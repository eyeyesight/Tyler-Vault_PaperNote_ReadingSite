# ADR 0001 — Use Quartz as the Primary Site Renderer

- Status: Accepted for the production spike; production maturity remains blocked
- Date: 2026-07-28

## Context

The accepted prototype combines an Open Neuroscience-style knowledge entrance with Quarto-style scholarly paper pages. Tyler-Vault uses Obsidian Markdown, wikilinks, backlinks, formal support nodes, and a public graph derived from an explicit publication allowlist. The generated site must be compatible with static hosting, remain independent from canonical Vault storage, and preserve deterministic theme/content separation.

The throwaway prototype proved the visual direction but used a custom Python renderer that intentionally did not establish production architecture.

## Decision

Requirements outrank implementation choices: the primary renderer is replaceable and is retained only while it continuously satisfies the approved product, privacy, security, readability, and maintenance contract. Quartz may be replaced if a safer or simpler implementation serves that contract better.

Use **Quartz as the sole primary renderer/static-site generator**.

- Quartz owns Obsidian Markdown projection, Explorer/search/navigation, wikilinks, backlinks, graph integration, and static output.
- This repository owns a versioned scholarly theme and two explicit semantic layouts: paper and support node.
- Quarto is a visual and document-structure reference only; it is not part of the initial runtime.
- A manifest adapter creates an isolated Quartz input set outside Tyler-Vault. Quartz never points at or writes into the canonical Vault.
- The repository wraps the renderer behind stable project commands so upstream Quartz CLI details do not become the publication contract.
- Quartz and every Node dependency are pinned by the package lock. Upgrades require the complete compatibility suite.

Pipeline:

```text
Canonical Drive Vault Markdown (read-only)
  → approved manifest and isolated export
  → preflight and manifest adapter
  → Quartz build in immutable staging
  → artifact/browser validation
  → atomic promotion outside Tyler-Vault
```

## Rejected alternatives

### Quarto as the primary site

Rejected because Vault-native wikilinks, backlinks, graph, and Explorer semantics would require substantial custom bridging. Quarto remains a layout reference and may later support a separately approved analytical-document lane.

### Small custom static-site generator

Rejected because the prototype proved UX, not long-term parser/search/graph maintenance. Owning those systems would add cost without improving the approved product contract.

### Quartz plus Quarto in the initial runtime

Rejected because two renderers create route, style, link, and upgrade consistency risk. A second renderer requires its own later ADR.

## Consequences

Positive:

- Uses an ecosystem aligned with Obsidian Markdown and knowledge navigation.
- Concentrates custom work in manifest isolation, page layouts, theme, deterministic public schemas, and validation.
- Produces static output suitable for a later GitHub Pages ticket.

Costs and risks:

- Custom components may break across Quartz upgrades; lockfile and compatibility tests are mandatory.
- Quartz's default behavior may scan more content than allowed; the isolated export boundary and output allowlist must be enforced before promotion.
- Default graph layout may not satisfy deterministic artifact requirements; graph data and layout behavior require an explicit tested adapter.
- Only two real integrated papers currently exist, so structural diversity and the agreed maturity claim remain blocked.
- Public GitHub Pages is valid only for explicitly approved public content.

## Spike acceptance gate

The production spike must prove, without deploying publicly:

1. Quartz consumes only a manifest-derived isolated export and never reads/writes Tyler-Vault directly.
2. Explorer, author/DOI/title search, public graph, wikilinks, backlinks, and stable routes work with zero unresolved or leaked links.
3. Paper and support layouts differ correctly; desktop/mobile, TOC, wide tables, collapsed Zotero, CJK typography, and accessibility checks pass.
4. A theme swap preserves source hashes, routes, public graph/search data, and content-projection fingerprints while allowing approved theme assets/presentation hooks to change.
5. A marker-only Zotero delta changes only the corresponding paper page among public artifacts.
6. Generated output contains only allowlisted routes/assets and every graph edge endpoint is public.

Passing this spike accepts the implementation architecture. It does not satisfy production maturity until 3–5 structurally different real integrated papers pass all five product maturity tests.
