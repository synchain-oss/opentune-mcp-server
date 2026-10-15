// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The mock's preferences and audio device methods beyond what the contract vectors show: revert
// recipes applied as given, the scheme change as a job, and the rollback of a device that fails to open.

import { afterEach, describe, expect, it } from 'vitest';

import { ManualClock } from '../../mock/clock.js';
import { Sessions, clip, type TestSession } from '../support/mock-client.js';

const sessions = new Sessions();
afterEach(async () => {
  await sessions.dispose();
});

interface Revert {
  method: string;
  params: Record<string, unknown>;
}

const field = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], value);

async function revert(session: TestSession, result: Record<string, unknown>) {
  const recipe = field(result, 'undo', 'revert') as Revert | null;
  if (recipe === null) throw new Error('the result has no revert recipe');
  return session.ok(recipe.method, recipe.params);
}

const processing = async (session: TestSession) => (await session.ok('prefs.get')).processing;

describe('prefs.set', () => {
  it('changes preferences, names them in one warning, and its revert recipe puts the old values back', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    mock.given({ clips: [clip()] });
    const before = await processing(session);
    const set = await ok('prefs.set', { tuningHz: 432, hybridMode: true, experimentalFeatures: true });
    expect(set.changes).toMatchObject([
      {
        entity: 'preference',
        ref: { preference: 'tuningHz' },
        fields: { tuningHz: { before: 440, after: 432, unit: 'hz' } },
      },
      { ref: { preference: 'hybridMode' }, fields: { hybridMode: { before: false, after: true } } },
      { ref: { preference: 'experimentalFeatures' } },
    ]);
    expect(set.warnings).toMatchObject([
      { code: 'GLOBAL_PREFERENCE', data: { preferences: ['tuningHz', 'hybridMode', 'experimentalFeatures'] } },
      { code: 'NOT_RETROACTIVE' },
    ]);
    // Switching hybrid mode renders every content again.
    expect(field(set, 'sideEffects', 'reRenderQueued', 'contentIds')).toHaveLength(1);
    expect(await processing(session)).toMatchObject({ tuningHz: 432, hybridMode: true, experimentalFeatures: true });
    expect((await ok('session.info')).processing).toMatchObject({ tuningHz: 432, experimentalFeatures: true });
    // It is not a change of the project.
    expect(set).toMatchObject({ dirty: { before: false, after: false } });

    await revert(session, set);
    expect(await processing(session)).toEqual(before);
    expect(await ok('prefs.set', { tuningHz: 440 })).toMatchObject({ noOp: true, changes: [], warnings: [] });
  });

  it('hands a scheme change to a job that applies every change of the call, and generates notes for the open clip', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { mock, ok } = session;
    const ids = mock.given({
      clips: [{ bind: 'clip', trackId: 0, startTimelineSec: 0, durationSec: 6, analysis: 'ready' }],
    });
    await ok('ui.setSelection', { placementId: ids['clip.placementId'], openEditor: true });
    const started = await ok('prefs.set', { editingScheme: 'openDyne', tuningHz: 442 });
    expect(started).toMatchObject({ applied: false, changes: [], job: { kind: 'prefsApply' } });
    // Nothing is applied before the job runs.
    expect(await processing(session)).toMatchObject({ editingScheme: 'openTune', tuningHz: 440 });
    clock.advance(0);
    const { job } = (await ok('job.get', { jobId: field(started, 'job', 'jobId'), waitMs: 5000 })) as {
      job: { state: string; cancellable: boolean; result: Record<string, unknown> };
    };
    expect(job).toMatchObject({ state: 'succeeded', cancellable: false });
    expect(job.result).toMatchObject({
      applied: true,
      sideEffects: { notesGenerated: { contentId: ids['clip.contentId'] } },
      dirty: { before: false, after: true },
    });
    expect((job.result.warnings as { code: string }[]).map((w) => w.code)).toEqual([
      'GLOBAL_PREFERENCE',
      'NOT_RETROACTIVE',
      'SCHEME_GENERATED_NOTES',
      'IRREVERSIBLE',
    ]);
    expect(await processing(session)).toMatchObject({ editingScheme: 'openDyne', tuningHz: 442 });
    expect(mock.snapshot().contents[0]?.notes.length).toBeGreaterThan(0);
  });

  it('is refused while a dialog is open', async () => {
    const session = await sessions.open();
    session.mock.given({ dialogs: [{ kind: 'preferences' }] });
    expect((await session.fails('prefs.set', { hybridMode: true })).data).toMatchObject({ reason: 'modal_open' });
  });
});

describe('audio.get and audio.set', () => {
  it('reports no device, opens one with the setup asked for, and its revert recipe restores the previous setup', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const none = await ok('audio.get');
    expect(none.device).toMatchObject({
      running: false,
      sampleRateHz: null,
      nullReasons: { sampleRateHz: 'no_audio_device' },
    });
    expect((await ok('session.info')).audioDevice).toMatchObject({ running: false, name: null });

    mock.given({ audio: { running: true } });
    const running = await ok('audio.get');
    expect(running.device).toMatchObject({
      running: true,
      sampleRateHz: 44100,
      bufferSizeFrame: 512,
      outputChannelPair: 0,
    });
    const set = await ok('audio.set', { sampleRateHz: 48000, bufferSizeFrame: 256 });
    expect(set.device).toMatchObject({ sampleRateHz: 48000, bufferSizeFrame: 256 });
    expect(set.changes).toMatchObject([
      {
        entity: 'audioDevice',
        fields: {
          sampleRateHz: { before: 44100, after: 48000, unit: 'hz' },
          bufferSizeFrame: { before: 512, after: 256 },
        },
      },
    ]);
    expect((await ok('session.info')).audioDevice).toMatchObject({ running: true, sampleRateHz: 48000 });
    await revert(session, set);
    expect((await ok('audio.get')).device).toEqual(running.device);
    expect(await ok('audio.set', { sampleRateHz: 44100 })).toMatchObject({ noOp: true, changes: [] });
  });

  it('refuses a value the setup does not offer, and restores the setup when the device fails to open', async () => {
    const session = await sessions.open();
    const { mock, ok, fails } = session;
    mock.given({ audio: { running: true, failsToOpen: true } });
    const before = await ok('audio.get');
    expect((await fails('audio.set', { sampleRateHz: 96000 })).data).toMatchObject({
      reason: 'audio_setting_unavailable',
      executed: false,
    });
    expect((await fails('audio.set', { outputChannelPair: 3 })).data).toMatchObject({
      reason: 'audio_setting_unavailable',
    });
    expect((await fails('audio.set', { sampleRateHz: 48000 })).data).toMatchObject({
      kind: 'IO_ERROR',
      reason: 'device_open_failed',
      executed: false,
    });
    expect(await ok('audio.get')).toEqual(before);
  });

  it('lets playback start without the no-device warning once a device runs', async () => {
    const session = await sessions.open();
    const { ok } = session;
    expect((await ok('transport.control', { action: 'play' })).warnings).toMatchObject([{ code: 'NO_AUDIO_DEVICE' }]);
    await ok('audio.set', { sampleRateHz: 48000 });
    expect((await ok('transport.control', { action: 'play' })).warnings).toEqual([]);
  });
});
