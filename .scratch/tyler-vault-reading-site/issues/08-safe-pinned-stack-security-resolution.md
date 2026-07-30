## T08 — Resolve the pinned-stack public-deployment security gate

- **Status:** `blocked`
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
