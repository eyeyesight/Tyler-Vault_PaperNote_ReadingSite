import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  cp,
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
const metadataPath = path.join(repoRoot, "config", "quartz-toolchain.json")

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
        rows.push([
          relative,
          "file",
          metadata.mtimeMs,
          createHash("sha256").update(await readFile(absolute)).digest("hex"),
        ])
      }
    }
  }
  await visit(root)
  return rows
}

/** @param {string} command @param {string} vault @param {string} source @param {string} output @param {string} [commandPath] */
function invoke(command, vault, source, output, commandPath = cli) {
  return spawnSync(
    process.execPath,
    [commandPath, command, "--vault-root", vault, "--source", source, "--output", output],
    { cwd: path.resolve(path.dirname(commandPath), ".."), encoding: "utf8" },
  )
}

/** @param {string} prefix */
async function sandbox(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  const vault = path.join(root, "canonical-vault")
  const source = path.join(root, "isolated-export")
  const output = path.join(root, "last-known-good")
  await Promise.all([
    mkdir(vault),
    mkdir(source),
    mkdir(output),
  ])
  await writeFile(path.join(output, "keep.txt"), "last-known-good\n")
  return { root, vault, source, output }
}

/** @param {string} name @param {string | Uint8Array} content @param {RegExp} expected */
async function assertRejectedWithoutMutation(name, content, expected) {
  const paths = await sandbox("tyler-source-reject-")
  await writeFile(path.join(paths.source, name), content)
  const before = await snapshot(paths.root)
  const result = invoke("build", paths.vault, paths.source, paths.output)
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, expected)
  assert.deepEqual(await snapshot(paths.root), before)
}

test("source preflight accepts only nested regular UTF-8 Markdown and does not mutate it", async () => {
  const paths = await sandbox("tyler-source-safe-")
  await mkdir(path.join(paths.source, "nested"))
  await writeFile(path.join(paths.source, "index.md"), "# Synthetic\n\n安全的 UTF-8 內容。\n")
  await writeFile(path.join(paths.source, "nested", "support.MD"), "# Support\n")
  const before = await snapshot(paths.root)
  const result = invoke("preflight", paths.vault, paths.source, paths.output)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /PREFLIGHT_OK/)
  assert.deepEqual(await snapshot(paths.root), before)
})

test("source preflight rejects every non-Markdown regular-file extension with zero mutation", async (t) => {
  for (const extension of ["png", "jpg", "jpeg", "gif", "tif", "tiff", "webp", "pdf", "zip", "txt"]) {
    await t.test(`.${extension}`, async () => {
      await assertRejectedWithoutMutation(`asset.${extension}`, "synthetic text\n", /SOURCE_FILE_CLASS_NOT_ALLOWED/)
    })
  }
})

test("source preflight rejects binary magic even when renamed to .md with zero mutation", async (t) => {
  const signatures = new Map([
    ["PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["JPEG", Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ["GIF", Buffer.from("GIF89a", "ascii")],
    ["TIFF-le", Buffer.from([0x49, 0x49, 0x2a, 0x00])],
    ["TIFF-be", Buffer.from([0x4d, 0x4d, 0x00, 0x2a])],
    ["WebP", Buffer.from("RIFF0000WEBP", "ascii")],
    ["PDF", Buffer.from("%PDF-1.7", "ascii")],
    ["ZIP", Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  ])
  for (const [name, signature] of signatures) {
    await t.test(name, async () => {
      await assertRejectedWithoutMutation(`${name}.md`, signature, /SOURCE_BINARY_MAGIC_NOT_ALLOWED/)
    })
  }
})

test("source preflight rejects NUL and malformed UTF-8 Markdown with zero mutation", async (t) => {
  await t.test("NUL", async () => {
    await assertRejectedWithoutMutation("nul.md", Buffer.from("safe\0unsafe", "utf8"), /SOURCE_NUL_NOT_ALLOWED/)
  })
  await t.test("invalid UTF-8", async () => {
    await assertRejectedWithoutMutation("invalid.md", Buffer.from([0x23, 0x20, 0xc3, 0x28]), /SOURCE_INVALID_UTF8/)
  })
})

test("source preflight rejects all initially unsupported image embed forms with zero mutation", async (t) => {
  const embeds = new Map([
    ["Markdown image", "# Note\n\n![alt](local.png)\n"],
    ["Markdown nested-alt image", "# Note\n\n![an [alt] label](local.png)\n"],
    ["Markdown full reference image", "# Note\n\n![alt][asset]\n\n[asset]: local.png\n"],
    ["Markdown collapsed reference image", "# Note\n\n![alt][]\n\n[alt]: local.png\n"],
    ["Markdown shortcut reference image", "# Note\n\n![asset]\n\n[asset]: local.png\n"],
    ["Markdown reference image with data URI definition", "# Note\n\n![pixel][asset]\n\n[asset]: data:image/png;base64,iVBORw0KGgo=\n"],
    ["Obsidian embed", "# Note\n\n![[local.png]]\n"],
    ["raw img", "# Note\n\n<IMG src=\"local.png\" alt=\"alt\">\n"],
  ])
  for (const [name, markdown] of embeds) {
    await t.test(name, async () => {
      await assertRejectedWithoutMutation(`${name}.md`, markdown, /SOURCE_IMAGE_EMBED_NOT_ALLOWED/)
    })
  }
})

test("source preflight rejects a nested symlink or reparse-point escape with zero mutation", async (t) => {
  const paths = await sandbox("tyler-source-link-")
  const outside = path.join(paths.root, "outside")
  const link = path.join(paths.source, "escape")
  await mkdir(outside)
  await writeFile(path.join(outside, "asset.md"), "# must not be followed\n")
  try {
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir")
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "unknown"
    t.skip(`symlink/reparse point unavailable: ${code}`)
    return
  }
  const before = await snapshot(paths.root)
  const result = invoke("build", paths.vault, paths.source, paths.output)
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /SOURCE_LINK_NOT_ALLOWED/)
  assert.deepEqual(await snapshot(paths.root), before)
})

test("build fails closed before toolchain materialization when installed default icon hash mismatches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyler-icon-mismatch-"))
  const copiedCli = path.join(root, "scripts", "site.mjs")
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"))
  const quartzRoot = path.join(root, "node_modules", "@jackyzha0", "quartz")
  const source = path.join(root, "source")
  const vault = path.join(root, "vault")
  const output = path.join(root, "output")
  await Promise.all([
    mkdir(path.dirname(copiedCli), { recursive: true }),
    mkdir(path.join(root, "config"), { recursive: true }),
    mkdir(path.join(quartzRoot, "quartz", "static"), { recursive: true }),
    mkdir(source),
    mkdir(vault),
    mkdir(output),
  ])
  await Promise.all([
    cp(cli, copiedCli),
    writeFile(path.join(root, "package.json"), '{"type":"module"}\n'),
    writeFile(path.join(root, "config", "quartz-toolchain.json"), `${JSON.stringify(metadata, null, 2)}\n`),
    writeFile(path.join(quartzRoot, "package.json"), `${JSON.stringify({ name: "@jackyzha0/quartz", version: metadata.version })}\n`),
    writeFile(path.join(quartzRoot, "quartz", "static", "icon.png"), "not the pinned icon\n"),
    writeFile(path.join(source, "index.md"), "# Synthetic\n"),
    writeFile(path.join(output, "keep.txt"), "last-known-good\n"),
  ])
  const before = await snapshot(root)
  const result = invoke("build", vault, source, output, copiedCli)
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /QUARTZ_ICON_HASH_MISMATCH/)
  assert.deepEqual(await snapshot(root), before)
})
