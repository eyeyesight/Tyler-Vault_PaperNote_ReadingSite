## T11 — Produce an authorized publication-input handoff

- **Status:** `blocked`
- **Source spec:** `specs/tyler-vault-reading-site.md`
- **Scope guard:** minimum headless authorization/export handoff only; no public deployment, repository visibility change, Pages enablement, Telegram command/UI rename, cron change, or canonical Vault/Drive write

- **Priority:** P0
- **Labels:** `orchestration`, `approval`, `export`, `custody`
- **Blocked by:** T10 integrated local rehearsal

### Problem

The renderer correctly refuses to invent Tyler approval, but T12 cannot deploy without a legally produced current manifest, authenticated approval receipt, export receipt, and sealed last-known-good release. Rehearsal fixtures are not production authority.

### Scope

Build and exercise the minimum headless publication-input handoff that authenticates a still-current Tyler approval event, creates the exact approved manifest/receipt in runtime custody, performs a read-only Drive export with receipt, and produces one sealed validated local release for T12. This is the backend authority seam later callable by `/vault_papernote_publish`; it does not add or rename Hermes/Telegram commands.

### Acceptance criteria

- Tyler receives the exact paper/support route list, content summary, rights notice, and plan digest and explicitly approves that complete public set; the handoff binds an immutable authenticated source event ID and rejects stale, ambiguous, mismatched, or replayed approval.
- The headless authority seam is the sole creator of the production approval receipt and pending manifest; the renderer cannot self-approve, and zero/multiple/expired/digest-mismatched pending manifests reject before export or build.
- Drive interaction is read-only and exports exactly the manifest paths into isolated custody. An export receipt records normalized relative path, class/public ID, source SHA-256, count reconciliation, and complete/partial status; partial or mismatched export cannot become formal input.
- The public release seam consumes that exact manifest/export, validates the T08 pinned stack and all publication contracts, seals a local release, atomically advances current only on success, and moves the exact manifest/receipt together to consumed custody.
- The handoff output exposes only the manifest ID, plan/public-set/release digests, exact approved route list, sealed release location/receipt reference, and redacted verification status needed by T12; credentials, canonical local paths, raw approval content, and runtime internals are excluded.
- Idempotent replay returns the same authority/result without duplicate export/release; stale or conflicting release/current-pointer state rejects and preserves last known good.
- Secret/private-path/PDF/Markdown/unapproved-route/graph/content-rights findings are zero, source hashes before/after match, and canonical Vault/Drive write count is zero.
- Independent authority/security review finds no open Blocker/High and proves T10 rehearsal artifacts cannot substitute for this handoff.

### Non-goals

No Pages deployment, public repository mutation, custom domain, Telegram command addition/rename, cron change, automatic note selection, PDF publication, or broad publication beyond Tyler's exact approved manifest.
