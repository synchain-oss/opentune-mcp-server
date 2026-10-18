# Contract change: track, transport and window tools

## Background

Until now no tool could change tracks, drive the transport bar or deal with dialogs, although the specification
(`spec-v1.0.0-rc.3`) already defines the OTCP methods and the mock implements them. This change adds four tools. The
specification is not changed.

- `opentune_set_tracks` (`ops[]`, `instance_id`): not read-only, not destructive, not idempotent; needs `tracks.v1`.
  Ops: `mute` and `solo` (`track_id`, `on`), `volume` (`track_id`, and `db` or `linear`), `colour` (`track_id`,
  `#RRGGBB`), `reveal` (`count`) and `duplicate` (`track_id`, `mode` `clone` or `share`). Consecutive mute, solo,
  volume and colour ops become one `track.set`; `reveal` is `track.add`, `duplicate` is `track.duplicate`. Mute, solo,
  volume and colour have no undo entry in OpenTune, so the first sentence of the result says so and the result gives
  the `opentune_set_tracks` call that restores the old values (mapped from the revert recipe). A duplicate is not
  undoable either; its way back is `opentune_delete_track`, which needs the user's agreement. A target slot that holds
  clips is an error whose next step is to show that slot with `reveal` first.
- `opentune_delete_track` (`track_id`, `confirm`, `expected_revision`): destructive. `expected_revision` is the
  `arrangement_revision` of `opentune_get_project`; a change that leaves the arrangement as it is (colour, volume, mute,
  notes) does not conflict. Without `confirm: true` nothing is sent and the next step asks the user. The first sentence
  of the result says that the deletion cannot be undone, that every later track moved down by one position (with the
  `trackIdMap`), and how many undo and redo entries may now address tracks that moved.
- `opentune_transport` (`action`, `position_sec`, `bpm`, `time_signature`, `loop`): not destructive, idempotent; needs
  `transport.v1`. `action` is one of `play`, `pause`, `stop`, `seek`, `play_from_last_start` (`playFromLastStart`) and
  `return_to_last_start` (`pauseAtLastStart`); `action` is optional so that the tempo can be set alone. The tempo and
  time signature are set first, then the loop flag, then the action. The last start is the position of the last play
  or seek, not 0. The tempo and time signature cannot be undone (as in OpenTune) and the result gives the call that
  restores them. The loop flag has no audible effect in the standalone (`LOOP_NO_EFFECT_STANDALONE`).
- `opentune_manage_ui` (`op`, `clip`, `open_editor`, `dry_run`, `accept_commit`): destructive, idempotent; needs
  `ui.bridge`. It is marked destructive because selecting a clip can generate its notes with no undo entry and marking
  the onboarding as shown cannot be undone; MCP clients use the hint to decide whether to ask first. `focus_clip` selects a clip (`ui.setSelection`); selecting can generate the clip's notes without an
  undo entry, queue reference analysis and change the scale shown in the transport bar, so `dry_run` predicts these
  effects and a real call names them in the first sentence. `dismiss_dialogs` (`ui.dismiss`, target `dialogs`) is
  refused while a dialog would commit its value (the track-colour dialog) unless `accept_commit` is true, which only
  the user may allow. `dismiss_onboarding` marks the first-run onboarding as shown (a global setting, cannot be undone).

Several requests in one call run in order and a failed one stops the call; the error lists what the requests before it
applied.

Other changes that clients can see:

- The error `BUSY` with reason `modal_open` has a next step of its own: call `opentune_manage_ui` with `op:
dismiss_dialogs`, asking the user first because closing a dialog can commit its value. It replaced the general
  "ask the user to finish" step for this reason only.
- New next steps for the reasons `dialog_commits_on_close`, `target_track_occupied`, `track_limit`, `last_track`,
  `track_hidden` and `arrangement_changed`.
- Revert recipes of `track.set`, `track.delete`, `transport.setTempo`, `transport.setLoop` and `ui.setSelection` (when it
  names a clip) are now carried out by tool calls (`restore` in the revert line); a recipe that asks for the arrangement
  revision says so.

## Files

| File                                      | Change                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `test/golden/tools-list.json`             | Adds the four tools.                                                                    |
| `test/golden/track-tools/*.json`          | New: results of the four tools against the mock, errors with their next steps included. |
| `docs/reference.md`                       | Regenerated: the four tools.                                                            |
| `mcpb/manifest.json`                      | Tools list synced from the golden catalog.                                              |
| `docs/TROUBLESHOOTING.md` and `.zh-CN.md` | The `modal_open` and first launch sections mention `opentune_manage_ui`.                |

## Compatibility

The catalog only grows: existing tools keep their names, descriptions and schemas. The instructions text is not
changed. An OpenTune build without `tracks.v1`, `transport.v1` or `ui.bridge` still works for every other tool; the
new tools answer `UNSUPPORTED(capability_missing)`. The size of `tools/list` is now about 54 KB, within the 64 KB limit;
each new tool is below 4 KB.
