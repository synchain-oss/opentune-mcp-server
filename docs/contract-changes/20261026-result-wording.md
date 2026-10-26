# Contract change: result wording that agrees with the facts

## Background

Real-machine runs found eight places where the one-sentence summary of a result, or a line next to it, said something
that the fact fields of the same result contradict, or left out something the facts show. A reader who trusts the
first sentence is misled: "no tool can restore it" for a tempo change that `opentune_transport` restores, "created 200
notes" for a result that created 962, "no side effects beyond the selection" next to `sideEffects.workspaceSwitched`.
This change corrects the wording and the numbers, adds one result member (`baseline` of `opentune_analyze_pitch`) and
shortens the `opentune_analyze_pitch` and `opentune_estimate_key` descriptions to make room for what they now say. The
OTCP specification (`spec/otcp/v1/`) and the MCP instructions are not changed; the tool calls are the same as before.
No tool, argument or error kind is added or removed. Items 3 and 9 were added after the op `switch_view` of
`opentune_manage_ui` was merged into the main line: the way back of a window switch is now that op, and the no-op
summary of the op keeps the warnings as the one of `focus_clip` does.

## Files

| File                                                                                   | Change                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/golden/tools-list.json`                                                          | The descriptions of `opentune_analyze_pitch` and `opentune_estimate_key`.                                                                                                                    |
| `docs/reference.md`, `mcpb/manifest.json`                                              | Regenerated / synced from the golden catalog by `npm run catalog:update`.                                                                                                                    |
| `test/golden/render/*.json`                                                            | The sentence about a queued render (`edit-undoable`, `many-changes`, `notes-replaced-destructive`, `pitch-shift-warning`, `settings-vocoder-weight-*`, `timing-shift-clamped`, `undo-step`). |
| `test/golden/edit-tools/*.json`                                                        | The same sentence (`autotune-*`, `edit-notes-*`, `redo-step`, `undo-step`, `set-clip-*`).                                                                                                    |
| `test/golden/arrangement/edit-several-ops.json`                                        | The first sentence names the hidden tracks it showed.                                                                                                                                        |
| `test/golden/track-tools/set-tracks-duplicate.json`, `set-tracks-reveal-and-solo.json` | The first sentence names the hidden track a copy showed and the colour it changed from and to.                                                                                               |
| `test/golden/track-tools/manage-ui-focus.json`                                         | The window switch is named in the first sentence, and a revert line gives the `switch_view` call as the way back.                                                                            |
| `test/golden/track-tools/manage-ui-focus-without-workspace.json`                       | New: the same call on a build without `ui.workspace`; the revert line says that no tool switches back and that the user can click the view button.                                           |
| `test/golden/track-tools/manage-ui-dismiss-commit.json`                                | The first sentence names the track colour the dialog committed.                                                                                                                              |
| `test/golden/project-files/*.json`                                                     | New: the save results (`save-as-new-file`, `save-current-file`, `save-overwrite-other-file`) with the media-copy sentence and `mediaFolder`.                                                 |
| `scripts/update-catalog.mjs`                                                           | Also runs the golden test of the save results.                                                                                                                                               |

## 1. Tempo change: the way back was refused

**Problem.** After `opentune_transport` changed the tempo, the result said "cannot be restored by any request". The
revert recipe of `transport.setTempo` lists only the members that changed (a tempo alone, a time signature alone, or
both), and the mapping of the recipe to a tool call accepted only both together.

**Fix.** A recipe with `bpm` only, `timeSignature` only, or both maps to `opentune_transport` (`bpm`,
`time_signature`). A recipe with an unknown member or an invalid value still maps to nothing and says so. The test mock
now lists only the changed members, as the real build does. A new guard, `test/unit/revert-vectors.test.ts`, walks
every revert recipe in the vectors (`undo.revert` and `sideEffects.*.revert`) and asserts that each maps to a tool call
that passes the input schema of its tool, except an explicit list with reasons (only `ui.setSelection` with a track:
no tool selects a track). The guard fails when the mapping of `transport.setTempo`, `transport.setLoop`, `track.set`,
`prefs.set` or `edit.undo` is removed.

**Client impact.** The revert line of a tempo change now carries a `restore` call (`opentune_transport`) where it had
`null`. Clients that read `restore` need no change.

## 2. Counts in a summary were the length of a cut list

**Problem.** A method lists at most 200 entries each in `changes`, `created` and `removed` and counts the rest in
`omittedCount` (`content.autoTune`, `project.open`) or `omittedChangeCount` (`content.editNotes`). The summary counted
the listed entries: "created 200 notes" for a result whose `noteCount.after` was 962.

**Fix.** The summary uses the listed entries plus what the method left out, and a list that was cut says so after the
first sentence: "Only the first 200 entries of created are listed." A cut list whose listed entities have one name is
named by it ("962 notes"); otherwise it is "items". The code documents the three numbers: `omittedCount` and the
envelope's `omittedChangeCount` are OpenTune's, per kind and for `changes`; `changeTable.omittedChangeCount` is this
server's and counts every entity of the result that is not a row of the table, so rows plus that number are all the
entities of the result.

**Client impact.** `changeTable.omittedChangeCount` is larger than before for a result with a cut `created` or
`removed` list (it used to count only `changes` left out by the method and the rows beyond the row limit). Summaries
that said "and N more not listed" now give the total and the sentence about the list.

## 3. A selection that switched the window said it had no other side effects

**Problem.** `opentune_manage_ui` with `focus_clip` and `open_editor: true` said "no side effects beyond the
selection" while `sideEffects.workspaceSwitched` was present, and gave no way back.

**Fix.** "No side effects" is said only when `sideEffects` is empty. Every side effect is named; the window switch is
named with its views ("switched the window from the arrangement view to the piano roll, as open_editor asked", or
listed as unasked when `open_editor` was not set). The way back is a revert line next to the side effect: on an
instance that reports `ui.workspace` it says to use the op `switch_view` of `opentune_manage_ui` and carries the call
in `restore` (`{op: "switch_view", view: <the view the window showed>}`); `revert` stays `null`, as OpenTune sends no
recipe for the side effect. On an instance without `ui.workspace` the line says that no tool of this server switches
the window back and that the user can click the view buttons in the transport bar, and `restore` is `null`. A result
of `switch_view` itself carries its own recipe in `undo.revert`, so it gets no second line, and a dry run, which
switched nothing, gets none either. A view name that this server does not know is not repeated: the line says "another
view" and falls back to the click.

**Client impact.** Wording, plus one revert line whose `restore` is now set for a `focus_clip` that opened the editor
on an instance with `ui.workspace`. Clients that read `restore` need no change. The `RenderContext` of the renderer
has a new optional member `canSwitchView`; it is set by `opentune_manage_ui` from the capabilities of the instance.

## 4. Duplicating a track: what it showed and recoloured was left out

**Problem.** The first sentence of a track copy said "changed 1 track" while the copy took the first hidden track, made
it visible and gave it the colour of its source.

**Fix.** The first sentence names the revealed tracks ("revealed the hidden track 5") and each colour change ("the
colour of track 5 changed from #4DB6AC to #E57373"), taken from `changes` and `sideEffects.tracksRevealed`. A dry run
says "would reveal" and "would change". Positions are checked integers and colours checked `#RRGGBB` values; other
values are left out of the sentence. The same wording appears for `opentune_edit_arrangement` and every other tool whose
result reveals a track.

**Client impact.** Wording only; the generic text "hidden tracks became visible" is no longer repeated in the
side-effect list when the tracks are named.

## 5. A first save-as read like an overwrite, and the media copy was not said

**Problem.** A save-as to a new path said "cannot be restored", the wording of an overwrite. No save result said that
OpenTune copies the audio the project uses into a folder next to the project file.

**Fix.** When `project.saveAs` changed the project's path and replaced nothing, the first sentence says that a new
project file was written (the path stays in `path`) and that no existing file was replaced. The irreversibility note is
in the warning lines. An overwrite keeps the strong warning. Every save result now says, as a fixed sentence that is not
built from the result, that "OpenTune also copies the audio the project uses into the Project_Media folder next to the
project file" (files copied before and unchanged are skipped): right after the first sentence for a save to a new
place (`save_as`, overwrite), and after the facts of the save for a save to the project's own file. The body gains
`mediaFolder`: the folder, built from the path this server checked itself (`save_as` and overwrite); `null` with the
reason `project_path_not_given` for a save to the project's current file, whose path only OpenTune knows.

**Client impact.** Wording, plus one added member (`mediaFolder`) that clients may ignore.

## 6. Key estimate: which key to trust, and what the confidences cover

**Problem.** "The clip's key in OpenTune has other notes than the estimate (see clip.key)" did not say which of the two
is more trustworthy. The two confidences were not described: the top-level pair belongs to `estimated_over`, the
`local_keys` confidence is a mean over a segment. The last `local_keys` entry ended at the length of the mix (270.63 s)
although the clip lasts 272 s.

**Fix.** The sentence names the clip key and where it came from (set by the user, found automatically) and gives a
verdict: a key set by the user stands; an automatic key gives way to a sure estimate (scale set confidence at least
0.6) that also hears the mix; otherwise neither is clearly better and the user is asked. A scale other than major and
minor is named as "dorian on root 2". The summary states the range of the estimate ("over 0 to 272 s", or "of the main
part") and that the confidences cover it, and that `scale_set_confidence` in `local_keys` is the mean over the short
windows of that segment. With a clip, `local_keys` and `estimated_over` end at the end of the clip; the mix is read from
its start. The warning for a mix and a clip of different lengths now says that times follow the clip. The tool
description says the same in a shorter form (it was shortened to stay under 600 characters).

**Client impact.** `local_keys[].end_sec` of the last entry and `estimated_over.end_sec` change for a call with a clip
whose length differs from the mix. The summary text changes.

## 7. Pitch analysis: what the deviations are measured against

**Problem.** For a clip without stored notes the deviations are measured against the nearest semitone of the detected
pitch, so they cannot be compared with an analysis after notes exist. Only `note_source` hinted at it.

**Fix.** The result has a new member `baseline`: `stored_notes` or `nearest_semitone`. With the nearest semitone the
summary says the deviations are not directly comparable with an analysis of the same clip once it has notes. The tool
description has one sentence about it (the description was rewritten shorter to fit).

**Client impact.** One member is added to the body of `opentune_analyze_pitch`; clients ignore unknown members.

## 8. A queued render: what the user hears meanwhile

**Problem.** A result with `sideEffects.reRenderQueued` listed the side effect but not what it means: playback can still
sound the old way, and where to see when it is current.

**Fix.** The summary has a sentence after the first one: OpenTune is rendering again, playback can still sound the old
way until `render.current` of `opentune_get_clip_details` is true, and an export waits for the render by itself. A
change of the vocoder weight that has not loaded yet says the render starts only once the weight has loaded. A dry run,
a result that changed nothing and a job that has only started get no sentence. A result that bundles several requests
has it once, at the end.

**Client impact.** Wording only: one sentence is added to the summary of the results that queue a render.

## 9. A view switch that changed nothing dropped the warnings

**Problem.** The summary of `opentune_manage_ui` `switch_view` for a window that already showed the view ("nothing was
changed") ended there, while the same sentence for `focus_clip` ("the clip was already selected; nothing was changed")
appended the warnings of the result. A warning on a no-op was lost from the summary.

**Fix.** Both sentences get their warning tail from one function, `Warnings: A, B.`; there is no tail when the result
has no warning. This follows the review of the change that added `switch_view`.

**Client impact.** Wording only, and only for a no-op result that carries a warning (the mock and the real build send
none today), so no golden file changes.

## Compatibility

New and old clients and servers interoperate unchanged: no method, argument, error kind or required member changes. The
members that change are `changeTable.omittedChangeCount` (item 2), the end of the last `local_keys` entry and of
`estimated_over` (item 6) and the added `baseline` (item 7). Summaries, revert lines and descriptions are text that
clients should not parse.
