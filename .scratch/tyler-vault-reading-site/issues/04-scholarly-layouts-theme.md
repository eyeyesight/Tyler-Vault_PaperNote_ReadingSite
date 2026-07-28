## T04 — Implement scholarly paper/support layouts and theme

- **Status:** `blocked`
- **Source spec:** `specs/tyler-vault-reading-site.md`
- **Scope guard:** local only; no Vault/Drive writes, no remote, no deployment, no Hermes changes

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
- Mobile 390×844 has no page-level horizontal overflow; when the left Explorer and right table of contents collapse, each remains reachable through an accessible 44 px control and usable drawer; wide tables scroll only inside their container.
- Keyboard focus, semantic headings, reduced motion, 44 px interactive targets, and readable CJK typography pass browser tests.
- Theme-swap fixture preserves routes, graph/search data, heading text/order, stable IDs, source hashes, and content-projection fingerprints.

### Non-goals

No dashboard card stack, animation system, analytics, comments, or PWA.
