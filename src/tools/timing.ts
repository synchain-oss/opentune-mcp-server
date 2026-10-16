// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_edit_timing: the time grid of one clip. The grid is the list of time handles of a content;
// moving a handle stretches or compresses the audio next to it. The tool seeds the grid (a job),
// shifts every handle of a range by a number of milliseconds and moves named handles to new output
// positions. OpenTune does not detect beats: where handles lie is up to the user, or to the seed.
// Only the grid part of the clip_revision is forwarded, so a change of the notes or the key does not
// conflict with a timing edit. A limited move (the minimum spacing to the neighbouring handles) is
// reported as OpenTune reports it: clamped, with the warning CLAMPED.

import { z } from 'zod';

import { OtcpError, errorDataFrom, fromOtcpError, toolError, type NextStep } from '../errors/tool-error.js';
import type { Json, OtcpSession } from '../otcp/client.js';
import { clipRevisionFrom, decodeClipRevision, expectedParams, type ClipTokens } from '../otcp/tokens.js';
import { writeOutcome } from '../render/index.js';
import { SIDE_EFFECT_TEXT } from '../render/text.js';
import { trustedToken } from '../sanitize/untrusted.js';
import {
  WRITE_RESULT_OUTPUT,
  defineTool,
  withInstance,
  type Body,
  type Outcome,
  type ToolContext,
} from './registry.js';

const TOOL = 'opentune_edit_timing';
const CLIP_RE = /^[pc]:[0-9a-f]{8}:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/;
const JOB_ID_RE = /^j:[0-9a-f]{8}:[1-9][0-9]*$/;
/** Most handles a result lists; the count of all of them is always given. */
export const MAX_LISTED_HANDLES = 200;
const WRITE_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 15_000;
/** OTCP answers a job.get wait within waitMs + 1000 ms; this side allows a little more. */
const WAIT_MARGIN_MS = 4000;
export const DEFAULT_WAIT_SECONDS = 10;
export const MAX_WAIT_SECONDS = 30;
export const MAX_OPS = 8;
/** Largest shift of one operation, the OTCP limit (deltaSec). */
export const MAX_DELTA_MS = 10_000;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const sec = z.number().min(0);

const opSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('seed') }),
  z.strictObject({
    op: z.literal('shift'),
    start_output_sec: sec.optional().describe('Range start on the output clock (after the time grid).'),
    end_output_sec: sec.optional().describe('Range end on the output clock.'),
    start_content_sec: sec.optional().describe('Range start on the content clock (source audio).'),
    end_content_sec: sec.optional().describe('Range end on the content clock.'),
    delta_ms: z
      .number()
      .min(-MAX_DELTA_MS)
      .max(MAX_DELTA_MS)
      .describe('Milliseconds to move the handles; negative = earlier.'),
  }),
  z.strictObject({
    op: z.literal('move'),
    moves: z
      .array(
        z.strictObject({
          // zod 4 counts max() in code points, as the spec's maxLength does, and listHandles counts the same way.
          handle_id: z
            .string()
            .min(1)
            .max(64)
            .describe(
              'Handle id, from time_grid_handles in the last result of this tool (a seed result has them too).',
            ),
          output_sec: sec.describe('New position on the output clock, in seconds.'),
        }),
      )
      .min(1)
      .max(64),
  }),
]);

export type TimingOp = z.output<typeof opSchema>;

export interface EditTimingArgs {
  readonly clip: string;
  readonly expected_revision?: string | undefined;
  readonly ops: readonly TimingOp[];
  readonly wait_seconds?: number | undefined;
  readonly instance_id?: string | undefined;
}

const invalid = (detail: string, reason?: string): Outcome => ({
  ok: false,
  error: toolError('INVALID_ARGUMENT', { detail, ...(reason === undefined ? {} : { reason }) }),
});

/** The OTCP range of a shift op: exactly one clock, both ends given, end after start. */
function shiftRange(op: Extract<TimingOp, { op: 'shift' }>, index: number): { range: Json } | Outcome {
  const at = `ops[${String(index)}]`;
  const output = [op.start_output_sec, op.end_output_sec];
  const content = [op.start_content_sec, op.end_content_sec];
  const usesOutput = output.some((v) => v !== undefined);
  const usesContent = content.some((v) => v !== undefined);
  if (usesOutput === usesContent) {
    return invalid(
      `${at}: give the range on one clock: start_output_sec and end_output_sec, or start_content_sec and end_content_sec`,
    );
  }
  const [start, end] = usesOutput ? output : content;
  if (start === undefined || end === undefined) return invalid(`${at}: give both the start and the end of the range`);
  if (end <= start) return invalid(`${at}: the range end must be after its start`);
  return {
    range: usesOutput ? { startOutputSec: start, endOutputSec: end } : { startContentSec: start, endContentSec: end },
  };
}

type Call =
  | { readonly kind: 'seed' }
  | { readonly kind: 'shift'; readonly range: Json; readonly deltaSec: number }
  | { readonly kind: 'move'; readonly moves: Json[] };

/** Checks the whole request before anything is sent, so a bad later op cannot follow an applied earlier one. */
function plan(args: EditTimingArgs): Call[] | Outcome {
  if (args.ops.some((op) => op.op === 'seed') && args.ops.length > 1) {
    return invalid(
      'seed runs as a job and changes the grid revision: pass it alone, then read the clip again and call with shift or move',
    );
  }
  if (args.wait_seconds !== undefined && args.ops.some((op) => op.op !== 'seed')) {
    return invalid('wait_seconds belongs to seed only: leave it out when ops has shift or move');
  }
  const calls: Call[] = [];
  for (const [index, op] of args.ops.entries()) {
    if (op.op === 'seed') calls.push({ kind: 'seed' });
    else if (op.op === 'shift') {
      const range = shiftRange(op, index);
      if (!('range' in range)) return range;
      calls.push({ kind: 'shift', range: range.range, deltaSec: op.delta_ms / 1000 });
    } else {
      const ids = op.moves.map((m) => m.handle_id);
      if (new Set(ids).size !== ids.length) {
        return invalid(`ops[${String(index)}]: a handle may appear in moves only once`, 'duplicate_handle');
      }
      calls.push({ kind: 'move', moves: op.moves.map((m) => ({ handleId: m.handle_id, outputSec: m.output_sec })) });
    }
  }
  return calls;
}

/** The content id of a clip given as a content id or a clip placement id. */
async function contentIdOf(session: OtcpSession, clip: string): Promise<string | Outcome> {
  if (clip.startsWith('c:')) return clip;
  const project = await session.call('project.get', {}, READ_TIMEOUT_MS);
  const found = (Array.isArray(project.placements) ? project.placements : []).find(
    (p): p is Json => isObject(p) && p.placementId === clip,
  );
  if (typeof found?.contentId === 'string') return found.contentId;
  return {
    ok: false,
    error: toolError('NOT_FOUND', {
      reason: 'unknown_handle',
      detail: 'no clip in the open project has this placement id',
    }),
  };
}

/** What to do about the errors of a timing edit whose right action differs from the kind's default. */
function stepFor(error: OtcpError, args: EditTimingArgs): NextStep | undefined {
  const { kind, reason } = error.data;
  if (kind === 'NOT_READY' && reason === 'grid_not_seeded') {
    return {
      actor: 'agent',
      tool: TOOL,
      args: { clip: args.clip, ops: [{ op: 'seed' }] },
      message:
        'The time grid has no handles yet. Seed it with op seed (this cannot be undone); the result lists the handles ' +
        '(time_grid_handles) and the clip_revision for the next edit.',
    };
  }
  if (kind === 'REVISION_CONFLICT' && reason === 'grid_changed') {
    return {
      actor: 'agent',
      tool: 'opentune_get_project',
      message:
        'The time grid changed since the clip_revision was read. Read the clip again with opentune_get_project for a ' +
        'fresh clip_revision, then retry. The current handles are in time_grid_handles of this error (when that is null, ' +
        'time_grid_handles_unavailable_reason says why); use them, not the handles of an earlier result.',
    };
  }
  return undefined;
}

/** The tokens a write result reports for one content. */
function contentTokens(result: Json, contentId: string): Json | undefined {
  const tokens = isObject(result.tokens) ? result.tokens : {};
  return (Array.isArray(tokens.contents) ? tokens.contents : []).find(
    (c): c is Json => isObject(c) && c.contentId === contentId,
  );
}

/** The clip_revision after a write: the tokens of the result for this content, geometry as before. */
function revisionAfter(result: Json, contentId: string, before: ClipTokens | null): string | null {
  return clipRevisionFrom(contentTokens(result, contentId), before?.geometry ?? null);
}

/** Why a listed handle has no usable id or position; fixed texts, never the value OpenTune sent. */
const NO_HANDLE_ID = 'the handle id is not a string of 1 to 64 characters';
const NO_HANDLE_POSITION = 'a position of the handle is missing or not a number';

/**
 * The handles of a content.getDetails answer. Every handle of the grid is listed, in order, so the count
 * matches the grid; a handle whose id or position does not fit the spec keeps its place with a null and
 * the reason, instead of being dropped.
 */
function listHandles(details: Json): Json[] {
  const grid = isObject(details.timeGrid) ? details.timeGrid : {};
  return (Array.isArray(grid.handles) ? grid.handles : []).map((h): Json => {
    const raw = isObject(h) ? h : {};
    const rawId = typeof raw.handleId === 'string' ? raw.handleId : null;
    // The spec counts code points (maxLength 64), so the length is taken by code point, not by UTF-16 unit.
    const length = rawId === null ? 0 : Array.from(rawId).length;
    const id = length >= 1 && length <= 64 ? rawId : null;
    const contentSec = typeof raw.contentSec === 'number' ? raw.contentSec : null;
    const outputSec = typeof raw.outputSec === 'number' ? raw.outputSec : null;
    const reason = id === null ? NO_HANDLE_ID : contentSec === null || outputSec === null ? NO_HANDLE_POSITION : null;
    return {
      handle_id: id,
      content_sec: contentSec,
      output_sec: outputSec,
      ...(reason === null ? {} : { handle_unreadable_reason: reason }),
    };
  });
}

/** The result of reading the handles: the listed fields, or the kind of the failed read. */
type HandleRead = { readonly listed: Json } | { readonly failed: string };

/**
 * The time handles of a content as content.getDetails reports them, ids and positions with the clock in
 * the field names. A failed read is reported, not thrown: the write already happened and its result must not be lost.
 */
async function handlesOf(session: OtcpSession, contentId: string): Promise<HandleRead> {
  try {
    const details = await session.call('content.getDetails', { contentId }, READ_TIMEOUT_MS);
    const all = listHandles(details);
    return {
      listed: {
        time_grid_handles: all.slice(0, MAX_LISTED_HANDLES),
        time_grid_handle_count: all.length,
        ...(all.length > MAX_LISTED_HANDLES ? { time_grid_handles_truncated: true } : {}),
      },
    };
  } catch (error) {
    if (error instanceof OtcpError) {
      return { failed: trustedToken(error.data.kind, /^[A-Z][A-Z_]{0,63}$/) ?? 'UNKNOWN' };
    }
    throw error;
  }
}

/** The handle fields of an answer: the list, or null with the reason the list could not be read. */
function handleFields(read: HandleRead, when: string): Json {
  return 'listed' in read
    ? read.listed
    : { time_grid_handles: null, time_grid_handles_unavailable_reason: `${when}: ${read.failed}` };
}

/** The outcome with the current handles of the content added to a success body. */
async function withHandles(session: OtcpSession, contentId: string, outcome: Outcome): Promise<Outcome> {
  if (!outcome.ok) return outcome;
  const read = await handlesOf(session, contentId);
  return { ok: true, body: { ...outcome.body, ...handleFields(read, 'the read after the write failed') } };
}

function rendered(result: Json, revision: string | null): Outcome {
  const outcome = writeOutcome(result, { tool: TOOL });
  if (!outcome.ok) return outcome;
  return { ok: true, body: { ...outcome.body, clip_revision: revision } };
}

/** Runs the seed job: the call answers with a job; wait for it up to wait_seconds. */
async function seed(
  session: OtcpSession,
  contentId: string,
  before: ClipTokens | null,
  waitSeconds: number,
): Promise<Outcome> {
  const started = await session.call('content.editTimeGrid', { contentId, op: 'seed' }, WRITE_TIMEOUT_MS);
  const job = isObject(started.job) ? started.job : null;
  const jobId = trustedToken(job?.jobId, JOB_ID_RE);
  // Already seeded (a no-op) or any answer that is not a job: render it as the write result it is.
  if (job === null || jobId === null) return rendered(started, revisionAfter(started, contentId, before));
  const waitMs = Math.round(waitSeconds * 1000);
  let current: Json = job;
  if (waitMs > 0) {
    try {
      const polled = await session.call('job.get', { jobId, waitMs }, waitMs + WAIT_MARGIN_MS);
      if (isObject(polled.job)) current = polled.job;
    } catch (error) {
      if (!(error instanceof OtcpError)) throw error;
      // The job was started and may be writing handles that cannot be undone: keep its id.
      const failure = fromOtcpError(error.data);
      return {
        ok: false,
        error: {
          ...failure,
          detail: `the seed job ${jobId} was started but waiting for it failed: ${failure.detail}`,
          executed: true,
          retryable: false,
          nextStep: {
            actor: 'agent',
            tool: 'opentune_get_job',
            args: { job_id: jobId },
            message:
              `The seed job ${jobId} is running or finished in OpenTune. Follow it with opentune_get_job; do not seed ` +
              'again before it has ended. When it has succeeded, read the clip_revision with opentune_get_project.',
          },
        },
        context: { jobId, job: current },
      };
    }
  }
  const state = typeof current.state === 'string' ? current.state : null;
  if (state === 'succeeded' && isObject(current.result)) {
    return rendered(current.result, revisionAfter(current.result, contentId, before));
  }
  if (state === 'failed') {
    return { ok: false, error: fromOtcpError(errorDataFrom(current.error)), context: { job: current } };
  }
  if (state === 'cancelled') {
    return {
      ok: true,
      body: {
        summary: `${TOOL}: the seed job ${jobId} was cancelled; no handles were written and the time grid is unchanged.`,
        job: current,
        clip_revision: null,
      },
    };
  }
  // Still queued or running: the write envelope of the call (it names the job) tells how to follow it.
  return rendered({ ...started, job: current }, null);
}

export async function editTiming(ctx: ToolContext, args: EditTimingArgs): Promise<Outcome> {
  const calls = plan(args);
  if (!Array.isArray(calls)) return calls;
  let tokens: ClipTokens | null = null;
  if (args.expected_revision !== undefined) {
    tokens = decodeClipRevision(args.expected_revision);
    if (tokens === null) {
      return {
        ok: false,
        error: toolError('INVALID_ARGUMENT', {
          reason: 'revision_invalid',
          detail: 'expected_revision is not a clip_revision issued by this server',
          nextStep: {
            actor: 'agent',
            tool: 'opentune_get_project',
            message:
              'Pass the clip_revision of the clip exactly as opentune_get_project or opentune_get_notes gave it.',
          },
        }),
      };
    }
  }
  if (tokens === null && calls.some((c) => c.kind !== 'seed')) {
    return invalid('shift and move need expected_revision: the clip_revision of the clip, from opentune_get_project');
  }
  const capabilities = ['timing.v1', ...(calls.some((c) => c.kind === 'seed') ? ['jobs.v1'] : []), 'read.v1'];
  return withInstance(ctx, { instanceId: args.instance_id }, capabilities, async (session) => {
    const resolved = await contentIdOf(session, args.clip);
    if (typeof resolved !== 'string') return resolved;
    const contentId = resolved;
    const steps: { body: Body; clamped: number }[] = [];
    let current = tokens;
    let last: Json = {};
    try {
      for (const call of calls) {
        if (call.kind === 'seed') {
          return await withHandles(
            session,
            contentId,
            await seed(session, contentId, current, args.wait_seconds ?? DEFAULT_WAIT_SECONDS),
          );
        }
        if (current === null) throw new Error('shift and move are planned only with a revision');
        const method = call.kind === 'shift' ? 'content.shiftTiming' : 'content.editTimeGrid';
        const grid = expectedParams(method, current, ['grid']);
        const params: Json =
          call.kind === 'shift'
            ? { contentId, ...grid, range: call.range, deltaSec: call.deltaSec }
            : { contentId, op: 'moveHandles', ...grid, moves: call.moves };
        const result = await session.call(method, params, WRITE_TIMEOUT_MS);
        const outcome = rendered(result, revisionAfter(result, contentId, current));
        if (!outcome.ok) return outcome;
        steps.push({ body: outcome.body, clamped: Array.isArray(result.clamped) ? result.clamped.length : 0 });
        last = result;
        const next = contentTokens(result, contentId)?.gridRevision;
        if (typeof next === 'string') current = { ...current, grid: next };
        else if (steps.length < calls.length) {
          return {
            ok: false,
            error: toolError('INTERNAL', {
              detail: 'OpenTune returned no grid revision, so the next operation cannot be sent safely',
              executed: true,
            }),
            context: { completed: steps.map((s) => s.body) },
          };
        }
      }
    } catch (error) {
      if (!(error instanceof OtcpError)) throw error;
      const failure = fromOtcpError(error.data, stepFor(error, args));
      const gridChanged = error.data.kind === 'REVISION_CONFLICT' && error.data.reason === 'grid_changed';
      // The grid moved under this call: the handles it reports now are the ones the next try needs.
      const currentHandles: Json = gridChanged
        ? handleFields(await handlesOf(session, contentId), 'the read of the time grid failed')
        : {};
      if (steps.length === 0) return { ok: false, error: failure, ...(gridChanged ? { context: currentHandles } : {}) };
      const applied = steps.length;
      // Earlier operations of this call took effect; the error says which one failed.
      const retry = gridChanged
        ? `retry only the operations from number ${String(applied + 1)} on.`
        : `retry only the operations from number ${String(applied + 1)} on, with the clip_revision of the last item of completed.`;
      return {
        ok: false,
        error: {
          ...failure,
          detail: `operation ${String(applied + 1)} failed after ${String(applied)} applied: ${failure.detail}`,
          executed: true,
          nextStep: {
            ...failure.nextStep,
            message: `${failure.nextStep.message} Operations 1 to ${String(applied)} are applied: ${retry}`,
          },
        },
        context: { ...currentHandles, completed: steps.map((s) => s.body) },
      };
    }
    const [only] = steps;
    if (steps.length === 1 && only !== undefined) return withHandles(session, contentId, { ok: true, body: only.body });
    return withHandles(session, contentId, {
      ok: true,
      body: {
        summary: multiSummary(steps),
        steps: steps.map((s) => s.body),
        clip_revision: revisionAfter(last, contentId, tokens),
      },
    });
  });
}

const keysOf = (value: unknown): string[] => (isObject(value) ? Object.keys(value) : []);

/** The first sentence of a several-operation result: side effects, warnings and the undo order of all steps. */
function multiSummary(steps: readonly { body: Body; clamped: number }[]): string {
  const clamped = steps.reduce((total, s) => total + s.clamped, 0);
  const effects = new Set(steps.flatMap((s) => keysOf(s.body.sideEffects)));
  const codes = new Set(
    steps.flatMap((s) =>
      (Array.isArray(s.body.warnings) ? s.body.warnings : []).flatMap((w): string[] => {
        const code = isObject(w) ? trustedToken(w.code, /^[A-Z][A-Z0-9_]{0,63}$/) : null;
        return code === null ? [] : [code];
      }),
    ),
  );
  const undoIds = steps.flatMap((s) => {
    const undo = isObject(s.body.undo) ? s.body.undo : null;
    const id = undo?.undoable === true ? trustedToken(undo.undoId, /^[A-Za-z0-9:_-]{1,64}$/) : null;
    return id === null ? [] : [id];
  });
  const effectText = [...effects].map(
    (name) =>
      SIDE_EFFECT_TEXT[name] ??
      `side effect ${trustedToken(name, /^[a-z][A-Za-z0-9]{0,63}$/) ?? 'with an unrecognized name'}`,
  );
  return (
    `${TOOL}: applied ${String(steps.length)} operations in order, each as its own undo step (see steps)` +
    (effectText.length > 0 ? `; side effects: ${effectText.join(', ')}` : '') +
    (clamped > 0 ? `; ${String(clamped)} handle move(s) were limited by the minimum spacing` : '') +
    (codes.size > 0 ? `; Warnings: ${[...codes].join(', ')}` : '') +
    (undoIds.length > 0
      ? `; undoing all takes ${String(undoIds.length)} steps, newest first: ${[...undoIds].reverse().join(', ')}`
      : '') +
    '.'
  );
}

export const editTimingTool = defineTool({
  name: TOOL,
  title: 'Edit OpenTune time grid',
  description:
    'OpenTune (audio vocal pitch editor): edits the time handles of one clip; audio between handles stretches or ' +
    'compresses. OpenTune does not detect beats: handle positions come from the user, or from op seed, which places ' +
    'initial handles and cannot be undone. ops run in order: seed (a job), shift (handles in a start..end range, ' +
    'output or content clock, by delta_ms), move (named handles to output_sec). Limited moves are applied as far as ' +
    'allowed (CLAMPED). Handle ids come from time_grid_handles of the last result of this tool (seed gives them too).',
  inputSchema: z.strictObject({
    clip: z
      .string()
      .regex(CLIP_RE)
      .describe('Clip placement id (p:...) from opentune_get_project, or a content id (c:...).'),
    expected_revision: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('clip_revision of the clip. Required for shift and move; not needed for seed.'),
    ops: z.array(opSchema).min(1).max(MAX_OPS).describe('Operations in order. seed must be alone.'),
    wait_seconds: z
      .number()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .optional()
      .describe(
        'Seed only (refused with shift or move). How long seed waits for its job, 0 to 30. Default 10; then the job id is returned.',
      ),
    instance_id: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional()
      .describe('OpenTune instance (32 hex digits, from opentune_get_status). Optional when one instance runs.'),
  }),
  outputSchema: WRITE_RESULT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  capabilities: ['timing.v1', 'jobs.v1', 'read.v1'],
  otcpMethods: ['content.shiftTiming', 'content.editTimeGrid', 'content.getDetails', 'job.get', 'project.get'],
  run: (args, ctx) => editTiming(ctx, args),
});
