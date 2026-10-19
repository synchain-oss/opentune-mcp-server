# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The OTCP protocol specification in `spec/otcp/v1/` is
versioned separately and has its own changelog.

## Unreleased

### Changed

- The review workflows are named after the model they run: `Claude PR Review (Opus 5.5)`,
  `PR Agent (DeepSeek V4.1 Flash)` and `PR Agent (Claude Haiku 5.5)`. The check names are unchanged.
  The workflow test that requires every call of `Synchain-oss/ci-workflows` to pin the same commit now
  also counts a call that spells the owner or repository in another case.
- The shared review workflows are pinned to `v1.3.1`. The Claude Haiku PR-Agent runs at effort `high`
  instead of `max`, which produced 50–90k output tokens per call and repeatedly hit the 900 s timeout.
- The review bots are now thin callers of the shared reusable workflows in `Synchain-oss/ci-workflows`,
  pinned to a commit. `claude-review.yml` passes only this repository's focus list and extra prompt;
  `pr-agent.yml` (DeepSeek V4.1 Flash through OpenCode Go, pull requests into `dev`) passes its ignore
  list (lock files and the generated `docs/reference.md`) and the untrusted-data declaration. A new
  `pr-agent-claude.yml` runs a second PR-Agent on Claude Haiku 5.5 for pull requests into every base; on
  `dev` it only adds review and suggestion comments. Both PR-Agents stay behind the `ENABLE_PR_AGENT`
  switch. PR-Agent now runs a digest-pinned image, never falls back to another model, and waits up to
  900 s per call without retrying. Pull requests from Dependabot and `dev` → `prod` promotions are no
  longer reviewed automatically; a maintainer can still comment `/review`, which refuses pull requests
  that touch `.github/workflows/`. `review-dispatch.yml` keeps its own steps and uses the shared prompt
  layout with the same focus list and extra prompt. (#69)
- Review bot moved from a direct DeepSeek endpoint to the OpenCode Go gateway
  (`https://opencode.ai/zen/go`, model `deepseek-v4.1-flash`). Notes that carried over: the
  gateway only accepts the bare model id (a `[1M]` suffix is rejected as "Model is unavailable",
  while the bare id already is the 1M-context model), it requires a session header, and PR-Agent
  v0.39.0 does not implement `config.max_output_tokens`, so the output cap comes from
  `DEFAULT_ANTHROPIC_CHAT_MAX_TOKENS` instead. The `base == 'dev'` gate and the
  `ENABLE_PR_AGENT` switch already existed and are unchanged by this PR. (#63)

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
- Status and jobs: `opentune_get_status` (one state with a next step: READY, NOT_READY, PROTOCOL_MISMATCH, STARTING,
  RUNNING_WITHOUT_API, NOT_RUNNING, NO_API_BUILD, NOT_INSTALLED, WSL_UNSUPPORTED_RUNTIME), `opentune_get_job` and
  `opentune_cancel_job`, and MCP instructions. Running OpenTune instances are found through their discovery files
  (stale files are recognised by process id and start time), sessions on `127.0.0.1` are verified before use, an
  instance is never switched silently, and every error has one shape with a next step and a
  [troubleshooting](docs/TROUBLESHOOTING.md) link.
- Launching: `opentune_launch` starts the OpenTune that `OPENTUNE_MCP_OPENTUNE_PATH` points to, and only an OpenTune
  build with the control interface.
- Reading a project: `opentune_get_project`, `opentune_get_notes`, `opentune_get_clip_details` and
  `opentune_get_settings` show the tracks and clips, the notes of a clip, the details of one clip and the OpenTune
  settings, without changing anything.
- Analysis: `opentune_analyze_pitch` measures the pitch of a clip, so a clip can be compared before and after tuning.
  `opentune_estimate_key` estimates the key of a clip from its vocal pitch and a WAV file of the mix or the
  instrumental; a relative major or minor key is not reported as a key change, and for a song that changes key it also
  reports `local_keys` for its sections.
- Editing: `opentune_set_clip` changes the settings of a clip, `opentune_autotune_range` tunes a range of a clip,
  `opentune_edit_notes` changes notes and `opentune_edit_timing` changes timing. `opentune_undo` and `opentune_redo`
  step back and forward through the steps that can be undone.
- Audio files: `opentune_open_audio` opens an audio file in OpenTune, and `opentune_export_audio` exports audio. It
  only writes `.wav` files, renames the file when the name is taken, and never overwrites a file.
- Project files: `opentune_save_project`, `opentune_save_project_overwrite` (only after the user agrees to replace
  another project file) and `opentune_open_project`. OpenTune has no autosave, so the instructions and the
  `tuning-workflow` skill ask the agent to save the project regularly.
- `opentune-mcp doctor [--json]`: checks Node.js, WSL, the discovery directory and `OPENTUNE_MCP_OPENTUNE_PATH` without
  starting the server. `opentune-mcp doctor --client <name>` prints the configuration for an MCP client instead.
- MCPB package for Claude Desktop, and the Claude Code plugin `opentune` with a marketplace entry. The plugin, the MCPB
  package and the skills zip carry the package version.
- Skills, installed with the plugin and also as a skills zip for Claude Desktop, which the user uploads in Claude's
  settings: `tuning-workflow` (the tuning flow; a song that changes key gets its sections found first, and each section
  is tuned on its own after the user confirms the sections), `check-results` (checking the result of a tuning pass) and
  `lyrics-timeline` (word-level timing and section detection, with lyrics in 11 languages: Mandarin, Cantonese,
  English, German, Spanish, French, Italian, Portuguese, Russian, Korean and Japanese, and timelines that use several
  vocal tracks; lines found only by a second look at the leftover audio get a confidence below 0.5, so the agent asks
  the user before using them; with an NVIDIA GPU whose driver supports CUDA 12.6 or newer it offers the PyTorch CUDA build,
  and otherwise the CPU build, in both cases only after the user agrees to the download).
- The OTCP specification `spec-v1.0.0-rc.3` with its schemas and test vectors, a mock OpenTune that implements it, and
  contract tests that run the tools against both.
- Golden snapshots of `tools/list` and of the instructions, the generated [tool reference](docs/reference.md) and the
  `tools/list` size limits, checked by the tests and by `npm run gates`.

[0.1.0]: https://github.com/synchain-oss/opentune-mcp-server/releases/tag/v0.1.0
