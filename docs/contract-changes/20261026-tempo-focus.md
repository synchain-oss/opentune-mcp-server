# Contract change: the rounding of the tempo needs the keyboard focus in the tempo field

- Date: 2026-10-26
- Frozen surface: `spec/otcp/v1/**`
- Specification version: `1.0.0-rc.7` (wire version `1.0`), a correction inside the release candidate; the tag
  `spec-v1.0.0-rc.7` is set by the maintainers after approval and is not set yet.
- Implementation lines changed with it: `mock/given.ts` and `mock/ui.ts` (the precondition and the comments),
  `test/contract/exe-given.ts` (the exe runner skips the precondition). The behaviour of the mock and the text of the
  tools do not change.

## Background

The change `20261026-tempo-rounded.md` said that every switch of the view rounds a tempo with more than one decimal,
and that every target runs the vector `ui/set-workspace-tempo-rounded`. That was checked on a started OpenTune whose
window was in the foreground. It is not true of every window.

Run against the executable that the OpenTune fork builds, on a Windows runner of the continuous integration, the vector
failed:

```
$.result.changes: expected 2 elements, got 1; $.result.sideEffects.tempoRounded: missing
```

The view was switched, but the tempo was not rounded. The cause is in OpenTune. A switch of the view moves the keyboard
focus. The tempo field of the transport bar writes the tempo it shows (one decimal) back to the project only when it
loses the focus, so only when it held the focus. A window in the foreground that has just started has the focus in that
field, so on a machine where a person runs the window every switch rounds. On the runner the window is not in the
foreground and the field holds no focus: the switch moves nothing out of it and nothing is written back. The instance
compares the tempo before and after the switch and reports a rounding only when the two differ, which is the right
thing for it to do.

So the rounding is conditional, and the vector has to say on what. This change adds that condition to the text and to
the format of the vectors, and no behaviour of OpenTune, of the mock or of the tools changes.

## The name

The precondition is `given.keyboardFocus` with the value `tempoField`: the tempo field of the transport bar holds the
keyboard focus, as in a window that has just started in the foreground.

- It is `keyboardFocus` and not `focus` because `focus` already has a meaning in this protocol: `import.start` takes a
  `focus` member, and the tool `focus_clip` selects a clip and loads it into the piano roll. `keyboardFocus` says which
  focus is meant.
- It is an enumeration with one value, like `onboarding` and `editingScheme`, so that a later version can name another
  place of the focus by adding a value (the registries only grow).
- Without the member, a vector assumes nothing about where the keyboard focus is. Only this vector depends on it.

## Changes

| File                                                                                                   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec/otcp/v1/schemas/vector.schema.json`                                                              | `given.keyboardFocus`, an enumeration with the value `tempoField`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `spec/otcp/v1/vectors/README.md`                                                                       | A row in the table of preconditions: what `tempoField` means, that a vector without the member assumes nothing about the focus, and that a runner that cannot make the field hold the focus (a started OpenTune whose window may be in the background) reports the vector as skipped with that reason.                                                                                                                                                                                                                                      |
| `spec/otcp/v1/vectors/ui/set-workspace-tempo-rounded.json`                                             | `given` is `{dirty: false, keyboardFocus: tempoField}`. The description no longer says that every target runs the vector; it says on which condition the rounding happens, and that without the focus in the field a switch rounds nothing and reports nothing about the tempo. The steps and the expected results are unchanged.                                                                                                                                                                                                           |
| `spec/otcp/v1/PROTOCOL.md`                                                                             | Section 14.6: the rounding happens only while the tempo field holds the keyboard focus (for example in a window in the foreground that has just started); a window in the background may not round. The instance reports `tempoRounded` and the change of the tempo only when it happened, by comparing the tempo before and after, and a result without them says only that the tempo did not change. The row of `tempoRounded` in the table of side effects says the same in a clause, and the text names the precondition of the vector. |
| `spec/otcp/v1/methods/ui.setWorkspace.schema.json`, `spec/otcp/v1/methods/ui.setSelection.schema.json` | The sentences about the rounding say that it happens when the field holds the focus, that a window in the background may not round, and that the result reports it only when it happened. Params, result schemas and every other case are unchanged.                                                                                                                                                                                                                                                                                        |
| `spec/otcp/v1/CHANGELOG.md`                                                                            | Under 1.0.0-rc.7: the entry of `tempoRounded` is made exact (the focus, and no "every target runs"), a new "Added" entry for the vector member, and a "Changed" entry for the text of section 14.6 and the two descriptions.                                                                                                                                                                                                                                                                                                                |
| `mock/given.ts`, `mock/ui.ts`                                                                          | The mock accepts `keyboardFocus: tempoField`. Its window always holds the focus in the tempo field, so there is nothing to set and its behaviour is as it was (the default does not change, and every existing vector passes as before). The comments say so. The mock does not model a window without the focus: no vector shows that case.                                                                                                                                                                                                |
| `test/contract/exe-given.ts`, `test/contract/README.md`                                                | The exe runner cannot make the window of a started OpenTune hold the focus in the field (the machine and the window system decide whether the window is in the foreground and where the focus is), so it reports `given.keyboardFocus` as a precondition it cannot establish, with that reason.                                                                                                                                                                                                                                             |
| `test/unit/exe-given.test.ts`, `test/unit/mock-ui.test.ts`                                             | The exe runner skips the vector `ui/set-workspace-tempo-rounded` with the reason (the test loads the vector, so it fails when the vector loses its precondition); the mock accepts the precondition and rounds as before.                                                                                                                                                                                                                                                                                                                   |
| `CHANGELOG.md`                                                                                         | One entry under "Fixed", and the earlier entry no longer says that every target runs the vector.                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Checked and left unchanged: `src/` and `test/golden/` (a tool already names the rounding only when the instance sends
`tempoRounded`, and says nothing about the tempo otherwise), `docs/reference.md` and `mcpb/manifest.json` (the tool
descriptions and schemas are the same), the capability registry (no capability is added), and the write envelope schema
(a side effect has no closed list of names).

## Interoperability

- No method, param, result member, side-effect name, entity name, error kind, warning code or reason code is added or
  changed. The wire does not change. A client or a server of the earlier text keeps working: the text now says what a
  real window already did. An instance whose tempo field holds no focus has never rounded, and has never reported a
  rounding then; before this change the text could be read as saying that it should.
- A runner that does not know the member `keyboardFocus` reports the vector as skipped, as it does for any precondition
  it does not know (the runners of this repository do, and the format says that later versions add precondition
  members). So a runner of an earlier version can no longer fail this vector on a window without the focus.
- The runner of the OpenTune fork that runs the vectors without a window has to learn to establish
  `keyboardFocus: tempoField` when the maintainers sync the copy of the specification. Its simulated window holds the
  focus in the field, as a window in the foreground that has just started does, so the rounding that the vector expects
  is the behaviour it has. Until it can establish the precondition, it reports this vector as skipped there, and the
  vector still runs against the mock.
- The exe runner of this repository skips the vector on a started OpenTune, because it does not control whether the
  window is in the foreground.
- The fork's copy of the specification, pinned by hash, is synced by the maintainers.
