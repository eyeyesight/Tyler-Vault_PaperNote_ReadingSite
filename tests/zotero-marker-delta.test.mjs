// @ts-nocheck -- public CLI regression builds dynamic sealed publication fixtures.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

import {
  computePlanDigest,
  computePublicSetDigest,
  jcsCanonicalize,
  readContractJson,
} from "../lib/publication-contracts.mjs"
import { parseZoteroManagedBlock } from "../lib/zotero-delta.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const fixtureRoot = path.join(repoRoot, "tests", "fixtures", "zotero-delta")
const now = "2026-07-29T00:00:00Z"
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const supportPath = "Knowledge/Concepts/existing-support.md"
const paperPath = "Literature/Notes/synthetic-delta-paper.md"
const supportBytes = Buffer.from("---\ntitle: Existing Support\ntype: concept\n---\n\n# Existing Support\n\nSYNTHETIC FIXTURE — NOT RESEARCH EVIDENCE.\n")

function sealManifest(manifest) {
  manifest.public_set_digest = computePublicSetDigest(manifest.nodes)
  manifest.plan_digest = computePlanDigest(manifest)
  manifest.approval_receipt.approved_plan_digest = manifest.plan_digest
}

async function snapshotTree(root) {
  const rows = []
  async function walk(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join("/")
      const metadata = await lstat(absolute)
      if (metadata.isDirectory()) { rows.push([relative, "directory"]); await walk(absolute) }
      else if (metadata.isFile()) rows.push([relative, "regular-file", (await readFile(absolute)).toString("hex")])
      else rows.push([relative, "other"])
    }
  }
  await walk(root)
  return rows
}

async function writeSource(root, relative, bytes) {
  const absolute = path.join(root, ...relative.split("/"))
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, bytes)
}

function invokeRelease(fixture, extraEnv = {}) {
  return spawnSync("npm", ["run", "--silent", "tracer:release", "--",
    "--manifest", fixture.manifestPath,
    "--export-receipt", fixture.exportReceiptPath,
    "--runtime-root", fixture.paths.runtime,
    "--export-root", fixture.paths.export,
    "--vault-root", fixture.paths.vault,
    "--work-root", fixture.paths.work,
    "--releases-root", fixture.paths.releases,
    "--now", now,
  ], { cwd: repoRoot, encoding: "utf8", timeout: 180_000, shell: process.platform === "win32", env: { ...process.env, ...extraEnv } })
}

async function writeAction(fixture, manifest) {
  sealManifest(manifest)
  const exportReceipt = {
    schema_version: 1,
    manifest_id: manifest.manifest_id,
    plan_digest: manifest.plan_digest,
    exported_at: new Date(Date.parse(manifest.created_at) + 60_000).toISOString().replace(".000Z", "Z"),
    drive_readback: "verified",
    files: manifest.nodes.map(({ path: sourcePath, source_sha256 }) => ({ path: sourcePath, source_sha256 })),
  }
  await writeFile(fixture.manifestPath, JSON.stringify(manifest))
  await writeFile(fixture.exportReceiptPath, JSON.stringify(exportReceipt))
  fixture.manifest = manifest
}

async function createPublishedFixture(t, ending = "lf") {
  const root = await mkdtemp(path.join(os.tmpdir(), `zotero-delta-${ending}-`))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = Object.fromEntries(["context", "runtime", "export", "vault", "work", "releases"].map((name) => [name, path.join(root, name)]))
  await Promise.all(Object.values(paths).map((directory) => mkdir(directory)))
  await writeFile(path.join(paths.vault, "do-not-touch.md"), "canonical sentinel\n")
  const beforeBytes = await readFile(path.join(fixtureRoot, `paper-before-${ending}.md`))
  await writeSource(paths.export, supportPath, supportBytes)
  await writeSource(paths.export, paperPath, beforeBytes)
  const nodes = [
    { public_id: "existing-support", path: supportPath, node_class: "concept", source_sha256: sha256(supportBytes) },
    { public_id: "synthetic-delta-paper", path: paperPath, node_class: "paper", source_sha256: sha256(beforeBytes) },
  ]
  const fixture = {
    root, paths, beforeBytes,
    manifestPath: path.join(paths.context, "manifest.json"),
    exportReceiptPath: path.join(paths.export, "export-receipt.json"),
  }
  await writeAction(fixture, {
    schema_version: 1,
    manifest_id: `VPUB-20260728-delta-${ending}`,
    created_at: "2026-07-28T00:00:00Z",
    expires_at: "2026-07-30T00:00:00Z",
    action: {
      kind: "publish-unit", baseline: { kind: "genesis" }, primary_id: "synthetic-delta-paper",
      support_ids: ["existing-support"], added_node_ids: ["existing-support", "synthetic-delta-paper"],
      direct_connection_edges: [{ source: "synthetic-delta-paper", target: "existing-support" }],
    },
    nodes, public_set_digest: "0".repeat(64),
    approval_receipt: { approver: "tyler", channel: "telegram", source_event_id: `delta-${ending}-initial`, approved_plan_digest: "0".repeat(64), approved_at: "2026-07-28T00:01:00Z" },
    plan_digest: "0".repeat(64),
  })
  const initial = invokeRelease(fixture)
  assert.equal(initial.status, 0, initial.stdout)
  assert.equal(initial.stderr, "")
  const initialOutput = JSON.parse(initial.stdout)
  const pointerPath = path.join(paths.runtime, "current-release.json")
  const pointer = await readContractJson(pointerPath)
  const receipt = await readContractJson(path.join(paths.runtime, ...pointer.receipt_path.split("/")))
  return { ...fixture, initialOutput, pointerPath, pointer, receipt }
}

async function installRefreshAction(fixture, targetBytes, suffix = "refresh") {
  await writeSource(fixture.paths.export, paperPath, targetBytes)
  const nodes = fixture.receipt.nodes.map(({ public_id, path: sourcePath, node_class, source_sha256 }) => ({
    public_id, path: sourcePath, node_class,
    source_sha256: public_id === "synthetic-delta-paper" ? sha256(targetBytes) : source_sha256,
  }))
  await writeAction(fixture, {
    schema_version: 1,
    manifest_id: `VPUB-20260729-${suffix}`,
    created_at: "2026-07-28T12:00:00Z",
    expires_at: "2026-07-30T00:00:00Z",
    action: {
      kind: "zotero-refresh", target_id: "synthetic-delta-paper",
      baseline_release_digest: fixture.pointer.release_digest,
      baseline_receipt_path: fixture.pointer.receipt_path,
    },
    nodes, public_set_digest: fixture.receipt.public_set_digest,
    approval_receipt: { approver: "tyler", channel: "telegram", source_event_id: suffix, approved_plan_digest: "0".repeat(64), approved_at: "2026-07-28T12:01:00Z" },
    plan_digest: "0".repeat(64),
  })
}

function artifactMap(receipt) {
  return new Map(receipt.artifacts.map((artifact) => [artifact.path, artifact.sha256]))
}

test("T07 raw-byte parser accepts exact LF/CRLF and literal empty five-region boundaries", async () => {
  const literals = JSON.parse(await readFile(path.join(fixtureRoot, "literal-hashes.json"), "utf8"))
  for (const ending of ["lf", "crlf"]) {
    const filename = `paper-before-${ending}.md`
    const parsed = parseZoteroManagedBlock(await readFile(path.join(fixtureRoot, filename)))
    const { source_sha256: expectedSource, managed_content_sha256: expectedManaged, ...expectedMetadata } = literals[filename]
    assert.equal(parsed.source_sha256, expectedSource)
    assert.equal(parsed.managed_content_sha256, expectedManaged)
    assert.deepEqual(parsed.metadata, expectedMetadata)
  }
  const empty = parseZoteroManagedBlock(Buffer.from("<!-- zotero-annotations:start -->\n<!-- zotero-annotations:end -->\n"))
  assert.equal(empty.prefix.length, 0)
  assert.equal(empty.managed_content.length, 0)
  assert.equal(empty.suffix.length, 0)
})

test("T07 raw-byte parser fails closed on malformed encoding, EOL, count, order, nesting, closure, and marker lines", () => {
  const valid = Buffer.from("prefix\n<!-- zotero-annotations:start -->\ncontent\n<!-- zotero-annotations:end -->\nsuffix\n")
  const cases = [
    ["missing", Buffer.from("prefix\ncontent\n"), "ZOTERO_MARKER_COUNT_INVALID"],
    ["duplicate", Buffer.from("<!-- zotero-annotations:start -->\n<!-- zotero-annotations:start -->\n<!-- zotero-annotations:end -->\n"), "ZOTERO_MARKER_COUNT_INVALID"],
    ["nested", Buffer.from("<!-- zotero-annotations:start -->\n<!-- zotero-annotations:start -->\n<!-- zotero-annotations:end -->\n<!-- zotero-annotations:end -->\n"), "ZOTERO_MARKER_COUNT_INVALID"],
    ["reversed", Buffer.from("<!-- zotero-annotations:end -->\n<!-- zotero-annotations:start -->\n"), "ZOTERO_MARKER_ORDER_INVALID"],
    ["unclosed", Buffer.from("<!-- zotero-annotations:start -->\ncontent\n"), "ZOTERO_MARKER_COUNT_INVALID"],
    ["mixed EOL", Buffer.from("prefix\r\n<!-- zotero-annotations:start -->\ncontent\n<!-- zotero-annotations:end -->\nsuffix\n"), "ZOTERO_EOL_INVALID"],
    ["bare CR", Buffer.from("prefix\r<!-- zotero-annotations:start -->\n<!-- zotero-annotations:end -->\n"), "ZOTERO_EOL_INVALID"],
    ["BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]), "ZOTERO_BOM_NOT_ALLOWED"],
    ["invalid UTF-8", Buffer.concat([valid.subarray(0, 10), Buffer.from([0xff]), valid.subarray(10)]), "ZOTERO_INVALID_UTF8"],
    ["inline marker", Buffer.from("prefix <!-- zotero-annotations:start -->\ncontent\n<!-- zotero-annotations:end -->\n"), "ZOTERO_MARKER_LINE_INVALID"],
    ["marker line drift", Buffer.from("<!-- zotero-annotations:start --> \ncontent\n<!-- zotero-annotations:end -->\n"), "ZOTERO_MARKER_LINE_INVALID"],
    ["marker EOL drift", Buffer.from("<!-- zotero-annotations:start -->content\n<!-- zotero-annotations:end -->\n"), "ZOTERO_MARKER_LINE_INVALID"],
  ]
  for (const [label, bytes, code] of cases) {
    assert.throws(() => parseZoteroManagedBlock(bytes), (error) => error?.code === code, label)
  }
})

test("T07 public tracer emits one redacted failure object and mutates no role root for invalid raw-byte deltas", async (t) => {
  const fixture = await createPublishedFixture(t, "lf")
  const source = fixture.beforeBytes
  const text = source.toString("utf8")
  const startLine = "<!-- zotero-annotations:start -->\n"
  const endLine = "<!-- zotero-annotations:end -->\n"
  const cases = [
    ["missing-marker", Buffer.from(text.replace(startLine, "")), "ZOTERO_MARKER_COUNT_INVALID"],
    ["duplicate-marker", Buffer.from(text.replace(startLine, startLine + startLine)), "ZOTERO_MARKER_COUNT_INVALID"],
    ["nested-marker", Buffer.from(text.replace(startLine, startLine + startLine).replace(endLine, endLine + endLine)), "ZOTERO_MARKER_COUNT_INVALID"],
    ["reversed-marker", Buffer.from(text.replace(`${startLine}- Prior annotation.\n${endLine}`, `${endLine}- Prior annotation.\n${startLine}`)), "ZOTERO_MARKER_ORDER_INVALID"],
    ["unclosed-marker", Buffer.from(text.replace(endLine, "")), "ZOTERO_MARKER_COUNT_INVALID"],
    ["mixed-eol", Buffer.from(text.replace("---\n", "---\r\n")), "ZOTERO_EOL_INVALID"],
    ["bom", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), source]), "ZOTERO_BOM_NOT_ALLOWED"],
    ["invalid-utf8", Buffer.concat([source.subarray(0, 80), Buffer.from([0xff]), source.subarray(80)]), "ZOTERO_INVALID_UTF8"],
    ["marker-line-drift", Buffer.from(text.replace("<!-- zotero-annotations:start -->\n", "<!-- zotero-annotations:start --> \n")), "ZOTERO_MARKER_LINE_INVALID"],
    ["prefix-byte-drift", Buffer.from(text.replace("Synthetic Delta Paper\n", "Synthetic Delta Paper!\n")), "ZOTERO_IMMUTABLE_REGION_CHANGED"],
    ["suffix-byte-drift", Buffer.from(text.replace("Synthetic fixture body.\n", "Synthetic fixture body!\n")), "ZOTERO_IMMUTABLE_REGION_CHANGED"],
  ]
  for (const [label, bytes, expectedCode] of cases) {
    await installRefreshAction(fixture, bytes, `invalid-${label}`)
    const before = Object.fromEntries(await Promise.all(["runtime", "releases", "vault", "work", "export"].map(async (role) => [role, await snapshotTree(fixture.paths[role])])))
    const result = invokeRelease(fixture)
    assert.equal(result.status, 1, `${label}: ${result.stdout}`)
    assert.equal(result.stderr, "", label)
    assert.equal(result.stdout.trim().split(/\r?\n/).length, 1, label)
    const output = JSON.parse(result.stdout)
    assert.equal(output.ok, false, label)
    assert.deepEqual(Object.keys(output), ["ok", "error"], label)
    assert.deepEqual(Object.keys(output.error), ["code", "message"], label)
    assert.equal(output.error.code, expectedCode, label)
    assert.equal(/(?:[A-Z]:\\|\/Users\/|\/workspace\/|token|secret)/i.test(output.error.message), false, label)
    for (const role of Object.keys(before)) assert.deepEqual(await snapshotTree(fixture.paths[role]), before[role], `${label}:${role}`)
  }
})

test("T07 public artifact gate rejects a non-target artifact mutation before promotion", async (t) => {
  const fixture = await createPublishedFixture(t, "lf")
  const afterBytes = await readFile(path.join(fixtureRoot, "paper-after-lf.md"))
  await installRefreshAction(fixture, afterBytes, "invalid-artifact-delta")
  const before = Object.fromEntries(await Promise.all(["runtime", "releases", "vault", "work", "export"].map(async (role) => [role, await snapshotTree(fixture.paths[role])])))
  const result = invokeRelease(fixture, {
    TYLER_RELEASE_TEST_CAPABILITY: "t06-regression-v1",
    TYLER_RELEASE_TEST_CASE: "zotero-non-target-artifact-tamper",
  })
  assert.equal(result.status, 1, result.stdout)
  assert.equal(result.stderr, "")
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    error: { code: "ZOTERO_ARTIFACT_DELTA_INVALID", message: "Zotero refresh may change only the target paper page artifact" },
  })
  for (const role of Object.keys(before)) assert.deepEqual(await snapshotTree(fixture.paths[role]), before[role], role)
})

test("T07 CRLF marker-only refresh preserves raw CRLF boundaries through the public release seam", async (t) => {
  const fixture = await createPublishedFixture(t, "crlf")
  const afterBytes = await readFile(path.join(fixtureRoot, "paper-after-crlf.md"))
  await installRefreshAction(fixture, afterBytes, "delta-crlf-refresh")
  const result = invokeRelease(fixture)
  assert.equal(result.status, 0, result.stdout)
  assert.equal(result.stderr, "")
  const output = JSON.parse(result.stdout)
  assert.equal(output.outcome, "promoted")
  const current = await readContractJson(fixture.pointerPath)
  const receipt = await readContractJson(path.join(fixture.paths.runtime, ...current.receipt_path.split("/")))
  const beforeArtifacts = artifactMap(fixture.receipt)
  assert.deepEqual(receipt.artifacts.filter((artifact) => beforeArtifacts.get(artifact.path) !== artifact.sha256).map((artifact) => artifact.path), ["papers/synthetic-delta-paper/index.html"])
  const literals = JSON.parse(await readFile(path.join(fixtureRoot, "literal-hashes.json"), "utf8"))
  const parsed = parseZoteroManagedBlock(afterBytes)
  assert.equal(parsed.metadata.line_ending, "CRLF")
  assert.equal(parsed.managed_content_sha256, literals["paper-after-crlf.md"].managed_content_sha256)
})

test("T07 LF marker-only refresh promotes a release whose only changed artifact is the target paper page", async (t) => {
  const fixture = await createPublishedFixture(t, "lf")
  const literals = JSON.parse(await readFile(path.join(fixtureRoot, "literal-hashes.json"), "utf8"))
  const targetBaseline = fixture.receipt.nodes.find((node) => node.public_id === "synthetic-delta-paper")
  const { managed_content_sha256: ignored, source_sha256: ignoredSource, ...expectedBaseline } = literals["paper-before-lf.md"]
  assert.deepEqual(targetBaseline.zotero_baseline, expectedBaseline)

  const beforeVault = await snapshotTree(fixture.paths.vault)
  const beforeExport = await snapshotTree(fixture.paths.export)
  const afterBytes = await readFile(path.join(fixtureRoot, "paper-after-lf.md"))
  await installRefreshAction(fixture, afterBytes, "delta-lf-refresh")
  const refreshedExport = await snapshotTree(fixture.paths.export)
  assert.notDeepEqual(refreshedExport, beforeExport)

  const result = invokeRelease(fixture)
  assert.equal(result.status, 0, result.stdout)
  assert.equal(result.stderr, "")
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1)
  const output = JSON.parse(result.stdout)
  assert.equal(output.ok, true)
  assert.equal(output.command, "release")
  assert.equal(output.outcome, "promoted")
  assert.notEqual(output.releaseDigest, fixture.pointer.release_digest)

  const current = await readContractJson(fixture.pointerPath)
  const refreshedReceipt = await readContractJson(path.join(fixture.paths.runtime, ...current.receipt_path.split("/")))
  const beforeArtifacts = artifactMap(fixture.receipt)
  const afterArtifacts = artifactMap(refreshedReceipt)
  assert.deepEqual([...afterArtifacts.keys()], [...beforeArtifacts.keys()])
  const changed = [...afterArtifacts].filter(([artifactPath, digest]) => beforeArtifacts.get(artifactPath) !== digest).map(([artifactPath]) => artifactPath)
  assert.deepEqual(changed, ["papers/synthetic-delta-paper/index.html"])
  for (const immutable of ["graph.json", "index.html", "search-index.json", "static/contentIndex.json"]) {
    assert.equal(afterArtifacts.get(immutable), beforeArtifacts.get(immutable), immutable)
  }
  assert.equal(refreshedReceipt.nodes.find((node) => node.public_id === "synthetic-delta-paper").source_sha256, literals["paper-after-lf.md"].source_sha256)
  assert.equal(refreshedReceipt.artifacts.some((artifact) => /release-receipt\.json$/i.test(artifact.path)), false)
  assert.deepEqual(await snapshotTree(fixture.paths.vault), beforeVault)
  assert.deepEqual(await snapshotTree(fixture.paths.export), refreshedExport)

  // The prior receipt remains sealed and standalone-valid, but current pointer
  // authority makes it stale and therefore unusable as a refresh baseline.
  await installRefreshAction(fixture, afterBytes, "stale-consumed-baseline")
  const beforeStale = Object.fromEntries(await Promise.all(["runtime", "releases", "vault", "work", "export"].map(async (role) => [role, await snapshotTree(fixture.paths[role])])))
  const stale = invokeRelease(fixture)
  assert.equal(stale.status, 1)
  assert.equal(stale.stderr, "")
  assert.equal(stale.stdout.trim().split(/\r?\n/).length, 1)
  assert.deepEqual(JSON.parse(stale.stdout), { ok: false, error: { code: "STALE_BASELINE", message: "action baseline does not equal the validated current release" } })
  for (const role of Object.keys(beforeStale)) assert.deepEqual(await snapshotTree(fixture.paths[role]), beforeStale[role], role)

  // A fresh, exact no-change export is acknowledged without building, sealing,
  // promoting, advancing the pointer, or writing any role root.
  fixture.pointer = current
  fixture.receipt = refreshedReceipt
  await installRefreshAction(fixture, afterBytes, "no-change-current-baseline")
  const beforeNoChange = Object.fromEntries(await Promise.all(["runtime", "releases", "vault", "work", "export"].map(async (role) => [role, await snapshotTree(fixture.paths[role])])))
  const noChange = invokeRelease(fixture)
  assert.equal(noChange.status, 0, noChange.stdout)
  assert.equal(noChange.stderr, "")
  assert.equal(noChange.stdout.trim().split(/\r?\n/).length, 1)
  assert.deepEqual(JSON.parse(noChange.stdout), {
    ok: true,
    command: "release",
    outcome: "no-change",
    manifestId: "VPUB-20260729-no-change-current-baseline",
    releaseDigest: current.release_digest,
    receiptPath: current.receipt_path,
    routes: ["/", "/knowledge/concept/existing-support/", "/papers/synthetic-delta-paper/"],
    files: refreshedReceipt.artifacts.length,
  })
  for (const role of Object.keys(beforeNoChange)) assert.deepEqual(await snapshotTree(fixture.paths[role]), beforeNoChange[role], role)
})
