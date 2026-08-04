import { readFile } from "node:fs/promises"
import path from "node:path"
import AjvModule from "ajv"

import { sha256Jcs } from "./publication-contracts.mjs"

const schemaPath = path.resolve(import.meta.dirname, "..", "config", "github-launch-audit-v1.schema.json")
const schema = JSON.parse(await readFile(schemaPath, "utf8"))
const Ajv = /** @type {any} */ (AjvModule)
const ajv = new Ajv({ allErrors: true, strict: true })
const validateShape = ajv.compile(schema)

const launchAuditPhases = [
  "previsibility_audit",
  "visibility_approval",
  "post_visibility_readback",
  "finalize_launch_audit",
]
const findingCategories = ["secret", "rights_unknown", "disallowed_output", "control_plane", "repository"]
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/

export class GitHubLaunchAuditError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message)
    this.name = "GitHubLaunchAuditError"
    this.code = code
    this.details = details
  }
}

/** @param {unknown} value @param {Set<object>} ancestors */
function isPlainJsonValue(value, ancestors) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object") return false
  const object = /** @type {object} */ (value)
  if (ancestors.has(object)) return false
  ancestors.add(object)
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(object)
      if (keys.some((key) => typeof key !== "string" || key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) return false
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isPlainJsonValue(value[index], ancestors)) return false
      }
      return true
    }
    const prototype = Object.getPrototypeOf(object)
    if (prototype !== Object.prototype && prototype !== null) return false
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key !== "string") return false
      const descriptor = Object.getOwnPropertyDescriptor(object, key)
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return false
      if (!isPlainJsonValue(descriptor.value, ancestors)) return false
    }
    return true
  } finally {
    ancestors.delete(object)
  }
}

/** @param {unknown} value */
function snapshotPlainData(value) {
  let snapshot
  try {
    snapshot = structuredClone(value)
  } catch {
    throw new GitHubLaunchAuditError("INPUT_NOT_PLAIN_DATA", "launch audit must be an already-parsed cloneable JSON value")
  }
  if (!isPlainJsonValue(snapshot, new Set())) {
    throw new GitHubLaunchAuditError("INPUT_NOT_PLAIN_DATA", "launch audit must contain only ordinary JSON data")
  }
  return /** @type {Record<string, any>} */ (snapshot)
}

/** @param {any[]} errors */
function schemaError(errors) {
  const first = [...(errors ?? [])].sort((left, right) =>
    String(left.instancePath ?? "").localeCompare(String(right.instancePath ?? ""))
      || String(left.keyword ?? "").localeCompare(String(right.keyword ?? "")))[0]
  return new GitHubLaunchAuditError(
    "SCHEMA_INVALID",
    `GitHub launch audit schema validation failed at ${first?.instancePath || "/"}: ${first?.keyword || "invalid"}`,
    { instancePath: first?.instancePath ?? "", keyword: first?.keyword ?? "invalid" },
  )
}

/** @param {unknown} value */
function timestampMilliseconds(value) {
  if (typeof value !== "string" || !timestampPattern.test(value)) {
    throw new GitHubLaunchAuditError("TIMESTAMP_INVALID", "launch-audit timestamps must be whole-second UTC ISO timestamps")
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== `${value.slice(0, -1)}.000Z`) {
    throw new GitHubLaunchAuditError("TIMESTAMP_INVALID", "launch-audit timestamp is not a valid UTC calendar instant")
  }
  return milliseconds
}

/** @param {any} evidence */
export function githubLaunchAuditObservationProjection(evidence) {
  if (!evidence || typeof evidence !== "object" || !Object.hasOwn(evidence, "observation")) {
    throw new GitHubLaunchAuditError("OBSERVATION_MISSING", "evidence must retain an observation projection")
  }
  return snapshotPlainData(evidence.observation)
}

/** @param {any} evidence */
export function computeGitHubLaunchAuditEvidenceDigest(evidence) {
  return sha256Jcs(githubLaunchAuditObservationProjection(evidence))
}

/** @param {any} audit */
export function computeGitHubLaunchAuditDigest(audit) {
  const unsigned = snapshotPlainData(audit)
  delete unsigned.audit_digest
  return sha256Jcs(unsigned)
}

/** @param {any} audit */
function validatePhaseOrder(audit) {
  const phases = audit.scope.lifecycle_phases
  if (phases.length !== launchAuditPhases.length || phases.some((/** @type {string} */ phase, /** @type {number} */ index) => phase !== launchAuditPhases[index])) {
    throw new GitHubLaunchAuditError("PHASE_ORDER_INVALID", "launch-audit lifecycle phases must use the exact ordered lifecycle")
  }
}

/** @param {any} audit */
function validateTimeOrder(audit) {
  const created = timestampMilliseconds(audit.created_at)
  const approved = timestampMilliseconds(audit.approvals.visibility.approved_at)
  const changed = timestampMilliseconds(audit.visibility_changed_at)
  const completed = timestampMilliseconds(audit.completed_at)
  const finalized = timestampMilliseconds(audit.finalized_at)
  if (!(created <= approved && approved <= changed && changed <= completed && completed <= finalized)) {
    throw new GitHubLaunchAuditError(
      "TIME_ORDER_INVALID",
      "launch-audit time order must be created_at <= visibility approval <= visibility_changed_at <= completed_at <= finalized_at",
    )
  }
  return { created, approved, changed, completed }
}

/** @param {any} audit @param {{created:number,approved:number,changed:number,completed:number}} times */
function validateEvidence(audit, times) {
  const findingIds = new Set(audit.findings.items.map((/** @type {any} */ item) => item.id))
  const referencedFindingIds = new Set()
  const seenEvidenceIds = new Set()
  for (const evidence of audit.evidence) {
    if (seenEvidenceIds.has(evidence.id)) {
      throw new GitHubLaunchAuditError("EVIDENCE_ID_DUPLICATE", `duplicate evidence id: ${evidence.id}`)
    }
    seenEvidenceIds.add(evidence.id)

    const observed = timestampMilliseconds(evidence.observed_at)
    const inRange = evidence.phase === "previsibility_audit"
      ? times.created <= observed && observed <= times.approved
      : times.changed <= observed && observed <= times.completed
    if (!inRange) {
      throw new GitHubLaunchAuditError("EVIDENCE_TIME_INVALID", `evidence is outside its ${evidence.phase} time range: ${evidence.id}`)
    }
    if (evidence.source === "anonymous-repository" && evidence.phase !== "post_visibility_readback") {
      throw new GitHubLaunchAuditError("ANONYMOUS_READBACK_PHASE_INVALID", "anonymous repository readback is only post-visibility evidence")
    }
    if (evidence.result !== evidence.observation.result) {
      throw new GitHubLaunchAuditError("EVIDENCE_RESULT_MISMATCH", `evidence result does not match its observation: ${evidence.id}`)
    }
    const expectedDigest = computeGitHubLaunchAuditEvidenceDigest(evidence)
    if (expectedDigest !== evidence.evidence_digest) {
      throw new GitHubLaunchAuditError("EVIDENCE_DIGEST_MISMATCH", `evidence digest does not match its observation: ${evidence.id}`)
    }
    if (evidence.result === "findings" && evidence.finding_ids.length === 0) {
      throw new GitHubLaunchAuditError("EVIDENCE_FINDINGS_UNBOUND", `findings evidence must name finding items: ${evidence.id}`)
    }
    if (evidence.result !== "findings" && evidence.finding_ids.length !== 0) {
      throw new GitHubLaunchAuditError("EVIDENCE_FINDINGS_UNEXPECTED", `clear or not-provable evidence cannot name findings: ${evidence.id}`)
    }
    for (const findingId of evidence.finding_ids) {
      if (!findingIds.has(findingId)) {
        throw new GitHubLaunchAuditError("EVIDENCE_FINDING_UNKNOWN", `evidence names an unknown finding: ${findingId}`)
      }
      referencedFindingIds.add(findingId)
    }
  }
  for (const findingId of findingIds) {
    if (!referencedFindingIds.has(findingId)) {
      throw new GitHubLaunchAuditError("FINDING_UNREFERENCED", `finding is not bound to findings evidence: ${findingId}`)
    }
  }
}

/** @param {any} audit */
function validateFindings(audit) {
  const expectedCounts = Object.fromEntries(findingCategories.map((category) => [category, 0]))
  const ids = new Set()
  for (const item of audit.findings.items) {
    if (ids.has(item.id)) throw new GitHubLaunchAuditError("FINDING_ID_DUPLICATE", `duplicate finding id: ${item.id}`)
    ids.add(item.id)
    expectedCounts[item.category] += 1
  }
  for (const category of findingCategories) {
    if (audit.findings.counts[category] !== expectedCounts[category]) {
      throw new GitHubLaunchAuditError("FINDINGS_COUNTS_MISMATCH", `finding count mismatch for ${category}`)
    }
  }
  const expectedStatus = audit.findings.items.length === 0
    ? "clear"
    : audit.findings.items.some((/** @type {any} */ item) => item.status === "open")
      ? "blocked"
      : "remediated"
  if (audit.findings.status !== expectedStatus) {
    throw new GitHubLaunchAuditError("FINDINGS_STATUS_MISMATCH", `expected findings status ${expectedStatus}`)
  }
}

/** @param {any} audit */
function validateLimitations(audit) {
  const zeroGates = [
    audit.limitations.known_clones_and_cached_views.zero_gate,
    audit.limitations.unknown_external_copies.zero_gate,
    audit.limitations.zero_gate.required_for_launch,
  ]
  if (zeroGates.some((value) => value !== false)) {
    throw new GitHubLaunchAuditError("ZERO_GATE_INVALID", "known copies and external-copy limitations must never be zero gates")
  }
}

/**
 * Validate a parsed GitHub launch-audit object. The input is cloned once and
 * every later check runs against that plain-data snapshot. This is a normal
 * parsed-data contract seam, not a hostile same-process object/proxy sandbox.
 * @param {unknown} input
 */
export function validateGitHubLaunchAudit(input) {
  const audit = snapshotPlainData(input)
  if (!validateShape(audit)) throw schemaError(validateShape.errors)
  validatePhaseOrder(audit)
  const times = validateTimeOrder(audit)
  validateEvidence(audit, times)
  validateFindings(audit)
  validateLimitations(audit)
  if (computeGitHubLaunchAuditDigest(audit) !== audit.audit_digest) {
    throw new GitHubLaunchAuditError("AUDIT_DIGEST_MISMATCH", "top-level audit_digest does not match the canonical audit")
  }
  return { kind: "github-launch-audit", schemaVersion: audit.schema_version, value: audit }
}
