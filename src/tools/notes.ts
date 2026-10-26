// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_get_notes: the notes of one clip in start-time order, one page at a time. The caller
// names the clock of from / to (content or timeline); every note carries its times with the clock
// and its units in the member names, as OTCP reports them. The page cursor is OTCP's, passed
// through unchanged. One result stays within OUTPUT_BUDGET characters: when a page would be larger,
// the page size is reduced (never the notes cut), so next_cursor always continues exactly where
// the page ends. With output_path the tool reads every page itself and writes all notes of the
// range to one new JSON file (the whole song for the beat-grid skill) and returns a small summary;
// the file is written only when the whole read saw one revision, and never replaces a file.

import { z } from 'zod';

import { OtcpError, fromOtcpError, toolError } from '../errors/tool-error.js';
import type { Json, OtcpSession } from '../otcp/client.js';
import { clipRevisionFrom } from '../otcp/tokens.js';
import { resolvePath, systemOf, type PathSystem } from '../paths/index.js';
import { serializeResult } from '../sanitize/untrusted.js';
import { CLIENT_TIMEOUT_MS } from './client-timeout.js';
import { FileWriteError, folderOf, realFiles, writeNewFile, type FileOps } from './notes-file.js';
import { defineTool, withInstance, type Body, type Outcome, type ToolContext } from './registry.js';

/** Largest serialized result of a read tool, in characters. */
export const OUTPUT_BUDGET = 20_000;
export const DEFAULT_NOTE_LIMIT = 100;
export const MAX_NOTE_LIMIT = 200;
/** Notes per page when the tool reads the whole range for a file: the most OTCP allows. */
export const FILE_PAGE_LIMIT = 500;
/** Most notes one file holds (a song has a few thousand); more asks for a narrower range. */
export const MAX_FILE_NOTES = 50_000;
const READ_TIMEOUT_MS = 15_000;
/** What is set aside, after the last page, for building the text of the file and writing it. */
const FILE_WRITE_ALLOWANCE_MS = 5_000;
/**
 * The time since the start of a read for a file (output_path) up to which a next page may be requested, the same
 * kind of budget as opentune_edit_timing has for its operations. The worst case after requesting a page: it takes its
 * whole READ_TIMEOUT_MS (15 s), and the file is written within FILE_WRITE_ALLOWANCE_MS (5 s), so elapsed + 15 s + 5 s
 * must stay below CLIENT_TIMEOUT_MS (60 s), which makes elapsed < 40 s. A read that is past it stops and fails
 * without writing: a file written after the client gave up is one that nobody knows about, and the retry would write
 * another one beside it.
 */
export const FILE_READ_BUDGET_MS = CLIENT_TIMEOUT_MS - READ_TIMEOUT_MS - FILE_WRITE_ALLOWANCE_MS;

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
  readonly output_path?: string | undefined;
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

/** The result body for one page of notes (or, for a file, for the merged pages of the whole read). */
function noteBody(args: GetNotesArgs, range: Json | null, geometry: Geometry | null, page: Json): Body {
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
    range,
    notes,
    next_cursor: page.nextCursor ?? null,
    derived: Array.isArray(page.derived) ? page.derived : [],
    ...(Object.keys(reasons).length > 0 ? { nullReasons: reasons } : {}),
  };
}

export async function getNotes(ctx: ToolContext, args: GetNotesArgs, files: FileOps = realFiles): Promise<Outcome> {
  const asked = requestedRange(args);
  if ('ok' in asked) return asked;
  if (args.output_path !== undefined) return notesToFile(ctx, args, asked.range, files);
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
    const build = (page: Json): Body => noteBody(args, asked.range, geometry, page);

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

/** The tokens a page was read at: when two pages differ, the read mixes two states of the clip. */
function readState(page: Json): string {
  const asOf = isObject(page.asOf) ? page.asOf : {};
  const content = (Array.isArray(asOf.contents) ? asOf.contents : []).find(
    (c): c is Json => isObject(c) && c.contentId === page.contentId,
  );
  return JSON.stringify([asOf.arrangementRevision ?? null, content ?? null, page.tuningHz ?? null]);
}

const CHANGED_STEP = {
  actor: 'agent',
  tool: 'opentune_get_notes',
  message:
    'Something edited the clip during the read (the user may be working in OpenTune). No file was written. ' +
    'Call again with the same arguments.',
} as const;

/** The error of a read for a file that used up its time: nothing was written, and the way on is a narrower range. */
const tooSlow = (read: number, total: number | null): Outcome => ({
  ok: false,
  error: toolError('REQUEST_TIMEOUT', {
    reason: 'read_too_slow',
    detail:
      `reading the notes took longer than the ${String(FILE_READ_BUDGET_MS / 1000)} seconds one call may use ` +
      `(${String(read)} of ${total === null ? 'an unknown number of' : String(total)} notes read); no file was written`,
    nextStep: {
      actor: 'agent',
      tool: 'opentune_get_notes',
      message:
        'Reading all pages took longer than a client waits for a result, so the read stopped and no file was ' +
        'written. Read a narrower range with from and to (and clock) into several files, or call again when ' +
        'OpenTune is less busy.',
    },
  }),
});

const changedWhileReading = (): Outcome => ({
  ok: false,
  error: toolError('REVISION_CONFLICT', {
    reason: 'content_changed',
    detail: 'the clip changed while its notes were being read, so no file was written',
    nextStep: CHANGED_STEP,
  }),
});

/** The error for a file that could not be written; the code of the file system is a fixed token, never free text. */
function writeFailure(error: FileWriteError): Outcome {
  if (error.kind === 'names_taken') {
    return {
      ok: false,
      error: toolError('ALREADY_EXISTS', {
        reason: 'target_exists',
        detail: 'the name asked for and its 998 numbered variants all exist; nothing was written',
        nextStep: { actor: 'agent', message: 'Choose another file name or folder and call again.' },
      }),
    };
  }
  const code = error.code !== null && /^[A-Z0-9_]{2,16}$/.test(error.code) ? ` (${error.code})` : '';
  return {
    ok: false,
    error: toolError('IO_ERROR', {
      reason: 'write_failed',
      detail: `the notes file could not be written${code}; nothing was written`,
      nextStep: {
        actor: 'user',
        message: 'The folder may be read-only, full or not allowed. Ask the user for another folder, then call again.',
      },
    }),
  };
}

const codeOf = (error: unknown): string | null => {
  const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' ? code : null;
};

/** Whether the folder of the target exists, before OpenTune is asked anything. */
async function folderProblem(target: string, system: PathSystem, files: FileOps): Promise<Outcome | null> {
  let kind: 'directory' | 'missing' | 'other';
  try {
    kind = await files.kindOf(folderOf(target, system));
  } catch (error) {
    return writeFailure(new FileWriteError('io', codeOf(error)));
  }
  if (kind === 'directory') return null;
  const missing = kind === 'missing';
  return {
    ok: false,
    error: toolError(missing ? 'NOT_FOUND' : 'INVALID_ARGUMENT', {
      reason: missing ? 'file_not_found' : 'path_not_normalized',
      detail: `the folder of output_path ${missing ? 'does not exist' : 'is not a folder'}; nothing was read or written`,
      nextStep: {
        actor: 'agent',
        message: 'Give a path in a folder that exists (the folder is never created). Ask the user for one if needed.',
      },
    }),
  };
}

/** output_path: every note of the range into one new JSON file, with a small result. */
async function notesToFile(ctx: ToolContext, args: GetNotesArgs, range: Json | null, files: FileOps): Promise<Outcome> {
  if (args.cursor !== undefined || args.limit !== undefined) {
    return invalid('output_path reads every note of the range in one call: leave out cursor and limit');
  }
  const system = systemOf(ctx.platform);
  // The client's clock starts when it sends the call: the time budget counts from here, lookups included.
  const started = ctx.now();
  const resolved = resolvePath(args.output_path ?? '', ctx, 'output_path', '.json');
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const target = resolved.path;
  const unusable = await folderProblem(target, system, files);
  if (unusable !== null) return unusable;

  return withInstance(ctx, { instanceId: args.instance_id }, ['read.v1'], async (session) => {
    const params = (cursor: string | undefined): Json => ({
      ...(args.clip.startsWith('p:') ? { placementId: args.clip } : { contentId: args.clip }),
      ...(range === null ? {} : { range }),
      ...(cursor === undefined ? {} : { cursor }),
      limit: FILE_PAGE_LIMIT,
    });
    const geometry = args.clip.startsWith('p:') ? await geometryOf(session, args.clip) : null;
    const allNotes: unknown[] = [];
    const derived = new Set<unknown>();
    let first: Json | null = null;
    let state = '';
    let cursor: string | undefined;
    let complete = false;
    try {
      // The page count is bounded by the note cap, so a server that never ends its pages cannot loop.
      for (let pages = 0; pages <= Math.ceil(MAX_FILE_NOTES / FILE_PAGE_LIMIT) + 1 && !complete; pages += 1) {
        // The first page is always read. Before a next one: could it, at its whole timeout, and the write of the file
        // after it, still end before the client gives up?
        if (pages > 0 && ctx.now() - started + READ_TIMEOUT_MS + FILE_WRITE_ALLOWANCE_MS >= CLIENT_TIMEOUT_MS) {
          return tooSlow(allNotes.length, first !== null && fin(first.totalCount) ? first.totalCount : null);
        }
        const page = await session.call('content.getNotes', params(cursor), READ_TIMEOUT_MS);
        if (first === null) {
          first = page;
          state = readState(page);
        } else if (readState(page) !== state) return changedWhileReading();
        for (const note of Array.isArray(page.notes) ? page.notes : []) allNotes.push(note);
        for (const item of Array.isArray(page.derived) ? page.derived : []) derived.add(item);
        if (allNotes.length > MAX_FILE_NOTES) {
          return {
            ok: false,
            error: toolError('INVALID_ARGUMENT', {
              reason: 'range_too_large',
              detail: `the range holds more than ${String(MAX_FILE_NOTES)} notes, more than one file takes`,
              nextStep: {
                actor: 'agent',
                tool: 'opentune_get_notes',
                message: 'Read a narrower range with from and to (and clock) into several files.',
              },
            }),
          };
        }
        if (typeof page.nextCursor === 'string') cursor = page.nextCursor;
        else complete = true;
      }
    } catch (error) {
      // OpenTune ties a cursor to the revisions of the read: a changed clip makes the next page stale.
      if (error instanceof OtcpError && error.data.kind === 'REVISION_CONFLICT') {
        return { ok: false, error: fromOtcpError(error.data, CHANGED_STEP) };
      }
      throw error;
    }
    // A file whose notes do not add up to the count OpenTune reports would pass for a complete read.
    if (first === null || !complete || (fin(first.totalCount) && first.totalCount !== allNotes.length)) {
      return {
        ok: false,
        error: toolError('INTERNAL', {
          reason: 'incomplete_read',
          detail: `the pages held ${String(allNotes.length)} notes but the read did not add up; no file was written`,
        }),
      };
    }
    // The last page may have taken the rest of the time: the file is not written once the client has given up.
    if (ctx.now() - started + FILE_WRITE_ALLOWANCE_MS >= CLIENT_TIMEOUT_MS)
      return tooSlow(allNotes.length, allNotes.length);
    const merged: Json = { ...first, notes: allNotes, nextCursor: null, derived: [...derived] };
    const body = noteBody(args, range, geometry, merged);
    const text = `${serializeResult({ ...body, clip: args.clip, clock: args.clock })}\n`;
    let written;
    try {
      written = await writeNewFile(target, text, system, files);
    } catch (error) {
      if (error instanceof FileWriteError) return writeFailure(error);
      throw error;
    }
    return {
      ok: true,
      body: {
        summary:
          `Wrote all ${String(allNotes.length)} notes of the range to a new JSON file (path in output.path); the file ` +
          'has the members of a normal result with every note in notes and next_cursor null.' +
          (written.renamed
            ? ' The name asked for was taken, so the next free name was used; nothing was overwritten.'
            : '') +
          ' Nothing in OpenTune changed.',
        output: {
          path: written.path,
          renamed: written.renamed,
          noteCount: allNotes.length,
          bytes: Buffer.byteLength(text, 'utf8'),
        },
        clock: args.clock,
        contentId: body.contentId,
        placementId: body.placementId,
        clip_revision: body.clip_revision,
        tuningHz: body.tuningHz,
        totalCount: body.totalCount,
        range,
        ...(body.nullReasons === undefined ? {} : { nullReasons: body.nullReasons }),
      },
    };
  });
}

export const getNotesTool = defineTool({
  name: 'opentune_get_notes',
  title: 'Get OpenTune notes',
  description:
    'OpenTune (audio vocal pitch editor): lists the notes of one clip in start-time order, a page at a time ' +
    '(default 100, at most 200, fewer when large). Each note has its index, start and end seconds on the content ' +
    'clock and, for a placement, the timeline clock, detected and target MIDI pitch, offset in cents, retune speed ' +
    '(0 natural to 1 mechanical), vibrato and voiced / corrected flags. clock picks the clock of from and to; ' +
    'timeline needs a placement id. output_path saves all notes of the range to a new .json file (for the ' +
    'beat-grid skill) and returns a summary. OpenTune is not changed.',
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
    output_path: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        'Absolute path of a new .json file for all notes of the range, read page by page for you; leave out cursor ' +
          'and limit. The folder must exist. Never overwrites: a taken name gets " (2)", " (3)" ...',
      ),
    instance_id: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional()
      .describe('OpenTune instance (32 hex digits, from opentune_get_status). Optional when one instance runs.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  capabilities: ['read.v1'],
  otcpMethods: ['content.getNotes', 'project.get'],
  run: (args, ctx) => getNotes(ctx, args),
});
