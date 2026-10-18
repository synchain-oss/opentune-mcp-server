// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_edit_arrangement: clip edits on the timeline, as OpenTune's arrangement view makes them
// (OTCP arrangement.edit and arrangement.copy, capability arrangement.v1). Times are on the timeline
// clock, in seconds. One call is one request: move, trim, gain, fade and set_reference ops run in
// order as one undo step; split, merge and delete go alone, because OpenTune cannot undo them (it
// frees objects its own undo entry needs, PROTOCOL.md section 15.4 rule 1); copy goes alone,
// because it has no undo entry at all and undoing the rest would not take it back. Only the
// arrangement_revision is forwarded, so edits of notes, keys or pitch never conflict with a clip
// edit. The whole request is checked here before anything is sent.

import { z } from 'zod';

import { OtcpError, fromOtcpError, toolError, type NextStep } from '../errors/tool-error.js';
import type { Json } from '../otcp/client.js';
import { decodeArrangementRevision, decodeClipRevision, encodeArrangementRevision } from '../otcp/tokens.js';
import { asList, isObject } from '../render/changes.js';
import { writeOutcome } from '../render/index.js';
import { table, token } from '../render/text.js';
import { INSTANCE_FIELD, WRITE_TIMEOUT_MS, invalid } from './clip-write.js';
import {
  WRITE_RESULT_OUTPUT,
  defineTool,
  withInstance,
  type Body,
  type Outcome,
  type ToolContext,
} from './registry.js';

const TOOL = 'opentune_edit_arrangement';
export const MAX_OPS = 64;

// Clip ids are checked against the placement id form in planRequest, not by a pattern in the
// schema: the pattern would repeat in every op and make tools/list much larger.
const PLACEMENT_RE = /^p:[0-9a-f]{8}:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/;
const CLIP = z.string();
const CLIPS = z.array(CLIP).min(1).max(64);
const SEC = z.number().min(0);
// A whole number, checked in planRequest: z.int() would add the safe-integer bounds to the schema.
const TRACK = z.number().min(0);

const OP = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('move'),
    clip: CLIP,
    to_track_id: TRACK.optional(),
    start_timeline_sec: SEC.optional(),
  }),
  z.strictObject({ op: z.literal('trim'), clip: CLIP, edge: z.enum(['start', 'end']), to_timeline_sec: SEC }),
  z.strictObject({ op: z.literal('gain'), clip: CLIP, gain_db: z.number() }),
  z.strictObject({ op: z.literal('fade'), clip: CLIP, fade_in_sec: SEC.optional(), fade_out_sec: SEC.optional() }),
  z.strictObject({ op: z.literal('split'), clip: CLIP, at_timeline_sec: SEC }),
  z.strictObject({ op: z.literal('merge'), leading_clip: CLIP, trailing_clip: CLIP }),
  z.strictObject({ op: z.literal('delete'), clips: CLIPS }),
  z.strictObject({
    op: z.literal('set_reference'),
    clip: CLIP,
    reference_clip: CLIP.optional().describe('An overlapping clip; leave out to unbind.'),
  }),
  z.strictObject({
    op: z.literal('copy'),
    clips: CLIPS,
    mode: z.enum(['window', 'full']).describe('window: only the shown part; full: whole content.'),
    to_track_id: TRACK,
    start_timeline_sec: SEC.describe('Start of the earliest copy.'),
  }),
]);

export type ArrangementOp = z.output<typeof OP>;

export interface EditArrangementArgs {
  readonly expected_revision: string;
  readonly ops: readonly ArrangementOp[];
  readonly dry_run?: boolean | undefined;
  readonly confirm?: boolean | undefined;
  readonly instance_id?: string | undefined;
}

/** Ops that need a call of their own. */
const STRUCTURAL = new Set(['split', 'merge', 'delete']);

interface Request {
  readonly method: 'arrangement.edit' | 'arrangement.copy';
  readonly params: Json;
}

const at = (index: number) => `ops[${String(index)}]`;

/** The OTCP op for one tool op, or the reason it is incomplete. */
function otcpOp(op: Exclude<ArrangementOp, { op: 'copy' }>, index: number): Json | string {
  switch (op.op) {
    case 'move':
      if (op.to_track_id === undefined && op.start_timeline_sec === undefined) {
        return `${at(index)}: move needs to_track_id, start_timeline_sec or both`;
      }
      return {
        op: 'move',
        placementId: op.clip,
        ...(op.to_track_id === undefined ? {} : { toTrackId: op.to_track_id }),
        ...(op.start_timeline_sec === undefined ? {} : { startTimelineSec: op.start_timeline_sec }),
      };
    case 'trim':
      return { op: 'trim', placementId: op.clip, edge: op.edge, toTimelineSec: op.to_timeline_sec };
    case 'gain':
      return { op: 'setGain', placementId: op.clip, gainDb: op.gain_db };
    case 'fade':
      if (op.fade_in_sec === undefined && op.fade_out_sec === undefined) {
        return `${at(index)}: fade needs fade_in_sec, fade_out_sec or both`;
      }
      return {
        op: 'setFade',
        placementId: op.clip,
        ...(op.fade_in_sec === undefined ? {} : { fadeInSec: op.fade_in_sec }),
        ...(op.fade_out_sec === undefined ? {} : { fadeOutSec: op.fade_out_sec }),
      };
    case 'split':
      return { op: 'split', placementId: op.clip, atTimelineSec: op.at_timeline_sec };
    case 'merge':
      return { op: 'merge', leadingPlacementId: op.leading_clip, trailingPlacementId: op.trailing_clip };
    case 'delete':
      // OTCP takes each clip once.
      return { op: 'delete', placementIds: [...new Set(op.clips)] };
    case 'set_reference':
      return { op: 'setReference', placementId: op.clip, referencePlacementId: op.reference_clip ?? null };
  }
}

const revisionStep: NextStep = {
  actor: 'agent',
  tool: 'opentune_get_project',
  message:
    'Pass the arrangement_revision exactly as opentune_get_project or the last result of opentune_edit_arrangement ' +
    'gave it (not a clip_revision), then call again.',
};

/** The clip ids an op names, with the argument that names each. */
function clipsOf(op: ArrangementOp): [string, string][] {
  switch (op.op) {
    case 'merge':
      return [
        ['leading_clip', op.leading_clip],
        ['trailing_clip', op.trailing_clip],
      ];
    case 'delete':
    case 'copy':
      return op.clips.map((clip) => ['clips', clip]);
    case 'set_reference':
      return op.reference_clip === undefined
        ? [['clip', op.clip]]
        : [
            ['clip', op.clip],
            ['reference_clip', op.reference_clip],
          ];
    default:
      return [['clip', op.clip]];
  }
}

/** Checks the whole call and builds the one OTCP request it makes. */
export function planRequest(args: EditArrangementArgs): Request | Outcome {
  const expected = decodeArrangementRevision(args.expected_revision);
  if (expected === null) {
    const clipRevision = decodeClipRevision(args.expected_revision) !== null;
    return {
      ok: false,
      error: toolError('INVALID_ARGUMENT', {
        reason: 'revision_invalid',
        detail: clipRevision
          ? 'expected_revision is a clip_revision; clip edits need the arrangement_revision of the project'
          : 'expected_revision is not an arrangement_revision issued by this server',
        nextStep: revisionStep,
      }),
    };
  }
  const { ops } = args;
  for (const [index, op] of ops.entries()) {
    if ((op.op === 'move' || op.op === 'copy') && op.to_track_id !== undefined && !Number.isInteger(op.to_track_id)) {
      return invalid(`${at(index)}.to_track_id: a track id is a whole number, the 0-based track position`);
    }
    const bad = clipsOf(op).find(([, clip]) => !PLACEMENT_RE.test(clip));
    if (bad !== undefined) {
      return invalid(
        `${at(index)}.${bad[0]}: not a clip placement id (p:...); take the placementId of the clip from ` +
          'opentune_get_project or from clip_ids of the last result',
        'invalid_clip_id',
      );
    }
  }
  const alone = ops.find((op) => op.op === 'copy' || STRUCTURAL.has(op.op));
  if (alone !== undefined && ops.length > 1) {
    return invalid(
      alone.op === 'copy'
        ? 'copy cannot be undone while the other ops are one undo step, so they cannot share a call: make two ' +
            'calls, copy alone in one and the other ops in the other, with the arrangement_revision of the first result'
        : `${alone.op} cannot be undone, so it goes in a call of its own: send it alone, after the user agreed, and ` +
            'the other ops in another call, with the arrangement_revision of the first result',
      'op_not_alone',
    );
  }
  const deletes = ops.some((op) => op.op === 'delete');
  if (args.confirm !== undefined && !deletes) {
    return invalid('confirm belongs to op delete only: leave it out', 'confirm_unexpected');
  }
  const [first] = ops;
  if (first?.op === 'copy') {
    if (args.dry_run === true) {
      return invalid(
        'copy has no preview: leave out dry_run. A copy cannot be undone, and removing the copies again is a delete, ' +
          "which needs the user's consent",
        'dry_run_unsupported',
      );
    }
    return {
      method: 'arrangement.copy',
      params: {
        sources: first.clips.map((placementId) => ({ placementId })),
        mode: first.mode,
        toTrackId: first.to_track_id,
        startTimelineSec: first.start_timeline_sec,
        expectedArrangementRevision: expected,
      },
    };
  }
  // copy goes alone (checked above), so every op here is an arrangement.edit op.
  const editOps = ops.filter((op): op is Exclude<ArrangementOp, { op: 'copy' }> => op.op !== 'copy');
  const otcpOps: Json[] = [];
  for (const [index, op] of editOps.entries()) {
    const built = otcpOp(op, index);
    if (typeof built === 'string') return invalid(built);
    otcpOps.push(built);
  }
  return {
    method: 'arrangement.edit',
    params: {
      expectedArrangementRevision: expected,
      ops: otcpOps,
      ...(args.dry_run === true ? { dryRun: true } : {}),
      ...(args.confirm === undefined ? {} : { confirm: args.confirm }),
    },
  };
}

// Errors --------------------------------------------------------------------------------------------

const agent = (message: string): NextStep => ({ actor: 'agent', message });
const reread = (message: string): NextStep => ({ actor: 'agent', tool: 'opentune_get_project', message });

/** Next steps of the errors whose right action differs from the kind's default, by `<kind>/<reason>`. */
export const ERROR_STEPS = table<NextStep>({
  'INVALID_ARGUMENT/confirm_required': {
    actor: 'user',
    message:
      'Deleting clips cannot be undone or restored, and a content no other clip shows leaves the project with them. ' +
      'Tell the user which clips would go (dry_run: true lists them); only after the user explicitly agrees, call ' +
      'again with confirm: true.',
  },
  'INVALID_ARGUMENT/split_out_of_range': agent(
    'The split position must lie strictly inside the clip on the timeline clock, and OpenTune moves it to the ' +
      'nearest analysis frame, which must not be an edge. Read the clip start and end with opentune_get_project and ' +
      'choose a position well inside.',
  ),
  'INVALID_ARGUMENT/merge_not_possible': agent(
    'Only two clips that OpenTune can join merge: on one track, the trailing clip starting where the leading one ' +
      'ends, both showing adjacent parts of one content (as a split leaves them), with equal gain. Check the clips ' +
      'with opentune_get_project; give them equal gain first with op gain if that is the difference.',
  ),
  'INVALID_ARGUMENT/trim_out_of_range': agent(
    'A trim moves an edge only within the audio of the clip content, and the start must stay before the end. Read ' +
      'the clip with opentune_get_project and choose a position inside that range.',
  ),
  'INVALID_ARGUMENT/reference_ineligible': agent(
    'A clip can refer only to another clip that overlaps it in time and does not refer back to it, directly or ' +
      'through others. Choose another clip, or remove the binding: set_reference without reference_clip.',
  ),
  'REVISION_CONFLICT/arrangement_changed': reread(
    'The clips changed since the arrangement_revision was read (in the OpenTune window or by another call). Read ' +
      'the project again with opentune_get_project, check that the ops still fit (clip ids change when clips are ' +
      'split, merged or deleted), then retry with the new arrangement_revision.',
  ),
  'NOT_FOUND/unknown_handle': reread(
    'A clip id or to_track_id names nothing: clip ids change when clips are split, merged, deleted or the project ' +
      'is opened, and track ids are positions. Read the project again with opentune_get_project.',
  ),
  'NOT_FOUND/stale_handle': reread(
    'A clip id is from before the project was opened again. Read the project with opentune_get_project for the ' +
      'current ids.',
  ),
  'NOT_READY/f0_not_ready': agent(
    'A split needs the pitch analysis of the clip, which is still running. Wait a few seconds and call again.',
  ),
});

// Result --------------------------------------------------------------------------------------------

const placementIds = (items: unknown): string[] =>
  asList(items).flatMap((item) => {
    if (!isObject(item) || item.entity !== 'placement' || !isObject(item.ref)) return [];
    const id = token(item.ref.placementId, 'placementId');
    return id === null ? [] : [id];
  });

const UPSTREAM_DEFECT = (envelope: Json): boolean =>
  (isObject(envelope.undo) && envelope.undo.reason === 'upstream_undo_defect') ||
  asList(envelope.warnings).some((w) => isObject(w) && w.code === 'UPSTREAM_UNDO_DEFECT');

/** Why a split, merge or delete cannot be undone, for the first sentence of its result. */
function structuralLead(kind: string, envelope: Json): string | null {
  if (envelope.dryRun === true) {
    const consent = kind === 'delete' ? ', and it needs confirm: true' : '';
    return (
      `applying this ${kind} cannot be undone (OpenTune cannot undo a clip split, merge or delete)${consent}, so ` +
      'apply it only after the user explicitly agreed'
    );
  }
  if (!UPSTREAM_DEFECT(envelope)) return null;
  const effect =
    kind === 'delete' ? 'undoing a delete does nothing' : `undoing a ${kind} makes its audio vanish from the timeline`;
  return (
    `this ${kind} cannot be undone: OpenTune frees objects its own undo entry needs, so ${effect}; ` +
    'opentune_undo refuses it, and the user should not undo it in the OpenTune window either. Ask the user before ' +
    'every split, merge or delete'
  );
}

const capital = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** The summary of the rendered result, with what only this tool knows put where it belongs. */
function summaryOf(generic: string, envelope: Json, kind: string): string {
  const prefix = `${TOOL}: `;
  const rest = generic.startsWith(prefix) ? generic.slice(prefix.length) : generic;
  let summary = generic;
  const lead = STRUCTURAL.has(kind) ? structuralLead(kind, envelope) : null;
  if (lead !== null) {
    const dryPrefix = 'dry run, nothing was changed; ';
    summary = rest.startsWith(dryPrefix)
      ? `${prefix}${dryPrefix}${lead}. It ${rest.slice(dryPrefix.length)}`
      : `${prefix}${lead}. ${capital(rest)}`;
  }
  const undoable = isObject(envelope.undo) && envelope.undo.undoable === true;
  if (kind === 'trim' && undoable) {
    summary += " The undo step also puts back the clip fades as they were before the trim (OpenTune's own does not).";
  }
  return summary;
}

function resultBody(rendered: Body, envelope: Json, kind: string): Body {
  const tokens = isObject(envelope.tokens) ? envelope.tokens : {};
  const raw = token(tokens.arrangementRevision, 'revision');
  const revision = raw === null ? null : encodeArrangementRevision(raw);
  const reasons: Json = { ...(isObject(rendered.nullReasons) ? rendered.nullReasons : {}) };
  if (revision === null) reasons.arrangement_revision = 'unavailable';
  return {
    ...rendered,
    summary: summaryOf(rendered.summary, envelope, kind),
    arrangement_revision: revision,
    clip_ids: { created: placementIds(envelope.created), removed: placementIds(envelope.removed) },
    ...(Object.keys(reasons).length > 0 ? { nullReasons: reasons } : {}),
  };
}

/** The op that names the call: the op of a one-op call, or trim when any op of the call is a trim. */
function callKind(ops: readonly ArrangementOp[]): string {
  const [only] = ops;
  if (ops.length === 1 && only !== undefined) return only.op;
  return ops.some((op) => op.op === 'trim') ? 'trim' : 'edit';
}

export async function editArrangement(ctx: ToolContext, args: EditArrangementArgs): Promise<Outcome> {
  const request = planRequest(args);
  if ('ok' in request) return request;
  return withInstance(ctx, { instanceId: args.instance_id }, ['arrangement.v1'], async (session) => {
    let envelope: Json;
    try {
      envelope = await session.call(request.method, request.params, WRITE_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof OtcpError)) throw error;
      const { kind, reason } = error.data;
      const step = reason === null ? undefined : ERROR_STEPS[`${kind}/${reason}`];
      return { ok: false, error: fromOtcpError(error.data, step) };
    }
    const outcome = writeOutcome(envelope, { tool: TOOL });
    if (!outcome.ok) return outcome;
    return { ok: true, body: resultBody(outcome.body, envelope, callKind(args.ops)) };
  });
}

export const editArrangementTool = defineTool({
  name: TOOL,
  title: 'Edit OpenTune clips on the timeline',
  description:
    'OpenTune (audio vocal pitch editor): edits clips on the timeline (timeline clock, seconds). move, trim, gain, ' +
    'fade, set_reference (experimental) run in order as one undo step. split, merge, delete and copy each go alone ' +
    'in a call and cannot be undone (the first three by an OpenTune defect): ask the user first; delete needs ' +
    'confirm. dry_run previews (not copy).',
  inputSchema: z.strictObject({
    expected_revision: z
      .string()
      .min(1)
      .max(512)
      .describe('arrangement_revision from opentune_get_project or the last result.'),
    ops: z.array(OP).min(1).max(MAX_OPS).describe('Clip ids: placement ids (p:...).'),
    dry_run: z.boolean().optional().describe('Predict without applying.'),
    confirm: z.boolean().optional().describe('delete only: true only after the user explicitly agreed.'),
    instance_id: INSTANCE_FIELD,
  }),
  outputSchema: WRITE_RESULT_OUTPUT,
  // Destructive: delete can be neither undone nor restored, and split and merge cannot be undone either.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  capabilities: ['arrangement.v1'],
  otcpMethods: ['arrangement.edit', 'arrangement.copy'],
  run: (args, ctx) => editArrangement(ctx, args),
});
