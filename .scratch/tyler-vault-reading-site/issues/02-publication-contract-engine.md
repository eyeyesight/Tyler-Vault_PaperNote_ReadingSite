## T02 — Implement publication contract engine

- **Status:** `blocked`
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
