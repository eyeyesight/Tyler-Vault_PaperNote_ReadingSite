// @ts-nocheck -- CLI transport tests intentionally inject dynamic stdin, process, and controller seams.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { routinePublicationHandoff } from "../lib/routine-publication-handoff.mjs"
import {
  MAX_HANDOFF_ENV_VALUE_BYTES,
  MAX_HANDOFF_STDIN_BYTES,
  decodeHandoffDocument,
  executeHandoffDocument,
  formatHandoffResult,
  main,
  parseHandoffEnvironment,
} from "../scripts/vault-papernote-handoff.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const script = path.join(repoRoot, "scripts", "vault-papernote-handoff.mjs")

const BASE_ENV = Object.freeze({
  VAULT_PAPERNOTE_HANDOFF_GIT_ROOT: "C:\\vault\\git-root",
  VAULT_PAPERNOTE_HANDOFF_GIT_EXECUTABLE: "C:\\Program Files\\Git\\bin\\git.exe",
  VAULT_PAPERNOTE_HANDOFF_GH_EXECUTABLE: "C:\\Program Files\\GitHub CLI\\gh.exe",
  VAULT_PAPERNOTE_HANDOFF_GH_CONFIG_DIR: "C:\\vault\\gh-config",
  VAULT_PAPERNOTE_HANDOFF_REMOTE: "origin",
  VAULT_PAPERNOTE_HANDOFF_REPOSITORY: "owner/repository",
  VAULT_PAPERNOTE_HANDOFF_ACTOR: "actor",
  VAULT_PAPERNOTE_HANDOFF_MAIN_REF: "refs/heads/main",
  VAULT_PAPERNOTE_HANDOFF_GH_PAGES_REF: "refs/heads/gh-pages",
  VAULT_PAPERNOTE_HANDOFF_OPERATION_ROOT: "C:\\vault\\operations",
})

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function gitBlobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\u0000`).update(bytes).digest("hex")
}

function candidateTreeSha256(files) {
  const rows = files
    .slice()
    .sort((left, right) => Buffer.compare(Buffer.from(left.relative), Buffer.from(right.relative)))
    .map(({ relative, bytes }) => `${relative}\u0000${sha256(bytes)}\n`)
    .join("")
  return sha256(Buffer.from(rows, "utf8"))
}

function transportDocument(content = Buffer.from("transport\n", "utf8"), overrides = {}) {
  return {
    version: 1,
    operation_id: "transport-op",
    lane: "content",
    approval: { marker: "approval" },
    candidate_identity: { marker: "candidate" },
    claimed_session: { work_root: "work-root" },
    proposed_site_content_base64: Buffer.from(content).toString("base64"),
    ...overrides,
  }
}

function paddedTransportJson(byteLength) {
  const document = transportDocument()
  document.approval = { padding: "" }
  const emptyPaddingLength = Buffer.byteLength(JSON.stringify(document), "utf8")
  const paddingLength = byteLength - emptyPaddingLength
  assert.ok(paddingLength >= 0)
  document.approval.padding = "x".repeat(paddingLength)
  const bytes = Buffer.from(JSON.stringify(document), "utf8")
  assert.equal(bytes.length, byteLength)
  return bytes
}

function runCli(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env: { ...process.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = []
    const stderr = []
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }))
    child.stdin.end(input)
  })
}

function assertSilentFailure(result) {
  assert.equal(result.code, 1)
  assert.equal(result.signal, null)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "")
}

test("strict environment mapping ignores ambient authority and never accepts a token key", () => {
  const config = parseHandoffEnvironment({
    ...BASE_ENV,
    PATH: "ambient-path-must-not-cross",
    GITHUB_TOKEN: "ambient-token-must-not-cross",
  })

  assert.deepEqual(config, {
    gitRoot: BASE_ENV.VAULT_PAPERNOTE_HANDOFF_GIT_ROOT,
    gitExecutable: BASE_ENV.VAULT_PAPERNOTE_HANDOFF_GIT_EXECUTABLE,
    ghExecutable: BASE_ENV.VAULT_PAPERNOTE_HANDOFF_GH_EXECUTABLE,
    ghConfigDir: BASE_ENV.VAULT_PAPERNOTE_HANDOFF_GH_CONFIG_DIR,
    remote: BASE_ENV.VAULT_PAPERNOTE_HANDOFF_REMOTE,
    repository: BASE_ENV.VAULT_PAPERNOTE_HANDOFF_REPOSITORY,
    actor: BASE_ENV.VAULT_PAPERNOTE_HANDOFF_ACTOR,
    mainRef: BASE_ENV.VAULT_PAPERNOTE_HANDOFF_MAIN_REF,
    ghPagesRef: BASE_ENV.VAULT_PAPERNOTE_HANDOFF_GH_PAGES_REF,
    operationRoot: BASE_ENV.VAULT_PAPERNOTE_HANDOFF_OPERATION_ROOT,
  })
  assert.equal(Object.hasOwn(config, "projectUrl"), false)
  assert.equal(Object.hasOwn(config, "token"), false)
  assert.throws(
    () => parseHandoffEnvironment({ ...BASE_ENV, VAULT_PAPERNOTE_HANDOFF_TOKEN: "must-not-be-accepted" }),
    (error) => error?.code === "environment_invalid",
  )
})

test("environment values are required, bounded, and NUL-free", () => {
  for (const key of Object.keys(BASE_ENV)) {
    assert.throws(
      () => parseHandoffEnvironment({ ...BASE_ENV, [key]: "" }),
      (error) => error?.code === "environment_invalid",
      key,
    )
    assert.throws(
      () => parseHandoffEnvironment({ ...BASE_ENV, [key]: `valid\u0000value` }),
      (error) => error?.code === "environment_invalid",
      key,
    )
    assert.throws(
      () => parseHandoffEnvironment({ ...BASE_ENV, [key]: "x".repeat(MAX_HANDOFF_ENV_VALUE_BYTES + 1) }),
      (error) => error?.code === "environment_invalid",
      key,
    )
  }
  assert.throws(
    () => parseHandoffEnvironment(Object.fromEntries(Object.keys(BASE_ENV).filter((key) => key !== "VAULT_PAPERNOTE_HANDOFF_ACTOR").map((key) => [key, BASE_ENV[key]]))),
    (error) => error?.code === "environment_invalid",
  )
})

test("transport decoding replaces only canonical base64 with Buffer and preserves nested identities", () => {
  const content = Buffer.from("pages:\n  - source: Existing.md\n    route: /papers/existing/\n    layout: paper\n", "utf8")
  const approval = Object.freeze({ marker: "approval", nested: Object.freeze({ unchanged: true }) })
  const candidate = Object.freeze({ marker: "candidate" })
  const claimed = Object.freeze({ work_root: "work-root" })
  const input = Object.freeze(transportDocument(content, {
    approval,
    candidate_identity: candidate,
    claimed_session: claimed,
  }))

  const decoded = decodeHandoffDocument(input)

  assert.deepEqual(Object.keys(decoded).sort(), [
    "approval",
    "candidate_identity",
    "claimed_session",
    "lane",
    "operation_id",
    "proposed_site_content_bytes",
    "version",
  ])
  assert.strictEqual(decoded.approval, approval)
  assert.strictEqual(decoded.candidate_identity, candidate)
  assert.strictEqual(decoded.claimed_session, claimed)
  assert.strictEqual(decoded.proposed_site_content_bytes.constructor, Buffer)
  assert.deepEqual(decoded.proposed_site_content_bytes, content)
  assert.equal(Object.hasOwn(decoded, "proposed_site_content_base64"), false)
})

test("transport decoding rejects non-exact objects and non-canonical base64 before execution", () => {
  const valid = transportDocument()
  const extra = { ...valid, extra: true }
  const missing = { ...valid }
  delete missing.lane
  const accessor = { ...valid }
  Object.defineProperty(accessor, "lane", {
    configurable: true,
    enumerable: true,
    get: () => "content",
  })
  const proxy = new Proxy(valid, {})
  const symbol = { ...valid }
  symbol[Symbol("transport")] = true
  const legacyInjected = { ...valid }
  delete legacyInjected.proposed_site_content_base64
  legacyInjected.proposed_site_content_bytes = Buffer.from("transport\n", "utf8")
  const legacyJson = { ...valid }
  delete legacyJson.proposed_site_content_base64
  legacyJson.proposed_site_content_bytes = { type: "Buffer", data: [116, 114, 97, 110, 115, 112, 111, 114, 116] }

  for (const value of [extra, missing, accessor, proxy, symbol, legacyInjected]) {
    assert.throws(() => decodeHandoffDocument(value), (error) => error?.code === "document_invalid")
  }
  assert.throws(
    () => decodeHandoffDocument(Buffer.from(JSON.stringify(legacyJson), "utf8")),
    (error) => error?.code === "document_invalid",
  )

  for (const encoded of ["", "A", "AAA", "AA=", "A===", "AA==\n", "AA-_", "AB==", "AAAA====", "éA==", "AA== "]) {
    const candidate = { ...valid, proposed_site_content_base64: encoded }
    assert.throws(() => decodeHandoffDocument(candidate), (error) => error?.code === "document_invalid", encoded)
  }
})

test("the exact 64 KiB transport document reaches the factory and controller once with Buffer bytes", async () => {
  const documentBytes = paddedTransportJson(MAX_HANDOFF_STDIN_BYTES)
  assert.equal(documentBytes.length, MAX_HANDOFF_STDIN_BYTES)
  const calls = { factory: 0, handoff: 0 }
  const adapter = { localGit: {}, provider: {} }
  const expectedContent = Buffer.from("transport\n", "utf8")
  const result = await executeHandoffDocument(documentBytes, {
    env: BASE_ENV,
    createAdapter: async (config) => {
      calls.factory += 1
      assert.deepEqual(config, parseHandoffEnvironment(BASE_ENV))
      return adapter
    },
    handoff: async (operation, seam) => {
      calls.handoff += 1
      assert.equal(operation.version, 1)
      assert.equal(operation.operation_id, "transport-op")
      assert.equal(operation.lane, "content")
      assert.equal(Buffer.isBuffer(operation.proposed_site_content_bytes), true)
      assert.deepEqual(operation.proposed_site_content_bytes, expectedContent)
      assert.equal(Object.hasOwn(operation, "proposed_site_content_base64"), false)
      assert.strictEqual(seam, adapter)
      return { status: "needs_attention", error_code: "provider_unavailable" }
    },
  })

  assert.deepEqual(result, { status: "needs_attention", error_code: "provider_unavailable" })
  assert.deepEqual(calls, { factory: 1, handoff: 1 })
  assert.equal(formatHandoffResult(result), `${JSON.stringify(result)}\n`)
  assert.equal(formatHandoffResult(result).split("\n").filter(Boolean).length, 1)
})

test("a 64 KiB plus one transport document fails before factory invocation", async () => {
  const calls = { factory: 0, handoff: 0 }
  await assert.rejects(
    executeHandoffDocument(paddedTransportJson(MAX_HANDOFF_STDIN_BYTES + 1), {
      env: BASE_ENV,
      createAdapter: async () => {
        calls.factory += 1
        return {}
      },
      handoff: async () => {
        calls.handoff += 1
        return {}
      },
    }),
    (error) => error?.code === "stdin_limit",
  )
  assert.deepEqual(calls, { factory: 0, handoff: 0 })
})

test("malformed, empty, invalid UTF-8, and non-object documents fail before factory", async () => {
  const invalidInputs = [
    Buffer.alloc(0),
    Buffer.from("{"),
    Buffer.from("{}{}"),
    Buffer.from("[]"),
    Buffer.from("null"),
    Buffer.from("42"),
    Buffer.from([0xc3, 0x28]),
    Buffer.from(JSON.stringify({ ...transportDocument(), proposed_site_content_bytes: Buffer.from("transport\n", "utf8") }), "utf8"),
  ]
  for (const input of invalidInputs) {
    let factoryCalls = 0
    await assert.rejects(
      executeHandoffDocument(input, {
        env: BASE_ENV,
        createAdapter: async () => {
          factoryCalls += 1
          return {}
        },
        handoff: async () => ({}),
      }),
      (error) => ["document_invalid", "stdin_empty"].includes(error?.code),
    )
    assert.equal(factoryCalls, 0)
  }
})

test("a valid injected transport preserves nested values, seam, and compact result", async () => {
  const content = Buffer.from("transport\n", "utf8")
  const approvedTransport = Object.freeze(transportDocument(content, {
    operation_id: "approved",
    approval: Object.freeze({ version: "approval" }),
    candidate_identity: Object.freeze({ version: "candidate" }),
    claimed_session: Object.freeze({ work_root: "approved-root" }),
  }))
  const adapter = Object.freeze({ localGit: {}, provider: {} })
  const handoffResult = Object.freeze({ version: 1, status: "deployed", error_code: null })
  let received
  const result = await executeHandoffDocument(approvedTransport, {
    env: BASE_ENV,
    createAdapter: async () => adapter,
    handoff: async (operation, seam) => {
      received = { operation, seam }
      return handoffResult
    },
  })

  assert.strictEqual(received.operation.approval, approvedTransport.approval)
  assert.strictEqual(received.operation.candidate_identity, approvedTransport.candidate_identity)
  assert.strictEqual(received.operation.claimed_session, approvedTransport.claimed_session)
  assert.deepEqual(received.operation.proposed_site_content_bytes, content)
  assert.strictEqual(received.seam, adapter)
  assert.strictEqual(result, handoffResult)
  assert.equal(formatHandoffResult(result), '{"version":1,"status":"deployed","error_code":null}\n')
})

test("a stable factory failure is routed through a minimal failing seam without leaking diagnostics", async () => {
  const approvedTransport = transportDocument(Buffer.from("transport\n", "utf8"), { operation_id: "approved" })
  const hostile = new Error("Bearer top-secret C:\\private\\factory.json")
  hostile.code = "provider_unavailable"
  hostile.stack = "Error: secret stack\n    at C:\\private\\factory.json"
  let receivedSeam
  const result = await executeHandoffDocument(approvedTransport, {
    env: BASE_ENV,
    createAdapter: async () => { throw hostile },
    handoff: async (operation, seam) => {
      assert.strictEqual(operation.approval, approvedTransport.approval)
      receivedSeam = seam
      assert.deepEqual(Object.keys(seam).sort(), ["localGit", "provider"])
      assert.equal(typeof seam.localGit.readRemoteAuthority, "function")
      await assert.rejects(seam.localGit.readRemoteAuthority({}), (error) => error?.code === "provider_unavailable")
      return { status: "needs_attention", error_code: "provider_unavailable" }
    },
  })
  const line = formatHandoffResult(result)

  assert.ok(receivedSeam)
  assert.equal(line.includes("top-secret"), false)
  assert.equal(line.includes("factory.json"), false)
  assert.equal(line.includes("secret stack"), false)
})

test("an unknown factory failure fails closed without invoking the controller", async () => {
  let handoffCalls = 0
  const hostile = new Error("raw secret C:\\private\\factory.json")
  await assert.rejects(
    executeHandoffDocument(transportDocument(), {
      env: BASE_ENV,
      createAdapter: async () => { throw hostile },
      handoff: async () => {
        handoffCalls += 1
        return { status: "deployed" }
      },
    }),
    (error) => error?.code === "handoff_unavailable",
  )
  assert.equal(handoffCalls, 0)
})

test("main emits one compact result line and returns zero for a controller needs_attention result", async () => {
  const output = []
  const adapter = { localGit: {}, provider: {} }
  const stdin = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(transportDocument()), "utf8")
    },
  }
  const code = await main([], stdin, { write: (line) => output.push(line) }, BASE_ENV, {
    createAdapter: async () => adapter,
    handoff: async () => ({ status: "needs_attention", error_code: "provider_unavailable" }),
  })

  assert.equal(code, 0)
  assert.deepEqual(output, [formatHandoffResult({ status: "needs_attention", error_code: "provider_unavailable" })])
})

test("the transport envelope crosses real approval and candidate gates before a stable remote failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-cli-controller-"))
  const operationId = "content-0123456789abcdef0123"
  const workRoot = path.join(root, "work")
  const session = path.join(workRoot, operationId)
  const candidateRoot = path.join(session, "handoff", "site")
  const mapBytes = Buffer.from([
    "pages:",
    "  - source: Existing.md",
    "    route: /papers/existing/",
    "    layout: paper",
    "",
  ].join("\n"), "utf8")
  const siteBytes = Buffer.from("<html>candidate</html>\n", "utf8")
  await mkdir(candidateRoot, { recursive: true })
  await writeFile(path.join(session, "site-content.yml"), mapBytes)
  await writeFile(path.join(candidateRoot, "index.html"), siteBytes)

  const expectedMainSha = "1".repeat(40)
  const expectedGhPagesSha = "2".repeat(40)
  const liveRendererSha = "3".repeat(40)
  const rendererTreeSha = sha256(Buffer.from("renderer-tree\n", "utf8"))
  const mapSha = sha256(mapBytes)
  const siteSha = candidateTreeSha256([{ relative: "index.html", bytes: siteBytes }])
  const candidateSha = sha256(Buffer.from([
    `source_main=${expectedMainSha}`,
    `gh_pages=${expectedGhPagesSha}`,
    `map=${mapSha}`,
    `live_renderer=${liveRendererSha}`,
    `renderer_tree=${rendererTreeSha}`,
    `site=${siteSha}`,
    "",
  ].join("\n"), "utf8"))
  const candidateIdentity = {
    base_gh_pages_sha: expectedGhPagesSha,
    live_renderer_sha: liveRendererSha,
    map_sha256: mapSha,
    renderer_tree_sha256: rendererTreeSha,
    sha256: candidateSha,
    site_sha256: siteSha,
    source_main_sha: expectedMainSha,
  }
  const approval = {
    candidate_id: candidateSha,
    expected_gh_pages_sha: expectedGhPagesSha,
    expected_main_sha: expectedMainSha,
    map_blob_sha: gitBlobSha(mapBytes),
    map_commit_sha: null,
    map_sha256: mapSha,
    mode: "routine",
    operation_id: operationId,
  }
  const envelope = transportDocument(mapBytes, {
    operation_id: operationId,
    approval,
    candidate_identity: candidateIdentity,
    claimed_session: { work_root: workRoot },
  })
  let factoryCalls = 0
  let remoteCalls = 0

  try {
    const result = await executeHandoffDocument(envelope, {
      env: BASE_ENV,
      createAdapter: async () => {
        factoryCalls += 1
        return {
          localGit: {
            async readRemoteAuthority() {
              remoteCalls += 1
              const error = new Error("local remote authority is intentionally unavailable")
              error.code = "provider_unavailable"
              throw error
            },
          },
          provider: {},
        }
      },
      handoff: routinePublicationHandoff,
    })

    assert.equal(result.status, "needs_attention", JSON.stringify(result))
    assert.equal(result.error_code, "provider_unavailable")
    assert.deepEqual(result.checks, [
      { name: "approval", outcome: "pass" },
      { name: "candidate", outcome: "pass" },
      { name: "remote_heads", outcome: "fail" },
    ])
    assert.equal(factoryCalls, 1)
    assert.equal(remoteCalls, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("production CLI is silent and exits 1 for empty, malformed, non-object, oversized, and argument input", async () => {
  const cases = [
    { name: "empty", args: [], input: Buffer.alloc(0) },
    { name: "malformed", args: [], input: Buffer.from("not-json", "utf8") },
    { name: "non-object", args: [], input: Buffer.from("[]", "utf8") },
    { name: "oversized", args: [], input: paddedTransportJson(MAX_HANDOFF_STDIN_BYTES + 1) },
    { name: "extra argument", args: ["unexpected"], input: Buffer.from("{}", "utf8") },
  ]
  for (const current of cases) {
    const result = await runCli(current.args, current.input)
    assertSilentFailure(result)
  }
})
