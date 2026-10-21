// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The mock's UI bridge beyond what the contract vectors show: revert recipes applied as given, what
// a dialog's closing commits, the busy rules around dialogs, and the effects of selecting a clip.

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

/** Sends the revert recipe of a result as it is. */
async function revert(session: TestSession, result: Record<string, unknown>) {
  const recipe = field(result, 'undo', 'revert') as Revert | null;
  if (recipe === null) throw new Error('the result has no revert recipe');
  return session.ok(recipe.method, recipe.params);
}

const state = async (session: TestSession) => (await session.ok('ui.getState')).ui;

describe('ui.setSelection', () => {
  it('selects a clip and a track, and its revert recipe selects the previous ones again', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({
      clips: [clip({ bind: 'a', trackId: 1 }), clip({ bind: 'b', trackId: 2, startTimelineSec: 10 })],
    });
    const first = await ok('ui.setSelection', { placementId: ids['a.placementId'] });
    expect(first.changes).toMatchObject([
      {
        entity: 'selection',
        fields: {
          activeTrackId: { before: 0, after: 1 },
          selectedPlacementIds: { before: [], after: [expect.any(String)] },
        },
      },
    ]);
    // Track 0 was active and no clip was selected: the recipe selects the track again.
    expect(first.undo).toMatchObject({
      undoable: false,
      reason: 'not_persisted_state',
      revert: { method: 'ui.setSelection', params: { trackId: 0 } },
    });
    const second = await ok('ui.setSelection', { placementId: ids['b.placementId'] });
    expect(await state(session)).toMatchObject({ activeTrackId: 2, selectedPlacementIds: [ids['b.placementId']] });

    // The recipe goes back to clip a, the selection before the call.
    await revert(session, second);
    expect(await state(session)).toMatchObject({ activeTrackId: 1, selectedPlacementIds: [ids['a.placementId']] });

    // A track selects no clip; its recipe selects the clip that was selected before.
    const track = await ok('ui.setSelection', { trackId: 3 });
    expect(await state(session)).toMatchObject({ activeTrackId: 3, selectedPlacementIds: [] });
    await revert(session, track);
    expect(await state(session)).toMatchObject({ activeTrackId: 1, selectedPlacementIds: [ids['a.placementId']] });

    const again = await ok('ui.setSelection', { placementId: ids['a.placementId'] });
    expect(again).toMatchObject({ applied: true, noOp: true, changes: [] });
  });

  it('refuses a track that is not shown, and a selection while a dialog is open or a gesture runs', async () => {
    const session = await sessions.open();
    const { mock, fails } = session;
    mock.given({ dialogs: [{ kind: 'message' }] });
    expect((await fails('ui.setSelection', { trackId: 7 })).data).toMatchObject({ reason: 'unknown_handle' });
    expect((await fails('ui.setSelection', { trackId: 1 })).data).toMatchObject({ kind: 'BUSY', reason: 'modal_open' });
    await session.ok('ui.dismiss', { target: 'dialogs' });
    mock.setBusy({ pointerDown: true });
    expect((await fails('ui.setSelection', { trackId: 1 })).data).toMatchObject({ reason: 'pointer_down' });
  });

  it('generates the notes of a clip it selects in the openDyne scheme, once, and a dry run only predicts it', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({
      editingScheme: 'openDyne',
      clips: [{ bind: 'clip', trackId: 0, startTimelineSec: 0, durationSec: 6, analysis: 'ready' }],
    });
    const before = mock.snapshot();
    const predicted = await ok('ui.setSelection', { placementId: ids['clip.placementId'], dryRun: true });
    expect(predicted).toMatchObject({ applied: false, dryRun: true, undo: null });
    expect(field(predicted, 'sideEffects', 'notesGenerated', 'noteCount')).toBeGreaterThan(0);
    expect(mock.snapshot()).toEqual(before);

    const done = await ok('ui.setSelection', { placementId: ids['clip.placementId'] });
    const count = field(done, 'sideEffects', 'notesGenerated', 'noteCount');
    expect(count).toBe(field(predicted, 'sideEffects', 'notesGenerated', 'noteCount'));
    expect(mock.snapshot().contents[0]?.notes).toHaveLength(count as number);
    expect(done).toMatchObject({ dirty: { before: false, after: true } });
    expect((done.warnings as { code: string }[]).map((w) => w.code)).toEqual([
      'SELECTION_GENERATED_NOTES',
      'IRREVERSIBLE',
    ]);
    // The notes exist now: selecting again generates nothing.
    const second = await ok('ui.setSelection', { placementId: ids['clip.placementId'] });
    expect(second).toMatchObject({ noOp: true, sideEffects: {}, warnings: [] });
  });

  it('opens the piano roll, reports the switch, and follows the key of the clip in the transport bar', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({ clips: [clip({ key: { root: 7, scale: 'minor' } })] });
    const opened = await ok('ui.setSelection', { placementId: ids['clip.placementId'], openEditor: true });
    expect(opened.sideEffects).toMatchObject({
      workspaceSwitched: { from: 'arrangement', to: 'pianoRoll', revert: null },
      uiScaleChanged: { before: { root: 0, scale: 'major' }, after: { root: 7, scale: 'minor' }, revert: null },
    });
    expect(opened.ui).toMatchObject({ workspace: 'pianoRoll', pianoRollContentId: ids['clip.contentId'] });
    expect((await ok('ui.getState')).uiScale).toEqual({ root: 7, scale: 'minor' });
    expect((await ok('project.get')).selection).toMatchObject({ pianoRollContentId: ids['clip.contentId'] });
  });

  it('queues the reference analysis of a bound clip only while experimental features are on', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({
      preferences: { experimentalFeatures: true },
      clips: [
        clip({ bind: 'ref', startTimelineSec: 0 }),
        clip({ bind: 'clip', startTimelineSec: 0, referenceClip: 'ref' }),
      ],
    });
    const selected = await ok('ui.setSelection', { placementId: ids['clip.placementId'] });
    expect(selected.sideEffects).toMatchObject({
      referenceAnalysisQueued: { contentIds: [ids['clip.contentId'], ids['ref.contentId']], revert: null },
    });
    expect((selected.warnings as { code: string }[]).map((w) => w.code)).toEqual(['REFERENCE_ANALYSIS_QUEUED']);
    await ok('prefs.set', { experimentalFeatures: false });
    const off = await ok('ui.setSelection', { placementId: ids['ref.placementId'] });
    expect(off.sideEffects).toEqual({});
  });

  describe('queues the reference analysis only for contents without alignment data', () => {
    const queuedIds = (result: Record<string, unknown>) =>
      field(result, 'sideEffects', 'referenceAnalysisQueued', 'contentIds');
    const codes = (result: Record<string, unknown>) => (result.warnings as { code: string }[]).map((w) => w.code);

    /** Runs content.analyzeReference for a placement to its end, which makes the data of both clips. */
    async function align(session: TestSession, clock: ManualClock, placementId: string | undefined) {
      const started = await session.ok('content.analyzeReference', { placementId });
      clock.advance(1000);
      const { job } = (await session.ok('job.get', { jobId: field(started, 'job', 'jobId') })) as {
        job: { state: string };
      };
      expect(job.state).toBe('succeeded');
    }

    it('lists only the clip when the reference clip is aligned already', async () => {
      const clock = new ManualClock();
      const session = await sessions.open({ clock });
      const ids = session.mock.given({
        preferences: { experimentalFeatures: true },
        clips: [
          clip({ bind: 'ref', startTimelineSec: 0 }),
          clip({ bind: 'one', startTimelineSec: 0, trackId: 1, referenceClip: 'ref' }),
          clip({ bind: 'two', startTimelineSec: 0, trackId: 2, referenceClip: 'ref' }),
        ],
      });
      await align(session, clock, ids['one.placementId']);
      const selected = await session.ok('ui.setSelection', { placementId: ids['two.placementId'] });
      expect(queuedIds(selected)).toEqual([ids['two.contentId']]);
      expect(codes(selected)).toEqual(['REFERENCE_ANALYSIS_QUEUED']);
    });

    it('reports nothing and touches no reference component when both clips are aligned', async () => {
      const clock = new ManualClock();
      const session = await sessions.open({ clock });
      const ids = session.mock.given({
        preferences: { experimentalFeatures: true },
        clips: [
          clip({ bind: 'ref', startTimelineSec: 0 }),
          clip({ bind: 'clip', startTimelineSec: 0, trackId: 1, referenceClip: 'ref' }),
        ],
      });
      await align(session, clock, ids['clip.placementId']);
      const selected = await session.ok('ui.setSelection', { placementId: ids['clip.placementId'] });
      expect(selected.sideEffects).toEqual({});
      expect(codes(selected)).toEqual([]);
      expect(field(selected, 'revisionDiff', 'contents')).toEqual([]);
    });

    it('lists a content once when both clips show it', async () => {
      const session = await sessions.open();
      const ids = session.mock.given({
        preferences: { experimentalFeatures: true },
        clips: [clip({ bind: 'clip', startTimelineSec: 0 })],
      });
      const copied = await session.ok('track.duplicate', { trackId: 0, mode: 'share' });
      const copy = field(copied, 'idMap') as { to: { placementId: string }[] }[];
      const asOf = (await session.ok('project.get')).asOf as { arrangementRevision: string };
      await session.ok('arrangement.edit', {
        expectedArrangementRevision: asOf.arrangementRevision,
        ops: [
          {
            op: 'setReference',
            placementId: ids['clip.placementId'],
            referencePlacementId: copy[0]?.to[0]?.placementId,
          },
        ],
      });
      const selected = await session.ok('ui.setSelection', { placementId: ids['clip.placementId'] });
      expect(queuedIds(selected)).toEqual([ids['clip.contentId']]);
    });
  });
});

describe('ui.dismiss', () => {
  it('commits the colour of a track-colour dialog only with confirm, and its revert recipe sets the old colour', async () => {
    const session = await sessions.open();
    const { mock, ok, fails } = session;
    mock.given({ dialogs: [{ kind: 'trackColour', trackId: 2, colour: '#123456' }] });
    const colourOf = async () => (field(await ok('project.get'), 'tracks') as { colour: string }[])[2]?.colour;
    const original = await colourOf();

    const refused = await fails('ui.dismiss', { target: 'dialogs' });
    expect(refused.data).toMatchObject({ reason: 'dialog_commits_on_close', executed: false });
    expect(await colourOf()).toBe(original);
    expect((await ok('ui.getState')).dialogs).toHaveLength(1);

    const closed = await ok('ui.dismiss', { target: 'dialogs', confirm: true });
    expect(await colourOf()).toBe('#123456');
    expect(closed).toMatchObject({
      dirty: { before: false, after: true },
      undo: { undoable: false, reason: 'ui_parity' },
      sideEffects: {
        dialogClosed: { dialogs: [{ kind: 'trackColour', trackId: 2 }] },
        dialogCommitted: { kind: 'trackColour', trackId: 2, colourBefore: original, colourAfter: '#123456' },
      },
    });
    expect(field(closed, 'revisionDiff', 'trackState')).not.toBeNull();
    await revert(session, closed);
    expect(await colourOf()).toBe(original);
    expect((await ok('ui.getState')).dialogs).toEqual([]);
  });

  it('closes dialogs that commit nothing without confirm, topmost first, and treats no dialog as a no-op', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    mock.given({ dialogs: [{ kind: 'preferences' }, { kind: 'confirm' }] });
    expect((await ok('ui.getState')).busy).toMatchObject({ modalOpen: true });
    const closed = await ok('ui.dismiss', { target: 'dialogs' });
    expect(field(closed, 'sideEffects', 'dialogClosed', 'dialogs')).toEqual([
      { kind: 'confirm', trackId: null },
      { kind: 'preferences', trackId: null },
    ]);
    expect(closed).toMatchObject({ undo: { reason: 'not_persisted_state', revert: null }, dirty: { after: false } });
    expect((await ok('ui.getState')).busy).toMatchObject({ modalOpen: false });
    expect(await ok('ui.dismiss', { target: 'dialogs' })).toMatchObject({ noOp: true, undo: { reason: 'no_op' } });
  });

  it('is refused during a gesture, but not by an open dialog', async () => {
    const session = await sessions.open();
    const { mock, ok, fails } = session;
    mock.given({ dialogs: [{ kind: 'message' }] });
    mock.setBusy({ pointerDown: true });
    expect((await fails('ui.dismiss', { target: 'dialogs' })).data).toMatchObject({ reason: 'pointer_down' });
    mock.setBusy({ pointerDown: false });
    expect(await ok('ui.dismiss', { target: 'dialogs' })).toMatchObject({ applied: true, noOp: false });
  });

  it('marks onboarding as shown, closes a showing overlay only with the capability, and reports it', async () => {
    const session = await sessions.open();
    const { mock, ok, fails } = session;
    mock.given({ onboarding: 'notShown' });
    expect((await ok('ui.getState')).onboarding).toEqual({ shown: false, showing: false });
    const prevented = await ok('ui.dismiss', { target: 'onboarding' });
    expect(prevented).toMatchObject({ undo: { reason: 'no_upstream_undo', revert: null } });
    expect((prevented.warnings as { code: string }[]).map((w) => w.code)).toEqual(['IRREVERSIBLE']);
    expect((await ok('prefs.get')).onboardingShown).toBe(true);
    expect(await ok('ui.dismiss', { target: 'onboarding' })).toMatchObject({ noOp: true });

    mock.given({ onboarding: 'showing', withoutCapabilities: ['ui.onboardingClose'] });
    expect((await fails('ui.dismiss', { target: 'onboarding' })).data).toMatchObject({ reason: 'capability_missing' });
    expect((await ok('ui.getState')).onboarding).toEqual({ shown: false, showing: true });
  });
});

describe('ui.getState', () => {
  it('reports the busy conditions, including the export lock', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    mock.setBusy({ importInProgress: true, projectOperation: true });
    expect((await ok('ui.getState')).busy).toEqual({
      pointerDown: false,
      modalOpen: false,
      importInProgress: true,
      exportInProgress: false,
      projectOperation: true,
    });
  });
});
