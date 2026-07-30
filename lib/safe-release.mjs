import { createHash } from "node:crypto"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"

import {
  ContractError,
  compareUtf8,
  jcsCanonicalize,
  sha256Jcs,
  validateContract,
  validateCrossReleaseManifest,
  validateReleaseAgainstManifest,
} from "./publication-contracts.mjs"

/** @typedef {{path:string,sha256:string}} Artifact */

/** @param {Buffer} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

/** @param {any} node */
function canonicalRoute(node) {
  return node.node_class === "paper"
    ? `/papers/${node.public_id}/`
    : `/knowledge/${node.node_class}/${node.public_id}/`
}

/** @param {unknown} left @param {unknown} right */
function sameJcs(left, right) {
  return jcsCanonicalize(left) === jcsCanonicalize(right)
}

/** @param {Map<string,Buffer>} projectedMarkdown @param {string} publicId */
function projectedBytes(projectedMarkdown, publicId) {
  const bytes = projectedMarkdown.get(publicId)
  if (!Buffer.isBuffer(bytes)) {
    throw new ContractError("RELEASE_FINGERPRINT_INPUT_INVALID", "projected Markdown must be supplied as exact UTF-8 bytes for every public node")
  }
  return bytes
}

/** @param {any} manifest @param {Map<string,Buffer>} projectedMarkdown */
export function computeContentFingerprints(manifest, projectedMarkdown) {
  if (!(projectedMarkdown instanceof Map)) {
    throw new ContractError("RELEASE_FINGERPRINT_INPUT_INVALID", "projected Markdown must be keyed by public ID")
  }
  const publicIds = new Set(manifest.nodes.map((/** @type {any} */ node) => node.public_id))
  if (projectedMarkdown.size !== publicIds.size || [...projectedMarkdown.keys()].some((publicId) => !publicIds.has(publicId))) {
    throw new ContractError("RELEASE_FINGERPRINT_SET_MISMATCH", "projected Markdown must exactly equal the manifest public node set")
  }
  return manifest.nodes
    .map((/** @type {any} */ node) => ({
      public_id: node.public_id,
      route: canonicalRoute(node),
      sha256: sha256(projectedBytes(projectedMarkdown, node.public_id)),
    }))
    .sort((/** @type {any} */ left, /** @type {any} */ right) => compareUtf8(left.public_id, right.public_id))
}

/**
 * Validate the receipt bytes named by the approved manifest baseline before any
 * optional Zotero metadata can be inherited. The receipt path is supplied by
 * the already-read runtime context; this seam performs no filesystem access.
 * @param {any} manifest @param {any|undefined} currentReceipt
 * @param {string|undefined} currentReceiptPath @param {string} createdAt
 */
async function approvedBaselineReceipt(manifest, currentReceipt, currentReceiptPath, createdAt) {
  const genesis = manifest.action.kind === "publish-unit" && manifest.action.baseline.kind === "genesis"
  if (genesis) {
    if (currentReceipt !== undefined || currentReceiptPath !== undefined) {
      throw new ContractError("RELEASE_BASELINE_REQUIRED", "genesis manifest cannot inherit current release metadata")
    }
    await validateCrossReleaseManifest(manifest, { now: createdAt })
    return undefined
  }
  if (currentReceipt === undefined && currentReceiptPath === undefined) {
    await validateCrossReleaseManifest(manifest, { now: createdAt })
    return undefined
  }
  if (currentReceipt === undefined || currentReceiptPath === undefined) {
    throw new ContractError("CURRENT_STATE_INCOMPLETE", "baseline inheritance requires both the current receipt and its resolved path")
  }
  await validateContract("release-receipt", currentReceipt)
  await validateCrossReleaseManifest(manifest, {
    now: createdAt,
    currentPointer: {
      schema_version: 1,
      release_digest: currentReceipt.release_digest,
      receipt_path: currentReceiptPath,
    },
    currentReceipt,
    receiptPath: currentReceiptPath,
  })
  return currentReceipt
}

/**
 * Construct and seal an in-memory release receipt. This function performs no
 * filesystem writes. Existing Zotero baseline metadata is cloned only from the
 * standalone-valid receipt named exactly by the approved release baseline; a
 * newly published node never synthesizes it.
 */
/** @param {{manifest:any,currentReceipt?:any,currentReceiptPath?:string,createdAt:string,projectedMarkdown:Map<string,Buffer>,artifacts:Artifact[]}} input */
export async function constructReleaseReceipt({ manifest, currentReceipt, currentReceiptPath, createdAt, projectedMarkdown, artifacts }) {
  const approvedReceipt = await approvedBaselineReceipt(manifest, currentReceipt, currentReceiptPath, createdAt)
  const currentById = new Map((approvedReceipt?.nodes ?? []).map((/** @type {any} */ node) => [node.public_id, node]))
  const nodes = manifest.nodes.map((/** @type {any} */ node) => {
    /** @type {any} */
    const releaseNode = {
      public_id: node.public_id,
      path: node.path,
      node_class: node.node_class,
      source_sha256: node.source_sha256,
    }
    const baseline = currentById.get(node.public_id)
    if (baseline && Object.hasOwn(baseline, "zotero_baseline")) {
      releaseNode.zotero_baseline = structuredClone(baseline.zotero_baseline)
    }
    return releaseNode
  })
  const computedArtifacts = structuredClone(artifacts)
  const computedFingerprints = computeContentFingerprints(manifest, projectedMarkdown)
  const unsigned = {
    schema_version: 1,
    manifest_id: manifest.manifest_id,
    plan_digest: manifest.plan_digest,
    public_set_digest: manifest.public_set_digest,
    created_at: createdAt,
    nodes,
    artifacts: computedArtifacts,
    content_fingerprints: computedFingerprints,
  }
  const receipt = { ...unsigned, release_digest: sha256Jcs(unsigned) }

  await validateReleaseAgainstManifest(receipt, manifest, { now: createdAt })
  if (!sameJcs(receipt.artifacts, computedArtifacts)) {
    throw new ContractError("RELEASE_ARTIFACT_BUILD_BINDING_MISMATCH", "sealed receipt artifacts differ from the computed candidate artifacts")
  }
  if (!sameJcs(receipt.content_fingerprints, computedFingerprints)) {
    throw new ContractError("RELEASE_FINGERPRINT_BUILD_BINDING_MISMATCH", "sealed receipt fingerprints differ from projected Markdown bytes")
  }
  return receipt
}

/** @param {string} root @param {string} candidate */
function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** @param {string} value */
function asciiCaseFold(value) {
  return value.replace(/[A-Z]/g, (/** @type {string} */ character) => String.fromCharCode(character.charCodeAt(0) + 0x20))
}

/** @param {import("node:fs").BigIntStats} before @param {import("node:fs").BigIntStats} after */
function sameFileMetadata(before, after) {
  return before.isFile() && after.isFile()
    && before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
}

/** @param {string} root */
async function openCandidateRoot(root) {
  let before
  let canonical
  let after
  try {
    before = await lstat(root, { bigint: true })
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new ContractError("CANDIDATE_ARTIFACT_ROOT_INVALID", "candidate artifact root must be an ordinary directory")
    }
    canonical = await realpath(root)
    after = await lstat(canonical, { bigint: true })
  } catch (error) {
    if (error instanceof ContractError) throw error
    throw new ContractError("CANDIDATE_ARTIFACT_ROOT_INVALID", "candidate artifact root could not be opened")
  }
  if (path.resolve(root) !== canonical || after.isSymbolicLink() || !after.isDirectory()
    || before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs) {
    throw new ContractError("CANDIDATE_ARTIFACT_ROOT_INVALID", "candidate artifact root is not a stable canonical ordinary directory")
  }
  return canonical
}

/** @param {string} relative */
function validateArtifactPath(relative) {
  if (!relative || relative.includes("\\") || relative.startsWith("/") || path.posix.isAbsolute(relative)) {
    throw new ContractError("CANDIDATE_ARTIFACT_PATH_INVALID", "candidate artifact path is not a normalized public relative path")
  }
  const segments = relative.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ContractError("CANDIDATE_ARTIFACT_PATH_INVALID", "candidate artifact path is not a normalized public relative path")
  }
}

/** @param {string} canonicalRoot @param {string} absolute @param {string} relative */
async function readStableRegularFile(canonicalRoot, absolute, relative) {
  let before
  let bytes
  let after
  let resolved
  try {
    before = await lstat(absolute, { bigint: true })
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new ContractError("CANDIDATE_ARTIFACT_CLASS_INVALID", "candidate artifact tree may contain regular files only")
    }
    resolved = await realpath(absolute)
    if (!inside(canonicalRoot, resolved) || resolved !== absolute) {
      throw new ContractError("CANDIDATE_ARTIFACT_PATH_INVALID", "candidate artifact path does not resolve canonically inside its root")
    }
    bytes = await readFile(absolute)
    after = await lstat(absolute, { bigint: true })
  } catch (error) {
    if (error instanceof ContractError) throw error
    throw new ContractError("CANDIDATE_ARTIFACT_READ_FAILED", "candidate artifact bytes could not be read back")
  }
  if (!sameFileMetadata(before, after) || BigInt(bytes.length) !== before.size) {
    throw new ContractError("CANDIDATE_ARTIFACT_CHANGED_DURING_READ", "candidate artifact metadata changed during read-back")
  }
  return { path: relative, sha256: sha256(bytes) }
}

/** Enumerate and hash the exact regular-file candidate tree without writes. */
/** @param {string} root */
export async function readCandidateArtifactTree(root) {
  const canonicalRoot = await openCandidateRoot(root)
  /** @type {Artifact[]} */
  const artifacts = []
  const foldedPaths = new Set()

  /** @param {string} directory @param {string} prefix */
  async function walk(directory, prefix) {
    let before
    let entries
    let after
    try {
      before = await lstat(directory, { bigint: true })
      if (before.isSymbolicLink() || !before.isDirectory()) {
        throw new ContractError("CANDIDATE_ARTIFACT_CLASS_INVALID", "candidate artifact tree may contain ordinary directories and regular files only")
      }
      entries = await readdir(directory, { withFileTypes: true })
      after = await lstat(directory, { bigint: true })
    } catch (error) {
      if (error instanceof ContractError) throw error
      throw new ContractError("CANDIDATE_ARTIFACT_READ_FAILED", "candidate artifact directory could not be read back")
    }
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs) {
      throw new ContractError("CANDIDATE_ARTIFACT_CHANGED_DURING_READ", "candidate artifact directory metadata changed during read-back")
    }
    const siblingNames = new Set()
    for (const entry of entries) {
      const foldedName = asciiCaseFold(entry.name)
      if (siblingNames.has(foldedName)) {
        throw new ContractError("CANDIDATE_ARTIFACT_CASE_COLLISION", "candidate artifact tree contains a case-insensitive path collision")
      }
      siblingNames.add(foldedName)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      validateArtifactPath(relative)
      const foldedRelative = asciiCaseFold(relative)
      if (foldedPaths.has(foldedRelative)) {
        throw new ContractError("CANDIDATE_ARTIFACT_CASE_COLLISION", "candidate artifact tree contains a case-insensitive path collision")
      }
      foldedPaths.add(foldedRelative)
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        const resolved = await realpath(absolute).catch(() => null)
        if (!resolved || resolved !== absolute || !inside(canonicalRoot, resolved)) {
          throw new ContractError("CANDIDATE_ARTIFACT_PATH_INVALID", "candidate artifact directory does not resolve canonically inside its root")
        }
        await walk(absolute, relative)
      } else if (entry.isFile()) {
        artifacts.push(await readStableRegularFile(canonicalRoot, absolute, relative))
      } else {
        throw new ContractError("CANDIDATE_ARTIFACT_CLASS_INVALID", "candidate artifact tree may contain regular files only")
      }
    }
  }

  await walk(canonicalRoot, "")
  return artifacts.sort((left, right) => compareUtf8(left.path, right.path))
}

/**
 * Read-only verifier for an already-sealed public release. This proves only the
 * exact path/class/hash artifact binding in the receipt; it deliberately makes
 * no claim about source or projected-content fingerprint recomputation.
 * @param {{root:string,receipt:any}} input
 */
export async function verifySealedArtifactTree({ root, receipt }) {
  await validateContract("release-receipt", receipt)
  let actualArtifacts
  try {
    actualArtifacts = await readCandidateArtifactTree(root)
  } catch (error) {
    if (error instanceof ContractError && error.code.startsWith("CANDIDATE_ARTIFACT_")) {
      throw new ContractError("RELEASE_ARTIFACT_READBACK_INVALID", "sealed release artifact tree could not be read exactly")
    }
    throw error
  }
  const expectedPaths = receipt.artifacts.map((/** @type {any} */ artifact) => artifact.path)
  const actualPaths = actualArtifacts.map((artifact) => artifact.path)
  if (!sameJcs(actualPaths, expectedPaths)) {
    throw new ContractError("RELEASE_ARTIFACT_SET_MISMATCH", "sealed release artifact set differs from its receipt")
  }
  if (!sameJcs(actualArtifacts, receipt.artifacts)) {
    throw new ContractError("RELEASE_ARTIFACT_HASH_MISMATCH", "sealed release artifact bytes differ from its receipt")
  }
  return { artifacts: actualArtifacts.length, verified: true }
}

/** Revalidate the sealed receipt and byte-read the candidate tree against it. */
/** @param {{root:string,receipt:any,manifest:any,projectedMarkdown:Map<string,Buffer>}} input */
export async function verifyCandidateArtifactTree({ root, receipt, manifest, projectedMarkdown }) {
  await validateReleaseAgainstManifest(receipt, manifest, { now: receipt.created_at })
  const expectedFingerprints = computeContentFingerprints(manifest, projectedMarkdown)
  if (!sameJcs(receipt.content_fingerprints, expectedFingerprints)) {
    throw new ContractError("RELEASE_FINGERPRINT_BUILD_BINDING_MISMATCH", "sealed receipt fingerprints differ from projected Markdown bytes")
  }
  const actualArtifacts = await readCandidateArtifactTree(root)
  const expectedPaths = receipt.artifacts.map((/** @type {any} */ artifact) => artifact.path)
  const actualPaths = actualArtifacts.map((artifact) => artifact.path)
  if (!sameJcs(actualPaths, expectedPaths)) {
    throw new ContractError("CANDIDATE_ARTIFACT_SET_MISMATCH", "candidate artifact set differs from the sealed release receipt")
  }
  if (!sameJcs(actualArtifacts, receipt.artifacts)) {
    throw new ContractError("CANDIDATE_ARTIFACT_HASH_MISMATCH", "candidate artifact bytes differ from the sealed release receipt")
  }
  return { artifacts: actualArtifacts.length, verified: true }
}
