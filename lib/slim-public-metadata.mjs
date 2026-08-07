const publicPaperFields = Object.freeze([
  "title",
  "authors",
  "year",
  "venue",
  "doi",
  "paper_type",
  "author_keywords",
  "reader_keywords",
])

/**
 * Project only the fields that are allowed to influence public paper metadata.
 * The returned object is ordinary data; workflow/frontmatter extensions are
 * never copied through by default.
 * @param {Record<string, unknown>} frontmatter
 */
export function publicMetadata(frontmatter) {
  /** @type {Record<string, unknown>} */
  const projected = {}
  for (const key of publicPaperFields) {
    if (!Object.hasOwn(frontmatter, key)) continue
    const value = frontmatter[key]
    if (Array.isArray(value)) projected[key] = value.map((entry) => String(entry))
    else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") projected[key] = value
  }
  return Object.freeze(projected)
}

export { publicPaperFields }
