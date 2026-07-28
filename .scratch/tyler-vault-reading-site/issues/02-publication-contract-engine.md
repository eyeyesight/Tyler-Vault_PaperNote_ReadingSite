## T02 — Implement publication contract engine

- **Status:** `done`
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

- Phase A added the read-only public library/CLI at `lib/publication-contracts.mjs` and `scripts/contracts.mjs` with one stable JSON success/error object and invariant-specific deterministic codes.
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

### Phase B evidence

- Added pure public `validateCrossReleaseManifest` composition plus read-only `loadPublicationRuntime`/`validatePublicationPreflight`. Genesis requires both an absent fixed `current-release.json` and absent consumed history (a missing or empty canonical `consumed/` is accepted). Any history entry, unreadable/ambiguous state, case alias, nonregular entry, or Node-identifiable symlink/junction fails closed with `GENESIS_HISTORY_PRESENT` or a more specific security code; no runtime failure downgrades to genesis.
- Genesis retains the normative exact `baseline: { "kind": "genesis" }`; current publication requires exact `{ "kind": "release", ... }`. All public IDs exactly equal sorted genesis `added_node_ids`. Current publish requires an exact action/current path+digest match (`STALE_BASELINE` otherwise), preserves every baseline path/class/source hash, and proves exact baseline-union-added and publication-unit scope equations.
- Runtime roots are checked from the absolute filesystem anchor through every ancestor with `lstat` before `realpath`, so a symlink/junction parent that Node identifies through `Stats.isSymbolicLink()` cannot launder a regular final root child. Contract-controlled layers retain exact-case, regular-class, Node-identifiable link, canonical-containment checks and redacted errors. Other opaque Windows reparse tags that Node does not expose as links are a documented residual outside the accepted runtime configuration; the runtime must be an ordinary local, agent-owned NTFS directory without those tags.
- Zotero refresh requires current state, exact three-way baseline binding, unchanged public ID/path/class/public-set identity, unchanged non-target source hashes, a still-paper canonical target, and complete schema-valid target `zotero_baseline`; an unchanged target source hash remains contract-valid.
- Candidate release receipts bind manifest ID, plan digest, public-set digest, and every node ID/path/class/source hash while permitting receipt-only Zotero metadata. Public `validateReleaseAgainstManifest` now first runs standalone manifest schema/digest/semantic validation, with trusted time opt-in, before cross-binding. Candidate pointers resolve and validate their named in-root receipt with stored/recomputed digest equality.
- Public CLI `validate` still requires `--now --runtime-root` for manifests, `--manifest --export-root --now --runtime-root` for exports, `--manifest --now --runtime-root` for releases, and `--runtime-root` for candidate pointers. Export/release validation first runs manifest Phase B; it does not fall back to standalone helper validation. `inspect` remains context-free standalone; successes remain one JSON object with `validationLevel:"preflight"`, empty stderr, and redacted failures.
- Public tests directly consume `stale-baseline-v1.semantic-invalid.json`, cover exact genesis/release baseline objects, pointer and consumed-history decision rows, positive genesis/current/Zotero/release/pointer paths, path/stored/recomputed failures, valid and malformed orphan receipts, empty/no consumed positives, ASCII aliases plus a conditional Windows Unicode UpCase alias matrix (`ſ/s`, `ı/i`, `K/k`) at current-pointer, consumed-history, and consumed-receipt layers, case/nonregular/junction containment, parent-junction roots, zero mutation, baseline deletion/path/class/hash, added missing/extra, Zotero set/path/class/non-target hash/no-change/metadata, release cross-binding, standalone malformed/digest-invalid manifest rejection, CLI context/output, and redaction. Mutated contracts are resealed before the target invariant.
- Final verification after the filesystem review correction: typecheck passed; focused contract suite passed **76/76**; full suite passed **166/166**; targeted pointer/history/ASCII/Unicode filesystem tests passed **3/3**. The direct Windows volume probe resolved the ASCII alias through the expected spelling; this host reported `ENOENT` for all tested Unicode pairs, so the matrix exercised and asserted the case-sensitive result without skipping. `git diff --check` passed and `git diff -- schemas specs` is empty; the schema/spec example status entries are CRLF metadata only and were not touched.
- Dependency audit remains the unchanged pinned Quartz boundary at **7 high, 0 critical**. No dependency was added, no audit fix was run, and no Vault/Drive/remote/deploy/Hermes action occurred.
