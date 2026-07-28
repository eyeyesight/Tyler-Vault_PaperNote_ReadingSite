# Publication contract engine (T02 Phase A)

`lib/publication-contracts.mjs` and `scripts/contracts.mjs` are the project-owned,
read-only publication contract seam. They validate the exact repository schemas
with Ajv's Draft 2020-12 implementation, then apply standalone prose invariants.
They do not read or write Tyler-Vault, create output, promote releases, contact
Drive, or authenticate approval events.

## CLI

Automation invokes the Node wrapper directly. It writes exactly one JSON object
to stdout and nothing to stderr. Success exits `0`; failure exits `1`.

```sh
node scripts/contracts.mjs validate \
  --kind publication-manifest \
  --input specs/examples/publish-unit-manifest-v1.example.json \
  --now 2026-07-28T00:00:00Z

node scripts/contracts.mjs validate \
  --kind export-receipt \
  --input /isolated-export/export-receipt.json \
  --manifest /runtime/pending/VPUB-....json \
  --export-root /isolated-export \
  --now 2026-07-28T00:00:00Z

node scripts/contracts.mjs inspect \
  --kind release-receipt \
  --input /runtime/consumed/VPUB-.../release-receipt.json

node scripts/contracts.mjs inspect \
  --kind current-release \
  --input /runtime/current-release.json
```

The npm alias is `npm run contracts:validate -- ...`; the focused test alias is
`npm run test:contracts`. Public `validate` is fail-closed preflight: a manifest
requires trusted `--now`, while an export receipt requires all of `--manifest`,
`--export-root`, and `--now`. Omitting any required context returns
`CONTEXT_REQUIRED`. Export preflight validates current manifest validity, receipt
binding, the exact isolated file set, and every source/file hash.

Phase A cannot perform cross-release preflight for release receipts or current
pointers without the Phase B baseline context. Their explicit `inspect` command
performs standalone schema/semantic inspection only. `inspect` accepts no context;
it must not be treated as publication authorization or preflight.

Success is stable JSON:

```json
{"ok":true,"kind":"publication-manifest","schemaVersion":1,"validationLevel":"preflight"}
```

`inspect` successes instead carry `"validationLevel":"standalone"`.

Errors have a deterministic invariant code and redacted message/details:

```json
{"ok":false,"error":{"code":"PLAN_DIGEST_MISMATCH","message":"plan_digest does not match the JCS publication plan"}}
```

## Library and invariants

Exports include `validateContract`, `validateStandaloneBundle`,
`readContractJson`, `jcsCanonicalize`, `sha256Jcs`, `compareUtf8`, ordering
helpers, and manifest digest helpers. `validateStandaloneBundle` accepts an
independently validated current pointer/receipt for Phase B composition, but
intentionally performs no cross-release equations.

Phase A enforces:

- a strict UTF-8 I-JSON reader that rejects BOM, duplicate decoded property names
  at any object depth, comments, and trailing commas, plus exact repository Draft
  2020-12 schemas;
- a project-owned, auditable RFC 8785 serializer that snapshots each ordinary
  object once through own property descriptors, serializes only enumerable data
  properties, sorts object names by UTF-16 code units, and uses ECMAScript
  primitive number/string serialization; it rejects Proxy before reflection,
  accessor and non-enumerable properties, symbols, named array properties, holes,
  non-plain objects, cycles, non-finite numbers, unsupported values, and lone
  surrogates without invoking getters, `toJSON`, inherited properties, or Proxy
  traps, plus SHA-256 for `plan_digest`, `public_set_digest`, and `release_digest`;
- NFC and unsigned UTF-8 lexicographic, complete-prefix-first ordering for every
  digest-bound contract array;
- unique IDs, exact and case-insensitive path uniqueness, normalized relative
  forward-slash paths, fixed class roots, and `.md` source identities;
- strict UTC RFC 3339 whole-second timestamps and approval/window binding;
- publish-unit primary/support/edge shape and coverage;
- isolated export receipt/manifest set and hash equality, receipt presence,
  unlisted-file rejection, real-path containment, and symlink/reparse rejection;
- release artifact order/uniqueness, normalized Windows-safe ASCII
  case-insensitive receipt-self exclusion at any depth, public-set digest,
  and complete release digest.

Representative stable codes are `SCHEMA_INVALID`, `NON_NFC_STRING`,
`INPUT_DUPLICATE_PROPERTY`, `INPUT_INVALID_UNICODE`, `JCS_NON_FINITE_NUMBER`,
`JCS_UNSUPPORTED_TYPE`, `JCS_ARRAY_HOLE`, `JCS_NAMED_ARRAY_PROPERTY`,
`JCS_ACCESSOR_PROPERTY`, `JCS_NON_ENUMERABLE_PROPERTY`, `JCS_SYMBOL_PROPERTY`,
`JCS_PROXY`, `JCS_NON_PLAIN_OBJECT`, `JCS_CYCLE`,
`INVALID_UNICODE_SCALAR`, `NOW_INVALID`, `CONTEXT_REQUIRED`,
`ARRAY_NOT_SORTED`, `ARRAY_NOT_UNIQUE`, `DUPLICATE_PUBLIC_ID`, `DUPLICATE_PATH`,
`PATH_CASE_COLLISION`, `PATH_ABSOLUTE`, `PATH_TRAVERSAL`, `PATH_BACKSLASH`,
`PATH_DRIVE_ABSOLUTE`, `PATH_UNC`, `PATH_SYMLINK_NOT_ALLOWED`,
`PATH_CONTAINMENT_ESCAPE`, `TIMESTAMP_INVALID`, `TIME_WINDOW_INVALID`,
`APPROVAL_TIME_INVALID`, `CLASS_ROOT_MISMATCH`, `PRIMARY_NOT_PAPER`,
`SUPPORT_NOT_FOUND`, `ACTION_EDGE_INVALID`, `ACTION_EDGE_COVERAGE`,
`PUBLIC_SET_DIGEST_MISMATCH`, `APPROVAL_DIGEST_MISMATCH`,
`PLAN_DIGEST_MISMATCH`, `EXPORT_MANIFEST_BINDING_MISMATCH`,
`EXPORT_SOURCE_HASH_MISMATCH`, `EXPORT_FILE_HASH_MISMATCH`,
`EXPORT_UNLISTED_FILE`, `RELEASE_RECEIPT_ARTIFACT`, and
`RELEASE_DIGEST_MISMATCH`.

Validation code performs reads only. It has no output/staging argument and no
write primitive. Isolated filesystem tests snapshot sentinels through rejected
unlisted-file, hash, and junction/symlink paths.

## Phase A review-correction evidence

The focused RED→GREEN suite passes 62/62 and the full repository suite passes
152/152 (the unchanged T01 90 plus T02 Phase A 62). Post-`npm ci` typecheck,
focused/full tests, both direct `toJSON` adversarial probes, and
`git diff --check` pass. `npm audit --omit=dev` remains at the pre-existing pinned
Quartz boundary of seven high and zero critical advisories. This correction
removed the canonicalizer runtime dependency, added none, and ran no audit fix.
T02 remains `in-progress-phase-a`; the Phase B boundary below is unchanged.

## Explicit Phase B pending boundary

Phase A does **not** implement genesis/current-presence rules, current pointer ↔
receipt ↔ action three-way equality, stale-baseline rejection, baseline identity
preservation, unchanged baseline source hashes, added-node set equations, or
Zotero cross-release identity/source equations. Those require a validated
current release context and belong to T02 Phase B. `stale-baseline-v1.semantic-invalid.json`
is therefore retained as Phase B evidence, not falsely accepted as a completed
Phase A equation test.
