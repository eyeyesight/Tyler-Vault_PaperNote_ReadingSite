// @ts-nocheck -- filesystem promotion tests intentionally assemble dynamic fixtures.
import assert from "node:assert/strict"
import { open as openFile } from "node:fs/promises"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, lstat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { atomicReplaceFile, createOwnedRunLifecycle, promoteRelease, promoteReleaseForTest } from "../lib/release-promotion.mjs"
import { constructReleaseReceipt, readCandidateArtifactTree } from "../lib/safe-release.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")

async function exactSnapshot(root) {
  const rows = []
  async function walk(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
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

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function assertNoRuntimeLease(runtimeRoot) {
  assert.equal(
    (await readdir(path.dirname(runtimeRoot))).some((entry) => /^\.tyler-runtime-[a-f0-9]+\.lease$/.test(entry)),
    false,
  )
}

async function validPromotionFixture(t, prefix = "release-promotion-valid-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtimeRoot = path.join(root, "runtime")
  const releasesRoot = path.join(root, "releases")
  const runRoot = path.join(root, "work", "owned-run")
  const candidateRoot = path.join(runRoot, "candidate")
  await Promise.all([mkdir(runtimeRoot), mkdir(releasesRoot), mkdir(candidateRoot, { recursive: true })])
  await writeFile(path.join(candidateRoot, "graph.json"), '{"schema_version":1}\n')
  await mkdir(path.join(candidateRoot, "nested"))
  await writeFile(path.join(candidateRoot, "nested", "index.html"), "<!doctype html>\n")

  const manifestPath = path.join(root, "manifest.json")
  const manifestRaw = await readFile(path.join(repoRoot, "specs", "examples", "publish-unit-manifest-v1.example.json"))
  await writeFile(manifestPath, manifestRaw)
  const manifest = JSON.parse(manifestRaw)
  const projectedMarkdown = new Map([
    ["flow", Buffer.from("---\ntitle: Existing\n---\n\n# Existing\n")],
    ["jackman-2021", Buffer.from("---\ntitle: Paper\n---\n\n# Paper\n")],
  ])
  const receipt = await constructReleaseReceipt({
    manifest,
    createdAt: "2026-07-28T12:34:56Z",
    projectedMarkdown,
    artifacts: await readCandidateArtifactTree(candidateRoot),
  })
  const oldDigest = "f".repeat(64)
  const oldReleaseRoot = path.join(releasesRoot, oldDigest)
  await mkdir(oldReleaseRoot)
  await writeFile(path.join(oldReleaseRoot, "index.html"), "last known good\n")
  const oldPointerBytes = Buffer.from(`${JSON.stringify({ schema_version: 1, release_digest: oldDigest, receipt_path: "consumed/old/release-receipt.json" })}\n`)
  const pointerPath = path.join(runtimeRoot, "current-release.json")
  await writeFile(pointerPath, oldPointerBytes)
  return { root, runtimeRoot, releasesRoot, runRoot, candidateRoot, manifestPath, manifestRaw, manifest, projectedMarkdown, receipt, oldPointerBytes, pointerPath }
}

function promotionInput(fixture, overrides = {}) {
  return {
    candidateRoot: fixture.candidateRoot,
    runRoot: fixture.runRoot,
    releasesRoot: fixture.releasesRoot,
    runtimeRoot: fixture.runtimeRoot,
    manifestPath: fixture.manifestPath,
    manifestRaw: fixture.manifestRaw,
    manifest: fixture.manifest,
    receipt: fixture.receipt,
    projectedMarkdown: fixture.projectedMarkdown,
    previousPointerBytes: fixture.oldPointerBytes,
    ...overrides,
  }
}

test("promotion consumes run ownership before pointer commit so outer cleanup is a post-commit no-op", async (t) => {
  const fixture = await validPromotionFixture(t, "release-promotion-ownership-")
  const removals = []
  const runOwnership = createOwnedRunLifecycle(fixture.runRoot, {
    removeTree: async (ownedPath, options) => {
      removals.push({ ownedPath, pointerBytes: await readFile(fixture.pointerPath) })
      await rm(ownedPath, options)
    },
  })

  const promoted = await promoteRelease(promotionInput(fixture, { runOwnership }))
  const committedPointerBytes = await readFile(fixture.pointerPath)
  assert.equal(JSON.parse(committedPointerBytes).release_digest, promoted.releaseDigest)
  assert.equal(removals.length, 1)
  assert.equal(removals[0].ownedPath, fixture.runRoot)
  assert.equal(removals[0].pointerBytes.equals(fixture.oldPointerBytes), true)
  assert.equal(runOwnership.owned, false)

  await runOwnership.cleanup()
  assert.equal(removals.length, 1, "outer finally must not issue any cleanup after pointer commit")
})

test("production promoteRelease ignores former fault fields even with the exact former capability", async (t) => {
  const control = await validPromotionFixture(t, "release-promotion-production-control-")
  const injected = await validPromotionFixture(t, "release-promotion-production-injected-")
  const controlResult = await promoteRelease(promotionInput(control, {
    runOwnership: createOwnedRunLifecycle(control.runRoot),
  }))
  const injectedResult = await promoteRelease(promotionInput(injected, {
    runOwnership: createOwnedRunLifecycle(injected.runRoot),
    promotionTestCase: "pointer-drift",
    promotionTestCapability: "t06-regression-v1",
  }))

  assert.deepEqual(injectedResult, controlResult)
  assert.deepEqual(await exactSnapshot(injected.runtimeRoot), await exactSnapshot(control.runtimeRoot))
  assert.deepEqual(await exactSnapshot(injected.releasesRoot), await exactSnapshot(control.releasesRoot))
  assert.equal(JSON.parse(await readFile(injected.pointerPath, "utf8")).release_digest, injectedResult.releaseDigest)
  assert.notEqual(injectedResult.releaseDigest, "d".repeat(64))
})

test("test-only promotion rollback seam preserves pointer and LKG for every safe fault boundary", async (t) => {
  const cases = [
    ["after release staging", "after-release-staging", true, { code: "PROMOTION_CONTROLLED_FAILURE", message: "controlled promotion failure" }],
    ["after custody staging", "after-custody-staging", true, { code: "PROMOTION_CONTROLLED_FAILURE", message: "controlled promotion failure" }],
    ["after release install", "after-release-install", true, { code: "PROMOTION_CONTROLLED_FAILURE", message: "controlled promotion failure" }],
    ["after custody install", "after-custody-install", true, { code: "PROMOTION_CONTROLLED_FAILURE", message: "controlled promotion failure" }],
    ["before pointer commit", "before-pointer-commit", true, { code: "PROMOTION_CONTROLLED_FAILURE", message: "controlled promotion failure" }],
    ["pointer replace failure", "pointer-replace-failure", false, { code: "CURRENT_POINTER_REPLACE_FAILED", message: "current release pointer could not be atomically replaced" }],
  ]

  for (const [name, faultCase, expectedOwned, expected] of cases) await t.test(name, async (t) => {
    const fixture = await validPromotionFixture(t, `release-promotion-test-only-${faultCase}-`)
    const runOwnership = createOwnedRunLifecycle(fixture.runRoot)
    const beforeRuntime = await exactSnapshot(fixture.runtimeRoot)
    const beforeReleases = await exactSnapshot(fixture.releasesRoot)
    const beforeRun = await exactSnapshot(fixture.runRoot)

    await assert.rejects(
      promoteReleaseForTest(promotionInput(fixture, { runOwnership }), { faultCase }),
      (error) => error.code === expected.code && error.message === expected.message,
    )

    assert.equal(runOwnership.owned, expectedOwned, "run ownership state must match whether commit preparation consumed the run")
    assert.deepEqual(await exactSnapshot(fixture.runtimeRoot), beforeRuntime)
    assert.deepEqual(await exactSnapshot(fixture.releasesRoot), beforeReleases)
    if (expectedOwned) assert.deepEqual(await exactSnapshot(fixture.runRoot), beforeRun)
    else await assert.rejects(lstat(fixture.runRoot), (error) => error.code === "ENOENT")
    assert.equal((await readFile(fixture.pointerPath)).equals(fixture.oldPointerBytes), true)
    assert.equal((await readdir(fixture.runtimeRoot)).some((entry) => /(?:tmp|staging)/i.test(entry)), false)
    assert.equal((await readdir(fixture.releasesRoot)).some((entry) => /(?:tmp|staging)/i.test(entry)), false)

    await runOwnership.cleanup()
    assert.equal(runOwnership.owned, false)
    await assert.rejects(lstat(fixture.runRoot), (error) => error.code === "ENOENT")
  })
})

test("test-only promotion seam rejects the retired destructive pointer-drift case before mutation", async (t) => {
  const fixture = await validPromotionFixture(t, "release-promotion-test-only-retired-pointer-drift-")
  const runOwnership = createOwnedRunLifecycle(fixture.runRoot)
  const beforeRuntime = await exactSnapshot(fixture.runtimeRoot)
  const beforeReleases = await exactSnapshot(fixture.releasesRoot)
  const beforeRun = await exactSnapshot(fixture.runRoot)

  await assert.rejects(
    promoteReleaseForTest(promotionInput(fixture, { runOwnership }), { faultCase: "pointer-drift" }),
    (error) => error.code === "TEST_INJECTION_INVALID"
      && error.message === "promotion regression injection is not a fixed supported variant",
  )
  assert.equal(runOwnership.owned, true)
  assert.deepEqual(await exactSnapshot(fixture.runtimeRoot), beforeRuntime)
  assert.deepEqual(await exactSnapshot(fixture.releasesRoot), beforeReleases)
  assert.deepEqual(await exactSnapshot(fixture.runRoot), beforeRun)
  await runOwnership.cleanup()
})

test("same-directory atomic replacement readers observe only complete old or new pointer bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-pointer-atomic-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pointerPath = path.join(root, "current-release.json")
  const oldBytes = Buffer.from('{"generation":"old","padding":"aaaaaaaaaaaaaaaa"}\n')
  const newBytes = Buffer.from('{"generation":"new","padding":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}\n')
  await writeFile(pointerPath, oldBytes)

  let reading = true
  const observations = []
  let announceFirstRead
  const firstRead = new Promise((resolve) => { announceFirstRead = resolve })
  let resumeReader
  const commitWindow = new Promise((resolve) => { resumeReader = resolve })
  const reader = (async () => {
    let first = true
    while (reading) {
      try {
        observations.push(await readFile(pointerPath))
      } catch (error) {
        observations.push(Buffer.from(`ERROR:${error.code}`))
      }
      if (first) {
        first = false
        announceFirstRead()
        await commitWindow
      }
      await delay(2)
    }
  })()
  await firstRead
  try {
    await atomicReplaceFile({ directory: root, targetName: "current-release.json", bytes: newBytes, expectedTargetBytes: oldBytes })
    resumeReader()
    for (let index = 0; index < 8; index += 1) await delay(2)
  } finally {
    resumeReader()
    reading = false
    await reader
  }

  assert.equal(observations.length > 2, true)
  assert.equal(observations.some((bytes) => bytes.equals(oldBytes)), true)
  assert.equal(observations.some((bytes) => bytes.equals(newBytes)), true)
  assert.equal(observations.every((bytes) => bytes.equals(oldBytes) || bytes.equals(newBytes)), true)
  assert.equal((await readFile(pointerPath)).equals(newBytes), true)
  assert.deepEqual(await readdir(root), ["current-release.json"])
})

test("held-open Windows pointer either replaces atomically or reports a stable failure with old bytes intact", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-pointer-held-open-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pointerPath = path.join(root, "current-release.json")
  const oldBytes = Buffer.from('{"generation":"old"}\n')
  const newBytes = Buffer.from('{"generation":"new"}\n')
  await writeFile(pointerPath, oldBytes)
  const held = await openFile(pointerPath, "r")
  let failure
  try {
    await atomicReplaceFile({ directory: root, targetName: "current-release.json", bytes: newBytes, expectedTargetBytes: oldBytes })
  } catch (error) {
    failure = error
  } finally {
    await held.close()
  }

  if (failure) {
    t.diagnostic(`${process.platform}: held-open pointer returned stable ${failure.code}`)
    assert.equal(failure.code, "CURRENT_POINTER_REPLACE_FAILED")
    assert.equal((await readFile(pointerPath)).equals(oldBytes), true)
  } else {
    t.diagnostic(`${process.platform}: held-open pointer replacement succeeded atomically`)
    assert.equal((await readFile(pointerPath)).equals(newBytes), true)
  }
  assert.deepEqual(await readdir(root), ["current-release.json"])
})

test("pending custody is consumed with the same promotion transaction and restored on pointer failure", async (t) => {
  const success = await validPromotionFixture(t, "release-promotion-pending-success-")
  await mkdir(path.join(success.runtimeRoot, "pending"))
  await writeFile(path.join(success.runtimeRoot, "pending", `${success.manifest.manifest_id}.json`), success.manifestRaw)
  await promoteRelease(promotionInput(success, { runOwnership: createOwnedRunLifecycle(success.runRoot) }))
  assert.deepEqual(await readdir(path.join(success.runtimeRoot, "pending")), [])
  assert.equal((await readFile(path.join(success.runtimeRoot, "consumed", success.manifest.manifest_id, "manifest.json"))).equals(success.manifestRaw), true)
  await assertNoRuntimeLease(success.runtimeRoot)

  const failure = await validPromotionFixture(t, "release-promotion-pending-failure-")
  await mkdir(path.join(failure.runtimeRoot, "pending"))
  const pendingPath = path.join(failure.runtimeRoot, "pending", `${failure.manifest.manifest_id}.json`)
  await writeFile(pendingPath, failure.manifestRaw)
  const runOwnership = createOwnedRunLifecycle(failure.runRoot)
  await assert.rejects(
    promoteReleaseForTest(promotionInput(failure, { runOwnership }), { faultCase: "before-pointer-commit" }),
    (error) => error.code === "PROMOTION_CONTROLLED_FAILURE",
  )
  assert.equal((await readFile(pendingPath)).equals(failure.manifestRaw), true)
  assert.equal((await readFile(failure.pointerPath)).equals(failure.oldPointerBytes), true)
  await assertNoRuntimeLease(failure.runtimeRoot)
  await runOwnership.cleanup()
})

test("cooperating concurrent promotions allow at most one transition and preserve pending/LKG boundaries", async (t) => {
  const fixture = await validPromotionFixture(t, "release-promotion-concurrent-")
  const pendingRoot = path.join(fixture.runtimeRoot, "pending")
  await mkdir(pendingRoot)
  const pendingPath = path.join(pendingRoot, `${fixture.manifest.manifest_id}.json`)
  await writeFile(pendingPath, fixture.manifestRaw)

  const secondRunRoot = path.join(fixture.root, "work", "second-owned-run")
  const secondCandidateRoot = path.join(secondRunRoot, "candidate")
  await cp(fixture.candidateRoot, secondCandidateRoot, { recursive: true })
  const firstOwnership = createOwnedRunLifecycle(fixture.runRoot)
  const secondOwnership = createOwnedRunLifecycle(secondRunRoot)
  const originalConsume = firstOwnership.consumeBeforeCommit
  let signalFirst
  let allowFirst
  const firstReachedCommit = new Promise((resolve) => { signalFirst = resolve })
  const firstMayCommit = new Promise((resolve) => { allowFirst = resolve })
  firstOwnership.consumeBeforeCommit = async (...args) => {
    signalFirst()
    await firstMayCommit
    return originalConsume(...args)
  }
  const secondInput = promotionInput({ ...fixture, runRoot: secondRunRoot, candidateRoot: secondCandidateRoot }, { runOwnership: secondOwnership })
  const firstPromise = promoteRelease(promotionInput(fixture, { runOwnership: firstOwnership }))
  await firstReachedCommit
  const secondPromise = promoteRelease(secondInput)
  const outcomesPromise = Promise.allSettled([firstPromise, secondPromise])
  await delay(100)
  allowFirst()
  const outcomes = await outcomesPromise
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1)
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1)
  assert.equal(outcomes.find((outcome) => outcome.status === "rejected").reason.code, "RUNTIME_TRANSACTION_BUSY")
  assert.deepEqual(await readdir(pendingRoot), [])
  const pointer = JSON.parse(await readFile(fixture.pointerPath, "utf8"))
  assert.notEqual(pointer.release_digest, "f".repeat(64))
  assert.equal((await readFile(path.join(fixture.releasesRoot, "f".repeat(64), "index.html"), "utf8")), "last known good\n")
  assert.deepEqual((await readdir(path.join(fixture.runtimeRoot, "consumed"))).sort(), [fixture.manifest.manifest_id])
  await firstOwnership.cleanup().catch(() => {})
  await secondOwnership.cleanup().catch(() => {})
})

test("corrupt preexisting digest collision preserves pointer, LKG, collision, candidate, and leaves no staging", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-promotion-collision-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtimeRoot = path.join(root, "runtime")
  const releasesRoot = path.join(root, "releases")
  const runRoot = path.join(root, "work", "owned-run")
  const candidateRoot = path.join(runRoot, "candidate")
  await Promise.all([mkdir(runtimeRoot), mkdir(releasesRoot), mkdir(candidateRoot, { recursive: true })])
  await writeFile(path.join(candidateRoot, "graph.json"), '{"schema_version":1}\n')
  await mkdir(path.join(candidateRoot, "nested"))
  await writeFile(path.join(candidateRoot, "nested", "index.html"), "<!doctype html>\n")

  const manifestPath = path.join(root, "manifest.json")
  const manifestRaw = await readFile(path.join(repoRoot, "specs", "examples", "publish-unit-manifest-v1.example.json"))
  await writeFile(manifestPath, manifestRaw)
  const manifest = JSON.parse(manifestRaw)
  const projectedMarkdown = new Map([
    ["flow", Buffer.from("---\ntitle: Existing\n---\n\n# Existing\n")],
    ["jackman-2021", Buffer.from("---\ntitle: Paper\n---\n\n# Paper\n")],
  ])
  const receipt = await constructReleaseReceipt({
    manifest,
    createdAt: "2026-07-28T12:34:56Z",
    projectedMarkdown,
    artifacts: await readCandidateArtifactTree(candidateRoot),
  })

  const oldDigest = "f".repeat(64)
  const oldReleaseRoot = path.join(releasesRoot, oldDigest)
  await mkdir(oldReleaseRoot)
  await writeFile(path.join(oldReleaseRoot, "index.html"), "last known good\n")
  const oldPointerBytes = Buffer.from(`${JSON.stringify({ schema_version: 1, release_digest: oldDigest, receipt_path: "consumed/old/release-receipt.json" })}\n`)
  await writeFile(path.join(runtimeRoot, "current-release.json"), oldPointerBytes)
  const collisionRoot = path.join(releasesRoot, receipt.release_digest)
  await mkdir(collisionRoot)
  await writeFile(path.join(collisionRoot, "corrupt.txt"), "collision sentinel\n")

  const before = {
    runtime: await exactSnapshot(runtimeRoot),
    releases: await exactSnapshot(releasesRoot),
    run: await exactSnapshot(runRoot),
  }
  await assert.rejects(promoteRelease({
    candidateRoot,
    runRoot,
    releasesRoot,
    runtimeRoot,
    manifestPath,
    manifestRaw,
    manifest,
    receipt,
    projectedMarkdown,
    previousPointerBytes: oldPointerBytes,
    runOwnership: createOwnedRunLifecycle(runRoot),
  }), (error) => error.code === "RELEASE_FINAL_COLLISION")

  assert.deepEqual(await exactSnapshot(runtimeRoot), before.runtime)
  assert.deepEqual(await exactSnapshot(releasesRoot), before.releases)
  assert.deepEqual(await exactSnapshot(runRoot), before.run)
  assert.equal((await readFile(path.join(runtimeRoot, "current-release.json"))).equals(oldPointerBytes), true)
  assert.deepEqual(await readdir(oldReleaseRoot), ["index.html"])
  assert.deepEqual(await readdir(collisionRoot), ["corrupt.txt"])
})

test("pending root is rejected as a non-ordinary custody root before any promotion mutation", async (t) => {
  const fixture = await validPromotionFixture(t, "release-promotion-pending-root-file-")
  await writeFile(path.join(fixture.runtimeRoot, "pending"), "not a directory\n")
  const beforeRuntime = await exactSnapshot(fixture.runtimeRoot)
  await assert.rejects(
    promoteRelease(promotionInput(fixture, { runOwnership: createOwnedRunLifecycle(fixture.runRoot) })),
    (error) => error.code === "RUNTIME_FILE_CLASS_INVALID",
  )
  assert.deepEqual(await exactSnapshot(fixture.runtimeRoot), beforeRuntime)
  assert.equal((await readFile(fixture.pointerPath)).equals(fixture.oldPointerBytes), true)
})

test("failed pending restore preserves unique custody and release evidence as recovery custody", async (t) => {
  const fixture = await validPromotionFixture(t, "release-promotion-pending-restore-failure-")
  const pendingRoot = path.join(fixture.runtimeRoot, "pending")
  await mkdir(pendingRoot)
  await writeFile(path.join(pendingRoot, `${fixture.manifest.manifest_id}.json`), fixture.manifestRaw)
  const runOwnership = createOwnedRunLifecycle(fixture.runRoot)
  await assert.rejects(
    promoteReleaseForTest(promotionInput(fixture, { runOwnership }), { faultCase: "pending-restore-failure" }),
    (error) => error.code === "PENDING_CUSTODY_RESTORE_FAILED",
  )
  assert.equal((await readFile(fixture.pointerPath)).equals(fixture.oldPointerBytes), true)
  const custodyRoot = path.join(fixture.runtimeRoot, "consumed", fixture.manifest.manifest_id)
  assert((await readFile(path.join(custodyRoot, "manifest.json"))).equals(fixture.manifestRaw))
  assert.equal((await readFile(path.join(custodyRoot, "release-receipt.json"))).length > 0, true)
  assert.equal((await readFile(path.join(fixture.releasesRoot, fixture.receipt.release_digest, "nested", "index.html"))).toString(), "<!doctype html>\n")
  await assertNoRuntimeLease(fixture.runtimeRoot)
  await runOwnership.cleanup()
})
