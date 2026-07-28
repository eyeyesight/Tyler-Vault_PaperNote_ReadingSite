# Tyler-Vault Reading Site Agent Rules

## Product boundary

- Tyler-Vault on Google Drive is the canonical Markdown source of truth.
- Never write HTML, CSS, JavaScript, JSON, deployment files, ZIPs, mirrors, or runtime state into Tyler-Vault.
- The publication flow is one-way: approved Vault Markdown export → validated build input → generated site.
- Only nodes explicitly listed by the current approved publication manifest may be generated.
- PDFs, Drafts, Queue, Logs, credentials, and unapproved nodes are excluded.
- Prototype fixtures never count as research evidence or production publication units.

## Engineering boundary

- Use tests at public seams: manifest/build CLI, generated artifact contract, browser-visible site behavior.
- Keep schema/content projection separate from visual theme.
- Make deterministic, minimal changes; fail closed on ambiguity.
- Do not deploy, create GitHub remotes, change Vault commands, or change cron jobs without explicit Tyler approval.
- Treat the existing prototype as design evidence, not production architecture or reusable source code.

## Agent skills

### Issue tracker

Local Markdown tickets live under `.scratch/<feature>/issues/`. See `docs/agents/issue-tracker.md`.

### Domain docs

This repo uses a single `CONTEXT.md` and root `docs/adr/`. See `docs/agents/domain.md`.
