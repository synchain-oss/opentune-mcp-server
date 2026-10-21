// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The track methods of the mock (capability tracks.v1): track.set, track.add, track.duplicate and
// track.delete (spec/otcp/v1/PROTOCOL.md sections 9, 14 and 15.3). Tracks are positions: deleting
// one moves every later track down together with its clips and settings, and the deletion is a
// barrier in the undo and redo histories.

import { checkNotBusy, envelope, type Handler } from './context.js';
import { refuse } from './errors.js';
import { TRACK_SLOTS, type HistoryEntry, type TrackRec, type World } from './model.js';
import { clipLabel, copyPlacement, gainDb, leavingContents } from './placements.js';
import { EMPTY_DIFF } from './writes.js';
import { GAIN_LINEAR_MAX } from './arrangement.js';

/** OpenTune's volume knob covers this linear range. */
const VOLUME_LINEAR_MAX = GAIN_LINEAR_MAX;

const COLOURS = ['#E57373', '#64B5F6', '#81C784', '#FFD54F', '#BA68C8', '#4DB6AC', '#FF8A65', '#A1887F'] as const;

const warning = (code: string, subject: unknown, data: unknown = null) => ({ code, subject, data });
const trackLabel = (trackId: number): string => `Track ${String(trackId + 1)}`;

interface TrackSetting {
  trackId: number;
  muted?: boolean;
  solo?: boolean;
  volumeDb?: number;
  volumeLinear?: number;
  colour?: string;
}

function slot(world: World, trackId: number): TrackRec {
  const track = world.tracks[trackId];
  if (track === undefined) throw refuse('NOT_FOUND', 'unknown_handle', 'trackId names no track slot');
  return track;
}

const audibleOf = (tracks: readonly { muted: boolean; solo: boolean }[]): boolean[] => {
  const anySolo = tracks.some((t) => t.solo);
  return tracks.map((t) => !t.muted && (t.solo || !anySolo));
};

const snapshotTracks = (world: World) =>
  world.tracks.map(({ muted, solo, volumeLinear, colour, visible }) => ({
    muted,
    solo,
    volumeLinear,
    colour,
    visible,
  }));

const trackFields = (before: ReturnType<typeof snapshotTracks>[number], after: typeof before) => {
  const fields: Record<string, unknown> = {};
  const note = (name: string, a: unknown, b: unknown, unit: string | null) => {
    if (a !== b) fields[name] = { before: a, after: b, unit };
  };
  note('visible', before.visible, after.visible, null);
  note('muted', before.muted, after.muted, null);
  note('solo', before.solo, after.solo, null);
  note('volumeDb', gainDb(before.volumeLinear), gainDb(after.volumeLinear), 'db');
  note('volumeLinear', before.volumeLinear, after.volumeLinear, 'linear');
  note('colour', before.colour, after.colour, null);
  return fields;
};

// track.set ----------------------------------------------------------------------------------------

const set: Handler = (context) => {
  const { world, params } = context;
  const settings = params.tracks as TrackSetting[];
  for (const setting of settings) slot(world, setting.trackId);
  checkNotBusy(context);
  const seen = new Set<number>();
  for (const { trackId } of settings) {
    if (seen.has(trackId))
      throw refuse('INVALID_ARGUMENT', 'duplicate_track', 'a track may appear in tracks only once');
    seen.add(trackId);
  }
  const warnings: unknown[] = [];
  const dirtyBefore = world.project.dirty;
  const before = snapshotTracks(world);
  const audibleBefore = audibleOf(before);
  const revert: Record<string, unknown>[] = [];
  const stateBefore = world.capture();
  for (const setting of settings) {
    const track = slot(world, setting.trackId);
    const previous: Record<string, unknown> = { trackId: track.trackId };
    if (setting.muted !== undefined && setting.muted !== track.muted) {
      previous.muted = track.muted;
      track.muted = setting.muted;
    }
    if (setting.solo !== undefined && setting.solo !== track.solo) {
      previous.solo = track.solo;
      track.solo = setting.solo;
    }
    const requested = setting.volumeDb ?? setting.volumeLinear;
    if (requested !== undefined) {
      const linear = setting.volumeDb === undefined ? (setting.volumeLinear ?? 0) : 10 ** (setting.volumeDb / 20);
      const applied = Math.min(linear, VOLUME_LINEAR_MAX);
      if (linear > VOLUME_LINEAR_MAX) {
        const field = setting.volumeDb === undefined ? 'volumeLinear' : 'volumeDb';
        warnings.push(
          warning(
            'CLAMPED',
            { trackId: track.trackId },
            {
              field,
              requested,
              applied: field === 'volumeDb' ? gainDb(VOLUME_LINEAR_MAX) : VOLUME_LINEAR_MAX,
            },
          ),
        );
      }
      if (Math.abs(applied - track.volumeLinear) > 1e-9) {
        // dB is what a person reads; linear only where dB would not restore the value exactly.
        const db = gainDb(track.volumeLinear);
        if (db !== null && Math.abs(10 ** (db / 20) - track.volumeLinear) < 1e-12) previous.volumeDb = db;
        else previous.volumeLinear = track.volumeLinear;
        track.volumeLinear = applied;
      }
    }
    const colour = setting.colour?.toUpperCase();
    if (colour !== undefined && colour !== track.colour) {
      previous.colour = track.colour;
      track.colour = colour;
    }
    if (Object.keys(previous).length > 1) revert.push(previous);
  }
  const after = snapshotTracks(world);
  const audibleAfter = audibleOf(after);
  const changes = world.tracks.flatMap((track, i) => {
    const fields = trackFields(before[i] ?? after[i] ?? track, after[i] ?? track);
    const wasAudible = audibleBefore[i];
    const isAudible = audibleAfter[i];
    if (wasAudible !== isAudible) fields.audible = { before: wasAudible, after: isAudible, unit: null };
    if (
      Object.keys(fields).length === 0 ||
      (!track.visible && fields.audible !== undefined && Object.keys(fields).length === 1)
    )
      return [];
    return [{ entity: 'track', ref: { trackId: track.trackId }, label: trackLabel(track.trackId), fields }];
  });
  if (changes.length === 0) {
    return envelope(world, {
      applied: true,
      noOp: true,
      diff: EMPTY_DIFF,
      contents: [],
      undo: { undoable: false, reason: 'no_op', revert: null },
      dirtyBefore,
      warnings,
    });
  }
  world.touchTrackState();
  world.markDirty();
  return envelope(world, {
    applied: true,
    noOp: false,
    changes,
    diff: world.diff(stateBefore, world.capture()),
    contents: [],
    undo: { undoable: false, reason: 'ui_parity', revert: { method: 'track.set', params: { tracks: revert } } },
    dirtyBefore,
    warnings,
  });
};

// track.add ----------------------------------------------------------------------------------------

const add: Handler = (context) => {
  const { world, params } = context;
  checkNotBusy(context);
  const count = typeof params.count === 'number' ? params.count : 1;
  const visibleBefore = world.visibleTrackCount;
  if (visibleBefore + count > TRACK_SLOTS) {
    throw refuse('INVALID_ARGUMENT', 'track_limit', 'fewer hidden track slots remain than count');
  }
  const stateBefore = world.capture();
  const revealed = world.revealThrough(visibleBefore + count - 1);
  return envelope(world, {
    applied: true,
    noOp: false,
    changes: revealed.map((trackId) => ({
      entity: 'track',
      ref: { trackId },
      label: trackLabel(trackId),
      fields: { visible: { before: false, after: true, unit: null } },
    })),
    diff: world.diff(stateBefore, world.capture()),
    contents: [],
    undo: { undoable: false, reason: 'not_persisted_state', revert: null },
    dirtyBefore: world.project.dirty,
    warnings: [warning('NOT_PERSISTED', { trackId: revealed[0] })],
    extra: { visibleTrackCount: { before: visibleBefore, after: world.visibleTrackCount } },
  });
};

// track.duplicate ----------------------------------------------------------------------------------

const duplicate: Handler = (context) => {
  const { world, params } = context;
  const source = slot(world, params.trackId as number);
  checkNotBusy(context);
  const newTrackId = world.visibleTrackCount;
  if (newTrackId >= TRACK_SLOTS) {
    throw refuse('INVALID_ARGUMENT', 'track_limit', 'every track slot is visible, so there is no slot for the copy');
  }
  if ([...world.placements.values()].some((p) => p.trackId === newTrackId)) {
    throw refuse('INVALID_ARGUMENT', 'target_track_occupied', 'the first hidden track slot holds clips');
  }
  const mode = params.mode === 'share' ? 'share' : 'full';
  const dirtyBefore = world.project.dirty;
  const stateBefore = world.capture();
  const targetBefore = snapshotTracks(world)[newTrackId];
  world.setVisibleTrackCount(newTrackId + 1);
  const target = slot(world, newTrackId);
  Object.assign(target, {
    muted: source.muted,
    solo: source.solo,
    volumeLinear: source.volumeLinear,
    colour: source.colour,
  });
  world.touchTrackState();
  const sources = [...world.placements.values()].filter((p) => p.trackId === source.trackId);
  const copies = sources.map((p) =>
    copyPlacement(world, p, { trackId: newTrackId, startTimelineSec: p.startTimelineSec, mode }),
  );
  world.touchArrangement();
  world.markDirty();
  const contents = mode === 'share' ? [] : [...new Set(copies.map((p) => p.content))];
  const afterTrack = snapshotTracks(world)[newTrackId];
  return envelope(world, {
    applied: true,
    noOp: false,
    changes: [
      {
        entity: 'track',
        ref: { trackId: newTrackId },
        label: trackLabel(newTrackId),
        fields: trackFields(
          targetBefore ?? { muted: false, solo: false, volumeLinear: 1, colour: '', visible: false },
          afterTrack ?? targetBefore ?? { muted: false, solo: false, volumeLinear: 1, colour: '', visible: true },
        ),
      },
    ],
    created: [
      ...copies.map((p) => ({
        entity: 'placement',
        ref: { placementId: p.id },
        label: clipLabel(p.serial, p.trackId),
      })),
      ...contents.map((c) => ({ entity: 'content', ref: { contentId: c.id }, label: `Content ${String(c.objectId)}` })),
    ],
    idMap: sources.map((p, i) => ({
      entity: 'placement',
      relation: 'copy',
      from: [{ placementId: p.id }],
      to: [{ placementId: copies[i]?.id ?? '' }],
    })),
    diff: world.diff(stateBefore, world.capture()),
    contents,
    placements: copies,
    undo: {
      undoable: false,
      reason: 'ui_parity',
      revert: {
        method: 'track.delete',
        params: { trackId: newTrackId, expectedArrangementRevision: world.arrangement },
        requiresConsent: true,
      },
    },
    dirtyBefore,
    warnings: mode === 'share' ? [warning('SHARED_CONTENT', { trackId: newTrackId })] : [],
    extra: { newTrackId },
  });
};

// track.delete -------------------------------------------------------------------------------------

/**
 * Section 15.3 rule 6: an entry recorded before a track was deleted may address a track that has
 * moved since. An entry from the UI cannot be inspected, so every one is possibly stale; one made
 * through the API is when it addressed the deleted track or a later one. The tracks and clip
 * states it holds are then renumbered to the positions after the deletion. Only the visible tracks
 * behind the deleted one move; hidden slots keep their position and their clips.
 */
function markBarrier(world: World, deleted: number, visible: number): { undo: number; redo: number } {
  const moves = (t: number): boolean => t > deleted && t < visible;
  const renumber = (entry: HistoryEntry): void => {
    entry.tracks = (entry.tracks ?? []).filter((t) => t !== deleted).map((t) => (moves(t) ? t - 1 : t));
    for (const patch of [entry.undoPatch, entry.redoPatch]) {
      for (const { state } of patch?.placements ?? []) {
        if (state.trackId === undefined) continue;
        if (state.trackId === deleted) delete state.trackId;
        else if (moves(state.trackId)) state.trackId -= 1;
      }
    }
  };
  for (const entry of [...world.undoStack, ...world.redoStack]) {
    const addressed = entry.tracks ?? [];
    if (entry.origin === 'ui' || addressed.some((t) => t >= deleted)) {
      entry.possiblyStale = true;
      renumber(entry);
    }
  }
  return {
    undo: world.undoStack.filter((e) => e.possiblyStale).length,
    redo: world.redoStack.filter((e) => e.possiblyStale).length,
  };
}

const remove: Handler = (context) => {
  const { world, params } = context;
  const trackId = params.trackId as number;
  slot(world, trackId);
  checkNotBusy(context);
  if (params.expectedArrangementRevision !== world.arrangement) {
    throw refuse(
      'REVISION_CONFLICT',
      'arrangement_changed',
      'the arrangement changed since expectedArrangementRevision',
    );
  }
  if (trackId >= world.visibleTrackCount) {
    throw refuse('INVALID_ARGUMENT', 'track_hidden', 'a hidden track cannot be deleted');
  }
  if (world.visibleTrackCount === 1) {
    throw refuse('INVALID_ARGUMENT', 'last_track', 'the only visible track cannot be deleted');
  }
  if (params.confirm !== true) {
    throw refuse(
      'INVALID_ARGUMENT',
      'confirm_required',
      'deleting a track cannot be undone; the end user must agree, then the call carries confirm true',
    );
  }
  const dirtyBefore = world.project.dirty;
  const stateBefore = world.capture();
  const all = [...world.placements.values()];
  const visible = world.visibleTrackCount;
  // OpenTune moves only the shown tracks behind the deleted one; hidden slots keep their place and their clips.
  const moves = (id: number): boolean => id > trackId && id < visible;
  const trackIdMap: { before: number; after: number | null }[] = [{ before: trackId, after: null }];
  for (let id = trackId + 1; id < visible; id++) trackIdMap.push({ before: id, after: id - 1 });
  const doomed = all.filter((p) => p.trackId === trackId);
  // The settings of the tracks behind the deleted one move down a slot; trackIdMap and the moved clips'
  // `changes` describe that shift, so it is not listed again here. `removed` lists the clips and, after
  // them, the contents that leave the project with them (section 14.4 rule 6).
  const removed = [
    ...doomed.map((p) => ({
      entity: 'placement',
      ref: { placementId: p.id },
      label: clipLabel(p.serial, p.trackId),
    })),
    ...leavingContents(world, doomed),
  ];
  const dangling = all
    .filter((p) => p.trackId !== trackId && p.reference !== null && doomed.includes(p.reference))
    .map((p) => ({ placementId: p.id, referencePlacementId: p.reference?.id ?? '' }));
  const changes: { entity: string; ref: unknown; label: string; fields: Record<string, unknown> }[] = [];
  for (const placement of all) {
    if (doomed.includes(placement)) continue;
    const fields: Record<string, unknown> = {};
    const from = placement.trackId;
    if (moves(from)) fields.trackId = { before: from, after: from - 1, unit: null };
    const dropped = placement.reference !== null && doomed.includes(placement.reference);
    if (dropped) {
      fields.referencePlacementId = { before: placement.reference?.id ?? null, after: null, unit: null };
    }
    if (Object.keys(fields).length > 0) {
      changes.push({
        entity: 'placement',
        ref: { placementId: placement.id },
        label: clipLabel(placement.serial, moves(from) ? from - 1 : from),
        fields,
      });
    }
  }
  const moved = all.filter((p) => moves(p.trackId));
  for (const placement of doomed) world.removePlacement(placement);
  for (const placement of all) {
    if (placement.reference !== null && doomed.includes(placement.reference)) placement.reference = null;
  }
  for (const placement of moved) {
    placement.trackId -= 1;
    world.touchGeometry(placement);
  }
  for (let id = trackId; id < visible - 1; id++) {
    const into = world.tracks[id];
    const from = world.tracks[id + 1];
    if (into !== undefined && from !== undefined) {
      Object.assign(into, { muted: from.muted, solo: from.solo, volumeLinear: from.volumeLinear, colour: from.colour });
    }
  }
  const last = world.tracks[visible - 1];
  if (last !== undefined) {
    Object.assign(last, {
      muted: false,
      solo: false,
      volumeLinear: 1,
      colour: COLOURS[(visible - 1) % COLOURS.length] ?? '#888888',
    });
  }
  world.setVisibleTrackCount(world.visibleTrackCount - 1);
  if (world.activeTrackId !== null) {
    if (world.activeTrackId > trackId) world.activeTrackId -= 1;
    world.activeTrackId = Math.min(world.activeTrackId, world.visibleTrackCount - 1);
  }
  world.touchArrangement();
  world.touchTrackState();
  world.markDirty();
  const stale = markBarrier(world, trackId, visible);
  const warnings = [warning('IRREVERSIBLE', { trackId })];
  if (stale.undo + stale.redo > 0) warnings.push(warning('UNDO_HISTORY_POSSIBLY_STALE', null, stale));
  return envelope(world, {
    applied: true,
    noOp: false,
    changes,
    removed,
    diff: world.diff(stateBefore, world.capture()),
    contents: [],
    placements: moved,
    undo: { undoable: false, reason: 'no_upstream_undo', revert: null },
    dirtyBefore,
    warnings,
    extra: { trackIdMap, danglingReferences: dangling, possiblyStaleEntries: stale },
  });
};

export const trackHandlers: Readonly<Record<string, Handler>> = {
  'track.set': set,
  'track.add': add,
  'track.duplicate': duplicate,
  'track.delete': remove,
};
