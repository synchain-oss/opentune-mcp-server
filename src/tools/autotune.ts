// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_autotune_range: OpenTune's AUTO on a clip with an explicit mode, scale and parameters.
// The request never inherits the AUTO button's mode or the knob positions of the window: absent
// parameters take the note generator's own defaults, and the result reports what was used. All
// ranges of one call are one undo step. notesOnly replaces every note of the clip without an undo
// entry, so it runs only with replace_edited_notes true.

import { z } from 'zod';

import { toolError } from '../errors/tool-error.js';
import type { Json } from '../otcp/client.js';
import { expectedParams, type Aspect } from '../otcp/tokens.js';
import { writeOutcome } from '../render/index.js';
import {
  CLIP_FIELD,
  INSTANCE_FIELD,
  KEY_FIELD,
  READ_TIMEOUT_MS,
  REVISION_FIELD,
  WRITE_TIMEOUT_MS,
  invalid,
  isObject,
  isOutcome,
  resolveContent,
  revisionTokens,
  type KeyArg,
} from './clip-write.js';
import { WRITE_RESULT_OUTPUT, defineTool, withInstance, type Outcome } from './registry.js';

const TOOL = 'opentune_autotune_range';
const MAX_RANGES = 16;

export interface SecRange {
  readonly from_sec: number;
  readonly to_sec: number;
}

export interface AutotuneArgs {
  readonly clip: string;
  readonly expected_revision: string;
  readonly mode: 'regenerate' | 'snapNotes' | 'notesOnly' | 'reference';
  readonly ranges?: readonly SecRange[] | undefined;
  readonly exclude?: readonly SecRange[] | undefined;
  readonly scale?: 'clip' | KeyArg | undefined;
  readonly retune_speed?: number | undefined;
  readonly vibrato_depth?: number | undefined;
  readonly vibrato_rate_hz?: number | undefined;
  readonly note_split_cents?: number | undefined;
  readonly dry_run?: boolean | undefined;
  readonly replace_edited_notes?: boolean | undefined;
  readonly instance_id?: string | undefined;
}

/** The parts of [0, duration) (or of `base`) that no exclusion covers, in order. */
export function subtractRanges(base: readonly SecRange[], exclude: readonly SecRange[]): SecRange[] {
  const cuts = [...exclude].sort((a, b) => a.from_sec - b.from_sec);
  const out: SecRange[] = [];
  for (const range of base) {
    let from = range.from_sec;
    for (const cut of cuts) {
      if (cut.to_sec <= from || cut.from_sec >= range.to_sec) continue;
      if (cut.from_sec > from) out.push({ from_sec: from, to_sec: cut.from_sec });
      from = Math.max(from, cut.to_sec);
    }
    if (from < range.to_sec) out.push({ from_sec: from, to_sec: range.to_sec });
  }
  return out;
}

function checkRanges(name: string, ranges: readonly SecRange[]): Outcome | null {
  const bad = ranges.find((r) => r.to_sec <= r.from_sec);
  return bad === undefined ? null : invalid(`${name}: to_sec must be larger than from_sec`);
}

/** Argument combinations the modes do not accept, as an error naming what to remove. */
function modeProblem(args: AutotuneArgs): string | null {
  const params = [args.retune_speed, args.vibrato_depth, args.vibrato_rate_hz, args.note_split_cents];
  const hasParams = params.some((p) => p !== undefined);
  const has = (name: string, present: boolean, modes: string) =>
    present ? `${name} is not accepted by mode ${args.mode}${modes}` : null;
  switch (args.mode) {
    case 'regenerate':
      return args.scale === undefined ? 'mode regenerate needs scale (a key, or "clip" for the clip key)' : null;
    case 'snapNotes':
      return (
        (args.scale === undefined ? 'mode snapNotes needs scale (a key, or "clip" for the clip key)' : null) ??
        has(
          'retune_speed, vibrato_depth, vibrato_rate_hz and note_split_cents',
          hasParams,
          ' (it only moves note targets)',
        )
      );
    case 'notesOnly':
      return (
        has(
          'ranges and exclude',
          args.ranges !== undefined || args.exclude !== undefined,
          ' (it covers the whole clip)',
        ) ?? has('scale', args.scale !== undefined, ' (it generates notes from the detected pitch)')
      );
    case 'reference':
      return (
        has(
          'ranges, exclude, scale, the parameters and dry_run',
          args.ranges !== undefined ||
            args.exclude !== undefined ||
            args.scale !== undefined ||
            hasParams ||
            args.dry_run !== undefined,
          ' (it aligns the whole clip to its reference)',
        ) ?? (args.clip.startsWith('p:') ? null : 'mode reference needs a clip placement id (p:...), not a content id')
      );
  }
}

/** The summary with the irreversible replacement of all notes said first. */
function leadReplaces(body: Json, tool: string): Json {
  const warnings = Array.isArray(body.warnings) ? body.warnings : [];
  const replaces = warnings.some((w) => isObject(w) && w.code === 'REPLACES_ALL_NOTES');
  if (!replaces || body.dryRun === true || typeof body.summary !== 'string') return body;
  const rest = body.summary.startsWith(`${tool}: `) ? body.summary.slice(tool.length + 2) : body.summary;
  return {
    ...body,
    summary: `${tool}: all notes of the clip were replaced (REPLACES_ALL_NOTES) and this cannot be undone; ${rest}`,
  };
}

export async function autotune(ctx: Parameters<typeof withInstance>[0], args: AutotuneArgs): Promise<Outcome> {
  const problem = modeProblem(args);
  if (problem !== null) return invalid(problem);
  for (const [name, list] of [
    ['ranges', args.ranges],
    ['exclude', args.exclude],
  ] as const) {
    const bad = list === undefined ? null : checkRanges(name, list);
    if (bad !== null) return bad;
  }
  if (args.mode === 'notesOnly' && args.dry_run !== true && args.replace_edited_notes !== true) {
    return {
      ok: false,
      error: toolError('INVALID_ARGUMENT', {
        reason: 'confirm_required',
        detail:
          'mode notesOnly replaces every note of the clip, including notes edited by hand, and cannot be undone; ' +
          'replace_edited_notes was not true',
        nextStep: {
          actor: 'user',
          message:
            'Tell the user that notesOnly replaces all notes of the clip and cannot be undone. Only after the user ' +
            'explicitly agrees, call again with replace_edited_notes: true. dry_run: true previews it safely.',
        },
      }),
    };
  }
  const tokens = revisionTokens(args.expected_revision);
  if (isOutcome(tokens)) return tokens;

  return withInstance(ctx, { instanceId: args.instance_id }, ['edit.v1', 'read.v1'], async (session) => {
    if (args.mode === 'reference' && !session.hello.capabilities.includes('reference.v1')) {
      return {
        ok: false,
        error: toolError('UNSUPPORTED', {
          reason: 'capability_missing',
          detail: 'mode reference needs the capability reference.v1, which this OpenTune build does not report',
          nextStep: {
            actor: 'user',
            message:
              'This OpenTune build cannot align a clip to its reference. Tell the user; the other modes ' +
              '(regenerate, snapNotes) still work, or the user can update OpenTune.',
          },
        }),
      };
    }
    const target = await resolveContent(session, args.clip);
    if (isOutcome(target)) return target;

    const params: Json = { contentId: target.contentId, mode: args.mode };
    const depends: Aspect[] = ['content'];
    if (args.mode === 'reference') {
      params.placementId = target.placementId;
    } else {
      if (args.dry_run === true) params.dryRun = true;
      if (args.mode !== 'notesOnly') {
        if (args.scale === 'clip') {
          params.key = 'clipKey';
          depends.push('key');
        } else if (args.scale !== undefined) {
          params.key = { root: args.scale.root, scale: args.scale.scale };
        }
        if (args.ranges !== undefined || args.exclude !== undefined) {
          let base: SecRange[] = args.ranges === undefined ? [] : [...args.ranges];
          if (args.ranges === undefined) {
            const details = await session.call('content.getDetails', { contentId: target.contentId }, READ_TIMEOUT_MS);
            if (typeof details.durationSec !== 'number') {
              return invalid('the length of the clip is not known, so exclude cannot be applied; give ranges');
            }
            base = [{ from_sec: 0, to_sec: details.durationSec }];
          }
          const ranges = args.exclude === undefined ? base : subtractRanges(base, args.exclude);
          if (ranges.length === 0)
            return invalid('exclude covers all of the requested ranges: nothing is left to tune');
          if (ranges.length > MAX_RANGES) {
            return invalid(
              `the ranges left after exclude are ${String(ranges.length)}, more than the ${String(MAX_RANGES)} one call can take; ` +
                'tune in several calls or exclude less',
            );
          }
          params.ranges = ranges.map((r) => ({ startContentSec: r.from_sec, endContentSec: r.to_sec }));
        }
      }
      if (args.mode === 'regenerate' || args.mode === 'notesOnly') {
        const given: Json = {};
        if (args.retune_speed !== undefined) given.retuneSpeed = args.retune_speed;
        if (args.vibrato_depth !== undefined) given.vibratoDepth = args.vibrato_depth;
        if (args.vibrato_rate_hz !== undefined) given.vibratoRateHz = args.vibrato_rate_hz;
        if (args.note_split_cents !== undefined) given.noteSplitCents = args.note_split_cents;
        if (Object.keys(given).length > 0) params.params = given;
      }
    }
    Object.assign(params, expectedParams('content.autoTune', tokens, depends));

    const outcome = writeOutcome(await session.call('content.autoTune', params, WRITE_TIMEOUT_MS), { tool: TOOL });
    return outcome.ok ? { ok: true, body: leadReplaces(outcome.body, TOOL) as typeof outcome.body } : outcome;
  });
}

const RANGE = z.strictObject({
  from_sec: z.number().min(0),
  to_sec: z.number().min(0),
});

export const autotuneTool = defineTool({
  name: TOOL,
  title: 'Auto-tune a range of an OpenTune clip',
  description:
    'OpenTune (audio vocal pitch editor): runs AUTO on a clip with an explicit mode. regenerate rebuilds notes in ' +
    'ranges from the sung pitch, snapped to scale; snapNotes moves existing note targets to scale; notesOnly ' +
    'replaces ALL notes, cannot be undone, needs replace_edited_notes true; reference aligns to the reference clip ' +
    '(needs reference.v1). Ranges: source-audio seconds, default whole clip, max 16, one undo step. Unset ' +
    'parameters use generator defaults, not window knobs. retune_speed 0..1: 0 keeps natural movement, 1 sounds mechanical.',
  inputSchema: z.strictObject({
    clip: CLIP_FIELD,
    expected_revision: REVISION_FIELD,
    mode: z.enum(['regenerate', 'snapNotes', 'notesOnly', 'reference']),
    ranges: z.array(RANGE).min(1).max(MAX_RANGES).optional().describe('Source-audio seconds. Default: whole clip.'),
    exclude: z.array(RANGE).min(1).max(MAX_RANGES).optional().describe('Source-audio seconds left untouched.'),
    scale: z
      .union([z.literal('clip'), KEY_FIELD])
      .optional()
      .describe('Key to snap to, or "clip" for the clip key. Needed by regenerate and snapNotes.'),
    retune_speed: z.number().min(0).max(1).optional().describe('0 keeps natural pitch movement, 1 is mechanical.'),
    vibrato_depth: z.number().min(0).max(100).optional().describe('Added vibrato; 100 is plus or minus a semitone.'),
    vibrato_rate_hz: z.number().min(3).max(12).optional(),
    note_split_cents: z.number().min(0).max(200).optional().describe('Note-split sensitivity.'),
    dry_run: z.boolean().optional().describe('Predict the changes without applying them.'),
    replace_edited_notes: z
      .boolean()
      .optional()
      .describe('Only with the explicit consent of the user: lets notesOnly replace all notes, irreversibly.'),
    instance_id: INSTANCE_FIELD,
  }),
  outputSchema: WRITE_RESULT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  capabilities: ['edit.v1', 'read.v1'],
  otcpMethods: ['content.autoTune', 'content.getDetails', 'project.get'],
  run: (args, ctx) => autotune(ctx, args),
});
