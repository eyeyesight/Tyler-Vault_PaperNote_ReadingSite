import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { parse as parseYaml } from "yaml"

import { approvedSitePageCount } from "../lib/slim-content-map.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const cli = path.join(repoRoot, "scripts", "slim-build.mjs")

/** @typedef {[source:string,route:string,layout:"paper"|"support"]} ApprovedPage */
/** @typedef {{source:string,route:string,layout:"paper"|"support"}} MappedPage */

/** @type {MappedPage[]} */
const mappedPages = parseYaml(await readFile(path.join(repoRoot, "site-content.yml"), "utf8")).pages
/** @type {ApprovedPage[]} */
const approvedPages = mappedPages.map((page) => [page.source, page.route, page.layout])
assert.equal(approvedPages.length, approvedSitePageCount)

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

test("Phase 1 CLI rejects retired --content-map with USAGE before reading source roots", async () => {
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
      code: "USAGE",
      message: "unknown flag --content-map",
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
