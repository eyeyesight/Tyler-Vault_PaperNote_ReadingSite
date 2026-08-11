// @ts-nocheck -- the runtime is a narrow composition seam over injected publication/QA capabilities.
import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const GIT_SHA = /^[0-9a-f]{40}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u
const MAX_RESULT_CHECKS = 64
const MAX_CHECK_NAME = 96
const MAX_OPERATION_ID = 80
const PUBLICATION_CODE_MAP = new Map([
  ["smoke_failed", "SMOKE_FAILED"],
  ["pages_failed", "PAGES_FAILED"],
  ["workflow_failed", "WORKFLOW_FAILED"],
  ["dispatch_uncertain", "DISPATCH_UNCERTAIN"],
  ["push_uncertain", "PUSH_UNCERTAIN"],
  ["remote_drift", "REMOTE_DRIFT"],
])

export const LKG_SCHEMA_VERSION = 1
export const LIVE_QA_FAILED_ROLLED_BACK = "LIVE_QA_FAILED_ROLLED_BACK"
export const LIVE_QA_FAILED_NO_LKG = "LIVE_QA_FAILED_NO_LKG"
export const LIVE_QA_ROLLBACK_FAILED = "LIVE_QA_ROLLBACK_FAILED"

export class SitePublicationError extends Error {
  constructor(code) {
    super(code)
    this.name = "SitePublicationError"
    this.code = code
  }
}

function fail(code) {
  throw new SitePublicationError(code)
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null)
      && Object.getOwnPropertySymbols(value).length === 0
      && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => Object.hasOwn(descriptor, "value"))
  } catch {
    return false
  }
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    fail("RESULT_INVALID")
  }
}

function boundedOperationId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_OPERATION_ID || !/^[a-z0-9][a-z0-9._-]*$/u.test(value)) return "unknown"
  return value
}

function boundedCode(value, fallback) {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : fallback
}

function boundedPublicationCode(value) {
  if (typeof value === "string" && SAFE_CODE.test(value)) return value
  return PUBLICATION_CODE_MAP.get(value) ?? "PUBLICATION_FAILED"
}

function boundedSha(value, length) {
  const expression = length === 40 ? GIT_SHA : SHA256
  return typeof value === "string" && expression.test(value) ? value : null
}

function boundedIdentifier(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) return null
  return value
}

function safeChecks(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_RESULT_CHECKS).flatMap((entry) => {
    if (!isPlainObject(entry) || typeof entry.name !== "string" || entry.name.length === 0 || entry.name.length > MAX_CHECK_NAME) return []
    if (entry.outcome !== "pass" && entry.outcome !== "fail" && entry.outcome !== "warn") return []
    return [{ name: entry.name, outcome: entry.outcome }]
  })
}

function safeQaResult(value, fallbackCode = "QA_RESULT_INVALID") {
  if (!isPlainObject(value)) {
    return { status: "fail", critical: true, checks: [{ name: "live_qa", outcome: "fail" }], error_code: fallbackCode }
  }
  const status = value.status === "pass" ? "pass" : value.status === "fail" ? "fail" : "fail"
  return {
    status,
    critical: status === "fail" ? value.critical !== false : false,
    checks: safeChecks(value.checks),
    error_code: status === "fail" ? boundedCode(value.error_code, fallbackCode) : null,
  }
}

function safePublicationResult(value, operation) {
  if (!isPlainObject(value)) fail("PUBLICATION_RESULT_INVALID")
  const status = value.status === "published" || value.status === "deployed"
    ? "published"
    : value.status === "no_change"
      ? "no_change"
      : value.status === "needs_attention"
        ? "needs_attention"
        : "needs_attention"
  const identifiers = isPlainObject(value.identifiers) ? value.identifiers : {}
  const safeIdentifiers = {}
  for (const key of ["site_commit", "workflow_run_id", "deployment_id", "mapping_pr_id", "mapping_merge_sha"]) {
    const candidate = key.endsWith("sha") || key === "site_commit"
      ? boundedSha(identifiers[key], key === "site_commit" || key === "mapping_merge_sha" ? 40 : 64)
      : boundedIdentifier(identifiers[key])
    if (candidate !== null) safeIdentifiers[key] = candidate
  }
  const result = {
    version: value.version === 1 ? 1 : 1,
    operation_id: boundedOperationId(value.operation_id ?? operation?.operation_id),
    status,
    checks: safeChecks(value.checks),
    error_code: status === "needs_attention" ? boundedPublicationCode(value.error_code) : null,
    identifiers: safeIdentifiers,
  }
  if (value.next_action === "none" || value.next_action === "request_manual_review" || value.next_action === "reconcile_operation") result.next_action = value.next_action
  return result
}

function siteIdentity(publication, operation) {
  const identifiers = isPlainObject(publication?.identifiers) ? publication.identifiers : {}
  const siteCommit = boundedSha(identifiers.site_commit ?? publication?.site_commit, 40)
    ?? boundedSha(operation?.candidate_identity?.site_commit, 40)
    ?? null
  const siteSha = boundedSha(publication?.site_sha256, 64)
    ?? boundedSha(operation?.candidate_identity?.site_sha256, 64)
    ?? null
  return { siteCommit, siteSha }
}

function candidateIdentity(operation) {
  return isPlainObject(operation?.candidate_identity) ? cloneJson(operation.candidate_identity) : null
}

function lkgCandidateRecord(publication, operation, qa) {
  const identity = siteIdentity(publication, operation)
  if (!identity.siteCommit || !identity.siteSha) fail("LKG_IDENTITY_INVALID")
  const identifiers = isPlainObject(publication?.identifiers) ? publication.identifiers : {}
  return {
    version: LKG_SCHEMA_VERSION,
    operation_id: boundedOperationId(operation?.operation_id),
    site_commit: identity.siteCommit,
    site_sha256: identity.siteSha,
    deployment_id: boundedIdentifier(identifiers.deployment_id),
    workflow_run_id: boundedIdentifier(identifiers.workflow_run_id),
    url: typeof publication?.url === "string" && publication.url.length <= 2048 ? publication.url : null,
    candidate_identity: candidateIdentity(operation),
    qa,
  }
}

function validateLkgRecord(value) {
  if (!isPlainObject(value) || value.version !== LKG_SCHEMA_VERSION
    || !GIT_SHA.test(value.site_commit) || !SHA256.test(value.site_sha256)
    || (value.deployment_id !== null && boundedIdentifier(value.deployment_id) === null)
    || (value.workflow_run_id !== null && boundedIdentifier(value.workflow_run_id) === null)
    || (value.url !== null && (typeof value.url !== "string" || value.url.length === 0 || value.url.length > 2048))
    || !isPlainObject(value.qa) || value.qa.status !== "pass") fail("LKG_RECORD_INVALID")
  if (value.candidate_identity !== null && !isPlainObject(value.candidate_identity)) fail("LKG_RECORD_INVALID")
  return cloneJson(value)
}

function recordPath(root, siteCommit) {
  return path.join(root, "records", `${siteCommit}.json`)
}

/**
 * Store each LKG record under its immutable site commit. `current.json` is
 * only a readable selector; rollback authority is the validated, keyed record
 * and never a branch name or an arbitrary ancestor.
 */
export function createImmutableLkgStore(root) {
  if (typeof root !== "string" || root.length === 0 || root.includes("\u0000")) fail("LKG_ROOT_INVALID")
  const absoluteRoot = path.resolve(root)
  return Object.freeze({
    async readCurrent() {
      let pointer
      try {
        pointer = JSON.parse(await readFile(path.join(absoluteRoot, "current.json"), "utf8"))
      } catch (error) {
        if (error?.code === "ENOENT") return null
        fail("LKG_READ_FAILED")
      }
      const safePointer = validateLkgRecord(pointer)
      let stored
      try {
        stored = JSON.parse(await readFile(recordPath(absoluteRoot, safePointer.site_commit), "utf8"))
      } catch {
        fail("LKG_READ_FAILED")
      }
      const safeStored = validateLkgRecord(stored)
      if (JSON.stringify(safeStored) !== JSON.stringify(safePointer)) fail("LKG_READ_FAILED")
      return safeStored
    },
    async record(value) {
      const record = validateLkgRecord(value)
      await mkdir(path.join(absoluteRoot, "records"), { recursive: true })
      const bytes = `${JSON.stringify(record)}\n`
      const target = recordPath(absoluteRoot, record.site_commit)
      try {
        await writeFile(target, bytes, { encoding: "utf8", flag: "wx" })
      } catch (error) {
        if (error?.code !== "EEXIST") fail("LKG_WRITE_FAILED")
        let existing
        try {
          existing = await readFile(target, "utf8")
        } catch {
          fail("LKG_WRITE_FAILED")
        }
        if (existing !== bytes) fail("LKG_IMMUTABILITY_VIOLATION")
      }
      try {
        await writeFile(path.join(absoluteRoot, "current.json"), bytes, { encoding: "utf8" })
      } catch {
        fail("LKG_WRITE_FAILED")
      }
      return cloneJson(record)
    },
  })
}

function qaInput(operation, settings, publication, phase, target = undefined) {
  const input = {
    phase,
    operation,
    publication,
  }
  if (typeof target === "string") input.siteRoot = target
  if (isPlainObject(settings?.qa_options)) input.options = cloneJson(settings.qa_options)
  return input
}

function candidateSiteRoot(operation, settings) {
  if (typeof settings?.candidate_site_root === "string") return settings.candidate_site_root
  if (typeof settings?.candidateSiteRoot === "string") return settings.candidateSiteRoot
  if (typeof operation?.claimed_session?.work_root === "string" && typeof operation?.operation_id === "string") {
    const laneRoot = operation.lane === "site" ? "main-handoff" : "handoff"
    return path.join(operation.claimed_session.work_root, operation.operation_id, laneRoot, "site")
  }
  return null
}

function resultWithFailure(publication, operation, code, extra = {}) {
  const base = safePublicationResult(publication, operation)
  return {
    ...base,
    status: "needs_attention",
    error_code: code,
    ...extra,
  }
}

/**
 * Run one publication, one critical QA pass, and—only for a critical failure—
 * one exact-LKG rollback followed by one revalidation. The publication and
 * rollback implementations remain injected controller seams; this module
 * owns only the narrow compensation ordering and redacted result projection.
 */
export async function runSitePublication(operation, settings = {}, dependencies = {}) {
  if (!isPlainObject(operation) || !isPlainObject(settings) || !isPlainObject(dependencies)) return resultWithFailure({}, {}, "REQUEST_INVALID")
  const publish = dependencies.publish
  const qa = dependencies.qa
  const lkg = dependencies.lkg
  const rollback = dependencies.rollback
  if (typeof publish !== "function" || typeof qa !== "function" || !lkg || typeof lkg.readCurrent !== "function" || typeof lkg.record !== "function") {
    return resultWithFailure({}, operation, "PUBLICATION_COMPONENT_UNAVAILABLE")
  }

  let publication
  try {
    publication = await publish(operation, settings)
  } catch {
    return resultWithFailure({ operation_id: operation.operation_id }, operation, "PUBLICATION_FAILED")
  }
  let safePublication
  try {
    safePublication = safePublicationResult(publication, operation)
  } catch {
    return resultWithFailure({ operation_id: operation.operation_id }, operation, "PUBLICATION_RESULT_INVALID")
  }
  if (safePublication.status === "no_change") return safePublication
  const publicSmokeFailure = safePublication.status === "needs_attention"
    && safePublication.error_code === "SMOKE_FAILED"
    && GIT_SHA.test(safePublication.identifiers?.site_commit)
  if (safePublication.status === "needs_attention" && !publicSmokeFailure) return safePublication

  const siteRoot = candidateSiteRoot(operation, settings)
  let liveQa
  if (publicSmokeFailure) {
    liveQa = safeQaResult({
      status: "fail",
      critical: true,
      checks: [{ name: "public_pages_smoke", outcome: "fail" }],
      error_code: "SMOKE_FAILED",
    })
  } else {
    try {
      liveQa = safeQaResult(await qa(qaInput(operation, settings, safePublication, "published", siteRoot)))
    } catch {
      liveQa = safeQaResult(null, "QA_EXECUTION_FAILED")
    }
  }
  const identity = siteIdentity(publication, operation)
  if (liveQa.status === "pass") {
    let record
    try {
      record = await lkg.record(lkgCandidateRecord(publication, operation, liveQa))
      record = validateLkgRecord(record)
    } catch {
      return resultWithFailure(safePublication, operation, "LKG_RECORD_FAILED", { live_qa: liveQa })
    }
    return {
      ...safePublication,
      status: "published",
      live_qa: liveQa,
      lkg: {
        site_commit: record.site_commit,
        site_sha256: record.site_sha256,
      },
    }
  }

  const failedRelease = {
    site_commit: identity.siteCommit,
    site_sha256: identity.siteSha,
  }
  let currentLkg
  try {
    currentLkg = await lkg.readCurrent()
    if (currentLkg !== null) currentLkg = validateLkgRecord(currentLkg)
  } catch {
    return resultWithFailure(safePublication, operation, LIVE_QA_FAILED_NO_LKG, { live_qa: liveQa, failed_release: failedRelease })
  }
  if (!currentLkg) return resultWithFailure(safePublication, operation, LIVE_QA_FAILED_NO_LKG, { live_qa: liveQa, failed_release: failedRelease })
  if (typeof rollback !== "function") return resultWithFailure(safePublication, operation, LIVE_QA_ROLLBACK_FAILED, { live_qa: liveQa, failed_release: failedRelease })

  let rollbackResult
  try {
    rollbackResult = await rollback({ operation, settings, publication: safePublication, lkg: currentLkg, failed_qa: liveQa })
    if (!isPlainObject(rollbackResult)
      || !GIT_SHA.test(rollbackResult.rollback_commit)
      || rollbackResult.restored_lkg_commit !== currentLkg.site_commit
      || rollbackResult.site_sha256 !== currentLkg.site_sha256) throw new SitePublicationError("ROLLBACK_IDENTITY_INVALID")
  } catch {
    return resultWithFailure(safePublication, operation, LIVE_QA_ROLLBACK_FAILED, { live_qa: liveQa, failed_release: failedRelease })
  }

  let revalidation
  try {
    revalidation = rollbackResult.revalidation === undefined
      ? safeQaResult(await qa(qaInput(operation, settings, safePublication, "rollback", rollbackResult.site_root)), "QA_ROLLBACK_REVALIDATION_FAILED")
      : safeQaResult(rollbackResult.revalidation, "QA_ROLLBACK_REVALIDATION_FAILED")
  } catch {
    revalidation = safeQaResult(null, "QA_ROLLBACK_REVALIDATION_FAILED")
  }
  const safeRollback = {
    rollback_commit: rollbackResult.rollback_commit,
    restored_lkg_commit: rollbackResult.restored_lkg_commit,
    site_sha256: rollbackResult.site_sha256,
  }
  if (revalidation.status !== "pass") {
    return resultWithFailure(safePublication, operation, LIVE_QA_ROLLBACK_FAILED, {
      live_qa: liveQa,
      failed_release: failedRelease,
      rollback: safeRollback,
      revalidation,
    })
  }
  return resultWithFailure(safePublication, operation, LIVE_QA_FAILED_ROLLED_BACK, {
    live_qa: liveQa,
    failed_release: failedRelease,
    rollback: safeRollback,
    revalidation,
  })
}
