// @ts-nocheck -- black-box mutation matrix intentionally exercises dynamic JSON shapes.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import {
  computeGitHubLaunchAuditDigest,
  computeGitHubLaunchAuditEvidenceDigest,
  GitHubLaunchAuditError,
  validateGitHubLaunchAudit,
} from "../lib/github-launch-audit.mjs"

const examplePath = path.resolve(import.meta.dirname, "..", "specs", "examples", "github-launch-audit-v1.example.json")

async function loadExample() {
  return JSON.parse(await readFile(examplePath, "utf8"))
}

function clone(value) {
  return structuredClone(value)
}

function reseal(audit) {
  for (const evidence of audit.evidence) {
    evidence.evidence_digest = computeGitHubLaunchAuditEvidenceDigest(evidence)
  }
  audit.audit_digest = computeGitHubLaunchAuditDigest(audit)
  return audit
}

function expectCode(code, mutate) {
  assert.throws(
    () => validateGitHubLaunchAudit(mutate(clone(currentAudit))),
    (error) => error instanceof GitHubLaunchAuditError && error.code === code,
    code,
  )
}

let currentAudit

test.beforeEach(async () => {
  currentAudit = await loadExample()
})

test("valid example passes the complete semantic launch-audit validator", () => {
  const result = validateGitHubLaunchAudit(currentAudit)
  assert.equal(result.kind, "github-launch-audit")
  assert.equal(result.schemaVersion, 1)
  assert.deepEqual(result.value, currentAudit)
})

test("previsibility cannot pass without an authenticated complete GitHub API machine evidence", () => {
  expectCode("SCHEMA_INVALID", (audit) => {
    audit.evidence = audit.evidence.filter((entry) => !(entry.phase === "previsibility_audit" && entry.source === "github-api"))
    return audit
  })
})

test("postvisibility cannot pass with incomplete API pagination", () => {
  expectCode("SCHEMA_INVALID", (audit) => {
    audit.evidence.find((entry) => entry.phase === "post_visibility_readback" && entry.source === "github-api").pagination = "not-applicable"
    return audit
  })
})

test("an unauthenticated API observation cannot satisfy the machine lane", () => {
  expectCode("SCHEMA_INVALID", (audit) => {
    audit.evidence.find((entry) => entry.phase === "previsibility_audit" && entry.source === "github-api").authentication = "none"
    return audit
  })
})

test("UI-only corroboration cannot replace either machine lane", () => {
  expectCode("SCHEMA_INVALID", (audit) => {
    audit.evidence = audit.evidence.filter((entry) => entry.source !== "github-api")
    audit.scope.post_visibility_readback.surfaces = ["repository", "ui", "anonymous-repository"]
    return audit
  })
})

test("UI corroboration may be absent while the two machine lanes remain valid", () => {
  const audit = clone(currentAudit)
  audit.evidence = audit.evidence.filter((entry) => entry.source !== "github-ui")
  delete audit.scope.authenticated_github_evidence.ui_corroboration
  audit.scope.post_visibility_readback.surfaces = ["repository", "api", "anonymous-repository"]
  reseal(audit)
  assert.equal(validateGitHubLaunchAudit(audit).value.audit_digest, audit.audit_digest)
})

test("lifecycle phases must remain in the exact contract order", () => {
  expectCode("SCHEMA_INVALID", (audit) => {
    audit.scope.lifecycle_phases.reverse()
    return audit
  })
})

test("evidence observed_at must remain inside its phase time window", () => {
  expectCode("EVIDENCE_TIME_INVALID", (audit) => {
    audit.evidence.find((entry) => entry.phase === "previsibility_audit" && entry.source === "github-api").observed_at = "2026-08-04T12:19:00Z"
    return audit
  })
})

test("reversed lifecycle dates are rejected after schema validation", () => {
  expectCode("TIME_ORDER_INVALID", (audit) => {
    audit.approvals.visibility.approved_at = "2026-08-04T12:25:00Z"
    return audit
  })
})

test("calendar-invalid ISO-looking dates are rejected", () => {
  expectCode("TIMESTAMP_INVALID", (audit) => {
    audit.completed_at = "2026-02-30T12:30:00Z"
    return audit
  })
})

test("an evidence observation digest is recomputed from its bounded projection", () => {
  expectCode("EVIDENCE_DIGEST_MISMATCH", (audit) => {
    audit.evidence[0].observation.checks.push("forged-check")
    return audit
  })
})

test("the top-level audit digest is recomputed with audit_digest omitted", () => {
  expectCode("AUDIT_DIGEST_MISMATCH", (audit) => {
    audit.summary = `${audit.summary} forged`
    reseal(audit)
    audit.audit_digest = currentAudit.audit_digest
    return audit
  })
})

test("finding counts must equal the categorized finding items", () => {
  expectCode("FINDINGS_COUNTS_MISMATCH", (audit) => {
    audit.findings.counts.secret = 1
    return audit
  })
})

test("finding status must agree with evidence results and item states", () => {
  expectCode("FINDINGS_STATUS_MISMATCH", (audit) => {
    audit.findings.status = "blocked"
    return audit
  })
})

test("Pages browser QA cannot be mixed into the launch audit", () => {
  expectCode("SCHEMA_INVALID", (audit) => {
    audit.post_deploy_qa = {
      phase: "post_deploy_qa",
      result: "clear",
    }
    return audit
  })
})

test("anonymous repository readback is post-visibility repository evidence, not Pages QA", () => {
  const audit = currentAudit
  const anonymous = audit.evidence.find((entry) => entry.source === "anonymous-repository")
  assert.equal(anonymous.phase, "post_visibility_readback")
  assert.equal(anonymous.authentication, "none")
  assert.equal(anonymous.observation.surface, "anonymous-repository")
  assert.equal(Object.hasOwn(audit, "post_deploy_qa"), false)
})
