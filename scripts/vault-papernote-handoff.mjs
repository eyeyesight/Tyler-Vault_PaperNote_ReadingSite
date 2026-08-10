#!/usr/bin/env node
// @ts-nocheck -- this is a deliberately small stdin-to-controller boundary.
import path from "node:path"
import { types as utilTypes } from "node:util"
import { fileURLToPath } from "node:url"

import { createRoutinePublicationAdapter } from "../lib/routine-publication-adapter.mjs"
import { routinePublicationHandoff } from "../lib/routine-publication-handoff.mjs"

export const MAX_HANDOFF_STDIN_BYTES = 64 * 1024
export const MAX_HANDOFF_ENV_VALUE_BYTES = 4 * 1024

const HANDOFF_ENV_PREFIX = "VAULT_PAPERNOTE_HANDOFF_"
const ENVIRONMENT_FIELDS = Object.freeze([
  ["VAULT_PAPERNOTE_HANDOFF_GIT_ROOT", "gitRoot"],
  ["VAULT_PAPERNOTE_HANDOFF_GIT_EXECUTABLE", "gitExecutable"],
  ["VAULT_PAPERNOTE_HANDOFF_GH_EXECUTABLE", "ghExecutable"],
  ["VAULT_PAPERNOTE_HANDOFF_GH_CONFIG_DIR", "ghConfigDir"],
  ["VAULT_PAPERNOTE_HANDOFF_REMOTE", "remote"],
  ["VAULT_PAPERNOTE_HANDOFF_REPOSITORY", "repository"],
  ["VAULT_PAPERNOTE_HANDOFF_ACTOR", "actor"],
  ["VAULT_PAPERNOTE_HANDOFF_MAIN_REF", "mainRef"],
  ["VAULT_PAPERNOTE_HANDOFF_GH_PAGES_REF", "ghPagesRef"],
  ["VAULT_PAPERNOTE_HANDOFF_OPERATION_ROOT", "operationRoot"],
])
const HANDOFF_TRANSPORT_FIELDS = Object.freeze([
  "version",
  "operation_id",
  "lane",
  "approval",
  "candidate_identity",
  "claimed_session",
  "proposed_site_content_base64",
])
const REQUIRED_ENV_KEYS = new Set(ENVIRONMENT_FIELDS.map(([key]) => key))
const STABLE_ADAPTER_FAILURE_CODES = new Set(["auth_failed", "rate_limited", "provider_unavailable"])
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

export class HandoffCliError extends Error {
  constructor(code) {
    super(code)
    this.name = "HandoffCliError"
    this.code = code
  }
}

function fail(code) {
  throw new HandoffCliError(code)
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    if (Object.getOwnPropertySymbols(value).length !== 0) return false
    return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => Object.hasOwn(descriptor, "value"))
  } catch {
    return false
  }
}

function boundedEnvironmentValue(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) fail("environment_invalid")
  if (value.length > MAX_HANDOFF_ENV_VALUE_BYTES || Buffer.byteLength(value, "utf8") > MAX_HANDOFF_ENV_VALUE_BYTES) fail("environment_invalid")
  return value
}

/**
 * Project only the ten Plugin-owned handoff values into the adapter factory
 * config. Ambient PATH, credentials, and every unrelated setting stay out.
 */
export function parseHandoffEnvironment(environment = process.env) {
  try {
    if (!environment || (typeof environment !== "object" && typeof environment !== "function")) fail("environment_invalid")
    for (const key of Object.keys(environment)) {
      const upper = key.toUpperCase()
      if ((upper.startsWith(HANDOFF_ENV_PREFIX) && !REQUIRED_ENV_KEYS.has(key)) || upper === "TOKEN") fail("environment_invalid")
    }
    const config = {}
    for (const [environmentKey, configKey] of ENVIRONMENT_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(environment, environmentKey)
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) fail("environment_invalid")
      config[configKey] = boundedEnvironmentValue(descriptor.value)
    }
    return Object.freeze(config)
  } catch (error) {
    if (error instanceof HandoffCliError) throw error
    throw new HandoffCliError("environment_invalid")
  }
}

function inputBytes(input) {
  if (Buffer.isBuffer(input)) return Buffer.from(input)
  if (input instanceof Uint8Array && !(input instanceof DataView)) return Buffer.from(input)
  if (typeof input === "string") return Buffer.from(input, "utf8")
  return null
}

function parseJsonBytes(bytes) {
  if (bytes.length === 0) fail("stdin_empty")
  if (bytes.length > MAX_HANDOFF_STDIN_BYTES) fail("stdin_limit")
  let text
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    fail("document_invalid")
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    fail("document_invalid")
  }
  if (!isPlainObject(value)) fail("document_invalid")
  return value
}

function exactTransportRecord(value) {
  if (!isPlainObject(value)) fail("document_invalid")
  const names = Object.getOwnPropertyNames(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  const expected = [...HANDOFF_TRANSPORT_FIELDS].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail("document_invalid")
  const result = Object.create(null)
  for (const key of HANDOFF_TRANSPORT_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) fail("document_invalid")
    result[key] = descriptor.value
  }
  return result
}

function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0
    || !/^[\x00-\x7f]+$/u.test(value) || !CANONICAL_BASE64.test(value)) fail("document_invalid")
  const bytes = Buffer.from(value, "base64")
  if (bytes.length === 0 || bytes.toString("base64") !== value) fail("document_invalid")
  return bytes
}

/** Decode the exact JSON transport envelope without applying controller policy. */
export function decodeHandoffDocument(input) {
  const raw = exactTransportRecord(input)
  return {
    version: raw.version,
    operation_id: raw.operation_id,
    lane: raw.lane,
    approval: raw.approval,
    candidate_identity: raw.candidate_identity,
    claimed_session: raw.claimed_session,
    proposed_site_content_bytes: decodeCanonicalBase64(raw.proposed_site_content_base64),
  }
}

/** Parse a bounded UTF-8 JSON document, retaining injected nested objects by identity. */
export function parseHandoffDocument(input) {
  const bytes = inputBytes(input)
  if (bytes !== null) return decodeHandoffDocument(parseJsonBytes(bytes))
  return decodeHandoffDocument(input)
}

/** Read no more than one bounded handoff document from a Node readable. */
export async function readBoundedStdin(stream = process.stdin) {
  const chunks = []
  let total = 0
  try {
    for await (const chunk of stream) {
      const bytes = inputBytes(chunk)
      if (bytes === null) fail("document_invalid")
      if (bytes.length > MAX_HANDOFF_STDIN_BYTES - total) fail("stdin_limit")
      chunks.push(bytes)
      total += bytes.length
    }
  } catch (error) {
    if (error instanceof HandoffCliError) throw error
    throw new HandoffCliError("document_invalid")
  }
  return Buffer.concat(chunks, total)
}

function dependency(options, names, fallback) {
  for (const name of names) {
    if (Object.hasOwn(options, name)) return options[name]
  }
  return fallback
}

function safeAdapterFailureCode(error) {
  try {
    if (!error || typeof error !== "object" || typeof error.code !== "string") return null
    return STABLE_ADAPTER_FAILURE_CODES.has(error.code) ? error.code : null
  } catch {
    return null
  }
}

function failingAdapter(code) {
  const throwFailure = async () => {
    const error = new Error(code)
    error.code = code
    throw error
  }
  return Object.freeze({
    localGit: Object.freeze({ readRemoteAuthority: throwFailure }),
    provider: Object.freeze({}),
  })
}

/**
 * Execute one already approved operation through the sole publication
 * controller. Factory failures are either handed back through that controller
 * using a stable adapter code or fail closed; this function never projects a
 * controller result itself.
 */
export async function executeHandoffDocument(input, options = {}) {
  try {
    if (!isPlainObject(options)) fail("handoff_unavailable")
    const argv = dependency(options, ["argv", "args"], [])
    if (!Array.isArray(argv) || argv.length !== 0) fail("arguments_invalid")
    const approvedOperation = parseHandoffDocument(input)
    const environment = dependency(options, ["env", "environment"], process.env)
    const config = parseHandoffEnvironment(environment)
    const factory = dependency(options, ["createAdapter", "factory"], createRoutinePublicationAdapter)
    const controller = dependency(options, ["handoff", "routinePublicationHandoff"], routinePublicationHandoff)
    if (typeof factory !== "function" || typeof controller !== "function") fail("handoff_unavailable")

    let adapter
    try {
      adapter = await factory(config)
    } catch (error) {
      const code = safeAdapterFailureCode(error)
      if (code === null) fail("handoff_unavailable")
      adapter = failingAdapter(code)
    }

    try {
      return await controller(approvedOperation, adapter)
    } catch {
      fail("handoff_unavailable")
    }
  } catch (error) {
    if (error instanceof HandoffCliError) throw error
    throw new HandoffCliError("handoff_unavailable")
  }
}

/** Serialize exactly one compact JSON result line and nothing else. */
export function formatHandoffResult(result) {
  let encoded
  try {
    encoded = JSON.stringify(result)
  } catch {
    fail("result_invalid")
  }
  if (typeof encoded !== "string") fail("result_invalid")
  return `${encoded}\n`
}

export async function main(argv = process.argv.slice(2), stdin = process.stdin, stdout = process.stdout, environment = process.env, dependencies = {}) {
  try {
    if (!Array.isArray(argv) || argv.length !== 0) fail("arguments_invalid")
    const input = await readBoundedStdin(stdin)
    const result = await executeHandoffDocument(input, { ...dependencies, argv, env: environment })
    stdout.write(formatHandoffResult(result))
    return 0
  } catch {
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code
  }).catch(() => {
    process.exitCode = 1
  })
}
