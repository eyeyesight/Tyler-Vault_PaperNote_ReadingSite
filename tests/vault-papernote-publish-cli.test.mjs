import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  createImmutableLkgStore,
  runSitePublication,
} from "../lib/site-publication-runtime.mjs"
import {
  MAX_PUBLICATION_REQUEST_BYTES,
  createProductionRollback,
  decodeOperationTransport,
  main,
  parsePublicationRequest,
} from "../scripts/vault-papernote-publish.mjs"

const SITE_COMMIT = "a".repeat(40)
const ROLLBACK_COMMIT = "b".repeat(40)
const SITE_SHA = "c".repeat(64)
const OPERATION_ID = "d".repeat(32)

function operation() {
  return {
    operation_id: OPERATION_ID,
    lane: "site",
    candidate_identity: {
      base_gh_pages_sha: "e".repeat(40),
      live_renderer_sha: "f".repeat(40),
      main_renderer_tree_sha256: "1".repeat(64),
      map_sha256: "2".repeat(64),
      sha256: "3".repeat(64),
      site_sha256: SITE_SHA,
      source_main_sha: "4".repeat(40),
    },
  }
}

function publicationResult() {
  return {
    status: "deployed",
    operation_id: OPERATION_ID,
    identifiers: { site_commit: SITE_COMMIT, workflow_run_id: "run-1" },
  }
}

function qaPass() {
  return {
    status: "pass",
    checks: [{ name: "browser_routes", outcome: "pass" }],
    error_code: null,
  }
}

function qaCriticalFailure() {
  return {
    status: "fail",
    critical: true,
    checks: [{ name: "browser_routes", outcome: "fail" }],
    error_code: "QA_BROWSER_ROUTE_STATUS",
  }
}

function lkgRecord() {
  return {
    version: 1,
    site_commit: SITE_COMMIT,
    site_sha256: SITE_SHA,
    deployment_id: "deployment-1",
    workflow_run_id: null,
    url: "https://example.invalid/site/",
    candidate_identity: operation().candidate_identity,
    qa: qaPass(),
  }
}

test("one-command publication records an immutable LKG after critical QA passes", async () => {
  const calls = []
  const records = []
  const result = await runSitePublication(operation(), {}, {
    publish: async () => {
      calls.push("publish")
      return publicationResult()
    },
    qa: async (input) => {
      calls.push(`qa:${input.phase}`)
      return qaPass()
    },
    lkg: {
      readCurrent: async () => null,
      record: async (record) => {
        calls.push("lkg:record")
        records.push(record)
        return record
      },
    },
  })

  assert.equal(result.status, "published")
  assert.equal(result.live_qa.status, "pass")
  assert.equal(result.lkg.site_commit, SITE_COMMIT)
  assert.equal(result.lkg.site_sha256, SITE_SHA)
  assert.deepEqual(calls, ["publish", "qa:published", "lkg:record"])
  assert.equal(records.length, 1)
  assert.equal(records[0].site_commit, SITE_COMMIT)
})

test("critical live QA failure rolls back exact LKG bytes and revalidates them", async () => {
  const calls = []
  let qaCalls = 0
  const lkg = lkgRecord()
  const result = await runSitePublication(operation(), {}, {
    publish: async () => {
      calls.push("publish")
      return publicationResult()
    },
    qa: async (input) => {
      qaCalls += 1
      calls.push(`qa:${input.phase}`)
      return qaCalls === 1 ? qaCriticalFailure() : qaPass()
    },
    lkg: {
      readCurrent: async () => lkg,
      record: async () => assert.fail("a failed release must not replace the LKG"),
    },
    rollback: async (input) => {
      calls.push("rollback")
      assert.equal(input.lkg.site_commit, SITE_COMMIT)
      assert.equal(input.lkg.site_sha256, SITE_SHA)
      return {
        rollback_commit: ROLLBACK_COMMIT,
        restored_lkg_commit: SITE_COMMIT,
        site_sha256: SITE_SHA,
      }
    },
  })

  assert.equal(result.status, "needs_attention")
  assert.equal(result.error_code, "LIVE_QA_FAILED_ROLLED_BACK")
  assert.equal(result.rollback.rollback_commit, ROLLBACK_COMMIT)
  assert.equal(result.rollback.restored_lkg_commit, SITE_COMMIT)
  assert.equal(result.rollback.site_sha256, SITE_SHA)
  assert.equal(result.revalidation.status, "pass")
  assert.deepEqual(calls, ["publish", "qa:published", "rollback", "qa:rollback"])
})

test("public Pages smoke failure restores the LKG without reusing failed candidate QA", async () => {
  const lkg = lkgRecord()
  let qaCalls = 0
  let rollbackCalls = 0
  const result = await runSitePublication(operation(), {}, {
    publish: async () => ({
      status: "needs_attention",
      operation_id: OPERATION_ID,
      error_code: "smoke_failed",
      identifiers: { site_commit: SITE_COMMIT },
    }),
    qa: async () => {
      qaCalls += 1
      assert.fail("public smoke recovery must use rollback live revalidation")
    },
    lkg: {
      readCurrent: async () => lkg,
      record: async () => assert.fail("a failed release must not replace the LKG"),
    },
    rollback: async () => {
      rollbackCalls += 1
      return {
        rollback_commit: lkg.site_commit,
        restored_lkg_commit: lkg.site_commit,
        site_sha256: lkg.site_sha256,
        revalidation: qaPass(),
      }
    },
  })

  assert.equal(result.status, "needs_attention")
  assert.equal(result.error_code, "LIVE_QA_FAILED_ROLLED_BACK")
  assert.equal(result.live_qa.error_code, "SMOKE_FAILED")
  assert.equal(result.revalidation.status, "pass")
  assert.equal(rollbackCalls, 1)
  assert.equal(qaCalls, 0)
})

test("default production rollback restores the exact LKG and deploys it through existing seams", async () => {
  const calls = []
  const failedCommit = "8".repeat(40)
  const lkg = lkgRecord()
  const mainSha = "7".repeat(40)
  const adapter = {
    localGit: {
      readRemoteAuthority: async () => ({ main_sha: mainSha, gh_pages_sha: failedCommit, map_bytes: Buffer.from("map") }),
      pushGhPages: async (input) => {
        calls.push(["push", input])
        return { pushed: true }
      },
      readGhPagesHead: async () => lkg.site_commit,
    },
    provider: {
      listMatchingDeploymentRuns: async () => {
        calls.push(["list"])
        return calls.filter(([name]) => name === "dispatch").length === 0 ? [] : [{ id: "run-rollback-1" }]
      },
      dispatchDeployment: async (input) => {
        calls.push(["dispatch", input])
        return { accepted: true }
      },
      readDeploymentRun: async (input) => {
        calls.push(["workflow", input])
        return { status: "completed", conclusion: "success" }
      },
      readPagesDeployment: async (input) => {
        calls.push(["pages", input])
        return { ...input, deployment_id: "deployment-rollback-1", status: "success", url: lkg.url }
      },
      anonymousSmoke: async (input) => {
        calls.push(["smoke", input])
        return { target: input.target, homepage_status: 200, route_statuses: [200], asset_statuses: [], not_found_status: 404 }
      },
    },
  }

  const rollback = createProductionRollback(adapter)
  const result = await rollback({
    settings: { lkg_site_root: "C:/immutable/lkg/site" },
    publication: { identifiers: { site_commit: failedCommit } },
    lkg,
  })

  assert.deepEqual(result, {
    rollback_commit: lkg.site_commit,
    restored_lkg_commit: lkg.site_commit,
    site_sha256: lkg.site_sha256,
    revalidation: {
      status: "pass",
      checks: [{ name: "public_lkg_smoke", outcome: "pass" }],
      error_code: null,
    },
    site_root: "C:/immutable/lkg/site",
  })
  assert.deepEqual(calls.map(([name]) => name), ["push", "list", "dispatch", "list", "workflow", "pages", "smoke"])
  assert.deepEqual(calls[0][1], { candidate_sha: lkg.site_commit, expected_old_sha: failedCommit })
})

test("LKG records are readable and immutable by exact site commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-lkg-"))
  try {
    const store = createImmutableLkgStore(root)
    const record = lkgRecord()
    await store.record(record)
    assert.deepEqual(await store.readCurrent(), record)
    const storedPointer = JSON.parse(await readFile(path.join(root, "current.json"), "utf8"))
    assert.equal(storedPointer.site_commit, SITE_COMMIT)
    await assert.rejects(
      store.record({ ...record, site_sha256: "9".repeat(64) }),
      (error) => error?.code === "LKG_IMMUTABILITY_VIOLATION",
    )
    assert.deepEqual(await store.readCurrent(), record)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("CLI operation transport restores canonical base64 map bytes", () => {
  const bytes = Buffer.from("pages:\n", "utf8")
  const transport = {
    version: 1,
    operation_id: OPERATION_ID,
    lane: "site",
    approval: {},
    candidate_identity: {},
    claimed_session: {},
    proposed_site_content_base64: bytes.toString("base64"),
  }
  const decoded = decodeOperationTransport(transport)
  assert.ok(Buffer.isBuffer(decoded.proposed_site_content_bytes))
  assert.deepEqual(decoded.proposed_site_content_bytes, bytes)
  assert.equal(Object.hasOwn(decoded, "proposed_site_content_base64"), false)
  assert.throws(() => decodeOperationTransport({ ...transport, extra: true }), /OPERATION_TRANSPORT_INVALID/)
  assert.throws(() => decodeOperationTransport({ ...transport, proposed_site_content_base64: "YQ=" }), /OPERATION_TRANSPORT_INVALID/)
})

test("publish CLI accepts one bounded JSON object and emits exactly one result line", async () => {
  const request = JSON.stringify({ operation: operation(), settings: {} })
  assert.deepEqual(parsePublicationRequest(request), { operation: operation(), settings: {} })
  assert.throws(
    () => parsePublicationRequest(`${request}${"x".repeat(MAX_PUBLICATION_REQUEST_BYTES)}`),
    /REQUEST_TOO_LARGE/,
  )

  const output = []
  const code = await main({
    argv: [],
    input: request,
    write: (line) => output.push(line),
    dependencies: {
      runPublication: async () => ({ status: "published", operation_id: OPERATION_ID }),
    },
  })

  assert.equal(code, 0)
  assert.equal(output.length, 1)
  assert.deepEqual(JSON.parse(output[0]), { version: 1, status: "published", operation_id: OPERATION_ID })
})

test("publish CLI rejects extra arguments and malformed envelopes without diagnostics", async () => {
  const output = []
  const code = await main({
    argv: ["--preview"],
    input: JSON.stringify({ operation: operation(), settings: {}, preview: true }),
    write: (line) => output.push(line),
    dependencies: {
      runPublication: async () => assert.fail("invalid requests must not execute publication"),
    },
  })

  assert.equal(code, 1)
  assert.equal(output.length, 1)
  assert.equal(JSON.parse(output[0]).error.code, "REQUEST_INVALID")
  assert.doesNotMatch(output[0], /preview|C:\\\\|\/Users\/|stack|Traceback/i)
})
