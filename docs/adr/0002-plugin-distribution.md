# ADR 0002: Distribute the Claude Code plugin as a release asset behind a fixed marketplace entry

- Status: accepted
- Date: 2026-10-16

## Context

The main way to install OpenTune MCP Server in Claude Code is a plugin, `opentune`, that holds the MCP server and the
skills that guide the editing workflow. Its MCP configuration starts the single-file bundle of
[ADR 0001](0001-single-file-bundle.md) with `node ${CLAUDE_PLUGIN_ROOT}/servers/opentune-mcp.mjs`, so the installed
plugin must contain that bundle, built from the same commit and carrying the same version as the plugin.

The bundle is a build output. Committing it to `feature/v1` or `dev` would make every pull request that touches
`src/` either rebuild and commit it (and conflict with every other such pull request) or leave the committed copy out
of date. The plugin must still be installable with the plain commands

```text
claude plugin marketplace add synchain-oss/opentune-mcp-server
claude plugin install opentune@synchain-opentune
```

which read `.claude-plugin/marketplace.json` from the default branch. Only a release (a `v*` tag, handled by
`.github/workflows/release.yml`) may produce anything that is written to the repository or to a GitHub release, and a
dry run of the release workflow must write nothing.

A marketplace entry names where Claude Code fetches the plugin from. The source types are a relative path inside the
marketplace repository, `github` (a repository, optionally at a `ref` or `sha`), `url` (any git repository),
`git-subdir` (a subdirectory of a git repository), `npm` (a package), `archive` (a zip over HTTPS, optionally pinned
by `sha256`) and `command` (a directory printed by a command on the user's machine). For every source except
`command`, Claude Code takes the plugin's version from its `plugin.json` first, and installs a new copy only when that
version changes.

## Decision

1. **The plugin's sources live in `plugins/opentune/`:** `.claude-plugin/plugin.json`, `.mcp.json`, `skills/`, and an
   empty `servers/` whose `.gitignore` keeps any bundle out of git.
2. **The assembled plugin is built, never committed.** `scripts/plugin.mjs` copies the sources, puts
   `dist/opentune-mcp.mjs` into `servers/`, adds `LICENSE` and `THIRD-PARTY-NOTICES.md` (the bundle inlines
   third-party code), and zips the result deterministically (sorted entries, fixed timestamps, stored), like the MCPB
   package. `npm run plugin:build` writes it under `dist/`.
3. **Each release attaches the zip as `opentune-plugin.zip`.** `release.yml` builds it from the tag after the full CI
   has passed, next to the npm tarball, the MCPB package and the skills zip, all of one version, each with a `.sha256`
   file, and creates a draft release. Publishing the draft is a maintainer's step.
4. **The marketplace entry is an `archive` source with a fixed URL,**
   `https://github.com/synchain-oss/opentune-mcp-server/releases/latest/download/opentune-plugin.zip`. GitHub
   redirects it to that asset of the latest published release; drafts and pre-releases are skipped. The entry sets no
   version: the version inside the zip is the one that counts.
5. **Names:** marketplace `synchain-opentune`, plugin `opentune`, MCP server `opentune`; none contains a word that
   Claude Code or claude.ai reserves (`claude`, `anthropic`). The plugin declares one option, `opentune_path`
   (type `file`, optional), with the title and description of the MCPB package's option, and passes it to the server
   as `OPENTUNE_MCP_OPENTUNE_PATH`.

Measured with Claude Code 2.1.301: while `opentune_path` is not set, `${user_config.opentune_path}` is replaced by the
empty string, with or without `"default": ""`, and the server still starts. The server treats an empty value as not
configured, so `opentune_get_status` reports `NOT_INSTALLED` with a next step for the user, as it does in every other
client.

## Rejected alternatives

- **Relative path to `plugins/opentune` with the bundle committed.** The simplest layout, but every change to the
  server would need a rebuilt, committed bundle, which conflicts between pull requests and can drift from `src/`.
- **Relative path, with the release workflow committing the assembled plugin to a distribution branch** (users add
  `synchain-oss/opentune-mcp-server#<branch>`). It needs a workflow with permission to push, a new protected branch
  and rules for its bot commits, and users who add the repository without the `#<branch>` suffix get a plugin without
  a server.
- **`github` or `git-subdir` source pinned to the release tag.** The tagged commit on `prod` does not contain the
  bundle either, so this works only together with committing build outputs.
- **`npm` source.** The npm package would have to carry the plugin layout and the skills, which changes the published
  npm contents fixed by ADR 0001, or a second npm package would need its own trusted-publishing setup.
- **`archive` source with a versioned URL and a `sha256` pin.** It pins the exact bytes, but the marketplace file
  would change with every release, and between merging that change and publishing the release the default branch
  would point at an asset that does not exist yet. Because the zip is deterministic, this remains possible later if
  pinning becomes a requirement.
- **`command` source.** It runs a command on the user's machine at every session start, which this project has no
  reason to ask for.

## Consequences

- Ordinary pull requests never touch build outputs; only the release workflow produces the plugin zip, and a dry run
  only uploads it as a workflow artifact.
- What users install is always a zip that `release.yml` built from a tag, together with npm and MCPB packages of the
  same version (enforced by `test/unit/plugin.test.ts` and by the assembly itself).
- Every release must change the version, as [docs/RELEASE.md](../RELEASE.md) says; otherwise Claude Code keeps the
  copy users already have.
- The download is not pinned by `sha256`: its integrity rests on HTTPS and on the GitHub release, and the release
  notes list the digest for anyone who checks by hand.
- Until the first release is published, the marketplace can be added but `claude plugin install` fails, because the
  asset does not exist yet.
- The plugin runs the server with the `node` on `PATH`, so it needs Node.js 22 or later; Claude Code itself does not
  provide one.
- Claude Desktop's chat ignores the MCP server of a plugin; Desktop users install the MCPB package for the tools and
  upload the skills zip for the guidance.
- `claude plugin validate --strict` runs on the assembled plugin and on the marketplace file in the local gates and in
  the full CI, with the Claude Code version pinned in `scripts/claude-cli/`.
