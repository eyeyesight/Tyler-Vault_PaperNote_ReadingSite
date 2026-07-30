// @ts-nocheck -- security fixtures intentionally assemble sealed runtime trees.
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import test from "node:test"

import {
  PagesContractError,
  deriveVerifiedSealedReleaseIdentity,
  loadVerifiedSealedReleaseForIdentity,
  loadVerifiedSealedRelease,
  rollbackPagesDeployment,
  runBoundedPagesDeployment,
  verifiedSealedReleaseIdentity,
} from "../lib/pages-deployment-contract.mjs"
import {
  rollbackPagesDeploymentForTest,
  runBoundedPagesDeploymentForTest,
} from "../lib/pages-provider-lifecycle.mjs"
import {
  createScriptedLocalPagesProvider,
} from "./support/scripted-local-pages-provider.mjs"
import { computePlanDigest, jcsCanonicalize } from "../lib/publication-contracts.mjs"
import { constructReleaseReceipt, readCandidateArtifactTree } from "../lib/safe-release.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")

async function installSealedRelease(root, suffix, createdAt, artifactText) {
  const runtimeRoot = path.join(root, "runtime")
  const releasesRoot = path.join(root, "releases")
  await Promise.all([
    mkdir(runtimeRoot, { recursive: true }),
    mkdir(releasesRoot, { recursive: true }),
  ])
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "specs", "examples", "publish-unit-manifest-v1.example.json"), "utf8"))
  manifest.manifest_id = `VPUB-20260728-pages-${suffix}`
  manifest.plan_digest = computePlanDigest(manifest)
  manifest.approval_receipt.approved_plan_digest = manifest.plan_digest
  const projectedMarkdown = new Map([
    ["flow", Buffer.from("---\ntitle: Existing\n---\n\n# Existing\n")],
    ["jackman-2021", Buffer.from("---\ntitle: Paper\n---\n\n# Paper\n")],
  ])
  const staging = path.join(root, `candidate-${suffix}`)
  await mkdir(staging)
  await writeFile(path.join(staging, "index.html"), artifactText)
  const receipt = await constructReleaseReceipt({
    manifest,
    createdAt,
    projectedMarkdown,
    artifacts: await readCandidateArtifactTree(staging),
  })
  const releaseRoot = path.join(releasesRoot, receipt.release_digest)
  await mkdir(releaseRoot)
  const artifactPath = path.join(releaseRoot, "index.html")
  await writeFile(artifactPath, artifactText)
  const custodyRoot = path.join(runtimeRoot, "consumed", manifest.manifest_id)
  await mkdir(custodyRoot, { recursive: true })
  await writeFile(path.join(custodyRoot, "manifest.json"), `${jcsCanonicalize(manifest)}\n`)
  await writeFile(path.join(custodyRoot, "release-receipt.json"), `${jcsCanonicalize(receipt)}\n`)
  const capability = await loadVerifiedSealedRelease({ runtimeRoot, releasesRoot, manifestId: manifest.manifest_id })
  return { runtimeRoot, releasesRoot, manifest, receipt, releaseRoot, artifactPath, capability }
}

async function expectPagesError(promise, code) {
  await assert.rejects(promise, (error) => error instanceof PagesContractError && error.code === code)
}

test("VerifiedSealedRelease is opaque, filesystem-minted, and plain authority cannot reach a provider", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-verified-sealed-release-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const candidate = await installSealedRelease(root, "candidate", "2026-07-28T12:34:56Z", "candidate bytes\n")
  assert.equal(Object.isFrozen(candidate.capability), true)
  assert.deepEqual(Reflect.ownKeys(candidate.capability), [])
  assert.match(verifiedSealedReleaseIdentity(candidate.capability).releaseId, /^VPUB-/)

  const provider = createScriptedLocalPagesProvider()
  await expectPagesError(
    runBoundedPagesDeployment({
      provider,
      candidate: {
        release: verifiedSealedReleaseIdentity(candidate.capability),
        authority: { approvedManifestDigest: "0".repeat(64) },
      },
    }),
    "DEPLOYMENT_AUTHORITY_INVALID",
  )
  assert.deepEqual(provider.calls, { claim: 0, start: 0, readback: 0, operation: 0 })
})

test("deployment revalidates candidate and last-known-good bytes immediately before provider mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-verified-sealed-recheck-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lkg = await installSealedRelease(root, "lkg", "2026-07-28T12:34:56Z", "lkg bytes\n")
  const candidate = await installSealedRelease(root, "candidate", "2026-07-28T13:34:56Z", "candidate bytes\n")
  const lkgIdentity = verifiedSealedReleaseIdentity(lkg.capability)

  const forgedCandidate = createScriptedLocalPagesProvider({ initial: lkgIdentity })
  await writeFile(candidate.artifactPath, "tampered candidate\n")
  await expectPagesError(
    runBoundedPagesDeployment({ provider: forgedCandidate, candidate: candidate.capability }),
    "DEPLOYMENT_CANDIDATE_BYTES_INVALID",
  )
  assert.deepEqual(forgedCandidate.calls, { claim: 0, start: 0, readback: 0, operation: 0 })

  await writeFile(candidate.artifactPath, "candidate bytes\n")
  const forgedLkg = createScriptedLocalPagesProvider({ initial: lkgIdentity })
  await writeFile(lkg.artifactPath, "tampered lkg\n")
  await expectPagesError(
    runBoundedPagesDeployment({ provider: forgedLkg, candidate: candidate.capability }),
    "DEPLOYMENT_LKG_BYTES_INVALID",
  )
  assert.equal(forgedLkg.calls.start, 0)
  assert(forgedLkg.calls.readback > 0)
})

test("a post-preflight candidate or LKG byte change is caught by the final pre-start revalidation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-verified-sealed-final-recheck-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lkg = await installSealedRelease(root, "lkg", "2026-07-28T12:34:56Z", "lkg bytes\n")
  const candidate = await installSealedRelease(root, "candidate", "2026-07-28T13:34:56Z", "candidate bytes\n")
  const lkgIdentity = verifiedSealedReleaseIdentity(lkg.capability)

  for (const [name, changedPath, code] of [
    ["candidate", candidate.artifactPath, "DEPLOYMENT_CANDIDATE_BYTES_INVALID"],
    ["last-known-good", lkg.artifactPath, "DEPLOYMENT_LKG_BYTES_INVALID"],
  ]) await t.test(name, async () => {
    await writeFile(candidate.artifactPath, "candidate bytes\n")
    await writeFile(lkg.artifactPath, "lkg bytes\n")
    let changed = false
    const provider = createScriptedLocalPagesProvider({
      initial: lkgIdentity,
      afterClaim: async () => {
        if (!changed) {
          changed = true
          await writeFile(changedPath, `tampered ${name}\n`)
        }
      },
    })
    await expectPagesError(runBoundedPagesDeployment({ provider, candidate: candidate.capability }), code)
    assert.equal(provider.calls.start, 0)
    assert.equal(changed, true)
  })
})

test("verified capability deployment preserves deterministic one-start, reconciliation, and replay behavior", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-verified-sealed-lifecycle-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lkg = await installSealedRelease(root, "lkg", "2026-07-28T12:34:56Z", "lkg bytes\n")
  const candidate = await installSealedRelease(root, "candidate", "2026-07-28T13:34:56Z", "candidate bytes\n")
  const candidateIdentity = verifiedSealedReleaseIdentity(candidate.capability)
  const provider = createScriptedLocalPagesProvider({
    initial: verifiedSealedReleaseIdentity(lkg.capability),
    startSteps: [{ type: "mutate-then-error", kind: "transport" }],
  })
  const deployed = await runBoundedPagesDeployment({ provider, candidate: candidate.capability })
  assert.equal(deployed.outcome, "deployed")
  assert.deepEqual(provider.active, candidateIdentity)
  assert.equal(provider.calls.start, 1)
  assert.equal(provider.lastStartedAuthority.sealedDescriptorId, candidate.manifest.manifest_id)
  assert.equal(provider.lastStartedAuthority.receipt.receiptId, candidate.receipt.release_digest)
  assert.deepEqual(provider.lastStartedAuthority.inventory, [{
    path: "index.html",
    sha256: candidate.receipt.artifacts[0].sha256,
    byteLength: Buffer.byteLength("candidate bytes\n"),
  }])

  const replay = await runBoundedPagesDeployment({ provider, candidate: candidate.capability })
  assert.equal(replay.outcome, "idempotent-replay")
  assert.equal(provider.calls.start, 1)

  await expectPagesError(
    runBoundedPagesDeployment({ provider, candidate: candidate.capability, timeoutMs: 1 }),
    "DEPLOYMENT_INTERFACE_INVALID",
  )
  assert.equal(provider.calls.start, 1)
})

test("production deployment rejects policy arguments and the frozen scripted adapter has no policy channel", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-production-policy-boundary-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const candidate = await installSealedRelease(root, "candidate", "2026-07-28T13:34:56Z", "candidate bytes\n")
  assert.throws(
    () => createScriptedLocalPagesProvider({
      testPolicy: { requestTimeoutMs: 1, reconcileDeadlineMs: 1, pollIntervalMs: 1 },
    }),
    (error) => error instanceof PagesContractError && error.code === "SCRIPTED_PROVIDER_INVALID",
  )
  const provider = createScriptedLocalPagesProvider()
  assert.equal(Object.isFrozen(provider), true)
  assert.throws(() => { provider.readOperation = async () => null }, TypeError)
  await expectPagesError(
    runBoundedPagesDeployment(
      { provider, candidate: candidate.capability },
      { requestTimeoutMs: 1, reconcileDeadlineMs: 1, pollIntervalMs: 1 },
    ),
    "DEPLOYMENT_INTERFACE_INVALID",
  )
  assert.deepEqual(provider.calls, { claim: 0, start: 0, readback: 0, operation: 0 })
})

test("pending verified deployment resumes the same provider operation without a second mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-verified-sealed-pending-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lkg = await installSealedRelease(root, "lkg", "2026-07-28T12:34:56Z", "lkg bytes\n")
  const candidate = await installSealedRelease(root, "candidate", "2026-07-28T13:34:56Z", "candidate bytes\n")
  const acceleratedPolicy = { requestTimeoutMs: 50, reconcileDeadlineMs: 300, pollIntervalMs: 5 }
  const provider = createScriptedLocalPagesProvider({
    initial: verifiedSealedReleaseIdentity(lkg.capability),
    startSteps: [{ type: "return-pending" }],
  })
  const first = await runBoundedPagesDeploymentForTest({ provider, candidate: candidate.capability }, acceleratedPolicy)
  const resumed = await runBoundedPagesDeploymentForTest({ provider, candidate: candidate.capability }, acceleratedPolicy)
  assert.equal(first.outcome, "pending")
  assert.equal(resumed.outcome, "pending")
  assert.equal(resumed.operationId, first.operationId)
  assert.equal(provider.calls.start, 1)
})

test("two legal callers atomically claim one operation and invoke start exactly once", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-durable-claim-race-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lkg = await installSealedRelease(root, "lkg", "2026-07-28T12:34:56Z", "lkg bytes\n")
  const candidate = await installSealedRelease(root, "candidate", "2026-07-28T13:34:56Z", "candidate bytes\n")
  const candidateIdentity = verifiedSealedReleaseIdentity(candidate.capability)
  let arrivals = 0
  let releaseBarrier
  const barrier = new Promise((resolve) => { releaseBarrier = resolve })
  const provider = createScriptedLocalPagesProvider({
    initial: verifiedSealedReleaseIdentity(lkg.capability),
    afterReadback: async ({ calls }) => {
      if (calls.readback > 2) return
      arrivals += 1
      if (arrivals === 2) releaseBarrier()
      await barrier
    },
  })

  const outcomes = await Promise.all([
    runBoundedPagesDeployment({ provider, candidate: candidate.capability }),
    runBoundedPagesDeployment({ provider, candidate: candidate.capability }),
  ])
  assert.equal(outcomes[0].operationId, outcomes[1].operationId)
  assert.deepEqual(outcomes.map(({ outcome }) => outcome), ["deployed", "deployed"])
  assert(outcomes.every(({ release }) => JSON.stringify(release) === JSON.stringify(candidateIdentity)), "no caller may report another release")
  assert.equal(provider.calls.claim, 2)
  assert.equal(provider.claimDispositions.filter((value) => value === "acquired").length, 1)
  assert.equal(provider.calls.start, 1)
})

test("an ambiguous start with temporarily absent operation read-back resumes the durable claim without another start", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-durable-claim-ambiguous-start-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lkg = await installSealedRelease(root, "lkg", "2026-07-28T12:34:56Z", "lkg bytes\n")
  const candidate = await installSealedRelease(root, "candidate", "2026-07-28T13:34:56Z", "candidate bytes\n")
  const acceleratedPolicy = { requestTimeoutMs: 50, reconcileDeadlineMs: 600, pollIntervalMs: 5 }
  const provider = createScriptedLocalPagesProvider({
    initial: verifiedSealedReleaseIdentity(lkg.capability),
    hideOperationReadback: true,
    startSteps: [{ type: "pending-error", kind: "transport" }],
  })

  const first = await runBoundedPagesDeploymentForTest({ provider, candidate: candidate.capability }, acceleratedPolicy)
  const resumed = await runBoundedPagesDeploymentForTest({ provider, candidate: candidate.capability }, acceleratedPolicy)
  assert.equal(first.outcome, "pending")
  assert.equal(resumed.outcome, "pending")
  assert.equal(resumed.operationId, first.operationId)
  assert.equal(provider.calls.claim, 1)
  assert.deepEqual(provider.claimDispositions, ["acquired"])
  assert.equal(provider.calls.start, 1)
})

test("an ambiguous durable claim never authorizes start", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-ambiguous-durable-claim-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const candidate = await installSealedRelease(root, "candidate", "2026-07-28T13:34:56Z", "candidate bytes\n")
  const policy = { requestTimeoutMs: 15, reconcileDeadlineMs: 40, pollIntervalMs: 2 }
  for (const claimStep of ["return-invalid", "persist-then-error", "persist-then-timeout"]) {
    const provider = createScriptedLocalPagesProvider({ claimSteps: [{ type: claimStep }] })
    const result = await runBoundedPagesDeploymentForTest({ provider, candidate: candidate.capability }, policy)
    assert.equal(result.outcome, "pending", claimStep)
    assert.equal(provider.calls.claim, 1, claimStep)
    assert.equal(provider.calls.start, 0, claimStep)
  }
})

test("pending exact candidate remains stale against newer active, expected-active, and retained history", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-pending-stale-generation-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const candidate = await installSealedRelease(root, "candidate", "2026-07-28T12:34:56Z", "candidate bytes\n")
  const active = await installSealedRelease(root, "active", "2026-07-28T13:34:56Z", "active bytes\n")
  const retained = await installSealedRelease(root, "retained", "2026-07-28T14:34:56Z", "retained bytes\n")
  const candidateIdentity = verifiedSealedReleaseIdentity(candidate.capability)
  const activeIdentity = verifiedSealedReleaseIdentity(active.capability)
  const retainedIdentity = verifiedSealedReleaseIdentity(retained.capability)
  const pending = {
    operationId: `pages-operation-${"6".repeat(64)}`,
    claimId: `pages-claim-${"6".repeat(64)}`,
    idempotencyKey: `pages-idempotency-${"6".repeat(64)}`,
    status: "pending",
    release: candidateIdentity,
    expectedActive: activeIdentity,
  }
  const provider = createScriptedLocalPagesProvider({
    initial: activeIdentity,
    retained: [retainedIdentity],
    inProgress: pending,
  })

  await expectPagesError(
    runBoundedPagesDeploymentForTest(
      { provider, candidate: candidate.capability },
      { requestTimeoutMs: 10, reconcileDeadlineMs: 20, pollIntervalMs: 1 },
    ),
    "DEPLOYMENT_STALE",
  )
  assert.equal(provider.calls.operation, 0)
  assert.equal(provider.calls.claim, 0)
  assert.equal(provider.calls.start, 0)
})

test("claim, start, and reconciliation share one aggregate deadline and never call after it expires", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-absolute-reconcile-deadline-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const candidate = await installSealedRelease(root, "candidate", "2026-07-28T13:34:56Z", "candidate bytes\n")
  const testPolicy = { requestTimeoutMs: 200, reconcileDeadlineMs: 350, pollIntervalMs: 2 }
  let operation = null
  let started = false
  let claimStartedAt = 0
  let postStartReadbacks = 0
  const postStartOperationHints = []
  const provider = {
    readback({ timeoutMs }) {
      assert(timeoutMs > 0)
      if (operation !== null && !started) {
        return { active: null, inProgress: structuredClone(operation), retained: [] }
      }
      if (started) {
        postStartReadbacks += 1
        return new Promise(() => {})
      }
      return { active: null, inProgress: null, retained: [] }
    },
    readOperation(_operationId, { timeoutMs }) {
      if (operation === null) return null
      postStartOperationHints.push(timeoutMs)
      return new Promise(() => {})
    },
    claim(operationValue, { timeoutMs }) {
      claimStartedAt = performance.now()
      operation = structuredClone(operationValue)
      assert(timeoutMs > 0 && timeoutMs <= testPolicy.requestTimeoutMs)
      return { disposition: "acquired" }
    },
    start(_operationValue, { timeoutMs }) {
      started = true
      assert(timeoutMs > 0 && timeoutMs <= testPolicy.requestTimeoutMs)
      return new Promise(() => {})
    },
  }

  const result = await runBoundedPagesDeploymentForTest({ provider, candidate: candidate.capability }, testPolicy)
  const aggregateElapsedMs = performance.now() - claimStartedAt
  assert.equal(result.outcome, "pending")
  assert.equal(postStartOperationHints.length, 1)
  assert(postStartOperationHints[0] > 0 && postStartOperationHints[0] < testPolicy.requestTimeoutMs)
  assert.equal(postStartReadbacks, 0, "deadline exhaustion must not begin a later state read-back")
  assert(
    aggregateElapsedMs < testPolicy.requestTimeoutMs + testPolicy.reconcileDeadlineMs - 100,
    `aggregate deadline was incorrectly additive: ${aggregateElapsedMs}ms`,
  )
  assert(aggregateElapsedMs <= testPolicy.reconcileDeadlineMs + 80, `aggregate deadline exceeded scheduler tolerance: ${aggregateElapsedMs}ms`)
})

test("rollback pending resume requires the operation expectedActive to equal the approval before polling", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-rollback-pending-expected-active-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = await installSealedRelease(root, "source", "2026-07-28T12:34:56Z", "source bytes\n")
  const active = await installSealedRelease(root, "active", "2026-07-28T13:34:56Z", "active bytes\n")
  const sourceIdentity = verifiedSealedReleaseIdentity(source.capability)
  const activeIdentity = verifiedSealedReleaseIdentity(active.capability)
  const rollbackIdentity = deriveVerifiedSealedReleaseIdentity(source.capability, activeIdentity.generation + 1)
  const approval = {
    approvalId: "approval-pending",
    approverId: "tyler",
    approvedAt: "2026-07-30T12:00:00Z",
    candidateRelease: rollbackIdentity,
    expectedActive: activeIdentity,
    sourceRelease: sourceIdentity,
  }
  const acceleratedPolicy = { requestTimeoutMs: 50, reconcileDeadlineMs: 300, pollIntervalMs: 5 }
  const provider = createScriptedLocalPagesProvider({
    initial: activeIdentity,
    startSteps: [{ type: "return-pending" }],
  })
  const pending = await rollbackPagesDeploymentForTest(
    { provider, approval, candidate: source.capability },
    acceleratedPolicy,
  )
  assert.equal(pending.outcome, "pending")
  const callsBeforeMismatch = { ...provider.calls }
  const staleApproval = { ...approval, expectedActive: sourceIdentity }
  await expectPagesError(
    rollbackPagesDeploymentForTest(
      { provider, approval: staleApproval, candidate: source.capability },
      acceleratedPolicy,
    ),
    "ROLLBACK_EXPECTED_ACTIVE_MISMATCH",
  )
  assert.equal(provider.calls.start, callsBeforeMismatch.start)
  assert.equal(provider.calls.operation, callsBeforeMismatch.operation, "mismatched approval must not poll the pending operation")
})

test("rollback gets old-byte authority only from an opaque capability and revalidates both target and active LKG", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-verified-sealed-rollback-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = await installSealedRelease(root, "source", "2026-07-28T12:34:56Z", "source bytes\n")
  const active = await installSealedRelease(root, "active", "2026-07-28T13:34:56Z", "active bytes\n")
  const activeIdentity = verifiedSealedReleaseIdentity(active.capability)
  const sourceIdentity = verifiedSealedReleaseIdentity(source.capability)
  const rollbackIdentity = deriveVerifiedSealedReleaseIdentity(source.capability, activeIdentity.generation + 1)
  const approval = {
    approvalId: "approval-1",
    approverId: "tyler",
    approvedAt: "2026-07-30T12:00:00Z",
    candidateRelease: rollbackIdentity,
    expectedActive: activeIdentity,
    sourceRelease: sourceIdentity,
  }
  const provider = createScriptedLocalPagesProvider({
    initial: activeIdentity,
    startSteps: [{ type: "success" }],
  })
  const result = await rollbackPagesDeployment({ provider, approval, candidate: source.capability })
  assert.equal(result.outcome, "rolled-back")
  assert.deepEqual(provider.active, rollbackIdentity)
  assert.equal(provider.calls.start, 1)
  assert.equal(provider.lastStartedAuthority.sealedDescriptorId, source.manifest.manifest_id)

  const replay = await rollbackPagesDeployment({ provider, approval, candidate: source.capability })
  assert.equal(replay.outcome, "idempotent-replay")
  assert.equal(provider.calls.start, 1)

  const untouched = createScriptedLocalPagesProvider({ initial: activeIdentity })
  await expectPagesError(
    rollbackPagesDeployment({ provider: untouched, approval, candidate: {} }),
    "ROLLBACK_LOCAL_CUSTODY_FAILED",
  )
  assert.deepEqual(untouched.calls, { claim: 0, start: 0, readback: 0, operation: 0 })
})

test("canonical rollback identity preserves custody through replay and a newer forward deployment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-rollback-custody-continuity-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = await installSealedRelease(root, "source", "2026-07-28T12:34:56Z", "source bytes\n")
  const active = await installSealedRelease(root, "active", "2026-07-28T13:34:56Z", "active bytes\n")
  const forward = await installSealedRelease(root, "forward", "2026-07-28T15:34:56Z", "forward bytes\n")
  const sourceIdentity = verifiedSealedReleaseIdentity(source.capability)
  const activeIdentity = verifiedSealedReleaseIdentity(active.capability)
  const rollbackIdentity = deriveVerifiedSealedReleaseIdentity(source.capability, activeIdentity.generation + 1)
  const approval = {
    approvalId: "approval-custody-continuity",
    approverId: "tyler",
    approvedAt: "2026-07-30T12:00:00Z",
    candidateRelease: rollbackIdentity,
    expectedActive: activeIdentity,
    sourceRelease: sourceIdentity,
  }
  const provider = createScriptedLocalPagesProvider({ initial: activeIdentity })

  const rolledBack = await rollbackPagesDeployment({ provider, approval, candidate: source.capability })
  assert.equal(rolledBack.outcome, "rolled-back")
  const replay = await rollbackPagesDeployment({ provider, approval, candidate: source.capability })
  assert.equal(replay.outcome, "idempotent-replay")
  assert.equal(provider.calls.start, 1)

  const loadedRollback = await loadVerifiedSealedReleaseForIdentity({
    runtimeRoot: source.runtimeRoot,
    releasesRoot: source.releasesRoot,
    release: rollbackIdentity,
  })
  assert.deepEqual(verifiedSealedReleaseIdentity(loadedRollback), rollbackIdentity)
  await writeFile(source.artifactPath, "tampered rollback LKG\n")
  await expectPagesError(
    runBoundedPagesDeployment({ provider, candidate: forward.capability }),
    "DEPLOYMENT_LKG_BYTES_INVALID",
  )
  assert.equal(provider.calls.start, 1)
  await writeFile(source.artifactPath, "source bytes\n")
  const deployed = await runBoundedPagesDeployment({ provider, candidate: forward.capability })
  assert.equal(deployed.outcome, "deployed")
  assert.equal(provider.calls.start, 2)

  await assert.rejects(
    loadVerifiedSealedReleaseForIdentity({
      runtimeRoot: source.runtimeRoot,
      releasesRoot: source.releasesRoot,
      release: { ...rollbackIdentity, releaseId: `${rollbackIdentity.releaseId}-alias` },
    }),
    /identity|rollback/i,
  )
  await assert.rejects(
    loadVerifiedSealedReleaseForIdentity({
      runtimeRoot: source.runtimeRoot,
      releasesRoot: source.releasesRoot,
      release: { ...rollbackIdentity, releaseDigest: "0".repeat(64) },
    }),
    /identity|digest/i,
  )
})
