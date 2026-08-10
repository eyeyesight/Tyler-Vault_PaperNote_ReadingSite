import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { test } from "node:test"

import { parseArgs } from "../scripts/vault-papernote-site.mjs"

const script = path.resolve("scripts/vault-papernote-site.mjs")

/** @param {string[]} args */
function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: path.resolve(".") })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

test("site CLI accepts the authority options used by the content CLI", () => {
  const options = parseArgs([
    "--vault-root", "vault",
    "--git-root", "repository",
    "--main-ref", "refs/heads/main",
    "--gh-pages-ref", "refs/heads/gh-pages",
    "--work-root", "workspace",
    "--operation-id", "content-0123456789abcdef0123",
  ])

  assert.deepEqual(options, {
    vaultRoot: "vault",
    gitRoot: "repository",
    gitDir: "",
    mainRef: "refs/heads/main",
    ghPagesRef: "refs/heads/gh-pages",
    workRoot: "workspace",
    operationId: "content-0123456789abcdef0123",
  })
})

test("site CLI emits one redacted Traditional Chinese result for invalid invocation", async () => {
  const result = await runCli([])
  assert.equal(result.code, 1)
  assert.equal(result.signal, null)
  assert.equal(result.stderr, "")
  assert.equal(result.stdout.split("\n").filter(Boolean).length, 1)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.lane, "site")
  assert.equal(payload.status, "needs_attention")
  assert.equal(payload.error_code, "VAULT_ROOT_REQUIRED")
  assert.equal(payload.checks[0].name, "cli_arguments")
  assert.deepEqual(payload.added_routes, [])
  assert.deepEqual(payload.changed_routes, [])
  assert.deepEqual(payload.removed_routes, [])
  assert.doesNotMatch(payload.summary, /已發布|already published/i)
  assert.doesNotMatch(result.stdout, /C:\\\\|\/Users\/|stack|Traceback/i)
})

test("site CLI calls the public site preview seam and keeps its result structured", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vault-papernote-site-cli-"))
  try {
    const result = await runCli(["--vault-root", root])
    assert.equal(result.code, 1)
    assert.equal(result.stderr, "")
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.lane, "site")
    assert.equal(payload.status, "needs_attention")
    assert.equal(typeof payload.error_code, "string")
    assert.equal(payload.candidate_identity, null)
    assert.ok(Array.isArray(payload.checks))
    assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
