# ADR-0002: GitHub Pages deployment and public exposure responsibility boundary

- **Status:** accepted — Wave C gh-pages branch implementation
- **Date:** 2026-08-04
- **Owners:** Tyler Vault Reading Site maintainers
- **Decision type:** public-content, repository-control-plane, and deployment-plane contract

## Decision summary

GitHub is the control plane and deployment plane for this project. Generated site bytes are tracked only on `refs/heads/gh-pages`, while the workflow definition remains on `refs/heads/main`. The public website is the `site/` directory at the root of `gh-pages`; the same commit carries sealed candidate metadata at `.publication/gh-pages-candidate-v1.json` and the finalized visibility launch audit at `.publication/github-launch-audit-v1.json`.

The delivery method is `gh-pages-branch-to-pages-artifact`. A deploy-capable run is started only by `workflow_dispatch` from the workflow on `main`, while the repository default branch is also `main`. It must receive an exact 40-hex `site_commit` plus exact 64-hex `candidate_digest` and `launch_audit_digest` expected values. Pull requests and pushes never publish. Validation first proves that `site_commit` belongs to `refs/heads/gh-pages`, compares the branch metadata and finalized audit with the two GitHub-authenticated expected digests, and uploads only `site/`. The deploy job enters the protected `github-pages` environment only after validation.

Those responsibilities are intentionally separate:

1. **Public content audit (project-owned):** decide whether the exact sealed site bytes, candidate metadata, manifest, receipt, rights, and bounded one-time launch-audit evidence are fit for public exposure.
2. **GitHub control plane (GitHub-native):** enforce collaborators, merge rules, rulesets/branch protection, Actions permissions, environment reviewers, Pages settings, and provider-visible governance.
3. **Deployment plane (GitHub-native):** run the manual workflow, wait for the `github-pages` environment approval, serialize runs with GitHub Actions concurrency, deploy the Pages artifact, and expose provider deployment IDs/status.

The machine-readable contract is [`config/github-pages-deployment-contract-v1.json`](../../config/github-pages-deployment-contract-v1.json), validated by [`config/github-pages-deployment-contract-v1.schema.json`](../../config/github-pages-deployment-contract-v1.schema.json). This ADR is its human-readable authority. The existing 31-surface catalog is retained only as a superseded migration reference.

The local prepare CLI is part of the candidate handoff boundary. It requires the exact `--source-root` flag: the operator supplies the canonical source-tree root as the trusted source authority, and the candidate output root must be disjoint from that root as well as from sealed runtime/release custody. The source-root path is not emitted into candidate metadata.

### Single-account operating roles

The repository and deployment path use one GitHub account, `eyeyesight`. Arke is the logical operator role for preparing the exact candidate, pushing the isolated `gh-pages` commit, and dispatching the workflow. Tyler is the logical approver role: Tyler records the visibility decision before the repository/public content mutation, then reviews the specific validated workflow run and approves the `github-pages` environment deployment after comparing the fixed summary with the approved exact digests. These are two separate human decisions at separate lifecycle points; they are not two GitHub identities.

GitHub records both roles as `eyeyesight`. Tyler correlates `workflow_run_id`, `run_started_at`, `environment_reviewed_at`, and the Telegram decision reference with the exact SHA, candidate digest, launch-audit digest, validation summary, and provider readback. Run/approval times and Telegram are operator correlation evidence, not cryptographic proof of Arke/Tyler identity separation.

## Context

The earlier design attempted to make a project-owned opaque evidence/capability chain behave like a provider transaction. It coupled a 31-surface exposure inventory to four uniform evidence lanes, treated an opaque `VerifiedSealedRelease` capability as deployment authority, and specified a custom atomic claim/one-start lifecycle. Those guarantees cannot be made authoritative over GitHub's collaborators, rulesets, environment approvals, Actions scheduler, Pages provider, or cached/forked views.

The Wave C decision keeps the useful content controls but assigns each decision to the system that can actually enforce it. It uses an immutable commit on the dedicated `gh-pages` content branch as the provider-accessible site source, while retaining sealed project custody and rights evidence. It does not call GitHub, DNS, or a live Pages site as part of this repository change, and it never records credentials in an audit or example.

## Normative source map

The following references are formal sources for this boundary:

| Source | Role after Wave C |
| --- | --- |
| This ADR | Human-readable responsibility boundary and lifecycle decision |
| `config/github-pages-deployment-contract-v1.json` | Active machine-readable gh-pages branch deployment contract |
| `config/github-pages-deployment-contract-v1.schema.json` | Schema for the active deployment contract |
| `config/github-launch-audit-v1.schema.json` | Schema for the one-time, human-readable, hashable launch audit |
| `specs/examples/github-launch-audit-v1.example.json` | Non-live, valid example of the launch-audit shape and digest rule |
| `config/public-output-allowlist-v1.json` | Project allowlist for public output paths/bytes |
| `schemas/current-release-v1.schema.json` and `schemas/release-receipt-v1.schema.json` | Release/receipt identity and sealed-artifact records |
| `specs/tyler-vault-reading-site.md` | Reading-site output, branch layout, route, and hosting requirements |
| `docs/publication-contract-engine.md` and `docs/manifest-quartz-tracer.md` | Project publication/manifest and renderer provenance inputs |
| `config/github-provider-public-exposure-catalog-v1.json` and its schema | **Superseded** historical 31-surface reference; never a deploy gate or deploy authority |

A document may explain these contracts, but it must not promote a superseded source back to deployment authority.

## Public content audit

### Required project-owned inputs

Before the repository is made public, the project records:

- the approved public-output allowlist;
- the exact sealed artifact digest and sorted byte inventory;
- the release manifest, receipt, and rights disposition digests;
- the one-time launch audit, finalized after post-visibility repository readback; and
- the human visibility approval recorded in that launch audit.

Unknown rights or an unapproved output unit blocks publication. A content audit does not grant repository write permission, merge permission, the `github-pages` environment approval, or Pages-provider authority. Deployment approval is recorded only by the protected GitHub environment in the deployment receipt.

### One-time launch audit

The launch audit is one complete, human-readable JSON record conforming to `github-launch-audit-v1.schema.json`. It is written once for the repository visibility boundary, finalized only after the post-visibility readback, retained with the sealed release receipt, and identified by SHA-256 over canonical JSON with the `audit_digest` member omitted. The record includes a human-readable summary, scope, evidence locators, findings, limitations, and the visibility approval only. It contains no deployment approval and no Pages post-deploy QA result.

The audit scope is bounded and reproducible:

- **Pre-visibility audit:** inspect the local mirror, allowlist, sealed artifact, byte inventory, manifest, and rights;
- **Visibility approval:** record the human approval before the repository visibility mutation;
- **Post-visibility readback:** use one authenticated machine lane (`gh api --paginate` or an equivalent authenticated GitHub API) for repository/API readback, optionally corroborate it in the authenticated UI, and perform anonymous repository readback; and
- **Finalize:** retain all evidence and compute the final `audit_digest` over the complete record with that member omitted.

Pages deployment approval and Pages post-deploy anonymous/browser QA belong to the later deployment lifecycle, not to this launch audit.

The audit must state its limitation plainly. Known clones, cached views, and unknown external copies may be recorded when observed, but their absence is **not provable**, is **not a zero gate**, and must not be converted into a custom deploy failure condition. The bounded audit gates what the project and authenticated GitHub control plane can inspect; it does not claim universal deletion or universal absence.

## GitHub control plane

The following are GitHub-native controls and are not reimplemented in project library code:

- collaborators, teams, and repository roles;
- protected default branch rulesets/branch protection, required reviews, and required checks;
- Actions workflow/job permissions and action pinning policy;
- Pages source/build-type configuration;
- the `github-pages` environment and required reviewers, with self-review prevention disabled for the shared `eyeyesight` account; and
- repository/organization Actions secret and variable metadata without exposing secret values.

Use one authenticated machine evidence lane: `gh api --paginate` is accepted, as is an equivalent authenticated GitHub API client. Pagination is required for list endpoints. UI evidence is optional human-readable corroboration only and does not create a second required machine lane. GitHub's current settings and provider responses remain authoritative for this plane.

## GitHub deployment plane

The deployment is a GitHub Actions Pages-artifact workflow, not a project-owned provider transaction.

### Workflow contract

The workflow file is `.github/workflows/deploy-pages.yml`:

- `workflow_dispatch` is its only trigger; there is no `push`, `pull_request`, schedule, repository-dispatch, or other automatic-publication trigger;
- required `site_commit`, `candidate_digest`, and `launch_audit_digest` inputs are exact lowercase hexadecimal values; the validation job proves that the commit is contained in `refs/heads/gh-pages` and the two expected digests match the verified branch bytes;
- the workflow hard-fails before candidate use unless both its dispatch ref and the repository default branch are `main`;
- the validation job verifies `.publication/gh-pages-candidate-v1.json`, requires and validates `.publication/github-launch-audit-v1.json`, binds that audit to the same sealed artifact, and stages an exact site-only copy;
- only verifier-staged `site/` is passed to `actions/upload-pages-artifact`; `.publication/` is not served;
- the deploy job needs `validate`, executes only after the `github-pages` environment required reviewer approves, and invokes `actions/deploy-pages` only with that validated Pages artifact; and
- neither job builds Quartz, mutates candidate bytes, emits invented manifest/rights outputs, or issues a custom provider claim.

The minimum provider permissions are `contents: read`, `pages: write`, and `id-token: write`, declared at the narrowest applicable workflow/job scope. GitHub evaluates and enforces those permissions.

### Environment approval and concurrency

The `github-pages` environment retains required reviewers. Because Arke and Tyler operate through the same `eyeyesight` account, self-review prevention is disabled; the environment review remains the only deployment approval, and GitHub environment/deployment records are authoritative for it.

The immutable sealed receipt is not rewritten. The environment review is distinct from the human visibility approval recorded in the launch audit: Tyler records visibility approval before the repository/public-content mutation, while Tyler reviews and approves the specific environment run only after validation and exact digest comparison. Tyler compares the workflow summary's `candidate_digest` and `launch_audit_digest` with the Telegram/out-of-band decision record and correlates `workflow_run_id`, `run_started_at`, and `environment_reviewed_at` before approving. GitHub records both decisions under `eyeyesight`; the correlation evidence does not create account-level identity separation.

If the `eyeyesight` account or its credential is compromised, the same account can initiate and approve both separate human decisions. This is an explicit limitation, not a reason to weaken exact-SHA, candidate/site-inventory, manifest/receipt, rights, provider-readback, or post-deploy QA controls.

The concurrency group is `github-pages` with `cancel-in-progress: false`, owned by GitHub Actions. A timeout or unknown provider result is reconciled by reading back the same workflow run and deployment objects; the workflow does not infer failure and blindly submit a second mutation.

### Provider deployment-ID lifecycle

The provider lifecycle is recorded using GitHub-native identifiers:

1. the workflow run records its source `commit_sha`, `workflow_run_id`, `run_attempt`, and exact `site_commit` input; the verifier validates candidate/site inventory and digests, manifest/receipt hashes, approved rights-authority projection, and launch-audit digest without declaring nonexistent GitHub job outputs;
2. the Pages artifact is uploaded once for that workflow run;
3. the deploy job waits for the environment approval and runs `actions/deploy-pages`;
4. GitHub's Pages provider record supplies `actions_artifact_id`, `deployment_id`, `deployment_status_id`, and `environment_url` (where exposed); and
5. the operator reads back those records and published bytes, then retains provider evidence and anonymous/browser QA alongside sealed custody and launch evidence without mutating the sealed receipt.

A later retry is a new workflow run with new provider IDs and the normal checks/approval policy. There is no custom atomic claim, custom exactly-once/one-start promise, or opaque capability that is authoritative for GitHub.

### Local candidate preparation cleanup boundary

Candidate preparation and site-only staging use best-effort cleanup of their own fresh output child. The parent and output staging root are trusted against cooperating same-user replacement during cleanup. Cleanup checks no-link ancestry and matching device/inode identity immediately before a non-recursive `rmdir` of the checked empty directory. This is not an atomic handle-bound deletion and does not claim resistance to a compromised or cooperating same-user writer replacing the path after those checks; the project must not describe it as absolute atomic replacement safety or broaden it to recursive deletion.

## Sealed artifact, rights, approvals, and QA retained

Wave C does not weaken the project-owned content controls:

- the sealed artifact hash and sorted byte inventory remain mandatory;
- release manifest/receipt hashes and the approved rights-authority projection remain bound to the artifact without inventing a separate rights digest;
- unknown rights or unapproved units remain blocking;
- visibility and deployment remain two separate human approvals; and
- provider success is insufficient until anonymous HTTP/browser QA checks the expected URL, base path, representative routes, custom 404, served bytes, deployment status, and rights/output invariants.

## Superseded decisions

The following are explicitly **superseded** and have no deployment authority:

1. the 31-surface public-exposure inventory as an active four-lane gate;
2. the uniform four-lane/opaque capability evidence chain;
3. the opaque `VerifiedSealedRelease` capability as a provider deploy input;
4. a custom atomic claim, custom exactly-once claim, or one-start lifecycle; and
5. custom provider operation/claim IDs as the source of deployment truth.

The old catalog is retained only as a historical/reference-only record. The active contract must not contain `public_exposure_inventory` as an executable gate. The superseded project-owned lifecycle/provider implementation is no longer present.

## Migration and Wave C

Wave B2 lifecycle deletion is complete in this repository snapshot. The removed legacy paths are `lib/pages-provider-lifecycle.mjs`, `tests/support/scripted-local-pages-provider.mjs`, and the four untracked Exposure experimental files (`lib/github-public-exposure-gate.mjs`, `lib/github-readonly-evidence-transport.mjs`, `tests/github-public-exposure-gate.test.mjs`, and `tests/github-readonly-evidence-transport.test.mjs`). The retained `lib/pages-deployment-contract.mjs` is a local Pages façade only; verified release/publication/safe-release custody remains outside the deleted legacy-lifecycle boundary.

Wave C now supplies the repository-side adapter from an opaque verified sealed release to an exact `gh-pages` candidate, the candidate verifier/staging CLI, and the thin manual workflow. It does **not** claim the live branch, remote environment/ruleset/Pages configuration, authenticated launch audit, either human approval, provider deployment/readback, or independent post-deploy QA. No remote mutation occurs in this repository-only implementation gate; those remain explicit live gates rather than missing local code.

## Consequences

### Positive

- Public-content decisions are auditable without pretending to control external copies.
- GitHub's actual control and deployment state is authoritative where GitHub can enforce it.
- Sealed artifact hashes, rights, separate approvals, and post-deploy QA remain strong project gates.
- Provider IDs and retries are observable through native workflow/deployment records.

### Costs and limitations

- A bounded launch audit cannot prove that all external clones or caches are absent.
- A real launch still requires human configuration/review in GitHub's remote control plane.
- A shared `eyeyesight` account records both Arke and Tyler roles as one GitHub actor; run IDs, timestamps, and Telegram references correlate the decisions but cannot prove account-level role separation, and account compromise can collapse both approval boundaries.
- Wave B2 removed the old implementation rather than preserving two competing deployment authorities; Wave C's exact-branch verifier/workflow preserves that boundary.

## Non-goals

- No live GitHub, DNS, credential, or remote mutation in this repository change.
- No custom evidence transport or capability protocol.
- No claim that GitHub Actions provides a universal exactly-once guarantee beyond its documented concurrency and provider records.
- No change to Quartz as the primary renderer; see ADR-0001.
