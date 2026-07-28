## T01 — Pin Quartz and establish stable project commands

- **Status:** `ready-for-agent`
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
