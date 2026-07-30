// @ts-check
import { lstat, open, opendir, realpath } from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { isProxy } from "node:util/types"

import { PagesContractError } from "./pages-provider-lifecycle.mjs"

const fixtureRoot = path.resolve(import.meta.dirname, "..", "tests", "fixtures", "pages-project-site")
const fixtureLimits = Object.freeze({
  maxDirectories: 32,
  maxDepth: 8,
  maxFiles: 64,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
})

/**
 * Accept one exact canonical absolute path plus its single trailing-slash form.
 * No other normalization (percent decoding, separator collapse, dot removal, or
 * Unicode normalization) is allowed at this trust boundary.
 */
/** @param {string} value @returns {string} */
export function normalizeBasePath(value) {
  const invalid = () => new PagesContractError("BASE_PATH_INVALID", "base path must be an exact canonical absolute URL path")
  if (typeof value !== "string" || value.length < 2 || !value.startsWith("/") || value.startsWith("//")) throw invalid()
  if (value.includes("%") || value.includes("\\") || value.includes("?") || value.includes("#")) throw invalid()
  if (value.normalize("NFC") !== value || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) || value.includes(" ")) throw invalid()

  const withoutTrailingSlash = value.endsWith("/") ? value.slice(0, -1) : value
  if (withoutTrailingSlash.length < 2 || withoutTrailingSlash.endsWith("/")) throw invalid()
  const segments = withoutTrailingSlash.slice(1).split("/")
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) throw invalid()
  return `${withoutTrailingSlash}/`
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
])

/** @returns {PagesContractError} */
function invalidFixtureOptions() {
  return new PagesContractError("FIXTURE_OPTIONS_INVALID", "fixture options must be exactly one plain own enumerable basePath data property")
}

/** @param {unknown} input @returns {string} */
function readBasePathOption(input) {
  if (typeof input !== "object" || input === null || isProxy(input)) throw invalidFixtureOptions()

  let keys
  let prototype
  let descriptor
  try {
    keys = Reflect.ownKeys(input)
    prototype = Object.getPrototypeOf(input)
    descriptor = Object.getOwnPropertyDescriptor(input, "basePath")
  } catch {
    throw invalidFixtureOptions()
  }
  if (
    prototype !== Object.prototype
    || keys.length !== 1
    || keys[0] !== "basePath"
    || descriptor === undefined
    || !descriptor.enumerable
    || !("value" in descriptor)
  ) {
    throw invalidFixtureOptions()
  }
  return normalizeBasePath(descriptor.value)
}

/** @param {string} root @param {string} candidate @returns {boolean} */
function fixturePathContained(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** @param {any} left @param {any} right @returns {boolean} */
function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
}

/** @param {string} candidate @param {string} canonicalRoot @returns {Promise<void>} */
async function validateFixtureDirectory(candidate, canonicalRoot) {
  const metadata = await lstat(candidate, { bigint: true })
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("fixture directory class rejected")
  const resolved = await realpath(candidate)
  if (resolved !== path.resolve(candidate) || !fixturePathContained(canonicalRoot, resolved)) {
    throw new Error("fixture directory redirect rejected")
  }
}

/**
 * Read exactly the already-bounded fstat size through one handle, then prove no
 * extra byte appeared at that offset. The caller never receives the handle.
 * @param {string} candidate
 * @param {string} canonicalRoot
 * @param {any} initialPathMetadata
 * @returns {Promise<Buffer>}
 */
async function snapshotFixtureFile(candidate, canonicalRoot, initialPathMetadata) {
  const handle = await open(candidate, "r")
  try {
    const openedBefore = await handle.stat({ bigint: true })
    const pathAfterOpen = await lstat(candidate, { bigint: true })
    const resolvedAfterOpen = await realpath(candidate)
    if (
      !openedBefore.isFile()
      || !pathAfterOpen.isFile()
      || pathAfterOpen.isSymbolicLink()
      || openedBefore.nlink !== 1n
      || pathAfterOpen.nlink !== 1n
      || !sameFileIdentity(initialPathMetadata, openedBefore)
      || !sameFileIdentity(openedBefore, pathAfterOpen)
      || resolvedAfterOpen !== path.resolve(candidate)
      || !fixturePathContained(canonicalRoot, resolvedAfterOpen)
      || openedBefore.size > BigInt(fixtureLimits.maxFileBytes)
    ) {
      throw new Error("fixture file metadata rejected")
    }

    const byteLength = Number(openedBefore.size)
    const bytes = Buffer.alloc(byteLength)
    let offset = 0
    while (offset < byteLength) {
      const result = await handle.read(bytes, offset, byteLength - offset, offset)
      if (result.bytesRead === 0) throw new Error("fixture file shortened during snapshot")
      offset += result.bytesRead
    }
    const probe = Buffer.allocUnsafe(1)
    const extra = await handle.read(probe, 0, 1, byteLength)
    if (extra.bytesRead !== 0) throw new Error("fixture file grew during snapshot")

    const openedAfter = await handle.stat({ bigint: true })
    const pathAfterRead = await lstat(candidate, { bigint: true })
    const resolvedAfterRead = await realpath(candidate)
    if (
      !openedAfter.isFile()
      || openedAfter.nlink !== 1n
      || !pathAfterRead.isFile()
      || pathAfterRead.isSymbolicLink()
      || pathAfterRead.nlink !== 1n
      || !sameFileIdentity(openedBefore, openedAfter)
      || !sameFileIdentity(openedAfter, pathAfterRead)
      || resolvedAfterRead !== path.resolve(candidate)
      || !fixturePathContained(canonicalRoot, resolvedAfterRead)
    ) {
      throw new Error("fixture file changed during snapshot")
    }
    return bytes
  } finally {
    await handle.close()
  }
}

/**
 * Build the only filesystem-backed state before listen. The mutable Map and its
 * source Buffers stay inside this closure; callers can only obtain fresh Buffer
 * copies, making the request-time view immutable and filesystem-free.
 * @returns {Promise<{lookup:(relative:string)=>({bytes:Buffer,byteLength:number,contentType:string}|undefined)}>}
 */
async function loadFixedFixtureSnapshot() {
  try {
    const rootMetadata = await lstat(fixtureRoot, { bigint: true })
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new Error("fixture root class rejected")
    const canonicalRoot = await realpath(fixtureRoot)
    if (canonicalRoot !== fixtureRoot) throw new Error("fixture root redirect rejected")

    /** @type {Map<string,{sourceBytes:Buffer,byteLength:number,contentType:string}>} */
    const entries = new Map()
    const state = { directories: 0, entries: 0, files: 0, totalBytes: 0 }

    /** @param {string} relativeDirectory @param {number} depth @returns {Promise<void>} */
    const walk = async (relativeDirectory, depth) => {
      if (depth > fixtureLimits.maxDepth) throw new Error("fixture depth limit exceeded")
      state.directories += 1
      if (state.directories > fixtureLimits.maxDirectories) throw new Error("fixture directory limit exceeded")

      const directory = relativeDirectory === "" ? canonicalRoot : path.join(canonicalRoot, ...relativeDirectory.split("/"))
      await validateFixtureDirectory(directory, canonicalRoot)
      const directoryHandle = await opendir(directory)
      try {
        let child
        while ((child = await directoryHandle.read()) !== null) {
          state.entries += 1
          if (state.entries > fixtureLimits.maxDirectories + fixtureLimits.maxFiles) throw new Error("fixture entry limit exceeded")
          if (
            child.name.length === 0
            || child.name === "."
            || child.name === ".."
            || child.name.normalize("NFC") !== child.name
            || /[\\/\0\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(child.name)
          ) {
            throw new Error("fixture entry name rejected")
          }
          const relative = relativeDirectory === "" ? child.name : `${relativeDirectory}/${child.name}`
          const candidate = path.join(canonicalRoot, ...relative.split("/"))
          if (!fixturePathContained(canonicalRoot, candidate)) throw new Error("fixture entry escaped root")

          const pathMetadata = await lstat(candidate, { bigint: true })
          if (pathMetadata.isSymbolicLink()) throw new Error("fixture link or reparse redirect rejected")
          const resolved = await realpath(candidate)
          if (resolved !== path.resolve(candidate) || !fixturePathContained(canonicalRoot, resolved)) {
            throw new Error("fixture entry redirect rejected")
          }
          if (pathMetadata.isDirectory()) {
            await walk(relative, depth + 1)
            continue
          }
          if (!pathMetadata.isFile() || pathMetadata.nlink !== 1n) throw new Error("fixture entry class rejected")

          state.files += 1
          if (state.files > fixtureLimits.maxFiles) throw new Error("fixture file limit exceeded")
          if (pathMetadata.size > BigInt(fixtureLimits.maxFileBytes)) throw new Error("fixture file byte limit exceeded")
          if (state.totalBytes + Number(pathMetadata.size) > fixtureLimits.maxTotalBytes) throw new Error("fixture total byte limit exceeded")
          const sourceBytes = await snapshotFixtureFile(candidate, canonicalRoot, pathMetadata)
          state.totalBytes += sourceBytes.length
          entries.set(relative, Object.freeze({
            sourceBytes,
            byteLength: sourceBytes.length,
            contentType: contentTypes.get(path.extname(relative).toLowerCase()) ?? "application/octet-stream",
          }))
        }
      } finally {
        await directoryHandle.close().catch((error) => {
          if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ERR_DIR_CLOSED") throw error
        })
      }
    }

    await walk("", 0)
    if (!entries.has("index.html") || !entries.has("404.html")) throw new Error("required fixture pages missing")

    return Object.freeze({
      /** @param {string} relative */
      lookup(relative) {
        const entry = entries.get(relative)
        if (!entry) return undefined
        return {
          bytes: Buffer.from(entry.sourceBytes),
          byteLength: entry.byteLength,
          contentType: entry.contentType,
        }
      },
    })
  } catch (error) {
    if (error instanceof PagesContractError) throw error
    throw new PagesContractError("FIXTURE_SNAPSHOT_INVALID", "fixed fixture corpus could not be loaded as a bounded ordinary-file snapshot")
  }
}

/** @param {import("node:http").ServerResponse} response @param {number} status @param {string} body @param {Record<string,string|number>} [headers] */
function sendText(response, status, body, headers = {}) {
  const bytes = Buffer.from(body, "utf8")
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": bytes.length,
    "cache-control": "no-store",
    ...headers,
  })
  response.end(bytes)
}

/** @param {import("node:http").ServerResponse} response @param {{bytes:Buffer,byteLength:number,contentType:string}} entry @param {string} method @param {number} status */
function sendSnapshot(response, entry, method, status) {
  response.writeHead(status, {
    "content-type": entry.contentType,
    "content-length": entry.byteLength,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  })
  response.end(method === "HEAD" ? undefined : entry.bytes)
}

/**
 * Loopback-only fixed-corpus fixture; no caller path, provider URL, network
 * client, credential, loader, or test hook crosses this deep module interface.
 * @param {unknown} input
 * @returns {Promise<any>}
 */
export async function createSyntheticProjectSiteServer(input) {
  const normalizedBasePath = readBasePathOption(input)
  const snapshot = await loadFixedFixtureSnapshot()

  const server = http.createServer((request, response) => {
    const method = request.method ?? "GET"
    if (method !== "GET" && method !== "HEAD") {
      sendText(response, 405, "Method not allowed\n", { allow: "GET, HEAD" })
      return
    }
    let pathname
    try {
      pathname = new URL(request.url ?? "/", "http://fixture.invalid").pathname
      pathname = decodeURIComponent(pathname)
    } catch {
      sendText(response, 400, "Bad request\n")
      return
    }
    if (pathname === normalizedBasePath.slice(0, -1)) {
      response.writeHead(308, { location: normalizedBasePath, "cache-control": "no-store" })
      response.end()
      return
    }
    if (!pathname.startsWith(normalizedBasePath)) {
      sendText(response, 404, "Outside synthetic project-site base path\n")
      return
    }

    const requested = pathname.slice(normalizedBasePath.length)
    const relative = requested === "" || requested.endsWith("/") ? `${requested}index.html` : requested
    const entry = snapshot.lookup(relative)
    if (entry) {
      sendSnapshot(response, entry, method, 200)
      return
    }
    const notFound = snapshot.lookup("404.html")
    if (notFound) {
      sendSnapshot(response, notFound, method, 404)
      return
    }
    sendText(response, 404, "Synthetic 404 fixture missing\n")
  })

  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set()
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })

  await new Promise((resolve, reject) => {
    const onError = (/** @type {Error} */ error) => reject(error)
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError)
      resolve(undefined)
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.closeAllConnections()
    server.close()
    throw new PagesContractError("FIXTURE_LISTEN_FAILED", "loopback fixture did not receive an ephemeral TCP port")
  }

  /** @type {Promise<void>|undefined} */
  let closePromise
  const close = () => {
    if (closePromise) return closePromise
    closePromise = new Promise((resolve, reject) => {
      let settled = false
      const finish = (/** @type {Error|undefined} */ error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => {
        finish(new PagesContractError("FIXTURE_CLOSE_TIMEOUT", "loopback fixture did not close within its local deadline"))
      }, 1_000)
      timer.unref()
      server.close((error) => {
        if (error && /** @type {NodeJS.ErrnoException} */ (error).code !== "ERR_SERVER_NOT_RUNNING") finish(error)
        else finish(undefined)
      })
      server.closeIdleConnections()
      server.closeAllConnections()
      for (const socket of sockets) socket.destroy()
    })
    return closePromise
  }

  return Object.freeze({
    host: "127.0.0.1",
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    basePath: normalizedBasePath,
    close,
  })
}
