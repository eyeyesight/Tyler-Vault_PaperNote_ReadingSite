// @ts-check
import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { types as utilTypes } from "node:util"

import {
  consumeVerifiedPendingReleaseContext,
  createPublicationApprovalPreview,
} from "./publication-handoff.mjs"
import { sealVerifiedPublication } from "./publication-release-handoff.mjs"
import { jcsCanonicalize, loadPublicationRuntime } from "./publication-contracts.mjs"
import {
  loadVerifiedSealedRelease,
  revalidateVerifiedSealedRelease,
  verifiedSealedReleaseIdentity,
} from "./verified-sealed-release.mjs"
import { assertNoLinkAncestors, pathsOverlap } from "./filesystem-safety.mjs"

export class T12DeploymentHandoffError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** @typedef {{releasesRoot:string,vaultRoot:string,workRoot:string}} TrustedRoots */
/** @typedef {{releasesRoot:string}} RecoveryRoots */
/** @typedef {{status:"ready-for-t12",manifestId:string,planDigest:string,publicSetDigest:string,releaseDigest:string,lifecycleDigest:string,approvedRoutes:readonly string[],sealedReleaseRef:string,receiptRef:string}} T12Summary */
/** @typedef {{handle:object,pendingAuthority?:object|Function,formalBuildInput?:object|Function,runtimeRoot:string,runtimeIdentityKey:string,roots:TrustedRoots|RecoveryRoots,rootIdentityKey:string,sealedRelease:object,summary:T12Summary}} HandoffState */

/** @type {WeakMap<object, WeakMap<object, Map<string, HandoffState|Promise<HandoffState>>>>} */
const handoffCache = new WeakMap()
/** @type {WeakMap<object, HandoffState>} */
const handoffStates = new WeakMap()

/** @param {unknown} value */
function isCapability(value) {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

/** @param {unknown} value @param {string[]} keys @param {string} code @param {string} message */
function exactPlainRecord(value, keys, code, message) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new T12DeploymentHandoffError(code, message)
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error("non-plain object")
    if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error("symbol property")
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const names = Object.getOwnPropertyNames(value).sort()
    if (JSON.stringify(names) !== JSON.stringify([...keys].sort())
      || Object.values(descriptors).some((descriptor) => !("value" in descriptor) || descriptor.enumerable !== true)) {
      throw new Error("inexact property set")
    }
    return /** @type {Record<string, unknown>} */ (value)
  } catch {
    throw new T12DeploymentHandoffError(code, message)
  }
}

/** @param {unknown} input */
function parseInput(input) {
  const top = exactPlainRecord(
    input,
    ["formalBuildInput", "pendingAuthority", "trustedRoots"],
    "T12_HANDOFF_INPUT_INVALID",
    "T12 handoff input must contain only verified capabilities and trusted roots",
  )
  const roots = exactPlainRecord(
    top.trustedRoots,
    ["releasesRoot", "vaultRoot", "workRoot"],
    "T12_HANDOFF_ROOTS_INVALID",
    "T12 handoff trusted roots are invalid",
  )
  const pendingAuthority = top.pendingAuthority
  const formalBuildInput = top.formalBuildInput
  if (!isCapability(pendingAuthority) || !isCapability(formalBuildInput)
    || utilTypes.isProxy(pendingAuthority) || utilTypes.isProxy(formalBuildInput)) {
    throw new T12DeploymentHandoffError("T12_HANDOFF_INPUT_INVALID", "T12 handoff capabilities must be opaque verified handles")
  }
  const rootsValue = /** @type {TrustedRoots} */ ({
    releasesRoot: roots.releasesRoot,
    vaultRoot: roots.vaultRoot,
    workRoot: roots.workRoot,
  })
  if (Object.values(rootsValue).some((root) => typeof root !== "string" || root.length === 0)) {
    throw new T12DeploymentHandoffError("T12_HANDOFF_ROOTS_INVALID", "T12 handoff trusted roots must be non-empty strings")
  }
  return { pendingAuthority, formalBuildInput, rootsValue }
}

/** @param {string} requestedRoot @param {boolean} requireCanonical */
async function verifyOrdinaryRoot(requestedRoot, requireCanonical) {
  const absolute = path.resolve(requestedRoot)
  try {
    await assertNoLinkAncestors(absolute, { errorFactory: () => new Error("trusted root contains a link") })
    const before = await lstat(absolute, { bigint: true })
    if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("trusted root is not an ordinary directory")
    const canonical = await realpath(absolute)
    const after = await lstat(absolute, { bigint: true })
    if (after.isSymbolicLink() || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("trusted root changed while inspected")
    }
    if (requireCanonical && canonical !== absolute) throw new Error("trusted root spelling is not canonical")
    await assertNoLinkAncestors(canonical, { errorFactory: () => new Error("canonical trusted root contains a link") })
    return { canonical, identity: `${after.dev}:${after.ino}` }
  } catch {
    throw new T12DeploymentHandoffError("T12_HANDOFF_ROOTS_INVALID", "T12 handoff trusted roots are not stable ordinary directories")
  }
}

/** @param {TrustedRoots} requested */
async function verifyTrustedRoots(requested) {
  /** @type {Partial<TrustedRoots>} */
  const roots = {}
  /** @type {Record<string,string>} */
  const identities = {}
  for (const name of /** @type {(keyof TrustedRoots)[]} */ (["releasesRoot", "vaultRoot", "workRoot"])) {
    const inspected = await verifyOrdinaryRoot(requested[name], false)
    roots[name] = inspected.canonical
    identities[name] = inspected.identity
  }
  const canonicalRoots = /** @type {TrustedRoots} */ (roots)
  if (pathsOverlap(canonicalRoots.releasesRoot, canonicalRoots.vaultRoot)
    || pathsOverlap(canonicalRoots.releasesRoot, canonicalRoots.workRoot)
    || pathsOverlap(canonicalRoots.vaultRoot, canonicalRoots.workRoot)) {
    throw new T12DeploymentHandoffError("T12_HANDOFF_ROOTS_INVALID", "T12 handoff trusted roots must be disjoint")
  }
  return { canonicalRoots, rootIdentityKey: jcsCanonicalize(identities) }
}

/** @param {string} runtimeRoot @param {string} releasesRoot */
async function verifyRecoveryRoots(runtimeRoot, releasesRoot) {
  const runtime = await verifyOrdinaryRoot(runtimeRoot, true)
  const releases = await verifyOrdinaryRoot(releasesRoot, true)
  if (pathsOverlap(runtime.canonical, releases.canonical)) {
    throw new T12DeploymentHandoffError("T12_HANDOFF_ROOTS_INVALID", "T12 recovery roots must be disjoint")
  }
  return {
    runtimeRoot: runtime.canonical,
    runtimeIdentityKey: runtime.identity,
    releasesRoot: releases.canonical,
    rootIdentityKey: jcsCanonicalize({ runtime: runtime.identity, releases: releases.identity }),
  }
}

/** @param {TrustedRoots|RecoveryRoots} roots */
function rootsKey(roots) {
  return jcsCanonicalize(roots)
}

/** @param {string|Buffer} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

/** @param {object} sealedRelease @param {string} runtimeRoot @param {TrustedRoots|RecoveryRoots} roots @param {string} manifestId */
async function assertCurrentSealedRelease(sealedRelease, runtimeRoot, roots, manifestId) {
  try {
    const sealed = await revalidateVerifiedSealedRelease(sealedRelease)
    const runtime = await loadPublicationRuntime(runtimeRoot)
    const receiptPath = `consumed/${manifestId}/release-receipt.json`
    if (!runtime.currentPointer || !runtime.currentReceipt || !runtime.currentManifest
      || runtime.currentPointer.release_digest !== sealed.authority.receipt.receiptId
      || runtime.currentPointer.receipt_path !== receiptPath
      || runtime.currentReceipt.release_digest !== sealed.authority.receipt.receiptId
      || runtime.currentManifest.manifest_id !== manifestId
      || runtime.currentManifest.plan_digest !== sealed.authority.approvedManifestDigest
      || sha256(Buffer.from(`${jcsCanonicalize(runtime.currentReceipt)}\n`, "utf8")) !== sealed.authority.receipt.receiptDigest
      || !/^[a-f0-9]{64}$/.test(sealed.authority.receipt.receiptId)) {
      throw new Error("current sealed custody mismatch")
    }
    if (path.resolve(sealed.releasesRoot) !== roots.releasesRoot || path.resolve(sealed.runtimeRoot) !== runtimeRoot) {
      throw new Error("sealed custody roots mismatch")
    }
    return sealed
  } catch (error) {
    if (error instanceof T12DeploymentHandoffError) throw error
    throw new T12DeploymentHandoffError("T12_HANDOFF_CUSTODY_INVALID", "sealed custody could not be revalidated")
  }
}

/** @param {any} manifest @param {any} releaseRoutes */
function approvedRoutesFor(manifest, releaseRoutes) {
  const preview = createPublicationApprovalPreview(manifest)
  const approvedRoutes = preview.routes.map((/** @type {{route:string}} */ entry) => entry.route)
  const expectedReleaseRoutes = ["/", ...approvedRoutes].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  if (!Array.isArray(releaseRoutes)
    || jcsCanonicalize(releaseRoutes) !== jcsCanonicalize(expectedReleaseRoutes)) {
    throw new T12DeploymentHandoffError("T12_HANDOFF_ROUTE_MISMATCH", "sealed release routes do not equal the approved preview")
  }
  return approvedRoutes
}

/** @param {any} identity @param {any} authority @param {any} manifest @param {any} releaseRoutes */
function makeSummary(identity, authority, manifest, releaseRoutes) {
  const approvedRoutes = approvedRoutesFor(manifest, releaseRoutes)
  const releaseDigest = authority.receipt.receiptId
  const lifecycleDigest = identity.releaseDigest
  return Object.freeze({
    status: "ready-for-t12",
    manifestId: manifest.manifest_id,
    planDigest: manifest.plan_digest,
    publicSetDigest: manifest.public_set_digest,
    releaseDigest,
    lifecycleDigest,
    approvedRoutes: Object.freeze([...approvedRoutes]),
    sealedReleaseRef: `t12-sealed-${sha256(releaseDigest).slice(0, 32)}`,
    receiptRef: `t12-receipt-${sha256(authority.receipt.receiptDigest).slice(0, 32)}`,
  })
}

/** @param {HandoffState} state */
async function revalidateState(state) {
  const currentRuntime = await verifyOrdinaryRoot(state.runtimeRoot, true)
  if (currentRuntime.canonical !== state.runtimeRoot || currentRuntime.identity !== state.runtimeIdentityKey) {
    throw new T12DeploymentHandoffError("T12_HANDOFF_ROOTS_INVALID", "T12 handoff runtime root identity changed")
  }
  if ("vaultRoot" in state.roots) {
    const currentRoots = await verifyTrustedRoots(state.roots)
    if (rootsKey(currentRoots.canonicalRoots) !== rootsKey(state.roots)
      || currentRoots.rootIdentityKey !== state.rootIdentityKey) {
      throw new T12DeploymentHandoffError("T12_HANDOFF_ROOTS_INVALID", "T12 handoff trusted root identity changed")
    }
  } else {
    const currentRoots = await verifyRecoveryRoots(state.runtimeRoot, state.roots.releasesRoot)
    if (rootsKey({ releasesRoot: currentRoots.releasesRoot }) !== rootsKey(state.roots)
      || currentRoots.rootIdentityKey !== state.rootIdentityKey) {
      throw new T12DeploymentHandoffError("T12_HANDOFF_ROOTS_INVALID", "T12 handoff trusted root identity changed")
    }
  }
  await assertCurrentSealedRelease(state.sealedRelease, state.runtimeRoot, state.roots, state.summary.manifestId)
}

/** @param {{pendingAuthority:object|Function,formalBuildInput:object|Function,canonicalRoots:TrustedRoots,rootIdentityKey:string}} selected */
async function mintT12Handoff(selected) {
  /** @type {{manifest:any,runtimeRoot:string,manifestPath:string}|undefined} */
  let pendingContext
  await consumeVerifiedPendingReleaseContext(selected.pendingAuthority, (value) => { pendingContext = value })
  if (!pendingContext) throw new T12DeploymentHandoffError("T12_HANDOFF_PENDING_INVALID", "pending authority context is unavailable")
  const manifest = pendingContext.manifest
  const sealedResult = await sealVerifiedPublication({
    pendingAuthority: selected.pendingAuthority,
    formalBuildInput: selected.formalBuildInput,
    trustedRoots: selected.canonicalRoots,
  })
  if (sealedResult?.state !== "sealed" || sealedResult.manifestId !== manifest.manifest_id
    || sealedResult.planDigest !== manifest.plan_digest || sealedResult.publicSetDigest !== manifest.public_set_digest) {
    throw new T12DeploymentHandoffError("T12_HANDOFF_SEAL_INVALID", "sealed release result did not bind the approved manifest")
  }
  const sealedRelease = await loadVerifiedSealedRelease({
    runtimeRoot: pendingContext.runtimeRoot,
    releasesRoot: selected.canonicalRoots.releasesRoot,
    manifestId: manifest.manifest_id,
  })
  const identity = verifiedSealedReleaseIdentity(sealedRelease)
  const sealed = await assertCurrentSealedRelease(sealedRelease, pendingContext.runtimeRoot, selected.canonicalRoots, manifest.manifest_id)
  if (sealed.authority.receipt.receiptId !== sealedResult.releaseDigest) {
    throw new T12DeploymentHandoffError("T12_HANDOFF_SEAL_INVALID", "sealed release identity did not match the pinned release result")
  }
  const runtime = await verifyOrdinaryRoot(pendingContext.runtimeRoot, true)
  if (runtime.canonical !== pendingContext.runtimeRoot) {
    throw new T12DeploymentHandoffError("T12_HANDOFF_ROOTS_INVALID", "pending runtime root is not canonical")
  }
  const summary = makeSummary(identity, sealed.authority, manifest, sealedResult.routes)
  const handle = Object.freeze(Object.create(null))
  const state = {
    handle,
    pendingAuthority: selected.pendingAuthority,
    formalBuildInput: selected.formalBuildInput,
    runtimeRoot: pendingContext.runtimeRoot,
    runtimeIdentityKey: runtime.identity,
    roots: selected.canonicalRoots,
    rootIdentityKey: selected.rootIdentityKey,
    sealedRelease,
    summary,
  }
  handoffStates.set(handle, state)
  return state
}

/**
 * Seal the verified pending/export pair once, then mint a module-private T12
 * capability over the resulting sealed custody. Exact replay only revalidates.
 * @param {{pendingAuthority:unknown,formalBuildInput:unknown,trustedRoots:unknown}} input
 */
export async function createT12DeploymentHandoff(input) {
  const parsed = parseInput(input)
  const verifiedRoots = await verifyTrustedRoots(parsed.rootsValue)
  const selected = {
    pendingAuthority: parsed.pendingAuthority,
    formalBuildInput: parsed.formalBuildInput,
    canonicalRoots: verifiedRoots.canonicalRoots,
    rootIdentityKey: verifiedRoots.rootIdentityKey,
  }
  let byFormal = handoffCache.get(/** @type {object} */ (selected.pendingAuthority))
  if (!byFormal) {
    byFormal = new WeakMap()
    handoffCache.set(/** @type {object} */ (selected.pendingAuthority), byFormal)
  }
  let byRoots = byFormal.get(/** @type {object} */ (selected.formalBuildInput))
  if (!byRoots) {
    byRoots = new Map()
    byFormal.set(/** @type {object} */ (selected.formalBuildInput), byRoots)
  }
  const key = rootsKey(selected.canonicalRoots)
  const cached = byRoots.get(key)
  if (cached) {
    const state = await cached
    await revalidateState(state)
    return state.handle
  }
  const inFlight = mintT12Handoff(selected)
  byRoots.set(key, inFlight)
  try {
    const state = await inFlight
    byRoots.set(key, state)
    return state.handle
  } catch (error) {
    if (byRoots.get(key) === inFlight) byRoots.delete(key)
    throw error
  }
}

/** @param {unknown} input */
function parseRecoveryInput(input) {
  const top = exactPlainRecord(
    input,
    ["manifestId", "releasesRoot", "runtimeRoot"],
    "T12_HANDOFF_RECOVERY_INPUT_INVALID",
    "T12 recovery input must contain only runtime root, releases root, and manifest identity",
  )
  if (typeof top.runtimeRoot !== "string" || top.runtimeRoot.length === 0
    || typeof top.releasesRoot !== "string" || top.releasesRoot.length === 0
    || typeof top.manifestId !== "string" || !/^VPUB-[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(top.manifestId)) {
    throw new T12DeploymentHandoffError("T12_HANDOFF_RECOVERY_INPUT_INVALID", "T12 recovery input fields are invalid")
  }
  return {
    runtimeRoot: top.runtimeRoot,
    releasesRoot: top.releasesRoot,
    manifestId: top.manifestId,
  }
}

/**
 * Recover a fresh-process T12 capability from only the trusted roots and the
 * manifest identity. Current pointer, sealed custody, and artifact bytes are
 * re-read before minting; no caller-supplied receipt, digest, route, or path
 * internals participate in recovery.
 * @param {{runtimeRoot:string,releasesRoot:string,manifestId:string}} input
 */
export async function loadT12DeploymentHandoff(input) {
  const parsed = parseRecoveryInput(input)
  const roots = await verifyRecoveryRoots(parsed.runtimeRoot, parsed.releasesRoot)
  const runtime = await loadPublicationRuntime(roots.runtimeRoot)
  if (!runtime.currentPointer || !runtime.currentReceipt || !runtime.currentManifest
    || runtime.currentManifest.manifest_id !== parsed.manifestId
    || runtime.currentPointer.receipt_path !== `consumed/${parsed.manifestId}/release-receipt.json`) {
    throw new T12DeploymentHandoffError("T12_HANDOFF_CUSTODY_INVALID", "current runtime custody does not bind the requested manifest")
  }
  const sealedRelease = await loadVerifiedSealedRelease({
    runtimeRoot: roots.runtimeRoot,
    releasesRoot: roots.releasesRoot,
    manifestId: parsed.manifestId,
  })
  const identity = verifiedSealedReleaseIdentity(sealedRelease)
  const sealed = await assertCurrentSealedRelease(
    sealedRelease,
    roots.runtimeRoot,
    { releasesRoot: roots.releasesRoot },
    parsed.manifestId,
  )
  const manifest = runtime.currentManifest
  const derivedReleaseRoutes = [
    "/",
    ...createPublicationApprovalPreview(manifest).routes.map((entry) => entry.route),
  ].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  const summary = makeSummary(identity, sealed.authority, manifest, derivedReleaseRoutes)
  const handle = Object.freeze(Object.create(null))
  const state = {
    handle,
    runtimeRoot: roots.runtimeRoot,
    runtimeIdentityKey: roots.runtimeIdentityKey,
    roots: Object.freeze({ releasesRoot: roots.releasesRoot }),
    rootIdentityKey: roots.rootIdentityKey,
    sealedRelease,
    summary,
  }
  handoffStates.set(handle, state)
  return handle
}

/** @param {unknown} handle */
function requireHandoff(handle) {
  if (!isCapability(handle)) throw new T12DeploymentHandoffError("T12_HANDOFF_UNVERIFIED", "T12 handoff handle is not verified")
  const state = handoffStates.get(/** @type {object} */ (handle))
  if (!state) throw new T12DeploymentHandoffError("T12_HANDOFF_UNVERIFIED", "T12 handoff handle is not verified")
  return state
}

/** @param {unknown} handle @returns {Promise<T12Summary>} */
export async function readT12DeploymentHandoff(handle) {
  const state = requireHandoff(handle)
  await revalidateState(state)
  return structuredClone(state.summary)
}

/** @param {unknown} handle @returns {Promise<object>} */
export async function t12DeploymentCandidate(handle) {
  const state = requireHandoff(handle)
  await revalidateState(state)
  return state.sealedRelease
}
