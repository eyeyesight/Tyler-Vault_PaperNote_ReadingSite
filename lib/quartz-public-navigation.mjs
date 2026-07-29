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
    const label = String(entry.label)
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
  return `<section class="public-search" role="search" aria-label="Search"><label>Search<input type="search" inputmode="search" autocomplete="off" data-public-search-input></label><p data-public-search-status aria-live="polite">Enter a title, author, DOI, tag, heading, or visible text.</p><ol data-public-search-results></ol></section>`
}

/** @param {string|null} currentPublicId */
function graphMarkup(currentPublicId) {
  const scope = currentPublicId === null ? "global" : "local"
  const suffix = scope === "global" ? "global" : `local-${currentPublicId}`
  const root = currentPublicId === null ? "" : ` data-graph-root-id="${escapeHtml(currentPublicId)}"`
  return `<section class="public-graph" id="public-graph-${escapeHtml(suffix)}" data-graph-scope="${scope}"${root} data-layout-ready="false"><h2>${scope === "global" ? "Global Graph" : "Local Graph"}</h2><svg role="img" aria-label="${scope === "global" ? "Global public graph" : "Local public graph"}"></svg></section>`
}

/** @param {string|null} currentPublicId @param {PublicNavigationEntry[]} backlinks @param {string} siteRoot */
function backlinksMarkup(currentPublicId, backlinks, siteRoot) {
  if (currentPublicId === null) return ""
  const items = backlinks.map((entry) => `<li><a href="${escapeHtml(relativePublicHref(siteRoot, entry.route))}" data-public-id="${escapeHtml(entry.publicId)}" data-node-class="${escapeHtml(entry.nodeClass)}">${escapeHtml(entry.label)}</a></li>`).join("")
  return `<div class="backlinks" data-public-backlinks data-public-id="${escapeHtml(currentPublicId)}"><h2 id="backlinks">Backlinks</h2>${items ? `<ul>${items}</ul>` : "<p>No approved backlinks.</p>"}</div>`
}

/** @param {Array<{nodeClass:string,label:string,entries:PublicNavigationEntry[]}>} groups */
function explorerAndTocScript(groups) {
  return `<script data-tracer-extension="t04">(()=>{const groups=${scriptData(groups)},publicHref=route=>new URL(publicSiteRoot+route.replace(/^\\/+/,""),document.baseURI).pathname,mobile=()=>matchMedia("(max-width: 800px)").matches,setOpen=(explorer,button,content,open)=>{explorer.classList.toggle("collapsed",!open);explorer.setAttribute("aria-expanded",String(open));button.setAttribute("aria-expanded",String(open));content.setAttribute("aria-expanded",String(open));content.style.visibility=open?"visible":"hidden";content.style.display=mobile()?(open?"":"none"):"";content.style.transform=open?"translateX(0)":"translateX(-100vw)";document.documentElement.classList.toggle("mobile-no-scroll",mobile()&&open)},renderGroups=list=>{const signature=groups.flatMap(group=>group.entries.map(entry=>entry.publicId)).join("\\0");if(list.dataset.publicExplorerSignature===signature&&list.querySelectorAll("[data-tracer-entry]").length===groups.reduce((count,group)=>count+group.entries.length,0))return;list.replaceChildren();for(const group of groups){const groupItem=document.createElement("li"),heading=document.createElement("span"),entriesList=document.createElement("ul");groupItem.className="public-class-group";groupItem.dataset.nodeClass=group.nodeClass;heading.className="public-class-group-label";heading.textContent=group.label;entriesList.className="public-class-group-entries";for(const entry of group.entries){const item=document.createElement("li"),link=document.createElement("a");item.setAttribute("data-tracer-entry","");link.href=publicHref(entry.route);link.className="nav-file-title tree-item-self";link.textContent=entry.label;link.dataset.publicId=entry.publicId;link.dataset.nodeClass=entry.nodeClass;item.append(link);entriesList.append(item)}groupItem.append(heading,entriesList);list.append(groupItem)}list.dataset.publicExplorerSignature=signature},setupExplorer=()=>document.querySelectorAll(".explorer").forEach(explorer=>{const button=explorer.querySelector(".mobile-explorer"),content=explorer.querySelector(".explorer-content"),list=explorer.querySelector(".explorer-ul");if(!button||!content||!list)return;button.classList.remove("hide-until-loaded");renderGroups(list);if(!button.hasAttribute("data-tracer-bound")){button.setAttribute("data-tracer-bound","true");new MutationObserver(()=>renderGroups(list)).observe(list,{childList:true,subtree:true});setOpen(explorer,button,content,!mobile());button.addEventListener("click",event=>{if(!mobile())return;const open=button.getAttribute("aria-expanded")!=="true";event.preventDefault();event.stopImmediatePropagation();setOpen(explorer,button,content,open);setTimeout(()=>setOpen(explorer,button,content,open),0)},true);document.addEventListener("keydown",event=>{if(event.key==="Escape"&&mobile()&&button.getAttribute("aria-expanded")==="true"){setOpen(explorer,button,content,false);button.focus()}},true)}}),setTocOpen=(button,content,open)=>{button.classList.toggle("collapsed",!open);button.setAttribute("aria-expanded",String(open));content.classList.toggle("collapsed",!open);content.setAttribute("aria-expanded",String(open));content.style.display=open?"":"none";content.style.visibility=open?"visible":"hidden"},setupToc=()=>{document.querySelectorAll("button.toc-header").forEach(button=>{const content=document.getElementById(button.getAttribute("aria-controls"))??button.nextElementSibling;if(!content)return;if(!button.hasAttribute("data-tracer-toc-bound")){button.setAttribute("data-tracer-toc-bound","true");button.addEventListener("click",()=>setTimeout(()=>setTocOpen(button,content,button.getAttribute("aria-expanded")==="true"),0))}if(!mobile())setTocOpen(button,content,true)});if(!document.documentElement.hasAttribute("data-tracer-toc-escape-bound")){document.documentElement.setAttribute("data-tracer-toc-escape-bound","true");document.addEventListener("keydown",event=>{if(event.key!=="Escape"||!mobile())return;document.querySelectorAll('button.toc-header[aria-expanded="true"]').forEach(button=>{const content=document.getElementById(button.getAttribute("aria-controls"))??button.nextElementSibling;if(content){setTocOpen(button,content,false);button.focus()}})},true)}},setup=()=>{setupExplorer();setupToc()};setup();window.addEventListener("load",()=>setTimeout(setup,0),{once:true});document.addEventListener("nav",setup)})()</script>`
}

function searchScript() {
  return `<script data-tracer-extension="t05-search">(()=>{const compare=(left,right)=>{const a=new TextEncoder().encode(left),b=new TextEncoder().encode(right),length=Math.min(a.length,b.length);for(let index=0;index<length;index+=1)if(a[index]!==b[index])return a[index]-b[index];return a.length-b.length},publicHref=route=>new URL(publicSiteRoot+route.replace(/^\\/+/,""),document.baseURI).pathname,setup=root=>{if(root.hasAttribute("data-public-search-ready"))return;root.setAttribute("data-public-search-ready","");const input=root.querySelector("[data-public-search-input]"),results=root.querySelector("[data-public-search-results]"),status=root.querySelector("[data-public-search-status]");if(!input||!results||!status)return;const render=async()=>{const query=input.value.trim().toLocaleLowerCase("en-US"),index=await fetchData,matches=query?index.records.filter(record=>record.search_text.toLocaleLowerCase("en-US").includes(query)).sort((left,right)=>compare(left.public_id,right.public_id)):[];results.replaceChildren();for(const record of matches){const item=document.createElement("li"),link=document.createElement("a");link.href=publicHref(record.url);link.textContent=record.title;link.dataset.publicId=record.public_id;link.dataset.nodeClass=record.node_class;item.append(link);results.append(item)}status.textContent=query?matches.length+" result"+(matches.length===1?"":"s"):"Enter a title, author, DOI, tag, heading, or visible text."};input.addEventListener("input",render)},setupAll=()=>document.querySelectorAll(".public-search").forEach(setup);setupAll();document.addEventListener("nav",setupAll)})()</script>`
}

function graphScript() {
  return `<script data-tracer-extension="t05-graph">(()=>{const ns="http://www.w3.org/2000/svg",graphData=fetch(new URL(publicSiteRoot+"graph.json",document.baseURI)).then(response=>{if(!response.ok)throw new Error("public graph unavailable");return response.json()}),publicHref=route=>new URL(publicSiteRoot+route.replace(/^\\/+/,""),document.baseURI).pathname,compare=(left,right)=>{const a=new TextEncoder().encode(left),b=new TextEncoder().encode(right),length=Math.min(a.length,b.length);for(let index=0;index<length;index+=1)if(a[index]!==b[index])return a[index]-b[index];return a.length-b.length},svgElement=(name,attributes={})=>{const element=document.createElementNS(ns,name);for(const [key,value] of Object.entries(attributes))element.setAttribute(key,String(value));return element},setup=async root=>{if(root.hasAttribute("data-graph-bound"))return;root.setAttribute("data-graph-bound","");const contract=await graphData,scope=root.dataset.graphScope,rootId=root.dataset.graphRootId??null,selected=new Set();if(scope==="global")contract.nodes.forEach(node=>selected.add(node.public_id));else{selected.add(rootId);contract.edges.forEach(edge=>{if(edge.source===rootId)selected.add(edge.target);if(edge.target===rootId)selected.add(edge.source)})}const nodes=contract.nodes.filter(node=>selected.has(node.public_id)).sort((left,right)=>compare(left.public_id,right.public_id)),edges=contract.edges.filter(edge=>selected.has(edge.source)&&selected.has(edge.target)).sort((left,right)=>compare(left.source+"\\0"+left.target,right.source+"\\0"+right.target)),svg=root.querySelector("svg"),positions=new Map();svg.replaceChildren();for(const edge of edges)svg.append(svgElement("line",{class:"public-graph-edge","data-graph-edge-source":edge.source,"data-graph-edge-target":edge.target}));for(const node of nodes){const group=svgElement("g",{id:root.id+"-node-"+node.public_id,"data-graph-node-id":node.public_id}),link=svgElement("a",{href:publicHref(node.url)}),glyph=svgElement("circle",{class:"public-graph-glyph",r:7}),label=svgElement("text",{class:"public-graph-label"}),title=svgElement("title");label.textContent=node.title;title.textContent=node.title;link.append(glyph,label,title);group.append(link);svg.append(group)}const layout=()=>{const width=Math.max(240,Math.floor(root.clientWidth)),ideal=Math.max(1,Math.ceil(Math.sqrt(nodes.length))),columns=width<620?1:Math.min(ideal,Math.max(1,Math.floor(width/250))),cellWidth=width/columns,rowHeight=54;nodes.forEach((node,index)=>positions.set(node.public_id,{x:(index%columns)*cellWidth+18,y:32+Math.floor(index/columns)*rowHeight}));const rows=Math.ceil(nodes.length/columns),height=Math.max(88,rows*rowHeight+16);svg.setAttribute("viewBox","0 0 "+width+" "+height);svg.setAttribute("height",String(height));for(const group of svg.querySelectorAll("[data-graph-node-id]")){const point=positions.get(group.dataset.graphNodeId),glyph=group.querySelector(".public-graph-glyph"),label=group.querySelector(".public-graph-label");glyph.setAttribute("cx",String(point.x));glyph.setAttribute("cy",String(point.y));label.setAttribute("x",String(point.x+16));label.setAttribute("y",String(point.y+5))}for(const edge of svg.querySelectorAll("[data-graph-edge-source]")){const source=positions.get(edge.dataset.graphEdgeSource),target=positions.get(edge.dataset.graphEdgeTarget);edge.setAttribute("x1",String(source.x));edge.setAttribute("y1",String(source.y));edge.setAttribute("x2",String(target.x));edge.setAttribute("y2",String(target.y))}root.dataset.layoutReady="true"};layout();new ResizeObserver(layout).observe(root)},setupAll=()=>document.querySelectorAll(".public-graph").forEach(root=>setup(root));setupAll();document.addEventListener("nav",setupAll)})()</script>`
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
    explorerShellMarkup: `<aside class="explorer" aria-label="Explorer" aria-expanded="true"><button type="button" class="mobile-explorer" aria-expanded="true">Explorer</button><div class="explorer-content" aria-expanded="true"><ul class="explorer-ul"></ul></div></aside>`,
    searchMarkup: searchMarkup(),
    graphMarkup: graphMarkup(currentPublicId),
    backlinksMarkup: backlinksMarkup(currentPublicId, normalizedBacklinks, siteRoot),
    runtimeScripts: `${explorerAndTocScript(groups)}${searchScript()}${graphScript()}`,
    rootHref: siteRoot,
  })
}

export const publicNavigationClassGroups = classGroups
