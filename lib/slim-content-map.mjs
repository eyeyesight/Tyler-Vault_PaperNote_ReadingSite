// @ts-nocheck -- the YAML document is deliberately validated as a small runtime contract.
import { createHash } from "node:crypto"
import { access, lstat, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { isAlias, isMap, isSeq, isScalar, parseDocument } from "yaml"

import { assertNoLinkAncestors, isEqualToOrInside, pathsOverlap } from "./filesystem-safety.mjs"

export const approvedLayouts = Object.freeze(["paper", "support"])
const supportClasses = new Set(["author", "concept", "method", "task", "synthesis", "map"])

export class SlimContentError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message)
    this.name = "SlimContentError"
    this.code = code
    this.details = details
  }
}

export class SiteContentError extends SlimContentError {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(code, message)
    this.name = "SiteContentError"
  }
}

/** @param {string} markdown */
export function parseFrontmatter(markdown) {
  const match = /^(?:---)\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
  if (!match) throw new SlimContentError("SOURCE_FRONTMATTER_REQUIRED", "every tracer node requires leading YAML frontmatter")
  try {
    const document = parseDocument(match[1], {
      schema: "failsafe",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      customTags: [],
      merge: false,
      resolveKnownTags: false,
      prettyErrors: false,
    })
    if (document.errors.length || document.warnings.length || !isMap(document.contents)) throw new Error("invalid YAML document")
    /** @type {Record<string,string|string[]>} */
    const data = Object.create(null)
    const scalarValue = (/** @type {any} */ node) => {
      if (!isScalar(node) || node.anchor || node.tag) throw new Error("unsupported YAML scalar")
      return String(node.value ?? "")
    }
    for (const pair of document.contents.items) {
      const key = scalarValue(pair.key)
      const value = pair.value
      if (isAlias(value) || value?.anchor || value?.tag) throw new Error("YAML aliases, anchors, and explicit tags are unsupported")
      if (isScalar(value)) data[key] = scalarValue(value)
      else if (isSeq(value)) data[key] = value.items.map(scalarValue)
      else throw new Error("frontmatter values must be scalars or scalar arrays")
    }
    return { data, body: markdown.slice(match[0].length) }
  } catch {
    throw new SlimContentError("SOURCE_FRONTMATTER_INVALID", "source frontmatter must be strict YAML with scalar fields or scalar arrays")
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
  const hasControl = [...source].some((character) => {
    const code = character.codePointAt(0)
    return code !== undefined && (code < 0x20 || code === 0x7f)
  })
  if (!source || hasControl || source.normalize("NFC") !== source || source.includes("\\") || source.startsWith("/")
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

const mapDocumentOptions = Object.freeze({
  schema: "failsafe",
  strict: true,
  stringKeys: true,
  uniqueKeys: true,
  customTags: [],
  merge: false,
  resolveKnownTags: false,
  prettyErrors: false,
})

const pageFields = Object.freeze(["source", "route", "layout"])

/** @param {unknown} node */
function rejectDecoratedNode(node) {
  if (isAlias(node) || node?.anchor || node?.tag) throw new Error("decorated YAML nodes are unsupported")
}

/** @param {Buffer|Uint8Array} input */
function parseMapDocument(input) {
  if (!(Buffer.isBuffer(input) || input instanceof Uint8Array)) throw new Error("content map bytes are required")
  const bytes = Buffer.from(input)
  let source
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new SiteContentError("CONTENT_MAP_INVALID", "site-content.yml must contain valid UTF-8 bytes")
  }
  let document
  try {
    document = parseDocument(source, mapDocumentOptions)
  } catch {
    throw new SiteContentError("CONTENT_MAP_INVALID", "site-content.yml could not be parsed")
  }
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) {
    throw new SiteContentError("CONTENT_MAP_INVALID", "site-content.yml must contain one mapping with pages")
  }
  return { bytes, document }
}

/** @param {Buffer|Uint8Array} input */
export function parseContentMapBytes(input) {
  const { bytes, document } = parseMapDocument(input)
  let topLevel
  try {
    topLevel = new Map()
    for (const pair of document.contents.items) {
      rejectDecoratedNode(pair.key)
      const key = scalarString(pair.key)
      if (topLevel.has(key)) throw new Error("duplicate top-level field")
      topLevel.set(key, pair.value)
    }
  } catch {
    throw new SiteContentError("CONTENT_MAP_INVALID", "site-content.yml top-level fields are invalid")
  }
  if ([...topLevel.keys()].some((key) => key !== "pages")) {
    throw new SiteContentError("CONTENT_MAP_INVALID", "site-content.yml contains an unsupported top-level field")
  }
  const pagesNode = topLevel.get("pages")
  if (!isSeq(pagesNode)) throw new SiteContentError("CONTENT_MAP_INVALID", "site-content.yml pages must be a sequence")
  if (pagesNode.items.length < 1) throw new SiteContentError("CONTENT_MAP_EMPTY", "site-content.yml pages must not be empty")

  const seenSources = new Set()
  const seenRoutes = new Set()
  const pages = []
  for (const page of pagesNode.items) {
    try {
      rejectDecoratedNode(page)
      if (!isMap(page)) throw new Error("page must be a mapping")
      const fields = page.items.map((pair) => {
        rejectDecoratedNode(pair.key)
        return scalarString(pair.key)
      })
      if (fields.length !== pageFields.length || new Set(fields).size !== pageFields.length
        || pageFields.some((field) => !fields.includes(field))) {
        throw new SiteContentError("CONTENT_MAP_INVALID", "each page must contain exactly source, route, and layout")
      }
      const values = new Map(page.items.map((pair) => [scalarString(pair.key), pair.value]))
      for (const value of values.values()) rejectDecoratedNode(value)
      const source = scalarString(values.get("source"))
      const route = scalarString(values.get("route"))
      const layout = scalarString(values.get("layout"))
      validateSourceName(source)
      const identity = validateRouteName(route)
      if (!approvedLayouts.includes(layout)) throw new SiteContentError("LAYOUT_INVALID", "site-content.yml layout must be paper or support")
      if (layout === "paper" && identity.nodeClass !== "paper") throw new SiteContentError("LAYOUT_ROUTE_MISMATCH", "paper layout must use a paper route")
      if (layout === "support" && identity.nodeClass === "paper") throw new SiteContentError("LAYOUT_ROUTE_MISMATCH", "support layout cannot use a paper route")
      const sourceKey = source.toLocaleLowerCase("en-US")
      const routeKey = route.toLocaleLowerCase("en-US")
      if (seenSources.has(sourceKey)) throw new SiteContentError("SOURCE_DUPLICATE", "site-content.yml source is duplicated or case-colliding")
      if (seenRoutes.has(routeKey)) throw new SiteContentError("ROUTE_DUPLICATE", "site-content.yml route is duplicated or case-colliding")
      seenSources.add(sourceKey)
      seenRoutes.add(routeKey)
      pages.push(Object.freeze({ source, route, layout, ...identity }))
    } catch (error) {
      if (error instanceof SiteContentError) throw error
      throw new SiteContentError("CONTENT_MAP_INVALID", "site-content.yml page structure is invalid")
    }
  }
  return Object.freeze({
    bytes,
    mapSha256: createHash("sha256").update(bytes).digest("hex"),
    pages: Object.freeze(pages),
  })
}

/** @param {string} mapPath @param {{mapBytes?:Buffer|Uint8Array,mapReader?:(mapPath:string)=>Promise<Buffer|Uint8Array>}} options */
async function readContentMapBytes(mapPath, options) {
  try {
    if (options.mapBytes !== undefined) return Buffer.from(options.mapBytes)
    const reader = options.mapReader ?? readFile
    return Buffer.from(await reader(mapPath))
  } catch {
    throw new SiteContentError("CONTENT_MAP_INVALID", "site-content.yml could not be read")
  }
}

/**
 * Parse the content map bytes once, then use the resulting records for the
 * ordinary Vault admission checks. This function never discovers sources.
 * @param {string} mapPath
 * @param {{vaultRoot:string, workRoot:string, output:string, snapshotRoot?:string}} roots
 * @param {{mapBytes?:Buffer|Uint8Array,mapReader?:(mapPath:string)=>Promise<Buffer|Uint8Array>}} [options]
 */
export async function loadSiteContent(mapPath, roots, options = {}) {
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

  const mapBytes = await readContentMapBytes(mapPath, options)
  const parsedMap = parseContentMapBytes(mapBytes)
  /** @type {Array<any>} */
  const records = []
  for (const page of parsedMap.pages) {
    const { source, route, layout, ...identity } = page
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
  return Object.freeze({
    mapPath: path.resolve(mapPath),
    mapBytes: Buffer.from(parsedMap.bytes),
    mapSha256: parsedMap.mapSha256,
    vaultRoot,
    workRoot,
    output,
    snapshotRoot,
    pages: Object.freeze(records),
  })
}
