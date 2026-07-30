# Pinned Quartz toolchain and local command surface

T01 uses Quartz as the only renderer. Synthetic Markdown under
`fixtures/synthetic-content/` is deliberately non-research content.

## Pin and installation

- Quartz `5.0.0`, upstream `v5` commit
  `507ad7f3d4601d83482f61930fccf1c77f42a072`.
- This commit is pinned for upstream lock completeness; it does not change
  Quartz's `sharp: ^0.34.5` declaration and is not the Sharp security fix.
  ADR 0003 owns the temporary exact root `sharp: 0.35.3` override and checked-in
  brace-expansion 5.0.8 compatibility adapter.
- `package.json` uses GitHub's tarball for that exact Git commit (avoiding an
  SSH/git requirement) and `package-lock.json` records its integrity plus every
  transitive npm dependency. Reproducible installs use `npm ci`.
- The upstream default `quartz/static/icon.png` is independently pinned in
  `config/quartz-toolchain.json` at SHA-256
  `532d053e33c2c6bdefdd8145996cedc4be2fc32cfdac740c8488749457d131cf`.
  Every `build` and `serve` hashes the installed bytes before materializing or
  executing Quartz; a mismatch fails closed before Quartz/sharp or output
  mutation.
- The authoritative installation guide says to clone/template Quartz, run
  `npm i` initially, use `npm ci` on later clones, then run
  `npx quartz build --serve`.

This repository already existed and contains approved specifications and ADRs,
so replacing its root with the Quartz template would be disruptive. The
minimal, reversible integration installs the exact upstream Git revision as a
locked dependency and materializes its unmodified runtime source into ignored
`.quartz-toolchain/` only after safety preflight. Project commands hide this
upstream layout. Trade-off: Quartz assumes it owns the repository root, so the
small materialization adapter is a compatibility seam that must be retested on
upgrades.

## Stable commands

All commands require the existing canonical Vault root through
`TYLER_VAULT_ROOT` or `--vault-root`. This is fail-closed: a missing/invalid
root is rejected. The default source and output are the synthetic fixture and
`.artifacts/synthetic-site`.

Hermes and every other automation runner **MUST invoke the project wrapper
directly**, so the tracked process is the process that owns the preview socket:

```sh
node scripts/site.mjs preflight --vault-root 'C:/absolute/canonical-vault'
node scripts/site.mjs build --vault-root 'C:/absolute/canonical-vault'
node scripts/site.mjs verify --vault-root 'C:/absolute/canonical-vault'
node scripts/site.mjs serve --vault-root 'C:/absolute/canonical-vault' --port 8080
```

The equivalent `npm run preflight|build|verify|serve -- ...` aliases are
interactive convenience only. They may be used by a person who owns the
terminal and stops preview with Ctrl+C; they are also retained for explicit
SIGINT/SIGTERM regression tests. Automation must not launch long-lived `serve`
through npm's additional Windows process layer.

`--source` and `--output` can override defaults. Before any command mutates
staging or output, the Vault, source, and output paths are canonicalized. Every
pair must be disjoint: equality and either ancestor/descendant direction are
rejected. Preflight then recursively accepts
only regular `.md` files containing valid UTF-8 without NUL. It rejects every
other file class/extension, symlink or reparse-point escape, PNG/JPEG/GIF/TIFF/
WebP/PDF/ZIP magic bytes even under a `.md` name, every Markdown `![` image
opener (including reference and Obsidian forms), and raw HTML `<img>` elements.
This deliberately narrow T01 gate prevents source images and
binary assets from reaching Quartz/sharp; it does not pre-implement T02
manifest semantics. Any rejection occurs before toolchain or output mutation.

## Local preview safety

`serve` first runs the same pinned Quartz build and output verification as
`build`, then serves only the completed files with the project-owned Node HTTP
server. It always binds `127.0.0.1` (never `0.0.0.0` or a non-loopback
interface), resolves extensionless Quartz routes such as `/support-node`, and
canonicalizes every requested file below the generated output root. The pinned
Quartz build bootstrap statically imports its CLI handlers, so the
`serve-handler` package/module can be imported while the child performs the
build. However, the wrapper never passes Quartz `--serve`: its `serve-handler`
HTTP handler is never called and no project-preview request URI can reach it.
The project-owned static server does not use `serve-handler`.

The preview runs in the project wrapper process rather than a long-lived Quartz
child. SIGINT and SIGTERM close active connections and the listening socket.
The wrapper also watches its direct parent every 250 ms and closes itself if
that launcher disappears. `SERVE_READY` reports the exact loopback host, port,
and owning PID for automated read-back and cleanup checks.

The Windows/Hermes automation proof used the canonical direct invocation
`node scripts/site.mjs serve ...`: after Hermes terminated the tracked process,
bounded read-back reported `DIRECT_PATH_CLOSED_AFTER 0.0`, with no orphan
listener. By contrast, terminating an npm launcher can leave its descendant
socket owner alive on this host; that observed process-layer behavior is why
the direct-invocation rule above is mandatory rather than advisory.

## Dependency audit boundary

T08 temporarily replaces the advisory-bearing primitives with the exact,
project-owned bridge accepted in ADR 0003: Quartz commit `507ad7f...`, root
`sharp: 0.35.3`, and a checked-in callable/named-export adapter over exact
`brace-expansion@5.0.8`. Quartz still declares `sharp: ^0.34.5`; the override is
outside that range and is not upstream-supported. The Quartz commit contributes
lock completeness, not the Sharp security fix.

Current full and production-only audit read-backs are required gates, but audit
zero is not complete safety proof: npm does not review adapter logic, runtime
reachability, input boundaries, cross-platform native compatibility, or product
regressions. Do not run `npm audit fix`; dependency changes require the complete
compatibility suite and renewed fingerprints.

- Sharp is genuinely invoked by Quartz's favicon plugin against only the fixed,
  digest-pinned `quartz/static/icon.png`. The project source gate rejects
  untrusted GIF/TIFF/VIPS and other image/binary inputs before Quartz. This
  exclusion remains defense-in-depth and does not replace the exact patched pin.
- Quartz's build bootstrap can statically import `serve-handler`, but the wrapper
  never passes Quartz `--serve`; no project request or untrusted glob reaches
  that handler. The project-owned local static server does not use it.
- Public rehearsal and deployment remain blocked until ADR 0003's focused,
  isolated-install, full regression, build/verify, headless browser, platform,
  audit/SBOM, and independent-review gates all pass.
