// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The mock's export job beyond what the contract vectors show: the three ifExists behaviours and
// the final rename that never replaces, a revision that changes while the file is written, the
// readiness wait driven by the clock, fault injection, cancellation, joining an identical job, and
// loaded media found by file identity.

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ManualClock } from '../../mock/clock.js';
import { EXPORT_POLL_MS, EXPORT_SAMPLE_RATE_HZ, EXPORT_WAIT_LIMIT_MS, EXPORT_WRITE_MS } from '../../mock/export.js';
import { Sessions, clip, type TestSession } from '../support/mock-client.js';

const sessions = new Sessions();
afterEach(async () => {
  await sessions.dispose();
});

interface JobShape {
  jobId: string;
  state: string;
  finishedAtMs: number | null;
  result: Record<string, unknown> | null;
  error: { data: { kind: string; reason: string } } | null;
}

async function open() {
  const clock = new ManualClock();
  const session = await sessions.open({ clock });
  return { clock, session };
}

const jobOf = async (session: TestSession, jobId: string) => (await session.ok('job.get', { jobId })).job as JobShape;

async function start(session: TestSession, params: Record<string, unknown>) {
  const result = await session.ok('export.start', params);
  return (result.job as { jobId: string }).jobId;
}

/** Moves the clock in steps until the job ends. */
async function finish(session: TestSession, clock: ManualClock, jobId: string, stepMs = EXPORT_POLL_MS) {
  for (let i = 0; i < 2000; i++) {
    clock.advance(stepMs);
    const job = await jobOf(session, jobId);
    if (job.finishedAtMs !== null) return job;
  }
  throw new Error('the job did not end');
}

const filesIn = (dir: string) => fs.readdirSync(dir).sort();
const clipGiven = { clips: [clip()] };

describe('ifExists and the final rename', () => {
  it('error: refuses an existing target at once, and fails the job when a file appears before the rename', async () => {
    const { clock, session } = await open();
    const ids = session.mock.given({
      ...clipGiven,
      files: [
        { bind: 'existing', kind: 'existing' },
        { bind: 'out', kind: 'absent' },
      ],
    });
    const params = { kind: 'clip', target: { placementId: ids['clip.placementId'] } };
    const before = fs.readFileSync(ids.existing ?? '', 'utf8');
    const refused = await session.fails('export.start', { ...params, path: ids.existing });
    expect(refused.data).toMatchObject({ kind: 'ALREADY_EXISTS', reason: 'target_exists', executed: false });
    expect(fs.readFileSync(ids.existing ?? '', 'utf8')).toBe(before);

    const jobId = await start(session, { ...params, path: ids.out });
    clock.advance(0);
    // The temporary file sits in the target directory while the job waits to rename it.
    const dir = path.dirname(ids.out ?? '');
    expect(filesIn(dir).some((name) => name.endsWith('.tmp'))).toBe(true);
    fs.writeFileSync(ids.out ?? '', 'someone else was faster');
    const job = await finish(session, clock, jobId, EXPORT_WRITE_MS);
    expect(job).toMatchObject({
      state: 'failed',
      error: { data: { kind: 'ALREADY_EXISTS', reason: 'target_exists' } },
    });
    expect(fs.readFileSync(ids.out ?? '', 'utf8')).toBe('someone else was faster');
    expect(filesIn(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rename: takes the next free name and never replaces a file', async () => {
    const { clock, session } = await open();
    const ids = session.mock.given({ ...clipGiven, files: [{ bind: 'existing', kind: 'existing' }] });
    const dir = path.dirname(ids.existing ?? '');
    fs.writeFileSync(ids['existing.next'] ?? '', 'taken too');
    const params = {
      kind: 'clip',
      target: { placementId: ids['clip.placementId'] },
      path: ids.existing,
      ifExists: 'rename',
    };
    const job = await finish(session, clock, await start(session, params));
    expect(job.state).toBe('succeeded');
    expect(job.result?.path).toBe(path.join(dir, 'existing (3).wav'));
    expect(fs.readFileSync(ids.existing ?? '', 'utf8')).toBe('existing file');
    expect(fs.readFileSync(ids['existing.next'] ?? '', 'utf8')).toBe('taken too');
    expect(fs.existsSync(path.join(dir, 'existing (3).wav'))).toBe(true);
    expect(filesIn(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rename: fails with ALREADY_EXISTS when all 999 names are taken', async () => {
    const { clock, session } = await open();
    const ids = session.mock.given({ ...clipGiven, files: [{ bind: 'existing', kind: 'existing' }] });
    const dir = path.dirname(ids.existing ?? '');
    for (let n = 2; n <= 999; n++) fs.writeFileSync(path.join(dir, `existing (${String(n)}).wav`), 'x');
    const params = { kind: 'master', path: ids.existing, ifExists: 'rename' };
    const job = await finish(session, clock, await start(session, params));
    expect(job).toMatchObject({ state: 'failed', error: { data: { reason: 'target_exists' } } });
  });

  it('overwrite: replaces an existing file with a WAV file of the export', async () => {
    const { clock, session } = await open();
    const ids = session.mock.given({ ...clipGiven, files: [{ bind: 'existing', kind: 'existing' }] });
    const params = { kind: 'master', path: ids.existing, ifExists: 'overwrite' };
    const job = await finish(session, clock, await start(session, params));
    expect(job.state).toBe('succeeded');
    expect(job.result).toMatchObject({
      path: ids.existing,
      channelCount: 2,
      sampleRateHz: EXPORT_SAMPLE_RATE_HZ,
      durationSec: 8,
      startTimelineSec: 0,
    });
    const file = fs.readFileSync(ids.existing ?? '');
    expect(file.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(file.length).toBe(44 + 8 * EXPORT_SAMPLE_RATE_HZ * 2 * 4);
  });

  it('exports a track as mono audio from time 0 and a clip from its own start', async () => {
    const { clock, session } = await open();
    const ids = session.mock.given({ ...clipGiven, files: [{ bind: 'out', kind: 'absent' }] });
    const dir = path.dirname(ids.out ?? '');
    const track = await finish(
      session,
      clock,
      await start(session, { kind: 'track', target: { trackId: 0 }, path: ids.out }),
    );
    expect(track.result).toMatchObject({ channelCount: 1, startTimelineSec: 0, durationSec: 8 });
    const second = path.join(dir, 'second.wav');
    const target = { placementId: ids['clip.placementId'] };
    const one = await finish(session, clock, await start(session, { kind: 'clip', target, path: second }));
    expect(one.result).toMatchObject({ channelCount: 1, startTimelineSec: 2, durationSec: 6 });
    // A track without clips gives an empty file rather than an error.
    const empty = await finish(
      session,
      clock,
      await start(session, { kind: 'track', target: { trackId: 3 }, path: path.join(dir, 'empty.wav') }),
    );
    expect(empty.result).toMatchObject({ durationSec: 0, dryContents: [] });
    expect(fs.statSync(path.join(dir, 'empty.wav')).size).toBe(44);
  });
});

describe('a content that changes', () => {
  it('fails with REVISION_CONFLICT and leaves the target untouched when it changes after the revisions were recorded', async () => {
    const { clock, session } = await open();
    const ids = session.mock.given({ ...clipGiven, files: [{ bind: 'existing', kind: 'existing' }] });
    const params = { kind: 'master', path: ids.existing, ifExists: 'overwrite' };
    const jobId = await start(session, params);
    clock.advance(0);
    // The file is being written now; the content changes before the final check.
    session.mock.setAnalysis(ids['clip.contentId'] ?? '', 'ready');
    const job = await finish(session, clock, jobId, EXPORT_WRITE_MS);
    expect(job).toMatchObject({ state: 'failed', error: { data: { kind: 'REVISION_CONFLICT' } } });
    expect(job.error?.data.reason).toBe('changed_during_export');
    expect(fs.readFileSync(ids.existing ?? '', 'utf8')).toBe('existing file');
    expect(filesIn(path.dirname(ids.existing ?? ''))).toEqual(['existing.wav']);
  });

  it('is no conflict when the revision changed while the job waited for the analysis', async () => {
    const { clock, session } = await open();
    const ids = session.mock.given({
      clips: [clip({ analysis: 'running', notes: [] })],
      files: [{ bind: 'out', kind: 'absent' }],
    });
    const jobId = await start(session, { kind: 'master', path: ids.out });
    clock.advance(0);
    expect((await jobOf(session, jobId)).state).toBe('running');
    clock.advance(EXPORT_POLL_MS * 3);
    expect((await jobOf(session, jobId)).state).toBe('running');
    session.mock.setAnalysis(ids['clip.contentId'] ?? '', 'ready');
    const job = await finish(session, clock, jobId);
    // The finished analysis found no notes to render: exported uncorrected, and said so.
    expect(job.state).toBe('succeeded');
    expect(job.result?.dryContents).toEqual([{ contentId: ids['clip.contentId'], reason: 'nothingToRender' }]);
    expect(fs.existsSync(ids.out ?? '')).toBe(true);
  });

  it('fails with NOT_READY(export_wait_timeout) after 120 s and writes nothing', async () => {
    const { clock, session } = await open();
    const ids = session.mock.given({
      clips: [clip({ analysis: 'running', notes: [] })],
      files: [{ bind: 'out', kind: 'absent' }],
    });
    const jobId = await start(session, { kind: 'master', path: ids.out });
    clock.advance(EXPORT_WAIT_LIMIT_MS - EXPORT_POLL_MS);
    expect((await jobOf(session, jobId)).state).toBe('running');
    const job = await finish(session, clock, jobId);
    expect(job).toMatchObject({
      state: 'failed',
      error: { data: { kind: 'NOT_READY', reason: 'export_wait_timeout' } },
    });
    expect(filesIn(path.dirname(ids.out ?? ''))).toEqual([]);
  });
});

describe('analysis and rendering', () => {
  it('exports a content whose analysis failed uncorrected when allowDry is set, and lists it', async () => {
    const { clock, session } = await open();
    const ids = session.mock.given({
      clips: [clip({ analysis: 'failed', notes: [] })],
      files: [{ bind: 'out', kind: 'absent' }],
    });
    const job = await finish(session, clock, await start(session, { kind: 'master', path: ids.out, allowDry: true }));
    expect(job.result?.dryContents).toEqual([{ contentId: ids['clip.contentId'], reason: 'analysisFailed' }]);
  });

  it('queues a failed render again once, and fails if it fails again', async () => {
    const { clock, session } = await open();
    const ids = session.mock.given({
      clips: [clip()],
      files: [
        { bind: 'a', kind: 'absent' },
        { bind: 'b', kind: 'absent' },
      ],
    });
    const contentId = ids['clip.contentId'] ?? '';
    session.mock.failRender(contentId, 1);
    const retried = await finish(session, clock, await start(session, { kind: 'master', path: ids.a }));
    expect(retried.state).toBe('succeeded');

    session.mock.failRender(contentId);
    const failed = await finish(session, clock, await start(session, { kind: 'master', path: ids.b }));
    expect(failed).toMatchObject({
      state: 'failed',
      error: { data: { kind: 'RENDER_FAILED', reason: 'render_chunk_failed' } },
    });
    expect(fs.existsSync(ids.b ?? '')).toBe(false);
  });

  it('waits while a render is pending', async () => {
    const { clock, session } = await open();
    const ids = session.mock.given({
      clips: [clip()],
      history: { undo: [{ bind: 'u1', origin: 'control', action: 'pitchShift', clip: 'clip' }], redo: [] },
      files: [{ bind: 'out', kind: 'absent' }],
    });
    // Undo queues a render, which settles 30 ms later; the export starts writing only after that.
    await session.ok('edit.undo', { expectedUndoId: ids.u1 });
    const jobId = await start(session, { kind: 'master', path: ids.out });
    clock.advance(0);
    expect(fs.existsSync(path.dirname(ids.out ?? ''))).toBe(true);
    expect(filesIn(path.dirname(ids.out ?? ''))).toEqual([]);
    clock.advance(EXPORT_POLL_MS);
    expect(filesIn(path.dirname(ids.out ?? '')).some((name) => name.endsWith('.tmp'))).toBe(true);
    expect((await finish(session, clock, jobId)).state).toBe('succeeded');
  });
});

describe('the job', () => {
  it('can be cancelled until the final rename, which deletes the temporary file', async () => {
    const { clock, session } = await open();
    const ids = session.mock.given({ ...clipGiven, files: [{ bind: 'out', kind: 'absent' }] });
    const jobId = await start(session, { kind: 'master', path: ids.out });
    clock.advance(0);
    const dir = path.dirname(ids.out ?? '');
    expect(filesIn(dir).some((name) => name.endsWith('.tmp'))).toBe(true);
    expect((await session.ok('job.cancel', { jobId })).cancelRequested).toBe(true);
    clock.advance(0);
    expect(await jobOf(session, jobId)).toMatchObject({
      state: 'cancelled',
      error: { data: { reason: 'cancelled_by_request' } },
    });
    expect(filesIn(dir)).toEqual([]);
  });

  it('returns the running job for the same normalized params, and refuses another export while it runs', async () => {
    const { clock, session } = await open();
    const ids = session.mock.given({
      ...clipGiven,
      files: [
        { bind: 'out', kind: 'absent' },
        { bind: 'other', kind: 'absent' },
      ],
    });
    const first = await start(session, { kind: 'master', path: ids.out });
    // ifExists error is the default, so this is the same call.
    expect(await start(session, { kind: 'master', path: ids.out, ifExists: 'error', allowDry: false })).toBe(first);
    const busy = await session.fails('export.start', { kind: 'master', path: ids.other });
    expect(busy.data).toMatchObject({ kind: 'BUSY', reason: 'export_in_progress', retryable: true });
    const done = await finish(session, clock, first);
    expect(done.state).toBe('succeeded');
    const second = await start(session, { kind: 'master', path: ids.other });
    expect(second).not.toBe(first);
    await finish(session, clock, second);
    // A finished job is not joined: the same call starts a new one (and the target now exists).
    expect((await session.fails('export.start', { kind: 'master', path: ids.out })).data).toMatchObject({
      reason: 'target_exists',
    });
  });

  it('stops pending work when the mock stops', async () => {
    const { clock, session } = await open();
    const ids = session.mock.given({ ...clipGiven, files: [{ bind: 'out', kind: 'absent' }] });
    await start(session, { kind: 'master', path: ids.out });
    await session.mock.stop();
    clock.advance(EXPORT_WAIT_LIMIT_MS);
    expect(fs.existsSync(ids.out ?? '')).toBe(false);
  });
});

describe('targets and paths', () => {
  it('refuses a hard link to a source file as loaded media, whatever its name', async () => {
    const { session } = await open();
    const ids = session.mock.given({ ...clipGiven, files: [{ bind: 'out', kind: 'absent' }] });
    const link = ids.out ?? '';
    try {
      fs.linkSync(ids['clip.sourcePath'] ?? '', link);
    } catch {
      return; // no hard links on this file system
    }
    for (const ifExists of ['error', 'rename', 'overwrite']) {
      const refused = await session.fails('export.start', { kind: 'master', path: link, ifExists });
      expect(refused.data).toMatchObject({
        kind: 'INVALID_ARGUMENT',
        reason: 'target_is_loaded_media',
      });
    }
  });

  it('names a missing source file by its directory and name', async () => {
    const { session } = await open();
    const ids = session.mock.given({ ...clipGiven });
    const source = ids['clip.sourcePath'] ?? '';
    fs.rmSync(source);
    const refused = await session.fails('export.start', { kind: 'master', path: source, ifExists: 'overwrite' });
    expect(refused.data).toMatchObject({ reason: 'target_is_loaded_media' });
  });

  it('rejects bad paths before it looks at any file', async () => {
    const { session } = await open();
    session.mock.given(clipGiven);
    for (const [bad, reason] of [
      ['out.wav', 'path_not_absolute'],
      [process.platform === 'win32' ? 'C:\\Music\\..\\x.wav' : '/music/../x.wav', 'path_not_normalized'],
      [process.platform === 'win32' ? 'C:\\Music\\x.mp3' : '/music/x.mp3', 'path_bad_extension'],
    ] as const) {
      const refused = await session.fails('export.start', { kind: 'master', path: bad });
      expect(refused.data).toMatchObject({ kind: 'INVALID_ARGUMENT', reason, executed: false });
    }
  });

  it('refuses an unknown track and a stale placement', async () => {
    const { session } = await open();
    const ids = session.mock.given({ ...clipGiven, files: [{ bind: 'out', kind: 'absent' }] });
    expect(
      (await session.fails('export.start', { kind: 'track', target: { trackId: 99 }, path: ids.out })).data,
    ).toMatchObject({
      reason: 'unknown_handle',
    });
    const stale = session.mock.runnerValue('runner.stalePlacementId');
    expect(
      (await session.fails('export.start', { kind: 'clip', target: { placementId: stale }, path: ids.out })).data,
    ).toMatchObject({
      reason: 'stale_handle',
    });
  });

  it('is refused while the UI is busy', async () => {
    const { session } = await open();
    const ids = session.mock.given({ ...clipGiven, files: [{ bind: 'out', kind: 'absent' }] });
    session.mock.setBusy({ modalOpen: true });
    expect((await session.fails('export.start', { kind: 'master', path: ids.out })).data).toMatchObject({
      kind: 'BUSY',
      reason: 'modal_open',
    });
  });
});
