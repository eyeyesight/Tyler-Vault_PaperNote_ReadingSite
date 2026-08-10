// @ts-nocheck -- headless QA fixtures intentionally inject browser/process test doubles.
import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { EventEmitter } from "node:events"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  classifyVisualDiff,
  runHeadlessSiteQa,
  runHeadlessSiteQaForTest,
  SiteHeadlessQaError,
} from "../lib/site-headless-qa.mjs"

async function put(root, relative, contents) {
  const absolute = path.join(root, ...relative.split("/"))
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, contents)
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyrs-site-qa-red-"))
  const siteRoot = path.join(root, "site")
  await mkdir(siteRoot)
  await put(siteRoot, "index.html", `<!doctype html>
<html><head>
<link rel="stylesheet" href="/project/assets/app.css">
<script type="module" src="./assets/app.js"></script>
</head><body><h1>home</h1></body></html>`)
  await put(siteRoot, "papers/alpha/index.html", `<!doctype html><html><head><link rel="stylesheet" href="../../assets/app.css"></head><body><h1>paper alpha</h1></body></html>`)
  await put(siteRoot, "papers/zeta/index.html", "<!doctype html><html><body><h1>paper zeta</h1></body></html>")
  await put(siteRoot, "knowledge/concept/alpha/index.html", "<!doctype html><html><body><h1>knowledge alpha</h1></body></html>")
  await put(siteRoot, "knowledge/concept/zeta/index.html", "<!doctype html><html><body><h1>knowledge zeta</h1></body></html>")
  await put(siteRoot, "assets/app.css", "body { color: black; }\n")
  await put(siteRoot, "assets/app.js", "window.siteQaFixture = true\n")
  await put(siteRoot, "404.html", "<!doctype html><html><body><h1>custom qa 404</h1></body></html>")
  return { root, siteRoot }
}

const mappedRoutes = [
  { route: "/papers/zeta/", file: "papers/zeta/index.html" },
  { route: "/knowledge/concept/zeta/", file: "knowledge/concept/zeta/index.html" },
  { route: "/papers/alpha/", file: "papers/alpha/index.html" },
  { route: "/knowledge/concept/alpha/", file: "knowledge/concept/alpha/index.html" },
]

test("local QA serves sorted mapped routes, loopback assets, and custom 404 without ordinary screenshots", async () => {
  const paths = await fixture()
  const visited = []
  let profileDirectory = ""
  try {
    const result = await runHeadlessSiteQaForTest({
      siteRoot: paths.siteRoot,
      basePath: "/project/",
      routes: mappedRoutes,
      sourceDiff: { changedFiles: ["docs/README.md"] },
    }, {
      browserRunner: async (context) => {
        profileDirectory = context.profileDirectory
        visited.push(...context.visitUrls)
        assert.equal(context.captureScreenshots, false)
        assert.deepEqual(context.screenshotRoutes, [])
        const responses = await Promise.all(context.visitUrls.map(async (url) => {
          const response = await fetch(url)
          return { url, status: response.status, dom: await response.text() }
        }))
        return { ok: true, pages: responses }
      },
    })

    assert.equal(result.status, "pass")
    assert.deepEqual(result.routes, [
      "/",
      "/knowledge/concept/alpha/",
      "/knowledge/concept/zeta/",
      "/papers/alpha/",
      "/papers/zeta/",
    ])
    assert.deepEqual(result.representative_routes, {
      paper: "/papers/alpha/",
      knowledge: "/knowledge/concept/alpha/",
    })
    assert.equal(result.screenshot_required, false)
    assert.deepEqual(result.screenshots, [])
    assert.equal(result.error_code, null)
    assert.equal(visited.length, 6)
    assert.equal(visited.at(-1).endsWith("/__t13_qa_not_found__/"), true)
    await assert.rejects(access(profileDirectory))
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("visual diff classification is pure and triggers every visual source class plus anomalies", () => {
  const cases = [
    ["css", "styles/site.css"],
    ["theme", "theme/tokens.js"],
    ["template", "templates/paper.html"],
    ["layout", "layouts/paper.mjs"],
    ["component", "components/card.mjs"],
  ]
  for (const [reason, file] of cases) {
    const result = classifyVisualDiff({ changedFiles: [file] })
    assert.equal(result.required, true, reason)
    assert.equal(result.reasons.includes(reason), true, reason)
  }
  assert.equal(classifyVisualDiff({ changedFiles: ["docs/README.md"] }).required, false)
  assert.equal(classifyVisualDiff({ changedFiles: ["docs/README.md"] }, true).required, true)
})

test("visual source changes capture only the deterministic paper and knowledge representatives", async () => {
  const paths = await fixture()
  const calls = []
  try {
    const result = await runHeadlessSiteQaForTest({
      siteRoot: paths.siteRoot,
      basePath: "/project/",
      routes: mappedRoutes,
      sourceDiff: { changedFiles: ["components/card.mjs"] },
    }, {
      browserRunner: async (context) => {
        calls.push({ capture: context.captureScreenshots, routes: [...context.screenshotRoutes] })
        return {
          ok: true,
          pages: context.visitUrls.map((url) => ({ url, dom: "<html><body>fixture</body></html>" })),
          screenshots: context.screenshotRoutes.map((route) => ({ route, bytes: Buffer.from(`PNG:${route}`) })),
        }
      },
    })
    assert.equal(result.status, "pass")
    assert.equal(result.screenshot_required, true)
    assert.deepEqual(calls, [{
      capture: true,
      routes: ["/papers/alpha/", "/knowledge/concept/alpha/"],
    }])
    assert.deepEqual(result.screenshots.map(({ route }) => route), ["/papers/alpha/", "/knowledge/concept/alpha/"])
    assert.deepEqual(result.screenshots.map(({ bytes }) => bytes.toString()), ["PNG:/papers/alpha/", "PNG:/knowledge/concept/alpha/"])
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("a QA anomaly causes one bounded representative screenshot pass after ordinary browser visits", async () => {
  const paths = await fixture()
  const calls = []
  try {
    const result = await runHeadlessSiteQaForTest({
      siteRoot: paths.siteRoot,
      basePath: "/project/",
      routes: mappedRoutes,
      sourceDiff: { changedFiles: ["docs/README.md"] },
    }, {
      browserRunner: async (context) => {
        calls.push(context.captureScreenshots)
        return {
          ok: true,
          pages: context.visitUrls.map((url) => ({ url, dom: "<html><body>fixture</body></html>" })),
          anomalies: calls.length === 1 ? [{ code: "DOM_MARKER_MISSING" }] : [],
          screenshots: context.screenshotRoutes.map((route) => ({ route, bytes: Buffer.from("anomalous-png") })),
        }
      },
    })
    assert.equal(result.status, "pass")
    assert.equal(result.screenshot_required, true)
    assert.deepEqual(calls, [false, true])
    assert.equal(result.screenshots.length, 2)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("browser failures and timeouts return stable redacted codes and clean the owned profile", async () => {
  for (const [name, runner, expected] of [
    ["failure", async () => { throw new Error("raw stderr C:\\private\\fixture") }, "QA_BROWSER_FAILED"],
    ["timeout", () => new Promise(() => {}), "QA_BROWSER_TIMEOUT"],
  ]) {
    const paths = await fixture()
    let profileDirectory = ""
    try {
      const result = await runHeadlessSiteQaForTest({
        siteRoot: paths.siteRoot,
        basePath: "/project/",
        routes: mappedRoutes,
        timeoutMs: name === "timeout" ? 25 : 1_000,
      }, {
        browserRunner: async (context) => {
          profileDirectory = context.profileDirectory
          return runner(context)
        },
      })
      assert.equal(result.status, "fail", name)
      assert.equal(result.error_code, expected, name)
      assert.equal(JSON.stringify(result).includes(paths.root), false, name)
      assert.equal(JSON.stringify(result).includes("raw stderr"), false, name)
      await assert.rejects(access(profileDirectory), name)
    } finally {
      await rm(paths.root, { recursive: true, force: true })
    }
  }
})

test("profile replacement is rejected by the identity claim and leaves the replacement sentinel", async () => {
  const paths = await fixture()
  let profileDirectory = ""
  let sentinel = ""
  try {
    const result = await runHeadlessSiteQaForTest({
      siteRoot: paths.siteRoot,
      basePath: "/project/",
      routes: mappedRoutes,
    }, {
      browserRunner: async (context) => {
        profileDirectory = context.profileDirectory
        return {
          ok: true,
          pages: context.visitUrls.map((url) => ({ url, dom: "<html><body>fixture</body></html>" })),
        }
      },
      removeTempProfile: async (profile) => {
        await rm(profile, { recursive: true, force: true })
        await mkdir(profile)
        sentinel = path.join(profile, "replacement-sentinel.txt")
        await writeFile(sentinel, "must survive")
        return true
      },
    })

    assert.equal(result.status, "fail")
    assert.equal(result.error_code, "QA_PROFILE_CLEANUP_FAILED")
    assert.deepEqual(result.checks.at(-1), { name: "profile_cleanup", outcome: "fail" })
    assert.equal(JSON.stringify(result).includes(paths.root), false)
    await access(sentinel)
  } finally {
    if (profileDirectory) await rm(profileDirectory, { recursive: true, force: true })
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("profile cleanup failure takes precedence over browser failure and timeout without exposing paths", async () => {
  const browserCases = [
    ["failure", async () => { throw new Error("browser stderr C:\\\\private\\\\fixture") }, 1_000],
    ["timeout", () => new Promise(() => {}), 25],
  ]
  for (const [browserName, browserRunner, timeoutMs] of browserCases) {
    for (const cleanupMode of ["false", "throw"]) {
      const paths = await fixture()
      let profileDirectory = ""
      try {
        const result = await runHeadlessSiteQaForTest({
          siteRoot: paths.siteRoot,
          basePath: "/project/",
          routes: mappedRoutes,
          timeoutMs,
        }, {
          browserRunner: async (context) => {
            profileDirectory = context.profileDirectory
            return browserRunner(context)
          },
          removeTempProfile: async () => {
            if (cleanupMode === "throw") throw new Error(`cleanup C:\\\\private\\\\${paths.root}`)
            return false
          },
        })
        assert.equal(result.status, "fail", `${browserName}/${cleanupMode}`)
        assert.equal(result.error_code, "QA_PROFILE_CLEANUP_FAILED", `${browserName}/${cleanupMode}`)
        assert.deepEqual(result.checks.at(-1), { name: "profile_cleanup", outcome: "fail" }, `${browserName}/${cleanupMode}`)
        assert.equal(JSON.stringify(result).includes(paths.root), false, `${browserName}/${cleanupMode}`)
        assert.equal(JSON.stringify(result).includes("private"), false, `${browserName}/${cleanupMode}`)
      } finally {
        if (profileDirectory) await rm(profileDirectory, { recursive: true, force: true })
        await rm(paths.root, { recursive: true, force: true })
      }
    }
  }
})

test("CSS and JavaScript assets receive sorted loopback HTTP 200 readback before browser launch", async () => {
  const paths = await fixture()
  const readbacks = []
  let browserLaunched = false
  try {
    const result = await runHeadlessSiteQaForTest({
      siteRoot: paths.siteRoot,
      basePath: "/project/",
      routes: mappedRoutes,
    }, {
      readBack: async (url, expected, _timeoutMs, statusCode) => {
        const pathname = new URL(url).pathname
        readbacks.push({ pathname, expected, statusCode })
        return statusCode === "QA_ASSET_STATUS" && pathname.endsWith("/assets/app.js") ? false : true
      },
      browserRunner: async () => {
        browserLaunched = true
        return { ok: true }
      },
    })
    assert.equal(result.status, "fail")
    assert.equal(result.error_code, "QA_ASSET_STATUS")
    assert.equal(browserLaunched, false)
    assert.deepEqual(readbacks.filter(({ statusCode }) => statusCode === "QA_ASSET_STATUS"), [
      { pathname: "/project/assets/app.css", expected: 200, statusCode: "QA_ASSET_STATUS" },
      { pathname: "/project/assets/app.js", expected: 200, statusCode: "QA_ASSET_STATUS" },
    ])
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("listen failures return QA_SERVER_START_FAILED before browser launch", async () => {
  const cases = [
    ["sync generic", () => { throw new Error("EADDRINUSE private path") }],
    ["async wrong stable code", async () => { throw new SiteHeadlessQaError("QA_BROWSER_FAILED") }],
  ]
  for (const [label, listenLoopback] of cases) {
    const paths = await fixture()
    let browserLaunched = false
    let cleanupCalls = 0
    try {
      const result = await runHeadlessSiteQaForTest({
        siteRoot: paths.siteRoot,
        basePath: "/project/",
        routes: [],
      }, {
        listenLoopback,
        closeHttpServer: async () => { cleanupCalls += 1; return true },
        browserRunner: async () => {
          browserLaunched = true
          return { ok: true }
        },
      })
      assert.equal(result.status, "fail", label)
      assert.equal(result.error_code, "QA_SERVER_START_FAILED", label)
      assert.equal(browserLaunched, false, label)
      assert.equal(cleanupCalls, 1, label)
      assert.equal(JSON.stringify(result).includes(paths.root), false, label)
    } finally {
      await rm(paths.root, { recursive: true, force: true })
    }
  }
})

test("server cleanup failure remains visible after a listen failure", async () => {
  const paths = await fixture()
  try {
    const result = await runHeadlessSiteQaForTest({
      siteRoot: paths.siteRoot,
      basePath: "/project/",
      routes: [],
    }, {
      listenLoopback: async () => { throw new SiteHeadlessQaError("QA_BROWSER_FAILED") },
      closeHttpServer: async () => false,
      browserRunner: async () => { throw new Error("browser must not launch") },
    })
    assert.equal(result.status, "fail")
    assert.equal(result.error_code, "QA_SERVER_CLOSE_FAILED")
    assert.equal(JSON.stringify(result).includes(paths.root), false)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("server cleanup failure remains visible after a browser failure", async () => {
  const paths = await fixture()
  let profileDirectory = ""
  try {
    const result = await runHeadlessSiteQaForTest({
      siteRoot: paths.siteRoot,
      basePath: "/project/",
      routes: mappedRoutes,
    }, {
      browserRunner: async (context) => {
        profileDirectory = context.profileDirectory
        throw new Error("browser failure")
      },
      closeHttpServer: async (server) => {
        if (server.listening) {
          if (typeof server.closeAllConnections === "function") server.closeAllConnections()
          await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        }
        throw new Error("server cleanup failure")
      },
    })
    assert.equal(result.status, "fail")
    assert.equal(result.error_code, "QA_SERVER_CLOSE_FAILED")
    assert.deepEqual(result.checks.at(-1), { name: "server_cleanup", outcome: "fail" })
    assert.equal(JSON.stringify(result).includes(paths.root), false)
    await assert.rejects(access(profileDirectory))
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("failed own-PID termination returns a stable redacted code for timeout and output overflow", async () => {
  const cases = [
    ["timeout", 25, 128 * 1024, () => {
      const child = new EventEmitter()
      child.pid = 5252
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      return child
    }],
    ["output", 500, 1, () => {
      const child = new EventEmitter()
      child.pid = 6363
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("overflow"))
        child.emit("close", 0, null)
      })
      return child
    }],
  ]
  for (const [name, timeoutMs, maxOutputBytes, spawn] of cases) {
    const paths = await fixture()
    const taskkills = []
    try {
      const result = await runHeadlessSiteQaForTest({
        siteRoot: paths.siteRoot,
        basePath: "/project/",
        routes: [],
        timeoutMs,
        maxOutputBytes,
      }, {
        platform: "win32",
        browserExecutable: "fixture-browser",
        spawn,
        execFile: (file, args, options, callback) => {
          taskkills.push({ file, args, options })
          callback(new Error(`taskkill C:\\\\private\\\\${paths.root}`))
        },
      })
      assert.equal(result.status, "fail", name)
      assert.equal(result.error_code, "QA_BROWSER_TERMINATION_FAILED", name)
      assert.deepEqual(result.checks.at(-1), { name: "browser_termination", outcome: "fail" }, name)
      assert.deepEqual(taskkills, [{
        file: "taskkill",
        args: ["/PID", name === "timeout" ? "5252" : "6363", "/T", "/F"],
        options: { windowsHide: true },
      }], name)
      assert.equal(JSON.stringify(result).includes(paths.root), false, name)
      assert.equal(JSON.stringify(result).includes("taskkill"), false, name)
    } finally {
      await rm(paths.root, { recursive: true, force: true })
    }
  }
})

test("external, protocol-relative, traversal, encoded-escape, and missing HTML assets fail closed", async () => {
  const cases = [
    ["https://cdn.invalid/app.css", "QA_ASSET_EXTERNAL"],
    ["//cdn.invalid/app.css", "QA_ASSET_PROTOCOL_RELATIVE"],
    ["../../outside.css", "QA_ASSET_TRAVERSAL"],
    ["%2e%2e/outside.css", "QA_ASSET_ENCODED_ESCAPE"],
    ["/project/assets/missing.css", "QA_ASSET_MISSING"],
  ]
  for (const [reference, expected] of cases) {
    const paths = await fixture()
    try {
      await writeFile(path.join(paths.siteRoot, "index.html"), `<!doctype html><html><head><link rel="stylesheet" href="${reference}"></head><body></body></html>`)
      const result = await runHeadlessSiteQaForTest({
        siteRoot: paths.siteRoot,
        basePath: "/project/",
        routes: [],
      }, { browserRunner: async () => ({ ok: true }) })
      assert.equal(result.status, "fail", reference)
      assert.equal(result.error_code, expected, reference)
    } finally {
      await rm(paths.root, { recursive: true, force: true })
    }
  }
})

test("strict public options reject runner injection and preserve one-argument production shape", async () => {
  assert.equal(runHeadlessSiteQa.length, 1)
  assert.equal(runHeadlessSiteQaForTest.length, 2)
  const result = await runHeadlessSiteQa({
    siteRoot: ".",
    routes: [],
    browserRunner: async () => ({ ok: true }),
  })
  assert.equal(result.status, "fail")
  assert.equal(result.error_code, "QA_OPTIONS_INVALID")
})

test("an ordinary immutable snapshot is served after source files change", async () => {
  const paths = await fixture()
  try {
    const result = await runHeadlessSiteQaForTest({
      siteRoot: paths.siteRoot,
      basePath: "/project/",
      routes: [{ route: "/papers/alpha/", file: "papers/alpha/index.html" }],
    }, {
      browserRunner: async (context) => {
        await writeFile(path.join(paths.siteRoot, "index.html"), "changed after snapshot")
        const response = await fetch(context.visitUrls[0])
        const body = await response.text()
        return {
          ok: true,
          pages: context.visitUrls.map((url) => ({ url, dom: body })),
        }
      },
    })
    assert.equal(result.status, "pass")
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("a link site root is rejected before browser launch", async () => {
  const paths = await fixture()
  const parent = await mkdtemp(path.join(os.tmpdir(), "tyrs-site-qa-link-"))
  const linked = path.join(parent, "site-link")
  try {
    await symlink(paths.siteRoot, linked, process.platform === "win32" ? "junction" : "dir")
    let launched = false
    const result = await runHeadlessSiteQaForTest({ siteRoot: linked, routes: [] }, {
      browserRunner: async () => {
        launched = true
        return { ok: true }
      },
    })
    assert.equal(result.status, "fail")
    assert.equal(result.error_code, "QA_SITE_ROOT_INVALID")
    assert.equal(launched, false)
  } finally {
    await rm(parent, { recursive: true, force: true })
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("Windows timeout termination uses taskkill for exactly the spawned PID and no process name", async () => {
  const paths = await fixture()
  const taskkills = []
  try {
    const result = await runHeadlessSiteQaForTest({
      siteRoot: paths.siteRoot,
      basePath: "/project/",
      routes: [],
      timeoutMs: 500,
    }, {
      platform: "win32",
      browserExecutable: "fixture-browser",
      spawn: () => {
        const child = new EventEmitter()
        child.pid = 4242
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        return child
      },
      execFile: (file, args, options, callback) => {
        taskkills.push({ file, args, options })
        callback(null, "", "")
      },
    })
    assert.equal(result.status, "fail")
    assert.equal(result.error_code, "QA_BROWSER_TIMEOUT")
    assert.deepEqual(taskkills, [{
      file: "taskkill",
      args: ["/PID", "4242", "/T", "/F"],
      options: { windowsHide: true },
    }])
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test("real Edge smoke uses the isolated fixture and has no ordinary screenshot work", async (t) => {
  const paths = await fixture()
  try {
    const result = await runHeadlessSiteQa({
      siteRoot: paths.siteRoot,
      basePath: "/project/",
      routes: [{ route: "/papers/alpha/", file: "papers/alpha/index.html" }],
      sourceDiff: { changedFiles: ["docs/README.md"] },
    })
    if (result.error_code === "QA_BROWSER_UNAVAILABLE") {
      t.skip("QA_BROWSER_UNAVAILABLE")
      return
    }
    assert.equal(result.status, "pass", JSON.stringify(result))
    assert.equal(result.screenshot_required, false)
    assert.deepEqual(result.screenshots, [])
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})
