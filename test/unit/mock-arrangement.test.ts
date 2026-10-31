// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The mock's track, arrangement and transport methods beyond what the contract vectors show:
// undo round trips, the token rules, revert recipes applied as given, and the barrier that a track
// deletion puts in the undo history.

import { afterEach, describe, expect, it } from 'vitest';

import { Sessions, clip, type TestSession } from '../support/mock-client.js';

const sessions = new Sessions();
afterEach(async () => {
  await sessions.dispose();
});

interface Revert {
  method: string;
  params: Record<string, unknown>;
  requiresConsent?: boolean;
}

const field = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], value);

/** Sends the revert recipe of a result as it is, adding `extra` only where the recipe needs consent. */
async function revert(session: TestSession, result: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const recipe = field(result, 'undo', 'revert') as Revert | null;
  if (recipe === null) throw new Error('the result has no revert recipe');
  return session.ok(recipe.method, { ...recipe.params, ...extra });
}

const codes = (result: Record<string, unknown>): string[] => (result.warnings as { code: string }[]).map((w) => w.code);

const arrangementRevision = async (session: TestSession): Promise<string> => {
  const asOf = (await session.ok('project.get')).asOf as { arrangementRevision: string };
  return asOf.arrangementRevision;
};

describe('arrangement.edit', () => {
  it('takes a whole call back with one undo step, including the fades a trim shortened', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({
      clips: [clip({ startTimelineSec: 1, durationSec: 6, fadeInSec: 0.5, fadeOutSec: 2 })],
    });
    const before = mock.snapshot();
    const trimmed = await ok('arrangement.edit', {
      expectedArrangementRevision: await arrangementRevision(session),
      ops: [
        { op: 'trim', placementId: ids['clip.placementId'], edge: 'end', toTimelineSec: 3 },
        { op: 'setGain', placementId: ids['clip.placementId'], gainLinear: 0.5 },
      ],
    });
    expect(trimmed.warnings).toMatchObject([{ code: 'FADES_RECLAMPED' }]);
    expect(trimmed.undo).toMatchObject({ undoable: true, steps: 1 });
    const trimmedState = mock.snapshot();
    expect(trimmedState.placements[0]).toMatchObject({ durationSec: 2, gainLinear: 0.5, fadeInSec: 0.5 });

    const undoId = field(trimmed, 'undo', 'undoId');
    await ok('edit.undo', { expectedUndoId: undoId });
    expect(mock.snapshot()).toEqual({ ...before, dirty: true });
    await ok('edit.redo', { expectedUndoId: undoId });
    expect(mock.snapshot()).toEqual(trimmedState);
  });

  it('moves the start edge of a trim together with the part of the content the clip shows', async () => {
    const session = await sessions.open();
    const { mock, ok, fails } = session;
    const ids = mock.given({ clips: [clip({ startTimelineSec: 2, durationSec: 6 })] });
    const result = await ok('arrangement.edit', {
      expectedArrangementRevision: await arrangementRevision(session),
      ops: [{ op: 'trim', placementId: ids['clip.placementId'], edge: 'start', toTimelineSec: 3.5 }],
    });
    expect(mock.snapshot().placements[0]).toMatchObject({
      startTimelineSec: 3.5,
      durationSec: 4.5,
      clipInContentSec: 1.5,
    });
    expect(result.changes).toMatchObject([{ fields: { startTimelineSec: { before: 2, after: 3.5 } } }]);
    // The clip cannot be pulled out past the start of its content.
    const refused = await fails('arrangement.edit', {
      expectedArrangementRevision: await arrangementRevision(session),
      ops: [{ op: 'trim', placementId: ids['clip.placementId'], edge: 'start', toTimelineSec: 1 }],
    });
    expect(refused.data).toMatchObject({ reason: 'trim_out_of_range' });
  });

  it('predicts without changing anything, and treats a move to where the clip is as a no-op', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({ clips: [clip({ startTimelineSec: 2 })] });
    const before = mock.snapshot();
    const revision = await arrangementRevision(session);
    const predicted = await ok('arrangement.edit', {
      expectedArrangementRevision: revision,
      dryRun: true,
      ops: [{ op: 'move', placementId: ids['clip.placementId'], startTimelineSec: 5, toTrackId: 6 }],
    });
    expect(predicted).toMatchObject({ applied: false, dryRun: true, undo: null });
    expect(predicted.sideEffects).toMatchObject({ tracksRevealed: { trackIds: [4, 5, 6] } });
    expect(mock.snapshot()).toEqual(before);
    const noop = await ok('arrangement.edit', {
      expectedArrangementRevision: revision,
      ops: [{ op: 'move', placementId: ids['clip.placementId'], startTimelineSec: 2 }],
    });
    expect(noop).toMatchObject({ applied: true, noOp: true, changes: [], dirty: { before: false, after: false } });
  });

  it('splits at an analysis frame, merges again with the revert recipe, and refuses to undo either', async () => {
    const session = await sessions.open();
    const { mock, ok, fails } = session;
    const ids = mock.given({ clips: [clip({ startTimelineSec: 1, durationSec: 4 })] });
    const split = await ok('arrangement.edit', {
      expectedArrangementRevision: await arrangementRevision(session),
      ops: [{ op: 'split', placementId: ids['clip.placementId'], atTimelineSec: 2.504 }],
    });
    expect(split.undo).toMatchObject({ undoable: false, reason: 'upstream_undo_defect' });
    expect(split.warnings).toMatchObject([
      { code: 'SPLIT_SNAPPED', data: { requestedTimelineSec: 2.504, appliedTimelineSec: 2.5 } },
      { code: 'UPSTREAM_UNDO_DEFECT' },
    ]);
    expect(field(split, 'idMap')).toMatchObject([{ relation: 'split' }]);
    expect(mock.snapshot().placements).toHaveLength(2);
    expect((await fails('edit.undo', { force: true })).data).toMatchObject({ reason: 'undo_unsafe_build' });

    const merged = await revert(session, split);
    expect(mock.snapshot().placements).toHaveLength(1);
    expect(mock.snapshot().placements[0]).toMatchObject({ startTimelineSec: 1, durationSec: 4, clipInContentSec: 0 });
    // Merging again is possible only for clips that fit: the merged clip has nothing to join.
    expect(merged.removed).toHaveLength(2);
  });

  it('limits the fades of both parts of a split, says so, and gives them back with the merge recipe', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({
      clips: [clip({ startTimelineSec: 0, durationSec: 4, fadeInSec: 1.5, fadeOutSec: 1.5 })],
    });
    const before = mock.snapshot();
    const request = {
      expectedArrangementRevision: await arrangementRevision(session),
      ops: [{ op: 'split', placementId: ids['clip.placementId'], atTimelineSec: 1 }],
    };
    const predicted = await ok('arrangement.edit', { ...request, dryRun: true });
    expect(predicted.changes).toMatchObject([{ fields: { fadeInSec: { before: 1.5, after: 0.9 } } }]);
    const split = await ok('arrangement.edit', request);
    expect(codes(split)).toEqual(['FADES_RECLAMPED', 'UPSTREAM_UNDO_DEFECT']);
    expect(split.warnings).toMatchObject([{ data: { fadeInSec: { before: 1.5, after: 0.9 }, fadeOutSec: null } }, {}]);
    const parts = mock.snapshot().placements;
    expect(parts.map((p) => [p.fadeInSec, p.fadeOutSec])).toEqual([
      [0.9, 0],
      [0, 1.5],
    ]);

    await revert(session, split);
    expect(mock.snapshot().placements).toMatchObject([
      { startTimelineSec: 0, durationSec: 4, clipInContentSec: 0, fadeInSec: 1.5, fadeOutSec: 1.5 },
    ]);
    expect(mock.snapshot().placements[0]).toMatchObject({
      gainLinear: before.placements[0]?.gainLinear,
      trackId: before.placements[0]?.trackId,
    });
  });

  it('says which fade a one-sided setFade shortened as a side effect', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({ clips: [clip({ durationSec: 4, fadeInSec: 0, fadeOutSec: 2 })] });
    const result = await ok('arrangement.edit', {
      expectedArrangementRevision: await arrangementRevision(session),
      ops: [{ op: 'setFade', placementId: ids['clip.placementId'], fadeInSec: 3 }],
    });
    const warnings = result.warnings as { code: string; data: unknown }[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('FADES_RECLAMPED');
    // Both keys are present, as in trim and split; the side that was not shortened is null.
    expect(warnings[0]?.data).toEqual({ fadeInSec: null, fadeOutSec: { before: 2, after: 0.6 } });
    expect(mock.snapshot().placements[0]).toMatchObject({ fadeInSec: 3, fadeOutSec: 0.6 });
  });

  it('gives no merge recipe and warns of an irreversible merge when the former boundary is not on an analysis frame', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({ clips: [clip({ startTimelineSec: 0, durationSec: 4 })] });
    const split = await ok('arrangement.edit', {
      expectedArrangementRevision: await arrangementRevision(session),
      ops: [{ op: 'split', placementId: ids['clip.placementId'], atTimelineSec: 1 }],
    });
    const [left, right] = (field(split, 'idMap') as { to: { placementId: string }[] }[])[0]?.to ?? [];
    const merge = async () => ({
      expectedArrangementRevision: await arrangementRevision(session),
      ops: [{ op: 'merge', leadingPlacementId: left?.placementId, trailingPlacementId: right?.placementId }],
    });
    // Move the boundary off the frame grid: the right part starts later, the left part reaches there.
    await ok('arrangement.edit', {
      expectedArrangementRevision: await arrangementRevision(session),
      ops: [{ op: 'trim', placementId: right?.placementId, edge: 'start', toTimelineSec: 1.003 }],
    });
    await ok('arrangement.edit', {
      expectedArrangementRevision: await arrangementRevision(session),
      ops: [{ op: 'trim', placementId: left?.placementId, edge: 'end', toTimelineSec: 1.003 }],
    });
    const merged = await ok('arrangement.edit', await merge());
    expect(codes(merged)).toEqual(['UPSTREAM_UNDO_DEFECT', 'IRREVERSIBLE']);
    expect(merged.undo).toEqual({ undoable: false, reason: 'upstream_undo_defect', revert: null });
    expect(mock.snapshot().placements).toHaveLength(1);
  });

  it('moves only the visible tracks behind a deleted track and leaves hidden slots in place', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    mock.given({
      visibleTrackCount: 3,
      clips: [clip({ bind: 'a', trackId: 1 }), clip({ bind: 'b', trackId: 2 }), clip({ bind: 'hidden', trackId: 5 })],
    });
    const deleted = await ok('track.delete', {
      trackId: 1,
      expectedArrangementRevision: await arrangementRevision(session),
      confirm: true,
    });
    expect(deleted.trackIdMap).toEqual([
      { before: 1, after: null },
      { before: 2, after: 1 },
    ]);
    expect(mock.snapshot().placements.map((p) => p.trackId)).toEqual([1, 5]);
  });

  it('does not give the fades of a split back when a part was trimmed since', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({
      clips: [clip({ startTimelineSec: 0, durationSec: 4, fadeInSec: 1.5, fadeOutSec: 1.5 })],
    });
    const split = await ok('arrangement.edit', {
      expectedArrangementRevision: await arrangementRevision(session),
      ops: [{ op: 'split', placementId: ids['clip.placementId'], atTimelineSec: 1 }],
    });
    const [left, right] = (field(split, 'idMap') as { to: { placementId: string }[] }[])[0]?.to ?? [];
    // Trim the end of the right part, so that it is no longer as long as it was when the clip was split.
    await ok('arrangement.edit', {
      expectedArrangementRevision: await arrangementRevision(session),
      ops: [{ op: 'trim', placementId: right?.placementId, edge: 'end', toTimelineSec: 3.5 }],
    });
    const merged = await ok('arrangement.edit', {
      expectedArrangementRevision: await arrangementRevision(session),
      ops: [{ op: 'merge', leadingPlacementId: left?.placementId, trailingPlacementId: right?.placementId }],
    });
    expect(merged.removed).toHaveLength(2);
    // The fade-in stays as the left part had it (0.9 s), not the 1.5 s of the clip before the split.
    expect(mock.snapshot().placements).toMatchObject([{ durationSec: 3.5, fadeInSec: 0.9, fadeOutSec: 1.5 }]);
  });

  it('needs confirm for a delete and gives no revert', async () => {
    const session = await sessions.open();
    const { mock, ok, fails } = session;
    const ids = mock.given({
      clips: [
        clip({ bind: 'a', startTimelineSec: 0, durationSec: 4 }),
        clip({ bind: 'b', trackId: 1, startTimelineSec: 1, durationSec: 4 }),
      ],
    });
    const request = {
      expectedArrangementRevision: await arrangementRevision(session),
      ops: [{ op: 'delete', placementIds: [ids['a.placementId']] }],
    };
    expect((await fails('arrangement.edit', request)).data).toMatchObject({ reason: 'confirm_required' });
    expect(await ok('arrangement.edit', { ...request, dryRun: true })).toMatchObject({ dryRun: true });
    const deleted = await ok('arrangement.edit', { ...request, confirm: true });
    expect(deleted.undo).toEqual({ undoable: false, reason: 'upstream_undo_defect', revert: null });
    expect(deleted.warnings).toMatchObject([{ code: 'UPSTREAM_UNDO_DEFECT' }, { code: 'IRREVERSIBLE' }]);
    expect(mock.snapshot().contents).toHaveLength(1);
  });
});

describe('arrangement.copy', () => {
  it('copies with a content of its own and removes the copies with the revert recipe after consent', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({ clips: [clip({ startTimelineSec: 1, durationSec: 6 })] });
    const before = mock.snapshot();
    const copied = await ok('arrangement.copy', {
      sources: [{ placementId: ids['clip.placementId'] }],
      mode: 'window',
      toTrackId: 5,
      startTimelineSec: 1,
      expectedArrangementRevision: await arrangementRevision(session),
    });
    expect(copied.sideEffects).toMatchObject({ tracksRevealed: { trackIds: [4, 5] } });
    expect(codes(copied)).toEqual(['STACKED_ON_SOURCE', 'TRACK_AUTO_REVEALED', 'TRACK_AUTO_REVEALED']);
    expect(field(copied, 'undo', 'revert', 'requiresConsent')).toBe(true);
    const snapshot = mock.snapshot();
    expect(snapshot.contents).toHaveLength(2);
    expect(snapshot.contents[1]?.notes).toEqual(snapshot.contents[0]?.notes);

    await revert(session, copied, { confirm: true });
    expect(mock.snapshot().placements).toEqual(before.placements);
    expect(mock.snapshot().contents).toEqual(before.contents);
  });
});

describe('track.set', () => {
  it('restores the previous settings with the revert recipe, and reports audibility of tracks it did not name', async () => {
    const { mock, ok, fails } = await sessions.open();
    mock.given({ clips: [clip()] });
    const before = mock.snapshot();
    const result = await ok('track.set', {
      tracks: [
        { trackId: 0, solo: true, volumeDb: 6, colour: '#aabbcc' },
        { trackId: 2, muted: true },
      ],
    });
    expect(result.changes).toMatchObject([
      { ref: { trackId: 0 }, fields: { solo: {}, volumeDb: {}, volumeLinear: {}, colour: { after: '#AABBCC' } } },
      { ref: { trackId: 1 }, fields: { audible: { before: true, after: false } } },
      { ref: { trackId: 2 }, fields: { muted: {} } },
      { ref: { trackId: 3 }, fields: { audible: { before: true, after: false } } },
    ]);
    expect(mock.snapshot().tracks[0]).toMatchObject({ solo: true, colour: '#AABBCC' });
    await ok('track.set', (field(result, 'undo', 'revert') as Revert).params);
    expect(mock.snapshot()).toEqual({ ...before, dirty: true });
    expect(
      (
        await fails('track.set', {
          tracks: [
            { trackId: 1, muted: true },
            { trackId: 1, solo: true },
          ],
        })
      ).data,
    ).toMatchObject({
      reason: 'duplicate_track',
    });
  });

  it('limits a volume to the range of the knob and says so', async () => {
    const { mock, ok } = await sessions.open();
    mock.given({});
    const result = await ok('track.set', { tracks: [{ trackId: 0, volumeLinear: 9 }] });
    expect(result.warnings).toMatchObject([
      { code: 'CLAMPED', data: { field: 'volumeLinear', requested: 9, applied: 4 } },
    ]);
    expect(mock.snapshot().tracks[0]?.volumeLinear).toBe(4);
  });
});

describe('track.add and track.duplicate', () => {
  it('shows tracks and marks the project changed, cannot be undone, and stops at the last slot', async () => {
    const { mock, ok, fails } = await sessions.open();
    mock.given({});
    const added = await ok('track.add', { count: 2 });
    // The number of visible tracks is saved with the project: the + button marks it changed, has no undo, and no
    // request restores the earlier number.
    expect(added).toMatchObject({
      visibleTrackCount: { before: 4, after: 6 },
      dirty: { before: false, after: true },
      undo: { undoable: false, reason: 'no_upstream_undo', revert: null },
      warnings: [{ code: 'IRREVERSIBLE', subject: { trackId: 4 }, data: null }],
    });
    expect(added.changes).toHaveLength(2);
    expect((await fails('track.add', { count: 3 })).data).toMatchObject({ reason: 'track_limit' });
    expect(mock.snapshot().tracks.filter((t) => t.visible)).toHaveLength(6);
  });

  it('copies a track to the first hidden slot, shares or clones contents, and deletes the copy with the revert recipe', async () => {
    const session = await sessions.open();
    const { mock, ok, fails } = session;
    mock.given({ visibleTrackCount: 2, clips: [clip({ trackId: 1 })] });
    await ok('track.set', { tracks: [{ trackId: 1, muted: true, colour: '#112233' }] });
    const before = mock.snapshot();
    const copied = await ok('track.duplicate', { trackId: 1, mode: 'share' });
    expect(copied).toMatchObject({ newTrackId: 2, warnings: [{ code: 'SHARED_CONTENT' }] });
    const snapshot = mock.snapshot();
    expect(snapshot.contents).toHaveLength(1);
    expect(snapshot.tracks[2]).toMatchObject({ visible: true, muted: true, colour: '#112233' });

    const recipe = field(copied, 'undo', 'revert') as Revert;
    expect(recipe).toMatchObject({ method: 'track.delete', requiresConsent: true });
    expect((await fails(recipe.method, recipe.params)).data).toMatchObject({ reason: 'confirm_required' });
    await ok(recipe.method, { ...recipe.params, confirm: true });
    // The copy is gone; the shared content stays with the source.
    expect(mock.snapshot().placements).toEqual(before.placements);
    expect(mock.snapshot().tracks[2]).toMatchObject({ visible: false, muted: false });
    expect(mock.snapshot().contents).toEqual(before.contents);

    const cloned = await ok('track.duplicate', { trackId: 1 });
    expect(mock.snapshot().contents).toHaveLength(2);
    expect(cloned.created).toHaveLength(2);
  });

  it('refuses a copy when every slot is visible or the first hidden slot holds clips', async () => {
    const { mock, fails } = await sessions.open();
    mock.given({ visibleTrackCount: 'all' });
    expect((await fails('track.duplicate', { trackId: 0 })).data).toMatchObject({ reason: 'track_limit' });
    const other = await sessions.open();
    other.mock.given({ visibleTrackCount: 2, clips: [clip({ trackId: 2 })] });
    expect((await other.fails('track.duplicate', { trackId: 0 })).data).toMatchObject({
      reason: 'target_track_occupied',
    });
  });
});

describe('track.delete', () => {
  it('moves later tracks down with their settings, and makes the entries it may have invalidated possibly stale', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    const ids = mock.given({
      clips: [
        clip({ bind: 'low', trackId: 0, startTimelineSec: 0, durationSec: 3 }),
        clip({ bind: 'gone', trackId: 1, startTimelineSec: 0, durationSec: 3 }),
        clip({ bind: 'moved', trackId: 2, startTimelineSec: 0, durationSec: 3 }),
      ],
      history: {
        undo: [
          { origin: 'ui', action: 'clipMove', clip: 'low' },
          { bind: 'ownLow', origin: 'control', action: 'noteEdit', clip: 'low' },
        ],
        redo: [],
      },
    });
    await ok('track.set', { tracks: [{ trackId: 2, solo: true, colour: '#010203' }] });
    // A move recorded through this API addresses the track it ends on: track 2.
    const moved = await ok('arrangement.edit', {
      expectedArrangementRevision: await arrangementRevision(session),
      ops: [{ op: 'move', placementId: ids['moved.placementId'], startTimelineSec: 1 }],
    });
    const deleted = await ok('track.delete', {
      trackId: 1,
      expectedArrangementRevision: await arrangementRevision(session),
      confirm: true,
    });
    expect(deleted).toMatchObject({
      trackIdMap: [
        { before: 1, after: null },
        { before: 2, after: 1 },
        { before: 3, after: 2 },
      ],
      possiblyStaleEntries: { undo: 2, redo: 0 },
      warnings: [{ code: 'IRREVERSIBLE' }, { code: 'UNDO_HISTORY_POSSIBLY_STALE', data: { undo: 2, redo: 0 } }],
      undo: { undoable: false, reason: 'no_upstream_undo', revert: null },
    });
    expect(mock.snapshot().tracks[1]).toMatchObject({ solo: true, colour: '#010203' });
    expect(mock.snapshot().placements.map((p) => p.trackId)).toEqual([0, 1]);

    const history = (await ok('edit.getHistory')) as { history: { undoTop: { possiblyStale: boolean } } };
    expect(history.history.undoTop).toMatchObject({ possiblyStale: true });
    // The move on track 2 is stale, the note edit and the UI entry are as the rules say.
    const stale = await session.fails('edit.undo', { expectedUndoId: field(moved, 'undo', 'undoId') });
    expect(stale.data).toMatchObject({ reason: 'stale_entry' });
  });

  it('applies an entry from the UI that a deletion made possibly stale, with a warning once it has an undoId', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    mock.given({
      clips: [clip({ bind: 'a', trackId: 0 }), clip({ bind: 'b', trackId: 1 })],
      history: { undo: [{ origin: 'ui', action: 'clipMove', clip: 'a' }], redo: [] },
    });
    await ok('track.delete', {
      trackId: 1,
      expectedArrangementRevision: await arrangementRevision(session),
      confirm: true,
    });
    const forced = await ok('edit.undo', { force: true });
    expect(codes(forced)).not.toContain('UNDO_ENTRY_POSSIBLY_STALE');
    expect(forced.entry).toMatchObject({ possiblyStale: false });
    const undoId = field(forced, 'entry', 'undoId');
    // The end user confirmed it: redo and undo it again without conflict or warning.
    const redone = await ok('edit.redo', { expectedUndoId: undoId });
    expect(codes(redone)).not.toContain('UNDO_ENTRY_POSSIBLY_STALE');
  });

  it('refuses the hidden track, the last visible track, and a stale arrangement revision', async () => {
    const session = await sessions.open();
    const { mock, fails } = session;
    mock.given({ visibleTrackCount: 1 });
    const revision = await arrangementRevision(session);
    expect(
      (await fails('track.delete', { trackId: 3, expectedArrangementRevision: revision, confirm: true })).data,
    ).toMatchObject({
      reason: 'track_hidden',
    });
    expect(
      (await fails('track.delete', { trackId: 0, expectedArrangementRevision: revision, confirm: true })).data,
    ).toMatchObject({
      reason: 'last_track',
    });
    expect(
      (await fails('track.delete', { trackId: 0, expectedArrangementRevision: 'stale', confirm: true })).data,
    ).toMatchObject({
      reason: 'arrangement_changed',
    });
  });
});

describe('transport', () => {
  it('returns to the position of the last play or seek, and warns while no audio device runs', async () => {
    const { mock, ok } = await sessions.open();
    mock.given({});
    const seek = await ok('transport.control', { action: 'seek', positionTimelineSec: 3 });
    expect(seek.transport).toMatchObject({ positionTimelineSec: 3, playStartTimelineSec: 3, playing: false });
    expect(seek.warnings).toEqual([]);
    const played = await ok('transport.control', { action: 'play' });
    expect(played.warnings).toMatchObject([{ code: 'NO_AUDIO_DEVICE' }]);
    expect(played.transport).toMatchObject({ playing: true, lastControl: { call: 'play' } });
    await ok('transport.control', { action: 'seek', positionTimelineSec: 8 });
    const back = await ok('transport.control', { action: 'pauseAtLastStart' });
    expect(back.transport).toMatchObject({ playing: false, positionTimelineSec: 8 });
    const again = await ok('transport.control', { action: 'pauseAtLastStart' });
    expect(again).toMatchObject({ noOp: true, dirty: { before: false, after: false } });
    const restart = await ok('transport.control', { action: 'playFromLastStart' });
    expect(restart.transport).toMatchObject({ playing: true, positionTimelineSec: 8 });
    const stopped = await ok('transport.control', { action: 'stop' });
    expect(stopped.transport).toMatchObject({ playing: false, positionTimelineSec: 8 });
    expect((await ok('transport.get')).transport).toEqual(stopped.transport);
  });

  it('moves the position on only while it plays on a running device at the rate the test sets', async () => {
    const { mock, ok } = await sessions.open();
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const position = async (): Promise<number> =>
      Number(field(await ok('transport.get'), 'transport', 'positionTimelineSec'));
    // The default rate is 0: the position stays where it is, whatever the time.
    mock.given({ audio: { running: true } });
    await ok('transport.control', { action: 'seek', positionTimelineSec: 2 });
    await ok('transport.control', { action: 'play' });
    await wait(30);
    expect(await position()).toBe(2);
    await ok('transport.control', { action: 'stop' });

    mock.setTransportRate(1000);
    await ok('transport.control', { action: 'seek', positionTimelineSec: 2 });
    await ok('transport.control', { action: 'play' });
    await wait(30);
    const moved = await position();
    expect(moved).toBeGreaterThan(2);
    // A pause keeps the position it reached; pausing at the last start goes back to where the play began.
    const paused = await ok('transport.control', { action: 'pause' });
    expect(paused.transport).toMatchObject({ playing: false, playStartTimelineSec: 2 });
    const kept = Number((paused.transport as Record<string, unknown>).positionTimelineSec);
    expect(kept).toBeGreaterThanOrEqual(moved);
    await wait(30);
    expect(await position()).toBe(kept);
    const restart = await ok('transport.control', { action: 'playFromLastStart' });
    expect(Number((restart.transport as Record<string, unknown>).positionTimelineSec)).toBeLessThan(kept);
    const back = await ok('transport.control', { action: 'pauseAtLastStart' });
    expect(back.transport).toMatchObject({ playing: false, positionTimelineSec: 2 });

    // A device that does not run plays nowhere, however fast the rate.
    mock.given({ audio: { running: false } });
    await ok('transport.control', { action: 'play' });
    await wait(30);
    expect(await position()).toBe(2);
  });

  it('does not warn about the audio device when one runs', async () => {
    const { mock, ok } = await sessions.open();
    mock.given({ audio: { running: true } });
    expect((await ok('transport.control', { action: 'play' })).warnings).toEqual([]);
  });

  it('restores tempo and loop flag with their revert recipes, and marks only the tempo as saved', async () => {
    const session = await sessions.open();
    const { mock, ok } = session;
    mock.given({});
    const tempo = await ok('transport.setTempo', { bpm: 90, timeSignature: { numerator: 3, denominator: 8 } });
    expect(tempo).toMatchObject({ tempo: { bpm: 90 }, dirty: { before: false, after: true } });
    await revert(session, tempo);
    expect((await ok('transport.get')).transport).toMatchObject({
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
    });
    expect(await ok('transport.setTempo', { bpm: 120 })).toMatchObject({ noOp: true });

    const loop = await ok('transport.setLoop', { enabled: true });
    expect(loop.warnings).toMatchObject([{ code: 'LOOP_NO_EFFECT_STANDALONE' }, { code: 'NOT_PERSISTED' }]);
    expect(loop.undo).toMatchObject({ undoable: false, reason: 'not_persisted_state' });
    await revert(session, loop);
    expect((await ok('transport.get')).transport).toMatchObject({ loopEnabled: false });
    expect(await ok('transport.setLoop', { enabled: false })).toMatchObject({ noOp: true, warnings: [] });
  });
});
