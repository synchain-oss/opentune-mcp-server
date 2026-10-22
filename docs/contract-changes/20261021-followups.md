# Contract change: follow-up fixes to the wave-B tool results

- Date: 2026-10-21
- Frozen surface: `test/golden/**` (and the generated `docs/reference.md`)
- Specification: unchanged (`1.0.0-rc.4`).

## Background

A review of the wave-B tools found small gaps in the first sentence of results, in the tool annotations and in the combined summary of multi-request calls. This change fixes them; it adds no tool and no argument.

## Changes

| File                                                                                  | Change                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/golden/tools-list.json`, `docs/reference.md`                                    | `opentune_transport` is annotated `idempotentHint: false` (`play_from_last_start` seeks back every time it is called). `tools/list` stays under its size limit.                                           |
| `test/golden/track-tools/manage-ui-dismiss-refused.json`                              | The next step of `INVALID_ARGUMENT(dialog_commits_on_close)` is the single text of `src/errors/next-step.ts` (it was written twice).                                                                      |
| `test/golden/track-tools/set-tracks-duplicate.json`                                   | The revert of a track duplicate (delete the new track) now needs the user's consent: the sentence adds `confirm: true` once the user agreed, and the result marks the consent.                            |
| `test/golden/track-tools/set-tracks-reveal-and-solo.json`, `transport-seek-play.json` | In a combined summary the numbered parts no longer repeat the flags (such as "not undoable") that the first sentence already carries for all requests; `results` keeps each request's own first sentence. |
| `test/golden/arrangement/copy-duplicate-clips.json`                                   | New: a `copy` that names a clip twice copies it once.                                                                                                                                                     |
| `test/golden/arrangement/delete-irreversible-without-defect.json`                     | New: a structural edit that is IRREVERSIBLE without the undo defect of OpenTune still says in its first sentence that it cannot be undone or restored.                                                    |

## Interoperability

Clients that read the structured result see the same members. The text of a few summaries and next steps changed; the `idempotentHint` annotation of `opentune_transport` is now `false`, so a client must not retry it on its own as if it were idempotent. A revert line of a track duplicate now asks for consent before `opentune_delete_track` is called with `confirm: true`.
