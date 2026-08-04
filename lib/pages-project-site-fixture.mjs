// @ts-check
import { readFile } from "node:fs/promises"
import http from "node:http"
import path from "node:path"

const fixtureRoot = path.resolve(import.meta.dirname, "..", "tests", "fixtures", "pages-project-site")
const fixtureFiles = Object.freeze([
  "404.html",
  "assets/app.css",
  "assets/app.js",
  "explorer/index.html",
  "graph/index.html",
  "graph.json",
  "index.html",
  "papers/synthetic-paper/index.html",
  "search/index.html",
  "search-index.json",
  "static/contentIndex.json",
])

class PagesContractError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = "PagesContractError"
    this.code = code
  }
}

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
  return new PagesContractError("FIXTURE_OPTIONS_INVALID", "fixture options must be one normal plain object with only a basePath string")
}

/** @param {unknown} input @returns {string} */
function readBasePathOption(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw invalidFixtureOptions()
  }
  const keys = Object.keys(input)
  const options = /** @type {{basePath?: unknown}} */ (input)
  if (keys.length !== 1 || keys[0] !== "basePath" || typeof options.basePath !== "string") throw invalidFixtureOptions()
  return normalizeBasePath(options.basePath)
}

/** @param {string} relative @returns {string} */
function contentTypeFor(relative) {
  return contentTypes.get(path.extname(relative).toLowerCase()) ?? "application/octet-stream"
}

/**
 * Load the repo-owned fixture corpus once before listen. The allowlist is the
 * complete public fixture contract; request handling never touches the filesystem.
 * @returns {Promise<{lookup:(relative:string)=>({bytes:Buffer,byteLength:number,contentType:string}|undefined)}>}
 */
async function loadFixedFixtureSnapshot() {
  try {
    /** @type {Map<string,{sourceBytes:Buffer,byteLength:number,contentType:string}>} */
    const entries = new Map()
    for (const relative of fixtureFiles) {
      const sourceBytes = await readFile(path.join(fixtureRoot, ...relative.split("/")))
      entries.set(relative, Object.freeze({
        sourceBytes,
        byteLength: sourceBytes.length,
        contentType: contentTypeFor(relative),
      }))
    }
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
    throw new PagesContractError("FIXTURE_SNAPSHOT_INVALID", "the fixed 11-file project-site fixture could not be loaded")
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
