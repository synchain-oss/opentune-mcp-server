# Contract change: install snippets, pitch analysis after the corrections, instructions

## Background

Testing with a real OpenTune build on Windows produced three findings that touch frozen surfaces (golden snapshots and
the MCP instructions). The maintainer approved the changes.

1. `opentune-mcp doctor --client claude-code` printed `claude mcp add --env K=V opentune -- ...`. `--env` takes any
   number of values, so it swallowed the name and the command failed with `missing required argument 'name'`. In
   PowerShell, `claude` resolves to the npm-generated `claude.ps1`, which loses a lone `--`; the command then failed
   with `missing required argument 'commandOrUrl'`.
2. `opentune_analyze_pitch` compared only the detected pitch with the note targets, so it could not show the result of
   the corrections. The model in the test session therefore ran its own pitch tracker over an exported file.
3. The instructions did not say that the pitch is already analyzed.

## Files

| File                                          | Change                                                                                                                                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/golden/client-config/claude-code-*.txt` | The command is `claude mcp add opentune --scope user -e K=V -- <command>`; on Windows it starts with `claude.cmd` and a note says why. Explains `--scope user`.                                                                                     |
| `test/golden/tools-list.json`                 | `opentune_analyze_pitch`: new description (before and after columns).                                                                                                                                                                               |
| `test/golden/instructions.txt`                | One sentence added: use `opentune_analyze_pitch` for before and after rather than an external pitch tracker; to check an exported file, ask the user first, because `opentune_open_audio` adds a track to the project and renumbers the later ones. |
| `docs/reference.md`, `mcpb/manifest.json`     | Regenerated from the above.                                                                                                                                                                                                                         |

## What changed for `opentune_analyze_pitch`

The input is unchanged. The result gains fields; no existing field changed its meaning or unit. Plain fields remain the
"before" side (detected minus target); the `corrected*` fields are the "after" side (corrected minus target), read from
`correctedMidi` of the same `content.getPitchCurve` calls. Units are in the field names (cents).

- Note entries: `correctedMedianDeviationCents`, `correctedStabilityCents`, `correctedOverThreshold`.
- Phrase entries: `correctedMeanAbsDeviationCents`, `correctedOverThresholdCount`.
- `overall`: `correctedMeanAbsDeviationCents`, `correctedMeanSignedDeviationCents`, `correctedMeanStabilityCents`,
  `correctedOverThresholdCount`, `correctedOverThresholdRatio`.
- Summary: `corrected_flagged_note_indexes` (and `corrected_flagged_note_indexes_truncated`), `hybrid_mode`.
- When the instance sends no usable corrected curve, every corrected value is `null` and
  `nullReasons.corrected_statistics` is `corrected_curve_unavailable`.
- The tool reads `prefs.get` once (`processing.hybridMode`). With hybrid mode on it adds a warning: the corrected
  data describes the corrected target curve, and OpenTune's hybrid mode may make a small correction sound smaller than
  that data (the hybrid mode option in OpenTune preferences explains it). The warning names no threshold. If the
  preference cannot be read, `hybrid_mode` is `null` and `nullReasons.hybrid_mode` is `unavailable`; when there is no
  corrected data it is not read and the reason is `not_read`.
- Output budget and paging are unchanged; the summary stays small.

`prefs.get` is added to the tool's `otcpMethods`; it needs the same capability (`read.v1`).

## Compatibility

- Older clients ignore the new fields. Older servers keep working with newer clients that do not require them.
- A newer server with an instance that does not report `correctedMidi` or the preference degrades to `null` values with
  reasons, as above.
- Clients that parsed the old `claude mcp add --env ...` text must not: it was printed for people to run, and it did
  not work.
- The OTCP specification (`spec/otcp/v1/`) is not changed.
