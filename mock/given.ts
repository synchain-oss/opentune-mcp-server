// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The `given` preconditions of a contract vector (spec/otcp/v1/vectors/README.md, "Preconditions")
// that concern project state: the editing scheme, the unsaved-changes flag, clips, files and the
// undo and redo histories. A test sets them up directly on the model, never through OTCP. Jobs and
// capabilities belong to the server and are handled there.

import type { WorkFiles, GivenFile } from './files.js';
import { snapOf } from './history.js';
import {
  DEFAULT_NOTE_PARAMS,
  DETECTED_KEY,
  TRACK_SLOTS,
  type Analysis,
  type ContentRec,
  type ContentSnap,
  type HistoryEntry,
  type Patch,
  type PitchShiftRec,
  type PlacementRec,
  type World,
} from './model.js';

export interface GivenClip {
  readonly bind: string;
  readonly trackId: number;
  readonly startTimelineSec: number;
  readonly durationSec: number;
  readonly analysis: Analysis;
  readonly notes?: readonly { startContentSec: number; endContentSec: number; targetMidi: number }[];
  readonly key?: { root: number; scale: string };
  readonly pitchShift?: PitchShiftRec;
  readonly timeGrid?: readonly { bind: string; contentSec: number }[];
  readonly referenceClip?: string;
}

export interface GivenHistoryEntry {
  readonly bind?: string;
  readonly origin: 'control' | 'ui';
  readonly action: string;
  readonly clip: string;
  readonly trackDeletedAfter?: boolean;
  /** A track after the clip's track was deleted after the entry was recorded: the clip did not move. */
  readonly laterTrackDeletedAfter?: boolean;
}

export interface GivenState {
  readonly editingScheme?: string;
  readonly dirty?: boolean;
  readonly clips?: readonly GivenClip[];
  /** Every track slot that no clip of `clips` is on holds one more clip. */
  readonly clipOnEveryTrack?: boolean;
  readonly files?: readonly GivenFile[];
  readonly history?: { readonly undo: readonly GivenHistoryEntry[]; readonly redo: readonly GivenHistoryEntry[] };
}

/** The members of a vector's `given` that this module establishes. */
export const WORLD_GIVEN_MEMBERS = ['editingScheme', 'dirty', 'clips', 'clipOnEveryTrack', 'files', 'history'] as const;

/** The clip that `clipOnEveryTrack` adds to an empty track (vectors/README.md, Preconditions). */
const FILLER_CLIP_SEC = 2;

const GIVEN_KEY_CONFIDENCE = 0.9;

const DESCRIPTIONS: Readonly<Record<string, { description: string; innerAction: string }>> = {
  noteEdit: { description: 'Edit notes', innerAction: 'setNotes' },
  pitchShift: { description: 'Pitch shift', innerAction: 'setPitchShift' },
  clipMove: { description: 'Move clip', innerAction: 'moveClip' },
  clipSplit: { description: 'Split clip', innerAction: 'splitClip' },
};

function createClip(world: World, files: WorkFiles, clip: GivenClip, bindings: Record<string, string>) {
  const sourcePath = files.clipSource(clip.bind, clip.durationSec, clip.analysis !== 'unvoiced');
  const content = world.addContent({ durationSec: clip.durationSec, analysis: clip.analysis, sourcePath });
  if (clip.pitchShift !== undefined) content.pitchShift = { ...clip.pitchShift };
  if (clip.key !== undefined) {
    content.key = { ...clip.key, origin: 'automatic', confidence: GIVEN_KEY_CONFIDENCE };
  } else if (clip.analysis === 'ready') {
    content.key = { ...DETECTED_KEY };
  }
  if (clip.analysis === 'ready') {
    content.notes = [...(clip.notes ?? [])]
      .sort((a, b) => a.startContentSec - b.startContentSec)
      .map((n) => ({
        startContentSec: n.startContentSec,
        endContentSec: n.endContentSec,
        targetMidi: n.targetMidi,
        offsetCents: 0,
        ...DEFAULT_NOTE_PARAMS,
      }));
  }
  content.handles = (clip.timeGrid ?? []).map((handle) => {
    const handleId = `th:${String(content.objectId)}:${String(++content.handleSeq)}`;
    bindings[handle.bind] = handleId;
    return { handleId, contentSec: handle.contentSec, outputSec: handle.contentSec };
  });
  const placement = world.addPlacement({
    trackId: clip.trackId,
    content,
    name: clip.bind,
    startTimelineSec: clip.startTimelineSec,
    durationSec: clip.durationSec,
  });
  bindings[`${clip.bind}.contentId`] = content.id;
  bindings[`${clip.bind}.placementId`] = placement.id;
  bindings[`${clip.bind}.sourcePath`] = sourcePath;
  return placement;
}

/** An older or newer state of the target of a history entry: what the entry's step puts back. */
function perturbed(action: string, direction: 'older' | 'newer', snap: ContentSnap, start: number) {
  const next: ContentSnap = structuredClone(snap);
  const sign = direction === 'older' ? -1 : 1;
  let startTimelineSec = start;
  if (action === 'noteEdit') {
    const note = next.notes[0];
    if (note !== undefined) {
      note.offsetCents += 10 * sign;
      note.targetMidi += 0.1 * sign;
    }
  } else if (action === 'pitchShift') {
    const wanted = next.pitchShift.semitones + 2 * sign;
    next.pitchShift = {
      ...next.pitchShift,
      semitones: Math.abs(wanted) <= 24 ? wanted : next.pitchShift.semitones - 2 * sign,
    };
  } else if (action === 'clipMove') {
    startTimelineSec = start + sign >= 0 ? start + sign : start - sign;
  }
  return { snap: next, startTimelineSec };
}

/** The undo and redo histories: entries whose steps change the clips they name (vectors/README.md). */
function buildHistory(
  world: World,
  given: NonNullable<GivenState['history']>,
  byBind: ReadonlyMap<string, PlacementRec>,
  bindings: Record<string, string>,
): void {
  const state = new Map<number, { snap: ContentSnap; startTimelineSec: number; serial: number }>();
  const current = (placement: PlacementRec) => {
    let entry = state.get(placement.serial);
    if (entry === undefined) {
      entry = {
        snap: snapOf(placement.content),
        startTimelineSec: placement.startTimelineSec,
        serial: placement.serial,
      };
      state.set(placement.serial, entry);
    }
    return entry;
  };
  const make = (item: GivenHistoryEntry, direction: 'undo' | 'redo'): HistoryEntry => {
    const placement = byBind.get(item.clip);
    if (placement === undefined) throw new Error(`history entry names the clip ${item.clip}, which no clip binds`);
    const info = DESCRIPTIONS[item.action] ?? { description: item.action, innerAction: item.action };
    // A track before the clip's moved it, so the entry does nothing. A later track did not, but
    // the server cannot tell that for an entry made in the UI (PROTOCOL.md section 15.3 rule 6).
    const moved = item.trackDeletedAfter === true;
    const stale = moved || (item.laterTrackDeletedAfter === true && item.origin === 'ui');
    let undoPatch: Patch | null = null;
    let redoPatch: Patch | null = null;
    if (!moved && item.action !== 'clipSplit') {
      // Walking away from the present: undo entries go back in time, redo entries forward.
      const now = current(placement);
      const there = perturbed(item.action, direction === 'undo' ? 'older' : 'newer', now.snap, now.startTimelineSec);
      const content = { objectId: placement.content.objectId };
      const near: Patch = {
        content: { ...content, snap: now.snap },
        placement: { serial: placement.serial, startTimelineSec: now.startTimelineSec },
      };
      const far: Patch = {
        content: { ...content, snap: there.snap },
        placement: { serial: placement.serial, startTimelineSec: there.startTimelineSec },
      };
      [undoPatch, redoPatch] = direction === 'undo' ? [far, near] : [near, far];
      state.set(placement.serial, { ...now, snap: there.snap, startTimelineSec: there.startTimelineSec });
    }
    const entry: HistoryEntry = {
      seq: null,
      origin: item.origin,
      action: item.action,
      description: info.description,
      innerActions: [info.innerAction],
      undoPatch,
      redoPatch,
      possiblyStale: stale,
      unsafe: item.action === 'clipSplit',
    };
    return entry;
  };
  // undoIds are assigned oldest first, the undo history before the redo history.
  const undo = new Array<HistoryEntry | undefined>(given.undo.length);
  const redo = new Array<HistoryEntry | undefined>(given.redo.length);
  // The undo history is built from the newest entry back, the redo history from its top.
  for (const [i, item] of [...given.undo.entries()].reverse()) undo[i] = make(item, 'undo');
  state.clear();
  for (const [i, item] of [...given.redo.entries()].reverse()) redo[i] = make(item, 'redo');
  const number = (items: readonly GivenHistoryEntry[], built: (HistoryEntry | undefined)[]) => {
    for (const [i, item] of items.entries()) {
      const entry = built[i];
      if (entry === undefined || item.origin !== 'control') continue;
      const { seq, undoId } = world.nextUndoId();
      entry.seq = seq;
      if (item.bind !== undefined) bindings[item.bind] = undoId;
    }
  };
  number(given.undo, undo);
  number(given.redo, redo);
  world.undoStack = undo.filter((e): e is HistoryEntry => e !== undefined);
  world.redoStack = redo.filter((e): e is HistoryEntry => e !== undefined);
}

/** Establishes the project-state members of a vector's `given` and returns the names it binds. */
export function applyGiven(world: World, files: WorkFiles, given: GivenState): Record<string, string> {
  const bindings: Record<string, string> = {};
  if (given.editingScheme !== undefined) world.editingScheme = given.editingScheme;
  const byBind = new Map<string, PlacementRec>();
  for (const clip of given.clips ?? []) byBind.set(clip.bind, createClip(world, files, clip, bindings));
  for (const clip of given.clips ?? []) {
    const reference = clip.referenceClip === undefined ? undefined : byBind.get(clip.referenceClip);
    if (clip.referenceClip !== undefined && reference === undefined) {
      throw new Error(`clip ${clip.bind} refers to the reference clip ${clip.referenceClip}, which no clip binds`);
    }
    const placement = byBind.get(clip.bind);
    if (placement !== undefined && reference !== undefined) placement.reference = reference;
  }
  if (given.clipOnEveryTrack === true) {
    const used = new Set([...world.placements.values()].map((p) => p.trackId));
    for (let trackId = 0; trackId < TRACK_SLOTS; trackId++) {
      if (used.has(trackId)) continue;
      // No name binds these clips, so their bindings go nowhere.
      const filler = {
        bind: `track${String(trackId)}Filler`,
        trackId,
        startTimelineSec: 0,
        durationSec: FILLER_CLIP_SEC,
      };
      createClip(world, files, { ...filler, analysis: 'ready' }, {});
    }
  }
  for (const file of given.files ?? []) Object.assign(bindings, files.provide(file));
  if (given.history !== undefined) buildHistory(world, given.history, byBind, bindings);
  world.project.dirty = given.dirty ?? false;
  // Tokens are read after every precondition is in place (vectors/README.md).
  for (const [bind, placement] of byBind) {
    const content: ContentRec = placement.content;
    bindings[`${bind}.revision`] = content.revision;
    bindings[`${bind}.gridRevision`] = content.comp.grid;
    bindings[`${bind}.keyRevision`] = content.comp.key;
    bindings[`${bind}.geometryHash`] = placement.geometryHash;
  }
  return bindings;
}
