// @ts-nocheck -- the fixture owns temporary repositories and fake provider seams.
import assert from "node:assert/strict"
import { rmSync, writeFileSync } from "node:fs"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

import { routinePublicationHandoff } from "../lib/routine-publication-handoff.mjs"

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const gitBlobSha = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: options.encoding ?? "utf8",
    input: options.input,
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`git fixture command failed: ${args.join(" ")}\n${String(result.stderr)}`)
  }
  return result.stdout
}

async function put(root, relative, bytes) {
  const absolute = path.join(root, ...relative.split("/"))
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, bytes)
}

async function snapshot(root, relative = "") {
  const directory = path.join(root, ...relative ? relative.split("/") : [])
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await snapshot(root, child))
    else {
      assert.equal(entry.isFile(), true, `fixture entry must be regular: ${child}`)
      files.push({ relative: child, bytes: await readFile(path.join(root, ...child.split("/"))) })
    }
  }
  return files
}

function siteDigest(files) {
  const rows = [...files]
    .sort((left, right) => Buffer.compare(Buffer.from(left.relative), Buffer.from(right.relative)))
    .map(({ relative, bytes }) => `${relative}\0${sha256(bytes)}\n`)
    .join("")
  return sha256(Buffer.from(rows, "utf8"))
}

function openPr(input, overrides = {}) {
  return {
    pr_id: "pr-pub-06",
    base: input.base,
    branch: input.branch,
    head_sha: input.head_sha,
    file_set: [...input.file_set],
    map_blob_sha: input.map_blob_sha,
    map_bytes: Buffer.from(input.map_bytes),
    state: "open",
    merged: false,
    ...overrides,
  }
}

function mergedPr(input, mergeSha, overrides = {}) {
  return {
    pr_id: input.pr_id,
    base: "main",
    head_sha: input.expected_head_sha,
    merged: true,
    merge_sha: mergeSha,
    ...overrides,
  }
}

async function commitSnapshot(remote, commit) {
  const names = String(git(["--git-dir", remote, "ls-tree", "-r", "--name-only", commit]))
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
  return Promise.all(names.map(async (relative) => ({
    relative,
    bytes: Buffer.from(git(["--git-dir", remote, "show", `${commit}:${relative}`], { encoding: "buffer" })),
  })))
}

async function commitEntries(remote, commit) {
  const output = String(git(["--git-dir", remote, "ls-tree", "-r", commit])).trim()
  if (!output) return []
  return Promise.all(output.split(/\r?\n/u).map(async (line) => {
    const match = /^(\d+)\s+(\w+)\s+[0-9a-f]+\t(.+)$/u.exec(line)
    assert(match, `fixture tree entry must be parseable: ${line}`)
    const [, mode, type, relative] = match
    return {
      relative,
      mode,
      type,
      bytes: Buffer.from(git(["--git-dir", remote, "show", `${commit}:${relative}`], { encoding: "buffer" })),
    }
  }))
}

function commitTree(remote, worktree, baseSha, message, updateRef, mutate, { resetWorktree = true } = {}) {
  const index = path.join(path.dirname(worktree), `.index-${process.pid}-${Math.random().toString(16).slice(2)}`)
  const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "Publication fixture", GIT_AUTHOR_EMAIL: "publication@example.test", GIT_COMMITTER_NAME: "Publication fixture", GIT_COMMITTER_EMAIL: "publication@example.test" }
  try {
    git(["--git-dir", remote, "read-tree", ...(baseSha ? [baseSha] : ["--empty"])], { env })
    if (baseSha && resetWorktree) git(["--git-dir", remote, "--work-tree", worktree, "read-tree", "-u", "--reset", baseSha], { env })
    mutate()
    git(["--git-dir", remote, "--work-tree", worktree, "add", "-A", "--", "."], { env })
    const tree = String(git(["--git-dir", remote, "write-tree"], { env })).trim()
    const commit = String(git(["--git-dir", remote, "commit-tree", tree, ...(baseSha ? ["-p", baseSha] : [])], { env, input: `${message}\n` })).trim()
    if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("fixture commit was not a SHA")
    if (updateRef) git(["--git-dir", remote, "update-ref", updateRef, commit])
    return commit
  } finally {
    try { git(["--git-dir", remote, "update-ref", `refs/pub-fixture/noop-${path.basename(index)}`, "0000000000000000000000000000000000000000"]) } catch {}
    // The temporary index is outside the repository and is intentionally best-effort cleaned.
    try { rmSync(index, { force: true }) } catch {}
  }
}

async function makeFixture({ lane = "content", mapChanged = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pub-06-tracer-"))
  const remote = path.join(root, "remote.git")
  const seed = path.join(root, "seed")
  const session = path.join(root, "work", "content-0123456789abcdef0123")
  const laneDirectory = lane === "content" ? "handoff" : "main-handoff"
  const candidateRoot = path.join(session, laneDirectory, "site")
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
  const initialMap = mapChanged
    ? Buffer.from([
      "pages:",
      "  - source: Existing.md",
      "    route: /papers/existing/",
      "    layout: paper",
      "",
    ].join("\n"), "utf8")
    : proposedMap
  await mkdir(root, { recursive: true })
  git(["init", "--bare", remote])
  git(["init", seed])
  git(["-C", seed, "config", "user.name", "Publication fixture"])
  git(["-C", seed, "config", "user.email", "publication@example.test"])
  await writeFile(path.join(seed, "site-content.yml"), initialMap)
  await writeFile(path.join(seed, "README.md"), "fixture main\n")
  git(["-C", seed, "add", "."])
  git(["-C", seed, "commit", "-m", "main baseline"])
  git(["-C", seed, "branch", "-M", "main"])
  git(["-C", seed, "remote", "add", "origin", remote])
  git(["-C", seed, "push", "origin", "main"])
  const mainSha = String(git(["-C", seed, "rev-parse", "HEAD"])).trim()
  git(["-C", seed, "checkout", "--orphan", "gh-pages"])
  git(["-C", seed, "rm", "-rf", "."])
  await put(seed, "site/index.html", Buffer.from("<html>home baseline</html>\n"))
  await put(seed, "site/404.html", Buffer.from("<html>not found baseline</html>\n"))
  await put(seed, "site/.nojekyll", Buffer.alloc(0))
  await put(seed, "site/papers/existing/index.html", Buffer.from("<html>existing baseline</html>\n"))
  await put(seed, "site/assets/app.css", Buffer.from("body{}\n"))
  git(["-C", seed, "add", "."])
  git(["-C", seed, "commit", "-m", "gh-pages baseline"])
  git(["-C", seed, "push", "origin", "gh-pages"])
  const ghPagesSha = String(git(["-C", seed, "rev-parse", "HEAD"])).trim()
  await mkdir(candidateRoot, { recursive: true })
  await writeFile(path.join(session, "site-content.yml"), proposedMap)
  for (const [relative, bytes] of [
    ["index.html", Buffer.from("<html>home candidate</html>\n")],
    ["404.html", Buffer.from("<html>not found candidate</html>\n")],
    [".nojekyll", Buffer.alloc(0)],
    ["papers/existing/index.html", Buffer.from("<html>existing candidate</html>\n")],
    ["papers/new/index.html", Buffer.from("<html>new candidate</html>\n")],
    ["assets/app.css", Buffer.from("body{color:black}\n")],
    ["assets/app.js", Buffer.from("window.publication=true\n")],
  ]) await put(candidateRoot, relative, bytes)
  const candidateFiles = await snapshot(candidateRoot)
  const siteSha = siteDigest(candidateFiles)
  const rendererSha = "a".repeat(40)
  const rendererTreeSha = sha256(Buffer.from("renderer-tree\n"))
  const mainRendererTreeSha = sha256(Buffer.from("main-renderer-tree\n"))
  const binding = lane === "content"
    ? sha256(Buffer.from([
      `source_main=${mainSha}`,
      `gh_pages=${ghPagesSha}`,
      `map=${sha256(proposedMap)}`,
      `live_renderer=${rendererSha}`,
      `renderer_tree=${rendererTreeSha}`,
      `site=${siteSha}`,
      "",
    ].join("\n"), "utf8"))
    : sha256(Buffer.from([
      `source_main_sha=${mainSha}`,
      `base_gh_pages_sha=${ghPagesSha}`,
      `live_renderer_sha=${rendererSha}`,
      `main_renderer_tree_sha256=${mainRendererTreeSha}`,
      `map_sha256=${sha256(proposedMap)}`,
      `site_sha256=${siteSha}`,
      "",
    ].join("\n"), "utf8"))
  const expectedRendererSha = lane === "content" ? rendererSha : mainSha
  const trace = []
  const mapping = { branch: "", headSha: "", prId: "pr-pub-06", mergeSha: "" }
  const runs = []
  const localGit = {
    async readRemoteAuthority() {
      trace.push("local.read_remote")
      const currentMain = String(git(["--git-dir", remote, "rev-parse", "refs/heads/main"])).trim()
      const currentGhPages = String(git(["--git-dir", remote, "rev-parse", "refs/heads/gh-pages"])).trim()
      const mapBytes = Buffer.from(git(["--git-dir", remote, "show", `${currentMain}:site-content.yml`], { encoding: "buffer" }))
      return { main_sha: currentMain, gh_pages_sha: currentGhPages, map_bytes: mapBytes }
    },
    async createMappingBranch(input) {
      trace.push("local.create_map_branch")
      assert.deepEqual(Object.keys(input).sort(), ["base_ref", "base_sha", "branch", "map_bytes"])
      assert.equal(input.base_ref, "main")
      assert.equal(input.base_sha, mainSha)
      assert.deepEqual(input.map_bytes, proposedMap)
      const branch = input.branch
      const worktree = path.join(root, "map-work")
      await mkdir(worktree, { recursive: true })
      mapping.headSha = commitTree(remote, worktree, input.base_sha, "Publication map proposal", `refs/heads/${branch}`, () => writeFileSync(path.join(worktree, "site-content.yml"), input.map_bytes))
      mapping.branch = branch
      return { branch, head_sha: mapping.headSha, base_sha: input.base_sha, map_bytes: Buffer.from(input.map_bytes) }
    },
    async createGhPagesCandidate(input) {
      trace.push("local.create_site_candidate")
      assert.deepEqual(Object.keys(input).sort(), ["base_sha", "candidate_path", "renderer_main_sha"])
      assert.equal(input.base_sha, ghPagesSha)
      assert.equal(input.renderer_main_sha, expectedRendererSha)
      const candidateSha = commitTree(remote, path.dirname(candidateRoot), input.base_sha, `Publication candidate\n\nRenderer-Main-SHA: ${input.renderer_main_sha}`, null, () => {}, { resetWorktree: false })
      const message = String(git(["--git-dir", remote, "show", "-s", "--format=%B", candidateSha]))
      return { candidate_sha: candidateSha, parent_sha: input.base_sha, renderer_main_sha: input.renderer_main_sha, message }
    },
    async readCandidateCommit(input) {
      trace.push("local.read_site_candidate")
      assert.deepEqual(Object.keys(input).sort(), ["candidate_sha"])
      assert.match(input.candidate_sha, /^[0-9a-f]{40}$/u)
      return { candidate_sha: input.candidate_sha, files: await commitEntries(remote, input.candidate_sha) }
    },
    async pushGhPages(input) {
      trace.push("local.push_gh_pages")
      assert.deepEqual(Object.keys(input).sort(), ["candidate_sha", "expected_old_sha"])
      assert.equal(input.expected_old_sha, ghPagesSha)
      git(["--git-dir", remote, "update-ref", "refs/heads/gh-pages", input.candidate_sha, input.expected_old_sha])
      return { remote_sha: input.candidate_sha }
    },
    async readGhPagesHead() {
      trace.push("local.read_gh_pages")
      return String(git(["--git-dir", remote, "rev-parse", "refs/heads/gh-pages"])).trim()
    },
  }
  const provider = {
    async listMatchingMappingPrs(input) {
      trace.push("provider.list_prs")
      assert.deepEqual(Object.keys(input).sort(), ["base", "branch", "file_set", "head_sha", "map_blob_sha", "map_bytes"])
      assert.deepEqual(input, {
        base: "main",
        branch: mapping.branch,
        head_sha: mapping.headSha,
        map_blob_sha: gitBlobSha(proposedMap),
        map_bytes: proposedMap,
        file_set: ["site-content.yml"],
      })
      return []
    },
    async createMappingPr(input) {
      trace.push("provider.create_pr")
      assert.deepEqual(Object.keys(input).sort(), ["base", "branch", "file_set", "head_sha", "map_blob_sha", "map_bytes"])
      assert.deepEqual(input, {
        base: "main",
        branch: mapping.branch,
        head_sha: mapping.headSha,
        map_blob_sha: gitBlobSha(proposedMap),
        map_bytes: proposedMap,
        file_set: ["site-content.yml"],
      })
      return { pr_id: mapping.prId }
    },
    async readMappingPr(input) {
      trace.push("provider.read_pr")
      assert.deepEqual(Object.keys(input).sort(), ["base", "branch", "file_set", "head_sha", "map_blob_sha", "map_bytes", "pr_id"])
      return { pr_id: input.pr_id, base: "main", branch: mapping.branch, head_sha: mapping.headSha, file_set: ["site-content.yml"], map_blob_sha: gitBlobSha(proposedMap), map_bytes: proposedMap, state: "open", merged: false }
    },
    async readRequiredCi(input) {
      trace.push("provider.read_ci")
      assert.deepEqual(input, { head_sha: mapping.headSha, workflow: "ci.yml", job: "CI" })
      return { head_sha: mapping.headSha, workflow: input.workflow, job: input.job, status: "completed", conclusion: "success" }
    },
    async squashMergeMappingPr(input) {
      trace.push("provider.squash_merge")
      assert.deepEqual(input, { pr_id: mapping.prId, expected_head_sha: mapping.headSha })
      const currentMain = String(git(["--git-dir", remote, "rev-parse", "refs/heads/main"])).trim()
      const worktree = path.join(root, "merge-work")
      await mkdir(worktree, { recursive: true })
      const branchTree = String(git(["--git-dir", remote, "rev-parse", `${mapping.headSha}^{tree}`])).trim()
      const index = path.join(worktree, "merge-index")
      const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "Publication fixture", GIT_AUTHOR_EMAIL: "publication@example.test", GIT_COMMITTER_NAME: "Publication fixture", GIT_COMMITTER_EMAIL: "publication@example.test" }
      git(["--git-dir", remote, "read-tree", branchTree], { env })
      const mergeSha = String(git(["--git-dir", remote, "commit-tree", branchTree, "-p", currentMain], { env, input: "Publication squash map merge\n" })).trim()
      git(["--git-dir", remote, "update-ref", "refs/heads/main", mergeSha, currentMain])
      mapping.mergeSha = mergeSha
      return { merge_sha: mergeSha, expected_head_sha: input.expected_head_sha }
    },
    async readMerge(input) {
      trace.push("provider.read_merge")
      assert.deepEqual(input, { merge_sha: mapping.mergeSha, expected_head_sha: mapping.headSha, pr_id: mapping.prId })
      return { pr_id: mapping.prId, merged: true, merge_sha: mapping.mergeSha, head_sha: mapping.headSha, base: "main" }
    },
    async listMergedMappingPrs(input) {
      trace.push("provider.list_merges")
      assert.deepEqual(input, { expected_head_sha: mapping.headSha, pr_id: mapping.prId })
      return []
    },
    async listMatchingDeploymentRuns(input) {
      trace.push("provider.list_runs")
      assert.deepEqual(Object.keys(input).sort(), ["head_sha", "ref", "run_name", "workflow"])
      assert.equal(input.workflow, "deploy-pages.yml")
      assert.equal(input.ref, "main")
      return runs.filter((run) => run.workflow === input.workflow && run.ref === input.ref && run.run_name === input.run_name && run.head_sha === input.head_sha).map((run) => ({ id: run.id }))
    },
    async dispatchDeployment(input) {
      trace.push("provider.dispatch")
      assert.deepEqual(Object.keys(input).sort(), ["expected_head_sha", "inputs", "ref", "run_name", "workflow"])
      assert.equal(input.workflow, "deploy-pages.yml")
      assert.equal(input.ref, "main")
      assert.match(input.expected_head_sha, /^[0-9a-f]{40}$/u)
      assert.deepEqual(input.inputs, { site_commit: input.inputs.site_commit, publication_mode: "routine" })
      assert.match(input.run_name, new RegExp(`${input.inputs.site_commit}.*routine`))
      runs.push({ id: "run-pub-06", workflow: input.workflow, ref: input.ref, head_sha: input.expected_head_sha, run_name: input.run_name, inputs: input.inputs })
      return { accepted: true }
    },
    async readDeploymentRun(input) {
      trace.push("provider.read_run")
      assert.deepEqual(input, { id: "run-pub-06", site_commit: input.site_commit, publication_mode: "routine", workflow: "deploy-pages.yml", ref: "main", head_sha: input.head_sha })
      return { id: input.id, workflow: input.workflow, ref: input.ref, head_sha: input.head_sha, run_name: runs.at(-1).run_name, inputs: { site_commit: input.site_commit, publication_mode: "routine" }, status: "completed", conclusion: "success" }
    },
    async readPagesDeployment(input) {
      trace.push("provider.read_pages")
      assert.deepEqual(input, { run_id: "run-pub-06", site_commit: input.site_commit })
      return { deployment_id: "deployment-pub-06", run_id: input.run_id, site_commit: input.site_commit, status: "success", url: "https://pages.example.test/Tyler-Vault_PaperNote_ReadingSite/" }
    },
    async anonymousSmoke(input) {
      trace.push("provider.smoke")
      assert.deepEqual(input.routes, ["/", "/papers/existing/", "/papers/new/"])
      assert.deepEqual(input.assets, ["assets/app.css", "assets/app.js"])
      assert.deepEqual(input.not_found, { path: "/__publication_missing__", expected_status: 404 })
      assert.deepEqual(input.target, { deployment_id: "deployment-pub-06", run_id: "run-pub-06", site_commit: input.target.site_commit, status: "success", url: "https://pages.example.test/Tyler-Vault_PaperNote_ReadingSite/" })
      return { target: input.target, homepage_status: 200, route_statuses: input.routes.map(() => 200), asset_statuses: input.assets.map(() => 200), not_found_status: 404 }
    },
  }
  return {
    root,
    remote,
    session,
    localGit,
    provider,
    trace,
    mainSha,
    ghPagesSha,
    proposedMap,
    candidateRoot,
    runs,
    operation: {
      version: 1,
      operation_id: "content-0123456789abcdef0123",
      lane,
      approval: {
        operation_id: "content-0123456789abcdef0123",
        candidate_id: binding,
        map_sha256: sha256(proposedMap),
        map_blob_sha: gitBlobSha(proposedMap),
        map_commit_sha: null,
        expected_main_sha: mainSha,
        expected_gh_pages_sha: ghPagesSha,
        mode: "routine",
      },
      candidate_identity: {
        sha256: binding,
        site_sha256: siteSha,
        source_main_sha: mainSha,
        base_gh_pages_sha: ghPagesSha,
        live_renderer_sha: rendererSha,
        ...(lane === "content" ? { renderer_tree_sha256: rendererTreeSha } : { main_renderer_tree_sha256: mainRendererTreeSha }),
        map_sha256: sha256(proposedMap),
      },
      claimed_session: { work_root: path.join(root, "work") },
      proposed_site_content_bytes: proposedMap,
    },
  }
}

test("approved routine publication uses exact temporary refs and provider checkpoints", async () => {
  const fixture = await makeFixture()
  try {
    const candidateBefore = await snapshot(fixture.candidateRoot)
    const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
    assert.equal(result.status, "deployed", JSON.stringify(result))
    assert.equal(result.version, 1)
    assert.equal(result.operation_id, fixture.operation.operation_id)
    assert.equal(result.lane, "content")
    assert.deepEqual(result.added_routes, [])
    assert.deepEqual(result.changed_routes, [])
    assert.deepEqual(result.removed_routes, [])
    assert.equal(result.next_action, "none")
    assert.equal(result.error_code, null)
    assert.deepEqual(result.checks.map(({ name, outcome }) => [name, outcome]), [
      ["approval", "pass"],
      ["candidate", "pass"],
      ["remote_heads", "pass"],
      ["mapping_branch", "pass"],
      ["mapping_pr", "pass"],
      ["mapping_ci", "pass"],
      ["mapping_merge", "pass"],
      ["map_readback", "pass"],
      ["site_candidate", "pass"],
      ["gh_pages_push", "pass"],
      ["dispatch", "pass"],
      ["deployment_run", "pass"],
      ["pages", "pass"],
      ["smoke", "pass"],
    ])
    assert.deepEqual(fixture.trace, [
      "local.read_remote",
      "local.create_map_branch",
      "provider.list_prs",
      "provider.create_pr",
      "provider.read_pr",
      "provider.read_ci",
      "provider.squash_merge",
      "provider.read_merge",
      "local.read_remote",
      "local.read_site_candidate",
      "local.create_site_candidate",
      "local.read_site_candidate",
      "local.push_gh_pages",
      "local.read_gh_pages",
      "provider.list_runs",
      "provider.dispatch",
      "provider.list_runs",
      "provider.read_run",
      "provider.read_pages",
      "provider.smoke",
    ])
    const mapBranch = String(git(["--git-dir", fixture.remote, "rev-parse", "refs/heads/publication/map/content-0123456789abcdef0123"])).trim()
    assert.match(mapBranch, /^[0-9a-f]{40}$/u)
    assert.deepEqual(String(git(["--git-dir", fixture.remote, "diff", "--name-only", `${fixture.mainSha}..${mapBranch}`])).trim().split(/\r?\n/u), ["site-content.yml"])
    const mergedMain = String(git(["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"])).trim()
    assert.deepEqual(Buffer.from(git(["--git-dir", fixture.remote, "show", `${mergedMain}:site-content.yml`], { encoding: "buffer" })), fixture.proposedMap)
    const candidateSha = result.identifiers.site_commit
    assert.equal(result.identifiers.candidate_id, fixture.operation.candidate_identity.sha256)
    assert.match(candidateSha, /^[0-9a-f]{40}$/u)
    assert.equal(String(git(["--git-dir", fixture.remote, "rev-parse", "refs/heads/gh-pages"])).trim(), candidateSha)
    assert.equal(String(git(["--git-dir", fixture.remote, "rev-parse", `${candidateSha}^`])).trim(), fixture.ghPagesSha)
    assert.match(String(git(["--git-dir", fixture.remote, "show", "-s", "--format=%B", candidateSha])), /Renderer-Main-SHA: a{40}/u)
    const expectedCommittedCandidate = candidateBefore.map(({ relative, bytes }) => ({ relative: `site/${relative}`, bytes }))
    const committedCandidate = await commitSnapshot(fixture.remote, candidateSha)
    assert.deepEqual(committedCandidate.map(({ relative }) => relative), expectedCommittedCandidate.map(({ relative }) => relative))
    for (const expected of expectedCommittedCandidate) {
      const actual = committedCandidate.find(({ relative }) => relative === expected.relative)
      assert(actual, `candidate commit is missing ${expected.relative}`)
      assert.deepEqual(actual.bytes, expected.bytes, `candidate commit changed ${expected.relative}`)
    }
    assert.deepEqual(await snapshot(fixture.candidateRoot), candidateBefore, "candidate source directory must remain unchanged")
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("an identical deployed site tree converges without a new commit, push, or deployment", async () => {
  const fixture = await makeFixture({ mapChanged: false })
  try {
    const originalRead = fixture.localGit.readCandidateCommit
    const candidateFiles = (await snapshot(fixture.candidateRoot)).map(({ relative, bytes }) => ({
      relative: `site/${relative}`,
      mode: "100644",
      type: "blob",
      bytes,
    }))
    fixture.localGit.readCandidateCommit = async (input) => {
      if (input.candidate_sha === fixture.ghPagesSha) {
        fixture.trace.push("local.read_site_candidate")
        return { candidate_sha: fixture.ghPagesSha, files: candidateFiles }
      }
      return await originalRead(input)
    }

    const result = await routinePublicationHandoff(fixture.operation, {
      provider: fixture.provider,
      localGit: fixture.localGit,
    })

    assert.equal(result.status, "no_change", JSON.stringify(result))
    assert.equal(result.next_action, "none")
    assert.equal(result.error_code, null)
    assert.deepEqual(result.identifiers, {
      candidate_id: fixture.operation.candidate_identity.sha256,
      site_commit: fixture.ghPagesSha,
    })
    assert.deepEqual(result.convergence, {
      exact: true,
      desired_site_sha256: fixture.operation.candidate_identity.site_sha256,
      public_site_sha256: fixture.operation.candidate_identity.site_sha256,
      live_site_sha256: fixture.operation.candidate_identity.site_sha256,
      provider_site_commit: fixture.ghPagesSha,
    })
    assert.deepEqual(result.checks.map(({ name, outcome }) => [name, outcome]), [
      ["approval", "pass"],
      ["candidate", "pass"],
      ["remote_heads", "pass"],
      ["map_readback", "pass"],
      ["site_convergence", "pass"],
    ])
    assert.deepEqual(fixture.trace, [
      "local.read_remote",
      "local.read_site_candidate",
    ])
    assert.equal(String(git(["--git-dir", fixture.remote, "rev-parse", "refs/heads/gh-pages"])).trim(), fixture.ghPagesSha)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("candidate commit readback rejects wrong tree, mode, link, or inventory before push or dispatch", async () => {
  const variants = [
    ["wrong tree bytes", (files) => files.map((entry, index) => index === 0 ? { ...entry, bytes: Buffer.from("tampered candidate", "utf8") } : entry)],
    ["wrong mode", (files) => files.map((entry, index) => index === 0 ? { ...entry, mode: "100755" } : entry)],
    ["symlink entry", (files) => files.map((entry, index) => index === 0 ? { ...entry, mode: "120000" } : entry)],
    ["wrong inventory", (files) => [...files, { relative: "site/unapproved.txt", mode: "100644", type: "blob", bytes: Buffer.from("unapproved", "utf8") }]],
  ]
  for (const [label, mutate] of variants) {
    const fixture = await makeFixture()
    try {
      const originalRead = fixture.localGit.readCandidateCommit
      fixture.localGit.readCandidateCommit = async (input) => {
        const response = await originalRead(input)
        return { ...response, files: mutate(response.files) }
      }
      const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
      assert.equal(result.error_code, "remote_drift", `${label}: ${JSON.stringify(result)}`)
      assert.equal(result.status, "needs_attention", label)
      assert.deepEqual(result.checks.filter(({ name }) => name === "site_candidate"), [{ name: "site_candidate", outcome: "fail" }], label)
      assert.equal(fixture.trace.includes("local.push_gh_pages"), false, label)
      assert.equal(fixture.trace.includes("provider.dispatch"), false, label)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test("non-string candidate SHA identities fail before deployment dispatch", async () => {
  const fixture = await makeFixture()
  try {
    const originalCreate = fixture.localGit.createGhPagesCandidate
    const originalRead = fixture.localGit.readCandidateCommit
    const originalPush = fixture.localGit.pushGhPages
    let primitiveSha
    fixture.localGit.createGhPagesCandidate = async (input) => {
      const response = await originalCreate(input)
      primitiveSha = response.candidate_sha
      return { ...response, candidate_sha: [primitiveSha] }
    }
    fixture.localGit.readCandidateCommit = async ({ candidate_sha }) => {
      if (typeof candidate_sha === "string") return await originalRead({ candidate_sha })
      const response = await originalRead({ candidate_sha: candidate_sha[0] })
      return { ...response, candidate_sha }
    }
    fixture.localGit.pushGhPages = async (input) => {
      await originalPush({ ...input, candidate_sha: input.candidate_sha[0] })
      return { remote_sha: input.candidate_sha }
    }
    fixture.localGit.readGhPagesHead = async () => [primitiveSha]

    const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
    assert.equal(result.status, "needs_attention", JSON.stringify(result))
    assert.equal(result.error_code, "remote_drift")
    assert.deepEqual(result.checks.at(-1), { name: "site_candidate", outcome: "fail" })
    assert.equal(fixture.trace.includes("provider.dispatch"), false)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("missing seam methods retain the current failed stage", async () => {
  const fixture = await makeFixture()
  try {
    fixture.localGit.readRemoteAuthority = undefined
    const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
    assert.equal(result.status, "needs_attention", JSON.stringify(result))
    assert.equal(result.error_code, "provider_unavailable")
    assert.deepEqual(result.checks.at(-1), { name: "remote_heads", outcome: "fail" })
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("accessor readbacks retain the current failed stage", async () => {
  const fixture = await makeFixture()
  try {
    const originalRead = fixture.provider.readRequiredCi
    fixture.provider.readRequiredCi = async (input) => {
      const response = await originalRead(input)
      Object.defineProperty(response, "status", { enumerable: true, get() { throw new Error("sensitive-provider-body") } })
      return response
    }
    const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
    assert.equal(result.status, "needs_attention", JSON.stringify(result))
    assert.equal(result.error_code, "ci_failed")
    assert.deepEqual(result.checks.at(-1), { name: "mapping_ci", outcome: "fail" })
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("approval map_commit_sha binds to the exact mapping branch head before PR or public mutation", async () => {
  const fixture = await makeFixture()
  try {
    fixture.operation.approval.map_commit_sha = "e".repeat(40)
    const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
    assert.equal(result.error_code, "pr_failed", JSON.stringify(result))
    assert.equal(result.status, "needs_attention")
    assert.deepEqual(fixture.trace, ["local.read_remote", "local.create_map_branch"])
    assert.equal(fixture.trace.some((entry) => entry.startsWith("provider.")), false)
    assert.equal(fixture.trace.includes("local.push_gh_pages"), false)
    assert.equal(fixture.trace.includes("provider.dispatch"), false)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("site lane binds the candidate trailer to the current-main renderer SHA", async () => {
  const fixture = await makeFixture({ lane: "site" })
  try {
    assert.notEqual(fixture.operation.candidate_identity.live_renderer_sha, fixture.operation.candidate_identity.source_main_sha)
    const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
    assert.equal(result.status, "deployed", JSON.stringify(result))
    const candidateSha = result.identifiers.site_commit
    assert.match(String(git(["--git-dir", fixture.remote, "show", "-s", "--format=%B", candidateSha])), new RegExp(`Renderer-Main-SHA: ${fixture.mainSha}`))
    assert.doesNotMatch(String(git(["--git-dir", fixture.remote, "show", "-s", "--format=%B", candidateSha])), /Renderer-Main-SHA: a{40}/u)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("mapping publication adopts one exact open PR before any create", async () => {
  const fixture = await makeFixture()
  try {
    let createCalls = 0
    fixture.provider.listMatchingMappingPrs = async (input) => {
      fixture.trace.push("provider.list_prs")
      assert.deepEqual(Object.keys(input).sort(), ["base", "branch", "file_set", "head_sha", "map_blob_sha", "map_bytes"])
      return [{
        pr_id: "pr-pub-06",
        base: "main",
        branch: input.branch,
        head_sha: input.head_sha,
        file_set: ["site-content.yml"],
        map_blob_sha: input.map_blob_sha,
        map_bytes: Buffer.from(input.map_bytes),
        state: "open",
        merged: false,
      }]
    }
    fixture.provider.createOrAdoptMappingPr = async () => {
      createCalls += 1
      throw new Error("legacy create seam must not be used")
    }
    const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
    assert.equal(result.status, "deployed", JSON.stringify(result))
    assert.equal(createCalls, 0)
    assert.equal(fixture.trace.includes("provider.create_or_adopt_pr"), false)
    assert.equal(fixture.trace.filter((entry) => entry === "provider.list_prs").length, 1)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("multiple exact open mapping PRs fail closed without create or public mutation", async () => {
  const fixture = await makeFixture()
  try {
    let createCalls = 0
    fixture.provider.listMatchingMappingPrs = async (input) => [openPr(input), openPr(input, { pr_id: "pr-pub-06-second" })]
    fixture.provider.createMappingPr = async () => {
      createCalls += 1
      throw new Error("create must not run when adoption is ambiguous")
    }
    const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
    assert.equal(result.error_code, "pr_failed", JSON.stringify(result))
    assert.equal(result.status, "needs_attention")
    assert.equal(createCalls, 0)
    assert.equal(fixture.trace.some((entry) => /provider\.(create|squash|dispatch)|local\.(push|read_gh_pages)/u.test(entry)), false)
    assert.equal(result.checks.filter(({ name }) => name === "mapping_pr").length, 1)
    assert.equal(result.checks.find(({ name }) => name === "mapping_pr").outcome, "fail")
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("mapping branch push failures retain the safe mutation uncertainty code", async () => {
  const fixture = await makeFixture()
  try {
    fixture.localGit.createMappingBranch = async () => {
      throw Object.assign(new Error("redacted adapter failure"), { code: "mapping_push_failed" })
    }
    const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
    assert.equal(result.status, "needs_attention")
    assert.equal(result.error_code, "push_uncertain")
    assert.deepEqual(result.checks.map(({ name, outcome }) => ({ name, outcome })), [
      { name: "approval", outcome: "pass" },
      { name: "candidate", outcome: "pass" },
      { name: "remote_heads", outcome: "pass" },
      { name: "mapping_branch", outcome: "fail" },
    ])
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("lost mapping PR create response reconciles exactly one newly visible PR", async () => {
  const fixture = await makeFixture()
  try {
    let listCalls = 0
    let createCalls = 0
    fixture.provider.listMatchingMappingPrs = async (input) => {
      listCalls += 1
      fixture.trace.push(`provider.list_prs_${listCalls}`)
      return listCalls === 1 ? [] : [openPr(input)]
    }
    fixture.provider.createMappingPr = async () => {
      createCalls += 1
      fixture.trace.push("provider.create_pr_lost")
      throw new Error("provider response lost after create")
    }
    const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
    assert.equal(result.status, "deployed", JSON.stringify(result))
    assert.equal(result.error_code, null)
    assert.equal(createCalls, 1)
    assert.equal(listCalls, 2)
    assert.equal(fixture.trace.filter((entry) => entry === "provider.create_pr_lost").length, 1)
    assert.equal(fixture.trace.some((entry) => entry === "provider.create_pr"), false)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("invalid approval, map, candidate, and session shapes stop before provider or public mutation", async () => {
  const fixture = await makeFixture()
  try {
    const variants = [
      ["boolean version", { version: true }],
      ["extra operation key", { unexpected: true }],
      ["map hash drift", { approval: { ...fixture.operation.approval, map_sha256: "0".repeat(64) } }],
      ["map blob drift", { approval: { ...fixture.operation.approval, map_blob_sha: "0".repeat(40) } }],
      ["proposed map bytes drift", { proposed_site_content_bytes: Buffer.from("pages:\n", "utf8") }],
      ["candidate identity drift", { candidate_identity: { ...fixture.operation.candidate_identity, site_sha256: "0".repeat(64) } }],
    ]
    for (const [name, override] of variants) {
      const candidate = { ...fixture.operation, ...override }
      const result = await routinePublicationHandoff(candidate, { provider: fixture.provider, localGit: fixture.localGit })
      assert.equal(result.error_code, "approval_invalid", `${name}: ${JSON.stringify(result)}`)
      assert.equal(result.status, "needs_attention")
      assert.equal("identifiers" in result, false, name)
      assert.deepEqual(result.checks, [{ name: "approval", outcome: "fail" }], name)
    }
    const invalidSession = {
      ...fixture.operation,
      claimed_session: { work_root: path.join(fixture.root, "missing-work-root") },
    }
    const sessionResult = await routinePublicationHandoff(invalidSession, { provider: fixture.provider, localGit: fixture.localGit })
    assert.equal(sessionResult.error_code, "approval_invalid")
    assert.equal(sessionResult.status, "needs_attention")
    assert.deepEqual(sessionResult.identifiers, { candidate_id: fixture.operation.candidate_identity.sha256 })
    assert.deepEqual(sessionResult.checks, [{ name: "approval", outcome: "fail" }])
    await put(fixture.candidateRoot, "unexpected.txt", Buffer.from("not approved\n", "utf8"))
    const candidateDrift = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
    assert.equal(candidateDrift.error_code, "approval_invalid", JSON.stringify(candidateDrift))
    assert.deepEqual(candidateDrift.identifiers, { candidate_id: fixture.operation.candidate_identity.sha256 })
    assert.deepEqual(candidateDrift.checks, [{ name: "approval", outcome: "fail" }])
    assert.equal(fixture.trace.length, 0)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("malformed provider readbacks retain the exact recovery stage", async () => {
  const variants = [
    ["remote authority", "provider_unavailable", "remote_heads", (fixture) => {
      fixture.localGit.readRemoteAuthority = async () => ({})
    }],
    ["deployment run list", "dispatch_uncertain", "dispatch", (fixture) => {
      fixture.provider.listMatchingDeploymentRuns = async () => [{}]
    }],
  ]
  for (const [label, code, failedName, configure] of variants) {
    const fixture = await makeFixture()
    try {
      configure(fixture)
      const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
      assert.equal(result.status, "needs_attention", `${label}: ${JSON.stringify(result)}`)
      assert.equal(result.error_code, code, label)
      assert.equal(result.checks.at(-1)?.name, failedName, label)
      assert.equal(result.checks.at(-1)?.outcome, "fail", label)
      assert.equal(result.checks.filter(({ outcome }) => outcome === "fail").length, 1, label)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test("initial remote head drift stops before mapping or public mutation", async () => {
  const fixture = await makeFixture()
  try {
    const originalRead = fixture.localGit.readRemoteAuthority
    fixture.localGit.readRemoteAuthority = async () => {
      const authority = await originalRead()
      return { ...authority, main_sha: "b".repeat(40) }
    }
    const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
    assert.equal(result.error_code, "remote_drift", JSON.stringify(result))
    assert.deepEqual(fixture.trace, ["local.read_remote"])
    assert.deepEqual(result.checks, [
      { name: "approval", outcome: "pass" },
      { name: "candidate", outcome: "pass" },
      { name: "remote_heads", outcome: "fail" },
    ])
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("post-map remote gh-pages drift fails before candidate creation", async () => {
  const fixture = await makeFixture()
  try {
    let reads = 0
    const originalRead = fixture.localGit.readRemoteAuthority
    fixture.localGit.readRemoteAuthority = async () => {
      reads += 1
      const authority = await originalRead()
      return reads === 2 ? { ...authority, gh_pages_sha: "c".repeat(40) } : authority
    }
    const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
    assert.equal(result.error_code, "remote_drift", JSON.stringify(result))
    assert.equal(fixture.trace.includes("local.create_site_candidate"), false)
    assert.equal(fixture.trace.includes("local.push_gh_pages"), false)
    assert.equal(fixture.trace.includes("provider.dispatch"), false)
    assert.deepEqual(result.checks.filter(({ name }) => name === "map_readback"), [{ name: "map_readback", outcome: "fail" }])
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("lost merge response reconciles one exact merged PR without a second merge", async () => {
  const fixture = await makeFixture()
  try {
    let mergeCalls = 0
    let listCalls = 0
    let mergeSha
    const originalMerge = fixture.provider.squashMergeMappingPr
    fixture.provider.squashMergeMappingPr = async (input) => {
      mergeCalls += 1
      const response = await originalMerge(input)
      mergeSha = response.merge_sha
      throw new Error("merge response lost after remote merge")
    }
    fixture.provider.listMergedMappingPrs = async (input) => {
      listCalls += 1
      assert.deepEqual(Object.keys(input).sort(), ["expected_head_sha", "pr_id"])
      assert.match(input.expected_head_sha, /^[0-9a-f]{40}$/u)
      assert.equal(typeof mergeSha, "string")
      return [mergedPr(input, mergeSha)]
    }
    const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
    assert.equal(result.status, "deployed", JSON.stringify(result))
    assert.equal(result.error_code, null)
    assert.equal(mergeCalls, 1)
    assert.equal(listCalls, 1)
    assert.equal(fixture.trace.includes("provider.read_merge"), false)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("zero or multiple merged objects after loss fail without push or dispatch", async () => {
  for (const [label, makeMatches] of [
    ["zero", () => []],
    ["multiple", (input, mergeSha) => [mergedPr(input, mergeSha), mergedPr(input, mergeSha, { merge_sha: "d".repeat(40) })]],
  ]) {
    const fixture = await makeFixture()
    try {
      let mergeSha
      let mergeCalls = 0
      const originalMerge = fixture.provider.squashMergeMappingPr
      fixture.provider.squashMergeMappingPr = async (input) => {
        mergeCalls += 1
        const response = await originalMerge(input)
        mergeSha = response.merge_sha
        throw new Error(`${label} merge reconciliation`)
      }
      fixture.provider.listMergedMappingPrs = async (input) => makeMatches(input, mergeSha)
      const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
      assert.equal(result.error_code, "merge_failed", `${label}: ${JSON.stringify(result)}`)
      assert.equal(result.checks.filter(({ name }) => name === "mapping_merge").length, 1)
      assert.equal(result.checks.find(({ name }) => name === "mapping_merge").outcome, "fail")
      assert.equal(mergeCalls, 1)
      assert.equal(fixture.trace.includes("local.push_gh_pages"), false)
      assert.equal(fixture.trace.includes("provider.dispatch"), false)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test("named CI failure stops before merge, push, or dispatch", async () => {
  const fixture = await makeFixture()
  try {
    fixture.provider.readRequiredCi = async (input) => {
      fixture.trace.push("provider.read_ci_failure")
      assert.deepEqual(Object.keys(input).sort(), ["head_sha", "job", "workflow"])
      assert.match(input.head_sha, /^[0-9a-f]{40}$/u)
      assert.equal(input.workflow, "ci.yml")
      assert.equal(input.job, "CI")
      return { head_sha: input.head_sha, workflow: input.workflow, job: input.job, status: "completed", conclusion: "failure" }
    }
    const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
    assert.equal(result.error_code, "ci_failed", JSON.stringify(result))
    assert.equal(result.checks.filter(({ name }) => name === "mapping_ci").length, 1)
    assert.equal(result.checks.find(({ name }) => name === "mapping_ci").outcome, "fail")
    assert.equal(fixture.trace.includes("provider.squash_merge"), false)
    assert.equal(fixture.trace.includes("local.push_gh_pages"), false)
    assert.equal(fixture.trace.includes("provider.dispatch"), false)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("lost or thrown push response continues only after exact remote candidate readback", async () => {
  for (const [label, mode] of [["lost", "return"], ["thrown", "throw"]]) {
    const fixture = await makeFixture()
    try {
      const originalPush = fixture.localGit.pushGhPages
      fixture.localGit.pushGhPages = async (input) => {
        const response = await originalPush(input)
        if (mode === "throw") throw new Error(`${label} provider response C:\\secret\\push-body`)
        return undefined
      }
      const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
      assert.equal(result.status, "deployed", `${label}: ${JSON.stringify(result)}`)
      assert.equal(result.error_code, null)
      assert.equal(fixture.trace.filter((entry) => entry === "local.push_gh_pages").length, 1)
      assert.equal(fixture.trace.filter((entry) => entry === "local.read_gh_pages").length, 1)
      assert.equal(fixture.trace.filter((entry) => entry === "provider.dispatch").length, 1)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test("wrong or unreadable push readback yields push_uncertain without dispatch", async () => {
  for (const mode of ["wrong", "unreadable"]) {
    const fixture = await makeFixture()
    try {
      fixture.localGit.readGhPagesHead = async () => {
        fixture.trace.push("local.read_gh_pages_override")
        if (mode === "unreadable") throw new Error("C:\\secret\\remote-head-body")
        return "d".repeat(40)
      }
      const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
      assert.equal(result.error_code, "push_uncertain", `${mode}: ${JSON.stringify(result)}`)
      assert.equal(result.checks.filter(({ name }) => name === "gh_pages_push").length, 1)
      assert.equal(result.checks.find(({ name }) => name === "gh_pages_push").outcome, "fail")
      assert.equal(fixture.trace.includes("provider.dispatch"), false)
      assert.doesNotMatch(JSON.stringify(result), /secret|remote-head-body/u)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test("lost or thrown dispatch response reconciles one new run and never redispatches", async () => {
  for (const mode of ["return", "throw"]) {
    const fixture = await makeFixture()
    try {
      let listCalls = 0
      let dispatchCalls = 0
      const originalList = fixture.provider.listMatchingDeploymentRuns
      const originalDispatch = fixture.provider.dispatchDeployment
      fixture.provider.listMatchingDeploymentRuns = async (input) => {
        listCalls += 1
        if (listCalls === 1) fixture.runs.push({ id: "run-old", workflow: input.workflow, ref: input.ref, head_sha: input.head_sha, run_name: input.run_name, inputs: input.inputs })
        return originalList(input)
      }
      fixture.provider.dispatchDeployment = async (input) => {
        dispatchCalls += 1
        const response = await originalDispatch(input)
        if (mode === "throw") throw new Error("dispatch response lost with provider body")
        return undefined
      }
      const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
      assert.equal(result.status, "deployed", `${mode}: ${JSON.stringify(result)}`)
      assert.equal(result.error_code, null)
      assert.equal(result.identifiers.workflow_run_id, "run-pub-06")
      assert.equal(listCalls, 2)
      assert.equal(dispatchCalls, 1)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test("zero or multiple new deployment runs yield dispatch_uncertain without a second dispatch", async () => {
  for (const mode of ["zero", "multiple"]) {
    const fixture = await makeFixture()
    try {
      let dispatchCalls = 0
      fixture.provider.dispatchDeployment = async (input) => {
        dispatchCalls += 1
        if (mode === "multiple") {
          fixture.runs.push({ id: "run-one", workflow: input.workflow, ref: input.ref, run_name: input.run_name, inputs: input.inputs })
          fixture.runs.push({ id: "run-two", workflow: input.workflow, ref: input.ref, run_name: input.run_name, inputs: input.inputs })
        }
        return undefined
      }
      const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
      assert.equal(result.error_code, "dispatch_uncertain", `${mode}: ${JSON.stringify(result)}`)
      assert.equal(result.checks.filter(({ name }) => name === "dispatch").length, 1)
      assert.equal(result.checks.find(({ name }) => name === "dispatch").outcome, "fail")
      assert.equal(dispatchCalls, 1)
      assert.equal(fixture.trace.includes("provider.read_run"), false)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test("deployment workflow terminal, unreadable, and identity failures stop before Pages or smoke", async () => {
  const variants = [
    ["terminal failure", (response) => ({ ...response, conclusion: "failure" })],
    ["readback shape", () => ({ id: "run-pub-06", status: "completed" })],
    ["wrong run id", (response) => ({ ...response, id: "run-other" })],
    ["wrong workflow", (response) => ({ ...response, workflow: "other.yml" })],
    ["wrong ref", (response) => ({ ...response, ref: "release" })],
    ["wrong workflow head", (response) => ({ ...response, head_sha: "f".repeat(40) })],
    ["wrong run name", (response) => ({ ...response, run_name: "Deploy GitHub Pages wrong (routine)" })],
    ["wrong exact inputs", (response) => ({ ...response, inputs: { site_commit: response.inputs.site_commit, publication_mode: "rollback" } })],
  ]
  for (const [label, mutate] of variants) {
    const fixture = await makeFixture()
    try {
      const originalRead = fixture.provider.readDeploymentRun
      fixture.provider.readDeploymentRun = async (input) => mutate(await originalRead(input), input)
      const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
      assert.equal(result.error_code, "workflow_failed", `${label}: ${JSON.stringify(result)}`)
      assert.equal(result.status, "needs_attention")
      assert.equal(fixture.trace.includes("provider.read_pages"), false, label)
      assert.equal(fixture.trace.includes("provider.smoke"), false, label)
      assert.deepEqual(result.checks.filter(({ name }) => name === "deployment_run"), [{ name: "deployment_run", outcome: "fail" }], label)
      assert.equal(result.checks.filter(({ name }) => name === "pages").length, 0, label)
      assert.equal(result.checks.filter(({ name }) => name === "smoke").length, 0, label)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test("Pages readback failures stop before anonymous smoke", async () => {
  const variants = [
    ["wrong run", (response) => ({ ...response, run_id: "run-other" })],
    ["wrong site commit", (response) => ({ ...response, site_commit: "f".repeat(40) })],
    ["wrong deployment URL", (response) => ({ ...response, url: "https://pages.example.test/wrong/" })],
    ["failed status", (response) => ({ ...response, status: "failure" })],
    ["malformed readback", () => ({ run_id: "run-pub-06", site_commit: "0".repeat(40) })],
  ]
  for (const [label, mutate] of variants) {
    const fixture = await makeFixture()
    try {
      const originalRead = fixture.provider.readPagesDeployment
      fixture.provider.readPagesDeployment = async (input) => mutate(await originalRead(input), input)
      const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
      assert.equal(result.error_code, "pages_failed", `${label}: ${JSON.stringify(result)}`)
      assert.equal(result.status, "needs_attention")
      assert.equal(fixture.trace.includes("provider.smoke"), false, label)
      assert.deepEqual(result.checks.filter(({ name }) => name === "pages"), [{ name: "pages", outcome: "fail" }], label)
      assert.equal(result.checks.filter(({ name }) => name === "smoke").length, 0, label)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test("anonymous smoke supplies every approved route, CSS or JS asset, and custom 404 then fails closed", async () => {
  const variants = [
    ["homepage", (response) => ({ ...response, homepage_status: 503 })],
    ["approved route", (response) => ({ ...response, route_statuses: [200, 500, 200] })],
    ["required CSS asset", (response) => ({ ...response, asset_statuses: [500, 200] })],
    ["required JS asset", (response) => ({ ...response, asset_statuses: [200, 500] })],
    ["custom 404", (response) => ({ ...response, not_found_status: 200 })],
    ["wrong smoke target", (response) => ({ ...response, target: { ...response.target, deployment_id: "deployment-other" } })],
    ["incomplete route matrix", (response) => ({ ...response, route_statuses: [200] })],
    ["incomplete asset matrix", (response) => ({ ...response, asset_statuses: [200] })],
  ]
  for (const [label, mutate] of variants) {
    const fixture = await makeFixture()
    try {
      const originalSmoke = fixture.provider.anonymousSmoke
      fixture.provider.anonymousSmoke = async (input) => {
        assert.deepEqual(input.routes, ["/", "/papers/existing/", "/papers/new/"], `${label}: route request drift`)
        assert.deepEqual(input.assets, ["assets/app.css", "assets/app.js"], `${label}: asset request drift`)
        assert.deepEqual(input.not_found, { path: "/__publication_missing__", expected_status: 404 }, `${label}: 404 request drift`)
        return mutate(await originalSmoke(input), input)
      }
      const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
      assert.equal(result.error_code, "smoke_failed", `${label}: ${JSON.stringify(result)}`)
      assert.equal(result.status, "needs_attention")
      assert.equal(fixture.trace.filter((entry) => entry === "provider.smoke").length, 1, label)
      assert.deepEqual(result.checks.filter(({ name }) => name === "smoke"), [{ name: "smoke", outcome: "fail" }], label)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test("anonymous smoke retries a complete 200/404 matrix while new routes settle", async () => {
  const fixture = await makeFixture()
  try {
    const originalSmoke = fixture.provider.anonymousSmoke
    let calls = 0
    fixture.provider.anonymousSmoke = async (input) => {
      calls += 1
      const response = await originalSmoke(input)
      if (calls === 1) return { ...response, route_statuses: [200, 404, 200] }
      return response
    }
    const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
    assert.equal(result.status, "deployed", JSON.stringify(result))
    assert.equal(result.error_code, null)
    assert.equal(calls, 2)
    assert.equal(fixture.trace.filter((entry) => entry === "provider.smoke").length, 2)
    assert.deepEqual(result.checks.filter(({ name }) => name === "smoke"), [{ name: "smoke", outcome: "pass" }])
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

const failureSummaries = Object.freeze({
  auth_failed: "發布服務驗證失敗，已停止。",
  rate_limited: "發布服務暫時限流，已停止。",
  workflow_failed: "精確版本部署工作流程失敗，已停止。",
  pages_failed: "Pages 部署讀回失敗，已停止。",
  smoke_failed: "匿名網站檢查失敗，已停止。",
  provider_unavailable: "發布服務目前無法核對，請人工處理。",
  push_uncertain: "公開分支推送結果無法唯一核對，請人工處理。",
})

function assertFailureContract(result, { code, failedName, hasIdentifiers }) {
  const expectedKeys = [
    "version",
    "operation_id",
    "lane",
    "status",
    "summary",
    "added_routes",
    "changed_routes",
    "removed_routes",
    "checks",
    "next_action",
    "error_code",
    ...(hasIdentifiers ? ["identifiers"] : []),
  ].sort()
  assert.deepEqual(Object.keys(result).sort(), expectedKeys)
  assert.equal(result.version, 1)
  assert.equal(result.operation_id, "content-0123456789abcdef0123")
  assert.equal(result.lane, "content")
  assert.equal(result.status, "needs_attention")
  assert.equal(result.summary, failureSummaries[code])
  assert.deepEqual(result.added_routes, [])
  assert.deepEqual(result.changed_routes, [])
  assert.deepEqual(result.removed_routes, [])
  assert.equal(result.next_action, "request_manual_review")
  assert.equal(result.error_code, code)
  assert(result.checks.length > 0)
  assert.equal(new Set(result.checks.map(({ name }) => name)).size, result.checks.length)
  for (const checkResult of result.checks) {
    assert.deepEqual(Object.keys(checkResult).sort(), ["name", "outcome"])
    assert.match(checkResult.name, /^[a-z_]+$/u)
    assert.ok(checkResult.outcome === "pass" || checkResult.outcome === "fail")
  }
  assert.deepEqual(result.checks.filter(({ name }) => name === failedName), [{ name: failedName, outcome: "fail" }])
  if (hasIdentifiers) {
    const allowed = new Set(["candidate_id", "mapping_pr_id", "mapping_merge_sha", "site_commit", "workflow_run_id"])
    assert(Object.keys(result.identifiers).every((name) => allowed.has(name)))
    assert.match(result.identifiers.candidate_id, /^[0-9a-f]{64}$/u)
    assert.equal("pages_url" in result.identifiers, false)
    const serializedIdentifiers = JSON.stringify(result.identifiers)
    assert.doesNotMatch(serializedIdentifiers, /C:\\\\/u)
    assert.doesNotMatch(serializedIdentifiers, /\/(?:Users|home|tmp|var)\//u)
  } else {
    assert.equal("identifiers" in result, false)
  }
}

function hostileError(code) {
  const error = new Error("Bearer [REDACTED] C:\\Users\\Arke\\private\\provider.json /var/lib/provider/body.json provider response body")
  if (code) error.code = code
  error.stack = "Error: provider response body\\n    at provider-stack (C:\\Users\\Arke\\private\\provider.json)\\n    at /var/lib/provider/body.json"
  return error
}

test("hostile provider and localGit errors expose only stable failure results", async () => {
  const variants = [
    ["auth provider workflow", "auth_failed", "deployment_run", true, (fixture) => {
      fixture.provider.readDeploymentRun = async () => { throw hostileError("auth_failed") }
    }, (fixture) => {
      assert.equal(fixture.trace.includes("provider.read_pages"), false)
      assert.equal(fixture.trace.includes("provider.smoke"), false)
    }],
    ["rate limited local candidate", "rate_limited", "site_candidate", true, (fixture) => {
      fixture.localGit.createGhPagesCandidate = async () => { throw hostileError("rate_limited") }
    }, (fixture) => {
      assert.equal(fixture.trace.includes("local.push_gh_pages"), false)
      assert.equal(fixture.trace.includes("provider.dispatch"), false)
    }],
    ["unknown provider smoke", "smoke_failed", "smoke", true, (fixture) => {
      fixture.provider.anonymousSmoke = async () => { throw hostileError() }
    }, () => {}],
    ["unknown localGit push readback", "push_uncertain", "gh_pages_push", true, (fixture) => {
      fixture.localGit.readGhPagesHead = async () => { throw hostileError() }
    }, (fixture) => {
      assert.equal(fixture.trace.includes("provider.dispatch"), false)
    }],
  ]
  for (const [label, code, failedName, hasIdentifiers, configure, assertStopped] of variants) {
    const fixture = await makeFixture()
    try {
      configure(fixture)
      const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
      assertFailureContract(result, { code, failedName, hasIdentifiers })
      const serialized = JSON.stringify(result)
      for (const forbidden of [
        "redacted:sk-",
        "provider response body",
        "provider-stack",
        "C:\\\\Users\\\\Arke",
        "/var/lib/provider/body.json",
      ]) {
        assert.equal(serialized.includes(forbidden), false, `${label}: leaked ${forbidden}`)
      }
      assertStopped(fixture)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test("hostile seam getter proxy returns one bounded result instead of rejecting", async () => {
  const fixture = await makeFixture()
  try {
    const secret = "provider proxy body [REDACTED] C:\\Users\\Arke\\private\\provider.json"
    const hostile = new Proxy({}, {
      get() { throw new Error(secret) },
      getPrototypeOf() { throw new Error(secret) },
    })
    const seams = { localGit: fixture.localGit }
    Object.defineProperty(seams, "provider", {
      enumerable: true,
      get() { throw hostile },
    })

    const result = await routinePublicationHandoff(fixture.operation, seams)
    assertFailureContract(result, {
      code: "provider_unavailable",
      failedName: "provider",
      hasIdentifiers: true,
    })
    assert.equal(JSON.stringify(result).includes(secret), false)
    assert.equal(fixture.trace.length, 0)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("stable provider errors after PR create reconcile without a second create", async () => {
  for (const code of ["auth_failed", "provider_unavailable"]) {
    const fixture = await makeFixture()
    try {
      let listCalls = 0
      let createCalls = 0
      const originalCreate = fixture.provider.createMappingPr
      fixture.provider.listMatchingMappingPrs = async (input) => {
        listCalls += 1
        return listCalls === 1 ? [] : [openPr(input)]
      }
      fixture.provider.createMappingPr = async (input) => {
        createCalls += 1
        await originalCreate(input)
        const error = new Error(`${code} after PR create`)
        error.code = code
        throw error
      }
      const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
      assert.equal(result.status, "deployed", `${code}: ${JSON.stringify(result)}`)
      assert.equal(result.error_code, null)
      assert.equal(createCalls, 1)
      assert.equal(listCalls, 2)
      assert.equal(fixture.trace.filter((entry) => entry === "provider.create_pr").length, 1)
      assert.equal(fixture.trace.includes("provider.squash_merge"), true)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test("stable provider errors after merge reconcile without a second merge", async () => {
  for (const code of ["auth_failed", "provider_unavailable"]) {
    const fixture = await makeFixture()
    try {
      let mergeCalls = 0
      let listCalls = 0
      let mergeSha
      const originalMerge = fixture.provider.squashMergeMappingPr
      fixture.provider.squashMergeMappingPr = async (input) => {
        mergeCalls += 1
        const response = await originalMerge(input)
        mergeSha = response.merge_sha
        const error = new Error(`${code} after merge`)
        error.code = code
        throw error
      }
      fixture.provider.listMergedMappingPrs = async (input) => {
        listCalls += 1
        return [mergedPr(input, mergeSha)]
      }
      const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
      assert.equal(result.status, "deployed", `${code}: ${JSON.stringify(result)}`)
      assert.equal(result.error_code, null)
      assert.equal(mergeCalls, 1)
      assert.equal(listCalls, 1)
      assert.equal(fixture.trace.includes("provider.read_merge"), false)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test("stable provider errors after gh-pages push reconcile without a second push", async () => {
  for (const code of ["auth_failed", "provider_unavailable"]) {
    const fixture = await makeFixture()
    try {
      let pushCalls = 0
      const originalPush = fixture.localGit.pushGhPages
      fixture.localGit.pushGhPages = async (input) => {
        pushCalls += 1
        await originalPush(input)
        const error = new Error(`${code} after gh-pages push`)
        error.code = code
        throw error
      }
      const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
      assert.equal(result.status, "deployed", `${code}: ${JSON.stringify(result)}`)
      assert.equal(result.error_code, null)
      assert.equal(pushCalls, 1)
      assert.equal(fixture.trace.filter((entry) => entry === "local.read_gh_pages").length, 1)
      assert.equal(fixture.trace.filter((entry) => entry === "provider.dispatch").length, 1)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test("stable provider errors after workflow dispatch reconcile without a second dispatch", async () => {
  for (const code of ["auth_failed", "provider_unavailable"]) {
    const fixture = await makeFixture()
    try {
      let listCalls = 0
      let dispatchCalls = 0
      const originalList = fixture.provider.listMatchingDeploymentRuns
      const originalDispatch = fixture.provider.dispatchDeployment
      fixture.provider.listMatchingDeploymentRuns = async (input) => {
        listCalls += 1
        if (listCalls === 1) fixture.runs.push({ id: "run-old", workflow: input.workflow, ref: input.ref, head_sha: input.head_sha, run_name: input.run_name, inputs: input.inputs })
        return originalList(input)
      }
      fixture.provider.dispatchDeployment = async (input) => {
        dispatchCalls += 1
        await originalDispatch(input)
        const error = new Error(`${code} after dispatch`)
        error.code = code
        throw error
      }
      const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
      assert.equal(result.status, "deployed", `${code}: ${JSON.stringify(result)}`)
      assert.equal(result.error_code, null)
      assert.equal(dispatchCalls, 1)
      assert.equal(listCalls, 2)
      assert.equal(fixture.trace.filter((entry) => entry === "provider.dispatch").length, 1)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test("valid PR create ID with lost read falls back to one exact list match", async () => {
  for (const matches of [
    ["one", (input) => [openPr(input)]],
    ["zero", () => []],
    ["multiple", (input) => [openPr(input), openPr(input, { pr_id: "pr-pub-06-second" })]],
  ]) {
    const [label, makeMatches] = matches
    const fixture = await makeFixture()
    try {
      let listCalls = 0
      let createCalls = 0
      let readCalls = 0
      const originalCreate = fixture.provider.createMappingPr
      const originalRead = fixture.provider.readMappingPr
      fixture.provider.listMatchingMappingPrs = async (input) => {
        listCalls += 1
        return listCalls === 1 ? [] : makeMatches(input)
      }
      fixture.provider.createMappingPr = async (input) => {
        createCalls += 1
        return originalCreate(input)
      }
      fixture.provider.readMappingPr = async (input) => {
        readCalls += 1
        if (readCalls === 1) {
          const error = new Error("read response lost after valid PR ID")
          error.code = "provider_unavailable"
          throw error
        }
        return originalRead(input)
      }
      const result = await routinePublicationHandoff(fixture.operation, { provider: fixture.provider, localGit: fixture.localGit })
      if (label === "one") {
        assert.equal(result.status, "deployed", JSON.stringify(result))
        assert.equal(result.error_code, null)
        assert.equal(readCalls, 2)
        assert.equal(fixture.trace.includes("provider.squash_merge"), true)
      } else {
        assert.equal(result.status, "needs_attention", `${label}: ${JSON.stringify(result)}`)
        assert.equal(result.error_code, "pr_failed")
        assert.equal(result.checks.find(({ name }) => name === "mapping_pr").outcome, "fail")
        assert.equal(readCalls, 1)
        assert.equal(fixture.trace.includes("provider.squash_merge"), false)
        assert.equal(fixture.trace.includes("local.push_gh_pages"), false)
        assert.equal(fixture.trace.includes("provider.dispatch"), false)
      }
      assert.equal(createCalls, 1)
      assert.equal(listCalls, 2)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})
