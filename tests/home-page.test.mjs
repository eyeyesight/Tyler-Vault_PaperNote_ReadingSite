import assert from "node:assert/strict"
import test from "node:test"

import { homePageMarkdown } from "../scripts/tracer.mjs"

/** @param {number} count */
function paperRecords(count) {
  return new Map(Array.from({ length: count }, (_, index) => {
    const publicId = `paper-${index + 1}`
    return [publicId, {
      frontmatter: { title: `Paper ${index + 1}`, authors: ["Researcher"], year: 2026 },
      node: { node_class: "paper", public_id: publicId },
      route: `/papers/${publicId}/`,
    }]
  }))
}

/** @param {number} paperCount */
function renderHome(paperCount) {
  const records = paperRecords(paperCount)
  const bodies = new Map([...records.keys()].map((publicId) => [publicId, `# ${publicId}\n\n## One-sentence Takeaway\n\nSummary.`]))
  return homePageMarkdown(records, new Map(), bodies)
}

test("Featured papers only offers the full Papers library when more than six papers exist", () => {
  const sixPapers = renderHome(6)
  assert.equal((sixPapers.match(/class="paper-card"/g) ?? []).length, 6)
  assert.doesNotMatch(sixPapers, /class="featured-papers-more"/)

  const sevenPapers = renderHome(7)
  assert.equal((sevenPapers.match(/class="paper-card"/g) ?? []).length, 6)
  assert.match(sevenPapers, /class="featured-papers-more"><button type="button" data-home-library-target="paper">View papers <span aria-hidden="true">→<\/span><\/button><\/div><\/section>/)
})
