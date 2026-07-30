// @ts-check
import {
  PagesContractError,
  PagesProviderError,
} from "../../lib/pages-deployment-contract.mjs"

const operationIdPattern = /^pages-operation-[0-9a-f]{64}$/
const claimIdPattern = /^pages-claim-[0-9a-f]{64}$/
const idempotencyKeyPattern = /^pages-idempotency-[0-9a-f]{64}$/
const hexDigest = /^[0-9a-f]{64}$/

/** @param {any} release */
function validRelease(release) {
  return release !== null && typeof release === "object" && !Array.isArray(release)
    && Object.keys(release).sort().join(",") === "generation,releaseDigest,releaseId"
    && typeof release.releaseId === "string" && release.releaseId.length > 0
    && typeof release.releaseDigest === "string" && hexDigest.test(release.releaseDigest)
    && Number.isSafeInteger(release.generation) && release.generation > 0
}

/** @param {any} left @param {any} right */
function sameRelease(left, right) {
  return Boolean(left && right
    && left.releaseId === right.releaseId
    && left.releaseDigest === right.releaseDigest
    && left.generation === right.generation)
}

/** @param {any} left @param {any} right */
function sameNullableRelease(left, right) {
  return (left === null && right === null) || sameRelease(left, right)
}

/** @param {any} left @param {any} right */
function sameOperation(left, right) {
  return Boolean(left && right
    && left.operationId === right.operationId
    && left.claimId === right.claimId
    && left.idempotencyKey === right.idempotencyKey
    && sameRelease(left.release, right.release)
    && sameNullableRelease(left.expectedActive, right.expectedActive))
}

/** @param {any} operation @param {Set<string>} [statuses] */
function validOperation(operation, statuses = new Set(["pending", "succeeded"])) {
  return operation !== null && typeof operation === "object" && !Array.isArray(operation)
    && Object.keys(operation).sort().join(",") === "claimId,expectedActive,idempotencyKey,operationId,release,status"
    && typeof operation.operationId === "string" && operationIdPattern.test(operation.operationId)
    && typeof operation.claimId === "string" && claimIdPattern.test(operation.claimId)
    && typeof operation.idempotencyKey === "string" && idempotencyKeyPattern.test(operation.idempotencyKey)
    && statuses.has(operation.status)
    && validRelease(operation.release)
    && (operation.expectedActive === null || validRelease(operation.expectedActive))
}

/** @param {any} authority */
function validAuthority(authority) {
  return authority !== null && typeof authority === "object" && !Array.isArray(authority)
    && typeof authority.approvedManifestDigest === "string" && hexDigest.test(authority.approvedManifestDigest)
    && typeof authority.sealedDescriptorId === "string" && authority.sealedDescriptorId.length > 0
    && typeof authority.receipt?.receiptId === "string"
    && typeof authority.receipt?.receiptDigest === "string" && hexDigest.test(authority.receipt.receiptDigest)
    && typeof authority.artifact?.artifactDigest === "string" && hexDigest.test(authority.artifact.artifactDigest)
    && Number.isSafeInteger(authority.artifact?.byteLength) && authority.artifact.byteLength > 0
    && Array.isArray(authority.inventory) && authority.inventory.length > 0
}

/** @param {any} options @param {Set<string>} allowed */
function validateOptions(options, allowed) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
    || Object.getPrototypeOf(options) !== Object.prototype
    || Object.getOwnPropertySymbols(options).length !== 0) {
    throw new PagesContractError("SCRIPTED_PROVIDER_INVALID", "scripted provider options must be a plain object")
  }
  const descriptors = Object.getOwnPropertyDescriptors(options)
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor) || !descriptor.enumerable)
    || Object.keys(options).some((key) => !allowed.has(key))) {
    throw new PagesContractError("SCRIPTED_PROVIDER_INVALID", "invalid scripted provider option")
  }
}

/**
 * Deterministic test-only adapter. Provider methods are frozen so a test cannot
 * swap transport behavior while retaining any fixture identity.
 * @param {any} [options]
 */
export function createScriptedLocalPagesProvider(options = {}) {
  const allowed = new Set(["initial", "retained", "inProgress", "operations", "claimSteps", "startSteps", "afterReadback", "afterClaim", "afterReadOperation", "hideOperationReadback"])
  validateOptions(options, allowed)
  const {
    initial = null,
    retained = [],
    inProgress = null,
    operations = [],
    claimSteps = [],
    startSteps = [],
    afterReadback,
    afterClaim,
    afterReadOperation,
    hideOperationReadback = false,
  } = options
  if (afterReadback !== undefined && typeof afterReadback !== "function") {
    throw new PagesContractError("SCRIPTED_PROVIDER_INVALID", "afterReadback must be a function")
  }
  if (afterClaim !== undefined && typeof afterClaim !== "function") {
    throw new PagesContractError("SCRIPTED_PROVIDER_INVALID", "afterClaim must be a function")
  }
  if (afterReadOperation !== undefined && typeof afterReadOperation !== "function") {
    throw new PagesContractError("SCRIPTED_PROVIDER_INVALID", "afterReadOperation must be a function")
  }
  if (typeof hideOperationReadback !== "boolean") {
    throw new PagesContractError("SCRIPTED_PROVIDER_INVALID", "hideOperationReadback must be boolean")
  }
  if ((initial !== null && !validRelease(initial))
    || !Array.isArray(retained) || !retained.every(validRelease)
    || (inProgress !== null && !validOperation(inProgress, new Set(["pending"])))) {
    throw new PagesContractError("DEPLOYMENT_READBACK_FAILED", "invalid scripted provider state")
  }
  let active = initial === null ? null : structuredClone(initial)
  let activeOperation = inProgress === null ? null : structuredClone(inProgress)
  const releaseMap = new Map()
  if (active) releaseMap.set(active.releaseDigest, active)
  for (const release of structuredClone(retained)) releaseMap.set(release.releaseDigest, release)
  const operationMap = new Map()
  for (const operation of structuredClone(operations)) {
    if (!validOperation(operation) || operationMap.has(operation.operationId)) {
      throw new PagesContractError("SCRIPTED_PROVIDER_INVALID", "invalid scripted operation")
    }
    operationMap.set(operation.operationId, operation)
  }
  if (activeOperation) operationMap.set(activeOperation.operationId, activeOperation)
  const claimResponses = structuredClone(claimSteps)
  const steps = structuredClone(startSteps)
  const calls = { claim: 0, start: 0, readback: 0, operation: 0 }
  /** @type {string[]} */
  const claimDispositions = []
  const dispatchedOperations = new Set()
  /** @type {number[]} */
  const observedTimeouts = []
  /** @type {any} */
  let lastStartedOperation
  /** @type {any} */
  let lastStartedAuthority

  /** @param {any} operation */
  function activate(operation) {
    if (active && !sameRelease(active, operation.release)) releaseMap.set(active.releaseDigest, active)
    active = structuredClone(operation.release)
    releaseMap.set(active.releaseDigest, active)
    operationMap.set(operation.operationId, { ...structuredClone(operation), status: "succeeded" })
    activeOperation = null
  }

  const provider = {}
  Object.defineProperties(provider, {
    calls: { enumerable: true, value: calls },
    claimDispositions: { enumerable: true, value: claimDispositions },
    observedTimeouts: { enumerable: true, value: observedTimeouts },
    active: { enumerable: true, get: () => active ? structuredClone(active) : null },
    lastStartedOperation: { enumerable: true, get: () => lastStartedOperation ? structuredClone(lastStartedOperation) : undefined },
    lastStartedAuthority: { enumerable: true, get: () => lastStartedAuthority ? structuredClone(lastStartedAuthority) : undefined },
    readback: {
      enumerable: true,
      value: async (/** @type {{timeoutMs:number}} */ { timeoutMs }) => {
        calls.readback += 1
        observedTimeouts.push(timeoutMs)
        const result = {
          active: active ? structuredClone(active) : null,
          inProgress: activeOperation ? structuredClone(activeOperation) : null,
          retained: [...releaseMap.values()].filter((release) => !sameRelease(release, active)).map((release) => structuredClone(release)),
        }
        if (afterReadback) await afterReadback({ result: structuredClone(result), calls })
        return result
      },
    },
    readOperation: {
      enumerable: true,
      value: async (/** @type {string} */ operationId, /** @type {{timeoutMs:number}} */ { timeoutMs }) => {
        calls.operation += 1
        observedTimeouts.push(timeoutMs)
        const operation = hideOperationReadback ? undefined : operationMap.get(operationId)
        const result = operation ? structuredClone(operation) : null
        if (afterReadOperation) await afterReadOperation({ operationId, result: structuredClone(result), calls })
        return result
      },
    },
    claim: {
      enumerable: true,
      value: async (/** @type {any} */ operationValue, /** @type {{timeoutMs:number}} */ { timeoutMs }) => {
        calls.claim += 1
        observedTimeouts.push(timeoutMs)
        const operation = structuredClone(operationValue)
        if (!validOperation(operation, new Set(["pending"]))) throw new PagesProviderError("unknown")
        const existing = operationMap.get(operation.operationId)
        if (existing) {
          if (!sameOperation(existing, operation)) throw new PagesProviderError("conflict", { status: 409 })
          claimDispositions.push("exists")
          return { disposition: "exists" }
        }
        if (!sameNullableRelease(active, operation.expectedActive) || activeOperation !== null) {
          throw new PagesProviderError("conflict", { status: 409 })
        }
        activeOperation = structuredClone(operation)
        operationMap.set(operation.operationId, structuredClone(operation))
        if (afterClaim) await afterClaim({ operation: structuredClone(operation), calls })
        const step = claimResponses.shift() ?? { type: "acquired" }
        if (step.type === "return-invalid") {
          claimDispositions.push("invalid")
          return { disposition: "unknown" }
        }
        if (step.type === "persist-then-error") {
          claimDispositions.push("ambiguous")
          throw new PagesProviderError("transport")
        }
        if (step.type === "persist-then-timeout") {
          claimDispositions.push("ambiguous")
          return new Promise(() => {})
        }
        if (step.type !== "acquired") throw new PagesProviderError("unknown")
        claimDispositions.push("acquired")
        return { disposition: "acquired" }
      },
    },
    start: {
      enumerable: true,
      value: async (/** @type {any} */ operationValue, /** @type {{timeoutMs:number,authority:any}} */ { timeoutMs, authority }) => {
        calls.start += 1
        observedTimeouts.push(timeoutMs)
        const operation = structuredClone(operationValue)
        const sealed = structuredClone(authority)
        if (!validOperation(operation, new Set(["pending"])) || !validAuthority(sealed)) throw new PagesProviderError("unknown")
        const claimed = operationMap.get(operation.operationId)
        if (!sameOperation(claimed, operation) || !sameOperation(activeOperation, operation)
          || dispatchedOperations.has(operation.operationId)
          || !sameNullableRelease(active, operation.expectedActive)) {
          throw new PagesProviderError("conflict", { status: 409 })
        }
        dispatchedOperations.add(operation.operationId)
        lastStartedOperation = structuredClone(operation)
        lastStartedAuthority = structuredClone(sealed)
        const step = steps.shift() ?? { type: "success" }
        if (step.type === "success") {
          activate(operation)
          return
        }
        if (step.type === "return-pending") return
        if (step.type === "mutate-then-error") {
          activate(operation)
          throw new PagesProviderError(step.kind ?? "unknown", {
            ...(step.status === undefined ? {} : { status: step.status }),
            ...(step.retryAfterMs === undefined ? {} : { retryAfterMs: step.retryAfterMs }),
          })
        }
        if (step.type === "pending-error") {
          throw new PagesProviderError(step.kind ?? "unknown", {
            ...(step.status === undefined ? {} : { status: step.status }),
            ...(step.retryAfterMs === undefined ? {} : { retryAfterMs: step.retryAfterMs }),
          })
        }
        if (step.type === "delayed-success") {
          setTimeout(() => activate(operation), step.delayMs)
          if (step.settle === "return") return
          if (step.settle === "reject") throw new PagesProviderError(step.kind ?? "transport")
          return new Promise(() => {})
        }
        throw new PagesProviderError("unknown")
      },
    },
  })
  return Object.freeze(provider)
}
