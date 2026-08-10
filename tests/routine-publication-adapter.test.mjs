// @ts-nocheck -- bounded command, HTTP, Git, and provider fixtures intentionally use dynamic test doubles.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { realpathSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

import {
  _testOnlyAdapterFailure,
  _testOnlyTerminateOwnedProcess,
  createBoundedCommandTransport,
  createBoundedHttpTransport,
  createRoutinePublicationAdapter,
  createRoutinePublicationLocalGitCapabilities,
  createRoutinePublicationProviderCapabilities,
} from "../lib/routine-publication-adapter.mjs"

function discoverGitExecutable() {
  const result = process.platform === "win32"
    ? spawnSync("where.exe", ["git.exe"], { encoding: "utf8", windowsHide: true })
    : spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" })
  assert.equal(result.status, 0, `git executable discovery failed\n${String(result.stderr)}`)
  const candidate = String(result.stdout).split(/\r?\n/u).map((line) => line.trim()).find(Boolean)
  assert.ok(candidate && path.isAbsolute(candidate), `discovered Git path is not absolute: ${candidate}`)
  const resolved = realpathSync(candidate)
  assert.ok(path.isAbsolute(resolved), `resolved Git path is not absolute: ${resolved}`)
  assert.ok(["git", "git.exe"].includes(path.basename(resolved).toLowerCase()), `unexpected Git basename: ${resolved}`)
  return resolved
}

const GIT_EXECUTABLE = discoverGitExecutable()

const SAFE_INPUT_BYTES = 16 * 1024 * 1024
const gitBlobSha = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")

async function makeProviderHarness(commandHandler, { actor = "actor", repository = "owner/repository", projectUrl, bounded = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-provider-fake-"))
  const ghExecutable = path.join(root, process.platform === "win32" ? "gh.exe" : "gh")
  const ghConfigDir = path.join(root, "gh-config")
  await writeFile(ghExecutable, "fake gh")
  await mkdir(ghConfigDir)
  const commandRequests = []
  const httpRequests = []
  const commandTransport = bounded
    ? createBoundedCommandTransport({
      execute: async (request) => {
        commandRequests.push(request)
        return await commandHandler(request)
      },
    })
    : {
      async run(request) {
        commandRequests.push(request)
        return await commandHandler(request)
      },
    }
  const httpTransport = {
    async get(request) {
      httpRequests.push(request)
      return { status: 200, finalUrl: request.url }
    },
  }
  const provider = await createRoutinePublicationProviderCapabilities({
    ghExecutable,
    ghConfigDir,
    repository,
    actor,
    ...(projectUrl === undefined ? {} : { projectUrl }),
  }, { commandTransport, httpTransport })
  return { root, provider, commandRequests, httpRequests, ghExecutable, ghConfigDir }
}

test("exports the internal local-Git constructor, bounded command transport, and bounded HTTP transport", () => {
  assert.equal(typeof createBoundedCommandTransport, "function")
  assert.equal(typeof createBoundedHttpTransport, "function")
  assert.equal(typeof createRoutinePublicationLocalGitCapabilities, "function")
})

test("exports the production GitHub provider constructor", async () => {
  const module = await import("../lib/routine-publication-adapter.mjs")
  assert.equal(typeof module.createRoutinePublicationProviderCapabilities, "function")
})

test("the final factory returns exactly plain localGit and provider capability seams", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-adapter-factory-"))
  const gitRoot = path.join(root, "git")
  const operationRoot = path.join(root, "operation")
  const ghConfigDir = path.join(root, "gh-config")
  const gitExecutable = path.join(root, process.platform === "win32" ? "git.exe" : "git")
  const ghExecutable = path.join(root, process.platform === "win32" ? "gh.exe" : "gh")
  const requests = []
  await mkdir(gitRoot)
  await mkdir(operationRoot)
  await mkdir(ghConfigDir)
  await writeFile(gitExecutable, "fake git")
  await writeFile(ghExecutable, "fake gh")
  try {
    await assert.rejects(createRoutinePublicationAdapter({
      actor: "actor",
      ghExecutable,
      ghPagesRef: "refs/heads/gh-pages",
      gitExecutable,
      gitRoot,
      mainRef: "refs/heads/main",
      operationRoot,
      remote: "origin",
      repository: "owner/repository",
    }, {
      commandTransport: { async run() { throw new Error("auth must not run without explicit ghConfigDir") } },
      httpTransport: { async get() { throw new Error("HTTP must not run") } },
    }), (error) => {
      assert.equal(error?.code, "config_invalid")
      assert.equal(error?.message, "config_invalid")
      return true
    })
    const seams = await createRoutinePublicationAdapter({
      actor: "actor",
      ghConfigDir,
      ghExecutable,
      ghPagesRef: "refs/heads/gh-pages",
      gitExecutable,
      gitRoot,
      mainRef: "refs/heads/main",
      operationRoot,
      remote: "origin",
      repository: "owner/repository",
    }, {
      commandTransport: {
        async run(request) {
          requests.push(request)
          return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
        },
      },
      httpTransport: { async get() { throw new Error("HTTP transport must not run during factory auth") } },
    })
    assert.equal(Object.getPrototypeOf(seams), Object.prototype)
    assert.deepEqual(Object.keys(seams).sort(), ["localGit", "provider"])
    assert.equal(Object.getPrototypeOf(seams.localGit), Object.prototype)
    assert.equal(Object.getPrototypeOf(seams.provider), Object.prototype)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].argv[0], ghExecutable)
    assert.equal(requests[0].argv[1], "api")
    assert.deepEqual(Object.keys(requests[0].env), ["GH_CONFIG_DIR"])
    assert.equal(typeof seams.localGit.readRemoteAuthority, "function")
    assert.equal(typeof seams.provider.readPagesDeployment, "function")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("GitHub provider capabilities are an authenticated plain object with exact own methods", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-provider-shape-"))
  const ghExecutable = path.join(root, process.platform === "win32" ? "gh.exe" : "gh")
  const ghConfigDir = path.join(root, "gh-config")
  await writeFile(ghExecutable, "fake gh")
  await mkdir(ghConfigDir)
  const requests = []
  const provider = await createRoutinePublicationProviderCapabilities({
    ghExecutable,
    ghConfigDir,
    repository: "owner/repository",
    actor: "actor",
  }, {
    commandTransport: {
      async run(request) {
        requests.push(request)
        return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
      },
    },
    httpTransport: { async get() { throw new Error("HTTP transport must not run during auth") } },
  })
  try {
    assert.equal(Object.getPrototypeOf(provider), Object.prototype)
    assert.deepEqual(Object.keys(provider).sort(), [
      "anonymousSmoke",
      "createMappingPr",
      "dispatchDeployment",
      "listMatchingDeploymentRuns",
      "listMatchingMappingPrs",
      "listMergedMappingPrs",
      "readDeploymentRun",
      "readMappingPr",
      "readMerge",
      "readPagesDeployment",
      "readRequiredCi",
      "squashMergeMappingPr",
    ])
    for (const name of Object.keys(provider)) {
      const descriptor = Object.getOwnPropertyDescriptor(provider, name)
      assert.equal(typeof descriptor?.value, "function", name)
      assert.equal(descriptor?.get, undefined, name)
      assert.equal(descriptor?.set, undefined, name)
    }
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0].argv.slice(1), ["api", "--repo", "owner/repository", "/user", "--jq", ".login"])
    assert.equal(requests[0].shell, false)
    assert.deepEqual(requests[0].env, { GH_CONFIG_DIR: ghConfigDir })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("bounded provider transport constructs the final safe environment once and reaches auth plus a provider read", async () => {
  const headSha = "c".repeat(40)
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    if (endpoint.startsWith("/repos/owner/repository/actions/workflows/t08-pinned-stack.yml/runs?")) return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({ total_count: 1, workflow_runs: [{
        id: 77,
        path: ".github/workflows/t08-pinned-stack.yml",
        head_sha: headSha,
      }] })),
      stderr: Buffer.alloc(0),
    }
    if (endpoint.startsWith("/repos/owner/repository/actions/runs/77/jobs?")) return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({ total_count: 1, jobs: [{
        name: "Ubuntu pinned-stack acceptance",
        status: "completed",
        conclusion: "success",
      }] })),
      stderr: Buffer.alloc(0),
    }
    throw new Error(`unexpected bounded provider endpoint: ${endpoint}`)
  }, { bounded: true })
  try {
    const result = await harness.provider.readRequiredCi({
      head_sha: headSha,
      workflow: "t08-pinned-stack.yml",
      job: "Ubuntu pinned-stack acceptance",
    })
    assert.deepEqual(result, {
      head_sha: headSha,
      workflow: "t08-pinned-stack.yml",
      job: "Ubuntu pinned-stack acceptance",
      status: "completed",
      conclusion: "success",
    })
    assert.equal(harness.commandRequests.length, 3)
    assert.equal(harness.commandRequests[0].env.PATH, path.dirname(harness.ghExecutable))
    assert.equal(harness.commandRequests[0].env.GH_CONFIG_DIR, harness.ghConfigDir)
    assert.equal(harness.commandRequests[0].env.GIT_DIR, undefined)
    assert.equal(harness.commandRequests[0].env.HOME, undefined)
    assert.equal(harness.commandRequests[0].env.HTTP_PROXY, undefined)
    assert.equal(harness.commandRequests[0].env.GIT_CONFIG_GLOBAL, process.platform === "win32" ? "NUL" : os.devNull)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("bounded provider status failures map 401 and rate limit to stable errors without raw diagnostics", async () => {
  for (const [status, expectedCode, diagnostic] of [
    [401, "auth_failed", "HTTP 401 Unauthorized Bearer secret-token C:\\provider\\stderr"],
    [429, "rate_limited", "HTTP 429 rate limit Bearer secret-token C:\\provider\\stderr"],
  ]) {
    const headSha = "d".repeat(40)
    const harness = await makeProviderHarness(async (request) => {
      const endpoint = request.argv[4]
      if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
      if (endpoint.startsWith("/repos/owner/repository/actions/workflows/t08-pinned-stack.yml/runs?")) return {
        status,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(diagnostic, "utf8"),
      }
      throw new Error(`unexpected bounded status endpoint: ${endpoint}`)
    }, { bounded: true })
    try {
      await assert.rejects(
        harness.provider.readRequiredCi({ head_sha: headSha, workflow: "t08-pinned-stack.yml", job: "Ubuntu pinned-stack acceptance" }),
        (error) => {
          assert.equal(error?.code, expectedCode)
          assert.equal(error?.message, expectedCode)
          assert.doesNotMatch(String(error), /secret-token|provider\\\\stderr/u)
          return true
        },
      )
      assert.equal(harness.commandRequests.length, 2)
    } finally {
      await rm(harness.root, { recursive: true, force: true })
    }
  }
})

test("bounded local-Git nonzero status maps to git_command_failed after bounded execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-adapter-git-status-"))
  const gitRoot = path.join(root, "git")
  const operationRoot = path.join(root, "operation")
  await mkdir(gitRoot)
  await mkdir(operationRoot)
  const requests = []
  const commandTransport = createBoundedCommandTransport({
    execute: async (request) => {
      requests.push(request)
      return { status: 17, stdout: Buffer.alloc(0), stderr: Buffer.from("fatal: Bearer secret-token C:\\private\\git.err", "utf8") }
    },
  })
  try {
    const localGit = createRoutinePublicationLocalGitCapabilities({
      gitRoot,
      gitExecutable: GIT_EXECUTABLE,
      remote: "origin",
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      operationRoot,
    }, { commandTransport })
    await assert.rejects(localGit.readGhPagesHead({}), (error) => {
      assert.equal(error?.code, "git_command_failed")
      assert.equal(error?.message, "git_command_failed")
      assert.doesNotMatch(String(error), /secret-token|private\\\\git\.err/u)
      return true
    })
    assert.equal(requests.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("provider actor mismatch is auth_failed with a stable public error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-provider-auth-mismatch-"))
  const ghExecutable = path.join(root, process.platform === "win32" ? "gh.exe" : "gh")
  const ghConfigDir = path.join(root, "gh-config")
  await writeFile(ghExecutable, "fake gh")
  await mkdir(ghConfigDir)
  try {
    await assert.rejects(
      createRoutinePublicationProviderCapabilities({
        ghExecutable,
        ghConfigDir,
        repository: "owner/repository",
        actor: "actor",
      }, {
        commandTransport: {
          async run(request) {
            assert.equal(request.argv[4], "/user")
            return { status: 0, stdout: Buffer.from("other\n"), stderr: Buffer.alloc(0) }
          },
        },
        httpTransport: { async get() { throw new Error("HTTP transport must not run during auth") } },
      }),
      (error) => {
        assert.equal(error?.code, "auth_failed")
        assert.equal(error?.message, "auth_failed")
        assert.deepEqual(Object.keys(error).sort(), ["code", "name"])
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("deployment dispatch preserves controller-known remote_drift and performs no POST", async () => {
  const expectedHeadSha = "a".repeat(40)
  const actualHeadSha = "b".repeat(40)
  const siteCommit = "c".repeat(40)
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    if (endpoint === "/repos/owner/repository/git/ref/heads/main") return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({ ref: "refs/heads/main", object: { type: "commit", sha: actualHeadSha } })),
      stderr: Buffer.alloc(0),
    }
    throw new Error(`unexpected dispatch endpoint: ${endpoint}`)
  })
  try {
    await assert.rejects(
      harness.provider.dispatchDeployment({
        expected_head_sha: expectedHeadSha,
        inputs: { site_commit: siteCommit, publication_mode: "routine" },
        ref: "main",
        run_name: `Deploy GitHub Pages ${siteCommit} (routine)`,
        workflow: "deploy-pages.yml",
      }),
      (error) => {
        assert.equal(error?.code, "remote_drift")
        assert.equal(error?.message, "remote_drift")
        return true
      },
    )
    const endpoints = harness.commandRequests.map((request) => request.argv[4])
    assert.deepEqual(endpoints, ["/user", "/repos/owner/repository/git/ref/heads/main"])
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("deployment run invalid input maps to workflow_failed rather than dispatch_uncertain", async () => {
  const headSha = "e".repeat(40)
  const siteCommit = "f".repeat(40)
  const harness = await makeProviderHarness(async (request) => {
    assert.equal(request.argv[4], "/user")
    return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
  })
  try {
    await assert.rejects(
      harness.provider.readDeploymentRun({
        id: "run-1",
        site_commit: siteCommit,
        publication_mode: "routine",
        workflow: "wrong.yml",
        ref: "main",
        head_sha: headSha,
      }),
      (error) => {
        assert.equal(error?.code, "workflow_failed")
        assert.equal(error?.message, "workflow_failed")
        return true
      },
    )
    assert.equal(harness.commandRequests.length, 1)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("createMappingPr sends one exact POST mutation body and returns the provider PR id", async () => {
  const mapBytes = Buffer.from("pages:\n  - source: Existing.md\n    route: /papers/existing/\n    layout: paper\n", "utf8")
  const branch = "t13/map/content-0123456789abcdef0123"
  const input = {
    base: "main",
    branch,
    file_set: ["site-content.yml"],
    head_sha: "a".repeat(40),
    map_blob_sha: gitBlobSha(mapBytes),
    map_bytes: mapBytes,
  }
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    assert.equal(endpoint, "/repos/owner/repository/pulls")
    assert.deepEqual(request.argv.slice(4), [
      "/repos/owner/repository/pulls",
      "--method",
      "POST",
      "--input",
      "-",
    ])
    assert.deepEqual(request.input, Buffer.from(JSON.stringify({
      title: "Update site-content.yml",
      head: branch,
      base: "main",
      body: "",
    }), "utf8"))
    return { status: 0, stdout: Buffer.from(JSON.stringify({ number: 417 })), stderr: Buffer.alloc(0) }
  })
  try {
    assert.deepEqual(await harness.provider.createMappingPr(input), { pr_id: "417" })
    assert.equal(harness.commandRequests.filter(({ argv }) => argv[4] === "/repos/owner/repository/pulls").length, 1)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("createMappingPr timeout or nonzero failure is stable pr_failed with no retry", async () => {
  for (const mode of ["timeout", "failure"]) {
    const mapBytes = Buffer.from("pages:\n  - source: Existing.md\n    route: /papers/existing/\n    layout: paper\n", "utf8")
    const input = {
      base: "main",
      branch: "t13/map/content-0123456789abcdef0123",
      file_set: ["site-content.yml"],
      head_sha: "b".repeat(40),
      map_blob_sha: gitBlobSha(mapBytes),
      map_bytes: mapBytes,
    }
    const harness = await makeProviderHarness(async (request) => {
      const endpoint = request.argv[4]
      if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
      assert.equal(endpoint, "/repos/owner/repository/pulls")
      if (mode === "timeout") throw new Error("command timeout Bearer secret-token C:\\provider\\stderr")
      return { status: 17, stdout: Buffer.alloc(0), stderr: Buffer.from("provider failure Bearer secret-token C:\\provider\\stderr", "utf8") }
    })
    try {
      await assert.rejects(harness.provider.createMappingPr(input), (error) => {
        assert.equal(error?.code, "pr_failed")
        assert.equal(error?.message, "pr_failed")
        assert.doesNotMatch(String(error), /secret-token|provider\\\\stderr/u)
        return true
      })
      assert.equal(harness.commandRequests.filter(({ argv }) => argv[4] === "/repos/owner/repository/pulls").length, 1)
    } finally {
      await rm(harness.root, { recursive: true, force: true })
    }
  }
})

test("mapping PR projection reads the exact open PR, file set, and map blob bytes", async () => {
  const mapBytes = Buffer.from("pages:\n  - source: Existing.md\n    route: /papers/existing/\n    layout: paper\n", "utf8")
  const input = {
    base: "main",
    branch: "t13/map/content-0123456789abcdef0123",
    file_set: ["site-content.yml"],
    head_sha: "c".repeat(40),
    map_blob_sha: gitBlobSha(mapBytes),
    map_bytes: mapBytes,
    pr_id: "101",
  }
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    if (endpoint === "/repos/owner/repository/pulls/101") return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({
        number: 101,
        base: { ref: "main" },
        head: { ref: input.branch, sha: input.head_sha },
        state: "open",
        merged_at: null,
      })),
      stderr: Buffer.alloc(0),
    }
    if (endpoint === "/repos/owner/repository/pulls/101/files?per_page=100&page=1") return {
      status: 0,
      stdout: Buffer.from(JSON.stringify([{ filename: "site-content.yml" }])),
      stderr: Buffer.alloc(0),
    }
    if (endpoint === `/repos/owner/repository/contents/site-content.yml?ref=${input.head_sha}`) return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({ type: "file", path: "site-content.yml", encoding: "base64", content: mapBytes.toString("base64"), sha: input.map_blob_sha })),
      stderr: Buffer.alloc(0),
    }
    throw new Error(`unexpected read PR endpoint: ${endpoint}`)
  })
  try {
    assert.deepEqual(await harness.provider.readMappingPr(input), {
      pr_id: "101",
      base: "main",
      branch: input.branch,
      head_sha: input.head_sha,
      file_set: ["site-content.yml"],
      map_blob_sha: input.map_blob_sha,
      map_bytes: mapBytes,
      state: "open",
      merged: false,
    })
    assert.deepEqual(harness.commandRequests.map(({ argv }) => argv[4]), [
      "/user",
      "/repos/owner/repository/pulls/101",
      "/repos/owner/repository/pulls/101/files?per_page=100&page=1",
      `/repos/owner/repository/contents/site-content.yml?ref=${input.head_sha}`,
    ])
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("mapping PR projection rejects duplicate file names and byte drift before returning", async () => {
  const mapBytes = Buffer.from("pages:\n  - source: Existing.md\n    route: /papers/existing/\n    layout: paper\n", "utf8")
  const input = {
    base: "main",
    branch: "t13/map/content-0123456789abcdef0123",
    file_set: ["site-content.yml"],
    head_sha: "d".repeat(40),
    map_blob_sha: gitBlobSha(mapBytes),
    map_bytes: mapBytes,
    pr_id: "102",
  }
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    if (endpoint === "/repos/owner/repository/pulls/102") return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({ number: 102, base: { ref: "main" }, head: { ref: input.branch, sha: input.head_sha }, state: "open", merged_at: null })),
      stderr: Buffer.alloc(0),
    }
    if (endpoint === "/repos/owner/repository/pulls/102/files?per_page=100&page=1") return {
      status: 0,
      stdout: Buffer.from(JSON.stringify([{ filename: "site-content.yml" }, { filename: "site-content.yml" }])),
      stderr: Buffer.alloc(0),
    }
    throw new Error(`unexpected malformed PR endpoint: ${endpoint}`)
  })
  try {
    await assert.rejects(harness.provider.readMappingPr(input), (error) => {
      assert.equal(error?.code, "pr_failed")
      assert.equal(error?.message, "pr_failed")
      return true
    })
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("listMatchingMappingPrs fails closed on malformed candidate summaries", async () => {
  const mapBytes = Buffer.from("pages:\n  - source: Existing.md\n    route: /papers/existing/\n    layout: paper\n", "utf8")
  const input = {
    base: "main",
    branch: "t13/map/content-0123456789abcdef0123",
    file_set: ["site-content.yml"],
    head_sha: "e".repeat(40),
    map_blob_sha: gitBlobSha(mapBytes),
    map_bytes: mapBytes,
  }
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    assert.match(endpoint, /^\/repos\/owner\/repository\/pulls\?/u)
    return {
      status: 0,
      stdout: Buffer.from(JSON.stringify([{
        number: 101,
        base: { ref: "main" },
        head: { ref: input.branch, sha: input.head_sha },
        state: "open",
      }])),
      stderr: Buffer.alloc(0),
    }
  })
  try {
    await assert.rejects(harness.provider.listMatchingMappingPrs(input), (error) => {
      assert.equal(error?.code, "pr_failed")
      assert.equal(error?.message, "pr_failed")
      return true
    })
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("mapping PR projection reads every page and proves the exact file and map blob bytes", async () => {
  const mapBytes = Buffer.from("pages:\n  - source: Existing.md\n    route: /papers/existing/\n    layout: paper\n", "utf8")
  const expected = {
    base: "main",
    branch: "t13/map/content-0123456789abcdef0123",
    file_set: ["site-content.yml"],
    head_sha: "a".repeat(40),
    map_blob_sha: gitBlobSha(mapBytes),
    map_bytes: mapBytes,
  }
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    if (endpoint.startsWith("/repos/owner/repository/pulls?")) {
      const page = Number(new URL(`https://fake.invalid${endpoint}`).searchParams.get("page"))
      if (page === 1) return {
        status: 0,
        stdout: Buffer.from(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
          number: index + 1,
          base: { ref: "main" },
          head: { ref: `other-${index}`, sha: "b".repeat(40) },
          state: "open",
          merged_at: null,
        })))),
        stderr: Buffer.alloc(0),
      }
      return {
        status: 0,
        stdout: Buffer.from(JSON.stringify(page === 2 ? [{
          number: 101,
          base: { ref: "main" },
          head: { ref: expected.branch, sha: expected.head_sha },
          state: "open",
          merged_at: null,
        }] : [])),
        stderr: Buffer.alloc(0),
      }
    }
    if (endpoint === "/repos/owner/repository/pulls/101") return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({
        number: 101,
        base: { ref: "main" },
        head: { ref: expected.branch, sha: expected.head_sha },
        state: "open",
        merged_at: null,
      })),
      stderr: Buffer.alloc(0),
    }
    if (endpoint.startsWith("/repos/owner/repository/pulls/101/files?")) return {
      status: 0,
      stdout: Buffer.from(JSON.stringify([{ filename: "site-content.yml" }])),
      stderr: Buffer.alloc(0),
    }
    if (endpoint === `/repos/owner/repository/contents/site-content.yml?ref=${expected.head_sha}`) return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({ type: "file", path: "site-content.yml", encoding: "base64", content: mapBytes.toString("base64"), sha: expected.map_blob_sha })),
      stderr: Buffer.alloc(0),
    }
    throw new Error(`unexpected fake command endpoint: ${endpoint}`)
  })
  try {
    const result = await harness.provider.listMatchingMappingPrs(expected)
    assert.deepEqual(result, [{
      pr_id: "101",
      base: "main",
      branch: expected.branch,
      head_sha: expected.head_sha,
      file_set: ["site-content.yml"],
      map_blob_sha: expected.map_blob_sha,
      map_bytes: mapBytes,
      state: "open",
      merged: false,
    }])
    const pages = harness.commandRequests
      .map((request) => request.argv[4])
      .filter((endpoint) => endpoint.startsWith("/repos/owner/repository/pulls?"))
      .map((endpoint) => new URL(`https://fake.invalid${endpoint}`).searchParams.get("page"))
    assert.deepEqual(pages, ["1", "2"])
    assert.equal(harness.httpRequests.length, 0)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("pinned CI fails closed when a paginated workflow response contains malformed data", async () => {
  const headSha = "c".repeat(40)
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    if (endpoint.startsWith("/repos/owner/repository/actions/workflows/t08-pinned-stack.yml/runs?")) return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({ total_count: 2, workflow_runs: [
        {},
        { id: 77, path: ".github/workflows/t08-pinned-stack.yml", head_sha: headSha },
      ] })),
      stderr: Buffer.alloc(0),
    }
    if (endpoint.startsWith("/repos/owner/repository/actions/runs/77/jobs?")) return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({ total_count: 1, jobs: [{ name: "Ubuntu pinned-stack acceptance", status: "completed", conclusion: "success" }] })),
      stderr: Buffer.alloc(0),
    }
    throw new Error(`unexpected fake CI endpoint: ${endpoint}`)
  })
  try {
    await assert.rejects(
      harness.provider.readRequiredCi({ head_sha: headSha, workflow: "t08-pinned-stack.yml", job: "Ubuntu pinned-stack acceptance" }),
      (error) => {
        assert.equal(error?.code, "ci_failed")
        return true
      },
    )
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("pinned CI reads one exact workflow run and required successful job projection", async () => {
  const headSha = "9".repeat(40)
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    if (endpoint === `/repos/owner/repository/actions/workflows/t08-pinned-stack.yml/runs?head_sha=${headSha}&per_page=100&page=1`) return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({ total_count: 1, workflow_runs: [{ id: "run-ci-1", path: ".github/workflows/t08-pinned-stack.yml", head_sha: headSha }] })),
      stderr: Buffer.alloc(0),
    }
    if (endpoint === "/repos/owner/repository/actions/runs/run-ci-1/jobs?per_page=100&page=1") return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({ total_count: 1, jobs: [{ name: "Ubuntu pinned-stack acceptance", status: "completed", conclusion: "success" }] })),
      stderr: Buffer.alloc(0),
    }
    throw new Error(`unexpected exact CI endpoint: ${endpoint}`)
  })
  try {
    assert.deepEqual(await harness.provider.readRequiredCi({
      head_sha: headSha,
      workflow: "t08-pinned-stack.yml",
      job: "Ubuntu pinned-stack acceptance",
    }), {
      head_sha: headSha,
      workflow: "t08-pinned-stack.yml",
      job: "Ubuntu pinned-stack acceptance",
      status: "completed",
      conclusion: "success",
    })
    assert.deepEqual(harness.commandRequests.map(({ argv }) => argv[4]), [
      "/user",
      `/repos/owner/repository/actions/workflows/t08-pinned-stack.yml/runs?head_sha=${headSha}&per_page=100&page=1`,
      "/repos/owner/repository/actions/runs/run-ci-1/jobs?per_page=100&page=1",
    ])
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("merged mapping PR projections prove PR number, base, head, and merge SHA while unmerged returns empty", async () => {
  const expectedHeadSha = "a".repeat(40)
  const mergeSha = "b".repeat(40)
  const input = { pr_id: "101", expected_head_sha: expectedHeadSha }
  let merged = false
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    assert.equal(endpoint, "/repos/owner/repository/pulls/101")
    return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({
        number: 101,
        base: { ref: "main" },
        head: { ref: "t13/map/content-0123456789abcdef0123", sha: expectedHeadSha },
        merged_at: merged ? "2026-08-10T00:00:00Z" : null,
        merge_commit_sha: merged ? mergeSha : null,
      })),
      stderr: Buffer.alloc(0),
    }
  })
  try {
    assert.deepEqual(await harness.provider.listMergedMappingPrs(input), [])
    merged = true
    assert.deepEqual(await harness.provider.listMergedMappingPrs(input), [{
      pr_id: "101",
      base: "main",
      head_sha: expectedHeadSha,
      merged: true,
      merge_sha: mergeSha,
    }])
    assert.deepEqual(await harness.provider.readMerge({ ...input, merge_sha: mergeSha }), {
      pr_id: "101",
      base: "main",
      head_sha: expectedHeadSha,
      merged: true,
      merge_sha: mergeSha,
    })
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("merged mapping PR projections fail closed on malformed or mismatched base/head/merge data", async () => {
  const expectedHeadSha = "c".repeat(40)
  const input = { pr_id: "102", expected_head_sha: expectedHeadSha }
  const variants = [
    { base: { ref: "release" }, head: { ref: "branch", sha: expectedHeadSha }, merged_at: "now", merge_commit_sha: "d".repeat(40) },
    { base: { ref: "main" }, head: { ref: "branch", sha: "e".repeat(40) }, merged_at: "now", merge_commit_sha: "d".repeat(40) },
    { base: { ref: "main" }, head: { ref: "branch", sha: expectedHeadSha }, merged_at: null, merge_commit_sha: "d".repeat(40) },
    { base: { ref: "main" }, head: { ref: "branch", sha: expectedHeadSha }, merge_commit_sha: "d".repeat(40) },
  ]
  for (const [index, variant] of variants.entries()) {
    const harness = await makeProviderHarness(async (request) => {
      const endpoint = request.argv[4]
      if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
      assert.equal(endpoint, `/repos/owner/repository/pulls/${input.pr_id}`)
      return { status: 0, stdout: Buffer.from(JSON.stringify({ number: Number(input.pr_id), ...variant })), stderr: Buffer.alloc(0) }
    })
    try {
      await assert.rejects(harness.provider.listMergedMappingPrs(input), (error) => {
        assert.equal(error?.code, "merge_failed", `variant ${index}`)
        assert.equal(error?.message, "merge_failed")
        return true
      })
    } finally {
      await rm(harness.root, { recursive: true, force: true })
    }
  }
})

test("squashMergeMappingPr sends one exact squash PUT and returns the verified merge SHA", async () => {
  const expectedHeadSha = "f".repeat(40)
  const mergeSha = "1".repeat(40)
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    assert.equal(endpoint, "/repos/owner/repository/pulls/101/merge")
    assert.deepEqual(request.argv.slice(4), [
      "/repos/owner/repository/pulls/101/merge",
      "--method",
      "PUT",
      "--input",
      "-",
    ])
    assert.deepEqual(request.input, Buffer.from(JSON.stringify({ sha: expectedHeadSha, merge_method: "squash" }), "utf8"))
    return { status: 0, stdout: Buffer.from(JSON.stringify({ merged: true, sha: mergeSha })), stderr: Buffer.alloc(0) }
  })
  try {
    assert.deepEqual(await harness.provider.squashMergeMappingPr({ pr_id: "101", expected_head_sha: expectedHeadSha }), { merge_sha: mergeSha })
    assert.equal(harness.commandRequests.filter(({ argv }) => argv[4] === "/repos/owner/repository/pulls/101/merge").length, 1)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("squashMergeMappingPr mutation failure is stable merge_failed with no retry", async () => {
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    assert.equal(endpoint, "/repos/owner/repository/pulls/101/merge")
    return { status: 17, stdout: Buffer.alloc(0), stderr: Buffer.from("merge failed Bearer secret-token C:\\provider\\merge.err", "utf8") }
  })
  try {
    await assert.rejects(harness.provider.squashMergeMappingPr({ pr_id: "101", expected_head_sha: "2".repeat(40) }), (error) => {
      assert.equal(error?.code, "merge_failed")
      assert.equal(error?.message, "merge_failed")
      assert.doesNotMatch(String(error), /secret-token|provider\\\\merge\.err/u)
      return true
    })
    assert.equal(harness.commandRequests.filter(({ argv }) => argv[4] === "/repos/owner/repository/pulls/101/merge").length, 1)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("listMatchingDeploymentRuns paginates and returns unique exact workflow/ref/head/title matches", async () => {
  const headSha = "3".repeat(40)
  const siteCommit = "4".repeat(40)
  const runName = `Deploy GitHub Pages ${siteCommit} (routine)`
  const pageOne = Array.from({ length: 100 }, (_, index) => ({
    id: `other-${index}`,
    path: ".github/workflows/deploy-pages.yml",
    head_branch: "main",
    head_sha: headSha,
    display_title: "Other deployment",
  }))
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    if (endpoint === `/repos/owner/repository/actions/workflows/deploy-pages.yml/runs?branch=main&head_sha=${headSha}&per_page=100&page=1`) return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({ total_count: 101, workflow_runs: pageOne })),
      stderr: Buffer.alloc(0),
    }
    if (endpoint === `/repos/owner/repository/actions/workflows/deploy-pages.yml/runs?branch=main&head_sha=${headSha}&per_page=100&page=2`) return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({ total_count: 101, workflow_runs: [{
        id: "run-target",
        path: ".github/workflows/deploy-pages.yml",
        head_branch: "main",
        head_sha: headSha,
        display_title: runName,
      }] })),
      stderr: Buffer.alloc(0),
    }
    throw new Error(`unexpected exact deployment-list endpoint: ${endpoint}`)
  })
  try {
    assert.deepEqual(await harness.provider.listMatchingDeploymentRuns({
      head_sha: headSha,
      ref: "main",
      run_name: runName,
      workflow: "deploy-pages.yml",
    }), [{ id: "run-target" }])
    assert.deepEqual(harness.commandRequests.map(({ argv }) => argv[4]), [
      "/user",
      `/repos/owner/repository/actions/workflows/deploy-pages.yml/runs?branch=main&head_sha=${headSha}&per_page=100&page=1`,
      `/repos/owner/repository/actions/workflows/deploy-pages.yml/runs?branch=main&head_sha=${headSha}&per_page=100&page=2`,
    ])
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("listMatchingDeploymentRuns fails closed on malformed entries and duplicate IDs", async () => {
  const headSha = "5".repeat(40)
  const siteCommit = "6".repeat(40)
  const runName = `Deploy GitHub Pages ${siteCommit} (routine)`
  const variants = [
    [{ id: "run-malformed" }],
    [
      { id: "run-duplicate", path: ".github/workflows/deploy-pages.yml", head_branch: "main", head_sha: headSha, display_title: "Other" },
      { id: "run-duplicate", path: ".github/workflows/deploy-pages.yml", head_branch: "main", head_sha: headSha, display_title: "Other" },
    ],
  ]
  for (const [index, payload] of variants.entries()) {
    const harness = await makeProviderHarness(async (request) => {
      const endpoint = request.argv[4]
      if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
      assert.equal(endpoint, `/repos/owner/repository/actions/workflows/deploy-pages.yml/runs?branch=main&head_sha=${headSha}&per_page=100&page=1`, `variant ${index}`)
      return { status: 0, stdout: Buffer.from(JSON.stringify({ total_count: payload.length, workflow_runs: payload })), stderr: Buffer.alloc(0) }
    })
    try {
      await assert.rejects(harness.provider.listMatchingDeploymentRuns({ head_sha: headSha, ref: "main", run_name: runName, workflow: "deploy-pages.yml" }), (error) => {
        assert.equal(error?.code, "dispatch_uncertain", `variant ${index}`)
        assert.equal(error?.message, "dispatch_uncertain")
        return true
      })
    } finally {
      await rm(harness.root, { recursive: true, force: true })
    }
  }
})

test("dispatchDeployment reads the exact main ref before one exact POST body", async () => {
  const expectedHeadSha = "7".repeat(40)
  const siteCommit = "8".repeat(40)
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    if (endpoint === "/repos/owner/repository/git/ref/heads/main") return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({ ref: "refs/heads/main", object: { type: "commit", sha: expectedHeadSha } })),
      stderr: Buffer.alloc(0),
    }
    assert.equal(endpoint, "/repos/owner/repository/actions/workflows/deploy-pages.yml/dispatches")
    assert.deepEqual(request.argv.slice(4), [
      "/repos/owner/repository/actions/workflows/deploy-pages.yml/dispatches",
      "--method",
      "POST",
      "--input",
      "-",
    ])
    assert.deepEqual(request.input, Buffer.from(JSON.stringify({
      ref: "main",
      inputs: { site_commit: siteCommit, publication_mode: "routine" },
    }), "utf8"))
    return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
  })
  try {
    assert.deepEqual(await harness.provider.dispatchDeployment({
      expected_head_sha: expectedHeadSha,
      inputs: { site_commit: siteCommit, publication_mode: "routine" },
      ref: "main",
      run_name: `Deploy GitHub Pages ${siteCommit} (routine)`,
      workflow: "deploy-pages.yml",
    }), { accepted: true })
    assert.equal(harness.commandRequests.filter(({ argv }) => argv[4] === "/repos/owner/repository/actions/workflows/deploy-pages.yml/dispatches").length, 1)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("dispatchDeployment mutation failure is stable dispatch_uncertain with no retry", async () => {
  const expectedHeadSha = "9".repeat(40)
  const siteCommit = "a".repeat(40)
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    if (endpoint === "/repos/owner/repository/git/ref/heads/main") return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({ ref: "refs/heads/main", object: { type: "commit", sha: expectedHeadSha } })),
      stderr: Buffer.alloc(0),
    }
    assert.equal(endpoint, "/repos/owner/repository/actions/workflows/deploy-pages.yml/dispatches")
    return { status: 17, stdout: Buffer.alloc(0), stderr: Buffer.from("dispatch failed Bearer secret-token C:\\provider\\dispatch.err", "utf8") }
  })
  try {
    await assert.rejects(harness.provider.dispatchDeployment({
      expected_head_sha: expectedHeadSha,
      inputs: { site_commit: siteCommit, publication_mode: "routine" },
      ref: "main",
      run_name: `Deploy GitHub Pages ${siteCommit} (routine)`,
      workflow: "deploy-pages.yml",
    }), (error) => {
      assert.equal(error?.code, "dispatch_uncertain")
      assert.equal(error?.message, "dispatch_uncertain")
      assert.doesNotMatch(String(error), /secret-token|provider\\\\dispatch\.err/u)
      return true
    })
    assert.equal(harness.commandRequests.filter(({ argv }) => argv[4] === "/repos/owner/repository/actions/workflows/deploy-pages.yml/dispatches").length, 1)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("readDeploymentRun returns the exact successful workflow-run projection", async () => {
  const headSha = "b".repeat(40)
  const siteCommit = "c".repeat(40)
  const input = { id: "run-1", site_commit: siteCommit, publication_mode: "routine", workflow: "deploy-pages.yml", ref: "main", head_sha: headSha }
  const runName = `Deploy GitHub Pages ${siteCommit} (routine)`
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    assert.equal(endpoint, "/repos/owner/repository/actions/runs/run-1")
    return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({
        id: "run-1",
        path: ".github/workflows/deploy-pages.yml",
        head_branch: "main",
        head_sha: headSha,
        display_title: runName,
        status: "completed",
        conclusion: "success",
      })),
      stderr: Buffer.alloc(0),
    }
  })
  try {
    assert.deepEqual(await harness.provider.readDeploymentRun(input), {
      id: "run-1",
      workflow: "deploy-pages.yml",
      ref: "main",
      head_sha: headSha,
      run_name: runName,
      inputs: { site_commit: siteCommit, publication_mode: "routine" },
      status: "completed",
      conclusion: "success",
    })
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("readDeploymentRun rejects wrong head, path, title, or terminal status as workflow_failed", async () => {
  const headSha = "d".repeat(40)
  const siteCommit = "e".repeat(40)
  const input = { id: "run-2", site_commit: siteCommit, publication_mode: "routine", workflow: "deploy-pages.yml", ref: "main", head_sha: headSha }
  const runName = `Deploy GitHub Pages ${siteCommit} (routine)`
  const variants = [
    { head_sha: "f".repeat(40) },
    { path: ".github/workflows/other.yml" },
    { display_title: "Deploy GitHub Pages wrong (routine)" },
    { status: "in_progress" },
  ]
  for (const [index, override] of variants.entries()) {
    const harness = await makeProviderHarness(async (request) => {
      const endpoint = request.argv[4]
      if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
      assert.equal(endpoint, "/repos/owner/repository/actions/runs/run-2", `variant ${index}`)
      return {
        status: 0,
        stdout: Buffer.from(JSON.stringify({
          id: "run-2",
          path: ".github/workflows/deploy-pages.yml",
          head_branch: "main",
          head_sha: headSha,
          display_title: runName,
          status: "completed",
          conclusion: "success",
          ...override,
        })),
        stderr: Buffer.alloc(0),
      }
    })
    try {
      await assert.rejects(harness.provider.readDeploymentRun(input), (error) => {
        assert.equal(error?.code, "workflow_failed", `variant ${index}`)
        assert.equal(error?.message, "workflow_failed")
        return true
      })
    } finally {
      await rm(harness.root, { recursive: true, force: true })
    }
  }
})

test("readPagesDeployment correlates the real Pages deployment shape from the authoritative run head", async () => {
  const siteCommit = "c".repeat(40)
  const headSha = "d".repeat(40)
  const runId = "12345"
  const projectUrl = "https://owner.github.io/repository/"
  const runName = `Deploy GitHub Pages ${siteCommit} (routine)`
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    if (endpoint === `/repos/owner/repository/actions/runs/${runId}`) return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({
        id: Number(runId),
        path: ".github/workflows/deploy-pages.yml",
        head_branch: "main",
        head_sha: headSha,
        display_title: runName,
        status: "completed",
        conclusion: "success",
      })),
      stderr: Buffer.alloc(0),
    }
    if (endpoint === `/repos/owner/repository/deployments?sha=${headSha}&environment=github-pages&per_page=100&page=1`) return {
      status: 0,
      stdout: Buffer.from(JSON.stringify([
        { id: 456, sha: headSha, ref: "main", task: "deploy", environment: "github-pages", environment_url: "https://stale.example.invalid/not-authoritative" },
        { id: 457, sha: headSha, ref: "main", task: "deploy", environment: "github-pages" },
      ])),
      stderr: Buffer.alloc(0),
    }
    if (endpoint === "/repos/owner/repository/deployments/456/statuses?per_page=100&page=1") return {
      status: 0,
      stdout: Buffer.from(JSON.stringify([
        { id: 1, state: "waiting", environment_url: projectUrl, log_url: null },
        { id: 2, state: "in_progress", environment_url: projectUrl, log_url: null },
        { id: 3, state: "inactive", environment_url: projectUrl, log_url: null },
        {
          id: 4,
          state: "success",
          environment_url: projectUrl,
          log_url: `https://github.com/owner/repository/actions/runs/${runId}/job/987654`,
        },
      ])),
      stderr: Buffer.alloc(0),
    }
    if (endpoint === "/repos/owner/repository/deployments/457/statuses?per_page=100&page=1") return {
      status: 0,
      stdout: Buffer.from(JSON.stringify([{
        id: 5,
        state: "success",
        environment_url: projectUrl,
        log_url: "https://github.com/owner/repository/actions/runs/99999/job/987655",
      }])),
      stderr: Buffer.alloc(0),
    }
    throw new Error(`unexpected Pages endpoint: ${endpoint}`)
  }, { projectUrl })
  try {
    assert.deepEqual(await harness.provider.readPagesDeployment({ run_id: runId, site_commit: siteCommit }), {
      deployment_id: "456",
      run_id: runId,
      site_commit: siteCommit,
      status: "success",
      url: projectUrl,
    })
    assert.deepEqual(harness.commandRequests.map(({ argv }) => argv[4]), [
      "/user",
      `/repos/owner/repository/actions/runs/${runId}`,
      `/repos/owner/repository/deployments?sha=${headSha}&environment=github-pages&per_page=100&page=1`,
      "/repos/owner/repository/deployments/456/statuses?per_page=100&page=1",
      "/repos/owner/repository/deployments/457/statuses?per_page=100&page=1",
    ])
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("readPagesDeployment fails closed when the authoritative run or Pages records do not match", async () => {
  const siteCommit = "e".repeat(40)
  const headSha = "f".repeat(40)
  const runId = "run-pages-1"
  const projectUrl = "https://owner.github.io/repository/"
  const runName = `Deploy GitHub Pages ${siteCommit} (routine)`
  const variants = [
    { path: ".github/workflows/other.yml" },
    { head_branch: "release" },
    { display_title: "Deploy GitHub Pages wrong (routine)" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { head_sha: "0".repeat(39) },
  ]
  for (const [index, override] of variants.entries()) {
    const harness = await makeProviderHarness(async (request) => {
      const endpoint = request.argv[4]
      if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
      assert.equal(endpoint, `/repos/owner/repository/actions/runs/${runId}`, `variant ${index}`)
      return {
        status: 0,
        stdout: Buffer.from(JSON.stringify({
          id: runId,
          path: ".github/workflows/deploy-pages.yml",
          head_branch: "main",
          head_sha: headSha,
          display_title: runName,
          status: "completed",
          conclusion: "success",
          ...override,
        })),
        stderr: Buffer.alloc(0),
      }
    }, { projectUrl })
    try {
      await assert.rejects(harness.provider.readPagesDeployment({ run_id: runId, site_commit: siteCommit }), (error) => {
        assert.equal(error?.code, "pages_failed", `variant ${index}`)
        assert.equal(error?.message, "pages_failed")
        return true
      })
      assert.equal(harness.commandRequests.length, 2, `variant ${index}`)
    } finally {
      await rm(harness.root, { recursive: true, force: true })
    }
  }
})

test("readPagesDeployment rejects duplicate or malformed deployment/status correlations", async () => {
  const siteCommit = "1".repeat(40)
  const headSha = "2".repeat(40)
  const runId = "777"
  const projectUrl = "https://owner.github.io/repository/"
  const runName = `Deploy GitHub Pages ${siteCommit} (routine)`
  const deploymentVariants = [
    [{ id: 10, sha: headSha, ref: "release", task: "deploy", environment: "github-pages" }],
    [{ id: 10, sha: headSha, ref: "main", task: "build", environment: "github-pages" }],
    [{ id: 10, sha: "3".repeat(40), ref: "main", task: "deploy", environment: "github-pages" }],
    [
      { id: 10, sha: headSha, ref: "main", task: "deploy", environment: "github-pages" },
      { id: 10, sha: headSha, ref: "main", task: "deploy", environment: "github-pages" },
    ],
  ]
  for (const [index, deployments] of deploymentVariants.entries()) {
    const harness = await makeProviderHarness(async (request) => {
      const endpoint = request.argv[4]
      if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
      if (endpoint === `/repos/owner/repository/actions/runs/${runId}`) return {
        status: 0,
        stdout: Buffer.from(JSON.stringify({ id: runId, path: ".github/workflows/deploy-pages.yml", head_branch: "main", head_sha: headSha, display_title: runName, status: "completed", conclusion: "success" })),
        stderr: Buffer.alloc(0),
      }
      assert.equal(endpoint, `/repos/owner/repository/deployments?sha=${headSha}&environment=github-pages&per_page=100&page=1`, `variant ${index}`)
      return { status: 0, stdout: Buffer.from(JSON.stringify(deployments)), stderr: Buffer.alloc(0) }
    }, { projectUrl })
    try {
      await assert.rejects(harness.provider.readPagesDeployment({ run_id: runId, site_commit: siteCommit }), (error) => {
        assert.equal(error?.code, "pages_failed", `variant ${index}`)
        assert.equal(error?.message, "pages_failed")
        return true
      })
      assert.equal(harness.commandRequests.length, 3, `variant ${index}`)
    } finally {
      await rm(harness.root, { recursive: true, force: true })
    }
  }
})

test("readPagesDeployment rejects two deployments correlated to the same exact workflow run", async () => {
  const siteCommit = "3".repeat(40)
  const headSha = "4".repeat(40)
  const runId = "778"
  const projectUrl = "https://owner.github.io/repository/"
  const runName = `Deploy GitHub Pages ${siteCommit} (routine)`
  const harness = await makeProviderHarness(async (request) => {
    const endpoint = request.argv[4]
    if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    if (endpoint === `/repos/owner/repository/actions/runs/${runId}`) return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({ id: runId, path: ".github/workflows/deploy-pages.yml", head_branch: "main", head_sha: headSha, display_title: runName, status: "completed", conclusion: "success" })),
      stderr: Buffer.alloc(0),
    }
    if (endpoint === `/repos/owner/repository/deployments?sha=${headSha}&environment=github-pages&per_page=100&page=1`) return {
      status: 0,
      stdout: Buffer.from(JSON.stringify([
        { id: 10, sha: headSha, ref: "main", task: "deploy", environment: "github-pages" },
        { id: 11, sha: headSha, ref: "main", task: "deploy", environment: "github-pages" },
      ])),
      stderr: Buffer.alloc(0),
    }
    const deploymentId = endpoint.includes("/deployments/10/") ? 10 : 11
    assert.equal(endpoint, `/repos/owner/repository/deployments/${deploymentId}/statuses?per_page=100&page=1`)
    return {
      status: 0,
      stdout: Buffer.from(JSON.stringify([{
        id: deploymentId,
        state: "success",
        environment_url: projectUrl,
        log_url: `https://github.com/owner/repository/actions/runs/${runId}/job/${deploymentId}`,
      }])),
      stderr: Buffer.alloc(0),
    }
  }, { projectUrl })
  try {
    await assert.rejects(harness.provider.readPagesDeployment({ run_id: runId, site_commit: siteCommit }), (error) => {
      assert.equal(error?.code, "pages_failed")
      assert.equal(error?.message, "pages_failed")
      return true
    })
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("readPagesDeployment rejects duplicate successful statuses and strict log URL violations", async () => {
  const siteCommit = "4".repeat(40)
  const headSha = "5".repeat(40)
  const runId = "888"
  const projectUrl = "https://owner.github.io/repository/"
  const runName = `Deploy GitHub Pages ${siteCommit} (routine)`
  const badLogUrls = [
    `http://github.com/owner/repository/actions/runs/${runId}/job/1`,
    `https://github.com/owner/repository/actions/runs/${runId}/job/0`,
    `https://github.com/owner/repository/actions/runs/${runId}/job/-1`,
    `https://github.com/owner/repository/actions/runs/${runId}/job/1?token=secret`,
    `https://evil.example/owner/repository/actions/runs/${runId}/job/1`,
    `https://github.com/owner/repository/actions/runs/other/job/1`,
  ]
  for (const [index, logUrl] of badLogUrls.entries()) {
    const harness = await makeProviderHarness(async (request) => {
      const endpoint = request.argv[4]
      if (endpoint === "/user") return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
      if (endpoint === `/repos/owner/repository/actions/runs/${runId}`) return {
        status: 0,
        stdout: Buffer.from(JSON.stringify({ id: runId, path: ".github/workflows/deploy-pages.yml", head_branch: "main", head_sha: headSha, display_title: runName, status: "completed", conclusion: "success" })),
        stderr: Buffer.alloc(0),
      }
      if (endpoint === `/repos/owner/repository/deployments?sha=${headSha}&environment=github-pages&per_page=100&page=1`) return {
        status: 0,
        stdout: Buffer.from(JSON.stringify([{ id: 10, sha: headSha, ref: "main", task: "deploy", environment: "github-pages" }])),
        stderr: Buffer.alloc(0),
      }
      assert.equal(endpoint, "/repos/owner/repository/deployments/10/statuses?per_page=100&page=1", `variant ${index}`)
      const statuses = index === 0
        ? [
          { id: 1, state: "success", environment_url: projectUrl, log_url: logUrl },
          { id: 2, state: "success", environment_url: projectUrl, log_url: `https://github.com/owner/repository/actions/runs/${runId}/job/2` },
        ]
        : [{ id: 1, state: "success", environment_url: projectUrl, log_url: logUrl }]
      return { status: 0, stdout: Buffer.from(JSON.stringify(statuses)), stderr: Buffer.alloc(0) }
    }, { projectUrl })
    try {
      await assert.rejects(harness.provider.readPagesDeployment({ run_id: runId, site_commit: siteCommit }), (error) => {
        assert.equal(error?.code, "pages_failed", `variant ${index}`)
        assert.equal(error?.message, "pages_failed")
        return true
      })
    } finally {
      await rm(harness.root, { recursive: true, force: true })
    }
  }
})

test("bounded HTTP transport accepts only exact anonymous HTTPS GET metadata requests", async () => {
  const requests = []
  const transport = createBoundedHttpTransport({
    execute: async (request) => {
      requests.push(request)
      return { status: 200, finalUrl: request.url }
    },
  })
  assert.equal(Object.getPrototypeOf(transport), Object.prototype)
  assert.deepEqual(Object.keys(transport), ["get"])
  const url = "https://owner.github.io/repository/papers/example/"
  assert.deepEqual(await transport.get({ url, timeoutMs: 10_000, maxResponseBytes: 1, method: "GET" }), { status: 200, finalUrl: url })
  assert.deepEqual(requests, [{ url, timeoutMs: 10_000, maxResponseBytes: 1, method: "GET" }])
})

test("bounded HTTP default request seam settles at headers and destroys the response without reading a body", async () => {
  let capturedOptions
  let responseDestroyed = false
  const request = (options, onResponse) => {
    capturedOptions = options
    const client = new EventEmitter()
    client.end = () => {
      queueMicrotask(() => {
        const response = new EventEmitter()
        response.statusCode = 200
        response.destroy = () => { responseDestroyed = true }
        onResponse(response)
      })
    }
    client.destroy = () => {}
    return client
  }
  const transport = createBoundedHttpTransport({ request })
  const url = "https://owner.github.io/repository/"
  assert.deepEqual(await transport.get({ url, timeoutMs: 10_000, maxResponseBytes: 1, method: "GET" }), { status: 200, finalUrl: url })
  assert.equal(responseDestroyed, true)
  assert.deepEqual(capturedOptions, {
    protocol: "https:",
    hostname: "owner.github.io",
    port: 443,
    path: "/repository/",
    method: "GET",
    agent: false,
    timeout: 10_000,
  })
})

test("bounded HTTP transport rejects credentials, query/hash, non-GET, invalid bounds, and raw seam failures", async () => {
  let executions = 0
  const transport = createBoundedHttpTransport({
    execute: async () => {
      executions += 1
      throw new Error("Bearer secret-token C:\\\\private\\\\response-body")
    },
  })
  const cases = [
    [{ url: "http://owner.github.io/repository/", timeoutMs: 10_000, maxResponseBytes: 1, method: "GET" }, "http_request_invalid"],
    [{ url: "https://user:pass@owner.github.io/repository/", timeoutMs: 10_000, maxResponseBytes: 1, method: "GET" }, "http_request_invalid"],
    [{ url: "https://owner.github.io/repository/?q=secret", timeoutMs: 10_000, maxResponseBytes: 1, method: "GET" }, "http_request_invalid"],
    [{ url: "https://owner.github.io/repository/#fragment", timeoutMs: 10_000, maxResponseBytes: 1, method: "GET" }, "http_request_invalid"],
    [{ url: "https://owner.github.io/repository/", timeoutMs: 10_000, maxResponseBytes: 1, method: "POST" }, "http_request_invalid"],
    [{ url: "https://owner.github.io/repository/", timeoutMs: 30_001, maxResponseBytes: 1, method: "GET" }, "http_request_invalid"],
    [{ url: "https://owner.github.io/repository/", timeoutMs: 10_000, maxResponseBytes: 0, method: "GET" }, "http_request_invalid"],
  ]
  for (const [request, code] of cases) {
    await assert.rejects(transport.get(request), (error) => {
      assert.equal(error?.code, code)
      assert.equal(error?.message, code)
      assert.doesNotMatch(String(error), /secret-token|private\\\\response-body/u)
      return true
    })
  }
  await assert.rejects(transport.get({ url: "https://owner.github.io/repository/", timeoutMs: 10_000, maxResponseBytes: 1, method: "GET" }), (error) => {
    assert.equal(error?.code, "http_failed")
    assert.equal(error?.message, "http_failed")
    assert.doesNotMatch(String(error), /secret-token|private\\\\response-body/u)
    return true
  })
  assert.equal(executions, 1)
})

test("provider config locks the project URL to the canonical owner-lowercase GitHub Pages URL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-provider-url-lock-"))
  const ghExecutable = path.join(root, process.platform === "win32" ? "gh.exe" : "gh")
  const ghConfigDir = path.join(root, "gh-config")
  await writeFile(ghExecutable, "fake gh")
  await mkdir(ghConfigDir)
  try {
    await assert.rejects(createRoutinePublicationProviderCapabilities({
      ghExecutable,
      ghConfigDir,
      repository: "Owner/Repo",
      actor: "actor",
      projectUrl: "https://owner.github.io/Repo/other/",
    }, {
      commandTransport: { async run() { return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) } } },
    }), (error) => {
      assert.equal(error?.code, "config_invalid")
      assert.equal(error?.message, "config_invalid")
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("provider dependencies construct the bounded HTTP default without invoking HTTP during constructor auth", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-provider-http-default-"))
  const ghExecutable = path.join(root, process.platform === "win32" ? "gh.exe" : "gh")
  const ghConfigDir = path.join(root, "gh-config")
  const commandRequests = []
  await writeFile(ghExecutable, "fake gh")
  await mkdir(ghConfigDir)
  try {
    const provider = await createRoutinePublicationProviderCapabilities({
      ghExecutable,
      ghConfigDir,
      repository: "Owner/Repo",
      actor: "actor",
    }, {
      commandTransport: { async run(request) {
        commandRequests.push(request)
        return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
      } },
    })
    assert.equal(typeof provider.anonymousSmoke, "function")
    assert.deepEqual(commandRequests.map(({ argv }) => argv[4]), ["/user"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("anonymousSmoke preserves homepage, route, asset, and custom-404 order with exact metadata requests", async () => {
  const siteCommit = "6".repeat(40)
  const target = {
    deployment_id: "10",
    run_id: "11",
    site_commit: siteCommit,
    status: "success",
    url: "https://owner.github.io/repository/",
  }
  const statuses = [200, 200, 200, 200, 200, 404]
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-provider-smoke-order-"))
  const ghExecutable = path.join(root, process.platform === "win32" ? "gh.exe" : "gh")
  const ghConfigDir = path.join(root, "gh-config")
  const httpRequests = []
  await writeFile(ghExecutable, "fake gh")
  await mkdir(ghConfigDir)
  const provider = await createRoutinePublicationProviderCapabilities({
    ghExecutable,
    ghConfigDir,
    repository: "owner/repository",
    actor: "actor",
  }, {
    commandTransport: { async run(request) {
      assert.equal(request.argv[4], "/user")
      return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) }
    } },
    httpTransport: { async get(request) {
      httpRequests.push(request)
      const status = statuses[httpRequests.length - 1]
      return { status, finalUrl: request.url }
    } },
  })
  try {
    const routes = ["/", "/papers/first/"]
    const assets = ["styles/site.css", "scripts/site.js"]
    const result = await provider.anonymousSmoke({ target, routes, assets, not_found: { path: "/__t13_missing__", expected_status: 404 } })
    assert.deepEqual(result, {
      target,
      homepage_status: 200,
      route_statuses: [200, 200],
      asset_statuses: [200, 200],
      not_found_status: 404,
    })
    assert.deepEqual(httpRequests.map(({ url }) => url), [
      "https://owner.github.io/repository/",
      "https://owner.github.io/repository/",
      "https://owner.github.io/repository/papers/first/",
      "https://owner.github.io/repository/styles/site.css",
      "https://owner.github.io/repository/scripts/site.js",
      "https://owner.github.io/repository/__t13_missing__",
    ])
    assert.ok(httpRequests.every((request) => Object.keys(request).sort().join("|") === "maxResponseBytes|method|timeoutMs|url"))
    assert.ok(httpRequests.every((request) => request.method === "GET" && request.maxResponseBytes === 1 && request.timeoutMs === 10_000))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("anonymousSmoke validates every input and request bound before the first GET", async () => {
  const siteCommit = "7".repeat(40)
  const target = {
    deployment_id: "10",
    run_id: "11",
    site_commit: siteCommit,
    status: "success",
    url: "https://owner.github.io/repository/",
  }
  const variants = [
    { target: { ...target, url: "https://evil.example/" }, routes: ["/ok/"], assets: [], not_found: { path: "/__t13_missing__", expected_status: 404 } },
    { target, routes: ["/bad?token=secret"], assets: [], not_found: { path: "/__t13_missing__", expected_status: 404 } },
    { target, routes: ["/ok/./normalized/"], assets: [], not_found: { path: "/__t13_missing__", expected_status: 404 } },
    { target, routes: ["/ok/%2e%2e/escaped/"], assets: [], not_found: { path: "/__t13_missing__", expected_status: 404 } },
    { target, routes: ["/ok/"], assets: ["../secret.js"], not_found: { path: "/__t13_missing__", expected_status: 404 } },
    { target, routes: ["/ok/"], assets: ["safe%2e%2e.js"], not_found: { path: "/__t13_missing__", expected_status: 404 } },
    { target, routes: ["/ok/"], assets: [], not_found: { path: "/wrong/", expected_status: 404 } },
    { target, routes: Array.from({ length: 511 }, () => "/ok/"), assets: [], not_found: { path: "/__t13_missing__", expected_status: 404 } },
  ]
  for (const [index, input] of variants.entries()) {
    const root = await mkdtemp(path.join(os.tmpdir(), `t13-provider-smoke-input-${index}-`))
    const ghExecutable = path.join(root, process.platform === "win32" ? "gh.exe" : "gh")
    const ghConfigDir = path.join(root, "gh-config")
    const httpRequests = []
    await writeFile(ghExecutable, "fake gh")
    await mkdir(ghConfigDir)
    const provider = await createRoutinePublicationProviderCapabilities({
      ghExecutable,
      ghConfigDir,
      repository: "owner/repository",
      actor: "actor",
    }, {
      commandTransport: { async run() { return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) } } },
      httpTransport: { async get(request) { httpRequests.push(request); return { status: 200, finalUrl: request.url } } },
    })
    try {
      await assert.rejects(provider.anonymousSmoke(input), (error) => {
        assert.equal(error?.code, "smoke_failed", `variant ${index}`)
        assert.equal(error?.message, "smoke_failed")
        assert.doesNotMatch(String(error), /secret|owner\.github|bad/u)
        return true
      })
      assert.deepEqual(httpRequests, [], `variant ${index}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("anonymousSmoke maps status, final URL, and transport failures to stable redacted smoke_failed", async () => {
  const siteCommit = "8".repeat(40)
  const target = {
    deployment_id: "10",
    run_id: "11",
    site_commit: siteCommit,
    status: "success",
    url: "https://owner.github.io/repository/",
  }
  const variants = [
    { response: { status: 200.5, finalUrl: target.url } },
    { response: { status: 200, finalUrl: "https://evil.example/" } },
    { error: new Error("Bearer secret-token C:\\\\private\\\\body-path") },
    { error: new Error("HTTP 401 Unauthorized Bearer secret-token C:\\\\private\\\\body-path") },
  ]
  for (const [index, variant] of variants.entries()) {
    const root = await mkdtemp(path.join(os.tmpdir(), `t13-provider-smoke-status-${index}-`))
    const ghExecutable = path.join(root, process.platform === "win32" ? "gh.exe" : "gh")
    const ghConfigDir = path.join(root, "gh-config")
    await writeFile(ghExecutable, "fake gh")
    await mkdir(ghConfigDir)
    const requests = []
    const provider = await createRoutinePublicationProviderCapabilities({
      ghExecutable,
      ghConfigDir,
      repository: "owner/repository",
      actor: "actor",
    }, {
      commandTransport: { async run() { return { status: 0, stdout: Buffer.from("actor\n"), stderr: Buffer.alloc(0) } } },
      httpTransport: { async get(request) {
        requests.push(request)
        if (variant.error) throw variant.error
        return variant.response
      } },
    })
    try {
      await assert.rejects(provider.anonymousSmoke({ target, routes: [], assets: [], not_found: { path: "/__t13_missing__", expected_status: 404 } }), (error) => {
        assert.equal(error?.code, "smoke_failed", `variant ${index}`)
        assert.equal(error?.message, "smoke_failed")
        assert.doesNotMatch(String(error), /secret-token|private\\\\body-path|evil\.example/u)
        return true
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("local-Git configuration requires a verified absolute Git executable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-adapter-config-"))
  const operationRoot = path.join(root, "operation")
  const gitRoot = path.join(root, "git")
  await mkdir(operationRoot)
  await mkdir(gitRoot)
  try {
    assert.throws(
      () => createRoutinePublicationLocalGitCapabilities({
        gitRoot,
        remote: "origin",
        mainRef: "refs/heads/main",
        ghPagesRef: "refs/heads/gh-pages",
        operationRoot,
      }),
      (error) => {
        assert.equal(error?.code, "config_invalid")
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("bounded transport rejects a non-absolute executable before execution", async () => {
  let executions = 0
  const transport = createBoundedCommandTransport({
    execute: async () => {
      executions += 1
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    },
  })
  await assert.rejects(
    transport.run({ argv: ["git", "--version"], cwd: process.cwd(), input: Buffer.alloc(0) }),
    (error) => {
      assert.equal(error?.code, "command_request_invalid")
      return true
    },
  )
  assert.equal(executions, 0)
})

test("bounded transport rejects input above the fixed 16 MiB byte cap before execution", async () => {
  let executions = 0
  const transport = createBoundedCommandTransport({
    execute: async () => {
      executions += 1
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    },
  })
  await assert.rejects(
    transport.run({
      argv: [GIT_EXECUTABLE, "hash-object", "--stdin"],
      cwd: process.cwd(),
      input: Buffer.alloc(SAFE_INPUT_BYTES + 1),
    }),
    (error) => {
      assert.equal(error?.code, "command_input_limit")
      return true
    },
  )
  assert.equal(executions, 0)
})

test("bounded transport rejects every supplied environment key outside the internal override set", async () => {
  let executions = 0
  const transport = createBoundedCommandTransport({
    execute: async () => {
      executions += 1
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    },
  })
  await assert.rejects(
    transport.run({
      argv: [GIT_EXECUTABLE, "status"],
      cwd: process.cwd(),
      env: { GIT_DIR: path.join(process.cwd(), "attacker.git") },
    }),
    (error) => {
      assert.equal(error?.code, "command_request_invalid")
      return true
    },
  )
  assert.equal(executions, 0)
})

test("bounded transport permits GH_CONFIG_DIR only for an absolute ordinary gh executable and rejects it for Git", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-adapter-gh-config-"))
  const ghExecutable = path.join(root, process.platform === "win32" ? "gh.exe" : "gh")
  const ghConfigDir = path.join(root, "gh-config")
  await writeFile(ghExecutable, "fake gh")
  await mkdir(ghConfigDir)
  const requests = []
  const transport = createBoundedCommandTransport({
    execute: async (request) => {
      requests.push(request)
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    },
  })
  try {
    await assert.rejects(transport.run({
      argv: [GIT_EXECUTABLE, "status"],
      cwd: root,
      env: { GH_CONFIG_DIR: ghConfigDir },
    }), (error) => {
      assert.equal(error?.code, "command_request_invalid")
      return true
    })
    await assert.rejects(transport.run({
      argv: [ghExecutable, "api", "/user"],
      cwd: root,
      env: { GH_CONFIG_DIR: "relative-config" },
    }), (error) => {
      assert.equal(error?.code, "command_request_invalid")
      return true
    })
    const result = await transport.run({
      argv: [ghExecutable, "api", "/user"],
      cwd: root,
      env: { GH_CONFIG_DIR: ghConfigDir },
    })
    assert.equal(result.status, 0)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].env.GH_CONFIG_DIR, ghConfigDir)
    assert.equal(requests[0].env.PATH, path.dirname(ghExecutable))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("local-Git transport uses the exact configured executable and excludes ambient Git and secret authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-adapter-env-"))
  const operationRoot = path.join(root, "operation")
  const gitRoot = path.join(root, "git")
  await mkdir(operationRoot)
  await mkdir(gitRoot)
  const dangerousNames = [
    "HOME",
    "USERPROFILE",
    "PATH",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_CONFIG_GLOBAL",
    "GIT_SSH_COMMAND",
    "GIT_ASKPASS",
    "AWS_SECRET_ACCESS_KEY",
    "ADAPTER_SECRET_TOKEN",
  ]
  const previous = new Map(dangerousNames.map((name) => [name, process.env[name]]))
  const expectedSha = "b".repeat(40)
  const recorded = []
  try {
    for (const name of dangerousNames) process.env[name] = "ambient-secret-authority"
    const commandTransport = createBoundedCommandTransport({
      execute: async (request) => {
        recorded.push(request)
        return {
          status: 0,
          stdout: Buffer.from(`${expectedSha}\trefs/heads/gh-pages\n`, "utf8"),
          stderr: Buffer.alloc(0),
        }
      },
    })
    const localGit = createRoutinePublicationLocalGitCapabilities({
      gitRoot,
      gitExecutable: GIT_EXECUTABLE,
      remote: "origin",
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      operationRoot,
    }, { commandTransport })
    assert.equal(await localGit.readGhPagesHead({}), expectedSha)
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].argv[0], GIT_EXECUTABLE)
    assert.equal(recorded[0].argv[1], "ls-remote")
    for (const name of dangerousNames) {
      if (name !== "PATH" && name !== "GIT_CONFIG_GLOBAL") assert.equal(recorded[0].env[name], undefined, name)
    }
    assert.notEqual(recorded[0].env.PATH, "ambient-secret-authority")
    assert.notEqual(recorded[0].env.GIT_CONFIG_GLOBAL, "ambient-secret-authority")
    assert.equal(recorded[0].env.GIT_TERMINAL_PROMPT, "0")
    assert.equal(recorded[0].env.GIT_OPTIONAL_LOCKS, "0")
    assert.equal(recorded[0].env.GIT_CONFIG_NOSYSTEM, "1")
    assert.equal(recorded[0].env.GIT_CONFIG_GLOBAL, process.platform === "win32" ? "NUL" : os.devNull)
    assert.equal(recorded[0].env.PATH, path.dirname(GIT_EXECUTABLE))
    const allowedNames = new Set([
      "SystemRoot",
      "WINDIR",
      "ComSpec",
      "PATHEXT",
      "TEMP",
      "TMP",
      "TMPDIR",
      "PATH",
      "LC_ALL",
      "LANG",
      "GIT_TERMINAL_PROMPT",
      "GIT_OPTIONAL_LOCKS",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_GLOBAL",
    ])
    assert.ok(Object.keys(recorded[0].env).every((name) => allowedNames.has(name)), Object.keys(recorded[0].env))
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test("local-Git capabilities are a plain object with the exact consumer methods", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-adapter-shape-"))
  const operationRoot = path.join(root, "operation")
  const gitRoot = path.join(root, "git")
  await mkdir(operationRoot)
  await mkdir(gitRoot)
  try {
    const capabilities = createRoutinePublicationLocalGitCapabilities({
      gitRoot,
      gitExecutable: GIT_EXECUTABLE,
      remote: "origin",
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      operationRoot,
    }, {
      commandTransport: { async run() { throw new Error("not reached") } },
    })
    assert.equal(Object.getPrototypeOf(capabilities), Object.prototype)
    assert.deepEqual(Object.keys(capabilities).sort(), [
      "createGhPagesCandidate",
      "createMappingBranch",
      "pushGhPages",
      "readCandidateCommit",
      "readGhPagesHead",
      "readRemoteAuthority",
    ])
    for (const name of Object.keys(capabilities)) {
      const descriptor = Object.getOwnPropertyDescriptor(capabilities, name)
      assert.equal(typeof descriptor?.value, "function", name)
      assert.equal(descriptor?.get, undefined, name)
      assert.equal(descriptor?.set, undefined, name)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd,
    encoding: options.encoding ?? "utf8",
    input: options.input,
    windowsHide: true,
  })
  assert.equal(result.status, 0, `fixture git failed: ${args.join(" ")}\n${String(result.stderr)}`)
  return result.stdout
}

async function makeGitFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-adapter-git-"))
  const remote = path.join(root, "remote.git")
  const gitRoot = path.join(root, "source")
  const operationRoot = path.join(root, "operation")
  const candidatePath = path.join(operationRoot, "content-0123456789abcdef0123", "handoff", "site")
  await mkdir(operationRoot)
  git(["init", "--bare", remote])
  git(["init", gitRoot])
  git(["-C", gitRoot, "config", "user.name", "T13 adapter fixture"])
  git(["-C", gitRoot, "config", "user.email", "fixture@example.invalid"])
  const initialMap = Buffer.from([
    "pages:",
    "  - source: Existing.md",
    "    route: /papers/existing/",
    "    layout: paper",
    "",
  ].join("\n"), "utf8")
  await writeFile(path.join(gitRoot, "site-content.yml"), initialMap)
  await writeFile(path.join(gitRoot, "README.md"), "fixture main\n")
  git(["-C", gitRoot, "add", "."])
  git(["-C", gitRoot, "commit", "-m", "main baseline"])
  git(["-C", gitRoot, "branch", "-M", "main"])
  git(["-C", gitRoot, "remote", "add", "origin", remote])
  git(["-C", gitRoot, "push", "origin", "main"])
  const mainSha = String(git(["-C", gitRoot, "rev-parse", "HEAD"])).trim()
  git(["-C", gitRoot, "checkout", "--orphan", "gh-pages"])
  git(["-C", gitRoot, "rm", "-rf", "."])
  for (const [relative, bytes] of [
    ["site/index.html", Buffer.from("<html>baseline</html>\n")],
    ["site/404.html", Buffer.from("<html>404</html>\n")],
    ["site/.nojekyll", Buffer.alloc(0)],
  ]) {
    const absolute = path.join(gitRoot, ...relative.split("/"))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, bytes)
  }
  git(["-C", gitRoot, "add", "."])
  git(["-C", gitRoot, "commit", "-m", "gh-pages baseline"])
  git(["-C", gitRoot, "push", "origin", "gh-pages"])
  const ghPagesSha = String(git(["-C", gitRoot, "rev-parse", "HEAD"])).trim()
  for (const [relative, bytes] of [
    ["index.html", Buffer.from("<html>candidate</html>\n")],
    ["404.html", Buffer.from("<html>candidate 404</html>\n")],
    [".nojekyll", Buffer.alloc(0)],
    ["papers/new/index.html", Buffer.from("<html>new</html>\n")],
  ]) {
    const absolute = path.join(candidatePath, ...relative.split("/"))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, bytes)
  }
  return { root, remote, gitRoot, operationRoot, candidatePath, initialMap, mainSha, ghPagesSha }
}

test("local-Git capabilities use isolated plumbing for exact refs, commits, tree bytes, and ordinary push", async () => {
  const fixture = await makeGitFixture()
  try {
    const localGit = createRoutinePublicationLocalGitCapabilities({
      gitRoot: fixture.gitRoot,
      gitExecutable: GIT_EXECUTABLE,
      remote: "origin",
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      operationRoot: fixture.operationRoot,
    })
    const beforeHead = String(git(["-C", fixture.gitRoot, "rev-parse", "HEAD"])).trim()
    const beforeStatus = String(git(["-C", fixture.gitRoot, "status", "--porcelain"])).trim()
    const authority = await localGit.readRemoteAuthority({})
    assert.equal(authority.main_sha, fixture.mainSha)
    assert.equal(authority.gh_pages_sha, fixture.ghPagesSha)
    assert.deepEqual(authority.map_bytes, fixture.initialMap)

    const proposedMap = Buffer.from([
      "pages:",
      "  - source: Existing.md",
      "    route: /papers/existing/",
      "    layout: paper",
      "  - source: New.md",
      "    route: /papers/new/",
      "    layout: paper",
      "",
    ].join("\n"), "utf8")
    const branch = "t13/map/content-0123456789abcdef0123"
    const mapping = await localGit.createMappingBranch({
      base_ref: "main",
      base_sha: fixture.mainSha,
      branch,
      map_bytes: proposedMap,
    })
    assert.equal(mapping.branch, branch)
    assert.equal(mapping.base_sha, fixture.mainSha)
    assert.deepEqual(mapping.map_bytes, proposedMap)
    assert.equal(String(git(["--git-dir", fixture.remote, "rev-parse", `refs/heads/${branch}`])).trim(), mapping.head_sha)
    assert.equal(String(git(["--git-dir", fixture.remote, "rev-parse", `${mapping.head_sha}^`])).trim(), fixture.mainSha)
    assert.deepEqual(String(git(["--git-dir", fixture.remote, "diff", "--name-only", `${fixture.mainSha}..${mapping.head_sha}`])).trim().split(/\r?\n/u), ["site-content.yml"])
    assert.deepEqual(Buffer.from(git(["--git-dir", fixture.remote, "show", `${mapping.head_sha}:site-content.yml`], { encoding: "buffer" })), proposedMap)

    const candidate = await localGit.createGhPagesCandidate({
      base_sha: fixture.ghPagesSha,
      candidate_path: fixture.candidatePath,
      renderer_main_sha: "a".repeat(40),
    })
    assert.equal(String(git(["-C", fixture.gitRoot, "rev-parse", `${candidate.candidate_sha}^`])).trim(), fixture.ghPagesSha)
    assert.match(String(git(["-C", fixture.gitRoot, "show", "-s", "--format=%B", candidate.candidate_sha])), /Renderer-Main-SHA: a{40}/u)
    assert.deepEqual(String(git(["-C", fixture.gitRoot, "ls-tree", "-r", "--name-only", candidate.candidate_sha])).trim().split(/\r?\n/u), [
      "site/.nojekyll",
      "site/404.html",
      "site/index.html",
      "site/papers/new/index.html",
    ])
    const readback = await localGit.readCandidateCommit({ candidate_sha: candidate.candidate_sha })
    assert.deepEqual(readback.files.map(({ relative }) => relative), [
      "site/.nojekyll",
      "site/404.html",
      "site/index.html",
      "site/papers/new/index.html",
    ])
    assert.ok(readback.files.every(({ mode, type, bytes }) => mode === "100644" && type === "blob" && Buffer.isBuffer(bytes)))
    assert.deepEqual(readback.files.find(({ relative }) => relative === "site/papers/new/index.html").bytes, Buffer.from("<html>new</html>\n"))

    const pushed = await localGit.pushGhPages({ candidate_sha: candidate.candidate_sha, expected_old_sha: fixture.ghPagesSha })
    assert.deepEqual(pushed, { remote_sha: candidate.candidate_sha })
    assert.equal(await localGit.readGhPagesHead({}), candidate.candidate_sha)
    assert.equal(String(git(["-C", fixture.gitRoot, "rev-parse", "HEAD"])).trim(), beforeHead)
    assert.equal(String(git(["-C", fixture.gitRoot, "status", "--porcelain"])).trim(), beforeStatus)
    assert.deepEqual((await readdir(fixture.operationRoot)).filter((name) => name.startsWith(".t13-git-")), [])
    assert.deepEqual(await readFile(path.join(fixture.candidatePath, "papers", "new", "index.html")), Buffer.from("<html>new</html>\n"))
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

const processTreeFixtureSource = String.raw`
const fs = require("node:fs")
const { spawn } = require("node:child_process")

const [pidFile, sentinelFile, mode] = process.argv.slice(1)
const descendantSource = [
  'const fs = require("node:fs")',
  'const sentinelFile = process.argv[1]',
  'process.on("SIGTERM", () => {})',
  'let writes = 0',
  'const timer = setInterval(() => {',
  '  if (writes >= 200) { clearInterval(timer); return }',
  '  fs.appendFileSync(sentinelFile, "sentinel" + String.fromCharCode(10))',
  '  writes += 1',
  '}, 10)',
].join(String.fromCharCode(10))
const descendant = spawn(process.execPath, ["-e", descendantSource, sentinelFile], {
  stdio: "ignore",
})
fs.writeFileSync(pidFile, JSON.stringify({ leader: process.pid, descendant: descendant.pid }))
if (mode === "overflow") {
  setInterval(() => process.stdout.write("x".repeat(4096)), 1)
}
process.on("SIGTERM", () => {
  if (process.platform !== "win32") process.exit(0)
})
setInterval(() => {}, 1000)
`

const earlyExitFixtureSource = String.raw`
const fs = require("node:fs")
const pidFile = process.argv[1]
fs.writeFileSync(pidFile, String(process.pid))
process.exit(0)
`

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForJsonFile(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"))
      if (Number.isInteger(parsed.leader) && parsed.leader > 0 && Number.isInteger(parsed.descendant) && parsed.descendant > 0) return parsed
    } catch {}
    await sleep(10)
  }
  throw new Error("process-tree fixture did not record both PIDs")
}

async function waitForPidFile(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await readFile(file, "utf8"), 10)
      if (Number.isInteger(pid) && pid > 0) return pid
    } catch {}
    await sleep(10)
  }
  throw new Error("early-exit fixture did not record its PID")
}

async function waitForSentinel(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const bytes = await readFile(file)
      if (bytes.length > 0) return bytes
    } catch {}
    await sleep(10)
  }
  throw new Error("process-tree fixture did not write its sentinel")
}

function pidExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === "ESRCH") return false
    return true
  }
}

async function waitForPidsAbsent(record, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidExists(record.leader) && !pidExists(record.descendant)) return
    await sleep(25)
  }
  assert.equal(pidExists(record.leader), false, "leader process remains after transport settlement")
  assert.equal(pidExists(record.descendant), false, "descendant process remains after transport settlement")
}

async function waitForPidAbsent(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidExists(pid)) return
    await sleep(25)
  }
  assert.equal(pidExists(pid), false, "early-exit child remains after transport settlement")
}

function cleanupProcessTree(record) {
  if (!record) return
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(record.leader), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(-record.leader, "SIGKILL")
  } catch {}
}

async function assertDefaultTransportStopsOwnedTree(mode, expectedCode) {
  const root = await mkdtemp(path.join(os.tmpdir(), `t13-adapter-tree-${mode}-`))
  const pidFile = path.join(root, "pids.json")
  const sentinelFile = path.join(root, "sentinel.log")
  let record
  try {
    const transport = createBoundedCommandTransport()
    const run = transport.run({
      argv: [process.execPath, "-e", processTreeFixtureSource, pidFile, sentinelFile, mode],
      cwd: root,
      maxOutputBytes: mode === "overflow" ? 1_024 : 1_024 * 1_024,
      shell: false,
      timeoutMs: mode === "overflow" ? 5_000 : 150,
    })
    record = await waitForJsonFile(pidFile)
    const before = await waitForSentinel(sentinelFile)
    await assert.rejects(run, (error) => {
      assert.equal(error?.code, expectedCode)
      return true
    })
    const settled = await readFile(sentinelFile)
    assert.ok(settled.length >= before.length)
    await sleep(150)
    assert.deepEqual(await readFile(sentinelFile), settled, "sentinel continued after transport settlement")
    await waitForPidsAbsent(record)
  } finally {
    cleanupProcessTree(record)
    try {
      await waitForPidsAbsent(record, 1_000)
    } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

test("default bounded transport proves the owned process tree is gone after timeout", async () => {
  await assertDefaultTransportStopsOwnedTree("timeout", "command_timeout")
})

test("default bounded transport proves the owned process tree is gone after stdout overflow", async () => {
  await assertDefaultTransportStopsOwnedTree("overflow", "command_output_limit")
})

test("default bounded transport reports early stdin failure without uncaught EPIPE or a live child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-adapter-input-failure-"))
  const pidFile = path.join(root, "pid.txt")
  let pid
  const uncaught = []
  const onUncaught = (error) => uncaught.push(error)
  process.on("uncaughtException", onUncaught)
  try {
    const transport = createBoundedCommandTransport()
    const run = transport.run({
      argv: [process.execPath, "-e", earlyExitFixtureSource, pidFile],
      cwd: root,
      input: Buffer.alloc(SAFE_INPUT_BYTES),
      shell: false,
      timeoutMs: 5_000,
    })
    pid = await waitForPidFile(pidFile)
    await assert.rejects(run, (error) => {
      assert.equal(error?.code, "command_input_failed")
      return true
    })
    assert.deepEqual(uncaught, [])
    await waitForPidAbsent(pid)
  } finally {
    process.off("uncaughtException", onUncaught)
    if (pid && pidExists(pid)) {
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
        } else {
          process.kill(pid, "SIGKILL")
        }
      } catch {}
    }
    await rm(root, { recursive: true, force: true })
  }
})

test("default bounded transport preserves undefined and empty input success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-adapter-empty-input-"))
  try {
    for (const input of [undefined, Buffer.alloc(0)]) {
      const result = await createBoundedCommandTransport().run({
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: root,
        ...(input === undefined ? {} : { input }),
        shell: false,
        timeoutMs: 5_000,
      })
      assert.equal(result.status, 0)
      assert.deepEqual(result.stdout, Buffer.alloc(0))
      assert.deepEqual(result.stderr, Buffer.alloc(0))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("default bounded transport preserves stdout and stderr for finite nonzero exit status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "t13-adapter-nonzero-status-"))
  try {
    const result = await createBoundedCommandTransport().run({
      argv: [process.execPath, "-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(23)"],
      cwd: root,
      shell: false,
      timeoutMs: 5_000,
    })
    assert.equal(result.status, 23)
    assert.deepEqual(result.stdout, Buffer.from("out"))
    assert.deepEqual(result.stderr, Buffer.from("err"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("default bounded transport fails closed when taskkill exits nonzero", { skip: process.platform !== "win32" }, async () => {
  await assert.rejects(
    _testOnlyTerminateOwnedProcess({ pid: 2_147_483_646 }),
    (error) => {
      assert.equal(error?.code, "termination_failed")
      return true
    },
  )
})

test("local-Git retains operation custody when termination cannot be proven", async () => {
  const fixture = await makeGitFixture()
  try {
    const commandTransport = {
      run: async (request) => {
        const command = request.argv[1]
        if (command === "ls-remote") {
          return { status: 0, stdout: Buffer.from(`${fixture.mainSha}\trefs/heads/main\n`), stderr: Buffer.alloc(0) }
        }
        if (command === "show") {
          return { status: 0, stdout: Buffer.from(fixture.initialMap), stderr: Buffer.alloc(0) }
        }
        throw _testOnlyAdapterFailure("termination_failed")
      },
    }
    const localGit = createRoutinePublicationLocalGitCapabilities(
      {
        gitRoot: fixture.gitRoot,
        gitExecutable: GIT_EXECUTABLE,
        remote: "origin",
        mainRef: "refs/heads/main",
        ghPagesRef: "refs/heads/gh-pages",
        operationRoot: fixture.operationRoot,
      },
      { commandTransport },
    )
    await assert.rejects(
      localGit.createMappingBranch({
        base_ref: "main",
        base_sha: fixture.mainSha,
        branch: "t13/map/content-fedcba9876543210fedc",
        map_bytes: Buffer.from("version: 1\nitems: []\n"),
      }),
      (error) => {
        assert.equal(error?.code, "termination_failed")
        return true
      },
    )
    const retained = (await readdir(fixture.operationRoot)).filter((name) => name.startsWith(".t13-git-"))
    assert.equal(retained.length, 1)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})
