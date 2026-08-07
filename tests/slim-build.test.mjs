import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

const repoRoot = path.resolve(import.meta.dirname, "..")
const cli = path.join(repoRoot, "scripts", "slim-build.mjs")

/** @typedef {[source:string,route:string,layout:"paper"|"support"]} ApprovedPage */

/** @type {ApprovedPage[]} */
const approvedPages = [
  ["Literature/Notes/Guo et al. 2024 — Benchmarking Micro-action Recognition.md", "/papers/guo-2024-benchmarking-micro-action-recognition/", "paper"],
  ["Literature/Notes/Jackman et al. 2021 — Flow and Clutch States in Recreational Running.md", "/papers/jackman-2021-flow-clutch-recreational-running/", "paper"],
  ["Knowledge/Authors/Patricia C. Jackman.md", "/knowledge/author/patricia-c-jackman/", "support"],
  ["Knowledge/Concepts/Flow.md", "/knowledge/concept/flow/", "support"],
  ["Knowledge/Concepts/Micro-action.md", "/knowledge/concept/micro-action/", "support"],
  ["Knowledge/Methods/Connecting Analysis.md", "/knowledge/method/connecting-analysis/", "support"],
  ["Knowledge/Methods/Event-Focused Interview.md", "/knowledge/method/event-focused-interview/", "support"],
  ["Knowledge/Methods/Thematic Analysis.md", "/knowledge/method/thematic-analysis/", "support"],
  ["Knowledge/Tasks/Action Recognition.md", "/knowledge/task/action-recognition/", "support"],
]

/** @param {number} index @param {"paper"|"support"} layout */
function noteFor(index, layout) {
  const title = `Approved Node ${index}`
  if (layout === "paper") return `---
title: ${title}
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

# ${title}

## One-sentence Takeaway

A synthetic approved paper.

## Citation

Synthetic citation.

## Research Question

What does the bounded Phase 1 build preserve?

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
`
}

/** @returns {Promise<{root:string,vault:string,work:string,output:string}>} */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-slim-red-"))
  const vault = path.join(root, "vault")
  const work = path.join(root, "work")
  const output = path.join(root, "output")
  await Promise.all([mkdir(vault), mkdir(work)])
  for (const [index, [source, , layout]] of approvedPages.entries()) {
    const absolute = path.join(vault, ...source.split("/"))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, noteFor(index, layout))
  }
  return { root, vault, work, output }
}

/** @param {{vault:string,work:string,output:string}} paths @param {"preflight"|"build"} command */
function invoke(paths, command) {
  return spawnSync(process.execPath, [cli, command, "--vault-root", paths.vault, "--work-root", paths.work, "--output", paths.output], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
  })
}

test("Phase 1 preflight accepts the exact nine approved source/route/layout mappings", async () => {
  const paths = await fixture()
  try {
    const result = invoke(paths, "preflight")
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stderr, "")
    const receipt = JSON.parse(result.stdout)
    assert.deepEqual(receipt.routes, approvedPages.map(([, route]) => route))
    assert.equal(receipt.pages, 9)
    assert.deepEqual(receipt.layouts, { paper: 2, support: 7 })
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

test("Phase 1 build renders all nine mapped routes and keeps workflow metadata private", async () => {
  const paths = await fixture()
  try {
    const before = new Map()
    for (const [source] of approvedPages) before.set(source, await readFile(path.join(paths.vault, ...source.split("/"))))
    const result = invoke(paths, "build")
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stderr, "")
    const receipt = JSON.parse(result.stdout)
    assert.deepEqual([...receipt.routes].sort(), ["/", ...approvedPages.map(([, route]) => route)].sort())
    assert.equal(receipt.pages, 9)

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
    assert.notEqual(notFound, home)
    assert.match(notFound, /404|not found/i)
    assert.equal(publicText.includes("PHASE1_WORKFLOW_SENTINEL"), false)
    assert.equal(publicText.includes("zotero://select/library/items/PRIVATE123"), false)
    assert.match(publicText, /data-tracer-template="paper"/)
    assert.match(publicText, /data-tracer-template="support"/)
    const graph = /** @type {{nodes:Array<{url:string}>}} */ (JSON.parse(await readFile(path.join(paths.output, "graph.json"), "utf8")))
    const search = /** @type {{records:Array<{url:string}>}} */ (JSON.parse(await readFile(path.join(paths.output, "search-index.json"), "utf8")))
    assert.equal(graph.nodes.length, 9)
    assert.equal(search.records.length, 9)
    assert.deepEqual(new Set(graph.nodes.map((node) => node.url)), new Set(approvedPages.map(([, route]) => route)))
    assert.deepEqual(new Set(search.records.map((record) => record.url)), new Set(approvedPages.map(([, route]) => route)))
    for (const [source, bytes] of before) assert.deepEqual(await readFile(path.join(paths.vault, ...source.split("/"))), bytes)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("Phase 1 paper and support select real structural project-owned templates", async () => {
  const { selectProjectPageTemplate } = await import("../scripts/slim-build.mjs")
  const navigation = {
    backlinksMarkup: '<div class="backlinks" data-public-backlinks><h2 id="backlinks">Backlinks</h2></div>',
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
    const { selectProjectPageTemplate } = await import("../scripts/slim-build.mjs")
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
