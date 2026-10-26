// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// What the arrangement, track and history code of the mock share about placements: their editable
// state, how a difference between two states is described in `changes` (spec/otcp/v1/PROTOCOL.md
// section 14.3), and copying a clip with or without a content of its own.

import { clone, round6, type ContentRec, type PlacementRec, type PlacementState, type World } from './model.js';

export const PLACEMENT_KEYS = [
  'trackId',
  'startTimelineSec',
  'durationSec',
  'clipInContentSec',
  'gainLinear',
  'fadeInSec',
  'fadeOutSec',
] as const satisfies readonly (keyof PlacementState)[];

/** The properties whose change changes the geometryHash of a placement (section 10). */
const GEOMETRY_KEYS: readonly (keyof PlacementState)[] = [
  'trackId',
  'startTimelineSec',
  'durationSec',
  'clipInContentSec',
];

const EPSILON = 1e-9;

export const stateOf = (placement: PlacementRec): PlacementState => ({
  trackId: placement.trackId,
  startTimelineSec: placement.startTimelineSec,
  durationSec: placement.durationSec,
  clipInContentSec: placement.clipInContentSec,
  gainLinear: placement.gainLinear,
  fadeInSec: placement.fadeInSec,
  fadeOutSec: placement.fadeOutSec,
});

export const differs = (a: number, b: number): boolean => Math.abs(a - b) > EPSILON;

/** The properties on which two states (or a state and a part of one) differ. */
export function differing(before: Partial<PlacementState>, after: Partial<PlacementState>) {
  return PLACEMENT_KEYS.filter((key) => {
    const a = before[key];
    const b = after[key];
    return a !== undefined && b !== undefined && differs(a, b);
  });
}

/** A display label built from the position of the clip, never from its name (section 20.2). */
export const clipLabel = (serial: number, trackId: number): string =>
  `Clip ${String(serial)} on Track ${String(trackId + 1)}`;

export const gainDb = (linear: number): number | null => (linear === 0 ? null : round6(20 * Math.log10(linear)));

/**
 * The `removed` entries of contents that leave the project when the clips in `doomed` are removed:
 * those that no other clip shows (section 14.4 rule 6). Call it before the clips are removed.
 */
export function leavingContents(world: World, doomed: readonly PlacementRec[]) {
  return [...new Set(doomed.map((p) => p.content))]
    .filter((content) => world.placementsOf(content).every((p) => doomed.includes(p)))
    .map((content) => ({
      entity: 'content',
      ref: { contentId: content.id },
      label: `Content ${String(content.objectId)}`,
    }));
}

const UNITS: Record<keyof PlacementState, string | null> = {
  trackId: null,
  startTimelineSec: 'sec',
  durationSec: 'sec',
  clipInContentSec: 'sec',
  gainLinear: 'linear',
  fadeInSec: 'sec',
  fadeOutSec: 'sec',
};

/** `fields` of a `changes` entry for the properties that differ; a gain change reports dB and linear. */
export function fieldChanges(before: Partial<PlacementState>, after: Partial<PlacementState>) {
  const fields: Record<string, { before: unknown; after: unknown; unit: string | null }> = {};
  for (const key of differing(before, after)) {
    const a = before[key] ?? 0;
    const b = after[key] ?? 0;
    if (key === 'gainLinear') {
      fields.gainDb = { before: gainDb(a), after: gainDb(b), unit: 'db' };
      fields.gainLinear = { before: a, after: b, unit: 'linear' };
    } else {
      fields[key] = { before: a, after: b, unit: UNITS[key] };
    }
  }
  const endBefore = (before.startTimelineSec ?? 0) + (before.durationSec ?? 0);
  const endAfter = (after.startTimelineSec ?? 0) + (after.durationSec ?? 0);
  if (
    before.startTimelineSec !== undefined &&
    before.durationSec !== undefined &&
    after.startTimelineSec !== undefined &&
    after.durationSec !== undefined &&
    differs(endBefore, endAfter)
  ) {
    fields.endTimelineSec = { before: round6(endBefore), after: round6(endAfter), unit: 'sec' };
  }
  return fields;
}

/**
 * Puts `state` on the placement and moves the tokens: a change of the geometry gives it a new
 * geometryHash, and any change moves the arrangement revision. Returns the properties that changed.
 */
export function applyState(world: World, placement: PlacementRec, state: Partial<PlacementState>) {
  const changed = differing(stateOf(placement), state);
  for (const key of changed) placement[key] = state[key] ?? placement[key];
  if (changed.some((key) => GEOMETRY_KEYS.includes(key))) world.touchGeometry(placement);
  else if (changed.length > 0) world.touchArrangement();
  return changed;
}

export const pick = (state: PlacementState, keys: readonly (keyof PlacementState)[]): Partial<PlacementState> =>
  Object.fromEntries(keys.map((key) => [key, state[key]]));

/** The content window a clip shows, on the content clock. */
export function windowOf(world: World, placement: PlacementRec) {
  const { content } = placement;
  const startOut = world.contentToOutput(content, placement.clipInContentSec);
  return {
    startContentSec: placement.clipInContentSec,
    endContentSec: world.outputToContent(content, startOut + placement.durationSec),
  };
}

/** A new content that is a copy of `source`; with `window` only the part inside it, moved to start at 0. */
export function copyContent(
  world: World,
  source: ContentRec,
  window?: { startContentSec: number; endContentSec: number },
): ContentRec {
  const start = window?.startContentSec ?? 0;
  const end = window?.endContentSec ?? source.durationSec;
  const copy = world.addContent({
    durationSec: window === undefined ? source.durationSec : round6(end - start),
    analysis: source.analysis,
    sourcePath: source.sourcePath,
  });
  copy.key = clone(source.key);
  copy.pitchShift = clone(source.pitchShift);
  copy.notes = clone(source.notes)
    .filter((note) => note.endContentSec > start && note.startContentSec < end)
    .map((note) => ({
      ...note,
      startContentSec: round6(Math.max(note.startContentSec, start) - start),
      endContentSec: round6(Math.min(note.endContentSec, end) - start),
    }));
  const outStart = world.contentToOutput(source, start);
  copy.handles = source.handles
    .filter((handle) => window === undefined || (handle.contentSec > start && handle.contentSec < end))
    .map((handle) => ({
      handleId: `th:${String(copy.objectId)}:${String(++copy.handleSeq)}`,
      contentSec: round6(handle.contentSec - start),
      outputSec: round6(handle.outputSec - (window === undefined ? 0 : outStart)),
    }));
  return copy;
}

/** A copy of a clip on another track and position, with a content of its own or the same content. */
export function copyPlacement(
  world: World,
  source: PlacementRec,
  to: { trackId: number; startTimelineSec: number; mode: 'window' | 'full' | 'share' },
): PlacementRec {
  const window = to.mode === 'window' ? windowOf(world, source) : undefined;
  const content = to.mode === 'share' ? source.content : copyContent(world, source.content, window);
  return world.addPlacement({
    trackId: to.trackId,
    content,
    name: source.name,
    startTimelineSec: round6(to.startTimelineSec),
    durationSec: source.durationSec,
    clipInContentSec: window === undefined ? source.clipInContentSec : 0,
    gainLinear: source.gainLinear,
    fadeInSec: source.fadeInSec,
    fadeOutSec: source.fadeOutSec,
  });
}

/** Whether another clip on the track of `placement` overlaps it in time. */
export function overlapsOther(world: World, placement: PlacementRec, ignore: readonly PlacementRec[] = []): boolean {
  const end = placement.startTimelineSec + placement.durationSec;
  return [...world.placements.values()].some(
    (other) =>
      other !== placement &&
      !ignore.includes(other) &&
      other.trackId === placement.trackId &&
      other.startTimelineSec < end - EPSILON &&
      other.startTimelineSec + other.durationSec > placement.startTimelineSec + EPSILON,
  );
}
