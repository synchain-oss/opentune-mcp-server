# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The OTCP protocol specification in `spec/otcp/v1/` is
versioned separately and has its own changelog.

## Unreleased

### Added

- `opentune_edit_arrangement`: edits clips on the timeline as OpenTune's arrangement view does (OTCP
  `arrangement.edit` and `arrangement.copy`). `move`, `trim`, `gain`, `fade` and `set_reference` run in order as one
  undo step; `split`, `merge`, `delete` and `copy` each go in a call of their own. The first sentence of a split, merge
  or delete result says that it cannot be undone (OpenTune frees objects its own undo entry needs) and to ask the user
  first; `delete` needs `confirm: true`, given only with the user's consent, and the tool is marked destructive.
  `dry_run` previews every op but `copy`. The tool takes and returns the `arrangement_revision`, so edits of notes,
  keys or pitch never conflict with a clip edit, and lists the ids of new and removed clips in `clip_ids`. Revert
  recipes that name `arrangement.edit` (the merge after a split, the removal of copies) are now given as calls of this
  tool; a restore that splits, merges or deletes cannot be undone either, so its revert line asks for the user's
  consent first.
- Track, transport and window tools, built on the OTCP methods of the capabilities `tracks.v1`, `transport.v1` and
  `ui.bridge`: `opentune_set_tracks` (mute, solo, volume, colour, reveal hidden tracks, duplicate a track),
  `opentune_delete_track` (needs the user's consent, cannot be undone, lists the track ids that moved),
  `opentune_transport` (play, pause, stop, seek, play from and return to the last start, tempo, time signature, loop)
  and `opentune_manage_ui` (select a clip with a prediction of what selecting does besides selecting, close dialogs,
  mark the first-run onboarding as shown). Results that cannot be undone say so in the first sentence and give the
  call that restores the old values.
- `BUSY` with reason `modal_open` now points to `opentune_manage_ui` instead of asking the user to close the
  dialog by hand, and keeps the rule that a dialog which commits its value on close needs the user's agreement.

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
  the user before using them; with an NVIDIA GPU whose driver supports CUDA 12.6 or newer it offers the PyTorch CUDA
  build, and otherwise the CPU build, in both cases only after the user agrees to the download).
- The OTCP specification `spec-v1.0.0-rc.3` with its schemas and test vectors, a mock OpenTune that implements it, and
  contract tests that run the tools against both.
- Golden snapshots of `tools/list` and of the instructions, the generated [tool reference](docs/reference.md) and the
  `tools/list` size limits, checked by the tests and by `npm run gates`.

[0.1.0]: https://github.com/synchain-oss/opentune-mcp-server/releases/tag/v0.1.0
