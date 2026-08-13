// @ts-nocheck -- this module intentionally crosses bounded local HTTP and child-process seams.
import { createServer } from "node:http"
import { execFile as childExecFile, spawn as childSpawn } from "node:child_process"
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { promisify } from "node:util"

const execFile = promisify(childExecFile)
const repoRoot = path.resolve(import.meta.dirname, "..")
const defaultTimeoutMs = 30_000
const defaultReadbackTimeoutMs = 10_000
const defaultSnapshotBytes = 32 * 1024 * 1024
const defaultFileBytes = 16 * 1024 * 1024
const defaultOutputBytes = 128 * 1024
const defaultScreenshotBytes = 2 * 1024 * 1024
const maxAllowedLimit = 256 * 1024 * 1024
const profilePrefix = "tyler-vault-site-qa-"
const custom404Route = "/__t13_qa_not_found__/"
const qaOrigin = "http://127.0.0.1"
const allowedOptionKeys = new Set([
  "siteRoot",
  "routes",
  "mappedRoutes",
  "basePath",
  "projectBasePath",
  "sourceDiff",
  "visualDiff",
  "changedFiles",
  "qaAnomaly",
  "anomaly",
  "timeoutMs",
  "maxSnapshotBytes",
  "maxFileBytes",
  "maxOutputBytes",
  "maxScreenshotBytes",
])
const visualDiffKeys = new Set(["changedFiles", "files", "paths", "changed", "modified", "added", "deleted"])
const visualExtensions = new Set([".css", ".scss", ".sass", ".less", ".pcss"])
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
])
const stableCodes = new Set([
  "QA_OPTIONS_INVALID",
  "QA_BROWSER_UNAVAILABLE",
  "QA_BROWSER_FAILED",
  "QA_BROWSER_TIMEOUT",
  "QA_BROWSER_OUTPUT_LIMIT",
  "QA_BROWSER_TERMINATION_FAILED",
  "QA_BROWSER_DOM_MISSING",
  "QA_BROWSER_ROUTE_MISSING",
  "QA_BROWSER_ROUTE_STATUS",
  "QA_SITE_ROOT_INVALID",
  "QA_SITE_SNAPSHOT_INVALID",
  "QA_SITE_SNAPSHOT_LIMIT",
  "QA_MAPPED_ROUTE_MISSING",
  "QA_MAPPED_ROUTE_STATUS",
  "QA_CUSTOM_404_MISSING",
  "QA_CUSTOM_404_STATUS",
  "QA_ASSET_EXTERNAL",
  "QA_ASSET_PROTOCOL_RELATIVE",
  "QA_ASSET_TRAVERSAL",
  "QA_ASSET_ENCODED_ESCAPE",
  "QA_ASSET_MISSING",
  "QA_ASSET_INVALID",
  "QA_ASSET_STATUS",
  "QA_SERVER_START_FAILED",
  "QA_SERVER_READBACK_FAILED",
  "QA_SERVER_CLOSE_FAILED",
  "QA_PROFILE_INVALID",
  "QA_PROFILE_CLEANUP_FAILED",
  "QA_SCREENSHOT_MISSING",
  "QA_SCREENSHOT_INVALID",
  "QA_SCREENSHOT_LIMIT",
])

export class SiteHeadlessQaError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code)
    this.name = "SiteHeadlessQaError"
    this.code = code
  }
}

/** @param {unknown} value */
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** @param {string} left @param {string} right */
function utf8Order(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

/** @param {unknown} error */
function stableErrorCode(error) {
  const candidate = error && typeof error === "object" && typeof error.code === "string" ? error.code : ""
  return stableCodes.has(candidate) ? candidate : "QA_BROWSER_FAILED"
}

/** @param {unknown} value */
function invalidOption() {
  throw new SiteHeadlessQaError("QA_OPTIONS_INVALID")
}

/** @param {unknown} value */
function validateText(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")
    || [...value].some((character) => (character.codePointAt(0) ?? 0) < 0x20 && character !== "\n" && character !== "\r" && character !== "\t")) {
    invalidOption(value)
  }
  return value
}

/** @param {unknown} value @param {number} fallback */
function validateLimit(value, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maxAllowedLimit) invalidOption(value)
  return value
}

/** @param {unknown} value */
function validateTimeout(value) {
  if (value === undefined) return defaultTimeoutMs
  if (!Number.isSafeInteger(value) || value < 10 || value > 10 * 60 * 1000) invalidOption(value)
  return value
}

/** @param {unknown} value */
function normalizeBasePath(value) {
  if (value === undefined) return "/"
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")
    || value.includes("?") || value.includes("#") || value.includes("%") || value.includes("\u0000")) invalidOption(value)
  const normalized = value.startsWith("/") ? value : `/${value}`
  const withTrailingSlash = normalized.endsWith("/") ? normalized : `${normalized}/`
  if (withTrailingSlash.includes("//") || withTrailingSlash.split("/").some((segment) => segment === ".." || segment === ".")) invalidOption(value)
  if (![...withTrailingSlash].every((character) => /[A-Za-z0-9._~/-]/u.test(character))) invalidOption(value)
  return withTrailingSlash
}

/** @param {string} route */
function routeFile(route) {
  return route === "/" ? "index.html" : `${route.slice(1, -1)}/index.html`
}

/** @param {string} route */
function routeClass(route) {
  if (route === "/") return "home"
  if (route.startsWith("/papers/")) return "paper"
  if (route.startsWith("/knowledge/")) return "knowledge"
  return "unknown"
}

/** @param {unknown} value */
function normalizeMappedRoute(value) {
  let route
  let file
  let kind
  let layout
  if (typeof value === "string") {
    route = value
  } else if (isPlainObject(value)) {
    const keys = Object.keys(value).sort(utf8Order)
    if (keys.some((key) => !["file", "kind", "layout", "route"].includes(key)) || !keys.includes("route")) invalidOption(value)
    route = value.route
    file = value.file
    kind = value.kind
    layout = value.layout
  } else {
    invalidOption(value)
  }
  if (typeof route !== "string" || route.length === 0 || route.includes("\\") || route.includes("?")
    || route.includes("#") || route.includes("%") || route.includes("\u0000") || !route.startsWith("/") || !route.endsWith("/")) invalidOption(value)
  if (route === "/") {
    if (file !== undefined && file !== "index.html") invalidOption(value)
    if (kind !== undefined && kind !== "home") invalidOption(value)
    if (layout !== undefined && layout !== "home") invalidOption(value)
    return { route, file: "index.html", kind: "home" }
  }
  const className = routeClass(route)
  if (className === "unknown" || route.slice(1, -1).split("/").some((segment) => segment === "" || segment === "." || segment === "..")) invalidOption(value)
  if (!/^\/papers\/[A-Za-z0-9][A-Za-z0-9._~-]*\/$/u.test(route)
    && !/^\/knowledge\/(?:author|concept|method|task|synthesis|map)\/[A-Za-z0-9][A-Za-z0-9._~-]*\/$/u.test(route)) invalidOption(value)
  const expectedFile = routeFile(route)
  if (file !== undefined && file !== expectedFile) invalidOption(value)
  if (kind !== undefined) {
    const allowedKinds = className === "paper" ? new Set(["paper"]) : new Set(["knowledge", "author", "concept", "method", "task", "synthesis", "map"])
    if (typeof kind !== "string" || !allowedKinds.has(kind)) invalidOption(value)
  }
  if (layout !== undefined) {
    if (typeof layout !== "string" || !["paper", "support"].includes(layout)
      || (className === "paper" && layout !== "paper") || (className === "knowledge" && layout !== "support")) invalidOption(value)
  }
  return { route, file: expectedFile, kind: className }
}

/** @param {unknown} sourceDiff @param {boolean} qaAnomaly */
export function classifyVisualDiff(sourceDiff = undefined, qaAnomaly = false) {
  if (typeof qaAnomaly !== "boolean") throw new SiteHeadlessQaError("QA_OPTIONS_INVALID")
  const paths = []
  if (sourceDiff !== undefined) {
    if (Array.isArray(sourceDiff)) {
      for (const item of sourceDiff) {
        if (typeof item !== "string") throw new SiteHeadlessQaError("QA_OPTIONS_INVALID")
        paths.push(item)
      }
    } else if (isPlainObject(sourceDiff)) {
      for (const key of Object.keys(sourceDiff)) {
        if (!visualDiffKeys.has(key)) throw new SiteHeadlessQaError("QA_OPTIONS_INVALID")
        const entries = sourceDiff[key]
        if (!Array.isArray(entries)) throw new SiteHeadlessQaError("QA_OPTIONS_INVALID")
        for (const item of entries) {
          if (typeof item === "string") paths.push(item)
          else if (isPlainObject(item) && typeof item.path === "string" && Object.keys(item).every((entry) => entry === "path" || entry === "status")) paths.push(item.path)
          else throw new SiteHeadlessQaError("QA_OPTIONS_INVALID")
        }
      }
    } else {
      throw new SiteHeadlessQaError("QA_OPTIONS_INVALID")
    }
  }
  const normalizedFiles = [...new Set(paths.map((item) => {
    if (typeof item !== "string" || item.length === 0 || item.includes("\u0000")) throw new SiteHeadlessQaError("QA_OPTIONS_INVALID")
    return item.replaceAll("\\", "/")
  }))].sort(utf8Order)
  const classes = new Set()
  for (const file of normalizedFiles) {
    const lower = file.toLowerCase()
    const segments = lower.split("/")
    const basename = segments.at(-1) ?? ""
    const extension = path.posix.extname(basename)
    if (visualExtensions.has(extension)) classes.add("css")
    if (segments.includes("theme") || segments.includes("themes") || segments.includes("style") || segments.includes("styles")) classes.add("theme")
    if (segments.includes("template") || segments.includes("templates") || basename.includes("template")) classes.add("template")
    if (segments.includes("layout") || segments.includes("layouts") || basename.includes("layout")) classes.add("layout")
    if (segments.includes("component") || segments.includes("components") || basename.includes("component") || /(?:^|[-_.])render(?:[-_.]|$)/u.test(basename)) classes.add("component")
  }
  const reasons = [...classes].sort(utf8Order)
  return {
    required: reasons.length > 0 || qaAnomaly,
    screenshot_required: reasons.length > 0 || qaAnomaly,
    reasons,
    files: normalizedFiles,
    anomaly: qaAnomaly,
  }
}

/** @param {unknown} options */
function validateOptions(options) {
  if (!isPlainObject(options)) invalidOption(options)
  for (const key of Object.keys(options)) if (!allowedOptionKeys.has(key)) invalidOption(options)
  if (typeof options.siteRoot !== "string" || options.siteRoot.length === 0 || options.siteRoot.includes("\u0000")) invalidOption(options.siteRoot)
  const hasRoutes = options.routes !== undefined
  const hasMappedRoutes = options.mappedRoutes !== undefined
  if (hasRoutes === hasMappedRoutes) invalidOption(options)
  if (!Array.isArray(hasRoutes ? options.routes : options.mappedRoutes)) invalidOption(options)
  const entries = (hasRoutes ? options.routes : options.mappedRoutes).map(normalizeMappedRoute)
  const byRoute = new Map()
  for (const entry of entries) {
    if (byRoute.has(entry.route)) invalidOption(options)
    byRoute.set(entry.route, entry)
  }
  const mapped = [...byRoute.values()].filter((entry) => entry.route !== "/").sort((left, right) => utf8Order(left.route, right.route))
  const baseCandidates = [options.basePath, options.projectBasePath].filter((value) => value !== undefined)
  if (baseCandidates.length > 1) invalidOption(options)
  const basePath = normalizeBasePath(baseCandidates[0])
  const diffCandidates = [options.sourceDiff, options.visualDiff, options.changedFiles].filter((value) => value !== undefined)
  if (diffCandidates.length > 1) invalidOption(options)
  const sourceDiff = diffCandidates[0]
  const anomalyCandidates = [options.qaAnomaly, options.anomaly].filter((value) => value !== undefined)
  if (anomalyCandidates.length > 1 || (anomalyCandidates.length === 1 && typeof anomalyCandidates[0] !== "boolean")) invalidOption(options)
  const qaAnomaly = anomalyCandidates[0] ?? false
  const classification = classifyVisualDiff(sourceDiff, qaAnomaly)
  return Object.freeze({
    siteRoot: path.resolve(options.siteRoot),
    basePath,
    mapped,
    routes: ["/", ...mapped.map((entry) => entry.route)],
    representativeRoutes: {
      paper: mapped.find((entry) => entry.kind === "paper")?.route ?? null,
      knowledge: mapped.find((entry) => entry.kind === "knowledge")?.route ?? null,
    },
    sourceDiff,
    classification,
    timeoutMs: validateTimeout(options.timeoutMs),
    maxSnapshotBytes: validateLimit(options.maxSnapshotBytes, defaultSnapshotBytes),
    maxFileBytes: validateLimit(options.maxFileBytes, defaultFileBytes),
    maxOutputBytes: validateLimit(options.maxOutputBytes, defaultOutputBytes),
    maxScreenshotBytes: validateLimit(options.maxScreenshotBytes, defaultScreenshotBytes),
  })
}

/** @param {string} root @param {string} candidate */
function pathInside(root, candidate) {
  const normalize = process.platform === "win32" ? (value) => value.toLowerCase() : (value) => value
  const relative = path.relative(normalize(path.resolve(root)), normalize(path.resolve(candidate)))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

/** @param {string} left @param {string} right */
function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

/** @param {unknown} metadata */
function captureFsIdentity(metadata) {
  const dev = metadata?.dev
  const ino = metadata?.ino
  const hasNumericIdentity = (typeof dev === "bigint" || typeof dev === "number")
    && (typeof ino === "bigint" || typeof ino === "number")
    && !(dev === 0 || dev === 0n || ino === 0 || ino === 0n)
  if (hasNumericIdentity) return Object.freeze({ kind: "dev-ino", dev: String(dev), ino: String(ino) })
  const birthtime = metadata?.birthtimeNs ?? metadata?.birthtimeMs
  const ctime = metadata?.ctimeNs ?? metadata?.ctimeMs
  if (birthtime === undefined || ctime === undefined || (String(birthtime) === "0" && String(ctime) === "0")) return null
  return Object.freeze({ kind: "timestamps", birthtime: String(birthtime), ctime: String(ctime) })
}

/** @param {unknown} left @param {unknown} right */
function sameFsIdentity(left, right) {
  if (!isPlainObject(left) || !isPlainObject(right) || left.kind !== right.kind) return false
  if (left.kind === "dev-ino") return left.dev === right.dev && left.ino === right.ino
  return left.kind === "timestamps" && left.birthtime === right.birthtime && left.ctime === right.ctime
}

/** @param {string} candidate */
async function inspectOwnedDirectory(candidate) {
  try {
    const absolute = path.resolve(candidate)
    const parsed = path.parse(absolute)
    const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
    let cursor = parsed.root
    let metadata = null
    for (const segment of segments) {
      cursor = path.join(cursor, segment)
      metadata = await lstat(cursor, { bigint: true })
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null
      const canonicalCursor = await realpath(cursor)
      if (!samePath(canonicalCursor, cursor)) return null
    }
    if (!metadata || !metadata.isDirectory() || metadata.isSymbolicLink()) return null
    const canonicalPath = path.resolve(await realpath(absolute))
    const identity = captureFsIdentity(metadata)
    if (!identity) return null
    return Object.freeze({ path: absolute, canonicalPath, identity })
  } catch {
    return null
  }
}

/** @param {string} root @param {string} candidate */
function strictlyInside(root, candidate) {
  return pathInside(root, candidate) && !samePath(root, candidate)
}

/** @param {object} claim */
async function isOwnedProfileClaimValid(claim) {
  if (!isPlainObject(claim)
    || typeof claim.path !== "string"
    || typeof claim.canonicalPath !== "string"
    || typeof claim.ownerRoot !== "string"
    || typeof claim.siteRoot !== "string") return false
  const ownerRoot = await inspectOwnedDirectory(claim.ownerRoot)
  const profile = await inspectOwnedDirectory(claim.path)
  if (!ownerRoot || !profile) return false
  if (!samePath(ownerRoot.canonicalPath, claim.ownerRoot)
    || !sameFsIdentity(ownerRoot.identity, claim.ownerRootIdentity)) return false
  if (!samePath(profile.canonicalPath, claim.canonicalPath)
    || !sameFsIdentity(profile.identity, claim.identity)) return false
  if (pathInside(repoRoot, ownerRoot.canonicalPath) || pathInside(repoRoot, profile.canonicalPath)) return false
  if (!strictlyInside(ownerRoot.canonicalPath, profile.canonicalPath)) return false
  if (pathInside(claim.siteRoot, profile.canonicalPath)) return false
  return true
}

/** @param {string} candidate */
async function isPathAbsent(candidate) {
  try {
    await lstat(candidate)
    return false
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR"
  }
}

/** @param {string} candidate */
async function assertOrdinaryNoLinkRoot(candidate) {
  const absolute = path.resolve(candidate)
  const parsed = path.parse(absolute)
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let cursor = parsed.root
  for (const segment of segments) {
    cursor = path.join(cursor, segment)
    let metadata
    try {
      metadata = await lstat(cursor)
    } catch {
      throw new SiteHeadlessQaError("QA_SITE_ROOT_INVALID")
    }
    if (metadata.isSymbolicLink()) throw new SiteHeadlessQaError("QA_SITE_ROOT_INVALID")
  }
  let rootMetadata
  try {
    rootMetadata = await lstat(absolute)
  } catch {
    throw new SiteHeadlessQaError("QA_SITE_ROOT_INVALID")
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new SiteHeadlessQaError("QA_SITE_ROOT_INVALID")
}

/** @param {string} siteRoot @param {number} maxSnapshotBytes @param {number} maxFileBytes */
async function readImmutableSnapshot(siteRoot, maxSnapshotBytes, maxFileBytes) {
  await assertOrdinaryNoLinkRoot(siteRoot)
  const files = new Map()
  let totalBytes = 0
  async function visit(directory, prefix) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      throw new SiteHeadlessQaError("QA_SITE_SNAPSHOT_INVALID")
    }
    entries.sort((left, right) => utf8Order(left.name, right.name))
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new SiteHeadlessQaError("QA_SITE_SNAPSHOT_INVALID")
      if (entry.isDirectory()) {
        await visit(absolute, relative)
        continue
      }
      if (!entry.isFile()) throw new SiteHeadlessQaError("QA_SITE_SNAPSHOT_INVALID")
      let metadataBefore
      let bytes
      let metadataAfter
      try {
        metadataBefore = await lstat(absolute)
        if (!metadataBefore.isFile() || metadataBefore.isSymbolicLink() || metadataBefore.size > maxFileBytes) {
          if (metadataBefore.size > maxFileBytes) throw new SiteHeadlessQaError("QA_SITE_SNAPSHOT_LIMIT")
          throw new SiteHeadlessQaError("QA_SITE_SNAPSHOT_INVALID")
        }
        bytes = await readFile(absolute)
        metadataAfter = await lstat(absolute)
      } catch (error) {
        if (error instanceof SiteHeadlessQaError) throw error
        throw new SiteHeadlessQaError("QA_SITE_SNAPSHOT_INVALID")
      }
      if (!metadataAfter.isFile() || metadataAfter.isSymbolicLink() || metadataBefore.size !== metadataAfter.size || bytes.length !== metadataAfter.size) {
        throw new SiteHeadlessQaError("QA_SITE_SNAPSHOT_INVALID")
      }
      totalBytes += bytes.length
      if (totalBytes > maxSnapshotBytes) throw new SiteHeadlessQaError("QA_SITE_SNAPSHOT_LIMIT")
      if (files.has(relative)) throw new SiteHeadlessQaError("QA_SITE_SNAPSHOT_INVALID")
      files.set(relative, Buffer.from(bytes))
    }
  }
  await visit(path.resolve(siteRoot), "")
  return Object.freeze({ files, totalBytes })
}

/** @param {string} basePath @param {string} route */
function joinBasePath(basePath, route) {
  return basePath === "/" ? route : `${basePath.slice(0, -1)}${route}`
}

/** @param {string} relative */
function documentRouteForHtml(relative) {
  if (relative === "index.html") return "/"
  if (relative === "404.html") return custom404Route
  if (relative.endsWith("/index.html")) return `/${relative.slice(0, -"index.html".length)}`
  return `/${relative}`
}

/** @param {string} tag */
function parseTagAttributes(tag) {
  const attributes = new Map()
  const opening = tag.indexOf(" ")
  if (opening < 0) return attributes
  const body = tag.slice(opening)
  const pattern = /([A-Za-z_:][A-Za-z0-9:._-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu
  for (const match of body.matchAll(pattern)) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "")
  }
  return attributes
}

/** @param {string} html */
function extractAssetReferences(html) {
  const references = []
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const attributes = parseTagAttributes(match[0])
    const href = attributes.get("href")
    const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/u)
    if (href !== undefined && (rel.includes("stylesheet") || /\.css(?:[?#]|$)/iu.test(href))) references.push({ attribute: "href", value: href })
  }
  for (const match of html.matchAll(/<script\b[^>]*>/giu)) {
    const attributes = parseTagAttributes(match[0])
    const src = attributes.get("src")
    if (src !== undefined) references.push({ attribute: "src", value: src })
  }
  return references
}

/** @param {string} reference @param {string} documentPath @param {string} basePath @param {Map<string,Buffer>} files */
function resolveAssetReference(reference, documentPath, basePath, files) {
  if (typeof reference !== "string" || reference.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(reference)) throw new SiteHeadlessQaError("QA_ASSET_INVALID")
  const value = reference.trim()
  if (value.startsWith("//")) throw new SiteHeadlessQaError("QA_ASSET_PROTOCOL_RELATIVE")
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) throw new SiteHeadlessQaError("QA_ASSET_EXTERNAL")
  if (value.includes("\\")) throw new SiteHeadlessQaError("QA_ASSET_TRAVERSAL")
  const rawPath = value.split(/[?#]/u, 1)[0]
  if (/%(?:00|2e|2f|5c|25(?:2e|2f|5c))/iu.test(rawPath)) throw new SiteHeadlessQaError("QA_ASSET_ENCODED_ESCAPE")
  let resolved
  try {
    resolved = new URL(value, `${qaOrigin}${joinBasePath(basePath, documentPath)}`)
  } catch {
    throw new SiteHeadlessQaError("QA_ASSET_INVALID")
  }
  if (resolved.origin !== qaOrigin) throw new SiteHeadlessQaError("QA_ASSET_EXTERNAL")
  if (/%(?:00|2e|2f|5c|25(?:2e|2f|5c))/iu.test(resolved.pathname)) throw new SiteHeadlessQaError("QA_ASSET_ENCODED_ESCAPE")
  let decodedPath
  try {
    decodedPath = decodeURIComponent(resolved.pathname)
  } catch {
    throw new SiteHeadlessQaError("QA_ASSET_ENCODED_ESCAPE")
  }
  if (decodedPath.includes("\\") || decodedPath.includes("\u0000")) throw new SiteHeadlessQaError("QA_ASSET_TRAVERSAL")
  if (basePath !== "/" && !decodedPath.startsWith(basePath)) throw new SiteHeadlessQaError("QA_ASSET_TRAVERSAL")
  const relative = basePath === "/" ? decodedPath.slice(1) : decodedPath.slice(basePath.length)
  if (!relative || relative.endsWith("/") || relative.split("/").some((segment) => segment === "..")) throw new SiteHeadlessQaError("QA_ASSET_TRAVERSAL")
  if (!files.has(relative)) throw new SiteHeadlessQaError("QA_ASSET_MISSING")
  return relative
}

/** @param {{files:Map<string,Buffer>} } snapshot @param {string} basePath */
function validateHtmlAssetReferences(snapshot, basePath) {
  const assets = new Set()
  for (const [relative, bytes] of [...snapshot.files.entries()].sort(([left], [right]) => utf8Order(left, right))) {
    if (!/\.html$/iu.test(relative)) continue
    const html = bytes.toString("utf8")
    const documentPath = documentRouteForHtml(relative)
    for (const reference of extractAssetReferences(html)) {
      assets.add(resolveAssetReference(reference.value, documentPath, basePath, snapshot.files))
    }
  }
  return [...assets].sort(utf8Order)
}

/** @param {string} target */
function rawTargetPath(target) {
  const question = target.indexOf("?")
  const hash = target.indexOf("#")
  const cut = [question, hash].filter((index) => index >= 0).sort((left, right) => left - right)[0]
  return cut === undefined ? target : target.slice(0, cut)
}

/** @param {string} target */
function rejectUnsafeRequestTarget(target) {
  const rawPath = rawTargetPath(target)
  if (rawPath.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(rawPath)) return "external"
  if (/%(?:00|2e|2f|5c|25(?:2e|2f|5c))/iu.test(rawPath)) return "encoded"
  if (rawPath.includes("\\") || rawPath.split("/").some((segment) => segment === "..")) return "traversal"
  return null
}

/** @param {string} target @param {string} basePath @param {Map<string,string>} routeFiles @param {Map<string,Buffer>} files */
function resolveRequest(target, basePath, routeFiles, files) {
  const unsafe = rejectUnsafeRequestTarget(target)
  if (unsafe) return { status: 400, body: Buffer.alloc(0), kind: unsafe }
  let parsed
  try {
    parsed = new URL(target, qaOrigin)
  } catch {
    return { status: 400, body: Buffer.alloc(0), kind: "invalid" }
  }
  let decodedPath
  try {
    decodedPath = decodeURIComponent(parsed.pathname)
  } catch {
    return { status: 400, body: Buffer.alloc(0), kind: "encoded" }
  }
  if (decodedPath.includes("\\") || decodedPath.includes("\u0000")) return { status: 400, body: Buffer.alloc(0), kind: "traversal" }
  if (basePath !== "/" && !decodedPath.startsWith(basePath)) return { status: 404, body: files.get("404.html"), kind: "unknown" }
  const relative = basePath === "/" ? decodedPath.slice(1) : decodedPath.slice(basePath.length)
  const route = relative === "" ? "/" : relative.endsWith("/") ? `/${relative}` : null
  if (route && routeFiles.has(route)) {
    const file = routeFiles.get(route)
    return { status: 200, body: files.get(file), kind: "route", route }
  }
  if (relative && files.has(relative)) return { status: 200, body: files.get(relative), kind: "asset" }
  return { status: 404, body: files.get("404.html"), kind: "unknown" }
}

/** @param {string|undefined} relative */
function contentTypeFor(relative) {
  const extension = path.posix.extname(relative ?? "").toLowerCase()
  return contentTypes.get(extension) ?? "application/octet-stream"
}

/** @param {{files:Map<string,Buffer>} } snapshot @param {ReadonlyArray<{route:string,file:string}>} routes @param {string} basePath */
function makeRouteFiles(snapshot, routes, basePath) {
  if (!snapshot.files.has("404.html")) throw new SiteHeadlessQaError("QA_CUSTOM_404_MISSING")
  const routeFiles = new Map()
  for (const entry of routes) {
    if (!snapshot.files.has(entry.file)) throw new SiteHeadlessQaError("QA_MAPPED_ROUTE_MISSING")
    routeFiles.set(entry.route, entry.file)
  }
  return { routeFiles, custom404UrlPath: joinBasePath(basePath, custom404Route) }
}

/** @param {import("node:http").Server} server */
async function closeHttpServer(server) {
  if (!server.listening) return
  try {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections()
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  } catch {
    throw new SiteHeadlessQaError("QA_SERVER_CLOSE_FAILED")
  }
}

/** @param {string} host @param {number} port @param {string} pathName */
function localUrl(host, port, pathName) {
  return `http://${host}:${port}${pathName}`
}

/** @param {number} port @param {string} basePath @param {Map<string,string>} routeFiles @param {{files:Map<string,Buffer>}} snapshot */
function createLoopbackServer(port, basePath, routeFiles, snapshot) {
  const server = createServer((request, response) => {
    const target = typeof request.url === "string" ? request.url : ""
    const result = resolveRequest(target, basePath, routeFiles, snapshot.files)
    response.statusCode = result.status
    if (result.status === 200 || result.status === 404) {
      response.setHeader("Content-Type", contentTypeFor(result.kind === "route" ? routeFiles.get(result.route) : result.kind === "asset" ? rawTargetPath(target) : "404.html"))
      response.setHeader("Cache-Control", "no-store")
    }
    if (request.method === "HEAD") response.end()
    else response.end(result.body)
  })
  return server
}

/** @param {import("node:http").Server} server */
async function listenLoopback(server) {
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening)
        reject(error)
      }
      const onListening = () => {
        server.off("error", onError)
        resolve()
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(0, "127.0.0.1")
    })
  } catch {
    throw new SiteHeadlessQaError("QA_SERVER_START_FAILED")
  }
  const address = server.address()
  if (!address || typeof address === "string" || address.address !== "127.0.0.1" || address.port === 0) {
    throw new SiteHeadlessQaError("QA_SERVER_START_FAILED")
  }
  return address.port
}

/** @param {string} url @param {number} expected @param {number} timeoutMs @param {string} statusCode */
async function readBack(url, expected, timeoutMs, statusCode) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { redirect: "manual", signal: controller.signal })
    const body = await response.arrayBuffer()
    if (response.status !== expected) throw new SiteHeadlessQaError(statusCode)
    if (expected === 404 && body.byteLength === 0) throw new SiteHeadlessQaError("QA_CUSTOM_404_STATUS")
  } catch (error) {
    if (error instanceof SiteHeadlessQaError) throw error
    throw new SiteHeadlessQaError("QA_SERVER_READBACK_FAILED")
  } finally {
    clearTimeout(timer)
  }
}

/** @param {number} port @param {string} basePath @param {ReadonlyArray<string>} routes @param {ReadonlyArray<string>} assets @param {number} timeoutMs @param {typeof readBack} readBackFn */
async function verifyLoopbackRoutes(port, basePath, routes, assets, timeoutMs, readBackFn) {
  for (const route of routes) {
    const outcome = await readBackFn(localUrl("127.0.0.1", port, joinBasePath(basePath, route)), 200, timeoutMs, "QA_MAPPED_ROUTE_STATUS")
    if (outcome === false) throw new SiteHeadlessQaError("QA_MAPPED_ROUTE_STATUS")
  }
  const notFound = await readBackFn(localUrl("127.0.0.1", port, joinBasePath(basePath, custom404Route)), 404, timeoutMs, "QA_CUSTOM_404_STATUS")
  if (notFound === false) throw new SiteHeadlessQaError("QA_CUSTOM_404_STATUS")
  for (const asset of assets) {
    const outcome = await readBackFn(localUrl("127.0.0.1", port, joinBasePath(basePath, `/${asset}`)), 200, timeoutMs, "QA_ASSET_STATUS")
    if (outcome === false) throw new SiteHeadlessQaError("QA_ASSET_STATUS")
  }
}

/** @param {unknown} value */
function normalizeScreenshotBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  return null
}

/** @param {unknown} result */
function resultAnomaly(result) {
  if (!isPlainObject(result)) return false
  if (result.qa_anomaly === true || result.anomaly === true) return true
  return Array.isArray(result.anomalies) && result.anomalies.length > 0
}

/** @param {unknown} result @param {{visitUrls:string[], visitEntries:Array, screenshotRoutes:string[]}} context */
function validateBrowserResult(result, context) {
  if (result === true || result === undefined || (isPlainObject(result) && result.ok === true && result.pages === undefined && result.visitedUrls === undefined && result.visitedRoutes === undefined)) {
    return { anomaly: false, screenshots: [] }
  }
  if (!isPlainObject(result)) throw new SiteHeadlessQaError("QA_BROWSER_FAILED")
  if (result.ok === false || result.status === "fail" || result.error_code) {
    const code = typeof result.error_code === "string" && stableCodes.has(result.error_code) ? result.error_code : "QA_BROWSER_FAILED"
    throw new SiteHeadlessQaError(code === "QA_BROWSER_TIMEOUT" ? code : "QA_BROWSER_FAILED")
  }
  const visited = result.visitedUrls ?? result.visitedRoutes
  if (visited !== undefined) {
    if (!Array.isArray(visited)) throw new SiteHeadlessQaError("QA_BROWSER_ROUTE_MISSING")
    const normalized = new Set(visited.map((value) => typeof value === "string" ? value : value?.url ?? value?.route).filter((value) => typeof value === "string"))
    for (const entry of context.visitEntries) if (!normalized.has(entry.url) && !normalized.has(entry.route)) throw new SiteHeadlessQaError("QA_BROWSER_ROUTE_MISSING")
  }
  if (result.pages !== undefined) {
    if (!Array.isArray(result.pages)) throw new SiteHeadlessQaError("QA_BROWSER_DOM_MISSING")
    for (const entry of context.visitEntries) {
      const page = result.pages.find((candidate) => candidate?.url === entry.url || candidate?.route === entry.route)
      if (!page) throw new SiteHeadlessQaError("QA_BROWSER_ROUTE_MISSING")
      if (page.dom === undefined || page.dom === null || String(page.dom).length === 0) throw new SiteHeadlessQaError("QA_BROWSER_DOM_MISSING")
      if (page.status !== undefined && page.status !== entry.expectedStatus) throw new SiteHeadlessQaError("QA_BROWSER_ROUTE_STATUS")
    }
  }
  const screenshots = Array.isArray(result.screenshots) ? result.screenshots : []
  return { anomaly: resultAnomaly(result), screenshots }
}

/** @param {string} executable @param {string[]} args @param {{timeoutMs:number,maxOutputBytes:number,platform?:string,spawn?:Function,execFile?:Function,terminateProcessTree?:Function}} deps */
async function runBrowserChild(executable, args, deps) {
  const platform = deps.platform ?? process.platform
  const spawnImpl = deps.spawn ?? childSpawn
  let child
  try {
    child = spawnImpl(executable, args, {
      windowsHide: true,
      detached: platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch {
    throw new SiteHeadlessQaError("QA_BROWSER_FAILED")
  }
  const pid = Number.isInteger(child?.pid) ? child.pid : null
  const stdout = { chunks: [], total: 0, overflow: false }
  const stderr = { chunks: [], total: 0, overflow: false }
  const collect = (stream, target) => {
    if (!stream || typeof stream.on !== "function") return
    stream.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      target.total += bytes.length
      if (target.total <= deps.maxOutputBytes) target.chunks.push(bytes)
      else target.overflow = true
    })
  }
  collect(child?.stdout, stdout)
  collect(child?.stderr, stderr)
  const closePromise = new Promise((resolve, reject) => {
    if (!child || typeof child.once !== "function") {
      reject(new SiteHeadlessQaError("QA_BROWSER_FAILED"))
      return
    }
    child.once("error", () => reject(new SiteHeadlessQaError("QA_BROWSER_FAILED")))
    child.once("close", (code, signal) => resolve({ code, signal }))
  })
  const timeoutMs = deps.timeoutMs
  let timer
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true }), timeoutMs)
  })
  const outcome = await Promise.race([closePromise, timeoutPromise])
  clearTimeout(timer)
  if (outcome?.timeout) {
    await terminateOwnProcess(pid, deps)
    await Promise.race([closePromise.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 250))])
    throw new SiteHeadlessQaError("QA_BROWSER_TIMEOUT")
  }
  if (stdout.overflow || stderr.overflow) {
    await terminateOwnProcess(pid, deps)
    throw new SiteHeadlessQaError("QA_BROWSER_OUTPUT_LIMIT")
  }
  if (outcome.code !== 0) throw new SiteHeadlessQaError("QA_BROWSER_FAILED")
  return {
    stdout: Buffer.concat(stdout.chunks),
    stderr: Buffer.concat(stderr.chunks),
  }
}

/** @param {number|null} pid @param {{platform?:string,execFile?:Function,terminateProcessTree?:Function}} deps */
async function terminateOwnProcess(pid, deps) {
  if (pid === null || pid <= 0) throw new SiteHeadlessQaError("QA_BROWSER_TERMINATION_FAILED")
  try {
    if (typeof deps.terminateProcessTree === "function") {
      const outcome = await deps.terminateProcessTree(pid)
      if (outcome === false) throw new Error("termination was not confirmed")
      return
    }
    const platform = deps.platform ?? process.platform
    if (platform === "win32") {
      const execImpl = deps.execFile
      if (execImpl) {
        await invokeExecFile(execImpl, "taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true })
      } else {
        await execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 2_000 })
      }
      return
    }
    process.kill(-pid, "SIGTERM")
  } catch (error) {
    if (error instanceof SiteHeadlessQaError && error.code === "QA_BROWSER_TERMINATION_FAILED") throw error
    throw new SiteHeadlessQaError("QA_BROWSER_TERMINATION_FAILED")
  }
}

/** @param {Function} implementation @param {string} file @param {string[]} args @param {object} options */
function invokeExecFile(implementation, file, args, options) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, stdout, stderr) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve({ stdout, stderr })
    }
    try {
      const result = implementation(file, args, options, finish)
      if (result && typeof result.then === "function") result.then((value) => finish(null, value?.stdout, value?.stderr), finish)
    } catch (error) {
      finish(error)
    }
  })
}

/** @param {string} executable @param {{visitEntries:Array,visitUrls:string[],screenshotRoutes:string[],profileDirectory:string,timeoutMs:number,maxOutputBytes:number,maxScreenshotBytes:number,browserExecutable:string,captureScreenshots:boolean}} context @param {object} deps */
async function defaultBrowserRunner(context, deps) {
  const pages = []
  const screenshotTargets = new Map(context.screenshotRoutes.map((route, index) => [route, index]))
  const screenshotDirectory = path.join(context.profileDirectory, "screenshots")
  if (context.captureScreenshots && context.screenshotRoutes.length > 0) await mkdir(screenshotDirectory, { recursive: true })
  const deadline = Date.now() + context.timeoutMs
  for (const entry of context.visitEntries) {
    const remaining = deadline - Date.now()
    if (remaining < 10) throw new SiteHeadlessQaError("QA_BROWSER_TIMEOUT")
    const screenshotIndex = screenshotTargets.get(entry.route)
    const screenshotPath = screenshotIndex === undefined ? null : path.join(screenshotDirectory, `shot-${screenshotIndex}.png`)
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--enable-logging=stderr",
      "--log-level=0",
      `--user-data-dir=${context.profileDirectory}`,
      "--window-size=1440,1100",
      "--dump-dom",
    ]
    if (screenshotPath !== null) args.push(`--screenshot=${screenshotPath}`)
    args.push(entry.url)
    const output = await runBrowserChild(context.browserExecutable, args, {
      ...deps,
      timeoutMs: Math.min(remaining, context.timeoutMs),
      maxOutputBytes: context.maxOutputBytes,
    })
    pages.push({
      route: entry.route,
      url: entry.url,
      status: entry.expectedStatus,
      dom: output.stdout.toString("utf8"),
      console: [],
      diagnostics: { process: output.stderr.toString("utf8") },
    })
  }
  const screenshots = []
  for (const route of context.screenshotRoutes) {
    const index = screenshotTargets.get(route)
    const screenshotPath = path.join(screenshotDirectory, `shot-${index}.png`)
    let bytes
    try {
      bytes = await readFile(screenshotPath)
    } catch {
      throw new SiteHeadlessQaError("QA_SCREENSHOT_MISSING")
    }
    if (bytes.length === 0) throw new SiteHeadlessQaError("QA_SCREENSHOT_INVALID")
    if (bytes.length > context.maxScreenshotBytes) throw new SiteHeadlessQaError("QA_SCREENSHOT_LIMIT")
    screenshots.push({ route, bytes: Buffer.from(bytes) })
  }
  return { ok: true, pages, screenshots }
}

/** @param {string[]} candidates */
async function firstAccessibleExecutable(candidates) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "string") continue
    try {
      const metadata = await lstat(candidate)
      if (metadata.isFile() && !metadata.isSymbolicLink()) {
        await access(candidate)
        return candidate
      }
    } catch {
      continue
    }
  }
  return null
}

async function discoverHeadlessBrowserExecutable() {
  const candidates = []
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles
    const programFilesX86 = process.env["ProgramFiles(x86)"]
    const localAppData = process.env.LOCALAPPDATA
    const windowsRoot = process.env.WINDIR ?? process.env.SystemRoot
    const volumeRoot = windowsRoot ? path.parse(path.resolve(windowsRoot)).root : null
    const systemProgramFiles = volumeRoot ? path.join(volumeRoot, "Program Files") : null
    const systemProgramFilesX86 = volumeRoot ? path.join(volumeRoot, "Program Files (x86)") : null
    for (const root of [programFilesX86, programFiles, localAppData, systemProgramFilesX86, systemProgramFiles]) {
      if (!root) continue
      candidates.push(path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"))
      candidates.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"))
    }
  } else {
    candidates.push(
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    )
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!directory) continue
      for (const name of ["microsoft-edge", "microsoft-edge-stable", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) candidates.push(path.join(directory, name))
    }
  }
  const executable = await firstAccessibleExecutable([...new Set(candidates)])
  if (!executable) throw new SiteHeadlessQaError("QA_BROWSER_UNAVAILABLE")
  return executable
}

/** @param {string} siteRoot @param {{makeTempProfile?:Function}} deps */
async function createOwnedProfile(siteRoot, deps) {
  const make = deps.makeTempProfile ?? ((prefix) => mkdtemp(prefix))
  const ownerRoot = await inspectOwnedDirectory(os.tmpdir())
  if (!ownerRoot
    || pathInside(repoRoot, ownerRoot.canonicalPath)
    || !isPlainObject(ownerRoot.identity)) throw new SiteHeadlessQaError("QA_PROFILE_INVALID")
  let profile
  try {
    profile = await make(path.join(os.tmpdir(), profilePrefix))
  } catch {
    throw new SiteHeadlessQaError("QA_PROFILE_INVALID")
  }
  if (isPlainObject(profile) && typeof profile.path === "string") profile = profile.path
  if (typeof profile !== "string" || profile.length === 0) throw new SiteHeadlessQaError("QA_PROFILE_INVALID")
  const profileInfo = await inspectOwnedDirectory(profile)
  if (!profileInfo
    || !strictlyInside(ownerRoot.canonicalPath, profileInfo.canonicalPath)
    || pathInside(repoRoot, profileInfo.canonicalPath)
    || pathInside(siteRoot, profileInfo.canonicalPath)) throw new SiteHeadlessQaError("QA_PROFILE_INVALID")
  return Object.freeze({
    path: profileInfo.path,
    canonicalPath: profileInfo.canonicalPath,
    identity: profileInfo.identity,
    ownerRoot: ownerRoot.canonicalPath,
    ownerRootIdentity: ownerRoot.identity,
    siteRoot: path.resolve(siteRoot),
  })
}

/** @param {object} claim @param {object} deps */
async function removeOwnedProfile(claim, deps) {
  try {
    if (!await isOwnedProfileClaimValid(claim)) return false
    if (typeof deps.beforeRemoveTempProfile === "function") {
      const prepared = await deps.beforeRemoveTempProfile(claim.path)
      if (prepared === false) return false
    }
    if (!await isOwnedProfileClaimValid(claim)) return false
    let outcome
    if (typeof deps.removeTempProfile === "function") outcome = await deps.removeTempProfile(claim.path)
    else outcome = await rm(claim.path, { recursive: true, force: true })
    if (outcome === false) return false
    return await isPathAbsent(claim.path)
  } catch {
    return false
  }
}

/** @param {ReadonlyArray<string>} routes @param {{paper:string|null,knowledge:string|null}} representatives */
function screenshotRoutesFor(representatives) {
  return [representatives.paper, representatives.knowledge].filter((route, index, all) => typeof route === "string" && all.indexOf(route) === index)
}

/** @param {object} validated @param {object} internal */
async function runValidatedQa(validated, internal) {
  const injectedRunner = internal && (internal.browserRunner ?? internal.runBrowser)
  const production = !injectedRunner && !internal?.browserExecutable
  let browserExecutable
  let profileClaim
  let server
  let result = {
    status: "fail",
    checks: [],
    routes: [...validated.routes],
    representative_routes: { ...validated.representativeRoutes },
    screenshot_required: validated.classification.required,
    screenshots: [],
    error_code: null,
  }
  const addCheck = (name, outcome) => result.checks.push({ name, outcome })
  try {
    if (production) browserExecutable = await discoverHeadlessBrowserExecutable()
    else browserExecutable = internal?.browserExecutable ?? "test-browser"
    addCheck("browser_executable", "pass")

    const snapshot = await readImmutableSnapshot(validated.siteRoot, validated.maxSnapshotBytes, validated.maxFileBytes)
    addCheck("site_snapshot", "pass")
    const htmlAssets = validateHtmlAssetReferences(snapshot, validated.basePath)
    addCheck("html_assets", "pass")
    const routeEntries = [{ route: "/", file: "index.html", kind: "home" }, ...validated.mapped]
    const { routeFiles, custom404UrlPath } = makeRouteFiles(snapshot, routeEntries, validated.basePath)
    addCheck("mapped_routes", "pass")

    profileClaim = await createOwnedProfile(validated.siteRoot, internal ?? {})
    server = createLoopbackServer(0, validated.basePath, routeFiles, snapshot)
    const listen = internal?.listenLoopback ?? listenLoopback
    let port
    try {
      port = await listen(server)
    } catch {
      throw new SiteHeadlessQaError("QA_SERVER_START_FAILED")
    }
    addCheck("loopback_server", "pass")
    const readBackFn = internal?.readBack ?? readBack
    await verifyLoopbackRoutes(port, validated.basePath, validated.routes, htmlAssets, defaultReadbackTimeoutMs, readBackFn)
    addCheck("route_readback", "pass")

    const visitEntries = [
      ...validated.routes.map((route) => ({ route, url: localUrl("127.0.0.1", port, joinBasePath(validated.basePath, route)), expectedStatus: 200 })),
      { route: custom404Route, url: localUrl("127.0.0.1", port, custom404UrlPath), expectedStatus: 404 },
    ]
    const visualRoutes = screenshotRoutesFor(validated.representativeRoutes)
    const runner = injectedRunner ?? ((context) => defaultBrowserRunner(context, internal ?? {}))
    const runOnce = async (captureScreenshots, reason = null) => {
      const context = {
        browserExecutable,
        profileDirectory: profileClaim.path,
        baseUrl: localUrl("127.0.0.1", port, validated.basePath),
        basePath: validated.basePath,
        routes: [...validated.routes],
        visitEntries,
        visitUrls: visitEntries.map((entry) => entry.url),
        custom404Url: visitEntries.at(-1).url,
        screenshotRoutes: captureScreenshots ? [...visualRoutes] : [],
        screenshotUrls: captureScreenshots ? visualRoutes.map((route) => localUrl("127.0.0.1", port, joinBasePath(validated.basePath, route))) : [],
        captureScreenshots,
        screenshotReason: reason,
        captureConsole: true,
        timeoutMs: validated.timeoutMs,
        maxOutputBytes: validated.maxOutputBytes,
        maxScreenshotBytes: validated.maxScreenshotBytes,
      }
      let runnerResult
      let timeoutHandle
      try {
        if (!injectedRunner) {
          runnerResult = await runner(context)
        } else {
          const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new SiteHeadlessQaError("QA_BROWSER_TIMEOUT")), validated.timeoutMs)
          })
          const invocation = typeof runner === "function" ? runner(context) : runner.run(context)
          runnerResult = await Promise.race([
            invocation,
            timeoutPromise,
          ])
        }
      } catch (error) {
        if (error instanceof SiteHeadlessQaError) throw error
        throw new SiteHeadlessQaError("QA_BROWSER_FAILED")
      } finally {
        clearTimeout(timeoutHandle)
      }
      return validateBrowserResult(runnerResult, context)
    }

    let browserResult = await runOnce(validated.classification.required, validated.classification.required ? "visual-source-diff" : null)
    let anomaly = browserResult.anomaly
    let screenshots = browserResult.screenshots
    if (anomaly && !validated.classification.required) {
      result.screenshot_required = true
      browserResult = await runOnce(true, "qa-anomaly")
      screenshots = browserResult.screenshots
    }
    addCheck("browser_routes", "pass")
    const screenshotRequired = validated.classification.required || anomaly
    result.screenshot_required = screenshotRequired
    if (screenshotRequired && visualRoutes.length > 0) {
      const byRoute = new Map()
      for (const item of screenshots) {
        if (!isPlainObject(item) || typeof item.route !== "string") throw new SiteHeadlessQaError("QA_SCREENSHOT_INVALID")
        if (!visualRoutes.includes(item.route)) throw new SiteHeadlessQaError("QA_SCREENSHOT_INVALID")
        const bytes = normalizeScreenshotBytes(item.bytes)
        if (!bytes || bytes.length === 0) throw new SiteHeadlessQaError("QA_SCREENSHOT_INVALID")
        if (bytes.length > validated.maxScreenshotBytes) throw new SiteHeadlessQaError("QA_SCREENSHOT_LIMIT")
        byRoute.set(item.route, bytes)
      }
      if (byRoute.size !== visualRoutes.length) throw new SiteHeadlessQaError("QA_SCREENSHOT_MISSING")
      result.screenshots = visualRoutes.map((route) => ({ route, bytes: byRoute.get(route) }))
    }
    addCheck("screenshots", "pass")
    result.status = "pass"
    return result
  } catch (error) {
    const code = stableErrorCode(error)
    result.error_code = code
    result.status = "fail"
    result.checks.push({ name: checkNameFor(code), outcome: "fail" })
    return result
  } finally {
    if (server) {
      try {
        const closeServer = internal?.closeHttpServer ?? closeHttpServer
        const closeOutcome = await closeServer(server)
        if (closeOutcome === false) throw new SiteHeadlessQaError("QA_SERVER_CLOSE_FAILED")
      } catch {
        result.status = "fail"
        result.error_code = "QA_SERVER_CLOSE_FAILED"
        result.checks.push({ name: "server_cleanup", outcome: "fail" })
      }
    }
    if (profileClaim) {
      let cleanupSucceeded = false
      try {
        cleanupSucceeded = await removeOwnedProfile(profileClaim, internal ?? {})
      } catch {
        cleanupSucceeded = false
      }
      if (!cleanupSucceeded) {
        result.status = "fail"
        result.error_code = "QA_PROFILE_CLEANUP_FAILED"
        result.checks.push({ name: "profile_cleanup", outcome: "fail" })
      }
    }
  }
}

/** @param {string} code */
function checkNameFor(code) {
  if (code.startsWith("QA_ASSET_")) return "html_assets"
  if (code === "QA_SITE_ROOT_INVALID" || code.startsWith("QA_SITE_SNAPSHOT")) return "site_snapshot"
  if (code.startsWith("QA_MAPPED_ROUTE") || code === "QA_CUSTOM_404_MISSING") return "mapped_routes"
  if (code === "QA_SERVER_START_FAILED" || code === "QA_SERVER_CLOSE_FAILED") return "loopback_server"
  if (code === "QA_SERVER_READBACK_FAILED" || code === "QA_CUSTOM_404_STATUS") return "route_readback"
  if (code.startsWith("QA_PROFILE_")) return "profile_cleanup"
  if (code.startsWith("QA_SCREENSHOT_")) return "screenshots"
  if (code === "QA_BROWSER_TERMINATION_FAILED") return "browser_termination"
  if (code.startsWith("QA_BROWSER_")) return "browser_routes"
  return "options"
}

/** @param {object} validated */
function emptyFailure(validated, code) {
  const classification = validated?.classification ?? { required: false }
  return {
    status: "fail",
    checks: [{ name: code === "QA_OPTIONS_INVALID" ? "options" : checkNameFor(code), outcome: "fail" }],
    routes: validated ? [...validated.routes] : [],
    representative_routes: validated ? { ...validated.representativeRoutes } : { paper: null, knowledge: null },
    screenshot_required: Boolean(classification.required),
    screenshots: [],
    error_code: code,
  }
}

/** @param {unknown} options */
export async function runHeadlessSiteQa(options) {
  let validated
  try {
    validated = validateOptions(options)
  } catch (error) {
    return emptyFailure(null, stableErrorCode(error) === "QA_BROWSER_FAILED" ? "QA_OPTIONS_INVALID" : stableErrorCode(error))
  }
  return runValidatedQa(validated, {})
}

/** @param {unknown} options @param {unknown} internal */
export async function runHeadlessSiteQaForTest(options, internal) {
  let validated
  try {
    validated = validateOptions(options)
  } catch {
    return emptyFailure(null, "QA_OPTIONS_INVALID")
  }
  if (internal !== undefined && !isPlainObject(internal)) return emptyFailure(validated, "QA_OPTIONS_INVALID")
  return runValidatedQa(validated, internal ?? {})
}

export const classifyScreenshotRequirement = classifyVisualDiff
