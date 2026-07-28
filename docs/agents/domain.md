# Domain Documentation

Layout: **single-context**.

Agents must read, in order:

1. Root `AGENTS.md` for safety and product boundaries.
2. Root `CONTEXT.md` for shared vocabulary and external contracts.
3. Relevant records under `docs/adr/` before changing an architectural decision.
4. The governing spec and the assigned local ticket.

Do not create per-package context documents unless the repository becomes a genuine multi-package system and Tyler approves the added human surface.
