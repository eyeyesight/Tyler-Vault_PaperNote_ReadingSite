#!/usr/bin/env node
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { copyFile, lstat, mkdir, readFile, rm } from "node:fs/promises"

import { loadSiteContent, SiteContentError } from "../lib/slim-content-map.mjs"
import { publicMetadata } from "../lib/slim-public-metadata.mjs"
import { selectProjectPageTemplate } from "../lib/project-page-template.mjs"
import {
  analyzeMarkdown,
  decodeMarkdown,
  parseFrontmatter,
  projectContent,
  publicContracts,
  readDeploymentSiteFiles,
  readSecretRules,
  readToolchainMetadata,
  runCandidatePipeline,
  validateMarkdownSafety,
  validateSemanticTemplates,
} from "./tracer.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const defaultMap = path.join(repoRoot, "site-content.yml")
const defaultWorkRoot = path.join(repoRoot, ".artifacts", "slim-work")
const defaultOutput = path.join(repoRoot, ".artifacts", "slim-site")
const projectOwnedTheme = path.join(repoRoot, "styles", "tracer-scholarly.scss")

/** @typedef {{command:"preflight"|"build",map:string,vaultRoot:string,workRoot:string,output:string}} SlimOptions */

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
    map: defaultMap,
    vaultRoot: process.env.TYLER_VAULT_ROOT ?? "",
    workRoot: defaultWorkRoot,
    output: defaultOutput,
  })
  /** @type {Map<string,"map"|"vaultRoot"|"workRoot"|"output">} */
  const flags = new Map([["--content-map", "map"], ["--vault-root", "vaultRoot"], ["--work-root", "workRoot"], ["--output", "output"]])
  const seen = new Set()
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) throw new SlimBuildError("USAGE", "every flag requires one value")
    const property = flags.get(flag)
    if (!property) throw new SlimBuildError("USAGE", `unknown flag ${flag}`)
    if (seen.has(property)) throw new SlimBuildError("USAGE", `duplicate flag ${flag}`)
    seen.add(property)
    if (property === "map") options.map = value
    else if (property === "vaultRoot") options.vaultRoot = value
    else if (property === "workRoot") options.workRoot = value
    else options.output = value
  }
  if (!options.vaultRoot) throw new SlimBuildError("VAULT_ROOT_REQUIRED", "--vault-root or TYLER_VAULT_ROOT is required")
  return options
}

/** @param {SlimOptions} options */
async function preflight(options) {
  return await loadSiteContent(options.map, options)
}

/** @param {SlimOptions} options @param {Awaited<ReturnType<typeof preflight>>} content */
async function build(options, content) {
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
      const analysis = analyzeMarkdown(parsed.body)
      validateMarkdownSafety(markdown, parsed.body, page.source, analysis)
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
        body: parsed.body,
        frontmatter: projectedFrontmatter,
        route: page.route,
        mtimeMs: snapshotMetadata.mtimeMs,
        analysis,
      })
    }
    validateSemanticTemplates(records)
    const projection = projectContent({ action: { kind: "static-site-map" } }, records)
    const contracts = publicContracts(records, projection.outgoing, projection.searchableBodies)
    const toolchain = await readToolchainMetadata()
    const deploymentFiles = await readDeploymentSiteFiles()
    const secretRules = await readSecretRules()
    const gate = await runCandidatePipeline({
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
      outputAllowlist: null,
    }, false)
    return { pages: records.size, routes: gate.routes, files: gate.files, quartz: toolchain.metadata.version }
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
  process.stdout.write(`${JSON.stringify({ ok: true, command: "preflight", pages: content.pages.length, routes: content.pages.map((page) => page.route), layouts })}\n`)
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

export { build, parseArgs, preflight, selectProjectPageTemplate }
