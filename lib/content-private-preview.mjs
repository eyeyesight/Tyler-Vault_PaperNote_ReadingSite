// @ts-nocheck -- the controller crosses bounded filesystem and local-Git fixture seams.
import { createHash, randomBytes } from "node:crypto"
import { execFile as execFileCallback, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { builtinModules, createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { parse as parseYaml } from "yaml"

import {
  assertNoLinkAncestors,
  isEqualToOrInside,
  pathsOverlap,
} from "./filesystem-safety.mjs"
import {
  loadSiteContent,
  parseFrontmatter,
} from "./slim-content-map.mjs"
import { build, preflight } from "../scripts/slim-build.mjs"
import { prepare as prepareGhPages } from "../scripts/prepare-gh-pages-commit.mjs"

const execFile = promisify(execFileCallback)
const repoRoot = path.resolve(import.meta.dirname, "..")
const defaultMap = path.join(repoRoot, "site-content.yml")
const defaultWorkRoot = path.join(os.tmpdir(), "tyler-vault-content-private-preview")
const rendererTempPrefix = "tyler-vault-renderer-"
const rendererInstallTimeoutMs = 300_000
const rendererInstallMaxBuffer = 64 * 1024 * 1024
const knowledgeCategories = Object.freeze([
  ["Authors", "author"],
  ["Concepts", "concept"],
  ["Methods", "method"],
  ["Tasks", "task"],
])
const knowledgeCategoryNames = new Set(knowledgeCategories.map(([folder]) => folder))
const statuses = new Set(["preparing", "ready_for_review", "no_change", "needs_attention"])
const opaqueOperationPattern = /^(?:content-[0-9a-f]{20}|[0-9a-f]{32})$/u
const strictRefPattern = /^refs\/(?:heads|tags|remotes)\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u
const requiredRendererFiles = new Set([
  "config/public-secret-rules.toml",
  "config/quartz-toolchain.json",
  "lib/filesystem-safety.mjs",
  "lib/project-page-template.mjs",
  "lib/quartz-public-navigation.mjs",
  "lib/slim-content-map.mjs",
  "lib/slim-public-metadata.mjs",
  "lib/zotero-public-projection.mjs",
  "package-lock.json",
  "package.json",
  "scripts/slim-build.mjs",
  "scripts/tracer.mjs",
  "styles/tracer-scholarly.scss",
  "vendor/brace-expansion-compat/index.cjs",
  "vendor/brace-expansion-compat/package.json",
])
const presentationBasePath = "/Tyler-Vault_PaperNote_ReadingSite/"
const maxPresentationSourceDiffEntries = 512
const maxPresentationSourceDiffBytes = 256 * 1024
const maxPresentationScreenshots = 2
const maxPresentationScreenshotBytes = 4 * 1024 * 1024

export class ContentPreviewError extends Error {
  /** @param {string} code @param {string} message @param {Record<string,unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message)
    this.name = "ContentPreviewError"
    this.code = code
    this.details = details
  }
}

/** @param {Buffer} bytes */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Git's native SHA-1 blob identity without writing an object or ref. @param {Buffer} bytes */
export function gitBlobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
}

/** @param {string} left @param {string} right */
function utf8Order(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/** @param {string} value */
function isSha(value) {
  return /^[0-9a-f]{40}$/u.test(value)
}

/** @param {unknown} _ignored */
export function opaqueOperationId(_ignored) {
  return `content-${randomBytes(10).toString("hex")}`
}

/** @param {unknown} value */
function isOpaqueOperationId(value) {
  return typeof value === "string" && opaqueOperationPattern.test(value)
}

/** @param {unknown} value */
function validateOperationId(value) {
  if (!isOpaqueOperationId(value)) throw new ContentPreviewError("OPERATION_ID_INVALID", "operation identifier must be an opaque controller identifier")
  return value
}

/** @param {unknown} value */
function validateGitRefInput(value) {
  const forbidden = new Set(["^", "~", ":", "@", "{", "}", "?", "*", "[", "]", "\\"])
  const hasControlOrForbidden = typeof value === "string"
    && [...value].some((character) => forbidden.has(character) || character.codePointAt(0) < 0x20)
  if (typeof value !== "string" || value.startsWith("-") || hasControlOrForbidden
    || (!isSha(value) && (!strictRefPattern.test(value) || value.includes("..")))) {
    throw new ContentPreviewError("GIT_REF_INVALID", "Git authority input must be a complete ref or 40-hex commit")
  }
  return value
}

/** @param {unknown} error */
function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code : "CONTENT_PREVIEW_FAILED"
}

/** @param {unknown} error */
function errorMessage(error) {
  return error && typeof error === "object" && typeof error.message === "string" ? error.message : "content private preview failed"
}

/** @param {string} source */
function normalizedSource(source) {
  if (typeof source !== "string" || source.normalize("NFC") !== source || source.includes("\\")
    || source.startsWith("/") || /^[A-Za-z]:/u.test(source) || source !== path.posix.normalize(source)
    || !source.endsWith(".md") || source.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ContentPreviewError("SOURCE_PATH_INVALID", "discovered source path is not a normalized Markdown path")
  }
  return source
}

/** @param {string} source */
function mapRecordKey(source) {
  return source.replace(/\\/g, "/").toLowerCase()
}

/** @param {Buffer} bytes */
function parseMapEntries(bytes) {
  let document
  try {
    document = parseYaml(bytes.toString("utf8"))
  } catch {
    throw new ContentPreviewError("CONTENT_MAP_INVALID", "site-content.yml could not be parsed")
  }
  if (!document || typeof document !== "object" || !Array.isArray(document.pages) || document.pages.length < 1) {
    throw new ContentPreviewError("CONTENT_MAP_INVALID", "site-content.yml pages are invalid")
  }
  return document.pages.map((page) => {
    if (!page || typeof page !== "object" || typeof page.source !== "string" || typeof page.route !== "string" || typeof page.layout !== "string") {
      throw new ContentPreviewError("CONTENT_MAP_INVALID", "site-content.yml pages are invalid")
    }
    return { source: page.source, route: page.route, layout: page.layout }
  })
}

/** @param {Buffer} baseline @param {ReadonlyArray<{source:string,route:string,layout:string}>} additions */
function appendMapEntries(baseline, additions) {
  if (additions.length === 0) return Buffer.from(baseline)
  const suffix = additions.map((page) => [
    `  - source: ${JSON.stringify(page.source)}`,
    `    route: ${JSON.stringify(page.route)}`,
    `    layout: ${page.layout}`,
  ].join("\n")).join("\n\n")
  const separator = baseline.length === 0 ? "" : baseline[baseline.length - 1] === 0x0a ? "\n" : "\n\n"
  return Buffer.concat([baseline, Buffer.from(`${separator}${suffix}\n`, "utf8")])
}

/** @param {ReadonlyArray<{source:string,route:string,layout:string}>} baseline @param {ReadonlyArray<{source:string,route:string,layout:string}>} proposal */
function assertAppendOnly(baseline, proposal) {
  const proposedRoutes = new Set(proposal.map((page) => page.route))
  const removedRoutes = baseline
    .filter((page) => !proposedRoutes.has(page.route))
    .map((page) => makeRoutePreview(page.route, page))
  if (removedRoutes.length > 0) throw routeRemovalError(removedRoutes)
  for (let index = 0; index < baseline.length; index += 1) {
    const expected = baseline[index]
    const actual = proposal[index]
    if (!actual || expected.source !== actual.source || expected.route !== actual.route || expected.layout !== actual.layout) {
      throw new ContentPreviewError("CONTENT_MAP_REWRITE", "routine map proposal cannot rewrite an existing mapping")
    }
  }
}

/** @param {string} stem @param {boolean} paper */
export function normalizeRouteSlug(stem, paper = false) {
  if (typeof stem !== "string") throw new ContentPreviewError("ROUTE_UNSUPPORTED", "route source name is invalid")
  let value = stem.normalize("NFKD").replace(/\p{M}/gu, "")
  if (paper) {
    value = value
      .replace(/\bet\s+al\.\s*/giu, " ")
      .replace(/\band\s+[A-Za-z][A-Za-z.'’-]*(?=\s+\d{4}\b)/giu, " ")
  }
  let slug = ""
  for (const character of value) {
    if (/[A-Za-z0-9]/u.test(character)) slug += character.toLowerCase()
    else if (/\s/u.test(character) || /\p{Dash_Punctuation}/u.test(character) || /\p{Punctuation}/u.test(character)) slug += "-"
    else throw new ContentPreviewError("ROUTE_UNSUPPORTED", "route source name contains an unsupported character")
  }
  slug = slug.replace(/-+/gu, "-").replace(/^-|-$/gu, "")
  if (!slug) throw new ContentPreviewError("ROUTE_EMPTY", "route source name produced an empty slug")
  return slug
}

/** @param {string} source */
export function routeForSource(source) {
  normalizedSource(source)
  const parts = source.split("/")
  const basename = parts.at(-1).slice(0, -3)
  if (parts.length === 3 && parts[0] === "Literature" && parts[1] === "Notes") {
    return `/papers/${normalizeRouteSlug(basename, true)}/`
  }
  if (parts.length === 3 && parts[0] === "Knowledge" && knowledgeCategoryNames.has(parts[1])) {
    const category = knowledgeCategories.find(([folder]) => folder === parts[1])[1]
    return `/knowledge/${category}/${normalizeRouteSlug(basename)}/`
  }
  if (parts.length === 3 && parts[0] === "Literature" && parts[1] === "Syntheses") {
    return `/knowledge/synthesis/${normalizeRouteSlug(basename)}/`
  }
  if (parts.length === 3 && parts[0] === "Literature" && parts[1] === "Reviews & Maps") {
    return `/knowledge/map/${normalizeRouteSlug(basename)}/`
  }
  throw new ContentPreviewError("DISCOVERY_TARGET_UNSUPPORTED", "new content must be a direct paper or approved support page")
}

/** @param {string} route */
function routeFile(route) {
  if (route === "/") return "index.html"
  return `${route.slice(1)}index.html`
}

/** @param {string} route */
function routeKind(route) {
  const paper = /^\/papers\//u.test(route)
  if (paper) return "paper"
  const match = /^\/knowledge\/(author|concept|method|task|synthesis|map)\//u.exec(route)
  return match ? match[1] : "support"
}

/** @param {string} route */
function safeRouteTitle(route) {
  const match = /\/([^/]+)\/$/u.exec(route)
  return match ? match[1].replace(/-/gu, " ") : "home"
}

const previewRoutePattern = /^\/(?:papers\/[a-z0-9]+(?:-[a-z0-9]+)*|knowledge\/(?:author|concept|method|task|synthesis|map)\/[a-z0-9]+(?:-[a-z0-9]+)*)\/$/u
const previewKinds = new Set(["paper", "author", "concept", "method", "task", "synthesis", "map", "support"])
const routeRemovalDetailsMarker = Symbol("route-removal-details")

/** @param {unknown} route */
function isPreviewRoute(route) {
  return route === "/" || (typeof route === "string" && previewRoutePattern.test(route))
}

/** @param {string} route @param {{source?:string,layout?:string}|undefined} [page] */
function makeRoutePreview(route, page) {
  if (!isPreviewRoute(route)) throw new ContentPreviewError("ROUTE_REMOVAL", "removed public route metadata is invalid")
  const title = page?.source ? path.posix.basename(page.source, ".md") : safeRouteTitle(route)
  const kind = page?.layout === "paper" ? "paper" : routeKind(route)
  if (typeof title !== "string" || !title || title.includes("/") || title.includes("\\")
    || [...title].some((character) => {
      const code = character.codePointAt(0)
      return code !== undefined && (code < 0x20 || code === 0x7f)
    }) || !previewKinds.has(kind)) {
    throw new ContentPreviewError("ROUTE_REMOVAL", "removed public route metadata is invalid")
  }
  return { route, title, kind }
}

/** @param {unknown} value */
function normalizeRoutePreviews(value) {
  if (!Array.isArray(value)) throw new ContentPreviewError("ROUTE_REMOVAL", "removed public route metadata is invalid")
  const byRoute = new Map()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || Object.keys(candidate).sort().join("\0") !== "kind\0route\0title") {
      throw new ContentPreviewError("ROUTE_REMOVAL", "removed public route metadata is invalid")
    }
    const preview = makeRoutePreview(candidate.route, undefined)
    if (candidate.title !== preview.title || candidate.kind !== preview.kind) {
      if (typeof candidate.title !== "string" || typeof candidate.kind !== "string") {
        throw new ContentPreviewError("ROUTE_REMOVAL", "removed public route metadata is invalid")
      }
      if (!candidate.title || candidate.title.includes("/") || candidate.title.includes("\\")
        || !previewKinds.has(candidate.kind)
        || [...candidate.title].some((character) => {
          const code = character.codePointAt(0)
          return code !== undefined && (code < 0x20 || code === 0x7f)
        })) {
        throw new ContentPreviewError("ROUTE_REMOVAL", "removed public route metadata is invalid")
      }
    }
    const normalized = { route: preview.route, title: candidate.title, kind: candidate.kind }
    const previous = byRoute.get(normalized.route)
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) {
      throw new ContentPreviewError("ROUTE_REMOVAL", "removed public route metadata is ambiguous")
    }
    byRoute.set(normalized.route, normalized)
  }
  return [...byRoute.values()].sort((left, right) => utf8Order(left.route, right.route))
}

/** @param {ReadonlyArray<{route:string,title:string,kind:string}>} routes */
function routeRemovalError(routes) {
  const removedRoutes = normalizeRoutePreviews(routes)
  if (removedRoutes.length === 0) throw new ContentPreviewError("ROUTE_REMOVAL", "generated preview would remove an existing public route")
  return new ContentPreviewError(
    "ROUTE_REMOVAL",
    "generated preview would remove an existing public route",
    { [routeRemovalDetailsMarker]: true, removedRoutes },
  )
}

/** @param {string} relative */
function routeFromDeletedFile(relative) {
  if (relative === "index.html") return "/"
  if (typeof relative !== "string" || !relative.endsWith("/index.html")) return null
  const route = `/${relative.slice(0, -"index.html".length)}`
  return isPreviewRoute(route) ? route : null
}

/** @param {{gitRoot?:string,gitDir?:string}} options @param {string[]} args @param {"utf8"|"buffer"} [encoding] */
async function gitRead(options, args, encoding = "utf8") {
  const prefix = options.gitDir ? ["--git-dir", path.resolve(options.gitDir)] : ["-C", path.resolve(options.gitRoot)]
  try {
    const result = await execFile("git", [...prefix, ...args], {
      encoding,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    })
    return result.stdout
  } catch {
    throw new ContentPreviewError("GIT_REF_UNAVAILABLE", "required local Git ref readback was unavailable")
  }
}

/** @param {{gitRoot?:string,gitDir?:string}} options @param {string} ref */
async function readGitCommit(options, ref) {
  validateGitRefInput(ref)
  const value = String(await gitRead(options, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim()
  if (!isSha(value)) throw new ContentPreviewError("GIT_REF_INVALID", "local Git ref did not resolve to a commit")
  return value
}

/** @param {{gitRoot?:string,gitDir?:string}} options @param {string} commitSha */
async function readGitMap(options, commitSha) {
  if (!isSha(commitSha)) throw new ContentPreviewError("GIT_REF_INVALID", "local Git authority SHA is invalid")
  const bytes = Buffer.from(await gitRead(options, ["show", `${commitSha}:site-content.yml`], "buffer"))
  if (bytes.length === 0) throw new ContentPreviewError("CONTENT_MAP_INVALID", "local Git ref contains an empty site-content.yml")
  return bytes
}

function sameCanonicalPath(left, right) {
  const normalize = process.platform === "win32" ? (value) => value.toLowerCase() : (value) => value
  return normalize(path.resolve(left)) === normalize(path.resolve(right))
}

/** @param {import("node:fs").Stats} left @param {import("node:fs").Stats} right */
function sameFilesystemIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

/** @param {string} candidate @param {boolean} includeCandidate */
async function assertNoNodeModulesAncestors(candidate, includeCandidate = false) {
  const absolute = path.resolve(candidate)
  const parsed = path.parse(absolute)
  let cursor = includeCandidate ? absolute : path.dirname(absolute)
  for (;;) {
    try {
      await lstat(path.join(cursor, "node_modules"))
      throw new ContentPreviewError("RENDERER_ROOT_INVALID", "renderer ancestors must not provide a node_modules fallback")
    } catch (error) {
      if (error instanceof ContentPreviewError) throw error
      if (error?.code !== "ENOENT") throw new ContentPreviewError("RENDERER_ROOT_INVALID", "renderer ancestors could not be verified")
    }
    if (cursor === parsed.root) break
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
}

/** @param {string} root @param {string} code */
async function claimOrdinaryDirectory(root, code) {
  await assertNoLinkAncestors(root, {
    errorFactory: () => new ContentPreviewError(code, "owned directory contains a link or reparse point"),
  })
  const [canonical, metadata] = await Promise.all([realpath(root), lstat(root)])
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new ContentPreviewError(code, "owned directory is not an ordinary directory")
  return { path: root, canonical, identity: metadata }
}

/** @param {{path:string,canonical:string,identity:import("node:fs").Stats}} claim @param {string} code */
async function verifyDirectoryClaim(claim, code) {
  await assertNoLinkAncestors(claim.path, {
    errorFactory: () => new ContentPreviewError(code, "owned directory contains a link or reparse point"),
  })
  const [canonical, metadata] = await Promise.all([realpath(claim.path), lstat(claim.path)])
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || !sameCanonicalPath(canonical, claim.canonical) || !sameFilesystemIdentity(metadata, claim.identity)) {
    throw new ContentPreviewError(code, "owned directory identity changed")
  }
  return canonical
}

/** @param {(claim: {path:string,canonical:string,identity:import("node:fs").Stats}) => Promise<boolean>} [removeDirectory] */
async function createRendererDirectory(removeDirectory = removeOwnedDirectory) {
  const tempRoot = path.resolve(os.tmpdir())
  await assertNoLinkAncestors(tempRoot, {
    errorFactory: () => new ContentPreviewError("RENDERER_ROOT_INVALID", "renderer temporary root is not safe"),
  })
  const tempCanonical = await realpath(tempRoot)
  await assertNoNodeModulesAncestors(tempCanonical, true)
  let claim = null
  try {
    const directory = await mkdtemp(path.join(tempCanonical, rendererTempPrefix))
    claim = await claimOrdinaryDirectory(directory, "RENDERER_ROOT_INVALID")
    if (!isEqualToOrInside(tempCanonical, claim.canonical) || sameCanonicalPath(tempCanonical, claim.canonical)) {
      throw new ContentPreviewError("RENDERER_ROOT_INVALID", "renderer temporary root escaped the operating-system temp root")
    }
    await assertNoNodeModulesAncestors(claim.canonical)
    return claim
  } catch (error) {
    if (claim) {
      let removed = false
      try {
        removed = (await removeDirectory(claim)) === true
      } catch {
        removed = false
      }
      if (!removed) throw new ContentPreviewError("CLEANUP_FAILED", "private renderer cleanup failed")
    }
    throw error
  }
}

/** @param {string} listing @param {string} prefix @param {string} code */
function parseGitBlobRecords(listing, prefix, code) {
  const files = []
  const exact = new Set()
  const folded = new Map()
  const prefixWithSlash = prefix ? `${prefix}/` : ""
  for (const record of listing.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t")
    if (tab < 0) throw new ContentPreviewError(code, "Git tree listing is malformed")
    const [mode, type, blobSha] = record.slice(0, tab).split(" ")
    const name = record.slice(tab + 1)
    if (type !== "blob" || !["100644", "100755"].includes(mode) || !isSha(blobSha)
      || (prefix && !name.startsWith(prefixWithSlash))) {
      throw new ContentPreviewError(code, "Git tree contains a non-ordinary entry")
    }
    const relative = prefix ? name.slice(prefixWithSlash.length) : name
    const parts = relative.split("/")
    if (!relative || relative.normalize("NFC") !== relative || relative.includes("\\") || relative.startsWith("/")
      || path.posix.normalize(relative) !== relative || parts.some((part) => !part || part === "." || part === ".."
        || [...part].some((character) => character.codePointAt(0) < 0x20 || character.codePointAt(0) === 0x7f))) {
      throw new ContentPreviewError(code, "Git tree contains an unsafe path")
    }
    if (exact.has(relative)) throw new ContentPreviewError(code, "Git tree contains a duplicate path")
    exact.add(relative)
    for (let index = 1; index <= parts.length; index += 1) {
      const exactPrefix = parts.slice(0, index).join("/")
      const foldedPrefix = exactPrefix.normalize("NFC").toLocaleLowerCase("en-US")
      const previous = folded.get(foldedPrefix)
      if (previous && previous !== exactPrefix) throw new ContentPreviewError(code, "Git tree contains a case collision")
      folded.set(foldedPrefix, exactPrefix)
    }
    files.push({ mode, name, relative, blobSha })
  }
  return files
}

/** @param {{gitRoot?:string,gitDir?:string}} options @param {string} commitSha @param {string} name @param {string} destination @param {{mode:string,blobSha:string}} file @param {string} code */
async function materializeGitBlob(options, commitSha, name, destination, file, code) {
  let absolute = ""
  try {
    const bytes = Buffer.from(await gitRead(options, ["show", `${commitSha}:${name}`], "buffer"))
    if (gitBlobSha(bytes) !== file.blobSha) throw new ContentPreviewError(code, "Git blob identity did not match its readback bytes")
    absolute = path.join(destination, ...file.relative.split("/"))
    await assertNoLinkAncestors(path.dirname(absolute), {
      allowMissing: true,
      errorFactory: () => new ContentPreviewError(code, "Git materialization parent contains a link or reparse point"),
    })
    await mkdir(path.dirname(absolute), { recursive: true })
    await assertNoLinkAncestors(path.dirname(absolute), {
      errorFactory: () => new ContentPreviewError(code, "Git materialization parent changed during creation"),
    })
    await writeFile(absolute, bytes, { flag: "wx" })
    if (process.platform !== "win32") await chmod(absolute, file.mode === "100755" ? 0o755 : 0o644)
    await assertNoLinkAncestors(absolute, {
      errorFactory: () => new ContentPreviewError(code, "Git materialization file contains a link or reparse point"),
    })
    const metadata = await lstat(absolute)
    const readback = await readFile(absolute)
    if (!metadata.isFile() || metadata.isSymbolicLink() || !readback.equals(bytes) || gitBlobSha(readback) !== file.blobSha) {
      throw new ContentPreviewError(code, "Git materialization bytes or identity changed during readback")
    }
    if (process.platform !== "win32" && (metadata.mode & 0o777) !== (file.mode === "100755" ? 0o755 : 0o644)) {
      throw new ContentPreviewError(code, "Git materialization file mode changed during readback")
    }
    return bytes
  } catch (error) {
    if (error instanceof ContentPreviewError) throw error
    throw new ContentPreviewError(code, "Git materialization failed")
  }
}

/** @param {{gitRoot?:string,gitDir?:string}} options @param {string} commitSha @param {string} destination */
async function extractGitSite(options, commitSha, destination) {
  if (!isSha(commitSha)) throw new ContentPreviewError("GIT_REF_INVALID", "local gh-pages authority SHA is invalid")
  try {
    await assertNoLinkAncestors(path.dirname(destination), {
      errorFactory: () => new ContentPreviewError("GIT_TREE_INVALID", "local gh-pages materialization parent is not safe"),
    })
    await mkdir(destination)
  } catch (error) {
    if (error?.code === "EEXIST") throw new ContentPreviewError("GIT_TREE_REUSED", "local gh-pages materialization root was already used")
    if (error instanceof ContentPreviewError) throw error
    throw new ContentPreviewError("GIT_TREE_INVALID", "local gh-pages materialization root could not be created")
  }
  await claimOrdinaryDirectory(destination, "GIT_TREE_INVALID")
  const listing = Buffer.from(await gitRead(options, ["ls-tree", "-r", "-z", commitSha, "--", "site"], "buffer")).toString("utf8")
  const files = parseGitBlobRecords(listing, "site", "GIT_TREE_INVALID")
  for (const file of files.sort((left, right) => utf8Order(left.relative, right.relative))) {
    await materializeGitBlob(options, commitSha, file.name, destination, file, "GIT_TREE_INVALID")
  }
}

/** @param {{gitRoot?:string,gitDir?:string}} options @param {string} commitSha */
async function readRendererTrailer(options, commitSha) {
  if (!isSha(commitSha)) throw new ContentPreviewError("GIT_REF_INVALID", "local gh-pages authority SHA is invalid")
  const message = String(await gitRead(options, ["show", "-s", "--format=%B", commitSha]))
  const matches = [...message.matchAll(/^Renderer-Main-SHA:\s*(\S+)\s*$/gim)].map((match) => match[1])
  if (matches.length !== 1) {
    throw new ContentPreviewError(matches.length === 0 ? "RENDERER_PROVENANCE_MISSING" : "RENDERER_PROVENANCE_AMBIGUOUS", "live renderer provenance is missing or ambiguous")
  }
  if (!isSha(matches[0])) throw new ContentPreviewError("RENDERER_PROVENANCE_INVALID", "live renderer provenance is not a commit SHA")
  return matches[0]
}

/** @param {unknown} error */
function rendererInstallErrorCode(error) {
  if (error?.code === "ETIMEDOUT" || error?.signal === "SIGTERM" || error?.signal === "SIGKILL") return "RENDERER_INSTALL_TIMEOUT"
  if (error?.code === "ENOBUFS" || /maxBuffer|buffer exceeded/iu.test(String(error?.message ?? ""))) return "RENDERER_INSTALL_OUTPUT_LIMIT"
  return "RENDERER_INSTALL_FAILED"
}

/** @param {string} name */
function isBuiltinDependency(name) {
  return name.startsWith("node:") || builtinModules.includes(name)
}

/** @param {unknown} value @param {string} field */
function dependencyEntries(value, field) {
  if (value === undefined) return []
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContentPreviewError("RENDERER_SOURCE_INVALID", `live renderer ${field} metadata is invalid`)
  }
  return Object.entries(value)
}

/** @param {Buffer} packageBytes */
function readRendererDependencyMetadata(packageBytes) {
  let packageJson
  try {
    packageJson = JSON.parse(packageBytes.toString("utf8"))
  } catch {
    throw new ContentPreviewError("RENDERER_SOURCE_INVALID", "live renderer package metadata is invalid")
  }
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    throw new ContentPreviewError("RENDERER_SOURCE_INVALID", "live renderer package metadata is invalid")
  }
  const required = new Map()
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, specifier] of dependencyEntries(packageJson[field], field)) {
      if (!name || typeof specifier !== "string" || !specifier) {
        throw new ContentPreviewError("RENDERER_SOURCE_INVALID", "live renderer dependency metadata is invalid")
      }
      required.set(name, specifier)
    }
  }
  const optional = new Map()
  for (const [name, specifier] of dependencyEntries(packageJson.optionalDependencies, "optionalDependencies")) {
    if (!name || typeof specifier !== "string" || !specifier) {
      throw new ContentPreviewError("RENDERER_SOURCE_INVALID", "live renderer optional dependency metadata is invalid")
    }
    if (!required.has(name)) optional.set(name, specifier)
  }
  return { required, optional }
}

/** @param {string} specifier */
function localFileSpecifier(specifier) {
  if (!specifier.startsWith("file:")) return null
  const relative = specifier.slice("file:".length)
  const invalidUrlOrEscape = relative.includes("%") || relative.includes("?") || relative.includes("#")
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(relative)
  if (!relative || relative !== relative.trim() || relative.includes("\\") || invalidUrlOrEscape
    || relative.startsWith("/") || path.posix.isAbsolute(relative) || /^[A-Za-z]:/u.test(relative)
    || path.posix.normalize(relative) !== relative
    || relative.split("/").some((part) => !part || part === "." || part === ".."
      || [...part].some((character) => character.codePointAt(0) < 0x20 || character.codePointAt(0) === 0x7f))) {
    throw new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "local renderer dependency specifier is not a safe relative path")
  }
  return relative
}

/** @param {string} destination @param {string} relative @param {ReadonlySet<string>} trackedFiles @param {ReadonlyMap<string,Buffer>} trackedBytes */
async function inspectTrackedRendererTarget(destination, relative, trackedFiles, trackedBytes) {
  const target = path.resolve(destination, ...relative.split("/"))
  const targetRelative = path.relative(destination, target).split(path.sep).join("/")
  const packageRelative = `${targetRelative}/package.json`
  if (!targetRelative || targetRelative !== relative || !isEqualToOrInside(destination, target)
    || sameCanonicalPath(destination, target) || pathsOverlap(repoRoot, target)
    || !trackedFiles.has(packageRelative) || !trackedBytes.has(packageRelative)) {
    throw new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "local renderer dependency target is not an approved tracked package")
  }
  try {
    await assertNoLinkAncestors(target, {
      errorFactory: () => new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "local renderer dependency target contains a link"),
    })
    const metadata = await lstat(target)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "local renderer dependency target is not an ordinary directory")
    }
    const canonical = await realpath(target)
    if (!isEqualToOrInside(destination, canonical) || sameCanonicalPath(destination, canonical) || pathsOverlap(repoRoot, canonical)) {
      throw new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "local renderer dependency target escaped its renderer root")
    }
    await assertNoLinkAncestors(canonical, {
      errorFactory: () => new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "local renderer dependency target contains a link"),
    })
    await assertTrackedRendererBytes(destination, packageRelative, trackedBytes.get(packageRelative), "RENDERER_DEPENDENCY_INVALID")
    return { relative: targetRelative, canonical }
  } catch (error) {
    if (error instanceof ContentPreviewError) throw error
    throw new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "local renderer dependency target could not be verified")
  }
}

/** @param {string} destination @param {string} relative @param {Buffer|undefined} expected @param {string} code */
async function assertTrackedRendererBytes(destination, relative, expected, code) {
  if (!expected) throw new ContentPreviewError(code, "tracked renderer bytes are unavailable")
  const absolute = path.join(destination, ...relative.split("/"))
  try {
    await assertNoLinkAncestors(absolute, {
      errorFactory: () => new ContentPreviewError(code, "tracked renderer bytes contain a link"),
    })
    const metadata = await lstat(absolute)
    const actual = metadata.isFile() && !metadata.isSymbolicLink() ? await readFile(absolute) : null
    if (!actual || !actual.equals(expected)) throw new ContentPreviewError(code, "tracked renderer bytes changed")
  } catch (error) {
    if (error instanceof ContentPreviewError) throw error
    throw new ContentPreviewError(code, "tracked renderer bytes could not be verified")
  }
}

/** @param {string} destination @param {{required:Map<string,string>,optional:Map<string,string>}} metadata @param {ReadonlySet<string>} trackedFiles @param {ReadonlyMap<string,Buffer>} trackedBytes */
async function prepareRendererDependencyMetadata(destination, metadata, trackedFiles, trackedBytes) {
  const localSpecs = new Map()
  const requiredTargets = new Map()
  for (const [name, specifier] of metadata.required) {
    if (isBuiltinDependency(name)) continue
    const relative = localFileSpecifier(specifier)
    if (relative === null) continue
    localSpecs.set(name, relative)
    requiredTargets.set(name, await inspectTrackedRendererTarget(destination, relative, trackedFiles, trackedBytes))
  }
  for (const [name, specifier] of metadata.optional) {
    if (isBuiltinDependency(name)) continue
    const relative = localFileSpecifier(specifier)
    if (relative !== null) localSpecs.set(name, relative)
  }
  return { ...metadata, localSpecs, requiredTargets }
}

/** @param {string} nodeModulesRoot @param {string} name */
function rendererDependencyEntry(nodeModulesRoot, name) {
  const entry = path.resolve(nodeModulesRoot, ...name.split("/"))
  if (!isEqualToOrInside(nodeModulesRoot, entry) || sameCanonicalPath(nodeModulesRoot, entry)) {
    throw new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "renderer dependency entry escaped node_modules")
  }
  return entry
}

/** @param {Buffer} bytes @param {string} expectedName */
function validateDependencyPackageName(bytes, expectedName) {
  try {
    const value = JSON.parse(bytes.toString("utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value) || value.name !== expectedName) throw new Error("name mismatch")
  } catch {
    throw new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "installed renderer dependency package metadata is invalid")
  }
}

/** @param {string} destination @param {string} nodeModulesRoot @param {string} name @param {{relative:string,canonical:string}|undefined} localTarget @param {ReadonlyMap<string,Buffer>} trackedBytes */
async function validateInstalledRendererDependency(destination, nodeModulesRoot, name, localTarget, trackedBytes) {
  const entry = rendererDependencyEntry(nodeModulesRoot, name)
  try {
    if (localTarget) {
      await assertNoLinkAncestors(path.dirname(entry), {
        errorFactory: () => new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "local renderer dependency entry contains a link"),
      })
      const entryMetadata = await lstat(entry)
      const entryCanonical = await realpath(entry)
      const entryIsLink = entryMetadata.isSymbolicLink() || !sameCanonicalPath(entry, entryCanonical)
      if (!entryIsLink || !sameCanonicalPath(entryCanonical, localTarget.canonical)) {
        throw new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "local renderer dependency entry is not bound to its tracked target")
      }
      const packageRelative = `${localTarget.relative}/package.json`
      const packageBytes = trackedBytes.get(packageRelative)
      await assertTrackedRendererBytes(destination, packageRelative, packageBytes, "RENDERER_DEPENDENCY_INVALID")
      validateDependencyPackageName(packageBytes, name)
      return
    }
    await assertNoLinkAncestors(entry, {
      errorFactory: () => new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "installed renderer dependency contains a link"),
    })
    const metadata = await lstat(entry)
    const canonical = await realpath(entry)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || !isEqualToOrInside(nodeModulesRoot, canonical) || sameCanonicalPath(nodeModulesRoot, canonical)) {
      throw new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "installed renderer dependency escaped node_modules")
    }
    const packagePath = path.join(entry, "package.json")
    await assertNoLinkAncestors(packagePath, {
      errorFactory: () => new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "installed renderer dependency metadata contains a link"),
    })
    validateDependencyPackageName(await readFile(packagePath), name)
  } catch (error) {
    if (error instanceof ContentPreviewError) throw error
    throw new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "installed renderer dependency could not be verified")
  }
}

/** @param {string} destination @param {{required:Map<string,string>,optional:Map<string,string>,localSpecs:Map<string,string>,requiredTargets:Map<string,{relative:string,canonical:string}>}} metadata @param {ReadonlySet<string>} trackedFiles @param {ReadonlyMap<string,Buffer>} trackedBytes */
async function validateInstalledRendererDependencies(destination, metadata, trackedFiles, trackedBytes) {
  let nodeModulesRoot
  try {
    const nodeModulesPath = path.join(destination, "node_modules")
    await assertNoLinkAncestors(nodeModulesPath, {
      errorFactory: () => new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "renderer node_modules root contains a link"),
    })
    const nodeModulesMetadata = await lstat(nodeModulesPath)
    if (!nodeModulesMetadata.isDirectory() || nodeModulesMetadata.isSymbolicLink()) {
      throw new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "renderer node_modules root is not ordinary")
    }
    nodeModulesRoot = await realpath(nodeModulesPath)
    if (!isEqualToOrInside(destination, nodeModulesRoot) || sameCanonicalPath(destination, nodeModulesRoot)) {
      throw new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "renderer node_modules root escaped its renderer root")
    }
    const liveResolved = path.join(destination, "scripts", "slim-build.mjs")
    await assertNoLinkAncestors(liveResolved, {
      errorFactory: () => new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "live renderer entry contains a link"),
    })
    const liveEntry = await realpath(liveResolved)
    if (!isEqualToOrInside(destination, liveEntry) || isEqualToOrInside(nodeModulesRoot, liveEntry)) {
      throw new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "live renderer entry escaped its materialized source")
    }
  } catch (error) {
    throw new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "live renderer package resolution is not anchored")
  }
  for (const name of [...metadata.required.keys()].sort(utf8Order)) {
    if (isBuiltinDependency(name)) continue
    const relative = metadata.localSpecs.get(name)
    const localTarget = relative
      ? await inspectTrackedRendererTarget(destination, relative, trackedFiles, trackedBytes)
      : undefined
    await validateInstalledRendererDependency(destination, nodeModulesRoot, name, localTarget, trackedBytes)
  }
  for (const name of [...metadata.optional.keys()].sort(utf8Order)) {
    if (metadata.required.has(name) || isBuiltinDependency(name)) continue
    const entry = rendererDependencyEntry(nodeModulesRoot, name)
    try {
      await lstat(entry)
    } catch (error) {
      if (error?.code === "ENOENT") continue
      throw new ContentPreviewError("RENDERER_DEPENDENCY_INVALID", "optional live renderer dependency entry could not be inspected")
    }
    const relative = metadata.localSpecs.get(name)
    const localTarget = relative
      ? await inspectTrackedRendererTarget(destination, relative, trackedFiles, trackedBytes)
      : undefined
    await validateInstalledRendererDependency(destination, nodeModulesRoot, name, localTarget, trackedBytes)
  }
}

/** @param {{gitRoot?:string,gitDir?:string}} options @param {string} commitSha @param {{path:string,canonical:string,identity:import("node:fs").Stats}} claim */
async function materializeGitRenderer(options, commitSha, claim) {
  if (!isSha(commitSha)) throw new ContentPreviewError("RENDERER_PROVENANCE_INVALID", "live renderer provenance is invalid")
  const destination = claim.path
  await verifyDirectoryClaim(claim, "RENDERER_ROOT_INVALID")
  await assertNoNodeModulesAncestors(destination)
  const listing = Buffer.from(await gitRead(options, ["ls-tree", "-r", "-z", "--full-tree", commitSha], "buffer")).toString("utf8")
  const files = parseGitBlobRecords(listing, "", "RENDERER_TREE_INVALID")
  const seen = new Set(files.map((file) => file.relative))
  for (const required of requiredRendererFiles) {
    if (!seen.has(required)) throw new ContentPreviewError("RENDERER_SOURCE_INVALID", "live renderer commit does not contain the required build source")
  }
  const packageBytes = new Map()
  const trackedBytes = new Map()
  const rows = []
  for (const file of files.sort((left, right) => utf8Order(left.relative, right.relative))) {
    const bytes = await materializeGitBlob(options, commitSha, file.name, destination, file, "RENDERER_BYTES_INVALID")
    trackedBytes.set(file.relative, bytes)
    if (file.relative === "package.json" || file.relative === "package-lock.json") packageBytes.set(file.relative, bytes)
    rows.push(`${file.mode} ${file.blobSha} ${file.relative}\n`)
  }
  const packageJsonBytes = packageBytes.get("package.json")
  if (!packageJsonBytes) throw new ContentPreviewError("RENDERER_SOURCE_INVALID", "live renderer package metadata is missing")
  const dependencyMetadata = readRendererDependencyMetadata(packageJsonBytes)
  const preparedDependencies = await prepareRendererDependencyMetadata(destination, dependencyMetadata, seen, trackedBytes)
  const npmCli = process.platform === "win32"
    ? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : null
  const npmCommand = npmCli ? process.execPath : "npm"
  const npmArgs = npmCli ? [npmCli] : []
  npmArgs.push("ci", "--ignore-scripts", "--no-audit", "--no-fund")
  try {
    execFileSync(npmCommand, npmArgs, {
      cwd: destination,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
      maxBuffer: rendererInstallMaxBuffer,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: rendererInstallTimeoutMs,
      killSignal: "SIGTERM",
      windowsHide: true,
    })
  } catch (error) {
    throw new ContentPreviewError(rendererInstallErrorCode(error), "materialized live renderer dependencies could not be installed")
  }
  const installed = await lstat(path.join(destination, "node_modules")).catch(() => null)
  if (!installed?.isDirectory() || installed.isSymbolicLink()) throw new ContentPreviewError("RENDERER_INSTALL_FAILED", "materialized live renderer dependency root is invalid")
  for (const [relative, expected] of packageBytes) {
    await assertTrackedRendererBytes(destination, relative, expected, "RENDERER_SOURCE_INVALID")
  }
  await assertNoLinkAncestors(destination, {
    errorFactory: () => new ContentPreviewError("RENDERER_ROOT_INVALID", "live renderer materialization contains a link"),
  })
  await assertNoNodeModulesAncestors(destination)
  const canonical = await verifyDirectoryClaim(claim, "RENDERER_ROOT_INVALID")
  await validateInstalledRendererDependencies(destination, preparedDependencies, seen, trackedBytes)
  return {
    root: canonical,
    treeSha256: sha256(Buffer.from(rows.join(""), "utf8")),
  }
}

/** @param {string} vaultRoot @param {string} relative */
async function ordinaryFile(vaultRoot, relative) {
  const absolute = path.resolve(vaultRoot, ...relative.split("/"))
  if (!isEqualToOrInside(vaultRoot, absolute)) throw new ContentPreviewError("DISCOVERY_TARGET_UNSUPPORTED", "discovered target escaped the canonical Vault root")
  try {
    await assertNoLinkAncestors(absolute, { allowMissing: true, errorFactory: () => new ContentPreviewError("SOURCE_LINK_NOT_ALLOWED", "discovered source contains a link or reparse point") })
    const metadata = await lstat(absolute)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("not a regular file")
    await access(absolute)
    return { absolute, bytes: await readFile(absolute) }
  } catch (error) {
    if (error instanceof ContentPreviewError) throw error
    return null
  }
}

/** @param {string} target */
function targetCandidates(target) {
  let value = target.trim().replace(/\\/gu, "/").replace(/^\.\//u, "")
  if (!value || value.startsWith("/") || value.split("/").some((part) => part === ".." || part === "." || !part)) {
    throw new ContentPreviewError("DISCOVERY_TARGET_UNSUPPORTED", "direct Wiki-link target is outside the approved Knowledge roots")
  }
  if (value.toLowerCase().endsWith(".md")) value = value.slice(0, -3)
  if (value.startsWith("Knowledge/")) {
    const parts = value.split("/")
    if (parts.length !== 3 || !knowledgeCategoryNames.has(parts[1])) {
      throw new ContentPreviewError("DISCOVERY_TARGET_UNSUPPORTED", "direct Wiki-link target is outside the approved Knowledge roots")
    }
    return [`${parts.join("/")}.md`]
  }
  if (value.startsWith("Literature/")) {
    const parts = value.split("/")
    if (parts.length !== 3 || !["Syntheses", "Reviews & Maps"].includes(parts[1])) {
      throw new ContentPreviewError("DISCOVERY_TARGET_UNSUPPORTED", "direct Wiki-link target is outside the approved support roots")
    }
    return [`${parts.join("/")}.md`]
  }
  if (value.includes("/")) {
    const parts = value.split("/")
    if (parts.length !== 2 || !knowledgeCategoryNames.has(parts[0])) {
      throw new ContentPreviewError("DISCOVERY_TARGET_UNSUPPORTED", "direct Wiki-link target is outside the approved Knowledge roots")
    }
    return [`Knowledge/${parts.join("/")}.md`]
  }
  return knowledgeCategories.map(([folder]) => `Knowledge/${folder}/${value}.md`)
}

/** @param {string} vaultRoot @param {string} target */
async function resolveKnowledgeTarget(vaultRoot, target) {
  const candidates = targetCandidates(target)
  const matches = []
  for (const relative of candidates) {
    const result = await ordinaryFile(vaultRoot, relative)
    if (result) matches.push({ relative, ...result })
  }
  if (matches.length === 0) throw new ContentPreviewError("DISCOVERY_TARGET_UNRESOLVED", "a direct Knowledge target could not be resolved")
  if (matches.length > 1) throw new ContentPreviewError("DISCOVERY_TARGET_AMBIGUOUS", "a direct Knowledge target resolved to more than one page")
  const parsed = parseFrontmatter(matches[0].bytes)
  if (parsed.data.layer !== "content") throw new ContentPreviewError("DISCOVERY_TARGET_INELIGIBLE", "a direct Knowledge target is not public content")
  return { source: matches[0].relative, parsed }
}

/** @param {string} markdown @returns {Array<{target:string}>} */
function discoverWikiLinks(markdown) {
  const masked = markdown.split("")
  const mask = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (masked[index] !== "\n") masked[index] = " "
    }
  }
  let offset = 0
  let fence = null
  for (const line of markdown.split(/(?<=\n)/u)) {
    const fenceMatch = /^[ ]{0,3}(`{3,}|~{3,})/u.exec(line)
    if (fence) {
      mask(offset, offset + line.length)
      if (fenceMatch && fenceMatch[1][0] === fence.character && fenceMatch[1].length >= fence.length) fence = null
    } else if (fenceMatch) {
      fence = { character: fenceMatch[1][0], length: fenceMatch[1].length }
      mask(offset, offset + line.length)
    }
    offset += line.length
  }
  const visible = masked.join("")
  for (const match of visible.matchAll(/(`+)([\s\S]*?)\1/gu)) {
    const start = match.index
    if (start !== undefined) mask(start, start + match[0].length)
  }
  const source = masked.join("")
  const links = []
  const pattern = /(?<!!)\[\[([^\]|#\r\n]+)(?:#[^\]|\r\n]*)?(?:\|([^\]\r\n]*))?\]\]/gu
  for (const match of source.matchAll(pattern)) {
    if (match[0].indexOf("[[", 2) >= 0) throw new ContentPreviewError("SOURCE_NESTED_WIKILINK_NOT_ALLOWED", "nested wikilink openers are not supported")
    const start = match.index
    let slashes = 0
    for (let index = start - 1; index >= 0 && markdown[index] === "\\"; index -= 1) slashes += 1
    if (slashes % 2 === 1) continue
    links.push({ target: match[1].trim() })
  }
  return links
}

/** @param {string} vaultRoot @param {ReadonlySet<string>} mappedSources */
async function discoverEligible(vaultRoot, mappedSources) {
  const notesRoot = path.resolve(vaultRoot, "Literature", "Notes")
  try {
    await assertNoLinkAncestors(notesRoot, { errorFactory: () => new ContentPreviewError("DISCOVERY_ROOT_INVALID", "the bounded Literature/Notes root is not safe") })
    if (!(await lstat(notesRoot)).isDirectory()) throw new Error("not a directory")
  } catch (error) {
    if (error instanceof ContentPreviewError) throw error
    throw new ContentPreviewError("DISCOVERY_ROOT_INVALID", "the bounded Literature/Notes root is unavailable")
  }
  const entries = await readdir(notesRoot, { withFileTypes: true })
  entries.sort((left, right) => utf8Order(left.name, right.name))
  const papers = []
  const supportSources = new Map()
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new ContentPreviewError("SOURCE_LINK_NOT_ALLOWED", "bounded discovery contains a link or reparse point")
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const source = normalizedSource(`Literature/Notes/${entry.name}`)
    if (mappedSources.has(mapRecordKey(source))) continue
    const result = await ordinaryFile(vaultRoot, source)
    if (!result) continue
    let parsed
    try {
      parsed = parseFrontmatter(result.bytes)
    } catch {
      continue
    }
    if (parsed.data.layer !== "content" || parsed.data.type !== "literature-note" || parsed.data.status !== "integrated") continue
    const links = discoverWikiLinks(parsed.body.toString("utf8"))
    const linkedSources = new Set()
    for (const link of links) {
      const target = await resolveKnowledgeTarget(vaultRoot, link.target)
      linkedSources.add(target.source)
      if (!mappedSources.has(mapRecordKey(target.source))) supportSources.set(mapRecordKey(target.source), target.source)
    }
    papers.push({ source, bytes: result.bytes, parsed, linkedSources })
  }
  return { papers, supportSources: [...supportSources.values()].sort(utf8Order) }
}

/** @param {string} vaultRoot @param {string[]} sources */
async function buildAdditions(vaultRoot, sources, baselineEntries) {
  const baselineSources = new Set(baselineEntries.map((page) => mapRecordKey(page.source)))
  const baselineRoutes = new Set(baselineEntries.map((page) => page.route.toLocaleLowerCase("en-US")))
  const additions = []
  const seenSources = new Set(baselineSources)
  const seenRoutes = new Set(baselineRoutes)
  for (const source of sources) {
    const normalized = normalizedSource(source)
    if (seenSources.has(mapRecordKey(normalized))) continue
    const route = routeForSource(normalized)
    const routeKey = route.toLocaleLowerCase("en-US")
    if (seenRoutes.has(routeKey)) throw new ContentPreviewError("ROUTE_COLLISION", "deterministic route collides with an existing mapped route")
    const layout = normalized.startsWith("Literature/Notes/") ? "paper" : "support"
    additions.push({ source: normalized, route, layout })
    seenSources.add(mapRecordKey(normalized))
    seenRoutes.add(routeKey)
  }
  return additions
}

/** @param {string} root */
async function collectFiles(root) {
  const files = []
  async function visit(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => utf8Order(left.name, right.name))
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new ContentPreviewError("PREVIEW_TREE_INVALID", "private preview contains a link or reparse point")
      if (entry.isDirectory()) await visit(absolute, relative)
      else if (entry.isFile()) files.push({ relative, bytes: await readFile(absolute) })
      else throw new ContentPreviewError("PREVIEW_TREE_INVALID", "private preview contains a non-ordinary entry")
    }
  }
  await visit(root, "")
  return files.sort((left, right) => utf8Order(left.relative, right.relative))
}

/** @param {string} root */
async function candidateIdentity(root) {
  const files = await collectFiles(root)
  const rows = files.map(({ relative, bytes }) => `${relative}\0${sha256(bytes)}\n`).join("")
  return { files, digest: sha256(Buffer.from(rows, "utf8")) }
}

/** @param {string} mapPath @param {Buffer} expected */
async function assertMapSnapshot(mapPath, expected) {
  const actual = await readFile(mapPath)
  if (!actual.equals(expected)) throw new ContentPreviewError("MAP_SNAPSHOT_CHANGED", "immutable map snapshot changed before preview completion")
}

/** Freeze exact mapped Markdown bytes once for both site-presentation builds.
 * @param {string} vaultRoot
 * @param {ReadonlyArray<{source:string}>} pages
 * @param {string} destination
 * @param {{canonical:string,identity:import("node:fs").Stats}} sessionClaim
 */
async function snapshotPresentationSources(vaultRoot, pages, destination, sessionClaim) {
  await assertMissingSessionOutput(destination, sessionClaim)
  try {
    await mkdir(destination)
  } catch {
    throw new ContentPreviewError("SOURCE_SNAPSHOT_INVALID", "presentation source snapshot must be fresh")
  }
  const claim = await claimSessionOutput(destination, sessionClaim)
  const ordered = [...pages].sort((left, right) => utf8Order(left.source, right.source))
  for (const page of ordered) {
    const source = normalizedSource(page.source)
    const absolute = path.resolve(vaultRoot, ...source.split("/"))
    if (!isEqualToOrInside(vaultRoot, absolute)) throw new ContentPreviewError("SOURCE_SNAPSHOT_INVALID", "mapped source escaped the Vault root")
    let before
    let bytes
    let after
    try {
      await assertNoLinkAncestors(absolute, {
        errorFactory: () => new ContentPreviewError("SOURCE_LINK_NOT_ALLOWED", "mapped source contains a link or reparse point"),
      })
      before = await lstat(absolute)
      if (!before.isFile() || before.isSymbolicLink()) throw new Error("mapped source is not ordinary")
      bytes = await readFile(absolute)
      after = await lstat(absolute)
    } catch (error) {
      if (error instanceof ContentPreviewError) throw error
      throw new ContentPreviewError("SOURCE_SNAPSHOT_INVALID", "mapped source could not be snapshotted")
    }
    if (!after.isFile() || after.isSymbolicLink() || !sameFilesystemIdentity(before, after)
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
      throw new ContentPreviewError("SOURCE_CHANGED_DURING_SNAPSHOT", "mapped source changed during snapshot")
    }
    const target = path.join(claim.canonical, ...source.split("/"))
    if (!isEqualToOrInside(claim.canonical, target) || sameCanonicalPath(claim.canonical, target)) {
      throw new ContentPreviewError("SOURCE_SNAPSHOT_INVALID", "snapshot target escaped its owned root")
    }
    await assertNoLinkAncestors(target, {
      allowMissing: true,
      errorFactory: () => new ContentPreviewError("SOURCE_SNAPSHOT_INVALID", "snapshot target contains a link or reparse point"),
    })
    await mkdir(path.dirname(target), { recursive: true })
    await assertNoLinkAncestors(target, {
      allowMissing: true,
      errorFactory: () => new ContentPreviewError("SOURCE_SNAPSHOT_INVALID", "snapshot target changed during creation"),
    })
    try {
      await writeFile(target, bytes, { flag: "wx" })
      const metadata = await lstat(target)
      const readback = await readFile(target)
      if (!metadata.isFile() || metadata.isSymbolicLink() || !readback.equals(bytes)) throw new Error("snapshot readback changed")
    } catch {
      throw new ContentPreviewError("SOURCE_SNAPSHOT_INVALID", "snapshot bytes could not be verified")
    }
  }
  await verifyDirectoryClaim(claim, "SOURCE_SNAPSHOT_INVALID")
  return claim.canonical
}

/** @param {{gitRoot?:string,gitDir?:string}} options @param {string} liveSha @param {string} mainSha */
async function readPresentationSourceDiff(options, liveSha, mainSha) {
  if (!isSha(liveSha) || !isSha(mainSha)) throw new ContentPreviewError("RENDERER_DIFF_INVALID", "presentation renderer SHAs are invalid")
  let bytes
  try {
    bytes = Buffer.from(await gitRead(options, ["diff", "--name-only", "-z", liveSha, mainSha, "--"], "buffer"))
  } catch {
    throw new ContentPreviewError("RENDERER_DIFF_INVALID", "presentation renderer source diff was unavailable")
  }
  if (bytes.length > maxPresentationSourceDiffBytes) throw new ContentPreviewError("RENDERER_DIFF_INVALID", "presentation renderer source diff is too large")
  let text
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new ContentPreviewError("RENDERER_DIFF_INVALID", "presentation renderer source diff is not UTF-8")
  }
  if (text.length > 0 && !text.endsWith("\0")) throw new ContentPreviewError("RENDERER_DIFF_INVALID", "presentation renderer source diff is not NUL-delimited")
  const changed = text.split("\0").filter(Boolean)
  if (changed.length > maxPresentationSourceDiffEntries) throw new ContentPreviewError("RENDERER_DIFF_INVALID", "presentation renderer source diff has too many paths")
  const exact = new Set()
  const folded = new Set()
  for (const relative of changed) {
    const parts = relative.split("/")
    const fold = relative.toLocaleLowerCase("en-US")
    if (relative.normalize("NFC") !== relative || relative.includes("\\") || relative.startsWith("/")
      || /^[A-Za-z]:/u.test(relative) || path.posix.normalize(relative) !== relative
      || parts.some((part) => !part || part === "." || part === ".." || [...part].some((character) => {
        const code = character.codePointAt(0)
        return code !== undefined && (code < 0x20 || code === 0x7f)
      })) || exact.has(relative) || folded.has(fold)) {
      throw new ContentPreviewError("RENDERER_DIFF_INVALID", "presentation renderer source diff contains an unsafe path")
    }
    exact.add(relative)
    folded.add(fold)
  }
  return changed.sort(utf8Order)
}

/** @param {unknown} error */
function presentationQaCode(error) {
  const code = error && typeof error === "object"
    ? typeof error.error_code === "string" ? error.error_code : typeof error.code === "string" ? error.code : ""
    : ""
  return /^QA_[A-Z0-9_]+$/u.test(code) ? code : "QA_BROWSER_FAILED"
}

/** @param {string} siteRoot @param {ReadonlyArray<{source:string,route:string,layout:string}>} pages @param {ReadonlyArray<string>} sourceDiff @param {object} internal */
async function runPresentationQa(siteRoot, pages, sourceDiff, internal) {
  const qaOptions = Object.freeze({
    siteRoot,
    mappedRoutes: Object.freeze(pages.map((page) => Object.freeze({
      route: page.route,
      kind: page.layout === "paper" ? "paper" : routeKind(page.route),
      layout: page.layout,
    }))),
    basePath: presentationBasePath,
    sourceDiff: Object.freeze({ changedFiles: Object.freeze([...sourceDiff]) }),
  })
  try {
    const injected = internal?.qa ?? internal?.runHeadlessSiteQa ?? internal?.runQa
    const qaResult = typeof injected === "function"
      ? await injected(qaOptions)
      : await (await import("./site-headless-qa.mjs")).runHeadlessSiteQa(qaOptions)
    if (!qaResult || qaResult.status !== "pass") {
      throw new ContentPreviewError(presentationQaCode(qaResult), "headless site QA failed")
    }
    return qaResult
  } catch (error) {
    const code = error instanceof ContentPreviewError && /^QA_[A-Z0-9_]+$/u.test(error.code)
      ? error.code
      : presentationQaCode(error)
    throw new ContentPreviewError(code, "headless site QA failed")
  }
}

/** @param {unknown} screenshots @param {ReadonlySet<string>} allowedRoutes @param {{path:string,canonical:string,identity:import("node:fs").Stats}} sessionClaim @param {string} sessionRoot */
async function persistPresentationScreenshots(screenshots, allowedRoutes, sessionClaim, sessionRoot) {
  if (screenshots === undefined) return []
  if (!Array.isArray(screenshots)) throw new ContentPreviewError("QA_SCREENSHOT_INVALID", "headless QA screenshots are invalid")
  if (screenshots.length === 0) return []
  if (screenshots.length > maxPresentationScreenshots) throw new ContentPreviewError("QA_SCREENSHOT_LIMIT", "headless QA screenshots exceed the bounded count")
  const entries = []
  let totalBytes = 0
  for (const screenshot of screenshots) {
    if (!screenshot || typeof screenshot !== "object" || typeof screenshot.route !== "string" || !allowedRoutes.has(screenshot.route)) {
      throw new ContentPreviewError("QA_SCREENSHOT_INVALID", "headless QA screenshot route is not mapped")
    }
    const bytes = Buffer.isBuffer(screenshot.bytes)
      ? Buffer.from(screenshot.bytes)
      : screenshot.bytes instanceof Uint8Array ? Buffer.from(screenshot.bytes) : null
    if (!bytes || bytes.length === 0) throw new ContentPreviewError("QA_SCREENSHOT_INVALID", "headless QA screenshot bytes are invalid")
    if (bytes.length > maxPresentationScreenshotBytes) throw new ContentPreviewError("QA_SCREENSHOT_LIMIT", "headless QA screenshot is too large")
    totalBytes += bytes.length
    if (totalBytes > maxPresentationScreenshotBytes * maxPresentationScreenshots) {
      throw new ContentPreviewError("QA_SCREENSHOT_LIMIT", "headless QA screenshots are too large")
    }
    entries.push({ route: screenshot.route, bytes })
  }
  entries.sort((left, right) => utf8Order(left.route, right.route))
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].route === entries[index].route) throw new ContentPreviewError("QA_SCREENSHOT_INVALID", "headless QA screenshots contain a duplicate route")
  }
  const screenshotRoot = path.join(sessionRoot, "screenshots")
  await assertMissingSessionOutput(screenshotRoot, sessionClaim)
  try {
    await mkdir(screenshotRoot)
    await claimOrdinaryDirectory(screenshotRoot, "QA_SCREENSHOT_INVALID")
    const result = []
    for (const [index, entry] of entries.entries()) {
      const filename = `shot-${String(index).padStart(4, "0")}.png`
      const handle = `screenshots/${filename}`
      const destination = path.join(screenshotRoot, filename)
      await assertNoLinkAncestors(destination, {
        allowMissing: true,
        errorFactory: () => new ContentPreviewError("QA_SCREENSHOT_INVALID", "screenshot output contains a link"),
      })
      await writeFile(destination, entry.bytes, { flag: "wx" })
      await assertNoLinkAncestors(destination, {
        errorFactory: () => new ContentPreviewError("QA_SCREENSHOT_INVALID", "screenshot output changed during writeback"),
      })
      const metadata = await lstat(destination)
      const readback = await readFile(destination)
      if (!metadata.isFile() || metadata.isSymbolicLink() || !readback.equals(entry.bytes)) {
        throw new ContentPreviewError("QA_SCREENSHOT_INVALID", "screenshot output failed readback")
      }
      result.push({ route: entry.route, handle, sha256: sha256(readback), bytes: readback.length })
    }
    return result
  } catch (error) {
    if (error instanceof ContentPreviewError) throw error
    throw new ContentPreviewError("QA_SCREENSHOT_INVALID", "screenshot output failed")
  }
}

/** @param {string} root @param {string} target @param {{path:string,canonical:string,identity:import("node:fs").Stats}} sessionClaim */
async function moveSessionOutput(root, target, sessionClaim) {
  await verifyDirectoryClaim(sessionClaim, "WORK_ROOT_INVALID")
  await verifyDirectoryClaim(await claimOrdinaryDirectory(root, "OUTPUT_ROOT_INVALID"), "OUTPUT_ROOT_INVALID")
  await assertMissingSessionOutput(target, sessionClaim)
  try {
    await rename(root, target)
  } catch {
    throw new ContentPreviewError("OUTPUT_ROOT_INVALID", "private preview output could not be separated")
  }
  await claimSessionOutput(target, sessionClaim)
}

/** @param {{vaultRoot:string,gitRoot?:string,gitDir?:string,mainRef?:string,ghPagesRef?:string,contentMap?:string,baselineSite?:string,liveRendererSha?:string,rendererSha?:string}} options */
async function readAuthority(options) {
  const useGit = Boolean(options.gitRoot || options.gitDir || options.mainRef || options.ghPagesRef)
  if (!useGit) {
    throw new ContentPreviewError("GIT_REFS_REQUIRED", "private preview requires read-only main and gh-pages Git refs")
  }
  if (options.liveRendererSha !== undefined || options.rendererSha !== undefined) {
    throw new ContentPreviewError("RENDERER_PROVENANCE_INPUT_FORBIDDEN", "Git mode derives renderer provenance only from deployed gh-pages readback")
  }
  const gitOptions = { gitRoot: options.gitRoot || repoRoot, gitDir: options.gitDir }
  const mainRef = options.mainRef || "refs/heads/main"
  const ghPagesRef = options.ghPagesRef || "refs/heads/gh-pages"
  const mainSha = await readGitCommit(gitOptions, mainRef)
  const ghPagesSha = await readGitCommit(gitOptions, ghPagesRef)
  const mapBytes = await readGitMap(gitOptions, mainSha)
  const trailerSha = await readRendererTrailer(gitOptions, ghPagesSha)
  let liveRendererSha
  try {
    liveRendererSha = await readGitCommit(gitOptions, trailerSha)
  } catch {
    throw new ContentPreviewError("RENDERER_PROVENANCE_INVALID", "deployed gh-pages renderer provenance did not resolve to a commit")
  }
  return { mapBytes, mainSha, ghPagesSha, liveRendererSha, gitOptions, mainRef, ghPagesRef }
}

/** @param {string} root @param {string} code */
async function claimExclusiveDirectory(root, code) {
  await assertNoLinkAncestors(path.dirname(root), {
    allowMissing: true,
    errorFactory: () => new ContentPreviewError(code, "owned directory parent is not safe"),
  })
  try {
    await mkdir(root)
  } catch (error) {
    if (error?.code === "EEXIST") throw new ContentPreviewError("OUTPUT_EXISTS", "private preview output must be fresh")
    throw new ContentPreviewError(code, "owned directory could not be created")
  }
  return await claimOrdinaryDirectory(root, code)
}

/** @param {{path:string,canonical:string,identity:import("node:fs").Stats}} claim @param {string} [ownerCanonical] */
async function removeOwnedDirectory(claim, ownerCanonical) {
  try {
    const current = await verifyDirectoryClaim(claim, "CLEANUP_ROOT_INVALID")
    if (ownerCanonical && (!isEqualToOrInside(ownerCanonical, current) || sameCanonicalPath(ownerCanonical, current))) return false
    await rm(claim.path, { recursive: true, force: true })
    try {
      await lstat(claim.path)
      return false
    } catch (error) {
      if (error?.code === "ENOENT") return true
      return false
    }
  } catch {
    // Never widen cleanup to a path whose canonical identity or ownership changed.
    return false
  }
}

/** @param {string} root @param {{canonical:string,identity:import("node:fs").Stats}} sessionClaim */
async function assertMissingSessionOutput(root, sessionClaim) {
  const absolute = path.resolve(root)
  if (!isEqualToOrInside(sessionClaim.canonical, absolute) || sameCanonicalPath(sessionClaim.canonical, absolute)) {
    throw new ContentPreviewError("OUTPUT_ROOT_INVALID", "private preview output must be inside the exclusive session")
  }
  await verifyDirectoryClaim(sessionClaim, "WORK_ROOT_INVALID")
  await assertNoLinkAncestors(absolute, {
    allowMissing: true,
    errorFactory: () => new ContentPreviewError("OUTPUT_ROOT_INVALID", "private preview output contains a link or reparse point"),
  })
  try {
    await lstat(absolute)
  } catch (error) {
    if (error?.code === "ENOENT") return
    throw new ContentPreviewError("OUTPUT_ROOT_INVALID", "private preview output could not be checked")
  }
  throw new ContentPreviewError("OUTPUT_EXISTS", "private preview output must be fresh")
}

/** @param {string} root @param {{canonical:string,identity:import("node:fs").Stats}} sessionClaim */
async function claimSessionOutput(root, sessionClaim) {
  const claim = await claimOrdinaryDirectory(root, "OUTPUT_ROOT_INVALID")
  if (!isEqualToOrInside(sessionClaim.canonical, claim.canonical) || sameCanonicalPath(sessionClaim.canonical, claim.canonical)
    || !sameCanonicalPath(path.dirname(claim.canonical), sessionClaim.canonical)) {
    throw new ContentPreviewError("OUTPUT_ROOT_INVALID", "private preview output escaped the exclusive session")
  }
  await verifyDirectoryClaim(sessionClaim, "WORK_ROOT_INVALID")
  await verifyDirectoryClaim(claim, "OUTPUT_ROOT_INVALID")
  return claim
}

/** @param {{version:number,operation_id:string,lane:"content"|"site",status:string,summary:string,added_routes:any[],changed_routes:any[],removed_routes:any[],checks:any[],next_action:string,error_code:string|null,mapping_identity:any,candidate_identity:any,preview:any}} result @param {"content"|"site"} [expectedLane] */
function assertStructured(result, expectedLane = "content") {
  if (result.version !== 1 || !isOpaqueOperationId(result.operation_id) || result.lane !== expectedLane || !statuses.has(result.status)
    || !Array.isArray(result.added_routes) || !Array.isArray(result.changed_routes) || !Array.isArray(result.removed_routes)
    || !Array.isArray(result.checks)) throw new ContentPreviewError("STRUCTURED_RESULT_INVALID", "private preview result is invalid")
  return result
}

/**
 * @param {{vaultRoot:string,gitRoot?:string,gitDir?:string,mainRef?:string,ghPagesRef?:string,contentMap?:string,baselineSite?:string,workRoot?:string,output?:string,operationId?:string,liveRendererSha?:string,rendererSha?:string}} options
 * @param {{siteVerification?:boolean,removeOwnedDirectory?:(claim:{path:string,canonical:string,identity:import("node:fs").Stats},ownerCanonical?:string)=>Promise<boolean>}} [internal]
 */
async function prepareContentPrivatePreviewController(options, internal = {}) {
  const siteVerification = internal?.siteVerification === true
  const publicationReconciliation = internal?.publicationReconciliation === true
  const presentationInternal = internal?.sitePresentation && typeof internal.sitePresentation === "object" ? internal.sitePresentation : {}
  const sitePresentation = internal?.sitePresentation === true || presentationInternal.enabled === true
  const lane = siteVerification || sitePresentation ? "site" : "content"
  const suppliedOptions = options ?? {}
  const fallbackOperation = opaqueOperationId(`${lane}:${suppliedOptions.mainRef ?? ""}:${suppliedOptions.ghPagesRef ?? ""}`)
  const removeDirectory = typeof internal?.removeOwnedDirectory === "function"
    ? internal.removeOwnedDirectory
    : removeOwnedDirectory
  let operationId = fallbackOperation
  let sessionRoot = ""
  let workspaceCanonical = ""
  let sessionClaim = null
  let outputRoot = ""
  let outputClaim = null
  const rendererClaims = []
  let liveRendererRoot = ""
  let liveRendererTreeSha256 = null
  let mainRendererTreeSha256 = null
  let keepSession = false
  let mappingIdentity = { map_sha256: null, map_blob_sha: null, additions: [] }
  let result = null
  let failureChecks = [{ name: "content_private_preview", outcome: "fail" }]
  let cleanupFailed = false
  const cleanupOwnedDirectory = async (claim, ownerCanonical) => {
    try {
      const removed = await removeDirectory(claim, ownerCanonical)
      if (removed !== true) cleanupFailed = true
      return removed === true
    } catch {
      cleanupFailed = true
      return false
    }
  }
  try {
    if (!options || typeof options.vaultRoot !== "string" || !options.vaultRoot) throw new ContentPreviewError("VAULT_ROOT_REQUIRED", "canonical Vault root is required")
    if (options.output !== undefined) throw new ContentPreviewError("OUTPUT_OVERRIDE_FORBIDDEN", "private preview output is controller-owned")
    if (options.operationId !== undefined) operationId = validateOperationId(options.operationId)
    const vaultRoot = path.resolve(options.vaultRoot)
    const authority = await readAuthority(options)
    if (options.operationId === undefined) operationId = opaqueOperationId(`${authority.mainSha}:${authority.ghPagesSha}:${authority.liveRendererSha}:${sha256(authority.mapBytes)}`)
    const workspaceRoot = path.resolve(options.workRoot || defaultWorkRoot)
    await assertNoLinkAncestors(workspaceRoot, { allowMissing: true, errorFactory: () => new ContentPreviewError("WORK_ROOT_INVALID", "private preview work root is not safe") })
    if (pathsOverlap(vaultRoot, workspaceRoot)) throw new ContentPreviewError("PATH_OVERLAP_NOT_ALLOWED", "Vault and private preview work roots must be disjoint")
    await mkdir(workspaceRoot, { recursive: true })
    await assertNoLinkAncestors(workspaceRoot, { errorFactory: () => new ContentPreviewError("WORK_ROOT_INVALID", "private preview work root is not safe") })
    workspaceCanonical = await realpath(workspaceRoot)
    sessionRoot = path.join(workspaceCanonical, operationId)
    if (!isEqualToOrInside(workspaceCanonical, sessionRoot) || sessionRoot === workspaceCanonical) throw new ContentPreviewError("OPERATION_ID_INVALID", "operation identifier escaped the private work root")
    try {
      await mkdir(sessionRoot)
    } catch (error) {
      if (error?.code === "EEXIST") throw new ContentPreviewError("OPERATION_ID_REUSED", "operation identifier already has a private session")
      throw error
    }
    await assertNoLinkAncestors(sessionRoot, { errorFactory: () => new ContentPreviewError("WORK_ROOT_INVALID", "private preview session root is not safe") })
    sessionRoot = await realpath(sessionRoot)
    if (!isEqualToOrInside(workspaceCanonical, sessionRoot) || sessionRoot === workspaceCanonical) throw new ContentPreviewError("WORK_ROOT_INVALID", "private preview session root escaped the work root")
    sessionClaim = await claimOrdinaryDirectory(sessionRoot, "WORK_ROOT_INVALID")
    sessionRoot = sessionClaim.canonical
    const mapPath = path.join(sessionRoot, "site-content.yml")
    const baselineRoot = path.join(sessionRoot, "baseline")
    if (!authority.gitOptions) throw new ContentPreviewError("GIT_REFS_REQUIRED", "private preview requires deployed gh-pages readback")
    await extractGitSite(authority.gitOptions, authority.ghPagesSha, baselineRoot)
    const slimWorkRoot = path.join(sessionRoot, "slim-work")
    const sourceSnapshotRoot = sitePresentation ? path.join(sessionRoot, "content-snapshot") : ""
    const liveHandoffRoot = path.join(sessionRoot, sitePresentation ? "live-handoff" : "handoff")
    outputRoot = path.join(sessionRoot, sitePresentation ? "main-built-site" : "built-site")
    const liveOutputRoot = sitePresentation ? path.join(sessionRoot, "live-built-site") : outputRoot
    const mainHandoffRoot = sitePresentation ? path.join(sessionRoot, "main-handoff") : ""
    if (!isEqualToOrInside(sessionClaim.canonical, outputRoot) || sameCanonicalPath(sessionClaim.canonical, outputRoot)
      || !isEqualToOrInside(sessionClaim.canonical, liveOutputRoot) || sameCanonicalPath(sessionClaim.canonical, liveOutputRoot)
      || (mainHandoffRoot && (!isEqualToOrInside(sessionClaim.canonical, mainHandoffRoot) || sameCanonicalPath(sessionClaim.canonical, mainHandoffRoot)))
      || pathsOverlap(vaultRoot, outputRoot) || pathsOverlap(slimWorkRoot, outputRoot)
      || pathsOverlap(vaultRoot, liveOutputRoot) || pathsOverlap(slimWorkRoot, liveOutputRoot)) {
      throw new ContentPreviewError("PATH_OVERLAP_NOT_ALLOWED", "Vault, private work, and output roots must be disjoint")
    }
    await writeFile(mapPath, authority.mapBytes, { flag: "wx" })

    const baselineEntries = parseMapEntries(authority.mapBytes)
    const mappedSources = new Set(baselineEntries.map((page) => mapRecordKey(page.source)))
    const discovery = await discoverEligible(vaultRoot, mappedSources)
    const newPaperSources = discovery.papers.map((paper) => paper.source)
    const additions = await buildAdditions(vaultRoot, [...newPaperSources, ...discovery.supportSources], baselineEntries)
    const proposedMap = appendMapEntries(authority.mapBytes, additions)
    assertAppendOnly(baselineEntries, parseMapEntries(proposedMap))
    await writeFile(mapPath, proposedMap, { flag: "w" })
    const proposedPages = parseMapEntries(proposedMap)
    const routesByFile = new Map(proposedPages.map((page) => [routeFile(page.route), page]))
    const pagesByRoute = new Map(proposedPages.map((page) => [page.route, page]))
    const baselineRouteFiles = new Set(["index.html", ...routesByFile.keys()])
    const earlyRemovedRoutes = normalizeRoutePreviews(
      (await collectFiles(baselineRoot))
        .map(({ relative }) => ({ relative, route: routeFromDeletedFile(relative) }))
        .filter(({ route, relative }) => route !== null && !baselineRouteFiles.has(relative))
        .map(({ route }) => makeRoutePreview(route, pagesByRoute.get(route))),
    )
    if (earlyRemovedRoutes.length > 0) throw routeRemovalError(earlyRemovedRoutes)
    mappingIdentity = {
      map_sha256: sha256(proposedMap),
      map_blob_sha: gitBlobSha(proposedMap),
      additions: additions.map(({ source, route, layout }) => ({ source, route, layout })),
    }

    const buildVaultRoot = sitePresentation
      ? await snapshotPresentationSources(vaultRoot, proposedPages, sourceSnapshotRoot, sessionClaim)
      : vaultRoot

    const slimOptions = {
      command: "preflight",
      vaultRoot: buildVaultRoot,
      workRoot: slimWorkRoot,
      output: outputRoot,
      contentMap: mapPath,
    }
    const content = await preflight(slimOptions)
    if (content.mapSha256 !== mappingIdentity.map_sha256) throw new ContentPreviewError("MAP_IDENTITY_MISMATCH", "preflight did not consume the frozen map bytes")
    await assertMapSnapshot(mapPath, proposedMap)

    const candidateRendererSha = lane === "content" ? authority.mainSha : authority.liveRendererSha
    const liveClaim = await createRendererDirectory(cleanupOwnedDirectory)
    rendererClaims.push(liveClaim)
    if (pathsOverlap(vaultRoot, liveClaim.canonical) || pathsOverlap(workspaceCanonical, liveClaim.canonical)) {
      throw new ContentPreviewError("PATH_OVERLAP_NOT_ALLOWED", "candidate renderer materialization must be disjoint from private inputs")
    }
    const materializedLiveRenderer = await materializeGitRenderer(authority.gitOptions, candidateRendererSha, liveClaim)
    liveRendererRoot = materializedLiveRenderer.root
    liveRendererTreeSha256 = materializedLiveRenderer.treeSha256
    const buildOptions = { ...slimOptions, command: "build", rendererRoot: liveRendererRoot }
    await assertMissingSessionOutput(outputRoot, sessionClaim)
    const built = await build(buildOptions, content)
    outputClaim = await claimSessionOutput(outputRoot, sessionClaim)
    if (built.map_sha256 !== mappingIdentity.map_sha256) throw new ContentPreviewError("MAP_IDENTITY_MISMATCH", "build did not consume the frozen map bytes")
    await assertMapSnapshot(mapPath, proposedMap)
    const handoff = await prepareGhPages({
      builtSite: outputRoot,
      baselineSite: baselineRoot,
      output: liveHandoffRoot,
      contentMapBytes: proposedMap,
    })
    await assertMapSnapshot(mapPath, proposedMap)

    const routeEntries = (routes) => routes.map((route) => makeRoutePreview(route, pagesByRoute.get(route)))
    const addedRoutes = routeEntries(handoff.routeDiff.added)
    const removedRoutes = normalizeRoutePreviews([
      ...handoff.routeDiff.deleted.map((route) => makeRoutePreview(route, pagesByRoute.get(route))),
      ...handoff.diff.deleted
        .map(routeFromDeletedFile)
        .filter((route) => route !== null)
        .map((route) => makeRoutePreview(route, pagesByRoute.get(route))),
    ])
    const changedFiles = new Set(handoff.diff.changed)
    const changedRoutes = [...routesByFile.entries()]
      .filter(([file]) => changedFiles.has(file))
      .map(([, page]) => ({ title: path.posix.basename(page.source, ".md"), route: page.route, kind: page.layout === "paper" ? "paper" : routeKind(page.route) }))
      .sort((left, right) => utf8Order(left.route, right.route))
    if (removedRoutes.length > 0) throw routeRemovalError(removedRoutes)

    const candidate = await candidateIdentity(path.join(liveHandoffRoot, "site"))
    const candidateBinding = sha256(Buffer.from(`source_main=${authority.mainSha}\ngh_pages=${authority.ghPagesSha}\nmap=${mappingIdentity.map_sha256}\nlive_renderer=${authority.liveRendererSha}\nrenderer_tree=${liveRendererTreeSha256}\nsite=${candidate.digest}\n`, "utf8"))
    const changed = ((siteVerification || sitePresentation) && additions.length > 0) || addedRoutes.length > 0 || changedRoutes.length > 0
      || handoff.diff.added.length > 0 || handoff.diff.deleted.length > 0 || handoff.diff.changed.length > 0
    if (!changed && !sitePresentation && !publicationReconciliation) {
      keepSession = false
      const checks = [
        { name: "bounded_discovery", outcome: "pass" },
        { name: "immutable_map", outcome: "pass" },
        { name: "renderer_provenance", outcome: "pass" },
        { name: "privacy", outcome: "pass" },
        ...(siteVerification ? [{ name: "exact_live_content_equality", outcome: "pass" }] : []),
        { name: "no_change_side_effects", outcome: "pass" },
      ]
      result = assertStructured({
        version: 1,
        operation_id: operationId,
        lane,
        status: "no_change",
        summary: siteVerification ? "線上內容與目前公開網站完全一致。" : "目前沒有需要發布的筆記網頁變更。",
        added_routes: [],
        changed_routes: [],
        removed_routes: [],
        checks,
        next_action: "none",
        error_code: null,
        mapping_identity: mappingIdentity,
        candidate_identity: null,
        preview: { pages: built.pages, routes: built.routes.length, files: built.files },
      }, lane)
      return result
    }
    if (!changed && publicationReconciliation) {
      keepSession = true
      result = assertStructured({
        version: 1,
        operation_id: operationId,
        lane: "content",
        status: "ready_for_review",
        summary: "已保留與線上內容完全一致的私人候選，供發布狀態收斂。",
        added_routes: [],
        changed_routes: [],
        removed_routes: [],
        checks: [
          { name: "bounded_discovery", outcome: "pass" },
          { name: "immutable_map", outcome: "pass" },
          { name: "renderer_provenance", outcome: "pass" },
          { name: "slim_preflight", outcome: "pass" },
          { name: "slim_build", outcome: "pass" },
          { name: "privacy", outcome: "pass" },
          { name: "route_safety", outcome: "pass" },
          { name: "private_handoff", outcome: "pass" },
          { name: "publication_reconciliation", outcome: "pass" },
        ],
        next_action: "approve_content",
        error_code: null,
        mapping_identity: mappingIdentity,
        candidate_identity: {
          sha256: candidateBinding,
          site_sha256: candidate.digest,
          source_main_sha: authority.mainSha,
          base_gh_pages_sha: authority.ghPagesSha,
          live_renderer_sha: authority.liveRendererSha,
          renderer_tree_sha256: liveRendererTreeSha256,
          map_sha256: mappingIdentity.map_sha256,
        },
        preview: { pages: built.pages, routes: built.routes.length, files: built.files },
      })
      return result
    }
    if ((siteVerification || sitePresentation) && changed) {
      keepSession = false
      result = assertStructured({
        version: 1,
        operation_id: operationId,
        lane,
        status: "needs_attention",
        summary: "偵測到公開內容變更，請先執行 content lane。",
        added_routes: addedRoutes.sort((left, right) => utf8Order(left.route, right.route)),
        changed_routes: changedRoutes,
        removed_routes: [],
        checks: [
          { name: "bounded_discovery", outcome: "pass" },
          { name: "immutable_map", outcome: "pass" },
          { name: "renderer_provenance", outcome: "pass" },
          { name: "slim_preflight", outcome: "pass" },
          { name: "slim_build", outcome: "pass" },
          { name: "privacy", outcome: "pass" },
          { name: "route_safety", outcome: "pass" },
          { name: "private_handoff", outcome: "pass" },
          { name: "exact_live_content_equality", outcome: "fail" },
        ],
        next_action: "run_content_lane_first",
        error_code: "PENDING_CONTENT_CHANGES",
        mapping_identity: mappingIdentity,
        candidate_identity: null,
        preview: { pages: built.pages, routes: built.routes.length, files: built.files },
      }, lane)
      return result
    }
    if (sitePresentation) {
      const presentationChecks = [
        { name: "exact_live_content_equality", outcome: "pass" },
        { name: "main_renderer_provenance", outcome: "pass" },
        { name: "slim_build", outcome: "pass" },
        { name: "privacy", outcome: "pass" },
        { name: "route_safety", outcome: "pass" },
        { name: "private_handoff", outcome: "pass" },
      ]
      if (authority.mainSha === authority.liveRendererSha) {
        keepSession = false
        result = assertStructured({
          version: 1,
          operation_id: operationId,
          lane: "site",
          status: "no_change",
          summary: "線上內容與目前 main renderer 完全一致。",
          added_routes: [],
          changed_routes: [],
          removed_routes: [],
          checks: [
            ...presentationChecks,
            { name: "headless_qa", outcome: "not_run" },
            { name: "screenshot_decision", outcome: "not_run" },
          ],
          next_action: "none",
          error_code: null,
          mapping_identity: mappingIdentity,
          candidate_identity: null,
          preview: { pages: built.pages, routes: built.routes.length, files: built.files },
        }, "site")
        return result
      }

      const afterLiveEquality = presentationInternal.afterLiveEquality
      if (typeof afterLiveEquality === "function") {
        const context = Object.freeze({
          source_main_sha: authority.mainSha,
          base_gh_pages_sha: authority.ghPagesSha,
          live_renderer_sha: authority.liveRendererSha,
          map_sha256: mappingIdentity.map_sha256,
          lane: "site",
        })
        try {
          await afterLiveEquality(context)
        } catch {
          throw new ContentPreviewError("AFTER_LIVE_EQUALITY_FAILED", "post-equality presentation hook failed")
        }
      }
      await moveSessionOutput(outputRoot, liveOutputRoot, sessionClaim)
      outputClaim = null
      await assertMapSnapshot(mapPath, proposedMap)
      const mainClaim = await createRendererDirectory(cleanupOwnedDirectory)
      rendererClaims.push(mainClaim)
      if (pathsOverlap(vaultRoot, mainClaim.canonical) || pathsOverlap(workspaceCanonical, mainClaim.canonical)) {
        throw new ContentPreviewError("PATH_OVERLAP_NOT_ALLOWED", "main renderer materialization must be disjoint from private inputs")
      }
      const materializedMainRenderer = await materializeGitRenderer(authority.gitOptions, authority.mainSha, mainClaim)
      mainRendererTreeSha256 = materializedMainRenderer.treeSha256
      await assertMapSnapshot(mapPath, proposedMap)
      await assertMissingSessionOutput(outputRoot, sessionClaim)
      const mainBuilt = await build({ ...slimOptions, command: "build", rendererRoot: materializedMainRenderer.root }, content)
      outputClaim = await claimSessionOutput(outputRoot, sessionClaim)
      if (mainBuilt.map_sha256 !== mappingIdentity.map_sha256) throw new ContentPreviewError("MAP_IDENTITY_MISMATCH", "main build did not consume the frozen map bytes")
      await assertMapSnapshot(mapPath, proposedMap)
      const mainHandoff = await prepareGhPages({
        builtSite: outputRoot,
        baselineSite: baselineRoot,
        output: mainHandoffRoot,
        contentMapBytes: proposedMap,
      })
      await assertMapSnapshot(mapPath, proposedMap)
      const mainAddedRoutes = routeEntries(mainHandoff.routeDiff.added)
      const mainRemovedRoutes = normalizeRoutePreviews([
        ...mainHandoff.routeDiff.deleted.map((route) => makeRoutePreview(route, pagesByRoute.get(route))),
        ...mainHandoff.diff.deleted
          .map(routeFromDeletedFile)
          .filter((route) => route !== null)
          .map((route) => makeRoutePreview(route, pagesByRoute.get(route))),
      ])
      if (mainRemovedRoutes.length > 0) throw routeRemovalError(mainRemovedRoutes)
      const mainChangedFiles = new Set(mainHandoff.diff.changed)
      const mainChangedRoutes = [...routesByFile.entries()]
        .filter(([file]) => mainChangedFiles.has(file))
        .map(([, page]) => ({ title: path.posix.basename(page.source, ".md"), route: page.route, kind: page.layout === "paper" ? "paper" : routeKind(page.route) }))
        .sort((left, right) => utf8Order(left.route, right.route))
      const mainChanged = mainAddedRoutes.length > 0 || mainChangedRoutes.length > 0
        || mainHandoff.diff.added.length > 0 || mainHandoff.diff.deleted.length > 0 || mainHandoff.diff.changed.length > 0
      if (!mainChanged) {
        keepSession = false
        result = assertStructured({
          version: 1,
          operation_id: operationId,
          lane: "site",
          status: "no_change",
          summary: "線上內容與目前 main renderer 產生的網站完全一致。",
          added_routes: [],
          changed_routes: [],
          removed_routes: [],
          checks: [
            ...presentationChecks,
            { name: "headless_qa", outcome: "not_run" },
            { name: "screenshot_decision", outcome: "not_run" },
          ],
          next_action: "none",
          error_code: null,
          mapping_identity: mappingIdentity,
          candidate_identity: null,
          preview: { pages: mainBuilt.pages, routes: mainBuilt.routes.length, files: mainBuilt.files },
        }, "site")
        return result
      }

      const sourceDiff = await readPresentationSourceDiff(authority.gitOptions, authority.liveRendererSha, authority.mainSha)
      failureChecks = [
        ...presentationChecks,
        { name: "headless_qa", outcome: "fail" },
        { name: "screenshot_decision", outcome: "not_run" },
      ]
      const qaResult = await runPresentationQa(path.join(mainHandoffRoot, "site"), proposedPages, sourceDiff, presentationInternal)
      failureChecks = [
        ...presentationChecks,
        { name: "headless_qa", outcome: "pass" },
        { name: "screenshot_decision", outcome: "fail" },
      ]
      const screenshotEvidence = await persistPresentationScreenshots(
        qaResult.screenshots,
        new Set(proposedPages.map((page) => page.route)),
        sessionClaim,
        sessionRoot,
      )
      const mainCandidate = await candidateIdentity(path.join(mainHandoffRoot, "site"))
      const binding = sha256(Buffer.from([
        `source_main_sha=${authority.mainSha}`,
        `base_gh_pages_sha=${authority.ghPagesSha}`,
        `live_renderer_sha=${authority.liveRendererSha}`,
        `main_renderer_tree_sha256=${mainRendererTreeSha256}`,
        `map_sha256=${mappingIdentity.map_sha256}`,
        `site_sha256=${mainCandidate.digest}`,
      ].join("\n") + "\n", "utf8"))
      failureChecks = [
        ...presentationChecks,
        { name: "headless_qa", outcome: "pass" },
        { name: "screenshot_decision", outcome: screenshotEvidence.length > 0 ? "persisted" : "not_required" },
      ]
      keepSession = true
      result = assertStructured({
        version: 1,
        operation_id: operationId,
        lane: "site",
        status: "ready_for_review",
        summary: "已完成 main renderer 私人網站預覽，等待一次性發布核准。",
        added_routes: mainAddedRoutes.sort((left, right) => utf8Order(left.route, right.route)),
        changed_routes: mainChangedRoutes,
        removed_routes: [],
        checks: failureChecks,
        next_action: "approve_site",
        error_code: null,
        mapping_identity: mappingIdentity,
        candidate_identity: {
          sha256: binding,
          source_main_sha: authority.mainSha,
          base_gh_pages_sha: authority.ghPagesSha,
          live_renderer_sha: authority.liveRendererSha,
          main_renderer_tree_sha256: mainRendererTreeSha256,
          map_sha256: mappingIdentity.map_sha256,
          site_sha256: mainCandidate.digest,
        },
        preview: { pages: mainBuilt.pages, routes: mainBuilt.routes.length, files: mainBuilt.files, screenshots: screenshotEvidence },
      }, "site")
      return result
    }
    keepSession = true
    result = assertStructured({
      version: 1,
      operation_id: operationId,
      lane,
      status: "ready_for_review",
      summary: "已完成私人筆記網頁預覽，等待一次性發布核准。",
      added_routes: addedRoutes.sort((left, right) => utf8Order(left.route, right.route)),
      changed_routes: changedRoutes,
      removed_routes: [],
      checks: [
        { name: "bounded_discovery", outcome: "pass" },
        { name: "immutable_map", outcome: "pass" },
        { name: "renderer_provenance", outcome: "pass" },
        { name: "slim_preflight", outcome: "pass" },
        { name: "slim_build", outcome: "pass" },
        { name: "privacy", outcome: "pass" },
        { name: "route_safety", outcome: "pass" },
        { name: "private_handoff", outcome: "pass" },
      ],
      next_action: "approve_content",
      error_code: null,
      mapping_identity: mappingIdentity,
      candidate_identity: {
        sha256: candidateBinding,
        site_sha256: candidate.digest,
        source_main_sha: authority.mainSha,
        base_gh_pages_sha: authority.ghPagesSha,
        live_renderer_sha: authority.liveRendererSha,
        renderer_tree_sha256: liveRendererTreeSha256,
        map_sha256: mappingIdentity.map_sha256,
      },
      preview: { pages: built.pages, routes: built.routes.length, files: built.files },
    })
    return result
  } catch (error) {
    const code = errorCode(error)
    let removedRoutes = []
    if (error instanceof ContentPreviewError && error.code === "ROUTE_REMOVAL"
      && error.details && typeof error.details === "object" && error.details[routeRemovalDetailsMarker] === true) {
      try {
        removedRoutes = normalizeRoutePreviews(error.details.removedRoutes)
      } catch {
        removedRoutes = []
      }
    }
    keepSession = false
    result = assertStructured({
      version: 1,
      operation_id: operationId,
      lane,
      status: "needs_attention",
      summary: "私人筆記網頁預覽停止，請先處理列出的問題。",
      added_routes: [],
      changed_routes: [],
      removed_routes: removedRoutes,
      checks: failureChecks,
      next_action: "request_manual_review",
      error_code: code,
      mapping_identity: mappingIdentity,
      candidate_identity: null,
      preview: { pages: 0, routes: 0, files: 0 },
    }, lane)
    return result
  } finally {
    for (let index = rendererClaims.length - 1; index >= 0; index -= 1) {
      await cleanupOwnedDirectory(rendererClaims[index])
    }
    if (!keepSession && sessionClaim && workspaceCanonical) await cleanupOwnedDirectory(sessionClaim, workspaceCanonical)
    if (cleanupFailed && result) {
      result.status = "needs_attention"
      result.summary = "私人筆記網頁預覽清理失敗，請先處理殘留工作階段。"
      result.error_code = "CLEANUP_FAILED"
      result.checks = [{ name: "cleanup", outcome: "fail" }]
      result.next_action = "request_manual_cleanup"
      result.candidate_identity = null
    }
  }
}

/** @param {{vaultRoot:string,gitRoot?:string,gitDir?:string,mainRef?:string,ghPagesRef?:string,contentMap?:string,baselineSite?:string,workRoot?:string,output?:string,operationId?:string,liveRendererSha?:string,rendererSha?:string}} options */
export async function prepareContentPrivatePreview(options) {
  return await prepareContentPrivatePreviewController(options)
}

/** Publication-only seam: retain an exact deployed private candidate so Site can reconcile live QA and LKG state. */
export async function preparePublicationPrivateCandidate(options) {
  return await prepareContentPrivatePreviewController(options, { publicationReconciliation: true })
}

/** @param {{vaultRoot:string,gitRoot?:string,gitDir?:string,mainRef?:string,ghPagesRef?:string,contentMap?:string,baselineSite?:string,workRoot?:string,output?:string,operationId?:string,liveRendererSha?:string,rendererSha?:string}} options */
export async function prepareSitePrivatePreview(options) {
  return await prepareContentPrivatePreviewController(options, { sitePresentation: true })
}

/** Test-only site-presentation seam; only QA and post-equality behavior may be injected. */
export async function prepareSitePrivatePreviewForTest(options, internal) {
  const injected = internal && typeof internal === "object" ? internal : {}
  return await prepareContentPrivatePreviewController(options, {
    sitePresentation: {
      enabled: true,
      qa: injected.qa ?? injected.runHeadlessSiteQa ?? injected.headlessQa,
      afterLiveEquality: injected.afterLiveEquality,
    },
  })
}

/** @param {{vaultRoot:string,gitRoot?:string,gitDir?:string,mainRef?:string,ghPagesRef?:string,contentMap?:string,baselineSite?:string,workRoot?:string,output?:string,operationId?:string,liveRendererSha?:string,rendererSha?:string}} options */
export async function verifyExactLiveContentForSite(options) {
  return await prepareContentPrivatePreviewController(options, { siteVerification: true })
}

/** Test-only controller dependency seam; the production export never accepts injected cleanup behavior.
 * @param {Parameters<typeof prepareContentPrivatePreviewController>[0]} options
 * @param {Parameters<typeof prepareContentPrivatePreviewController>[1]} internal
 */
export async function prepareContentPrivatePreviewForTest(options, internal) {
  return await prepareContentPrivatePreviewController(options, internal)
}

export { parseMapEntries }
