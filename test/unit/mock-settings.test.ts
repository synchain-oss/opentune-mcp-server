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

  it('fails the scheme job with BUSY when a dialog opened after the call, and changes no preference', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { mock, ok } = session;
    const before = await processing(session);
    const started = await ok('prefs.set', { editingScheme: 'openDyne', tuningHz: 442 });
    expect(started).toMatchObject({ applied: false, job: { kind: 'prefsApply' } });
    // The dialog opens between the call and the job's first step.
    mock.setBusy({ modalOpen: true });
    clock.advance(0);
    const { job } = (await ok('job.get', { jobId: field(started, 'job', 'jobId') })) as {
      job: { state: string; result: unknown; error: { data: Record<string, unknown> } | null };
    };
    expect(job.state).toBe('failed');
    expect(job.error?.data).toMatchObject({ kind: 'BUSY', reason: 'modal_open', retryable: true, executed: false });
    mock.setBusy({ modalOpen: false });
    expect(await processing(session)).toEqual(before);
  });
});

interface JobView {
  state: string;
  result: Record<string, unknown> | null;
  error: { data: Record<string, unknown> } | null;
}

const jobOf = async (session: TestSession, started: Record<string, unknown>): Promise<JobView> =>
  ((await session.ok('job.get', { jobId: field(started, 'job', 'jobId') })) as { job: JobView }).job;

const vocoderOf = async (session: TestSession) => {
  const { processing: info } = (await session.ok('session.info')) as {
    processing: { vocoderReady: boolean; vocoderReconfiguring: boolean };
  };
  return { ready: info.vocoderReady, reconfiguring: info.vocoderReconfiguring };
};

const OPTIONS = { vocoderWeight: ['hifigan.onnx', 'hifigan_coulin9.onnx'], f0Model: ['fcpe', 'rmvpe'] };

describe('prefs.get and prefs.set: vocoder weight, rendering priority, pitch model, reference alignment mode', () => {
  it('lists the values prefs.set accepts in processing.options, which session.info does not report', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    expect(await processing(session)).toMatchObject({
      vocoderWeight: 'hifigan.onnx',
      renderingPriority: 'gpuFirst',
      f0Model: 'fcpe',
      referenceAlignMode: 'standardAuto',
      options: {
        vocoderWeight: ['hifigan.onnx', 'hifigan_coulin9.onnx'],
        f0Model: ['fcpe'],
        renderingPriority: ['gpuFirst', 'cpuFirst'],
        referenceAlignMode: ['standardAuto', 'game'],
      },
    });
    const info = (await ok('session.info')).processing as Record<string, unknown>;
    expect(info).toMatchObject({ vocoderWeight: 'hifigan.onnx', vocoderReady: true, vocoderReconfiguring: false });
    expect(info).not.toHaveProperty('options');
    // A test can describe a different installation.
    mock.given({ preferences: { options: { vocoderWeight: ['a.onnx'], f0Model: ['fcpe', 'rmvpe'] } } });
    expect(field(await processing(session), 'options')).toMatchObject({
      vocoderWeight: ['a.onnx'],
      f0Model: ['fcpe', 'rmvpe'],
    });
  });

  it('lists the changes of a call in the order of the schema, whatever order the members came in', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { mock, ok } = session;
    mock.given({ clips: [clip()] });
    const started = await ok('prefs.set', {
      referenceAlignMode: 'game',
      renderingPriority: 'cpuFirst',
      vocoderWeight: 'hifigan_coulin9.onnx',
      hybridMode: true,
      tuningHz: 432,
    });
    expect(started).toMatchObject({ applied: false, changes: [], job: { kind: 'prefsApply' } });
    clock.advance(1000);
    const job = await jobOf(session, started);
    expect(job.state).toBe('succeeded');
    const names = ['tuningHz', 'hybridMode', 'vocoderWeight', 'renderingPriority', 'referenceAlignMode'];
    expect((job.result?.changes as { ref: { preference: string } }[]).map((c) => c.ref.preference)).toEqual(names);
    expect(job.result?.warnings).toMatchObject([
      { code: 'GLOBAL_PREFERENCE', data: { preferences: names } },
      { code: 'NOT_RETROACTIVE', subject: { preference: 'tuningHz' } },
      { code: 'EXPERIMENTAL_FEATURE', subject: { preference: 'referenceAlignMode' }, data: null },
    ]);
    expect(field(job.result, 'undo', 'revert', 'params')).toEqual({
      tuningHz: 440,
      hybridMode: false,
      vocoderWeight: 'hifigan.onnx',
      renderingPriority: 'gpuFirst',
      referenceAlignMode: 'standardAuto',
    });
  });

  it('queues a render only for a vocoder weight and hybrid mode, not for a rendering priority', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const ids = session.mock.given({ clips: [clip()] });
    const start = async (params: Record<string, unknown>) => {
      const started = await session.ok('prefs.set', params);
      clock.advance(1000);
      return jobOf(session, started);
    };
    const priority = await start({ renderingPriority: 'cpuFirst' });
    expect(priority.state).toBe('succeeded');
    expect(priority.result?.sideEffects).toEqual({});
    const weight = await start({ vocoderWeight: 'hifigan_coulin9.onnx' });
    expect(field(weight.result, 'sideEffects', 'reRenderQueued', 'contentIds')).toEqual([ids['clip.contentId']]);
    // The reference alignment mode takes effect at the next AUTO Ref: nothing is rendered.
    const mode = await session.ok('prefs.set', { referenceAlignMode: 'game' });
    expect(mode.job).toBeNull();
    expect(mode.sideEffects).toEqual({});
  });

  it('applies the pitch model, the reference alignment mode and the experimental features without a job', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    mock.given({ preferences: { options: OPTIONS } });
    const set = await ok('prefs.set', { f0Model: 'rmvpe', referenceAlignMode: 'game', experimentalFeatures: true });
    expect(set).toMatchObject({ applied: true, job: null });
    expect(await processing(session)).toMatchObject({
      f0Model: 'rmvpe',
      referenceAlignMode: 'game',
      experimentalFeatures: true,
    });
    await revert(session, set);
    expect(await processing(session)).toMatchObject({
      f0Model: 'fcpe',
      referenceAlignMode: 'standardAuto',
      experimentalFeatures: false,
    });
    // The values it already has: nothing to do, and no job.
    expect(
      await ok('prefs.set', { f0Model: 'fcpe', vocoderWeight: 'hifigan.onnx', renderingPriority: 'gpuFirst' }),
    ).toMatchObject({ noOp: true, job: null, changes: [] });
  });

  it('refuses a vocoder weight or pitch model the installation does not offer, with nothing changed and no job', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { fails } = session;
    const before = await processing(session);
    for (const params of [
      { vocoderWeight: 'missing.onnx' },
      { f0Model: 'missing' },
      { tuningHz: 432, vocoderWeight: 'missing.onnx' },
    ]) {
      const error = await fails('prefs.set', params);
      expect(error).toMatchObject({ code: -32602 });
      expect(error.data).toMatchObject({
        kind: 'INVALID_ARGUMENT',
        reason: 'option_unavailable',
        retryable: false,
        executed: false,
      });
    }
    clock.advance(1000);
    expect(await processing(session)).toEqual(before);
  });

  it('fails a pitch model OpenTune cannot load with MODEL_UNAVAILABLE(model_missing), with nothing changed', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { mock, ok, fails } = session;
    mock.given({ preferences: { options: OPTIONS } });
    mock.failF0Model('rmvpe');
    const before = await processing(session);
    const direct = await fails('prefs.set', { f0Model: 'rmvpe', tuningHz: 432 });
    expect(direct.data).toMatchObject({ kind: 'MODEL_UNAVAILABLE', reason: 'model_missing', executed: false });
    expect(await processing(session)).toEqual(before);
    // Inside a job the pitch model is applied first, so the weight of the same call is not applied either.
    const started = await ok('prefs.set', { f0Model: 'rmvpe', vocoderWeight: 'hifigan_coulin9.onnx' });
    clock.advance(1000);
    const job = await jobOf(session, started);
    expect(job.state).toBe('failed');
    expect(job.error?.data).toMatchObject({ kind: 'MODEL_UNAVAILABLE', reason: 'model_missing', executed: false });
    expect(await processing(session)).toEqual(before);
  });

  it('waits until the vocoder is ready again, which it reports for a moment after the command', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { ok } = session;
    const started = await ok('prefs.set', { vocoderWeight: 'hifigan_coulin9.onnx' });
    clock.advance(0);
    // The change is made, but the command is still queued: the vocoder reports ready and not reconfiguring, and the
    // job must not take that for done.
    expect(await processing(session)).toMatchObject({ vocoderWeight: 'hifigan_coulin9.onnx' });
    expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
    clock.advance(4);
    expect((await jobOf(session, started)).state).toBe('running');
    expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
    clock.advance(1);
    expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: true });
    clock.advance(9);
    expect((await jobOf(session, started)).state).toBe('running');
    clock.advance(1);
    expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
    expect(await jobOf(session, started)).toMatchObject({ state: 'succeeded', result: { applied: true } });
  });

  it('does not wait for a vocoder that was not ready, but still hands it the change, nor for a scheme change alone', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { mock, ok } = session;
    // A reconfiguration that never finishes leaves the vocoder not ready.
    mock.setVocoderFault('stuck');
    const stuck = await ok('prefs.set', { renderingPriority: 'cpuFirst' });
    clock.advance(20);
    expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: true });
    // The next job commits and ends at once: there is no ready vocoder to wait for.
    const next = await ok('prefs.set', { vocoderWeight: 'hifigan_coulin9.onnx' });
    clock.advance(0);
    expect(await jobOf(session, next)).toMatchObject({ state: 'succeeded', result: { applied: true } });
    expect(await processing(session)).toMatchObject({
      renderingPriority: 'cpuFirst',
      vocoderWeight: 'hifigan_coulin9.onnx',
    });
    // The vocoder still gets the new weight: that reconfiguration supersedes the stuck one, so the fault going away
    // does not end it early, and the first job ends once the new one has.
    mock.setVocoderFault(null);
    clock.advance(10);
    expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: true });
    expect((await jobOf(session, stuck)).state).toBe('running');
    clock.advance(5);
    expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
    clock.advance(3);
    expect((await jobOf(session, stuck)).state).toBe('succeeded');
    // A scheme change alone reconfigures nothing.
    const scheme = await ok('prefs.set', { editingScheme: 'openDyne' });
    clock.advance(0);
    expect((await jobOf(session, scheme)).state).toBe('succeeded');
    expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
  });

  it('fails with MODEL_UNAVAILABLE(vocoder_not_ready) when the vocoder stays busy past the wait limit, and takes the call back', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock, vocoder: { waitLimitMs: 1000 } });
    const { mock, ok } = session;
    mock.setVocoderFault('stuck');
    const before = await processing(session);
    const started = await ok('prefs.set', {
      vocoderWeight: 'hifigan_coulin9.onnx',
      renderingPriority: 'cpuFirst',
      tuningHz: 442,
    });
    clock.advance(999);
    expect((await jobOf(session, started)).state).toBe('running');
    // The changes are in place while the job waits.
    expect(await processing(session)).toMatchObject({ vocoderWeight: 'hifigan_coulin9.onnx', tuningHz: 442 });
    expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: true });
    clock.advance(1);
    const job = await jobOf(session, started);
    expect(job.state).toBe('failed');
    expect(job.error?.data).toMatchObject({
      kind: 'MODEL_UNAVAILABLE',
      reason: 'vocoder_not_ready',
      retryable: true,
      executed: false,
    });
    expect(await processing(session)).toEqual(before);
    // The previous weight and priority go back to the vocoder, which loads them again: it reports reconfiguring while
    // the fault lasts and is ready once that reconfiguration ends. A new request then waits again from the start.
    clock.advance(100);
    expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: true });
    mock.setVocoderFault(null);
    expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
    const again = await ok('prefs.set', { vocoderWeight: 'hifigan_coulin9.onnx' });
    clock.advance(1000);
    expect((await jobOf(session, again)).state).toBe('succeeded');
  });

  it('fails at once with MODEL_UNAVAILABLE(vocoder_load_failed) when the vocoder cannot load the new weight, and takes the call back', async () => {
    const clock = new ManualClock();
    // A wait limit far away: the job must not need it.
    const session = await sessions.open({ clock, vocoder: { waitLimitMs: 1_000_000 } });
    const { mock, ok } = session;
    mock.setVocoderFault('loadFails');
    const before = await processing(session);
    const started = await ok('prefs.set', { vocoderWeight: 'hifigan_coulin9.onnx', tuningHz: 442 });
    clock.advance(14);
    expect((await jobOf(session, started)).state).toBe('running');
    expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: true });
    // The command ends with the vocoder not ready: the job does not wait for its limit.
    clock.advance(1);
    const job = await jobOf(session, started);
    expect(job.state).toBe('failed');
    expect(job.error?.data).toMatchObject({
      kind: 'MODEL_UNAVAILABLE',
      reason: 'vocoder_load_failed',
      retryable: false,
      executed: false,
    });
    expect(await processing(session)).toEqual(before);
    expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: false });
    // The previous weight goes back to the vocoder, which loads it again: reconfiguring while it does, then ready.
    clock.advance(5);
    expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: true });
    clock.advance(10);
    expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
    // A rendering priority fails the same way while the fault lasts, and succeeds once it is gone.
    const priority = await ok('prefs.set', { renderingPriority: 'cpuFirst' });
    clock.advance(15);
    const failed = await jobOf(session, priority);
    expect(failed.error?.data).toMatchObject({ reason: 'vocoder_load_failed' });
    expect(String(failed.error?.data.detail)).toMatch(/^the vocoder could not load the new weight or backend;/);
    expect(await processing(session)).toMatchObject({ renderingPriority: 'gpuFirst' });
    mock.setVocoderFault(null);
    clock.advance(15);
    expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
    const again = await ok('prefs.set', { vocoderWeight: 'hifigan_coulin9.onnx' });
    clock.advance(100);
    expect((await jobOf(session, again)).state).toBe('succeeded');
  });

  it('reports executed true when another write changed a preference of the call before the vocoder failed to load', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { mock, ok } = session;
    mock.setVocoderFault('loadFails');
    const started = await ok('prefs.set', { vocoderWeight: 'hifigan_coulin9.onnx', tuningHz: 442 });
    clock.advance(6);
    await ok('prefs.set', { tuningHz: 450 });
    clock.advance(9);
    const job = await jobOf(session, started);
    expect(job.error?.data).toMatchObject({ reason: 'vocoder_load_failed', retryable: false, executed: true });
    expect(String(job.error?.data.detail)).toContain('tuningHz');
    expect(await processing(session)).toMatchObject({ vocoderWeight: 'hifigan.onnx', tuningHz: 450 });
  });

  it('reports executed true when another write changed a preference of the call while the job waited', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock, vocoder: { waitLimitMs: 1000 } });
    const { mock, ok } = session;
    mock.setVocoderFault('stuck');
    const started = await ok('prefs.set', { vocoderWeight: 'hifigan_coulin9.onnx', tuningHz: 442 });
    clock.advance(500);
    await ok('prefs.set', { tuningHz: 450 });
    clock.advance(500);
    const job = await jobOf(session, started);
    expect(job.state).toBe('failed');
    expect(job.error?.data).toMatchObject({ reason: 'vocoder_not_ready', executed: true });
    expect(String(job.error?.data.detail)).toContain('tuningHz');
    // The weight went back; the tuning keeps the other write's value.
    expect(await processing(session)).toMatchObject({ vocoderWeight: 'hifigan.onnx', tuningHz: 450 });
  });

  it('reports the render of a new vocoder weight also when the job did not wait, and renders once the weight loaded', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { mock, ok } = session;
    const ids = mock.given({ clips: [clip()] });
    const contentId = ids['clip.contentId'];
    const desired = async () => field(await ok('content.getDetails', { contentId }), 'render', 'desiredRevision');
    // A vocoder that is not ready (a reconfiguration that never finishes) is not waited for.
    mock.setVocoderFault('stuck');
    await ok('prefs.set', { renderingPriority: 'cpuFirst' });
    clock.advance(20);
    expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: true });
    const before = await desired();
    const started = await ok('prefs.set', { vocoderWeight: 'hifigan_coulin9.onnx' });
    clock.advance(0);
    const job = await jobOf(session, started);
    expect(job).toMatchObject({ state: 'succeeded', result: { applied: true } });
    expect(job.result?.sideEffects).toEqual({ reRenderQueued: { contentIds: [contentId], revert: null } });
    // The render starts once the vocoder has loaded the new weight, after the job ended.
    expect(await desired()).toBe(before);
    mock.setVocoderFault(null);
    clock.advance(20);
    expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
    expect(await desired()).not.toBe(before);
    // Hybrid mode reports its render whatever the vocoder does.
    const hybrid = await ok('prefs.set', { hybridMode: true });
    expect(field(hybrid, 'sideEffects', 'reRenderQueued', 'contentIds')).toHaveLength(1);
  });

  it('renders nothing for a new vocoder weight that cannot be loaded, and the vocoder stays not ready', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { mock, ok } = session;
    const ids = mock.given({ clips: [clip()] });
    const contentId = ids['clip.contentId'];
    const desired = async () => field(await ok('content.getDetails', { contentId }), 'render', 'desiredRevision');
    mock.setVocoderFault('loadFails');
    // A rendering priority that cannot be loaded is taken back, and the vocoder loads the previous one again.
    await ok('prefs.set', { renderingPriority: 'cpuFirst' });
    clock.advance(21);
    expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: true });
    const before = await desired();
    // While it does, a new weight is not waited for; the result reports the render it causes once it loads.
    const started = await ok('prefs.set', { vocoderWeight: 'hifigan_coulin9.onnx' });
    clock.advance(0);
    const job = await jobOf(session, started);
    expect(job).toMatchObject({ state: 'succeeded', result: { applied: true } });
    expect(job.result?.sideEffects).toEqual({ reRenderQueued: { contentIds: [contentId], revert: null } });
    // It cannot be loaded: nothing is rendered, and the vocoder stays not ready.
    clock.advance(100);
    expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: false });
    expect(await desired()).toBe(before);
    expect(await processing(session)).toMatchObject({ vocoderWeight: 'hifigan_coulin9.onnx' });
  });

  describe('a vocoder that loads at the first render', () => {
    const shift = (ids: Record<string, string>, deltaCents = 10, revision = ids['clip.revision']) => ({
      contentId: ids['clip.contentId'],
      expectedRevision: revision,
      ops: [{ op: 'shiftCents', select: { indices: [0] }, deltaCents }],
    });
    /** The revision of the content a write result reports. */
    const revisionOf = (result: Record<string, unknown>): string =>
      (field(result, 'tokens', 'contents') as { revision: string }[])[0]?.revision ?? '';
    /** A clip whose one note sits on the detected pitch of the mock (within about 12 cents of it). */
    const onPitch = () => clip({ notes: [{ startContentSec: 0.1, endContentSec: 0.5, targetMidi: 64 }] });
    const renderOf = async (session: TestSession, ids: Record<string, string>) =>
      field(await session.ok('content.getDetails', { contentId: ids['clip.contentId'] }), 'render') as {
        current: boolean;
        publishedRevision: string;
      };

    it('is not ready until an edit has to be rendered, then loads, and publishes the render only once it has', async () => {
      const clock = new ManualClock();
      const session = await sessions.open({ clock, vocoder: { reconfiguringMs: 100 } });
      const { mock, ok } = session;
      const ids = mock.given({ clips: [clip()] });
      // By default the vocoder is ready from the start.
      expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
      mock.setVocoderLoadOnDemand(true);
      expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: false });
      // Nothing is rendered, so nothing loads it.
      clock.advance(1000);
      expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: false });
      const published = (await renderOf(session, ids)).publishedRevision;

      const edited = await ok('content.editNotes', shift(ids));
      expect((await renderOf(session, ids)).current).toBe(false);
      // The command is queued first; then the vocoder loads, and the render, done by now, waits for it.
      clock.advance(6);
      expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: true });
      clock.advance(40);
      expect((await renderOf(session, ids)).current).toBe(false);
      clock.advance(70);
      expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
      const after = await renderOf(session, ids);
      expect(after.current).toBe(true);
      expect(after.publishedRevision).not.toBe(published);

      // Loaded now: a further render needs no load and settles on its own.
      await ok('edit.undo', { expectedUndoId: field(edited, 'undo', 'undoId') });
      clock.advance(30);
      expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
      expect((await renderOf(session, ids)).current).toBe(true);
    });

    it('keeps the vocoder not ready, and the render waiting, when the load never ends', async () => {
      const clock = new ManualClock();
      const session = await sessions.open({ clock });
      const { mock, ok } = session;
      const ids = mock.given({ clips: [clip()] });
      mock.setVocoderLoadOnDemand(true);
      mock.setVocoderFault('stuck');
      await ok('content.editNotes', shift(ids));
      clock.advance(10_000);
      expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: true });
      expect((await renderOf(session, ids)).current).toBe(false);
      // Once the fault is gone, the load ends and the render is published.
      mock.setVocoderFault(null);
      expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
      expect((await renderOf(session, ids)).current).toBe(true);
    });

    it('with hybrid mode on, renders a correction within 75 cents without the vocoder, and loads it for a larger one', async () => {
      const clock = new ManualClock();
      const session = await sessions.open({ clock });
      const { mock, ok } = session;
      const ids = mock.given({ clips: [onPitch()], preferences: { hybridMode: true } });
      mock.setVocoderLoadOnDemand(true);
      // 10 cents: the render is done by resampling, so it is published and nothing loads the vocoder.
      const small = await ok('content.editNotes', shift(ids, 10));
      clock.advance(1000);
      expect((await renderOf(session, ids)).current).toBe(true);
      expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: false });
      // Taking it back is a render of the same kind.
      await ok('edit.undo', { expectedUndoId: field(small, 'undo', 'undoId') });
      clock.advance(1000);
      expect((await renderOf(session, ids)).current).toBe(true);
      expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: false });
      // Beyond 75 cents the render needs the vocoder: it loads first, and the render is published once it has.
      const revision = ((await ok('content.getNotes', { contentId: ids['clip.contentId'] })) as { asOf: unknown }).asOf;
      const current = (field(revision, 'contents') as { revision: string }[])[0]?.revision;
      const large = await ok('content.editNotes', shift(ids, 200, current));
      clock.advance(6);
      expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: true });
      expect((await renderOf(session, ids)).current).toBe(false);
      clock.advance(1000);
      expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
      expect((await renderOf(session, ids)).current).toBe(true);
      expect(revisionOf(large)).not.toBe(revisionOf(small));
    });

    it('loads for a small correction when hybrid mode is off', async () => {
      const clock = new ManualClock();
      const session = await sessions.open({ clock });
      const { mock, ok } = session;
      const ids = mock.given({ clips: [onPitch()], preferences: { hybridMode: false } });
      mock.setVocoderLoadOnDemand(true);
      await ok('content.editNotes', shift(ids, 10));
      clock.advance(1000);
      expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
      expect((await renderOf(session, ids)).current).toBe(true);
    });

    it('leaves a render that was queued again while it waited to the later one', async () => {
      const clock = new ManualClock();
      const session = await sessions.open({ clock, vocoder: { reconfiguringMs: 100 } });
      const { mock, ok } = session;
      const ids = mock.given({ clips: [clip()] });
      mock.setVocoderLoadOnDemand(true);
      const edited = await ok('content.editNotes', shift(ids));
      // The first render is done and waits for the vocoder, which loads until 105 ms.
      clock.advance(100);
      expect((await renderOf(session, ids)).current).toBe(false);
      // A second render is queued; its timer fires 30 ms later, after the vocoder has loaded.
      await ok('edit.undo', { expectedUndoId: field(edited, 'undo', 'undoId') });
      clock.advance(6);
      expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
      // The vocoder's completion does not publish the first render over the second one.
      expect((await renderOf(session, ids)).current).toBe(false);
      clock.advance(30);
      expect((await renderOf(session, ids)).current).toBe(true);
    });

    it('is ready from the start again when switched off, and publishes the renders that waited', async () => {
      const clock = new ManualClock();
      const session = await sessions.open({ clock });
      const { mock, ok } = session;
      const ids = mock.given({ clips: [clip()] });
      mock.setVocoderLoadOnDemand(true);
      mock.setVocoderFault('stuck');
      await ok('content.editNotes', shift(ids));
      clock.advance(1000);
      expect((await renderOf(session, ids)).current).toBe(false);
      // A reconfiguration is running, so switching off leaves the vocoder alone until it ends.
      mock.setVocoderLoadOnDemand(false);
      expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: true });
      mock.setVocoderFault(null);
      expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
      expect((await renderOf(session, ids)).current).toBe(true);
    });
  });

  it('lets only the latest reconfiguration end the vocoder, so an earlier one never ends a later job early', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { ok } = session;
    const first = await ok('prefs.set', { renderingPriority: 'cpuFirst' });
    clock.advance(1);
    // The first command is still queued: the vocoder reports ready, so the second job waits as well.
    const second = await ok('prefs.set', { vocoderWeight: 'hifigan_coulin9.onnx' });
    clock.advance(14);
    // The first reconfiguration would have ended now; the second one still runs, and so do both jobs.
    expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: true });
    expect((await jobOf(session, first)).state).toBe('running');
    expect((await jobOf(session, second)).state).toBe('running');
    clock.advance(1);
    expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
    clock.advance(3);
    expect((await jobOf(session, first)).state).toBe('succeeded');
    expect((await jobOf(session, second)).state).toBe('succeeded');
  });

  it('fails every job that waits for a reconfiguration that cannot load, not only the first to see it', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { mock, ok } = session;
    mock.setVocoderFault('loadFails');
    const before = await processing(session);
    const priority = await ok('prefs.set', { renderingPriority: 'cpuFirst' });
    clock.advance(1);
    // Both jobs wait for the second reconfiguration, which supersedes the first and cannot load. The job that sees it
    // first takes its change back, and the vocoder reloads; that reload must not end the other job as a success.
    const weight = await ok('prefs.set', { vocoderWeight: 'hifigan_coulin9.onnx' });
    clock.advance(100);
    for (const started of [priority, weight]) {
      const job = await jobOf(session, started);
      expect(job.state).toBe('failed');
      expect(job.error?.data).toMatchObject({
        kind: 'MODEL_UNAVAILABLE',
        reason: 'vocoder_load_failed',
        executed: false,
      });
    }
    expect(await processing(session)).toEqual(before);
    expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
  });

  it('keeps a weight another write set while the job waited, and never reports a weight that did not load as ready', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { mock, ok } = session;
    mock.given({
      preferences: {
        vocoderWeight: 'a.onnx',
        options: { vocoderWeight: ['a.onnx', 'b.onnx', 'c.onnx'], f0Model: ['fcpe'] },
      },
    });
    mock.setVocoderFault('loadFails');
    const first = await ok('prefs.set', { vocoderWeight: 'b.onnx' });
    clock.advance(6);
    // Another write changes the weight while the vocoder reconfigures: its job does not wait, but the vocoder gets c.
    const second = await ok('prefs.set', { vocoderWeight: 'c.onnx' });
    clock.advance(0);
    expect((await jobOf(session, second)).state).toBe('succeeded');
    clock.advance(100);
    const job = await jobOf(session, first);
    expect(job.state).toBe('failed');
    expect(job.error?.data).toMatchObject({ reason: 'vocoder_load_failed', executed: true });
    expect(String(job.error?.data.detail)).toContain('vocoderWeight');
    // c keeps the other write's value; the vocoder could not load it and does not report it ready.
    expect(await processing(session)).toMatchObject({ vocoderWeight: 'c.onnx' });
    expect(await vocoderOf(session)).toEqual({ ready: false, reconfiguring: false });
  });

  it.each([
    ['stays busy past the wait limit', 'stuck', 'vocoder_not_ready'],
    ['cannot load the new weight', 'loadFails', 'vocoder_load_failed'],
  ] as const)(
    'keeps the notes that the switch to openDyne generated, and reports executed true, when the vocoder %s',
    async (_, fault, reason) => {
      const clock = new ManualClock();
      const session = await sessions.open({ clock, vocoder: { waitLimitMs: 1000 } });
      const { mock, ok } = session;
      const ids = mock.given({
        clips: [{ bind: 'clip', trackId: 0, startTimelineSec: 0, durationSec: 6, analysis: 'ready' }],
      });
      await ok('ui.setSelection', { placementId: ids['clip.placementId'], openEditor: true });
      expect(mock.snapshot().contents[0]?.notes).toEqual([]);
      mock.setVocoderFault(fault);
      const before = await processing(session);
      const started = await ok('prefs.set', { editingScheme: 'openDyne', vocoderWeight: 'hifigan_coulin9.onnx' });
      clock.advance(1000);
      const job = await jobOf(session, started);
      expect(job.state).toBe('failed');
      expect(job.error?.data).toMatchObject({ kind: 'MODEL_UNAVAILABLE', reason, executed: true });
      expect(String(job.error?.data.detail)).toContain(
        `the notes that the switch to openDyne generated for content ${String(ids['clip.contentId'])} cannot be undone`,
      );
      // The preferences went back, but the generated notes cannot be taken back: they and the unsaved changes stay.
      expect(await processing(session)).toEqual(before);
      expect(mock.snapshot().contents[0]?.notes.length).toBeGreaterThan(0);
      expect(field(await ok('project.get'), 'project', 'dirty')).toBe(true);
    },
  );

  it('refuses an unlisted vocoder weight or pitch model even when it equals the current value, and changes nothing', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { mock, fails } = session;
    // The weight in use is no longer on offer, for example because its file was removed.
    mock.given({ preferences: { vocoderWeight: 'removed.onnx', f0Model: 'gone' } });
    const before = await processing(session);
    for (const params of [
      { vocoderWeight: 'removed.onnx' },
      { f0Model: 'gone', tuningHz: 432 },
      { vocoderWeight: 'removed.onnx', renderingPriority: 'cpuFirst' },
    ]) {
      expect((await fails('prefs.set', params)).data).toMatchObject({
        reason: 'option_unavailable',
        executed: false,
      });
    }
    clock.advance(1000);
    expect(await processing(session)).toEqual(before);
  });

  it('leaves a previous vocoder weight that the wire cannot carry out of the revert recipe, and reports before null', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { mock, ok } = session;
    const long = 'w'.repeat(65);
    mock.given({
      preferences: {
        vocoderWeight: long,
        options: { vocoderWeight: ['hifigan.onnx', '', long, 'ok.onnx'], f0Model: ['fcpe'] },
      },
    });
    // The lists leave out the names that cannot be carried, and a weight in use with such a name is reported as null.
    expect(await processing(session)).toMatchObject({
      vocoderWeight: null,
      nullReasons: { vocoderWeight: 'unavailable' },
    });
    expect(((await ok('session.info')).processing as Record<string, unknown>).vocoderWeight).toBeNull();
    expect(field(await processing(session), 'options', 'vocoderWeight')).toEqual(['hifigan.onnx', 'ok.onnx']);
    const only = await ok('prefs.set', { vocoderWeight: 'ok.onnx' });
    clock.advance(1000);
    const alone = await jobOf(session, only);
    expect(alone.state).toBe('succeeded');
    expect(alone.result?.changes).toMatchObject([{ fields: { vocoderWeight: { before: null, after: 'ok.onnx' } } }]);
    expect(field(alone.result, 'undo', 'revert')).toBeNull();
    // With another member the recipe holds that member only.
    mock.given({ preferences: { vocoderWeight: '' } });
    const both = await ok('prefs.set', { vocoderWeight: 'hifigan.onnx', tuningHz: 432 });
    clock.advance(1000);
    const job = await jobOf(session, both);
    expect(job.result?.changes).toMatchObject([
      { fields: { tuningHz: { before: 440, after: 432 } } },
      { fields: { vocoderWeight: { before: null, after: 'hifigan.onnx' } } },
    ]);
    expect(field(job.result, 'undo', 'revert', 'params')).toEqual({ tuningHz: 440 });
  });

  it('is refused while a dialog is open, for the new members too', async () => {
    const session = await sessions.open();
    session.mock.given({ dialogs: [{ kind: 'preferences' }] });
    for (const params of [
      { vocoderWeight: 'hifigan_coulin9.onnx' },
      { renderingPriority: 'cpuFirst' },
      { f0Model: 'fcpe' },
      { referenceAlignMode: 'game' },
    ]) {
      expect((await session.fails('prefs.set', params)).data).toMatchObject({ reason: 'modal_open' });
    }
  });

  it('fails the job with BUSY when a dialog opened after the call, for a vocoder weight and a rendering priority too', async () => {
    const clock = new ManualClock();
    const session = await sessions.open({ clock });
    const { mock, ok } = session;
    const before = await processing(session);
    const started = await ok('prefs.set', { vocoderWeight: 'hifigan_coulin9.onnx', renderingPriority: 'cpuFirst' });
    mock.setBusy({ modalOpen: true });
    clock.advance(1000);
    const job = await jobOf(session, started);
    expect(job.state).toBe('failed');
    expect(job.error?.data).toMatchObject({ kind: 'BUSY', reason: 'modal_open', executed: false });
    mock.setBusy({ modalOpen: false });
    expect(await processing(session)).toEqual(before);
    expect(await vocoderOf(session)).toEqual({ ready: true, reconfiguring: false });
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

  it('offers two device types; another type opens its own default output device, and the revert recipe names both', async () => {
    const session = await sessions.open();
    const { mock, ok, fails } = session;
    mock.given({ audio: { running: true } });
    const running = await ok('audio.get');
    expect(running.available).toMatchObject({
      deviceTypes: ['Mock Audio', 'Mock Audio 2'],
      outputDevices: ['Mock Output', 'Mock Output 2'],
      outputChannelPairCount: 1,
    });
    // An output device of the other type is not offered while the current type runs, and vice versa.
    expect((await fails('audio.set', { outputDevice: 'Mock B Output' })).data).toMatchObject({
      reason: 'audio_setting_unavailable',
    });
    await ok('audio.set', { outputDevice: 'Mock Output 2' });
    const switched = await ok('audio.set', { deviceType: 'Mock Audio 2' });
    expect(switched.device).toMatchObject({ deviceType: 'Mock Audio 2', outputDevice: 'Mock B Output' });
    expect(switched.changes).toMatchObject([
      {
        fields: {
          deviceType: { before: 'Mock Audio', after: 'Mock Audio 2' },
          outputDevice: { before: 'Mock Output 2', after: 'Mock B Output' },
        },
      },
    ]);
    expect((await ok('audio.get')).available).toMatchObject({ outputDevices: ['Mock B Output'] });
    expect((await fails('audio.set', { outputDevice: 'Mock Output' })).data).toMatchObject({
      reason: 'audio_setting_unavailable',
    });
    // Naming a device of the new type in the same call is checked against that type.
    await revert(session, switched);
    expect((await ok('audio.get')).device).toMatchObject({ deviceType: 'Mock Audio', outputDevice: 'Mock Output 2' });
    const both = await ok('audio.set', { deviceType: 'Mock Audio 2', outputDevice: 'Mock B Output' });
    expect(both.device).toMatchObject({ deviceType: 'Mock Audio 2', outputDevice: 'Mock B Output' });
    expect((await fails('audio.set', { deviceType: 'Mock Audio 2', outputDevice: 'Mock Output' })).data).toMatchObject({
      reason: 'audio_setting_unavailable',
    });
  });

  it('offers one output channel pair only: pair 0 is the current setup, any other is refused', async () => {
    const session = await sessions.open();
    const { mock, ok, fails } = session;
    mock.given({ audio: { running: true } });
    expect(await ok('audio.set', { outputChannelPair: 0 })).toMatchObject({ noOp: true, changes: [] });
    expect((await fails('audio.set', { outputChannelPair: 1 })).data).toMatchObject({
      reason: 'audio_setting_unavailable',
      executed: false,
    });
    // A test can offer a second pair, which audio.get then lists and audio.set opens.
    mock.setOutputChannelPairCount(2);
    expect(field(await ok('audio.get'), 'available', 'outputChannelPairCount')).toBe(2);
    expect(await ok('audio.set', { outputChannelPair: 1 })).toMatchObject({
      noOp: false,
      device: { outputChannelPair: 1 },
    });
  });

  it('lets playback start without the no-device warning once a device runs', async () => {
    const session = await sessions.open();
    const { ok } = session;
    expect((await ok('transport.control', { action: 'play' })).warnings).toMatchObject([{ code: 'NO_AUDIO_DEVICE' }]);
    await ok('audio.set', { sampleRateHz: 48000 });
    expect((await ok('transport.control', { action: 'play' })).warnings).toEqual([]);
  });
});
