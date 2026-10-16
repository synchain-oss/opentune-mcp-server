<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: MIT
-->

# Testing against a real OpenTune

Two checks run against a started OpenTune Standalone build instead of the mock. Neither runs in CI
of this repository, and neither runs unless `OTCP_TARGET_EXE` is set. Both start the executable
themselves, in a temporary `OPENTUNE_DATA_DIR`, and stop it afterwards; your preferences, logs and
real discovery files are never touched. With `OTCP_TARGET_DATA_DIR` the data folders are kept
instead, so the logs of the instance can be read afterwards (see below).

| Command                 | What it runs                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm run test:contract` | Every OTCP vector of `spec/otcp/v1/vectors` against the instance (details: `test/contract/README.md`). |
| `npm run e2e:exe`       | One end-to-end scenario: import, analysis, AUTO, export, with timings.                                 |

## Prerequisites

- An OpenTune Standalone build with the control API compiled in: it understands `--control-api` (or
  `OPENTUNE_CONTROL_API=1`), `--control-api-ready-file=` and `--control-api-launch-nonce=`, and
  honours `OPENTUNE_DATA_DIR`. A build without the control API never writes the ready file, and the
  run fails after its timeout.
- The models OpenTune needs for pitch analysis and rendering, installed where that build looks for
  them. A missing model fails the scenario (`MODEL_UNAVAILABLE`, reason `model_missing`).
- A machine that can run the build's inference backend. When the backend cannot be initialised
  (`MODEL_UNAVAILABLE`, reason `backend_unavailable`) the scenario is reported as `FLAKY-SKIP`.
- Node 22 or later and `npm ci` in this repository. No audio file is needed: the scenario generates
  its own input at run time and writes it to the system temporary directory.

## Environment variables

| Variable                    | Required | Meaning                                                                                         |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `OTCP_TARGET_EXE`           | yes      | Absolute path of the OpenTune executable. Without it both checks are skipped, with that reason. |
| `OTCP_TARGET_ARGS`          | no       | JSON array of strings, the arguments to start it with. Default `["--control-api"]`.             |
| `OTCP_TARGET_TIMEOUT_MS`    | no       | How long to wait for the ready file, the hello and the exit. Default 30000.                     |
| `OTCP_E2E_REPORT`           | no       | Absolute path of the JSON report written by `npm run e2e:exe` (folders are created).            |
| `OTCP_E2E_STEP_TIMEOUT_MS`  | no       | How long one wait (analysis, a job, a not-yet-ready content) may take. Default 180000.          |
| `OTCP_TARGET_DATA_DIR`      | no       | Absolute path of an existing folder; keeps the data folders of the launches (see below).        |
| `OTCP_TARGET_DATA_TEMPLATE` | no       | Absolute path of an existing folder whose contents are copied into every launch's data folder.  |

```bash
# PowerShell: $env:OTCP_TARGET_EXE = 'C:\path\to\OpenTune.exe'
OTCP_TARGET_EXE=/path/to/OpenTune OTCP_E2E_REPORT=/tmp/e2e-report.json npm run e2e:exe
OTCP_TARGET_EXE=/path/to/OpenTune npm run test:contract -- -t "against the exe"
```

## Keeping the logs: `OTCP_TARGET_DATA_DIR`

By default every launch gets a temporary data folder that is deleted at the end, and the instance's
logs go with it. When `OTCP_TARGET_DATA_DIR` names an existing folder (an absolute path; a relative
path or a missing folder is a configuration error and fails the run, it is not a skip), each launch
instead gets a new sub-folder of it, so launches stay isolated from each other:

- the contract run names it after the vector id (`import/start-path-not-absolute` becomes
  `import-start-path-not-absolute-<random>`), the smoke scenario starts it with `smoke-`;
- the sub-folder is kept after the instance ended, also when the launch failed. Logs and
  preferences stay; only the instance's discovery files (`control/instances`, which hold a
  token) are removed. The generated audio never lives there: it is in the system temporary
  directory and is deleted as before;
- the name, relative to `OTCP_TARGET_DATA_DIR` (never an absolute path), is in the results:
  `dataDir` in the smoke report and a line under the step table, the `Data folder` column of the
  contract table, and `dataDirs` (vector id to name) in the `OTCP_CONTRACT_SUMMARY_EXE` file.

A workflow can set it to a folder it uploads as an artifact:

```bash
mkdir -p "$RUNNER_TEMP/opentune-data"
OTCP_TARGET_EXE=/path/to/OpenTune OTCP_TARGET_DATA_DIR="$RUNNER_TEMP/opentune-data" npm run e2e:exe
# upload $RUNNER_TEMP/opentune-data as an artifact, also when the run failed
```

When a step gets `BUSY` with reason `modal_open`, its note says that the instance has a modal dialog
open (decided by the `BUSY` error the instance actually sent, not by text in the vector). In the
smoke scenario the report also gets `busyDiagnostics`: one extra read-only `ui.getState` call (only
if the instance reports `ui.bridge`) with its busy conditions, open dialogs (kind and title) and
first-run onboarding state. Dialog titles are untrusted: a path under a user folder in a title is
replaced by `<home>` and the title is cut short.

## Starting from a known state: `OTCP_TARGET_DATA_TEMPLATE`

Every launch starts with an empty data folder, which is a first start of the application, with
whatever a first start does (a first-run dialog that blocks writes, for instance). To start from a
known state instead, set `OTCP_TARGET_DATA_TEMPLATE` to an existing folder (an absolute path; a
relative path, a missing folder or a file is a configuration error and fails the run, it is not a
skip). Before each launch, in the contract run and in the smoke scenario alike, the contents of that
folder are copied as they are into the data folder of that launch, whether it is a temporary folder
or a sub-folder of `OTCP_TARGET_DATA_DIR`; then the process starts. Only regular files and
sub-folders are copied, symbolic links are not followed. Every launch gets its own copy, so what one
launch changes is not seen by the next. Without the variable nothing is copied.

Which files make up the state you want is up to the caller; this repository does not ship any.

## What the scenario does

1. **generate audio**: about 10 s of a synthetic sung-like signal (eight notes, 30 cents sharp), from the
   seeded generator in `test/support/harmonic-tone.ts`, written to a temporary directory.
2. **launch**: starts the executable and reads its discovery file (launch nonce and `session.hello` of the
   exe target checked, as in the contract run).
3. **hello**: opens an OTCP session with `session.hello` and checks the capabilities the scenario needs
   (`jobs.v1`, `read.v1`, `import.v1`, `edit.v1`, `export.v1`).
4. **import and analysis**: `import.start` (layout `single`), follows the job, then waits until
   `content.getDetails` reports `analysis.f0State` `ready`.
5. **AUTO (regenerate)**: `content.autoTune` with mode `regenerate`, in the content's own key (the
   chromatic scale if it has none), with the revision just read. A retryable `NOT_READY` is retried.
6. **export**: `export.start` of the master mix, followed to the end of its job.
7. **check exported file**: the file exists; its sample rate and channel count equal those in the job
   result; its duration is close to the source; it is not silent; it differs from the source;
   and `dryContents` is empty, so the audio was corrected and not exported dry.
8. **shutdown**: stops the instance (normal stop request where the platform has one) and removes its
   data folder (with `OTCP_TARGET_DATA_DIR`, only its discovery files); leftovers make the step fail.

A step that fails stops the scenario; the remaining steps are `SKIP` ("not run"), except the
shutdown, which always runs.

## Results

| Result       | Meaning                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASS`       | The step ran and its checks held.                                                                                                                                           |
| `FAIL`       | The step ran and something was wrong, or it hit an error that is a defect (including a missing model).                                                                      |
| `SKIP`       | Not run and nothing is wrong: the instance does not report a needed capability, or an earlier step failed.                                                                  |
| `FLAKY-SKIP` | Not run for a reason that belongs to the machine and that the specification allows: only an inference backend that cannot be initialised. A real failure is never put here. |

The run's result is `FAIL` if any step failed, else `FLAKY-SKIP` or `SKIP` if any step was skipped, else
`PASS`. A skipped run is reported as skipped by vitest and exits 0; only `FAIL` fails the command.

## Timings and the report

The step table (with the time of every step) is printed to stderr. With `OTCP_E2E_REPORT` the same data
is written as JSON:

```json
{
  "schema": "opentune-mcp-e2e-exe/1",
  "result": "PASS",
  "counts": { "PASS": 8, "FAIL": 0, "SKIP": 0, "FLAKY-SKIP": 0 },
  "startedAt": "2026-01-01T00:00:00.000Z",
  "totalMs": 41000,
  "steps": [{ "name": "launch", "result": "PASS", "ms": 2100, "note": "..." }],
  "instance": { "protocol": "1.0", "appVersion": "..." },
  "audio": { "sourceSeconds": 9.9, "exportSeconds": 9.9, "exportDryContents": 0 },
  "dataDir": null,
  "busyDiagnostics": null
}
```

The report holds no absolute paths and no token (`dataDir` is only a folder name). `ms` is wall-clock time per step: `launch` is the start of the
process until its discovery file and hello check, `import and analysis` runs until the pitch analysis is
ready, `AUTO (regenerate)` and `export` include waiting for their jobs and for retryable not-ready answers.
