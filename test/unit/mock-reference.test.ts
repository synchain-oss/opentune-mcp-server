// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The mock's reference alignment beyond what the contract vectors show: the job and its
// cancellation point, joining a running job, AUTO in mode reference as one undo step, and the
// checks the job repeats.

import { afterEach, describe, expect, it } from 'vitest';

import { ManualClock } from '../../mock/clock.js';
import { Sessions, clip, type TestSession } from '../support/mock-client.js';

const sessions = new Sessions();
afterEach(async () => {
  await sessions.dispose();
});

const field = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], value);

const targets = (session: TestSession, index = 0) =>
  session.mock.snapshot().contents[index]?.notes.map((n) => n.targetMidi);

async function setup(clock?: ManualClock) {
  const session = await sessions.open(clock === undefined ? {} : { clock });
  const ids = session.mock.given({
    clips: [
      clip({
        bind: 'ref',
        startTimelineSec: 0,
        notes: [
          { startContentSec: 0.5, endContentSec: 1.5, targetMidi: 60 },
          { startContentSec: 2, endContentSec: 3, targetMidi: 62 },
        ],
      }),
      clip({
        bind: 'clip',
        startTimelineSec: 0,
        notes: [
          { startContentSec: 0.5, endContentSec: 1.5, targetMidi: 70 },
          { startContentSec: 2, endContentSec: 3, targetMidi: 71 },
        ],
        referenceClip: 'ref',
      }),
    ],
  });
  return { session, ids };
}

describe('content.analyzeReference', () => {
  it('runs as a job, joins a call for the same clip while it runs, and leaves the edit alone', async () => {
    const clock = new ManualClock();
    const { session, ids } = await setup(clock);
    const { ok } = session;
    const details = async () =>
      field(await ok('content.getDetails', { contentId: ids['clip.contentId'] }), 'reference');
    expect(await details()).toMatchObject({ alignmentReady: false });
    const before = session.mock.snapshot();

    const first = await ok('content.analyzeReference', { placementId: ids['clip.placementId'] });
    clock.advance(0);
    const second = await ok('content.analyzeReference', { placementId: ids['clip.placementId'] });
    expect(field(second, 'job', 'jobId')).toBe(field(first, 'job', 'jobId'));
    expect(field(second, 'job', 'state')).toBe('running');

    clock.advance(1000);
    const { job } = (await ok('job.get', { jobId: field(first, 'job', 'jobId') })) as { job: Record<string, unknown> };
    expect(job).toMatchObject({
      state: 'succeeded',
      result: {
        placementId: ids['clip.placementId'],
        referencePlacementId: ids['ref.placementId'],
        alignmentReady: true,
      },
    });
    expect(await details()).toMatchObject({ alignmentReady: true });
    // The data is derived: no edit, no undo entry, no unsaved changes.
    expect(session.mock.snapshot()).toEqual(before);
    expect(field(await ok('edit.getHistory'), 'history', 'undoCount')).toBe(0);
    // A new call after the job ended starts a new job.
    const third = await ok('content.analyzeReference', { placementId: ids['clip.placementId'] });
    expect(field(third, 'job', 'jobId')).not.toBe(field(first, 'job', 'jobId'));
  });

  it('can be cancelled before it stores anything', async () => {
    const clock = new ManualClock();
    const { session, ids } = await setup(clock);
    const { ok } = session;
    const started = await ok('content.analyzeReference', { placementId: ids['clip.placementId'] });
    clock.advance(0);
    await ok('job.cancel', { jobId: field(started, 'job', 'jobId') });
    clock.advance(1000);
    expect(((await ok('job.get', { jobId: field(started, 'job', 'jobId') })).job as { state: string }).state).toBe(
      'cancelled',
    );
    expect(field(await ok('content.getDetails', { contentId: ids['clip.contentId'] }), 'reference')).toMatchObject({
      alignmentReady: false,
    });
  });

  describe('checks again when the job runs', () => {
    const changes: [string, (session: TestSession, ids: Record<string, unknown>) => Promise<void>, string][] = [
      [
        'the clip was deleted',
        async ({ ok }, ids) => {
          const revision = ((await ok('project.get')).asOf as { arrangementRevision: string }).arrangementRevision;
          await ok('arrangement.edit', {
            expectedArrangementRevision: revision,
            ops: [{ op: 'delete', placementIds: [ids['clip.placementId']] }],
            confirm: true,
          });
        },
        'unknown_handle',
      ],
      [
        'the binding was removed',
        async ({ ok }, ids) => {
          const revision = ((await ok('project.get')).asOf as { arrangementRevision: string }).arrangementRevision;
          await ok('arrangement.edit', {
            expectedArrangementRevision: revision,
            ops: [{ op: 'setReference', placementId: ids['clip.placementId'], referencePlacementId: null }],
          });
        },
        'reference_not_bound',
      ],
      [
        'another project was opened',
        async ({ ok }, ids) => {
          await ok('project.open', { path: ids.other });
        },
        'unknown_handle',
      ],
    ];
    it.each(changes)(
      'ends the job with the error of the check and stores nothing when %s',
      async (_name, change, reason) => {
        const clock = new ManualClock();
        const session = await sessions.open({ clock });
        const ids = session.mock.given({
          files: [{ bind: 'other', kind: 'project', durationSec: 3 }],
          clips: [
            clip({ bind: 'ref', startTimelineSec: 0 }),
            clip({ bind: 'clip', startTimelineSec: 0, referenceClip: 'ref' }),
          ],
        });
        const started = await session.ok('content.analyzeReference', { placementId: ids['clip.placementId'] });
        const jobId = String(field(started, 'job', 'jobId'));
        await change(session, ids);
        clock.advance(5000);
        const { job } = (await session.ok('job.get', { jobId })) as {
          job: { state: string; error: { data: Record<string, unknown> } | null };
        };
        expect(job.state).toBe('failed');
        const kind = reason === 'reference_not_bound' ? 'INVALID_ARGUMENT' : 'NOT_FOUND';
        expect(job.error?.data).toMatchObject({ kind, reason, executed: false });
      },
    );
  });

  it('needs a binding and finished analyses of both clips', async () => {
    const { session, ids } = await setup();
    const { mock, fails } = session;
    expect((await fails('content.analyzeReference', { placementId: ids['ref.placementId'] })).data).toMatchObject({
      reason: 'reference_not_bound',
    });
    mock.setAnalysis(String(ids['ref.contentId']), 'running');
    expect((await fails('content.analyzeReference', { placementId: ids['clip.placementId'] })).data).toMatchObject({
      kind: 'NOT_READY',
      reason: 'f0_not_ready',
    });
    mock.setAnalysis(String(ids['ref.contentId']), 'failed');
    expect((await fails('content.analyzeReference', { placementId: ids['clip.placementId'] })).data).toMatchObject({
      kind: 'NOT_READY',
      reason: 'f0_failed',
    });
  });
});

describe('content.autoTune in mode reference', () => {
  it('aligns the notes to the reference clip in one undo step that undo and redo take back and forth', async () => {
    const { session, ids } = await setup();
    const { ok } = session;
    const before = targets(session, 1);
    expect(before).toEqual([70, 71]);
    const revision = (await ok('content.getDetails', { contentId: ids['clip.contentId'] })).asOf as {
      contents: { revision: string }[];
    };
    const started = await ok('content.autoTune', {
      contentId: ids['clip.contentId'],
      mode: 'reference',
      placementId: ids['clip.placementId'],
      expectedRevision: revision.contents[0]?.revision,
    });
    expect(started).toMatchObject({
      applied: false,
      mode: 'reference',
      keyUsed: null,
      paramsUsed: null,
      noteCount: null,
    });
    const { job } = (await ok('job.get', { jobId: field(started, 'job', 'jobId'), waitMs: 5000 })) as {
      job: { state: string; result: Record<string, unknown> };
    };
    expect(job.state).toBe('succeeded');
    expect(job.result).toMatchObject({
      applied: true,
      mode: 'reference',
      noteCount: { before: 2, after: 2 },
      undo: { undoable: true, steps: 1 },
      dirty: { after: true },
    });
    expect(targets(session, 1)).toEqual([60, 62]);
    expect(field(await ok('content.getDetails', { contentId: ids['clip.contentId'] }), 'reference')).toMatchObject({
      alignmentReady: true,
    });

    const undoId = field(job.result, 'undo', 'undoId');
    await ok('edit.undo', { expectedUndoId: undoId });
    expect(targets(session, 1)).toEqual(before);
    await ok('edit.redo', { expectedUndoId: undoId });
    expect(targets(session, 1)).toEqual([60, 62]);
  });

  it('checks the placement, the binding and the revision before it starts a job', async () => {
    const { session, ids } = await setup();
    const { fails, ok } = session;
    const revision = (
      (await ok('content.getDetails', { contentId: ids['clip.contentId'] })).asOf as {
        contents: { revision: string }[];
      }
    ).contents[0]?.revision;
    const call = (extra: Record<string, unknown>) =>
      fails('content.autoTune', { mode: 'reference', expectedRevision: revision, ...extra });
    expect((await call({ contentId: ids['clip.contentId'], placementId: ids['ref.placementId'] })).data).toMatchObject({
      reason: 'placement_content_mismatch',
    });
    const refRevision = (
      (await ok('content.getDetails', { contentId: ids['ref.contentId'] })).asOf as { contents: { revision: string }[] }
    ).contents[0]?.revision;
    expect(
      (
        await call({
          contentId: ids['ref.contentId'],
          placementId: ids['ref.placementId'],
          expectedRevision: refRevision,
        })
      ).data,
    ).toMatchObject({ reason: 'reference_not_bound' });
    expect(
      (await call({ contentId: ids['clip.contentId'], placementId: ids['clip.placementId'], expectedRevision: 'old' }))
        .data,
    ).toMatchObject({ kind: 'REVISION_CONFLICT', reason: 'content_changed' });
  });

  it('is a no-op when the notes already follow the reference, and fails the job when the binding went away meanwhile', async () => {
    const clock = new ManualClock();
    const { session, ids } = await setup(clock);
    const { ok } = session;
    const request = async () => ({
      contentId: ids['clip.contentId'],
      mode: 'reference',
      placementId: ids['clip.placementId'],
      expectedRevision: (
        (await ok('content.getDetails', { contentId: ids['clip.contentId'] })).asOf as {
          contents: { revision: string }[];
        }
      ).contents[0]?.revision,
    });
    const result = async (started: Record<string, unknown>) => {
      clock.advance(1000);
      return (await ok('job.get', { jobId: field(started, 'job', 'jobId') })).job as {
        state: string;
        result: Record<string, unknown> | null;
        error: { data: Record<string, unknown> } | null;
      };
    };
    expect((await result(await ok('content.autoTune', await request()))).state).toBe('succeeded');
    const again = await result(await ok('content.autoTune', await request()));
    expect(again.result).toMatchObject({ applied: true, noOp: true, changes: [], noteCount: { before: 2, after: 2 } });

    // The binding is removed after the call was accepted and before the job runs.
    const doomed = await ok('content.autoTune', await request());
    const revision = ((await ok('project.get')).asOf as { arrangementRevision: string }).arrangementRevision;
    await ok('arrangement.edit', {
      expectedArrangementRevision: revision,
      ops: [{ op: 'setReference', placementId: ids['clip.placementId'], referencePlacementId: null }],
    });
    const failed = await result(doomed);
    expect(failed.state).toBe('failed');
    // The job ends with the error of the check it repeats (x-otcp.jobErrors).
    expect(failed.error?.data).toMatchObject({ kind: 'INVALID_ARGUMENT', reason: 'reference_not_bound' });
  });
});
