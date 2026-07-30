// @ts-check
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { isProxy } from "node:util/types"

import {
  loadVerifiedSealedReleaseForIdentity,
  revalidateVerifiedSealedRelease,
} from "./verified-sealed-release.mjs"

/** @typedef {{releaseId:string,releaseDigest:string,generation:number}} Release */
/** @typedef {{path:string,sha256:string,byteLength:number}} InventoryEntry */
/** @typedef {{approvedManifestDigest:string,sealedDescriptorId:string,receipt:{receiptId:string,receiptDigest:string},artifact:{artifactDigest:string,byteLength:number},inventory:InventoryEntry[]}} SealedReleaseAuthority */
/** @typedef {{operationId:string,claimId:string,idempotencyKey:string,status:"pending"|"succeeded",release:Release,expectedActive:Release|null}} DeploymentOperation */
/** @typedef {{active:Release|null,inProgress:DeploymentOperation|null,retained:Release[]}} ProviderState */
/** @typedef {{requestTimeoutMs:number,reconcileDeadlineMs:number,pollIntervalMs:number}} OperationPolicy */

const machineContract = JSON.parse(readFileSync(new URL("../config/github-pages-deployment-contract-v1.json", import.meta.url), "utf8"))
const configuredPolicy = machineContract?.failure_policy
const canonicalPolicy = Object.freeze({
  requestTimeoutMs: configuredPolicy?.request_timeout_ms,
  reconcileDeadlineMs: configuredPolicy?.reconcile_deadline_ms,
  pollIntervalMs: configuredPolicy?.poll_interval_ms,
})

/** @param {any} policy @returns {boolean} */
function validPolicy(policy) {
  return isPlainRecord(policy)
    && hasExactKeys(policy, ["requestTimeoutMs", "reconcileDeadlineMs", "pollIntervalMs"])
    && Object.values(policy).every((value) => Number.isSafeInteger(value) && value > 0)
    && policy.pollIntervalMs <= policy.reconcileDeadlineMs
}
if (!validPolicy(canonicalPolicy)
  || configuredPolicy.operation_start_call_limit !== 1
  || configuredPolicy.caller_policy_overrides_allowed !== false) {
  throw new Error("invalid canonical Pages operation policy")
}

const hexDigest = /^[0-9a-f]{64}$/
const providerErrorKinds = new Set(["auth", "rate-limit", "server", "timeout", "transport", "conflict", "unknown"])

export class PagesContractError extends Error {
  /** @param {string} code @param {string} message @param {Record<string,unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message)
    this.name = "PagesContractError"
    this.code = code
    this.details = details
  }
}

/** Strict transport protocol. Ambiguity is lifecycle-owned after start. */
export class PagesProviderError extends Error {
  /** @param {string} kind @param {any} [options] */
  constructor(kind, options = {}) {
    if (!providerErrorKinds.has(kind) || !isPlainRecord(options) || !hasExactKeys(options, Object.keys(options))) {
      throw new TypeError("invalid Pages provider error")
    }
    const optionKeys = Object.keys(options)
    if (optionKeys.some((key) => key !== "status" && key !== "retryAfterMs")) {
      throw new TypeError("provider errors cannot declare ambiguity or unknown options")
    }
    const { status, retryAfterMs } = options
    if (status !== undefined && (!Number.isSafeInteger(status) || status < 100 || status > 599)) throw new TypeError("invalid Pages provider HTTP status")
    if (retryAfterMs !== undefined && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)) throw new TypeError("invalid Pages provider retry-after")
    if (retryAfterMs !== undefined && kind !== "rate-limit") throw new TypeError("only rate-limit errors may carry retry-after")
    if (kind === "auth" && status !== 401 && status !== 403) throw new TypeError("auth errors require HTTP 401 or 403")
    if (kind === "rate-limit" && status !== 403 && status !== 429) throw new TypeError("rate-limit errors require HTTP 403 or 429")
    if (kind === "server" && (status === undefined || status < 500)) throw new TypeError("server errors require a 5xx status")
    if (kind === "conflict" && status !== undefined && status !== 409 && status !== 412) throw new TypeError("conflict errors require HTTP 409 or 412")
    if ((kind === "timeout" || kind === "transport" || kind === "unknown") && status !== undefined) throw new TypeError(`${kind} errors cannot carry HTTP status`)
    super(`Pages provider failure: ${kind}`)
    this.name = "PagesProviderError"
    this.kind = kind
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/** @param {any} value @returns {value is Record<string,any>} */
function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || isProxy(value) || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** @param {any} value @param {string[]} keys @returns {boolean} */
function hasExactKeys(value, keys) {
  if (!isPlainRecord(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/** Reject accessors, symbols, hidden properties, exotic prototypes, and cycles before cloning. */
/** @param {any} value @param {WeakSet<object>} [seen] */
function assertPlainDataGraph(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number" && Number.isSafeInteger(value)) return
  if (typeof value !== "object" || isProxy(value) || seen.has(value)) throw new TypeError("not a finite plain data graph")
  seen.add(value)
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError("symbol properties are forbidden")
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("exotic arrays are forbidden")
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === "length") continue
      if (!("value" in descriptor) || !descriptor.enumerable) throw new TypeError("array accessors and hidden properties are forbidden")
      assertPlainDataGraph(descriptor.value, seen)
    }
    seen.delete(value)
    return
  }
  if (!isPlainRecord(value)) throw new TypeError("only plain objects are accepted")
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable) throw new TypeError("accessors and hidden properties are forbidden")
    assertPlainDataGraph(descriptor.value, seen)
  }
  seen.delete(value)
}

/** @param {any} value @returns {any} */
function clonePlainData(value) {
  assertPlainDataGraph(value)
  const clone = structuredClone(value)
  assertPlainDataGraph(clone)
  return clone
}

/** @param {any} value @returns {string} */
function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (!isPlainRecord(value)) throw new TypeError("canonical JSON accepts only plain data")
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
}

/** @param {string} value @returns {string} */
function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

/** @param {any} release @returns {release is Release} */
function validRelease(release) {
  return hasExactKeys(release, ["releaseId", "releaseDigest", "generation"])
    && typeof release.releaseId === "string" && release.releaseId.length > 0 && release.releaseId.length <= 200
    && typeof release.releaseDigest === "string" && hexDigest.test(release.releaseDigest)
    && Number.isSafeInteger(release.generation) && release.generation > 0
}

/** @param {Release|null|undefined} left @param {Release|null|undefined} right @returns {boolean} */
function sameRelease(left, right) {
  return Boolean(left && right && left.releaseId === right.releaseId && left.releaseDigest === right.releaseDigest && left.generation === right.generation)
}

/** @param {Release|null|undefined} left @param {Release|null|undefined} right @returns {boolean} */
function sameNullableRelease(left, right) {
  return (left === null && right === null) || sameRelease(left, right)
}

/** @param {any} value @returns {boolean} */
function validInventoryPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1000
    && value.normalize("NFC") === value
    && !value.startsWith("/") && !value.endsWith("/") && !value.includes("\\")
    && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}

/** @param {any} authority @returns {authority is SealedReleaseAuthority} */
function validAuthority(authority) {
  if (!hasExactKeys(authority, ["approvedManifestDigest", "sealedDescriptorId", "receipt", "artifact", "inventory"])) return false
  if (typeof authority.approvedManifestDigest !== "string" || !hexDigest.test(authority.approvedManifestDigest)) return false
  if (typeof authority.sealedDescriptorId !== "string" || authority.sealedDescriptorId.length === 0 || authority.sealedDescriptorId.length > 200) return false
  if (!hasExactKeys(authority.receipt, ["receiptId", "receiptDigest"])
    || typeof authority.receipt.receiptId !== "string" || authority.receipt.receiptId.length === 0 || authority.receipt.receiptId.length > 200
    || typeof authority.receipt.receiptDigest !== "string" || !hexDigest.test(authority.receipt.receiptDigest)) return false
  if (!hasExactKeys(authority.artifact, ["artifactDigest", "byteLength"])
    || typeof authority.artifact.artifactDigest !== "string" || !hexDigest.test(authority.artifact.artifactDigest)
    || !Number.isSafeInteger(authority.artifact.byteLength) || authority.artifact.byteLength <= 0) return false
  if (!Array.isArray(authority.inventory) || authority.inventory.length === 0) return false
  let prior
  for (const entry of authority.inventory) {
    if (!hasExactKeys(entry, ["path", "sha256", "byteLength"])
      || !validInventoryPath(entry.path)
      || typeof entry.sha256 !== "string" || !hexDigest.test(entry.sha256)
      || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) return false
    if (prior !== undefined && Buffer.compare(Buffer.from(prior, "utf8"), Buffer.from(entry.path, "utf8")) >= 0) return false
    prior = entry.path
  }
  return true
}

/** @param {Release} release @param {SealedReleaseAuthority} authority @returns {any} */
function descriptorFor(release, authority) {
  return {
    schemaVersion: 1,
    releaseId: release.releaseId,
    generation: release.generation,
    approvedManifestDigest: authority.approvedManifestDigest,
    sealedDescriptorId: authority.sealedDescriptorId,
    receiptId: authority.receipt.receiptId,
    receiptDigest: authority.receipt.receiptDigest,
    artifactDigest: authority.artifact.artifactDigest,
    artifactByteLength: authority.artifact.byteLength,
    inventory: authority.inventory,
  }
}

/** @param {any} releaseValue @param {any} authorityValue @returns {{release:Release,authority:SealedReleaseAuthority}} */
function verifyReleaseAuthority(releaseValue, authorityValue) {
  let release
  let authority
  try {
    release = clonePlainData(releaseValue)
    authority = clonePlainData(authorityValue)
  } catch {
    throw new PagesContractError("DEPLOYMENT_AUTHORITY_INVALID", "deployment requires plain immutable sealed authority data")
  }
  if (!validRelease(release)) throw new PagesContractError("DEPLOYMENT_RELEASE_INVALID", "release identity is invalid")
  if (!validAuthority(authority)) throw new PagesContractError("DEPLOYMENT_AUTHORITY_INVALID", "complete sorted sealed authority is mandatory")
  const expectedDigest = sha256(canonicalJson(descriptorFor(release, authority)))
  if (release.releaseDigest !== expectedDigest) {
    throw new PagesContractError("DEPLOYMENT_RELEASE_DIGEST_MISMATCH", "candidate does not match its canonical lifecycle descriptor")
  }
  return { release, authority }
}

/** @param {any} operation @param {Set<string>} [allowedStatuses] @returns {operation is DeploymentOperation} */
function validOperation(operation, allowedStatuses = new Set(["pending", "succeeded"])) {
  return hasExactKeys(operation, ["operationId", "claimId", "idempotencyKey", "status", "release", "expectedActive"])
    && typeof operation.operationId === "string" && /^pages-operation-[0-9a-f]{64}$/.test(operation.operationId)
    && typeof operation.claimId === "string" && /^pages-claim-[0-9a-f]{64}$/.test(operation.claimId)
    && typeof operation.idempotencyKey === "string" && /^pages-idempotency-[0-9a-f]{64}$/.test(operation.idempotencyKey)
    && allowedStatuses.has(operation.status)
    && validRelease(operation.release)
    && (operation.expectedActive === null || validRelease(operation.expectedActive))
}

/** @param {ProviderState} state @returns {Release[]} */
function collectStateIdentities(state) {
  return [
    ...(state.active ? [state.active] : []),
    ...state.retained,
    ...(state.inProgress ? [state.inProgress.release] : []),
    ...(state.inProgress?.expectedActive ? [state.inProgress.expectedActive] : []),
  ]
}

/** @param {Release[]} releases @returns {boolean} */
function identitiesConsistent(releases) {
  const byId = new Map()
  const byDigest = new Map()
  for (const release of releases) {
    const priorId = byId.get(release.releaseId)
    const priorDigest = byDigest.get(release.releaseDigest)
    if ((priorId && !sameRelease(priorId, release)) || (priorDigest && !sameRelease(priorDigest, release))) return false
    byId.set(release.releaseId, release)
    byDigest.set(release.releaseDigest, release)
  }
  return true
}

/** @param {any} state @returns {state is ProviderState} */
function validProviderState(state) {
  return hasExactKeys(state, ["active", "inProgress", "retained"])
    && (state.active === null || validRelease(state.active))
    && (state.inProgress === null || validOperation(state.inProgress, new Set(["pending"])))
    && Array.isArray(state.retained) && state.retained.every(validRelease)
    && identitiesConsistent(collectStateIdentities(state))
}

/** @param {any} provider */
function validateProvider(provider) {
  if (!provider || typeof provider !== "object"
    || typeof provider.claim !== "function"
    || typeof provider.readback !== "function"
    || typeof provider.readOperation !== "function"
    || typeof provider.start !== "function") {
    throw new PagesContractError("DEPLOYMENT_PROVIDER_INVALID", "provider must expose atomic durable claim, readback, readOperation, and start")
  }
}

/** @template T @param {number} timeoutMs @param {(signal:AbortSignal)=>Promise<T>|T} operation @returns {Promise<T>} */
async function withDeadline(timeoutMs, operation) {
  const controller = new AbortController()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new PagesProviderError("timeout"))
    }, timeoutMs)
  })
  try {
    const result = operation(controller.signal)
    if (result !== null && typeof result === "object" && isProxy(result)) {
      throw new TypeError("provider returned a Proxy")
    }
    return await Promise.race([Promise.resolve(result), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** @param {any} provider @param {OperationPolicy} policy @param {string} [code] @param {number} [timeoutMs] @returns {Promise<ProviderState>} */
async function safeReadbackInternal(provider, policy, code = "DEPLOYMENT_READBACK_FAILED", timeoutMs = policy.requestTimeoutMs) {
  try {
    const raw = await withDeadline(timeoutMs, (signal) => provider.readback({ timeoutMs, signal }))
    const state = clonePlainData(raw)
    if (!validProviderState(state)) throw new TypeError("invalid provider state")
    return state
  } catch {
    throw new PagesContractError(code, "provider state is unavailable or invalid")
  }
}

/** @param {any} provider @returns {Promise<any>} */
export async function safeReadback(provider) {
  if (arguments.length !== 1) throw new PagesContractError("DEPLOYMENT_INTERFACE_INVALID", "safeReadback policy is machine-owned")
  validateProvider(provider)
  return safeReadbackInternal(provider, canonicalPolicy)
}

/** @param {any} provider @param {string} operationId @param {OperationPolicy} policy @param {number} [timeoutMs] @returns {Promise<DeploymentOperation|null>} */
async function readOperationInternal(provider, operationId, policy, timeoutMs = policy.requestTimeoutMs) {
  const raw = await withDeadline(timeoutMs, (signal) => provider.readOperation(operationId, { timeoutMs, signal }))
  const operation = clonePlainData(raw)
  if (operation !== null && !validOperation(operation)) throw new TypeError("invalid provider operation")
  return operation
}

/** @param {any} provider @param {DeploymentOperation} operation @param {number} timeoutMs @returns {Promise<"acquired"|"exists">} */
async function claimOperationInternal(provider, operation, timeoutMs) {
  const raw = await withDeadline(timeoutMs, (signal) => provider.claim(structuredClone(operation), { timeoutMs, signal }))
  const result = clonePlainData(raw)
  if (!hasExactKeys(result, ["disposition"])
    || (result.disposition !== "acquired" && result.disposition !== "exists")) {
    throw new TypeError("invalid provider claim disposition")
  }
  return result.disposition
}

/** @param {Release} release @param {Release|null} expectedActive @returns {DeploymentOperation} */
function deriveOperation(release, expectedActive) {
  const digest = sha256(canonicalJson({
    schemaVersion: 1,
    kind: "github-pages-deployment",
    release,
    expectedActive,
  }))
  return {
    operationId: `pages-operation-${digest}`,
    claimId: `pages-claim-${digest}`,
    idempotencyKey: `pages-idempotency-${digest}`,
    status: "pending",
    release: structuredClone(release),
    expectedActive: expectedActive ? structuredClone(expectedActive) : null,
  }
}

/** @param {DeploymentOperation} observed @param {DeploymentOperation} expected @returns {boolean} */
function operationBindingMatches(observed, expected) {
  return observed.operationId === expected.operationId
    && observed.claimId === expected.claimId
    && observed.idempotencyKey === expected.idempotencyKey
    && sameRelease(observed.release, expected.release)
    && sameNullableRelease(observed.expectedActive, expected.expectedActive)
}

/** @param {ProviderState} state @param {Release} release @param {boolean} [allowExactCandidate] */
function validateCandidateAgainstState(state, release, allowExactCandidate = false) {
  for (const historical of collectStateIdentities(state)) {
    if (historical.releaseId === release.releaseId && !sameRelease(historical, release)) {
      throw new PagesContractError("DEPLOYMENT_IDEMPOTENCY_CONFLICT", "release ID is bound to another identity")
    }
    if (historical.releaseDigest === release.releaseDigest && !sameRelease(historical, release)) {
      throw new PagesContractError("DEPLOYMENT_IDENTITY_CONFLICT", "release digest is bound to another identity")
    }
  }
  const generationHistory = collectStateIdentities(state)
    .filter((historical) => !allowExactCandidate || !sameRelease(historical, release))
  const newestGeneration = generationHistory.reduce((maximum, item) => Math.max(maximum, item.generation), 0)
  if (release.generation <= newestGeneration) throw new PagesContractError("DEPLOYMENT_STALE", "candidate generation is not newer than provider history")
}

/** @param {number} ms @returns {Promise<void>} */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** @param {any} provider @param {DeploymentOperation} expected @param {OperationPolicy} policy @param {number} deadline @returns {Promise<any>} */
async function reconcileOperation(provider, expected, policy, deadline) {
  while (true) {
    let observedOperation
    let state
    let remaining = deadline - Date.now()
    if (remaining <= 0) break
    try {
      observedOperation = await readOperationInternal(
        provider,
        expected.operationId,
        policy,
        Math.min(policy.requestTimeoutMs, remaining),
      )
      remaining = deadline - Date.now()
      if (remaining > 0) {
        state = await safeReadbackInternal(
          provider,
          policy,
          "DEPLOYMENT_STATE_UNKNOWN",
          Math.min(policy.requestTimeoutMs, remaining),
        )
      }
    } catch {
      // Every post-start read error remains outcome-uncertain. Poll only.
    }
    if (observedOperation && state
      && operationBindingMatches(observedOperation, expected)
      && observedOperation.status === "succeeded"
      && sameRelease(state.active, expected.release)
      && state.inProgress === null) {
      return {
        outcome: "deployed",
        operationId: expected.operationId,
        release: structuredClone(expected.release),
      }
    }
    remaining = deadline - Date.now()
    if (remaining <= 0) break
    await delay(Math.min(policy.pollIntervalMs, remaining))
  }
  return {
    outcome: "pending",
    state: "unknown",
    operationId: expected.operationId,
    release: structuredClone(expected.release),
  }
}

/** @param {any} value @param {string[]} keys @param {string} code */
function exactInput(value, keys, code) {
  if (value !== null && typeof value === "object" && isProxy(value)) {
    throw new PagesContractError(code, "operation input must be a plain object")
  }
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new PagesContractError(code, "operation input must be a plain object")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor) || !descriptor.enumerable)) {
    throw new PagesContractError(code, "operation input must contain only own enumerable data properties")
  }
  if (!hasExactKeys(value, keys)) throw new PagesContractError(code, "operation input shape is not canonical")
}

/** @param {unknown} capability @param {"candidate"|"lkg"} role */
async function verifiedEvidence(capability, role) {
  try {
    return await revalidateVerifiedSealedRelease(capability)
  } catch {
    throw new PagesContractError(
      role === "candidate" ? "DEPLOYMENT_CANDIDATE_BYTES_INVALID" : "DEPLOYMENT_LKG_BYTES_INVALID",
      role === "candidate"
        ? "candidate sealed custody or artifact bytes are unavailable or changed"
        : "last-known-good sealed custody or artifact bytes are unavailable or changed",
    )
  }
}

/** @param {Release|null} active @param {{release:Release,runtimeRoot:string,releasesRoot:string,capability:any}} candidateEvidence @param {Release} authorizedRelease */
async function verifyLastKnownGood(active, candidateEvidence, authorizedRelease) {
  if (active === null) return undefined
  if (sameRelease(active, candidateEvidence.release) || sameRelease(active, authorizedRelease)) {
    return { ...await verifiedEvidence(candidateEvidence.capability, "lkg"), capability: candidateEvidence.capability }
  }
  let capability
  try {
    capability = await loadVerifiedSealedReleaseForIdentity({
      runtimeRoot: candidateEvidence.runtimeRoot,
      releasesRoot: candidateEvidence.releasesRoot,
      release: active,
    })
  } catch {
    throw new PagesContractError("DEPLOYMENT_LKG_BYTES_INVALID", "last-known-good sealed custody or artifact bytes are unavailable or changed")
  }
  const evidence = await verifiedEvidence(capability, "lkg")
  if (!sameRelease(active, evidence.release)) {
    throw new PagesContractError("DEPLOYMENT_LKG_IDENTITY_MISMATCH", "provider active identity does not match verified local last-known-good bytes")
  }
  return { ...evidence, capability }
}

/** @param {{provider:any,candidate:any,releaseOverride?:Release,requiredExpectedActive?:Release}} input @param {OperationPolicy} policy @returns {Promise<any>} */
async function runDeploymentInternal({ provider, candidate, releaseOverride, requiredExpectedActive }, policy) {
  let initialEvidence
  try {
    initialEvidence = await revalidateVerifiedSealedRelease(candidate)
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "VERIFIED_SEALED_RELEASE_CAPABILITY_REQUIRED") {
      throw new PagesContractError("DEPLOYMENT_AUTHORITY_INVALID", "deployment requires an opaque filesystem-verified sealed release capability")
    }
    throw new PagesContractError("DEPLOYMENT_CANDIDATE_BYTES_INVALID", "candidate sealed custody or artifact bytes are unavailable or changed")
  }
  const candidateEvidence = { ...initialEvidence, capability: candidate }
  const releaseValue = releaseOverride ?? initialEvidence.release
  const { release, authority } = verifyReleaseAuthority(releaseValue, initialEvidence.authority)
  validateProvider(provider)
  const before = await safeReadbackInternal(provider, policy)

  const lkgEvidence = await verifyLastKnownGood(before.active, candidateEvidence, release)

  if (sameRelease(before.active, release) && before.inProgress === null) {
    validateCandidateAgainstState(before, release, true)
    return { outcome: "idempotent-replay", release: structuredClone(release) }
  }

  if (before.inProgress !== null) {
    if (requiredExpectedActive !== undefined
      && (!validRelease(requiredExpectedActive) || !sameRelease(before.inProgress.expectedActive, requiredExpectedActive))) {
      throw new PagesContractError("DEPLOYMENT_EXPECTED_ACTIVE_MISMATCH", "pending operation expected-active identity does not match approval")
    }
    validateCandidateAgainstState(before, release, true)
    const pending = deriveOperation(release, before.inProgress.expectedActive)
    if (!operationBindingMatches(before.inProgress, pending)) {
      throw new PagesContractError("DEPLOYMENT_CONCURRENT", "another provider operation retains the deployment claim")
    }
    return reconcileOperation(provider, pending, policy, Date.now() + policy.reconcileDeadlineMs)
  }

  validateCandidateAgainstState(before, release)
  if (requiredExpectedActive !== undefined && (!validRelease(requiredExpectedActive) || !sameRelease(before.active, requiredExpectedActive))) {
    throw new PagesContractError("DEPLOYMENT_EXPECTED_ACTIVE_MISMATCH", "current active identity does not match approval")
  }
  const operation = deriveOperation(release, before.active)
  const deadline = Date.now() + policy.reconcileDeadlineMs
  let remaining = deadline - Date.now()
  if (remaining <= 0) return reconcileOperation(provider, operation, policy, deadline)

  let disposition
  try {
    disposition = await claimOperationInternal(provider, operation, Math.min(policy.requestTimeoutMs, remaining))
  } catch {
    // An unknown, timed-out, or failed claim may have persisted. Never start.
    return reconcileOperation(provider, operation, policy, deadline)
  }
  if (disposition !== "acquired") return reconcileOperation(provider, operation, policy, deadline)

  // Atomic claim has already made this exact pending operation provider-visible.
  // Revalidate the claimed expected-active state, then re-read both local byte
  // authorities immediately before the sole mutation call.
  remaining = deadline - Date.now()
  if (remaining <= 0) return reconcileOperation(provider, operation, policy, deadline)
  let finalState
  try {
    finalState = await safeReadbackInternal(
      provider,
      policy,
      "DEPLOYMENT_STATE_UNKNOWN",
      Math.min(policy.requestTimeoutMs, remaining),
    )
  } catch {
    return reconcileOperation(provider, operation, policy, deadline)
  }
  const expectedClaimedState = { ...structuredClone(before), inProgress: structuredClone(operation) }
  if (canonicalJson(finalState) !== canonicalJson(expectedClaimedState)) {
    throw new PagesContractError("DEPLOYMENT_CONCURRENT", "provider state changed outside the exact durable claim")
  }
  const finalCandidate = await verifiedEvidence(candidate, "candidate")
  if (!sameRelease(finalCandidate.release, initialEvidence.release)
    || canonicalJson(finalCandidate.authority) !== canonicalJson(authority)) {
    throw new PagesContractError("DEPLOYMENT_CANDIDATE_BYTES_INVALID", "candidate sealed custody or artifact bytes changed before mutation")
  }
  if (lkgEvidence) {
    const finalLkg = await verifiedEvidence(lkgEvidence.capability, "lkg")
    if (!sameRelease(finalLkg.release, lkgEvidence.release)) {
      throw new PagesContractError("DEPLOYMENT_LKG_BYTES_INVALID", "last-known-good sealed bytes changed before mutation")
    }
  }

  remaining = deadline - Date.now()
  if (remaining <= 0) return reconcileOperation(provider, operation, policy, deadline)
  const startTimeoutMs = Math.min(policy.requestTimeoutMs, remaining)
  try {
    await withDeadline(startTimeoutMs, (signal) => provider.start(structuredClone(operation), {
      timeoutMs: startTimeoutMs,
      signal,
      authority: structuredClone(finalCandidate.authority),
    }))
  } catch {
    // No start error can prove non-mutation. Reconcile this operation only.
  }
  return reconcileOperation(provider, operation, policy, deadline)
}

/** @param {any} value @returns {OperationPolicy} */
function policyForTest(value) {
  let policy
  try { policy = clonePlainData(value) } catch { throw new PagesContractError("TEST_POLICY_INVALID", "invalid test-only policy") }
  if (!validPolicy(policy) || policy.requestTimeoutMs > 1000 || policy.reconcileDeadlineMs > 2000) {
    throw new PagesContractError("TEST_POLICY_INVALID", "test-only policy must be small and bounded")
  }
  return Object.freeze(policy)
}

/** @param {any} input @returns {Promise<any>} */
export async function runBoundedPagesDeployment(input) {
  if (arguments.length !== 1) throw new PagesContractError("DEPLOYMENT_INTERFACE_INVALID", "deployment policy is machine-owned")
  exactInput(input, ["provider", "candidate"], "DEPLOYMENT_INTERFACE_INVALID")
  return runDeploymentInternal(input, canonicalPolicy)
}

/** Explicit deep-module seam for accelerated local tests; never exported by the production façade. */
/** @param {any} input @param {any} policyValue @returns {Promise<any>} */
export async function runBoundedPagesDeploymentForTest(input, policyValue) {
  if (arguments.length !== 2) throw new PagesContractError("TEST_POLICY_INVALID", "test-only deployment requires one explicit policy")
  exactInput(input, ["provider", "candidate"], "DEPLOYMENT_INTERFACE_INVALID")
  return runDeploymentInternal(input, policyForTest(policyValue))
}

/** @param {any} approval @returns {boolean} */
function validApproval(approval) {
  return hasExactKeys(approval, ["approvalId", "approverId", "approvedAt", "candidateRelease", "expectedActive", "sourceRelease"])
    && typeof approval.approvalId === "string" && approval.approvalId.length > 0
    && typeof approval.approverId === "string" && approval.approverId.length > 0
    && typeof approval.approvedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(approval.approvedAt)
    && new Date(approval.approvedAt).toISOString().replace(".000Z", "Z") === approval.approvedAt
    && validRelease(approval.candidateRelease)
    && validRelease(approval.expectedActive)
    && validRelease(approval.sourceRelease)
}

/** @param {any} input @param {OperationPolicy} policy @returns {Promise<any>} */
async function rollbackPagesDeploymentInternal(input, policy) {
  exactInput(input, ["provider", "approval", "candidate"], "ROLLBACK_INTERFACE_INVALID")
  let approval
  try {
    approval = clonePlainData(input.approval)
  } catch {
    throw new PagesContractError("ROLLBACK_APPROVAL_INVALID", "rollback approval must be plain sealed data")
  }
  if (!validApproval(approval)) {
    throw new PagesContractError("ROLLBACK_APPROVAL_INVALID", "rollback requires complete field-bound approval")
  }
  let custody
  try {
    custody = await revalidateVerifiedSealedRelease(input.candidate)
  } catch {
    throw new PagesContractError("ROLLBACK_LOCAL_CUSTODY_FAILED", "rollback authority could not be loaded from sealed custody")
  }
  if (!sameRelease(custody.release, approval.sourceRelease)) {
    throw new PagesContractError("ROLLBACK_AUTHORITY_MISMATCH", "opaque custody capability does not bind the approved source release")
  }
  // The approval may define a new monotonic lifecycle identity for old bytes,
  // but it cannot supply or alter authority: that comes only from the capability.
  verifyReleaseAuthority(approval.candidateRelease, custody.authority)
  let deployment
  try {
    deployment = await runDeploymentInternal({
      provider: input.provider,
      candidate: input.candidate,
      releaseOverride: approval.candidateRelease,
      requiredExpectedActive: approval.expectedActive,
    }, policy)
  } catch (error) {
    if (error instanceof PagesContractError && error.code === "DEPLOYMENT_EXPECTED_ACTIVE_MISMATCH") {
      throw new PagesContractError("ROLLBACK_EXPECTED_ACTIVE_MISMATCH", "rollback approval is stale for the current active identity")
    }
    throw error
  }
  if (deployment.outcome === "pending") return { ...deployment, sourceRelease: structuredClone(approval.sourceRelease) }
  return {
    outcome: deployment.outcome === "idempotent-replay" ? "idempotent-replay" : "rolled-back",
    deploymentOutcome: deployment.outcome,
    operationId: deployment.operationId,
    active: structuredClone(approval.candidateRelease),
    sourceRelease: structuredClone(approval.sourceRelease),
  }
}

/** @param {any} input @returns {Promise<any>} */
export async function rollbackPagesDeployment(input) {
  if (arguments.length !== 1) throw new PagesContractError("ROLLBACK_INTERFACE_INVALID", "rollback policy is machine-owned")
  return rollbackPagesDeploymentInternal(input, canonicalPolicy)
}

/** Explicit deep-module seam for accelerated local rollback tests; never exported by the production façade. */
/** @param {any} input @param {any} policyValue @returns {Promise<any>} */
export async function rollbackPagesDeploymentForTest(input, policyValue) {
  if (arguments.length !== 2) throw new PagesContractError("TEST_POLICY_INVALID", "test-only rollback requires one explicit policy")
  return rollbackPagesDeploymentInternal(input, policyForTest(policyValue))
}
