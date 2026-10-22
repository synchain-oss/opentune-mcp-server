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
| OTCP specification             | `1.0.0-rc.4` (wire version `1.0`, protocol major 1)                                             | The specification in `spec/otcp/v1/` of this repository. The test build and this server must both support protocol major 1; otherwise the status is `PROTOCOL_MISMATCH`.                                                                                                                                       |
| Node.js                        | 22 or later                                                                                     | Not needed for the MCPB package.                                                                                                                                                                                                                                                                               |
| Operating system               | Windows x64                                                                                     | macOS: not yet. Linux: not supported. WSL: run the server with Windows Node.js.                                                                                                                                                                                                                                |

The unofficial OpenTune test build that matches this server's 0.1.0 release is tagged `synchain-test/v1.8.0-ctl.1`.

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
`capability_missing:<capability>`, and `opentune_set_settings` asks only for the capabilities of the groups you give
it. A test build older than this server may therefore offer fewer tools than [reference.md](reference.md) lists.

| Capability       | Tools that need it                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session.v1`     | `opentune_get_status`, `opentune_launch`, `opentune_get_settings`                                                                                                                                      |
| `read.v1`        | `opentune_get_project`, `opentune_get_notes`, `opentune_get_clip_details`, `opentune_get_settings`, `opentune_analyze_pitch`, `opentune_estimate_key`, and the write tools that read before they write |
| `jobs.v1`        | `opentune_get_job`, `opentune_cancel_job`, and every tool that waits for a job: open, export, timing seed, save, open project and settings                                                             |
| `import.v1`      | `opentune_open_audio`                                                                                                                                                                                  |
| `export.v1`      | `opentune_export_audio`                                                                                                                                                                                |
| `edit.v1`        | `opentune_set_clip`, `opentune_autotune_range`, `opentune_edit_notes`                                                                                                                                  |
| `history.v1`     | `opentune_undo`, `opentune_redo`                                                                                                                                                                       |
| `timing.v1`      | `opentune_edit_timing`                                                                                                                                                                                 |
| `reference.v1`   | `opentune_autotune_range`, only in mode `reference`                                                                                                                                                    |
| `arrangement.v1` | `opentune_edit_arrangement`                                                                                                                                                                            |
| `tracks.v1`      | `opentune_set_tracks`, `opentune_delete_track`                                                                                                                                                         |
| `transport.v1`   | `opentune_transport`                                                                                                                                                                                   |
| `ui.bridge`      | `opentune_manage_ui`                                                                                                                                                                                   |
| `project.io`     | `opentune_save_project`, `opentune_save_project_overwrite`, `opentune_open_project`, and the `clear_recent` part of `opentune_set_settings`                                                            |
| `prefs.write`    | `opentune_set_settings` (the `processing` part)                                                                                                                                                        |
| `audio.device`   | `opentune_get_settings` (the `audio_device` section), `opentune_set_settings` (the `audio_device` part)                                                                                                |
