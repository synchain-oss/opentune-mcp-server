# Contract change: follow-ups to the settings, export, timing and notes tools and to the mock

## Background

The reviews of the changes that added whole-song timing (`get_notes` to a file, 64 operations of `edit_timing`), the
result wording, the write-result size, the settings summaries and the mock's `app.quit` left a few suggestions that
were recorded as follow-ups. They are all small and independent, and they are done together here. The OTCP
specification (`spec/otcp/v1/`) and the MCP instructions are not changed; no tool, argument or error kind is added or
removed. One description (the `ops` argument of `opentune_edit_timing`) is a little longer, which is the only change of
the tool catalog.

## Files

| File                                                       | Change                                                                                                                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tools/processing-text.ts`, `src/tools/settings.ts`    | The fall back to the CPU is said only while the vocoder is loaded; the sentence about a vocoder that is not loaded no longer calls it normal.              |
| `src/tools/status.ts`                                      | No change of its own: it uses the same sentence (`VOCODER_NOTE`) as the settings.                                                                          |
| `src/tools/set-settings.ts`                                | A read of `session.info` that fails before the change gives the reason `ready_state_unavailable` and its own sentence.                                     |
| `src/tools/wav-peak.ts`                                    | Counts samples that are NaN or infinite and reports `not_finite` before `silent`.                                                                          |
| `src/tools/manage-ui.ts`                                   | `notesGenerated`, `uiScaleChanged` and `workspaceSwitched` are worded by their key, whatever their value is, like `tempoRounded`.                          |
| `src/tools/timing.ts`                                      | The full format is used only while the result fits the output budget; the description of `ops` says that a long result is compact.                         |
| `src/tools/notes.ts`, `src/tools/client-timeout.ts`        | A read for `output_path` has a time budget inside the time a client waits; the constant of that time moves to its own file and is shared with `timing.ts`. |
| `mock/server.ts`                                           | A stop whose removal of the discovery file fails still marks the end and runs the clean-up; `app.quit` does not leave an unhandled rejection.              |
| `test/golden/tools-list.json`                              | The description of `ops` of `opentune_edit_timing`.                                                                                                        |
| `docs/reference.md`                                        | Regenerated from the golden catalog by `npm run catalog:update`.                                                                                           |
| `docs/TROUBLESHOOTING.md`, `docs/TROUBLESHOOTING.zh-CN.md` | The vocoder paragraph, and the new reason `read_too_slow` under `REQUEST_TIMEOUT`.                                                                         |
| `CHANGELOG.md`                                             | The two `### Fixed` headings of Unreleased are one; the entries of this change.                                                                            |
| `test/unit/*.test.ts`                                      | Cases for every item below, and the cases that stated the old behaviour are changed.                                                                       |

## 1. The settings no longer conclude from a vocoder that is not loaded

**Problem.** `opentune_get_settings` said "the rendering priority is gpuFirst but OpenTune is using the CPU" whenever
`processing.backend` was `cpu`. While the vocoder is not loaded (`vocoderReady` false) the backend can still be the one
from before, so no fall back can be concluded; `opentune_set_settings` already said so after a change. And it said "the
vocoder loads when the first render needs it, so it not being loaded just after start is normal" for every
`vocoderReady: false`, which would also have told an agent that a vocoder that could not load, or is stuck, is fine.

**Fix.** The sentence about the CPU needs `processing.vocoderReady === true`. For the second sentence, the results of
`session.info` and `prefs.get` were checked for a member that tells "not loaded yet" from "could not load" (a reason, a
state, the last failure): there is none. `vocoderReady` is false in all three cases and `vocoderReconfiguring` is false
unless a load is running now. So the sentence became neutral: "The vocoder is not loaded yet; it loads when the first
render needs it. If it is still not loaded after a render, tell the user." It is the same constant for
`opentune_get_status`, `opentune_launch` and `opentune_get_settings`. The troubleshooting text says where to look (the
log) and that a change of the weight fails with `vocoder_load_failed` when the load fails.

**Client impact.** Summary wording only. A summary that used to carry both sentences (CPU under `gpuFirst`, vocoder not
loaded) carries the one about the vocoder.

## 2. `set_settings`: a failed read before the change is not "not ready"

**Problem.** The state of the vocoder is read from `session.info` before a change of the weight or the rendering
priority. A read that failed counted as "not ready", so `rendering_backend.unconfirmed_reason` said
`vocoder_not_ready_before_change` for a state that was not known.

**Fix.** The state is `ready`, `not_ready` or `unknown`. For `unknown`, `confirmed` is false as before (the job may not
have waited for the vocoder), `unconfirmed_reason` is `ready_state_unavailable`, and the summary says that whether the
vocoder was ready could not be read, instead of saying that it was not ready. The wording of the re-render does not
change.

**Client impact.** A new value of an existing member (`unconfirmed_reason`), which is not an enumeration of the
specification; clients that read it as a string need no change.

## 3. `export_audio`: a NaN is not silence

**Problem.** `readWavPeak` compared samples with `>`, which is false for NaN, so a file of NaN had the peak 0 and was
reported `silent`, and a file with some NaN got the level of its finite samples.

**Fix.** Samples that are NaN or infinite are counted. If there is one, `peakDbfs` is null with the reason `not_finite`,
before the test for `silent`. `clippedSampleCount` and the sentence for a peak above 0 dBFS are as before.

**Client impact.** `nullReasons.peakDbfs` can be `not_finite` where it was `silent` or absent.

## 4. `manage_ui`: every worded side effect is decided by its key

**Problem.** The summary of `focus_clip` words `tempoRounded` whenever the key is there. The other three worded side
effects (`notesGenerated`, `uiScaleChanged`, `workspaceSwitched`) were worded only when the value was an object; for a
null or a string the one line of the fixed table named the effect, without "no undo entry" and "the project is marked as
changed", or without saying where the window went.

**Fix.** All four are decided by `Object.hasOwn`. For a value that is not an object, the sentence is the one of the
side effect without what the value would have said: "OpenTune generated notes for the clip, with no undo entry, and the
project is marked as changed" (no count), "the scale shown in the transport bar changes with the clip key", and "the
window switched to a view the result does not name" (no views). The same sentences hold in a dry run (present tense and
"would be"), and for `workspaceSwitched` with `open_editor`.

**Client impact.** Summary wording only, for an instance that sends such a value; the structured members are unchanged.
No golden of a rendered result changed.

## 5. `edit_timing`: the full format is by size

**Problem.** Up to 8 operations had every step in full, and a step carries the write result of its request. Eight
operations that moved many handles were about 40,000 characters, twice the output budget of 20,000.

**Fix.** The full format is assembled first; if its serialized size is over the budget, the compact format is used (per
step the operation number, `op`, `moved`, `clamped`, `undo_id` and the moves up to a character budget), which is the one
used above 8 operations. It still gives the count of every operation. The handles of the grid are read once; the compact
format lists 40 of them, the full one 100. The same decision is made for the `completed` steps of an error. The
description of `ops` says "more than 8, or a result too long, give a compact result".

**Client impact.** A result of 2 to 8 operations can now have `steps_format` (compact) where it had full steps. A client
that reads `steps` must check `steps_format`, as it already had to for more than 8 operations.

## 6. `get_notes` to a file has a time budget

**Problem.** The loop that reads the pages for `output_path` had no limit but the number of pages. A client waits 60
seconds; a read that ended later wrote a file that nobody was told about, and the retry wrote a second one named " (2)".

**Fix.** Before each page after the first, the read stops if the page at its whole timeout (15 s) and the write of the
file (5 s) could end after 60 seconds, that is when more than 40 seconds have passed since the start of the call; the
rule is the one of `opentune_edit_timing` (`CALL_BUDGET_MS`), with the same constant for the client's wait
(`CLIENT_TIMEOUT_MS`, now in `src/tools/client-timeout.ts`). The same check runs before the file is written. The result
is `REQUEST_TIMEOUT` with the reason `read_too_slow`, `executed` false, the count of notes read in the detail, and a next
step (a narrower range). No file is written.

**Client impact.** A new reason of an existing kind, `REQUEST_TIMEOUT`, which is a kind of this server and whose reasons
are not registered in the specification.

## 7. The mock: a stop that fails still ends

**Problem.** `stopMock` removed the discovery file with `fs.rmSync` and then marked the end. When `rmSync` threw (for
example `EPERM` on Windows), the end was never marked, `whenEnded()` never resolved and the clean-up after the file did
not run; `app.quit` called `void stopMock()`, which turned the failure into an unhandled rejection.

**Fix.** The end is marked in a `finally`, and the clean-up (jobs, work files, timers) runs in another one. `stop()`
rejects with the failure, once, for whoever asks; the stop that `app.quit` starts catches it.

**Client impact.** None: the mock is a test double.

## Compatibility

| Combination              | Behaviour                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New server, any OpenTune | Nothing is sent that was not sent before; only what the server does with the answers changed.                                                                                                          |
| Old client, new server   | The structured members have the same names. Summary wording, one reason value (`ready_state_unavailable`, `not_finite`, `read_too_slow`) and the compact format of a long `edit_timing` result differ. |
| New client, old server   | A client that reads the compact format of `edit_timing` for 2 to 8 operations gets full steps from an old server, as before.                                                                           |
