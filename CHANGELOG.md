# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The OTCP protocol specification in `spec/otcp/v1/` is
versioned separately and has its own changelog.

## Unreleased

## [0.1.0] - 2026-10-17

The first public version of OpenTune MCP Server (by Synchain). It implements OTCP specification `spec-v1.0.0-rc.3` and
talks to the unofficial OpenTune test build from synchain-oss/OpenTune, which has the control interface enabled; the
official OpenTune releases do not provide it yet. The release has four packages built from the same version: the npm
package `@synchain/opentune-mcp`, the MCPB package for Claude Desktop, the Claude Code plugin `opentune`, and the skills
zip for Claude Desktop.

### Added

- Project scaffold: TypeScript (strict, ESM) checked with `tsc`, eslint (typescript-eslint, type-aware) and prettier;
  vitest with v8 coverage thresholds (85% overall; 90% per file for input sanitizing, errors, OTCP framing, analysis
  and result rendering).
- `opentune-mcp` command. `--version` and `--help` print to stdout and exit. Without arguments it serves MCP over stdio
  as `opentune-mcp`, answering both the `initialize` handshake and 2026-07-28 requests.
- Single-file build `dist/opentune-mcp.mjs` (esbuild). The package has no runtime dependencies and no lifecycle
  scripts, and `THIRD-PARTY-NOTICES.md` is generated from the esbuild metafile; see
  [ADR 0001](docs/adr/0001-single-file-bundle.md).
- Local gates, `npm run gates`: lint, formatting, typecheck, unit tests with coverage, build, bundle shape, package
  contents, `npm audit`, third-party notices, stdio smoke test, gitleaks (version and sha256 pinned in
  `scripts/tools.lock.json`), privacy, AI attribution, sign-off and commit identity, README heading parity, and the
  `pull_request_target` ban. It prints a PASS / FAIL / SKIP table for the current commit.
- First tools: `opentune_get_status` (one state with a next step: READY, NOT_READY, PROTOCOL_MISMATCH, STARTING,
  RUNNING_WITHOUT_API, NOT_RUNNING, NO_API_BUILD, NOT_INSTALLED, WSL_UNSUPPORTED_RUNTIME), `opentune_get_job` and
  `opentune_cancel_job`, and MCP instructions. Running OpenTune instances are found through their discovery files
  (stale files are recognised by process id and start time), sessions on `127.0.0.1` are verified before use, an
  instance is never switched silently, and every error has one shape with a next step and a
  [troubleshooting](docs/TROUBLESHOOTING.md) link.
- `opentune-mcp doctor [--json]`: checks Node.js, WSL, the discovery directory and `OPENTUNE_MCP_OPENTUNE_PATH` without
  starting the server.
- Golden snapshots of `tools/list` and of the instructions, the generated [tool reference](docs/reference.md) and the
  `tools/list` size limits, checked by the tests and by `npm run gates`.
- `opentune_estimate_key`: estimates the key of a clip from its vocal pitch and a WAV file of the mix or the
  instrumental. For a song that changes key it also reports `local_keys` for its sections.
- Claude Code plugin `opentune` with the skills `tuning-workflow` (the tuning flow), `check-results` (checking the
  result of a tuning pass) and `lyrics-timeline`, and a skills zip for Claude Desktop, which the user uploads in
  Claude's settings. The plugin and the skills zip carry the package version.
- `lyrics-timeline` skill: word-level timing and section detection, with lyrics in Japanese, Korean, Russian and
  Western European languages, and timelines that use several vocal tracks.
- `tuning-workflow` skill: a song that changes key gets its sections found first, and each section is tuned on its
  own after the user confirms the sections.
- Project tools: `opentune_save_project`, `opentune_save_project_overwrite` (only after the user agrees to replace
  another project file) and `opentune_open_project`. OpenTune has no autosave, so the instructions and the
  `tuning-workflow` skill ask the agent to save the project regularly.

### Fixed

- `opentune_estimate_key` no longer reports a relative major or minor key as a key change.
- The lyrics timeline installs the PyTorch CUDA build that matches the GPU driver, and a secondary lookup reports a
  confidence below 0.5.
