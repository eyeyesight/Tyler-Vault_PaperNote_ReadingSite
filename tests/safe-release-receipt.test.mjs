// @ts-nocheck -- literal contract fixture intentionally uses dynamic JSON values.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { computePlanDigest, computePublicSetDigest, sha256Jcs } from "../lib/publication-contracts.mjs"
import { constructReleaseReceipt, readCandidateArtifactTree, verifySealedArtifactTree } from "../lib/safe-release.mjs"
import { parseZoteroManagedBlock } from "../lib/zotero-delta.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const baselineReceiptPath = "consumed/VPUB-20260728-example/release-receipt.json"
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

async function json(relative) {
  return JSON.parse(await readFile(path.join(repoRoot, relative), "utf8"))
}

function sealManifest(manifest) {
  manifest.public_set_digest = computePublicSetDigest(manifest.nodes)
  manifest.plan_digest = computePlanDigest(manifest)
  manifest.approval_receipt.approved_plan_digest = manifest.plan_digest
}

function sealReceipt(receipt) {
  receipt.public_set_digest = computePublicSetDigest(receipt.nodes)
  const unsigned = structuredClone(receipt)
  delete unsigned.release_digest
  receipt.release_digest = sha256Jcs(unsigned)
}

function constructorInput(manifest, authority = {}) {
  return {
    manifest,
    createdAt: "2026-07-28T12:34:56Z",
    projectedMarkdown: new Map(manifest.nodes.map((node) => [node.public_id, Buffer.from(`projected:${node.public_id}\n`, "utf8")])),
    artifacts: [
      { path: "graph.json", sha256: "c5d130e87e377f65c0f77eda3629f01de137de88cd3b0a181aa1b6fda001afdc" },
      { path: "index.html", sha256: "335fca8574f060eea24ebcdae6b78f32414f5de03da1084fd0e73d710768e3a9" },
    ],
    ...authority,
  }
}

test("release receipt fingerprints exact projected Markdown bytes with independent literals", async () => {
  const manifest = await json("specs/examples/publish-unit-manifest-v1.example.json")
  const projectedMarkdown = new Map([
    ["flow", Buffer.from("---\ntitle: Existing\n---\n\n# Existing\n", "utf8")],
    ["jackman-2021", Buffer.from("---\ntitle: Paper\n---\n\n# Paper\n", "utf8")],
  ])
  const artifacts = [
    { path: "graph.json", sha256: "c5d130e87e377f65c0f77eda3629f01de137de88cd3b0a181aa1b6fda001afdc" },
    { path: "index.html", sha256: "335fca8574f060eea24ebcdae6b78f32414f5de03da1084fd0e73d710768e3a9" },
  ]

  const receipt = await constructReleaseReceipt({
    manifest,
    createdAt: "2026-07-28T12:34:56Z",
    projectedMarkdown,
    artifacts,
  })

  assert.deepEqual(receipt.content_fingerprints, [
    { public_id: "flow", route: "/knowledge/concept/flow/", sha256: "f43bfd6616c6449f8c67d1b27c19a16e7d44e064cfe41419f1f313fbafd0e276" },
    { public_id: "jackman-2021", route: "/papers/jackman-2021/", sha256: "57fa440f23cdf7bccc8086b3abaa552c6894294255a716b77120dc6ddd9fe9c2" },
  ])
  assert.deepEqual(receipt.artifacts, artifacts)
  assert.deepEqual(receipt.nodes.map(({ public_id, path, node_class, source_sha256 }) => ({ public_id, path, node_class, source_sha256 })), manifest.nodes)
  assert.equal(receipt.nodes.some((node) => Object.hasOwn(node, "zotero_baseline")), false)
  assert.equal(receipt.created_at, "2026-07-28T12:34:56Z")
  assert.equal(receipt.release_digest, "446d5787b6191edb272acf23f30678107e9b3387e0d563d29b9300c1647d8295")
})

test("release receipt clones Zotero metadata only from the exact approved release baseline", async () => {
  const manifest = await json("specs/examples/publish-unit-with-baseline-v1.example.json")
  const currentReceipt = await json("specs/examples/release-receipt-v1.example.json")
  const receipt = await constructReleaseReceipt(constructorInput(manifest, { currentReceipt, currentReceiptPath: baselineReceiptPath }))
  const inherited = receipt.nodes.find((node) => node.public_id === "jackman-2021")

  assert.deepEqual(inherited.zotero_baseline, currentReceipt.nodes[1].zotero_baseline)
  assert.equal(JSON.stringify(inherited.zotero_baseline), JSON.stringify(currentReceipt.nodes[1].zotero_baseline))
  assert.notEqual(inherited.zotero_baseline, currentReceipt.nodes[1].zotero_baseline)
  assert.deepEqual(receipt.nodes.filter((node) => Object.hasOwn(node, "zotero_baseline")).map((node) => node.public_id), ["jackman-2021"])
})

test("release receipt derives new Zotero authority only from exact raw bytes for the newly published paper", async () => {
  const sourceBytes = Buffer.from("---\ntitle: New Paper\ntype: literature-note\nstatus: integrated\n---\n\n<!-- zotero-annotations:start -->\n- Annotation.\n<!-- zotero-annotations:end -->\n\nBody.\n", "utf8")
  const genesis = await json("specs/examples/publish-unit-manifest-v1.example.json")
  genesis.nodes.find((node) => node.public_id === genesis.action.primary_id).source_sha256 = sha256(sourceBytes)
  sealManifest(genesis)
  const input = constructorInput(genesis)

  const receipt = await constructReleaseReceipt({
    ...input,
    zoteroSourceBytes: new Map([[genesis.action.primary_id, sourceBytes]]),
  })
  assert.deepEqual(
    receipt.nodes.find((node) => node.public_id === genesis.action.primary_id).zotero_baseline,
    parseZoteroManagedBlock(sourceBytes).metadata,
  )

  const forgedMetadata = { ...parseZoteroManagedBlock(sourceBytes).metadata, prefix_sha256: "0".repeat(64) }
  await assert.rejects(
    constructReleaseReceipt({ ...input, zoteroBaselines: new Map([[genesis.action.primary_id, forgedMetadata]]) }),
    (error) => error.code === "ZOTERO_BASELINE_INPUT_INVALID",
  )
  await assert.rejects(
    constructReleaseReceipt({ ...input, zoteroSourceBytes: new Map([["unknown", sourceBytes]]) }),
    (error) => error.code === "ZOTERO_SOURCE_TARGET_INVALID",
  )
  await assert.rejects(
    constructReleaseReceipt({ ...input, zoteroSourceBytes: new Map([["flow", sourceBytes]]) }),
    (error) => error.code === "ZOTERO_SOURCE_TARGET_INVALID",
  )

  const wrongHash = structuredClone(genesis)
  wrongHash.nodes.find((node) => node.public_id === wrongHash.action.primary_id).source_sha256 = "f".repeat(64)
  sealManifest(wrongHash)
  await assert.rejects(
    constructReleaseReceipt({ ...constructorInput(wrongHash), zoteroSourceBytes: new Map([[wrongHash.action.primary_id, sourceBytes]]) }),
    (error) => error.code === "ZOTERO_SOURCE_HASH_MISMATCH",
  )

  const baseline = await json("specs/examples/publish-unit-with-baseline-v1.example.json")
  const currentReceipt = await json("specs/examples/release-receipt-v1.example.json")
  await assert.rejects(
    constructReleaseReceipt({
      ...constructorInput(baseline, { currentReceipt, currentReceiptPath: baselineReceiptPath }),
      zoteroSourceBytes: new Map([["jackman-2021", sourceBytes]]),
    }),
    (error) => error.code === "ZOTERO_SOURCE_TARGET_INVALID",
  )
})

test("release receipt rejects absent, genesis, stale, or digest-invalid baseline authority", async () => {
  const genesis = await json("specs/examples/publish-unit-manifest-v1.example.json")
  const baseline = await json("specs/examples/publish-unit-with-baseline-v1.example.json")
  const currentReceipt = await json("specs/examples/release-receipt-v1.example.json")

  await assert.rejects(
    constructReleaseReceipt(constructorInput(genesis, { currentReceipt, currentReceiptPath: baselineReceiptPath })),
    (error) => error.code === "RELEASE_BASELINE_REQUIRED",
  )
  await assert.rejects(
    constructReleaseReceipt(constructorInput(baseline)),
    (error) => error.code === "GENESIS_BASELINE_REQUIRED",
  )
  await assert.rejects(
    constructReleaseReceipt(constructorInput(baseline, { currentReceipt })),
    (error) => error.code === "CURRENT_STATE_INCOMPLETE",
  )

  for (const field of ["release_digest", "receipt_path"]) {
    const stale = structuredClone(baseline)
    stale.action.baseline[field] = field === "release_digest" ? "f".repeat(64) : "consumed/VPUB-20260728-other/release-receipt.json"
    sealManifest(stale)
    await assert.rejects(
      constructReleaseReceipt(constructorInput(stale, { currentReceipt, currentReceiptPath: baselineReceiptPath })),
      (error) => error.code === "STALE_BASELINE",
      field,
    )
  }

  const invalidStored = structuredClone(currentReceipt)
  invalidStored.release_digest = "0".repeat(64)
  await assert.rejects(
    constructReleaseReceipt(constructorInput(baseline, { currentReceipt: invalidStored, currentReceiptPath: baselineReceiptPath })),
    (error) => error.code === "RELEASE_DIGEST_MISMATCH",
  )

  const invalidSchema = structuredClone(currentReceipt)
  delete invalidSchema.content_fingerprints
  await assert.rejects(
    constructReleaseReceipt(constructorInput(baseline, { currentReceipt: invalidSchema, currentReceiptPath: baselineReceiptPath })),
    (error) => error.code === "SCHEMA_INVALID",
  )

  const invalidRecomputed = structuredClone(currentReceipt)
  invalidRecomputed.nodes[0].source_sha256 = "0".repeat(64)
  await assert.rejects(
    constructReleaseReceipt(constructorInput(baseline, { currentReceipt: invalidRecomputed, currentReceiptPath: baselineReceiptPath })),
    (error) => error.code === "RELEASE_DIGEST_MISMATCH",
  )
})

test("release receipt rejects approved manifests that do not preserve every baseline identity and source hash", async () => {
  const originalManifest = await json("specs/examples/publish-unit-with-baseline-v1.example.json")
  const originalReceipt = await json("specs/examples/release-receipt-v1.example.json")
  const cases = [
    ["BASELINE_NODE_MISSING", (manifest, receipt) => {
      receipt.nodes[1].public_id = "zebra-paper"
      receipt.content_fingerprints[1].public_id = "zebra-paper"
      receipt.content_fingerprints[1].route = "/papers/zebra-paper/"
      sealReceipt(receipt)
      manifest.action.baseline.release_digest = receipt.release_digest
    }],
    ["BASELINE_NODE_CLASS_CHANGED", (manifest) => {
      const node = manifest.nodes.find((candidate) => candidate.public_id === "flow")
      node.node_class = "method"
      node.path = "Knowledge/Methods/Flow.md"
    }],
    ["BASELINE_NODE_PATH_CHANGED", (manifest) => {
      manifest.nodes.find((candidate) => candidate.public_id === "flow").path = "Knowledge/Concepts/Flow-renamed.md"
    }],
    ["BASELINE_SOURCE_CHANGED", (manifest) => {
      manifest.nodes.find((candidate) => candidate.public_id === "flow").source_sha256 = "0".repeat(64)
    }],
  ]

  for (const [code, mutate] of cases) {
    const manifest = structuredClone(originalManifest)
    const currentReceipt = structuredClone(originalReceipt)
    mutate(manifest, currentReceipt)
    sealManifest(manifest)
    await assert.rejects(
      constructReleaseReceipt(constructorInput(manifest, { currentReceipt, currentReceiptPath: baselineReceiptPath })),
      (error) => error.code === code,
      code,
    )
  }
})

test("candidate artifact verifier reads the exact regular-file set and bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "safe-release-receipt-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, "nested"))
  await writeFile(path.join(root, "graph.json"), '{"schema_version":1}\n')
  await writeFile(path.join(root, "nested", "index.html"), "<!doctype html>\n")

  const artifacts = [
    { path: "graph.json", sha256: "c5d130e87e377f65c0f77eda3629f01de137de88cd3b0a181aa1b6fda001afdc" },
    { path: "nested/index.html", sha256: "335fca8574f060eea24ebcdae6b78f32414f5de03da1084fd0e73d710768e3a9" },
  ]
  assert.deepEqual(await readCandidateArtifactTree(root), artifacts)

  const manifest = await json("specs/examples/publish-unit-manifest-v1.example.json")
  const projectedMarkdown = new Map([
    ["flow", Buffer.from("---\ntitle: Existing\n---\n\n# Existing\n", "utf8")],
    ["jackman-2021", Buffer.from("---\ntitle: Paper\n---\n\n# Paper\n", "utf8")],
  ])
  const receipt = await constructReleaseReceipt({ manifest, createdAt: "2026-07-28T12:34:56Z", projectedMarkdown, artifacts })
  assert.deepEqual(await verifySealedArtifactTree({ root, receipt }), { artifacts: 2, verified: true })
  await writeFile(path.join(root, "graph.json"), '{"schema_version":2}\n')
  await assert.rejects(verifySealedArtifactTree({ root, receipt }), (error) => error.code === "RELEASE_ARTIFACT_HASH_MISMATCH")
})

test("Windows accepts a case-only spelling variant of an ordinary artifact root", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "safe-release-receipt-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from("case-variant artifact root\n", "utf8")
  await writeFile(path.join(root, "index.html"), bytes)

  const variant = path.join(path.dirname(root), path.basename(root).replace("safe-release-receipt-", "SAFE-RELEASE-RECEIPT-"))
  assert.notEqual(variant, root)
  assert.deepEqual(await readCandidateArtifactTree(variant), [{ path: "index.html", sha256: sha256(bytes) }])
})
