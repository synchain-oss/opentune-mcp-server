# Contract change: the settings tool

## Background

`opentune_get_settings` reads the global settings of the OpenTune installation, but no tool could change them. This
change adds `opentune_set_settings` on top of the OTCP methods `prefs.set` (capability `prefs.write`), `audio.set`
(capability `audio.device`) and `project.clearRecent` (capability `project.io`), all already in the specification.

- `opentune_set_settings` (`processing`, `audio_device`, `clear_recent`, `wait_seconds`, `instance_id`): not read-only,
  not destructive, idempotent. At least one group is required, and a group must name at least one value.
  - `processing` takes exactly the settable fields of `prefs.set`: `tuning_hz` (400 to 500), `editing_scheme`
    (`openTune` or `openDyne`), `hybrid_mode` and `experimental_features`.
  - `audio_device` takes the fields of `audio.set`: `device_type`, `output_device`, `sample_rate_hz`,
    `buffer_size_frame` and `output_channel_pair`.
  - `clear_recent: true` calls `project.clearRecent`.
  - The groups run in that order. The first failure stops the call, and the error carries what the earlier groups
    already applied (`applied_before_error`).
  - A change of the editing scheme runs as a job. The call follows it for up to 25 s by default (30 s at most) and
    returns the job id when it has not ended; no later group is attempted then.
- Each group checks only the capability it needs, so a build without `audio.device` can still change the processing
  preferences. A missing capability gives the usual `UNSUPPORTED(capability_missing)` error.
- These settings belong to the installation, not to the project, and OpenTune records no undo entry for them. The
  first sentence of every result says so and points to the revert line. The revert recipes of `prefs.set` and
  `audio.set` are now mapped to an `opentune_set_settings` call with the previous values, so the revert line gives a
  call that can be made as it is. A recipe value outside the tool's input schema is left out, and a recipe left with
  no value becomes a manual restore.
- New next steps for `INVALID_ARGUMENT(audio_setting_unavailable)` (read the available values with
  `opentune_get_settings` and call again) and `IO_ERROR(device_open_failed)` (OpenTune restored the previous setup;
  the user chooses another device or frees it).
- Device names come from the system: they stay JSON string values and are never placed in a summary sentence.

`project.clearRecent` was on the list of unexposed methods in `test/unit/project-files-tools.test.ts`; it is exposed
now and that list is empty.

## Files

| File                                                   | Change                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `test/golden/tools-list.json`                          | Adds `opentune_set_settings`.                                      |
| `test/golden/render/settings-preference-revert.json`   | New: the rendering of a processing change with its revert call.    |
| `test/golden/render/settings-audio-device-revert.json` | New: the rendering of an audio device change with its revert call. |
| `docs/reference.md`                                    | Regenerated: the new tool.                                         |
| `mcpb/manifest.json`                                   | Tools list synced from the golden catalog.                         |

The OTCP specification (`spec/otcp/v1/`) and the instructions are not changed.

## Compatibility

The catalog only grows: existing tools keep their names, descriptions and schemas, so clients that do not know the new
tool keep working. Revert lines of other tools are unchanged. An OpenTune build that does not report `prefs.write`,
`audio.device` or `project.io` answers the matching group with `capability_missing`; the mock implements all three
methods and the tests run against it.
