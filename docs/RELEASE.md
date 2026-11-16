# Releases

A release of OpenTune MCP Server (by Synchain) is one version number, one `v<version>` tag on `prod`, and four
packages built from that tag by `.github/workflows/release.yml`.

## The four packages

| Package                              | File on the release                   | Who uses it                                               | Version taken from                            |
| ------------------------------------ | ------------------------------------- | --------------------------------------------------------- | --------------------------------------------- |
| npm package `@synchain/opentune-mcp` | `synchain-opentune-mcp-<version>.tgz` | other MCP clients (`npx -y @synchain/opentune-mcp`)       | `package.json`                                |
| MCPB package                         | `opentune-mcp-<version>.mcpb`         | Claude Desktop                                            | `mcpb/manifest.json`                          |
| Claude Code plugin `opentune`        | `opentune-plugin.zip`                 | Claude Code, through the `synchain-opentune` marketplace  | `plugins/opentune/.claude-plugin/plugin.json` |
| Skills zip                           | `opentune-skills-<version>.zip`       | Claude Desktop, uploaded by the user in Claude's settings | `package.json`                                |

Every file comes with a `.sha256` file, and the release notes list the same digests.

- **One version for all four.** `package.json`, `mcpb/manifest.json` and the plugin manifest must carry the same
  `version`. A unit test (`test/unit/plugin.test.ts`) enforces it, assembling the plugin refuses a mismatch, and the
  release workflow checks that the tag is `v` followed by that version.
- **The plugin's version must change with every release.** Claude Code installs a new copy of the plugin only when its
  version string changes; a release that keeps the old version reaches nobody who already installed the plugin. Since
  the plugin version is the package version, this holds as long as every release bumps `package.json`, which it must
  anyway.
- **Why the plugin zip has no version in its name.** The marketplace entry in `.claude-plugin/marketplace.json`
  downloads `releases/latest/download/opentune-plugin.zip`, a URL that GitHub redirects to the asset of the latest
  published release. The entry therefore never changes between releases. The version is inside the zip, in
  `.claude-plugin/plugin.json`. Drafts and pre-releases are not "latest", so the marketplace keeps serving the last
  full release until the next one is published. See [ADR 0002](adr/0002-plugin-distribution.md).
- **The skills zip** (`opentune-skills-<version>.zip`) holds the instruction-only skills (`tuning-workflow`,
  `check-results`) as one zip per skill: the outer file contains `<skill>.zip` for each skill, and each of those has
  the skill's folder at its top level. The user uploads the inner `<skill>.zip` in Claude's settings (one skill per
  upload), not the outer file. Skills that need local tools (for example Python, or the `beat-grid` Node script and
  the analyzer it downloads) are only in the plugin: `lyrics-timeline` and `beat-grid`.

## Making a release

1. Bump `version` in `package.json` (and `package-lock.json`), `mcpb/manifest.json` and
   `plugins/opentune/.claude-plugin/plugin.json` to the same value, and add the release to `CHANGELOG.md`. Name the
   OpenTune builds of the release in `compatibility.json` (see [Which OpenTune build goes with this
   release](#which-opentune-build-goes-with-this-release)). Run `npm run gates`.
2. Promote the change to `dev` and then to `prod` as usual, through reviewed pull requests.
3. Optional dry run: start `release.yml` by hand (`workflow_dispatch`) on the branch. It runs the full CI, builds the
   four packages and the notes, checks the notes for AI attribution, and uploads everything as a workflow artifact
   for seven days. A dry run never creates a release and never writes to the repository.
4. The maintainer tags the `prod` commit `v<version>` and pushes the tag. `release.yml` checks that the tag names the
   package version and is on `prod`, runs the full CI through `workflow_call`, checks that `compatibility.json` has a
   record for the version, builds the packages, checks every `.sha256`, and creates a **draft** release with the four
   packages, their `.sha256` files and the generated notes (which open with "Works with OpenTune").
5. The maintainer reviews the draft and publishes it. Only then does the marketplace serve the new plugin. Publishing
   the npm package is a separate, approved step and not part of `release.yml` yet.

### Which OpenTune build goes with this release

Every release says which OpenTune build it goes with, so that nobody runs it with a build it was never checked with.
The one record is [`compatibility.json`](../compatibility.json): one entry per server version, oldest first, and the
entry of the release being prepared last, named `unreleased`. An entry gives the OTCP specification and the builds
(test build tag, upstream commit, or official release) with `verified: true` when the server was run against a real
build, and `verified: false` for "listed, not yet verified". Three things are made from it:

- the version table of `docs/COMPATIBILITY.md` and the "Which OpenTune build to use" box of `README.md` and
  `README.zh-CN.md` (generated blocks between `BEGIN GENERATED` and `END GENERATED` comments; `npm run compat:update`
  rewrites them, `npm run compat:check` fails when they differ, and a unit test does the same);
- the "Works with OpenTune" section at the top of the release notes (`scripts/release-assets.mjs notes`);
- the check of `opentune_get_status` and `opentune-mcp doctor`, which compares the running build with the record of the
  version of the server itself, or with `unreleased` when that version has no record yet (the file is bundled into the
  server).

To prepare a release, change `unreleased` into the new version number (and the builds it was checked with), run
`npm run compat:update`, and commit the file together with the regenerated blocks. `release.yml` stops before it builds
anything when `compatibility.json` has no record for the version of `package.json`, or when a generated block is out of
date, so a release cannot go out without saying which OpenTune it goes with. After the release, add a new `unreleased`
record for the next one. The `note` of an entry is plain text in English (printable ASCII, no `|`, at most 300
characters): it goes into a table. Releases that were made before this file existed have their records written from
what they shipped with; their release notes are edited by hand (`gh release edit`) by a maintainer.

### Pre-releases, patches on an older line, and re-runs

- A tag whose version has a hyphen (`v1.2.0-rc.1`) gets a draft that is also marked **pre-release**. A pre-release
  never becomes "latest", so the marketplace keeps serving the last full release. Do not clear the pre-release mark
  when publishing it.
- When you publish a patch on an older line (for example `v1.0.5` after `v1.1.0` exists), **untick "Set as the latest
  release"** in the publish dialog. Otherwise `releases/latest/download/opentune-plugin.zip` moves back to the older
  version and the marketplace rolls back.
- The draft job refuses to run when a release for the tag already exists (`gh release view`), so a re-run or a second
  push of the tag cannot leave two drafts. Delete the old draft first if the new run should replace it.

## Building the packages locally

All of these write under `dist/`, which git ignores:

| Command                   | Writes                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run build`           | `dist/opentune-mcp.mjs` (empties `dist/` first)                                            |
| `npm run plugin:build`    | `dist/plugin/` (the assembled plugin) and `dist/opentune-plugin.zip` with its `.sha256`    |
| `npm run plugin:validate` | the same, then `claude plugin validate --strict` on the plugin and on the marketplace file |
| `npm run skills:zip`      | `dist/opentune-skills-<version>.zip` with its `.sha256`                                    |
| `npm run mcpb:pack`       | `.cache/mcpb/opentune-mcp-<version>.mcpb` with its `.sha256`                               |

The plugin and skills commands use the bundle that `npm run build` wrote; run it first. To try the assembled plugin
for one session without installing it, run `claude --plugin-dir dist/plugin` (or pass `dist/opentune-plugin.zip`).

`claude plugin validate` runs the Claude Code version pinned in `scripts/claude-cli/package.json`: the `claude` on
`PATH` when it reports exactly that version, otherwise a copy installed under `.cache/tools/claude-code` from the
lockfile. Either way it runs with its own empty configuration directory under `.cache/`, so it does not touch your
Claude Code settings.

## Tests of the skills (Python)

A skill that ships Python may carry its own tests: `tests/`, `conftest.py`, `pytest.ini`, `requirements-test.txt` and
`requirements-test.lock`. None of these go into the plugin zip. CI (job `plugin`, step "Skill tests (Python, via
gates)") installs the dependencies of every such skill into one venv from the lock files only, with
`pip install --require-hashes --no-deps --only-binary=:all: -r requirements-test.lock`, puts the venv first on `PATH`
and runs `node scripts/gates.mjs --base HEAD --no-skip --only "skill tests"`. The pytest command (`python -I -m pytest`
in each skill's directory) therefore lives only in `scripts/gates.mjs`; locally, `npm run gates` runs it the same way
and reports each skill on its own (a skill whose dependencies are missing is a SKIP for that skill only, and with
`--no-skip` that is a failure). A skill with a `requirements-test.txt` and no `requirements-test.lock` fails the CI
step. Generate the lock from the skill's directory; the hashes cover every file of each pinned version, so a lock made
with the oldest Python the skill supports (3.10, which also pulls in `exceptiongroup` and `tomli`) installs on CI's
3.12 and on Windows:

```bash
pip install pip-tools
pip-compile --generate-hashes --allow-unsafe --output-file requirements-test.lock requirements-test.txt
```

Commit both files. The step logs that it found no skill with a `requirements-test.txt` and passes when none has tests.
