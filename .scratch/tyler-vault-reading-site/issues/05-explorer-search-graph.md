## T05 — Add Explorer, search, public graph, backlinks, and link suppression

- **Status:** `completed`
- **Source spec:** `specs/tyler-vault-reading-site.md`
- **Scope guard:** local only; no Vault/Drive writes, no remote, no deployment, no Hermes changes

- **Priority:** P1
- **Labels:** `navigation`, `search`, `graph`
- **Blocked by:** none (T04 completed)

### Problem

The product needs an Open Neuroscience-style knowledge entrance without exposing unapproved targets or relying on fixed prototype graph coordinates.

### Scope

Implement versioned deterministic public search/graph data, Explorer classes, local/global graph, backlinks, and exact unlisted-link suppression behavior.

### Acceptance criteria

- Search supports title, authors, DOI, source tags, headings, and visible body outside Zotero annotations.
- Graph/search records match the exact spec schemas and deterministic ordering.
- Every edge endpoint resolves to a public node; unlisted targets create no href, target metadata, search record, backlink, or graph node.
- Layout scales beyond fixed ten-node coordinates and has no label clipping/overlap in agreed desktop/mobile fixtures.
- Search by Jackman DOI returns one paper; `flow` fixture returns its expected approved records.

### Non-goals

No recursive Vault graph, AI summaries, ranking model, or publication of unrelated formal pages.

### Engineering evidence

- Deterministic public contracts are implemented by `schemas/public-graph-v1.schema.json` and `schemas/search-index-v1.schema.json`; independent literal byte vectors live under `specs/fixtures/`.
- Quartz remains the primary renderer and `contentIndex`/`fetchData` seam. The project-owned navigation adapter provides one class-grouped Explorer, search, deterministic global/local graph, public-only backlinks, and deployment-subpath-safe browser URLs without CDN dependencies.
- Public candidate gates execute both normative schemas, enforce graph/search identity parity and edge closure, and suppress unlisted targets through bounded percent/HTML decoding to a fail-closed fixpoint.
- Parent focused verification: T05/N4 `14/14`, T03 exact regression `1/1`, T04 theme/security `13/13`, and publication contracts `76/76` passed.
- Standards, Spec, and Security correction reviews reported `0` remaining blocker, major, or minor findings.
- Fresh full suite: `251/251` passed with `0` failed, cancelled, or skipped; Edge PIDs `9152` and `3516` exited and both temporary profiles were removed.
- Final scope audit matched the exact 12-path T05 allowlist; `git diff --check` passed and the staged index was empty before final staging.
