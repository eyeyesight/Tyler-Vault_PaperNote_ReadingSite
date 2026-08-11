import { createHash } from "node:crypto"
import path from "node:path"

/**
 * @typedef {Record<string, unknown>} UnknownRecord
 * @typedef {UnknownRecord} Dependencies
 * @typedef {(...args: unknown[]) => unknown | Promise<unknown>} DependencyFunction
 * @typedef {"sha256" | "git"} ShaKind
 * @typedef {"100644" | "100755"} FileMode
 * @typedef {Object} FileInput
 * @property {unknown} [path]
 * @property {unknown} [relative]
 * @property {unknown} [bytes]
 * @property {unknown} [content]
 * @property {unknown} [mode]
 * @typedef {Object} FileEntry
 * @property {string} path
 * @property {Buffer} bytes
 * @property {FileMode} mode
 * @typedef {Object} FrozenInput
 * @property {string} vault_export_sha256
 * @property {string} source_main_sha
 * @property {string} policy_version
 * @property {string} expected_gh_pages_sha
 * @property {string} workflow_sha
 * @typedef {Object} PublicationOperation
 * @property {string} operation_id
 * @property {FrozenInput} frozen_input
 * @property {unknown} [status]
 * @property {unknown} [created_at]
 * @property {unknown} [updated_at]
 * @typedef {Object} NormalizedCandidate
 * @property {FileEntry[]} files
 * @property {string[]} routes
 * @property {string} site_sha256
 * @property {string} desired_site_sha256
 * @property {string} route_inventory_sha256
 * @property {string} file_inventory_sha256
 * @property {string | null} public_projection_sha256
 * @property {string | null} candidate_path
 * @typedef {Object} RemoteState
 * @property {string} main_sha
 * @property {string} gh_pages_sha
 * @property {string | null} site_sha256
 * @property {string | null} route_inventory_sha256
 * @property {string | null} file_inventory_sha256
 * @property {string | null} public_projection_sha256
 * @property {string | null} provider_site_commit
 * @property {string | null} live_site_sha256
 * @typedef {UnknownRecord & {id: number}} DeploymentRun
 * @typedef {Object} NormalizedDeployment
 * @property {string | number} deployment_id
 * @property {string} provider_site_commit
 * @property {string} live_site_sha256
 * @property {string | null} url
 * @typedef {Object} LiveIdentity
 * @property {unknown} deployment_id
 * @property {string} provider_site_commit
 * @property {string} live_site_sha256
 * @typedef {Object} Convergence
 * @property {string} desired_site_sha256
 * @property {string} public_site_sha256
 * @property {string} provider_site_commit
 * @property {string} live_site_sha256
 * @property {boolean} exact
 * @typedef {Object} Effects
 * @property {string | null} site_commit
 * @property {number | null} workflow_run_id
 * @property {string | number | null} deployment_id
 * @property {string | null} rollback_commit
 * @typedef {Object} VerifiedOutput
 * @property {string} site_sha256
 * @property {string} route_inventory_sha256
 * @property {string} file_inventory_sha256
 * @typedef {Object} PublicationError
 * @property {string} code
 * @property {string} stage
 * @property {boolean} live_verified
 * @property {string} next_action
 * @typedef {Object} TerminalNotification
 * @property {string} state
 * @property {string | null} notification_sha256
 * @property {number} delivery_attempts
 * @property {string | null} delivered_at
 * @typedef {Object} PublicationResult
 * @property {number} schema_version
 * @property {string} operation_id
 * @property {string} status
 * @property {string} created_at
 * @property {string} updated_at
 * @property {FrozenInput} frozen_input
 * @property {VerifiedOutput | null} verified_output
 * @property {Convergence | null} convergence
 * @property {Effects} effects
 * @property {string | null} public_projection_sha256
 * @property {string | null} lkg_record_sha256
 * @property {PublicationError | null} error
 * @property {TerminalNotification} terminal_notification
 * @typedef {"published" | "rolled_back"} ProjectionStateCode
 * @typedef {Object} PublicProjectionInput
 * @property {string} operation_id
 * @property {ProjectionStateCode} state_code
 * @property {string} source_main_sha
 * @property {string} site_commit
 * @property {string} site_sha256
 * @property {string} route_inventory_sha256
 * @property {string} workflow_sha
 * @typedef {Object} PublicProjection
 * @property {1} schema_version
 * @property {string} operation_id
 * @property {ProjectionStateCode} state_code
 * @property {string} source_main_sha
 * @property {string} site_commit
 * @property {string} site_sha256
 * @property {string} route_inventory_sha256
 * @property {string} workflow_sha
 * @typedef {Object} DispatchInput
 * @property {string} operation_id
 * @property {string} source_main_sha
 * @property {string} expected_gh_pages_sha
 * @property {string} workflow_sha
 * @property {string} site_commit
 * @property {string} site_sha256
 * @property {string} route_inventory_sha256
 * @property {string | null} public_projection_sha256
 * @typedef {Object} BoundedWorkerOptions
 * @property {number} [timeoutMs]
 * @property {() => unknown | Promise<unknown>} [terminateOwnedProcessTree]
 */

const OPERATION_ID = /^[0-9a-f]{32}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const GIT_SHA = /^[0-9a-f]{40}$/u
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\)(?:[^\/]+\/)*[^\/]+$/u
const FORBIDDEN_OUTPUT_PATH = /(?:^|\/)(?:\.git|\.env(?:\.|$)|attachments?|credentials?|drafts?|logs?|private|queue|runtime|secrets?)(?:\/|$)/iu
const PRIVATE_BYTES = /(?:-----BEGIN [^-]+ PRIVATE KEY-----|(?:^|[\s"'])Bearer\s+[A-Za-z0-9._~-]{20,}|(?:ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}|(?:[A-Z]:\\Users\\|\/Users\/|\/home\/|\\AppData\\Local\\))/u
const ROOT_KEYS = ["vault_root", "source_root", "git_root", "work_root", "temp_root", "output_root", "candidate_root"]
const FORBIDDEN_SETTING_KEYS = /(?:^|_)(?:approval|callback|handoff|preview|rollback|token|credential|secret)(?:_|$)/iu
const IDENTITY_SETTING_KEYS = new Set([
  "operation_id",
  "source_main_sha",
  "expected_gh_pages_sha",
  "vault_export_sha256",
  "desired_site_sha256",
  "site_commit",
  "workflow_run_id",
  "deployment_id",
])
const PUBLIC_PROJECTION_KEYS = new Set([
  "schema_version",
  "operation_id",
  "state_code",
  "source_main_sha",
  "site_commit",
  "site_sha256",
  "route_inventory_sha256",
  "workflow_sha",
])

export const PUBLICATION_STAGES = Object.freeze([
  "preparing",
  "verified",
  "publishing",
  "deploying",
  "verifying_live",
])

export class PublicationControllerError extends Error {
  /**
   * @param {string} code
   * @param {string} [stage="preparing"]
   */
  constructor(code, stage = "preparing") {
    super(code)
    this.name = "PublicationControllerError"
    this.code = code
    this.stage = stage
  }
}

/**
 * @param {unknown} value
 * @returns {value is UnknownRecord}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * @param {string | Uint8Array} value
 * @returns {string}
 */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  return /** @type {string} */ (JSON.stringify(value))
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function validIso(value) {
  if (typeof value !== "string") return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && value === new Date(timestamp).toISOString()
}

/**
 * @param {Dependencies} dependencies
 * @returns {string}
 */
function nowIso(dependencies) {
  const value = typeof dependencies.now === "function" ? dependencies.now() : new Date().toISOString()
  if (typeof value !== "string" || !validIso(value)) throw new PublicationControllerError("CLOCK_INVALID")
  return value
}

/**
 * @param {unknown} value
 * @param {ShaKind} kind
 * @returns {value is string}
 */
function validSha(value, kind) {
  return typeof value === "string" && (kind === "sha256" ? SHA256.test(value) : GIT_SHA.test(value))
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeOperationId(value) {
  const stringValue = /** @type {string} */ (value)
  return OPERATION_ID.test(stringValue) ? stringValue : "0".repeat(32)
}

/**
 * @param {unknown} value
 * @returns {FrozenInput}
 */
function safeFrozenInput(value) {
  if (!isRecord(value)) {
    return {
      vault_export_sha256: "0".repeat(64),
      source_main_sha: "0".repeat(40),
      policy_version: "invalid",
      expected_gh_pages_sha: "0".repeat(40),
      workflow_sha: "0".repeat(40),
    }
  }
  return {
    vault_export_sha256: validSha(value.vault_export_sha256, "sha256") ? value.vault_export_sha256 : "0".repeat(64),
    source_main_sha: validSha(value.source_main_sha, "git") ? value.source_main_sha : "0".repeat(40),
    policy_version: typeof value.policy_version === "string" && value.policy_version.length > 0 && value.policy_version.length <= 128
      ? value.policy_version
      : "invalid",
    expected_gh_pages_sha: validSha(value.expected_gh_pages_sha, "git") ? value.expected_gh_pages_sha : "0".repeat(40),
    workflow_sha: validSha(value.workflow_sha, "git") ? value.workflow_sha : "0".repeat(40),
  }
}

/**
 * @param {unknown} operation
 * @param {Dependencies} dependencies
 * @param {string} [status="needs_attention"]
 * @returns {PublicationResult}
 */
function baseRecord(operation, dependencies, status = "needs_attention") {
  const operationRecord = /** @type {UnknownRecord | null | undefined} */ (operation)
  const frozen = safeFrozenInput(operationRecord?.frozen_input)
  const createdAt = validIso(operationRecord?.created_at) ? operationRecord.created_at : nowIso(dependencies)
  const updatedAt = nowIso(dependencies)
  return {
    schema_version: 1,
    operation_id: safeOperationId(operationRecord?.operation_id),
    status,
    created_at: createdAt,
    updated_at: updatedAt,
    frozen_input: frozen,
    verified_output: null,
    convergence: null,
    effects: {
      site_commit: null,
      workflow_run_id: null,
      deployment_id: null,
      rollback_commit: null,
    },
    public_projection_sha256: null,
    lkg_record_sha256: null,
    error: null,
    terminal_notification: {
      state: "pending",
      notification_sha256: null,
      delivery_attempts: 0,
      delivered_at: null,
    },
  }
}

/**
 * @param {unknown} operation
 * @param {Dependencies} dependencies
 * @param {string} code
 * @param {string} [stage="preparing"]
 * @param {boolean} [liveVerified=false]
 * @param {unknown} [nextAction="reconcile the operation before retrying"]
 * @returns {PublicationResult}
 */
function resultWithError(operation, dependencies, code, stage = "preparing", liveVerified = false, nextAction = "reconcile the operation before retrying") {
  const result = baseRecord(operation, dependencies)
  result.error = {
    code: /^[A-Z][A-Z0-9_]{2,63}$/u.test(code) ? code : "PUBLICATION_FAILED",
    stage: typeof stage === "string" && stage.length > 0 && stage.length <= 128 ? stage : "preparing",
    live_verified: liveVerified === true,
    next_action: String(nextAction).slice(0, 300),
  }
  return result
}

/**
 * @param {unknown} settings
 * @returns {UnknownRecord}
 */
function rejectSettingShape(settings) {
  if (!isRecord(settings)) throw new PublicationControllerError("SETTINGS_INVALID")
  for (const key of Object.keys(settings)) {
    if (FORBIDDEN_SETTING_KEYS.test(key) || IDENTITY_SETTING_KEYS.has(key)) throw new PublicationControllerError("SETTINGS_INVALID")
  }
  /** @type {{key: string, resolved: string}[]} */
  const roots = []
  for (const key of ROOT_KEYS) {
    if (settings[key] === undefined) continue
    if (typeof settings[key] !== "string" || settings[key].length === 0 || settings[key].length > 1_024) throw new PublicationControllerError("ROOT_INVALID")
    const resolved = path.resolve(settings[key]).replace(/[\\/]$/u, "").toLowerCase()
    roots.push({ key, resolved })
  }
  for (let index = 0; index < roots.length; index += 1) {
    for (let other = index + 1; other < roots.length; other += 1) {
      const left = roots[index].resolved
      const right = roots[other].resolved
      const overlap = left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`)
      if (overlap) throw new PublicationControllerError("ROOTS_NOT_DISJOINT")
    }
  }
  if (settings.workflow_sha !== undefined && !validSha(settings.workflow_sha, "git")) throw new PublicationControllerError("SETTINGS_INVALID")
  return settings
}

/**
 * @param {unknown} operation
 * @returns {PublicationOperation}
 */
function validateOperation(operation) {
  if (!isRecord(operation) || !OPERATION_ID.test(/** @type {string} */ (operation.operation_id)) || !isRecord(operation.frozen_input)) throw new PublicationControllerError("OPERATION_INVALID")
  const frozen = operation.frozen_input
  if (!validSha(frozen.vault_export_sha256, "sha256")
    || !validSha(frozen.source_main_sha, "git")
    || typeof frozen.policy_version !== "string"
    || frozen.policy_version.length < 1
    || frozen.policy_version.length > 128
    || !validSha(frozen.expected_gh_pages_sha, "git")
    || !validSha(frozen.workflow_sha, "git")) throw new PublicationControllerError("OPERATION_INVALID")
  const allowed = new Set(["operation_id", "status", "created_at", "updated_at", "frozen_input"])
  for (const key of Object.keys(operation)) if (!allowed.has(key)) throw new PublicationControllerError("OPERATION_INVALID")
  if (operation.status !== undefined && operation.status !== "accepted") throw new PublicationControllerError("OPERATION_INVALID")
  return /** @type {PublicationOperation} */ (operation)
}

/**
 * @param {Dependencies} dependencies
 * @param {string} name
 * @returns {DependencyFunction | null}
 */
function getFunction(dependencies, name) {
  if (typeof dependencies?.[name] === "function") return /** @type {DependencyFunction} */ (dependencies[name])
  const groups = ["inputs", "renderer", "localGit", "provider", "liveQa"]
  for (const group of groups) {
    const groupValue = /** @type {UnknownRecord | null | undefined} */ (dependencies?.[group])
    if (typeof groupValue?.[name] === "function") return /** @type {DependencyFunction} */ (groupValue[name])
  }
  return null
}

/**
 * @param {Dependencies} dependencies
 * @param {string} name
 * @param {unknown} input
 * @param {string} [stage]
 * @returns {Promise<unknown>}
 */
async function invoke(dependencies, name, input, stage) {
  const fn = getFunction(dependencies, name)
  if (!fn) throw new PublicationControllerError("COMPONENT_UNAVAILABLE", /** @type {string} */ (stage))
  try {
    return await fn(input)
  } catch (error) {
    if (error instanceof PublicationControllerError) throw error
    if (error && typeof error === "object" && (/** @type {{code?: unknown}} */ (error)).code === "TIMEOUT") throw new PublicationControllerError("WORKER_TIMEOUT", /** @type {string} */ (stage))
    throw new PublicationControllerError(`${(/** @type {string} */ (stage)).toUpperCase()}_FAILED`, /** @type {string} */ (stage))
  }
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function safeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && SAFE_PATH.test(value) && value.normalize("NFC") === value
}

/**
 * @param {unknown} value
 * @returns {Buffer | null}
 */
function asBytes(value) {
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === "string") return Buffer.from(value, "utf8")
  return null
}

/**
 * @param {UnknownRecord} candidate
 * @returns {FileEntry[]}
 */
function normalizeFiles(candidate) {
  const files = candidate.site_files ?? candidate.files
  if (!Array.isArray(files) || files.length === 0 || files.length > 10_000) throw new PublicationControllerError("CANDIDATE_INVALID", "verified")
  const normalized = files.map((/** @type {unknown} */ file) => {
    if (!isRecord(file)) throw new PublicationControllerError("CANDIDATE_INVALID", "verified")
    const relativePath = file.path ?? file.relative
    const bytes = asBytes(file.bytes ?? file.content)
    const mode = /** @type {FileMode} */ (file.mode ?? "100644")
    if (!safeRelativePath(relativePath) || !bytes || bytes.length > 10_000_000 || !["100644", "100755"].includes(mode)) throw new PublicationControllerError("CANDIDATE_INVALID", "verified")
    if (FORBIDDEN_OUTPUT_PATH.test(relativePath) || PRIVATE_BYTES.test(bytes.toString("utf8"))) throw new PublicationControllerError("PRIVACY_FAILED", "verified")
    return { path: relativePath, bytes, mode }
  })
  normalized.sort((left, right) => left.path.localeCompare(right.path))
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].path === normalized[index].path) throw new PublicationControllerError("CANDIDATE_INVALID", "verified")
  }
  if (!normalized.some((file) => file.path === "index.html")) throw new PublicationControllerError("CANDIDATE_INVALID", "verified")
  return normalized
}

/**
 * @param {FileInput[]} files
 * @returns {string}
 */
export function hashFileInventory(files) {
  const normalized = files.map((file) => {
    const pathName = file.path ?? file.relative
    const bytes = asBytes(file.bytes ?? file.content)
    const mode = file.mode ?? "100644"
    return `${pathName}\0${mode}\0${bytes ? sha256(bytes) : ""}\0${bytes?.length ?? 0}\n`
  }).sort().join("")
  return sha256(normalized)
}

/**
 * @param {FileInput[]} files
 * @returns {string}
 */
export function hashSiteTree(files) {
  return hashFileInventory(files)
}

/**
 * @param {unknown} routes
 * @returns {string}
 */
export function hashRouteInventory(routes) {
  if (!Array.isArray(routes)) throw new TypeError("routes must be an array")
  return sha256(canonicalJson(routes))
}

/**
 * @param {PublicProjectionInput} input
 * @returns {PublicProjection}
 */
export function createPublicProjection(input) {
  return {
    schema_version: 1,
    operation_id: input.operation_id,
    state_code: input.state_code,
    source_main_sha: input.source_main_sha,
    site_commit: input.site_commit,
    site_sha256: input.site_sha256,
    route_inventory_sha256: input.route_inventory_sha256,
    workflow_sha: input.workflow_sha,
  }
}

/**
 * @param {unknown} projection
 * @returns {string}
 */
export function hashPublicProjection(projection) {
  if (!isRecord(projection)) throw new TypeError("public projection must be an object")
  const keys = Object.keys(projection)
  if (keys.length !== PUBLIC_PROJECTION_KEYS.size || keys.some((key) => !PUBLIC_PROJECTION_KEYS.has(key))) {
    throw new TypeError("public projection shape is invalid")
  }
  return sha256(Buffer.from(canonicalJson(projection), "utf8"))
}

/**
 * @param {UnknownRecord} candidate
 * @param {PublicationOperation} operation
 * @param {FileEntry[]} normalizedFiles
 * @returns {string | null}
 */
function validateProjection(candidate, operation, normalizedFiles) {
  if (["public_projection", "public_projection_bytes", "public_projection_sha256"]
    .some((key) => Object.hasOwn(candidate, key))) {
    throw new PublicationControllerError("PRIVACY_FAILED", "verified")
  }
  void operation
  void normalizedFiles
  return null
}

/**
 * @param {unknown} candidate
 * @param {PublicationOperation} operation
 * @returns {NormalizedCandidate}
 */
function normalizeCandidate(candidate, operation) {
  if (!isRecord(candidate)) throw new PublicationControllerError("CANDIDATE_INVALID", "verified")
  const files = normalizeFiles(candidate)
  const routeInventory = candidate.routes
  if (!Array.isArray(routeInventory) || routeInventory.length === 0 || routeInventory.some((route) => typeof route !== "string")) throw new PublicationControllerError("CANDIDATE_INVALID", "verified")
  const routes = /** @type {string[]} */ (routeInventory)
  const fileInventorySha256 = hashFileInventory(files)
  const siteSha256 = hashSiteTree(files)
  const routeInventorySha256 = hashRouteInventory(routes)
  const expectedSite = candidate.desired_site_sha256 ?? candidate.site_sha256
  if (!validSha(expectedSite, "sha256") || expectedSite !== siteSha256) throw new PublicationControllerError("CANDIDATE_INVALID", "verified")
  if (!validSha(candidate.file_inventory_sha256, "sha256") || candidate.file_inventory_sha256 !== fileInventorySha256) throw new PublicationControllerError("CANDIDATE_INVALID", "verified")
  if (!validSha(candidate.route_inventory_sha256, "sha256") || candidate.route_inventory_sha256 !== routeInventorySha256) throw new PublicationControllerError("CANDIDATE_INVALID", "verified")
  validateProjection(candidate, operation, files)
  return {
    files,
    routes: [...routes],
    site_sha256: siteSha256,
    desired_site_sha256: siteSha256,
    route_inventory_sha256: routeInventorySha256,
    file_inventory_sha256: fileInventorySha256,
    public_projection_sha256: null,
    candidate_path: typeof candidate.candidate_path === "string" ? candidate.candidate_path : null,
  }
}

/**
 * @param {unknown} record
 * @param {string[]} names
 * @param {ShaKind} [kind="sha256"]
 * @returns {string | null}
 */
function readHash(record, names, kind = "sha256") {
  if (!isRecord(record)) return null
  for (const name of names) {
    if (record[name] !== undefined) return validSha(record[name], kind) ? record[name] : null
  }
  return null
}

/**
 * @param {unknown} remote
 * @param {FrozenInput} frozen
 * @param {string | null} [expectedPagesSha]
 * @returns {RemoteState}
 */
function normalizeRemote(remote, frozen, expectedPagesSha = frozen.expected_gh_pages_sha) {
  if (!isRecord(remote)) throw new PublicationControllerError("REMOTE_READBACK_FAILED", "preparing")
  const mainSha = readHash(remote, ["main_sha", "source_main_sha", "main_head"], "git")
  const pagesSha = readHash(remote, ["gh_pages_sha", "gh_pages_head", "public_head"], "git")
  if (mainSha !== frozen.source_main_sha || !pagesSha || (expectedPagesSha !== null && pagesSha !== expectedPagesSha)) throw new PublicationControllerError("REMOTE_DRIFT", "preparing")
  if (remote.workflow_sha !== undefined && remote.workflow_sha !== frozen.workflow_sha) throw new PublicationControllerError("WORKFLOW_DRIFT", "preparing")
  return {
    main_sha: mainSha,
    gh_pages_sha: pagesSha,
    site_sha256: readHash(remote, ["site_sha256", "public_site_sha256"]),
    route_inventory_sha256: readHash(remote, ["route_inventory_sha256"]),
    file_inventory_sha256: readHash(remote, ["file_inventory_sha256"]),
    public_projection_sha256: readHash(remote, ["public_projection_sha256"]),
    provider_site_commit: readHash(remote, ["provider_site_commit"], "git"),
    live_site_sha256: readHash(remote, ["live_site_sha256"]),
  }
}

/**
 * @param {unknown} value
 * @returns {DeploymentRun[]}
 */
function normalizedRuns(value) {
  if (!Array.isArray(value) || value.length > 2) throw new PublicationControllerError("DISPATCH_UNCERTAIN", "deploying")
  return value.map((/** @type {unknown} */ run) => {
    if (!isRecord(run)) throw new PublicationControllerError("DISPATCH_UNCERTAIN", "deploying")
    const id = run.id ?? run.run_id ?? run.workflow_run_id
    if (!(typeof id === "number" && Number.isSafeInteger(id) && id > 0) && !(typeof id === "string" && /^[1-9][0-9]*$/u.test(id))) throw new PublicationControllerError("DISPATCH_UNCERTAIN", "deploying")
    return { ...run, id: typeof id === "number" ? id : Number(id) }
  })
}

/**
 * @param {DeploymentRun[]} runs
 * @param {string} operationId
 * @param {string} siteCommit
 * @returns {DeploymentRun[]}
 */
function matchingRuns(runs, operationId, siteCommit) {
  return runs.filter((run) => {
    if (run.operation_id !== undefined && run.operation_id !== operationId) return false
    if (run.site_commit !== undefined && run.site_commit !== siteCommit) return false
    return true
  })
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizeRunId(value) {
  const record = /** @type {UnknownRecord | null | undefined} */ (value)
  const id = record?.id ?? record?.run_id ?? record?.workflow_run_id
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id
  if (typeof id === "string" && /^[1-9][0-9]*$/u.test(id)) return Number(id)
  return null
}

/**
 * @param {unknown} value
 * @param {PublicationOperation} operation
 * @param {string} siteCommit
 * @param {string} desiredSiteSha256
 * @returns {NormalizedDeployment}
 */
function normalizeDeployment(value, operation, siteCommit, desiredSiteSha256) {
  if (!isRecord(value)) throw new PublicationControllerError("PROVIDER_READBACK_FAILED", "verifying_live")
  const providerSiteCommit = readHash(value, ["site_commit", "provider_site_commit"], "git")
  const liveSiteSha256 = readHash(value, ["live_site_sha256", "site_sha256", "public_site_sha256"])
  const deploymentId = value.deployment_id ?? value.id
  if (!providerSiteCommit || providerSiteCommit !== siteCommit || !liveSiteSha256 || liveSiteSha256 !== desiredSiteSha256
    || (value.operation_id !== undefined && value.operation_id !== operation.operation_id)
    || (deploymentId !== undefined && deploymentId === null)) throw new PublicationControllerError("PROVIDER_READBACK_FAILED", "verifying_live")
  if (typeof deploymentId !== "string" && typeof deploymentId !== "number") throw new PublicationControllerError("PROVIDER_READBACK_FAILED", "verifying_live")
  return { deployment_id: deploymentId, provider_site_commit: providerSiteCommit, live_site_sha256: liveSiteSha256, url: typeof value.url === "string" ? value.url : null }
}

/**
 * @param {NormalizedCandidate} candidate
 * @param {RemoteState} publicState
 * @param {NormalizedDeployment} deployment
 * @returns {Convergence}
 */
function assertConvergence(candidate, publicState, deployment) {
  const publicSiteSha256 = publicState.site_sha256
  if (!publicSiteSha256 || publicSiteSha256 !== candidate.site_sha256) throw new PublicationControllerError("PUBLIC_READBACK_FAILED", "verifying_live")
  const routeMatch = publicState.route_inventory_sha256 === null || publicState.route_inventory_sha256 === candidate.route_inventory_sha256
  const fileMatch = publicState.file_inventory_sha256 === null || publicState.file_inventory_sha256 === candidate.file_inventory_sha256
  if (!routeMatch || !fileMatch) throw new PublicationControllerError("PUBLIC_READBACK_FAILED", "verifying_live")
  return {
    desired_site_sha256: candidate.site_sha256,
    public_site_sha256: publicSiteSha256,
    provider_site_commit: deployment.provider_site_commit,
    live_site_sha256: deployment.live_site_sha256,
    exact: publicSiteSha256 === candidate.site_sha256 && deployment.live_site_sha256 === candidate.site_sha256,
  }
}

/**
 * @param {PublicationOperation} operation
 * @param {FrozenInput} frozen
 * @param {NormalizedCandidate} candidate
 * @param {string} siteCommit
 * @param {string | null} publicProjectionSha256
 * @returns {DispatchInput}
 */
function exactDispatchInput(operation, frozen, candidate, siteCommit, publicProjectionSha256) {
  return {
    operation_id: operation.operation_id,
    source_main_sha: frozen.source_main_sha,
    expected_gh_pages_sha: frozen.expected_gh_pages_sha,
    workflow_sha: frozen.workflow_sha,
    site_commit: siteCommit,
    site_sha256: candidate.site_sha256,
    route_inventory_sha256: candidate.route_inventory_sha256,
    public_projection_sha256: publicProjectionSha256,
  }
}

/**
 * @param {PublicationOperation} operation
 * @param {FrozenInput} frozen
 * @param {NormalizedCandidate} candidate
 * @returns {UnknownRecord}
 */
function exactCandidateInput(operation, frozen, candidate) {
  return {
    operation_id: operation.operation_id,
    expected_gh_pages_sha: frozen.expected_gh_pages_sha,
    source_main_sha: frozen.source_main_sha,
    workflow_sha: frozen.workflow_sha,
    site_sha256: candidate.site_sha256,
    route_inventory_sha256: candidate.route_inventory_sha256,
    file_inventory_sha256: candidate.file_inventory_sha256,
    files: candidate.files,
    routes: candidate.routes,
    candidate_path: candidate.candidate_path,
  }
}

/**
 * @param {PublicationResult} result
 * @param {NormalizedCandidate} candidate
 * @returns {void}
 */
function setOutput(result, candidate) {
  result.verified_output = {
    site_sha256: candidate.site_sha256,
    route_inventory_sha256: candidate.route_inventory_sha256,
    file_inventory_sha256: candidate.file_inventory_sha256,
  }
}

/**
 * @param {Dependencies} dependencies
 * @param {PublicationOperation} operation
 * @param {NormalizedCandidate} candidate
 * @param {RemoteState} remote
 * @param {UnknownRecord} providerInput
 * @param {string} [stage="verifying_live"]
 * @returns {Promise<LiveIdentity | null>}
 */
async function readLiveIdentity(dependencies, operation, candidate, remote, providerInput, stage = "verifying_live") {
  const read = getFunction(dependencies, "readLiveIdentity")
  const value = read
    ? await invoke(dependencies, "readLiveIdentity", providerInput, stage)
    : {
      provider_site_commit: remote.provider_site_commit,
      live_site_sha256: remote.live_site_sha256,
      deployment_id: "readback",
    }
  if (!isRecord(value)) return null
  const providerSiteCommit = readHash(value, ["site_commit", "provider_site_commit"], "git")
  const liveSiteSha256 = readHash(value, ["live_site_sha256", "site_sha256", "public_site_sha256"])
  if (!providerSiteCommit || !liveSiteSha256) return null
  if (value.operation_id !== undefined && value.operation_id !== operation.operation_id) throw new PublicationControllerError("PROVIDER_READBACK_FAILED", stage)
  void candidate
  return {
    deployment_id: value.deployment_id ?? value.id ?? "readback",
    provider_site_commit: providerSiteCommit,
    live_site_sha256: liveSiteSha256,
  }
}

/**
 * @param {Dependencies} dependencies
 * @param {PublicationOperation} operation
 * @param {FrozenInput} frozen
 * @param {NormalizedCandidate} candidate
 * @param {string} siteCommit
 * @param {string} expectedOldHead
 * @returns {Promise<RemoteState>}
 */
async function reconcilePush(dependencies, operation, frozen, candidate, siteCommit, expectedOldHead) {
  const readState = getFunction(dependencies, "readRemoteAuthority")
  if (!readState) throw new PublicationControllerError("COMPONENT_UNAVAILABLE", "publishing")
  let pushed = false
  try {
    await invoke(dependencies, "pushGhPages", exactCandidateInput(operation, frozen, candidate), "publishing")
    pushed = true
  } catch (error) {
    let observed
    try { observed = normalizeRemote(await readState({ operation_id: operation.operation_id }), frozen, null) } catch { throw new PublicationControllerError("PUSH_UNCERTAIN", "publishing") }
    if (observed.gh_pages_sha !== siteCommit) throw error instanceof PublicationControllerError && error.code === "REMOTE_DRIFT"
      ? error
      : new PublicationControllerError("PUSH_UNCERTAIN", "publishing")
    return observed
  }
  if (!pushed) throw new PublicationControllerError("PUSH_UNCERTAIN", "publishing")
  const observed = normalizeRemote(await invoke(dependencies, "readRemoteAuthority", { operation_id: operation.operation_id }), frozen, null)
  if (observed.gh_pages_sha !== siteCommit) throw new PublicationControllerError("PUSH_READBACK_FAILED", "publishing")
  if (observed.site_sha256 !== candidate.site_sha256) throw new PublicationControllerError("PUBLIC_READBACK_FAILED", "publishing")
  void expectedOldHead
  return observed
}

/**
 * @param {Dependencies} dependencies
 * @param {PublicationOperation} operation
 * @param {FrozenInput} frozen
 * @param {NormalizedCandidate} candidate
 * @param {string} siteCommit
 * @param {string} publicProjectionSha256
 * @returns {Promise<{runId: number, input: DispatchInput}>}
 */
async function dispatchOnce(dependencies, operation, frozen, candidate, siteCommit, publicProjectionSha256) {
  const input = exactDispatchInput(operation, frozen, candidate, siteCommit, publicProjectionSha256)
  const list = getFunction(dependencies, "listMatchingDeploymentRuns")
  if (!list) throw new PublicationControllerError("COMPONENT_UNAVAILABLE", "deploying")
  const before = matchingRuns(normalizedRuns(await invoke(dependencies, "listMatchingDeploymentRuns", input, "deploying")), operation.operation_id, siteCommit)
  if (before.length > 1) throw new PublicationControllerError("DUPLICATE_WORKFLOW_RUNS", "deploying")
  if (before.length === 1) return { runId: before[0].id, input }
  const dispatch = getFunction(dependencies, "dispatchDeployment")
  if (!dispatch) throw new PublicationControllerError("COMPONENT_UNAVAILABLE", "deploying")
  let dispatchResult = null
  let dispatchError = null
  try {
    dispatchResult = await invoke(dependencies, "dispatchDeployment", input, "deploying")
  } catch (error) {
    dispatchError = error
  }
  const after = matchingRuns(normalizedRuns(await invoke(dependencies, "listMatchingDeploymentRuns", input, "deploying")), operation.operation_id, siteCommit)
  if (after.length > 1) throw new PublicationControllerError("DUPLICATE_WORKFLOW_RUNS", "deploying")
  if (after.length === 1) return { runId: after[0].id, input }
  const dispatchId = normalizeRunId(dispatchResult)
  if (!dispatchError && dispatchId !== null) return { runId: dispatchId, input }
  if (dispatchError) throw new PublicationControllerError("DISPATCH_UNCERTAIN", "deploying")
  throw new PublicationControllerError("DISPATCH_UNCERTAIN", "deploying")
}

/**
 * @param {unknown} rawOperation
 * @param {unknown} settings
 * @param {Dependencies} dependencies
 * @returns {Promise<PublicationResult>}
 */
async function runPublication(rawOperation, settings, dependencies) {
  const operation = validateOperation(rawOperation)
  const fixed = rejectSettingShape(settings)
  const frozen = operation.frozen_input
  if (fixed.workflow_sha !== undefined && fixed.workflow_sha !== frozen.workflow_sha) throw new PublicationControllerError("FROZEN_SETTING_MISMATCH")
  const accepted = await invoke(dependencies, "readAcceptedInputs", {
    operation_id: operation.operation_id,
    frozen_input: { ...frozen },
    settings: fixed,
  }, "preparing")
  if (!isRecord(accepted)
    || accepted.vault_export_sha256 !== frozen.vault_export_sha256
    || accepted.source_main_sha !== frozen.source_main_sha
    || accepted.policy_version !== frozen.policy_version) throw new PublicationControllerError("INPUT_DRIFT", "preparing")
  const candidateRaw = await invoke(dependencies, "buildCandidate", {
    operation_id: operation.operation_id,
    frozen_input: { ...frozen },
    accepted_inputs: accepted,
    settings: fixed,
  }, "preparing")
  const candidate = normalizeCandidate(candidateRaw, operation)
  const initial = normalizeRemote(await invoke(dependencies, "readRemoteAuthority", { operation_id: operation.operation_id }, "preparing"), frozen)
  if (initial.gh_pages_sha !== frozen.expected_gh_pages_sha) throw new PublicationControllerError("REMOTE_DRIFT", "preparing")
  const result = baseRecord(operation, dependencies, "verified")
  setOutput(result, candidate)

  const initialDeployment = await readLiveIdentity(
    dependencies,
    operation,
    candidate,
    initial,
    { ...exactDispatchInput(operation, frozen, candidate, frozen.expected_gh_pages_sha, null), site_commit: initial.provider_site_commit ?? frozen.expected_gh_pages_sha },
    "verifying_live",
  )
  const alreadyConverged = initial.site_sha256 === candidate.site_sha256
    && initial.route_inventory_sha256 === candidate.route_inventory_sha256
    && initial.file_inventory_sha256 === candidate.file_inventory_sha256
    && initialDeployment !== null
    && initialDeployment.live_site_sha256 === candidate.site_sha256
  if (alreadyConverged) {
    result.status = "no_change"
    result.convergence = {
      desired_site_sha256: candidate.site_sha256,
      public_site_sha256: /** @type {string} */ (initial.site_sha256),
      provider_site_commit: initialDeployment.provider_site_commit,
      live_site_sha256: initialDeployment.live_site_sha256,
      exact: true,
    }
    return result
  }

  const createCandidate = getFunction(dependencies, "createCandidateCommit")
  if (!createCandidate) throw new PublicationControllerError("COMPONENT_UNAVAILABLE", "publishing")
  const commit = /** @type {UnknownRecord} */ (await invoke(dependencies, "createCandidateCommit", exactCandidateInput(operation, frozen, candidate), "publishing"))
  const siteCommit = commit?.site_commit ?? commit?.commit_sha
  if (!validSha(siteCommit, "git") || commit.parent_sha !== frozen.expected_gh_pages_sha) throw new PublicationControllerError("CANDIDATE_COMMIT_INVALID", "publishing")
  const publicProjection = createPublicProjection({
    operation_id: operation.operation_id,
    state_code: "published",
    source_main_sha: frozen.source_main_sha,
    site_commit: /** @type {string} */ (siteCommit),
    site_sha256: candidate.site_sha256,
    route_inventory_sha256: candidate.route_inventory_sha256,
    workflow_sha: frozen.workflow_sha,
  })
  const publicProjectionSha256 = hashPublicProjection(publicProjection)
  const readCandidate = getFunction(dependencies, "readCandidateCommit")
  if (readCandidate) {
    const readback = await invoke(dependencies, "readCandidateCommit", { ...exactCandidateInput(operation, frozen, candidate), site_commit: siteCommit }, "publishing")
    if (!isRecord(readback) || readback.site_sha256 !== candidate.site_sha256 || readback.commit_sha !== undefined && readback.commit_sha !== siteCommit) throw new PublicationControllerError("CANDIDATE_READBACK_FAILED", "publishing")
  }
  const remoteAfterPush = await reconcilePush(dependencies, operation, frozen, candidate, siteCommit, frozen.expected_gh_pages_sha)
  result.status = "deploying"
  const dispatch = await dispatchOnce(dependencies, operation, frozen, candidate, siteCommit, publicProjectionSha256)
  const readRun = await invoke(dependencies, "readDeploymentRun", { ...dispatch.input, workflow_run_id: dispatch.runId }, "deploying")
  const readRunRecord = /** @type {UnknownRecord | null | undefined} */ (readRun)
  const runId = normalizeRunId(readRun) ?? dispatch.runId
  if (runId !== dispatch.runId
    || (readRunRecord?.operation_id !== undefined && readRunRecord.operation_id !== operation.operation_id)
    || (readRunRecord?.site_commit !== undefined && readRunRecord.site_commit !== siteCommit)
    || (readRunRecord?.workflow_sha !== undefined && readRunRecord.workflow_sha !== frozen.workflow_sha)
    || (readRunRecord?.status !== undefined && readRunRecord.status !== "completed")
    || (readRunRecord?.conclusion !== undefined && readRunRecord.conclusion !== "success")) throw new PublicationControllerError("WORKFLOW_FAILED", "deploying")
  const deployment = await invoke(dependencies, "readPagesDeployment", { ...dispatch.input, workflow_run_id: dispatch.runId }, "verifying_live")
  const normalizedDeployment = normalizeDeployment(deployment, operation, siteCommit, candidate.site_sha256)
  const finalRemote = normalizeRemote(await invoke(dependencies, "readRemoteAuthority", { operation_id: operation.operation_id }, "verifying_live"), frozen, siteCommit)
  if (finalRemote.gh_pages_sha !== siteCommit) throw new PublicationControllerError("PUBLIC_HEAD_READBACK_FAILED", "verifying_live")
  const convergence = assertConvergence(candidate, { ...remoteAfterPush, ...finalRemote }, normalizedDeployment)
  result.status = "published"
  result.convergence = convergence
  result.effects = {
    site_commit: siteCommit,
    workflow_run_id: dispatch.runId,
    deployment_id: normalizedDeployment.deployment_id,
    rollback_commit: null,
  }
  result.public_projection_sha256 = publicProjectionSha256
  return result
}

/**
 * @param {unknown} [settings={}]
 * @param {Dependencies} [dependencies={}]
 * @returns {{publish: (operation: unknown) => Promise<PublicationResult>}}
 */
export function createExactPublicationController(settings = {}, dependencies = {}) {
  const fixed = rejectSettingShape(settings)
  return Object.freeze({
    /**
     * @param {unknown} operation
     * @returns {Promise<PublicationResult>}
     */
    async publish(operation) {
      try {
        return await runPublication(operation, fixed, dependencies)
      } catch (error) {
        const code = error instanceof PublicationControllerError ? error.code : "PUBLICATION_FAILED"
        const stage = error instanceof PublicationControllerError ? error.stage : "preparing"
        const liveVerified = ["verifying_live", "published"].includes(stage) && code === "PROVIDER_READBACK_FAILED"
        return resultWithError(operation, dependencies, code, stage, liveVerified)
      }
    },
  })
}

export const createPublicationController = createExactPublicationController

/**
 * @param {unknown} operation
 * @param {unknown} [settings={}]
 * @param {Dependencies} [dependencies={}]
 * @returns {Promise<PublicationResult>}
 */
export async function runExactPublication(operation, settings = {}, dependencies = {}) {
  try {
    return await createExactPublicationController(settings, dependencies).publish(operation)
  } catch (error) {
    const code = error instanceof PublicationControllerError ? error.code : "SETTINGS_INVALID"
    const stage = error instanceof PublicationControllerError ? error.stage : "preparing"
    return resultWithError(operation, dependencies, code, stage)
  }
}

export const runPublicationWorker = runExactPublication

/**
 * @param {() => unknown | Promise<unknown>} worker
 * @param {BoundedWorkerOptions} [options={}]
 * @returns {Promise<unknown>}
 */
export async function runBoundedPublicationWorker(worker, options = {}) {
  if (typeof worker !== "function") throw new TypeError("worker must be a function")
  const timeoutMs = options.timeoutMs ?? 120_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new TypeError("timeoutMs is invalid")
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  let timedOut = false
  try {
    return await Promise.race([
      Promise.resolve().then(worker),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new PublicationControllerError("WORKER_TIMEOUT", "preparing"))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (timedOut && typeof options.terminateOwnedProcessTree === "function") {
      try { await options.terminateOwnedProcessTree() } catch { /* terminal result remains uncertain */ }
    }
  }
}
