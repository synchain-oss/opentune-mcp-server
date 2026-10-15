// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The mock's content edits and time-grid edits beyond what the contract vectors show: how the
// tokens move, that an undo step puts the data back, the limits of handle moves, key snapping,
// AUTO's modes and the refusals that apply to every content write.

import { afterEach, describe, expect, it } from 'vitest';

import { ManualClock } from '../../mock/clock.js';
import { editHandlers } from '../../mock/edit.js';
import { JOB_RETENTION_COUNT, JobStore, oneShot } from '../../mock/jobs.js';
import { World } from '../../mock/model.js';
import { SCALES, nearestInScale } from '../../mock/music.js';
import { MIN_HANDLE_SPACING_SEC, timingHandlers } from '../../mock/timing.js';
import { Sessions, clip, type TestSession } from '../support/mock-client.js';
import { otcpSpec } from '../support/otcp-spec.js';

const sessions = new Sessions();
afterEach(async () => {
  await sessions.dispose();
});

const GRID = [
  { bind: 'h1', contentSec: 1 },
  { bind: 'h2', contentSec: 2 },
  { bind: 'h3', contentSec: 3 },
];

interface Setup {
  readonly session: TestSession;
  readonly ids: Record<string, string>;
  readonly contentId: string;
  /** The notes of the content as content.getNotes reports them. */
  readonly notes: () => Promise<{ index: number; targetMidi: number; offsetCents: number; startContentSec: number }[]>;
}

async function setup(extra: Parameters<typeof clip>[0] = {}): Promise<Setup> {
  const session = await sessions.open();
  const ids = session.mock.given({ dirty: false, clips: [clip(extra)] });
  const contentId = ids['clip.contentId'] ?? '';
  return {
    session,
    ids,
    contentId,
    async notes() {
      const result = await session.ok('content.getNotes', { contentId });
      return result.notes as Awaited<ReturnType<Setup['notes']>>;
    },
  };
}

const field = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], value);

describe('scales', () => {
  it('snaps to the nearest pitch of the scale, an exact tie going up', () => {
    const cMajor = { root: 0, scale: 'major' };
    expect(nearestInScale(69.3, cMajor)).toBe(69);
    expect(nearestInScale(61, cMajor)).toBe(62);
    expect(nearestInScale(66, cMajor)).toBe(67);
    expect(nearestInScale(66.2, cMajor)).toBe(67);
    expect(nearestInScale(65.9, cMajor)).toBe(65);
    // The root moves the scale; the chromatic scale keeps every pitch.
    expect(nearestInScale(61.2, { root: 1, scale: 'major' })).toBe(61);
    expect(nearestInScale(61.4, { root: 0, scale: 'chromatic' })).toBe(61);
    expect(nearestInScale(50, { root: 0, scale: 'unknown' })).toBe(50);
    for (const degrees of Object.values(SCALES)) expect(degrees[0]).toBe(0);
  });
});

describe('content.editNotes', () => {
  it('moves revision only, and one undo step takes a whole call back', async () => {
    const { session, ids, contentId } = await setup();
    const { mock, ok } = session;
    const before = mock.snapshot();
    const edited = await ok('content.editNotes', {
      contentId,
      expectedRevision: ids['clip.revision'],
      ops: [
        { op: 'shiftCents', select: { indices: [0] }, deltaCents: 25 },
        { op: 'setTargetPitch', select: { indices: [1] }, targetMidi: 71 },
        { op: 'setParams', select: { all: true }, retuneSpeed: 0.2, vibratoDepth: 5, vibratoRateHz: 7 },
      ],
    });
    const tokens = field(edited, 'tokens', 'contents') as {
      revision: string;
      gridRevision: string;
      keyRevision: string;
    }[];
    expect(tokens[0]?.revision).not.toBe(ids['clip.revision']);
    expect(tokens[0]?.gridRevision).toBe(ids['clip.gridRevision']);
    expect(tokens[0]?.keyRevision).toBe(ids['clip.keyRevision']);
    expect(edited.undo).toMatchObject({ undoable: true, steps: 1 });
    expect((edited.changes as unknown[]).length).toBe(3);

    const undoId = field(edited, 'undo', 'undoId');
    expect((await ok('edit.getHistory')).history).toMatchObject({ undoCount: 1 });
    const after = mock.snapshot();
    expect(after).not.toEqual({ ...before, dirty: true });

    await ok('edit.undo', { expectedUndoId: undoId });
    expect(mock.snapshot()).toEqual({ ...before, dirty: true });
    await ok('edit.redo', { expectedUndoId: undoId });
    expect(mock.snapshot()).toEqual(after);
  });

  it('predicts without changing anything and reports a call that changes nothing as a no-op', async () => {
    const { session, ids, contentId } = await setup();
    const { mock, ok } = session;
    const before = mock.snapshot();
    const request = (extra: Record<string, unknown>) => ({
      contentId,
      expectedRevision: ids['clip.revision'],
      ops: [{ op: 'shiftCents', select: { all: true }, deltaCents: 40 }],
      ...extra,
    });
    const predicted = await ok('content.editNotes', request({ dryRun: true }));
    expect(predicted).toMatchObject({
      applied: false,
      dryRun: true,
      undo: null,
      dirty: { before: false, after: false },
    });
    expect((predicted.changes as unknown[]).length).toBe(3);
    expect(mock.snapshot()).toEqual(before);
    expect((await ok('edit.getHistory')).history).toMatchObject({ undoCount: 0 });

    const none = await ok('content.editNotes', {
      contentId,
      expectedRevision: ids['clip.revision'],
      ops: [{ op: 'shiftCents', select: { all: true }, deltaCents: 0 }],
    });
    expect(none).toMatchObject({ applied: true, noOp: true, undo: { reason: 'no_op' }, dirty: { after: false } });
    expect(mock.snapshot()).toEqual(before);
  });

  it('snaps to the clip key only with its revision, and a new edit ends the redo history', async () => {
    const { session, ids, contentId } = await setup({ key: { root: 0, scale: 'major' } });
    const { ok, fails } = session;
    const op = { op: 'snapToScale', select: { all: true }, key: 'clipKey' };
    const base = { contentId, expectedRevision: ids['clip.revision'], ops: [op] };
    expect((await fails('content.editNotes', base)).data).toMatchObject({ kind: 'INVALID_ARGUMENT' });
    const snapped = await ok('content.editNotes', { ...base, expectedKeyRevision: ids['clip.keyRevision'] });
    expect(snapped.changes).toMatchObject([{ fields: { targetMidi: { after: 69 } } }]);

    await ok('edit.undo', { expectedUndoId: field(snapped, 'undo', 'undoId') });
    expect((await ok('edit.getHistory')).history).toMatchObject({ redoCount: 1 });
    await ok('content.setPitchShift', { contentId, pitchShift: { semitones: 1, cents: 0 } });
    expect((await ok('edit.getHistory')).history).toMatchObject({ undoCount: 1, redoCount: 0 });
  });

  it('lists at most 200 changes and counts the rest', async () => {
    const session = await sessions.open();
    const notes = Array.from({ length: 230 }, (_, i) => ({
      startContentSec: i * 0.1,
      endContentSec: i * 0.1 + 0.08,
      targetMidi: 60,
    }));
    const ids = session.mock.given({ clips: [clip({ durationSec: 30, notes })] });
    const result = await session.ok('content.editNotes', {
      contentId: ids['clip.contentId'],
      expectedRevision: ids['clip.revision'],
      ops: [{ op: 'shiftCents', select: { all: true }, deltaCents: 10 }],
    });
    expect((result.changes as unknown[]).length).toBe(200);
    expect(result.omittedChangeCount).toBe(30);
  });
});

describe('refusals of content writes', () => {
  it('check the UI state before the analysis and the analysis before the tokens', async () => {
    const { session, ids, contentId } = await setup();
    const { mock, fails } = session;
    const calls: [string, Record<string, unknown>][] = [
      ['content.setKey', { contentId, key: { root: 2, scale: 'major' } }],
      ['content.setPitchShift', { contentId, pitchShift: { semitones: 1, cents: 0 } }],
      [
        'content.editNotes',
        { contentId, expectedRevision: 'stale', ops: [{ op: 'shiftCents', select: { all: true }, deltaCents: 1 }] },
      ],
      ['content.autoTune', { contentId, mode: 'notesOnly', expectedRevision: 'stale' }],
      ['content.editTimeGrid', { contentId, op: 'seed' }],
    ];
    mock.setBusy({ modalOpen: true });
    for (const [method, params] of calls)
      expect((await fails(method, params)).data).toMatchObject({ reason: 'modal_open' });
    mock.setBusy({ modalOpen: false });

    for (const [analysis, reason, retryable] of [
      ['running', 'f0_not_ready', true],
      ['failed', 'f0_failed', false],
      ['unvoiced', 'f0_empty', false],
    ] as const) {
      mock.setAnalysis(contentId, analysis);
      for (const [method, params] of calls) {
        expect((await fails(method, params)).data).toMatchObject({ kind: 'NOT_READY', reason, retryable });
      }
    }
    mock.setAnalysis(contentId, 'ready');
    expect((await fails('content.editNotes', calls[2]?.[1])).data).toMatchObject({ reason: 'content_changed' });
    expect(ids['clip.contentId']).toBe(contentId);
  });
});

describe('content.autoTune', () => {
  it('regenerates notes inside the range from the detected pitch, snapped to the key and with the given parameters', async () => {
    const { session, ids, contentId, notes } = await setup();
    const result = await session.ok('content.autoTune', {
      contentId,
      mode: 'regenerate',
      expectedRevision: ids['clip.revision'],
      ranges: [{ startContentSec: 0.8, endContentSec: 3.2 }],
      key: { root: 0, scale: 'pentatonicMajor' },
      params: { retuneSpeed: 0.3, noteSplitCents: 150 },
    });
    expect(result).toMatchObject({
      mode: 'regenerate',
      keyUsed: { root: 0, scale: 'pentatonicMajor' },
      paramsUsed: { retuneSpeed: 0.3, vibratoDepth: 0, vibratoRateHz: 6, noteSplitCents: 150 },
      noteCount: { before: 3 },
    });
    const now = await notes();
    const pentatonic = SCALES.pentatonicMajor ?? [];
    const created = (result.created as { ref: { note: { index: number } } }[]).map((c) => now[c.ref.note.index]);
    expect(created.length).toBeGreaterThan(0);
    for (const note of created) {
      expect(note?.offsetCents).toBe(0);
      expect(note?.startContentSec).toBeGreaterThanOrEqual(0.8);
      expect(pentatonic).toContain((((note?.targetMidi ?? 0) % 12) + 12) % 12);
    }
    // Notes outside the range stay, and the notes remain in order of start time.
    expect(now.some((n) => n.startContentSec === 3.5)).toBe(true);
    expect(now.map((n) => n.startContentSec)).toEqual([...now.map((n) => n.startContentSec)].sort((a, b) => a - b));
  });

  it('snaps existing notes without making new ones, and a second snap changes nothing', async () => {
    const { session, ids, contentId } = await setup();
    const params = {
      contentId,
      mode: 'snapNotes',
      expectedRevision: ids['clip.revision'],
      key: { root: 0, scale: 'major' },
    };
    const first = await session.ok('content.autoTune', params);
    expect(first).toMatchObject({ noteCount: { before: 3, after: 3 }, paramsUsed: null, created: [], removed: [] });
    const revision = (field(first, 'tokens', 'contents') as { revision: string }[])[0]?.revision;
    const second = await session.ok('content.autoTune', { ...params, expectedRevision: revision });
    expect(second).toMatchObject({ applied: true, noOp: true });
  });

  it('generates notes for the whole content without a key, with no undo entry', async () => {
    const { session, ids, contentId, notes } = await setup();
    const result = await session.ok('content.autoTune', {
      contentId,
      mode: 'notesOnly',
      expectedRevision: ids['clip.revision'],
      dryRun: true,
    });
    expect(result).toMatchObject({ applied: false, keyUsed: null, noteCount: { before: 3 } });
    expect((await notes()).length).toBe(3);

    const done = await session.ok('content.autoTune', {
      contentId,
      mode: 'notesOnly',
      expectedRevision: ids['clip.revision'],
    });
    expect(done.undo).toEqual({ undoable: false, reason: 'ui_parity', revert: null });
    expect((await session.ok('edit.getHistory')).history).toMatchObject({ undoCount: 0 });
    expect((await notes()).length).toBe(field(done, 'noteCount', 'after'));
  });

  it('refuses reference mode, which needs a capability the mock does not report', () => {
    const world = new World('0123456789abcdef0123456789abcdef', new ManualClock());
    const content = world.addContent({ durationSec: 6, analysis: 'ready', sourcePath: null });
    const run = () =>
      editHandlers['content.autoTune']?.({
        world,
        params: { contentId: content.id, mode: 'reference', expectedRevision: content.revision },
        exportLock: false,
        hasCapability: () => false,
        redact: (t) => t,
        startJob: () => {
          throw new Error('no job here');
        },
      });
    expect(run).toThrow(/reference\.v1/);
  });
});

describe('content.setKey', () => {
  it('sets a manual key, is undone by its revert recipe, and treats the detected key as the same key', async () => {
    const { session, ids, contentId } = await setup({ key: { root: 9, scale: 'minor' } });
    const { ok } = session;
    const same = await ok('content.setKey', { contentId, key: { root: 9, scale: 'minor' } });
    expect(same).toMatchObject({ noOp: true, dirty: { after: false } });
    const set = await ok('content.setKey', { contentId, key: { root: 2, scale: 'dorian' } });
    expect(await ok('content.getDetails', { contentId })).toMatchObject({
      key: { root: 2, scale: 'dorian', origin: 'manual', confidence: null },
    });
    const revert = field(set, 'undo', 'revert') as { method: string; params: Record<string, unknown> };
    expect(revert.method).toBe('content.setKey');
    expect(ids['clip.keyRevision']).not.toBe(field(revert, 'params', 'expectedKeyRevision'));
    await ok(revert.method, revert.params);
    expect(await ok('content.getDetails', { contentId })).toMatchObject({ key: { root: 9, scale: 'minor' } });
  });

  it('reports the scale in the transport bar when the clip is selected', () => {
    const world = new World('0123456789abcdef0123456789abcdef', new ManualClock());
    const content = world.addContent({ durationSec: 6, analysis: 'ready', sourcePath: null });
    content.key = { root: 0, scale: 'major', origin: 'automatic', confidence: 0.9 };
    const placement = world.addPlacement({ trackId: 0, content, name: null, startTimelineSec: 0, durationSec: 6 });
    world.selectedPlacementIds = [placement.id];
    const result = editHandlers['content.setKey']?.({
      world,
      params: { contentId: content.id, key: { root: 7, scale: 'major' } },
      exportLock: false,
      hasCapability: () => true,
      redact: (t) => t,
      startJob: () => {
        throw new Error('no job here');
      },
    });
    expect(result?.sideEffects).toMatchObject({
      uiScaleChanged: { root: 7, scale: 'major', revert: { method: 'content.setKey' } },
    });
  });
});

describe('time grid', () => {
  it('limits moves by the spacing to the neighbours and to the ends, in two passes', async () => {
    const { session, contentId } = await setup({ timeGrid: GRID });
    const { ok, mock } = session;
    const handles = async () =>
      (
        (await ok('content.getDetails', { contentId })).timeGrid as {
          handles: { handleId: string; outputSec: number }[];
        }
      ).handles;
    const [h1, h2, h3] = await handles();
    const shift = async (start: number, end: number, deltaSec: number) => {
      const grid = field((await ok('content.getDetails', { contentId })).asOf, 'contents') as {
        gridRevision: string;
      }[];
      return ok('content.shiftTiming', {
        contentId,
        expectedGridRevision: grid[0]?.gridRevision,
        range: { startOutputSec: start, endOutputSec: end },
        deltaSec,
      });
    };

    // Against the neighbour that stays.
    let result = await shift(1.5, 2.5, 5);
    expect(field(result, 'clamped')).toEqual([
      { handleId: h2?.handleId, requestedOutputSec: 7, appliedOutputSec: round(3 - MIN_HANDLE_SPACING_SEC) },
    ]);
    // Against the start of the content.
    result = await shift(0.5, 1.5, -5);
    expect(field(result, 'clamped')).toEqual([
      { handleId: h1?.handleId, requestedOutputSec: -4, appliedOutputSec: MIN_HANDLE_SPACING_SEC },
    ]);
    // Two handles that move together keep the spacing between them at the end of the content.
    result = await shift(2.5, 3.5, 10);
    expect(field(result, 'clamped')).toEqual([
      { handleId: h2?.handleId, requestedOutputSec: 12.95, appliedOutputSec: 5.9 },
      { handleId: h3?.handleId, requestedOutputSec: 13, appliedOutputSec: 5.95 },
    ]);
    const moved = await handles();
    expect(moved.map((h) => h.outputSec)).toEqual([MIN_HANDLE_SPACING_SEC, 5.9, 5.95]);

    result = await shift(0, 7, 10);
    const last = await handles();
    expect(last.map((h) => h.outputSec)).toEqual([5.85, 5.9, 5.95]);
    expect((result.warnings as { code: string }[]).filter((w) => w.code === 'CLAMPED').length).toBe(3);
    expect(mock.snapshot().contents[0]?.handles.length).toBe(3);
  });

  it('undoes a move of handles and reads a content range through the grid', async () => {
    const { session, ids, contentId } = await setup({ timeGrid: GRID });
    const { ok, mock } = session;
    const before = mock.snapshot();
    const moved = await ok('content.shiftTiming', {
      contentId,
      expectedGridRevision: ids['clip.gridRevision'],
      range: { startContentSec: 1.5, endContentSec: 2.5 },
      deltaSec: 0.2,
    });
    expect(moved.changes).toMatchObject([{ entity: 'timeHandle', fields: { outputSec: { before: 2, after: 2.2 } } }]);
    expect(mock.snapshot()).not.toEqual({ ...before, dirty: true });
    await ok('edit.undo', { expectedUndoId: field(moved, 'undo', 'undoId') });
    expect(mock.snapshot()).toEqual({ ...before, dirty: true });

    const details = await ok('content.getDetails', { contentId });
    const empty = await ok('content.shiftTiming', {
      contentId,
      expectedGridRevision: (details.asOf as { contents: { gridRevision: string }[] }).contents[0]?.gridRevision,
      range: { startOutputSec: 4, endOutputSec: 5 },
      deltaSec: 1,
    });
    expect(empty).toMatchObject({ applied: true, noOp: true, clamped: [] });
  });

  it('seeds a grid with a job, once', async () => {
    const { session, contentId } = await setup();
    const { ok } = session;
    const started = await ok('content.editTimeGrid', { contentId, op: 'seed' });
    const jobId = field(started, 'job', 'jobId') as string;
    const job = field(await ok('job.get', { jobId, waitMs: 5000 }), 'job') as {
      state: string;
      result: Record<string, unknown>;
    };
    expect(job.state).toBe('succeeded');
    const created = job.result.created as { ref: { handleId: string } }[];
    expect(created.length).toBe(5);
    expect(job.result.undo).toEqual({ undoable: false, reason: 'ui_parity', revert: null });
    expect(await ok('content.getDetails', { contentId })).toMatchObject({ timeGrid: { seeded: true, identity: true } });
    // A grid with handles is not seeded again.
    expect(await ok('content.editTimeGrid', { contentId, op: 'seed' })).toMatchObject({ noOp: true, job: null });
    expect((await ok('edit.getHistory')).history).toMatchObject({ undoCount: 0 });
  });

  it('predicts a move of handles without making it', async () => {
    const { session, ids, contentId } = await setup({ timeGrid: GRID });
    const before = session.mock.snapshot();
    const handle = (await session.ok('content.getDetails', { contentId })).timeGrid as {
      handles: { handleId: string }[];
    };
    const result = await session.ok('content.editTimeGrid', {
      contentId,
      op: 'moveHandles',
      expectedGridRevision: ids['clip.gridRevision'],
      moves: [{ handleId: handle.handles[0]?.handleId, outputSec: 0.9 }],
      dryRun: true,
    });
    expect(result).toMatchObject({ applied: false, dryRun: true, clamped: [] });
    expect(session.mock.snapshot()).toEqual(before);
  });
});

describe('undo entries next to writes without one', () => {
  const revisionOf = async (session: TestSession, contentId: string) =>
    (field((await session.ok('content.getDetails', { contentId })).asOf, 'contents') as { revision: string }[])[0]
      ?.revision;

  it('put back only what their own step changed', async () => {
    const { session, ids, contentId } = await setup({ key: { root: 9, scale: 'minor' } });
    const { ok, mock } = session;
    const content = () => mock.snapshot().contents[0];

    // A pitch shift, then a seeded grid: the undo of the shift leaves the grid.
    const shifted = await ok('content.setPitchShift', { contentId, pitchShift: { semitones: 2, cents: 0 } });
    const started = await ok('content.editTimeGrid', { contentId, op: 'seed' });
    const job = field(await ok('job.get', { jobId: field(started, 'job', 'jobId'), waitMs: 5000 }), 'job');
    expect(field(job, 'state')).toBe('succeeded');
    const seeded = content()?.handles;
    expect(seeded?.length).toBe(5);
    await ok('edit.undo', { expectedUndoId: field(shifted, 'undo', 'undoId') });
    expect(content()?.pitchShift).toEqual({ semitones: 0, cents: 0 });
    expect(content()?.handles).toEqual(seeded);

    // A note edit, then a key change: the undo of the edit leaves the key.
    const notesBefore = content()?.notes;
    const edited = await ok('content.editNotes', {
      contentId,
      expectedRevision: ids['clip.revision'],
      ops: [{ op: 'shiftCents', select: { all: true }, deltaCents: 20 }],
    });
    await ok('content.setKey', { contentId, key: { root: 2, scale: 'dorian' } });
    const undone = await ok('edit.undo', { expectedUndoId: field(edited, 'undo', 'undoId') });
    expect(content()?.notes).toEqual(notesBefore);
    expect(content()?.key).toMatchObject({ root: 2, scale: 'dorian', origin: 'manual' });
    expect((undone.changes as { entity: string }[]).map((c) => c.entity)).toEqual(['content']);
  });

  it('do not take back notes that notesOnly generated after them', async () => {
    const { session, ids, contentId } = await setup();
    const { ok, mock } = session;
    const regenerated = await ok('content.autoTune', {
      contentId,
      mode: 'regenerate',
      expectedRevision: ids['clip.revision'],
      key: { root: 0, scale: 'major' },
    });
    await ok('content.autoTune', {
      contentId,
      mode: 'notesOnly',
      expectedRevision: await revisionOf(session, contentId),
      params: { noteSplitCents: 150 },
    });
    const generated = mock.snapshot().contents[0]?.notes;
    const undone = await ok('edit.undo', { expectedUndoId: field(regenerated, 'undo', 'undoId') });
    expect(undone).toMatchObject({ applied: true, noOp: true, warnings: [{ code: 'UNDO_NO_EFFECT' }] });
    expect(mock.snapshot().contents[0]?.notes).toEqual(generated);
  });

  it('end the redo history, so that no redo writes over them', async () => {
    const { session, ids, contentId } = await setup();
    const { ok, fails, mock } = session;
    const regenerated = await ok('content.autoTune', {
      contentId,
      mode: 'regenerate',
      expectedRevision: ids['clip.revision'],
      key: { root: 0, scale: 'major' },
    });
    const undoId = field(regenerated, 'undo', 'undoId');
    await ok('edit.undo', { expectedUndoId: undoId });
    expect((await ok('edit.getHistory')).history).toMatchObject({ redoCount: 1 });
    await ok('content.autoTune', {
      contentId,
      mode: 'notesOnly',
      expectedRevision: await revisionOf(session, contentId),
      params: { noteSplitCents: 150 },
    });
    const generated = mock.snapshot().contents[0]?.notes;
    expect((await ok('edit.getHistory')).history).toMatchObject({ undoCount: 0, redoCount: 0 });
    expect((await fails('edit.redo', { expectedUndoId: undoId })).data).toMatchObject({ reason: 'history_empty' });
    expect(mock.snapshot().contents[0]?.notes).toEqual(generated);

    // The same for a key change after an undone pitch shift.
    const shifted = await ok('content.setPitchShift', { contentId, pitchShift: { semitones: 1, cents: 0 } });
    await ok('edit.undo', { expectedUndoId: field(shifted, 'undo', 'undoId') });
    await ok('content.setKey', { contentId, key: { root: 4, scale: 'minor' } });
    expect((await ok('edit.getHistory')).history).toMatchObject({ redoCount: 0 });
  });
});

describe('the timeGridSeed job', () => {
  it('can be cancelled before it runs, and then writes no handle', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const ids = session.mock.given({ clips: [clip()] });
    const contentId = ids['clip.contentId'] ?? '';
    const started = await session.ok('content.editTimeGrid', { contentId, op: 'seed' });
    const jobId = field(started, 'job', 'jobId');
    expect(field(await session.ok('job.get', { jobId }), 'job', 'cancellable')).toBe(true);
    expect(await session.ok('job.cancel', { jobId })).toMatchObject({ cancelRequested: true });
    clock.advance(0);
    const job = field(await session.ok('job.get', { jobId }), 'job');
    expect(job).toMatchObject({
      state: 'cancelled',
      cancellable: false,
      result: null,
      error: { data: { kind: 'CANCELLED', reason: 'cancelled_by_request' } },
    });
    expect(await session.ok('content.getDetails', { contentId })).toMatchObject({
      timeGrid: { seeded: false, handles: [] },
    });
    expect(await session.ok('job.cancel', { jobId })).toMatchObject({ cancelRequested: false });
  });

  it('checks the UI state and the analysis again when it runs, and fails without writing', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const ids = session.mock.given({ clips: [clip()] });
    const contentId = ids['clip.contentId'] ?? '';
    const run = async (meanwhile: () => void) => {
      const started = await session.ok('content.editTimeGrid', { contentId, op: 'seed' });
      meanwhile();
      clock.advance(0);
      return field(await session.ok('job.get', { jobId: field(started, 'job', 'jobId') }), 'job');
    };
    const busy = await run(() => {
      session.mock.setBusy({ modalOpen: true });
    });
    expect(busy).toMatchObject({ state: 'failed', result: null, error: { data: { kind: 'INTERNAL' } } });
    expect(field(busy, 'error', 'data', 'detail')).toMatch(/BUSY\(modal_open\)/);
    session.mock.setBusy({ modalOpen: false });
    const notReady = await run(() => {
      session.mock.setAnalysis(contentId, 'running');
    });
    expect(field(notReady, 'error', 'data', 'detail')).toMatch(/NOT_READY\(f0_not_ready\)/);
    expect(session.mock.snapshot().contents[0]?.handles).toEqual([]);
  });

  it('fails when its content is gone by the time it runs', () => {
    const clock = new ManualClock();
    const world = new World('0123456789abcdef0123456789abcdef', clock);
    const jobs = new JobStore(otcpSpec(), clock, '01234567');
    const content = world.addContent({ durationSec: 6, analysis: 'ready', sourcePath: null });
    const result = timingHandlers['content.editTimeGrid']?.({
      world,
      params: { contentId: content.id, op: 'seed' },
      exportLock: false,
      hasCapability: () => true,
      redact: (t) => t,
      startJob: (kind, work) => jobs.start({ kind }, oneShot(work)),
    });
    const jobId = String(field(result, 'job', 'jobId'));
    world.contents.delete(content.objectId);
    clock.advance(0);
    expect(jobs.get(jobId)).toMatchObject({ state: 'failed', error: { data: { kind: 'INTERNAL' } } });
    expect(field(jobs.get(jobId), 'error', 'data', 'detail')).toMatch(/NOT_FOUND\(unknown_handle\)/);
    expect(content.handles).toEqual([]);
  });

  it('is refused with BUSY(job_limit) while every retained job is still active', async () => {
    const { session, contentId } = await setup();
    session.mock.given({
      jobs: Array.from({ length: JOB_RETENTION_COUNT }, (_, i) => ({
        bind: `job${String(i)}`,
        kind: 'import',
        state: 'queued' as const,
        cancellable: true,
      })),
    });
    expect((await session.fails('content.editTimeGrid', { contentId, op: 'seed' })).data).toMatchObject({
      kind: 'BUSY',
      reason: 'job_limit',
    });
    expect(session.mock.snapshot().contents[0]?.handles).toEqual([]);
  });
});

describe('content.getNotes cursors', () => {
  it('belong to the range they were issued for', async () => {
    const { session, contentId } = await setup();
    const { ok, fails } = session;
    const range = { startContentSec: 0, endContentSec: 6 };
    const page = await ok('content.getNotes', { contentId, range, limit: 1 });
    const cursor = page.nextCursor as string;
    expect(cursor).toBeTypeOf('string');
    expect((await ok('content.getNotes', { contentId, range, cursor })).notes).toHaveLength(2);
    expect((await fails('content.getNotes', { contentId, cursor })).data).toMatchObject({ reason: 'cursor_stale' });
    const narrower = { startContentSec: 0, endContentSec: 5 };
    expect((await fails('content.getNotes', { contentId, range: narrower, cursor })).data).toMatchObject({
      reason: 'cursor_stale',
    });
  });
});

const round = (value: number): number => Math.round(value * 1e6) / 1e6;
