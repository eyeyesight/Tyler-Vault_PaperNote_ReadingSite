// @ts-nocheck -- public CLI fixture builds a complete synthetic publication set.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import test from "node:test"

import Ajv2020 from "ajv/dist/2020.js"
import { computePlanDigest, computePublicSetDigest, jcsCanonicalize, sha256Jcs } from "../lib/publication-contracts.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const cli = path.join(repoRoot, "scripts", "tracer.mjs")
const now = "2026-07-28T12:00:00Z"
const disclaimer = "SYNTHETIC FIXTURE — NOT RESEARCH EVIDENCE."
const jackmanDoi = "10.1016/j.psychsport.2021.102051"
const flowIds = ["concept-flow", "jackman-flow", "synthesis-flow"]
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const utf8Sort = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))
const edgeExecutable = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const edgeSpawnOptions = Object.freeze({ stdio: "ignore", windowsHide: true })

const supports = [
  ["author-jackman", "author", "Knowledge/Authors/author-jackman.md", "Patricia Jackman", "A synthetic author node."],
  ["concept-attention", "concept", "Knowledge/Concepts/concept-attention.md", "Attention", "A synthetic attention concept."],
  ["concept-flow", "concept", "Knowledge/Concepts/concept-flow.md", "Flow", "A synthetic optimal experience concept."],
  ["concept-motivation", "concept", "Knowledge/Concepts/concept-motivation.md", "Motivation", "A synthetic motivation concept."],
  ["concept-skill", "concept", "Knowledge/Concepts/concept-skill.md", "Skill", "A synthetic skill concept."],
  ["map-performance", "map", "Literature/Reviews & Maps/map-performance.md", "Performance Map", "A synthetic performance map."],
  ["method-interview", "method", "Knowledge/Methods/method-interview.md", "Interview", "A synthetic interview method."],
  ["method-scale", "method", "Knowledge/Methods/method-scale.md", "Scale", "A synthetic scale method."],
  ["synthesis-flow", "synthesis", "Literature/Syntheses/synthesis-flow.md", "Flow Synthesis", "A synthetic synthesis node."],
  ["task-running", "task", "Knowledge/Tasks/task-running.md", "Running", "A synthetic running task."],
  ["task-swimming", "task", "Knowledge/Tasks/task-swimming.md", "Swimming", "A synthetic swimming task."],
]

function sealManifest(manifest) {
  manifest.public_set_digest = computePublicSetDigest(manifest.nodes)
  manifest.plan_digest = computePlanDigest(manifest)
  manifest.approval_receipt.approved_plan_digest = manifest.plan_digest
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "t05-public-fixture-"))
  const paths = Object.fromEntries(["context", "runtime", "export", "vault", "work"].map((name) => [name, path.join(root, name)]))
  await Promise.all(Object.values(paths).map((directory) => mkdir(directory)))
  await writeFile(path.join(paths.vault, "do-not-touch.md"), "canonical sentinel\n")

  const supportLinks = supports.map(([, , sourcePath, title]) => `- [[${sourcePath.replace(/\.md$/, "")}|${title}]]`).join("\n")
  const paperPath = "Literature/Notes/jackman-flow.md"
  const paperBytes = Buffer.from(`---\ntitle: Flow and Performance\ntype: literature-note\nstatus: integrated\nauthors:\n  - Patricia C. Jackman\n  - Christian Swann\ndoi: ${jackmanDoi}\ntags:\n  - sport\n  - flow\n  - flow\n---\n\n# Flow and Performance\n\n${disclaimer}\n\n## Bibliography\n\nSynthetic bibliography only.\n\n## One-sentence Takeaway\n\nSynthetic takeaway only.\n\n## Research Question\n\nHow does the synthetic fixture exercise public navigation?\n\n## Citation\n\nSynthetic citation only.\n\n## Findings\n\nVisible performance body with deliberate Unicode   whitespace.\n\n## Zotero Annotations\n\nVisible Zotero introduction outside the managed block.\n\n<!-- zotero-annotations:start -->\nPRIVATE-ZOTERO-CANARY must never be searchable.\n<!-- zotero-annotations:end -->\n\nVisible Zotero conclusion outside the managed block.\n\n## Connections\n\n${supportLinks}\n- [[Private/Hidden-Neuron|neutral withheld reference]]\n`)
  const sources = [["jackman-flow", "paper", paperPath, paperBytes]]
  for (const [id, nodeClass, sourcePath, title, body] of supports) {
    sources.push([id, nodeClass, sourcePath, Buffer.from(`---\ntitle: ${title}\ntype: ${nodeClass}\ntags: [synthetic]\n---\n\n# ${title}\n\n${disclaimer}\n\n## Overview\n\n${body}\n`)])
  }
  for (const [, , sourcePath, bytes] of sources) {
    const absolute = path.join(paths.export, ...sourcePath.split("/"))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, bytes)
  }
  const nodes = sources.map(([public_id, node_class, sourcePath, bytes]) => ({ public_id, path: sourcePath, node_class, source_sha256: digest(bytes) }))
    .sort((left, right) => utf8Sort(left.public_id, right.public_id))
  const supportIds = supports.map(([id]) => id).sort(utf8Sort)
  const manifest = {
    schema_version: 1,
    manifest_id: "VPUB-20260728-t05-public-fixture",
    created_at: "2026-07-28T00:00:00Z",
    expires_at: "2026-07-29T00:00:00Z",
    action: {
      kind: "publish-unit",
      baseline: { kind: "genesis" },
      primary_id: "jackman-flow",
      support_ids: supportIds,
      added_node_ids: nodes.map((node) => node.public_id),
      direct_connection_edges: supportIds.map((target) => ({ source: "jackman-flow", target })),
    },
    nodes,
    public_set_digest: "0".repeat(64),
    approval_receipt: { approver: "tyler", channel: "telegram", source_event_id: "synthetic-t05-event", approved_plan_digest: "0".repeat(64), approved_at: "2026-07-28T00:01:00Z" },
    plan_digest: "0".repeat(64),
  }
  sealManifest(manifest)
  const receipt = {
    schema_version: 1,
    manifest_id: manifest.manifest_id,
    plan_digest: manifest.plan_digest,
    exported_at: "2026-07-28T00:02:00Z",
    drive_readback: "verified",
    files: nodes.map(({ path: sourcePath, source_sha256 }) => ({ path: sourcePath, source_sha256 })).sort((left, right) => utf8Sort(left.path, right.path)),
  }
  const manifestPath = path.join(paths.context, "manifest.json")
  const receiptPath = path.join(paths.export, "export-receipt.json")
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(receiptPath, JSON.stringify(receipt))
  return { root, paths, manifest, receipt, manifestPath, receiptPath, output: path.join(root, "output") }
}

async function replaceFixtureSource(fx, publicId, bytes) {
  const node = fx.manifest.nodes.find((candidate) => candidate.public_id === publicId)
  assert.ok(node)
  await writeFile(path.join(fx.paths.export, ...node.path.split("/")), bytes)
  node.source_sha256 = digest(bytes)
  sealManifest(fx.manifest)
  fx.receipt.plan_digest = fx.manifest.plan_digest
  fx.receipt.files = fx.manifest.nodes.map(({ path: sourcePath, source_sha256 }) => ({ path: sourcePath, source_sha256 })).sort((left, right) => utf8Sort(left.path, right.path))
  await writeFile(fx.manifestPath, JSON.stringify(fx.manifest))
  await writeFile(fx.receiptPath, JSON.stringify(fx.receipt))
}

async function fullManifestFixture() {
  const fx = await fixture("t05-full-manifest-")
  const baselineSources = [
    ["existing-node", "concept", "Knowledge/Concepts/existing-node.md", Buffer.from(`---\ntitle: Existing Public Concept\ntype: concept\ntags: [existing]\n---\n\n# Existing Public Concept\n\n${disclaimer}\n\n## Overview\n\nVisible unrelated public concept.\n`)],
    ["existing-paper", "paper", "Literature/Notes/existing-paper.md", Buffer.from(`---\ntitle: Existing Public Paper\ntype: literature-note\nstatus: integrated\nauthors:\n  - Existing Author\ntags:\n  - existing\n---\n\n# Existing Public Paper\n\n${disclaimer}\n\n## Bibliography\n\nExisting bibliography.\n\n## One-sentence Takeaway\n\nExisting takeaway.\n\n## Research Question\n\nExisting question.\n\n## Citation\n\nExisting citation.\n\n## Findings\n\nVisible unrelated public paper with an existing public link.\n\n## Connections\n\n- [[Knowledge/Concepts/existing-node|Existing Public Concept]]\n`)],
  ]
  const baselineNodes = []
  for (const [public_id, node_class, sourcePath, bytes] of baselineSources) {
    const absolute = path.join(fx.paths.export, ...sourcePath.split("/"))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, bytes)
    baselineNodes.push({ public_id, path: sourcePath, node_class, source_sha256: digest(bytes) })
  }
  baselineNodes.sort((left, right) => utf8Sort(left.public_id, right.public_id))
  const baselineManifest = {
    schema_version: 1,
    manifest_id: "VPUB-20260727-existing-baseline",
    created_at: "2026-07-27T00:00:00Z",
    expires_at: "2026-07-28T00:00:00Z",
    action: {
      kind: "publish-unit",
      baseline: { kind: "genesis" },
      primary_id: "existing-paper",
      support_ids: ["existing-node"],
      added_node_ids: ["existing-node", "existing-paper"],
      direct_connection_edges: [{ source: "existing-paper", target: "existing-node" }],
    },
    nodes: baselineNodes,
    public_set_digest: "0".repeat(64),
    approval_receipt: { approver: "tyler", channel: "telegram", source_event_id: "synthetic-t05-baseline", approved_plan_digest: "0".repeat(64), approved_at: "2026-07-27T00:01:00Z" },
    plan_digest: "0".repeat(64),
  }
  sealManifest(baselineManifest)
  const baselineReceipt = {
    schema_version: 1,
    release_digest: "0".repeat(64),
    manifest_id: "VPUB-20260727-existing-baseline",
    plan_digest: baselineManifest.plan_digest,
    public_set_digest: computePublicSetDigest(baselineNodes),
    created_at: "2026-07-27T12:00:00Z",
    nodes: baselineNodes,
    artifacts: [{ path: "index.html", sha256: "2".repeat(64) }],
    content_fingerprints: [
      { public_id: "existing-node", route: "/knowledge/concept/existing-node/", sha256: "3".repeat(64) },
      { public_id: "existing-paper", route: "/papers/existing-paper/", sha256: "4".repeat(64) },
    ],
  }
  const unsignedBaseline = structuredClone(baselineReceipt)
  delete unsignedBaseline.release_digest
  baselineReceipt.release_digest = sha256Jcs(unsignedBaseline)
  const receiptPath = "consumed/VPUB-20260727-existing-baseline/release-receipt.json"
  const runtimeReceipt = path.join(fx.paths.runtime, ...receiptPath.split("/"))
  await mkdir(path.dirname(runtimeReceipt), { recursive: true })
  await writeFile(path.join(path.dirname(runtimeReceipt), "manifest.json"), `${JSON.stringify(baselineManifest, null, 2)}\n`)
  await writeFile(runtimeReceipt, `${jcsCanonicalize(baselineReceipt)}\n`)
  await writeFile(path.join(fx.paths.runtime, "current-release.json"), `${jcsCanonicalize({ schema_version: 1, release_digest: baselineReceipt.release_digest, receipt_path: receiptPath })}\n`)

  fx.manifest.action.baseline = { kind: "release", release_digest: baselineReceipt.release_digest, receipt_path: receiptPath }
  fx.manifest.nodes.push(...baselineNodes)
  fx.manifest.nodes.sort((left, right) => utf8Sort(left.public_id, right.public_id))
  sealManifest(fx.manifest)
  fx.receipt.plan_digest = fx.manifest.plan_digest
  fx.receipt.files = fx.manifest.nodes.map(({ path: sourcePath, source_sha256 }) => ({ path: sourcePath, source_sha256 })).sort((left, right) => utf8Sort(left.path, right.path))
  await writeFile(fx.manifestPath, JSON.stringify(fx.manifest))
  await writeFile(fx.receiptPath, JSON.stringify(fx.receipt))
  return fx
}

async function literalFixture(graphVector, searchVector) {
  const root = await mkdtemp(path.join(os.tmpdir(), "t05-literal-fixture-"))
  const paths = Object.fromEntries(["context", "runtime", "export", "vault", "work"].map((name) => [name, path.join(root, name)]))
  await Promise.all(Object.values(paths).map((directory) => mkdir(directory)))
  await writeFile(path.join(paths.vault, "do-not-touch.md"), "canonical sentinel\n")

  const paperInput = searchVector.input
  const graphNodes = new Map(graphVector.input.nodes.map((node) => [node.public_id, node]))
  const paperNode = graphVector.input.nodes.find((node) => node.node_class === "paper")
  const supportNode = graphVector.input.nodes.find((node) => node.node_class !== "paper")
  assert.ok(paperNode && supportNode)
  assert.equal(paperInput.public_id, paperNode.public_id)
  const paperPath = `Literature/Notes/${paperNode.public_id}.md`
  const supportPath = `Knowledge/Concepts/${supportNode.public_id}.md`
  const normalized = (value) => String(value).replace(/\p{White_Space}+/gu, " ").trim()
  const connectionLines = graphVector.input.edges.map((edge) => {
    assert.equal(edge.source, paperNode.public_id)
    assert.equal(edge.target, supportNode.public_id)
    return `- [[${supportPath.replace(/\.md$/, "")}|${graphNodes.get(edge.target).title}]]`
  }).join("\n")
  const paperBytes = Buffer.from(`---\ntitle: ${normalized(paperInput.title)}\ntype: literature-note\nstatus: integrated\nauthors: [${paperInput.authors.map(normalized).join(", ")}]\ntags: [${paperInput.source_tags.join(", ")}]\n---\n\n${disclaimer}\n\n## Bibliography\n\n## One-sentence Takeaway\n\n## Research Question\n\n## Citation\n\n${paperInput.headings.map((heading) => `## ${heading}`).join("\n\n")}\n\n${paperInput.visible_body.join("\n\n")}\n\n## Connections\n\n${connectionLines}\n`)
  const supportBytes = Buffer.from(`---\ntitle: ${supportNode.title}\ntype: ${supportNode.node_class}\n---\n\n${disclaimer}\n`)
  const sources = [
    [paperNode.public_id, paperNode.node_class, paperPath, paperBytes],
    [supportNode.public_id, supportNode.node_class, supportPath, supportBytes],
  ]
  for (const [, , sourcePath, bytes] of sources) {
    const absolute = path.join(paths.export, ...sourcePath.split("/"))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, bytes)
  }
  const nodes = sources.map(([public_id, node_class, sourcePath, bytes]) => ({ public_id, path: sourcePath, node_class, source_sha256: digest(bytes) })).sort((left, right) => utf8Sort(left.public_id, right.public_id))
  const manifest = {
    schema_version: 1,
    manifest_id: "VPUB-20260728-t05-literal-fixture",
    created_at: "2026-07-28T00:00:00Z",
    expires_at: "2026-07-29T00:00:00Z",
    action: {
      kind: "publish-unit",
      baseline: { kind: "genesis" },
      primary_id: paperNode.public_id,
      support_ids: [supportNode.public_id],
      added_node_ids: nodes.map((node) => node.public_id),
      direct_connection_edges: [{ source: paperNode.public_id, target: supportNode.public_id }],
    },
    nodes,
    public_set_digest: "0".repeat(64),
    approval_receipt: { approver: "tyler", channel: "telegram", source_event_id: "synthetic-t05-literal-event", approved_plan_digest: "0".repeat(64), approved_at: "2026-07-28T00:01:00Z" },
    plan_digest: "0".repeat(64),
  }
  sealManifest(manifest)
  const receipt = {
    schema_version: 1,
    manifest_id: manifest.manifest_id,
    plan_digest: manifest.plan_digest,
    exported_at: "2026-07-28T00:02:00Z",
    drive_readback: "verified",
    files: nodes.map(({ path: sourcePath, source_sha256 }) => ({ path: sourcePath, source_sha256 })).sort((left, right) => utf8Sort(left.path, right.path)),
  }
  const manifestPath = path.join(paths.context, "manifest.json")
  const receiptPath = path.join(paths.export, "export-receipt.json")
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(receiptPath, JSON.stringify(receipt))
  return { root, paths, manifestPath, receiptPath, output: path.join(root, "output") }
}

function invoke(fx, command, env = {}) {
  const args = [cli, command,
    "--manifest", fx.manifestPath,
    "--export-receipt", fx.receiptPath,
    "--runtime-root", fx.paths.runtime,
    "--export-root", fx.paths.export,
    "--vault-root", fx.paths.vault,
    "--work-root", fx.paths.work,
    "--output", fx.output,
    "--now", now,
  ]
  const effectiveEnv = { ...env }
  if (!Object.hasOwn(effectiveEnv, "TYLER_TRACER_TEST_CAPABILITY") && Object.keys(effectiveEnv).some((name) => name.startsWith("TYLER_TRACER_TEST_"))) {
    effectiveEnv.TYLER_TRACER_TEST_CAPABILITY = "t03-regression-v1"
  }
  return spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...effectiveEnv }, timeout: 180_000 })
}

function oneJson(result) {
  assert.equal(result.stderr, "")
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1)
  return JSON.parse(result.stdout)
}

async function loadJson(filePath) {
  const bytes = await readFile(filePath)
  assert.equal(bytes.at(-1), 0x0a)
  assert.equal(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false)
  assert.equal(bytes.toString("utf8"), `${JSON.stringify(JSON.parse(bytes))}\n`)
  return JSON.parse(bytes)
}

async function outputTree(root) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else files.push([path.relative(root, absolute).split(path.sep).join("/"), await readFile(absolute)])
    }
  }
  await walk(root)
  return files.sort((left, right) => utf8Sort(left[0], right[0]))
}

async function compileSchema(name) {
  const schema = JSON.parse(await readFile(path.join(repoRoot, "schemas", `${name}-v1.schema.json`), "utf8"))
  return new Ajv2020({ strict: true }).compile(schema)
}

test("T05 slice A emits exact deterministic public graph/search data and suppresses private metadata", async (t) => {
  const fx = await fixture()
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const result = invoke(fx, "build")
  assert.equal(result.status, 0, result.stdout)

  const [graph, search, graphValid, searchValid] = await Promise.all([
    loadJson(path.join(fx.output, "graph.json")),
    loadJson(path.join(fx.output, "search-index.json")),
    compileSchema("public-graph"),
    compileSchema("search-index"),
  ])
  assert.equal(graphValid(graph), true, JSON.stringify(graphValid.errors))
  assert.equal(searchValid(search), true, JSON.stringify(searchValid.errors))
  assert.deepEqual(graph.nodes.map((node) => node.public_id), [...graph.nodes.map((node) => node.public_id)].sort(utf8Sort))
  assert.deepEqual(graph.edges, supports.map(([target]) => ({ source: "jackman-flow", target })).sort((left, right) => utf8Sort(`${left.source}\0${left.target}`, `${right.source}\0${right.target}`)))
  assert.equal(graph.nodes.length, 12)
  const publicIds = new Set(graph.nodes.map((node) => node.public_id))
  assert.ok(graph.edges.every((edge) => publicIds.has(edge.source) && publicIds.has(edge.target)))

  assert.deepEqual(search.records.map((record) => record.public_id), [...publicIds].sort(utf8Sort))
  const doiMatches = search.records.filter((record) => record.search_text.includes(jackmanDoi))
  assert.deepEqual(doiMatches.map((record) => record.public_id), ["jackman-flow"])
  assert.deepEqual(search.records.filter((record) => record.search_text.toLocaleLowerCase("en-US").includes("flow")).map((record) => record.public_id), flowIds)
  assert.deepEqual(search.records.find((record) => record.public_id === "jackman-flow"), {
    public_id: "jackman-flow",
    title: "Flow and Performance",
    node_class: "paper",
    url: "/papers/jackman-flow/",
    authors: ["Patricia C. Jackman", "Christian Swann"],
    doi: jackmanDoi,
    source_tags: ["flow", "sport"],
    // N4-B B1 intentionally changes this literal: safe unlisted-link display and
    // marker-external Zotero text are public search material.
    search_text: "Flow and Performance\nPatricia C. Jackman Christian Swann\n10.1016/j.psychsport.2021.102051\nflow sport\nFlow and Performance Bibliography One-sentence Takeaway Research Question Citation Findings Zotero Annotations Connections\nSYNTHETIC FIXTURE — NOT RESEARCH EVIDENCE. Synthetic bibliography only. Synthetic takeaway only. How does the synthetic fixture exercise public navigation? Synthetic citation only. Visible performance body with deliberate Unicode whitespace. Visible Zotero introduction outside the managed block. Visible Zotero conclusion outside the managed block. Patricia Jackman Attention Flow Motivation Skill Performance Map Interview Scale Flow Synthesis Running Swimming neutral withheld reference",
  })
  const allPublicBytes = (await Promise.all([
    readFile(path.join(fx.output, "graph.json"), "utf8"),
    readFile(path.join(fx.output, "search-index.json"), "utf8"),
    readFile(path.join(fx.output, "static", "contentIndex.json"), "utf8"),
  ])).join("\n")
  for (const canary of ["Private/Hidden-Neuron", "Hidden-Neuron", "hidden-neuron", "Private%2FHidden-Neuron", "PRIVATE-ZOTERO-CANARY"]) assert.equal(allPublicBytes.includes(canary), false)

  const [graphVector, searchVector] = await Promise.all([
    readFile(path.join(repoRoot, "specs", "fixtures", "public-graph-v1.literal-vector.json"), "utf8").then(JSON.parse),
    readFile(path.join(repoRoot, "specs", "fixtures", "search-index-v1.literal-vector.json"), "utf8").then(JSON.parse),
  ])
  const literal = await literalFixture(graphVector, searchVector)
  t.after(() => rm(literal.root, { recursive: true, force: true }))
  const literalResult = invoke(literal, "build")
  assert.equal(literalResult.status, 0, literalResult.stdout)
  const literalGraphBytes = await readFile(path.join(literal.output, "graph.json"), "utf8")
  assert.equal(literalGraphBytes, graphVector.expected_utf8)
  assert.deepEqual(JSON.parse(literalGraphBytes), JSON.parse(graphVector.expected_utf8))
  const literalSearch = await loadJson(path.join(literal.output, "search-index.json"))
  const paperSearch = { schema_version: literalSearch.schema_version, records: literalSearch.records.filter((record) => record.public_id === searchVector.input.public_id) }
  const paperSearchBytes = `${JSON.stringify(paperSearch)}\n`
  assert.equal(paperSearchBytes, searchVector.expected_utf8)
  assert.deepEqual(paperSearch, JSON.parse(searchVector.expected_utf8))
})

test("N4-B B1 search keeps safe display and marker-external Zotero text while suppressing managed/private content", async (t) => {
  const fx = await fixture()
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const result = invoke(fx, "build")
  assert.equal(result.status, 0, result.stdout)

  const search = await loadJson(path.join(fx.output, "search-index.json"))
  const paper = search.records.find((record) => record.public_id === "jackman-flow")
  assert.ok(paper)
  for (const visible of ["Zotero Annotations", "Visible Zotero introduction outside the managed block.", "Visible Zotero conclusion outside the managed block.", "neutral withheld reference"]) {
    assert.ok(paper.search_text.includes(visible), visible)
  }
  assert.equal(paper.search_text.includes("PRIVATE-ZOTERO-CANARY"), false)
  assert.deepEqual(search.records.filter((record) => record.search_text.toLocaleLowerCase("en-US").includes("neutral withheld reference")).map((record) => record.public_id), ["jackman-flow"])

  const paperHtml = await readFile(path.join(fx.output, "papers", "jackman-flow", "index.html"), "utf8")
  assert.match(paperHtml, /neutral withheld reference/)
  const allArtifacts = (await outputTree(fx.output)).map(([, bytes]) => bytes.toString("utf8")).join("\n")
  for (const privateForm of ["Private/Hidden-Neuron", "Private\\Hidden-Neuron", "Hidden-Neuron", "hidden-neuron", "Private%2FHidden-Neuron", "Private%252FHidden-Neuron"]) {
    assert.equal(allArtifacts.toLocaleLowerCase("en-US").includes(privateForm.toLocaleLowerCase("en-US")), false, privateForm)
  }
})

test("N4-B B2 canonical YAML block lists project ordered authors and sorted unique tags; invalid structures fail closed", async (t) => {
  const positive = await fixture()
  t.after(() => rm(positive.root, { recursive: true, force: true }))
  const built = invoke(positive, "build")
  assert.equal(built.status, 0, built.stdout)
  const search = await loadJson(path.join(positive.output, "search-index.json"))
  const paper = search.records.find((record) => record.public_id === "jackman-flow")
  assert.deepEqual(paper?.authors, ["Patricia C. Jackman", "Christian Swann"])
  assert.deepEqual(paper?.source_tags, ["flow", "sport"])
  assert.equal(paper?.title, "Flow and Performance")
  assert.equal(paper?.doi, jackmanDoi)

  const duplicate = await fixture("t05-yaml-duplicate-")
  t.after(() => rm(duplicate.root, { recursive: true, force: true }))
  const duplicatePath = path.join(duplicate.paths.export, "Literature", "Notes", "jackman-flow.md")
  const duplicateSource = await readFile(duplicatePath, "utf8")
  await replaceFixtureSource(duplicate, "jackman-flow", Buffer.from(duplicateSource.replace("title: Flow and Performance", "title: Flow and Performance\ntitle: Shadow Title")))
  const duplicateResult = invoke(duplicate, "preflight")
  assert.equal(duplicateResult.status, 1, duplicateResult.stdout)
  assert.equal(oneJson(duplicateResult).error.code, "SOURCE_FRONTMATTER_INVALID")

  const nested = await fixture("t05-yaml-nested-")
  t.after(() => rm(nested.root, { recursive: true, force: true }))
  const nestedPath = path.join(nested.paths.export, "Literature", "Notes", "jackman-flow.md")
  const nestedSource = await readFile(nestedPath, "utf8")
  await replaceFixtureSource(nested, "jackman-flow", Buffer.from(nestedSource.replace("tags:\n  - sport\n  - flow\n  - flow", "tags:\n  - nested:\n      key: value")))
  const nestedResult = invoke(nested, "preflight")
  assert.equal(nestedResult.status, 1, nestedResult.stdout)
  assert.equal(oneJson(nestedResult).error.code, "SOURCE_FRONTMATTER_INVALID")
})

test("N4-B B3 complete public manifest accepts unrelated existing paper/node while constraining only the action unit", async (t) => {
  const fx = await fullManifestFixture()
  t.after(() => rm(fx.root, { recursive: true, force: true }))

  const preflight = invoke(fx, "preflight")
  assert.equal(preflight.status, 0, preflight.stdout)
  assert.equal(oneJson(preflight).nodes, 14)

  const built = invoke(fx, "build")
  assert.equal(built.status, 0, built.stdout)
  const result = oneJson(built)
  assert.equal(result.nodes, 14)
  assert.ok(result.routes.includes("/papers/existing-paper/"))
  assert.ok(result.routes.includes("/knowledge/concept/existing-node/"))

  const [graph, search] = await Promise.all([
    loadJson(path.join(fx.output, "graph.json")),
    loadJson(path.join(fx.output, "search-index.json")),
  ])
  assert.deepEqual(graph.nodes.map((node) => node.public_id), fx.manifest.nodes.map((node) => node.public_id))
  assert.deepEqual(search.records.map((record) => record.public_id), fx.manifest.nodes.map((node) => node.public_id))
  const expectedEdges = [
    { source: "existing-paper", target: "existing-node" },
    ...fx.manifest.action.direct_connection_edges,
  ].sort((left, right) => utf8Sort(`${left.source}\0${left.target}`, `${right.source}\0${right.target}`))
  assert.deepEqual(graph.edges, expectedEdges)
  assert.ok(search.records.find((record) => record.public_id === "existing-paper")?.search_text.includes("Visible unrelated public paper with an existing public link."))
  const existingNode = await readFile(path.join(fx.output, "knowledge", "concept", "existing-node", "index.html"), "utf8")
  assert.match(existingNode, /<div\b[^>]*class="[^"]*backlinks[^"]*"[\s\S]*?href="[^"]*papers\/existing-paper[^"]*"/)
})

test("T05 A1 candidate gate closes percent/HTML decoding to a bounded fixpoint and fails closed at the cap", async (t) => {
  const matrix = [
    ["percent-double-encoded-suppressed-target", "CANDIDATE_SUPPRESSED_TARGET_DISCLOSURE"],
    ["percent-four-layer-suppressed-target", "CANDIDATE_SUPPRESSED_TARGET_DISCLOSURE"],
    ["html-four-layer-suppressed-target", "CANDIDATE_SUPPRESSED_TARGET_DISCLOSURE"],
    ["percent-four-layer-full-suppressed-target", "CANDIDATE_SUPPRESSED_TARGET_DISCLOSURE"],
    ["html-four-layer-full-suppressed-target", "CANDIDATE_SUPPRESSED_TARGET_DISCLOSURE"],
    ["percent-disclosure-depth-cap", "CANDIDATE_DISCLOSURE_DEPTH_EXCEEDED"],
  ]
  for (const [variant, expectedCode] of matrix) {
    await t.test(variant, async (t) => {
      const fx = await fixture()
      t.after(() => rm(fx.root, { recursive: true, force: true }))
      const result = invoke(fx, "build", { TYLER_TRACER_TEST_PREBASELINE_CASE: variant })
      assert.equal(result.status, 1, result.stdout)
      const failure = oneJson(result)
      assert.equal(failure.error.code, expectedCode)
      const serialized = JSON.stringify(failure)
      assert.equal(serialized.includes(fx.root), false)
      assert.equal(/Private|Hidden-Neuron|%25|&amp;/.test(serialized), false)
    })
  }
})

test("T05 A2 candidate gate rejects schema-invalid generated public data", async (t) => {
  const fx = await fixture()
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const result = invoke(fx, "build", { TYLER_TRACER_TEST_PREBASELINE_CASE: "public-data-empty-title" })
  assert.equal(result.status, 1, result.stdout)
  const failure = oneJson(result)
  assert.equal(failure.error.code, "CANDIDATE_PUBLIC_DATA_INVALID")
  assert.equal(JSON.stringify(failure).includes(fx.root), false)
})

test("T05 slice B exposes classed Explorer, DOI/flow search, and public-only SSR backlinks", async (t) => {
  const fx = await fixture()
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const result = invoke(fx, "build")
  assert.equal(result.status, 0, result.stdout)
  const paper = await readFile(path.join(fx.output, "papers", "jackman-flow", "index.html"), "utf8")
  const concept = await readFile(path.join(fx.output, "knowledge", "concept", "concept-flow", "index.html"), "utf8")
  const home = await readFile(path.join(fx.output, "index.html"), "utf8")
  for (const [html, siteRoot] of [[paper, "../../"], [concept, "../../../"], [home, "./"]]) {
    assert.match(html, /class="public-search"/)
    assert.match(html, /data-public-search-input/)
    assert.match(html, /data-tracer-extension="t05-search"/)
    assert.equal([...html.matchAll(/\bclass="([^"]*)"/g)].filter((match) => match[1].split(/\s+/).includes("explorer")).length, 1)
    assert.doesNotMatch(html, /public-explorer/)
    assert.ok(html.includes(`const publicSiteRoot=${JSON.stringify(siteRoot)}`))
    assert.match(html, /fetch\(new URL\(publicSiteRoot\+"static\/contentIndex\.json",document\.baseURI\)\)/)
  }
  const searchRuntime = /<script data-tracer-extension="t05-search">([\s\S]*?)<\/script>/.exec(paper)?.[1]
  assert.match(searchRuntime, /index=await fetchData/)
  assert.doesNotMatch(searchRuntime, /\bfetch\s*\(/)
  assert.match(concept, /<div\b[^>]*class="[^"]*backlinks[^"]*"[\s\S]*?href="[^"]*papers\/jackman-flow[^"]*"/)
  for (const html of [paper, concept]) {
    const backlinks = /<div\b[^>]*class="[^"]*backlinks[^"]*"[\s\S]*?<\/div>/.exec(html)?.[0]
    assert.ok(backlinks)
    assert.doesNotMatch(backlinks, /Hidden-Neuron|withheld reference|PRIVATE-ZOTERO-CANARY/)
  }
})

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.waiters = new Map()
    this.history = new Map()
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true })
      this.socket.addEventListener("error", reject, { once: true })
    })
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
        return
      }
      if (!message.method) return
      this.history.set(message.method, [...(this.history.get(message.method) ?? []), message.params])
      const waiters = this.waiters.get(message.method) ?? []
      this.waiters.delete(message.method)
      for (const resolve of waiters) resolve(message.params)
    })
  }
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  once(method) { return new Promise((resolve) => this.waiters.set(method, [...(this.waiters.get(method) ?? []), resolve])) }
  events(method) { return this.history.get(method) ?? [] }
  close() { this.socket.close() }
}

async function waitFor(read, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try { const value = await read(); if (value) return value } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("timed out waiting for Edge state")
}

function processExists(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error?.code === "ESRCH") return false
    throw error
  }
}

async function edgeSession(output, mount = "/") {
  const normalizedMount = `/${mount.split("/").filter(Boolean).join("/")}/`
  const serverRequests = []
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname)
      serverRequests.push(pathname)
      if (!pathname.startsWith(normalizedMount)) throw new Error("outside deployment mount")
      const publicPath = pathname.slice(normalizedMount.length)
      let target = path.resolve(output, publicPath)
      if (!target.startsWith(path.resolve(output))) throw new Error("escaped output")
      if (pathname.endsWith("/")) target = path.join(target, "index.html")
      const bytes = await readFile(target)
      const type = target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".css") ? "text/css" : target.endsWith(".json") ? "application/json" : "application/javascript"
      response.writeHead(200, { "content-type": type })
      response.end(bytes)
    } catch { response.writeHead(404); response.end("not found") }
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const port = server.address().port
  const profile = await mkdtemp(path.join(os.tmpdir(), "t05-edge-"))
  const edgeArgs = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `http://127.0.0.1:${port}${normalizedMount}`]
  const edge = spawn(edgeExecutable, edgeArgs, edgeSpawnOptions)
  if (!Number.isInteger(edge.pid)) throw new Error("Edge did not expose its spawned PID")
  const edgePid = edge.pid
  const stopEdge = async () => {
    const gone = async (timeout) => { try { await waitFor(() => !processExists(edgePid), timeout) } catch {}; return !processExists(edgePid) }
    if (processExists(edgePid)) edge.kill()
    if (!(await gone(2_000))) { edge.kill("SIGKILL"); await gone(2_000) }
    if (processExists(edgePid)) throw new Error(`spawned Edge PID ${edgePid} did not exit`)
    await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    const profileRemoved = await lstat(profile).then(() => false, (error) => error?.code === "ENOENT")
    return { pid: edgePid, exited: true, profileRemoved }
  }
  let client
  let closePromise
  try {
    const active = await waitFor(async () => {
      const lines = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/)
      return lines[0] ? lines : null
    })
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${active[0]}/json/list`)
      return (await response.json()).find((item) => item.type === "page" && item.webSocketDebuggerUrl)
    })
    client = new CdpClient(target.webSocketDebuggerUrl)
    await client.open()
    await Promise.all([client.send("Page.enable"), client.send("Runtime.enable"), client.send("Network.enable")])
    return { client, origin: `http://127.0.0.1:${port}`, baseUrl: `http://127.0.0.1:${port}${normalizedMount.slice(0, -1)}`, normalizedMount, serverRequests, edgePid, edgeArgs, close() {
      closePromise ??= (async () => {
        await client?.send("Browser.close").catch(() => {})
        client?.close()
        await new Promise((resolve) => server.close(resolve))
        return stopEdge()
      })()
      return closePromise
    } }
  } catch (error) {
    client?.close()
    await new Promise((resolve) => server.close(resolve))
    await stopEdge()
    throw error
  }
}

async function cdpNavigate(session, route, width, height) {
  await session.client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width <= 800 })
  const loaded = session.client.once("Page.loadEventFired")
  await session.client.send("Page.navigate", { url: `${session.baseUrl}${route}` })
  await loaded
  await waitFor(async () => (await session.client.send("Runtime.evaluate", { expression: "document.querySelector('.public-graph')?.dataset.layoutReady === 'true'", returnByValue: true })).result.value)
}

async function cdpValue(session, expression) {
  const result = await session.client.send("Runtime.evaluate", { expression: `(${expression})()`, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

const expectedGraphIds = ["author-jackman", "concept-attention", "concept-flow", "concept-motivation", "concept-skill", "jackman-flow", "map-performance", "method-interview", "method-scale", "synthesis-flow", "task-running", "task-swimming"]
const expectedGraphEdges = expectedGraphIds.filter((id) => id !== "jackman-flow").map((target) => `jackman-flow\0${target}`).sort(utf8Sort)
const expectedNodeClass = new Map([["jackman-flow", "paper"], ...supports.map(([id, nodeClass]) => [id, nodeClass])])
const expectedLocal = (rootId) => rootId === "jackman-flow"
  ? { ids: expectedGraphIds, edges: expectedGraphEdges }
  : { ids: [rootId, "jackman-flow"].sort(utf8Sort), edges: [`jackman-flow\0${rootId}`] }

async function graphMeasurement(session) {
  return cdpValue(session, `() => {
    const graph = document.querySelector(".public-graph"), svg = graph?.querySelector("svg"), finite = value => Number.isFinite(value)
    if (!graph || !svg) return { missing: true }
    const rectValue = element => { const rect = element.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } }
    const graphRect = rectValue(svg), nodes = [...svg.querySelectorAll("[data-graph-node-id]")]
    const labels = nodes.map(node => ({ id: node.dataset.graphNodeId, rect: rectValue(node.querySelector(".public-graph-label")) }))
    const glyphs = nodes.map(node => ({ id: node.dataset.graphNodeId, rect: rectValue(node.querySelector(".public-graph-glyph")) }))
    const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
    return {
      missing: false, id: graph.id, scope: graph.dataset.graphScope, root: graph.dataset.graphRootId ?? null, ready: graph.dataset.layoutReady,
      nodeIds: nodes.map(node => node.dataset.graphNodeId), edgeIds: [...svg.querySelectorAll("[data-graph-edge-source]")].map(edge => edge.dataset.graphEdgeSource + "\\0" + edge.dataset.graphEdgeTarget),
      labels, glyphs, graphRect,
      finiteLabels: labels.every(item => Object.values(item.rect).every(finite) && item.rect.width > 0 && item.rect.height > 0),
      labelsContained: labels.every(item => item.rect.left >= graphRect.left - .01 && item.rect.right <= graphRect.right + .01 && item.rect.top >= graphRect.top - .01 && item.rect.bottom <= graphRect.bottom + .01),
      labelPairIntersections: labels.flatMap((left, index) => labels.slice(index + 1).map(right => overlap(left.rect, right.rect))),
      foreignGlyphIntersections: labels.flatMap(label => glyphs.filter(glyph => glyph.id !== label.id).map(glyph => overlap(label.rect, glyph.rect))),
      positions: Object.fromEntries(glyphs.map(item => [item.id, [item.rect.left, item.rect.top]])),
      overflow: document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth,
      privateCanaryInDom: /Private(?:%2F|\\/)Hidden-Neuron|hidden-neuron/i.test(document.documentElement.outerHTML),
      externalOriginInDom: [...document.querySelectorAll("[href],[src]")].some(element => ["href", "src"].some(name => { const value = element.getAttribute(name); if (!value) return false; try { const url = new URL(value, document.baseURI); return /^https?:$/.test(url.protocol) && url.origin !== location.origin } catch { return true } })),
    }
  }`)
}

async function navigationMeasurement(session) {
  return cdpValue(session, `() => {
    const explorer = document.querySelector(".explorer")
    const groups = [...explorer.querySelectorAll(":scope .public-class-group")]
    const entries = [...explorer.querySelectorAll(":scope [data-tracer-entry] a")]
    return {
      explorerCount: document.querySelectorAll(".explorer").length,
      publicExplorerCount: document.querySelectorAll(".public-explorer").length,
      groups: groups.map(group => ({ label: group.querySelector(":scope > .public-class-group-label")?.textContent, count: group.querySelectorAll(":scope > ul > [data-tracer-entry]").length })),
      entries: entries.map(entry => ({ id: entry.dataset.publicId, nodeClass: entry.dataset.nodeClass, href: entry.href })),
    }
  }`)
}

function assertGraph(measured, scope, rootId, expectedIds, expectedEdges) {
  assert.equal(measured.missing, false)
  assert.equal(measured.id, scope === "global" ? "public-graph-global" : `public-graph-local-${rootId}`)
  assert.equal(measured.scope, scope)
  assert.equal(measured.root, rootId)
  assert.equal(measured.ready, "true")
  assert.equal(measured.nodeIds.length, expectedIds.length)
  assert.deepEqual(measured.nodeIds, expectedIds)
  assert.equal(measured.edgeIds.length, expectedEdges.length)
  assert.deepEqual(measured.edgeIds, expectedEdges)
  const publicSet = new Set(expectedIds)
  assert.ok(measured.edgeIds.every((edge) => edge.split("\0").every((id) => publicSet.has(id))))
  assert.equal(measured.labels.length, expectedIds.length)
  assert.equal(measured.glyphs.length, expectedIds.length)
  assert.equal(measured.finiteLabels, true, JSON.stringify(measured.labels))
  assert.equal(measured.labelsContained, true, JSON.stringify({ labels: measured.labels, graph: measured.graphRect }))
  assert.equal(measured.labelPairIntersections.length, expectedIds.length * (expectedIds.length - 1) / 2)
  assert.ok(measured.labelPairIntersections.every((area) => area === 0), JSON.stringify(measured.labelPairIntersections))
  assert.equal(measured.foreignGlyphIntersections.length, expectedIds.length * (expectedIds.length - 1))
  assert.ok(measured.foreignGlyphIntersections.every((area) => area === 0), JSON.stringify(measured.foreignGlyphIntersections))
}

test("T05 slice C renders deterministic project-owned global/local graphs and passes real Edge graph/search acceptance from a deployment subpath", async (t) => {
  const fx = await fixture()
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const result = invoke(fx, "build")
  assert.equal(result.status, 0, result.stdout)
  const graph = await loadJson(path.join(fx.output, "graph.json"))
  assert.equal(graph.nodes.length, expectedGraphIds.length)
  assert.deepEqual(graph.nodes.map((node) => node.public_id), expectedGraphIds)
  assert.equal(graph.edges.length, expectedGraphEdges.length)
  assert.deepEqual(graph.edges.map((edge) => `${edge.source}\0${edge.target}`), expectedGraphEdges)
  const publicIds = new Set(expectedGraphIds)
  assert.ok(graph.edges.every((edge) => publicIds.has(edge.source) && publicIds.has(edge.target)))

  const routeById = new Map([["jackman-flow", ["papers", "jackman-flow", "index.html"]], ...supports.map(([id, nodeClass]) => [id, ["knowledge", nodeClass, id, "index.html"]])])
  const home = await readFile(path.join(fx.output, "index.html"), "utf8")
  assert.match(home, /<section\b(?=[^>]*id="public-graph-global")(?=[^>]*data-graph-scope="global")(?=[^>]*data-layout-ready="false")[^>]*>/)
  for (const id of expectedGraphIds) {
    const html = await readFile(path.join(fx.output, ...routeById.get(id)), "utf8")
    assert.match(html, new RegExp(`<section\\b(?=[^>]*id="public-graph-local-${id}")(?=[^>]*data-graph-scope="local")(?=[^>]*data-graph-root-id="${id}")(?=[^>]*data-layout-ready="false")[^>]*>`))
  }
  assert.match(home, /data-tracer-extension="t05-graph"/)
  assert.match(home, /fetch\(new URL\(publicSiteRoot\+"graph\.json",document\.baseURI\)\)/)
  assert.doesNotMatch(home, /fetch\(["']\/graph\.json|href=["']\/(?:papers|knowledge)\//)
  assert.doesNotMatch(home, /@quartz-community\/graph|cdnjs|https?:\/\/(?!www\.w3\.org\/2000\/svg)/i)

  const session = await edgeSession(fx.output, "/repo/")
  t.after(() => session.close())
  assert.ok(session.edgeArgs.includes("--headless=new"))
  assert.equal(edgeSpawnOptions.windowsHide, true)
  await cdpNavigate(session, "/", 1440, 1100)
  const globalDesktop = await graphMeasurement(session)
  assertGraph(globalDesktop, "global", null, expectedGraphIds, expectedGraphEdges)
  const expectedGroups = [
    ["Papers", ["jackman-flow"]],
    ["Concepts", ["concept-attention", "concept-flow", "concept-motivation", "concept-skill"]],
    ["Methods", ["method-interview", "method-scale"]],
    ["Tasks", ["task-running", "task-swimming"]],
    ["Authors", ["author-jackman"]],
    ["Syntheses", ["synthesis-flow"]],
    ["Maps", ["map-performance"]],
  ]
  const assertNavigation = async () => {
    const navigation = await navigationMeasurement(session)
    assert.equal(navigation.explorerCount, 1)
    assert.equal(navigation.publicExplorerCount, 0)
    assert.deepEqual(navigation.groups, expectedGroups.map(([label, ids]) => ({ label, count: ids.length })))
    assert.deepEqual(navigation.entries.map((entry) => entry.id), expectedGroups.flatMap(([, ids]) => ids))
    assert.deepEqual(navigation.entries.map(({ id, nodeClass }) => ({ id, nodeClass })), expectedGroups.flatMap(([, ids]) => ids.map((id) => ({ id, nodeClass: expectedNodeClass.get(id) }))))
    assert.equal(new Set(navigation.entries.map((entry) => entry.id)).size, expectedGraphIds.length)
    assert.ok(navigation.entries.every((entry) => entry.id && entry.nodeClass && entry.href.startsWith(`${session.baseUrl}/`)))
  }
  await assertNavigation()
  const homeSubpathLinks = await cdpValue(session, `async () => {
    const href = selector => { const element = document.querySelector(selector); return element ? new URL(element.getAttribute("href"), document.baseURI).href : null }
    const input = document.querySelector("[data-public-search-input]")
    input.value = ${JSON.stringify(jackmanDoi)}
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 80))
    return {
      explorer: href(".explorer [data-public-id]"),
      search: href("[data-public-search-results] [data-public-id]"),
      graph: href(".public-graph [data-graph-node-id] a"),
      backlinkCount: document.querySelectorAll("[data-public-backlinks] a").length,
    }
  }`)
  assert.ok([homeSubpathLinks.explorer, homeSubpathLinks.search, homeSubpathLinks.graph].every((href) => href?.startsWith(`${session.baseUrl}/`)), JSON.stringify(homeSubpathLinks))
  assert.equal(homeSubpathLinks.backlinkCount, 0)
  await cdpNavigate(session, "/", 1440, 1100)
  const globalReload = await graphMeasurement(session)
  assertGraph(globalReload, "global", null, expectedGraphIds, expectedGraphEdges)
  for (const id of expectedGraphIds) for (const axis of [0, 1]) assert.ok(Math.abs(globalDesktop.positions[id][axis] - globalReload.positions[id][axis]) <= 0.5)

  await cdpNavigate(session, "/papers/jackman-flow/", 390, 844)
  const localMobile = await graphMeasurement(session)
  assertGraph(localMobile, "local", "jackman-flow", expectedGraphIds, expectedGraphEdges)
  assert.equal(localMobile.overflow, true)
  assert.equal(localMobile.privateCanaryInDom, false)
  assert.equal(localMobile.externalOriginInDom, false)
  await assertNavigation()
  const search = await cdpValue(session, `async () => {
    const input = document.querySelector("[data-public-search-input]"), results = document.querySelector("[data-public-search-results]")
    const query = async value => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 80)); return [...results.querySelectorAll("[data-public-id]")].map(item => item.dataset.publicId) }
    return { doi: await query(${JSON.stringify(jackmanDoi)}), flow: await query("flow"), privateCanary: await query("Private/Hidden-Neuron"), zoteroCanary: await query("PRIVATE-ZOTERO-CANARY") }
  }`)
  assert.deepEqual(search.doi, ["jackman-flow"])
  assert.equal(search.flow.length, flowIds.length)
  assert.deepEqual(search.flow, flowIds)
  assert.equal(search.privateCanary.length, 0)
  assert.deepEqual(search.privateCanary, [])
  assert.equal(search.zoteroCanary.length, 0)
  assert.deepEqual(search.zoteroCanary, [])

  await cdpNavigate(session, "/knowledge/concept/concept-flow/", 1440, 1100)
  await assertNavigation()
  const subpathLinks = await cdpValue(session, `async () => {
    const href = selector => { const element = document.querySelector(selector); return element ? new URL(element.getAttribute("href"), document.baseURI).href : null }
    const input = document.querySelector("[data-public-search-input]")
    input.value = ${JSON.stringify(jackmanDoi)}
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 80))
    return {
      explorer: href(".explorer [data-public-id]"),
      search: href("[data-public-search-results] [data-public-id]"),
      backlink: href("[data-public-backlinks] a"),
      graph: href(".public-graph [data-graph-node-id] a"),
    }
  }`)
  assert.ok(Object.values(subpathLinks).every((href) => href?.startsWith(`${session.baseUrl}/`)), JSON.stringify(subpathLinks))

  await cdpNavigate(session, "/papers/jackman-flow/", 390, 844)
  const localMobileReload = await graphMeasurement(session)
  assertGraph(localMobileReload, "local", "jackman-flow", expectedGraphIds, expectedGraphEdges)
  for (const id of expectedGraphIds) for (const axis of [0, 1]) assert.ok(Math.abs(localMobile.positions[id][axis] - localMobileReload.positions[id][axis]) <= 0.5)

  for (const [id, nodeClass] of supports) {
    const local = expectedLocal(id)
    await cdpNavigate(session, `/knowledge/${nodeClass}/${id}/`, 1440, 1100)
    assertGraph(await graphMeasurement(session), "local", id, local.ids, local.edges)
  }
  await cdpNavigate(session, "/", 390, 844)
  const globalMobile = await graphMeasurement(session)
  assertGraph(globalMobile, "global", null, expectedGraphIds, expectedGraphEdges)
  assert.equal(globalMobile.overflow, true)
  const requestUrls = session.client.events("Network.requestWillBeSent").map((event) => event.request.url)
  assert.ok(requestUrls.length > 0)
  assert.ok(requestUrls.every((url) => url.startsWith(`${session.baseUrl}/`)), JSON.stringify(requestUrls))
  assert.ok(requestUrls.some((url) => url === `${session.baseUrl}/graph.json`), JSON.stringify(requestUrls))
  assert.ok(requestUrls.some((url) => url === `${session.baseUrl}/static/contentIndex.json`), JSON.stringify(requestUrls))
  const responses = session.client.events("Network.responseReceived").map((event) => event.response)
  for (const suffix of ["/graph.json", "/static/contentIndex.json"]) assert.ok(responses.some((response) => response.url === `${session.baseUrl}${suffix}` && response.status === 200), JSON.stringify(responses))
  assert.equal(session.serverRequests.some((pathname) => !pathname.startsWith("/repo/")), false, JSON.stringify(session.serverRequests))
  assert.ok(requestUrls.every((url) => !/Private(?:%2F|\/)Hidden-Neuron|hidden-neuron/i.test(url)), JSON.stringify(requestUrls))
  const cleanup = await session.close()
  assert.deepEqual(cleanup, { pid: session.edgePid, exited: true, profileRemoved: true })
  t.diagnostic(`Edge cleanup ${JSON.stringify(cleanup)}`)
})
