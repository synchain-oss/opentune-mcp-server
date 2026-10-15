// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The mock's import job beyond what the contract vectors show: where the clips are placed for each
// layout, errors of single items, analysis and note generation, cancellation between files, the
// idempotency key, revealed tracks and the job limit. The audio is generated at run time in a
// temporary directory of its own and deleted afterwards.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ManualClock } from '../../mock/clock.js';
import { IMPORT_ANALYSIS_MS, IMPORT_ITEM_MS } from '../../mock/import.js';
import { JOB_RETENTION_COUNT } from '../../mock/jobs.js';
import { TRACK_SLOTS } from '../../mock/model.js';
import { Sessions, clip, type TestSession } from '../support/mock-client.js';
import { wavFile, type WavOptions } from '../support/wav-file.js';

const sessions = new Sessions();
const dirs: string[] = [];
afterEach(async () => {
  await sessions.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Item {
  path: string;
  imported: boolean;
  trackId: number | null;
  startTimelineSec: number | null;
  durationSec: number | null;
  f0State: string | null;
  notesGenerated: boolean;
  notesGeneratedBy: string | null;
  error: { data: { kind: string; reason: string } } | null;
}

interface JobShape {
  jobId: string;
  state: string;
  finishedAtMs: number | null;
  result: {
    items: Item[];
    counts: { requested: number; imported: number; failed: number };
    warnings: { code: string; subject: Record<string, unknown> | null }[];
    sideEffects: Record<string, { trackIds?: number[]; contentIds?: string[] }>;
    undo: { reason: string; revert: unknown };
    noOp: boolean;
    dirty: { before: boolean; after: boolean };
    revisionDiff: { trackState: unknown };
  } | null;
}

async function open() {
  const clock = new ManualClock();
  const session = await sessions.open({ clock });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-import-test-'));
  dirs.push(dir);
  const audio = (name: string, options: WavOptions = { seconds: 2 }) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, wavFile(options));
    return file;
  };
  return { clock, session, dir, audio };
}

const jobOf = async (session: TestSession, jobId: string) => (await session.ok('job.get', { jobId })).job as JobShape;

async function run(session: TestSession, clock: ManualClock, params: Record<string, unknown>) {
  const jobId = ((await session.ok('import.start', params)).job as { jobId: string }).jobId;
  for (let i = 0; i < 200; i++) {
    clock.advance(IMPORT_ITEM_MS);
    const job = await jobOf(session, jobId);
    if (job.finishedAtMs !== null) return job;
  }
  throw new Error('the job did not end');
}

describe('where clips go', () => {
  it('appends a clip after the last clip of its track, as the UI does', async () => {
    const { clock, session, audio } = await open();
    session.mock.given({ clips: [clip({ trackId: 1, startTimelineSec: 1, durationSec: 3 })] });
    const job = await run(session, clock, { items: [{ path: audio('a.wav') }], layout: 'single', trackId: 1 });
    expect(job.result?.items[0]).toMatchObject({ trackId: 1, startTimelineSec: 4, durationSec: 2 });
  });

  it('places sequential files end to end from startTimelineSec, with no gap for a failed file', async () => {
    const { clock, session, audio, dir } = await open();
    const items = [
      { path: audio('a.wav', { seconds: 2 }) },
      { path: path.join(dir, 'missing.wav') },
      { path: audio('c.wav', { seconds: 3 }) },
      { path: audio('d.wav', { seconds: 1 }) },
    ];
    const job = await run(session, clock, { items, layout: 'sequential', trackId: 2, startTimelineSec: 5 });
    expect(job.result?.items.map((i) => [i.trackId, i.startTimelineSec])).toEqual([
      [2, 5],
      [null, null],
      [2, 7],
      [2, 10],
    ]);
    expect(job.result?.counts).toEqual({ requested: 4, imported: 3, failed: 1 });
  });

  it('puts separate tracks on consecutive tracks, none spent on a failed file, all at startTimelineSec', async () => {
    const { clock, session, audio, dir } = await open();
    const items = [{ path: path.join(dir, 'missing.wav') }, { path: audio('a.wav') }, { path: audio('b.wav') }];
    const job = await run(session, clock, { items, layout: 'separateTracks', trackId: 3, startTimelineSec: 1 });
    expect(job.result?.items.map((i) => [i.trackId, i.startTimelineSec])).toEqual([
      [null, null],
      [3, 1],
      [4, 1],
    ]);
  });

  it('takes the first track without clips for newTrack, and the active track otherwise', async () => {
    const { clock, session, audio } = await open();
    session.mock.given({ clips: [clip({ trackId: 0 }), clip({ bind: 'other', trackId: 1 })] });
    const first = await run(session, clock, { items: [{ path: audio('a.wav') }], layout: 'single', newTrack: true });
    expect(first.result?.items[0]?.trackId).toBe(2);
    const second = await run(session, clock, { items: [{ path: audio('b.wav') }], layout: 'single' });
    expect(second.result?.items[0]?.trackId).toBe(0);
  });

  it('refuses newTrack when every track holds a clip, and an unknown track in every layout', async () => {
    const { session, audio } = await open();
    session.mock.given({
      clips: Array.from({ length: TRACK_SLOTS }, (_, trackId) => clip({ bind: `c${String(trackId)}`, trackId })),
    });
    const items = [{ path: audio('a.wav') }];
    expect((await session.fails('import.start', { items, layout: 'single', newTrack: true })).data).toMatchObject({
      reason: 'track_capacity',
    });
    for (const layout of ['single', 'sequential', 'separateTracks']) {
      expect((await session.fails('import.start', { items, layout, trackId: TRACK_SLOTS })).data).toMatchObject({
        kind: 'NOT_FOUND',
        reason: 'unknown_handle',
      });
    }
  });

  it('reveals a hidden track that now holds a clip, and says so', async () => {
    const { clock, session, audio } = await open();
    const job = await run(session, clock, { items: [{ path: audio('a.wav') }], layout: 'single', trackId: 6 });
    expect(job.result?.sideEffects.tracksRevealed?.trackIds).toEqual([4, 5, 6]);
    expect(job.result?.warnings.map((w) => w.code)).toContain('TRACK_AUTO_REVEALED');
    expect(job.result?.revisionDiff.trackState).not.toBeNull();
    expect(await session.ok('project.get')).toMatchObject({ visibleTrackCount: 7 });
  });
});

describe('items that fail', () => {
  it('reports each error on its item and imports the rest', async () => {
    const { clock, session, audio, dir } = await open();
    const locked = session.mock.given({ files: [{ bind: 'locked', kind: 'noAccess' }] }).locked ?? '';
    fs.writeFileSync(path.join(dir, 'garbled.wav'), 'not audio');
    const items = [
      { path: audio('ok.wav') },
      { path: audio('three.wav', { seconds: 1, channels: 3 }) },
      { path: audio('long.wav', { seconds: 700, rate: 100 }) },
      { path: path.join(dir, 'garbled.wav') },
      { path: locked },
      { path: dir.replace(/[\\/]$/, '') + path.sep + 'sub.wav' },
    ];
    fs.mkdirSync(path.join(dir, 'sub.wav'));
    const job = await run(session, clock, { items, layout: 'sequential', trackId: 0 });
    expect(job.result?.items.map((i) => i.error?.data.reason ?? null)).toEqual([
      null,
      'too_many_channels',
      'audio_too_long',
      'unsupported_format',
      'read_failed',
      'read_failed',
    ]);
    expect(job.result?.items.map((i) => i.imported)).toEqual([true, false, false, false, false, false]);
    expect(job.result?.counts).toEqual({ requested: 6, imported: 1, failed: 5 });
  });

  it('keeps a clip whose analysis failed, with f0State failed and the error ANALYSIS_FAILED', async () => {
    const { clock, session, audio } = await open();
    session.mock.failNextAnalysis(1);
    const items = [{ path: audio('a.wav') }, { path: audio('b.wav') }];
    const job = await run(session, clock, { items, layout: 'sequential', trackId: 0, generateNotes: true });
    expect(job.result?.items[0]).toMatchObject({
      imported: true,
      f0State: 'failed',
      notesGenerated: false,
      error: { data: { kind: 'ANALYSIS_FAILED', reason: 'f0_failed' } },
    });
    expect(job.result?.items[1]).toMatchObject({
      f0State: 'ready',
      notesGenerated: true,
      notesGeneratedBy: 'request',
      error: null,
    });
    expect(job.result?.counts).toMatchObject({ imported: 2, failed: 0 });
  });

  it('is a no-op that does not mark the project as changed when nothing was imported', async () => {
    const { clock, session, dir } = await open();
    const job = await run(session, clock, { items: [{ path: path.join(dir, 'missing.wav') }], layout: 'single' });
    expect(job.result).toMatchObject({
      noOp: true,
      dirty: { before: false, after: false },
      undo: { reason: 'no_op', revert: null },
      warnings: [],
    });
  });
});

describe('analysis and notes', () => {
  it('generates notes only on request, or for the focused clip in the openDyne scheme', async () => {
    const { clock, session, audio } = await open();
    const items = [
      { path: audio('a.wav') },
      { path: audio('b.wav') },
      { path: audio('c.wav', { seconds: 2, voiced: false }) },
    ];
    const plain = await run(session, clock, { items, layout: 'sequential', trackId: 0 });
    expect(plain.result?.items.map((i) => i.notesGeneratedBy)).toEqual([null, null, null]);
    expect(plain.result?.items.map((i) => i.f0State)).toEqual(['ready', 'ready', 'ready']);

    session.mock.given({ editingScheme: 'openDyne' });
    const dyne = await run(session, clock, { items, layout: 'sequential', trackId: 1 });
    // The focused clip is the last one imported, and it has no voice, so nothing is generated.
    expect(dyne.result?.items.map((i) => i.notesGeneratedBy)).toEqual([null, null, null]);
    const unfocused = await run(session, clock, {
      items: items.slice(0, 2),
      layout: 'sequential',
      trackId: 2,
      focus: false,
    });
    expect(unfocused.result?.items.map((i) => i.notesGeneratedBy)).toEqual([null, null]);
    const focused = await run(session, clock, { items: items.slice(0, 2), layout: 'sequential', trackId: 3 });
    expect(focused.result?.items.map((i) => i.notesGeneratedBy)).toEqual([null, 'focus']);
    expect(focused.result?.warnings.map((w) => w.code)).toEqual(['SELECTION_GENERATED_NOTES', 'IRREVERSIBLE']);
    // A request wins over focus for the clip both apply to.
    const asked = await run(session, clock, {
      items: items.slice(0, 2),
      layout: 'sequential',
      trackId: 4,
      generateNotes: true,
    });
    expect(asked.result?.items.map((i) => i.notesGeneratedBy)).toEqual(['request', 'request']);
    expect(asked.result?.sideEffects).not.toHaveProperty('notesGenerated');
  });

  it('writes the generated notes into the content and selects the last clip', async () => {
    const { clock, session, audio } = await open();
    const job = await run(session, clock, {
      items: [{ path: audio('a.wav', { seconds: 4 }) }],
      layout: 'single',
      generateNotes: true,
    });
    const project = await session.ok('project.get');
    const placement = (project.placements as { placementId: string; contentId: string }[])[0];
    expect(project.selection).toMatchObject({ selectedPlacementIds: [placement?.placementId] });
    const notes = await session.ok('content.getNotes', { contentId: placement?.contentId });
    expect(notes.totalCount).toBeGreaterThan(0);
    expect(job.result?.items[0]?.notesGenerated).toBe(true);
  });

  it('keeps the job running until the analysis of every clip has finished', async () => {
    const { clock, session, audio } = await open();
    const jobId = (
      (await session.ok('import.start', { items: [{ path: audio('a.wav') }], layout: 'single' })).job as {
        jobId: string;
      }
    ).jobId;
    clock.advance(0);
    const running = await jobOf(session, jobId);
    expect(running.state).toBe('running');
    const content = (await session.ok('project.get')).placements as { contentId: string }[];
    expect((await session.ok('content.getDetails', { contentId: content[0]?.contentId })).analysis).toMatchObject({
      f0State: 'extracting',
    });
    clock.advance(IMPORT_ITEM_MS);
    expect((await jobOf(session, jobId)).state).toBe('running');
    clock.advance(IMPORT_ANALYSIS_MS);
    expect((await jobOf(session, jobId)).state).toBe('succeeded');
  });
});

describe('cancellation', () => {
  it('stops before the next file is committed and reports the clips committed before', async () => {
    const { clock, session, audio } = await open();
    const items = [{ path: audio('a.wav') }, { path: audio('b.wav') }, { path: audio('c.wav') }];
    const jobId = (
      (await session.ok('import.start', { items, layout: 'sequential', trackId: 0 })).job as { jobId: string }
    ).jobId;
    clock.advance(0);
    expect((await session.ok('job.cancel', { jobId })).cancelRequested).toBe(true);
    clock.advance(0);
    const job = await jobOf(session, jobId);
    expect(job).toMatchObject({ state: 'cancelled' });
    expect(job.result?.items).toHaveLength(1);
    expect(job.result?.counts).toEqual({ requested: 3, imported: 1, failed: 0 });
    expect((await session.ok('project.get')).placements).toHaveLength(1);
  });

  it('can be cancelled before the first file', async () => {
    const { clock, session, audio } = await open();
    const jobId = (
      (await session.ok('import.start', { items: [{ path: audio('a.wav') }], layout: 'single' })).job as {
        jobId: string;
      }
    ).jobId;
    await session.ok('job.cancel', { jobId });
    clock.advance(0);
    const job = await jobOf(session, jobId);
    expect(job).toMatchObject({ state: 'cancelled', result: { noOp: true } });
    expect((await session.ok('project.get')).placements).toHaveLength(0);
  });
});

describe('the idempotency key and the job limit', () => {
  it('returns the job of a retained key also after it ended', async () => {
    const { clock, session, audio } = await open();
    const params = { items: [{ path: audio('a.wav') }], layout: 'single', idempotencyKey: 'once' };
    const first = await run(session, clock, params);
    const again = (await session.ok('import.start', params)).job as { jobId: string; state: string };
    expect(again).toMatchObject({ jobId: first.jobId, state: 'succeeded' });
    expect((await session.ok('project.get')).placements).toHaveLength(1);
  });

  it('treats defaults as given: the same key with the explicit defaults is the same call', async () => {
    const { session, audio } = await open();
    const file = audio('a.wav');
    const first = (await session.ok('import.start', { items: [{ path: file }], layout: 'single', idempotencyKey: 'k' }))
      .job as {
      jobId: string;
    };
    const second = (
      await session.ok('import.start', {
        items: [{ path: file }],
        layout: 'single',
        idempotencyKey: 'k',
        newTrack: false,
        generateNotes: false,
        focus: true,
      })
    ).job as { jobId: string };
    expect(second.jobId).toBe(first.jobId);
    const other = await session.fails('import.start', {
      items: [{ path: file }],
      layout: 'single',
      idempotencyKey: 'k',
      focus: false,
    });
    expect(other.data).toMatchObject({ reason: 'idempotency_key_reused' });
  });

  it('fails with BUSY(job_limit) when every retained job is still active', async () => {
    const { session, audio } = await open();
    const file = audio('a.wav');
    for (let n = 0; n < JOB_RETENTION_COUNT; n++)
      await session.ok('import.start', { items: [{ path: file }], layout: 'single' });
    const refused = await session.fails('import.start', { items: [{ path: file }], layout: 'single' });
    expect(refused.data).toMatchObject({ kind: 'BUSY', reason: 'job_limit' });
  });

  it('is refused while the UI is busy, and for a bad path before anything else', async () => {
    const { session, audio } = await open();
    session.mock.setBusy({ pointerDown: true });
    const items = [{ path: audio('a.wav') }];
    expect((await session.fails('import.start', { items, layout: 'single' })).data).toMatchObject({
      kind: 'BUSY',
      reason: 'pointer_down',
    });
    const refused = await session.fails('import.start', {
      items: [{ path: items[0]?.path.replace(/\.wav$/, '.ogg') }],
      layout: 'single',
    });
    expect(refused.data).toMatchObject({ reason: 'path_bad_extension' });
    expect(refused.data.detail).not.toContain(path.basename(items[0]?.path ?? ''));
  });
});
