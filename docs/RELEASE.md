# Releases

A release of OpenTune MCP Server (by Synchain) is one version number, one `v<version>` tag on `prod`, and four
packages built from that tag by `.github/workflows/release.yml`.

## The four packages

| Package                              | File on the release                   | Who uses it                                              | Version taken from                            |
| ------------------------------------ | ------------------------------------- | -------------------------------------------------------- | --------------------------------------------- |
| npm package `@synchain/opentune-mcp` | `synchain-opentune-mcp-<version>.tgz` | other MCP clients (`npx -y @synchain/opentune-mcp`)      | `package.json`                                |
| MCPB package                         | `opentune-mcp-<version>.mcpb`         | Claude Desktop                                           | `mcpb/manifest.json`                          |
| Claude Code plugin `opentune`        | `opentune-plugin.zip`                 | Claude Code, through the `synchain-opentune` marketplace | `plugins/opentune/.claude-plugin/plugin.json` |
| Skills zip                           | `opentune-skills-<version>.zip`       | claude.ai and Claude Desktop, uploaded by the user       | `package.json`                                |

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
- **The skills zip** holds the instruction-only skills (`tuning-workflow`, `check-results`), one upload-ready zip per
  skill. Skills that need local tools (for example Python) are only in the plugin.

## Making a release

1. Bump `version` in `package.json` (and `package-lock.json`), `mcpb/manifest.json` and
   `plugins/opentune/.claude-plugin/plugin.json` to the same value, and add the release to `CHANGELOG.md`. Run
   `npm run gates`.
2. Promote the change to `dev` and then to `prod` as usual, through reviewed pull requests.
3. Optional dry run: start `release.yml` by hand (`workflow_dispatch`) on the branch. It runs the full CI, builds the
   four packages and the notes, checks the notes for AI attribution, and uploads everything as a workflow artifact
   for seven days. A dry run never creates a release and never writes to the repository.
4. The maintainer tags the `prod` commit `v<version>` and pushes the tag. `release.yml` checks that the tag names the
   package version and is on `prod`, runs the full CI through `workflow_call`, builds the packages, checks every
   `.sha256`, and creates a **draft** release with the four packages, their `.sha256` files and the generated notes.
5. The maintainer reviews the draft and publishes it. Only then does the marketplace serve the new plugin. Publishing
   the npm package is a separate, approved step and not part of `release.yml` yet.

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
