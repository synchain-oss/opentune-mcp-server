# Contract change: project save and open tools, and the save habit

## Background

OpenTune has no autosave, and the undo history is not stored in the project file, so everything an agent did is lost
when OpenTune closes or crashes unless the project was saved. Until now no tool could save or open a project. This
change adds three tools on top of the OTCP methods `project.save`, `project.saveAs` and `project.open` (capability
`project.io`, already in the specification), and adds the habit of saving to the server instructions and the
`tuning-workflow` skill.

- `opentune_save_project` (`mode` `save` or `save_as`, `path` for `save_as`, `wait_seconds`, `instance_id`): not
  read-only, not destructive, idempotent. `save` writes the current project file and fails with a next step when the
  project was never saved. `save_as` makes the given `.otproj` path the project file and refuses to replace a
  different existing file; the error points to the overwrite tool and says it needs the user's consent. The call
  follows the save job for up to 25 s by default (30 s at most) and returns the job id when it has not ended. The
  result states where the project was saved, whether it is still marked as changed, and what a project file does not
  hold (`notSavedInProject`: the undo history, which tracks are shown, global preferences).
- `opentune_save_project_overwrite` (`path`, `confirm`): destructive, not idempotent. Calls `project.saveAs` with
  `confirm: true`, and only if its own `confirm` is `true`; the description says it is for use after the user
  explicitly agreed. The first sentence of the result says another project file was overwritten.
- `opentune_open_project` (`path`, `discard_unsaved`): destructive, not idempotent. Never saves. With unsaved changes
  it fails with `UNSAVED_CHANGES` and a next step (save first, or discard only with the user's consent). The result
  says that the undo history is cleared, that earlier clip, placement and content ids are invalid, and which media
  files were missing and how many clips and reference bindings were not restored. When the previous project had a file, the
  result gives the way back (opentune_open_project with the previous path, mapped from the revert recipe) and says it
  cannot be undone with opentune_undo; otherwise it says it cannot be undone or restored.

All three declare the capability `project.io` (and `jobs.v1` for following the job); an OpenTune build without
`project.io` gets the usual `UNSUPPORTED(capability_missing)` error, which asks the user to update. Paths go through the
existing normalization (quotes, `file://`, `~`, `/mnt/<drive>/`) and must end in `.otproj`.

`project.clearRecent` is not exposed as a tool: it clears a global preference list that no editing workflow needs. It
is on the list of unexposed methods in `test/unit/project-files-tools.test.ts` with that reason.

## Files

| File                                               | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/golden/tools-list.json`                      | Adds `opentune_save_project`, `opentune_save_project_overwrite` and `opentune_open_project`.                                                                                                                                                                                                                                                                                                                                                                           |
| `test/golden/instructions.txt`                     | Adds one sentence: OpenTune has no autosave, so save with `opentune_save_project` after each finished step and save numbered checkpoints before risky steps. The rest is only shortened in wording to stay within 1,500 characters; every earlier point is kept (ask the user when unsure, hand audio to other apps by file path only, use `opentune_analyze_pitch` rather than an external pitch tracker, import an exported file onto a new track with focus false). |
| `docs/reference.md`                                | Regenerated: the three tools.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `mcpb/manifest.json`                               | Tools list synced from the golden catalog (`node scripts/mcpb.mjs sync-tools`).                                                                                                                                                                                                                                                                                                                                                                                        |
| `plugins/opentune/skills/tuning-workflow/SKILL.md` | New section "Save often" and a line under "Things that go wrong".                                                                                                                                                                                                                                                                                                                                                                                                      |

The OTCP specification (`spec/otcp/v1/`) is not changed.

## Compatibility

The catalog only grows: existing tools keep their names, descriptions and schemas, so clients that do not know the new
tools keep working. The instructions text changed, so a client that caches it sees the new text on its next
`initialize`. A server instance that does not report `project.io` still works for every other tool; only the three new
tools answer with `capability_missing`. On the OpenTune side the three methods must be implemented by the build for
the tools to do anything; the mock implements them and the tests run against it.
