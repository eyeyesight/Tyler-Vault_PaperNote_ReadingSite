// @ts-nocheck -- the synthetic tracer intentionally assembles contract fixtures.
import assert from "node:assert/strict"
import { createHash, createHmac } from "node:crypto"
import { spawn } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
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
import { computePlanDigest, computePublicSetDigest, jcsCanonicalize } from "../lib/publication-contracts.mjs"
import { verifiedSealedReleaseIdentity, revalidateVerifiedSealedRelease } from "../lib/verified-sealed-release.mjs"
import {
  createT12DeploymentHandoff,
  loadT12DeploymentHandoff,
  readT12DeploymentHandoff,
  t12DeploymentCandidate,
} from "../lib/publication-t12-handoff.mjs"

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

function sourceBytes() {
  const support = Buffer.from("---\ntitle: Release Support\ntype: concept\n---\n\n# Release Support\n\nA bounded local release fixture.\n")
  const paper = Buffer.from("---\ntitle: Release Paper\ntype: literature-note\nstatus: integrated\n---\n\n# Release Paper\n\n## Bibliography\n\nNot stated.\n\n## One-sentence Takeaway\n\nA bounded local release fixture.\n\n## Research Question\n\nHow does the pinned release preserve exact bytes?\n\n## Citation\n\nNot stated.\n\n## Connections\n\n[[Knowledge/Concepts/release-support|Release Support]]\n")
  return new Map([
    ["Knowledge/Concepts/release-support.md", { bytes: support, public_id: "release-support", node_class: "concept" }],
    ["Literature/Notes/release-paper.md", { bytes: paper, public_id: "release-paper", node_class: "paper" }],
  ])
}

function approvalEnvelope(plan) {
  const preview = createPublicationApprovalPreview(plan)
  const payload = {
    approved_at: "2026-08-01T00:01:00Z",
    approved_plan_digest: plan.plan_digest,
    approved_preview_digest: sha256(jcsCanonicalize(preview)),
    approver: "tyler",
    channel: "telegram",
    schema_version: 1,
    source_event_id: "t11-t12-handoff-tracer",
  }
  return {
    ...payload,
    authentication_tag: createHmac("sha256", Buffer.from("12".repeat(32), "hex"))
      .update(jcsCanonicalize(payload)).digest("hex"),
  }
}

async function snapshotTree(root) {
  const result = []
  async function walk(directory, relative = "") {
    for (const name of (await readdir(directory)).sort()) {
      const child = path.join(directory, name)
      const childRelative = path.join(relative, name)
      const metadata = await lstat(child)
      try {
        await readdir(child)
        result.push({ path: childRelative, kind: "directory", mtimeMs: metadata.mtimeMs })
        await walk(child, childRelative)
      } catch (error) {
        if (error?.code !== "ENOTDIR") throw error
        result.push({ path: childRelative, kind: "file", bytes: (await readFile(child)).toString("hex"), mtimeMs: metadata.mtimeMs })
      }
    }
  }
  await walk(root)
  return result
}

async function tracerFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "t12-handoff-tracer-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtimeRoot = path.join(root, "runtime")
  const exportRoot = path.join(root, "export")
  const releasesRoot = path.join(root, "releases")
  const vaultRoot = path.join(root, "vault")
  const workRoot = path.join(root, "work")
  await Promise.all([runtimeRoot, releasesRoot, vaultRoot, workRoot].map((dir) => mkdir(dir)))
  const sources = sourceBytes()
  const plan = {
    schema_version: 1,
    manifest_id: "VPUB-20260802-t12-handoff",
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
    nodes: [...sources].map(([filePath, value]) => ({
      path: filePath, public_id: value.public_id, node_class: value.node_class, source_sha256: sha256(value.bytes),
    })).sort((a, b) => Buffer.compare(Buffer.from(a.public_id), Buffer.from(b.public_id))),
    public_set_digest: "0".repeat(64),
    plan_digest: "0".repeat(64),
  }
  plan.public_set_digest = computePublicSetDigest(plan.nodes)
  plan.plan_digest = computePlanDigest(plan)
  const preview = createPublicationApprovalPreview(plan)
  const approvalAuthority = verifyPublicationApproval({
    plan,
    approvalEnvelope: approvalEnvelope(plan),
    approvalKey: Buffer.from("12".repeat(32), "hex"),
  })
  await admitApprovedPublication({
    approvalAuthority,
    runtimeRoot,
    plan,
  })
  const authority = await loadVerifiedPendingAuthority(runtimeRoot)
  const providerCalls = { list: 0, read: 0 }
  const provider = {
    list: async () => {
      providerCalls.list += 1
      return {
        entries: [...sources].map(([filePath, value]) => ({
          metadata: { etag: value.public_id }, node_class: value.node_class, path: filePath, public_id: value.public_id, version: "1",
        })),
        snapshot: { id: "t12-handoff-tracer" },
      }
    },
    read: async (filePath) => {
      providerCalls.read += 1
      const value = sources.get(filePath)
      if (!value) throw new Error("fixture source missing")
      return {
        bytes: value.bytes, metadata: { etag: value.public_id }, node_class: value.node_class,
        path: filePath, public_id: value.public_id, snapshot: { id: "t12-handoff-tracer" }, version: "1",
      }
    },
  }
  const exportResult = await exportVerifiedPendingAuthority({ authority, provider, exportRoot })
  return {
    root, runtimeRoot, releasesRoot, vaultRoot, workRoot, authority,
    formalBuildInput: exportResult.formalBuildInput, providerCalls, plan, preview,
  }
}

function runRecoveryChild(input) {
  const handoffUrl = new URL("../lib/publication-t12-handoff.mjs", import.meta.url).href
  const sealedUrl = new URL("../lib/verified-sealed-release.mjs", import.meta.url).href
  const script = `import { loadT12DeploymentHandoff, readT12DeploymentHandoff, t12DeploymentCandidate } from ${JSON.stringify(handoffUrl)}; import { verifiedSealedReleaseIdentity } from ${JSON.stringify(sealedUrl)}; const handle = await loadT12DeploymentHandoff(JSON.parse(process.env.T12_RECOVERY_INPUT)); const summary = await readT12DeploymentHandoff(handle); const identity = verifiedSealedReleaseIdentity(await t12DeploymentCandidate(handle)); process.stdout.write(JSON.stringify({ summary, identity }));`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, T12_RECOVERY_INPUT: JSON.stringify(input) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8") })
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8") })
    child.once("error", reject)
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`recovery child failed: ${stderr}`))
      else {
        try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) }
      }
    })
  })
}

test("same-process concurrent T12 creation seals exactly once and returns one handle", async (t) => {
  const fixture = await tracerFixture(t)
  const input = {
    pendingAuthority: fixture.authority,
    formalBuildInput: fixture.formalBuildInput,
    trustedRoots: { releasesRoot: fixture.releasesRoot, vaultRoot: fixture.vaultRoot, workRoot: fixture.workRoot },
  }
  const handles = await Promise.all([
    createT12DeploymentHandoff(input),
    createT12DeploymentHandoff(input),
    createT12DeploymentHandoff(input),
  ])
  assert(handles.every((handle) => handle === handles[0]))
  assert.deepEqual(fixture.providerCalls, { list: 1, read: 4 })
  assert.deepEqual(verifiedSealedReleaseIdentity(await t12DeploymentCandidate(handles[0])), verifiedSealedReleaseIdentity(await t12DeploymentCandidate(handles[1])))
})

test("fresh-process T12 recovery remints the same redacted summary without mutation", async (t) => {
  const fixture = await tracerFixture(t)
  const input = {
    pendingAuthority: fixture.authority,
    formalBuildInput: fixture.formalBuildInput,
    trustedRoots: { releasesRoot: fixture.releasesRoot, vaultRoot: fixture.vaultRoot, workRoot: fixture.workRoot },
  }
  const originalHandle = await createT12DeploymentHandoff(input)
  const expectedSummary = await readT12DeploymentHandoff(originalHandle)
  const expectedIdentity = verifiedSealedReleaseIdentity(await t12DeploymentCandidate(originalHandle))
  const recoveryInput = {
    runtimeRoot: fixture.runtimeRoot,
    releasesRoot: fixture.releasesRoot,
    manifestId: fixture.plan.manifest_id,
  }
  const before = await Promise.all([
    snapshotTree(fixture.runtimeRoot),
    snapshotTree(fixture.releasesRoot),
    snapshotTree(fixture.workRoot),
  ])
  const recovered = await runRecoveryChild(recoveryInput)
  assert.deepEqual(recovered, { summary: expectedSummary, identity: expectedIdentity })
  assert.deepEqual(await Promise.all([
    snapshotTree(fixture.runtimeRoot),
    snapshotTree(fixture.releasesRoot),
    snapshotTree(fixture.workRoot),
  ]), before)
  assert.deepEqual(fixture.providerCalls, { list: 1, read: 4 })

  const extra = { ...recoveryInput, receipt: "caller-supplied-receipt" }
  await assert.rejects(loadT12DeploymentHandoff(extra), (error) => error?.code === "T12_HANDOFF_RECOVERY_INPUT_INVALID")
  let trapped = false
  const proxy = new Proxy(recoveryInput, { get() { trapped = true; throw new Error("must not reflect") }, ownKeys() { trapped = true; throw new Error("must not reflect") } })
  await assert.rejects(loadT12DeploymentHandoff(proxy), (error) => error?.code === "T12_HANDOFF_RECOVERY_INPUT_INVALID")
  assert.equal(trapped, false)
  const accessor = { ...recoveryInput }
  Object.defineProperty(accessor, "runtimeRoot", { enumerable: true, get() { trapped = true; throw new Error("getter must not run") } })
  await assert.rejects(loadT12DeploymentHandoff(accessor), (error) => error?.code === "T12_HANDOFF_RECOVERY_INPUT_INVALID")
  assert.equal(trapped, false)
  if (process.platform === "win32") {
    const alternateDriveCase = (root) => `${root[0] === root[0].toLowerCase() ? root[0].toUpperCase() : root[0].toLowerCase()}${root.slice(1)}`
    await assert.rejects(loadT12DeploymentHandoff({
      ...recoveryInput,
      runtimeRoot: alternateDriveCase(recoveryInput.runtimeRoot),
    }), (error) => error?.code === "T12_HANDOFF_ROOTS_INVALID")
  }
  const pointerPath = path.join(fixture.runtimeRoot, "current-release.json")
  const pointerBytes = await readFile(pointerPath)
  const pointer = JSON.parse(pointerBytes.toString("utf8"))
  pointer.release_digest = "0".repeat(64)
  await writeFile(pointerPath, `${jcsCanonicalize(pointer)}\n`)
  const tampered = await Promise.all([
    snapshotTree(fixture.runtimeRoot),
    snapshotTree(fixture.releasesRoot),
  ])
  await assert.rejects(loadT12DeploymentHandoff(recoveryInput), /custody|current|digest/i)
  assert.deepEqual(await Promise.all([
    snapshotTree(fixture.runtimeRoot),
    snapshotTree(fixture.releasesRoot),
  ]), tampered)
  await writeFile(pointerPath, pointerBytes)
})

test("T12 tracer mints a redacted opaque handoff and exact replay only revalidates", async (t) => {
  const fixture = await tracerFixture(t)
  const input = {
    pendingAuthority: fixture.authority,
    formalBuildInput: fixture.formalBuildInput,
    trustedRoots: { releasesRoot: fixture.releasesRoot, vaultRoot: fixture.vaultRoot, workRoot: fixture.workRoot },
  }
  const handoff = await createT12DeploymentHandoff(input)
  assert.equal(Object.isFrozen(handoff), true)
  assert.deepEqual(Reflect.ownKeys(handoff), [])
  const summary = await readT12DeploymentHandoff(handoff)
  assert.deepEqual(Object.keys(summary).sort(), [
    "approvedRoutes", "lifecycleDigest", "manifestId", "planDigest", "publicSetDigest",
    "receiptRef", "releaseDigest", "sealedReleaseRef", "status",
  ].sort())
  assert.equal(summary.status, "ready-for-t12")
  assert.equal(summary.manifestId, fixture.plan.manifest_id)
  assert.equal(summary.planDigest, fixture.plan.plan_digest)
  assert.equal(summary.publicSetDigest, fixture.plan.public_set_digest)
  assert.deepEqual(summary.approvedRoutes, fixture.preview.routes.map((route) => route.route))
  const serialized = JSON.stringify(summary)
  assert.doesNotMatch(serialized, /C:\\|\\\\|\/tmp\/|publication-manifest|release-receipt|export-receipt|\.md|\.pdf|zotero|drive|credential|approval_receipt|source_event_id/i)

  const candidate = await t12DeploymentCandidate(handoff)
  const identity = verifiedSealedReleaseIdentity(candidate)
  assert.equal(identity.releaseId, fixture.plan.manifest_id)
  await revalidateVerifiedSealedRelease(candidate)
  assert.deepEqual(fixture.providerCalls, { list: 1, read: 4 })

  const beforeReplay = await Promise.all([snapshotTree(fixture.runtimeRoot), snapshotTree(fixture.releasesRoot), snapshotTree(fixture.workRoot)])
  const replay = await createT12DeploymentHandoff({
    pendingAuthority: fixture.authority,
    formalBuildInput: fixture.formalBuildInput,
    trustedRoots: { releasesRoot: fixture.releasesRoot, vaultRoot: fixture.vaultRoot, workRoot: fixture.workRoot },
  })
  assert.strictEqual(replay, handoff)
  assert.equal(JSON.stringify(await readT12DeploymentHandoff(replay)), JSON.stringify(summary))
  assert.deepEqual(await Promise.all([snapshotTree(fixture.runtimeRoot), snapshotTree(fixture.releasesRoot), snapshotTree(fixture.workRoot)]), beforeReplay)
  assert.deepEqual(fixture.providerCalls, { list: 1, read: 4 })

  if (process.platform === "win32") {
    const alternateDriveCase = (root) => `${root[0] === root[0].toLowerCase() ? root[0].toUpperCase() : root[0].toLowerCase()}${root.slice(1)}`
    const aliasReplay = await createT12DeploymentHandoff({
      pendingAuthority: fixture.authority,
      formalBuildInput: fixture.formalBuildInput,
      trustedRoots: {
        releasesRoot: alternateDriveCase(fixture.releasesRoot),
        vaultRoot: alternateDriveCase(fixture.vaultRoot),
        workRoot: alternateDriveCase(fixture.workRoot),
      },
    })
    assert.strictEqual(aliasReplay, handoff)
    assert.deepEqual(await Promise.all([snapshotTree(fixture.runtimeRoot), snapshotTree(fixture.releasesRoot), snapshotTree(fixture.workRoot)]), beforeReplay)
  }

  const originalWorkRoot = `${fixture.workRoot}-original`
  await rename(fixture.workRoot, originalWorkRoot)
  await mkdir(fixture.workRoot)
  await assert.rejects(
    readT12DeploymentHandoff(handoff),
    (error) => error?.code === "T12_HANDOFF_ROOTS_INVALID",
  )
  await rm(fixture.workRoot, { recursive: true, force: true })
  await rename(originalWorkRoot, fixture.workRoot)
  assert.equal(JSON.stringify(await readT12DeploymentHandoff(handoff)), JSON.stringify(summary))
})

test("T12 handoff rejects reflective, copied, and tampered handles before exposing custody", async (t) => {
  const fixture = await tracerFixture(t)
  const input = {
    pendingAuthority: fixture.authority,
    formalBuildInput: fixture.formalBuildInput,
    trustedRoots: { releasesRoot: fixture.releasesRoot, vaultRoot: fixture.vaultRoot, workRoot: fixture.workRoot },
  }
  const handoff = await createT12DeploymentHandoff(input)
  await assert.rejects(() => readT12DeploymentHandoff({ ...handoff }), /handoff/i)
  await assert.rejects(() => readT12DeploymentHandoff(JSON.parse(JSON.stringify(handoff))), /handoff/i)
  let trapped = false
  const proxy = new Proxy(input, { get() { trapped = true; throw new Error("must not reflect") }, ownKeys() { trapped = true; throw new Error("must not reflect") } })
  await assert.rejects(createT12DeploymentHandoff(proxy), (error) => error?.code === "T12_HANDOFF_INPUT_INVALID")
  assert.equal(trapped, false)
  const extra = { ...input, extra: true }
  await assert.rejects(createT12DeploymentHandoff(extra), (error) => error?.code === "T12_HANDOFF_INPUT_INVALID")
  const hidden = { ...input }
  Object.defineProperty(hidden, "hidden", { value: true, enumerable: false })
  await assert.rejects(createT12DeploymentHandoff(hidden), (error) => error?.code === "T12_HANDOFF_INPUT_INVALID")
  const symbolized = { ...input, [Symbol("hidden")]: true }
  await assert.rejects(createT12DeploymentHandoff(symbolized), (error) => error?.code === "T12_HANDOFF_INPUT_INVALID")
  const getter = { ...input }
  Object.defineProperty(getter, "formalBuildInput", { enumerable: true, get() { trapped = true; throw new Error("getter must not run") } })
  await assert.rejects(createT12DeploymentHandoff(getter), (error) => error?.code === "T12_HANDOFF_INPUT_INVALID")
  assert.equal(trapped, false)
  const rootExtra = { ...input, trustedRoots: { ...input.trustedRoots, extra: true } }
  await assert.rejects(createT12DeploymentHandoff(rootExtra), (error) => error?.code === "T12_HANDOFF_ROOTS_INVALID")
  const rootProxy = new Proxy(input.trustedRoots, { get() { trapped = true; throw new Error("root getter must not run") }, ownKeys() { trapped = true; throw new Error("root ownKeys must not run") } })
  await assert.rejects(createT12DeploymentHandoff({ ...input, trustedRoots: rootProxy }), (error) => error?.code === "T12_HANDOFF_ROOTS_INVALID")
  assert.equal(trapped, false)

  const before = await snapshotTree(fixture.releasesRoot)
  const currentPointer = path.join(fixture.runtimeRoot, "current-release.json")
  const pointer = JSON.parse(await readFile(currentPointer, "utf8"))
  pointer.release_digest = "0".repeat(64)
  await writeFile(currentPointer, `${jcsCanonicalize(pointer)}\n`)
  await assert.rejects(() => readT12DeploymentHandoff(handoff), /custody|current|digest/i)
  await assert.rejects(() => createT12DeploymentHandoff(input), /custody|current|digest/i)
  assert.deepEqual(await snapshotTree(fixture.releasesRoot), before)
})
