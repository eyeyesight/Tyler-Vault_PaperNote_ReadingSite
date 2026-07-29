## T07 — Implement Zotero marker-only delta validation

- **Status:** `blocked`
- **Source spec:** `specs/tyler-vault-reading-site.md`
- **Scope guard:** local only; no Vault/Drive writes, no remote, no deployment, no Hermes changes

- **Priority:** P0
- **Labels:** `zotero`, `safety`, `delta`
- **Blocked by:** T05, T06

### Problem

Automatic site refresh is allowed only when one already-published paper changes inside its unique managed Zotero block.

### Scope

Implement raw-byte marker parsing, baseline receipt comparison, complete public-set/source checks, and page-only artifact-diff enforcement.

### Acceptance criteria

- LF and CRLF literal fixtures pass when only managed content changes.
- BOM, mixed EOL, duplicate/reversed/missing markers, marker-line changes, prefix/suffix changes, and non-target source changes reject.
- Baseline receipt path/digest/current pointer all resolve to and verify the same release; stale consumed receipts reject even when internally valid.
- Public set and all non-target source hashes remain unchanged.
- A valid delta changes only the target paper page; search, graph, navigation, theme, and unrelated page hashes remain unchanged.

### Non-goals

No Zotero API call, Vault write, cron change, or failed-build retry.
