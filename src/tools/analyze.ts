// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_analyze_pitch: how far the detected pitch of a clip's notes is from their target pitch.
// The notes come from OpenTune (content.getNotes; content.segmentNotes when the clip has no stored
// notes yet), the detected pitch from content.getPitchCurve; the statistics are computed here
// (src/analysis/pitch.ts). Three levels of detail: summary (small, the default), phrases and notes
// (both paged). One result stays within OUTPUT_BUDGET characters: a page that would be larger
// gets fewer entries, never cut ones, and next_cursor continues exactly where the page ends.

import { z } from 'zod';

import {
  DEFAULT_THRESHOLD_CENTS,
  MAX_THRESHOLD_CENTS,
  PHRASE_GAP_SEC,
  groupPhrases,
  measureNotes,
  summarize,
  type NoteSpan,
  type NoteStat,
  type PhraseStat,
  type PitchFrames,
} from '../analysis/pitch.js';
import { toolError } from '../errors/tool-error.js';
import type { Json, OtcpSession } from '../otcp/client.js';
import { clipRevisionFrom } from '../otcp/tokens.js';
import { serializeResult } from '../sanitize/untrusted.js';
import { OUTPUT_BUDGET, geometryOf } from './notes.js';
import { defineTool, withInstance, type Body, type Outcome, type ToolContext } from './registry.js';

const READ_TIMEOUT_MS = 15_000;
const NOTE_PAGE = 200;
const CURVE_PAGE = 10_000;
/** Upper bounds on what one call reads: 10,000 notes and 1,000,000 frames (about 2.7 hours at 10 ms). */
const MAX_NOTE_PAGES = 50;
const MAX_CURVE_PAGES = 100;
/** Entries of a paged detail level: default and largest page. */
export const DEFAULT_ENTRY_LIMIT = 50;
export const MAX_ENTRY_LIMIT = 200;
/** Flagged note indexes listed in the summary. */
const MAX_FLAGGED_LISTED = 100;

const CLIP_RE = /^[pc]:[0-9a-f]{8}:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/;
const CURSOR_PREFIX = 'ap1.';

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const fin = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export type Detail = 'summary' | 'phrases' | 'notes';

export interface AnalyzePitchArgs {
  readonly clip: string;
  readonly from?: number | undefined;
  readonly to?: number | undefined;
  readonly threshold_cents?: number | undefined;
  readonly detail?: Detail | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly instance_id?: string | undefined;
}

const invalid = (detail: string): Outcome => ({ ok: false, error: toolError('INVALID_ARGUMENT', { detail }) });

/** What a cursor is bound to: the same request on the same content state continues, anything else is stale. */
interface CursorState {
  readonly offset: number;
  readonly binding: string;
}

const encodeCursor = (state: CursorState): string =>
  CURSOR_PREFIX + Buffer.from(JSON.stringify([state.offset, state.binding]), 'utf8').toString('base64url');

function decodeCursor(cursor: string): CursorState | null {
  if (!cursor.startsWith(CURSOR_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [offset, binding] = parsed as unknown[];
    return Number.isInteger(offset) && (offset as number) >= 0 && typeof binding === 'string'
      ? { offset: offset as number, binding }
      : null;
  } catch {
    return null;
  }
}

/** The notes of the clip as OTCP reports them, all pages. */
async function readNotes(session: OtcpSession, base: Json, range: Json | null) {
  const notes: NoteSpan[] = [];
  let first: Json | null = null;
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < MAX_NOTE_PAGES; page += 1) {
    const result = await session.call(
      'content.getNotes',
      { ...base, ...(range === null ? {} : { range }), ...(cursor === undefined ? {} : { cursor }), limit: NOTE_PAGE },
      READ_TIMEOUT_MS,
    );
    first ??= result;
    for (const note of Array.isArray(result.notes) ? result.notes : []) {
      if (!isObject(note)) continue;
      if (fin(note.startContentSec) && fin(note.endContentSec) && fin(note.targetMidi)) {
        notes.push({
          index: fin(note.index) ? note.index : null,
          startContentSec: note.startContentSec,
          endContentSec: note.endContentSec,
          targetMidi: note.targetMidi,
        });
      }
    }
    if (typeof result.nextCursor !== 'string') {
      complete = true;
      break;
    }
    cursor = result.nextCursor;
  }
  return { notes, first: first ?? {}, complete };
}

/** The detected pitch of [startContentSec, endContentSec], all pages joined into one frame array. */
async function readCurve(session: OtcpSession, contentId: string, startContentSec: number, endContentSec: number) {
  const midi: (number | null)[] = [];
  let first: Json | null = null;
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < MAX_CURVE_PAGES; page += 1) {
    const result = await session.call(
      'content.getPitchCurve',
      {
        contentId,
        range: { startContentSec, endContentSec },
        stepFrame: 1,
        ...(cursor === undefined ? {} : { cursor }),
        limit: CURVE_PAGE,
      },
      READ_TIMEOUT_MS,
    );
    first ??= result;
    for (const value of Array.isArray(result.originalMidi) ? result.originalMidi : []) {
      midi.push(fin(value) ? value : null);
    }
    if (typeof result.nextCursor !== 'string') {
      complete = true;
      break;
    }
    cursor = result.nextCursor;
  }
  const head = first ?? {};
  const frames: PitchFrames = {
    startContentSec: fin(head.startContentSec) ? head.startContentSec : startContentSec,
    frameSec: fin(head.hopSec) && fin(head.stepFrame) ? head.hopSec * head.stepFrame : 0,
    midi,
  };
  return { frames, first: head, complete };
}

const noteEntry = (stat: NoteStat): Json => ({
  index: stat.index,
  startContentSec: stat.startContentSec,
  endContentSec: stat.endContentSec,
  targetMidi: stat.targetMidi,
  medianDeviationCents: stat.medianDeviationCents,
  stabilityCents: stat.stabilityCents,
  onsetDeviationCents: stat.onsetDeviationCents,
  releaseDeviationCents: stat.releaseDeviationCents,
  voicedFrameCount: stat.voicedFrameCount,
  overThreshold: stat.overThreshold,
});

const phraseEntry = (phrase: PhraseStat): Json => ({ ...phrase });

/** Takes entries from `offset` while the built body fits the budget; returns the body and the entries shown. */
function fitPage(
  entries: readonly Json[],
  offset: number,
  requested: number,
  build: (page: readonly Json[], more: boolean) => Body,
): { body: Body; shown: number } | null {
  let size = Math.min(requested, Math.max(0, entries.length - offset));
  for (;;) {
    const page = entries.slice(offset, offset + size);
    const body = build(page, offset + size < entries.length);
    if (serializeResult(body).length <= OUTPUT_BUDGET) return { body, shown: size };
    if (size <= 1) return null;
    size = Math.max(1, Math.min(size - 1, Math.floor(size * 0.8)));
  }
}

const nullable = (value: number | null, unit: string): string => (value === null ? 'n/a' : `${String(value)} ${unit}`);

export async function analyzePitch(ctx: ToolContext, args: AnalyzePitchArgs): Promise<Outcome> {
  if ((args.from === undefined) !== (args.to === undefined)) {
    return invalid('from and to go together: pass both, or neither to analyze all notes of the clip');
  }
  if (args.from !== undefined && args.to !== undefined && args.to < args.from) {
    return invalid('to must not be smaller than from');
  }
  const detail: Detail = args.detail ?? 'summary';
  const threshold = args.threshold_cents ?? DEFAULT_THRESHOLD_CENTS;
  const limit = Math.min(args.limit ?? DEFAULT_ENTRY_LIMIT, MAX_ENTRY_LIMIT);
  const cursor = args.cursor === undefined ? null : decodeCursor(args.cursor);
  if (args.cursor !== undefined) {
    if (detail === 'summary') return invalid('cursor applies to detail phrases and notes only');
    if (cursor === null) return invalid('cursor was not issued by this tool; pass next_cursor back unchanged');
  }
  const range: Json | null =
    args.from === undefined || args.to === undefined ? null : { startContentSec: args.from, endContentSec: args.to };

  return withInstance(ctx, { instanceId: args.instance_id }, ['read.v1'], async (session) => {
    const geometry = args.clip.startsWith('p:') ? await geometryOf(session, args.clip) : null;
    const base: Json = args.clip.startsWith('p:') ? { placementId: args.clip } : { contentId: args.clip };
    const read = await readNotes(session, base, range);
    const contentId = typeof read.first.contentId === 'string' ? read.first.contentId : null;
    if (contentId === null) {
      return {
        ok: false,
        error: toolError('INTERNAL', { detail: 'the instance returned no content id for the clip' }),
      };
    }
    const asOf = isObject(read.first.asOf) ? read.first.asOf : {};
    const content = (Array.isArray(asOf.contents) ? asOf.contents : []).find(
      (c): c is Json => isObject(c) && c.contentId === contentId,
    );
    const sameArrangement =
      geometry !== null && geometry.arrangement !== null && geometry.arrangement === asOf.arrangementRevision;
    const revision = clipRevisionFrom(content, sameArrangement ? geometry.hash : null);
    const warnings: string[] = [];
    const reasons: Json = {};
    if (revision === null) reasons.clip_revision = 'unavailable';
    if (!read.complete) warnings.push(`only the first ${String(read.notes.length)} notes were analyzed`);

    let source: 'stored_notes' | 'detected_segments' = 'stored_notes';
    let spans = read.notes;
    let f0State: string | null = null;
    let tuningHz: unknown = read.first.tuningHz ?? null;
    if (spans.length === 0) {
      // No stored notes: the segmentation OpenTune would make is the next best set of notes.
      const segmented = await session.call(
        'content.segmentNotes',
        { contentId, ...(range === null ? {} : { range }) },
        READ_TIMEOUT_MS,
      );
      f0State = typeof segmented.f0State === 'string' ? segmented.f0State : null;
      tuningHz = segmented.tuningHz ?? tuningHz;
      source = 'detected_segments';
      spans = [];
      for (const segment of Array.isArray(segmented.segments) ? segmented.segments : []) {
        if (
          isObject(segment) &&
          fin(segment.startContentSec) &&
          fin(segment.endContentSec) &&
          fin(segment.detectedMidi)
        ) {
          spans.push({
            index: null,
            startContentSec: segment.startContentSec,
            endContentSec: segment.endContentSec,
            targetMidi: Math.round(segment.detectedMidi),
          });
        }
      }
    }

    let stats: NoteStat[] = [];
    if (spans.length > 0) {
      const start = Math.min(...spans.map((s) => s.startContentSec));
      const end = Math.max(...spans.map((s) => s.endContentSec));
      const curve = await readCurve(session, contentId, start, end);
      f0State = typeof curve.first.f0State === 'string' ? curve.first.f0State : f0State;
      tuningHz = curve.first.tuningHz ?? tuningHz;
      if (!curve.complete) warnings.push('the pitch curve was cut at the read limit; later notes are not measured');
      const curveContent = (
        Array.isArray(isObject(curve.first.asOf) ? curve.first.asOf.contents : null)
          ? ((curve.first.asOf as Json).contents as unknown[])
          : []
      ).find((c): c is Json => isObject(c) && c.contentId === contentId);
      if (isObject(content) && isObject(curveContent) && content.revision !== curveContent.revision) {
        return {
          ok: false,
          error: toolError('REVISION_CONFLICT', {
            reason: 'changed_during_read',
            detail: 'the clip changed while its notes and pitch curve were read',
            retryable: true,
          }),
        };
      }
      stats = f0State === 'ready' ? measureNotes(spans, curve.frames, threshold) : [];
    }

    const ready = f0State === null || f0State === 'ready';
    if (!ready) reasons.statistics = `pitch_analysis_${String(f0State)}`;
    const overall = summarize(stats);
    const phrases = groupPhrases(stats);
    const binding = JSON.stringify([
      detail,
      threshold,
      args.from ?? null,
      args.to ?? null,
      isObject(content) ? (content.revision ?? null) : null,
    ]);
    let offset = 0;
    if (cursor !== null) {
      if (cursor.binding !== binding) {
        return {
          ok: false,
          error: toolError('REVISION_CONFLICT', {
            reason: 'cursor_stale',
            detail: 'the clip or the request changed since the cursor was issued',
            nextStep: {
              actor: 'agent',
              tool: 'opentune_analyze_pitch',
              message: 'Call opentune_analyze_pitch again without cursor to read the first page of the current state.',
            },
          }),
        };
      }
      offset = cursor.offset;
    }

    const flagged = stats.flatMap((s) => (s.overThreshold && s.index !== null ? [s.index] : []));
    const head = (page: string): Body => ({
      summary: page,
      contentId,
      placementId: read.first.placementId ?? null,
      clip_revision: revision,
      tuningHz,
      f0State,
      note_source: source,
      threshold_cents: threshold,
      range,
      detail,
    });
    const sourceNote =
      source === 'detected_segments'
        ? ' The clip has no stored notes, so OpenTune segmentation of the detected pitch was used with the nearest semitone as target; these notes have no index.'
        : '';
    const tail: Json = {
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(Object.keys(reasons).length > 0 ? { nullReasons: reasons } : {}),
    };

    if (!ready || stats.length === 0) {
      const why = !ready
        ? `The pitch analysis of this clip is not ready (state ${String(f0State)}); no statistics yet.`
        : 'No notes to analyze in this clip or range.';
      return {
        ok: true,
        body: {
          ...head(why + sourceNote),
          overall: summarize([]),
          phrase_count: 0,
          flagged_note_indexes: [],
          ...tail,
        },
      };
    }

    const unit = 'cents; positive = detected pitch above the target';
    if (detail === 'summary') {
      const worst = overall.worstNotes.map(noteEntry);
      const shownFlagged = flagged.slice(0, MAX_FLAGGED_LISTED);
      return {
        ok: true,
        body: {
          ...head(
            `Analyzed ${String(overall.measuredNoteCount)} of ${String(overall.noteCount)} notes in ${String(phrases.length)} phrases: ` +
              `mean absolute deviation ${nullable(overall.meanAbsDeviationCents, 'cents')}, ` +
              `${String(overall.overThresholdCount)} beyond ${String(threshold)} cents (${unit}).` +
              sourceNote,
          ),
          overall,
          phrase_count: phrases.length,
          phrase_gap_sec: PHRASE_GAP_SEC,
          worst_notes: worst,
          flagged_note_indexes: shownFlagged,
          ...(flagged.length > shownFlagged.length ? { flagged_note_indexes_truncated: true } : {}),
          ...tail,
        },
      };
    }

    const entries = (detail === 'phrases' ? phrases.map(phraseEntry) : stats.map(noteEntry)) as readonly Json[];
    const noun = detail === 'phrases' ? 'phrases' : 'notes';
    const paged = fitPage(entries, offset, limit, (page, more) => {
      const last = offset + page.length;
      return {
        ...head(
          `Returned ${noun} ${String(page.length === 0 ? 0 : offset)} to ${String(Math.max(0, last - 1))} of ${String(entries.length)} (${unit}).` +
            (more ? ' More follow: pass next_cursor as cursor to read the next page.' : '') +
            sourceNote,
        ),
        total_count: entries.length,
        [noun]: page,
        next_cursor: more ? encodeCursor({ offset: last, binding }) : null,
        ...tail,
      };
    });
    if (paged === null) {
      return {
        ok: false,
        error: toolError('INTERNAL', {
          reason: 'output_too_large',
          detail: `a page of one entry exceeds the ${String(OUTPUT_BUDGET)} character output budget`,
        }),
      };
    }
    const body =
      paged.shown < Math.min(limit, entries.length - offset)
        ? {
            ...paged.body,
            summary: `${paged.body.summary} The page was limited to ${String(paged.shown)} entries to keep the result small.`,
            page_limit_applied: paged.shown,
          }
        : paged.body;
    return { ok: true, body };
  });
}

export const analyzePitchTool = defineTool({
  name: 'opentune_analyze_pitch',
  title: 'Analyze OpenTune pitch',
  description:
    'OpenTune (audio vocal pitch editor): measures how far the detected pitch of a clip is from its notes, in ' +
    'cents (detected minus target, positive = sharp). Per note: median deviation, stability (standard deviation), ' +
    'onset and release deviation; notes beyond threshold_cents (default 25) are flagged; notes are grouped into ' +
    'phrases at silences over 0.4 s. detail summary (default, small) gives totals, worst notes and flagged note ' +
    'indexes for opentune_edit_notes plus clip_revision; phrases and notes are paged. from and to are seconds ' +
    'of the source audio. Read-only.',
  inputSchema: z.strictObject({
    clip: z
      .string()
      .regex(CLIP_RE)
      .describe('Clip placement id (p:...) from opentune_get_project, or a content id (c:...).'),
    from: z
      .number()
      .min(0)
      .optional()
      .describe('Range start in seconds of the source audio (content clock). Give both from and to.'),
    to: z.number().min(0).optional().describe('Range end in seconds of the source audio. Notes overlapping the range.'),
    threshold_cents: z
      .number()
      .min(1)
      .max(MAX_THRESHOLD_CENTS)
      .optional()
      .describe('A note is flagged when its median deviation is larger than this many cents. Default 25.'),
    detail: z
      .enum(['summary', 'phrases', 'notes'])
      .optional()
      .describe('summary (default): totals and worst notes. phrases: one entry per phrase. notes: one per note.'),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('next_cursor of the previous page (phrases and notes only), passed back unchanged.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_ENTRY_LIMIT)
      .optional()
      .describe('Entries per page for phrases and notes, 1 to 200. Default 50; fewer when the page would be large.'),
    instance_id: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional()
      .describe('OpenTune instance (32 hex digits, from opentune_get_status). Optional when one instance runs.'),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  capabilities: ['read.v1'],
  otcpMethods: ['content.getNotes', 'content.getPitchCurve', 'content.segmentNotes', 'project.get'],
  run: (args, ctx) => analyzePitch(ctx, args),
});
