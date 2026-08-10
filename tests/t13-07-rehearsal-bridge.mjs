// @ts-nocheck -- the cross-language rehearsal bridge owns dynamic temporary Git and Vault fixtures.
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { parse as parseYaml } from "yaml"

const siteRoot = path.resolve(import.meta.dirname, "..")
const slimBuild = path.join(siteRoot, "scripts", "slim-build.mjs")
const mappedPages = parseYaml(await readFile(path.join(siteRoot, "site-content.yml"), "utf8")).pages

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    cwd: siteRoot,
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(`fixture git command failed: ${args.join(" ")}`)
  }
  return result.stdout.trim()
}

function note(title, layout, body = "") {
  if (layout === "paper") {
    return `---
title: ${title}
type: literature-note
status: integrated
layer: content
authors:
  - Synthetic Author
year: 2024
venue: Synthetic Venue
doi: 10.0000/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}
paper_type: empirical
---

# ${title}

## One-sentence Takeaway

A bounded synthetic paper.

## Citation

Synthetic citation.

## Research Question

What does this paper show?

## Connections

${body || "No new Knowledge links."}
`
  }
  return `---
title: ${title}
type: support
layer: content
---

# ${title}

A bounded synthetic support page.
`
}

async function put(root, relative, bytes) {
  const absolute = path.join(root, ...relative.split("/"))
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, bytes)
}

async function populateVault(vault, includeNew) {
  for (const page of mappedPages) {
    await put(
      vault,
      page.source,
      note(
        path.posix.basename(page.source, ".md"),
        page.layout === "paper" ? "paper" : "support",
        "- [[Knowledge/Concepts/Flow|Flow]]",
      ),
    )
  }
  if (includeNew) {
    await put(
      vault,
      "Literature/Notes/Smith and Jones 2024 — New Study.md",
      note("New Study", "paper", "- [[Knowledge/Concepts/New Concept]]"),
    )
    await put(vault, "Knowledge/Concepts/New Concept.md", note("New Concept", "support"))
  }
}

async function copyTrackedRenderer(repo) {
  const tracked = git(siteRoot, ["ls-files"]).split(/\r?\n/u).filter(Boolean)
  for (const relative of tracked) {
    const source = path.join(siteRoot, ...relative.split("/"))
    const destination = path.join(repo, ...relative.split("/"))
    await mkdir(path.dirname(destination), { recursive: true })
    await cp(source, destination)
  }
}

async function buildBaseline(root, mapPath, vault) {
  const baseline = path.join(root, "baseline-site")
  const result = spawnSync(process.execPath, [
    slimBuild,
    "build",
    "--content-map",
    mapPath,
    "--vault-root",
    vault,
    "--work-root",
    path.join(root, "baseline-work"),
    "--output",
    baseline,
  ], {
    cwd: siteRoot,
    encoding: "utf8",
    timeout: 180_000,
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error(`fixture baseline build failed: ${result.stdout}\n${result.stderr}`)
  }
  await put(baseline, ".nojekyll", Buffer.alloc(0))
  return baseline
}

async function makeRefs(root, mapPath, vault, lane) {
  const repo = path.join(root, "git-refs")
  await mkdir(repo, { recursive: true })
  const baseline = await buildBaseline(root, mapPath, vault)

  git(repo, ["init", "-b", "main"])
  git(repo, ["config", "user.email", "fixture@example.invalid"])
  git(repo, ["config", "user.name", "T13 Rehearsal Fixture"])
  await copyTrackedRenderer(repo)
  await put(repo, "site-content.yml", await readFile(mapPath))
  git(repo, ["add", "-A"])
  git(repo, ["commit", "-m", "fixture complete renderer baseline"])
  const liveRendererSha = git(repo, ["rev-parse", "HEAD"])
  git(repo, ["branch", "live-renderer", liveRendererSha])

  if (lane === "site") {
    const stylePath = path.join(repo, "styles", "tracer-scholarly.scss")
    const style = await readFile(stylePath, "utf8")
    await writeFile(stylePath, `${style}\nbody { outline: 1px solid rgb(17, 34, 51); }\n`)
    git(repo, ["add", "styles/tracer-scholarly.scss"])
    git(repo, ["commit", "-m", "fixture output-affecting presentation change"])
  }
  const mainSha = git(repo, ["rev-parse", "refs/heads/main"])

  git(repo, ["checkout", "--orphan", "gh-pages"])
  git(repo, ["rm", "-rf", "."])
  await cp(baseline, path.join(repo, "site"), { recursive: true })
  git(repo, ["add", "site"])
  git(repo, [
    "commit",
    "-m",
    `fixture gh-pages baseline\n\nRenderer-Main-SHA: ${liveRendererSha}`,
  ])
  git(repo, ["rev-parse", "refs/heads/gh-pages"])
  return {
    repo,
    mainRef: "refs/heads/main",
    ghPagesRef: "refs/heads/gh-pages",
    mainSha,
    liveRendererSha,
  }
}

async function fixture(root, lane) {
  if (!root || !["publish", "site"].includes(lane)) {
    throw new Error("fixture requires --root and --lane publish|site")
  }
  const resolvedRoot = path.resolve(root)
  const vault = path.join(resolvedRoot, "vault")
  const map = path.join(resolvedRoot, "main-site-content.yml")
  await mkdir(vault, { recursive: true })
  await writeFile(map, await readFile(path.join(siteRoot, "site-content.yml")))
  await populateVault(vault, lane === "publish")
  const refs = await makeRefs(resolvedRoot, map, vault, lane)

  // Deliberately expose fixture inputs only. Producer result, candidate identity,
  // route diffs, lifecycle, and handoff remain owned by the real producer/plugin.
  return {
    version: 1,
    lane,
    vault_root: vault,
    git_root: refs.repo,
    main_ref: refs.mainRef,
    gh_pages_ref: refs.ghPagesRef,
  }
}

function option(argv, name) {
  const index = argv.indexOf(name)
  return index < 0 ? "" : argv[index + 1] || ""
}

const [action, ...argv] = process.argv.slice(2)
if (action !== "fixture") {
  process.stderr.write("expected fixture action\n")
  process.exitCode = 2
} else {
  try {
    const result = await fixture(option(argv, "--root"), option(argv, "--lane"))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    process.exitCode = 1
  }
}
