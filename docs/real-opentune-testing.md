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

| Command                 | What it runs                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run test:contract` | Every OTCP vector of `spec/otcp/v1/vectors` against the instance (details: `test/contract/README.md`).                                                                                                             |
| `npm run e2e:exe`       | The end-to-end scenarios, one after the other, each with an instance of its own: the smoke scenario (import, analysis, AUTO, export, with timings), the [effects scenario] and the three boundary scenarios below. |

[effects scenario]: #effects-scenario

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

| Variable                      | Required | Meaning                                                                                                                          |
| ----------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `OTCP_TARGET_EXE`             | yes      | Absolute path of the OpenTune executable. Without it both checks are skipped, with that reason.                                  |
| `OTCP_TARGET_ARGS`            | no       | JSON array of strings, the arguments to start it with. Default `["--control-api"]`.                                              |
| `OTCP_TARGET_TIMEOUT_MS`      | no       | How long to wait for the ready file, the hello and the exit. Default 30000.                                                      |
| `OTCP_E2E_REPORT`             | no       | Absolute path of the JSON report of the smoke scenario (folders are created).                                                    |
| `OTCP_E2E_EFFECTS_REPORT`     | no       | Absolute path of the JSON report of the effects scenario; default `effects.json` next to `OTCP_E2E_REPORT`, none without either. |
| `OTCP_E2E_EFFECTS_AUDIO`      | no       | Absolute path of a `.wav` file the effects scenario uses instead of its generated audio (see below).                             |
| `OTCP_E2E_EFFECTS_TIMING_SEC` | no       | Lengths in seconds of the extra clips the effects scenario only times, comma-separated, or `none`. Default `60,240`.             |
| `OTCP_E2E_STEP_TIMEOUT_MS`    | no       | How long one wait (analysis, a job, a not-yet-ready content, a render to settle) may take. Default 180000.                       |
| `OTCP_TARGET_DATA_DIR`        | no       | Absolute path of an existing folder; keeps the data folders of the launches (see below).                                         |
| `OTCP_TARGET_DATA_TEMPLATE`   | no       | Absolute path of an existing folder whose contents are copied into every launch's data folder.                                   |

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

Two paths of the template are never copied, because the runner uses them itself and a stale copy
would be taken for the new instance's: the ready file at the top of the template (`ready.json`) and
the discovery folder `control/instances/` with everything in it (other files under `control/` are
copied). On Windows and macOS these names are matched without regard to case, as their file systems
do by default (`Ready.json`, `Control/Instances`). A launch that left something out is counted:
`templateSkipped` in the smoke and effects reports.

Which files make up the state you want is up to the caller; this repository does not ship any.

## What the smoke scenario does

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

## Boundary scenarios

`npm run e2e:exe` also runs three scenarios for what the happy path never feeds OpenTune. Each has a table
of its own on stderr and, with `OTCP_E2E_REPORT`, a report file `<scenario>.json` in the folder of that
variable (the smoke report stays at the path given). The reports have the members of the smoke report
(`schema`, `result`, `counts`, `startedAt`, `totalMs`, `steps[]` with `name`, `result`, `ms`, `note`) plus
`scenario`, `facts` (what was observed, for example the analysis limit the instance reported) and
`manualChecks` (what only a person can check on this machine, each with the reason). Results mean the same as
for the smoke scenario; a `SKIP` here is a missing capability or a machine that is not free for the scenario, and
the note says which. They run one after the other, and the two that go through the MCP bundle use the file built
by the project's global setup (`dist/opentune-mcp.mjs`).

| Scenario (report)  | What it checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boundary.json`    | One instance, started like the smoke scenario. Audio in a folder and under a file name with Chinese characters and spaces is imported (`project.get` names the same source file) and a master export to such a folder is written and read back. A silent file is imported, its clip stays in the project, the analysis outcome is recorded (`ANALYSIS_FAILED` or an analysis that ends without voiced audio) and a master export lists it in `dryContents`. A 601 s, 8 kHz, 8 bit file (about 4.8 MB, generated) is refused with `INVALID_ARGUMENT(audio_too_long)` and the limit of `session.info` in the detail, and nothing is imported. An edit followed by `edit.undo` and `edit.redo` leaves the read-back state as before the edit and as after it (skipped when the instance reports no `edit.v1` or `history.v1`). Relative, UNC, alternate-data-stream and `.docx` export paths are refused with `INVALID_ARGUMENT` and no file appears in the target folder. |
| `instances.json`   | Two instances that announce themselves in one discovery folder, driven through the MCP bundle: without `instance_id` a read and a write give `MULTIPLE_INSTANCES` and change neither instance; with it the write works on that instance only; after one instance is ended (only one this scenario started) the next scan removes its discovery file and the other instance keeps working.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `launch-real.json` | `opentune_launch` and `opentune_get_status` through the MCP bundle: an executable without a control manifest (the official installation when found, read-only, else a copy of the test build without its manifest) gives `NO_API_BUILD` and starts no process; two launches at once and one after them give one process and `alreadyRunning`; after the MCP process is killed, OpenTune, its discovery file and the unsaved clip are still there and a new MCP process reports the same `instanceId` as `READY`. The case of an OpenTune running without the control API needs the official GUI and is listed in `manualChecks`.                                                                                                                                                                                                                                                                                                                                        |

Things to know before running them:

- They use the same variables as the smoke scenario (`OTCP_TARGET_EXE`, `OTCP_TARGET_TIMEOUT_MS`,
  `OTCP_TARGET_DATA_TEMPLATE`, `OTCP_E2E_STEP_TIMEOUT_MS`, `OTCP_E2E_REPORT`). `instances` and `launch-real`
  take their data and discovery folders from a scratch folder of their own below the system temporary directory
  (`ot-e2e-*`), which is removed at the end, also after a failure; `OTCP_TARGET_DATA_DIR` applies to `boundary` only.
- The MCP bundle is started with an environment that holds only the variables the scenario sets: variables
  `OPENTUNE_MCP_*` and `OPENTUNE_DATA_DIR` of the calling shell never reach it, so no scenario can resolve the
  discovery folder of a real OpenTune.
- Only a process the scenario started is ended: an instance it spawned itself, or the one `opentune_launch`
  started, after its discovery file in the scenario's folder and its start time show it to be that process.
  `launch-real` stops (`SKIP`, with the reason in the note) before it launches anything when an `OpenTune.exe`
  that it did not start is running; it never ends that one.
- Nothing is installed or uninstalled, and the registry is only read (the official installation is looked up with
  the same read-only query as `opentune-mcp doctor`).
- A machine that runs several of these checks should take turns: run them one at a time.

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
  "busyDiagnostics": null,
  "templateSkipped": 0
}
```

The report holds no absolute paths and no token (`dataDir` is only a folder name). `ms` is wall-clock time per step: `launch` is the start of the
process until its discovery file and hello check, `import and analysis` runs until the pitch analysis is
ready, `AUTO (regenerate)` and `export` include waiting for their jobs and for retryable not-ready answers.

## Effects scenario

The effects scenario (`test/e2e/effects.ts`) checks that what a write reports is what the instance
then holds, and that what a write says it changed is what changed in the exported audio, and nothing
else. It does not judge how good a correction sounds. It starts its own instance, exactly as the smoke
scenario does (same variables, same data folders; its data folder starts with `effects-`).

### What it checks

Each check exports the clip (`export.start` of kind `clip`) and compares the file with a baseline
export of the same clip, analysed with the same F0 estimator (`test/support/f0-estimator.ts`, YIN in
TypeScript). For every note only the frames voiced in both files count, and max(80 ms, 20 % of the
note) is left out at both ends; the median of the per-frame differences is the measured change. After
every write the scenario reads the clip back: each `after` value in `changes` must equal the value
read, and the tokens of the result must equal those of the fresh read. Each check then takes its
write back with `edit.undo` and verifies that the notes, the pitch shift and the time-grid handles
read back equal the snapshot taken before the write.

| Step                                    | What must hold                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare audio`                         | Generated audio: five notes of 1.2 s with 0.4 s of silence between them, the third one 40 cents sharp.                                                                                                                                                                                                                                                                       |
| `import and analysis`                   | `import.start` with `generateNotes`, then `analysis.f0State` `ready`; OpenTune finds as many voiced notes as were generated.                                                                                                                                                                                                                                                 |
| `export before any edit`                | Nothing is corrected yet: the export succeeds, either corrected or listing the clip in `dryContents` (PROTOCOL.md section 19 rule 6), at the pitch of the source.                                                                                                                                                                                                            |
| `fixed note parameters`                 | `setParams` on every note (`retuneSpeed` 0.5, `vibratoDepth` 0, `pitchDriftScale` 1), so that no check depends on the defaults of the note generator; the render settles.                                                                                                                                                                                                    |
| `baseline and noise floor`              | The baseline, exported twice: how far two exports of the unchanged clip differ (the noise floor).                                                                                                                                                                                                                                                                            |
| `setTargetPitch +100 cents`             | One note gets its target + 1 semitone: that note +100 cents, the other notes bit-identical to the baseline.                                                                                                                                                                                                                                                                  |
| `shiftCents +100 cents`                 | Another note `shiftCents` +100: the same.                                                                                                                                                                                                                                                                                                                                    |
| `setPitchShift +2 semitones`            | Every note +200 cents.                                                                                                                                                                                                                                                                                                                                                       |
| `AUTO <mode> pulls the sharp note back` | `content.autoTune` in mode `regenerate` and, as a step of its own, in mode `snapNotes`, chromatic: the sharp note -40 cents, the other notes unchanged.                                                                                                                                                                                                                      |
| `setParams retuneSpeed 1`               | `retuneSpeed` 1 flattens the notes to their targets. These notes are flat and the baseline holds them at their targets already, so no note may move.                                                                                                                                                                                                                         |
| `race: +100 cents, export, -100 cents`  | Two notes +100 cents, `export.start`, at once -200 cents. The file is one whole version (both notes +100, or both -100), or the job fails with `REVISION_CONFLICT(changed_during_export)` and the target is not written; never a mix, a silent or a dry file. A second write refused with `BUSY(export_in_progress)` is allowed, and the file must then be the +100 version. |
| `shiftTiming +30 ms`                    | Seeds the time grid (which must not change the sound) and moves the handle at a note start by +30 ms: the audio at the handle plays 30 ms later (cross-correlation of the amplitude envelopes, `test/support/time-shift.ts`), and the notes away from the moved handle stay where they were.                                                                                 |
| `timing <n> s`                          | Times only: a generated clip of n seconds on a track of its own; import to F0 ready, AUTO (the mode the AUTO button runs) to a settled render, export.                                                                                                                                                                                                                       |

No export of a check may be silent or list the clip in `dryContents`. A failed set-up step stops the
scenario; a failed check does not stop the checks after it, since each check has put the clip back as
it was. Only a check that could not put the clip back stops the rest. The results are those of the
smoke scenario (`PASS`, `FAIL`, `SKIP`, `FLAKY-SKIP`). The scenario also needs `history.v1` (for
`edit.undo`); `shiftTiming +30 ms` is skipped without `timing.v1`. An export before any edit can wait
up to the 120 s export limit, so a run takes a few minutes.

### Tolerances

The tolerances are fixed in `test/e2e/effects.ts`, each with the measurements it rests on:

- Pitch: 15 cents around the expected change. Two exports of the unchanged clip were bit-identical,
  the estimator stays within 2 cents of known tones (`test/unit/f0-estimator.test.ts`), and the
  renderer put the measured changes up to 5.1 cents off. 15 cents still tells the 40 cents of AUTO
  and the 100 cents of an edit apart from no change.
- Time: 5 ms around the expected shift (measured: 29.2 ms for 30 ms). The estimator is within 2 ms
  (`test/unit/time-shift.test.ts`).
- Notes that were not edited: bit-identical after note and pitch edits (measured so). After a
  time-grid move, which renders the whole clip again, at most 1e-3 (-60 dBFS) from the baseline
  (measured: up to 1.1e-4, -79 dBFS).

### External audio: `OTCP_E2E_EFFECTS_AUDIO`

With `OTCP_E2E_EFFECTS_AUDIO` (an absolute path of an existing `.wav` file; anything else is a
configuration error) the scenario imports that file instead of the generated audio. The notes it
edits are then chosen from the notes OpenTune finds (the two longest voiced notes of at least 0.4 s;
shorter notes are not measured), and the checks that need to know the pitch in advance are skipped:
the AUTO checks and the comparison of the estimator with the known pitch. The report says the audio
is `external`, with its length and sample rate only, never its name or path. The file is only read.

### The report

The step table goes to stderr. The JSON report (`OTCP_E2E_EFFECTS_REPORT`, else `effects.json` next to
`OTCP_E2E_REPORT`) has the members of the smoke report, with `schema` `opentune-mcp-e2e-effects/1`,
and these:

| Member       | Holds                                                                                                                                                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend`    | The inference backend `session.info` reports, and every `processing.backend` the exports reported (they can differ: an analysis session can fall back to the CPU).                                                                                             |
| `audio`      | `source` (`generated` or `external`), length and sample rate.                                                                                                                                                                                                  |
| `tolerances` | The tolerances above and the error bounds of the two estimators.                                                                                                                                                                                               |
| `noiseFloor` | `repeatExport` (two exports of the unchanged clip: bit-identical or not, the change per note), and for generated audio `estimatorOnSource` and `renderedAgainstSource` (cents from the known pitch).                                                           |
| `checks`     | Per step: the expected and the measured median change and the frame count of every note, the sample comparison of the notes that were not edited (`bitIdentical`, `maxAbsDiff`, `maxAbsDiffDbfs`), the measured shift, the race outcome, consistency problems. |
| `timings`    | `launchToReadyMs`, `importToF0ReadyMs`, `fixedParamsToSettleMs`, `autoToSettleMs` per AUTO mode, the time of every export, and per timing clip `importToF0ReadyMs`, `autoToSettleMs` and `exportMs`.                                                           |

Like the smoke report it holds no absolute path and no token. Timeouts for clients are not derived
here; the timings are recorded for that.
