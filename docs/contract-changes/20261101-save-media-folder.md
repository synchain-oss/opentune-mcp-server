# Contract change: the `mediaFolder` of a save result is the folder found after the write

- Date: 2026-11-01
- Frozen surface: `test/golden/project-files/*.json` (one new snapshot); the result of `opentune_save_project` (modes
  `save_as`) and `opentune_save_project_overwrite`
- Specification: unchanged (`1.0.0`); wire version unchanged (`1.0`)

## Background

`mediaFolder` in the result of a save to a path the call gave (`save_as`, the overwrite tool) was always
`<file name without extension>_Media` next to the file. That is the folder of a build that implements `1.0.0-rc.9`. A
build that implements `1.0.0-rc.8` (the test builds that are published) copies the audio into one `Project_Media` folder
that all the project files of the directory share, so for such a build the member named a folder that does not exist.
The fixed sentence of the summary already names both layouts, and the protocol version on the wire does not tell the two
builds apart, so the member has to follow the file system, as the member of an autosave copy already does.

## Changes

| File                                                                              | Change                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/tools/project-files.ts`                                                      | After a save to a path the call gave, the tool looks for `<name>_Media` next to the file, then for the `Project_Media` next to it. `mediaFolder` is the one it finds; when neither is there, or the file system cannot be asked, it is `null` with the reason `media_folder_not_found`. A save to the project's own file is as before: `null`, `project_path_not_given`. |
| `test/golden/project-files/save-as-shared-media-folder.json`                      | New: a `save_as` on a directory that has `Project_Media` (the layout of `rc.8`); `mediaFolder` names it.                                                                                                                                                                                                                                                                 |
| `test/unit/project-files-golden.test.ts`, `test/unit/project-files-tools.test.ts` | The mock writes no audio folder, so the tests make the folder a build would have made before the save; new cases for both layouts, both together, neither, a probe that fails and the overwrite tool.                                                                                                                                                                    |
| `docs/COMPATIBILITY.md`, `CHANGELOG.md`                                           | The entry on media folders says how `mediaFolder` of a save result is found.                                                                                                                                                                                                                                                                                             |

The fixed sentence about the media folder, the other members of the result and the tool descriptions do not change; the
other golden snapshots are byte for byte the same.

## Compatibility

Against a build that implements `rc.9` nothing changes: `<name>_Media` is found and named as before. Against a build
that implements `rc.8`, `mediaFolder` now names `Project_Media` instead of a folder that is not there. A client that
reads the member as "the folder the audio went to" gets the right one in both cases; a client that expected a name ending
in `_Media` on every build has to accept `Project_Media` as well, and `null` when the folder is not found (the
summary and the reason code say so).
