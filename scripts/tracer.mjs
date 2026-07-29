#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import {
  constants,
} from "node:fs"
import {
  access,
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
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { TextDecoder } from "node:util"
import { fileURLToPath } from "node:url"

import Ajv2020Module from "ajv/dist/2020.js"
import { fromMarkdown } from "mdast-util-from-markdown"
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml"

import {
  ContractError,
  readContractJson,
  validateContract,
  validatePublicationPreflight,
} from "../lib/publication-contracts.mjs"
import {
  assertNoLinkAncestors,
  canonicalPath,
  hasFsCode,
  isEqualToOrInside,
  pathsOverlap,
} from "../lib/filesystem-safety.mjs"
import { createQuartzPublicNavigation } from "../lib/quartz-public-navigation.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const Ajv2020 = /** @type {any} */ (Ajv2020Module)
const toolchainMetadataPath = path.join(repoRoot, "config", "quartz-toolchain.json")
const scholarlyThemePath = path.join(repoRoot, "styles", "tracer-scholarly.scss")
const fixtureDisclaimer = "SYNTHETIC FIXTURE — NOT RESEARCH EVIDENCE."
const homeDisclaimer = "SYNTHETIC / NON-RESEARCH: This generated site is a tracer fixture only. It contains no research evidence."
const requiredFlags = ["manifest", "exportReceipt", "runtimeRoot", "exportRoot", "vaultRoot", "workRoot", "output", "now"]
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

/** @param {string[]} argv */
function parseArgs(argv) {
  const [command, ...rest] = argv
  if (command !== "preflight" && command !== "build") throw new TracerError("USAGE", "expected command: preflight or build")
  /** @type {Record<string,string>} */
  const options = {}
  const flags = new Map([
    ["--manifest", "manifest"],
    ["--export-receipt", "exportReceipt"],
    ["--runtime-root", "runtimeRoot"],
    ["--export-root", "exportRoot"],
    ["--vault-root", "vaultRoot"],
    ["--work-root", "workRoot"],
    ["--output", "output"],
    ["--now", "now"],
  ])
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new TracerError("USAGE", "every flag requires exactly one value")
    }
    const property = flags.get(flag)
    if (!property) throw new TracerError("USAGE", "unknown flag")
    if (Object.hasOwn(options, property)) throw new TracerError("USAGE", "duplicate flag")
    options[property] = value
  }
  const missing = requiredFlags.filter((flag) => !options[flag])
  if (missing.length) throw new TracerError("CONTEXT_REQUIRED", "all tracer path and time flags are required")
  return /** @type {{command:"preflight"|"build",manifest:string,exportReceipt:string,runtimeRoot:string,exportRoot:string,vaultRoot:string,workRoot:string,output:string,now:string}} */ ({ command, ...options })
}

/** @param {string} name @param {string} input @param {"directory"|"file"|"missing"} kind */
async function openRolePath(name, input, kind) {
  const absolute = path.resolve(input)
  await assertNoLinkAncestors(absolute, {
    allowMissing: kind === "missing",
    errorFactory: (message) => new TracerError("PATH_SYMLINK_NOT_ALLOWED", `${name}: ${message}`),
  })
  let canonical
  try {
    canonical = await canonicalPath(absolute)
  } catch {
    throw new TracerError("PATH_INVALID", `${name} is not a valid filesystem path`)
  }
  if (canonical !== absolute) throw new TracerError("PATH_ALIAS_NOT_ALLOWED", `${name} must use exact canonical filesystem spelling`)
  if (kind === "missing") {
    try {
      await lstat(absolute)
      throw new TracerError("OUTPUT_ALREADY_EXISTS", "output must not already exist")
    } catch (error) {
      if (error instanceof TracerError) throw error
      if (!hasFsCode(error, "ENOENT")) throw new TracerError("PATH_INVALID", "output metadata could not be read")
    }
    return canonical
  }
  try {
    const metadata = await lstat(absolute)
    if (kind === "directory" ? !metadata.isDirectory() : !metadata.isFile()) {
      throw new TracerError("PATH_CLASS_INVALID", `${name} has the wrong filesystem class`)
    }
    await access(absolute, constants.R_OK)
  } catch (error) {
    if (error instanceof TracerError) throw error
    throw new TracerError("PATH_INVALID", `${name} must be readable and existing`)
  }
  return canonical
}

/** @param {Array<[string,string]>} roles */
function rejectOverlaps(roles) {
  for (let first = 0; first < roles.length; first += 1) {
    for (let second = first + 1; second < roles.length; second += 1) {
      if (pathsOverlap(roles[first][1], roles[second][1])) {
        throw new TracerError("PATH_OVERLAP_NOT_ALLOWED", `${roles[first][0]} and ${roles[second][0]} must be disjoint`)
      }
    }
  }
}

/** @param {Buffer} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
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

/** @param {string} markdown @param {string} body @param {string} role @param {ReturnType<typeof analyzeMarkdown>} analysis */
function validateMarkdownSafety(markdown, body, role, analysis) {
  // This intentionally recognizes a narrow accepted Markdown subset rather than
  // attempting browser-grade HTML parsing. Anything tag-, declaration-,
  // processing-instruction-, comment-, namespace-, or autolink-shaped fails closed.
  const rawHtml = /<!--|-->|<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*|[^<>\s@]+@[^<>\s@]+)>|<\s*\/?\s*[A-Za-z][A-Za-z0-9:-]*(?=[\s/>]|$)[^<>\r\n]*(?:>|$)|<![A-Za-z][^>\r\n]*(?:>|$)|<\?[^>\r\n]*(?:>|$)/i
  const withoutManagedMarkers = body.replace(/^<!-- zotero-annotations:(?:start|end) -->\r?\n?/gm, "")
  const markerHtmlOnly = analysis.htmlValues.every((value) => /^<!-- zotero-annotations:(?:start|end) -->$/.test(value.trim()))
  if ((analysis.hasHtml && !markerHtmlOnly) || rawHtml.test(withoutManagedMarkers)) throw new TracerError("SOURCE_ACTIVE_CONTENT_NOT_ALLOWED", `${role} contains raw HTML or an unsupported autolink`)
  if (analysis.markdownUrls.some((url) => /^(?:javascript|vbscript|data|file)\s*:/i.test(url.replace(/[\u0000-\u0020]+/g, "")))
    || /\]\(\s*(?:javascript|vbscript|data|file)\s*:/i.test(markdown)
    || /\b(?:href|src)\s*=\s*["']?\s*(?:javascript|vbscript|data|file)\s*:/i.test(markdown)) {
    throw new TracerError("SOURCE_UNSAFE_URL_SCHEME", `${role} contains an unsafe URL scheme`)
  }
  if (/!\[|!\[\[|<img\b/i.test(markdown)) throw new TracerError("SOURCE_IMAGE_EMBED_NOT_ALLOWED", `${role} contains an image or attachment embed`)
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp|github_pat|sk_live|AKIA)[A-Za-z0-9_-]{8,}/.test(markdown)) {
    throw new TracerError("SOURCE_SECRET_NOT_ALLOWED", `${role} contains credential-shaped content`)
  }
}

/** @param {string} markdown */
function parseFrontmatter(markdown) {
  const match = /^(?:---)\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
  if (!match) throw new TracerError("SOURCE_FRONTMATTER_REQUIRED", "every tracer node requires leading YAML frontmatter")
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
    throw new TracerError("SOURCE_FRONTMATTER_INVALID", "source frontmatter must be strict YAML with scalar fields or scalar arrays")
  }
}

/** @param {string} value */
function aliasKey(value) {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.md$/i, "").toLowerCase()
}

/** @param {string} value */
function markdownText(value) {
  return value.replace(/[\\`*_[\]<>]/g, (character) => `\\${character}`).replace(/[\r\n]+/g, " ").trim()
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

/** Authenticate an optional Zotero marker pair against root-level parser HTML
 * nodes. Any marker-shaped source that is not one exact ordered pair fails
 * closed; callers may then operate on the exact parser offsets only. */
function zoteroManagedRange(/** @type {string} */ markdown, /** @type {any} */ tree) {
  const startMarker = "<!-- zotero-annotations:start -->"
  const endMarker = "<!-- zotero-annotations:end -->"
  const markerMentions = [...markdown.matchAll(/<!--\s*zotero-annotations:(?:start|end)\s*-->/gi)]
  const markers = tree.children.filter((/** @type {any} */ node) => node.type === "html" && (node.value === startMarker || node.value === endMarker))
  if (markerMentions.length === 0 && markers.length === 0) return null
  if (markerMentions.length !== 2 || markers.length !== 2 || markers[0].value !== startMarker || markers[1].value !== endMarker) {
    throw new TracerError("SOURCE_MARKDOWN_INVALID", "Zotero managed markers must be one exact ordered root-level pair")
  }
  const start = nodeOffsets(markers[0])
  const end = nodeOffsets(markers[1])
  if (markdown.slice(start.start, start.end) !== startMarker || markdown.slice(end.start, end.end) !== endMarker || start.end > end.start) {
    throw new TracerError("SOURCE_MARKDOWN_INVALID", "Zotero managed marker offsets are invalid")
  }
  return { start: start.start, end: end.end }
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
    let hasHtml = false
    /** @type {string[]} */
    const htmlValues = []
    const excluded = new Set(["code", "inlineCode", "definition", "link", "linkReference", "image", "imageReference", "html"])
    /** @param {any} node @param {string[]} ancestors */
    function walk(node, ancestors) {
      if (!node || typeof node.type !== "string") throw new Error("invalid MDAST node")
      if (node.type === "html") { hasHtml = true; htmlValues.push(String(node.value ?? "")) }
      if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url)
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
    const disclaimer = tree.children.some((node) => node.type === "paragraph" && node.children?.length === 1
      && node.children[0].type === "text" && node.children[0].value === fixtureDisclaimer)
    const markdownUrls = linkNodes.map((node) => {
      if (node.type === "link") return node.url
      const resolved = definitions.get(node.identifier)
      if (typeof resolved !== "string") throw new Error("unresolved MDAST link reference")
      return resolved
    })
    const zoteroManaged = zoteroManagedRange(markdown, tree)
    return { tree, links, tokens: allWikiLinkTokens(markdown), connections, disclaimer, hasHtml, htmlValues, markdownUrls, zoteroManaged }
  } catch (error) {
    if (error instanceof TracerError) throw error
    throw new TracerError("SOURCE_MARKDOWN_INVALID", "source Markdown could not be parsed with stable MDAST offsets")
  }
}

const paperTemplateHeadings = Object.freeze(["Bibliography", "One-sentence Takeaway", "Research Question", "Citation"])

/** @param {Map<string,{node:any,analysis:ReturnType<typeof analyzeMarkdown>}>} records */
function validateSemanticTemplates(records) {
  for (const record of records.values()) {
    const rootH2 = record.analysis.tree.children.flatMap((node) => {
      if (node.type !== "heading" || node.depth !== 2) return []
      return [node.children.length === 1 && node.children[0].type === "text" ? node.children[0].value : ""]
    })
    if (record.node.node_class === "paper") {
      const scholarly = rootH2.filter((heading) => paperTemplateHeadings.includes(heading))
      if (JSON.stringify(rootH2.slice(0, paperTemplateHeadings.length)) !== JSON.stringify(paperTemplateHeadings)
        || JSON.stringify(scholarly) !== JSON.stringify(paperTemplateHeadings)) {
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

/** @param {any} manifest @param {Map<string,{node:any,markdown:string,body:string,frontmatter:Record<string,string|string[]>,route:string,analysis:ReturnType<typeof analyzeMarkdown>}>} records */
function projectContent(manifest, records) {
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
        const variants = suppressedTargetVariants(link.target)
        const normalizedDisplay = link.display.trim().replace(/\\/g, "/")
        if (!link.explicit || !normalizedDisplay || variants.has(normalizedDisplay) || variants.has(normalizedDisplay.toLowerCase())) {
          throw new TracerError("UNLISTED_DISPLAY_REQUIRED", "an unlisted wikilink requires an explicit non-private display")
        }
        for (const variant of variants) suppressedTargets.add(variant)
        suppressedTargetKeys.add(aliasKey(link.target))
        const value = markdownText(link.display)
        replacements.push({ start: link.start, end: link.end, value, searchValue: value })
      }
    }
    // Hidden/code tokens never create graph edges. Unlisted targets must still
    // be removed from derived metadata even when their safe display remains in
    // the source-visible page body.
    for (const link of record.analysis.tokens) {
      if (semanticRanges.has(`${link.start}:${link.end}`) || aliasOwners.has(aliasKey(link.target))) continue
      const variants = suppressedTargetVariants(link.target)
      const normalizedDisplay = link.display.trim().replace(/\\/g, "/")
      if (!link.explicit || !normalizedDisplay || variants.has(normalizedDisplay) || variants.has(normalizedDisplay.toLowerCase())) {
        throw new TracerError("UNLISTED_DISPLAY_REQUIRED", "an unlisted wikilink requires an explicit non-private display")
      }
      for (const variant of variants) suppressedTargets.add(variant)
      suppressedTargetKeys.add(aliasKey(link.target))
      const value = markdownText(link.display)
      replacements.push({ start: link.start, end: link.end, value, searchValue: value })
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
    searchableBodies.set(id, searchableBody)
    projectedBodies.set(id, discloseZoteroAnnotations(body))
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

  const paper = records.get(manifest.action.primary_id)
  if (!paper) throw new TracerError("TRACER_SHAPE_INVALID", "primary paper record is missing")
  const connectionRange = paper.analysis.connections
  for (const edge of manifest.action.direct_connection_edges) {
    const support = records.get(edge.target)
    if (!support) throw new TracerError("TRACER_SHAPE_INVALID", "support record is missing")
    if (!outgoing.get(edge.source)?.has(edge.target)) {
      throw new TracerError("DIRECT_CONNECTION_MISSING", "an approved action edge is absent from the public projection")
    }
    const exactPath = aliasKey(support.node.path)
    if (!connectionRange || !paper.analysis.links.some((link) => link.start >= connectionRange.start && link.end <= connectionRange.end && aliasKey(link.target) === exactPath)) {
      throw new TracerError("DIRECT_CONNECTION_MISSING", "paper Connections lacks the approved support path")
    }
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

/** @param {Map<string,any>} records @param {Map<string,Set<string>>} outgoing @param {Map<string,string>} searchableBodies */
function publicContracts(records, outgoing, searchableBodies) {
  const compare = (/** @type {string} */ left, /** @type {string} */ right) => Buffer.compare(Buffer.from(left), Buffer.from(right))
  const ordered = [...records.entries()].sort(([left], [right]) => compare(left, right))
  const nodes = ordered.map(([publicId, record]) => ({
    public_id: publicId,
    title: collapseUnicodeWhitespace(String(record.frontmatter.title ?? publicId)),
    node_class: record.node.node_class,
    url: record.route,
  }))
  const edgeKeys = new Set()
  for (const [source, targets] of outgoing) for (const target of targets) edgeKeys.add(`${source}\0${target}`)
  const edges = [...edgeKeys].sort(compare).map((key) => {
    const [source, target] = key.split("\0")
    return { source, target }
  })
  const publicIds = new Set(nodes.map((node) => node.public_id))
  if (edges.some((edge) => !publicIds.has(edge.source) || !publicIds.has(edge.target))) throw new TracerError("UNEXPECTED_GRAPH_STATE", "public graph edge endpoint is not public")
  const recordsProjection = ordered.map(([publicId, record]) => {
    const authors = (Array.isArray(record.frontmatter.authors) ? record.frontmatter.authors : []).map((/** @type {string} */ value) => collapseUnicodeWhitespace(String(value))).filter(Boolean)
    const doiValue = typeof record.frontmatter.doi === "string" ? collapseUnicodeWhitespace(record.frontmatter.doi) : ""
    const sourceTags = [...new Set((Array.isArray(record.frontmatter.tags) ? record.frontmatter.tags : []).map((/** @type {string} */ value) => collapseUnicodeWhitespace(String(value))).filter(Boolean))].sort(compare)
    const segments = searchableMarkdownSegments(searchableBodies.get(publicId) ?? "")
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
      title: collapseUnicodeWhitespace(String(record.frontmatter.title ?? publicId)),
      node_class: record.node.node_class,
      url: record.route,
      authors,
      doi: doiValue || null,
      source_tags: sourceTags,
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
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version) || !/^[0-9a-f]{40}$/.test(metadata.commit) || !/^[0-9a-f]{64}$/.test(metadata.defaultIconSha256)
    || !Number.isSafeInteger(metadata.quartzPackageTreeFiles) || metadata.quartzPackageTreeFiles < 1 || !/^[0-9a-f]{64}$/.test(metadata.quartzPackageTreeSha256)
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
  if (quartzTree.files !== metadata.quartzPackageTreeFiles || quartzTree.sha256 !== metadata.quartzPackageTreeSha256
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
    ["pageTitle: Quartz 5", "pageTitle: Manifest Quartz Tracer"],
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

  const disabledPlugins = ["alias-redirects", "og-image", "cname", "canvas-page", "tag-page", "graph", "search", "footer", "quartz-fonts", "latex", "darkmode", "reader-mode", "spacer", "unlisted-pages", "encrypted-pages", "bases-page", "backlinks", "article-title", "content-meta"]
  for (const plugin of disabledPlugins) replaceOne(`source: "@quartz-community/${plugin}"\n    enabled: true`, `source: "@quartz-community/${plugin}"\n    enabled: false`)
  replaceOne("source: \"@quartz-community/content-index\"\n    enabled: true\n    options:\n      enableSiteMap: true\n      enableRSS: true", "source: \"@quartz-community/content-index\"\n    enabled: true\n    options:\n      enableSiteMap: false\n      enableRSS: false")
  replaceOne("source: \"@quartz-community/table-of-contents\"\n    enabled: true\n    order: 50", "source: \"@quartz-community/table-of-contents\"\n    enabled: true\n    options:\n      maxDepth: 3\n      minEntries: 1\n      showByDefault: true\n      collapseByDefault: true\n      layout: modern\n    order: 50")
  replaceOne("source: \"@quartz-community/explorer\"\n    enabled: true\n    layout:", "source: \"@quartz-community/explorer\"\n    enabled: true\n    options:\n      title: Library\n      folderDefaultState: collapsed\n      folderClickBehavior: link\n      useSavedState: false\n    layout:")
  replaceOne("    folder:\n      exclude:\n        - reader-mode\n      positions:\n        right: []", "    folder: {}")

  for (const expected of ["pageTitle: Manifest Quartz Tracer", "enableSPA: false", "enablePopovers: false", "provider: null", "baseUrl: example.invalid", "fontOrigin: local", "cdnCaching: false", "header: system-ui", "body: Georgia", "code: ui-monospace", "enableInHtmlEmbed: true", "title: Library", "folder: {}"]) {
    if (transformed.split(expected).length !== 2) fail()
  }
  for (const plugin of disabledPlugins) {
    const escaped = plugin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const matches = [...transformed.matchAll(new RegExp(`source:\\s*["']@quartz-community/${escaped}["']\\s*\\n\\s*enabled:\\s*(true|false)`, "g"))]
    if (matches.length !== 1 || matches[0][1] !== "false") fail()
  }
  for (const plugin of ["table-of-contents", "explorer"]) {
    const matches = [...transformed.matchAll(new RegExp(`source:\\s*["']@quartz-community/${plugin}["']\\s*\\n\\s*enabled:\\s*(true|false)`, "g"))]
    if (matches.length !== 1 || matches[0][1] !== "true") fail()
  }
  return transformed
}

/** @param {"warm"|"contrast"} variant @param {string} template */
function scholarlyTheme(variant, template) {
  const palettes = {
    warm: { LIGHT: "#f8f4ec", LIGHTGRAY: "#ded6c8", GRAY: "#8a8175", DARKGRAY: "#3f3a34", DARK: "#201d1a", SECONDARY: "#745238", TERTIARY: "#4f6b62", HIGHLIGHT: "rgba(116, 82, 56, 0.12)" },
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

/** Quartz breadcrumbs include links for synthetic folder pages that are later
 * removed by the exact route gate. Before the immutable baseline, normalize
 * only those renderer-owned breadcrumb links to the approved library root.
 * @param {string} candidate @param {string} run
 * @param {Map<string,{route:string,frontmatter:Record<string,string|string[]>,node:{public_id:string,node_class:string}}>} records
 * @param {Map<string,Set<string>>} outgoing */
async function normalizeBreadcrumbRoutes(candidate, run, records, outgoing) {
  const approved = new Set(["/", ...[...records.values()].map((record) => record.route)])
  const explorerEntries = [...records.values()].map((record) => ({
    publicId: record.node.public_id,
    nodeClass: record.node.node_class,
    route: record.route,
    label: String(record.frontmatter.title ?? record.node.public_id),
  })).sort((left, right) => Buffer.compare(Buffer.from(left.publicId), Buffer.from(right.publicId)))
  for (const file of await listRegularTree(candidate, run)) {
    if (!file.relative.endsWith(".html")) continue
    const route = `/${file.relative === "index.html" ? "" : file.relative.slice(0, -"index.html".length)}`
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
    if (record) {
      const template = record.node.node_class === "paper" ? "paper" : "support"
      if (/\bdata-tracer-template=/.test(normalized)) throw new TracerError("CANDIDATE_TEMPLATE_MARKER_INVALID", "generated body already contains a template marker")
      normalized = normalized.replace(/<body\b/, `<body data-tracer-template="${template}"`)
      if (!normalized.includes(`<body data-tracer-template="${template}"`)) throw new TracerError("CANDIDATE_TEMPLATE_MARKER_INVALID", "generated content route lacks a body element")
    }
    normalized = normalized.replace(/<nav\b(?=[^>]*class="[^"]*breadcrumb-container)[^>]*>[\s\S]*?<\/nav>/gi, (nav) => nav.replace(/href="([^"]*)"/g, (attribute, href) => {
      if (!href) return attribute
      let pathname
      try { pathname = new URL(href, `https://example.invalid${route}`).pathname } catch { return attribute }
      return approved.has(pathname) ? attribute : `href="${navigation.rootHref}"`
    }))
    normalized = normalized
      .replace(/<link rel="preconnect" href="https:\/\/cdnjs\.cloudflare\.com" crossorigin="anonymous"\/>/g, "")
      .replace(/<script type="application\/javascript" data-persist="true">const fetchData = fetch\("[^"]*static\/contentIndex\.json"\)\.then\(data => data\.json\(\)\)<\/script>/, navigation.contentIndexScript)
      .replaceAll("https://example.invalid", "")
    if (publicPage) {
      const existingExplorerCount = [...normalized.matchAll(/\bclass="([^"]*)"/g)].filter((match) => match[1].split(/\s+/).includes("explorer")).length
      if (existingExplorerCount > 1 || (record && existingExplorerCount !== 1) || normalized.includes("public-explorer")) {
        throw new TracerError("CANDIDATE_EXPLORER_INVALID", "generated public page must retain exactly one Quartz Explorer")
      }
      const explorerMarkup = route === "/" && existingExplorerCount === 0 ? navigation.explorerShellMarkup : ""
      normalized = normalized.replace(/<body\b[^>]*>/, (body) => `${body}${navigation.searchMarkup}${explorerMarkup}`)
      if (!normalized.includes("class=\"public-search\"")) throw new TracerError("CANDIDATE_SEARCH_INVALID", "generated public page lacks the project-owned search surface")
      const explorerCount = [...normalized.matchAll(/\bclass="([^"]*)"/g)].filter((match) => match[1].split(/\s+/).includes("explorer")).length
      if (explorerCount !== 1 || normalized.includes("public-explorer")) throw new TracerError("CANDIDATE_EXPLORER_INVALID", "generated public page must retain exactly one Quartz Explorer")
    }
    if (record) {
      const beforeBacklinks = normalized
      normalized = normalized.replace(/<h2\b[^>]*id="backlinks"[^>]*>[\s\S]*?<\/h2>\s*(?:<ul>[\s\S]*?<\/ul>|<p>[\s\S]*?<\/p>)/, navigation.backlinksMarkup)
      if (normalized === beforeBacklinks) throw new TracerError("CANDIDATE_BACKLINKS_INVALID", "generated content route lacks the project-owned backlinks surface")
    }
    const beforeGraph = normalized
    normalized = normalized.replace("</article>", `${navigation.graphMarkup}</article>`)
    if (normalized === beforeGraph) throw new TracerError("CANDIDATE_GRAPH_INVALID", "generated public page lacks an article graph surface")
    normalized = normalized.replace("</body>", `${navigation.runtimeScripts}</body>`)
    if (normalized !== html) await writeFile(file.absolute, normalized)
  }
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

/** @param {Map<string,{route:string}>} records */
function virtualHtmlPaths(records) {
  const virtual = new Set(["404.html"])
  for (const { route } of records.values()) {
    const segments = route.split("/").filter(Boolean)
    for (let length = 1; length < segments.length; length += 1) virtual.add(`${segments.slice(0, length).join("/")}/index.html`)
  }
  return virtual
}

/** Remove only baseline-authenticated Quartz virtual pages.
 * @param {string} candidate @param {string} run @param {Map<string,{route:string}>} records
 * @param {ReadonlyArray<{relative:string,fileClass:string,sha256:string}>} baseline */
async function pruneVirtualHtml(candidate, run, records, baseline) {
  await assertCandidateRoot(candidate, run)
  const virtual = virtualHtmlPaths(records)
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

/** Quartz's fixed projection must retain the exact disclaimer as a normal body
 * paragraph, not merely as inert/head metadata. This is intentionally narrower
 * than a general browser visibility model. @param {string} html */
function hasCandidateDisclaimerParagraph(html) {
  const bodyOnly = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(template|head|title|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
  return /<p>\s*SYNTHETIC FIXTURE — NOT RESEARCH EVIDENCE\.\s*<\/p>/.test(bodyOnly)
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
  if (variant === "disclaimer-template") {
    const page = (await listRegularTree(candidate, run)).find((file) => /^(?:papers|knowledge)\/.+\/index\.html$/.test(file.relative) && hasCandidateDisclaimerParagraph(file.bytes.toString("utf8")))
    if (!page) throw new TracerError("TEST_INJECTION_INVALID", "candidate disclaimer paragraph was not found")
    const html = page.bytes.toString("utf8")
    const replaced = html.replace(/<p>\s*SYNTHETIC FIXTURE — NOT RESEARCH EVIDENCE\.\s*<\/p>/, `<template>${fixtureDisclaimer}</template>`)
    if (replaced === html) throw new TracerError("TEST_INJECTION_INVALID", "candidate disclaimer paragraph could not be replaced")
    await writeFile(page.absolute, replaced)
    return
  }
  const index = path.join(candidate, "index.html")
  const snippets = new Map([
    ["event-attribute", "<div onpointerenter=\"alert(1)\">event</div>"],
    ["poster-private", "<video poster=\"/private/hidden-poster\"></video>"],
    ["srcset-missing", "<img srcset=\"/static/icon.png 1x, /static/unexpected.png 2x\">"],
    ["form-action-private", "<form action=\"/private/\"><button formaction=\"/private/submit/\">submit</button></form>"],
    ["object-data-private", "<object data=\"/private/object/\"></object>"],
    ["meta-refresh", "<meta http-equiv=\"refresh\" content=\"0; url=/private/\">"],
    ["css-url-missing", "<style>body{background-image:url('/static/unexpected.png')}</style>"],
    ["unsafe-attribute-scheme", "<a href=\"javascript:alert(1)\">unsafe</a>"],
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
          .replace(/(<ul\b[^>]*\b)id="[^"]+"/, `$1id="${id}"`)
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
    if (JSON.stringify(Object.keys(record)) !== JSON.stringify(["public_id", "title", "node_class", "url", "authors", "doi", "source_tags", "search_text"])
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

/** @param {string} candidate @param {string} run @param {Map<string,{route:string,node:{node_class:string}}>} records @param {Set<string>} suppressedTargets @param {string[]} privatePaths @param {ReadonlyArray<{relative:string,fileClass:string,sha256:string}>} baseline */
async function gateCandidate(candidate, run, records, suppressedTargets, privatePaths, baseline) {
  await assertCandidateRoot(candidate, run)
  if (testHook("TYLER_TRACER_TEST_GATE_FAILURE") === "1") throw new TracerError("CANDIDATE_GATE_FAILED", "candidate gate test injection")
  const files = await listRegularTree(candidate, run)
  await validatePublicDataStructure(files)
  const html = files.filter((file) => file.relative.endsWith(".html")).map((file) => file.relative)
  const expectedHtml = ["index.html", ...[...records.values()].map((record) => `${record.route.slice(1)}index.html`)].sort()
  if (JSON.stringify(html.sort()) !== JSON.stringify(expectedHtml)) throw new TracerError("CANDIDATE_ROUTE_SET_INVALID", "candidate HTML route set is not exact", { actual: html.sort(), expected: expectedHtml })
  const approvedRoutes = new Set(["/", ...[...records.values()].map((record) => record.route)])
  const virtual = virtualHtmlPaths(records)
  const expectedFinal = baseline.filter((row) => !virtual.has(row.relative))
  const expectedAssets = new Set(expectedFinal.filter((row) => !row.relative.endsWith(".html")).map((row) => `/${row.relative}`))
  const contentHtml = new Set([...records.values()].map((record) => `${record.route.slice(1)}index.html`))
  for (const file of files) {
    if (file.relative.endsWith(".html")) {
      const pageHtml = file.bytes.toString("utf8")
      if (pageHtml.split(tracerCspMeta).length - 1 !== 1) throw new TracerError("CANDIDATE_CSP_INVALID", "candidate page lacks its exact unique content security policy")
      if (contentHtml.has(file.relative) && !hasCandidateDisclaimerParagraph(pageHtml)) {
        throw new TracerError("CANDIDATE_DISCLAIMER_MISSING", "candidate paper/support route lacks the exact visible disclaimer paragraph")
      }
      if (contentHtml.has(file.relative)) {
        const record = [...records.values()].find((candidateRecord) => `${candidateRecord.route.slice(1)}index.html` === file.relative)
        const template = record?.node?.node_class === "paper" ? "paper" : "support"
        if (!new RegExp(`<body\\b[^>]*\\bdata-tracer-template="${template}"`).test(pageHtml)) {
          throw new TracerError("CANDIDATE_TEMPLATE_MARKER_INVALID", "candidate content route lacks its renderer-owned template marker")
        }
      }
      const route = `/${file.relative === "index.html" ? "" : file.relative.slice(0, -"index.html".length)}`
      validateCandidateHtml(pageHtml, route, approvedRoutes, expectedAssets)
    } else if (file.relative.endsWith(".css")) validateCandidateCss(file.bytes.toString("utf8"), `/${file.relative}`, approvedRoutes, expectedAssets)
  }
  const actualManifest = files.map((file) => ({ relative: file.relative, fileClass: "regular-file", sha256: sha256(file.bytes) }))
  if (JSON.stringify(actualManifest) !== JSON.stringify(expectedFinal)) throw new TracerError("CANDIDATE_FILE_MANIFEST_MISMATCH", "candidate files differ from the immutable post-Quartz baseline")
  const normalizePrivatePath = (/** @type {string} */ value) => {
    const normalized = value.replace(/\\/g, "/")
    return process.platform === "win32" ? normalized.toLowerCase() : normalized
  }
  const pathVariants = privatePaths.map(normalizePrivatePath)
  for (const file of files) {
    if (/\.(?:md|pdf)$/i.test(file.relative)) throw new TracerError("CANDIDATE_FORBIDDEN_FILE", "candidate contains Markdown or PDF")
    const text = file.bytes.toString("utf8")
    const forbiddenDisclosure = /export-receipt|publication-manifest|release-receipt|current-release/i.exec(text)
      ?? (file.relative.endsWith(".html") ? /\.md\b|\.pdf\b/i.exec(text) : null)
    if (forbiddenDisclosure) throw new TracerError("CANDIDATE_FORBIDDEN_DISCLOSURE", "candidate contains forbidden source or receipt metadata", { file: file.relative, token: forbiddenDisclosure[0].toLowerCase() })
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp|github_pat|sk_live|AKIA)[A-Za-z0-9_-]{8,}/.test(text)) throw new TracerError("CANDIDATE_SECRET_DISCLOSURE", "candidate contains credential-shaped bytes")
    const schemeText = file.relative.endsWith(".html") ? text.replace(tracerCspMeta, "") : text
    if (!/\.(?:css|js|map)$/i.test(file.relative) && /(?:javascript|vbscript|data|file)\s*:/i.test(schemeText)) throw new TracerError("CANDIDATE_UNSAFE_SCHEME", "candidate contains an unsafe URL scheme", { file: file.relative })
    const comparableText = normalizePrivatePath(text)
    if (pathVariants.some((value) => value && comparableText.includes(value)) || /(?:[A-Za-z]:[\\/]+users[\\/]|[\\/](?:home|users)[\\/])/i.test(text)) throw new TracerError("CANDIDATE_ABSOLUTE_PATH_DISCLOSURE", "candidate contains an absolute local path")
    const disclosureForms = disclosureComparables(text)
    if ([...suppressedTargets].some((target) => target && disclosureForms.some((form) => form.includes(target.replace(/\\/g, "/").toLowerCase())))) throw new TracerError("CANDIDATE_SUPPRESSED_TARGET_DISCLOSURE", "candidate contains suppressed target metadata")
  }
  return { files: files.length, routes: [...approvedRoutes].sort() }
}

/** @param {ReturnType<typeof parseArgs>} cli */
async function preflight(cli) {
  const [runtimeRoot, exportRoot, vaultRoot, workRoot, output, manifestPath] = await Promise.all([
    openRolePath("runtime root", cli.runtimeRoot, "directory"),
    openRolePath("export root", cli.exportRoot, "directory"),
    openRolePath("canonical Vault root", cli.vaultRoot, "directory"),
    openRolePath("work root", cli.workRoot, "directory"),
    openRolePath("output", cli.output, "missing"),
    openRolePath("manifest", cli.manifest, "file"),
  ])
  rejectOverlaps([["runtime root", runtimeRoot], ["export root", exportRoot], ["canonical Vault root", vaultRoot], ["work root", workRoot], ["output", output]])
  if ([exportRoot, vaultRoot, workRoot, output].some((root) => isEqualToOrInside(root, manifestPath))) {
    throw new TracerError("PATH_OVERLAP_NOT_ALLOWED", "manifest context must be outside export, Vault, work, and output roots")
  }
  const expectedReceipt = path.join(exportRoot, "export-receipt.json")
  const receiptPath = await openRolePath("export receipt", cli.exportReceipt, "file")
  if (receiptPath !== expectedReceipt || path.resolve(cli.exportReceipt) !== expectedReceipt) {
    throw new TracerError("EXPORT_RECEIPT_LOCATION_INVALID", "receipt must be the exact export-root/export-receipt.json entry")
  }
  const exportNames = await readdir(exportRoot)
  if (!exportNames.includes("export-receipt.json")) throw new TracerError("EXPORT_RECEIPT_LOCATION_INVALID", "receipt filesystem spelling is not exact")

  const manifest = /** @type {any} */ (await readContractJson(manifestPath))
  await validatePublicationPreflight(manifest, { now: cli.now, runtimeRoot })
  const receipt = /** @type {any} */ (await readContractJson(receiptPath))
  await validateContract("export-receipt", receipt, { manifest, exportRoot, now: cli.now })
  if (manifest.action.kind !== "publish-unit") {
    throw new TracerError("TRACER_SHAPE_INVALID", "tracer requires a publish-unit action")
  }
  const primary = manifest.nodes.find((/** @type {any} */ node) => node.public_id === manifest.action.primary_id)
  const nodeById = new Map(manifest.nodes.map((/** @type {any} */ node) => [node.public_id, node]))
  if (!primary || primary.node_class !== "paper" || manifest.action.support_ids.some((/** @type {string} */ id) => nodeById.get(id)?.node_class === "paper" || !nodeById.has(id))) {
    throw new TracerError("TRACER_SHAPE_INVALID", "publish-unit action roles do not match listed nodes")
  }

  /** @type {Map<string,{node:any,bytes:Buffer,markdown:string,body:string,frontmatter:Record<string,string|string[]>,route:string,mtimeMs:number,analysis:ReturnType<typeof analyzeMarkdown>}>} */
  const records = new Map()
  for (const node of manifest.nodes) {
    const absolute = path.join(exportRoot, ...node.path.split("/"))
    const metadata = await lstat(absolute)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new TracerError("SOURCE_FILE_CLASS_INVALID", "manifest source must be a regular Markdown file")
    const bytes = await readFile(absolute)
    const markdown = decodeMarkdown(bytes, node.public_id)
    const parsed = parseFrontmatter(markdown)
    const analysis = analyzeMarkdown(parsed.body)
    validateMarkdownSafety(markdown, parsed.body, node.public_id, analysis)
    if (node.node_class === "paper") {
      if (parsed.data.type !== "literature-note" || parsed.data.status !== "integrated") throw new TracerError("PAPER_FRONTMATTER_INVALID", "paper requires exact type: literature-note and status: integrated")
    } else if (parsed.data.type === "paper") throw new TracerError("SUPPORT_FRONTMATTER_INVALID", "support node cannot claim paper type")
    if (!analysis.disclaimer) throw new TracerError("SYNTHETIC_DISCLAIMER_REQUIRED", "each T03 source body requires the exact synthetic fixture disclaimer as an independent visible plain paragraph")
    const route = node.node_class === "paper" ? `/papers/${node.public_id}/` : `/knowledge/${node.node_class}/${node.public_id}/`
    records.set(node.public_id, { node, bytes, markdown, body: parsed.body, frontmatter: parsed.data, route, mtimeMs: metadata.mtimeMs, analysis })
  }
  const projection = projectContent(manifest, records)
  const contracts = publicContracts(records, projection.outgoing, projection.searchableBodies)
  validateSemanticTemplates(records)
  const toolchain = await readToolchainMetadata()
  return { runtimeRoot, exportRoot, vaultRoot, workRoot, output, manifestPath, receiptPath, manifest, receipt, records, contracts, ...projection, ...toolchain }
}

/** @param {Awaited<ReturnType<typeof preflight>>} safe */
async function build(safe) {
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
  } else if (configCase !== undefined) throw new TracerError("TEST_INJECTION_INVALID", "config regression injection is not a fixed supported variant")
  const quartzConfig = tracerQuartzConfig(defaultConfig)
  const run = await mkdtemp(path.join(safe.workRoot, `tracer-${process.pid}-${randomBytes(8).toString("hex")}-`))
  try {
    const raw = path.join(run, "raw")
    const content = path.join(run, "content")
    const toolchain = path.join(run, "toolchain")
    const candidate = path.join(run, "candidate")
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
    const homeLinks = [...safe.records.values()]
      .sort((left, right) => Buffer.compare(Buffer.from(left.node.public_id), Buffer.from(right.node.public_id)))
      .map((record) => `- [${markdownText(String(record.frontmatter.title ?? record.node.public_id))}](${record.route})`)
      .join("\n")
    await writeFile(path.join(content, "index.md"), `---\ntitle: "Manifest Quartz Tracer"\n---\n\n# Manifest Quartz Tracer\n\n> **${homeDisclaimer}**\n\n${homeLinks}\n`, { flag: "wx" })
    await Promise.all([
      cp(path.join(safe.installedRoot, "quartz"), path.join(toolchain, "quartz"), { recursive: true, errorOnExist: true, force: false }),
      copyFile(path.join(safe.installedRoot, "package.json"), path.join(toolchain, "package.json"), constants.COPYFILE_EXCL),
      copyFile(path.join(safe.installedRoot, "quartz.ts"), path.join(toolchain, "quartz.ts"), constants.COPYFILE_EXCL),
      symlink(path.join(repoRoot, "node_modules"), path.join(toolchain, "node_modules"), process.platform === "win32" ? "junction" : "dir"),
    ])
    await Promise.all([
      writeFile(path.join(toolchain, "quartz.config.yaml"), quartzConfig, { flag: "wx" }),
      writeFile(path.join(toolchain, "quartz", "styles", "custom.scss"), customTheme),
    ])
    const executable = path.join(toolchain, "quartz", "bootstrap-cli.mjs")
    const quartz = /** @type {{code:number,logs:string}} */ (await spawnCaptured(executable, ["build", "--directory", content, "--output", candidate, "--concurrency", "1"], toolchain))
    if (quartz.code !== 0) throw new TracerError("QUARTZ_BUILD_FAILED", "pinned Quartz build failed", testHook("TYLER_TRACER_TEST_DEBUG") === "1" ? { logs: quartz.logs } : {})
    await normalizeBreadcrumbRoutes(candidate, run, safe.records, safe.outgoing)
    await repairTocAccessibility(candidate, run)
    await installNetworkCsp(candidate, run)
    await writePublicDataAssets(candidate, run, safe.contracts)
    const prebaselineCase = testHook("TYLER_TRACER_TEST_PREBASELINE_CASE")
    if (prebaselineCase) await injectPrebaselineRegression(candidate, run, prebaselineCase)
    await validateT04Prebaseline(candidate, run)
    // This frozen manifest is captured after the fixed T04 boundary and before
    // every post-baseline test hook and sanctioned virtual-page pruning.
    const baseline = await immutableCandidateManifest(candidate, run)
    const candidateVariant = testHook("TYLER_TRACER_TEST_CANDIDATE_CASE")
      ?? (testHook("TYLER_TRACER_TEST_EXTRA_HTML") === "1" ? "extra-html" : undefined)
    if (candidateVariant) await injectCandidateRegression(candidate, run, candidateVariant)
    await pruneVirtualHtml(candidate, run, safe.records, baseline)
    await gateCandidate(candidate, run, safe.records, safe.suppressedTargets, [safe.runtimeRoot, safe.exportRoot, safe.vaultRoot, safe.workRoot, safe.output, safe.manifestPath, safe.receiptPath], baseline)

    for (const record of safe.records.values()) {
      const source = path.join(safe.exportRoot, ...record.node.path.split("/"))
      const metadata = await lstat(source)
      const bytes = await readFile(source)
      if (!bytes.equals(record.bytes) || metadata.mtimeMs !== record.mtimeMs || sha256(bytes) !== record.node.source_sha256) {
        throw new TracerError("SOURCE_MUTATED_DURING_BUILD", "source bytes, hash, or mtime changed during build")
      }
    }
    try {
      await lstat(safe.output)
      throw new TracerError("OUTPUT_ALREADY_EXISTS", "output appeared during build")
    } catch (error) {
      if (error instanceof TracerError) throw error
      if (!hasFsCode(error, "ENOENT")) throw new TracerError("OUTPUT_FINALIZE_FAILED", "output metadata could not be checked")
    }
    await assertCandidateRoot(candidate, run)
    const finalGate = await gateCandidate(candidate, run, safe.records, safe.suppressedTargets, [safe.runtimeRoot, safe.exportRoot, safe.vaultRoot, safe.workRoot, safe.output, safe.manifestPath, safe.receiptPath], baseline)
    await assertCandidateRoot(candidate, run)
    await rename(candidate, safe.output)
    return finalGate
  } finally {
    await rm(run, { recursive: true, force: true })
  }
}

async function main() {
  const cli = parseArgs(process.argv.slice(2))
  const safe = await preflight(cli)
  if (testHook("TYLER_TRACER_TEST_DISCLOSURE_ERROR")) {
    throw new TracerError("TEST_DISCLOSURE", "synthetic redaction failure", { logs: testHook("TYLER_TRACER_TEST_DISCLOSURE_ERROR") })
  }
  if (cli.command === "preflight") {
    process.stdout.write(`${JSON.stringify({ ok: true, command: "preflight", manifestId: safe.manifest.manifest_id, nodes: safe.records.size, suppressionCount: safe.suppressionCount, quartz: safe.metadata.version })}\n`)
    return
  }
  const gate = await build(safe)
  process.stdout.write(`${JSON.stringify({ ok: true, command: "build", manifestId: safe.manifest.manifest_id, nodes: safe.records.size, routes: gate.routes, files: gate.files, suppressionCount: safe.suppressionCount, quartz: safe.metadata.version })}\n`)
}

main().catch((error) => {
  const known = error instanceof TracerError || error instanceof ContractError
  const code = known ? error.code : "UNEXPECTED_ERROR"
  const message = known ? error.message : "unexpected tracer failure"
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`)
  process.exitCode = 1
})
