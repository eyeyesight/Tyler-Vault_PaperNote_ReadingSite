// @ts-nocheck -- static YAML and Markdown fixtures are validated at runtime.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { parse as parseYaml } from "yaml"

const repoRoot = path.resolve(import.meta.dirname, "..")
const workflowPath = path.join(repoRoot, ".github", "workflows", "deploy-pages.yml")
const contractPath = path.join(repoRoot, "config", "github-pages-deployment-contract-v1.json")
const runbookPath = path.join(repoRoot, "docs", "github-pages-operator-runbook.md")

const expectedPins = new Map([
  ["actions/checkout", { sha: "11bd71901bbe5b1630ceea73d27597364c9af683", version: "v4.2.2" }],
  ["actions/setup-node", { sha: "49933ea5288caeca8642d1e84afbd3f7d6820020", version: "v4.4.0" }],
  ["actions/configure-pages", { sha: "983d7736d9b0ae728b81ab479565c72886d7745b", version: "v5.0.0" }],
  ["actions/upload-pages-artifact", { sha: "56afc609e74202658d3ffba0e8f6dda462b719fa", version: "v3.0.1" }],
  ["actions/deploy-pages", { sha: "d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e", version: "v4.0.5" }],
])

let workflowText
let workflow
let contract
let runbookText

test.before(async () => {
  workflowText = await readFile(workflowPath, "utf8")
  workflow = parseYaml(workflowText)
  contract = JSON.parse(await readFile(contractPath, "utf8"))
  runbookText = await readFile(runbookPath, "utf8")
})

function validateJob() {
  return workflow.jobs.validate
}

function validateSteps() {
  return validateJob().steps
}

function stepNamed(name) {
  const step = validateSteps().find((candidate) => candidate.name === name)
  assert(step, `missing validate step: ${name}`)
  return step
}

function runText(step) {
  assert.equal(typeof step.run, "string", `${step.name ?? "unnamed step"} must be a shell step`)
  return step.run
}

test("Pages workflow is manual-only, requires all exact inputs, and has a literal main-only gate", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"])
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["site_commit", "candidate_digest", "launch_audit_digest"])
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.site_commit, {
    description: "Exact lowercase 40-hex commit from refs/heads/gh-pages",
    required: true,
    type: "string",
  })
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.candidate_digest, {
    description: "Expected lowercase 64-hex candidate digest",
    required: true,
    type: "string",
  })
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.launch_audit_digest, {
    description: "Expected lowercase 64-hex launch-audit digest",
    required: true,
    type: "string",
  })

  const gate = stepNamed("Enforce main-only dispatch")
  assert.deepEqual(gate.env, {
    DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
    WORKFLOW_REF: "${{ github.ref }}",
  })
  const gateRun = runText(gate)
  assert.match(gateRun, /\[\[\s*"\$WORKFLOW_REF"\s*!=\s*"refs\/heads\/main"\s*\|\|\s*"\$DEFAULT_BRANCH"\s*!=\s*"main"\s*\]\]/)
  assert.match(gateRun, /refs\/heads\/main/)
  assert.match(gateRun, /default branch must be main/i)
  assert.equal(validateJob().if, undefined, "validate must execute its hard-fail gate rather than silently skip")
  assert.equal(workflow.jobs.deploy.if, "github.ref == 'refs/heads/main' && github.event.repository.default_branch == 'main'")
  assert.doesNotMatch(workflowText, /format\(\s*['"]refs\/heads\//)
  for (const forbiddenTrigger of ["push", "pull_request", "pull_request_target", "repository_dispatch", "schedule"]) {
    assert.doesNotMatch(workflowText, new RegExp(`^\\s{0,4}${forbiddenTrigger}:`, "m"), `forbidden trigger: ${forbiddenTrigger}`)
  }
})

test("Every action is an official immutable commit pin with a version comment", () => {
  const usesLines = [...workflowText.matchAll(/^\s+uses:\s+([^\s#]+)(?:\s+#\s*(v[^\s]+))?\s*$/gm)]
  assert.equal(usesLines.length, expectedPins.size + 1, "checkout is intentionally used once for source and once for candidate")
  for (const [, reference, version] of usesLines) {
    const match = reference.match(/^([^@]+)@([0-9a-f]{40})$/)
    assert(match, `action reference is not an immutable 40-hex pin: ${reference}`)
    const expected = expectedPins.get(match[1])
    assert(expected, `unapproved action: ${match[1]}`)
    assert.equal(match[2], expected.sha, `unexpected pin for ${match[1]}`)
    assert.equal(version, expected.version, `missing/version-mismatched comment for ${match[1]}`)
  }
})

test("Inputs are validated as shell environment values before either candidate checkout or verifier use", () => {
  const steps = validateSteps()
  const inputStep = stepNamed("Validate workflow inputs")
  assert.deepEqual(inputStep.env, {
    SITE_COMMIT: "${{ inputs.site_commit }}",
    CANDIDATE_DIGEST: "${{ inputs.candidate_digest }}",
    LAUNCH_AUDIT_DIGEST: "${{ inputs.launch_audit_digest }}",
  })
  const inputRun = runText(inputStep)
  assert.match(inputRun, /\[\[\s*!\s*"\$SITE_COMMIT"\s*=~\s*\^\[0-9a-f\]\{40\}\$\s*\]\]/)
  assert.match(inputRun, /\[\[\s*!\s*"\$CANDIDATE_DIGEST"\s*=~\s*\^\[0-9a-f\]\{64\}\$\s*\]\]/)
  assert.match(inputRun, /\[\[\s*!\s*"\$LAUNCH_AUDIT_DIGEST"\s*=~\s*\^\[0-9a-f\]\{64\}\$\s*\]\]/)
  assert.doesNotMatch(inputRun, /\$\{\{\s*inputs\./)

  const inputIndex = steps.indexOf(inputStep)
  const candidateCheckoutIndex = steps.findIndex((step) => step.with?.path === "candidate")
  const verifierIndex = steps.findIndex((step) => step.name === "Verify and stage candidate")
  assert(inputIndex < candidateCheckoutIndex)
  assert(inputIndex < verifierIndex)
})

test("Validation checks out the workflow commit first and installs from source", () => {
  const steps = validateSteps()
  const checkoutSteps = steps.filter((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"))
  assert.equal(checkoutSteps.length, 2)
  assert.deepEqual(checkoutSteps[0].with, {
    "fetch-depth": 1,
    path: "source",
    "persist-credentials": false,
    ref: "${{ github.sha }}",
  })

  const npmStep = steps.find((step) => step.name === "Install source dependencies")
  assert(npmStep)
  assert.equal(npmStep["working-directory"], "source")
  assert.equal(runText(npmStep).trim(), "npm ci")
})

test("Candidate checkout is exact, credential-free, and proves containment in gh-pages only", () => {
  const checkoutSteps = validateSteps().filter((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"))
  assert.deepEqual(checkoutSteps[1].with, {
    "fetch-depth": 1,
    path: "candidate",
    "persist-credentials": false,
    ref: "${{ inputs.site_commit }}",
    repository: "${{ github.repository }}",
  })

  const containmentStep = stepNamed("Prove site_commit is from gh-pages")
  assert.deepEqual(containmentStep.env, { SITE_COMMIT: "${{ inputs.site_commit }}" })
  const containmentRun = runText(containmentStep)
  assert.match(containmentRun, /test\s+"\$\(git rev-parse HEAD\)"\s*=\s*"\$SITE_COMMIT"/)
  assert.match(containmentRun, /git fetch --no-tags --prune --unshallow origin \+refs\/heads\/gh-pages:refs\/remotes\/origin\/gh-pages/)
  assert.match(containmentRun, /git rev-parse --verify "\$SITE_COMMIT\^\{commit\}"/)
  assert.match(containmentRun, /git merge-base --is-ancestor "\$SITE_COMMIT" refs\/remotes\/origin\/gh-pages/)
  assert.doesNotMatch(containmentRun, /refs\/heads\/(?!gh-pages\b)[A-Za-z0-9._/-]+/)
  assert.doesNotMatch(containmentRun, /\$\{\{\s*inputs\.site_commit\s*\}\}/)
})

test("G3 verification requires both expected digests, the launch audit, and one fresh RUNNER_TEMP stage", () => {
  const verifierStep = stepNamed("Verify and stage candidate")
  assert.equal(verifierStep["working-directory"], "source")
  assert.deepEqual(verifierStep.env, {
    EXPECTED_CANDIDATE_DIGEST: "${{ inputs.candidate_digest }}",
    EXPECTED_LAUNCH_AUDIT_DIGEST: "${{ inputs.launch_audit_digest }}",
  })
  const verifierRun = runText(verifierStep)
  assert.match(verifierRun, /stage_parent="\$\(mktemp\s+-d\s+"\$\{RUNNER_TEMP\}\/github-pages-site\.XXXXXX"\)"/)
  assert.match(verifierRun, /stage_root="\$\{stage_parent\}\/site"/)
  assert.match(verifierRun, /test\s+!\s+-e\s+"\$stage_root"/)
  assert(verifierRun.indexOf('test ! -e "$stage_root"') < verifierRun.indexOf("node scripts/verify-gh-pages-candidate.mjs"))
  assert.match(verifierRun, /node scripts\/verify-gh-pages-candidate\.mjs \\\n\s+--candidate-root \.\.\/candidate \\\n\s+--expected-candidate-digest "\$EXPECTED_CANDIDATE_DIGEST" \\\n\s+--expected-launch-audit-digest "\$EXPECTED_LAUNCH_AUDIT_DIGEST" \\\n\s+--require-launch-audit \\\n\s+--stage-output "\$stage_root"/)
  assert.match(verifierRun, /PAGES_STAGE_DIR=%s.*"\$stage_root".*GITHUB_ENV/s)
  assert.match(verifierRun, /test\s+-d\s+"\$stage_root"/)
  assert.doesNotMatch(verifierRun, /verify-gh-pages-candidate\.mjs\s+\.\.\/candidate(?!\s+\\)/)
})

test("Fixed summary exposes the three GitHub-authenticated values before environment approval", () => {
  const summaryStep = stepNamed("Record validated approval inputs")
  assert.deepEqual(summaryStep.env, {
    SITE_COMMIT: "${{ inputs.site_commit }}",
    CANDIDATE_DIGEST: "${{ inputs.candidate_digest }}",
    LAUNCH_AUDIT_DIGEST: "${{ inputs.launch_audit_digest }}",
  })
  const summaryRun = runText(summaryStep)
  assert.match(summaryRun, /GITHUB_STEP_SUMMARY/)
  assert.match(summaryRun, /## GitHub Pages candidate approval inputs/)
  assert.match(summaryRun, /\| `site_commit` \| `%s` \|/)
  assert.match(summaryRun, /\| `candidate_digest` \| `%s` \|/)
  assert.match(summaryRun, /\| `launch_audit_digest` \| `%s` \|/)
  assert.match(summaryRun, /Telegram\/out-of-band approved digest/i)
  assert.match(summaryRun, /github-pages environment/i)
  assert.equal(summaryStep, validateSteps()[validateSteps().findIndex((step) => step.name === "Verify and stage candidate") + 1])
  assert.doesNotMatch(workflowText, /^\s+outputs:/m)
  assert.doesNotMatch(workflowText, /::set-output|custom\s+(?:claim|token|signature)/i)
})

test("Only the verified staged directory is configured and uploaded, with no site build or mutation", () => {
  const steps = validateSteps()
  const verifierIndex = steps.findIndex((step) => step.name === "Verify and stage candidate")
  const configureIndex = steps.findIndex((step) => step.name === "Configure GitHub Pages")
  const uploadIndex = steps.findIndex((step) => step.name === "Upload staged Pages site")
  assert(verifierIndex >= 0 && configureIndex > verifierIndex && uploadIndex > configureIndex)

  const configureStep = steps[configureIndex]
  assert.match(configureStep.uses, /^actions\/configure-pages@[0-9a-f]{40}$/)
  const uploadSteps = steps.filter((step) => typeof step.uses === "string" && step.uses.startsWith("actions/upload-pages-artifact@"))
  assert.equal(uploadSteps.length, 1)
  assert.deepEqual(uploadSteps[0].with, { path: "${{ env.PAGES_STAGE_DIR }}" })
  assert.doesNotMatch(workflowText, /npm\s+run\s+(?:build|preflight)|quartz/i)
  assert.doesNotMatch(workflowText, /\bgit\s+(?:push|pull)\b/)
  assert.doesNotMatch(workflowText, /\b(?:claim|retry|rollback)\b/i)
})

test("Workflow root, validate, and deploy permissions match the machine contract at their actual scopes", () => {
  assert.deepEqual(workflow.permissions, contract.workflow.permissions.root)
  assert.deepEqual(validateJob().permissions, contract.workflow.permissions.validate)
  assert.deepEqual(workflow.jobs.deploy.permissions, contract.workflow.permissions.deploy)
  assert.deepEqual(workflow.permissions, { contents: "read" })
  assert.deepEqual(validateJob().permissions, { contents: "read", pages: "write" })
  assert.deepEqual(workflow.jobs.deploy.permissions, {
    contents: "read",
    pages: "write",
    "id-token": "write",
  })
})

test("Deploy waits for validation, uses the Pages environment output, and keeps the main-only condition", () => {
  const deploy = workflow.jobs.deploy
  assert.equal(deploy.needs, "validate")
  assert.equal(deploy["runs-on"], "ubuntu-latest")
  assert.equal(deploy.if, "github.ref == 'refs/heads/main' && github.event.repository.default_branch == 'main'")
  assert.deepEqual(deploy.environment, {
    name: "github-pages",
    url: "${{ steps.deployment.outputs.page_url }}",
  })
  const deploySteps = deploy.steps.filter((step) => typeof step.uses === "string" && step.uses.startsWith("actions/deploy-pages@"))
  assert.equal(deploySteps.length, 1)
  assert.equal(deploySteps[0].id, "deployment")
  assert.deepEqual(workflow.concurrency, {
    "cancel-in-progress": false,
    group: "github-pages",
  })
})

test("Workflow has no secret, broad-write, untrusted-PR, or shell-injection escape hatch", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" })
  assert.doesNotMatch(workflowText, /secrets\./)
  assert.doesNotMatch(workflowText, /contents:\s*write/)
  assert.doesNotMatch(workflowText, /actions\/upload-artifact@/)
  assert.doesNotMatch(workflowText, /pull_request_target|repository_dispatch|workflow_run|schedule:/)
  assert.doesNotMatch(workflowText, /\b(?:eval|bash\s+-c|sh\s+-c)\b/)
  assert.doesNotMatch(workflowText, /curl[^\n]*\|\s*(?:sh|bash)/i)
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== "string") continue
      assert.doesNotMatch(step.run, /\$\{\{\s*inputs\.(?:site_commit|candidate_digest|launch_audit_digest)\s*\}\}/, `${jobId}/${step.name ?? "unnamed"} interpolates input in shell`)
    }
  }
})

test("Operator runbook preserves the required human/provider handoffs and digest authority boundary", () => {
  for (const requiredText of [
    "gh-pages",
    "visibility audit",
    "approval",
    "readback",
    "final audit",
    "Arke",
    "exact SHA",
    "Tyler",
    "github-pages",
    "provider",
    "browser QA",
    "hotfix",
    "reseal",
    "revalidate",
    "slug",
    "search",
    "graph",
    "source build",
    "unknown",
    "candidate_digest",
    "launch_audit_digest",
    "Telegram",
    "out-of-band",
    "isolated worktree",
    "site/",
    ".publication/",
  ]) assert.match(runbookText, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), `runbook missing: ${requiredText}`)
  assert.match(runbookText, /compare[\s\S]{0,180}(?:candidate_digest|launch_audit_digest)[\s\S]{0,180}(?:Telegram|out-of-band)/i)
  assert.match(runbookText, /do not[\s\S]{0,100}(?:switch|use)[\s\S]{0,100}shared[\s\S]{0,100}worktree/i)
})

test("Operator runbook names the shared account roles and run/time/Telegram correlation", () => {
  assert.match(runbookText, /same GitHub account:\s*`eyeyesight`/i)
  assert.match(runbookText, /Arke[^\n]{0,120}(?:prepare|dispatch)/i)
  assert.match(runbookText, /Tyler[^\n]{0,160}(?:visibility|deployment)[^\n]{0,160}(?:decision|approval)/i)
  assert.match(runbookText, /GitHub records both[^\n]{0,100}eyeyesight/i)
  assert.match(runbookText, /workflow_run_id[\s\S]{0,160}run_started_at[\s\S]{0,160}environment_reviewed_at[\s\S]{0,160}Telegram/i)
  assert.match(runbookText, /self-review prevention is disabled/i)
  assert.doesNotMatch(runbookText, /independent GitHub identity/i)
  assert.doesNotMatch(runbookText, /prevents self-review/i)
})
