"use strict"

const safe = require("brace-expansion-safe")
const legacy = safe.expand

if (typeof legacy !== "function") {
  throw new TypeError("patched brace-expansion does not expose expand()")
}

// minimatch 3 expects the historical CommonJS package itself to be callable,
// while minimatch 10 statically imports the modern expand named export.
module.exports = legacy
Object.assign(module.exports, safe)
module.exports.expand = safe.expand
