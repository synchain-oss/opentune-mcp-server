// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_analyze_pitch: how far the detected pitch of a clip's notes is from their target pitch.
// The notes come from OpenTune (content.getNotes; content.segmentNotes when the clip has no stored
// notes yet), the detected pitch (before) and the corrected pitch (after the edits) from one
// content.getPitchCurve read; the statistics are computed here (src/analysis/pitch.ts). Three levels of detail: summary (small, the default), phrases and notes
// (both paged). One result stays within OUTPUT_BUDGET characters: a page that would be larger
// gets fewer entries, never cut ones, and next_cursor continues exactly where the page ends.

import { createHash } from 'node:crypto';

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

/** How much one call reads: the page size and the number of pages of each paged OTCP read. */
export interface ReadLimits {
  readonly notePage: number;
  readonly maxNotePages: number;
  readonly curvePage: number;
  readonly maxCurvePages: number;
}

/** Upper bounds on what one call reads: 10,000 notes and 1,000,000 frames (about 2.7 hours at 10 ms). */
export const READ_LIMITS: ReadLimits = { notePage: 200, maxNotePages: 50, curvePage: 10_000, maxCurvePages: 100 };
/** Entries of a paged detail level: default and largest page. */
export const DEFAULT_ENTRY_LIMIT = 50;
export const MAX_ENTRY_LIMIT = 200;
/** Flagged note indexes listed in the summary. */
const MAX_FLAGGED_LISTED = 100;

const CLIP_RE = /^[pc]:[0-9a-f]{8}:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/;
const CURSOR_PREFIX = 'ap1.';
/** f0State is a camelName (notRequested, extracting, ready, failed); any other value is reported as 'unknown'. */
const STATE_RE = /^[a-z][A-Za-z0-9]{0,63}$/;

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

/**
 * f0State as the instance reports it. It is the only OpenTune string the summary sentence quotes, so
 * a value that is not a camelName becomes 'unknown'; a missing one leaves `fallback`.
 */
const stateOf = (value: unknown, fallback: string | null): string | null =>
  typeof value === 'string' ? (STATE_RE.test(value) ? value : 'unknown') : fallback;

/** The asOf.contents[] entry of `contentId` in a read result, if the instance reports one. */
function contentTokens(result: Json, contentId: string): Json | undefined {
  const asOf = isObject(result.asOf) ? result.asOf : {};
  return (Array.isArray(asOf.contents) ? asOf.contents : []).find(
    (c): c is Json => isObject(c) && c.contentId === contentId,
  );
}

/**
 * What a cursor is bound to: the same request on the same clip in the same state continues, anything
 * else is stale. `binding` is a digest, so the cursor stays short whatever goes into it.
 */
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

/** The notes of the clip as OTCP reports them, all pages up to the read limit. */
async function readNotes(session: OtcpSession, base: Json, range: Json | null, limits: ReadLimits) {
  const notes: NoteSpan[] = [];
  let first: Json | null = null;
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < limits.maxNotePages; page += 1) {
    const result = await session.call(
      'content.getNotes',
      {
        ...base,
        ...(range === null ? {} : { range }),
        ...(cursor === undefined ? {} : { cursor }),
        limit: limits.notePage,
      },
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

/**
 * The detected and the corrected pitch of a span, all pages up to the read limit joined into one frame
 * array each. `corrected` is null when the instance sent no usable corrected curve.
 */
async function readCurve(
  session: OtcpSession,
  contentId: string,
  span: { readonly startContentSec: number; readonly endContentSec: number },
  limits: ReadLimits,
) {
  const { startContentSec, endContentSec } = span;
  const midi: (number | null)[] = [];
  const correctedMidi: (number | null)[] = [];
  let correctedPresent = true;
  let first: Json | null = null;
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < limits.maxCurvePages; page += 1) {
    const result = await session.call(
      'content.getPitchCurve',
      {
        contentId,
        range: { startContentSec, endContentSec },
        stepFrame: 1,
        ...(cursor === undefined ? {} : { cursor }),
        limit: limits.curvePage,
      },
      READ_TIMEOUT_MS,
    );
    first ??= result;
    for (const value of Array.isArray(result.originalMidi) ? result.originalMidi : []) {
      midi.push(fin(value) ? value : null);
    }
    if (Array.isArray(result.correctedMidi)) {
      for (const value of result.correctedMidi) correctedMidi.push(fin(value) ? value : null);
    } else {
      correctedPresent = false;
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
  // Both arrays describe the same frames: a corrected curve of another length cannot be paired with them.
  const usable = correctedPresent && correctedMidi.length === midi.length;
  const corrected: PitchFrames | null = usable ? { ...frames, midi: correctedMidi } : null;
  return { frames, corrected, first: head, complete };
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
  correctedMedianDeviationCents: stat.correctedMedianDeviationCents,
  correctedStabilityCents: stat.correctedStabilityCents,
  correctedOverThreshold: stat.correctedOverThreshold,
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

/** A digest of what a cursor is bound to. */
const digest = (parts: unknown): string => createHash('sha256').update(JSON.stringify(parts)).digest('base64url');

/** The reads of one call saw different content revisions: the clip was edited in between. */
const changedDuringRead = (): Outcome => ({
  ok: false,
  error: toolError('REVISION_CONFLICT', {
    reason: 'changed_during_read',
    detail: 'the clip changed while its notes and pitch curve were read',
    retryable: true,
    nextStep: { actor: 'agent', tool: 'opentune_analyze_pitch', message: 'Call opentune_analyze_pitch again.' },
  }),
});

const HYBRID_WARNING =
  'hybrid mode is on: corrections smaller than 75 cents are rendered by DSP pitch shifting, so what you hear may ' +
  'change less than the corrected data suggests';

/** The hybrid-mode preference; 'unavailable' when the instance does not report it. */
async function readHybridMode(session: OtcpSession): Promise<boolean | 'unavailable'> {
  try {
    const prefs = await session.call('prefs.get', {}, READ_TIMEOUT_MS);
    const processing = isObject(prefs.processing) ? prefs.processing : {};
    return typeof processing.hybridMode === 'boolean' ? processing.hybridMode : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** `limits` lets tests reach the read limits with small content; the tool always uses READ_LIMITS. */
export async function analyzePitch(
  ctx: ToolContext,
  args: AnalyzePitchArgs,
  limits: ReadLimits = READ_LIMITS,
): Promise<Outcome> {
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
    const read = await readNotes(session, base, range, limits);
    const contentId = typeof read.first.contentId === 'string' ? read.first.contentId : null;
    if (contentId === null) {
      return {
        ok: false,
        error: toolError('INTERNAL', { detail: 'the instance returned no content id for the clip' }),
      };
    }
    const asOf = isObject(read.first.asOf) ? read.first.asOf : {};
    const content = contentTokens(read.first, contentId);
    /** The content revision each read reported; they must all agree. */
    const seenRevisions: unknown[] = [content?.revision];
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
      f0State = stateOf(segmented.f0State, null);
      tuningHz = segmented.tuningHz ?? tuningHz;
      seenRevisions.push(contentTokens(segmented, contentId)?.revision);
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

    let frames: PitchFrames | null = null;
    let correctedFrames: PitchFrames | null = null;
    if (spans.length > 0) {
      const curve = await readCurve(
        session,
        contentId,
        {
          startContentSec: Math.min(...spans.map((s) => s.startContentSec)),
          endContentSec: Math.max(...spans.map((s) => s.endContentSec)),
        },
        limits,
      );
      f0State = stateOf(curve.first.f0State, f0State);
      tuningHz = curve.first.tuningHz ?? tuningHz;
      if (!curve.complete) warnings.push('the pitch curve was cut at the read limit; later notes are not measured');
      seenRevisions.push(contentTokens(curve.first, contentId)?.revision);
      frames = curve.frames;
      correctedFrames = curve.corrected;
    }
    // Notes, segments and curve must describe one state of the clip: every revision reported must agree.
    const reported = seenRevisions.filter((r) => r !== undefined);
    if (reported.some((r) => r !== reported[0])) return changedDuringRead();
    const stats: NoteStat[] =
      frames !== null && f0State === 'ready' ? measureNotes(spans, frames, threshold, correctedFrames) : [];
    if (stats.length > 0 && correctedFrames === null) reasons.corrected_statistics = 'corrected_curve_unavailable';
    const hybrid = stats.length > 0 && correctedFrames !== null ? await readHybridMode(session) : null;
    if (hybrid === 'unavailable') reasons.hybrid_mode = 'unavailable';
    if (hybrid === true) warnings.push(HYBRID_WARNING);

    const ready = f0State === null || f0State === 'ready';
    if (!ready) reasons.statistics = `pitch_analysis_${String(f0State)}`;
    const overall = summarize(stats);
    const phrases = groupPhrases(stats);
    const entries: readonly Json[] =
      detail === 'phrases' ? phrases.map(phraseEntry) : detail === 'notes' ? stats.map(noteEntry) : [];
    // A cursor is bound to the clip (revision tokens are opaque and two contents may report the same
    // one), the request, the content revision (the whole asOf when the instance reports none) and
    // the entries being paged, so it never continues on another clip or another state of this one.
    const revisionNow = content?.revision ?? null;
    const binding = digest([
      contentId,
      args.clip,
      detail,
      threshold,
      args.from ?? null,
      args.to ?? null,
      revisionNow,
      revisionNow === null ? asOf : null,
      entries,
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
      if (cursor.offset >= entries.length) {
        return invalid('cursor was not issued by this tool; pass next_cursor back unchanged');
      }
      offset = cursor.offset;
    }

    const flagged = stats.flatMap((s) => (s.overThreshold && s.index !== null ? [s.index] : []));
    const flaggedAfter = stats.flatMap((s) => (s.correctedOverThreshold === true && s.index !== null ? [s.index] : []));
    const head = (page: string): Body => ({
      summary: page,
      contentId,
      placementId: read.first.placementId ?? null,
      clip_revision: revision,
      tuningHz,
      f0State,
      hybrid_mode: typeof hybrid === 'boolean' ? hybrid : null,
      note_source: source,
      threshold_cents: threshold,
      range,
      detail,
    });
    const segmentsNote = (flaggedWithoutIndex: boolean): string =>
      source === 'detected_segments'
        ? ' The clip has no stored notes, so OpenTune segmentation of the detected pitch was used with the nearest semitone as target; these notes have no index' +
          (flaggedWithoutIndex ? ', so for the ones beyond the threshold use detail notes for their times.' : '.')
        : '';
    const sourceNote = segmentsNote(false);
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

    const unit =
      'cents; positive = above the target; the plain fields are before (detected pitch), the corrected* fields after (corrected pitch)';
    if (detail === 'summary') {
      const worst = overall.worstNotes.map(noteEntry);
      const shownFlagged = flagged.slice(0, MAX_FLAGGED_LISTED);
      const shownFlaggedAfter = flaggedAfter.slice(0, MAX_FLAGGED_LISTED);
      return {
        ok: true,
        body: {
          ...head(
            `Analyzed ${String(overall.measuredNoteCount)} of ${String(overall.noteCount)} notes in ${String(phrases.length)} phrases: ` +
              `mean absolute deviation ${nullable(overall.meanAbsDeviationCents, 'cents')}, ` +
              `${String(overall.overThresholdCount)} beyond ${String(threshold)} cents` +
              (overall.correctedOverThresholdCount === null
                ? ''
                : ` before, ${String(overall.correctedOverThresholdCount)} after the corrections`) +
              ` (${unit}).` +
              segmentsNote(overall.overThresholdCount > 0),
          ),
          overall,
          phrase_count: phrases.length,
          phrase_gap_sec: PHRASE_GAP_SEC,
          worst_notes: worst,
          flagged_note_indexes: shownFlagged,
          ...(flagged.length > shownFlagged.length ? { flagged_note_indexes_truncated: true } : {}),
          corrected_flagged_note_indexes: correctedFrames === null ? null : shownFlaggedAfter,
          ...(flaggedAfter.length > shownFlaggedAfter.length ? { corrected_flagged_note_indexes_truncated: true } : {}),
          ...tail,
        },
      };
    }

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
    'OpenTune (audio vocal pitch editor): measures the pitch of a clip against its notes, in cents (positive = ' +
    'sharp). Plain fields are before the corrections (detected minus target); corrected* fields are after them ' +
    '(corrected minus target). Per note: median deviation, stability, onset, release; notes beyond ' +
    'threshold_cents (default 25) are flagged, before and after. Phrases split at silences over 0.4 s. detail ' +
    'summary (default): totals, worst notes, flagged note indexes (as in opentune_get_notes), ' +
    'clip_revision; phrases and notes are paged. from and to: seconds of the source audio. Read-only.',
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
  otcpMethods: ['content.getNotes', 'content.getPitchCurve', 'content.segmentNotes', 'prefs.get', 'project.get'],
  run: (args, ctx) => analyzePitch(ctx, args),
});
