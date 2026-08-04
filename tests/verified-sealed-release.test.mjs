// @ts-nocheck -- security fixtures intentionally assemble sealed runtime trees.
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  loadVerifiedSealedRelease,
  loadVerifiedSealedReleaseForIdentity,
  revalidateVerifiedSealedRelease,
  verifiedSealedReleaseIdentity,
} from "../lib/verified-sealed-release.mjs"
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
  return { runtimeRoot, releasesRoot, manifest, receipt, releaseRoot, artifactPath, custodyRoot, capability }
}

async function expectVerifiedError(promise, expected) {
  await assert.rejects(promise, (error) => {
    const actual = `${error?.code ?? ""} ${error?.message ?? ""}`
    if (expected instanceof RegExp) return expected.test(actual)
    const codes = new Set(Array.isArray(expected) ? expected : [expected])
    return codes.has(error?.code)
  })
}

test("VerifiedSealedRelease is opaque and only exposes identity after sealed custody verification", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-verified-sealed-release-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const candidate = await installSealedRelease(root, "candidate", "2026-07-28T12:34:56Z", "candidate bytes\n")

  assert.equal(Object.isFrozen(candidate.capability), true)
  assert.deepEqual(Reflect.ownKeys(candidate.capability), [])
  const identity = verifiedSealedReleaseIdentity(candidate.capability)
  assert.match(identity.releaseId, /^VPUB-/)
  assert.deepEqual(Object.keys(identity).sort(), ["generation", "releaseDigest", "releaseId"])

  const evidence = await revalidateVerifiedSealedRelease(candidate.capability)
  assert.deepEqual(evidence.release, identity)
  assert.equal(evidence.authority.sealedDescriptorId, candidate.manifest.manifest_id)
  assert.equal(evidence.authority.receipt.receiptId, candidate.receipt.release_digest)
  assert.equal(evidence.authority.inventory[0].path, "index.html")
  await expectVerifiedError(revalidateVerifiedSealedRelease({ ...evidence }), "VERIFIED_SEALED_RELEASE_CAPABILITY_REQUIRED")
})

test("sealed custody revalidation rejects tampered manifest and receipt bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-verified-sealed-custody-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const candidate = await installSealedRelease(root, "custody", "2026-07-28T12:34:56Z", "candidate bytes\n")
  const manifestPath = path.join(candidate.custodyRoot, "manifest.json")
  const receiptPath = path.join(candidate.custodyRoot, "release-receipt.json")
  const manifestBytes = await readFile(manifestPath)
  const receiptBytes = await readFile(receiptPath)

  await writeFile(manifestPath, Buffer.from(`${manifestBytes.toString("utf8")}tampered`))
  await expectVerifiedError(revalidateVerifiedSealedRelease(candidate.capability), /JSON|custody|manifest|receipt/i)
  await writeFile(manifestPath, manifestBytes)

  await writeFile(receiptPath, Buffer.from(`${receiptBytes.toString("utf8")}tampered`))
  await expectVerifiedError(revalidateVerifiedSealedRelease(candidate.capability), /JSON|custody|manifest|receipt/i)
})

test("candidate and last-known-good capabilities revalidate their exact artifact bytes independently", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-verified-sealed-candidate-lkg-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lkg = await installSealedRelease(root, "lkg", "2026-07-28T12:34:56Z", "lkg bytes\n")
  const candidate = await installSealedRelease(root, "candidate", "2026-07-28T13:34:56Z", "candidate bytes\n")

  const lkgIdentity = verifiedSealedReleaseIdentity(lkg.capability)
  const candidateIdentity = verifiedSealedReleaseIdentity(candidate.capability)
  assert.notDeepEqual(lkgIdentity, candidateIdentity)
  assert.deepEqual((await revalidateVerifiedSealedRelease(lkg.capability)).release, lkgIdentity)
  assert.deepEqual((await revalidateVerifiedSealedRelease(candidate.capability)).release, candidateIdentity)

  await writeFile(lkg.artifactPath, "tampered lkg\n")
  await expectVerifiedError(revalidateVerifiedSealedRelease(lkg.capability), /artifact|bytes|receipt|changed/i)
  assert.deepEqual((await revalidateVerifiedSealedRelease(candidate.capability)).release, candidateIdentity)

  await writeFile(lkg.artifactPath, "lkg bytes\n")
  await writeFile(candidate.artifactPath, "tampered candidate\n")
  await expectVerifiedError(revalidateVerifiedSealedRelease(candidate.capability), /artifact|bytes|receipt|changed/i)
  assert.deepEqual((await revalidateVerifiedSealedRelease(lkg.capability)).release, lkgIdentity)
})

test("identity recovery revalidates the same sealed candidate and rejects forged release identities", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-verified-sealed-identity-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const candidate = await installSealedRelease(root, "identity", "2026-07-28T12:34:56Z", "candidate bytes\n")
  const release = verifiedSealedReleaseIdentity(candidate.capability)
  const recovered = await loadVerifiedSealedReleaseForIdentity({
    runtimeRoot: candidate.runtimeRoot,
    releasesRoot: candidate.releasesRoot,
    release,
  })
  assert.deepEqual(verifiedSealedReleaseIdentity(recovered), release)
  await expectVerifiedError(loadVerifiedSealedReleaseForIdentity({
    runtimeRoot: candidate.runtimeRoot,
    releasesRoot: candidate.releasesRoot,
    release: { ...release, releaseDigest: "0".repeat(64) },
  }), ["VERIFIED_SEALED_RELEASE_IDENTITY_INVALID", "VERIFIED_SEALED_RELEASE_BYTES_INVALID"])
})
