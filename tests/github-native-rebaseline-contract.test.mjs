import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import AjvModule from "ajv"

import { validateGitHubLaunchAudit } from "../lib/github-launch-audit.mjs"
import { sha256Jcs } from "../lib/publication-contracts.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const deploymentContractPath = path.join(repoRoot, "config", "github-pages-deployment-contract-v1.json")
const deploymentSchemaPath = path.join(repoRoot, "config", "github-pages-deployment-contract-v1.schema.json")
const launchAuditSchemaPath = path.join(repoRoot, "config", "github-launch-audit-v1.schema.json")
const launchAuditExamplePath = path.join(repoRoot, "specs", "examples", "github-launch-audit-v1.example.json")
const catalogPath = path.join(repoRoot, "config", "github-provider-public-exposure-catalog-v1.json")

/** @param {string} filePath @returns {Promise<any>} */
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"))
}

/** @param {string} filePath @returns {Promise<boolean>} */
async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

/** @param {any} lifecycle */
function assertPhaseGraph(lifecycle) {
  assert(Array.isArray(lifecycle.phases), "lifecycle phases must be an array")
  /** @type {any[]} */
  const phases = lifecycle.phases
  const byId = new Map()
  for (const phase of phases) {
    assert.equal(typeof phase.id, "string")
    assert(Number.isInteger(phase.order) && phase.order > 0, `invalid phase order: ${phase.id}`)
    assert(!byId.has(phase.id), `duplicate phase: ${phase.id}`)
    byId.set(phase.id, phase)
  }

  const ordered = [...phases].sort((first, second) => first.order - second.order)
  assert.deepEqual(ordered.map((phase) => phase.id), phases.map((phase) => phase.id), "lifecycle phases must be in order")
  for (const phase of phases) {
    for (const dependency of phase.depends_on) {
      assert(byId.has(dependency), `unknown dependency: ${phase.id} -> ${dependency}`)
    }
  }

  const visiting = new Set()
  const visited = new Set()
  /** @param {string} phaseId */
  function visit(phaseId) {
    if (visiting.has(phaseId)) throw new Error(`lifecycle cycle: ${phaseId}`)
    if (visited.has(phaseId)) return
    visiting.add(phaseId)
    for (const dependency of byId.get(phaseId).depends_on) visit(dependency)
    visiting.delete(phaseId)
    visited.add(phaseId)
  }
  for (const phase of phases) visit(phase.id)
  for (const phase of phases) {
    for (const dependency of phase.depends_on) {
      assert(byId.get(dependency).order < phase.order, `phase-order violation: ${phase.id} depends on ${dependency}`)
    }
  }
}

/** @param {any} audit */
function assertLaunchAuditBoundary(audit) {
  assert.equal(audit.audit_kind, "one-time-launch-audit")
  assert.deepEqual(audit.scope.lifecycle_phases, [
    "previsibility_audit",
    "visibility_approval",
    "post_visibility_readback",
    "finalize_launch_audit",
  ])
  assert.equal(Object.hasOwn(audit, "post_deploy_qa"), false)
  assert.equal(Object.hasOwn(audit.approvals, "deployment"), false)
  assert.equal(Object.hasOwn(audit.approvals, "deployment_approval"), false)
  assert(audit.evidence.every(/** @param {any} entry */ (entry) => entry.plane !== "deployment-plane"))
  assert(audit.evidence.every(/** @param {any} entry */ (entry) => entry.source !== "anonymous-browser"))
  assert.equal(audit.scope.authenticated_github_evidence.machine_lane.required, true)
  assert.equal(audit.scope.authenticated_github_evidence.machine_lane.single_lane, true)
  assert(["gh-api-paginate", "authenticated-github-api"].includes(audit.scope.authenticated_github_evidence.machine_lane.transport))
  assert.equal(audit.scope.authenticated_github_evidence.machine_lane.pagination, "complete")
  if (Object.hasOwn(audit.scope.authenticated_github_evidence, "ui_corroboration")) {
    assert.equal(audit.scope.authenticated_github_evidence.ui_corroboration.required, false)
  }
  assert.equal(audit.scope.anonymous_repository_readback.after_visibility_change, true)
  assert.equal(Object.hasOwn(audit.findings.counts, "deployment"), false)
}

test("Wave C deploy input is anchored to the gh-pages branch transport", async () => {
  const deploymentContract = await readJson(deploymentContractPath)
  assert.equal(deploymentContract.rebaseline, "wave-c-gh-pages-branch")
  assert.equal(deploymentContract.migration.status, "wave-c-gh-pages-branch-implementation")
  assert.equal(deploymentContract.delivery.method, "gh-pages-branch-to-pages-artifact")
  assert.equal(deploymentContract.delivery.source_ref, "refs/heads/gh-pages")
  assert.equal(deploymentContract.delivery.generated_site_in_git, true)
  assert.equal(deploymentContract.delivery.branch_layout.public_site_root, "site/")
  assert.equal(deploymentContract.delivery.branch_layout.candidate_metadata, ".publication/gh-pages-candidate-v1.json")
  assert.equal(deploymentContract.delivery.branch_layout.final_launch_audit, ".publication/github-launch-audit-v1.json")
  assert.equal(deploymentContract.workflow.workflow_file_ref, "refs/heads/main")
  assert.deepEqual(deploymentContract.workflow.deploy_triggers, ["workflow_dispatch"])
  assert.deepEqual(Object.keys(deploymentContract.workflow.triggers), ["workflow_dispatch"])
  assert.equal(deploymentContract.workflow.workflow_dispatch.inputs.site_commit.pattern, "^[0-9a-f]{40}$")
  assert.equal(deploymentContract.workflow.workflow_dispatch.inputs.candidate_digest.pattern, "^[0-9a-f]{64}$")
  assert.equal(deploymentContract.workflow.workflow_dispatch.inputs.launch_audit_digest.pattern, "^[0-9a-f]{64}$")
  assert.deepEqual(deploymentContract.workflow.main_only_gate, {
    required: true,
    ref: "refs/heads/main",
    default_branch: "main",
    failure: "hard-fail before candidate input use",
  })
  assert.equal(deploymentContract.workflow.jobs.validate.proves_site_commit_on_source_ref, true)
  assert.equal(deploymentContract.workflow.jobs.validate.validates_candidate_and_audit, true)
  assert.deepEqual(deploymentContract.workflow.jobs.validate.upload_paths, ["site/"])
  assert.deepEqual(deploymentContract.workflow.jobs.validate.verifier_summary_fields, {
    candidate_digest: "verifier.candidateDigest",
    launch_audit_digest: "verifier.launchAuditDigest",
  })
  assert.equal(deploymentContract.workflow.jobs.deploy.enters_environment_after, "validate")
  assert.equal(deploymentContract.sealed_custody.deploy_authority, false)
  assert.deepEqual(deploymentContract.migration.remaining_blockers, [
    "remote GitHub settings",
    "actual gh-pages branch contents",
    "live launch audit",
    "visibility and deployment approvals",
    "provider deployment and readback",
    "post-deploy anonymous/browser QA",
  ])
})

test("GitHub-native rebaseline validates the active contracts and digest", async () => {
  const deploymentContract = await readJson(deploymentContractPath)
  const deploymentSchema = await readJson(deploymentSchemaPath)
  const launchAuditSchema = await readJson(launchAuditSchemaPath)
  const launchAudit = await readJson(launchAuditExamplePath)
  const Ajv = /** @type {any} */ (AjvModule)
  const ajv = new Ajv({ allErrors: true, strict: true })
  const validateDeployment = ajv.compile(deploymentSchema)
  const validateLaunchAudit = ajv.compile(launchAuditSchema)

  assert.equal(validateDeployment(deploymentContract), true, ajv.errorsText(validateDeployment.errors))
  assert.equal(validateLaunchAudit(launchAudit), true, ajv.errorsText(validateLaunchAudit.errors))
  assert.deepEqual(validateGitHubLaunchAudit(launchAudit).value, launchAudit)
  const digestInput = structuredClone(launchAudit)
  delete digestInput.audit_digest
  assert.equal(sha256Jcs(digestInput), launchAudit.audit_digest)

  assert.equal(deploymentContract.rebaseline, "wave-c-gh-pages-branch")
  assert.deepEqual(Object.keys(deploymentContract.planes).sort(), [
    "deployment_plane",
    "github_control_plane",
    "public_content_audit",
  ])
  assert.equal(deploymentContract.planes.public_content_audit.authority, "project-owned")
  assert.equal(deploymentContract.planes.github_control_plane.authority, "github-native")
  assert.equal(deploymentContract.planes.deployment_plane.authority, "github-native")
  assert.equal(deploymentContract.planes.public_content_audit.launch_audit.schema, "config/github-launch-audit-v1.schema.json")
  assert.equal(deploymentContract.planes.public_content_audit.known_clones_and_cached_views.zero_gate, false)
  assert.equal(deploymentContract.migration.status, "wave-c-gh-pages-branch-implementation")
  assert.equal(deploymentContract.migration.wave_c.live_state, "not-live")
  assert.deepEqual(deploymentContract.migration.remaining_blockers, [
    "remote GitHub settings",
    "actual gh-pages branch contents",
    "live launch audit",
    "visibility and deployment approvals",
    "provider deployment and readback",
    "post-deploy anonymous/browser QA",
  ])
  assert(!deploymentContract.planes.public_content_audit.required_inputs.includes("launch audit digest"))
  for (const requiredInput of [
    "site_commit",
    "candidate_digest",
    "candidate_site_inventory",
    "candidate_site_inventory_digest",
    "manifest_digest",
    "receipt_digest",
    "rights_authority",
    "launch_audit_digest",
  ]) assert(Object.hasOwn(deploymentContract.delivery.deploy_input, requiredInput), requiredInput)
  assert.equal(Object.hasOwn(deploymentContract.delivery.deploy_input, "rights_digest"), false)
  assert.equal(deploymentContract.delivery.deploy_input.candidate_digest, "workflow_dispatch.inputs.candidate_digest")
  assert.equal(deploymentContract.delivery.deploy_input.candidate_site_inventory, "candidate.candidate_site.inventory")
  assert.equal(deploymentContract.delivery.deploy_input.candidate_site_inventory_digest, "candidate.candidate_site.digest")
  assert.equal(deploymentContract.delivery.deploy_input.manifest_digest, "candidate.approved_manifest.manifest_sha256")
  assert.equal(deploymentContract.delivery.deploy_input.receipt_digest, "candidate.approved_receipt.receipt_sha256")
  assert.equal(deploymentContract.delivery.deploy_input.rights_authority, "candidate.rights_authority")
  assert.equal(deploymentContract.delivery.deploy_input.launch_audit_digest, "workflow_dispatch.inputs.launch_audit_digest")
  assert.equal(Object.hasOwn(deploymentContract.delivery.deploy_input, "candidate_metadata"), false)
  assert.equal(Object.hasOwn(deploymentContract.delivery.deploy_input, "site_digest"), false)
  assert(deploymentContract.delivery.deploy_input_authority.includes("Exact 40-hex site_commit"))
  assert.match(deploymentContract.delivery.deploy_input_authority, /GitHub-authenticated workflow_dispatch inputs/i)
  assert.match(deploymentContract.trust_boundary.expected_digest_inputs, /independent of branch bytes/i)
  assert.match(deploymentContract.trust_boundary.human_authority, /Tyler/i)
  assert(deploymentContract.trust_boundary.limitations.some((/** @type {string} */ value) => /malicious launcher/i.test(value)))
  assert(deploymentContract.trust_boundary.limitations.some((/** @type {string} */ value) => /custom signing|custom token|custom claim/i.test(value)))
  assert.deepEqual(Object.keys(deploymentContract.delivery.byte_identity).sort(), [
    "candidate_digest",
    "candidate_site_inventory_digest",
    "launch_audit_digest",
    "manifest_digest",
    "receipt_digest",
    "rights_authority_binding",
    "source_artifact_inventory_digest",
  ])
  assert.match(deploymentContract.delivery.byte_identity.source_artifact_inventory_digest, /canonical normalized.*inventory/i)
  assert.match(deploymentContract.delivery.byte_identity.candidate_site_inventory_digest, /canonical normalized.*inventory/i)
  assert.doesNotMatch(JSON.stringify(deploymentContract.delivery.byte_identity), /raw aggregate|upload bytes/i)
  assert.equal(Object.hasOwn(deploymentContract.delivery.byte_identity, "artifact_digest"), false)
  assert.equal(deploymentContract.sealed_custody.deploy_authority, false)
  assert.equal(deploymentContract.workflow.automatic_publication, false)
  assert.deepEqual(Object.keys(deploymentContract.workflow.triggers), ["workflow_dispatch"])
  assert.deepEqual(deploymentContract.workflow.deploy_triggers, ["workflow_dispatch"])
  assert.deepEqual(deploymentContract.workflow.permissions, {
    root: { contents: "read" },
    validate: { contents: "read", pages: "write" },
    deploy: { contents: "read", pages: "write", "id-token": "write" },
  })
  assert.equal(deploymentContract.workflow.jobs.validate.proves_site_commit_on_source_ref, true)
  assert.equal(deploymentContract.workflow.jobs.validate.validates_candidate_and_audit, true)
  assert.deepEqual(deploymentContract.workflow.jobs.validate.upload_paths, ["site/"])
  assert.equal(deploymentContract.workflow.jobs.deploy.enters_environment_after, "validate")
  assert.equal(Object.hasOwn(deploymentContract.workflow.jobs.validate, "outputs"), false)
  assert.equal(deploymentContract.lifecycle.phases.some(/** @param {any} phase */ (phase) => phase.id === "validate_and_build"), false)
  assert.deepEqual(deploymentContract.lifecycle.phases.find(/** @param {any} phase */ (phase) => phase.id === "deployment_approval").depends_on, ["validate_candidate"])

  assertPhaseGraph(deploymentContract.lifecycle)
  assert.deepEqual(deploymentContract.lifecycle.launch_audit_phases, [
    "previsibility_audit",
    "visibility_approval",
    "post_visibility_readback",
    "finalize_launch_audit",
  ])
  assert.equal(deploymentContract.lifecycle.deployment_approval_phase, "deployment_approval")
  assert.equal(deploymentContract.lifecycle.post_deploy_qa_phase, "post_deploy_qa")
  const badOrder = structuredClone(deploymentContract.lifecycle)
  badOrder.phases.find(/** @param {any} phase */ (phase) => phase.id === "visibility_approval").order = 45
  assert.throws(() => assertPhaseGraph(badOrder), /order/)
  const cyclic = structuredClone(deploymentContract.lifecycle)
  cyclic.phases.find(/** @param {any} phase */ (phase) => phase.id === "previsibility_audit").depends_on = ["finalize_launch_audit"]
  assert.throws(() => assertPhaseGraph(cyclic), /cycle/)

  assertLaunchAuditBoundary(launchAudit)
  assert.equal(deploymentContract.approvals.deployment.authority, "github-pages environment required reviewer")
  assert(deploymentContract.approvals.deployment.recorded_in.includes("github-pages environment"))
  assert(!deploymentContract.approvals.deployment.recorded_in.includes("launch audit"))
  assert.equal(deploymentContract.lifecycle.phases.find(/** @param {any} phase */ (phase) => phase.id === "deployment_approval").authority, "github-pages environment required reviewer")
  assert.equal(deploymentContract.workflow.environment.name, "github-pages")
  assert.equal(deploymentContract.workflow.environment.review_is_deployment_approval, true)
  assert.equal(deploymentContract.workflow.jobs.deploy.environment, "github-pages")
  assert(deploymentContract.workflow.jobs.deploy.approval_recorded_in.includes("github-pages environment"))
  assert(deploymentContract.post_deploy_qa.authority.includes("after GitHub provider success"))
  assert.equal(deploymentContract.post_deploy_qa.phase, "post_deploy_qa")
  assert.equal(deploymentContract.post_deploy_qa.runs_after, "provider success")
  assert.deepEqual(deploymentContract.lifecycle.phases.find(/** @param {any} phase */ (phase) => phase.id === "post_deploy_qa").depends_on, ["deploy"])

  const catalog = await readJson(catalogPath)
  assert.equal(catalog.lifecycle.status, "superseded")
  assert.equal(catalog.lifecycle.deploy_authority, false)
  assert.equal(catalog.lifecycle.replacement, "config/github-launch-audit-v1.schema.json")
  assert.equal(catalog.required_surfaces.length, 31)
  assert(catalog.required_surfaces.every(/** @param {any} surface */ (surface) => surface.lifecycle === "superseded"))
})

test("T12 records the single eyeyesight account and operational correlation boundary", async () => {
  const deploymentContract = await readJson(deploymentContractPath)
  assert.deepEqual(deploymentContract.trust_boundary.github_account_model, {
    mode: "single-owner-account",
    github_login: "eyeyesight",
    operator_role: "Arke",
    approver_role: "Tyler",
    prevent_self_review: false,
    correlation_evidence: [
      "workflow_run_id",
      "run_started_at",
      "environment_reviewed_at",
      "Telegram decision reference",
    ],
    limitation: "GitHub records only the same eyeyesight account and cannot prove Arke/Tyler role separation; compromise of the eyeyesight account can simultaneously initiate and approve both human decisions.",
  })
  assert.equal(deploymentContract.workflow.environment.required_reviewers, true)
  assert.equal(deploymentContract.workflow.environment.prevent_self_review, false)
  assert.equal(deploymentContract.approvals.deployment.prevent_self_review, false)

  const activeProsePaths = [
    path.join(repoRoot, "docs", "adr", "0002-github-pages-deployment-and-public-exposure.md"),
    path.join(repoRoot, "docs", "github-pages-operator-runbook.md"),
    path.join(repoRoot, "specs", "ticket-breakdown-proposal.md"),
    path.join(repoRoot, "specs", "tyler-vault-reading-site.md"),
  ]
  const activeProse = (await Promise.all(activeProsePaths.map((filePath) => readFile(filePath, "utf8")))).join("\\n")
  assert.doesNotMatch(activeProse, /independent GitHub identity/i)
  assert.doesNotMatch(activeProse, /prevents self-review/i)
  assert.doesNotMatch(activeProse, /(?:required|requires|must)[^\\n.]{0,80}prevent[- ]self[- ]review/i)
})

test("Wave C migration has no legacy exposure implementation or test paths", async () => {
  const legacyExposurePaths = [
    "lib/github-public-exposure-gate.mjs",
    "lib/github-readonly-evidence-transport.mjs",
    "tests/github-public-exposure-gate.test.mjs",
    "tests/github-readonly-evidence-transport.test.mjs",
    "lib/pages-provider-lifecycle.mjs",
    "tests/support/scripted-local-pages-provider.mjs",
  ]
  for (const relativePath of legacyExposurePaths) {
    assert.equal(await pathExists(path.join(repoRoot, relativePath)), false, `legacy exposure path remains: ${relativePath}`)
  }
})

test("Wave C Pages façade has no lifecycle, provider, rollback, or opaque deploy-authority exports", async () => {
  const facade = await import("../lib/pages-deployment-contract.mjs")
  assert.deepEqual(Object.keys(facade).sort(), ["createSyntheticProjectSiteServer", "normalizeBasePath"])
  for (const legacyExport of [
    "PagesContractError",
    "PagesProviderError",
    "loadT12DeploymentAuthority",
    "rollbackPagesDeployment",
    "runBoundedPagesDeployment",
    "safeReadback",
    "verifiedSealedReleaseIdentity",
  ]) assert.equal(Object.hasOwn(facade, legacyExport), false, `legacy façade export remains: ${legacyExport}`)
})

test("H2 deployment approval stays in GitHub environment/deployment records and never in release or sealed receipt text", async () => {
  const paths = [
    path.join(repoRoot, "config", "github-pages-deployment-contract-v1.json"),
    path.join(repoRoot, "docs", "adr", "0002-github-pages-deployment-and-public-exposure.md"),
    path.join(repoRoot, "specs", "ticket-breakdown-proposal.md"),
    path.join(repoRoot, "specs", "tyler-vault-reading-site.md"),
    path.join(repoRoot, "docs", "github-pages-operator-runbook.md"),
  ]
  const text = await Promise.all(paths.map((filePath) => readFile(filePath, "utf8")))
  assert.match(text.join("\n"), /never mutate(?:s)? the sealed (?:release|receipt)|without mutating the sealed receipt/i)
  assert.doesNotMatch(text.join("\n"), /deployment approval[^\n]{0,120}(?:release|sealed) receipt/i)
  assert.doesNotMatch(text.join("\n"), /approval_recorded_in[^\n]{0,120}release receipt/i)
})
