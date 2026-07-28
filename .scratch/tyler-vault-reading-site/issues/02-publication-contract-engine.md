## T02 — Implement publication contract engine

- **Status:** `in-progress-phase-a`
- **Source spec:** `specs/tyler-vault-reading-site.md`
- **Scope guard:** local only; no Vault/Drive writes, no remote, no deployment, no Hermes changes

- **Priority:** P0
- **Labels:** `foundation`, `security`, `contracts`
- **Blocked by:** T01

### Problem

JSON shape validation alone cannot prove approval binding, JCS digests, path containment, complete public-set equations, release baselines, sorting, or uniqueness.

### Scope

Implement schema loading plus semantic preflight for manifest, export receipt, release receipt, and current-release pointer. Implement RFC 8785 JCS digest checks and the exact genesis/release/Zotero baseline rules from the spec.

### Acceptance criteria

- RED→GREEN tests cover all files under `specs/examples/` and reject schema/prose negative cases.
- Reject duplicate IDs, duplicate/case-colliding paths, unsorted arrays, absolute/traversal/symlink escapes, invalid times, approval mismatch, digest mismatch, class/root mismatch, invalid action edges, and failed set equations.
- Recompute and verify `plan_digest`, `public_set_digest`, `release_digest`, baseline receipt equality, and export/source hashes.
- Enforce NFC plus unsigned UTF-8 byte ordering for every digest-bound array and reject alternate/locale ordering. Tests must directly load every named vector in `specs/fixtures/utf8-ordering-v1.json`: nodes, identity projection, support IDs, added IDs, direct edges, export files, and release artifacts, including prefix-first cases.
- Genesis works only without current release; every non-genesis baseline path/digest must equal the validated current pointer and recomputed current receipt; a stale valid receipt is rejected. Release baseline preserves all prior identities/source hashes and adds exactly the approved unit.
- Public CLI returns stable machine-readable error codes and performs zero source/output mutation on preflight failure.

### Non-goals

No Quartz rendering, no Telegram approval creation, no Drive access.

### Phase A evidence

- Status remains `in-progress-phase-a`; Phase A adds the read-only public library/CLI at `lib/publication-contracts.mjs` and `scripts/contracts.mjs` with one stable JSON success/error object and invariant-specific deterministic codes.
- Exact-pinned `ajv@8.20.0` validates the four repository schemas as Draft 2020-12. RFC 8785 JCS is now a project-owned auditable serializer with no canonicalizer runtime package: it snapshots own descriptors, never invokes `toJSON`/getters/inherited properties/Proxy traps, and uses the RFC-required UTF-16 property-name order. Literal examples still reproduce `plan_digest`, `public_set_digest`, and `release_digest`; this final review removes one runtime dependency.
- Review correction: the public reader now parses strict UTF-8 I-JSON with an auditable duplicate-aware recursive descent before object construction, including nested and escaped-name duplicates (`INPUT_DUPLICATE_PROPERTY`). Public JCS helpers recursively reject non-finite/unsupported JavaScript values, array holes, non-plain objects, cycles, and lone surrogates before canonicalization while contract digests remain NFC-bound.
- Public CLI `validate` now fails closed: manifests require trusted `--now`; export receipts require `--manifest`, `--export-root`, and `--now` and verify current validity, binding, exact file set, and bytes. Standalone schema/semantic use is the distinct `inspect` command. Success identifies `validationLevel` as `preflight` or `standalone`; Phase A release/current validation remains standalone rather than claiming Phase B preflight.
- Final Phase A JCS review: the focused RED run reproduced both `json-canonicalize` defects (own `toJSON` bypassed sorting; inherited polluted `Object.prototype.toJSON` replaced ordinary input). The package/import were removed. The project serializer rejects Proxy before reflection with `JCS_PROXY`, reads one own-descriptor snapshot per ordinary object, accepts only enumerable data, treats own `toJSON` as ordinary data, and uses RFC 8785 UTF-16 code-unit name order rather than the contract-array UTF-8 comparator.
- The security matrix covers object/array trailing commas and comments; bad escapes, escaped surrogate pairs and lone surrogates; number grammar, token boundaries and out-of-range values; nested decoded duplicate names; safe own `__proto__`; getter non-execution; symbols, non-enumerables, named array properties, holes, non-plain values, cycles and trap-free Proxy rejection; and CLI temporary-path redaction.
- Existing Windows-safe release-receipt self-exclusion and millisecond/invalid `Date` handling remain covered and unchanged.
- Focused RED→GREEN suite now has **62 tests**. It retains all seven named ordering vectors, literal RFC number/escaping examples and example digests, plus the public-path ordering/identity matrices, strict recursive reader matrix, descriptor/Proxy matrix, Date/Windows receipt cases, complete CLI context matrix, full manifest/export successes, path redaction, and one-object/empty-stderr assertions.
- Final verification: `npm ci` succeeded (with a non-fatal stale Sass-directory cleanup warning); `npm run typecheck` passed; focused tests passed **62/62**; full `npm test` passed **152/152** (the prior T01 90 plus Phase A 62); both direct adversarial `toJSON` probes returned the required canonical output; and `git diff --check` passed.
- `npm audit --omit=dev` reports the unchanged pre-existing Quartz boundary of **7 high, 0 critical** advisories (`brace-expansion`/`minimatch`/`serve-handler` and `sharp` through pinned Quartz). The final JCS review removed one runtime dependency, added none, and ran no audit fix.
- Documentation: `docs/publication-contract-engine.md`; package aliases: `contracts:validate` and `test:contracts`.

### Phase B pending (intentionally not implemented)

- Genesis/current-release presence rules; current pointer/action/receipt path+stored+recomputed digest three-way equality; stale-current baseline rejection (including `stale-baseline-v1.semantic-invalid.json`).
- Baseline identity preservation/reclassification/source-hash equations, exact added-node/public-set equations, and Zotero cross-release identity/source equations.
- `validateStandaloneBundle` accepts independently validated current pointer/receipt values so Phase B can add these equations without weakening or duplicating Phase A validation.
