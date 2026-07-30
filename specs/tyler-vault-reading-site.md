# Tyler-Vault Generated Reading Site — Production Specification (Draft)

**Status:** Ready for local implementation; renderer ADR and publication contracts passed independent review with no remaining blocking/major finding. Public deployment and Hermes integration remain blocked.

## Problem Statement

Tyler-Vault contains governed, linked research notes whose canonical form is Markdown on Google Drive. Obsidian is effective for authoring and knowledge maintenance, but the current reading experience does not provide a public, cross-device entrance that combines Explorer/search/graph navigation with a calm scholarly paper layout.

A website projection must improve reading without creating a second editable knowledge base, leaking private Vault material, publishing PDFs or operational records, or allowing generated website files to enter Tyler-Vault. The current throwaway prototype validates the visual direction at a ten-node scale, but its custom renderer is disposable and the live Vault has only two eligible integrated papers, so the agreed 3–5-paper maturity gate is not yet met.

## Solution

Build an independent, reproducible static-site system that consumes only an isolated export set named by a Tyler-approved publication manifest. It generates a knowledge entrance, paper pages, support pages, search data, and a public graph into a website repository outside Tyler-Vault.

The system is a one-way projection:

```text
Canonical Drive Vault Markdown (read-only)
  → approved, unexpired, digest-valid publication manifest
  → isolated export set outside the Vault
  → schema/link/privacy preflight
  → reproducible static build in staging
  → static + browser validation
  → atomic promotion of validated output
```

The site adopts the accepted prototype direction:

- Open Neuroscience-inspired Explorer, search, global graph, and content classes.
- Quarto-inspired paper masthead and long-form reading hierarchy.
- A separate, simpler support-node template.
- English controls and template headings; approved note body remains Traditional Chinese.
- A replaceable visual theme that does not change source Markdown or content/schema projection.

No generated website artifact is ever written into Tyler-Vault.

## User Stories

1. As Tyler, I want one knowledge entrance with Explorer, search, and a global graph, so that I can find published research without remembering Vault paths.
2. As Tyler, I want to search by title, author, DOI, keyword, and formal node name, so that I can reopen a paper quickly.
3. As Tyler, I want a paper page to show bibliography, `One-sentence Takeaway`, and `Research Question` before I scroll, so that I can judge relevance immediately.
4. As Tyler, I want long Traditional Chinese research content in a restrained reading column, so that sustained reading is comfortable.
5. As Tyler, I want a table of contents on long pages, so that I can jump directly to method, results, or appraisal.
6. As Tyler, I want wide tables to scroll inside their own region on mobile, so that the whole page never becomes wider than the screen.
7. As Tyler, I want Zotero Annotations available but collapsed by default, so that evidence remains accessible without dominating the reading flow.
8. As Tyler, I want Concept, Method, Task, Author, and other support nodes to use a simple knowledge layout, so that they are not misrepresented as papers.
9. As Tyler, I want backlinks and a local graph on every published node, so that I can follow only approved direct relationships.
10. As Tyler, I want every global-graph edge to connect two published nodes, so that private or unapproved Vault structure cannot leak.
11. As Tyler, I want new papers to require an explicit approved manifest, so that publication remains a human decision.
12. As Tyler, I want a failed or incomplete build to leave the last-known-good site untouched, so that a bad update never replaces a working site.
13. As a site administrator, I want identical inputs under the same pinned stack to preserve routes, public JSON, and semantic content fingerprints, so that meaningful changes are reviewable without claiming byte stability Quartz does not guarantee.
14. As Tyler, I want a theme change to leave source Markdown, routes, and content/schema projection unchanged, while allowing theme assets and approved presentation hooks to change.
15. As Tyler, I want an already-published paper's Zotero managed-block refresh to change only that paper's public page, so that automatic synchronization remains narrowly bounded.
16. As Tyler, I want website files stored only in the independent website repository or hosting system, so that Tyler-Vault remains a clean Markdown knowledge base.
17. As Tyler, I want PDFs, drafts, queues, logs, credentials, runtime state, and unrelated notes excluded by default, so that publication fails safe.
18. As Tyler, I want missing approved fields displayed as absent or `Not stated`, so that the renderer never invents research claims.
19. As a site reader, I want keyboard-visible focus, semantic headings, reduced-motion behavior, and touch-sized controls, so that the site remains accessible.
20. As a site administrator, I want validation evidence and source/output hashes outside the public site, so that releases are auditable without leaking local paths or runtime data.
21. As a future publication command, I want one stable build contract, so that `/vault_papernote_publish` can call the renderer without duplicating selection or safety logic.
22. As Tyler, I want the system to withhold a maturity claim until 3–5 structurally different real integrated papers pass all agreed checks, so that fixture success is not mistaken for production evidence.

## Implementation Decisions

### 1. Repository and ownership boundary

- This website is an independent repository outside Tyler-Vault.
- Tyler-Vault owns canonical Markdown and existing governed Vault material only.
- The website repository owns renderer code, theme code, tests, generated/deployed artifacts, and release evidence.
- No HTML, CSS, JavaScript, search/graph JSON, deployment file, ZIP, site mirror, or website runtime state may be written into Tyler-Vault.
- The renderer never edits source Markdown. It reads an isolated export set and writes only to repository-external staging or the repository's generated-output area.

### 2. Renderer architecture

- Quartz is the sole primary renderer/static-site generator; see `docs/adr/0001-quartz-primary-renderer.md`.
- Quartz owns Obsidian Markdown projection, Explorer/search/navigation, wikilinks, backlinks, graph integration, and static output.
- This repository owns a versioned scholarly theme, paper/support semantic layouts, manifest isolation, deterministic public schemas, and validation.
- Quarto is a visual/document-structure reference only and is not part of the initial runtime.
- The throwaway Python renderer is design evidence only and must not be copied wholesale.
- Quartz and all Node dependencies are lockfile-pinned. An upgrade must rerun the full build, safety, deterministic-diff, and browser compatibility suite.
- Project-owned commands wrap Quartz so upstream CLI changes do not alter the publication contract. Exact command names are fixed by the architecture spike ticket before downstream implementation tickets begin.
- Production maturity remains blocked until 3–5 structurally different real integrated papers pass all five agreed maturity tests; the current two-paper source set may validate mechanics but cannot satisfy maturity.

### 3. Publication manifest contract

The production manifest is the sole publication allowlist and always describes the **complete desired public site**, including previously published nodes that must remain. An action section separately describes the current approved change. It never treats one publication unit as the entire site.

`schemas/publication-manifest-v1.schema.json` is the normative shape contract. JSON Schema validation is necessary but not sufficient; the cross-field, sorting, digest, baseline, path-containment, and set-equation rules in this section are mandatory semantic preflight. Any schema/prose mismatch blocks execution rather than choosing one interpretation.

The manifest is UTF-8 JSON without BOM. Its canonical bytes follow RFC 8785 JSON Canonicalization Scheme (JCS). `plan_digest` is lowercase hex SHA-256 over the JCS-canonicalized publication plan with the top-level `approval_receipt` and `plan_digest` members omitted. The receipt is then added and binds that completed plan digest, avoiding a self-referential hash.

All digest-bound strings must already be Unicode NFC; semantic preflight rejects non-NFC input. The sole total order is lexicographic comparison of the NFC string's UTF-8 bytes as unsigned octets, with a shorter exact prefix sorting first. Nodes and identity projections sort by `public_id`; ID arrays sort by the ID; edges sort by the tuple `(source, target)`; export files and release artifacts sort by normalized relative `path`. No locale-aware, natural, filesystem, or case-folded collation may determine digest order. Semantic preflight rejects any digest-bound array not already in this order.

Required top-level members:

- `schema_version`: integer `1`.
- `manifest_id`: stable identifier matching `^VPUB-[0-9]{8}-[a-z0-9-]+$`.
- `created_at` and `expires_at`: RFC 3339 UTC timestamps using `Z`; validity is the half-open interval `created_at <= now < expires_at`.
- `approval_receipt`: exact upstream approval contract:
  - `approver`: literal `tyler`;
  - `channel`: literal `telegram`;
  - `source_event_id`: non-empty immutable event reference created by the publication orchestrator;
  - `approved_plan_digest`: must equal `plan_digest`;
  - `approved_at`: RFC 3339 UTC timestamp within `[created_at, expires_at)`.
- `action`: one JSON object with exact string `kind`:
  - when `kind` is `publish-unit`, the only additional members are `baseline`, `primary_id`, sorted unique `support_ids`, sorted unique `added_node_ids`, and sorted unique `direct_connection_edges` objects containing only `source` and `target`. `baseline` is either exactly `{ "kind": "genesis" }` or `{ "kind": "release", "release_digest": <sha256>, "receipt_path": <consumed-receipt-path> }`; or
  - when `kind` is `zotero-refresh`, the only additional members are one already-public `target_id`, `baseline_release_digest`, and `baseline_receipt_path`.
- `nodes`: the complete desired public node set, sorted by `public_id`, each containing:
  - immutable `public_id`, matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`;
  - canonical Vault-relative Markdown `path`;
  - fixed `node_class` enum: `paper`, `concept`, `method`, `task`, `author`, `synthesis`, or `map`;
  - `source_sha256`: expected lowercase SHA-256 of exported Markdown.
- `public_set_digest`: lowercase SHA-256 over the JCS-canonicalized sorted identity projection of `nodes`, where each identity contains only `public_id`, `path`, and `node_class`.
- `plan_digest`: digest defined above.

Approval authority and custody:

- Only the future `/vault_papernote_publish` orchestrator may create an approval receipt and place a manifest in the configured publication runtime custody root; the static renderer never claims to authenticate Tyler itself.
- Runtime root contract: environment variable `TYLER_VAULT_PUBLICATION_RUNTIME`; its Windows default is `%LOCALAPPDATA%\hermes\runtime\vault-publication`.
- State directories are exactly `pending/`, `consumed/`, and `rejected/`. Pending manifests are immutable files named `<manifest_id>.json`.
- The orchestrator may execute only when `pending/` contains exactly one schema-valid, currently valid manifest whose approval receipt binds the same `plan_digest`. Zero or more than one candidate fails closed.
- On successful publication, the exact manifest and release receipt move together to `consumed/<manifest_id>/`. A rejected/expired manifest moves to `rejected/<manifest_id>/` with a redacted reason. They are never stored in Tyler-Vault or the public site.
- Authenticating `source_event_id` and creating the receipt belong to the future orchestrator ticket. Renderer tickets accept only the validated receipt fields above and must not invent a second approval mechanism.

Publication-set rules:

- Paths are Vault-relative, forward-slash normalized, cannot be absolute, cannot contain `..`, and cannot point into excluded roots.
- Every `paper` node must be under `Literature/Notes/`, with `type: literature-note` and `status: integrated`.
- Support class roots are fixed: `concept` → `Knowledge/Concepts/`, `method` → `Knowledge/Methods/`, `task` → `Knowledge/Tasks/`, `author` → `Knowledge/Authors/`, `synthesis` → `Literature/Syntheses/`, and `map` → `Literature/Reviews & Maps/`.
- For `publish-unit`, `primary_id` must identify exactly one newly added `paper`. `support_ids` lists every existing or new direct formal support node in this publication unit. Each support ID must have one `primary_id` → `support_id` edge, and no other edge shape is valid in `direct_connection_edges`.
- A direct edge is valid only when the integrated primary's governed `## Connections` section contains a resolvable wikilink to that exact support path; `## Candidate Integrations` never qualifies. Existing unrelated public nodes remain in `nodes` but are not part of the new publication unit.
- With a release baseline, preflight first validates `current-release.json`, resolves its receipt, recomputes that receipt digest, and requires exact three-way equality among the action baseline path/digest, current pointer path/digest, and resolved receipt path/stored/recomputed digest. It then requires: current identities are exactly baseline identities union `added_node_ids`; no baseline identity is removed or reclassified; all baseline source hashes are unchanged; and `added_node_ids` equals the new primary plus any support IDs absent from baseline. With genesis, no `current-release.json` or consumed receipt may exist, and all manifest nodes must equal `added_node_ids`.
- `added_node_ids` may contain the primary and its newly added direct support nodes only. Existing node IDs are invalid in that list; unrelated new nodes are invalid.
- `direct_connection_edges` and generated graph edges may reference only IDs in `nodes`.
- Every exported file hash must equal the manifest hash before rendering.
- Unlisted files in the export root are rejected rather than silently ignored.
- Prototype fixtures and unknown node classes are invalid production nodes. Expanding the enum requires a later spec/ADR change.

### 4. Isolated export contract

- Production build input is a dedicated export directory outside Tyler-Vault.
- The export contains only manifest-listed Markdown plus one machine-readable `export-receipt.json`; initial scope rejects Markdown images, local attachments, and all source binary assets rather than defining an implicit asset-publication lane.
- The receipt follows `schemas/export-receipt-v1.schema.json`; its files are sorted by normalized path and unique by case-insensitive normalized path. It records manifest ID/digest, source hashes, export time, and Drive read-back verification status.
- The renderer rejects an export whose receipt is missing, failed, mismatched, expired, or lists a file not present byte-for-byte.
- Local absolute source paths and credential-shaped values never enter public artifacts.
- Export creation and Drive interaction belong to the future publication orchestration lane, not the static renderer.

### 5. Stable public identity and routes

- `public_id` is immutable after first publication and is not inferred from a changing title.
- Paper route: `/papers/<public_id>/`.
- Support route: `/knowledge/<node-class>/<public_id>/`.
- Home route: `/`.
- Internal links and graph records use these generated routes.
- A wikilink whose target is not in the manifest is emitted only as its source-visible display text, with no `href`, target metadata, search record, backlink, or graph edge. The build writes a redacted suppression count outside the public tree. Ambiguous aliases or path resolution fail preflight instead of guessing.
- Initial scope rejects Markdown image syntax and local attachment embeds before rendering.

### 6. Content projection

- Rendering is deterministic: read existing frontmatter, headings, tables, footnotes, callouts, and wikilinks; do not generate new claims.
- Paper header order: bibliography → `One-sentence Takeaway` → `Research Question` → citation → body.
- `Authors' Discussion` and `Critical Appraisal` remain visually distinct.
- Zotero Annotations render in a closed disclosure element by default.
- Support pages render title, approved body, backlinks, and local graph.
- Missing optional data is omitted or shown as `Not stated`; the renderer never infers DOI, summary, conclusion, or study design.
- Site controls and template headings are English. Approved body content remains byte-derived from the Traditional Chinese source.

### 7. Public graph and search schemas

`graph.json` is versioned and deterministic:

- top-level `schema_version`, `nodes`, and `edges`;
- nodes ordered by `public_id` and contain only `public_id`, title, node class, and public URL;
- edges ordered by `(source, target)`, deduplicated, and emitted only when both IDs are public;
- no Vault absolute paths, unpublished titles, or source snippets.

`search-index.json` is versioned and deterministically ordered:

- records ordered by `public_id`;
- fields are exactly `public_id`, title, node class, public URL, authors, DOI, source tags, and `search_text`;
- `search_text` is derived only from the published title, authors, DOI, source tags, headings, and visible body outside the Zotero managed block; there is no generated excerpt or keyword inference;
- Zotero managed-block text is excluded so a marker-only refresh does not alter search data;
- no raw frontmatter dump, local path, PDF path, attachment reference, or unpublished target metadata.

### 8. Theme contract

- Semantic templates and content extraction are independent from theme tokens and assets.
- Replacing the active theme may change theme assets and approved presentation-only hooks. Source Markdown, routes, heading text/order, stable content IDs, graph/search data, and content-projection fingerprints remain unchanged.
- The selected theme must preserve visible focus, touch controls of at least 44 px where interactive, reduced-motion behavior, readable CJK line height, and contained table scrolling.

### 9. Build, validation, and promotion lifecycle

Public lifecycle actions are:

1. `preflight`: validate the unique pending manifest, approval/export receipts, hashes, schema, privacy boundary, paths, symlinks, links, and excluded roots without changing the current site.
2. `build`: generate a complete candidate site in a new immutable staging directory.
3. `validate`: run route/schema/content-fingerprint checks, source and generated-byte secret scans, plus browser-visible desktop/mobile checks against staging.
4. `promote`: create an immutable validated release and atomically replace the small `current-release.json` pointer only after every check passes. The release hash manifest and pointer remain outside the public tree.

Behavior:

- A rerun with the same manifest, source hashes, pinned renderer, and theme must preserve the route set, public JSON bytes, and content-projection fingerprints. Quartz-generated HTML byte identity is not required.
- The release receipt follows `schemas/release-receipt-v1.schema.json`. Its `nodes` array is sorted by `public_id`; `artifacts` is sorted by public relative `path`; each identity/path is unique; and the receipt file itself is never an artifact.
- Its required `content_fingerprints` array contains exact `{public_id, route, sha256}` records, sorted by unsigned UTF-8 bytes of `public_id`, with at least one unique record and IDs exactly equal to the receipt and manifest node set. Each route is the canonical route for that node class and ID. Each `sha256` is the lowercase SHA-256 of the exact UTF-8 projected Markdown bytes actually handed to Quartz for that node, after privacy, suppression, and backlink projection; it is therefore independent of theme bytes. This is a private, `release_digest`-bound receipt member, not an artifact or separate public/private sidecar.
- `release_digest` is lowercase SHA-256 over RFC 8785 JCS canonical bytes of the complete release receipt with only the top-level `release_digest` member omitted. Loading any baseline requires recomputing this digest and matching both `receipt.release_digest` and the action's baseline digest.
- Public release bytes have immutable root `<releases-root>/<release_digest>/`. Private custody is exactly `<runtime-root>/consumed/<manifest_id>/manifest.json` and `<runtime-root>/consumed/<manifest_id>/release-receipt.json`. Custody `manifest.json` is an exact raw-byte copy of the validated input manifest; `release-receipt.json` and `current-release.json` are UTF-8 RFC 8785 JCS canonical JSON followed by exactly one LF. The pointer remains digest plus receipt path; a consumer locates the public root from its configured releases root plus that digest.
- Release immutability is logical: installation is exclusive, with no overwrite and no in-place mutation. It does not promise ACL enforcement, directory `fsync`, or power-loss durability.
- On a controlled failure before pointer commit, the publisher removes only this attempt's unreferenced release and custody entries; the old pointer and last-known-good release remain bit-identical. Process kill, power loss, and concurrent publishers are non-goals.
- `current-release.json` follows `schemas/current-release-v1.schema.json` and contains only schema version, release digest, and normalized receipt path. Every receipt path is relative to the runtime root and begins with `consumed/`. Every non-genesis action must match this pointer's path and digest exactly; the pointer must match the resolved receipt's stored and recomputed digest before preflight treats it as current or last-known-good. A valid older consumed receipt is still a stale baseline and must be rejected.
- Staging is uniquely named outside the public directory, starts empty, and is discarded after failure.
- Before install, every candidate artifact is read byte-for-byte with ordinary-root containment plus pre-read and post-read metadata checks for file class, path, size, and modification time. The sealed receipt and candidate must have the exact same artifact path/hash set; the receipt itself is never in that set. These checks fail closed within portable filesystem semantics and do not claim resistance to a privileged concurrent writer.
- Every source/export path is normalized; absolute paths, `..`, symlinks/reparse points, duplicate IDs/paths, unsorted contract arrays, and case-insensitive destination collisions are rejected before any copy/build.
- Promotion preserves immutable prior release directories and changes only the validated release pointer. Any failure leaves the pointer and last-known-good release unchanged.
- The generated release contains no Markdown, PDFs, source receipts, local absolute paths, runtime state, or credentials.
- Runtime receipts, release hashes, diagnostics, and failed staging remain outside the public site and Tyler-Vault.
- No automatic retry occurs for approval, schema, digest, hash, path, symlink, collision, secret, or privacy failures.
- Partial output is never promoted.
- Concurrent publication, resumable operations, quarantine retention, remote deployment read-back, and hosting retries belong to the later orchestrator/hosting spec and are not implemented in this renderer slice.

### 10. Zotero managed-block delta

- This lane applies only to an already-published paper explicitly identified by `public_id` and canonical source path.
- `baseline_receipt_path` is normalized relative to the runtime root, must begin with `consumed/`, cannot contain `..`, and must resolve inside that root to a completed prior release receipt.
- `baseline_receipt_path` and `baseline_release_digest` must equal the validated current pointer path/digest and both the recomputed digest and stored `release_digest` of that resolved receipt; the receipt file itself must not appear in its `artifacts` array. Any stale consumed receipt is rejected.
- The trusted baseline receipt stores the prior `public_set_digest`, every prior node `source_sha256`, and, for the target source, marker-count/order plus hashes and encoding metadata defined below.
- The source must contain exactly one correctly ordered Zotero start/end marker pair. Missing, duplicated, nested, reversed, or unclosed markers reject the automatic lane.
- Marker parsing operates on raw bytes. Input must be valid UTF-8 without BOM and use one consistent line ending, either LF (`0A`) or CRLF (`0D0A`); mixed endings reject. Marker lines are exact ASCII literals `<!-- zotero-annotations:start -->` and `<!-- zotero-annotations:end -->`, each beginning at byte 0 or immediately after the chosen line ending and followed by that same line ending.
- Split into five regions: `prefix` (all bytes before the start-marker literal), `start_marker_line` (literal plus its line ending), mutable managed content, `end_marker_line` (literal plus its line ending), and `suffix` (all remaining bytes). Empty prefix, managed content, or suffix is valid and hashes as SHA-256 of empty bytes. Baseline stores hashes for the four immutable regions plus encoding, BOM, line-ending, and literal metadata. Any byte outside managed content, including line endings, must remain unchanged.
- The refresh manifest's `public_set_digest` must equal the baseline. Every node identity and every non-target `source_sha256` must be unchanged; only the target `source_sha256` may differ.
- The source change must be byte-for-byte confined to managed content. The four immutable-region hashes and metadata must match; any other change rejects the automatic lane and returns to a pending publication manifest.
- Zotero ingest/write/validation and a fresh Drive read-back must succeed; the read-back SHA-256 must equal the manifest's expected source hash before site preflight begins.
- The build reuses the existing public node set and routes.
- Among public artifacts, only the corresponding paper page may change. Search, graph, unrelated pages, theme, and navigation must remain byte-identical.
- A no-change delta is silent and does not promote a new release or advance publication state.
- Every test and receipt must prove the website pipeline performed zero writes to Tyler-Vault.

### 11. Privacy, secrets, and licensing

- Preflight rejects PDFs, Markdown copied into generated output, credential files, private-key material, active script/iframe content from Markdown, unsafe URL schemes, absolute local paths, symlinks/reparse-point escapes, and configured secret-shaped fields.
- Secret scanning covers UTF-8 source text and every candidate generated public byte before promotion using the repository-versioned ruleset at `config/public-secret-rules.toml`. The initial mandatory rules cover private-key delimiters, configured high-confidence token prefixes, credential filenames, and Windows/POSIX absolute local paths. A hit blocks promotion and writes only a redacted finding report outside the public tree and Vault.
- A release output allowlist verifies exact generated routes/assets; stale files from a prior build are impossible because staging begins empty.
- Renderer/theme code uses MIT licensing.
- Tyler-authored note content remains all rights reserved unless Tyler decides otherwise.
- Third-party quotations and Zotero annotation excerpts are not relicensed by the code license.

### 12. Hosting boundary

- The initial accepted target remains a public GitHub repository plus free GitHub Pages, but repository creation, remote setup, deployment, public naming, and access policy require a separate Tyler-approved ticket.
- A private repository must never be presented as equivalent to a private website.
- PWA/offline installation, custom domain, analytics, comments, and access-controlled hosting are deferred.

## Testing Decisions

Tests prove observable behavior at three agreed entry points:

1. **Build contract test:** provide a fixed manifest/export fixture to the public build command and assert exact generated routes, graph/search JSON bytes, semantic content fingerprints, links, and exclusions.
2. **Safety lifecycle test:** start with a last-known-good site, inject expired/digest/hash/path/secret/link failures, and prove no public artifact changes; then pass a valid candidate and prove atomic promotion.
3. **Browser acceptance test:** open the generated site in real Chromium at 1440×1100 desktop and 390×844 mobile viewports and verify Explorer/search/graph, the required paper header in the initial desktop viewport, support layout, table containment, collapsed annotations, keyboard focus, and no page-level overflow.

Additional boundary tests:

- Manifest canonicalization and SHA-256 validation use independent literal fixtures.
- Semantic preflight tests reject duplicate `public_id`, duplicate/case-colliding normalized paths, unsorted arrays, absolute/traversal/escaping paths, invalid time order, approval/digest mismatch, class/root mismatch, invalid action edges, and every failed genesis/baseline set equation—even when basic JSON Schema shape passes.
- Literal contract fixtures cover genesis publish, baseline publish, stale-baseline rejection, Zotero refresh, release-digest recomputation, current-release pointer resolution, and LF/CRLF marker-only deltas. The UTF-8 ordering fixture has separately named input/expected/hash vectors for nodes, identity projections, support IDs, added IDs, direct edges, export files, and release artifacts, including full-byte-prefix pairs and non-NFC rejection.
- Every excluded root/file class has a rejection test.
- Every graph edge endpoint must resolve to the public node set.
- Theme swap may change approved theme assets/presentation hooks but preserves routes, graph/search JSON, heading text/order, stable IDs, source hashes, and content-projection fingerprints.
- Zotero marker-only delta changes only one paper page; an outside-marker change is rejected.
- Identical builds preserve routes, graph/search JSON bytes, and content-projection fingerprints; whole-HTML byte identity is not required.
- Public outputs contain no absolute paths, PDF/Markdown files, credential patterns, unapproved routes, or unpublished target metadata.
- The maturity suite reports `not mature` unless 3–5 real integrated papers cover at least three recorded structural categories among empirical, review, methods, and table-heavy. Categories are test-selection metadata, not inferred research claims; a prototype fixture cannot satisfy the count.

Tests observe public CLI/output/browser behavior rather than private parser functions. Lower-level tests are added only where a public failure cannot identify the boundary precisely.

## Out of Scope

- Editing or migrating canonical Tyler-Vault Markdown.
- Writing any generated website artifact into Tyler-Vault.
- Publishing PDFs or Zotero attachments.
- Replacing the current `/vault_paper_*` commands during this implementation slice.
- Implementing `/vault_papernote_publish` before the renderer contract is production-ready.
- Changing the 04:00 Zotero cron or using a fixed-delay website build.
- Creating a GitHub repository, enabling GitHub Pages, deploying publicly, choosing a site name, or setting a custom domain without a separate approval.
- PWA/offline installation, analytics, comments, authentication, or access-controlled hosting.
- AI-generated summaries, rewritten research claims, inferred metadata, or recursive publication of the Vault graph.
- Claiming maturity before 3–5 structurally different real integrated notes pass all five maturity tests.

## Further Notes

- Prototype evidence and reports remain at `C:\Users\Arke\AppData\Local\hermes\prototypes\20260728-tyler-vault-reading-prototype`; they are not production dependencies.
- The production repository is local and has no remote. Local Markdown tickets are used until Tyler approves a tracker.
- The renderer ADR and publication contracts passed independent review; Tyler's prior authorization covers local implementation and sub-agent execution.
- Work is split into tracer-bullet tickets; only dependency-unblocked tickets are dispatched. Public deployment and Hermes integration require separate explicit approval.
