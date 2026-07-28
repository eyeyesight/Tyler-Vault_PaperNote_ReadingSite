import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

const repoRoot = path.resolve(import.meta.dirname, "..")
const cli = path.join(repoRoot, "scripts", "site.mjs")

/** @param {string} root */
async function snapshot(root) {
  /** @type {any[]} */
  const rows = []
  /** @param {string} current */
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name)
      const relative = path.relative(root, absolute)
      const metadata = await lstat(absolute)
      if (entry.isDirectory()) {
        rows.push([relative, "directory", metadata.mtimeMs])
        await visit(absolute)
      } else if (entry.isSymbolicLink()) {
        rows.push([relative, "symlink", metadata.mtimeMs, await readlink(absolute)])
      } else {
        const bytes = await readFile(absolute)
        rows.push([
          relative,
          "file",
          metadata.mtimeMs,
          createHash("sha256").update(bytes).digest("hex"),
        ])
      }
    }
  }
  await visit(root)
  return rows
}

/** @param {string} command @param {string} vaultRoot @param {string} source @param {string} output */
function invoke(command, vaultRoot, source, output) {
  return spawnSync(
    process.execPath,
    [cli, command, "--vault-root", vaultRoot, "--source", source, "--output", output],
    { cwd: repoRoot, encoding: "utf8" },
  )
}

test("every public command rejects every canonical Vault/source/output overlap with zero mutation", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "tyler-vault-guard-"))
  const vaultParent = path.join(sandbox, "canonical-container")
  const vault = path.join(vaultParent, "Canonical-Vault")
  const vaultChild = path.join(vault, "Literature", "Notes")
  const safeSource = path.join(sandbox, "isolated-export")
  const safeOutput = path.join(sandbox, "candidate-site")
  const sourceParent = path.join(sandbox, "source-parent")
  const nestedOutput = path.join(sourceParent, "candidate")
  const outputParent = path.join(sandbox, "output-parent")
  const nestedSource = path.join(outputParent, "export")
  await mkdir(vaultChild, { recursive: true })
  await mkdir(safeSource, { recursive: true })
  await mkdir(safeOutput, { recursive: true })
  await mkdir(nestedOutput, { recursive: true })
  await mkdir(nestedSource, { recursive: true })
  await writeFile(path.join(vaultChild, "do-not-touch.md"), "canonical bytes\n")
  await writeFile(path.join(safeSource, "index.md"), "# safe synthetic\n")
  await writeFile(path.join(safeOutput, "keep.txt"), "last-known-good\n")
  // Keep every possible source tree scanner-valid. A failure below must come
  // from the overlap guard, not from a coincidental source-content rejection.
  await writeFile(path.join(sourceParent, "index.md"), "# safe parent source\n")
  await writeFile(path.join(nestedOutput, "keep.md"), "# scanner-safe nested output\n")
  await writeFile(path.join(nestedSource, "index.md"), "# safe nested source\n")

  const cases = [
    ["source equals Vault root", vault, safeOutput],
    ["source is under Vault root", vaultChild, safeOutput],
    ["source is an ancestor of Vault root", vaultParent, safeOutput],
    ["output equals Vault root", safeSource, vault],
    ["output is under Vault root", safeSource, path.join(vault, "generated")],
    ["output is an ancestor of Vault root", safeSource, vaultParent],
    ["source equals output", safeSource, safeSource],
    ["source contains output", sourceParent, nestedOutput],
    ["output contains source", nestedSource, outputParent],
  ]

  for (const command of ["preflight", "build", "verify", "serve"]) {
    for (const [name, source, output] of cases) {
      await t.test(`${command}: ${name}`, async () => {
        const before = await snapshot(sandbox)
        const result = invoke(command, vault, source, output)
        assert.notEqual(result.status, 0)
        assert.match(`${result.stdout}\n${result.stderr}`, /PATH_OVERLAP_NOT_ALLOWED/)
        assert.deepEqual(await snapshot(sandbox), before)
      })
    }
  }
})

test("guard canonicalizes an existing symlink before containment comparison", async (t) => {
  if (process.platform === "win32") {
    // Directory symlinks may require Developer Mode; skip only when the host denies creation.
  }
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "tyler-vault-symlink-"))
  const vault = path.join(sandbox, "vault")
  const child = path.join(vault, "notes")
  const alias = path.join(sandbox, "alias")
  const safeOutput = path.join(sandbox, "output")
  await mkdir(child, { recursive: true })
  await mkdir(safeOutput, { recursive: true })
  try {
    await symlink(child, alias, process.platform === "win32" ? "junction" : "dir")
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "unknown"
    t.skip(`symlink unavailable: ${code}`)
    return
  }
  const before = await snapshot(sandbox)
  const result = invoke("preflight", vault, alias, safeOutput)
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /PATH_OVERLAP_NOT_ALLOWED/)
  assert.deepEqual(await snapshot(sandbox), before)
})

test("public preflight accepts isolated source/output outside canonical Vault without mutation", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "tyler-vault-safe-"))
  const vault = path.join(sandbox, "vault")
  const source = path.join(sandbox, "isolated-export")
  const output = path.join(sandbox, "candidate")
  await mkdir(vault)
  await mkdir(source)
  await writeFile(path.join(source, "index.md"), "# synthetic\n")
  const before = await snapshot(sandbox)
  const result = invoke("preflight", vault, source, output)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /PREFLIGHT_OK/)
  assert.deepEqual(await snapshot(sandbox), before)
})
