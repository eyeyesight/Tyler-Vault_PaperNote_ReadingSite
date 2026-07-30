import { createHash } from "node:crypto"
import { TextDecoder } from "node:util"

import { ContractError, jcsCanonicalize } from "./publication-contracts.mjs"

export const ZOTERO_START_MARKER = "<!-- zotero-annotations:start -->"
export const ZOTERO_END_MARKER = "<!-- zotero-annotations:end -->"
const startLiteral = Buffer.from(ZOTERO_START_MARKER, "ascii")
const endLiteral = Buffer.from(ZOTERO_END_MARKER, "ascii")

/** @param {Buffer} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

/** @param {Buffer} bytes @param {Buffer} needle */
function allOffsets(bytes, needle) {
  const offsets = []
  let cursor = 0
  while (cursor <= bytes.length - needle.length) {
    const offset = bytes.indexOf(needle, cursor)
    if (offset < 0) break
    offsets.push(offset)
    cursor = offset + needle.length
  }
  return offsets
}

/** @param {Buffer} bytes */
function strictLineEnding(bytes) {
  let hasLf = false
  let hasCrlf = false
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0d) {
      if (bytes[index + 1] !== 0x0a) throw new ContractError("ZOTERO_EOL_INVALID", "Zotero source must use one consistent LF or CRLF line ending")
      hasCrlf = true
      index += 1
    } else if (bytes[index] === 0x0a) hasLf = true
  }
  if (hasLf && hasCrlf) throw new ContractError("ZOTERO_EOL_INVALID", "Zotero source must use one consistent LF or CRLF line ending")
  if (!hasLf && !hasCrlf) throw new ContractError("ZOTERO_EOL_INVALID", "Zotero marker lines must use LF or CRLF")
  return hasCrlf ? { name: "CRLF", bytes: Buffer.from("\r\n", "ascii") } : { name: "LF", bytes: Buffer.from("\n", "ascii") }
}

/**
 * Parse one exact raw-byte Zotero managed block. The returned five buffers are
 * slices of the caller-owned immutable byte snapshot and are never written.
 * @param {Buffer} bytes
 */
export function parseZoteroManagedBlock(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new ContractError("ZOTERO_SOURCE_INVALID", "Zotero source must be supplied as exact bytes")
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    throw new ContractError("ZOTERO_BOM_NOT_ALLOWED", "Zotero source must be UTF-8 without BOM")
  }
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch {
    throw new ContractError("ZOTERO_INVALID_UTF8", "Zotero source must be valid UTF-8 without BOM")
  }
  const lineEnding = strictLineEnding(bytes)
  const starts = allOffsets(bytes, startLiteral)
  const ends = allOffsets(bytes, endLiteral)
  if (starts.length !== 1 || ends.length !== 1) {
    throw new ContractError("ZOTERO_MARKER_COUNT_INVALID", "Zotero source must contain exactly one start and one end marker")
  }
  const start = starts[0]
  const end = ends[0]
  if (start >= end) throw new ContractError("ZOTERO_MARKER_ORDER_INVALID", "Zotero start marker must precede the end marker")
  const beginsLine = (/** @type {number} */ offset) => offset === 0 || bytes.subarray(offset - lineEnding.bytes.length, offset).equals(lineEnding.bytes)
  const followedByEol = (/** @type {number} */ offset, /** @type {Buffer} */ literal) => bytes.subarray(offset + literal.length, offset + literal.length + lineEnding.bytes.length).equals(lineEnding.bytes)
  if (!beginsLine(start) || !beginsLine(end) || !followedByEol(start, startLiteral) || !followedByEol(end, endLiteral)) {
    throw new ContractError("ZOTERO_MARKER_LINE_INVALID", "Zotero markers must be exact ASCII lines followed by the source line ending")
  }
  const startLineEnd = start + startLiteral.length + lineEnding.bytes.length
  const endLineEnd = end + endLiteral.length + lineEnding.bytes.length
  const regions = {
    prefix: bytes.subarray(0, start),
    start_marker_line: bytes.subarray(start, startLineEnd),
    managed_content: bytes.subarray(startLineEnd, end),
    end_marker_line: bytes.subarray(end, endLineEnd),
    suffix: bytes.subarray(endLineEnd),
  }
  return {
    ...regions,
    metadata: {
      encoding: "utf-8",
      bom: false,
      line_ending: lineEnding.name,
      start_marker_literal: ZOTERO_START_MARKER,
      end_marker_literal: ZOTERO_END_MARKER,
      marker_count: 1,
      marker_order: "start-before-end",
      prefix_sha256: sha256(regions.prefix),
      start_marker_line_sha256: sha256(regions.start_marker_line),
      end_marker_line_sha256: sha256(regions.end_marker_line),
      suffix_sha256: sha256(regions.suffix),
    },
    managed_content_sha256: sha256(regions.managed_content),
    source_sha256: sha256(bytes),
  }
}

/** @param {{baselineNode:any,currentBytes:Buffer,expectedSourceSha256:string}} input */
export function validateZoteroSourceDelta({ baselineNode, currentBytes, expectedSourceSha256 }) {
  if (!baselineNode?.zotero_baseline) throw new ContractError("ZOTERO_BASELINE_MISSING", "Zotero baseline target must contain complete marker metadata")
  const parsed = parseZoteroManagedBlock(currentBytes)
  if (parsed.source_sha256 !== expectedSourceSha256) {
    throw new ContractError("ZOTERO_READBACK_HASH_MISMATCH", "fresh Zotero export read-back does not match the manifest source hash")
  }
  if (jcsCanonicalize(parsed.metadata) !== jcsCanonicalize(baselineNode.zotero_baseline)) {
    throw new ContractError("ZOTERO_IMMUTABLE_REGION_CHANGED", "Zotero refresh changed bytes outside managed content")
  }
  return { parsed, noChange: parsed.source_sha256 === baselineNode.source_sha256 }
}

/** @param {{baselineReceipt:any,candidateArtifacts:Array<{path:string,sha256:string}>,targetPublicId:string,expectChange?:boolean}} input */
export function validateZoteroArtifactDelta({ baselineReceipt, candidateArtifacts, targetPublicId, expectChange = true }) {
  const targetPath = `papers/${targetPublicId}/index.html`
  const baseline = new Map(baselineReceipt.artifacts.map((/** @type {{path:string,sha256:string}} */ artifact) => [artifact.path, artifact.sha256]))
  const candidate = new Map(candidateArtifacts.map((artifact) => [artifact.path, artifact.sha256]))
  if (baseline.size !== baselineReceipt.artifacts.length || candidate.size !== candidateArtifacts.length
    || baseline.size !== candidate.size || [...baseline.keys()].some((artifactPath) => !candidate.has(artifactPath))) {
    throw new ContractError("ZOTERO_ARTIFACT_SET_CHANGED", "Zotero refresh must preserve the exact public artifact set")
  }
  if (!baseline.has(targetPath)) throw new ContractError("ZOTERO_TARGET_ARTIFACT_MISSING", "Zotero target paper artifact is absent from the current release")
  const changed = [...candidate].filter(([artifactPath, digest]) => baseline.get(artifactPath) !== digest).map(([artifactPath]) => artifactPath)
  if (changed.some((artifactPath) => artifactPath !== targetPath) || (expectChange && (changed.length !== 1 || changed[0] !== targetPath))) {
    throw new ContractError("ZOTERO_ARTIFACT_DELTA_INVALID", "Zotero refresh may change only the target paper page artifact")
  }
  return { changed }
}
