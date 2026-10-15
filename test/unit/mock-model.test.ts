// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The mock's model beyond what the contract vectors show: the token rules of section 10, reads that
// follow the model's state, the undo history, the busy checks, `given`, and the test interface.

import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ManualClock } from '../../mock/clock.js';
import { historyHandlers } from '../../mock/history.js';
import { DEFAULT_NOTE_PARAMS, RENDER_SETTLE_MS, World, type HistoryEntry } from '../../mock/model.js';
import { UnsupportedPrecondition } from '../../mock/server.js';
import { RunnerConnection } from '../contract/connection.js';
import { Sessions, clip } from '../support/mock-client.js';

const sessions = new Sessions();
afterEach(async () => {
  await sessions.dispose();
});

const INSTANCE_ID = '0123456789abcdef0123456789abcdef';

describe('tokens (section 10)', () => {
  it('mints a token for every change, never repeats one, and moves revision only with notes, pitch and content', () => {
    const world = new World(INSTANCE_ID, new ManualClock());
    const content = world.addContent({ durationSec: 6, analysis: 'ready', sourcePath: null });
    const seen = new Set<string>();
    const note = (values: Record<string, string>) => {
      for (const value of Object.values(values)) {
        expect(seen.has(value)).toBe(false);
        seen.add(value);
      }
    };
    note({ ...content.comp, revision: content.revision });
    const revision = content.revision;

    // A key, grid or pitch-shift change does not change revision (rule 2) ...
    for (const component of ['key', 'grid', 'pitchShift', 'reference'] as const) {
      const before = content.comp[component];
      world.touch(content, component);
      expect(content.comp[component]).not.toBe(before);
      expect(content.revision).toBe(revision);
      note({ [component]: content.comp[component] });
    }
    // ... while notes, pitch and content each do.
    for (const component of ['notes', 'pitch', 'content'] as const) {
      const before = content.revision;
      world.touch(content, component);
      expect(content.revision).not.toBe(before);
      note({ revision: content.revision });
    }
    expect(world.gridIsIdentity(content)).toBe(true);
  });

  it('shows only the components that differ in a revision diff, and a new content with before null', () => {
    const world = new World(INSTANCE_ID, new ManualClock());
    const content = world.addContent({ durationSec: 6, analysis: 'ready', sourcePath: null });
    const before = world.capture();
    expect(world.diff(before, world.capture())).toEqual({ arrangement: null, trackState: null, contents: [] });

    world.touch(content, 'key');
    world.touch(content, 'notes');
    const added = world.addContent({ durationSec: 1, analysis: 'running', sourcePath: null });
    const diff = world.diff(before, world.capture());
    const [first, second] = diff.contents;
    expect(Object.keys(first?.changed ?? {}).sort()).toEqual(['key', 'notes']);
    expect(first?.changed.key).toEqual({ before: before.contents.get(content.objectId)?.key, after: content.comp.key });
    expect(second?.contentId).toBe(added.id);
    expect(second?.changed.content).toEqual({ before: null, after: added.comp.content });
  });

  it('maps the time grid piecewise-linearly through its handles, with its ends fixed', () => {
    const world = new World(INSTANCE_ID, new ManualClock());
    const content = world.addContent({ durationSec: 6, analysis: 'ready', sourcePath: null });
    content.handles = [{ handleId: 'h', contentSec: 2, outputSec: 3 }];
    expect(world.contentToOutput(content, 1)).toBeCloseTo(1.5);
    expect(world.contentToOutput(content, 4)).toBeCloseTo(4.5);
    expect(world.outputToContent(content, 1.5)).toBeCloseTo(1);
    expect(world.outputToContent(content, 6)).toBeCloseTo(6);
    expect(world.gridIsIdentity(content)).toBe(false);
  });
});

describe('undo history', () => {
  const history = {
    undo: [
      { bind: 'u1', origin: 'control' as const, action: 'pitchShift', clip: 'clip' },
      { bind: 'u2', origin: 'control' as const, action: 'noteEdit', clip: 'clip' },
    ],
    redo: [],
  };

  it('restores the data after undoing and redoing every entry, with tokens that moved on', async () => {
    const { mock, ok } = await sessions.open();
    const ids = mock.given({ clips: [clip()], history });
    const start = mock.snapshot();
    const tokensBefore = (await ok('project.get')).asOf;

    const undo2 = await ok('edit.undo', { expectedUndoId: ids.u2 });
    expect(undo2).toMatchObject({ applied: true, noOp: false, dirty: { before: false, after: true } });
    const undo1 = await ok('edit.undo', { expectedUndoId: ids.u1 });
    expect(undo1).toMatchObject({ applied: true, noOp: false });
    expect(mock.snapshot()).not.toEqual({ ...start, dirty: true });

    // The redo history now has u1 on top.
    expect(await ok('edit.redo', { expectedUndoId: ids.u1 })).toMatchObject({ applied: true });
    expect(await ok('edit.redo', { expectedUndoId: ids.u2 })).toMatchObject({ applied: true });
    expect(mock.snapshot()).toEqual({ ...start, dirty: true });
    expect((await ok('edit.getHistory')).history).toMatchObject({ undoCount: 2, redoCount: 0 });

    // The data is the same but no token is: a stale expectedRevision must keep failing.
    const tokensAfter = (await ok('project.get')).asOf;
    expect(tokensAfter).not.toEqual(tokensBefore);
  });

  it('keeps an entry changing nothing as a success that still marks the project changed', async () => {
    const { mock, ok } = await sessions.open();
    const ids = mock.given({
      dirty: false,
      clips: [clip({ trackId: 1 })],
      history: {
        undo: [{ bind: 'move', origin: 'control', action: 'clipMove', clip: 'clip', trackDeletedAfter: true }],
        redo: [],
      },
    });
    const result = await ok('edit.undo', { expectedUndoId: ids.move, force: true });
    expect(result).toMatchObject({
      applied: true,
      noOp: true,
      changes: [],
      revisionDiff: { arrangement: null, trackState: null, contents: [] },
      dirty: { before: false, after: true },
      warnings: [{ code: 'UNDO_NO_EFFECT' }],
    });
    // The step is used up: the entry is on the redo history now.
    expect((await ok('edit.getHistory')).history).toMatchObject({ undoCount: 0, redoCount: 1 });
  });

  it('applies a clip move as a change of the arrangement', async () => {
    const { mock, ok } = await sessions.open();
    const ids = mock.given({
      clips: [clip()],
      history: { undo: [{ bind: 'move', origin: 'control', action: 'clipMove', clip: 'clip' }], redo: [] },
    });
    const undone = await ok('edit.undo', { expectedUndoId: ids.move });
    expect(undone.revisionDiff).toMatchObject({ arrangement: { before: expect.any(String) as string } });
    expect(undone.changes).toMatchObject([
      { entity: 'placement', fields: { startTimelineSec: { before: 2, after: 1 } } },
    ]);
    expect(undone.tokens).toMatchObject({ placements: [{ placementId: ids['clip.placementId'] }] });
  });

  it('refuses an unsafe entry on top, with force too, and shows it in the history', async () => {
    const { mock, ok, fails } = await sessions.open();
    mock.given({
      clips: [clip()],
      history: {
        undo: [
          { origin: 'ui', action: 'noteEdit', clip: 'clip' },
          { origin: 'ui', action: 'clipSplit', clip: 'clip' },
        ],
        redo: [],
      },
    });
    expect((await fails('edit.undo', { force: true })).data).toMatchObject({ reason: 'undo_unsafe_build' });
    expect((await ok('edit.getHistory')).history).toMatchObject({
      undoCount: 2,
      undoTop: { unsafe: true, undoId: null },
    });
  });

  it('applies an entry from the UI that is possibly stale with a warning, and clears it only with force', () => {
    const world = new World(INSTANCE_ID, new ManualClock());
    const entry = (): HistoryEntry => ({
      seq: world.nextUndoId().seq,
      origin: 'ui',
      action: 'noteEdit',
      description: 'Edit notes',
      innerActions: ['setNotes'],
      undoPatch: null,
      redoPatch: null,
      possiblyStale: true,
      unsafe: false,
    });
    const run = (params: Record<string, unknown>) =>
      historyHandlers['edit.undo']?.({ world, params, exportLock: false, hasCapability: () => true, redact: (t) => t });
    world.undoStack = [entry(), entry()];
    const [lower, upper] = world.undoStack;

    // A UI entry that already has an undoId and is possibly stale is applied with a warning.
    const warned = run({ expectedUndoId: world.undoIdOf(upper?.seq ?? 0) });
    expect(warned?.warnings).toEqual([
      { code: 'UNDO_ENTRY_POSSIBLY_STALE', subject: null, data: null },
      { code: 'UNDO_NO_EFFECT', subject: null, data: null },
    ]);
    expect(warned?.entry).toMatchObject({ possiblyStale: true });
    // With force the same entry is confirmed by the end user: no warning, and the flag is cleared.
    const forced = run({ force: true });
    expect(forced?.warnings).toEqual([{ code: 'UNDO_NO_EFFECT', subject: null, data: null }]);
    expect(forced?.entry).toMatchObject({ undoId: world.undoIdOf(lower?.seq ?? 0), possiblyStale: false });
  });
});

describe('busy checks (section 13.2)', () => {
  it('refuses a write without waiting while the UI is busy, and keeps answering reads', async () => {
    const { mock, ok, fails } = await sessions.open();
    const ids = mock.given({
      clips: [clip()],
      history: { undo: [{ bind: 'u1', origin: 'control', action: 'pitchShift', clip: 'clip' }], redo: [] },
    });
    for (const [state, reason] of [
      [{ pointerDown: true }, 'pointer_down'],
      [{ modalOpen: true }, 'modal_open'],
      [{ importInProgress: true }, 'import_in_progress'],
      [{ projectOperation: true }, 'project_operation'],
    ] as const) {
      mock.setBusy({
        pointerDown: false,
        modalOpen: false,
        importInProgress: false,
        projectOperation: false,
        ...state,
      });
      const error = await fails('edit.undo', { expectedUndoId: ids.u1 });
      expect(error).toMatchObject({
        message: 'BUSY',
        data: { reason, retryable: true, executed: false, retryAfterMs: 1000 },
      });
      expect(await ok('project.get')).toHaveProperty('project');
    }
    mock.setBusy({ projectOperation: false });
    expect(await ok('edit.undo', { expectedUndoId: ids.u1 })).toMatchObject({ applied: true });
  });

  it('holds the export lock while an export job is not finished', async () => {
    const { mock, fails } = await sessions.open();
    const ids = mock.given({
      clips: [clip()],
      jobs: [{ bind: 'export', kind: 'export', state: 'running', cancellable: true }],
      history: { undo: [{ bind: 'u1', origin: 'control', action: 'pitchShift', clip: 'clip' }], redo: [] },
    });
    expect((await fails('edit.undo', { expectedUndoId: ids.u1 })).data).toMatchObject({ reason: 'export_in_progress' });
    await (await sessions.open()).ok('project.get'); // another instance is not affected
  });
});

describe('reads follow the model', () => {
  it('describes tracks, placements and contents, with nulls and their reasons', async () => {
    const { mock, ok } = await sessions.open();
    mock.given({
      dirty: true,
      clips: [clip(), clip({ bind: 'later', trackId: 5, analysis: 'running', notes: [] })],
    });
    const project = await ok('project.get');
    expect(project).toMatchObject({
      project: { path: null, dirty: true },
      visibleTrackCount: 6,
      derived: ['tracks[].label'],
    });
    const tracks = project.tracks as { label: string; visible: boolean; placementCount: number }[];
    expect(tracks).toHaveLength(8);
    expect(tracks.map((t) => t.visible)).toEqual([true, true, true, true, true, true, false, false]);
    expect(tracks[0]).toMatchObject({ label: 'Track 1', placementCount: 1 });
    const contents = project.contents as { f0State: string; key: unknown; noteCount: number; nullReasons?: object }[];
    expect(contents[0]).toMatchObject({ f0State: 'ready', key: { origin: 'automatic' }, noteCount: 3 });
    expect(contents[1]).toMatchObject({ f0State: 'extracting', key: null, nullReasons: { key: 'not_analyzed' } });
  });

  it('withdraws history from project.get when the instance lacks history.v1', async () => {
    const { mock, ok, fails } = await sessions.open();
    mock.given({ withoutCapabilities: ['history.v1'] });
    expect(await ok('project.get')).toMatchObject({ history: null, nullReasons: { history: 'capability_missing' } });
    expect((await fails('edit.getHistory')).data).toMatchObject({ reason: 'capability_missing' });
  });

  it('pages notes with a cursor that is bound to the content tokens', async () => {
    const { mock, ok, fails } = await sessions.open();
    const ids = mock.given({
      clips: [clip()],
      history: { undo: [{ bind: 'u1', origin: 'control', action: 'noteEdit', clip: 'clip' }], redo: [] },
    });
    const contentId = ids['clip.contentId'];
    const first = await ok('content.getNotes', { contentId, limit: 2 });
    expect(first).toMatchObject({ totalCount: 3, nextCursor: expect.any(String) as string });
    expect((first.notes as { index: number }[]).map((n) => n.index)).toEqual([0, 1]);
    const second = await ok('content.getNotes', { contentId, cursor: first.nextCursor, limit: 2 });
    expect((second.notes as { index: number }[]).map((n) => n.index)).toEqual([2]);
    expect(second.nextCursor).toBeNull();

    expect((await fails('content.getNotes', { contentId, cursor: 'garbage' })).data).toMatchObject({
      reason: 'invalid_params',
    });
    await ok('edit.undo', { expectedUndoId: ids.u1 });
    expect((await fails('content.getNotes', { contentId, cursor: first.nextCursor })).data).toMatchObject({
      reason: 'cursor_stale',
    });
  });

  it('reports the analysis state instead of gating reads', async () => {
    const { mock, ok } = await sessions.open();
    const ids = mock.given({
      clips: [
        clip({ bind: 'running', analysis: 'running', notes: [] }),
        clip({ bind: 'failed', analysis: 'failed', notes: [] }),
        clip({ bind: 'silent', analysis: 'unvoiced', notes: [] }),
      ],
    });
    const curve = (name: string) => ok('content.getPitchCurve', { contentId: ids[`${name}.contentId`], limit: 20 });
    expect(await curve('running')).toMatchObject({ f0State: 'extracting', pointCount: 0, originalMidi: [] });
    expect(await curve('failed')).toMatchObject({ f0State: 'failed', pointCount: 0 });
    const silent = await curve('silent');
    expect(silent).toMatchObject({ f0State: 'ready', pointCount: 20 });
    expect(new Set(silent.originalMidi as unknown[])).toEqual(new Set([null]));
    for (const [name, failure] of [
      ['running', null],
      ['failed', 'f0_failed'],
      ['silent', 'f0_empty'],
    ] as const) {
      const details = await ok('content.getDetails', { contentId: ids[`${name}.contentId`] });
      expect(details).toMatchObject({ analysis: { failure }, key: null, nullReasons: { key: 'not_analyzed' } });
      expect((details.autoModes as { available: string[] }).available).toEqual([]);
    }
    const segments = await ok('content.segmentNotes', { contentId: ids['running.contentId'] });
    expect(segments.segments).toEqual([]);
  });

  it('segments finer with a smaller note-split sensitivity, and keeps the corrected curve on the notes', async () => {
    const { mock, ok } = await sessions.open();
    const ids = mock.given({ clips: [clip()] });
    const contentId = ids['clip.contentId'];
    const count = async (noteSplitCents: number) =>
      ((await ok('content.segmentNotes', { contentId, noteSplitCents })).segments as unknown[]).length;
    expect(await count(80)).toBeGreaterThan(await count(200));

    const curve = (range: { startContentSec: number; endContentSec: number }) =>
      ok('content.getPitchCurve', { contentId, range });
    // Before the first note the corrected pitch is the detected pitch; inside it, it is not.
    const before = await curve({ startContentSec: 0.1, endContentSec: 0.2 });
    expect(before.correctedMidi).toEqual(before.originalMidi);
    const inside = await curve({ startContentSec: 0.5, endContentSec: 0.6 });
    expect(inside.correctedMidi).not.toEqual(inside.originalMidi);
    expect(inside).toMatchObject({ hopSec: 0.01, pointCount: 10, startContentSec: 0.5 });
  });

  it('keeps the audible render pending until it has settled', async () => {
    const clock = new ManualClock();
    const { mock, ok } = await sessions.open({ clock });
    const ids = mock.given({
      clips: [clip()],
      history: { undo: [{ bind: 'u1', origin: 'control', action: 'pitchShift', clip: 'clip' }], redo: [] },
    });
    const render = async () => (await ok('content.getDetails', { contentId: ids['clip.contentId'] })).render;
    expect(await render()).toMatchObject({ current: true });
    const undone = await ok('edit.undo', { expectedUndoId: ids.u1 });
    expect(undone.sideEffects).toMatchObject({ reRenderQueued: { contentIds: [ids['clip.contentId']], revert: null } });
    expect(await render()).toMatchObject({ current: false });
    clock.advance(RENDER_SETTLE_MS);
    expect(await render()).toMatchObject({ current: true });
  });

  it('answers prefs.get and transport.get from the state, and reads the log with secrets and home removed', async () => {
    const { mock, ok } = await sessions.open();
    mock.given({ editingScheme: 'openDyne' });
    expect(await ok('prefs.get')).toMatchObject({ processing: { editingScheme: 'openDyne', tuningHz: 440 } });
    expect(await ok('transport.get')).toMatchObject({ transport: { playing: false, bpm: 120 } });
    const { token, serverProof } = mock.discovery;
    mock.logLine(`token ${token} proof ${String(serverProof)} file ${path.join(os.homedir(), 'a.wav')}`);
    mock.logLine('x'.repeat(5000));
    const log = await ok('app.getLog', { maxLines: 2 });
    const lines = log.lines as string[];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/token <redacted> proof <redacted> file ~/);
    expect(lines[0]).not.toContain(token);
    expect(lines[1]?.length).toBeLessThanOrEqual(4096);
    expect(log.truncated).toBe(true);
    expect(DEFAULT_NOTE_PARAMS.retuneSpeed).toBeGreaterThan(0);
  });

  it('removes the home directory from log lines written with forward slashes, and on Windows in any case', async () => {
    const { mock, ok } = await sessions.open();
    const home = os.homedir();
    mock.logLine(`opened ${home.replaceAll('\\', '/')}/Music/a.wav`);
    if (process.platform === 'win32') mock.logLine(`opened ${home.toUpperCase()}\\Music\\b.wav`);
    const lines = (await ok('app.getLog', { maxLines: 5 })).lines as string[];
    const opened = lines.filter((line) => line.includes('opened'));
    expect(opened.length).toBeGreaterThan(0);
    for (const line of opened) expect(line).toMatch(/opened ~[\\/]Music[\\/][ab]\.wav$/);
  });
});

describe('given and the test interface', () => {
  it('provides the files of the `files` precondition and removes them when the mock stops', async () => {
    const { mock } = await sessions.open();
    const bound = mock.given({
      files: [
        { bind: 'audio', kind: 'audio', durationSec: 2 },
        { bind: 'absent', kind: 'absent', extension: '.mp3' },
        { bind: 'existing', kind: 'existing' },
        { bind: 'garbled', kind: 'undecodable' },
        { bind: 'locked', kind: 'noAccess' },
      ],
    });
    const wav = readFileSync(bound.audio ?? '');
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.length).toBe(44 + 2 * 16_000 * 2);
    expect(bound.absent).toMatch(/\.mp3$/);
    expect(existsSync(bound.absent ?? '')).toBe(false);
    expect(statSync(path.dirname(bound.absent ?? '')).isDirectory()).toBe(true);
    expect(existsSync(bound.existing ?? '')).toBe(true);
    expect(existsSync(bound['existing.next'] ?? '')).toBe(false);
    expect(path.basename(bound['existing.next'] ?? '')).toBe('existing (2).wav');
    expect(path.dirname(bound['existing.next'] ?? '')).toBe(path.dirname(bound.existing ?? ''));
    expect(
      readFileSync(bound.garbled ?? '')
        .subarray(0, 4)
        .toString('ascii'),
    ).not.toBe('RIFF');
    expect(existsSync(path.dirname(bound.locked ?? ''))).toBe(true);
    expect(existsSync(bound.locked ?? '')).toBe(false);

    await mock.stop();
    expect(existsSync(path.dirname(path.dirname(bound.audio ?? '')))).toBe(false);
  });

  it('creates the source of a clip, silent when the clip has no voice, and binds handles and tokens', async () => {
    const { mock, ok } = await sessions.open();
    const ids = mock.given({
      clips: [
        clip({ timeGrid: [{ bind: 'h1', contentSec: 1 }], referenceClip: 'ref' }),
        clip({ bind: 'ref', trackId: 1, analysis: 'unvoiced', notes: [] }),
      ],
    });
    expect(
      readFileSync(ids['clip.sourcePath'] ?? '')
        .subarray(0, 4)
        .toString('ascii'),
    ).toBe('RIFF');
    const silent = readFileSync(ids['ref.sourcePath'] ?? '').subarray(44);
    expect(silent.every((byte) => byte === 0)).toBe(true);
    const details = await ok('content.getDetails', { contentId: ids['clip.contentId'] });
    expect(details).toMatchObject({
      timeGrid: { seeded: true, identity: true, handles: [{ handleId: ids.h1 }] },
      reference: { referencePlacementId: ids['ref.placementId'] },
    });
    expect(ids['clip.revision']).toBe((details.asOf as { contents: { revision: string }[] }).contents[0]?.revision);
    expect(Object.keys(ids)).toEqual(
      expect.arrayContaining(['clip.gridRevision', 'clip.keyRevision', 'clip.geometryHash']),
    );
  });

  it('rejects preconditions it cannot establish', async () => {
    const { mock } = await sessions.open();
    expect(() => mock.given({ modalFlavour: 1 })).toThrow(UnsupportedPrecondition);
    expect(() => mock.given({ clips: [clip({ referenceClip: 'nowhere' })] })).toThrow(/nowhere/);
    expect(() =>
      mock.given({
        clips: [clip()],
        history: { undo: [{ origin: 'ui', action: 'noteEdit', clip: 'other' }], redo: [] },
      }),
    ).toThrow(/other/);
  });

  it('answers the runner names from its state', async () => {
    const { mock, fails } = await sessions.open({ instanceId: INSTANCE_ID });
    expect(mock.runnerValue('runner.lastTrackId')).toBe(7);
    expect(mock.runnerValue('runner.unknownTrackId')).toBe(8);
    expect(mock.runnerValue('runner.nothing')).toBeUndefined();
    const unknown = mock.runnerValue('runner.unknownContentId');
    const stale = mock.runnerValue('runner.staleContentId');
    expect(unknown).toMatch(/^c:01234567:0:\d+$/);
    expect(stale).toMatch(/^c:(?!01234567)[0-9a-f]{8}:0:1$/);
    expect((await fails('content.getDetails', { contentId: unknown })).data).toMatchObject({
      reason: 'unknown_handle',
    });
    expect((await fails('content.getDetails', { contentId: stale })).data).toMatchObject({ reason: 'stale_handle' });
  });

  it('changes the analysis of a content for a test and finds a key when it becomes ready', async () => {
    const { mock, ok } = await sessions.open();
    const ids = mock.given({ clips: [clip({ analysis: 'running', notes: [] })] });
    const contentId = ids['clip.contentId'] ?? '';
    mock.setAnalysis(contentId, 'ready');
    expect(await ok('content.getDetails', { contentId })).toMatchObject({
      analysis: { f0State: 'ready' },
      key: { root: 0, scale: 'major', origin: 'automatic' },
    });
    expect(() => {
      mock.setAnalysis('c:01234567:0:99', 'failed');
    }).toThrow();
  });

  it('counts accepted connections and lets a test wait for them', async () => {
    const { mock } = await sessions.open();
    expect(mock.acceptedConnections).toBe(1);
    expect(mock.openConnections).toBe(1);
    const second = await RunnerConnection.open(mock.address.port);
    await mock.whenAccepted(2);
    expect(mock.acceptedConnections).toBe(2);
    expect(mock.openConnections).toBe(2);
    second.destroy();
    await mock.whenAccepted(1);
  });
});
