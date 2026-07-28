#!/usr/bin/env node
import {
  ContractError,
  readContractJson,
  validateContract,
} from "../lib/publication-contracts.mjs"

const kinds = new Set(["publication-manifest", "export-receipt", "release-receipt", "current-release"])

/** @param {string[]} argv */
function parseArgs(argv) {
  const [command, ...rest] = argv
  if (command !== "validate" && command !== "inspect") throw new ContractError("USAGE", "expected command: validate or inspect")
  /** @type {{command?:string,kind?:string,input?:string,manifest?:string,exportRoot?:string,now?:string}} */
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
    else throw new ContractError("USAGE", `unknown flag: ${flag}`)
  }
  if (!options.kind || !kinds.has(options.kind)) throw new ContractError("USAGE", "--kind must name a supported contract")
  if (!options.input) throw new ContractError("USAGE", "--input is required")

  if (command === "inspect") {
    if (options.manifest || options.exportRoot || options.now) throw new ContractError("USAGE", "inspect is standalone and accepts no validation context")
  } else if (options.kind === "publication-manifest") {
    if (!options.now) throw new ContractError("CONTEXT_REQUIRED", "publication-manifest preflight requires trusted --now")
    if (options.manifest || options.exportRoot) throw new ContractError("USAGE", "publication-manifest does not accept export context")
  } else if (options.kind === "export-receipt") {
    const missing = [!options.manifest && "--manifest", !options.exportRoot && "--export-root", !options.now && "--now"].filter(Boolean)
    if (missing.length > 0) throw new ContractError("CONTEXT_REQUIRED", `export-receipt preflight requires ${missing.join(", ")}`)
  } else {
    throw new ContractError("CONTEXT_REQUIRED", `${options.kind} has only standalone Phase A inspection; full preflight requires Phase B context`)
  }
  return /** @type {{command:"validate"|"inspect",kind:string,input:string,manifest?:string,exportRoot?:string,now?:string}} */ (options)
}

async function main() {
  const cli = parseArgs(process.argv.slice(2))
  const value = await readContractJson(cli.input)
  let manifest
  if (cli.command === "validate" && cli.kind === "export-receipt") {
    manifest = await readContractJson(/** @type {string} */ (cli.manifest))
    await validateContract("publication-manifest", manifest, { now: cli.now })
  }
  const result = await validateContract(cli.kind, value, {
    ...(cli.now ? { now: cli.now } : {}),
    ...(manifest ? { manifest } : {}),
    ...(cli.exportRoot ? { exportRoot: cli.exportRoot } : {}),
  })
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
