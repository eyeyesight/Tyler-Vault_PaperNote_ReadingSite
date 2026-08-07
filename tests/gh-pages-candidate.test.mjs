// @ts-nocheck -- filesystem fixtures exercise the sealed release boundary.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  loadVerifiedSealedRelease,
  revalidateVerifiedSealedRelease,
} from "../lib/verified-sealed-release.mjs"
import {
  computeGitHubLaunchAuditDigest,
  computeGitHubLaunchAuditEvidenceDigest,
} from "../lib/github-launch-audit.mjs"
import { computePlanDigest, jcsCanonicalize, sha256Jcs } from "../lib/publication-contracts.mjs"
import { constructReleaseReceipt, readCandidateArtifactTree } from "../lib/safe-release.mjs"
import {
  prepareGhPagesCandidate,
  verifyGhPagesCandidate,
} from "../lib/gh-pages-candidate.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const expectedUrl = "https://eyeyesight.github.io/Tyler-Vault_PaperNote_ReadingSite/"
const basePath = "/Tyler-Vault_PaperNote_ReadingSite"

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

async function installSealedRelease(root, suffix = "candidate", missingArtifacts = []) {
  const runtimeRoot = path.join(root, "runtime")
  const releasesRoot = path.join(root, "releases")
  const sourceRoot = path.join(root, "Vault")
  await Promise.all([
    mkdir(runtimeRoot, { recursive: true }),
    mkdir(releasesRoot, { recursive: true }),
    mkdir(sourceRoot, { recursive: true }),
  ])
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "specs", "examples", "publish-unit-manifest-v1.example.json"), "utf8"))
  manifest.manifest_id = `VPUB-20260728-${suffix}`
  manifest.plan_digest = computePlanDigest(manifest)
  manifest.approval_receipt.approved_plan_digest = manifest.plan_digest
  const artifactBytes = new Map([
    ["index.html", Buffer.from("<!doctype html>\n<h1>sealed</h1>\n")],
    ["404.html", Buffer.from("<!doctype html>\n<h1>not found</h1>\n")],
    ["assets/app.css", Buffer.from("body{color:#123;}\n")],
  ])
  for (const relative of missingArtifacts) artifactBytes.delete(relative)
  const staging = path.join(root, `input-${suffix}`)
  await mkdir(path.join(staging, "assets"), { recursive: true })
  for (const [relative, bytes] of artifactBytes) await writeFile(path.join(staging, ...relative.split("/")), bytes)
  const receipt = await constructReleaseReceipt({
    manifest,
    createdAt: "2026-07-28T12:34:56Z",
    projectedMarkdown: new Map([
      ["flow", Buffer.from("---\ntitle: Existing\n---\n\n# Existing\n")],
      ["jackman-2021", Buffer.from("---\ntitle: Paper\n---\n\n# Paper\n")],
    ]),
    artifacts: await readCandidateArtifactTree(staging),
  })
  const releaseRoot = path.join(releasesRoot, receipt.release_digest)
  for (const [relative, bytes] of artifactBytes) {
    const destination = path.join(releaseRoot, ...relative.split("/"))
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, bytes)
  }
  const custodyRoot = path.join(runtimeRoot, "consumed", manifest.manifest_id)
  await mkdir(custodyRoot, { recursive: true })
  await writeFile(path.join(custodyRoot, "manifest.json"), `${jcsCanonicalize(manifest)}\n`)
  await writeFile(path.join(custodyRoot, "release-receipt.json"), `${jcsCanonicalize(receipt)}\n`)
  const capability = await loadVerifiedSealedRelease({ runtimeRoot, releasesRoot, manifestId: manifest.manifest_id })
  return { runtimeRoot, releasesRoot, sourceRoot, manifest, receipt, releaseRoot, capability, artifactBytes, custodyRoot }
}

async function expectCode(promise, codes) {
  if (codes instanceof RegExp) {
    await assert.rejects(promise, (error) => codes.test(`${error?.code ?? ""} ${error?.message ?? ""}`))
    return
  }
  const expected = new Set(Array.isArray(codes) ? codes : [codes])
  await assert.rejects(promise, (error) => expected.has(error?.code))
}

function makeLaunchAudit(sealedArtifactDigest) {
  const audit = {
    schema_version: 1,
    audit_id: "launch-audit-candidate-test",
    audit_kind: "one-time-launch-audit",
    repository: {
      owner: "eyeyesight",
      name: "Tyler-Vault_PaperNote_ReadingSite",
      html_url: "https://github.com/eyeyesight/Tyler-Vault_PaperNote_ReadingSite",
      default_branch: "main",
      target_visibility: "public",
    },
    summary: "Candidate launch audit fixture.",
    created_at: "2026-08-04T12:00:00Z",
    visibility_changed_at: "2026-08-04T12:20:00Z",
    completed_at: "2026-08-04T12:30:00Z",
    finalized_at: "2026-08-04T12:32:00Z",
    scope: {
      lifecycle_phases: ["previsibility_audit", "visibility_approval", "post_visibility_readback", "finalize_launch_audit"],
      previsibility_audit: {
        required: true,
        local_mirror: { required: true, root: "workspace-mirror/site", checks: ["allowlist"] },
        checks: ["allowlist"],
      },
      authenticated_github_evidence: {
        required: true,
        machine_lane: {
          required: true,
          single_lane: true,
          transport: "gh-api-paginate",
          authentication: "authenticated",
          pagination: "complete",
          checks: ["metadata"],
        },
        ui_corroboration: { required: false, role: "corroboration-only" },
      },
      post_visibility_readback: {
        required: true,
        after_visibility_change: true,
        surfaces: ["repository", "api", "anonymous-repository"],
        checks: ["readback"],
      },
      anonymous_repository_readback: {
        required: true,
        after_visibility_change: true,
        authentication: "none",
        checks: ["anonymous"],
      },
      source_commit: "0123456789abcdef0123456789abcdef01234567",
      sealed_artifact_digest: sealedArtifactDigest,
    },
    evidence: [],
    findings: {
      status: "clear",
      counts: { secret: 0, rights_unknown: 0, disallowed_output: 0, control_plane: 0, repository: 0 },
      items: [],
    },
    limitations: {
      known_clones_and_cached_views: { status: "not-provable", zero_gate: false, note: "Not a zero gate." },
      unknown_external_copies: { status: "not-provable", zero_gate: false, note: "Not a zero gate." },
      zero_gate: { required_for_launch: false, reason: "Bounded audit." },
      statement: "External copies are not provable.",
    },
    approvals: {
      visibility: {
        required: true,
        status: "approved",
        approved_by: "fixture-reviewer",
        approved_at: "2026-08-04T12:18:00Z",
        reference: "fixture://approval",
      },
    },
  }
  const evidence = [
    ["evidence-pre", "previsibility_audit", "github-api", "api", "2026-08-04T12:10:00Z"],
    ["evidence-repo", "post_visibility_readback", "github-repository", "repository", "2026-08-04T12:22:00Z"],
    ["evidence-api", "post_visibility_readback", "github-api", "api", "2026-08-04T12:24:00Z"],
    ["evidence-anon", "post_visibility_readback", "anonymous-repository", "anonymous-repository", "2026-08-04T12:28:00Z"],
  ].map(([id, phase, source, surface, observed_at]) => {
    const observation = { surface, result: "clear", checks: ["readback"] }
    const item = {
      id,
      phase,
      plane: source === "github-api" && phase === "previsibility_audit" ? "github-control-plane" : "github-control-plane",
      source,
      locator: `fixture://${id}`,
      authentication: source === "anonymous-repository" ? "none" : "authenticated",
      pagination: source === "github-api" ? "complete" : "not-applicable",
      observed_at,
      result: "clear",
      finding_ids: [],
      observation,
      summary: "Fixture evidence.",
    }
    item.evidence_digest = computeGitHubLaunchAuditEvidenceDigest(item)
    return item
  })
  audit.evidence = evidence
  audit.audit_digest = computeGitHubLaunchAuditDigest(audit)
  return audit
}

async function addLaunchAudit(candidateRoot) {
  const publication = path.join(candidateRoot, ".publication")
  await mkdir(publication, { recursive: true })
  const metadata = JSON.parse(await readFile(path.join(publication, "gh-pages-candidate-v1.json"), "utf8"))
  const audit = makeLaunchAudit(metadata.source_artifact.artifact_digest)
  await writeFile(path.join(publication, "github-launch-audit-v1.json"), `${jcsCanonicalize(audit)}\n`)
  return audit
}

async function rewriteCandidateMetadata(candidateRoot, changes) {
  const metadataPath = path.join(candidateRoot, ".publication", "gh-pages-candidate-v1.json")
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"))
  const updated = { ...metadata, ...changes }
  const unsigned = { ...updated }
  delete unsigned.candidate_digest
  updated.candidate_digest = sha256Jcs(unsigned)
  await writeFile(metadataPath, `${jcsCanonicalize(updated)}\n`)
  return updated
}

test("verify accepts an ordinary Git checkout .git directory without treating it as candidate content", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-pages-candidate-git-directory-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sealed = await installSealedRelease(root, "git-directory")
  const candidateRoot = path.join(root, "output")
  const prepared = await prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot: candidateRoot, expectedUrl, basePath })
  const gitRoot = path.join(candidateRoot, ".git")
  await mkdir(path.join(gitRoot, "objects"), { recursive: true })
  await writeFile(path.join(gitRoot, "HEAD"), "ref: refs/heads/main\n")

  const stageOutputRoot = path.join(root, "stage-output")
  const verified = await verifyGhPagesCandidate({
    candidateRoot,
    expectedCandidateDigest: prepared.candidateDigest,
    stageOutputRoot,
  })

  assert.equal(verified.verified, true)
  assert.equal(verified.staged, true)
  assert.equal((await readdir(stageOutputRoot)).includes(".git"), false)
  assert.deepEqual((await readdir(candidateRoot)).sort(), [".git", ".publication", "site"])
})

test("verify accepts an ordinary linked-worktree .git file without treating it as candidate content", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-pages-candidate-git-file-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sealed = await installSealedRelease(root, "git-file")
  const candidateRoot = path.join(root, "output")
  const prepared = await prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot: candidateRoot, expectedUrl, basePath })
  await writeFile(path.join(candidateRoot, ".git"), "gitdir: ../.git/worktrees/output\n")

  const stageOutputRoot = path.join(root, "stage-output")
  const verified = await verifyGhPagesCandidate({
    candidateRoot,
    expectedCandidateDigest: prepared.candidateDigest,
    stageOutputRoot,
  })

  assert.equal(verified.verified, true)
  assert.equal(verified.staged, true)
  assert.equal((await readdir(stageOutputRoot)).includes(".git"), false)
})

test("verify rejects an unexpected root entry even when a Git control entry is present", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-pages-candidate-git-extra-root-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sealed = await installSealedRelease(root, "git-extra-root")
  const candidateRoot = path.join(root, "output")
  await prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot: candidateRoot, expectedUrl, basePath })
  await mkdir(path.join(candidateRoot, ".git"))
  await writeFile(path.join(candidateRoot, "unexpected.txt"), "not candidate content\n")

  await expectCode(verifyGhPagesCandidate({ candidateRoot }), "CANDIDATE_TREE_SET_MISMATCH")
})

test("verify rejects a symlink or reparse-point Git control entry", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-pages-candidate-git-link-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sealed = await installSealedRelease(root, "git-link")
  const candidateRoot = path.join(root, "output")
  await prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot: candidateRoot, expectedUrl, basePath })

  try {
    await symlink(sealed.releaseRoot, path.join(candidateRoot, ".git"), process.platform === "win32" ? "junction" : "dir")
  } catch (error) {
    if (["EACCES", "EPERM", "ENOSYS", "UNKNOWN"].includes(error?.code)) {
      t.skip("symlink or junction creation is unavailable")
      return
    }
    throw error
  }
  await expectCode(verifyGhPagesCandidate({ candidateRoot }), "CANDIDATE_SYMLINK_NOT_ALLOWED")
})

test("verify rejects case-colliding Git control entries", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-pages-candidate-git-case-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sealed = await installSealedRelease(root, "git-case")
  const candidateRoot = path.join(root, "output")
  await prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot: candidateRoot, expectedUrl, basePath })
  await mkdir(path.join(candidateRoot, ".git"))
  try {
    await mkdir(path.join(candidateRoot, ".GIT"))
  } catch (error) {
    if (["EACCES", "EEXIST", "EPERM"].includes(error?.code)) {
      t.skip("case-colliding root entries are unavailable on this filesystem")
      return
    }
    throw error
  }
  await expectCode(verifyGhPagesCandidate({ candidateRoot }), "CANDIDATE_TREE_CASE_COLLISION")
})

test("prepare creates a deterministic exact candidate with .nojekyll and stable digests", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-pages-candidate-positive-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sealed = await installSealedRelease(root, "positive")
  const targetRoot = path.join(root, "output")
  const summary = await prepareGhPagesCandidate({
    verifiedSealedRelease: sealed.capability,
    targetRoot,
    sourceRoot: sealed.sourceRoot,
    expectedUrl,
    basePath,
  })
  assert.equal(summary.verified, true)
  assert.equal(Object.isFrozen(summary), true)
  assert.equal(summary.site.inventory.some((entry) => entry.path === ".nojekyll"), true)
  assert.equal(summary.site.digest, sha256Jcs(summary.site.inventory))
  assert.equal(summary.candidateDigest, summary.candidate_digest ?? summary.candidateDigest)
  assert.deepEqual(await readdir(targetRoot), [".publication", "site"])
  assert.deepEqual(await readFile(path.join(targetRoot, "site", ".nojekyll")), Buffer.alloc(0))
  const second = await verifyGhPagesCandidate({ candidateRoot: targetRoot })
  assert.deepEqual(second, summary)
  assert.deepEqual(await verifyGhPagesCandidate({ candidateRoot: targetRoot }), second)
})

test("prepare rejects a sealed artifact missing the active custom 404 file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-pages-candidate-missing-custom-404-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sealed = await installSealedRelease(root, "missing-custom-404", ["404.html"])
  await expectCode(
    prepareGhPagesCandidate({
      verifiedSealedRelease: sealed.capability,
      targetRoot: path.join(root, "output"),
      expectedUrl,
      basePath,
    }),
    "CANDIDATE_STATIC_SITE_FILE_MISSING",
  )
})

test("prepare rejects a sealed artifact missing the active entry file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-pages-candidate-missing-entry-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sealed = await installSealedRelease(root, "missing-entry", ["index.html"])
  await expectCode(
    prepareGhPagesCandidate({
      verifiedSealedRelease: sealed.capability,
      targetRoot: path.join(root, "output"),
      expectedUrl,
      basePath,
    }),
    "CANDIDATE_STATIC_SITE_FILE_MISSING",
  )
})

test("verify rejects candidate inventories missing the active custom 404 file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-pages-candidate-verify-missing-custom-404-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sealed = await installSealedRelease(root, "verify-missing-custom-404")
  const candidateRoot = path.join(root, "output")
  await prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot: candidateRoot, expectedUrl, basePath })

  const metadata = JSON.parse(await readFile(path.join(candidateRoot, ".publication", "gh-pages-candidate-v1.json"), "utf8"))
  const sourceInventory = metadata.source_artifact.inventory.filter(({ path: relative }) => relative !== "404.html")
  const siteInventory = metadata.candidate_site.inventory.filter(({ path: relative }) => relative !== "404.html")
  await rm(path.join(candidateRoot, "site", "404.html"))
  await rewriteCandidateMetadata(candidateRoot, {
    source_artifact: {
      ...metadata.source_artifact,
      byte_length: sourceInventory.reduce((sum, entry) => sum + entry.byteLength, 0),
      inventory: sourceInventory,
      artifact_digest: sha256Jcs(sourceInventory),
    },
    candidate_site: {
      inventory: siteInventory,
      digest: sha256Jcs(siteInventory),
    },
  })
  await expectCode(verifyGhPagesCandidate({ candidateRoot }), "CANDIDATE_STATIC_SITE_FILE_MISSING")
})

test("candidate metadata binds real manifest and receipt without inventing a rights digest", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-pages-candidate-metadata-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sealed = await installSealedRelease(root, "metadata")
  const targetRoot = path.join(root, "output")
  await prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot, expectedUrl, basePath })
  const metadata = JSON.parse(await readFile(path.join(targetRoot, ".publication", "gh-pages-candidate-v1.json"), "utf8"))
  assert.equal(metadata.approved_manifest.manifest_id, sealed.manifest.manifest_id)
  assert.equal(metadata.approved_manifest.plan_digest, sealed.manifest.plan_digest)
  assert.equal(metadata.approved_receipt.release_digest, sealed.receipt.release_digest)
  assert.equal(metadata.approved_manifest.manifest_sha256, sha256(Buffer.from(`${jcsCanonicalize(sealed.manifest)}\n`)))
  assert.equal(metadata.approved_receipt.receipt_sha256, sha256(Buffer.from(`${jcsCanonicalize(sealed.receipt)}\n`)))
  assert.equal(Object.hasOwn(metadata, "rights_digest"), false)
  assert.equal(Object.hasOwn(metadata.rights_authority, "rights_digest"), false)
  assert.equal(metadata.expected_url, expectedUrl)
  assert.equal(metadata.base_path, basePath)
})

test("verify accepts expected candidate and launch-audit digests and rejects invalid or mismatched expectations", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-pages-candidate-expected-digests-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sealed = await installSealedRelease(root, "expected-digests")
  const candidateRoot = path.join(root, "output")
  const prepared = await prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot: candidateRoot, expectedUrl, basePath })
  const audit = await addLaunchAudit(candidateRoot)

  const verified = await verifyGhPagesCandidate({
    candidateRoot,
    requireLaunchAudit: true,
    expectedCandidateDigest: prepared.candidateDigest,
    expectedLaunchAuditDigest: audit.audit_digest,
  })
  assert.equal(verified.candidateDigest, prepared.candidateDigest)
  assert.equal(verified.launchAuditDigest, audit.audit_digest)

  await expectCode(
    verifyGhPagesCandidate({ candidateRoot, expectedCandidateDigest: "A".repeat(64) }),
    "CANDIDATE_EXPECTED_DIGEST_INVALID",
  )
  await expectCode(
    verifyGhPagesCandidate({ candidateRoot, expectedLaunchAuditDigest: "0".repeat(63) }),
    "LAUNCH_AUDIT_EXPECTED_DIGEST_INVALID",
  )
  await expectCode(
    verifyGhPagesCandidate({
      candidateRoot,
      expectedCandidateDigest: prepared.candidateDigest === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64),
    }),
    "CANDIDATE_DIGEST_MISMATCH",
  )
  await expectCode(
    verifyGhPagesCandidate({
      candidateRoot,
      requireLaunchAudit: true,
      expectedLaunchAuditDigest: audit.audit_digest === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64),
    }),
    "LAUNCH_AUDIT_DIGEST_MISMATCH",
  )
})

test("verify binds candidate URL and base path to the active deployment contract", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-pages-candidate-active-site-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sealed = await installSealedRelease(root, "active-site")
  const candidateRoot = path.join(root, "output")
  await prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot: candidateRoot, expectedUrl, basePath })

  await rewriteCandidateMetadata(candidateRoot, {
    expected_url: "https://example.com/Tyler-Vault_PaperNote_ReadingSite/",
    base_path: basePath,
  })
  await expectCode(verifyGhPagesCandidate({ candidateRoot }), "CANDIDATE_SITE_IDENTITY_INVALID")
})

test("Windows accepts a case-variant stage path spelling and keeps the canonical no-link directory usable", async (t) => {
  if (process.platform !== "win32") {
    t.skip("case-variant path identity regression is Windows-specific")
    return
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-pages-candidate-case-variant-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sealed = await installSealedRelease(root, "case-variant")
  const candidateRoot = path.join(root, "output")
  const prepared = await prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot: candidateRoot, expectedUrl, basePath })
  const audit = await addLaunchAudit(candidateRoot)
  const canonicalStageRoot = path.join(root, "Stage-Output")
  const caseVariantStageRoot = canonicalStageRoot.toLowerCase()
  assert.notEqual(caseVariantStageRoot, canonicalStageRoot)

  const summary = await verifyGhPagesCandidate({
    candidateRoot,
    requireLaunchAudit: true,
    expectedCandidateDigest: prepared.candidateDigest,
    expectedLaunchAuditDigest: audit.audit_digest,
    stageOutputRoot: caseVariantStageRoot,
  })
  assert.equal(summary.staged, true)
  const canonicalMetadata = await lstat(canonicalStageRoot, { bigint: true })
  const variantMetadata = await lstat(caseVariantStageRoot, { bigint: true })
  assert.equal(variantMetadata.dev, canonicalMetadata.dev)
  assert.equal(variantMetadata.ino, canonicalMetadata.ino)
  const resolvedStageRoot = await realpath(caseVariantStageRoot)
  assert.deepEqual((await readCandidateArtifactTree(resolvedStageRoot)).map(({ path: relative }) => relative), [".nojekyll", "404.html", "assets/app.css", "index.html"])
})

test("verify rejects tamper, extra, missing, case-collision, symlink, and nonregular site entries", async (t) => {
  const cases = [
    ["tamper", async (candidateRoot) => writeFile(path.join(candidateRoot, "site", "index.html"), "tampered\n"), "CANDIDATE_SITE_HASH_MISMATCH"],
    ["extra", async (candidateRoot) => writeFile(path.join(candidateRoot, "site", "extra.txt"), "extra\n"), "CANDIDATE_SITE_SET_MISMATCH"],
    ["missing", async (candidateRoot) => rm(path.join(candidateRoot, "site", "index.html")), ["CANDIDATE_STATIC_SITE_FILE_MISSING", "CANDIDATE_SITE_SET_MISMATCH"]],
    ["case", async (candidateRoot) => writeFile(path.join(candidateRoot, "site", "INDEX.HTML"), "collision\n"), ["CANDIDATE_SITE_CASE_COLLISION", "CANDIDATE_SITE_HASH_MISMATCH", "CANDIDATE_SITE_SET_MISMATCH"]],
    ["directory", async (candidateRoot) => { await rm(path.join(candidateRoot, "site", "index.html")); await mkdir(path.join(candidateRoot, "site", "index.html")) }, ["CANDIDATE_STATIC_SITE_FILE_MISSING", "CANDIDATE_SITE_CLASS_INVALID", "CANDIDATE_SITE_SET_MISMATCH"]],
  ]
  for (const [label, mutate, code] of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), `gh-pages-candidate-${label}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const sealed = await installSealedRelease(root, label)
    const targetRoot = path.join(root, "output")
    await prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot, expectedUrl, basePath })
    await mutate(targetRoot)
    await expectCode(verifyGhPagesCandidate({ candidateRoot: targetRoot }), code)
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-pages-candidate-symlink-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sealed = await installSealedRelease(root, "symlink")
  const targetRoot = path.join(root, "output")
  await prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot, expectedUrl, basePath })
  try {
    await rm(path.join(targetRoot, "site", "index.html"))
    await symlink(sealed.artifactBytes.get("index.html"), path.join(targetRoot, "site", "index.html"))
    await expectCode(verifyGhPagesCandidate({ candidateRoot: targetRoot }), ["CANDIDATE_SITE_CLASS_INVALID", "CANDIDATE_SITE_PATH_INVALID"])
  } catch (error) {
    if (!(["EPERM", "EACCES", "UNKNOWN"].includes(error?.code))) throw error
    t.diagnostic("symlink creation unavailable; boundary covered by existing sealed tree tests")
  }
})

test("prepare rejects forged capabilities, stale custody, unsafe targets, and preserves source bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-pages-candidate-safety-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sealed = await installSealedRelease(root, "safety")
  const sourceBytesBefore = await readFile(path.join(sealed.releaseRoot, "index.html"))
  await expectCode(prepareGhPagesCandidate({ verifiedSealedRelease: {}, targetRoot: path.join(root, "forged") }), "VERIFIED_SEALED_RELEASE_CAPABILITY_REQUIRED")
  assert.equal((await lstat(path.join(root, "forged")).catch(() => null)), null)

  const existing = path.join(root, "existing")
  await mkdir(existing)
  await expectCode(prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot: existing }), "CANDIDATE_TARGET_NOT_FRESH")
  const insideRuntime = path.join(sealed.runtimeRoot, "output")
  await expectCode(prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot: insideRuntime }), "CANDIDATE_TARGET_UNSAFE")
  const insideReleases = path.join(sealed.releasesRoot, "output")
  await expectCode(prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot: insideReleases }), "CANDIDATE_TARGET_UNSAFE")
  const insideVault = path.join(sealed.sourceRoot, "output")
  await expectCode(prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot: insideVault, sourceRoot: sealed.sourceRoot }), "CANDIDATE_TARGET_UNSAFE")

  const manifestPath = path.join(sealed.custodyRoot, "manifest.json")
  const manifestBytes = await readFile(manifestPath)
  await writeFile(manifestPath, Buffer.concat([manifestBytes, Buffer.from(" ")]))
  const staleTarget = path.join(root, "stale")
  await expectCode(prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot: staleTarget }), /VERIFIED|TARGET|CUSTODY/)
  assert.equal((await lstat(staleTarget).catch(() => null)), null)
  await writeFile(manifestPath, manifestBytes)
  await prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot: staleTarget })
  assert.equal((await lstat(staleTarget)).isDirectory(), true)
  assert.deepEqual(await readFile(path.join(sealed.releaseRoot, "index.html")), sourceBytesBefore)
})

test("verify optionally validates launch audit and stages exact site bytes without metadata", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-pages-candidate-stage-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sealed = await installSealedRelease(root, "stage")
  const targetRoot = path.join(root, "output")
  await prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot, expectedUrl, basePath })
  await expectCode(verifyGhPagesCandidate({ candidateRoot: targetRoot, requireLaunchAudit: true }), "LAUNCH_AUDIT_MISSING")
  const audit = await addLaunchAudit(targetRoot)
  const stageOutputRoot = path.join(root, "stage-output")
  const summary = await verifyGhPagesCandidate({ candidateRoot: targetRoot, requireLaunchAudit: true, stageOutputRoot })
  assert.equal(summary.launchAuditDigest, audit.audit_digest)
  assert.equal(summary.staged, true)
  assert.equal((await readdir(stageOutputRoot)).includes(".publication"), false)
  assert.deepEqual(
    (await readCandidateArtifactTree(stageOutputRoot)).map(({ path: relative, sha256: digest }) => ({ path: relative, sha256: digest })),
    summary.site.inventory.map(({ path: relative, sha256: digest }) => ({ path: relative, sha256: digest })),
  )
  await writeFile(path.join(targetRoot, ".publication", "github-launch-audit-v1.json"), `${jcsCanonicalize({ ...audit, audit_digest: "0".repeat(64) })}\n`)
  await expectCode(verifyGhPagesCandidate({ candidateRoot: targetRoot, requireLaunchAudit: true }), "LAUNCH_AUDIT_INVALID")
})

test("launch audit must bind the same sealed artifact and staging cannot enter Vault ancestry", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-pages-candidate-audit-binding-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sealed = await installSealedRelease(root, "audit-binding")
  const targetRoot = path.join(root, "output")
  await prepareGhPagesCandidate({ verifiedSealedRelease: sealed.capability, targetRoot, expectedUrl, basePath })

  const publication = path.join(targetRoot, ".publication")
  const wrongAudit = makeLaunchAudit("f".repeat(64))
  await writeFile(path.join(publication, "github-launch-audit-v1.json"), `${jcsCanonicalize(wrongAudit)}\n`)
  await expectCode(
    verifyGhPagesCandidate({ candidateRoot: targetRoot, requireLaunchAudit: true }),
    "LAUNCH_AUDIT_BINDING_MISMATCH",
  )

  await addLaunchAudit(targetRoot)
  const unsafeStage = path.join(sealed.sourceRoot, "pages-stage")
  await expectCode(
    verifyGhPagesCandidate({ candidateRoot: targetRoot, requireLaunchAudit: true, stageOutputRoot: unsafeStage }),
    "CANDIDATE_TARGET_UNSAFE",
  )
  assert.equal(await lstat(unsafeStage).catch(() => null), null)
})

test("staging comparison binds both candidate and launch-audit digests", async () => {
  const source = await readFile(path.join(repoRoot, "lib", "gh-pages-candidate.mjs"), "utf8")
  assert.match(source, /rechecked\.metadata\.candidate_digest\s*!==\s*checked\.metadata\.candidate_digest/)
  assert.match(source, /rechecked\.launchAuditDigest\s*!==\s*checked\.launchAuditDigest/)
})

test("site digest is SHA-256 over normalized JCS inventory bytes", () => {
  const inventory = [
    { path: "b.txt", sha256: "b".repeat(64), byteLength: 1 },
    { path: "a.txt", sha256: "a".repeat(64), byteLength: 1 },
  ]
  const normalized = [...inventory].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  assert.equal(sha256Jcs(normalized), sha256(Buffer.from(jcsCanonicalize(normalized), "utf8")))
  assert.notEqual(sha256Jcs(inventory), sha256Jcs(normalized))
})
