// @ts-nocheck -- black-box mutation matrix intentionally exercises invalid dynamic JSON shapes.
import assert from "node:assert/strict"
import { lstat, mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

import {
  ContractError,
  compareUtf8,
  computePlanDigest,
  computePublicSetDigest,
  jcsCanonicalize,
  sha256Jcs,
  sortContractArray,
  validateContract,
  validateStandaloneBundle,
  readContractJson,
  loadPublicationRuntime,
  validateCrossReleaseManifest,
  validatePublicationPreflight,
  validateReleaseAgainstManifest,
  validateCurrentReleaseCandidate,
} from "../lib/publication-contracts.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const examplesRoot = path.join(repoRoot, "specs", "examples")
const orderingPath = path.join(repoRoot, "specs", "fixtures", "utf8-ordering-v1.json")
const cliPath = path.join(repoRoot, "scripts", "contracts.mjs")

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"))
}
function clone(value) {
  return structuredClone(value)
}
function expectCode(code, fn) {
  assert.throws(fn, (error) => error instanceof ContractError && error.code === code)
}
function sealManifest(manifest) {
  manifest.public_set_digest = computePublicSetDigest(manifest.nodes)
  manifest.plan_digest = computePlanDigest(manifest)
  manifest.approval_receipt.approved_plan_digest = manifest.plan_digest
  return manifest
}
function sealRelease(receipt) {
  receipt.public_set_digest = computePublicSetDigest(receipt.nodes)
  const unsigned = clone(receipt)
  delete unsigned.release_digest
  receipt.release_digest = sha256Jcs(unsigned)
  return receipt
}
async function writeRuntimeCurrent(root, receipt, pointer) {
  const receiptFile = path.join(root, ...pointer.receipt_path.split("/"))
  await mkdir(path.dirname(receiptFile), { recursive: true })
  await writeFile(receiptFile, JSON.stringify(receipt))
  await writeFile(path.join(root, "current-release.json"), JSON.stringify(pointer))
}

async function probeFilesystemAlias(expectedPath) {
  try {
    await lstat(expectedPath)
    return true
  } catch (error) {
    assert.equal(error?.code, "ENOENT")
    return false
  }
}

const exampleCases = [
  ["publication-manifest", "publish-unit-manifest-v1.example.json"],
  ["publication-manifest", "publish-unit-with-baseline-v1.example.json"],
  ["publication-manifest", "zotero-refresh-manifest-v1.example.json"],
  ["export-receipt", "export-receipt-v1.example.json"],
  ["release-receipt", "release-receipt-v1.example.json"],
  ["current-release", "current-release-v1.example.json"],
]
for (const [kind, name] of exampleCases) {
  test(`規格正例通過：${name}`, async () => {
    const result = await validateContract(kind, await json(path.join(examplesRoot, name)))
    assert.equal(result.kind, kind)
  })
}

test("RFC 8785 canonicalization preserves required number and escaping behavior", () => {
  const sample = {
    literals: [null, true, false],
    numbers: [333333333.33333329, 1e30, 4.5, 0.002, 1e-27],
    string: "€$\u000f\nA'B\"\\\"/",
  }
  assert.equal(
    jcsCanonicalize(sample),
    "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\"/\"}",
  )
  assert.equal(jcsCanonicalize({ b: 1, a: -0 }), '{"a":0,"b":1}')
})

test("project JCS treats an own toJSON data property as ordinary sorted data", () => {
  assert.equal(
    jcsCanonicalize({ b: 1, toJSON: "x", a: 2 }),
    '{"a":2,"b":1,"toJSON":"x"}',
  )
})

test("project JCS ignores inherited toJSON even under prototype pollution", () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON")
  let actual
  try {
    Object.defineProperty(Object.prototype, "toJSON", {
      value: () => ({ compromised: true }),
      configurable: true,
      writable: true,
    })
    actual = jcsCanonicalize({ b: 1, a: 2 })
  } finally {
    if (previous) Object.defineProperty(Object.prototype, "toJSON", previous)
    else delete Object.prototype.toJSON
  }
  assert.equal(actual, '{"a":2,"b":1}')
})

test("RFC 8785 object names use UTF-16 code-unit order, not the contract UTF-8 comparator", () => {
  assert(compareUtf8("\ue000", "𐀀") < 0)
  assert.equal(jcsCanonicalize({ "\ue000": 2, "𐀀": 1 }), '{"𐀀":1,"":2}')
})

test("UTF-8 comparator is unsigned, NFC, and complete-prefix-first", () => {
  assert(compareUtf8("a", "a-1") < 0)
  assert(compareUtf8("a.md", "a.md-more.md") < 0)
  assert(compareUtf8("A", "a") < 0)
  assert(compareUtf8("Å", "中") < 0)
  expectCode("NON_NFC_STRING", () => compareUtf8("A\u030a", "Å"))
})

test("ordering fixture every named vector matches expected order and expected JCS SHA-256", async () => {
  const fixture = await json(orderingPath)
  assert.deepEqual(Object.keys(fixture.vectors), [
    "nodes_by_public_id",
    "identity_projection_by_public_id",
    "support_ids",
    "added_node_ids",
    "direct_connection_edges",
    "export_files_by_path",
    "release_artifacts_by_path",
  ])
  for (const [name, vector] of Object.entries(fixture.vectors)) {
    const actual = sortContractArray(name, vector.input)
    assert.deepEqual(actual, vector.expected, name)
    assert.equal(sha256Jcs(actual), vector.expected_jcs_sha256, `${name} JCS digest`)
  }
  for (const pair of fixture.prefix_pairs.slice(0, 2)) assert.equal(pair.expected_first, pair.short)
  assert(compareUtf8(fixture.prefix_pairs[0].short, fixture.prefix_pairs[0].long) < 0)
  assert(compareUtf8(fixture.prefix_pairs[1].short, fixture.prefix_pairs[1].long) < 0)
  const edgePair = fixture.prefix_pairs[2]
  assert.deepEqual(sortContractArray("direct_connection_edges", [edgePair.long_edge, edgePair.short_edge])[0], edgePair.expected_first)
  for (const decomposed of fixture.non_nfc_rejected) expectCode("NON_NFC_STRING", () => compareUtf8(decomposed, "z"))
})

test("manifest digest functions reproduce literal specification examples", async () => {
  for (const name of [
    "publish-unit-manifest-v1.example.json",
    "publish-unit-with-baseline-v1.example.json",
    "zotero-refresh-manifest-v1.example.json",
  ]) {
    const manifest = await json(path.join(examplesRoot, name))
    assert.equal(computePublicSetDigest(manifest.nodes), manifest.public_set_digest)
    assert.equal(computePlanDigest(manifest), manifest.plan_digest)
  }
})

test("release digest recomputation reproduces literal specification example", async () => {
  const receipt = await json(path.join(examplesRoot, "release-receipt-v1.example.json"))
  const copy = clone(receipt)
  delete copy.release_digest
  assert.equal(sha256Jcs(copy), receipt.release_digest)
})

test("schema validator is Draft 2020-12 and rejects unknown/invalid shape deterministically", async () => {
  const manifest = await json(path.join(examplesRoot, "publish-unit-manifest-v1.example.json"))
  manifest.unknown = true
  await assert.rejects(validateContract("publication-manifest", manifest), (error) =>
    error instanceof ContractError && error.code === "SCHEMA_INVALID" && error.details.schemaDraft === "2020-12")
})

const manifestMutations = [
  ["DUPLICATE_PUBLIC_ID", (m) => { m.nodes.push(clone(m.nodes[0])) }],
  ["DUPLICATE_PATH", (m) => { m.nodes[1].path = m.nodes[0].path }],
  ["PATH_CASE_COLLISION", (m) => { m.nodes[1].path = "knowledge/concepts/flow.md" }],
  ["PATH_ABSOLUTE", (m) => { m.nodes[0].path = "/Knowledge/Concepts/Flow.md" }],
  ["PATH_TRAVERSAL", (m) => { m.nodes[0].path = "Knowledge/../Flow.md" }],
  ["PATH_BACKSLASH", (m) => { m.nodes[0].path = "Knowledge\\Concepts\\Flow.md" }],
  ["PATH_DRIVE_ABSOLUTE", (m) => { m.nodes[0].path = "C:/Knowledge/Concepts/Flow.md" }],
  ["PATH_UNC", (m) => { m.nodes[0].path = "//server/share/Flow.md" }],
  ["TIMESTAMP_INVALID", (m) => { m.created_at = "2026-07-28T00:00:00.000Z" }],
  ["TIME_WINDOW_INVALID", (m) => { m.expires_at = m.created_at }],
  ["APPROVAL_TIME_INVALID", (m) => { m.approval_receipt.approved_at = m.expires_at }],
  ["CLASS_ROOT_MISMATCH", (m) => { m.nodes[0].node_class = "method" }],
  ["PRIMARY_NOT_PAPER", (m) => { m.action.primary_id = "flow" }],
  ["SUPPORT_NOT_FOUND", (m) => { m.action.support_ids = ["missing"]; m.action.direct_connection_edges[0].target = "missing" }],
  ["ACTION_EDGE_INVALID", (m) => { m.action.direct_connection_edges[0].source = "flow" }],
  ["ACTION_EDGE_COVERAGE", (m) => { m.action.direct_connection_edges = [] }],
  ["ARRAY_NOT_SORTED", (m) => { m.nodes.reverse() }],
  ["ARRAY_NOT_UNIQUE", (m) => { m.action.support_ids.push("flow") }],
  ["NON_NFC_STRING", (m) => { m.nodes[0].path = "Knowledge/Concepts/A\u030a.md" }],
  ["PUBLIC_SET_DIGEST_MISMATCH", (m) => { m.public_set_digest = "0".repeat(64) }],
  ["PLAN_DIGEST_MISMATCH", (m) => { m.plan_digest = "0".repeat(64); m.approval_receipt.approved_plan_digest = m.plan_digest }],
  ["APPROVAL_DIGEST_MISMATCH", (m) => { m.approval_receipt.approved_plan_digest = "0".repeat(64) }],
]
for (const [code, mutate] of manifestMutations) {
  test(`manifest semantic negative: ${code}`, async () => {
    const manifest = await json(path.join(examplesRoot, "publish-unit-manifest-v1.example.json"))
    mutate(manifest)
    // Re-seal mutations that test semantics other than digest binding.
    if (!["PUBLIC_SET_DIGEST_MISMATCH", "PLAN_DIGEST_MISMATCH", "APPROVAL_DIGEST_MISMATCH"].includes(code)) sealManifest(manifest)
    await assert.rejects(validateContract("publication-manifest", manifest), (error) => error instanceof ContractError && error.code === code)
  })
}

test("manifest strict current validity is opt-in and half-open", async () => {
  const manifest = await json(path.join(examplesRoot, "publish-unit-manifest-v1.example.json"))
  await validateContract("publication-manifest", manifest, { now: "2026-07-28T00:00:00Z" })
  await assert.rejects(validateContract("publication-manifest", manifest, { now: manifest.expires_at }), (e) => e.code === "MANIFEST_EXPIRED")
})

test("export receipt binds manifest and hashes isolated supplied files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-export-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await json(path.join(examplesRoot, "publish-unit-manifest-v1.example.json"))
  const receipt = await json(path.join(examplesRoot, "export-receipt-v1.example.json"))
  for (const file of receipt.files) {
    const absolute = path.join(root, ...file.path.split("/"))
    await mkdir(path.dirname(absolute), { recursive: true })
    // Fixture bytes are intentionally isolated and hashes are rebound; no research content is used.
    const bytes = Buffer.from(`synthetic:${file.path}\n`)
    await writeFile(absolute, bytes)
    file.source_sha256 = createHash("sha256").update(bytes).digest("hex")
    manifest.nodes.find((node) => node.path === file.path).source_sha256 = file.source_sha256
  }
  sealManifest(manifest)
  receipt.plan_digest = manifest.plan_digest
  await writeFile(path.join(root, "export-receipt.json"), JSON.stringify(receipt))
  await validateContract("export-receipt", receipt, { manifest, exportRoot: root })

  const changed = clone(receipt)
  changed.files[0].source_sha256 = "0".repeat(64)
  await assert.rejects(validateContract("export-receipt", changed, { manifest, exportRoot: root }), (e) => e.code === "EXPORT_SOURCE_HASH_MISMATCH")
  await writeFile(path.join(root, ...receipt.files[0].path.split("/")), "mutated")
  await assert.rejects(validateContract("export-receipt", receipt, { manifest, exportRoot: root }), (e) => e.code === "EXPORT_FILE_HASH_MISMATCH")
})

test("export root rejects unlisted files and symlinks without mutation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-export-link-"))
  const outside = await mkdtemp(path.join(tmpdir(), "contract-outside-"))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))
  const receipt = await json(path.join(examplesRoot, "export-receipt-v1.example.json"))
  await writeFile(path.join(root, "export-receipt.json"), "sentinel")
  await writeFile(path.join(root, "extra.txt"), "sentinel")
  await assert.rejects(validateContract("export-receipt", receipt, { exportRoot: root }), (e) => e.code === "EXPORT_UNLISTED_FILE")
  await rm(path.join(root, "extra.txt"))
  await writeFile(path.join(outside, "outside.md"), "outside")
  await symlink(outside, path.join(root, "escape"), "junction")
  await assert.rejects(validateContract("export-receipt", receipt, { exportRoot: root }), (e) => e.code === "PATH_SYMLINK_NOT_ALLOWED")
  const rootAlias = path.join(path.dirname(root), `${path.basename(root)}-alias`)
  await symlink(root, rootAlias, "junction")
  t.after(() => rm(rootAlias, { recursive: true, force: true }))
  await assert.rejects(validateContract("export-receipt", receipt, { exportRoot: rootAlias }), (e) => e.code === "PATH_SYMLINK_NOT_ALLOWED")
  assert.equal(await readFile(path.join(root, "export-receipt.json"), "utf8"), "sentinel")
})

test("release and current semantic negatives have invariant-specific codes", async () => {
  const release = await json(path.join(examplesRoot, "release-receipt-v1.example.json"))
  release.artifacts.reverse()
  await assert.rejects(validateContract("release-receipt", release), (e) => e.code === "ARRAY_NOT_SORTED")

  const pointer = await json(path.join(examplesRoot, "current-release-v1.example.json"))
  pointer.receipt_path = "consumed/../release-receipt.json"
  await assert.rejects(validateContract("current-release", pointer), (e) => e.code === "PATH_TRAVERSAL")
})

test("release receipt rejects path collisions, self-artifact, and standalone digest mismatches", async () => {
  const original = await json(path.join(examplesRoot, "release-receipt-v1.example.json"))
  const collision = clone(original)
  collision.artifacts.push({ path: "GRAPH.JSON", sha256: "0".repeat(64) })
  collision.artifacts = sortContractArray("release_artifacts_by_path", collision.artifacts)
  sealRelease(collision)
  await assert.rejects(validateContract("release-receipt", collision), (e) => e.code === "PATH_CASE_COLLISION")

  const selfArtifact = clone(original)
  selfArtifact.artifacts.push({ path: "release-receipt.json", sha256: "0".repeat(64) })
  selfArtifact.artifacts = sortContractArray("release_artifacts_by_path", selfArtifact.artifacts)
  sealRelease(selfArtifact)
  await assert.rejects(validateContract("release-receipt", selfArtifact), (e) => e.code === "RELEASE_RECEIPT_ARTIFACT")

  const digest = clone(original)
  digest.artifacts[0].sha256 = "0".repeat(64)
  await assert.rejects(validateContract("release-receipt", digest), (e) => e.code === "RELEASE_DIGEST_MISMATCH")
  const publicSet = clone(original)
  publicSet.public_set_digest = "0".repeat(64)
  await assert.rejects(validateContract("release-receipt", publicSet), (e) => e.code === "PUBLIC_SET_DIGEST_MISMATCH")
})

test("export digest-bound files reject alternate order and case-colliding paths", async () => {
  const receipt = await json(path.join(examplesRoot, "export-receipt-v1.example.json"))
  receipt.files.reverse()
  await assert.rejects(validateContract("export-receipt", receipt), (e) => e.code === "ARRAY_NOT_SORTED")
  const collision = await json(path.join(examplesRoot, "export-receipt-v1.example.json"))
  collision.files.push({ path: "knowledge/concepts/flow.md", source_sha256: "0".repeat(64) })
  await assert.rejects(validateContract("export-receipt", collision), (e) => e.code === "PATH_CASE_COLLISION")
})

test("strict JSON reader rejects BOM and invalid UTF-8 with stable codes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-json-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bom = path.join(root, "bom.json")
  const invalid = path.join(root, "invalid.json")
  await writeFile(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]))
  await writeFile(invalid, Buffer.from([0xff]))
  await assert.rejects(readContractJson(bom), (e) => e.code === "INPUT_BOM_NOT_ALLOWED")
  await assert.rejects(readContractJson(invalid), (e) => e.code === "INPUT_INVALID_UTF8")
})

test("strict I-JSON reader rejects duplicate decoded property names at every object depth", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-duplicate-json-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cases = [
    '{"schema_version":1,"schema_version":1}',
    '{"outer":{"value":1,"value":2}}',
    '{"outer":{"a":1,"\\u0061":2}}',
    '[{"nested":true,"n\\u0065sted":false}]',
  ]
  for (const [index, source] of cases.entries()) {
    const input = path.join(root, `${index}.json`)
    await writeFile(input, source)
    await assert.rejects(readContractJson(input), (error) => error instanceof ContractError && error.code === "INPUT_DUPLICATE_PROPERTY")
  }
})

test("strict I-JSON reader rejects object/array comments and trailing commas", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-invalid-json-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cases = [
    ["object-comment", '{/* no */"a":1}'],
    ["array-comment", '[1,/* no */2]'],
    ["object-comma", '{"a":1,}'],
    ["array-comma", '[1,]'],
  ]
  for (const [name, source] of cases) {
    const input = path.join(root, `${name}.json`)
    await writeFile(input, source)
    await assert.rejects(readContractJson(input), (error) => error instanceof ContractError && error.code === "INPUT_INVALID_JSON")
  }
})

test("strict I-JSON reader enforces escapes and Unicode scalar strings", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-string-json-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const valid = path.join(root, "valid-pair.json")
  await writeFile(valid, '{"emoji":"\\ud83d\\ude00"}')
  assert.deepEqual(await readContractJson(valid), { emoji: "😀" })

  const invalidCases = [
    ["bad-escape", '{"value":"\\x"}', "INPUT_INVALID_JSON"],
    ["bad-hex", '{"value":"\\u12xz"}', "INPUT_INVALID_JSON"],
    ["lone-high", '{"value":"\\ud800"}', "INPUT_INVALID_UNICODE"],
    ["lone-low", '{"value":"\\udc00"}', "INPUT_INVALID_UNICODE"],
    ["reversed-pair", '{"value":"\\udc00\\ud800"}', "INPUT_INVALID_UNICODE"],
  ]
  for (const [name, source, code] of invalidCases) {
    const input = path.join(root, `${name}.json`)
    await writeFile(input, source)
    await assert.rejects(readContractJson(input), (error) => error instanceof ContractError && error.code === code, name)
  }
})

test("strict I-JSON reader enforces number grammar, token boundaries, and IEEE-754 range", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-number-json-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const invalidGrammar = ["01", "-01", "1.", ".1", "+1", "1e", "1e+", "--1", "truex", "null0", "1true", "[1 2]"]
  for (const [index, source] of invalidGrammar.entries()) {
    const input = path.join(root, `grammar-${index}.json`)
    await writeFile(input, source)
    await assert.rejects(readContractJson(input), (error) => error instanceof ContractError && error.code === "INPUT_INVALID_JSON", source)
  }
  const outOfRange = path.join(root, "out-of-range.json")
  await writeFile(outOfRange, '{"value":1e400}')
  await assert.rejects(readContractJson(outOfRange), (error) => error instanceof ContractError && error.code === "INPUT_NUMBER_OUT_OF_RANGE")
})

test("strict I-JSON reader constructs an own __proto__ property without prototype mutation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-proto-json-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = path.join(root, "proto.json")
  await writeFile(input, '{"nested":{"__proto__":{"polluted":true}}}')
  const value = await readContractJson(input)
  assert.equal(Object.getPrototypeOf(value.nested), Object.prototype)
  assert.deepEqual(Object.getOwnPropertyDescriptor(value.nested, "__proto__")?.value, { polluted: true })
  assert.equal(jcsCanonicalize(value), '{"nested":{"__proto__":{"polluted":true}}}')
  assert.equal(Object.prototype.polluted, undefined)
  assert.equal({}.polluted, undefined)
})

test("public JCS helpers reject every value outside the I-JSON/JCS data model", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expectCode("JCS_NON_FINITE_NUMBER", () => jcsCanonicalize(value))
    expectCode("JCS_NON_FINITE_NUMBER", () => sha256Jcs({ value }))
  }
  for (const value of [undefined, () => {}, Symbol("value"), 1n]) {
    expectCode("JCS_UNSUPPORTED_TYPE", () => jcsCanonicalize(value))
  }
  const hole = ["present", , "present"]
  expectCode("JCS_ARRAY_HOLE", () => jcsCanonicalize(hole))
  for (const value of [new Date("2026-07-28T00:00:00Z"), new Map(), /not-json/]) {
    expectCode("JCS_NON_PLAIN_OBJECT", () => jcsCanonicalize(value))
  }
  const cycle = {}
  cycle.self = cycle
  expectCode("JCS_CYCLE", () => jcsCanonicalize(cycle))
  expectCode("INVALID_UNICODE_SCALAR", () => jcsCanonicalize({ value: "\ud800" }))
  expectCode("INVALID_UNICODE_SCALAR", () => jcsCanonicalize({ ["\udc00"]: "value" }))
})

test("public JCS helpers reject descriptors and properties that cannot be safely snapshotted", () => {
  let getterCalls = 0
  const accessor = {}
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      getterCalls += 1
      return "must not run"
    },
  })
  expectCode("JCS_ACCESSOR_PROPERTY", () => jcsCanonicalize(accessor))
  assert.equal(getterCalls, 0)

  const hidden = { visible: true }
  Object.defineProperty(hidden, "hidden", { value: true, enumerable: false })
  expectCode("JCS_NON_ENUMERABLE_PROPERTY", () => jcsCanonicalize(hidden))

  const symbol = Symbol("hidden")
  expectCode("JCS_SYMBOL_PROPERTY", () => jcsCanonicalize({ [symbol]: true }))

  const namedArray = [1]
  namedArray.extra = 2
  expectCode("JCS_NAMED_ARRAY_PROPERTY", () => jcsCanonicalize(namedArray))

  const arrayAccessor = [1]
  Object.defineProperty(arrayAccessor, "0", { enumerable: true, get: () => "must not run" })
  expectCode("JCS_ACCESSOR_PROPERTY", () => jcsCanonicalize(arrayAccessor))
})

test("public JCS helper rejects Proxy before invoking any trap", () => {
  let trapCalls = 0
  const pollute = () => {
    trapCalls += 1
    Object.prototype.jcsProxyPolluted = true
  }
  const proxy = new Proxy({ a: 1 }, {
    get(target, key, receiver) { pollute(); return Reflect.get(target, key, receiver) },
    getOwnPropertyDescriptor(target, key) { pollute(); return Reflect.getOwnPropertyDescriptor(target, key) },
    getPrototypeOf(target) { pollute(); return Reflect.getPrototypeOf(target) },
    ownKeys(target) { pollute(); return Reflect.ownKeys(target) },
  })
  try {
    expectCode("JCS_PROXY", () => jcsCanonicalize(proxy))
    assert.equal(trapCalls, 0)
    assert.equal(Object.prototype.jcsProxyPolluted, undefined)
  } finally {
    delete Object.prototype.jcsProxyPolluted
  }
})

test("manifest trusted Date clock accepts milliseconds and rejects Invalid Date deterministically", async () => {
  const manifest = await json(path.join(examplesRoot, "publish-unit-manifest-v1.example.json"))
  await validateContract("publication-manifest", manifest, { now: new Date("2026-07-28T00:00:00.123Z") })
  await assert.rejects(validateContract("publication-manifest", manifest, { now: new Date(Number.NaN) }),
    (error) => error instanceof ContractError && error.code === "NOW_INVALID")
})

test("public validation paths enforce ordering and identity uniqueness for every contract array", async () => {
  const manifestName = path.join(examplesRoot, "publish-unit-manifest-v1.example.json")
  const manifestCases = [
    ["nodes unsorted", "ARRAY_NOT_SORTED", (m) => m.nodes.reverse()],
    ["nodes duplicate identity", "DUPLICATE_PUBLIC_ID", (m) => { const node = clone(m.nodes[0]); node.path = "Knowledge/Concepts/Other.md"; m.nodes.push(node) }],
    ["support_ids unsorted", "ARRAY_NOT_SORTED", (m) => { const support = clone(m.nodes[0]); support.public_id = "flow-z"; support.path = "Knowledge/Concepts/Flow Z.md"; m.nodes.push(support); m.nodes = sortContractArray("nodes_by_public_id", m.nodes); m.action.support_ids = ["flow-z", "flow"]; m.action.direct_connection_edges.push({ source: m.action.primary_id, target: "flow-z" }); m.action.direct_connection_edges = sortContractArray("direct_connection_edges", m.action.direct_connection_edges) }],
    ["support_ids duplicate identity", "ARRAY_NOT_UNIQUE", (m) => m.action.support_ids.push(m.action.support_ids[0])],
    ["added_node_ids unsorted", "ARRAY_NOT_SORTED", (m) => m.action.added_node_ids.reverse()],
    ["added_node_ids duplicate identity", "ARRAY_NOT_UNIQUE", (m) => m.action.added_node_ids.push(m.action.added_node_ids[0])],
    ["edges unsorted", "ARRAY_NOT_SORTED", (m) => { const support = clone(m.nodes[0]); support.public_id = "flow-z"; support.path = "Knowledge/Concepts/Flow Z.md"; m.nodes.push(support); m.nodes = sortContractArray("nodes_by_public_id", m.nodes); m.action.support_ids.push("flow-z"); m.action.direct_connection_edges.push({ source: m.action.primary_id, target: "flow-z" }); m.action.direct_connection_edges.reverse() }],
    ["edges duplicate tuple", "ARRAY_NOT_UNIQUE", (m) => m.action.direct_connection_edges.push(clone(m.action.direct_connection_edges[0]))],
  ]
  for (const [label, code, mutate] of manifestCases) {
    const manifest = await json(manifestName)
    mutate(manifest)
    sealManifest(manifest)
    await assert.rejects(validateContract("publication-manifest", manifest),
      (error) => error instanceof ContractError && error.code === code, label)
  }

  const exportReceipt = await json(path.join(examplesRoot, "export-receipt-v1.example.json"))
  exportReceipt.files.reverse()
  await assert.rejects(validateContract("export-receipt", exportReceipt), (error) => error.code === "ARRAY_NOT_SORTED")
  const duplicateExport = await json(path.join(examplesRoot, "export-receipt-v1.example.json"))
  duplicateExport.files.push(clone(duplicateExport.files[0]))
  await assert.rejects(validateContract("export-receipt", duplicateExport), (error) => error.code === "DUPLICATE_PATH")

  const releaseName = path.join(examplesRoot, "release-receipt-v1.example.json")
  const releaseNodesUnsorted = await json(releaseName)
  releaseNodesUnsorted.nodes.reverse()
  sealRelease(releaseNodesUnsorted)
  await assert.rejects(validateContract("release-receipt", releaseNodesUnsorted), (error) => error.code === "ARRAY_NOT_SORTED")
  const releaseNodeIdentity = await json(releaseName)
  const sameId = clone(releaseNodeIdentity.nodes[0])
  sameId.path = "Knowledge/Concepts/Other.md"
  releaseNodeIdentity.nodes.push(sameId)
  sealRelease(releaseNodeIdentity)
  await assert.rejects(validateContract("release-receipt", releaseNodeIdentity), (error) => error.code === "DUPLICATE_PUBLIC_ID")
  const releaseArtifactsUnsorted = await json(releaseName)
  releaseArtifactsUnsorted.artifacts.reverse()
  sealRelease(releaseArtifactsUnsorted)
  await assert.rejects(validateContract("release-receipt", releaseArtifactsUnsorted), (error) => error.code === "ARRAY_NOT_SORTED")
  const releaseArtifactIdentity = await json(releaseName)
  releaseArtifactIdentity.artifacts.push(clone(releaseArtifactIdentity.artifacts[0]))
  sealRelease(releaseArtifactIdentity)
  await assert.rejects(validateContract("release-receipt", releaseArtifactIdentity), (error) => error.code === "DUPLICATE_PATH")
})

test("release receipt self-exclusion is Windows-safe and ASCII case-insensitive at any depth", async () => {
  const original = await json(path.join(examplesRoot, "release-receipt-v1.example.json"))
  for (const artifactPath of ["RELEASE-RECEIPT.JSON", "evidence/Release-Receipt.Json", "nested/deeper/reLeAsE-rEcEiPt.JsOn"]) {
    const receipt = clone(original)
    receipt.artifacts.push({ path: artifactPath, sha256: "0".repeat(64) })
    receipt.artifacts = sortContractArray("release_artifacts_by_path", receipt.artifacts)
    sealRelease(receipt)
    await assert.rejects(validateContract("release-receipt", receipt),
      (error) => error instanceof ContractError && error.code === "RELEASE_RECEIPT_ARTIFACT", artifactPath)
  }
})

test("Phase B composition seam independently validates supplied current receipt and pointer", async () => {
  const result = await validateStandaloneBundle({
    manifest: await json(path.join(examplesRoot, "publish-unit-with-baseline-v1.example.json")),
    currentReceipt: await json(path.join(examplesRoot, "release-receipt-v1.example.json")),
    currentPointer: await json(path.join(examplesRoot, "current-release-v1.example.json")),
  })
  assert.equal(result.currentReceipt.kind, "release-receipt")
  assert.equal(result.currentPointer.kind, "current-release")
})

test("CLI validate fails closed for the complete missing-context matrix", () => {
  const manifestInput = path.join(examplesRoot, "publish-unit-manifest-v1.example.json")
  const cases = [
    ["publication-manifest", "publish-unit-manifest-v1.example.json", [["--now", "2026-07-28T00:00:00Z"], ["--runtime-root", examplesRoot]]],
    ["export-receipt", "export-receipt-v1.example.json", [["--manifest", manifestInput], ["--export-root", examplesRoot], ["--now", "2026-07-28T00:00:00Z"], ["--runtime-root", examplesRoot]]],
    ["release-receipt", "release-receipt-v1.example.json", [["--manifest", manifestInput], ["--now", "2026-07-28T00:00:00Z"], ["--runtime-root", examplesRoot]]],
    ["current-release", "current-release-v1.example.json", [["--runtime-root", examplesRoot]]],
  ]
  for (const [kind, filename, flags] of cases) {
    const completeMask = (1 << flags.length) - 1
    for (let mask = 0; mask < completeMask; mask += 1) {
      const args = [cliPath, "validate", "--kind", kind, "--input", path.join(examplesRoot, filename)]
      for (let index = 0; index < flags.length; index += 1) if (mask & (1 << index)) args.push(...flags[index])
      const result = spawnSync(process.execPath, args, { encoding: "utf8" })
      assert.equal(result.status, 1, `${kind} context mask ${mask}`)
      assert.equal(result.stderr, "", `${kind} context mask ${mask}`)
      assert.equal(JSON.parse(result.stdout).error.code, "CONTEXT_REQUIRED", `${kind} context mask ${mask}`)
      assert.equal(result.stdout.trim().split(/\r?\n/).length, 1)
    }
  }
})

test("CLI separates standalone inspect from trusted preflight validation levels", async (t) => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "contract-cli-runtime-"))
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }))
  const manifestInput = path.join(examplesRoot, "publish-unit-manifest-v1.example.json")
  const preflight = spawnSync(process.execPath, [cliPath, "validate", "--kind", "publication-manifest", "--input", manifestInput, "--now", "2026-07-28T00:00:00Z", "--runtime-root", runtimeRoot], { encoding: "utf8" })
  assert.equal(preflight.status, 0)
  assert.equal(preflight.stderr, "")
  assert.deepEqual(JSON.parse(preflight.stdout), { ok: true, kind: "publication-manifest", schemaVersion: 1, validationLevel: "preflight" })
  assert.equal(preflight.stdout.trim().split(/\r?\n/).length, 1)

  const releaseInput = path.join(examplesRoot, "release-receipt-v1.example.json")
  const standalone = spawnSync(process.execPath, [cliPath, "inspect", "--kind", "release-receipt", "--input", releaseInput], { encoding: "utf8" })
  assert.equal(standalone.status, 0)
  assert.equal(standalone.stderr, "")
  assert.deepEqual(JSON.parse(standalone.stdout), { ok: true, kind: "release-receipt", schemaVersion: 1, validationLevel: "standalone" })
  assert.equal(standalone.stdout.trim().split(/\r?\n/).length, 1)
})

test("CLI full export preflight verifies current manifest binding, exact file set, and bytes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-cli-export-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await json(path.join(examplesRoot, "publish-unit-manifest-v1.example.json"))
  const receipt = await json(path.join(examplesRoot, "export-receipt-v1.example.json"))
  for (const file of receipt.files) {
    const absolute = path.join(root, ...file.path.split("/"))
    await mkdir(path.dirname(absolute), { recursive: true })
    const bytes = Buffer.from(`cli-synthetic:${file.path}\n`)
    await writeFile(absolute, bytes)
    file.source_sha256 = createHash("sha256").update(bytes).digest("hex")
    manifest.nodes.find((node) => node.path === file.path).source_sha256 = file.source_sha256
  }
  sealManifest(manifest)
  receipt.plan_digest = manifest.plan_digest
  const manifestInput = path.join(root, "manifest.json")
  const receiptInput = path.join(root, "export-receipt.json")
  await writeFile(manifestInput, JSON.stringify(manifest))
  await writeFile(receiptInput, JSON.stringify(receipt))

  // The manifest is context, not part of the isolated export allowlist.
  const contextRoot = await mkdtemp(path.join(tmpdir(), "contract-cli-context-"))
  t.after(() => rm(contextRoot, { recursive: true, force: true }))
  const contextManifest = path.join(contextRoot, "manifest.json")
  await writeFile(contextManifest, JSON.stringify(manifest))
  await rm(manifestInput)
  const result = spawnSync(process.execPath, [cliPath, "validate", "--kind", "export-receipt", "--input", receiptInput, "--manifest", contextManifest, "--export-root", root, "--now", "2026-07-28T00:00:00Z", "--runtime-root", contextRoot], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stdout)
  assert.equal(result.stderr, "")
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, kind: "export-receipt", schemaVersion: 1, validationLevel: "preflight" })
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1)
})

test("CLI rejects adversarial duplicate manifest keys before JSON.parse can overwrite them", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-cli-duplicate-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = path.join(root, "duplicate.json")
  await writeFile(input, '{"schema_version":1,"schema_version":1}')
  const result = spawnSync(process.execPath, [cliPath, "validate", "--kind", "publication-manifest", "--input", input, "--now", "2026-07-28T00:00:00Z", "--runtime-root", root], { encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.equal(result.stderr, "")
  assert.equal(JSON.parse(result.stdout).error.code, "INPUT_DUPLICATE_PROPERTY")
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1)
})

test("CLI error JSON redacts temporary absolute input paths", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-cli-redaction-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = path.join(root, "malformed.json")
  await writeFile(input, '{"unterminated":')
  const result = spawnSync(process.execPath, [cliPath, "inspect", "--kind", "publication-manifest", "--input", input], { encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.equal(result.stderr, "")
  assert.equal(JSON.parse(result.stdout).error.code, "INPUT_INVALID_JSON")
  assert.equal(result.stdout.includes(root), false)
  assert.equal(result.stdout.includes(input), false)
})

test("CLI deterministic schema error remains one JSON object with empty stderr", () => {
  const failure = spawnSync(process.execPath, [cliPath, "inspect", "--kind", "publication-manifest", "--input", orderingPath], { encoding: "utf8" })
  assert.equal(failure.status, 1)
  assert.equal(failure.stderr, "")
  assert.equal(JSON.parse(failure.stdout).error.code, "NON_NFC_STRING")
  assert.equal(failure.stdout.trim().split(/\r?\n/).length, 1)
})

test("Phase B public API accepts genesis only with an absent current pointer and exact genesis baseline", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-runtime-genesis-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await json(path.join(examplesRoot, "publish-unit-manifest-v1.example.json"))
  assert.deepEqual(manifest.action.baseline, { kind: "genesis" })
  const state = await loadPublicationRuntime(root)
  assert.equal(state.currentPointer, undefined)
  const result = await validatePublicationPreflight(manifest, { now: "2026-07-28T00:00:00Z", runtimeRoot: root })
  assert.equal(result.kind, "publication-manifest")
})

test("Phase B stale fixture is rejected through the public pure composition API", async () => {
  const fixture = await json(path.join(repoRoot, "specs", "fixtures", "stale-baseline-v1.semantic-invalid.json"))
  await assert.rejects(validateCrossReleaseManifest(fixture.replayed_manifest, {
    now: "2026-07-28T00:00:00Z",
    currentPointer: fixture.current_pointer,
    currentReceipt: fixture.current_receipt,
    receiptPath: fixture.current_pointer.receipt_path,
  }), (error) => error instanceof ContractError && error.code === fixture.expected_error)
})

test("Phase B positive current publish, Zotero refresh, release binding, and candidate pointer", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-runtime-positive-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const receipt = await json(path.join(examplesRoot, "release-receipt-v1.example.json"))
  const pointer = await json(path.join(examplesRoot, "current-release-v1.example.json"))
  await writeRuntimeCurrent(root, receipt, pointer)

  const publish = await json(path.join(examplesRoot, "publish-unit-with-baseline-v1.example.json"))
  const refresh = await json(path.join(examplesRoot, "zotero-refresh-manifest-v1.example.json"))
  assert.equal((await validatePublicationPreflight(publish, { now: "2026-07-28T00:00:00Z", runtimeRoot: root })).kind, "publication-manifest")
  assert.equal((await validatePublicationPreflight(refresh, { now: "2026-07-28T00:00:00Z", runtimeRoot: root })).kind, "publication-manifest")

  const genesis = await json(path.join(examplesRoot, "publish-unit-manifest-v1.example.json"))
  assert.equal((await validateReleaseAgainstManifest(receipt, genesis)).kind, "release-receipt")
  assert.equal((await validateCurrentReleaseCandidate(pointer, { runtimeRoot: root })).receipt.release_digest, pointer.release_digest)
})

test("Phase B current-presence versus baseline decision table fails closed", async () => {
  const genesis = await json(path.join(examplesRoot, "publish-unit-manifest-v1.example.json"))
  const baseline = await json(path.join(examplesRoot, "publish-unit-with-baseline-v1.example.json"))
  const receipt = await json(path.join(examplesRoot, "release-receipt-v1.example.json"))
  const pointer = await json(path.join(examplesRoot, "current-release-v1.example.json"))
  const state = { now: "2026-07-28T00:00:00Z", currentPointer: pointer, currentReceipt: receipt, receiptPath: pointer.receipt_path }

  await assert.rejects(validateCrossReleaseManifest(baseline, { now: state.now }), (e) => e.code === "GENESIS_BASELINE_REQUIRED")
  await assert.rejects(validateCrossReleaseManifest(genesis, state), (e) => e.code === "RELEASE_BASELINE_REQUIRED")
  const stale = clone(baseline)
  stale.action.baseline.receipt_path = "consumed/VPUB-20260728-older/release-receipt.json"
  sealManifest(stale)
  await assert.rejects(validateCrossReleaseManifest(stale, state), (e) => e.code === "STALE_BASELINE")
  const refresh = await json(path.join(examplesRoot, "zotero-refresh-manifest-v1.example.json"))
  await assert.rejects(validateCrossReleaseManifest(refresh, { now: state.now }), (e) => e.code === "CURRENT_RELEASE_REQUIRED")
})

test("runtime loader distinguishes absent pointer from corrupt pointer and bad/missing receipts", async (t) => {
  const roots = []
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))
  const makeRoot = async () => { const root = await mkdtemp(path.join(tmpdir(), "contract-runtime-integrity-")); roots.push(root); return root }
  const receipt = await json(path.join(examplesRoot, "release-receipt-v1.example.json"))
  const pointer = await json(path.join(examplesRoot, "current-release-v1.example.json"))

  const absent = await makeRoot()
  assert.equal((await loadPublicationRuntime(absent)).currentPointer, undefined)

  const corruptPointer = await makeRoot()
  await writeFile(path.join(corruptPointer, "current-release.json"), "{")
  await assert.rejects(loadPublicationRuntime(corruptPointer), (e) => e.code === "INPUT_INVALID_JSON")

  const missingReceipt = await makeRoot()
  await writeFile(path.join(missingReceipt, "current-release.json"), JSON.stringify(pointer))
  await assert.rejects(loadPublicationRuntime(missingReceipt), (e) => e.code === "CURRENT_RECEIPT_MISSING")

  const badReceipt = await makeRoot()
  const receiptFile = path.join(badReceipt, ...pointer.receipt_path.split("/"))
  await mkdir(path.dirname(receiptFile), { recursive: true })
  await writeFile(receiptFile, "{")
  await writeFile(path.join(badReceipt, "current-release.json"), JSON.stringify(pointer))
  await assert.rejects(loadPublicationRuntime(badReceipt), (e) => e.code === "INPUT_INVALID_JSON")

  const pointerMismatch = await makeRoot()
  const wrongPointer = clone(pointer)
  wrongPointer.release_digest = "0".repeat(64)
  await writeRuntimeCurrent(pointerMismatch, receipt, wrongPointer)
  await assert.rejects(loadPublicationRuntime(pointerMismatch), (e) => e.code === "CURRENT_RELEASE_DIGEST_MISMATCH")

  const storedMismatch = await makeRoot()
  const wrongStored = clone(receipt)
  wrongStored.release_digest = "0".repeat(64)
  await writeRuntimeCurrent(storedMismatch, wrongStored, pointer)
  await assert.rejects(loadPublicationRuntime(storedMismatch), (e) => e.code === "RELEASE_DIGEST_MISMATCH")

  const recomputedMismatch = await makeRoot()
  const changedBytes = clone(receipt)
  changedBytes.artifacts[0].sha256 = "0".repeat(64)
  await writeRuntimeCurrent(recomputedMismatch, changedBytes, pointer)
  await assert.rejects(loadPublicationRuntime(recomputedMismatch), (e) => e.code === "RELEASE_DIGEST_MISMATCH")
})

test("pointer absence is genesis only when consumed history is absent or empty, with zero mutation", async (t) => {
  const roots = []
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))
  const makeRoot = async () => { const root = await mkdtemp(path.join(tmpdir(), "contract-runtime-history-")); roots.push(root); return root }
  const receipt = await json(path.join(examplesRoot, "release-receipt-v1.example.json"))
  const pointer = await json(path.join(examplesRoot, "current-release-v1.example.json"))

  const absent = await makeRoot()
  assert.equal((await loadPublicationRuntime(absent)).currentPointer, undefined)

  const empty = await makeRoot()
  await mkdir(path.join(empty, "consumed"))
  assert.equal((await loadPublicationRuntime(empty)).currentPointer, undefined)

  const validHistory = await makeRoot()
  const validReceiptPath = path.join(validHistory, ...pointer.receipt_path.split("/"))
  await mkdir(path.dirname(validReceiptPath), { recursive: true })
  await writeFile(validReceiptPath, JSON.stringify(receipt))
  const validBefore = await readFile(validReceiptPath, "utf8")
  await assert.rejects(loadPublicationRuntime(validHistory), (error) => error instanceof ContractError && error.code === "GENESIS_HISTORY_PRESENT")
  assert.equal(await readFile(validReceiptPath, "utf8"), validBefore)

  const malformedHistory = await makeRoot()
  const malformedReceiptPath = path.join(malformedHistory, ...pointer.receipt_path.split("/"))
  await mkdir(path.dirname(malformedReceiptPath), { recursive: true })
  await writeFile(malformedReceiptPath, "{sentinel")
  await assert.rejects(loadPublicationRuntime(malformedHistory), (error) => error instanceof ContractError && error.code === "GENESIS_HISTORY_PRESENT")
  assert.equal(await readFile(malformedReceiptPath, "utf8"), "{sentinel")

  const consumedFile = await makeRoot()
  await writeFile(path.join(consumedFile, "consumed"), "sentinel")
  await assert.rejects(loadPublicationRuntime(consumedFile), (error) => error instanceof ContractError && error.code === "GENESIS_HISTORY_PRESENT")
  assert.equal(await readFile(path.join(consumedFile, "consumed"), "utf8"), "sentinel")

  const caseAlias = await makeRoot()
  await mkdir(path.join(caseAlias, "Consumed"))
  await assert.rejects(loadPublicationRuntime(caseAlias), (error) => error instanceof ContractError && error.code === "PATH_CASE_COLLISION")

  const linked = await makeRoot()
  const outside = await makeRoot()
  await writeFile(path.join(outside, "sentinel.txt"), "outside-sentinel")
  await symlink(outside, path.join(linked, "consumed"), "junction")
  await assert.rejects(loadPublicationRuntime(linked), (error) => error instanceof ContractError && error.code === "PATH_SYMLINK_NOT_ALLOWED")
  assert.equal(await readFile(path.join(outside, "sentinel.txt"), "utf8"), "outside-sentinel")

  const linkedEntry = await makeRoot()
  const consumed = path.join(linkedEntry, "consumed")
  await mkdir(consumed)
  await symlink(outside, path.join(consumed, "history-alias"), "junction")
  await assert.rejects(loadPublicationRuntime(linkedEntry), (error) => error instanceof ContractError && error.code === "GENESIS_HISTORY_PRESENT")
  assert.equal(await readFile(path.join(outside, "sentinel.txt"), "utf8"), "outside-sentinel")
})

test("runtime root rejects a parent junction even when the final root child is a regular directory", async (t) => {
  const aliasContainer = await mkdtemp(path.join(tmpdir(), "contract-runtime-parent-alias-"))
  const outsideParent = await mkdtemp(path.join(tmpdir(), "contract-runtime-parent-target-"))
  t.after(() => Promise.all([
    rm(aliasContainer, { recursive: true, force: true }),
    rm(outsideParent, { recursive: true, force: true }),
  ]))
  const realRoot = path.join(outsideParent, "regular-root-child")
  await mkdir(realRoot)
  await writeFile(path.join(realRoot, "sentinel.txt"), "root-sentinel")
  const parentAlias = path.join(aliasContainer, "parent-junction")
  await symlink(outsideParent, parentAlias, "junction")

  await assert.rejects(loadPublicationRuntime(path.join(parentAlias, "regular-root-child")),
    (error) => error instanceof ContractError && error.code === "PATH_SYMLINK_NOT_ALLOWED")
  assert.equal(await readFile(path.join(realRoot, "sentinel.txt"), "utf8"), "root-sentinel")
})

test("runtime loader rejects case aliases, nonregular files, and junction layers with zero mutation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-runtime-path-"))
  const outside = await mkdtemp(path.join(tmpdir(), "contract-runtime-outside-"))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))
  const pointer = await json(path.join(examplesRoot, "current-release-v1.example.json"))

  const asciiAlias = path.join(root, "CURRENT-RELEASE.JSON")
  const expectedPointer = path.join(root, "current-release.json")
  await writeFile(asciiAlias, JSON.stringify(pointer))
  const asciiFilesystemAlias = await probeFilesystemAlias(expectedPointer)
  if (process.platform === "win32") {
    assert.equal(asciiFilesystemAlias, true, "Windows volume must resolve the expected spelling before the loader exercises its filesystem probe")
  }
  const asciiBefore = await readFile(asciiAlias, "utf8")
  await assert.rejects(loadPublicationRuntime(root), (error) => {
    assert.equal(error instanceof ContractError && error.code === "PATH_CASE_COLLISION", true)
    assert.equal(JSON.stringify(error).includes(root), false)
    return true
  })
  assert.equal(await readFile(asciiAlias, "utf8"), asciiBefore)
  await rm(asciiAlias)

  await mkdir(path.join(root, "current-release.json"))
  await assert.rejects(loadPublicationRuntime(root), (e) => e.code === "RUNTIME_FILE_CLASS_INVALID")
  await rm(path.join(root, "current-release.json"), { recursive: true })

  await writeFile(path.join(outside, "release-receipt.json"), "sentinel")
  await symlink(outside, path.join(root, "consumed"), "junction")
  await writeFile(path.join(root, "current-release.json"), JSON.stringify(pointer))
  const before = await readFile(path.join(root, "current-release.json"), "utf8")
  await assert.rejects(loadPublicationRuntime(root), (e) => e.code === "PATH_SYMLINK_NOT_ALLOWED")
  assert.equal(await readFile(path.join(root, "current-release.json"), "utf8"), before)
  assert.equal(await readFile(path.join(outside, "release-receipt.json"), "utf8"), "sentinel")

  const rootAlias = path.join(path.dirname(root), `${path.basename(root)}-alias`)
  await symlink(root, rootAlias, "junction")
  t.after(() => rm(rootAlias, { recursive: true, force: true }))
  await assert.rejects(loadPublicationRuntime(rootAlias), (e) => e.code === "PATH_SYMLINK_NOT_ALLOWED")

  await rm(path.join(root, "consumed"), { recursive: true })
  const finalParent = path.join(root, "consumed", "VPUB-20260728-example")
  await mkdir(finalParent, { recursive: true })
  await symlink(outside, path.join(finalParent, "release-receipt.json"), "junction")
  await assert.rejects(loadPublicationRuntime(root), (e) => e.code === "PATH_SYMLINK_NOT_ALLOWED")
  assert.equal(await readFile(path.join(root, "current-release.json"), "utf8"), before)
  assert.equal(await readFile(path.join(outside, "release-receipt.json"), "utf8"), "sentinel")
})

test("runtime loader probes Windows Unicode UpCase aliases before missing or genesis fallback", async (t) => {
  const roots = []
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))
  const makeRoot = async () => {
    const root = await mkdtemp(path.join(tmpdir(), "contract-runtime-unicode-alias-"))
    roots.push(root)
    return root
  }
  const pointerFixture = await json(path.join(examplesRoot, "current-release-v1.example.json"))
  const cases = [
    {
      label: "long-s/current pointer",
      expectedName: "current-release.json",
      aliasName: "current-releaſe.json",
      arrange: async (root, aliasPath) => writeFile(aliasPath, JSON.stringify(pointerFixture)),
    },
    {
      label: "long-s/consumed history",
      expectedName: "consumed",
      aliasName: "conſumed",
      arrange: async (root, aliasPath) => {
        await mkdir(aliasPath)
        await writeFile(path.join(aliasPath, "sentinel.txt"), "unicode-alias-sentinel")
      },
      sentinelPath: (root, aliasPath) => path.join(aliasPath, "sentinel.txt"),
    },
    {
      label: "dotless-i/consumed receipt",
      expectedName: "release-receipt.json",
      aliasName: "release-receıpt.json",
      directory: "consumed",
      arrange: async (root, aliasPath) => {
        await mkdir(path.dirname(aliasPath), { recursive: true })
        const pointer = { ...pointerFixture, receipt_path: "consumed/release-receipt.json" }
        await writeFile(path.join(root, "current-release.json"), JSON.stringify(pointer))
        await writeFile(aliasPath, "unicode-alias-sentinel")
      },
    },
    {
      label: "kelvin-sign/consumed receipt",
      expectedName: "marker-k.json",
      aliasName: "marker-K.json",
      directory: "consumed",
      arrange: async (root, aliasPath) => {
        await mkdir(path.dirname(aliasPath), { recursive: true })
        const pointer = { ...pointerFixture, receipt_path: "consumed/marker-k.json" }
        await writeFile(path.join(root, "current-release.json"), JSON.stringify(pointer))
        await writeFile(aliasPath, "unicode-alias-sentinel")
      },
    },
  ]

  const matrix = []
  for (const candidate of cases) {
    const root = await makeRoot()
    const directory = candidate.directory ? path.join(root, candidate.directory) : root
    const aliasPath = path.join(directory, candidate.aliasName)
    await candidate.arrange(root, aliasPath)
    const equivalent = await probeFilesystemAlias(path.join(directory, candidate.expectedName))
    matrix.push({ label: candidate.label, equivalent })
    if (equivalent) {
      const sentinelPath = candidate.sentinelPath ? candidate.sentinelPath(root, aliasPath) : aliasPath
      const before = await readFile(sentinelPath, "utf8")
      await assert.rejects(loadPublicationRuntime(root), (error) => {
        assert.equal(error instanceof ContractError && error.code === "PATH_CASE_COLLISION", true, candidate.label)
        assert.equal(JSON.stringify(error).includes(root), false, candidate.label)
        return true
      })
      assert.equal(await readFile(sentinelPath, "utf8"), before, candidate.label)
    }
  }

  assert.deepEqual(matrix.map(({ label }) => label), cases.map(({ label }) => label))
  if (!matrix.some(({ equivalent }) => equivalent)) {
    assert.deepEqual(matrix.map(({ equivalent }) => equivalent), [false, false, false, false])
  }
})

test("publish-unit baseline identity/source and exact added-set equations have stable codes", async () => {
  const original = await json(path.join(examplesRoot, "publish-unit-with-baseline-v1.example.json"))
  const receipt = await json(path.join(examplesRoot, "release-receipt-v1.example.json"))
  const pointer = await json(path.join(examplesRoot, "current-release-v1.example.json"))
  const state = { now: "2026-07-28T00:00:00Z", currentPointer: pointer, currentReceipt: receipt, receiptPath: pointer.receipt_path }
  const cases = [
    ["BASELINE_NODE_MISSING", (m) => { m.nodes = m.nodes.filter((node) => node.public_id !== "jackman-2021") }],
    ["BASELINE_NODE_PATH_CHANGED", (m) => { m.nodes.find((node) => node.public_id === "jackman-2021").path = "Literature/Notes/jackman-renamed.md" }],
    ["BASELINE_NODE_CLASS_CHANGED", (m) => { const node = m.nodes.find((item) => item.public_id === "flow"); node.node_class = "method"; node.path = "Knowledge/Methods/Flow.md" }],
    ["BASELINE_SOURCE_CHANGED", (m) => { m.nodes.find((node) => node.public_id === "jackman-2021").source_sha256 = "0".repeat(64) }],
    ["ADDED_NODE_SET_MISMATCH", (m) => { m.action.added_node_ids = ["guo-2024"] }],
    ["ADDED_NODE_SET_MISMATCH", (m) => { m.action.added_node_ids = ["flow", "guo-2024", "micro-action"] }],
  ]
  for (const [code, mutate] of cases) {
    const manifest = clone(original)
    mutate(manifest)
    sealManifest(manifest)
    await assert.rejects(validateCrossReleaseManifest(manifest, state), (e) => e.code === code, code)
  }
})

test("Zotero refresh preserves set, identity, non-target source, target baseline metadata, and permits no-change target", async () => {
  const original = await json(path.join(examplesRoot, "zotero-refresh-manifest-v1.example.json"))
  const receipt = await json(path.join(examplesRoot, "release-receipt-v1.example.json"))
  const pointer = await json(path.join(examplesRoot, "current-release-v1.example.json"))
  const state = { now: "2026-07-28T00:00:00Z", currentPointer: pointer, currentReceipt: receipt, receiptPath: pointer.receipt_path }
  const noChange = clone(original)
  noChange.nodes.find((node) => node.public_id === "jackman-2021").source_sha256 = receipt.nodes.find((node) => node.public_id === "jackman-2021").source_sha256
  sealManifest(noChange)
  await validateCrossReleaseManifest(noChange, state)

  const cases = [
    ["ZOTERO_NODE_SET_CHANGED", (m) => { m.nodes = m.nodes.filter((node) => node.public_id !== "flow") }],
    ["ZOTERO_NODE_PATH_CHANGED", (m) => { m.nodes.find((node) => node.public_id === "flow").path = "Knowledge/Concepts/Flow-renamed.md" }],
    ["ZOTERO_NODE_CLASS_CHANGED", (m) => { const node = m.nodes.find((item) => item.public_id === "flow"); node.node_class = "method"; node.path = "Knowledge/Methods/Flow.md" }],
    ["ZOTERO_NON_TARGET_SOURCE_CHANGED", (m) => { m.nodes.find((node) => node.public_id === "flow").source_sha256 = "0".repeat(64) }],
  ]
  for (const [code, mutate] of cases) {
    const manifest = clone(original)
    mutate(manifest)
    sealManifest(manifest)
    await assert.rejects(validateCrossReleaseManifest(manifest, state), (e) => e.code === code, code)
  }

  const metadataReceipt = clone(receipt)
  delete metadataReceipt.nodes.find((node) => node.public_id === "jackman-2021").zotero_baseline
  sealRelease(metadataReceipt)
  const metadataPointer = clone(pointer)
  metadataPointer.release_digest = metadataReceipt.release_digest
  const metadataManifest = clone(original)
  metadataManifest.action.baseline_release_digest = metadataReceipt.release_digest
  sealManifest(metadataManifest)
  await assert.rejects(validateCrossReleaseManifest(metadataManifest, {
    now: state.now, currentPointer: metadataPointer, currentReceipt: metadataReceipt, receiptPath: metadataPointer.receipt_path,
  }), (e) => e.code === "ZOTERO_BASELINE_MISSING")
})

test("candidate release receipt cross-binding covers top-level, set, identity, and source fields", async () => {
  const manifest = await json(path.join(examplesRoot, "publish-unit-manifest-v1.example.json"))
  const original = await json(path.join(examplesRoot, "release-receipt-v1.example.json"))
  const cases = [
    ["RELEASE_MANIFEST_BINDING_MISMATCH", (r) => { r.manifest_id = "VPUB-20260728-other" }],
    ["RELEASE_NODE_SET_MISMATCH", (r) => { r.nodes = r.nodes.filter((node) => node.public_id !== "flow") }],
    ["RELEASE_NODE_IDENTITY_MISMATCH", (r) => { r.nodes.find((node) => node.public_id === "flow").path = "Knowledge/Concepts/Flow-renamed.md" }],
    ["RELEASE_NODE_IDENTITY_MISMATCH", (r) => { const node = r.nodes.find((item) => item.public_id === "flow"); node.node_class = "method"; node.path = "Knowledge/Methods/Flow.md" }],
    ["RELEASE_NODE_SOURCE_MISMATCH", (r) => { r.nodes.find((node) => node.public_id === "flow").source_sha256 = "0".repeat(64) }],
  ]
  for (const [code, mutate] of cases) {
    const receipt = clone(original)
    mutate(receipt)
    sealRelease(receipt)
    await assert.rejects(validateReleaseAgainstManifest(receipt, manifest), (e) => e.code === code, code)
  }
})

test("candidate release helper standalone-validates the supplied manifest before cross-binding", async () => {
  const receipt = await json(path.join(examplesRoot, "release-receipt-v1.example.json"))
  const original = await json(path.join(examplesRoot, "publish-unit-manifest-v1.example.json"))

  const malformed = clone(original)
  delete malformed.action
  await assert.rejects(validateReleaseAgainstManifest(receipt, malformed),
    (error) => error instanceof ContractError && error.code === "SCHEMA_INVALID")

  const digestInvalid = clone(original)
  digestInvalid.plan_digest = "0".repeat(64)
  digestInvalid.approval_receipt.approved_plan_digest = digestInvalid.plan_digest
  await assert.rejects(validateReleaseAgainstManifest(receipt, digestInvalid),
    (error) => error instanceof ContractError && error.code === "PLAN_DIGEST_MISMATCH")

  await assert.rejects(validateReleaseAgainstManifest(receipt, original, { now: original.expires_at }),
    (error) => error instanceof ContractError && error.code === "MANIFEST_EXPIRED")
})

test("Phase B CLI validates release and candidate current with one JSON object and redacted runtime errors", async (t) => {
  const genesisRoot = await mkdtemp(path.join(tmpdir(), "contract-cli-release-runtime-"))
  const candidateRoot = await mkdtemp(path.join(tmpdir(), "contract-cli-current-runtime-"))
  t.after(() => Promise.all([rm(genesisRoot, { recursive: true, force: true }), rm(candidateRoot, { recursive: true, force: true })]))
  const manifestPath = path.join(examplesRoot, "publish-unit-manifest-v1.example.json")
  const receiptPath = path.join(examplesRoot, "release-receipt-v1.example.json")
  const pointerPath = path.join(examplesRoot, "current-release-v1.example.json")
  const receipt = await json(receiptPath)
  const pointer = await json(pointerPath)
  const runtimeReceipt = path.join(candidateRoot, ...pointer.receipt_path.split("/"))
  await mkdir(path.dirname(runtimeReceipt), { recursive: true })
  await writeFile(runtimeReceipt, JSON.stringify(receipt))

  const releaseResult = spawnSync(process.execPath, [cliPath, "validate", "--kind", "release-receipt", "--input", receiptPath, "--manifest", manifestPath, "--now", "2026-07-28T00:00:00Z", "--runtime-root", genesisRoot], { encoding: "utf8" })
  assert.equal(releaseResult.status, 0, releaseResult.stdout)
  assert.equal(releaseResult.stderr, "")
  assert.equal(releaseResult.stdout.trim().split(/\r?\n/).length, 1)
  assert.equal(JSON.parse(releaseResult.stdout).validationLevel, "preflight")

  const currentResult = spawnSync(process.execPath, [cliPath, "validate", "--kind", "current-release", "--input", pointerPath, "--runtime-root", candidateRoot], { encoding: "utf8" })
  assert.equal(currentResult.status, 0, currentResult.stdout)
  assert.equal(currentResult.stderr, "")
  assert.equal(currentResult.stdout.trim().split(/\r?\n/).length, 1)

  await rm(runtimeReceipt)
  const failure = spawnSync(process.execPath, [cliPath, "validate", "--kind", "current-release", "--input", pointerPath, "--runtime-root", candidateRoot], { encoding: "utf8" })
  assert.equal(failure.status, 1)
  assert.equal(failure.stderr, "")
  assert.equal(JSON.parse(failure.stdout).error.code, "CURRENT_RECEIPT_MISSING")
  assert.equal(failure.stdout.includes(candidateRoot), false)
})
