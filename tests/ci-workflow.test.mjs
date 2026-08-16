// @ts-nocheck -- workflow YAML is parsed and checked as a static public contract.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { parse as parseYaml } from "yaml"

const repoRoot = path.resolve(import.meta.dirname, "..")
const workflowPath = path.join(repoRoot, ".github", "workflows", "ci.yml")

const expectedPins = new Map([
  ["actions/checkout", { sha: "11bd71901bbe5b1630ceea73d27597364c9af683", version: "v4.2.2" }],
  ["actions/setup-node", { sha: "49933ea5288caeca8642d1e84afbd3f7d6820020", version: "v4.4.0" }],
])

let workflowText
let workflow

test.before(async () => {
  workflowText = await readFile(workflowPath, "utf8")
  workflow = parseYaml(workflowText)
})

function job() {
  return workflow.jobs.ci
}

function steps() {
  return job().steps
}

function stepNamed(name) {
  const step = steps().find((candidate) => candidate.name === name)
  assert(step, `missing CI step: ${name}`)
  return step
}

function runText(step) {
  assert.equal(typeof step.run, "string", `${step.name ?? "unnamed step"} must be a shell step`)
  return step.run
}

test("CI keeps the pull-request and manual dispatch events with the existing acceptance check", () => {
  assert.equal(workflow.name, "CI")
  assert.deepEqual(Object.keys(workflow.on), ["pull_request", "workflow_dispatch"])
  assert.deepEqual(workflow.permissions, { contents: "read" })
  assert.equal(job().name, "CI")
})

test("Checkout selects the exact pull-request head and uses only a bounded dispatch fallback", () => {
  const checkout = steps().find((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"))
  assert(checkout, "missing actions/checkout")
  assert.equal(checkout.with["persist-credentials"], false)
  const ref = checkout.with.ref
  assert.equal(typeof ref, "string")
  assert.match(ref, /github\.event_name\s*==\s*['"]pull_request['"]|github\.event_name\s*==\s*'pull_request'/)
  assert.match(ref, /github\.event\.pull_request\.head\.sha/)
  assert.match(ref, /github\.sha/)
  assert.doesNotMatch(ref, /github\.event\.pull_request\.(?:merge_commit_sha|base\.sha)/)
  assert.doesNotMatch(ref, /\$\{\{\s*inputs\.|github\.ref\b/)
})

test("Trusted PR-head assertion runs before dependency installation and CI", () => {
  const headStep = stepNamed("Verify exact pull-request head checkout")
  assert.deepEqual(headStep.env, {
    EVENT_NAME: "${{ github.event_name }}",
    PR_HEAD_SHA: "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || '' }}",
  })
  const headRun = runText(headStep)
  assert.match(headRun, /if\s+\[\[\s*"\$EVENT_NAME"\s*==\s*"pull_request"\s*\]\];\s*then/)
  assert.match(headRun, /\[\[\s*!\s*"\$PR_HEAD_SHA"\s*=~\s*\^\[0-9a-f\]\{40\}\$\s*\]\]/)
  assert.match(headRun, /test\s+"\$\(git rev-parse HEAD\)"\s*=\s*"\$PR_HEAD_SHA"/)
  assert.match(headRun, /elif\s+\[\[\s*"\$EVENT_NAME"\s*==\s*"workflow_dispatch"\s*\]\];\s*then/)
  assert.match(headRun, /test\s+-z\s+"\$PR_HEAD_SHA"/)
  assert.match(headRun, /else\s*\n\s*printf .*unsupported event/i)
  assert.doesNotMatch(headRun, /\$\{\{\s*(?:github\.event|github\.sha|inputs\.)/)

  const headIndex = steps().indexOf(headStep)
  const installIndex = steps().findIndex((step) => typeof step.run === "string" && /npm ci/.test(step.run))
  const ciIndex = steps().findIndex((step) => typeof step.run === "string" && /(?:node --test|npm test|npm run typecheck)/.test(step.run))
  assert(headIndex >= 0 && headIndex < installIndex, "PR-head proof must precede dependency installation")
  assert(headIndex >= 0 && headIndex < ciIndex, "PR-head proof must precede CI")
})

test("CI actions remain immutable official pins with comments and checkout credentials disabled", () => {
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

  const checkout = steps().find((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"))
  assert.equal(checkout.with["persist-credentials"], false)
})

test("No shell step interpolates caller-controlled input or a synthetic merge ref", () => {
  assert.doesNotMatch(workflowText, /github\.event\.pull_request\.merge_commit_sha/)
  assert.doesNotMatch(workflowText, /refs\/pull\//)
  for (const step of steps()) {
    if (typeof step.run !== "string") continue
    assert.doesNotMatch(step.run, /\$\{\{\s*(?:inputs\.|github\.ref\b|github\.event\.pull_request\.(?:head|base|merge_commit_sha))/)
  }
})

test("CI runs the retained Pages workflow contract inside the bounded site suite", () => {
  const site = stepNamed("Build and verify the slim production site")
  const command = runText(site).trim()
  assert.equal(command, [
    "node --test",
    "tests/slim-build.test.mjs",
    "tests/prepare-gh-pages-commit.test.mjs",
    "tests/github-pages-workflow.test.mjs",
  ].join(" "))
})

test("CI uses a bounded publication acceptance suite instead of the repository-wide test scan", () => {
  const acceptance = stepNamed("Run the bounded publication and headless browser acceptance suite")
  const command = runText(acceptance).trim()
  assert.equal(command, [
    "node --test --test-concurrency=1",
    "tests/vault-papernote-publish-cli.test.mjs",
    "tests/site-headless-qa.test.mjs",
    "tests/vault-papernote-site-cli.test.mjs",
  ].join(" "))
  assert.doesNotMatch(command, /\bnpm test\b|node --test(?:\s+--test-concurrency=1)?\s*$/)
})
