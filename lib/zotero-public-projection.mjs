import { fromMarkdown } from "mdast-util-from-markdown"

import { ContractError } from "./publication-contracts.mjs"

const startMarker = "<!-- zotero-annotations:start -->"
const endMarker = "<!-- zotero-annotations:end -->"
const unsupportedManagedRawHtml = /<!--|-->|<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*|[^<>\s@]+@[^<>\s@]+)>|<\s*\/?\s*[A-Za-z][A-Za-z0-9:-]*(?=[\s/>]|$)[^<>\r\n]*(?:>|$)|<![A-Za-z][^>\r\n]*(?:>|$)|<\?[^>\r\n]*(?:>|$)/i

const keyPattern = "[A-Za-z0-9]+"
const labelPattern = String.raw`\[[^\]\r\n]+\]`
const selectTargetPattern = String.raw`zotero:\/\/select\/library\/items\/(${keyPattern})`
const currentOpenPdfTargetPattern = String.raw`zotero:\/\/open-pdf\/library\/items\/(${keyPattern})\?page=([1-9][0-9]*)&annotation=(${keyPattern})`
const legacyOpenPdfTargetPattern = String.raw`zotero:\/\/open-pdf\/library\/items\/(${keyPattern})\?page=([1-9][0-9]*)`
const projectionTargetPattern = String.raw`(?:zotero:\/\/select\/library\/items\/${keyPattern}|zotero:\/\/open-pdf\/library\/items\/${keyPattern}\?page=[1-9][0-9]*(?:&annotation=${keyPattern})?)`

const exactSelectLink = new RegExp(`^${labelPattern}\\(${selectTargetPattern}\\)$`)
const exactPrivateSelectUri = new RegExp(`^${selectTargetPattern}$`)
const exactCurrentOpenPdfLink = new RegExp(`^${labelPattern}\\(${currentOpenPdfTargetPattern}\\)$`)
const exactLegacyOpenPdfLink = new RegExp(`^${labelPattern}\\(${legacyOpenPdfTargetPattern}\\)$`)
const exactZoteroLinkSuffix = new RegExp(`\\]\\(${projectionTargetPattern}\\)`, "g")

/** @param {any} node */
function nodeOffsets(node) {
  const start = node?.position?.start?.offset
  const end = node?.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new ContractError("SOURCE_MARKDOWN_INVALID", "Zotero Markdown nodes require stable source offsets")
  }
  return { start, end }
}

/** Decode only ASCII encodings that can obscure a local scheme. */
function normalizeSchemeProbe(/** @type {string} */ input) {
  let value = input
  for (let pass = 0; pass < 16; pass += 1) {
    const decoded = value
      .replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|colon|percnt|amp);/gi, (match, hex, decimal) => {
        if (/^&colon;$/i.test(match)) return ":"
        if (/^&percnt;$/i.test(match)) return "%"
        if (/^&amp;$/i.test(match)) return "&"
        const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10)
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x7f ? String.fromCharCode(codePoint) : match
      })
      .replace(/%([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    if (decoded === value) break
    value = decoded
  }
  return value.replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase()
}

/** @param {string} input @param {boolean} [anchored] */
export function containsZoteroSchemeDisclosure(input, anchored = false) {
  const probe = normalizeSchemeProbe(input)
  const expression = anchored
    ? /^zotero(?::|%(?:25)*3a|(?:&amp;)*(?:&colon;|&#0*58;|&#x0*3a;))/i
    : /zotero(?::|%(?:25)*3a|(?:&amp;)*(?:&colon;|&#0*58;|&#x0*3a;))/i
  return expression.test(probe)
}

/** Permit one exact private Zotero item URI only on paper frontmatter. Every
 * other frontmatter disclosure fails closed; the caller's public projection
 * must continue to omit this private input-only field.
 * @param {Record<string,string|string[]>} frontmatter @param {string} nodeClass */
export function validateZoteroFrontmatter(frontmatter, nodeClass) {
  if (Object.hasOwn(frontmatter, "zotero_uri")) {
    const value = frontmatter.zotero_uri
    if (nodeClass !== "paper" || typeof value !== "string" || !exactPrivateSelectUri.test(value)) {
      throw new ContractError("SOURCE_UNSAFE_URL_SCHEME", "Zotero frontmatter contains an unsupported local URL")
    }
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === "zotero_uri") continue
    const values = Array.isArray(value) ? value : [value]
    if (values.some((candidate) => containsZoteroSchemeDisclosure(candidate))) {
      throw new ContractError("SOURCE_UNSAFE_URL_SCHEME", "Zotero local URLs require the authenticated managed block")
    }
  }
}

/** Authenticate one exact root-level managed marker pair against MDAST offsets.
 * @param {string} markdown @param {any} tree */
export function zoteroManagedRange(markdown, tree) {
  const markerMentions = [...markdown.matchAll(/<!--\s*zotero-annotations:(?:start|end)\s*-->/gi)]
  const markers = tree.children.filter((/** @type {any} */ node) => node.type === "html" && (node.value === startMarker || node.value === endMarker))
  if (markerMentions.length === 0 && markers.length === 0) return null
  if (markerMentions.length !== 2 || markers.length !== 2 || markers[0].value !== startMarker || markers[1].value !== endMarker) {
    throw new ContractError("SOURCE_MARKDOWN_INVALID", "Zotero managed markers must be one exact ordered root-level pair")
  }
  const start = nodeOffsets(markers[0])
  const end = nodeOffsets(markers[1])
  if (markdown.slice(start.start, start.end) !== startMarker || markdown.slice(end.start, end.end) !== endMarker || start.end > end.start) {
    throw new ContractError("SOURCE_MARKDOWN_INVALID", "Zotero managed marker offsets are invalid")
  }
  return { start: start.start, end: end.end }
}

/** Remove exact local Zotero links while preserving the source-visible label.
 * A backwards balanced-bracket scan also handles projected wikilinks inside a
 * label without widening the accepted URL-target dialect. */
function stripExactZoteroLinks(/** @type {string} */ markdown) {
  const replacements = []
  for (const match of markdown.matchAll(exactZoteroLinkSuffix)) {
    const close = match.index
    let depth = 0
    let open = -1
    for (let cursor = close - 1; cursor >= 0; cursor -= 1) {
      const character = markdown[cursor]
      if (character === "]") depth += 1
      else if (character === "[") {
        if (depth === 0) { open = cursor; break }
        depth -= 1
      }
      if (character === "\n" || character === "\r") break
    }
    if (open < 0) continue
    replacements.push({ start: open, end: close + match[0].length, value: markdown.slice(open + 1, close) })
  }
  let safe = markdown
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    safe = `${safe.slice(0, replacement.start)}${replacement.value}${safe.slice(replacement.end)}`
  }
  return safe
}

/** @param {string} markdown */
function sanitizeManagedSlice(markdown) {
  const safe = stripExactZoteroLinks(markdown)
    .replace(/^<!-- zotero-annotations:(?:start|end) -->\r?\n?/gm, "")
    .replace(/<span style="background-color:#[0-9a-fA-F]{6}; color:#000; padding:1px 6px; border-radius:4px;">([^<>\r\n]+)<\/span>/g, "$1")
    .replace(/\s*<!-- zotero-annotation: [A-Za-z0-9]+ -->/g, "")
    .replace(/^ {2}- Metadata: attachment `[A-Za-z0-9]*`; color `#[0-9a-fA-F]{6}`; type `[^`\r\n]+`; position `\{[^`\r\n]*\}`\r?\n?/gm, "")
    .replace(/\s*·\s*`annotation:[A-Za-z0-9]+`/g, "")
  if (containsZoteroSchemeDisclosure(safe)) {
    throw new ContractError("SOURCE_UNSAFE_URL_SCHEME", "Zotero managed content contains an unsupported local URL")
  }
  if (/<!--\s*zotero-annotation\b|`annotation:|Metadata:\s*attachment\s*`/i.test(safe)) {
    throw new ContractError("SOURCE_ACTIVE_CONTENT_NOT_ALLOWED", "Zotero managed content contains unsupported annotation metadata")
  }
  if (unsupportedManagedRawHtml.test(safe)) {
    throw new ContractError("SOURCE_ACTIVE_CONTENT_NOT_ALLOWED", "Zotero managed content contains unsupported raw HTML")
  }
  return safe
}

/** @param {string} markdown */
function parseMarkdown(markdown) {
  try {
    const tree = fromMarkdown(markdown)
    if (!tree || tree.type !== "root" || !Array.isArray(tree.children)) throw new Error("invalid MDAST root")
    return tree
  } catch (error) {
    if (error instanceof ContractError) throw error
    throw new ContractError("SOURCE_MARKDOWN_INVALID", "source Markdown could not be parsed for Zotero projection")
  }
}

/** @param {string} markdown @param {any} tree */
function markdownUrlNodes(markdown, tree) {
  const definitions = new Map()
  /** @type {any[]} */
  const linkNodes = []
  /** @type {any[]} */
  const definitionNodes = []
  /** @param {any} node */
  function walk(node) {
    if (!node || typeof node.type !== "string") throw new ContractError("SOURCE_MARKDOWN_INVALID", "Zotero Markdown tree is invalid")
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url)
      definitionNodes.push(node)
    }
    if (node.type === "link" || node.type === "linkReference") linkNodes.push(node)
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) throw new ContractError("SOURCE_MARKDOWN_INVALID", "Zotero Markdown children are invalid")
      for (const child of node.children) walk(child)
    }
  }
  walk(tree)
  return [...linkNodes, ...definitionNodes].map((node) => {
    const { start, end } = nodeOffsets(node)
    if (end > markdown.length) throw new ContractError("SOURCE_MARKDOWN_INVALID", "Zotero Markdown offset escaped source")
    if (node.type === "link" || node.type === "definition") return { url: node.url, type: node.type, start, end }
    const resolved = definitions.get(node.identifier)
    if (typeof resolved !== "string") throw new ContractError("SOURCE_MARKDOWN_INVALID", "Zotero Markdown link reference is unresolved")
    return { url: resolved, type: node.type, start, end }
  })
}

/** Validate the complete parser-authenticated writer dialect and prove its
 * managed slice can be reduced to an inert public projection. Current links
 * carry annotation identity in the URL; the accepted legacy page-only form
 * must carry it in the exact immediately following legacy marker. */
export function validateZoteroManagedMarkdown(/** @type {string} */ markdown) {
  const tree = parseMarkdown(markdown)
  const managed = zoteroManagedRange(markdown, tree)
  if (managed) sanitizeManagedSlice(markdown.slice(managed.start, managed.end))
  /** @type {Array<{attachment:string,annotation:string,end:number,legacyPageOnly:boolean}>} */
  const openPdfLinks = []
  for (const link of markdownUrlNodes(markdown, tree)) {
    if (!containsZoteroSchemeDisclosure(link.url, true)) continue
    if (!managed || link.type !== "link" || link.start < managed.start || link.end > managed.end) {
      throw new ContractError("SOURCE_UNSAFE_URL_SCHEME", "Zotero local URLs require the authenticated managed block")
    }
    const source = markdown.slice(link.start, link.end)
    const select = exactSelectLink.exec(source)
    const currentOpenPdf = exactCurrentOpenPdfLink.exec(source)
    const legacyOpenPdf = exactLegacyOpenPdfLink.exec(source)
    if (select) continue
    if (currentOpenPdf) {
      openPdfLinks.push({ attachment: currentOpenPdf[1], annotation: currentOpenPdf[3], end: link.end, legacyPageOnly: false })
      continue
    }
    if (legacyOpenPdf) {
      const suffix = markdown.slice(link.end, managed.end)
      const marker = /^ · `annotation:([A-Za-z0-9]+)`/.exec(suffix)
      if (!marker) {
        throw new ContractError("SOURCE_UNSAFE_URL_SCHEME", "Zotero managed content contains an unsupported local URL")
      }
      openPdfLinks.push({ attachment: legacyOpenPdf[1], annotation: marker[1], end: link.end, legacyPageOnly: true })
      continue
    }
    throw new ContractError("SOURCE_UNSAFE_URL_SCHEME", "Zotero managed content contains an unsupported local URL")
  }

  if (!managed) return { managed }
  const managedSource = markdown.slice(managed.start, managed.end)
  const currentMarkers = [...managedSource.matchAll(/<!-- zotero-annotation: ([A-Za-z0-9]+) -->/g)]
  const legacyMarkers = [...managedSource.matchAll(/· `annotation:([A-Za-z0-9]+)`/g)]
  const exactMarkers = [...currentMarkers, ...legacyMarkers]
  const markerMentions = [...managedSource.matchAll(/<!--\s*zotero-annotation\b[^>]*(?:-->|$)|·?\s*`?annotation\s*:[^\s`<]+`?/gi)]
  if (markerMentions.length !== exactMarkers.length || exactMarkers.length !== openPdfLinks.length) {
    throw new ContractError("SOURCE_ACTIVE_CONTENT_NOT_ALLOWED", "Zotero managed content contains unsupported annotation metadata")
  }
  for (const link of openPdfLinks) {
    const suffix = markdown.slice(link.end, managed.end)
    const current = /^ <!-- zotero-annotation: ([A-Za-z0-9]+) -->/.exec(suffix)
    const legacy = /^ · `annotation:([A-Za-z0-9]+)`/.exec(suffix)
    const marker = link.legacyPageOnly ? legacy : current ?? legacy
    if (!marker || marker[1] !== link.annotation) {
      throw new ContractError("SOURCE_ACTIVE_CONTENT_NOT_ALLOWED", "Zotero managed content contains unsupported annotation metadata")
    }
  }

  const exactMetadata = [...managedSource.matchAll(/^ {2}- Metadata: attachment `([A-Za-z0-9]*)`; color `#[0-9a-fA-F]{6}`; type `[^`\r\n]+`; position `\{[^`\r\n]*\}`\r?$/gm)]
  const metadataMentions = [...managedSource.matchAll(/^.*\bMetadata\s*:\s*attachment\b.*$/gim)]
  if (exactMetadata.length !== metadataMentions.length
    || exactMetadata.some((match) => !openPdfLinks.some((link) => link.attachment === match[1]))) {
    throw new ContractError("SOURCE_ACTIVE_CONTENT_NOT_ALLOWED", "Zotero managed content contains unsupported annotation metadata")
  }
  return { managed }
}

/** Project a previously validated body after caller-owned wikilink replacement. */
export function projectZoteroManagedMarkdown(/** @type {string} */ markdown) {
  const tree = parseMarkdown(markdown)
  const managed = zoteroManagedRange(markdown, tree)
  if (!managed) return markdown
  return `${markdown.slice(0, managed.start)}${sanitizeManagedSlice(markdown.slice(managed.start, managed.end))}${markdown.slice(managed.end)}`
}
