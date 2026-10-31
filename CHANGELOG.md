# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The OTCP protocol specification in `spec/otcp/v1/` is
versioned separately and has its own changelog.

## [Unreleased]

The OTCP specification in `spec/otcp/v1/` is now `1.0.0-rc.9`. The server in this repository does not change what it
sends to OpenTune; the specification, its mock and the text of the results do. A test build that implements `rc.9`
(the fork has to follow; see `docs/contract-changes/20261031-spec-rc9.md`) is needed for the new warnings and the new
media folder to show up in real results.

### Added

- Two warnings, with a mock that produces them, rendering templates and golden files. `BACKEND_FALLBACK` (`data`:
  `requested`, `actual`) is carried by the job result of `prefs.set` when the call changed the rendering priority to
  `gpuFirst` and the backend in use is `cpu`. `ASIO_RATE_NOT_RESTORED` (subject `{"singleton":"audioDevice"}`, `data`:
  `deviceName`, `sampleRateHz`) is carried by `audio.set` when the device type or the output device changed to ASIO and
  OpenTune could not put the previous sample rate back: the switch goes on, and the warning tells the user to check the
  rate in the driver. The rendering text of the server is English only; the Chinese wording is in
  `docs/TROUBLESHOOTING.zh-CN.md`.
- The specification vectors `audio/set-asio-rate-not-restored`, `audio/set-asio-rate-not-needed`,
  `prefs/set-rendering-priority-fallback` and `prefs/set-rendering-priority-gpu`, with the vector members
  `given.gpu` and `given.audio.asioRateRestoreFails`.

### Changed

- The media folder of a project file is `<file name without extension>_Media` beside the target `.otproj`, instead of
  one `Project_Media` folder that all the project files of a directory shared. OpenTune writes the media files again at
  every save, through a temporary file, so no file stays half written. Save, Save As and `project.saveCopy` all follow
  the target path; only a media folder of the same name with no `.otproj` of that name is replaced, and
  `project.saveCopy` reports `ALREADY_EXISTS` by looking at the `.otproj` alone. In this server, the old version of a
  project (`<name>.oldversion`) now gets a copy of `<name>_Media` (the `Project_Media` folder of an earlier OpenTune
  is still copied when there is no `<name>_Media`), and the autosave copies get a media folder of their own each
  (`mediaFolder` in the result). Each copy holds a full set of the audio, so `<name>.autosave` takes about the size of
  the audio times up to 10.
- `opentune_save_project` with `mode: autosave` keeps the newest 10 copies instead of 50, and when it rolls a copy
  away it deletes the media folder of that copy with it: the one folder whose path is computed from the name of the
  copy (`<copy name>_Media`), its regular files and then the folder, never a pattern. A copy that could not be deleted
  keeps its folder, and a folder that could not be deleted is counted in `couldNotRemove` and never raises an error. The
  first autosave after the update deletes every copy beyond the newest 10, each with its media folder.
- The description of the setting `rendering_priority` of `opentune_set_settings` no longer says that the fall back to
  the CPU happens without notice: a build that implements specification `1.0.0-rc.9` adds the warning
  `BACKEND_FALLBACK` to the result, and an older build says nothing (`docs/TROUBLESHOOTING.md`).
- `opentune-mcp doctor` (`OT_MODELS_MISSING`) no longer asks for the five model files in the `GAME` folder of the
  official installation: the code of OpenTune 1.8.2 does not use them and later official versions do not ship them.
  `fcpe.onnx` is still required.
- Build and test setup: the unit project of the tests has a time limit of 60 seconds per test (the golden tests passed
  the default 5 seconds on a loaded machine), and the build pins `minimatch` to `11.0.3` through `overrides`, which
  clears the advisory GHSA-g3hv-75wg-m249 that `npm audit` reported for the lint toolchain.
- The description of an undo entry is the text of the undo menu of OpenTune and follows its language: clients must
  not parse it (specification section 15.1, `edit.getHistory`, `undoable`).
- An export that finds render work still pending, including blocks waiting for a delayed retry, drains it before it
  starts; when that does not finish in time, it fails with the existing `NOT_READY` reason `export_wait_timeout`, which
  is retryable (specification section 19 rules 6 and 7). No new reason code.
- `audio.set` does not roll back the switch when the previous ASIO sample rate cannot be restored. The earlier text,
  which called for `OpenFailed` and a rollback, is gone; `device_open_failed` stays for a device that really cannot be
  opened.
- The descriptions of `processing.backend`, `vocoderReady`, `vocoderReconfiguring`, `renderingPriority` and
  `options.renderingPriority` say what the values mean and when they are read, and the sentence in `prefs.set` that
  ended in "and never does" is rewritten.
- `docs/COMPATIBILITY.md` names the specification `1.0.0-rc.9` and lists the test build `synchain-test/v1.8.0-ctl.3`
  (the same OpenTune and interface as `ctl.2`, with a macOS package added).
- The number of visible tracks is project state, not view state: OpenTune 1.8.2 saves it in the project file and
  restores it when the project is opened. Behaviour change: `opentune_set_tracks` with the op `reveal` (`track.add`)
  now marks the project as changed, cannot be undone (undo reason `no_upstream_undo`, no revert recipe, warning
  `IRREVERSIBLE`; the first sentence of the summary says it cannot be undone but does not call it destructive, because
  showing a track destroys nothing) and is no longer described as "view state, not saved";
  a client written against the earlier text that relied on the call leaving the project unchanged now sees unsaved
  changes. `track.delete` is no way back: it deletes the clips on the track and one track per request. The warning
  `NOT_SAVED_IN_PROJECT` lists only the undo history and the preferences, so the save tools no longer say that "which
  tracks are shown" is missing from the file. `project.open` restores the stored number, reports the tracks it showed
  as `tracksRevealed`, and leaves the project without unsaved changes. The mock follows
  (`docs/contract-changes/20261031-spec-rc9.md`).

## [0.2.0] - 2026-10-29

The second public version of OpenTune MCP Server (by Synchain), and wave B of the control interface: editing the
arrangement, tracks, transport, the dialogs and the selection in the OpenTune window, opening and saving projects, the
processing preferences (including the vocoder weight), the audio device setup, closing OpenTune, switching the view and autosave copies of the project. It implements
OTCP specification `spec-v1.0.0-rc.8` and needs the second unofficial OpenTune test build from synchain-oss/OpenTune
(`synchain-test/v1.8.0-ctl.2`), which has the control interface enabled; the official OpenTune releases do not provide
it yet. Compared with `rc.6`, the specification `1.0.0-rc.7` added `app.quit` (capability `app.quit`) and
`ui.setWorkspace` (capability `ui.workspace`) and retired the reference alignment, and `1.0.0-rc.8` added
`project.saveCopy` (capability `project.copy`). The four packages are built from the same version, as for 0.1.0: the npm package `@synchain/opentune-mcp`, the
MCPB package, the Claude Code plugin `opentune` and the skills zip.

### Added

- `opentune_save_project` has the mode `autosave`: it writes a numbered copy of the project into
  `<name>.autosave` next to the project file (`<name>-autosave-0001.otproj`, 0002, ...; the newest 50 are kept) and
  writes nothing outside that folder (the audio that OpenTune copies goes into a `Project_Media` folder inside it, so a
  copy never touches the audio of another project). The project file, the unsaved-changes flag, the recent-projects list, the undo history and the
  window title stay as they are, so an agent can save after every step without touching the user's file or the
  question of whether to save. It sends the new OTCP method `project.saveCopy` of the specification `1.0.0-rc.8`
  (capability `project.copy`, job kind `projectCopy`; a copy never replaces a project file). The result names the copy
  (`autosave.path`, `autosave.number`), the project file and its unsaved-changes flag, and the folder where OpenTune
  copied the audio. A project without a file, and a test build without `project.copy` (everything up to
  `1.0.0-rc.7`), get an error with a next step and nothing is written. Only files that match
  `<name>-autosave-<number>.otproj` are ever deleted from the folder; the audio folder, other project files and
  anything else a user keeps there stay.
- Every save that replaces a project file (`opentune_save_project` with `mode: save`, `mode: save_as` onto the
  project's own file, and `opentune_save_project_overwrite`) first copies the file it is about to replace into
  `<name>.oldversion/<name>-<YYYYMMDD-HHMMSS>.otproj` next to it (local time; `-2`, `-3` for the same second) and
  keeps the newest 10. If the copy fails, nothing is saved, and the error says so. A save to a path where no file
  exists keeps nothing. The result gives the path of the old version (`oldVersion`), or `null` with the reason
  `no_previous_file`; the first sentence no longer says that the old content cannot be restored. A save that OpenTune
  then refuses deletes the copy it made. When the newest old version already holds exactly the bytes of the file to be
  replaced, no new copy is made: that one is the old version (`oldVersion.reused` is true), so a repeated save does not
  push an older version out of the ten. A copy that fails part way is deleted again. See `docs/contract-changes/20261028-autosave-and-save-rules.md`.
  An old version also gets its audio: in the same step, before the save, the files of the `Project_Media` folder next to
  the file being replaced are copied into `<name>.oldversion/Project_Media`, where an old version looks for its audio,
  so it still opens after the original audio files were deleted (until now it opened only while they were in place).
  The rule is OpenTune's own for its audio folder: a file is copied when it is missing there or older than its source;
  nothing is deleted, a newer file is never overwritten, links and sub-folders are skipped, and a copy that fails part way
  is deleted again. A reused old version gets the missing files, too. The whole `Project_Media` folder is copied, which
  every project file in the same directory shares, so the audio of the other projects there comes along and each
  project file's `<name>.oldversion/Project_Media` holds its own copy: with several project files in one directory the
  space taken multiplies by their number (one project per folder avoids that). The roll of the old versions does not
  touch the folder, so it only grows. The copy stops after 15 seconds (checked between files) so that it cannot hold
  the save up: the files left are listed as not copied, `oldVersion.media.timedOut` is true, and the next save that
  replaces the file copies the rest. A failure to copy audio does not stop the save either: the result says so in
  `oldVersion.media` (`copied`, `notCopied`, `notCopiedCount`, `timedOut`), a warning line
  (`OLD_VERSION_MEDIA_NOT_COPIED`, `source: server`) and a sentence in the summary, a different one for a failure and for
  the time limit. The troubleshooting page now also says when the old version of a save is deleted again (OpenTune
  refuses the save or reports no change) and when it is kept (any other failure). See
  `docs/contract-changes/20261028-oldversion-media.md`.
- `opentune_manage_ui` has the op `switch_view` with `view` `arrangement` or `piano_roll`, so an agent can close the
  piano roll again after `focus_clip` opened it (`arrangement` shows the arrangement view). It sends the new OTCP
  method `ui.setWorkspace` of the specification `1.0.0-rc.7` (capability `ui.workspace`, which the op asks for in
  place of `ui.bridge`). Only the view changes: no clip, note or setting, no revision, and the project is not marked as
  changed. The result names the view that was shown, says so when the window already showed the view asked for (a
  no-op), and gives the call that switches back. A test build without `ui.workspace` answers with `UNSUPPORTED`
  (`capability_missing`) and a next step that asks the user to click the view button in the OpenTune window. The mock,
  five contract vectors, the tool golden files, the tour of the real-machine run and the `tuning-workflow` skill follow.
  See `docs/contract-changes/20261026-ui-set-workspace.md`.
- `opentune_quit` closes OpenTune, as the close button of its window does, and waits until the instance has exited. It
  sends the new OTCP method `app.quit` of the specification `1.0.0-rc.7` (capability `app.quit`). The window quits
  without asking, also over unsaved changes; the tool does not: it fails with `UNSAVED_CHANGES` and a next step (save
  with `opentune_save_project`, or ask the user whether the changes may be discarded), and quits over them only with
  `discard_unsaved: true`, which only the user may allow. It refuses with `BUSY` while a dialog is open or a job has not
  finished (the new reason `job_in_progress`). The first sentence of the result says that OpenTune closed, or that it
  closed without saving and the unsaved changes are lost, or that the exit was not confirmed in time (`exited` is
  `false`), or that it could not be looked at (`exited` is `null`, with `exitCheckProblem`: the discovery directory
  could not be read, which is not the same as a timeout); the project file comes back as data. A test build without `app.quit` (everything up to `1.0.0-rc.6`, including the test build of
  0.1.0) answers with `UNSUPPORTED` (`capability_missing`) and a next step that asks the user to save and close the
  window. The mock, nine contract vectors (a vector can now end the instance: `endsSession`), the runner, the tool
  golden files, the token canary and the `tuning-workflow` skill follow. See
  `docs/contract-changes/20261026-app-quit.md`.
- `opentune_get_notes` takes `output_path`: it reads every page of the range itself and writes all notes to one new
  `.json` file (never overwriting; a taken name gets ` (2)`, ` (3)` ...), and returns the path, the note count, the
  clock and the `clip_revision`. If the clip changes during the read, the result is `REVISION_CONFLICT` and no file is
  written. Because it can write a file, the tool is no longer annotated read-only. Without `output_path` nothing
  changes.
- `opentune_edit_timing` takes up to 64 operations in one call (was 8), as many as `moveHandles` of the specification.
  A call of more than 8 operations returns compact steps (the undo id and the moves of each), and a call stops between
  two operations once a further write, at the longest it may take, plus the read after it would not end inside the 60
  seconds a client waits by default, and says how far it got, with the `clip_revision` to go on with.
- The `beat-grid` skill fixes the timing of a whole song. `timing-plan` reads the file `opentune_get_notes` writes,
  merges the touching fragments that automatic note splitting makes of one sung syllable (gap under 30 ms, pitch within
  300 cents; a lone note under 60 ms gets no suggestion) and compares only the start of each chain with the grid, and
  gives every batch of up to 64 operations in `calls`; the skill applies one batch, reads the notes again and plans
  again. `align --vocal <wav> --backing <wav>` finds the offset between the vocal and the backing track by itself, and
  the user is asked only when it is not confident. Every command takes `--home` (priority `--home`,
  `OPENTUNE_BEATS_HOME`, `CLAUDE_PLUGIN_DATA`) and `--help`. `analyze`, `timing-plan` and `align` also take
  `--paths-file`, a JSON file with the paths: the skill puts the paths that tools returned in it, so that a file name
  is never part of a shell command line.
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
  separate MIT project, downloaded only after the user agrees to about 85 to 90 MB (about 13 to 15 MB with
  the small model); version, URLs and SHA-256 values are pinned in a manifest, the install is an
  atomic rename with a `--version` self-check and rolls back to the previous version on failure, and
  it installs `opentune-beats` 0.1.0 from its GitHub Release. The skill never writes a per-section
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

- The instructions and the `tuning-workflow` skill now say: write an autosave copy after each step without asking
  (`mode: autosave`), and overwrite the project file (`mode: save`) only when the user asks or agrees, offering it
  every few steps and before closing. The skill also says what to do before closing or opening another project (write a
  copy first, then ask whether the changes may be dropped), where earlier work is kept, and that its description now
  covers clip, track and project edits. This replaces "save after each finished step", which let an agent overwrite the
  user's file unasked.
- The description of `opentune_set_tracks` begins with duplicating a track, and the description of
  `opentune_edit_arrangement` says that a whole track is duplicated with `opentune_set_tracks`, not with `copy`.
- The next step of `merge_not_possible` now lists every condition of a merge, including that the two clips have the
  same key set the same way, and what to do when the keys differ (compare them with `opentune_get_clip_details`, ask
  the user which key to keep, set it on both clips with `opentune_set_clip`, merge again).
- Results of the write tools that list many entries are cut so that a host does not reject them (contract change record
  `docs/contract-changes/20261026-agent-feedback.md`). `changes`, `created`, `removed` and `idMap` list at most 20
  entries each and count the rest in `omittedCount`; the change table is a preview of 10 rows; the list of time-grid
  handles of `opentune_edit_timing` holds 100. For a write that is not a dry run, the undo information (the undo id, or
  "not undoable" with the way to restore it) comes first in the result, in the text and in the structured content. A
  regenerate of a whole song of 1,200 notes now gives a result of under 20,000 characters.
- `opentune_get_status` and `opentune_launch` read the window of a ready instance once (`ui.getState`, capability
  `ui.bridge`). When the first-run welcome page or another dialog is open, the result carries `blockedBy` (`kind` and a
  hint), the summary says that writes are refused until it is closed, and the next step is `opentune_manage_ui` with
  `dismiss_onboarding` (after the user has agreed: closing the welcome page marks it as seen and cannot be undone) or
  `dismiss_dialogs`. An instance without `ui.bridge` has `blockedBy` `null` with the reason `capability_missing`. A vocoder that is not loaded yet is no longer worded as a problem: one
  sentence says that it loads at the first render (reworded since: see Fixed).
- `opentune_get_settings` gives next to `options.renderingPriority` one note per value (`optionNotes`: what it means and
  when it takes effect), and a summary sentence when the priority is `gpuFirst` but the CPU runs, with the log and
  `opentune-mcp doctor` as the places to look. `opentune_set_settings` reads the backend once after a change of the
  rendering priority (`rendering_backend`) and says "gpuFirst was requested, but OpenTune is now using the CPU", that the
  vocoder is still reloading, or, when the vocoder was not ready before the change, that the backend is not known yet. The description of `rendering_priority` says what the values do.
- `opentune_edit_notes` describes `delta_cents`, `retune_speed`, `pitch_drift_scale` (the usual meaning of "vibrato" in a
  request), `vibrato_depth` and `vibrato_rate_hz` in the parameters.
- `opentune_edit_arrangement` no longer says "ask the user first" for every split, merge and delete: a request that
  names the clip or the time counts as the agreement and the step runs at once; the first sentence of the result says that
  it cannot be undone and how to restore it. Only a target that is not clear, and a merge or delete the user did not ask
  for, are asked about first. This matches the companion skill.
- `opentune_export_audio` reads the file it wrote, in blocks, and reports `peakDbfs` and `clippedSampleCount`; a peak
  above 0 dBFS adds a sentence to the summary. A read that fails only leaves the two members null, with the reason in
  `nullReasons`.
- The companion skills `tuning-workflow`, `check-results` and `lyrics-timeline` now treat a clear request from the user as the agreement for that step, ask a question only once and only about what the tools cannot find out, use only the files the user named, confirm that the render is current before a result is called ready to listen to, and compare before and after pitch figures only when they share the same target basis.
- The `tuning-workflow` and `check-results` skills now tell the agent to check the earlier corrections after reopening a project before saying the content is all there, name the file that holds the version before a risky step, name an open welcome page or dialog from the `kind` of `blockedBy` (`onboarding` or `dialog`) and close it only with the user's agreement, read a status again before reporting it as not ready, describe the rendering priority by the backend actually in use, ask before a `regenerate` that resets the notes, give one key confidence figure, mention clipping only when the export result reports a peak above 0 dBFS (and say neither that it clips nor that it does not when the peak was not measured), and state only the range that was checked.
- `opentune_estimate_key` sets `recommendation.ask_user` to `true` also when the key the clip already has in OpenTune
  has other notes than the estimate (`clip.same_scale_set_as_estimate` is `false`) or cannot be compared with it
  (`null` while the clip has a key: its scale is one this server has no name for), whether the key was set by the user,
  found automatically or is of unknown origin; before, only a scale set confidence under 0.6 did, so a result could say
  "offer it to the user before setting it" and `ask_user: false` at once. `recommendation.reason` then says that the
  clip's key has other notes (or cannot be compared) and that the user is asked before `opentune_set_clip` is called (a
  key the user set stands unless they want another), and the closing sentence of the summary offers `opentune_set_clip`
  only once the user has agreed. When the clip key has the same notes as a sure estimate, the summary says that
  snapping gives the same result and the clip key need not change, and offers `scale: "clip"` only when the key does
  not change along the song; with an unsure estimate it says nothing about the clip key (the recommendation is
  chromatic), and its closing sentence no longer names `opentune_set_clip`. Without a clip or without a clip key
  nothing changes. The `tuning-workflow` skill says the same: a request for the whole job ("analyse it, then tune it")
  does not cover replacing the key OpenTune found for the clip, which cannot be undone, so the agent asks once (also
  when the notes could not be compared), leaves the clip key as it is when the user does not answer, and after a key
  change says in the first sentence that it changed, cannot be undone and how to go back in plain words. See
  `docs/contract-changes/20261027-estimate-key-ask-user.md`.
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
- The review workflows are named after the model they run: `Claude PR Review (Opus 5.5)`,
  `PR Agent (DeepSeek V4.1 Flash)` and `PR Agent (Claude Haiku 5.5)`. The check names are unchanged.
  The workflow test that requires every call of `Synchain-oss/ci-workflows` to pin the same commit now
  also counts a call that spells the owner or repository in another case, writes the `uses:` value in quotes, or
  has extra spaces after `uses:`.
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
- Documentation: the READMEs (English and Chinese) list all 28 tools by group, say which ones are marked destructive and
  which arguments need the user's agreement, add example prompts for moving and fading a clip, muting a track and saving
  a project under a new name, and give the known limits of undo and saving. The DAW and WSL
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

### Removed

Several entries under Added, Changed and Fixed of this version describe the reference alignment (`set_reference`,
`reference_align_mode`, the reference analysis jobs and their errors, the specification text of `rc.4` to `rc.6` about
them). The feature was removed again before this version was published, so those entries describe work that is not in
the release.

- The reference alignment. OpenTune's upstream project retired the experimental reference track and its AUTO Ref
  button, and the control interface no longer reads, writes or reports it (OTCP specification `1.0.0-rc.7`). The
  tools lose what belonged to it:
  - `opentune_autotune_range`: the mode `reference` (published in 0.1.0). The input schema takes `regenerate`,
    `snapNotes` and `notesOnly` only, so a call with `mode: "reference"` is refused before anything is sent. The tool
    no longer needs the capability `reference.v1`, and `content.autoTune` no longer hands work to a job.
  - `opentune_edit_arrangement`: the op `set_reference` with its `reference_clip`, and the error step for
    `reference_ineligible`.
  - `opentune_set_settings` and `opentune_get_settings`: `reference_align_mode` (the reference alignment mode of the
    processing preferences, and its entry in `options`). The experimental features switch (`experimental_features`)
    stays. `opentune_get_settings` leaves the mode out also when an instance of the specification `1.0.0-rc.6` still
    reports it.
  - `opentune_get_clip_details`: the section `reference` (it is no longer a value of `sections`) and the notice about
    a reference binding that is left over. The window of a test build from before OpenTune's upstream project removed
    the feature still runs the reference alignment from its AUTO button once a reference track is bound there, so the
    summary says when the button would run a mode that this server cannot run (`autoModes.uiButtonRuns` is
    `reference`, which is not in `autoModes.available`); the server never runs it. See `docs/COMPATIBILITY.md`.
  - The sentences of the results of `opentune_delete_track`, `opentune_open_project` and `opentune_manage_ui` about
    reference bindings that were removed or not restored and about a queued reference analysis, the job kind
    `referenceAnalysis` of the job tools, and the next steps of the reasons `reference_analysis_stalled`,
    `reference_analysis_timeout` and `reference_analysis_failed`.
  - The mock, the contract vectors, the tests, the end-to-end tour and the troubleshooting text of the reference
    analysis. The registries of the specification keep the capability `reference.v1`, the reasons and the warning that were
    sent, marked as retired from `1.0.0-rc.7` on; see `docs/contract-changes/20261026-retire-reference.md`.

### Fixed

- A whole-song regenerate gave a result of about 60,000 characters that a host rejected, which lost the undo id; see
  Changed.
- `opentune_estimate_key` names the scale of the key of a clip in a sentence only when it is one of the scales of the
  protocol, else "another scale". `opentune_manage_ui` does not say "no other side effects" for a side effect whose
  details are not an object; see the entries on the worded side effects below.
- Result wording that disagreed with the facts of the same result (contract change record
  `docs/contract-changes/20261026-result-wording.md`):
  - A change of the tempo alone or of the time signature alone is now restorable with `opentune_transport`; the
    result no longer says that no tool can restore it. A new test walks every revert recipe of the specification
    vectors and fails when one that a tool can carry out maps to no tool call.
  - The summary of a result whose lists OpenTune cut at 200 entries (AUTO over a long clip, a large edit of notes)
    gives the real totals ("created 962 notes") and says which lists are shorter than the result.
  - `opentune_manage_ui` with `focus_clip` and `open_editor` names the switch of the window and no longer claims
    "no side effects"; a revert line gives the `switch_view` call to switch the window back (on a build without
    `ui.workspace`, it says to click the view button). The summary of `switch_view` for a window that already showed
    the view keeps the warnings of the result, as the one of `focus_clip` does.
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
- A switch of the view can change the tempo, and the results now say so (OTCP specification `1.0.0-rc.7`, contract
  change record `docs/contract-changes/20261026-tempo-rounded.md`). The tempo field of the OpenTune transport bar shows
  one decimal and, each time the window switches view (in both directions), writes that rounded value back and marks the
  project as changed; so `opentune_manage_ui` with `switch_view`, or with `focus_clip` and `open_editor` that really
  switches the view, turns a tempo of 120.27 into 120.3, as a click on the view button does. A tempo with one decimal or
  none is left as it is. Until now the specification, the tool results and the mock said that a switch never changes
  the project. The first sentence now says that OpenTune changed the tempo from 120.27 to 120.3, which nobody asked
  for, and a revert line gives the `opentune_transport` call that sets it back (without `transport.v1` it says that no request can). The
  mock, a contract vector, the rendering and tool golden files follow. The mock also loads the
  clip that an import with focus selects into the piano roll, as the window does.
- Follow-up to the rounded tempo (contract change record `docs/contract-changes/20261026-tempo-rounded.md`, section
  "Follow-up"): the summary of `opentune_manage_ui` with `focus_clip` names the tempo whenever the result lists the
  side effect `tempoRounded`, also when an instance sends it with a value that is not an object, as the generic summary
  does. In a dry run, the summary says that the project "would be" marked as changed, for the tempo and for the notes
  OpenTune would generate, instead of saying it in the present tense. The OTCP specification (`1.0.0-rc.7`, section 21
  rule 2) now says what the window does when an import focuses the imported clip: the clip is loaded into the piano
  roll, `ui.pianoRollContentId` is its content and `selectedPlacementIds` its placement, and the view is not switched.
  The mock does not count floating-point noise (a tempo of 120.30000000000001) as a rounding.
- The `beat-grid` skill checks `status` before it plans an install. An analyzer that was already installed used to
  be treated as missing when the manifest still said the release was not published: the install plan listed
  Problems and told the agent not to retry, and the whole beat-grid workflow was given up. Now `install` (the plan
  and `--yes`) reports "already installed" with the version, folder and models, exits 0 and downloads nothing when the
  program and the models asked for are there; `status` leaves out the unpublished-release note for an installed
  analyzer; `SKILL.md` skips the install section on `installed: true` and stops for an unpublished release only
  when nothing is installed. An analyzer that is not installed is still refused as before.
- Text and specification follow-ups of the review of the skill and wording changes (contract change record
  `docs/contract-changes/20261026-shift-timing-closed-range.md`):
  - The OTCP specification (`1.0.0-rc.7`) says that the `range` of `content.shiftTiming` is a closed interval: a handle
    exactly at either end moves, so two ranges that share an end point move the handle there twice. It also says in the
    `focus` description of `import.start` that the focused clip is loaded into the piano roll without switching the
    view. Both state what the OpenTune build already does; nothing changes on the wire.
  - The timing plan of the `beat-grid` skill no longer lets neighbouring ranges meet: a range ends at least 0.1 ms
    before the next one starts. An onset that has no room left for a range (the next chain starts less than about 0.2 ms
    after it) gets no op of its own and the warning `RANGE_TOO_NARROW`, which names the note and the shift that was not
    planned, instead of a range that reaches into the next one. The warning also says what happens to a handle at that
    onset: it can still lie inside the next chain's range (the two starts are in the same 0.1 ms) and then moves with
    that chain, by that chain's shift (`movedWithNextChainMs`, which is `null` when no range covers it).
  - `SKILL.md` of `beat-grid` says that `grid` stays out of the paths file when `--grid` is on the command line (both
    is refused as "given twice").
  - `SKILL.md` of `tuning-workflow` tells the first-run welcome page from other dialogs by `blockedBy.kind`
    (`onboarding` or `dialog`) instead of the English of `hint`; says that a peak above 0 dBFS and samples at full scale
    without a measured peak (`peakDbfs` null, `clippedSampleCount` above 0) are reported differently; and, when a
    reopened project lacks corrections, no longer saves over the original file: the agent tells the user what is
    missing, suggests `save_as` to a new file, and overwrites the original only if the user agrees.
  - The skill tests: the check that no skill declares `allowed-tools` also sees a quoted key, and every identifier a
    skill names in backticks as a result field (`peakDbfs`, `blockedBy`) must exist in the code.
- Follow-ups to the settings, export, timing and notes tools and to the mock (contract change record
  `docs/contract-changes/20261026-followups-code.md`):
  - `opentune_get_settings` says "gpuFirst but OpenTune is using the CPU" only while the vocoder is loaded
    (`processing.vocoderReady` true). A vocoder that is not loaded can still report the backend from before, so no fall
    back is concluded from it; this is the rule `opentune_set_settings` already followed after a change.
  - The sentence about a vocoder that is not loaded (`opentune_get_settings`, `opentune_get_status`,
    `opentune_launch`) no longer calls it normal. `session.info` and `prefs.get` have no member that tells "not
    loaded yet" from "could not load" or "stuck", so the sentence says that the vocoder loads when the first render needs
    it, and that the user is to be told if it is still not loaded after a render.
  - `opentune_set_settings`: when `session.info` cannot be read before a change of the vocoder weight or the rendering
    priority, `rendering_backend.unconfirmed_reason` is `ready_state_unavailable` and the summary says that the state could
    not be read. It was `vocoder_not_ready_before_change`, which claimed a state that was not known.
  - `opentune_export_audio`: a file with a sample that is NaN or infinite reports `peakDbfs` null with the reason
    `not_finite`. A file of NaN used to be reported as `silent`, and a file with some NaN got a level that did not
    describe it.
  - `opentune_manage_ui` with `focus_clip` words `notesGenerated`, `uiScaleChanged` and `workspaceSwitched` by their key,
    as it already did for `tempoRounded`, whatever their value is. A value that is null or a string gets the sentence of
    its side effect without what the value would have said (the note count, the two views), instead of the one line
    of the fixed table that left out "no undo entry" and "the project is marked as changed".
  - `opentune_edit_timing`: the full format of up to 8 operations is kept only while the result fits the output budget
    of 20,000 characters; otherwise the compact format is used, which still gives the counts of every operation. A
    result of 8 operations that moved many handles was about 40,000 characters. The completed steps of an error are
    treated the same way, and the description of `ops` says it.
  - `opentune_get_notes` with `output_path` stops reading pages when the next one could end after a client has given
    up (40 seconds into the call, with room for a page at its timeout and for the file) and fails with
    `REQUEST_TIMEOUT` (`read_too_slow`) and a next step (a narrower range). No file is written then; a file written after
    the client gave up was one nobody knew about, and the retry wrote a second one named " (2)".
  - The mock: a stop that cannot remove the discovery file (for example `EPERM` on Windows) still ends it:
    `whenEnded()` resolves and the clean-up runs; `stop()` rejects with the failure, and an `app.quit` that stops the
    mock leaves no unhandled rejection.
  - The mock: `content.shiftTiming` takes the range as closed, so a handle exactly on the end moves as well as one
    exactly on the start, as the real OpenTune does. The mock used to leave out a handle on the end.
- The rounding of the tempo at a switch of the view needs the keyboard focus in the tempo field (OTCP specification
  `1.0.0-rc.7`, contract change record `docs/contract-changes/20261026-tempo-focus.md`). The text and the contract
  vector said that every switch rounds a tempo with two decimals. A started OpenTune whose window is in the background
  does not hold the focus in the field, so a switch there leaves the tempo as it is, and the vector failed on such a
  run. The specification now says that the rounding happens only while the field holds the focus, as in a window in the
  foreground that has just started, and that the result reports it only when it happened. The vector
  `ui/set-workspace-tempo-rounded` states that as its precondition `keyboardFocus` `tempoField`, which a runner that
  cannot establish it skips with the reason; the exe runner of this repository skips it that way. Tool results are
  unchanged: they already report the rounding only when the instance sends it.
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

- The `beat-grid` skill no longer declares `allowed-tools`. That line let every shell command and file read or write
  run without asking while the skill was loaded; now the user's own permission settings apply to each command of the
  skill.
- The `lyrics-timeline` skill no longer declares `allowed-tools`. Until now, while that skill was loaded, any Bash
  command and any file read or write ran without Claude Code asking the user.
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
