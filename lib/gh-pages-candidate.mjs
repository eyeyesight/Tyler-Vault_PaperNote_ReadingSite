// @ts-check
import { createHash } from "node:crypto"
import { lstat, mkdir, open, readFile, readdir, realpath, rmdir } from "node:fs/promises"
import path from "node:path"
import { types as utilTypes } from "node:util"
import Ajv2020Module from "ajv/dist/2020.js"

import {
  ContractError,
  decodeContractJsonBytes,
  jcsCanonicalize,
  sha256Jcs,
} from "./publication-contracts.mjs"
import {
  computeGitHubLaunchAuditDigest,
  validateGitHubLaunchAudit,
} from "./github-launch-audit.mjs"
import { assertNoLinkAncestors, hasFsCode, isEqualToOrInside, pathsOverlap } from "./filesystem-safety.mjs"
import { readCandidateArtifactTree } from "./safe-release.mjs"
import {
  materializeVerifiedSealedRelease,
  revalidateVerifiedSealedRelease,
} from "./verified-sealed-release.mjs"

const candidateSchemaPath = path.resolve(import.meta.dirname, "..", "config", "gh-pages-candidate-v1.schema.json")
const deploymentContractPath = path.resolve(import.meta.dirname, "..", "config", "github-pages-deployment-contract-v1.json")
const candidateSchema = JSON.parse(await readFile(candidateSchemaPath, "utf8"))
const deploymentContract = JSON.parse(await readFile(deploymentContractPath, "utf8"))
const Ajv2020 = /** @type {any} */ (Ajv2020Module)
const metadataValidator = new Ajv2020({ allErrors: true, strict: true }).compile(candidateSchema)

const metadataName = "gh-pages-candidate-v1.json"
const launchAuditName = "github-launch-audit-v1.json"
const siteName = "site"
const publicationName = ".publication"
const nojekyllName = ".nojekyll"
const sha256Pattern = /^[a-f0-9]{64}$/
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** @param {unknown} bytes */
function sha256(bytes) {
  return createHash("sha256").update(/** @type {any} */ (bytes)).digest("hex")
}

/** @param {string} value */
function foldCase(value) {
  return value.normalize("NFC").toLowerCase()
}

/** @param {string} requested @param {string} canonical */
function sameCanonicalPathSpelling(requested, canonical) {
  return requested === canonical || (process.platform === "win32" && foldCase(requested) === foldCase(canonical))
}

/** @param {unknown} value @param {string} code @param {string} message */
function requireString(value, code, message) {
  if (typeof value !== "string" || value.length === 0) throw new ContractError(code, message)
  return value
}

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code)
}

/** @param {import("node:fs").BigIntStats} before @param {import("node:fs").BigIntStats} after */
function sameFileMetadata(before, after) {
  return before.isFile() && after.isFile() && !before.isSymbolicLink() && !after.isSymbolicLink()
    && before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.size === after.size && before.mtimeNs === after.mtimeNs
}

/** @param {import("node:fs").BigIntStats} before @param {import("node:fs").BigIntStats} after */
function sameDirectoryMetadata(before, after) {
  return before.isDirectory() && after.isDirectory() && !before.isSymbolicLink() && !after.isSymbolicLink()
    && before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.size === after.size && before.mtimeNs === after.mtimeNs
}

/** @param {string} relative */
function validateRelativeCandidatePath(relative) {
  if (typeof relative !== "string" || relative.length === 0
    || relative.startsWith("/") || relative.startsWith("\\\\") || /^[A-Za-z]:/.test(relative)
    || relative.includes("\\") || relative.includes("\0")) {
    throw new ContractError("CANDIDATE_PATH_INVALID", "candidate paths must be normalized relative paths")
  }
  const segments = relative.split("/")
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new ContractError("CANDIDATE_PATH_INVALID", "candidate paths must be normalized relative paths")
  }
}

/** @param {string[]} names @param {string} code @param {string} message */
function rejectCaseCollisions(names, code, message) {
  const seen = new Set()
  for (const name of names) {
    const folded = foldCase(name)
    if (seen.has(folded)) throw new ContractError(code, message)
    seen.add(folded)
  }
}

/** @param {{path:string,sha256:string,byteLength:number}[]} entries @param {string} label @param {boolean} [allowNojekyll] */
function normalizeInventory(entries, label, allowNojekyll = true) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ContractError("CANDIDATE_METADATA_INVALID", `${label} inventory must not be empty`)
  }
  const exact = new Set()
  const folded = new Set()
  const result = entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.path !== "string" || !sha256Pattern.test(entry.sha256)
      || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) {
      throw new ContractError("CANDIDATE_METADATA_INVALID", `${label} inventory entry is invalid`)
    }
    validateRelativeCandidatePath(entry.path)
    if (!allowNojekyll && entry.path === nojekyllName) {
      throw new ContractError("CANDIDATE_METADATA_INVALID", "sealed artifact inventory cannot contain .nojekyll")
    }
    if (exact.has(entry.path)) throw new ContractError("CANDIDATE_METADATA_INVALID", `${label} inventory contains a duplicate path`)
    const foldedPath = foldCase(entry.path)
    if (folded.has(foldedPath)) throw new ContractError("CANDIDATE_SITE_CASE_COLLISION", `${label} inventory contains a case collision`)
    exact.add(entry.path)
    folded.add(foldedPath)
    return { path: entry.path, sha256: entry.sha256, byteLength: entry.byteLength }
  })
  result.sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")))
  return result
}

/** @param {string} root @param {string} code @param {string} message */
async function openExistingDirectory(root, code, message) {
  const absolute = path.resolve(root)
  try {
    await assertNoLinkAncestors(absolute, {
      errorFactory: () => new ContractError("CANDIDATE_SYMLINK_NOT_ALLOWED", "candidate filesystem paths cannot contain symlinks or reparse points"),
    })
    const before = await lstat(absolute, { bigint: true })
    if (before.isSymbolicLink() || !before.isDirectory()) throw new ContractError(code, message)
    const canonical = await realpath(absolute)
    const after = await lstat(canonical, { bigint: true })
    if (!sameCanonicalPathSpelling(absolute, canonical) || !sameDirectoryMetadata(before, after)) throw new ContractError(code, message)
    return canonical
  } catch (error) {
    if (error instanceof ContractError) throw error
    throw new ContractError(code, message)
  }
}

/** @param {string} absolute @param {string} code @param {string} message */
async function readStableRegularFile(absolute, code, message) {
  let before
  let bytes
  let after
  try {
    await assertNoLinkAncestors(absolute, {
      errorFactory: () => new ContractError("CANDIDATE_SYMLINK_NOT_ALLOWED", "candidate filesystem paths cannot contain symlinks or reparse points"),
    })
    before = await lstat(absolute, { bigint: true })
    if (before.isSymbolicLink() || !before.isFile()) throw new ContractError(code, message)
    const resolved = await realpath(absolute)
    if (resolved !== absolute) throw new ContractError("CANDIDATE_SYMLINK_NOT_ALLOWED", "candidate files must resolve canonically")
    bytes = await readFile(absolute)
    after = await lstat(absolute, { bigint: true })
  } catch (error) {
    if (error instanceof ContractError) throw error
    throw new ContractError(code, message)
  }
  if (!sameFileMetadata(before, after) || BigInt(bytes.length) !== before.size) {
    throw new ContractError("CANDIDATE_FILE_CHANGED_DURING_READ", "candidate file changed during stable read")
  }
  return bytes
}

/** @param {string} root @param {string} relative @param {string} code */
async function readRootFile(root, relative, code) {
  validateRelativeCandidatePath(relative)
  const absolute = path.join(root, ...relative.split("/"))
  const resolved = path.resolve(absolute)
  if (!isEqualToOrInside(root, resolved)) throw new ContractError("CANDIDATE_PATH_INVALID", "candidate path escapes its root")
  return readStableRegularFile(resolved, code, "candidate contract file could not be read")
}

/** @param {string} root */
async function scanRegularTree(root) {
  const canonicalRoot = await openExistingDirectory(root, "CANDIDATE_SITE_ROOT_INVALID", "candidate site root must be an ordinary directory")
  /** @type {{path:string,sha256:string,byteLength:number}[]} */
  const files = []
  const foldedPaths = new Set()

  /** @param {string} directory @param {string} prefix */
  async function walk(directory, prefix) {
    let before
    let entries
    let after
    try {
      before = await lstat(directory, { bigint: true })
      if (before.isSymbolicLink() || !before.isDirectory()) throw new ContractError("CANDIDATE_SITE_CLASS_INVALID", "candidate site may contain only ordinary directories and regular files")
      entries = await readdir(directory)
      after = await lstat(directory, { bigint: true })
    } catch (error) {
      if (error instanceof ContractError) throw error
      throw new ContractError("CANDIDATE_SITE_READ_FAILED", "candidate site directory could not be read")
    }
    if (!sameDirectoryMetadata(before, after)) throw new ContractError("CANDIDATE_SITE_CHANGED_DURING_READ", "candidate site directory changed during read")
    rejectCaseCollisions(entries, "CANDIDATE_SITE_CASE_COLLISION", "candidate site contains a case-insensitive path collision")
    for (const name of entries) {
      const relative = prefix ? `${prefix}/${name}` : name
      validateRelativeCandidatePath(relative)
      const folded = foldCase(relative)
      if (foldedPaths.has(folded)) throw new ContractError("CANDIDATE_SITE_CASE_COLLISION", "candidate site contains a case-insensitive path collision")
      foldedPaths.add(folded)
      const absolute = path.join(directory, name)
      const metadata = await lstat(absolute, { bigint: true })
      if (metadata.isSymbolicLink()) throw new ContractError("CANDIDATE_SITE_CLASS_INVALID", "candidate site may not contain symlinks")
      if (metadata.isDirectory()) {
        const resolved = await realpath(absolute).catch(() => null)
        if (resolved !== absolute || !isEqualToOrInside(canonicalRoot, resolved)) throw new ContractError("CANDIDATE_SITE_PATH_INVALID", "candidate site directory does not resolve canonically inside its root")
        await walk(absolute, relative)
      } else if (metadata.isFile()) {
        const bytes = await readStableRegularFile(absolute, "CANDIDATE_SITE_CLASS_INVALID", "candidate site file must be a regular file")
        files.push({ path: relative, sha256: sha256(bytes), byteLength: bytes.length })
      } else {
        throw new ContractError("CANDIDATE_SITE_CLASS_INVALID", "candidate site may contain regular files only")
      }
    }
  }

  await walk(canonicalRoot, "")
  return files.sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")))
}

/** @param {string} root @param {string} child @param {string} code */
async function inspectFreshChild(root, child, code) {
  const absoluteRoot = path.resolve(root)
  const target = path.resolve(child)
  const parent = path.dirname(target)
  if (parent !== absoluteRoot) throw new ContractError(code, "fresh output roots must be one child of an existing ordinary parent")
  const canonicalParent = await openExistingDirectory(parent, "CANDIDATE_PARENT_INVALID", "candidate output parent must be an ordinary directory")
  let names
  try { names = await readdir(canonicalParent) } catch { throw new ContractError("CANDIDATE_PARENT_INVALID", "candidate output parent could not be read") }
  rejectCaseCollisions(names, "CANDIDATE_TARGET_CASE_COLLISION", "candidate output parent contains a case-insensitive collision")
  const name = path.basename(target)
  if (names.some((entry) => foldCase(entry) === foldCase(name))) {
    throw new ContractError("CANDIDATE_TARGET_NOT_FRESH", "candidate output root already exists")
  }
  const canonicalTarget = path.join(canonicalParent, name)
  try {
    await lstat(canonicalTarget)
    throw new ContractError("CANDIDATE_TARGET_NOT_FRESH", "candidate output root already exists")
  } catch (error) {
    if (error instanceof ContractError) throw error
    if (!hasFsCode(error, "ENOENT")) throw new ContractError("CANDIDATE_TARGET_NOT_FRESH", "candidate output root cannot be inspected")
  }
  return { target: canonicalTarget, parent: canonicalParent }
}

/** @param {string} target @param {string[]} protectedRoots @param {string[]} [namedRoots] */
function assertTargetDisjoint(target, protectedRoots, namedRoots = []) {
  const absolute = path.resolve(target)
  for (const protectedRoot of protectedRoots) {
    if (typeof protectedRoot !== "string" || protectedRoot.length === 0) continue
    if (pathsOverlap(absolute, protectedRoot)) throw new ContractError("CANDIDATE_TARGET_UNSAFE", "candidate output root overlaps protected release or source custody")
  }
  const sourceLikeNames = new Set(["source", "vault", "tyler-vault"])
  const segments = absolute.split(path.sep).filter(Boolean)
  if (segments.some((segment) => sourceLikeNames.has(foldCase(segment)))) {
    throw new ContractError("CANDIDATE_TARGET_UNSAFE", "candidate output root cannot be inside a source or Vault ancestry")
  }
  for (const root of namedRoots) {
    if (typeof root === "string" && root.length > 0 && pathsOverlap(absolute, root)) {
      throw new ContractError("CANDIDATE_TARGET_UNSAFE", "candidate output root overlaps a protected source ancestry")
    }
  }
}

/** @param {string} absolute @param {{path:string,dev:bigint,ino:bigint}|undefined} owner @param {string} code @param {string} message @param {boolean} [allowMissing] */
async function validateOwnedDirectory(absolute, owner, code, message, allowMissing = false) {
  await assertNoLinkAncestors(absolute, {
    allowMissing,
    errorFactory: () => new ContractError("CANDIDATE_SYMLINK_NOT_ALLOWED", "candidate filesystem paths cannot contain symlinks or reparse points"),
  })
  const metadata = await lstat(absolute, { bigint: true })
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
    || (owner && !matchesOwnedDirectory(owner, metadata))) {
    throw new ContractError(code, message)
  }
  const canonical = await realpath(absolute)
  const after = await lstat(canonical, { bigint: true })
  if (!sameCanonicalPathSpelling(absolute, canonical)
    || !sameDirectoryMetadata(metadata, after)
    || (owner && !matchesOwnedDirectory(owner, after))) {
    throw new ContractError(code, message)
  }
  return { path: canonical, dev: metadata.dev, ino: metadata.ino }
}

/** @param {{path:string,dev:bigint,ino:bigint}} owner @param {import("node:fs").BigIntStats} metadata */
function matchesOwnedDirectory(owner, metadata) {
  return metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.dev === owner.dev && metadata.ino === owner.ino
}

/** @param {string} target */
async function createOwnedDirectory(target) {
  let owner
  try {
    await mkdir(target)
    // Capture the identity immediately after the exclusive mkdir. Any later
    // validation must prove that this exact directory is still at this path.
    const metadata = await lstat(target, { bigint: true })
    owner = { path: target, dev: metadata.dev, ino: metadata.ino }
    const validated = await validateOwnedDirectory(target, owner, "CANDIDATE_TARGET_CREATE_FAILED", "candidate output root is not an ordinary directory")
    owner.path = validated.path
    return { path: validated.path, dev: owner.dev, ino: owner.ino }
  } catch (error) {
    await cleanupOwnedDirectory(owner)
    if (error instanceof ContractError) throw error
    if (hasFsCode(error, "EEXIST")) throw new ContractError("CANDIDATE_TARGET_NOT_FRESH", "candidate output root already exists")
    throw new ContractError("CANDIDATE_TARGET_CREATE_FAILED", "candidate output root could not be created exclusively")
  }
}

/** @param {{path:string,dev:bigint,ino:bigint}|undefined} owner */
async function cleanupOwnedDirectory(owner) {
  if (!owner) return
  try {
    await assertNoLinkAncestors(owner.path)
    const metadata = await lstat(owner.path, { bigint: true })
    if (!matchesOwnedDirectory(owner, metadata)) return
    const canonical = await realpath(owner.path)
    if (!sameCanonicalPathSpelling(owner.path, canonical)) return
    const canonicalMetadata = await lstat(canonical, { bigint: true })
    if (!sameDirectoryMetadata(metadata, canonicalMetadata) || !matchesOwnedDirectory(owner, canonicalMetadata)) return
    // The parent and output staging root are trusted against cooperating
    // same-user replacement during cleanup. These no-link and dev/ino checks
    // happen immediately before a best-effort, non-recursive rmdir of the
    // checked empty directory; they are not an atomic handle-bound operation
    // and do not claim resistance to a compromised or cooperating same-user
    // writer replacing the path after the checks.
    await rmdir(owner.path)
  } catch {
    // Cleanup is best effort and deliberately does not broaden deletion.
  }
}

/** @param {string} root @param {string} relative */
async function ensureOwnedDirectory(root, relative) {
  let current = root
  if (!relative) return current
  for (const segment of relative.split("/")) {
    validateRelativeCandidatePath(segment)
    current = path.join(current, segment)
    try {
      const validated = await validateOwnedDirectory(current, undefined, "CANDIDATE_OUTPUT_CLASS_INVALID", "candidate output directories must be ordinary directories", true)
      current = validated.path
    } catch (error) {
      if (error instanceof ContractError) throw error
      if (!hasCode(error, "ENOENT")) throw new ContractError("CANDIDATE_OUTPUT_CREATE_FAILED", "candidate output directory could not be inspected")
      try { await mkdir(current) } catch (mkdirError) {
        if (hasFsCode(mkdirError, "EEXIST")) throw new ContractError("CANDIDATE_OUTPUT_CREATE_FAILED", "candidate output directory was not created exclusively")
        throw new ContractError("CANDIDATE_OUTPUT_CREATE_FAILED", "candidate output directory could not be created")
      }
      let owner
      try {
        // Capture the identity immediately after the exclusive mkdir, before
        // resolving or otherwise operating on the new path.
        const created = await lstat(current, { bigint: true })
        owner = { path: current, dev: created.dev, ino: created.ino }
        const validated = await validateOwnedDirectory(current, owner, "CANDIDATE_OUTPUT_CLASS_INVALID", "candidate output directory is not ordinary")
        owner.path = validated.path
        current = validated.path
      } catch (validationError) {
        await cleanupOwnedDirectory(owner)
        if (validationError instanceof ContractError) throw validationError
        throw new ContractError("CANDIDATE_OUTPUT_CREATE_FAILED", "candidate output directory could not be validated")
      }
    }
  }
  return current
}

/** @param {string} destination @param {Buffer} bytes @param {string} code */
async function writeExclusiveFile(destination, bytes, code) {
  let handle
  try {
    handle = await open(destination, "wx")
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    const written = await readStableRegularFile(destination, code, "candidate output file could not be read back")
    if (!written.equals(bytes)) throw new ContractError("CANDIDATE_OUTPUT_HASH_MISMATCH", "candidate output file did not read back exactly")
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    if (error instanceof ContractError) throw error
    if (hasFsCode(error, "EEXIST")) throw new ContractError("CANDIDATE_OUTPUT_COLLISION", "candidate output file already exists")
    throw new ContractError(code, "candidate output file could not be written exclusively")
  }
}

/** @param {string} releaseRoot @param {{path:string,sha256:string,byteLength:number}} artifact */
async function readSourceArtifact(releaseRoot, artifact) {
  const absolute = path.resolve(releaseRoot, ...artifact.path.split("/"))
  if (!isEqualToOrInside(releaseRoot, absolute)) throw new ContractError("SEALED_ARTIFACT_PATH_INVALID", "sealed artifact path escapes the release root")
  const bytes = await readStableRegularFile(absolute, "SEALED_ARTIFACT_CLASS_INVALID", "sealed artifact is not an ordinary stable file")
  if (bytes.length !== artifact.byteLength || sha256(bytes) !== artifact.sha256) throw new ContractError("SEALED_ARTIFACT_HASH_MISMATCH", "sealed artifact bytes do not match its verified inventory")
  return bytes
}

/** @param {any} materialized */
function verifiedSourceSnapshot(materialized) {
  if (!materialized || typeof materialized !== "object" || Array.isArray(materialized)) throw new ContractError("VERIFIED_SEALED_RELEASE_CHANGED", "verified sealed release materialization is invalid")
  const authority = materialized.authority
  const release = materialized.release
  const receipt = materialized.receipt
  const manifest = materialized.manifest
  if (!authority || !release || !receipt || !manifest || !Buffer.isBuffer(materialized.manifestRaw) || !Buffer.isBuffer(materialized.receiptRaw)) {
    throw new ContractError("VERIFIED_SEALED_RELEASE_CHANGED", "verified sealed release materialization is incomplete")
  }
  if (manifest.manifest_id !== receipt.manifest_id
    || authority.sealedDescriptorId !== manifest.manifest_id
    || authority.receipt.receiptId !== receipt.release_digest
    || authority.approvedManifestDigest !== manifest.plan_digest
    || authority.receipt.receiptDigest !== sha256(materialized.receiptRaw)
    || sha256(materialized.manifestRaw) !== sha256(Buffer.from(`${jcsCanonicalize(manifest)}\n`, "utf8"))
    || sha256(materialized.receiptRaw) !== sha256(Buffer.from(`${jcsCanonicalize(receipt)}\n`, "utf8"))) {
    throw new ContractError("VERIFIED_SEALED_RELEASE_CHANGED", "sealed custody documents do not bind the verified release")
  }
  const releaseRoot = path.resolve(materialized.releasesRoot, authority.receipt.receiptId)
  if (path.resolve(materialized.releaseRoot) !== releaseRoot) throw new ContractError("VERIFIED_SEALED_RELEASE_CHANGED", "release root was not derived from verified custody")
  const inventory = normalizeInventory(authority.inventory, "sealed artifact", false)
  if (sha256Jcs(inventory) !== authority.artifact.artifactDigest) throw new ContractError("SEALED_ARTIFACT_INVENTORY_INVALID", "sealed artifact inventory digest is invalid")
  const total = inventory.reduce((sum, entry) => sum + entry.byteLength, 0)
  if (total !== authority.artifact.byteLength || total <= 0) throw new ContractError("SEALED_ARTIFACT_INVENTORY_INVALID", "sealed artifact byte length is invalid")
  return { materialized, inventory, releaseRoot }
}

/** @param {any} manifest */
function approvedReceiptProjection(manifest) {
  const approval = manifest.approval_receipt
  if (!approval || typeof approval !== "object") throw new ContractError("CANDIDATE_METADATA_INVALID", "approved manifest has no approval receipt")
  return {
    approver: approval.approver,
    channel: approval.channel,
    source_event_id: approval.source_event_id,
    approved_plan_digest: approval.approved_plan_digest,
    approved_at: approval.approved_at,
  }
}

/** @param {any} source @param {string} expectedUrl @param {string} basePath */
function buildMetadata(source, expectedUrl, basePath) {
  const { materialized, inventory } = source
  const manifest = materialized.manifest
  const receipt = materialized.receipt
  const approval = approvedReceiptProjection(manifest)
  const nojekyll = { path: nojekyllName, sha256: sha256(Buffer.alloc(0)), byteLength: 0 }
  const siteInventory = normalizeInventory([
    ...inventory.map((/** @type {{path:string,sha256:string,byteLength:number}} */ entry) => ({ ...entry, path: entry.path })),
    nojekyll,
  ], "candidate site")
  if (siteInventory.length !== inventory.length + 1) throw new ContractError("CANDIDATE_METADATA_INVALID", "candidate site inventory does not contain exactly one controlled .nojekyll")
  const unsigned = {
    schema_version: 1,
    candidate_kind: "gh-pages-candidate",
    source_release_identity: {
      release_id: materialized.release.releaseId,
      release_digest: materialized.release.releaseDigest,
      generation: materialized.release.generation,
    },
    source_artifact: {
      artifact_digest: materialized.authority.artifact.artifactDigest,
      byte_length: materialized.authority.artifact.byteLength,
      inventory,
    },
    approved_manifest: {
      manifest_id: manifest.manifest_id,
      plan_digest: manifest.plan_digest,
      manifest_sha256: sha256(materialized.manifestRaw),
      approval_receipt: approval,
    },
    approved_receipt: {
      release_digest: receipt.release_digest,
      receipt_sha256: sha256(materialized.receiptRaw),
      created_at: receipt.created_at,
    },
    rights_authority: {
      kind: "publication-manifest-approval",
      status: "approved",
      manifest_id: manifest.manifest_id,
      plan_digest: manifest.plan_digest,
      approval_receipt: approval,
    },
    expected_url: expectedUrl,
    base_path: basePath,
    candidate_site: {
      inventory: siteInventory,
      digest: sha256Jcs(siteInventory),
    },
  }
  return { ...unsigned, candidate_digest: sha256Jcs(unsigned) }
}

/** @param {unknown} value */
function rejectMetadataSecretsOrLocalPaths(value) {
  const forbiddenKey = /(credential|password|secret|access[_-]?token|private[_-]?key|token)/i
  const absoluteWindows = /^[A-Za-z]:[\\/]/
  const absoluteUnc = /^\\\\/
  const absolutePosix = /^\/(?!\/)/
  const credentialValue = /(?:ghp_|github_pat_|xox[baprs]-|bearer\s+|sk-[A-Za-z0-9])/i
  /** @param {unknown} node @param {string} [field] */
  function walk(node, field = "") {
    if (typeof node === "string") {
      const isApprovedBasePath = field === "base_path"
      if (absoluteWindows.test(node) || absoluteUnc.test(node) || (absolutePosix.test(node) && !isApprovedBasePath) || credentialValue.test(node)) {
        throw new ContractError("CANDIDATE_METADATA_SENSITIVE", "candidate metadata cannot contain credentials or local absolute paths")
      }
      return
    }
    if (!node || typeof node !== "object") return
    for (const key of Reflect.ownKeys(node)) {
      if (typeof key !== "string") throw new ContractError("CANDIDATE_METADATA_INVALID", "candidate metadata must be plain JSON")
      if (forbiddenKey.test(key)) throw new ContractError("CANDIDATE_METADATA_SENSITIVE", "candidate metadata cannot contain credentials")
      walk(/** @type {any} */ (node)[key], key)
    }
  }
  walk(value)
}

/** @param {any} metadata */
function validateMetadataSemantics(metadata) {
  if (!metadataValidator(metadata)) throw new ContractError("CANDIDATE_METADATA_SCHEMA_INVALID", "candidate metadata does not satisfy schema v1")
  rejectMetadataSecretsOrLocalPaths(metadata)
  const sourceInventory = normalizeInventory(metadata.source_artifact.inventory, "sealed artifact", false)
  const siteInventory = normalizeInventory(metadata.candidate_site.inventory, "candidate site")
  if (sha256Jcs(sourceInventory) !== metadata.source_artifact.artifact_digest) throw new ContractError("CANDIDATE_SOURCE_DIGEST_MISMATCH", "source artifact digest does not match its inventory")
  if (sha256Jcs(siteInventory) !== metadata.candidate_site.digest) throw new ContractError("CANDIDATE_SITE_DIGEST_MISMATCH", "candidate site digest does not match its inventory")
  const expectedCandidateDigest = sha256Jcs(Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "candidate_digest")))
  if (expectedCandidateDigest !== metadata.candidate_digest) throw new ContractError("CANDIDATE_DIGEST_MISMATCH", "candidate digest does not match metadata with itself omitted")

  const expectedSite = normalizeInventory([
    ...sourceInventory,
    { path: nojekyllName, sha256: sha256(Buffer.alloc(0)), byteLength: 0 },
  ], "expected candidate site")
  if (jcsCanonicalize(siteInventory) !== jcsCanonicalize(expectedSite)) throw new ContractError("CANDIDATE_SITE_SET_MISMATCH", "candidate site inventory does not equal the sealed inventory plus .nojekyll")
  if (metadata.source_artifact.byte_length !== sourceInventory.reduce((sum, entry) => sum + entry.byteLength, 0)) throw new ContractError("CANDIDATE_SOURCE_LENGTH_MISMATCH", "source artifact byte length does not match its inventory")
  if (metadata.approved_manifest.plan_digest !== metadata.approved_manifest.approval_receipt.approved_plan_digest
    || metadata.rights_authority.plan_digest !== metadata.approved_manifest.plan_digest
    || metadata.rights_authority.manifest_id !== metadata.approved_manifest.manifest_id
    || metadata.rights_authority.status !== "approved"
    || jcsCanonicalize(metadata.rights_authority.approval_receipt) !== jcsCanonicalize(metadata.approved_manifest.approval_receipt)) {
    throw new ContractError("CANDIDATE_RIGHTS_BINDING_MISMATCH", "rights authority does not equal the approved manifest authority")
  }

  if (!timestampPattern.test(metadata.approved_receipt.created_at)) throw new ContractError("CANDIDATE_METADATA_INVALID", "receipt timestamp is invalid")
  if (!metadata.expected_url.endsWith("/") || !metadata.expected_url.startsWith("https://") || metadata.base_path.includes("..") || metadata.base_path.includes("\\")) {
    throw new ContractError("CANDIDATE_SITE_IDENTITY_INVALID", "expected URL and base path are invalid")
  }
  try {
    const url = new URL(metadata.expected_url)
    const expectedPath = metadata.base_path === "/" ? "/" : `${metadata.base_path}/`
    if (url.pathname !== expectedPath || url.username || url.password) throw new Error("URL binding invalid")
  } catch {
    throw new ContractError("CANDIDATE_SITE_IDENTITY_INVALID", "expected URL and base path are invalid")
  }
  if (metadata.expected_url !== deploymentContract?.site?.expected_url || metadata.base_path !== deploymentContract?.site?.base_path) {
    throw new ContractError("CANDIDATE_SITE_IDENTITY_INVALID", "candidate URL and base path must equal the active deployment contract")
  }
  // Keep this explicit so a future inventory extension cannot silently omit the
  // one controlled Pages marker.
  if (!siteInventory.some((entry) => entry.path === nojekyllName && entry.byteLength === 0 && entry.sha256 === sha256(Buffer.alloc(0)))) {
    throw new ContractError("CANDIDATE_NOJEKYLL_INVALID", "candidate site must contain the controlled empty .nojekyll file")
  }
  return { sourceInventory, siteInventory }
}

/**
 * @param {string} candidateRoot
 * @param {{requireLaunchAudit?:boolean}} options
 * @returns {Promise<{root:string,metadata:any,sourceInventory:{path:string,sha256:string,byteLength:number}[],siteInventory:{path:string,sha256:string,byteLength:number}[],launchAuditDigest?:string}>}
 */
async function verifyCandidateInternal(candidateRoot, options = {}) {
  const root = await openExistingDirectory(candidateRoot, "CANDIDATE_ROOT_INVALID", "candidate root must be an ordinary directory")
  const rootNames = await readdir(root)
  rejectCaseCollisions(rootNames, "CANDIDATE_TREE_CASE_COLLISION", "candidate root contains a case-insensitive collision")
  if (rootNames.length !== 2 || !rootNames.includes(siteName) || !rootNames.includes(publicationName)) {
    throw new ContractError("CANDIDATE_TREE_SET_MISMATCH", "candidate root must contain exactly site and .publication")
  }
  const siteRoot = await openExistingDirectory(path.join(root, siteName), "CANDIDATE_SITE_ROOT_INVALID", "candidate site must be an ordinary directory")
  const publicationRoot = await openExistingDirectory(path.join(root, publicationName), "CANDIDATE_PUBLICATION_ROOT_INVALID", "candidate publication directory must be an ordinary directory")
  const publicationNames = await readdir(publicationRoot)
  rejectCaseCollisions(publicationNames, "CANDIDATE_PUBLICATION_CASE_COLLISION", "candidate publication contains a case-insensitive collision")
  const allowedPublication = new Set([metadataName, launchAuditName])
  if (publicationNames.some((name) => !allowedPublication.has(name)) || !publicationNames.includes(metadataName) || publicationNames.length > 2) {
    throw new ContractError("CANDIDATE_PUBLICATION_SET_MISMATCH", "candidate publication contains an unexpected file")
  }
  const metadataBytes = await readRootFile(publicationRoot, metadataName, "CANDIDATE_METADATA_MISSING")
  /** @type {any} */
  let metadata
  try { metadata = decodeContractJsonBytes(metadataBytes) } catch { throw new ContractError("CANDIDATE_METADATA_INVALID", "candidate metadata is not valid JSON") }
  if (utilTypes.isProxy(metadata)) throw new ContractError("CANDIDATE_METADATA_INVALID", "candidate metadata must be plain JSON")
  if (!Buffer.from(`${jcsCanonicalize(metadata)}\n`, "utf8").equals(metadataBytes)) throw new ContractError("CANDIDATE_METADATA_FORMAT_INVALID", "candidate metadata must be canonical JSON followed by one LF")
  const { sourceInventory, siteInventory } = validateMetadataSemantics(metadata)
  const actualSiteInventory = await scanRegularTree(siteRoot)
  if (jcsCanonicalize(actualSiteInventory) !== jcsCanonicalize(siteInventory)) {
    const actualPaths = actualSiteInventory.map((entry) => entry.path)
    const expectedPaths = siteInventory.map((entry) => entry.path)
    if (jcsCanonicalize(actualPaths) !== jcsCanonicalize(expectedPaths)) throw new ContractError("CANDIDATE_SITE_SET_MISMATCH", "candidate site file set differs from metadata")
    throw new ContractError("CANDIDATE_SITE_HASH_MISMATCH", "candidate site bytes differ from metadata")
  }
  if (jcsCanonicalize(actualSiteInventory) !== jcsCanonicalize(siteInventory)) throw new ContractError("CANDIDATE_SITE_HASH_MISMATCH", "candidate site bytes differ from metadata")
  let launchAuditDigest
  if (publicationNames.includes(launchAuditName)) {
    const auditBytes = await readRootFile(publicationRoot, launchAuditName, "LAUNCH_AUDIT_INVALID")
    let audit
    try { audit = decodeContractJsonBytes(auditBytes) } catch { throw new ContractError("LAUNCH_AUDIT_INVALID", "launch audit is not valid JSON") }
    let validated
    try { validated = validateGitHubLaunchAudit(audit) } catch { throw new ContractError("LAUNCH_AUDIT_INVALID", "launch audit failed its existing validator") }
    if (!Buffer.from(`${jcsCanonicalize(validated.value)}\n`, "utf8").equals(auditBytes)) throw new ContractError("LAUNCH_AUDIT_INVALID", "launch audit must be canonical JSON followed by one LF")
    if (validated.value.scope.sealed_artifact_digest !== metadata.source_artifact.artifact_digest) {
      throw new ContractError("LAUNCH_AUDIT_BINDING_MISMATCH", "launch audit does not bind the candidate sealed artifact")
    }
    launchAuditDigest = computeGitHubLaunchAuditDigest(validated.value)
  } else if (options.requireLaunchAudit) {
    throw new ContractError("LAUNCH_AUDIT_MISSING", "required GitHub launch audit is missing")
  }
  return { root, metadata, sourceInventory, siteInventory, launchAuditDigest }
}

/** @param {unknown} value @param {string} code @param {string} message */
function validateExpectedDigest(value, code, message) {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new ContractError(code, message)
  return value
}

/** @param {{metadata:any,launchAuditDigest?:string}} checked @param {string|undefined} expectedCandidateDigest @param {string|undefined} expectedLaunchAuditDigest */
function assertExpectedDigests(checked, expectedCandidateDigest, expectedLaunchAuditDigest) {
  if (expectedCandidateDigest !== undefined && checked.metadata.candidate_digest !== expectedCandidateDigest) {
    throw new ContractError("CANDIDATE_DIGEST_MISMATCH", "verified candidate digest does not match the expected candidate digest")
  }
  if (expectedLaunchAuditDigest !== undefined && checked.launchAuditDigest !== expectedLaunchAuditDigest) {
    throw new ContractError("LAUNCH_AUDIT_DIGEST_MISMATCH", "validated launch-audit digest does not match the expected launch-audit digest")
  }
}

/** @param {any} metadata @param {string|undefined} launchAuditDigest @param {boolean} staged */
function makeSummary(metadata, launchAuditDigest, staged) {
  const summary = /** @type {Record<string, any>} */ ({
    verified: true,
    schemaVersion: 1,
    candidateDigest: metadata.candidate_digest,
    sourceRelease: {
      releaseId: metadata.source_release_identity.release_id,
      releaseDigest: metadata.source_release_identity.release_digest,
      generation: metadata.source_release_identity.generation,
    },
    sourceArtifact: {
      artifactDigest: metadata.source_artifact.artifact_digest,
      byteLength: metadata.source_artifact.byte_length,
      inventory: metadata.source_artifact.inventory,
    },
    approvedManifest: metadata.approved_manifest,
    approvedReceipt: metadata.approved_receipt,
    rightsAuthority: metadata.rights_authority,
    expectedUrl: metadata.expected_url,
    basePath: metadata.base_path,
    site: {
      digest: metadata.candidate_site.digest,
      inventory: metadata.candidate_site.inventory,
    },
    staged,
  })
  if (launchAuditDigest !== undefined) summary.launchAuditDigest = launchAuditDigest
  return deepFreeze(structuredClone(summary))
}

/** @param {any} value */
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

/** @param {unknown} input */
function requirePrepareInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || utilTypes.isProxy(input)) throw new ContractError("CANDIDATE_INPUT_INVALID", "candidate preparation input must be an ordinary object")
  const values = /** @type {any} */ (input)
  requireString(values.targetRoot, "CANDIDATE_TARGET_INVALID", "candidate output root is required")
  const capability = values.verifiedSealedRelease ?? values.verifiedRelease
  if (capability === undefined) throw new ContractError("VERIFIED_SEALED_RELEASE_CAPABILITY_REQUIRED", "an opaque verified sealed release is required")
  return { values, capability }
}

/** @param {any} values */
function siteIdentity(values) {
  const configured = deploymentContract?.site
  const expectedUrl = values.expectedUrl ?? configured?.expected_url
  const basePath = values.basePath ?? configured?.base_path
  requireString(expectedUrl, "CANDIDATE_SITE_IDENTITY_INVALID", "expected Pages URL is required")
  requireString(basePath, "CANDIDATE_SITE_IDENTITY_INVALID", "Pages base path is required")
  if (expectedUrl !== configured?.expected_url || basePath !== configured?.base_path) {
    throw new ContractError("CANDIDATE_SITE_IDENTITY_INVALID", "expected Pages URL and base path must equal the approved deployment contract")
  }
  return { expectedUrl, basePath }
}

/** @param {any} before @param {any} after */
function assertSameVerifiedAuthority(before, after) {
  if (jcsCanonicalize(before.release) !== jcsCanonicalize(after.release)
    || jcsCanonicalize(before.authority) !== jcsCanonicalize(after.authority)) {
    throw new ContractError("VERIFIED_SEALED_RELEASE_CHANGED", "sealed release changed during candidate materialization")
  }
}

/** @param {string} candidateRoot @param {string} stageRoot @param {any[]} inventory */
async function copySiteToStage(candidateRoot, stageRoot, inventory) {
  for (const entry of inventory) {
    const source = path.join(candidateRoot, siteName, ...entry.path.split("/"))
    const bytes = await readStableRegularFile(source, "CANDIDATE_SITE_CLASS_INVALID", "candidate site file could not be copied")
    if (bytes.length !== entry.byteLength || sha256(bytes) !== entry.sha256) throw new ContractError("CANDIDATE_SITE_HASH_MISMATCH", "candidate site changed before staging")
    const parentRelative = path.posix.dirname(entry.path) === "." ? "" : path.posix.dirname(entry.path)
    const parent = await ensureOwnedDirectory(stageRoot, parentRelative)
    await writeExclusiveFile(path.join(parent, path.basename(entry.path)), bytes, "STAGE_OUTPUT_WRITE_FAILED")
  }
}

/** @param {string} stageRoot @param {any[]} expected */
async function verifyStageExact(stageRoot, expected) {
  const actual = await scanRegularTree(stageRoot)
  if (jcsCanonicalize(actual) !== jcsCanonicalize(expected)) throw new ContractError("STAGE_OUTPUT_MISMATCH", "staging output is not an exact site copy")
}

/**
 * Materialize a sealed release as a deterministic GitHub Pages candidate.
 * Only a branded VerifiedSealedRelease capability can supply source custody.
 * When supplied, sourceRoot is the operator-supplied trusted authority for the
 * canonical source tree and the output root must remain disjoint from it.
 * @param {{verifiedSealedRelease?:unknown,verifiedRelease?:unknown,targetRoot:string,sourceRoot?:string,vaultRoot?:string,sourceRoots?:string[],expectedUrl?:string,basePath?:string}} input
 */
export async function prepareGhPagesCandidate(input) {
  const { values, capability } = requirePrepareInput(input)
  const before = await revalidateVerifiedSealedRelease(capability)
  const materialized = await materializeVerifiedSealedRelease(capability)
  const source = verifiedSourceSnapshot(materialized)
  assertSameVerifiedAuthority(before, materialized)
  const identity = siteIdentity(values)
  const protectedRoots = [materialized.runtimeRoot, materialized.releasesRoot, materialized.releaseRoot]
  const namedRoots = [values.sourceRoot, values.vaultRoot, ...(Array.isArray(values.sourceRoots) ? values.sourceRoots : [])]
  assertTargetDisjoint(values.targetRoot, protectedRoots, namedRoots)
  const { target } = await inspectFreshChild(path.dirname(values.targetRoot), values.targetRoot, "CANDIDATE_TARGET_NOT_FRESH")
  const metadata = buildMetadata(source, identity.expectedUrl, identity.basePath)
  const metadataBytes = Buffer.from(`${jcsCanonicalize(metadata)}\n`, "utf8")
  let owner
  try {
    owner = await createOwnedDirectory(target)
    const siteRoot = await ensureOwnedDirectory(target, siteName)
    const publicationRoot = await ensureOwnedDirectory(target, publicationName)
    const sourceInventory = source.inventory
    for (const artifact of sourceInventory) {
      const bytes = await readSourceArtifact(source.releaseRoot, artifact)
      const parentRelative = path.posix.dirname(artifact.path) === "." ? "" : path.posix.dirname(artifact.path)
      const parent = await ensureOwnedDirectory(siteRoot, parentRelative)
      await writeExclusiveFile(path.join(parent, path.basename(artifact.path)), bytes, "CANDIDATE_OUTPUT_WRITE_FAILED")
    }
    const nojekyllParent = siteRoot
    await writeExclusiveFile(path.join(nojekyllParent, nojekyllName), Buffer.alloc(0), "CANDIDATE_OUTPUT_WRITE_FAILED")
    await writeExclusiveFile(path.join(publicationRoot, metadataName), metadataBytes, "CANDIDATE_METADATA_WRITE_FAILED")
    const checked = await verifyCandidateInternal(target)
    const after = await revalidateVerifiedSealedRelease(capability)
    assertSameVerifiedAuthority(before, after)
    return makeSummary(checked.metadata, checked.launchAuditDigest, false)
  } catch (error) {
    await cleanupOwnedDirectory(owner)
    if (error instanceof ContractError) throw error
    throw new ContractError("CANDIDATE_PREPARE_FAILED", "GitHub Pages candidate could not be prepared")
  }
}

/**
 * Verify a candidate's exact tree and, optionally, produce a site-only upload
 * staging root. The staging root is always fresh and is never allowed to retain
 * publication metadata.
 * @param {{candidateRoot:string,requireLaunchAudit?:boolean,stageOutputRoot?:string,expectedCandidateDigest?:string,expectedLaunchAuditDigest?:string}} input
 */
export async function verifyGhPagesCandidate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || utilTypes.isProxy(input)) throw new ContractError("CANDIDATE_INPUT_INVALID", "candidate verification input must be an ordinary object")
  const values = /** @type {any} */ (input)
  requireString(values.candidateRoot, "CANDIDATE_ROOT_INVALID", "candidate root is required")
  if (values.requireLaunchAudit !== undefined && typeof values.requireLaunchAudit !== "boolean") throw new ContractError("CANDIDATE_INPUT_INVALID", "requireLaunchAudit must be boolean")
  const expectedCandidateDigest = validateExpectedDigest(values.expectedCandidateDigest, "CANDIDATE_EXPECTED_DIGEST_INVALID", "expected candidate digest must be lowercase hexadecimal SHA-256")
  const expectedLaunchAuditDigest = validateExpectedDigest(values.expectedLaunchAuditDigest, "LAUNCH_AUDIT_EXPECTED_DIGEST_INVALID", "expected launch-audit digest must be lowercase hexadecimal SHA-256")
  const checked = await verifyCandidateInternal(values.candidateRoot, { requireLaunchAudit: values.requireLaunchAudit === true })
  assertExpectedDigests(checked, expectedCandidateDigest, expectedLaunchAuditDigest)
  if (values.stageOutputRoot === undefined) return makeSummary(checked.metadata, checked.launchAuditDigest, false)
  requireString(values.stageOutputRoot, "STAGE_OUTPUT_INVALID", "stage output root must be a non-empty path")
  assertTargetDisjoint(values.stageOutputRoot, [checked.root])
  const stageTargetInfo = await inspectFreshChild(path.dirname(values.stageOutputRoot), values.stageOutputRoot, "STAGE_OUTPUT_NOT_FRESH")
  let owner
  try {
    owner = await createOwnedDirectory(stageTargetInfo.target)
    await copySiteToStage(checked.root, stageTargetInfo.target, checked.siteInventory)
    await verifyStageExact(stageTargetInfo.target, checked.siteInventory)
    const rechecked = await verifyCandidateInternal(values.candidateRoot, { requireLaunchAudit: values.requireLaunchAudit === true })
    if (rechecked.metadata.candidate_digest !== checked.metadata.candidate_digest
      || rechecked.launchAuditDigest !== checked.launchAuditDigest) {
      throw new ContractError("CANDIDATE_CHANGED_DURING_STAGING", "candidate or launch audit changed during staging")
    }
    assertExpectedDigests(rechecked, expectedCandidateDigest, expectedLaunchAuditDigest)
    return makeSummary(rechecked.metadata, rechecked.launchAuditDigest, true)
  } catch (error) {
    await cleanupOwnedDirectory(owner)
    if (error instanceof ContractError) throw error
    throw new ContractError("STAGE_OUTPUT_FAILED", "site-only staging output could not be prepared")
  }
}

export const GH_PAGES_CANDIDATE_METADATA_PATH = `${publicationName}/${metadataName}`
export const GH_PAGES_CANDIDATE_LAUNCH_AUDIT_PATH = `${publicationName}/${launchAuditName}`
