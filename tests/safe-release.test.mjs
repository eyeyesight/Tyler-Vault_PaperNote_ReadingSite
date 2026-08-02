// @ts-nocheck -- public CLI test intentionally assembles dynamic contract fixtures.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

import {
  computePlanDigest,
  computePublicSetDigest,
  jcsCanonicalize,
  readContractJson,
  sha256Jcs,
  validateContract,
  validateCurrentReleaseCandidate,
  validateReleaseAgainstManifest,
} from "../lib/publication-contracts.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const npm = "npm"
const now = "2026-07-29T00:00:00Z"
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

function sealManifest(manifest) {
  manifest.public_set_digest = computePublicSetDigest(manifest.nodes)
  manifest.plan_digest = computePlanDigest(manifest)
  manifest.approval_receipt.approved_plan_digest = manifest.plan_digest
}

function sealRelease(receipt) {
  receipt.public_set_digest = computePublicSetDigest(receipt.nodes)
  const unsigned = structuredClone(receipt)
  delete unsigned.release_digest
  receipt.release_digest = sha256Jcs(unsigned)
}

async function exactSnapshot(root) {
  const rows = []
  async function walk(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join("/")
      const metadata = await lstat(absolute)
      if (metadata.isDirectory()) {
        rows.push([relative, "directory"])
        await walk(absolute)
      } else if (metadata.isFile()) rows.push([relative, "regular-file", (await readFile(absolute)).toString("hex")])
      else rows.push([relative, "other"])
    }
  }
  await walk(root)
  return rows
}

async function sourceByteAndMtimeSnapshot(fixture) {
  return Promise.all(fixture.manifest.nodes.map(async (node) => {
    const absolute = path.join(fixture.paths.export, ...node.path.split("/"))
    const metadata = await lstat(absolute, { bigint: true })
    return [node.path, (await readFile(absolute)).toString("hex"), metadata.mtimeNs.toString()]
  }))
}

async function releaseFixture(expiresAt = now, genesis = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "safe-release-"))
  const paths = Object.fromEntries(["context", "runtime", "export", "vault", "work", "releases"].map((name) => [name, path.join(root, name)]))
  await Promise.all(Object.values(paths).map((directory) => mkdir(directory)))
  await writeFile(path.join(paths.vault, "do-not-touch.md"), "canonical sentinel\n")
  await writeFile(path.join(paths.work, "work-sentinel.txt"), "work sentinel\n")

  const existingPath = "Knowledge/Concepts/existing-support.md"
  const historicalPaperPath = "Literature/Notes/historical-paper.md"
  const paperPath = "Literature/Notes/synthetic-paper.md"
  const existingBytes = Buffer.from("---\ntitle: Existing Support\ntype: concept\n---\n\n# Existing Support\n\nSYNTHETIC FIXTURE — NOT RESEARCH EVIDENCE.\n")
  const paperBytes = Buffer.from("---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n# Synthetic Paper\n\nSYNTHETIC FIXTURE — NOT RESEARCH EVIDENCE.\n\n## Bibliography\n\nSynthetic fixture bibliography.\n\n## One-sentence Takeaway\n\nSynthetic fixture takeaway.\n\n## Research Question\n\nSynthetic fixture question.\n\n## Citation\n\nSynthetic fixture citation.\n\n## Zotero Annotations\n\nSynthetic fixture annotation.\n\n## Body\n\nSynthetic fixture body.\n\n## Connections\n\n- [[Knowledge/Concepts/existing-support]]\n")
  const historicalPaperBytes = Buffer.from(paperBytes.toString("utf8").replaceAll("Synthetic Paper", "Historical Paper"))
  const sourceEntries = genesis
    ? [[existingPath, existingBytes], [paperPath, paperBytes]]
    : [[existingPath, existingBytes], [historicalPaperPath, historicalPaperBytes], [paperPath, paperBytes]]
  for (const [relative, bytes] of sourceEntries) {
    const absolute = path.join(paths.export, ...relative.split("/"))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, bytes)
  }

  const baselineNode = { public_id: "existing-support", path: existingPath, node_class: "concept", source_sha256: sha256(existingBytes) }
  const historicalPaperNode = { public_id: "historical-paper", path: historicalPaperPath, node_class: "paper", source_sha256: sha256(historicalPaperBytes) }
  const baselineManifest = {
    schema_version: 1,
    manifest_id: "VPUB-20260728-existing",
    created_at: "2026-07-28T00:00:00Z",
    expires_at: "2026-07-29T00:00:00Z",
    action: {
      kind: "publish-unit",
      baseline: { kind: "genesis" },
      primary_id: "historical-paper",
      support_ids: ["existing-support"],
      added_node_ids: ["existing-support", "historical-paper"],
      direct_connection_edges: [{ source: "historical-paper", target: "existing-support" }],
    },
    nodes: [baselineNode, historicalPaperNode],
    public_set_digest: "0".repeat(64),
    approval_receipt: { approver: "tyler", channel: "telegram", source_event_id: "historical-release-test", approved_plan_digest: "0".repeat(64), approved_at: "2026-07-28T00:01:00Z" },
    plan_digest: "0".repeat(64),
  }
  sealManifest(baselineManifest)
  const baselineManifestRaw = Buffer.from(`${JSON.stringify(baselineManifest, null, 2)}\n`, "utf8")
  const baselineReceipt = {
    schema_version: 1,
    release_digest: "0".repeat(64),
    manifest_id: baselineManifest.manifest_id,
    plan_digest: baselineManifest.plan_digest,
    public_set_digest: "0".repeat(64),
    created_at: "2026-07-28T12:00:00Z",
    nodes: [baselineNode, historicalPaperNode],
    artifacts: [{ path: "index.html", sha256: sha256(Buffer.from("last known good\n")) }],
    content_fingerprints: [
      { public_id: "existing-support", route: "/knowledge/concept/existing-support/", sha256: "b".repeat(64) },
      { public_id: "historical-paper", route: "/papers/historical-paper/", sha256: "c".repeat(64) },
    ],
  }
  sealRelease(baselineReceipt)
  const receiptPath = `consumed/${baselineReceipt.manifest_id}/release-receipt.json`
  const lkgRoot = path.join(paths.releases, baselineReceipt.release_digest)
  if (!genesis) {
    const custody = path.join(paths.runtime, "consumed", baselineReceipt.manifest_id)
    await mkdir(custody, { recursive: true })
    await writeFile(path.join(custody, "manifest.json"), baselineManifestRaw)
    await writeFile(path.join(custody, "release-receipt.json"), `${jcsCanonicalize(baselineReceipt)}\n`)
    await writeFile(path.join(paths.runtime, "current-release.json"), `${jcsCanonicalize({ schema_version: 1, release_digest: baselineReceipt.release_digest, receipt_path: receiptPath })}\n`)
    await mkdir(lkgRoot)
    await writeFile(path.join(lkgRoot, "index.html"), "last known good\n")
  }

  const manifest = {
    schema_version: 1,
    manifest_id: "VPUB-20260729-expired-release",
    created_at: "2026-07-28T00:00:00Z",
    expires_at: expiresAt,
    action: {
      kind: "publish-unit",
      baseline: genesis ? { kind: "genesis" } : { kind: "release", release_digest: baselineReceipt.release_digest, receipt_path: receiptPath },
      primary_id: "synthetic-paper",
      support_ids: ["existing-support"],
      added_node_ids: genesis ? ["existing-support", "synthetic-paper"] : ["synthetic-paper"],
      direct_connection_edges: [{ source: "synthetic-paper", target: "existing-support" }],
    },
    nodes: [
      baselineNode,
      ...(!genesis ? [historicalPaperNode] : []),
      { public_id: "synthetic-paper", path: paperPath, node_class: "paper", source_sha256: sha256(paperBytes) },
    ],
    public_set_digest: "0".repeat(64),
    approval_receipt: { approver: "tyler", channel: "telegram", source_event_id: "expired-release-test", approved_plan_digest: "0".repeat(64), approved_at: "2026-07-28T00:01:00Z" },
    plan_digest: "0".repeat(64),
  }
  sealManifest(manifest)
  const exportReceipt = {
    schema_version: 1,
    manifest_id: manifest.manifest_id,
    plan_digest: manifest.plan_digest,
    exported_at: "2026-07-28T00:02:00Z",
    drive_readback: "verified",
    files: manifest.nodes.map(({ path: filePath, source_sha256 }) => ({ path: filePath, source_sha256 })),
  }
  const manifestPath = path.join(paths.context, "manifest.json")
  const exportReceiptPath = path.join(paths.export, "export-receipt.json")
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(exportReceiptPath, JSON.stringify(exportReceipt))
  return { root, paths, manifest, exportReceipt, manifestPath, exportReceiptPath }
}

async function replaceFixtureSource(fixture, publicId, bytes) {
  const node = fixture.manifest.nodes.find((candidate) => candidate.public_id === publicId)
  const absolute = path.join(fixture.paths.export, ...node.path.split("/"))
  await writeFile(absolute, bytes)
  node.source_sha256 = sha256(bytes)
  sealManifest(fixture.manifest)
  fixture.exportReceipt.plan_digest = fixture.manifest.plan_digest
  fixture.exportReceipt.files = fixture.manifest.nodes.map(({ path: filePath, source_sha256 }) => ({ path: filePath, source_sha256 }))
  await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest))
  await writeFile(fixture.exportReceiptPath, JSON.stringify(fixture.exportReceipt))
}

function invokeRelease(fixture, env = {}, trustedNow = now) {
  const args = ["run", "--silent", "tracer:release", "--",
    "--manifest", fixture.manifestPath,
    "--export-receipt", fixture.exportReceiptPath,
    "--runtime-root", fixture.paths.runtime,
    "--export-root", fixture.paths.export,
    "--vault-root", fixture.paths.vault,
    "--work-root", fixture.paths.work,
    "--releases-root", fixture.paths.releases,
    "--now", trustedNow,
  ]
  const childEnv = { ...process.env, ...env }
  for (const [name, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[name]
  return spawnSync(npm, args, { cwd: repoRoot, encoding: "utf8", timeout: 180_000, shell: process.platform === "win32", env: childEnv })
}

const protectedRoots = ["runtime", "releases", "work", "export", "vault"]

async function fixtureSnapshots(fixture) {
  return Object.fromEntries(await Promise.all(protectedRoots.map(async (name) => [name, await exactSnapshot(fixture.paths[name])])))
}

async function assertProtectedFailure(fixture, before, result, expected) {
  await assertPublicFailure(fixture, result, expected)
  for (const name of protectedRoots) assert.deepEqual(await exactSnapshot(fixture.paths[name]), before[name], name)
}

async function assertPublicFailure(fixture, result, expected) {
  assert.equal(result.status, 1, result.stdout)
  assert.equal(result.stderr, "")
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1)
  const output = JSON.parse(result.stdout)
  if (typeof expected === "string") {
    assert.equal(output.ok, false)
    assert.equal(output.error.code, expected)
    assert.deepEqual(Object.keys(output.error).sort(), ["code", "message"])
  } else assert.deepEqual(output, { ok: false, error: expected })
  assert.equal(result.stdout.includes("t06canary"), false)
  assert.equal(result.stdout.includes(fixture.root), false)
}

async function assertSourceRejected(t, suffix, expected) {
  const fixture = await releaseFixture("2026-07-30T00:00:00Z")
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const node = fixture.manifest.nodes.find((candidate) => candidate.public_id === "synthetic-paper")
  const source = path.join(fixture.paths.export, ...node.path.split("/"))
  await replaceFixtureSource(fixture, node.public_id, Buffer.concat([await readFile(source), Buffer.from(`\n${suffix}\n`)]))
  const before = await fixtureSnapshots(fixture)
  await assertProtectedFailure(fixture, before, invokeRelease(fixture), expected)
}

async function assertSecretRulesRejected(t, variant) {
  const fixture = await releaseFixture("2026-07-30T00:00:00Z")
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const before = await fixtureSnapshots(fixture)
  await assertProtectedFailure(fixture, before, invokeRelease(fixture, {
    TYLER_RELEASE_TEST_CAPABILITY: "t06-regression-v1",
    TYLER_RELEASE_TEST_RULES_CASE: variant,
  }), "SECRET_RULES_INVALID")
}

test("T10 baseline approval binding rejects a digest-mismatched rehearsal-shaped manifest", async (t) => {
  const fixture = await releaseFixture("2026-07-30T00:00:00Z")
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const rehearsalManifest = structuredClone(fixture.manifest)
  rehearsalManifest.approval_receipt = {
    approver: "tyler",
    channel: "telegram",
    source_event_id: "t10-integrated-local-rehearsal-not-publication-authority",
    approved_plan_digest: "0".repeat(64),
    approved_at: rehearsalManifest.approval_receipt.approved_at,
  }
  await writeFile(fixture.manifestPath, JSON.stringify(rehearsalManifest))
  const before = await fixtureSnapshots(fixture)
  await assertProtectedFailure(fixture, before, invokeRelease(fixture), "APPROVAL_DIGEST_MISMATCH")
})

test("ordinary baseline rejects noncanonical or incomplete sealed custody before build with zero mutation", async (t) => {
  const cases = [
    ["noncanonical pointer bytes", async (fixture) => {
      const pointerPath = path.join(fixture.paths.runtime, "current-release.json")
      await writeFile(pointerPath, JSON.stringify(JSON.parse(await readFile(pointerPath, "utf8")), null, 2))
    }, "CURRENT_POINTER_FORMAT_INVALID"],
    ["noncanonical receipt bytes", async (fixture) => {
      const pointer = JSON.parse(await readFile(path.join(fixture.paths.runtime, "current-release.json"), "utf8"))
      const receiptPath = path.join(fixture.paths.runtime, ...pointer.receipt_path.split("/"))
      await writeFile(receiptPath, JSON.stringify(JSON.parse(await readFile(receiptPath, "utf8")), null, 2))
    }, "CURRENT_RECEIPT_FORMAT_INVALID"],
    ["missing custody manifest", async (fixture) => {
      const pointer = JSON.parse(await readFile(path.join(fixture.paths.runtime, "current-release.json"), "utf8"))
      await rm(path.join(path.dirname(path.join(fixture.paths.runtime, ...pointer.receipt_path.split("/"))), "manifest.json"))
    }, "CURRENT_CUSTODY_INVALID"],
    ["extra custody file", async (fixture) => {
      const pointer = JSON.parse(await readFile(path.join(fixture.paths.runtime, "current-release.json"), "utf8"))
      const custody = path.dirname(path.join(fixture.paths.runtime, ...pointer.receipt_path.split("/")))
      await writeFile(path.join(custody, "extra.json"), "{}\n")
    }, "CURRENT_CUSTODY_INVALID"],
    ["wrong fixed receipt path", async (fixture) => {
      const pointerPath = path.join(fixture.paths.runtime, "current-release.json")
      const pointer = JSON.parse(await readFile(pointerPath, "utf8"))
      pointer.receipt_path = `consumed/${fixture.manifest.manifest_id}/other.json`
      await writeFile(pointerPath, `${jcsCanonicalize(pointer)}\n`)
    }, "CURRENT_RECEIPT_PATH_MISMATCH"],
    ["receipt manifest identity mismatch", async (fixture) => {
      const pointerPath = path.join(fixture.paths.runtime, "current-release.json")
      const pointer = JSON.parse(await readFile(pointerPath, "utf8"))
      const receiptPath = path.join(fixture.paths.runtime, ...pointer.receipt_path.split("/"))
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"))
      receipt.manifest_id = "VPUB-20260728-other"
      sealRelease(receipt)
      pointer.release_digest = receipt.release_digest
      await writeFile(receiptPath, `${jcsCanonicalize(receipt)}\n`)
      await writeFile(pointerPath, `${jcsCanonicalize(pointer)}\n`)
    }, "CURRENT_RECEIPT_PATH_MISMATCH"],
  ]

  for (const [name, mutate, expectedCode] of cases) await t.test(name, async (t) => {
    const fixture = await releaseFixture("2026-07-30T00:00:00Z")
    t.after(() => rm(fixture.root, { recursive: true, force: true }))
    await mutate(fixture)
    const before = await fixtureSnapshots(fixture)
    await assertProtectedFailure(fixture, before, invokeRelease(fixture), expectedCode)
  })
})

test("public release preflight rejects digest, source hash, manifest path, and junction defects before mutation", async (t) => {
  const invalidPathCase = (invalidPath) => async (fixture) => {
    const node = fixture.manifest.nodes.find((candidate) => candidate.public_id === "synthetic-paper")
    node.path = invalidPath
    sealManifest(fixture.manifest)
    fixture.exportReceipt.plan_digest = fixture.manifest.plan_digest
    fixture.exportReceipt.files = fixture.manifest.nodes.map(({ path: filePath, source_sha256 }) => ({ path: filePath, source_sha256 }))
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest))
    await writeFile(fixture.exportReceiptPath, JSON.stringify(fixture.exportReceipt))
  }
  const cases = [
    ["manifest digest mismatch", async (fixture) => {
      fixture.manifest.expires_at = "2026-07-31T00:00:00Z"
      await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest))
    }, "PLAN_DIGEST_MISMATCH"],
    ["exported source byte hash mismatch", async (fixture) => {
      const node = fixture.manifest.nodes.find((candidate) => candidate.public_id === "synthetic-paper")
      await writeFile(path.join(fixture.paths.export, ...node.path.split("/")), "changed without receipt or manifest reseal\n")
    }, "EXPORT_FILE_HASH_MISMATCH"],
    ["manifest traversal path", invalidPathCase("Literature/Notes/../private.md"), "PATH_TRAVERSAL"],
    ["manifest backslash path", invalidPathCase("Literature\\Notes\\private.md"), "PATH_BACKSLASH"],
    ["manifest drive path", invalidPathCase("D:/Secrets/private.md"), "PATH_DRIVE_ABSOLUTE"],
    ["listed source ancestor junction", async (fixture) => {
      const sourceAncestor = path.join(fixture.paths.export, "Literature")
      const target = path.join(fixture.root, "junction-source-target")
      await rename(sourceAncestor, target)
      await symlink(target, sourceAncestor, process.platform === "win32" ? "junction" : "dir")
    }, "PATH_SYMLINK_NOT_ALLOWED"],
  ]

  for (const [name, setup, expectedCode] of cases) await t.test(name, async (t) => {
    const fixture = await releaseFixture("2026-07-30T00:00:00Z")
    t.after(() => rm(fixture.root, { recursive: true, force: true }))
    await setup(fixture)
    const before = await fixtureSnapshots(fixture)
    await assertProtectedFailure(fixture, before, invokeRelease(fixture), expectedCode)
  })
})

test("release rejects an expired manifest before any mutation and preserves the exact LKG", async (t) => {
  const fixture = await releaseFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const roots = ["runtime", "releases", "work", "export", "vault"]
  const before = Object.fromEntries(await Promise.all(roots.map(async (name) => [name, await exactSnapshot(fixture.paths[name])])))

  const result = invokeRelease(fixture)
  assert.equal(result.status, 1)
  assert.equal(result.stderr, "")
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1)
  const output = JSON.parse(result.stdout)
  assert.deepEqual(output, { ok: false, error: { code: "MANIFEST_EXPIRED", message: "manifest has expired" } })
  assert.equal(result.stdout.includes(fixture.root), false)

  for (const name of roots) assert.deepEqual(await exactSnapshot(fixture.paths[name]), before[name], name)
})

test("release with a preflight-valid manifest installs immutable public and custody trees then atomically selects it", async (t) => {
  const fixture = await releaseFixture("2026-07-30T00:00:00Z")
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const oldPointerPath = path.join(fixture.paths.runtime, "current-release.json")
  const oldPointerBytes = await readFile(oldPointerPath)
  const oldReleaseDigest = JSON.parse(oldPointerBytes).release_digest
  const oldReleaseRoot = path.join(fixture.paths.releases, oldReleaseDigest)
  const oldReleaseSnapshot = await exactSnapshot(oldReleaseRoot)
  const unchanged = Object.fromEntries(await Promise.all(["work", "export", "vault"].map(async (name) => [name, await exactSnapshot(fixture.paths[name])])))
  const manifestRaw = await readFile(fixture.manifestPath)

  const result = invokeRelease(fixture, {
    TYLER_RELEASE_TEST_CAPABILITY: "t06-regression-v1",
    TYLER_RELEASE_TEST_CASE: "gate-marker",
  })
  assert.equal(result.status, 0, result.stdout)
  assert.equal(result.stderr, "")
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1)
  assert.equal(result.stdout.includes(fixture.root), false)
  const output = JSON.parse(result.stdout)
  t.diagnostic(`success-json: ${JSON.stringify(output)}`)
  const receiptPath = `consumed/${fixture.manifest.manifest_id}/release-receipt.json`
  assert.deepEqual(output, {
    ok: true,
    command: "release",
    manifestId: fixture.manifest.manifest_id,
    releaseDigest: output.releaseDigest,
    receiptPath,
    routes: output.routes,
    files: output.files,
  })
  assert.match(output.releaseDigest, /^[0-9a-f]{64}$/)
  assert.deepEqual(output.routes, ["/", "/knowledge/concept/existing-support/", "/papers/historical-paper/", "/papers/synthetic-paper/"])
  assert.equal(Number.isInteger(output.files) && output.files > 0, true)

  const pointerBytes = await readFile(oldPointerPath)
  assert.equal(pointerBytes.equals(oldPointerBytes), false)
  const pointer = JSON.parse(pointerBytes)
  assert.equal(pointerBytes.toString("utf8"), `${jcsCanonicalize(pointer)}\n`)
  assert.deepEqual(pointer, { schema_version: 1, release_digest: output.releaseDigest, receipt_path: receiptPath })
  assert.equal((await validateCurrentReleaseCandidate(pointer, { runtimeRoot: fixture.paths.runtime })).receipt.release_digest, output.releaseDigest)

  assert.deepEqual(await exactSnapshot(oldReleaseRoot), oldReleaseSnapshot)
  const publicRoot = path.join(fixture.paths.releases, output.releaseDigest)
  const publicSnapshot = await exactSnapshot(publicRoot)
  const publicFiles = publicSnapshot.filter((row) => row[1] === "regular-file")
  assert.equal(publicFiles.length, output.files)
  assert.equal(publicFiles.some(([relative]) => /(?:manifest|receipt|current-release)/i.test(relative)), false)
  assert.equal(publicFiles.every(([relative]) => !/\.(?:md|pdf)$/i.test(relative)), true)

  const custodyRoot = path.join(fixture.paths.runtime, "consumed", fixture.manifest.manifest_id)
  assert.deepEqual((await readdir(custodyRoot)).sort(), ["manifest.json", "release-receipt.json"])
  assert.equal((await readFile(path.join(custodyRoot, "manifest.json"))).equals(manifestRaw), true)
  const receiptBytes = await readFile(path.join(custodyRoot, "release-receipt.json"))
  const receipt = await readContractJson(path.join(custodyRoot, "release-receipt.json"))
  assert.equal(receiptBytes.toString("utf8"), `${jcsCanonicalize(receipt)}\n`)
  await validateReleaseAgainstManifest(receipt, fixture.manifest, { now })
  assert.equal(receipt.release_digest, output.releaseDigest)
  assert.deepEqual(receipt.artifacts.map(({ path: artifactPath, sha256: digest }) => {
    const bytes = publicFiles.find(([relative]) => relative === artifactPath)?.[2]
    return { path: artifactPath, sha256: sha256(Buffer.from(bytes, "hex")) }
  }), receipt.artifacts)

  for (const name of ["work", "export", "vault"]) assert.deepEqual(await exactSnapshot(fixture.paths[name]), unchanged[name], name)
  const releaseEntries = await readdir(fixture.paths.releases)
  assert.deepEqual(releaseEntries.sort(), [oldReleaseDigest, output.releaseDigest].sort())
  const runtimeEntries = await readdir(fixture.paths.runtime)
  assert.deepEqual(runtimeEntries.sort(), ["consumed", "current-release.json"])
  assert.equal(runtimeEntries.some((name) => /(?:tmp|staging)/i.test(name)), false)
})

test("production release is inert to build-only and former promotion fault environments", async (t) => {
  const control = await releaseFixture("2026-07-30T00:00:00Z")
  const pointerDrift = await releaseFixture("2026-07-30T00:00:00Z")
  const safeFault = await releaseFixture("2026-07-30T00:00:00Z")
  const absentCapability = await releaseFixture("2026-07-30T00:00:00Z")
  const wrongCapability = await releaseFixture("2026-07-30T00:00:00Z")
  const injectedFixtures = [pointerDrift, safeFault, absentCapability, wrongCapability]
  t.after(() => Promise.all([control, ...injectedFixtures].map((fixture) => rm(fixture.root, { recursive: true, force: true }))))
  const sourceBefore = new Map(await Promise.all(injectedFixtures.map(async (fixture) => [fixture, await sourceByteAndMtimeSnapshot(fixture)])))

  const controlResult = invokeRelease(control)
  const commonEnvironment = {
    TYLER_TRACER_TEST_CAPABILITY: "t03-regression-v1",
    TYLER_TRACER_TEST_THEME_VARIANT: "contrast",
    TYLER_TRACER_TEST_CONFIG_CASE: "content-index-single-quote",
    TYLER_TRACER_TEST_PREBASELINE_CASE: "external-script",
    TYLER_TRACER_TEST_CANDIDATE_CASE: "disclaimer-template",
    TYLER_TRACER_TEST_EXTRA_HTML: "1",
    TYLER_TRACER_TEST_GATE_FAILURE: "1",
    TYLER_TRACER_TEST_DEBUG: "1",
    TYLER_TEST_DELAY_MS: "1",
    TYLER_TEST_MUTATE_SOURCE: "1",
    TYLER_RELEASE_TEST_CAPABILITY: "t06-regression-v1",
  }
  const injected = [
    [pointerDrift, invokeRelease(pointerDrift, {
      ...commonEnvironment,
      TYLER_TRACER_TEST_DISCLOSURE_ERROR: pointerDrift.root,
      TYLER_RELEASE_TEST_PROMOTION_CASE: "pointer-drift",
    })],
    [safeFault, invokeRelease(safeFault, {
      ...commonEnvironment,
      TYLER_TRACER_TEST_DISCLOSURE_ERROR: safeFault.root,
      TYLER_RELEASE_TEST_PROMOTION_CASE: "after-release-staging",
    })],
    [absentCapability, invokeRelease(absentCapability, {
      TYLER_RELEASE_TEST_CAPABILITY: undefined,
      TYLER_RELEASE_TEST_PROMOTION_CASE: "after-release-staging",
    })],
    [wrongCapability, invokeRelease(wrongCapability, {
      TYLER_RELEASE_TEST_CAPABILITY: "wrong-capability",
      TYLER_RELEASE_TEST_PROMOTION_CASE: "pointer-drift",
    })],
  ]

  assert.equal(controlResult.status, 0, controlResult.stdout)
  assert.equal(controlResult.stderr, "")
  for (const [fixture, result] of injected) {
    assert.equal(result.status, 0, result.stdout)
    assert.equal(result.stderr, "")
    assert.equal(result.stdout, controlResult.stdout)
    assert.equal(result.stdout.includes("TEST_INJECTION"), false)
    assert.deepEqual(await sourceByteAndMtimeSnapshot(fixture), sourceBefore.get(fixture))
    assert.deepEqual(await exactSnapshot(fixture.paths.releases), await exactSnapshot(control.paths.releases))
    assert.deepEqual(await exactSnapshot(fixture.paths.runtime), await exactSnapshot(control.paths.runtime))
    assert.deepEqual(await exactSnapshot(fixture.paths.work), await exactSnapshot(control.paths.work))
  }
})

test("Zotero artifact fault hook rejects an ordinary publish-unit before mutation", async (t) => {
  const fixture = await releaseFixture("2026-07-30T00:00:00Z")
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const before = await fixtureSnapshots(fixture)
  const result = invokeRelease(fixture, {
    TYLER_RELEASE_TEST_CAPABILITY: "t06-regression-v1",
    TYLER_RELEASE_TEST_CASE: "zotero-non-target-artifact-tamper",
  })

  assert.equal(result.status, 1, result.stdout)
  assert.equal(result.stderr, "")
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    error: { code: "TEST_INJECTION_INVALID", message: "Zotero artifact regression injection requires a Zotero refresh action" },
  })
  for (const name of protectedRoots) assert.deepEqual(await exactSnapshot(fixture.paths[name]), before[name], name)
})

test("exact already-current release replay is read-only and skips the candidate pipeline", async (t) => {
  const fixture = await releaseFixture("2026-07-30T00:00:00Z")
  t.after(() => rm(fixture.root, { recursive: true, force: true }))

  const first = invokeRelease(fixture)
  assert.equal(first.status, 0, first.stdout)
  assert.equal(first.stderr, "")
  const firstOutput = JSON.parse(first.stdout)
  const before = await fixtureSnapshots(fixture)
  const custodyRoot = path.join(fixture.paths.runtime, "consumed", fixture.manifest.manifest_id)
  const manifestBytes = await readFile(path.join(custodyRoot, "manifest.json"))
  const receiptBytes = await readFile(path.join(custodyRoot, "release-receipt.json"))

  const replay = invokeRelease(fixture, {
    TYLER_RELEASE_TEST_CAPABILITY: "t06-regression-v1",
    TYLER_RELEASE_TEST_CASE: "replay-build-must-not-run",
  })
  assert.equal(replay.status, 0, replay.stdout)
  assert.equal(replay.stderr, "")
  assert.equal(replay.stdout, first.stdout)
  assert.deepEqual(JSON.parse(replay.stdout), firstOutput)
  for (const name of protectedRoots) assert.deepEqual(await exactSnapshot(fixture.paths[name]), before[name], name)
  assert.equal((await readFile(path.join(custodyRoot, "manifest.json"))).equals(manifestBytes), true)
  assert.equal((await readFile(path.join(custodyRoot, "release-receipt.json"))).equals(receiptBytes), true)
  assert.equal((await readdir(custodyRoot)).filter((name) => name === "release-receipt.json").length, 1)
  assert.equal((await readdir(fixture.paths.runtime)).some((name) => /(?:tmp|staging)/i.test(name)), false)
  assert.equal((await readdir(fixture.paths.releases)).some((name) => /(?:tmp|staging)/i.test(name)), false)
})

test("exact already-current replay needs no export receipt, source, Vault, or work roots", async (t) => {
  const fixture = await releaseFixture("2026-07-30T00:00:00Z")
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const first = invokeRelease(fixture)
  assert.equal(first.status, 0, first.stdout)
  const beforeRuntime = await exactSnapshot(fixture.paths.runtime)
  const beforeReleases = await exactSnapshot(fixture.paths.releases)

  await Promise.all(["export", "vault", "work"].map((name) => rm(fixture.paths[name], { recursive: true })))
  const replay = invokeRelease(fixture, {
    TYLER_RELEASE_TEST_CAPABILITY: "t06-regression-v1",
    TYLER_RELEASE_TEST_CASE: "replay-build-must-not-run",
  })

  assert.equal(replay.status, 0, replay.stdout)
  assert.equal(replay.stderr, "")
  assert.equal(replay.stdout, first.stdout)
  assert.deepEqual(await exactSnapshot(fixture.paths.runtime), beforeRuntime)
  assert.deepEqual(await exactSnapshot(fixture.paths.releases), beforeReleases)
  for (const name of ["export", "vault", "work"]) {
    await assert.rejects(lstat(fixture.paths[name]), (error) => error.code === "ENOENT", name)
  }
})

test("replay pipeline hook is inert without the exact release capability", async (t) => {
  const fixture = await releaseFixture("2026-07-30T00:00:00Z")
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const result = invokeRelease(fixture, {
    TYLER_RELEASE_TEST_CAPABILITY: "wrong-capability",
    TYLER_RELEASE_TEST_CASE: "replay-build-must-not-run",
  })
  assert.equal(result.status, 0, result.stdout)
  assert.equal(JSON.parse(result.stdout).ok, true)
})

test("same manifest ID with independently valid altered bytes fails as a collision before build", async (t) => {
  const fixture = await releaseFixture("2026-07-30T00:00:00Z")
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const first = invokeRelease(fixture)
  assert.equal(first.status, 0, first.stdout)

  const altered = structuredClone(fixture.manifest)
  altered.expires_at = "2026-07-31T00:00:00Z"
  sealManifest(altered)
  await validateContract("publication-manifest", altered, { now })
  fixture.manifest = altered
  await writeFile(fixture.manifestPath, JSON.stringify(altered))
  const before = await fixtureSnapshots(fixture)

  await assertProtectedFailure(fixture, before, invokeRelease(fixture, {
    TYLER_RELEASE_TEST_CAPABILITY: "t06-regression-v1",
    TYLER_RELEASE_TEST_CASE: "replay-build-must-not-run",
  }), "MANIFEST_ID_COLLISION")
})

test("exact replay fails closed on a corrupted selected public artifact without self-healing", async (t) => {
  const fixture = await releaseFixture("2026-07-30T00:00:00Z")
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const first = invokeRelease(fixture)
  assert.equal(first.status, 0, first.stdout)
  const output = JSON.parse(first.stdout)
  const receipt = await readContractJson(path.join(fixture.paths.runtime, "consumed", fixture.manifest.manifest_id, "release-receipt.json"))
  const artifactPath = path.join(fixture.paths.releases, output.releaseDigest, ...receipt.artifacts[0].path.split("/"))
  await writeFile(artifactPath, "externally corrupted selected release\n")
  const before = await fixtureSnapshots(fixture)

  await assertProtectedFailure(fixture, before, invokeRelease(fixture, {
    TYLER_RELEASE_TEST_CAPABILITY: "t06-regression-v1",
    TYLER_RELEASE_TEST_CASE: "replay-build-must-not-run",
  }), "RELEASE_ARTIFACT_HASH_MISMATCH")
})

test("an exact orphan release and custody pair is reused after the old pointer is atomically restored", async (t) => {
  const fixture = await releaseFixture("2026-07-30T00:00:00Z")
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const pointerPath = path.join(fixture.paths.runtime, "current-release.json")
  const oldPointerBytes = await readFile(pointerPath)
  const oldDigest = JSON.parse(oldPointerBytes).release_digest
  const oldReleaseSnapshot = await exactSnapshot(path.join(fixture.paths.releases, oldDigest))

  const first = invokeRelease(fixture)
  assert.equal(first.status, 0, first.stdout)
  const output = JSON.parse(first.stdout)
  const selectedPointerBytes = await readFile(pointerPath)
  const selectedReleaseRoot = path.join(fixture.paths.releases, output.releaseDigest)
  const custodyRoot = path.join(fixture.paths.runtime, "consumed", fixture.manifest.manifest_id)
  const releaseSnapshot = await exactSnapshot(selectedReleaseRoot)
  const custodySnapshot = await exactSnapshot(custodyRoot)

  const restoreTemp = path.join(fixture.paths.runtime, ".test-restore-old-pointer")
  await writeFile(restoreTemp, oldPointerBytes, { flag: "wx" })
  await rename(restoreTemp, pointerPath)
  const unchanged = Object.fromEntries(await Promise.all(["work", "export", "vault"].map(async (name) => [name, await exactSnapshot(fixture.paths[name])])))

  const resumed = invokeRelease(fixture)
  assert.equal(resumed.status, 0, resumed.stdout)
  assert.equal(resumed.stderr, "")
  assert.equal(resumed.stdout, first.stdout)
  assert.equal((await readFile(pointerPath)).equals(selectedPointerBytes), true)
  assert.deepEqual(await exactSnapshot(selectedReleaseRoot), releaseSnapshot)
  assert.deepEqual(await exactSnapshot(custodyRoot), custodySnapshot)
  assert.deepEqual(await exactSnapshot(path.join(fixture.paths.releases, oldDigest)), oldReleaseSnapshot)
  for (const name of ["work", "export", "vault"]) assert.deepEqual(await exactSnapshot(fixture.paths[name]), unchanged[name], name)
  assert.equal((await readdir(fixture.paths.runtime)).some((name) => /(?:tmp|staging|test-restore)/i.test(name)), false)
  assert.equal((await readdir(fixture.paths.releases)).some((name) => /(?:tmp|staging)/i.test(name)), false)
})

test("complete orphan retry at a different trusted time reuses sealed finals without source roots", async (t) => {
  const fixture = await releaseFixture("2026-07-30T00:00:00Z")
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const pointerPath = path.join(fixture.paths.runtime, "current-release.json")
  const oldPointerBytes = await readFile(pointerPath)

  const first = invokeRelease(fixture, {}, "2026-07-29T00:00:00Z")
  assert.equal(first.status, 0, first.stdout)
  const firstOutput = JSON.parse(first.stdout)
  const selectedPointerBytes = await readFile(pointerPath)
  const targetCustody = path.join(fixture.paths.runtime, "consumed", fixture.manifest.manifest_id)
  const targetRelease = path.join(fixture.paths.releases, firstOutput.releaseDigest)
  const custodyBefore = await exactSnapshot(targetCustody)
  const releaseBefore = await exactSnapshot(targetRelease)

  const restoreTemp = path.join(fixture.paths.runtime, ".test-restore-old-pointer-different-time")
  await writeFile(restoreTemp, oldPointerBytes, { flag: "wx" })
  await rename(restoreTemp, pointerPath)
  await Promise.all(["export", "vault", "work"].map((name) => rm(fixture.paths[name], { recursive: true })))

  const resumed = invokeRelease(fixture, {}, "2026-07-29T12:00:00Z")
  assert.equal(resumed.status, 0, resumed.stdout)
  assert.equal(resumed.stderr, "")
  assert.equal(resumed.stdout, first.stdout)
  assert.equal((await readFile(pointerPath)).equals(selectedPointerBytes), true)
  assert.deepEqual(await exactSnapshot(targetCustody), custodyBefore)
  assert.deepEqual(await exactSnapshot(targetRelease), releaseBefore)
  assert.equal((await readdir(fixture.paths.releases)).length, 2)
  assert.equal((await readdir(path.join(fixture.paths.runtime, "consumed"))).length, 2)
  assert.equal((await readdir(fixture.paths.runtime)).some((name) => /(?:tmp|staging|test-restore)/i.test(name)), false)
  assert.equal((await readdir(fixture.paths.releases)).some((name) => /(?:tmp|staging)/i.test(name)), false)
  for (const name of ["export", "vault", "work"]) {
    await assert.rejects(lstat(fixture.paths[name]), (error) => error.code === "ENOENT", name)
  }
})

test("orphan collision matrix fails before source reads and never repairs sealed history", async (t) => {
  const cases = [
    ["missing target custody", async (fixture, output) => {
      await rm(path.join(fixture.paths.runtime, "consumed", fixture.manifest.manifest_id), { recursive: true })
    }, "EXISTING_RELEASE_PAIR_INCOMPLETE"],
    ["missing target release", async (fixture, output) => {
      await rm(path.join(fixture.paths.releases, output.releaseDigest), { recursive: true })
    }, "RELEASE_ARTIFACT_READBACK_INVALID"],
    ["malformed target custody", async (fixture) => {
      await writeFile(path.join(fixture.paths.runtime, "consumed", fixture.manifest.manifest_id, "extra.json"), "{}\n")
    }, "TARGET_CUSTODY_INVALID"],
    ["same target identity with different manifest bytes", async (fixture) => {
      const altered = structuredClone(fixture.manifest)
      altered.expires_at = "2026-08-01T00:00:00Z"
      sealManifest(altered)
      fixture.manifest = altered
      await writeFile(fixture.manifestPath, JSON.stringify(altered))
    }, "MANIFEST_ID_COLLISION"],
    ["corrupt target artifact", async (fixture, output) => {
      const receipt = await readContractJson(path.join(fixture.paths.runtime, "consumed", fixture.manifest.manifest_id, "release-receipt.json"))
      await writeFile(path.join(fixture.paths.releases, output.releaseDigest, ...receipt.artifacts[0].path.split("/")), "corrupt orphan artifact\n")
    }, "RELEASE_ARTIFACT_HASH_MISMATCH"],
  ]

  for (const [name, mutate, code] of cases) await t.test(name, async (t) => {
    const fixture = await releaseFixture("2026-07-31T00:00:00Z")
    t.after(() => rm(fixture.root, { recursive: true, force: true }))
    const pointerPath = path.join(fixture.paths.runtime, "current-release.json")
    const oldPointerBytes = await readFile(pointerPath)
    const first = invokeRelease(fixture)
    assert.equal(first.status, 0, first.stdout)
    const output = JSON.parse(first.stdout)
    const restoreTemp = path.join(fixture.paths.runtime, `.test-restore-${name.replaceAll(" ", "-")}`)
    await writeFile(restoreTemp, oldPointerBytes, { flag: "wx" })
    await rename(restoreTemp, pointerPath)
    await mutate(fixture, output)
    await Promise.all(["export", "vault", "work"].map((root) => rm(fixture.paths[root], { recursive: true })))
    const beforeRuntime = await exactSnapshot(fixture.paths.runtime)
    const beforeReleases = await exactSnapshot(fixture.paths.releases)

    const result = invokeRelease(fixture, {
      TYLER_RELEASE_TEST_CAPABILITY: "t06-regression-v1",
      TYLER_RELEASE_TEST_CASE: "replay-build-must-not-run",
    })
    await assertPublicFailure(fixture, result, code)
    assert.deepEqual(await exactSnapshot(fixture.paths.runtime), beforeRuntime)
    assert.deepEqual(await exactSnapshot(fixture.paths.releases), beforeReleases)
    for (const root of ["export", "vault", "work"]) {
      await assert.rejects(lstat(fixture.paths[root]), (error) => error.code === "ENOENT", root)
    }
  })
})

test("genesis release installs the first immutable release and pointer from truly absent history", async (t) => {
  const fixture = await releaseFixture("2026-07-30T00:00:00Z", true)
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const unchanged = Object.fromEntries(await Promise.all(["work", "export", "vault"].map(async (name) => [name, await exactSnapshot(fixture.paths[name])])))
  assert.deepEqual(await readdir(fixture.paths.runtime), [])
  assert.deepEqual(await readdir(fixture.paths.releases), [])

  const result = invokeRelease(fixture)
  assert.equal(result.status, 0, result.stdout)
  assert.equal(result.stderr, "")
  const output = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(output), ["ok", "command", "manifestId", "releaseDigest", "receiptPath", "routes", "files"])
  assert.equal(output.ok, true)
  assert.equal(output.command, "release")
  assert.equal(output.manifestId, fixture.manifest.manifest_id)
  assert.equal(output.receiptPath, `consumed/${fixture.manifest.manifest_id}/release-receipt.json`)
  assert.deepEqual(output.routes, ["/", "/knowledge/concept/existing-support/", "/papers/synthetic-paper/"])

  const pointer = await readContractJson(path.join(fixture.paths.runtime, "current-release.json"))
  const selected = await validateCurrentReleaseCandidate(pointer, { runtimeRoot: fixture.paths.runtime })
  assert.equal(pointer.release_digest, output.releaseDigest)
  assert.equal(selected.receipt.release_digest, output.releaseDigest)
  assert.deepEqual(await readdir(fixture.paths.releases), [output.releaseDigest])
  assert.deepEqual((await readdir(path.join(fixture.paths.runtime, "consumed", fixture.manifest.manifest_id))).sort(), ["manifest.json", "release-receipt.json"])
  for (const name of ["work", "export", "vault"]) assert.deepEqual(await exactSnapshot(fixture.paths[name]), unchanged[name], name)
})

async function assertPostSealRejected(t, variant, expectedCode) {
  const fixture = await releaseFixture("2026-07-30T00:00:00Z")
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const before = await fixtureSnapshots(fixture)
  await assertProtectedFailure(fixture, before, invokeRelease(fixture, {
    TYLER_RELEASE_TEST_CAPABILITY: "t06-regression-v1",
    TYLER_RELEASE_TEST_CASE: variant,
  }), expectedCode)
}

test("release rejects artifact content tampered after receipt seal", async (t) => {
  await assertPostSealRejected(t, "artifact-content-tamper-after-seal", "CANDIDATE_ARTIFACT_HASH_MISMATCH")
})

test("release rejects an extra artifact added after receipt seal", async (t) => {
  await assertPostSealRejected(t, "artifact-extra-after-seal", "CANDIDATE_ARTIFACT_SET_MISMATCH")
})

test("release rejects an artifact removed after receipt seal", async (t) => {
  await assertPostSealRejected(t, "artifact-remove-after-seal", "CANDIDATE_ARTIFACT_SET_MISMATCH")
})

test("release rejects an artifact changed to a link after receipt seal", async (t) => {
  await assertPostSealRejected(t, "artifact-class-after-seal", "CANDIDATE_ARTIFACT_CLASS_INVALID")
})

test("release rejects a receipt digest tampered after seal", async (t) => {
  await assertPostSealRejected(t, "receipt-digest-tamper", "RELEASE_DIGEST_MISMATCH")
})

test("release rejects a fingerprint tamper even when the receipt is resealed", async (t) => {
  await assertPostSealRejected(t, "receipt-fingerprint-reseal-tamper", "RELEASE_FINGERPRINT_BUILD_BINDING_MISMATCH")
})

test("release rejects a prebaseline extra asset that the candidate cannot self-authorize", async (t) => {
  const fixture = await releaseFixture("2026-07-30T00:00:00Z")
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const roots = ["runtime", "releases", "work", "export", "vault"]
  const before = Object.fromEntries(await Promise.all(roots.map(async (name) => [name, await exactSnapshot(fixture.paths[name])])))

  const result = invokeRelease(fixture, {
    TYLER_RELEASE_TEST_CAPABILITY: "t06-regression-v1",
    TYLER_RELEASE_TEST_CASE: "output-extra-asset",
  })
  assert.equal(result.status, 1)
  assert.equal(result.stderr, "")
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    error: { code: "CANDIDATE_OUTPUT_SET_INVALID", message: "candidate output set is not the project-owned exact allowlist" },
  })
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1)
  assert.equal(result.stdout.includes(fixture.root), false)
  for (const name of roots) assert.deepEqual(await exactSnapshot(fixture.paths[name]), before[name], name)
})

test("release exact output allowlist rejects every fixed extra, missing, and forbidden file class", async (t) => {
  const cases = [
    ["extra route", "output-extra-route", "CANDIDATE_OUTPUT_SET_INVALID"],
    ["missing fixed renderer asset", "output-missing-asset", "CANDIDATE_OUTPUT_SET_INVALID"],
    ["Markdown", "output-markdown", "CANDIDATE_FORBIDDEN_FILE"],
    ["PDF", "output-pdf", "CANDIDATE_FORBIDDEN_FILE"],
    ["release receipt", "output-receipt", "CANDIDATE_FORBIDDEN_FILE"],
    ["runtime state", "output-runtime", "CANDIDATE_FORBIDDEN_FILE"],
  ]
  for (const [name, variant, expectedCode] of cases) await t.test(name, async (t) => {
    const fixture = await releaseFixture("2026-07-30T00:00:00Z")
    t.after(() => rm(fixture.root, { recursive: true, force: true }))
    const roots = ["runtime", "releases", "work", "export", "vault"]
    const before = Object.fromEntries(await Promise.all(roots.map(async (root) => [root, await exactSnapshot(fixture.paths[root])])))
    const result = invokeRelease(fixture, { TYLER_RELEASE_TEST_CAPABILITY: "t06-regression-v1", TYLER_RELEASE_TEST_CASE: variant })
    assert.equal(result.status, 1, `${name}: ${result.stdout}`)
    assert.equal(result.stderr, "")
    const output = JSON.parse(result.stdout)
    assert.equal(output.error.code, expectedCode)
    assert.deepEqual(Object.keys(output.error).sort(), ["code", "message"])
    assert.equal(result.stdout.trim().split(/\r?\n/).length, 1)
    assert.equal(result.stdout.includes(fixture.root), false)
    for (const root of roots) assert.deepEqual(await exactSnapshot(fixture.paths[root]), before[root], root)
  })
})

test("versioned secret rules scan every candidate byte and credential filename before install", async (t) => {
  const cases = [
    ["token in existing HTML", "candidate-token-html"],
    ["token after invalid UTF-8 in binary asset", "candidate-token-binary"],
    ["empty .env", "candidate-empty-env"],
    ["empty credential file", "candidate-empty-credential"],
    ["empty key-suffix file", "candidate-empty-key"],
  ]
  for (const [name, variant] of cases) await t.test(name, async (t) => {
    const fixture = await releaseFixture("2026-07-30T00:00:00Z")
    t.after(() => rm(fixture.root, { recursive: true, force: true }))
    const roots = ["runtime", "releases", "work", "export", "vault"]
    const before = Object.fromEntries(await Promise.all(roots.map(async (root) => [root, await exactSnapshot(fixture.paths[root])])))
    const result = invokeRelease(fixture, { TYLER_RELEASE_TEST_CAPABILITY: "t06-regression-v1", TYLER_RELEASE_TEST_CASE: variant })
    assert.equal(result.status, 1, `${name}: ${result.stdout}`)
    assert.equal(result.stderr, "")
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: { code: "CANDIDATE_SECRET_DISCLOSURE", message: "candidate contains credential-shaped bytes" } })
    assert.equal(result.stdout.includes("t06canary"), false)
    assert.equal(result.stdout.includes(fixture.root), false)
    for (const root of roots) assert.deepEqual(await exactSnapshot(fixture.paths[root]), before[root], root)
  })
})

test("release rejects a private-key delimiter in a digest-valid synthetic source", async (t) => {
  await assertSourceRejected(t, "-----BEGIN OPENSSH PRIVATE KEY-----\nt06canary", {
    code: "SOURCE_SECRET_NOT_ALLOWED", message: "source contains credential-shaped bytes",
  })
})

test("release rejects a configured high-confidence token in a digest-valid synthetic source", async (t) => {
  await assertSourceRejected(t, "sk_live_t06canary12345678", {
    code: "SOURCE_SECRET_NOT_ALLOWED", message: "source contains credential-shaped bytes",
  })
})

test("versioned absolute-local-path policy rejects cross-platform source classes before build", async (t) => {
  const cases = [
    ["Windows drive backslashes outside Users", "D:\\Secrets\\paper.md"],
    ["Windows drive forward slashes outside Users", "D:/Secrets/paper.md"],
    ["Windows UNC backslashes", "\\\\server\\share\\secret.txt"],
    ["normalized Windows UNC", "//server/share/secret.txt"],
    ["Windows UNC backslashes with underscore-tailed share", "\\\\server\\share_\\secret.txt"],
    ["normalized Windows UNC with underscore-tailed share", "//server/share_/secret.txt"],
    ["normalized Windows UNC with hyphen-tailed share", "//server/share-/secret.txt"],
    ["normalized Windows UNC with dot-tailed share", "//server/share./secret.txt"],
    ["normalized Windows UNC with dollar-tailed share", "//server/share$/secret.txt"],
    ["POSIX binary root", "/bin/private"],
    ["POSIX binary root exact token", "/bin"],
    ["POSIX device root", "/dev/shm/private"],
    ["POSIX device root exact token", "/dev"],
    ["POSIX temporary root", "/tmp/private-note.md"],
    ["POSIX configuration root", "/etc/private-key"],
    ["POSIX home root", "/home/t06canary/tyler-vault/private-note.md"],
    ["POSIX local root", "/usr/local/t06canary/tyler-vault/private-note.md"],
    ["POSIX user binaries", "/usr/bin/private"],
    ["POSIX container workspace", "/workspace/private"],
    ["POSIX container workspace exact token", "/workspace"],
  ]
  for (const [name, disclosedPath] of cases) await t.test(name, async (t) => {
    await assertSourceRejected(t, disclosedPath, {
      code: "SOURCE_ABSOLUTE_PATH_NOT_ALLOWED", message: "source contains an absolute local path",
    })
  })
})

test("absolute-local-path policy does not reject public routes, URL pathnames, or component-prefix lookalikes", async (t) => {
  const fixture = await releaseFixture("2026-07-30T00:00:00Z")
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const safeText = [
    "Public URL: https://example.test/etc/x",
    "Protocol-relative public asset: //cdn.example.test/assets/site.css",
    "Ordinary double-slash syntax: // comment only",
    "Paper route: /papers/synthetic-paper/",
    "Knowledge route: /knowledge/concept/existing-support/",
    "Lookalike root: /etcetera/public-note",
    "Lookalike binary root: /binary/public-note",
    "Lookalike device root: /developer/public-note",
    "Lookalike workspace root: /workspace-public/public-note",
    "Root-level data asset lookalike: /data.json",
    "Root-level app asset lookalike: /app.css",
  ].join("\n")
  const node = fixture.manifest.nodes.find((candidate) => candidate.public_id === "synthetic-paper")
  const source = path.join(fixture.paths.export, ...node.path.split("/"))
  await replaceFixtureSource(fixture, node.public_id, Buffer.concat([await readFile(source), Buffer.from(`\n${safeText}\n`)]))

  const result = invokeRelease(fixture)
  assert.equal(result.status, 0, result.stdout)
  assert.equal(result.stderr, "")
  assert.equal(JSON.parse(result.stdout).ok, true)
})

test("versioned absolute-local-path policy scans HTML and invalid-UTF8 binary candidate bytes before install", async (t) => {
  const cases = [
    ["HTML text", "candidate-absolute-path-html"],
    ["binary bytes after invalid UTF-8", "candidate-absolute-path-binary"],
    ["UNC underscore after high and invalid UTF-8 bytes", "candidate-unc-tail-binary"],
    ["exact POSIX root token", "candidate-absolute-root-token"],
  ]
  for (const [name, variant] of cases) await t.test(name, async (t) => {
    const fixture = await releaseFixture("2026-07-30T00:00:00Z")
    t.after(() => rm(fixture.root, { recursive: true, force: true }))
    const before = await fixtureSnapshots(fixture)
    await assertProtectedFailure(fixture, before, invokeRelease(fixture, {
      TYLER_RELEASE_TEST_CAPABILITY: "t06-regression-v1",
      TYLER_RELEASE_TEST_CASE: variant,
    }), "CANDIDATE_ABSOLUTE_PATH_DISCLOSURE")
  })
})

test("release rejects secret rules with an unknown key before candidate mutation", async (t) => {
  await assertSecretRulesRejected(t, "unknown")
})

test("release rejects secret rules with a duplicate key before candidate mutation", async (t) => {
  await assertSecretRulesRejected(t, "duplicate")
})

test("release rejects secret rules with a malformed array before candidate mutation", async (t) => {
  await assertSecretRulesRejected(t, "malformed")
})

test("release rejects secret rules with an empty value before candidate mutation", async (t) => {
  await assertSecretRulesRejected(t, "empty")
})

test("release rejects non-NFC secret rules before candidate mutation", async (t) => {
  await assertSecretRulesRejected(t, "non-nfc")
})

test("release rejects secret rules with a duplicate value before candidate mutation", async (t) => {
  await assertSecretRulesRejected(t, "duplicate-value")
})

test("release rejects escaped policy control characters before candidate mutation", async (t) => {
  await assertSecretRulesRejected(t, "control-character")
})

test("release rejects absolute-local-path rules with an unknown grammar class before mutation", async (t) => {
  await assertSecretRulesRejected(t, "unknown-class")
})

test("release rejects absolute-local-path rules missing a required key before mutation", async (t) => {
  await assertSecretRulesRejected(t, "missing-path-classes")
})

test("release rejects unsorted absolute-local POSIX roots before mutation", async (t) => {
  await assertSecretRulesRejected(t, "unsorted-path-root")
})

test("release rejects duplicate absolute-local POSIX roots before mutation", async (t) => {
  await assertSecretRulesRejected(t, "duplicate-path-root")
})

test("release secret-rule injection is inert when its capability is missing", async (t) => {
  const fixture = await releaseFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const before = await fixtureSnapshots(fixture)
  await assertProtectedFailure(fixture, before, invokeRelease(fixture, {
    TYLER_RELEASE_TEST_CAPABILITY: undefined,
    TYLER_RELEASE_TEST_RULES_CASE: "unknown",
  }), { code: "MANIFEST_EXPIRED", message: "manifest has expired" })
})

test("release secret-rule injection is inert when its capability is wrong", async (t) => {
  const fixture = await releaseFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const before = await fixtureSnapshots(fixture)
  await assertProtectedFailure(fixture, before, invokeRelease(fixture, {
    TYLER_RELEASE_TEST_CAPABILITY: "wrong-capability",
    TYLER_RELEASE_TEST_RULES_CASE: "unknown",
  }), { code: "MANIFEST_EXPIRED", message: "manifest has expired" })
})


