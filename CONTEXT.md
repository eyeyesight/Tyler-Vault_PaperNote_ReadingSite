# Domain Context

## Product

A generated public reading layer for the Tyler-Vault research notes explicitly listed in the tracked content map. It provides a home/knowledge entrance, search, public graph navigation, scholarly paper pages, and support-node pages.

## Authority and ownership

- **Canonical source:** Tyler-Vault Markdown on Google Drive; it is the only editable research source and is read-only during every repository build.
- **Content authority:** [`site-content.yml`](site-content.yml) is the only inclusion and route authority. Its current nine `source` / `route` / `layout` entries are the verified baseline, not a permanent cardinality. Routine publication may form one bounded private proposal for eligible new pages, but the build never consumes discovery directly or uses a second registry.
- **Map-before-build contract:** Freeze one exact immutable map snapshot before preflight/build; preflight, build, preview, the mapping-only change, and approval use those exact bytes. Existing mappings/routes are immutable; a removal or rewrite stops for manual review. Proposal generation is deterministic, bounded, one-hop where applicable, uses no LLM, and keeps the Vault read-only.
- **T13 ownership:** Remaining fixed-nine code/test hits in `lib/slim-content-map.mjs`, `scripts/prepare-gh-pages-commit.mjs`, `tests/slim-build.test.mjs`, and `tests/prepare-gh-pages-commit.test.mjs` are intentionally T03-owned (T13-03); T13-01 changes these governance documents only.
- **Presentation source:** project-owned paper/support templates and theme, applied by one full build.
- **Public output:** regenerated HTML, CSS, JavaScript, JSON, and provider support files outside Tyler-Vault.

## Active build and handoff

```text
Canonical Vault (read-only)
  → site-content.yml
  → npm run slim:preflight / npm run slim:build
  → public projection and mapped-route/privacy checks
  → npm run gh-pages:prepare
  → exact gh-pages commit
  → workflow_dispatch(site_commit)
  → GitHub Pages
```

The slim build uses a temporary public snapshot and removes it after the build. The local handoff compares a built site with a supplied gh-pages baseline, reports added/deleted/changed/unchanged files and mapped routes, and creates a fresh `site/` preview. The workflow does not build or mutate site bytes; it deploys the exact checked-out `site_commit`.

## Public surface

The current baseline public routes are `/` plus the routes in [`site-content.yml`](site-content.yml). The map currently contains nine content entries; that count is not a permanent cardinality:

- `/papers/guo-2024-benchmarking-micro-action-recognition/`
- `/papers/jackman-2021-flow-clutch-recreational-running/`
- `/knowledge/author/patricia-c-jackman/`
- `/knowledge/concept/flow/`
- `/knowledge/concept/micro-action/`
- `/knowledge/method/connecting-analysis/`
- `/knowledge/method/event-focused-interview/`
- `/knowledge/method/thematic-analysis/`
- `/knowledge/task/action-recognition/`

Paper pages use the public bibliographic projection and the paper template. Support pages use the support template. Search, graph, Explorer, backlinks, and content-index data are derived from the same mapped public set.

## Privacy and safety

Only mapped Markdown and explicitly public projected fields may enter generated output. Workflow-only frontmatter, private identifiers, Zotero-local values, PDFs, credentials, local paths, drafts, queues, logs, and unlisted graph targets stay out of the public tree. Source, temporary snapshot, work, and output roots must be disjoint. A source/build/handoff failure must not write back to the canonical Vault.

## Deployment boundary

Generated site bytes belong on the `gh-pages` content branch; build, presentation, tests, configuration, and workflow stay on the source branch. [`deploy-pages.yml`](.github/workflows/deploy-pages.yml) is manual-only, accepts exactly lowercase 40-hex `site_commit`, verifies that commit and the required `index.html`, `404.html`, and empty `.nojekyll`, then uploads only `candidate/site`. Provider approval and live smoke checks remain GitHub/operator actions, not a repository-owned replacement state machine.

## Verification

```bash
npm run typecheck
npm run test:slim
npm run test:gh-pages
node --test tests/security-stack.test.mjs
npm test
```

See [`docs/quartz-toolchain.md`](docs/quartz-toolchain.md) for pinned installation and build facts. Do not treat synthetic fixtures as research evidence or claim production maturity from fixture-only results.
