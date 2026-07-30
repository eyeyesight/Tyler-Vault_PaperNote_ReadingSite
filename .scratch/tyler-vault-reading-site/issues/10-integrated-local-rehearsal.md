## T10 — Run integrated local rehearsal and browser QA

- **Status:** `blocked`
- **Source spec:** `specs/tyler-vault-reading-site.md`
- **Scope guard:** local rehearsal only; no canonical Vault/Drive write, remote mutation, deployment, repository visibility change, or Hermes change

- **Priority:** P0
- **Labels:** `integration`, `qa`, `evidence`
- **Blocked by:** T08 safe pinned-stack security resolution

### Problem

Ticket-level tests do not prove the final public-deployment stack preserves publication boundaries and accepted UX with real current structures.

### Scope

Use read-only staged copies of the two eligible integrated notes plus their seven approved direct support pages. Build, validate, serve, and inspect desktop/mobile on exactly the T08 stack. Rehearsal approval/receipt material is explicitly non-deployable and cannot satisfy the formal handoff or public deployment gate. Do not claim maturity.

### Acceptance criteria

- Full type/test/build/browser suite passes and local HTTP read-back succeeds on the exact T08 pinned stack.
- Exactly the approved real nodes/routes appear; graph endpoint/link leak/PDF/Markdown/secret scans are zero.
- The first 390×844 mobile check proves the collapsed left Explorer and right table of contents remain discoverable, keyboard/touch reachable, and usable through their mobile controls rather than disappearing.
- Desktop/mobile visual evidence proves required masthead, templates, tables, collapsed annotations, search, Explorer, graph, focus, and overflow behavior.
- Source hashes before/after match; canonical Vault/Drive write count is zero.
- Rehearsal manifests, receipts, exports, releases, and screenshots remain in isolated local evidence custody, are labelled non-deployable, and are rejected if presented as T11/T12 production authority.
- Report explicitly remains `not mature`: only two real integrated papers exist, and synthetic fixtures do not count.

### Non-goals

No formal publication authorization, remote write, repository visibility change, or GitHub Pages deployment during T10. This is the required pre-deployment evidence gate, not the final hosting architecture.
