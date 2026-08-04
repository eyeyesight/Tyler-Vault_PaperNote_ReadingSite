import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import test from "node:test"

import { Ajv } from "ajv"
import { fromHtml } from "hast-util-from-html"

import {
  createSyntheticProjectSiteServer,
  normalizeBasePath,
} from "../lib/pages-project-site-fixture.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const contractPath = path.join(repoRoot, "config", "github-pages-deployment-contract-v1.json")
const exposureCatalogPath = path.join(repoRoot, "config", "github-provider-public-exposure-catalog-v1.json")
const exposureCatalogSchemaPath = path.join(repoRoot, "config", "github-provider-public-exposure-catalog-v1.schema.json")
const basePath = "/Tyler-Vault_PaperNote_ReadingSite/"

/** @param {Promise<unknown>} promise @param {string} code */
async function expectFixtureError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(/** @type {any} */ (error)?.code, code)
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
      (error) => /** @type {any} */ (error)?.code === "BASE_PATH_INVALID",
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

test("T09 fixture options require one normal plain basePath property and report invalid shapes clearly", async () => {
  await expectFixtureError(createSyntheticProjectSiteServer(undefined), "FIXTURE_OPTIONS_INVALID")
  await expectFixtureError(createSyntheticProjectSiteServer(null), "FIXTURE_OPTIONS_INVALID")
  await expectFixtureError(createSyntheticProjectSiteServer({ basePath, extra: true }), "FIXTURE_OPTIONS_INVALID")
  await expectFixtureError(createSyntheticProjectSiteServer({ basePath: "relative" }), "BASE_PATH_INVALID")
})

test("T09 fixture façade exposes only the explicit local Pages contract", async () => {
  const fixtureModule = await import("../lib/pages-project-site-fixture.mjs")
  assert.deepEqual(Object.keys(fixtureModule).sort(), ["createSyntheticProjectSiteServer", "normalizeBasePath"])
  const facadeModule = await import("../lib/pages-deployment-contract.mjs")
  assert.deepEqual(Object.keys(facadeModule).sort(), ["createSyntheticProjectSiteServer", "normalizeBasePath"])
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

test("T09 machine-readable contract locks current GitHub-native delivery, rights, limits, and the historical exposure catalog", async () => {
  const contract = /** @type {any} */ (JSON.parse(await readFile(contractPath, "utf8")))
  const catalog = /** @type {any} */ (JSON.parse(await readFile(exposureCatalogPath, "utf8")))
  const catalogSchema = /** @type {any} */ (JSON.parse(await readFile(exposureCatalogSchemaPath, "utf8")))
  const ajv = new Ajv({ allErrors: true, strict: true })
  const validateCatalog = ajv.compile(catalogSchema)
  assert.equal(validateCatalog(catalog), true, JSON.stringify(validateCatalog.errors))
  assert.equal(contract.schema_version, 1)
  assert.equal(contract.checked_at, "2026-08-04")
  assert.equal(contract.site.base_path, basePath.slice(0, -1))
  assert.equal(contract.delivery.method, "gh-pages-branch-to-pages-artifact")
  assert.equal(contract.delivery.pages_build_type, "workflow")
  assert.equal(contract.delivery.generated_site_in_git, true)
  assert.equal(contract.delivery.source_ref, "refs/heads/gh-pages")
  assert.equal(contract.delivery.workflow_ref, "refs/heads/main")
  assert.equal(contract.delivery.branch_layout.public_site_root, "site/")
  assert.equal(contract.delivery.branch_layout.candidate_metadata, ".publication/gh-pages-candidate-v1.json")
  assert.deepEqual(Object.keys(contract.delivery.release_identity), ["release_id", "release_digest", "generation", "authority"])
  assert.match(contract.delivery.release_identity.release_digest, /release descriptor/i)
  assert.deepEqual(Object.keys(contract.delivery.byte_identity).sort(), [
    "candidate_digest",
    "candidate_site_inventory_digest",
    "launch_audit_digest",
    "manifest_digest",
    "receipt_digest",
    "rights_authority_binding",
    "source_artifact_inventory_digest",
  ])
  assert.match(contract.delivery.byte_identity.candidate_digest, /canonical.*candidate metadata/i)
  assert.match(contract.delivery.byte_identity.candidate_site_inventory_digest, /canonical normalized.*inventory/i)
  assert.match(contract.delivery.byte_identity.source_artifact_inventory_digest, /canonical normalized.*inventory/i)
  assert.doesNotMatch(JSON.stringify(contract.delivery.byte_identity), /raw aggregate|upload bytes/i)
  assert.equal(Object.hasOwn(contract.delivery.byte_identity, "artifact_digest"), false)
  assert.match(contract.delivery.deploy_input_authority, /Exact 40-hex site_commit/i)
  assert.match(contract.delivery.deploy_input_authority, /GitHub-authenticated workflow_dispatch inputs/i)
  assert.equal(Object.hasOwn(contract, "failure_policy"), false)
  assert.deepEqual(contract.workflow.permissions, {
    root: { contents: "read" },
    validate: { contents: "read", pages: "write" },
    deploy: { contents: "read", pages: "write", "id-token": "write" },
  })
  assert.deepEqual(Object.keys(contract.workflow.workflow_dispatch.inputs), ["site_commit", "candidate_digest", "launch_audit_digest"])
  assert.deepEqual(contract.workflow.main_only_gate, {
    required: true,
    ref: "refs/heads/main",
    default_branch: "main",
    failure: "hard-fail before candidate input use",
  })
  assert.equal(contract.workflow.environment.name, "github-pages")
  assert.equal(contract.workflow.concurrency.cancel_in_progress, false)
  assert.equal(contract.artifact.sealed_artifact_required, true)
  assert.equal(contract.artifact.sealed_artifact_hash_required, true)
  assert.equal(contract.artifact.hash_algorithm, "sha256")
  assert(contract.artifact.required_bindings.includes("sorted site byte inventory"))
  assert(contract.artifact.required_bindings.includes("approved rights-authority projection"))
  assert.equal(contract.rights.authority, "project-owned manifest and publication contract")
  assert.equal(contract.rights.unknown_rights, "block")
  assert.equal(contract.rights.unapproved_unit, "block")
  assert.equal(contract.approvals.visibility.required, true)
  assert.equal(contract.approvals.deployment.required, true)
  assert.equal(contract.approvals.must_be_separate, true)
  assert.equal(contract.post_deploy_qa.required, true)
  assert.equal(contract.post_deploy_qa.runs_after, "provider success")
  assert.equal(contract.public_exposure_catalog.status, "superseded")
  assert.equal(contract.public_exposure_catalog.deploy_authority, false)
  assert.equal(contract.superseded.legacy_opaque_capability.deploy_authority, false)
  assert.equal(contract.superseded.legacy_custom_atomic_claim_one_start.deploy_authority, false)
  assert.equal(contract.migration.status, "wave-c-gh-pages-branch-implementation")
  assert.equal(contract.migration.new_callers_may_use_legacy_implementation, false)
  assert.deepEqual(contract.migration.legacy_implementation, [])
  assert.equal(contract.migration.wave_c.branch_transport, "gh-pages-branch-to-pages-artifact")
  assert.equal(contract.migration.wave_c.generated_site_ref, "refs/heads/gh-pages")
  assert.equal(contract.migration.wave_c.workflow_ref, "refs/heads/main")
  assert.equal(contract.migration.wave_c.deploy_trigger, "workflow_dispatch")
  assert.equal(contract.migration.wave_c.live_state, "not-live")
  assert.deepEqual(contract.migration.remaining_blockers, [
    "remote GitHub settings",
    "actual gh-pages branch contents",
    "live launch audit",
    "visibility and deployment approvals",
    "provider deployment and readback",
    "post-deploy anonymous/browser QA",
  ])

  assert.equal(catalog.required_surfaces.length, 31)
  assert(catalog.required_surfaces.every((/** @type {any} */ surface) => surface.lifecycle === "superseded"))
})
