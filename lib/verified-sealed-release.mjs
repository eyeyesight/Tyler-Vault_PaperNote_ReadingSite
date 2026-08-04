// @ts-check
import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { types as utilTypes } from "node:util"

import {
  ContractError,
  jcsCanonicalize,
  loadSealedCustodyByManifestId,
} from "./publication-contracts.mjs"
import { assertNoLinkAncestors } from "./filesystem-safety.mjs"
import { verifySealedArtifactTree } from "./safe-release.mjs"

/** @typedef {{releaseId:string,releaseDigest:string,generation:number}} Release */
/** @typedef {{path:string,sha256:string,byteLength:number}} InventoryEntry */
/** @typedef {{approvedManifestDigest:string,sealedDescriptorId:string,receipt:{receiptId:string,receiptDigest:string},artifact:{artifactDigest:string,byteLength:number},inventory:InventoryEntry[]}} SealedReleaseAuthority */
/** @typedef {{runtimeRoot:string,releasesRoot:string,manifestId:string,releaseRoot:string,release:Release,authority:SealedReleaseAuthority,evidenceDigest:string,manifest:any,receipt:any,manifestRaw:Buffer,receiptRaw:Buffer}} VerifiedState */

/** Module-private brand and state: object shape alone can never mint authority. @type {WeakMap<object,VerifiedState>} */
const verifiedStates = new WeakMap()

/** @param {Buffer|string} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

/** @param {string} releaseId @param {number} generation @param {SealedReleaseAuthority} authority */
function releaseFor(releaseId, generation, authority) {
  const descriptor = {
    schemaVersion: 1,
    releaseId,
    generation,
    approvedManifestDigest: authority.approvedManifestDigest,
    sealedDescriptorId: authority.sealedDescriptorId,
    receiptId: authority.receipt.receiptId,
    receiptDigest: authority.receipt.receiptDigest,
    artifactDigest: authority.artifact.artifactDigest,
    artifactByteLength: authority.artifact.byteLength,
    inventory: authority.inventory,
  }
  return { releaseId, releaseDigest: sha256(jcsCanonicalize(descriptor)), generation }
}

const rollbackIdPrefix = "pages-rollback-v1."

/** @param {string} manifestId @param {number} generation */
function rollbackReleaseIdFor(manifestId, generation) {
  const encodedManifestId = Buffer.from(manifestId, "utf8").toString("base64url")
  const releaseId = `${rollbackIdPrefix}${generation}.${encodedManifestId}`
  if (encodedManifestId.length === 0 || releaseId.length > 200) {
    throw new ContractError("VERIFIED_SEALED_RELEASE_IDENTITY_INVALID", "canonical rollback identity is not representable")
  }
  return releaseId
}

/** @param {Release} release */
function manifestIdForRelease(release) {
  if (!release.releaseId.startsWith(rollbackIdPrefix)) {
    if (release.releaseId.startsWith("pages-rollback-")) {
      throw new ContractError("VERIFIED_SEALED_RELEASE_IDENTITY_INVALID", "rollback identity must use the canonical reversible form")
    }
    return release.releaseId
  }
  const match = /^pages-rollback-v1\.([1-9][0-9]*)\.([A-Za-z0-9_-]+)$/.exec(release.releaseId)
  if (!match) throw new ContractError("VERIFIED_SEALED_RELEASE_IDENTITY_INVALID", "rollback identity is not canonical")
  const generation = Number(match[1])
  let manifestId
  try { manifestId = Buffer.from(match[2], "base64url").toString("utf8") } catch { manifestId = "" }
  if (!Number.isSafeInteger(generation) || generation !== release.generation
    || manifestId.length === 0
    || Buffer.from(manifestId, "utf8").toString("base64url") !== match[2]
    || rollbackReleaseIdFor(manifestId, generation) !== release.releaseId) {
    throw new ContractError("VERIFIED_SEALED_RELEASE_IDENTITY_INVALID", "rollback identity does not bind one source manifest and generation")
  }
  return manifestId
}

/** @param {unknown} value @returns {value is Release} */
function validReleaseIdentity(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false
  const release = /** @type {any} */ (value)
  return (Object.getPrototypeOf(release) === Object.prototype || Object.getPrototypeOf(release) === null)
    && Object.getOwnPropertySymbols(release).length === 0
    && JSON.stringify(Object.keys(release).sort()) === JSON.stringify(["generation", "releaseDigest", "releaseId"])
    && Object.values(Object.getOwnPropertyDescriptors(release)).every((descriptor) => "value" in descriptor && descriptor.enumerable)
    && typeof release.releaseId === "string" && release.releaseId.length > 0 && release.releaseId.length <= 200
    && typeof release.releaseDigest === "string" && /^[0-9a-f]{64}$/.test(release.releaseDigest)
    && Number.isSafeInteger(release.generation) && release.generation > 0
}

/** @param {unknown} value */
function assertLoadInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new ContractError("VERIFIED_SEALED_RELEASE_INPUT_INVALID", "verified sealed release input must be exact plain data")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors).sort()
  if (JSON.stringify(keys) !== JSON.stringify(["manifestId", "releasesRoot", "runtimeRoot"])
    || Object.values(descriptors).some((descriptor) => !("value" in descriptor) || !descriptor.enumerable)) {
    throw new ContractError("VERIFIED_SEALED_RELEASE_INPUT_INVALID", "verified sealed release input must name only trusted roots and manifest identity")
  }
  for (const key of keys) {
    const field = /** @type {PropertyDescriptor & {value:unknown}} */ (descriptors[key]).value
    if (typeof field !== "string" || field.length === 0) {
      throw new ContractError("VERIFIED_SEALED_RELEASE_INPUT_INVALID", "verified sealed release input fields must be non-empty strings")
    }
  }
}

/** @param {import("node:fs").BigIntStats} before @param {import("node:fs").BigIntStats} after */
function sameFile(before, after) {
  return before.isFile() && after.isFile() && !before.isSymbolicLink() && !after.isSymbolicLink()
    && before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.size === after.size && before.mtimeNs === after.mtimeNs
}

/**
 * Read size and hash from the same stable ordinary file used to create the
 * provider inventory. The T06 whole-tree verifier runs both before and after
 * this pass, so additions, removals, class changes, and byte changes fail closed.
 * @param {string} releaseRoot @param {any} receipt
 * @returns {Promise<InventoryEntry[]>}
 */
async function readStableInventory(releaseRoot, receipt) {
  /** @type {InventoryEntry[]} */
  const inventory = []
  for (const artifact of receipt.artifacts) {
    const absolute = path.join(releaseRoot, ...artifact.path.split("/"))
    try {
      await assertNoLinkAncestors(absolute, {
        errorFactory: () => new ContractError("VERIFIED_SEALED_RELEASE_BYTES_INVALID", "sealed artifact path is not an ordinary trusted filesystem path"),
      })
      const before = await lstat(absolute, { bigint: true })
      if (before.isSymbolicLink() || !before.isFile() || await realpath(absolute) !== absolute) throw new Error("not canonical regular file")
      const bytes = await readFile(absolute)
      const after = await lstat(absolute, { bigint: true })
      if (!sameFile(before, after) || BigInt(bytes.length) !== before.size || sha256(bytes) !== artifact.sha256) {
        throw new Error("unstable or digest mismatched file")
      }
      inventory.push({ path: artifact.path, sha256: artifact.sha256, byteLength: bytes.length })
    } catch (error) {
      if (error instanceof ContractError && error.code === "VERIFIED_SEALED_RELEASE_BYTES_INVALID") throw error
      throw new ContractError("VERIFIED_SEALED_RELEASE_BYTES_INVALID", "sealed artifact bytes could not be verified exactly")
    }
  }
  return inventory
}

/** @param {{runtimeRoot:string,releasesRoot:string,manifestId:string}} input @returns {Promise<VerifiedState>} */
async function readVerifiedState(input) {
  assertLoadInput(input)
  const runtimeRoot = path.resolve(input.runtimeRoot)
  const releasesRoot = path.resolve(input.releasesRoot)
  const custody = await loadSealedCustodyByManifestId(runtimeRoot, input.manifestId)
  const releaseRoot = path.join(releasesRoot, custody.receipt.release_digest)
  await verifySealedArtifactTree({ root: releaseRoot, receipt: custody.receipt })
  const inventory = await readStableInventory(releaseRoot, custody.receipt)
  await verifySealedArtifactTree({ root: releaseRoot, receipt: custody.receipt })

  const artifactByteLength = inventory.reduce((total, entry) => total + entry.byteLength, 0)
  if (!Number.isSafeInteger(artifactByteLength) || artifactByteLength <= 0) {
    throw new ContractError("VERIFIED_SEALED_RELEASE_BYTES_INVALID", "sealed artifact byte length is invalid")
  }
  const generation = Math.floor(Date.parse(custody.receipt.created_at) / 1000)
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new ContractError("VERIFIED_SEALED_RELEASE_IDENTITY_INVALID", "sealed receipt time cannot define a lifecycle generation")
  }
  const authority = {
    approvedManifestDigest: custody.manifest.plan_digest,
    sealedDescriptorId: custody.manifest.manifest_id,
    receipt: {
      receiptId: custody.receipt.release_digest,
      receiptDigest: sha256(custody.receiptRaw),
    },
    artifact: {
      artifactDigest: sha256(jcsCanonicalize(inventory)),
      byteLength: artifactByteLength,
    },
    inventory,
  }
  const release = releaseFor(custody.manifest.manifest_id, generation, authority)
  const evidenceDigest = sha256(jcsCanonicalize({
    release,
    authority,
    manifestRawSha256: sha256(custody.manifestRaw),
    receiptRawSha256: sha256(custody.receiptRaw),
  }))
  return {
    runtimeRoot,
    releasesRoot,
    manifestId: input.manifestId,
    releaseRoot,
    release,
    authority,
    evidenceDigest,
    manifest: structuredClone(custody.manifest),
    receipt: structuredClone(custody.receipt),
    manifestRaw: Buffer.from(custody.manifestRaw),
    receiptRaw: Buffer.from(custody.receiptRaw),
  }
}

/**
 * Mint an opaque capability only after T03 trusted-path checks, T06 sealed-custody
 * validation, and an exact T06 artifact-tree byte read-back all succeed.
 * @param {{runtimeRoot:string,releasesRoot:string,manifestId:string}} input
 */
export async function loadVerifiedSealedRelease(input) {
  const state = await readVerifiedState(input)
  const capability = Object.freeze(Object.create(null))
  verifiedStates.set(capability, state)
  return capability
}

/**
 * Recover opaque custody from either a normal manifest release identity or the
 * canonical reversible rollback lifecycle identity. No caller-supplied alias
 * map participates in recovery.
 * @param {{runtimeRoot:string,releasesRoot:string,release:Release}} input
 */
export async function loadVerifiedSealedReleaseForIdentity(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || utilTypes.isProxy(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    || Object.getOwnPropertySymbols(input).length !== 0
    || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(["release", "releasesRoot", "runtimeRoot"])
    || Object.values(Object.getOwnPropertyDescriptors(input)).some((descriptor) => !("value" in descriptor) || !descriptor.enumerable)
    || typeof input.runtimeRoot !== "string" || input.runtimeRoot.length === 0
    || typeof input.releasesRoot !== "string" || input.releasesRoot.length === 0
    || !validReleaseIdentity(input.release)) {
    throw new ContractError("VERIFIED_SEALED_RELEASE_INPUT_INVALID", "identity recovery input must be exact plain data")
  }
  const release = structuredClone(input.release)
  const manifestId = manifestIdForRelease(release)
  const source = await readVerifiedState({ runtimeRoot: input.runtimeRoot, releasesRoot: input.releasesRoot, manifestId })
  const recovered = release.releaseId.startsWith(rollbackIdPrefix)
    ? releaseFor(release.releaseId, release.generation, source.authority)
    : source.release
  if (jcsCanonicalize(recovered) !== jcsCanonicalize(release)) {
    throw new ContractError("VERIFIED_SEALED_RELEASE_IDENTITY_INVALID", "lifecycle identity digest does not match recovered sealed custody")
  }
  const state = { ...source, release }
  const capability = Object.freeze(Object.create(null))
  verifiedStates.set(capability, state)
  return capability
}

/** @param {unknown} capability @returns {VerifiedState} */
function requireState(capability) {
  if (!capability || typeof capability !== "object" || !verifiedStates.has(capability)) {
    throw new ContractError("VERIFIED_SEALED_RELEASE_CAPABILITY_REQUIRED", "an opaque filesystem-verified sealed release capability is required")
  }
  return /** @type {VerifiedState} */ (verifiedStates.get(capability))
}

/** Return only the provider-visible identity; this does not expose minting state. @param {unknown} capability */
export function verifiedSealedReleaseIdentity(capability) {
  return structuredClone(requireState(capability).release)
}

/**
 * Derive the one canonical reversible rollback lifecycle identity while keeping
 * old byte authority inside the opaque capability. The ID binds source manifest
 * identity plus the new generation and cannot be caller-aliased.
 * @param {unknown} capability @param {number} generation
 */
export function deriveVerifiedSealedReleaseIdentity(capability, generation) {
  const state = requireState(capability)
  if (!Number.isSafeInteger(generation) || generation <= state.release.generation) {
    throw new ContractError("VERIFIED_SEALED_RELEASE_INTENT_INVALID", "rollback generation must be a newer positive safe integer")
  }
  return releaseFor(rollbackReleaseIdFor(state.manifestId, generation), generation, state.authority)
}

/**
 * Re-read custody and every artifact byte. The returned evidence is a clone;
 * callers cannot alter the branded state. This is exported for the lifecycle
 * module but cannot accept a caller-constructed lookalike.
 * @param {unknown} capability
 */
export async function revalidateVerifiedSealedRelease(capability) {
  const expected = requireState(capability)
  const source = await readVerifiedState({
    runtimeRoot: expected.runtimeRoot,
    releasesRoot: expected.releasesRoot,
    manifestId: expected.manifestId,
  })
  const actualRelease = expected.release.releaseId.startsWith(rollbackIdPrefix)
    ? releaseFor(expected.release.releaseId, expected.release.generation, source.authority)
    : source.release
  if (source.evidenceDigest !== expected.evidenceDigest
    || jcsCanonicalize(actualRelease) !== jcsCanonicalize(expected.release)
    || jcsCanonicalize(source.authority) !== jcsCanonicalize(expected.authority)) {
    throw new ContractError("VERIFIED_SEALED_RELEASE_CHANGED", "sealed release custody or artifact bytes changed after verification")
  }
  return {
    release: structuredClone(actualRelease),
    authority: structuredClone(source.authority),
    runtimeRoot: source.runtimeRoot,
    releasesRoot: source.releasesRoot,
  }
}

/**
 * Materialize only cloned custody evidence needed by a downstream artifact
 * projector. The branded capability itself never leaves this module and no
 * caller-provided release root or custody object participates in the result.
 * @param {unknown} capability
 */
export async function materializeVerifiedSealedRelease(capability) {
  const expected = requireState(capability)
  const source = await readVerifiedState({
    runtimeRoot: expected.runtimeRoot,
    releasesRoot: expected.releasesRoot,
    manifestId: expected.manifestId,
  })
  const actualRelease = expected.release.releaseId.startsWith(rollbackIdPrefix)
    ? releaseFor(expected.release.releaseId, expected.release.generation, source.authority)
    : source.release
  if (source.evidenceDigest !== expected.evidenceDigest
    || jcsCanonicalize(actualRelease) !== jcsCanonicalize(expected.release)
    || jcsCanonicalize(source.authority) !== jcsCanonicalize(expected.authority)) {
    throw new ContractError("VERIFIED_SEALED_RELEASE_CHANGED", "sealed release custody or artifact bytes changed after verification")
  }
  return {
    runtimeRoot: source.runtimeRoot,
    releasesRoot: source.releasesRoot,
    releaseRoot: source.releaseRoot,
    release: structuredClone(actualRelease),
    authority: structuredClone(source.authority),
    manifest: structuredClone(source.manifest),
    receipt: structuredClone(source.receipt),
    manifestRaw: Buffer.from(source.manifestRaw),
    receiptRaw: Buffer.from(source.receiptRaw),
  }
}
