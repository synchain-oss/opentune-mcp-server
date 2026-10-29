# Contract change: clip edits on the timeline (opentune_edit_arrangement)

## Background

Until now no tool could change clips on the timeline: an agent could edit notes, keys, pitch and timing inside a clip,
but not move, trim, split, merge, delete or copy clips, which OpenTune's arrangement view offers. This change adds one
tool on top of the OTCP methods `arrangement.edit` and `arrangement.copy` (capability `arrangement.v1`, already in the
specification), and lets results whose revert recipe names `arrangement.edit` give it as a call of the new tool.

`opentune_edit_arrangement` (`expected_revision`, `ops`, `dry_run`, `confirm`, `instance_id`): not read-only,
destructive (`destructiveHint: true`: a delete can be neither undone nor restored, and a split or merge cannot be
undone), not idempotent. Times are on the timeline clock, in seconds.

- `ops` (1 to 64, in order): `move` (`clip`, `to_track_id` and/or `start_timeline_sec`), `trim` (`clip`, `edge`,
  `to_timeline_sec`), `gain` (`clip`, `gain_db`), `fade` (`clip`, `fade_in_sec` and/or `fade_out_sec`), `split`
  (`clip`, `at_timeline_sec`), `merge` (`leading_clip`, `trailing_clip`), `delete` (`clips`), `set_reference` (`clip`,
  `reference_clip`, left out to unbind) and `copy` (`clips`, `mode` `window` or `full`, `to_track_id`, `start_timeline_sec`). Clip
  ids are placement ids (`p:...`); the tool checks their form, the whole-number track ids and the parts each op needs
  before it sends anything, so the input schema can stay small (no pattern repeated in every op).
- `move`, `trim`, `gain`, `fade` and `set_reference` are one `arrangement.edit` request and one undo step.
- `split`, `merge` and `delete` each go in a call of their own, as `arrangement.edit` requires. OpenTune frees objects
  that its own undo entry for them needs, so they cannot be undone: undoing a delete does nothing, undoing a split or
  merge makes the audio vanish from the timeline. OTCP reports `upstream_undo_defect`; the first sentence of the result
  says that the step cannot be undone, that the user should not undo it in the OpenTune window either, and to ask the
  user before every split, merge or delete. A preview (`dry_run`) of these ops says the same about applying them.
- `delete` needs `confirm: true`, which only the user may allow; without it OTCP refuses with `confirm_required` and the
  error's next step asks the user (actor `user`). `confirm` is refused with any other op.
- `copy` goes alone too: it has no undo entry (as in OpenTune), so it cannot share a call with ops that are one undo
  step. A call that mixes them is refused before anything is sent, and the error says to make two calls. `copy` has no
  preview (`arrangement.copy` has no dry run), so `dry_run` with it is refused. The result gives the removal of the
  copies as the way back; that is a delete, so the revert line says to add `confirm: true` only after the user agreed.
- A trim records the clip fades in its undo step (OTCP applies the fades first, then the trim), so undoing it puts back
  fades that the trim shortened; the summary says so.
- `expected_revision` is the `arrangement_revision` from `opentune_get_project` or from the last result of this tool,
  which returns the new one. Only `expectedArrangementRevision` is forwarded, so a change of notes, keys or pitch does
  not conflict, while any change of the clips does (`REVISION_CONFLICT(arrangement_changed)`, next step: read the
  project again). A `clip_revision` is refused with a next step that names the right token.
- The result is the rendered write envelope plus `arrangement_revision` and `clip_ids` (`created`, `removed`): the
  placement ids a later call can use at once, for example the two parts of a split for a merge.
- The OTCP reasons `split_out_of_range`, `merge_not_possible`, `trim_out_of_range`, `reference_ineligible`,
  `confirm_required`, `arrangement_changed`, `unknown_handle`, `stale_handle` and `f0_not_ready` get next steps of
  their own.

The tool fits the per-tool limit of 4 KB in `tools/list` (4,057 bytes). With it the catalog is about 49 KB of the
64 KB total limit. `reference_clip` is left out to unbind instead of taking `null`, so the input schema has no `type`
array, which the Inspector's portability check (`--strict`) warns about.

Revert recipes: `src/render/revert.ts` now turns a recipe whose method is `arrangement.edit` into a call of
`opentune_edit_arrangement`, with the recipe's `expectedArrangementRevision` as `expected_revision` and every op in
the tool's form. This applies to every result with such a recipe: the merge after a split, the split after a merge,
the removal of copies, and the removal of imported clips when an OpenTune build gives that recipe for `import.start`
(the test mock gives none). A call that splits, merges or deletes cannot be undone in turn, so the revert line and the
summary say to make it only after the user explicitly agreed, even when the recipe has no `requiresConsent` (the merge
that restores a split and the split that restores a merge carry none); when it deletes clips, the line also says to
add `confirm: true`. A recipe that the tool cannot take (unknown op, malformed ids, no expected revision) stays a
recipe the user carries out by hand, as before.

## Files

| File                                         | Change                                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `test/golden/tools-list.json`                | Adds `opentune_edit_arrangement`.                                                                                                  |
| `test/golden/arrangement/*.json`             | New: the tool's results against the mock (each op kind, previews, the refused mix, the delete consent, errors).                    |
| `docs/reference.md`                          | Regenerated: the new tool.                                                                                                         |
| `mcpb/manifest.json`                         | Tools list synced from the golden catalog.                                                                                         |
| `src/render/revert.ts`, `src/render/text.ts` | `arrangement.edit` recipes as tool calls, a split, merge or delete only with consent (delete: `confirm`); the revision token form. |

The instructions and the OTCP specification (`spec/otcp/v1/`) are not changed, and no existing golden snapshot
changes.

## Compatibility

The catalog only grows: existing tools keep their names, descriptions and schemas, so clients that do not know the new
tool keep working. An OpenTune build that does not report `arrangement.v1` still works for every other tool; the new
tool answers with `UNSUPPORTED(capability_missing)`, which asks the user to update. Results of other tools change only
where OpenTune gives a revert recipe that names `arrangement.edit`: the revert line then names a tool call instead of
asking the user to restore by hand.
