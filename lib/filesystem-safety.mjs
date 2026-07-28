import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

/** @param {unknown} error @param {string} code */
export function hasFsCode(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code)
}

/** Resolve through the nearest existing ancestor without creating anything. @param {string} candidate */
export async function canonicalPath(candidate) {
  let cursor = path.resolve(candidate)
  /** @type {string[]} */
  const missing = []
  for (;;) {
    try {
      const existing = await realpath(cursor)
      return path.join(existing, ...missing.reverse())
    } catch (error) {
      if (!hasFsCode(error, "ENOENT")) throw error
      const parent = path.dirname(cursor)
      if (parent === cursor) throw error
      missing.push(path.basename(cursor))
      cursor = parent
    }
  }
}

/** @param {string} root @param {string} candidate */
export function isEqualToOrInside(root, candidate) {
  /** @type {(value:string) => string} */
  const normalize = process.platform === "win32" ? (value) => value.toLowerCase() : (value) => value
  const normalizedRoot = normalize(path.resolve(root))
  const normalizedCandidate = normalize(path.resolve(candidate))
  const relative = path.relative(normalizedRoot, normalizedCandidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

/** @param {string} first @param {string} second */
export function pathsOverlap(first, second) {
  return isEqualToOrInside(first, second) || isEqualToOrInside(second, first)
}

/**
 * Inspect the filesystem anchor and every existing named layer without following
 * a Node-identifiable link. Missing tail segments are allowed when requested.
 * @param {string} candidate
 * @param {{allowMissing?:boolean, errorFactory?:(message:string)=>Error}} [options]
 */
export async function assertNoLinkAncestors(candidate, options = {}) {
  const fail = options.errorFactory ?? ((message) => new Error(message))
  const absolute = path.resolve(candidate)
  const parsed = path.parse(absolute)
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let cursor = parsed.root
  for (const [index, segment] of ["", ...segments].entries()) {
    if (index > 0) cursor = path.join(cursor, segment)
    let metadata
    try {
      metadata = await lstat(cursor)
    } catch (error) {
      if (options.allowMissing && hasFsCode(error, "ENOENT")) return
      throw fail("path and every ancestor must exist and be readable")
    }
    if (metadata.isSymbolicLink()) throw fail("path cannot contain a symlink, junction, or reparse point")
  }
}
