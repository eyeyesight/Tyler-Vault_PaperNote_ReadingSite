import assert from "node:assert/strict"
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
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
/** @typedef {{root:string,vault:string,work:string,output:string}} FixturePaths */

/** @type {MappedPage[]} */
const mappedPages = parseYaml(await readFile(path.join(repoRoot, "site-content.yml"), "utf8")).pages
/** @type {ApprovedPage[]} */
const approvedPages = mappedPages.map((page) => [page.source, page.route, page.layout])
assert.equal(approvedPages.length, approvedSitePageCount)

const tracerCsp = "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self' data:; frame-src 'none'; img-src 'self' data:; media-src 'self'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; form-action 'none'"

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

/** @param {{vault:string,work:string,output:string}} paths @param {"preflight"|"build"} command @param {NodeJS.ProcessEnv} [env] */
function invoke(paths, command, env = {}) {
  return spawnSync(process.execPath, [cli, command, "--vault-root", paths.vault, "--work-root", paths.work, "--output", paths.output], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...env },
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
    const before = await mappedSourceBytes(paths)
    const result = invoke(paths, "build")
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stderr, "")
    const receipt = JSON.parse(result.stdout)
    /** @param {string} route */
    const routeFile = (route) => route === "/" ? "index.html" : `${route.slice(1)}index.html`
    const expectedRoutes = ["/", ...approvedPages.map(([, route]) => route)]
    assert.deepEqual([...receipt.routes].sort(), expectedRoutes.sort())
    assert.equal(receipt.pages, 9)

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
    const search = /** @type {{schema_version:number,records:Array<{public_id:string,title:string,node_class:string,url:string,authors:string[],doi:string|null,source_tags:string[],search_text:string}>}} */ (JSON.parse(await readFile(path.join(paths.output, "search-index.json"), "utf8")))
    const contentIndex = /** @type {typeof search} */ (JSON.parse(await readFile(path.join(paths.output, "static", "contentIndex.json"), "utf8")))
    assert.deepEqual(Object.keys(graph), ["schema_version", "nodes", "edges"])
    assert.equal(graph.schema_version, 1)
    assert.equal(graph.nodes.length, 9)
    assert.deepEqual(graph.nodes.map((node) => node.public_id), [...graph.nodes.map((node) => node.public_id)].sort())
    assert.deepEqual(new Set(graph.nodes.map((node) => node.url)), new Set(approvedPages.map(([, route]) => route)))
    const publicIds = new Set(graph.nodes.map((node) => node.public_id))
    assert.ok(graph.edges.every((edge) => publicIds.has(edge.source) && publicIds.has(edge.target)))
    assert.deepEqual(Object.keys(search), ["schema_version", "records"])
    assert.equal(search.schema_version, 1)
    assert.equal(search.records.length, graph.nodes.length)
    assert.deepEqual(search.records.map((record) => record.public_id), graph.nodes.map((node) => node.public_id))
    for (const record of search.records) {
      assert.deepEqual(Object.keys(record), ["public_id", "title", "node_class", "url", "authors", "doi", "source_tags", "search_text"])
      assert.equal(Object.hasOwn(record, "slug"), false)
      assert.equal(Object.hasOwn(record, "content"), false)
    }
    assert.deepEqual(contentIndex, search)

    /** @param {string} html @param {string} token @returns {number} */
    const classTokenCount = (html, token) => [...html.matchAll(/\bclass="([^"]*)"/g)].filter((match) => match[1].split(/\s+/).includes(token)).length
    const css = tree.filter(([relative]) => relative.endsWith(".css")).map(([, bytes]) => bytes.toString("utf8")).join("\n")
    assert.match(css, /--tyler-tracer-theme\s*:\s*warm/)
    for (const [, route, layout] of approvedPages) {
      const html = await readFile(path.join(paths.output, ...route.slice(1).split("/"), "index.html"), "utf8")
      assert.equal((html.match(/<meta http-equiv="Content-Security-Policy"/g) ?? []).length, 1, route)
      assert.ok(html.includes(`content="${tracerCsp}"`), route)
      assert.match(html, new RegExp(`<body\\b[^>]*data-tracer-template="${layout}"`))
      assert.equal(classTokenCount(html, "explorer"), 1, `${route}: Explorer surface`)
      assert.equal(classTokenCount(html, "public-search"), 1, `${route}: Search surface`)
      assert.equal(classTokenCount(html, "public-graph"), 1, `${route}: Graph surface`)
      assert.equal((html.match(/data-tracer-extension="t05-search"/g) ?? []).length, 1, `${route}: Search runtime`)
      assert.equal((html.match(/data-tracer-extension="t05-graph"/g) ?? []).length, 1, `${route}: Graph runtime`)
      assert.match(html, /class="backlinks" data-public-backlinks/)
      const siteRoot = route.startsWith("/papers/") ? "../../" : "../../../"
      assert.ok(html.includes(`const publicSiteRoot=${JSON.stringify(siteRoot)}`), route)
      assert.doesNotMatch(html, /<(?:link|script|img|iframe|source|video|audio)\b[^>]*(?:href|src|srcset|poster)="https?:\/\//i, route)
      const node = graph.nodes.find((candidate) => candidate.url === route)
      assert.ok(node, route)
      assert.match(html, new RegExp(`id="public-graph-local-${node.public_id}"`), route)
      assert.match(html, new RegExp(`data-graph-root-id="${node.public_id}"`), route)
    }
    assert.equal(classTokenCount(home, "explorer"), 1)
    assert.equal(classTokenCount(home, "public-search"), 1)
    assert.equal(classTokenCount(home, "public-graph"), 1)
    assert.match(home, /id="public-graph-global" data-graph-scope="global"/)
    assert.equal((home.match(/data-public-backlinks/g) ?? []).length, 0)
    assert.equal((home.match(/data-tracer-extension="t05-search"/g) ?? []).length, 1)
    assert.equal((home.match(/data-tracer-extension="t05-graph"/g) ?? []).length, 1)
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
