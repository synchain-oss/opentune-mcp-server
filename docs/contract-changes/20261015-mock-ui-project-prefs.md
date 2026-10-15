# Contract change: mock reports "no track active" at start

## Background

The mock now implements the UI bridge, the project file methods, preferences, the audio device and reference
alignment. The specification (`spec/otcp/v1/vectors/README.md`, "Preconditions") says an instance that has just started
has "no track active". Vectors such as `ui/get-state-ok` and `ui/set-selection-clip` check that: the generic UI snapshot
of a write result has `activeTrackId: null` until something is selected. The mock reported track 0 before, so the
snapshot of every write result in the golden files carried `"activeTrackId": 0`.

The OTCP specification, the tool catalog and the MCP instructions are not changed. Only the value that the mock puts in
the golden snapshots changes.

## Files

| File                            | Change                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `test/golden/render/*.json`     | `ui.activeTrackId` is `null` instead of `0` in the 10 snapshots that show the snapshot. No other line changes. |
| `test/golden/edit-tools/*.json` | The same one-line change in the 10 snapshots that show the snapshot.                                           |

## Compatibility

Nothing a client sends or receives from a real OpenTune changes: `activeTrackId` was already nullable in the schema
(`common.schema.json#/$defs/uiSnapshot`). Tools render the field the same way for any value. The mock was wrong to
report an active track before anything was selected, and a golden file that shows it records that mistake.
