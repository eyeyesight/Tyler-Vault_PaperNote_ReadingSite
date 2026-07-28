# Domain Context

## Product

A generated public reading layer for explicitly approved Tyler-Vault research notes. It combines a knowledge entrance (Explorer, search, global graph) with scholarly paper reading pages and simpler support-node pages.

## Vocabulary

- **Canonical Vault:** Tyler-Vault Markdown on Google Drive; the only editable research source.
- **Publication manifest:** Tyler-approved, expiring, digest-bound allowlist for one publication action.
- **Publication unit:** one integrated Literature Note plus only explicitly listed direct formal support nodes.
- **Generated site:** HTML/CSS/JavaScript/search/graph/deployment artifacts outside Tyler-Vault.
- **Paper page:** bibliographic masthead, One-sentence Takeaway, Research Question, body, collapsed Zotero Annotations, backlinks/local graph.
- **Support page:** title, approved body, backlinks, local graph; never forced into the paper template.
- **Public graph:** generated nodes and edges; an edge exists only when both endpoints are in the approved public node set.
- **Zotero managed block:** marker-bounded annotation region eligible for automatic refresh on an already-published paper.
- **Last-known-good site:** the currently valid deployed/generated release preserved when a later build or validation fails.
- **Prototype fixture:** labelled non-factual layout data; never a publication unit or maturity evidence.

## Fixed external contracts

- Canonical source is read-only to this repository.
- No website artifact or runtime state is written into Tyler-Vault.
- Eligible paper: `Literature/Notes/`, `type: literature-note`, `status: integrated`, explicitly manifest-listed.
- New publications require explicit Tyler approval; only already-published Zotero managed-block deltas may later auto-refresh.
- PDFs, Drafts, Queue, Logs, credentials, unrelated nodes, and unapproved graph edges are excluded.
- User-facing controls and section headings are English; approved note body remains Traditional Chinese.
- Theme replacement must not alter source Markdown or semantic page structure.
- Build/validation failure must not replace last-known-good output.

## Evidence status

The throwaway prototype passed 4/5 maturity tests. The missing test is 3–5 structurally different real integrated notes; the live Vault had only two. Production must not claim maturity until that source condition exists and all five tests pass.
