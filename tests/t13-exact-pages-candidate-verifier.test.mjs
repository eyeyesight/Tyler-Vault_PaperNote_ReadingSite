import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const repoRoot = path.resolve(import.meta.dirname, "..")
const verifierPath = path.join(repoRoot, "scripts", "verify-exact-pages-candidate.py")

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function git(repo, args, options = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    input: options.input,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  })
}

function write(repo, relative, bytes) {
  const target = path.join(repo, ...relative.split("/"))
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, bytes)
}

function commitAll(repo, message) {
  git(repo, ["add", "-A"])
  git(repo, ["commit", "-m", message])
  return git(repo, ["rev-parse", "HEAD"]).trim()
}

function commitWithRepeatedSiteBlob(repo, parent, relativeSitePaths, bytes, message) {
  const oid = git(repo, ["hash-object", "-w", "--stdin"], {
    encoding: "utf8",
    input: bytes,
  }).trim()
  const existingSiteEntries = git(repo, ["ls-tree", "-z", `${parent}:site`], { encoding: null })
  const extraEntries = relativeSitePaths.map((relativeSitePath) =>
    Buffer.from(`100644 blob ${oid}\t${relativeSitePath}\0`, "utf8"))
  const siteTree = git(repo, ["mktree", "-z"], {
    encoding: "utf8",
    input: Buffer.concat([existingSiteEntries, ...extraEntries]),
  }).trim()
  const rootRecords = git(repo, ["ls-tree", "-z", `${parent}^{tree}`], { encoding: null })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => record.endsWith("\tsite") ? `040000 tree ${siteTree}\tsite` : record)
  const rootTree = git(repo, ["mktree", "-z"], {
    encoding: "utf8",
    input: Buffer.from(`${rootRecords.join("\0")}\0`, "utf8"),
  }).trim()
  return git(repo, ["commit-tree", rootTree, "-p", parent], {
    encoding: "utf8",
    input: Buffer.from(`${message}\n`, "utf8"),
  }).trim()
}

function commitWithExtraSiteBlob(repo, parent, relativeSitePath, bytes, message) {
  return commitWithRepeatedSiteBlob(repo, parent, [relativeSitePath], bytes, message)
}

function treeEntries(repo, commit) {
  const output = git(repo, ["ls-tree", "-r", "-z", "--full-tree", commit], { encoding: null })
  return output.toString("utf8").split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t")
    const [mode, type, oid] = record.slice(0, tab).split(" ")
    return { mode, type, oid, path: record.slice(tab + 1) }
  })
}

function blob(repo, oid) {
  return git(repo, ["cat-file", "blob", oid], { encoding: null })
}

function independentSiteSha(repo, commit) {
  const lines = treeEntries(repo, commit)
    .filter((entry) => entry.path.startsWith("site/"))
    .map((entry) => {
      const bytes = blob(repo, entry.oid)
      return `${entry.path.slice("site/".length)}\0${entry.mode}\0${sha256(bytes)}\0${bytes.length}\n`
    })
    .sort()
    .join("")
  return sha256(Buffer.from(lines, "utf8"))
}

function independentRouteSha(repo, commit) {
  const entry = treeEntries(repo, commit).find((candidate) => candidate.path === ".t13/routes.json")
  assert.ok(entry)
  const routes = JSON.parse(blob(repo, entry.oid).toString("utf8"))
  return sha256(Buffer.from(JSON.stringify(routes), "utf8"))
}

function independentProjectionSha({ operationId, sourceMainSha, workflowSha, siteCommit, siteSha256, routeInventorySha256 }) {
  const projection = {
    schema_version: 1,
    operation_id: operationId,
    state_code: "published",
    source_main_sha: sourceMainSha,
    site_commit: siteCommit,
    site_sha256: siteSha256,
    route_inventory_sha256: routeInventorySha256,
    workflow_sha: workflowSha,
  }
  const canonical = Object.fromEntries(Object.keys(projection).sort().map((key) => [key, projection[key]]))
  return sha256(Buffer.from(JSON.stringify(canonical), "utf8"))
}

function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "t13-exact-pages-verifier-"))
  const repo = path.join(root, "repo")
  mkdirSync(repo, { recursive: true })
  git(repo, ["init", "--initial-branch=main"])
  git(repo, ["config", "user.name", "T13 verifier test"])
  git(repo, ["config", "user.email", "t13-verifier@example.invalid"])

  write(repo, "main.txt", "source\n")
  const sourceMainSha = commitAll(repo, "source")
  write(repo, ".github/workflows/deploy-pages.yml", "workflow\n")
  const workflowSha = commitAll(repo, "workflow")

  git(repo, ["checkout", "-b", "candidate", sourceMainSha])
  rmSync(path.join(repo, "main.txt"))
  write(repo, "site/index.html", "<html><body>ok</body></html>\n")
  write(repo, "site/404.html", "<html><body>missing</body></html>\n")
  write(repo, "site/.nojekyll", Buffer.alloc(0))
  write(repo, "site/assets/app.js", "console.log('ok')\n")
  chmodSync(path.join(repo, "site/assets/app.js"), 0o755)
  const routes = ["/", "/papers/example/", "/café/"]
  write(repo, ".t13/routes.json", Buffer.from(JSON.stringify(routes), "utf8"))
  git(repo, ["add", "-A"])
  git(repo, ["update-index", "--chmod=+x", "--", "site/assets/app.js"])
  git(repo, ["commit", "-m", "candidate"])
  const siteCommit = git(repo, ["rev-parse", "HEAD"]).trim()
  git(repo, ["update-ref", "refs/remotes/origin/gh-pages", siteCommit])

  const siteSha256 = independentSiteSha(repo, siteCommit)
  const routeInventorySha256 = independentRouteSha(repo, siteCommit)
  const publicProjectionSha256 = independentProjectionSha({
    operationId: "0123456789abcdef0123456789abcdef",
    sourceMainSha,
    workflowSha,
    siteCommit,
    siteSha256,
    routeInventorySha256,
  })
  return {
    root,
    repo,
    operationId: "0123456789abcdef0123456789abcdef",
    sourceMainSha,
    workflowSha,
    expectedGhPagesSha: sourceMainSha,
    siteCommit,
    siteSha256,
    routeInventorySha256,
    publicProjectionSha256,
  }
}

function runVerifier(fixture, overrides = {}, spawnOptions = {}) {
  const values = {
    repo: fixture.repo,
    operationId: fixture.operationId,
    sourceMainSha: fixture.sourceMainSha,
    workflowSha: fixture.workflowSha,
    expectedGhPagesSha: fixture.expectedGhPagesSha,
    siteCommit: fixture.siteCommit,
    siteSha256: fixture.siteSha256,
    routeInventorySha256: fixture.routeInventorySha256,
    publicProjectionSha256: fixture.publicProjectionSha256,
    ...overrides,
  }
  const result = spawnSync("python", [
    verifierPath,
    "--repo", values.repo,
    "--operation-id", values.operationId,
    "--source-main-sha", values.sourceMainSha,
    "--workflow-sha", values.workflowSha,
    "--expected-gh-pages-sha", values.expectedGhPagesSha,
    "--site-commit", values.siteCommit,
    "--site-sha256", values.siteSha256,
    "--route-inventory-sha256", values.routeInventorySha256,
    "--public-projection-sha256", values.publicProjectionSha256,
  ], { encoding: "utf8", windowsHide: true, ...spawnOptions })
  return result
}

function assertStableFailure(result, code, fixture) {
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, `${code}\n`)
  assert.equal(result.stderr.includes(fixture.repo), false)
}

test("verifies a real Git Pages candidate and independently recomputed identities", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))

  const result = runVerifier(fixture)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, "")
  assert.equal(result.stdout, `${JSON.stringify({
    schema_version: 1,
    operation_id: fixture.operationId,
    state_code: "published",
    source_main_sha: fixture.sourceMainSha,
    site_commit: fixture.siteCommit,
    site_sha256: fixture.siteSha256,
    route_inventory_sha256: fixture.routeInventorySha256,
    workflow_sha: fixture.workflowSha,
    expected_gh_pages_sha: fixture.expectedGhPagesSha,
    public_projection_sha256: fixture.publicProjectionSha256,
  })}\n`)
  assert.equal(result.stdout.includes(fixture.repo), false)
})

test("rejects a candidate whose single parent is not the expected old gh-pages head", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))

  const result = runVerifier(fixture, { expectedGhPagesSha: fixture.workflowSha })
  assertStableFailure(result, "SITE_PARENT_MISMATCH", fixture)
})

test("rejects a candidate when origin gh-pages does not point at the site commit", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  git(fixture.repo, ["update-ref", "refs/remotes/origin/gh-pages", fixture.sourceMainSha])

  const result = runVerifier(fixture)
  assertStableFailure(result, "REMOTE_GH_PAGES_MISMATCH", fixture)
})

test("rejects a candidate when the independently supplied site digest is wrong", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))

  const result = runVerifier(fixture, { siteSha256: "a".repeat(64) })
  assertStableFailure(result, "SITE_SHA256_MISMATCH", fixture)
})

test("rejects a candidate when the independently supplied public projection digest is wrong", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))

  const result = runVerifier(fixture, { publicProjectionSha256: "b".repeat(64) })
  assertStableFailure(result, "PUBLIC_PROJECTION_SHA256_MISMATCH", fixture)
})

test("rejects a candidate with an extra private root file", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  write(fixture.repo, "private.txt", "private\n")
  const previousSiteCommit = fixture.siteCommit
  const extraRootCommit = commitAll(fixture.repo, "extra private root file")
  git(fixture.repo, ["update-ref", "refs/remotes/origin/gh-pages", extraRootCommit])
  fixture.expectedGhPagesSha = previousSiteCommit
  fixture.siteCommit = extraRootCommit
  fixture.publicProjectionSha256 = independentProjectionSha(fixture)

  const result = runVerifier(fixture)
  assertStableFailure(result, "TREE_PATH_NOT_ALLOWED", fixture)
})

test("rejects a candidate missing the route manifest", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  const previousSiteCommit = fixture.siteCommit
  git(fixture.repo, ["rm", "--", ".t13/routes.json"])
  const missingManifestCommit = commitAll(fixture.repo, "missing route manifest")
  git(fixture.repo, ["update-ref", "refs/remotes/origin/gh-pages", missingManifestCommit])
  fixture.expectedGhPagesSha = previousSiteCommit
  fixture.siteCommit = missingManifestCommit

  const result = runVerifier(fixture)
  assertStableFailure(result, "ROUTE_MANIFEST_MISSING", fixture)
})

test("rejects a route manifest whose bytes are not the exact compact UTF-8 JSON", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  const previousSiteCommit = fixture.siteCommit
  write(fixture.repo, ".t13/routes.json", Buffer.from(`["/", "/papers/example/", "/café/"]\n`, "utf8"))
  const nonCanonicalRouteCommit = commitAll(fixture.repo, "non-canonical route manifest")
  git(fixture.repo, ["update-ref", "refs/remotes/origin/gh-pages", nonCanonicalRouteCommit])
  fixture.expectedGhPagesSha = previousSiteCommit
  fixture.siteCommit = nonCanonicalRouteCommit
  fixture.routeInventorySha256 = independentRouteSha(fixture.repo, nonCanonicalRouteCommit)
  fixture.publicProjectionSha256 = independentProjectionSha(fixture)

  const result = runVerifier(fixture)
  assertStableFailure(result, "ROUTE_MANIFEST_NOT_CANONICAL", fixture)
})

test("rejects duplicate routes in an otherwise canonical manifest", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  const previousSiteCommit = fixture.siteCommit
  write(fixture.repo, ".t13/routes.json", Buffer.from(JSON.stringify(["/", "/"]), "utf8"))
  const duplicateRouteCommit = commitAll(fixture.repo, "duplicate routes")
  git(fixture.repo, ["update-ref", "refs/remotes/origin/gh-pages", duplicateRouteCommit])
  fixture.expectedGhPagesSha = previousSiteCommit
  fixture.siteCommit = duplicateRouteCommit
  fixture.routeInventorySha256 = independentRouteSha(fixture.repo, duplicateRouteCommit)
  fixture.publicProjectionSha256 = independentProjectionSha(fixture)

  const result = runVerifier(fixture)
  assertStableFailure(result, "ROUTE_MANIFEST_INVALID", fixture)
})


test("rejects routes outside the exact public route grammar", (t) => {
  const invalidRouteSets = [
    ["relative"],
    ["/bad\\route"],
    [`/${"x".repeat(512)}`],
    ["/bad\nroute"],
    ["/cafe\u0301/"],
  ]
  const results = []
  for (const routes of invalidRouteSets) {
    const fixture = makeRepo()
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
    const previousSiteCommit = fixture.siteCommit
    write(fixture.repo, ".t13/routes.json", Buffer.from(JSON.stringify(routes), "utf8"))
    const invalidRouteCommit = commitAll(fixture.repo, "invalid route grammar")
    git(fixture.repo, ["update-ref", "refs/remotes/origin/gh-pages", invalidRouteCommit])
    fixture.expectedGhPagesSha = previousSiteCommit
    fixture.siteCommit = invalidRouteCommit
    fixture.routeInventorySha256 = independentRouteSha(fixture.repo, invalidRouteCommit)
    fixture.publicProjectionSha256 = independentProjectionSha(fixture)
    results.push({ fixture, result: runVerifier(fixture) })
  }

  for (const { fixture, result } of results) {
    assertStableFailure(result, "ROUTE_MANIFEST_INVALID", fixture)
  }
})


test("rejects more than ten thousand routes", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  const previousSiteCommit = fixture.siteCommit
  const routes = Array.from({ length: 10_001 }, (_, index) => `/route-${index}/`)
  write(fixture.repo, ".t13/routes.json", Buffer.from(JSON.stringify(routes), "utf8"))
  const excessiveRouteCommit = commitAll(fixture.repo, "too many routes")
  git(fixture.repo, ["update-ref", "refs/remotes/origin/gh-pages", excessiveRouteCommit])
  fixture.expectedGhPagesSha = previousSiteCommit
  fixture.siteCommit = excessiveRouteCommit
  fixture.routeInventorySha256 = independentRouteSha(fixture.repo, excessiveRouteCommit)
  fixture.publicProjectionSha256 = independentProjectionSha(fixture)

  const result = runVerifier(fixture)
  assertStableFailure(result, "ROUTE_MANIFEST_LIMIT_EXCEEDED", fixture)
})


test("rejects a candidate missing a required public site file", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  const previousSiteCommit = fixture.siteCommit
  git(fixture.repo, ["rm", "--", "site/404.html"])
  const missingRequiredCommit = commitAll(fixture.repo, "missing required site file")
  git(fixture.repo, ["update-ref", "refs/remotes/origin/gh-pages", missingRequiredCommit])
  fixture.expectedGhPagesSha = previousSiteCommit
  fixture.siteCommit = missingRequiredCommit
  fixture.siteSha256 = independentSiteSha(fixture.repo, missingRequiredCommit)
  fixture.publicProjectionSha256 = independentProjectionSha(fixture)

  const result = runVerifier(fixture)
  assertStableFailure(result, "SITE_REQUIRED_FILE_MISSING", fixture)
})


test("rejects a non-empty nojekyll marker", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  const previousSiteCommit = fixture.siteCommit
  write(fixture.repo, "site/.nojekyll", "not-empty")
  const invalidMarkerCommit = commitAll(fixture.repo, "non-empty nojekyll")
  git(fixture.repo, ["update-ref", "refs/remotes/origin/gh-pages", invalidMarkerCommit])
  fixture.expectedGhPagesSha = previousSiteCommit
  fixture.siteCommit = invalidMarkerCommit
  fixture.siteSha256 = independentSiteSha(fixture.repo, invalidMarkerCommit)
  fixture.publicProjectionSha256 = independentProjectionSha(fixture)

  const result = runVerifier(fixture)
  assertStableFailure(result, "NOJEKYLL_INVALID", fixture)
})


test("rejects case-folded public path collisions", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  const previousSiteCommit = fixture.siteCommit
  const aliasOid = git(fixture.repo, ["hash-object", "-w", "--stdin"], {
    encoding: "utf8",
    input: Buffer.from("alias\n", "utf8"),
  }).trim()
  git(fixture.repo, ["update-index", "--add", "--cacheinfo", `100644,${aliasOid},site/INDEX.HTML`])
  git(fixture.repo, ["commit", "-m", "case-folded alias"])
  const collisionCommit = git(fixture.repo, ["rev-parse", "HEAD"]).trim()
  git(fixture.repo, ["update-ref", "refs/remotes/origin/gh-pages", collisionCommit])
  fixture.expectedGhPagesSha = previousSiteCommit
  fixture.siteCommit = collisionCommit
  fixture.siteSha256 = independentSiteSha(fixture.repo, collisionCommit)
  fixture.publicProjectionSha256 = independentProjectionSha(fixture)

  const result = runVerifier(fixture)
  assertStableFailure(result, "TREE_PATH_COLLISION", fixture)
})


test("rejects a non-NFC public path", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  const previousSiteCommit = fixture.siteCommit
  const decomposedPath = "site/cafe\u0301.html"
  const oid = git(fixture.repo, ["hash-object", "-w", "--stdin"], {
    encoding: "utf8",
    input: Buffer.from("decomposed\n", "utf8"),
  }).trim()
  git(fixture.repo, ["update-index", "--add", "--cacheinfo", `100644,${oid},${decomposedPath}`])
  git(fixture.repo, ["commit", "-m", "non-nfc path"])
  const nonNfcCommit = git(fixture.repo, ["rev-parse", "HEAD"]).trim()
  git(fixture.repo, ["update-ref", "refs/remotes/origin/gh-pages", nonNfcCommit])
  fixture.expectedGhPagesSha = previousSiteCommit
  fixture.siteCommit = nonNfcCommit
  fixture.siteSha256 = independentSiteSha(fixture.repo, nonNfcCommit)
  fixture.publicProjectionSha256 = independentProjectionSha(fixture)

  const result = runVerifier(fixture)
  assertStableFailure(result, "TREE_PATH_INVALID", fixture)
})


test("rejects a public path containing a control character", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  const previousSiteCommit = fixture.siteCommit
  const unsafeCommit = commitWithExtraSiteBlob(
    fixture.repo,
    fixture.siteCommit,
    "unsafe\nname.html",
    Buffer.from("unsafe\n", "utf8"),
    "control path",
  )
  git(fixture.repo, ["update-ref", "HEAD", unsafeCommit])
  git(fixture.repo, ["update-ref", "refs/remotes/origin/gh-pages", unsafeCommit])
  fixture.expectedGhPagesSha = previousSiteCommit
  fixture.siteCommit = unsafeCommit
  fixture.siteSha256 = independentSiteSha(fixture.repo, unsafeCommit)
  fixture.publicProjectionSha256 = independentProjectionSha(fixture)

  const result = runVerifier(fixture)
  assertStableFailure(result, "TREE_PATH_INVALID", fixture)
})


test("rejects a public path containing a backslash", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  const previousSiteCommit = fixture.siteCommit
  const unsafeCommit = commitWithExtraSiteBlob(
    fixture.repo,
    fixture.siteCommit,
    "unsafe\\name.html",
    Buffer.from("unsafe\n", "utf8"),
    "backslash path",
  )
  git(fixture.repo, ["update-ref", "HEAD", unsafeCommit])
  git(fixture.repo, ["update-ref", "refs/remotes/origin/gh-pages", unsafeCommit])
  fixture.expectedGhPagesSha = previousSiteCommit
  fixture.siteCommit = unsafeCommit
  fixture.siteSha256 = independentSiteSha(fixture.repo, unsafeCommit)
  fixture.publicProjectionSha256 = independentProjectionSha(fixture)

  const result = runVerifier(fixture)
  assertStableFailure(result, "TREE_PATH_INVALID", fixture)
})


test("rejects a public blob larger than ten MiB", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  const previousSiteCommit = fixture.siteCommit
  const oversizedCommit = commitWithExtraSiteBlob(
    fixture.repo,
    fixture.siteCommit,
    "oversized.bin",
    Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
    "oversized blob",
  )
  git(fixture.repo, ["update-ref", "HEAD", oversizedCommit])
  git(fixture.repo, ["update-ref", "refs/remotes/origin/gh-pages", oversizedCommit])
  fixture.expectedGhPagesSha = previousSiteCommit
  fixture.siteCommit = oversizedCommit
  fixture.siteSha256 = independentSiteSha(fixture.repo, oversizedCommit)
  fixture.publicProjectionSha256 = independentProjectionSha(fixture)

  const result = runVerifier(fixture)
  assertStableFailure(result, "TREE_BLOB_LIMIT_EXCEEDED", fixture)
})


test("rejects a public tree larger than one hundred MiB", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  const tenMiB = Buffer.alloc(10 * 1024 * 1024, 0x62)
  let parent = fixture.siteCommit
  for (let index = 0; index < 10; index += 1) {
    parent = commitWithExtraSiteBlob(
      fixture.repo,
      parent,
      `bulk-${index}.bin`,
      tenMiB,
      `bulk blob ${index}`,
    )
  }
  const expectedParent = parent
  const oversizedTreeCommit = commitWithExtraSiteBlob(
    fixture.repo,
    parent,
    "bulk-10.bin",
    tenMiB,
    "bulk blob 10",
  )
  git(fixture.repo, ["update-ref", "HEAD", oversizedTreeCommit])
  git(fixture.repo, ["update-ref", "refs/remotes/origin/gh-pages", oversizedTreeCommit])
  fixture.expectedGhPagesSha = expectedParent
  fixture.siteCommit = oversizedTreeCommit
  fixture.siteSha256 = independentSiteSha(fixture.repo, oversizedTreeCommit)
  fixture.publicProjectionSha256 = independentProjectionSha(fixture)

  const result = runVerifier(fixture)
  assertStableFailure(result, "TREE_TOTAL_LIMIT_EXCEEDED", fixture)
})


test("rejects a public tree with more than ten thousand files", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  const previousSiteCommit = fixture.siteCommit
  const paths = Array.from(
    { length: 10_001 },
    (_, index) => `zz-file-${String(index).padStart(5, "0")}.txt`,
  )
  const oversizedTreeCommit = commitWithRepeatedSiteBlob(
    fixture.repo,
    fixture.siteCommit,
    paths,
    Buffer.from("x", "utf8"),
    "too many files",
  )
  git(fixture.repo, ["update-ref", "HEAD", oversizedTreeCommit])
  git(fixture.repo, ["update-ref", "refs/remotes/origin/gh-pages", oversizedTreeCommit])
  fixture.expectedGhPagesSha = previousSiteCommit
  fixture.siteCommit = oversizedTreeCommit

  const result = runVerifier(fixture, {}, { timeout: 5_000 })
  assertStableFailure(result, "TREE_FILE_LIMIT_EXCEEDED", fixture)
})


test("rejects a candidate with a symlink entry in the committed public tree", (t) => {
  const fixture = makeRepo()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  const previousSiteCommit = fixture.siteCommit
  const symlinkOid = git(fixture.repo, ["hash-object", "-w", "--stdin"], {
    encoding: "utf8",
    input: Buffer.from("../private", "utf8"),
  }).trim()
  git(fixture.repo, ["update-index", "--add", "--cacheinfo", `120000,${symlinkOid},site/linked`])
  git(fixture.repo, ["commit", "-m", "symlink entry"])
  const symlinkCommit = git(fixture.repo, ["rev-parse", "HEAD"]).trim()
  git(fixture.repo, ["update-ref", "refs/remotes/origin/gh-pages", symlinkCommit])
  fixture.expectedGhPagesSha = previousSiteCommit
  fixture.siteCommit = symlinkCommit

  const result = runVerifier(fixture)
  assertStableFailure(result, "TREE_NON_REGULAR", fixture)
})
