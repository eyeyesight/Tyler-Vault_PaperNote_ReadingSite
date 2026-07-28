# Publication contract engine (T02 Phase B)

`lib/publication-contracts.mjs` and `scripts/contracts.mjs` are the project-owned,
read-only publication contract seam. Phase A schema, strict I-JSON, JCS, ordering,
path, time, action-shape, export-byte, and receipt-digest checks remain intact.
Phase B composes those checks with the runtime current release and enforces the
cross-release genesis, baseline, public-set, Zotero, candidate-release, and
candidate-pointer equations.

The engine never reads Tyler-Vault, writes runtime state, creates output, promotes
a release, contacts Drive, or authenticates approval events. `--runtime-root` is
read-only validation context; it is not an input/output location for mutation.

## Public CLI

The CLI emits exactly one JSON object on stdout, emits nothing on stderr, and exits
`0` on success or `1` on failure. `validate` is Phase B preflight and requires all
context below:

```sh
# Genesis or current-baseline publication manifest
node scripts/contracts.mjs validate \
  --kind publication-manifest --input manifest.json \
  --now 2026-07-28T00:00:00Z --runtime-root /runtime

# Export receipt; its manifest is Phase B-validated first
node scripts/contracts.mjs validate \
  --kind export-receipt --input /export/export-receipt.json \
  --manifest manifest.json --export-root /export \
  --now 2026-07-28T00:00:00Z --runtime-root /runtime

# Candidate release receipt; its manifest is Phase B-validated first
node scripts/contracts.mjs validate \
  --kind release-receipt --input candidate-release-receipt.json \
  --manifest manifest.json \
  --now 2026-07-28T00:00:00Z --runtime-root /runtime

# Candidate pointer resolves and validates the named consumed receipt
node scripts/contracts.mjs validate \
  --kind current-release --input candidate-current-release.json \
  --runtime-root /runtime
```

Missing any required context returns `CONTEXT_REQUIRED`. `inspect` remains the
explicit context-free schema/standalone semantic command and rejects validation
context. Successful `validate` output retains
`"validationLevel":"preflight"`; successful `inspect` output retains
`"validationLevel":"standalone"`.

## Public library seams

- `loadPublicationRuntime(runtimeRoot)` reads fixed `current-release.json` and the
  exact `consumed/.../release-receipt.json` named by it. Genesis requires both the
  fixed pointer and consumed receipt history to be absent; a missing or empty
  canonical `consumed/` directory is accepted. Any history entry, read failure,
  case alias, nonregular entry, or Node-identifiable symlink/junction fails closed
  rather than downgrading to genesis.
- `validateCrossReleaseManifest(manifest, state)` is the pure composition seam. It
  validates supplied contracts and applies cross-release equations without I/O.
- `validatePublicationPreflight(manifest, { now, runtimeRoot })` composes the
  read-only loader and pure seam.
- `validateReleaseAgainstManifest(receipt, manifest, { now? })` first performs
  standalone schema/digest/semantic manifest validation (trusted time is opt-in),
  then validates and cross-binds the candidate receipt.
- `validateCurrentReleaseCandidate(pointer, { runtimeRoot })` resolves and
  validates a candidate pointer's receipt without writing or replacing the fixed
  pointer.
- Phase A exports remain available: `validateContract`,
  `validateStandaloneBundle`, `readContractJson`, `jcsCanonicalize`, `sha256Jcs`,
  `compareUtf8`, ordering helpers, and digest helpers.

## Runtime trust boundary

The loader requires an existing regular directory root. For an absolute runtime
root it `lstat`s every layer from the filesystem anchor through the final root,
rejecting an ancestor symlink or junction (the reparse links Node identifies via
`Stats.isSymbolicLink()`) even when the final child is a regular directory, and
only then resolves the canonical root. It checks exact casing, canonical
containment, and regular directory/file class at every contract-controlled layer.
It rejects absolute/traversal/backslash contract paths, case aliases/collisions,
Node-identifiable symlinks/junctions, nonregular entries, and canonical escapes.
Runtime errors contain no absolute path.

`Stats.isSymbolicLink()` does not prove rejection of every opaque Windows reparse
tag that Node does not expose as a link. Those tags are a documented residual and
are outside the accepted runtime configuration. The runtime root must therefore
be an ordinary local, agent-owned NTFS directory with no unsupported opaque
reparse tags.

A current pointer is trusted only after:

1. strict duplicate-aware UTF-8 I-JSON reading and current-pointer validation;
2. exact in-root resolution of its normalized `consumed/...json` path;
3. strict release-receipt validation and receipt digest recomputation; and
4. equality of pointer digest, receipt stored digest, and recomputed digest.

## Cross-release equations

### Publish unit

- Genesis requires absent `current-release.json`, no possible consumed receipt
  history, exact `action.baseline: { "kind": "genesis" }`, at least one node
  (schema), and exact sorted equality of `added_node_ids` to every manifest public
  ID. A missing or empty canonical `consumed/` directory is the only accepted
  consumed state. Added nodes are only the primary paper and its new direct support
  nodes.
- With current state, baseline path/digest must byte-equal the validated current
  pointer and resolved receipt. Any older valid consumed receipt is
  `STALE_BASELINE`.
- Every baseline public ID remains present with unchanged path, node class, and
  source SHA-256. `added_node_ids` is exactly manifest IDs minus baseline IDs;
  there are no missing, extra, existing, or unrelated added IDs.

### Zotero refresh

A current release is mandatory. Baseline path/digest has the same exact
three-way binding. Public IDs, paths, classes, and `public_set_digest` remain
identical; every non-target source hash remains identical. The target exists in
both sets, remains a paper at the same canonical path, and is the sole source hash
allowed to differ (an equal hash is a valid no-change contract). Its baseline
receipt node must contain complete schema-valid `zotero_baseline` metadata.

### Candidate release and pointer

A release receipt binds the manifest's `manifest_id`, `plan_digest`, and
`public_set_digest`. Its nodes exactly match manifest public IDs and each node's
path, class, and source hash; optional `zotero_baseline` receipt metadata does not
change those four fields. The complete Phase A `release_digest` still applies.
A candidate pointer must resolve inside the runtime root and match the receipt's
stored and recomputed digest.

Representative Phase B codes include `GENESIS_BASELINE_REQUIRED`,
`GENESIS_HISTORY_PRESENT`, `RELEASE_BASELINE_REQUIRED`,
`CURRENT_RELEASE_REQUIRED`, `STALE_BASELINE`, `CURRENT_RECEIPT_MISSING`,
`CURRENT_RELEASE_DIGEST_MISMATCH`, `CURRENT_RECEIPT_PATH_MISMATCH`, `BASELINE_NODE_MISSING`,
`BASELINE_NODE_PATH_CHANGED`, `BASELINE_NODE_CLASS_CHANGED`,
`BASELINE_SOURCE_CHANGED`, `ADDED_NODE_SET_MISMATCH`,
`ADDED_NODE_SCOPE_INVALID`, `ZOTERO_NODE_SET_CHANGED`,
`ZOTERO_NODE_PATH_CHANGED`, `ZOTERO_NODE_CLASS_CHANGED`,
`ZOTERO_NON_TARGET_SOURCE_CHANGED`, `ZOTERO_PUBLIC_SET_CHANGED`,
`ZOTERO_BASELINE_MISSING`, `RELEASE_MANIFEST_BINDING_MISMATCH`,
`RELEASE_NODE_SET_MISMATCH`, `RELEASE_NODE_IDENTITY_MISMATCH`, and
`RELEASE_NODE_SOURCE_MISMATCH`.

## Phase A history retained

Phase A introduced the four Draft 2020-12 schema validators, strict
UTF-8/duplicate-aware recursive reader, project-owned RFC 8785 serializer,
unsigned UTF-8 contract-array ordering, NFC enforcement, plan/public-set/release
digests, standalone manifest action semantics, isolated export byte validation,
and release receipt self-exclusion. Its final suite passed 62 focused and 152 full
tests, with no new dependency and the existing Quartz audit boundary at seven
high and zero critical advisories.

## Phase B evidence

The Phase B suite directly consumes the named stale fixture and exercises public
API/CLI seams for the exact genesis/release baseline objects, pointer/consumed
history decision rows, positive baseline publication, Zotero refresh/no-change,
path/stored/recomputed pointer integrity, valid and malformed orphan history,
missing and bad receipts, ASCII and conditional Windows Unicode UpCase aliases,
case/nonregular/junction paths, parent-junction runtime roots, zero mutation,
standalone manifest validation at the candidate-release helper, baseline identity
and source preservation, exact added sets, Zotero set/identity/source/metadata,
candidate release binding, candidate current resolution, required CLI context,
single-object output, empty stderr, and runtime-path redaction. The Unicode matrix
probes the expected spelling with `lstat` and covers fixed pointer, consumed-history,
and consumed-receipt layers without skipping on volumes where no candidate pair is
equivalent. Mutated contracts are resealed so target equations are not hidden by
stale Phase A digests.

Final command counts and audit evidence are recorded in the T02 issue. T02 is
`ready-for-review-phase-b`, not done.
