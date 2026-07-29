## T08 — Run integrated local rehearsal and browser QA

- **Status:** `blocked`
- **Source spec:** `specs/tyler-vault-reading-site.md`
- **Scope guard:** local only; no Vault/Drive writes, no remote, no deployment, no Hermes changes

- **Priority:** P0
- **Labels:** `integration`, `qa`, `evidence`
- **Blocked by:** T05, T06, T07

### Problem

Ticket-level tests do not prove the integrated site preserves publication boundaries and accepted UX with real current structures.

### Scope

Use read-only staged copies of the two eligible integrated notes plus their seven approved direct support pages. Build, validate, serve, and inspect desktop/mobile. Do not claim maturity.

### Acceptance criteria

- Full type/test/build/browser suite passes and local HTTP read-back succeeds.
- Exactly the approved real nodes/routes appear; graph endpoint/link leak/PDF/Markdown/secret scans are zero.
- The first 390×844 mobile check proves the collapsed left Explorer and right table of contents remain discoverable, keyboard/touch reachable, and usable through their mobile controls rather than disappearing.
- Desktop/mobile visual evidence proves required masthead, templates, tables, collapsed annotations, search, Explorer, graph, focus, and overflow behavior.
- Source hashes before/after match; canonical Vault/Drive write count is zero.
- Report explicitly remains `not mature`: only two real integrated papers exist, and synthetic fixtures do not count.

### Non-goals

No public GitHub repository or deployment.
