# Tyler-Vault Reading Site Agent Rules

## Product boundary

- Tyler-Vault on Google Drive is the canonical Markdown source of truth and is always read-only to this repository.
- `site-content.yml` is the only tracked inclusion and route authority for the slim site. Its current nine `source` / `route` / `layout` mappings are a verified baseline, not a permanent cardinality. Routine publication may prepare one bounded private proposal for eligible new pages, but the build must never read directly from discovery or infer routes from titles.
- The proposal is frozen as one exact immutable map snapshot before preflight/build; preflight, build, preview, the mapping-only change, and approval consume those exact bytes. Existing mappings/routes are never rewritten or removed; route removal stops for manual review.
- Bounded proposal generation is deterministic, reads only approved bounded Vault inputs, follows at most one Knowledge hop where applicable, uses no LLM, and never writes to the Vault; every repository build remains read-only to the Vault.
- `scripts/slim-build.mjs` snapshots only mapped Markdown, applies the public metadata projection, and generates the mapped public site without writing to the Vault.
- Never write HTML, CSS, JavaScript, JSON, deployment files, ZIPs, mirrors, or runtime state into Tyler-Vault.
- Public output excludes workflow-only metadata, private identifiers, Zotero-local values, PDFs, credentials, local paths, drafts, queues, logs, and unlisted nodes.

## Active engineering seam

- Build and preflight: `npm run slim:preflight -- --vault-root <path>` and `npm run slim:build -- --vault-root <path>`.
- Local gh-pages handoff: `npm run gh-pages:prepare -- --built-site <path> --baseline-site <path> --output <path>`.
- Deployment handoff: `.github/workflows/deploy-pages.yml` is manual-only and accepts the exact `site_commit` input. It checks out that commit from gh-pages, verifies the site shape, and uploads the exact `candidate/site` tree.
- Keep the slim path as one build and one exact-commit handoff. Do not restore a parallel approval, receipt, digest, custody, or release layer.
- T13-01 changes governance prose only. Remaining fixed-nine code/test seams in `lib/slim-content-map.mjs`, `scripts/prepare-gh-pages-commit.mjs`, `tests/slim-build.test.mjs`, and `tests/prepare-gh-pages-commit.test.mjs` are owned by T03 (T13-03); do not migrate them in this ticket.
- Make deterministic, minimal changes; fail closed on ambiguous mappings, unsafe source paths, private output, missing routes, and invalid handoff roots.

## Verification

Use the public seams and run the relevant checks after changes:

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

Do not deploy, create GitHub remotes, change Vault commands, or change cron jobs without explicit Tyler approval. Do not write to Vault/Drive, gh-pages, or another worktree from this repository task.

## Repository documentation

- Read [`CONTEXT.md`](CONTEXT.md) for the current product vocabulary and fixed boundaries.
- Read [`docs/quartz-toolchain.md`](docs/quartz-toolchain.md) for the pinned Quartz installation and build facts.
- `docs/agents/domain.md` and `docs/agents/issue-tracker.md` describe repository-agent mechanics; they are not product authorities.
