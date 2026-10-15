<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: MIT
-->

# Contract vectors

`vectors.test.ts` runs every vector of `spec/otcp/v1/vectors` against a target. There are two:

- the **mock** (`mock/`), always;
- a **started OpenTune** (the exe target), only when you point it at a build.

## Running the vectors against a local OpenTune build

You need an OpenTune Standalone build with the control API compiled in: one that understands
`--control-api` (or `OPENTUNE_CONTROL_API=1`), `--control-api-ready-file=` and
`--control-api-launch-nonce=`, and honours `OPENTUNE_DATA_DIR`. A build without the control API
never writes the ready file, and the target reports that after its timeout.

| Variable                  | Meaning                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `OTCP_TARGET_EXE`         | Required. Absolute path of the executable; it must be an existing regular file.          |
| `OTCP_TARGET_ARGS`        | Optional. JSON array of strings, the arguments to start it with. Default `["--control-api"]`. |
| `OTCP_TARGET_TIMEOUT_MS`  | Optional. How long to wait for the ready file, the hello and the exit. Default 30000.    |

```bash
OTCP_TARGET_EXE=/path/to/OpenTune npm run test:contract -- -t "against the exe"
# or, with the other checks
OTCP_TARGET_EXE=/path/to/OpenTune npm run gates -- --only "contract vectors (exe)"
```

Without `OTCP_TARGET_EXE` the exe target is skipped as a whole, with that reason; it never reports
PASS. CI does not set it.

For every vector the target starts a fresh process with a new temporary `OPENTUNE_DATA_DIR`
(plus `OPENTUNE_CONTROL_API=1`, `--control-api-ready-file=` and a random
`--control-api-launch-nonce=`), waits for the ready file, reads the discovery file for that pid
from `<data dir>/control/instances`, checks the launch nonce, and learns the capabilities from a
`session.hello` of its own. Your preferences, logs and real discovery files are never read or
written, and a data folder inside a real OpenTune installation is refused. Only vectors whose
capabilities the instance reports run; the rest are skipped with that reason, as are vectors with
preconditions (`given`), which this target cannot establish yet.

Afterwards the process is asked to stop normally and the discovery file is checked to be gone.
Windows has no normal stop request to send, so there the target ends the process it started and
records that the clean-up on exit was not verified. It never ends any other process. On a failed
start the error carries the tail of the process's stderr with token, server proof and nonce
removed.

`OTCP_CONTRACT_SUMMARY_EXE` (a file path) makes the run write its counts as JSON, which is how
`npm run gates` fills its "contract vectors (exe)" row.
