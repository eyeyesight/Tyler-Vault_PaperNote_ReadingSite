import { createPublicGraphExplorerScript, publicGraphTypeIcons } from "./public-graph-explorer.mjs"

const classGroups = Object.freeze([
  Object.freeze({ nodeClass: "paper", label: "Papers" }),
  Object.freeze({ nodeClass: "concept", label: "Concepts" }),
  Object.freeze({ nodeClass: "method", label: "Methods" }),
  Object.freeze({ nodeClass: "task", label: "Tasks" }),
  Object.freeze({ nodeClass: "author", label: "Authors" }),
  Object.freeze({ nodeClass: "synthesis", label: "Syntheses" }),
  Object.freeze({ nodeClass: "map", label: "Maps" }),
])

const utf8 = new TextEncoder()

/** @typedef {{publicId:string,nodeClass:string,route:string,label:string}} PublicNavigationEntry */

/** @param {string} left @param {string} right */
function utf8Compare(left, right) {
  const a = utf8.encode(left)
  const b = utf8.encode(right)
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return a.length - b.length
}

/** @param {unknown} value */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character)
}

/** @param {unknown} value */
function scriptData(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => ({
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029",
  })[character] ?? character)
}

/** @param {string} value */
function uppercaseInitial(value) {
  const characters = [...value]
  return characters.length === 0 ? value : `${characters[0].toLocaleUpperCase("en-US")}${characters.slice(1).join("")}`
}

/** @param {string} route */
function siteRootForRoute(route) {
  if (route === "/") return "./"
  if (/^\/papers\/[^/]+\/$/.test(route)) return "../../"
  if (/^\/knowledge\/[^/]+\/[^/]+\/$/.test(route)) return "../../../"
  throw new Error("public navigation route has an unsupported generated depth")
}

/** @param {string} siteRoot @param {string} route */
function relativePublicHref(siteRoot, route) {
  if (route === "/") return siteRoot
  if (!/^\/(?:papers\/[^/]+|knowledge\/[^/]+\/[^/]+)\/$/.test(route)) throw new Error("public navigation entry has an invalid canonical route")
  return `${siteRoot}${route.slice(1)}`
}

/** @param {PublicNavigationEntry[]} entries */
function normalizeEntries(entries) {
  const seenIds = new Set()
  const seenRoutes = new Set()
  const normalized = entries.map((entry) => {
    const publicId = String(entry.publicId)
    const nodeClass = String(entry.nodeClass)
    const route = String(entry.route)
    const rawLabel = String(entry.label)
    const label = ["concept", "method", "task", "synthesis", "map"].includes(nodeClass) ? uppercaseInitial(rawLabel) : rawLabel
    if (!publicId || !label || !classGroups.some((group) => group.nodeClass === nodeClass)) throw new Error("public navigation entry is incomplete")
    relativePublicHref("./", route)
    if (seenIds.has(publicId) || seenRoutes.has(route)) throw new Error("public navigation entries must have unique IDs and routes")
    seenIds.add(publicId)
    seenRoutes.add(route)
    return { publicId, nodeClass, route, label }
  })
  return classGroups.map((group) => ({
    ...group,
    entries: normalized.filter((entry) => entry.nodeClass === group.nodeClass).sort((left, right) => utf8Compare(left.publicId, right.publicId)),
  }))
}

function searchMarkup() {
  return `<section class="public-search" role="search" aria-label="Search"><label><span>Search the public library</span><input type="search" inputmode="search" autocomplete="off" placeholder="Search papers, authors, DOI, concepts, methods, or text…" data-public-search-input></label><p data-public-search-status aria-live="polite">Enter a title, author, DOI, tag, heading, or visible text.</p><ol data-public-search-results></ol></section>`
}

/** @param {string|null} currentPublicId */
function graphMarkup(currentPublicId) {
  const scope = currentPublicId === null ? "global" : "local"
  const suffix = scope === "global" ? "global" : `local-${currentPublicId}`
  const root = currentPublicId === null ? "" : ` data-graph-root-id="${escapeHtml(currentPublicId)}"`
  const graphId = `public-graph-${suffix}`
  const titleId = `${graphId}-title`
  const descriptionId = `${graphId}-description`
  const statusId = `${graphId}-status`
  /** @param {Readonly<{id:string,elements:ReadonlyArray<Readonly<{name:string,attributes:Readonly<Record<string,string|number>>}>>}>} graphic @param {string} [className] */
  const icon = (graphic, className = "public-graph-filter-icon") => `<svg class="${className}" data-icon="${graphic.id}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${graphic.elements.map(({ name, attributes }) => `<${name} ${Object.entries(attributes).map(([key, value]) => `${key}="${escapeHtml(value)}"`).join(" ")}/>`).join("")}</svg>`
  const filters = classGroups.map(({ nodeClass, label }) => `
    <button type="button" data-graph-filter="${nodeClass}" aria-pressed="true" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
      <span class="public-graph-swatch" data-node-class="${nodeClass}" aria-hidden="true"></span>
      ${icon(publicGraphTypeIcons[nodeClass])}
      <span data-graph-filter-label>${label}</span>
      <span data-graph-filter-count></span>
    </button>`).join("")
  const graphTitle = scope === "global" ? "Trace connections in the global graph" : "Local Graph"
  const openNoteIcon = icon(publicGraphTypeIcons.paper, "public-graph-action-icon")
  const sourceIcon = icon({ id: "lucide-external-link", elements: [{ name: "path", attributes: { d: "M15 3h6v6" } }, { name: "path", attributes: { d: "M10 14 21 3" } }, { name: "path", attributes: { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" } }] }, "public-graph-action-icon")
  const expandIcon = icon({ id: "lucide-expand", elements: [{ name: "path", attributes: { d: "m15 15 6 6" } }, { name: "path", attributes: { d: "m15 9 6-6" } }, { name: "path", attributes: { d: "M21 16v5h-5" } }, { name: "path", attributes: { d: "M21 8V3h-5" } }, { name: "path", attributes: { d: "M3 16v5h5" } }, { name: "path", attributes: { d: "m3 21 6-6" } }, { name: "path", attributes: { d: "M3 8V3h5" } }, { name: "path", attributes: { d: "M3 3l6 6" } }] }, "public-graph-window-icon public-graph-window-icon-expand")
  const collapseIcon = icon({ id: "lucide-shrink", elements: [{ name: "path", attributes: { d: "M3 3l6 6" } }, { name: "path", attributes: { d: "M9 4v5H4" } }, { name: "path", attributes: { d: "m21 3-6 6" } }, { name: "path", attributes: { d: "M15 4v5h5" } }, { name: "path", attributes: { d: "m3 21 6-6" } }, { name: "path", attributes: { d: "M4 15h5v5" } }, { name: "path", attributes: { d: "m21 21-6-6" } }, { name: "path", attributes: { d: "M15 20v-5h5" } }] }, "public-graph-window-icon public-graph-window-icon-collapse")

  return `<section class="public-graph" id="${escapeHtml(graphId)}" data-graph-scope="${scope}"${root} data-layout-ready="false" data-graph-layout="phone" data-graph-zoom="mid" data-graph-window="inline" data-sheet-state="peek">
    <header class="public-graph-heading">
      <div class="public-graph-heading-copy">
        <p class="public-graph-kicker">Knowledge map</p>
        <h2 data-graph-title>${graphTitle}</h2>
      </div>
    </header>
    <p class="public-graph-status sr-only" id="${escapeHtml(statusId)}" data-graph-status role="status" aria-live="polite" aria-atomic="true">Loading graph&hellip;</p>
    <div class="public-graph-workspace public-graph-card">
      <div class="public-graph-canvas" data-graph-canvas tabindex="0" aria-label="Interactive public knowledge graph">
        <div class="public-graph-filters" role="group" aria-label="Filter node types">${filters}</div>
        <button type="button" class="public-graph-window-toggle" data-graph-action="toggle-window" aria-label="Expand graph to window" aria-pressed="false" title="Expand graph to window">${expandIcon}${collapseIcon}</button>
        <svg data-graph-surface role="group" aria-labelledby="${escapeHtml(titleId)}" aria-describedby="${escapeHtml(descriptionId)} ${escapeHtml(statusId)}">
          <title id="${escapeHtml(titleId)}">${scope === "global" ? "Global public graph" : "Local public graph"}</title>
          <desc id="${escapeHtml(descriptionId)}">An interactive node-link diagram. Drag nodes, pan or zoom the background, and select a node to inspect its relationships.</desc>
        </svg>
        <p class="public-graph-empty" data-graph-empty hidden>No nodes match the active filters.</p>
      </div>
      <aside class="public-graph-inspector" data-graph-inspector aria-label="Node details">
        <button type="button" class="public-graph-sheet-handle" data-graph-action="toggle-sheet" aria-label="Expand or collapse details"><span></span></button>
        <div class="public-graph-inspector-empty"><p>Select a node to inspect it.</p></div>
        <div class="public-graph-inspector-content" hidden>
          <div class="public-graph-inspector-summary">
            <div class="public-graph-inspector-heading">
              <p data-graph-inspector-type></p>
              <div class="public-graph-inspector-actions">
                <a data-graph-inspector-link aria-label="Open note" title="Open note">${openNoteIcon}</a>
                <a data-graph-inspector-doi target="_blank" rel="noopener noreferrer" aria-label="Open DOI or source in a new tab" title="DOI / source" hidden>${sourceIcon}</a>
                <button type="button" data-graph-action="close-inspector" aria-label="Close node details">&times;</button>
              </div>
            </div>
            <h3 id="${escapeHtml(graphId)}-inspector-title" data-graph-inspector-title></h3>
            <p data-graph-inspector-meta></p>
            <div class="public-graph-definition" data-graph-inspector-definition hidden>
              <p>Description</p>
              <div data-graph-inspector-definition-text></div>
            </div>
          </div>
          <div class="public-graph-relations">
            <p>Relationships <strong data-graph-relation-count hidden>0</strong></p>
            <ul data-graph-relations></ul>
          </div>
        </div>
      </aside>
    </div>
  </section>`
}

/** @param {string|null} currentPublicId @param {PublicNavigationEntry[]} backlinks @param {string} siteRoot */
function backlinksMarkup(currentPublicId, backlinks, siteRoot) {
  if (currentPublicId === null) return ""
  const items = backlinks.map((entry) => `<li><a href="${escapeHtml(relativePublicHref(siteRoot, entry.route))}" data-public-id="${escapeHtml(entry.publicId)}" data-node-class="${escapeHtml(entry.nodeClass)}">${escapeHtml(entry.label)}</a></li>`).join("")
  return `<div class="backlinks" data-public-backlinks data-public-id="${escapeHtml(currentPublicId)}"><h2 id="backlinks">Backlinks</h2>${items ? `<ul>${items}</ul>` : "<p>No approved backlinks.</p>"}</div>`
}

/** @param {Array<{nodeClass:string,label:string,entries:PublicNavigationEntry[]}>} groups */
function explorerAndTocScript(groups) {
  return `<script data-tracer-extension="t04">(()=>{const groups=${scriptData(groups.filter((group) => group.entries.length > 0))},responsiveMedia=matchMedia("(max-width: 980px)"),publicHref=route=>new URL(publicSiteRoot+route.replace(/^\\/+/ ,""),document.baseURI).pathname,syncScrollLock=()=>document.documentElement.classList.toggle("library-no-scroll",Boolean(document.querySelector(".sidebar.left.library-open,.sidebar.right.toc-open"))),setGroupOpen=(button,list,open)=>{button.setAttribute("aria-expanded",String(open));list.setAttribute("aria-hidden",String(!open));list.inert=!open},renderGroups=list=>{const signature=groups.flatMap(group=>[group.nodeClass,...group.entries.map(entry=>entry.publicId)]).join("\\0");if(list.dataset.publicExplorerSignature===signature&&list.querySelectorAll("[data-tracer-entry]").length===groups.reduce((count,group)=>count+group.entries.length,0))return;list.replaceChildren();for(const group of groups){const groupItem=document.createElement("li"),heading=document.createElement("button"),entriesList=document.createElement("ul"),entriesId="library-group-"+group.nodeClass;groupItem.className="public-class-group";groupItem.dataset.nodeClass=group.nodeClass;heading.type="button";heading.className="public-class-group-toggle";heading.textContent=group.label;heading.setAttribute("aria-controls",entriesId);heading.setAttribute("aria-expanded","false");entriesList.id=entriesId;entriesList.className="public-class-group-entries";setGroupOpen(heading,entriesList,false);for(const entry of group.entries){const item=document.createElement("li"),link=document.createElement("a");item.setAttribute("data-tracer-entry","");link.href=publicHref(entry.route);link.className="nav-file-title tree-item-self";link.textContent=entry.label;link.dataset.publicId=entry.publicId;link.dataset.nodeClass=entry.nodeClass;if(new URL(link.href,document.baseURI).pathname===location.pathname)link.setAttribute("aria-current","page");item.append(link);entriesList.append(item)}heading.addEventListener("click",()=>{const open=heading.getAttribute("aria-expanded")!=="true";for(const other of list.querySelectorAll(".public-class-group-toggle")){const controlled=document.getElementById(other.getAttribute("aria-controls"));if(controlled)setGroupOpen(other,controlled,other===heading&&open)}});groupItem.append(heading,entriesList);list.append(groupItem)}list.dataset.publicExplorerSignature=signature},setLibraryOpen=(explorer,button,content,open,moveFocus=false)=>{const sidebar=explorer.closest(".sidebar.left"),backdrop=sidebar?.querySelector(".library-backdrop");if(open)document.querySelector('button.toc-header[aria-expanded="true"]')?.click();sidebar?.classList.toggle("library-open",open);explorer.classList.toggle("collapsed",!open);explorer.setAttribute("aria-expanded",String(open));button.setAttribute("aria-expanded",String(open));button.setAttribute("aria-label",open?"Close Library":"Open Library");content.setAttribute("aria-hidden",String(!open));content.inert=!open;syncScrollLock();if(moveFocus)requestAnimationFrame(()=>{if(open)(content.querySelector("a,button")??button).focus();else button.focus()})},setupExplorer=()=>document.querySelectorAll(".explorer").forEach(explorer=>{const sidebar=explorer.closest(".sidebar.left"),button=explorer.querySelector(".library-toggle"),content=explorer.querySelector(".explorer-content"),list=explorer.querySelector(".explorer-ul"),backdrop=sidebar?.querySelector(".library-backdrop");if(!button||!content||!list)return;button.classList.remove("hide-until-loaded");renderGroups(list);if(button.hasAttribute("data-tracer-bound"))return;button.setAttribute("data-tracer-bound","true");new MutationObserver(()=>renderGroups(list)).observe(list,{childList:true,subtree:true});setLibraryOpen(explorer,button,content,false);button.addEventListener("click",event=>{event.preventDefault();event.stopImmediatePropagation();setLibraryOpen(explorer,button,content,button.getAttribute("aria-expanded")!=="true",true)},true);backdrop?.addEventListener("click",()=>setLibraryOpen(explorer,button,content,false,true));content.addEventListener("click",event=>{if(event.target.closest("a"))setLibraryOpen(explorer,button,content,false)});document.addEventListener("tracer:open-library",event=>{setLibraryOpen(explorer,button,content,true,true);const target=event.detail?.nodeClass,group=list.querySelector('[data-node-class="'+CSS.escape(target??"")+'"]'),groupButton=group?.querySelector(".public-class-group-toggle");if(groupButton?.getAttribute("aria-expanded")!=="true")groupButton?.click();requestAnimationFrame(()=>groupButton?.focus())});document.addEventListener("keydown",event=>{if(button.getAttribute("aria-expanded")!=="true")return;if(event.key==="Escape"){event.preventDefault();setLibraryOpen(explorer,button,content,false,true);return}if(event.key!=="Tab")return;const focusable=[button,...explorer.querySelectorAll('a[href],button:not([disabled])')].filter(element=>!element.closest('[aria-hidden="true"]')),first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}},true)}),setTocOpen=(button,content,open,moveFocus=false)=>{const sidebar=button.closest(".sidebar.right"),toc=button.closest(".toc"),backdrop=sidebar?.querySelector(".toc-backdrop");if(open)document.querySelector('.library-toggle[aria-expanded="true"]')?.click();sidebar?.classList.toggle("toc-open",open);toc?.setAttribute("aria-expanded",String(open));button.classList.toggle("collapsed",!open);button.setAttribute("aria-expanded",String(open));button.setAttribute("aria-label",open?"Close Table of Contents":"Open Table of Contents");content.classList.toggle("collapsed",!open);content.setAttribute("aria-hidden",String(!open));content.inert=!open;syncScrollLock();if(moveFocus)requestAnimationFrame(()=>{if(open)(content.querySelector("a")??button).focus();else button.focus()})},setupToc=()=>document.querySelectorAll("button.toc-header").forEach(button=>{const sidebar=button.closest(".sidebar.right"),content=document.getElementById(button.getAttribute("aria-controls"))??button.nextElementSibling,backdrop=sidebar?.querySelector(".toc-backdrop");if(!content)return;[...content.children].forEach((item,index)=>item.style.setProperty("--toc-item-delay",Math.min(index*42,420)+"ms"));if(button.hasAttribute("data-tracer-toc-bound"))return;button.setAttribute("data-tracer-toc-bound","true");setTocOpen(button,content,false);button.addEventListener("click",event=>{event.preventDefault();event.stopImmediatePropagation();setTocOpen(button,content,button.getAttribute("aria-expanded")!=="true",true)},true);backdrop?.addEventListener("click",()=>setTocOpen(button,content,false,true));content.addEventListener("click",event=>{if(event.target.closest("a"))setTocOpen(button,content,false)});document.addEventListener("keydown",event=>{if(button.getAttribute("aria-expanded")!=="true")return;if(event.key==="Escape"){event.preventDefault();setTocOpen(button,content,false,true);return}if(event.key!=="Tab")return;const focusable=[button,...content.querySelectorAll('a[href]')],first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}},true)}),setup=()=>{setupExplorer();setupToc()};setup();window.addEventListener("load",()=>setTimeout(setup,0),{once:true});document.addEventListener("nav",setup)})()</script>`
}

function adaptiveReadingScript() {
  return `<script data-tracer-extension="t06-adaptive">(()=>{
    const wideMedia=matchMedia("(min-width: 120rem)")
    const setLibrary=open=>{for(const explorer of document.querySelectorAll(".explorer")){const sidebar=explorer.closest(".sidebar.left"),button=explorer.querySelector(".library-toggle"),content=explorer.querySelector(".explorer-content");if(!button||!content)continue;sidebar?.classList.toggle("library-open",open);explorer.classList.toggle("collapsed",!open);explorer.setAttribute("aria-expanded",String(open));button.setAttribute("aria-expanded",String(open));button.setAttribute("aria-label",open?"Close Library":"Open Library");content.setAttribute("aria-hidden",String(!open));content.inert=!open}}
    const setToc=open=>{for(const toc of document.querySelectorAll(".sidebar.right > .toc")){const sidebar=toc.closest(".sidebar.right"),button=toc.querySelector(".toc-header"),content=button&&document.getElementById(button.getAttribute("aria-controls"))||toc.querySelector(".toc-content");if(!button||!content)continue;sidebar?.classList.toggle("toc-open",open);toc.setAttribute("aria-expanded",String(open));button.classList.toggle("collapsed",!open);button.setAttribute("aria-expanded",String(open));button.setAttribute("aria-label",open?"Close Table of Contents":"Open Table of Contents");content.classList.toggle("collapsed",!open);content.setAttribute("aria-hidden",String(!open));content.inert=!open}}
    const syncWide=()=>{const open=wideMedia.matches;document.documentElement.classList.toggle("wide-fixed-navigation",open);setLibrary(open);setToc(open);if(open)document.documentElement.classList.remove("library-no-scroll")}
    const setupTables=()=>{for(const table of document.querySelectorAll("article table:not([data-responsive-table-ready])")){table.setAttribute("data-responsive-table-ready","");const headers=[...table.querySelectorAll("thead th")].map(cell=>cell.textContent?.trim()??""),rows=[...table.querySelectorAll("tbody tr")],simple=headers.length>0&&rows.length>0&&!table.querySelector("[rowspan],[colspan]")&&rows.every(row=>row.children.length===headers.length);table.classList.add(simple?"responsive-card-table":"responsive-scroll-table");if(!simple)continue;for(const row of rows)[...row.children].forEach((cell,index)=>{const label=document.createElement("span");label.className="responsive-cell-label";label.setAttribute("aria-hidden","true");label.textContent=headers[index];cell.prepend(label)})}}
    const setupBackToTop=()=>{for(const button of document.querySelectorAll("[data-back-to-top]:not([data-back-to-top-ready])")){button.setAttribute("data-back-to-top-ready","");button.addEventListener("click",()=>scrollTo({top:0,behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"}))}}
    const setup=()=>{setupTables();setupBackToTop();syncWide()}
    setup()
    wideMedia.addEventListener("change",syncWide)
    document.addEventListener("click",event=>{if(wideMedia.matches&&event.target.closest(".toc-content a"))queueMicrotask(syncWide)})
    addEventListener("hashchange",()=>{if(wideMedia.matches)syncWide()})
    document.addEventListener("nav",setup)
  })()</script>`
}

function searchScript() {
  return `<script data-tracer-extension="t05-search">(()=>{const compare=(left,right)=>{const a=new TextEncoder().encode(left),b=new TextEncoder().encode(right),length=Math.min(a.length,b.length);for(let index=0;index<length;index+=1)if(a[index]!==b[index])return a[index]-b[index];return a.length-b.length},publicHref=route=>new URL(publicSiteRoot+route.replace(/^\\/+/,""),document.baseURI).pathname,setup=root=>{if(root.hasAttribute("data-public-search-ready"))return;root.setAttribute("data-public-search-ready","");const input=root.querySelector("[data-public-search-input]"),results=root.querySelector("[data-public-search-results]"),status=root.querySelector("[data-public-search-status]");if(!input||!results||!status)return;const render=async()=>{const query=input.value.trim().toLocaleLowerCase("en-US"),index=await fetchData,matches=query?index.records.filter(record=>record.search_text.toLocaleLowerCase("en-US").includes(query)).sort((left,right)=>compare(left.public_id,right.public_id)):[];results.replaceChildren();for(const record of matches){const item=document.createElement("li"),link=document.createElement("a");link.href=publicHref(record.url);link.textContent=record.title;link.dataset.publicId=record.public_id;link.dataset.nodeClass=record.node_class;item.append(link);results.append(item)}status.textContent=query?matches.length+" result"+(matches.length===1?"":"s"):"Enter a title, author, DOI, tag, heading, or visible text."};input.addEventListener("input",render)},setupAll=()=>document.querySelectorAll(".public-search").forEach(setup);setupAll();document.addEventListener("nav",setupAll)})()</script>`
}

/**
 * Explicit deterministic adapter around Quartz's existing Explorer and
 * contentIndex/fetchData seams. Quartz remains the primary renderer; the stock
 * graph is intentionally excluded because its CDN and layout are not suitable
 * for the deterministic public contract.
 */
/** @param {{entries:PublicNavigationEntry[],route:string,currentPublicId?:string|null,backlinks?:PublicNavigationEntry[]}} options */
export function createQuartzPublicNavigation({ entries, route, currentPublicId = null, backlinks = [] }) {
  const siteRoot = siteRootForRoute(route)
  const groups = normalizeEntries(entries)
  const normalizedBacklinks = normalizeEntries(backlinks).flatMap((group) => group.entries)
  if (currentPublicId !== null && !groups.some((group) => group.entries.some((entry) => entry.publicId === currentPublicId))) throw new Error("current public ID is not an Explorer entry")
  return Object.freeze({
    siteRoot,
    contentIndexScript: `<script type="application/javascript" data-persist="true">const publicSiteRoot=${scriptData(siteRoot)};const fetchData=fetch(new URL(publicSiteRoot+"static/contentIndex.json",document.baseURI)).then(data=>data.json())</script>`,
    explorerShellMarkup: `<button type="button" class="library-backdrop" aria-label="Close Library" aria-hidden="true" tabindex="-1"></button><aside class="explorer collapsed" aria-labelledby="tracer-library-heading" aria-expanded="false"><button type="button" class="explorer-toggle library-toggle" aria-label="Open Library" aria-controls="tracer-explorer-content" aria-expanded="false"><svg class="library-menu-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path class="library-menu-line library-menu-line-top" d="M3 5h18"></path><path class="library-menu-line library-menu-line-middle" d="M3 12h18"></path><path class="library-menu-line library-menu-line-bottom" d="M3 19h18"></path></svg></button><h2 id="tracer-library-heading" class="desktop-explorer">Library</h2><div id="tracer-explorer-content" class="explorer-content" aria-hidden="true"><a class="public-home-link" href="${escapeHtml(siteRoot)}">Homepage</a><ul class="explorer-ul"></ul></div></aside>`,
    tocBackdropMarkup: `<button type="button" class="toc-backdrop" aria-label="Close Table of Contents" aria-hidden="true" tabindex="-1"></button>`,
    searchMarkup: searchMarkup(),
    backToTopMarkup: `<div class="back-to-top-row"><button type="button" class="back-to-top" data-back-to-top aria-label="Back to top"><span aria-hidden="true">&#8593;</span><span>Back to top</span></button></div>`,
    graphMarkup: graphMarkup(currentPublicId),
    backlinksMarkup: backlinksMarkup(currentPublicId, normalizedBacklinks, siteRoot),
    runtimeScripts: `${explorerAndTocScript(groups)}${adaptiveReadingScript()}${searchScript()}${createPublicGraphExplorerScript(groups)}`,
    rootHref: siteRoot,
  })
}

export const publicNavigationClassGroups = classGroups
