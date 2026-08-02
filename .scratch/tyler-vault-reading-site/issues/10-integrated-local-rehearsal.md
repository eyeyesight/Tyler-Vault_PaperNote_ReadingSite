## T10 — Run integrated local rehearsal and browser QA

- **Status:** `in-review`
- **Source spec:** `specs/tyler-vault-reading-site.md`
- **Scope guard:** local rehearsal only; no canonical Vault/Drive write, remote mutation, deployment, repository visibility change, or Hermes change

- **Priority:** P0
- **Labels:** `integration`, `qa`, `evidence`
- **Blocked by:** none (T08 completed)

### Problem

Ticket-level tests do not prove the final public-deployment stack preserves publication boundaries and accepted UX with real current structures.

### Scope

Use read-only staged copies of the two eligible integrated notes plus their seven approved direct support pages. Build, validate, serve, and inspect desktop/mobile on exactly the T08 stack. Rehearsal approval/receipt material is explicitly non-deployable and cannot satisfy the formal handoff or public deployment gate. Do not claim maturity.

Architecture authority was amended with Tyler's approval on 2026-08-02: Quartz remains the sole primary renderer, while the repository owns the allowlist-constrained Explorer/search/graph/backlinks projection described by ADR 0001 and the normative specification. T10 closure must include executable conformance tests for that boundary.

### Acceptance criteria

- [x] Full type/test/build/browser suite passes and local HTTP read-back succeeds on the exact T08 pinned stack.
- [x] Exactly the approved real nodes/routes appear; graph endpoint/link leak/PDF/Markdown/secret scans are zero.
- [x] The first 390×844 mobile check proves the collapsed left Explorer and right table of contents remain discoverable, keyboard/touch reachable, and usable through their mobile controls rather than disappearing.
- [x] Desktop/mobile visual evidence proves required masthead, templates, tables, collapsed annotations, search, Explorer, graph, focus, and overflow behavior.
- [x] Source hashes before/after match; canonical Vault/Drive write count is zero.
- [x] Rehearsal manifests, receipts, exports, releases, and screenshots remain in isolated local evidence custody and are labelled non-deployable. T10 does not claim to prove rejection at the not-yet-implemented T11/T12 authority-admission seam; T11 acceptance criterion 8 owns that successor-seam proof before any artifact can become formal input.
- [x] Report explicitly remains `not mature`: only two real integrated papers exist, and synthetic fixtures do not count.

### Review evidence

- Tracked redacted summary: `docs/evidence/t10-integrated-local-rehearsal-redacted.md`
- [x] Independent review: Spec.
- [x] Independent review: Standards.
- [x] Independent review: Security.
- [x] Parent-owned local commit decision.

T10 remains `in-review`, not completed. The tracked summary is non-authoritative and cannot satisfy T11/T12 publication or deployment authority.

### Non-goals

No formal publication authorization, remote write, repository visibility change, or GitHub Pages deployment during T10. This is the required pre-deployment evidence gate, not the final hosting architecture.

### Tyler-approved post-T10 code collaboration handoff

After every T10 acceptance criterion passes and the T10 changes are committed locally, push the code-only feature branch and open a review-gated pull request. This post-completion handoff is not a T10 remote effect.

The PR may contain renderer/theme source, tests, configuration, documentation, and redacted non-authoritative evidence. It must exclude canonical/source Markdown, PDFs, generated real-note HTML/search/graph artifacts, Drive exports, manifests, approval/export/release receipts, runtime state, screenshots containing source content, credentials, and local paths. Do not enable GitHub Pages, change repository visibility/settings, merge the PR, or deploy the site under this authorization.
