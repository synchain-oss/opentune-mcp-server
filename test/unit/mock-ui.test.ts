// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The mock's UI bridge beyond what the contract vectors show: revert recipes applied as given, what
// a dialog's closing commits, the busy rules around dialogs, and the effects of selecting a clip.

import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Sessions, clip, type TestSession } from '../support/mock-client.js';
import { otcpSpec } from '../support/otcp-spec.js';

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

  it('loads the selected clip into the piano roll while the window keeps showing the arrangement view', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({
      clips: [clip({ bind: 'a', trackId: 1 }), clip({ bind: 'b', trackId: 2, startTimelineSec: 10 })],
    });
    const selected = await ok('ui.setSelection', { placementId: ids['a.placementId'] });
    // The view is not switched (no workspaceSwitched), but the piano roll holds the clip, as in a running window.
    expect(selected.ui).toMatchObject({ workspace: 'arrangement', pianoRollContentId: ids['a.contentId'] });
    expect(selected.sideEffects).toEqual({});
    expect((await ok('project.get')).selection).toMatchObject({ pianoRollContentId: ids['a.contentId'] });

    // A dry run selects nothing and loads nothing.
    await ok('ui.setSelection', { placementId: ids['b.placementId'], dryRun: true });
    expect(await state(session)).toMatchObject({ workspace: 'arrangement', pianoRollContentId: ids['a.contentId'] });

    // Another clip takes its place; selecting that clip again changes nothing.
    await ok('ui.setSelection', { placementId: ids['b.placementId'] });
    expect(await state(session)).toMatchObject({ workspace: 'arrangement', pianoRollContentId: ids['b.contentId'] });
    expect(await ok('ui.setSelection', { placementId: ids['b.placementId'] })).toMatchObject({
      noOp: true,
      changes: [],
      sideEffects: {},
    });
  });

  it('queues no background work and warns about no experimental feature, whatever the preference says', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({ preferences: { experimentalFeatures: true }, clips: [clip({ bind: 'clip' })] });
    const on = await ok('ui.setSelection', { placementId: ids['clip.placementId'] });
    expect(on.sideEffects).toEqual({});
    expect(on.warnings).toEqual([]);
    await ok('prefs.set', { experimentalFeatures: false });
    const off = await ok('ui.setSelection', { placementId: ids['clip.placementId'] });
    expect(off).toMatchObject({ noOp: true, sideEffects: {}, warnings: [] });
  });
});

describe('ui.setWorkspace', () => {
  const codes = (result: Record<string, unknown>) => (result.warnings as { code: string }[]).map((w) => w.code);

  it('switches to the piano roll and back, reports the switch, and its revert recipe switches back', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    mock.given({ dirty: false, clips: [clip()] });
    const before = mock.snapshot();

    const opened = await ok('ui.setWorkspace', { workspace: 'pianoRoll' });
    expect(opened).toMatchObject({
      applied: true,
      noOp: false,
      dryRun: false,
      changes: [
        {
          entity: 'ui',
          ref: { singleton: 'workspace' },
          label: expect.any(String) as string,
          fields: { workspace: { before: 'arrangement', after: 'pianoRoll', unit: null } },
        },
      ],
      revisionDiff: { arrangement: null, trackState: null, contents: [] },
      undo: {
        undoable: false,
        reason: 'not_persisted_state',
        revert: { method: 'ui.setWorkspace', params: { workspace: 'arrangement' } },
      },
      dirty: { before: false, after: false },
      ui: { workspace: 'pianoRoll' },
      sideEffects: { workspaceSwitched: { from: 'arrangement', to: 'pianoRoll', revert: null } },
      warnings: [],
      job: null,
    });
    // The view state is what the reads show, and nothing of the project changed.
    expect(await state(session)).toMatchObject({ workspace: 'pianoRoll' });
    expect((await ok('project.get')).selection).toMatchObject({ pianoRollContentId: null });
    expect(mock.snapshot()).toEqual(before);

    // The recipe, sent as it is, closes the piano roll; its own recipe opens it again.
    const closed = await revert(session, opened);
    expect(closed).toMatchObject({
      noOp: false,
      changes: [{ fields: { workspace: { before: 'pianoRoll', after: 'arrangement' } } }],
      ui: { workspace: 'arrangement' },
      sideEffects: { workspaceSwitched: { from: 'pianoRoll', to: 'arrangement', revert: null } },
      undo: { revert: { method: 'ui.setWorkspace', params: { workspace: 'pianoRoll' } } },
    });
    expect(await state(session)).toMatchObject({ workspace: 'arrangement' });
    await revert(session, closed);
    expect(await state(session)).toMatchObject({ workspace: 'pianoRoll' });
    expect(mock.snapshot()).toEqual(before);
  });

  it('is a no-op when the window already shows the workspace, in both directions', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    mock.given({ dirty: false, clips: [clip()] });
    const noOp = {
      applied: true,
      noOp: true,
      changes: [],
      sideEffects: {},
      warnings: [],
      undo: { undoable: false, reason: 'no_op', revert: null },
      revisionDiff: { arrangement: null, trackState: null, contents: [] },
      dirty: { before: false, after: false },
    };
    expect(await ok('ui.setWorkspace', { workspace: 'arrangement' })).toMatchObject({
      ...noOp,
      ui: { workspace: 'arrangement' },
    });
    await ok('ui.setWorkspace', { workspace: 'pianoRoll' });
    expect(await ok('ui.setWorkspace', { workspace: 'pianoRoll' })).toMatchObject({
      ...noOp,
      ui: { workspace: 'pianoRoll' },
    });
  });

  it('switches back after ui.setSelection opened the editor, and the clip stays selected', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({ dirty: false, clips: [clip()] });
    await ok('ui.setSelection', { placementId: ids['clip.placementId'], openEditor: true });
    expect(await state(session)).toMatchObject({ workspace: 'pianoRoll', pianoRollContentId: ids['clip.contentId'] });

    const back = await ok('ui.setWorkspace', { workspace: 'arrangement' });
    expect(back).toMatchObject({
      changes: [{ fields: { workspace: { before: 'pianoRoll', after: 'arrangement' } } }],
      ui: { workspace: 'arrangement', selectedPlacementIds: [ids['clip.placementId']] },
      dirty: { before: false, after: false },
      revisionDiff: { contents: [] },
    });
    expect(await state(session)).toMatchObject({ workspace: 'arrangement' });
    expect((await ok('project.get')).selection).toMatchObject({ selectedPlacementIds: [ids['clip.placementId']] });
    // Opening the piano roll again shows the selected clip.
    const again = await ok('ui.setWorkspace', { workspace: 'pianoRoll' });
    expect(again.ui).toMatchObject({ workspace: 'pianoRoll', pianoRollContentId: ids['clip.contentId'] });
  });

  it('shows the selected clip in the piano roll, or none when no clip is selected', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({ clips: [clip({ bind: 'a', trackId: 1 }), clip({ bind: 'b', trackId: 2 })] });
    // Nothing selected: the piano roll is empty, which is not an error.
    expect((await ok('ui.setWorkspace', { workspace: 'pianoRoll' })).ui).toMatchObject({
      workspace: 'pianoRoll',
      pianoRollContentId: null,
    });
    await ok('ui.setWorkspace', { workspace: 'arrangement' });
    await ok('ui.setSelection', { placementId: ids['b.placementId'] });
    expect((await ok('ui.setWorkspace', { workspace: 'pianoRoll' })).ui).toMatchObject({
      pianoRollContentId: ids['b.contentId'],
    });
    // Another clip is selected while the arrangement view shows: the piano roll shows that one when it opens.
    await ok('ui.setWorkspace', { workspace: 'arrangement' });
    await ok('ui.setSelection', { placementId: ids['a.placementId'] });
    expect((await ok('ui.setWorkspace', { workspace: 'pianoRoll' })).ui).toMatchObject({
      pianoRollContentId: ids['a.contentId'],
    });
    // A track selects no clip, so the piano roll shows none.
    await ok('ui.setWorkspace', { workspace: 'arrangement' });
    await ok('ui.setSelection', { trackId: 3 });
    expect((await ok('ui.setWorkspace', { workspace: 'pianoRoll' })).ui).toMatchObject({ pianoRollContentId: null });
  });

  it('generates nothing in the openDyne scheme and does not mark the project as changed', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({
      editingScheme: 'openDyne',
      dirty: false,
      clips: [{ bind: 'clip', trackId: 0, startTimelineSec: 0, durationSec: 6, analysis: 'running' }],
    });
    // The clip is selected while its analysis runs, so selecting it generated nothing; the analysis finishes
    // afterwards, which leaves a selected clip whose notes were never generated (the case in which selecting it
    // would generate them).
    await ok('ui.setSelection', { placementId: ids['clip.placementId'] });
    mock.setAnalysis(ids['clip.contentId'] ?? '', 'ready');
    mock.given({ dirty: false });
    const before = mock.snapshot();
    expect(before.contents[0]?.notes).toHaveLength(0);
    const opened = await ok('ui.setWorkspace', { workspace: 'pianoRoll' });
    expect(opened).toMatchObject({ dirty: { before: false, after: false }, revisionDiff: { contents: [] } });
    expect(Object.keys(opened.sideEffects as object)).toEqual(['workspaceSwitched']);
    expect(codes(opened)).toEqual([]);
    expect(mock.snapshot()).toEqual(before);
  });

  it('keeps a dirty project dirty and a clean one clean', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    mock.given({ dirty: true });
    expect(await ok('ui.setWorkspace', { workspace: 'pianoRoll' })).toMatchObject({
      dirty: { before: true, after: true },
    });
    mock.given({ dirty: false });
    expect(await ok('ui.setWorkspace', { workspace: 'arrangement' })).toMatchObject({
      dirty: { before: false, after: false },
    });
  });

  it.each([
    [{ pointerDown: true }, 'pointer_down'],
    [{ modalOpen: true }, 'modal_open'],
    [{ importInProgress: true }, 'import_in_progress'],
    [{ projectOperation: true }, 'project_operation'],
  ] as const)('is refused with BUSY while the UI is busy (%j) and changes nothing', async (busy, reason) => {
    const session = await sessions.open();
    const { mock, fails } = session;
    mock.given({ clips: [clip()] });
    mock.setBusy(busy);
    const error = await fails('ui.setWorkspace', { workspace: 'pianoRoll' });
    expect(error).toMatchObject({
      message: 'BUSY',
      data: { kind: 'BUSY', reason, retryable: true, executed: false, retryAfterMs: 1000 },
    });
    mock.setBusy({ pointerDown: false, modalOpen: false, importInProgress: false, projectOperation: false });
    expect(await state(session)).toMatchObject({ workspace: 'arrangement' });
  });

  it('is refused while a dialog is open, and while an export holds the export lock', async () => {
    const dialog = await sessions.open();
    dialog.mock.given({ dialogs: [{ kind: 'message' }] });
    expect((await dialog.fails('ui.setWorkspace', { workspace: 'pianoRoll' })).data).toMatchObject({
      kind: 'BUSY',
      reason: 'modal_open',
      executed: false,
    });
    // Unlike ui.dismiss, nothing about a dialog lets the switch through; closing the dialog does.
    await dialog.ok('ui.dismiss', { target: 'dialogs' });
    expect(await dialog.ok('ui.setWorkspace', { workspace: 'pianoRoll' })).toMatchObject({ noOp: false });

    const exporting = await sessions.open();
    exporting.mock.given({
      clips: [clip()],
      jobs: [{ bind: 'export', kind: 'export', state: 'running', cancellable: true }],
    });
    expect((await exporting.fails('ui.setWorkspace', { workspace: 'pianoRoll' })).data).toMatchObject({
      kind: 'BUSY',
      reason: 'export_in_progress',
      executed: false,
    });
    expect(await state(exporting)).toMatchObject({ workspace: 'arrangement' });
  });

  it('refuses a missing, unknown or additional member as invalid params', async () => {
    const session = await sessions.open();
    const { mock, fails } = session;
    mock.given({ clips: [clip()] });
    for (const params of [
      {},
      { workspace: 'mixer' },
      { workspace: 'piano_roll' },
      { workspace: 1 },
      { workspace: 'pianoRoll', dryRun: true },
    ]) {
      expect((await fails('ui.setWorkspace', params)).data, JSON.stringify(params)).toMatchObject({
        kind: 'INVALID_ARGUMENT',
        reason: 'invalid_params',
        executed: false,
      });
    }
    expect(await state(session)).toMatchObject({ workspace: 'arrangement' });
  });

  it('is capability_missing on an instance without ui.workspace, which still has the rest of the UI bridge', async () => {
    const session = await sessions.open();
    const { mock, ok, fails } = session;
    mock.given({ clips: [clip()], withoutCapabilities: ['ui.workspace'] });
    expect(mock.capabilities).not.toContain('ui.workspace');
    expect((await fails('ui.setWorkspace', { workspace: 'pianoRoll' })).data).toMatchObject({
      kind: 'UNSUPPORTED',
      reason: 'capability_missing',
    });
    expect(await ok('ui.getState')).toHaveProperty('ui');
    expect(await ok('ui.dismiss', { target: 'dialogs' })).toMatchObject({ noOp: true });
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

  it('closes an overlay that has shown its choice as a change of the view only', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    mock.given({ dirty: false, onboarding: 'notShown' });
    // OpenTune marks onboarding as shown once the overlay shows its choice.
    mock.showOnboarding(true);
    expect((await ok('ui.getState')).onboarding).toEqual({ shown: true, showing: true });
    const closed = await ok('ui.dismiss', { target: 'onboarding' });
    expect(closed).toMatchObject({
      applied: true,
      noOp: false,
      changes: [],
      warnings: [],
      undo: { undoable: false, reason: 'not_persisted_state', revert: null },
      dirty: { before: false, after: false },
    });
    expect((await ok('ui.getState')).onboarding).toEqual({ shown: true, showing: false });
    // Closed and shown before: a no-op.
    expect(await ok('ui.dismiss', { target: 'onboarding' })).toMatchObject({ noOp: true });

    // An overlay that has not shown its choice yet: closing it marks onboarding as shown, which no request resets.
    mock.given({ onboarding: 'notShown' });
    mock.showOnboarding(false);
    const marked = await ok('ui.dismiss', { target: 'onboarding' });
    expect(marked).toMatchObject({
      changes: [{ entity: 'preference', fields: { onboardingShown: { before: false, after: true } } }],
      undo: { reason: 'no_upstream_undo', revert: null },
    });
    expect((marked.warnings as { code: string }[]).map((w) => w.code)).toEqual(['IRREVERSIBLE']);
  });
});

describe('showOnboarding', () => {
  it('without the choice clears the first-run flag, since the overlay has not marked onboarding as shown', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    mock.given({ onboarding: 'shown' });
    expect((await ok('ui.getState')).onboarding).toEqual({ shown: true, showing: false });
    mock.showOnboarding(false);
    expect((await ok('ui.getState')).onboarding).toEqual({ shown: false, showing: true });
    expect((await ok('prefs.get')).onboardingShown).toBe(false);
  });
});

describe('a window-less run (no editor window)', () => {
  // The eleven methods that act through the editor window (PROTOCOL.md section 7 rule 6; NO_EDITOR_METHODS of the mock).
  const NO_EDITOR_METHODS = [
    'ui.getState',
    'ui.dismiss',
    'ui.setSelection',
    'ui.setWorkspace',
    'track.add',
    'track.duplicate',
    'track.delete',
    'project.save',
    'project.saveAs',
    'project.open',
    'audio.set',
  ] as const;
  const projectFile = path.join(os.tmpdir(), 'ot-no-editor', 'song.otproj');

  /** Valid params for every method of the rule, so that only the missing window can make a call fail. */
  const paramsFor = (
    ids: Record<string, string>,
    arrangementRevision: string,
  ): Record<string, Record<string, unknown>> => ({
    'ui.getState': {},
    'ui.dismiss': { target: 'dialogs' },
    'ui.setSelection': { placementId: ids['a.placementId'] },
    'ui.setWorkspace': { workspace: 'pianoRoll' },
    'track.add': {},
    'track.duplicate': { trackId: 1, mode: 'clone' },
    'track.delete': { trackId: 1, expectedArrangementRevision: arrangementRevision, confirm: true },
    'project.save': {},
    'project.saveAs': { path: projectFile },
    'project.open': { path: projectFile },
    'audio.set': { bufferSizeFrame: 256 },
  });

  /** What a call could change: the data of the mock, the state of the interface, the audio setup and the project. */
  async function observed(session: TestSession) {
    const { mock, ok } = session;
    return {
      data: mock.snapshot(),
      audio: await ok('audio.get'),
      project: await ok('project.get'),
    };
  }

  it('lists exactly the methods that the specification names, and gives each one valid params', async () => {
    const session = await sessions.open();
    const ids = session.mock.given({ clips: [clip({ bind: 'a', trackId: 1 })] });
    const arrangementRevision = field(await session.ok('project.get'), 'asOf', 'arrangementRevision') as string;
    const params = paramsFor(ids, arrangementRevision);
    expect(Object.keys(params).sort()).toEqual([...NO_EDITOR_METHODS].sort());
    for (const method of NO_EDITOR_METHODS) {
      expect(otcpSpec().validate(`methods/${method}.schema.json#/$defs/params`, params[method]), method).toEqual([]);
    }
  });

  it.each(NO_EDITOR_METHODS)('refuses %s with UNSUPPORTED(no_editor_window) and changes nothing', async (method) => {
    const session = await sessions.open();
    const { mock, ok, fails } = session;
    const ids = mock.given({
      dirty: false,
      visibleTrackCount: 3,
      clips: [clip({ bind: 'a', trackId: 1 })],
      dialogs: [{ kind: 'message' }],
      audio: { running: true },
    });
    const arrangementRevision = field(await ok('project.get'), 'asOf', 'arrangementRevision') as string;
    const params = paramsFor(ids, arrangementRevision)[method] ?? {};
    const interfaceBefore = await state(session);
    const before = await observed(session);

    mock.setNoEditor(true);
    expect(await fails(method, params)).toMatchObject({
      data: { kind: 'UNSUPPORTED', reason: 'no_editor_window', executed: false },
    });
    // The refusal changed nothing, in the data of the mock or in what the methods that still work report.
    expect(await observed(session)).toEqual(before);
    mock.setNoEditor(false);
    expect(await state(session)).toEqual(interfaceBefore);
  });

  it('lets a method that works without the editor window run, track.set among them, and the preferences answer', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    mock.given({ visibleTrackCount: 2, clips: [clip({ bind: 'a', trackId: 0 })] });
    const muted = async () => (field(await ok('project.get'), 'tracks') as { muted: boolean }[])[0]?.muted;
    expect(await muted()).toBe(false);
    mock.setNoEditor(true);
    // The rule names track.set as one of the methods that work without a window; it is not in the list of refusals.
    expect(NO_EDITOR_METHODS).not.toContain('track.set');
    expect(await ok('prefs.get')).toHaveProperty('onboardingShown');
    expect(await ok('track.set', { tracks: [{ trackId: 0, muted: true }] })).toMatchObject({
      applied: true,
      noOp: false,
    });
    expect(await muted()).toBe(true);
  });

  it('works again with an editor window: the same selection that was refused is applied', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({ clips: [clip({ bind: 'a', trackId: 1 })] });
    mock.setNoEditor(true);
    expect(await session.fails('ui.setSelection', { placementId: ids['a.placementId'] })).toMatchObject({
      data: { reason: 'no_editor_window' },
    });
    mock.setNoEditor(false);
    await ok('ui.setSelection', { placementId: ids['a.placementId'] });
    expect(await state(session)).toMatchObject({ selectedPlacementIds: [ids['a.placementId']] });
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
