import assert from "node:assert/strict"
import test from "node:test"

import { prepareContentPrivatePreview } from "../lib/content-private-preview.mjs"

test("accepts the Hermes runtime-owned opaque operation id without rewriting it", async () => {
  const operationId = "a".repeat(32)
  const result = await prepareContentPrivatePreview({
    operationId,
    vaultRoot: "Z:/t13-missing-vault",
  })

  assert.equal(result.operation_id, operationId)
  assert.notEqual(result.error_code, "OPERATION_ID_INVALID")
  assert.equal(result.status, "needs_attention")
})
