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
| `OTCP_TARGET_DATA_DIR`    | Optional. Absolute path of an existing folder; each launch then gets a kept sub-folder of it as data folder (see `docs/real-opentune-testing.md`). |
| `OTCP_TARGET_DATA_TEMPLATE` | Optional. Absolute path of an existing folder; its contents are copied into the data folder of every launch before it starts, except the ready file at its top and its `control/instances/` folder, which the runner uses itself (matched without regard to case on Windows and macOS). |

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
preconditions (`given`) that this target cannot establish (see below).

### Preconditions and runner names on a real instance

The target prepares a vector's state through the public calls of a session of its own (closed before
the vector connects, so the vector's connections are the only ones), from audio it generates at run
time in a work folder that is removed afterwards (`test/contract/exe-given.ts`). What it builds, and
checks by reading it back; a state that does not read back as asked is skipped, not claimed:

| Name | How |
| --- | --- |
| `runner.unknownPlacementId`, `runner.unknownContentId` | A handle of the instance's own instance part and content epoch with a serial that nothing has. |
| `runner.stalePlacementId`, `runner.staleContentId` | A handle of valid form whose instance part differs (vectors/README.md). |
| `runner.lastTrackId`, `runner.unknownTrackId`, `runner.arrangementRevision` | Read from `project.get` once the preconditions are in place. |
| `given.files` | `audio`, `absent`, `existing` (with its `.next` name) and `undecodable`, in the vector's own folder. `noAccess` (needs an access control list) and `project` / `projectMissingMedia` (need a project OpenTune wrote) are skipped. |
| `given.clips` | Only a plain clip (bind, track, start, duration, `ready`): the generated audio is imported without notes and the analysis awaited; the names `<bind>.contentId`, `.placementId`, `.sourcePath` and the tokens are bound last. A clip described by notes, key, time grid, fades or pitch shift is skipped with "needs exact content (notes, key, time grid, fades or pitch shift); covered by the fork's headless runner"; so is an analysis that is not `ready`. |
| `given.dirty` | `true`: a tempo change that is taken back at once (else a mute that is). `false`: the project is saved to a file of the vector's folder when earlier steps made it dirty. |
| `given.visibleTrackCount` | `track.add` up to the number (or all slots); tracks cannot be hidden, so a number below what is shown is skipped. |
| `given.history` | Only undo entries made through the API (`pitchShift`, `clipMove`) on a clip of `clips`; entries made in the UI, redo entries and entries made possibly stale by a track deletion are skipped. |

Everything else (`audio`, `dialogs`, `onboarding`, `editingScheme`, `preferences`, `jobs`,
`withoutCapabilities`, `projectFile`, `clipOnEveryTrack`) is skipped with the reason.

Afterwards the process is asked to stop normally and the discovery file is checked to be gone.
Windows has no normal stop request to send, so there the target ends the process and records that
the clean-up on exit was not verified. On a failed start the error carries the tail of the
process's stderr with token, server proof and nonce removed.

### Which processes the target ends

Only the process it started, and the process the ready file names when that is another one (the
executable is a launcher that hands over to the real process). That second process is ended only
once it is confirmed to come from this launch: its discovery file carries the launch nonce, and the
start time the operating system reports for it lies between the launch and the ready file and
matches `processStartTimeMs` of its discovery file (within 2 s). The start time is read again
before every stop request, so a reused pid is never signalled. A process that cannot be confirmed
is never ended: the vector fails with "could not be confirmed as started by this target … it was
not ended", and the process keeps running until you end it yourself. No process is looked up or
ended by name.

### How the instances ended

Each run reports, next to the PASS / FAIL / SKIP counts, how many instances

- stopped normally with their discovery file removed;
- were ended by force (Windows, or no exit in time), so the clean-up on exit was not verified;
- quit by themselves as a vector asked for it (`endsSession`, below), with their discovery file removed;
- ended by themselves during a vector that did not ask for it, with the exit code when it is known;
- exited after a normal stop request but left their discovery file behind;
- could not be confirmed as started by this run and were not ended.

The last three are deviations: each one also makes the vector it happened in FAIL, whatever the
vector itself gave.

### Vectors that end the instance

A vector with `endsSession` true (`app/quit-clean`, `app/quit-saved-path`, `app/quit-dirty-discard`) makes the
instance quit by itself, and `spec/otcp/v1/vectors/README.md` ("Vectors that end the instance") says what a runner
checks. This runner gives every vector an instance of its own, so the next vector is unaffected; no ordering is
needed. For such a vector it

- waits up to 15 seconds, not 5, for a close (`connectionAfter` `closed`, `expectClosed` without `withinMs`);
- then waits, within 15 seconds, until every connection of the vector is closed and the port of the instance accepts
  no connection any more;
- asks the target how the instance ended (`expectEnded`). The exe target waits for the process it started to exit by
  itself and requires exit code 0; for a process that a launcher handed over to it can see only that the process is
  gone, not how it exited, and says so in the note of the vector (`not checked: ...`). Both require the discovery
  file to be gone. The mock target requires the mock to have stopped completely and the file to be gone, and notes
  that it has no process of its own.

The instance that quit is not counted as one that "ended by itself during a vector" and is not ended again by
`close()`. From the moment the runner sends the call that makes it quit (the request of a request vector, the last step
that sends in a scenario) its end is one that was asked for, also when the vector fails at that step or afterwards, so
the failure is the one of the vector and not a second one for an early end. An instance that ends before that call was
sent, because an earlier step failed, is still one that ended by itself. A vector that does not set `endsSession` and
sees its instance end is still a deviation.

`OTCP_CONTRACT_SUMMARY_EXE` (a file path) makes the run write its counts as JSON, which is how
`npm run gates` fills its "contract vectors (exe)" row. The file also names the runner (`exe`), the build
(`commit`, from `OTCP_TARGET_COMMIT`, else `unknown`) and every vector (`vectors`, below). The "contract vectors (mock)" row clears
`OTCP_TARGET_EXE` for its own run, so setting it starts no executable there.

## Which vectors pass where: `scripts/vector-coverage.mjs`

No single runner passes every vector: the mock lacks some behaviour, a started OpenTune cannot be put into
some states, the fork's headless runner has its own limits. The coverage script merges the result files of
several runners and lists, per vector, where it passes and, for a vector that passes nowhere, why each runner
skipped it.

Result file, one per runner (UTF-8 JSON):

```json
{
  "runner": "exe",
  "commit": "<sha of the build under test>",
  "vectors": [
    { "id": "session/hello-ok", "status": "PASS" },
    { "id": "edit/redo-ok", "status": "SKIP", "reason": "needs exact content (notes, key, time grid, fades or pitch shift); covered by the fork's headless runner" }
  ]
}
```

`status` is `PASS`, `FAIL` or `SKIP`; `reason` is optional for `PASS`. Other members are ignored, so the summary
files of this directory's runs (`OTCP_CONTRACT_SUMMARY` for the mock, `OTCP_CONTRACT_SUMMARY_EXE` for the exe)
can be passed as they are. The fork's headless runner writes the same format.

```bash
node scripts/vector-coverage.mjs mock-summary.json exe-summary.json headless.json
node scripts/vector-coverage.mjs --vectors spec/otcp/v1/vectors --json exe-summary.json
```

It prints the runners with their counts, a table of every vector with the runners that pass it, the vectors no
runner passes with every runner's reason, vector ids that are not in the directory, and the totals. In the table,
a runner that did not list a vector is counted ("not listed by N runners") rather than named, so only the runners
that passed, failed or skipped a vector are named there. Exit code 0: every vector passes in at least one runner and none
fails; 1: a vector fails somewhere, passes nowhere, or a result names an unknown id; 2: unreadable input or a
wrong option.

The result files (`OTCP_CONTRACT_SUMMARY`, `OTCP_CONTRACT_SUMMARY_EXE`) can be shared: the home and temporary folders in their texts are replaced by `~` and `%TEMP%` (`$TMPDIR` outside Windows), and a stack trace keeps its first line only.
