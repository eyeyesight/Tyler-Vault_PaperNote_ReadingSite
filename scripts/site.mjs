import { constants } from "node:fs"
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { TextDecoder } from "node:util"
import { canonicalPath, isEqualToOrInside, pathsOverlap } from "../lib/filesystem-safety.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const defaultSource = path.join(repoRoot, "fixtures", "synthetic-content")
const defaultOutput = path.join(repoRoot, ".artifacts", "synthetic-site")
const toolchainRoot = path.join(repoRoot, ".quartz-toolchain")
const toolchainMetadataPath = path.join(repoRoot, "config", "quartz-toolchain.json")

class CliError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const [command, ...rest] = argv
  if (!command || !["preflight", "build", "verify", "serve"].includes(command)) {
    throw new CliError("USAGE", "expected one command: preflight, build, verify, or serve")
  }
  const options = {
    command,
    source: defaultSource,
    output: defaultOutput,
    vaultRoot: process.env.TYLER_VAULT_ROOT ?? "",
    port: 8080,
  }
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!flag?.startsWith("--") || value === undefined) {
      throw new CliError("USAGE", `flag ${flag ?? "<missing>"} requires a value`)
    }
    if (flag === "--source") options.source = value
    else if (flag === "--output") options.output = value
    else if (flag === "--vault-root") options.vaultRoot = value
    else if (flag === "--port") {
      const port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65534) {
        throw new CliError("USAGE", "--port must be an integer from 1 through 65534")
      }
      options.port = port
    } else {
      throw new CliError("USAGE", `unknown flag ${flag}`)
    }
  }
  return options
}


/** @type {[string, Buffer][]} */
const forbiddenSourceMagic = [
  ["PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ["JPEG", Buffer.from([0xff, 0xd8, 0xff])],
  ["GIF87a", Buffer.from("GIF87a", "ascii")],
  ["GIF89a", Buffer.from("GIF89a", "ascii")],
  ["TIFF little-endian", Buffer.from([0x49, 0x49, 0x2a, 0x00])],
  ["TIFF big-endian", Buffer.from([0x4d, 0x4d, 0x00, 0x2a])],
  ["PDF", Buffer.from("%PDF-", "ascii")],
  ["ZIP", Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  ["empty ZIP", Buffer.from([0x50, 0x4b, 0x05, 0x06])],
  ["spanned ZIP", Buffer.from([0x50, 0x4b, 0x07, 0x08])],
]

/** @param {Buffer} bytes */
function forbiddenMagicName(bytes) {
  for (const [name, signature] of forbiddenSourceMagic) {
    if (bytes.subarray(0, signature.length).equals(signature)) return name
  }
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).equals(Buffer.from("RIFF", "ascii"))
    && bytes.subarray(8, 12).equals(Buffer.from("WEBP", "ascii"))
  ) return "WebP"
  return undefined
}

/**
 * T01's intentionally narrow source gate. It does not implement publication
 * manifests: it only prevents assets/binary input from ever reaching Quartz
 * (and therefore sharp). Every entry is inspected before any build mutation.
 * @param {string} source
 */
async function validateSourceTree(source) {
  const root = await realpath(source)
  /** @param {string} directory */
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute)
      const metadata = await lstat(absolute)
      if (metadata.isSymbolicLink()) {
        throw new CliError("SOURCE_LINK_NOT_ALLOWED", `source contains a symlink or reparse point: ${relative}`)
      }
      if (metadata.isDirectory()) {
        const resolved = await realpath(absolute)
        if (!isEqualToOrInside(root, resolved)) {
          throw new CliError("SOURCE_LINK_NOT_ALLOWED", `source directory escapes its root: ${relative}`)
        }
        await walk(resolved)
        continue
      }
      if (!metadata.isFile() || path.extname(entry.name).toLowerCase() !== ".md") {
        throw new CliError("SOURCE_FILE_CLASS_NOT_ALLOWED", `source accepts regular .md files only: ${relative}`)
      }
      const resolved = await realpath(absolute)
      if (!isEqualToOrInside(root, resolved)) {
        throw new CliError("SOURCE_LINK_NOT_ALLOWED", `source file escapes its root: ${relative}`)
      }
      const bytes = await readFile(resolved)
      const magic = forbiddenMagicName(bytes)
      if (magic) {
        throw new CliError("SOURCE_BINARY_MAGIC_NOT_ALLOWED", `${relative} has forbidden ${magic} magic bytes`)
      }
      if (bytes.includes(0)) {
        throw new CliError("SOURCE_NUL_NOT_ALLOWED", `source Markdown contains a NUL byte: ${relative}`)
      }
      let markdown
      try {
        markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        throw new CliError("SOURCE_INVALID_UTF8", `source Markdown is not valid UTF-8: ${relative}`)
      }
      if (markdown.includes("![") || /<img\b/i.test(markdown)) {
        throw new CliError("SOURCE_IMAGE_EMBED_NOT_ALLOWED", `source Markdown contains an image embed: ${relative}`)
      }
    }
  }
  await walk(root)
}

/**
 * Public safety seam. It performs only reads and returns canonical safe paths.
 * No staging directory, output directory, or receipt is created before this
 * completes successfully.
 * @param {{source:string, output:string, vaultRoot:string}} options
 */
async function preflight(options) {
  if (!options.vaultRoot) {
    throw new CliError("CANONICAL_VAULT_ROOT_REQUIRED", "set --vault-root or TYLER_VAULT_ROOT")
  }

  let vaultRoot
  try {
    vaultRoot = await realpath(path.resolve(options.vaultRoot))
    if (!(await stat(vaultRoot)).isDirectory()) throw new Error("not a directory")
  } catch {
    throw new CliError("INVALID_CANONICAL_VAULT_ROOT", "canonical Vault root must be an existing directory")
  }

  const [source, output] = await Promise.all([
    canonicalPath(options.source),
    canonicalPath(options.output),
  ])

  const guardedPaths = [
    ["canonical Vault root", vaultRoot],
    ["source", source],
    ["output", output],
  ]
  for (let firstIndex = 0; firstIndex < guardedPaths.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < guardedPaths.length; secondIndex += 1) {
      const [firstRole, firstPath] = guardedPaths[firstIndex]
      const [secondRole, secondPath] = guardedPaths[secondIndex]
      if (!pathsOverlap(firstPath, secondPath)) continue
      throw new CliError(
        "PATH_OVERLAP_NOT_ALLOWED",
        `${firstRole} and ${secondRole} must be disjoint; equal, ancestor, and descendant paths are not allowed`,
      )
    }
  }

  try {
    if (!(await stat(source)).isDirectory()) throw new Error("not a directory")
    await access(source, constants.R_OK)
  } catch {
    throw new CliError("INVALID_SOURCE", "source must be a readable existing directory")
  }

  await validateSourceTree(source)

  return { source, output, vaultRoot }
}

async function readToolchainMetadata() {
  const metadata = JSON.parse(await readFile(toolchainMetadataPath, "utf8"))
  if (
    !/^\d+\.\d+\.\d+$/.test(metadata.version)
    || !/^[0-9a-f]{40}$/.test(metadata.commit)
    || !/^[0-9a-f]{64}$/.test(metadata.defaultIconSha256)
  ) {
    throw new CliError("INVALID_TOOLCHAIN_METADATA", "Quartz metadata is not pinned")
  }
  return metadata
}

async function locateInstalledQuartz() {
  const packageJsonUrl = import.meta.resolve("@jackyzha0/quartz/package.json")
  const packageJsonPath = fileURLToPath(packageJsonUrl)
  return path.dirname(packageJsonPath)
}

/** Materialize the pinned git dependency into Quartz's expected repository layout. */
/** @param {{version:string, commit:string, defaultIconSha256:string}} metadata */
async function ensureToolchain(metadata) {
  const markerPath = path.join(toolchainRoot, ".tyler-toolchain.json")
  const installedRoot = await locateInstalledQuartz()
  const installedPackage = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"))
  if (installedPackage.version !== metadata.version) {
    throw new CliError("QUARTZ_VERSION_MISMATCH", "installed Quartz does not match config/quartz-toolchain.json")
  }
  const iconPath = path.join(installedRoot, "quartz", "static", "icon.png")
  const installedIconSha256 = createHash("sha256").update(await readFile(iconPath)).digest("hex")
  if (installedIconSha256 !== metadata.defaultIconSha256) {
    throw new CliError("QUARTZ_ICON_HASH_MISMATCH", "installed Quartz default icon.png does not match config/quartz-toolchain.json")
  }

  await rm(toolchainRoot, { recursive: true, force: true })
  await mkdir(toolchainRoot, { recursive: true })
  await Promise.all([
    cp(path.join(installedRoot, "quartz"), path.join(toolchainRoot, "quartz"), { recursive: true }),
    cp(path.join(installedRoot, "quartz.ts"), path.join(toolchainRoot, "quartz.ts")),
    cp(path.join(installedRoot, "package.json"), path.join(toolchainRoot, "package.json")),
  ])
  const defaultConfig = await readFile(path.join(installedRoot, "quartz.config.default.yaml"), "utf8")
  const projectConfig = defaultConfig
    .replace("pageTitle: Quartz 5", "pageTitle: Synthetic Reading Site")
    .replace("baseUrl: quartz.jzhao.xyz", "baseUrl: example.invalid")
  await writeFile(path.join(toolchainRoot, "quartz.config.yaml"), projectConfig)
  await writeFile(markerPath, `${JSON.stringify({
    version: metadata.version,
    commit: metadata.commit,
    defaultIconSha256: metadata.defaultIconSha256,
  }, null, 2)}\n`)
}

/** @param {string[]} args */
async function spawnQuartz(args) {
  const executable = path.join(toolchainRoot, "quartz", "bootstrap-cli.mjs")
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: toolchainRoot,
    env: process.env,
    stdio: "inherit",
  })
  return await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) reject(new CliError("QUARTZ_SIGNAL", `Quartz stopped by ${signal}`))
      else resolve(code ?? 1)
    })
  })
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".webp", "image/webp"],
  [".xml", "application/xml; charset=utf-8"],
])

/** Watch only the direct launcher. Automation invokes this file directly, so
 * terminating its tracked process also terminates the socket-owning process. */
function parentPidsToWatch() {
  return process.ppid > 1 ? [process.ppid] : []
}

/** @param {number} pid */
function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM")
  }
}

/** @param {string} root @param {string} requestUrl */
async function resolveStaticFile(root, requestUrl) {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname)
  } catch {
    throw new CliError("BAD_HTTP_PATH", "request path is not valid UTF-8")
  }
  if (pathname.includes("\0")) throw new CliError("BAD_HTTP_PATH", "request path contains a null byte")
  if (pathname.includes("\\")) throw new CliError("BAD_HTTP_PATH", "request path contains a backslash")
  const relative = pathname.replace(/^\/+/, "")
  const candidates = relative === ""
    ? ["index.html"]
    : relative.endsWith("/")
      ? [path.join(relative, "index.html")]
      : path.extname(relative)
        ? [relative]
        : [`${relative}.html`, path.join(relative, "index.html")]

  for (const candidate of candidates) {
    const unresolved = path.resolve(root, candidate)
    if (!isEqualToOrInside(root, unresolved)) throw new CliError("BAD_HTTP_PATH", "request escaped the output root")
    try {
      const resolved = await realpath(unresolved)
      if (!isEqualToOrInside(root, resolved)) throw new CliError("BAD_HTTP_PATH", "request escaped the output root")
      if ((await stat(resolved)).isFile()) return resolved
    } catch (error) {
      if (error instanceof CliError) throw error
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
    }
  }
  return undefined
}

/** Serve an already-built output from this process, without calling Quartz's
 * serve-handler HTTP handler or retaining a long-lived child process.
 * @param {string} output @param {number} port */
async function serveStatic(output, port) {
  const root = await realpath(output)
  const watchedParents = parentPidsToWatch()
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" })
        response.end("Method Not Allowed\n")
        return
      }
      try {
        const file = await resolveStaticFile(root, request.url ?? "/")
        if (!file) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
          response.end("Not Found\n")
          return
        }
        const body = await readFile(file)
        response.writeHead(200, {
          "Content-Length": body.byteLength,
          "Content-Type": contentTypes.get(path.extname(file).toLowerCase()) ?? "application/octet-stream",
        })
        response.end(request.method === "HEAD" ? undefined : body)
      } catch (error) {
        const status = error instanceof CliError && error.code === "BAD_HTTP_PATH" ? 400 : 500
        response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" })
        response.end(status === 400 ? "Bad Request\n" : "Internal Server Error\n")
      }
    })()
  })

  await new Promise((resolve, reject) => {
    let stopping = false
    /** @type {NodeJS.Timeout | undefined} */
    let watchdog
    /** @param {string} reason */
    const stop = (reason) => {
      if (stopping) return
      stopping = true
      if (watchdog) clearInterval(watchdog)
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
      server.closeAllConnections()
      server.close((error) => {
        console.log(`SERVE_STOP reason=${reason}`)
        if (error) reject(error)
        else resolve(undefined)
      })
    }
    const onSigint = () => stop("SIGINT")
    const onSigterm = () => stop("SIGTERM")
    process.once("SIGINT", onSigint)
    process.once("SIGTERM", onSigterm)
    server.once("error", (error) => {
      if (watchdog) clearInterval(watchdog)
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
      reject(error)
    })
    server.listen(port, "127.0.0.1", () => {
      console.log(`SERVE_READY host=127.0.0.1 port=${port} pid=${process.pid}`)
      console.log(`SERVE_WATCH parents=${watchedParents.join(",") || "none"}`)
      watchdog = setInterval(() => {
        const deadParent = watchedParents.find((pid) => !processIsAlive(pid))
        if (deadParent !== undefined) stop(`PARENT_EXIT:${deadParent}`)
      }, 250)
    })
  })
}

/** @param {string} output */
async function verifyOutput(output) {
  const indexPath = path.join(output, "index.html")
  const supportPath = path.join(output, "support-node.html")
  const faviconPath = path.join(output, "favicon.ico")
  const contentIndexPath = path.join(output, "static", "contentIndex.json")
  let indexHtml
  try {
    indexHtml = await readFile(indexPath, "utf8")
  } catch {
    throw new CliError("VERIFY_MISSING_INDEX", "generated output does not contain index.html")
  }
  if (!indexHtml.includes("This page contains synthetic, non-research content used only to verify the pinned Quartz build.")) {
    throw new CliError("VERIFY_INDEX_MARKER", "index.html lacks its exact synthetic fixture marker")
  }

  let supportHtml
  try {
    supportHtml = await readFile(supportPath, "utf8")
  } catch {
    throw new CliError("VERIFY_MISSING_SUPPORT", "generated output does not contain support-node.html")
  }
  if (!supportHtml.includes("This is a synthetic fixture. It is not evidence and it is not sourced from Tyler-Vault.")) {
    throw new CliError("VERIFY_SUPPORT_MARKER", "support-node.html lacks its exact synthetic fixture marker")
  }

  let favicon
  try {
    favicon = await readFile(faviconPath)
  } catch {
    throw new CliError("VERIFY_MISSING_FAVICON", "generated output does not contain favicon.ico")
  }
  if (favicon.byteLength === 0) {
    throw new CliError("VERIFY_EMPTY_FAVICON", "generated favicon.ico is empty")
  }

  let contentIndexBytes
  try {
    contentIndexBytes = await readFile(contentIndexPath)
  } catch {
    throw new CliError("VERIFY_MISSING_CONTENT_INDEX", "generated output does not contain static/contentIndex.json")
  }
  if (contentIndexBytes.byteLength === 0) {
    throw new CliError("VERIFY_EMPTY_CONTENT_INDEX", "generated static/contentIndex.json is empty")
  }
  let contentIndex
  try {
    contentIndex = JSON.parse(contentIndexBytes.toString("utf8"))
  } catch {
    throw new CliError("VERIFY_INVALID_CONTENT_INDEX", "generated static/contentIndex.json is not valid JSON")
  }
  if (
    !contentIndex
    || typeof contentIndex !== "object"
    || Array.isArray(contentIndex)
    || contentIndex.index?.slug !== "index"
    || contentIndex.index?.title !== "Synthetic Reading Site"
    || contentIndex["support-node"]?.slug !== "support-node"
    || contentIndex["support-node"]?.title !== "Synthetic Support Node"
  ) {
    throw new CliError(
      "VERIFY_CONTENT_IDENTITIES",
      "generated static/contentIndex.json lacks the exact index and support-node identities",
    )
  }

  /** @type {string[]} */
  const forbidden = []
  /** @param {string} directory */
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (/\.(md|pdf)$/i.test(entry.name)) forbidden.push(path.relative(output, absolute))
    }
  }
  await walk(output)
  if (forbidden.length > 0) {
    throw new CliError("VERIFY_FORBIDDEN_OUTPUT", "generated output contains Markdown or PDF files")
  }
  return indexPath
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const safe = await preflight(options)
  const metadata = await readToolchainMetadata()
  if (options.command === "preflight") {
    console.log(`PREFLIGHT_OK quartz=${metadata.version} commit=${metadata.commit} icon_sha256=${metadata.defaultIconSha256}`)
    return
  }
  if (options.command === "verify") {
    await verifyOutput(safe.output)
    console.log(`VERIFY_OK quartz=${metadata.version} commit=${metadata.commit}`)
    return
  }

  await ensureToolchain(metadata)
  const quartzArgs = [
    "build",
    "--directory", safe.source,
    "--output", safe.output,
    "--concurrency", "1",
  ]
  const exitCode = await spawnQuartz(quartzArgs)
  if (exitCode !== 0) throw new CliError("QUARTZ_BUILD_FAILED", `Quartz exited with status ${exitCode}`)
  await verifyOutput(safe.output)
  console.log(`BUILD_RECEIPT quartz=${metadata.version} commit=${metadata.commit} icon_sha256=${metadata.defaultIconSha256} synthetic=true`)
  if (options.command === "build") console.log("BUILD_OK")
  else await serveStatic(safe.output, options.port)
}

main().catch((error) => {
  const code = error instanceof CliError ? error.code : "UNEXPECTED_ERROR"
  const message = error instanceof Error ? error.message : String(error)
  console.error(`${code}: ${message}`)
  process.exitCode = 1
})
