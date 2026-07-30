import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import test from "node:test"

import { Ajv } from "ajv"
import { fromHtml } from "hast-util-from-html"

import {
  PagesContractError,
  PagesProviderError,
  createSyntheticProjectSiteServer,
  normalizeBasePath,
  rollbackPagesDeployment,
  runBoundedPagesDeployment,
  safeReadback,
} from "../lib/pages-deployment-contract.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const contractPath = path.join(repoRoot, "config", "github-pages-deployment-contract-v1.json")
const exposureCatalogPath = path.join(repoRoot, "config", "github-provider-public-exposure-catalog-v1.json")
const exposureCatalogSchemaPath = path.join(repoRoot, "config", "github-provider-public-exposure-catalog-v1.schema.json")
const basePath = "/Tyler-Vault_PaperNote_ReadingSite/"
const policy = {
  maxAttempts: 3,
  requestTimeoutMs: 10_000,
  baseBackoffMs: 1_000,
  maxBackoffMs: 5_000,
  maxRetryAfterMs: 60_000,
}

const releaseA = { releaseId: "release-a", releaseDigest: "a".repeat(64), generation: 1 }
const releaseB = { releaseId: "release-b", releaseDigest: "b".repeat(64), generation: 2 }
const releaseC = { releaseId: "release-c", releaseDigest: "c".repeat(64), generation: 2 }

const sealedAuthority = {
  approvedManifestDigest: "1".repeat(64),
  sealedDescriptorId: "sealed-descriptor-1",
  receipt: { receiptId: "receipt-1", receiptDigest: "2".repeat(64) },
  artifact: { artifactDigest: "3".repeat(64), byteLength: 321 },
  inventory: [
    { path: "404.html", sha256: "4".repeat(64), byteLength: 120 },
    { path: "index.html", sha256: "5".repeat(64), byteLength: 201 },
  ],
}

/** Independent test canonicalizer for the lifecycle release descriptor. @param {any} value @returns {string} */
function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
}

/** @param {string} releaseId @param {number} generation @param {any} [authority] @returns {{releaseId:string,releaseDigest:string,generation:number}} */
function lifecycleRelease(releaseId, generation, authority = sealedAuthority) {
  const descriptor = {
    schemaVersion: 1,
    releaseId,
    generation,
    approvedManifestDigest: authority.approvedManifestDigest,
    sealedDescriptorId: authority.sealedDescriptorId,
    receiptId: authority.receipt.receiptId,
    receiptDigest: authority.receipt.receiptDigest,
    artifactDigest: authority.artifact.artifactDigest,
    artifactByteLength: authority.artifact.byteLength,
    inventory: authority.inventory,
  }
  return {
    releaseId,
    releaseDigest: createHash("sha256").update(canonicalJson(descriptor), "utf8").digest("hex"),
    generation,
  }
}

const sealedReleaseA = lifecycleRelease("sealed-release-a", 1)
const sealedReleaseB = lifecycleRelease("sealed-release-b", 2)

/** @param {Promise<unknown>} promise @param {string} code */
async function expectContractError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert(error instanceof PagesContractError)
    assert.equal(error.code, code)
    return true
  })
}

test("T09 base path accepts only the canonical value and its one trailing-slash variant", () => {
  assert.equal(normalizeBasePath(basePath.slice(0, -1)), basePath)
  assert.equal(normalizeBasePath(basePath), basePath)

  const invalid = [
    "", "relative", "//Tyler-Vault_PaperNote_ReadingSite", "/Tyler-Vault_PaperNote_ReadingSite//",
    "/Tyler-Vault_PaperNote_ReadingSite//child", "/Tyler-Vault_PaperNote_ReadingSite/./child",
    "/Tyler-Vault_PaperNote_ReadingSite/../child", "/Tyler-Vault_PaperNote_ReadingSite/%2e/child",
    "/Tyler-Vault_PaperNote_ReadingSite/%2E%2E/child", "/Tyler-Vault_PaperNote_ReadingSite/%2fchild",
    "/Tyler-Vault_PaperNote_ReadingSite/%5Cchild", "/Tyler-Vault_PaperNote_ReadingSite/%00",
    "/Tyler-Vault_PaperNote_ReadingSite/%", "/Tyler-Vault_PaperNote_ReadingSite\\child",
    "/Tyler-Vault_PaperNote_ReadingSite/\0", "/Tyler-Vault_PaperNote_ReadingSite/\u001f",
    "/Tyler-Vault_PaperNote_ReadingSite/cafe\u0301", "/Tyler-Vault_PaperNote_ReadingSite/?query",
    "/Tyler-Vault_PaperNote_ReadingSite/#fragment",
  ]
  for (const candidate of invalid) {
    assert.throws(
      () => normalizeBasePath(candidate),
      (error) => error instanceof PagesContractError && error.code === "BASE_PATH_INVALID",
      JSON.stringify(candidate),
    )
  }
})

test("T09 synthetic project site serves routes, assets, Explorer, search, graph, and custom 404 only below the Pages base path", async (t) => {
  const server = await createSyntheticProjectSiteServer({ basePath })
  t.after(() => server.close())
  assert.equal(server.host, "127.0.0.1")
  assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/)

  const root = await fetch(`${server.origin}${basePath}`)
  assert.equal(root.status, 200)
  const html = await root.text()
  assert.match(html, new RegExp(`${basePath}assets/app\\.css`))
  assert.match(html, /src="\.\/assets\/app\.js"/)

  /** @type {Array<[string, RegExp]>} */
  const routes = [
    ["papers/synthetic-paper/", /Synthetic paper route/],
    ["explorer/", /data-feature="explorer"/],
    ["search/", /data-feature="search"/],
    ["graph/", /data-feature="graph"/],
  ]
  for (const [route, marker] of routes) {
    const response = await fetch(`${server.origin}${basePath}${route}`)
    assert.equal(response.status, 200, route)
    assert.match(await response.text(), marker)
  }

  const [css, script, explorerIndex, searchIndex, graphIndex] = await Promise.all([
    fetch(`${server.origin}${basePath}assets/app.css`),
    fetch(new URL("./assets/app.js", `${server.origin}${basePath}`).href),
    fetch(`${server.origin}${basePath}static/contentIndex.json`),
    fetch(`${server.origin}${basePath}search-index.json`),
    fetch(`${server.origin}${basePath}graph.json`),
  ])
  assert.deepEqual([css.status, script.status, explorerIndex.status, searchIndex.status, graphIndex.status], [200, 200, 200, 200, 200])
  assert.equal((await explorerIndex.json())["synthetic-paper"].slug, "papers/synthetic-paper")
  assert.equal((await searchIndex.json()).documents[0].route, `${basePath}papers/synthetic-paper/`)
  assert.equal((await graphIndex.json()).nodes[0].route, `${basePath}papers/synthetic-paper/`)

  const missing = await fetch(`${server.origin}${basePath}does-not-exist`)
  assert.equal(missing.status, 404)
  assert.match(await missing.text(), new RegExp(`href="${basePath}"`))

  const outside = await fetch(`${server.origin}/assets/app.css`)
  assert.equal(outside.status, 404)
  assert.doesNotMatch(await outside.text(), /color: #20242b/)

  const noSlash = await fetch(`${server.origin}${basePath.slice(0, -1)}`, { redirect: "manual" })
  assert.equal(noSlash.status, 308)
  assert.equal(noSlash.headers.get("location"), basePath)
})

test("T09 browser-visible navigation resolves and fetches every declared fixture URL below the project base path", async (t) => {
  const server = await createSyntheticProjectSiteServer({ basePath })
  t.after(() => server.close())
  const pages = [
    basePath,
    `${basePath}papers/synthetic-paper/`,
    `${basePath}explorer/`,
    `${basePath}search/`,
    `${basePath}graph/`,
    `${basePath}missing-browser-route`,
  ]
  /** @type {Array<{page:string,attribute:string,value:string,resolved:string,status:number,contentType:string}>} */
  const observed = []
  for (const page of pages) {
    const pageResponse = await fetch(`${server.origin}${page}`)
    assert.equal(pageResponse.status, page.endsWith("missing-browser-route") ? 404 : 200, page)
    const html = await pageResponse.text()
    const document = fromHtml(html)
    /** @type {any[]} */
    const nodes = [document]
    while (nodes.length > 0) {
      const node = nodes.pop()
      if (Array.isArray(node?.children)) nodes.push(...node.children)
      if (node?.type !== "element") continue
      for (const [attribute, property] of [["href", "href"], ["src", "src"], ["action", "action"], ["data-index", "dataIndex"]]) {
        const value = node.properties?.[property]
        if (typeof value !== "string") continue
        const target = new URL(value, pageResponse.url)
        assert.equal(target.origin, server.origin, `${page} ${attribute}=${value}`)
        assert(target.pathname.startsWith(basePath), `${page} escaped base path via ${attribute}=${value}`)
        const targetResponse = await fetch(target)
        const bytes = Buffer.from(await targetResponse.arrayBuffer())
        const contentType = targetResponse.headers.get("content-type") ?? ""
        assert.equal(targetResponse.status, 200, `${page} ${attribute}=${value}`)
        assert(bytes.length > 0, `${page} ${attribute}=${value} returned empty content`)
        if (attribute === "data-index") {
          assert.match(contentType, /^application\/json\b/)
          JSON.parse(bytes.toString("utf8"))
        } else if (attribute === "href" || attribute === "action") {
          assert.match(contentType, /^(?:text\/html|text\/css)\b/)
        } else {
          assert.match(contentType, /^text\/javascript\b/)
        }
        observed.push({ page, attribute, value, resolved: target.href, status: targetResponse.status, contentType })
      }
    }
  }
  assert.deepEqual(new Set(observed.map(({ attribute }) => attribute)), new Set(["href", "src", "action", "data-index"]))
  assert.equal(observed.length, 16, JSON.stringify(observed, null, 2))
  assert(observed.some(({ page, attribute, value }) => page.endsWith("missing-browser-route") && attribute === "href" && value === basePath), "custom 404 back link was not crawled")
})

test("T09 fixture interface accepts only one plain own enumerable basePath data property", async () => {
  let accessorCalls = 0
  const accessor = {}
  Object.defineProperty(accessor, "basePath", {
    enumerable: true,
    get() {
      accessorCalls += 1
      return basePath
    },
  })
  const hidden = {}
  Object.defineProperty(hidden, "basePath", { enumerable: false, value: basePath })
  const extraAccessor = { basePath }
  Object.defineProperty(extraAccessor, "root", {
    enumerable: true,
    get() {
      accessorCalls += 1
      return repoRoot
    },
  })
  const extraHidden = { basePath }
  Object.defineProperty(extraHidden, "root", { enumerable: false, value: repoRoot })
  const symbol = { basePath, [Symbol("fixture-hook")]: true }
  const inherited = Object.create({ basePath })
  const exotic = new (class FixtureOptions { constructor() { this.basePath = basePath } })()
  const proxied = new Proxy({ basePath }, {})
  const invalid = [
    undefined,
    null,
    [],
    inherited,
    exotic,
    proxied,
    accessor,
    hidden,
    extraAccessor,
    extraHidden,
    symbol,
    { basePath, root: repoRoot },
    { basePath, testOnlyAfterFixtureFileValidated() {} },
  ]

  for (const options of invalid) {
    await expectContractError(createSyntheticProjectSiteServer(options), "FIXTURE_OPTIONS_INVALID")
  }
  assert.equal(accessorCalls, 0, "fixture option accessors must never execute")

  const fixtureModule = await import("../lib/pages-project-site-fixture.mjs")
  assert.deepEqual(
    Object.keys(fixtureModule).sort(),
    ["createSyntheticProjectSiteServer", "normalizeBasePath"],
    "the fixture module must not export a loader, root, or test hook",
  )
  const facadeModule = await import("../lib/pages-deployment-contract.mjs")
  assert.deepEqual(Object.keys(facadeModule).sort(), [
    "PagesContractError",
    "PagesProviderError",
    "createSyntheticProjectSiteServer",
    "deriveVerifiedSealedReleaseIdentity",
    "loadVerifiedSealedRelease",
    "loadVerifiedSealedReleaseForIdentity",
    "normalizeBasePath",
    "rollbackPagesDeployment",
    "runBoundedPagesDeployment",
    "safeReadback",
    "verifiedSealedReleaseIdentity",
  ])
})

test("T09 startup snapshot stays byte-stable across legal HTTP requests and serves exact HEAD and 404 metadata", async (t) => {
  const server = await createSyntheticProjectSiteServer({ basePath })
  t.after(() => server.close())
  const cssUrl = `${server.origin}${basePath}assets/app.css`
  const cssResponses = await Promise.all([fetch(cssUrl), fetch(cssUrl), fetch(cssUrl)])
  const cssBytes = await Promise.all(cssResponses.map(async (response) => {
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /^text\/css; charset=utf-8$/)
    return Buffer.from(await response.arrayBuffer())
  }))
  assert.deepEqual(cssBytes[1], cssBytes[0])
  assert.deepEqual(cssBytes[2], cssBytes[0])

  const cssHead = await fetch(cssUrl, { method: "HEAD" })
  assert.equal(cssHead.status, 200)
  assert.equal(cssHead.headers.get("content-type"), "text/css; charset=utf-8")
  assert.equal(Number(cssHead.headers.get("content-length")), cssBytes[0].length)
  assert.equal((await cssHead.arrayBuffer()).byteLength, 0)

  const missingUrl = `${server.origin}${basePath}missing-snapshot-route`
  const missingGet = await fetch(missingUrl)
  const missingBytes = Buffer.from(await missingGet.arrayBuffer())
  assert.equal(missingGet.status, 404)
  assert.equal(missingGet.headers.get("content-type"), "text/html; charset=utf-8")
  assert(missingBytes.length > 0)
  const missingHead = await fetch(missingUrl, { method: "HEAD" })
  assert.equal(missingHead.status, 404)
  assert.equal(missingHead.headers.get("content-type"), "text/html; charset=utf-8")
  assert.equal(Number(missingHead.headers.get("content-length")), missingBytes.length)
  assert.equal((await missingHead.arrayBuffer()).byteLength, 0)
})

test("T09 fixture close is bounded and idempotent, destroys active connections, and releases its port", async () => {
  const server = await createSyntheticProjectSiteServer({ basePath })
  const socket = net.createConnection({ host: server.host, port: server.port })
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })
  socket.write(`GET ${basePath} HTTP/1.1\r\nHost: ${server.host}\r\n`)
  const socketClosed = new Promise((resolve) => socket.once("close", () => resolve(undefined)))

  const firstClose = server.close()
  const secondClose = server.close()
  assert.equal(secondClose, firstClose)
  await firstClose
  await server.close()
  await socketClosed
  assert.equal(socket.destroyed, true)

  const rebound = net.createServer()
  try {
    await new Promise((resolve, reject) => {
      rebound.once("error", reject)
      rebound.listen(server.port, server.host, () => resolve(undefined))
    })
    const address = rebound.address()
    assert(address && typeof address !== "string")
    assert.equal(address.port, server.port)
  } finally {
    await new Promise((resolve, reject) => rebound.close((error) => error ? reject(error) : resolve(undefined)))
  }
})

test("T09 machine-readable contract locks deployment, rights, limits, and the independent provider exposure catalog", async () => {
  const contract = /** @type {any} */ (JSON.parse(await readFile(contractPath, "utf8")))
  const catalog = /** @type {any} */ (JSON.parse(await readFile(exposureCatalogPath, "utf8")))
  const catalogSchema = /** @type {any} */ (JSON.parse(await readFile(exposureCatalogSchemaPath, "utf8")))
  const ajv = new Ajv({ allErrors: true, strict: true })
  const validateCatalog = ajv.compile(catalogSchema)
  assert.equal(validateCatalog(catalog), true, JSON.stringify(validateCatalog.errors))
  assert.equal(contract.schema_version, 1)
  assert.equal(contract.checked_at, "2026-07-30")
  assert.equal(contract.site.base_path, basePath.slice(0, -1))
  assert.equal(contract.delivery.method, "github-actions-pages-artifact")
  assert.equal(contract.delivery.generated_site_in_git, false)
  assert.deepEqual(Object.keys(contract.delivery.release_identity), ["release_id", "release_digest", "generation"])
  assert.match(contract.delivery.release_identity.release_digest, /lifecycle descriptor/i)
  assert.deepEqual(Object.keys(contract.delivery.byte_identity), ["artifact_digest", "receipt_digest"])
  assert.match(contract.delivery.byte_identity.artifact_digest, /artifact bytes/i)
  assert.match(contract.failure_policy.provider_error_protocol, /strict.*transport.*no adapter-supplied/i)
  assert.equal(contract.failure_policy.operation_start_call_limit, 1)
  assert.equal(contract.failure_policy.caller_policy_overrides_allowed, false)
  assert.deepEqual(
    [contract.failure_policy.request_timeout_ms, contract.failure_policy.reconcile_deadline_ms, contract.failure_policy.poll_interval_ms],
    [10_000, 600_000, 1_000],
  )
  assert.match(contract.failure_policy.start_atomicity, /claim\(operation, options\).*atomic.*provider-visible pending.*only.*acquired.*start/i)
  assert.match(contract.failure_policy.durable_claim, /exact.*acquired.*exists.*unknown.*timeout.*error.*never.*start.*reconcile/i)
  assert.match(contract.failure_policy.claim_crash_recovery, /crash.*after claim.*before start.*permanent pending.*manual adjudication.*never resend/i)
  assert.match(contract.failure_policy.aggregate_deadline, /before claim.*claim.*final revalidation.*start.*reconciliation.*same absolute deadline.*min\(request_timeout_ms, remaining\)/i)
  assert.match(contract.failure_policy.rollback_identity_custody, /canonical.*reversible.*source manifest.*generation.*reload.*digest/i)
  assert.match(contract.failure_policy.sealed_authority, /before any provider read or write.*module-private branded VerifiedSealedRelease.*complete sorted.*inventory.*ordinary objects/i)
  assert.match(contract.failure_policy.last_known_good, /before start.*active lifecycle identity.*canonical sealed custody recovery.*candidate.*active LKG artifact bytes.*mismatch blocks start/i)
  assert.match(contract.failure_policy.rollback, /opaque source capability.*source candidate.*active LKG.*byte-verified.*one-start/i)
  assert.deepEqual(contract.workflow.permissions, { contents: "read", pages: "write", "id-token": "write" })
  assert.equal(contract.workflow.environment.name, "github-pages")
  assert.equal(contract.workflow.concurrency.cancel_in_progress, false)
  assert.equal(contract.artifact.retention_days, 1)
  assert.equal(contract.artifact.supported_max_bytes, 1_000_000_000)
  assert.match(contract.failure_policy.post_start_uncertainty, /every start return.*already-established aggregate absolute deadline.*remaining.*min\(request_timeout_ms, remaining\).*pending\/unknown/i)
  assert.match(contract.failure_policy.readback_schema, /root.*nested-object.*array Proxy.*node:util\/types\.isProxy.*before.*reflection/i)
  assert.match(contract.failure_policy.test_harness_boundary, /Production safeReadback.*canonical policy.*tests\/support.*ForTest.*never.*pages-deployment-contract\.mjs/i)
  assert.match(contract.failure_policy.rollback, /pending resume.*inProgress\.expectedActive.*approval exactly.*before any operation poll.*ROLLBACK_EXPECTED_ACTIVE_MISMATCH/i)
  assert.equal(contract.rights.renderer_theme, "MIT")
  assert.equal(contract.rights.tyler_authored_content, "all-rights-reserved")
  assert.equal(contract.rights.third_party_material, "original-rights-retained-not-relicensed")

  const requiredSurfaces = new Set(catalog.required_surfaces.map((/** @type {any} */ surface) => surface.id))
  assert.equal(requiredSurfaces.size, catalog.required_surfaces.length, "catalog surface IDs must be unique")
  const independentlyReviewedSecondWave = [
    "commit-comments",
    "github-projects-visibility-and-content",
    "dependency-graph-and-external-snapshots",
    "artifact-attestations-and-public-transparency-log",
    "actions-repository-variables",
    "actions-organization-variables-and-repository-access",
    "actions-repository-secrets-and-authorization",
    "actions-organization-secrets-and-repository-access",
  ]
  for (const id of independentlyReviewedSecondWave) assert(requiredSurfaces.has(id), `catalog missing official surface: ${id}`)
  assert.deepEqual(new Set(contract.public_exposure_inventory.map((/** @type {any} */ entry) => entry.id)), requiredSurfaces)
  const validateEntry = ajv.compile({ $ref: `${catalogSchema.$id}#/$defs/contract_entry` })
  for (const /** @type {any} */ entry of contract.public_exposure_inventory) {
    assert.equal(validateEntry(entry), true, `${entry.id}: ${JSON.stringify(validateEntry.errors)}`)
  }
})

test("T09 safeReadback accepts only cloned recursively plain own-enumerable data and checks every state identity", async () => {
  const pendingOperation = {
    operationId: `pages-operation-${"6".repeat(64)}`,
    claimId: `pages-claim-${"6".repeat(64)}`,
    idempotencyKey: `pages-idempotency-${"6".repeat(64)}`,
    status: "pending",
    release: sealedReleaseB,
    expectedActive: sealedReleaseA,
  }
  const sourceState = { active: sealedReleaseA, inProgress: pendingOperation, retained: [] }
  /** @param {any} state @returns {any} */
  const providerFor = (state) => ({
    claim() { return { disposition: "exists" } },
    readback() { return state },
    readOperation() { return null },
    start() {},
  })
  const valid = await safeReadback(providerFor(sourceState))
  assert.deepEqual(valid, sourceState)
  valid.active.releaseId = "mutated-clone"
  assert.equal(sourceState.active.releaseId, sealedReleaseA.releaseId)

  let getterCalls = 0
  const accessorState = { inProgress: null, retained: [] }
  Object.defineProperty(accessorState, "active", { enumerable: true, get() { getterCalls += 1; return sealedReleaseA } })
  const symbolState = /** @type {any} */ ({ active: sealedReleaseA, inProgress: null, retained: [] })
  symbolState[Symbol("hidden")] = true
  const hiddenNested = { ...sealedReleaseA }
  Object.defineProperty(hiddenNested, "hidden", { enumerable: false, value: true })
  const invalidStates = [
    accessorState,
    symbolState,
    { active: hiddenNested, inProgress: null, retained: [] },
    { active: sealedReleaseA, inProgress: null, retained: [], unknown: true },
    { active: sealedReleaseA, inProgress: { ...pendingOperation, release: { ...sealedReleaseB, releaseId: sealedReleaseA.releaseId } }, retained: [] },
    { active: sealedReleaseA, inProgress: { ...pendingOperation, expectedActive: { ...sealedReleaseA, releaseDigest: sealedReleaseB.releaseDigest } }, retained: [] },
    { active: sealedReleaseA, inProgress: null, retained: [{ ...sealedReleaseB, releaseId: sealedReleaseA.releaseId }] },
  ]
  for (const state of invalidStates) {
    await expectContractError(safeReadback(providerFor(state)), "DEPLOYMENT_READBACK_FAILED")
  }
  assert.equal(getterCalls, 0)
  await expectContractError(safeReadback(providerFor(sourceState), 1), "DEPLOYMENT_INTERFACE_INVALID")
})

test("T09 provider state and exact deployment input reject root, nested, and array Proxies without firing a trap", async () => {
  const pendingOperation = {
    operationId: `pages-operation-${"7".repeat(64)}`,
    claimId: `pages-claim-${"7".repeat(64)}`,
    idempotencyKey: `pages-idempotency-${"7".repeat(64)}`,
    status: "pending",
    release: sealedReleaseB,
    expectedActive: sealedReleaseA,
  }
  const trapCounter = { count: 0 }
  /** @param {object} target */
  const trackedProxy = (target) => new Proxy(target, {
    get(targetValue, key, receiver) { trapCounter.count += 1; return Reflect.get(targetValue, key, receiver) },
    getOwnPropertyDescriptor(targetValue, key) { trapCounter.count += 1; return Reflect.getOwnPropertyDescriptor(targetValue, key) },
    getPrototypeOf(targetValue) { trapCounter.count += 1; return Reflect.getPrototypeOf(targetValue) },
    has(targetValue, key) { trapCounter.count += 1; return Reflect.has(targetValue, key) },
    ownKeys(targetValue) { trapCounter.count += 1; return Reflect.ownKeys(targetValue) },
  })
  /** @param {any} state */
  const providerFor = (state) => ({
    claim() { return { disposition: "exists" } },
    readback() { return state },
    readOperation() { return null },
    start() {},
  })
  const invalidStates = [
    trackedProxy({ active: sealedReleaseA, inProgress: null, retained: [] }),
    { active: trackedProxy({ ...sealedReleaseA }), inProgress: null, retained: [] },
    { active: sealedReleaseA, inProgress: null, retained: trackedProxy([]) },
    { active: sealedReleaseA, inProgress: null, retained: [trackedProxy({ ...sealedReleaseB })] },
    { active: sealedReleaseA, inProgress: { ...pendingOperation, release: trackedProxy({ ...sealedReleaseB }) }, retained: [] },
  ]
  for (const state of invalidStates) {
    await expectContractError(safeReadback(providerFor(state)), "DEPLOYMENT_READBACK_FAILED")
  }
  const exactInputProxy = trackedProxy({ provider: providerFor(null), candidate: {} })
  await expectContractError(runBoundedPagesDeployment(exactInputProxy), "DEPLOYMENT_INTERFACE_INVALID")
  assert.equal(trapCounter.count, 0)
})
