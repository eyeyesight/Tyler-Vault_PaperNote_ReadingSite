## T05 — Add Explorer, search, public graph, backlinks, and link suppression

- **Status:** `ready-for-agent`
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
