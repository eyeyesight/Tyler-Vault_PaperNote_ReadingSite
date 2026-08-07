#!/usr/bin/env node
// @ts-nocheck -- this CLI validates a deliberately small local handoff contract.
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"

const repoRoot = path.resolve(import.meta.dirname, "..")
const contentMapPath = path.join(repoRoot, "site-content.yml")

class HandoffError extends Error {
  constructor(code, message, missingRoutes) {
    super(message)
    this.code = code
    if (missingRoutes) this.missingRoutes = missingRoutes
  }
}

function parseArgs(argv) {
  const values = { builtSite: "", baselineSite: "", output: "" }
  const flags = new Map([
    ["--built-site", "builtSite"],
    ["--baseline-site", "baselineSite"],
    ["--output", "output"],
  ])
  if (argv.length !== 6) throw new HandoffError("HANDOFF_USAGE", "expected built, baseline, and output roots")
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    const property = flags.get(flag)
    if (!property || !value || value.startsWith("--") || values[property]) throw new HandoffError("HANDOFF_USAGE", "expected each handoff root exactly once")
    values[property] = value
  }
  if (Object.values(values).some((value) => !value)) throw new HandoffError("HANDOFF_USAGE", "expected built, baseline, and output roots")
  return values
}

function utf8Order(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function routeFile(route) {
  if (typeof route !== "string" || route.normalize("NFC") !== route || route === "" || !route.startsWith("/") || !route.endsWith("/")
    || route.includes("\\") || route.includes("//") || route.includes("?") || route.includes("#")
    || route.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new HandoffError("HANDOFF_CONTENT_MAP_INVALID", "site-content.yml contains an invalid mapped route")
  }
  if (route === "/") return "index.html"
  const relative = route.slice(1, -1)
  if (!relative) throw new HandoffError("HANDOFF_CONTENT_MAP_INVALID", "site-content.yml contains an invalid mapped route")
  return `${relative}/index.html`
}

async function readMappedRoutes() {
  let document
  try {
    document = parseYaml(await readFile(contentMapPath, "utf8"))
  } catch {
    throw new HandoffError("HANDOFF_CONTENT_MAP_INVALID", "site-content.yml could not be read")
  }
  if (!document || typeof document !== "object" || !Array.isArray(document.pages)) {
    throw new HandoffError("HANDOFF_CONTENT_MAP_INVALID", "site-content.yml pages are invalid")
  }
  const routes = ["/", ...document.pages.map((page) => {
    if (!page || typeof page !== "object") throw new HandoffError("HANDOFF_CONTENT_MAP_INVALID", "site-content.yml pages are invalid")
    return page.route
  })]
  const seen = new Set()
  const folded = new Set()
  const proof = routes.map((route) => {
    const file = routeFile(route)
    if (seen.has(route) || folded.has(route.toLowerCase())) throw new HandoffError("HANDOFF_CONTENT_MAP_INVALID", "site-content.yml routes are not unique")
    seen.add(route)
    folded.add(route.toLowerCase())
    return { route, file }
  })
  return proof
}

async function existingDirectory(absolute, code) {
  try {
    const metadata = await lstat(absolute)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("not an ordinary directory")
    return { absolute, canonical: await realpath(absolute) }
  } catch {
    throw new HandoffError(code, "handoff root must be an ordinary directory")
  }
}

async function freshOutput(absolute) {
  try {
    await lstat(absolute)
    throw new HandoffError("HANDOFF_OUTPUT_EXISTS", "handoff output root must be fresh")
  } catch (error) {
    if (error instanceof HandoffError) throw error
    if (error?.code !== "ENOENT") throw new HandoffError("HANDOFF_OUTPUT_INVALID", "handoff output root is unavailable")
  }
  const parent = await existingDirectory(path.dirname(absolute), "HANDOFF_OUTPUT_PARENT_INVALID")
  return { absolute, canonical: path.join(parent.canonical, path.basename(absolute)) }
}

function contains(left, right) {
  const relative = path.relative(left, right)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function overlaps(left, right) {
  return contains(left, right) || contains(right, left)
}

async function collectRegularFiles(root, invalidCode) {
  const files = new Map()
  async function visit(directory, prefix) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      throw new HandoffError(invalidCode, "handoff site root could not be read")
    }
    entries.sort((left, right) => utf8Order(left.name, right.name))
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new HandoffError(invalidCode, "handoff site contains a non-ordinary entry")
      if (entry.isDirectory()) {
        await visit(absolute, relative)
      } else if (entry.isFile()) {
        try {
          files.set(relative, await readFile(absolute))
        } catch {
          throw new HandoffError(invalidCode, "handoff site file could not be read")
        }
      } else {
        throw new HandoffError(invalidCode, "handoff site contains a non-ordinary entry")
      }
    }
  }
  await visit(root, "")
  return files
}

function compareFiles(candidate, baseline) {
  const paths = [...new Set([...candidate.keys(), ...baseline.keys()])].sort(utf8Order)
  const diff = { added: [], deleted: [], changed: [], unchanged: [] }
  for (const relative of paths) {
    const candidateBytes = candidate.get(relative)
    const baselineBytes = baseline.get(relative)
    if (!baselineBytes) diff.added.push(relative)
    else if (!candidateBytes) diff.deleted.push(relative)
    else if (!candidateBytes.equals(baselineBytes)) diff.changed.push(relative)
    else diff.unchanged.push(relative)
  }
  return diff
}

function compareMappedRoutes(proof, candidate, baseline) {
  const diff = { added: [], deleted: [], unchanged: [] }
  for (const { route, file } of proof) {
    const inCandidate = candidate.has(file)
    const inBaseline = baseline.has(file)
    if (inCandidate && !inBaseline) diff.added.push(route)
    else if (!inCandidate && inBaseline) diff.deleted.push(route)
    else if (inCandidate && inBaseline) diff.unchanged.push(route)
  }
  return diff
}

async function prepare(options) {
  const built = await existingDirectory(path.resolve(options.builtSite), "HANDOFF_BUILT_ROOT_INVALID")
  const baseline = await existingDirectory(path.resolve(options.baselineSite), "HANDOFF_BASELINE_ROOT_INVALID")
  const output = await freshOutput(path.resolve(options.output))
  if (overlaps(built.canonical, baseline.canonical) || overlaps(built.canonical, output.canonical)
    || overlaps(baseline.canonical, output.canonical)) {
    throw new HandoffError("HANDOFF_PATH_OVERLAP", "handoff roots must be disjoint")
  }

  const [proof, builtFiles, baselineFiles] = await Promise.all([
    readMappedRoutes(),
    collectRegularFiles(built.absolute, "HANDOFF_BUILT_ROOT_INVALID"),
    collectRegularFiles(baseline.absolute, "HANDOFF_BASELINE_ROOT_INVALID"),
  ])
  const missing = proof.filter(({ file }) => !builtFiles.has(file))
  if (missing.length > 0) {
    throw new HandoffError(
      "HANDOFF_MAPPED_ROUTE_MISSING",
      "generated site is missing one or more mapped routes",
      missing.map(({ route }) => route),
    )
  }
  if (!builtFiles.has("404.html")) throw new HandoffError("HANDOFF_CUSTOM_404_MISSING", "generated site is missing its custom 404")
  if (builtFiles.has(".nojekyll") && builtFiles.get(".nojekyll").length !== 0) {
    throw new HandoffError("HANDOFF_NOJEKYLL_INVALID", "generated site contains a non-empty .nojekyll")
  }

  let created = false
  try {
    await mkdir(output.absolute)
    created = true
    const site = path.join(output.absolute, "site")
    await mkdir(site)
    for (const [relative, bytes] of builtFiles) {
      if (relative === ".nojekyll") continue
      const destination = path.join(site, ...relative.split("/"))
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, bytes, { flag: "wx" })
    }
    await writeFile(path.join(site, ".nojekyll"), Buffer.alloc(0), { flag: "wx" })
    const candidateFiles = await collectRegularFiles(site, "HANDOFF_OUTPUT_INVALID")
    return {
      ok: true,
      command: "prepare-gh-pages-commit",
      previewRoot: site,
      routeProof: { count: proof.length, routes: proof, missing: [] },
      routeDiff: compareMappedRoutes(proof, candidateFiles, baselineFiles),
      diff: compareFiles(candidateFiles, baselineFiles),
    }
  } catch (error) {
    if (created) await rm(output.absolute, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function main() {
  const result = await prepare(parseArgs(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const known = error instanceof HandoffError
    const detail = known && error.missingRoutes ? { missingRoutes: error.missingRoutes } : {}
    process.stdout.write(`${JSON.stringify({ ok: false, error: {
      code: known ? error.code : "HANDOFF_FAILED",
      message: known ? error.message : "local gh-pages handoff failed",
      ...detail,
    } })}\n`)
    process.exitCode = 1
  })
}

export { compareFiles, parseArgs, prepare, readMappedRoutes, routeFile }
