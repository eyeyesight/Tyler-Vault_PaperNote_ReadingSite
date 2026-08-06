// @ts-nocheck -- the YAML document is deliberately validated as a small runtime contract.
import { access, lstat, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { isMap, isSeq, isScalar, parseDocument } from "yaml"

import { assertNoLinkAncestors, isEqualToOrInside, pathsOverlap } from "./filesystem-safety.mjs"
import { parseFrontmatter } from "../scripts/tracer.mjs"

export const approvedSitePageCount = 9
export const approvedLayouts = Object.freeze(["paper", "support"])
const supportClasses = new Set(["author", "concept", "method", "task", "synthesis", "map"])

export class SiteContentError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = "SiteContentError"
    this.code = code
  }
}

/** @param {unknown} value */
function scalarString(value) {
  if (!isScalar(value) || value.anchor || value.tag || typeof value.value !== "string") throw new Error("expected plain string")
  return value.value
}

/** @param {string} route */
function routeIdentity(route) {
  const paper = /^\/papers\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/.exec(route)
  if (paper) return { nodeClass: "paper", publicId: paper[1] }
  const support = /^\/knowledge\/(author|concept|method|task|synthesis|map)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/.exec(route)
  if (support) return { nodeClass: support[1], publicId: support[2] }
  throw new SiteContentError("ROUTE_INVALID", "site-content.yml contains an unsupported site-relative route")
}

/** @param {string} source */
function validateSourceName(source) {
  if (!source || source.normalize("NFC") !== source || source.includes("\\") || source.startsWith("/")
    || /^[A-Za-z]:/.test(source) || source !== path.posix.normalize(source) || !source.endsWith(".md")
    || source.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new SiteContentError("SOURCE_PATH_INVALID", "site-content.yml source must be a normalized relative Markdown path")
  }
}

/** @param {string} route */
function validateRouteName(route) {
  if (!route || route.normalize("NFC") !== route || route.includes("\\") || route.includes("?") || route.includes("#")
    || route.includes("//") || !route.startsWith("/") || !route.endsWith("/")
    || route.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new SiteContentError("ROUTE_INVALID", "site-content.yml route must be a normalized site-relative path")
  }
  return routeIdentity(route)
}

/** @param {string} mapPath */
async function readPages(mapPath) {
  let document
  try {
    document = parseDocument(await readFile(mapPath, "utf8"), {
      schema: "failsafe",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      customTags: [],
      merge: false,
      resolveKnownTags: false,
      prettyErrors: false,
    })
  } catch {
    throw new SiteContentError("CONTENT_MAP_INVALID", "site-content.yml could not be parsed")
  }
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) {
    throw new SiteContentError("CONTENT_MAP_INVALID", "site-content.yml must contain one mapping with pages")
  }
  const pagesPair = document.contents.items.find((pair) => scalarString(pair.key) === "pages")
  if (!pagesPair || !isSeq(pagesPair.value)) throw new SiteContentError("CONTENT_MAP_INVALID", "site-content.yml pages must be a sequence")
  return pagesPair.value.items
}

/**
 * Load and validate the deliberately static Phase 1 content map. The map is
 * the only source selector; no directory discovery occurs here.
 * @param {string} mapPath
 * @param {{vaultRoot:string, workRoot:string, output:string, snapshotRoot?:string}} roots
 */
export async function loadSiteContent(mapPath, roots) {
  const vaultRoot = path.resolve(roots.vaultRoot)
  const workRoot = path.resolve(roots.workRoot)
  const output = path.resolve(roots.output)
  const snapshotRoot = path.resolve(roots.snapshotRoot ?? path.join(workRoot, "public-snapshot"))
  try {
    await assertNoLinkAncestors(vaultRoot, { errorFactory: () => new SiteContentError("VAULT_ROOT_INVALID", "canonical Vault root must be an ordinary directory") })
    if (!(await stat(vaultRoot)).isDirectory()) throw new Error("not a directory")
  } catch (error) {
    if (error instanceof SiteContentError) throw error
    throw new SiteContentError("VAULT_ROOT_INVALID", "canonical Vault root must be an existing directory")
  }
  for (const [role, candidate] of [["work root", workRoot], ["output", output], ["temporary public snapshot", snapshotRoot]]) {
    try {
      await assertNoLinkAncestors(candidate, { allowMissing: true, errorFactory: () => new SiteContentError("PATH_INVALID", `${role} must not contain a link`) })
    } catch (error) {
      if (error instanceof SiteContentError) throw error
      throw new SiteContentError("PATH_INVALID", `${role} is not a valid path`)
    }
  }
  const disjointRoles = [
    ["Vault root", vaultRoot],
    ["work root", workRoot],
    ["output", output],
  ]
  for (let first = 0; first < disjointRoles.length; first += 1) {
    for (let second = first + 1; second < disjointRoles.length; second += 1) {
      if (pathsOverlap(disjointRoles[first][1], disjointRoles[second][1])) {
        throw new SiteContentError("PATH_OVERLAP_NOT_ALLOWED", "Vault, work, and output paths must be disjoint")
      }
    }
  }
  if (pathsOverlap(vaultRoot, snapshotRoot) || pathsOverlap(output, snapshotRoot)) {
    throw new SiteContentError("PATH_OVERLAP_NOT_ALLOWED", "Vault, temporary snapshot, and output paths must be disjoint")
  }

  const pages = await readPages(mapPath)
  if (pages.length !== approvedSitePageCount) throw new SiteContentError("CONTENT_MAP_PAGE_COUNT", "site-content.yml must contain exactly nine pages")
  const seenSources = new Set()
  const seenRoutes = new Set()
  const seenRouteKeys = new Set()
  /** @type {Array<any>} */
  const records = []
  for (const page of pages) {
    if (!isMap(page)) throw new SiteContentError("CONTENT_MAP_INVALID", "each site-content.yml page must be a mapping")
    const fields = page.items.map((pair) => scalarString(pair.key))
    if (JSON.stringify(fields) !== JSON.stringify(["source", "route", "layout"])) {
      throw new SiteContentError("CONTENT_MAP_INVALID", "each page must contain exactly source, route, and layout")
    }
    const source = scalarString(page.items[0].value)
    const route = scalarString(page.items[1].value)
    const layout = scalarString(page.items[2].value)
    validateSourceName(source)
    const identity = validateRouteName(route)
    if (!approvedLayouts.includes(layout)) throw new SiteContentError("LAYOUT_INVALID", "site-content.yml layout must be paper or support")
    if (layout === "paper" && identity.nodeClass !== "paper") throw new SiteContentError("LAYOUT_ROUTE_MISMATCH", "paper layout must use a paper route")
    if (layout === "support" && identity.nodeClass === "paper") throw new SiteContentError("LAYOUT_ROUTE_MISMATCH", "support layout cannot use a paper route")
    const routeKey = route.toLocaleLowerCase("en-US")
    if (seenSources.has(source)) throw new SiteContentError("SOURCE_DUPLICATE", "site-content.yml source is listed more than once")
    if (seenRoutes.has(route) || seenRouteKeys.has(routeKey)) throw new SiteContentError("ROUTE_DUPLICATE", "site-content.yml route is duplicated or case-colliding")
    seenSources.add(source)
    seenRoutes.add(route)
    seenRouteKeys.add(routeKey)
    const sourceAbsolute = path.resolve(vaultRoot, ...source.split("/"))
    if (!isEqualToOrInside(vaultRoot, sourceAbsolute)) throw new SiteContentError("SOURCE_OUTSIDE_VAULT", "site-content.yml source escapes the canonical Vault root")
    try {
      await assertNoLinkAncestors(sourceAbsolute, { errorFactory: () => new SiteContentError("SOURCE_LINK_NOT_ALLOWED", "mapped source contains a link or reparse point") })
      const metadata = await lstat(sourceAbsolute)
      if (!metadata.isFile()) throw new Error("not a regular file")
      await access(sourceAbsolute)
      try {
        parseFrontmatter(await readFile(sourceAbsolute, "utf8"))
      } catch (error) {
        const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "SOURCE_FRONTMATTER_INVALID"
        throw new SiteContentError(code, "mapped Markdown frontmatter could not be parsed")
      }
    } catch (error) {
      if (error instanceof SiteContentError) throw error
      throw new SiteContentError("SOURCE_MISSING", "a mapped Markdown source does not exist")
    }
    records.push(Object.freeze({ source, sourceAbsolute, route, layout, ...identity }))
  }
  return Object.freeze({ mapPath: path.resolve(mapPath), vaultRoot, workRoot, output, snapshotRoot, pages: Object.freeze(records) })
}
