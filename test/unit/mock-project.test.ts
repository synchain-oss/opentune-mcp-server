// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The mock's project file methods beyond what the contract vectors show: a save and open round
// trip with the revert recipe as given, what opening does to handles and histories, cancelling,
// and the recent-projects list. The files live in the mock's work directory.

import { existsSync, readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { ManualClock } from '../../mock/clock.js';
import { Sessions, clip, need, type TestSession } from '../support/mock-client.js';

const sessions = new Sessions();
afterEach(async () => {
  await sessions.dispose();
});

const field = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], value);

/** Waits for the job a write started and returns its result (the job must succeed). */
async function finished(session: TestSession, started: Record<string, unknown>): Promise<Record<string, unknown>> {
  const jobId = String(field(started, 'job', 'jobId'));
  const { job } = (await session.ok('job.get', { jobId, waitMs: 5000 })) as {
    job: { state: string; result: Record<string, unknown> | null; error: unknown };
  };
  if (job.state !== 'succeeded' || job.result === null)
    throw new Error(`job ${job.state}: ${JSON.stringify(job.error)}`);
  return job.result;
}

/** The project without any handle or token: what must be equal after a save and an open. */
const shape = (session: TestSession) => {
  const { placements, contents, tracks } = session.mock.snapshot();
  return {
    placements: placements.map((p) => ({ ...p, id: '', reference: null })),
    contents: contents.map((c) => ({ ...c, id: '' })),
    tracks,
  };
};

const FILES = [
  { bind: 'a', kind: 'absent', extension: '.otproj' },
  { bind: 'b', kind: 'project', durationSec: 3 },
] as const;

describe('project.save and project.saveAs', () => {
  it('needs a project file for save, then saves under a path, clears the flag and remembers the path', async () => {
    const session = await sessions.open();
    const { mock, ok, fails } = session;
    const ids = mock.given({ files: [...FILES], clips: [clip()], dirty: true });
    expect((await fails('project.save')).data).toMatchObject({ reason: 'no_project_path' });

    const saved = await finished(session, await ok('project.saveAs', { path: ids.a }));
    expect(saved).toMatchObject({
      path: ids.a,
      dirty: { before: true, after: false },
      changes: [{ entity: 'project', fields: { path: { before: null, after: ids.a } } }],
      undo: { undoable: false, reason: 'no_upstream_undo', revert: null },
    });
    expect((saved.warnings as { code: string }[]).map((w) => w.code)).toEqual(['IRREVERSIBLE', 'NOT_SAVED_IN_PROJECT']);
    expect(existsSync(need(ids, 'a'))).toBe(true);
    expect(field(await ok('project.get'), 'project')).toEqual({ path: ids.a, dirty: false });
    expect(field(await ok('prefs.get'), 'recentProjects')).toEqual([{ path: ids.a, exists: true }]);

    // Changing the tempo marks the project as changed; save writes the same file again.
    await ok('transport.setTempo', { bpm: 90 });
    const again = await finished(session, await ok('project.save'));
    expect(again).toMatchObject({ path: ids.a, changes: [], dirty: { before: true, after: false } });
    expect(JSON.parse(readFileSync(need(ids, 'a'), 'utf8'))).toMatchObject({ bpm: 90 });
  });

  it('replaces another existing project file only with confirm, and says so', async () => {
    const session = await sessions.open();
    const { mock, ok, fails } = session;
    const ids = mock.given({ files: [...FILES], clips: [clip()] });
    const before = readFileSync(need(ids, 'b'), 'utf8');
    expect((await fails('project.saveAs', { path: ids.b })).data).toMatchObject({
      reason: 'confirm_required',
      executed: false,
    });
    expect(readFileSync(need(ids, 'b'), 'utf8')).toBe(before);
    const saved = await finished(session, await ok('project.saveAs', { path: ids.b, confirm: true }));
    expect((saved.warnings as { code: string }[]).map((w) => w.code)).toEqual([
      'IRREVERSIBLE',
      'OVERWROTE_OTHER_PROJECT',
      'NOT_SAVED_IN_PROJECT',
    ]);
    expect(readFileSync(need(ids, 'b'), 'utf8')).not.toBe(before);
    // The file is the project's file now: saving it again needs no consent.
    const resaved = await finished(session, await ok('project.saveAs', { path: ids.b }));
    expect(resaved.warnings).not.toContainEqual(expect.objectContaining({ code: 'OVERWROTE_OTHER_PROJECT' }));
  });

  it('refuses writes while the job runs, and rejects paths that are not project files', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { mock, ok, fails } = session;
    const ids = mock.given({ files: [...FILES], clips: [clip()] });
    const started = await ok('project.saveAs', { path: ids.a });
    expect((await fails('transport.setTempo', { bpm: 100 })).data).toMatchObject({ reason: 'project_operation' });
    expect(((await ok('ui.getState')).busy as Record<string, boolean>).projectOperation).toBe(true);
    clock.advance(0);
    await finished(session, started);
    await ok('transport.setTempo', { bpm: 100 });
    expect((await fails('project.saveAs', { path: 'C:\\Music\\take1.wav' })).data).toMatchObject({
      reason: 'path_bad_extension',
    });
  });
});

describe('project.open', () => {
  it('replaces the project, makes its handles stale and clears the histories, and the revert recipe opens the old one', async () => {
    const session = await sessions.open();
    const { mock, ok, fails } = session;
    const ids = mock.given({ files: [...FILES], clips: [clip()] });
    await finished(session, await ok('project.saveAs', { path: ids.a }));
    const original = shape(session);

    // A note edit leaves an undo entry, which opening another project takes away.
    await ok('content.setPitchShift', { contentId: ids['clip.contentId'], pitchShift: { semitones: 2, cents: 0 } });
    await finished(session, await ok('project.save'));
    expect(field(await ok('edit.getHistory'), 'history', 'undoCount')).toBe(1);

    const opened = await finished(session, await ok('project.open', { path: ids.b }));
    expect(opened).toMatchObject({
      path: ids.b,
      previous: { path: ids.a, dirty: false, discarded: false },
      restored: { placementCount: 1, contentCount: 1 },
      skipped: { media: [], placementCount: 0 },
      historyCleared: { undoCount: 1, redoCount: 0 },
      dirty: { after: false },
      undo: {
        undoable: false,
        reason: 'no_upstream_undo',
        revert: { method: 'project.open', params: { path: ids.a } },
      },
    });
    expect((opened.removed as unknown[]).length).toBe(2);
    expect((opened.created as unknown[]).length).toBe(2);
    expect(field(await ok('edit.getHistory'), 'history', 'undoCount')).toBe(0);
    expect((await fails('content.getDetails', { contentId: ids['clip.contentId'] })).data).toMatchObject({
      reason: 'stale_handle',
    });
    // The pitch analysis of the opened clip starts, and finishes shortly after.
    const content = (field(await ok('project.get'), 'contents') as { contentId: string; f0State: string }[])[0];
    expect(content?.f0State).toBe('extracting');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(field(await ok('content.getDetails', { contentId: content?.contentId }), 'analysis', 'f0State')).toBe(
      'ready',
    );

    // The recipe is a complete request: it opens the file the project had before, with its pitch shift.
    const recipe = field(opened, 'undo', 'revert') as { method: string; params: Record<string, unknown> };
    await finished(session, await ok(recipe.method, recipe.params));
    expect(shape(session)).toMatchObject({
      placements: original.placements,
      tracks: original.tracks,
      contents: [
        expect.objectContaining({ pitchShift: { semitones: 2, cents: 0 }, notes: original.contents[0]?.notes }),
      ],
    });
  });

  it('keeps the project when the file cannot be read, and does not discard changes unasked', async () => {
    const session = await sessions.open();
    const { mock, ok, fails } = session;
    const ids = mock.given({
      files: [
        { bind: 'junk', kind: 'undecodable', extension: '.otproj' },
        { bind: 'gone', kind: 'absent', extension: '.otproj' },
        ...FILES,
      ],
      clips: [clip()],
      dirty: true,
    });
    const before = mock.snapshot();
    expect((await fails('project.open', { path: ids.b })).data).toMatchObject({ kind: 'UNSAVED_CHANGES' });
    expect((await fails('project.open', { path: ids.gone, discardUnsaved: true })).data).toMatchObject({
      reason: 'file_not_found',
    });
    const started = await ok('project.open', { path: ids.junk, discardUnsaved: true });
    const { job } = (await ok('job.get', { jobId: field(started, 'job', 'jobId'), waitMs: 5000 })) as {
      job: { state: string; error: { data: Record<string, unknown> } };
    };
    expect(job.state).toBe('failed');
    expect(job.error.data).toMatchObject({ kind: 'IO_ERROR', reason: 'read_failed' });
    expect(mock.snapshot()).toEqual(before);
    expect(((await ok('ui.getState')).busy as Record<string, boolean>).projectOperation).toBe(false);
  });

  it('can be cancelled until the file is read, and not after', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { mock, ok, fails } = session;
    const ids = mock.given({ files: [...FILES], clips: [clip()] });
    const before = mock.snapshot();

    const first = await ok('project.open', { path: ids.b });
    const firstId = String(field(first, 'job', 'jobId'));
    await ok('job.cancel', { jobId: firstId });
    clock.advance(0);
    expect(((await ok('job.get', { jobId: firstId })).job as { state: string }).state).toBe('cancelled');
    expect(mock.snapshot()).toEqual(before);

    const second = await ok('project.open', { path: ids.b });
    const secondId = String(field(second, 'job', 'jobId'));
    clock.advance(0);
    expect((await fails('job.cancel', { jobId: secondId })).data).toMatchObject({ reason: 'job_not_cancellable' });
    clock.advance(1000);
    expect(((await ok('job.get', { jobId: secondId })).job as { state: string }).state).toBe('succeeded');
  });

  it('lists a missing media file instead of restoring the clip that shows it', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({ files: [{ bind: 'm', kind: 'projectMissingMedia', durationSec: 3 }] });
    const opened = await finished(session, await ok('project.open', { path: ids.m }));
    expect(opened).toMatchObject({
      restored: { placementCount: 0, contentCount: 0 },
      skipped: { media: [{ reason: 'missing' }], placementCount: 1 },
    });
    expect(mock.snapshot().placements).toEqual([]);
  });
});

describe('project.clearRecent', () => {
  it('empties the list once, and an empty list is a no-op', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({
      files: [
        { bind: 'r1', kind: 'project', durationSec: 1 },
        { bind: 'r2', kind: 'absent', extension: '.otproj' },
      ],
      preferences: { recentProjects: ['r1', 'r2'] },
    });
    expect(field(await ok('prefs.get'), 'recentProjects')).toEqual([
      { path: ids.r1, exists: true },
      { path: ids.r2, exists: false },
    ]);
    const cleared = await ok('project.clearRecent');
    expect(cleared.changes).toMatchObject([{ fields: { recentProjects: { before: [ids.r1, ids.r2], after: [] } } }]);
    expect(field(await ok('prefs.get'), 'recentProjects')).toEqual([]);
    expect(await ok('project.clearRecent')).toMatchObject({ noOp: true, changes: [] });
  });
});
