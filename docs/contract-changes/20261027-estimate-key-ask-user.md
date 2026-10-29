# Contract change: opentune_estimate_key asks before a clip key is replaced

## Background

In a run on a real machine, an agent was told to "analyse the tempo and the key, open the project and tune it". The
estimate of `opentune_estimate_key` was G major; the key OpenTune had found for the clip was Ab major, which has
other notes. The agent did not ask the user and replaced the key of the clip with `opentune_set_clip`. A key change
cannot be undone (only the call in its result puts the old key back), and an earlier version of the companion skill had
asked first.

Two causes:

1. **The result contradicted itself.** For this case the summary says that the estimate is the more trustworthy and to
   "offer it to the user before setting it", but `recommendation.ask_user` was `false`: `recommendation()` looked only
   at the confidence (`ask_user` was `!sure`) and never at the key of the clip.
2. **The skill.** The ground rule of `tuning-workflow` says that a clear request for a step is the agreement for it,
   and the agent took "tune it" as the agreement to change the key. Step 4 asked the user only when the estimate was
   unsure.

The OTCP specification (`spec/otcp/v1/`), the tool catalog (`test/golden/**`, `docs/reference.md`) and the MCP
instructions are not changed; no tool, argument, member or error kind is added or removed. Only the value and the text
of members that the result already has change. This record supersedes the `recommendation` row of
`20261016-estimate-key.md`.

## Files

| File                                               | Change                                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/tools/estimate-key.ts`                        | `recommendation.ask_user` and `recommendation.reason`; the summary sentences about the clip key and the closing sentence.  |
| `test/unit/estimate-key.test.ts`                   | Cases for every origin of the clip key, for the same notes, for a key that cannot be compared, for the unchanged cases.    |
| `plugins/opentune/skills/tuning-workflow/SKILL.md` | The ground rule on a request for the whole job; the comparison with the clip key in step 4; how a key change is announced. |
| `CHANGELOG.md`                                     | An entry under Unreleased, Changed.                                                                                        |

## Behaviour

`recommendation.ask_user` is `true` when one of two conditions holds:

- the scale set confidence is below 0.6 (as before), or
- the clip has a key in OpenTune that the agent must not replace without asking: `clip.same_scale_set_as_estimate` is
  `false` (its notes differ from the estimate), or `null` while the clip has a key (the two cannot be compared, because
  the scale is one this server has no name for). This holds for a key the user set (`origin: manual`), for one OpenTune
  found itself (`origin: automatic`) and for one of unknown origin, because replacing it cannot be undone, whoever
  chose it.

| Clip key and estimate                                                           | `ask_user`             | Text                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| other notes (`same_scale_set_as_estimate: false`)                               | `true`                 | `reason` gains "the clip's key in OpenTune (G major, found automatically) has other notes than this estimate: ask the user which one to use before calling opentune_set_clip". For `origin: manual` it says "keep the user's choice unless the user wants another, and ask before calling opentune_set_clip". The summary sentence is unchanged.                                                                                                                               |
| the clip has a key that cannot be compared (`same_scale_set_as_estimate: null`) | `true`                 | `reason` gains "the clip's key in OpenTune (another scale on root 1, of unknown origin) cannot be compared with this estimate (its scale is not one this server knows): ask the user ..." (the same two endings as above). The summary gains a sentence that says so and asks which one is right; it does not name the scale, which is OpenTune's word.                                                                                                                        |
| the same notes (`true`) and a sure estimate (scale set confidence 0.6 or more)  | by the confidence only | The summary gains "The clip's key in OpenTune (C major, found automatically) has the same notes as this estimate, so snapping gives the same result: leave the clip key as it is and use scale "clip" in opentune_autotune_range." When the key changes along the song (`local_keys` has several parts) it says instead "... and the clip key need not change; each part of the song still gets its own key (see local_keys)", with no `scale: "clip"`. `reason` is unchanged. |
| the same notes (`true`) and an unsure estimate                                  | `true` (confidence)    | No sentence about the clip key: the recommendation is chromatic, not the key of the clip, so `scale: "clip"` is not offered.                                                                                                                                                                                                                                                                                                                                                   |
| no clip, or a clip with no key (`clip.key` is `null`)                           | by the confidence only | Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

The closing sentence of the summary follows the case. With the same notes it is "Pass recommendation.key as scale to
opentune_autotune_range." and no longer names `opentune_set_clip`, since the clip key has these notes already. When
`ask_user` is `true` because of the clip key it is "... as scale to opentune_autotune_range, or as key to
opentune_set_clip once the user has agreed." Otherwise it is unchanged ("... as key to opentune_set_clip or as scale to
opentune_autotune_range.").

`sections[].key` is not affected: a section carries only `root` and `scale`, never `ask_user`. The key of the clip is
named in these sentences by the same function as before, so a scale word that this server does not know, or an origin
it does not know, is never repeated.

## Skill

The `tuning-workflow` skill is text only and has no golden. It now says: a request for the whole job covers only the
steps that can be undone, not replacing the key OpenTune found for a clip, which cannot be undone, so the agent asks
once. With the same notes it does not change the clip key; it tunes with `scale: "clip"` only when the estimate is sure
and the key does not change along the song (an unsure estimate: `chromatic` or ask; a changing key: each section with
its own key). With other notes, with notes that could not be compared, or with `ask_user: true` it tells the user in
one sentence which key OpenTune found and which one it estimates, with one confidence figure, and asks which to use,
unless the user has already said; without an answer it leaves the key. After a key change the first sentence of the
reply says that the key changed and cannot be undone, and says in plain words how to go back.

## Compatibility

A client that reads `recommendation.key` and ignores `ask_user` behaves as before. A client that follows `ask_user` now
asks in a case where it did not, which is the intended change. The shape of the result is the same, so existing servers,
clients and saved results stay valid; a result from an older version of this server simply has `ask_user: false` in the
cases above. The skill needs no new tool.
