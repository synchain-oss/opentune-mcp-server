<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: MIT
-->

# Compatibility

## Versions

| Part                           | Version                                                                                         | Notes                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official OpenTune installation | 1.7.9 or newer                                                                                  | The oldest version supported. The side-car smoke test (the test build started next to an official installation) passes in CI with 1.7.9 in its default folder, 1.8.1 in its default folder and 1.8.1 in a custom folder.                                                                                       |
| Models                         | From the official installation                                                                  | The test build contains no models and no Direct3D 12 runtime. 1.7.9 must be installed in its default folder, because it keeps its models in its install folder; 1.8.1 keeps them in `%ProgramData%\OpenTune\Models`, so it can be installed anywhere. `opentune-mcp doctor` checks this (`OT_MODELS_MISSING`). |
| OpenTune build                 | An unofficial test build from [synchain-oss/OpenTune](https://github.com/synchain-oss/OpenTune) | An official OpenTune release has no control API and is reported as `NO_API_BUILD`. The test build has `opentune-control.json` next to `OpenTune.exe`, listing `protocolMajors` 1.                                                                                                                              |
| OTCP specification             | `1.0.0-rc.7` (wire version `1.0`, protocol major 1)                                             | The specification in `spec/otcp/v1/` of this repository. The test build and this server must both support protocol major 1; otherwise the status is `PROTOCOL_MISMATCH`.                                                                                                                                       |
| Node.js                        | 22 or later                                                                                     | Not needed for the MCPB package.                                                                                                                                                                                                                                                                               |
| Operating system               | Windows x64                                                                                     | macOS: not yet. Linux: not supported. WSL: run the server with Windows Node.js.                                                                                                                                                                                                                                |

The unofficial OpenTune test build that matches each release of this server:

| Server | OTCP specification | Unofficial OpenTune test build |
| ------ | ------------------ | ------------------------------ |
| 0.2.0  | `1.0.0-rc.6`       | `synchain-test/v1.8.0-ctl.2`   |
| 0.1.0  | `1.0.0-rc.3`       | `synchain-test/v1.8.0-ctl.1`   |

## How long to wait

These times were measured on one Windows machine, with the GPU selected as DirectML but the pitch analysis (F0) running
on the CPU, and with hybrid mode off (see [Hybrid mode](TROUBLESHOOTING.md#hybrid-mode)). They show an order of
magnitude, not a promise: your machine will differ.

| Clip length | Import until F0 is ready | AUTO until the render is stable | Export       |
| ----------- | ------------------------ | ------------------------------- | ------------ |
| 8.5 s       | 0.2 s                    | 0.8 to 0.9 s                    | 30 to 60 ms  |
| 60 s        | 0.9 to 1.3 s             | 10 to 12.5 s                    | 0.1 to 0.3 s |
| 240 s       | 3.0 to 3.1 s             | 25.6 to 31.8 s                  | 0.6 to 0.7 s |

On a CI runner without a GPU (everything on the CPU), a 10 s clip took 1.7 to 3.6 s to import and analyse, a master
export took 3.3 to 4.6 s, and OpenTune took 2.3 to 2.5 s to start.

What this means for a client:

- `opentune_open_audio` and `opentune_export_audio` wait for at most `wait_seconds` (at most 30) and then return the id
  of a job that is still running. Follow it with `opentune_get_job` and its `wait_seconds` in a loop; do not rely on one
  call, and do not start the same import or export again while its job runs.
- A render that has not settled yet is not an error: read the status again and wait. On a machine without a GPU
  (CPU only), audio longer than the 240 s measured above may take longer than the table shows; that was not measured.
- After `opentune_launch`, allow about 30 seconds for OpenTune to announce itself (the tool waits that long itself).
  On Windows, finding an instance can take a few seconds more once (see
  [Slow process discovery](TROUBLESHOOTING.md#slow-process-discovery)).

## Capabilities of the test build

A build lists what it can do as capabilities (`capabilities` in the answer to `session.hello`). Every tool declares the
ones it needs. A build that lacks one answers the tools that need it with the error `UNSUPPORTED`, reason
`capability_missing`, and `detail` names the capability (see
[Error UNSUPPORTED](TROUBLESHOOTING.md#error-unsupported)); every other tool keeps working. Two tools take what a build
can give: `opentune_get_settings` returns a section it cannot read as `null` with the reason
`capability_missing:<capability>`, and `opentune_set_settings` asks only for the capabilities of the groups and members
you give it. A test build older than this server may therefore offer fewer tools than [reference.md](reference.md)
lists. A call of `opentune_set_settings` that names `editing_scheme`, `vocoder_weight` or `rendering_priority` also needs
`jobs.v1`, because OpenTune applies these by a job that the tool follows: on a build without `jobs.v1` the call is
refused with `UNSUPPORTED` before anything is sent, so no change is applied that the tool could not follow.

| Capability       | Tools that need it                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.v1`     | `opentune_get_status`, `opentune_launch`, `opentune_get_settings`                                                                                                                                                                                                                                                                                                                                                                         |
| `read.v1`        | `opentune_get_project`, `opentune_get_notes`, `opentune_get_clip_details`, `opentune_analyze_pitch`, `opentune_estimate_key` (with `clip`), `opentune_export_audio`, `opentune_set_clip`, `opentune_autotune_range`, `opentune_edit_notes`, `opentune_edit_timing`                                                                                                                                                                        |
| `jobs.v1`        | `opentune_get_job`, `opentune_cancel_job`, and every tool that waits for a job: open, export, timing seed, save and open project, and `opentune_set_settings` when it names `editing_scheme`, `vocoder_weight` or `rendering_priority` (checked before it sends)                                                                                                                                                                          |
| `import.v1`      | `opentune_open_audio`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `export.v1`      | `opentune_export_audio`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `edit.v1`        | `opentune_set_clip`, `opentune_autotune_range`, `opentune_edit_notes`                                                                                                                                                                                                                                                                                                                                                                     |
| `history.v1`     | `opentune_undo`, `opentune_redo`                                                                                                                                                                                                                                                                                                                                                                                                          |
| `timing.v1`      | `opentune_edit_timing`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `arrangement.v1` | `opentune_edit_arrangement`                                                                                                                                                                                                                                                                                                                                                                                                               |
| `tracks.v1`      | `opentune_set_tracks`, `opentune_delete_track`                                                                                                                                                                                                                                                                                                                                                                                            |
| `transport.v1`   | `opentune_transport`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ui.bridge`      | `opentune_manage_ui` (the ops `focus_clip`, `dismiss_dialogs` and `dismiss_onboarding`)                                                                                                                                                                                                                                                                                                                                                   |
| `ui.workspace`   | `opentune_manage_ui`, the op `switch_view` only (it asks for this capability and not for `ui.bridge`). A build with `ui.bridge` and without `ui.workspace` answers `switch_view` with `UNSUPPORTED`, reason `capability_missing`, and a next step that asks the user to click the arrangement view or piano roll button in the OpenTune window. The capability is new in `1.0.0-rc.7`, so a test build of `1.0.0-rc.6` or older lacks it. |
| `project.io`     | `opentune_save_project`, `opentune_save_project_overwrite`, `opentune_open_project`, and the `clear_recent` part of `opentune_set_settings`                                                                                                                                                                                                                                                                                               |
| `prefs.write`    | `opentune_set_settings` (the `processing` part)                                                                                                                                                                                                                                                                                                                                                                                           |
| `audio.device`   | `opentune_get_settings` (the `audio_device` section), `opentune_set_settings` (the `audio_device` part)                                                                                                                                                                                                                                                                                                                                   |

### Reference alignment was removed

The experimental reference track and its AUTO Ref button have been retired by OpenTune's upstream project. The window of
this test build may still show the reference track, but the control interface (specification `1.0.0-rc.7`) neither reads,
writes nor reports it, and the capability `reference.v1` is gone from the registry. This server therefore has no mode
`reference` in `opentune_autotune_range`, no `set_reference` in `opentune_edit_arrangement`, no `reference_align_mode`
in `opentune_set_settings` and no reference section in `opentune_get_clip_details`. An instance that follows `1.0.0-rc.6`
or earlier still lists `reference.v1` among its capabilities; this server ignores it and never sends the removed members
to such an instance, so every other tool works with it as before.

## Settings tools and the specification versions

`opentune_get_settings` and `opentune_set_settings` follow `1.0.0-rc.7` of the specification (`prefs.get`, `prefs.set`).
The tools name their fields in snake_case, the specification in camelCase.

| Field of `processing` in the tools     | Member in `prefs.get` and `prefs.set` | Values and notes                                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tuning_hz`                            | `tuningHz`                            | 400 to 500.                                                                                                                                                                                                                                 |
| `editing_scheme`                       | `editingScheme`                       | `openTune` or `openDyne`. Applied by a job.                                                                                                                                                                                                 |
| `hybrid_mode`                          | `hybridMode`                          | On or off.                                                                                                                                                                                                                                  |
| `experimental_features`                | `experimentalFeatures`                | On or off.                                                                                                                                                                                                                                  |
| `vocoder_weight`                       | `vocoderWeight`                       | One of `options.vocoderWeight` of `opentune_get_settings`. Applied by a job; every clip renders again once the weight has loaded.                                                                                                           |
| `rendering_priority`                   | `renderingPriority`                   | `gpuFirst` or `cpuFirst`. Applied by a job; it changes the backend, not the sound.                                                                                                                                                          |
| `f0_model`                             | `f0Model`                             | One of `options.f0Model` of `opentune_get_settings`.                                                                                                                                                                                        |
| `options` (in `opentune_get_settings`) | `processing.options` (`prefs.get`)    | The values `vocoder_weight`, `f0_model` and `rendering_priority` accept on this installation. A name outside the list is refused with `INVALID_ARGUMENT(option_unavailable)` and nothing is changed, also when it equals the current value. |

A call that changes the editing scheme, the vocoder weight or the rendering priority is handed to a job, which the tool
follows for `wait_seconds` like any other job. After a new vocoder weight the result says whether the clips render
again now (the vocoder was ready before the call, so the job waited for the weight to load) or after the weight has
loaded (it was not ready before the call, so the job did not wait, or that could not be read). Two
failures are specific to these jobs, and in both OpenTune takes the changes back: `MODEL_UNAVAILABLE(vocoder_not_ready)`
(the vocoder stayed busy past OpenTune's wait limit; call again) and `MODEL_UNAVAILABLE(vocoder_load_failed)` (it could
not load the new weight or backend; this does not go away by calling again, see
[Error MODEL_UNAVAILABLE](TROUBLESHOOTING.md#error-model_unavailable)).

What a test build of `1.0.0-rc.5` does, since both versions have the wire version `1.0` and the tools decide by
capabilities, not by version:

- `prefs.set` rejects the four new members as unknown parameters with `INVALID_ARGUMENT(invalid_params)`, and nothing is
  changed. The tool does not try to guess the version first.
- `prefs.get` reports no `processing.options`. `opentune_get_settings` then returns `options` as `null`, with the reason
  `not_reported` in `nullReasons` (or `capability_missing:read.v1` when the build cannot read at all), and the other
  members as before. A `null` there tells you that this build does not take the new members.
- The rest of the settings (tuning frequency, editing scheme, hybrid mode, experimental features, audio device, recent
  projects) works as before.
