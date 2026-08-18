#!/usr/bin/env node
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import {
  constants,
} from "node:fs"
import {
  cp,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { TextDecoder } from "node:util"
import { fileURLToPath } from "node:url"

import Ajv2020Module from "ajv/dist/2020.js"
import { fromMarkdown } from "mdast-util-from-markdown"

import {
  parseFrontmatter,
  SlimContentError,
} from "../lib/slim-content-map.mjs"
import {
  hasFsCode,
  isEqualToOrInside,
} from "../lib/filesystem-safety.mjs"
import { createQuartzPublicNavigation } from "../lib/quartz-public-navigation.mjs"
import { ProjectPageTemplateError, selectProjectPageTemplate } from "../lib/project-page-template.mjs"
import {
  containsZoteroSchemeDisclosure,
  projectZoteroManagedMarkdown,
  validateZoteroManagedMarkdown,
  zoteroManagedRange,
} from "../lib/zotero-public-projection.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const Ajv2020 = /** @type {any} */ (Ajv2020Module)
const toolchainMetadataPath = path.join(repoRoot, "config", "quartz-toolchain.json")
const secretRulesPath = path.join(repoRoot, "config", "public-secret-rules.toml")
const scholarlyThemePath = path.join(repoRoot, "styles", "tracer-scholarly.scss")
const projectFontStylesPath = path.join(repoRoot, "styles", "tracer-fonts.css")
const projectFontAssetPath = path.join(repoRoot, "assets", "fonts")
const projectSiteIconPath = path.join(repoRoot, "assets", "site-icon.png")
const projectSiteIconSha256 = "d0996d7737c07ac76c9f48d335c29aacaa42a330568d26d2600cf3eb6b1a81f3"
/** @type {Readonly<Record<string,string>>} */
const projectFontAssetHashes = Object.freeze({
  "newsreader-variable.woff2": "1faa3380ac0e87e057b180e03fd94bd708a612afb67d2590677be4508909fae9",
  "newsreader-italic-variable.woff2": "d184d5e6a967ffea109d9f99fa245eccbff221e27f30bfd7d6fdb2940fcc6265",
  "source-sans-3-variable.woff2": "5f16566f7a40d39b339ad26be151fa5a1ab1f0c2574c7a2e619765584a1acbd8",
  "source-sans-3-italic-variable.woff2": "b4959abc0569392f87c6c6ac612f90e3fe0104d283724189b7d8b6f61af347d3",
})
const projectFontAssets = Object.freeze(Object.keys(projectFontAssetHashes))
const projectSiteBasePath = "/Tyler-Vault_PaperNote_ReadingSite/"
const quartzContentIndexFile = "index.html"
const testCapability = "t03-regression-v1"
function testHooksEnabled() {
  return process.env.TYLER_TRACER_TEST_CAPABILITY === testCapability
}

/** @param {string} name */
function testHook(name) {
  return testHooksEnabled() ? process.env[name] : undefined
}

class TracerError extends Error {
  /** @param {string} code @param {string} message @param {Record<string,unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message)
    this.code = code
    this.details = details
  }
}

/** @param {Buffer} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Authenticate reviewed project-owned binary assets before exempting their
 * opaque bytes from text-shaped disclosure scanning. Unknown assets remain
 * subject to the complete candidate gate. @param {string} relative @param {Buffer} bytes */
function authenticateProjectAsset(relative, bytes) {
  if (relative === "static/icon.png") {
    if (sha256(bytes) !== projectSiteIconSha256) throw new TracerError("PROJECT_SITE_ICON_MISMATCH", "candidate site icon does not match the reviewed asset")
    return true
  }
  const fontAsset = /^static\/fonts\/([^/]+\.woff2)$/.exec(relative)?.[1]
  if (!fontAsset) return false
  const pinnedFontHash = projectFontAssetHashes[fontAsset]
  if (!pinnedFontHash || sha256(bytes) !== pinnedFontHash) throw new TracerError("PROJECT_TYPOGRAPHY_ASSET_INVALID", "candidate font is not an authenticated project asset")
  return true
}

function utf8Order(/** @type {string} */ left, /** @type {string} */ right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/** The slim build owns these two ordinary Quartz output names; no external
 * deployment contract is needed by the renderer. */
async function readDeploymentSiteFiles() {
  return Object.freeze({ entryFile: "index.html", custom404: "404.html" })
}

/** @param {string} route */
function quartzContentRouteFile(route) {
  return `${route.slice(1)}${quartzContentIndexFile}`
}

/** @param {string} relative @param {{entryFile:string,custom404:string}} deploymentFiles */
function generatedHtmlRoute(relative, deploymentFiles) {
  if (relative === deploymentFiles.entryFile) return "/"
  if (relative === deploymentFiles.custom404) return `/${deploymentFiles.custom404}`
  if (relative.endsWith(`/${quartzContentIndexFile}`)) return `/${relative.slice(0, -quartzContentIndexFile.length)}`
  return `/${relative}`
}

/** @param {{entryFile:string,custom404:string}} deploymentFiles @param {ReadonlyArray<{relative:string}>} baseline */
function assertQuartzProducesDeploymentFiles(deploymentFiles, baseline) {
  const baselinePaths = new Set(baseline.map((row) => row.relative))
  if (!baselinePaths.has(deploymentFiles.entryFile) || !baselinePaths.has(deploymentFiles.custom404)) {
    throw new TracerError("DEPLOYMENT_SITE_FILES_UNSUPPORTED", "active deployment site files are not produced by the pinned Quartz renderer")
  }
}

/** Strictly parse the repository-owned TOML subset: one integer schema and
 * six quoted-string arrays. General TOML syntax and arbitrary regex are not
 * accepted at this security boundary. @param {Buffer} bytes */
function parseSecretRules(bytes) {
  let source
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { throw new TracerError("SECRET_RULES_INVALID", "public secret rules are not strict UTF-8") }
  if (source.normalize("NFC") !== source || source.startsWith("\ufeff")) throw new TracerError("SECRET_RULES_INVALID", "public secret rules must be NFC without BOM")
  const expected = new Set(["schema_version", "absolute_path_classes", "posix_local_roots", "private_key_delimiters", "token_prefixes", "credential_filenames", "credential_suffixes"])
  /** @type {Record<string,number|string[]>} */
  const parsed = Object.create(null)
  for (const line of source.split("\n")) {
    if (line === "") continue
    const match = /^([a-z_]+) = (.+)$/.exec(line)
    if (!match || !expected.has(match[1]) || Object.hasOwn(parsed, match[1])) throw new TracerError("SECRET_RULES_INVALID", "public secret rules contain an unknown, duplicate, or malformed field")
    if (match[1] === "schema_version") {
      if (match[2] !== "1") throw new TracerError("SECRET_RULES_INVALID", "public secret rules schema version is unsupported")
      parsed[match[1]] = 1
      continue
    }
    let values
    try { values = JSON.parse(match[2]) } catch { throw new TracerError("SECRET_RULES_INVALID", "public secret rules arrays must contain quoted strings") }
    if (!Array.isArray(values) || values.length < 1 || values.some((value) => typeof value !== "string" || value.length < 1
      || value.normalize("NFC") !== value || /[\u0000-\u001f\u007f]/u.test(value))
      || new Set(values).size !== values.length
      || JSON.stringify(values) !== JSON.stringify([...values].sort(utf8Order))) {
      throw new TracerError("SECRET_RULES_INVALID", "public secret rule arrays must be nonempty, unique, NFC, and UTF-8 sorted")
    }
    parsed[match[1]] = values
  }
  if ([...expected].some((key) => !Object.hasOwn(parsed, key))) throw new TracerError("SECRET_RULES_INVALID", "public secret rules are incomplete")
  const absolutePathClasses = /** @type {string[]} */ (parsed.absolute_path_classes)
  const requiredPathClasses = ["posix-local-root", "windows-drive-root", "windows-unc-root"]
  if (JSON.stringify(absolutePathClasses) !== JSON.stringify(requiredPathClasses)) {
    throw new TracerError("SECRET_RULES_INVALID", "absolute local path grammar classes must be the complete supported set")
  }
  const posixLocalRoots = /** @type {string[]} */ (parsed.posix_local_roots)
  if (posixLocalRoots.some((root) => !root.startsWith("/") || !root.endsWith("/") || root.includes("\\") || root.includes("//")
    || root.split("/").slice(1, -1).some((segment) => segment === "" || segment === "." || segment === ".."))) {
    throw new TracerError("SECRET_RULES_INVALID", "POSIX local roots must be normalized absolute component prefixes")
  }
  return Object.freeze({
    absolutePathClasses: Object.freeze(absolutePathClasses),
    posixLocalRoots: Object.freeze(posixLocalRoots),
    privateKeyDelimiters: Object.freeze(/** @type {string[]} */ (parsed.private_key_delimiters)),
    tokenPrefixes: Object.freeze(/** @type {string[]} */ (parsed.token_prefixes)),
    credentialFilenames: Object.freeze(/** @type {string[]} */ (parsed.credential_filenames)),
    credentialSuffixes: Object.freeze(/** @type {string[]} */ (parsed.credential_suffixes)),
  })
}

async function readSecretRules() {
  try { return parseSecretRules(await readFile(secretRulesPath)) } catch (error) {
    if (error instanceof TracerError) throw error
    throw new TracerError("SECRET_RULES_INVALID", "public secret rules could not be loaded")
  }
}

/** A local-path token may begin at byte zero or after punctuation/whitespace,
 * but never inside a hostname, URL scheme, identifier, or existing path token.
 * This makes `https://host/etc/x` nonlocal while retaining quoted `/etc/x`.
 * @param {string} value @param {number} index */
function hasAbsolutePathTokenBoundary(value, index) {
  if (index === 0) return true
  const previous = value.charCodeAt(index - 1)
  const identifier = (previous >= 0x30 && previous <= 0x39)
    || (previous >= 0x41 && previous <= 0x5a)
    || (previous >= 0x61 && previous <= 0x7a)
    || previous === 0x5f
  return !identifier && !"+.-:/\\".includes(value[index - 1])
}

/** A configured POSIX root also matches its exact component token without the
 * policy's normalization slash. Only path/syntax delimiters terminate the
 * token; ordinary filename bytes keep lookalikes such as `/data.json`,
 * `/binary`, and `/workspace-public` outside the configured root.
 * @param {string} value @param {number} end */
function hasPosixRootComponentEndBoundary(value, end) {
  if (end >= value.length) return true
  const next = value.charCodeAt(end)
  if (next <= 0x20 || next === 0x7f) return true
  return next === 0x2f || next === 0x5c || next === 0x22 || next === 0x27
    || next === 0x60 || next === 0x3c || next === 0x3e || next === 0x7b
    || next === 0x7d || next === 0x5b || next === 0x5d || next === 0x28
    || next === 0x29 || next === 0x2c || next === 0x3b || next === 0x3a
    || next === 0x21 || next === 0x3f || next === 0x25 || next === 0x23
}

/** UNC components are scanned as raw one-byte values. They may contain any
 * non-control Windows-legal byte (including high bytes, spaces after the first
 * byte, and common terminal punctuation), except reserved path characters.
 * @param {number} byte */
function isUncComponentByte(byte) {
  return byte >= 0x20 && byte !== 0x7f && !'<>:"/\\|?*'.includes(String.fromCharCode(byte))
}

/** Slash-form UNC and protocol-relative URLs are lexically identical when the
 * host is a single label. Exempt only a DNS-shaped public host; backslash UNC
 * and single-label slash UNC remain fail-closed. @param {string} host */
function isDnsProtocolRelativeHost(host) {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+(?:\:[0-9]+)?$/.test(host)
}

/** @param {string} value */
function hasWindowsUncPath(value) {
  for (const opener of value.matchAll(/(?:\\\\|\/\/)/g)) {
    const index = /** @type {number} */ (opener.index)
    if (!hasAbsolutePathTokenBoundary(value, index)) continue
    let cursor = index + 2
    const serverStart = cursor
    if (value.charCodeAt(cursor) <= 0x20) continue
    while (cursor < value.length && isUncComponentByte(value.charCodeAt(cursor))) cursor += 1
    if (cursor === serverStart || (value[cursor] !== "/" && value[cursor] !== "\\")) continue
    const server = value.slice(serverStart, cursor)
    cursor += 1
    const shareStart = cursor
    if (value.charCodeAt(cursor) <= 0x20) continue
    while (cursor < value.length && isUncComponentByte(value.charCodeAt(cursor))) cursor += 1
    if (cursor === shareStart) continue
    if (value[index] === "/" && isDnsProtocolRelativeHost(server)) continue
    return true
  }
  return false
}

/** Grammar-based raw-byte absolute local path policy. Slash-form UNC requires
 * server/share components, so ordinary `// comment` syntax is not classified;
 * a preceding colon also prevents the `//` in an HTTP(S) URL from becoming UNC.
 * @param {Buffer} bytes @param {Awaited<ReturnType<typeof readSecretRules>>} rules */
function hasAbsoluteLocalPath(bytes, rules) {
  const ascii = bytes.toString("latin1")
  const classes = new Set(rules.absolutePathClasses)
  if (classes.has("posix-local-root")) {
    for (const root of rules.posixLocalRoots) {
      const componentRoot = root.slice(0, -1)
      let cursor = 0
      while ((cursor = ascii.indexOf(componentRoot, cursor)) !== -1) {
        if (hasAbsolutePathTokenBoundary(ascii, cursor)
          && hasPosixRootComponentEndBoundary(ascii, cursor + componentRoot.length)) return true
        cursor += componentRoot.length
      }
    }
  }
  if (classes.has("windows-drive-root")) {
    for (const match of ascii.matchAll(/[A-Za-z]:[\\/]/g)) {
      if (hasAbsolutePathTokenBoundary(ascii, /** @type {number} */ (match.index))) return true
    }
  }
  if (classes.has("windows-unc-root") && hasWindowsUncPath(ascii)) return true
  return false
}

/** Raw ASCII-safe scanner shared by source and candidate bytes. It never relies
 * on UTF-8 replacement decoding to recognize token prefixes. */
function secretFinding(/** @type {Buffer} */ bytes, /** @type {string} */ relative, /** @type {Awaited<ReturnType<typeof readSecretRules>>} */ rules, /** @type {string[]} */ privatePaths) {
  const normalizedRelative = relative.replace(/\\/g, "/").toLowerCase()
  const basename = normalizedRelative.slice(normalizedRelative.lastIndexOf("/") + 1)
  if (rules.credentialFilenames.some((name) => basename === name.toLowerCase())
    || rules.credentialSuffixes.some((suffix) => basename.endsWith(suffix.toLowerCase()))) return "credential-filename"
  for (const delimiter of rules.privateKeyDelimiters) if (bytes.includes(Buffer.from(delimiter, "ascii"))) return "private-key"
  for (const prefix of rules.tokenPrefixes) {
    const needle = Buffer.from(prefix, "ascii")
    let cursor = 0
    while ((cursor = bytes.indexOf(needle, cursor)) !== -1) {
      let end = cursor + needle.length
      while (end < bytes.length && ((bytes[end] >= 0x30 && bytes[end] <= 0x39) || (bytes[end] >= 0x41 && bytes[end] <= 0x5a) || (bytes[end] >= 0x61 && bytes[end] <= 0x7a) || bytes[end] === 0x5f || bytes[end] === 0x2d)) end += 1
      if (end - (cursor + needle.length) >= 8) return "token-prefix"
      cursor += needle.length
    }
  }
  const ascii = bytes.toString("latin1").replace(/\\/g, "/").toLowerCase()
  const normalizedPrivate = privatePaths.map((value) => value.replace(/\\/g, "/").toLowerCase())
  if (normalizedPrivate.some((value) => value && ascii.includes(value)) || hasAbsoluteLocalPath(bytes, rules)) return "absolute-path"
  return null
}

/** @param {Buffer} bytes @param {string} role */
function decodeMarkdown(bytes, role) {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new TracerError("SOURCE_BOM_NOT_ALLOWED", `${role} has a UTF-8 BOM`)
  if (bytes.includes(0)) throw new TracerError("SOURCE_NUL_NOT_ALLOWED", `${role} contains a NUL byte`)
  const magic = [
    Buffer.from("%PDF-", "ascii"), Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("GIF8", "ascii"), Buffer.from("PK\x03\x04", "binary"),
  ]
  if (magic.some((prefix) => bytes.subarray(0, prefix.length).equals(prefix))) {
    throw new TracerError("SOURCE_BINARY_MAGIC_NOT_ALLOWED", `${role} has forbidden binary magic`)
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new TracerError("SOURCE_INVALID_UTF8", `${role} is not strict UTF-8`)
  }
}

const unsupportedRawHtml = /<!--|-->|<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*|[^<>\s@]+@[^<>\s@]+)>|<\s*\/?\s*[A-Za-z][A-Za-z0-9:-]*(?=[\s/>]|$)[^<>\r\n]*(?:>|$)|<![A-Za-z][^>\r\n]*(?:>|$)|<\?[^>\r\n]*(?:>|$)/i

/** Remove only exact root-line workflow boundaries from the derived public
 * body. The approved Markdown between each pair remains public; malformed,
 * mismatched, nested, or arbitrary comments remain for the existing HTML gate
 * to reject. Source bytes are never changed. @param {string} body */
function projectIntegrationBoundaries(body) {
  return body
    .replace(
      /^<!-- candidate-integration:start -->\r?\n([\s\S]*?)^<!-- candidate-integration:end -->\r?\n?/gmu,
      "$1",
    )
    .replace(
      /^<!-- source-contribution:([a-f0-9]{12}):start -->\r?\n([\s\S]*?)^<!-- source-contribution:\1:end -->\r?\n?/gmu,
      "$2",
    )
}

/** @param {string} markdown @param {string} body @param {string} role @param {ReturnType<typeof analyzeMarkdown>} analysis */
function validateMarkdownSafety(markdown, body, role, analysis) {
  // This intentionally recognizes a narrow accepted Markdown subset rather than
  // attempting browser-grade HTML parsing. Anything tag-, declaration-,
  // processing-instruction-, comment-, namespace-, or autolink-shaped outside
  // one authenticated and sanitizable Zotero-managed range fails closed.
  let withoutManaged = body
  const zoteroValidation = validateZoteroManagedMarkdown(body)
  if (zoteroValidation.managed) {
    withoutManaged = `${body.slice(0, zoteroValidation.managed.start)}${body.slice(zoteroValidation.managed.end)}`
  }
  if (containsZoteroSchemeDisclosure(withoutManaged)) throw new TracerError("SOURCE_UNSAFE_URL_SCHEME", "Zotero local URLs require the authenticated managed block")
  if (unsupportedRawHtml.test(withoutManaged)) throw new TracerError("SOURCE_ACTIVE_CONTENT_NOT_ALLOWED", `${role} contains raw HTML or an unsupported autolink`)
  if (analysis.markdownUrls.some((url) => /^(?:javascript|vbscript|data|file)\s*:/i.test(url.replace(/[\u0000-\u0020]+/g, "")))
    || /\]\(\s*(?:javascript|vbscript|data|file)\s*:/i.test(markdown)
    || /\b(?:href|src)\s*=\s*["']?\s*(?:javascript|vbscript|data|file)\s*:/i.test(markdown)) {
    throw new TracerError("SOURCE_UNSAFE_URL_SCHEME", `${role} contains an unsafe URL scheme`)
  }
  if (/!\[|!\[\[|<img\b/i.test(markdown)) throw new TracerError("SOURCE_IMAGE_EMBED_NOT_ALLOWED", `${role} contains an image or attachment embed`)
}

/** @param {string} value */
function aliasKey(value) {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.md$/i, "").toLowerCase()
}

/** @param {string} value */
function markdownText(value) {
  return value.replace(/[\\`*_[\]<>]/g, (character) => `\\${character}`).replace(/[\r\n]+/g, " ").trim()
}

/** @param {unknown} value */
function htmlText(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character)
}

/** @param {string} value @param {number} offset */
function isEscaped(value, offset) {
  let slashes = 0
  for (let cursor = offset - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1
  return slashes % 2 === 1
}

/** Scan one parser-authenticated source slice while retaining body-relative offsets.
 * @param {string} source @param {number} baseOffset @param {string} markdown @param {boolean} [includeEscaped] */
function wikiLinksInSource(source, baseOffset, markdown, includeEscaped = false) {
  /** @type {Array<{whole:string,target:string,display:string,explicit:boolean,start:number,end:number}>} */
  const links = []
  const pattern = /(?<!!)\[\[([^\]|#\r\n]+)(?:#[^\]|\r\n]*)?(?:\|([^\]\r\n]*))?\]\]/g
  for (const match of source.matchAll(pattern)) {
    if (match[0].indexOf("[[", 2) >= 0) {
      throw new TracerError("SOURCE_NESTED_WIKILINK_NOT_ALLOWED", "nested wikilink openers are not supported")
    }
    const start = baseOffset + match.index
    const end = start + match[0].length
    if (!includeEscaped && isEscaped(markdown, start)) continue
    const target = match[1].trim()
    const explicit = match[2] !== undefined
    links.push({
      whole: match[0],
      target,
      display: (explicit ? match[2] : path.posix.basename(target).replace(/\.md$/i, "")).trim(),
      explicit,
      start,
      end,
    })
  }
  return links
}

/** Collect every wikilink-shaped token for disclosure suppression, including
 * tokens that cannot create public link semantics. @param {string} markdown */
function allWikiLinkTokens(markdown) {
  return wikiLinksInSource(markdown, 0, markdown, true)
}

/** @param {any} node */
function nodeOffsets(node) {
  const start = node?.position?.start?.offset
  const end = node?.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new Error("MDAST node lacks stable source offsets")
  }
  return { start, end }
}

/** @param {string} markdown */
function analyzeMarkdown(markdown) {
  try {
    const tree = fromMarkdown(markdown)
    if (!tree || tree.type !== "root" || !Array.isArray(tree.children)) throw new Error("invalid MDAST root")
    /** @type {Array<{whole:string,target:string,display:string,explicit:boolean,start:number,end:number}>} */
    const links = []
    /** @type {Map<string,string>} */
    const definitions = new Map()
    /** @type {any[]} */
    const linkNodes = []
    /** @type {any[]} */
    const definitionNodes = []
    /** @type {any[]} */
    const inlineCodeNodes = []
    const excluded = new Set(["code", "inlineCode", "definition", "link", "linkReference", "image", "imageReference", "html"])
    /** @param {any} node @param {string[]} ancestors */
    function walk(node, ancestors) {
      if (!node || typeof node.type !== "string") throw new Error("invalid MDAST node")
      if (node.type === "definition" && !definitions.has(node.identifier)) {
        definitions.set(node.identifier, node.url)
        definitionNodes.push(node)
      }
      if (node.type === "inlineCode") inlineCodeNodes.push(node)
      if (node.type === "link" || node.type === "linkReference") linkNodes.push(node)
      if (node.type === "text" && !ancestors.some((type) => excluded.has(type))) {
        const { start, end } = nodeOffsets(node)
        if (end > markdown.length) throw new Error("MDAST offset escaped source")
        links.push(...wikiLinksInSource(markdown.slice(start, end), start, markdown))
      }
      if (node.children !== undefined) {
        if (!Array.isArray(node.children)) throw new Error("invalid MDAST children")
        for (const child of node.children) walk(child, [...ancestors, node.type])
      }
    }
    walk(tree, [])

    const headingIndex = tree.children.findIndex((node) => node.type === "heading" && node.depth === 2
      && node.children?.length === 1 && node.children[0].type === "text" && node.children[0].value === "Connections")
    let connections = null
    if (headingIndex >= 0) {
      const heading = tree.children[headingIndex]
      const next = tree.children.slice(headingIndex + 1).find((node) => node.type === "heading" && (node.depth === 1 || node.depth === 2))
      connections = { start: nodeOffsets(heading).end, end: next ? nodeOffsets(next).start : markdown.length }
    }
    const markdownUrlNodes = [...linkNodes, ...definitionNodes].map((node) => {
      const { start, end } = nodeOffsets(node)
      if (node.type === "link" || node.type === "definition") return { url: node.url, type: node.type, start, end }
      const resolved = definitions.get(node.identifier)
      if (typeof resolved !== "string") throw new Error("unresolved MDAST link reference")
      return { url: resolved, type: node.type, start, end }
    })
    const markdownUrls = markdownUrlNodes.map(({ url }) => url)
    const zoteroManaged = zoteroManagedRange(markdown, tree)
    return { tree, links, tokens: allWikiLinkTokens(markdown), connections, markdownUrls, markdownUrlNodes, inlineCodeNodes, zoteroManaged }
  } catch (error) {
    if (error instanceof TracerError || error instanceof SlimContentError) throw error
    throw new TracerError("SOURCE_MARKDOWN_INVALID", "source Markdown could not be parsed with stable MDAST offsets")
  }
}

const paperTemplateHeadings = Object.freeze(["Bibliography", "One-sentence Takeaway", "Research Question", "Citation"])
const integratedVaultPaperHeadings = Object.freeze(["One-sentence Takeaway", "Citation", "Research Question"])

/** @param {any} tree @returns {string[]} */
function rootH2Headings(tree) {
  return tree.children.flatMap((/** @type {any} */ node) => {
    if (node.type !== "heading" || node.depth !== 2) return []
    return [node.children.length === 1 && node.children[0].type === "text" ? node.children[0].value : ""]
  })
}

/** @param {string[]} rootH2 */
function paperMastheadShape(rootH2) {
  const scholarly = rootH2.filter((heading) => paperTemplateHeadings.includes(heading))
  if (JSON.stringify(rootH2.slice(0, paperTemplateHeadings.length)) === JSON.stringify(paperTemplateHeadings)
    && JSON.stringify(scholarly) === JSON.stringify(paperTemplateHeadings)) return "projected"
  if (JSON.stringify(rootH2.slice(0, integratedVaultPaperHeadings.length)) === JSON.stringify(integratedVaultPaperHeadings)
    && JSON.stringify(scholarly) === JSON.stringify(integratedVaultPaperHeadings)) return "integrated-vault"
  return "invalid"
}

/** The two currently integrated Vault notes store Citation between Takeaway and
 * Research Question and do not provide Bibliography. Preserve source bytes and
 * project the missing required public slot as an explicit non-claim. */
function normalizePaperMasthead(/** @type {string} */ markdown) {
  /** @type {any} */
  let tree
  try {
    tree = fromMarkdown(markdown)
  } catch {
    throw new TracerError("SOURCE_MARKDOWN_INVALID", "projected Markdown could not be reparsed for the scholarly masthead")
  }
  const shape = paperMastheadShape(rootH2Headings(tree))
  if (shape === "projected") return markdown
  if (shape !== "integrated-vault") throw new TracerError("SEMANTIC_TEMPLATE_INVALID", "paper requires an accepted scholarly root H2 masthead")
  const headings = /** @type {any[]} */ (tree.children.filter((/** @type {any} */ node) => node.type === "heading" && (node.depth === 1 || node.depth === 2)))
  const sections = new Map()
  for (const name of integratedVaultPaperHeadings) {
    const heading = headings.find((/** @type {any} */ node) => node.depth === 2 && node.children?.length === 1 && node.children[0].type === "text" && node.children[0].value === name)
    if (!heading) throw new TracerError("SEMANTIC_TEMPLATE_INVALID", "integrated Vault paper masthead is incomplete")
    const index = headings.indexOf(heading)
    const next = headings[index + 1]
    sections.set(name, { start: nodeOffsets(heading).start, end: next ? nodeOffsets(next).start : markdown.length })
  }
  const takeaway = sections.get("One-sentence Takeaway")
  const citation = sections.get("Citation")
  const question = sections.get("Research Question")
  if (!takeaway || !citation || !question) throw new TracerError("SEMANTIC_TEMPLATE_INVALID", "integrated Vault paper masthead is incomplete")
  const bibliography = "## Bibliography\n\nNot stated.\n\n"
  return `${markdown.slice(0, takeaway.start)}${bibliography}${markdown.slice(takeaway.start, takeaway.end)}${markdown.slice(question.start, question.end)}${markdown.slice(citation.start, citation.end)}${markdown.slice(question.end)}`
}

/** @param {Map<string,{node:any,analysis:ReturnType<typeof analyzeMarkdown>}>} records */
function validateSemanticTemplates(records) {
  for (const record of records.values()) {
    const rootH2 = rootH2Headings(record.analysis.tree)
    if (record.node.node_class === "paper") {
      if (paperMastheadShape(rootH2) === "invalid") {
        throw new TracerError("SEMANTIC_TEMPLATE_INVALID", "paper requires the exact ordered scholarly root H2 masthead")
      }
    } else if (rootH2.some((heading) => paperTemplateHeadings.includes(heading))) {
      throw new TracerError("SEMANTIC_TEMPLATE_INVALID", "support content cannot claim a paper-only scholarly root H2")
    }
  }
}

/** Convert only an exact root H2 Zotero section in derived Markdown. Source
 * bytes remain untouched; a fresh parse makes offsets valid after projection.
 * @param {string} markdown */
function discloseZoteroAnnotations(markdown) {
  let tree
  try {
    tree = fromMarkdown(markdown)
  } catch {
    throw new TracerError("SOURCE_MARKDOWN_INVALID", "projected Markdown could not be reparsed for Zotero disclosure")
  }
  const matches = tree.children.filter((node) => node.type === "heading" && node.depth === 2
    && node.children?.length === 1 && node.children[0].type === "text" && node.children[0].value === "Zotero Annotations")
  if (matches.length === 0) return markdown
  if (matches.length !== 1) throw new TracerError("SOURCE_MARKDOWN_INVALID", "multiple root Zotero Annotations sections are not supported")
  const heading = matches[0]
  const index = tree.children.indexOf(heading)
  const next = tree.children.slice(index + 1).find((node) => node.type === "heading" && (node.depth === 1 || node.depth === 2))
  const start = nodeOffsets(heading).start
  const contentStart = nodeOffsets(heading).end
  const end = next ? nodeOffsets(next).start : markdown.length
  const content = markdown.slice(contentStart, end).trim()
  const disclosure = `<details class="zotero-annotations">\n<summary>Zotero Annotations</summary>\n\n${content || "Not stated"}\n\n</details>\n\n`
  return `${markdown.slice(0, start)}${disclosure}${markdown.slice(end)}`
}

/** @param {string} url */
function isRelativeLocalMarkdownUrl(url) {
  const value = url.trim()
  return Boolean(value) && !value.startsWith("/") && !value.startsWith("#") && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
}

/** @param {string} target */
function suppressedTargetVariants(target) {
  const normalized = target.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/")
  const basename = path.posix.basename(normalized)
  const variants = new Set([
    normalized,
    normalized.replace(/\.md$/i, ""),
    basename,
    basename.replace(/\.md$/i, ""),
  ].filter(Boolean))
  for (const variant of [...variants]) variants.add(variant.toLowerCase())
  return variants
}

/** Return only path-bearing forms that must not survive into public output.
 * The basename is intentionally excluded because it is the safe inert display
 * for an unlisted target. @param {string} target */
function suppressedDisclosureVariants(target) {
  const normalized = target.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/")
  if (!normalized.includes("/")) return new Set()
  const variants = new Set([normalized, normalized.replace(/\.md$/i, "")].filter(Boolean))
  for (const variant of [...variants]) variants.add(variant.toLowerCase())
  return variants
}

/** Render an unlisted target as inert text without disclosing its Vault path.
 * An explicit author label is retained unless it is itself a target variant;
 * otherwise the safe basename is derived automatically.
 * @param {{target:string,display:string,explicit:boolean}} link */
function unlistedDisplay(link) {
  const variants = suppressedTargetVariants(link.target)
  const explicit = link.display.trim().replace(/\\/g, "/")
  if (link.explicit && explicit && !variants.has(explicit) && !variants.has(explicit.toLowerCase())) {
    return markdownText(link.display)
  }
  return markdownText(path.posix.basename(link.target.trim().replace(/\\/g, "/")).replace(/\.md$/i, ""))
}

/** Project a parser-authenticated inline-code Vault path to its inert basename.
 * Other `.md` occurrences still fail the final disclosure gate.
 * @param {unknown} value */
function inlineVaultMarkdownPathDisplay(value) {
  const normalized = String(value ?? "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "")
  if (!normalized.includes("/") || normalized.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)
    || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || !/\.md$/i.test(normalized)) return null
  return markdownText(path.posix.basename(normalized).replace(/\.md$/i, ""))
}

/** @param {Map<string,{node:any,markdown:string,body:string,frontmatter:Record<string,string|string[]>,route:string,analysis:ReturnType<typeof analyzeMarkdown>}>} records */
function projectContent(records) {
  /** @type {Map<string,string>} */
  const aliasOwners = new Map()
  /** @type {Map<string,string>} */
  const aliasDisplay = new Map()
  for (const [id, record] of records) {
    const nodePath = record.node.path
    const basename = path.posix.basename(nodePath).replace(/\.md$/i, "")
    const aliases = [id, nodePath, nodePath.replace(/\.md$/i, ""), basename]
    if (typeof record.frontmatter.title === "string") aliases.push(record.frontmatter.title)
    if (Array.isArray(record.frontmatter.aliases)) aliases.push(...record.frontmatter.aliases)
    for (const alias of aliases) {
      const key = aliasKey(alias)
      const previous = aliasOwners.get(key)
      if (previous && previous !== id) throw new TracerError("AMBIGUOUS_ALIAS", "a wikilink alias resolves to more than one public node")
      aliasOwners.set(key, id)
      aliasDisplay.set(key, alias)
    }
  }

  /** @type {Set<string>} */
  const suppressedTargets = new Set()
  /** @type {Set<string>} */
  const suppressedTargetKeys = new Set()
  /** @type {Map<string,Set<string>>} */
  const outgoing = new Map()
  /** @type {Map<string,string>} */
  const projectedBodies = new Map()
  /** @type {Map<string,string>} */
  const searchableBodies = new Map()
  /** @type {Map<string,string>} */
  const projected = new Map()

  for (const [id, record] of records) {
    let body = record.body
    let searchableBody = record.body
    const resolvedTargets = new Set()
    /** @type {Array<{start:number,end:number,value:string,searchValue:string}>} */
    const replacements = []
    const semanticRanges = new Set(record.analysis.links.map((link) => `${link.start}:${link.end}`))
    for (const link of record.analysis.links) {
      const targetId = aliasOwners.get(aliasKey(link.target))
      if (targetId) {
        const target = records.get(targetId)
        if (!target) throw new TracerError("UNEXPECTED_GRAPH_STATE", "resolved target record is missing")
        resolvedTargets.add(targetId)
        const value = `[${markdownText(link.display)}](${target.route})`
        replacements.push({ start: link.start, end: link.end, value, searchValue: value })
      } else {
        const variants = suppressedDisclosureVariants(link.target)
        for (const variant of variants) suppressedTargets.add(variant)
        suppressedTargetKeys.add(aliasKey(link.target))
        const value = unlistedDisplay(link)
        replacements.push({ start: link.start, end: link.end, value, searchValue: value })
      }
    }
    // Hidden/code tokens never create graph edges. Unlisted targets must still
    // be removed from derived metadata even when their safe display remains in
    // the source-visible page body.
    for (const link of record.analysis.tokens) {
      if (semanticRanges.has(`${link.start}:${link.end}`) || aliasOwners.has(aliasKey(link.target))) continue
      const variants = suppressedDisclosureVariants(link.target)
      for (const variant of variants) suppressedTargets.add(variant)
      suppressedTargetKeys.add(aliasKey(link.target))
      const value = unlistedDisplay(link)
      replacements.push({ start: link.start, end: link.end, value, searchValue: value })
    }
    for (const node of record.analysis.inlineCodeNodes) {
      const value = inlineVaultMarkdownPathDisplay(node.value)
      if (value === null) continue
      const { start, end } = nodeOffsets(node)
      for (const variant of suppressedDisclosureVariants(String(node.value))) suppressedTargets.add(variant)
      suppressedTargetKeys.add(aliasKey(String(node.value)))
      replacements.push({ start, end, value, searchValue: value })
    }
    const orderedReplacements = replacements.sort((left, right) => right.start - left.start)
    for (let index = 1; index < orderedReplacements.length; index += 1) {
      if (orderedReplacements[index - 1].start < orderedReplacements[index].end) {
        throw new TracerError("SOURCE_MARKDOWN_INVALID", "overlapping Markdown source replacements are not supported")
      }
    }
    for (const replacement of orderedReplacements) {
      body = `${body.slice(0, replacement.start)}${replacement.value}${body.slice(replacement.end)}`
      searchableBody = `${searchableBody.slice(0, replacement.start)}${replacement.searchValue}${searchableBody.slice(replacement.end)}`
    }
    if (record.analysis.markdownUrls.some(isRelativeLocalMarkdownUrl)) {
      throw new TracerError("SOURCE_LOCAL_LINK_NOT_ALLOWED", "local Markdown links must use resolvable wikilinks")
    }
    outgoing.set(id, resolvedTargets)
    body = projectZoteroManagedMarkdown(body)
    const normalizedBody = record.node.node_class === "paper" ? normalizePaperMasthead(body) : body
    const normalizedSearchableBody = record.node.node_class === "paper" ? normalizePaperMasthead(searchableBody) : searchableBody
    searchableBodies.set(id, normalizedSearchableBody)
    projectedBodies.set(id, discloseZoteroAnnotations(normalizedBody))
  }

  for (const [id, record] of records) {
    const backlinks = [...records.entries()]
      .filter(([otherId]) => otherId !== id && outgoing.get(otherId)?.has(id))
      .map(([otherId, other]) => `- [${markdownText(String(other.frontmatter.title ?? otherId))}](${other.route})`)
      .join("\n")
    const title = markdownText(String(record.frontmatter.title ?? id))
    const body = projectedBodies.get(id)
    if (body === undefined) throw new TracerError("UNEXPECTED_GRAPH_STATE", "projected body is missing")
    projected.set(id, `---\ntitle: "${title.replace(/"/g, "\\\"")}"\n---\n\n${body.trim()}\n\n## Backlinks\n\n${backlinks || "No approved backlinks."}\n`)
  }

  return { projected, searchableBodies, outgoing, suppressedTargets, suppressionCount: suppressedTargetKeys.size }
}

/** @param {string} value */
function collapseUnicodeWhitespace(value) {
  return value.replace(/\p{White_Space}+/gu, " ").trim()
}

/** @param {any} node */
function visibleNodeText(node) {
  if (!node || node.type === "html" || node.type === "definition") return ""
  if (node.type === "text" || node.type === "inlineCode" || node.type === "code") return String(node.value ?? "")
  return Array.isArray(node.children) ? node.children.map(visibleNodeText).filter(Boolean).join(" ") : ""
}

/** Exclude only the parser-authenticated managed marker range, then derive
 * headings and browser-visible body text from privacy-suppressed Markdown. */
function searchableMarkdownSegments(/** @type {string} */ markdown) {
  let tree = fromMarkdown(markdown)
  const managed = zoteroManagedRange(markdown, tree)
  if (managed) {
    markdown = `${markdown.slice(0, managed.start)}${markdown.slice(managed.end)}`
    tree = fromMarkdown(markdown)
  }
  const headings = tree.children.filter((node) => node.type === "heading").map(visibleNodeText).map(collapseUnicodeWhitespace).filter(Boolean)
  const body = tree.children.filter((node) => node.type !== "heading").map(visibleNodeText).map(collapseUnicodeWhitespace).filter(Boolean)
  return { headings, body }
}

/** Read one public level-two Markdown section without leaking content from the
 * following section. Managed Zotero blocks remain excluded by the same parser
 * boundary used by the public search projection. */
function publicMarkdownSectionText(/** @type {string} */ markdown, /** @type {string} */ heading) {
  let tree = fromMarkdown(markdown)
  const managed = zoteroManagedRange(markdown, tree)
  if (managed) {
    markdown = `${markdown.slice(0, managed.start)}${markdown.slice(managed.end)}`
    tree = fromMarkdown(markdown)
  }
  const start = tree.children.findIndex((node) => node.type === "heading" && node.depth === 2 && collapseUnicodeWhitespace(visibleNodeText(node)).toLocaleLowerCase("en-US") === heading.toLocaleLowerCase("en-US"))
  if (start < 0) return null
  const section = []
  for (const node of tree.children.slice(start + 1)) {
    if (node.type === "heading" && node.depth <= 2) break
    const text = collapseUnicodeWhitespace(visibleNodeText(node))
    if (text) section.push(text)
  }
  return section.length > 0 ? section.join(" ") : null
}

/** Read the description convention used by public knowledge notes: the first
 * blockquote immediately following the level-one title. Content later in the
 * document is never promoted into the graph sidebar. */
function publicMarkdownLeadQuoteText(/** @type {string} */ markdown) {
  let tree = fromMarkdown(markdown)
  const managed = zoteroManagedRange(markdown, tree)
  if (managed) {
    markdown = `${markdown.slice(0, managed.start)}${markdown.slice(managed.end)}`
    tree = fromMarkdown(markdown)
  }
  const title = tree.children.findIndex((node) => node.type === "heading" && node.depth === 1)
  if (title < 0) return null
  for (const node of tree.children.slice(title + 1)) {
    if (node.type === "html" || node.type === "definition") continue
    if (node.type === "heading" || node.type !== "blockquote") return null
    const text = collapseUnicodeWhitespace(visibleNodeText(node))
    return text || null
  }
  return null
}

/** @param {Map<string,any>} records @param {Map<string,Set<string>>} outgoing @param {Map<string,string>} searchableBodies */
function publicContracts(records, outgoing, searchableBodies) {
  const compare = (/** @type {string} */ left, /** @type {string} */ right) => Buffer.compare(Buffer.from(left), Buffer.from(right))
  const ordered = [...records.entries()].sort(([left], [right]) => compare(left, right))
  const displayTitle = (/** @type {string} */ publicId, /** @type {any} */ record) => {
    const title = collapseUnicodeWhitespace(String(record.frontmatter.title ?? publicId))
    if (record.node.node_class === "author") return path.posix.basename(record.node.path, ".md")
    return ["concept", "method", "task", "synthesis", "map"].includes(record.node.node_class)
      ? title.replace(/^./u, (character) => character.toLocaleUpperCase("en-US"))
      : title
  }
  const nodes = ordered.map(([publicId, record]) => ({
    public_id: publicId,
    title: displayTitle(publicId, record),
    node_class: record.node.node_class,
    url: record.route,
  }))
  const edgeKeys = new Set()
  for (const [source, targets] of outgoing) for (const target of targets) {
    const [left, right] = compare(source, target) <= 0 ? [source, target] : [target, source]
    edgeKeys.add(`${left}\0${right}`)
  }
  const edges = [...edgeKeys].sort(compare).map((key) => {
    const [source, target] = key.split("\0")
    return { source, target }
  })
  const publicIds = new Set(nodes.map((node) => node.public_id))
  if (edges.some((edge) => !publicIds.has(edge.source) || !publicIds.has(edge.target))) throw new TracerError("UNEXPECTED_GRAPH_STATE", "public graph edge endpoint is not public")
  const recordsProjection = ordered.map(([publicId, record]) => {
    const authors = (Array.isArray(record.frontmatter.authors) ? record.frontmatter.authors : []).map((/** @type {string} */ value) => collapseUnicodeWhitespace(String(value))).filter(Boolean)
    const yearValue = record.frontmatter.year === undefined || record.frontmatter.year === null ? "" : collapseUnicodeWhitespace(String(record.frontmatter.year))
    const doiValue = typeof record.frontmatter.doi === "string" ? collapseUnicodeWhitespace(record.frontmatter.doi) : ""
    const sourceTags = [...new Set((Array.isArray(record.frontmatter.tags) ? record.frontmatter.tags : []).map((/** @type {string} */ value) => collapseUnicodeWhitespace(String(value))).filter(Boolean))].sort(compare)
    const segments = searchableMarkdownSegments(searchableBodies.get(publicId) ?? "")
    const searchableBody = searchableBodies.get(publicId) ?? ""
    const nodeClass = record.node.node_class
    const searchSegments = [
      collapseUnicodeWhitespace(String(record.frontmatter.title ?? publicId)),
      collapseUnicodeWhitespace(authors.join(" ")),
      doiValue,
      collapseUnicodeWhitespace(sourceTags.join(" ")),
      collapseUnicodeWhitespace(segments.headings.join(" ")),
      collapseUnicodeWhitespace(segments.body.join(" ")),
    ].filter(Boolean)
    return {
      public_id: publicId,
      title: displayTitle(publicId, record),
      node_class: record.node.node_class,
      url: record.route,
      authors,
      year: yearValue || null,
      doi: doiValue || null,
      source_tags: sourceTags,
      definition: nodeClass === "paper"
        ? null
        : publicMarkdownLeadQuoteText(searchableBody) ?? (["concept", "method", "task"].includes(nodeClass) ? publicMarkdownSectionText(searchableBody, "Definition") : null),
      search_text: searchSegments.join("\n"),
    }
  })
  return { graph: { schema_version: 1, nodes, edges }, search: { schema_version: 1, records: recordsProjection } }
}

/** Deterministic depth-first package-tree digest with each directory's entries
 * UTF-8 byte-sorted by name; rows contain relative path, NUL, lowercase file
 * SHA-256, and LF. Links and nonregular entries fail closed.
 * @param {string} root */
async function pinnedTreeDigest(root) {
  const rootMetadata = await lstat(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new TracerError("QUARTZ_PACKAGE_TREE_INVALID", "pinned package tree root is not an ordinary directory")
  /** @type {string[]} */
  const rows = []
  /** @param {string} directory */
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const metadata = await lstat(absolute)
      if (metadata.isSymbolicLink()) throw new TracerError("QUARTZ_PACKAGE_TREE_INVALID", "pinned package tree contains a link")
      if (metadata.isDirectory()) await walk(absolute)
      else if (metadata.isFile()) {
        const relative = path.relative(root, absolute).split(path.sep).join("/")
        rows.push(`${relative}\0${sha256(await readFile(absolute))}\n`)
      } else throw new TracerError("QUARTZ_PACKAGE_TREE_INVALID", "pinned package tree contains a nonregular entry")
    }
  }
  await walk(root)
  return { files: rows.length, sha256: sha256(Buffer.from(rows.join(""))) }
}

async function readToolchainMetadata() {
  let metadata
  try {
    metadata = JSON.parse(await readFile(toolchainMetadataPath, "utf8"))
  } catch {
    throw new TracerError("INVALID_TOOLCHAIN_METADATA", "Quartz pin metadata could not be read")
  }
  const platformTree = metadata.quartzPackageTrees?.[`${process.platform}-${process.arch}`]
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version) || !/^[0-9a-f]{40}$/.test(metadata.commit) || !/^[0-9a-f]{64}$/.test(metadata.defaultIconSha256)
    || !Number.isSafeInteger(platformTree?.files) || platformTree.files < 1 || !/^[0-9a-f]{64}$/.test(platformTree?.sha256)
    || !Number.isSafeInteger(metadata.quartzCommunityTreeFiles) || metadata.quartzCommunityTreeFiles < 1 || !/^[0-9a-f]{64}$/.test(metadata.quartzCommunityTreeSha256)) {
    throw new TracerError("INVALID_TOOLCHAIN_METADATA", "Quartz pin metadata is invalid")
  }
  const installedRoot = path.dirname(fileURLToPath(import.meta.resolve("@jackyzha0/quartz/package.json")))
  const communityRoot = path.resolve(installedRoot, "..", "..", "@quartz-community")
  const installed = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"))
  if (installed.version !== metadata.version) throw new TracerError("QUARTZ_VERSION_MISMATCH", "installed Quartz does not match the pin")
  const iconHash = sha256(await readFile(path.join(installedRoot, "quartz", "static", "icon.png")))
  if (iconHash !== metadata.defaultIconSha256) throw new TracerError("QUARTZ_ICON_HASH_MISMATCH", "installed Quartz icon does not match the pin")
  const [quartzTree, communityTree] = await Promise.all([pinnedTreeDigest(installedRoot), pinnedTreeDigest(communityRoot)])
  if (quartzTree.files !== platformTree.files || quartzTree.sha256 !== platformTree.sha256
    || communityTree.files !== metadata.quartzCommunityTreeFiles || communityTree.sha256 !== metadata.quartzCommunityTreeSha256) {
    throw new TracerError("QUARTZ_PACKAGE_TREE_MISMATCH", "installed Quartz package trees do not match the deterministic pins")
  }
  return { metadata, installedRoot }
}

/** @param {string} source */
function tracerQuartzConfig(source) {
  let transformed = source
  const fail = () => { throw new TracerError("QUARTZ_CONFIG_TRANSFORM_FAILED", "pinned Quartz config no longer satisfies the required transform contract") }
  /** @param {string} before @param {string} after */
  const replaceOne = (before, after) => {
    if (transformed.split(before).length !== 2) fail()
    transformed = transformed.replace(before, after)
  }
  for (const [before, after] of [
    ["pageTitle: Quartz 5", "pageTitle: Psychology Research Notes"],
    ["enableSPA: true", "enableSPA: false"],
    ["enablePopovers: true", "enablePopovers: false"],
    ["provider: plausible", "provider: null"],
    ["baseUrl: quartz.jzhao.xyz", "baseUrl: example.invalid"],
    ["fontOrigin: googleFonts", "fontOrigin: local"],
    ["cdnCaching: true", "cdnCaching: false"],
    ["header: Schibsted Grotesk", "header: system-ui"],
    ["body: Source Sans Pro", "body: Georgia"],
    ["code: IBM Plex Mono", "code: ui-monospace"],
    ["enableInHtmlEmbed: false", "enableInHtmlEmbed: true"],
  ]) replaceOne(before, after)

  const disabledPlugins = ["alias-redirects", "og-image", "cname", "canvas-page", "tag-page", "graph", "search", "explorer", "footer", "quartz-fonts", "latex", "darkmode", "reader-mode", "spacer", "unlisted-pages", "encrypted-pages", "bases-page", "backlinks", "article-title", "content-meta"]
  for (const plugin of disabledPlugins) replaceOne(`source: "@quartz-community/${plugin}"\n    enabled: true`, `source: "@quartz-community/${plugin}"\n    enabled: false`)
  replaceOne("source: \"@quartz-community/content-index\"\n    enabled: true\n    options:\n      enableSiteMap: true\n      enableRSS: true", "source: \"@quartz-community/content-index\"\n    enabled: true\n    options:\n      enableSiteMap: false\n      enableRSS: false")
  replaceOne("source: \"@quartz-community/table-of-contents\"\n    enabled: true\n    order: 50", "source: \"@quartz-community/table-of-contents\"\n    enabled: true\n    options:\n      maxDepth: 3\n      minEntries: 1\n      showByDefault: true\n      collapseByDefault: true\n      layout: modern\n    order: 50")
  replaceOne("    folder:\n      exclude:\n        - reader-mode\n      positions:\n        right: []", "    folder: {}")

  for (const expected of ["pageTitle: Psychology Research Notes", "enableSPA: false", "enablePopovers: false", "provider: null", "baseUrl: example.invalid", "fontOrigin: local", "cdnCaching: false", "header: system-ui", "body: Georgia", "code: ui-monospace", "enableInHtmlEmbed: true", "folder: {}"]) {
    if (transformed.split(expected).length !== 2) fail()
  }
  for (const plugin of disabledPlugins) {
    const escaped = plugin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const matches = [...transformed.matchAll(new RegExp(`source:\\s*["']@quartz-community/${escaped}["']\\s*\\n\\s*enabled:\\s*(true|false)`, "g"))]
    if (matches.length !== 1 || matches[0][1] !== "false") fail()
  }
  for (const plugin of ["table-of-contents"]) {
    const matches = [...transformed.matchAll(new RegExp(`source:\\s*["']@quartz-community/${plugin}["']\\s*\\n\\s*enabled:\\s*(true|false)`, "g"))]
    if (matches.length !== 1 || matches[0][1] !== "true") fail()
  }
  return transformed
}

/** @param {"warm"|"contrast"} variant @param {string} template */
function scholarlyTheme(variant, template) {
  const palettes = {
    warm: { LIGHT: "#f7f4ee", LIGHTGRAY: "#ddd6c9", GRAY: "#6b7280", DARKGRAY: "#20262e", DARK: "#20262e", SECONDARY: "#405d78", TERTIARY: "#62806a", HIGHLIGHT: "rgba(64, 93, 120, 0.12)" },
    contrast: { LIGHT: "#fffdf8", LIGHTGRAY: "#c9bfae", GRAY: "#6e655a", DARKGRAY: "#292520", DARK: "#100e0c", SECONDARY: "#5b351f", TERTIARY: "#31564b", HIGHLIGHT: "rgba(91, 53, 31, 0.16)" },
  }
  const palette = palettes[variant]
  let css = template.replaceAll("__THEME_VARIANT__", variant)
  for (const [name, value] of Object.entries(palette)) css = css.replaceAll(`__${name}__`, value)
  if (/__[A-Z_]+__/.test(css)) throw new TracerError("INVALID_THEME_TEMPLATE", "scholarly theme template contains an unresolved token")
  return css
}

/** @param {string} executable @param {string[]} args @param {string} cwd */
async function spawnCaptured(executable, args, cwd) {
  const child = spawn(process.execPath, [executable, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", NODE_PATH: path.join(repoRoot, "node_modules") },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let outputBytes = 0
  let logs = ""
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    outputBytes += chunk.length
    if (logs.length < 100_000) logs += chunk.toString("utf8")
    if (outputBytes > 10_000_000) child.kill()
  })
  return await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => signal ? reject(new TracerError("QUARTZ_BUILD_FAILED", "Quartz terminated by signal")) : resolve({ code: code ?? 1, logs }))
  })
}

/** @param {string} value */
function normalizedFsPath(value) {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/** Re-establish the candidate's trusted anchor before every operation.
 * @param {string} candidate @param {string} run */
async function assertCandidateRoot(candidate, run) {
  try {
    const [runMetadata, candidateMetadata] = await Promise.all([lstat(run), lstat(candidate)])
    if (!runMetadata.isDirectory() || runMetadata.isSymbolicLink() || !candidateMetadata.isDirectory() || candidateMetadata.isSymbolicLink()) throw new Error("wrong root class")
    const [canonicalRun, canonicalCandidate] = await Promise.all([realpath(run), realpath(candidate)])
    if (normalizedFsPath(canonicalRun) !== normalizedFsPath(run) || normalizedFsPath(canonicalCandidate) !== normalizedFsPath(candidate)) throw new Error("noncanonical root")
    const relative = path.relative(canonicalRun, canonicalCandidate)
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("candidate escaped run")
    return { canonicalRun, canonicalCandidate }
  } catch {
    throw new TracerError("CANDIDATE_ROOT_INVALID", "candidate root must remain an ordinary canonical directory inside its exclusive run")
  }
}

/** @param {string} root @param {string} run */
async function listRegularTree(root, run) {
  const { canonicalCandidate } = await assertCandidateRoot(root, run)
  /** @type {Array<{relative:string,absolute:string,bytes:Buffer}>} */
  const files = []
  /** @param {string} directory */
  async function walk(directory) {
    const directoryMetadata = await lstat(directory)
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw new TracerError("CANDIDATE_LINK_NOT_ALLOWED", "candidate contains a link or reparse point")
    const canonicalDirectory = await realpath(directory)
    if (normalizedFsPath(canonicalDirectory) !== normalizedFsPath(directory) || !isEqualToOrInside(canonicalCandidate, canonicalDirectory)) {
      throw new TracerError("CANDIDATE_LINK_NOT_ALLOWED", "candidate directory escaped its canonical root")
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const entryMetadata = await lstat(absolute)
      if (entryMetadata.isSymbolicLink()) throw new TracerError("CANDIDATE_LINK_NOT_ALLOWED", "candidate contains a link or reparse point")
      if (entryMetadata.isDirectory()) await walk(absolute)
      else if (entryMetadata.isFile()) {
        const bytes = await readFile(absolute)
        const afterRead = await lstat(absolute)
        if (!afterRead.isFile() || afterRead.isSymbolicLink() || afterRead.size !== entryMetadata.size || afterRead.mtimeMs !== entryMetadata.mtimeMs) {
          throw new TracerError("CANDIDATE_FILE_CHANGED_DURING_READ", "candidate file changed while it was being read")
        }
        files.push({ relative: path.relative(canonicalCandidate, absolute).split(path.sep).join("/"), absolute, bytes })
      } else throw new TracerError("CANDIDATE_FILE_CLASS_INVALID", "candidate contains a nonregular entry")
    }
  }
  await walk(canonicalCandidate)
  await assertCandidateRoot(root, run)
  return files.sort((a, b) => Buffer.compare(Buffer.from(a.relative), Buffer.from(b.relative)))
}

/** @param {string} candidate @param {string} run */
async function immutableCandidateManifest(candidate, run) {
  const rows = (await listRegularTree(candidate, run)).map((file) => Object.freeze({ relative: file.relative, fileClass: "regular-file", sha256: sha256(file.bytes) }))
  return Object.freeze(rows)
}

/** Fixed raw-Quartz HTML mutation proving that a pinned integration-seam upgrade
 * fails before project navigation normalization or output creation.
 * @param {string} candidate @param {string} run @param {string} variant */
async function injectQuartzHtmlRegression(candidate, run, variant) {
  await assertCandidateRoot(candidate, run)
  if (variant !== "content-index-fetch-seam-renamed") {
    throw new TracerError("TEST_INJECTION_INVALID", "Quartz HTML regression injection is not a fixed supported variant")
  }
  const index = path.join(candidate, quartzContentIndexFile)
  const html = await readFile(index, "utf8")
  const mutated = html.replace("const fetchData = fetch(", "const vendorFetchData = fetch(")
  if (mutated === html) throw new TracerError("TEST_INJECTION_INVALID", "pinned Quartz HTML fixture lacks the expected content-index seam")
  await writeFile(index, mutated)
}

const homeNodeClasses = Object.freeze([
  Object.freeze({ nodeClass: "concept", label: "Concepts", description: "Ideas that connect findings across the reading layer. 串連閱讀層中不同研究發現的核心概念。" }),
  Object.freeze({ nodeClass: "method", label: "Methods", description: "Approaches used to collect, connect, and interpret evidence. 用來蒐集、連結與解讀證據的研究方法。" }),
  Object.freeze({ nodeClass: "task", label: "Tasks", description: "Research problems that organize the public literature. 組織公開文獻與研究問題的任務脈絡。" }),
  Object.freeze({ nodeClass: "author", label: "Authors", description: "Researchers connected to the mapped papers and methods. 與目前論文及方法相連的研究者。" }),
  Object.freeze({ nodeClass: "synthesis", label: "Syntheses", description: "Integrated interpretations that connect evidence across papers. 跨越多篇論文整合證據與詮釋的研究綜整。" }),
  Object.freeze({ nodeClass: "map", label: "Maps", description: "Structured overviews of literature, themes, and relationships. 組織文獻、主題與關係的研究地圖。" }),
])
// Lucide outline icons sourced through Iconstack's public SVG API. Keeping the
// paths inline makes this navigation deterministic and removes a runtime fetch.
/** @type {Readonly<Record<string, Readonly<{id:string,body:string}>>>} */
const homeNodeIcons = Object.freeze({
  concept: Object.freeze({
    id: "lucide-network",
    body: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  }),
  method: Object.freeze({
    id: "lucide-flask-conical",
    body: '<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>',
  }),
  task: Object.freeze({
    id: "lucide-list-checks",
    body: '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/>',
  }),
  author: Object.freeze({
    id: "lucide-users-round",
    body: '<path d="M18 21a8 8 0 0 0-16 0"/><circle cx="10" cy="8" r="5"/><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"/>',
  }),
  synthesis: Object.freeze({
    id: "lucide-layers-3",
    body: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="m22 12.5-9.17 4.17a2 2 0 0 1-1.66 0L2 12.5"/><path d="m22 17.5-9.17 4.17a2 2 0 0 1-1.66 0L2 17.5"/>',
  }),
  map: Object.freeze({
    id: "lucide-map",
    body: '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.618v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.382V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>',
  }),
})
const homeStatClasses = Object.freeze([
  Object.freeze({ nodeClass: "paper", label: "Papers" }),
  ...homeNodeClasses.map(({ nodeClass, label }) => Object.freeze({ nodeClass, label })),
])

/** @param {string} markdown @param {string} fallback */
function paperHeadingTitle(markdown, fallback) {
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]
  return collapseUnicodeWhitespace(heading ?? fallback)
}

/** @param {string} markdown @param {string} fallback */
function shortPaperTitle(markdown, fallback) {
  return paperHeadingTitle(markdown, fallback)
    .replace(/^.{1,100}?\b(?:19|20)\d{2}\s*[—–-]\s+/, "")
}

/** @param {string} markdown @param {string} heading */
function markdownSectionSummary(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "mi").exec(markdown)
  if (!match) return "Open the paper note for its public takeaway, questions, and evidence."
  const summary = collapseUnicodeWhitespace(searchableMarkdownSegments(match[1]).body.join(" "))
  if (!summary) return "Open the paper note for its public takeaway, questions, and evidence."
  return summary.length > 220 ? `${summary.slice(0, 217).trimEnd()}…` : summary
}

/** @param {string} nodeClass */
function homeNodeIconSvg(nodeClass) {
  const icon = homeNodeIcons[nodeClass]
  if (!icon) throw new TracerError("HOME_COMPOSITION_INVALID", `home icon is missing for ${nodeClass}`)
  return `<svg class="node-type-card-icon-svg" data-icon="${icon.id}" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icon.body}</svg>`
}

/** @param {Map<string,any>} records @param {Map<string,Set<string>>} outgoing @param {Map<string,string>} searchableBodies */
function homePageMarkdown(records, outgoing, searchableBodies) {
  const entries = [...records.entries()]
  const byClass = new Map(homeStatClasses.map(({ nodeClass }) => [nodeClass, entries.filter(([, record]) => record.node.node_class === nodeClass)]))
  const publicHref = (/** @type {string} */ route) => htmlText(route.slice(1))
  const titleOf = (/** @type {any} */ record) => String(record.frontmatter.title ?? record.node.public_id)
  const stats = homeStatClasses.map(({ nodeClass, label }) => `<li><strong>${byClass.get(nodeClass)?.length ?? 0}</strong> ${htmlText(label)}</li>`).join("")
  const nodeCards = homeNodeClasses.flatMap(({ nodeClass, label, description }) => {
    const grouped = byClass.get(nodeClass) ?? []
    return grouped.length === 0 ? [] : [`<article class="node-type-card node-type-${nodeClass}" data-home-node-class="${nodeClass}"><span class="node-type-card-icon" aria-hidden="true">${homeNodeIconSvg(nodeClass)}</span><div><p class="node-type-card-count">${grouped.length} ${htmlText(label)}</p><h3>${htmlText(label)}</h3><p>${htmlText(description)}</p><button type="button" data-home-library-target="${nodeClass}">View ${htmlText(label.toLowerCase())} <span aria-hidden="true">→</span></button></div></article>`]
  }).join("")
  const papers = (byClass.get("paper") ?? []).slice(0, 6)
  const paperCount = byClass.get("paper")?.length ?? 0
  const paperCards = papers.map(([publicId, record]) => {
    const authors = Array.isArray(record.frontmatter.authors) ? record.frontmatter.authors.join(", ") : ""
    const year = record.frontmatter.year ? String(record.frontmatter.year) : ""
    const related = [...(outgoing.get(publicId) ?? [])].map((id) => records.get(id)).filter(Boolean).slice(0, 3)
    const tags = related.map((target) => `<span data-node-class="${htmlText(target.node.node_class)}">${htmlText(titleOf(target))}</span>`).join("")
    const title = shortPaperTitle(searchableBodies.get(publicId) ?? "", titleOf(record))
    return `<a class="paper-card" href="${publicHref(record.route)}" aria-label="Read ${htmlText(title)}"><p class="paper-card-kicker">Paper${year ? ` · ${htmlText(year)}` : ""}</p><p class="paper-card-title">${htmlText(title)}</p>${authors ? `<p class="paper-card-authors">${htmlText(authors)}</p>` : ""}<p class="paper-card-summary">${htmlText(markdownSectionSummary(searchableBodies.get(publicId) ?? "", "One-sentence Takeaway"))}</p>${tags ? `<div class="paper-card-tags">${tags}</div>` : ""}</a>`
  }).join("")
  const paperCta = paperCount > 6 ? `<div class="featured-papers-more"><button type="button" data-home-library-target="paper">View papers <span aria-hidden="true">→</span></button></div>` : ""
  return `---\ntitle: "Psychology Research Notes"\n---\n\n<section class="home-hero reveal-on-entry" data-home-total="${entries.length}"><p class="home-eyebrow">Public research reading layer</p><h1>Psychology Research Notes</h1><p class="home-intro">Literature-centered notes on psychology, connected through authors, concepts, methods, and research tasks. <span lang="zh-Hant">以心理學文獻為核心的研究筆記，透過作者、構念、研究方法與實驗作業彼此串聯。</span></p><div class="home-search-slot"></div><ul class="home-stats" aria-label="Public collection totals">${stats}</ul></section>\n\n<section class="home-section reveal-on-entry" aria-labelledby="browse-heading"><div class="home-section-heading"><p class="home-eyebrow">Research lenses</p><h2 id="browse-heading">Explore through knowledge nodes</h2></div><div class="node-type-grid">${nodeCards}</div></section>\n\n<section class="home-section reveal-on-entry" aria-labelledby="featured-heading"><div class="home-section-heading"><p class="home-eyebrow">Featured papers</p><h2 id="featured-heading">Browse reviewed papers</h2></div><div class="featured-paper-grid">${paperCards}</div>${paperCta}</section>\n`
}

const paperTabs = Object.freeze([
  Object.freeze({ key: "introductions", label: "Introductions", startId: "bibliography", fallbackId: null }),
  Object.freeze({ key: "methods", label: "Methods", startId: "method", fallbackId: null }),
  Object.freeze({ key: "results", label: "Results", startId: "main-results", fallbackId: null }),
  Object.freeze({ key: "discussion", label: "Discussion", startId: "authors-discussion", fallbackId: null }),
  Object.freeze({ key: "others", label: "Others", startId: "relevance-to-my-research", fallbackId: "connections" }),
])

/** Split only the rendered paper-note body. The immutable Vault Markdown stays
 * untouched; absent optional sections produce an empty, stable panel. */
function addPaperTabs(/** @type {string} */ html) {
  const mastheadEnd = html.indexOf("</header>")
  const articleEnd = html.lastIndexOf("</article>")
  const trailingContainers = articleEnd > 0 ? /(?:<\/div>\s*)+$/.exec(html.slice(0, articleEnd)) : null
  const contentEnd = trailingContainers?.index ?? -1
  const firstHeading = html.indexOf('<h2 id="bibliography"', mastheadEnd)
  if (mastheadEnd < 0 || firstHeading < 0 || contentEnd <= firstHeading) throw new TracerError("PAPER_TABS_INVALID", "generated paper page lacks the stable tab section seams")
  const content = html.slice(firstHeading, contentEnd)
  const starts = paperTabs.map((tab) => {
    const primary = content.indexOf(`<h2 id="${tab.startId}"`)
    if (primary >= 0) return primary
    return tab.fallbackId ? content.indexOf(`<h2 id="${tab.fallbackId}"`) : -1
  })
  const panelContent = paperTabs.map((_, index) => {
    const start = starts[index]
    if (start < 0) return ""
    const later = starts.slice(index + 1).filter((candidate) => candidate > start)
    const end = later.length > 0 ? Math.min(...later) : content.length
    return content.slice(start, end)
  })
  const controls = paperTabs.map((tab, index) => `<button type="button" id="paper-tab-${tab.key}" role="tab" data-paper-tab="${tab.key}" aria-controls="paper-panel-${tab.key}" aria-selected="${index === 0}" tabindex="${index === 0 ? "0" : "-1"}">${tab.label}</button>`).join("")
  const pickerOptions = paperTabs.map((tab, index) => `<button type="button" role="option" data-section-option="${tab.key}" aria-selected="${index === 0}"><span>${tab.label}</span><span class="section-picker-check" aria-hidden="true">✓</span></button>`).join("")
  const panels = paperTabs.map((tab, index) => `<section class="paper-tab-panel" id="paper-panel-${tab.key}" role="tabpanel" aria-labelledby="paper-tab-${tab.key}" data-paper-panel="${tab.key}"${index === 0 ? "" : " hidden"}><h2 class="paper-tab-title" id="paper-section-${tab.key}" tabindex="-1">${tab.label}</h2>${panelContent[index]}</section>`).join("")
  /** @param {string} className */
  const pickerChevron = (className) => `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="6 9 12 15 18 9"></polyline></svg>`
  const navigationChevron = pickerChevron("section-picker-icon")
  const selectionChevron = pickerChevron("section-picker-caret")
  const picker = `<div class="paper-section-picker" data-section-picker role="toolbar" aria-label="Paper section controls"><button type="button" class="section-picker-step section-picker-previous" data-section-step="previous" aria-label="Previous paper section" aria-disabled="true" disabled>${navigationChevron}</button><div class="section-picker-select"><button type="button" class="section-picker-toggle" data-section-picker-toggle aria-haspopup="listbox" aria-controls="paper-section-picker-options" aria-expanded="false"><span data-section-current>Introductions</span>${selectionChevron}</button><div class="section-picker-options" id="paper-section-picker-options" role="listbox" aria-label="Choose paper section" hidden>${pickerOptions}</div></div><button type="button" class="section-picker-step section-picker-next" data-section-step="next" aria-label="Next paper section" aria-disabled="false">${navigationChevron}</button></div>`
  const tabs = `<div class="paper-section-navigation" data-paper-section-navigation><div class="paper-tabs"><div class="paper-tab-list" role="tablist" aria-label="Paper note sections"><span class="paper-tab-pill" aria-hidden="true"></span>${controls}</div></div>${picker}</div>${panels}`
  return `${html.slice(0, firstHeading)}${tabs}${html.slice(contentEnd)}`
}

function paperReadingRuntimeScript() {
  return `<script data-tracer-extension="t06-reading">(()=>{
    const setup=()=>{
      const body=document.body
      if(body.dataset.tracerTemplate!=="paper"||body.hasAttribute("data-reading-tools-ready"))return
      body.setAttribute("data-reading-tools-ready","")
      const progress=document.querySelector(".reading-progress span"),citationButton=document.querySelector("[data-copy-citation]"),toast=document.querySelector("[data-citation-toast]"),tabs=[...document.querySelectorAll("[data-paper-tab]")],panels=[...document.querySelectorAll("[data-paper-panel]")],pill=document.querySelector(".paper-tab-pill"),toc=document.querySelector(".toc-content"),navigation=document.querySelector("[data-paper-section-navigation]"),picker=document.querySelector("[data-section-picker]"),pickerToggle=document.querySelector("[data-section-picker-toggle]"),pickerOptions=document.getElementById("paper-section-picker-options"),currentLabel=document.querySelector("[data-section-current]"),previousButton=document.querySelector('[data-section-step="previous"]'),nextButton=document.querySelector('[data-section-step="next"]')
      const updateProgress=()=>{const maximum=Math.max(1,document.documentElement.scrollHeight-innerHeight),value=Math.min(1,Math.max(0,scrollY/maximum));if(progress)progress.style.transform="scaleX("+value+")"}
      updateProgress()
      addEventListener("scroll",updateProgress,{passive:true})
      citationButton?.addEventListener("click",async()=>{const heading=document.getElementById("citation"),parts=[];for(let node=heading?.nextElementSibling;node&&!/^H[12]$/.test(node.tagName);node=node.nextElementSibling)parts.push(node.textContent?.trim()??"");const citation=parts.filter(Boolean).join("\\n");if(!citation)return;await navigator.clipboard.writeText(citation);if(toast){toast.hidden=false;clearTimeout(window.__tylerCitationToast);window.__tylerCitationToast=setTimeout(()=>{toast.hidden=true},2200)}})
      const measure=button=>{if(!pill||!button)return;pill.style.left=button.offsetLeft+"px";pill.style.top=button.offsetTop+"px";pill.style.width=button.offsetWidth+"px";pill.style.height=button.offsetHeight+"px"}
      const renderToc=panel=>{if(!toc||!panel)return;const label=document.getElementById(panel.getAttribute("aria-labelledby"))?.textContent?.trim()??"Section",rows=[{id:panel.querySelector(".paper-tab-title")?.id,label,depth:0},...[...panel.querySelectorAll("h2[id]:not(.paper-tab-title),h3[id]")].map(heading=>({id:heading.id,label:heading.childNodes[0]?.textContent?.trim()||heading.textContent?.trim()||heading.id,depth:heading.tagName==="H2"?1:2}))];toc.replaceChildren(...rows.filter(row=>row.id).map((row,index)=>{const item=document.createElement("li"),link=document.createElement("a");item.className="depth-"+row.depth+(row.depth===0?" paper-tab-toc-title":"");item.style.setProperty("--toc-item-delay",Math.min(index*42,420)+"ms");link.href="#"+row.id;link.dataset.for=row.id;link.textContent=row.label;item.append(link);return item}))}
      const setPickerOpen=open=>{if(!pickerToggle||!pickerOptions)return;pickerToggle.setAttribute("aria-expanded",String(open));pickerOptions.hidden=!open;navigation?.toggleAttribute("data-picker-open",open);if(open)navigation?.removeAttribute("data-sticky-hidden")}
      const setStepDisabled=(button,disabled)=>{if(!button)return;button.disabled=disabled;button.setAttribute("aria-disabled",String(disabled))}
      const activate=(key,{focus=false}={})=>{const button=tabs.find(candidate=>candidate.dataset.paperTab===key)??tabs[0],panel=panels.find(candidate=>candidate.dataset.paperPanel===button?.dataset.paperTab);if(!button||!panel)return;const activeIndex=tabs.indexOf(button);for(const candidate of tabs){const active=candidate===button;candidate.setAttribute("aria-selected",String(active));candidate.tabIndex=active?0:-1}for(const candidate of panels)candidate.hidden=candidate!==panel;for(const option of document.querySelectorAll("[data-section-option]"))option.setAttribute("aria-selected",String(option.dataset.sectionOption===button.dataset.paperTab));if(currentLabel)currentLabel.textContent=button.textContent?.trim()??"Section";setStepDisabled(previousButton,activeIndex<=0);setStepDisabled(nextButton,activeIndex>=tabs.length-1);measure(button);renderToc(panel);updateProgress();if(focus)button.focus()}
      const activateOffset=offset=>{const index=tabs.findIndex(button=>button.getAttribute("aria-selected")==="true"),target=tabs[index+offset];if(target)activate(target.dataset.paperTab)}
      const panelForHash=()=>{const target=location.hash&&document.getElementById(decodeURIComponent(location.hash.slice(1)));return target?.closest?.("[data-paper-panel]")?.dataset.paperPanel}
      for(const [index,button] of tabs.entries()){button.addEventListener("click",()=>activate(button.dataset.paperTab));button.addEventListener("keydown",event=>{let target;if(event.key==="ArrowRight")target=(index+1)%tabs.length;else if(event.key==="ArrowLeft")target=(index-1+tabs.length)%tabs.length;else if(event.key==="Home")target=0;else if(event.key==="End")target=tabs.length-1;else return;event.preventDefault();activate(tabs[target].dataset.paperTab,{focus:true})})}
      previousButton?.addEventListener("click",()=>activateOffset(-1))
      nextButton?.addEventListener("click",()=>activateOffset(1))
      pickerToggle?.addEventListener("click",()=>setPickerOpen(pickerToggle.getAttribute("aria-expanded")!=="true"))
      for(const option of document.querySelectorAll("[data-section-option]"))option.addEventListener("click",()=>{activate(option.dataset.sectionOption);setPickerOpen(false);pickerToggle?.focus()})
      document.addEventListener("click",event=>{if(!event.target.closest("[data-section-picker]"))setPickerOpen(false)})
      document.addEventListener("keydown",event=>{if(event.key==="Escape"&&pickerToggle?.getAttribute("aria-expanded")==="true"){setPickerOpen(false);pickerToggle.focus()}})
      let swipeStart=null
      picker?.addEventListener("pointerdown",event=>{swipeStart=event.clientX})
      picker?.addEventListener("pointerup",event=>{if(swipeStart===null)return;const distance=event.clientX-swipeStart;swipeStart=null;if(Math.abs(distance)<44)return;activateOffset(distance<0?1:-1)})
      let lastScrollY=scrollY,naturalTop=navigation?.offsetTop??0
      const updateNavigationVisibility=()=>{if(!navigation)return;const current=scrollY,delta=current-lastScrollY;if(current<=naturalTop+8)navigation.removeAttribute("data-sticky-hidden");else if(delta>6&&!navigation.hasAttribute("data-picker-open"))navigation.setAttribute("data-sticky-hidden","");else if(delta<-6)navigation.removeAttribute("data-sticky-hidden");lastScrollY=current}
      addEventListener("scroll",updateNavigationVisibility,{passive:true})
      activate(panelForHash()??"introductions")
      addEventListener("hashchange",()=>{const key=panelForHash();if(key)activate(key)})
      new ResizeObserver(()=>{naturalTop=navigation?.offsetTop??naturalTop;measure(tabs.find(button=>button.getAttribute("aria-selected")==="true"))}).observe(document.querySelector(".paper-tab-list"))
    }
    setup()
    document.addEventListener("nav",setup)
  })()</script>`
}

/** @param {string} html @param {any} record */
function addPaperMasthead(html, record) {
  const heading = /<h1\b[^>]*>[\s\S]*?<\/h1>/.exec(html)?.[0]
  if (!heading) throw new TracerError("PAPER_MASTHEAD_INVALID", "generated paper page lacks its primary heading")
  const frontmatter = record.frontmatter
  const headingOpen = /^<h1\b[^>]*>/.exec(heading)?.[0] ?? "<h1>"
  const headingAnchor = /(<a\b[^>]*href="#[^"]*"[^>]*>[\s\S]*?<\/a>)\s*<\/h1>$/.exec(heading)?.[1] ?? ""
  const fullHeading = `${headingOpen}${htmlText(frontmatter.title ?? record.node.public_id)}${headingAnchor}</h1>`
  const authors = Array.isArray(frontmatter.authors) ? frontmatter.authors.map(htmlText).join(", ") : ""
  const year = frontmatter.year ? htmlText(frontmatter.year) : ""
  const venue = frontmatter.venue ? htmlText(frontmatter.venue) : ""
  const doi = typeof frontmatter.doi === "string" ? frontmatter.doi : ""
  const tags = [...new Set([...(Array.isArray(frontmatter.author_keywords) ? frontmatter.author_keywords : []), ...(Array.isArray(frontmatter.reader_keywords) ? frontmatter.reader_keywords : [])])]
  const badges = tags.map((tag) => `<span>${htmlText(tag)}</span>`).join("")
  const doiAction = doi ? `<a href="https://doi.org/${doi.split("/").map(encodeURIComponent).join("/")}" target="_blank" rel="noopener noreferrer">DOI / source</a>` : ""
  const masthead = `<header class="paper-masthead"><p class="paper-masthead-kicker">Paper note</p><p class="paper-masthead-meta">${htmlText([authors, year].filter(Boolean).join(" · "))}</p>${fullHeading}${venue ? `<p class="paper-masthead-venue">${venue}</p>` : ""}<div class="paper-masthead-actions"><button type="button" data-copy-citation>Copy citation</button>${doiAction}<a href="#public-graph-local-${htmlText(record.node.public_id)}">View in graph</a></div>${badges ? `<div class="paper-masthead-tags">${badges}</div>` : ""}</header>`
  let normalized = html.replace(heading, masthead).replace(/<body\b[^>]*>/, (body) => `${body}<div class="reading-progress" aria-hidden="true"><span></span></div>`)
  normalized = addPaperTabs(normalized)
  normalized = normalized.replace("</body>", `<div class="copy-citation-toast" data-citation-toast role="status" aria-live="polite" hidden>Citation copied.</div>${paperReadingRuntimeScript()}</body>`)
  return normalized
}

function homeRuntimeScript() {
  return `<script data-tracer-extension="t06-home">(()=>{const setup=()=>{const hero=document.querySelector(".home-hero");if(!hero||hero.hasAttribute("data-home-ready"))return;hero.setAttribute("data-home-ready","");for(const button of document.querySelectorAll("[data-home-library-target]"))button.addEventListener("click",()=>document.dispatchEvent(new CustomEvent("tracer:open-library",{detail:{nodeClass:button.dataset.homeLibraryTarget}})));if(!matchMedia("(prefers-reduced-motion: reduce)").matches){const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){entry.target.classList.add("is-visible");observer.unobserve(entry.target)}},{threshold:.12});document.querySelectorAll(".reveal-on-entry").forEach(section=>observer.observe(section))}else document.querySelectorAll(".reveal-on-entry").forEach(section=>section.classList.add("is-visible"))};setup();document.addEventListener("nav",setup)})()</script>`
}

/** Breadcrumbs are orientation text only. Navigation lives in Library, so
 * rendering route fragments as links would imply pages that do not exist.
 * @param {string} route @param {any|null} record @param {Map<string,string>} searchableBodies */
function plainBreadcrumbMarkup(route, record, searchableBodies) {
  const routeParts = route.split("/").filter(Boolean)
  const hierarchy = routeParts.slice(0, -1).map((part) => part.replaceAll("-", " ").replace(/^./, (character) => character.toUpperCase()))
  const current = record
    ? record.node.node_class === "paper"
      ? shortPaperTitle(searchableBodies.get(record.node.public_id) ?? "", String(record.frontmatter.title ?? record.node.public_id))
      : ["concept", "method", "task"].includes(record.node.node_class)
        ? String(record.frontmatter.title ?? record.node.public_id).replace(/^./u, (character) => character.toLocaleUpperCase("en-US"))
        : String(record.frontmatter.title ?? record.node.public_id)
    : "Home"
  const labels = route === "/" ? ["Home"] : ["Home", ...hierarchy, current]
  const items = labels.map((label, index) => `<li${index === labels.length - 1 ? ' aria-current="page"' : ""}>${htmlText(label)}</li>`).join("")
  return `<nav class="breadcrumb-container" aria-label="Breadcrumb"><ol>${items}</ol></nav>`
}

const emptyQuartzFolderListing = /<div class="page-listing"><p>0 items under this folder\.<\/p><div><ul class="section-ul"><\/ul><\/div><\/div>/g
const quartzArticleFooterRule = /<\/article>(<\/div>)?<hr\/><div class="page-footer">/g

/** Replace Quartz breadcrumb navigation before the immutable baseline.
 * @param {string} candidate @param {string} run
 * @param {Map<string,{route:string,frontmatter:Record<string,string|string[]>,node:{public_id:string,node_class:string,path:string}}>} records
 * @param {Map<string,Set<string>>} outgoing @param {Map<string,string>} searchableBodies
 * @param {{entryFile:string,custom404:string}} deploymentFiles */
async function normalizeBreadcrumbRoutes(candidate, run, records, outgoing, searchableBodies, deploymentFiles) {
  const explorerEntries = [...records.values()].map((record) => ({
    publicId: record.node.public_id,
    nodeClass: record.node.node_class,
    route: record.route,
    label: record.node.node_class === "paper"
      ? paperHeadingTitle(searchableBodies.get(record.node.public_id) ?? "", String(record.frontmatter.title ?? record.node.public_id))
      : record.node.node_class === "author"
        ? path.posix.basename(record.node.path, ".md")
        : String(record.frontmatter.title ?? record.node.public_id),
  })).sort((left, right) => Buffer.compare(Buffer.from(left.publicId), Buffer.from(right.publicId)))
  for (const file of await listRegularTree(candidate, run)) {
    if (!file.relative.endsWith(".html")) continue
    const route = generatedHtmlRoute(file.relative, deploymentFiles)
    const html = file.bytes.toString("utf8")
    const record = [...records.values()].find((candidateRecord) => candidateRecord.route === route)
    const publicPage = route === "/" || Boolean(record)
    if (!publicPage) {
      const normalized = html
        .replace(/<link rel="preconnect" href="https:\/\/cdnjs\.cloudflare\.com" crossorigin="anonymous"\/>/g, "")
        .replaceAll("https://example.invalid", "")
      if (normalized !== html) await writeFile(file.absolute, normalized)
      continue
    }
    const backlinks = record ? [...records.entries()]
      .filter(([sourceId]) => sourceId !== record.node.public_id && outgoing.get(sourceId)?.has(record.node.public_id))
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([sourceId, source]) => ({ publicId: sourceId, nodeClass: source.node.node_class, route: source.route, label: String(source.frontmatter.title ?? sourceId) })) : []
    const navigation = createQuartzPublicNavigation({
      entries: explorerEntries,
      route,
      currentPublicId: record?.node.public_id ?? null,
      backlinks,
    })
    let normalized = html
    const breadcrumbPattern = /<nav\b(?=[^>]*class="[^"]*breadcrumb-container)[^>]*>[\s\S]*?<\/nav>/gi
    const breadcrumbCount = normalized.match(breadcrumbPattern)?.length ?? 0
    if (breadcrumbCount !== (record ? 1 : 0)) throw new TracerError("CANDIDATE_BREADCRUMB_INVALID", "generated public page has an unexpected breadcrumb seam")
    if (record) {
      normalized = normalized.replace(breadcrumbPattern, plainBreadcrumbMarkup(route, record, searchableBodies))
      const emptyFolderListingCount = normalized.match(emptyQuartzFolderListing)?.length ?? 0
      if (emptyFolderListingCount !== 1) throw new TracerError("CANDIDATE_FOLDER_LISTING_INVALID", "generated mapped page lacks the exact empty Quartz folder listing")
      normalized = normalized.replace(emptyQuartzFolderListing, "")
    }
    const contentIndexFetchSeam = /<script type="application\/javascript" data-persist="true">const fetchData = fetch\("[^"]*static\/contentIndex\.json"\)\.then\(data => data\.json\(\)\)<\/script>/g
    const contentIndexFetchSeams = normalized.match(contentIndexFetchSeam) ?? []
    if (contentIndexFetchSeams.length !== 1) {
      throw new TracerError("QUARTZ_HTML_INTEGRATION_SEAM_INVALID", "generated public page lacks the exact unique pinned Quartz content-index fetch seam")
    }
    normalized = normalized
      .replace(/<link rel="preconnect" href="https:\/\/cdnjs\.cloudflare\.com" crossorigin="anonymous"\/>/g, "")
      .replace(contentIndexFetchSeam, navigation.contentIndexScript)
      .replaceAll("https://example.invalid", "")
    const articleFooterRuleCount = normalized.match(quartzArticleFooterRule)?.length ?? 0
    if (articleFooterRuleCount !== 1) throw new TracerError("CANDIDATE_ARTICLE_FOOTER_RULE_INVALID", "generated public page lacks the exact Quartz article footer rule")
    normalized = normalized.replace(quartzArticleFooterRule, (_match, centerClose = "") => `</article>${centerClose}<div class="page-footer">`)
    if (publicPage) {
      const existingExplorerCount = [...normalized.matchAll(/\bclass="([^"]*)"/g)].filter((match) => match[1].split(/\s+/).includes("explorer")).length
      if (existingExplorerCount !== 0 || normalized.includes("public-explorer")) {
        throw new TracerError("CANDIDATE_EXPLORER_INVALID", "generated public page must not retain the disabled vendor Explorer shell")
      }
      if (route === "/") {
        const homeSearchSlot = /<div class="home-search-slot"><\/div>/
        if (!homeSearchSlot.test(normalized)) throw new TracerError("HOME_COMPOSITION_INVALID", "generated home page lacks its search insertion seam")
        normalized = normalized.replace(homeSearchSlot, navigation.searchMarkup)
      }
      const explorerMarkup = navigation.explorerShellMarkup
      const leftSidebar = '<div class="left sidebar">'
      const leftSidebarCount = normalized.split(leftSidebar).length - 1
      if (leftSidebarCount > 1) throw new TracerError("CANDIDATE_EXPLORER_INVALID", "generated public page has an ambiguous left sidebar seam")
      if (leftSidebarCount === 1) normalized = normalized.replace(leftSidebar, `${leftSidebar}${explorerMarkup}`)
      else {
        const quartzBody = '<div id="quartz-body">'
        if (normalized.split(quartzBody).length !== 2) throw new TracerError("CANDIDATE_EXPLORER_INVALID", "generated public page lacks the exact Quartz body insertion seam")
        normalized = normalized.replace(quartzBody, `${quartzBody}<div class="left sidebar">${explorerMarkup}</div>`)
      }
      const duplicateHomepage = /<h2 class="page-title"><a href="[^"]*">Psychology Research Notes<\/a><\/h2>/g
      const duplicateHomepageCount = normalized.match(duplicateHomepage)?.length ?? 0
      if (duplicateHomepageCount !== 1) throw new TracerError("CANDIDATE_EXPLORER_INVALID", "generated public page must expose exactly one removable vendor homepage link")
      normalized = normalized.replace(duplicateHomepage, "")
      const searchCount = [...normalized.matchAll(/\bclass="[^"]*\bpublic-search\b[^"]*"/g)].length
      if (searchCount !== (route === "/" ? 1 : 0)) throw new TracerError("CANDIDATE_SEARCH_INVALID", "generated public search must appear on the homepage only")
      const explorerCount = [...normalized.matchAll(/\bclass="([^"]*)"/g)].filter((match) => match[1].split(/\s+/).includes("explorer")).length
      if (explorerCount !== 1 || normalized.includes("public-explorer")) throw new TracerError("CANDIDATE_EXPLORER_INVALID", "generated public page must expose exactly one project-owned Explorer")
      const rightSidebar = '<div class="right sidebar">'
      const rightSidebarCount = normalized.split(rightSidebar).length - 1
      if (rightSidebarCount !== 1) throw new TracerError("CANDIDATE_TOC_INVALID", "generated public page lacks the exact right sidebar seam")
      normalized = normalized.replace(rightSidebar, `${rightSidebar}${navigation.tocBackdropMarkup}`)
    }
    if (record) {
      const template = selectProjectPageTemplate(record.node.node_class === "paper" ? "paper" : "support")
      if (record.node.node_class === "paper") normalized = addPaperMasthead(normalized, record)
      try {
        normalized = template.render(normalized, navigation)
      } catch (error) {
        if (error instanceof ProjectPageTemplateError) throw new TracerError(error.code, error.message)
        throw error
      }
    } else {
      const articleEnd = normalized.lastIndexOf("</article>")
      if (articleEnd < 0) throw new TracerError("CANDIDATE_GRAPH_INVALID", "generated public page lacks an article graph surface")
      normalized = `${normalized.slice(0, articleEnd)}${navigation.graphMarkup}${navigation.backToTopMarkup}${normalized.slice(articleEnd)}`
      normalized = normalized.replace("</body>", `${navigation.runtimeScripts}</body>`)
      normalized = normalized.replace("</body>", `${homeRuntimeScript()}</body>`)
    }
    normalized = openExternalLinksInNewTab(normalized)
    if (normalized !== html) await writeFile(file.absolute, normalized)
  }
}

const projectSiteAttribute = /(\b(?:href|src|content)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
const custom404ContentIndexFetch = /(fetch\(\s*)(["'])\/static\/contentIndex\.json\2(\s*\))/g

/** @param {string} html @param {(value:string) => string} rewrite */
function rewriteProjectSiteAttributes(html, rewrite) {
  projectSiteAttribute.lastIndex = 0
  return html.replace(projectSiteAttribute, (whole, prefix, doubleQuoted, singleQuoted, unquoted) => {
    const value = doubleQuoted ?? singleQuoted ?? unquoted
    const rewritten = rewrite(value)
    if (rewritten === value) return whole
    if (doubleQuoted !== undefined) return `${prefix}"${rewritten}"`
    if (singleQuoted !== undefined) return `${prefix}'${rewritten}'`
    return `${prefix}${rewritten}`
  })
}

/** @param {string} value */
function projectSiteReference(value) {
  if (!value.startsWith("/") || value.startsWith("//")) return value
  if (value === projectSiteBasePath.slice(0, -1) || value.startsWith(projectSiteBasePath)) return value === projectSiteBasePath.slice(0, -1) ? projectSiteBasePath : value
  return `${projectSiteBasePath}${value.slice(1)}`
}

/** @param {string} html */
function normalizeCustom404References(html) {
  const normalized = rewriteProjectSiteAttributes(html, projectSiteReference)
    .replace(custom404ContentIndexFetch, `$1$2${projectSiteBasePath}static/contentIndex.json$2$3`)
  projectSiteAttribute.lastIndex = 0
  for (const match of normalized.matchAll(projectSiteAttribute)) {
    const value = match[2] ?? match[3] ?? match[4]
    if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith(projectSiteBasePath)) {
      throw new TracerError("CUSTOM_404_BASE_PATH_INVALID", "generated custom 404 contains an escaping root-absolute URL-bearing attribute")
    }
  }
  if (/fetch\(\s*["']\/(?!Tyler-Vault_PaperNote_ReadingSite\/)/.test(normalized)) {
    throw new TracerError("CUSTOM_404_BASE_PATH_INVALID", "generated custom 404 contains an escaping root-absolute content-index fetch")
  }
  return normalized
}

/** @param {string} candidate @param {string} run @param {{custom404:string}} deploymentFiles */
async function normalizeCustom404BasePath(candidate, run, deploymentFiles) {
  await assertCandidateRoot(candidate, run)
  const custom404 = (await listRegularTree(candidate, run)).find((file) => file.relative === deploymentFiles.custom404)
  if (!custom404) throw new TracerError("CUSTOM_404_BASE_PATH_INVALID", "generated custom 404 is missing")
  const html = custom404.bytes.toString("utf8")
  const normalized = normalizeCustom404References(html)
  if (normalized !== html) await writeFile(custom404.absolute, normalized)
}

/** Replace Quartz's broad content index with the exact public search contract;
 * fetchData remains the shared runtime seam used by project-owned navigation. */
async function writePublicDataAssets(/** @type {string} */ candidate, /** @type {string} */ run, /** @type {{graph:any,search:any}} */ contracts) {
  await assertCandidateRoot(candidate, run)
  const graphBytes = `${JSON.stringify(contracts.graph)}\n`
  const searchBytes = `${JSON.stringify(contracts.search)}\n`
  await mkdir(path.join(candidate, "static"), { recursive: true })
  await Promise.all([
    writeFile(path.join(candidate, "graph.json"), graphBytes),
    writeFile(path.join(candidate, "search-index.json"), searchBytes),
    writeFile(path.join(candidate, "static", "contentIndex.json"), searchBytes),
  ])
}

/** Add the project-owned local fonts to the generated theme before its
 * immutable baseline is captured. Quartz's SCSS bundler treats font URLs as
 * module imports, so the URL-bearing rules enter after that compilation step. */
async function installProjectTypographyAssets(/** @type {string} */ candidate, /** @type {string} */ run) {
  await assertCandidateRoot(candidate, run)
  const files = await listRegularTree(candidate, run)
  const themeStylesheets = files.filter((file) => file.relative.endsWith(".css") && file.bytes.includes(Buffer.from("--tyler-tracer-theme")))
  if (themeStylesheets.length !== 1) throw new TracerError("PROJECT_TYPOGRAPHY_ASSET_INVALID", "generated output must contain exactly one project theme stylesheet")
  const targetFontPath = path.join(candidate, "static", "fonts")
  await mkdir(targetFontPath, { recursive: true })
  await Promise.all(projectFontAssets.map(async (fontAsset) => {
    const bytes = await readFile(path.join(projectFontAssetPath, fontAsset))
    if (sha256(bytes) !== projectFontAssetHashes[fontAsset]) throw new TracerError("PROJECT_TYPOGRAPHY_ASSET_INVALID", "project font asset does not match its pinned official source")
    await writeFile(path.join(targetFontPath, fontAsset), bytes, { flag: "wx" })
  }))
  const fontStyles = await readFile(projectFontStylesPath, "utf8")
  const themeStylesheet = themeStylesheets[0]
  await writeFile(themeStylesheet.absolute, `${themeStylesheet.bytes.toString("utf8")}\n${fontStyles}`)
}

/** @param {Map<string,{route:string}>} records @param {{entryFile:string,custom404:string}} deploymentFiles @param {boolean} [retainCustom404] */
function virtualHtmlPaths(records, deploymentFiles, retainCustom404 = false) {
  const virtual = new Set(retainCustom404 ? [] : [deploymentFiles.custom404])
  for (const { route } of records.values()) {
    const segments = route.split("/").filter(Boolean)
    for (let length = 1; length < segments.length; length += 1) virtual.add(quartzContentRouteFile(`/${segments.slice(0, length).join("/")}/`))
  }
  return virtual
}

/** Remove only baseline-authenticated Quartz virtual pages.
 * @param {string} candidate @param {string} run @param {Map<string,{route:string}>} records
 * @param {ReadonlyArray<{relative:string,fileClass:string,sha256:string}>} baseline @param {{entryFile:string,custom404:string}} deploymentFiles @param {boolean} [retainCustom404] */
async function pruneVirtualHtml(candidate, run, records, baseline, deploymentFiles, retainCustom404 = false) {
  await assertCandidateRoot(candidate, run)
  const virtual = virtualHtmlPaths(records, deploymentFiles, retainCustom404)
  const baselineByPath = new Map(baseline.map((row) => [row.relative, row]))
  const current = await listRegularTree(candidate, run)
  const currentByPath = new Map(current.map((file) => [file.relative, file]))
  const generatedVirtual = [...virtual].filter((relative) => baselineByPath.has(relative))
  for (const relative of generatedVirtual) {
    const expected = baselineByPath.get(relative)
    const file = currentByPath.get(relative)
    if (!expected || !file || expected.fileClass !== "regular-file" || sha256(file.bytes) !== expected.sha256) {
      throw new TracerError("CANDIDATE_VIRTUAL_PAGE_TAMPERED", "a known Quartz virtual page changed before pruning")
    }
  }
  for (const file of current) {
    if (virtual.has(file.relative) && !baselineByPath.has(file.relative)) {
      throw new TracerError("CANDIDATE_VIRTUAL_PAGE_TAMPERED", "an untrusted virtual page appeared after the Quartz baseline")
    }
  }
  for (const relative of generatedVirtual) {
    await assertCandidateRoot(candidate, run)
    const file = currentByPath.get(relative)
    if (!file || sha256(await readFile(file.absolute)) !== baselineByPath.get(relative)?.sha256) {
      throw new TracerError("CANDIDATE_VIRTUAL_PAGE_TAMPERED", "a known Quartz virtual page changed before deletion")
    }
    await rm(file.absolute)
  }
}

/** @param {string} value */
function decodeHtmlAttribute(value) {
  const names = new Map([["amp", "&"], ["quot", "\""], ["apos", "'"], ["lt", "<"], ["gt", ">"], ["colon", ":"], ["tab", "\t"], ["newline", "\n"]])
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));?/gi, (whole, decimal, hexadecimal, name) => {
    if (decimal || hexadecimal) {
      const point = Number.parseInt(decimal ?? hexadecimal, decimal ? 10 : 16)
      return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole
    }
    return names.get(String(name).toLowerCase()) ?? whole
  })
}

/** @param {string} source */
function parseTagAttributes(source) {
  /** @type {Array<{name:string,value:string}>} */
  const attributes = []
  let cursor = 0
  while (cursor < source.length) {
    while (/\s|\//.test(source[cursor] ?? "")) cursor += 1
    if (cursor >= source.length) break
    const start = cursor
    while (cursor < source.length && !/[\s=/>]/.test(source[cursor])) cursor += 1
    const name = source.slice(start, cursor).toLowerCase()
    while (/\s/.test(source[cursor] ?? "")) cursor += 1
    let value = ""
    if (source[cursor] === "=") {
      cursor += 1
      while (/\s/.test(source[cursor] ?? "")) cursor += 1
      const quote = source[cursor] === "\"" || source[cursor] === "'" ? source[cursor++] : ""
      const valueStart = cursor
      if (quote) while (cursor < source.length && source[cursor] !== quote) cursor += 1
      else while (cursor < source.length && !/[\s>]/.test(source[cursor])) cursor += 1
      value = decodeHtmlAttribute(source.slice(valueStart, cursor))
      if (quote && source[cursor] === quote) cursor += 1
    }
    if (name) attributes.push({ name, value })
  }
  return attributes
}

/** @param {string} tag @param {string} name @param {string} value */
function setHtmlTagAttribute(tag, name, value) {
  const attribute = new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i")
  return attribute.test(tag)
    ? tag.replace(attribute, ` ${name}="${value}"`)
    : tag.replace(/>$/, ` ${name}="${value}">`)
}

/** Give the reviewed favicon a content-derived cache key while retaining the
 * same immutable public asset. @param {string} html */
function versionProjectSiteIconReference(html) {
  let iconLinks = 0
  const versioned = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const attributes = new Map(parseTagAttributes(tag.slice(5, -1)).map((attribute) => [attribute.name, attribute.value]))
    const rel = new Set((attributes.get("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean))
    const href = attributes.get("href") ?? ""
    if (!rel.has("icon") || !/(?:^|\/)static\/icon\.png$/.test(href)) return tag
    iconLinks += 1
    return setHtmlTagAttribute(tag, "href", `${href}?v=${projectSiteIconSha256}`)
  })
  if (iconLinks !== 1) throw new TracerError("PROJECT_SITE_ICON_LINK_INVALID", "candidate page lacks the exact project favicon link")
  return versioned
}

/** @param {string} candidate @param {string} run */
async function versionProjectSiteIcon(candidate, run) {
  for (const file of await listRegularTree(candidate, run)) {
    if (!file.relative.endsWith(".html")) continue
    await writeFile(file.absolute, versionProjectSiteIconReference(file.bytes.toString("utf8")))
  }
}

/** Keep public-site navigation in the current tab while opening actual
 * off-site HTTP(S) anchors in a separate, opener-isolated tab.
 * @param {string} html */
function openExternalLinksInNewTab(html) {
  return html.replace(/<a\b[^>]*>/gi, (/** @type {string} */ tag) => {
    const attributes = new Map(parseTagAttributes(tag.slice(2, -1)).map((attribute) => [attribute.name, attribute.value]))
    const href = (attributes.get("href") ?? "").trim()
    if (!/^(?:https?:)?\/\//i.test(href)) return tag
    const rel = new Set((attributes.get("rel") ?? "").split(/\s+/).filter(Boolean).map((token) => token.toLowerCase()))
    rel.add("noopener")
    rel.add("noreferrer")
    return setHtmlTagAttribute(setHtmlTagAttribute(tag, "target", "_blank"), "rel", [...rel].join(" "))
  })
}

/** @param {string} html */
function htmlStartTags(html) {
  /** @type {Array<{name:string,attributes:Array<{name:string,value:string}>,rawText:string}>} */
  const tags = []
  let cursor = 0
  while (cursor < html.length) {
    const open = html.indexOf("<", cursor)
    if (open < 0) break
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4)
      cursor = close < 0 ? html.length : close + 3
      continue
    }
    const nameMatch = /^<([A-Za-z][A-Za-z0-9:-]*)\b/.exec(html.slice(open))
    if (!nameMatch) { cursor = open + 1; continue }
    let end = open + nameMatch[0].length
    let quote = ""
    for (; end < html.length; end += 1) {
      const character = html[end]
      if (quote) { if (character === quote) quote = ""; continue }
      if (character === "\"" || character === "'") quote = character
      else if (character === ">") break
    }
    if (end >= html.length) break
    const name = nameMatch[1].toLowerCase()
    const attributeSource = html.slice(open + nameMatch[0].length, end)
    let rawText = ""
    cursor = end + 1
    if (name === "style" || name === "script") {
      const closePattern = new RegExp(`</${name}\\s*>`, "ig")
      closePattern.lastIndex = cursor
      const close = closePattern.exec(html)
      rawText = html.slice(cursor, close?.index ?? html.length)
      cursor = close ? closePattern.lastIndex : html.length
    }
    tags.push({ name, attributes: parseTagAttributes(attributeSource), rawText })
  }
  return tags
}

/** Remove CSS comments only outside quoted strings so comments retain their
 * grammar role as whitespace without changing literal URL bytes. @param {string} css */
function cssWithoutComments(css) {
  let normalized = ""
  let quote = ""
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index]
    if (quote) {
      normalized += character
      if (character === "\\" && index + 1 < css.length) normalized += css[++index]
      else if (character === quote) quote = ""
      continue
    }
    if (character === "\"" || character === "'") { quote = character; normalized += character; continue }
    if (character === "/" && css[index + 1] === "*") {
      const close = css.indexOf("*/", index + 2)
      normalized += " "
      index = close < 0 ? css.length : close + 1
      continue
    }
    normalized += character
  }
  return normalized
}

/** Parse the bounded CSS resource grammar needed by the publication gate. CSS
 * escapes in resource tokens or identifiers fail closed instead of being
 * decoded locally. @param {string} css */
function cssResourceReferences(css) {
  const source = cssWithoutComments(css)
  const lower = source.toLowerCase()
  const urls = []
  const imports = []
  let unsafe = false
  const whitespace = (/** @type {string} */ character) => /[\t\n\f\r ]/.test(character)
  const identifier = (/** @type {string} */ character) => /[A-Za-z0-9_-]/.test(character)
  const skipWhitespace = (/** @type {number} */ start) => {
    let cursor = start
    while (cursor < source.length && whitespace(source[cursor])) cursor += 1
    return cursor
  }
  const readString = (/** @type {number} */ start) => {
    const quote = source[start]
    let value = ""
    let escaped = false
    for (let cursor = start + 1; cursor < source.length; cursor += 1) {
      const character = source[cursor]
      if (character === quote) return { value, end: cursor + 1, escaped, closed: true }
      if (character === "\\") {
        escaped = true
        if (cursor + 1 < source.length) value += character + source[++cursor]
        continue
      }
      value += character
    }
    unsafe = true
    return { value, end: source.length, escaped, closed: false }
  }
  const readUrlFunction = (/** @type {number} */ start) => {
    let cursor = skipWhitespace(start + 3)
    if (source[cursor] !== "(") return null
    cursor = skipWhitespace(cursor + 1)
    let value = ""
    let escaped = false
    if (source[cursor] === "\"" || source[cursor] === "'") {
      const token = readString(cursor)
      value = token.value
      escaped = token.escaped
      cursor = skipWhitespace(token.end)
    } else {
      const valueStart = cursor
      while (cursor < source.length && source[cursor] !== ")") {
        if (source[cursor] === "\\") escaped = true
        if (source[cursor] === "\"" || source[cursor] === "'") unsafe = true
        cursor += 1
      }
      value = source.slice(valueStart, cursor).trim()
    }
    if (escaped && !/^data:/i.test(value.trim())) unsafe = true
    if (source[cursor] !== ")") unsafe = true
    else cursor += 1
    return { value, end: cursor }
  }
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === "\"" || character === "'") {
      index = readString(index).end - 1
      continue
    }
    if (character === "\\") continue
    if (lower.startsWith("@import", index) && !identifier(source[index + 7] ?? "")) {
      let cursor = skipWhitespace(index + 7)
      if (source[cursor] === "\"" || source[cursor] === "'") {
        const token = readString(cursor)
        if (token.escaped || !token.closed) unsafe = true
        imports.push(token.value.trim())
        index = token.end - 1
        continue
      }
      if (lower.startsWith("url", cursor) && !identifier(source[cursor + 3] ?? "")) {
        const token = readUrlFunction(cursor)
        if (!token) { unsafe = true; continue }
        imports.push(token.value.trim())
        index = token.end - 1
        continue
      }
      unsafe = true
      continue
    }
    if (lower.startsWith("url", index) && !identifier(source[index - 1] ?? "") && !identifier(source[index + 3] ?? "")) {
      const token = readUrlFunction(index)
      if (!token) continue
      urls.push(token.value.trim())
      index = token.end - 1
    }
  }
  return { urls, imports, unsafe }
}

/** @param {string} css */
function cssImportUrls(css) { return cssResourceReferences(css).imports }

/** @param {string} css */
function cssUrls(css) { return cssResourceReferences(css).urls }

/** @param {string} raw @param {string} baseRoute @param {Set<string>} approvedRoutes @param {Set<string>} expectedAssets @param {boolean} assetContext */
function validateCandidateUrl(raw, baseRoute, approvedRoutes, expectedAssets, assetContext) {
  const value = decodeHtmlAttribute(raw).trim()
  if (!value || value.startsWith("#")) return
  const compactValue = value.replace(/[\u0000-\u0020]+/g, "")
  const unsafeScheme = /^(javascript|vbscript|data|file)\s*:/i.exec(compactValue)?.[1]?.toLowerCase()
  if (unsafeScheme) {
    throw new TracerError("CANDIDATE_UNSAFE_SCHEME", `candidate contains an unsafe URL scheme (${baseRoute}: ${unsafeScheme})`)
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)?.[1]?.toLowerCase()
  if (scheme) {
    if (["http", "https", "mailto", "tel"].includes(scheme)) return
    throw new TracerError("CANDIDATE_UNSAFE_SCHEME", "candidate contains a URL scheme outside the public policy")
  }
  if (value.startsWith("//")) return
  let resolved
  try { resolved = new URL(value, `https://example.invalid${baseRoute}`) } catch { throw new TracerError("CANDIDATE_LINK_INVALID", "candidate contains an invalid URL-bearing attribute") }
  const pathname = resolved.pathname
  if (approvedRoutes.has(pathname) || expectedAssets.has(pathname)) return
  if (assetContext || /\.[A-Za-z0-9]{1,12}$/.test(pathname)) throw new TracerError("CANDIDATE_ASSET_MISSING", "candidate references an asset outside the immutable Quartz baseline")
  throw new TracerError("CANDIDATE_UNAPPROVED_LINK", "candidate contains an unapproved internal target")
}

/** @param {string} css @param {string} baseRoute @param {Set<string>} approvedRoutes @param {Set<string>} expectedAssets */
function validateCandidateCss(css, baseRoute, approvedRoutes, expectedAssets) {
  const references = cssResourceReferences(css)
  if (references.unsafe) throw new TracerError("CANDIDATE_UNSAFE_SCHEME", "candidate CSS contains an escaped or malformed resource token")
  for (const value of references.urls) {
    if (/^data\s*:/i.test(value)) continue
    validateCandidateUrl(value, baseRoute, approvedRoutes, expectedAssets, true)
  }
}

/** @param {string} html @param {string} route @param {Set<string>} approvedRoutes @param {Set<string>} expectedAssets */
function validateCandidateHtml(html, route, approvedRoutes, expectedAssets) {
  const urlAttributes = new Set(["href", "src", "poster", "action", "formaction"])
  for (const tag of htmlStartTags(html)) {
    const attributes = new Map(tag.attributes.map((attribute) => [attribute.name, attribute.value]))
    if (tag.attributes.some((attribute) => attribute.name.startsWith("on"))) throw new TracerError("CANDIDATE_EVENT_ATTRIBUTE", "candidate HTML contains an inline event attribute")
    if (tag.name === "meta" && (attributes.get("http-equiv") ?? "").trim().toLowerCase() === "refresh") throw new TracerError("CANDIDATE_META_REFRESH", "candidate HTML contains meta refresh")
    if (tag.name === "a" && /^(?:https?:)?\/\//i.test((attributes.get("href") ?? "").trim())) {
      const rel = new Set((attributes.get("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean))
      if ((attributes.get("target") ?? "").toLowerCase() !== "_blank" || !rel.has("noopener") || !rel.has("noreferrer")) {
        throw new TracerError("CANDIDATE_EXTERNAL_LINK_INVALID", "candidate external links must open in an opener-isolated new tab")
      }
    }
    for (const { name, value } of tag.attributes) {
      if (name === "style") validateCandidateCss(value, route, approvedRoutes, expectedAssets)
      if (name === "srcset") {
        for (const candidate of value.split(",")) validateCandidateUrl(candidate.trim().split(/\s+/)[0] ?? "", route, approvedRoutes, expectedAssets, true)
      } else if (urlAttributes.has(name) || (tag.name === "object" && name === "data")) {
        const assetContext = name === "poster" || (name === "src" && /^(?:img|script|audio|video|source|track|input)$/.test(tag.name)) || (name === "href" && tag.name === "link") || (tag.name === "object" && name === "data")
        validateCandidateUrl(value, route, approvedRoutes, expectedAssets, assetContext)
      }
    }
    if (tag.name === "style") validateCandidateCss(tag.rawText, route, approvedRoutes, expectedAssets)
  }
}

/** Fixed T04 boundary captured before the immutable baseline. It excludes
 * deferred index/search/graph artifacts and actual external resource loads. */
async function validateT04Prebaseline(/** @type {string} */ candidate, /** @type {string} */ run) {
  const files = await listRegularTree(candidate, run)
  const forbiddenArtifact = /^(?:sitemap\.xml|index\.xml)$/i
  const deferredArtifact = /(?:^|\/)(?:graph|search)(?:[-_.][^/]*)?\.json$/i
  const ownedPublicData = new Set(["graph.json", "search-index.json", "static/contentIndex.json"])
  const external = (/** @type {string} */ value) => /^(?:https?:)?\/\//i.test(decodeHtmlAttribute(value).trim())
  const loadedCss = new Set()
  /** @param {string} css @param {string} base */
  const trackLocalImports = (css, base) => {
    const references = cssResourceReferences(css)
    if (references.unsafe) throw new TracerError("T04_BOUNDARY_VIOLATION", `candidate CSS contains an escaped or malformed resource token (${new URL(base).pathname})`)
    for (const href of references.imports) {
      if (external(href)) continue
      try { loadedCss.add(decodeURIComponent(new URL(href, base).pathname).replace(/^\//, "")) } catch {}
    }
  }
  for (const file of files) {
    if (!file.relative.endsWith(".html")) continue
    const base = `https://example.invalid/${file.relative}`
    for (const tag of htmlStartTags(file.bytes.toString("utf8"))) {
      const attributes = new Map(tag.attributes.map((attribute) => [attribute.name, attribute.value]))
      const inlineStyle = attributes.get("style") ?? ""
      const inlineReferences = cssResourceReferences(inlineStyle)
      if (inlineReferences.unsafe || inlineReferences.urls.some(external) || inlineReferences.imports.some(external)) {
        throw new TracerError("T04_BOUNDARY_VIOLATION", "candidate inline style loads an external network resource")
      }
      if (tag.name === "style") {
        const styleReferences = cssResourceReferences(tag.rawText)
        if (styleReferences.unsafe || styleReferences.urls.some(external) || styleReferences.imports.some(external)) {
          throw new TracerError("T04_BOUNDARY_VIOLATION", "candidate style block loads an external network resource")
        }
        trackLocalImports(tag.rawText, base)
      }
      if (tag.name !== "link") continue
      if (!(attributes.get("rel") ?? "").split(/\s+/).includes("stylesheet")) continue
      const href = attributes.get("href") ?? ""
      if (!external(href)) {
        try { loadedCss.add(decodeURIComponent(new URL(href, base).pathname).replace(/^\//, "")) } catch {}
      }
    }
  }
  const filesByRelative = new Map(files.map((file) => [file.relative, file]))
  const scannedImports = new Set()
  while ([...loadedCss].some((relative) => !scannedImports.has(relative))) {
    const relative = [...loadedCss].find((candidate) => !scannedImports.has(candidate))
    if (relative === undefined) break
    scannedImports.add(relative)
    const file = filesByRelative.get(relative)
    if (!file) continue
    const css = file.bytes.toString("utf8")
    trackLocalImports(css, `https://example.invalid/${relative}`)
  }
  for (const file of files) {
    if (forbiddenArtifact.test(file.relative) || (deferredArtifact.test(file.relative) && !ownedPublicData.has(file.relative))) {
      throw new TracerError("T04_BOUNDARY_VIOLATION", "candidate contains a non-owned index, graph, or search artifact")
    }
    if (file.relative.endsWith(".css") && loadedCss.has(file.relative)) {
      const css = file.bytes.toString("utf8")
      const references = cssResourceReferences(css)
      const externalUrls = references.urls.filter(external)
      const externalImport = references.imports.find(external)
      if (references.unsafe || externalUrls.length > 0 || externalImport) {
        const resource = externalUrls[0] ?? externalImport
        throw new TracerError("T04_BOUNDARY_VIOLATION", `candidate CSS loads an external or ambiguous network resource (${file.relative}${resource ? `: ${resource}` : ""})`)
      }
    }
    if (!file.relative.endsWith(".html")) continue
    const html = file.bytes.toString("utf8")
    for (const tag of htmlStartTags(html)) {
      const attributes = new Map(tag.attributes.map((attribute) => [attribute.name, attribute.value]))
      const resourceAttribute = tag.name === "object" ? "data" : tag.name === "link" ? "href" : /^(?:script|img|iframe|source|video|audio|track|embed|input)$/.test(tag.name) ? "src" : null
      if (resourceAttribute && external(attributes.get(resourceAttribute) ?? "")) {
        throw new TracerError("T04_BOUNDARY_VIOLATION", "candidate HTML loads an external network resource")
      }
      if (tag.name === "script" && /(?:fetch|importScripts|import)\s*\([^)]{0,160}["'](?:https?:)?\/\//i.test(tag.rawText)) {
        throw new TracerError("T04_BOUNDARY_VIOLATION", "candidate script imports an external network resource")
      }
      if (tag.name === "script" && /Math\.random\s*\(/.test(tag.rawText)) {
        throw new TracerError("T04_BOUNDARY_VIOLATION", "candidate graph/runtime script uses nondeterministic random layout initialization")
      }
      if (tag.name === "script" && /(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|pixi(?:\.min)?\.js)/i.test(tag.rawText)) {
        throw new TracerError("T04_BOUNDARY_VIOLATION", "candidate graph/runtime script references a forbidden vendor CDN")
      }
    }
  }
}

/** @param {string} candidate @param {string} run @param {string} variant */
async function injectPrebaselineRegression(candidate, run, variant) {
  await assertCandidateRoot(candidate, run)
  const index = path.join(candidate, "index.html")
  const html = await readFile(index, "utf8")
  if (variant === "percent-double-encoded-suppressed-target") {
    await writeFile(index, html.replace(/<\/body>/i, "<p>%ZZ Private%252FHidden%252DNeuron</p></body>"))
    return
  }
  if (variant === "percent-four-layer-suppressed-target") {
    await writeFile(index, html.replace(/<\/body>/i, "<p>Private%2525252FHidden-Neuron</p></body>"))
    return
  }
  if (variant === "html-four-layer-suppressed-target") {
    await writeFile(index, html.replace(/<\/body>/i, "<p>Private&amp;amp;amp;#x2f;Hidden-Neuron</p></body>"))
    return
  }
  if (variant === "percent-four-layer-full-suppressed-target") {
    await writeFile(index, html.replace(/<\/body>/i, "<p>Private%2525252FHidden%2525252DNeuron</p></body>"))
    return
  }
  if (variant === "html-four-layer-full-suppressed-target") {
    await writeFile(index, html.replace(/<\/body>/i, "<p>Private&amp;amp;amp;#x2f;Hidden&amp;amp;amp;#x2d;Neuron</p></body>"))
    return
  }
  if (variant === "percent-disclosure-depth-cap") {
    let deeplyEncodedSeparator = "%2F"
    let deeplyEncodedHyphen = "%2D"
    for (let depth = 0; depth < 300; depth += 1) {
      deeplyEncodedSeparator = deeplyEncodedSeparator.replaceAll("%", "%25")
      deeplyEncodedHyphen = deeplyEncodedHyphen.replaceAll("%", "%25")
    }
    await writeFile(index, html.replace(/<\/body>/i, `<p>Private${deeplyEncodedSeparator}Hidden${deeplyEncodedHyphen}Neuron</p></body>`))
    return
  }
  if (variant === "public-data-empty-title") {
    const graphPath = path.join(candidate, "graph.json")
    const graph = JSON.parse(await readFile(graphPath, "utf8"))
    graph.nodes[0].title = ""
    await writeFile(graphPath, `${JSON.stringify(graph)}\n`)
    return
  }
  if (["vendor-slug-keyed-search", "broad-search-record", "extra-virtual-search-record"].includes(variant)) {
    const searchPaths = [path.join(candidate, "search-index.json"), path.join(candidate, "static", "contentIndex.json")]
    let search = JSON.parse(await readFile(searchPaths[0], "utf8"))
    if (variant === "vendor-slug-keyed-search") {
      search = Object.fromEntries(search.records.map((/** @type {any} */ record) => [record.url.replace(/^\/+|\/+$/g, ""), { title: record.title, content: record.search_text }]))
    } else if (variant === "broad-search-record") {
      search.records[0].slug = search.records[0].url.replace(/^\/+|\/+$/g, "")
      search.records[0].content = search.records[0].search_text
    } else {
      search.records.push({
        public_id: "virtual-folder", title: "Virtual Folder", node_class: "concept", url: "/knowledge/concept/virtual-folder/",
        authors: [], doi: null, source_tags: [], search_text: "virtual folder",
      })
    }
    await Promise.all(searchPaths.map((target) => writeFile(target, `${JSON.stringify(search)}\n`)))
    return
  }
  if (variant === "graph-math-random") {
    await writeFile(index, html.replace(/<\/body>/i, '<script data-vendor-graph-layout>const x=Math.random()</script></body>'))
    return
  }
  if (variant === "external-script") {
    await writeFile(index, html.replace(/<\/body>/i, '<script src="https://example.invalid/t04-boundary.js"></script></body>'))
    return
  }
  if (variant === "commented-css-import") {
    const staticRoot = path.join(candidate, "static")
    await mkdir(staticRoot, { recursive: true })
    await writeFile(path.join(staticRoot, "t04-boundary-root.css"), '@import /* valid CSS whitespace */ url("t04-boundary-nested.css");\n')
    await writeFile(path.join(staticRoot, "t04-boundary-nested.css"), 'body { background-image: url("https://external.test/leak.png"); }\n')
    await writeFile(index, html.replace(/<\/head>/i, '<link rel="stylesheet" href="/static/t04-boundary-root.css"></head>'))
    return
  }
  if (variant === "spaced-css-import") {
    const staticRoot = path.join(candidate, "static")
    await mkdir(staticRoot, { recursive: true })
    await writeFile(path.join(staticRoot, "t04-boundary-spaced-root.css"), '@import "t04-boundary nested.css";\n')
    await writeFile(path.join(staticRoot, "t04-boundary nested.css"), 'body { background-image: url("https://external.test/spaced-leak.png"); }\n')
    await writeFile(index, html.replace(/<\/head>/i, '<link rel="stylesheet" href="/static/t04-boundary-spaced-root.css"></head>'))
    return
  }
  if (variant === "escaped-css-scheme") {
    const staticRoot = path.join(candidate, "static")
    await mkdir(staticRoot, { recursive: true })
    await writeFile(path.join(staticRoot, "t04-boundary-escaped.css"), 'body { background-image: url("https\\3a //external.test/escaped-leak.png"); }\n')
    await writeFile(index, html.replace(/<\/head>/i, '<link rel="stylesheet" href="/static/t04-boundary-escaped.css"></head>'))
    return
  }
  throw new TracerError("TEST_INJECTION_INVALID", "prebaseline regression injection is not a fixed supported variant")
}


/** @param {string} candidate @param {string} run @param {string} variant */
async function injectCandidateRegression(candidate, run, variant) {
  await assertCandidateRoot(candidate, run)
  if (variant === "candidate-root-junction") {
    const target = path.join(run, "candidate-root-target")
    await rename(candidate, target)
    await symlink(target, candidate, process.platform === "win32" ? "junction" : "dir")
    return
  }
  const index = path.join(candidate, "index.html")
  const snippets = new Map([
    ["event-attribute", "<div onpointerenter=\"alert(1)\">event</div>"],
    ["poster-private", "<video poster=\"/unapproved-fixture/poster.png\"></video>"],
    ["srcset-missing", "<img srcset=\"/static/icon.png 1x, /static/unexpected.png 2x\">"],
    ["form-action-private", "<form action=\"/unapproved-fixture/form/\"><button formaction=\"/unapproved-fixture/submit/\">submit</button></form>"],
    ["object-data-private", "<object data=\"/unapproved-fixture/object.bin\"></object>"],
    ["meta-refresh", "<meta http-equiv=\"refresh\" content=\"0; url=/unapproved-fixture/refresh/\">"],
    ["css-url-missing", "<style>body{background-image:url('/static/unexpected.png')}</style>"],
    ["unsafe-attribute-scheme", "<a href=\"javascript:alert(1)\">unsafe</a>"],
    ["zotero-scheme-disclosure", "<p>zotero://select/library/items/OPAQUE123</p>"],
  ])
  if (variant === "virtual-parent-tamper") {
    await writeFile(path.join(candidate, "knowledge", "index.html"), "<!doctype html><title>tampered virtual parent</title>")
  } else if (variant === "unexpected-asset") {
    await mkdir(path.join(candidate, "static"), { recursive: true })
    await writeFile(path.join(candidate, "static", "unexpected.js"), "console.log('not in Quartz baseline')\n", { flag: "wx" })
  } else if (variant === "extra-html") {
    await mkdir(path.join(candidate, "malicious-extra"), { recursive: true })
    await writeFile(path.join(candidate, "malicious-extra", "index.html"), "<!doctype html><title>must be rejected</title>", { flag: "wx" })
  } else if (snippets.has(variant)) {
    const html = await readFile(index, "utf8")
    await writeFile(index, html.replace(/<\/body>/i, `${snippets.get(variant)}</body>`))
  } else throw new TracerError("TEST_INJECTION_INVALID", "candidate regression injection is not a fixed supported variant")
}

/** Repair the pinned Quartz v5 ToC component's mismatched aria-controls value
 * before the immutable candidate baseline is captured. Only the control ID is
 * changed; the generated list ID, content, and vendor assets remain untouched.
 * @param {string} candidate @param {string} run */
async function repairTocAccessibility(candidate, run) {
  await assertCandidateRoot(candidate, run)
  const htmlFiles = (await listRegularTree(candidate, run)).filter((file) => file.relative.endsWith(".html"))
  for (const file of htmlFiles) {
    const html = file.bytes.toString("utf8")
    let tocIndex = 0
    const repaired = html.replace(
      /<button\b(?=[^>]*\bclass="[^"]*\btoc-header\b)(?=[^>]*\baria-controls=")[^>]*>[\s\S]*?<\/button>\s*<ul\b(?=[^>]*\bclass="[^"]*\btoc-content\b)[^>]*>/g,
      (relationship) => {
        const id = `tracer-toc-${tocIndex++}`
        return relationship
          .replace(/\baria-controls="[^"]+"/, `aria-controls="${id}"`)
          .replace(/<button\b/, '<button aria-label="Open Table of Contents"')
          .replace(/(<ul\b[^>]*\b)id="[^"]+"/, `$1id="${id}"`)
          .replace(/<\/button>\s*(<ul\b)/, '</button><h2 class="toc-panel-title">Table of Contents</h2>$1')
      },
    )
    const ids = [...repaired.matchAll(/(?:^|\s)id="([^"]+)"/g)].map((match) => match[1])
    if (new Set(ids).size !== ids.length) throw new TracerError("CANDIDATE_DUPLICATE_ID", "generated page contains duplicate element IDs")
    const idSet = new Set(ids)
    for (const tag of repaired.matchAll(/<button\b(?=[^>]*\bclass="[^"]*\btoc-header\b)[^>]*>/g)) {
      const target = /\baria-controls="([^"]+)"/.exec(tag[0])?.[1]
      if (!target || !idSet.has(target)) throw new TracerError("CANDIDATE_TOC_CONTROL_INVALID", "generated table-of-contents control target is missing")
    }
    if (repaired !== html) await writeFile(file.absolute, repaired)
  }
}

const tracerCsp = "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self' data:; frame-src 'none'; img-src 'self' data:; media-src 'self'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; form-action 'none'"
const tracerCspMeta = `<meta http-equiv="Content-Security-Policy" content="${tracerCsp}">`

/** Install the browser-enforced no-external-network boundary before the
 * immutable baseline. The meta is first in head so it governs later resources.
 * @param {string} candidate @param {string} run */
async function installNetworkCsp(candidate, run) {
  await assertCandidateRoot(candidate, run)
  const htmlFiles = (await listRegularTree(candidate, run)).filter((file) => file.relative.endsWith(".html"))
  for (const file of htmlFiles) {
    const html = file.bytes.toString("utf8")
    if (/http-equiv=["']Content-Security-Policy["']/i.test(html)) throw new TracerError("CANDIDATE_CSP_INVALID", "generated page already contains a content security policy")
    const secured = html.replace(/<head\b[^>]*>/i, (head) => `${head}${tracerCspMeta}`)
    if (secured === html) throw new TracerError("CANDIDATE_CSP_INVALID", "generated page is missing its head element")
    await writeFile(file.absolute, secured)
  }
}

/** Decode each maximal run of syntactically valid percent octets without
 * allowing a malformed literal such as %ZZ (or an invalid UTF-8 octet) to
 * suppress decoding of neighboring valid escapes. */
function decodeValidPercentRuns(/** @type {string} */ value) {
  return value.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    const octets = run.match(/%[0-9a-f]{2}/gi) ?? []
    let decoded = ""
    for (let index = 0; index < octets.length;) {
      const first = Number.parseInt(octets[index].slice(1), 16)
      const width = first <= 0x7f ? 1
        : first >= 0xc2 && first <= 0xdf ? 2
          : first >= 0xe0 && first <= 0xef ? 3
            : first >= 0xf0 && first <= 0xf4 ? 4
              : 0
      if (width > 0 && index + width <= octets.length) {
        const encoded = octets.slice(index, index + width).join("")
        try {
          decoded += decodeURIComponent(encoded)
          index += width
          continue
        } catch {}
      }
      decoded += octets[index]
      index += 1
    }
    return decoded
  })
}

const disclosureVariantLimit = 256
const disclosureProcessedCharLimit = 8 * 1024 * 1024

/** Close percent and HTML decoding under composition. Every newly discovered
 * representation is queued exactly once; bounded accounting rejects hostile
 * encoding depth instead of treating an incomplete scan as clean. */
function disclosureComparables(/** @type {string} */ value) {
  const seen = new Set([value])
  const queue = [value]
  const comparables = []
  let processedChars = 0
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const candidate = queue[cursor]
    processedChars += candidate.length
    if (processedChars > disclosureProcessedCharLimit) {
      throw new TracerError("CANDIDATE_DISCLOSURE_DEPTH_EXCEEDED", "candidate disclosure decoding exceeded its safety limit")
    }
    comparables.push(candidate.replace(/\\/g, "/").toLowerCase())
    for (const transformed of [decodeValidPercentRuns(candidate), decodeHtmlAttribute(candidate)]) {
      if (seen.has(transformed)) continue
      if (seen.size >= disclosureVariantLimit) {
        throw new TracerError("CANDIDATE_DISCLOSURE_DEPTH_EXCEEDED", "candidate disclosure decoding exceeded its safety limit")
      }
      seen.add(transformed)
      queue.push(transformed)
    }
  }
  return comparables
}

let publicDataValidatorsPromise

async function publicDataValidators() {
  publicDataValidatorsPromise ??= (async () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true })
    const [graphSchema, searchSchema] = await Promise.all([
      readFile(path.join(repoRoot, "schemas", "public-graph-v1.schema.json"), "utf8"),
      readFile(path.join(repoRoot, "schemas", "search-index-v1.schema.json"), "utf8"),
    ])
    return {
      graph: ajv.compile(JSON.parse(graphSchema)),
      search: ajv.compile(JSON.parse(searchSchema)),
    }
  })()
  return publicDataValidatorsPromise
}

async function validatePublicDataStructure(/** @type {Array<{relative:string,bytes:Buffer}>} */ files) {
  const invalid = (/** @type {string} */ message) => new TracerError("CANDIDATE_PUBLIC_DATA_INVALID", message)
  const byPath = new Map(files.map((file) => [file.relative, file]))
  const parseExact = (/** @type {string} */ relative) => {
    const file = byPath.get(relative)
    if (!file) throw invalid("candidate is missing a required public data artifact")
    const text = file.bytes.toString("utf8")
    let value
    try { value = JSON.parse(text) } catch { throw invalid("candidate public data is not JSON") }
    if (text !== `${JSON.stringify(value)}\n`) throw invalid("candidate public data is not compact UTF-8 JSON plus LF")
    return value
  }
  const graph = parseExact("graph.json")
  const search = parseExact("search-index.json")
  const contentIndex = parseExact("static/contentIndex.json")
  if (JSON.stringify(search) !== JSON.stringify(contentIndex)) throw invalid("fetchData index differs from public search index")

  let validators
  try { validators = await publicDataValidators() } catch { throw invalid("normative public data schemas could not be applied") }
  if (!validators.graph(graph) || !validators.search(search)) throw invalid("candidate public data fails its normative schema")

  if (JSON.stringify(Object.keys(graph)) !== JSON.stringify(["schema_version", "nodes", "edges"])) throw invalid("graph contract key order is invalid")
  if (JSON.stringify(Object.keys(search)) !== JSON.stringify(["schema_version", "records"])) throw invalid("search contract key order is invalid")

  const ids = new Set()
  let previousId = null
  for (const node of graph.nodes) {
    if (JSON.stringify(Object.keys(node)) !== JSON.stringify(["public_id", "title", "node_class", "url"])
      || ids.has(node.public_id)
      || (previousId !== null && Buffer.compare(Buffer.from(previousId), Buffer.from(node.public_id)) >= 0)) {
      throw invalid("graph node identity, key order, uniqueness, or ordering is invalid")
    }
    ids.add(node.public_id)
    previousId = node.public_id
  }

  let previousEdge = null
  for (const edge of graph.edges) {
    const key = `${edge.source}\0${edge.target}`
    if (JSON.stringify(Object.keys(edge)) !== JSON.stringify(["source", "target"])
      || !ids.has(edge.source)
      || !ids.has(edge.target)
      || (previousEdge !== null && Buffer.compare(Buffer.from(previousEdge), Buffer.from(key)) >= 0)) {
      throw invalid("graph edge key order, uniqueness, ordering, or closure is invalid")
    }
    previousEdge = key
  }

  if (search.records.length !== graph.nodes.length) throw invalid("graph and search public ID sets differ")
  previousId = null
  for (let index = 0; index < search.records.length; index += 1) {
    const record = search.records[index]
    const node = graph.nodes[index]
    if (JSON.stringify(Object.keys(record)) !== JSON.stringify(["public_id", "title", "node_class", "url", "authors", "year", "doi", "source_tags", "definition", "search_text"])
      || record.public_id !== node.public_id
      || record.title !== node.title
      || record.node_class !== node.node_class
      || record.url !== node.url
      || (previousId !== null && Buffer.compare(Buffer.from(previousId), Buffer.from(record.public_id)) >= 0)) {
      throw invalid("graph and search record identity closure is invalid")
    }
    const sortedTags = [...new Set(record.source_tags)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    if (JSON.stringify(record.source_tags) !== JSON.stringify(sortedTags)) throw invalid("search source tags are not unique and UTF-8 sorted")
    previousId = record.public_id
  }
}

/** @param {string} candidate @param {string} run @param {Map<string,{route:string,node:{node_class:string}}>} records @param {Set<string>} suppressedTargets @param {string[]} privatePaths @param {ReadonlyArray<{relative:string,fileClass:string,sha256:string}>} baseline @param {Awaited<ReturnType<typeof readSecretRules>>} secretRules @param {{entryFile:string,custom404:string}} deploymentFiles @param {boolean} [retainCustom404] */
async function gateCandidate(candidate, run, records, suppressedTargets, privatePaths, baseline, secretRules, deploymentFiles, retainCustom404 = false) {
  await assertCandidateRoot(candidate, run)
  if (testHook("TYLER_TRACER_TEST_GATE_FAILURE") === "1") throw new TracerError("CANDIDATE_GATE_FAILED", "candidate gate test injection")
  const files = await listRegularTree(candidate, run)
  for (const file of files) {
    if (/\.(?:md|pdf)$/i.test(file.relative)
      || /(?:^|\/)(?:runtime|work)(?:[._-][^/]*)?$/i.test(file.relative)) {
      throw new TracerError("CANDIDATE_FORBIDDEN_FILE", "candidate contains a forbidden public file")
    }
    const authenticatedProjectAsset = authenticateProjectAsset(file.relative, file.bytes)
    if (!authenticatedProjectAsset) {
      if (containsZoteroSchemeDisclosure(file.bytes.toString("utf8"))) throw new TracerError("CANDIDATE_UNSAFE_SCHEME", "candidate contains a Zotero local URL disclosure", { file: file.relative })
      const finding = secretFinding(file.bytes, file.relative, secretRules, privatePaths)
      if (finding === "absolute-path") throw new TracerError("CANDIDATE_ABSOLUTE_PATH_DISCLOSURE", "candidate contains an absolute local path")
      if (finding) throw new TracerError("CANDIDATE_SECRET_DISCLOSURE", "candidate contains credential-shaped bytes")
    }
  }
  await validatePublicDataStructure(files)
  const html = files.filter((file) => file.relative.endsWith(".html")).map((file) => file.relative)
  const expectedHtml = [...(retainCustom404 ? [deploymentFiles.custom404] : []), deploymentFiles.entryFile, ...[...records.values()].map((record) => quartzContentRouteFile(record.route))].sort()
  if (JSON.stringify(html.sort()) !== JSON.stringify(expectedHtml)) throw new TracerError("CANDIDATE_ROUTE_SET_INVALID", "candidate HTML route set is not exact", { actual: html.sort(), expected: expectedHtml })
  const approvedRoutes = new Set(["/", ...[...records.values()].map((record) => record.route)])
  const custom404Routes = new Set([...approvedRoutes].map((route) => `${projectSiteBasePath}${route.slice(1)}`))
  const virtual = virtualHtmlPaths(records, deploymentFiles, retainCustom404)
  const expectedFinal = baseline.filter((row) => !virtual.has(row.relative))
  const expectedAssets = new Set(expectedFinal.filter((row) => !row.relative.endsWith(".html")).map((row) => `/${row.relative}`))
  const custom404Assets = new Set([...expectedAssets].map((asset) => `${projectSiteBasePath}${asset.slice(1)}`))
  const contentHtml = new Set([...records.values()].map((record) => quartzContentRouteFile(record.route)))
  for (const file of files) {
    if (file.relative.endsWith(".html")) {
      const pageHtml = file.bytes.toString("utf8")
      if (pageHtml.split(tracerCspMeta).length - 1 !== 1) throw new TracerError("CANDIDATE_CSP_INVALID", "candidate page lacks its exact unique content security policy")
      if (contentHtml.has(file.relative)) {
        const record = [...records.values()].find((candidateRecord) => `${candidateRecord.route.slice(1)}index.html` === file.relative)
        const template = record?.node?.node_class === "paper" ? "paper" : "support"
        if (!new RegExp(`<body\\b[^>]*\\bdata-tracer-template="${template}"`).test(pageHtml)) {
          throw new TracerError("CANDIDATE_TEMPLATE_MARKER_INVALID", "candidate content route lacks its renderer-owned template marker")
        }
      }
      const route = generatedHtmlRoute(file.relative, deploymentFiles)
      const custom404 = file.relative === deploymentFiles.custom404
      validateCandidateHtml(pageHtml, route, custom404 ? custom404Routes : approvedRoutes, custom404 ? custom404Assets : expectedAssets)
    } else if (file.relative.endsWith(".css")) validateCandidateCss(file.bytes.toString("utf8"), `/${file.relative}`, approvedRoutes, expectedAssets)
  }
  const actualManifest = files.map((file) => ({ relative: file.relative, fileClass: "regular-file", sha256: sha256(file.bytes) }))
  if (JSON.stringify(actualManifest) !== JSON.stringify(expectedFinal)) throw new TracerError("CANDIDATE_FILE_MANIFEST_MISMATCH", "candidate files differ from the immutable post-Quartz baseline")
  for (const file of files) {
    if (authenticateProjectAsset(file.relative, file.bytes)) continue
    const text = file.bytes.toString("utf8")
    const forbiddenDisclosure = file.relative.endsWith(".html") ? /\.md\b|\.pdf\b/i.exec(text) : null
    if (forbiddenDisclosure) throw new TracerError("CANDIDATE_FORBIDDEN_DISCLOSURE", "candidate contains forbidden source metadata", { file: file.relative, token: forbiddenDisclosure[0].toLowerCase() })
    const structurallyValidatedText = /\.(?:html|json|css|js|map)$/i.test(file.relative)
    if (!structurallyValidatedText && /(?:javascript|vbscript|data|file)\s*:/i.test(text)) throw new TracerError("CANDIDATE_UNSAFE_SCHEME", "candidate contains an unsafe URL scheme", { file: file.relative })
    const disclosureForms = disclosureComparables(text)
    if ([...suppressedTargets].some((target) => target && disclosureForms.some((form) => form.includes(target.replace(/\\/g, "/").toLowerCase())))) throw new TracerError("CANDIDATE_SUPPRESSED_TARGET_DISCLOSURE", "candidate contains suppressed target metadata")
  }
  return { files: files.length, routes: [...approvedRoutes].sort() }
}

/** @param {any} safe */
async function runRendererPipeline(safe) {
  const retainCustom404 = safe.retainCustom404 === true
  const output = safe.output
  if (typeof output !== "string") throw new TracerError("OUTPUT_REQUIRED", "build requires an output root")
  const requestedTheme = testHook("TYLER_TRACER_TEST_THEME_VARIANT")
  if (requestedTheme !== undefined && requestedTheme !== "contrast") {
    throw new TracerError("TEST_THEME_VARIANT_INVALID", "only the fixed contrast test theme is supported")
  }
  const themeVariant = requestedTheme === "contrast" ? "contrast" : "warm"
  const customTheme = scholarlyTheme(themeVariant, await readFile(scholarlyThemePath, "utf8"))
  let defaultConfig = await readFile(path.join(safe.installedRoot, "quartz.config.default.yaml"), "utf8")
  const configCase = testHook("TYLER_TRACER_TEST_CONFIG_CASE")
  if (configCase === "content-index-single-quote") {
    defaultConfig = defaultConfig.replace('source: "@quartz-community/content-index"', "source: '@quartz-community/content-index'")
  } else if (configCase?.startsWith("navigation:")) {
    const [, plugin, drift] = configCase.split(":")
    if (!["explorer", "search", "graph", "backlinks"].includes(plugin)
      || !["missing", "renamed", "schema", "enable-token"].includes(drift)) {
      throw new TracerError("TEST_INJECTION_INVALID", "navigation config regression injection is not a fixed supported variant")
    }
    const source = `source: "@quartz-community/${plugin}"`
    const enabled = `${source}\n    enabled: true`
    if (drift === "missing") defaultConfig = defaultConfig.replace(`${enabled}\n`, "")
    if (drift === "renamed") defaultConfig = defaultConfig.replace(source, `source: "@quartz-community/${plugin}-renamed"`)
    if (drift === "schema") defaultConfig = defaultConfig.replace(enabled, `enabled: true\n    ${source}`)
    if (drift === "enable-token") defaultConfig = defaultConfig.replace(`${source}\n    enabled: true`, `${source}\n    enabled: yes`)
  } else if (configCase !== undefined) throw new TracerError("TEST_INJECTION_INVALID", "config regression injection is not a fixed supported variant")
  const quartzConfig = tracerQuartzConfig(defaultConfig)
  const run = await mkdtemp(path.join(safe.workRoot, "q-"))
  try {
    const raw = path.join(run, "raw")
    const content = path.join(run, "content")
    const toolchain = path.join(run, "toolchain")
    const candidate = path.join(run, "candidate")
    const projectSiteIcon = await readFile(projectSiteIconPath)
    if (sha256(projectSiteIcon) !== projectSiteIconSha256) throw new TracerError("PROJECT_SITE_ICON_MISMATCH", "project site icon does not match the reviewed asset")
    await Promise.all([mkdir(raw), mkdir(content), mkdir(toolchain)])
    for (const [id, record] of safe.records) {
      const rawPath = path.join(raw, ...record.node.path.split("/"))
      await mkdir(path.dirname(rawPath), { recursive: true })
      await copyFile(path.join(safe.exportRoot, ...record.node.path.split("/")), rawPath, constants.COPYFILE_EXCL)
      if (!(await readFile(rawPath)).equals(record.bytes)) throw new TracerError("RAW_COPY_MISMATCH", "fresh raw input copy changed source bytes")
      const derivedPath = path.join(content, ...record.route.slice(1).split("/").filter(Boolean), "index.md")
      await mkdir(path.dirname(derivedPath), { recursive: true })
      const projected = safe.projected.get(id)
      if (!projected) throw new TracerError("UNEXPECTED_GRAPH_STATE", "projected node is missing")
      await writeFile(derivedPath, projected, { flag: "wx" })
    }
    await writeFile(path.join(content, "index.md"), homePageMarkdown(safe.records, safe.outgoing, safe.searchableBodies), { flag: "wx" })
    await Promise.all([
      cp(path.join(safe.installedRoot, "quartz"), path.join(toolchain, "quartz"), { recursive: true, errorOnExist: true, force: false }),
      copyFile(path.join(safe.installedRoot, "package.json"), path.join(toolchain, "package.json"), constants.COPYFILE_EXCL),
      copyFile(path.join(safe.installedRoot, "quartz.ts"), path.join(toolchain, "quartz.ts"), constants.COPYFILE_EXCL),
      symlink(path.join(repoRoot, "node_modules"), path.join(toolchain, "node_modules"), process.platform === "win32" ? "junction" : "dir"),
    ])
    await Promise.all([
      writeFile(path.join(toolchain, "quartz.config.yaml"), quartzConfig, { flag: "wx" }),
      writeFile(path.join(toolchain, "quartz", "styles", "custom.scss"), customTheme),
      writeFile(path.join(toolchain, "quartz", "static", "icon.png"), projectSiteIcon),
    ])
    const executable = path.join(toolchain, "quartz", "bootstrap-cli.mjs")
    const quartz = /** @type {{code:number,logs:string}} */ (await spawnCaptured(executable, ["build", "--directory", content, "--output", candidate, "--concurrency", "1"], toolchain))
    if (quartz.code !== 0) throw new TracerError("QUARTZ_BUILD_FAILED", "pinned Quartz build failed", testHook("TYLER_TRACER_TEST_DEBUG") === "1" ? { logs: quartz.logs } : {})
    await installProjectTypographyAssets(candidate, run)
    const quartzHtmlCase = testHook("TYLER_TRACER_TEST_QUARTZ_HTML_CASE")
    if (quartzHtmlCase) await injectQuartzHtmlRegression(candidate, run, quartzHtmlCase)
    await normalizeBreadcrumbRoutes(candidate, run, safe.records, safe.outgoing, safe.searchableBodies, safe.deploymentFiles)
    await normalizeCustom404BasePath(candidate, run, safe.deploymentFiles)
    await versionProjectSiteIcon(candidate, run)
    await repairTocAccessibility(candidate, run)
    await installNetworkCsp(candidate, run)
    await writePublicDataAssets(candidate, run, safe.contracts)
    const prebaselineCase = testHook("TYLER_TRACER_TEST_PREBASELINE_CASE")
    if (prebaselineCase) await injectPrebaselineRegression(candidate, run, prebaselineCase)
    await validateT04Prebaseline(candidate, run)
    // Capture the renderer baseline after the fixed privacy boundary and before
    // sanctioned virtual-page pruning.
    const baseline = await immutableCandidateManifest(candidate, run)
    assertQuartzProducesDeploymentFiles(safe.deploymentFiles, baseline)
    const renderedVariant = testHook("TYLER_TRACER_TEST_CANDIDATE_CASE")
      ?? (testHook("TYLER_TRACER_TEST_EXTRA_HTML") === "1" ? "extra-html" : undefined)
    if (renderedVariant) await injectCandidateRegression(candidate, run, renderedVariant)
    await pruneVirtualHtml(candidate, run, safe.records, baseline, safe.deploymentFiles, retainCustom404)
    await gateCandidate(candidate, run, safe.records, safe.suppressedTargets, safe.privatePaths, baseline, safe.secretRules, safe.deploymentFiles, retainCustom404)

    for (const record of safe.records.values()) {
      const source = path.join(safe.exportRoot, ...record.node.path.split("/"))
      const metadata = await lstat(source)
      const bytes = await readFile(source)
      if (!bytes.equals(record.bytes) || metadata.mtimeMs !== record.mtimeMs || sha256(bytes) !== record.node.source_sha256) {
        throw new TracerError("SOURCE_MUTATED_DURING_BUILD", "source bytes, hash, or mtime changed during build")
      }
    }
    try {
      await lstat(output)
      throw new TracerError("OUTPUT_ALREADY_EXISTS", "output appeared during build")
    } catch (error) {
      if (error instanceof TracerError) throw error
      if (!hasFsCode(error, "ENOENT")) throw new TracerError("OUTPUT_FINALIZE_FAILED", "output metadata could not be checked")
    }
    await assertCandidateRoot(candidate, run)
    const finalGate = await gateCandidate(candidate, run, safe.records, safe.suppressedTargets, safe.privatePaths, baseline, safe.secretRules, safe.deploymentFiles, retainCustom404)
    await assertCandidateRoot(candidate, run)
    await rename(candidate, output)
    return finalGate
  } finally {
    await rm(run, { recursive: true, force: true })
  }
}

export {
  analyzeMarkdown,
  authenticateProjectAsset,
  decodeMarkdown,
  homePageMarkdown,
  normalizePaperMasthead,
  parseFrontmatter,
  projectIntegrationBoundaries,
  projectContent,
  publicContracts,
  readDeploymentSiteFiles,
  readSecretRules,
  readToolchainMetadata,
  runRendererPipeline,
  scholarlyTheme,
  tracerQuartzConfig,
  validateMarkdownSafety,
  validateSemanticTemplates,
  versionProjectSiteIconReference,
}
