import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises"
import path from "node:path"

import {
  ContractError,
  jcsCanonicalize,
  readContractJson,
  validateContract,
  validateReleaseAgainstManifest,
} from "./publication-contracts.mjs"
import { assertNoLinkAncestors, hasFsCode, isEqualToOrInside } from "./filesystem-safety.mjs"
import { verifyCandidateArtifactTree } from "./safe-release.mjs"
import {
  acquireRuntimeExclusiveLease,
  assertRuntimePathIdentity,
  captureRuntimePathIdentity,
} from "./runtime-exclusive-lease.mjs"

/** @param {unknown} value */
export function canonicalContractBytes(value) {
  return Buffer.from(`${jcsCanonicalize(value)}\n`, "utf8")
}

/** @param {string} value */
function asciiCaseFold(value) {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 0x20))
}

/** @param {string[]} names */
function rejectAsciiCaseCollisions(names) {
  const folded = new Set()
  for (const name of names) {
    const key = asciiCaseFold(name)
    if (folded.has(key)) throw new ContractError("PATH_CASE_COLLISION", "release directory contains a case-insensitive name collision")
    folded.add(key)
  }
}

/** @param {string} root @param {string} role */
async function openOrdinaryRoot(root, role) {
  const absolute = path.resolve(root)
  try {
    await assertNoLinkAncestors(absolute, {
      errorFactory: () => new ContractError("PATH_SYMLINK_NOT_ALLOWED", `${role} cannot contain a symlink, junction, or reparse point`),
    })
    const before = await lstat(absolute, { bigint: true })
    const canonical = await realpath(absolute)
    const after = await lstat(canonical, { bigint: true })
    if (canonical !== absolute || before.isSymbolicLink() || !before.isDirectory() || after.isSymbolicLink() || !after.isDirectory()
      || before.dev !== after.dev || before.ino !== after.ino) {
      throw new ContractError("RELEASE_ROOT_INVALID", `${role} must be an exact canonical ordinary directory`)
    }
    rejectAsciiCaseCollisions(await readdir(canonical))
    return canonical
  } catch (error) {
    if (error instanceof ContractError) throw error
    throw new ContractError("RELEASE_ROOT_INVALID", `${role} must be a readable exact canonical ordinary directory`)
  }
}

/** @param {string} parent @param {string} name */
async function inspectExactChild(parent, name) {
  let names
  try {
    names = await readdir(parent)
  } catch {
    throw new ContractError("RELEASE_ROOT_INVALID", "release parent directory could not be read")
  }
  rejectAsciiCaseCollisions(names)
  if (!names.includes(name)) {
    if (names.some((candidate) => asciiCaseFold(candidate) === asciiCaseFold(name))) {
      throw new ContractError("PATH_CASE_COLLISION", "release destination casing is not canonical")
    }
    try {
      await lstat(path.join(parent, name))
    } catch (error) {
      if (hasFsCode(error, "ENOENT")) return { exists: false, path: path.join(parent, name) }
      throw new ContractError("RELEASE_ROOT_INVALID", "release destination metadata could not be read")
    }
    throw new ContractError("PATH_CASE_COLLISION", "release destination spelling is not canonical")
  }
  const child = path.join(parent, name)
  let metadata
  try {
    metadata = await lstat(child)
  } catch {
    throw new ContractError("RELEASE_ROOT_INVALID", "release destination metadata could not be read")
  }
  if (metadata.isSymbolicLink()) throw new ContractError("PATH_SYMLINK_NOT_ALLOWED", "release destination cannot be a symlink, junction, or reparse point")
  return { exists: true, path: child, metadata }
}

/** @param {string} parent @param {string} prefix */
async function createExclusiveDirectory(parent, prefix) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = `${prefix}${process.pid}-${randomBytes(12).toString("hex")}`
    const destination = path.join(parent, name)
    try {
      await mkdir(destination)
      const metadata = await lstat(destination)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new ContractError("RELEASE_STAGING_INVALID", "exclusive staging path is not an ordinary directory")
      }
      return destination
    } catch (error) {
      if (hasFsCode(error, "EEXIST")) continue
      if (error instanceof ContractError) throw error
      throw new ContractError("RELEASE_STAGING_CREATE_FAILED", "exclusive staging directory could not be created")
    }
  }
  throw new ContractError("RELEASE_STAGING_CREATE_FAILED", "exclusive staging directory could not be allocated")
}

/** @param {string} candidateRoot @param {string} stagingRoot @param {any} receipt */
async function copyPublicArtifacts(candidateRoot, stagingRoot, receipt) {
  for (const artifact of receipt.artifacts) {
    const source = path.join(candidateRoot, ...artifact.path.split("/"))
    const destination = path.join(stagingRoot, ...artifact.path.split("/"))
    try {
      const before = await lstat(source, { bigint: true })
      if (before.isSymbolicLink() || !before.isFile()) {
        throw new ContractError("CANDIDATE_ARTIFACT_CLASS_INVALID", "candidate artifact tree may contain regular files only")
      }
      if (await realpath(source) !== source) {
        throw new ContractError("CANDIDATE_ARTIFACT_PATH_INVALID", "candidate artifact does not resolve canonically inside its root")
      }
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(source, destination, constants.COPYFILE_EXCL)
      const after = await lstat(source, { bigint: true })
      if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeNs !== after.mtimeNs || await realpath(source) !== source) {
        throw new ContractError("CANDIDATE_ARTIFACT_CHANGED_DURING_READ", "candidate artifact changed while it was copied")
      }
    } catch (error) {
      if (error instanceof ContractError) throw error
      throw new ContractError("RELEASE_ARTIFACT_COPY_FAILED", "candidate artifact could not be copied exclusively")
    }
  }
}

/** @param {string} directory @param {string} targetName */
async function snapshotTargetFile(directory, targetName) {
  const target = await inspectExactChild(directory, targetName)
  if (!target.exists) return { exists: false, bytes: undefined }
  if (!target.metadata?.isFile()) throw new ContractError("RUNTIME_FILE_CLASS_INVALID", "current release pointer must be an ordinary regular file")
  try {
    return { exists: true, bytes: await readFile(target.path) }
  } catch {
    throw new ContractError("RUNTIME_READ_FAILED", "current release pointer bytes could not be read")
  }
}

/** @param {{exists:boolean,bytes?:Buffer}} actual @param {Buffer|undefined} expected */
function targetMatches(actual, expected) {
  return expected === undefined ? !actual.exists : actual.exists && Buffer.isBuffer(actual.bytes) && actual.bytes.equals(expected)
}

/**
 * Prepare a same-directory, exclusive, synced replacement file. Callers may
 * perform final validation before invoking commitWithoutCheck; rename is the
 * sole pathname commit and has no unlink/copy fallback.
 * @param {{directory:string,targetName:string,bytes:Buffer,expectedTargetBytes?:Buffer,tempPrefix?:string,simulateReplaceFailure?:boolean}} input
 */
export async function prepareAtomicFileReplace({ directory, targetName, bytes, expectedTargetBytes, tempPrefix = ".current-release.tmp-", simulateReplaceFailure = false }) {
  if (!/^[A-Za-z0-9._-]+$/.test(targetName) || !/^[A-Za-z0-9._-]+$/.test(tempPrefix)) {
    throw new ContractError("CURRENT_POINTER_PATH_INVALID", "atomic replacement names must be single normalized filename segments")
  }
  const root = await openOrdinaryRoot(directory, "atomic pointer directory")
  const initial = await snapshotTargetFile(root, targetName)
  if (!targetMatches(initial, expectedTargetBytes)) {
    throw new ContractError("CURRENT_POINTER_CHANGED", "current release pointer changed after preflight")
  }
  const tempName = `${tempPrefix}${process.pid}-${randomBytes(12).toString("hex")}`
  const tempPath = path.join(root, tempName)
  let handle
  try {
    handle = await open(tempPath, "wx")
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    const metadata = await lstat(tempPath)
    if (metadata.isSymbolicLink() || !metadata.isFile() || !(await readFile(tempPath)).equals(bytes)) {
      throw new ContractError("CURRENT_POINTER_TEMP_INVALID", "current release pointer temp file failed exact read-back")
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await rm(tempPath, { force: true }).catch(() => {})
    if (error instanceof ContractError) throw error
    throw new ContractError("CURRENT_POINTER_WRITE_FAILED", "current release pointer temp file could not be written and synced")
  }

  let live = true
  return {
    tempPath,
    async assertTargetUnchanged() {
      const current = await snapshotTargetFile(root, targetName)
      if (!targetMatches(current, expectedTargetBytes)) {
        throw new ContractError("CURRENT_POINTER_CHANGED", "current release pointer changed after preflight")
      }
    },
    async commitWithoutCheck() {
      if (!live) throw new ContractError("CURRENT_POINTER_REPLACE_FAILED", "current release pointer replacement is no longer available")
      try {
        if (simulateReplaceFailure) throw new Error("fixed controlled replacement failure")
        await rename(tempPath, path.join(root, targetName))
        live = false
      } catch {
        throw new ContractError("CURRENT_POINTER_REPLACE_FAILED", "current release pointer could not be atomically replaced")
      }
    },
    async discard() {
      if (!live) return
      try {
        const metadata = await lstat(tempPath)
        if (!metadata.isSymbolicLink() && metadata.isFile() && (await readFile(tempPath)).equals(bytes)) {
          await rm(tempPath)
        }
      } catch (error) {
        if (!hasFsCode(error, "ENOENT")) return
      }
      live = false
    },
  }
}

/** Public unit seam for a complete stable atomic pointer replacement. */
/** @param {{directory:string,targetName:string,bytes:Buffer,expectedTargetBytes?:Buffer}} input */
export async function atomicReplaceFile(input) {
  const prepared = await prepareAtomicFileReplace(input)
  try {
    await prepared.assertTargetUnchanged()
    await prepared.commitWithoutCheck()
  } catch (error) {
    await prepared.discard()
    throw error
  }
}

/**
 * Select an already-installed sealed release. All target custody and artifact
 * validation belongs to the caller and must finish before this seam. The
 * immediate old-pointer check followed by one same-directory rename is the
 * branch's final fallible transaction step; there is no staging or cleanup.
 * @param {{runtimeRoot:string,pointer:any,previousPointerBytes?:Buffer}} input
 */
export async function selectExistingRelease(input) {
  await validateContract("current-release", input.pointer)
  const prepared = await prepareAtomicFileReplace({
    directory: input.runtimeRoot,
    targetName: "current-release.json",
    bytes: canonicalContractBytes(input.pointer),
    expectedTargetBytes: input.previousPointerBytes,
  })
  try {
    await prepared.assertTargetUnchanged()
    await prepared.commitWithoutCheck()
    return
  } catch (error) {
    await prepared.discard()
    throw error
  }
}

/** @param {string} custodyRoot @param {Buffer} manifestRaw @param {Buffer} receiptBytes @param {any} manifest @param {any} receipt */
async function verifyCustody(custodyRoot, manifestRaw, receiptBytes, manifest, receipt) {
  const metadata = await lstat(custodyRoot)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ContractError("CUSTODY_FINAL_COLLISION", "release custody destination is not an ordinary directory")
  }
  const names = await readdir(custodyRoot)
  rejectAsciiCaseCollisions(names)
  if (JSON.stringify([...names].sort()) !== JSON.stringify(["manifest.json", "release-receipt.json"])) {
    throw new ContractError("CUSTODY_FINAL_COLLISION", "release custody destination does not contain the exact contract set")
  }
  const manifestPath = path.join(custodyRoot, "manifest.json")
  const receiptPath = path.join(custodyRoot, "release-receipt.json")
  for (const file of [manifestPath, receiptPath]) {
    const fileMetadata = await lstat(file)
    if (fileMetadata.isSymbolicLink() || !fileMetadata.isFile()) {
      throw new ContractError("CUSTODY_FINAL_COLLISION", "release custody contracts must be ordinary regular files")
    }
  }
  if (!(await readFile(manifestPath)).equals(manifestRaw) || !(await readFile(receiptPath)).equals(receiptBytes)) {
    throw new ContractError("CUSTODY_FINAL_COLLISION", "release custody bytes do not exactly match this promotion")
  }
  const storedManifest = await readContractJson(manifestPath)
  const storedReceipt = await readContractJson(receiptPath)
  if (jcsCanonicalize(storedManifest) !== jcsCanonicalize(manifest)
    || jcsCanonicalize(storedReceipt) !== jcsCanonicalize(receipt)) {
    throw new ContractError("CUSTODY_FINAL_COLLISION", "release custody contracts do not exactly match this promotion")
  }
  await validateReleaseAgainstManifest(storedReceipt, storedManifest, { now: receipt.created_at })
}

/** @param {string} stagingRoot @param {string} manifestPath @param {Buffer} manifestRaw @param {Buffer} receiptBytes @param {any} manifest @param {any} receipt */
async function writeCustodyStaging(stagingRoot, manifestPath, manifestRaw, receiptBytes, manifest, receipt) {
  try {
    await copyFile(manifestPath, path.join(stagingRoot, "manifest.json"), constants.COPYFILE_EXCL)
    if (!(await readFile(path.join(stagingRoot, "manifest.json"))).equals(manifestRaw)
      || !(await readFile(manifestPath)).equals(manifestRaw)) {
      throw new ContractError("MANIFEST_CHANGED_DURING_RELEASE", "manifest bytes changed before custody installation")
    }
    const handle = await open(path.join(stagingRoot, "release-receipt.json"), "wx")
    try {
      await handle.writeFile(receiptBytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await verifyCustody(stagingRoot, manifestRaw, receiptBytes, manifest, receipt)
  } catch (error) {
    if (error instanceof ContractError) throw error
    throw new ContractError("CUSTODY_STAGING_WRITE_FAILED", "release custody staging could not be written")
  }
}

/** @param {string} candidate @param {any} receipt @param {any} manifest @param {Map<string,Buffer>} projectedMarkdown */
async function verifyRelease(candidate, receipt, manifest, projectedMarkdown) {
  try {
    await verifyCandidateArtifactTree({ root: candidate, receipt, manifest, projectedMarkdown })
  } catch (error) {
    if (error instanceof ContractError && error.code.startsWith("CANDIDATE_")) {
      throw new ContractError("RELEASE_FINAL_COLLISION", "release destination does not exactly match the sealed artifact tree")
    }
    throw error
  }
}

/** @param {string} candidate @param {string} parent @param {string} requiredPrefix */
async function removeOwnedTree(candidate, parent, requiredPrefix) {
  if (!candidate || path.dirname(candidate) !== parent || !path.basename(candidate).startsWith(requiredPrefix)
    || !isEqualToOrInside(parent, candidate)) return false
  try {
    const metadata = await lstat(candidate)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false
    await rm(candidate, { recursive: true, force: false })
    return true
  } catch (error) {
    return false
  }
}

/**
 * Shared ownership state for one uniquely-created run tree. Promotion consumes
 * it before selector commit; the caller's outer finally uses cleanup(), which
 * becomes a no-op once ownership has been consumed.
 * @param {string} runRoot
 * @param {{removeTree?:(ownedPath:string,options:{recursive:boolean,force:boolean})=>Promise<void>}} [operations]
 */
export function createOwnedRunLifecycle(runRoot, operations = {}) {
  const ownedPath = path.resolve(runRoot)
  const removeTree = operations.removeTree ?? rm
  let owned = true
  let removalInProgress = false

  async function removeAndConsume(/** @type {boolean} */ force) {
    if (!owned || removalInProgress) {
      throw new ContractError("RUN_OWNERSHIP_INVALID", "owned run lifecycle cannot be consumed more than once")
    }
    removalInProgress = true
    try {
      await removeTree(ownedPath, { recursive: true, force })
      try {
        await lstat(ownedPath)
        throw new ContractError("RUN_CLEANUP_FAILED", "owned run tree still exists after cleanup")
      } catch (error) {
        if (error instanceof ContractError) throw error
        if (!hasFsCode(error, "ENOENT")) throw new ContractError("RUN_CLEANUP_FAILED", "owned run tree cleanup could not be verified")
      }
      owned = false
    } finally {
      removalInProgress = false
    }
  }

  return {
    path: ownedPath,
    get owned() { return owned },
    async consumeBeforeCommit(/** @type {string} */ requestedPath) {
      if (path.resolve(requestedPath) !== ownedPath) {
        throw new ContractError("RUN_OWNERSHIP_INVALID", "promotion run root does not match caller ownership")
      }
      await removeAndConsume(false)
    },
    async cleanup() {
      if (!owned) return
      await removeAndConsume(true)
    },
  }
}

const testOnlyPromotionCases = new Set([
  "after-release-staging",
  "after-custody-staging",
  "after-release-install",
  "after-custody-install",
  "before-pointer-commit",
  "pointer-replace-failure",
  "pending-restore-failure",
])

/** @param {string|undefined} selected @param {string} phase */
function failControlledPromotionAt(selected, phase) {
  if (selected === phase) {
    throw new ContractError("PROMOTION_CONTROLLED_FAILURE", "controlled promotion failure")
  }
}

/**
 * Install a verified candidate into immutable public/private finals and select
 * it with one same-directory pointer rename. The run tree is removed before the
 * commit point; after rename succeeds this function performs no fallible work.
 * @param {{candidateRoot:string,runRoot:string,runOwnership:ReturnType<typeof createOwnedRunLifecycle>,releasesRoot:string,runtimeRoot:string,manifestPath:string,manifestRaw:Buffer,manifest:any,receipt:any,projectedMarkdown:Map<string,Buffer>,previousPointerBytes?:Buffer}} input
 * @param {string|undefined} promotionTestCase
 */
async function promoteReleaseCore(input, promotionTestCase) {
  const releasesRoot = await openOrdinaryRoot(input.releasesRoot, "releases root")
  const runtimeRoot = await openOrdinaryRoot(input.runtimeRoot, "runtime root")
  const candidateRoot = path.resolve(input.candidateRoot)
  const runRoot = path.resolve(input.runRoot)
  if (!input.runOwnership || input.runOwnership.path !== runRoot
    || typeof input.runOwnership.consumeBeforeCommit !== "function") {
    throw new ContractError("RUN_OWNERSHIP_INVALID", "promotion requires exact caller-owned run lifecycle state")
  }
  if (!isEqualToOrInside(runRoot, candidateRoot) || candidateRoot === runRoot) {
    throw new ContractError("CANDIDATE_ARTIFACT_ROOT_INVALID", "candidate root must be a child of the owned run root")
  }
  if (isEqualToOrInside(releasesRoot, runRoot) || isEqualToOrInside(runRoot, releasesRoot)
    || isEqualToOrInside(runtimeRoot, runRoot) || isEqualToOrInside(runRoot, runtimeRoot)
    || isEqualToOrInside(releasesRoot, runtimeRoot) || isEqualToOrInside(runtimeRoot, releasesRoot)) {
    throw new ContractError("PATH_OVERLAP_NOT_ALLOWED", "release, runtime, and owned run roots must be disjoint")
  }
  if (!(await readFile(input.manifestPath)).equals(input.manifestRaw)) {
    throw new ContractError("MANIFEST_CHANGED_DURING_RELEASE", "manifest bytes changed before release installation")
  }
  await validateReleaseAgainstManifest(input.receipt, input.manifest, { now: input.receipt.created_at })
  await verifyCandidateArtifactTree({ root: candidateRoot, receipt: input.receipt, manifest: input.manifest, projectedMarkdown: input.projectedMarkdown })

  const runtimeLease = await acquireRuntimeExclusiveLease(runtimeRoot)
  const trackedIdentities = new Map()
  /** @param {string} target */
  const trackIdentity = async (target) => {
    trackedIdentities.set(target, await captureRuntimePathIdentity(target))
  }
  /** @param {string} target */
  const markRemoved = async (target) => {
    await trackIdentity(target)
  }
  /** @param {string} root */
  const markTreeRemoved = async (root) => {
    const affected = [...trackedIdentities.keys()].filter((target) => target === root || isEqualToOrInside(root, target))
    for (const target of affected) await markRemoved(target)
  }
  /** @param {string} source @param {string} destination */
  const trackRename = async (source, destination) => {
    const affected = [...trackedIdentities.keys()].filter((target) => target === source || isEqualToOrInside(source, target))
    for (const target of affected) await markRemoved(target)
    for (const target of affected) {
      const relative = path.relative(source, target)
      const mapped = relative ? path.join(destination, relative) : destination
      await trackIdentity(mapped)
    }
  }
  const revalidateTransaction = async () => {
    await runtimeLease.assertOwned()
    for (const [target, identity] of trackedIdentities) {
      await assertRuntimePathIdentity(target, identity, target === runtimeRoot ? "runtime root" : "runtime transaction path")
    }
  }
  await trackIdentity(runtimeRoot)

  const receiptPath = `consumed/${input.manifest.manifest_id}/release-receipt.json`
  const pointer = { schema_version: 1, release_digest: input.receipt.release_digest, receipt_path: receiptPath }
  const pointerBytes = canonicalContractBytes(pointer)
  const receiptBytes = canonicalContractBytes(input.receipt)
  const releaseName = input.receipt.release_digest
  const custodyName = input.manifest.manifest_id

  let consumedCreated = false
  let releaseStage
  let custodyStage
  let releaseCreated = false
  let custodyCreated = false
  let releaseFinal
  let custodyFinal
  let pointerPrepared
  let pendingRoot
  let pendingManifestPath
  let pendingMoved = false

  try {
    await revalidateTransaction()
    const consumedState = await inspectExactChild(runtimeRoot, "consumed")
    const consumedRoot = consumedState.path
    if (!consumedState.exists) {
      await revalidateTransaction()
      await mkdir(consumedRoot)
      await trackIdentity(runtimeRoot)
      consumedCreated = true
    } else if (!consumedState.metadata?.isDirectory()) {
      throw new ContractError("RUNTIME_FILE_CLASS_INVALID", "runtime consumed custody must be an ordinary directory")
    }
    await trackIdentity(consumedRoot)
    await openOrdinaryRoot(consumedRoot, "runtime consumed custody")

    await revalidateTransaction()
    releaseStage = await createExclusiveDirectory(releasesRoot, ".release-staging-")
    await trackIdentity(releaseStage)
    custodyStage = await createExclusiveDirectory(consumedRoot, ".custody-staging-")
    await trackIdentity(custodyStage)
    await copyPublicArtifacts(candidateRoot, releaseStage, input.receipt)
    await verifyCandidateArtifactTree({ root: releaseStage, receipt: input.receipt, manifest: input.manifest, projectedMarkdown: input.projectedMarkdown })
    failControlledPromotionAt(promotionTestCase, "after-release-staging")
    await writeCustodyStaging(custodyStage, input.manifestPath, input.manifestRaw, receiptBytes, input.manifest, input.receipt)
    const pendingPathRoot = path.join(runtimeRoot, "pending")
    await trackIdentity(pendingPathRoot)
    await revalidateTransaction()
    let pendingEntry
    const pendingState = await inspectExactChild(runtimeRoot, "pending")
    if (pendingState.exists) {
      if (!pendingState.metadata?.isDirectory()) throw new ContractError("RUNTIME_FILE_CLASS_INVALID", "runtime pending custody must be an ordinary directory")
      pendingRoot = await openOrdinaryRoot(pendingState.path, "runtime pending custody")
      await trackIdentity(pendingRoot)
      pendingEntry = await inspectExactChild(pendingRoot, `${input.manifest.manifest_id}.json`)
    }
    if (pendingEntry?.exists) {
      pendingManifestPath = pendingEntry.path
      await trackIdentity(pendingManifestPath)
      if (!pendingEntry.metadata?.isFile() || !(await readFile(pendingManifestPath)).equals(input.manifestRaw)) {
        throw new ContractError("PENDING_CUSTODY_MISMATCH", "pending custody is not the exact approved manifest")
      }
      const stagedManifestPath = path.join(custodyStage, "manifest.json")
      await trackIdentity(stagedManifestPath)
      await revalidateTransaction()
      await rm(stagedManifestPath, { force: false })
      await markRemoved(stagedManifestPath)
      await rename(pendingManifestPath, stagedManifestPath)
      await trackRename(pendingManifestPath, stagedManifestPath)
      pendingMoved = true
      await verifyCustody(custodyStage, input.manifestRaw, receiptBytes, input.manifest, input.receipt)
    }
    failControlledPromotionAt(promotionTestCase, "after-custody-staging")

    await revalidateTransaction()
    pointerPrepared = await prepareAtomicFileReplace({
      directory: runtimeRoot,
      targetName: "current-release.json",
      bytes: pointerBytes,
      expectedTargetBytes: input.previousPointerBytes,
      simulateReplaceFailure: promotionTestCase === "pointer-replace-failure",
    })

    const releaseState = await inspectExactChild(releasesRoot, releaseName)
    const custodyState = await inspectExactChild(consumedRoot, custodyName)
    releaseFinal = releaseState.path
    custodyFinal = custodyState.path
    await trackIdentity(releaseFinal)
    await trackIdentity(custodyFinal)
    await revalidateTransaction()
    if (releaseState.exists || custodyState.exists) {
      if (!releaseState.exists || !custodyState.exists) {
        throw new ContractError(releaseState.exists ? "RELEASE_FINAL_COLLISION" : "CUSTODY_FINAL_COLLISION", "preexisting release and custody finals are incomplete")
      }
      if (!releaseState.metadata?.isDirectory()) throw new ContractError("RELEASE_FINAL_COLLISION", "release destination is not an ordinary directory")
      if (!custodyState.metadata?.isDirectory()) throw new ContractError("CUSTODY_FINAL_COLLISION", "custody destination is not an ordinary directory")
      await verifyRelease(releaseFinal, input.receipt, input.manifest, input.projectedMarkdown)
      await verifyCustody(custodyFinal, input.manifestRaw, receiptBytes, input.manifest, input.receipt)
      await revalidateTransaction()
      if (!await removeOwnedTree(releaseStage, releasesRoot, ".release-staging-")) {
        throw new ContractError("RELEASE_STAGING_CLEANUP_FAILED", "verified release staging could not be removed before pointer commit")
      }
      await markTreeRemoved(releaseStage)
      releaseStage = undefined
      if (!await removeOwnedTree(custodyStage, consumedRoot, ".custody-staging-")) {
        throw new ContractError("CUSTODY_STAGING_CLEANUP_FAILED", "verified custody staging could not be removed before pointer commit")
      }
      await markTreeRemoved(custodyStage)
      custodyStage = undefined
    } else {
      try {
        await revalidateTransaction()
        await rename(releaseStage, releaseFinal)
        await trackRename(releaseStage, releaseFinal)
        releaseCreated = true
        releaseStage = undefined
        failControlledPromotionAt(promotionTestCase, "after-release-install")
      } catch (error) {
        if (error instanceof ContractError) throw error
        throw new ContractError("RELEASE_FINAL_COLLISION", "release destination could not be installed exclusively")
      }
      try {
        await revalidateTransaction()
        await rename(custodyStage, custodyFinal)
        await trackRename(custodyStage, custodyFinal)
        custodyCreated = true
        custodyStage = undefined
        failControlledPromotionAt(promotionTestCase, "after-custody-install")
      } catch (error) {
        if (error instanceof ContractError) throw error
        throw new ContractError("CUSTODY_FINAL_COLLISION", "custody destination could not be installed exclusively")
      }
    }

    await verifyCandidateArtifactTree({ root: releaseFinal, receipt: input.receipt, manifest: input.manifest, projectedMarkdown: input.projectedMarkdown })
    await verifyCustody(custodyFinal, input.manifestRaw, receiptBytes, input.manifest, input.receipt)
    await pointerPrepared.assertTargetUnchanged()
    failControlledPromotionAt(promotionTestCase, "pending-restore-failure")
    failControlledPromotionAt(promotionTestCase, "before-pointer-commit")

    await revalidateTransaction()
    await input.runOwnership.consumeBeforeCommit(runRoot)
    await pointerPrepared.commitWithoutCheck()
    return { pointer, receiptPath, releaseDigest: input.receipt.release_digest }
  } catch (error) {
    try {
      await runtimeLease.assertOwned()
    } catch {
      throw new ContractError("RUNTIME_TRANSACTION_LEASE_LOST", "runtime transition lease was lost; custody cleanup was skipped")
    }
    if (pointerPrepared) await pointerPrepared.discard()
    let pendingRestoreFailed = false
    if (pendingMoved) {
      const pendingSource = custodyFinal
        ? path.join(custodyFinal, "manifest.json")
        : custodyStage ? path.join(custodyStage, "manifest.json") : undefined
      try {
        if (promotionTestCase === "pending-restore-failure" || !pendingSource || !pendingRoot || !pendingManifestPath) throw new Error("controlled pending restore failure")
        const pendingDestination = await inspectExactChild(pendingRoot, path.basename(pendingManifestPath))
        if (pendingDestination.exists) throw new Error("pending destination already exists")
        const sourceMetadata = await lstat(pendingSource)
        if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile() || !(await readFile(pendingSource)).equals(input.manifestRaw)) throw new Error("pending recovery source is not exact")
        await rename(pendingSource, pendingManifestPath)
        await trackRename(pendingSource, pendingManifestPath)
        const restoredMetadata = await lstat(pendingManifestPath)
        if (restoredMetadata.isSymbolicLink() || !restoredMetadata.isFile() || !(await readFile(pendingManifestPath)).equals(input.manifestRaw)) throw new Error("pending restore read-back failed")
        const sourceRoot = path.dirname(pendingSource)
        const remaining = await readdir(sourceRoot)
        if (JSON.stringify(remaining) !== JSON.stringify(["release-receipt.json"])) throw new Error("custody recovery root is not exact")
        await rm(path.join(sourceRoot, "release-receipt.json"), { force: false })
        await rmdir(sourceRoot)
        await markTreeRemoved(sourceRoot)
        if (sourceRoot === custodyFinal) {
          custodyFinal = undefined
          custodyCreated = false
        } else {
          custodyStage = undefined
        }
        pendingMoved = false
      } catch {
        pendingRestoreFailed = true
      }
    }
    if (pendingRestoreFailed) {
      throw new ContractError("PENDING_CUSTODY_RESTORE_FAILED", "pending custody restore failed; recovery custody and release evidence were retained")
    }
    const consumedRoot = path.join(runtimeRoot, "consumed")
    if (custodyCreated && custodyFinal) {
      try {
        await verifyCustody(custodyFinal, input.manifestRaw, receiptBytes, input.manifest, input.receipt)
        await rm(custodyFinal, { recursive: true, force: false })
        await markTreeRemoved(custodyFinal)
      } catch {}
    }
    if (releaseCreated && releaseFinal) {
      try {
        await verifyCandidateArtifactTree({ root: releaseFinal, receipt: input.receipt, manifest: input.manifest, projectedMarkdown: input.projectedMarkdown })
        await rm(releaseFinal, { recursive: true, force: false })
        await markTreeRemoved(releaseFinal)
      } catch {}
    }
    if (custodyStage && await removeOwnedTree(custodyStage, consumedRoot, ".custody-staging-")) await markTreeRemoved(custodyStage)
    if (releaseStage && await removeOwnedTree(releaseStage, releasesRoot, ".release-staging-")) await markTreeRemoved(releaseStage)
    if (consumedCreated) {
      try {
        if ((await readdir(consumedRoot)).length === 0) await rm(consumedRoot, { recursive: true, force: false })
      } catch {}
    }
    throw error
  } finally {
    await runtimeLease.release().catch(() => {})
  }
}

/**
 * Production promotion entry point. Extra caller properties are deliberately
 * ignored; fault selection is not part of the production promotion API.
 * @param {{candidateRoot:string,runRoot:string,runOwnership:ReturnType<typeof createOwnedRunLifecycle>,releasesRoot:string,runtimeRoot:string,manifestPath:string,manifestRaw:Buffer,manifest:any,receipt:any,projectedMarkdown:Map<string,Buffer>,previousPointerBytes?:Buffer}} input
 */
export async function promoteRelease(input) {
  return promoteReleaseCore(input, undefined)
}

/**
 * TEST-ONLY module seam for deterministic rollback regression coverage. It is
 * never imported by the production CLI and exposes only failures that do not
 * rewrite an existing live pointer.
 * @param {{candidateRoot:string,runRoot:string,runOwnership:ReturnType<typeof createOwnedRunLifecycle>,releasesRoot:string,runtimeRoot:string,manifestPath:string,manifestRaw:Buffer,manifest:any,receipt:any,projectedMarkdown:Map<string,Buffer>,previousPointerBytes?:Buffer}} input
 * @param {{faultCase:string}} options
 */
export async function promoteReleaseForTest(input, { faultCase }) {
  if (!testOnlyPromotionCases.has(faultCase)) {
    throw new ContractError("TEST_INJECTION_INVALID", "promotion regression injection is not a fixed supported variant")
  }
  return promoteReleaseCore(input, faultCase)
}
