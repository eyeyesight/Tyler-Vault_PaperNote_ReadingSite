import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { jcsCanonicalize } from "../lib/publication-contracts.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"))
const lock = JSON.parse(await readFile(path.join(repoRoot, "package-lock.json"), "utf8"))
const metadata = JSON.parse(await readFile(path.join(repoRoot, "config", "quartz-toolchain.json"), "utf8"))
const baseline = JSON.parse(await readFile(path.join(repoRoot, "security", "t08-advisory-baseline.json"), "utf8"))
const require = createRequire(import.meta.url)

const quartzCommit = "507ad7f3d4601d83482f61930fccf1c77f42a072"
const quartzTarball = `https://github.com/jackyzha0/quartz/archive/${quartzCommit}.tar.gz`
const compatibilitySpec = "file:vendor/brace-expansion-compat"
const sharpOverride = "0.35.3"

/** @param {import("node:crypto").BinaryLike} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

function discoverNpmCli() {
  const candidate = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((value) => value && existsSync(value))
  if (!candidate) throw new Error("npm CLI must be discoverable without invoking a shell")
  return candidate
}
const npmCli = discoverNpmCli()

/**
 * @param {string[]} args
 * @param {string} [cwd]
 */
function npmOutput(args, cwd = repoRoot) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

/** @param {string} value */
function versionTuple(value) {
  assert.match(value, /^\d+\.\d+\.\d+$/)
  return value.split(".").map(Number)
}

/** @param {string} left @param {string} right */
function compareVersions(left, right) {
  const a = versionTuple(left)
  const b = versionTuple(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

test("T08 advisory baseline preserves the two underlying high findings and their seven propagated audit nodes", () => {
  assert.equal(baseline.schema_version, 1)
  assert.equal(baseline.checked_at, "2026-07-30")
  assert.deepEqual(baseline.before.audit_summary, {
    info: 0, low: 0, moderate: 0, high: 7, critical: 0, total: 7,
  })
  assert.deepEqual(baseline.advisories.map(/** @param {{ id: string }} advisory */ ({ id }) => id), [
    "GHSA-f88m-g3jw-g9cj",
    "GHSA-mh99-v99m-4gvg",
  ])
  for (const advisory of baseline.advisories) {
    assert.equal(advisory.severity, "high")
    assert.equal(advisory.classification, "production")
    assert.equal(advisory.dependency_paths.length > 0, true)
    assert.match(advisory.affected_range, /\d/)
    assert.match(advisory.first_fixed_version, /^\d+\.\d+\.\d+$/)
    assert.equal(typeof advisory.project_invokes_dependency_path, "boolean")
    assert.equal(typeof advisory.untrusted_exploit_input_reachable, "boolean")
    assert.equal(advisory.reachable_path.length > 40, true)
    assert.match(advisory.source_url, /^https:\/\/github\.com\/advisories\/GHSA-/)
    assert.equal(advisory.source_checked_at, baseline.checked_at)
  }
})

test("T08 final lock, audit artifacts, and canonical CycloneDX evidence remain bound", async () => {
  const lockBytes = await readFile(path.join(repoRoot, "package-lock.json"))
  assert.equal(sha256(lockBytes), baseline.after.package_lock_sha256)
  assert.equal(baseline.after.quartz_commit, quartzCommit)
  assert.equal(npmOutput(["--version"]).trim(), baseline.after.audit_evidence.npm)
  for (const summary of [baseline.after.audit_summary, baseline.after.production_audit_summary]) {
    assert.deepEqual(summary, { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 })
  }

  /** @type {Array<[string, string[]]>} */
  const auditCases = [
    ["full", ["audit", "--package-lock-only", "--json"]],
    ["production", ["audit", "--package-lock-only", "--omit=dev", "--json"]],
  ]
  for (const [kind, args] of auditCases) {
    const evidence = baseline.after.audit_evidence[kind]
    const artifactBytes = await readFile(path.join(repoRoot, ...evidence.artifact.split("/")))
    assert.equal(sha256(artifactBytes), evidence.sha256)
    assert.equal(npmOutput(args), artifactBytes.toString("utf8"))
    const report = JSON.parse(artifactBytes.toString("utf8"))
    assert.deepEqual(report.metadata.vulnerabilities, { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 })
    assert.deepEqual(report.metadata.dependencies, evidence.dependencies)
  }

  const checkoutRoots = await Promise.all([
    mkdtemp(path.join(os.tmpdir(), "t08-sbom-checkout-a-")),
    mkdtemp(path.join(os.tmpdir(), "t08-sbom-checkout-b-longer-name-")),
  ])
  assert.notEqual(path.basename(checkoutRoots[0]), path.basename(checkoutRoots[1]))
  const packageBytes = await readFile(path.join(repoRoot, "package.json"))
  const adapterPackageBytes = await readFile(path.join(repoRoot, "vendor", "brace-expansion-compat", "package.json"))
  /** @type {Array<Record<string, any>>} */
  const sboms = []
  try {
    for (const checkout of checkoutRoots) {
      const adapterRoot = path.join(checkout, "vendor", "brace-expansion-compat")
      await mkdir(adapterRoot, { recursive: true })
      await Promise.all([
        writeFile(path.join(checkout, "package.json"), packageBytes),
        writeFile(path.join(checkout, "package-lock.json"), lockBytes),
        writeFile(path.join(adapterRoot, "package.json"), adapterPackageBytes),
      ])
      sboms.push(JSON.parse(npmOutput(["sbom", "--package-lock-only", "--sbom-format=cyclonedx"], checkout)))
    }
  } finally {
    await Promise.all(checkoutRoots.map((checkout) => rm(checkout, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
  }
  assert.equal(sboms.length, baseline.after.sbom.reproducibility_runs)
  for (const sbom of sboms) {
    assert.equal(sbom.bomFormat, baseline.after.sbom.format)
    assert.equal(sbom.specVersion, baseline.after.sbom.spec_version)
    assert.equal(sbom.components.length, baseline.after.sbom.component_count)
    assert.equal(sbom.dependencies.length, baseline.after.sbom.dependency_count)
  }
  /** @param {Record<string, any>} document */
  const canonicalizeSbom = (document) => {
    const normalized = structuredClone(document)
    delete normalized.serialNumber
    delete normalized.metadata.timestamp
    normalized.metadata.component.name = packageJson.name
    return Buffer.from(jcsCanonicalize(normalized))
  }
  const canonicalRuns = sboms.map(canonicalizeSbom)
  assert.deepEqual(canonicalRuns[0], canonicalRuns[1])
  for (const canonical of canonicalRuns) {
    assert.equal(canonical.length, baseline.after.sbom.canonical_bytes)
    assert.equal(sha256(canonical), baseline.after.sbom.canonical_sha256)
  }
})

test("T08 root stack uses only exact reviewed Quartz and transitive source pins", () => {
  assert.equal(packageJson.dependencies["@jackyzha0/quartz"], quartzTarball)
  assert.equal(packageJson.dependencies["brace-expansion"], compatibilitySpec)
  assert.deepEqual(packageJson.overrides, {
    "brace-expansion": "$brace-expansion",
    sharp: sharpOverride,
  })
  assert.equal(lock.packages[""].dependencies["@jackyzha0/quartz"], quartzTarball)
  assert.equal(lock.packages[""].dependencies["brace-expansion"], compatibilitySpec)
  assert.equal(lock.packages["node_modules/@jackyzha0/quartz"].resolved, quartzTarball)
  assert.match(lock.packages["node_modules/@jackyzha0/quartz"].integrity, /^sha512-/)
})

test("T08 records project ownership because Quartz does not natively support the overridden Sharp line", async () => {
  const sharpRange = lock.packages["node_modules/@jackyzha0/quartz"].dependencies.sharp
  assert.equal(sharpRange, "^0.34.5")
  assert.equal(compareVersions(sharpOverride, "0.35.0") >= 0, true)
  assert.equal(sharpOverride.startsWith("0.34."), false, `${sharpOverride} must remain outside ${sharpRange}`)
  assert.equal(packageJson.overrides.sharp, sharpOverride)

  assert.equal(baseline.resolution.bridge.kind, "temporary-project-owned-bridge")
  assert.equal(baseline.resolution.bridge.upstream_support, false)
  assert.equal(baseline.resolution.bridge.accepted_by, "Tyler")
  assert.equal(baseline.resolution.bridge.accepted_at, "2026-07-30")
  assert.match(baseline.resolution.quartz_pin_purpose, /lock completeness/i)
  assert.match(baseline.resolution.sharp_override.ownership, /project/i)
  assert.equal(baseline.resolution.sharp_override.version, sharpOverride)
  assert.equal(baseline.resolution.removal_triggers.length >= 3, true)

  const adr = await readFile(path.join(repoRoot, "docs", "adr", "0003-temporary-pinned-stack-bridge.md"), "utf8")
  assert.match(adr, /Status:\s*Accepted/i)
  assert.match(adr, /Accepted by:\s*Tyler/i)
  assert.match(adr, /not upstream-supported/i)
  assert.match(adr, /507ad7f3d4601d83482f61930fccf1c77f42a072/)
  assert.match(adr, /0\.35\.3/)
  assert.match(adr, /5\.0\.8/)
})

test("T08 lock graph contains patched image and brace primitives only", async () => {
  assert.equal(lock.packages["node_modules/sharp"].version, "0.35.3")
  assert.match(lock.packages["node_modules/sharp"].integrity, /^sha512-/)
  assert.equal(lock.packages["node_modules/serve-handler"].version, "6.1.7")
  assert.equal(lock.packages["node_modules/serve-handler"].resolved, "https://registry.npmjs.org/serve-handler/-/serve-handler-6.1.7.tgz")
  assert.match(lock.packages["node_modules/serve-handler"].integrity, /^sha512-/)
  assert.deepEqual(lock.packages["node_modules/brace-expansion"], {
    resolved: "vendor/brace-expansion-compat",
    link: true,
  })
  assert.equal(lock.packages["vendor/brace-expansion-compat"].version, "5.0.8")
  assert.equal(lock.packages["vendor/brace-expansion-compat"].dependencies["brace-expansion-safe"], "npm:brace-expansion@5.0.8")
  assert.equal(lock.packages["node_modules/brace-expansion-safe"].version, "5.0.8")
  assert.match(lock.packages["node_modules/brace-expansion-safe"].integrity, /^sha512-/)

  const adapter = baseline.resolution.compatibility_adapter
  assert.equal(adapter.package_sha256, sha256(await readFile(path.join(repoRoot, "vendor", "brace-expansion-compat", "package.json"))))
  assert.equal(adapter.entrypoint_sha256, sha256(await readFile(path.join(repoRoot, "vendor", "brace-expansion-compat", "index.cjs"))))

  const sharpNodes = Object.entries(lock.packages).filter(([name]) => /(?:^|\/)node_modules\/sharp$/.test(name))
  const braceNodes = Object.entries(lock.packages).filter(([name]) => /(?:^|\/)node_modules\/(?:brace-expansion|brace-expansion-safe)$/.test(name))
  assert.equal(sharpNodes.length > 0, true)
  assert.equal(braceNodes.length > 0, true)
  for (const [name, candidate] of sharpNodes) {
    assert.equal(compareVersions(candidate.version, "0.35.0") >= 0, true, `${name}@${candidate.version}`)
  }
  for (const [name, candidate] of braceNodes) {
    const resolved = candidate.link ? lock.packages[candidate.resolved] : candidate
    assert.equal(compareVersions(resolved.version, "5.0.8") >= 0, true, `${name}@${resolved.version}`)
  }
})

test("T08 Sharp processes only the pinned favicon path into a 48x48 PNG", async () => {
  const iconPath = path.join(repoRoot, "node_modules", "@jackyzha0", "quartz", "quartz", "static", "icon.png")
  const iconBytes = await readFile(iconPath)
  assert.equal(sha256(iconBytes), metadata.defaultIconSha256)

  const { default: sharp } = await import("sharp")
  assert.equal(sharp.versions.sharp, sharpOverride)
  const sourceMetadata = await sharp(iconBytes).metadata()
  assert.equal(sourceMetadata.format, "png")
  assert.equal(sourceMetadata.width, 200)
  assert.equal(sourceMetadata.height, 200)

  const { data, info } = await sharp(iconBytes).resize(48, 48).png().toBuffer({ resolveWithObject: true })
  assert.equal(data.length > 0, true)
  assert.equal(info.format, "png")
  assert.equal(info.width, 48)
  assert.equal(info.height, 48)
  const outputMetadata = await sharp(data).metadata()
  assert.equal(outputMetadata.format, "png")
  assert.equal(outputMetadata.width, 48)
  assert.equal(outputMetadata.height, 48)
})

test("T08 patched brace adapter supports Quartz minimatch ESM imports", async () => {
  const importedAdapter = /** @type {unknown} */ (await import("brace-expansion"))
  const braceExpansion = /** @type {{ expand: (pattern: string) => string[] }} */ (importedAdapter)
  assert.equal(typeof braceExpansion.expand, "function")
  assert.deepEqual(braceExpansion.expand("{safe,stack}"), ["safe", "stack"])

  const minimatchModule = await import("minimatch")
  assert.equal(minimatchModule.minimatch("notes/paper.md", "**/*.md"), true)
})

test("T08 exact serve-handler replacement satisfies its real minimatch call contract", async (t) => {
  const serveHandler = /** @type {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, options: { public: string, rewrites: Array<{ source: string, destination: string }> }) => Promise<void>} */ (
    require(/** @type {string} */ ("serve-handler"))
  )
  const root = await mkdtemp(path.join(os.tmpdir(), "t08-serve-handler-"))
  await writeFile(path.join(root, "index.html"), "T08 compatibility spike\n")
  t.after(() => rm(root, { recursive: true, force: true }))
  const server = createServer((request, response) => serveHandler(request, response, {
    public: root,
    rewrites: [{ source: "**", destination: "/index.html" }],
  }))
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve(undefined))
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP server address")
  }
  const response = await fetch(`http://127.0.0.1:${address.port}/nested/path`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), "T08 compatibility spike\n")
})

test("T08 toolchain receipt is rebound to the reviewed Quartz commit and complete executable trees", () => {
  assert.equal(metadata.version, "5.0.0")
  assert.equal(metadata.commit, quartzCommit)
  assert.match(metadata.defaultIconSha256, /^[0-9a-f]{64}$/)
  assert.equal(Number.isInteger(metadata.quartzPackageTreeFiles) && metadata.quartzPackageTreeFiles > 0, true)
  assert.match(metadata.quartzPackageTreeSha256, /^[0-9a-f]{64}$/)
  assert.equal(Number.isInteger(metadata.quartzCommunityTreeFiles) && metadata.quartzCommunityTreeFiles > 0, true)
  assert.match(metadata.quartzCommunityTreeSha256, /^[0-9a-f]{64}$/)
})
