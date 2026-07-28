import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

const repoRoot = path.resolve(import.meta.dirname, "..")
const cli = path.join(repoRoot, "scripts", "site.mjs")
const homeMarker = "This page contains synthetic, non-research content used only to verify the pinned Quartz build."
const supportMarker = "This is a synthetic fixture. It is not evidence and it is not sourced from Tyler-Vault."

/** @param {string} vault @param {string} source @param {string} output */
function invokeVerify(vault, source, output) {
  return spawnSync(
    process.execPath,
    [cli, "verify", "--vault-root", vault, "--source", source, "--output", output],
    { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
  )
}

async function makeSandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tyler-output-verify-"))
  const vault = path.join(root, "vault")
  const source = path.join(root, "source")
  const output = path.join(root, "output")
  await Promise.all([mkdir(vault), mkdir(source), mkdir(path.join(output, "static"), { recursive: true })])
  await writeFile(path.join(source, "index.md"), "# Scanner-safe synthetic source\n")
  return { root, vault, source, output }
}

/** @param {string} output */
async function writeValidOutput(output) {
  await Promise.all([
    writeFile(path.join(output, "index.html"), `<main>${homeMarker}</main>\n`),
    writeFile(path.join(output, "support-node.html"), `<main>${supportMarker}</main>\n`),
    writeFile(path.join(output, "favicon.ico"), Buffer.from([0x00, 0x00, 0x01, 0x00])),
    writeFile(path.join(output, "static", "contentIndex.json"), `${JSON.stringify({
      index: { slug: "index", title: "Synthetic Reading Site" },
      "support-node": { slug: "support-node", title: "Synthetic Support Node" },
    })}\n`),
  ])
}

/** @param {(paths: Awaited<ReturnType<typeof makeSandbox>>) => Promise<void>} arrange @param {RegExp} code */
async function assertVerifyRejected(arrange, code) {
  const paths = await makeSandbox()
  try {
    await arrange(paths)
    const result = invokeVerify(paths.vault, paths.source, paths.output)
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout, /VERIFY_OK/)
    assert.match(`${result.stdout}\n${result.stderr}`, code)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
}

test("verify rejects a forged index carrying only the home marker", async () => {
  await assertVerifyRejected(async ({ output }) => {
    await writeFile(path.join(output, "index.html"), `<main>${homeMarker}</main>\n`)
  }, /VERIFY_MISSING_SUPPORT/)
})

test("verify rejects an otherwise complete output missing the support page", async () => {
  await assertVerifyRejected(async ({ output }) => {
    await writeValidOutput(output)
    await rm(path.join(output, "support-node.html"))
  }, /VERIFY_MISSING_SUPPORT/)
})

test("verify rejects a damaged exact home-page marker", async () => {
  await assertVerifyRejected(async ({ output }) => {
    await writeValidOutput(output)
    await writeFile(path.join(output, "index.html"), "<main>Synthetic Reading Site</main>\n")
  }, /VERIFY_INDEX_MARKER/)
})

test("verify rejects a damaged exact support-page marker", async () => {
  await assertVerifyRejected(async ({ output }) => {
    await writeValidOutput(output)
    await writeFile(path.join(output, "support-node.html"), "<main>Synthetic Support Node</main>\n")
  }, /VERIFY_SUPPORT_MARKER/)
})

test("verify rejects a missing content index", async () => {
  await assertVerifyRejected(async ({ output }) => {
    await writeValidOutput(output)
    await rm(path.join(output, "static", "contentIndex.json"))
  }, /VERIFY_MISSING_CONTENT_INDEX/)
})

test("verify rejects a damaged content index", async () => {
  await assertVerifyRejected(async ({ output }) => {
    await writeValidOutput(output)
    await writeFile(path.join(output, "static", "contentIndex.json"), "{not-json\n")
  }, /VERIFY_INVALID_CONTENT_INDEX/)
})

test("verify rejects an empty content index", async () => {
  await assertVerifyRejected(async ({ output }) => {
    await writeValidOutput(output)
    await writeFile(path.join(output, "static", "contentIndex.json"), "")
  }, /VERIFY_EMPTY_CONTENT_INDEX/)
})

test("verify rejects a content index missing a synthetic route identity", async () => {
  await assertVerifyRejected(async ({ output }) => {
    await writeValidOutput(output)
    await writeFile(path.join(output, "static", "contentIndex.json"), '{"index":{"slug":"index","title":"Synthetic Reading Site"}}\n')
  }, /VERIFY_CONTENT_IDENTITIES/)
})

test("verify rejects a missing favicon", async () => {
  await assertVerifyRejected(async ({ output }) => {
    await writeValidOutput(output)
    await rm(path.join(output, "favicon.ico"))
  }, /VERIFY_MISSING_FAVICON/)
})

test("verify rejects an empty favicon", async () => {
  await assertVerifyRejected(async ({ output }) => {
    await writeValidOutput(output)
    await writeFile(path.join(output, "favicon.ico"), "")
  }, /VERIFY_EMPTY_FAVICON/)
})

test("verify keeps rejecting Markdown and PDF files in otherwise valid output", async (t) => {
  for (const name of ["leaked.md", "paper.PDF"]) {
    await t.test(name, async () => {
      await assertVerifyRejected(async ({ output }) => {
        await writeValidOutput(output)
        await writeFile(path.join(output, name), "forbidden\n")
      }, /VERIFY_FORBIDDEN_OUTPUT/)
    })
  }
})
