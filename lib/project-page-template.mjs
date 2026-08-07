/**
 * The project-owned HTML page structure shared by the Phase 1 paper and support
 * pages. Quartz still supplies the surrounding document; this module owns the
 * structural seams that make a mapped page a public project page.
 *
 * @typedef {{backlinksMarkup:string,graphMarkup:string,runtimeScripts:string}} ProjectPageNavigation
 * @typedef {{name:"paper"|"support",render:(html:string,navigation:ProjectPageNavigation)=>string}} ProjectPageTemplate
 */

export class ProjectPageTemplateError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** @param {string} html @param {"paper"|"support"} layout @param {ProjectPageNavigation} navigation */
function renderSharedProjectPageStructure(html, layout, navigation) {
  let normalized = html
  if (/\bdata-tracer-template=/.test(normalized)) {
    throw new ProjectPageTemplateError("CANDIDATE_TEMPLATE_MARKER_INVALID", "generated body already contains a template marker")
  }
  normalized = normalized.replace(/<body\b/, `<body data-tracer-template="${layout}"`)
  if (!normalized.includes(`<body data-tracer-template="${layout}"`)) {
    throw new ProjectPageTemplateError("CANDIDATE_TEMPLATE_MARKER_INVALID", "generated content route lacks a body element")
  }

  const beforeBacklinks = normalized
  normalized = normalized.replace(/<h2\b[^>]*id="backlinks"[^>]*>[\s\S]*?<\/h2>\s*(?:<ul>[\s\S]*?<\/ul>|<p>[\s\S]*?<\/p>)/, navigation.backlinksMarkup)
  if (normalized === beforeBacklinks) {
    throw new ProjectPageTemplateError("CANDIDATE_BACKLINKS_INVALID", "generated content route lacks the project-owned backlinks surface")
  }

  const beforeGraph = normalized
  normalized = normalized.replace("</article>", `${navigation.graphMarkup}</article>`)
  if (normalized === beforeGraph) {
    throw new ProjectPageTemplateError("CANDIDATE_GRAPH_INVALID", "generated public page lacks an article graph surface")
  }
  return normalized.replace("</body>", `${navigation.runtimeScripts}</body>`)
}

/** @param {string} html @param {ProjectPageNavigation} navigation */
function renderPaperPageTemplate(html, navigation) {
  return renderSharedProjectPageStructure(html, "paper", navigation)
}

/** @param {string} html @param {ProjectPageNavigation} navigation */
function renderSupportPageTemplate(html, navigation) {
  return renderSharedProjectPageStructure(html, "support", navigation)
}

/** @type {ProjectPageTemplate} */
const paperPageTemplate = Object.freeze({ name: "paper", render: renderPaperPageTemplate })
/** @type {ProjectPageTemplate} */
const supportPageTemplate = Object.freeze({ name: "support", render: renderSupportPageTemplate })

/** @param {unknown} layout @returns {ProjectPageTemplate} */
export function selectProjectPageTemplate(layout) {
  if (layout === "paper") return paperPageTemplate
  if (layout === "support") return supportPageTemplate
  throw new ProjectPageTemplateError("LAYOUT_INVALID", "site-content.yml layout has no project-owned template")
}
