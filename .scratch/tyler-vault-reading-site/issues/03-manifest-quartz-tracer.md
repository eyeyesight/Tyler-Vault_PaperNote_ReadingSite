## T03 — Build the manifest-to-Quartz tracer slice

- **Status:** `done`
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

### Fresh verification evidence (2026-07-29)

- `npm ci`: PASS; 346 packages installed.
- `npm audit --omit=dev`: existing dependency boundary is 7 high and 0 critical advisories.
- Exact-pinned MDAST wave `npm run typecheck`: PASS.
- Focused `npm run test:tracer`: 56/56 PASS before the final nested-opener guard; the final T03 file contributes 58/58 passing tests inside the parent suite (13 top-level plus 45 public-seam subtests), 0 skipped.
- The frontmatter-stripped body is now parsed by exact `mdast-util-from-markdown@2.0.3`; parser/position failure is the stable fail-closed `SOURCE_MARKDOWN_INVALID`. Semantic wikilinks come only from rendered MDAST text-node source slices with exact body offsets. Code, inline code, definitions, Markdown links/references and their labels/titles/destinations, images, and HTML cannot create edges.
- `## Connections` now requires an exact root-level depth-2 heading with one plain `Connections` text child; its range ends at the next root H1/H2. A public preflight positive proves a four-space nested-list continuation support wikilink is semantic and that an unmatched visible backtick does not hide the later real heading/link.
- New public preflight negatives prove an exact support target present only in a multiline reference-definition title or multiline inline-link title fails `DIRECT_CONNECTION_MISSING`, with absent output, unchanged fixture trees, and clean work.
- Source disclaimer evidence now requires an exact root paragraph with one plain text child. Added code-only, list-only, and blockquote-only negatives join frontmatter/reference/link-title negatives and fail `SYNTHETIC_DISCLAIMER_REQUIRED` with zero writes; the generated exact `<p>` gate remains unchanged.
- Markdown local-link inspection now uses MDAST `link` nodes and resolved `linkReference` definitions. Raw HTML is additionally rejected from MDAST `html` nodes while the malformed slash/namespaced regex defense and unsafe-scheme gate remain.
- The disclosure-only all-context wikilink pass remains global, including code, escaped, and hidden metadata. Unlisted nonsemantic targets still require a safe explicit alias and are replaced by exact offsets; listed nonsemantic tokens remain, semantic ranges are deduplicated, and overlaps fail closed.
- The final reviewer-found nested-opener bypass was reproduced red in both code and visible contexts, then closed at the shared parser seam with `SOURCE_NESTED_WIKILINK_NOT_ALLOWED`; both public negatives now pass with zero writes.
- `package.json` and `package-lock.json` retain the exact parser dependency. `npm audit --omit=dev` remains at the existing dependency boundary of 7 high and 0 critical advisories.
- Documentation now names the exact-pinned CommonMark MDAST boundary and retains the narrow raw-HTML accepted subset plus existing CSS scanner, opaque Windows reparse-tag, and privileged filesystem TOCTOU residuals. Quartz vendor assets and normative schemas/specs remain untouched.
- Parent final `npm test`: 224/224 PASS, 0 skipped, in 429.04 s on the Windows runner; `git diff --check` passes and normative `schemas/**` / `specs/**` remain unchanged.
- Independent filesystem/security review and iterative content review findings are resolved. T03 is accepted as done; T04–T07 remain outside this ticket.
