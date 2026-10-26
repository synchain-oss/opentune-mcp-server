# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The OTCP protocol specification in `spec/otcp/v1/` is
versioned separately and has its own changelog.

## Unreleased

### Added

- `opentune_manage_ui` has the op `switch_view` with `view` `arrangement` or `piano_roll`, so an agent can close the
  piano roll again after `focus_clip` opened it (`arrangement` shows the arrangement view). It sends the new OTCP
  method `ui.setWorkspace` of the specification `1.0.0-rc.7` (capability `ui.workspace`, which the op asks for in
  place of `ui.bridge`). Only the view changes: no clip, note or setting, no revision, and the project is not marked as
  changed. The result names the view that was shown, says so when the window already showed the view asked for (a
  no-op), and gives the call that switches back. A test build without `ui.workspace` answers with `UNSUPPORTED`
  (`capability_missing`) and a next step that asks the user to click the view button in the OpenTune window. The mock,
  five contract vectors, the tool golden files, the tour of the real-machine run and the `tuning-workflow` skill follow.
  See `docs/contract-changes/20261026-ui-set-workspace.md`.

### Fixed

- Result wording that disagreed with the facts of the same result (contract change record
  `docs/contract-changes/20261026-result-wording.md`):
  - A change of the tempo alone or of the time signature alone is now restorable with `opentune_transport`; the
    result no longer says that no tool can restore it. A new test walks every revert recipe of the specification
    vectors and fails when one that a tool can carry out maps to no tool call.
  - The summary of a result whose lists OpenTune cut at 200 entries (AUTO over a long clip, a large edit of notes)
    gives the real totals ("created 962 notes") and says which lists are shorter than the result.
  - `opentune_manage_ui` with `focus_clip` and `open_editor` names the switch of the window and no longer claims
    "no side effects"; a revert line says there is no tool yet to switch the window back.
  - Duplicating a track, and any result that shows a hidden track, names the revealed track and the colour change in
    the first sentence.
  - A first save to a new file says that a new project file was written, not that nothing can be restored; every save
    result says that OpenTune copies the audio the project uses into the `Project_Media` folder next to the project
    file, and the body gives that folder (`mediaFolder`).
  - `opentune_estimate_key` says which key to trust when the key of the clip has other notes than the estimate, states
    which range its two confidences cover, and ends `local_keys` and `estimated_over` at the end of the clip.
  - `opentune_analyze_pitch` reports `baseline` (`stored_notes` or `nearest_semitone`) and says that deviations
    against the nearest semitone are not directly comparable with a later analysis of the clip with notes.
  - A result that queued a render says that playback can still sound the old way until `render.current` of
    `opentune_get_clip_details` is true, and that an export waits for it.

## [0.2.0] - 2026-10-26

The second public version of OpenTune MCP Server (by Synchain), and wave B of the control interface: editing the
arrangement, tracks, transport, the dialogs and the selection in the OpenTune window, opening and saving projects, the
processing preferences (including the vocoder weight), the audio device setup and reference alignment. It implements
OTCP specification `spec-v1.0.0-rc.6` and needs the second unofficial OpenTune test build from synchain-oss/OpenTune
(`synchain-test/v1.8.0-ctl.2`), which has the control interface enabled; the official OpenTune releases do not provide
it yet. The four packages are built from the same version, as for 0.1.0: the npm package `@synchain/opentune-mcp`, the
MCPB package, the Claude Code plugin `opentune` and the skills zip.

### Added

- `opentune_set_settings` also changes the vocoder weight (`vocoder_weight`), the rendering priority
  (`rendering_priority`), the pitch model (`f0_model`) and the reference alignment mode (`reference_align_mode`), as
  `prefs.set` of the specification `1.0.0-rc.6` does, and `opentune_get_settings` returns the values they accept
  (`options`, from `processing.options` of `prefs.get`). A weight or model that is not on the list is refused with
  `INVALID_ARGUMENT(option_unavailable)` and nothing is changed. The vocoder weight and the rendering priority are applied
  by a job, which the tool follows. The result of a new vocoder weight says whether the clips render again now or after
  the weight has loaded, the result of a new reference alignment mode carries the experimental-feature warning, and the
  revert line restores the new members too. `MODEL_UNAVAILABLE(vocoder_not_ready)` (retryable) and
  `MODEL_UNAVAILABLE(vocoder_load_failed)` (not retryable) have a next step. The wave-B tour switches each new member
  and puts it back, and the effects scenario renders the same small correction under two vocoder weights (a skip with a
  reason where only one weight is installed). See `docs/COMPATIBILITY.md` for how a test build of `1.0.0-rc.5` answers.
- The wave-B tour and boundary scenario now drive the remaining real-machine steps and take each change back by the
  revert recipe of its result: transport `pause`, `playFromLastStart` (also after a seek) and `pauseAtLastStart` during
  playback, `setTempo` with a time signature, selecting a clip with `openEditor` (the piano roll shows that clip), a
  track colour set and sent back, closing or preventing the first-run overlay, switching the output device, buffer
  size, sample rate, output channel pair and device type (never ASIO or an exclusive mode) with the whole audio setup
  compared afterwards, `project.save` on a saved project, and the revert recipe of `project.open` after a project with
  missing media. The mock gains a second device type and a test knob that lets the transport position advance. The
  settings snapshot reads a file again for a moment when OpenTune is replacing it.
- A wave-B boundary scenario (`test/e2e/wave-b-boundary.ts`, `npm run e2e:exe`) drives the edge cases of the wave-B
  writes against a started OpenTune: structural edits that cannot be undone, trimming below the fades and its undo,
  the id map and a stale undo entry after a track delete, the `openDyne` side effects of focus and selection, the
  editing scheme and every processing preference put back by their revert recipes, saving over another project, and
  opening a project whose media is gone. The two checks no request can drive (the track colour dialog, a write during
  a modal) are listed as manual checks.
- Every real-OpenTune run now snapshots the settings files of the instance's data folder (preferences and JUCE
  settings) before it starts and puts them back byte for byte afterwards, also after a failure, and fails when a
  value changed or the restore did not work (`scripts/e2e/settings-snapshot.mjs`). A second guard compares the
  settings files of the real user folder by size and modification time only and fails the run when they changed.
- A wave-B tour (`test/e2e/wave-b-tour.ts`, `npm run e2e:exe`) drives every OTCP method and every MCP tool that wave B
  added once against a started OpenTune and checks the answers against the specification: result schemas, the read-back
  state behind every `changes[].fields.*.after`, tokens, the undo or revert round trip, the promised warnings and the
  first sentence of a result that cannot be undone, with the latency of every call in its report. Run against a
  correct fake in `test/unit/exe-wave-b-tour.test.ts`; a fake with one defect fails exactly the check that notices it.
- The contract vectors can now run against a started OpenTune with the state they need: the runner builds the
  preconditions of a vector (files, plain clips, dirty state, tracks, undo entries and the stale or unknown handles)
  through public calls and reads each one back, and skips with the reason what it cannot build. Every run writes one
  result row per vector, and `scripts/vector-coverage.mjs` merges the result files of several runners (the mock, a started
  OpenTune, the fork's headless runner) into a table of which runner passes which vector. The wave-B tour also judges
  the reference analysis by the known upstream defect and switches the audio device to another one and back.
- The `beat-grid` skill (plugin only; it needs Node.js and a local download): measures the tempo and
  beat grid of a song from its backing track or the original mix with `opentune-beats`, reports the
  tempo of each constant-tempo section for the agent and the user to confirm, and turns the grid
  plus the notes of a vocal clip into `opentune_edit_timing` suggestions with the singer's overall
  lead or lag (the median) removed before the 30 ms threshold. The analyzer and its model are a
  separate MIT project, downloaded only after the user agrees to about 85 to 90 MB (about 18 MB with
  the small model); version, URLs and SHA-256 values are pinned in a manifest, the install is an
  atomic rename with a `--version` self-check and rolls back to the previous version on failure, and
  it refuses while no `opentune-beats` release is published. The skill never writes a per-section
  tempo into the project: OpenTune has one BPM and one time signature, and setting them asks the
  user which section to follow.
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
- `opentune_set_settings`: changes the global settings of the OpenTune installation, not of the project: the processing
  preferences (A4 tuning, editing scheme, hybrid mode, experimental features), the audio device setup, and clearing the
  recent-projects list (`clear_recent`). OpenTune records no undo entry for these; the result warns `GLOBAL_PREFERENCE`
  and gives the previous values with the call that restores them. The tool is marked destructive: clearing the list
  cannot be undone, and an editing-scheme change can generate notes that cannot be undone. A change of the editing
  scheme runs as a settings job, which the tool follows.
- `BUSY` with reason `modal_open` now asks the user either to close the dialog in OpenTune or to agree explicitly
  that the agent closes it with `opentune_manage_ui`; closing a confirmation box cancels the action it asked about,
  and a dialog which commits its value on close needs the user's agreement (`accept_commit`).
- An end-to-end arrangement effects scenario (`test/e2e/arrangement-effects.ts`) for a real OpenTune build: clip gain,
  fade ramps, track mute/solo, a clip split, a clip move and trim, a copy (modes `window` and `full`), the delete of
  a copy, a track volume, a track duplicate (`clone` and `share`), the delete of a track and a batch import (layouts
  `sequential` and `separateTracks`) must change the exported master mix exactly as their results report, and nothing
  else; every write is taken back and the restored export must equal the baseline. Unit tests prove each check against
  a stand-in, and a stand-in with one defect fails exactly the check that notices it.
- Seven more checks in the effects scenario (`test/e2e/effects.ts`), each measured on a real build, with its tolerance
  frozen next to the measurement and a unit test that a wrong effect fails: `content.autoTune` with
  `params.noteSplitCents` (a stepped tone is cut at every step by 30 cents and left whole by 160), `snapToScale`,
  vibrato depth and rate (rate, amplitude, none at depth 0), `pitchDriftScale` 0 against 1 (on a slowly drifting tone),
  `content.editTimeGrid` `moveHandles`, and the two processing preferences `prefs.set tuningHz` (about +7.85 cents for
  442 Hz, not retroactive) and `prefs.set hybridMode` (re-render, same sound after the revert recipe). The preference
  checks run only in the scenario's own instance, put the value back by the revert recipe and read it back; a value that
  is not put back fails with the value it started from and stops the checks after it. The generator
  (`test/support/harmonic-tone.ts`) can now give a note a pitch contour (steps, slow drift), and the stand-in
  executable models the new methods and a defect for each check.

### Changed

- `opentune_set_settings` now checks `jobs.v1` before it sends a change that OpenTune applies by a job (the editing
  scheme, the vocoder weight, the rendering priority). A build without `jobs.v1` used to apply the change and then fail
  when following the job; now the call is refused with `UNSUPPORTED(capability_missing)` and nothing is changed.
- OTCP specification `1.0.0-rc.6`, proposed as the text of 1.0.0: `prefs.set` also changes the vocoder
  weight, the rendering priority, the pitch model and the reference alignment mode (the first two are applied by the
  `prefsApply` job, which waits until the vocoder is ready again), `prefs.get` lists the accepted values in
  `processing.options`, three reasons are appended (`option_unavailable`, `vocoder_not_ready`, `vocoder_load_failed`), and 16 vectors cover the
  new members and settings that were specified but not shown. The mock follows (test hooks `setVocoderFault` and `failF0Model`); its
  `vibratoRateHz` change now reports the unit `hz`. The tools take the new members in a separate change (see Added).
- OTCP specification `1.0.0-rc.5`, proposed as the text of 1.0.0: the methods that need the OpenTune
  editor window answer `UNSUPPORTED(no_editor_window)` (a new reason) while there is none, the `prefsApply` job of `prefs.set`
  checks the busy state again (`BUSY` in its job errors), duplicating a hidden track fails with `track_hidden`,
  closing a first-run overlay that already marked onboarding as shown changes the view only, and two corrections of
  the reference-job and track-id text. The mock follows (test hook `showOnboarding`).
- OTCP specification `1.0.0-rc.4` (not released on its own; its content is part of rc.5): the reasons `reference_analysis_stalled`,
  `reference_analysis_timeout` and `reference_analysis_failed` for the reference analysis jobs, and corrections of
  the selection, track deletion, split and merge text and vectors to what OpenTune does. The mock follows (fault
  mode `setReferenceFault`).
- The shared review workflows are pinned to `v1.3.3`. The PR-Agent input budget (`max_model_tokens`) now depends on
  the provider: 500000 for the Claude provider (was 800000), unchanged at 800000 for the others. PR-Agent counts the
  prompt with an OpenAI tokenizer that undercounts Claude tokens, so on a large PR the Claude PR-Agent sent a prompt
  over the 1M-token window and failed with no review. The step summary now lists the input budget.
- The shared review workflows are pinned to `v1.3.2`, and `review-dispatch.yml` moves from `claude-code-action`
  `v1.0.245` to `v1.0.253`, the version `dev` and the shared workflows use. The shared Claude review now also
  denies reading `/github` (the container-job layout), and `review-dispatch.yml` carries the same deny rule. The
  shared workflows also record the commit that ran in the step summary.
- The real-instance helper of the end-to-end scenarios now copies a data template with the rules the contract runner
  uses and the documentation describes: the template's ready file and discovery folder are left out.
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
  `ENABLE_PR_AGENT` switch already existed and are unchanged. (#63)
- Documentation: the READMEs (English and Chinese) list all 27 tools by group, say which ones are marked destructive and
  which arguments need the user's agreement, add example prompts for moving and fading a clip, muting a track and saving
  a project under a new name, and give the known limits of undo, saving and the reference analysis. The DAW and WSL
  sections agree on how paths are written and reported. `docs/real-opentune-testing.md` explains how to run the whole
  real-OpenTune set and how to judge it (what counts as a pass, the settings guard, the known upstream defect),
  `docs/COMPATIBILITY.md` lists the capabilities each tool needs, `docs/install.md` has a WSL section, and the
  hybrid-mode section of the troubleshooting guide mentions `opentune_set_settings`.
- The real-OpenTune runs are stricter about their own clean-up and about what they print. The watch of the real
  user's settings folder counts a file that is deleted between listing and reading as gone, instead of failing with
  an ENOENT that names the full path, and a comparison that does fail shows the home folder as `~`. In the wave-B
  boundary scenario, a rename back of the moved media that fails no longer replaces the result of the missing-media
  step: it is listed as a manual check next to it. New unit tests cover each of these, and the arrangement effects
  scenario has a test for a split whose two clips cannot be found after an applied merge.

### Fixed

- Revert lines now ask for the user's agreement where the way back is itself irreversible: restoring a deleted track
  says to add `confirm: true` only after the user agrees, and a restore that would split, merge or delete together
  with other clip edits is left to the user in the OpenTune window instead of being offered as a call the tool would
  refuse.
- A restore that can only put part of a change back says so: values of the recipe outside the range a tool accepts
  are named as omitted in the revert line and in the first sentence of the result, so a partial restore is never
  mistaken for a full one.
- Every irreversible clip split, merge or delete says so in the first sentence of its result, also when OpenTune does
  not report its undo defect for that call.
- The first sentence of a structural edit and its revert line read the revert recipe the same way: a recipe that is
  not in the protocol's form is no way back, so the first sentence no longer promises a restore that the revert line
  does not.
- `opentune_edit_arrangement` copies a clip that `clips` names twice only once, and the summary of a call with several
  requests no longer repeats "not undoable" once per request.
- `opentune_transport` is no longer marked idempotent: `play_from_last_start` seeks back to the last start on every
  call, also while playback runs.
- The `tuning-workflow` skill covers the arrangement, track, transport, window and settings tools, including who has
  to agree before a clip split, merge or delete and that a changed global setting is restored when the step is done.
- The `beat-grid` skill installs the analyzer only when the download stays on GitHub release hosts (the checksum
  remains the trust anchor), exposes `--no-refine` and `--min-segment-beats`, gives each timing suggestion as a single
  op instead of a call that would reuse a stale revision, explains what to do when the user rejects a plan, and sorts
  installed analyzer versions by version rather than by text.
- The errors of a reference analysis that does not complete tell what to do next: `reference_analysis_stalled` (not
  retryable) asks the user to save the project and restart OpenTune, `reference_analysis_timeout` (retryable) says to
  wait a little and call again, and `reference_analysis_failed` says to choose another reference clip or have the
  reference audio checked.
- A tool error for an instance that does not serve this server's protocol major (`PROTOCOL_MISMATCH`) now lists the majors
  the instance's discovery file announces, in the optional member `protocolMajors`, as the status already did. The error
  text names the major the instance speaks (`OTCP major 2`) or says that its version is unreadable.
- `opentune_get_status` reports the reason `major_not_served` for an instance whose answer to `session.hello` names a
  protocol major this server does not serve; it reported `hello_rejected` for every rejected hello.
- The watch of the real user's settings files in the real-OpenTune runs passes on a CI runner when no settings file
  existed before or after the run, as on a clean runner that has never run OpenTune (a file the run creates still
  fails it); on a machine with no settings file it stays a skip.

### Security

- Upgraded `zod` from 4.6.5 to 4.6.7 (pinned exactly) to fix GHSA-mrhx-c7xc-m3w5, where validating an oversized
  constrained collection could exhaust memory. `zod` is a development dependency, but esbuild bundles it into the
  published single file, so the fix reaches the release bundle (and its entry in `THIRD-PARTY-NOTICES.md`).
- Updated the transitive dependency `fast-uri` (via `ajv`, development only) from 3.1.8 to 3.1.9 for the four 3.0.0 to
  3.1.8 advisories (GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h, GHSA-wjr9-j795-jxcr, GHSA-333x-w4r6-6crp). `npm audit`
  reports no vulnerabilities.

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

[0.2.0]: https://github.com/synchain-oss/opentune-mcp-server/releases/tag/v0.2.0
[0.1.0]: https://github.com/synchain-oss/opentune-mcp-server/releases/tag/v0.1.0
