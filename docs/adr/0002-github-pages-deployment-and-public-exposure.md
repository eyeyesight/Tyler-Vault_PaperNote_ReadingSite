# ADR 0002: GitHub Pages deployment and private-to-public exposure contract

- **Status:** Accepted for T09 contract work; remote activation remains unapproved
- **Decision date / official-source check:** 2026-07-30 UTC
- **Scope:** `eyeyesight/Tyler-Vault_PaperNote_ReadingSite`
- **Machine-readable contract:** `config/github-pages-deployment-contract-v1.json`
- **Independent exposure authority/schema:** `config/github-provider-public-exposure-catalog-v1.json`, `config/github-provider-public-exposure-catalog-v1.schema.json`
- **Local executable contract:** `lib/pages-deployment-contract.mjs`, `lib/verified-sealed-release.mjs`, `tests/support/scripted-local-pages-provider.mjs`, `tests/github-pages-deployment-contract.test.mjs`, and `tests/verified-sealed-release.test.mjs`

## Context

The target is a free public GitHub repository and a GitHub Pages **project site**. The repository currently needs a deployment contract, not a deployment. This ADR therefore does not create a workflow, enable Pages, change visibility, call a mutating GitHub endpoint, or publish any real note.

Changing a private repository to public is much broader than publishing one static directory. GitHub says the code becomes visible to everyone, anyone can fork it, activity is published, and Actions history and logs become visible. GitHub also warns that rewriting Git history does not recall copies from clones/forks, SHA-addressed cached views, or pull requests. A Pages-only artifact scan cannot establish that the repository is safe to expose.

## Decision

### 1. Hosting and URL

Use the public repository on GitHub Free and a Pages project site at:

- origin: `https://eyeyesight.github.io`
- base path: `/Tyler-Vault_PaperNote_ReadingSite`
- canonical site URL: `https://eyeyesight.github.io/Tyler-Vault_PaperNote_ReadingSite/`
- no custom domain or `CNAME`

GitHub's Pages overview identifies a project-site default location as `https://<owner>.github.io/<repositoryname>`. GitHub's Pages documentation states that public repositories are supported by GitHub Free. The renderer must generate and test URLs under the project base path; root-only success is not evidence.

The Pages artifact root must contain case-exact `index.html` and `404.html`. All canonical internal routes, absolute assets, relative assets, Explorer, search, graph, and 404 navigation must remain under the base path.

### 2. Delivery mechanism

Select a **custom GitHub Actions Pages artifact**:

1. obtain the exact approved manifest and sealed local release;
2. verify the release receipt, path set, bytes, hashes, content rights, and public-exposure gates;
3. configure Pages metadata;
4. upload one `github-pages` artifact;
5. in a separate serialized job, deploy that artifact to the `github-pages` environment;
6. read back provider state and public bytes before declaring success.

Do **not** commit generated real-note HTML to a normal branch. Git history would make generated content part of the much larger, forkable repository exposure and would complicate removal. GitHub recommends a custom Actions workflow when a non-Jekyll build or no dedicated compiled-output branch is desired, and its official workflow model is `configure-pages` → `upload-pages-artifact` → `deploy-pages`.

T09 intentionally adds no active `.github/workflows` file. A later implementation must use the checked full commit pins in the machine contract after re-reviewing them. Moving major tags shown in examples are not accepted as immutable executable pins.

### 3. Workflow authority and least privilege

The only deploy input authority is an opaque `VerifiedSealedRelease` capability minted after the existing trusted-filesystem checks load an approved manifest and sealed local receipt and the existing sealed-custody verifier reads the exact artifact tree. The capability carries no enumerable fields and is recognized only by module-private object identity. A plain object, copied authority fields, a forged brand/symbol/prototype, a serialized clone, branch tip, arbitrary workflow artifact, mutable directory, or “latest successful build” is not deployment authority.

The deploy job contract is:

```yaml
permissions:
  contents: read
  pages: write
  id-token: write
environment:
  name: github-pages
  url: ${{ steps.deployment.outputs.page_url }}
concurrency:
  group: pages
  cancel-in-progress: false
```

GitHub documents `pages: write` and `id-token: write` as the minimum deployment permissions and recommends `github-pages`; its example also includes `contents: read`. The environment must allow only the approved default branch, require a distinct deployment approval, and prevent self-review where the plan supports it. The deploy action's OIDC token proves workflow-job/ref context; no PAT is stored or used by this contract.

Actions concurrency is only a provider-side guard. GitHub documents that a concurrency group permits at most one running and one pending job, may replace an existing pending job, and does not guarantee ordering. Therefore the lifecycle must also compare a monotonic generation and current LKG immediately before mutation. `cancel-in-progress: false` avoids deliberately aborting the running deployment; stale or concurrent candidates fail closed rather than relying on queue order.

### 4. Artifact format, size, and retention

Lock the artifact to:

- name `github-pages`;
- one gzip archive containing one tar archive;
- ordinary files/directories only, with no symbolic or hard links;
- hidden files excluded;
- official published-site maximum 1 GB;
- local release gate maximum 900,000,000 bytes, preserving headroom;
- deploy-status ceiling 600,000 ms (10 minutes);
- transport artifact retention 1 day.

The official `upload-pages-artifact` action defaults to one-day retention and documents the required tar/gzip structure. Its README mentions an unofficial absolute 10 GB rejection threshold but also says Pages officially supports only 1 GB and larger deployments are not guaranteed. This contract treats **1 GB as the provider maximum** and 900 MB as the stricter release gate; the 10 GB implementation ceiling is not a supported allowance. GitHub separately documents a 1 GB published-site limit and 10-minute deployment timeout. Public repository Actions artifacts/logs can be configured for 1–90 days, so one day is valid.

A one-day transport artifact is not rollback custody. The immutable local sealed release remains authoritative.

### 5. Base-path and fixed local-only fixture

`createSyntheticProjectSiteServer` binds only `127.0.0.1` on an ephemeral port. Its complete caller interface is exactly one plain own enumerable data property, `{ basePath }`; accessors, proxies/exotic objects, symbols, non-enumerable properties, `root`, test hooks, and every other extra property fail with `FIXTURE_OPTIONS_INVALID` before fixture loading or listen. It has no caller-selected path, exported loader/test hook, provider URL, credential lookup, or network client. `normalizeBasePath` accepts only one exact canonical absolute path and its single trailing-slash variant; malformed percent escapes and all percent-encoded, repeated-separator, control/NUL, slash/backslash, dot-traversal, and non-NFC forms fail with `BASE_PATH_INVALID`.

The module-private root is fixed to the repository corpus at `tests/fixtures/pages-project-site/`. Before listen, the server takes exactly one complete snapshot with fixed ceilings of 32 directories, depth 8, 64 files, 256 KiB per file, and 1 MiB total. It incrementally enumerates and closes directory handles; at every level it applies `lstat` plus exact `realpath` canonical-root containment and rejects links, junction redirects, non-file/non-directory entries, and hard-linked files. Every file is opened once and read only through that `FileHandle`: `fstat` → bounded exact-size read plus one-byte growth probe → `fstat`, requiring an ordinary file, `nlink === 1`, and unchanged device, inode, size, and nanosecond mtime. Path identity and containment are checked around the handle read, and every success/error path closes the handle.

After snapshot construction, request handling makes zero filesystem calls. The module-private map and source buffers never escape; each response receives a fresh Buffer copy (or only snapshot metadata for `HEAD`). `close()` is idempotent, stops acceptance, closes idle/all connections, destroys tracked sockets, and has a one-second local deadline so an incomplete client request cannot retain the server or port indefinitely.

The static corpus proves:

- canonical root and paper route;
- an absolute base-path CSS URL and relative JavaScript/route URLs;
- Explorer's content index;
- search index route values;
- graph index route values;
- a custom `404.html` with base-path-safe return navigation;
- denial of the same asset outside the project base path;
- redirect from the no-trailing-slash project path to the canonical path.

Navigation acceptance parses every `href`, `src`, `action`, and `data-index` attribute from the actual served root, paper, Explorer, search, graph, and custom-404 HTML responses. Each value is resolved against that response URL, required to stay on the loopback origin below the project base path, fetched, and checked for status, content type, and nonempty/valid JSON content. Separate public-interface regressions cover repeated legal HTTP reads from the same immutable startup snapshot, `HEAD`, content types, custom 404 metadata, double close, active-connection termination, and immediate port reuse.

This is a fixed, trusted, synthetic test corpus only—not a production server, preview server, or arbitrary file server—and it contains no Tyler-Vault-derived research content. Node does not expose one portable JavaScript predicate for every possible Windows reparse tag. The fixed trusted root narrows that platform threat model; known symlink/junction redirects are rejected by `lstat`, and any exact-`realpath` redirect or containment mismatch at root, directory, or file fails closed. This contract does not claim resistance to a privileged concurrent writer that can preserve all checked file identity metadata.

### 6. External lifecycle, failure semantics, and read-back

A lifecycle release identity is the structured tuple `(release_id, release_digest, generation)`: `release_id` is globally unique, `release_digest` hashes the canonical lifecycle descriptor, and `generation` is a positive monotonic integer. This identity is separate from byte custody: `artifact_digest` identifies the exact published artifact bytes and `receipt_digest` identifies the exact sealed local receipt bytes. Reusing an artifact during controlled rollback does not reuse an old lifecycle identity; rollback creates a new tuple with a newer generation. Its release ID uses one canonical reversible encoding of source manifest ID plus new generation, so a later process can recover custody and recompute the lifecycle digest without a caller map or process-local registry.

State transition rules:

1. **Local authority first:** before any provider read or write, require a module-private branded `VerifiedSealedRelease`; no caller-supplied release or authority object is accepted. Minting loads T06 sealed custody through T03 trusted filesystem boundaries, verifies the exact release tree, and derives the complete approved-manifest digest, sealed descriptor identity, receipt identity/digest, artifact digest/byte length, sorted path/hash/size inventory, and lifecycle digest from those bytes. The same custody and artifact bytes are re-read before every run and replay.
2. **Preflight read-back:** `safeReadback` uses only the canonical machine policy and first rejects every root, nested-object, and array `Proxy` with `node:util/types.isProxy` before prototype, key, descriptor, symbol, or value reflection on that node. It then rejects accessors, symbols, non-enumerable properties, exotic/cyclic values, clones, and validates exactly `active`, `inProgress`, and required `retained` keys. Identity consistency covers active, retained, the in-progress release, and its expected-active release.
3. **Replay and resume:** exact active identity with no in-progress operation is an authority-checked no-op. If the same deterministic operation is pending, resume creates a new read-only polling deadline and polls that provider-visible operation ID; it never claims or calls start again. A rollback resume first requires the pending operation's exact expected-active tuple to equal the field-bound approval, otherwise it returns stable `ROLLBACK_EXPECTED_ACTIVE_MISMATCH` without polling or starting. A different in-progress operation blocks the candidate.
4. **Conflict/stale:** compare the candidate against all active, retained, in-progress, and expected-active history. Reject one release ID bound to another digest/generation, one digest bound to another identity, or a generation not newer than provider history. For an exact pending candidate, generation comparison excludes only occurrences of that exact identity; it still evaluates every newer active, retained, and expected-active identity and returns stable `DEPLOYMENT_STALE` before polling.
5. **Deterministic operation and atomic durable claim:** derive one operation, claim, and idempotency identity from the candidate plus captured expected-active identity. The production provider protocol requires `claim(operation, options)`. It atomically and durably persists the exact operation and expected-active CAS as a provider-visible pending claim before remote mutation. The first exact caller receives only `{disposition: 'acquired'}`; every later, concurrent, and cross-resume caller receives only `{disposition: 'exists'}`. An unknown value, timeout, or error is ambiguous and can only enter reconciliation. Only the caller that received exact `acquired` may continue to final provider-state validation, reload and byte-verify both candidate and active LKG, and call `start`. Two callers that pass initial read-back therefore produce one acquired claim and at most one `start` call.
6. **Exactly one mutation call:** `start` requires the already persisted exact claim and is invoked at most once for an operation. Every return, rejection, auth/403, 429, transport error, 5xx, timeout, conflict, or unknown result after start is outcome-uncertain. No error discriminant or adapter flag can authorize a second start. If a process crashes after acquiring the claim but before calling start, the provider-visible operation may remain permanently pending and requires manual adjudication; safety forbids resending start.
7. **One aggregate absolute deadline:** production `safeReadback`, deploy, and rollback always use the canonical machine-owned 10-second request limit and 10-minute deadline. A fresh operation establishes one absolute deadline immediately before claim; claim, final provider revalidation, start, and reconciliation share it. Before every remote call or delay, the lifecycle recomputes remaining time; each remote call receives and enforces `min(request_timeout_ms, remaining)`, and no next call starts at zero. Resume may create a new read-only polling deadline but can never start. Caller policy, retry-count, timeout, backoff, and sleep overrides are rejected before provider access. The scripted adapter lives only under `tests/support/`; accelerated policies enter only through deep-module functions explicitly named `ForTest`, which are not exported by `pages-deployment-contract.mjs`. If the exact operation is terminal success, the requested identity is active, and `inProgress` is null, return success. Otherwise return nonterminal `pending/unknown`, preserve the claim, and block a different deployment until the same operation converges or is separately resolved.
8. **Terminal success:** a stale success operation, an active identity without matching terminal operation status, or a terminal operation while another claim remains cannot count as deployment success.
9. **Unknown read-back:** remain pending and issue no mutation. GitHub may use 404 to hide an unauthorized private resource, so 404 is never proof of absence.
10. **Public success gate:** after provider terminal success, require Pages settings, provider deployment status and environment URL, public release identity, complete public byte hashes, and every exposure-inventory read-back to match before calling the publication successful.

GitHub's REST guidance says to stop on rate limit, honor `Retry-After`/reset, avoid concurrency, and not ignore repeated 4xx/5xx errors. This project is stricter at the mutation seam: it never retries `start`; `Retry-After` is diagnostic after start, and only bounded read-only reconciliation may continue.

Provider-readable surfaces include `GET /repos/{owner}/{repo}/pages`, deployment objects/statuses, workflow run/artifact metadata, and the public site itself. The Pages API exposes create, status, and cancel operations. As checked on 2026-07-30, it does **not document a native “roll back to prior Pages artifact” endpoint**. Absence from the current API is not assumed permanent.

### 7. Last-known-good and controlled rollback

Before any remote mutation, retain and verify the immutable sealed bytes for the current LKG. A failed candidate must not overwrite or delete those bytes.

Rollback is a new, serialized lifecycle release of explicitly approved locally retained bytes, not an API magic switch and not `provider.rollback(digest)`:

1. record a complete rollback approval identity: approval/approver/time, the new lifecycle `(release_id, release_digest, generation)`, expected-active, and prior source-release tuples; derive the canonical reversible release ID from source manifest ID plus new generation and derive the new digest from the opaque source capability, so the approval cannot supply an alias or alter byte authority;
2. before provider access, revalidate the opaque source capability against trusted sealed custody and exact artifact bytes; after provider preflight, independently reload and verify both those target bytes and the provider-active LKG bytes immediately before `start`;
3. if the candidate is already exact active with no in-progress operation, revalidate the same approval and custody and return an idempotent no-op; only a first mutation requires current active to equal the approval's expected-active identity;
4. otherwise, including every pending resume, require the provider operation's expected-active tuple to equal the approval exactly before any operation-status poll, then derive the same deterministic operation/claim/idempotency identity used by forward deployment and atomically persist it with expected-active CAS;
5. invoke `start` at most once, upload the approved prior sealed bytes as a new one-day transport artifact, and reconcile only through that provider-visible operation ID;
6. require terminal operation success, the **new** lifecycle release identity, provider status, and all public hashes while retaining the approved prior artifact/receipt byte identities. Later LKG verification parses that canonical ID, reloads the source manifest's opaque capability, and recomputes the lifecycle digest and exact bytes. A deadline returns nonterminal pending/unknown and never authorizes another start.

If the prior sealed bytes are unavailable, approval identity is incomplete, read-back is ambiguous, or any hash differs, rollback is blocked. The local provider seam tests local custody authority, exact terminal read-back, partial activation reconciliation, and atomic publication without implementing a real deployment or a provider-native rollback operation.

### 8. Complete private-to-public exposure inventory

The required-set authority is the separately reviewable `config/github-provider-public-exposure-catalog-v1.json`, validated by `config/github-provider-public-exposure-catalog-v1.schema.json`. The contract inventory must cover that catalog exactly; neither the contract nor its test owns a duplicate complete hard-coded set. Every contract entry independently supplies `policy`, `allowlist`, `paginated_scan`, `authenticated_readback`, `anonymous_probe`, `derived_bytes`, and `block_on_unknown: true`. Its required surfaces are:

1. all reachable Git objects and all refs;
2. branches;
3. tags and annotated-tag metadata;
4. PR refs, cached GitHub views, forks, and known clones;
5. Git LFS pointers/objects;
6. submodules and target commits;
7. releases and release assets;
8. packages/registries;
9. wiki history and attachments;
10. issues, comments, events, labels, milestones, and attachments;
11. commit comments, reactions, linked attachments, and rendered context;
12. PR bodies, commits, diffs, reviews, comments, checks, and attachments;
13. discussions;
14. classic Projects and Projects v2 visibility, fields, views, drafts, items, archived content, links, and attachments across repository and owner scopes;
15. Actions workflow definitions, local/reusable actions, triggers, permissions, pins, and runners;
16. Actions runs, logs, annotations, and job summaries;
17. Actions artifacts, including historical/expired metadata;
18. Actions caches and fork-access risk;
19. repository Actions variables and exact authorized values;
20. organization Actions variables plus visibility and selected-repository grants;
21. repository Actions secret metadata, external value custody, and consuming workflow/ref/event authorization scope;
22. organization Actions secret metadata, visibility, selected-repository grants, external value custody, and consuming authorization scope;
23. environments, protection rules, reviewers, variables, and secret metadata;
24. deployment objects and statuses;
25. Pages artifact and served site;
26. Pages settings, custom domain/CNAME, HTTPS, and DNS;
27. repository metadata, community files, license, authors/contributors, activity, stars/watchers, and fork network;
28. dependency graph, manifests, submitted dependencies, and external dependency snapshots;
29. artifact attestations, subjects/predicates/signatures, and public Sigstore transparency-log records/proofs;
30. security policies, published advisories, alerts/annotations where authorized;
31. non-public but mutation-relevant control surfaces: webhooks, deploy keys, collaborators/teams, installed apps, rulesets, branch protections, and token defaults.

A surface may be `allow`, `deny`, `allow-if-empty`, or `allow-by-manifest`. Empty/read-restricted/expired is never inferred from a single API response: pagination, authorization, local mirror/object scan, downloadable bytes, unauthenticated probes, and provider UI/API cross-checks are required as applicable. Any unknown is blocking.

### 9. Rights split

- Identified Quartz renderer/theme code and upstream assets remain under MIT.
- Tyler-authored content is **all rights reserved**; publishing it does not relicense it.
- Third-party quotations, Zotero excerpts, bibliographic material, images, and linked works retain their original rights. They are not relicensed and must not be described as Tyler-owned.
- Every public node/asset needs a rights classification and required attribution/provenance. Unknown rights is a blocking finding.

Repository-level licensing must not use a single blanket statement that appears to place Tyler content or third-party material under the renderer's MIT license.

### 10. Publication gate and zero-side-effect boundary

Visibility and deployment are two separate human-approved mutations. Immediately before either one, require:

- current approved manifest;
- validated sealed local release and exact artifact receipt read-back;
- source-repository and Pages-artifact allowlists both clean;
- zero secret, private/local path, Markdown, PDF, unapproved-route, or content-rights finding;
- complete provider exposure inventory with no unknown;
- independent contradiction/security review with no open Blocker/High;
- explicit visibility approval, then separate deployment approval.

T09 authorizes none of those remote mutations. It creates no workflow and performs no GitHub write/API mutation.

## Consequences

### Positive

- Generated real-note HTML does not enter normal Git history.
- Project-site base-path behavior is executable locally.
- Deployment retries are bounded, idempotent, and read-back driven.
- LKG custody does not depend on short-lived Actions artifacts.
- Public exposure is treated as a repository-wide transition, not a Pages-directory scan.

### Costs and limits

- A later ticket must implement the workflow and provider adapters only after approvals.
- Full historical and GitHub-side exposure inventory is operationally expensive and requires authenticated pagination plus unauthenticated checks.
- Existing forks/clones/cached views can make exposure irreversible; unknown prior copies block visibility.
- GitHub plan, API, action SHAs, and limits can change and must be re-checked immediately before implementation/activation.

## Official primary sources checked 2026-07-30

1. [Getting started with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages) — availability in public repositories on GitHub Free.
2. [What is GitHub Pages?](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) — project-site URL shape.
3. [Configuring a publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) — custom Actions recommendation/flow and public-site warning.
4. [Using custom workflows with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) — configure/upload/deploy actions, permissions, environment, and artifact structure.
5. [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) — 1 GB published site, 10-minute deployment, bandwidth/build/rate limits.
6. [Troubleshooting 404 errors](https://docs.github.com/en/pages/getting-started-with-github-pages/troubleshooting-404-errors-for-github-pages-sites) — top-level artifact `index.html`, case sensitivity, URL rebuild caveats.
7. [`actions/upload-pages-artifact`](https://github.com/actions/upload-pages-artifact/blob/main/README.md) and [action.yml](https://github.com/actions/upload-pages-artifact/blob/main/action.yml) — artifact format, links, limits, hidden-file behavior, one-day default retention.
8. [`actions/deploy-pages`](https://github.com/actions/deploy-pages/blob/main/README.md) and [action.yml](https://github.com/actions/deploy-pages/blob/main/action.yml) — permissions/OIDC, environment, 10-minute status timeout, status error bound, output URL.
9. [`actions/configure-pages` action.yml](https://github.com/actions/configure-pages/blob/main/action.yml) — base URL/origin/base-path outputs and opt-in mutating enablement (not selected).
10. [Workflow syntax: concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency) — running/pending behavior and unordered execution.
11. [Managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) — protection rules, deployment branches/tags, environment creation, and deployment objects.
12. [Managing Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository) — public fork workflow risk, token defaults, cache settings, and 1–90 day public artifact/log retention.
13. [Dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching) — base-branch cache access from fork PRs and prohibition on sensitive cache content.
14. [Setting repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility) — public code/forks/activity and Actions history/log visibility.
15. [Removing sensitive data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) — clones, forks, cached views, PR refs, and LFS cleanup limitations.
16. [REST API endpoints for GitHub Pages](https://docs.github.com/en/rest/pages/pages) — settings/build/deployment create/status/cancel fields and current API version.
17. [REST API endpoints for deployments](https://docs.github.com/en/rest/deployments/deployments) and [deployment statuses](https://docs.github.com/en/rest/deployments/statuses) — deployment/read-back objects and states.
18. [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) and [REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) — 403/429 headers, bounded exponential retry, authorization-hidden 404, and repeated 4xx/5xx handling.
19. [Downloading workflow artifacts](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts) and [REST Actions artifact endpoints](https://docs.github.com/en/rest/actions/artifacts) — read access, expiry, enumeration, and download read-back.
