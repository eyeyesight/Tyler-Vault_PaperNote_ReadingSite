import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { createQuartzPublicNavigation } from "../lib/quartz-public-navigation.mjs"
import { publicContracts } from "../scripts/tracer.mjs"

const graphStyles = await readFile(new URL("../styles/tracer-scholarly.scss", import.meta.url), "utf8")

const entries = [
  { publicId: "paper-a", nodeClass: "paper", route: "/papers/paper-a/", label: "Paper A" },
  { publicId: "paper-b", nodeClass: "paper", route: "/papers/paper-b/", label: "Paper B" },
  { publicId: "concept-a", nodeClass: "concept", route: "/knowledge/concept/concept-a/", label: "concept A" },
  { publicId: "concept-b", nodeClass: "concept", route: "/knowledge/concept/concept-b/", label: "concept B" },
  { publicId: "method-a", nodeClass: "method", route: "/knowledge/method/method-a/", label: "method A" },
  { publicId: "method-b", nodeClass: "method", route: "/knowledge/method/method-b/", label: "method B" },
  { publicId: "method-c", nodeClass: "method", route: "/knowledge/method/method-c/", label: "method C" },
  { publicId: "task-a", nodeClass: "task", route: "/knowledge/task/task-a/", label: "task A" },
  { publicId: "author-a", nodeClass: "author", route: "/knowledge/author/author-a/", label: "Author A" },
  { publicId: "synthesis-a", nodeClass: "synthesis", route: "/knowledge/synthesis/synthesis-a/", label: "synthesis A" },
  { publicId: "map-a", nodeClass: "map", route: "/knowledge/map/map-a/", label: "map A" },
]

/** @param {string} runtimeScripts */
function graphRuntime(runtimeScripts) {
  const match = /<script data-tracer-extension="t05-graph">([\s\S]*?)<\/script>/.exec(runtimeScripts)
  assert.ok(match, "graph runtime is present")
  return match[1]
}

test("global graph keeps icon-coded type filters over the graph and on-demand details", () => {
  const navigation = createQuartzPublicNavigation({ entries, route: "/" })

  assert.match(navigation.graphMarkup, /id="public-graph-global" data-graph-scope="global"/)
  assert.match(navigation.graphMarkup, /role="group" aria-label="Filter node types"/)
  assert.match(navigation.graphMarkup, /data-graph-filter-count/)
  assert.match(navigation.graphMarkup, /data-graph-status role="status" aria-live="polite" aria-atomic="true"/)
  assert.match(navigation.graphMarkup, /data-graph-empty hidden/)
  assert.match(navigation.graphMarkup, /<svg data-graph-surface role="group" aria-labelledby="public-graph-global-title"/)
  assert.match(navigation.graphMarkup, /data-graph-canvas tabindex="0"/)
  assert.match(navigation.graphMarkup, /data-graph-inspector/)
  assert.match(navigation.graphMarkup, /class="public-graph-heading"[\s\S]*class="public-graph-workspace public-graph-card"/)
  assert.match(navigation.graphMarkup, /data-icon="tabler-file-text"/)
  assert.match(navigation.graphMarkup, /data-icon="lucide-network"/)
  assert.match(navigation.graphMarkup, /data-icon="lucide-external-link"/)
  assert.match(navigation.graphMarkup, /data-graph-inspector-doi target="_blank" rel="noopener noreferrer"/, "graph DOI opens in an opener-isolated new tab")
  assert.ok(navigation.graphMarkup.indexOf('data-graph-inspector-link') < navigation.graphMarkup.indexOf('data-graph-inspector-doi'), "Open note precedes DOI / source")
  assert.match(navigation.graphMarkup, /data-graph-inspector-definition/)
  assert.match(navigation.graphMarkup, /<p>Description<\/p>/)
  assert.match(navigation.graphMarkup, />Relationships\s/)
  assert.ok(navigation.graphMarkup.indexOf("public-graph-canvas") < navigation.graphMarkup.indexOf("public-graph-filters"), "filters live inside the canvas")
  assert.equal((navigation.graphMarkup.match(/data-graph-filter="/g) ?? []).length, 7, "all seven public node types have graph filters")
  for (const nodeClass of ["paper", "concept", "method", "task", "author", "synthesis", "map"]) assert.match(navigation.graphMarkup, new RegExp(`public-graph-swatch[^>]*data-node-class="${nodeClass}"`))
  assert.doesNotMatch(navigation.graphMarkup, /public-graph-toolbar|public-graph-viewport-controls|public-graph-search/)
  assert.doesNotMatch(navigation.graphMarkup, /data-graph-action="(?:search|fullscreen|zoom-in|zoom-out|fit|freeze|arrange|pin|unpin|reset)"/)
  assert.doesNotMatch(navigation.graphMarkup, /Connections as text/)
  assert.doesNotMatch(navigation.graphMarkup, /public-graph-list/)
  assert.doesNotMatch(navigation.graphMarkup, /data-graph-depth|Explore connections|direct relationships/)
})

test("public graph contracts collapse reciprocal links into one undirected relationship", () => {
  const records = new Map([
    ["paper-a", { node: { node_class: "paper", path: "paper-a.md" }, route: "/papers/paper-a/", frontmatter: { title: "Paper A", authors: ["Dan Guo", "Kun Li"], year: 2024 } }],
    ["concept-a", { node: { node_class: "concept", path: "concept-a.md" }, route: "/knowledge/concept/concept-a/", frontmatter: { title: "concept A" } }],
  ])
  const outgoing = new Map([
    ["paper-a", new Set(["concept-a"])],
    ["concept-a", new Set(["paper-a"])],
  ])

  const { graph, search } = publicContracts(records, outgoing, new Map([
    ["concept-a", "# Concept A\n\n## Definition\n\nA bounded public definition.\n\n## Connections\n\nOther text."],
  ]))

  assert.deepEqual(graph.edges, [{ source: "concept-a", target: "paper-a" }])
  assert.equal(search.records.find((record) => record.public_id === "paper-a")?.year, "2024")
  assert.equal(search.records.find((record) => record.public_id === "concept-a")?.definition, "A bounded public definition.")
  assert.equal(search.records.find((record) => record.public_id === "paper-a")?.definition, null)
})

test("graph sidebar descriptions use the first blockquote after H1 for every non-paper node", () => {
  const nodeClasses = ["concept", "method", "task", "author", "synthesis", "map"]
  const records = new Map(nodeClasses.map((nodeClass) => [
    `${nodeClass}-a`,
    {
      node: { node_class: nodeClass, path: `${nodeClass}-a.md` },
      route: `/knowledge/${nodeClass}/${nodeClass}-a/`,
      frontmatter: { title: `${nodeClass} A` },
    },
  ]))
  const searchableBodies = new Map(nodeClasses.map((nodeClass) => [
    `${nodeClass}-a`,
    `# ${nodeClass} A\n\n> Public ${nodeClass} description.\n> Continued on the next quoted line.\n\n## Connections\n\nOther text.`,
  ]))

  const { search } = publicContracts(records, new Map(), searchableBodies)

  for (const nodeClass of nodeClasses) {
    assert.equal(
      search.records.find((record) => record.public_id === `${nodeClass}-a`)?.definition,
      `Public ${nodeClass} description. Continued on the next quoted line.`,
      `${nodeClass} exposes its H1 blockquote description to the graph sidebar`,
    )
  }
})

test("graph contracts uppercase synthesis and map title initials", () => {
  const records = new Map([
    ["synthesis-a", { node: { node_class: "synthesis", path: "synthesis-a.md" }, route: "/knowledge/synthesis/synthesis-a/", frontmatter: { title: "synthesis A" } }],
    ["map-a", { node: { node_class: "map", path: "map-a.md" }, route: "/knowledge/map/map-a/", frontmatter: { title: "map A" } }],
  ])

  const { graph, search } = publicContracts(records, new Map(), new Map())

  assert.equal(graph.nodes.find((node) => node.public_id === "synthesis-a")?.title, "Synthesis A")
  assert.equal(graph.nodes.find((node) => node.public_id === "map-a")?.title, "Map A")
  assert.equal(search.records.find((record) => record.public_id === "synthesis-a")?.title, "Synthesis A")
  assert.equal(search.records.find((record) => record.public_id === "map-a")?.title, "Map A")
})

test("local graph starts from its page without adding scope controls", () => {
  const navigation = createQuartzPublicNavigation({ entries, route: "/papers/paper-a/", currentPublicId: "paper-a" })

  assert.match(navigation.graphMarkup, /data-graph-root-id="paper-a"/)
  assert.match(navigation.graphMarkup, /data-graph-scope="local"/)
  assert.doesNotMatch(navigation.graphMarkup, /data-graph-scope-control/)
})

test("graph runtime includes force-graph drag dynamics, semantic zoom, and responsive details", () => {
  const navigation = createQuartzPublicNavigation({ entries, route: "/" })
  const runtime = graphRuntime(navigation.runtimeScripts)

  assert.match(runtime, /const titleLines=/)
  assert.match(runtime, /const seedPositions=/)
  assert.match(runtime, /const startSimulation=/)
  assert.match(runtime, /const tick=/)
  assert.match(runtime, /class:"public-graph-edges"/)
  assert.match(runtime, /querySelector\("\[data-graph-surface\]"\)/)
  assert.match(runtime, /data-graph-inspector-title/)
  assert.match(runtime, /data-graph-inspector-definition/)
  assert.match(runtime, /supported=node\.node_class!=="paper"&&Boolean\(record\?\.definition\)/, "all non-paper node descriptions can appear in the sidebar")
  assert.match(runtime, /data-graph-relations/)
  assert.match(runtime, /const paperCitation=/)
  assert.match(runtime, /normalized\.split\(\/\\s\+\/\)\.at\(-1\)/)
  assert.match(runtime, /label=node\.node_class==="paper"\?paperCitation\(record\):shortLabel\(node\)/, "paper nodes retain their compact citation label")
  assert.match(runtime, /dataset\.graphDistance/)
  assert.match(runtime, /layout==="phone"\?1\.15:1\.05/)
  assert.match(runtime, /alphaDecay=\.0228,velocityDecay=\.4,dragClickTolerance=5/)
  assert.match(runtime, /alphaTarget=\.3/)
  assert.match(runtime, /Math\.hypot\(dx,dy\)<=dragClickTolerance/)
  assert.match(runtime, /point\.fx=drag\.fx;point\.fy=drag\.fy/)
  assert.match(runtime, /resizeObserver\.observe\(canvas\)/)
  assert.match(runtime, /requestAnimationFrame/)
  assert.doesNotMatch(runtime, /public-graph-band/)
  assert.doesNotMatch(runtime, /renderList/)
  assert.doesNotMatch(runtime, /data-graph-node-link/)
  assert.doesNotMatch(runtime, /searchInput|pinDrops|frozen|arrange=/)
  assert.match(runtime, /const updateFocus=/)
  assert.match(runtime, /new ResizeObserver/)
  assert.match(runtime, /"nodeClass":"synthesis"/, "graph runtime configures synthesis nodes")
  assert.match(runtime, /"nodeClass":"map"/, "graph runtime configures map nodes")
  for (const icon of ["tabler-file-text", "lucide-network", "lucide-flask-conical", "lucide-list-checks", "lucide-users-round", "lucide-layers-3", "lucide-map"]) {
    assert.match(runtime, new RegExp(`"id":"${icon}"`), `graph nodes configure the ${icon} icon`)
  }
  assert.match(runtime, /class:"public-graph-node-container",x:-15,y:-15,width:30,height:30,rx:10/, "every graph node uses a 30px squircle container")
  assert.match(runtime, /class:"public-graph-node-icon",transform:"translate\(-8 -8\) scale\(\.666667\)"/, "type icons are centered inside the squircle")
  assert.doesNotMatch(runtime, /M 0 -10 L 10 0|M 0 -10 L 9 -5/, "legacy geometric node shapes are removed")
  assert.match(runtime, /public-graph-paper-card/, "zoomed-in paper nodes retain the existing paper card")
  assert.match(runtime, /meta\.textContent=paperCitation\(record\)/, "zoomed-in paper cards retain their citation metadata")
  assert.doesNotMatch(runtime, /public-graph-author-initial/, "author nodes use their category icon instead of the legacy initial")
  assert.doesNotMatch(runtime, /Math\.random/)
  assert.doesNotThrow(() => new Function(runtime))
})

test("persistent graph sidebar activates within the site's desktop content column", () => {
  const navigation = createQuartzPublicNavigation({ entries, route: "/" })
  const runtime = graphRuntime(navigation.runtimeScripts)

  assert.match(graphStyles, /@container \(min-width: 45rem\)[\s\S]*?grid-template-columns: minmax\(0, 1\.618fr\) minmax\(18rem, 1fr\)/)
  assert.match(graphStyles, /\.public-graph-inspector-content:not\(\[hidden\]\)\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) minmax\(0, 1\.618fr\)/s)
  assert.match(graphStyles, /\.public-graph-relations\s*\{[^}]*overflow-y:\s*auto/s)
  assert.match(graphStyles, /\.public-graph-relations::-webkit-scrollbar\s*\{[^}]*display:\s*none/s)
  assert.match(graphStyles, /container:\s*graph-canvas\s*\/\s*inline-size/)
  assert.match(graphStyles, /container:\s*public-graph\s*\/\s*inline-size/)
  assert.match(graphStyles, /@container graph-canvas \(max-width: 44\.999rem\)[\s\S]*?\[data-graph-filter-label\][\s\S]*?display:\s*none/)
  assert.match(graphStyles, /@container \(max-width: 37\.499rem\)[\s\S]*?height:\s*clamp\(26rem,\s*calc\(100svh - 8rem\),\s*34rem\)/)
  assert.match(graphStyles, /@container \(max-width: 37\.499rem\)[\s\S]*?touch-action:\s*pan-y pinch-zoom/)
  assert.match(graphStyles, /\.public-graph-relations button\s*\{[^}]*background:\s*transparent[^}]*border:\s*0/s)
  assert.match(graphStyles, /\.public-graph \.public-graph-heading h2\s*\{[^}]*font-family:\s*var\(--font-editorial\)/s, "graph section heading uses the homepage editorial typeface")
  assert.match(graphStyles, /\[data-graph-inspector-title\][\s\S]*?-webkit-line-clamp:\s*3/s, "long inspector titles are clamped to three lines")
  assert.match(graphStyles, /\[data-graph-inspector-meta\][\s\S]*?-webkit-line-clamp:\s*3/s, "long inspector metadata is clamped to three lines")
  assert.match(graphStyles, /\[data-graph-inspector-definition-text\][\s\S]*?-webkit-line-clamp:\s*3/s, "long inspector definitions are clamped to three lines")
  assert.match(graphStyles, /\.public-graph-relations button\s*\{[^}]*-webkit-line-clamp:\s*3/s, "long relationship labels are clamped to three lines")
  assert.match(graphStyles, /\.public-graph-label,\s*\.public-graph-paper-title,\s*\.public-graph-paper-meta\s*\{[^}]*font-family:\s*inherit/s, "graph node text inherits the site's bilingual typography")
  assert.match(graphStyles, /\.public-graph\s*\{[^}]*font-family:\s*inherit/s, "graph sidebar and controls inherit the site's bilingual typography")
  assert.match(graphStyles, /\.public-graph-inspector-heading p\s*\{[^}]*font-family:\s*var\(--font-interface\)/s, "graph inspector categories retain the interface typeface")
  assert.match(graphStyles, /\.public-graph-inspector h3\s*\{[^}]*font-family:\s*var\(--font-interface\)/s, "graph inspector titles retain the interface typeface")
  assert.match(graphStyles, /\.public-graph-definition > p\s*\{[^}]*font-family:\s*var\(--font-interface\)/s, "the Description label retains the interface typeface")
  assert.match(graphStyles, /\.public-graph-relations > p\s*\{[^}]*font-family:\s*var\(--font-interface\)/s, "the Relationships label retains the interface typeface")
  assert.match(graphStyles, /\.public-graph-relations button\s*\{[^}]*font-family:\s*var\(--font-interface\)/s, "graph relationship items retain the interface typeface")
  assert.match(graphStyles, /\.public-graph\[data-layout-ready\] \.public-graph-node-container\s*\{[^}]*fill:\s*var\(--graph-node-color,[^}]*drop-shadow/s, "squircle containers carry the node type color")
  assert.match(graphStyles, /\.public-graph\[data-layout-ready\] \.public-graph-node-icon > \*\s*\{[^}]*stroke:\s*#fffaf3[^}]*stroke-linecap:\s*round/s, "node icons use a high-contrast consistent stroke")
  for (const nodeClass of ["paper", "concept", "method", "task", "author", "synthesis", "map"]) assert.match(graphStyles, new RegExp(`\\[data-node-class="${nodeClass}"\\] \\{ --graph-node-color:`))
  assert.match(runtime, /containerWidth>=720\?"wide"/)
  assert.doesNotMatch(runtime, /groups\.slice\(0,\s*5\)/, "graph runtime keeps all configured public node types")
})

test("mobile graph keeps its section label and gives the inspector an unobstructed close control", () => {
  assert.match(graphStyles, /\.public-graph\[data-layout-ready\]\[data-layout-ready\] \.public-graph-heading-copy > \.public-graph-kicker\s*\{[^}]*display:\s*block/s)
  assert.doesNotMatch(graphStyles, /\.public-graph-heading-copy \.public-graph-kicker,\s*\.public-graph-heading-copy > p:last-child/)
  assert.match(graphStyles, /@container public-graph \(max-width: 44\.999rem\)[\s\S]*?\[data-graph-overlay="inspector"\] \.public-graph-filters\s*\{[^}]*visibility:\s*hidden[^}]*pointer-events:\s*none/s)
  assert.match(graphStyles, /@container \(max-width: 37\.499rem\)[\s\S]*?\.public-graph-inspector-content:not\(\[hidden\]\)\s*\{[^}]*grid-template-rows:\s*minmax\(0, calc\(38\.2% \+ 1\.5rem\)\) minmax\(0, 1fr\)/s)
  assert.match(graphStyles, /@container \(max-width: 37\.499rem\)[\s\S]*?\[data-graph-action="close-inspector"\]\s*\{[^}]*font-size:\s*1\.5rem[^}]*line-height:\s*1/s)
})

test("graph gestures preserve clicks, reveal inspector content, and animate direct manipulation", () => {
  const navigation = createQuartzPublicNavigation({ entries, route: "/" })
  const runtime = graphRuntime(navigation.runtimeScripts)
  const pointerDown = runtime.slice(runtime.indexOf('canvas.addEventListener("pointerdown"'), runtime.indexOf('canvas.addEventListener("pointermove"'))
  const pointerMove = runtime.slice(runtime.indexOf('canvas.addEventListener("pointermove"'), runtime.indexOf("const endPointer"))
  const pointerEnd = runtime.slice(runtime.indexOf("const endPointer"), runtime.indexOf('document.addEventListener("keydown"'))

  assert.match(pointerDown, /closest\?\.\("\[data-graph-filter\],\[data-graph-action\]"\)\)return/)
  assert.doesNotMatch(pointerDown, /setPointerCapture/)
  assert.match(pointerMove, /setPointerCapture/)
  assert.match(pointerEnd, /clickedId=!drag\.dragged&&event\.type==="pointerup"\?drag\.id:null/)
  assert.match(pointerEnd, /if\(clickedId\)selectNode\(clickedId\)/)
  assert.doesNotMatch(runtime, /group\.addEventListener\("click"/)
  assert.doesNotMatch(runtime, /if\(reducedMotion\.matches\)\{for\(let index=0;index<60/)
  assert.match(graphStyles, /\.public-graph-inspector \[hidden\]\s*\{[^}]*display:\s*none\s*!important/)
})
