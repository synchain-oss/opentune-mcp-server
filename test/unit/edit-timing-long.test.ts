// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_edit_timing with many operations in one call (up to 64): the grid revision chained from one
// request to the next, the compact steps and their character budget, the result staying inside the
// 20,000 character budget of a read result, the stop at the time budget with the place to go on from,
// and the compact list of completed operations when a later one fails.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OtcpSession } from '../../src/otcp/client.js';
import { startMock, type OtcpMock } from '../../mock/server.js';
import { encodeClipRevision } from '../../src/otcp/tokens.js';
import { render, type Outcome } from '../../src/tools/registry.js';
import {
  CALL_BUDGET_MS,
  CLIENT_TIMEOUT_MS,
  editTiming,
  editTimingTool,
  type EditTimingArgs,
} from '../../src/tools/timing.js';
import { tempDir, testContext, type TestContext } from '../support/context.js';
import { clip, need } from '../support/mock-client.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function withMock(): Promise<{ mock: OtcpMock; ctx: TestContext }> {
  const t = tempDir();
  cleanup.push(t.remove);
  const mock = await startMock({ discoveryDir: t.dir });
  cleanup.push(() => mock.stop());
  const ctx = testContext(t.dir);
  cleanup.push(() => {
    ctx.instances.close();
  });
  return { mock, ctx };
}

const body = (outcome: Outcome) => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.error.kind}: ${outcome.error.detail}`);
  return outcome.body;
};
const failure = (outcome: Outcome) => {
  if (outcome.ok) throw new Error('expected an error');
  return outcome.error;
};

/** Records every OTCP request of the tool, passing it on to the mock. */
function recordCalls(): { method: string; params: Record<string, unknown> }[] {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = OtcpSession.prototype.call;
  vi.spyOn(OtcpSession.prototype, 'call').mockImplementation(function (this: OtcpSession, method, params, timeout) {
    calls.push({ method, params });
    return original.call(this, method, params, timeout);
  });
  return calls;
}

const call = (ctx: TestContext, args: EditTimingArgs) => editTiming(ctx, args);

/**
 * A clock that moves only when a request is made, by the time that request is given (its timeout when
 * `cost` is null: the worst case, every request taking its whole timeout). `sent` has the clock reading at
 * which each request left, so a test can check when a write was sent.
 */
function clockPerRequest(ctx: TestContext, cost: number | null) {
  let elapsed = 0;
  const sent: { method: string; at: number; timeout: number }[] = [];
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = OtcpSession.prototype.call;
  vi.spyOn(OtcpSession.prototype, 'call').mockImplementation(async function (
    this: OtcpSession,
    method,
    params,
    timeout,
  ) {
    sent.push({ method, at: elapsed, timeout });
    const result = await original.call(this, method, params, timeout);
    elapsed += cost ?? timeout;
    return result;
  });
  return { ctx: { ...ctx, now: () => elapsed }, sent, elapsed: () => elapsed };
}

const HANDLES = 400;
const SPACING = 0.5;

/** A clip with 400 handles, one every half second from second 1. */
async function longSeeded() {
  const { mock, ctx } = await withMock();
  const grid = Array.from({ length: HANDLES }, (_, i) => ({ bind: `h${String(i)}`, contentSec: 1 + i * SPACING }));
  const ids = mock.given({ dirty: false, clips: [clip({ durationSec: HANDLES * SPACING + 20, timeGrid: grid })] });
  const revision = encodeClipRevision({
    content: need(ids, 'clip.revision'),
    grid: need(ids, 'clip.gridRevision'),
    key: need(ids, 'clip.keyRevision'),
    geometry: ids['clip.geometryHash'] ?? null,
  });
  return { mock, ctx, ids, revision, placement: need(ids, 'clip.placementId') };
}

/** `count` shifts of one three-second phrase each, starting at phrase `from`. */
const phrases = (count: number, delta_ms = 10, from = 0) =>
  Array.from({ length: count }, (_, i) => ({
    op: 'shift' as const,
    start_content_sec: 0.9 + (from + i) * 3,
    end_content_sec: 3.9 + (from + i) * 3,
    delta_ms,
  }));

const sizes = (outcome: Outcome) => {
  const result = render(outcome);
  return {
    text: (result.content[0] as { text: string }).text.length,
    structured: JSON.stringify(result.structuredContent).length,
  };
};

interface Compact {
  operation: number;
  op: string;
  moved: number;
  clamped: number;
  undo_id: string | null;
  moves: unknown[][];
  moves_omitted?: number;
}

describe('opentune_edit_timing: up to 64 operations in one call', () => {
  it('accepts 64 operations and no more, and a move still names at most 64 handles', () => {
    const schema = editTimingTool.inputSchema;
    const args = (n: number) => ({ clip: 'c:01234567:0:1', expected_revision: 'x', ops: phrases(n) });
    expect(schema.safeParse(args(64)).success).toBe(true);
    expect(schema.safeParse(args(65)).success).toBe(false);
    expect(schema.safeParse(args(0)).success).toBe(false);
    const moves = (n: number) => ({
      op: 'move' as const,
      moves: Array.from({ length: n }, (_, i) => ({ handle_id: `th:1:${String(i)}`, output_sec: 1 })),
    });
    expect(schema.safeParse({ ...args(1), ops: [moves(64)] }).success).toBe(true);
    expect(schema.safeParse({ ...args(1), ops: [moves(65)] }).success).toBe(false);
  });

  it('applies 64 operations, each with the grid revision of the one before, and lists them compactly', async () => {
    const { ctx, ids, revision, placement } = await longSeeded();
    const calls = recordCalls();
    const outcome = await call(ctx, { clip: placement, expected_revision: revision, ops: phrases(64) });
    const out = body(outcome);

    expect(out.summary).toMatch(/^opentune_edit_timing: applied 64 operations in order, each as its own undo step/);
    expect(out.summary).toContain('undoing all takes 64 steps, newest operation first');
    const steps = out.steps as Compact[];
    expect(steps).toHaveLength(64);
    expect(steps.map((s) => s.operation)).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
    expect(steps.every((s) => s.op === 'shift' && typeof s.undo_id === 'string' && s.clamped === 0)).toBe(true);
    expect(new Set(steps.map((s) => s.undo_id)).size).toBe(64);
    expect(steps.reduce((total, s) => total + s.moved, 0)).toBe(out.moves_total);
    expect(out.moves_total as number).toBeGreaterThanOrEqual(64 * 5);
    expect(steps.reduce((total, s) => total + s.moves.length + (s.moves_omitted ?? 0), 0)).toBe(out.moves_total);
    const first = steps[0]?.moves[0];
    expect(first).toEqual([expect.any(String), expect.any(Number), expect.any(Number)]);
    expect((first?.[2] as number) - (first?.[1] as number)).toBeCloseTo(0.01);
    expect(out.steps_format).toContain('handle_id');

    // Every request carried the grid revision the previous answer produced.
    const sent = calls.filter((c) => c.method === 'content.shiftTiming');
    expect(sent).toHaveLength(64);
    const revisions = sent.map((c) => c.params.expectedGridRevision);
    expect(revisions[0]).toBe(ids['clip.gridRevision']);
    expect(new Set(revisions).size).toBe(64);

    // The handle list is capped, the count is not.
    expect((out.time_grid_handles as unknown[]).length).toBe(40);
    expect(out.time_grid_handle_count).toBe(HANDLES);
    expect(out.time_grid_handles_truncated).toBe(true);

    // The whole result stays inside the budget of a read result.
    const size = sizes(outcome);
    expect(size.text).toBeLessThanOrEqual(20_000);
    expect(size.structured).toBeLessThanOrEqual(20_000);

    // The revision at the end is current.
    body(await call(ctx, { clip: placement, expected_revision: out.clip_revision as string, ops: phrases(1, 5, 70) }));
  });

  it('lists the moves up to a character budget and counts the rest, even when every handle moves in every operation', async () => {
    const { ctx, revision, placement } = await longSeeded();
    const everything = Array.from({ length: 64 }, () => ({
      op: 'shift' as const,
      start_output_sec: 0,
      end_output_sec: 1000,
      delta_ms: 1,
    }));
    const outcome = await call(ctx, { clip: placement, expected_revision: revision, ops: everything });
    const out = body(outcome);
    expect(out.moves_total).toBe(64 * HANDLES);
    const listed = out.moves_listed as number;
    expect(listed).toBeGreaterThan(100);
    expect(listed).toBeLessThan(64 * HANDLES);
    const steps = out.steps as Compact[];
    expect(steps.reduce((total, s) => total + s.moves.length, 0)).toBe(listed);
    expect(steps.reduce((total, s) => total + s.moved, 0)).toBe(64 * HANDLES);
    // Operations after the budget was used up list no moves, and say how many they left out.
    const last = steps.at(-1);
    expect(last?.moves).toEqual([]);
    expect(last?.moves_omitted).toBe(HANDLES);
    expect(sizes(outcome).text).toBeLessThanOrEqual(20_000);
    expect(sizes(outcome).structured).toBeLessThanOrEqual(20_000);
  });

  it('keeps up to eight operations in the full format', async () => {
    const { ctx, revision, placement } = await longSeeded();
    const out = body(await call(ctx, { clip: placement, expected_revision: revision, ops: phrases(8) }));
    expect(out.steps_format).toBeUndefined();
    expect(out.moves_total).toBeUndefined();
    const steps = out.steps as { summary: string; changes: unknown[] }[];
    expect(steps).toHaveLength(8);
    expect(steps[0]?.summary).toMatch(/^opentune_edit_timing: changed /);
    expect(steps[0]?.changes.length).toBeGreaterThan(0);
    expect((out.time_grid_handles as unknown[]).length).toBe(200);
    expect(out.summary).toContain('newest first: ');
  });

  it('stops between two operations when the call has used its time, and says where to go on', async () => {
    const { ctx, revision, placement } = await longSeeded();
    const calls = recordCalls();
    // Each request sent counts as 20 seconds: the third operation would start at 40 seconds, and 40 s + the
    // 20 s a write may take + the 15 s of the read after it do not fit in 60 s.
    const slow = { ...ctx, now: () => calls.filter((c) => c.method === 'content.shiftTiming').length * 20_000 };
    const out = body(await call(slow, { clip: placement, expected_revision: revision, ops: phrases(10) }));

    expect(calls.filter((c) => c.method === 'content.shiftTiming')).toHaveLength(2);
    expect(out.summary).toMatch(/^opentune_edit_timing: applied 2 of 10 operations in order/);
    expect(out.summary).toContain('operations 3 to 10 were NOT sent');
    expect(out.stopped).toEqual({
      reason: 'time_budget',
      applied: 2,
      total: 10,
      next_operation: 3,
      message: expect.stringContaining('Operations 3 to 10 were not sent') as unknown,
    });
    expect((out.steps as Compact[]).map((s) => s.operation)).toEqual([1, 2]);
    expect(out.summary).toContain('undoing all takes 2 steps');

    // The rest goes in a new call with the revision of this result.
    const rest = body(
      await call(ctx, { clip: placement, expected_revision: out.clip_revision as string, ops: phrases(8, 10, 2) }),
    );
    expect(rest.stopped).toBeUndefined();
    expect(rest.summary).toMatch(/applied 8 operations/);
  });

  it('derives the budget from the client timeout and the longest a write and the read after it may take', () => {
    expect(CLIENT_TIMEOUT_MS).toBe(60_000);
    // 60 s - 20 s (a write at its timeout) - 15 s (the read of the handles at its timeout)
    expect(CALL_BUDGET_MS).toBe(25_000);
  });

  it('sends no write that could end after the client timeout, even when every request takes its whole timeout', async () => {
    for (const count of [1, 2, 3, 10, 64]) {
      const { ctx, revision, placement } = await longSeeded();
      vi.restoreAllMocks();
      const worst = clockPerRequest(ctx, null);
      const outcome = await call(worst.ctx, { clip: placement, expected_revision: revision, ops: phrases(count) });
      const out = body(outcome);
      const writes = worst.sent.filter((r) => r.method === 'content.shiftTiming');
      // The call as a whole, with every request at its timeout, ended inside the client timeout.
      expect(worst.elapsed(), `${String(count)} operations`).toBeLessThanOrEqual(CLIENT_TIMEOUT_MS);
      // Every write after the first left with room for itself and for the read of the handles.
      for (const write of writes.slice(1)) {
        expect(write.at + write.timeout + 15_000, `${String(count)} operations`).toBeLessThanOrEqual(CLIENT_TIMEOUT_MS);
      }
      // The look-up of the clip (a project.get at its timeout) counts: here it leaves room for one write only.
      expect(writes).toHaveLength(Math.min(count, 1));
      if (count > 1) expect(out.stopped).toMatchObject({ applied: 1, total: count, next_operation: 2 });
      else expect(out.stopped).toBeUndefined();
    }
  });

  it('keeps sending while the worst case fits, and stops at the first operation that would not', async () => {
    const { ctx, revision, placement } = await longSeeded();
    vi.restoreAllMocks();
    // Every request takes 7 s: writes leave at 7 s (after the look-up), 14 s, 21 s and 28 s; the one at 28 s
    // would be 28 + 20 + 15 = 63 s in the worst case, so the call stops with four applied.
    const typical = clockPerRequest(ctx, 7000);
    const out = body(await call(typical.ctx, { clip: placement, expected_revision: revision, ops: phrases(10) }));
    const writes = typical.sent.filter((r) => r.method === 'content.shiftTiming');
    expect(writes.map((w) => w.at)).toEqual([7000, 14_000, 21_000]);
    expect(out.stopped).toMatchObject({ applied: 3, total: 10, next_operation: 4 });
    expect(21_000 + 20_000 + 15_000).toBeLessThan(CLIENT_TIMEOUT_MS);
    expect(28_000 + 20_000 + 15_000).toBeGreaterThanOrEqual(CLIENT_TIMEOUT_MS);
    expect(out.summary).toContain('applied 3 of 10 operations');
  });

  it('keeps the full steps when a short call is stopped, and never stops before the first operation', async () => {
    const { ctx, revision, placement } = await longSeeded();
    const calls = recordCalls();
    const slow = { ...ctx, now: () => calls.filter((c) => c.method === 'content.shiftTiming').length * 60_000 };
    const out = body(await call(slow, { clip: placement, expected_revision: revision, ops: phrases(3) }));
    expect(calls.filter((c) => c.method === 'content.shiftTiming')).toHaveLength(1);
    expect(out.summary).toMatch(/applied 1 of 3 operations/);
    expect(out.stopped).toMatchObject({ applied: 1, total: 3, next_operation: 2 });
    expect(out.steps_format).toBeUndefined();
    expect((out.steps as { undo: unknown }[])[0]?.undo).toBeDefined();
  });

  it('reports the completed operations compactly when a later one fails, with the revision of the last', async () => {
    const { ctx, revision, placement } = await longSeeded();
    const outcome = await call(ctx, {
      clip: placement,
      expected_revision: revision,
      ops: [...phrases(9), { op: 'move', moves: [{ handle_id: 'th:9:9', output_sec: 5 }] }],
    });
    const error = failure(outcome);
    expect(error).toMatchObject({ kind: 'NOT_FOUND', reason: 'unknown_handle', executed: true });
    expect(error.detail).toContain('operation 10 failed after 9 applied');
    expect(error.nextStep.message).toContain('retry only the operations from number 10 on');
    const completed = (outcome as { context?: { completed?: (Compact & { clip_revision?: string })[] } }).context
      ?.completed;
    expect(completed).toHaveLength(9);
    expect(completed?.every((c) => typeof c.undo_id === 'string')).toBe(true);
    expect(completed?.slice(0, -1).some((c) => 'clip_revision' in c)).toBe(false);
    const latest = completed?.at(-1)?.clip_revision;
    expect(typeof latest).toBe('string');
    // That revision is current: the rest can go on with it.
    body(await call(ctx, { clip: placement, expected_revision: latest ?? '', ops: phrases(1, 5, 40) }));
    expect(sizes(outcome).text).toBeLessThanOrEqual(20_000);
  });
});
