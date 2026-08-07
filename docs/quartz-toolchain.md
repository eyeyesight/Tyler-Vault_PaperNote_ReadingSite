# Pinned Quartz toolchain

Quartz is the renderer used by the active slim build. The project wrapper owns the content map, public projection, templates/theme, privacy checks, and local gh-pages handoff; Quartz remains an implementation dependency rather than a second command surface.

## Pin and installation

- `package.json` pins Quartz to the GitHub tarball for commit `507ad7f3d4601d83482f61930fccf1c77f42a072` (`5.0.0`).
- `package-lock.json` records the tarball integrity and the complete dependency graph. Use `npm ci` for a reproducible install; do not replace the lockfile with a floating Quartz install.
- The required runtime is Node.js 22 or newer with npm 10.9.2 or newer.
- `config/quartz-toolchain.json` records the pinned default icon SHA-256 and complete installed Quartz / Quartz Community tree fingerprints for the supported platforms. The active renderer checks those bytes before materializing or running Quartz.
- The temporary Sharp and brace-expansion compatibility decision is documented separately in [`docs/adr/0003-temporary-pinned-stack-bridge.md`](adr/0003-temporary-pinned-stack-bridge.md). It is dependency evidence, not a site-content or deployment authority.

## Active build commands

Run from the repository root. The canonical source root must be supplied through `TYLER_VAULT_ROOT` or `--vault-root`; the wrapper rejects a missing root and rejects overlap between Vault, work, snapshot, and output paths.

```bash
npm ci
npm run slim:preflight -- --vault-root 'C:/absolute/canonical-vault'
npm run slim:build -- --vault-root 'C:/absolute/canonical-vault'
```

`slim-build.mjs` reads the exact tracked `site-content.yml`, snapshots its nine mapped Markdown files into temporary work space, calls the pinned Quartz renderer through the active renderer helper, applies the project-owned paper/support templates and theme, writes the local generated output, and removes the temporary snapshot. It must not write to the canonical Vault.

The local exact-commit handoff is a separate wrapper:

```bash
npm run gh-pages:prepare -- \
  --built-site '.artifacts/slim-site' \
  --baseline-site 'C:/absolute/gh-pages-copy' \
  --output '.artifacts/gh-pages-preview'
```

It requires ordinary, disjoint built/baseline/output directories, checks every mapped route plus `404.html`, rejects private or hidden public files, copies a fresh local `site/` tree, adds an empty `.nojekyll`, and reports the byte/file diff. It does not contact GitHub or mutate the baseline.

## Verification commands

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

The Pages workflow is [`../.github/workflows/deploy-pages.yml`](../.github/workflows/deploy-pages.yml). It accepts only the exact `site_commit`, checks out that commit, verifies the gh-pages ancestry and required site files, and uploads `candidate/site` without rebuilding.
