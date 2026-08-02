# T10 integrated local rehearsal — redacted evidence summary

## Scope and authority

- **Status label:** review evidence for T10 only.
- **Maturity label:** **not mature**.
- **Authority label:** **non-authoritative, non-deployable local rehearsal evidence**.
- This summary covers a code-only PR evidence slice. It does not contain or confer T11 publication-input authority or T12 publication/deployment authority. The existing T10 safe-release negative control proves only plan-digest binding; it is not evidence that a future T11 provenance-authentication seam rejects rehearsal custody. That successor-seam proof remains mandatory under T11 acceptance criterion 8.
- It is not a publication approval, release receipt, deployment record, GitHub/Pages mutation record, or formal evidence package.
- Canonical/source Markdown, paper or support-page text, screenshots, raw Drive identifiers, modified times, local paths, Drive exports, manifests, receipts, releases, runtime state, generated real-site files, credentials, and custody-artifact references are intentionally outside this tracked summary. The underlying real-source evidence remains in isolated local custody.

## Rehearsal input and generated surface

The read-only rehearsal used the currently eligible integrated source set:

- 2 real integrated papers;
- 7 approved direct support pages;
- 9 real source nodes in total;
- 10 generated routes, including the site entry route;
- 37 generated files.

Synthetic fixtures were used only for engineering coverage and do **not** increase the real-source count or establish maturity.

## Automated suites

| Verification slice | Result | Duration |
| --- | ---: | ---: |
| Manifest/browser suite | 135/135 PASS | 989040.076 ms |
| Safe-release suite | 95/95 PASS | 1257254.3973 ms |
| Full repository suite | 471/471 PASS | 2512604.3161 ms |

The exact repository commands were:

```text
node --test tests/manifest-quartz-tracer.test.mjs
node --test tests/safe-release.test.mjs
npm test
npm run typecheck
node --check lib/zotero-public-projection.mjs
node --check scripts/tracer.mjs
git diff --check
```

All seven commands passed on the final review slice. Focused current-byte public-seam coverage also passed: managed-block-external Zotero disclosure cases 14/14, exact private-frontmatter compatibility and rejection matrix 7/7, current/legacy writer-dialect matrix 21/21, and candidate/projection cases 12/12. The isolated real-source tracer build exited 0 with 9 nodes, 10 routes, 37 files, `suppressionCount=0`, and independent generated-output scans of 0 Zotero schemes, annotation markers, writer metadata rows, `zotero_uri` fields, Markdown files, and PDFs.

### Current-byte and environment binding

- Fixed review point and test-time `HEAD`: `838b52a8383078353f7d4a5986d0667f05945fc0`.
- Runtime: Node `v22.23.0`; npm `10.9.8`; Microsoft Edge `150.0.4078.105`; Quartz `5.0.0`, pinned to repository commit `507ad7f3d4601d83482f61930fccf1c77f42a072`.
- The sorted 10-file T10 review-slice manifest has SHA-256 `e2c7326decf3a2d6e0f145eabfc007671ce400ec2a91f9a4e1c8a69e6be3243b`. It binds the current bytes of the T10 ticket, output allowlist, renderer ADR, navigation module, Zotero validation/projection module, tracer, normative specification, scholarly styles, manifest/browser tests, and safe-release tests. This evidence summary is deliberately excluded to avoid self-reference.
- The current native-Enter closure report separately binds the production-file SHA-256 values and records an unchanged dirty-worktree status across its run. A post-run read-back matched every bound production file to the current bytes.
- The worktree remained intentionally dirty and nothing was staged during verification. T11/T12/T13 planning paths and mixed `CONTEXT.md` changes are outside this T10 review-slice binding and must not be blanket-staged.

The fresh local rebuild reproduced 10 routes and 37 files.

## Real browser and local HTTP outcomes

The real-source rehearsal exercised a 390×844 mobile viewport and the integrated local site:

- 10/10 expected routes returned HTTP 200;
- 385 browser requests produced 0 non-200 responses;
- console errors: 0;
- uncaught errors: 0;
- window errors: 0;
- Explorer, search, internal links, backlinks, global graph, local graph, Zotero/annotation collapse behavior, and page overflow checks passed;
- native CDP Tab and Enter events changed the mobile Explorer and table-of-contents expanded state through the production handlers;
- the browser error audit persisted across desktop/mobile home, paper, and support navigation and detected injected later-page console errors and uncaught exceptions in its negative controls;
- the combined browser result passed with no blocker.

All 11 real tables fit within the 358 px content width. Every table wrapper had `overflow-x: auto`. A fitting table correctly has no positive horizontal scroll range; the first report incorrectly treated the absence of such a range as a failure even though the table fit. The supplemental closure therefore classifies the result as PASS: fitting tables remain fully visible, while their wrappers retain horizontal overflow handling for content that actually exceeds the container.

## Same-object Drive read-back and write safety

The supplemental closure reconciled the fresh rebuild against the same 9 baseline Drive objects without recording their identifiers in tracked evidence:

- all 9 object identities and modified-time values matched the baseline;
- metadata, downloaded bytes, per-object SHA-256 values, and aggregate values matched;
- Drive operations were `get=9`, `download=9`, `search=0`, and `write_total=0`;
- source/write-safety reconciliation passed with no blocker.

The first report's pre-rebuild snapshot predated capture of the Drive identity and modified-time fields. Its raw overall FAIL was limited to that missing-before-snapshot comparison and the incorrect table scroll-range classification described above. The supplemental closure rechecked those points and returned overall PASS.

## Cleanup

Cleanup found 0 owned processes remaining. No deployment, repository visibility change, GitHub/Pages mutation, canonical Vault/Drive write, or production authority action was performed.

## Redacted provenance handles

These SHA-256 values identify the repo-external reports without tracking their paths or contents:

- first real-validation report: `fe606d8e2d8c4d784c11c86c4c75c2d9f83df137dfc87c99fc8e39fb98fe4f3d`;
- supplemental closure report: `107c17d3caac9fdddf9b1e51d370d80c4dd0b8e08a0ac7e92c2f4fc126e55ef8`;
- final current-working-tree native-Enter closure v3: `9f3c679b277b7ce5ffea3760fb3a22764e2090333b578c48e8e2c12eb8da4270`.

Earlier current-byte reports v1 (`15a19ff1d727d4174746d7a1cc330c7b13e44ed774350b87c3086261454b3320`) and v2 (`9119baf04e71fcf2ac8cb02b91fbc5a5a100ac4db5e2cee59c9cb84b5eb74013`) were superseded by later source hardening and are not closure authority.

## Known limitation and next gate

This rehearsal remains **not mature** because the real integrated corpus contains only 2 papers plus 7 direct support pages. Passing synthetic fixtures and the integrated local rehearsal does not broaden that corpus and does not authorize publication.

Independent Spec, Standards, and Security closure review found no open blocker or high-severity finding in the final T10 slice. The next gate is the parent-owned local commit decision. Until that decision and the separate T11/T12 authority gates occur, this evidence must remain non-authoritative and must not be used to publish or deploy anything.
