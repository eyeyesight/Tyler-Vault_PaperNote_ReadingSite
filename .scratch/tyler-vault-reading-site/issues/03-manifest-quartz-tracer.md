## T03 — Build the manifest-to-Quartz tracer slice

- **Status:** `blocked`
- **Source spec:** `specs/tyler-vault-reading-site.md`
- **Scope guard:** local only; no Vault/Drive writes, no remote, no deployment, no Hermes changes

- **Priority:** P0
- **Labels:** `vertical-slice`, `quartz`, `renderer`
- **Blocked by:** T01, T02

### Problem

The chosen architecture is not proven until a validated allowlist can become a minimal Quartz site without scanning the canonical Vault or publishing unlisted nodes.

### Scope

Create an isolated manifest adapter and render one synthetic paper plus one synthetic support node through Quartz.

### Acceptance criteria

- Preflight copies only manifest-listed Markdown from the isolated export into a fresh renderer input; unlisted files fail closed.
- Generated routes are exactly `/`, `/papers/<id>/`, and `/knowledge/<class>/<id>/` for the fixture.
- Wikilink/backlink resolution works between the two approved nodes; unlisted links produce display text only and no public target metadata.
- Generated output contains no Markdown, PDFs, source receipts, absolute paths, or fixture claims presented as research evidence.
- Source fixture hashes remain unchanged; configured canonical Vault write count is zero.

### Non-goals

No final theme, full Explorer/search/graph, release promotion, or real research content.
