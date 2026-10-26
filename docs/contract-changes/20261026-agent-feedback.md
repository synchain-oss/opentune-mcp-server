# Contract change: results that fit the host, a window that blocks writes, settings that say what runs

## Background

A real-machine run with an agent found a set of places where the tools let the agent down. A whole-song regenerate gave
a result of 60,827 characters; the host refused it and the agent lost the undo id. A freshly started OpenTune that
showed its welcome page was reported as ready, and the first write failed with `BUSY (modal_open)`. The rendering
priority `gpuFirst` ran on the CPU without anyone being told. The parameters of `opentune_edit_notes` did not say which
one answers "less vibrato". `opentune_edit_arrangement` told the agent to ask the user before every split, merge and
delete, even when the user had said "cut the clip at 12 s". An export whose mix was above 0 dBFS did not say so.

This change cuts the long lists of a write result, moves the undo information to the front, adds the state of the
window to the status and launch results, adds the rendering backend to the settings results, rewrites a few
descriptions and sentences, and adds the peak of an exported file. The OTCP specification (`spec/otcp/v1/`) and the MCP
instructions are not changed; no OTCP method is added (`ui.getState` and `session.info` were already used by other
tools, and the export file is read from the local disk). No tool, argument or error kind is added or removed.

## Files

| File                                                                 | Change                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/golden/tools-list.json`                                        | The descriptions of the parameters `delta_cents`, `retune_speed`, `pitch_drift_scale`, `vibrato_depth`, `vibrato_rate_hz` of `opentune_edit_notes`; `rendering_priority` of `opentune_set_settings`; the description and `confirm` of `opentune_edit_arrangement`. |
| `docs/reference.md`, `mcpb/manifest.json`                            | Regenerated / synced from the golden catalog by `npm run catalog:update`.                                                                                                                                                                                          |
| `test/golden/render/*.json`, `test/golden/edit-tools/*.json`         | The member order of a write result (the undo information and the lines come first, the long lists last) and, where a list was longer than 20, the cut lists and the change table of 10 rows.                                                                       |
| `test/golden/arrangement/*.json`                                     | The same order; the first sentence of a split, merge and delete names the way back instead of telling the agent to ask first; the previews and the refused delete say when to ask first.                                                                           |
| `test/golden/track-tools/*.json`, `test/golden/project-files/*.json` | The same order of members (no wording change).                                                                                                                                                                                                                     |
| `docs/TROUBLESHOOTING.md`, `docs/TROUBLESHOOTING.zh-CN.md`           | The first-launch dialog section describes `blockedBy`; a new section "Rendering backend and vocoder".                                                                                                                                                              |
| `CHANGELOG.md`                                                       | Unreleased: Changed and Fixed.                                                                                                                                                                                                                                     |

## 1. Large write results are cut, and the undo information comes first

**Problem.** `content.autoTune` over a whole song of 1,200 notes listed every note in `changes`, `created` and `removed`,
and again in `changeTable`; the text and the structured form of the result were 60,827 characters together. The host
rejected it, and with it the undo id.

**Fix.** The lists `changes`, `created`, `removed` and `idMap` of a write result hold at most 20 entries each
(`MAX_LISTED`). What is left out is counted: `omittedCount` has one number per list (`changes`, `created`, `removed`,
`idMap`), the cut and what the method itself left out together, and `omittedChangeCount` is raised by the same amount
when the method sent it. A result that needs no cut is unchanged. The change table is a preview of 10 rows (it was 20),
so what both carry is at most those ten entries and the lists remain the one place with the full entries. The list of
time-grid handles of `opentune_edit_timing` holds 100 (it was 200). For every write that is not a dry run, the members
that tell what happened and how to take it back come first (`summary`, `applied`, `noOp`, `dryRun`, `undo`, `lines`,
then the rest of the envelope, then the long lists last). The summary of a cut result says which lists are shorter than
the result, as it did for lists cut by OpenTune. `opentune_edit_arrangement` still returns every clip id of the call in
`clip_ids` (at most 64 ops, so a bounded list): the next call needs them.

**Test.** `test/unit/output-budget.test.ts` regenerates 1,200 notes and asserts that the text and the structured form
together stay under 20,000 characters, that the undo id is within the first 2,000 characters, and that no list exceeds
20; a control run shows that the uncut result of the same call is over 20,000 characters. The same file checks a notes
edit over all notes, a timing shift with 300 handles and an arrangement edit with 40 clips. Setting `MAX_LISTED` to 1000
turns six of these red.

**Client impact.** A client that read `created[]`, `removed[]` or `changes[]` beyond the 20th entry must use
`omittedCount`; the entries that the result no longer holds are in the project and can be read with
`opentune_get_notes` and `opentune_get_project`. JSON objects are unordered, so a client that reads members by name is not
affected by the new order.

## 2. The window is read by the status and the launch

**Problem.** `opentune_get_status` and `opentune_launch` reported `READY` and "ready" while the first-run welcome page (or
any dialog) was open, and the first write failed with `BUSY (modal_open)`. A vocoder that was not loaded yet
(`vocoderReady: false`, normal right after the start) was easy to read as a fault.

**Fix.** A ready instance with the capability `ui.bridge` is asked once with `ui.getState`. When `onboarding.showing` is
true, the result gets `blockedBy: {kind: "onboarding", hint}`; when a modal is open (`busy.modalOpen` or a dialog is
listed) and the state does not say that the first-run page is showing, `blockedBy: {kind: "dialog", hint}`. The summary
says that OpenTune runs but writes are refused until the window is closed, and the next step is `opentune_manage_ui` with
`dismiss_onboarding` (the welcome page; it marks onboarding as shown, which cannot be undone, so the next step tells the
agent to tell the user) or `dismiss_dialogs`. If the state cannot be read, `blockedBy` is `null` with
`nullReasons.blockedBy` `unavailable`, and the status stays `READY`. An instance without `ui.bridge` has no member. With
several instances, only the per-instance `blockedBy` is given. The fields of the result that already existed are not
changed, and `vocoderReady: false` is still reported as it is; the summary adds one sentence saying that the vocoder loads
at the first render, so it not being loaded just after the start is normal.

**Test.** `test/unit/tools.test.ts` and `test/unit/launch.test.ts` (the fake build answers `ui.getState` with a welcome page
or a dialog), with the cases: onboarding, dialog, nothing open, a failed read, a state that does not tell the overlay
apart, several instances.

**Client impact.** A new optional member and a different summary and next step for a ready but blocked instance.

## 3. The settings say what runs

**Problem.** `opentune_get_settings` listed the options of `renderingPriority` without saying what they do, and with
`gpuFirst` on the CPU nothing said so. After a change of the priority `opentune_set_settings` did not say which backend
runs.

**Fix.** `processing.optionNotes.renderingPriority` has one note per value that the instance lists and this server knows:
what it means and that it takes effect at once (the vocoder reloads for a few seconds, nothing is rendered again). When
the priority is `gpuFirst` and `processing.backend` is `cpu`, the summary says that the GPU may be unavailable or have fallen
back and where to look (the log with `sections ["log"]` and `log_lines` 30, and `opentune-mcp doctor`, which checks
Direct3D 12). `opentune_set_settings` reads `session.info` once after the job of a change of the priority and adds
`rendering_backend: {requested, backend, vocoder_reloading}`; for `gpuFirst` with the CPU it says so with the same two
places, and a vocoder that is still reloading after a wait of at most 6 seconds is said to be reloading and not guessed.
A failed read gives `rendering_backend: null` and `nullReasons.rendering_backend`. The description of `rendering_priority`
is a little longer. Sentences are composed from the enum values only; no OpenTune string is put in them. The mock can now
express "gpuFirst requested, CPU actual".

**Test.** `test/unit/details-settings-tools.test.ts` and `test/unit/set-settings-tools.test.ts`, including a backend string
that carries an injection, a vocoder that reloads and a failed read.

## 4. The parameters of `opentune_edit_notes`

`delta_cents` (cents to raise or lower the target pitch, 100 is a semitone), `retune_speed`, `pitch_drift_scale` (scales the
voice's own pitch wobble; this is the usual meaning of "vibrato" in a request: 1 keeps it, below 1 weakens it, 0 removes
it), `vibrato_depth` and `vibrato_rate_hz` (synthetic vibrato added on top, default 0) have a description. The tool
description is unchanged, and the tool stays under its 9 KB limit.

## 5. `opentune_edit_arrangement`: when to ask

**Problem.** The description and the results told the agent to ask the user before every split, merge and delete, which
made it ask again after the user had said "cut the clip at 12 s". The companion skill already says that a request that
names the step is the agreement.

**Fix.** The description says to do the step when the user named the clip or the time, else to ask first; `delete`
still needs `confirm: true`, which the user's own request for the delete provides. The first sentence of a split, merge
or delete that cannot be undone keeps the explanation of the OpenTune defect and ends with the way back ("the revert line
says how to put it back", or "no request can restore it either"), where it said to ask before every such step. The
preview and the other sentences say to apply the step only when the user asked for it and named the clip or time, and to
ask first otherwise. The next step of the refused delete (`confirm_required`) says to call again with `confirm: true` when
the user asked for the delete, and to ask first when not; its actor is now the agent. The error that says a structural op
goes alone no longer says "after the user agreed".

**Test.** `test/unit/edit-arrangement.test.ts`: the description, the parameter, the preview, the refused delete, the lead of
every structural kind with and without a way back, and a split that is done directly.

## 6. `opentune_export_audio`: the peak of the file

**Problem.** A mix of voice and accompaniment exported to a 32-bit float file had a peak of +3.95 dBFS; converting it to 16
bits clips, and nobody said so.

**Fix.** After a finished export the server reads the file it wrote once, in blocks of 1 MiB (never the whole file),
and adds `peakDbfs` (to two decimals) and `clippedSampleCount` (samples with an absolute value above 1.0) to the result. A
peak above 0 dBFS adds a sentence to the summary: the peak, the number of samples above full scale, that converting to 16
bits or playing it elsewhere may clip, and to lower the volume of a track with `opentune_set_tracks` and export again. The
path that is read is only the one in the job result and only if it is the path asked for or one of the names
`<stem> (2).wav` to `<stem> (999).wav` in its folder, which are the names an export tries; it is not a link; a file whose
audio is over 1 GiB is not read. A read that fails (missing, not a WAV, an unsupported layout) leaves both members `null`
with the reason in `nullReasons` (`unreadable`, `not_a_wav`, `unsupported_format`, `too_large`,
`not_the_exported_file`), and the export result is unaffected. A silent file has `peakDbfs` `null` with the reason
`silent` and a count of 0. Integer samples of 8 to 32 bits and floats of 32 and 64 bits are read; the format tag
extensible is read by its sub-format.

**Test.** `test/unit/export-peak.test.ts` with small WAV files generated at run time: unclipped, clipped, 16 and 24 bits,
64-bit float, an open data size, a file over one block, damaged files, a link, and the export tool with a hook that
puts such a file at the path of the job result (unclipped, clipped, deleted, damaged, a path elsewhere). Replacing the
check of the path, or counting a sample of exactly full scale, turns the tests red.

**Client impact.** Two new optional members, a new optional sentence, and new `nullReasons` values.

## 7. Three small leftovers

- `opentune_estimate_key` names the scale of the key of a clip in a sentence only when it is a token and one of the scales
  of the protocol; any other word is said as "another scale". The value stays a JSON value.
- `opentune_manage_ui`: a side effect whose details are not an object is named from the fixed table; it used to be
  skipped, and the summary said "no other side effects".
- `combineResults` (the combined result of the track and transport tools) words a queued render generically: the render
  state of the single result belongs to a change of the vocoder weight, which only `prefs.set` makes, and none of the tools
  that combine results sends it. A comment says so and a test keeps the list of methods of these tools free of it.

## Sizes of `tools/list`

Total 62,588 bytes of 65,536 (it was 61,907). By tool: `opentune_edit_notes` 7,183 of 9,216; `opentune_set_settings` 3,874 and
`opentune_edit_arrangement` 3,829 of 4,096.

## Old and new clients and servers

All changes are additions or rewordings of results of the tools; the OTCP wire, the tool names, the arguments and the error
kinds are the same. An older client that reads the old summary sentences or the member order sees the new ones; one that
reads members by name sees every old member, with long lists cut at 20 (see 1). An older OpenTune build is unaffected: a
build without `ui.bridge` has no `blockedBy`, one that reports no `backend` has `backend` `null`, and an export that wrote
a file this server cannot read has the two members `null`.
