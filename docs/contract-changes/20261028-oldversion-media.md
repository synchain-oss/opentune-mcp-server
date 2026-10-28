# Contract change: an old version keeps its audio

- Date: 2026-10-28
- Frozen surfaces: the result snapshots of the save tools (`test/golden/project-files/*.json`). The `tools/list` snapshot,
  the instructions snapshot and every tool description are unchanged.
- Related: `20261028-autosave-and-save-rules.md` (the old versions this change completes).
- Tool names, the set of tools, the arguments and the OTCP methods do not change; `spec/**` is not touched.

## Background

A real OpenTune showed what an old version needs. A project saved to `proj\test.otproj` had its audio copied by OpenTune
into `proj\Project_Media\1.wav`. After a second save, the earlier content was in `proj\test.oldversion\test-<time>.otproj`.
OpenTune opens a project file by looking for the audio at `<folder of the project file>\Project_Media\<id><extension>` and,
when it is not there, at the path the audio was imported from. For the old version the first place is
`proj\test.oldversion\Project_Media\`, which did not exist. So the old version opened only while the original audio file
was still where it was imported from. Users often delete that file after the import (a downloads folder, for example),
and then going back to an old version loaded no clips and listed the missing `proj\test.oldversion\Project_Media\1.wav`,
although `proj\Project_Media\1.wav` was still there. An old version exists to go back, so it has to carry its audio.

## Changes

| File                                                                       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/files/project-folders.ts`                                             | `ProjectFs` gets `stat` (what is at a path, links not followed) and `copyReplace` (replaces a file by a copy, written under a name of its own and renamed over the target, so that a failure leaves the target as it was). New `copyMediaToOldVersions`; `copyToOldVersions` calls it once the old version of the project file exists (made now, or reused) and returns its result as `OldVersion.media`. The header states the rules. |
| `src/tools/project-files.ts`                                               | The result of a save that replaced a file gets `oldVersion.media`, and, when some audio was not copied, a warning line and a sentence in the summary. The save itself is not affected by a failure to copy audio.                                                                                                                                                                                                                      |
| `test/unit/project-oldversion-media.test.ts`                               | New: the copy, the rules (target missing, older, newer, equal), directories and links, no folder, the reused old version, the file that the overwrite tool replaces, failures that do not stop the save, the part of a failed copy that is deleted, and the real file system operations.                                                                                                                                               |
| `test/unit/project-autosave.test.ts`                                       | The recording file system knows the two new operations, and the test that the file system work stays inside the folders also covers the audio folders.                                                                                                                                                                                                                                                                                 |
| `test/golden/project-files/*.json`                                         | `oldVersion.media` in the two results that show an old version (`save-current-file.json`, `save-overwrite-other-file.json`); two new files: `save-copies-audio-for-old-version.json` (audio copied) and `save-audio-not-copied.json` (the warning line, on a reused old version).                                                                                                                                                      |
| `plugins/opentune/skills/tuning-workflow/SKILL.md`                         | The sentence about the audio of an old version: it is copied beside it, and what to tell the user when a save warns that some was not.                                                                                                                                                                                                                                                                                                 |
| `docs/TROUBLESHOOTING.md`, `docs/TROUBLESHOOTING.zh-CN.md`, `CHANGELOG.md` | The audio of an old version, that the folder only grows, the warning and how to fix its cause; and, from an earlier review, when the old version made for a refused save is deleted again (OpenTune refuses or reports no change) and when it is kept (any other failure).                                                                                                                                                             |

### The rule

Whenever an old version of a project file is made (and also when the newest one is reused because it holds the same
bytes), before the save is sent, the server copies the regular files of the `Project_Media` folder next to the file that
is being replaced into `<name>.oldversion\Project_Media`:

- The source is the folder of the file that is replaced: the project's current file for `mode: save` and for `mode:
save_as` onto it, the replaced file for `opentune_save_project_overwrite`.
- It follows the rule of OpenTune's own copy of its audio: only regular files; a file is copied when it is missing in the
  target or older than its source (by the time of the last change); nothing is deleted; a newer file in the target is
  never overwritten; links are not followed and sub-folders are not entered.
- A copy that fails part way is deleted again (the file this attempt made). A file that replaces an older one is written
  under a temporary name and renamed over it, so the older one is never left half written.
- When the source folder does not exist, nothing is done and nothing is reported. The folder for the copies is made only
  when there is something to copy.
- The roll of the old versions does not touch the folder, so it only grows, by the audio the project has used.
- A failure to copy audio never fails or stops the save. It is reported (below).

### Result members

- `oldVersion.media` (new member of `oldVersion`, present whenever `oldVersion` is not `null`):
  `{copied, notCopied, notCopiedCount}`. `copied` is the number of files written by this save. `notCopied` lists the
  files that should have been copied and were not, as relative paths with `/` (`Project_Media/1.wav`), at most 20;
  `Project_Media` itself when the folder could not be read or the folder for the copies could not be made.
  `notCopiedCount` is the full number.
- When `notCopiedCount` is more than 0: one more entry in `lines`, `{kind: "warning", code:
"OLD_VERSION_MEDIA_NOT_COPIED", source: "server", text, subject: null, data: {notCopied, notCopiedCount}}`, and one more
  sentence at the end of the facts in the summary, saying that the old version may not find its audio once the original
  audio files are gone, with no file name in it. The code is made by this server and is not in the OTCP warning registry;
  `source: "server"` says so. A client accepts codes it does not know.
- When everything was copied, or there was nothing to copy, the summary is unchanged.

## Interoperability

- A client that reads the earlier results keeps working: every member it knows is unchanged; `oldVersion.media`, the
  extra `lines` entry and its code are new and may be ignored. The `source` member in a line is new; lines from OpenTune do
  not have it.
- Old versions made before this change have no `Project_Media` folder. They open as before (while the original audio is in
  place). The next save that makes or reuses an old version in the same `.oldversion` folder adds the audio to the folder,
  and an old version with the same audio names then finds it.
- The server now writes into one more folder, `<name>.oldversion\Project_Media`, and into no other place outside the two
  folders; it still deletes only regular files that match `<name>-autosave-<number>.otproj` and
  `<name>-<YYYYMMDD-HHMMSS>[-<n>].otproj` there, except for the part of a copy of audio that failed while it was written.
- As in the folder next to the project file, a file in `Project_Media` is replaced by a newer source of the same name. If
  the audio of a project was replaced under the same name between two old versions, the older old version finds the newer
  audio under that name. This is how OpenTune's own audio folder behaves, and the reason an autosave copy has a folder
  of its own.
- Copying takes time proportional to the audio that is new (a file already there and not older is only looked at). The
  first save of a project with a lot of audio copies all of it.
