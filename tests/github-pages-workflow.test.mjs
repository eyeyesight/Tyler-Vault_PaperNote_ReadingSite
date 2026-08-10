// @ts-nocheck -- workflow YAML is parsed and checked as a static public contract.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { parse as parseYaml } from "yaml"

const repoRoot = path.resolve(import.meta.dirname, "..")
const workflowPath = path.join(repoRoot, ".github", "workflows", "deploy-pages.yml")

const expectedPins = new Map([
  ["actions/checkout", { sha: "11bd71901bbe5b1630ceea73d27597364c9af683", version: "v4.2.2" }],
  ["actions/configure-pages", { sha: "983d7736d9b0ae728b81ab479565c72886d7745b", version: "v5.0.0" }],
  ["actions/upload-pages-artifact", { sha: "56afc609e74202658d3ffba0e8f6dda462b719fa", version: "v3.0.1" }],
  ["actions/deploy-pages", { sha: "d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e", version: "v4.0.5" }],
])

let workflowText
let workflow

test.before(async () => {
  workflowText = await readFile(workflowPath, "utf8")
  workflow = parseYaml(workflowText)
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

test("Pages workflow is manual-only and accepts exact site_commit and publication_mode inputs", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"])
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["site_commit", "publication_mode"])
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.site_commit, {
    description: "Exact lowercase 40-hex commit from refs/heads/gh-pages",
    required: true,
    type: "string",
  })
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.publication_mode, {
    default: "routine",
    description: "Select routine publication or rollback mode",
    options: ["routine", "rollback"],
    required: true,
    type: "choice",
  })
  assert.doesNotMatch(workflowText, /candidate_digest|launch_audit_digest|launch audit/i)
  for (const forbiddenTrigger of ["push", "pull_request", "pull_request_target", "repository_dispatch", "schedule"]) {
    assert.doesNotMatch(workflowText, new RegExp(`^\\s{0,4}${forbiddenTrigger}:`, "m"), `forbidden trigger: ${forbiddenTrigger}`)
  }
})

test("Pages run-name retains the full exact site commit and publication mode", () => {
  assert.equal(workflow["run-name"], "Deploy GitHub Pages ${{ inputs.site_commit }} (${{ inputs.publication_mode }})")
})

test("Every action is an official immutable commit pin with a version comment", () => {
  const usesLines = [...workflowText.matchAll(/^\s+uses:\s+([^\s#]+)(?:\s+#\s*(v[^\s]+))?\s*$/gm)]
  assert.equal(usesLines.length, expectedPins.size)
  for (const [, reference, version] of usesLines) {
    const match = reference.match(/^([^@]+)@([0-9a-f]{40})$/)
    assert(match, `action reference is not an immutable 40-hex pin: ${reference}`)
    const expected = expectedPins.get(match[1])
    assert(expected, `unapproved action: ${match[1]}`)
    assert.equal(match[2], expected.sha, `unexpected pin for ${match[1]}`)
    assert.equal(version, expected.version, `missing/version-mismatched comment for ${match[1]}`)
  }
})

test("Main-only dispatch and exact input validation run before candidate checkout", () => {
  const steps = validateSteps()
  const gate = stepNamed("Enforce main-only dispatch")
  assert.deepEqual(gate.env, {
    DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
    WORKFLOW_REF: "${{ github.ref }}",
  })
  const gateRun = runText(gate)
  assert.match(gateRun, /\[\[\s*"\$WORKFLOW_REF"\s*!=\s*"refs\/heads\/main"\s*\|\|\s*"\$DEFAULT_BRANCH"\s*!=\s*"main"\s*\]\]/)
  assert.match(gateRun, /default branch must be main/i)
  assert.equal(validateJob().if, undefined, "validate must execute its hard-fail gate rather than silently skip")
  assert.equal(workflow.jobs.deploy.if, "github.ref == 'refs/heads/main' && github.event.repository.default_branch == 'main'")

  const inputStep = stepNamed("Validate site_commit")
  assert.deepEqual(inputStep.env, {
    PUBLICATION_MODE: "${{ inputs.publication_mode }}",
    SITE_COMMIT: "${{ inputs.site_commit }}",
  })
  const inputRun = runText(inputStep)
  assert.match(inputRun, /\[\[\s*!\s*"\$SITE_COMMIT"\s*=~\s*\^\[0-9a-f\]\{40\}\$\s*\]\]/)
  assert.match(inputRun, /\[\[\s*"\$PUBLICATION_MODE"\s*!=\s*"routine"\s*&&\s*"\$PUBLICATION_MODE"\s*!=\s*"rollback"\s*\]\]/)
  assert.doesNotMatch(inputRun, /\$\{\{\s*inputs\./)
  const inputIndex = steps.indexOf(inputStep)
  const checkoutIndex = steps.findIndex((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"))
  assert(inputIndex < checkoutIndex)
})

test("Candidate checkout uses the exact SHA credential-free and selects routine or rollback authority", () => {
  const checkoutSteps = validateSteps().filter((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"))
  assert.equal(checkoutSteps.length, 1)
  assert.deepEqual(checkoutSteps[0].with, {
    repository: "${{ github.repository }}",
    ref: "${{ inputs.site_commit }}",
    "fetch-depth": 1,
    path: "candidate",
    "persist-credentials": false,
  })

  const verify = stepNamed("Verify exact gh-pages site")
  assert.equal(verify["working-directory"], "candidate")
  assert.deepEqual(verify.env, {
    PUBLICATION_MODE: "${{ inputs.publication_mode }}",
    SITE_COMMIT: "${{ inputs.site_commit }}",
  })
  const verifyRun = runText(verify)
  assert.match(verifyRun, /test\s+"\$\(git rev-parse HEAD\)"\s*=\s*"\$SITE_COMMIT"/)
  const fetchCommand = "git fetch --no-tags --prune --unshallow origin +refs/heads/gh-pages:refs/remotes/origin/gh-pages"
  assert.match(verifyRun, new RegExp(fetchCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(verifyRun, /git rev-parse --verify refs\/remotes\/origin\/gh-pages\^\{commit\}/)
  assert.match(verifyRun, /git rev-parse --verify "\$SITE_COMMIT\^\{commit\}"/)
  assert.match(verifyRun, /if\s+\[\[\s*"\$PUBLICATION_MODE"\s*==\s*"routine"\s*\]\];\s*then/)
  assert.match(verifyRun, /test\s+"\$\(git rev-parse refs\/remotes\/origin\/gh-pages\)"\s*=\s*"\$SITE_COMMIT"/)
  assert.match(verifyRun, /elif\s+\[\[\s*"\$PUBLICATION_MODE"\s*==\s*"rollback"\s*\]\];\s*then/)
  assert.match(verifyRun, /git merge-base --is-ancestor "\$SITE_COMMIT" refs\/remotes\/origin\/gh-pages/)
  const fetchIndex = verifyRun.indexOf(fetchCommand)
  const authorityIndex = verifyRun.indexOf('if [[ "$PUBLICATION_MODE" == "routine" ]]')
  assert(fetchIndex >= 0 && authorityIndex > fetchIndex, "gh-pages must be fetched before authority selection")
})

test("Routine and rollback authority selection rejects every other mode", () => {
  const verifyRun = runText(stepNamed("Verify exact gh-pages site"))
  assert.match(verifyRun, /else\s*\n\s*printf '%s\\n' 'publication_mode must be routine or rollback' >&2\s*\n\s*exit 1/)
})

test("Validation requires index, real 404, and empty .nojekyll without mutating candidate bytes", () => {
  const verifyRun = runText(stepNamed("Verify exact gh-pages site"))
  assert.match(verifyRun, /test\s+-d\s+site/)
  assert.match(verifyRun, /test\s+-f\s+site\/index\.html/)
  assert.match(verifyRun, /test\s+-f\s+site\/404\.html/)
  assert.match(verifyRun, /test\s+-f\s+site\/\.nojekyll/)
  assert.match(verifyRun, /test\s+!\s+-s\s+site\/\.nojekyll/)
  assert.doesNotMatch(verifyRun, /\b(?:cp|mv|rm|mkdir|touch|truncate)\b/)
  assert.doesNotMatch(workflowText, /\b(?:npm|node|setup-node|verify-gh-pages-candidate|quartz)\b/i)
  assert.doesNotMatch(workflowText, /\b(?:git\s+push|git\s+pull)\b/)
})

test("Only candidate/site is configured and uploaded after validation", () => {
  const steps = validateSteps()
  const verifyIndex = steps.findIndex((step) => step.name === "Verify exact gh-pages site")
  const configureIndex = steps.findIndex((step) => step.name === "Configure GitHub Pages")
  const uploadIndex = steps.findIndex((step) => step.name === "Upload exact Pages site")
  assert(verifyIndex >= 0 && configureIndex > verifyIndex && uploadIndex > configureIndex)
  assert.deepEqual(steps[uploadIndex].with, { path: "candidate/site" })
  assert.doesNotMatch(workflowText, /PAGES_STAGE_DIR|stage_parent|stage_root|GITHUB_ENV|source\//)
})

test("Workflow keeps least permissions, protected environment, and retry-by-redispatch concurrency", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" })
  assert.deepEqual(validateJob().permissions, { contents: "read", pages: "write" })
  assert.deepEqual(workflow.jobs.deploy.permissions, {
    contents: "read",
    pages: "write",
    "id-token": "write",
  })
  const deploy = workflow.jobs.deploy
  assert.equal(deploy.needs, "validate")
  assert.equal(deploy["runs-on"], "ubuntu-latest")
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

test("Workflow has no metadata digest, secret, broad-write, or shell-injection escape hatch", () => {
  assert.doesNotMatch(workflowText, /secrets\.|contents:\s*write|actions\/upload-artifact@/)
  assert.doesNotMatch(workflowText, /pull_request_target|repository_dispatch|workflow_run|schedule:/)
  assert.doesNotMatch(workflowText, /\b(?:eval|bash\s+-c|sh\s+-c)\b/)
  assert.doesNotMatch(workflowText, /curl[^\n]*\|\s*(?:sh|bash)/i)
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== "string") continue
      assert.doesNotMatch(step.run, /\$\{\{\s*inputs\.site_commit\s*\}\}/, `${jobId}/${step.name ?? "unnamed"} interpolates input in shell`)
    }
  }
})
