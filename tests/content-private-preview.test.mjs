import assert from "node:assert/strict"
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { parse as parseYaml } from "yaml"

import {
  normalizeRouteSlug,
  opaqueOperationId,
  prepareContentPrivatePreview,
  prepareContentPrivatePreviewForTest,
  routeForSource,
  sha256,
} from "../lib/content-private-preview.mjs"
import * as contentPreview from "../lib/content-private-preview.mjs"

test("site presentation exposes a one-argument production seam", async () => {
  assert.equal(typeof contentPreview.prepareSitePrivatePreview, "function")
  assert.equal(contentPreview.prepareSitePrivatePreview.length, 1)
  const result = await contentPreview.prepareSitePrivatePreview(/** @type {any} */ (null))
  assert.equal(result.error_code, "VAULT_ROOT_REQUIRED")
  assert.equal(JSON.stringify(result).includes("sitePresentation"), false)
})

const repoRoot = path.resolve(import.meta.dirname, "..")
const cli = path.join(repoRoot, "scripts", "slim-build.mjs")
const publishCli = path.join(repoRoot, "scripts", "vault-papernote-publish.mjs")

/** @param {string} title */
function source(title) {
  return `---\ntitle: ${title}\ntype: support\nlayer: content\n---\n\n# ${title}\n`
}

test("content map snapshot preflight accepts a non-nine page proposal through the public seam", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-map-red-"))
  const vault = path.join(root, "vault")
  const work = path.join(root, "work")
  const output = path.join(root, "output")
  const map = path.join(root, "proposal.yml")
  await mkdir(vault, { recursive: true })
  await mkdir(work, { recursive: true })
  const pages = []
  for (let index = 0; index < 10; index += 1) {
    const sourcePath = `Knowledge/Concepts/Proposal-${index}.md`
    const absolute = path.join(vault, ...sourcePath.split("/"))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, source(`Proposal ${index}`))
    pages.push(`  - source: "${sourcePath}"\n    route: "/knowledge/concept/proposal-${index}/"\n    layout: support`)
  }
  await writeFile(map, `pages:\n${pages.join("\n")}\n`)
  try {
    const result = spawnSync(process.execPath, [
      cli,
      "preflight",
      "--content-map", map,
      "--vault-root", vault,
      "--work-root", work,
      "--output", output,
    ], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stderr, "")
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.pages, 10)
    assert.equal(receipt.map_sha256.length, 64)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const mappedPages = parseYaml(await readFile(path.join(repoRoot, "site-content.yml"), "utf8")).pages

test("publish CLI starts a real temporary Git/Vault fixture without an operation id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-publish-cli-red-"))
  const vault = path.join(root, "vault")
  const map = path.join(root, "map.yml")
  await mkdir(vault, { recursive: true })
  await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
  try {
    await populateVault({ root, vault }, true)
    const refs = await makeFixture(root, map, vault, true)
    const result = spawnSync(process.execPath, [
      publishCli,
      "--vault-root", vault,
      "--git-root", refs.repo,
      "--main-ref", "refs/heads/main",
      "--gh-pages-ref", "refs/heads/gh-pages",
      "--work-root", path.join(root, "cli-work"),
    ], { cwd: repoRoot, encoding: "utf8", timeout: 600_000 })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stderr, "")
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.status, "ready_for_review")
    assert.match(receipt.operation_id, /^content-[0-9a-f]{20}$/u)
    assert.equal(result.stdout.includes(root), false)
    assert.equal(result.stdout.trim().split(/\r?\n/u).length, 1)
    for (const mainRef of ["refs/heads/main~1", "refs/heads/main^", "refs/heads/main:site-content.yml"]) {
      const invalidRef = spawnSync(process.execPath, [
        publishCli,
        "--vault-root", vault,
        "--git-root", refs.repo,
        "--main-ref", mainRef,
        "--gh-pages-ref", "refs/heads/gh-pages",
        "--work-root", path.join(root, `invalid-${mainRef.replace(/[^A-Za-z0-9]+/gu, "-")}`),
      ], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 })
      assert.equal(invalidRef.status, 1)
      assert.equal(invalidRef.stderr, "")
      const invalidReceipt = JSON.parse(invalidRef.stdout)
      assert.equal(invalidReceipt.error_code, "GIT_REF_INVALID", mainRef)
      assert.match(invalidReceipt.operation_id, /^content-[0-9a-f]{20}$/u)
      assert.equal(invalidRef.stdout.includes(root), false)
      assert.equal(invalidRef.stdout.trim().split(/\r?\n/u).length, 1)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("publish CLI rejects unsupported caller authority flags without path leakage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-publish-flags-"))
  try {
    for (const [flag, value] of [["--content-map", path.join(root, "private-input")], ["--baseline-site", path.join(root, "private-input")], ["--cleanup", "true"]]) {
      const result = spawnSync(process.execPath, [
        publishCli,
        "--vault-root", path.join(root, "private-vault"),
        flag, path.join(root, "private-input"),
      ], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 })
      assert.equal(result.status, 1, flag)
      assert.equal(result.stderr, "", flag)
      const receipt = JSON.parse(result.stdout)
      assert.equal(receipt.error_code, "USAGE", flag)
      assert.equal(result.stdout.includes(root), false, flag)
      assert.equal(result.stdout.trim().split(/\r?\n/u).length, 1, flag)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("controller rejects caller output overrides before reading mutable authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-output-override-"))
  try {
    const result = await prepareContentPrivatePreview({
      vaultRoot: path.join(root, "vault"),
      workRoot: path.join(root, "work"),
      output: path.join(root, "caller-output"),
    })
    assert.equal(result.status, "needs_attention")
    assert.equal(result.error_code, "OUTPUT_OVERRIDE_FORBIDDEN")
    assert.equal(JSON.stringify(result).includes(root), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { cwd: repoRoot, encoding: "utf8" })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return result.stdout.trim()
}

/** @param {string} title @param {"paper"|"support"} layout @param {string} [body] */
function note(title, layout, body = "") {
  if (layout === "paper") return `---
title: ${title}
type: literature-note
status: integrated
layer: content
authors:
  - Synthetic Author
year: 2024
venue: Synthetic Venue
doi: 10.0000/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}
paper_type: empirical
---

# ${title}

## One-sentence Takeaway

A bounded synthetic paper.

## Citation

Synthetic citation.

## Research Question

What does this paper show?

## Connections

${body || "No new Knowledge links."}
`
  return `---
title: ${title}
type: support
layer: content
---

# ${title}

A bounded synthetic support page.
`
}

/** @param {string} root @param {string} relative @param {string|Buffer} bytes */
async function put(root, relative, bytes) {
  const absolute = path.join(root, ...relative.split("/"))
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, bytes)
}

/** @param {{root:string,vault:string}} fixture @param {boolean} includeNew @param {string} [newPaperName] @param {string} [newBody] */
async function populateVault(fixture, includeNew, newPaperName = "Smith and Jones 2024 — New Study.md", newBody = "- [[Knowledge/Concepts/New Concept]]") {
  for (const page of mappedPages) {
    await put(fixture.vault, page.source, note(path.posix.basename(page.source, ".md"), page.layout === "paper" ? "paper" : "support", "- [[Knowledge/Concepts/Flow|Flow]]"))
  }
  if (includeNew) {
    await put(fixture.vault, `Literature/Notes/${newPaperName}`, note("New Study", "paper", newBody))
    await put(fixture.vault, "Knowledge/Concepts/New Concept.md", note("New Concept", "support"))
  }
}

/** @param {string} root @param {string} mapPath @param {string} vault @param {boolean} buildBaseline */
async function makeFixture(root, mapPath, vault, buildBaseline) {
  const fixture = {
    root,
    vault,
    repo: path.join(root, "refs"),
    baseline: path.join(root, "baseline-build"),
    mainMap: path.join(root, "main-site-content.yml"),
  }
  await mkdir(fixture.repo, { recursive: true })
  await writeFile(fixture.mainMap, await readFile(mapPath))
  if (buildBaseline) {
    const buildWork = path.join(root, "baseline-work")
    const result = spawnSync(process.execPath, [
      cli,
      "build",
      "--content-map", fixture.mainMap,
      "--vault-root", fixture.vault,
      "--work-root", buildWork,
      "--output", fixture.baseline,
    ], { cwd: repoRoot, encoding: "utf8", timeout: 180_000 })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    await put(fixture.baseline, ".nojekyll", Buffer.alloc(0))
  }
  git(fixture.repo, ["init", "-b", "main"])
  git(fixture.repo, ["config", "user.email", "fixture@example.invalid"])
  git(fixture.repo, ["config", "user.name", "T13 Fixture"])
  await put(fixture.repo, "site-content.yml", await readFile(fixture.mainMap))
  git(fixture.repo, ["add", "site-content.yml"])
  git(fixture.repo, ["commit", "-m", "fixture main"])
  const mainSha = git(fixture.repo, ["rev-parse", "HEAD"])
  git(fixture.repo, ["checkout", "-b", "live-renderer", "main"])
  for (const relative of git(repoRoot, ["ls-files"]).split(/\r?\n/u).filter(Boolean)) {
    const source = path.join(repoRoot, ...relative.split("/"))
    const destination = path.join(fixture.repo, ...relative.split("/"))
    await mkdir(path.dirname(destination), { recursive: true })
    await cp(source, destination)
  }
  git(fixture.repo, ["add", "-A"])
  git(fixture.repo, ["commit", "-m", "fixture live renderer"])
  const rendererSha = git(fixture.repo, ["rev-parse", "HEAD"])
  git(fixture.repo, ["checkout", "--orphan", "gh-pages"])
  git(fixture.repo, ["rm", "-rf", "."])
  if (buildBaseline) await cp(fixture.baseline, path.join(fixture.repo, "site"), { recursive: true })
  else await put(fixture.repo, "site/.nojekyll", Buffer.alloc(0))
  git(fixture.repo, ["add", "site"])
  git(fixture.repo, ["commit", "-m", `fixture gh-pages\n\nRenderer-Main-SHA: ${rendererSha}`])
  const ghPagesSha = git(fixture.repo, ["rev-parse", "HEAD"])
  return { ...fixture, mainSha, rendererSha, ghPagesSha }
}

/** Build a complete main/live renderer pair so presentation compares two materializable commits.
 * @param {string} root @param {string} mapPath @param {string} vault @param {boolean} [mutateMain]
 */
async function makePresentationFixture(root, mapPath, vault, mutateMain = true) {
  const fixture = {
    root,
    vault,
    repo: path.join(root, "presentation-refs"),
    baseline: path.join(root, "presentation-baseline"),
    mainMap: path.join(root, "presentation-main-site-content.yml"),
  }
  await mkdir(fixture.repo, { recursive: true })
  await writeFile(fixture.mainMap, await readFile(mapPath))
  const baselineWork = path.join(root, "presentation-baseline-work")
  const baselineResult = spawnSync(process.execPath, [
    cli,
    "build",
    "--content-map", fixture.mainMap,
    "--vault-root", fixture.vault,
    "--work-root", baselineWork,
    "--output", fixture.baseline,
  ], { cwd: repoRoot, encoding: "utf8", timeout: 180_000 })
  assert.equal(baselineResult.status, 0, `${baselineResult.stdout}\n${baselineResult.stderr}`)
  await put(fixture.baseline, ".nojekyll", Buffer.alloc(0))
  git(fixture.repo, ["init", "-b", "main"])
  git(fixture.repo, ["config", "user.email", "fixture@example.invalid"])
  git(fixture.repo, ["config", "user.name", "T13 Presentation Fixture"])
  for (const relative of git(repoRoot, ["ls-files"]).split(/\r?\n/u).filter(Boolean)) {
    const sourcePath = path.join(repoRoot, ...relative.split("/"))
    const destination = path.join(fixture.repo, ...relative.split("/"))
    await mkdir(path.dirname(destination), { recursive: true })
    await cp(sourcePath, destination)
  }
  await put(fixture.repo, "site-content.yml", await readFile(fixture.mainMap))
  git(fixture.repo, ["add", "-A"])
  git(fixture.repo, ["commit", "-m", "fixture renderer baseline"])
  const rendererSha = git(fixture.repo, ["rev-parse", "HEAD"])
  git(fixture.repo, ["checkout", "-b", "live-renderer"])
  git(fixture.repo, ["checkout", "main"])
  if (mutateMain) {
    const stylePath = path.join(fixture.repo, "styles", "tracer-scholarly.scss")
    await writeFile(stylePath, `${await readFile(stylePath, "utf8")}\nbody { outline: 1px solid rgb(17, 34, 51); }\n`)
    git(fixture.repo, ["add", "styles/tracer-scholarly.scss"])
    git(fixture.repo, ["commit", "-m", "fixture output-affecting presentation change"])
  }
  const mainSha = git(fixture.repo, ["rev-parse", "refs/heads/main"])
  git(fixture.repo, ["checkout", "--orphan", "gh-pages"])
  git(fixture.repo, ["rm", "-rf", "."])
  await cp(fixture.baseline, path.join(fixture.repo, "site"), { recursive: true })
  git(fixture.repo, ["add", "site"])
  git(fixture.repo, ["commit", "-m", `fixture presentation gh-pages\n\nRenderer-Main-SHA: ${rendererSha}`])
  const ghPagesSha = git(fixture.repo, ["rev-parse", "HEAD"])
  return { ...fixture, mainSha, rendererSha, ghPagesSha }
}

/** @param {{root:string,vault:string,repo:string,baseline:string,mainMap:string,mainSha:string,rendererSha:string,ghPagesSha:string}} refs @param {string} spec */
async function replaceRendererBraceExpansionSpecifier(refs, spec) {
  git(refs.repo, ["checkout", "live-renderer"])
  const packagePath = path.join(refs.repo, "package.json")
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"))
  packageJson.dependencies["brace-expansion"] = spec
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
  git(refs.repo, ["add", "package.json"])
  git(refs.repo, ["commit", "-m", "fixture renderer dependency adversarial case"])
  const rendererSha = git(refs.repo, ["rev-parse", "HEAD"])
  git(refs.repo, ["checkout", "gh-pages"])
  git(refs.repo, ["commit", "--amend", "-m", `fixture gh-pages\n\nRenderer-Main-SHA: ${rendererSha}`])
  return { ...refs, rendererSha, ghPagesSha: git(refs.repo, ["rev-parse", "HEAD"]) }
}

/** @param {string} root */
async function exists(root) {
  try {
    await readFile(root)
    return true
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
  }
}

test("renderer file dependencies reject outside and untracked targets before resolver fallback", async () => {
  const cases = [
    { name: "outside", spec: "file:../node_modules/yaml" },
    { name: "untracked", spec: "file:node_modules/yaml" },
  ]
  for (const current of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), `tyrs-t13-renderer-file-${current.name}-`))
    const vault = path.join(root, "vault")
    const map = path.join(root, "map.yml")
    await mkdir(vault, { recursive: true })
    await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
    await populateVault({ root, vault }, false)
    let refs = await makeFixture(root, map, vault, false)
    refs = await replaceRendererBraceExpansionSpecifier(refs, current.spec)
    try {
      const result = await prepareContentPrivatePreview({
        vaultRoot: vault,
        gitRoot: refs.repo,
        mainRef: "refs/heads/main",
        ghPagesRef: "refs/heads/gh-pages",
        workRoot: path.join(root, "work"),
      })
      assert.equal(result.status, "needs_attention", current.name)
      assert.equal(result.error_code, "RENDERER_DEPENDENCY_INVALID", current.name)
      assert.equal(JSON.stringify(result).includes(root), false, current.name)
      assert.equal(await exists(path.join(root, "work", result.operation_id)), false, current.name)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("content lane creates one complete private preview from Vault plus temporary Git refs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-content-e2e-"))
  const vault = path.join(root, "vault")
  const map = path.join(root, "map.yml")
  await mkdir(vault, { recursive: true })
  await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
  await populateVault({ root, vault }, true)
  const refs = await makeFixture(root, map, vault, true)
  const dirtySentinels = {
    package: "CURRENT_DIRTY_PACKAGE_SENTINEL not valid json\n",
    tracer: "throw new Error(\"CURRENT_DIRTY_TRACER_SENTINEL\")\n",
    style: "CURRENT_DIRTY_STYLE_SENTINEL { this-is: invalid; }\n",
  }
  await put(refs.repo, "package.json", dirtySentinels.package)
  await put(refs.repo, "scripts/tracer.mjs", dirtySentinels.tracer)
  await put(refs.repo, "styles/tracer-scholarly.scss", dirtySentinels.style)
  const beforeMap = await readFile(map)
  const beforePaper = await readFile(path.join(vault, "Literature", "Notes", "Smith and Jones 2024 — New Study.md"))
  const workRoot = path.join(root, "private-work")
  const refsBefore = {
    main: git(refs.repo, ["rev-parse", "refs/heads/main"]),
    ghPages: git(refs.repo, ["rev-parse", "refs/heads/gh-pages"]),
  }
  try {
    const result = await prepareContentPrivatePreview({
      vaultRoot: vault,
      gitRoot: refs.repo,
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      workRoot,
    })
    assert.equal(result.status, "ready_for_review", JSON.stringify(result))
    assert.equal(result.next_action, "approve_content")
    assert.deepEqual(result.added_routes.map(({ route }) => route), [
      "/knowledge/concept/new-concept/",
      "/papers/smith-2024-new-study/",
    ])
    assert.deepEqual(
      result.changed_routes.map((/** @type {{ route: string }} */ entry) => entry.route),
      mappedPages.map((/** @type {{ route: string }} */ entry) => entry.route).sort(),
    )
    assert.deepEqual(result.removed_routes, [])
    assert.equal(result.mapping_identity.additions.length, 2)
    assert.equal(result.mapping_identity.map_sha256.length, 64)
    assert.equal(result.mapping_identity.map_blob_sha.length, 40)
    assert.equal(result.candidate_identity.base_gh_pages_sha, refs.ghPagesSha)
    assert.equal(result.candidate_identity.source_main_sha, refs.mainSha)
    assert.equal(result.candidate_identity.live_renderer_sha, refs.rendererSha)
    assert.equal(JSON.stringify(result).includes(root), false)
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false)
    assert.deepEqual(await readFile(path.join(vault, "Literature", "Notes", "Smith and Jones 2024 — New Study.md")), beforePaper)
    assert.deepEqual(await readFile(map), beforeMap)
    assert.deepEqual({
      main: git(refs.repo, ["rev-parse", "refs/heads/main"]),
      ghPages: git(refs.repo, ["rev-parse", "refs/heads/gh-pages"]),
    }, refsBefore)
    assert.equal(await readFile(path.join(refs.repo, "package.json"), "utf8"), dirtySentinels.package)
    assert.equal(await readFile(path.join(refs.repo, "scripts", "tracer.mjs"), "utf8"), dirtySentinels.tracer)
    assert.equal(await readFile(path.join(refs.repo, "styles", "tracer-scholarly.scss"), "utf8"), dirtySentinels.style)
    const frozenMap = path.join(workRoot, result.operation_id, "site-content.yml")
    const mapBytes = await readFile(frozenMap)
    assert.equal(mapBytes.equals(beforeMap), false)
    assert.equal(result.mapping_identity.map_sha256, sha256(mapBytes))
    assert.equal(await exists(path.join(workRoot, result.operation_id, "built-site")), true)
    assert.equal(await exists(path.join(workRoot, result.operation_id, "handoff", "site", "papers", "smith-2024-new-study", "index.html")), true)
    const candidateHtml = await readFile(path.join(workRoot, result.operation_id, "handoff", "site", "papers", "smith-2024-new-study", "index.html"), "utf8")
    assert.doesNotMatch(candidateHtml, /zotero:\/\/|PRIVATE|C:\\Users\\/i)

    const noChangeBaseline = path.join(root, "no-change-baseline")
    await cp(path.join(workRoot, result.operation_id, "handoff", "site"), noChangeBaseline, { recursive: true })
    git(refs.repo, ["rm", "-rf", "site"])
    await cp(noChangeBaseline, path.join(refs.repo, "site"), { recursive: true })
    git(refs.repo, ["add", "site"])
    git(refs.repo, ["commit", "-m", `fixture gh-pages no-change\n\nRenderer-Main-SHA: ${refs.rendererSha}`])
    const noChangeWork = path.join(root, "no-change-work")
    const noChange = await prepareContentPrivatePreview({
      vaultRoot: vault,
      gitRoot: refs.repo,
      contentMap: frozenMap,
      workRoot: noChangeWork,
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
    })
    assert.equal(noChange.status, "no_change")
    assert.equal(noChange.next_action, "none")
    assert.equal(await exists(path.join(noChangeWork, noChange.operation_id)), false)

    await put(refs.repo, "site/papers/legacy-route/index.html", Buffer.from("<html>legacy</html>\n"))
    git(refs.repo, ["add", "site/papers/legacy-route/index.html"])
    git(refs.repo, ["commit", "-m", `fixture gh-pages removal\n\nRenderer-Main-SHA: ${refs.rendererSha}`])
    const removal = await prepareContentPrivatePreview({
      vaultRoot: vault,
      gitRoot: refs.repo,
      contentMap: frozenMap,
      workRoot: path.join(root, "removal-work"),
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
    })
    assert.equal(removal.status, "needs_attention")
    assert.equal(removal.error_code, "ROUTE_REMOVAL")
    assert.deepEqual(removal.removed_routes, [
      { route: "/papers/legacy-route/", title: "legacy route", kind: "paper" },
    ])
    assert.deepEqual(removal.added_routes, [])
    assert.deepEqual(removal.changed_routes, [])
    assert.deepEqual(removal.checks, [{ name: "content_private_preview", outcome: "fail" }])
    assert.equal(removal.next_action, "request_manual_review")
    assert.equal(removal.candidate_identity, null)
    assert.equal(await exists(path.join(root, "removal-work", removal.operation_id)), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("site exact live verification returns no_change and cleans its session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-site-exact-unchanged-"))
  const vault = path.join(root, "vault")
  const map = path.join(root, "map.yml")
  const workRoot = path.join(root, "site-work")
  await mkdir(vault, { recursive: true })
  await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
  await populateVault({ root, vault }, false)
  const refs = await makeFixture(root, map, vault, true)
  try {
    const result = await contentPreview.verifyExactLiveContentForSite({
      vaultRoot: vault,
      gitRoot: refs.repo,
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      workRoot,
    })
    assert.equal(result.version, 1)
    assert.equal(result.lane, "site")
    assert.equal(result.status, "no_change")
    assert.equal(result.error_code, null)
    assert.equal(result.candidate_identity, null)
    assert.equal(result.next_action, "none")
    assert.deepEqual(result.checks.filter(({ name }) => name === "exact_live_content_equality"), [
      { name: "exact_live_content_equality", outcome: "pass" },
    ])
    assert.equal(await exists(path.join(workRoot, result.operation_id)), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("site exact live verification reuses an explicit operation id only after successful cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-site-exact-reuse-"))
  const vault = path.join(root, "vault")
  const map = path.join(root, "map.yml")
  const workRoot = path.join(root, "site-work")
  const operationId = "content-0123456789abcdefabcd"
  await mkdir(vault, { recursive: true })
  await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
  await populateVault({ root, vault }, false)
  const refs = await makeFixture(root, map, vault, true)
  const options = {
    vaultRoot: vault,
    gitRoot: refs.repo,
    mainRef: "refs/heads/main",
    ghPagesRef: "refs/heads/gh-pages",
    workRoot,
    operationId,
  }
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await contentPreview.verifyExactLiveContentForSite(options)
      assert.equal(result.operation_id, operationId)
      assert.equal(result.lane, "site")
      assert.equal(result.status, "no_change")
      assert.equal(result.error_code, null)
      assert.equal(result.candidate_identity, null)
      assert.equal(await exists(path.join(workRoot, operationId)), false)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("site exact live verification reports mapped Vault content changes without a candidate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-site-exact-mapped-change-"))
  const vault = path.join(root, "vault")
  const map = path.join(root, "map.yml")
  const workRoot = path.join(root, "site-work")
  await mkdir(vault, { recursive: true })
  const mapBytes = await readFile(path.join(repoRoot, "site-content.yml"))
  await writeFile(map, mapBytes)
  await populateVault({ root, vault }, false)
  const refs = await makeFixture(root, map, vault, true)
  const mappedPaper = mappedPages.find((/** @type {{layout:string}} */ page) => page.layout === "paper")
  assert.ok(mappedPaper)
  await put(vault, mappedPaper.source, note("Changed Mapped Paper", "paper", "- [[Knowledge/Concepts/Flow|Flow]]"))
  try {
    const result = await contentPreview.verifyExactLiveContentForSite({
      vaultRoot: vault,
      gitRoot: refs.repo,
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      workRoot,
    })
    assert.equal(result.version, 1)
    assert.equal(result.lane, "site")
    assert.equal(result.status, "needs_attention")
    assert.equal(result.error_code, "PENDING_CONTENT_CHANGES")
    assert.equal(result.candidate_identity, null)
    assert.match(result.summary, /content lane/u)
    assert.equal(result.next_action, "run_content_lane_first")
    assert.deepEqual(result.mapping_identity.additions, [])
    assert.deepEqual(await readFile(map), mapBytes)
    assert.deepEqual(result.checks.filter(({ name }) => name === "exact_live_content_equality"), [
      { name: "exact_live_content_equality", outcome: "fail" },
    ])
    assert.equal(await exists(path.join(workRoot, result.operation_id)), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("site exact verification reports a proposal and leaves the public content candidate isolated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-site-exact-proposal-"))
  const vault = path.join(root, "vault")
  const map = path.join(root, "map.yml")
  const siteWorkRoot = path.join(root, "site-work")
  const contentWorkRoot = path.join(root, "content-work")
  await mkdir(vault, { recursive: true })
  const mapBytes = await readFile(path.join(repoRoot, "site-content.yml"))
  await writeFile(map, mapBytes)
  await populateVault({ root, vault }, true)
  const refs = await makeFixture(root, map, vault, true)
  try {
    const siteResult = await contentPreview.verifyExactLiveContentForSite({
      vaultRoot: vault,
      gitRoot: refs.repo,
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      workRoot: siteWorkRoot,
    })
    assert.equal(siteResult.version, 1)
    assert.equal(siteResult.lane, "site")
    assert.equal(siteResult.status, "needs_attention")
    assert.equal(siteResult.error_code, "PENDING_CONTENT_CHANGES")
    assert.equal(siteResult.candidate_identity, null)
    assert.equal(siteResult.mapping_identity.additions.length, 2)
    assert.deepEqual(await readFile(map), mapBytes)
    assert.equal(await exists(path.join(siteWorkRoot, siteResult.operation_id)), false)

    const contentResult = await prepareContentPrivatePreview({
      vaultRoot: vault,
      gitRoot: refs.repo,
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      workRoot: contentWorkRoot,
    })
    assert.equal(contentResult.lane, "content")
    assert.equal(contentResult.status, "ready_for_review")
    assert.equal(contentResult.next_action, "approve_content")
    assert.ok(contentResult.candidate_identity)
    assert.equal(await exists(path.join(contentWorkRoot, contentResult.operation_id)), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("site exact verification keeps route removal as manual review", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-site-route-removal-"))
  const vault = path.join(root, "vault")
  const map = path.join(root, "map.yml")
  const workRoot = path.join(root, "site-work")
  await mkdir(vault, { recursive: true })
  await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
  await populateVault({ root, vault }, false)
  const refs = await makeFixture(root, map, vault, false)
  for (const relative of [
    "site/papers/legacy-route/index.html",
    "site/knowledge/concept/zeta/index.html",
  ]) await put(refs.repo, relative, Buffer.from("<html>legacy</html>\n"))
  git(refs.repo, ["add", "site"])
  git(refs.repo, ["commit", "-m", `fixture gh-pages site route removals\n\nRenderer-Main-SHA: ${refs.rendererSha}`])
  try {
    const result = await contentPreview.verifyExactLiveContentForSite({
      vaultRoot: vault,
      gitRoot: refs.repo,
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      workRoot,
    })
    assert.equal(result.lane, "site")
    assert.equal(result.status, "needs_attention")
    assert.equal(result.error_code, "ROUTE_REMOVAL")
    assert.deepEqual(result.removed_routes, [
      { route: "/knowledge/concept/zeta/", title: "zeta", kind: "concept" },
      { route: "/papers/legacy-route/", title: "legacy route", kind: "paper" },
    ])
    assert.equal(result.candidate_identity, null)
    assert.equal(await exists(path.join(workRoot, result.operation_id)), false)
    assert.equal(JSON.stringify(result).includes(root), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("site presentation materializes current main once, runs QA, and persists bounded screenshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-site-presentation-ready-"))
  const vault = path.join(root, "vault")
  const map = path.join(root, "map.yml")
  const workRoot = path.join(root, "site-work")
  await mkdir(vault, { recursive: true })
  await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
  await populateVault({ root, vault }, false)
  const refs = await makePresentationFixture(root, map, vault, true)
  const paper = mappedPages.find((/** @type {{layout:string}} */ page) => page.layout === "paper")
  const knowledge = mappedPages.find((/** @type {{layout:string}} */ page) => page.layout === "support")
  assert.ok(paper)
  assert.ok(knowledge)
  const paperRoute = paper.route
  const knowledgeRoute = knowledge.route
  let qaCalls = 0
  try {
    const result = await contentPreview.prepareSitePrivatePreviewForTest({
      vaultRoot: vault,
      gitRoot: refs.repo,
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      workRoot,
    }, {
      afterLiveEquality: async (/** @type {Readonly<Record<string,string>>} */ context) => {
        assert.equal(Object.isFrozen(context), true)
        assert.equal("mapPath" in context, false)
        assert.equal("content" in context, false)
        await put(vault, paper.source, note("After live equality mutation", paper.layout, "- [[Knowledge/Concepts/Flow|Flow]]"))
        git(refs.repo, ["checkout", "main"])
        await writeFile(path.join(refs.repo, "styles", "tracer-scholarly.scss"), "DIRTY_WORKTREE_PRESENTATION_SENTINEL\n")
      },
      qa: async (/** @type {any} */ qaOptions) => {
        qaCalls += 1
        assert.equal(qaOptions.basePath, "/Tyler-Vault_PaperNote_ReadingSite/")
        assert.deepEqual(qaOptions.sourceDiff.changedFiles, ["styles/tracer-scholarly.scss"])
        assert.equal(qaOptions.mappedRoutes.some((/** @type {{route:string}} */ entry) => entry.route === paperRoute), true)
        assert.equal(qaOptions.mappedRoutes.some((/** @type {{route:string}} */ entry) => entry.route === knowledgeRoute), true)
        const html = await readFile(path.join(qaOptions.siteRoot, "index.html"), "utf8")
        assert.equal(html.includes("DIRTY_WORKTREE_PRESENTATION_SENTINEL"), false)
        return {
          status: "pass",
          screenshots: [
            { route: knowledgeRoute, bytes: Buffer.from("knowledge-png") },
            { route: paperRoute, bytes: Buffer.from("paper-png") },
          ],
        }
      },
    })
    assert.equal(qaCalls, 1)
    assert.equal(result.status, "ready_for_review")
    assert.equal(result.next_action, "approve_site")
    assert.equal(result.error_code, null)
    assert.ok(result.candidate_identity)
    assert.equal(result.candidate_identity.source_main_sha, refs.mainSha)
    assert.equal(result.candidate_identity.base_gh_pages_sha, refs.ghPagesSha)
    assert.equal(result.candidate_identity.live_renderer_sha, refs.rendererSha)
    assert.equal(result.candidate_identity.main_renderer_tree_sha256.length, 64)
    assert.equal(result.candidate_identity.map_sha256.length, 64)
    assert.equal(result.candidate_identity.site_sha256.length, 64)
    assert.equal(Object.prototype.hasOwnProperty.call(result.candidate_identity, "screenshots"), false)
    assert.deepEqual(result.preview.screenshots.map((/** @type {{route:string,handle:string,bytes:number}} */ entry) => ({ route: entry.route, handle: entry.handle, bytes: entry.bytes })), [
      { route: knowledgeRoute, handle: "screenshots/shot-0000.png", bytes: "knowledge-png".length },
      { route: paperRoute, handle: "screenshots/shot-0001.png", bytes: "paper-png".length },
    ])
    assert.equal(JSON.stringify(result).includes(root), false)
    assert.equal(JSON.stringify(result).includes("Buffer"), false)
    const session = path.join(workRoot, result.operation_id)
    assert.equal(await exists(session), true)
    assert.equal(await readFile(path.join(session, result.preview.screenshots[0].handle), "utf8"), "knowledge-png")
    assert.equal(await readFile(path.join(session, result.preview.screenshots[1].handle), "utf8"), "paper-png")
    const mainHtml = await readFile(path.join(session, "main-handoff", "site", paper.route.slice(1), "index.html"), "utf8")
    assert.doesNotMatch(mainHtml, /After live equality mutation/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("site presentation exposes a stable QA failure and removes its session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-site-presentation-qa-failure-"))
  const vault = path.join(root, "vault")
  const map = path.join(root, "map.yml")
  const workRoot = path.join(root, "site-work")
  await mkdir(vault, { recursive: true })
  await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
  await populateVault({ root, vault }, false)
  const refs = await makePresentationFixture(root, map, vault, true)
  try {
    const result = await contentPreview.prepareSitePrivatePreviewForTest({
      vaultRoot: vault,
      gitRoot: refs.repo,
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      workRoot,
    }, {
      qa: async () => ({ status: "fail", error_code: "QA_SERVER_CLOSE_FAILED", screenshots: [] }),
    })
    assert.equal(result.status, "needs_attention")
    assert.equal(result.error_code, "QA_SERVER_CLOSE_FAILED")
    assert.equal(result.candidate_identity, null)
    assert.equal(result.checks.some((/** @type {{name:string,outcome:string}} */ entry) => entry.name === "headless_qa" && entry.outcome === "fail"), true)
    assert.equal(await exists(path.join(workRoot, result.operation_id)), false)
    assert.equal(JSON.stringify(result).includes(root), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("site presentation returns no_change without a second renderer install when main equals live", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-site-presentation-no-change-"))
  const vault = path.join(root, "vault")
  const map = path.join(root, "map.yml")
  const workRoot = path.join(root, "site-work")
  await mkdir(vault, { recursive: true })
  await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
  await populateVault({ root, vault }, false)
  const refs = await makePresentationFixture(root, map, vault, false)
  let qaCalls = 0
  try {
    const result = await contentPreview.prepareSitePrivatePreviewForTest({
      vaultRoot: vault,
      gitRoot: refs.repo,
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      workRoot,
    }, { qa: async () => { qaCalls += 1; throw new Error("QA must not run") } })
    assert.equal(refs.mainSha, refs.rendererSha)
    assert.equal(result.status, "no_change")
    assert.equal(result.error_code, null)
    assert.equal(result.candidate_identity, null)
    assert.equal(qaCalls, 0)
    assert.equal(await exists(path.join(workRoot, result.operation_id)), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("site presentation stops for pending content before current-main materialization or QA", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-site-presentation-pending-content-"))
  const vault = path.join(root, "vault")
  const map = path.join(root, "map.yml")
  const workRoot = path.join(root, "site-work")
  await mkdir(vault, { recursive: true })
  await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
  await populateVault({ root, vault }, false)
  const refs = await makePresentationFixture(root, map, vault, false)
  const paper = mappedPages.find((/** @type {{layout:string}} */ page) => page.layout === "paper")
  assert.ok(paper)
  await put(vault, paper.source, note("Pending content change", paper.layout, "- [[Knowledge/Concepts/Flow|Flow]]"))
  let qaCalls = 0
  try {
    const result = await contentPreview.prepareSitePrivatePreviewForTest({
      vaultRoot: vault,
      gitRoot: refs.repo,
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      workRoot,
    }, { qa: async () => { qaCalls += 1; throw new Error("QA must not run") } })
    assert.equal(result.lane, "site")
    assert.equal(result.status, "needs_attention")
    assert.equal(result.error_code, "PENDING_CONTENT_CHANGES")
    assert.equal(result.candidate_identity, null)
    assert.equal(result.next_action, "run_content_lane_first")
    assert.equal(qaCalls, 0)
    assert.equal(await exists(path.join(workRoot, result.operation_id)), false)
    assert.equal(JSON.stringify(result).includes(root), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("route-removal result is exact, sorted, and redacted before renderer work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-route-removal-"))
  const vault = path.join(root, "vault")
  const map = path.join(root, "map.yml")
  await mkdir(vault, { recursive: true })
  await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
  await populateVault({ root, vault }, false)
  const refs = await makeFixture(root, map, vault, false)
  for (const relative of [
    "site/papers/legacy-route/index.html",
    "site/knowledge/concept/zeta/index.html",
    "site/knowledge/author/alpha/index.html",
  ]) {
    await put(refs.repo, relative, Buffer.from("<html>legacy</html>\n"))
  }
  git(refs.repo, ["add", "site"])
  git(refs.repo, ["commit", "-m", `fixture gh-pages route removals\n\nRenderer-Main-SHA: ${refs.rendererSha}`])
  try {
    const result = await prepareContentPrivatePreview({
      vaultRoot: vault,
      gitRoot: refs.repo,
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      workRoot: path.join(root, "work"),
    })
    const { operation_id: operationId, ...withoutOperationId } = result
    assert.match(operationId, /^content-[0-9a-f]{20}$/u)
    assert.deepEqual(withoutOperationId, {
      version: 1,
      lane: "content",
      status: "needs_attention",
      summary: "私人筆記網頁預覽停止，請先處理列出的問題。",
      added_routes: [],
      changed_routes: [],
      removed_routes: [
        { route: "/knowledge/author/alpha/", title: "alpha", kind: "author" },
        { route: "/knowledge/concept/zeta/", title: "zeta", kind: "concept" },
        { route: "/papers/legacy-route/", title: "legacy route", kind: "paper" },
      ],
      checks: [{ name: "content_private_preview", outcome: "fail" }],
      next_action: "request_manual_review",
      error_code: "ROUTE_REMOVAL",
      mapping_identity: { map_sha256: null, map_blob_sha: null, additions: [] },
      candidate_identity: null,
      preview: { pages: 0, routes: 0, files: 0 },
    })
    assert.equal(JSON.stringify(result).includes(root), false)
    assert.equal(await exists(path.join(root, "work", operationId)), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("operation nonce is opaque and fresh for each attempt", () => {
  const first = opaqueOperationId("same-authority")
  const second = opaqueOperationId("same-authority")
  assert.match(first, /^content-[0-9a-f]{20}$/u)
  assert.match(second, /^content-[0-9a-f]{20}$/u)
  assert.notEqual(first, second)
})

test("content lane route normalization is deterministic and rejects unsupported input", () => {
  assert.equal(normalizeRouteSlug("Guo et al. 2024 — Benchmarking Micro-action Recognition", true), "guo-2024-benchmarking-micro-action-recognition")
  assert.equal(normalizeRouteSlug("Smith and Jones 2024 — Title", true), "smith-2024-title")
  assert.equal(normalizeRouteSlug("Micro-action Recognition"), "micro-action-recognition")
  assert.equal(routeForSource("Knowledge/Methods/Micro-action Recognition.md"), "/knowledge/method/micro-action-recognition/")
  assert.throws(() => normalizeRouteSlug("中文純文字"), (error) => /** @type {any} */ (error).code === "ROUTE_UNSUPPORTED")
})

test("content lane fails closed for collision, unresolved one-hop target, privacy, and renderer drift", async () => {
  const cases = [
    {
      name: "collision",
      file: "Guo 2024 — Benchmarking Micro-action Recognition.md",
      body: "- [[Knowledge/Concepts/Flow|Flow]]",
      code: "ROUTE_COLLISION",
    },
    {
      name: "unresolved",
      file: "Unique 2024 — Unresolved.md",
      body: "- [[Knowledge/Concepts/Missing Target]]",
      code: "DISCOVERY_TARGET_UNRESOLVED",
    },
    {
      name: "privacy",
      file: "Unique 2024 — Private.md",
      body: "- [[Knowledge/Concepts/Flow|Flow]]\n\nprivate zotero://select/library/items/PRIVATE123",
      code: "SOURCE_UNSAFE_URL_SCHEME",
    },
  ]
  for (const current of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), `tyrs-t13-${current.name}-`))
    const vault = path.join(root, "vault")
    const map = path.join(root, "map.yml")
    await mkdir(vault, { recursive: true })
    await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
    await populateVault({ root, vault }, true, current.file, current.body)
    const refs = await makeFixture(root, map, vault, false)
    try {
      const result = await prepareContentPrivatePreview({
        vaultRoot: vault,
        gitRoot: refs.repo,
        mainRef: "refs/heads/main",
        ghPagesRef: "refs/heads/gh-pages",
        workRoot: path.join(root, "work"),
      })
      assert.equal(result.status, "needs_attention", current.name)
      assert.equal(result.error_code, current.code, current.name)
      assert.equal(await exists(path.join(root, "work", result.operation_id)), false, current.name)
      assert.equal(JSON.stringify(result).includes(root), false, current.name)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-renderer-drift-"))
  const vault = path.join(root, "vault")
  const map = path.join(root, "map.yml")
  await mkdir(vault, { recursive: true })
  await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
  await populateVault({ root, vault }, true)
  const refs = await makeFixture(root, map, vault, false)
  try {
    const result = await prepareContentPrivatePreview({
      vaultRoot: vault,
      gitRoot: refs.repo,
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      workRoot: path.join(root, "work"),
      liveRendererSha: "0000000000000000000000000000000000000000",
    })
    assert.equal(result.status, "needs_attention")
    assert.equal(result.error_code, "RENDERER_PROVENANCE_INPUT_FORBIDDEN")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("operation IDs are opaque and failed attempts never delete traversal or reused sentinels", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-operation-id-"))
  const vault = path.join(root, "vault")
  const map = path.join(root, "map.yml")
  const workRoot = path.join(root, "work")
  await mkdir(vault, { recursive: true })
  await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
  await populateVault({ root, vault }, true)
  const refs = await makeFixture(root, map, vault, false)
  const traversalRoot = path.join(root, "outside")
  const traversalSentinel = path.join(traversalRoot, "sentinel.txt")
  const reusedId = "content-aaaaaaaaaaaaaaaaaaaa"
  const reusedRoot = path.join(workRoot, reusedId)
  const reusedSentinel = path.join(reusedRoot, "sentinel.txt")
  await mkdir(traversalRoot, { recursive: true })
  await writeFile(traversalSentinel, "keep traversal sentinel\n")
  await mkdir(reusedRoot, { recursive: true })
  await writeFile(reusedSentinel, "keep reused sentinel\n")
  try {
    const traversal = await prepareContentPrivatePreview({
      vaultRoot: vault,
      gitRoot: refs.repo,
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      workRoot,
      operationId: "../outside",
    })
    assert.equal(traversal.status, "needs_attention")
    assert.equal(traversal.error_code, "OPERATION_ID_INVALID")
    assert.match(traversal.operation_id, /^content-[0-9a-f]{20}$/u)
    assert.equal(await exists(traversalSentinel), true)

    const reused = await prepareContentPrivatePreview({
      vaultRoot: vault,
      gitRoot: refs.repo,
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      workRoot,
      operationId: reusedId,
    })
    assert.equal(reused.status, "needs_attention")
    assert.equal(reused.error_code, "OPERATION_ID_REUSED")
    assert.equal(reused.operation_id, reusedId)
    assert.equal(await exists(reusedSentinel), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Git authority accepts only immutable safe refs and rejects revision expressions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-git-ref-"))
  const vault = path.join(root, "vault")
  const map = path.join(root, "map.yml")
  await mkdir(vault, { recursive: true })
  await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
  await populateVault({ root, vault }, false)
  const refs = await makeFixture(root, map, vault, false)
  try {
    for (const mainRef of ["refs/heads/main~1", "HEAD~1", "refs/heads/main^", "refs/heads/main:site-content.yml", "--help", "refs/heads/-bad"]) {
      const result = await prepareContentPrivatePreview({
        vaultRoot: vault,
        gitRoot: refs.repo,
        mainRef,
        ghPagesRef: "refs/heads/gh-pages",
        workRoot: path.join(root, "work", mainRef.replace(/[^A-Za-z0-9]+/gu, "-")),
      })
      assert.equal(result.status, "needs_attention", mainRef)
      assert.equal(result.error_code, "GIT_REF_INVALID", mainRef)
      assert.match(result.operation_id, /^content-[0-9a-f]{20}$/u)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("malformed and wrong deployed renderer provenance fail closed before build", async () => {
  for (const mode of ["missing", "ambiguous", "malformed", "wrong"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `tyrs-t13-provenance-${mode}-`))
    const vault = path.join(root, "vault")
    const map = path.join(root, "map.yml")
    await mkdir(vault, { recursive: true })
    await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
    await populateVault({ root, vault }, false)
    const refs = await makeFixture(root, map, vault, false)
    try {
      const message = mode === "missing"
        ? "fixture gh-pages"
        : mode === "ambiguous"
          ? `fixture gh-pages\n\nRenderer-Main-SHA: ${refs.mainSha}\nRenderer-Main-SHA: ${refs.mainSha}`
          : mode === "malformed"
            ? "fixture gh-pages\n\nRenderer-Main-SHA: not-a-sha"
            : "fixture gh-pages\n\nRenderer-Main-SHA: 0000000000000000000000000000000000000000"
      git(refs.repo, ["checkout", "gh-pages"])
      git(refs.repo, ["commit", "--amend", "-m", message])
      const result = await prepareContentPrivatePreview({
        vaultRoot: vault,
        gitRoot: refs.repo,
        mainRef: "refs/heads/main",
        ghPagesRef: "refs/heads/gh-pages",
        workRoot: path.join(root, "work"),
      })
      assert.equal(result.status, "needs_attention")
      assert.equal(result.error_code, {
        missing: "RENDERER_PROVENANCE_MISSING",
        ambiguous: "RENDERER_PROVENANCE_AMBIGUOUS",
        malformed: "RENDERER_PROVENANCE_INVALID",
        wrong: "RENDERER_PROVENANCE_INVALID",
      }[mode])
      assert.equal(JSON.stringify(result).includes(root), false)
      assert.equal(await exists(path.join(root, "output")), false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("cleanup failure is visible through an internal controller seam without exposing paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-cleanup-failure-"))
  const vault = path.join(root, "vault")
  const map = path.join(root, "map.yml")
  const workRoot = path.join(root, "work")
  await mkdir(vault, { recursive: true })
  await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
  await populateVault({ root, vault }, false)
  await rm(path.join(vault, "Literature", "Notes"), { recursive: true, force: true })
  const refs = await makeFixture(root, map, vault, false)
  let cleanupAttempts = 0
  try {
    const result = await prepareContentPrivatePreviewForTest({
      vaultRoot: vault,
      gitRoot: refs.repo,
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      workRoot,
    }, {
      removeOwnedDirectory: async () => {
        cleanupAttempts += 1
        throw new Error(path.join(root, "must-not-appear"))
      },
    })
    assert.equal(result.status, "needs_attention")
    assert.equal(result.error_code, "CLEANUP_FAILED")
    assert.equal(result.candidate_identity, null)
    assert.deepEqual(result.checks, [{ name: "cleanup", outcome: "fail" }])
    assert.equal(result.next_action, "request_manual_cleanup")
    assert.equal(cleanupAttempts > 0, true)
    assert.equal(JSON.stringify(result).includes(root), false)
    assert.equal(await exists(path.join(workRoot, result.operation_id)), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("site verification cleanup failure is visible and never returns a candidate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-t13-site-cleanup-failure-"))
  const vault = path.join(root, "vault")
  const map = path.join(root, "map.yml")
  const workRoot = path.join(root, "work")
  await mkdir(vault, { recursive: true })
  await writeFile(map, await readFile(path.join(repoRoot, "site-content.yml")))
  await populateVault({ root, vault }, false)
  await rm(path.join(vault, "Literature", "Notes"), { recursive: true, force: true })
  const refs = await makeFixture(root, map, vault, false)
  let cleanupAttempts = 0
  try {
    const result = await prepareContentPrivatePreviewForTest({
      vaultRoot: vault,
      gitRoot: refs.repo,
      mainRef: "refs/heads/main",
      ghPagesRef: "refs/heads/gh-pages",
      workRoot,
    }, {
      siteVerification: true,
      removeOwnedDirectory: async () => {
        cleanupAttempts += 1
        throw new Error(path.join(root, "must-not-appear"))
      },
    })
    assert.equal(result.version, 1)
    assert.equal(result.lane, "site")
    assert.equal(result.status, "needs_attention")
    assert.equal(result.error_code, "CLEANUP_FAILED")
    assert.equal(result.candidate_identity, null)
    assert.deepEqual(result.checks, [{ name: "cleanup", outcome: "fail" }])
    assert.equal(result.next_action, "request_manual_cleanup")
    assert.equal(cleanupAttempts > 0, true)
    assert.equal(JSON.stringify(result).includes(root), false)
    assert.equal(await exists(path.join(workRoot, result.operation_id)), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
