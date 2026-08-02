import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { link, lstat, mkdir, open, readFile, readdir, realpath, rm, unlink } from "node:fs/promises"
import path from "node:path"
import { types as utilTypes } from "node:util"

import {
  computePlanDigest,
  computePublicSetDigest,
  compareUtf8,
  jcsCanonicalize,
  loadPublicationRuntime,
  readContractJson,
  validateContract,
  validateCrossReleaseManifest,
} from "./publication-contracts.mjs"
import { assertNoLinkAncestors } from "./filesystem-safety.mjs"

export class AuthorityError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const exactEnvelopeKeys = [
  "approved_at",
  "approved_plan_digest",
  "approved_preview_digest",
  "approver",
  "authentication_tag",
  "channel",
  "schema_version",
  "source_event_id",
]
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** @param {unknown} value @param {string} code @returns {any} */
function snapshotStrictValue(value, code) {
  if (value === null) return value
  if (typeof value !== "object") {
    if (["function", "symbol", "bigint"].includes(typeof value)) throw new AuthorityError(code, "input contains an exotic value")
    return value
  }
  if (utilTypes.isProxy(value)) throw new AuthorityError(code, "input must not be a Proxy")
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length !== 0) throw new AuthorityError(code, "input arrays must not contain symbols")
    const names = Object.getOwnPropertyNames(value)
    const expected = ["length", ...Array.from({ length: value.length }, (_, index) => String(index))]
    if (names.length !== expected.length || names.some((name) => !expected.includes(name))) {
      throw new AuthorityError(code, "input arrays must not contain extra properties or holes")
    }
    const copy = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) {
        throw new AuthorityError(code, "input arrays must contain data properties only")
      }
      copy.push(snapshotStrictValue(descriptor.value, code))
    }
    return Object.freeze(copy)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new AuthorityError(code, "input objects must have a plain prototype")
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new AuthorityError(code, "input objects must not contain symbols")
  const copy = Object.create(prototype)
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) {
      throw new AuthorityError(code, "input objects must contain enumerable data properties only")
    }
    Object.defineProperty(copy, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: snapshotStrictValue(descriptor.value, code),
    })
  }
  return Object.freeze(copy)
}

/** @param {unknown} value @param {string[]} keys @param {string} code */
function readStrictRecord(value, keys, code) {
  if (!isRecord(value) || utilTypes.isProxy(value)) throw new AuthorityError(code, "input must be a plain non-Proxy record")
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new AuthorityError(code, "input must have a plain prototype")
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new AuthorityError(code, "input records must not contain symbols")
  if (JSON.stringify(Object.getOwnPropertyNames(value).sort(utf8Compare)) !== JSON.stringify([...keys].sort(utf8Compare))) {
    throw new AuthorityError(code, "input record has unexpected keys")
  }
  const result = Object.create(null)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) {
      throw new AuthorityError(code, "input record must contain enumerable data properties only")
    }
    result[key] = descriptor.value
  }
  return result
}

/** @param {string} value @param {string} other */
function utf8Compare(value, other) {
  return Buffer.compare(Buffer.from(value), Buffer.from(other))
}

/** @param {unknown} envelope */
function strictApprovalEnvelope(envelope) {
  const value = readStrictRecord(envelope, exactEnvelopeKeys, "APPROVAL_ENVELOPE_INVALID")
  if (value.schema_version !== 1 || value.approver !== "tyler" || value.channel !== "telegram"
      || typeof value.source_event_id !== "string" || value.source_event_id.length < 1
      || typeof value.approved_plan_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.approved_plan_digest)
      || typeof value.approved_preview_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.approved_preview_digest)
      || typeof value.approved_at !== "string"
      || typeof value.authentication_tag !== "string" || !/^[a-f0-9]{64}$/.test(value.authentication_tag)) {
    throw new AuthorityError("APPROVAL_ENVELOPE_INVALID", "approval envelope fields are invalid")
  }
  return Object.freeze(value)
}

/** @param {ReturnType<typeof strictApprovalEnvelope>} envelope @param {Buffer} approvalKey */
function authenticateApproval(envelope, approvalKey) {
  if (!Buffer.isBuffer(approvalKey) || approvalKey.length < 32) {
    throw new AuthorityError("APPROVAL_KEY_INVALID", "approval authentication key must contain at least 32 bytes")
  }
  const payload = {
    approved_at: envelope.approved_at,
    approved_plan_digest: envelope.approved_plan_digest,
    approved_preview_digest: envelope.approved_preview_digest,
    approver: envelope.approver,
    channel: envelope.channel,
    schema_version: envelope.schema_version,
    source_event_id: envelope.source_event_id,
  }
  const expected = createHmac("sha256", approvalKey).update(jcsCanonicalize(payload)).digest()
  const supplied = Buffer.from(envelope.authentication_tag, "hex")
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new AuthorityError("APPROVAL_AUTHENTICATION_FAILED", "approval authentication failed")
  }
}

/** @param {string} runtimeRoot */
async function openRuntimeRoot(runtimeRoot) {
  if (typeof runtimeRoot !== "string" || runtimeRoot.length === 0) {
    throw new AuthorityError("RUNTIME_PATH_INVALID", "publication runtime root must be a non-empty path string")
  }
  const absolute = path.resolve(runtimeRoot)
  await assertNoLinkAncestors(absolute, {
    errorFactory: (message) => new AuthorityError("RUNTIME_PATH_INVALID", message),
  })
  let metadata
  try {
    metadata = await lstat(absolute)
  } catch {
    throw new AuthorityError("RUNTIME_PATH_INVALID", "publication runtime root must already exist")
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new AuthorityError("RUNTIME_PATH_INVALID", "publication runtime root must be an ordinary directory")
  }
  if (await realpath(absolute) !== absolute) {
    throw new AuthorityError("RUNTIME_PATH_INVALID", "publication runtime root must use exact canonical spelling")
  }
  const names = await readdir(absolute)
  if (names.some((name) => !["pending", "consumed", "rejected", "current-release.json"].includes(name))) {
    throw new AuthorityError("RUNTIME_STATE_INVALID", "publication runtime root contains an unknown entry")
  }
  if (names.includes("current-release.json")) {
    const pointerMetadata = await lstat(path.join(absolute, "current-release.json"))
    if (pointerMetadata.isSymbolicLink() || !pointerMetadata.isFile()) {
      throw new AuthorityError("RUNTIME_STATE_INVALID", "current release pointer must be an ordinary file")
    }
  }
  return { absolute, names }
}

const verifiedPendingAuthorities = new WeakMap()
const runtimeStateNames = new Set(["pending", "consumed", "rejected"])

/** @param {string} value */
function asciiRuntimeFold(value) {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 0x20))
}

/** @param {string[]} names */
function requireUnambiguousRuntimeNames(names) {
  const folded = new Set()
  for (const name of names) {
    const key = asciiRuntimeFold(name)
    if (folded.has(key)) throw new AuthorityError("RUNTIME_STATE_INVALID", "publication runtime contains case-colliding entries")
    folded.add(key)
  }
}

/** @param {string} root @param {string} candidate */
function isInsideRuntime(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

/** Read-only runtime and pending custody boundary for the verified authority seam. @param {string} runtimeRoot */
async function openVerifiedPendingRuntime(runtimeRoot) {
  const runtime = await openRuntimeRoot(runtimeRoot)
  requireUnambiguousRuntimeNames(runtime.names)
  for (const name of runtime.names) {
    if (name === "current-release.json") continue
    if (!runtimeStateNames.has(name)) {
      throw new AuthorityError("RUNTIME_STATE_INVALID", "publication runtime root contains an unknown entry")
    }
    const metadata = await lstat(path.join(runtime.absolute, name))
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new AuthorityError("RUNTIME_STATE_INVALID", "publication runtime state entries must be ordinary directories")
    }
    if (await realpath(path.join(runtime.absolute, name)) !== path.join(runtime.absolute, name)) {
      throw new AuthorityError("RUNTIME_STATE_INVALID", "publication runtime state entries must use canonical paths")
    }
  }
  if (!runtime.names.includes("pending")) {
    throw new AuthorityError("PENDING_AUTHORITY_COUNT_INVALID", "pending custody must contain exactly one valid manifest")
  }
  return runtime
}

/** @param {string} runtimeRoot */
async function readVerifiedPendingManifest(runtimeRoot) {
  const pendingRoot = path.join(runtimeRoot, "pending")
  let names
  let pendingBefore
  try {
    pendingBefore = await lstat(pendingRoot)
    if (pendingBefore.isSymbolicLink() || !pendingBefore.isDirectory()) throw new Error("pending custody is not an ordinary directory")
    names = await readdir(pendingRoot)
    const pendingAfter = await lstat(pendingRoot)
    if (pendingAfter.isSymbolicLink() || !pendingAfter.isDirectory()
        || pendingBefore.dev !== pendingAfter.dev || pendingBefore.ino !== pendingAfter.ino
        || pendingBefore.mode !== pendingAfter.mode || pendingBefore.size !== pendingAfter.size
        || pendingBefore.mtimeMs !== pendingAfter.mtimeMs) throw new Error("pending custody changed during read")
  } catch {
    throw new AuthorityError("PENDING_STATE_INVALID", "pending custody could not be read stably")
  }
  requireUnambiguousRuntimeNames(names)
  if (names.length !== 1) {
    throw new AuthorityError("PENDING_AUTHORITY_COUNT_INVALID", "pending custody must contain exactly one candidate")
  }
  const filename = names[0]
  if (!/^VPUB-[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(filename)) {
    throw new AuthorityError("PENDING_ENTRY_INVALID", "pending custody entry name is invalid")
  }
  const manifestPath = path.join(pendingRoot, filename)
  let before
  let firstBytes
  let manifest
  try {
    before = await lstat(manifestPath)
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new AuthorityError("PENDING_ENTRY_INVALID", "pending manifest must be an ordinary regular file")
    }
    const resolved = await realpath(manifestPath)
    if (resolved !== manifestPath || !isInsideRuntime(runtimeRoot, resolved)) {
      throw new AuthorityError("PENDING_PATH_INVALID", "pending manifest must resolve canonically inside runtime custody")
    }
    firstBytes = await readFile(manifestPath)
    manifest = /** @type {any} */ (await readContractJson(manifestPath))
    const secondBytes = await readFile(manifestPath)
    const after = await lstat(manifestPath)
    if (!before.isFile() || !after.isFile() || before.isSymbolicLink() || after.isSymbolicLink()
        || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || !firstBytes.equals(secondBytes)) {
      throw new AuthorityError("PENDING_CHANGED_DURING_READ", "pending manifest changed during stable read")
    }
    const finalPendingNames = await readdir(pendingRoot)
    const finalPendingMetadata = await lstat(pendingRoot)
    if (finalPendingMetadata.isSymbolicLink() || !finalPendingMetadata.isDirectory()
        || pendingBefore.dev !== finalPendingMetadata.dev || pendingBefore.ino !== finalPendingMetadata.ino
        || pendingBefore.mode !== finalPendingMetadata.mode || pendingBefore.size !== finalPendingMetadata.size
        || pendingBefore.mtimeMs !== finalPendingMetadata.mtimeMs
        || finalPendingNames.length !== names.length || finalPendingNames.some((name) => !names.includes(name))) {
      throw new AuthorityError("PENDING_CHANGED_DURING_READ", "pending custody changed during stable read")
    }
  } catch (error) {
    if (error instanceof AuthorityError) throw error
    if (error && typeof error === "object" && typeof (/** @type {{code?:unknown}} */ (error)).code === "string"
        && !String((/** @type {{code:string}} */ (error)).code).startsWith("E")) throw error
    throw new AuthorityError("PENDING_READ_FAILED", "pending manifest could not be read stably")
  }
  if (filename !== `${manifest.manifest_id}.json`) {
    throw new AuthorityError("PENDING_IDENTITY_MISMATCH", "pending filename must equal manifest identity")
  }
  if (!firstBytes.equals(Buffer.from(`${jcsCanonicalize(manifest)}\n`, "utf8"))) {
    throw new AuthorityError("PENDING_FORMAT_INVALID", "pending manifest must be canonical JSON followed by one LF")
  }
  const trustedNow = new Date()
  await validateContract("publication-manifest", manifest, { now: trustedNow })
  const runtimeState = await loadPublicationRuntime(runtimeRoot)
  await validateCrossReleaseManifest(manifest, { ...runtimeState, now: trustedNow })
  return { manifest }
}

/**
 * Select exactly one currently valid canonical pending manifest and return a
 * module-identity-backed opaque handle. The handle contains no custody data.
 * @param {string} runtimeRoot
 */
export async function loadVerifiedPendingAuthority(runtimeRoot) {
  const runtime = await openVerifiedPendingRuntime(runtimeRoot)
  const selected = await readVerifiedPendingManifest(runtime.absolute)
  const handle = Object.freeze(Object.create(null))
  verifiedPendingAuthorities.set(handle, {
    manifest: structuredClone(selected.manifest),
    runtimeRoot: runtime.absolute,
    manifestPath: path.join(runtime.absolute, "pending", `${selected.manifest.manifest_id}.json`),
  })
  return handle
}

/** @param {unknown} value */
export function isVerifiedPendingAuthority(value) {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? verifiedPendingAuthorities.has(/** @type {object} */ (value))
    : false
}

/**
 * Consume a verified handle without exposing runtime custody internals through
 * the handle. The callback receives an isolated manifest copy only after the
 * identity predicate succeeds.
 * @param {unknown} handle
 * @param {(manifest:any)=>unknown|Promise<unknown>} consumer
 */
export async function consumeVerifiedPendingAuthority(handle, consumer) {
  const authority = (typeof handle === "object" && handle !== null) || typeof handle === "function"
    ? verifiedPendingAuthorities.get(/** @type {object} */ (handle))
    : undefined
  if (!authority) throw new AuthorityError("PENDING_AUTHORITY_UNVERIFIED", "pending authority handle is not verified")
  if (typeof consumer !== "function") throw new AuthorityError("PENDING_CONSUMER_INVALID", "pending authority consumer must be a function")
  return consumer(structuredClone(authority.manifest))
}

/**
 * Internal release handoff context. The opaque handle remains empty; custody
 * paths are available only to a module consumer after the filesystem brand has
 * already been proven. The ordinary public consumer above intentionally keeps
 * these paths out of its callback contract.
 * @param {unknown} handle
 * @param {(value:{manifest:any,runtimeRoot:string,manifestPath:string})=>unknown|Promise<unknown>} consumer
 */
export async function consumeVerifiedPendingReleaseContext(handle, consumer) {
  const authority = (typeof handle === "object" && handle !== null) || typeof handle === "function"
    ? verifiedPendingAuthorities.get(/** @type {object} */ (handle))
    : undefined
  if (!authority) throw new AuthorityError("PENDING_AUTHORITY_UNVERIFIED", "pending authority handle is not verified")
  if (typeof consumer !== "function") throw new AuthorityError("PENDING_CONSUMER_INVALID", "pending authority consumer must be a function")
  return consumer({
    manifest: structuredClone(authority.manifest),
    runtimeRoot: authority.runtimeRoot,
    manifestPath: authority.manifestPath,
  })
}

/** @typedef {{list:()=>Promise<unknown>,read:(pathname:string)=>Promise<unknown>}} ReadOnlyProvider */
/** @typedef {{manifestId:string,planDigest:string,state:"complete",fileCount:number,reconciliation:{expected:number,exported:number,status:"complete"},formalBuildInput:object}} ExportResult */
/** @typedef {{manifest:ExportManifest,exportReceipt:ExportReceipt,fileBindings:ExportFileBinding[],exportRoot:string}} StoredExport */

/** @type {WeakMap<object,StoredExport>} */
const verifiedExportInputs = new WeakMap()

/** @param {unknown} value @param {string} code */
function exportFailure(value, code) {
  if (value instanceof AuthorityError) return value
  return new AuthorityError(code, "read-only publication export could not be verified")
}

/** @typedef {{path:string,public_id:string,node_class:string,source_sha256:string}} ExportManifestNode */
/** @typedef {{manifest_id:string,plan_digest:string,nodes:ExportManifestNode[]}} ExportManifest */
/** @typedef {{metadata:unknown,node_class:string,path:string,public_id:string,version:string}} ExportListingEntry */
/** @typedef {{entries:ExportListingEntry[],snapshot:unknown}} ExportListing */
/** @typedef {{bytes:unknown,metadata:unknown,node_class:string,path:string,public_id:string,snapshot:unknown,version:string}} ExportReadResult */
/** @typedef {{path:string,source_sha256:string}} ExportReceiptFile */
/** @typedef {{schema_version:1,manifest_id:string,plan_digest:string,exported_at:string,drive_readback:"verified",files:ExportReceiptFile[]}} ExportReceipt */
/** @typedef {{path:string,publicId:string,nodeClass:string,sourceSha256:string}} ExportFileBinding */

/** @param {unknown} value */
function stableEvidence(value) {
  try {
    return jcsCanonicalize(value)
  } catch {
    throw new AuthorityError("EXPORT_PROVIDER_INVALID", "provider evidence is not comparable")
  }
}

/** @param {string} candidate */
function requireExportPath(candidate) {
  if (typeof candidate !== "string" || candidate.length < 4 || candidate.normalize("NFC") !== candidate
      || candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate) || /[\\\u0000]/.test(candidate)) {
    throw new AuthorityError("EXPORT_PATH_INVALID", "provider returned an unsafe Markdown path")
  }
  const segments = candidate.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..") || !candidate.endsWith(".md")) {
    throw new AuthorityError("EXPORT_PATH_INVALID", "provider returned an unsafe Markdown path")
  }
  return candidate
}

/** @param {unknown} provider @returns {ReadOnlyProvider} */
function requireReadOnlyProvider(provider) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)
      || utilTypes.isProxy(provider)
      || Object.getPrototypeOf(provider) !== Object.prototype
      || JSON.stringify(Object.getOwnPropertyNames(provider).sort()) !== JSON.stringify(["list", "read"])
      || Object.getOwnPropertySymbols(provider).length !== 0) {
    throw new AuthorityError("EXPORT_PROVIDER_INVALID", "Drive provider must expose list and read only")
  }
  const listDescriptor = Object.getOwnPropertyDescriptor(provider, "list")
  const readDescriptor = Object.getOwnPropertyDescriptor(provider, "read")
  if (!listDescriptor || !readDescriptor
      || listDescriptor.enumerable !== true || readDescriptor.enumerable !== true
      || "get" in listDescriptor || "set" in listDescriptor
      || "get" in readDescriptor || "set" in readDescriptor
      || typeof listDescriptor.value !== "function" || typeof readDescriptor.value !== "function"
      || utilTypes.isProxy(listDescriptor.value) || utilTypes.isProxy(readDescriptor.value)) {
    throw new AuthorityError("EXPORT_PROVIDER_INVALID", "Drive provider list and read methods are required")
  }
  return /** @type {ReadOnlyProvider} */ (provider)
}

/** @param {any} value @param {string[]} keys @param {string[]} [binaryKeys] */
function requireExactObjectKeys(value, keys, binaryKeys = []) {
  const values = readStrictRecord(value, keys, "EXPORT_PROVIDER_INVALID")
  const copy = Object.create(null)
  for (const key of keys) {
    copy[key] = binaryKeys.includes(key) ? values[key] : snapshotStrictValue(values[key], "EXPORT_PROVIDER_INVALID")
  }
  return Object.freeze(copy)
}

/** @param {string} root */
async function assertFreshExportRoot(root) {
  if (typeof root !== "string" || root.length === 0) throw new AuthorityError("EXPORT_ROOT_INVALID", "export custody root is invalid")
  const absolute = path.resolve(root)
  try {
    await assertNoLinkAncestors(absolute, {
      allowMissing: true,
      errorFactory: (message) => new AuthorityError("EXPORT_ROOT_INVALID", message),
    })
  } catch (error) {
    throw exportFailure(error, "EXPORT_ROOT_INVALID")
  }
  try {
    const metadata = await lstat(absolute)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new AuthorityError("EXPORT_ROOT_INVALID", "export custody root must be an ordinary directory")
    }
    throw new AuthorityError("EXPORT_ROOT_COLLISION", "export custody root already exists")
  } catch (error) {
    if (error instanceof AuthorityError) throw error
    if (/** @type {{code?:string}} */ (error)?.code !== "ENOENT") throw exportFailure(error, "EXPORT_ROOT_INVALID")
  }
  return absolute
}

/** @param {string} root @param {string} candidate */
function insideExportRoot(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

/** @param {string} root */
async function assertOrdinaryExportRoot(root) {
  const metadata = await lstat(root)
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(root) !== root) {
    throw new AuthorityError("EXPORT_ROOT_CHANGED", "export custody root changed during export")
  }
}

/** @param {string} root @param {string[]} createdFiles @param {string[]} createdDirectories */
async function cleanupExportAttempt(root, createdFiles, createdDirectories) {
  for (const filename of [...createdFiles].reverse()) {
    try { await rm(filename, { force: true }) } catch {}
  }
  for (const directory of [...createdDirectories].reverse()) {
    try { await rm(directory, { recursive: false, force: true }) } catch {}
  }
}

/** @param {string} root @param {string} relative @param {Buffer} bytes @param {string[]} createdFiles @param {string[]} createdDirectories */
async function writeExportFile(root, relative, bytes, createdFiles, createdDirectories) {
  const absolute = path.resolve(root, ...relative.split("/"))
  if (!insideExportRoot(root, absolute)) throw new AuthorityError("EXPORT_PATH_INVALID", "export path escapes custody root")
  const directory = path.dirname(absolute)
  const missing = []
  let cursor = directory
  while (cursor !== root) {
    try {
      const metadata = await lstat(cursor)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new AuthorityError("EXPORT_ROOT_CHANGED", "export custody path is not an ordinary directory")
      break
    } catch (error) {
      if (/** @type {{code?:string}} */ (error)?.code !== "ENOENT") throw error
      missing.push(cursor)
      const parent = path.dirname(cursor)
      if (parent === cursor || !insideExportRoot(root, parent)) throw new AuthorityError("EXPORT_PATH_INVALID", "export path escapes custody root")
      cursor = parent
    }
  }
  for (const missingDirectory of missing.reverse()) {
    await mkdir(missingDirectory)
    createdDirectories.push(missingDirectory)
  }
  const handle = await open(absolute, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  createdFiles.push(absolute)
}

/**
 * Export exactly the manifest selected by a Ticket02 verified-pending handle.
 * The provider is deliberately a two-method read-only adapter: list() returns
 * one snapshot and exact identities; read() returns bytes plus comparable
 * snapshot/version/metadata evidence. No caller-supplied clock is accepted.
 * @param {{authority:unknown,provider:unknown,exportRoot:string}} input
 * @returns {Promise<ExportResult>}
 */
export async function exportVerifiedPendingAuthority(input) {
  let exported
  try {
    exported = await consumeVerifiedPendingAuthority(input?.authority, async (rawManifest) => {
      const manifest = /** @type {ExportManifest} */ (rawManifest)
      const provider = requireReadOnlyProvider(input?.provider)
      const exportRoot = await assertFreshExportRoot(input?.exportRoot)
      const firstNow = new Date()
      await validateContract("publication-manifest", manifest, { now: firstNow })
      const listing = /** @type {ExportListing} */ (requireExactObjectKeys(await provider.list(), ["entries", "snapshot"]))
      if (!Array.isArray(listing.entries) || listing.entries.length !== manifest.nodes.length) {
        throw new AuthorityError("EXPORT_FILE_SET_MISMATCH", "Drive listing does not exactly match the manifest")
      }
      const expectedByPath = new Map(manifest.nodes.map((node) => [node.path, node]))
      const seen = new Set()
      const folded = new Set()
      const entriesByPath = new Map()
      for (const rawEntry of listing.entries) {
        const entry = /** @type {ExportListingEntry} */ (requireExactObjectKeys(rawEntry, ["metadata", "node_class", "path", "public_id", "version"]))
        const entryPath = requireExportPath(entry.path)
        const foldedPath = entryPath.toLowerCase()
        if (seen.has(entryPath)) throw new AuthorityError("EXPORT_DUPLICATE_PATH", "Drive listing contains a duplicate path")
        if (folded.has(foldedPath)) throw new AuthorityError("EXPORT_PATH_CASE_COLLISION", "Drive listing contains a case-colliding path")
        seen.add(entryPath)
        folded.add(foldedPath)
        const expected = expectedByPath.get(entryPath)
        if (!expected || expected.public_id !== entry.public_id || expected.node_class !== entry.node_class
            || typeof entry.version !== "string" || entry.version.length === 0 || !entry.metadata || typeof entry.metadata !== "object") {
          throw new AuthorityError("EXPORT_PROVIDER_PATH_MISMATCH", "Drive listing identity does not match the manifest")
        }
        stableEvidence(entry.metadata)
        entriesByPath.set(entryPath, entry)
      }
      if (seen.size !== expectedByPath.size) throw new AuthorityError("EXPORT_FILE_SET_MISMATCH", "Drive listing does not exactly match the manifest")
      const listingSnapshot = stableEvidence(listing.snapshot)
      /** @type {Map<string, Buffer>} */
      const bytesByPath = new Map()
      for (const node of manifest.nodes) {
        const entry = entriesByPath.get(node.path)
        if (!entry) throw new AuthorityError("EXPORT_FILE_SET_MISMATCH", "Drive listing does not exactly match the manifest")
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const readResult = /** @type {ExportReadResult} */ (requireExactObjectKeys(
            await provider.read(node.path),
            ["bytes", "metadata", "node_class", "path", "public_id", "snapshot", "version"],
            ["bytes"],
          ))
          if (utilTypes.isProxy(readResult.bytes)) throw new AuthorityError("EXPORT_PROVIDER_INVALID", "provider bytes must not be a Proxy")
          const bytes = Buffer.isBuffer(readResult.bytes)
            ? Buffer.from(readResult.bytes)
            : readResult.bytes instanceof Uint8Array ? Buffer.from(readResult.bytes) : undefined
          if (!bytes || readResult.path !== node.path || readResult.public_id !== node.public_id
              || readResult.node_class !== node.node_class || readResult.version !== entry.version
              || stableEvidence(readResult.snapshot) !== listingSnapshot
              || stableEvidence(readResult.metadata) !== stableEvidence(entry.metadata)) {
            throw new AuthorityError("EXPORT_CHANGED_DURING_READ", "Drive source changed during export")
          }
          if (attempt === 0) bytesByPath.set(node.path, bytes)
          else {
            const firstBytes = bytesByPath.get(node.path)
            if (!firstBytes || !bytes.equals(firstBytes)) throw new AuthorityError("EXPORT_CHANGED_DURING_READ", "Drive source changed during export")
          }
        }
        const sourceBytes = bytesByPath.get(node.path)
        if (!sourceBytes) throw new AuthorityError("EXPORT_CHANGED_DURING_READ", "Drive source changed during export")
        const digest = createHash("sha256").update(sourceBytes).digest("hex")
        if (digest !== node.source_sha256) throw new AuthorityError("EXPORT_SOURCE_HASH_MISMATCH", "Drive source hash does not match the manifest")
      }
      const secondNow = new Date()
      await validateContract("publication-manifest", manifest, { now: secondNow })
      const exportedAt = new Date(Math.floor(secondNow.getTime() / 1000) * 1000).toISOString().replace(".000Z", "Z")
      const receipt = /** @type {ExportReceipt} */ ({
        schema_version: 1,
        manifest_id: manifest.manifest_id,
        plan_digest: manifest.plan_digest,
        exported_at: exportedAt,
        drive_readback: "verified",
        files: manifest.nodes.map((node) => ({
          path: node.path,
          source_sha256: node.source_sha256,
        })).sort((first, second) => compareUtf8(first.path, second.path)),
      })
      await validateContract("export-receipt", receipt, { manifest, now: secondNow })
      const createdFiles = /** @type {string[]} */ ([])
      const createdDirectories = /** @type {string[]} */ ([])
      try {
        try {
          await mkdir(exportRoot)
        } catch (error) {
          if (/** @type {{code?:unknown}} */ (error)?.code === "EEXIST") {
            throw new AuthorityError("EXPORT_ROOT_COLLISION", "export custody root already exists")
          }
          throw error
        }
        createdDirectories.push(exportRoot)
        for (const [relative, bytes] of bytesByPath) await writeExportFile(exportRoot, relative, bytes, createdFiles, createdDirectories)
        await writeExportFile(exportRoot, "export-receipt.json", Buffer.from(`${jcsCanonicalize(receipt)}\n`, "utf8"), createdFiles, createdDirectories)
        await assertOrdinaryExportRoot(exportRoot)
        await validateContract("export-receipt", receipt, { manifest, exportRoot, now: secondNow })
      } catch (error) {
        await cleanupExportAttempt(exportRoot, createdFiles, createdDirectories)
        throw error
      }
      const formalBuildInput = Object.freeze(Object.create(null))
      verifiedExportInputs.set(formalBuildInput, {
        manifest: structuredClone(manifest),
        exportReceipt: structuredClone(receipt),
        fileBindings: receipt.files.map((file) => {
          const node = manifest.nodes.find((candidate) => candidate.path === file.path)
          if (!node) throw new AuthorityError("EXPORT_FILE_SET_MISMATCH", "export receipt does not match the manifest")
          return {
            path: file.path,
            publicId: node.public_id,
            nodeClass: node.node_class,
            sourceSha256: file.source_sha256,
          }
        }),
        exportRoot,
      })
      return Object.freeze({
        manifestId: manifest.manifest_id,
        planDigest: manifest.plan_digest,
        state: "complete",
        fileCount: receipt.files.length,
        reconciliation: Object.freeze({ expected: receipt.files.length, exported: receipt.files.length, status: "complete" }),
        formalBuildInput,
      })
    })
  } catch (error) {
    throw exportFailure(error, "EXPORT_FAILED")
  }
  return /** @type {ExportResult} */ (exported)
}

/** @param {unknown} input @param {(value:{manifest:any,exportReceipt:any,fileBindings:any[],exportRoot:string})=>unknown|Promise<unknown>} consumer */
export async function consumeVerifiedExportInput(input, consumer) {
  const stored = (typeof input === "object" && input !== null) || typeof input === "function"
    ? verifiedExportInputs.get(/** @type {object} */ (input))
    : undefined
  if (!stored) throw new AuthorityError("EXPORT_INPUT_UNVERIFIED", "formal export input is not verified")
  if (typeof consumer !== "function") throw new AuthorityError("EXPORT_CONSUMER_INVALID", "formal export consumer must be a function")
  return consumer({
    manifest: structuredClone(stored.manifest),
    exportReceipt: structuredClone(stored.exportReceipt),
    fileBindings: structuredClone(stored.fileBindings),
    exportRoot: stored.exportRoot,
  })
}

/** @param {string} runtimeRoot @param {"consumed"|"rejected"} state @param {string} sourceEventId */
async function rejectFinalCustodyReplay(runtimeRoot, state, sourceEventId) {
  const custodyStateRoot = path.join(runtimeRoot, state)
  let rootMetadata
  try {
    rootMetadata = await lstat(custodyStateRoot)
  } catch (error) {
    if (/** @type {{code?:string}} */ (error)?.code === "ENOENT") return
    throw new AuthorityError("RUNTIME_STATE_INVALID", `${state} custody metadata could not be read`)
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new AuthorityError("RUNTIME_STATE_INVALID", `${state} custody must be an ordinary directory`)
  }
  for (const custodyName of await readdir(custodyStateRoot)) {
    const custodyRoot = path.join(custodyStateRoot, custodyName)
    const custodyMetadata = await lstat(custodyRoot)
    if (custodyMetadata.isSymbolicLink() || !custodyMetadata.isDirectory()) {
      throw new AuthorityError("RUNTIME_STATE_INVALID", `${state} custody entries must be ordinary directories`)
    }
    const manifestPath = path.join(custodyRoot, "manifest.json")
    let manifestMetadata
    try {
      manifestMetadata = await lstat(manifestPath)
    } catch {
      throw new AuthorityError("RUNTIME_STATE_INVALID", `${state} custody is missing its manifest`)
    }
    if (manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile()) {
      throw new AuthorityError("RUNTIME_STATE_INVALID", `${state} manifest must be an ordinary file`)
    }
    let manifest
    try {
      manifest = /** @type {any} */ (await readContractJson(manifestPath))
    } catch {
      throw new AuthorityError("RUNTIME_STATE_INVALID", `${state} manifest could not be parsed`)
    }
    if (manifest?.approval_receipt?.source_event_id === sourceEventId) {
      throw new AuthorityError("APPROVAL_REPLAYED", `approval source event already exists in ${state} custody`)
    }
  }
}

/** @param {string} runtimeRoot @param {string} manifestId @param {string} sourceEventId @param {Buffer} bytes */
async function installPendingManifest(runtimeRoot, manifestId, sourceEventId, bytes) {
  const pendingRoot = path.join(runtimeRoot, "pending")
  let pendingCreated = false
  if (!(await readdir(runtimeRoot)).includes("pending")) {
    try {
      await mkdir(pendingRoot)
      pendingCreated = true
    } catch (error) {
      if (/** @type {{code?:string}} */ (error)?.code !== "EEXIST") throw error
    }
  }
  const metadata = await lstat(pendingRoot)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new AuthorityError("PENDING_STATE_INVALID", "pending custody must be an ordinary directory")
  }
  const existing = await readdir(pendingRoot)
  if (existing.length !== 0) {
    if (existing.length === 1 && /^[A-Za-z0-9-]+\.json$/.test(existing[0])) {
      try {
        const admitted = /** @type {any} */ (await readContractJson(path.join(pendingRoot, existing[0])))
        if (admitted?.approval_receipt?.source_event_id === sourceEventId) {
          throw new AuthorityError("APPROVAL_REPLAYED", "approval source event was already admitted")
        }
      } catch (error) {
        if (error instanceof AuthorityError) throw error
      }
    }
    throw new AuthorityError("PENDING_AUTHORITY_EXISTS", "pending custody already contains publication authority")
  }

  const finalPath = path.join(pendingRoot, `${manifestId}.json`)
  const temporaryPath = path.join(pendingRoot, `.admission-${process.pid}-${randomBytes(12).toString("hex")}.tmp`)
  let temporaryCreated = false
  try {
    const handle = await open(temporaryPath, "wx", 0o600)
    temporaryCreated = true
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await link(temporaryPath, finalPath)
    if (!(await readFile(finalPath)).equals(bytes)) {
      throw new AuthorityError("PENDING_WRITE_MISMATCH", "pending manifest read-back does not match admitted bytes")
    }
    await unlink(temporaryPath)
    temporaryCreated = false
  } catch (error) {
    if (temporaryCreated) await rm(temporaryPath, { force: true })
    if (pendingCreated) {
      try {
        if ((await readdir(pendingRoot)).length === 0) await rm(pendingRoot, { recursive: false })
      } catch {}
    }
    if (/** @type {{code?:string}} */ (error)?.code === "EEXIST") {
      throw new AuthorityError("PENDING_AUTHORITY_EXISTS", "pending authority destination already exists")
    }
    throw error
  }
}

const publicNodeClasses = new Set(["paper", "concept", "method", "task", "author", "synthesis", "map"])
const rightsNotice = "Tyler-authored content is all rights reserved. Third-party quotations, Zotero excerpts, bibliographic material, images, and linked works retain their original rights."

/** @param {any} plan */
function previewPlan(plan) {
  if (!isRecord(plan) || !isRecord(plan.action) || !Array.isArray(plan.nodes)
      || typeof plan.plan_digest !== "string" || typeof plan.public_set_digest !== "string") {
    throw new AuthorityError("PREVIEW_INVALID", "publication approval preview input is invalid")
  }
  const action = /** @type {Record<string, any>} */ (plan.action)
  if (action.kind !== "publish-unit" || typeof action.primary_id !== "string"
      || !Array.isArray(action.support_ids) || !Array.isArray(action.added_node_ids)) {
    throw new AuthorityError("PREVIEW_INVALID", "publication approval preview requires a publish-unit plan")
  }
  if (!/^[a-f0-9]{64}$/.test(plan.plan_digest) || !/^[a-f0-9]{64}$/.test(plan.public_set_digest)) {
    throw new AuthorityError("PREVIEW_INVALID", "publication approval preview digests are invalid")
  }
  if (computePublicSetDigest(plan.nodes) !== plan.public_set_digest || computePlanDigest(plan) !== plan.plan_digest) {
    throw new AuthorityError("PREVIEW_DIGEST_MISMATCH", "publication approval preview is not bound to the exact plan")
  }

  const supportIds = new Set(action.support_ids)
  const addedIds = new Set(action.added_node_ids)
  if (supportIds.has(action.primary_id)) {
    throw new AuthorityError("PREVIEW_INVALID", "publication preview primary cannot also be support")
  }
  const routes = plan.nodes.map((/** @type {any} */ node) => {
    if (!isRecord(node) || typeof node.public_id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(node.public_id)
        || typeof node.node_class !== "string" || !publicNodeClasses.has(node.node_class)) {
      throw new AuthorityError("PREVIEW_INVALID", "publication approval preview node is invalid")
    }
    const role = node.public_id === action.primary_id
      ? "primary"
      : supportIds.has(node.public_id) ? "support" : "retained"
    const route = node.node_class === "paper"
      ? `/papers/${node.public_id}/`
      : `/knowledge/${node.node_class}/${node.public_id}/`
    return {
      publicId: node.public_id,
      route,
      nodeClass: node.node_class,
      role,
      status: addedIds.has(node.public_id) ? "added" : "existing",
    }
  })
  const counts = {
    total: routes.length,
    added: routes.filter((/** @type {any} */ entry) => entry.status === "added").length,
    existing: routes.filter((/** @type {any} */ entry) => entry.status === "existing").length,
    primary: routes.filter((/** @type {any} */ entry) => entry.role === "primary").length,
    support: routes.filter((/** @type {any} */ entry) => entry.role === "support").length,
    retained: routes.filter((/** @type {any} */ entry) => entry.role === "retained").length,
  }
  if (counts.primary !== 1 || counts.support !== action.support_ids.length) {
    throw new AuthorityError("PREVIEW_INVALID", "publication preview roles do not cover the plan")
  }
  return {
    routes,
    counts,
    planDigest: plan.plan_digest,
    publicSetDigest: plan.public_set_digest,
    rightsNotice,
  }
}

/** @param {any} plan */
export function createPublicationApprovalPreview(plan) {
  return previewPlan(snapshotStrictValue(plan, "PREVIEW_INVALID"))
}

/** @typedef {{plan:any, envelope:ReturnType<typeof strictApprovalEnvelope>, planDigest:string, previewDigest:string}} VerifiedPublicationApproval */
/** @type {WeakMap<object,VerifiedPublicationApproval>} */
const verifiedPublicationApprovals = new WeakMap()

/** @param {string} value @param {string} field */
function approvalTimestamp(value, field) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new AuthorityError("TIMESTAMP_INVALID", `${field} must be RFC 3339 UTC with whole seconds and Z`)
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== `${value.slice(0, -1)}.000Z`) {
    throw new AuthorityError("TIMESTAMP_INVALID", `${field} is not a valid UTC calendar instant`)
  }
  return milliseconds
}

/** @param {any} plan @param {ReturnType<typeof strictApprovalEnvelope>} envelope @param {Date} trustedNow */
function validateApprovalWindow(plan, envelope, trustedNow) {
  const created = approvalTimestamp(plan.created_at, "created_at")
  const expires = approvalTimestamp(plan.expires_at, "expires_at")
  const approved = approvalTimestamp(envelope.approved_at, "approved_at")
  if (created >= expires) throw new AuthorityError("TIME_WINDOW_INVALID", "manifest requires created_at < expires_at")
  if (approved < created || approved >= expires) throw new AuthorityError("APPROVAL_TIME_INVALID", "approved_at must be within [created_at, expires_at)")
  const now = trustedNow.getTime()
  if (!Number.isFinite(now)) throw new AuthorityError("NOW_INVALID", "trusted current time must be a valid Date")
  if (now < created) throw new AuthorityError("MANIFEST_NOT_YET_VALID", "manifest is not yet valid")
  if (now >= expires) throw new AuthorityError("MANIFEST_EXPIRED", "manifest has expired")
}

/** @param {unknown} input */
export function verifyPublicationApproval(input) {
  const values = readStrictRecord(input, ["approvalEnvelope", "approvalKey", "plan"], "APPROVAL_VERIFICATION_INVALID")
  const plan = snapshotStrictValue(values.plan, "PUBLICATION_PLAN_INVALID")
  const envelope = strictApprovalEnvelope(values.approvalEnvelope)
  authenticateApproval(envelope, values.approvalKey)
  const computedPlanDigest = computePlanDigest(plan)
  if (envelope.approved_plan_digest !== plan.plan_digest || envelope.approved_plan_digest !== computedPlanDigest) {
    throw new AuthorityError("APPROVAL_PLAN_MISMATCH", "approval does not bind the exact publication plan")
  }
  const preview = previewPlan(plan)
  const previewDigest = createHash("sha256").update(jcsCanonicalize(preview)).digest("hex")
  if (envelope.approved_preview_digest !== previewDigest) {
    throw new AuthorityError("APPROVAL_PREVIEW_MISMATCH", "approval does not bind the exact publication preview")
  }
  const trustedNow = new Date()
  validateApprovalWindow(plan, envelope, trustedNow)
  const handle = Object.freeze(Object.create(null))
  verifiedPublicationApprovals.set(handle, {
    plan,
    envelope,
    planDigest: plan.plan_digest,
    previewDigest,
  })
  return handle
}

/** @param {unknown} value */
export function isVerifiedPublicationApproval(value) {
  return ((typeof value === "object" && value !== null) || typeof value === "function")
    ? verifiedPublicationApprovals.has(/** @type {object} */ (value))
    : false
}

/**
 * Public headless authority seam. T13 may adapt Telegram commands to this seam;
 * renderers never call it and cannot create publication authority.
 * @param {{approvalAuthority:unknown,runtimeRoot:string,plan:any}} input
 */
export async function admitApprovedPublication(input) {
  const values = readStrictRecord(input, ["approvalAuthority", "plan", "runtimeRoot"], "PUBLICATION_ADMISSION_INVALID")
  const approval = (typeof values.approvalAuthority === "object" && values.approvalAuthority !== null) || typeof values.approvalAuthority === "function"
    ? verifiedPublicationApprovals.get(/** @type {object} */ (values.approvalAuthority))
    : undefined
  if (!approval) throw new AuthorityError("APPROVAL_AUTHORITY_UNVERIFIED", "publication approval authority is not verified")
  const plan = snapshotStrictValue(values.plan, "PUBLICATION_PLAN_INVALID")
  const computedPlanDigest = computePlanDigest(plan)
  if (plan.plan_digest !== computedPlanDigest || approval.planDigest !== computedPlanDigest) {
    throw new AuthorityError("APPROVAL_PLAN_MISMATCH", "approval does not bind the exact publication plan")
  }
  const preview = previewPlan(plan)
  const previewDigest = createHash("sha256").update(jcsCanonicalize(preview)).digest("hex")
  if (approval.previewDigest !== previewDigest) throw new AuthorityError("APPROVAL_PREVIEW_MISMATCH", "approval does not bind the exact publication preview")
  const envelope = approval.envelope
  const manifest = {
    ...plan,
    approval_receipt: {
      approver: envelope.approver,
      channel: envelope.channel,
      source_event_id: envelope.source_event_id,
      approved_plan_digest: envelope.approved_plan_digest,
      approved_at: envelope.approved_at,
    },
  }
  const trustedNow = new Date()
  await validateContract("publication-manifest", manifest, { now: trustedNow })
  const runtime = await openRuntimeRoot(values.runtimeRoot)
  await rejectFinalCustodyReplay(runtime.absolute, "consumed", envelope.source_event_id)
  await rejectFinalCustodyReplay(runtime.absolute, "rejected", envelope.source_event_id)
  const runtimeState = await loadPublicationRuntime(runtime.absolute)
  await validateCrossReleaseManifest(manifest, { ...runtimeState, now: trustedNow })
  if (runtime.names.includes("pending")) {
    const pendingMetadata = await lstat(path.join(runtime.absolute, "pending"))
    if (pendingMetadata.isSymbolicLink() || !pendingMetadata.isDirectory()) {
      throw new AuthorityError("PENDING_STATE_INVALID", "pending custody must be an ordinary directory")
    }
  }
  await installPendingManifest(runtime.absolute, manifest.manifest_id, envelope.source_event_id, Buffer.from(`${jcsCanonicalize(manifest)}\n`, "utf8"))
  return {
    manifestId: manifest.manifest_id,
    planDigest: manifest.plan_digest,
    sourceEventId: envelope.source_event_id,
    state: "pending",
  }
}
