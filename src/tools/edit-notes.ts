// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_edit_notes: edits of existing notes, as the piano roll does, in one undo step. Notes are
// chosen by index, by a content-clock time range, all at once, or by a condition (the sung pitch is
// more than N cents from the note's target); a condition is resolved here, by reading the notes at
// the revision the caller holds, into the indexes OTCP takes. Notes are never added or removed.

import { z } from 'zod';

import { toolError } from '../errors/tool-error.js';
import type { Json, OtcpSession } from '../otcp/client.js';
import { expectedParams, type Aspect, type ClipTokens } from '../otcp/tokens.js';
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
import { WRITE_RESULT_OUTPUT, defineTool, withInstance, type Outcome, type ToolContext } from './registry.js';

const TOOL = 'opentune_edit_notes';
/** Most indexes OTCP takes in one selection. */
const MAX_INDICES = 1000;
const PAGE = 200;
/** Pages read to resolve a condition; 20 pages cover 4000 notes. */
const MAX_PAGES = 20;

export type Select =
  | { readonly indices: readonly number[] }
  | { readonly from_sec: number; readonly to_sec: number }
  | { readonly all: true }
  | {
      readonly off_target_cents_over: number;
      readonly from_sec?: number | undefined;
      readonly to_sec?: number | undefined;
    };

export type NoteOp =
  | { readonly op: 'setTargetPitch'; readonly select: Select; readonly target_midi: number }
  | { readonly op: 'shiftCents'; readonly select: Select; readonly delta_cents: number }
  | { readonly op: 'snapToScale'; readonly select: Select; readonly scale: 'clip' | KeyArg }
  | {
      readonly op: 'setParams';
      readonly select: Select;
      readonly retune_speed?: number | undefined;
      readonly vibrato_depth?: number | undefined;
      readonly vibrato_rate_hz?: number | undefined;
      readonly pitch_drift_scale?: number | undefined;
    };

export interface EditNotesArgs {
  readonly clip: string;
  readonly expected_revision: string;
  readonly ops: readonly NoteOp[];
  readonly dry_run?: boolean | undefined;
  readonly instance_id?: string | undefined;
}

interface NoteFacts {
  readonly index: number;
  readonly detectedMidi: number | null;
  readonly targetMidi: number | null;
}

/** The notes of a content, with the content revision they were read at; null revision when unknown. */
async function readNotes(
  session: OtcpSession,
  contentId: string,
  range: Json | null,
): Promise<{ notes: NoteFacts[]; revision: string | null } | Outcome> {
  const notes: NoteFacts[] = [];
  let revision: string | null = null;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await session.call(
      'content.getNotes',
      { contentId, limit: PAGE, ...(range === null ? {} : { range }), ...(cursor === undefined ? {} : { cursor }) },
      READ_TIMEOUT_MS,
    );
    const asOf = isObject(result.asOf) ? result.asOf : {};
    const content = (Array.isArray(asOf.contents) ? asOf.contents : []).find(
      (c): c is Json => isObject(c) && c.contentId === contentId,
    );
    const seen = typeof content?.revision === 'string' ? content.revision : null;
    if (revision !== null && seen !== revision) {
      return {
        ok: false,
        error: toolError('REVISION_CONFLICT', {
          reason: 'content_changed',
          detail: 'the notes changed while they were being read to resolve the selection',
        }),
      };
    }
    revision = seen;
    for (const raw of Array.isArray(result.notes) ? result.notes : []) {
      if (!isObject(raw) || typeof raw.index !== 'number') continue;
      notes.push({
        index: raw.index,
        detectedMidi: typeof raw.detectedMidi === 'number' ? raw.detectedMidi : null,
        targetMidi: typeof raw.targetMidi === 'number' ? raw.targetMidi : null,
      });
    }
    if (typeof result.nextCursor !== 'string') return { notes, revision };
    cursor = result.nextCursor;
  }
  return invalid(
    `the clip has more than ${String(MAX_PAGES * PAGE)} notes, too many to resolve a condition; select by time range`,
  );
}

/** Cents between what was sung and the note's target; null for an unvoiced note. */
export const offTargetCents = (note: NoteFacts): number | null =>
  note.detectedMidi === null || note.targetMidi === null ? null : Math.abs(note.detectedMidi - note.targetMidi) * 100;

/** The indexes a condition chooses among `notes`; the notes were read for the whole clip or the given range. */
export function indicesOverCents(notes: readonly NoteFacts[], cents: number): number[] {
  return notes.flatMap((note) => {
    const off = offTargetCents(note);
    return off !== null && off > cents ? [note.index] : [];
  });
}

const rangeOf = (from: number, to: number): Json => ({ startContentSec: from, endContentSec: to });

/** Reads the notes a condition looks at, for the whole clip or for a time range. */
type NoteSource = (range: Json | null) => Promise<NoteFacts[] | Outcome>;

/** The OTCP selection of one op, reading the notes when a condition needs them. */
async function resolveSelect(
  select: Select,
  notesFrom: NoteSource,
): Promise<{ select: Json; matched: number | null } | 'none' | Outcome> {
  if ('indices' in select) return { select: { indices: [...select.indices] }, matched: null };
  if ('all' in select) return { select: { all: true }, matched: null };
  if ('off_target_cents_over' in select) {
    if ((select.from_sec === undefined) !== (select.to_sec === undefined)) {
      return invalid('from_sec and to_sec go together');
    }
    if (select.from_sec !== undefined && select.to_sec !== undefined && select.to_sec <= select.from_sec) {
      return invalid('select: to_sec must be larger than from_sec');
    }
    const range =
      select.from_sec === undefined || select.to_sec === undefined ? null : rangeOf(select.from_sec, select.to_sec);
    const pool = await notesFrom(range);
    if (isOutcome(pool)) return pool;
    const indices = indicesOverCents(pool, select.off_target_cents_over);
    if (indices.length === 0) return 'none';
    if (indices.length > MAX_INDICES) {
      return invalid(
        `${String(indices.length)} notes match, more than the ${String(MAX_INDICES)} one selection can hold; ` +
          'narrow it with from_sec and to_sec',
      );
    }
    return { select: { indices }, matched: indices.length };
  }
  if (select.to_sec <= select.from_sec) return invalid('select: to_sec must be larger than from_sec');
  return { select: { range: rangeOf(select.from_sec, select.to_sec) }, matched: null };
}

export async function editNotes(ctx: ToolContext, args: EditNotesArgs): Promise<Outcome> {
  const tokens = revisionTokens(args.expected_revision);
  if (isOutcome(tokens)) return tokens;
  return withInstance(ctx, { instanceId: args.instance_id }, ['edit.v1', 'read.v1'], async (session) => {
    const target = await resolveContent(session, args.clip);
    if (isOutcome(target)) return target;
    return runOps(session, target.contentId, tokens, args);
  });
}

async function runOps(
  session: OtcpSession,
  contentId: string,
  tokens: ClipTokens,
  args: EditNotesArgs,
): Promise<Outcome> {
  // The indexes mean something only at the revision the caller holds; a read at another revision
  // would resolve a condition to the wrong notes.
  const notesFrom: NoteSource = async (range) => {
    const read = await readNotes(session, contentId, range);
    if (isOutcome(read)) return read;
    if (read.revision !== null && tokens.content !== null && read.revision !== tokens.content) {
      return {
        ok: false,
        error: toolError('REVISION_CONFLICT', {
          reason: 'content_changed',
          detail: 'the notes changed since the clip_revision was read, so a condition cannot be resolved to indexes',
        }),
      };
    }
    return read.notes;
  };

  const ops: Json[] = [];
  const resolved: { op: number; matched: number | null }[] = [];
  let usesClipKey = false;
  for (const [position, op] of args.ops.entries()) {
    const selection = await resolveSelect(op.select, notesFrom);
    if (selection === 'none') {
      resolved.push({ op: position, matched: 0 });
      continue;
    }
    if (isOutcome(selection)) return selection;
    if (selection.matched !== null) resolved.push({ op: position, matched: selection.matched });
    switch (op.op) {
      case 'setTargetPitch':
        ops.push({ op: op.op, select: selection.select, targetMidi: op.target_midi });
        break;
      case 'shiftCents':
        ops.push({ op: op.op, select: selection.select, deltaCents: op.delta_cents });
        break;
      case 'snapToScale':
        if (op.scale === 'clip') usesClipKey = true;
        ops.push({
          op: op.op,
          select: selection.select,
          key: op.scale === 'clip' ? 'clipKey' : { root: op.scale.root, scale: op.scale.scale },
        });
        break;
      case 'setParams': {
        const params: Json = {};
        if (op.retune_speed !== undefined) params.retuneSpeed = op.retune_speed;
        if (op.vibrato_depth !== undefined) params.vibratoDepth = op.vibrato_depth;
        if (op.vibrato_rate_hz !== undefined) params.vibratoRateHz = op.vibrato_rate_hz;
        if (op.pitch_drift_scale !== undefined) params.pitchDriftScale = op.pitch_drift_scale;
        if (Object.keys(params).length === 0) {
          return invalid(`ops[${String(position)}]: setParams needs at least one parameter to set`);
        }
        ops.push({ op: op.op, select: selection.select, ...params });
        break;
      }
    }
  }

  if (ops.length === 0) {
    return {
      ok: true,
      body: {
        summary: `${TOOL}: nothing was changed, which is a success: no note matched the selection, so no request was sent.`,
        applied: false,
        noOp: true,
        dryRun: args.dry_run === true,
        selection_resolved: resolved,
      },
    };
  }
  const depends: Aspect[] = usesClipKey ? ['content', 'key'] : ['content'];
  const params: Json = {
    contentId,
    ops,
    ...expectedParams('content.editNotes', tokens, depends),
    ...(args.dry_run === true ? { dryRun: true } : {}),
  };
  const outcome = writeOutcome(await session.call('content.editNotes', params, WRITE_TIMEOUT_MS), { tool: TOOL });
  if (!outcome.ok || resolved.length === 0) return outcome;
  return { ok: true, body: { ...outcome.body, selection_resolved: resolved } };
}

// Input -----------------------------------------------------------------------------------------

const SELECT = z.union([
  z.strictObject({ indices: z.array(z.number().int().min(0)).min(1).max(MAX_INDICES) }),
  z.strictObject({ from_sec: z.number().min(0), to_sec: z.number().min(0) }),
  z.strictObject({ all: z.literal(true) }),
  z.strictObject({
    off_target_cents_over: z.number().min(0).max(1200),
    from_sec: z.number().min(0).optional(),
    to_sec: z.number().min(0).optional(),
  }),
]);

const SELECT_DOC =
  'select = {indices:[...]} (from opentune_get_notes), {from_sec,to_sec} (source-audio seconds, overlapping), ' +
  '{all:true}, or {off_target_cents_over:N, from_sec?, to_sec?} (voiced notes whose sung pitch is more than N ' +
  'cents from their target).';

const OP = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('setTargetPitch'), select: SELECT, target_midi: z.number().min(0).max(127) }),
  z.strictObject({ op: z.literal('shiftCents'), select: SELECT, delta_cents: z.number().min(-1200).max(1200) }),
  z.strictObject({ op: z.literal('snapToScale'), select: SELECT, scale: z.union([z.literal('clip'), KEY_FIELD]) }),
  z.strictObject({
    op: z.literal('setParams'),
    select: SELECT,
    retune_speed: z.number().min(0).max(1).optional(),
    vibrato_depth: z.number().min(0).max(100).optional(),
    vibrato_rate_hz: z.number().min(3).max(12).optional(),
    pitch_drift_scale: z.number().min(-2).max(3).optional(),
  }),
]);

export const editNotesTool = defineTool({
  name: TOOL,
  title: 'Edit OpenTune notes',
  description:
    'OpenTune (audio vocal pitch editor): edits existing notes of a clip as the piano roll does; never adds or ' +
    'removes notes. ops (1-32, in order, one undo step): setTargetPitch, shiftCents, snapToScale, setParams ' +
    '(retune_speed 0..1: 0 keeps the natural pitch movement, 1 sounds mechanical; vibrato; pitch_drift_scale). ' +
    'Each op selects notes; selections refer to the notes at expected_revision. dry_run previews.',
  inputSchema: z.strictObject({
    clip: CLIP_FIELD,
    expected_revision: REVISION_FIELD,
    ops: z.array(OP).min(1).max(32).describe(`Each op has select. ${SELECT_DOC}`),
    dry_run: z.boolean().optional().describe('Predict the changes without applying them.'),
    instance_id: INSTANCE_FIELD,
  }),
  outputSchema: WRITE_RESULT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  capabilities: ['edit.v1', 'read.v1'],
  otcpMethods: ['content.editNotes', 'content.getNotes', 'project.get'],
  run: (args, ctx) => editNotes(ctx, args),
});
