// @ts-nocheck -- public CLI fixtures intentionally use dynamic temporary roots.
import assert from "node:assert/strict"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

const repoRoot = path.resolve(import.meta.dirname, "..")
const cli = path.join(repoRoot, "scripts", "prepare-gh-pages-commit.mjs")

const mappedRoutes = [
  "/",
  "/papers/guo-2024-benchmarking-micro-action-recognition/",
  "/papers/jackman-2021-flow-clutch-recreational-running/",
  "/knowledge/author/patricia-c-jackman/",
  "/knowledge/concept/flow/",
  "/knowledge/concept/micro-action/",
  "/knowledge/method/connecting-analysis/",
  "/knowledge/method/event-focused-interview/",
  "/knowledge/method/thematic-analysis/",
  "/knowledge/task/action-recognition/",
]

function routeFile(route) {
  return route === "/" ? "index.html" : `${route.slice(1)}index.html`
}

async function put(root, relative, bytes) {
  const absolute = path.join(root, ...relative.split("/"))
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, bytes)
}

async function snapshot(root, relative = "") {
  const directory = path.join(root, ...relative ? relative.split("/") : [])
  const entries = await readdir(directory, { withFileTypes: true })
  const result = new Map()
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      for (const [name, bytes] of await snapshot(root, child)) result.set(name, bytes)
    } else {
      assert.equal(entry.isFile(), true, `fixture entry must be regular: ${child}`)
      result.set(child, await readFile(path.join(root, ...child.split("/"))))
    }
  }
  return result
}

async function exists(absolute) {
  try {
    await lstat(absolute)
    return true
  } catch {
    return false
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-handoff-red-"))
  const built = path.join(root, "built")
  const baseline = path.join(root, "baseline")
  const output = path.join(root, "preview")
  await Promise.all([mkdir(built), mkdir(baseline)])
  for (const route of mappedRoutes) {
    const relative = routeFile(route)
    const bytes = Buffer.from(`<html><body data-route="${route}"></body></html>\n`)
    await put(built, relative, bytes)
    await put(baseline, relative, bytes)
  }
  await put(built, "404.html", Buffer.from("<html><body>Quartz 404</body></html>\n"))
  await put(baseline, "404.html", Buffer.from("<html><body>Quartz 404</body></html>\n"))
  await put(built, "changed.txt", Buffer.from("candidate\n"))
  await put(baseline, "changed.txt", Buffer.from("baseline\n"))
  await put(built, "only-built.txt", Buffer.from("added\n"))
  await put(baseline, "only-baseline.txt", Buffer.from("deleted\n"))
  await put(baseline, ".nojekyll", Buffer.alloc(0))
  return { root, built, baseline, output }
}

function invoke(paths) {
  return spawnSync(process.execPath, [
    cli,
    "--built-site", paths.built,
    "--baseline-site", paths.baseline,
    "--output", paths.output,
  ], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 })
}

const expectedProof = mappedRoutes.map((route) => ({ route, file: routeFile(route) }))

test("local handoff copies the generated site, adds empty .nojekyll, and reports mapped route plus byte diffs", async () => {
  const paths = await fixture()
  try {
    const baselineBefore = await snapshot(paths.baseline)
    const result = invoke(paths)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stderr, "")
    const output = JSON.parse(result.stdout)
    assert.deepEqual(output, {
      ok: true,
      command: "prepare-gh-pages-commit",
      previewRoot: path.join(paths.output, "site"),
      routeProof: { count: 10, routes: expectedProof, missing: [] },
      routeDiff: {
        added: [],
        deleted: [],
        unchanged: mappedRoutes,
      },
      diff: {
        added: ["only-built.txt"],
        deleted: ["only-baseline.txt"],
        changed: ["changed.txt"],
        unchanged: [
          ".nojekyll",
          "404.html",
          "index.html",
          "knowledge/author/patricia-c-jackman/index.html",
          "knowledge/concept/flow/index.html",
          "knowledge/concept/micro-action/index.html",
          "knowledge/method/connecting-analysis/index.html",
          "knowledge/method/event-focused-interview/index.html",
          "knowledge/method/thematic-analysis/index.html",
          "knowledge/task/action-recognition/index.html",
          "papers/guo-2024-benchmarking-micro-action-recognition/index.html",
          "papers/jackman-2021-flow-clutch-recreational-running/index.html",
        ],
      },
    })
    assert.equal((await readFile(path.join(paths.output, "site", ".nojekyll"))).length, 0)
    assert.deepEqual(await readFile(path.join(paths.output, "site", "404.html")), await readFile(path.join(paths.built, "404.html")))
    assert.equal(await exists(path.join(paths.output, "site", "only-baseline.txt")), false)
    assert.equal(await exists(path.join(paths.output, "site", "only-built.txt")), true)
    assert.deepEqual(await snapshot(paths.baseline), baselineBefore)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("local handoff fails before finalizing output when a mapped route is absent", async () => {
  const paths = await fixture()
  try {
    const missing = routeFile(mappedRoutes[3])
    await rm(path.join(paths.built, ...missing.split("/")))
    const baselineBefore = await snapshot(paths.baseline)
    const result = invoke(paths)
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stderr, "")
    const output = JSON.parse(result.stdout)
    assert.deepEqual(output.error, {
      code: "HANDOFF_MAPPED_ROUTE_MISSING",
      message: "generated site is missing one or more mapped routes",
      missingRoutes: [mappedRoutes[3]],
    })
    assert.equal(result.stdout.includes(paths.root), false)
    assert.equal(await exists(paths.output), false)
    assert.deepEqual(await snapshot(paths.baseline), baselineBefore)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("local handoff rejects overlapping roots without creating a preview", async () => {
  const paths = await fixture()
  try {
    const result = spawnSync(process.execPath, [
      cli,
      "--built-site", paths.built,
      "--baseline-site", paths.baseline,
      "--output", path.join(paths.built, "preview"),
    ], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 })
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stderr, "")
    assert.deepEqual(JSON.parse(result.stdout).error, {
      code: "HANDOFF_PATH_OVERLAP",
      message: "handoff roots must be disjoint",
    })
    assert.equal(await exists(path.join(paths.built, "preview")), false)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})
