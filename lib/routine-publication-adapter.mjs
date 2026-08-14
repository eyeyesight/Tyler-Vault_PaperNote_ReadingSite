// @ts-nocheck -- this module is a narrow local-Git transport seam for the routine handoff consumer.
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { request as httpsRequest } from "node:https"
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises"
import { lstatSync as lstatSyncFs, realpathSync as realpathSyncFs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { assertNoLinkAncestors, isEqualToOrInside, pathsOverlap } from "./filesystem-safety.mjs"

const MAP_FILE = "site-content.yml"
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_TIMEOUT_MS = 300_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_CANDIDATE_FILES = 4_096
const MAX_CANDIDATE_FILE_BYTES = 16 * 1024 * 1024
const MAX_CANDIDATE_TREE_BYTES = 64 * 1024 * 1024
const SHA40 = /^[0-9a-f]{40}$/u
const REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const BRANCH = /^t13\/map\/[a-z0-9][a-z0-9._-]{0,79}$/u
const SAFE_RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\)(?!.*[\u0000-\u001f\u007f])[^/]+(?:\/[^/]+)*$/u
const INTERNAL_ENV_KEYS = new Set([
  "GIT_INDEX_FILE",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GH_CONFIG_DIR",
])
const WINDOWS_RUNTIME_ENV_KEYS = ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"]
const POSIX_RUNTIME_ENV_KEYS = ["TMPDIR"]
// Git for Windows rejects Node's `os.devNull` spelling (`\\.\\nul`) as a config path;
// `NUL` is the same OS null device in the Git-for-Windows path grammar.
const GIT_CONFIG_GLOBAL_NULL = process.platform === "win32" ? "NUL" : os.devNull

class AdapterFailure extends Error {
  constructor(code) {
    super(code)
    this.name = "RoutinePublicationAdapterError"
    this.code = code
  }
}

function fail(code) {
  return new AdapterFailure(code)
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => Object.hasOwn(descriptor, "value"))
  } catch {
    return false
  }
}

function exactRecord(value, keys, code = "input_invalid") {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) throw fail(code)
  const names = Object.getOwnPropertyNames(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  const expected = [...keys].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw fail(code)
  const result = Object.create(null)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw fail(code)
    result[key] = descriptor.value
  }
  return result
}

function allowedRecord(value, keys, code = "input_invalid") {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) throw fail(code)
  const allowed = new Set(keys)
  for (const name of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(name)) throw fail(code)
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw fail(code)
  }
  return value
}

function assertFiniteBound(value, code, maximum) {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value) || value < 1 || value > maximum) throw fail(code)
  return value
}

function optionalFiniteBound(value, fallback, code, maximum) {
  return value === undefined ? fallback : assertFiniteBound(value, code, maximum)
}

function text(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) throw fail(code)
  return value
}

function sha(value, code = "git_readback_invalid") {
  if (typeof value !== "string" || !SHA40.test(value)) throw fail(code)
  return value
}

function safeRef(value, code = "config_invalid") {
  if (typeof value !== "string" || !REF.test(value) || value.includes("..")) throw fail(code)
  return value
}

function normalizeFsPath(value, code) {
  text(value, code)
  const absolute = path.resolve(value)
  if (absolute.includes("\u0000")) throw fail(code)
  return absolute
}

function samePath(left, right) {
  const normalize = process.platform === "win32" ? (value) => value.toLowerCase() : (value) => value
  return normalize(path.resolve(left)) === normalize(path.resolve(right))
}

function ordinaryDirectorySync(candidate, code) {
  const absolute = normalizeFsPath(candidate, code)
  const parsed = path.parse(absolute)
  let cursor = parsed.root
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  for (const segment of segments) {
    cursor = path.join(cursor, segment)
    let metadata
    try {
      metadata = lstatSyncFs(cursor)
    } catch {
      throw fail(code)
    }
    if (metadata.isSymbolicLink()) throw fail(code)
  }
  let metadata
  let canonical
  try {
    metadata = lstatSyncFs(absolute)
    canonical = realpathSyncFs(absolute)
  } catch {
    throw fail(code)
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(canonical, absolute)) throw fail(code)
  return { absolute, canonical }
}

function ordinaryExecutableSync(candidate, code, allowedBasenames = ["git", "git.exe"]) {
  const value = text(candidate, code)
  if (!path.isAbsolute(value)) throw fail(code)
  const absolute = normalizeFsPath(value, code)
  const parsed = path.parse(absolute)
  const basename = path.basename(absolute)
  const expectedBasename = process.platform === "win32" ? basename.toLowerCase() : basename
  if (!allowedBasenames.includes(expectedBasename)) throw fail(code)
  let cursor = parsed.root
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  for (const segment of segments) {
    cursor = path.join(cursor, segment)
    let metadata
    try {
      metadata = lstatSyncFs(cursor)
    } catch {
      throw fail(code)
    }
    if (metadata.isSymbolicLink()) throw fail(code)
  }
  let metadata
  let canonical
  try {
    metadata = lstatSyncFs(absolute)
    canonical = realpathSyncFs(absolute)
  } catch {
    throw fail(code)
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || !samePath(canonical, absolute)) throw fail(code)
  return { absolute, canonical }
}

function validateConfig(value) {
  const requiredKeys = ["gitExecutable", "gitRoot", "remote", "mainRef", "ghPagesRef", "operationRoot"]
  const allowed = allowedRecord(value, [...requiredKeys, "candidateRoot"], "config_invalid")
  for (const key of requiredKeys) {
    if (!Object.hasOwn(allowed, key)) throw fail("config_invalid")
  }
  const raw = allowed
  const git = ordinaryDirectorySync(raw.gitRoot, "config_invalid")
  const gitExecutable = ordinaryExecutableSync(raw.gitExecutable, "config_invalid")
  const operation = ordinaryDirectorySync(raw.operationRoot, "config_invalid")
  const candidate = raw.candidateRoot === undefined
    ? operation
    : ordinaryDirectorySync(raw.candidateRoot, "config_invalid")
  if (pathsOverlap(git.canonical, operation.canonical)) throw fail("config_roots_overlap")
  if (pathsOverlap(git.canonical, candidate.canonical)) throw fail("config_roots_overlap")
  if (raw.candidateRoot !== undefined && pathsOverlap(operation.canonical, candidate.canonical)) throw fail("config_roots_overlap")
  const remote = text(raw.remote, "config_invalid")
  if (!REMOTE.test(remote) || remote.startsWith("-") || remote.includes("..")) throw fail("config_invalid")
  const mainRef = safeRef(raw.mainRef)
  const ghPagesRef = safeRef(raw.ghPagesRef)
  if (mainRef === ghPagesRef) throw fail("config_invalid")
  return Object.freeze({
    gitExecutable: gitExecutable.absolute,
    gitExecutableCanonical: gitExecutable.canonical,
    gitRoot: git.absolute,
    gitRootCanonical: git.canonical,
    remote,
    mainRef,
    ghPagesRef,
    operationRoot: operation.absolute,
    operationRootCanonical: operation.canonical,
    candidateRoot: candidate.absolute,
    candidateRootCanonical: candidate.canonical,
  })
}

function copyBytes(value, code = "git_readback_invalid") {
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Uint8Array && !(value instanceof DataView)) return Buffer.from(value)
  throw fail(code)
}

function utf8(value, code) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value)
  } catch {
    throw fail(code)
  }
}

function parseSingleSha(output, expectedRef) {
  const value = utf8(output, "git_readback_invalid")
  if (!value.endsWith("\n")) throw fail("git_readback_invalid")
  const lines = value.slice(0, -1).split("\n")
  if (lines.length !== 1) throw fail("git_readback_invalid")
  const separator = lines[0].indexOf("\t")
  if (separator < 0 || lines[0].indexOf("\t", separator + 1) >= 0) throw fail("git_readback_invalid")
  const head = lines[0].slice(0, separator)
  const ref = lines[0].slice(separator + 1)
  if (ref !== expectedRef) throw fail("git_readback_invalid")
  return sha(head)
}

function parseCommandResult(value, maxOutputBytes) {
  if (!isPlainRecord(value)) throw fail("command_output_invalid")
  const stdout = copyBytes(value.stdout, "command_output_invalid")
  const stderr = copyBytes(value.stderr, "command_output_invalid")
  if (stdout.length > maxOutputBytes || stderr.length > maxOutputBytes) throw fail("command_output_limit")
  const status = value.status ?? value.exitCode ?? 0
  if (typeof status !== "number" || !Number.isInteger(status)) throw fail("command_output_invalid")
  return Object.freeze({ status, stdout, stderr })
}

function validateEnvironmentOverrides(value, executable = null) {
  if (value === undefined) return Object.create(null)
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) throw fail("command_request_invalid")
  const overrides = Object.create(null)
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!INTERNAL_ENV_KEYS.has(key)) throw fail("command_request_invalid")
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw fail("command_request_invalid")
    if (typeof descriptor.value !== "string" || descriptor.value.includes("\u0000")) throw fail("command_request_invalid")
    if (key === "GH_CONFIG_DIR") {
      const basename = process.platform === "win32" ? path.basename(executable ?? "").toLowerCase() : path.basename(executable ?? "")
      if (!executable || !["gh", "gh.exe"].includes(basename) || !path.isAbsolute(descriptor.value)) throw fail("command_request_invalid")
      ordinaryDirectorySync(descriptor.value, "command_request_invalid")
    }
    overrides[key] = descriptor.value
  }
  return overrides
}

function safeEnvironment(executable, overrides = {}) {
  const environment = {}
  const runtimeKeys = process.platform === "win32" ? WINDOWS_RUNTIME_ENV_KEYS : POSIX_RUNTIME_ENV_KEYS
  for (const key of runtimeKeys) {
    const value = process.env[key]
    if (typeof value === "string" && !value.includes("\u0000")) environment[key] = value
  }
  environment.LC_ALL = "C"
  environment.LANG = "C"
  environment.PATH = path.dirname(executable)
  Object.assign(environment, validateEnvironmentOverrides(overrides, executable))
  environment.GIT_TERMINAL_PROMPT = "0"
  environment.GIT_OPTIONAL_LOCKS = "0"
  environment.GIT_CONFIG_NOSYSTEM = "1"
  environment.GIT_CONFIG_GLOBAL = GIT_CONFIG_GLOBAL_NULL
  return Object.freeze(environment)
}

function boundedCommandInput(value, code = "command_request_invalid") {
  const bytes = copyBytes(value, code)
  if (bytes.length > MAX_CANDIDATE_FILE_BYTES) throw fail("command_input_limit")
  return bytes
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function pidExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === "ESRCH") return false
    return true
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error?.code === "ESRCH") return false
    throw fail("termination_failed")
  }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!predicate()) return true
    await delay(25)
  }
  return !predicate()
}

function childHasClosed(child) {
  return Boolean(child) && (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  )
}

async function waitForChildClose(child, timeoutMs) {
  if (childHasClosed(child)) return true
  return await Promise.race([
    new Promise((resolve) => child.once("close", () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ])
}

async function runTaskkill(pid) {
  let killer
  try {
    killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    })
  } catch {
    throw fail("termination_failed")
  }
  const outcome = await Promise.race([
    new Promise((resolve) => {
      killer.once("error", () => resolve({ kind: "error" }))
      killer.once("close", (code) => resolve({ kind: "close", code }))
    }),
    delay(5_000).then(() => ({ kind: "timeout" })),
  ])
  if (outcome.kind !== "close" || outcome.code !== 0) throw fail("termination_failed")
}

async function killTree(child) {
  const pid = child?.pid
  if (!Number.isInteger(pid) || pid < 1) throw fail("termination_failed")
  if (process.platform === "win32") {
    if (childHasClosed(child) && !pidExists(pid)) return
    try {
      await runTaskkill(pid)
    } catch {
      if (typeof child?.once !== "function") throw fail("termination_failed")
      const [closed, absent] = await Promise.all([
        waitForChildClose(child, 1_000),
        waitUntil(() => pidExists(pid), 1_000),
      ])
      if (!closed || !absent) throw fail("termination_failed")
      return
    }
    const [closed, absent] = await Promise.all([
      waitForChildClose(child, 1_000),
      waitUntil(() => pidExists(pid), 1_000),
    ])
    if (!closed || !absent) throw fail("termination_failed")
    return
  }
  try {
    process.kill(-pid, "SIGTERM")
  } catch (error) {
    if (error?.code !== "ESRCH") throw fail("termination_failed")
  }
  if (!(await waitUntil(() => processGroupExists(pid), 1_000))) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch (error) {
      if (error?.code !== "ESRCH") throw fail("termination_failed")
    }
  }
  if (!(await waitUntil(() => processGroupExists(pid), 1_000))) throw fail("termination_failed")
  if (!(await waitForChildClose(child, 1_000))) throw fail("termination_failed")
}

export async function _testOnlyTerminateOwnedProcess(child) {
  return await killTree(child)
}

export function _testOnlyAdapterFailure(code) {
  return fail(code)
}

function executeDefault(request) {
  return new Promise((resolve, reject) => {
    const { argv, cwd, input, env, timeoutMs, maxOutputBytes } = request
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch {
      reject(fail("command_unavailable"))
      return
    }
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let terminating = false
    let terminationReason = null
    let settled = false
    let timer
    const hasInput = Buffer.isBuffer(input) && input.length > 0
    let inputFinished = !hasInput
    let inputClosed = !hasInput
    let inputFailed = false
    let childClosed = false
    let childStatus = null
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const terminate = (failure) => {
      if (terminationReason === null) terminationReason = failure
      if (terminating) return
      terminating = true
      void (async () => {
        try {
          await killTree(child)
          settle(reject, fail(terminationReason))
        } catch {
          settle(reject, fail("termination_failed"))
        }
      })()
    }
    const inputPending = () => hasInput && !(inputFinished && inputClosed)
    const markInputFailed = () => {
      if (!hasInput || inputFailed || settled) return
      inputFailed = true
      terminate("command_input_failed")
    }
    const maybeComplete = () => {
      if (settled || terminating) return
      if (inputFailed) {
        terminate("command_input_failed")
        return
      }
      if (!childClosed) return
      if (inputPending()) {
        terminate("command_input_failed")
        return
      }
      if (typeof childStatus !== "number" || !Number.isInteger(childStatus)) settle(reject, fail("command_failed"))
      else settle(resolve, { status: childStatus, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    }
    const collect = (target, chunk, current, failure) => {
      const bytes = Buffer.from(chunk)
      if (current + bytes.length > maxOutputBytes) {
        terminate(failure)
        return current
      }
      target.push(bytes)
      return current + bytes.length
    }
    child.stdout.on("data", (chunk) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes, "command_output_limit")
    })
    child.stderr.on("data", (chunk) => {
      stderrBytes = collect(stderr, chunk, stderrBytes, "command_output_limit")
    })
    child.stdin.on("error", () => {
      markInputFailed()
    })
    child.stdin.once("finish", () => {
      inputFinished = true
      maybeComplete()
    })
    child.stdin.once("close", () => {
      inputClosed = true
      if (hasInput && !inputFinished && !inputFailed) markInputFailed()
      else maybeComplete()
    })
    child.once("error", () => {
      if (!Number.isInteger(child.pid) || child.pid < 1) settle(reject, fail("command_unavailable"))
      else terminate("command_unavailable")
    })
    child.once("close", (status) => {
      childClosed = true
      childStatus = status
      maybeComplete()
    })
    timer = setTimeout(() => terminate("command_timeout"), timeoutMs)
    try {
      if (input === undefined) child.stdin.end()
      else child.stdin.end(input)
    } catch {
      markInputFailed()
    }
  })
}

/**
 * Create the bounded command transport used by the local-Git adapter.
 * An optional `execute` function is an internal test/runtime injection; it
 * receives a redacted, finite request and must return bounded Buffer output.
 */
export function createBoundedCommandTransport(options = {}) {
  const raw = allowedRecord(options, ["execute", "maxOutputBytes", "timeoutMs"], "transport_config_invalid")
  if (raw.execute !== undefined && typeof raw.execute !== "function") throw fail("transport_config_invalid")
  const timeoutMs = optionalFiniteBound(raw.timeoutMs, DEFAULT_TIMEOUT_MS, "transport_config_invalid", MAX_TIMEOUT_MS)
  const maxOutputBytes = optionalFiniteBound(raw.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, "transport_config_invalid", MAX_OUTPUT_BYTES)
  const execute = raw.execute ?? executeDefault
  const run = async (request) => {
    const supplied = Array.isArray(request) ? { argv: request } : allowedRecord(request, ["argv", "cwd", "env", "input", "maxOutputBytes", "shell", "timeoutMs"], "command_request_invalid")
    const argv = supplied.argv
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== "string" || value.length === 0 || value.includes("\u0000"))) throw fail("command_request_invalid")
    if (!path.isAbsolute(argv[0])) throw fail("command_request_invalid")
    const cwd = text(supplied.cwd, "command_request_invalid")
    if (!path.isAbsolute(cwd)) throw fail("command_request_invalid")
    if (supplied.shell !== undefined && supplied.shell !== false) throw fail("command_request_invalid")
    const effectiveTimeout = optionalFiniteBound(supplied.timeoutMs, timeoutMs, "command_request_invalid", MAX_TIMEOUT_MS)
    const effectiveOutput = optionalFiniteBound(supplied.maxOutputBytes, maxOutputBytes, "command_request_invalid", MAX_OUTPUT_BYTES)
    let input
    if (supplied.input !== undefined) {
      input = typeof supplied.input === "string" ? Buffer.from(supplied.input) : copyBytes(supplied.input, "command_request_invalid")
      if (input.length > MAX_CANDIDATE_FILE_BYTES) throw fail("command_input_limit")
    }
    const env = safeEnvironment(argv[0], supplied.env)
    const safeRequest = Object.freeze({
      argv: Object.freeze([...argv]),
      cwd,
      ...(env ? { env } : {}),
      ...(input === undefined ? {} : { input }),
      maxOutputBytes: effectiveOutput,
      shell: false,
      timeoutMs: effectiveTimeout,
    })
    let result
    try {
      result = await execute(safeRequest)
    } catch (error) {
      if (error instanceof AdapterFailure) throw error
      throw fail("command_failed")
    }
    const normalized = parseCommandResult(result, effectiveOutput)
    return normalized
  }
  return Object.freeze({ run })
}

function transportRunner(value) {
  if (value === undefined) return createBoundedCommandTransport()
  if (typeof value === "function") return value
  if (!isPlainRecord(value)) throw fail("transport_config_invalid")
  const descriptor = Object.getOwnPropertyDescriptor(value, "run")
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") throw fail("transport_config_invalid")
  return value
}

async function invokeTransport(transport, request) {
  try {
    const result = typeof transport === "function" ? await transport(request) : await transport.run(request)
    return parseCommandResult(result, request.maxOutputBytes)
  } catch (error) {
    if (error instanceof AdapterFailure) throw error
    throw fail("command_failed")
  }
}

function gitEnvironment(overrides = {}) {
  return validateEnvironmentOverrides(overrides)
}

async function runGit(config, transport, args, options = {}) {
  const input = options.input === undefined ? undefined : boundedCommandInput(options.input)
  const env = gitEnvironment(options.env)
  const request = {
    argv: [config.gitExecutable, ...args],
    cwd: config.gitRoot,
    env,
    ...(input === undefined ? {} : { input: copyBytes(input, "command_request_invalid") }),
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    shell: false,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  const result = await invokeTransport(transport, request)
  if (result.status !== 0) throw fail("git_command_failed")
  return result
}

async function readRemoteRef(config, transport, ref) {
  const result = await runGit(config, transport, ["ls-remote", "--refs", config.remote, ref])
  return parseSingleSha(result.stdout, ref)
}

async function ensureCommitObject(config, transport, commit) {
  const exactCommit = sha(commit)
  try {
    await runGit(config, transport, ["cat-file", "-e", `${exactCommit}^{commit}`])
    return
  } catch {
    await runGit(config, transport, [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      config.remote,
      exactCommit,
    ])
  }
  await runGit(config, transport, ["cat-file", "-e", `${exactCommit}^{commit}`])
}

async function readCommitMap(config, transport, commit) {
  await ensureCommitObject(config, transport, commit)
  const result = await runGit(config, transport, ["show", `${sha(commit)}:${MAP_FILE}`], { maxOutputBytes: MAX_CANDIDATE_FILE_BYTES })
  return copyBytes(result.stdout)
}

async function verifyDirectory(directory, root, code) {
  const absolute = normalizeFsPath(directory, code)
  if (!isEqualToOrInside(root.canonical, absolute) || samePath(root.canonical, absolute)) throw fail(code)
  try {
    await assertNoLinkAncestors(absolute, { errorFactory: () => fail(code) })
    const [metadata, canonical] = await Promise.all([lstat(absolute), realpath(absolute)])
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !isEqualToOrInside(root.canonical, canonical) || samePath(root.canonical, canonical)) throw fail(code)
    return { absolute, canonical }
  } catch (error) {
    if (error instanceof AdapterFailure) throw error
    throw fail(code)
  }
}

async function collectCandidateFiles(root) {
  const files = []
  async function visit(directory, prefix) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      throw fail("candidate_path_invalid")
    }
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (!SAFE_RELATIVE.test(relative) || relative.normalize("NFC") !== relative) throw fail("candidate_tree_invalid")
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw fail("candidate_tree_invalid")
      if (entry.isDirectory()) {
        await visit(absolute, relative)
      } else if (entry.isFile()) {
        let bytes
        try {
          const metadata = await lstat(absolute)
          if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error()
          bytes = await readFile(absolute)
        } catch {
          throw fail("candidate_tree_invalid")
        }
        if (bytes.length > MAX_CANDIDATE_FILE_BYTES || files.length >= MAX_CANDIDATE_FILES || files.reduce((sum, file) => sum + file.bytes.length, 0) + bytes.length > MAX_CANDIDATE_TREE_BYTES) throw fail("candidate_tree_limit")
        files.push({ relative, bytes: Buffer.from(bytes) })
      } else throw fail("candidate_tree_invalid")
    }
  }
  await visit(root, "")
  if (files.length === 0) throw fail("candidate_tree_invalid")
  files.sort((left, right) => Buffer.compare(Buffer.from(left.relative), Buffer.from(right.relative)))
  return files
}

function commitMessage(rendererSha) {
  return Buffer.from(`T13 gh-pages candidate\n\nRenderer-Main-SHA: ${rendererSha}\n`, "utf8")
}

async function makeOperationDirectory(config) {
  try {
    await assertNoLinkAncestors(config.operationRoot, { errorFactory: () => fail("operation_root_invalid") })
    const canonical = await realpath(config.operationRoot)
    if (!samePath(canonical, config.operationRootCanonical)) throw fail("operation_root_invalid")
    const directory = await mkdtemp(path.join(config.operationRoot, ".t13-git-"))
    await assertNoLinkAncestors(directory, { errorFactory: () => fail("operation_root_invalid") })
    const directoryCanonical = await realpath(directory)
    if (!isEqualToOrInside(config.operationRootCanonical, directoryCanonical) || samePath(config.operationRootCanonical, directoryCanonical)) throw fail("operation_root_invalid")
    return { directory, index: path.join(directory, "index"), canonical: directoryCanonical }
  } catch (error) {
    if (error instanceof AdapterFailure) throw error
    throw fail("operation_root_invalid")
  }
}

async function removeOperationDirectory(operation) {
  try {
    await rm(operation.directory, { recursive: true, force: true })
  } catch {
    throw fail("operation_cleanup_failed")
  }
}

async function withIndex(config, transport, callback) {
  const operation = await makeOperationDirectory(config)
  const env = {
    GIT_INDEX_FILE: operation.index,
    GIT_AUTHOR_NAME: "T13 routine publication",
    GIT_AUTHOR_EMAIL: "t13-local-git@invalid",
    GIT_COMMITTER_NAME: "T13 routine publication",
    GIT_COMMITTER_EMAIL: "t13-local-git@invalid",
  }
  let retainForAttention = false
  try {
    return await callback(operation, env)
  } catch (error) {
    if (error?.code === "termination_failed") retainForAttention = true
    throw error
  } finally {
    if (!retainForAttention) await removeOperationDirectory(operation)
  }
}

function parseShaText(output, code = "git_readback_invalid") {
  const value = utf8(output, code).trim()
  if (!SHA40.test(value) || value.includes("\n") || value.includes("\r")) throw fail(code)
  return value
}

function parseParentLine(output, expectedCommit, expectedParent) {
  const value = utf8(output, "git_readback_invalid").trim()
  const parts = value.split(/\s+/u)
  if (parts.length !== 2 || parts[0] !== expectedCommit || parts[1] !== expectedParent) throw fail("git_readback_invalid")
}

function treePath(relative, code = "candidate_tree_invalid") {
  if (!SAFE_RELATIVE.test(relative) || relative.normalize("NFC") !== relative || path.posix.normalize(relative) !== relative) throw fail(code)
  return relative
}

function parseTree(output, prefix, code = "candidate_tree_invalid") {
  if (output.length > MAX_CANDIDATE_TREE_BYTES) throw fail("candidate_tree_limit")
  const value = utf8(output, code)
  if (!value.endsWith("\u0000")) throw fail(code)
  const records = value.slice(0, -1).split("\u0000")
  const files = []
  const seen = new Set()
  for (const record of records) {
    if (!record) throw fail(code)
    const tab = record.indexOf("\t")
    if (tab < 0) throw fail(code)
    const header = record.slice(0, tab).split(" ")
    const relative = record.slice(tab + 1)
    if (header.length !== 3 || header[0] !== "100644" || header[1] !== "blob" || !SHA40.test(header[2])) throw fail(code)
    if (!relative.startsWith(`${prefix}/`)) throw fail(code)
    treePath(relative.slice(prefix.length + 1), code)
    if (seen.has(relative)) throw fail(code)
    seen.add(relative)
    files.push({ relative, mode: header[0], type: header[1], blob_sha: header[2] })
  }
  files.sort((left, right) => Buffer.compare(Buffer.from(left.relative), Buffer.from(right.relative)))
  return files
}

function mapOnlyInput(input) {
  const value = exactRecord(input, ["base_ref", "base_sha", "branch", "map_bytes"], "mapping_input_invalid")
  if (value.base_ref !== "main" || !BRANCH.test(value.branch)) throw fail("mapping_input_invalid")
  const baseSha = sha(value.base_sha, "mapping_input_invalid")
  const mapBytes = copyBytes(value.map_bytes, "mapping_input_invalid")
  if (mapBytes.length === 0 || mapBytes.length > MAX_CANDIDATE_FILE_BYTES) throw fail("mapping_input_invalid")
  return { base_ref: value.base_ref, base_sha: baseSha, branch: value.branch, map_bytes: mapBytes }
}

function candidateInput(input) {
  const value = exactRecord(input, ["base_sha", "candidate_path", "renderer_main_sha"], "candidate_input_invalid")
  return {
    base_sha: sha(value.base_sha, "candidate_input_invalid"),
    candidate_path: text(value.candidate_path, "candidate_input_invalid"),
    renderer_main_sha: sha(value.renderer_main_sha, "candidate_input_invalid"),
  }
}

function rollbackInput(input) {
  const value = exactRecord(input, ["failed_sha", "lkg_sha"], "rollback_input_invalid")
  return {
    failed_sha: sha(value.failed_sha, "rollback_input_invalid"),
    lkg_sha: sha(value.lkg_sha, "rollback_input_invalid"),
  }
}

function readCandidateInput(input) {
  const value = exactRecord(input, ["candidate_sha"], "candidate_input_invalid")
  return { candidate_sha: sha(value.candidate_sha, "candidate_input_invalid") }
}

function pushInput(input) {
  const value = exactRecord(input, ["candidate_sha", "expected_old_sha"], "push_input_invalid")
  return {
    candidate_sha: sha(value.candidate_sha, "push_input_invalid"),
    expected_old_sha: sha(value.expected_old_sha, "push_input_invalid"),
  }
}

async function createMappingCommit(config, transport, input) {
  const authority = await readRemoteRef(config, transport, config.mainRef)
  if (authority !== input.base_sha) throw fail("remote_drift")
  const baseMap = await readCommitMap(config, transport, input.base_sha)
  if (baseMap.equals(input.map_bytes)) throw fail("mapping_no_change")
  return await withIndex(config, transport, async (_operation, env) => {
    await runGit(config, transport, ["read-tree", input.base_sha], { env })
    const blob = parseShaText((await runGit(config, transport, ["hash-object", "-w", "--stdin"], { env, input: input.map_bytes })).stdout, "git_write_invalid")
    await runGit(config, transport, ["update-index", "--add", "--cacheinfo", `100644,${blob},${MAP_FILE}`], { env })
    const tree = parseShaText((await runGit(config, transport, ["write-tree"], { env })).stdout, "git_write_invalid")
    const message = Buffer.from(`T13 mapping proposal ${input.branch}\n`, "utf8")
    const commit = parseShaText((await runGit(config, transport, ["commit-tree", tree, "-p", input.base_sha], { env, input: message })).stdout, "git_write_invalid")
    parseParentLine((await runGit(config, transport, ["rev-list", "--parents", "-n", "1", commit], { env })).stdout, commit, input.base_sha)
    const changed = utf8((await runGit(config, transport, ["diff-tree", "--no-commit-id", "--name-only", "-r", input.base_sha, commit], { env })).stdout, "git_write_invalid").split(/\r?\n/u).filter(Boolean)
    if (changed.length !== 1 || changed[0] !== MAP_FILE) throw fail("mapping_tree_invalid")
    const destination = `refs/heads/${input.branch}`
    let pushError
    try {
      await runGit(config, transport, ["push", "--porcelain", config.remote, `${commit}:${destination}`])
    } catch (error) {
      pushError = error
    }
    let remoteHead
    try {
      remoteHead = await readRemoteRef(config, transport, destination)
    } catch {
      if (pushError) throw fail("mapping_push_failed")
      throw fail("mapping_readback_invalid")
    }
    if (remoteHead !== commit) throw fail(pushError ? "mapping_push_failed" : "mapping_readback_invalid")
    return { branch: input.branch, head_sha: commit, base_sha: input.base_sha, map_bytes: Buffer.from(input.map_bytes) }
  })
}

async function createCandidateCommit(config, transport, input) {
  const authority = await readRemoteRef(config, transport, config.ghPagesRef)
  if (authority !== input.base_sha) throw fail("remote_drift")
  const candidate = await verifyDirectory(input.candidate_path, {
    canonical: config.candidateRootCanonical,
  }, "candidate_path_invalid")
  if (pathsOverlap(candidate.canonical, config.gitRootCanonical)) throw fail("candidate_path_invalid")
  const files = await collectCandidateFiles(candidate.absolute)
  return await withIndex(config, transport, async (_operation, env) => {
    await runGit(config, transport, ["read-tree", input.base_sha], { env })
    const existing = parseTree(
      (await runGit(config, transport, ["ls-tree", "-r", "-z", input.base_sha, "--", "site"], { env, maxOutputBytes: MAX_CANDIDATE_TREE_BYTES })).stdout,
      "site",
      "git_tree_invalid",
    )
    for (const entry of existing) await runGit(config, transport, ["update-index", "--force-remove", "--", entry.relative], { env })
    for (const file of files) {
      const blob = parseShaText((await runGit(config, transport, ["hash-object", "-w", "--stdin"], { env, input: file.bytes })).stdout, "git_write_invalid")
      const relative = `site/${file.relative}`
      await runGit(config, transport, ["update-index", "--add", "--cacheinfo", `100644,${blob},${relative}`], { env })
    }
    const tree = parseShaText((await runGit(config, transport, ["write-tree"], { env })).stdout, "git_write_invalid")
    const message = commitMessage(input.renderer_main_sha)
    const candidateSha = parseShaText((await runGit(config, transport, ["commit-tree", tree, "-p", input.base_sha], { env, input: message })).stdout, "git_write_invalid")
    parseParentLine((await runGit(config, transport, ["rev-list", "--parents", "-n", "1", candidateSha], { env })).stdout, candidateSha, input.base_sha)
    const readMessage = utf8((await runGit(config, transport, ["show", "-s", "--format=%B", candidateSha], { env })).stdout, "git_readback_invalid")
    const trailer = `Renderer-Main-SHA: ${input.renderer_main_sha}`
    const trailerLines = readMessage.split(/\r?\n/u).filter((line) => line === trailer)
    if (trailerLines.length !== 1) throw fail("candidate_metadata_invalid")
    return {
      candidate_sha: candidateSha,
      parent_sha: input.base_sha,
      renderer_main_sha: input.renderer_main_sha,
      message: readMessage,
    }
  })
}

async function createRollbackCommit(config, transport, input) {
  const authority = await readRemoteRef(config, transport, config.ghPagesRef)
  if (authority !== input.failed_sha) throw fail("remote_drift")
  await ensureCommitObject(config, transport, input.failed_sha)
  await ensureCommitObject(config, transport, input.lkg_sha)
  const lkgTree = parseShaText((await runGit(config, transport, ["rev-parse", "--verify", "--end-of-options", `${input.lkg_sha}^{tree}`])).stdout, "rollback_readback_invalid")
  const siteTree = parseTree(
    (await runGit(config, transport, ["ls-tree", "-r", "-z", input.lkg_sha, "--", "site"], { maxOutputBytes: MAX_CANDIDATE_TREE_BYTES })).stdout,
    "site",
    "rollback_tree_invalid",
  )
  if (siteTree.length === 0) throw fail("rollback_tree_invalid")
  const lkgMessage = utf8((await runGit(config, transport, ["show", "-s", "--format=%B", input.lkg_sha])).stdout, "rollback_readback_invalid")
  const rendererLines = lkgMessage.split(/\r?\n/u).filter((line) => /^Renderer-Main-SHA: [0-9a-f]{40}$/u.test(line))
  if (rendererLines.length !== 1) throw fail("rollback_metadata_invalid")
  const rendererMainSha = rendererLines[0].slice("Renderer-Main-SHA: ".length)

  return await withIndex(config, transport, async (_operation, env) => {
    await runGit(config, transport, ["read-tree", input.lkg_sha], { env })
    const materializedTree = parseShaText((await runGit(config, transport, ["write-tree"], { env })).stdout, "rollback_tree_invalid")
    if (materializedTree !== lkgTree) throw fail("rollback_tree_invalid")
    const message = Buffer.from(`T13 gh-pages rollback\n\nRestored-LKG-SHA: ${input.lkg_sha}\nRenderer-Main-SHA: ${rendererMainSha}\n`, "utf8")
    const rollbackSha = parseShaText((await runGit(config, transport, ["commit-tree", lkgTree, "-p", input.failed_sha], { env, input: message })).stdout, "git_write_invalid")
    if (rollbackSha === input.failed_sha || rollbackSha === input.lkg_sha) throw fail("rollback_identity_invalid")
    parseParentLine((await runGit(config, transport, ["rev-list", "--parents", "-n", "1", rollbackSha], { env })).stdout, rollbackSha, input.failed_sha)
    const rollbackTree = parseShaText((await runGit(config, transport, ["rev-parse", "--verify", "--end-of-options", `${rollbackSha}^{tree}`], { env })).stdout, "rollback_readback_invalid")
    if (rollbackTree !== lkgTree) throw fail("rollback_tree_invalid")
    const readMessage = utf8((await runGit(config, transport, ["show", "-s", "--format=%B", rollbackSha], { env })).stdout, "rollback_readback_invalid")
    if (readMessage.split(/\r?\n/u).filter((line) => line === `Restored-LKG-SHA: ${input.lkg_sha}`).length !== 1
      || readMessage.split(/\r?\n/u).filter((line) => line === `Renderer-Main-SHA: ${rendererMainSha}`).length !== 1) throw fail("rollback_metadata_invalid")
    return {
      rollback_sha: rollbackSha,
      parent_sha: input.failed_sha,
      restored_lkg_sha: input.lkg_sha,
    }
  })
}

async function readCandidate(config, transport, input) {
  const type = utf8((await runGit(config, transport, ["cat-file", "-t", input.candidate_sha])).stdout, "git_readback_invalid").trim()
  if (type !== "commit") throw fail("candidate_readback_invalid")
  const tree = parseTree(
    (await runGit(config, transport, ["ls-tree", "-r", "-z", input.candidate_sha, "--", "site"], { maxOutputBytes: MAX_CANDIDATE_TREE_BYTES })).stdout,
    "site",
  )
  if (tree.length === 0) throw fail("candidate_readback_invalid")
  const files = []
  let total = 0
  for (const entry of tree) {
    const bytes = copyBytes((await runGit(config, transport, ["cat-file", "blob", entry.blob_sha], { maxOutputBytes: MAX_CANDIDATE_FILE_BYTES })).stdout, "candidate_readback_invalid")
    if (bytes.length > MAX_CANDIDATE_FILE_BYTES || total + bytes.length > MAX_CANDIDATE_TREE_BYTES) throw fail("candidate_tree_limit")
    total += bytes.length
    files.push({ relative: entry.relative, mode: entry.mode, type: entry.type, bytes })
  }
  files.sort((left, right) => Buffer.compare(Buffer.from(left.relative), Buffer.from(right.relative)))
  return { candidate_sha: input.candidate_sha, files }
}

async function pushCandidate(config, transport, input) {
  const current = await readRemoteRef(config, transport, config.ghPagesRef)
  if (current !== input.expected_old_sha) throw fail("remote_drift")
  const parent = parseShaText((await runGit(config, transport, ["rev-parse", "--verify", "--end-of-options", `${input.candidate_sha}^`])).stdout, "candidate_readback_invalid")
  if (parent !== input.expected_old_sha) throw fail("candidate_parent_invalid")
  let pushError
  try {
    await runGit(config, transport, ["push", "--porcelain", config.remote, `${input.candidate_sha}:${config.ghPagesRef}`])
  } catch (error) {
    pushError = error
  }
  let remoteHead
  try {
    remoteHead = await readRemoteRef(config, transport, config.ghPagesRef)
  } catch {
    throw fail("push_uncertain")
  }
  if (remoteHead !== input.candidate_sha) throw fail(pushError ? "push_failed" : "push_uncertain")
  return { remote_sha: input.candidate_sha }
}

/**
 * Build the six local-Git capabilities consumed by routinePublicationHandoff.
 * This is intentionally not a publication controller and exposes no provider
 * or lifecycle surface. The returned methods are own data-valued functions.
 */
export function createRoutinePublicationLocalGitCapabilities(config, dependencies = {}) {
  const validated = validateConfig(config)
  const rawDependencies = allowedRecord(dependencies, ["commandTransport"], "transport_config_invalid")
  const transport = transportRunner(rawDependencies.commandTransport)
  const capabilities = {
    async readRemoteAuthority(input = {}) {
      exactRecord(input, [], "remote_input_invalid")
      const mainSha = await readRemoteRef(validated, transport, validated.mainRef)
      const ghPagesSha = await readRemoteRef(validated, transport, validated.ghPagesRef)
      const mapBytes = await readCommitMap(validated, transport, mainSha)
      return { gh_pages_sha: ghPagesSha, main_sha: mainSha, map_bytes: mapBytes }
    },
    async createMappingBranch(input) {
      return await createMappingCommit(validated, transport, mapOnlyInput(input))
    },
    async createGhPagesCandidate(input) {
      return await createCandidateCommit(validated, transport, candidateInput(input))
    },
    async createGhPagesRollback(input) {
      return await createRollbackCommit(validated, transport, rollbackInput(input))
    },
    async readCandidateCommit(input) {
      return await readCandidate(validated, transport, readCandidateInput(input))
    },
    async pushGhPages(input) {
      return await pushCandidate(validated, transport, pushInput(input))
    },
    async readGhPagesHead(input = {}) {
      exactRecord(input, [], "remote_input_invalid")
      return await readRemoteRef(validated, transport, validated.ghPagesRef)
    },
  }
  return capabilities
}

const PROVIDER_PAGE_SIZE = 100
const PROVIDER_MAX_PAGES = 100
const PROVIDER_MAX_ITEMS = PROVIDER_PAGE_SIZE * PROVIDER_MAX_PAGES
const PROVIDER_MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const PROVIDER_READ_TIMEOUT_MS = 30_000
const PROVIDER_MUTATION_TIMEOUT_MS = 120_000
const PROVIDER_SMOKE_TIMEOUT_MS = 10_000
const PROVIDER_MAX_SMOKE_REQUESTS = 512
const PROVIDER_HTTP_DEFAULT_TIMEOUT_MS = PROVIDER_SMOKE_TIMEOUT_MS
const PROVIDER_HTTP_MAX_TIMEOUT_MS = 30_000
const PROVIDER_HTTP_DEFAULT_MAX_RESPONSE_BYTES = 1
const PROVIDER_HTTP_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const PROVIDER_REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,99}))$/u
const PROVIDER_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const PROVIDER_RUN_NAME = /^Deploy GitHub Pages [0-9a-f]{40} \(routine\)$/u
const PROVIDER_WORKFLOW_PATH = (name) => `.github/workflows/${name}`
const PROVIDER_MAPPING_WORKFLOW = "t08-pinned-stack.yml"
const PROVIDER_MAPPING_JOB = "Ubuntu pinned-stack acceptance"
const PROVIDER_DEPLOY_WORKFLOW = "deploy-pages.yml"
const PROVIDER_DEPLOY_REF = "main"
const PROVIDER_DEPLOY_MODE = "routine"
const PROVIDER_PAGES_ENVIRONMENT = "github-pages"

function gitBlobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
}

function providerStageCode(stage) {
  if (stage === "auth") return "auth_failed"
  if (stage === "pr") return "pr_failed"
  if (stage === "ci") return "ci_failed"
  if (stage === "merge") return "merge_failed"
  if (stage === "dispatch") return "dispatch_uncertain"
  if (stage === "workflow") return "workflow_failed"
  if (stage === "pages") return "pages_failed"
  if (stage === "smoke") return "smoke_failed"
  return "provider_unavailable"
}

function providerStatusCode(status, diagnostic, stage) {
  if (status === 401 || /(?:^|\D)401(?:\D|$)|unauthori[sz]ed|authentication/u.test(diagnostic)) return "auth_failed"
  if (status === 429 || /rate[ -]?limit|secondary rate/u.test(diagnostic)) return "rate_limited"
  return providerStageCode(stage)
}

function providerFailureCode(error, stage) {
  let supplied = ""
  let status
  let diagnostic = ""
  try {
    if (error && typeof error === "object") {
      if (typeof error.code === "string") supplied = error.code
      if (typeof error.status === "number") status = error.status
      else if (typeof error.statusCode === "number") status = error.statusCode
      else if (typeof error.httpStatus === "number") status = error.httpStatus
      if (typeof error.message === "string") diagnostic = error.message.slice(0, 512)
      if (typeof error.stderr === "string") diagnostic += ` ${error.stderr.slice(0, 512)}`
    }
  } catch {}
  if (supplied === "auth_failed" || supplied === "rate_limited") return supplied
  if (status === 401 || status === 429 || diagnostic) return providerStatusCode(status, diagnostic, stage)
  return providerStageCode(stage)
}

function providerFail(error, stage) {
  if (error instanceof AdapterFailure && [
    "auth_failed",
    "rate_limited",
    "remote_drift",
    "pr_failed",
    "ci_failed",
    "merge_failed",
    "dispatch_uncertain",
    "workflow_failed",
    "pages_failed",
    "smoke_failed",
    "provider_unavailable",
  ].includes(error.code)) return error
  return fail(providerFailureCode(error, stage))
}

function providerOperation(stage, callback) {
  return Promise.resolve().then(callback).catch((error) => {
    throw providerFail(error, stage)
  })
}

function providerId(value, code = "provider_unavailable") {
  if (typeof value !== "string" || !PROVIDER_ID.test(value) || value.includes("..")) throw fail(code)
  return value
}

function providerSha(value, code = "provider_unavailable") {
  return sha(value, code)
}

function providerSafeText(value, code = "provider_unavailable") {
  text(value, code)
  if (/[\u0001-\u001f\u007f]/u.test(value)) throw fail(code)
  return value
}

function canonicalProjectUrl(value, code = "config_invalid") {
  providerSafeText(value, code)
  let parsed
  try { parsed = new URL(value) } catch { throw fail(code) }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") throw fail(code)
  if (!parsed.hostname || !parsed.pathname.startsWith("/") || !parsed.pathname.endsWith("/") || parsed.pathname.includes("..") || parsed.href !== value) throw fail(code)
  return parsed.href
}

function validateProviderConfig(value) {
  const raw = allowedRecord(value, ["actor", "ghConfigDir", "ghExecutable", "projectUrl", "repository"], "config_invalid")
  if (typeof raw.ghExecutable !== "string" || typeof raw.repository !== "string" || typeof raw.actor !== "string") throw fail("config_invalid")
  const executable = ordinaryExecutableSync(raw.ghExecutable, "config_invalid", ["gh", "gh.exe"])
  const repositoryMatch = PROVIDER_REPOSITORY.exec(raw.repository)
  if (!repositoryMatch) throw fail("config_invalid")
  const [, owner, name] = repositoryMatch
  if (!PROVIDER_LOGIN.test(raw.actor)) throw fail("config_invalid")
  let ghConfigDir
  if (raw.ghConfigDir !== undefined) ghConfigDir = ordinaryDirectorySync(raw.ghConfigDir, "config_invalid")
  const canonical = `https://${owner.toLowerCase()}.github.io/${name}/`
  if (raw.projectUrl !== undefined && raw.projectUrl !== canonical) throw fail("config_invalid")
  const projectUrl = canonical
  return Object.freeze({
    actor: raw.actor,
    ghConfigDir: ghConfigDir?.absolute ?? null,
    ghExecutable: executable.absolute,
    projectUrl,
    repository: raw.repository,
    repositoryOwner: owner,
    repositoryName: name,
    ghCwd: path.dirname(executable.absolute),
  })
}

function canonicalHttpUrl(value, code = "http_request_invalid") {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096
    || /[\u0000-\u0020\u007f-\u009f]/u.test(value) || value.includes("?") || value.includes("#")) throw fail(code)
  const authority = value.slice("https://".length).split("/", 1)[0]
  if (authority.includes("@") || /%40/iu.test(authority)) throw fail(code)
  let parsed
  try { parsed = new URL(value) } catch { throw fail(code) }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.search !== "" || parsed.hash !== "" || parsed.hostname === "" || parsed.href !== value) throw fail(code)
  return parsed.href
}

function parseHttpResponse(value) {
  let response
  try { response = exactRecord(value, ["finalUrl", "status"], "http_response_invalid") } catch { throw fail("http_response_invalid") }
  if (typeof response.finalUrl !== "string" || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw fail("http_response_invalid")
  return { finalUrl: response.finalUrl, status: response.status }
}

function executeDefaultHttp(request, requestImplementation = httpsRequest) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer
    let clientRequest
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const rejectCode = (code) => settle(reject, fail(code))
    const parsed = new URL(request.url)
    try {
      clientRequest = requestImplementation({
        protocol: "https:",
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname,
        method: "GET",
        agent: false,
        timeout: request.timeoutMs,
      }, (response) => {
        const status = response.statusCode
        if (!Number.isInteger(status) || status < 100 || status > 599) {
          response.destroy()
          rejectCode("http_response_invalid")
          return
        }
        // This transport projects response metadata only. Destroy the response
        // at the header boundary so no body byte, cookie, or redirect target is
        // captured or followed.
        response.destroy()
        settle(resolve, { status, finalUrl: request.url })
      })
      clientRequest.once("timeout", () => {
        rejectCode("http_timeout")
        clientRequest.destroy()
      })
      clientRequest.once("error", () => rejectCode("http_failed"))
      timer = setTimeout(() => {
        rejectCode("http_timeout")
        clientRequest.destroy()
      }, request.timeoutMs)
      clientRequest.end()
    } catch {
      rejectCode("http_failed")
    }
  })
}

/**
 * Create the bounded anonymous HTTPS status transport. The optional `execute`
 * or `request` function is an internal credential-free test seam; production
 * uses node:https and discards response bytes after enforcing the cap.
 */
export function createBoundedHttpTransport(options = {}) {
  const raw = allowedRecord(options, ["execute", "maxResponseBytes", "request", "timeoutMs"], "transport_config_invalid")
  if (raw.execute !== undefined && typeof raw.execute !== "function") throw fail("transport_config_invalid")
  if (raw.request !== undefined && typeof raw.request !== "function") throw fail("transport_config_invalid")
  if (raw.execute !== undefined && raw.request !== undefined) throw fail("transport_config_invalid")
  const timeoutMs = optionalFiniteBound(raw.timeoutMs, PROVIDER_HTTP_DEFAULT_TIMEOUT_MS, "transport_config_invalid", PROVIDER_HTTP_MAX_TIMEOUT_MS)
  const maxResponseBytes = optionalFiniteBound(raw.maxResponseBytes, PROVIDER_HTTP_DEFAULT_MAX_RESPONSE_BYTES, "transport_config_invalid", PROVIDER_HTTP_MAX_RESPONSE_BYTES)
  const execute = raw.execute ?? ((request) => executeDefaultHttp(request, raw.request ?? httpsRequest))
  const get = async (request) => {
    const supplied = exactRecord(request, ["url", "timeoutMs", "maxResponseBytes", "method"], "http_request_invalid")
    if (supplied.method !== "GET") throw fail("http_request_invalid")
    const url = canonicalHttpUrl(supplied.url)
    const effectiveTimeout = assertFiniteBound(supplied.timeoutMs, "http_request_invalid", PROVIDER_HTTP_MAX_TIMEOUT_MS)
    const effectiveResponseBytes = assertFiniteBound(supplied.maxResponseBytes, "http_request_invalid", PROVIDER_HTTP_MAX_RESPONSE_BYTES)
    const safeRequest = Object.freeze({ url, timeoutMs: effectiveTimeout, maxResponseBytes: effectiveResponseBytes, method: "GET" })
    let response
    try {
      response = await execute(safeRequest)
    } catch (error) {
      if (error instanceof AdapterFailure) throw error
      throw fail("http_failed")
    }
    const normalized = parseHttpResponse(response)
    if (normalized.finalUrl !== url) throw fail("http_response_invalid")
    return normalized
  }
  return Object.freeze({ get })
}

function providerDependencies(value) {
  const raw = allowedRecord(value, ["commandTransport", "httpTransport"], "transport_config_invalid")
  const command = transportRunner(raw.commandTransport)
  if (raw.httpTransport === undefined) return { command, http: createBoundedHttpTransport() }
  if (typeof raw.httpTransport === "function") return { command, http: raw.httpTransport }
  if (!isPlainRecord(raw.httpTransport)) throw fail("transport_config_invalid")
  const descriptor = Object.getOwnPropertyDescriptor(raw.httpTransport, "get")
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") throw fail("transport_config_invalid")
  return { command, http: descriptor.value.bind(raw.httpTransport) }
}

function providerCommandRequest(config, args, { input, mutation = false } = {}) {
  const request = {
    argv: Object.freeze([config.ghExecutable, "api", ...args]),
    cwd: config.ghCwd,
    env: config.ghConfigDir === null ? {} : { GH_CONFIG_DIR: config.ghConfigDir },
    ...(input === undefined ? {} : { input: boundedCommandInput(input, "provider_input_invalid") }),
    maxOutputBytes: PROVIDER_MAX_OUTPUT_BYTES,
    shell: false,
    timeoutMs: mutation ? PROVIDER_MUTATION_TIMEOUT_MS : PROVIDER_READ_TIMEOUT_MS,
  }
  return Object.freeze(request)
}

async function runProviderCommand(config, transport, args, options = {}, stage) {
  const request = providerCommandRequest(config, args, options)
  let value
  try {
    value = typeof transport === "function" ? await transport(request) : await transport.run(request)
    const result = parseCommandResult(value, request.maxOutputBytes)
    if (result.status !== 0) {
      const diagnostic = result.stderr.toString("utf8").slice(0, 2048)
      throw fail(providerStatusCode(result.status, diagnostic, stage))
    }
    return result
  } catch (error) {
    throw providerFail(error, stage)
  }
}

async function readProviderJson(config, transport, args, stage) {
  const result = await runProviderCommand(config, transport, args, {}, stage)
  let value
  try {
    value = JSON.parse(utf8(result.stdout, providerStageCode(stage)))
  } catch {
    throw fail(providerStageCode(stage))
  }
  return value
}

async function runProviderMutation(config, transport, args, body, stage, { allowEmpty = false } = {}) {
  const result = await runProviderCommand(config, transport, args, { input: Buffer.from(JSON.stringify(body), "utf8"), mutation: true }, stage)
  if (!allowEmpty && result.stdout.length === 0) throw fail(providerStageCode(stage))
  return result
}

async function verifyProviderActor(config, transport) {
  const result = await runProviderCommand(config, transport, ["/user", "--jq", ".login"], {}, "auth")
  let login
  try { login = utf8(result.stdout, "auth_failed") } catch { throw fail("auth_failed") }
  if (!login.endsWith("\n")) throw fail("auth_failed")
  login = login.slice(0, -1)
  if (!PROVIDER_LOGIN.test(login) || login !== config.actor) throw fail("auth_failed")
}

function paginatedEndpoint(endpoint, page) {
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=${PROVIDER_PAGE_SIZE}&page=${page}`
}

async function readProviderPages(config, transport, endpoint, stage, collectionKey = null) {
  const all = []
  let expectedTotal
  for (let page = 1; page <= PROVIDER_MAX_PAGES; page += 1) {
    const payload = await readProviderJson(config, transport, [paginatedEndpoint(endpoint, page)], stage)
    let items
    if (collectionKey === null) {
      if (!Array.isArray(payload)) throw fail(providerStageCode(stage))
      items = payload
    } else {
      if (!isPlainRecord(payload) || payload.incomplete_results === true || !Array.isArray(payload[collectionKey])) throw fail(providerStageCode(stage))
      if (payload.total_count !== undefined) {
        if (!Number.isInteger(payload.total_count) || payload.total_count < 0 || payload.total_count > PROVIDER_MAX_ITEMS) throw fail(providerStageCode(stage))
        if (expectedTotal === undefined) expectedTotal = payload.total_count
        else if (expectedTotal !== payload.total_count) throw fail(providerStageCode(stage))
      }
      items = payload[collectionKey]
    }
    if (items.length > PROVIDER_PAGE_SIZE || all.length + items.length > PROVIDER_MAX_ITEMS) throw fail(providerStageCode(stage))
    all.push(...items)
    if (items.length < PROVIDER_PAGE_SIZE) {
      if (expectedTotal !== undefined && all.length !== expectedTotal) throw fail(providerStageCode(stage))
      return all
    }
  }
  throw fail(providerStageCode(stage))
}

function providerPrInput(input, includeId) {
  const keys = includeId
    ? ["base", "branch", "file_set", "head_sha", "map_blob_sha", "map_bytes", "pr_id"]
    : ["base", "branch", "file_set", "head_sha", "map_blob_sha", "map_bytes"]
  const raw = exactRecord(input, keys, "pr_failed")
  if (raw.base !== "main" || typeof raw.branch !== "string" || !BRANCH.test(raw.branch) || !Array.isArray(raw.file_set)
    || raw.file_set.length !== 1 || raw.file_set[0] !== MAP_FILE) throw fail("pr_failed")
  const headSha = providerSha(raw.head_sha, "pr_failed")
  const mapBlobSha = providerSha(raw.map_blob_sha, "pr_failed")
  const mapBytes = copyBytes(raw.map_bytes, "pr_failed")
  if (mapBytes.length === 0 || mapBytes.length > MAX_CANDIDATE_FILE_BYTES || gitBlobSha(mapBytes) !== mapBlobSha) throw fail("pr_failed")
  return {
    base: "main",
    branch: raw.branch,
    file_set: [MAP_FILE],
    head_sha: headSha,
    map_blob_sha: mapBlobSha,
    map_bytes: mapBytes,
    ...(includeId ? { pr_id: providerId(raw.pr_id, "pr_failed") } : {}),
  }
}

function providerPath(config, suffix) {
  return `/repos/${config.repository}${suffix}`
}

function pullRequestSummary(record, expected) {
  if (!isPlainRecord(record)) throw fail("pr_failed")
  let number
  try { number = providerId(String(record.number), "pr_failed") } catch { throw fail("pr_failed") }
  const base = record.base?.ref
  const head = record.head
  if (!isPlainRecord(record.base) || !isPlainRecord(head)
    || typeof base !== "string" || base.length === 0
    || typeof head.ref !== "string" || head.ref.length === 0
    || typeof head.sha !== "string" || !SHA40.test(head.sha)
    || record.state !== "open" || !Object.hasOwn(record, "merged_at") || record.merged_at !== null) throw fail("pr_failed")
  const matches = base === expected.base && head.ref === expected.branch && head.sha === expected.head_sha
  return { number, matches }
}

async function readPullRequest(config, transport, prId, stage) {
  return await readProviderJson(config, transport, [providerPath(config, `/pulls/${encodeURIComponent(prId)}`)], stage)
}

function decodeProviderBase64(value, code) {
  if (typeof value !== "string" || value.length > PROVIDER_MAX_OUTPUT_BYTES || !/^[A-Za-z0-9+/=\r\n ]*$/u.test(value)) throw fail(code)
  const compact = value.replace(/[\r\n ]/gu, "")
  if (compact.length === 0 || compact.length % 4 === 1) throw fail(code)
  const bytes = Buffer.from(compact, "base64")
  const canonical = bytes.toString("base64")
  if (canonical.replace(/=+$/u, "") !== compact.replace(/=+$/u, "")) throw fail(code)
  return bytes
}

async function readMappingProjection(config, transport, input) {
  const pull = await readPullRequest(config, transport, input.pr_id, "pr")
  const summary = pullRequestSummary(pull, input)
  if (!summary.matches || summary.number !== input.pr_id) throw fail("pr_failed")
  const files = await readProviderPages(config, transport, providerPath(config, `/pulls/${encodeURIComponent(input.pr_id)}/files`), "pr")
  const names = []
  for (const file of files) {
    if (!isPlainRecord(file) || typeof file.filename !== "string" || names.includes(file.filename)) throw fail("pr_failed")
    names.push(file.filename)
  }
  names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  if (JSON.stringify(names) !== JSON.stringify([MAP_FILE])) throw fail("pr_failed")
  const content = await readProviderJson(config, transport, [providerPath(config, `/contents/${MAP_FILE}?ref=${encodeURIComponent(input.head_sha)}`)], "pr")
  if (!isPlainRecord(content) || content.type !== "file" || content.path !== MAP_FILE || content.encoding !== "base64" || typeof content.content !== "string") throw fail("pr_failed")
  const mapBytes = decodeProviderBase64(content.content, "pr_failed")
  if (content.sha !== input.map_blob_sha || gitBlobSha(mapBytes) !== input.map_blob_sha || !mapBytes.equals(input.map_bytes)) throw fail("pr_failed")
  return {
    pr_id: input.pr_id,
    base: "main",
    branch: input.branch,
    head_sha: input.head_sha,
    file_set: [MAP_FILE],
    map_blob_sha: input.map_blob_sha,
    map_bytes: mapBytes,
    state: "open",
    merged: false,
  }
}

async function listMatchingPrs(config, transport, input) {
  const entries = await readProviderPages(
    config,
    transport,
    providerPath(config, `/pulls?state=open&base=main&head=${encodeURIComponent(`${config.repositoryOwner}:${input.branch}`)}`),
    "pr",
  )
  const seen = new Set()
  const matches = []
  for (const entry of entries) {
    const summary = pullRequestSummary(entry, input)
    if (seen.has(summary.number)) throw fail("pr_failed")
    seen.add(summary.number)
    if (summary.matches) matches.push(await readMappingProjection(config, transport, { ...input, pr_id: summary.number }))
  }
  return matches
}

async function createMappingPr(config, transport, input) {
  const body = { title: "Update site-content.yml", head: input.branch, base: "main", body: "" }
  const result = await runProviderMutation(config, transport, [providerPath(config, "/pulls"), "--method", "POST", "--input", "-"], body, "pr")
  let response
  try { response = JSON.parse(utf8(result.stdout, "pr_failed")) } catch { throw fail("pr_failed") }
  if (!isPlainRecord(response)) throw fail("pr_failed")
  return { pr_id: providerId(String(response.number), "pr_failed") }
}

async function readRequiredCi(config, transport, input) {
  const value = exactRecord(input, ["head_sha", "job", "workflow"], "ci_failed")
  const headSha = providerSha(value.head_sha, "ci_failed")
  if (value.workflow !== PROVIDER_MAPPING_WORKFLOW || value.job !== PROVIDER_MAPPING_JOB) throw fail("ci_failed")
  const runs = await readProviderPages(config, transport, providerPath(config, `/actions/workflows/${encodeURIComponent(value.workflow)}/runs?head_sha=${encodeURIComponent(headSha)}`), "ci", "workflow_runs")
  const matchingRuns = []
  for (const run of runs) {
    if (!isPlainRecord(run) || typeof run.path !== "string" || typeof run.head_sha !== "string" || run.path !== PROVIDER_WORKFLOW_PATH(value.workflow) || run.head_sha !== headSha) throw fail("ci_failed")
    const id = providerId(String(run.id), "ci_failed")
    if (matchingRuns.some((entry) => entry.id === id)) throw fail("ci_failed")
    matchingRuns.push({ id })
  }
  if (matchingRuns.length !== 1) throw fail("ci_failed")
  const jobs = await readProviderPages(config, transport, providerPath(config, `/actions/runs/${encodeURIComponent(matchingRuns[0].id)}/jobs`), "ci", "jobs")
  const matchingJobs = jobs.filter((job) => isPlainRecord(job) && job.name === value.job)
  if (matchingJobs.length !== 1) throw fail("ci_failed")
  const job = matchingJobs[0]
  if (job.status !== "completed" || job.conclusion !== "success") throw fail("ci_failed")
  return { head_sha: headSha, workflow: value.workflow, job: value.job, status: "completed", conclusion: "success" }
}

function mergeInput(input, includeMergeSha = false) {
  const keys = includeMergeSha ? ["expected_head_sha", "merge_sha", "pr_id"] : ["expected_head_sha", "pr_id"]
  const value = exactRecord(input, keys, "merge_failed")
  return {
    expected_head_sha: providerSha(value.expected_head_sha, "merge_failed"),
    pr_id: providerId(value.pr_id, "merge_failed"),
    ...(includeMergeSha ? { merge_sha: providerSha(value.merge_sha, "merge_failed") } : {}),
  }
}

function pullMergeProjection(pull, input) {
  if (!isPlainRecord(pull) || String(pull.number) !== input.pr_id || !isPlainRecord(pull.base) || pull.base.ref !== "main"
    || !isPlainRecord(pull.head) || typeof pull.head.ref !== "string" || pull.head.ref.length === 0
    || pull.head.sha !== input.expected_head_sha || !Object.hasOwn(pull, "merged_at") || !Object.hasOwn(pull, "merge_commit_sha")
    || (pull.merged_at !== null && typeof pull.merged_at !== "string")) throw fail("merge_failed")
  const merged = pull.merged_at !== null
  if (!merged) {
    if (pull.merge_commit_sha !== null) throw fail("merge_failed")
    return null
  }
  const mergeSha = providerSha(pull.merge_commit_sha, "merge_failed")
  return { pr_id: input.pr_id, base: "main", head_sha: input.expected_head_sha, merged: true, merge_sha: mergeSha }
}

async function listMergedPrs(config, transport, input) {
  const value = mergeInput(input)
  const pull = await readPullRequest(config, transport, value.pr_id, "merge")
  const projection = pullMergeProjection(pull, value)
  return projection === null ? [] : [projection]
}

async function squashMergePr(config, transport, input) {
  const value = mergeInput(input)
  const result = await runProviderMutation(config, transport, [providerPath(config, `/pulls/${encodeURIComponent(value.pr_id)}/merge`), "--method", "PUT", "--input", "-"], {
    sha: value.expected_head_sha,
    merge_method: "squash",
  }, "merge")
  let response
  try { response = JSON.parse(utf8(result.stdout, "merge_failed")) } catch { throw fail("merge_failed") }
  if (!isPlainRecord(response) || response.merged !== true) throw fail("merge_failed")
  return { merge_sha: providerSha(response.sha, "merge_failed") }
}

async function readMerge(config, transport, input) {
  const value = mergeInput(input, true)
  const pull = await readPullRequest(config, transport, value.pr_id, "merge")
  const projection = pullMergeProjection(pull, value)
  if (projection === null || projection.merge_sha !== value.merge_sha) throw fail("merge_failed")
  return projection
}

function deploymentRunInput(input, includeSiteCommit = false) {
  const keys = includeSiteCommit
    ? ["head_sha", "id", "publication_mode", "ref", "site_commit", "workflow"]
    : ["head_sha", "ref", "run_name", "workflow"]
  const failureCode = includeSiteCommit ? "workflow_failed" : "dispatch_uncertain"
  const value = exactRecord(input, keys, failureCode)
  const headSha = providerSha(value.head_sha, failureCode)
  if (value.workflow !== PROVIDER_DEPLOY_WORKFLOW || value.ref !== PROVIDER_DEPLOY_REF) throw fail(failureCode)
  if (includeSiteCommit) {
    const siteCommit = providerSha(value.site_commit, "workflow_failed")
    const runId = providerId(value.id, "workflow_failed")
    if (value.publication_mode !== PROVIDER_DEPLOY_MODE) throw fail("workflow_failed")
    return { head_sha: headSha, id: runId, publication_mode: PROVIDER_DEPLOY_MODE, ref: PROVIDER_DEPLOY_REF, site_commit: siteCommit, workflow: PROVIDER_DEPLOY_WORKFLOW }
  }
  if (typeof value.run_name !== "string" || !PROVIDER_RUN_NAME.test(value.run_name)) throw fail(failureCode)
  return { head_sha: headSha, ref: PROVIDER_DEPLOY_REF, run_name: value.run_name, workflow: PROVIDER_DEPLOY_WORKFLOW }
}

async function listDeploymentRuns(config, transport, input) {
  const value = deploymentRunInput(input)
  const runs = await readProviderPages(config, transport, providerPath(config, `/actions/workflows/${encodeURIComponent(value.workflow)}/runs?branch=${encodeURIComponent(value.ref)}&head_sha=${encodeURIComponent(value.head_sha)}`), "dispatch", "workflow_runs")
  const ids = []
  const seen = new Set()
  for (const run of runs) {
    if (!isPlainRecord(run) || typeof run.path !== "string" || typeof run.head_branch !== "string" || typeof run.head_sha !== "string" || typeof run.display_title !== "string") throw fail("dispatch_uncertain")
    const id = providerId(String(run.id), "dispatch_uncertain")
    if (seen.has(id)) throw fail("dispatch_uncertain")
    seen.add(id)
    if (run.path !== PROVIDER_WORKFLOW_PATH(value.workflow) || run.head_branch !== value.ref || run.head_sha !== value.head_sha || run.display_title !== value.run_name) continue
    ids.push(id)
  }
  return ids.map((id) => ({ id }))
}

async function readMainHead(config, transport, stage) {
  const response = await readProviderJson(config, transport, [providerPath(config, "/git/ref/heads/main")], stage)
  if (!isPlainRecord(response) || response.ref !== "refs/heads/main" || !isPlainRecord(response.object) || response.object.type !== "commit") throw fail(providerStageCode(stage))
  return providerSha(response.object.sha, providerStageCode(stage))
}

async function dispatchDeployment(config, transport, input) {
  const value = exactRecord(input, ["expected_head_sha", "inputs", "ref", "run_name", "workflow"], "dispatch_uncertain")
  const expectedHeadSha = providerSha(value.expected_head_sha, "dispatch_uncertain")
  if (value.workflow !== PROVIDER_DEPLOY_WORKFLOW || value.ref !== PROVIDER_DEPLOY_REF || typeof value.run_name !== "string" || !PROVIDER_RUN_NAME.test(value.run_name)) throw fail("dispatch_uncertain")
  if (!isPlainRecord(value.inputs) || Object.getOwnPropertyNames(value.inputs).sort().join("|") !== "publication_mode|site_commit" || value.inputs.publication_mode !== PROVIDER_DEPLOY_MODE) throw fail("dispatch_uncertain")
  const siteCommit = providerSha(value.inputs.site_commit, "dispatch_uncertain")
  const expectedRunName = `Deploy GitHub Pages ${siteCommit} (${PROVIDER_DEPLOY_MODE})`
  if (value.run_name !== expectedRunName) throw fail("dispatch_uncertain")
  const currentHead = await readMainHead(config, transport, "dispatch")
  if (currentHead !== expectedHeadSha) throw fail("remote_drift")
  await runProviderMutation(config, transport, [providerPath(config, `/actions/workflows/${encodeURIComponent(value.workflow)}/dispatches`), "--method", "POST", "--input", "-"], {
    ref: PROVIDER_DEPLOY_REF,
    inputs: { site_commit: siteCommit, publication_mode: PROVIDER_DEPLOY_MODE },
  }, "dispatch", { allowEmpty: true })
  return { accepted: true }
}

async function readDeploymentRun(config, transport, input) {
  const value = deploymentRunInput(input, true)
  const response = await readProviderJson(config, transport, [providerPath(config, `/actions/runs/${encodeURIComponent(value.id)}`)], "workflow")
  const runName = `Deploy GitHub Pages ${value.site_commit} (${value.publication_mode})`
  if (!isPlainRecord(response) || String(response.id) !== value.id || response.path !== PROVIDER_WORKFLOW_PATH(value.workflow)
    || response.head_branch !== value.ref || response.head_sha !== value.head_sha || response.display_title !== runName
    || response.status !== "completed" || response.conclusion !== "success") throw fail("workflow_failed")
  return {
    id: value.id,
    workflow: PROVIDER_DEPLOY_WORKFLOW,
    ref: PROVIDER_DEPLOY_REF,
    head_sha: value.head_sha,
    run_name: runName,
    inputs: { site_commit: value.site_commit, publication_mode: PROVIDER_DEPLOY_MODE },
    status: "completed",
    conclusion: "success",
  }
}

function strictProviderRecordId(value, code = "pages_failed") {
  if (typeof value !== "string" && typeof value !== "number") throw fail(code)
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 1)) throw fail(code)
  return providerId(String(value), code)
}

function statusRunIdFromLogUrl(value, config) {
  if (typeof value !== "string") throw fail("pages_failed")
  let parsed
  try { parsed = new URL(value) } catch { throw fail("pages_failed") }
  const pathPrefix = `/${config.repository}/actions/runs/`
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port !== "" || parsed.username !== "" || parsed.password !== ""
    || parsed.search !== "" || parsed.hash !== "" || parsed.href !== value || !parsed.pathname.startsWith(pathPrefix)) throw fail("pages_failed")
  const match = /^([1-9][0-9]*)\/job\/[1-9][0-9]*$/u.exec(parsed.pathname.slice(pathPrefix.length))
  if (!match) throw fail("pages_failed")
  return match[1]
}

function pagesRunHead(response, runId, siteCommit) {
  if (!isPlainRecord(response) || !Object.hasOwn(response, "id")) throw fail("pages_failed")
  const responseId = strictProviderRecordId(response.id)
  const expectedTitle = `Deploy GitHub Pages ${siteCommit} (${PROVIDER_DEPLOY_MODE})`
  if (responseId !== runId || response.path !== PROVIDER_WORKFLOW_PATH(PROVIDER_DEPLOY_WORKFLOW)
    || response.head_branch !== PROVIDER_DEPLOY_REF || response.display_title !== expectedTitle
    || response.status !== "completed" || response.conclusion !== "success") throw fail("pages_failed")
  return providerSha(response.head_sha, "pages_failed")
}

function deploymentStatusShape(status, config, runId, seenIds) {
  if (!isPlainRecord(status) || !Object.hasOwn(status, "id") || !Object.hasOwn(status, "state")) throw fail("pages_failed")
  const id = strictProviderRecordId(status.id)
  if (seenIds.has(id)) throw fail("pages_failed")
  seenIds.add(id)
  if (typeof status.state !== "string") throw fail("pages_failed")
  if (status.state === "success") {
    if (status.environment_url !== config.projectUrl) throw fail("pages_failed")
    return statusRunIdFromLogUrl(status.log_url, config) === runId
  }
  if (!["inactive", "queued", "in_progress", "waiting"].includes(status.state)) throw fail("pages_failed")
  if (Object.hasOwn(status, "environment_url") && status.environment_url !== null && typeof status.environment_url !== "string") throw fail("pages_failed")
  if (Object.hasOwn(status, "log_url") && status.log_url !== null && typeof status.log_url !== "string") throw fail("pages_failed")
  return false
}

async function readPagesDeployment(config, transport, input) {
  const value = exactRecord(input, ["run_id", "site_commit"], "pages_failed")
  const runId = providerId(value.run_id, "pages_failed")
  const siteCommit = providerSha(value.site_commit, "pages_failed")
  const run = await readProviderJson(config, transport, [providerPath(config, `/actions/runs/${encodeURIComponent(runId)}`)], "pages")
  const headSha = pagesRunHead(run, runId, siteCommit)
  const deployments = await readProviderPages(config, transport, providerPath(config, `/deployments?sha=${encodeURIComponent(headSha)}&environment=${encodeURIComponent(PROVIDER_PAGES_ENVIRONMENT)}`), "pages")
  const candidates = []
  const seenDeploymentIds = new Set()
  for (const deployment of deployments) {
    if (!isPlainRecord(deployment) || !Object.hasOwn(deployment, "id")) throw fail("pages_failed")
    const id = strictProviderRecordId(deployment.id)
    if (seenDeploymentIds.has(id)) throw fail("pages_failed")
    seenDeploymentIds.add(id)
    if (providerSha(deployment.sha, "pages_failed") !== headSha || deployment.ref !== PROVIDER_DEPLOY_REF
      || deployment.task !== "deploy" || deployment.environment !== PROVIDER_PAGES_ENVIRONMENT) throw fail("pages_failed")
    candidates.push({ id })
  }
  if (candidates.length === 0) throw fail("pages_failed")
  const matchingDeployments = []
  for (const candidate of candidates) {
    const statuses = await readProviderPages(config, transport, providerPath(config, `/deployments/${encodeURIComponent(candidate.id)}/statuses`), "pages")
    const seenStatusIds = new Set()
    let matchingSuccesses = 0
    for (const status of statuses) {
      if (deploymentStatusShape(status, config, runId, seenStatusIds)) matchingSuccesses += 1
    }
    if (matchingSuccesses > 1) throw fail("pages_failed")
    if (matchingSuccesses === 1) matchingDeployments.push(candidate)
  }
  if (matchingDeployments.length !== 1) throw fail("pages_failed")
  return {
    deployment_id: matchingDeployments[0].id,
    run_id: runId,
    site_commit: siteCommit,
    status: "success",
    url: config.projectUrl,
  }
}

function smokeTarget(value, config) {
  const target = exactRecord(value, ["deployment_id", "run_id", "site_commit", "status", "url"], "smoke_failed")
  providerId(target.deployment_id, "smoke_failed")
  providerId(target.run_id, "smoke_failed")
  providerSha(target.site_commit, "smoke_failed")
  if (target.status !== "success" || target.url !== config.projectUrl) throw fail("smoke_failed")
  return { ...target }
}

function smokeRouteUrl(config, route) {
  if (typeof route !== "string" || route.length === 0 || route.length > 2_048 || !route.startsWith("/") || route.startsWith("//")
    || route.includes("\\") || route.includes("?") || route.includes("#") || route.includes("%")
    || /[\u0000-\u0020\u007f-\u009f]/u.test(route) || route.normalize("NFC") !== route) throw fail("smoke_failed")
  if (route === "/") return config.projectUrl
  const segments = route.slice(1).split("/")
  const last = segments.at(-1)
  const bodySegments = last === "" ? segments.slice(0, -1) : segments
  if (bodySegments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) throw fail("smoke_failed")
  const base = new URL(config.projectUrl)
  const expected = `${config.projectUrl}${route.slice(1)}`
  let url
  try { url = new URL(expected) } catch { throw fail("smoke_failed") }
  if (url.origin !== base.origin || url.search !== "" || url.hash !== "" || url.href !== expected
    || url.pathname !== `${base.pathname}${route.slice(1)}`) throw fail("smoke_failed")
  return url.href
}

function smokeAssetUrl(config, asset) {
  if (typeof asset !== "string" || asset.length === 0 || asset.length > 2_048 || !SAFE_RELATIVE.test(asset)
    || asset.includes("%") || /[\u0000-\u0020\u007f-\u009f]/u.test(asset) || asset.normalize("NFC") !== asset
    || !/\.(?:css|js)$/u.test(asset)) throw fail("smoke_failed")
  const base = new URL(config.projectUrl)
  const expected = `${config.projectUrl}${asset}`
  let url
  try { url = new URL(expected) } catch { throw fail("smoke_failed") }
  if (url.origin !== base.origin || url.search !== "" || url.hash !== "" || url.href !== expected
    || url.pathname !== `${base.pathname}${asset}`) throw fail("smoke_failed")
  return url.href
}

async function httpStatus(get, url) {
  let value
  try { value = await get({ url, timeoutMs: PROVIDER_SMOKE_TIMEOUT_MS, maxResponseBytes: 1, method: "GET" }) } catch { throw fail("smoke_failed") }
  let response
  try { response = exactRecord(value, ["finalUrl", "status"], "smoke_failed") } catch { throw fail("smoke_failed") }
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599 || response.finalUrl !== url) throw fail("smoke_failed")
  return response.status
}

async function anonymousSmoke(config, http, input) {
  const value = exactRecord(input, ["assets", "not_found", "routes", "target"], "smoke_failed")
  const target = smokeTarget(value.target, config)
  if (!Array.isArray(value.routes) || !Array.isArray(value.assets) || !isPlainRecord(value.not_found)) throw fail("smoke_failed")
  const notFound = exactRecord(value.not_found, ["expected_status", "path"], "smoke_failed")
  if (notFound.expected_status !== 404 || notFound.path !== "/__t13_missing__") throw fail("smoke_failed")
  if (value.routes.length + value.assets.length + 2 > PROVIDER_MAX_SMOKE_REQUESTS) throw fail("smoke_failed")
  const routeUrls = value.routes.map((route) => smokeRouteUrl(config, route))
  const assetUrls = value.assets.map((asset) => smokeAssetUrl(config, asset))
  if (new Set(routeUrls).size !== routeUrls.length || new Set(assetUrls).size !== assetUrls.length) throw fail("smoke_failed")
  const homepageStatus = await httpStatus(http, config.projectUrl)
  const routeStatuses = []
  for (const url of routeUrls) routeStatuses.push(await httpStatus(http, url))
  const assetStatuses = []
  for (const url of assetUrls) assetStatuses.push(await httpStatus(http, url))
  const notFoundStatus = await httpStatus(http, smokeRouteUrl(config, notFound.path))
  return {
    target,
    homepage_status: homepageStatus,
    route_statuses: routeStatuses,
    asset_statuses: assetStatuses,
    not_found_status: notFoundStatus,
  }
}

export async function createRoutinePublicationProviderCapabilities(config, dependencies = {}) {
  const validated = validateProviderConfig(config)
  const { command, http } = providerDependencies(dependencies)
  await verifyProviderActor(validated, command)
  const capabilities = {
    async listMatchingMappingPrs(input) {
      return await providerOperation("pr", async () => await listMatchingPrs(validated, command, providerPrInput(input, false)))
    },
    async createMappingPr(input) {
      return await providerOperation("pr", async () => await createMappingPr(validated, command, providerPrInput(input, false)))
    },
    async readMappingPr(input) {
      return await providerOperation("pr", async () => await readMappingProjection(validated, command, providerPrInput(input, true)))
    },
    async readRequiredCi(input) {
      return await providerOperation("ci", async () => await readRequiredCi(validated, command, input))
    },
    async listMergedMappingPrs(input) {
      return await providerOperation("merge", async () => await listMergedPrs(validated, command, input))
    },
    async squashMergeMappingPr(input) {
      return await providerOperation("merge", async () => await squashMergePr(validated, command, input))
    },
    async readMerge(input) {
      return await providerOperation("merge", async () => await readMerge(validated, command, input))
    },
    async listMatchingDeploymentRuns(input) {
      return await providerOperation("dispatch", async () => await listDeploymentRuns(validated, command, input))
    },
    async dispatchDeployment(input) {
      return await providerOperation("dispatch", async () => await dispatchDeployment(validated, command, input))
    },
    async readDeploymentRun(input) {
      return await providerOperation("workflow", async () => await readDeploymentRun(validated, command, input))
    },
    async readPagesDeployment(input) {
      return await providerOperation("pages", async () => await readPagesDeployment(validated, command, input))
    },
    async anonymousSmoke(input) {
      return await providerOperation("smoke", async () => await anonymousSmoke(validated, http, input))
    },
  }
  return capabilities
}

/**
 * Build the two capability seams consumed by routinePublicationHandoff.
 *
 * The factory is deliberately only composition: local Git and GitHub
 * transports remain capability implementations, while the handoff module
 * remains the sole publication controller. A single bounded command
 * transport is shared by both capabilities so environment and lifecycle
 * policy is constructed at one boundary.
 */
export async function createRoutinePublicationAdapter(config, dependencies = {}) {
  const raw = allowedRecord(config, [
    "actor",
    "candidateRoot",
    "ghConfigDir",
    "ghExecutable",
    "ghPagesRef",
    "gitExecutable",
    "gitRoot",
    "mainRef",
    "operationRoot",
    "projectUrl",
    "remote",
    "repository",
  ], "config_invalid")
  const required = [
    "actor",
    "ghConfigDir",
    "ghExecutable",
    "ghPagesRef",
    "gitExecutable",
    "gitRoot",
    "mainRef",
    "operationRoot",
    "remote",
    "repository",
  ]
  for (const key of required) {
    if (!Object.hasOwn(raw, key)) throw fail("config_invalid")
  }
  const rawDependencies = allowedRecord(dependencies, ["commandTransport", "httpTransport"], "transport_config_invalid")
  const commandTransport = rawDependencies.commandTransport ?? createBoundedCommandTransport()
  const localGit = createRoutinePublicationLocalGitCapabilities({
    ...(raw.candidateRoot === undefined ? {} : { candidateRoot: raw.candidateRoot }),
    gitExecutable: raw.gitExecutable,
    gitRoot: raw.gitRoot,
    remote: raw.remote,
    mainRef: raw.mainRef,
    ghPagesRef: raw.ghPagesRef,
    operationRoot: raw.operationRoot,
  }, { commandTransport })
  const provider = await createRoutinePublicationProviderCapabilities({
    actor: raw.actor,
    ghExecutable: raw.ghExecutable,
    ...(raw.ghConfigDir === undefined ? {} : { ghConfigDir: raw.ghConfigDir }),
    ...(raw.projectUrl === undefined ? {} : { projectUrl: raw.projectUrl }),
    repository: raw.repository,
  }, {
    commandTransport,
    ...(rawDependencies.httpTransport === undefined ? {} : { httpTransport: rawDependencies.httpTransport }),
  })
  return { localGit, provider }
}
