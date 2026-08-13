// @ts-nocheck -- public CLI fixtures intentionally use dynamic temporary roots.
import assert from "node:assert/strict"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

import { prepare, readMappedRoutes } from "../scripts/prepare-gh-pages-commit.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const cli = path.join(repoRoot, "scripts", "prepare-gh-pages-commit.mjs")
const mappedRoutes = (await readMappedRoutes()).map(({ route }) => route)
assert.ok(mappedRoutes.length > 1)

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
  for (const [relative, bytes] of [
    ["safe/site.css", Buffer.from("body { color: black; }\n")],
    ["safe/site.js", Buffer.from("window.safeAsset = true\n")],
    ["safe/data.json", Buffer.from('{"safe":true}\n')],
    ["safe/icon.png", Buffer.from([0, 1, 2, 3])],
  ]) {
    await put(built, relative, bytes)
    await put(baseline, relative, bytes)
  }
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

/** @param {{built:string,baseline:string,output:string}} paths @param {string} contentMap */
function invokeWithMap(paths, contentMap) {
  return spawnSync(process.execPath, [
    cli,
    "--built-site", paths.built,
    "--baseline-site", paths.baseline,
    "--output", paths.output,
    "--content-map", contentMap,
  ], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 })
}

const expectedProof = mappedRoutes.map((route) => ({ route, file: routeFile(route) }))
const expectedUnchangedFiles = [
  ".nojekyll",
  "404.html",
  ...mappedRoutes.map(routeFile),
  "safe/data.json",
  "safe/icon.png",
  "safe/site.css",
  "safe/site.js",
].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))

test("local handoff consumes injected immutable map bytes without rereading a mutable path", async () => {
  const paths = await fixture()
  const poisonedMap = path.join(paths.root, "poisoned-map.yml")
  const frozenMapBytes = await readFile(path.join(repoRoot, "site-content.yml"))
  await writeFile(poisonedMap, "pages:\n  - source: ../poison.md\n")
  try {
    const result = await prepare({
      builtSite: paths.built,
      baselineSite: paths.baseline,
      output: paths.output,
      contentMap: poisonedMap,
      contentMapBytes: frozenMapBytes,
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.routeProof, { count: expectedProof.length, routes: expectedProof, missing: [] })
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("local handoff uses strict shared map structure without requiring Vault sources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-handoff-map-schema-"))
  const map = path.join(root, "map.yml")
  const cases = [
    ["malformed source", `version: 1\npages:\n  - source: ../escape.md\n    route: /knowledge/concept/flow/\n    layout: support`],
    ["unsupported layout", `version: 1\npages:\n  - source: Missing.md\n    route: /knowledge/concept/flow/\n    layout: unknown`],
    ["unsupported version", `version: 2\npages:\n  - source: Missing.md\n    route: /knowledge/concept/flow/\n    layout: support`],
    ["extra page field", `version: 1\npages:\n  - source: Missing.md\n    route: /knowledge/concept/flow/\n    layout: support\n    extra: rejected`],
    ["missing page field", `version: 1\npages:\n  - source: Missing.md\n    route: /knowledge/concept/flow/`],
  ]
  const paths = await fixture()
  try {
    for (const [name, bytes] of cases) {
      await writeFile(map, bytes)
      const result = invokeWithMap(paths, map)
      assert.equal(result.status, 1, `${name}: ${result.stdout}\n${result.stderr}`)
      assert.equal(result.stderr, "", name)
      assert.deepEqual(JSON.parse(result.stdout).error, {
        code: "HANDOFF_CONTENT_MAP_INVALID",
        message: "site-content.yml contains an invalid content-map structure",
      }, name)
      assert.equal(await exists(paths.output), false, name)
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

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
      routeProof: { count: expectedProof.length, routes: expectedProof, missing: [] },
      routeDiff: {
        added: [],
        deleted: [],
        unchanged: mappedRoutes,
      },
      diff: {
        added: ["only-built.txt"],
        deleted: ["only-baseline.txt"],
        changed: ["changed.txt"],
        unchanged: expectedUnchangedFiles,
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

test("local handoff rejects link ancestors for built, baseline, and output before any write", async () => {
  const paths = await fixture()
  const targetBefore = await snapshot(paths.root)
  const linkedParent = await mkdtemp(path.join(os.tmpdir(), "tyrs-handoff-link-parent-"))
  const linkedRoot = path.join(linkedParent, "linked-root")
  await symlink(paths.root, linkedRoot, process.platform === "win32" ? "junction" : "dir")
  try {
    for (const [role, invocation] of [
      ["built", { built: path.join(linkedRoot, "built"), baseline: paths.baseline, output: paths.output }],
      ["baseline", { built: paths.built, baseline: path.join(linkedRoot, "baseline"), output: path.join(paths.root, "preview-baseline") }],
      ["output", { built: paths.built, baseline: paths.baseline, output: path.join(linkedRoot, "preview-output") }],
    ]) {
      const result = invoke(invocation)
      assert.equal(result.status, 1, `${role}: ${result.stdout}\n${result.stderr}`)
      assert.equal(result.stderr, "")
      const failure = JSON.parse(result.stdout).error
      assert.equal(failure.code, `HANDOFF_${role.toUpperCase()}_ROOT_INVALID`, role)
      assert.equal(await exists(invocation.output), false, `${role}: output must remain absent`)
    }
    assert.deepEqual(await snapshot(paths.root), targetBefore)
  } finally {
    await rm(linkedParent, { recursive: true, force: true })
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("local handoff rejects private Markdown and extra HTML before finalizing output", async () => {
  const paths = await fixture()
  try {
    await put(paths.built, "private.md", Buffer.from("private\n"))
    await put(paths.built, "extra.html", Buffer.from("<html>extra</html>\n"))
    const result = invoke(paths)
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stderr, "")
    assert.deepEqual(JSON.parse(result.stdout).error, {
      code: "HANDOFF_OUTPUT_CLASS_INVALID",
      message: "generated site contains a disallowed public file",
    })
    assert.equal(await exists(paths.output), false)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("local handoff rejects PDFs, publication paths, and hidden metadata except empty root .nojekyll", async () => {
  for (const relative of ["private.markdown", "private.pdf", ".publication/receipt.json", ".DS_Store", "nested/.hidden.json", "nested/.nojekyll"]) {
    const paths = await fixture()
    try {
      await put(paths.built, relative, Buffer.from("disallowed\n"))
      const result = invoke(paths)
      assert.equal(result.status, 1, `${relative}: ${result.stdout}\n${result.stderr}`)
      assert.equal(result.stderr, "")
      assert.deepEqual(JSON.parse(result.stdout).error, {
        code: "HANDOFF_OUTPUT_CLASS_INVALID",
        message: "generated site contains a disallowed public file",
      }, relative)
      assert.equal(await exists(paths.output), false, `${relative}: output must remain absent`)
    } finally {
      await rm(paths.root, { recursive: true, force: true })
    }
  }
})

test("local handoff does not bind mapped route parsing to a fixed page count", async () => {
  const source = await readFile(cli, "utf8")
  assert.doesNotMatch(source, /approvedSitePageCount/)
  assert.equal((await readMappedRoutes()).length, mappedRoutes.length)
})
