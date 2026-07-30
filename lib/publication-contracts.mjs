import { createHash } from "node:crypto"
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { TextDecoder, types as utilTypes } from "node:util"
import Ajv2020Module from "ajv/dist/2020.js"

const repoRoot = path.resolve(import.meta.dirname, "..")
const schemaFiles = {
  "publication-manifest": "publication-manifest-v1.schema.json",
  "export-receipt": "export-receipt-v1.schema.json",
  "release-receipt": "release-receipt-v1.schema.json",
  "current-release": "current-release-v1.schema.json",
}

export class ContractError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message)
    this.name = "ContractError"
    this.code = code
    this.details = details
  }
}

const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/
/** @param {string} value */
function timestampMilliseconds(value) {
  const match = timestampPattern.exec(value)
  if (!match) throw new ContractError("TIMESTAMP_INVALID", "timestamp must be RFC 3339 UTC with whole seconds and Z")
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== `${value.slice(0, -1)}.000Z`) {
    throw new ContractError("TIMESTAMP_INVALID", "timestamp is not a valid UTC calendar instant")
  }
  return milliseconds
}

const Ajv2020 = /** @type {any} */ (Ajv2020Module)
const ajv = new Ajv2020({ allErrors: true, strict: true })
ajv.addFormat("date-time", {
  type: "string",
  validate(/** @type {string} */ value) {
    try {
      timestampMilliseconds(value)
      return true
    } catch {
      return false
    }
  },
})
/** @type {Map<string, import("ajv").ValidateFunction>} */
const validators = new Map()
for (const [kind, filename] of Object.entries(schemaFiles)) {
  const schema = JSON.parse(await readFile(path.join(repoRoot, "schemas", filename), "utf8"))
  validators.set(kind, ajv.compile(schema))
}

/** Validate that a string contains Unicode scalar values only. @param {string} value */
function requireUnicodeScalars(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new ContractError("INVALID_UNICODE_SCALAR", "contract strings must contain only valid Unicode scalar values")
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new ContractError("INVALID_UNICODE_SCALAR", "contract strings must contain only valid Unicode scalar values")
    }
  }
}

/** RFC 8785 sorts object names lexicographically by UTF-16 code units. @param {string} first @param {string} second */
function compareUtf16(first, second) {
  const length = Math.min(first.length, second.length)
  for (let index = 0; index < length; index += 1) {
    const difference = first.charCodeAt(index) - second.charCodeAt(index)
    if (difference !== 0) return difference
  }
  return first.length - second.length
}

/** @param {PropertyDescriptor} descriptor */
function requireDataDescriptor(descriptor) {
  if (!Object.hasOwn(descriptor, "value")) {
    throw new ContractError("JCS_ACCESSOR_PROPERTY", "JCS input cannot contain accessor properties")
  }
  if (!descriptor.enumerable) {
    throw new ContractError("JCS_NON_ENUMERABLE_PROPERTY", "JCS input cannot contain non-enumerable data properties")
  }
  return descriptor.value
}

/** @param {string} name @param {number} length */
function isArrayElementName(name, length) {
  if (!(name === "0" || /^[1-9][0-9]*$/.test(name))) return false
  const index = Number(name)
  return Number.isSafeInteger(index) && index >= 0 && index < length
}

/**
 * Project-owned RFC 8785 serializer. Every ordinary object is captured once as
 * own property descriptors, then only descriptor values are traversed. Proxy is
 * rejected before reflection, so no getter, toJSON method, inherited property,
 * or Proxy trap can execute during canonicalization.
 * @param {unknown} value
 * @param {WeakSet<object>} ancestors
 * @returns {string}
 */
function serializeJcs(value, ancestors) {
  if (value === null) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "string") {
    requireUnicodeScalars(value)
    return /** @type {string} */ (JSON.stringify(value))
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ContractError("JCS_NON_FINITE_NUMBER", "JCS numbers must be finite IEEE 754 values")
    return /** @type {string} */ (JSON.stringify(value))
  }
  if (typeof value !== "object") {
    throw new ContractError("JCS_UNSUPPORTED_TYPE", `JCS cannot represent JavaScript ${typeof value} values`)
  }

  const object = /** @type {object} */ (value)
  if (utilTypes.isProxy(object)) throw new ContractError("JCS_PROXY", "JCS input cannot contain Proxy objects")
  if (ancestors.has(object)) throw new ContractError("JCS_CYCLE", "JCS values cannot contain cycles")
  const isArray = Array.isArray(value)
  if (!isArray) {
    const prototype = Object.getPrototypeOf(object)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ContractError("JCS_NON_PLAIN_OBJECT", "JCS objects must be plain objects")
    }
  }

  // This is the sole property snapshot for this object. It reads descriptors,
  // never property values through [[Get]], and is safe because Proxy was rejected.
  const descriptors = Object.getOwnPropertyDescriptors(object)
  const snapshotKeys = Reflect.ownKeys(descriptors)
  if (snapshotKeys.some((key) => typeof key === "symbol")) {
    throw new ContractError("JCS_SYMBOL_PROPERTY", "JCS input cannot contain own symbol properties")
  }
  const names = /** @type {string[]} */ (snapshotKeys)

  ancestors.add(object)
  try {
    if (isArray) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(descriptors, "length")?.value
      if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value")) {
        throw new ContractError("JCS_INVALID_VALUE", "JCS array length snapshot is invalid")
      }
      const length = lengthDescriptor.value
      const elementNames = names.filter((name) => name !== "length")
      if (elementNames.some((name) => !isArrayElementName(name, length))) {
        throw new ContractError("JCS_NAMED_ARRAY_PROPERTY", "JCS arrays cannot contain named properties")
      }
      const serialized = []
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(descriptors, String(index))?.value
        if (!descriptor) throw new ContractError("JCS_ARRAY_HOLE", "JCS arrays cannot contain holes")
        serialized.push(serializeJcs(requireDataDescriptor(descriptor), ancestors))
      }
      return `[${serialized.join(",")}]`
    }

    const entries = []
    names.sort(compareUtf16)
    for (const name of names) {
      requireUnicodeScalars(name)
      const descriptor = Object.getOwnPropertyDescriptor(descriptors, name)?.value
      if (!descriptor) throw new ContractError("JCS_INVALID_VALUE", "JCS property snapshot is incomplete")
      const serializedName = /** @type {string} */ (JSON.stringify(name))
      entries.push(`${serializedName}:${serializeJcs(requireDataDescriptor(descriptor), ancestors)}`)
    }
    return `{${entries.join(",")}}`
  } finally {
    ancestors.delete(object)
  }
}

/** @param {unknown} value */
export function jcsCanonicalize(value) {
  return serializeJcs(value, new WeakSet())
}
/** @param {unknown} value */
export function sha256Jcs(value) {
  return createHash("sha256").update(jcsCanonicalize(value), "utf8").digest("hex")
}

/** @param {string} value */
function requireNfc(value) {
  requireUnicodeScalars(value)
  if (value.normalize("NFC") !== value) throw new ContractError("NON_NFC_STRING", "digest-bound strings must already be Unicode NFC")
}
/** @param {unknown} value */
function requireNfcTree(value) {
  if (typeof value === "string") requireNfc(value)
  else if (Array.isArray(value)) for (const item of value) requireNfcTree(item)
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      requireNfc(key)
      requireNfcTree(item)
    }
  }
}

/** Unsigned lexicographic comparison of NFC UTF-8 bytes, naturally prefix-first. @param {string} first @param {string} second */
export function compareUtf8(first, second) {
  requireNfc(first)
  requireNfc(second)
  return Buffer.compare(Buffer.from(first, "utf8"), Buffer.from(second, "utf8"))
}
/** @param {{source:string,target:string}} first @param {{source:string,target:string}} second */
function compareEdges(first, second) {
  return compareUtf8(first.source, second.source) || compareUtf8(first.target, second.target)
}
/** @type {Record<string, (a:any, b:any) => number>} */
const vectorComparators = {
  nodes_by_public_id: (a, b) => compareUtf8(a.public_id, b.public_id),
  identity_projection_by_public_id: (a, b) => compareUtf8(a.public_id, b.public_id),
  support_ids: compareUtf8,
  added_node_ids: compareUtf8,
  direct_connection_edges: compareEdges,
  export_files_by_path: (a, b) => compareUtf8(a.path, b.path),
  release_artifacts_by_path: (a, b) => compareUtf8(a.path, b.path),
  content_fingerprints_by_public_id: (a, b) => compareUtf8(a.public_id, b.public_id),
}
/** @param {string} name @param {any[]} input */
export function sortContractArray(name, input) {
  const comparator = vectorComparators[name]
  if (!comparator) throw new ContractError("UNKNOWN_ORDERING_VECTOR", `unknown ordering vector ${name}`)
  return structuredClone(input).sort(comparator)
}

/** @param {any[]} array @param {(a:any,b:any)=>number} comparator @param {string} label */
function requireSortedUnique(array, comparator, label) {
  for (let index = 1; index < array.length; index += 1) {
    const comparison = comparator(array[index - 1], array[index])
    if (comparison > 0) throw new ContractError("ARRAY_NOT_SORTED", `${label} must use unsigned UTF-8 byte order`)
    if (comparison === 0) throw new ContractError("ARRAY_NOT_UNIQUE", `${label} must be unique by its digest-bound key`)
  }
}

/** @param {any[]} nodes */
export function computePublicSetDigest(nodes) {
  const identities = nodes.map(({ public_id, path: nodePath, node_class }) => ({ public_id, path: nodePath, node_class }))
  return sha256Jcs(identities)
}
/** @param {Record<string, any>} manifest */
export function computePlanDigest(manifest) {
  const plan = structuredClone(manifest)
  delete plan.approval_receipt
  delete plan.plan_digest
  return sha256Jcs(plan)
}

/** @param {unknown} value */
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

/** Map prose path invariants to deterministic errors before schema's generic pattern error. @param {string} candidate */
function validateRelativePath(candidate) {
  requireNfc(candidate)
  if (candidate.startsWith("//") || candidate.startsWith("\\\\")) throw new ContractError("PATH_UNC", "UNC paths are not allowed")
  if (/^[A-Za-z]:/.test(candidate)) throw new ContractError("PATH_DRIVE_ABSOLUTE", "drive-qualified paths are not allowed")
  if (candidate.startsWith("/")) throw new ContractError("PATH_ABSOLUTE", "absolute paths are not allowed")
  if (candidate.includes("\\")) throw new ContractError("PATH_BACKSLASH", "contract paths must use forward slashes")
  if (candidate.includes("\0")) throw new ContractError("PATH_NUL", "contract paths cannot contain NUL")
  const segments = candidate.split("/")
  if (segments.includes("..")) throw new ContractError("PATH_TRAVERSAL", "contract paths cannot traverse with ..")
  if (segments.includes("") || segments.includes(".")) throw new ContractError("PATH_NOT_NORMALIZED", "contract paths must be normalized relative paths")
}

/** @param {string[]} values @param {string} duplicateCode */
function rejectDuplicateStrings(values, duplicateCode) {
  const exact = new Set()
  const folded = new Map()
  for (const value of values) {
    if (exact.has(value)) throw new ContractError(duplicateCode, `duplicate value: ${value}`)
    exact.add(value)
    const key = value.toLowerCase()
    if (folded.has(key)) throw new ContractError("PATH_CASE_COLLISION", `case-insensitive path collision: ${value}`)
    folded.set(key, value)
  }
}

/** Run safe recognizers before schema validation so prose invariants retain stable codes. @param {string} kind @param {any} value */
function preSchemaChecks(kind, value) {
  requireNfcTree(value)
  if (!isRecord(value)) return
  const timestampFields = kind === "publication-manifest"
    ? [value.created_at, value.expires_at, value.approval_receipt?.approved_at]
    : kind === "export-receipt"
      ? [value.exported_at]
      : kind === "release-receipt"
        ? [value.created_at]
        : []
  for (const timestamp of timestampFields) {
    if (typeof timestamp === "string") timestampMilliseconds(timestamp)
  }
  /** @type {string[]} */
  const paths = []
  if ((kind === "publication-manifest" || kind === "release-receipt") && Array.isArray(value.nodes)) {
    const ids = value.nodes.flatMap((/** @type {any} */ node) => typeof node?.public_id === "string" ? [node.public_id] : [])
    if (new Set(ids).size !== ids.length) throw new ContractError("DUPLICATE_PUBLIC_ID", "public_id values must be unique")
    for (const node of value.nodes) if (typeof node?.path === "string") paths.push(node.path)
  }
  if (kind === "export-receipt" && Array.isArray(value.files)) {
    for (const file of value.files) if (typeof file?.path === "string") paths.push(file.path)
  }
  if (kind === "release-receipt" && Array.isArray(value.artifacts)) {
    for (const artifact of value.artifacts) if (typeof artifact?.path === "string") paths.push(artifact.path)
  }
  if (kind === "release-receipt" && Array.isArray(value.content_fingerprints)) {
    const fingerprintIds = value.content_fingerprints.flatMap((/** @type {any} */ fingerprint) => typeof fingerprint?.public_id === "string" ? [fingerprint.public_id] : [])
    if (new Set(fingerprintIds).size !== fingerprintIds.length) throw new ContractError("ARRAY_NOT_UNIQUE", "content fingerprints must be unique by public_id")
  }
  if (kind === "current-release" && typeof value.receipt_path === "string") paths.push(value.receipt_path)
  if (kind === "publication-manifest") {
    const action = value.action
    if (typeof action?.baseline?.receipt_path === "string") paths.push(action.baseline.receipt_path)
    if (typeof action?.baseline_receipt_path === "string") paths.push(action.baseline_receipt_path)
  }
  for (const contractPath of paths) validateRelativePath(contractPath)
  if (paths.length > 0) rejectDuplicateStrings(paths, "DUPLICATE_PATH")
  const action = value.action
  for (const array of [action?.support_ids, action?.added_node_ids]) {
    if (Array.isArray(array) && new Set(array).size !== array.length) throw new ContractError("ARRAY_NOT_UNIQUE", "digest-bound ID arrays must be unique")
  }
  if (Array.isArray(action?.direct_connection_edges)) {
    const edgeKeys = action.direct_connection_edges.map((/** @type {any} */ edge) => `${edge?.source}\u0000${edge?.target}`)
    if (new Set(edgeKeys).size !== edgeKeys.length) throw new ContractError("ARRAY_NOT_UNIQUE", "digest-bound edge arrays must be unique")
  }
}

/** @param {string} kind @param {unknown} value */
function validateSchema(kind, value) {
  const validator = validators.get(kind)
  if (!validator) throw new ContractError("UNKNOWN_CONTRACT_KIND", `unknown contract kind: ${kind}`)
  if (!validator(value)) {
    const first = [...(validator.errors ?? [])].sort((a, b) =>
      compareUtf8(a.instancePath, b.instancePath) || compareUtf8(a.keyword, b.keyword))[0]
    throw new ContractError("SCHEMA_INVALID", `schema validation failed at ${first?.instancePath || "/"}: ${first?.keyword || "invalid"}`, {
      schemaDraft: "2020-12",
      instancePath: first?.instancePath ?? "",
      keyword: first?.keyword ?? "invalid",
    })
  }
}

const classRoots = {
  paper: "Literature/Notes/",
  concept: "Knowledge/Concepts/",
  method: "Knowledge/Methods/",
  task: "Knowledge/Tasks/",
  author: "Knowledge/Authors/",
  synthesis: "Literature/Syntheses/",
  map: "Literature/Reviews & Maps/",
}
/** @param {any[]} nodes */
function validateNodes(nodes) {
  requireSortedUnique(nodes, vectorComparators.nodes_by_public_id, "nodes")
  rejectDuplicateStrings(nodes.map((node) => node.path), "DUPLICATE_PATH")
  for (const node of nodes) {
    if (!node.path.endsWith(".md")) throw new ContractError("SOURCE_PATH_EXTENSION", `${node.public_id} source path must end in .md`)
    const requiredRoot = classRoots[/** @type {keyof typeof classRoots} */ (node.node_class)]
    if (!node.path.startsWith(requiredRoot)) {
      throw new ContractError("CLASS_ROOT_MISMATCH", `${node.public_id} is outside the fixed root for ${node.node_class}`)
    }
  }
}

/** @param {any} manifest @param {{now?:string|Date}} options */
function validateManifest(manifest, options) {
  validateNodes(manifest.nodes)
  const created = timestampMilliseconds(manifest.created_at)
  const expires = timestampMilliseconds(manifest.expires_at)
  if (created >= expires) throw new ContractError("TIME_WINDOW_INVALID", "manifest requires created_at < expires_at")
  const approved = timestampMilliseconds(manifest.approval_receipt.approved_at)
  if (approved < created || approved >= expires) throw new ContractError("APPROVAL_TIME_INVALID", "approved_at must be within [created_at, expires_at)")
  if (options.now !== undefined) {
    let now
    if (options.now instanceof Date) {
      now = options.now.getTime()
      if (!Number.isFinite(now)) throw new ContractError("NOW_INVALID", "trusted current time must be a valid Date")
    } else {
      now = timestampMilliseconds(options.now)
    }
    if (now < created) throw new ContractError("MANIFEST_NOT_YET_VALID", "manifest is not yet valid")
    if (now >= expires) throw new ContractError("MANIFEST_EXPIRED", "manifest has expired")
  }

  const action = manifest.action
  const nodeById = new Map(manifest.nodes.map((/** @type {any} */ node) => [node.public_id, node]))
  if (action.kind === "publish-unit") {
    requireSortedUnique(action.support_ids, compareUtf8, "action.support_ids")
    requireSortedUnique(action.added_node_ids, compareUtf8, "action.added_node_ids")
    requireSortedUnique(action.direct_connection_edges, compareEdges, "action.direct_connection_edges")
    const primary = nodeById.get(action.primary_id)
    if (!primary || primary.node_class !== "paper") throw new ContractError("PRIMARY_NOT_PAPER", "primary_id must identify a listed paper")
    for (const supportId of action.support_ids) {
      const support = nodeById.get(supportId)
      if (!support || support.node_class === "paper") throw new ContractError("SUPPORT_NOT_FOUND", "support_ids must identify listed non-paper nodes")
    }
    for (const edge of action.direct_connection_edges) {
      if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) throw new ContractError("ACTION_EDGE_ENDPOINT_NOT_PUBLIC", "action edge endpoints must be listed nodes")
      if (edge.source !== action.primary_id || !action.support_ids.includes(edge.target)) {
        throw new ContractError("ACTION_EDGE_INVALID", "action edges must be exactly primary_id to support_id")
      }
    }
    if (action.direct_connection_edges.length !== action.support_ids.length ||
        action.support_ids.some((/** @type {string} */ id) => !action.direct_connection_edges.some((/** @type {any} */ edge) => edge.source === action.primary_id && edge.target === id))) {
      throw new ContractError("ACTION_EDGE_COVERAGE", "every support ID requires exactly one direct edge")
    }
  } else {
    const target = nodeById.get(action.target_id)
    if (!target || target.node_class !== "paper") throw new ContractError("REFRESH_TARGET_NOT_PAPER", "zotero target must identify a listed paper")
  }

  const publicSetDigest = computePublicSetDigest(manifest.nodes)
  if (manifest.public_set_digest !== publicSetDigest) throw new ContractError("PUBLIC_SET_DIGEST_MISMATCH", "public_set_digest does not match the identity projection")
  if (manifest.approval_receipt.approved_plan_digest !== manifest.plan_digest) {
    throw new ContractError("APPROVAL_DIGEST_MISMATCH", "approval receipt does not bind plan_digest")
  }
  const planDigest = computePlanDigest(manifest)
  if (manifest.plan_digest !== planDigest) throw new ContractError("PLAN_DIGEST_MISMATCH", "plan_digest does not match the JCS publication plan")
}

/** @param {string} root @param {string} candidate */
function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}
/** @param {string} root */
async function scanExportRoot(root) {
  /** @type {string} */
  let canonicalRoot
  try {
    const rootMetadata = await lstat(root)
    if (rootMetadata.isSymbolicLink()) throw new ContractError("PATH_SYMLINK_NOT_ALLOWED", "export root cannot itself be a symlink or reparse point")
    canonicalRoot = await realpath(root)
    if (!(await stat(canonicalRoot)).isDirectory()) throw new ContractError("EXPORT_ROOT_INVALID", "export root must be a directory")
  } catch (error) {
    if (error instanceof ContractError) throw error
    throw new ContractError("EXPORT_ROOT_INVALID", "export root must be a readable existing directory")
  }
  /** @type {string[]} */
  const files = []
  /** @param {string} directory */
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const metadata = await lstat(absolute)
      if (metadata.isSymbolicLink()) throw new ContractError("PATH_SYMLINK_NOT_ALLOWED", "export root cannot contain symlinks or reparse points")
      const resolved = await realpath(absolute)
      if (!inside(canonicalRoot, resolved)) throw new ContractError("PATH_CONTAINMENT_ESCAPE", "resolved export path escapes its root")
      if (metadata.isDirectory()) await walk(resolved)
      else if (metadata.isFile()) files.push(path.relative(canonicalRoot, resolved).split(path.sep).join("/"))
      else throw new ContractError("EXPORT_FILE_CLASS_INVALID", "export root may contain regular files only")
    }
  }
  await walk(canonicalRoot)
  return { canonicalRoot, files }
}

/** @param {any} receipt @param {{manifest?:any,exportRoot?:string,now?:string|Date}} options */
async function validateExportReceipt(receipt, options) {
  timestampMilliseconds(receipt.exported_at)
  requireSortedUnique(receipt.files, vectorComparators.export_files_by_path, "files")
  rejectDuplicateStrings(receipt.files.map((/** @type {any} */ file) => file.path), "DUPLICATE_PATH")
  if (options.manifest) {
    const manifest = options.manifest
    preSchemaChecks("publication-manifest", manifest)
    validateSchema("publication-manifest", manifest)
    validateManifest(manifest, options.now === undefined ? {} : { now: options.now })
    if (receipt.manifest_id !== manifest.manifest_id || receipt.plan_digest !== manifest.plan_digest) {
      throw new ContractError("EXPORT_MANIFEST_BINDING_MISMATCH", "export receipt does not bind the supplied manifest")
    }
    const exported = timestampMilliseconds(receipt.exported_at)
    if (exported < timestampMilliseconds(manifest.created_at) || exported >= timestampMilliseconds(manifest.expires_at)) {
      throw new ContractError("EXPORT_TIME_INVALID", "exported_at must be within the manifest window")
    }
    const nodeByPath = new Map(manifest.nodes.map((/** @type {any} */ node) => [node.path, node]))
    if (nodeByPath.size !== receipt.files.length || receipt.files.some((/** @type {any} */ file) => !nodeByPath.has(file.path))) {
      throw new ContractError("EXPORT_FILE_SET_MISMATCH", "export receipt files must exactly equal manifest node paths")
    }
    for (const file of receipt.files) {
      if (nodeByPath.get(file.path).source_sha256 !== file.source_sha256) {
        throw new ContractError("EXPORT_SOURCE_HASH_MISMATCH", "export receipt hash does not equal manifest source hash")
      }
    }
  }
  if (options.exportRoot) {
    const { canonicalRoot, files } = await scanExportRoot(options.exportRoot)
    const allowed = new Set(["export-receipt.json", ...receipt.files.map((/** @type {any} */ file) => file.path)])
    const unlisted = files.filter((file) => !allowed.has(file)).sort(compareUtf8)
    if (unlisted.length) throw new ContractError("EXPORT_UNLISTED_FILE", `unlisted export file: ${unlisted[0]}`)
    if (!files.includes("export-receipt.json")) throw new ContractError("EXPORT_RECEIPT_MISSING", "export root must contain export-receipt.json")
    const rootedReceipt = await readContractJson(path.join(canonicalRoot, "export-receipt.json"))
    if (jcsCanonicalize(rootedReceipt) !== jcsCanonicalize(receipt)) {
      throw new ContractError("EXPORT_RECEIPT_MISMATCH", "export-receipt.json does not equal the supplied receipt")
    }
    for (const file of receipt.files) {
      if (!files.includes(file.path)) throw new ContractError("EXPORT_FILE_MISSING", `missing exported file: ${file.path}`)
      const absolute = path.resolve(canonicalRoot, ...file.path.split("/"))
      if (!inside(canonicalRoot, absolute)) throw new ContractError("PATH_CONTAINMENT_ESCAPE", "export path escapes root")
      const resolved = await realpath(absolute)
      if (!inside(canonicalRoot, resolved)) throw new ContractError("PATH_CONTAINMENT_ESCAPE", "resolved export path escapes root")
      const digest = createHash("sha256").update(await readFile(resolved)).digest("hex")
      if (digest !== file.source_sha256) throw new ContractError("EXPORT_FILE_HASH_MISMATCH", `exported bytes do not match receipt: ${file.path}`)
    }
  }
}

/** Windows collision comparison is deliberately ASCII-only and locale-independent. @param {string} value */
function asciiCaseFold(value) {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 0x20))
}

/** @param {any} receipt */
function validateReleaseReceipt(receipt) {
  timestampMilliseconds(receipt.created_at)
  validateNodes(receipt.nodes)
  requireSortedUnique(receipt.artifacts, vectorComparators.release_artifacts_by_path, "artifacts")
  requireSortedUnique(receipt.content_fingerprints, vectorComparators.content_fingerprints_by_public_id, "content_fingerprints")
  if (receipt.content_fingerprints.length !== receipt.nodes.length ||
      receipt.content_fingerprints.some((/** @type {any} */ fingerprint, /** @type {number} */ index) => fingerprint.public_id !== receipt.nodes[index].public_id)) {
    throw new ContractError("RELEASE_FINGERPRINT_SET_MISMATCH", "content fingerprints must exactly equal the release node ID set")
  }
  for (let index = 0; index < receipt.nodes.length; index += 1) {
    const node = receipt.nodes[index]
    const expectedRoute = node.node_class === "paper" ? `/papers/${node.public_id}/` : `/knowledge/${node.node_class}/${node.public_id}/`
    if (receipt.content_fingerprints[index].route !== expectedRoute) {
      throw new ContractError("RELEASE_FINGERPRINT_ROUTE_MISMATCH", "content fingerprint route must match its node class and public ID")
    }
  }
  rejectDuplicateStrings(receipt.artifacts.map((/** @type {any} */ artifact) => artifact.path), "DUPLICATE_PATH")
  if (receipt.artifacts.some((/** @type {any} */ artifact) => {
    const normalizedSegments = artifact.path.split("/")
    const basename = normalizedSegments[normalizedSegments.length - 1]
    return asciiCaseFold(basename) === "release-receipt.json"
  })) {
    throw new ContractError("RELEASE_RECEIPT_ARTIFACT", "release receipt cannot list itself as an artifact")
  }
  if (receipt.public_set_digest !== computePublicSetDigest(receipt.nodes)) {
    throw new ContractError("PUBLIC_SET_DIGEST_MISMATCH", "release public_set_digest does not match node identities")
  }
  const unsigned = structuredClone(receipt)
  delete unsigned.release_digest
  if (receipt.release_digest !== sha256Jcs(unsigned)) throw new ContractError("RELEASE_DIGEST_MISMATCH", "release_digest does not match the JCS receipt")
}

/** @param {unknown} error @param {string} code */
function hasErrorCode(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code)
}

/** Establish a canonical, existing runtime directory whose complete absolute ancestor chain is non-reparse. @param {string} root */
async function openRuntimeRoot(root) {
  if (typeof root !== "string" || root.length === 0) throw new ContractError("RUNTIME_ROOT_INVALID", "runtime root must be a readable existing directory")
  const absoluteRoot = path.resolve(root)
  const parsed = path.parse(absoluteRoot)
  const segments = absoluteRoot.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let candidate = parsed.root
  try {
    // A regular final child is still untrusted when any ancestor is a junction.
    // Inspect the filesystem anchor and every named layer before canonicalization.
    for (const [index, segment] of ["", ...segments].entries()) {
      if (index > 0) candidate = path.join(candidate, segment)
      const metadata = await lstat(candidate)
      if (metadata.isSymbolicLink()) throw new ContractError("PATH_SYMLINK_NOT_ALLOWED", "runtime root cannot contain a symlink, junction, or reparse point")
      if (!metadata.isDirectory()) throw new ContractError("RUNTIME_ROOT_INVALID", "runtime root and every ancestor layer must be a directory")
    }
    const canonicalRoot = await realpath(absoluteRoot)
    const canonicalMetadata = await lstat(canonicalRoot)
    if (canonicalMetadata.isSymbolicLink() || !canonicalMetadata.isDirectory()) throw new ContractError("RUNTIME_ROOT_INVALID", "runtime root must be a canonical directory")
    return { canonicalRoot }
  } catch (error) {
    if (error instanceof ContractError) throw error
    throw new ContractError("RUNTIME_ROOT_INVALID", "runtime root must be a readable existing directory")
  }
}

/** Reject ambiguous case aliases before selecting an exact child. @param {string[]} names */
function rejectDirectoryCaseCollisions(names) {
  const folded = new Set()
  for (const name of names) {
    const key = asciiCaseFold(name)
    if (folded.has(key)) throw new ContractError("PATH_CASE_COLLISION", "runtime directory contains a case-insensitive name collision")
    folded.add(key)
  }
}

/**
 * Require the directory snapshot to contain the exact expected spelling. When
 * it does not, probe that spelling without following the final entry: Windows
 * may resolve a non-ASCII UpCase alias that the locale-independent ASCII
 * fallback cannot identify from names alone.
 * @param {string} directory
 * @param {string[]} names
 * @param {string} expectedSegment
 */
async function hasExactRuntimeSegment(directory, names, expectedSegment) {
  if (names.includes(expectedSegment)) return true
  try {
    await lstat(path.join(directory, expectedSegment))
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw new ContractError("RUNTIME_READ_FAILED", "runtime contract path metadata could not be read")
    }
    if (names.some((name) => asciiCaseFold(name) === asciiCaseFold(expectedSegment))) {
      throw new ContractError("PATH_CASE_COLLISION", "runtime contract path casing is not canonical")
    }
    return false
  }
  throw new ContractError("PATH_CASE_COLLISION", "runtime contract path spelling is not canonical")
}

/** @param {import("node:fs").BigIntStats} before @param {import("node:fs").BigIntStats} after @param {"file"|"directory"} kind */
function sameStableRuntimeMetadata(before, after, kind) {
  const sameClass = kind === "file"
    ? before.isFile() && after.isFile()
    : before.isDirectory() && after.isDirectory()
  return sameClass && !before.isSymbolicLink() && !after.isSymbolicLink()
    && before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.size === after.size && before.mtimeNs === after.mtimeNs
}

/** Read one canonical ordinary runtime directory with a stable metadata snapshot. @param {{canonicalRoot:string}} opened @param {string} directory */
async function readStableRuntimeDirectory(opened, directory) {
  try {
    const before = await lstat(directory, { bigint: true })
    if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("not an ordinary directory")
    const resolved = await realpath(directory)
    if (resolved !== directory || !inside(opened.canonicalRoot, resolved)) throw new Error("not canonical inside runtime root")
    const names = await readdir(directory)
    const after = await lstat(directory, { bigint: true })
    if (!sameStableRuntimeMetadata(before, after, "directory")) throw new Error("directory changed during read")
    rejectDirectoryCaseCollisions(names)
    return names
  } catch (error) {
    if (error instanceof ContractError) throw error
    throw new ContractError("RUNTIME_READ_FAILED", "runtime contract directory could not be read stably")
  }
}

/** Traverse exact ordinary/canonical directory segments without following links. @param {{canonicalRoot:string}} opened @param {string[]} segments @param {string} missingCode */
async function traverseRuntimeDirectory(opened, segments, missingCode) {
  let directory = opened.canonicalRoot
  for (const segment of segments) {
    const names = await readStableRuntimeDirectory(opened, directory)
    if (!await hasExactRuntimeSegment(directory, names, segment)) {
      throw new ContractError(missingCode, "required runtime custody directory is missing")
    }
    const candidate = path.join(directory, segment)
    try {
      const metadata = await lstat(candidate, { bigint: true })
      if (metadata.isSymbolicLink()) throw new ContractError("PATH_SYMLINK_NOT_ALLOWED", "runtime custody cannot contain a symlink, junction, or reparse point")
      if (!metadata.isDirectory()) throw new ContractError("RUNTIME_FILE_CLASS_INVALID", "runtime custody layers must be ordinary directories")
      const resolved = await realpath(candidate)
      if (resolved !== candidate || !inside(opened.canonicalRoot, resolved)) {
        throw new ContractError("PATH_CONTAINMENT_ESCAPE", "runtime custody does not resolve canonically inside its root")
      }
      directory = resolved
    } catch (error) {
      if (error instanceof ContractError) throw error
      if (hasErrorCode(error, "ENOENT")) throw new ContractError(missingCode, "required runtime custody directory is missing")
      throw new ContractError("RUNTIME_READ_FAILED", "runtime custody metadata could not be read")
    }
  }
  return directory
}

/** Stable exact-byte reader for one normalized runtime contract path. @param {{canonicalRoot:string}} opened @param {string} relativePath @param {string} missingCode */
async function readStableRuntimeContract(opened, relativePath, missingCode) {
  validateRelativePath(relativePath)
  const segments = relativePath.split("/")
  const filename = /** @type {string} */ (segments.pop())
  const directory = await traverseRuntimeDirectory(opened, segments, missingCode)
  const names = await readStableRuntimeDirectory(opened, directory)
  if (!await hasExactRuntimeSegment(directory, names, filename)) {
    throw new ContractError(missingCode, "required runtime contract is missing")
  }
  const absolute = path.join(directory, filename)
  try {
    const before = await lstat(absolute, { bigint: true })
    if (before.isSymbolicLink()) throw new ContractError("PATH_SYMLINK_NOT_ALLOWED", "runtime contract cannot be a symlink, junction, or reparse point")
    if (!before.isFile()) throw new ContractError("RUNTIME_FILE_CLASS_INVALID", "runtime contract must be an ordinary regular file")
    const resolved = await realpath(absolute)
    if (resolved !== absolute || !inside(opened.canonicalRoot, resolved)) {
      throw new ContractError("PATH_CONTAINMENT_ESCAPE", "runtime contract does not resolve canonically inside its root")
    }
    const bytes = await readFile(absolute)
    const after = await lstat(absolute, { bigint: true })
    if (!sameStableRuntimeMetadata(before, after, "file") || BigInt(bytes.length) !== before.size) {
      throw new ContractError("RUNTIME_CONTRACT_CHANGED_DURING_READ", "runtime contract changed during stable read")
    }
    return { absolute, bytes, value: decodeContractJsonBytes(bytes) }
  } catch (error) {
    if (error instanceof ContractError) throw error
    if (hasErrorCode(error, "ENOENT")) throw new ContractError(missingCode, "required runtime contract is missing")
    throw new ContractError("RUNTIME_READ_FAILED", "runtime contract bytes could not be read stably")
  }
}

/** Genesis requires both the fixed pointer and every possible consumed history entry to be absent. @param {{canonicalRoot:string}} opened */
async function requireGenesisHistoryAbsent(opened) {
  const names = await readStableRuntimeDirectory(opened, opened.canonicalRoot)
  if (!await hasExactRuntimeSegment(opened.canonicalRoot, names, "consumed")) return
  let consumed
  try {
    consumed = await traverseRuntimeDirectory(opened, ["consumed"], "GENESIS_HISTORY_PRESENT")
  } catch (error) {
    if (error instanceof ContractError && error.code === "RUNTIME_FILE_CLASS_INVALID") {
      throw new ContractError("GENESIS_HISTORY_PRESENT", "genesis is forbidden when consumed history may exist")
    }
    throw error
  }
  const entries = await readStableRuntimeDirectory(opened, consumed)
  if (entries.length > 0) throw new ContractError("GENESIS_HISTORY_PRESENT", "genesis is forbidden when consumed receipt history may exist")
}

/**
 * Shared strict reader for one manifest-keyed sealed custody directory. The
 * caller supplies role-specific redacted codes; both fixed-current and target
 * custody therefore use the same traversal, exact-set, decoder, canonical
 * receipt, digest, schema, and historical-time validation boundary.
 * @param {{canonicalRoot:string}} opened @param {string} manifestId
 * @param {{missing:string,invalid:string,receiptMissing:string,receiptFormat:string,identity:string}} codes
 */
async function loadSealedCustodyAuthority(opened, manifestId, codes) {
  const custodyRelative = `consumed/${manifestId}`
  let custodyRoot
  try {
    custodyRoot = await traverseRuntimeDirectory(opened, custodyRelative.split("/"), codes.missing)
  } catch (error) {
    if (error instanceof ContractError) throw error
    throw new ContractError(codes.invalid, "sealed custody is not an exact stable ordinary directory")
  }

  let custodyNames
  try {
    custodyNames = (await readStableRuntimeDirectory(opened, custodyRoot)).sort(compareUtf8)
  } catch (error) {
    if (error instanceof ContractError && error.code === "PATH_CASE_COLLISION") throw error
    throw new ContractError(codes.invalid, "sealed custody is not an exact stable ordinary directory")
  }
  if (sameStrings(custodyNames, ["manifest.json"])) {
    throw new ContractError(codes.receiptMissing, "required sealed release receipt is missing")
  }
  if (!sameStrings(custodyNames, ["manifest.json", "release-receipt.json"])) {
    throw new ContractError(codes.invalid, "sealed custody does not contain the exact contract set")
  }

  const receiptPath = `${custodyRelative}/release-receipt.json`
  const receiptDocument = await readStableRuntimeContract(opened, receiptPath, codes.receiptMissing)
  const receipt = /** @type {any} */ (receiptDocument.value)
  await validateContract("release-receipt", receipt)
  if (!receiptDocument.bytes.equals(Buffer.from(`${jcsCanonicalize(receipt)}\n`, "utf8"))) {
    throw new ContractError(codes.receiptFormat, "sealed release receipt must be canonical JSON followed by one LF")
  }
  if (receipt.manifest_id !== manifestId) {
    throw new ContractError(codes.identity, "sealed custody identity does not match its fixed directory")
  }

  const manifestDocument = await readStableRuntimeContract(opened, `${custodyRelative}/manifest.json`, codes.invalid)
  const manifest = /** @type {any} */ (manifestDocument.value)
  await validateReleaseAgainstManifest(receipt, manifest, { now: receipt.created_at })
  const finalCustodyNames = (await readStableRuntimeDirectory(opened, custodyRoot)).sort(compareUtf8)
  if (!sameStrings(finalCustodyNames, ["manifest.json", "release-receipt.json"])) {
    throw new ContractError(codes.invalid, "sealed custody changed during read")
  }
  return {
    custodyRoot,
    receiptPath,
    manifest,
    manifestRaw: manifestDocument.bytes,
    receipt,
    receiptRaw: receiptDocument.bytes,
  }
}

/** Load one fixed current pointer and its complete sealed custody authority. @param {{canonicalRoot:string}} opened */
async function loadSealedCurrentAuthority(opened) {
  const pointerDocument = await readStableRuntimeContract(opened, "current-release.json", "CURRENT_POINTER_ABSENT")
  const pointer = /** @type {any} */ (pointerDocument.value)
  await validateContract("current-release", pointer)
  if (!pointerDocument.bytes.equals(Buffer.from(`${jcsCanonicalize(pointer)}\n`, "utf8"))) {
    throw new ContractError("CURRENT_POINTER_FORMAT_INVALID", "current release pointer must be canonical JSON followed by one LF")
  }

  const pathSegments = pointer.receipt_path.split("/")
  if (pathSegments.length !== 3 || pathSegments[0] !== "consumed" || pathSegments[2] !== "release-receipt.json") {
    throw new ContractError("CURRENT_RECEIPT_PATH_MISMATCH", "current receipt path is not the fixed sealed custody path")
  }
  const custody = await loadSealedCustodyAuthority(opened, pathSegments[1], {
    missing: "CURRENT_RECEIPT_MISSING",
    invalid: "CURRENT_CUSTODY_INVALID",
    receiptMissing: "CURRENT_RECEIPT_MISSING",
    receiptFormat: "CURRENT_RECEIPT_FORMAT_INVALID",
    identity: "CURRENT_RECEIPT_PATH_MISMATCH",
  })
  if (pointer.receipt_path !== custody.receiptPath) {
    throw new ContractError("CURRENT_RECEIPT_PATH_MISMATCH", "current receipt path does not match the sealed manifest identity")
  }
  if (pointer.release_digest !== custody.receipt.release_digest) {
    throw new ContractError("CURRENT_RELEASE_DIGEST_MISMATCH", "current pointer digest does not equal the receipt stored and recomputed digest")
  }
  return {
    currentPointer: pointer,
    currentReceipt: custody.receipt,
    receiptPath: pointer.receipt_path,
    currentManifest: custody.manifest,
    currentManifestRaw: custody.manifestRaw,
    currentReceiptRaw: custody.receiptRaw,
    currentPointerRaw: pointerDocument.bytes,
  }
}

/**
 * Read a sealed custody selected by an already standalone-validated manifest ID,
 * not by the fixed current pointer. Unlike loadPublicationRuntime, this target
 * reader does not claim the custody is current and never follows an arbitrary
 * receipt path. The strict ASCII ID check happens before any path composition.
 * @param {string} runtimeRoot @param {string} manifestId
 */
export async function loadSealedCustodyByManifestId(runtimeRoot, manifestId) {
  if (typeof manifestId !== "string" || !/^VPUB-[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifestId)) {
    throw new ContractError("TARGET_MANIFEST_ID_INVALID", "target manifest identity is invalid")
  }
  const opened = await openRuntimeRoot(runtimeRoot)
  return loadSealedCustodyAuthority(opened, manifestId, {
    missing: "TARGET_CUSTODY_ABSENT",
    invalid: "TARGET_CUSTODY_INVALID",
    receiptMissing: "TARGET_CUSTODY_INVALID",
    receiptFormat: "TARGET_RECEIPT_FORMAT_INVALID",
    identity: "TARGET_CUSTODY_IDENTITY_MISMATCH",
  })
}

/**
 * Read-only loader for the fixed runtime current pointer and its complete sealed
 * custody. Genesis requires a genuinely absent pointer and empty/absent consumed
 * history. Portable metadata checks do not claim privileged-writer resistance.
 * @param {string} runtimeRoot
 */
export async function loadPublicationRuntime(runtimeRoot) {
  const opened = await openRuntimeRoot(runtimeRoot)
  try {
    return await loadSealedCurrentAuthority(opened)
  } catch (error) {
    if (error instanceof ContractError && error.code === "CURRENT_POINTER_ABSENT") {
      await requireGenesisHistoryAbsent(opened)
      return {
        currentPointer: undefined,
        currentReceipt: undefined,
        receiptPath: undefined,
        currentManifest: undefined,
        currentManifestRaw: undefined,
        currentReceiptRaw: undefined,
        currentPointerRaw: undefined,
      }
    }
    throw error
  }
}

/** @param {string[]} actual @param {string[]} expected */
function sameStrings(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

/** Validate the pointer/receipt/path three-way independently of filesystem provenance. @param {any} state */
async function validateCurrentState(state) {
  const pointer = state.currentPointer
  const receipt = state.currentReceipt
  if (pointer === undefined && receipt === undefined && state.receiptPath === undefined) return undefined
  if (pointer === undefined || receipt === undefined || state.receiptPath === undefined) {
    throw new ContractError("CURRENT_STATE_INCOMPLETE", "current release context must contain pointer, receipt, and resolved receipt path")
  }
  await validateContract("current-release", pointer)
  await validateContract("release-receipt", receipt)
  if (state.receiptPath !== pointer.receipt_path) {
    throw new ContractError("CURRENT_RECEIPT_PATH_MISMATCH", "resolved receipt path does not equal current pointer path")
  }
  if (pointer.release_digest !== receipt.release_digest) {
    throw new ContractError("CURRENT_RELEASE_DIGEST_MISMATCH", "current pointer digest does not equal the receipt stored and recomputed digest")
  }
  return { pointer, receipt, receiptPath: state.receiptPath }
}

/** @param {any} action @param {{pointer:any,receipt:any,receiptPath:string}} current */
function requireActionCurrentBinding(action, current) {
  const actionPath = action.kind === "publish-unit" ? action.baseline.receipt_path : action.baseline_receipt_path
  const actionDigest = action.kind === "publish-unit" ? action.baseline.release_digest : action.baseline_release_digest
  if (actionPath !== current.pointer.receipt_path || actionDigest !== current.pointer.release_digest ||
      actionPath !== current.receiptPath) {
    throw new ContractError("STALE_BASELINE", "action baseline does not equal the validated current release")
  }
  if (actionDigest !== current.receipt.release_digest) {
    throw new ContractError("STALE_BASELINE", "action baseline does not equal the validated current release")
  }
}

/** @param {any} manifest @param {any} receipt */
function validatePublishEquations(manifest, receipt) {
  const action = manifest.action
  const manifestById = new Map(manifest.nodes.map((/** @type {any} */ node) => [node.public_id, node]))
  const baselineById = new Map(receipt.nodes.map((/** @type {any} */ node) => [node.public_id, node]))
  for (const baselineNode of receipt.nodes) {
    const candidate = manifestById.get(baselineNode.public_id)
    if (!candidate) throw new ContractError("BASELINE_NODE_MISSING", "manifest cannot remove a baseline node")
    if (candidate.node_class !== baselineNode.node_class) throw new ContractError("BASELINE_NODE_CLASS_CHANGED", "manifest cannot reclassify a baseline node")
    if (candidate.path !== baselineNode.path) throw new ContractError("BASELINE_NODE_PATH_CHANGED", "manifest cannot change a baseline node path")
    if (candidate.source_sha256 !== baselineNode.source_sha256) throw new ContractError("BASELINE_SOURCE_CHANGED", "publish-unit cannot change a baseline source hash")
  }
  const expectedAdded = manifest.nodes.filter((/** @type {any} */ node) => !baselineById.has(node.public_id)).map((/** @type {any} */ node) => node.public_id)
  if (!sameStrings(action.added_node_ids, expectedAdded)) {
    throw new ContractError("ADDED_NODE_SET_MISMATCH", "added_node_ids must exactly equal manifest IDs absent from baseline")
  }
  if (!action.added_node_ids.includes(action.primary_id) ||
      action.added_node_ids.some((/** @type {string} */ id) => id !== action.primary_id && !action.support_ids.includes(id))) {
    throw new ContractError("ADDED_NODE_SCOPE_INVALID", "added_node_ids may contain only the new primary and new direct support nodes")
  }
}

/** @param {any} manifest @param {any} receipt */
function validateZoteroEquations(manifest, receipt) {
  const targetId = manifest.action.target_id
  const manifestById = new Map(manifest.nodes.map((/** @type {any} */ node) => [node.public_id, node]))
  const baselineById = new Map(receipt.nodes.map((/** @type {any} */ node) => [node.public_id, node]))
  if (!sameStrings([...manifestById.keys()], [...baselineById.keys()])) {
    throw new ContractError("ZOTERO_NODE_SET_CHANGED", "zotero refresh must preserve the complete public ID set")
  }
  for (const baselineNode of receipt.nodes) {
    const candidate = manifestById.get(baselineNode.public_id)
    if (candidate.node_class !== baselineNode.node_class) throw new ContractError("ZOTERO_NODE_CLASS_CHANGED", "zotero refresh cannot reclassify a node")
    if (candidate.path !== baselineNode.path) throw new ContractError("ZOTERO_NODE_PATH_CHANGED", "zotero refresh cannot change a node path")
    if (baselineNode.public_id !== targetId && candidate.source_sha256 !== baselineNode.source_sha256) {
      throw new ContractError("ZOTERO_NON_TARGET_SOURCE_CHANGED", "zotero refresh cannot change a non-target source hash")
    }
  }
  if (manifest.public_set_digest !== receipt.public_set_digest) {
    throw new ContractError("ZOTERO_PUBLIC_SET_CHANGED", "zotero refresh public_set_digest must equal baseline")
  }
  const target = baselineById.get(targetId)
  if (!target || target.node_class !== "paper") throw new ContractError("ZOTERO_TARGET_INVALID", "zotero baseline target must exist and remain a paper")
  if (!target.zotero_baseline) throw new ContractError("ZOTERO_BASELINE_MISSING", "zotero baseline target must contain complete marker metadata")
}

/**
 * Pure cross-release composition seam. Values are validated with the same Phase A
 * validators before genesis/current/baseline/public-set equations are evaluated.
 * @param {any} manifest
 * @param {{now?:string|Date,currentPointer?:any,currentReceipt?:any,receiptPath?:string}} state
 */
export async function validateCrossReleaseManifest(manifest, state = {}) {
  await validateContract("publication-manifest", manifest, state.now === undefined ? {} : { now: state.now })
  const current = await validateCurrentState(state)
  const action = manifest.action
  if (action.kind === "publish-unit") {
    if (!current) {
      if (action.baseline.kind !== "genesis") throw new ContractError("GENESIS_BASELINE_REQUIRED", "publish-unit without current release requires exactly the genesis baseline object")
      const manifestIds = manifest.nodes.map((/** @type {any} */ node) => node.public_id)
      if (!sameStrings(action.added_node_ids, manifestIds)) {
        throw new ContractError("ADDED_NODE_SET_MISMATCH", "genesis added_node_ids must exactly equal all manifest public IDs")
      }
      if (!action.added_node_ids.includes(action.primary_id) ||
          action.added_node_ids.some((/** @type {string} */ id) => id !== action.primary_id && !action.support_ids.includes(id))) {
        throw new ContractError("ADDED_NODE_SCOPE_INVALID", "genesis nodes may contain only the approved publication unit")
      }
    } else {
      if (action.baseline.kind !== "release") throw new ContractError("RELEASE_BASELINE_REQUIRED", "publish-unit with current release requires exactly a release baseline object")
      requireActionCurrentBinding(action, current)
      validatePublishEquations(manifest, current.receipt)
    }
  } else {
    if (!current) throw new ContractError("CURRENT_RELEASE_REQUIRED", "zotero refresh requires a validated current release")
    requireActionCurrentBinding(action, current)
    validateZoteroEquations(manifest, current.receipt)
  }
  return { kind: "publication-manifest", schemaVersion: manifest.schema_version, value: manifest }
}

/** Read runtime state and apply the pure composition contract. @param {any} manifest @param {{now:string|Date,runtimeRoot:string}} options */
export async function validatePublicationPreflight(manifest, options) {
  if (!options || options.now === undefined || !options.runtimeRoot) throw new ContractError("CONTEXT_REQUIRED", "manifest preflight requires trusted time and runtime root")
  const state = await loadPublicationRuntime(options.runtimeRoot)
  return validateCrossReleaseManifest(manifest, { ...state, now: options.now })
}

/**
 * Cross-bind a candidate release receipt to a standalone-valid manifest.
 * Trusted current time remains opt-in for library callers.
 * @param {any} receipt
 * @param {any} manifest
 * @param {{now?:string|Date}} [options]
 */
export async function validateReleaseAgainstManifest(receipt, manifest, options = {}) {
  await validateContract("publication-manifest", manifest, options.now === undefined ? {} : { now: options.now })
  await validateContract("release-receipt", receipt)
  if (receipt.manifest_id !== manifest.manifest_id || receipt.plan_digest !== manifest.plan_digest) {
    throw new ContractError("RELEASE_MANIFEST_BINDING_MISMATCH", "release receipt does not bind manifest ID and plan digest")
  }
  if (receipt.nodes.length !== manifest.nodes.length ||
      receipt.nodes.some((/** @type {any} */ node, /** @type {number} */ index) => node.public_id !== manifest.nodes[index].public_id)) {
    throw new ContractError("RELEASE_NODE_SET_MISMATCH", "release receipt nodes must exactly equal manifest public IDs")
  }
  for (let index = 0; index < receipt.nodes.length; index += 1) {
    const releaseNode = receipt.nodes[index]
    const manifestNode = manifest.nodes[index]
    if (releaseNode.path !== manifestNode.path || releaseNode.node_class !== manifestNode.node_class) {
      throw new ContractError("RELEASE_NODE_IDENTITY_MISMATCH", "release receipt node path and class must equal manifest")
    }
    if (releaseNode.source_sha256 !== manifestNode.source_sha256) {
      throw new ContractError("RELEASE_NODE_SOURCE_MISMATCH", "release receipt node source hash must equal manifest")
    }
  }
  if (receipt.public_set_digest !== manifest.public_set_digest) {
    throw new ContractError("RELEASE_MANIFEST_BINDING_MISMATCH", "release receipt does not bind manifest public-set digest")
  }
  return { kind: "release-receipt", schemaVersion: receipt.schema_version, value: receipt }
}

/** Validate that a supplied pointer is exactly the fixed current sealed authority. @param {any} pointer @param {{runtimeRoot:string}} options */
export async function validateCurrentReleaseCandidate(pointer, options) {
  if (!options?.runtimeRoot) throw new ContractError("CONTEXT_REQUIRED", "current-release preflight requires runtime root")
  await validateContract("current-release", pointer)
  const authority = await loadPublicationRuntime(options.runtimeRoot)
  if (!authority.currentPointer || jcsCanonicalize(pointer) !== jcsCanonicalize(authority.currentPointer)) {
    throw new ContractError("CURRENT_POINTER_MISMATCH", "supplied current pointer does not equal the fixed runtime pointer authority")
  }
  return {
    kind: "current-release",
    schemaVersion: pointer.schema_version,
    value: authority.currentPointer,
    receipt: authority.currentReceipt,
    manifest: authority.currentManifest,
    manifestRaw: authority.currentManifestRaw,
  }
}

/**
 * Phase A standalone validation. Phase B can inject a separately validated
 * current pointer/receipt through later orchestration without weakening this seam.
 * This function performs reads only and never writes source or output.
 * @param {string} kind
 * @param {unknown} value
 * @param {{now?:string|Date,manifest?:any,exportRoot?:string,currentReceipt?:any,currentPointer?:any}} [options]
 */
export async function validateContract(kind, value, options = {}) {
  preSchemaChecks(kind, value)
  validateSchema(kind, value)
  const document = /** @type {any} */ (value)
  if (kind === "publication-manifest") validateManifest(document, options)
  else if (kind === "export-receipt") await validateExportReceipt(document, options)
  else if (kind === "release-receipt") validateReleaseReceipt(document)
  else if (kind === "current-release") validateRelativePath(document.receipt_path)
  return { kind, schemaVersion: document.schema_version, value: document }
}

/**
 * Composable Phase A result for Phase B. Supplied current state is validated
 * independently, but no genesis/baseline identity or set equation is evaluated
 * here. Phase B must consume these validated values and enforce those equations.
 * @param {{manifest:any,exportReceipt?:any,exportRoot?:string,currentReceipt?:any,currentPointer?:any,now?:string|Date}} bundle
 */
export async function validateStandaloneBundle(bundle) {
  const manifest = await validateContract("publication-manifest", bundle.manifest, bundle.now === undefined ? {} : { now: bundle.now })
  const exportReceipt = bundle.exportReceipt === undefined
    ? undefined
    : await validateContract("export-receipt", bundle.exportReceipt, {
      manifest: manifest.value,
      ...(bundle.exportRoot ? { exportRoot: bundle.exportRoot } : {}),
    })
  const currentReceipt = bundle.currentReceipt === undefined
    ? undefined
    : await validateContract("release-receipt", bundle.currentReceipt)
  const currentPointer = bundle.currentPointer === undefined
    ? undefined
    : await validateContract("current-release", bundle.currentPointer)
  return { manifest, exportReceipt, currentReceipt, currentPointer }
}

/**
 * Small auditable recursive-descent JSON parser. Duplicate checks happen when a
 * decoded member name is read, before any assignment can overwrite information.
 * @param {string} text
 */
function parseIJson(text) {
  let index = 0
  /** @returns {never} */
  const syntax = () => { throw new SyntaxError(`invalid JSON at offset ${index}`) }
  const skipWhitespace = () => {
    while (index < text.length && (text[index] === " " || text[index] === "\t" || text[index] === "\r" || text[index] === "\n")) index += 1
  }
  /** @param {string} value */
  const scalarString = (value) => {
    try {
      requireUnicodeScalars(value)
    } catch {
      throw new ContractError("INPUT_INVALID_UNICODE", "contract JSON strings must contain Unicode scalar values only")
    }
    return value
  }
  const parseString = () => {
    if (text[index] !== '"') syntax()
    index += 1
    let decoded = ""
    while (index < text.length) {
      const character = text[index]
      const codeUnit = text.charCodeAt(index)
      if (character === '"') {
        index += 1
        return scalarString(decoded)
      }
      if (codeUnit <= 0x1f) syntax()
      if (character !== "\\") {
        decoded += character
        index += 1
        continue
      }
      index += 1
      const escape = text[index]
      if (escape === "u") {
        const hexadecimal = text.slice(index + 1, index + 5)
        if (!/^[0-9a-fA-F]{4}$/.test(hexadecimal)) syntax()
        decoded += String.fromCharCode(Number.parseInt(hexadecimal, 16))
        index += 5
        continue
      }
      const escapedCharacters = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }
      if (!escape || !Object.hasOwn(escapedCharacters, escape)) syntax()
      decoded += escapedCharacters[/** @type {keyof typeof escapedCharacters} */ (escape)]
      index += 1
    }
    syntax()
  }
  const parseNumber = () => {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index))
    if (!match) syntax()
    index += match[0].length
    const value = Number(match[0])
    if (!Number.isFinite(value)) throw new ContractError("INPUT_NUMBER_OUT_OF_RANGE", "contract JSON numbers must be finite IEEE 754 values")
    return value
  }
  const parseArray = () => {
    index += 1
    skipWhitespace()
    /** @type {unknown[]} */
    const array = []
    if (text[index] === "]") {
      index += 1
      return array
    }
    while (true) {
      array.push(parseValue())
      skipWhitespace()
      if (text[index] === "]") {
        index += 1
        return array
      }
      if (text[index] !== ",") syntax()
      index += 1
      skipWhitespace()
    }
  }
  const parseObject = () => {
    index += 1
    skipWhitespace()
    /** @type {Record<string, unknown>} */
    const object = {}
    const names = new Set()
    if (text[index] === "}") {
      index += 1
      return object
    }
    while (true) {
      const name = parseString()
      if (names.has(name)) throw new ContractError("INPUT_DUPLICATE_PROPERTY", "contract JSON objects must not contain duplicate decoded property names")
      names.add(name)
      skipWhitespace()
      if (text[index] !== ":") syntax()
      index += 1
      skipWhitespace()
      const value = parseValue()
      Object.defineProperty(object, name, { value, enumerable: true, configurable: true, writable: true })
      skipWhitespace()
      if (text[index] === "}") {
        index += 1
        return object
      }
      if (text[index] !== ",") syntax()
      index += 1
      skipWhitespace()
    }
  }
  const parseValue = () => {
    skipWhitespace()
    if (text[index] === '"') return parseString()
    if (text[index] === "{") return parseObject()
    if (text[index] === "[") return parseArray()
    if (text.startsWith("true", index)) { index += 4; return true }
    if (text.startsWith("false", index)) { index += 5; return false }
    if (text.startsWith("null", index)) { index += 4; return null }
    return parseNumber()
  }
  const value = parseValue()
  skipWhitespace()
  if (index !== text.length) syntax()
  return value
}

/** Duplicate-aware UTF-8 I-JSON decoder over one already-stabilized byte snapshot. @param {Buffer} bytes */
function decodeContractJsonBytes(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new ContractError("INPUT_BOM_NOT_ALLOWED", "contract JSON must not contain a UTF-8 BOM")
  let text
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new ContractError("INPUT_INVALID_UTF8", "contract input must be valid UTF-8")
  }
  try {
    return parseIJson(text)
  } catch (error) {
    if (error instanceof ContractError) throw error
    throw new ContractError("INPUT_INVALID_JSON", "contract input must be valid JSON")
  }
}

/** Strict duplicate-aware UTF-8 I-JSON reader for the public CLI and Phase B composition. @param {string} inputPath */
export async function readContractJson(inputPath) {
  let bytes
  try {
    bytes = await readFile(inputPath)
  } catch {
    throw new ContractError("INPUT_READ_FAILED", "contract input could not be read")
  }
  return decodeContractJsonBytes(bytes)
}
