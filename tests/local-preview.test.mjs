import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("local preview serves PNG favicon assets with the image/png media type", async () => {
  const source = await readFile(new URL("../local-only/local-preview-local.mjs", import.meta.url), "utf8")
  assert.match(source, /\["\.png", "image\/png"\]/)
  assert.equal((source.match(/"Cache-Control": "no-store"/g) ?? []).length, 2)
})
