## T09 — Lock the GitHub Pages deployment contract

- **Status:** `completed`
- **Source spec:** `specs/tyler-vault-reading-site.md`
- **Scope guard:** read-only GitHub/provider research and local fixtures only; no remote write, repository visibility change, Pages enablement, deployment, Vault/Drive write, or Hermes change

- **Priority:** P0
- **Labels:** `deployment`, `github-pages`, `spike`, `safety`
- **Blocked by:** none

### Problem

The final hosting target is confirmed as a public GitHub repository plus free GitHub Pages, but the exact deployment and public-exposure contracts are not yet locked. Separate agents must not independently choose incompatible branch, artifact, base-path, permission, retention, rollback, or repository-audit semantics.

### Scope

Use current official GitHub documentation and bounded local fixtures to decide and record one deployable contract for the existing project repository. Prefer a GitHub Actions Pages artifact over committing generated real-note HTML to normal source history unless primary-source evidence proves that choice cannot meet the approved requirements.

### Acceptance criteria

- Current first-party GitHub documentation verifies repository visibility and plan requirements, Pages source/deployment method, required workflow permissions, environment behavior, project-site base path, artifact limits/retention, rollback/read-back capabilities, and relevant API failure modes; citations and check date are recorded.
- One architecture decision records the selected delivery mechanism, why generated content is or is not retained in Git history, the expected project-site URL/base path, and the licensing split: identified renderer/theme code is MIT; Tyler-authored content is all rights reserved; third-party quotations and Zotero excerpts retain their original rights and are not relicensed or represented as Tyler-owned.
- A complete private-to-public exposure inventory covers every reachable Git object and ref, branches/tags, Git LFS, submodules, releases/assets, packages, wiki/issues/PR metadata, Actions workflows/logs/artifacts/caches, environments, Pages artifacts, repository metadata, and other GitHub-side surfaces documented by the provider. It defines an allowlist and read-back method for each surface before visibility mutation.
- A local synthetic deployment fixture proves absolute and relative assets, routes, Explorer/search/graph, 404 behavior, and navigation work under the repository project-site base path rather than only at `/`.
- The external lifecycle contract defines deploy input authority, release digest binding, idempotent replay, concurrent/stale deployment rejection, bounded authentication/timeout/429/5xx/partial-failure behavior, last-known-good preservation, and a controlled rollback path.
- The public-exposure gate requires an approved current manifest, a validated sealed local release, zero secret/private-path/PDF/Markdown/unapproved-route/content-rights findings in both source-repository exposure inventory and Pages artifact, and explicit visibility/deployment approval before remote mutation.
- The decision, exposure inventory, and fixture pass an independent contradiction/security review with no open Blocker/High finding.

### Non-goals

No real note, generated real-note HTML, repository visibility, GitHub setting, Actions secret, Pages environment, custom domain, analytics, comment system, or Hermes command is created or changed.

### Local implementation evidence (2026-07-30; ticket status intentionally unchanged)

- Decision and primary-source citations: `docs/adr/0002-github-pages-deployment-and-public-exposure.md`
- Machine contract and complete per-surface allowlist/scan/read-back inventory: `config/github-pages-deployment-contract-v1.json`
- Stable façade plus deep modules: `lib/pages-deployment-contract.mjs`, `lib/verified-sealed-release.mjs`, `lib/pages-provider-lifecycle.mjs`, and `lib/pages-project-site-fixture.mjs`; provider mutation accepts only module-private branded authority minted from T03/T06 trusted filesystem/sealed-custody byte verification, rechecks candidate and LKG bytes immediately before `start`, and preserves one deterministic provider-visible operation, machine-owned policy, pending-safe reconciliation, and capability-bound idempotent rollback.
- Loopback-only fixed-corpus startup-snapshot fixture and synthetic corpus: `lib/pages-project-site-fixture.mjs`, `tests/fixtures/pages-project-site/`
- Public contract tests: `tests/github-pages-deployment-contract.test.mjs`, `tests/verified-sealed-release.test.mjs`
- RED: `node --test tests/github-pages-deployment-contract.test.mjs` failed with `ERR_MODULE_NOT_FOUND` for the not-yet-created implementation.
- GREEN: Parent freshness verification passes typecheck with zero errors, 25/25 Pages contract tests, 13/13 output-verification tests, and the final full repository suite with 397/397 tests passing (0 failed, skipped, cancelled, or todo), plus module syntax checks, JSON parsing, normative-input diff gates, and `git diff --check`. The contract tests cover opaque unforgeable `VerifiedSealedRelease`, T03/T06 custody-backed minting, candidate/LKG byte tamper before mutation, atomic durable provider claims, concurrent and cross-resume one-start convergence, ambiguous claim/start handling, aggregate absolute deadlines, pending stale-generation rejection, canonical rollback custody recovery through replay and the next forward deployment, capability-bound rollback, strict provider-state cloning, zero-trap Proxy rejection, rollback pending expected-active binding, production-only canonical policy, complete exposure catalog, fixed snapshot navigation, HTTP/HEAD/404 behavior, bounded close, and port release.
- Remote effects: none; no active workflow, visibility/settings/API mutation, deployment, commit, or push was performed.
- Independent contradiction/security review: **complete**. Final corrected-scope Standards, Spec, and Security read-backs independently reported all four last findings closed—durable one-start admission, pending stale-generation enforcement, aggregate deadline enforcement, and rollback custody continuity—with **0 open Blocker / High / Medium** and approval to mark T09 completed.
