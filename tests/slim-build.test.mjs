import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { parse as parseYaml } from "yaml"

import { loadSiteContent } from "../lib/slim-content-map.mjs"
import { parseArgs } from "../scripts/slim-build.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const cli = path.join(repoRoot, "scripts", "slim-build.mjs")

/** @typedef {[source:string,route:string,layout:"paper"|"support"]} ApprovedPage */
/** @typedef {{source:string,route:string,layout:"paper"|"support"}} MappedPage */
/** @typedef {{root:string,vault:string,work:string,output:string}} FixturePaths */

/** @type {MappedPage[]} */
const mappedPages = parseYaml(await readFile(path.join(repoRoot, "site-content.yml"), "utf8")).pages
/** @type {ApprovedPage[]} */
const approvedPages = mappedPages.map((page) => [page.source, page.route, page.layout])
assert.ok(approvedPages.length > 0)

const tracerCsp = "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self' data:; frame-src 'none'; img-src 'self' data:; media-src 'self'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; form-action 'none'"

test("default work root stays outside repository ignore rules", () => {
  const options = parseArgs(["build", "--vault-root", path.join(repoRoot, "vault-fixture")])
  const relativeWork = path.relative(repoRoot, options.workRoot)
  assert.ok(relativeWork === ".." || relativeWork.startsWith(`..${path.sep}`) || path.isAbsolute(relativeWork))
  assert.equal(path.relative(repoRoot, options.output).split(path.sep)[0], ".artifacts")
})

/** @param {"paper"|"support"} layout @returns {MappedPage} */
function pageForLayout(layout) {
  const page = mappedPages.find((candidate) => candidate.layout === layout)
  assert.ok(page, `missing ${layout} page in site-content.yml`)
  return page
}

/** @param {{vault:string}} paths @param {string} source */
function mappedSourcePath(paths, source) {
  return path.join(paths.vault, ...source.split("/"))
}

/** @param {{vault:string}} paths @param {string} source @param {string|Buffer} bytes */
async function replaceMappedSource(paths, source, bytes) {
  await writeFile(mappedSourcePath(paths, source), bytes)
}

/** @param {string} root @returns {Promise<Array<[string,Buffer]>>} */
async function outputTree(root) {
  /** @type {Array<[string,Buffer]>} */
  const files = []
  /** @param {string} directory */
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else files.push([path.relative(root, absolute).split(path.sep).join("/"), await readFile(absolute)])
    }
  }
  await walk(root)
  return files.sort(([left], [right]) => left.localeCompare(right))
}

/** @param {number} index @param {"paper"|"support"} layout */
function noteFor(index, layout) {
  const title = `Approved Node ${index}`
  if (layout === "paper") return `---
title: The Full Approved Publication ${index}
type: literature-note
status: integrated
authors:
  - Synthetic Author
year: 2024
venue: Synthetic Venue
doi: 10.0000/synthetic-${index}
paper_type: empirical
author_keywords:
  - approved
reader_keywords:
  - phase-one
projects: PHASE1_WORKFLOW_SENTINEL
draft_source: PHASE1_WORKFLOW_SENTINEL
model: PHASE1_WORKFLOW_SENTINEL
zotero_uri: zotero://select/library/items/PRIVATE123
---

# Synthetic Author 2024 — ${title}

## One-sentence Takeaway

A synthetic approved paper.

[External research source](https://example.org/research-source)

| Term | Source Definition | Boundary or Distinction |
| --- | --- | --- |
| Synthetic construct | A complete definition for responsive reading. | A useful distinction from adjacent constructs. |

## Citation

Synthetic citation.

## Research Question

What does the bounded Phase 1 build preserve?

## Method

### Design or Approach

Synthetic method details.

## Main Results

### Result Index

Synthetic results.

## Authors' Discussion

### Conclusions

Synthetic discussion.

## Missing or Unclear Information

Synthetic uncertainty.

## Critical Appraisal

### Strengths

Synthetic appraisal.

## Relevance to My Research

### Claims Supported

Synthetic relevance.

## Connections

- [[Knowledge/Concepts/Flow|Flow]]
`
  return `---
title: ${title}
type: support
projects: PHASE1_WORKFLOW_SENTINEL
reading_status: PHASE1_WORKFLOW_SENTINEL
---

# ${title}

A synthetic support node.

## Definition

A synthetic public definition for ${title}.
`
}

/** @returns {Promise<{root:string,vault:string,work:string,output:string}>} */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-slim-red-"))
  const vault = path.join(root, "vault")
  const work = path.join(root, "work")
  const output = path.join(root, "output")
  await Promise.all([mkdir(vault), mkdir(work)])
  for (const [index, [source, route, layout]] of approvedPages.entries()) {
    const absolute = path.join(vault, ...source.split("/"))
    await mkdir(path.dirname(absolute), { recursive: true })
    const note = noteFor(index, layout)
    const navigationCapitalizationFixture = /^\/knowledge\/(?:concept|method|task|synthesis|map)\//.test(route)
      ? note.replaceAll(`Approved Node ${index}`, `approved Node ${index}`)
      : /^\/knowledge\/author\//.test(route)
        ? note.replaceAll(`Approved Node ${index}`, "patricia c. jackman")
      : note
    await writeFile(absolute, navigationCapitalizationFixture)
  }
  return { root, vault, work, output }
}

/** @param {{vault:string,work:string,output:string}} paths @param {"preflight"|"build"} command @param {NodeJS.ProcessEnv} [env] */
function invoke(paths, command, env = {}) {
  return spawnSync(process.execPath, [cli, command, "--vault-root", paths.vault, "--work-root", paths.work, "--output", paths.output], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...env },
  })
}

/** @param {{vault:string,work:string,output:string}} paths @param {"preflight"|"build"} command @param {string} contentMap */
function invokeWithMap(paths, command, contentMap) {
  return spawnSync(process.execPath, [
    cli,
    command,
    "--content-map", contentMap,
    "--vault-root", paths.vault,
    "--work-root", paths.work,
    "--output", paths.output,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
  })
}

/** @param {{vault:string}} paths @returns {Promise<Map<string, Buffer>>} */
async function mappedSourceBytes(paths) {
  const bytes = new Map()
  for (const [source] of approvedPages) bytes.set(source, await readFile(path.join(paths.vault, ...source.split("/"))))
  return bytes
}

/** @param {{vault:string}} paths @param {Map<string, Buffer>} before */
async function assertMappedSourceBytesUnchanged(paths, before) {
  for (const [source, bytes] of before) assert.deepEqual(await readFile(path.join(paths.vault, ...source.split("/"))), bytes, source)
}

/** @param {string} candidate */
async function pathExists(candidate) {
  try {
    await lstat(candidate)
    return true
  } catch (error) {
    if (filesystemErrorCode(error) === "ENOENT") return false
    throw error
  }
}

/** @param {unknown} error */
function filesystemErrorCode(error) {
  if (!error || typeof error !== "object" || !("code" in error)) return "unknown"
  const code = /** @type {{code?:unknown}} */ (error).code
  return typeof code === "string" ? code : "unknown"
}

/** @param {unknown} error */
function isLinkCapabilityDenial(error) {
  const code = filesystemErrorCode(error)
  const denied = process.platform === "win32"
    ? ["EACCES", "EPERM", "ENOTSUP"]
    : ["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP"]
  return denied.includes(code)
}

/** @param {import("node:test").TestContext} t @param {string} target @param {string} link */
async function createMappedDirectoryLink(t, target, link) {
  const type = process.platform === "win32" ? "junction" : "dir"
  try {
    await symlink(target, link, type)
    return true
  } catch (error) {
    if (isLinkCapabilityDenial(error)) {
      t.skip(`mapped-source ${type} creation denied: ${filesystemErrorCode(error)}`)
      return false
    }
    throw error
  }
}

test("Phase 5 slim-build preflight rejects distinct Vault/work/output overlaps before mutation", async () => {
  /** @type {Array<[string,(paths:FixturePaths)=>string,(paths:FixturePaths)=>string]>} */
  const overlapCases = [
    ["work nested under Vault", (paths) => path.join(paths.vault, "overlap-work"), (paths) => path.join(paths.root, "overlap-output")],
    ["work equals output", (paths) => path.join(paths.root, "overlap-work-output"), (paths) => path.join(paths.root, "overlap-work-output")],
    ["output nested under Vault", (paths) => paths.work, (paths) => path.join(paths.vault, "overlap-output")],
  ]
  for (const [name, workRoot, output] of overlapCases) {
    const paths = await fixture()
    try {
      const before = await mappedSourceBytes(paths)
      const runPaths = { ...paths, work: workRoot(paths), output: output(paths) }
      assert.equal(await pathExists(runPaths.output), false, `${name}: output must start absent`)
      const result = invoke(runPaths, "preflight")
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
      assert.equal(result.stderr, "")
      assert.deepEqual(JSON.parse(result.stdout).error, {
        code: "PATH_OVERLAP_NOT_ALLOWED",
        message: "Vault, work, and output paths must be disjoint",
      })
      assert.equal(await pathExists(runPaths.output), false, `${name}: output must remain absent`)
      await assertMappedSourceBytesUnchanged(paths, before)
    } finally {
      await rm(paths.root, { recursive: true, force: true })
    }
  }
})

test("Phase 5 slim-build preflight rejects a mapped source directory link/reparse escape before output mutation", async (t) => {
  const paths = await fixture()
  try {
    const before = await mappedSourceBytes(paths)
    const mappedDirectory = path.join(paths.vault, "Literature", "Notes")
    const outside = path.join(paths.root, "outside-mapped-notes")
    await mkdir(outside)
    for (const [source] of approvedPages.filter(([source]) => source.startsWith("Literature/Notes/"))) {
      const target = path.join(outside, ...source.split("/").slice(2))
      await mkdir(path.dirname(target), { recursive: true })
      const sourceBytes = before.get(source)
      assert.ok(sourceBytes, source)
      await writeFile(target, sourceBytes)
    }
    await rm(mappedDirectory, { recursive: true, force: true })
    if (!await createMappedDirectoryLink(t, outside, mappedDirectory)) return

    assert.equal((await lstat(mappedDirectory)).isSymbolicLink(), true)
    const result = invoke(paths, "preflight")
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stderr, "")
    assert.deepEqual(JSON.parse(result.stdout).error, {
      code: "SOURCE_LINK_NOT_ALLOWED",
      message: "mapped source contains a link or reparse point",
    })
    assert.equal(result.stdout.includes(paths.root), false, "source-boundary errors must not disclose absolute sandbox paths")
    assert.equal(await pathExists(paths.output), false)
    await assertMappedSourceBytesUnchanged(paths, before)
    assert.equal((await lstat(mappedDirectory)).isSymbolicLink(), true)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("Phase 5 slim-build build rejects mapped source invalid UTF-8 with a stable redacted error and no output", async () => {
  const paths = await fixture()
  try {
    const source = path.join(paths.vault, ...approvedPages[0][0].split("/"))
    await writeFile(source, Buffer.concat([
      Buffer.from("---\ntitle: Invalid UTF8\ntype: literature-note\nstatus: integrated\n---\n\n# Invalid\n", "utf8"),
      Buffer.from([0xc3, 0x28]),
    ]))
    const before = await mappedSourceBytes(paths)
    const result = invoke(paths, "build")
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stderr, "")
    assert.deepEqual(JSON.parse(result.stdout).error, {
      code: "SOURCE_INVALID_UTF8",
      message: `${approvedPages[0][0]} is not strict UTF-8`,
    })
    assert.equal(result.stdout.includes(paths.root), false, "source-boundary errors must not disclose absolute sandbox paths")
    assert.equal(await pathExists(paths.output), false)
    await assertMappedSourceBytesUnchanged(paths, before)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("Phase 5 slim-build build rejects mapped source NUL with a stable redacted error and no output", async () => {
  const paths = await fixture()
  try {
    const source = path.join(paths.vault, ...approvedPages[0][0].split("/"))
    await writeFile(source, Buffer.concat([
      Buffer.from("---\ntitle: NUL\ntype: literature-note\nstatus: integrated\n---\n\n# NUL\n", "utf8"),
      Buffer.from("safe\0unsafe\n", "utf8"),
    ]))
    const before = await mappedSourceBytes(paths)
    const result = invoke(paths, "build")
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stderr, "")
    assert.deepEqual(JSON.parse(result.stdout).error, {
      code: "SOURCE_NUL_NOT_ALLOWED",
      message: `${approvedPages[0][0]} contains a NUL byte`,
    })
    assert.equal(result.stdout.includes(paths.root), false, "source-boundary errors must not disclose absolute sandbox paths")
    assert.equal(await pathExists(paths.output), false)
    await assertMappedSourceBytesUnchanged(paths, before)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("Phase 1 preflight accepts the current approved source/route/layout mappings", async () => {
  const paths = await fixture()
  try {
    const result = invoke(paths, "preflight")
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stderr, "")
    const receipt = JSON.parse(result.stdout)
    assert.deepEqual(receipt.routes, approvedPages.map(([, route]) => route))
    assert.equal(receipt.pages, approvedPages.length)
    const expectedLayouts = mappedPages.reduce((counts, page) => {
      counts[page.layout] += 1
      return counts
    }, { paper: 0, support: 0 })
    assert.deepEqual(receipt.layouts, expectedLayouts)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("Phase 1 CLI accepts --content-map but fails closed for an invalid Vault root", async () => {
  const paths = await fixture()
  const before = new Map()
  for (const [source] of approvedPages) before.set(source, await readFile(path.join(paths.vault, ...source.split("/"))))
  try {
    const result = spawnSync(process.execPath, [
      cli,
      "preflight",
      "--content-map", path.join(paths.root, "private-map.yml"),
      "--vault-root", path.join(paths.root, "missing-vault"),
      "--work-root", paths.work,
      "--output", paths.output,
    ], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 })
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stderr, "")
    assert.deepEqual(JSON.parse(result.stdout).error, {
      code: "VAULT_ROOT_INVALID",
      message: "canonical Vault root must be an ordinary directory",
    })
    for (const [source, bytes] of before) assert.deepEqual(await readFile(path.join(paths.vault, ...source.split("/"))), bytes)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("Phase 1 preflight fails closed when a mapped source has malformed frontmatter", async () => {
  const paths = await fixture()
  try {
    const source = path.join(paths.vault, ...approvedPages[0][0].split("/"))
    await writeFile(source, "---\ntitle: [unterminated\n---\n\n# Broken\n")
    const result = invoke(paths, "preflight")
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stderr, "")
    assert.equal(JSON.parse(result.stdout).error.code, "SOURCE_FRONTMATTER_INVALID")
    assert.equal(await import("node:fs/promises").then(({ stat }) => stat(paths.output).then(() => true, () => false)), false)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("build strips exact integration boundary comments while preserving approved content", async () => {
  const paths = await fixture()
  try {
    const supportPages = mappedPages.filter((page) => page.layout === "support")
    assert.ok(supportPages.length >= 2)
    await replaceMappedSource(paths, supportPages[0].source, `${noteFor(90, "support")}\n<!-- candidate-integration:start -->\n\nApproved candidate content.\n\n<!-- candidate-integration:end -->\n`)
    await replaceMappedSource(paths, supportPages[1].source, `${noteFor(91, "support")}\n<!-- source-contribution:bae7f880ec64:start -->\n\nApproved source contribution.\n\n<!-- source-contribution:bae7f880ec64:end -->\n`)

    const result = invoke(paths, "build")
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const publicText = (await outputTree(paths.output)).map(([, bytes]) => bytes.toString("utf8")).join("\n")
    assert.match(publicText, /Approved candidate content\./)
    assert.match(publicText, /Approved source contribution\./)
    assert.doesNotMatch(publicText, /candidate-integration|source-contribution/)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("build projects an unlisted wikilink without a manual alias to safe basename text", async () => {
  const paths = await fixture()
  try {
    const support = pageForLayout("support")
    await replaceMappedSource(paths, support.source, `${noteFor(92, "support")}\nA related private draft is [[Private/Workflow/Hidden Target]].\n`)

    const result = invoke(paths, "build")
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const publicText = (await outputTree(paths.output)).map(([, bytes]) => bytes.toString("utf8")).join("\n")
    assert.match(publicText, /A related private draft is Hidden Target\./)
    assert.doesNotMatch(publicText, /Private\/Workflow|\[\[Private\/Workflow\/Hidden Target\]\]/)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("build suppresses an unlisted inline-code Vault path without rewriting unrelated slash code", async () => {
  const paths = await fixture()
  try {
    const support = pageForLayout("support")
    await replaceMappedSource(paths, support.source, `${noteFor(93, "support")}\nA private inline target is \`Ideas/Private Hidden Plan\`; metric \`F1micro/Acc-Top1\`.\n`)

    const result = invoke(paths, "build")
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const publicText = (await outputTree(paths.output)).map(([, bytes]) => bytes.toString("utf8")).join("\n")
    assert.match(publicText, /A private inline target is Private Hidden Plan; metric/)
    assert.doesNotMatch(publicText, /Ideas\/Private Hidden Plan/)
    assert.match(publicText, /<code>F1micro\/Acc-Top1<\/code>/)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("build maps a published inline-code Vault path to its public site route", async () => {
  const paths = await fixture()
  try {
    const support = pageForLayout("support")
    const mappedTarget = mappedPages.find((page) => page.source === "Knowledge/Concepts/Flow.md")
    assert.ok(mappedTarget)
    assert.notEqual(support.source, mappedTarget.source)
    await replaceMappedSource(paths, support.source, `${noteFor(94, "support")}\nA mapped inline target is \`Knowledge/Concepts/Flow.md\`.\n`)

    const result = invoke(paths, "build")
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const html = await readFile(path.join(paths.output, ...support.route.slice(1).split("/"), "index.html"), "utf8")
    assert.match(html, /A mapped inline target is <a\b[^>]*href="[^"]*knowledge\/concept\/flow\/?"[^>]*>Flow<\/a>\./)
    assert.doesNotMatch(html, /Knowledge\/Concepts\/Flow(?:\.md)?/)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("build still rejects malformed integration markers and arbitrary HTML comments", async () => {
  const cases = [
    "<!-- candidate-integration:start -->\n\nApproved content without an end marker.\n",
    "<!-- source-contribution:bae7f880ec64:start -->\n\nMismatched marker.\n\n<!-- source-contribution:ffffffffffff:end -->\n",
    "<!-- arbitrary private workflow note -->\n",
  ]
  for (const [index, marker] of cases.entries()) {
    const paths = await fixture()
    try {
      const support = pageForLayout("support")
      await replaceMappedSource(paths, support.source, `${noteFor(100 + index, "support")}\n${marker}`)
      const result = invoke(paths, "build")
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
      assert.equal(result.stderr, "")
      assert.equal(JSON.parse(result.stdout).error.code, "SOURCE_ACTIVE_CONTENT_NOT_ALLOWED")
      assert.equal(await pathExists(paths.output), false)
    } finally {
      await rm(paths.root, { recursive: true, force: true })
    }
  }
})

test("Phase 5 map preflight reads injected map bytes exactly once and hashes those exact bytes", async () => {
  const paths = await fixture()
  const mapBytes = await readFile(path.join(repoRoot, "site-content.yml"))
  const mutatedMapBytes = Buffer.from(mapBytes.toString("utf8").replace("/knowledge/concept/flow/", "/knowledge/concept/mutated/")
    .replace("/papers/guo-2024-benchmarking-micro-action-recognition/", "/papers/mutated/"))
  let reads = 0
  try {
    const content = await loadSiteContent(path.join(paths.root, "missing-map.yml"), {
      vaultRoot: paths.vault,
      workRoot: paths.work,
      output: paths.output,
    }, {
      mapReader: async () => {
        reads += 1
        return reads === 1 ? Buffer.from(mapBytes) : mutatedMapBytes
      },
    })
    assert.equal(reads, 1)
    assert.equal(content.mapSha256, createHash("sha256").update(mapBytes).digest("hex"))
    assert.deepEqual(content.pages.map(({ source, route, layout }) => [source, route, layout]), approvedPages)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("Phase 5 slim-build rejects malformed content-map structure before Vault admission", async () => {
  const page = approvedPages[0]
  const sameLayoutPage = approvedPages.find((candidate) => candidate[2] === page[2] && candidate[0] !== page[0])
  assert.ok(sameLayoutPage)
  const foldedSource = page[0].replace(/[A-Za-z]/, (character) => character === character.toUpperCase() ? character.toLowerCase() : character.toUpperCase())
  const duplicateRoute = page[2] === "paper" ? "/papers/duplicate-route/" : "/knowledge/concept/duplicate-route/"
  const cases = [
    ["malformed source", `pages:\n  - source: ../escape.md\n    route: "${page[1]}"\n    layout: ${page[2]}`, "SOURCE_PATH_INVALID"],
    ["unsupported layout", `pages:\n  - source: "${page[0]}"\n    route: "${page[1]}"\n    layout: unknown`, "LAYOUT_INVALID"],
    ["unsupported version field", `version: 1\npages:\n  - source: "${page[0]}"\n    route: "${page[1]}"\n    layout: ${page[2]}`, "CONTENT_MAP_INVALID"],
    ["extra page field", `pages:\n  - source: "${page[0]}"\n    route: "${page[1]}"\n    layout: ${page[2]}\n    extra: rejected`, "CONTENT_MAP_INVALID"],
    ["missing page field", `pages:\n  - source: "${page[0]}"\n    route: "${page[1]}"`, "CONTENT_MAP_INVALID"],
    ["extra top-level field", `metadata: rejected\npages:\n  - source: "${page[0]}"\n    route: "${page[1]}"\n    layout: ${page[2]}`, "CONTENT_MAP_INVALID"],
    ["duplicate source", `pages:\n  - source: "${page[0]}"\n    route: "${page[1]}"\n    layout: ${page[2]}\n  - source: "${page[0]}"\n    route: "${duplicateRoute}"\n    layout: ${page[2]}`, "SOURCE_DUPLICATE"],
    ["source case collision", `pages:\n  - source: "${page[0]}"\n    route: "${page[1]}"\n    layout: ${page[2]}\n  - source: "${foldedSource}"\n    route: "${duplicateRoute}"\n    layout: ${page[2]}`, "SOURCE_DUPLICATE"],
    ["duplicate route", `pages:\n  - source: "${page[0]}"\n    route: "${page[1]}"\n    layout: ${page[2]}\n  - source: "${sameLayoutPage[0]}"\n    route: "${page[1]}"\n    layout: ${page[2]}`, "ROUTE_DUPLICATE"],
  ]
  const paths = await fixture()
  const map = path.join(paths.root, "malformed-map.yml")
  try {
    for (const [name, bytes, code] of cases) {
      await writeFile(map, bytes)
      const result = invokeWithMap(paths, "preflight", map)
      assert.equal(result.status, 1, `${name}: ${result.stdout}\n${result.stderr}`)
      assert.equal(result.stderr, "", name)
      assert.equal(JSON.parse(result.stdout).error.code, code, name)
      assert.equal(await pathExists(paths.output), false, name)
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("build renders every mapped route and keeps workflow metadata private", async () => {
  const paths = await fixture()
  try {
    const before = await mappedSourceBytes(paths)
    const result = invoke(paths, "build")
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stderr, "")
    const receipt = JSON.parse(result.stdout)
    /** @param {string} route */
    const routeFile = (route) => route === "/" ? "index.html" : `${route.slice(1)}index.html`
    const expectedRoutes = ["/", ...approvedPages.map(([, route]) => route)]
    assert.deepEqual([...receipt.routes].sort(), expectedRoutes.sort())
    assert.equal(receipt.pages, approvedPages.length)

    const tree = await outputTree(paths.output)
    const htmlPaths = tree.filter(([relative]) => relative.endsWith(".html")).map(([relative]) => relative)
    assert.deepEqual(htmlPaths, ["404.html", ...expectedRoutes.map(routeFile)].sort())
    const publicFiles = [
      path.join(paths.output, "index.html"),
      path.join(paths.output, "graph.json"),
      path.join(paths.output, "search-index.json"),
      path.join(paths.output, "static", "contentIndex.json"),
      ...approvedPages.map(([, route]) => path.join(paths.output, ...route.slice(1).split("/"), "index.html")),
    ]
    const publicText = (await Promise.all(publicFiles.map((file) => readFile(file, "utf8")))).join("\n")
    const notFound = await readFile(path.join(paths.output, "404.html"), "utf8")
    const home = await readFile(path.join(paths.output, "index.html"), "utf8")
    const projectBasePath = "/Tyler-Vault_PaperNote_ReadingSite/"
    const rootAbsoluteReferences = [...notFound.matchAll(/\b(?:href|src|content)=["'](\/(?!\/)[^"']*)["']/gi)].map((match) => match[1])
    assert.notEqual(notFound, home)
    assert.match(notFound, /404|not found/i)
    assert.ok(rootAbsoluteReferences.length > 0, "custom 404 should retain root-relative asset/navigation references")
    assert.ok(rootAbsoluteReferences.every((reference) => reference.startsWith(projectBasePath)), rootAbsoluteReferences.join("\n"))
    assert.match(notFound, /fetch\(["']\/Tyler-Vault_PaperNote_ReadingSite\/static\/contentIndex\.json["']\)/)
    assert.doesNotMatch(notFound, /fetch\(["']\/(?!Tyler-Vault_PaperNote_ReadingSite\/)/)
    assert.equal(home.includes(projectBasePath), false, "project base-path normalization must be scoped to custom 404")
    assert.equal(publicText.includes("PHASE1_WORKFLOW_SENTINEL"), false)
    assert.equal(publicText.includes("zotero://select/library/items/PRIVATE123"), false)
    assert.match(publicText, /data-tracer-template="paper"/)
    assert.match(publicText, /data-tracer-template="support"/)

    const graph = /** @type {{schema_version:number,nodes:Array<{public_id:string,url:string}>,edges:Array<{source:string,target:string}>}} */ (JSON.parse(await readFile(path.join(paths.output, "graph.json"), "utf8")))
    const search = /** @type {{schema_version:number,records:Array<{public_id:string,title:string,node_class:string,url:string,authors:string[],year:string|null,doi:string|null,source_tags:string[],definition:string|null,search_text:string}>}} */ (JSON.parse(await readFile(path.join(paths.output, "search-index.json"), "utf8")))
    const contentIndex = /** @type {typeof search} */ (JSON.parse(await readFile(path.join(paths.output, "static", "contentIndex.json"), "utf8")))
    assert.deepEqual(Object.keys(graph), ["schema_version", "nodes", "edges"])
    assert.equal(graph.schema_version, 1)
    assert.equal(graph.nodes.length, approvedPages.length)
    assert.deepEqual(graph.nodes.map((node) => node.public_id), [...graph.nodes.map((node) => node.public_id)].sort())
    assert.deepEqual(new Set(graph.nodes.map((node) => node.url)), new Set(approvedPages.map(([, route]) => route)))
    const publicIds = new Set(graph.nodes.map((node) => node.public_id))
    assert.ok(graph.edges.every((edge) => publicIds.has(edge.source) && publicIds.has(edge.target)))
    assert.deepEqual(Object.keys(search), ["schema_version", "records"])
    assert.equal(search.schema_version, 1)
    assert.equal(search.records.length, graph.nodes.length)
    assert.deepEqual(search.records.map((record) => record.public_id), graph.nodes.map((node) => node.public_id))
    for (const record of search.records) {
      assert.deepEqual(Object.keys(record), ["public_id", "title", "node_class", "url", "authors", "year", "doi", "source_tags", "definition", "search_text"])
      assert.equal(Object.hasOwn(record, "slug"), false)
      assert.equal(Object.hasOwn(record, "content"), false)
      if (["concept", "method", "task"].includes(record.node_class)) {
        assert.match(record.title, /^Approved Node /, `${record.url}: search result title starts with uppercase`)
        assert.match(record.definition ?? "", /^A synthetic public definition for approved Node /, `${record.url}: inspector receives the public Definition section`)
      } else if (record.node_class === "author") {
        assert.equal(record.title, "Patricia C. Jackman", `${record.url}: search result uses the canonical author name`)
      }
    }
    assert.deepEqual(contentIndex, search)

    /** @param {string} html @param {string} token @returns {number} */
    const classTokenCount = (html, token) => [...html.matchAll(/\bclass="([^"]*)"/g)].filter((match) => match[1].split(/\s+/).includes(token)).length
    const css = tree.filter(([relative]) => relative.endsWith(".css")).map(([, bytes]) => bytes.toString("utf8")).join("\n")
    const themeSource = await readFile(path.join(repoRoot, "styles", "tracer-scholarly.scss"), "utf8")
    assert.match(css, /--tyler-tracer-theme\s*:\s*warm/)
    const fontAssets = [
      "newsreader-variable.woff2",
      "newsreader-italic-variable.woff2",
      "source-sans-3-variable.woff2",
      "source-sans-3-italic-variable.woff2",
    ]
    for (const fontAsset of fontAssets) {
      const renderedFont = tree.find(([relative]) => relative === `static/fonts/${fontAsset}`)?.[1]
      assert.ok(renderedFont, `${fontAsset}: self-hosted font is present in the public output`)
      assert.deepEqual(renderedFont, await readFile(path.join(repoRoot, "assets", "fonts", fontAsset)), `${fontAsset}: public font bytes match the project asset`)
      assert.match(css, new RegExp(`static/fonts/${fontAsset.replaceAll(".", "\\.")}`), `${fontAsset}: stylesheet references the self-hosted font`)
    }
    assert.match(themeSource, /--font-editorial:\s*"Newsreader",\s*"Noto Serif TC",\s*Georgia,\s*ui-serif,\s*serif/, "editorial stack preserves the existing CJK serif fallback")
    assert.match(themeSource, /--font-interface:\s*"Source Sans 3",\s*system-ui,\s*-apple-system,\s*"Segoe UI",\s*sans-serif/, "interface stack preserves the existing system fallback")
    assert.match(themeSource, /\.page-title,[\s\S]*?font-family:\s*var\(--font-editorial\)/, "page title uses the editorial role")
    assert.match(themeSource, /\.public-graph \.public-graph-heading h2\s*\{[^}]*font-family:\s*var\(--font-editorial\)/s, "graph section heading uses the homepage editorial typography")
    assert.doesNotMatch(css, /fonts\.(?:googleapis|gstatic)\.com/i, "typography does not depend on a remote font service")
    for (const [pageIndex, [, route, layout]] of approvedPages.entries()) {
      const html = await readFile(path.join(paths.output, ...route.slice(1).split("/"), "index.html"), "utf8")
      assert.equal((html.match(/<meta http-equiv="Content-Security-Policy"/g) ?? []).length, 1, route)
      assert.ok(html.includes(`content="${tracerCsp}"`), route)
      assert.match(html, new RegExp(`<body\\b[^>]*data-tracer-template="${layout}"`))
      assert.equal(classTokenCount(html, "explorer"), 1, `${route}: Explorer surface`)
      assert.equal(classTokenCount(html, "library-backdrop"), 1, `${route}: Library backdrop`)
      assert.equal(classTokenCount(html, "library-menu-icon"), 1, `${route}: Library menu icon`)
      assert.equal(classTokenCount(html, "library-toggle"), 1, `${route}: all-viewport Library toggle`)
      assert.match(html, /<svg class="library-menu-icon"/, `${route}: animated SVG menu icon`)
      const externalAnchors = [...html.matchAll(/<a\b[^>]*href="https?:\/\/[^\"]+"[^>]*>/gi)].map((match) => match[0])
      for (const anchor of externalAnchors) {
        assert.match(anchor, /\btarget="_blank"/, `${route}: external link opens in a new tab`)
        const rel = /\brel="([^"]*)"/.exec(anchor)?.[1].split(/\s+/) ?? []
        assert.ok(rel.includes("noopener") && rel.includes("noreferrer"), `${route}: external new tab is opener-isolated`)
      }
      assert.equal(classTokenCount(html, "public-search"), 0, `${route}: Search remains homepage-only`)
      assert.equal(classTokenCount(html, "public-graph"), 1, `${route}: Graph surface`)
      assert.equal(classTokenCount(html, "back-to-top"), 1, `${route}: Back-to-top control`)
      assert.equal(classTokenCount(html, "back-to-top-row"), 1, `${route}: Back-to-top flow row`)
      assert.equal(classTokenCount(html, "page-listing"), 0, `${route}: empty Quartz folder listing removed`)
      assert.doesNotMatch(html, /0 items under this folder\./, `${route}: empty folder count removed`)
      assert.doesNotMatch(html, /<\/article>(?:<\/div>)?<hr\/><div class="page-footer">/, `${route}: Knowledge Map has no trailing Quartz rule`)
      assert.match(html, /data-back-to-top aria-label="Back to top"/, `${route}: accessible Back-to-top control`)
      assert.ok(html.indexOf('class="public-graph"') < html.indexOf('class="back-to-top-row"'), `${route}: Back to top sits below Knowledge Map`)
      assert.equal((html.match(/data-tracer-extension="t05-search"/g) ?? []).length, 1, `${route}: Search runtime`)
      assert.equal((html.match(/data-tracer-extension="t05-graph"/g) ?? []).length, 1, `${route}: Graph runtime`)
      assert.equal((html.match(/data-tracer-extension="t06-adaptive"/g) ?? []).length, 1, `${route}: adaptive table and fixed-navigation runtime`)
      assert.match(html, /responsive-card-table/, `${route}: mobile table-card enhancement`)
      assert.match(html, /min-width: 120rem/, `${route}: persistent navigation threshold`)
      assert.match(html, /class="backlinks" data-public-backlinks/)
      assert.match(html, /class="public-home-link"[^>]*>Homepage<\/a>/, `${route}: Homepage navigation`)
      assert.match(html, /aria-label="Open Library"/, `${route}: accessible Library trigger`)
      assert.equal(classTokenCount(html, "toc-backdrop"), 1, `${route}: all-viewport ToC backdrop`)
      assert.equal(classTokenCount(html, "toc-panel-title"), 1, `${route}: symmetric Table of Contents title`)
      assert.match(html, /<h2 class="toc-panel-title">Table of Contents<\/h2>/, `${route}: full ToC heading`)
      assert.match(html, /aria-label="Open Table of Contents"/, `${route}: accessible ToC trigger`)
      assert.match(html, /public-class-group-toggle/, `${route}: accordion group runtime`)
      assert.match(html, /"nodeClass":"(?:concept|method|task)"[^}]*"label":"Approved Node/, `${route}: Library concept, method, and task labels start with uppercase`)
      assert.match(html, /"nodeClass":"synthesis"[^}]*"label":"Approved Node/, `${route}: Library synthesis labels start with uppercase`)
      assert.match(html, /"nodeClass":"map"[^}]*"label":"Approved Node/, `${route}: Library map labels start with uppercase`)
      assert.match(html, /library-menu-line-top/, `${route}: morphing Library menu line`)
      assert.doesNotMatch(html, /mobile-explorer/, `${route}: Library drawer is not mobile-only`)
      assert.doesNotMatch(html, /if\(!narrow\(\)\)return;event\.preventDefault/, `${route}: wide Library toggle is interactive`)
      assert.match(html, /max-width: 980px/, `${route}: Editorial-compatible responsive seam`)
      assert.doesNotMatch(html, /<h2 class="page-title">/, `${route}: duplicate homepage link removed`)
      const breadcrumb = /<nav class="breadcrumb-container"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? ""
      assert.ok(breadcrumb, `${route}: plain breadcrumb is present`)
      assert.doesNotMatch(breadcrumb, /<a\b/, `${route}: breadcrumb is orientation text, not navigation`)
      if (/^\/knowledge\/(?:concept|method|task)\//.test(route)) {
        const hierarchyLabel = route.includes("/concept/") ? "Concept" : route.includes("/method/") ? "Method" : "Task"
        assert.match(breadcrumb, new RegExp(`<li>Home</li><li>Knowledge</li><li>${hierarchyLabel}</li><li aria-current="page">Approved Node ${pageIndex}</li>`), `${route}: breadcrumb hierarchy and current title start with uppercase`)
      }
      const siteRoot = route.startsWith("/papers/") ? "../../" : "../../../"
      assert.ok(html.includes(`const publicSiteRoot=${JSON.stringify(siteRoot)}`), route)
      assert.doesNotMatch(html, /<(?:link|script|img|iframe|source|video|audio)\b[^>]*(?:href|src|srcset|poster)="https?:\/\//i, route)
      const node = graph.nodes.find((candidate) => candidate.url === route)
      assert.ok(node, route)
      assert.match(html, new RegExp(`id="public-graph-local-${node.public_id}"`), route)
      assert.match(html, new RegExp(`data-graph-root-id="${node.public_id}"`), route)
      assert.match(html, /data-graph-filter="paper"/, `${route}: Graph type filters`)
      assert.match(html, /data-graph-filter="paper"[^>]*aria-label="Papers"[^>]*title="Papers"/, `${route}: icon-only Graph filters keep accessible labels and tooltips`)
      assert.equal(classTokenCount(html, "public-graph-window-toggle"), 1, `${route}: Graph exposes one window-sized mode control`)
      assert.match(html, /data-graph-action="toggle-window"[^>]*aria-label="Expand graph to window"[^>]*aria-pressed="false"/, `${route}: Graph window control starts accessible and collapsed`)
      assert.match(html, /data-icon="lucide-expand"/, `${route}: Graph window control uses the outward-arrow icon`)
      assert.match(html, /data-icon="lucide-shrink"/, `${route}: Graph window control uses the inward-arrow icon`)
      assert.match(html, /public-graph-paper-nodes/, `${route}: Paper cards have a dedicated top rendering layer`)
      assert.match(html, /viewport\.append\(edgeLayer,nodeLayer,paperLayer\)/, `${route}: Paper cards render above edges and other nodes`)
      assert.doesNotMatch(html, /public-graph-toolbar|public-graph-viewport-controls/, `${route}: Graph omits redundant chrome`)
      assert.match(html, /data-graph-status role="status" aria-live="polite"/, `${route}: Graph announces filter results`)
      assert.match(html, /data-graph-empty hidden/, `${route}: Graph exposes a zero-results message`)
      assert.doesNotMatch(html, /Connections as text/, `${route}: Graph does not duplicate itself as a visible text interface`)
      assert.doesNotMatch(html, /data-graph-scope-control/, `${route}: Graph scope does not add toolbar controls`)
      if (layout === "paper") {
        assert.ok(externalAnchors.length >= 2, `${route}: article source and DOI links are external-link fixtures`)
        assert.equal(classTokenCount(html, "paper-masthead"), 1, `${route}: Paper masthead`)
        assert.match(html, new RegExp(`<header class="paper-masthead">[\\s\\S]*?<h1[^>]*>The Full Approved Publication ${pageIndex}`), `${route}: masthead uses the full paper title`)
        assert.match(breadcrumb, new RegExp(`Approved Node ${pageIndex}`), `${route}: breadcrumb uses the short paper title`)
        assert.doesNotMatch(breadcrumb, /Synthetic Author 2024/, `${route}: breadcrumb omits author/year title prefix`)
        assert.match(html, new RegExp(`Synthetic Author 2024 — Approved Node ${pageIndex}`), `${route}: Library paper label uses author, year, and short title`)
        assert.equal(classTokenCount(html, "reading-progress"), 1, `${route}: Reading progress`)
        assert.match(html, /scrollTo\(\{top:0,behavior:/, `${route}: Back-to-top interaction`)
        assert.match(html, /data-copy-citation/, `${route}: Copy citation action`)
        assert.match(html, /data-citation-toast/, `${route}: Copy citation toast`)
        assert.match(html, /data-tracer-extension="t06-reading"/, `${route}: Paper interaction runtime`)
        assert.equal(classTokenCount(html, "paper-tabs"), 1, `${route}: Paper tabs`)
        assert.equal(classTokenCount(html, "paper-tab-panel"), 5, `${route}: five paper tab panels`)
        assert.equal((html.match(/data-paper-tab=/g) ?? []).length, 5, `${route}: five paper tab controls`)
        assert.equal(classTokenCount(html, "paper-tab-pill"), 1, `${route}: gliding tab indicator`)
        assert.equal(classTokenCount(html, "paper-section-picker"), 1, `${route}: narrow-screen Section Picker`)
        assert.equal(classTokenCount(html, "section-picker-icon"), 2, `${route}: Section Picker uses two SVG chevrons`)
        assert.equal(classTokenCount(html, "section-picker-caret"), 1, `${route}: Section Picker uses an SVG selection chevron`)
        assert.equal((html.match(/<polyline points="6 9 12 15 18 9"><\/polyline>/g) ?? []).length >= 3, true, `${route}: all three Section Picker controls reuse the navigation chevron geometry`)
        assert.match(html, /<svg class="section-picker-caret"[^>]*aria-hidden="true" focusable="false">/, `${route}: selection chevron is decorative SVG`)
        assert.doesNotMatch(html, /[⌄]/, `${route}: Section Picker selection chevron is not a text glyph`)
        assert.doesNotMatch(html, /<span aria-hidden="true">[‹›]<\/span>/, `${route}: Section Picker does not use text glyph arrows`)
        assert.equal((html.match(/data-section-option=/g) ?? []).length, 5, `${route}: Section Picker exposes five options`)
        assert.match(html, /data-section-step="previous"[^>]*aria-disabled="true"[^>]*disabled/, `${route}: first section keeps a visibly disabled previous control`)
        assert.match(html, /data-section-step="next"/, `${route}: first section exposes a next control`)
        assert.match(html, /setStepDisabled\(previousButton,activeIndex<=0\);setStepDisabled\(nextButton,activeIndex>=tabs\.length-1\)/, `${route}: endpoint chevrons remain visible but disabled`)
        assert.match(html, /role="listbox" aria-label="Choose paper section"/, `${route}: Section Picker list is accessible`)
        assert.match(html, /pointerdown[\s\S]*Math\.abs\(distance\)<44/, `${route}: Section Picker supports horizontal swipe navigation`)
        assert.match(html, /data-sticky-hidden/, `${route}: section navigation responds to scroll direction`)
        assert.match(html, /data-paper-tab="introductions"[^>]*aria-selected="true"/, `${route}: Introductions is the default tab`)
        assert.match(html, /data-paper-tab="methods"/, `${route}: Methods tab`)
        assert.match(html, /data-paper-tab="results"/, `${route}: Results tab`)
        assert.match(html, /data-paper-tab="discussion"/, `${route}: Discussion tab`)
        assert.match(html, /data-paper-tab="others"/, `${route}: Others tab`)
        assert.match(html, /data-paper-panel="methods"[\s\S]*?<h2 id="method"[\s\S]*?<h3 id="design-or-approach"/, `${route}: Method content is grouped in Methods`)
        assert.match(html, /data-paper-panel="results"[\s\S]*?<h2 id="main-results"[\s\S]*?<h3 id="result-index"/, `${route}: result content is grouped in Results`)
        assert.match(html, /data-paper-panel="discussion"[\s\S]*?<h2 id="authors-discussion"[\s\S]*?<h2 id="missing-or-unclear-information"[\s\S]*?<h2 id="critical-appraisal"/, `${route}: discussion and appraisal content stay together`)
        assert.match(html, /data-paper-panel="others"[\s\S]*?<h2 id="relevance-to-my-research"[\s\S]*?<h2 id="connections"/, `${route}: relevance and later content are grouped in Others`)
      } else {
        assert.equal(classTokenCount(html, "paper-tabs"), 0, `${route}: support pages do not expose paper tabs`)
      }
    }
    assert.equal(classTokenCount(home, "explorer"), 1)
    assert.equal(classTokenCount(home, "library-backdrop"), 1)
    assert.equal(classTokenCount(home, "public-search"), 1)
    assert.equal(classTokenCount(home, "public-graph"), 1)
    assert.equal(classTokenCount(home, "back-to-top"), 1)
    assert.doesNotMatch(home, /<\/article>(?:<\/div>)?<hr\/><div class="page-footer">/, "Homepage Knowledge Map has no trailing Quartz rule")
    assert.ok(home.indexOf('class="public-graph"') < home.indexOf('class="back-to-top-row"'))
    assert.match(home, /id="public-graph-global" data-graph-scope="global"/)
    assert.doesNotMatch(home, /data-graph-scope-control="local"/, "Homepage omits the meaningless Local graph control")
    assert.match(home, /data-graph-status role="status" aria-live="polite"/, "Homepage graph announces filter results")
    assert.doesNotMatch(home, /Connections as text/, "Homepage graph does not duplicate itself as a visible text interface")
    assert.equal(classTokenCount(home, "home-hero"), 1)
    assert.match(home, /<h1[^>]*>Psychology Research Notes[\s\S]*?<\/h1>/, "homepage uses the new research-notes title")
    assert.match(home, /Literature-centered notes on psychology, connected through authors, concepts, methods, and research tasks\.\s+<span lang="zh-Hant">以心理學文獻為核心的研究筆記，透過作者、構念、研究方法與實驗作業彼此串聯。<\/span>/, "homepage uses the bilingual research-notes description without a forced line break")
    assert.doesNotMatch(home, /research tasks\.<br\/?>(?:\s*)<span lang="zh-Hant">/, "homepage description has no forced language break")
    assert.doesNotMatch(home, /Tyler-Vault Reading Site|A paper-led reading layer connected through concepts, methods, tasks, and authors\./, "homepage omits the retired title and description")
    assert.equal(classTokenCount(home, "node-type-card"), 6)
    assert.equal(classTokenCount(home, "node-type-card-icon-svg"), 6)
    for (const icon of ["lucide-network", "lucide-flask-conical", "lucide-list-checks", "lucide-users-round", "lucide-layers-3", "lucide-map"]) {
      assert.match(home, new RegExp(`data-icon="${icon}"`), `homepage includes the ${icon} legend icon`)
    }
    assert.equal((home.match(/<svg class="node-type-card-icon-svg"[^>]*aria-hidden="true" focusable="false">/g) ?? []).length, 6, "homepage legend icons are decorative SVGs")
    assert.doesNotMatch(home, /class="node-type-card-icon"[^>]*>\s*[CMTA]\s*<\/span>/, "homepage legend does not use initial letters")
    const totalPaperCount = approvedPages.filter(([, , layout]) => layout === "paper").length
    const expectedFeaturedPaperCount = Math.min(6, totalPaperCount)
    assert.equal(classTokenCount(home, "paper-card"), expectedFeaturedPaperCount)
    assert.equal(classTokenCount(home, "paper-card-title"), expectedFeaturedPaperCount)
    assert.equal((home.match(/<a\b[^>]*class="[^"]*\bpaper-card\b[^"]*"/g) ?? []).length, expectedFeaturedPaperCount)
    assert.equal(classTokenCount(home, "reading-path-card"), 0)
    assert.match(home, new RegExp(`data-home-total="${approvedPages.length}"`))
    assert.equal((home.match(/data-home-library-target=/g) ?? []).length, 6 + Number(totalPaperCount > 6))
    assert.equal(classTokenCount(home, "featured-papers-more"), Number(totalPaperCount > 6))
    assert.match(home, /data-home-library-target="synthesis"/, "homepage Browse section opens the Syntheses Library group")
    assert.match(home, /data-home-library-target="map"/, "homepage Browse section opens the Maps Library group")
    assert.match(home, /<p class="home-eyebrow">Research lenses<\/p><h2 id="browse-heading">Explore through knowledge nodes/, "homepage introduces the research lenses")
    assert.match(home, /<p class="home-eyebrow">Featured papers<\/p><h2 id="featured-heading">Browse reviewed papers/, "homepage introduces the reviewed papers")
    assert.match(home, /<p class="public-graph-kicker">Knowledge map<\/p>\s*<h2 data-graph-title>Trace connections in the global graph/, "homepage introduces the global knowledge map")
    assert.doesNotMatch(home, /data-home-filter=/)
    assert.doesNotMatch(home, /Read the note/)
    assert.doesNotMatch(home, /Where to start/)
    assert.match(home, /Patricia C\. Jackman/)
    assert.match(home, /data-tracer-extension="t06-home"/)
    assert.match(home, /class="paper-card-title">Approved Node /, "homepage cards use short paper titles")
    assert.ok(home.indexOf('class="home-hero"') < home.indexOf('class="public-search"'))
    assert.ok(home.indexOf('class="public-search"') < home.indexOf('class="node-type-grid"'))
    assert.ok(home.indexOf('class="featured-paper-grid"') < home.indexOf('class="public-graph"'))
    assert.equal((home.match(/data-public-backlinks/g) ?? []).length, 0)
    assert.equal((home.match(/data-tracer-extension="t05-search"/g) ?? []).length, 1)
    assert.equal((home.match(/data-tracer-extension="t05-graph"/g) ?? []).length, 1)
    assert.match(css, /\.page:has\(\.home-hero\)\s*>\s*#quartz-body/)
    assert.match(themeSource, /\.page:has\(\.home-hero\)[\s\S]*?\.public-graph-heading\s*\{[^}]*border-top:\s*2px solid var\(--dark\)/s, "homepage Knowledge Map repeats the Featured papers divider")
    assert.match(css, /\.library-backdrop/)
    assert.match(css, /\.toc-backdrop/)
    assert.match(css, /\.public-class-group-toggle/)
    assert.match(css, /clip-path\s*:\s*circle/)
    assert.match(css, /--library-item-index/)
    assert.match(css, /scrollbar-width\s*:\s*none/)
    assert.match(css, /max-width\s*:\s*1367px/)
    assert.match(css, /::-webkit-scrollbar/)
    assert.match(css, /html\.library-no-scroll/)
    assert.match(themeSource, /html\.library-no-scroll:has\(\.sidebar\.left\.library-open\):not\(:has\(\.sidebar\.right\.toc-open\)\)\s*\{[^}]*overflow:\s*auto/s, "an open Library leaves the center page scrollable")
    assert.match(css, /scrollbar-gutter\s*:\s*auto/)
    assert.match(css, /\.public-graph-target/)
    assert.match(themeSource, /\.public-graph\[data-layout-ready\]\[data-layout-ready\] \.public-graph-filters :is\(\.public-graph-swatch, \[data-graph-filter-label\], \[data-graph-filter-count\]\)\s*\{[^}]*display:\s*none/s, "all graph layouts use icon-only type filters")
    assert.match(themeSource, /\.public-graph\[data-layout-ready\]\[data-layout-ready\]\[data-graph-window="expanded"\]\s*\{[^}]*position:\s*fixed[^}]*height:\s*100dvh/s, "expanded graph fills the current browser window without the Fullscreen API")
    assert.match(themeSource, /\[data-graph-window="expanded"\][\s\S]*?\.public-graph-canvas\s*\{[^}]*touch-action:\s*none/s, "window-sized graph owns touch gestures without changing the rest of the site")
    assert.doesNotMatch(css, /\.public-graph-band-surface/)
    assert.doesNotMatch(css, /\.public-graph-list-group/)
    assert.match(css, /\.paper-tab-pill/)
    const homeTitleRule = /\.home-hero h1\s*\{[^}]*\}/.exec(themeSource)?.[0] ?? ""
    assert.match(homeTitleRule, /max-width:\s*none/, "homepage title uses the available width before wrapping")
    assert.doesNotMatch(homeTitleRule, /white-space:\s*nowrap/, "homepage title wraps naturally only when its available width is exhausted")
    const homeIntroRule = /\.home-intro\s*\{[^}]*\}/.exec(themeSource)?.[0] ?? ""
    assert.match(homeIntroRule, /max-width:\s*none/, "homepage description uses the available width before wrapping")
    assert.doesNotMatch(homeIntroRule, /white-space:\s*nowrap/, "homepage description wraps naturally only when its available width is exhausted")
    assert.match(themeSource, /@media \(max-width: 700px\)\s*\{\s*\.home-hero h1\s*\{\s*line-height: 1\.1;/, "wrapped mobile title keeps comfortable line spacing")
    assert.match(css, /cubic-bezier\((?:0)?\.65,\s*0,\s*(?:0)?\.35,\s*1\)/)
    assert.match(css, /max-width\s*:\s*55\.999rem/, "Section Picker replaces tabs below the measured navigation threshold")
    assert.match(css, /\.paper-section-navigation\s*\{[^}]*position\s*:\s*sticky/s, "paper section navigation is sticky")
    assert.match(css, /\.paper-section-picker/, "narrow layouts use the Section Picker")
    assert.match(themeSource, /\.node-type-card-icon::before\s*\{[^}]*transform\s*:\s*rotate\(45deg\)/s, "homepage legend icons use the diamond frame")
    assert.match(css, /grid-template-columns\s*:\s*44px minmax\(150px,\s*180px\) 44px/, "Section Picker is a compact three-part button group")
    assert.match(themeSource, /\.paper-section-picker\s*\{[\s\S]*?height\s*:\s*44px[\s\S]*?min-height\s*:\s*44px/, "Section Picker matches the 44px navigation controls")
    assert.match(themeSource, /\.section-picker-caret\s*\{[^}]*width\s*:\s*16px[^}]*height\s*:\s*16px/s, "Section Picker selection chevron has explicit SVG dimensions")
    assert.match(css, /\.section-picker-step:disabled\s*\{[^}]*opacity\s*:\s*(?:0)?\.25/s, "endpoint chevrons remain visible at quarter opacity")
    assert.doesNotMatch(css, /\.section-picker-toggle\s*\{[^}]*border-inline/s, "Section Picker has no internal divider lines")
    assert.match(css, /table\.responsive-card-table/, "simple mobile tables use readable row cards")
    assert.match(css, /\.responsive-cell-label/, "mobile table cards repeat column labels")
    assert.match(css, /\.back-to-top-row/, "Back-to-top control is a flow-content row")
    assert.match(themeSource, /\.back-to-top-row\s*\{[^}]*justify-content\s*:\s*center[^}]*background\s*:\s*transparent/s, "Back-to-top is centered without a dark band")
    assert.match(themeSource, /\.back-to-top\s*\{[^}]*color\s*:\s*var\(--gray\)/s, "Back-to-top uses the Library child-link color")
    assert.doesNotMatch(css, /\.back-to-top\s*\{[^}]*position\s*:\s*fixed/s, "Back-to-top is not a floating box")
    assert.match(css, /\.wide-fixed-navigation/, "ultra-wide layout exposes a persistent navigation state")
    assert.match(themeSource, /grid-template-columns\s*:\s*21rem minmax\(0,\s*1fr\) 22rem/, "ultra-wide sidebars remain flush with viewport edges")
    assert.match(themeSource, /width\s*:\s*min\(100%,\s*72rem\)/, "ultra-wide layout caps the reading content at 1152px")
    assert.match(themeSource, /\.wide-fixed-navigation \.page > #quartz-body \.page-header\s*\{[^}]*padding-top\s*:\s*var\(--control-rail-height\)/s, "ultra-wide content keeps the same top rail spacing as tablet layouts")
    assert.match(css, /\.toc-panel-title/, "Table of Contents has a Library-symmetrical heading")
    assert.match(themeSource, /\.explorer > \.desktop-explorer\s*\{[^}]*font-size\s*:\s*1\.125rem/s, "Library title is 18px")
    assert.match(themeSource, /\.toc-panel-title\s*\{[^}]*font-size\s*:\s*1\.125rem/s, "Table of Contents title is 18px")
    assert.match(themeSource, /\.explorer \.public-class-group-toggle,[\s\S]*?\.toc \.toc-content a\s*\{[^}]*font-size\s*:\s*1rem/s, "Library and ToC primary items are 16px")
    assert.match(themeSource, /\.explorer \.public-class-group-entries a\s*\{[^}]*font-size\s*:\s*0\.875rem/s, "Library child items are 14px")
    assert.match(css, /\.paper-tab-toc-title\s*\{[^}]*border-bottom\s*:\s*0/s, "active section uses indentation without a divider")
    assert.doesNotMatch(css, /transition-duration\s*:\s*0s\s*!important/, "Library interaction motion must not be globally disabled")
    for (const [, bytes] of tree) {
      const text = bytes.toString("utf8")
      assert.doesNotMatch(text, /Private(?:[\\\\/]|%2F)Hidden-Neuron|PRIVATE-ZOTERO-CANARY|PHASE1_WORKFLOW_SENTINEL/i)
    }
    await assertMappedSourceBytesUnchanged(paths, before)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("Phase 1 paper and support select real structural project-owned templates", async () => {
  const { selectProjectPageTemplate } = await import("../lib/project-page-template.mjs")
  const navigation = {
    backlinksMarkup: '<div class="backlinks" data-public-backlinks><h2 id="backlinks">Backlinks</h2></div>',
    backToTopMarkup: '<div class="back-to-top-row"><button class="back-to-top">Back to top</button></div>',
    graphMarkup: '<section class="public-graph" data-template-structure="graph"></section>',
    runtimeScripts: '<script data-project-template-runtime></script>',
  }
  const source = '<body><article><h2 id="backlinks">Backlinks</h2><ul><li>vendor</li></ul></article></body>'
  for (const layout of ["paper", "support"]) {
    const template = selectProjectPageTemplate(layout)
    assert.equal(template.name, layout)
    assert.equal(typeof template.render, "function")
    const rendered = template.render(source, navigation)
    assert.match(rendered, new RegExp(`<body\\b[^>]*data-tracer-template="${layout}"`))
    assert.match(rendered, /<div class="backlinks" data-public-backlinks>/)
    assert.match(rendered, /<section class="public-graph" data-template-structure="graph">/)
    assert.match(rendered, /data-project-template-runtime/)
  }
})

test("Phase 1 full build applies the selected structural template to every matching mapped route", async () => {
  const paths = await fixture()
  try {
    const { selectProjectPageTemplate } = await import("../lib/project-page-template.mjs")
    const result = invoke(paths, "build")
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    for (const [, route, layout] of approvedPages) {
      const html = await readFile(path.join(paths.output, ...route.slice(1).split("/"), "index.html"), "utf8")
      const template = selectProjectPageTemplate(layout)
      assert.equal(template.name, layout)
      assert.equal((html.match(new RegExp(`data-tracer-template="${layout}"`, "g")) ?? []).length, 1, route)
      assert.match(html, /<section class="public-graph"/)
      assert.match(html, /data-tracer-extension="t05-search"/)
      assert.match(html, /data-tracer-extension="t05-graph"/)
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("Phase 5 Slice 1 keeps the parser and privacy error on slim-owned seams", async () => {
  const [mapSource, tracerSource, projectionSource] = await Promise.all([
    readFile(path.join(repoRoot, "lib", "slim-content-map.mjs"), "utf8"),
    readFile(path.join(repoRoot, "scripts", "tracer.mjs"), "utf8"),
    readFile(path.join(repoRoot, "lib", "zotero-public-projection.mjs"), "utf8"),
  ])
  assert.doesNotMatch(mapSource, /from ["']\.\.\/scripts\/tracer\.mjs["']/)
  assert.doesNotMatch(projectionSource, /from ["']\.\/publication-contracts\.mjs["']/)
  assert.doesNotMatch(tracerSource, /\bContractError\b/)
  assert.doesNotMatch(tracerSource, /function parseFrontmatter\s*\(/)
  assert.match(tracerSource, /from ["']\.\.\/lib\/slim-content-map\.mjs["']/)

  const [map, tracer, projection] = await Promise.all([
    import("../lib/slim-content-map.mjs"),
    import("../scripts/tracer.mjs"),
    import("../lib/zotero-public-projection.mjs"),
  ])
  assert.equal(tracer.parseFrontmatter, map.parseFrontmatter)
  const parsed = map.parseFrontmatter("---\ntitle: Seam\n---\n\n# Body\n")
  assert.equal(parsed.data.title, "Seam")
  assert.equal(parsed.body, "\n# Body\n")
  assert.throws(
    () => projection.validateZoteroFrontmatter({ zotero_uri: "zotero://select/library/items/PRIVATE123" }, "support"),
    (error) => error instanceof map.SlimContentError
      && error.name === "SlimContentError"
      && error.code === "SOURCE_UNSAFE_URL_SCHEME",
  )
})

test("Windows renderer scratch stays below the native Sharp path limit", { skip: process.platform !== "win32" }, async () => {
  const paths = await fixture()
  try {
    await rm(paths.work, { recursive: true, force: true })
    const legacySuffix = path.join(`tracer-${process.pid}-${"0".repeat(16)}-XXXXXX`, "toolchain", "quartz", "static", "icon.png")
    const targetWorkLength = 262 - 1 - legacySuffix.length
    const workPrefix = path.join(paths.root, "long-")
    assert.ok(workPrefix.length < targetWorkLength)
    paths.work = `${workPrefix}${"w".repeat(targetWorkLength - workPrefix.length)}`
    await mkdir(paths.work)

    assert.equal(path.join(paths.work, legacySuffix).length, 262)
    assert.ok(path.join(paths.work, "q-XXXXXX", "toolchain", "quartz", "static", "icon.png").length < 260)

    const result = invoke(paths, "build")
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("Phase 5 Slice 5A keeps tracer as an import-only slim renderer/privacy seam", async () => {
  const tracerSource = await readFile(path.join(repoRoot, "scripts", "tracer.mjs"), "utf8")
  for (const moduleName of ["publication-contracts", "release-promotion", "safe-release", "zotero-delta"]) {
    assert.doesNotMatch(tracerSource, new RegExp(`(?:from|import\\s*\\().*${moduleName}\\.mjs`), moduleName)
  }
  assert.doesNotMatch(tracerSource, /\breleaseMode\b|TYLER_RELEASE_TEST|preSealReleaseCases|postSealReleaseCases|injectReleaseRegression|injectPostSealReleaseRegression/)
  assert.doesNotMatch(tracerSource, /runCandidatePipeline|constructReleaseReceipt|promoteRelease|command === ["']release["']/)

  const tracer = await import("../scripts/tracer.mjs")
  const tracerExports = /** @type {Record<string, unknown>} */ (tracer)
  for (const name of [
    "analyzeMarkdown", "decodeMarkdown", "projectContent", "publicContracts",
    "readDeploymentSiteFiles", "readSecretRules", "readToolchainMetadata",
    "validateMarkdownSafety", "validateSemanticTemplates",
  ]) assert.equal(typeof tracerExports[name], "function", name)
  assert.equal(Object.hasOwn(tracer, "parseArgs"), false)
  assert.equal(Object.hasOwn(tracer, "main"), false)

  const paths = await fixture()
  try {
    const result = invoke(paths, "build")
    assert.equal(result.status, 0, `${result.stdout}\\n${result.stderr}`)
    assert.deepEqual(JSON.parse(result.stdout).routes.sort(), [
      "/", ...approvedPages.map(([, route]) => route),
    ].sort())
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})
