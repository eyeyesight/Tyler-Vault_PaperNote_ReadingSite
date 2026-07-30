# Tyler-Vault Reading Site

A manifest-governed static reading layer for explicitly approved Tyler-Vault research notes. The project combines Explorer, search, public graph navigation, scholarly paper pages, support-node pages, and fail-closed atomic releases while keeping the canonical Vault read-only.

## Project status

This repository is an **active private implementation milestone**, not a production publication.

- T01–T06 are complete, including safe atomic releases and last-known-good protection.
- T07 Zotero marker-only delta validation is pending.
- T08 integrated read-only rehearsal and desktop/mobile browser QA are pending.
- Production maturity remains blocked until 3–5 structurally different real integrated papers pass the agreed maturity suite.
- Public deployment, GitHub Pages, and Hermes command integration require separate approval.

No prototype fixture in this repository is research evidence. The committed fixtures are synthetic and explicitly labelled.

## Safety boundaries

- Tyler-Vault Markdown remains the canonical, read-only source.
- Generated site files and runtime state stay outside Tyler-Vault.
- Publication requires an approved, expiring, digest-bound manifest.
- Unlisted nodes, PDFs, credentials, local paths, runtime files, and private graph edges fail closed.
- A failed build or promotion cannot replace the last-known-good release pointer.

## Requirements

- Node.js 22 or newer
- npm 10.9.2 or newer

## Local verification

```bash
npm ci
npm run typecheck
npm test
```

The authoritative full test command runs serially because several acceptance cases exercise filesystem and browser lifecycle boundaries.

## Project commands

```bash
npm run preflight
npm run build
npm run verify
npm run serve
npm run contracts:validate

# Synthetic tracer fixtures only
npm run tracer:preflight
npm run tracer:build
npm run tracer:release
```

Commands require the contract-specific arguments described by the production specification and local ticket fixtures. Synthetic tracer output must never be presented as published research.

## Documentation

- Product specification: [`specs/tyler-vault-reading-site.md`](specs/tyler-vault-reading-site.md)
- Domain vocabulary and fixed boundaries: [`CONTEXT.md`](CONTEXT.md)
- Quartz renderer ADR: [`docs/adr/0001-quartz-primary-renderer.md`](docs/adr/0001-quartz-primary-renderer.md)
- Local implementation tickets: [`.scratch/tyler-vault-reading-site/issues/`](.scratch/tyler-vault-reading-site/issues/)

## Current release evidence

The T06 milestone was closed with:

- 364/364 repository tests passing
- TypeScript and Node syntax checks passing
- Independent scanner and promotion-boundary reviews reporting no Blocker or High findings
- Package dry-run confirming required release modules, policies, schemas, and tests are included

The working milestone remains intentionally private until the remaining integration and maturity gates are satisfied.
