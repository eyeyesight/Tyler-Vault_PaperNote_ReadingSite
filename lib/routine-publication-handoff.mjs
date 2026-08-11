// @ts-nocheck -- the controller crosses exact filesystem, local-Git, and injected provider seams.
import { createHash } from "node:crypto"
import { lstat, readFile, realpath, readdir } from "node:fs/promises"
import path from "node:path"
import { types as utilTypes } from "node:util"

import { assertNoLinkAncestors } from "./filesystem-safety.mjs"
import { parseContentMapBytes } from "./slim-content-map.mjs"

const MAP_FILE = "site-content.yml"
const MAPPING_BRANCH_PREFIX = "t13/map/"
const MAPPING_WORKFLOW = "t08-pinned-stack.yml"
const MAPPING_JOB = "Ubuntu pinned-stack acceptance"
const DEPLOY_WORKFLOW = "deploy-pages.yml"
const DEPLOY_REF = "main"
const DEPLOY_MODE = "routine"
const PROVIDER_SETTLE_ATTEMPTS = 120
const PROVIDER_SETTLE_DELAY_MS = 5_000
const PROJECT_BASE_PATH = "/Tyler-Vault_PaperNote_ReadingSite/"
const ROUTINE_STATUS = new Set(["publishing", "deployed", "needs_attention"])
const SPEC_ERROR_CODES = new Set([
  "auth_failed",
  "rate_limited",
  "remote_drift",
  "pr_failed",
  "ci_failed",
  "merge_failed",
  "push_uncertain",
  "dispatch_uncertain",
  "workflow_failed",
  "pages_failed",
  "smoke_failed",
  "provider_unavailable",
  "operation_corrupt",
  "confirmation_unavailable",
  "approval_invalid",
])
const SHA40 = /^[0-9a-f]{40}$/u
const SHA64 = /^[0-9a-f]{64}$/u
const OPERATION_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u

class HandoffFailure extends Error {
  constructor(code, stage) {
    super(code)
    this.name = "HandoffFailure"
    this.code = code
    this.stage = stage
  }
}

function fail(code, stage = "approval") {
  return new HandoffFailure(code, stage)
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => Object.hasOwn(descriptor, "value"))
  } catch {
    return false
  }
}

function exactRecord(value, keys, code = "approval_invalid", stage = "approval") {
  if (!isRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) throw fail(code, stage)
  const names = Object.getOwnPropertyNames(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  const expected = [...keys].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw fail(code, stage)
  const result = Object.create(null)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw fail(code, stage)
    result[key] = descriptor.value
  }
  return result
}

function exactBytes(value, code = "approval_invalid", stage = "approval") {
  if (utilTypes.isProxy(value) || !(Buffer.isBuffer(value) || value instanceof Uint8Array) || value instanceof DataView) throw fail(code, stage)
  return Buffer.from(value)
}

function exactVersion(value) {
  if (typeof value !== "number" || value !== 1 || !Number.isInteger(value) || Object.is(value, -0)) throw fail("approval_invalid")
}

function exactOperationId(value) {
  if (typeof value !== "string" || !OPERATION_ID.test(value) || value.includes("..")) throw fail("approval_invalid")
  return value
}

function exactSha(value, length, code = "approval_invalid", stage = "approval") {
  if (typeof value !== "string" || !(length === 40 ? SHA40 : SHA64).test(value)) throw fail(code, stage)
  return value
}

function gitBlobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function sameBytes(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right)
}

function utf8Order(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function ordinaryDirectory(candidate, code) {
  const absolute = path.resolve(candidate)
  try {
    await assertNoLinkAncestors(absolute, {
      errorFactory: () => fail(code),
    })
    const [metadata, canonical] = await Promise.all([lstat(absolute), realpath(absolute)])
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== absolute) throw fail(code)
    return { absolute, canonical }
  } catch (error) {
    if (error instanceof HandoffFailure) throw error
    throw fail(code)
  }
}

async function ordinaryFile(candidate, code) {
  const absolute = path.resolve(candidate)
  try {
    await assertNoLinkAncestors(absolute, {
      errorFactory: () => fail(code),
    })
    const [metadata, canonical] = await Promise.all([lstat(absolute), realpath(absolute)])
    if (!metadata.isFile() || metadata.isSymbolicLink() || canonical !== absolute) throw fail(code)
    return { absolute, canonical }
  } catch (error) {
    if (error instanceof HandoffFailure) throw error
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
      throw fail("approval_invalid")
    }
    entries.sort((left, right) => utf8Order(left.name, right.name))
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw fail("approval_invalid")
      if (entry.isDirectory()) await visit(absolute, relative)
      else if (entry.isFile()) {
        try {
          files.push({ relative, bytes: await readFile(absolute) })
        } catch {
          throw fail("approval_invalid")
        }
      } else throw fail("approval_invalid")
    }
  }
  await visit(root, "")
  return files.sort((left, right) => utf8Order(left.relative, right.relative))
}

function candidateTreeSha256(files) {
  const rows = files.map(({ relative, bytes }) => `${relative}\0${sha256(bytes)}\n`).join("")
  return sha256(Buffer.from(rows, "utf8"))
}

function candidateBinding(operation, identity) {
  if (operation.lane === "content") {
    return sha256(Buffer.from([
      `source_main=${identity.source_main_sha}`,
      `gh_pages=${identity.base_gh_pages_sha}`,
      `map=${identity.map_sha256}`,
      `live_renderer=${identity.live_renderer_sha}`,
      `renderer_tree=${identity.renderer_tree_sha256}`,
      `site=${identity.site_sha256}`,
      "",
    ].join("\n"), "utf8"))
  }
  return sha256(Buffer.from([
    `source_main_sha=${identity.source_main_sha}`,
    `base_gh_pages_sha=${identity.base_gh_pages_sha}`,
    `live_renderer_sha=${identity.live_renderer_sha}`,
    `main_renderer_tree_sha256=${identity.main_renderer_tree_sha256}`,
    `map_sha256=${identity.map_sha256}`,
    `site_sha256=${identity.site_sha256}`,
    "",
  ].join("\n"), "utf8"))
}

function readOperation(input) {
  const raw = exactRecord(input, [
    "approval",
    "candidate_identity",
    "claimed_session",
    "lane",
    "operation_id",
    "proposed_site_content_bytes",
    "version",
  ])
  exactVersion(raw.version)
  const operationId = exactOperationId(raw.operation_id)
  if (raw.lane !== "content" && raw.lane !== "site") throw fail("approval_invalid")
  const approval = exactRecord(raw.approval, [
    "candidate_id",
    "expected_gh_pages_sha",
    "expected_main_sha",
    "map_blob_sha",
    "map_commit_sha",
    "map_sha256",
    "mode",
    "operation_id",
  ])
  const candidateKeys = raw.lane === "content"
    ? ["base_gh_pages_sha", "live_renderer_sha", "map_sha256", "renderer_tree_sha256", "sha256", "site_sha256", "source_main_sha"]
    : ["base_gh_pages_sha", "live_renderer_sha", "main_renderer_tree_sha256", "map_sha256", "sha256", "site_sha256", "source_main_sha"]
  const candidate = exactRecord(raw.candidate_identity, candidateKeys)
  const claimed = exactRecord(raw.claimed_session, ["work_root"])
  const proposedBytes = exactBytes(raw.proposed_site_content_bytes)
  if (approval.operation_id !== operationId || approval.mode !== DEPLOY_MODE
    || approval.candidate_id !== candidate.sha256
    || approval.expected_main_sha !== candidate.source_main_sha
    || approval.expected_gh_pages_sha !== candidate.base_gh_pages_sha
    || approval.map_sha256 !== candidate.map_sha256) throw fail("approval_invalid")
  exactSha(approval.expected_main_sha, 40)
  exactSha(approval.expected_gh_pages_sha, 40)
  exactSha(approval.map_sha256, 64)
  exactSha(approval.map_blob_sha, 40)
  if (approval.map_commit_sha !== null) exactSha(approval.map_commit_sha, 40)
  exactSha(candidate.sha256, 64)
  exactSha(candidate.site_sha256, 64)
  exactSha(candidate.source_main_sha, 40)
  exactSha(candidate.base_gh_pages_sha, 40)
  exactSha(candidate.live_renderer_sha, 40)
  exactSha(candidate.map_sha256, 64)
  if (raw.lane === "content") exactSha(candidate.renderer_tree_sha256, 64)
  else exactSha(candidate.main_renderer_tree_sha256, 64)
  if (typeof claimed.work_root !== "string" || claimed.work_root.length === 0) throw fail("approval_invalid")
  if (approval.map_sha256 !== sha256(proposedBytes) || approval.map_blob_sha !== gitBlobSha(proposedBytes)) throw fail("approval_invalid")
  if (candidateBinding({ lane: raw.lane }, candidate) !== candidate.sha256) throw fail("approval_invalid")
  return Object.freeze({
    version: 1,
    operation_id: operationId,
    lane: raw.lane,
    approval: Object.freeze(approval),
    candidate_identity: Object.freeze(candidate),
    claimed_session: Object.freeze({ work_root: claimed.work_root }),
    proposed_site_content_bytes: proposedBytes,
  })
}

async function validateCandidate(operation) {
  const work = await ordinaryDirectory(operation.claimed_session.work_root, "approval_invalid")
  const sessionPath = path.resolve(work.canonical, operation.operation_id)
  if (!inside(work.canonical, sessionPath) || sessionPath === work.canonical) throw fail("approval_invalid")
  const session = await ordinaryDirectory(sessionPath, "approval_invalid")
  if (!inside(work.canonical, session.canonical) || session.canonical === work.canonical) throw fail("approval_invalid")
  const mapFile = await ordinaryFile(path.join(session.canonical, MAP_FILE), "approval_invalid")
  const mapBytes = await readFile(mapFile.absolute)
  if (!sameBytes(mapBytes, operation.proposed_site_content_bytes)) throw fail("approval_invalid")
  try {
    parseContentMapBytes(operation.proposed_site_content_bytes)
  } catch {
    throw fail("approval_invalid")
  }
  const laneDirectory = operation.lane === "content" ? "handoff" : "main-handoff"
  const candidate = await ordinaryDirectory(path.join(session.canonical, laneDirectory, "site"), "approval_invalid")
  if (!inside(session.canonical, candidate.canonical)) throw fail("approval_invalid")
  const files = await collectCandidateFiles(candidate.canonical)
  if (files.length === 0 || candidateTreeSha256(files) !== operation.candidate_identity.site_sha256) throw fail("approval_invalid")
  if (candidateBinding(operation, operation.candidate_identity) !== operation.candidate_identity.sha256) throw fail("approval_invalid")
  return Object.freeze({ session: session.canonical, candidate: candidate.canonical, files })
}

function method(seam, name) {
  try {
    if (!seam || (typeof seam !== "object" && typeof seam !== "function") || utilTypes.isProxy(seam)) throw new Error()
    const descriptor = Object.getOwnPropertyDescriptor(seam, name)
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") throw new Error()
    return descriptor.value.bind(seam)
  } catch {
    throw fail("provider_unavailable", "provider")
  }
}

function providerCode(stage, error) {
  if (error instanceof HandoffFailure) return error.code
  let supplied
  try {
    supplied = error && typeof error === "object" && typeof error.code === "string" ? error.code : ""
  } catch {
    supplied = ""
  }
  if (SPEC_ERROR_CODES.has(supplied)) return supplied
  if (stage === "pr") return "pr_failed"
  if (stage === "ci") return "ci_failed"
  if (stage === "merge") return "merge_failed"
  if (stage === "push") return "push_uncertain"
  if (stage === "dispatch") return "dispatch_uncertain"
  if (stage === "workflow") return "workflow_failed"
  if (stage === "pages") return "pages_failed"
  if (stage === "smoke") return "smoke_failed"
  return "provider_unavailable"
}

function isStableFailure(error) {
  return error instanceof HandoffFailure && SPEC_ERROR_CODES.has(error.code)
}

async function call(seam, name, input, stage) {
  try {
    const fn = method(seam, name)
    return await fn(input)
  } catch (error) {
    throw fail(providerCode(stage, error), stage)
  }
}

function exactId(value, code = "provider_unavailable", stage = "provider") {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw fail(code, stage)
  return value
}

function exactRunIds(value) {
  if (!Array.isArray(value)) throw fail("dispatch_uncertain", "dispatch")
  const ids = []
  const seen = new Set()
  for (const entry of value) {
    const record = exactRecord(entry, ["id"], "dispatch_uncertain", "dispatch")
    const id = exactId(record.id, "dispatch_uncertain", "dispatch")
    if (seen.has(id)) throw fail("dispatch_uncertain", "dispatch")
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function setDifference(after, before) {
  const old = new Set(before)
  return after.filter((id) => !old.has(id))
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

function mapRoutes(bytes) {
  let parsed
  try { parsed = parseContentMapBytes(bytes) } catch { throw fail("approval_invalid") }
  const routes = ["/", ...parsed.pages.map(({ route }) => route)]
  return routes.sort((left, right) => left === "/" ? -1 : right === "/" ? 1 : utf8Order(left, right))
}

function mapAssets(files) {
  return files
    .map(({ relative }) => relative)
    .filter((relative) => /\.(?:css|js)$/u.test(relative))
    .sort(utf8Order)
}

function check(name, outcome = "pass") {
  return { name, outcome }
}

function result(operationId, lane, status, summary, checks, nextAction, errorCode, identifiers = {}) {
  const base = {
    version: 1,
    operation_id: operationId,
    lane,
    status,
    summary,
    added_routes: [],
    changed_routes: [],
    removed_routes: [],
    checks,
    next_action: nextAction,
    error_code: errorCode,
  }
  if (Object.keys(identifiers).length > 0) base.identifiers = identifiers
  return base
}

function failureSummary(code) {
  const summaries = {
    approval_invalid: "核准內容或私人候選版本已失效，未執行公開變更。",
    remote_drift: "遠端基線已變更，未執行公開變更。",
    pr_failed: "映射變更的 PR 核對失敗，已停止發布。",
    ci_failed: "映射變更的固定 CI 未通過，已停止發布。",
    merge_failed: "映射變更合併失敗，已停止發布。",
    push_uncertain: "公開分支推送結果無法唯一核對，請人工處理。",
    dispatch_uncertain: "部署派送結果無法唯一核對，未重複派送。",
    workflow_failed: "精確版本部署工作流程失敗，已停止。",
    pages_failed: "Pages 部署讀回失敗，已停止。",
    smoke_failed: "匿名網站檢查失敗，已停止。",
    provider_unavailable: "發布服務目前無法核對，請人工處理。",
    operation_corrupt: "發布操作資料損壞，請人工核對。",
    confirmation_unavailable: "發布核准能力目前不可用，未執行公開變更。",
    auth_failed: "發布服務驗證失敗，已停止。",
    rate_limited: "發布服務暫時限流，已停止。",
  }
  return summaries[code] ?? "發布核對失敗，已停止。"
}

function safeFailureMetadata(error) {
  if (!error || typeof error !== "object" || utilTypes.isProxy(error)) {
    return { code: "provider_unavailable", stage: "provider" }
  }
  try {
    return {
      code: SPEC_ERROR_CODES.has(error.code) ? error.code : "provider_unavailable",
      stage: typeof error.stage === "string" ? error.stage : "provider",
    }
  } catch {
    return { code: "provider_unavailable", stage: "provider" }
  }
}

function errorResult(operationId, lane, checks, error, identifiers) {
  const { code, stage } = safeFailureMetadata(error)
  const failedName = stage === "approval" ? "approval" : stage === "candidate" ? "candidate" : stage === "remote" ? "remote_heads" : stage === "pr" ? "mapping_pr" : stage === "ci" ? "mapping_ci" : stage === "merge" ? "mapping_merge" : stage === "map" ? "map_readback" : stage === "candidate_commit" ? "site_candidate" : stage === "push" ? "gh_pages_push" : stage === "dispatch" ? "dispatch" : stage === "workflow" ? "deployment_run" : stage === "pages" ? "pages" : stage === "smoke" ? "smoke" : "provider"
  const existingIndex = checks.findIndex(({ name }) => name === failedName)
  const finalChecks = existingIndex === -1
    ? [...checks, check(failedName, "fail")]
    : [...checks.slice(0, existingIndex), check(failedName, "fail")]
  return result(operationId, lane, "needs_attention", failureSummary(code), finalChecks, "request_manual_review", code, identifiers)
}

function validateRemoteAuthority(value, stage) {
  const authority = exactRecord(value, ["gh_pages_sha", "main_sha", "map_bytes"], "provider_unavailable", stage)
  exactSha(authority.main_sha, 40, "provider_unavailable", stage)
  exactSha(authority.gh_pages_sha, 40, "provider_unavailable", stage)
  authority.map_bytes = exactBytes(authority.map_bytes, "provider_unavailable", stage)
  return authority
}

function validateMappingBranch(value, operation, mapBytes) {
  if (!isRecord(value)) throw fail("pr_failed", "pr")
  const branch = value.branch
  const head = exactSha(value.head_sha, 40, "pr_failed", "pr")
  const base = value.base_sha
  if (branch !== `${MAPPING_BRANCH_PREFIX}${operation.operation_id}` || base !== operation.approval.expected_main_sha
    || (operation.approval.map_commit_sha !== null && head !== operation.approval.map_commit_sha)
    || !sameBytes(value.map_bytes, mapBytes)) throw fail("pr_failed", "pr")
  return { branch, head_sha: head, base_sha: base }
}

function validatePr(value, expected) {
  if (!isRecord(value) || value.base !== "main" || value.branch !== expected.branch || value.head_sha !== expected.head_sha
    || !Array.isArray(value.file_set) || JSON.stringify(value.file_set) !== JSON.stringify([MAP_FILE])
    || value.map_blob_sha !== expected.map_blob_sha || !sameBytes(value.map_bytes, expected.map_bytes)
    || value.state !== "open" || value.merged !== false) throw fail("pr_failed", "pr")
  return exactId(value.pr_id, "pr_failed", "pr")
}

function validatePrList(value, expected) {
  if (!Array.isArray(value)) throw fail("pr_failed", "pr")
  return value.map((entry) => ({ entry, pr_id: validatePr(entry, expected) }))
}

function validateCi(value, head) {
  if (!isRecord(value) || value.head_sha !== head || value.workflow !== MAPPING_WORKFLOW || value.job !== MAPPING_JOB
    || value.status !== "completed" || value.conclusion !== "success") throw fail("ci_failed", "ci")
}

function validateMerge(value, prId, head) {
  if (!isRecord(value) || value.pr_id !== prId || value.merged !== true || value.base !== "main" || value.head_sha !== head) throw fail("merge_failed", "merge")
  return exactSha(value.merge_sha, 40, "merge_failed", "merge")
}

function validateMergeList(value, prId, head) {
  if (!Array.isArray(value)) throw fail("merge_failed", "merge")
  return value.map((entry) => ({ entry, merge_sha: validateMerge(entry, prId, head) }))
}

function validateCandidateCommit(value, baseSha, rendererSha) {
  if (!isRecord(value) || value.parent_sha !== baseSha
    || value.renderer_main_sha !== rendererSha || typeof value.message !== "string"
    || !new RegExp(`(?:^|\\n)Renderer-Main-SHA: ${rendererSha}(?:\\n|$)`, "u").test(value.message)) throw fail("remote_drift", "candidate_commit")
  return exactSha(value.candidate_sha, 40, "remote_drift", "candidate_commit")
}

function validateCandidateCommitTree(value, candidateSha, expectedFiles, expectedSiteSha) {
  if (!isRecord(value) || value.candidate_sha !== candidateSha || !Array.isArray(value.files)) throw fail("remote_drift", "candidate_commit")
  const expected = new Map(expectedFiles.map(({ relative, bytes }) => [`site/${relative}`, bytes]))
  const seen = new Set()
  const actual = []
  for (const entry of value.files) {
    if (!isRecord(entry) || typeof entry.relative !== "string" || entry.mode !== "100644" || entry.type !== "blob"
      || !Buffer.isBuffer(entry.bytes) || seen.has(entry.relative)) throw fail("remote_drift", "candidate_commit")
    const expectedBytes = expected.get(entry.relative)
    if (!expected.has(entry.relative) || !sameBytes(entry.bytes, expectedBytes)) throw fail("remote_drift", "candidate_commit")
    seen.add(entry.relative)
    actual.push({ relative: entry.relative.slice("site/".length), bytes: entry.bytes })
  }
  actual.sort((left, right) => utf8Order(left.relative, right.relative))
  if (seen.size !== expected.size || candidateTreeSha256(actual) !== expectedSiteSha) throw fail("remote_drift", "candidate_commit")
}

function validateRun(value, runId, siteCommit, runName, headSha) {
  if (!isRecord(value) || value.id !== runId || value.workflow !== DEPLOY_WORKFLOW || value.ref !== DEPLOY_REF
    || value.head_sha !== headSha || value.run_name !== runName || value.status !== "completed" || value.conclusion !== "success") throw fail("workflow_failed", "workflow")
  if (!isRecord(value.inputs) || JSON.stringify(value.inputs) !== JSON.stringify({ site_commit: siteCommit, publication_mode: DEPLOY_MODE })) throw fail("workflow_failed", "workflow")
}

function validatePages(value, runId, siteCommit) {
  let pages
  try {
    pages = exactRecord(value, ["deployment_id", "run_id", "site_commit", "status", "url"], "pages_failed")
  } catch {
    throw fail("pages_failed", "pages")
  }
  if (pages.run_id !== runId || pages.site_commit !== siteCommit || pages.status !== "success") throw fail("pages_failed", "pages")
  const deploymentId = exactId(pages.deployment_id, "pages_failed", "pages")
  let url
  try {
    url = new URL(pages.url)
  } catch {
    throw fail("pages_failed", "pages")
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
    || url.pathname !== PROJECT_BASE_PATH || url.href !== pages.url) throw fail("pages_failed", "pages")
  return { deployment_id: deploymentId, run_id: runId, site_commit: siteCommit, url: url.href }
}

function sameDeploymentTarget(value, target) {
  if (!isRecord(value)) return false
  return value.deployment_id === target.deployment_id && value.run_id === target.run_id
    && value.site_commit === target.site_commit && value.url === target.url
}

/**
 * Execute one approved routine publication against injected local-Git and provider capabilities.
 * The only public mutation capability is the injected seam; no production network transport is used.
 * @param {unknown} approvedOperation
 * @param {{provider:object,localGit:object}} seams
 */
export async function routinePublicationHandoff(approvedOperation, seams) {
  let operationId = "invalid-operation"
  let lane = "content"
  const checks = []
  const identifiers = {}
  try {
    const operation = readOperation(approvedOperation)
    operationId = operation.operation_id
    lane = operation.lane
    identifiers.candidate_id = operation.candidate_identity.sha256
    const provider = seams?.provider
    const localGit = seams?.localGit
    if (!provider || !localGit) throw fail("provider_unavailable", "provider")
    const candidate = await validateCandidate(operation)
    checks.push(check("approval"), check("candidate"))
    const initial = validateRemoteAuthority(await call(localGit, "readRemoteAuthority", {}, "remote"), "remote")
    if (initial.main_sha !== operation.approval.expected_main_sha || initial.gh_pages_sha !== operation.approval.expected_gh_pages_sha) throw fail("remote_drift", "remote")
    checks.push(check("remote_heads"))
    let currentMainSha = initial.main_sha
    if (!sameBytes(initial.map_bytes, operation.proposed_site_content_bytes)) {
      const branch = `${MAPPING_BRANCH_PREFIX}${operation.operation_id}`
      const mappingBranch = validateMappingBranch(await call(localGit, "createMappingBranch", {
        base_ref: "main",
        base_sha: operation.approval.expected_main_sha,
        branch,
        map_bytes: operation.proposed_site_content_bytes,
      }, "pr"), operation, operation.proposed_site_content_bytes)
      checks.push(check("mapping_branch"))
      const expectedPr = {
        base: "main",
        branch,
        head_sha: mappingBranch.head_sha,
        map_blob_sha: operation.approval.map_blob_sha,
        map_bytes: operation.proposed_site_content_bytes,
        file_set: [MAP_FILE],
      }
      const readPr = async (prId) => {
        const readInput = { pr_id: prId, ...expectedPr }
        const readId = validatePr(await call(provider, "readMappingPr", readInput, "pr"), expectedPr)
        if (readId !== prId) throw fail("pr_failed", "pr")
        return readId
      }
      const listMatchingPrs = async () => validatePrList(await call(provider, "listMatchingMappingPrs", expectedPr, "pr"), expectedPr)
      const adoptOnePr = async () => {
        const matches = await listMatchingPrs()
        if (matches.length !== 1) throw fail("pr_failed", "pr")
        return readPr(matches[0].pr_id)
      }
      const reconcileCreateFailure = async (mutationError) => {
        let matches
        try {
          matches = await listMatchingPrs()
        } catch {
          throw fail("pr_failed", "pr")
        }
        if (matches.length === 0) {
          if (isStableFailure(mutationError)) throw mutationError
          throw fail("pr_failed", "pr")
        }
        if (matches.length !== 1) throw fail("pr_failed", "pr")
        try {
          return await readPr(matches[0].pr_id)
        } catch {
          throw fail("pr_failed", "pr")
        }
      }
      const beforePrs = validatePrList(await call(provider, "listMatchingMappingPrs", expectedPr, "pr"), expectedPr)
      if (beforePrs.length > 1) throw fail("pr_failed", "pr")
      let prId
      if (beforePrs.length === 1) {
        prId = await readPr(beforePrs[0].pr_id)
      } else {
        let createdPr
        let createError
        try {
          createdPr = await call(provider, "createMappingPr", expectedPr, "pr")
        } catch (error) {
          if (!(error instanceof HandoffFailure) || error.stage !== "pr") throw error
          createError = error
        }
        let createdPrId
        if (isRecord(createdPr)) {
          try {
            createdPrId = exactId(createdPr.pr_id, "pr_failed", "pr")
          } catch {
            createdPrId = undefined
          }
        }
        if (createError) {
          prId = await reconcileCreateFailure(createError)
        } else if (createdPrId) {
          try {
            prId = await readPr(createdPrId)
          } catch {
            try {
              prId = await adoptOnePr()
            } catch {
              throw fail("pr_failed", "pr")
            }
          }
        } else {
          try {
            prId = await adoptOnePr()
          } catch {
            throw fail("pr_failed", "pr")
          }
        }
      }
      identifiers.mapping_pr_id = prId
      checks.push(check("mapping_pr"))
      await waitForProviderRead(async () => await call(provider, "readRequiredCi", { head_sha: mappingBranch.head_sha, workflow: MAPPING_WORKFLOW, job: MAPPING_JOB }, "ci").then((value) => validateCi(value, mappingBranch.head_sha)))
      checks.push(check("mapping_ci"))
      const listMergedPrs = async () => validateMergeList(await call(provider, "listMergedMappingPrs", { pr_id: prId, expected_head_sha: mappingBranch.head_sha }, "merge"), prId, mappingBranch.head_sha)
      const reconcileMergeFailure = async (mutationError) => {
        let matches
        try {
          matches = await listMergedPrs()
        } catch {
          throw fail("merge_failed", "merge")
        }
        if (matches.length === 0) {
          if (isStableFailure(mutationError)) throw mutationError
          throw fail("merge_failed", "merge")
        }
        if (matches.length !== 1) throw fail("merge_failed", "merge")
        return matches[0].merge_sha
      }
      let mergeResponse
      let mergeError
      try {
        mergeResponse = await call(provider, "squashMergeMappingPr", { pr_id: prId, expected_head_sha: mappingBranch.head_sha }, "merge")
      } catch (error) {
        if (!(error instanceof HandoffFailure) || error.stage !== "merge") throw error
        mergeError = error
      }
      let mergeSha
      if (mergeError) {
        mergeSha = await reconcileMergeFailure(mergeError)
      } else if (isRecord(mergeResponse) && SHA40.test(mergeResponse.merge_sha)) {
        try {
          mergeSha = validateMerge(await call(provider, "readMerge", { pr_id: prId, merge_sha: mergeResponse.merge_sha, expected_head_sha: mappingBranch.head_sha }, "merge"), prId, mappingBranch.head_sha)
        } catch {
          try {
            const matches = await listMergedPrs()
            if (matches.length !== 1) throw fail("merge_failed", "merge")
            mergeSha = matches[0].merge_sha
          } catch {
            throw fail("merge_failed", "merge")
          }
        }
      } else {
        try {
          const matches = await listMergedPrs()
          if (matches.length !== 1) throw fail("merge_failed", "merge")
          mergeSha = matches[0].merge_sha
        } catch {
          throw fail("merge_failed", "merge")
        }
      }
      identifiers.mapping_merge_sha = mergeSha
      checks.push(check("mapping_merge"))
      const afterMerge = validateRemoteAuthority(await call(localGit, "readRemoteAuthority", {}, "map"), "map")
      if (afterMerge.main_sha !== mergeSha || afterMerge.gh_pages_sha !== operation.approval.expected_gh_pages_sha || !sameBytes(afterMerge.map_bytes, operation.proposed_site_content_bytes)) throw fail("remote_drift", "map")
      currentMainSha = afterMerge.main_sha
    } else if (operation.approval.map_commit_sha !== null && operation.approval.map_commit_sha !== currentMainSha) {
      throw fail("remote_drift", "map")
    }
    checks.push(check("map_readback"))
    const candidateRendererSha = operation.lane === "content"
      ? operation.candidate_identity.live_renderer_sha
      : operation.candidate_identity.source_main_sha
    const candidateCommitResponse = await call(localGit, "createGhPagesCandidate", {
      base_sha: operation.approval.expected_gh_pages_sha,
      candidate_path: candidate.candidate,
      renderer_main_sha: candidateRendererSha,
    }, "candidate_commit")
    const siteCommit = validateCandidateCommit(candidateCommitResponse, operation.approval.expected_gh_pages_sha, candidateRendererSha)
    const committedCandidate = await call(localGit, "readCandidateCommit", { candidate_sha: siteCommit }, "candidate_commit")
    validateCandidateCommitTree(committedCandidate, siteCommit, candidate.files, operation.candidate_identity.site_sha256)
    identifiers.site_commit = siteCommit
    checks.push(check("site_candidate"))
    let pushError
    try {
      await call(localGit, "pushGhPages", { candidate_sha: siteCommit, expected_old_sha: operation.approval.expected_gh_pages_sha }, "push")
    } catch (error) {
      if (!(error instanceof HandoffFailure) || error.stage !== "push") throw error
      pushError = error
    }
    let remoteGhPages
    try {
      remoteGhPages = exactSha(await call(localGit, "readGhPagesHead", {}, "push"), 40, "push_uncertain", "push")
    } catch {
      throw fail("push_uncertain", "push")
    }
    if (remoteGhPages !== siteCommit) {
      if (remoteGhPages === operation.approval.expected_gh_pages_sha && isStableFailure(pushError)) throw pushError
      throw fail("push_uncertain", "push")
    }
    checks.push(check("gh_pages_push"))
    const runName = `Deploy GitHub Pages ${siteCommit} (${DEPLOY_MODE})`
    const runQuery = { workflow: DEPLOY_WORKFLOW, ref: DEPLOY_REF, run_name: runName, head_sha: currentMainSha }
    const beforeIds = exactRunIds(await call(provider, "listMatchingDeploymentRuns", runQuery, "dispatch"))
    let dispatchError
    try {
      await call(provider, "dispatchDeployment", { workflow: DEPLOY_WORKFLOW, ref: DEPLOY_REF, run_name: runName, expected_head_sha: currentMainSha, inputs: { site_commit: siteCommit, publication_mode: DEPLOY_MODE } }, "dispatch")
    } catch (error) {
      if (!(error instanceof HandoffFailure) || error.stage !== "dispatch") throw error
      dispatchError = error
    }
    let afterIds
    let newIds = []
    try {
      for (let attempt = 1; attempt <= PROVIDER_SETTLE_ATTEMPTS; attempt += 1) {
        afterIds = exactRunIds(await call(provider, "listMatchingDeploymentRuns", runQuery, "dispatch"))
        newIds = setDifference(afterIds, beforeIds)
        if (newIds.length === 1) break
        if (newIds.length > 1) throw fail("dispatch_uncertain", "dispatch")
        if (newIds.length === 0 && isStableFailure(dispatchError)) throw dispatchError
        if (attempt < PROVIDER_SETTLE_ATTEMPTS) await settleDelay()
      }
    } catch (error) {
      if (isStableFailure(error)) throw error
      throw fail("dispatch_uncertain", "dispatch")
    }
    if (newIds.length !== 1) {
      if (newIds.length === 0 && isStableFailure(dispatchError)) throw dispatchError
      throw fail("dispatch_uncertain", "dispatch")
    }
    const runId = newIds[0]
    identifiers.workflow_run_id = runId
    checks.push(check("dispatch"))
    await waitForProviderRead(async () => await call(provider, "readDeploymentRun", { id: runId, site_commit: siteCommit, publication_mode: DEPLOY_MODE, workflow: DEPLOY_WORKFLOW, ref: DEPLOY_REF, head_sha: currentMainSha }, "workflow").then((value) => validateRun(value, runId, siteCommit, runName, currentMainSha)))
    checks.push(check("deployment_run"))
    const pages = await waitForProviderRead(async () => await call(provider, "readPagesDeployment", { run_id: runId, site_commit: siteCommit }, "pages"))
    const deploymentTarget = validatePages(pages, runId, siteCommit)
    checks.push(check("pages"))
    const smokeInput = {
      target: deploymentTarget,
      routes: mapRoutes(operation.proposed_site_content_bytes),
      assets: mapAssets(candidate.files),
      not_found: { path: "/__t13_missing__", expected_status: 404 },
    }
    const smoke = await call(provider, "anonymousSmoke", smokeInput, "smoke")
    if (!isRecord(smoke) || !sameDeploymentTarget(smoke.target, deploymentTarget)
      || smoke.homepage_status !== 200 || smoke.not_found_status !== 404
      || !Array.isArray(smoke.route_statuses) || smoke.route_statuses.length !== smokeInput.routes.length || smoke.route_statuses.some((value) => value !== 200)
      || !Array.isArray(smoke.asset_statuses) || smoke.asset_statuses.length !== smokeInput.assets.length || smoke.asset_statuses.some((value) => value !== 200)) throw fail("smoke_failed", "smoke")
    checks.push(check("smoke"))
    return result(operationId, lane, "deployed", "已完成核准版本發布與部署核對。", checks, "none", null, identifiers)
  } catch (error) {
    return errorResult(operationId, lane, checks, error, identifiers)
  }
}
