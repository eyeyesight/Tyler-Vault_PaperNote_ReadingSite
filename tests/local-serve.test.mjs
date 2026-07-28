import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import test from "node:test"

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, "..")
const cli = path.join(repoRoot, "scripts", "site.mjs")
const parentFixture = path.join(repoRoot, "tests", "fixtures", "serve-parent.mjs")
const source = path.join(repoRoot, "fixtures", "synthetic-content")

/** @typedef {import("node:child_process").ChildProcess & {stdout: import("node:stream").Readable, stderr: import("node:stream").Readable}} OutputChild */

async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve(undefined))
  })
  const address = server.address()
  assert(address && typeof address === "object")
  const port = address.port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined)))
  return port
}

/** @param {OutputChild} child @param {RegExp} pattern @returns {Promise<RegExpMatchArray>} */
function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = ""
    const timer = setTimeout(() => finish(new Error(`timed out waiting for ${pattern}; output:\n${output}`)), 90_000)
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      output += chunk.toString()
      const match = output.match(pattern)
      if (match) finish(undefined, match)
    }
    /** @param {number | null} code @param {NodeJS.Signals | null} signal */
    const onExit = (code, signal) => finish(new Error(`serve exited before ready (${code ?? signal}); output:\n${output}`))
    /** @param {Error | undefined} error @param {RegExpMatchArray | undefined} [match] */
    function finish(error, match) {
      clearTimeout(timer)
      child.stdout.off("data", onData)
      child.stderr.off("data", onData)
      child.off("exit", onExit)
      if (error) reject(error)
      else resolve(/** @type {RegExpMatchArray} */ (match))
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    child.once("exit", onExit)
  })
}

/** @param {import("node:child_process").ChildProcess} child @returns {Promise<void>} */
function waitForExit(child, timeout = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit)
      reject(new Error(`process ${child.pid} did not exit within ${timeout}ms`))
    }, timeout)
    const onExit = () => {
      clearTimeout(timer)
      resolve(undefined)
    }
    child.once("exit", onExit)
  })
}

/** @param {number} port */
async function waitForPortClosed(port, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port })
      socket.setTimeout(250)
      socket.once("connect", () => {
        socket.destroy()
        resolve(true)
      })
      const closed = () => {
        socket.destroy()
        resolve(false)
      }
      socket.once("error", closed)
      socket.once("timeout", closed)
    })
    if (!open) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`port ${port} remained open after ${timeout}ms`)
}

/** @param {number | undefined} pid */
function processExists(pid) {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM")
  }
}

/** @param {string} vault @param {string} output @param {number} port */
function serveArgs(vault, output, port) {
  return [cli, "serve", "--vault-root", vault, "--source", source, "--output", output, "--port", String(port)]
}

/** @param {string} vault @param {string} output @param {number} port */
function spawnServe(vault, output, port) {
  return spawn(process.execPath, serveArgs(vault, output, port), {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
}

/** @param {number} port @param {number} pid */
async function assertLoopbackListener(port, pid) {
  if (process.platform !== "win32") return
  const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" })
  const listeners = stdout.split(/\r?\n/).filter((line) =>
    line.includes("LISTENING") && new RegExp(`:${port}\\s`).test(line),
  )
  assert(listeners.length > 0, `no LISTENING socket found for port ${port}`)
  assert(listeners.every((line) => line.trim().startsWith(`TCP    127.0.0.1:${port}`)), listeners.join("\n"))
  assert(listeners.every((line) => line.trim().endsWith(String(pid))), listeners.join("\n"))
}

/** @param {string} prefix */
async function makeSandbox(prefix) {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), prefix))
  const vault = path.join(sandbox, "canonical-vault")
  const output = path.join(sandbox, "site")
  await mkdir(vault)
  return { sandbox, vault, output }
}

test("serve binds only IPv4 loopback, serves generated routes, and releases the port on SIGINT", { timeout: 120_000 }, async () => {
  const { sandbox, vault, output } = await makeSandbox("tyler-serve-loopback-")
  const port = await availablePort()
  const child = spawnServe(vault, output, port)
  try {
    const match = await waitForOutput(child, new RegExp(`SERVE_READY host=127\\.0\\.0\\.1 port=${port} pid=(\\d+)`))
    const serverPid = Number(match[1])
    assert.equal(serverPid, child.pid)
    await assertLoopbackListener(port, serverPid)

    const [home, support, head, post] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/`),
      fetch(`http://127.0.0.1:${port}/support-node`),
      fetch(`http://127.0.0.1:${port}/support-node`, { method: "HEAD" }),
      fetch(`http://127.0.0.1:${port}/support-node`, { method: "POST" }),
    ])
    assert.equal(home.status, 200)
    const homeBody = await home.text()
    assert.match(homeBody, /Synthetic Reading Site/)
    assert.equal(support.status, 200)
    const supportBody = await support.text()
    assert.match(supportBody, /Synthetic Support Node/)
    assert.equal(head.status, 200)
    assert.equal(await head.text(), "")
    assert.equal(Number(head.headers.get("content-length")), Buffer.byteLength(supportBody))
    assert.equal(post.status, 405)
    assert.deepEqual(
      new Set((post.headers.get("allow") ?? "").split(",").map((method) => method.trim())),
      new Set(["GET", "HEAD"]),
    )

    const traversal = await fetch(`http://127.0.0.1:${port}/..%5cpackage.json`)
    assert.equal(traversal.status, 400)
    assert.doesNotMatch(await traversal.text(), /tyler-vault-reading-site/)

    child.kill("SIGINT")
    await waitForExit(child)
    await waitForPortClosed(port)
  } finally {
    if (processExists(child.pid)) child.kill("SIGKILL")
    await rm(sandbox, { recursive: true, force: true })
  }
})

test("serve releases the port on SIGTERM", { timeout: 120_000 }, async () => {
  const { sandbox, vault, output } = await makeSandbox("tyler-serve-sigterm-")
  const port = await availablePort()
  const child = spawnServe(vault, output, port)
  try {
    await waitForOutput(child, new RegExp(`SERVE_READY host=127\\.0\\.0\\.1 port=${port}`))
    child.kill("SIGTERM")
    await waitForExit(child)
    await waitForPortClosed(port)
  } finally {
    if (processExists(child.pid)) child.kill("SIGKILL")
    await rm(sandbox, { recursive: true, force: true })
  }
})

test("serve watchdog exits and releases the port when its parent dies", { timeout: 120_000 }, async () => {
  const { sandbox, vault, output } = await makeSandbox("tyler-serve-parent-")
  const port = await availablePort()
  const parent = spawn(process.execPath, [parentFixture, ...serveArgs(vault, output, port)], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  let serverPid = 0
  try {
    const pidMatch = await waitForOutput(parent, /PARENT_CHILD_PID pid=(\d+)/)
    serverPid = Number(pidMatch[1])
    await waitForOutput(parent, new RegExp(`SERVE_READY host=127\\.0\\.0\\.1 port=${port} pid=${serverPid}`))
    await assertLoopbackListener(port, serverPid)

    parent.kill("SIGKILL")
    await waitForExit(parent)
    await waitForPortClosed(port)
    const deadline = Date.now() + 5_000
    while (processExists(serverPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(processExists(serverPid), false, `orphan server PID ${serverPid} remained alive`)
  } finally {
    if (processExists(parent.pid)) parent.kill("SIGKILL")
    if (serverPid && processExists(serverPid)) process.kill(serverPid, "SIGKILL")
    await rm(sandbox, { recursive: true, force: true })
  }
})
