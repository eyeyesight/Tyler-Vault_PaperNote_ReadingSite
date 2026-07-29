## T06 — Implement safe releases and last-known-good protection

- **Status:** `blocked`
- **Source spec:** `specs/tyler-vault-reading-site.md`
- **Scope guard:** local only; no Vault/Drive writes, no remote, no deployment, no Hermes changes

- **Priority:** P0
- **Labels:** `security`, `release`, `reliability`
- **Blocked by:** T05

### Problem

A direct or partial build must never replace a valid local release, and candidate bytes must be scanned before promotion.

### Scope

Implement empty immutable staging, output allowlist, release receipt/digest, content fingerprints, versioned secret rules, immutable release directories, and atomic current-release pointer replacement.

### Acceptance criteria

- Valid candidate creates a schema-valid receipt whose recomputed `release_digest` matches; receipt is not in artifacts.
- Expired/digest/hash/path/link/secret/output failures leave the prior pointer and release bytes unchanged.
- Candidate public tree contains no Markdown/PDF/source receipts/runtime data/local paths/credentials.
- Stale prior files cannot survive because staging starts empty and exact output allowlist is checked.
- Valid promotion changes only `current-release.json` after release verification; failure never changes it.

### Non-goals

No remote deployment, hosting retry, resumable operation journal, quarantine retention, or concurrent publication.
