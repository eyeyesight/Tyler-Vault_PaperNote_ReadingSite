# ADR 0003 — Dependency Compatibility Decision

- Status: Accepted
- Date: 2026-07-30
- Accepted by: Tyler
- Owner: Tyler-Vault reading site project maintainers

## Context

The approved product is a safe, private, maintainable, and readable public layer for explicitly approved Vault notes. Quartz, Sharp, and their dependency graph are implementation means, not product requirements. The previously pinned stack had two underlying High advisories propagated to seven audit nodes. Patched versions exist, but Quartz commit `507ad7f3d4601d83482f61930fccf1c77f42a072` still declares `sharp: ^0.34.5`, which excludes Sharp `0.35.3`, and released `serve-handler@6.1.7` still uses the callable CommonJS contract of `minimatch@3.1.5`.

Tyler approved a bounded bridge instead of waiting indefinitely for upstream. This is a project-owned compatibility and maintenance decision. It is **not upstream-supported** Sharp 0.35 support, not a claim that npm audit reviews local adapter logic, and not permission to rehearse or deploy before every gate below is green.

## Decision principle

Requirements outrank tools. Retain the primary renderer or any dependency only while it continuously satisfies the approved product, privacy, security, readability, and maintenance contract. Quartz and Sharp remain replaceable if a simpler or safer implementation better serves that contract.

## Decision

Temporarily pin this exact stack as one indivisible bridge:

1. Quartz exact commit `507ad7f3d4601d83482f61930fccf1c77f42a072`.
2. Root exact `sharp: 0.35.3` override. Quartz's upstream `^0.34.5` range does not include it, so the project owns compatibility evidence.
3. Checked-in `vendor/brace-expansion-compat` adapter wrapping exact upstream `brace-expansion@5.0.8`. It preserves the historical callable CommonJS contract for minimatch 3 and an explicit named `expand` export for minimatch 10 ESM.

The Quartz commit is selected for upstream lock completeness only. It does not provide the Sharp security fix; the root override does. The adapter is reviewed project code even though its package metadata participates in npm's installed graph.

## Required gates

Before any public rehearsal or deployment, all of the following must pass against byte-identical package, lock, vendor, and toolchain inputs:

- focused ownership tests plus the real pinned-favicon Sharp 48×48 PNG smoke;
- real minimatch 3 CommonJS/serve-handler and minimatch 10 ESM consumer tests;
- typecheck and complete directly affected regression coverage, followed by the full suite where locally feasible;
- fresh isolated `npm ci`, no lock drift, and no unexpected source mutation;
- production build/verify and completely headless, isolated synthetic browser QA;
- full and production-only `npm audit`, dependency graph read-back, SBOM read-back, and independent security review with no open Blocker/High public-deployment finding;
- the actual deployment runner platform. Local Windows evidence cannot be represented as Linux evidence; Linux remains a PR CI/deployment prerequisite.

Audit zero is only advisory-database evidence. It does not prove compatibility, reachability boundaries, adapter correctness, supply-chain integrity, or end-to-end safety.

## Review cadence and removal triggers

Review the bridge at least every 30 days while retained, before every public rehearsal or deployment, and whenever Quartz, Sharp, serve-handler, minimatch, brace-expansion, relevant advisories, or accepted input boundaries change.

Remove or stop the affected bridge component when:

1. Quartz publishes merged, reviewed, green formal Sharp 0.35-or-newer support and that exact stack passes all project gates;
2. serve-handler publishes a safe dependency graph compatible with its real CommonJS/ESM consumers and it passes all project gates; or
3. advisory facts or input boundaries change, especially if untrusted GIF, TIFF, VIPS, image, request glob, or equivalent attacker-controlled input becomes reachable. This trigger requires immediate fail-closed re-review, not a silent waiver.

## Rejected alternatives

- **Wait for upstream:** rejected for the temporary path because timing is unbounded. An eventual merged and green release remains the preferred removal trigger.
- **Maintain a narrow Quartz fork:** rejected because it does not remove project ownership and adds fork provenance, rebasing, and supply-chain burden.
- **Risk exception on the advisory-bearing stack:** rejected because reachability controls are defense-in-depth, not a substitute for patched production dependencies.
- **Pin open/CI-red PR #2506:** rejected because it is not merged upstream support, its checks are not green, and it bundles unrelated dependency changes.

## Consequences

The project gets an exact patched graph without waiting for upstream, while accepting explicit temporary maintenance work. Every dependency or boundary change must re-prove the bridge. Failure of any gate keeps public rehearsal and deployment blocked. CI must continue to verify the dependency compatibility and security checks on Linux before changes are merged.
