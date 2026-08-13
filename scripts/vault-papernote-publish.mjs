#!/usr/bin/env node
// @ts-nocheck -- the CLI is a deliberately small bounded stdin/controller boundary.
import path from "node:path"
import { fileURLToPath } from "node:url"

import { parseContentMapBytes } from "../lib/slim-content-map.mjs"
import { createRoutinePublicationAdapter } from "../lib/routine-publication-adapter.mjs"
import { routinePublicationHandoff } from "../lib/routine-publication-handoff.mjs"
import { runHeadlessSiteQa } from "../lib/site-headless-qa.mjs"
import {
  createImmutableLkgStore,
  runSitePublication,
} from "../lib/site-publication-runtime.mjs"

export const MAX_PUBLICATION_REQUEST_BYTES = 64 * 1024
export const MAX_PUBLICATION_RESULT_BYTES = 64 * 1024
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SHA40 = /^[0-9a-f]{40}$/u
const SHA64 = /^[0-9a-f]{64}$/u
const DEPLOY_WORKFLOW = "deploy-pages.yml"
const DEPLOY_REF = "main"
const DEPLOY_MODE = "routine"
const PROVIDER_SETTLE_ATTEMPTS = 120
const PROVIDER_SETTLE_DELAY_MS = 5_000
const OPERATION_TRANSPORT_KEYS = [
  "approval",
  "candidate_identity",
  "claimed_session",
  "lane",
  "operation_id",
  "proposed_site_content_base64",
  "version",
]

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null)
      && Object.getOwnPropertySymbols(value).length === 0
      && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => Object.hasOwn(descriptor, "value"))
  } catch {
    return false
  }
}

function cliError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function validCode(value, fallback) {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : fallback
}

function validId(value, fallback = "unknown") {
  return typeof value === "string" && SAFE_ID.test(value) ? value : fallback
}

function validSha(value, length) {
  const expression = length === 40 ? SHA40 : SHA64
  return typeof value === "string" && expression.test(value) ? value : null
}

function exactEnvelope(value) {
  if (!isPlainObject(value)) throw cliError("REQUEST_INVALID")
  const names = Object.getOwnPropertyNames(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  if (JSON.stringify(names) !== JSON.stringify(["operation", "settings"])) throw cliError("REQUEST_INVALID")
  if (!isPlainObject(value.operation) || !isPlainObject(value.settings)) throw cliError("REQUEST_INVALID")
  return { operation: value.operation, settings: value.settings }
}

function parseUtf8Json(bytes) {
  if (bytes.length === 0) throw cliError("REQUEST_INVALID")
  if (bytes.length > MAX_PUBLICATION_REQUEST_BYTES) throw cliError("REQUEST_TOO_LARGE")
  let text
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw cliError("REQUEST_INVALID")
  }
  try {
    return exactEnvelope(JSON.parse(text))
  } catch (error) {
    if (error?.code === "REQUEST_INVALID") throw error
    throw cliError("REQUEST_INVALID")
  }
}

/** Parse exactly one bounded UTF-8 JSON object from a string or byte value. */
export function parsePublicationRequest(input, maxBytes = MAX_PUBLICATION_REQUEST_BYTES) {
  const bytes = Buffer.isBuffer(input)
    ? Buffer.from(input)
    : input instanceof Uint8Array && !(input instanceof DataView)
      ? Buffer.from(input)
      : typeof input === "string"
        ? Buffer.from(input, "utf8")
        : null
  if (bytes === null) throw cliError("REQUEST_INVALID")
  if (bytes.length > maxBytes) throw cliError("REQUEST_TOO_LARGE")
  return parseUtf8Json(bytes)
}

/** Read one bounded request, rejecting the next chunk before accepting it. */
export async function readBoundedPublicationRequest(input, maxBytes = MAX_PUBLICATION_REQUEST_BYTES) {
  if (typeof input === "string" || Buffer.isBuffer(input) || input instanceof Uint8Array) return parsePublicationRequest(input, maxBytes)
  if (!input || typeof input[Symbol.asyncIterator] !== "function") throw cliError("REQUEST_INVALID")
  const chunks = []
  let total = 0
  try {
    for await (const chunk of input) {
      if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) || chunk instanceof DataView) throw cliError("REQUEST_INVALID")
      const bytes = Buffer.from(chunk)
      if (bytes.length > maxBytes - total) throw cliError("REQUEST_TOO_LARGE")
      chunks.push(bytes)
      total += bytes.length
    }
  } catch (error) {
    if (error?.code === "REQUEST_TOO_LARGE" || error?.code === "REQUEST_INVALID") throw error
    throw cliError("REQUEST_INVALID")
  }
  return parsePublicationRequest(Buffer.concat(chunks, total), maxBytes)
}

/** Convert the language-neutral JSON transport into the exact Buffer handoff contract. */
export function decodeOperationTransport(value) {
  if (!isPlainObject(value)) throw cliError("OPERATION_TRANSPORT_INVALID")
  const names = Object.getOwnPropertyNames(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  const expected = [...OPERATION_TRANSPORT_KEYS].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw cliError("OPERATION_TRANSPORT_INVALID")
  const encoded = value.proposed_site_content_base64
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > MAX_PUBLICATION_REQUEST_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw cliError("OPERATION_TRANSPORT_INVALID")
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.length === 0 || bytes.toString("base64") !== encoded) throw cliError("OPERATION_TRANSPORT_INVALID")
  const { proposed_site_content_base64: _encoded, ...operation } = value
  return { ...operation, proposed_site_content_bytes: bytes }
}

function safeChecks(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 64).flatMap((entry) => {
    if (!isPlainObject(entry) || typeof entry.name !== "string" || entry.name.length === 0 || entry.name.length > 96) return []
    if (!["pass", "fail", "warn"].includes(entry.outcome)) return []
    return [{ name: entry.name, outcome: entry.outcome }]
  })
}

function projectNested(value) {
  if (!isPlainObject(value)) return null
  const result = {}
  for (const key of ["site_commit", "rollback_commit", "restored_lkg_commit"]) {
    const sha = validSha(value[key], 40)
    if (sha) result[key] = sha
  }
  for (const key of ["site_sha256"]) {
    const sha = validSha(value[key], 64)
    if (sha) result[key] = sha
  }
  if (typeof value.status === "string" && ["pass", "fail", "published", "needs_attention", "no_change"].includes(value.status)) result.status = value.status
  if (typeof value.error_code === "string" && SAFE_CODE.test(value.error_code)) result.error_code = value.error_code
  if (Array.isArray(value.checks)) result.checks = safeChecks(value.checks)
  return result
}

/** Keep stdout to a bounded allowlist; raw controller errors/paths never cross it. */
export function projectPublicationResult(value, operation = {}) {
  if (!isPlainObject(value)) throw cliError("RESULT_INVALID")
  const result = {
    version: value.version === 1 ? 1 : 1,
    operation_id: validId(value.operation_id ?? operation.operation_id),
    status: ["published", "deployed", "no_change", "needs_attention"].includes(value.status) ? (value.status === "deployed" ? "published" : value.status) : "needs_attention",
  }
  if (Array.isArray(value.checks)) result.checks = safeChecks(value.checks)
  if (typeof value.error_code === "string" && SAFE_CODE.test(value.error_code)) result.error_code = value.error_code
  if (value.next_action === "none" || value.next_action === "request_manual_review" || value.next_action === "reconcile_operation") result.next_action = value.next_action
  if (isPlainObject(value.identifiers)) {
    const identifiers = {}
    for (const key of ["site_commit", "mapping_merge_sha"]) {
      const sha = validSha(value.identifiers[key], 40)
      if (sha) identifiers[key] = sha
    }
    for (const key of ["workflow_run_id", "deployment_id", "mapping_pr_id"]) {
      const id = validId(value.identifiers[key], "")
      if (id) identifiers[key] = id
    }
    result.identifiers = identifiers
  }
  for (const key of ["live_qa", "revalidation"]) {
    if (value[key] !== undefined) result[key] = projectNested(value[key])
  }
  for (const key of ["lkg", "failed_release", "rollback"]) {
    if (value[key] !== undefined) result[key] = projectNested(value[key])
  }
  return result
}

function safeFailure(code, operation = {}) {
  return {
    version: 1,
    operation_id: validId(operation?.operation_id),
    status: "needs_attention",
    error: {
      code: validCode(code, "REQUEST_INVALID"),
      next_action: "reconcile the operation before retrying",
    },
  }
}

function mapRoutes(operation) {
  try {
    const parsed = parseContentMapBytes(operation.proposed_site_content_bytes)
    return ["/", ...parsed.pages.map((page) => page.route)]
  } catch {
    return ["/"]
  }
}

function adapterConfig(settings, operation) {
  if (!isPlainObject(settings)) throw cliError("PRODUCTION_CONFIG_INVALID")
  const source = isPlainObject(settings.adapter_config) ? settings.adapter_config : settings
  if (!isPlainObject(source)) throw cliError("PRODUCTION_CONFIG_INVALID")
  if (Object.hasOwn(source, "candidateRoot")) throw cliError("PRODUCTION_CONFIG_INVALID")
  const claimedSession = operation?.claimed_session
  if (!isPlainObject(claimedSession)
    || JSON.stringify(Object.keys(claimedSession).sort()) !== JSON.stringify(["work_root"])
    || typeof claimedSession.work_root !== "string"
    || claimedSession.work_root.length === 0) throw cliError("OPERATION_TRANSPORT_INVALID")
  return { ...source, candidateRoot: claimedSession.work_root }
}

function exactSha(value, label) {
  if (typeof value !== "string" || !SHA40.test(value)) throw cliError(label)
  return value
}

function exactRunIds(value) {
  if (!Array.isArray(value)) throw cliError("ROLLBACK_DISPATCH_FAILED")
  const ids = value.map((entry) => {
    if (!isPlainObject(entry)) throw cliError("ROLLBACK_DISPATCH_FAILED")
    return validId(entry.id, "")
  })
  if (ids.some((id) => id.length === 0) || new Set(ids).size !== ids.length) throw cliError("ROLLBACK_DISPATCH_FAILED")
  return ids
}

function settleDelay() {
  return new Promise((resolve) => setTimeout(resolve, PROVIDER_SETTLE_DELAY_MS))
}

async function waitForProviderRead(read) {
  let lastError
  for (let attempt = 1; attempt <= PROVIDER_SETTLE_ATTEMPTS; attempt += 1) {
    try {
      return await read()
    } catch (error) {
      lastError = error
      if (attempt === PROVIDER_SETTLE_ATTEMPTS) break
      await settleDelay()
    }
  }
  throw lastError
}

/** Restore the exact immutable LKG through the existing CAS + Pages provider seams. */
export function createProductionRollback(adapter) {
  if (!isPlainObject(adapter) || !isPlainObject(adapter.localGit) || !isPlainObject(adapter.provider)) throw cliError("PRODUCTION_COMPONENT_UNAVAILABLE")
  return async ({ settings, publication, lkg }) => {
    const failedCommit = exactSha(publication?.identifiers?.site_commit, "ROLLBACK_IDENTITY_INVALID")
    const lkgCommit = exactSha(lkg?.site_commit, "ROLLBACK_IDENTITY_INVALID")
    if (typeof lkg?.site_sha256 !== "string" || !SHA64.test(lkg.site_sha256)) throw cliError("ROLLBACK_IDENTITY_INVALID")
    const authority = await adapter.localGit.readRemoteAuthority({})
    const mainSha = exactSha(authority?.main_sha, "ROLLBACK_REMOTE_INVALID")
    const remoteGhPages = exactSha(authority?.gh_pages_sha, "ROLLBACK_REMOTE_INVALID")
    if (remoteGhPages !== failedCommit) throw cliError("ROLLBACK_REMOTE_DRIFT")

    await adapter.localGit.pushGhPages({ candidate_sha: lkgCommit, expected_old_sha: failedCommit })
    if (exactSha(await adapter.localGit.readGhPagesHead({}), "ROLLBACK_PUSH_UNCERTAIN") !== lkgCommit) throw cliError("ROLLBACK_PUSH_UNCERTAIN")

    const runName = `Deploy GitHub Pages ${lkgCommit} (${DEPLOY_MODE})`
    const runQuery = { workflow: DEPLOY_WORKFLOW, ref: DEPLOY_REF, run_name: runName, head_sha: mainSha }
    const before = exactRunIds(await adapter.provider.listMatchingDeploymentRuns(runQuery))
    await adapter.provider.dispatchDeployment({
      workflow: DEPLOY_WORKFLOW,
      ref: DEPLOY_REF,
      run_name: runName,
      expected_head_sha: mainSha,
      inputs: { site_commit: lkgCommit, publication_mode: DEPLOY_MODE },
    })
    let after = []
    let newRuns = []
    for (let attempt = 1; attempt <= PROVIDER_SETTLE_ATTEMPTS; attempt += 1) {
      after = exactRunIds(await adapter.provider.listMatchingDeploymentRuns(runQuery))
      const beforeSet = new Set(before)
      newRuns = after.filter((id) => !beforeSet.has(id))
      if (newRuns.length === 1) break
      if (newRuns.length > 1) throw cliError("ROLLBACK_DISPATCH_FAILED")
      if (attempt < PROVIDER_SETTLE_ATTEMPTS) await settleDelay()
    }
    if (newRuns.length !== 1) throw cliError("ROLLBACK_DISPATCH_FAILED")
    const runId = newRuns[0]
    await waitForProviderRead(async () => await adapter.provider.readDeploymentRun({
      id: runId,
      site_commit: lkgCommit,
      publication_mode: DEPLOY_MODE,
      workflow: DEPLOY_WORKFLOW,
      ref: DEPLOY_REF,
      head_sha: mainSha,
    }))
    const pages = await waitForProviderRead(async () => await adapter.provider.readPagesDeployment({ run_id: runId, site_commit: lkgCommit }))
    if (!isPlainObject(pages) || pages.site_commit !== lkgCommit || pages.status !== "success") throw cliError("ROLLBACK_PAGES_FAILED")
    const smoke = await waitForProviderRead(async () => await adapter.provider.anonymousSmoke({
      target: pages,
      routes: ["/"],
      assets: [],
      not_found: { path: "/__t13_missing__", expected_status: 404 },
    }))
    if (!isPlainObject(smoke) || smoke.homepage_status !== 200 || smoke.not_found_status !== 404
      || !Array.isArray(smoke.route_statuses) || smoke.route_statuses.length !== 1 || smoke.route_statuses[0] !== 200
      || !Array.isArray(smoke.asset_statuses) || smoke.asset_statuses.length !== 0) throw cliError("ROLLBACK_SMOKE_FAILED")
    const siteRoot = typeof settings?.lkg_site_root === "string"
      ? settings.lkg_site_root
      : typeof settings?.candidate_site_root === "string"
        ? settings.candidate_site_root
        : undefined
    return {
      rollback_commit: lkgCommit,
      restored_lkg_commit: lkgCommit,
      site_sha256: lkg.site_sha256,
      revalidation: {
        status: "pass",
        checks: [{ name: "public_lkg_smoke", outcome: "pass" }],
        error_code: null,
      },
      ...(siteRoot === undefined ? {} : { site_root: siteRoot }),
    }
  }
}

async function defaultRuntime(request, dependencies) {
  const operation = dependencies.parseOperation
    ? await dependencies.parseOperation(request.operation)
    : decodeOperationTransport(request.operation)
  const createAdapter = dependencies.createAdapter ?? createRoutinePublicationAdapter
  const adapter = await createAdapter(adapterConfig(request.settings, operation), {
    ...(dependencies.commandTransport === undefined ? {} : { commandTransport: dependencies.commandTransport }),
    ...(dependencies.httpTransport === undefined ? {} : { httpTransport: dependencies.httpTransport }),
  })
  if (!isPlainObject(adapter) || !isPlainObject(adapter.localGit) || !isPlainObject(adapter.provider)) throw cliError("PRODUCTION_COMPONENT_UNAVAILABLE")
  const lkgRoot = request.settings.lkg_root ?? request.settings.lkgRoot
  const lkg = dependencies.lkg ?? (typeof lkgRoot === "string" && lkgRoot.length > 0 ? createImmutableLkgStore(lkgRoot) : null)
  if (!lkg) throw cliError("LKG_ROOT_INVALID")
  const publish = dependencies.publish ?? (async (approvedOperation) => await routinePublicationHandoff(approvedOperation, adapter))
  const runQa = dependencies.runHeadlessSiteQa ?? runHeadlessSiteQa
  const qa = dependencies.qa ?? (async (input) => {
    const routes = mapRoutes(input.operation)
    const options = isPlainObject(input.options) ? input.options : {}
    return await runQa({
      ...options,
      siteRoot: input.siteRoot,
      mappedRoutes: routes,
    })
  })
  const rollback = dependencies.rollback ?? createProductionRollback(adapter)
  return await runSitePublication(operation, request.settings, {
    publish,
    qa,
    lkg,
    rollback,
  })
}

export async function runPublicationCommand(request, dependencies = {}) {
  if (typeof dependencies.runPublication === "function") return await dependencies.runPublication(request)
  return await defaultRuntime(request, dependencies)
}

export async function main(options = {}) {
  const argv = options.argv ?? process.argv.slice(2)
  const write = options.write ?? ((line) => process.stdout.write(line))
  let result
  let exitCode = 1
  let request = null
  try {
    if (!Array.isArray(argv) || argv.length !== 0) throw cliError("REQUEST_INVALID")
    request = await readBoundedPublicationRequest(options.input ?? options.stdin ?? process.stdin)
    const rawResult = await runPublicationCommand(request, options.dependencies ?? {})
    result = projectPublicationResult(rawResult, request.operation)
    exitCode = result.status === "published" || result.status === "no_change" ? 0 : 1
  } catch (error) {
    result = safeFailure(validCode(error?.code, "REQUEST_INVALID"), request?.operation)
  }
  let encoded
  try {
    encoded = JSON.stringify(result)
    if (Buffer.byteLength(encoded, "utf8") > MAX_PUBLICATION_RESULT_BYTES) throw cliError("RESULT_LIMIT")
  } catch {
    encoded = JSON.stringify(safeFailure("RESULT_INVALID", request?.operation))
    exitCode = 1
  }
  write(`${encoded}\n`)
  return exitCode
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code }).catch(() => { process.exitCode = 1 })
}
