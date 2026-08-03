import assert from "node:assert/strict"
import { createHash, createHmac } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  admitApprovedPublication,
  createPublicationApprovalPreview,
  exportVerifiedPendingAuthority,
  loadVerifiedPendingAuthority,
  verifyPublicationApproval,
} from "../lib/publication-handoff.mjs"
import { computePlanDigest, computePublicSetDigest, jcsCanonicalize, loadPublicationRuntime, loadSealedCustodyByManifestId } from "../lib/publication-contracts.mjs"
import { sealVerifiedPublication } from "../lib/publication-release-handoff.mjs"

/** @param {Buffer} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const rootDir = path.resolve(import.meta.dirname, "..")

function sourceBytes() {
  const support = Buffer.from("---\ntitle: Release Support\ntype: concept\n---\n\n# Release Support\n\nA bounded local release fixture.\n")
  const paper = Buffer.from("---\ntitle: Release Paper\ntype: literature-note\nstatus: integrated\n---\n\n# Release Paper\n\n## Bibliography\n\nNot stated.\n\n## One-sentence Takeaway\n\nA bounded local release fixture.\n\n## Research Question\n\nHow does the pinned release preserve exact bytes?\n\n## Citation\n\nNot stated.\n\n## Connections\n\n[[Knowledge/Concepts/release-support|Release Support]]\n")
  return new Map([
    ["Knowledge/Concepts/release-support.md", { bytes: support, public_id: "release-support", node_class: "concept" }],
    ["Literature/Notes/release-paper.md", { bytes: paper, public_id: "release-paper", node_class: "paper" }],
  ])
}

/** @param {import("node:test").TestContext} t @param {string} [manifestId] */
async function validFixture(t, manifestId = "VPUB-20260802-release-positive") {
  const root = await mkdtemp(path.join(os.tmpdir(), "t11-release-positive-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtimeRoot = path.join(root, "runtime")
  const exportRoot = path.join(root, "export")
  const releasesRoot = path.join(root, "releases")
  const vaultRoot = path.join(root, "vault")
  const workRoot = path.join(root, "work")
  await Promise.all([runtimeRoot, vaultRoot, workRoot, releasesRoot].map((dir) => mkdir(dir, { recursive: true })))
  const sources = sourceBytes()
  const manifest = {
    schema_version: 1,
    manifest_id: manifestId,
    created_at: "2026-08-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    action: {
      kind: "publish-unit",
      baseline: { kind: "genesis" },
      primary_id: "release-paper",
      support_ids: ["release-support"],
      added_node_ids: ["release-paper", "release-support"],
      direct_connection_edges: [{ source: "release-paper", target: "release-support" }],
    },
    nodes: [...sources].map(([filePath, value]) => ({ path: filePath, public_id: value.public_id, node_class: value.node_class, source_sha256: sha256(value.bytes) })).sort((left, right) => Buffer.compare(Buffer.from(left.public_id), Buffer.from(right.public_id))),
    public_set_digest: "0".repeat(64),
    approval_receipt: {
      approver: "tyler",
      channel: "telegram",
      source_event_id: "t11-release-positive",
      approved_plan_digest: "0".repeat(64),
      approved_at: "2026-08-01T00:01:00Z",
    },
    plan_digest: "0".repeat(64),
  }
  manifest.public_set_digest = computePublicSetDigest(manifest.nodes)
  manifest.plan_digest = computePlanDigest(manifest)
  manifest.approval_receipt.approved_plan_digest = manifest.plan_digest
  const approvalKey = Buffer.from("t11-test-approval-key-0123456789012345", "utf8")
  const preview = createPublicationApprovalPreview(manifest)
  const approvalEnvelope = {
    schema_version: 1,
    approver: "tyler",
    channel: "telegram",
    source_event_id: `${manifestId}-approval`,
    approved_plan_digest: manifest.plan_digest,
    approved_preview_digest: sha256(Buffer.from(jcsCanonicalize(preview), "utf8")),
    approved_at: manifest.approval_receipt.approved_at,
    authentication_tag: "0".repeat(64),
  }
  approvalEnvelope.authentication_tag = createHmac("sha256", approvalKey)
    .update(jcsCanonicalize({
      approved_at: approvalEnvelope.approved_at,
      approved_plan_digest: approvalEnvelope.approved_plan_digest,
      approved_preview_digest: approvalEnvelope.approved_preview_digest,
      approver: approvalEnvelope.approver,
      channel: approvalEnvelope.channel,
      schema_version: approvalEnvelope.schema_version,
      source_event_id: approvalEnvelope.source_event_id,
    }))
    .digest("hex")
  const approvalAuthority = await verifyPublicationApproval({ plan: manifest, approvalEnvelope, approvalKey })
  await admitApprovedPublication({ approvalAuthority, runtimeRoot, plan: manifest })
  const admittedManifestRaw = await readFile(path.join(runtimeRoot, "pending", `${manifest.manifest_id}.json`))
  const providerCalls = { list: 0, read: 0 }
  const provider = {
    list: async () => {
      providerCalls.list += 1
      return {
        entries: [...sources].map(([filePath, value]) => ({ metadata: { etag: value.public_id }, node_class: value.node_class, path: filePath, public_id: value.public_id, version: "1" })),
        snapshot: { id: "release-positive" },
      }
    },
    read: async (/** @type {string} */ filePath) => {
      providerCalls.read += 1
      const value = sources.get(filePath)
      if (!value) throw new Error("fixture source missing")
      return { bytes: value.bytes, metadata: { etag: value.public_id }, node_class: value.node_class, path: filePath, public_id: value.public_id, snapshot: { id: "release-positive" }, version: "1" }
    },
  }
  const authority = await loadVerifiedPendingAuthority(runtimeRoot)
  const formalBuildInput = await exportVerifiedPendingAuthority({ authority, provider, exportRoot })
  return { root, runtimeRoot, exportRoot, releasesRoot, vaultRoot, workRoot, authority, formalBuildInput, manifest, admittedManifestRaw, providerCalls }
}

test("verified pending + verified export perform actual pinned Quartz sealing and consume pending", async (t) => {
  const fixture = await validFixture(t)
  const result = await sealVerifiedPublication({
    pendingAuthority: fixture.authority,
    formalBuildInput: fixture.formalBuildInput.formalBuildInput,
    trustedRoots: { releasesRoot: fixture.releasesRoot, vaultRoot: fixture.vaultRoot, workRoot: fixture.workRoot },
  })
  assert.equal(result.state, "sealed")
  assert.equal(result.custody, "consumed")
  assert.equal(result.manifestId, fixture.manifest.manifest_id)
  assert.equal(result.receiptVerified, true)
  assert.deepEqual(await readdir(path.join(fixture.runtimeRoot, "pending")), [])
  const runtime = await loadPublicationRuntime(fixture.runtimeRoot)
  const custody = await loadSealedCustodyByManifestId(fixture.runtimeRoot, fixture.manifest.manifest_id)
  assert.equal(runtime.currentPointer.release_digest, custody.receipt.release_digest)
  assert.equal((await readFile(path.join(fixture.releasesRoot, custody.receipt.release_digest, "index.html"))).length > 0, true)
})

test("forged export capability and manifest mismatch fail before build without consuming pending", async (t) => {
  const fixture = await validFixture(t)
  const pendingPath = path.join(fixture.runtimeRoot, "pending", `${fixture.manifest.manifest_id}.json`)
  const before = await readFile(pendingPath)
  await assert.rejects(
    sealVerifiedPublication({
      pendingAuthority: fixture.authority,
      formalBuildInput: {},
      trustedRoots: { releasesRoot: fixture.releasesRoot, vaultRoot: fixture.vaultRoot, workRoot: fixture.workRoot },
    }),
    (/** @type {any} */ error) => error?.code === "EXPORT_INPUT_UNVERIFIED",
  )
  assert((await readFile(pendingPath)).equals(before))

  const other = await validFixture(t, "VPUB-20260802-release-other")
  await assert.rejects(
    sealVerifiedPublication({
      pendingAuthority: fixture.authority,
      formalBuildInput: other.formalBuildInput.formalBuildInput,
      trustedRoots: { releasesRoot: fixture.releasesRoot, vaultRoot: fixture.vaultRoot, workRoot: fixture.workRoot },
    }),
    (/** @type {any} */ error) => error?.code === "RELEASE_MANIFEST_BINDING_MISMATCH",
  )
  assert((await readFile(pendingPath)).equals(before))
})

test("transient pinned build failure preserves LKG and leaves pending retryable", async (t) => {
  const fixture = await validFixture(t)
  await writeFile(path.join(fixture.exportRoot, "Literature", "Notes", "release-paper.md"), "transient source change\n")
  await assert.rejects(
    sealVerifiedPublication({
      pendingAuthority: fixture.authority,
      formalBuildInput: fixture.formalBuildInput.formalBuildInput,
      trustedRoots: { releasesRoot: fixture.releasesRoot, vaultRoot: fixture.vaultRoot, workRoot: fixture.workRoot },
    }),
    (/** @type {any} */ error) => typeof error?.code === "string" && error.code.length > 0,
  )
  assert.deepEqual(await readdir(path.join(fixture.runtimeRoot, "pending")), [`${fixture.manifest.manifest_id}.json`])
  assert.deepEqual(await readdir(fixture.releasesRoot), [])
  assert.deepEqual(await readdir(fixture.workRoot), [])
})

test("exact replay reuses the sealed release without rebuilding or recustody", async (t) => {
  const fixture = await validFixture(t)
  const input = {
    pendingAuthority: fixture.authority,
    formalBuildInput: fixture.formalBuildInput.formalBuildInput,
    trustedRoots: { releasesRoot: fixture.releasesRoot, vaultRoot: fixture.vaultRoot, workRoot: fixture.workRoot },
  }
  const first = await sealVerifiedPublication(input)
  const releaseNames = await readdir(fixture.releasesRoot)
  const replay = await sealVerifiedPublication(input)
  assert.equal(replay.releaseDigest, first.releaseDigest)
  assert.deepEqual(await readdir(fixture.releasesRoot), releaseNames)
  assert.deepEqual(await readdir(path.join(fixture.runtimeRoot, "pending")), [])
})

test("forged pending authority and reflective public inputs fail before release work", async (t) => {
  const fixture = await validFixture(t, "VPUB-20260802-release-forged-pending")
  const pendingPath = path.join(fixture.runtimeRoot, "pending", `${fixture.manifest.manifest_id}.json`)
  const before = await readFile(pendingPath)
  const roots = { releasesRoot: fixture.releasesRoot, vaultRoot: fixture.vaultRoot, workRoot: fixture.workRoot }
  await assert.rejects(
    sealVerifiedPublication({ pendingAuthority: {}, formalBuildInput: fixture.formalBuildInput.formalBuildInput, trustedRoots: roots }),
    (/** @type {any} */ error) => error?.code === "PENDING_AUTHORITY_UNVERIFIED",
  )
  assert((await readFile(pendingPath)).equals(before))
  assert.deepEqual(await readdir(fixture.releasesRoot), [])
  assert.deepEqual(await readdir(fixture.workRoot), [])

  let trapped = false
  const input = new Proxy({ pendingAuthority: fixture.authority, formalBuildInput: fixture.formalBuildInput.formalBuildInput, trustedRoots: roots }, {
    get() { trapped = true; throw new Error("getter must not run") },
    ownKeys() { trapped = true; throw new Error("ownKeys trap must not run") },
  })
  await assert.rejects(sealVerifiedPublication(input), (/** @type {any} */ error) => error?.code === "RELEASE_HANDOFF_INPUT_INVALID")
  assert.equal(trapped, false)

  trapped = false
  const rootProxy = new Proxy(roots, {
    get() { trapped = true; throw new Error("trusted root getter must not run") },
    ownKeys() { trapped = true; throw new Error("trusted root ownKeys trap must not run") },
  })
  await assert.rejects(
    sealVerifiedPublication({ pendingAuthority: fixture.authority, formalBuildInput: fixture.formalBuildInput.formalBuildInput, trustedRoots: rootProxy }),
    (/** @type {any} */ error) => error?.code === "RELEASE_HANDOFF_ROOTS_INVALID",
  )
  assert.equal(trapped, false)
  assert.deepEqual(fixture.providerCalls, { list: 1, read: 4 })
})

test("authority tamper after verification enters canonical rejected custody without build or provider work", async (t) => {
  const fixture = await validFixture(t, "VPUB-20260802-release-tampered")
  const pendingPath = path.join(fixture.runtimeRoot, "pending", `${fixture.manifest.manifest_id}.json`)
  await writeFile(pendingPath, Buffer.from('{"tampered":true}\n'))
  const result = await sealVerifiedPublication({
    pendingAuthority: fixture.authority,
    formalBuildInput: fixture.formalBuildInput.formalBuildInput,
    trustedRoots: { releasesRoot: fixture.releasesRoot, vaultRoot: fixture.vaultRoot, workRoot: fixture.workRoot },
  })
  assert.equal(result.state, "rejected")
  assert.equal(result.reasonCode, "PENDING_AUTHORITY_TAMPERED")
  assert.deepEqual(fixture.providerCalls, { list: 1, read: 4 })
  assert.deepEqual(await readdir(fixture.releasesRoot), [])
  assert.deepEqual(await readdir(fixture.workRoot), [])
  const rejectedRoot = path.join(fixture.runtimeRoot, "rejected", fixture.manifest.manifest_id)
  assert.deepEqual((await readdir(rejectedRoot)).sort(), ["manifest.json", "rejection.json"])
  assert((await readFile(path.join(rejectedRoot, "manifest.json"))).equals(fixture.admittedManifestRaw))
  const rejection = {
    schema_version: 1,
    manifest_id: fixture.manifest.manifest_id,
    reason_code: "PENDING_AUTHORITY_TAMPERED",
  }
  assert.equal(
    await readFile(path.join(rejectedRoot, "rejection.json"), "utf8"),
    `${jcsCanonicalize(rejection)}\n`,
  )
  assert.deepEqual(await readdir(path.join(fixture.runtimeRoot, "pending")), [])
})

test("rejected custody refuses a case-aliased runtime state before mutation", async (t) => {
  const fixture = await validFixture(t, "VPUB-20260802-release-rejected-alias")
  const pendingPath = path.join(fixture.runtimeRoot, "pending", `${fixture.manifest.manifest_id}.json`)
  const tampered = Buffer.from('{"tampered":true}\n')
  await writeFile(pendingPath, tampered)
  await mkdir(path.join(fixture.runtimeRoot, "Rejected"))

  await assert.rejects(
    sealVerifiedPublication({
      pendingAuthority: fixture.authority,
      formalBuildInput: fixture.formalBuildInput.formalBuildInput,
      trustedRoots: { releasesRoot: fixture.releasesRoot, vaultRoot: fixture.vaultRoot, workRoot: fixture.workRoot },
    }),
    (/** @type {any} */ error) => error?.code === "REJECTED_CUSTODY_TRANSITION_FAILED",
  )

  assert((await readFile(pendingPath)).equals(tampered))
  assert.deepEqual(await readdir(path.join(fixture.runtimeRoot, "Rejected")), [])
  assert.deepEqual(await readdir(fixture.releasesRoot), [])
  assert.deepEqual(await readdir(fixture.workRoot), [])
  assert.deepEqual(fixture.providerCalls, { list: 1, read: 4 })
})
