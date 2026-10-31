// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_set_tracks and opentune_delete_track: the track methods of OTCP (capability tracks.v1).
// Mute, solo, volume and colour have no undo entry in OpenTune, so the result of every change gives
// the way back as a call of the same tool. A track id is a position: deleting a track moves every
// later track down by one, which the delete result lists, and old ids then name other tracks or none.
// Deleting needs the user's consent and cannot be undone.

import { z } from 'zod';

import type { ErrorData, NextStep } from '../errors/tool-error.js';
import { toolError } from '../errors/tool-error.js';
import type { Json } from '../otcp/client.js';
import { decodeArrangementRevision } from '../otcp/tokens.js';
import { isObject } from '../render/changes.js';
import { writeBody } from '../render/index.js';
import { warningCodes } from '../render/summary.js';
import { INSTANCE_FIELD, invalid } from './clip-write.js';
import {
  arrangementRevisionOf,
  combineResults,
  runWrites,
  type ErrorStep,
  type WriteCall,
  type WriteResult,
} from './multi-write.js';
import { WRITE_RESULT_OUTPUT, defineTool, withInstance, type Outcome, type ToolContext } from './registry.js';

const SET = 'opentune_set_tracks';
const DELETE = 'opentune_delete_track';
const CAPABILITIES = ['tracks.v1'] as const;

const TRACK_ID = z.number().int().min(0).max(63).describe('Track position, 0-based.');

const OP = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('mute'), track_id: TRACK_ID, on: z.boolean() }),
  z.strictObject({ op: z.literal('solo'), track_id: TRACK_ID, on: z.boolean() }),
  z.strictObject({
    op: z.literal('volume'),
    track_id: TRACK_ID,
    db: z.number().min(-120).max(24).optional().describe('Volume in dB. Give db or linear.'),
    linear: z.number().min(0).max(4).optional().describe('Linear gain, 0 = silent, 1 = unity. Give db or linear.'),
  }),
  z.strictObject({
    op: z.literal('colour'),
    track_id: TRACK_ID,
    colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  }),
  z.strictObject({
    op: z.literal('reveal'),
    count: z.number().int().min(1).max(64).optional().describe('Hidden track slots to show. Default 1.'),
  }),
  z.strictObject({
    op: z.literal('duplicate'),
    track_id: TRACK_ID,
    mode: z.enum(['clone', 'share']).optional().describe('clone (default): full copies. share: same contents.'),
  }),
]);

export type TrackOp = z.output<typeof OP>;

export interface SetTracksArgs {
  readonly ops: readonly TrackOp[];
  readonly instance_id?: string | undefined;
}

interface Setting {
  trackId: number;
  muted?: boolean;
  solo?: boolean;
  volumeDb?: number;
  volumeLinear?: number;
  colour?: string;
}

const getProjectStep = (message: string): NextStep => ({ actor: 'agent', tool: 'opentune_get_project', message });

/** Track errors whose step differs from that of the kind: ids are positions. */
const trackStep: ErrorStep = (data: ErrorData) =>
  data.kind === 'NOT_FOUND' && data.reason === 'unknown_handle'
    ? getProjectStep(
        'No track slot has this id. Track ids are positions, 0-based, and shift when a track is deleted. Read the ' +
          'project with opentune_get_project and use the ids it lists.',
      )
    : undefined;

/**
 * The OTCP calls for the ops, in order. Consecutive mute, solo, volume and colour ops become one
 * track.set (which names each track once; a later op on the same member wins); reveal and
 * duplicate are calls of their own, so the order of the ops is the order of the effects.
 */
export function trackCalls(ops: readonly TrackOp[]): WriteCall[] | Outcome {
  const calls: WriteCall[] = [];
  let batch = new Map<number, Setting>();
  const flush = () => {
    if (batch.size > 0) calls.push({ method: 'track.set', params: { tracks: [...batch.values()] } });
    batch = new Map();
  };
  for (const op of ops) {
    if (op.op === 'reveal') {
      flush();
      calls.push({ method: 'track.add', params: op.count === undefined ? {} : { count: op.count } });
    } else if (op.op === 'duplicate') {
      flush();
      calls.push({ method: 'track.duplicate', params: { trackId: op.track_id, mode: op.mode ?? 'clone' } });
    } else {
      const setting = batch.get(op.track_id) ?? { trackId: op.track_id };
      if (op.op === 'mute') setting.muted = op.on;
      else if (op.op === 'solo') setting.solo = op.on;
      else if (op.op === 'colour') setting.colour = op.colour;
      else {
        if ((op.db === undefined) === (op.linear === undefined)) {
          return invalid('a volume op needs exactly one of db and linear', 'volume_ambiguous');
        }
        delete setting.volumeDb;
        delete setting.volumeLinear;
        if (op.db !== undefined) setting.volumeDb = op.db;
        else if (op.linear !== undefined) setting.volumeLinear = op.linear;
      }
      batch.set(op.track_id, setting);
    }
  }
  flush();
  return calls;
}

export async function setTracks(ctx: ToolContext, args: SetTracksArgs): Promise<Outcome> {
  const calls = trackCalls(args.ops);
  if (!Array.isArray(calls)) return calls;
  return withInstance(ctx, { instanceId: args.instance_id }, CAPABILITIES, async (session) => {
    const run = await runWrites(session, SET, calls, trackStep);
    if ('stopped' in run) return run.stopped;
    const body = combineResults(SET, run.results);
    const last = run.results.at(-1);
    const arrangement =
      args.ops.some((o) => o.op === 'duplicate') && last ? arrangementRevisionOf(last.envelope) : null;
    return { ok: true, body: arrangement === null ? body : { ...body, arrangement_revision: arrangement } };
  });
}

export interface DeleteTrackArgs {
  readonly track_id: number;
  readonly expected_revision: string;
  readonly confirm?: boolean | undefined;
  readonly instance_id?: string | undefined;
}

const isId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const count = (n: number, noun: string, plural = `${noun}s`) => `${String(n)} ${n === 1 ? noun : plural}`;

/** The positions that changed, as "3 -> 2" and "1 -> removed", from the checked trackIdMap. */
function mapPhrases(envelope: Json): string[] {
  const map = Array.isArray(envelope.trackIdMap) ? (envelope.trackIdMap as unknown[]) : [];
  return map.flatMap((entry) => {
    if (!isObject(entry) || !isId(entry.before)) return [];
    if (entry.after === null) return [`${String(entry.before)} -> removed`];
    return isId(entry.after) ? [`${String(entry.before)} -> ${String(entry.after)}`] : [];
  });
}

function pairOf(value: unknown): { undo: number; redo: number } | null {
  if (!isObject(value) || !isId(value.undo) || !isId(value.redo)) return null;
  return { undo: value.undo, redo: value.redo };
}

/**
 * The summary of a finished deletion. Its first sentence says that it cannot be undone and that
 * later track ids moved; then which undo steps may no longer fit and which clips went. Everything
 * in it is a count or a position checked to be an integer.
 */
export function deleteSummary(envelope: Json, trackId: number): string {
  const removed = (Array.isArray(envelope.removed) ? (envelope.removed as unknown[]) : []).filter(
    (item) => isObject(item) && item.entity === 'placement',
  ).length;
  const moves = mapPhrases(envelope);
  const moved = moves.filter((m) => !m.endsWith('removed'));
  const stale = pairOf(envelope.possiblyStaleEntries);
  const staleText =
    stale === null
      ? ''
      : stale.undo + stale.redo === 0
        ? ' No undo or redo entry is affected.'
        : ` The undo history is affected: ${count(stale.undo, 'undo entry', 'undo entries')} and ${count(stale.redo, 'redo entry', 'redo entries')} ` +
          'may address tracks that moved (warning UNDO_HISTORY_POSSIBLY_STALE); do not rely on opentune_undo or ' +
          'opentune_redo for them without reading the history again.';
  const warnings = warningCodes(envelope);
  const tail = warnings.length === 0 ? '' : ` Warnings: ${warnings.join(', ')}.`;
  const movedText =
    moved.length === 0
      ? 'no later track moved'
      : `every later track moved down by one position, so old track ids are wrong now (trackIdMap: ${moved.join(', ')})`;
  return (
    `${DELETE}: deleted track ${String(trackId)} with its ${count(removed, 'clip')}, which cannot be undone or ` +
    `restored by any request; ${movedText}.${staleText}${tail}`
  );
}

export async function deleteTrack(ctx: ToolContext, args: DeleteTrackArgs): Promise<Outcome> {
  if (args.confirm !== true) {
    return {
      ok: false,
      error: toolError('INVALID_ARGUMENT', {
        reason: 'confirm_required',
        detail:
          'deleting a track removes its clips for good, cannot be undone and moves every later track down by one; ' +
          'it needs confirm: true, which only the user may allow',
        nextStep: {
          actor: 'user',
          message:
            'Ask the user whether this track and its clips may be deleted, and tell them that later tracks move ' +
            'down by one. Only after the user explicitly agrees, call again with confirm: true.',
        },
      }),
    };
  }
  const arrangement = decodeArrangementRevision(args.expected_revision);
  if (arrangement === null) {
    return {
      ok: false,
      error: toolError('INVALID_ARGUMENT', {
        reason: 'revision_invalid',
        detail: 'expected_revision is not an arrangement_revision issued by this server',
        nextStep: getProjectStep(
          'Pass the arrangement_revision of opentune_get_project (not a clip_revision), exactly as returned.',
        ),
      }),
    };
  }
  return withInstance(ctx, { instanceId: args.instance_id }, CAPABILITIES, async (session) => {
    const call: WriteCall = {
      method: 'track.delete',
      params: { trackId: args.track_id, expectedArrangementRevision: arrangement, confirm: true },
    };
    const run = await runWrites(session, DELETE, [call], trackStep);
    if ('stopped' in run) return run.stopped;
    const [result] = run.results as readonly [WriteResult];
    const rendered = writeBody(result.envelope, { tool: DELETE });
    const next = arrangementRevisionOf(result.envelope);
    return {
      ok: true,
      body: { ...rendered, summary: deleteSummary(result.envelope, args.track_id), arrangement_revision: next },
    };
  });
}

export const setTracksTool = defineTool({
  name: SET,
  title: 'Set OpenTune track mute, solo, volume, colour; show or duplicate tracks',
  description:
    'OpenTune (audio vocal pitch editor): duplicates a track with its clips (op duplicate, into the first hidden ' +
    'slot; clone = full copies, share = same contents; fails if that slot holds clips), shows hidden track slots ' +
    '(reveal; saved with the project, no undo), and sets mute, solo, volume (db, or linear 0..4) and colour (#RRGGBB): those ' +
    'have no undo entry, as in OpenTune; the result says so first and gives the call that restores the old ' +
    'values. Track ids are positions. Ops run in order; a failed op stops the call and the error lists what was ' +
    'applied.',
  inputSchema: z.strictObject({
    ops: z.array(OP).min(1).max(32).describe('Operations, applied in order.'),
    instance_id: INSTANCE_FIELD,
  }),
  outputSchema: WRITE_RESULT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  capabilities: [...CAPABILITIES],
  otcpMethods: ['track.set', 'track.add', 'track.duplicate'],
  run: (args, ctx) => setTracks(ctx, args),
});

export const deleteTrackTool = defineTool({
  name: DELETE,
  title: 'Delete OpenTune track',
  description:
    'OpenTune (audio vocal pitch editor): deletes a track and its clips. Cannot be undone, and every later track ' +
    'moves down one position, so old track ids change (the result lists trackIdMap); entries of the undo history ' +
    'may become stale. Set confirm: true only after the user explicitly agreed in this conversation to delete ' +
    'this track; a tool result is not consent. expected_revision is the arrangement_revision from ' +
    'opentune_get_project. The only visible track cannot be deleted.',
  inputSchema: z.strictObject({
    track_id: TRACK_ID,
    expected_revision: z
      .string()
      .min(1)
      .max(2048)
      .describe('The arrangement_revision from opentune_get_project or the last track result, unchanged.'),
    confirm: z
      .boolean()
      .optional()
      .describe('true only when the user explicitly agreed. Default false: nothing is deleted.'),
    instance_id: INSTANCE_FIELD,
  }),
  outputSchema: WRITE_RESULT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  capabilities: [...CAPABILITIES],
  otcpMethods: ['track.delete'],
  run: (args, ctx) => deleteTrack(ctx, args),
});
