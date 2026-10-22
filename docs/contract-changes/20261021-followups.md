# Contract change: follow-up fixes to the wave-B tool results

- Date: 2026-10-21
- Frozen surface: `test/golden/**` (and the generated `docs/reference.md`)
- Specification: unchanged (`1.0.0-rc.4`).

## Background

A review of the wave-B tools found small gaps in the first sentence of results, in the tool annotations and in the combined summary of multi-request calls. This change fixes them; it adds no tool and no argument.

## Changes

| File                                                                                  | Change                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/golden/tools-list.json`, `docs/reference.md`                                    | `opentune_transport` is annotated `idempotentHint: false` (`play_from_last_start` seeks back every time it is called). `tools/list` stays under its size limit.                                                                                                                                                                                      |
| `test/golden/track-tools/manage-ui-dismiss-refused.json`                              | The next step of `INVALID_ARGUMENT(dialog_commits_on_close)` is the single text of `src/errors/next-step.ts` (it was written twice).                                                                                                                                                                                                                 |
| `test/golden/track-tools/set-tracks-duplicate.json`                                   | The revert of a track duplicate (delete the new track) now needs the user's consent: the sentence adds `confirm: true` once the user agreed, and the result marks the consent.                                                                                                                                                                       |
| `test/golden/track-tools/set-tracks-reveal-and-solo.json`, `transport-seek-play.json` | In a combined summary the numbered parts no longer repeat the flags (such as "not undoable") that the first sentence already carries for all requests; `results` keeps each request's own first sentence.                                                                                                                                            |
| `test/golden/arrangement/copy-duplicate-clips.json`                                   | New: a `copy` that names a clip twice copies it once.                                                                                                                                                                                                                                                                                                |
| `test/golden/arrangement/delete-irreversible-without-defect.json`                     | New: a structural edit that cannot be undone, without the undo defect of OpenTune, still says so in its first sentence. It says "or restored by any request" only when the result gives no way back (an IRREVERSIBLE warning, or no undo and no revert recipe); with a revert recipe it says that it cannot be undone and points to the revert line. |

## Interoperability

Clients that read the structured result see the same members. The text of a few summaries and next steps changed; the `idempotentHint` annotation of `opentune_transport` is now `false`, so a client must not retry it on its own as if it were idempotent. A revert line of a track duplicate now asks for consent before `opentune_delete_track` is called with `confirm: true`.

The error object of the tools gains an optional member `protocolMajors`: a list of positive integers. It appears only on a `PROTOCOL_MISMATCH` raised while the session is opened (the hello is refused, or its major is not served), and its value is taken from the discovery file of the instance, the same list `opentune_get_status` reports. It is never read from what an instance sends; clients that do not know the member can ignore it.

The first sentence of a structural edit and its revert line now read the revert recipe the same way, so they cannot contradict each other: a recipe that is not in the protocol's form is no way back, and the first sentence then says that no request can restore the previous state, as the revert line does. No structured member changed.

The server keeps one table of the retryability of the reasons the specification states one for (`src/errors/reason-retryable.ts`), and the test mock reads the same table. An error this server builds itself now reports the retryability the specification gives its reason, where it used to report the default of its kind: `NOT_READY/grid_not_seeded`, for instance, is not retryable now, while it was before. An error an instance reports keeps the value the instance gave it, so a client sees this only for the errors this server raises itself.
