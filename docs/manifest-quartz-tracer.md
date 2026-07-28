# Manifest-to-Quartz tracer (T03)

T03 proves one deliberately narrow vertical slice: a validated publication
manifest and its isolated export can produce a pinned Quartz site containing one
synthetic paper, one synthetic support node, and no other content route. The
tracer is local-only. It does not read the canonical Vault as content, write
Vault/Drive/runtime state, deploy, or promote a release.

## Public commands

```sh
npm run tracer:preflight -- \
  --manifest /context/manifest.json \
  --export-receipt /export/export-receipt.json \
  --runtime-root /runtime \
  --export-root /export \
  --vault-root /canonical-vault \
  --work-root /work \
  --output /public-output \
  --now 2026-07-28T12:00:00Z

npm run tracer:build -- \
  --manifest /context/manifest.json \
  --export-receipt /export/export-receipt.json \
  --runtime-root /runtime \
  --export-root /export \
  --vault-root /canonical-vault \
  --work-root /work \
  --output /public-output \
  --now 2026-07-28T12:00:00Z

npm run test:tracer
```

All eight flags are required and may appear only once. Unknown flags, duplicate
flags, missing values, and an unknown command fail closed. `--export-receipt`
must name the exact `export-receipt.json` entry directly under `--export-root`;
a copied receipt or spelling alias is rejected. Every invocation writes exactly
one JSON object to stdout, writes nothing to stderr, and exits `0` on success or
`1` on failure. Error JSON uses stable codes and role names rather than local
absolute paths.

Successful preflight JSON has this shape:

```json
{"ok":true,"command":"preflight","manifestId":"VPUB-...","nodes":2,"suppressionCount":1,"quartz":"5.0.0"}
```

Successful build JSON additionally reports the exact public route set and gated
file count:

```json
{"ok":true,"command":"build","manifestId":"VPUB-...","nodes":2,"routes":["/","/knowledge/concept/synthetic-support/","/papers/synthetic-paper/"],"files":40,"suppressionCount":1,"quartz":"5.0.0"}
```

`files` is toolchain-output dependent; consumers must enforce `routes`, not pin
the illustrative file count.

## Security and operation order

`preflight` is a read-only seam. Before any work or output path is created, it:

1. canonicalizes every role, rejects Node-identifiable symlink/junction ancestors,
   requires exact filesystem spelling/class/readability, and rejects equal,
   ancestor, or descendant overlaps;
2. validates the publication manifest against trusted `--now` and the read-only
   runtime baseline, then validates the exact export receipt and isolated export;
3. requires the T03 shape (one `type: literature-note`, `status: integrated`
   paper plus one non-paper support node), strict source bytes, declared hashes,
   safe Markdown/frontmatter, the exact `SYNTHETIC FIXTURE — NOT RESEARCH
   EVIDENCE.` text as an independent visible plain body paragraph in each node,
   and the approved direct connection; and
4. resolves aliases only among manifest-listed nodes. An unresolved/unlisted
   wikilink must have an explicit, non-empty pipe display that is not a private
   target variant. Only that escaped display becomes public; normalized full,
   extensionless, basename, and case-folded target variants are retained only in
   a private suppression set used by the output gate.

T03 parses each frontmatter-stripped body with the exact-pinned
`mdast-util-from-markdown@2.0.3` CommonMark parser. Parser failure or missing stable
MDAST source offsets fails closed as `SOURCE_MARKDOWN_INVALID`. Semantic
wikilinks are scanned only inside source slices authenticated by rendered MDAST
`text` nodes, using each node's `position.start.offset` and
`position.end.offset`; source replacements therefore retain exact body-relative
offsets and run in descending order. Text under `code`, `inlineCode`,
`definition`, `link`, `linkReference`, `image`, `imageReference`, or `html`
ancestors is excluded, so fenced/indented code, code spans, reference metadata,
Markdown destinations/titles, and Markdown link labels cannot create graph
semantics. Escaped wikilink openers are not links. This intentionally does not
support wikilinks nested in Markdown link labels.

`Connections` is recognized only as a root-level depth-2 MDAST heading whose
children are exactly one plain `text` node with value `Connections`. Its governed
range starts at that heading's end offset and ends at the next root-level H1/H2
start offset. The exact support-path semantic link in that range is the sole
direct-edge evidence. Consequently, rendered nested-list continuation text may
provide the link, while unmatched backticks have their CommonMark meaning and do
not hide a later real heading/link. Code examples cannot create outgoing links
or backlinks.

A separate all-source token pass remains disclosure-only: wikilink-shaped tokens
in code, escaped, link-title, reference-definition, and other nonsemantic
contexts still pass through the unlisted-target policy. Private targets are
replaced by their safe explicit display rather than leaking as source or
metadata; listed nonsemantic tokens are retained. Exact semantic ranges are
deduplicated and overlapping replacements fail closed. A second `[[` opener
inside one token is rejected as `SOURCE_NESTED_WIKILINK_NOT_ALLOWED` before
projection, preventing a private inner target from hiding in a public outer
display. The strict source
disclaimer is accepted only when a root child is a paragraph whose children are
exactly one plain text node equal to the fixture disclaimer; frontmatter, code,
list, blockquote, link/title text, and reference definitions do not qualify.
Markdown local-link policy is derived from MDAST `link` nodes and resolved
`linkReference` definitions rather than source-text masking.

Source bodies reject raw HTML tags, slash-separated and namespaced tag shapes,
declarations, processing instructions, and comments before projection. This
raw-source defense defines the accepted HTML/autolink subset; it is not a browser
parser and does not replace the exact-pinned CommonMark MDAST parse. Markdown
autolinks are
also rejected at this T03 boundary. Ordinary less-than comparison text such as
`2 < 3` remains valid; normal HTTPS Markdown links remain subject to the later
candidate link gate.

`build` runs preflight first. It then creates an exclusive random directory under
`--work-root`, copies only the two approved source files into fresh raw input,
projects separate renderer Markdown, copies the pinned Quartz toolchain, and
runs Quartz against only that projection. No third-party asset bytes are
post-processed. Immediately after Quartz exits successfully—and before any test
hook or prune—the tracer validates the candidate root and records a private,
sorted immutable baseline of every regular file's relative path, filesystem
class, and SHA-256. The baseline is never emitted in CLI JSON or copied into the
public tree.

Candidate-root validation is repeated before every walk, prune, gate, and final
rename. Both the exclusive run and candidate must remain canonical ordinary
(non-link) directories, and the candidate's real path must remain strictly
inside that run. A candidate pathname replaced by an in-run or external
symlink/junction fails with `CANDIDATE_ROOT_INVALID`.

The tracer removes only Quartz's known `404.html` and parent folder virtual
pages derived from approved routes. Every page being removed must already be in
the immutable baseline and must still have its baseline hash immediately before
deletion; otherwise pruning fails with `CANDIDATE_VIRTUAL_PAGE_TAMPERED`.
Arbitrary extra HTML is left intact and rejected by the exact-route gate. The
expected final manifest is exactly the baseline minus that closed virtual-page
set. Extra, missing, reclassified, or changed files and assets fail with
`CANDIDATE_FILE_MANIFEST_MISMATCH`; candidate-created files never authorize
themselves merely by existing.

Before atomic output rename, the candidate gate requires exactly the three HTML
routes below. Every paper/support route must also contain the exact disclaimer
as a normal body `<p>`; text present only in metadata, title, comment, or inert
`<template>` content fails `CANDIDATE_DISCLAIMER_MISSING`. The gate parses
generated HTML start tags and enumerates `href`, `src`,
`poster`, `action`, `formaction`, `object[data]`, and every `srcset` URL. Inline
`on*` event attributes and meta refresh are rejected. CSS `url()` references are
checked in style attributes, `<style>` blocks, and generated CSS files. Internal
URLs may resolve only to approved content routes or non-HTML assets in the
immutable baseline; missing assets and unapproved routes have distinct stable
errors. HTTP(S), protocol-relative, fragment, `mailto:`, and `tel:` URLs remain
permitted. HTML URL attributes reject `javascript:`, `vbscript:`, `data:`, and
`file:`; CSS data URIs remain allowed for pinned Quartz output.

The gate also rejects Markdown/PDF files, receipt/source metadata, suppressed
private targets, credential-shaped bytes, unsafe schemes, and configured or
conventional absolute local paths. Windows path comparisons are case-folded and
separator-normalized; conventional `C:/users/`, `c:\\users\\`, `/home/`, and
`/users/` forms are rejected case-insensitively. Source bytes, SHA-256, and mtime
are rechecked after Quartz returns. Any failure removes the exclusive work run
and leaves output absent. Output absence is rechecked immediately before the
final gate/rename; protection against a privileged concurrent writer remains a
documented runtime precondition rather than an atomic T06 promotion guarantee.

Every `TYLER_TRACER_TEST_*` injection is inert unless the process also presents
`TYLER_TRACER_TEST_CAPABILITY=t03-regression-v1`. Candidate mutations are a
closed enumeration used only by public-CLI regressions; production runs do not
accept arbitrary candidate payloads.

## Routes and links

For the synthetic fixture, the only public routes are:

- `/`
- `/papers/synthetic-paper/`
- `/knowledge/concept/synthetic-support/`

The paper's governed, visible `## Connections` link resolves to the support
route. Inline, fenced, and indented code are retained as code but never treated
as wikilinks. A
backlink is derived only from an actual resolved outgoing source wikilink, never
synthesized bidirectionally from the manifest edge: the support page therefore
links back to the paper in `## Backlinks`, while the paper has no support backlink
unless an independently authorized source link actually points to it. Aliases of
approved nodes may resolve only when the directed manifest connection authorizes
the source-to-target link. An unlisted explicit neutral display remains visible
as text, but creates no href, route, source path, target basename, public ID,
backlink, or other private target metadata.

## Zero-write contract

Preflight performs no copy and no mutation: context, manifest, receipt, isolated
export, runtime, canonical Vault, work root, and absent output remain byte-,
hash-, and mtime-identical. Build writes only inside its exclusive work run and,
after all gates pass, the previously absent output path. It never writes the
source/export, canonical Vault, or runtime. The work run is removed on both
success and failure.

## Scope boundary and residual risk

T03 owns manifest-to-renderer projection, exact synthetic routes/link policy,
candidate gating, cleanup, and zero-write evidence. The immutable candidate
baseline prevents post-build files from self-authorizing, but it does not turn
Quartz output into a separate trust root: renderer trust remains bounded by the
committed package lock, pinned Quartz archive/commit metadata, installed-version
check, pinned default-icon hash, and exact `mdast-util-from-markdown@2.0.3`
dependency. The current production-dependency audit boundary is 7 high and 0
critical advisories; this tracer change adds no floating parser version. T03 does
not mutate vendor assets. T04 owns
paper/support layouts, responsive drawers, typography, and accessibility. T05–T07
own later search/graph, release, and operational surfaces. T03 does not implement
or claim those features, final theme behavior, real research publication,
deployment, or release promotion.

Node's `Stats.isSymbolicLink()` does not identify every opaque Windows reparse
tag. Roots must therefore be ordinary local, agent-owned directories without
unsupported opaque reparse points. Path checks and later byte/mtime checks reduce
but cannot eliminate filesystem TOCTOU: a privileged concurrent actor could swap
an ancestor or output between checks. Run the tracer in an exclusive local
workspace with untrusted concurrent writers excluded. These are known residuals,
not accepted publication inputs.

Candidate CSS URL inspection is likewise a narrow scanner for pinned Quartz
output, not a complete CSS parser. Obfuscated or future CSS grammar outside that
fixed renderer baseline remains residual risk; changing Quartz/CSS output
requires renewed gate review rather than assuming browser-parser equivalence.
