// @ts-nocheck -- public CLI mutation matrix intentionally builds dynamic invalid contracts.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

import { computePlanDigest, computePublicSetDigest } from "../lib/publication-contracts.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const cli = path.join(repoRoot, "scripts", "tracer.mjs")
const now = "2026-07-28T12:00:00Z"
const disclaimer = "SYNTHETIC FIXTURE — NOT RESEARCH EVIDENCE."
const disclaimerParagraph = /<p>\s*SYNTHETIC FIXTURE — NOT RESEARCH EVIDENCE\.\s*<\/p>/

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")

function sealManifest(manifest) {
  manifest.public_set_digest = computePublicSetDigest(manifest.nodes)
  manifest.plan_digest = computePlanDigest(manifest)
  manifest.approval_receipt.approved_plan_digest = manifest.plan_digest
}

async function snapshot(root) {
  const rows = []
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name)
      const metadata = await lstat(absolute)
      if (metadata.isDirectory()) {
        rows.push([path.relative(root, absolute), "d", metadata.mtimeMs])
        await walk(absolute)
      } else rows.push([path.relative(root, absolute), "f", metadata.mtimeMs, digest(await readFile(absolute))])
    }
  }
  await walk(root)
  return rows
}

async function fixture(prefix = "tracer-fixture-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  const paths = Object.fromEntries(["context", "runtime", "export", "vault", "work"].map((name) => [name, path.join(root, name)]))
  await Promise.all(Object.values(paths).map((directory) => mkdir(directory)))
  await writeFile(path.join(paths.vault, "do-not-touch.md"), "canonical sentinel\n")
  const supportPath = "Knowledge/Concepts/synthetic-support.md"
  const paperPath = "Literature/Notes/synthetic-paper.md"
  const supportBytes = Buffer.from(`---\ntitle: Synthetic Support\ntype: concept\naliases: [support-alias]\n---\n\n# Synthetic Support\n\n${disclaimer}\n`)
  const paperBytes = Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\naliases: [paper-alias]\n---\n\n# Synthetic Paper\n\n${disclaimer}\n\n## Connections\n\nCode example: \`[[Knowledge/Concepts/synthetic-support|approved support alias]]\`\n\n- [[Knowledge/Concepts/synthetic-support|approved support alias]]\n- [[Private/Hidden-Neuron|neutral withheld reference]]\n`)
  for (const [relative, bytes] of [[supportPath, supportBytes], [paperPath, paperBytes]]) {
    const absolute = path.join(paths.export, ...relative.split("/"))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, bytes)
  }
  const manifest = {
    schema_version: 1,
    manifest_id: "VPUB-20260728-tracer-fixture",
    created_at: "2026-07-28T00:00:00Z",
    expires_at: "2026-07-29T00:00:00Z",
    action: {
      kind: "publish-unit", baseline: { kind: "genesis" }, primary_id: "synthetic-paper",
      support_ids: ["synthetic-support"], added_node_ids: ["synthetic-paper", "synthetic-support"],
      direct_connection_edges: [{ source: "synthetic-paper", target: "synthetic-support" }],
    },
    nodes: [
      { public_id: "synthetic-paper", path: paperPath, node_class: "paper", source_sha256: digest(paperBytes) },
      { public_id: "synthetic-support", path: supportPath, node_class: "concept", source_sha256: digest(supportBytes) },
    ],
    public_set_digest: "0".repeat(64),
    approval_receipt: { approver: "tyler", channel: "telegram", source_event_id: "synthetic-test-event", approved_plan_digest: "0".repeat(64), approved_at: "2026-07-28T00:01:00Z" },
    plan_digest: "0".repeat(64),
  }
  sealManifest(manifest)
  const receipt = {
    schema_version: 1, manifest_id: manifest.manifest_id, plan_digest: manifest.plan_digest,
    exported_at: "2026-07-28T00:02:00Z", drive_readback: "verified",
    files: manifest.nodes.map(({ path: filePath, source_sha256 }) => ({ path: filePath, source_sha256 })).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))),
  }
  const manifestPath = path.join(paths.context, "manifest.json")
  const receiptPath = path.join(paths.export, "export-receipt.json")
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(receiptPath, JSON.stringify(receipt))
  return { root, paths, manifest, receipt, manifestPath, receiptPath, output: path.join(root, "output") }
}

function invoke(fx, command, extra = {}, env = {}) {
  const values = {
    manifest: fx.manifestPath, exportReceipt: fx.receiptPath, runtimeRoot: fx.paths.runtime,
    exportRoot: fx.paths.export, vaultRoot: fx.paths.vault, workRoot: fx.paths.work,
    output: fx.output, now, ...extra,
  }
  const names = { manifest: "--manifest", exportReceipt: "--export-receipt", runtimeRoot: "--runtime-root", exportRoot: "--export-root", vaultRoot: "--vault-root", workRoot: "--work-root", output: "--output", now: "--now" }
  const args = [cli, command]
  for (const [key, flag] of Object.entries(names)) args.push(flag, values[key])
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

function headingSection(html, id) {
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*\bid=["']([^"']+)["'][^>]*>/gi)]
  const currentIndex = headings.findIndex((heading) => heading[2] === id)
  assert.notEqual(currentIndex, -1, `missing #${id} heading`)
  const current = headings[currentIndex]
  const level = Number(current[1])
  const next = headings.slice(currentIndex + 1).find((heading) => Number(heading[1]) <= level)
  return html.slice(current.index, next?.index ?? html.length)
}

function containsText(value, needle) {
  if (typeof value === "string") return value.includes(needle)
  if (Array.isArray(value)) return value.some((item) => containsText(item, needle))
  return Boolean(value && typeof value === "object" && Object.values(value).some((item) => containsText(item, needle)))
}

async function rewriteContracts(fx) {
  sealManifest(fx.manifest)
  fx.receipt.manifest_id = fx.manifest.manifest_id
  fx.receipt.plan_digest = fx.manifest.plan_digest
  fx.receipt.files = fx.manifest.nodes.map(({ path: filePath, source_sha256 }) => ({ path: filePath, source_sha256 })).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
  await writeFile(fx.manifestPath, JSON.stringify(fx.manifest))
  await writeFile(fx.receiptPath, JSON.stringify(fx.receipt))
}

async function replaceSource(fx, nodeId, bytes) {
  const node = fx.manifest.nodes.find((item) => item.public_id === nodeId)
  await writeFile(path.join(fx.paths.export, ...node.path.split("/")), bytes)
  node.source_sha256 = digest(bytes)
  await rewriteContracts(fx)
}

test("T03 public preflight is read-only and build produces the exact gated Quartz routes", async (t) => {
  const fx = await fixture()
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const before = await snapshot(fx.root)
  const preflight = invoke(fx, "preflight")
  assert.equal(preflight.status, 0, preflight.stdout)
  assert.deepEqual(oneJson(preflight), { ok: true, command: "preflight", manifestId: fx.manifest.manifest_id, nodes: 2, suppressionCount: 1, quartz: "5.0.0" })
  assert.deepEqual(await snapshot(fx.root), before)

  const protectedBefore = Object.fromEntries(await Promise.all(
    ["context", "runtime", "export", "vault", "work"].map(async (name) => [name, await snapshot(fx.paths[name])]),
  ))
  const build = invoke(fx, "build")
  assert.equal(build.status, 0, `${build.stdout}\n${build.error ?? ""}`)
  const result = oneJson(build)
  assert.deepEqual(result.routes, ["/", "/knowledge/concept/synthetic-support/", "/papers/synthetic-paper/"])
  const outputFiles = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else outputFiles.push([path.relative(fx.output, absolute).split(path.sep).join("/"), await readFile(absolute)])
    }
  }
  await walk(fx.output)
  const htmlFiles = outputFiles.filter(([relative]) => relative.endsWith(".html")).map(([relative]) => relative)
  assert.deepEqual(htmlFiles.sort(), ["index.html", "knowledge/concept/synthetic-support/index.html", "papers/synthetic-paper/index.html"])
  const paper = await readFile(path.join(fx.output, "papers", "synthetic-paper", "index.html"), "utf8")
  const support = await readFile(path.join(fx.output, "knowledge", "concept", "synthetic-support", "index.html"), "utf8")
  const home = await readFile(path.join(fx.output, "index.html"), "utf8")
  assert.match(home, /SYNTHETIC \/ NON-RESEARCH/)
  const resolvedHrefs = (html, route) => [...html.matchAll(/\bhref="([^"]+)"/g)].map((match) => new URL(match[1], `https://example.invalid${route}`).pathname)
  assert.ok(resolvedHrefs(home, "/").includes("/papers/synthetic-paper/"))
  assert.ok(resolvedHrefs(home, "/").includes("/knowledge/concept/synthetic-support/"))
  const paperBacklinks = headingSection(paper, "backlinks")
  const supportBacklinks = headingSection(support, "backlinks")
  assert.equal(resolvedHrefs(paperBacklinks, "/papers/synthetic-paper/").includes("/knowledge/concept/synthetic-support/"), false)
  assert.ok(resolvedHrefs(supportBacklinks, "/knowledge/concept/synthetic-support/").includes("/papers/synthetic-paper/"))
  assert.ok(resolvedHrefs(paper, "/papers/synthetic-paper/").includes("/knowledge/concept/synthetic-support/"))
  assert.equal(resolvedHrefs(support, "/knowledge/concept/synthetic-support/").filter((href) => href === "/papers/synthetic-paper/").length, 1)
  assert.match(paper, disclaimerParagraph)
  assert.match(support, disclaimerParagraph)
  assert.match(paper, /<code>\[\[Knowledge\/Concepts\/synthetic-support\|approved support alias\]\]<\/code>/)
  assert.equal(resolvedHrefs(paper, "/papers/synthetic-paper/").filter((href) => href === "/knowledge/concept/synthetic-support/").length, 1)
  assert.match(paper, />neutral withheld reference</)
  const privateTargetVariants = ["Private/Hidden-Neuron", "private/hidden-neuron", "Hidden-Neuron", "hidden-neuron", "Private/Hidden-Neuron.md", "private/hidden-neuron.md"]
  for (const text of [home, paper, support]) {
    for (const privateTarget of privateTargetVariants) assert.equal(text.includes(privateTarget), false)
    assert.equal(text.includes("neutral withheld reference"), text === paper)
  }
  const privateBytes = [fx.root, fx.paths.context, fx.paths.runtime, fx.paths.export, fx.paths.vault, fx.paths.work, fx.manifestPath, fx.receiptPath]
    .flatMap((value) => [value, value.replace(/\\/g, "/")])
  for (const [relative, bytes] of outputFiles) {
    assert.doesNotMatch(relative, /\.(?:md|pdf)$/i)
    const text = bytes.toString("utf8")
    assert.doesNotMatch(text, /export-receipt|publication-manifest|release-receipt|current-release/i)
    for (const privateTarget of privateTargetVariants) assert.equal(text.includes(privateTarget), false)
    assert.equal(privateBytes.some((value) => text.includes(value)), false)
  }
  const protectedAfter = Object.fromEntries(await Promise.all(
    ["context", "runtime", "export", "vault", "work"].map(async (name) => [name, await snapshot(fx.paths[name])]),
  ))
  assert.deepEqual(protectedAfter, protectedBefore)
})

test("T03 MDAST semantics accept nested-list continuation links after unmatched visible backticks", async (t) => {
  const fx = await fixture("tracer-mdast-positive-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  await replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n# Synthetic Paper\n\n${disclaimer}\n\nAn unmatched \` remains ordinary visible CommonMark text.\n\n## Connections\n\n- Nested list item\n    continuation [[Knowledge/Concepts/synthetic-support|approved support alias]]\n`))
  const before = await snapshot(fx.root)
  const result = invoke(fx, "preflight")
  assert.equal(result.status, 0, result.stdout)
  assert.deepEqual(oneJson(result), { ok: true, command: "preflight", manifestId: fx.manifest.manifest_id, nodes: 2, suppressionCount: 0, quartz: "5.0.0" })
  assert.deepEqual(await snapshot(fx.root), before)
  await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
  assert.equal((await readdir(fx.paths.work)).length, 0)
})

test("T03 CLI flags fail closed with one JSON object and empty stderr", async (t) => {
  const fx = await fixture("tracer-cli-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  for (const args of [
    [cli, "unknown"],
    [cli, "preflight", "--unknown", "x"],
    [cli, "preflight", "--manifest", fx.manifestPath, "--manifest", fx.manifestPath],
  ]) {
    const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8" })
    assert.equal(result.status, 1)
    const failure = oneJson(result)
    assert.equal(failure.ok, false)
    assert.equal(containsText(failure, fx.root), false)
  }

  const disclosure = invoke(fx, "preflight", {}, { TYLER_TRACER_TEST_DISCLOSURE_ERROR: fx.root })
  assert.equal(disclosure.status, 1)
  const redacted = oneJson(disclosure)
  assert.equal(redacted.error.code, "TEST_DISCLOSURE")
  assert.equal(containsText(redacted, fx.root), false)
})

test("T03 preflight negative matrix leaves output absent and source/Vault unchanged", async (t) => {
  const cases = [
    ["unlisted export", null, async (fx) => writeFile(path.join(fx.paths.export, "extra.txt"), "no")],
    ["hash mismatch", null, async (fx) => { fx.manifest.nodes[0].source_sha256 = "0".repeat(64); await rewriteContracts(fx); fx.receipt.files[0].source_sha256 = "0".repeat(64); await writeFile(fx.receiptPath, JSON.stringify(fx.receipt)) }],
    ["paper frontmatter", "PAPER_FRONTMATTER_INVALID", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Bad\ntype: paper\nstatus: integrated\n---\n\n${disclaimer}\n\n## Connections\n\n[[Knowledge/Concepts/synthetic-support]]\n`))],
    ["active Markdown", "SOURCE_ACTIVE_CONTENT_NOT_ALLOWED", async (fx) => replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Bad\ntype: concept\n---\n\n${disclaimer}\n<script>alert(1)</script>\n`))],
    ["raw svg event handler", "SOURCE_ACTIVE_CONTENT_NOT_ALLOWED", async (fx) => replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Bad\ntype: concept\n---\n\n${disclaimer}\n<svg onload=alert(1)>\n`))],
    ["raw details event handler", "SOURCE_ACTIVE_CONTENT_NOT_ALLOWED", async (fx) => replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Bad\ntype: concept\n---\n\n${disclaimer}\n<details ontoggle=alert(1)>unsafe</details>\n`))],
    ["unsafe scheme", "SOURCE_UNSAFE_URL_SCHEME", async (fx) => replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Bad\ntype: concept\n---\n\n${disclaimer}\n[x](javascript:alert(1))\n`))],
    ["missing direct connection", "DIRECT_CONNECTION_MISSING", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n## Connections\n\nNo approved path link.\n`))],
    ["direct connection only in inline code", "DIRECT_CONNECTION_MISSING", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n## Connections\n\n\`[[Knowledge/Concepts/synthetic-support]]\`\n`))],
    ["direct connection only in fenced code", "DIRECT_CONNECTION_MISSING", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n## Connections\n\n~~~md\n[[Knowledge/Concepts/synthetic-support]]\n~~~\n`))],
    ["direct connection only in multiline reference definition title", "DIRECT_CONNECTION_MISSING", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n## Connections\n\n[support]: https://example.invalid\n  "[[Knowledge/Concepts/synthetic-support]]"\n`))],
    ["direct connection only in multiline Markdown link title", "DIRECT_CONNECTION_MISSING", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n## Connections\n\n[neutral](https://example.invalid\n  "[[Knowledge/Concepts/synthetic-support]]")\n`))],
    ["Connections heading contains inline code", "DIRECT_CONNECTION_MISSING", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n## \`Connections\`\n\n[[Knowledge/Concepts/synthetic-support]]\n`))],
    ["escaped direct connection opener", "DIRECT_CONNECTION_MISSING", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n## Connections\n\n\\[[Knowledge/Concepts/synthetic-support]]\n`))],
    ["ambiguous alias", "AMBIGUOUS_ALIAS", async (fx) => replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Synthetic Paper\ntype: concept\n---\n\n${disclaimer}\n`))],
    ["unlisted target without pipe display", "UNLISTED_DISPLAY_REQUIRED", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n## Connections\n\n- [[Knowledge/Concepts/synthetic-support|approved support alias]]\n- [[Private/Hidden-Neuron]]\n`))],
    ["unlisted target in inline code without safe display", "UNLISTED_DISPLAY_REQUIRED", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n\`[[Private/Hidden-Neuron]]\`\n\n## Connections\n\n- [[Knowledge/Concepts/synthetic-support|approved support alias]]\n`))],
    ["escaped unlisted target without safe display", "UNLISTED_DISPLAY_REQUIRED", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n\\[[Private/Hidden-Neuron]]\n\n## Connections\n\n- [[Knowledge/Concepts/synthetic-support|approved support alias]]\n`))],
    ["nested private opener in code context", "SOURCE_NESTED_WIKILINK_NOT_ALLOWED", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n\`[[Knowledge/Concepts/synthetic-support|ok [[Private/Hidden|neutral]]]]\`\n\n## Connections\n\n- [[Knowledge/Concepts/synthetic-support|approved support alias]]\n`))],
    ["nested private opener in visible text", "SOURCE_NESTED_WIKILINK_NOT_ALLOWED", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n## Connections\n\n- [[Knowledge/Concepts/synthetic-support|ok [[Private/Hidden|neutral]]]]\n`))],
    ["unlisted target exposed as display", "UNLISTED_DISPLAY_REQUIRED", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n## Connections\n\n- [[Knowledge/Concepts/synthetic-support|approved support alias]]\n- [[Private/Hidden-Neuron|hidden-neuron]]\n`))],
    ["disclaimer only in frontmatter", "SYNTHETIC_DISCLAIMER_REQUIRED", async (fx) => replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Bad\ntype: concept\ndisclaimer: "${disclaimer}"\n---\n\n# No visible disclaimer\n`))],
    ["disclaimer only in reference definition title", "SYNTHETIC_DISCLAIMER_REQUIRED", async (fx) => replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Bad\ntype: concept\n---\n\n[fixture]: https://example.invalid "${disclaimer}"\n`))],
    ["disclaimer only in Markdown link title", "SYNTHETIC_DISCLAIMER_REQUIRED", async (fx) => replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Bad\ntype: concept\n---\n\n[fixture](https://example.invalid "${disclaimer}")\n`))],
    ["disclaimer only in code", "SYNTHETIC_DISCLAIMER_REQUIRED", async (fx) => replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Bad\ntype: concept\n---\n\n\`${disclaimer}\`\n`))],
    ["disclaimer only in list", "SYNTHETIC_DISCLAIMER_REQUIRED", async (fx) => replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Bad\ntype: concept\n---\n\n- ${disclaimer}\n`))],
    ["disclaimer only in blockquote", "SYNTHETIC_DISCLAIMER_REQUIRED", async (fx) => replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Bad\ntype: concept\n---\n\n> ${disclaimer}\n`))],
  ]
  for (const [name, expectedCode, mutate] of cases) await t.test(name, async (t) => {
    const fx = await fixture("tracer-negative-")
    t.after(() => rm(fx.root, { recursive: true, force: true }))
    await mutate(fx)
    const before = await snapshot(fx.root)
    const result = invoke(fx, "preflight")
    assert.equal(result.status, 1, name)
    const failure = oneJson(result)
    assert.equal(failure.ok, false)
    if (expectedCode) assert.equal(failure.error.code, expectedCode)
    await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
    assert.deepEqual(await snapshot(fx.root), before)
    assert.equal((await readdir(fx.paths.work)).length, 0)
  })
})

test("T03 source permits ordinary less-than text but rejects every raw HTML tag family with zero writes", async (t) => {
  const accepted = await fixture("tracer-less-than-")
  t.after(() => rm(accepted.root, { recursive: true, force: true }))
  await replaceSource(accepted, "synthetic-support", Buffer.from(`---\ntitle: Safe comparison\ntype: concept\n---\n\n${disclaimer}\n\nA score < 3 is ordinary text.\n`))
  const acceptedBefore = await snapshot(accepted.root)
  const acceptedResult = invoke(accepted, "preflight")
  assert.equal(acceptedResult.status, 0, acceptedResult.stdout)
  assert.deepEqual(await snapshot(accepted.root), acceptedBefore)

  for (const [name, rawHtml] of [
    ["comment", "<!-- hidden -->"],
    ["object", "<object data=x>fallback</object>"],
    ["form", "<form action=x>unsafe</form>"],
    ["meta", "<meta http-equiv=refresh content=x>"],
    ["style", "<style>body{display:none}</style>"],
    ["slash-separated tag payload", "<svg/onload=alert(1)>"],
    ["namespaced tag", "<svg:foreignObject>unsafe</svg:foreignObject>"],
  ]) await t.test(name, async (t) => {
    const fx = await fixture("tracer-raw-html-")
    t.after(() => rm(fx.root, { recursive: true, force: true }))
    await replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Raw HTML\ntype: concept\n---\n\n${disclaimer}\n\n${rawHtml}\n`))
    const before = await snapshot(fx.root)
    const result = invoke(fx, "preflight")
    assert.equal(result.status, 1)
    assert.equal(oneJson(result).error.code, "SOURCE_ACTIVE_CONTENT_NOT_ALLOWED")
    assert.deepEqual(await snapshot(fx.root), before)
    await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
    assert.equal((await readdir(fx.paths.work)).length, 0)
  })
})

test("T03 candidate gate rejects lowercase mixed-separator Windows paths and cleans work", async (t) => {
  const fx = await fixture("tracer-windows-disclosure-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  await replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Synthetic Support\ntype: concept\n---\n\n${disclaimer}\n\nLocal path: c:\\users\\arke\\private\n`))
  const result = invoke(fx, "build")
  assert.equal(result.status, 1, result.stdout)
  assert.equal(oneJson(result).error.code, "CANDIDATE_ABSOLUTE_PATH_DISCLOSURE")
  await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
  assert.equal((await readdir(fx.paths.work)).length, 0)
})

test("T03 rejects wrong receipt location, root junctions, overlaps, and existing output sentinel", async (t) => {
  const fx = await fixture("tracer-paths-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const copied = path.join(fx.paths.context, "export-receipt.json")
  await writeFile(copied, JSON.stringify(fx.receipt))
  let result = invoke(fx, "preflight", { exportReceipt: copied })
  assert.equal(result.status, 1)
  const receiptFailure = oneJson(result)
  assert.equal(receiptFailure.error.code, "EXPORT_RECEIPT_LOCATION_INVALID")
  assert.equal(containsText(receiptFailure, fx.root), false)

  result = invoke(fx, "preflight", { output: path.join(fx.paths.vault, "site") })
  assert.equal(result.status, 1)
  assert.equal(oneJson(result).error.code, "PATH_OVERLAP_NOT_ALLOWED")

  await writeFile(fx.output, "last-known-good")
  result = invoke(fx, "build")
  assert.equal(result.status, 1)
  assert.equal(oneJson(result).error.code, "OUTPUT_ALREADY_EXISTS")
  assert.equal(await readFile(fx.output, "utf8"), "last-known-good")

  const target = path.join(fx.root, "junction-target")
  const alias = path.join(fx.root, "junction-work")
  await mkdir(target)
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir")
  result = invoke(fx, "preflight", { workRoot: alias, output: path.join(fx.root, "fresh-output") })
  assert.equal(result.status, 1)
  assert.equal(oneJson(result).error.code, "PATH_SYMLINK_NOT_ALLOWED")
})

test("T03 candidate-gate failure cleans its exclusive work run and never creates output", async (t) => {
  const fx = await fixture("tracer-gate-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const result = invoke(fx, "build", {}, { TYLER_TRACER_TEST_GATE_FAILURE: "1" })
  assert.equal(result.status, 1, result.stdout)
  assert.equal(oneJson(result).error.code, "CANDIDATE_GATE_FAILED")
  await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
  assert.equal((await readdir(fx.paths.work)).length, 0)
})

test("T03 candidate disclaimer must remain an actual visible paragraph", async (t) => {
  const fx = await fixture("tracer-candidate-disclaimer-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const protectedBefore = Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault"].map(async (role) => [role, await snapshot(fx.paths[role])])))
  const result = invoke(fx, "build", {}, { TYLER_TRACER_TEST_CANDIDATE_CASE: "disclaimer-template" })
  assert.equal(result.status, 1, result.stdout)
  assert.equal(oneJson(result).error.code, "CANDIDATE_DISCLAIMER_MISSING")
  await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
  assert.equal((await readdir(fx.paths.work)).length, 0)
  const protectedAfter = Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault"].map(async (role) => [role, await snapshot(fx.paths[role])])))
  assert.deepEqual(protectedAfter, protectedBefore)
})

test("T03 never prunes arbitrary extra HTML before the exact route gate", async (t) => {
  const fx = await fixture("tracer-extra-html-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const result = invoke(fx, "build", {}, { TYLER_TRACER_TEST_EXTRA_HTML: "1" })
  assert.equal(result.status, 1, result.stdout)
  assert.equal(oneJson(result).error.code, "CANDIDATE_ROUTE_SET_INVALID")
  await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
  assert.equal((await readdir(fx.paths.work)).length, 0)
})

test("T03 post-Quartz immutable manifest and candidate root tamper gates fail closed", async (t) => {
  const cases = [
    ["route-derived virtual parent overwrite", "virtual-parent-tamper", "CANDIDATE_VIRTUAL_PAGE_TAMPERED"],
    ["unexpected non-HTML asset", "unexpected-asset", "CANDIDATE_FILE_MANIFEST_MISMATCH"],
    ["candidate root replaced by an in-run junction", "candidate-root-junction", "CANDIDATE_ROOT_INVALID"],
  ]
  for (const [name, variant, expectedCode] of cases) await t.test(name, async (t) => {
    const fx = await fixture("tracer-candidate-integrity-")
    t.after(() => rm(fx.root, { recursive: true, force: true }))
    const protectedBefore = Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault"].map(async (role) => [role, await snapshot(fx.paths[role])])))
    const result = invoke(fx, "build", {}, { TYLER_TRACER_TEST_CANDIDATE_CASE: variant })
    assert.equal(result.status, 1, `${name}: ${result.stdout}`)
    const failure = oneJson(result)
    assert.deepEqual(Object.keys(failure.error).sort(), ["code", "message"])
    assert.equal(failure.error.code, expectedCode)
    await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
    assert.equal((await readdir(fx.paths.work)).length, 0)
    const protectedAfter = Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault"].map(async (role) => [role, await snapshot(fx.paths[role])])))
    assert.deepEqual(protectedAfter, protectedBefore)
  })
})

test("T03 candidate URL-bearing attributes, active HTML, and CSS URLs are gated at the public CLI", async (t) => {
  const cases = [
    ["inline event attribute", "event-attribute", "CANDIDATE_EVENT_ATTRIBUTE"],
    ["poster private target", "poster-private", "CANDIDATE_ASSET_MISSING"],
    ["srcset missing baseline asset", "srcset-missing", "CANDIDATE_ASSET_MISSING"],
    ["form action and formaction private routes", "form-action-private", "CANDIDATE_UNAPPROVED_LINK"],
    ["object data private target", "object-data-private", "CANDIDATE_ASSET_MISSING"],
    ["meta refresh", "meta-refresh", "CANDIDATE_META_REFRESH"],
    ["inline CSS missing baseline asset", "css-url-missing", "CANDIDATE_ASSET_MISSING"],
    ["unsafe attribute scheme", "unsafe-attribute-scheme", "CANDIDATE_UNSAFE_SCHEME"],
  ]
  for (const [name, variant, expectedCode] of cases) await t.test(name, async (t) => {
    const fx = await fixture("tracer-candidate-url-")
    t.after(() => rm(fx.root, { recursive: true, force: true }))
    const result = invoke(fx, "build", {}, { TYLER_TRACER_TEST_CANDIDATE_CASE: variant })
    assert.equal(result.status, 1, `${name}: ${result.stdout}`)
    const failure = oneJson(result)
    assert.deepEqual(Object.keys(failure.error).sort(), ["code", "message"])
    assert.equal(failure.error.code, expectedCode)
    await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
    assert.equal((await readdir(fx.paths.work)).length, 0)
  })
})

test("T03 test hooks require the explicit regression capability", async (t) => {
  const fx = await fixture("tracer-test-capability-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const result = invoke(fx, "preflight", {}, {
    TYLER_TRACER_TEST_CAPABILITY: "not-authorized",
    TYLER_TRACER_TEST_DISCLOSURE_ERROR: fx.root,
  })
  assert.equal(result.status, 0, result.stdout)
  assert.equal(oneJson(result).ok, true)
  await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
  assert.equal((await readdir(fx.paths.work)).length, 0)
})
