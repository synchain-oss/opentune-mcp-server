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

| Command                 | What it runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run test:contract` | Every OTCP vector of `spec/otcp/v1/vectors` against the instance (details: `test/contract/README.md`, which also says which preconditions the target builds on a real instance and how `scripts/vector-coverage.mjs` merges the result files of several runners).                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `npm run e2e:exe`       | The end-to-end scenarios, one after the other, each with an instance of its own: the smoke scenario (import, analysis, AUTO, export, with timings), the [effects scenario], the [arrangement effects scenario], the [wave-B tour], the [wave-B boundary scenario] and the three boundary scenarios below. The wave-B tour fails while the build under test has a defect it found, for example an out-of-range clip gain that is not limited and gives no `CLAMPED` warning; a red `e2e:exe` in which only the tour fails for such a reason is not a regression of this server. How to read the outcome of a whole run, and which defect of OpenTune itself is counted as known, is in [Judging a run]. |

[effects scenario]: #effects-scenario
[arrangement effects scenario]: #arrangement-effects-scenario
[wave-B tour]: #wave-b-tour
[wave-B boundary scenario]: #wave-b-boundary-scenario
[Judging a run]: #judging-a-run

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

| Variable                                     | Required | Meaning                                                                                                                                                  |
| -------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTCP_TARGET_EXE`                            | yes      | Absolute path of the OpenTune executable. Without it both checks are skipped, with that reason.                                                          |
| `OTCP_TARGET_ARGS`                           | no       | JSON array of strings, the arguments to start it with. Default `["--control-api"]`.                                                                      |
| `OTCP_TARGET_TIMEOUT_MS`                     | no       | How long to wait for the ready file, the hello and the exit. Default 30000.                                                                              |
| `OTCP_E2E_REPORT`                            | no       | Absolute path of the JSON report of the smoke scenario (folders are created).                                                                            |
| `OTCP_E2E_EFFECTS_REPORT`                    | no       | Absolute path of the JSON report of the effects scenario; default `effects.json` next to `OTCP_E2E_REPORT`, none without either.                         |
| `OTCP_E2E_EFFECTS_AUDIO`                     | no       | Absolute path of a `.wav` file the effects scenario uses instead of its generated audio (see below).                                                     |
| `OTCP_E2E_EFFECTS_TIMING_SEC`                | no       | Lengths in seconds of the extra clips the effects scenario only times, comma-separated, or `none`. Default `60,240`.                                     |
| `OTCP_E2E_EFFECTS_DATA_TEMPLATE`             | no       | Absolute path of an existing folder: the data template of the effects scenario's instance, in place of `OTCP_TARGET_DATA_TEMPLATE` (see below).          |
| `OTCP_E2E_ARRANGEMENT_EFFECTS_REPORT`        | no       | Absolute path of the JSON report of the arrangement effects scenario; default `arrangement-effects.json` next to `OTCP_E2E_REPORT`, none without either. |
| `OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE` | no       | Absolute path of an existing folder: the data template of the arrangement effects scenario's instance, in place of `OTCP_TARGET_DATA_TEMPLATE`.          |
| `OTCP_E2E_STEP_TIMEOUT_MS`                   | no       | How long one wait (analysis, a job, a not-yet-ready content, a render to settle) may take. Default 180000.                                               |
| `OTCP_TARGET_DATA_DIR`                       | no       | Absolute path of an existing folder; keeps the data folders of the launches (see below).                                                                 |
| `OTCP_TARGET_DATA_TEMPLATE`                  | no       | Absolute path of an existing folder whose contents are copied into every launch's data folder.                                                           |

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

| Scenario (report)  | What it checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `boundary.json`    | One instance, started like the smoke scenario. Audio in a folder and under a file name with Chinese characters and spaces is imported (`project.get` names the same source file) and a master export to such a folder is written and read back. A silent file is imported, its clip stays in the project, the analysis outcome is recorded (`ANALYSIS_FAILED` or an analysis that ends without voiced audio) and a master export lists it in `dryContents`. A 601 s, 8 kHz, 8 bit file (about 4.8 MB, generated) is refused as too long: the step first requires `import.maxAnalysisSec` of `session.info` to be positive and smaller than the generated duration, then expects `INVALID_ARGUMENT(audio_too_long)` (as the failed item of the import job or as the error of the call) and that no clip was imported. An edit followed by `edit.undo` and `edit.redo` leaves the read-back state as before the edit and as after it (skipped when the instance reports no `edit.v1` or `history.v1`). Relative, UNC, alternate-data-stream and `.docx` export paths are refused with `INVALID_ARGUMENT` and no file appears in the target folder. |
| `instances.json`   | Two instances that announce themselves in one discovery folder, driven through the MCP bundle: without `instance_id` a read and a write give `MULTIPLE_INSTANCES` and change neither instance; with it the write works on that instance only; after one instance is ended (only one this scenario started) the next scan removes its discovery file and the other instance keeps working.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `launch-real.json` | `opentune_launch` and `opentune_get_status` through the MCP bundle: an executable without a control manifest (the official installation when found, read-only, else a copy of the test build without its manifest) gives `NO_API_BUILD` and starts no process; two launches at once and one after them give one process and `alreadyRunning`; after the MCP process is killed, OpenTune, its discovery file and the unsaved clip are still there and a new MCP process reports the same `instanceId` as `READY`. The case of an OpenTune running without the control API needs the official GUI and is listed in `manualChecks`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

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
scenario does (same variables, same data folders; its data folder starts with `effects-`), except
that `OTCP_E2E_EFFECTS_DATA_TEMPLATE`, when set, is its data template instead of
`OTCP_TARGET_DATA_TEMPLATE`.

### Run it with hybrid mode off: `OTCP_E2E_EFFECTS_DATA_TEMPLATE`

In hybrid mode (on by default in OpenTune) a correction that is small (in the measured build, below
about 75 cents) is not rendered by the vocoder but on a lighter path, which leaves such a correction
largely unapplied on real voices, in the user interface just as through the control API. That is
OpenTune's own behaviour, not a defect of the API, but it makes the checks of small corrections
(AUTO pulling a 40 cents sharp note back, `retuneSpeed` 1) fail. Run the effects scenario on an
instance with hybrid mode off: give `OTCP_E2E_EFFECTS_DATA_TEMPLATE` a data template that starts
OpenTune that way. The variable means the same as `OTCP_TARGET_DATA_TEMPLATE` (an absolute path of
an existing folder, copied into the data folder before the launch; anything else is a configuration
error, not a skip), but only the effects scenario uses it, so the smoke, boundary and contract runs
keep their own state. Which files make up that state is not this repository's business: the fork's
end-to-end workflow provides the template, and this repository ships none. `dataTemplateFrom` in the
report says which variable the template came from.

The scenario does not change the preference itself. Every export reports its `processing`
(`hybridMode` and `backend`); the report keeps them per check, and `hybridMode` at its top is `true`
when `session.info` or any export reported hybrid mode on. Then the first entry of `notices` (also
printed above the step table) says that checks of small corrections can fail because of OpenTune's
lighter path. The checks are judged as usual either way: a failure stays a `FAIL`.

### What it checks

Each check exports the clip (`export.start` of kind `clip`) and compares the file with a baseline
export of the same clip, analysed with the same F0 estimator (`test/support/f0-estimator.ts`, YIN in
TypeScript). For every note only the frames voiced in both files count, and max(80 ms, 20 % of the
note) is left out at both ends; the median of the per-frame differences is the measured change. After
every write the scenario reads the clip back: each `after` value in `changes` must equal the value
read, and the tokens of the result must equal those of the fresh read. Only the fields the scenario
reads back are compared (the note fields it parses, the pitch shift, a time-grid handle's
`contentSec` and `outputSec`, the clip's tokens); any other field is listed in `unreadFields` of the
check and counted in the step note, not treated as a problem, since fields are only ever added to the
specification. Each check then takes its write back with `edit.undo` and verifies that the notes, the
pitch shift and the time-grid handles read back equal the snapshot taken before the write.

| Step                                    | What must hold                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare audio`                         | Generated audio: five notes of 1.2 s with 0.4 s of silence between them, the third one 40 cents sharp.                                                                                                                                                                                                                                                                       |
| `import and analysis`                   | `import.start` with `generateNotes`, then `analysis.f0State` `ready`; OpenTune finds as many voiced notes as were generated.                                                                                                                                                                                                                                                 |
| `export before any edit`                | Nothing is corrected yet: the export succeeds, either corrected or listing the clip in `dryContents` (PROTOCOL.md section 19 rule 6), at the pitch of the source.                                                                                                                                                                                                            |
| `fixed note parameters`                 | `setParams` on every note (`retuneSpeed` 0.5, `vibratoDepth` 0, `pitchDriftScale` 1), so that no check depends on the defaults of the note generator; the render settles.                                                                                                                                                                                                    |
| `baseline and noise floor`              | The baseline, exported twice: how far two exports of the unchanged clip differ (the noise floor).                                                                                                                                                                                                                                                                            |
| `setTargetPitch +100 cents`             | One note gets its target + 1 semitone: that note +100 cents, the other notes unchanged (see the tolerances).                                                                                                                                                                                                                                                                 |
| `shiftCents +100 cents`                 | Another note `shiftCents` +100: the same.                                                                                                                                                                                                                                                                                                                                    |
| `setPitchShift +2 semitones`            | Every note +200 cents.                                                                                                                                                                                                                                                                                                                                                       |
| `AUTO <mode> pulls the sharp note back` | `content.autoTune` in mode `regenerate` and, as a step of its own, in mode `snapNotes`, chromatic: the sharp note -40 cents, the other notes unchanged.                                                                                                                                                                                                                      |
| `setParams retuneSpeed 1`               | `retuneSpeed` 1 flattens the notes to their targets. These notes are flat and the baseline holds them at their targets already, so no note may move.                                                                                                                                                                                                                         |
| `race: +100 cents, export, -100 cents`  | Two notes +100 cents, `export.start`, at once -200 cents. The file is one whole version (both notes +100, or both -100), or the job fails with `REVISION_CONFLICT(changed_during_export)` and the target is not written; never a mix, a silent or a dry file. A second write refused with `BUSY(export_in_progress)` is allowed, and the file must then be the +100 version. |
| `shiftTiming +30 ms`                    | Seeds the time grid (which must not change the sound) and moves the handle at a note start by +30 ms: the audio at the handle plays 30 ms later (cross-correlation of the amplitude envelopes, `test/support/time-shift.ts`), and the notes away from the moved handle stay where they were.                                                                                 |
| `timing <n> s`                          | Times only: a generated clip of n seconds on a track of its own; import to F0 ready, AUTO (the mode the AUTO button runs) to a settled render, export.                                                                                                                                                                                                                       |

No export of a check may be silent or list the clip in `dryContents`. In the race, a second write
that is applied is checked against the clip read back once the export job has ended, like every
other write. A failed set-up step stops the scenario; a failed check does not stop the checks after
it, since each check has put the clip back as it was, also when it failed half-way: the `undoId` of a
write that took effect is recorded before anything else is read from its result, and the clip is
compared with the snapshot whether or not there was anything to take back. Only a check that could
not put the clip back stops the rest, and so does a write that took effect without a usable `undoId`
in its result, since nothing could take it back. The results are those of the
smoke scenario (`PASS`, `FAIL`, `SKIP`, `FLAKY-SKIP`). The scenario also needs `history.v1` (for
`edit.undo`); `shiftTiming +30 ms` is skipped without `timing.v1`. An export before any edit can wait
up to the 120 s export limit, so a run takes a few minutes.

### Tolerances

The tolerances are fixed in `test/e2e/effects.ts`, each with the measurements it rests on:

- Pitch: 15 cents around the expected change. Two exports of the unchanged clip were bit-identical,
  the estimator stays within 2 cents of known tones (`test/unit/f0-estimator.test.ts`), and the
  renderer put the measured changes up to 5.1 cents off with hybrid mode on and up to 1.1 cents off
  with it off (AUTO took -41.1 cents off the 40 cents sharp note). 15 cents still tells the 40 cents
  of AUTO and the 100 cents of an edit apart from no change.
- Time: 5 ms around the expected shift (measured: 28.8 to 29.2 ms for 30 ms). The estimator is within 2 ms
  (`test/unit/time-shift.test.ts`).
- Notes that were not edited, after a note or pitch edit: by zone, as measured with hybrid mode off
  (where the vocoder renders every corrected note). An edit makes OpenTune synthesise a stretch again,
  from shortly before the edited note (69 to 78 ms before it where the note before runs into it,
  inside the silence where there is one) to the end of its render block, and the next block too when
  that one begins within about 0.16 s after the edited note ends (blocks are split in silences; every
  gap of 0.355 s and more was a split). A note in that stretch is synthesised again as a whole:
  same pitch (0 cents) and level (0.0 dB), another phase, so its samples differ by about its own size.
  Nothing outside the stretch changed by a single sample, and taking the edit back gave a
  bit-identical export again. Hence:
  - the last 100 ms before an edited note are not compared;
  - the notes after an edited note, up to and including the first note after a gap of at least
    0.3 s (the rest of its phrase and the first note of the next one), are within the reach of the
    re-synthesis: bit-identical, or the same sound in another phase. Over the inside of the note
    (trimmed as for the pitch), the energy left after aligning each 100 ms window by at most one
    period must be at least 20 dB below the note (measured: -25.1 to -40.3 dB on re-synthesised
    notes, against +2.2 to +3.0 dB on a note moved by 100 cents and -0.3 dB on one moved by 10
    cents); their pitch is measured like every note's;
  - every other note must be bit-identical. A change there fails the check, also when it is only a
    change of phase.

  The report lists the notes of each zone (`unedited.away`, `unedited.reach`). In the scenario's
  audio (gaps of 0.355 s) the reach is the one note after the edited note; it was synthesised again
  after the `shiftCents` edit (-28.3 dB) and not after the `setTargetPitch` edit.

  The same comparison is also made over the two ends of such a note alone (max(80 ms, 20 %) at each
  end, the stretches the inside check leaves out), against a wider limit of -12 dB: attack and
  release are short and hold the onset, so a phase offset smears them more (measured: -28.1 dB at
  the ends against -28.3 dB for the inside of the same note, on the one re-synthesised note the
  generated audio gives; the limit is 16 dB above that and is to be tightened or loosened by a run
  on voices). A lost or changed attack or release fails here while the inside still passes. With
  external audio this edge residual is only written to the report (`edgeResidualDb`) and does not
  fail the check: the two real voices measured so far reach -16.4 dB at worst, only 4.4 dB below
  the -12 dB limit, so the limit needs more voices before it is calibrated for them. The generated
  harmonic tones are still checked against -12 dB.

- After a time-grid move, which renders the whole clip again, the notes away from the moved handle
  at most 1e-3 (-60 dBFS) from the baseline (measured: up to 1.1e-4, -79 dBFS) with the generated
  audio. With external audio the same notes were re-synthesised in another phase (differences of up to
  0.26 of full scale, same pitch), so there each is either bit-identical or the same sound in another
  phase, by the two residual limits above, and its pitch must lie within the 15 cents of the pitch
  tolerance of the baseline.
- A value that `changes` reports (`targetMidi`, `offsetCents`) is compared with the intended one to the
  precision of the field, not exactly: 1e-3 semitones (0.1 cent) for `targetMidi` and 0.1 cent for
  `offsetCents`. OpenTune reported an intended 64.9746 as 64.9745; the difference of 0.01 cent is
  far below anything the audio checks resolve. The comparison with the state read back stays exact.

### External audio: `OTCP_E2E_EFFECTS_AUDIO`

With `OTCP_E2E_EFFECTS_AUDIO` (an absolute path of an existing `.wav` file; anything else is a
configuration error) the scenario imports that file instead of the generated audio. The notes it
edits are then chosen from the notes OpenTune finds (the two longest voiced notes of at least 0.4 s;
shorter notes are not measured), and the checks that need to know the pitch in advance are skipped:
the AUTO checks and the comparison of the estimator with the known pitch. The report says the audio
is `external`, with its length and sample rate only, never its name or path. The file is only read.

Real voices carry vibrato and glides, where the estimator and OpenTune's detected pitch differ by
more than 15 cents. For external audio `export before any edit` therefore holds only the notes with a
steady pitch to the detected pitch: those whose voiced frames have a standard deviation of at most
20 cents around their median (the generated tones measure 0 to 2 cents; a steady sung note wobbles by
roughly 10 to 15 cents, vibrato of +-50 cents is near 35). Up to 5 % of the steady notes (rounded
down) may still lie beyond 15 cents, since a wrong export would be wrong for most notes and not for a
few; the check is skipped when fewer than three notes are steady. The report lists the notes left out
and why (`unsteadyPitch`, `tooFewVoicedFrames`) under the check. Steadiness is measured on the source audio, because the export gives only each
note's median pitch; so `unsteadyPitch` describes a property of the source audio. For the generated
audio the limit is unchanged: every note.

### The report

The step table goes to stderr. The JSON report (`OTCP_E2E_EFFECTS_REPORT`, else `effects.json` next to
`OTCP_E2E_REPORT`) has the members of the smoke report, with `schema` `opentune-mcp-e2e-effects/1`,
and these:

| Member             | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notices`          | What to know before reading the results; with hybrid mode on, the note that checks of small corrections can fail for OpenTune's own reason. Empty otherwise.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `hybridMode`       | `true` when `session.info` or any export reported hybrid mode on, `false` when all reported it off, `null` when none reported it.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `dataTemplateFrom` | `OTCP_E2E_EFFECTS_DATA_TEMPLATE`, `OTCP_TARGET_DATA_TEMPLATE` or `null`: where the instance's data template came from.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `backend`          | The inference backend `session.info` reports, and every `processing.backend` the exports reported (they can differ: an analysis session can fall back to the CPU).                                                                                                                                                                                                                                                                                                                                                                                            |
| `audio`            | `source` (`generated` or `external`), length and sample rate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `tolerances`       | The tolerances above and the error bounds of the two estimators.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `noiseFloor`       | `repeatExport` (two exports of the unchanged clip: bit-identical or not, the change per note), and for generated audio `estimatorOnSource` and `renderedAgainstSource` (cents from the known pitch).                                                                                                                                                                                                                                                                                                                                                          |
| `checks`           | Per step: the expected and the measured median change and the frame count of every note, the notes that were not edited by zone (`unedited.away`: their indices and the sample comparison, `bitIdentical`, `maxAbsDiff`, `maxAbsDiffDbfs`; `unedited.reach`: per note `bitIdentical` and `alignedResidualDb`), the measured shift, the race outcome, consistency problems, `unreadFields` (`entity.field`) when a result reported fields the scenario does not read back, and `processing` (`export`, `hybridMode`, `backend` of every export the step made). |
| `timings`          | `launchToReadyMs`, `importToF0ReadyMs`, `fixedParamsToSettleMs`, `autoToSettleMs` per AUTO mode, the time of every export, and per timing clip `importToF0ReadyMs`, `autoToSettleMs` and `exportMs`.                                                                                                                                                                                                                                                                                                                                                          |

Like the smoke report it holds no absolute path and no token. Timeouts for clients are not derived
here; the timings are recorded for that.

## Arrangement effects scenario

The arrangement effects scenario (`test/e2e/arrangement-effects.ts`) checks that an arrangement or
track write changes the exported master mix exactly as its result says, and nothing else. It does
not judge how the audio sounds. It starts its own instance like the smoke and effects scenarios, uses
generated audio only, and exports the master mix only. It is meant for a real OpenTune build; the
checks are proved by unit tests against a stand-in (`test/support/fake-arrangement.mjs`), so a run
needs no prepared project.

### Set-up

- **Audio.** The seeded generator (test/support/harmonic-tone.ts) makes two clips of one sustained
  harmonic note each: clip A at MIDI 60 (2.4 s of sound) and clip B at MIDI 67 (2.0 s), at different
  pitches. No audio file is checked in.
- **Tracks and timeline.** Clip A is imported on a new track at timeline 0 and clip B on a second new
  track at least 1 s after clip A ends, so the master has two regions that can be compared on their
  own. Each import asks for notes and waits until `content.getDetails` reports `analysis.f0State`
  `ready`, as the effects scenario does.
- **Trimming the silent tail.** The generator leaves 0.1 s of silence after the note. Once both
  analyses are ready, the scenario trims each clip's end to its note with one `arrangement.edit` call
  (`trim` op), so a 0.5 s fade-out ends where the sound ends. The trim is part of the set-up and is
  not taken back. Without `arrangement.v1` the clips keep their tails and the checks that need a
  fade or a split skip themselves.
- **Baseline.** It exports the master once and reads the float32 WAV back (`export.start`, kind
  `master`, `ifExists: error`). The export result's `processing` (hybrid mode, backend, vocoder
  weight, tuning frequency) is recorded in the report; the top-level `hybridMode` is `true` when
  `session.info` or any export reported it on.
- **No assumed pan law or fade curve.** The master is compared with itself from other exports, so the
  channel layout, the pan law and the fade curve do not have to be known. The only level model used
  is a ratio of RMS values, and the two clips never overlap in time.

### What it checks

Each check writes, reads the project back, exports the master and compares it with the baseline. A
result's `changes[].fields.after` must equal the value read back with `project.get`, and the result's
`tokens` (arrangement revision, content tokens, placement geometry hashes) must equal a fresh read.
Fields the scenario does not read back are listed in the report and are not a problem.

| Step                                             | What must hold                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clip gain -6 dB`                                | `arrangement.edit` op `setGain` takes clip A to its current gain - 6 dB. Over clip A's region the RMS level change is -6 dB +- 0.5 dB, and clip B's region is bit-identical. `edit.undo` with the returned `undoId` reads back the snapshot, and the master is bit-identical to the baseline again; a difference is reported with its largest sample difference.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `fades are ramps`                                | `setFade` on clip A with 0.5 s in and out (the applied values when the result carries `CLAMPED`). The wet/baseline level ratio of every 10 ms window starts (fade-in) or ends (fade-out) at most -24 dB below the baseline, changes in one direction with 3 dB of slack for the windowing, and is within 0.5 dB of unity just outside the fade. The part of clip A between the fades and all of clip B stay bit-identical. The ratio at 25, 50 and 75 % of each fade is written to the report as information, not checked. The undo is verified as in the gain check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `mute and solo in the master export`             | `track.set` mutes clip B's track, then solos clip A's track, then solos clip B's track. In each case the clip that should not be heard is silent (largest sample at most 1e-6; exact zeros expected) and the other clip is bit-identical. The call's revert recipe is sent exactly as given; the old mute/solo values must be read back and the master must equal the baseline bit for bit. A revert that does not restore stops the checks after it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `move clip B 0.5 s later`                        | `arrangement.edit` op `move` takes clip B 0.5 s later on its track. The shift is read off the master by cross-correlating the amplitude envelope of clip B's old region with the new one, as the effects scenario measures a timing shift: 500 ms +- 2 ms. The part of the old place that the moved clip no longer covers is silent (at most 1e-6), the new place equals clip B in the baseline exactly (largest sample difference 0, at a start within one sample of the named one), and everything before clip B is bit-identical. `edit.undo` puts the clip back; the master must equal the baseline bit for bit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `trim clip A end by 1 s`                         | op `trim` (edge `end`) cuts 1 s off the end of clip A, which leaves 1.4 s. After the new end the master is silent up to clip B (at most 1e-6); the kept part of clip A and all of clip B are bit-identical (one sample either side of the new end is not judged). The cut part holds the sustained note, so a trim that is not rendered cannot pass. `edit.undo` and the comparison with the baseline are as above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `copy window of clip A`, `copy full of clip A`   | `arrangement.copy` puts a copy of clip A on the same track, 0.4 s after the end of the baseline master, so the target is empty and none of the warnings `STACKED_ON_SOURCE`, `OVERLAPS_CLIP` or `TRACK_AUTO_REVEALED` is expected. The result's `created` (the clip and a content of its own) and `idMap` (relation `copy`) must agree with a fresh `project.get`: track, start, length, gain and fades of the source and, in mode `full`, the part of the content it shows. In the master the copy equals clip A in the baseline exactly (largest difference 0, at a start within one sample of the named one), the gap before it is silent and everything up to the end of the baseline is bit-identical. The revert recipe (a delete, which asks for consent) is sent as given plus `confirm: true`, because the scenario made the copy; the master must equal the baseline again.                                                                                                                                                                                                                                                                                                                                                                      |
| `delete a copy of clip A`                        | The scenario copies clip A once more (it never deletes an original, because a delete cannot be undone) and deletes the copy with op `delete`. Without `confirm` the call must be refused with `INVALID_ARGUMENT(confirm_required)` and change nothing. With `confirm: true`, `removed` names the copy; the project is as before and the master equals the baseline bit for bit. The result's undo block and warnings (`upstream_undo_defect`, no revert, `UPSTREAM_UNDO_DEFECT`, `IRREVERSIBLE`) are written to the report.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `track volume -6 dB`                             | `track.set` sets the track of clip A to `volumeDb` -6 and, in a second case, to `volumeLinear` 0.5. Over clip A's region the RMS level change is -6 dB (-6.02 dB for 0.5) +- 0.5 dB and clip B's region is bit-identical; the values read back with `project.get` agree with the result. The revert recipe of each call is sent exactly as given; the track and the master must equal the baseline again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `duplicate track clone`, `duplicate track share` | `track.duplicate` copies the track of clip A to the hidden slot `newTrackId`, which becomes shown. The new track takes mute, solo, volume and colour of its source and holds a copy of every clip at the same place; with `clone` the copies have contents of their own, with `share` they show the contents of their sources and the result carries `SHARED_CONTENT`. Both tracks play the same samples, so over clip A the master is twice the baseline (largest difference at most 1e-6, level +6.02 dB +- 0.5 dB) and the rest is bit-identical. The revert recipe (a `track.delete`, which asks for consent) is sent plus `confirm: true`; afterwards the track list, the master and the notes of the content of clip A (which `share` must not have touched) read back as before.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `delete a duplicated track`                      | The scenario duplicates the track of clip A and deletes the duplicate with `track.delete` as a call of its own, not through the revert recipe. Without `confirm` the call must be refused with `INVALID_ARGUMENT(confirm_required)`. With it, `trackIdMap` must map the deleted track to `null` and every later shown track to its new place, as the following `project.get` shows (the clips, the settings and the number of shown tracks), `removed` names the clips of the track, and the master equals the baseline bit for bit. The result's undo block and warnings (`no_upstream_undo`, no revert, `IRREVERSIBLE`) are written to the report.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `split boundary is seamless`                     | After the checks above, because a split cannot be undone (`upstream_undo_defect`). `split` cuts clip A strictly inside a voiced note; the request is deliberately a few milliseconds off the 10 ms analysis grid, so an instance that snaps it reports `SPLIT_SNAPPED` and the check uses `appliedTimelineSec`. The result's `created`, `removed` and `idMap` entries must agree with a fresh `project.get`: the old clip gone, two new clips that meet at the applied split and cover the old clip. The whole master must stay bit-identical to the baseline and have the same length; if not, the report holds the largest difference, its time and its distance from the split. The returned revert recipe (a merge) is then sent as given and its master must equal the baseline again. A refused merge is reported, not failed.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `batch import sequential and separateTracks`     | Last, because an import shows a hidden track slot and nothing hides it again; these two cases therefore compare the project without the `visible` flag of the tracks. `import.start` imports the two generated clips with layout `sequential` at 10 s and then with layout `separateTracks`. Sequential: both clips on one track, the first at 10 s and the second where the first ends (1e-6 s), `project.get` agrees with the result, the first sound of each clip in the master lies within 1 ms of the first sound of its source placed where the project says, and the master equals the baseline plus the sources at their places, scaled by the gain that the baseline shows for clip A (largest difference 1e-6). SeparateTracks: two successive tracks, both clips at 0, and the master equals the baseline plus the sum of both sources. The revert recipe of each import (a delete) is sent plus `confirm: true`; the master must equal the baseline again. The specification gives an import this recipe when the instance reports `arrangement.v1`; a result without one (`revert: null`, warning `IRREVERSIBLE`) fails the check as a finding, the scenario then deletes the clips with a call it builds itself, and the measurements go on. |

A check that fails does not stop the checks after it, because each check takes its write back and
verifies the project and the master even when its measurement failed: with `edit.undo` where the write
has an `undoId`, with the call's revert recipe where it has none. Revert recipes of `arrangement.edit`
and `track.delete` ask for the end user's consent and, by protocol, must not carry `confirm`; the
scenario made every clip and track they remove, so it plays the end user and adds `confirm: true`
itself (a recipe that carries `confirm` is a problem). A check whose clean-up cannot restore the
project, or a write that took effect without a usable `undoId` or revert recipe, stops the remaining
checks with `SKIP` and the reason, like the effects scenario. A failed set-up step
stops the run. The results are those of the smoke scenario (`PASS`, `FAIL`, `SKIP`, `FLAKY-SKIP`).

The scenario needs `session.v1`, `jobs.v1`, `read.v1`, `import.v1` and `export.v1`. Each check skips
itself when its methods' capabilities are missing: `arrangement.v1` for gain, fades, move, trim, copy,
delete, split and import (whose revert is a delete), `history.v1` for the undos of gain, fades, move and
trim, and `tracks.v1` for mute and solo, track volume, duplicate and track delete. A missing base capability skips
the whole run with the reason. The instance must start with an empty project: an existing clip would
make the master regions ambiguous, so the set-up fails and says so.

### Tolerances

The constants are fixed in `test/e2e/arrangement-effects.ts`, each with its reason:

- **Gain: 0.5 dB.** A clip gain is a multiplication, so the level change is exact up to the master's
  summation; 0.5 dB still separates -6 dB from no change or half of it.
- **Fade window: 10 ms** (2 % of a 0.5 s fade). The first audible fade-in window (the last audible
  fade-out window when the clip ends in silence) must be at most -24 dB below the baseline: a linear
  ramp measures about -38.8 dB there, so 14.8 dB are left for a renderer's smoothing or another
  curve, while a fade that starts at unity measures 0 dB.
- **Fade direction: 3 dB of slack per window.** A monotone 0.5 s ramp changes by about 0.17 dB per
  10 ms window, so 3 dB leaves room for windowing and overlap; a dip of the size of the fade is
  still caught. Just outside the fade the level must be within 0.5 dB of the baseline, which is the
  same order as the gain tolerance.
- **Silence: 1e-6 of full scale** (-120 dBFS). A muted or soloed-out track is expected to produce
  exact zeros; the limit is above float32 rounding at the tone's level and far below the quietest
  generated signal.
- **Timeline: 1e-6 s.** Reads round timeline values to that precision. A split has no tolerance: the
  whole file must be bit-identical, and the split request itself is only offset by 3 ms inside the
  note so the `SPLIT_SNAPPED` path is exercised.
- **Move: 0.5 s, read to 2 ms.** The distance is 25 times the 20 ms the envelope estimator resolves
  comfortably, shorter than clip B so that old-only and new-only parts of the master exist, and a whole
  number of samples. The estimator is within 2 ms for another phase of the same waveform; the moved
  clip itself must equal the original sample for sample, because the dry audio is copied into the
  master.
- **Trim: 1 s.** The cut part holds the sustained note (RMS about 0.23, 100 times the noise floor), so
  a trim that is not rendered leaves a level far above the silence limit.
- **Position: one sample.** OpenTune turns a position in seconds into a whole sample by truncating (a
  clip moved to 4.1 s sounds from sample 180809, not 180810, because 4.1 * 44100 is 180809.99999999997
  in floating point), and the specification does not say which way it rounds. One sample is 23
  microseconds, so a clip may start one sample before or after the sample its start names; two samples,
  or a different clip, still fail.
- **Copies, moves and track duplicates: exact.** Dry audio is copied into the master, so a copy or a
  moved clip must equal its source with a largest difference of 0 at its start, and
  the sum of two identical clips must equal twice the source within 1e-6 (about 30 times float32
  rounding at the tone's level, 100 times below the generator's noise floor). The level of a coherent
  sum must read +6.02 dB +- 0.5 dB, the tolerance of the other level checks.
- **Track volume: 0.5 dB.** A volume is a multiplication, like a clip gain, with the same tolerance;
  it separates -6 dB from no change (0 dB) and from half the change (3 dB).
- **Import: onsets 1 ms, sum 1e-6.** An onset is the first 2 ms window of the master whose RMS reaches
  0.02 (8 % of the tone's RMS). The expected onset is the same measure on the source, scaled by the
  gain fitted from clip A in the baseline and placed where the project says, so a clip that sounds one
  analysis frame (10 ms) away from its position fails. The master must equal the baseline plus the
  placed, scaled sources within 1e-6.

### How to run

`npm run e2e:exe` runs the scenario after the effects scenario, each with an instance of its own. It
takes the variables above and its own report and data-template variables:

```bash
OTCP_TARGET_EXE=/path/to/OpenTune npm run e2e:exe
OTCP_TARGET_EXE=/path/to/OpenTune \
  OTCP_E2E_ARRANGEMENT_EFFECTS_REPORT=/tmp/arrangement-effects.json \
  OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE=/path/to/known-state \
  npx vitest run --project e2e test/e2e/exe-arrangement-effects.test.ts
```

Without `OTCP_TARGET_EXE` the test file is skipped as a whole and says why; it never reports `PASS`.
`OTCP_TARGET_DATA_DIR` keeps the instance's data folder under that folder, as for every scenario.
The scenario uses no external audio: there is no variable for it.

### The report

The step table goes to stderr. The JSON report (`OTCP_E2E_ARRANGEMENT_EFFECTS_REPORT`, else
`arrangement-effects.json` next to `OTCP_E2E_REPORT`) has `schema`
`opentune-mcp-e2e-arrangement-effects/1`, and:

| Member                                              | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `result`, `counts`, `steps`, `startedAt`, `totalMs` | As in the smoke report; every step has `name`, `result`, `ms` and a `note`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `hybridMode`                                        | `true` when `session.info` or any export reported hybrid mode on, `false` when all reported it off, `null` when none reported it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `dataTemplateFrom`                                  | `OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE`, `OTCP_TARGET_DATA_TEMPLATE` or `null`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `instance`                                          | Protocol, app version and the capability list of the instance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `audio`                                             | `source` (`generated`), the length and pitch of both clips, and the gap between them. No file name or path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `tolerances`                                        | The values listed above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `checks`                                            | Per step: the measured gain, the fade windows' first/last level and their ratio at 25, 50 and 75 %, any monotonicity or silence problem, the unchanged spans, the three mute/solo cases with their revert results, the split's `requestedTimelineSec`, `appliedTimelineSec`, `snapped`, the largest difference with its time and distance from the split, and the merge result; for the move the measured shift and its correlation peak, for trim, copy and duplicate the differences from the baseline, the revert recipe and the warnings, for the volume the two cases, for the deletes the undo block, `trackIdMap` and the warnings, and for the imports the placed clips, the fitted gain and the onsets; also `processing` (per export: hybrid mode, backend, vocoder weight, tuning frequency), consistency problems and any `unreadFields`. |
| `timings`                                           | Launch to ready, import to analysis ready for each clip, and the time of every export.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `dataDir`, `templateSkipped`, `busyDiagnostics`     | As in the smoke report.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Like the other reports it holds no absolute path and no token.

## Wave-B tour

The wave-B tour (`test/e2e/wave-b-tour.ts`) drives every OTCP method and every MCP tool that wave B
added once against a started OpenTune, and checks that the answers agree with the specification and
with what the tools tell the user. It is a tour, not a measurement: no audio is judged, only the
structure and the state. It starts its own instance like the boundary scenarios (same variables,
same data folders, its data folder below a scratch folder named `ot-e2e-wave-b-tour-*`), and it
starts `dist/opentune-mcp.mjs` over stdio for the tool part; the project's global setup builds that file before the
scenarios start.
`OTCP_TARGET_DATA_DIR` does **not** apply to this scenario: its instance, discovery folder and data
folder are its own scratch folder, removed at the end, also after a failure.

Every step of the tour is one of the smoke scenario's four results. A step that needs a capability the
instance does not report is `SKIP` with the capability named; a failed set-up step stops the scenario;
a failed check does not stop the later checks, unless the state of the instance could not be put back
(that stops them, since the later checks would judge the wrong state). The tour takes a few minutes
because it follows jobs (import and the reference analysis).

| Step                                                                         | What it checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prepare`                                                                    | About 6 s of generated audio (harmonic tones, 30 cents sharp) in the run's scratch folder.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `launch`                                                                     | The instance of this run (own data folder, data template from `OTCP_TARGET_DATA_TEMPLATE`, ready file and launch nonce checked by the runner).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `hello`                                                                      | `session.hello` and the capabilities the tour needs at all (`session.v1`, `jobs.v1`, `read.v1`, `import.v1`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ui.getState and ui.dismiss`                                                 | `ui.getState` is schema-valid. While a dialog is open that this scenario did not open, nothing is dismissed (`SKIP`); a first-run overlay that this run's own instance started is closed (that marks `onboardingShown`, an IRREVERSIBLE preference no request resets, in this run's data folder only). Otherwise `ui.dismiss` is a no-op and says so (`noOp`, reason `no_op`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `import and analysis`                                                        | `import.start` with `generateNotes` and `focus: false`, the job followed, the pitch analysis ready and notes generated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ui.getState and ui.setSelection`                                            | A track and the clip are selected (`ui.setSelection`); the previous selection is put back through the recipe the result gives.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `track.set, track.add, track.duplicate and track.delete`                     | `track.set` muting track 0 and its revert recipe putting the mute back; `track.add` showing one more slot (warning `NOT_PERSISTED`, no revert because the visible-track count is view state; `track_limit` is a `SKIP`); `track.duplicate` of a track of this scenario, whose revert is a `track.delete` of the new track (consent added by the scenario, since it created the track).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `transport.get, transport.setTempo, transport.setLoop and transport.control` | `transport.get` schema-valid; the tempo and the loop flag changed and put back through their recipes; then **every visible track is muted** (`track.set`), the transport seeks, plays and stops, and the mute, the position and the track values are put back and compared with the snapshot taken before. `LOOP_NO_EFFECT_STANDALONE` appears when the loop is turned on; `NO_AUDIO_DEVICE` when no device runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `prefs.set`                                                                  | `tuningHz` changed (warning `GLOBAL_PREFERENCE` and `NOT_RETROACTIVE`), its revert recipe applied, the old value read back; the report lists the preference it touched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `audio.get and audio.set`                                                    | The maintainer agreed that the test switches the machine's audio setup as long as it is put back. A buffer size or sample rate that `audio.get` lists for the **current** device is changed first (`GLOBAL_PREFERENCE`); when the device offers neither, another output device, then another device type. The revert recipe is sent as given, and device type, output device, sample rate, buffer size and output channel pair read back are compared one by one with those read at the start. A setup that is not back is a `FAIL`; its note gives the setup of the start, so that it can be set back by hand (the step also sends the start values once more, both when the setup read back differs and when the revert itself failed or read back differently, and the note says whether that put the setup back). Without a running device, or when `audio.get` offers nothing but the current setup, the step is a `SKIP` with that reason. |
| `arrangement.edit: move, trim, gain and fade`                                | One call with the four ops on a clip of this scenario, as one undo step; the gain asks for an out-of-range value on purpose, so `CLAMPED` must be there and the applied value must be the limited one; `edit.undo` restores the geometry read back before the write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `arrangement.copy and arrangement.edit op setReference`                      | `arrangement.copy` (mode `window`) creates a clip of this scenario; `setReference` binds it to the source clip (warning `EXPERIMENTAL_FEATURE`) and its undo puts the binding back; the binding is set again for the next step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `content.analyzeReference and content.autoTune in mode reference`            | The reference job's result has the alignment data; `content.autoTune` in mode `reference` aligns the copy as one undo step, whose undo restores the notes. OpenTune completes only one synchronous reference analysis per session, and in the measured build it has used it up before the first import is over (a binding made right after an import, with or without `generateNotes`, already meets the stalled error), so the step cannot get a real PASS there: a job that ends at once with `NOT_READY(reference_analysis_stalled)` (the job of `content.analyzeReference` and the job of `content.autoTune` alike) passes as the known upstream defect when it changed nothing; the note says so and `facts.knownUpstreamDefects` lists it. The same error at the wait limit, `reference_analysis_timeout` and every other error fail the step.                                                                                             |
| `the wave-B MCP tools`                                                       | `opentune_set_tracks` (duplicate a track of this scenario), `opentune_delete_track` (that track, with `confirm: true`), `opentune_transport` (the loop flag, put back through the revert line), `opentune_manage_ui` (select the clip), `opentune_set_settings` (`tuning_hz`, put back), `opentune_edit_arrangement` (a gain, undone with `opentune_undo`) and `opentune_autotune_range` in mode `reference` (a job handed over is followed): each result is not `isError`, passes the tool's output schema, says in its first sentence what cannot be undone, and its change is visible in a fresh OTCP read.                                                                                                                                                                                                                                                                                                                                   |
| `arrangement.edit: split, the merge that takes it back, and delete`          | The copy is removed through its revert recipe; when later writes have changed the arrangement since, the recipe first refuses with `REVISION_CONFLICT(arrangement_changed)` and is then sent with the current revision; the split carries `UPSTREAM_UNDO_DEFECT` and its revert merges the clips again; the delete (of a clip of this scenario, `confirm: true`) carries `UPSTREAM_UNDO_DEFECT` and `IRREVERSIBLE` and has no revert.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `shutdown`                                                                   | The MCP server and the instance this run started are ended, the scratch folder is removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Besides the schema of every result, each write of the tour is checked for the report consistency of
`test/e2e/effects.ts`: every `changes[].fields.*.after` equals the value a read right after the write
returns (`project.get`, `transport.get`, `prefs.get`, `audio.get`, `ui.getState`, `content.getDetails`,
`content.getNotes`), and the returned `tokens` equal a fresh read. If `undo.undoable` is true, the
`undoId` is used with `edit.undo` and the state read back must equal the snapshot read before the
write; otherwise the revert recipe is sent as the result gives it (with the consent member the recipe
withholds, only for tracks and clips this scenario created) and the state must come back. A result
whose `revert` is null must carry its reason, and `IRREVERSIBLE` where the specification says so.

The report is `wave-b-tour.json` next to `OTCP_E2E_REPORT`. It has the members of the smoke report
(`schema`, `result`, `counts`, `startedAt`, `totalMs`, `steps[]`, `facts`, `manualChecks`) plus:

| Member         | Holds                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance`     | `protocol` and `appVersion` of `session.hello`; `null` when the scenario never got that far.                                                                                                                                          |
| `capabilities` | The capabilities the instance reported.                                                                                                                                                                                               |
| `calls`        | Every call of the tour with its latency: `step`, `method`, `kind` (`write`, `undo`, `revert`, `read`, `job`), `ms`, `outcome` (`ok` or `error`), `note`. Result reads of the checks are counted in the facts (`readCalls`, `readMs`). |
| `tools`        | Every MCP tool call with `ms`, `outcome` (`ok`, `error`, `skip`) and a short note.                                                                                                                                                    |
| `skipped`      | What could not be run and why (a missing capability, a missing track slot, a dialog this scenario did not open).                                                                                                                      |

`facts` holds `sourceSeconds`, `notesGeneratedBy`, `openDialogs`, `onboarding`, `onboardingDismissed`
(when the overlay of this run was closed), `trackAdd` (when it hit `track_limit`), `duplicatedTrack`,
`preferencesTouched`, `audioSetting`, `readCalls`, `readMs`, `callCount` and `mcpToolCalls`. Like the
other reports it holds no absolute path and no token. It also lists the manual check that a person
may confirm nothing was heard: the tour mutes every track before it plays and puts the mute back.

## Wave-B boundary scenario

The wave-B boundary scenario (`test/e2e/wave-b-boundary.ts`, `test/e2e/exe-wave-b-boundary.test.ts`) drives the
cases at the edge of what a wave-B write promises, and checks that the answer, the history and a fresh read
agree. The tour and the arrangement effects scenario drive every method once; this one does not repeat them. It
starts its own instance like the tour (same variables, its scratch folder named `ot-e2e-wave-b-boundary-*`,
`OTCP_TARGET_DATA_DIR` does not apply) and uses only generated audio. Select it alone with
`npm run e2e:exe -- test/e2e/exe-wave-b-boundary.test.ts`. A failed check does not stop the later ones; an
instance that reports no capability a check needs gives a `SKIP` that names it.

| Step                                                                     | What it checks                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `import four clips on four tracks`                                       | Set-up: four generated clips with notes, one per track; a failure here stops the scenario.                                                                                                                                                                                                                                                                                     |
| `trim shorter than the fades, and its undo`                              | Fades are set, then the clip is trimmed to less than the two fades together: `FADES_RECLAMPED` is reported and the fades read back are shorter; `edit.undo` restores the length and the fades.                                                                                                                                                                                 |
| `delete a middle track, then undo an older step`                         | `track.delete` (with `confirm`) reports `trackIdMap`, which equals where a fresh read finds each clip; the older undo entry is possibly stale and is refused with `UNDO_CONFLICT(stale_entry)` without `force`; with `force` the answer is `UNDO_NO_EFFECT` or the change is visible in a fresh read, and the two agree.                                                       |
| `split, merge and delete report the undo defect`                         | Each result says `undo {undoable: false, reason: upstream_undo_defect}` with the warning `UPSTREAM_UNDO_DEFECT`; the entry on top of the history is flagged unsafe and `edit.undo` refuses it (`UNSUPPORTED`, `undo_unsafe_build`) without changing anything. A delete without `confirm` is refused (`confirm_required`).                                                      |
| `switch the editing scheme and put it back`                              | `prefs.set` of `editingScheme` reports `GLOBAL_PREFERENCE` and `undo {undoable: false, reason: ui_parity}`; the revert recipe, sent as given, puts the scheme back. A dialog that stays open afterwards is reported and closed.                                                                                                                                                |
| `every processing preference changes once and is put back by its recipe` | `tuningHz`, `hybridMode` and `experimentalFeatures` are changed one by one (`GLOBAL_PREFERENCE`), each revert recipe is sent as given, and `prefs.get` returns exactly the values it returned before.                                                                                                                                                                          |
| `openDyne: import focus and selection generate notes`                    | With the `openDyne` scheme (put back at the end): selecting a clip that has no notes reports `SELECTION_GENERATED_NOTES`, names the clip in `sideEffects.notesGenerated`, marks the project changed, and `ui.getState` and a fresh read show the selection and the notes; an import with `focus` reports `notesGenerated` and `notesGeneratedBy: focus`.                       |
| `save as over another project`                                           | `project.saveAs` onto another existing project is refused with `confirm_required` and leaves that file untouched; with `confirm` it succeeds and reports `OVERWROTE_OTHER_PROJECT`. Everything is in the scratch folder.                                                                                                                                                       |
| `a project with missing media`                                           | The media of the saved project (the imported file and the copy OpenTune keeps next to the project) is moved away and the project is opened: `MEDIA_MISSING`, `skipped.media` lists the file, and the clip is not restored. The files are moved back afterwards. When the media file cannot be renamed (OpenTune holds it) the step is a `SKIP` with that reason, never a PASS. |

Manual checks (listed in `manualChecks` of the report; nothing in the interface can drive them):

- **Track colour dialog.** Open the colour dialog of a track in the OpenTune window and close it by the close
  button and by Escape; the track keeps its colour. No request opens this dialog (`ui.dismiss` only closes one
  and `ui.getState` only lists it). The headless tests of the build under test cover dismissing a listed dialog.
- **Write during a modal.** With a dialog open in the OpenTune window, send a write (for example `track.set`);
  it must fail with `BUSY(modal_open)` and change nothing. No request opens a modal dialog. The headless tests
  of the build under test cover the `BUSY` answer with a test bridge.

The report is `wave-b-boundary.json` next to `OTCP_E2E_REPORT`, with the members of the smoke report. Its `facts`
name what the scenario saw (for example `schemeSwitchSideEffects`, `staleUndo`, `overwriteRefusal`,
`missingMediaWarnings`, `settingsFilesWithAddedKeys`).

## Settings snapshot

A run against a real OpenTune must leave the settings as it found them. Every scenario that starts an instance
(smoke, effects, boundary, instances, launch, arrangement effects, tour, wave-B boundary) and the contract runner
against the exe do the following with `scripts/e2e/settings-snapshot.mjs`:

1. After the data template has been copied into the instance's data folder and before it starts, the settings
   files of that folder are snapshotted: every `*.settings` file (the preferences with `onboardingShown`, and the
   JUCE settings with the audio device), byte for byte. Log and discovery folders are not part of it.
2. Once the instance answers, a second snapshot is taken. OpenTune writes its defaults into a fresh folder while it
   starts, so the keys and files it adds are not a difference (the scenario reports how many as
   `settingsFilesWithAddedKeys`, the number of files in which keys appeared); a value that was there and changed is.
3. When the run is over, whatever its outcome, the folder is compared with the second snapshot, put back to the
   first one byte for byte, and checked again. A difference is a `FAIL` that lists it (values are clipped), and so is
   a restore that did not work.

A second guard compares the settings files of the **real** OpenTune folders of the user, by size and modification
time only: they are never opened or written, and the log folder is not compared. The preferences and the JUCE settings
are in JUCE's per-user application data folder (`%APPDATA%\OpenTune` on Windows); the control-API discovery folder
is under the per-user state folder (`%LOCALAPPDATA%\OpenTune\control` on Windows). Both folders are watched. Any
change fails the run (`real user settings untouched`), which proves the run did not touch the real settings. The
step's note says how many files were watched in which folder; when no settings file was found at all the step is a
`SKIP` (the check could not have noticed anything), never a silent PASS. When a scenario throws, the watch result is
added to its error message.

The script can also be used by hand: `node scripts/e2e/settings-snapshot.mjs snapshot <dir> <snapshot.json>`,
then `diff <dir> <snapshot.json>` (exit 1 when they differ) and `restore <dir> <snapshot.json>`. **`restore`
deletes** every `*.settings` file below `<dir>` that the snapshot does not have and **overwrites** the others with
the saved bytes, so point it only at a scratch data folder. It refuses a snapshot with a file name that is not a
relative path inside `<dir>` (`..`, absolute, drive letter), and a `<dir>` that is, contains or lies inside the
settings folder of the real OpenTune. The unit tests
(`test/unit/settings-snapshot.test.ts`) run on temporary folders and never touch a real one.

## Judging a run

`npm run e2e:exe` exits with 0 for a run that passed and for one that was skipped as a whole; only a `FAIL` fails the
command. The exit code therefore does not say that a build passed: read the step tables and the reports. This section
is about running the whole set on a real machine and reading what comes out.

### Running the whole set

1. Prepare the machine as in [Prerequisites](#prerequisites). Close every other OpenTune on it and do not work in
   OpenTune during the run: the guard on the real settings folders (see [Settings snapshot](#settings-snapshot))
   compares them before and after, and it cannot tell your changes from the run's. The tour switches the audio setup of the
   machine for a moment (another buffer size or sample rate, else another output device or device type) and puts it back,
   comparing the whole setup with the one at the start; if that fails the note gives the start values for you to set
   back by hand (see the table of `SKIP`s below).
2. Set `OTCP_TARGET_EXE` to the build under test and `OTCP_E2E_REPORT` to a file path in a folder you keep. For the
   effects scenario and the arrangement effects scenario give a data template that starts OpenTune with hybrid mode
   off (`OTCP_E2E_EFFECTS_DATA_TEMPLATE`, `OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE`, see above).
3. Run `npm run e2e:exe`. The scenarios run one after the other, each with an instance of its own.
4. To run one scenario, name its file: `npm run e2e:exe -- test/e2e/exe-wave-b-tour.test.ts` (the others are
   `exe-wave-b-boundary.test.ts`, `exe-arrangement-effects.test.ts`, `exe-effects.test.ts`, `exe-smoke.test.ts` and
   `exe-boundary.test.ts`, which runs the three boundary scenarios).

Every scenario prints its step table to stderr and, with `OTCP_E2E_REPORT`, writes its report: the smoke report at the
path given, the others as `<scenario>.json` in the same folder (`effects.json`, `arrangement-effects.json`,
`boundary.json`, `instances.json`, `launch-real.json`, `wave-b-tour.json`, `wave-b-boundary.json`).

### What counts as a pass

A build passes a real-OpenTune check when all of this holds:

- Every report has `result` `PASS`, and its `counts` show 0 `FAIL`, 0 `SKIP` and 0 `FLAKY-SKIP`. A `SKIP` is not a
  defect, but it is a check that did not run, so it is not a pass. The `SKIP`s that a machine causes, and what clears
  them:

  | Step                               | Skipped when                                                                                            | What clears it                                         |
  | ---------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
  | `audio.get and audio.set`          | No audio device runs in the instance, or `audio.get` offers nothing but the current setup to switch to. | Run on a machine whose audio device offers a choice.   |
  | `ui.getState and ui.dismiss`       | A dialog is open that the scenario did not open; the scenario never closes it.                          | Close the dialog in the OpenTune window and run again. |
  | `launch-real` (the whole scenario) | An `OpenTune.exe` that the scenario did not start is running; it never ends that one.                   | Close it and run again.                                |
  | Any step                           | The instance does not report a capability the step needs; the note names it.                            | Use a build that reports it.                           |

- The settings guard is clean in every scenario. `real user settings untouched` is `PASS` with a count of watched
  files above 0. A `SKIP` there means the guard found no settings file at all, which on a machine with OpenTune
  installed means it looked in the wrong folder, so the run proved nothing about your settings.
- The only defects the reports hold against the build are the known upstream defects listed below, each named in the
  report.
- The `manualChecks` of the reports are for a person; they are not part of the automatic result. The tour mutes every
  track before it plays, so nothing should have been heard and no track should be left muted; the track-colour dialog
  and a write during a modal dialog are described under [Wave-B boundary scenario](#wave-b-boundary-scenario).

### Reading the settings guard

The guard (see [Settings snapshot](#settings-snapshot)) reports in two places:

- **In the scenario.** The last, clean-up step of the scenario (`shutdown` in the smoke scenario and in the tour) is a
  `FAIL` when a settings file of the instance's own data folder changed in value, or could not be put back to the
  first snapshot byte for byte. Its note lists the files and the changed keys, values clipped. Keys and files that
  OpenTune added while it started are not a difference. In the wave-B boundary scenario only, the number of files that
  gained keys is reported as the fact `settingsFilesWithAddedKeys`.
- **Around the scenario.** The step `real user settings untouched` compares the settings files in the real user folders
  by size and modification time and fails on any change. It names the file that changed. One possible cause is another
  OpenTune that was open on the same machine; find out what touched the file before you run again.

A failed guard fails the run even when every other step passed. Fix the cause and run again; do not edit the report.

### Known upstream defects

OpenTune completes only one reference analysis per session. Every later reference analysis ends, in a build that
reports it, with `NOT_READY` and the reason `reference_analysis_stalled`, and only a restart of OpenTune helps. The
tour counts this as a known upstream defect, not as a failure of the build, when all of the following hold for a
reference alignment:

- the error is exactly `NOT_READY` with the reason `reference_analysis_stalled`;
- it came back before the wait limit of 30 seconds, not at the limit;
- the notes of the clip read back as before and the undo history has the same number of steps.

Three calls of the tour are judged by this rule, and each needs its conditions:

- the `content.analyzeReference` job of the step `content.analyzeReference and content.autoTune in mode reference`: the
  error and the wait limit as above (it writes nothing, so there are no notes to compare). In the measured build the
  one analysis is already used up when the first import is over, so a binding made right after an import, with or
  without `generateNotes`, meets the error at once and the step cannot reach a real analysis;
- the `content.autoTune` call in mode `reference` of the step `content.analyzeReference and content.autoTune in mode
reference`;
- the `opentune_autotune_range` call in mode `reference` of the step `the wave-B MCP tools`.

The step then passes. Its note says `known upstream defect`, and the report names the defect in the fact
`knownUpstreamDefects` (`["reference_analysis_stalled"]`), listed once however many calls met it. A run that meets a
known upstream defect is a `PASS` that carries that list: name the defects when you report the run; they are neither
hidden nor turned into a `SKIP`. Anything else fails the step: no reason on the error, the error at the limit,
`reference_analysis_timeout`, `ANALYSIS_FAILED`, a change of the notes or of the undo history, and the same error in any
other call. The defect is OpenTune's own;
the control API does not hide it and does not work around it.

A defect of the build under test is never a known upstream defect. An out-of-range clip gain that is applied without
being limited and without a `CLAMPED` warning, for example, fails the step of the tour that checks it until the build
is fixed.
