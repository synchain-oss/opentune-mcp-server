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
| OTCP specification             | `1.0.0-rc.3` (wire version `1.0`, protocol major 1)                                             | The specification in `spec/otcp/v1/` of this repository. The test build and this server must both support protocol major 1; otherwise the status is `PROTOCOL_MISMATCH`.                                                                                                                                       |
| Node.js                        | 22 or later                                                                                     | Not needed for the MCPB package.                                                                                                                                                                                                                                                                               |
| Operating system               | Windows x64                                                                                     | macOS: not yet. Linux: not supported. WSL: run the server with Windows Node.js.                                                                                                                                                                                                                                |

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
