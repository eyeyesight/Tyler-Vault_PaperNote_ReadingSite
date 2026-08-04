# Tyler-Vault Reading Site — Ticket Breakdown Proposal

**Status:** T01–T11 local product, sealed-release custody, and handoff work are complete. T12 repository-only implementation is active on the approved dedicated `gh-pages` transport; repository visibility, Pages settings, environment approval, and first live deployment remain separately approval-gated. T13 remains start-gated.

## Feature summary

Build a production-oriented Quartz static reading site outside Tyler-Vault. It consumes only a validated manifest/export, renders approved paper/support nodes, produces safe public search/graph data, preserves last-known-good sealed releases, and proves the accepted desktop/mobile reading behavior. T12 projects one verified sealed release into an isolated `gh-pages` candidate without writing Tyler-Vault; no repository visibility mutation, Pages setting change, live deployment, command rename, or cron change occurs before its dedicated gate.

## Dependency graph

```text
T01 Quartz scaffold and stable project commands
  └─ T02 Publication contract engine
       └─ T03 Manifest-to-Quartz tracer slice
            ├─ T04 Scholarly paper/support UI
            │    └─ T05 Explorer/search/graph/link policy
            ├─ T06 Release safety and last-known-good
            └─ T07 Zotero marker-only delta
                  
T04 + T05 + T06 + T07
  └─ T08 Integrated local rehearsal and QA

Continuation after the completed local product tickets:
T11 Verified sealed release and publication handoff (complete and merged)
  └─ T12 Dedicated gh-pages candidate, exact-SHA workflow, and live Pages gates
       └─ T13 Hermes command rename and /vault_papernote_publish integration (start-gated)
```

Only dependency-unblocked tickets may run. Concurrent writers must own disjoint modules or separate worktrees; agents do not commit, reset, clean, or deploy.

---

## T01 — Pin Quartz and establish stable project commands

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

---

## T02 — Implement publication contract engine

- **Priority:** P0
- **Labels:** `foundation`, `security`, `contracts`
- **Blocked by:** T01

### Problem

JSON shape validation alone cannot prove approval binding, JCS digests, path containment, complete public-set equations, release baselines, sorting, or uniqueness.

### Scope

Implement schema loading plus semantic preflight for manifest, export receipt, release receipt, and current-release pointer. Implement RFC 8785 JCS digest checks and the exact genesis/release/Zotero baseline rules from the spec.

### Acceptance criteria

- RED→GREEN tests cover all files under `specs/examples/` and reject schema/prose negative cases.
- Reject duplicate IDs, duplicate/case-colliding paths, unsorted arrays, absolute/traversal/symlink escapes, invalid times, approval mismatch, digest mismatch, class/root mismatch, invalid action edges, and failed set equations.
- Recompute and verify `plan_digest`, `public_set_digest`, `release_digest`, baseline receipt equality, and export/source hashes.
- Enforce NFC plus unsigned UTF-8 byte ordering for every digest-bound array and reject alternate/locale ordering. Tests must directly load every named vector in `specs/fixtures/utf8-ordering-v1.json`: nodes, identity projection, support IDs, added IDs, direct edges, export files, and release artifacts, including prefix-first cases.
- Genesis works only without current release; every non-genesis baseline path/digest must equal the validated current pointer and recomputed current receipt; a stale valid receipt is rejected. Release baseline preserves all prior identities/source hashes and adds exactly the approved unit.
- Public CLI returns stable machine-readable error codes and performs zero source/output mutation on preflight failure.

### Non-goals

No Quartz rendering, no Telegram approval creation, no Drive access.

---

## T03 — Build the manifest-to-Quartz tracer slice

- **Priority:** P0
- **Labels:** `vertical-slice`, `quartz`, `renderer`
- **Blocked by:** T01, T02

### Problem

The chosen architecture is not proven until a validated allowlist can become a minimal Quartz site without scanning the canonical Vault or publishing unlisted nodes.

### Scope

Create an isolated manifest adapter and render one synthetic paper plus one synthetic support node through Quartz.

### Acceptance criteria

- Preflight copies only manifest-listed Markdown from the isolated export into a fresh renderer input; unlisted files fail closed.
- Generated routes are exactly `/`, `/papers/<id>/`, and `/knowledge/<class>/<id>/` for the fixture.
- Wikilink/backlink resolution works between the two approved nodes; unlisted links produce display text only and no public target metadata.
- Generated output contains no Markdown, PDFs, source receipts, absolute paths, or fixture claims presented as research evidence.
- Source fixture hashes remain unchanged; configured canonical Vault write count is zero.

### Non-goals

No final theme, full Explorer/search/graph, release promotion, or real research content.

---

## T04 — Implement scholarly paper/support layouts and theme

- **Priority:** P1
- **Labels:** `frontend`, `accessibility`, `theme`
- **Blocked by:** T03

### Problem

Quartz defaults do not implement the accepted Quarto-inspired paper masthead, separate support template, restrained CJK reading layout, and responsive behavior.

### Scope

Implement paper/support semantic layouts and the quiet scholarly theme while keeping content projection independent from presentation.

### Acceptance criteria

- Desktop 1440×1100 shows bibliography, `One-sentence Takeaway`, and `Research Question` in the initial viewport.
- Paper and support nodes use different templates; Zotero Annotations are collapsed by default.
- Mobile 390×844 has no page-level horizontal overflow; wide tables scroll only inside their container.
- Keyboard focus, semantic headings, reduced motion, 44 px interactive targets, and readable CJK typography pass browser tests.
- Theme-swap fixture preserves routes, graph/search data, heading text/order, stable IDs, source hashes, and content-projection fingerprints.

### Non-goals

No dashboard card stack, animation system, analytics, comments, or PWA.

---

## T05 — Add Explorer, search, public graph, backlinks, and link suppression

- **Priority:** P1
- **Labels:** `navigation`, `search`, `graph`
- **Blocked by:** T04

### Problem

The product needs an Open Neuroscience-style knowledge entrance without exposing unapproved targets or relying on fixed prototype graph coordinates.

### Scope

Implement versioned deterministic public search/graph data, Explorer classes, local/global graph, backlinks, and exact unlisted-link suppression behavior.

### Acceptance criteria

- Search supports title, authors, DOI, source tags, headings, and visible body outside Zotero annotations.
- Graph/search records match the exact spec schemas and deterministic ordering.
- Every edge endpoint resolves to a public node; unlisted targets create no href, target metadata, search record, backlink, or graph node.
- Layout scales beyond fixed ten-node coordinates and has no label clipping/overlap in agreed desktop/mobile fixtures.
- Search by Jackman DOI returns one paper; `flow` fixture returns its expected approved records.

### Non-goals

No recursive Vault graph, AI summaries, ranking model, or publication of unrelated formal pages.

---

## T06 — Implement safe releases and last-known-good protection

- **Priority:** P0
- **Labels:** `security`, `release`, `reliability`
- **Blocked by:** T02, T03

### Problem

A direct or partial build must never replace a valid local release, and candidate bytes must be scanned before promotion.

### Scope

Implement empty immutable staging, output allowlist, release receipt/digest, content fingerprints, versioned secret rules, immutable release directories, and atomic current-release pointer replacement.

### Acceptance criteria

- Valid candidate creates a schema-valid receipt whose recomputed `release_digest` matches; receipt is not in artifacts.
- Expired/digest/hash/path/link/secret/output failures leave the prior pointer and release bytes unchanged.
- Candidate public tree contains no Markdown/PDF/source receipts/runtime data/local paths/credentials.
- Stale prior files cannot survive because staging starts empty and exact output allowlist is checked.
- Valid promotion changes only `current-release.json` after release verification; failure never changes it.

### Non-goals

No remote deployment, hosting retry, resumable operation journal, quarantine retention, or concurrent publication.

---

## T07 — Implement Zotero marker-only delta validation

- **Priority:** P0
- **Labels:** `zotero`, `safety`, `delta`
- **Blocked by:** T02, T03

### Problem

Automatic site refresh is allowed only when one already-published paper changes inside its unique managed Zotero block.

### Scope

Implement raw-byte marker parsing, baseline receipt comparison, complete public-set/source checks, and page-only artifact-diff enforcement.

### Acceptance criteria

- LF and CRLF literal fixtures pass when only managed content changes.
- BOM, mixed EOL, duplicate/reversed/missing markers, marker-line changes, prefix/suffix changes, and non-target source changes reject.
- Baseline receipt path/digest/current pointer all resolve to and verify the same release; stale consumed receipts reject even when internally valid.
- Public set and all non-target source hashes remain unchanged.
- A valid delta changes only the target paper page; search, graph, navigation, theme, and unrelated page hashes remain unchanged.

### Non-goals

No Zotero API call, Vault write, cron change, or failed-build retry.

---

## T08 — Run integrated local rehearsal and browser QA

- **Priority:** P0
- **Labels:** `integration`, `qa`, `evidence`
- **Blocked by:** T04, T05, T06, T07

### Problem

Ticket-level tests do not prove the integrated site preserves publication boundaries and accepted UX with real current structures.

### Scope

Use read-only staged copies of the two eligible integrated notes plus their seven approved direct support pages. Build, validate, serve, and inspect desktop/mobile. Do not claim maturity.

### Acceptance criteria

- Full type/test/build/browser suite passes and local HTTP read-back succeeds.
- Exactly the approved real nodes/routes appear; graph endpoint/link leak/PDF/Markdown/secret scans are zero.
- Desktop/mobile visual evidence proves required masthead, templates, tables, collapsed annotations, search, Explorer, graph, focus, and overflow behavior.
- Source hashes before/after match; canonical Vault/Drive write count is zero.
- Report explicitly remains `not mature`: only two real integrated papers exist, and synthetic fixtures do not count.

### Non-goals

No public GitHub repository or deployment.

---

## T12/T13 continuation

### T12 — Dedicated `gh-pages` candidate and GitHub Pages deployment

T12 keeps source, tools, contracts, and the thin workflow on `main`; approved generated bytes exist only in the dedicated `refs/heads/gh-pages` publication history. A local opaque `VerifiedSealedRelease` is revalidated and projected exact-byte into a fresh candidate whose root is exactly `site/` plus `.publication/`. The prepare CLI requires the exact `--source-root` flag; the operator-supplied canonical source-tree root is trusted authority for the source boundary, and the candidate output root must be disjoint from it and from runtime/release custody. Candidate metadata contains no source-root path. Its failed-attempt cleanup is best-effort, non-recursive `rmdir` after immediate no-link and dev/ino checks under a trusted parent/output staging-root assumption; it does not claim resistance to a compromised or cooperating same-user writer or absolute atomic replacement safety. `site/` contains only the sealed public inventory plus controlled `.nojekyll`; `.publication/gh-pages-candidate-v1.json` binds release, artifact, manifest, receipt, rights authority, expected URL, and site inventory/digest. The finalized visibility audit is added as `.publication/github-launch-audit-v1.json`; workflow upload contains only verifier-staged `site/` bytes.

The default-branch workflow is manual-only (`workflow_dispatch`) and requires three exact inputs: lowercase 40-hex `site_commit`, lowercase 64-hex `candidate_digest`, and lowercase 64-hex `launch_audit_digest`. It hard-fails before candidate use unless the workflow ref is `refs/heads/main` and the repository default branch is `main`. Its validation job proves the commit is contained in `refs/heads/gh-pages`, verifies branch metadata against both GitHub-authenticated expected digests, verifies the finalized launch audit, and stages an exact site-only upload. Only then may the deploy job enter the protected `github-pages` environment. Arke, in the operator role, prepares/pushes and dispatches with the shared GitHub account `eyeyesight`; Tyler, in the approver role, records the separate visibility approval before public mutation and, only after validate plus exact digest comparison, approves the `github-pages` environment for the specific workflow run. GitHub records both roles as `eyeyesight`. Tyler correlates `workflow_run_id`, `run_started_at`, `environment_reviewed_at`, and the Telegram decision reference; these are operational correlation, not cryptographic identity proof. Self-review prevention is disabled while the required reviewer/environment approval remains. Account compromise can collapse both events. Provider IDs/readback and anonymous browser QA are required after provider success; unknown outcomes are reconciled through provider readback, not custom claims or blind retries.

Remaining live gates are real GitHub settings/readback, creation and push of the actual `gh-pages` commit, authenticated visibility audit and approval, workflow dispatch, Tyler's environment approval, provider deployment/readback, and anonymous browser QA. Repository-only tests must not claim any of those have happened.

### T13 — Hermes command rename and publication orchestration

T13 is blocked until T12 closes and Tyler explicitly starts the rebaselined Tickets 16–19. It owns the Hermes command/menu surface, candidate preview and Telegram content confirmation, durable run state, exact `gh-pages` handoff, workflow-run/approval link, provider readback, and final user report. Telegram approval authorizes candidate content only; it never substitutes for Tyler's GitHub `github-pages` environment approval and the plugin must not hold Tyler's GitHub user credential. Zotero-triggered automatic Pages deployment, Telegram rollback, custom deployment authority/claims, Draft Release transport, and unresealed branch hotfixes are outside T13 v1.

## Execution waves

1. **Local implementation foundation/product/integration (complete):** T01–T08.
2. **GitHub-native contract and legacy-lifecycle deletion (complete):** Wave A/B2 removed the superseded collector/custom lifecycle without claiming remote success.
3. **Verified sealed release and handoff (complete):** T11.
4. **Dedicated branch implementation (current Wave C):** machine contract/schema, sealed-release candidate/verifier, thin workflow, runbook, focused tests, Main integration, independent review, and full suite.
5. **T12 live gates:** visibility approval/readback and the exact Pages deployment approval remain separate Tyler decisions; then provider/browser QA and PR/CI/merge/final readback.
6. **T13:** stop after T12 and wait for Tyler's explicit start authorization before changing production Hermes/plugin/Gateway behavior.

## Execution decision

Tyler previously authorized continuation and sub-agent execution. Arke selected the least-risk default rather than requiring Tyler to interpret engineering tickets:

- preserve the completed T01–T11 evidence and execute only the repository-authorized T12 Wave C work before live approval gates;
- keep repository visibility, Pages deployment, and T13 Hermes integration separately gated;
- escalate only costs, public release, permissions, destructive actions, or research judgment;
- report Telegram progress in plain language: protection provided, result, and whether Tyler must act.
