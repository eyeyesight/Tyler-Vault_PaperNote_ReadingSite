// @ts-check
import { ContractError } from "../lib/publication-contracts.mjs"
import { prepareGhPagesCandidate } from "../lib/gh-pages-candidate.mjs"
import { loadVerifiedSealedRelease } from "../lib/verified-sealed-release.mjs"

/** @param {string[]} argv @param {Set<string>} valueFlags @param {Set<string>} booleanFlags */
function parseFlags(argv, valueFlags, booleanFlags) {
  /** @type {Record<string, string|boolean>} */
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const equal = argument.indexOf("=")
    const name = equal === -1 ? argument : argument.slice(0, equal)
    const inline = equal === -1 ? undefined : argument.slice(equal + 1)
    if (!name.startsWith("--") || (!valueFlags.has(name) && !booleanFlags.has(name))) throw new ContractError("CLI_ARGUMENT_INVALID", "candidate CLI arguments are invalid")
    if (booleanFlags.has(name)) {
      if (inline !== undefined) throw new ContractError("CLI_ARGUMENT_INVALID", "boolean candidate CLI arguments do not take values")
      if (values[name] !== undefined) throw new ContractError("CLI_ARGUMENT_INVALID", "candidate CLI arguments must not be repeated")
      values[name] = true
      continue
    }
    const value = inline ?? argv[++index]
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) throw new ContractError("CLI_ARGUMENT_INVALID", "candidate CLI argument values are required")
    if (values[name] !== undefined) throw new ContractError("CLI_ARGUMENT_INVALID", "candidate CLI arguments must not be repeated")
    values[name] = value
  }
  return values
}

/** @param {unknown} error */
function redactedError(error) {
  const candidateError = /** @type {{code?:unknown}} */ (error)
  const code = candidateError && typeof candidateError.code === "string" && /^[A-Z0-9_]+$/.test(candidateError.code)
    ? candidateError.code
    : "GH_PAGES_CANDIDATE_FAILED"
  return { error: { code, message: "GitHub Pages candidate operation failed" } }
}

async function main() {
  const flags = parseFlags(
    process.argv.slice(2),
    new Set(["--runtime-root", "--runtimeRoot", "--releases-root", "--releasesRoot", "--manifest-id", "--manifestId", "--source-root", "--output-root", "--outputRoot"]),
    new Set(),
  )
  const get = (/** @type {string} */ hyphen, /** @type {string} */ camel) => /** @type {string|undefined} */ (flags[hyphen] ?? flags[camel])
  const runtimeRoot = get("--runtime-root", "--runtimeRoot")
  const releasesRoot = get("--releases-root", "--releasesRoot")
  const manifestId = get("--manifest-id", "--manifestId")
  const sourceRoot = /** @type {string|undefined} */ (flags["--source-root"])
  const outputRoot = get("--output-root", "--outputRoot")
  if (!runtimeRoot || !releasesRoot || !manifestId || !sourceRoot || !outputRoot) throw new ContractError("CLI_ARGUMENT_INVALID", "prepare requires runtime, releases, manifest, source, and output arguments")
  const capability = await loadVerifiedSealedRelease({ runtimeRoot, releasesRoot, manifestId })
  const summary = await prepareGhPagesCandidate({ verifiedSealedRelease: capability, targetRoot: outputRoot, sourceRoot })
  process.stdout.write(`${JSON.stringify(summary)}\n`)
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${JSON.stringify(redactedError(error))}\n`)
  process.exitCode = 1
}
