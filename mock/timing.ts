// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The time-grid edits of the mock (capability timing.v1): content.shiftTiming and
// content.editTimeGrid (spec/otcp/v1/PROTOCOL.md section 8.1). The grid is the list of handles of a
// content; moving a handle stretches or compresses the audio next to it. Moves are limited by a
// minimum spacing to the neighbouring handles, in two passes, and a limited move is reported as
// clamped. Seeding the grid runs as a job of kind timeGridSeed.

import { checkNotBusy, envelope, type Handler, type MethodContext } from './context.js';
import { MockError, refuse } from './errors.js';
import type { ContentRec, HandleRec } from './model.js';
import {
  commit,
  expectGridRevision,
  jobResult,
  noOpResult,
  predictionResult,
  requireReady,
  round,
  type UndoInfo,
} from './writes.js';

/** The least distance between two handles, and between a handle and either end, on the output clock. */
export const MIN_HANDLE_SPACING_SEC = 0.05;
/** Seeded handles lie this far apart on the content clock. */
const SEED_SPACING_SEC = 1;
const EPSILON = 1e-9;

const TIME_GRID: UndoInfo = { action: 'timeGrid', description: 'Move time handles', innerActions: ['moveTimeHandles'] };

const handleLabel = (handle: HandleRec): string => `Handle at ${handle.contentSec.toFixed(2)} s`;

const notSeeded = () =>
  new MockError({
    kind: 'NOT_READY',
    reason: 'grid_not_seeded',
    detail: 'the time grid has no handles; seed it with content.editTimeGrid first',
  });

/** The common start of a time-grid write: handle, busy state and readiness gate (section 13.1 rule 4). */
function open(context: MethodContext, options: { needsHandles: boolean }): ContentRec {
  const content = context.world.content(String(context.params.contentId));
  checkNotBusy(context);
  requireReady(content);
  if (options.needsHandles && content.handles.length === 0) throw notSeeded();
  return content;
}

interface Clamped {
  handleId: string;
  requestedOutputSec: number;
  appliedOutputSec: number;
}

/**
 * Where the handles in `requests` (handleId to requested output position) end up. The other
 * handles stay. Pass one limits each moved handle to the room between the nearest handles that do
 * not move (or the ends of the content); pass two keeps the moved handles apart from each other,
 * first from the start of the grid forward and then from the end back.
 *
 * Every move keeps the spacing, so between two handles that stay there is always room for the
 * handles between them. Only a grid that was set up closer than the spacing (a `given` time grid)
 * can lack that room: the backward pass then packs the moved handles against the upper end of
 * their room, and the first ones end up closer than the spacing to the handle or end before them,
 * possibly past it. The mock accepts that and never refuses a move for lack of room.
 */
function clampMoves(content: ContentRec, requests: ReadonlyMap<string, number>) {
  interface Slot {
    readonly handle: HandleRec;
    /** Undefined for a handle that stays. */
    readonly requested: number | undefined;
    low: number;
    high: number;
    x: number;
  }
  const slots: Slot[] = content.handles.map((handle) => ({
    handle,
    requested: requests.get(handle.handleId),
    low: MIN_HANDLE_SPACING_SEC,
    high: content.durationSec - MIN_HANDLE_SPACING_SEC,
    x: handle.outputSec,
  }));
  // The room of a moved handle ends at the nearest handle on each side that stays.
  slots.forEach((slot, i) => {
    const before = slots
      .slice(0, i)
      .reverse()
      .find((other) => other.requested === undefined);
    const after = slots.slice(i + 1).find((other) => other.requested === undefined);
    if (before !== undefined) slot.low = before.handle.outputSec + MIN_HANDLE_SPACING_SEC;
    if (after !== undefined) slot.high = after.handle.outputSec - MIN_HANDLE_SPACING_SEC;
  });
  // Pass one: each moved handle on its own.
  for (const slot of slots) {
    if (slot.requested !== undefined)
      slot.x = Math.min(Math.max(slot.requested, slot.low), Math.max(slot.low, slot.high));
  }
  // Pass two: neighbours that move keep their distance, first forward and then back.
  slots.forEach((slot, i) => {
    const previous = slots[i - 1];
    if (slot.requested !== undefined && previous?.requested !== undefined) {
      slot.x = Math.max(slot.x, previous.x + MIN_HANDLE_SPACING_SEC);
    }
  });
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i];
    const next = slots[i + 1];
    if (slot?.requested === undefined) continue;
    const room = next?.requested === undefined ? Infinity : next.x - MIN_HANDLE_SPACING_SEC;
    slot.x = Math.min(slot.x, slot.high, room);
  }
  const moves: { handle: HandleRec; to: number }[] = [];
  const clamped: Clamped[] = [];
  for (const { handle, requested, x } of slots) {
    if (requested === undefined) continue;
    const to = round(x);
    if (Math.abs(to - handle.outputSec) > EPSILON) moves.push({ handle, to });
    if (Math.abs(to - requested) > EPSILON) {
      clamped.push({ handleId: handle.handleId, requestedOutputSec: round(requested), appliedOutputSec: to });
    }
  }
  return { moves, clamped };
}

/** Moves handles to the requested positions, as far as the spacing allows, or predicts that. */
function moveHandles(
  context: MethodContext,
  content: ContentRec,
  requests: ReadonlyMap<string, number>,
  dryRun: boolean,
) {
  const { world } = context;
  const { moves, clamped } = clampMoves(content, requests);
  const warnings = clamped.map((c) => ({
    code: 'CLAMPED',
    subject: { contentId: content.id, handleId: c.handleId },
    data: { field: 'outputSec', requested: c.requestedOutputSec, applied: c.appliedOutputSec },
  }));
  const changes = moves.map(({ handle, to }) => ({
    entity: 'timeHandle',
    ref: { contentId: content.id, handleId: handle.handleId },
    label: handleLabel(handle),
    fields: { outputSec: { before: handle.outputSec, after: to, unit: 'sec' } },
  }));
  if (dryRun) return predictionResult(context, content, { changes, warnings, extra: { clamped } });
  if (moves.length === 0) return noOpResult(context, content, { clamped }, warnings);
  const done = commit(world, content, {
    mutate() {
      for (const { handle, to } of moves) handle.outputSec = to;
      world.touch(content, 'grid');
    },
    undo: TIME_GRID,
    rerender: true,
  });
  return envelope(world, {
    applied: true,
    noOp: false,
    changes,
    diff: done.diff,
    contents: [content],
    undo: done.undo,
    dirtyBefore: done.dirtyBefore,
    sideEffects: done.sideEffects,
    warnings,
    extra: { clamped },
  });
}

type ShiftRange = { startContentSec: number; endContentSec: number } | { startOutputSec: number; endOutputSec: number };

const shiftTiming: Handler = (context) => {
  const { world, params } = context;
  const content = open(context, { needsHandles: true });
  expectGridRevision(content, params.expectedGridRevision);
  const range = params.range as ShiftRange;
  // A content range is mapped through the grid as it is at expectedGridRevision, which is now.
  const [start, end] =
    'startContentSec' in range
      ? [world.contentToOutput(content, range.startContentSec), world.contentToOutput(content, range.endContentSec)]
      : [range.startOutputSec, range.endOutputSec];
  const delta = params.deltaSec as number;
  // The range is closed: a handle exactly on either end moves, as it does in OpenTune.
  const requests = new Map(
    content.handles
      .filter((h) => h.outputSec >= start && h.outputSec <= end)
      .map((h) => [h.handleId, h.outputSec + delta]),
  );
  return moveHandles(context, content, requests, params.dryRun === true);
};

// content.editTimeGrid ----------------------------------------------------------------------------

/** The handles OpenTune's time tool places when it is picked: evenly along the content. */
function seededHandles(content: ContentRec): HandleRec[] {
  const times: number[] = [];
  for (let t = SEED_SPACING_SEC; t < content.durationSec - MIN_HANDLE_SPACING_SEC; t += SEED_SPACING_SEC) times.push(t);
  if (times.length === 0 && content.durationSec > 2 * MIN_HANDLE_SPACING_SEC) times.push(content.durationSec / 2);
  return times.map((t) => ({
    handleId: `th:${String(content.objectId)}:${String(++content.handleSeq)}`,
    contentSec: round(t),
    outputSec: round(t),
  }));
}

/**
 * The work of the timeGridSeed job: it runs after the call has answered and commits the handles.
 * What the call checked can have changed by then, so the job checks again in the same order: the
 * content still exists, the UI is not busy, the analysis is ready. If one fails, nothing is written
 * and the job fails with that check's error (NOT_FOUND, BUSY or NOT_READY, which the method lists
 * in x-otcp.jobErrors).
 */
function seedGrid(context: MethodContext, content: ContentRec): Record<string, unknown> {
  const { world } = context;
  if (world.contents.get(content.objectId) !== content) {
    throw refuse('NOT_FOUND', 'unknown_handle', 'the content was removed before the seed job ran');
  }
  checkNotBusy(context);
  requireReady(content);
  const handles = content.handles.length === 0 ? seededHandles(content) : [];
  if (handles.length === 0) return noOpResult(context, content, { clamped: [] });
  const done = commit(world, content, {
    mutate() {
      content.handles = handles;
      world.touch(content, 'grid');
    },
    // OpenTune pushes no undo entry when the time tool is picked, and no request can take the handles away.
    undo: { notUndoable: { undoable: false, reason: 'ui_parity', revert: null } },
    rerender: false,
  });
  return envelope(world, {
    applied: true,
    noOp: false,
    created: handles.map((handle) => ({
      entity: 'timeHandle',
      ref: { contentId: content.id, handleId: handle.handleId },
      label: handleLabel(handle),
    })),
    diff: done.diff,
    contents: [content],
    undo: done.undo,
    dirtyBefore: done.dirtyBefore,
    sideEffects: done.sideEffects,
    warnings: [{ code: 'IRREVERSIBLE', subject: { contentId: content.id }, data: null }],
    extra: { clamped: [] },
  });
}

const editTimeGrid: Handler = (context) => {
  const { params } = context;
  if (params.op === 'seed') {
    const content = open(context, { needsHandles: false });
    if (content.handles.length > 0) return noOpResult(context, content, { clamped: [] });
    const job = context.startJob('timeGridSeed', () => seedGrid(context, content));
    return jobResult(context, content, job, { clamped: [] });
  }
  const content = open(context, { needsHandles: true });
  expectGridRevision(content, params.expectedGridRevision);
  const moves = params.moves as { handleId: string; outputSec: number }[];
  const requests = new Map<string, number>();
  for (const { handleId, outputSec } of moves) {
    if (requests.has(handleId)) {
      throw refuse('INVALID_ARGUMENT', 'duplicate_handle', 'a handle may appear in moves only once');
    }
    requests.set(handleId, outputSec);
  }
  const unknown = moves.find(({ handleId }) => !content.handles.some((h) => h.handleId === handleId));
  if (unknown !== undefined) {
    throw refuse('NOT_FOUND', 'unknown_handle', 'a handleId in moves is not in the time grid of the content');
  }
  return moveHandles(context, content, requests, params.dryRun === true);
};

export const timingHandlers: Readonly<Record<string, Handler>> = {
  'content.shiftTiming': shiftTiming,
  'content.editTimeGrid': editTimeGrid,
};
