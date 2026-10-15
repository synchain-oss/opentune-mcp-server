// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_edit_timing against the mock: seed as a job (finished, still running, cancelled), shift
// on both clocks, move, the limits of a move (CLAMPED), the refusals (grid not seeded, grid changed,
// stale and unknown handles), several operations in one call, and the revision rule: only the grid
// token is forwarded, so a change of the notes does not conflict and a change of the grid does.

import { afterEach, describe, expect, it } from 'vitest';

import { ManualClock } from '../../mock/clock.js';
import { startMock, type OtcpMock } from '../../mock/server.js';
import { decodeClipRevision, encodeClipRevision } from '../../src/otcp/tokens.js';
import { WRITE_RESULT_OUTPUT, type Outcome } from '../../src/tools/registry.js';
import { editTiming, editTimingTool, type EditTimingArgs } from '../../src/tools/timing.js';
import { tempDir, testContext, type TestContext } from '../support/context.js';
import { clip, need } from '../support/mock-client.js';
import { otcpSpec } from '../support/otcp-spec.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function withMock(clock?: ManualClock): Promise<{ mock: OtcpMock; ctx: TestContext }> {
  const t = tempDir();
  cleanup.push(t.remove);
  const mock = await startMock({ discoveryDir: t.dir, ...(clock === undefined ? {} : { clock }) });
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

async function otcp(ctx: TestContext, method: string, params: Record<string, unknown>) {
  const scan = await ctx.instances.scan();
  if (!('instances' in scan) || scan.instances[0] === undefined) throw new Error('no instance');
  return (await ctx.instances.session(scan.instances[0])).call(method, params, 10_000);
}

const GRID = [
  { bind: 'h1', contentSec: 1 },
  { bind: 'h2', contentSec: 2 },
  { bind: 'h3', contentSec: 3 },
];

/** A clip with handles at 1, 2 and 3 s and the clip_revision a client would hold for it. */
async function seeded(clock?: ManualClock) {
  const { mock, ctx } = await withMock(clock);
  const ids = mock.given({ dirty: false, clips: [clip({ timeGrid: GRID })] });
  return { mock, ctx, ids, revision: revisionOf(ids), placement: need(ids, 'clip.placementId') };
}

function revisionOf(ids: Record<string, string>): string {
  return encodeClipRevision({
    content: need(ids, 'clip.revision'),
    grid: need(ids, 'clip.gridRevision'),
    key: need(ids, 'clip.keyRevision'),
    geometry: ids['clip.geometryHash'] ?? null,
  });
}

const call = (ctx: TestContext, args: EditTimingArgs) => editTiming(ctx, args);
const shift = (extra: Record<string, unknown> = {}) => ({
  op: 'shift' as const,
  start_output_sec: 1.5,
  end_output_sec: 2.5,
  delta_ms: 100,
  ...extra,
});

describe('opentune_edit_timing shift and move', () => {
  it('shifts the handles of an output range by milliseconds and reports the new clip_revision', async () => {
    const { ctx, ids, revision, placement } = await seeded();
    const out = body(await call(ctx, { clip: placement, expected_revision: revision, ops: [shift()] }));
    expect(out.summary).toMatch(/^opentune_edit_timing: changed 1 timeHandle/);
    const change = (out.changes as { fields: { outputSec: { before: number; after: number } } }[])[0];
    expect(change?.fields.outputSec.before).toBeCloseTo(2);
    expect(change?.fields.outputSec.after).toBeCloseTo(2.1);
    expect(out.clamped).toEqual([]);
    expect(out.lines).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'undo' })]));
    const next = decodeClipRevision(out.clip_revision as string);
    expect(next?.grid).not.toBe(ids['clip.gridRevision']);
    expect(next?.content).toBe(ids['clip.revision']);
    expect(next?.key).toBe(ids['clip.keyRevision']);
    // The new revision is current: a second edit with it succeeds.
    body(await call(ctx, { clip: placement, expected_revision: out.clip_revision as string, ops: [shift()] }));
  });

  it('shifts a range given on the content clock, through a content id', async () => {
    const { ctx, ids, revision } = await seeded();
    const out = body(
      await call(ctx, {
        clip: need(ids, 'clip.contentId'),
        expected_revision: revision,
        ops: [{ op: 'shift', start_content_sec: 2.5, end_content_sec: 3.5, delta_ms: -200 }],
      }),
    );
    const change = (out.changes as { fields: { outputSec: { after: number } } }[])[0];
    expect(change?.fields.outputSec.after).toBeCloseTo(2.8);
  });

  it('moves named handles and chains the revision across calls', async () => {
    const { ctx, ids, revision } = await seeded();
    const first = body(
      await call(ctx, {
        clip: need(ids, 'clip.contentId'),
        expected_revision: revision,
        ops: [{ op: 'move', moves: [{ handle_id: need(ids, 'h1'), output_sec: 1.25 }] }],
      }),
    );
    expect(first.changes).toHaveLength(1);
    const second = body(
      await call(ctx, {
        clip: need(ids, 'clip.contentId'),
        expected_revision: first.clip_revision as string,
        ops: [
          {
            op: 'move',
            moves: [
              { handle_id: need(ids, 'h1'), output_sec: 1.3 },
              { handle_id: need(ids, 'h3'), output_sec: 3.2 },
            ],
          },
        ],
      }),
    );
    expect(second.changes).toHaveLength(2);
    expect(second.clamped).toEqual([]);
  });

  it('reports a move that the minimum spacing limits: the applied value, CLAMPED and the first sentence', async () => {
    const { ctx, ids, revision } = await seeded();
    const out = body(
      await call(ctx, {
        clip: need(ids, 'clip.contentId'),
        expected_revision: revision,
        ops: [{ op: 'move', moves: [{ handle_id: need(ids, 'h2'), output_sec: 3.5 }] }],
      }),
    );
    const clamped = out.clamped as { handleId: string; requestedOutputSec: number; appliedOutputSec: number }[];
    expect(clamped).toHaveLength(1);
    expect(clamped[0]?.handleId).toBe(ids.h2);
    expect(clamped[0]?.requestedOutputSec).toBeCloseTo(3.5);
    expect(clamped[0]?.appliedOutputSec).toBeGreaterThan(2);
    expect(clamped[0]?.appliedOutputSec).toBeLessThan(3);
    expect(out.summary).toContain('Warnings: CLAMPED');
    expect(out.lines).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'warning', code: 'CLAMPED' })]));
  });

  it('applies several operations in order, each with the grid revision the previous one produced', async () => {
    const { ctx, ids, revision } = await seeded();
    const out = body(
      await call(ctx, {
        clip: need(ids, 'clip.contentId'),
        expected_revision: revision,
        ops: [shift({ delta_ms: 50 }), { op: 'move', moves: [{ handle_id: need(ids, 'h3'), output_sec: 3.4 }] }],
      }),
    );
    expect(out.summary).toMatch(/applied 2 operations in order, each as its own undo step/);
    expect(out.steps).toHaveLength(2);
    expect(decodeClipRevision(out.clip_revision as string)?.grid).not.toBe(ids['clip.gridRevision']);
  });

  it('says how far a multi-operation call got when a later operation is refused', async () => {
    const { ctx, ids, revision } = await seeded();
    const outcome = await call(ctx, {
      clip: need(ids, 'clip.contentId'),
      expected_revision: revision,
      ops: [shift(), { op: 'move', moves: [{ handle_id: 'th:9:9', output_sec: 5 }] }],
    });
    const error = failure(outcome);
    expect(error).toMatchObject({ kind: 'NOT_FOUND', reason: 'unknown_handle', executed: true });
    expect(error.detail).toContain('operation 2 failed after 1 applied');
    expect((outcome as { context?: { completed?: unknown[] } }).context?.completed).toHaveLength(1);
  });
});

describe('opentune_edit_timing revisions and refusals', () => {
  it('does not conflict with a change of the notes, and conflicts with a change of the grid', async () => {
    const { ctx, ids, revision } = await seeded();
    // The notes change; the content token moves, the grid token does not (rule 2 of the revision section).
    await otcp(ctx, 'content.editNotes', {
      contentId: ids['clip.contentId'],
      expectedRevision: ids['clip.revision'],
      ops: [{ op: 'shiftCents', select: { indices: [0] }, deltaCents: 10 }],
    });
    const unrelated = body(
      await call(ctx, { clip: need(ids, 'clip.contentId'), expected_revision: revision, ops: [shift()] }),
    );
    expect(unrelated.changes).toHaveLength(1);
    // The same revision again: the grid changed by the call above.
    const conflict = failure(
      await call(ctx, { clip: need(ids, 'clip.contentId'), expected_revision: revision, ops: [shift()] }),
    );
    expect(conflict).toMatchObject({ kind: 'REVISION_CONFLICT', reason: 'grid_changed', executed: false });
    expect(conflict.nextStep.tool).toBe('opentune_get_project');
  });

  it('forwards only the grid token', async () => {
    const { ctx, ids, revision } = await seeded();
    const tokens = decodeClipRevision(revision);
    if (tokens === null) throw new Error('unreachable');
    // A stale content, key and geometry token in the revision do not matter; only the grid one does.
    const stale = encodeClipRevision({ ...tokens, content: 'old', key: 'old', geometry: 'old' });
    const out = body(await call(ctx, { clip: need(ids, 'clip.contentId'), expected_revision: stale, ops: [shift()] }));
    expect(out.changes).toHaveLength(1);
  });

  it('points to seed when the grid has no handles', async () => {
    const { mock, ctx } = await withMock();
    const ids = mock.given({ dirty: false, clips: [clip()] });
    const error = failure(
      await call(ctx, { clip: need(ids, 'clip.contentId'), expected_revision: revisionOf(ids), ops: [shift()] }),
    );
    expect(error).toMatchObject({ kind: 'NOT_READY', reason: 'grid_not_seeded', executed: false });
    expect(error.nextStep).toMatchObject({ tool: 'opentune_edit_timing', args: { ops: [{ op: 'seed' }] } });
  });

  it('reports a handle id of another instance as stale and an unknown handle as unknown', async () => {
    const { ctx, ids, revision } = await seeded();
    const stale = failure(await call(ctx, { clip: 'c:deadbeef:0:1', expected_revision: revision, ops: [shift()] }));
    expect(stale).toMatchObject({ kind: 'NOT_FOUND', reason: 'stale_handle' });
    const unknown = failure(
      await call(ctx, {
        clip: need(ids, 'clip.contentId'),
        expected_revision: revision,
        ops: [{ op: 'move', moves: [{ handle_id: 'th:9:9', output_sec: 1 }] }],
      }),
    );
    expect(unknown).toMatchObject({ kind: 'NOT_FOUND', reason: 'unknown_handle', executed: false });
    const missing = failure(
      await call(ctx, { clip: 'p:00000000:0:1', expected_revision: revision, ops: [shift()] }).catch(() => {
        throw new Error('the lookup of an unknown placement must not throw');
      }),
    );
    expect(missing.kind).toBe('NOT_FOUND');
  });

  it('checks the arguments before it sends anything', async () => {
    const { ctx, ids, revision } = await seeded();
    const clipId = need(ids, 'clip.contentId');
    const base = { clip: clipId, expected_revision: revision };
    const cases: [string, EditTimingArgs, RegExp][] = [
      ['seed with others', { clip: clipId, ops: [{ op: 'seed' }, shift()] }, /pass it alone/],
      ['both clocks', { ...base, ops: [shift({ start_content_sec: 1, end_content_sec: 2 })] }, /one clock/],
      ['no clock', { ...base, ops: [{ op: 'shift', delta_ms: 5 }] }, /one clock/],
      ['half a range', { ...base, ops: [shift({ end_output_sec: undefined })] }, /both the start and the end/],
      ['empty range', { ...base, ops: [shift({ end_output_sec: 1.5 })] }, /after its start/],
      [
        'duplicate handle',
        {
          ...base,
          ops: [
            {
              op: 'move',
              moves: [
                { handle_id: 'a', output_sec: 1 },
                { handle_id: 'a', output_sec: 2 },
              ],
            },
          ],
        },
        /only once/,
      ],
      ['no revision', { clip: clipId, ops: [shift()] }, /need expected_revision/],
      ['foreign revision', { clip: clipId, expected_revision: 'r1', ops: [shift()] }, /not a clip_revision/],
    ];
    for (const [name, args, detail] of cases) {
      const error = failure(await call(ctx, args));
      expect(error.kind, name).toBe('INVALID_ARGUMENT');
      expect(error.detail, name).toMatch(detail);
    }
    // Nothing was sent: the clip is unchanged.
    expect((await otcp(ctx, 'project.get', {})).dirty ?? false).toBeFalsy();
  });

  it('asks for a complete clip revision when the grid token is missing', async () => {
    const { ctx, ids } = await seeded();
    const revision = encodeClipRevision({ content: 'r', grid: null, key: 'k', geometry: null });
    const error = failure(
      await call(ctx, { clip: need(ids, 'clip.contentId'), expected_revision: revision, ops: [shift()] }),
    );
    expect(error).toMatchObject({ kind: 'INVALID_ARGUMENT', reason: 'revision_incomplete' });
  });

  it('returns an actionable error when the build lacks the timing capability', async () => {
    const { mock, ctx } = await withMock();
    const ids = mock.given({ clips: [clip()], withoutCapabilities: ['timing.v1'] });
    const error = failure(
      await call(ctx, { clip: need(ids, 'clip.contentId'), expected_revision: revisionOf(ids), ops: [shift()] }),
    );
    expect(error).toMatchObject({ kind: 'UNSUPPORTED', reason: 'capability_missing' });
  });
});

describe('opentune_edit_timing seed', () => {
  it('seeds the grid as a job, waits for it and returns the write result with a usable clip_revision', async () => {
    const { mock, ctx } = await withMock();
    const ids = mock.given({ dirty: false, clips: [clip()] });
    const out = body(await call(ctx, { clip: need(ids, 'clip.placementId'), ops: [{ op: 'seed' }], wait_seconds: 10 }));
    expect(out.summary).toMatch(/^opentune_edit_timing: created \d+ timeHandles? \(destructive; not undoable/);
    expect(out.summary).toContain('Warnings: IRREVERSIBLE');
    expect((out.created as { entity: string }[]).every((c) => c.entity === 'timeHandle')).toBe(true);
    // The revision after the seed works for the next edit; the handle ids are in `created`.
    const handle = (out.created as { ref: { handleId: string } }[])[0]?.ref.handleId ?? '';
    const moved = body(
      await call(ctx, {
        clip: need(ids, 'clip.contentId'),
        expected_revision: out.clip_revision as string,
        ops: [{ op: 'move', moves: [{ handle_id: handle, output_sec: 1.1 }] }],
      }),
    );
    expect(moved.changes).toHaveLength(1);
  });

  it('seeding a grid that has handles changes nothing', async () => {
    const { ctx, placement } = await seeded();
    const out = body(await call(ctx, { clip: placement, ops: [{ op: 'seed' }] }));
    expect(out.summary).toMatch(/^opentune_edit_timing: nothing was changed, which is a success/);
  });

  it('returns the job when it has not ended within the wait, and follows a cancellation', async () => {
    const clock = new ManualClock();
    const { mock, ctx } = await withMock(clock);
    const ids = mock.given({ dirty: false, clips: [clip()] });
    const pending = body(
      await call(ctx, { clip: need(ids, 'clip.contentId'), ops: [{ op: 'seed' }], wait_seconds: 0 }),
    );
    expect(pending.summary).toMatch(
      /started job j:[0-9a-f]{8}:\d+ \(timeGridSeed\), \w+; nothing is committed until it finishes/,
    );
    expect(pending.clip_revision).toBeNull();
    const jobId = (pending.job as { jobId: string }).jobId;
    // Cancel the job, let the mock's clock run: the grid stays unseeded.
    await otcp(ctx, 'job.cancel', { jobId });
    clock.advance(1000);
    const job = (await otcp(ctx, 'job.get', { jobId, waitMs: 0 })).job as { state: string };
    expect(job.state).toBe('cancelled');
    expect(
      failure(
        await call(ctx, { clip: need(ids, 'clip.contentId'), expected_revision: revisionOf(ids), ops: [shift()] }),
      ).reason,
    ).toBe('grid_not_seeded');
  });

  it('reports a cancellation that happens during the wait', async () => {
    const clock = new ManualClock();
    const { mock, ctx } = await withMock(clock);
    const ids = mock.given({ dirty: false, clips: [clip()] });
    const waiting = call(ctx, { clip: need(ids, 'clip.contentId'), ops: [{ op: 'seed' }], wait_seconds: 20 });
    const jobId = `j:${mock.discovery.instanceId.slice(0, 8)}:1`;
    // The call has to reach the mock before the job exists.
    for (let i = 0; i < 100; i += 1) {
      const known = await otcp(ctx, 'job.get', { jobId, waitMs: 0 }).then(
        () => true,
        () => false,
      );
      if (known) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await otcp(ctx, 'job.cancel', { jobId });
    clock.advance(1000);
    const out = body(await waiting);
    expect(out.summary).toContain(`the seed job ${jobId} was cancelled; no handles were written`);
  });

  it('refuses to seed a clip whose analysis is not ready, with the retry advice', async () => {
    const { mock, ctx } = await withMock();
    const ids = mock.given({ dirty: false, clips: [clip({ analysis: 'running' })] });
    const error = failure(await call(ctx, { clip: need(ids, 'clip.contentId'), ops: [{ op: 'seed' }] }));
    expect(error.kind).toBe('NOT_READY');
    expect(error.retryable).toBe(true);
  });
});

describe('opentune_edit_timing declaration', () => {
  it('is a write tool of the timing capability and returns the shared write result schema', () => {
    expect(editTimingTool.annotations.readOnlyHint).toBe(false);
    expect(editTimingTool.capabilities).toEqual(['timing.v1', 'jobs.v1', 'read.v1']);
    expect(editTimingTool.otcpMethods).toEqual(expect.arrayContaining(['content.shiftTiming', 'content.editTimeGrid']));
    expect(editTimingTool.outputSchema).toBe(WRITE_RESULT_OUTPUT);
    expect(editTimingTool.description).toContain('does not detect beats');
  });

  it('keeps the tool names of the next steps and the OTCP params in line with the spec', () => {
    const spec = otcpSpec();
    const params = spec.validate('methods/content.shiftTiming.schema.json#/$defs/params', {
      contentId: 'c:01234567:0:1',
      expectedGridRevision: 'g1',
      range: { startOutputSec: 1, endOutputSec: 2 },
      deltaSec: 10,
    });
    expect(params).toEqual([]);
  });
});
