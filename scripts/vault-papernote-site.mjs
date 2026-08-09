#!/usr/bin/env node
// @ts-nocheck -- CLI values are validated and delegated to the bounded controller.
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  ContentPreviewError,
  opaqueOperationId,
  prepareSitePrivatePreview,
} from "../lib/content-private-preview.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const defaultWorkRoot = path.join(repoRoot, ".artifacts", "site-private-preview")

/** @param {string[]} argv */
export function parseArgs(argv) {
  const values = {
    vaultRoot: "",
    gitRoot: "",
    gitDir: "",
    mainRef: "",
    ghPagesRef: "",
    workRoot: defaultWorkRoot,
  }
  const flags = new Map([
    ["--vault-root", "vaultRoot"],
    ["--git-root", "gitRoot"],
    ["--git-dir", "gitDir"],
    ["--main-ref", "mainRef"],
    ["--gh-pages-ref", "ghPagesRef"],
    ["--work-root", "workRoot"],
    ["--operation-id", "operationId"],
  ])
  if (argv.length % 2 !== 0) throw new ContentPreviewError("USAGE", "every flag requires one value")
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    const property = flags.get(flag)
    if (!property || !value || value.startsWith("--") || seen.has(property)) {
      throw new ContentPreviewError("USAGE", "unknown, duplicate, or empty CLI argument")
    }
    seen.add(property)
    values[property] = value
  }
  if (!values.vaultRoot) throw new ContentPreviewError("VAULT_ROOT_REQUIRED", "--vault-root is required")
  if (values.gitRoot && values.gitDir) throw new ContentPreviewError("USAGE", "--git-root and --git-dir are mutually exclusive")
  return values
}

/** @param {ContentPreviewError} error */
export function usageResult(error) {
  return {
    version: 1,
    operation_id: opaqueOperationId(`site-cli:${error.code}`),
    lane: "site",
    status: "needs_attention",
    summary: "Reading Site 私人預覽參數無效，請修正後重試。",
    added_routes: [],
    changed_routes: [],
    removed_routes: [],
    checks: [{ name: "cli_arguments", outcome: "fail" }],
    next_action: "request_manual_review",
    error_code: error.code,
    mapping_identity: { map_sha256: null, map_blob_sha: null, additions: [] },
    candidate_identity: null,
    preview: { pages: 0, routes: 0, files: 0 },
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = await prepareSitePrivatePreview(options)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.status === "needs_attention") process.exitCode = 1
  } catch (error) {
    const safeError = error instanceof ContentPreviewError
      ? error
      : new ContentPreviewError("USAGE", "invalid site preview invocation")
    process.stdout.write(`${JSON.stringify(usageResult(safeError))}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
