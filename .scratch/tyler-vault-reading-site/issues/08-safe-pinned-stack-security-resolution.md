## T08 — Resolve the pinned-stack public-deployment security gate

- **Status:** `in-progress`
- **Source spec:** `specs/tyler-vault-reading-site.md`
- **Scope guard:** local dependency/security work only; no real Vault content, Drive write, remote mutation, deployment, repository visibility change, or Hermes change

- **Priority:** P0
- **Labels:** `security`, `dependencies`, `quartz`, `supply-chain`
- **Blocked by:** T07 Zotero marker-only delta validation

### Problem

T01 accepted the pinned Quartz stack only for local use and recorded seven high `npm audit` advisories. Public deployment remains prohibited until an approved safe upgrade or explicit Tyler-approved risk decision closes that gate; a green functional suite alone is insufficient.

### Scope

Map every current advisory to the pinned dependency graph and reachable production/runtime paths, identify an upstream Quartz/dependency pin that closes the public-deployment risk without changing the approved renderer contract, and perform the upgrade test-first. Do not run an unreviewed broad `npm audit fix`.

### Acceptance criteria

- A machine-readable baseline records advisory IDs, severity, dependency path, affected version range, fixed version, production/dev classification, and whether the project invokes the vulnerable path.
- Current primary upstream sources establish one exact Quartz commit and transitive dependency solution; unresolved high/critical production advisories keep this ticket blocked unless Tyler explicitly approves a documented risk exception and corresponding spec revision.
- Quartz, lockfile integrity, toolchain fingerprints, and pinned upstream default-asset hashes are updated together; semver ranges and floating Git refs are absent.
- RED regressions reproduce each reachable risk or the contract boundary that excludes it; GREEN evidence proves the upgraded stack preserves path containment, source/output scans, local serve isolation, release authority, Zotero delta, and last-known-good behavior.
- The complete repository suite, typecheck, production build/verify, and desktop/mobile synthetic browser QA pass on the upgraded stack.
- Final `npm audit`/SBOM read-back and an independent security review report no open Blocker/High public-deployment finding.
- The exact stack used here is the one consumed by the integrated real-note rehearsal; no later ticket silently changes dependencies.

### Non-goals

No Pages workflow, repository visibility change, real note, generated real-note HTML, custom domain, Hermes command, cron change, or unrelated package modernization.

### Current evidence — 2026-07-31

- Tyler accepted the time-bounded project-owned bridge: Quartz exact `507ad7f3d4601d83482f61930fccf1c77f42a072`, root Sharp exact override `0.35.3`, and a checked-in compatibility adapter wrapping exact `brace-expansion@5.0.8`. This is not a claim of upstream Sharp 0.35 support.
- Final-lock full and production-only audit artifacts both report zero findings and are byte/hash-bound in `security/t08-advisory-baseline.json`; canonical CycloneDX evidence is reproduced in two differently named isolated checkouts.
- Parent-run post-#3 focused gates: security **9/9 pass**, Pages contract **25/25 pass**, typecheck, full/production audit zero, fresh merged-lock `npm ci`, production build/verify, and the first failing T05 slice-A acceptance now pass.
- The pre-#3 complete repository suite was **381/381 pass**, 0 fail/cancel/skip. After #3 merged, the first Ubuntu run exposed one cross-platform receipt defect: optional Typst native packages make the complete expanded Quartz tree platform-specific. The fix retains full binary coverage with exact `win32-x64` and `linux-x64` fingerprints; post-merge complete Windows and Ubuntu suites are pending.
- Independent corrected-implementation reviews before the #3 integration were **Spec APPROVE**, **Standards APPROVE**, **Security APPROVE** with 0 open Blocker/High/Medium. The platform-fingerprint delta requires one final narrow security re-review.
- `.github/workflows/t08-pinned-stack.yml` is a read-only Ubuntu PR acceptance gate, not a Pages/deployment workflow. It repeats fresh install, immutable-source checks, audit/SBOM, typecheck, production build/verify, the complete suite, and headless Chromium QA.

### Remaining gate

- Keep status `in-progress` and public rehearsal/deployment blocked until the pull request's Ubuntu acceptance job completes successfully against the exact committed bytes. After that result is read back, update this ticket to `completed`; merge remains Tyler's review decision.
