# Contract change: the settings tools take the members of specification 1.0.0-rc.6

- Date: 2026-10-25
- Frozen surface: `test/golden/tools-list.json`, `test/golden/render/**`
- Specification: unchanged (`1.0.0-rc.6`, tag `spec-v1.0.0-rc.6`). This is the change that
  [20261025-spec-rc6.md](20261025-spec-rc6.md) left to the tools ("offering the new members in a tool is a separate change").

## Background

`prefs.set` of the specification changes the vocoder weight, the rendering priority, the pitch model and the reference
alignment mode since rc.6, and `prefs.get` lists the values it accepts (`processing.options`). `opentune_set_settings`
sent only the four earlier members, so an agent could not use them, and `opentune_get_settings` could not tell it which
weights are installed. This change gives the tools the same members, with the results the specification promises:
the previous values, the call that restores them, the warnings, and the reasons of the new failures.

## Changes

- `opentune_set_settings`, `processing`: four optional fields, in the order of the specification after the earlier
  four: `vocoder_weight` (string, 1 to 64 characters; one of the options of `opentune_get_settings`),
  `rendering_priority` (`gpuFirst` or `cpuFirst`), `f0_model` (string, 1 to 64 characters; one of the options) and
  `reference_align_mode` (`standardAuto` or `game`). The description names them and points to `options`. The tool stays
  destructive, idempotent and not read-only; its other groups are unchanged.
- `opentune_get_settings`, `processing`: a new member `options` with the values the four members accept
  (`vocoderWeight`, `f0Model`, `renderingPriority`, `referenceAlignMode`), taken from `processing.options` of
  `prefs.get`. A build that does not report it (an instance of `1.0.0-rc.5`) gives `null`, with the reason
  `not_reported` (or `capability_missing:read.v1` when the build cannot read) in `nullReasons`, as for every other
  value the tool cannot give. The description names the new values.
- Capabilities: a call of `opentune_set_settings` that names `editing_scheme`, `vocoder_weight` or `rendering_priority`
  now also needs `jobs.v1` (OpenTune applies these by a `prefsApply` job, which the tool follows). Without it the call
  is refused with `UNSUPPORTED(capability_missing)`, `detail` `jobs.v1`, before anything is sent. Before, such a build
  applied the change and the following of the job then failed (documented in `docs/COMPATIBILITY.md`, now rewritten).
- Results: the revert line restores the four new members as well (a value outside the input schema is left out, as
  before). The sentence that explains the re-render after a new vocoder weight depends on one read of `session.info`
  made before the call, by a call that names `vocoder_weight` and by no other: when the vocoder was ready and not
  loading, the job waits for the new weight, and when it ends normally the clips render again with it; otherwise (the
  vocoder was not ready, the job did not end normally, the read fails) the render happens only after the weight has
  loaded, and not at all if it cannot be loaded. Nothing read after the call decides it, because right after a change
  the vocoder can still report ready. The wording is used for the side effect `reRenderQueued` in the side-effects
  clause of the summary and in its own line; the warning `EXPERIMENTAL_FEATURE` keeps its existing line. The first
  sentence of a result is chosen by the same rules as before, except that the first sentence of a result whose job
  outlives the wait names only what the members of the call bring: the notes of `editing_scheme`, the render of
  `vocoder_weight`, the load of `rendering_priority`.
- Next steps: `INVALID_ARGUMENT(option_unavailable)` (read `processing.options`, call again with one of the values;
  nothing was changed), `MODEL_UNAVAILABLE(vocoder_not_ready)` (retryable; OpenTune took its changes back) and
  `MODEL_UNAVAILABLE(vocoder_load_failed)` (not retryable; tell the user). The retryable flags follow the registry as
  before.
- Names that OpenTune sends (weight files, models) stay JSON string values and are never placed in a summary sentence.

## Files

| File                                                                                                                                                                 | Change                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `test/golden/tools-list.json`                                                                                                                                        | `opentune_set_settings` (four fields, description), `opentune_get_settings` (description).                         |
| `test/golden/render/settings-vocoder-weight-loaded.json`, `settings-vocoder-weight-after-load.json`                                                                  | New: a new weight with the clips rendering again now, and after the weight has loaded.                             |
| `test/golden/render/settings-rendering-priority.json`, `settings-pitch-model-reference-align.json`                                                                   | New: a new rendering priority (no re-render), a no-op pitch model with a new reference alignment mode.             |
| `docs/reference.md`, `mcpb/manifest.json`                                                                                                                            | Regenerated from the catalog (`npm run catalog:update`).                                                           |
| `docs/COMPATIBILITY.md`, `docs/TROUBLESHOOTING.md`, `docs/TROUBLESHOOTING.zh-CN.md`, `docs/real-opentune-testing.md`, `README.md`, `README.zh-CN.md`, `CHANGELOG.md` | The fields and the `jobs.v1` rule; the three reasons; the steps of the real-machine scenarios.                     |
| `test/e2e/wave-b-tour.ts`, `test/e2e/effects.ts`                                                                                                                     | The tour switches each new member and puts it back; the effects scenario renders one correction under two weights. |

## Sizes

The limits are 4096 bytes for one tool and 65536 bytes for the whole list (compact JSON of `tools/list`).

| Measure                 | Before | After | Limit |
| ----------------------- | ------ | ----- | ----- |
| `opentune_set_settings` | 3329   | 3927  | 4096  |
| `opentune_get_settings` | 1442   | 1499  | 4096  |
| all tools               | 61709  | 62364 | 65536 |

## Compatibility

- Clients: the catalog only grows. Tool names are unchanged; `opentune_set_settings` gains optional input fields and
  `opentune_get_settings` gains a member in `processing`, which a client that does not know it ignores. A call that
  worked before works as before, except one that names `editing_scheme` against a build that reports `prefs.write`
  but not `jobs.v1`: it is refused now instead of being applied and then failing to follow the job.
- Servers: a test build of `1.0.0-rc.5` rejects the four new members as unknown parameters with
  `INVALID_ARGUMENT(invalid_params)` and changes nothing, and its `prefs.get` has no `processing.options`, which the
  tool reports as `options: null` (`docs/COMPATIBILITY.md`). The tools decide by capabilities, not by version.
- The mock already implements the contract (`20261025-spec-rc6.md`); the tests run against it, with its fault hooks
  `setVocoderFault` for the wait limit and the failed load.

## Tests

Unit tests for the tool (every member, the order in `changes`, the job and its wording, `option_unavailable` with
nothing changed, `vocoder_not_ready`, `vocoder_load_failed`, the refusal without `jobs.v1`), the renderer and the
revert line, the next steps, `options` in `opentune_get_settings`; the token canary scenario sends the new fields; the
real-machine scenarios have a stand-in with the new behaviour and the ways it can go wrong (the revert recipe does not
bring the first weight back, the first weight cannot be put back, the two weights sound alike, one weight installed,
no `processing.options`).
