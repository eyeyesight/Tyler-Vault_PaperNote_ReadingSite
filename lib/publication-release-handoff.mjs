// @ts-check
import { spawn } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { types as utilTypes } from "node:util"

import {
  consumeVerifiedExportInput,
  consumeVerifiedPendingReleaseContext,
} from "./publication-handoff.mjs"
import {
  jcsCanonicalize,
  loadPublicationRuntime,
  loadSealedCustodyByManifestId,
} from "./publication-contracts.mjs"
import {
  loadVerifiedSealedRelease,
  revalidateVerifiedSealedRelease,
  verifiedSealedReleaseIdentity,
} from "./verified-sealed-release.mjs"
import { assertNoLinkAncestors } from "./filesystem-safety.mjs"
import {
  acquireRuntimeExclusiveLease,
  assertRuntimePathIdentity,
  captureRuntimePathIdentity,
} from "./runtime-exclusive-lease.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const tracerPath = path.join(repoRoot, "scripts", "tracer.mjs")

export class PublicationReleaseHandoffError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** @param {unknown} value @param {string[]} keys @param {string} code @param {string} message */
function exactPlainRecord(value, keys, code, message) {
  if (!isRecord(value) || utilTypes.isProxy(value)) throw new PublicationReleaseHandoffError(code, message)
  let descriptors
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length !== 0) {
      throw new Error("non-plain object")
    }
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    throw new PublicationReleaseHandoffError(code, message)
  }
  const names = Object.keys(descriptors).sort()
  if (JSON.stringify(names) !== JSON.stringify([...keys].sort())
    || Object.values(descriptors).some((descriptor) => !("value" in descriptor) || descriptor.enumerable !== true)) {
    throw new PublicationReleaseHandoffError(code, message)
  }
  return /** @type {Record<string,unknown>} */ (value)
}

/** @param {unknown} input */
function requireInput(input) {
  const top = exactPlainRecord(input, ["formalBuildInput", "pendingAuthority", "trustedRoots"], "RELEASE_HANDOFF_INPUT_INVALID", "release handoff input must contain only verified capabilities and trusted roots")
  const topDescriptors = Object.getOwnPropertyDescriptors(top)
  const pendingAuthority = topDescriptors.pendingAuthority.value
  const formalBuildInput = topDescriptors.formalBuildInput.value
  const roots = topDescriptors.trustedRoots.value
  if (utilTypes.isProxy(pendingAuthority) || utilTypes.isProxy(formalBuildInput)) {
    throw new PublicationReleaseHandoffError("RELEASE_HANDOFF_INPUT_INVALID", "release handoff capabilities must be opaque verified handles")
  }
  const trustedRoots = exactPlainRecord(roots, ["releasesRoot", "vaultRoot", "workRoot"], "RELEASE_HANDOFF_ROOTS_INVALID", "release handoff trusted roots are invalid")
  const descriptors = Object.getOwnPropertyDescriptors(trustedRoots)
  if (Object.values(descriptors).some((descriptor) => typeof descriptor.value !== "string" || descriptor.value.length === 0)) {
    throw new PublicationReleaseHandoffError("RELEASE_HANDOFF_ROOTS_INVALID", "release handoff trusted roots are invalid")
  }
  return /** @type {{pendingAuthority:unknown,formalBuildInput:unknown,trustedRoots:{releasesRoot:string,vaultRoot:string,workRoot:string}}} */ ({
    pendingAuthority,
    formalBuildInput,
    trustedRoots: {
      releasesRoot: /** @type {string} */ (descriptors.releasesRoot.value),
      vaultRoot: /** @type {string} */ (descriptors.vaultRoot.value),
      workRoot: /** @type {string} */ (descriptors.workRoot.value),
    },
  })
}

/** @typedef {{path:string,public_id:string,node_class:string,source_sha256:string}} ManifestNode */
/** @typedef {{manifest:{manifest_id:string,plan_digest:string,public_set_digest:string,nodes:ManifestNode[]},runtimeRoot:string,manifestPath:string}} PendingContext */
/** @typedef {{manifest:{manifest_id:string,plan_digest:string,nodes:ManifestNode[]},exportReceipt:{manifest_id:string,plan_digest:string},fileBindings:{path:string,publicId:string,nodeClass:string,sourceSha256:string}[],exportRoot:string}} ExportContext */

/** @param {PendingContext} pending @param {ExportContext} exported */
function assertSameAuthority(pending, exported) {
  if (jcsCanonicalize(pending.manifest) !== jcsCanonicalize(exported.manifest)
    || pending.manifest.manifest_id !== exported.manifest.manifest_id
    || pending.manifest.plan_digest !== exported.manifest.plan_digest
    || pending.manifest.plan_digest !== exported.exportReceipt.plan_digest
    || pending.manifest.manifest_id !== exported.exportReceipt.manifest_id) {
    throw new PublicationReleaseHandoffError("RELEASE_MANIFEST_BINDING_MISMATCH", "verified pending and export authority do not bind the same manifest")
  }
  const expected = pending.manifest.nodes.map((/** @type {ManifestNode} */ node) => ({
    path: node.path,
    publicId: node.public_id,
    nodeClass: node.node_class,
    sourceSha256: node.source_sha256,
  })).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  const actual = [...exported.fileBindings].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  if (jcsCanonicalize(actual) !== jcsCanonicalize(expected)) {
    throw new PublicationReleaseHandoffError("RELEASE_FILE_BINDING_MISMATCH", "verified export file bindings do not match the manifest")
  }
}

/** @typedef {{ok:true,command:"release",manifestId:string,releaseDigest:string,receiptPath:string,routes:string[],files:number,outcome?:string}} PinnedReleaseResult */

/** @param {unknown} value */
function isStrictJsonObject(value) {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return false
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor && descriptor.enumerable === true)
}

/** @param {unknown} value @returns {value is PinnedReleaseResult} */
function strictReleaseResult(value) {
  if (!isStrictJsonObject(value)) return false
  const record = /** @type {Record<string,unknown>} */ (value)
  const keys = Object.keys(record).sort()
  const allowed = ["command", "files", "manifestId", "ok", "outcome", "receiptPath", "releaseDigest", "routes"]
  if (!(JSON.stringify(keys) === JSON.stringify(allowed) || JSON.stringify(keys) === JSON.stringify(allowed.filter((key) => key !== "outcome")))) return false
  return record.ok === true && record.command === "release"
    && typeof record.manifestId === "string" && /^VPUB-[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.manifestId)
    && typeof record.releaseDigest === "string" && /^[a-f0-9]{64}$/.test(record.releaseDigest)
    && typeof record.receiptPath === "string" && /^consumed\/[A-Za-z0-9-]+\/release-receipt\.json$/.test(record.receiptPath)
    && Array.isArray(record.routes) && record.routes.every((route) => typeof route === "string")
    && typeof record.files === "number" && Number.isSafeInteger(record.files) && record.files >= 1
    && (record.outcome === undefined || typeof record.outcome === "string")
}

/** @param {unknown} value */
function strictReleaseFailure(value) {
  if (!isStrictJsonObject(value)) return false
  const record = /** @type {Record<string,unknown>} */ (value)
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["error", "ok"])) return false
  const error = record.error
  if (!isStrictJsonObject(error)) return false
  const errorRecord = /** @type {Record<string,unknown>} */ (error)
  return record.ok === false
    && JSON.stringify(Object.keys(errorRecord).sort()) === JSON.stringify(["code", "message"])
    && typeof errorRecord.code === "string" && /^[A-Z0-9_]+$/.test(errorRecord.code)
    && typeof errorRecord.message === "string"
}

const pinnedReleaseDeadlineMs = 10 * 60 * 1000
const pinnedReleaseOutputLimitBytes = 1024 * 1024
const pinnedReleaseEnvironmentKeys = [
  "PATH", "PATHEXT", "SystemRoot", "WINDIR", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ComSpec", "CI", "NO_COLOR",
]

function pinnedReleaseEnvironment() {
  /** @type {Record<string,string>} */
  const environment = {}
  for (const name of pinnedReleaseEnvironmentKeys) {
    const value = process.env[name] ?? (name === "PATH" ? process.env.Path : undefined)
    if (typeof value === "string") environment[name] = value
  }
  return environment
}

/** @param {import("node:child_process").ChildProcess} child */
function terminatePinnedRelease(child) {
  try { child.kill("SIGKILL") } catch {}
  if (process.platform === "win32" && child.pid) {
    try {
      const tree = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        shell: false,
        stdio: "ignore",
      })
      tree.unref()
    } catch {}
  }
}

/** @param {string[]} args @returns {Promise<PinnedReleaseResult>} */
function runPinnedRelease(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tracerPath, "release", ...args], {
      cwd: repoRoot,
      env: pinnedReleaseEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    })
    /** @type {Buffer[]} */
    const stdout = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let outputLimitExceeded = false
    let timedOut = false
    let terminated = false
    /** @type {Error|undefined} */
    let startError
    const terminate = () => {
      if (terminated) return
      terminated = true
      terminatePinnedRelease(child)
    }
    /** @param {Buffer|string} chunk */
    const appendStdout = (chunk) => {
      if (outputLimitExceeded) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      stdoutBytes += bytes.length
      if (stdoutBytes > pinnedReleaseOutputLimitBytes) {
        outputLimitExceeded = true
        terminate()
      } else stdout.push(bytes)
    }
    child.stdout.on("data", appendStdout)
    child.stderr.on("data", (/** @type {Buffer|string} */ chunk) => {
      if (outputLimitExceeded) return
      stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), "utf8")
      if (stderrBytes > pinnedReleaseOutputLimitBytes) {
        outputLimitExceeded = true
        terminate()
      }
    })
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, pinnedReleaseDeadlineMs)
    child.once("error", (error) => { startError = error })
    child.once("close", (code, signal) => {
      clearTimeout(timer)
      const completion = { code, signal }
      if (startError) {
        reject(new PublicationReleaseHandoffError("RELEASE_PROVIDER_FAILED", "pinned release process could not start"))
        return
      }
      if (timedOut) {
        reject(new PublicationReleaseHandoffError("RELEASE_PROVIDER_FAILED", "pinned release timed out; pending authority remains retryable"))
        return
      }
      if (outputLimitExceeded) {
        reject(new PublicationReleaseHandoffError("RELEASE_PROVIDER_FAILED", "pinned release exceeded its bounded output; pending authority remains retryable"))
        return
      }
      let result
      try { result = JSON.parse(Buffer.concat(stdout).toString("utf8").trim()) } catch { result = undefined }
      if (completion.code !== 0 || completion.signal !== null || !strictReleaseResult(result)) {
        if (completion.code !== 0 && !strictReleaseFailure(result)) {
          reject(new PublicationReleaseHandoffError("RELEASE_PROVIDER_FAILED", "pinned release failed with a redacted stable result"))
        } else {
          reject(new PublicationReleaseHandoffError("RELEASE_PROVIDER_FAILED", "pinned release failed; pending authority remains retryable"))
        }
        return
      }
      resolve(result)
    })
  })
}

/** @param {PendingContext} pending */
async function assertPendingAuthorityExact(pending) {
  const expected = Buffer.from(`${jcsCanonicalize(pending.manifest)}\n`, "utf8")
  try {
    await assertNoLinkAncestors(pending.manifestPath, { errorFactory: () => new Error("pending authority path changed") })
    const before = await lstat(pending.manifestPath, { bigint: true })
    if (before.isSymbolicLink() || !before.isFile()) throw new Error("pending authority class changed")
    const actual = await readFile(pending.manifestPath)
    const after = await lstat(pending.manifestPath, { bigint: true })
    if (after.isSymbolicLink() || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || !actual.equals(expected)) throw new Error("pending authority bytes changed")
  } catch {
    try {
      const runtime = await loadPublicationRuntime(pending.runtimeRoot)
      if (runtime.currentManifest && jcsCanonicalize(runtime.currentManifest) === jcsCanonicalize(pending.manifest)) return
    } catch {}
    throw new PublicationReleaseHandoffError("PENDING_AUTHORITY_TAMPERED", "verified pending authority no longer matches its approved canonical bytes")
  }
}

/** @param {string} filename @param {Buffer} bytes */
async function writeVerifiedStageFile(filename, bytes) {
  await writeFile(filename, bytes, { flag: "wx", mode: 0o600 })
  if (!(await readFile(filename)).equals(bytes)) throw new PublicationReleaseHandoffError("REJECTED_CUSTODY_WRITE_FAILED", "rejected custody read-back failed")
}

/** @param {PendingContext} pending @param {string} reasonCode */
async function transitionPendingToRejected(pending, reasonCode) {
  const runtimeRoot = path.resolve(pending.runtimeRoot)
  const rejectedRoot = path.join(runtimeRoot, "rejected")
  const rejectedFinal = path.join(rejectedRoot, pending.manifest.manifest_id)
  const manifestBytes = Buffer.from(`${jcsCanonicalize(pending.manifest)}\n`, "utf8")
  const rejectionBytes = Buffer.from(`${jcsCanonicalize({ schema_version: 1, manifest_id: pending.manifest.manifest_id, reason_code: reasonCode })}\n`, "utf8")
  const assertExactRuntimeEntries = async () => {
    const names = await readdir(runtimeRoot)
    const allowed = new Set(["pending", "consumed", "rejected", "current-release.json"])
    const folded = names.map((name) => name.toLowerCase())
    if (new Set(folded).size !== names.length || names.some((name) => !allowed.has(name))) {
      throw new Error("runtime custody entries are not exact")
    }
  }
  /** @type {import("./runtime-exclusive-lease.mjs").RuntimeExclusiveLease|undefined} */
  let runtimeLease
  const trackedIdentities = new Map()
  /** @param {string} target */
  const trackIdentity = async (target) => {
    trackedIdentities.set(target, await captureRuntimePathIdentity(target))
  }
  /** @param {string} source @param {string} destination */
  const trackRename = async (source, destination) => {
    const affected = [...trackedIdentities.keys()].filter((target) => target === source || target.startsWith(`${source}${path.sep}`))
    for (const target of affected) await trackIdentity(target)
    for (const target of affected) {
      const relative = path.relative(source, target)
      await trackIdentity(relative ? path.join(destination, relative) : destination)
    }
  }
  const revalidateTransaction = async () => {
    if (!runtimeLease) throw new PublicationReleaseHandoffError("RUNTIME_TRANSACTION_LEASE_LOST", "runtime transition lease was not acquired")
    await runtimeLease.assertOwned()
    for (const [target, identity] of trackedIdentities) await assertRuntimePathIdentity(target, identity, "rejected runtime transaction path")
  }
  try {
    runtimeLease = await acquireRuntimeExclusiveLease(runtimeRoot)
    await trackIdentity(runtimeRoot)
    await trackIdentity(pending.manifestPath)
    await trackIdentity(rejectedRoot)
    await trackIdentity(rejectedFinal)
    await assertNoLinkAncestors(runtimeRoot)
    const runtimeMetadata = await lstat(runtimeRoot)
    if (runtimeMetadata.isSymbolicLink() || !runtimeMetadata.isDirectory()) throw new Error("runtime root is not ordinary")
    await assertExactRuntimeEntries()
    await revalidateTransaction()
    try { await mkdir(rejectedRoot) } catch (error) {
      if ((/** @type {{code?:string}} */ (error))?.code !== "EEXIST") throw error
    }
    await trackIdentity(runtimeRoot)
    await trackIdentity(rejectedRoot)
    await assertExactRuntimeEntries()
    await assertNoLinkAncestors(rejectedRoot)
    const rejectedMetadata = await lstat(rejectedRoot)
    if (rejectedMetadata.isSymbolicLink() || !rejectedMetadata.isDirectory()) throw new Error("rejected root is not ordinary")
    const names = await readdir(rejectedRoot)
    const folded = names.map((name) => name.toLowerCase())
    if (new Set(folded).size !== names.length || folded.includes(pending.manifest.manifest_id.toLowerCase())) throw new Error("rejected identity collision")
    await revalidateTransaction()
    const stage = await mkdtemp(path.join(rejectedRoot, `.rejected-staging-${process.pid}-`))
    await trackIdentity(stage)
    let finalInstalled = false
    try {
      await writeVerifiedStageFile(path.join(stage, "manifest.json"), manifestBytes)
      await writeVerifiedStageFile(path.join(stage, "rejection.json"), rejectionBytes)
      if (JSON.stringify((await readdir(stage)).sort()) !== JSON.stringify(["manifest.json", "rejection.json"])) throw new Error("rejected stage shape changed")
      await rename(stage, rejectedFinal)
      await trackRename(stage, rejectedFinal)
      finalInstalled = true
      const pendingMetadata = await lstat(pending.manifestPath)
      if (pendingMetadata.isSymbolicLink() || !pendingMetadata.isFile()) throw new Error("pending authority class changed")
      await rm(pending.manifestPath, { force: false })
      await trackIdentity(pending.manifestPath)
      try { await lstat(pending.manifestPath); throw new Error("pending authority remained") } catch (error) {
        if ((/** @type {{code?:string}} */ (error))?.code !== "ENOENT") throw error
      }
      if (!(await readFile(path.join(rejectedFinal, "manifest.json"))).equals(manifestBytes)
        || !(await readFile(path.join(rejectedFinal, "rejection.json"))).equals(rejectionBytes)) throw new Error("rejected final read-back failed")
      await revalidateTransaction()
    } catch (error) {
      if (!finalInstalled) await rm(stage, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  } catch {
    throw new PublicationReleaseHandoffError("REJECTED_CUSTODY_TRANSITION_FAILED", "verified permanent rejection could not be installed safely")
  } finally {
    await runtimeLease?.release().catch(() => {})
  }
}

/** @param {PendingContext} pending @param {ExportContext} exported @param {PinnedReleaseResult} release @param {string} releasesRoot */
async function verifyBrandedReleaseReadback(pending, exported, release, releasesRoot) {
  const runtime = await loadPublicationRuntime(pending.runtimeRoot)
  const custody = await loadSealedCustodyByManifestId(pending.runtimeRoot, pending.manifest.manifest_id)
  if (!runtime.currentPointer || runtime.currentPointer.release_digest !== custody.receipt.release_digest
    || custody.receipt.release_digest !== release.releaseDigest
    || runtime.currentPointer.receipt_path !== custody.receiptPath
    || custody.receiptPath !== `consumed/${pending.manifest.manifest_id}/release-receipt.json`
    || custody.manifest.manifest_id !== pending.manifest.manifest_id
    || custody.manifest.plan_digest !== pending.manifest.plan_digest
    || jcsCanonicalize(custody.manifest) !== jcsCanonicalize(pending.manifest)
    || jcsCanonicalize(custody.manifest) !== jcsCanonicalize(exported.manifest)) {
    throw new PublicationReleaseHandoffError("RELEASE_READBACK_INVALID", "sealed release pointer and custody read-back do not agree")
  }
  const capability = await loadVerifiedSealedRelease({ runtimeRoot: pending.runtimeRoot, releasesRoot: path.resolve(releasesRoot), manifestId: pending.manifest.manifest_id })
  const branded = await revalidateVerifiedSealedRelease(capability)
  const identity = verifiedSealedReleaseIdentity(capability)
  if (identity.releaseId !== pending.manifest.manifest_id
    || branded.release.releaseId !== identity.releaseId
    || branded.authority.sealedDescriptorId !== pending.manifest.manifest_id
    || branded.authority.receipt.receiptId !== custody.receipt.release_digest
    || branded.authority.inventory.length !== custody.receipt.artifacts.length
    || jcsCanonicalize(branded.authority.inventory.map((entry) => ({ path: entry.path, sha256: entry.sha256 })))
      !== jcsCanonicalize(custody.receipt.artifacts.map((/** @type {{path:string,sha256:string}} */ entry) => ({ path: entry.path, sha256: entry.sha256 })))) {
    throw new PublicationReleaseHandoffError("RELEASE_READBACK_INVALID", "module-branded sealed release inventory did not match custody")
  }
  const expectedRoutes = ["/", ...pending.manifest.nodes.map((node) => node.node_class === "paper"
    ? `/papers/${node.public_id}/`
    : `/knowledge/${node.node_class}/${node.public_id}/`)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  const expectedFiles = branded.authority.inventory.length
  if (JSON.stringify(release.routes) !== JSON.stringify(expectedRoutes) || release.files !== expectedFiles) {
    throw new PublicationReleaseHandoffError("RELEASE_READBACK_INVALID", "pinned release summary did not match verified custody")
  }
  return { runtime, custody, identity, branded, routes: expectedRoutes, files: expectedFiles }
}

/**
 * Seal the exact already-verified pending/export pair through the existing
 * manifest-aware pinned Quartz release pipeline. Runtime/export/manifest paths,
 * receipt bytes, approval, clock, and test policy never cross this public seam.
 * @param {{pendingAuthority:unknown,formalBuildInput:unknown,trustedRoots:{releasesRoot:string,vaultRoot:string,workRoot:string}}} input
 * @returns {Promise<any>}
 */
export async function sealVerifiedPublication(input) {
  const selected = requireInput(input)
  /** @type {PendingContext|undefined} */
  let verifiedPending
  try {
    return await consumeVerifiedPendingReleaseContext(selected.pendingAuthority, async (/** @type {PendingContext} */ pending) => {
      verifiedPending = pending
      await assertPendingAuthorityExact(pending)
      return consumeVerifiedExportInput(selected.formalBuildInput, async (/** @type {ExportContext} */ exported) => {
        assertSameAuthority(pending, exported)
        const contextRoot = await mkdtemp(path.join(os.tmpdir(), "t11-release-context-"))
        try {
          const manifestPath = path.join(contextRoot, "manifest.json")
          await writeFile(manifestPath, `${jcsCanonicalize(pending.manifest)}\n`, { flag: "wx" })
          const receiptPath = path.join(exported.exportRoot, "export-receipt.json")
          const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(".000Z", "Z")
          const args = [
            "--manifest", manifestPath,
            "--export-receipt", receiptPath,
            "--runtime-root", pending.runtimeRoot,
            "--export-root", exported.exportRoot,
            "--vault-root", selected.trustedRoots.vaultRoot,
            "--work-root", selected.trustedRoots.workRoot,
            "--releases-root", selected.trustedRoots.releasesRoot,
            "--now", now,
          ]
          const release = await runPinnedRelease(args)
          const readback = await verifyBrandedReleaseReadback(pending, exported, release, selected.trustedRoots.releasesRoot)
          await assertNoLinkAncestors(path.join(pending.runtimeRoot, "pending"))
          const pendingRootMetadata = await lstat(path.join(pending.runtimeRoot, "pending"))
          if (pendingRootMetadata.isSymbolicLink() || !pendingRootMetadata.isDirectory() || (await readdir(path.join(pending.runtimeRoot, "pending"))).length !== 0) {
            throw new PublicationReleaseHandoffError("PENDING_CUSTODY_REMAINS", "pending custody was not fully consumed")
          }
          return {
            state: "sealed",
            outcome: release.outcome ?? "promoted",
            manifestId: pending.manifest.manifest_id,
            planDigest: pending.manifest.plan_digest,
            publicSetDigest: pending.manifest.public_set_digest,
            releaseDigest: readback.custody.receipt.release_digest,
            receiptVerified: true,
            custody: "consumed",
            routes: readback.routes,
            files: readback.files,
          }
        } finally {
          await rm(contextRoot, { recursive: true, force: true }).catch(() => {})
        }
      })
    })
  } catch (error) {
    if (verifiedPending && error instanceof PublicationReleaseHandoffError && error.code === "PENDING_AUTHORITY_TAMPERED") {
      await transitionPendingToRejected(verifiedPending, "PENDING_AUTHORITY_TAMPERED")
      return {
        state: "rejected",
        manifestId: verifiedPending.manifest.manifest_id,
        planDigest: verifiedPending.manifest.plan_digest,
        reasonCode: "PENDING_AUTHORITY_TAMPERED",
        custody: "rejected",
      }
    }
    throw error
  }
}
