import assert from "node:assert/strict"
import { createHash, createHmac } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  admitApprovedPublication,
  consumeVerifiedPendingAuthority,
  consumeVerifiedExportInput,
  createPublicationApprovalPreview,
  exportVerifiedPendingAuthority,
  isVerifiedPendingAuthority,
  loadVerifiedPendingAuthority,
  verifyPublicationApproval,
} from "../lib/publication-handoff.mjs"
import {
  computePlanDigest,
  computePublicSetDigest,
  jcsCanonicalize,
  readContractJson,
  validateContract,
} from "../lib/publication-contracts.mjs"
import { constructReleaseReceipt } from "../lib/safe-release.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const examplePath = path.join(repoRoot, "specs", "examples", "publish-unit-manifest-v1.example.json")
const approvalKey = Buffer.from("11".repeat(32), "hex")

/** @param {number} offsetMs */
function relativeIso(offsetMs) {
  return new Date(Math.floor((Date.now() + offsetMs) / 1000) * 1000).toISOString().replace(".000Z", "Z")
}

/** @typedef {{path:string,public_id:string,node_class:string,source_sha256:string}} TestManifestNode */
/** @typedef {{manifest_id:string,nodes:TestManifestNode[]}} TestManifest */
/** @typedef {{listCalls:number,readCalls:number,writeCalls:number}} ProviderStats */

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return typeof error === "object" && error !== null && /** @type {{code?:unknown}} */ (error).code === code
}

async function approvedPlan() {
  const manifest = JSON.parse(await readFile(examplePath, "utf8"))
  delete manifest.approval_receipt
  manifest.created_at = relativeIso(-60_000)
  manifest.expires_at = relativeIso(3_600_000)
  manifest.plan_digest = computePlanDigest(manifest)
  return manifest
}

/** @param {any} plan @param {Partial<{source_event_id:string,approved_at:string,approvalKey:Buffer}>} [options] */
function approvalFor(plan, options = {}) {
  const preview = createPublicationApprovalPreview(plan)
  const payload = {
    schema_version: 1,
    approver: "tyler",
    channel: "telegram",
    source_event_id: options.source_event_id ?? `telegram:test:${plan.manifest_id}`,
    approved_plan_digest: plan.plan_digest,
    approved_preview_digest: createHash("sha256").update(jcsCanonicalize(preview)).digest("hex"),
    approved_at: options.approved_at ?? relativeIso(-30_000),
  }
  const key = options.approvalKey ?? approvalKey
  return {
    ...payload,
    authentication_tag: createHmac("sha256", key).update(jcsCanonicalize(payload)).digest("hex"),
  }
}

/** @param {any} plan @param {Partial<{source_event_id:string,approved_at:string,approvalKey:Buffer}>} [options] */
async function verifiedApproval(plan, options = {}) {
  const approvalEnvelope = approvalFor(plan, options)
  return verifyPublicationApproval({ plan, approvalEnvelope, approvalKey: options.approvalKey ?? approvalKey })
}

async function currentPendingManifest() {
  const manifest = await approvedPlan()
  manifest.created_at = relativeIso(-60_000)
  manifest.expires_at = relativeIso(3_600_000)
  manifest.plan_digest = computePlanDigest(manifest)
  manifest.approval_receipt = {
    approver: "tyler",
    channel: "telegram",
    source_event_id: "telegram:test:pending-authority",
    approved_plan_digest: manifest.plan_digest,
    approved_at: relativeIso(-30_000),
  }
  return manifest
}

/** @param {any} envelope @param {Buffer} [key] */
function resealApprovalEnvelope(envelope, key = approvalKey) {
  const payload = { ...envelope }
  delete payload.authentication_tag
  return {
    ...payload,
    authentication_tag: createHmac("sha256", key).update(jcsCanonicalize(payload)).digest("hex"),
  }
}

/** @param {import("node:test").TestContext} t */
async function currentReleaseFixture(t) {
  const fixture = await mkdtemp(path.join(tmpdir(), "publication-second-release-"))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const runtimeRoot = path.join(fixture, "runtime")
  await mkdir(runtimeRoot)
  const manifest = await currentPendingManifest()
  const projectedMarkdown = new Map([
    ["flow", Buffer.from("# Flow\n")],
    ["jackman-2021", Buffer.from("# Jackman\n")],
  ])
  const receipt = await constructReleaseReceipt({
    manifest,
    createdAt: relativeIso(-10_000),
    projectedMarkdown,
    artifacts: [{ path: "graph.json", sha256: createHash("sha256").update("graph\n").digest("hex") }],
  })
  const consumedRoot = path.join(runtimeRoot, "consumed", manifest.manifest_id)
  await mkdir(consumedRoot, { recursive: true })
  await writeFile(path.join(consumedRoot, "manifest.json"), `${jcsCanonicalize(manifest)}\n`)
  await writeFile(path.join(consumedRoot, "release-receipt.json"), `${jcsCanonicalize(receipt)}\n`)
  await writeFile(path.join(runtimeRoot, "current-release.json"), `${jcsCanonicalize({
    schema_version: 1,
    release_digest: receipt.release_digest,
    receipt_path: `consumed/${manifest.manifest_id}/release-receipt.json`,
  })}\n`)
  return { fixture, runtimeRoot, manifest, receipt }
}

/** @param {any} currentManifest @param {any} receipt @param {{wrongBaseline?:boolean}} [options] */
function secondPublicationPlan(currentManifest, receipt, options = {}) {
  const plan = structuredClone(currentManifest)
  delete plan.approval_receipt
  plan.manifest_id = "VPUB-20260803-second"
  plan.created_at = relativeIso(-60_000)
  plan.expires_at = relativeIso(3_600_000)
  plan.action = {
    kind: "publish-unit",
    baseline: {
      kind: "release",
      release_digest: options.wrongBaseline ? "0".repeat(64) : receipt.release_digest,
      receipt_path: `consumed/${currentManifest.manifest_id}/release-receipt.json`,
    },
    primary_id: "new-paper",
    support_ids: ["flow"],
    added_node_ids: ["new-paper"],
    direct_connection_edges: [{ source: "new-paper", target: "flow" }],
  }
  plan.nodes.push({
    public_id: "new-paper",
    path: "Literature/Notes/new-paper.md",
    node_class: "paper",
    source_sha256: "ef".repeat(32),
  })
  plan.nodes.sort((/** @type {any} */ first, /** @type {any} */ second) => Buffer.compare(Buffer.from(first.public_id), Buffer.from(second.public_id)))
  plan.public_set_digest = computePublicSetDigest(plan.nodes)
  plan.plan_digest = computePlanDigest(plan)
  return plan
}

/** @param {string} runtimeRoot @param {any} manifest @param {string} [filename] */
async function writePendingManifest(runtimeRoot, manifest, filename = `${manifest.manifest_id}.json`) {
  await mkdir(path.join(runtimeRoot, "pending"), { recursive: true })
  await writeFile(path.join(runtimeRoot, "pending", filename), `${jcsCanonicalize(manifest)}\n`)
}

/** @param {string} root */
async function snapshotTree(root) {
  /** @type {Array<{path:string,bytes?:string}>} */
  const snapshot = []
  /** @param {string} directory @param {string} [relative] */
  async function walk(directory, relative = "") {
    for (const name of (await readdir(directory)).sort()) {
      const child = path.join(directory, name)
      const childRelative = path.join(relative, name)
      try {
        const entries = await readdir(child)
        snapshot.push({ path: childRelative, bytes: undefined })
        await walk(child, childRelative)
      } catch (error) {
        if (/** @type {{code?:string}} */ (error)?.code !== "ENOTDIR") throw error
        snapshot.push({ path: childRelative, bytes: (await readFile(child)).toString("hex") })
      }
    }
  }
  await walk(root)
  return snapshot
}

test("approval preview exposes only the exact public route plan and redacted rights summary", async () => {
  const plan = await approvedPlan()
  plan.action.baseline = {
    kind: "release",
    release_digest: "ab".repeat(32),
    receipt_path: "consumed/VPUB-20260728-example/release-receipt.json",
  }
  plan.nodes.push({
    public_id: "study-method",
    path: "Knowledge/Methods/study-method.md",
    node_class: "method",
    source_sha256: "cd".repeat(32),
  })
  plan.nodes.sort((/** @type {any} */ first, /** @type {any} */ second) => Buffer.compare(Buffer.from(first.public_id), Buffer.from(second.public_id)))
  plan.public_set_digest = computePublicSetDigest(plan.nodes)
  plan.plan_digest = computePlanDigest(plan)

  assert.deepEqual(createPublicationApprovalPreview(plan), {
    routes: [
      { publicId: "flow", route: "/knowledge/concept/flow/", nodeClass: "concept", role: "support", status: "added" },
      { publicId: "jackman-2021", route: "/papers/jackman-2021/", nodeClass: "paper", role: "primary", status: "added" },
      { publicId: "study-method", route: "/knowledge/method/study-method/", nodeClass: "method", role: "retained", status: "existing" },
    ],
    counts: { total: 3, added: 2, existing: 1, primary: 1, support: 1, retained: 1 },
    planDigest: plan.plan_digest,
    publicSetDigest: plan.public_set_digest,
    rightsNotice: "Tyler-authored content is all rights reserved. Third-party quotations, Zotero excerpts, bibliographic material, images, and linked works retain their original rights.",
  })
})

test("authenticated Tyler approval atomically admits the exact plan as the sole pending manifest", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "publication-handoff-"))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const runtimeRoot = path.join(fixture, "runtime")
  await mkdir(runtimeRoot)
  const plan = await approvedPlan()

  const envelope = approvalFor(plan, { source_event_id: "telegram:test:admit" })
  const approvalAuthority = await verifyPublicationApproval({ plan, approvalEnvelope: envelope, approvalKey })
  const result = await admitApprovedPublication({ approvalAuthority, runtimeRoot, plan })

  assert.deepEqual(result, {
    manifestId: plan.manifest_id,
    planDigest: plan.plan_digest,
    sourceEventId: envelope.source_event_id,
    state: "pending",
  })
  assert.deepEqual(await readdir(runtimeRoot), ["pending"])
  assert.deepEqual(await readdir(path.join(runtimeRoot, "pending")), [`${plan.manifest_id}.json`])

  const manifestPath = path.join(runtimeRoot, "pending", `${plan.manifest_id}.json`)
  const stored = await readContractJson(manifestPath)
  assert.deepEqual(stored, {
    ...plan,
    approval_receipt: {
      approver: "tyler",
      channel: "telegram",
      source_event_id: envelope.source_event_id,
      approved_plan_digest: plan.plan_digest,
      approved_at: envelope.approved_at,
    },
  })
  assert.equal(await readFile(manifestPath, "utf8"), `${jcsCanonicalize(stored)}\n`)
  await validateContract("publication-manifest", stored)
})

test("replaying the same authenticated approval is rejected without changing pending custody", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "publication-handoff-replay-"))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const runtimeRoot = path.join(fixture, "runtime")
  await mkdir(runtimeRoot)
  const plan = await approvedPlan()
  const approvalAuthority = await verifiedApproval(plan, { source_event_id: "telegram:test:replay" })
  const input = { approvalAuthority, runtimeRoot, plan }
  await admitApprovedPublication(input)
  const manifestPath = path.join(runtimeRoot, "pending", `${plan.manifest_id}.json`)
  const before = await readFile(manifestPath)

  await assert.rejects(admitApprovedPublication(input), (error) => hasCode(error, "APPROVAL_REPLAYED"))

  assert.deepEqual(await readdir(path.join(runtimeRoot, "pending")), [`${plan.manifest_id}.json`])
  assert((await readFile(manifestPath)).equals(before))
})

test("an approval event already preserved in consumed custody cannot create new pending authority", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "publication-handoff-consumed-replay-"))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const runtimeRoot = path.join(fixture, "runtime")
  await mkdir(runtimeRoot)
  const plan = await approvedPlan()
  const approvalAuthority = await verifiedApproval(plan, { source_event_id: "telegram:test:consumed-replay" })
  const input = { approvalAuthority, runtimeRoot, plan }
  await admitApprovedPublication(input)
  const pendingRoot = path.join(runtimeRoot, "pending")
  const pendingManifest = path.join(pendingRoot, `${plan.manifest_id}.json`)
  const consumedRoot = path.join(runtimeRoot, "consumed", plan.manifest_id)
  await mkdir(consumedRoot, { recursive: true })
  await rename(pendingManifest, path.join(consumedRoot, "manifest.json"))
  await rm(pendingRoot, { recursive: true })
  const before = await readFile(path.join(consumedRoot, "manifest.json"))

  await assert.rejects(admitApprovedPublication(input), (error) => hasCode(error, "APPROVAL_REPLAYED"))

  assert.deepEqual(await readdir(runtimeRoot), ["consumed"])
  assert((await readFile(path.join(consumedRoot, "manifest.json"))).equals(before))
})

test("an approval event already preserved in rejected custody cannot create new pending authority", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "publication-handoff-rejected-replay-"))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const runtimeRoot = path.join(fixture, "runtime")
  await mkdir(runtimeRoot)
  const plan = await approvedPlan()
  const approvalAuthority = await verifiedApproval(plan, { source_event_id: "telegram:test:rejected-replay" })
  const input = { approvalAuthority, runtimeRoot, plan }
  await admitApprovedPublication(input)
  const pendingRoot = path.join(runtimeRoot, "pending")
  const pendingManifest = path.join(pendingRoot, `${plan.manifest_id}.json`)
  const rejectedRoot = path.join(runtimeRoot, "rejected", plan.manifest_id)
  await mkdir(rejectedRoot, { recursive: true })
  await rename(pendingManifest, path.join(rejectedRoot, "manifest.json"))
  await rm(pendingRoot, { recursive: true })
  const before = await readFile(path.join(rejectedRoot, "manifest.json"))

  await assert.rejects(admitApprovedPublication(input), (error) => hasCode(error, "APPROVAL_REPLAYED"))

  assert.deepEqual(await readdir(runtimeRoot), ["rejected"])
  assert((await readFile(path.join(rejectedRoot, "manifest.json"))).equals(before))
})

test("invalid approval inputs fail closed before runtime mutation", async (t) => {
  /** @typedef {{plan:any,approvalEnvelope:any,approvalKey:Buffer}} VerificationInput */
  /** @type {Array<[string,string,(input:VerificationInput)=>void|Promise<void>]>} */
  const cases = [
    ["forged authentication tag", "APPROVAL_AUTHENTICATION_FAILED", (input) => {
      input.approvalEnvelope = { ...input.approvalEnvelope, authentication_tag: "0".repeat(64) }
    }],
    ["plan bytes changed after approval", "APPROVAL_PLAN_MISMATCH", (input) => {
      input.plan.nodes[0].source_sha256 = "0".repeat(64)
    }],
    ["expired approval window", "MANIFEST_EXPIRED", (input) => {
      input.plan.expires_at = relativeIso(-1_000)
      input.plan.plan_digest = computePlanDigest(input.plan)
      input.approvalEnvelope = approvalFor(input.plan)
    }],
    ["unknown envelope field", "APPROVAL_ENVELOPE_INVALID", (input) => {
      input.approvalEnvelope = { ...input.approvalEnvelope, unexpected: true }
    }],
    ["short authentication key", "APPROVAL_KEY_INVALID", (input) => {
      input.approvalKey = Buffer.alloc(31)
    }],
  ]

  for (const [name, code, mutate] of cases) {
    await t.test(name, async (caseTest) => {
      const fixture = await mkdtemp(path.join(tmpdir(), "publication-handoff-invalid-"))
      caseTest.after(() => rm(fixture, { recursive: true, force: true }))
      const runtimeRoot = path.join(fixture, "runtime")
      await mkdir(runtimeRoot)
      const plan = await approvedPlan()
      const input = {
        plan,
        approvalEnvelope: approvalFor(plan),
        approvalKey: Buffer.from(approvalKey),
      }
      await mutate(input)

      assert.throws(() => verifyPublicationApproval(input), (error) => hasCode(error, code))
      assert.deepEqual(await readdir(runtimeRoot), [])
    })
  }
})

test("valid HMAC with a wrong approved_preview_digest is rejected as APPROVAL_PREVIEW_MISMATCH", async () => {
  const plan = await approvedPlan()
  const approvalEnvelope = resealApprovalEnvelope({
    ...approvalFor(plan),
    approved_preview_digest: "0".repeat(64),
  })

  assert.throws(
    () => verifyPublicationApproval({ plan, approvalEnvelope, approvalKey }),
    (error) => hasCode(error, "APPROVAL_PREVIEW_MISMATCH"),
  )
})

test("approval verification rejects envelope accessors before invoking their getters", async () => {
  const plan = await approvedPlan()
  const envelope = approvalFor(plan)
  let getterCalls = 0
  Object.defineProperty(envelope, "approved_preview_digest", {
    configurable: true,
    enumerable: true,
    get() { getterCalls += 1; return "0".repeat(64) },
  })

  assert.throws(
    () => verifyPublicationApproval({ plan, approvalEnvelope: envelope, approvalKey }),
    (error) => hasCode(error, "APPROVAL_ENVELOPE_INVALID"),
  )
  assert.equal(getterCalls, 0)
})

test("approval verification rejects deep plan accessors and Proxies before any getter or trap", async () => {
  const accessorPlan = await approvedPlan()
  const envelope = approvalFor(accessorPlan)
  let getterCalls = 0
  Object.defineProperty(accessorPlan.nodes[0], "source_sha256", {
    configurable: true,
    enumerable: true,
    get() { getterCalls += 1; return "0".repeat(64) },
  })
  assert.throws(
    () => verifyPublicationApproval({ plan: accessorPlan, approvalEnvelope: envelope, approvalKey }),
    (error) => hasCode(error, "PUBLICATION_PLAN_INVALID"),
  )
  assert.equal(getterCalls, 0)

  const proxyPlan = await approvedPlan()
  const proxyEnvelope = approvalFor(proxyPlan)
  let trapCalls = 0
  proxyPlan.nodes[0] = new Proxy(proxyPlan.nodes[0], {
    get() { trapCalls += 1; return "unexpected" },
    ownKeys() { trapCalls += 1; return [] },
    getPrototypeOf() { trapCalls += 1; return Object.prototype },
  })
  assert.throws(
    () => verifyPublicationApproval({ plan: proxyPlan, approvalEnvelope: proxyEnvelope, approvalKey }),
    (error) => hasCode(error, "PUBLICATION_PLAN_INVALID"),
  )
  assert.equal(trapCalls, 0)
})

test("strict approval verification input rejects an extra now field", async () => {
  const plan = await approvedPlan()
  assert.throws(
    () => verifyPublicationApproval({ plan, approvalEnvelope: approvalFor(plan), approvalKey, now: new Date() }),
    (error) => hasCode(error, "APPROVAL_VERIFICATION_INVALID"),
  )
})

test("admission accepts only the opaque exact approval handle and leaves runtime unchanged for forgeries", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "publication-admission-handle-"))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const runtimeRoot = path.join(fixture, "runtime")
  await mkdir(runtimeRoot)
  const plan = await approvedPlan()
  const approvalAuthority = await verifiedApproval(plan, { source_event_id: "telegram:test:opaque-handle" })
  const candidates = [
    ["plain object", {}],
    ["copied handle", { ...approvalAuthority }],
    ["serialized handle", JSON.parse(JSON.stringify(approvalAuthority))],
    ["forged prototype", Object.create(approvalAuthority)],
    ["symbol handle", Object.assign(Object.create(null), { [Symbol("verified")]: true })],
  ]

  for (const [name, candidate] of candidates) {
    await t.test(name, async () => {
      const before = await snapshotTree(runtimeRoot)
      await assert.rejects(
        admitApprovedPublication({ approvalAuthority: candidate, runtimeRoot, plan }),
        (error) => hasCode(error, "APPROVAL_AUTHORITY_UNVERIFIED"),
      )
      assert.deepEqual(await snapshotTree(runtimeRoot), before)
    })
  }
})

test("a verified approval handle rejects plan mutation at admission without runtime mutation", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "publication-admission-plan-mutation-"))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const runtimeRoot = path.join(fixture, "runtime")
  await mkdir(runtimeRoot)
  const plan = await approvedPlan()
  const approvalAuthority = await verifiedApproval(plan, { source_event_id: "telegram:test:plan-mutation" })
  const before = await snapshotTree(runtimeRoot)
  plan.nodes[0].source_sha256 = "0".repeat(64)

  await assert.rejects(
    admitApprovedPublication({ approvalAuthority, runtimeRoot, plan }),
    (error) => hasCode(error, "APPROVAL_PLAN_MISMATCH"),
  )
  assert.deepEqual(await snapshotTree(runtimeRoot), before)
})

test("admission rechecks its trusted clock and rejects a verified approval that expires between verify and admit", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "publication-admission-expiry-race-"))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const runtimeRoot = path.join(fixture, "runtime")
  await mkdir(runtimeRoot)
  const plan = await approvedPlan()
  const nowSecond = Math.floor(Date.now() / 1000) * 1000
  const expiresAt = nowSecond + 1_000
  plan.created_at = new Date(nowSecond - 1_000).toISOString().replace(".000Z", "Z")
  plan.expires_at = new Date(expiresAt).toISOString().replace(".000Z", "Z")
  plan.plan_digest = computePlanDigest(plan)
  const approvalAuthority = await verifiedApproval(plan, {
    source_event_id: "telegram:test:expiry-race",
    approved_at: plan.created_at,
  })
  const waitStarted = Date.now()
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 10)))
  assert.ok(Date.now() - waitStarted < 2_000, "expiry-race wait must remain bounded below two seconds")
  const before = await snapshotTree(runtimeRoot)

  await assert.rejects(
    admitApprovedPublication({ approvalAuthority, runtimeRoot, plan }),
    (error) => hasCode(error, "MANIFEST_EXPIRED"),
  )
  assert.deepEqual(await snapshotTree(runtimeRoot), before)
})

test("one currently-valid canonical pending manifest yields an opaque verified handle", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "publication-pending-authority-valid-"))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const runtimeRoot = path.join(fixture, "runtime")
  await mkdir(runtimeRoot)
  const manifest = await currentPendingManifest()
  await writePendingManifest(runtimeRoot, manifest)

  const handle = await loadVerifiedPendingAuthority(runtimeRoot)
  assert.equal(isVerifiedPendingAuthority(handle), true)
  assert.equal(Object.isFrozen(handle), true)
  assert.deepEqual(Object.keys(handle), [])
  assert.deepEqual(Object.getOwnPropertySymbols(handle), [])
  assert.equal(JSON.stringify(handle), "{}")
  assert.equal(Object.prototype.hasOwnProperty.call(handle, "manifest"), false)
  assert.equal(Object.prototype.hasOwnProperty.call(handle, "runtimeRoot"), false)

  const observed = []
  await consumeVerifiedPendingAuthority(handle, (selected) => {
    observed.push(selected)
    assert.deepEqual(selected, manifest)
    assert.equal("runtimeRoot" in selected, false)
    assert.equal("approval_receipt" in selected, true)
  })
  assert.equal(observed.length, 1)
  assert.equal(isVerifiedPendingAuthority({}), false)
  assert.equal(isVerifiedPendingAuthority({ ...handle }), false)
  assert.equal(isVerifiedPendingAuthority(Object.create(handle)), false)
  const symbolCopy = Object.create(null)
  Object.defineProperty(symbolCopy, Symbol("verified"), { value: true })
  assert.equal(isVerifiedPendingAuthority(symbolCopy), false)
  assert.equal(isVerifiedPendingAuthority(JSON.parse(JSON.stringify(handle))), false)
  assert.equal(isVerifiedPendingAuthority(structuredClone(handle)), false)
})

test("invalid runtime and pending states fail before the downstream consumer and without mutation", async (t) => {
  /** @type {Array<[string,(runtimeRoot:string,manifest:any)=>Promise<void>]>} */
  const cases = [
    ["zero pending candidates", async () => {}],
    ["multiple pending candidates", async (runtimeRoot, manifest) => {
      await writePendingManifest(runtimeRoot, manifest)
      await writePendingManifest(runtimeRoot, manifest, "extra.json")
    }],
    ["malformed pending JSON", async (runtimeRoot, manifest) => {
      await mkdir(path.join(runtimeRoot, "pending"))
      await writeFile(path.join(runtimeRoot, "pending", `${manifest.manifest_id}.json`), '{"schema_version":1,"schema_version":1}')
    }],
    ["expired pending manifest", async (runtimeRoot, manifest) => {
      manifest.expires_at = "2020-01-01T00:00:00Z"
      await writePendingManifest(runtimeRoot, manifest)
    }],
    ["digest-mismatched pending manifest", async (runtimeRoot, manifest) => {
      manifest.plan_digest = "0".repeat(64)
      manifest.approval_receipt.approved_plan_digest = manifest.plan_digest
      await writePendingManifest(runtimeRoot, manifest)
    }],
    ["unknown root entry", async (runtimeRoot, manifest) => {
      await writePendingManifest(runtimeRoot, manifest)
      await mkdir(path.join(runtimeRoot, "unexpected"))
    }],
    ["unknown pending entry", async (runtimeRoot, manifest) => {
      await writePendingManifest(runtimeRoot, manifest)
      await writeFile(path.join(runtimeRoot, "pending", "notes.tmp"), "not a manifest")
    }],
    ["case-alias pending filename", async (runtimeRoot, manifest) => {
      await writePendingManifest(runtimeRoot, manifest, `${manifest.manifest_id}.JSON`)
    }],
    ["symlink pending entry", async (runtimeRoot, manifest) => {
      await mkdir(path.join(runtimeRoot, "pending"))
      const source = path.join(runtimeRoot, "outside.json")
      await writeFile(source, `${jcsCanonicalize(manifest)}\n`)
      await symlink(source, path.join(runtimeRoot, "pending", `${manifest.manifest_id}.json`), "file")
    }],
    ["nonregular pending entry", async (runtimeRoot, manifest) => {
      await mkdir(path.join(runtimeRoot, "pending"))
      await mkdir(path.join(runtimeRoot, "pending", `${manifest.manifest_id}.json`))
    }],
  ]

  for (const [name, setup] of cases) {
    await t.test(name, async (caseTest) => {
      const fixture = await mkdtemp(path.join(tmpdir(), "publication-pending-authority-invalid-"))
      caseTest.after(() => rm(fixture, { recursive: true, force: true }))
      const runtimeRoot = path.join(fixture, "runtime")
      await mkdir(runtimeRoot)
      const manifest = await currentPendingManifest()
      try {
        await setup(runtimeRoot, manifest)
      } catch (error) {
        if (name === "symlink pending entry" && ["EPERM", "EACCES"].includes(/** @type {{code?:string}} */ (error)?.code ?? "")) {
          caseTest.skip("Windows symlink creation is unavailable in this worker")
          return
        }
        throw error
      }
      const before = await snapshotTree(runtimeRoot)
      let calls = 0

      await assert.rejects(loadVerifiedPendingAuthority(runtimeRoot))
      const forged = {}
      await assert.rejects(
        consumeVerifiedPendingAuthority(forged, () => { calls += 1 }),
        (error) => hasCode(error, "PENDING_AUTHORITY_UNVERIFIED"),
      )
      assert.equal(calls, 0)
      assert.deepEqual(await snapshotTree(runtimeRoot), before)
    })
  }
})

test("current-release baseline admission is exact: genesis fails, wrong release fails, and exact release admits a second pending publication", async (t) => {
  await t.test("genesis plan fails when a current release exists without runtime mutation", async (caseTest) => {
    const { runtimeRoot } = await currentReleaseFixture(caseTest)
    const plan = await approvedPlan()
    const approvalAuthority = await verifiedApproval(plan, { source_event_id: "telegram:test:genesis-with-current" })
    const before = await snapshotTree(runtimeRoot)

    await assert.rejects(
      admitApprovedPublication({ approvalAuthority, runtimeRoot, plan }),
      (error) => hasCode(error, "RELEASE_BASELINE_REQUIRED"),
    )
    assert.deepEqual(await snapshotTree(runtimeRoot), before)
  })

  await t.test("wrong release baseline fails against the validated current pointer without mutation", async (caseTest) => {
    const { runtimeRoot, manifest, receipt } = await currentReleaseFixture(caseTest)
    const plan = secondPublicationPlan(manifest, receipt, { wrongBaseline: true })
    const approvalAuthority = await verifiedApproval(plan, { source_event_id: "telegram:test:wrong-current-baseline" })
    const before = await snapshotTree(runtimeRoot)

    await assert.rejects(
      admitApprovedPublication({ approvalAuthority, runtimeRoot, plan }),
      (error) => hasCode(error, "STALE_BASELINE"),
    )
    assert.deepEqual(await snapshotTree(runtimeRoot), before)
  })

  await t.test("exact release baseline admits the second publication as pending and preserves current custody", async (caseTest) => {
    const { runtimeRoot, manifest, receipt } = await currentReleaseFixture(caseTest)
    const plan = secondPublicationPlan(manifest, receipt)
    const approvalEnvelope = approvalFor(plan, { source_event_id: "telegram:test:second-publication" })
    const approvalAuthority = await verifyPublicationApproval({ plan, approvalEnvelope, approvalKey })
    const before = await snapshotTree(runtimeRoot)

    const result = await admitApprovedPublication({ approvalAuthority, runtimeRoot, plan })

    assert.deepEqual(result, {
      manifestId: plan.manifest_id,
      planDigest: plan.plan_digest,
      sourceEventId: approvalEnvelope.source_event_id,
      state: "pending",
    })
    const after = await snapshotTree(runtimeRoot)
    assert.deepEqual(after.filter((entry) => !entry.path.startsWith(`pending${path.sep}`) && entry.path !== "pending"), before)
    const pendingPath = path.join(runtimeRoot, "pending", `${plan.manifest_id}.json`)
    const pending = /** @type {any} */ (await readContractJson(pendingPath))
    assert.deepEqual(pending.approval_receipt, {
      approver: "tyler",
      channel: "telegram",
      source_event_id: approvalEnvelope.source_event_id,
      approved_plan_digest: plan.plan_digest,
      approved_at: approvalEnvelope.approved_at,
    })
    await validateContract("publication-manifest", pending)
  })
})

/** @param {any} manifest */
function exportedManifest(manifest) {
  const copy = structuredClone(manifest)
  for (const node of copy.nodes) {
    const bytes = Buffer.from(`synthetic:${node.path}\n`)
    node.source_sha256 = createHash("sha256").update(bytes).digest("hex")
  }
  copy.plan_digest = computePlanDigest(copy)
  copy.approval_receipt.approved_plan_digest = copy.plan_digest
  return copy
}

/** @param {TestManifest} manifest @returns {any} */
function fakeDriveProvider(manifest) {
  const bytesByPath = new Map(manifest.nodes.map((node) => [node.path, Buffer.from(`synthetic:${node.path}\n`)]))
  const versions = new Map(manifest.nodes.map((node) => [node.path, "v1"]))
  const snapshot = { generation: 1 }
  const stats = { listCalls: 0, readCalls: 0, writeCalls: 0 }
  const target = {
    async list() {
      stats.listCalls += 1
      return {
        snapshot,
        entries: manifest.nodes.map((node) => ({
          path: node.path,
          public_id: node.public_id,
          node_class: node.node_class,
          version: versions.get(node.path),
          metadata: { generation: 1 },
        })),
      }
    },
    async read(/** @type {string} */ pathname) {
      stats.readCalls += 1
      const node = manifest.nodes.find((candidate) => candidate.path === pathname)
      if (!node) throw new Error("synthetic provider path is missing")
      const bytes = bytesByPath.get(pathname)
      if (!bytes) throw new Error("synthetic provider bytes are missing")
      return {
        snapshot,
        path: pathname,
        public_id: node.public_id,
        node_class: node.node_class,
        version: versions.get(pathname),
        metadata: { generation: 1 },
        bytes: Buffer.from(bytes),
      }
    },
  }
  providerStats.set(target, stats)
  return target
}

/** @type {WeakMap<object,ProviderStats>} */
const providerStats = new WeakMap()

/** @param {object} provider @returns {ProviderStats} */
function statsFor(provider) {
  const stats = providerStats.get(provider)
  if (!stats) throw new Error("provider stats are missing")
  return stats
}

test("verified pending authority exports an exact read-only Drive snapshot and a contract-valid receipt", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "publication-export-valid-"))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const runtimeRoot = path.join(fixture, "runtime")
  const exportRoot = path.join(fixture, "export-attempt")
  await mkdir(runtimeRoot)
  const manifest = exportedManifest(await currentPendingManifest())
  await writePendingManifest(runtimeRoot, manifest)
  const authority = await loadVerifiedPendingAuthority(runtimeRoot)
  const provider = fakeDriveProvider(manifest)
  const result = /** @type {{state:string,fileCount:number,formalBuildInput:object}} */ (await exportVerifiedPendingAuthority({ authority, provider, exportRoot }))
  const stats = statsFor(provider)
  assert.equal(result.state, "complete")
  assert.equal(result.fileCount, manifest.nodes.length)
  assert.equal(stats.listCalls, 1)
  assert.equal(stats.readCalls, manifest.nodes.length * 2)
  assert.equal(stats.writeCalls, 0)
  assert.equal(Object.keys(result).includes("exportRoot"), false)
  assert.equal(Object.keys(result).includes("runtimeRoot"), false)
  assert.equal(JSON.stringify(result).includes(fixture), false)
  await consumeVerifiedExportInput(result.formalBuildInput, async ({ manifest: exported, exportReceipt, fileBindings, exportRoot: rooted }) => {
    const selected = /** @type {TestManifest} */ (exported)
    assert.equal(selected.manifest_id, manifest.manifest_id)
    assert.equal(exportReceipt.drive_readback, "verified")
    assert.equal(exportReceipt.files.length, manifest.nodes.length)
    assert.equal(fileBindings.length, manifest.nodes.length)
    for (const file of exportReceipt.files) {
      const node = selected.nodes.find((/** @type {TestManifestNode} */ candidate) => candidate.path === file.path)
      if (!node) throw new Error("test manifest node is missing")
      const binding = fileBindings.find((candidate) => candidate.path === file.path)
      assert.equal(file.source_sha256, node.source_sha256)
      assert.deepEqual(binding, { path: file.path, publicId: node.public_id, nodeClass: node.node_class, sourceSha256: file.source_sha256 })
    }
    await validateContract("export-receipt", exportReceipt, { manifest: selected, exportRoot: rooted })
  })
})


/** @param {unknown} error @param {string} code */
function assertAuthorityCode(error, code) {
  return hasCode(error, code)
}

test("incomplete, unsafe, racing, or write-capable export inputs fail closed with zero Drive writes", async (t) => {
  /** @type {Array<[string,string,(provider:any,manifest:any)=>Promise<void>|void,number]>} */
  const cases = [
    ["missing listing entry", "EXPORT_FILE_SET_MISMATCH", (provider) => {
      const original = provider.list
      provider.list = async () => { const value = await original(); value.entries.pop(); return value }
    }, 1],
    ["extra listing entry", "EXPORT_FILE_SET_MISMATCH", (provider) => {
      const original = provider.list
      provider.list = async () => { const value = await original(); value.entries.push({ ...value.entries[0] }); return value }
    }, 1],
    ["duplicate listing path", "EXPORT_DUPLICATE_PATH", (provider) => {
      const original = provider.list
      provider.list = async () => { const value = await original(); value.entries[1] = { ...value.entries[0] }; return value }
    }, 1],
    ["provider identity mismatch", "EXPORT_PROVIDER_PATH_MISMATCH", (provider) => {
      const original = provider.list
      provider.list = async () => { const value = await original(); value.entries[0].public_id = "wrong-id"; return value }
    }, 1],
    ["case-colliding listing", "EXPORT_PATH_CASE_COLLISION", (provider) => {
      const original = provider.list
      provider.list = async () => { const value = await original(); value.entries[1].path = value.entries[0].path.toLowerCase(); return value }
    }, 1],
    ["traversal listing", "EXPORT_PATH_INVALID", (provider) => {
      const original = provider.list
      provider.list = async () => { const value = await original(); value.entries[0].path = "../escape.md"; return value }
    }, 1],
    ["absolute listing", "EXPORT_PATH_INVALID", (provider) => {
      const original = provider.list
      provider.list = async () => { const value = await original(); value.entries[0].path = "/escape.md"; return value }
    }, 1],
    ["source hash mismatch", "EXPORT_SOURCE_HASH_MISMATCH", (provider) => {
      const original = provider.read
      provider.read = async (/** @type {string} */ pathname) => { const value = await original(pathname); value.bytes = Buffer.from("wrong"); return value }
    }, 3],
    ["source changes between readback", "EXPORT_CHANGED_DURING_READ", (provider) => {
      const original = provider.read
      let calls = 0
      provider.read = async (/** @type {string} */ pathname) => { const value = await original(pathname); calls += 1; if (calls === 2) value.bytes = Buffer.from("changed"); return value }
    }, 3],
    ["write-capable provider", "EXPORT_PROVIDER_INVALID", (provider) => {
      provider.create = () => { statsFor(provider).writeCalls += 1; throw new Error("must never be called") }
    }, 0],
    ["non-enumerable extra provider method", "EXPORT_PROVIDER_INVALID", (provider) => {
      Object.defineProperty(provider, "create", { value: () => {}, enumerable: false })
    }, 0],
    ["provider own symbol", "EXPORT_PROVIDER_INVALID", (provider) => {
      Object.defineProperty(provider, Symbol("write"), { value: () => {} })
    }, 0],
    ["provider accessor is not invoked", "EXPORT_PROVIDER_INVALID", (provider) => {
      Object.defineProperty(provider, "list", { configurable: true, enumerable: true, get() { getterCalls += 1; return () => ({}) } })
    }, 0],
    ["provider OS error is redacted", "EXPORT_FAILED", (provider, manifest) => {
      const original = provider.list
      provider.list = async () => { await original(); throw Object.assign(new Error(`secret path ${manifest.nodes[0].path}`), { code: "EACCES" }) }
    }, 1],
  ]
  let getterCalls = 0
  for (const [name, code, mutate, expectedActivity] of cases) {
    await t.test(name, async (caseTest) => {
      const fixture = await mkdtemp(path.join(tmpdir(), "publication-export-invalid-"))
      caseTest.after(() => rm(fixture, { recursive: true, force: true }))
      const runtimeRoot = path.join(fixture, "runtime")
      const exportRoot = path.join(fixture, "export-attempt")
      await mkdir(runtimeRoot)
      const manifest = exportedManifest(await currentPendingManifest())
      await writePendingManifest(runtimeRoot, manifest)
      const authority = await loadVerifiedPendingAuthority(runtimeRoot)
      const provider = fakeDriveProvider(manifest)
      if (name !== "provider accessor is not invoked") getterCalls = 0
      await mutate(provider, manifest)
      const before = await snapshotTree(runtimeRoot)
      await assert.rejects(
        exportVerifiedPendingAuthority({ authority, provider, exportRoot }),
        (error) => {
          if (!assertAuthorityCode(error, code)) return false
          if (name === "provider OS error is redacted") {
            const record = /** @type {{message?:unknown,code?:unknown}} */ (error)
            assert.equal(record.message, "read-only publication export could not be verified")
            assert.equal(record.code, "EXPORT_FAILED")
            assert.equal(String(record.message).includes(manifest.nodes[0].path), false)
          }
          return true
        },
      )

      const stats = statsFor(provider)
      assert.equal(stats.listCalls + stats.readCalls, expectedActivity)
      assert.equal(stats.writeCalls, 0)
      if (name === "provider accessor is not invoked") assert.equal(getterCalls, 0)
      assert.deepEqual(await snapshotTree(runtimeRoot), before)
      await assert.rejects(readFile(exportRoot), (error) => hasCode(error, "ENOENT"))
    })
  }
})

test("a root created after freshness validation is a stable collision and is never deleted", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "publication-export-root-race-"))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const runtimeRoot = path.join(fixture, "runtime")
  const exportRoot = path.join(fixture, "export-attempt")
  await mkdir(runtimeRoot)
  const manifest = exportedManifest(await currentPendingManifest())
  await writePendingManifest(runtimeRoot, manifest)
  const authority = await loadVerifiedPendingAuthority(runtimeRoot)
  const provider = fakeDriveProvider(manifest)
  const original = provider.read
  let created = false
  provider.read = async (/** @type {string} */ pathname) => {
    const value = await original(pathname)
    if (!created) {
      created = true
      await mkdir(exportRoot)
      await writeFile(path.join(exportRoot, "external-sentinel"), "must-survive")
    }
    return value
  }

  await assert.rejects(
    exportVerifiedPendingAuthority({ authority, provider, exportRoot }),
    (value) => assertAuthorityCode(value, "EXPORT_ROOT_COLLISION"),
  )
  assert.equal(await readFile(path.join(exportRoot, "external-sentinel"), "utf8"), "must-survive")
  assert.equal(statsFor(provider).writeCalls, 0)
})

test("a provider Proxy is rejected before any trap can execute", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "publication-export-provider-proxy-"))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const runtimeRoot = path.join(fixture, "runtime")
  const exportRoot = path.join(fixture, "export-attempt")
  await mkdir(runtimeRoot)
  const manifest = exportedManifest(await currentPendingManifest())
  await writePendingManifest(runtimeRoot, manifest)
  const authority = await loadVerifiedPendingAuthority(runtimeRoot)
  const base = fakeDriveProvider(manifest)
  let trapCalls = 0
  const provider = new Proxy(base, {
    getPrototypeOf() { trapCalls += 1; return Object.prototype },
    ownKeys(target) { trapCalls += 1; return Reflect.ownKeys(target) },
  })

  await assert.rejects(
    exportVerifiedPendingAuthority({ authority, provider, exportRoot }),
    (value) => assertAuthorityCode(value, "EXPORT_PROVIDER_INVALID"),
  )
  assert.equal(trapCalls, 0)
  assert.equal(statsFor(base).writeCalls, 0)
  await assert.rejects(readFile(exportRoot), (error) => hasCode(error, "ENOENT"))
})

test("provider response accessors and nested Proxies are rejected without getter/trap execution or export mutation", async (t) => {
  /** @type {Array<[string,(provider:any,counters:{calls:number})=>void,number]>} */
  const cases = [
    ["listing outer entries getter", (provider, counters) => {
      const original = provider.list
      provider.list = async () => {
        const value = await original()
        return Object.defineProperty({ snapshot: value.snapshot }, "entries", {
          enumerable: true,
          configurable: true,
          get() { counters.calls += 1; return value.entries },
        })
      }
    }, 1],
    ["listing entry path getter", (provider, counters) => {
      const original = provider.list
      provider.list = async () => {
        const value = await original()
        Object.defineProperty(value.entries[0], "path", {
          enumerable: true,
          configurable: true,
          get() { counters.calls += 1; return "unexpected.md" },
        })
        return value
      }
    }, 1],
    ["listing snapshot deep getter", (provider, counters) => {
      const original = provider.list
      provider.list = async () => {
        const value = await original()
        value.snapshot = Object.defineProperty({}, "generation", {
          enumerable: true,
          configurable: true,
          get() { counters.calls += 1; return 1 },
        })
        return value
      }
    }, 1],
    ["listing snapshot Proxy", (provider, counters) => {
      const original = provider.list
      provider.list = async () => {
        const value = await original()
        value.snapshot = new Proxy({ generation: 1 }, {
          get() { counters.calls += 1; return 1 },
          ownKeys() { counters.calls += 1; return ["generation"] },
          getPrototypeOf() { counters.calls += 1; return Object.prototype },
        })
        return value
      }
    }, 1],
    ["listing metadata getter", (provider, counters) => {
      const original = provider.list
      provider.list = async () => {
        const value = await original()
        Object.defineProperty(value.entries[0], "metadata", {
          enumerable: true,
          configurable: true,
          get() { counters.calls += 1; return { generation: 1 } },
        })
        return value
      }
    }, 1],
    ["listing metadata Proxy", (provider, counters) => {
      const original = provider.list
      provider.list = async () => {
        const value = await original()
        value.entries[0].metadata = new Proxy({ generation: 1 }, {
          get() { counters.calls += 1; return 1 },
          ownKeys() { counters.calls += 1; return ["generation"] },
          getPrototypeOf() { counters.calls += 1; return Object.prototype },
        })
        return value
      }
    }, 1],
    ["read outer bytes getter", (provider, counters) => {
      const original = provider.read
      provider.read = async (/** @type {string} */ pathname) => {
        const value = await original(pathname)
        return Object.defineProperty({
          metadata: value.metadata,
          node_class: value.node_class,
          path: value.path,
          public_id: value.public_id,
          snapshot: value.snapshot,
          version: value.version,
        }, "bytes", {
          enumerable: true,
          configurable: true,
          get() { counters.calls += 1; return value.bytes },
        })
      }
    }, 2],
  ]

  for (const [name, mutate, expectedActivity] of cases) {
    await t.test(name, async (caseTest) => {
      const fixture = await mkdtemp(path.join(tmpdir(), "publication-export-response-adversarial-"))
      caseTest.after(() => rm(fixture, { recursive: true, force: true }))
      const runtimeRoot = path.join(fixture, "runtime")
      const exportRoot = path.join(fixture, "export-attempt")
      await mkdir(runtimeRoot)
      const manifest = exportedManifest(await currentPendingManifest())
      await writePendingManifest(runtimeRoot, manifest)
      const authority = await loadVerifiedPendingAuthority(runtimeRoot)
      const provider = fakeDriveProvider(manifest)
      const counters = { calls: 0 }
      mutate(provider, counters)
      const before = await snapshotTree(runtimeRoot)

      await assert.rejects(
        exportVerifiedPendingAuthority({ authority, provider, exportRoot }),
        (error) => hasCode(error, "EXPORT_PROVIDER_INVALID"),
      )
      assert.equal(counters.calls, 0)
      assert.equal(statsFor(provider).listCalls + statsFor(provider).readCalls, expectedActivity)
      assert.equal(statsFor(provider).writeCalls, 0)
      assert.deepEqual(await snapshotTree(runtimeRoot), before)
      await assert.rejects(readFile(exportRoot), (error) => hasCode(error, "ENOENT"))
    })
  }
})

test("export custody keeps a defensive copy when a provider mutates its returned Buffer after success", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "publication-export-buffer-copy-"))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const runtimeRoot = path.join(fixture, "runtime")
  const exportRoot = path.join(fixture, "export-attempt")
  await mkdir(runtimeRoot)
  const manifest = exportedManifest(await currentPendingManifest())
  await writePendingManifest(runtimeRoot, manifest)
  const authority = await loadVerifiedPendingAuthority(runtimeRoot)
  const provider = fakeDriveProvider(manifest)
  const original = provider.read
  const sharedBytesByPath = new Map(manifest.nodes.map((/** @type {any} */ node) => [node.path, Buffer.from(`synthetic:${node.path}\n`)]))
  const originalBytes = Buffer.from(sharedBytesByPath.get(manifest.nodes[0].path))
  provider.read = async (/** @type {string} */ pathname) => {
    const value = await original(pathname)
    value.bytes = sharedBytesByPath.get(pathname)
    return value
  }

  const result = await exportVerifiedPendingAuthority({ authority, provider, exportRoot })
  for (const bytes of sharedBytesByPath.values()) bytes.fill(0x58)
  await consumeVerifiedExportInput(result.formalBuildInput, async ({ exportRoot: rooted, exportReceipt }) => {
    const file = exportReceipt.files.find((/** @type {any} */ candidate) => candidate.path === manifest.nodes[0].path)
    if (!file) throw new Error("defensive-copy test receipt file is missing")
    assert.equal((await readFile(path.join(rooted, ...file.path.split("/")))).equals(originalBytes), true)
    assert.equal(file.source_sha256, manifest.nodes[0].source_sha256)
  })
  assert.equal(statsFor(provider).readCalls, manifest.nodes.length * 2)
  assert.equal(statsFor(provider).writeCalls, 0)
})

test("preexisting, linked, or nonregular export roots are never adopted", async (t) => {
  const cases = ["directory", "file", "link"]
  for (const kind of cases) {
    await t.test(kind, async (caseTest) => {
      const fixture = await mkdtemp(path.join(tmpdir(), "publication-export-root-"))
      caseTest.after(() => rm(fixture, { recursive: true, force: true }))
      const runtimeRoot = path.join(fixture, "runtime")
      const exportRoot = path.join(fixture, "export-attempt")
      await mkdir(runtimeRoot)
      const manifest = exportedManifest(await currentPendingManifest())
      await writePendingManifest(runtimeRoot, manifest)
      const authority = await loadVerifiedPendingAuthority(runtimeRoot)
      if (kind === "directory") await mkdir(exportRoot)
      if (kind === "file") await writeFile(exportRoot, "sentinel")
      if (kind === "link") {
        const outside = path.join(fixture, "outside")
        await mkdir(outside)
        try {
          await symlink(outside, exportRoot, "junction")
        } catch (error) {
          if (hasCode(error, "EPERM") || hasCode(error, "EACCES")) { caseTest.skip("Windows symlink creation is unavailable in this worker"); return }
          throw error
        }
      }
      const before = await snapshotTree(fixture)
      const provider = fakeDriveProvider(manifest)
      await assert.rejects(
        exportVerifiedPendingAuthority({ authority, provider, exportRoot }),
        (error) => assertAuthorityCode(error, kind === "directory" ? "EXPORT_ROOT_COLLISION" : "EXPORT_ROOT_INVALID"),
      )
      assert.deepEqual(await snapshotTree(fixture), before)
    })
  }
})
