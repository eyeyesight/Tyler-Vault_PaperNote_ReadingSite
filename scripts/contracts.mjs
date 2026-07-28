#!/usr/bin/env node
import {
  ContractError,
  readContractJson,
  validateContract,
  validateCurrentReleaseCandidate,
  validatePublicationPreflight,
  validateReleaseAgainstManifest,
} from "../lib/publication-contracts.mjs"

const kinds = new Set(["publication-manifest", "export-receipt", "release-receipt", "current-release"])

/** @param {string[]} argv */
function parseArgs(argv) {
  const [command, ...rest] = argv
  if (command !== "validate" && command !== "inspect") throw new ContractError("USAGE", "expected command: validate or inspect")
  /** @type {{command?:string,kind?:string,input?:string,manifest?:string,exportRoot?:string,now?:string,runtimeRoot?:string}} */
  const options = { command }
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!flag?.startsWith("--") || value === undefined) throw new ContractError("USAGE", `flag ${flag ?? "<missing>"} requires a value`)
    if (flag === "--kind") options.kind = value
    else if (flag === "--input") options.input = value
    else if (flag === "--manifest") options.manifest = value
    else if (flag === "--export-root") options.exportRoot = value
    else if (flag === "--now") options.now = value
    else if (flag === "--runtime-root") options.runtimeRoot = value
    else throw new ContractError("USAGE", `unknown flag: ${flag}`)
  }
  if (!options.kind || !kinds.has(options.kind)) throw new ContractError("USAGE", "--kind must name a supported contract")
  if (!options.input) throw new ContractError("USAGE", "--input is required")

  if (command === "inspect") {
    if (options.manifest || options.exportRoot || options.now || options.runtimeRoot) {
      throw new ContractError("USAGE", "inspect is standalone and accepts no validation context")
    }
  } else {
    /** @type {Record<string, Array<["manifest"|"exportRoot"|"now"|"runtimeRoot", string]>>} */
    const requirements = {
      "publication-manifest": [["now", "--now"], ["runtimeRoot", "--runtime-root"]],
      "export-receipt": [["manifest", "--manifest"], ["exportRoot", "--export-root"], ["now", "--now"], ["runtimeRoot", "--runtime-root"]],
      "release-receipt": [["manifest", "--manifest"], ["now", "--now"], ["runtimeRoot", "--runtime-root"]],
      "current-release": [["runtimeRoot", "--runtime-root"]],
    }
    const missing = requirements[options.kind].filter(([property]) => !options[property]).map(([, flag]) => flag)
    if (missing.length > 0) throw new ContractError("CONTEXT_REQUIRED", `${options.kind} preflight requires ${missing.join(", ")}`)
    if (options.kind === "publication-manifest" && (options.manifest || options.exportRoot)) {
      throw new ContractError("USAGE", "publication-manifest does not accept manifest/export context")
    }
    if (options.kind === "release-receipt" && options.exportRoot) throw new ContractError("USAGE", "release-receipt does not accept export context")
    if (options.kind === "current-release" && (options.manifest || options.exportRoot || options.now)) {
      throw new ContractError("USAGE", "current-release accepts only runtime context")
    }
  }
  return /** @type {{command:"validate"|"inspect",kind:string,input:string,manifest?:string,exportRoot?:string,now?:string,runtimeRoot?:string}} */ (options)
}

async function main() {
  const cli = parseArgs(process.argv.slice(2))
  const value = await readContractJson(cli.input)
  const runtimeRoot = /** @type {string} */ (cli.runtimeRoot)
  const now = /** @type {string} */ (cli.now)
  let result
  if (cli.command === "inspect") {
    result = await validateContract(cli.kind, value)
  } else if (cli.kind === "current-release") {
    result = await validateCurrentReleaseCandidate(value, { runtimeRoot })
  } else {
    const manifest = cli.kind === "publication-manifest" ? value : await readContractJson(/** @type {string} */ (cli.manifest))
    const manifestResult = await validatePublicationPreflight(manifest, { now, runtimeRoot })
    if (cli.kind === "publication-manifest") result = manifestResult
    else if (cli.kind === "export-receipt") {
      result = await validateContract("export-receipt", value, { manifest, exportRoot: cli.exportRoot, now })
    } else {
      result = await validateReleaseAgainstManifest(value, manifest)
    }
  }
  const validationLevel = cli.command === "validate" ? "preflight" : "standalone"
  process.stdout.write(`${JSON.stringify({ ok: true, kind: result.kind, schemaVersion: result.schemaVersion, validationLevel })}\n`)
}

main().catch((error) => {
  const known = error instanceof ContractError
  const code = known ? error.code : "UNEXPECTED_ERROR"
  const message = known ? error.message : "unexpected contract engine failure"
  const details = known && Object.keys(error.details).length > 0 ? error.details : undefined
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message, ...(details ? { details } : {}) } })}\n`)
  process.exitCode = 1
})
