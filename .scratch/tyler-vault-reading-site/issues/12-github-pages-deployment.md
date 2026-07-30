## T12 — Deploy the manifest-approved generated site to GitHub Pages

- **Status:** `blocked`
- **Source spec:** `specs/tyler-vault-reading-site.md`
- **Scope guard:** remote GitHub mutation is permitted only inside this ticket after every blocker and public-exposure gate passes; no canonical Vault/Drive write and no Hermes command/cron change

- **Priority:** P0
- **Labels:** `deployment`, `github-pages`, `publication`, `browser-qa`
- **Blocked by:** T09 GitHub Pages deployment contract; T11 authorized publication-input handoff

### Problem

A local generated site does not give Tyler cross-device viewing or remote theme/code maintenance. The approved final architecture requires the validated allowlisted generated site to be served from the public project repository through free GitHub Pages without publishing canonical Vault Markdown or excluded material.

### Scope

Implement the T09 deployment contract end to end for `eyeyesight/Tyler-Vault_PaperNote_ReadingSite`. Consume only the current T11 authorized handoff and its sealed last-known-good release. The first public deployment requires a final read-back of the approved route/content/rights list and release digest immediately before repository visibility or Pages settings change.

### Acceptance criteria

- Before public mutation, Tyler receives the exact paper/support route list, public-content/rights summary, plan/public-set/release digests, and repository exposure inventory; deployment proceeds only with a still-current explicit approval.
- Before visibility changes, every provider surface identified by T09 is audited and read back: all reachable Git objects/refs, branches/tags, LFS, submodules, releases/assets, packages, wiki/issues/PR metadata, Actions workflows/logs/artifacts/caches, environments, Pages artifacts, repository metadata, and other documented public surfaces. Secret/private-path/Markdown/PDF/unapproved-content/content-rights findings are zero.
- The repository contains the MIT license/renderer-theme boundary plus NOTICE/README language stating Tyler-authored note content is all rights reserved and third-party quotations/Zotero excerpts retain their original rights, are not relicensed by MIT, and are not represented as Tyler-owned.
- GitHub Pages deploys only the T11 validated generated HTML, search, graph, theme assets, and required static assets through the T09 mechanism; canonical Vault Markdown, PDFs, Drafts, Queue, Logs, credentials, runtime receipts, local paths, and unapproved nodes are absent.
- GitHub API read-back proves repository visibility, Pages source/workflow, deployment environment/status, deployed commit/release binding, and expected project-site URL without exposing credentials.
- Desktop and 390×844 mobile browser QA against the real Pages URL proves homepage, every approved paper/support route, Explorer, search, global/local graph, table of contents, collapsed annotations, keyboard/touch controls, wide tables, focus, and overflow behavior.
- HTTP and content scans prove expected routes return successfully; broken links, leaked graph endpoints, Markdown/PDF/private-link/local-path/secret findings, content-rights mislabelling, and unapproved routes are zero.
- Both a synthetic pre-mutation rejection and the T09 provider-seam matrix for authentication failure, timeout, 429, 5xx, and partial deployment prove the old deployed digest/bytes remain last known good; normal replay of the same release is idempotent.
- A controlled provider-equivalent rollback/read-back proves recovery to a previously approved deployed digest. Rollback requires the same exact route/content/rights/digest approval gate and cannot bypass publication approval.
- Canonical source hashes before/after match and Vault/Drive write count is zero.
- A concise remote-maintenance guide documents: edit canonical Markdown on Drive, approve a publication manifest, build/validate, deploy, review GitHub PR/theme changes, inspect Pages status, and execute an approved rollback.

### Non-goals

No custom domain, PWA/offline mode, analytics, comments, access-controlled hosting, PDF publication, direct HTML editing workflow, `/vault_papernote_publish` UI command, Telegram command rename, cron change, or broad publication beyond the approved manifest.
