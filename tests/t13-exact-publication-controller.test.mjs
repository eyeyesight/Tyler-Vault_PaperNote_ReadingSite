import assert from "node:assert/strict"
import test from "node:test"

import {
  hashFileInventory,
  hashPublicProjection,
  hashRouteInventory,
  hashSiteTree,
  runExactPublication,
} from "../lib/exact-publication-controller.mjs"

/**
 * @typedef {Record<string, unknown>} UnknownRecord
 * @typedef {Object} FrozenInput
 * @property {string} vault_export_sha256
 * @property {string} source_main_sha
 * @property {string} policy_version
 * @property {string} expected_gh_pages_sha
 * @property {string} workflow_sha
 * @typedef {Object} Operation
 * @property {string} operation_id
 * @property {FrozenInput} frozen_input
 * @typedef {Object} TestFile
 * @property {string} path
 * @property {string | Uint8Array} bytes
 * @property {string} [mode]
 * @typedef {Object} Candidate
 * @property {TestFile[]} files
 * @property {string[]} routes
 * @property {string} site_sha256
 * @property {string} route_inventory_sha256
 * @property {string} file_inventory_sha256
 * @property {UnknownRecord} [public_projection]
 * @property {string} [public_projection_sha256]
 * @typedef {Object} HarnessState
 * @property {string} gh_pages_sha
 * @property {string} site_sha256
 * @property {string} route_inventory_sha256
 * @property {string} file_inventory_sha256
 * @property {string} provider_site_commit
 * @property {string} live_site_sha256
 * @typedef {Object} HarnessOptions
 * @property {Candidate} [candidate]
 * @property {"old" | "new"} [current]
 * @property {"ok" | "lost-response"} [pushBehavior]
 * @property {"ok" | "lost-response"} [dispatchBehavior]
 */

/** @type {Operation} */
const operation = {
  operation_id: "0".repeat(31) + "1",
  frozen_input: {
    vault_export_sha256: "1".repeat(64),
    source_main_sha: "2".repeat(40),
    policy_version: "t13-policy-v1",
    expected_gh_pages_sha: "3".repeat(40),
    workflow_sha: "4".repeat(40),
  },
}

/**
 * @param {string} [operationId=operation.operation_id]
 * @param {string} [body="<html><body>new</body></html>"]
 * @returns {Candidate}
 */
function candidateFor(operationId = operation.operation_id, body = "<html><body>new</body></html>") {
  const files = [{ path: "index.html", bytes: body, mode: "100644" }]
  const routes = ["/"]
  const siteSha = hashSiteTree(files)
  const projection = {
    operation_id: operationId,
    site_sha256: siteSha,
    route_inventory_sha256: hashRouteInventory(routes),
    file_inventory_sha256: hashFileInventory(files),
  }
  return {
    files,
    routes,
    site_sha256: siteSha,
    route_inventory_sha256: projection.route_inventory_sha256,
    file_inventory_sha256: projection.file_inventory_sha256,
    public_projection: projection,
    public_projection_sha256: hashPublicProjection(projection),
  }
}

/**
 * @param {HarnessOptions} [options]
 * @returns {{calls: string[], dependencies: UnknownRecord, state: HarnessState}}
 */
function makeHarness({ candidate = candidateFor(), current = "old", pushBehavior = "ok", dispatchBehavior = "ok" } = {}) {
  const oldFiles = [{ path: "index.html", bytes: "<html><body>old</body></html>", mode: "100644" }]
  const oldRoutes = ["/"]
  const state = {
    gh_pages_sha: operation.frozen_input.expected_gh_pages_sha,
    site_sha256: hashSiteTree(oldFiles),
    route_inventory_sha256: hashRouteInventory(oldRoutes),
    file_inventory_sha256: hashFileInventory(oldFiles),
    provider_site_commit: operation.frozen_input.expected_gh_pages_sha,
    live_site_sha256: current === "new" ? candidate.site_sha256 : hashSiteTree(oldFiles),
  }
  /** @type {string[]} */
  const calls = []
  let listCalls = 0
  let runExists = false
  const remote = () => ({
    main_sha: operation.frozen_input.source_main_sha,
    workflow_sha: operation.frozen_input.workflow_sha,
    ...state,
  })
  const dependencies = {
    readAcceptedInputs: async () => {
      calls.push("accepted")
      return {
        vault_export_sha256: operation.frozen_input.vault_export_sha256,
        source_main_sha: operation.frozen_input.source_main_sha,
        policy_version: operation.frozen_input.policy_version,
      }
    },
    buildCandidate: async () => {
      calls.push("build")
      return candidate
    },
    readRemoteAuthority: async () => {
      calls.push("remote")
      return remote()
    },
    readLiveIdentity: async () => {
      calls.push("live")
      return {
        provider_site_commit: state.provider_site_commit,
        live_site_sha256: state.live_site_sha256,
        deployment_id: 88,
      }
    },
    createCandidateCommit: async (/** @type {UnknownRecord} */ input) => {
      calls.push("commit")
      assert.equal(input.expected_gh_pages_sha, operation.frozen_input.expected_gh_pages_sha)
      return { site_commit: "5".repeat(40), parent_sha: operation.frozen_input.expected_gh_pages_sha }
    },
    readCandidateCommit: async (/** @type {UnknownRecord} */ input) => {
      calls.push("candidate-readback")
      return { commit_sha: "5".repeat(40), site_sha256: input.site_sha256 }
    },
    pushGhPages: async () => {
      calls.push("push")
      state.gh_pages_sha = "5".repeat(40)
      state.site_sha256 = candidate.site_sha256
      state.route_inventory_sha256 = candidate.route_inventory_sha256
      state.file_inventory_sha256 = candidate.file_inventory_sha256
      state.provider_site_commit = "5".repeat(40)
      state.live_site_sha256 = candidate.site_sha256
      if (pushBehavior === "lost-response") throw new Error("connection closed")
    },
    listMatchingDeploymentRuns: async (/** @type {UnknownRecord} */ input) => {
      calls.push("list")
      listCalls += 1
      assert.equal(input.operation_id, operation.operation_id)
      assert.equal(input.site_commit, "5".repeat(40))
      assert.equal(Object.hasOwn(input, "publication_mode"), false)
      if (runExists || (dispatchBehavior === "lost-response" && listCalls >= 2)) {
        runExists = true
        return [{ id: 77, operation_id: operation.operation_id, site_commit: "5".repeat(40) }]
      }
      return []
    },
    dispatchDeployment: async (/** @type {UnknownRecord} */ input) => {
      calls.push("dispatch")
      assert.equal(input.workflow_sha, operation.frozen_input.workflow_sha)
      if (dispatchBehavior === "lost-response") {
        runExists = true
        throw new Error("response lost")
      }
      runExists = true
      return { accepted: true }
    },
    readDeploymentRun: async () => {
      calls.push("run-readback")
      return {
        id: 77,
        operation_id: operation.operation_id,
        site_commit: "5".repeat(40),
        workflow_sha: operation.frozen_input.workflow_sha,
        status: "completed",
        conclusion: "success",
      }
    },
    readPagesDeployment: async () => {
      calls.push("pages-readback")
      return {
        deployment_id: 99,
        operation_id: operation.operation_id,
        site_commit: "5".repeat(40),
        live_site_sha256: candidate.site_sha256,
        url: "https://example.invalid/site/",
      }
    },
  }
  return { calls, dependencies, state }
}

test("exact publication controller rejects a non-frozen operation identity before any seam", async () => {
  /** @type {string[]} */
  const calls = []
  const result = await runExactPublication(
    { ...operation, operation_id: "not-an-operation" },
    {},
    {
      readAcceptedInputs: async () => { calls.push("inputs") },
      buildCandidate: async () => { calls.push("build") },
    },
  )
  assert.equal(result.status, "needs_attention")
  assert.ok(result.error)
  assert.equal(result.error.code, "OPERATION_INVALID")
  assert.deepEqual(calls, [])
})

test("published path binds accepted inputs, exact candidate, CAS push, dispatch, and provider readback", async () => {
  const candidate = candidateFor()
  const harness = makeHarness({ candidate })
  const result = await runExactPublication(operation, { workflow_sha: operation.frozen_input.workflow_sha }, harness.dependencies)
  assert.equal(result.status, "published")
  assert.deepEqual(result.verified_output, {
    site_sha256: candidate.site_sha256,
    route_inventory_sha256: candidate.route_inventory_sha256,
    file_inventory_sha256: candidate.file_inventory_sha256,
  })
  assert.deepEqual(result.effects, {
    site_commit: "5".repeat(40),
    workflow_run_id: 77,
    deployment_id: 99,
    rollback_commit: null,
  })
  assert.ok(result.convergence)
  assert.equal(result.convergence.exact, true)
  assert.equal(result.public_projection_sha256, candidate.public_projection_sha256)
  assert.deepEqual(harness.calls, ["accepted", "build", "remote", "live", "commit", "candidate-readback", "push", "remote", "list", "dispatch", "list", "run-readback", "pages-readback", "remote"])
})

test("no_change proves exact convergence and creates zero public effects", async () => {
  const candidate = candidateFor()
  const harness = makeHarness({ candidate, current: "new" })
  harness.state.site_sha256 = candidate.site_sha256
  harness.state.route_inventory_sha256 = candidate.route_inventory_sha256
  harness.state.file_inventory_sha256 = candidate.file_inventory_sha256
  const result = await runExactPublication(operation, {}, harness.dependencies)
  assert.equal(result.status, "no_change")
  assert.ok(result.convergence)
  assert.equal(result.convergence.exact, true)
  assert.equal(result.public_projection_sha256, null)
  assert.deepEqual(result.effects, { site_commit: null, workflow_run_id: null, deployment_id: null, rollback_commit: null })
  assert.equal(harness.calls.includes("commit"), false)
  assert.equal(harness.calls.includes("push"), false)
  assert.equal(harness.calls.includes("list"), false)
  assert.equal(harness.calls.includes("dispatch"), false)
  assert.equal(harness.calls.includes("pages-readback"), false)
})

test("expected-head drift fails closed before candidate mutation", async () => {
  const candidate = candidateFor()
  const harness = makeHarness({ candidate })
  harness.state.gh_pages_sha = "6".repeat(40)
  const result = await runExactPublication(operation, {}, harness.dependencies)
  assert.equal(result.status, "needs_attention")
  assert.ok(result.error)
  assert.equal(result.error.code, "REMOTE_DRIFT")
  assert.equal(harness.calls.includes("commit"), false)
  assert.equal(harness.calls.includes("push"), false)
  assert.equal(harness.calls.includes("dispatch"), false)
})

test("lost push response reconciles the exact new head without a blind second push", async () => {
  const harness = makeHarness({ candidate: candidateFor(), pushBehavior: "lost-response" })
  const result = await runExactPublication(operation, {}, harness.dependencies)
  assert.equal(result.status, "published")
  assert.equal(harness.calls.filter((call) => call === "push").length, 1)
  assert.equal(result.effects.site_commit, "5".repeat(40))
})

test("lost dispatch response reconciles one exact workflow run without redispatch", async () => {
  const harness = makeHarness({ candidate: candidateFor(), dispatchBehavior: "lost-response" })
  const result = await runExactPublication(operation, {}, harness.dependencies)
  assert.equal(result.status, "published")
  assert.equal(harness.calls.filter((call) => call === "dispatch").length, 1)
  assert.equal(harness.calls.filter((call) => call === "list").length, 2)
})

test("candidate privacy gate rejects private output before any public effect", async () => {
  const files = [{ path: "private/secret.txt", bytes: "not for Pages" }]
  const candidate = {
    files,
    routes: ["/"],
    site_sha256: hashSiteTree(files),
    route_inventory_sha256: hashRouteInventory(["/"]),
    file_inventory_sha256: hashFileInventory(files),
  }
  const harness = makeHarness({ candidate })
  const result = await runExactPublication(operation, {}, harness.dependencies)
  assert.equal(result.status, "needs_attention")
  assert.ok(result.error)
  assert.equal(result.error.code, "PRIVACY_FAILED")
  assert.equal(harness.calls.includes("remote"), false)
  assert.equal(harness.calls.includes("push"), false)
})
