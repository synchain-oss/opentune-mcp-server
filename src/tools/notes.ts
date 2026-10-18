// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_get_notes: the notes of one clip in start-time order, one page at a time. The caller
// names the clock of from / to (content or timeline); every note carries its times with the clock
// and its units in the member names, as OTCP reports them. The page cursor is OTCP's, passed
// through unchanged. One result stays within OUTPUT_BUDGET characters: when a page would be larger,
// the page size is reduced (never the notes cut), so next_cursor always continues exactly where
// the page ends.

import { z } from 'zod';

import { toolError } from '../errors/tool-error.js';
import type { Json, OtcpSession } from '../otcp/client.js';
import { clipRevisionFrom } from '../otcp/tokens.js';
import { serializeResult } from '../sanitize/untrusted.js';
import { defineTool, withInstance, type Body, type Outcome, type ToolContext } from './registry.js';

/** Largest serialized result of a read tool, in characters. */
export const OUTPUT_BUDGET = 20_000;
export const DEFAULT_NOTE_LIMIT = 100;
export const MAX_NOTE_LIMIT = 200;
const READ_TIMEOUT_MS = 15_000;

const CLIP_RE = /^[pc]:[0-9a-f]{8}:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const fin = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export interface GetNotesArgs {
  readonly clip: string;
  readonly clock: 'content' | 'timeline';
  readonly from?: number | undefined;
  readonly to?: number | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly instance_id?: string | undefined;
}

const invalid = (detail: string): Outcome => ({ ok: false, error: toolError('INVALID_ARGUMENT', { detail }) });

/** The OTCP range of the request, or an error outcome. */
function requestedRange(args: GetNotesArgs): { range: Json | null } | Outcome {
  if (args.from === undefined && args.to === undefined) return { range: null };
  if (args.from === undefined || args.to === undefined) {
    return invalid('from and to go together: pass both, or neither to read all notes of the clip');
  }
  if (args.to < args.from) return invalid('to must not be smaller than from');
  if (args.clock === 'timeline') {
    if (!args.clip.startsWith('p:')) {
      return invalid('the timeline clock needs a clip placement id (p:...); a content id (c:...) has no timeline');
    }
    return { range: { startTimelineSec: args.from, endTimelineSec: args.to } };
  }
  return { range: { startContentSec: args.from, endContentSec: args.to } };
}

/** The note view of the tool: OTCP's note without the display-only label. */
function noteView(note: unknown): unknown {
  if (!isObject(note)) return note;
  const view = { ...note };
  delete view.label;
  return view;
}

/** A placement's geometry hash with the arrangement revision of the read it came from. */
export interface Geometry {
  readonly hash: string | null;
  readonly arrangement: string | null;
}

/** The geometry hash of a placement, from a fresh project read; null members when it cannot be read. */
export async function geometryOf(session: OtcpSession, placementId: string): Promise<Geometry> {
  try {
    const project = await session.call('project.get', {}, READ_TIMEOUT_MS);
    const found = (Array.isArray(project.placements) ? project.placements : []).find(
      (p): p is Json => isObject(p) && p.placementId === placementId,
    );
    const asOf = isObject(project.asOf) ? project.asOf : {};
    return {
      hash: typeof found?.geometryHash === 'string' ? found.geometryHash : null,
      arrangement: typeof asOf.arrangementRevision === 'string' ? asOf.arrangementRevision : null,
    };
  } catch {
    return { hash: null, arrangement: null };
  }
}

export async function getNotes(ctx: ToolContext, args: GetNotesArgs): Promise<Outcome> {
  const asked = requestedRange(args);
  if ('ok' in asked) return asked;
  const requested = Math.min(args.limit ?? DEFAULT_NOTE_LIMIT, MAX_NOTE_LIMIT);
  return withInstance(ctx, { instanceId: args.instance_id }, ['read.v1'], async (session) => {
    const params = (limit: number): Json => ({
      ...(args.clip.startsWith('p:') ? { placementId: args.clip } : { contentId: args.clip }),
      ...(asked.range === null ? {} : { range: asked.range }),
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      limit,
    });

    // The geometry is read before the notes: if the arrangement changes in between, the token is
    // older than the notes, so a write using it gets REVISION_CONFLICT (the safe direction).
    const geometry = args.clip.startsWith('p:') ? await geometryOf(session, args.clip) : null;
    let limit = requested;
    let result = await session.call('content.getNotes', params(limit), READ_TIMEOUT_MS);
    const build = (page: Json): Body => {
      const notes = Array.isArray(page.notes) ? page.notes.map(noteView) : [];
      const total = fin(page.totalCount) ? page.totalCount : null;
      const indexOf = (note: unknown) => (isObject(note) && fin(note.index) ? note.index : null);
      const first = indexOf(notes[0]);
      const last = indexOf(notes[notes.length - 1]);
      const clock = args.clock;
      const more = page.nextCursor !== null && page.nextCursor !== undefined;
      const summary =
        `Returned ${String(notes.length)} of ${total === null ? 'an unknown number of' : String(total)} notes` +
        (args.from === undefined ? '' : ` in the requested ${clock}-clock range`) +
        (first === null || last === null ? '' : ` (note indexes ${String(first)} to ${String(last)})`) +
        '; note times are in seconds and each member name states its clock.' +
        (more ? ' More notes follow: pass next_cursor as cursor to read the next page.' : '');
      const asOf = isObject(page.asOf) ? page.asOf : {};
      // The geometry counts only when both reads saw the same arrangement revision.
      const sameArrangement =
        geometry !== null && geometry.arrangement !== null && geometry.arrangement === asOf.arrangementRevision;
      const geometryHash = sameArrangement ? geometry.hash : null;
      const content = (Array.isArray(asOf.contents) ? asOf.contents : []).find(
        (c): c is Json => isObject(c) && c.contentId === page.contentId,
      );
      const revision = clipRevisionFrom(content, geometryHash);
      const reasons: Json = { ...(isObject(page.nullReasons) ? page.nullReasons : {}) };
      if (revision === null) reasons.clip_revision = 'unavailable';
      else if (geometry !== null && geometryHash === null) {
        reasons.clip_revision_geometry = geometry.hash === null ? 'unavailable' : 'arrangement_changed_during_read';
      }
      return {
        summary,
        contentId: page.contentId ?? null,
        placementId: page.placementId ?? null,
        clip_revision: revision,
        tuningHz: page.tuningHz ?? null,
        totalCount: page.totalCount ?? null,
        range: asked.range,
        notes,
        next_cursor: page.nextCursor ?? null,
        derived: Array.isArray(page.derived) ? page.derived : [],
        ...(Object.keys(reasons).length > 0 ? { nullReasons: reasons } : {}),
      };
    };

    let body: Body = build(result);
    // Reduce the page size until the result fits; the same cursor keeps the pages continuous.
    for (let attempt = 0; attempt < 4 && limit > 1; attempt += 1) {
      const size = serializeResult(body).length;
      if (size <= OUTPUT_BUDGET) break;
      const shown = Array.isArray(body.notes) ? body.notes.length : 0;
      const perNote = shown > 0 ? size / shown : size;
      limit = Math.max(1, Math.min(limit - 1, Math.floor((OUTPUT_BUDGET * 0.9) / perNote)));
      result = await session.call('content.getNotes', params(limit), READ_TIMEOUT_MS);
      body = build(result);
    }
    if (serializeResult(body).length > OUTPUT_BUDGET) {
      return {
        ok: false,
        error: toolError('INTERNAL', {
          reason: 'output_too_large',
          detail: `a page of ${String(limit)} note(s) still exceeds the ${String(OUTPUT_BUDGET)} character output budget`,
          nextStep: {
            actor: 'agent',
            tool: 'opentune_get_notes',
            message:
              'Read a narrower range with from and to (and clock), or pass limit 1 with the cursor, to get smaller pages.',
          },
        }),
      };
    }
    if (limit < requested) {
      body = {
        ...body,
        summary: `${body.summary} The page was limited to ${String(limit)} notes to keep the result small.`,
        page_limit_applied: limit,
      };
    }
    return { ok: true, body };
  });
}

export const getNotesTool = defineTool({
  name: 'opentune_get_notes',
  title: 'Get OpenTune notes',
  description:
    'OpenTune (audio vocal pitch editor): lists the notes of one clip in start-time order, a page at a time (limit ' +
    'default 100, at most 200; fewer when the page would be large). Each note has its index, start and end seconds ' +
    'on the content clock (source audio) and, for a clip placement, on the timeline clock, detected and target ' +
    'MIDI pitch, offset in cents, retune speed (0 natural to 1 mechanical), vibrato and voiced / corrected flags. ' +
    'clock says which clock from and to use; timeline needs a placement id. Read-only.',
  inputSchema: z.strictObject({
    clip: z
      .string()
      .regex(CLIP_RE)
      .describe('Clip placement id (p:...) from opentune_get_project, or a content id (c:...).'),
    clock: z
      .enum(['content', 'timeline'])
      .describe(
        'Clock of from and to: content = seconds of the source audio, timeline = seconds of the arrangement ' +
          '(placement ids only). Required.',
      ),
    from: z.number().min(0).optional().describe('Range start in seconds on the given clock. Give both from and to.'),
    to: z.number().min(0).optional().describe('Range end in seconds on the given clock. Notes overlapping the range.'),
    cursor: z.string().min(1).max(512).optional().describe('next_cursor of the previous page, passed back unchanged.'),
    limit: z.number().int().min(1).max(MAX_NOTE_LIMIT).optional().describe('Notes per page, 1 to 200. Default 100.'),
    instance_id: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional()
      .describe('OpenTune instance (32 hex digits, from opentune_get_status). Optional when one instance runs.'),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  capabilities: ['read.v1'],
  otcpMethods: ['content.getNotes', 'project.get'],
  run: (args, ctx) => getNotes(ctx, args),
});
