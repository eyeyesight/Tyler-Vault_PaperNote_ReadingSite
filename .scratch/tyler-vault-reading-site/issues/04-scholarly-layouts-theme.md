## T04 — Implement scholarly paper/support layouts and theme

- **Status:** `completed`
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

### Evidence (2026-07-29)

- RED: the first public Edge regression found no readable desktop Explorer routes (`actual: []`) and generic mobile `Paper` / `Support` labels; drawer isolation then found a closed Explorer at `display: block`.
- RED: independent review found vendor ToC opacity below readable contrast, no mobile ToC Escape/focus return, route-CSS-only template proof, a self-authenticating renderer baseline that could miss config drift, and CSS parser bypasses involving comments, spaced quoted imports, and escaped URL schemes.
- GREEN: `npm run typecheck` and `npm run test:theme` pass; the latter is 13/13 including three semantic-template negatives, config quote-drift, five fixed prebaseline boundary subtests, theme-swap preservation, unique fixed CSP artifacts, and real Edge acceptance under CSP.
- Browser evidence now verifies fully opaque high-contrast ToC links, source-derived Explorer titles, English controls, CJK font/line-height and visible glyph rect, visible focus outlines, 44 px controls and drawer links, both drawers' Escape/focus return, viewport/overflow/table containment, reduced motion, and renderer-owned `data-tracer-template` markers.
- Toolchain trust is pinned before build by deterministic per-directory UTF-8-sorted depth-first regular-file tree digests for `@jackyzha0/quartz` (310 files) and `@quartz-community` (495 files); config transforms require unique matches and postconditions. A fixed prebaseline gate rejects deferred T05 index/graph/search artifacts and actual external resource loads before the immutable candidate baseline.
- T04 theme-swap evidence preserves the **absence** of graph/search/content-index artifacts together with routes, headings, links, source snapshots, and article fingerprints. This is the deliberate T04/T05 boundary, not a claim that T05 graph/search data already exists; non-vacuous data-preservation tests remain T05 work.
- Final visual captures (not repository artifacts): `C:\Users\Arke\AppData\Local\Temp\t04-final-visual-g8f481gk\t04-desktop-1440x1100.png`, `t04-mobile-toc-390x844.png`, and `t04-mobile-explorer-390x844.png` in the same directory. Parent vision review found no blocker or major.
- Edge was spawned only with `--headless=new`, `--disable-gpu`, `windowsHide: true`, and a temporary profile; latest reviewer PID `1264` exited and its profile was removed.
- `npm test` passes 237/237 with zero failures/skips; `git diff --check` and the protected-tree diff (`schemas specs examples fixtures`) pass. Final independent CSS/CSP review found no blocker, major, or minor and reproduced zero external requests under the exact CSP.
