// @ts-nocheck -- public CLI mutation matrix intentionally builds dynamic invalid contracts.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import test from "node:test"

import { computePlanDigest, computePublicSetDigest } from "../lib/publication-contracts.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const cli = path.join(repoRoot, "scripts", "tracer.mjs")
const now = "2026-07-28T12:00:00Z"
const disclaimer = "SYNTHETIC FIXTURE — NOT RESEARCH EVIDENCE."
const projectedMasthead = `## Bibliography

Not stated.

## One-sentence Takeaway

Synthetic takeaway.

## Research Question

Synthetic question?

## Citation

Synthetic citation.`
const disclaimerParagraph = /<p>\s*SYNTHETIC FIXTURE — NOT RESEARCH EVIDENCE\.\s*<\/p>/
const zoteroPaperSource = (block) => Buffer.from(`---\ntitle: Synthetic Integrated Paper\ntype: literature-note\nstatus: integrated\n---\n\n# Synthetic Integrated Paper\n\n${disclaimer}\n\n## One-sentence Takeaway\n\nSynthetic integrated takeaway.\n\n## Citation\n\nSynthetic integrated citation.\n\n## Research Question\n\nSynthetic integrated question.\n\n<!-- zotero-annotations:start -->\n## Zotero Annotations\n\n${block}\n\n<!-- zotero-annotations:end -->\n\n## Connections\n\n[[Knowledge/Concepts/synthetic-support|approved support alias]]\n`)
const edgeExecutable = process.env.TYLER_TRACER_BROWSER_EXECUTABLE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const edgeSpawnOptions = Object.freeze({ stdio: "ignore", windowsHide: true })
const pinnedVendorNavigationPlugins = Object.freeze(["explorer", "search", "graph", "backlinks"])

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")

function sealManifest(manifest) {
  manifest.public_set_digest = computePublicSetDigest(manifest.nodes)
  manifest.plan_digest = computePlanDigest(manifest)
  manifest.approval_receipt.approved_plan_digest = manifest.plan_digest
}

async function snapshot(root) {
  const rows = []
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name)
      const metadata = await lstat(absolute)
      if (metadata.isDirectory()) {
        rows.push([path.relative(root, absolute), "d", metadata.mtimeMs])
        await walk(absolute)
      } else rows.push([path.relative(root, absolute), "f", metadata.mtimeMs, digest(await readFile(absolute))])
    }
  }
  await walk(root)
  return rows
}

async function fixture(prefix = "tracer-fixture-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  const paths = Object.fromEntries(["context", "runtime", "export", "vault", "work"].map((name) => [name, path.join(root, name)]))
  await Promise.all(Object.values(paths).map((directory) => mkdir(directory)))
  await writeFile(path.join(paths.vault, "do-not-touch.md"), "canonical sentinel\n")
  const supportPath = "Knowledge/Concepts/synthetic-support.md"
  const paperPath = "Literature/Notes/synthetic-paper.md"
  const supportBytes = Buffer.from(`---\ntitle: Synthetic Support\ntype: concept\naliases: [support-alias]\n---\n\n# Synthetic Support\n\n${disclaimer}\n`)
  const paperBytes = Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\naliases: [paper-alias]\n---\n\n# Synthetic Paper\n\n${disclaimer}\n\n## Bibliography\n\nSynthetic fixture bibliography entry; not a research citation.\n\n## One-sentence Takeaway\n\nSynthetic fixture takeaway; no research claim is made.\n\n## Research Question\n\nSynthetic fixture question: how is this non-research layout rendered?\n\n## Citation\n\nSynthetic fixture citation text; not bibliographic evidence.\n\n## Zotero Annotations\n\nSynthetic source annotation preserved for disclosure testing.\n\n## Body\n\n這是合成且非研究內容，僅供繁體中文排版驗收。\n\nSynthetic table used only for responsive layout acceptance.\n\n| Synthetic column one | Synthetic column two | Synthetic column three | Synthetic column four |\n| --- | --- | --- | --- |\n| fixture-only value | fixture-only value | fixture-only value | fixture-only value |\n\n## Connections\n\nCode example: \`[[Knowledge/Concepts/synthetic-support|approved support alias]]\`\n\n- [[Knowledge/Concepts/synthetic-support|approved support alias]]\n- [[Private/Hidden-Neuron|neutral withheld reference]]\n`)
  for (const [relative, bytes] of [[supportPath, supportBytes], [paperPath, paperBytes]]) {
    const absolute = path.join(paths.export, ...relative.split("/"))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, bytes)
  }
  const manifest = {
    schema_version: 1,
    manifest_id: "VPUB-20260728-tracer-fixture",
    created_at: "2026-07-28T00:00:00Z",
    expires_at: "2026-07-29T00:00:00Z",
    action: {
      kind: "publish-unit", baseline: { kind: "genesis" }, primary_id: "synthetic-paper",
      support_ids: ["synthetic-support"], added_node_ids: ["synthetic-paper", "synthetic-support"],
      direct_connection_edges: [{ source: "synthetic-paper", target: "synthetic-support" }],
    },
    nodes: [
      { public_id: "synthetic-paper", path: paperPath, node_class: "paper", source_sha256: digest(paperBytes) },
      { public_id: "synthetic-support", path: supportPath, node_class: "concept", source_sha256: digest(supportBytes) },
    ],
    public_set_digest: "0".repeat(64),
    approval_receipt: { approver: "tyler", channel: "telegram", source_event_id: "synthetic-test-event", approved_plan_digest: "0".repeat(64), approved_at: "2026-07-28T00:01:00Z" },
    plan_digest: "0".repeat(64),
  }
  sealManifest(manifest)
  const receipt = {
    schema_version: 1, manifest_id: manifest.manifest_id, plan_digest: manifest.plan_digest,
    exported_at: "2026-07-28T00:02:00Z", drive_readback: "verified",
    files: manifest.nodes.map(({ path: filePath, source_sha256 }) => ({ path: filePath, source_sha256 })).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))),
  }
  const manifestPath = path.join(paths.context, "manifest.json")
  const receiptPath = path.join(paths.export, "export-receipt.json")
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(receiptPath, JSON.stringify(receipt))
  return { root, paths, manifest, receipt, manifestPath, receiptPath, output: path.join(root, "output") }
}

function invoke(fx, command, extra = {}, env = {}) {
  const values = {
    manifest: fx.manifestPath, exportReceipt: fx.receiptPath, runtimeRoot: fx.paths.runtime,
    exportRoot: fx.paths.export, vaultRoot: fx.paths.vault, workRoot: fx.paths.work,
    output: fx.output, now, ...extra,
  }
  const names = { manifest: "--manifest", exportReceipt: "--export-receipt", runtimeRoot: "--runtime-root", exportRoot: "--export-root", vaultRoot: "--vault-root", workRoot: "--work-root", output: "--output", now: "--now" }
  const args = [cli, command]
  for (const [key, flag] of Object.entries(names)) args.push(flag, values[key])
  const effectiveEnv = { ...env }
  if (!Object.hasOwn(effectiveEnv, "TYLER_TRACER_TEST_CAPABILITY") && Object.keys(effectiveEnv).some((name) => name.startsWith("TYLER_TRACER_TEST_"))) {
    effectiveEnv.TYLER_TRACER_TEST_CAPABILITY = "t03-regression-v1"
  }
  return spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...effectiveEnv }, timeout: 180_000 })
}

function oneJson(result) {
  assert.equal(result.stderr, "")
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1)
  return JSON.parse(result.stdout)
}

function headingSection(html, id) {
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*\bid=["']([^"']+)["'][^>]*>/gi)]
  const currentIndex = headings.findIndex((heading) => heading[2] === id)
  assert.notEqual(currentIndex, -1, `missing #${id} heading`)
  const current = headings[currentIndex]
  const level = Number(current[1])
  const next = headings.slice(currentIndex + 1).find((heading) => Number(heading[1]) <= level)
  return html.slice(current.index, next?.index ?? html.length)
}

function containsText(value, needle) {
  if (typeof value === "string") return value.includes(needle)
  if (Array.isArray(value)) return value.some((item) => containsText(item, needle))
  return Boolean(value && typeof value === "object" && Object.values(value).some((item) => containsText(item, needle)))
}

async function rewriteContracts(fx) {
  sealManifest(fx.manifest)
  fx.receipt.manifest_id = fx.manifest.manifest_id
  fx.receipt.plan_digest = fx.manifest.plan_digest
  fx.receipt.files = fx.manifest.nodes.map(({ path: filePath, source_sha256 }) => ({ path: filePath, source_sha256 })).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
  await writeFile(fx.manifestPath, JSON.stringify(fx.manifest))
  await writeFile(fx.receiptPath, JSON.stringify(fx.receipt))
}

async function replaceSource(fx, nodeId, bytes) {
  const node = fx.manifest.nodes.find((item) => item.public_id === nodeId)
  await writeFile(path.join(fx.paths.export, ...node.path.split("/")), bytes)
  node.source_sha256 = digest(bytes)
  await rewriteContracts(fx)
}

async function outputTree(root) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else files.push([path.relative(root, absolute).split(path.sep).join("/"), await readFile(absolute)])
    }
  }
  await walk(root)
  return files.sort((a, b) => a[0].localeCompare(b[0]))
}

function semanticHeadings(html) {
  return [...html.matchAll(/<h([1-6])\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/gi)].map((match) => ({
    level: Number(match[1]), id: match[2], text: match[3].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim(),
  }))
}

function routeHrefs(html, route) {
  return [...html.matchAll(/\bhref="([^"]*)"/g)]
    .map((match) => match[1])
    .filter((href) => href && !/\.(?:css|js|png|svg|ico)(?:$|[?#])/i.test(href))
    .map((href) => {
      const url = new URL(href, `http://example.invalid${route}`)
      return `${url.pathname}${url.hash}`
    })
    .sort()
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.events = new Map()
    this.listeners = new Map()
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true })
      this.socket.addEventListener("error", reject, { once: true })
    })
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params)
        const waiters = this.events.get(message.method) ?? []
        this.events.delete(message.method)
        for (const resolve of waiters) resolve(message.params)
      }
    })
  }
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  once(method) {
    return new Promise((resolve) => this.events.set(method, [...(this.events.get(method) ?? []), resolve]))
  }
  on(method, listener) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener])
    return () => this.listeners.set(method, (this.listeners.get(method) ?? []).filter((candidate) => candidate !== listener))
  }
  close() { this.socket.close() }
}

async function waitFor(read, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await read()
      if (value) return value
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("timed out waiting for browser state")
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === "ESRCH") return false
    throw error
  }
}

async function edgeSession(output) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname)
      const relative = pathname.replace(/^\/+/, "")
      let target = path.resolve(output, relative)
      if (!target.startsWith(path.resolve(output))) throw new Error("path escaped output")
      if (pathname.endsWith("/")) target = path.join(target, "index.html")
      const bytes = await readFile(target)
      response.writeHead(200, { "content-type": target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".css") ? "text/css" : "application/javascript" })
      response.end(bytes)
    } catch {
      response.writeHead(404)
      response.end("not found")
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = server.address().port
  const profile = await mkdtemp(path.join(os.tmpdir(), "tracer-edge-"))
  const edgeArgs = [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    `http://127.0.0.1:${port}/papers/synthetic-paper/`,
  ]
  const edge = spawn(edgeExecutable, edgeArgs, edgeSpawnOptions)
  if (!Number.isInteger(edge.pid)) throw new Error("Edge did not expose its spawned PID")
  const edgePid = edge.pid
  const stopEdge = async () => {
    const waitUntilGone = async (timeout) => {
      try {
        await waitFor(() => !processExists(edgePid), timeout)
      } catch {}
      return !processExists(edgePid)
    }
    if (processExists(edgePid)) edge.kill()
    if (!(await waitUntilGone(2_000))) {
      edge.kill("SIGKILL")
      await waitUntilGone(2_000)
    }
    if (processExists(edgePid)) throw new Error(`spawned Edge PID ${edgePid} did not exit`)
    await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    const profileRemoved = await lstat(profile).then(() => false, (error) => error?.code === "ENOENT")
    return { pid: edgePid, exited: !processExists(edgePid), profileRemoved }
  }
  let client
  let closePromise
  try {
    const active = await waitFor(async () => {
      const lines = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/)
      return lines[0] ? lines : null
    })
    const targets = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${active[0]}/json/list`)
      const list = await response.json()
      return list.find((item) => item.type === "page" && item.webSocketDebuggerUrl)
    })
    client = new CdpClient(targets.webSocketDebuggerUrl)
    await client.open()
    await Promise.all([client.send("Page.enable"), client.send("Runtime.enable"), client.send("Log.enable")])
    return {
      client,
      baseUrl: `http://127.0.0.1:${port}`,
      edgePid,
      edgeArgs,
      close() {
        closePromise ??= (async () => {
          await client?.send("Browser.close").catch(() => {})
          client?.close()
          await new Promise((resolve) => server.close(resolve))
          return stopEdge()
        })()
        return closePromise
      },
    }
  } catch (error) {
    client?.close()
    await new Promise((resolve) => server.close(resolve))
    await stopEdge()
    throw error
  }
}

async function cdpNavigate(session, route, width, height) {
  await session.client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width <= 800 })
  const loaded = session.client.once("Page.loadEventFired")
  await session.client.send("Page.navigate", { url: `${session.baseUrl}${route}` })
  await loaded
  await session.client.send("Runtime.evaluate", { expression: "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", awaitPromise: true })
}

async function cdpValue(session, expression) {
  const result = await session.client.send("Runtime.evaluate", { expression: `(${expression})()`, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result.value
}

async function cdpNativeKey(session, key) {
  const descriptor = key === "Tab"
    ? { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }
    : key === "Enter"
      ? { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
      : key === "Escape"
        ? { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
        : null
  if (!descriptor) throw new Error(`unsupported native test key: ${key}`)
  await session.client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...descriptor })
  if (key === "Enter") await session.client.send("Input.dispatchKeyEvent", { type: "char", ...descriptor, text: "\r", unmodifiedText: "\r" })
  await session.client.send("Input.dispatchKeyEvent", { type: "keyUp", ...descriptor })
  await session.client.send("Runtime.evaluate", { expression: "new Promise(resolve => requestAnimationFrame(resolve))", awaitPromise: true })
}

async function capturePage(session, filename) {
  const directory = process.env.TYLER_TRACER_CAPTURE_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  const screenshot = await session.client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })
  await writeFile(path.join(directory, filename), Buffer.from(screenshot.data, "base64"))
}

test("T03 public preflight is read-only and build produces the exact gated Quartz routes", async (t) => {
  const fx = await fixture()
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const before = await snapshot(fx.root)
  const preflight = invoke(fx, "preflight")
  assert.equal(preflight.status, 0, preflight.stdout)
  assert.deepEqual(oneJson(preflight), { ok: true, command: "preflight", manifestId: fx.manifest.manifest_id, nodes: 2, suppressionCount: 1, quartz: "5.0.0" })
  assert.deepEqual(await snapshot(fx.root), before)

  const protectedBefore = Object.fromEntries(await Promise.all(
    ["context", "runtime", "export", "vault", "work"].map(async (name) => [name, await snapshot(fx.paths[name])]),
  ))
  const build = invoke(fx, "build")
  assert.equal(build.status, 0, `${build.stdout}\n${build.error ?? ""}`)
  const result = oneJson(build)
  assert.deepEqual(result.routes, ["/", "/knowledge/concept/synthetic-support/", "/papers/synthetic-paper/"])
  const outputFiles = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else outputFiles.push([path.relative(fx.output, absolute).split(path.sep).join("/"), await readFile(absolute)])
    }
  }
  await walk(fx.output)
  const htmlFiles = outputFiles.filter(([relative]) => relative.endsWith(".html")).map(([relative]) => relative)
  assert.deepEqual(htmlFiles.sort(), ["index.html", "knowledge/concept/synthetic-support/index.html", "papers/synthetic-paper/index.html"])
  const paper = await readFile(path.join(fx.output, "papers", "synthetic-paper", "index.html"), "utf8")
  const support = await readFile(path.join(fx.output, "knowledge", "concept", "synthetic-support", "index.html"), "utf8")
  const home = await readFile(path.join(fx.output, "index.html"), "utf8")
  assert.match(home, /Tyler-Vault Reading Site/)
  assert.doesNotMatch(home, /SYNTHETIC \/ NON-RESEARCH/)
  const resolvedHrefs = (html, route) => [...html.matchAll(/\bhref="([^"]+)"/g)].map((match) => new URL(match[1], `https://example.invalid${route}`).pathname)
  assert.ok(resolvedHrefs(home, "/").includes("/papers/synthetic-paper/"))
  assert.ok(resolvedHrefs(home, "/").includes("/knowledge/concept/synthetic-support/"))
  const paperBacklinks = headingSection(paper, "backlinks")
  const supportBacklinks = headingSection(support, "backlinks")
  assert.equal(resolvedHrefs(paperBacklinks, "/papers/synthetic-paper/").includes("/knowledge/concept/synthetic-support/"), false)
  assert.ok(resolvedHrefs(supportBacklinks, "/knowledge/concept/synthetic-support/").includes("/papers/synthetic-paper/"))
  assert.ok(resolvedHrefs(paper, "/papers/synthetic-paper/").includes("/knowledge/concept/synthetic-support/"))
  assert.equal(resolvedHrefs(support, "/knowledge/concept/synthetic-support/").filter((href) => href === "/papers/synthetic-paper/").length, 1)
  assert.match(paper, disclaimerParagraph)
  assert.match(support, disclaimerParagraph)
  assert.match(paper, /<code>\[\[Knowledge\/Concepts\/synthetic-support\|approved support alias\]\]<\/code>/)
  assert.equal(resolvedHrefs(paper, "/papers/synthetic-paper/").filter((href) => href === "/knowledge/concept/synthetic-support/").length, 1)
  assert.match(paper, />neutral withheld reference</)
  const privateTargetVariants = ["Private/Hidden-Neuron", "private/hidden-neuron", "Hidden-Neuron", "hidden-neuron", "Private/Hidden-Neuron.md", "private/hidden-neuron.md"]
  for (const text of [home, paper, support]) {
    for (const privateTarget of privateTargetVariants) assert.equal(text.includes(privateTarget), false)
    assert.equal(text.includes("neutral withheld reference"), text === paper)
  }
  const privateBytes = [fx.root, fx.paths.context, fx.paths.runtime, fx.paths.export, fx.paths.vault, fx.paths.work, fx.manifestPath, fx.receiptPath]
    .flatMap((value) => [value, value.replace(/\\/g, "/")])
  for (const [relative, bytes] of outputFiles) {
    assert.doesNotMatch(relative, /\.(?:md|pdf)$/i)
    const text = bytes.toString("utf8")
    assert.doesNotMatch(text, /export-receipt|publication-manifest|release-receipt|current-release/i)
    for (const privateTarget of privateTargetVariants) assert.equal(text.includes(privateTarget), false)
    assert.equal(privateBytes.some((value) => text.includes(value)), false)
  }
  const protectedAfter = Object.fromEntries(await Promise.all(
    ["context", "runtime", "export", "vault", "work"].map(async (name) => [name, await snapshot(fx.paths[name])]),
  ))
  assert.deepEqual(protectedAfter, protectedBefore)
})

test("T03 MDAST semantics accept nested-list continuation links after unmatched visible backticks", async (t) => {
  const fx = await fixture("tracer-mdast-positive-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  await replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n# Synthetic Paper\n\n${disclaimer}\n\n## Bibliography\n\nNot stated\n\n## One-sentence Takeaway\n\nNot stated\n\n## Research Question\n\nNot stated\n\n## Citation\n\nNot stated\n\nAn unmatched \` remains ordinary visible CommonMark text.\n\n## Connections\n\n- Nested list item\n    continuation [[Knowledge/Concepts/synthetic-support|approved support alias]]\n`))
  const before = await snapshot(fx.root)
  const result = invoke(fx, "preflight")
  assert.equal(result.status, 0, result.stdout)
  assert.deepEqual(oneJson(result), { ok: true, command: "preflight", manifestId: fx.manifest.manifest_id, nodes: 2, suppressionCount: 0, quartz: "5.0.0" })
  assert.deepEqual(await snapshot(fx.root), before)
  await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
  assert.equal((await readdir(fx.paths.work)).length, 0)
})

test("T03 production preflight accepts scholarly sources without a synthetic-fixture disclaimer", async (t) => {
  const fx = await fixture("tracer-real-source-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  await replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Scholarly Support\ntype: concept\n---\n\n# Scholarly Support\n\nA concise public concept page.\n`))
  await replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Scholarly Paper\ntype: literature-note\nstatus: integrated\n---\n\n# Scholarly Paper\n\n${projectedMasthead}\n\n## Connections\n\n- [[Knowledge/Concepts/synthetic-support|Scholarly Support]]\n`))
  const before = await snapshot(fx.root)
  const result = invoke(fx, "preflight")
  assert.equal(result.status, 0, result.stdout)
  assert.deepEqual(oneJson(result), { ok: true, command: "preflight", manifestId: fx.manifest.manifest_id, nodes: 2, suppressionCount: 0, quartz: "5.0.0" })
  assert.deepEqual(await snapshot(fx.root), before)
})

test("T03 CLI flags fail closed with one JSON object and empty stderr", async (t) => {
  const fx = await fixture("tracer-cli-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  for (const args of [
    [cli, "unknown"],
    [cli, "preflight", "--unknown", "x"],
    [cli, "preflight", "--manifest", fx.manifestPath, "--manifest", fx.manifestPath],
  ]) {
    const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8" })
    assert.equal(result.status, 1)
    const failure = oneJson(result)
    assert.equal(failure.ok, false)
    assert.equal(containsText(failure, fx.root), false)
  }

  const disclosure = invoke(fx, "preflight", {}, { TYLER_TRACER_TEST_DISCLOSURE_ERROR: fx.root })
  assert.equal(disclosure.status, 1)
  const redacted = oneJson(disclosure)
  assert.equal(redacted.error.code, "TEST_DISCLOSURE")
  assert.equal(containsText(redacted, fx.root), false)
})

test("T03 preflight negative matrix leaves output absent and source/Vault unchanged", async (t) => {
  const cases = [
    ["unlisted export", null, async (fx) => writeFile(path.join(fx.paths.export, "extra.txt"), "no")],
    ["hash mismatch", null, async (fx) => { fx.manifest.nodes[0].source_sha256 = "0".repeat(64); await rewriteContracts(fx); fx.receipt.files[0].source_sha256 = "0".repeat(64); await writeFile(fx.receiptPath, JSON.stringify(fx.receipt)) }],
    ["paper frontmatter", "PAPER_FRONTMATTER_INVALID", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Bad\ntype: paper\nstatus: integrated\n---\n\n${disclaimer}\n\n${projectedMasthead}\n\n## Connections\n\n[[Knowledge/Concepts/synthetic-support]]\n`))],
    ["active Markdown", "SOURCE_ACTIVE_CONTENT_NOT_ALLOWED", async (fx) => replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Bad\ntype: concept\n---\n\n${disclaimer}\n<script>alert(1)</script>\n`))],
    ["raw svg event handler", "SOURCE_ACTIVE_CONTENT_NOT_ALLOWED", async (fx) => replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Bad\ntype: concept\n---\n\n${disclaimer}\n<svg onload=alert(1)>\n`))],
    ["raw details event handler", "SOURCE_ACTIVE_CONTENT_NOT_ALLOWED", async (fx) => replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Bad\ntype: concept\n---\n\n${disclaimer}\n<details ontoggle=alert(1)>unsafe</details>\n`))],
    ["unsafe scheme", "SOURCE_UNSAFE_URL_SCHEME", async (fx) => replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Bad\ntype: concept\n---\n\n${disclaimer}\n[x](javascript:alert(1))\n`))],
    ["missing direct connection", "DIRECT_CONNECTION_MISSING", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n${projectedMasthead}\n\n## Connections\n\nNo approved path link.\n`))],
    ["direct connection only in inline code", "DIRECT_CONNECTION_MISSING", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n${projectedMasthead}\n\n## Connections\n\n\`[[Knowledge/Concepts/synthetic-support]]\`\n`))],
    ["direct connection only in fenced code", "DIRECT_CONNECTION_MISSING", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n${projectedMasthead}\n\n## Connections\n\n~~~md\n[[Knowledge/Concepts/synthetic-support]]\n~~~\n`))],
    ["direct connection only in multiline reference definition title", "DIRECT_CONNECTION_MISSING", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n${projectedMasthead}\n\n## Connections\n\n[support]: https://example.invalid\n  "[[Knowledge/Concepts/synthetic-support]]"\n`))],
    ["direct connection only in multiline Markdown link title", "DIRECT_CONNECTION_MISSING", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n${projectedMasthead}\n\n## Connections\n\n[neutral](https://example.invalid\n  "[[Knowledge/Concepts/synthetic-support]]")\n`))],
    ["Connections heading contains inline code", "DIRECT_CONNECTION_MISSING", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n${projectedMasthead}\n\n## \`Connections\`\n\n[[Knowledge/Concepts/synthetic-support]]\n`))],
    ["escaped direct connection opener", "DIRECT_CONNECTION_MISSING", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n${projectedMasthead}\n\n## Connections\n\n\\[[Knowledge/Concepts/synthetic-support]]\n`))],
    ["ambiguous alias", "AMBIGUOUS_ALIAS", async (fx) => replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Synthetic Paper\ntype: concept\n---\n\n${disclaimer}\n`))],
    ["unlisted target without pipe display", "UNLISTED_DISPLAY_REQUIRED", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n${projectedMasthead}\n\n## Connections\n\n- [[Knowledge/Concepts/synthetic-support|approved support alias]]\n- [[Private/Hidden-Neuron]]\n`))],
    ["unlisted target in inline code without safe display", "UNLISTED_DISPLAY_REQUIRED", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n\`[[Private/Hidden-Neuron]]\`\n\n## Connections\n\n- [[Knowledge/Concepts/synthetic-support|approved support alias]]\n`))],
    ["escaped unlisted target without safe display", "UNLISTED_DISPLAY_REQUIRED", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n\\[[Private/Hidden-Neuron]]\n\n## Connections\n\n- [[Knowledge/Concepts/synthetic-support|approved support alias]]\n`))],
    ["nested private opener in code context", "SOURCE_NESTED_WIKILINK_NOT_ALLOWED", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n\`[[Knowledge/Concepts/synthetic-support|ok [[Private/Hidden|neutral]]]]\`\n\n## Connections\n\n- [[Knowledge/Concepts/synthetic-support|approved support alias]]\n`))],
    ["nested private opener in visible text", "SOURCE_NESTED_WIKILINK_NOT_ALLOWED", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n${projectedMasthead}\n\n## Connections\n\n- [[Knowledge/Concepts/synthetic-support|ok [[Private/Hidden|neutral]]]]\n`))],
    ["unlisted target exposed as display", "UNLISTED_DISPLAY_REQUIRED", async (fx) => replaceSource(fx, "synthetic-paper", Buffer.from(`---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n${disclaimer}\n\n${projectedMasthead}\n\n## Connections\n\n- [[Knowledge/Concepts/synthetic-support|approved support alias]]\n- [[Private/Hidden-Neuron|hidden-neuron]]\n`))],
  ]
  for (const [name, expectedCode, mutate] of cases) await t.test(name, async (t) => {
    const fx = await fixture("tracer-negative-")
    t.after(() => rm(fx.root, { recursive: true, force: true }))
    await mutate(fx)
    const before = await snapshot(fx.root)
    const result = invoke(fx, "preflight")
    assert.equal(result.status, 1, name)
    const failure = oneJson(result)
    assert.equal(failure.ok, false)
    if (expectedCode) assert.equal(failure.error.code, expectedCode)
    await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
    assert.deepEqual(await snapshot(fx.root), before)
    assert.equal((await readdir(fx.paths.work)).length, 0)
  })
})

test("T03 source permits ordinary less-than text but rejects every raw HTML tag family with zero writes", async (t) => {
  const accepted = await fixture("tracer-less-than-")
  t.after(() => rm(accepted.root, { recursive: true, force: true }))
  await replaceSource(accepted, "synthetic-support", Buffer.from(`---\ntitle: Safe comparison\ntype: concept\n---\n\n${disclaimer}\n\nA score < 3 is ordinary text.\n`))
  const acceptedBefore = await snapshot(accepted.root)
  const acceptedResult = invoke(accepted, "preflight")
  assert.equal(acceptedResult.status, 0, acceptedResult.stdout)
  assert.deepEqual(await snapshot(accepted.root), acceptedBefore)

  for (const [name, rawHtml] of [
    ["comment", "<!-- hidden -->"],
    ["object", "<object data=x>fallback</object>"],
    ["form", "<form action=x>unsafe</form>"],
    ["meta", "<meta http-equiv=refresh content=x>"],
    ["style", "<style>body{display:none}</style>"],
    ["slash-separated tag payload", "<svg/onload=alert(1)>"],
    ["namespaced tag", "<svg:foreignObject>unsafe</svg:foreignObject>"],
  ]) await t.test(name, async (t) => {
    const fx = await fixture("tracer-raw-html-")
    t.after(() => rm(fx.root, { recursive: true, force: true }))
    await replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Raw HTML\ntype: concept\n---\n\n${disclaimer}\n\n${rawHtml}\n`))
    const before = await snapshot(fx.root)
    const result = invoke(fx, "preflight")
    assert.equal(result.status, 1)
    assert.equal(oneJson(result).error.code, "SOURCE_ACTIVE_CONTENT_NOT_ALLOWED")
    assert.deepEqual(await snapshot(fx.root), before)
    await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
    assert.equal((await readdir(fx.paths.work)).length, 0)
  })
})

test("T03 source gate rejects lowercase mixed-separator Windows paths before build and cleans work", async (t) => {
  const fx = await fixture("tracer-windows-disclosure-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  await replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Synthetic Support\ntype: concept\n---\n\n${disclaimer}\n\nLocal path: c:\\users\\arke\\private\n`))
  const result = invoke(fx, "build")
  assert.equal(result.status, 1, result.stdout)
  assert.equal(oneJson(result).error.code, "SOURCE_ABSOLUTE_PATH_NOT_ALLOWED")
  await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
  assert.equal((await readdir(fx.paths.work)).length, 0)
})

test("T03 rejects wrong receipt location, root junctions, overlaps, and existing output sentinel", async (t) => {
  const fx = await fixture("tracer-paths-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const copied = path.join(fx.paths.context, "export-receipt.json")
  await writeFile(copied, JSON.stringify(fx.receipt))
  let result = invoke(fx, "preflight", { exportReceipt: copied })
  assert.equal(result.status, 1)
  const receiptFailure = oneJson(result)
  assert.equal(receiptFailure.error.code, "EXPORT_RECEIPT_LOCATION_INVALID")
  assert.equal(containsText(receiptFailure, fx.root), false)

  result = invoke(fx, "preflight", { output: path.join(fx.paths.vault, "site") })
  assert.equal(result.status, 1)
  assert.equal(oneJson(result).error.code, "PATH_OVERLAP_NOT_ALLOWED")

  await writeFile(fx.output, "last-known-good")
  result = invoke(fx, "build")
  assert.equal(result.status, 1)
  assert.equal(oneJson(result).error.code, "OUTPUT_ALREADY_EXISTS")
  assert.equal(await readFile(fx.output, "utf8"), "last-known-good")

  const target = path.join(fx.root, "junction-target")
  const alias = path.join(fx.root, "junction-work")
  await mkdir(target)
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir")
  result = invoke(fx, "preflight", { workRoot: alias, output: path.join(fx.root, "fresh-output") })
  assert.equal(result.status, 1)
  assert.equal(oneJson(result).error.code, "PATH_SYMLINK_NOT_ALLOWED")
})

test("T03 candidate-gate failure cleans its exclusive work run and never creates output", async (t) => {
  const fx = await fixture("tracer-gate-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const result = invoke(fx, "build", {}, { TYLER_TRACER_TEST_GATE_FAILURE: "1" })
  assert.equal(result.status, 1, result.stdout)
  assert.equal(oneJson(result).error.code, "CANDIDATE_GATE_FAILED")
  await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
  assert.equal((await readdir(fx.paths.work)).length, 0)
})

test("T03 never prunes arbitrary extra HTML before the exact route gate", async (t) => {
  const fx = await fixture("tracer-extra-html-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const result = invoke(fx, "build", {}, { TYLER_TRACER_TEST_EXTRA_HTML: "1" })
  assert.equal(result.status, 1, result.stdout)
  assert.equal(oneJson(result).error.code, "CANDIDATE_ROUTE_SET_INVALID")
  await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
  assert.equal((await readdir(fx.paths.work)).length, 0)
})

test("T03 post-Quartz immutable manifest and candidate root tamper gates fail closed", async (t) => {
  const cases = [
    ["route-derived virtual parent overwrite", "virtual-parent-tamper", "CANDIDATE_VIRTUAL_PAGE_TAMPERED"],
    ["unexpected non-HTML asset", "unexpected-asset", "CANDIDATE_FILE_MANIFEST_MISMATCH"],
    ["candidate root replaced by an in-run junction", "candidate-root-junction", "CANDIDATE_ROOT_INVALID"],
  ]
  for (const [name, variant, expectedCode] of cases) await t.test(name, async (t) => {
    const fx = await fixture("tracer-candidate-integrity-")
    t.after(() => rm(fx.root, { recursive: true, force: true }))
    const protectedBefore = Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault"].map(async (role) => [role, await snapshot(fx.paths[role])])))
    const result = invoke(fx, "build", {}, { TYLER_TRACER_TEST_CANDIDATE_CASE: variant })
    assert.equal(result.status, 1, `${name}: ${result.stdout}`)
    const failure = oneJson(result)
    assert.deepEqual(Object.keys(failure.error).sort(), ["code", "message"])
    assert.equal(failure.error.code, expectedCode)
    await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
    assert.equal((await readdir(fx.paths.work)).length, 0)
    const protectedAfter = Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault"].map(async (role) => [role, await snapshot(fx.paths[role])])))
    assert.deepEqual(protectedAfter, protectedBefore)
  })
})

test("T03 candidate URL-bearing attributes, active HTML, and CSS URLs are gated at the public CLI", async (t) => {
  const cases = [
    ["inline event attribute", "event-attribute", "CANDIDATE_EVENT_ATTRIBUTE"],
    ["poster private target", "poster-private", "CANDIDATE_ASSET_MISSING"],
    ["srcset missing baseline asset", "srcset-missing", "CANDIDATE_ASSET_MISSING"],
    ["form action and formaction private routes", "form-action-private", "CANDIDATE_UNAPPROVED_LINK"],
    ["object data private target", "object-data-private", "CANDIDATE_ASSET_MISSING"],
    ["meta refresh", "meta-refresh", "CANDIDATE_META_REFRESH"],
    ["inline CSS missing baseline asset", "css-url-missing", "CANDIDATE_ASSET_MISSING"],
    ["unsafe attribute scheme", "unsafe-attribute-scheme", "CANDIDATE_UNSAFE_SCHEME"],
    ["Zotero scheme disclosure", "zotero-scheme-disclosure", "CANDIDATE_UNSAFE_SCHEME"],
  ]
  for (const [name, variant, expectedCode] of cases) await t.test(name, async (t) => {
    const fx = await fixture("tracer-candidate-url-")
    t.after(() => rm(fx.root, { recursive: true, force: true }))
    const result = invoke(fx, "build", {}, { TYLER_TRACER_TEST_CANDIDATE_CASE: variant })
    assert.equal(result.status, 1, `${name}: ${result.stdout}`)
    const failure = oneJson(result)
    assert.deepEqual(Object.keys(failure.error).sort(), ["code", "message"])
    assert.equal(failure.error.code, expectedCode)
    await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
    assert.equal((await readdir(fx.paths.work)).length, 0)
  })
})

test("T03 test hooks require the explicit regression capability", async (t) => {
  const fx = await fixture("tracer-test-capability-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const result = invoke(fx, "preflight", {}, {
    TYLER_TRACER_TEST_CAPABILITY: "not-authorized",
    TYLER_TRACER_TEST_DISCLOSURE_ERROR: fx.root,
  })
  assert.equal(result.status, 0, result.stdout)
  assert.equal(oneJson(result).ok, true)
  await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
  assert.equal((await readdir(fx.paths.work)).length, 0)
})

test("T04 Architecture A generated artifacts expose exactly one project navigation surface per route", async (t) => {
  const fx = await fixture("tracer-theme-static-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const protectedBefore = Object.fromEntries(await Promise.all(
    ["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])]),
  ))
  const result = invoke(fx, "build")
  assert.equal(result.status, 0, result.stdout)
  assert.deepEqual(oneJson(result).routes, ["/", "/knowledge/concept/synthetic-support/", "/papers/synthetic-paper/"])
  const paper = await readFile(path.join(fx.output, "papers", "synthetic-paper", "index.html"), "utf8")
  const support = await readFile(path.join(fx.output, "knowledge", "concept", "synthetic-support", "index.html"), "utf8")
  const home = await readFile(path.join(fx.output, "index.html"), "utf8")
  const headings = [...paper.matchAll(/<h([1-6])\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/h\1>/gi)].map((match) => match[2])
  const scholarly = ["bibliography", "one-sentence-takeaway", "research-question", "citation"]
  assert.deepEqual(headings.filter((id) => scholarly.includes(id)), scholarly)
  for (const id of scholarly) assert.equal(support.includes(`id="${id}"`), false)
  assert.match(paper, /<body\b[^>]*data-tracer-template="paper"/)
  assert.match(support, /<body\b[^>]*data-tracer-template="support"/)
  for (const html of [paper, support]) {
    assert.equal((html.match(/http-equiv="Content-Security-Policy"/g) ?? []).length, 1)
    assert.match(html, /content="default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self' data:; frame-src 'none'; img-src 'self' data:; media-src 'self'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; form-action 'none'"/)
  }
  assert.match(paper, /<body\b[^>]*data-slug="papers\/synthetic-paper\/index"/)
  assert.match(support, /<body\b[^>]*data-slug="knowledge\/concept\/synthetic-support\/index"/)
  assert.match(paper, /<details class="zotero-annotations">\s*<summary>Zotero Annotations<\/summary>[\s\S]*Synthetic source annotation preserved for disclosure testing\.[\s\S]*<\/details>/)
  assert.doesNotMatch(paper, /<details class="zotero-annotations"\s+open\b/)
  assert.match(paper, /<button\b(?=[^>]*class="[^"]*explorer-toggle mobile-explorer)(?=[^>]*aria-controls="[^"]+")[^>]*>/)
  assert.match(paper, /<div class="toc">[\s\S]*?<button\b(?=[^>]*class="[^"]*toc-header)(?=[^>]*aria-controls="[^"]+")[^>]*>/)
  assert.match(paper, /class="breadcrumb-container"/)
  assert.match(paper, /id="backlinks"/)
  assert.match(paper, /class="left sidebar"/)
  assert.match(paper, /class="right sidebar"/)
  const cssFiles = (await readdir(fx.output)).filter((name) => name.endsWith(".css"))
  const css = (await Promise.all(cssFiles.map((name) => readFile(path.join(fx.output, name), "utf8")))).join("\n")
  const graph = JSON.parse(await readFile(path.join(fx.output, "graph.json"), "utf8"))
  const search = JSON.parse(await readFile(path.join(fx.output, "search-index.json"), "utf8"))
  const contentIndex = JSON.parse(await readFile(path.join(fx.output, "static", "contentIndex.json"), "utf8"))
  assert.deepEqual(Object.keys(graph), ["schema_version", "nodes", "edges"])
  assert.equal(graph.schema_version, 1)
  assert.deepEqual(graph.nodes.map((node) => node.public_id), ["synthetic-paper", "synthetic-support"])
  assert.deepEqual(graph.edges, [{ source: "synthetic-paper", target: "synthetic-support" }])
  assert.ok(graph.edges.every((edge) => graph.nodes.some((node) => node.public_id === edge.source) && graph.nodes.some((node) => node.public_id === edge.target)))
  assert.deepEqual(Object.keys(search), ["schema_version", "records"])
  assert.equal(search.schema_version, 1)
  assert.deepEqual(search.records.map((record) => record.public_id), ["synthetic-paper", "synthetic-support"])
  assert.equal(search.records.length, fx.manifest.nodes.length)
  for (const record of search.records) {
    assert.deepEqual(Object.keys(record), ["public_id", "title", "node_class", "url", "authors", "doi", "source_tags", "search_text"])
    assert.equal(Object.hasOwn(record, "slug"), false)
    assert.equal(Object.hasOwn(record, "content"), false)
  }
  assert.deepEqual(contentIndex, search)
  assert.match(css, /--tyler-tracer-theme\s*:\s*warm/)
  assert.match(css, /article table\s*\{[^}]*display:\s*block[^}]*overflow-x:\s*auto/)
  assert.match(css, /body\[data-slug\^=papers\\\/\]/)
  assert.match(css, /body\[data-slug\^=knowledge\\\/\]/)
  assert.match(css, /\.public-graph-glyph/)
  assert.doesNotMatch(css, /(?:@import\s+(?:url\()?|url\()\s*["']?https?:\/\//i)
  assert.doesNotMatch(paper, /<(?:link|script|img|iframe|source|video|audio)\b[^>]*(?:href|src|srcset|poster)="https?:\/\//i)
  assert.match(paper, /class="public-search"/)
  assert.match(paper, /<section\b(?=[^>]*id="public-graph-local-synthetic-paper")(?=[^>]*data-graph-scope="local")(?=[^>]*data-graph-root-id="synthetic-paper")[^>]*>/)
  assert.doesNotMatch(paper, /@quartz-community\/graph|cdnjs\.cloudflare\.com/i)
  const classTokenCount = (html, token) => [...html.matchAll(/\bclass="([^"]*)"/g)].filter((match) => match[1].split(/\s+/).includes(token)).length
  for (const [route, html, scope, backlinks] of [
    ["/", home, "global", 0],
    ["/papers/synthetic-paper/", paper, "local", 1],
    ["/knowledge/concept/synthetic-support/", support, "local", 1],
  ]) {
    assert.equal(classTokenCount(html, "explorer"), 1, `${route}: project Explorer must be unique`)
    assert.equal(classTokenCount(html, "public-search"), 1, `${route}: project search must be unique`)
    assert.equal(classTokenCount(html, "public-graph"), 1, `${route}: route graph must be unique`)
    assert.equal((html.match(/\bdata-public-backlinks(?:\s|=|>)/g) ?? []).length, backlinks, `${route}: backlinks contract`)
    assert.equal((html.match(new RegExp(`data-graph-scope="${scope}"`, "g")) ?? []).length, 1, `${route}: graph scope contract`)
    assert.equal((html.match(/data-tracer-extension="t05-search"/g) ?? []).length, 1, `${route}: search runtime must be unique`)
    assert.equal((html.match(/data-tracer-extension="t05-graph"/g) ?? []).length, 1, `${route}: graph runtime must be unique`)
    assert.doesNotMatch(html, /(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|(?:^|[\W])d3(?:[.@/]|\W)|pixi(?:\.min)?\.js|Math\.random\s*\()/i, `${route}: vendor or nondeterministic graph runtime`)
    assert.doesNotMatch(html, /@quartz-community\/(?:explorer|search|graph|backlinks)/i, `${route}: vendor navigation marker`)
  }
  const protectedAfter = Object.fromEntries(await Promise.all(
    ["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])]),
  ))
  assert.deepEqual(protectedAfter, protectedBefore)
})

test("Architecture A config transform fails closed for every pinned vendor plugin drift", async (t) => {
  for (const plugin of pinnedVendorNavigationPlugins) {
    for (const drift of ["missing", "renamed", "schema", "enable-token"]) await t.test(`${plugin}: ${drift}`, async (t) => {
      const fx = await fixture("architecture-config-drift-")
      t.after(() => rm(fx.root, { recursive: true, force: true }))
      const protectedBefore = Object.fromEntries(await Promise.all(
        ["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])]),
      ))

      const result = invoke(fx, "build", {}, { TYLER_TRACER_TEST_CONFIG_CASE: `navigation:${plugin}:${drift}` })

      assert.equal(result.status, 1, `${plugin}/${drift}: ${result.stdout}`)
      assert.equal(oneJson(result).error.code, "QUARTZ_CONFIG_TRANSFORM_FAILED", `${plugin}/${drift}`)
      await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
      assert.deepEqual(Object.fromEntries(await Promise.all(
        ["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])]),
      )), protectedBefore, `${plugin}/${drift}`)
    })
  }
})

test("Architecture A public search artifacts reject vendor broad and virtual-record schemas", async (t) => {
  const cases = [
    ["vendor slug-keyed content index", "vendor-slug-keyed-search"],
    ["broad record fields", "broad-search-record"],
    ["extra virtual record", "extra-virtual-search-record"],
  ]
  for (const [name, variant] of cases) await t.test(name, async (t) => {
    const fx = await fixture("architecture-search-schema-")
    t.after(() => rm(fx.root, { recursive: true, force: true }))
    const protectedBefore = Object.fromEntries(await Promise.all(
      ["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])]),
    ))

    const result = invoke(fx, "build", {}, { TYLER_TRACER_TEST_PREBASELINE_CASE: variant })

    assert.equal(result.status, 1, `${name}: ${result.stdout}`)
    assert.equal(oneJson(result).error.code, "CANDIDATE_PUBLIC_DATA_INVALID", name)
    await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
    assert.deepEqual(Object.fromEntries(await Promise.all(
      ["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])]),
    )), protectedBefore, name)
  })
})

test("Architecture A candidate gate rejects nondeterministic graph layout before output creation", async (t) => {
  const fx = await fixture("architecture-random-graph-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const protectedBefore = Object.fromEntries(await Promise.all(
    ["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])]),
  ))

  const result = invoke(fx, "build", {}, { TYLER_TRACER_TEST_PREBASELINE_CASE: "graph-math-random" })

  assert.equal(result.status, 1, result.stdout)
  assert.equal(oneJson(result).error.code, "T04_BOUNDARY_VIOLATION")
  await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
  assert.deepEqual(Object.fromEntries(await Promise.all(
    ["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])]),
  )), protectedBefore)
})

test("Architecture A pinned Quartz HTML integration seam drift fails closed", async (t) => {
  const fx = await fixture("architecture-html-seam-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const protectedBefore = Object.fromEntries(await Promise.all(
    ["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])]),
  ))

  const result = invoke(fx, "build", {}, { TYLER_TRACER_TEST_QUARTZ_HTML_CASE: "content-index-fetch-seam-renamed" })

  assert.equal(result.status, 1, result.stdout)
  assert.equal(oneJson(result).error.code, "QUARTZ_HTML_INTEGRATION_SEAM_INVALID")
  await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
  assert.deepEqual(Object.fromEntries(await Promise.all(
    ["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])]),
  )), protectedBefore)
})

test("T10 integrated Vault paper shape projects the accepted scholarly masthead without changing source", async (t) => {
  const fx = await fixture("t10-integrated-shape-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const source = Buffer.from(`---\ntitle: Synthetic Integrated Paper\ntype: literature-note\nstatus: integrated\n---\n\n# Synthetic Integrated Paper\n\n${disclaimer}\n\n## One-sentence Takeaway\n\nSynthetic integrated takeaway.\n\n## Citation\n\nSynthetic integrated citation.\n\n## Research Question\n\nSynthetic integrated question.\n\n## Findings\n\n| Long synthetic column one | Long synthetic column two | Long synthetic column three | Long synthetic column four |\n| --- | --- | --- | --- |\n| fixture-only value | fixture-only value | fixture-only value | fixture-only value |\n\nData: Synthetic prose label; this is not a URL.\n\n<!-- zotero-annotations:start -->\n## Zotero Annotations\n\n| Color | Meaning |\n| --- | --- |\n| <span style="background-color:#aaaaaa; color:#000; padding:1px 6px; border-radius:4px;">Gray</span> | fixture only |\n\n- Zotero item: [Open in Zotero](zotero://select/library/items/SYNTHETIC)\n\n- [Open PDF](zotero://open-pdf/library/items/ATTACHMENT?page=1&annotation=SYNTHETIC) <!-- zotero-annotation: SYNTHETIC -->\n  - Metadata: attachment \`ATTACHMENT\`; color \`#aaaaaa\`; type \`highlight\`; position \`{\"pageIndex\":0}\`\n\nSynthetic annotation.\n\n<!-- zotero-annotations:end -->\n\n## Connections\n\n[[Knowledge/Concepts/synthetic-support|approved support alias]]\n`)
  await replaceSource(fx, "synthetic-paper", source)
  const sourceBefore = await readFile(path.join(fx.paths.export, "Literature", "Notes", "synthetic-paper.md"))

  const result = invoke(fx, "build")
  assert.equal(result.status, 0, result.stdout)
  const paper = await readFile(path.join(fx.output, "papers", "synthetic-paper", "index.html"), "utf8")
  assert.deepEqual(semanticHeadings(paper).filter(({ level }) => level === 2).slice(0, 5).map(({ id }) => id), [
    "bibliography", "one-sentence-takeaway", "research-question", "citation", "findings",
  ])
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/.exec(paper)?.[1]
  assert.ok(article)
  assert.match(article, /<h2[^>]*id="bibliography"[^>]*>[\s\S]*?<\/h2>\s*<p>Not stated\.<\/p>/)
  assert.equal((article.match(/Synthetic integrated citation\./g) ?? []).length, 1)
  assert.match(paper, /<details class="zotero-annotations">/)
  assert.doesNotMatch(paper, /zotero:\/\//)
  assert.doesNotMatch(paper, /ATTACHMENT|pageIndex|Metadata:\s*attachment/i)
  assert.doesNotMatch(paper, /<span style=/)
  assert.doesNotMatch(paper, /<!--\s*zotero-annotation:|`annotation:/i)
  for (const relative of ["search-index.json", "static/contentIndex.json"]) {
    const contract = JSON.parse(await readFile(path.join(fx.output, ...relative.split("/")), "utf8"))
    const record = contract.records.find((entry) => entry.public_id === "synthetic-paper")
    assert.ok(record, relative)
    assert.doesNotMatch(record.search_text, /Synthetic annotation|Zotero Annotations|Open PDF|zotero:/i, relative)
  }
  assert.deepEqual(await readFile(path.join(fx.paths.export, "Literature", "Notes", "synthetic-paper.md")), sourceBefore)
})

test("T10 Zotero projection rejects a managed local link outside the exact inert dialect", async (t) => {
  const fx = await fixture("t10-zotero-link-shape-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const source = Buffer.from(`---\ntitle: Synthetic Integrated Paper\ntype: literature-note\nstatus: integrated\n---\n\n# Synthetic Integrated Paper\n\n${disclaimer}\n\n## One-sentence Takeaway\n\nSynthetic integrated takeaway.\n\n## Citation\n\nSynthetic integrated citation.\n\n## Research Question\n\nSynthetic integrated question.\n\n<!-- zotero-annotations:start -->\n## Zotero Annotations\n\n- [Open PDF](zotero://select/library/items/SYNTHETIC?unexpected=1)\n\n<!-- zotero-annotations:end -->\n\n## Connections\n\n[[Knowledge/Concepts/synthetic-support|approved support alias]]\n`)
  await replaceSource(fx, "synthetic-paper", source)
  const before = await snapshot(fx.root)
  const result = invoke(fx, "build")
  assert.equal(result.status, 1, result.stdout)
  assert.equal(oneJson(result).error.code, "SOURCE_UNSAFE_URL_SCHEME")
  assert.deepEqual(await snapshot(fx.root), before)
  await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
})

test("T10 public preflight rejects every Zotero Markdown link outside an authenticated managed block", async (t) => {
  const cases = [
    ["select without managed markers", "[Open in Zotero](zotero://select/library/items/SYNTHETIC)"],
    ["open-pdf without managed markers", "[Open PDF](zotero://open-pdf/library/items/ATTACHMENT?page=1&annotation=SYNTHETIC)"],
    ["open-pdf with only an annotation marker", "[Open PDF](zotero://open-pdf/library/items/ATTACHMENT?page=1&annotation=SYNTHETIC) <!-- zotero-annotation: SYNTHETIC -->"],
    ["literal plain text", "zotero://select/library/items/OPAQUE123"],
    ["mixed-case plain text", "ZoTeRo://select/library/items/OPAQUE123"],
    ["whitespace-control split plain text", "zotero\t\n:\u000b//select/library/items/OPAQUE123"],
    ["HTML named entity colon", "zotero&colon;//select/library/items/OPAQUE123"],
    ["HTML numeric entity colon", "zotero&#x3a;//select/library/items/OPAQUE123"],
    ["nested HTML entity colon", "zotero&amp;#58;//select/library/items/OPAQUE123"],
    ["single percent layer plain text", "zotero%3A//select/library/items/OPAQUE123"],
    ["double percent layer plain text", "zotero%253A//select/library/items/OPAQUE123"],
    ["triple percent layer plain text", "zotero%25253A//select/library/items/OPAQUE123"],
    ["twelve percent layers plain text", `zotero%${"25".repeat(11)}3A//select/library/items/OPAQUE123`],
  ]
  for (const [name, markdownLink] of cases) await t.test(name, async (t) => {
    const fx = await fixture("t10-zotero-outside-")
    t.after(() => rm(fx.root, { recursive: true, force: true }))
    await replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: Synthetic Support\ntype: concept\n---\n\n# Synthetic Support\n\n${markdownLink}\n`))
    const protectedBefore = Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])])))

    const result = invoke(fx, "preflight")

    assert.equal(result.status, 1, `${name}: ${result.stdout}`)
    assert.deepEqual(oneJson(result), { ok: false, error: { code: "SOURCE_UNSAFE_URL_SCHEME", message: "Zotero local URLs require the authenticated managed block" } })
    await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
    assert.deepEqual(Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])]))), protectedBefore)
  })
})

test("T10 public preflight rejects Zotero disclosure in frontmatter before output mutation", async (t) => {
  const fx = await fixture("t10-zotero-frontmatter-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  await replaceSource(fx, "synthetic-support", Buffer.from(`---\ntitle: zotero://select/library/items/OPAQUE123\ntype: concept\n---\n\n# Synthetic Support\n\n${disclaimer}\n`))
  const protectedBefore = Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])])))

  const result = invoke(fx, "preflight")

  assert.equal(result.status, 1, result.stdout)
  assert.deepEqual(oneJson(result), { ok: false, error: { code: "SOURCE_UNSAFE_URL_SCHEME", message: "Zotero local URLs require the authenticated managed block" } })
  await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
  assert.deepEqual(Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])]))), protectedBefore)
})

test("T10 exact paper zotero_uri frontmatter remains private and never reaches public output", async (t) => {
  const fx = await fixture("t10-zotero-private-frontmatter-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const source = zoteroPaperSource("Synthetic private-metadata compatibility annotation.")
    .toString("utf8")
    .replace("status: integrated\n", "status: integrated\nzotero_uri: zotero://select/library/items/SYNTHETIC\n")
  await replaceSource(fx, "synthetic-paper", Buffer.from(source))

  const result = invoke(fx, "build")

  assert.equal(result.status, 0, result.stdout)
  for (const [, bytes] of await outputTree(fx.output)) assert.doesNotMatch(bytes.toString("utf8"), /zotero\s*(?::|%3a|&colon;)/i)
})

test("T10 private zotero_uri frontmatter accepts only an exact paper item URI", async (t) => {
  const paperSource = (line) => Buffer.from(zoteroPaperSource("Synthetic private frontmatter boundary annotation.").toString("utf8").replace("status: integrated\n", `status: integrated\n${line}\n`))
  const cases = [
    ["support node", "synthetic-support", Buffer.from(`---\ntitle: Synthetic Support\ntype: concept\nzotero_uri: zotero://select/library/items/SYNTHETIC\n---\n\n# Synthetic Support\n\n${disclaimer}\n`)],
    ["extra query", "synthetic-paper", paperSource("zotero_uri: zotero://select/library/items/SYNTHETIC?extra=1")],
    ["array value", "synthetic-paper", paperSource("zotero_uri:\n  - zotero://select/library/items/SYNTHETIC")],
    ["encoded scheme", "synthetic-paper", paperSource("zotero_uri: zotero%3A//select/library/items/SYNTHETIC")],
  ]
  for (const [name, nodeId, source] of cases) await t.test(name, async (t) => {
    const fx = await fixture("t10-zotero-frontmatter-invalid-")
    t.after(() => rm(fx.root, { recursive: true, force: true }))
    await replaceSource(fx, nodeId, source)
    const protectedBefore = Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])])))

    const result = invoke(fx, "preflight")

    assert.equal(result.status, 1, `${name}: ${result.stdout}`)
    assert.equal(oneJson(result).error.code, "SOURCE_UNSAFE_URL_SCHEME")
    await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
    assert.deepEqual(Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])]))), protectedBefore)
  })
})

test("T10 table-driven Zotero writer dialect accepts only current and legacy inert forms", async (t) => {
  const valid = [
    ["current", `| Color | Meaning |\n| --- | --- |\n| <span style="background-color:#aaaaaa; color:#000; padding:1px 6px; border-radius:4px;">Gray</span> | fixture only |\n\n- Zotero item: [Open in Zotero](zotero://select/library/items/SYNTHETIC)\n\n- [Open PDF](zotero://open-pdf/library/items/ATTACHMENT?page=1&annotation=SYNTHETIC) <!-- zotero-annotation: SYNTHETIC -->\n  - Metadata: attachment \`ATTACHMENT\`; color \`#aaaaaa\`; type \`highlight\`; position \`{\"pageIndex\":0}\`\n\nSynthetic annotation.`],
    ["current URL with legacy annotation marker", `- [Open PDF](zotero://open-pdf/library/items/ATTACHMENT?page=12&annotation=SYNTHETIC) · \`annotation:SYNTHETIC\`\n\nSynthetic legacy annotation.`],
    ["legacy page-only URL with annotation marker", `- [Open PDF](zotero://open-pdf/library/items/ATTACHMENT?page=12) · \`annotation:SYNTHETIC\`\n\nSynthetic legacy annotation.`],
  ]
  for (const [name, block] of valid) await t.test(`accepts ${name}`, async (t) => {
    const fx = await fixture("t10-zotero-valid-")
    t.after(() => rm(fx.root, { recursive: true, force: true }))
    await replaceSource(fx, "synthetic-paper", zoteroPaperSource(block))
    const before = await snapshot(fx.root)
    const result = invoke(fx, "preflight")
    assert.equal(result.status, 0, `${name}: ${result.stdout}`)
    assert.deepEqual(await snapshot(fx.root), before)
    await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
  })

  const invalid = [
    ["missing item key", "- [Open in Zotero](zotero://select/library/items/)", "SOURCE_UNSAFE_URL_SCHEME"],
    ["extra select path", "- [Open in Zotero](zotero://select/library/items/SYNTHETIC/extra)", "SOURCE_UNSAFE_URL_SCHEME"],
    ["page-only URL without legacy marker", "- [Open PDF](zotero://open-pdf/library/items/ATTACHMENT?page=1)", "SOURCE_UNSAFE_URL_SCHEME"],
    ["page-only URL with current marker", "- [Open PDF](zotero://open-pdf/library/items/ATTACHMENT?page=1) <!-- zotero-annotation: SYNTHETIC -->", "SOURCE_UNSAFE_URL_SCHEME"],
    ["current URL without annotation marker", "- [Open PDF](zotero://open-pdf/library/items/ATTACHMENT?page=1&annotation=SYNTHETIC)", "SOURCE_ACTIVE_CONTENT_NOT_ALLOWED"],
    ["extra query", "- [Open PDF](zotero://open-pdf/library/items/ATTACHMENT?page=1&annotation=SYNTHETIC&extra=1)", "SOURCE_UNSAFE_URL_SCHEME"],
    ["reordered query", "- [Open PDF](zotero://open-pdf/library/items/ATTACHMENT?annotation=SYNTHETIC&page=1)", "SOURCE_UNSAFE_URL_SCHEME"],
    ["percent-encoded scheme", "- [Open in Zotero](zotero%3A//select/library/items/SYNTHETIC)", "SOURCE_UNSAFE_URL_SCHEME"],
    ["double-percent-encoded scheme", "- [Open in Zotero](zotero%253A//select/library/items/SYNTHETIC)", "SOURCE_UNSAFE_URL_SCHEME"],
    ["triple-percent-encoded scheme", "- [Open in Zotero](zotero%25253A//select/library/items/SYNTHETIC)", "SOURCE_UNSAFE_URL_SCHEME"],
    ["deep-percent-encoded scheme", `- [Open in Zotero](zotero%${"25".repeat(11)}3A//select/library/items/SYNTHETIC)`, "SOURCE_UNSAFE_URL_SCHEME"],
    ["percent-encoded key", "- [Open in Zotero](zotero://select/library/items/SYN%54HETIC)", "SOURCE_UNSAFE_URL_SCHEME"],
    ["link title", "- [Open in Zotero](zotero://select/library/items/SYNTHETIC \"local title\")", "SOURCE_UNSAFE_URL_SCHEME"],
    ["metadata spacing variant", "- [Open PDF](zotero://open-pdf/library/items/ATTACHMENT?page=1&annotation=SYNTHETIC) <!-- zotero-annotation: SYNTHETIC -->\n  - Metadata : attachment \`ATTACHMENT\`; color \`#aaaaaa\`; type \`highlight\`; position \`{\"pageIndex\":0}\`", "SOURCE_ACTIVE_CONTENT_NOT_ALLOWED"],
    ["duplicate annotation marker", "- [Open PDF](zotero://open-pdf/library/items/ATTACHMENT?page=1&annotation=SYNTHETIC) <!-- zotero-annotation: SYNTHETIC --> <!-- zotero-annotation: SYNTHETIC -->", "SOURCE_ACTIVE_CONTENT_NOT_ALLOWED"],
    ["mismatched annotation marker", "- [Open PDF](zotero://open-pdf/library/items/ATTACHMENT?page=1&annotation=SYNTHETIC) <!-- zotero-annotation: OTHER -->", "SOURCE_ACTIVE_CONTENT_NOT_ALLOWED"],
    ["opaque annotation leakage", "- annotation:SYNTHETIC", "SOURCE_ACTIVE_CONTENT_NOT_ALLOWED"],
  ]
  for (const [name, block, expectedCode] of invalid) await t.test(`rejects ${name}`, async (t) => {
    const fx = await fixture("t10-zotero-invalid-")
    t.after(() => rm(fx.root, { recursive: true, force: true }))
    await replaceSource(fx, "synthetic-paper", zoteroPaperSource(block))
    const protectedBefore = Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])])))
    const result = invoke(fx, "preflight")
    assert.equal(result.status, 1, `${name}: ${result.stdout}`)
    assert.equal(oneJson(result).error.code, expectedCode, name)
    await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
    assert.deepEqual(Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(fx.paths[role])]))), protectedBefore, name)
  })
})

test("T04 semantic template preflight rejects missing/reordered paper mastheads and paper-only support headings", async (t) => {
  const paperPrefix = `---\ntitle: Synthetic Paper\ntype: literature-note\nstatus: integrated\n---\n\n# Synthetic Paper\n\n${disclaimer}\n\n`
  const connection = `\n\n## Connections\n\n[[Knowledge/Concepts/synthetic-support|approved support alias]]\n`
  const cases = [
    ["missing paper field", "synthetic-paper", Buffer.from(`${paperPrefix}## Bibliography\n\nNot stated\n\n## One-sentence Takeaway\n\nNot stated\n\n## Research Question\n\nNot stated${connection}`)],
    ["reordered paper fields", "synthetic-paper", Buffer.from(`${paperPrefix}## One-sentence Takeaway\n\nNot stated\n\n## Bibliography\n\nNot stated\n\n## Research Question\n\nNot stated\n\n## Citation\n\nNot stated${connection}`)],
    ["support claims paper masthead", "synthetic-support", Buffer.from(`---\ntitle: Synthetic Support\ntype: concept\n---\n\n# Synthetic Support\n\n${disclaimer}\n\n## Bibliography\n\nNot stated\n`)],
  ]
  for (const [name, nodeId, bytes] of cases) await t.test(name, async (t) => {
    const fx = await fixture("tracer-template-negative-")
    t.after(() => rm(fx.root, { recursive: true, force: true }))
    await replaceSource(fx, nodeId, bytes)
    const before = await snapshot(fx.root)
    const result = invoke(fx, "build")
    assert.equal(result.status, 1, `${name}: ${result.stdout}`)
    assert.equal(oneJson(result).error.code, "SEMANTIC_TEMPLATE_INVALID")
    assert.deepEqual(await snapshot(fx.root), before)
    await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
    assert.equal((await readdir(fx.paths.work)).length, 0)
  })
})

test("T04 Architecture A external-resource gate and pinned config seam fail closed", async (t) => {
  const cases = [
    ["content-index single-quote drift", { TYLER_TRACER_TEST_CONFIG_CASE: "content-index-single-quote" }, "QUARTZ_CONFIG_TRANSFORM_FAILED"],
    ["external script before baseline", { TYLER_TRACER_TEST_PREBASELINE_CASE: "external-script" }, "T04_BOUNDARY_VIOLATION"],
    ["commented nested CSS import before baseline", { TYLER_TRACER_TEST_PREBASELINE_CASE: "commented-css-import" }, "T04_BOUNDARY_VIOLATION"],
    ["spaced quoted CSS import before baseline", { TYLER_TRACER_TEST_PREBASELINE_CASE: "spaced-css-import" }, "T04_BOUNDARY_VIOLATION"],
    ["escaped CSS scheme before baseline", { TYLER_TRACER_TEST_PREBASELINE_CASE: "escaped-css-scheme" }, "T04_BOUNDARY_VIOLATION"],
  ]
  for (const [name, env, expectedCode] of cases) await t.test(name, async (t) => {
    const fx = await fixture("tracer-t04-boundary-")
    t.after(() => rm(fx.root, { recursive: true, force: true }))
    const protectedBefore = Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault"].map(async (role) => [role, await snapshot(fx.paths[role])])))
    const result = invoke(fx, "build", {}, env)
    assert.equal(result.status, 1, `${name}: ${result.stdout}`)
    assert.equal(oneJson(result).error.code, expectedCode)
    const protectedAfter = Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault"].map(async (role) => [role, await snapshot(fx.paths[role])])))
    assert.deepEqual(protectedAfter, protectedBefore)
    await assert.rejects(lstat(fx.output), (error) => error.code === "ENOENT")
    assert.equal((await readdir(fx.paths.work)).length, 0)
  })
})

test("T04 fixed theme swap changes only theme assets and preserves public semantics", async (t) => {
  const warm = await fixture("tracer-theme-warm-")
  const contrast = await fixture("tracer-theme-contrast-")
  t.after(() => Promise.all([rm(warm.root, { recursive: true, force: true }), rm(contrast.root, { recursive: true, force: true })]))
  const warmProtected = Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(warm.paths[role])])))
  const contrastProtected = Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(contrast.paths[role])])))
  const warmBuild = invoke(warm, "build")
  const contrastBuild = invoke(contrast, "build", {}, { TYLER_TRACER_TEST_THEME_VARIANT: "contrast" })
  assert.equal(warmBuild.status, 0, warmBuild.stdout)
  assert.equal(contrastBuild.status, 0, contrastBuild.stdout)
  assert.deepEqual(oneJson(warmBuild).routes, oneJson(contrastBuild).routes)
  const warmFiles = await outputTree(warm.output)
  const contrastFiles = await outputTree(contrast.output)
  const htmlPaths = warmFiles.filter(([name]) => name.endsWith(".html")).map(([name]) => name)
  assert.deepEqual(htmlPaths, contrastFiles.filter(([name]) => name.endsWith(".html")).map(([name]) => name))
  assert.deepEqual(htmlPaths, ["index.html", "knowledge/concept/synthetic-support/index.html", "papers/synthetic-paper/index.html"])
  for (const [relative, route] of [["papers/synthetic-paper/index.html", "/papers/synthetic-paper/"], ["knowledge/concept/synthetic-support/index.html", "/knowledge/concept/synthetic-support/"]]) {
    const warmHtml = warmFiles.find(([name]) => name === relative)[1].toString("utf8")
    const contrastHtml = contrastFiles.find(([name]) => name === relative)[1].toString("utf8")
    assert.deepEqual(semanticHeadings(warmHtml), semanticHeadings(contrastHtml))
    assert.deepEqual(routeHrefs(warmHtml, route), routeHrefs(contrastHtml, route))
    const warmArticle = /<article\b[^>]*>([\s\S]*?)<\/article>/.exec(warmHtml)?.[1]
    const contrastArticle = /<article\b[^>]*>([\s\S]*?)<\/article>/.exec(contrastHtml)?.[1]
    assert.equal(digest(warmArticle), digest(contrastArticle))
  }
  const warmCss = warmFiles.filter(([name]) => name.endsWith(".css")).map(([, bytes]) => bytes).join("\n")
  const contrastCss = contrastFiles.filter(([name]) => name.endsWith(".css")).map(([, bytes]) => bytes).join("\n")
  assert.match(warmCss, /--tyler-tracer-theme\s*:\s*warm/)
  assert.match(contrastCss, /--tyler-tracer-theme\s*:\s*contrast/)
  assert.notEqual(digest(warmCss), digest(contrastCss))
  const ownedDataPaths = ["graph.json", "search-index.json", "static/contentIndex.json"]
  for (const files of [warmFiles, contrastFiles]) assert.deepEqual(files.map(([name]) => name).filter((name) => /contentIndex|graph|search/i.test(name)), ownedDataPaths)
  for (const relative of ownedDataPaths) {
    const warmBytes = warmFiles.find(([name]) => name === relative)?.[1]
    const contrastBytes = contrastFiles.find(([name]) => name === relative)?.[1]
    assert.ok(warmBytes && contrastBytes)
    assert.deepEqual(warmBytes, contrastBytes)
  }
  assert.deepEqual(Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(warm.paths[role])]))), warmProtected)
  assert.deepEqual(Object.fromEntries(await Promise.all(["context", "runtime", "export", "vault", "work"].map(async (role) => [role, await snapshot(contrast.paths[role])]))), contrastProtected)
})

test("T10 CDP error audit persists across navigation and catches later console errors and exceptions", async (t) => {
  const fx = await fixture("t10-browser-error-audit-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const buildResult = invoke(fx, "build")
  assert.equal(buildResult.status, 0, buildResult.stdout)
  const session = await edgeSession(fx.output)
  t.after(() => session.close())
  const errors = []
  session.client.on("Runtime.consoleAPICalled", (event) => {
    if (event.type === "error") errors.push({ kind: "console", text: event.args.map((value) => value.value ?? value.description ?? "").join(" ") })
  })
  session.client.on("Runtime.exceptionThrown", (event) => {
    errors.push({ kind: "exception", text: event.exceptionDetails.exception?.description ?? event.exceptionDetails.text })
  })
  await session.client.send("Page.addScriptToEvaluateOnNewDocument", { source: `if(location.pathname.includes("synthetic-support")){queueMicrotask(()=>console.error("T10_LATER_NAV_CONSOLE"));setTimeout(()=>{throw new Error("T10_LATER_NAV_EXCEPTION")},0)}` })

  await cdpNavigate(session, "/papers/synthetic-paper/", 1440, 1100)
  assert.deepEqual(errors, [])
  await cdpNavigate(session, "/knowledge/concept/synthetic-support/", 1440, 1100)
  await waitFor(() => errors.length >= 2)

  assert.equal(errors.some((entry) => entry.kind === "console" && entry.text.includes("T10_LATER_NAV_CONSOLE")), true, JSON.stringify(errors))
  assert.equal(errors.some((entry) => entry.kind === "exception" && entry.text.includes("T10_LATER_NAV_EXCEPTION")), true, JSON.stringify(errors))
})

test("T10 native CDP Tab and Enter activate mobile Explorer and ToC buttons", async (t) => {
  const fx = await fixture("t10-native-keyboard-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const buildResult = invoke(fx, "build")
  assert.equal(buildResult.status, 0, buildResult.stdout)
  const session = await edgeSession(fx.output)
  t.after(() => session.close())
  await cdpNavigate(session, "/papers/synthetic-paper/", 390, 844)
  await cdpValue(session, `() => { document.activeElement?.blur(); return true }`)

  const tabTo = async (selector) => {
    for (let index = 0; index < 30; index += 1) {
      await cdpNativeKey(session, "Tab")
      if (await cdpValue(session, `() => document.activeElement?.matches(${JSON.stringify(selector)}) === true`)) return
    }
    assert.fail(`native Tab did not focus ${selector}`)
  }
  const state = (buttonSelector) => cdpValue(session, `() => {
    const button=document.querySelector(${JSON.stringify(buttonSelector)}),content=button&&document.getElementById(button.getAttribute("aria-controls")),style=content&&getComputedStyle(content)
    return { focused:document.activeElement===button,expanded:button?.getAttribute("aria-expanded"),contentExpanded:content?.getAttribute("aria-expanded"),display:style?.display,visibility:style?.visibility }
  }`)

  await tabTo(".explorer-toggle.mobile-explorer")
  const explorerBefore = await state(".explorer-toggle.mobile-explorer")
  await cdpNativeKey(session, "Enter")
  const explorerAfter = await state(".explorer-toggle.mobile-explorer")
  assert.equal(explorerBefore.focused, true)
  assert.notEqual(explorerAfter.expanded, explorerBefore.expanded)
  assert.equal(explorerAfter.focused, true)
  assert.equal(explorerAfter.expanded, explorerAfter.contentExpanded)

  await cdpNativeKey(session, "Escape")
  assert.equal((await state(".explorer-toggle.mobile-explorer")).focused, true)
  await tabTo("button.toc-header")
  const tocBefore = await state("button.toc-header")
  await cdpNativeKey(session, "Enter")
  const tocAfter = await state("button.toc-header")
  assert.equal(tocBefore.focused, true)
  assert.notEqual(tocAfter.expanded, tocBefore.expanded)
  assert.equal(tocAfter.focused, true)
  assert.equal(tocAfter.expanded, tocAfter.contentExpanded)
  assert.equal(tocAfter.expanded === "true" ? tocAfter.display !== "none" && tocAfter.visibility !== "hidden" : tocAfter.display === "none", true, JSON.stringify(tocAfter))

  await cdpNativeKey(session, "Escape")
  const tocEscaped = await state("button.toc-header")
  assert.equal(tocEscaped.expanded, "false")
  assert.equal(tocEscaped.focused, true)
})

test("T04 Architecture A Chromium proves unique project navigation and route-scoped graph/backlinks", async (t) => {
  const fx = await fixture("tracer-theme-browser-")
  t.after(() => rm(fx.root, { recursive: true, force: true }))
  const buildResult = invoke(fx, "build")
  assert.equal(buildResult.status, 0, buildResult.stdout)
  const session = await edgeSession(fx.output)
  t.after(() => session.close())
  assert.ok(session.edgeArgs.includes("--headless=new"))
  assert.equal(edgeSpawnOptions.windowsHide, true)
  const browserErrors = []
  session.client.on("Runtime.consoleAPICalled", (event) => {
    if (event.type === "error") browserErrors.push({ kind: "console", text: event.args.map((value) => value.value ?? value.description ?? "").join(" ") })
  })
  session.client.on("Runtime.exceptionThrown", (event) => browserErrors.push({ kind: "exception", text: event.exceptionDetails.exception?.description ?? event.exceptionDetails.text }))
  session.client.on("Log.entryAdded", ({ entry }) => {
    if (entry.level === "error") browserErrors.push({ kind: "log", text: entry.text })
  })
  const browserArchitecture = () => cdpValue(session, `() => ({
    explorer: document.querySelectorAll(".explorer").length,
    search: document.querySelectorAll(".public-search").length,
    graph: document.querySelectorAll(".public-graph").length,
    graphScopes: [...document.querySelectorAll(".public-graph")].map((element) => element.dataset.graphScope),
    backlinks: document.querySelectorAll("[data-public-backlinks]").length,
    externalResources: performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => new URL(name, location.href).origin !== location.origin),
  })`)

  await cdpNavigate(session, "/", 1440, 1100)
  assert.equal(await cdpValue(session, `() => location.pathname`), "/")
  assert.deepEqual(await browserArchitecture(), { explorer: 1, search: 1, graph: 1, graphScopes: ["global"], backlinks: 0, externalResources: [] })
  await cdpNavigate(session, "/papers/synthetic-paper/", 1440, 1100)
  const desktop = await cdpValue(session, `() => {
    const rect = (selector) => { const element = document.querySelector(selector), value = element?.getBoundingClientRect(), style = element && getComputedStyle(element); return value && { top: value.top, bottom: value.bottom, width: value.width, height: value.height, display: style.display, visibility: style.visibility, opacity: style.opacity } }
    const readable = (selector) => [...document.querySelectorAll(selector)].map(element => {
      const bounds = element.getBoundingClientRect(), style = getComputedStyle(element)
      return { text: element.textContent.trim(), top: bounds.top, left: bounds.left, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height, display: style.display, visibility: style.visibility, opacity: style.opacity, color: style.color }
    }).filter(item => item.text && item.width > 0 && item.height > 0 && item.right > 0 && item.left < innerWidth && item.bottom > 0 && item.top < innerHeight && item.display !== "none" && item.visibility !== "hidden" && item.opacity !== "0")
    const bodyStyle = getComputedStyle(document.body), cjkText = "這是合成且非研究內容，僅供繁體中文排版驗收。", walker = document.createTreeWalker(document.querySelector("article"), NodeFilter.SHOW_TEXT); let cjkRect = null
    while (walker.nextNode()) { const index = walker.currentNode.data.indexOf(cjkText); if (index >= 0) { const range = document.createRange(); range.setStart(walker.currentNode, index); range.setEnd(walker.currentNode, index + cjkText.length); const value = range.getBoundingClientRect(); cjkRect = { width: value.width, height: value.height, top: value.top, bottom: value.bottom }; break } }
    const focus = selector => { const element = document.querySelector(selector); element?.focus(); const style = element && getComputedStyle(element); return element && { active: document.activeElement === element, style: style.outlineStyle, width: parseFloat(style.outlineWidth), color: style.outlineColor } }
    return { slug: document.body.dataset.slug, template: document.body.dataset.tracerTemplate, bibliography: rect("#bibliography"), takeaway: rect("#one-sentence-takeaway"), question: rect("#research-question"), explorer: rect(".sidebar.left .explorer"), toc: rect(".sidebar.right .toc"), explorerRoutes: readable(".sidebar.left .explorer a[href]"), tocSections: readable(".sidebar.right .toc-content a[href^='#']"), typography: { fontFamily: bodyStyle.fontFamily, fontSize: parseFloat(bodyStyle.fontSize), lineHeight: parseFloat(bodyStyle.lineHeight), cjkRect }, controls: { tocHeading: document.querySelector("button.toc-header h3")?.textContent.trim(), explorerHeading: document.querySelector(".explorer > h2.desktop-explorer")?.textContent.trim(), explorerFocus: focus(".explorer a[href]"), tocFocus: focus("button.toc-header") } }
  }`)
  assert.equal(desktop.slug, "papers/synthetic-paper/index")
  assert.equal(desktop.template, "paper")
  for (const section of [desktop.bibliography, desktop.takeaway, desktop.question]) assert.ok(section && section.top >= 0 && section.height > 0 && section.bottom < 1100 && section.display !== "none" && section.visibility !== "hidden" && section.opacity !== "0", JSON.stringify(section))
  assert.ok(desktop.typography.lineHeight / desktop.typography.fontSize >= 1.75, JSON.stringify(desktop.typography))
  assert.match(desktop.typography.fontFamily, /Georgia/)
  assert.match(desktop.typography.fontFamily, /Noto Serif CJK TC/)
  assert.ok(desktop.typography.cjkRect?.width > 0 && desktop.typography.cjkRect?.height > 0, JSON.stringify(desktop.typography.cjkRect))
  assert.equal(desktop.controls.tocHeading, "Table of Contents")
  assert.equal(desktop.controls.explorerHeading, "Library")
  for (const control of [desktop.controls.explorerFocus, desktop.controls.tocFocus]) assert.ok(control.active && control.style !== "none" && control.width >= 3, JSON.stringify(control))
  assert.ok(desktop.explorer?.width > 0)
  assert.ok(desktop.toc?.width > 0)
  assert.deepEqual(desktop.explorerRoutes.map((entry) => entry.text), ["Synthetic Paper", "Synthetic Support"])
  assert.ok(desktop.explorerRoutes.every((entry) => entry.left >= 0 && entry.right <= 1440), JSON.stringify(desktop.explorerRoutes))
  assert.ok(desktop.tocSections.some((entry) => entry.text === "Bibliography"), JSON.stringify(desktop.tocSections))
  assert.ok(desktop.tocSections.every((entry) => entry.left >= 0 && entry.right <= 1440), JSON.stringify(desktop.tocSections))
  assert.ok(desktop.tocSections.every((entry) => ["rgb(32, 29, 26)", "rgb(63, 58, 52)"].includes(entry.color)), JSON.stringify(desktop.tocSections))
  assert.ok(desktop.tocSections.every((entry) => entry.opacity === "1"), JSON.stringify(desktop.tocSections))
  assert.deepEqual(await browserArchitecture(), { explorer: 1, search: 1, graph: 1, graphScopes: ["local"], backlinks: 1, externalResources: [] })
  await capturePage(session, "t04-desktop-1440x1100.png")

  await cdpNavigate(session, "/knowledge/concept/synthetic-support/", 1440, 1100)
  const supportTemplate = await cdpValue(session, `() => ({ slug: document.body.dataset.slug, template: document.body.dataset.tracerTemplate, hasPaperMasthead: Boolean(document.querySelector("#bibliography")) })`)
  assert.deepEqual(supportTemplate, { slug: "knowledge/concept/synthetic-support/index", template: "support", hasPaperMasthead: false })
  assert.deepEqual(await browserArchitecture(), { explorer: 1, search: 1, graph: 1, graphScopes: ["local"], backlinks: 1, externalResources: [] })

  await cdpNavigate(session, "/", 390, 844)
  assert.equal(await cdpValue(session, `() => location.pathname`), "/")
  await cdpNavigate(session, "/papers/synthetic-paper/", 390, 844)
  const mobile = await cdpValue(session, `async () => {
    const measure = (selector) => { const element = document.querySelector(selector), rect = element?.getBoundingClientRect(), style = element && getComputedStyle(element); return element && { width: rect.width, height: rect.height, display: style.display, visibility: style.visibility } }
    const rawBox = element => { const rect = element.getBoundingClientRect(), style = getComputedStyle(element); return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, overflowX: style.overflowX, bounds: { left: rect.left, right: rect.right, width: rect.width } } }
    const explorerButton = document.querySelector(".explorer-toggle.mobile-explorer"), tocButton = document.querySelector("button.toc-header"), explorer = document.querySelector(".explorer")
    const explorerContent = explorerButton && document.getElementById(explorerButton.getAttribute("aria-controls")), tocContent = tocButton && document.getElementById(tocButton.getAttribute("aria-controls")), table = document.querySelector("article table"), tableWrapper = table?.closest(".table-container")
    const missing = [["explorerButton", explorerButton], ["explorer", explorer], ["explorerContent", explorerContent], ["tocButton", tocButton], ["tocContent", tocContent], ["table", table], ["tableWrapper", tableWrapper]].filter(([, value]) => !value).map(([name]) => name)
    if (missing.length) return { missing, diagnostics: { tocButton: tocButton?.outerHTML, tocParent: tocButton?.parentElement?.outerHTML } }
    explorerButton.focus(); const explorerFocused = document.activeElement === explorerButton; explorerButton.click(); await new Promise(resolve => setTimeout(resolve, 300))
    const linkTargets = root => [...root.querySelectorAll("a[href]")].map(anchor => { const rect = anchor.getBoundingClientRect(), style = getComputedStyle(anchor); return { text: anchor.textContent.trim(), href: anchor.getAttribute("href"), width: rect.width, height: rect.height, display: style.display, visibility: style.visibility } }).filter(item => item.width > 0 && item.height > 0 && item.display !== "none" && item.visibility !== "hidden")
    const explorerState = { buttonExpanded: explorerButton.getAttribute("aria-expanded"), contentExpanded: explorerContent.getAttribute("aria-expanded"), explorerClass: explorer.className, style: explorerContent.getAttribute("style"), display: getComputedStyle(explorerContent).display, visibility: getComputedStyle(explorerContent).visibility, transform: getComputedStyle(explorerContent).transform, hrefs: [...explorerContent.querySelectorAll("a[href]")].map((anchor) => anchor.getAttribute("href")), labels: [...explorerContent.querySelectorAll("a[href]")].map((anchor) => anchor.textContent.trim()), targets: linkTargets(explorerContent) }
    const explorerOpen = explorerState.buttonExpanded === "true" && explorerState.contentExpanded === "true" && explorerState.visibility === "visible" && explorerState.hrefs.includes("/papers/synthetic-paper/")
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await new Promise(resolve => setTimeout(resolve, 10)); const explorerEscaped = explorerButton.getAttribute("aria-expanded") === "false" && explorerContent.getAttribute("aria-expanded") === "false" && document.activeElement === explorerButton; const explorerClosedDisplay = getComputedStyle(explorerContent).display
    tocButton.focus(); const tocFocused = document.activeElement === tocButton; tocButton.click(); await new Promise(resolve => setTimeout(resolve, 10))
    const tocState = { buttonExpanded: tocButton.getAttribute("aria-expanded"), buttonClass: tocButton.className, contentClass: tocContent.className, display: getComputedStyle(tocContent).display, visibility: getComputedStyle(tocContent).visibility, entries: [...tocContent.querySelectorAll("a[href]")].map(item => { const rect = item.getBoundingClientRect(), style = getComputedStyle(item); return { text: item.textContent.trim(), width: rect.width, height: rect.height, left: rect.left, right: rect.right, opacity: style.opacity, color: style.color, display: style.display, visibility: style.visibility } }).filter(item => item.width > 0 && item.height > 0 && item.display !== "none" && item.visibility !== "hidden") }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await new Promise(resolve => setTimeout(resolve, 10))
    const tocEscaped = tocButton.getAttribute("aria-expanded") === "false" && tocContent.classList.contains("collapsed") && getComputedStyle(tocContent).display === "none" && document.activeElement === tocButton
    const closedTocDrawer = document.querySelector(".sidebar.right").getBoundingClientRect()
    return { missing, explorerState, explorerEscaped, explorerClosedDisplay, overflow: document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth, explorerButton: measure(".explorer-toggle.mobile-explorer"), tocButton: measure("button.toc-header"), explorerFocused, explorerOpen, tocFocused, tocState, tocOpen: tocState.buttonExpanded === "true" && tocState.display !== "none", tocEscaped, closedTocDrawer: { width: closedTocDrawer.width, height: closedTocDrawer.height }, tableRaw: { wrapper: rawBox(tableWrapper), table: rawBox(table) } }
  }`)
  assert.deepEqual(mobile.missing, [], JSON.stringify(mobile.diagnostics))
  assert.equal(mobile.overflow, true)
  for (const control of [mobile.explorerButton, mobile.tocButton]) {
    assert.ok(control.width >= 44 && control.height >= 44)
    assert.notEqual(control.display, "none")
    assert.notEqual(control.visibility, "hidden")
  }
  assert.equal(mobile.explorerFocused, true)
  assert.equal(mobile.explorerOpen, true, JSON.stringify(mobile.explorerState))
  assert.deepEqual(mobile.explorerState.labels, ["Synthetic Paper", "Synthetic Support"])
  assert.equal(mobile.explorerState.labels.includes("Paper") || mobile.explorerState.labels.includes("Support"), false)
  assert.equal(mobile.explorerState.targets.length, 2, JSON.stringify(mobile.explorerState.targets))
  assert.ok(mobile.explorerState.targets.every((target) => target.height >= 44), JSON.stringify(mobile.explorerState.targets))
  assert.equal(mobile.explorerEscaped, true)
  assert.equal(mobile.explorerClosedDisplay, "none")
  assert.equal(mobile.tocFocused, true)
  assert.equal(mobile.tocOpen, true, JSON.stringify(mobile.tocState))
  assert.ok(mobile.tocState.entries.some((entry) => entry.text === "Bibliography" && entry.width > 0 && entry.height > 0 && entry.left >= 0 && entry.right <= 390), JSON.stringify(mobile.tocState.entries))
  assert.ok(mobile.tocState.entries.every((entry) => entry.opacity === "1"), JSON.stringify(mobile.tocState.entries))
  assert.ok(mobile.tocState.entries.every((entry) => ["rgb(32, 29, 26)", "rgb(63, 58, 52)"].includes(entry.color)), JSON.stringify(mobile.tocState.entries))
  assert.ok(mobile.tocState.entries.every((entry) => entry.height >= 44), JSON.stringify(mobile.tocState.entries))
  assert.equal(mobile.tocEscaped, true)
  assert.ok(mobile.closedTocDrawer.width <= 44 && mobile.closedTocDrawer.height <= 44, JSON.stringify(mobile.closedTocDrawer))
  assert.equal(mobile.tableRaw.wrapper.overflowX, "auto", JSON.stringify(mobile.tableRaw))
  assert.ok(mobile.tableRaw.wrapper.bounds.left >= 0 && mobile.tableRaw.wrapper.bounds.right <= 390, JSON.stringify(mobile.tableRaw))
  const tableOverflowsWrapper = mobile.tableRaw.wrapper.scrollWidth > mobile.tableRaw.wrapper.clientWidth
  if (tableOverflowsWrapper) {
    assert.ok(mobile.tableRaw.wrapper.scrollWidth >= mobile.tableRaw.table.scrollWidth, JSON.stringify(mobile.tableRaw))
  } else {
    assert.ok(mobile.tableRaw.table.bounds.left >= mobile.tableRaw.wrapper.bounds.left && mobile.tableRaw.table.bounds.right <= mobile.tableRaw.wrapper.bounds.right + 1, JSON.stringify(mobile.tableRaw))
  }
  await cdpValue(session, `async () => { const toc = document.querySelector("button.toc-header"); toc.click(); await new Promise(resolve => setTimeout(resolve, 10)); return true }`)
  await capturePage(session, "t04-mobile-toc-390x844.png")
  if (process.env.TYLER_TRACER_CAPTURE_DIR) {
    await cdpValue(session, `async () => { const toc = document.querySelector("button.toc-header"), explorer = document.querySelector(".explorer-toggle.mobile-explorer"); if (toc?.getAttribute("aria-expanded") === "true") toc.click(); explorer?.click(); await new Promise(resolve => setTimeout(resolve, 300)); return true }`)
    await capturePage(session, "t04-mobile-explorer-390x844.png")
  }

  await session.client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] })
  const reduced = await cdpValue(session, `() => ({ transition: getComputedStyle(document.querySelector(".explorer-content")).transitionDuration, scroll: getComputedStyle(document.documentElement).scrollBehavior })`)
  assert.match(reduced.transition, /^(?:0s(?:, 0s)*)$/)
  assert.equal(reduced.scroll, "auto")
  const explorerNavigationLoaded = session.client.once("Page.loadEventFired", () => true)
  await cdpValue(session, `() => {
    const button = document.querySelector(".explorer-toggle.mobile-explorer")
    if (button?.getAttribute("aria-expanded") !== "true") button?.click()
    const link = document.querySelector('.explorer a[data-public-id="synthetic-support"]')
    if (!link) throw new Error("support Explorer link missing")
    setTimeout(() => link.click(), 0)
    return true
  }`)
  await explorerNavigationLoaded
  const explorerNavigation = await cdpValue(session, `() => ({ pathname: location.pathname, template: document.body.dataset.tracerTemplate, title: document.querySelector("article h1")?.textContent.trim() })`)
  assert.deepEqual(explorerNavigation, { pathname: "/knowledge/concept/synthetic-support/", template: "support", title: "Synthetic Support" })
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.deepEqual(browserErrors, [])
  const cleanup = await session.close()
  assert.deepEqual(cleanup, { pid: session.edgePid, exited: true, profileRemoved: true })
  t.diagnostic(`Chromium cleanup ${JSON.stringify(cleanup)}`)
})
