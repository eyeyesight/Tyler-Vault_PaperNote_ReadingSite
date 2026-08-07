# Tyler-Vault Reading Site

A slim static reading layer for the explicitly mapped Tyler-Vault research notes. The repository owns the build, project templates/theme, public metadata projection, local handoff, and GitHub Pages workflow; the canonical Vault remains read-only.

## Active path

The only supported product path is:

```text
read-only Tyler-Vault Markdown
  → site-content.yml (the tracked nine-entry source/route/layout map)
  → scripts/slim-build.mjs
  → local public-output and privacy checks
  → scripts/prepare-gh-pages-commit.mjs
  → exact gh-pages commit
  → .github/workflows/deploy-pages.yml (site_commit)
```

`site-content.yml` is the inclusion boundary. It contains two paper pages and seven support pages. The build does not discover folders or infer routes from titles. It snapshots only mapped Markdown, projects the public metadata needed by the site, and never writes into the Vault.

The local handoff prints the mapped-route proof and the file diff against a supplied gh-pages baseline. It creates a fresh local `site/` preview; it does not push, deploy, or create a second publication state. The Pages workflow is manual-only, accepts exactly `site_commit`, verifies that exact commit and the required site files, and uploads `candidate/site` without rebuilding.

## Public routes and privacy

The home route is `/`. The nine mapped content routes are:

- `/papers/guo-2024-benchmarking-micro-action-recognition/`
- `/papers/jackman-2021-flow-clutch-recreational-running/`
- `/knowledge/author/patricia-c-jackman/`
- `/knowledge/concept/flow/`
- `/knowledge/concept/micro-action/`
- `/knowledge/method/connecting-analysis/`
- `/knowledge/method/event-focused-interview/`
- `/knowledge/method/thematic-analysis/`
- `/knowledge/task/action-recognition/`

Only mapped Markdown and its public projection may reach generated output. Workflow-only frontmatter, private identifiers, Zotero-local values, PDFs, credentials, local paths, drafts, queues, logs, and unlisted nodes are excluded. Generated output, temporary snapshots, and handoff staging stay outside the canonical Vault.

## Requirements

- Node.js 22 or newer
- npm 10.9.2 or newer

## Commands

Run from the repository root. `slim:preflight` and `slim:build` require a canonical Vault root supplied through `TYLER_VAULT_ROOT` or `--vault-root`.

```bash
npm ci
npm run slim:preflight -- --vault-root 'C:/absolute/canonical-vault'
npm run slim:build -- --vault-root 'C:/absolute/canonical-vault'
npm run gh-pages:prepare -- \
  --built-site '.artifacts/slim-site' \
  --baseline-site 'C:/absolute/gh-pages-copy' \
  --output '.artifacts/gh-pages-preview'
```

The `gh-pages:prepare` output contains the local `site/` preview and the route/file diff for human review before any separately authorized repository operation.

## Verification

```bash
npm run typecheck
npm run test:slim
npm run test:gh-pages
node --test tests/security-stack.test.mjs
npm test
node --check scripts/slim-build.mjs
node --check scripts/prepare-gh-pages-commit.mjs
node --check scripts/tracer.mjs
git diff --check
```

See [`AGENTS.md`](AGENTS.md), [`CONTEXT.md`](CONTEXT.md), [`site-content.yml`](site-content.yml), and [`docs/quartz-toolchain.md`](docs/quartz-toolchain.md) for the current boundaries and toolchain facts. The exact workflow is [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml).
