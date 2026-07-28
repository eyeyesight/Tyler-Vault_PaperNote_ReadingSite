## T01 — Pin Quartz and establish stable project commands

- **Status:** `done`
- **Source spec:** `specs/tyler-vault-reading-site.md`
- **Scope guard:** local only; no Vault/Drive writes, no remote, no deployment, no Hermes changes

- **Priority:** P0
- **Labels:** `foundation`, `quartz`, `ready-after-approval`
- **Blocked by:** none

### Problem

The ADR chooses Quartz, but the repository has no pinned toolchain or project-owned command surface. Downstream tickets would otherwise call different Quartz commands and create incompatible layouts.

### Scope

Create the minimal Node/TypeScript/Quartz project, lock every dependency, and expose stable project commands for contract preflight, build, verification, and local serve. Use only synthetic non-research content.

### Acceptance criteria

- Lockfile pins Quartz and all transitive dependencies; version is recorded in the build receipt/test output.
- Project-owned scripts define one command each for preflight, build, verify, and local serve; raw Quartz CLI details stay internal.
- A synthetic placeholder build completes locally and is served over HTTP.
- Test proves no command accepts or writes a path under a configured canonical Vault root.
- Type/compile check, focused test, and `git diff --check` pass.

### Non-goals

No manifest semantics beyond a stub, no real Vault content, no visual customization, no deployment.

### Completion evidence

- Pinned Quartz `5.0.0` at `41864a0eba8f95deef7ff3cdede7ae03a45d4c70`; npm lockfile v3 records the exact tarball integrity and transitive dependency graph.
- Tool-computed upstream default `icon.png` SHA-256 is pinned as `532d053e33c2c6bdefdd8145996cedc4be2fc32cfdac740c8488749457d131cf`; every build/serve verifies it before Quartz/sharp or output mutation, and mismatch regression passes.
- Project-owned `preflight`, `build`, `verify`, and `serve` commands exercised with synthetic non-research Markdown. Typecheck and all 90 tests pass.
- Final-review path blocker closed: all four public commands canonicalize Vault/source/output first and reject every equality or ancestor/descendant overlap among all three pairs with `PATH_OVERLAP_NOT_ALLOWED` and zero observed sandbox mutation. Scanner-safe overlap fixtures prove this guard runs before source scanning.
- The source preflight accepts only regular valid UTF-8 `.md`, rejects NUL, non-Markdown files, symlink/reparse escapes, PNG/JPEG/GIF/TIFF/WebP/PDF/ZIP magic under renamed `.md`, every Markdown `![` opener (inline, full/collapsed/shortcut reference, data-URI definition use, and Obsidian), and raw HTML `<img>` before Quartz receives input.
- Final-review verify false-green blocker closed: verification requires exact independent markers in `index.html` and `support-node.html`, non-empty `favicon.ico`, and non-empty valid `static/contentIndex.json` with exact Quartz `index` and `support-node` slug/title identities. Independent negatives cover forged index-only output, missing/damaged pages, missing/empty/invalid/identity-damaged content index, missing/empty favicon, and retained Markdown/PDF rejection.
- Project `serve` builds with pinned Quartz and uses a path-contained Node static server in the wrapper process, bound only to `127.0.0.1`. Quartz's build bootstrap may import the transitive `serve-handler` module, but its HTTP handler is never called, request URIs cannot reach it, and the project static server does not use it.
- Regression tests confirm HTTP `200` plus synthetic markers for `/` and `/support-node`, HEAD `200` with empty body and correct `Content-Length`, POST `405` with `Allow: GET, HEAD`, traversal rejection, and port release after SIGINT, SIGTERM, and direct-parent death without manual cleanup.
- Hermes/automation must directly invoke `node scripts/site.mjs <command>`; npm aliases are interactive convenience only. Parent's real Hermes termination proof for this canonical path reported `DIRECT_PATH_CLOSED_AFTER 0.0` with no orphan, while the npm process layer was proven unsafe for automation termination.
- Windows `netstat -ano -p tcp` confirms the owning PID listens on `127.0.0.1` only (no `0.0.0.0`/`[::]`). Final-review direct build and verify returned `BUILD_OK` and `VERIFY_OK`; direct serve on port 60281 returned GET/HEAD `200`, POST `405`, exact markers/content length, and `PORT_CLOSED` after cleanup.
- `npm audit` currently reports 7 high advisories. T01 accepts the local-only pin with gates: the project preview never calls `serve-handler`'s HTTP handler, source assets cannot reach Quartz/sharp, and public deployment remains blocked pending an approved safe upgrade. The reviewed Quartz pin was preserved (no `npm audit fix`).
