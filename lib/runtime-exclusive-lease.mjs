import { createHash, randomBytes } from "node:crypto"
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises"
import path from "node:path"

import { ContractError } from "./publication-contracts.mjs"
import { assertNoLinkAncestors, hasFsCode } from "./filesystem-safety.mjs"

/** @typedef {{exists:boolean,class:"directory"|"file"|"symlink"|"other"|undefined,dev:bigint|number|undefined,ino:bigint|number|undefined}} PathIdentity */
/** @typedef {{assertOwned:()=>Promise<void>,release:()=>Promise<void>}} RuntimeExclusiveLease */

/** @param {string} target */
async function ordinaryRuntimeIdentity(target) {
  const absolute = path.resolve(target)
  let metadata
  try {
    metadata = await lstat(absolute, { bigint: true })
  } catch (error) {
    if (hasFsCode(error, "ENOENT")) {
      return { exists: false, class: undefined, dev: undefined, ino: undefined }
    }
    throw new ContractError("RUNTIME_TRANSACTION_STATE_INVALID", "runtime transaction identity could not be read")
  }
  /** @type {PathIdentity["class"]} */
  const kind = metadata.isDirectory()
    ? "directory"
    : metadata.isFile() ? "file"
      : metadata.isSymbolicLink() ? "symlink" : "other"
  return { exists: true, class: kind, dev: metadata.dev, ino: metadata.ino }
}

/** @param {PathIdentity} expected @param {PathIdentity} actual @param {string} role */
function sameIdentity(expected, actual, role) {
  if (expected.exists !== actual.exists || expected.class !== actual.class
    || expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new ContractError("RUNTIME_TRANSACTION_STATE_CHANGED", `${role} identity changed during runtime transaction`)
  }
}

/** @param {string} target */
export async function captureRuntimePathIdentity(target) {
  return ordinaryRuntimeIdentity(target)
}

/** @param {string} target @param {PathIdentity} expected @param {string} role */
export async function assertRuntimePathIdentity(target, expected, role) {
  sameIdentity(expected, await ordinaryRuntimeIdentity(target), role)
}

/**
 * Cross-process cooperative lease for one runtime root. The lease is a sibling
 * file so the runtime contract itself remains readable by authority loaders.
 * A pre-existing lease is never treated as stale: crash recovery must block
 * until an operator removes the exact abandoned lease after investigation.
 * Node's path APIs cannot provide openat/no-follow semantics on every supported
 * platform, so this protects cooperating writers, not a privileged same-user
 * process that ignores the lease.
 * @param {string} runtimeRoot
 */
export async function acquireRuntimeExclusiveLease(runtimeRoot) {
  const absoluteRoot = path.resolve(runtimeRoot)
  await assertNoLinkAncestors(absoluteRoot, {
    errorFactory: () => new ContractError("RUNTIME_TRANSACTION_ROOT_INVALID", "runtime transaction root is not an ordinary canonical directory"),
  })
  const rootMetadata = await lstat(absoluteRoot, { bigint: true })
  const canonicalRoot = await realpath(absoluteRoot)
  if (canonicalRoot !== absoluteRoot || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new ContractError("RUNTIME_TRANSACTION_ROOT_INVALID", "runtime transaction root is not an ordinary canonical directory")
  }
  /** @type {PathIdentity} */
  const rootIdentity = { exists: true, class: "directory", dev: rootMetadata.dev, ino: rootMetadata.ino }
  const leaseName = `.tyler-runtime-${createHash("sha256").update(Buffer.from(absoluteRoot, "utf8")).digest("hex")}.lease`
  const leasePath = path.join(path.dirname(absoluteRoot), leaseName)
  const token = randomBytes(32).toString("hex")
  const bytes = Buffer.from(`${token}\n`, "utf8")
  let handle
  try {
    handle = await open(leasePath, "wx", 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    if (hasFsCode(error, "EEXIST")) throw new ContractError("RUNTIME_TRANSACTION_BUSY", "another cooperating runtime transition owns the exclusive lease")
    throw new ContractError("RUNTIME_TRANSACTION_LEASE_FAILED", "runtime exclusive lease could not be acquired")
  }

  let leaseIdentity
  try {
    const metadata = await lstat(leasePath, { bigint: true })
    if (metadata.isSymbolicLink() || !metadata.isFile() || !(await readFile(leasePath)).equals(bytes)) throw new Error("lease read-back mismatch")
    /** @type {PathIdentity} */
    const identity = { exists: true, class: "file", dev: metadata.dev, ino: metadata.ino }
    leaseIdentity = identity
    sameIdentity(rootIdentity, await ordinaryRuntimeIdentity(absoluteRoot), "runtime root")
  } catch {
    try {
      const current = await lstat(leasePath, { bigint: true })
      if (!current.isSymbolicLink() && current.isFile() && (await readFile(leasePath)).equals(bytes)) await unlink(leasePath)
    } catch {}
    throw new ContractError("RUNTIME_TRANSACTION_LEASE_FAILED", "runtime exclusive lease could not be verified")
  }

  let released = false
  /** @type {RuntimeExclusiveLease} */
  return {
    async assertOwned() {
      if (released) throw new ContractError("RUNTIME_TRANSACTION_LEASE_LOST", "runtime exclusive lease is no longer owned")
      sameIdentity(rootIdentity, await ordinaryRuntimeIdentity(absoluteRoot), "runtime root")
      sameIdentity(leaseIdentity, await ordinaryRuntimeIdentity(leasePath), "runtime exclusive lease")
      let actual
      try { actual = await readFile(leasePath) } catch { throw new ContractError("RUNTIME_TRANSACTION_LEASE_LOST", "runtime exclusive lease is no longer owned") }
      if (!actual.equals(bytes)) throw new ContractError("RUNTIME_TRANSACTION_LEASE_LOST", "runtime exclusive lease is no longer owned")
    },
    async release() {
      if (released) return
      try {
        const actualIdentity = await ordinaryRuntimeIdentity(leasePath)
        sameIdentity(leaseIdentity, actualIdentity, "runtime exclusive lease")
        const actualBytes = await readFile(leasePath)
        if (!actualBytes.equals(bytes)) throw new ContractError("RUNTIME_TRANSACTION_LEASE_LOST", "runtime exclusive lease is no longer owned")
        await unlink(leasePath)
      } catch (error) {
        if (error instanceof ContractError) throw error
        if (!hasFsCode(error, "ENOENT")) throw new ContractError("RUNTIME_TRANSACTION_LEASE_RELEASE_FAILED", "runtime exclusive lease could not be released safely")
      } finally {
        released = true
      }
    },
  }
}
