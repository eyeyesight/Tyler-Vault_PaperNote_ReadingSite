#!/usr/bin/env node
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { copyFile, lstat, mkdir, readFile, rm } from "node:fs/promises"
import os from "node:os"

import { loadSiteContent, SiteContentError } from "../lib/slim-content-map.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const defaultMap = path.join(repoRoot, "site-content.yml")
const defaultWorkRoot = path.join(os.tmpdir(), "tyler-vault-reading-site", String(process.pid), "slim-work")
const defaultOutput = path.join(repoRoot, ".artifacts", "slim-site")
const projectOwnedTheme = path.join(repoRoot, "styles", "tracer-scholarly.scss")

/** @typedef {{command:"preflight"|"build",vaultRoot:string,workRoot:string,output:string,contentMap:string,rendererRoot?:string}} SlimOptions */

class SlimBuildError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** @param {string[]} argv @returns {SlimOptions} */
function parseArgs(argv) {
  const [command, ...rest] = argv
  if (!command || !["preflight", "build"].includes(command)) throw new SlimBuildError("USAGE", "expected preflight or build")
  const options = /** @type {SlimOptions} */ ({
    command: /** @type {"preflight"|"build"} */ (command),
    vaultRoot: process.env.TYLER_VAULT_ROOT ?? "",
    workRoot: defaultWorkRoot,
    output: defaultOutput,
    contentMap: defaultMap,
  })
  /** @type {Map<string,"vaultRoot"|"workRoot"|"output"|"contentMap">} */
  const flags = new Map([
    ["--vault-root", "vaultRoot"],
    ["--work-root", "workRoot"],
    ["--output", "output"],
    ["--content-map", "contentMap"],
  ])
  const seen = new Set()
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) throw new SlimBuildError("USAGE", "every flag requires one value")
    const property = flags.get(flag)
    if (!property) throw new SlimBuildError("USAGE", `unknown flag ${flag}`)
    if (seen.has(property)) throw new SlimBuildError("USAGE", `duplicate flag ${flag}`)
    seen.add(property)
    if (property === "vaultRoot") options.vaultRoot = value
    else if (property === "workRoot") options.workRoot = value
    else if (property === "output") options.output = value
    else options.contentMap = value
  }
  if (!options.vaultRoot) throw new SlimBuildError("VAULT_ROOT_REQUIRED", "--vault-root or TYLER_VAULT_ROOT is required")
  return options
}

/** @param {SlimOptions} options */
async function preflight(options) {
  return await loadSiteContent(options.contentMap, options)
}

/** @param {SlimOptions} options @param {Awaited<ReturnType<typeof preflight>>} content */
async function build(options, content) {
  if (options.rendererRoot) {
    const liveBuildPath = path.join(path.resolve(options.rendererRoot), "scripts", "slim-build.mjs")
    const liveBuild = await import(pathToFileURL(liveBuildPath).href)
    if (typeof liveBuild.build !== "function") throw new SlimBuildError("RENDERER_SOURCE_INVALID", "materialized live renderer does not expose its build seam")
    const built = await liveBuild.build({ ...options, rendererRoot: undefined }, content)
    return { ...built, map_sha256: content.mapSha256 }
  }
  return await buildWithLocalRenderer(options, content)
}

/** The local renderer is lazy so content/map admission cannot load pending
 * presentation, tracer, toolchain, deployment, or style modules.
 * @param {SlimOptions} options
 * @param {Awaited<ReturnType<typeof preflight>>} content
 */
async function buildWithLocalRenderer(options, content) {
  const [{ publicMetadata }, { selectProjectPageTemplate }, tracer] = await Promise.all([
    import("../lib/slim-public-metadata.mjs"),
    import("../lib/project-page-template.mjs"),
    import("./tracer.mjs"),
  ])
  const {
    analyzeMarkdown,
    decodeMarkdown,
    parseFrontmatter,
    projectIntegrationBoundaries,
    projectContent,
    publicContracts,
    readDeploymentSiteFiles,
    readSecretRules,
    readToolchainMetadata,
    runRendererPipeline,
    validateMarkdownSafety,
    validateSemanticTemplates,
  } = tracer
  await readFile(projectOwnedTheme, "utf8")
  const snapshot = content.snapshotRoot
  await rm(snapshot, { recursive: true, force: true })
  await mkdir(snapshot, { recursive: true })
  try {
    /** @type {Map<string, any>} */
    const records = new Map()
    for (const page of content.pages) {
      const layout = /** @type {"paper"|"support"} */ (page.layout)
      const sourceBefore = await lstat(page.sourceAbsolute)
      const bytes = await readFile(page.sourceAbsolute)
      const markdown = decodeMarkdown(bytes, page.source)
      const parsed = parseFrontmatter(markdown)
      const publicBody = projectIntegrationBoundaries(parsed.body)
      const analysis = analyzeMarkdown(publicBody)
      validateMarkdownSafety(markdown, publicBody, page.source, analysis)
      if (layout === "paper" && (parsed.data.type !== "literature-note" || parsed.data.status !== "integrated")) {
        throw new SlimBuildError("PAPER_FRONTMATTER_INVALID", "paper source requires type: literature-note and status: integrated")
      }
      if (layout === "support" && parsed.data.type === "paper") {
        throw new SlimBuildError("SUPPORT_FRONTMATTER_INVALID", "support source cannot claim paper type")
      }
      const template = selectProjectPageTemplate(layout)
      const projectedFrontmatter = layout === "paper"
        ? publicMetadata(parsed.data)
        : Object.freeze({ title: typeof parsed.data.title === "string" ? parsed.data.title : page.publicId })
      const snapshotPath = path.join(snapshot, ...page.source.split("/"))
      await mkdir(path.dirname(snapshotPath), { recursive: true })
      await copyFile(page.sourceAbsolute, snapshotPath)
      const sourceAfter = await lstat(page.sourceAbsolute)
      const snapshotBytes = await readFile(snapshotPath)
      if (!snapshotBytes.equals(bytes) || sourceAfter.size !== sourceBefore.size || sourceAfter.mtimeMs !== sourceBefore.mtimeMs) {
        throw new SlimBuildError("SOURCE_CHANGED_DURING_SNAPSHOT", "mapped Markdown source changed while creating the temporary public snapshot")
      }
      const snapshotMetadata = await lstat(snapshotPath)
      records.set(page.publicId, {
        node: {
          public_id: page.publicId,
          node_class: page.nodeClass,
          path: page.source,
          source_sha256: createHash("sha256").update(bytes).digest("hex"),
          template: template.name,
        },
        bytes,
        markdown,
        body: publicBody,
        frontmatter: projectedFrontmatter,
        route: page.route,
        mtimeMs: snapshotMetadata.mtimeMs,
        analysis,
      })
    }
    validateSemanticTemplates(records)
    const projection = projectContent(records)
    const contracts = publicContracts(records, projection.outgoing, projection.searchableBodies)
    const toolchain = await readToolchainMetadata()
    const deploymentFiles = await readDeploymentSiteFiles()
    const secretRules = await readSecretRules()
    const gate = await runRendererPipeline({
      exportRoot: snapshot,
      vaultRoot: content.vaultRoot,
      workRoot: content.workRoot,
      output: content.output,
      installedRoot: toolchain.installedRoot,
      records,
      projected: projection.projected,
      searchableBodies: projection.searchableBodies,
      outgoing: projection.outgoing,
      suppressedTargets: projection.suppressedTargets,
      suppressionCount: projection.suppressionCount,
      contracts,
      secretRules,
      privatePaths: [content.vaultRoot, content.workRoot, snapshot, content.output],
      deploymentFiles,
      retainCustom404: true,
    })
    return {
      pages: records.size,
      routes: gate.routes,
      files: gate.files,
      quartz: toolchain.metadata.version,
      map_sha256: content.mapSha256,
    }
  } finally {
    await rm(snapshot, { recursive: true, force: true })
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const content = await preflight(options)
  if (options.command === "build") {
    const result = await build(options, content)
    process.stdout.write(`${JSON.stringify({ ok: true, command: "build", ...result })}\n`)
    return
  }
  const layouts = { paper: 0, support: 0 }
  for (const page of content.pages) {
    const layout = /** @type {"paper"|"support"} */ (page.layout)
    layouts[layout] += 1
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "preflight",
    pages: content.pages.length,
    routes: content.pages.map((page) => page.route),
    layouts,
    map_sha256: content.mapSha256,
  })}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const known = error instanceof SiteContentError || error instanceof SlimBuildError || (error && typeof error === "object" && typeof error.code === "string")
    const code = known ? error.code : "UNEXPECTED_ERROR"
    const message = known ? error.message : "unexpected slim build failure"
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`)
    process.exitCode = 1
  })
}

export { build, parseArgs, preflight }
