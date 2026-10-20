// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The clip edits of the mock (capability arrangement.v1): arrangement.edit and arrangement.copy
// (spec/otcp/v1/PROTOCOL.md sections 14, 15 and 15.4). The ops of one call are planned on working
// copies of the clips, in order; the plan is then predicted (dryRun) or committed as one undo step.
// Split, merge and delete push the entry the UI pushes but are reported as not undoable, since
// OpenTune cannot take them back (section 15.4 rule 1).

import { checkNotBusy, envelope, isEmptyDiff, type Handler, type MethodContext } from './context.js';
import { refuse } from './errors.js';
import { HOP_SEC } from './music.js';
import { round6, type HistoryEntry, type PlacementRec, type PlacementState, type World } from './model.js';
import {
  applyState,
  clipLabel,
  copyPlacement,
  differing,
  differs,
  fieldChanges,
  gainDb,
  leavingContents,
  overlapsOther,
  pick,
  stateOf,
} from './placements.js';
import { EMPTY_DIFF, requireReady } from './writes.js';

/** The clip gain OpenTune accepts, as a linear factor. */
export const GAIN_LINEAR_MAX = 4;
const TOLERANCE = 1e-6;

type Op = Record<string, unknown> & { op: string };

const ENTRY_NAMES: Readonly<Record<string, { description: string; innerActions: string[] }>> = {
  move: { description: 'Move clip', innerActions: ['moveClip'] },
  trim: { description: 'Trim clip', innerActions: ['setFade', 'trimClip'] },
  setGain: { description: 'Set clip gain', innerActions: ['setClipGain'] },
  setFade: { description: 'Set clip fade', innerActions: ['setFade'] },
  setReference: { description: 'Set reference clip', innerActions: ['setReference'] },
};

const warning = (code: string, subject: unknown, data: unknown = null) => ({ code, subject, data });
const subjectOf = (placement: PlacementRec) => ({ placementId: placement.id });

/** What the plan does to one clip that stays. */
interface Draft {
  readonly placement: PlacementRec;
  readonly before: PlacementState;
  after: PlacementState;
  /** Properties an undo step puts back besides those that changed (a trim records the fades). */
  readonly recorded: Set<keyof PlacementState>;
  referenceBefore: PlacementRec | null;
  referenceAfter: PlacementRec | null;
}

function trackSlot(world: World, trackId: unknown): void {
  if (typeof trackId === 'number' && (trackId < 0 || trackId >= world.tracks.length)) {
    throw refuse('NOT_FOUND', 'unknown_handle', 'toTrackId names no track slot');
  }
}

/** Section 13.1 rule 4, handles first: every placement and track an op names must exist. */
function resolveHandles(world: World, ops: readonly Op[]): void {
  for (const op of ops) {
    for (const key of ['placementId', 'leadingPlacementId', 'trailingPlacementId'] as const) {
      if (typeof op[key] === 'string') world.placement(op[key]);
    }
    if (op.op === 'delete') for (const id of op.placementIds as string[]) world.placement(id);
    if (op.op === 'setReference' && typeof op.referencePlacementId === 'string') {
      world.placement(op.referencePlacementId);
    }
    trackSlot(world, op.toTrackId);
  }
}

function checkRevision(world: World, expected: unknown): void {
  if (expected !== world.arrangement) {
    throw refuse(
      'REVISION_CONFLICT',
      'arrangement_changed',
      'the arrangement changed since expectedArrangementRevision',
    );
  }
}

/** The share of its length that a clip's fades may take together. */
const FADE_SHARE = 0.9;

const clampFade = (fade: number, durationSec: number): number => Math.min(fade, Math.max(0, durationSec));

/** The fade-in keeps its length up to the share; the fade-out gets what remains of the share after it. */
const clampFades = (fadeIn: number, fadeOut: number, durationSec: number) => {
  const room = round6(durationSec * FADE_SHARE);
  const kept = clampFade(fadeIn, room);
  return { fadeInSec: kept, fadeOutSec: round6(clampFade(fadeOut, room - kept)) };
};

/** The placement a reference chain from `start` ends at, or the placements it passes through. */
function referenceChain(start: PlacementRec | null, drafts: ReadonlyMap<number, Draft>): PlacementRec[] {
  const chain: PlacementRec[] = [];
  for (let current = start; current !== null && !chain.includes(current);) {
    chain.push(current);
    const draft = drafts.get(current.serial);
    current = draft === undefined ? current.reference : draft.referenceAfter;
  }
  return chain;
}

interface Plan {
  readonly drafts: Map<number, Draft>;
  readonly warnings: unknown[];
}

/** Plans the ops move, trim, setGain, setFade and setReference on working copies of the clips. */
function planEdits(world: World, ops: readonly Op[]): Plan {
  const drafts = new Map<number, Draft>();
  const warnings: unknown[] = [];
  const draftOf = (id: string): Draft => {
    const placement = world.placement(id);
    let draft = drafts.get(placement.serial);
    if (draft === undefined) {
      draft = {
        placement,
        before: stateOf(placement),
        after: stateOf(placement),
        recorded: new Set(),
        referenceBefore: placement.reference,
        referenceAfter: placement.reference,
      };
      drafts.set(placement.serial, draft);
    }
    return draft;
  };
  for (const op of ops) {
    const draft = draftOf(String(op.placementId));
    const { after, placement } = draft;
    switch (op.op) {
      case 'move': {
        if (typeof op.toTrackId === 'number') after.trackId = op.toTrackId;
        if (typeof op.startTimelineSec === 'number') after.startTimelineSec = op.startTimelineSec;
        break;
      }
      case 'trim': {
        const to = op.toTimelineSec as number;
        const content = placement.content;
        const end = after.startTimelineSec + after.durationSec;
        // The room the content gives: output seconds before the clip's window and after it.
        const windowStartOut = world.contentToOutput(content, after.clipInContentSec);
        if (op.edge === 'start') {
          const startLimit = after.startTimelineSec - windowStartOut;
          if (to < startLimit - TOLERANCE || to >= end - TOLERANCE) {
            throw refuse(
              'INVALID_ARGUMENT',
              'trim_out_of_range',
              'the new start lies outside the audio of the content',
            );
          }
          const delta = to - after.startTimelineSec;
          after.clipInContentSec = round6(world.outputToContent(content, windowStartOut + delta));
          after.startTimelineSec = to;
          after.durationSec = round6(end - to);
        } else {
          const endLimit = after.startTimelineSec + (content.durationSec - windowStartOut);
          if (to > endLimit + TOLERANCE || to <= after.startTimelineSec + TOLERANCE) {
            throw refuse('INVALID_ARGUMENT', 'trim_out_of_range', 'the new end lies outside the audio of the content');
          }
          after.durationSec = round6(to - after.startTimelineSec);
        }
        draft.recorded.add('fadeInSec').add('fadeOutSec');
        const { fadeInSec: fadeIn, fadeOutSec: fadeOut } = clampFades(
          after.fadeInSec,
          after.fadeOutSec,
          after.durationSec,
        );
        if (differs(fadeIn, after.fadeInSec) || differs(fadeOut, after.fadeOutSec)) {
          warnings.push(
            warning('FADES_RECLAMPED', subjectOf(placement), {
              fadeInSec: differs(fadeIn, after.fadeInSec) ? { before: after.fadeInSec, after: fadeIn } : null,
              fadeOutSec: differs(fadeOut, after.fadeOutSec) ? { before: after.fadeOutSec, after: fadeOut } : null,
            }),
          );
          after.fadeInSec = fadeIn;
          after.fadeOutSec = fadeOut;
        }
        break;
      }
      case 'setGain': {
        const field = typeof op.gainDb === 'number' ? 'gainDb' : 'gainLinear';
        const requested = (op.gainDb ?? op.gainLinear) as number;
        const linear = typeof op.gainDb === 'number' ? 10 ** (op.gainDb / 20) : (op.gainLinear as number);
        after.gainLinear = Math.min(linear, GAIN_LINEAR_MAX);
        if (linear > GAIN_LINEAR_MAX) {
          const applied = field === 'gainDb' ? gainDb(GAIN_LINEAR_MAX) : GAIN_LINEAR_MAX;
          warnings.push(warning('CLAMPED', subjectOf(placement), { field, requested, applied }));
        }
        break;
      }
      case 'setFade': {
        for (const field of ['fadeInSec', 'fadeOutSec'] as const) {
          const requested = op[field];
          if (typeof requested !== 'number') continue;
          const other = field === 'fadeInSec' ? 'fadeOutSec' : 'fadeInSec';
          const otherRequested = typeof op[other] === 'number';
          const otherBefore = after[other];
          after[field] = requested;
          const fitted = clampFades(after.fadeInSec, after.fadeOutSec, after.durationSec);
          if (differs(fitted[field], requested)) {
            warnings.push(warning('CLAMPED', subjectOf(placement), { field, requested, applied: fitted[field] }));
          }
          Object.assign(after, fitted);
          // A side that was not asked for and got shortened to make room is an effect the caller did not request.
          if (!otherRequested && differs(fitted[other], otherBefore)) {
            warnings.push(
              warning('FADES_RECLAMPED', subjectOf(placement), {
                fadeInSec: other === 'fadeInSec' ? { before: otherBefore, after: fitted[other] } : null,
                fadeOutSec: other === 'fadeOutSec' ? { before: otherBefore, after: fitted[other] } : null,
              }),
            );
          }
        }
        break;
      }
      case 'setReference': {
        const target = typeof op.referencePlacementId === 'string' ? world.placement(op.referencePlacementId) : null;
        if (target !== null) {
          const targetState = drafts.get(target.serial)?.after ?? stateOf(target);
          const overlapping =
            targetState.startTimelineSec < after.startTimelineSec + after.durationSec - TOLERANCE &&
            targetState.startTimelineSec + targetState.durationSec > after.startTimelineSec + TOLERANCE;
          if (target === placement || !overlapping || referenceChain(target, drafts).includes(placement)) {
            throw refuse(
              'INVALID_ARGUMENT',
              'reference_ineligible',
              'a clip can only refer to another clip that overlaps it in time and does not lead back to it',
            );
          }
        }
        draft.referenceAfter = target;
        warnings.push(warning('EXPERIMENTAL_FEATURE', subjectOf(placement)));
        break;
      }
      default:
        throw refuse('INVALID_ARGUMENT', 'invalid_params', `the op ${op.op} is not planned here`);
    }
  }
  return { drafts, warnings };
}

const changedKeys = (draft: Draft) => differing(draft.before, draft.after);
const referenceChanged = (draft: Draft): boolean => draft.referenceBefore !== draft.referenceAfter;
const hasEffect = (draft: Draft): boolean => changedKeys(draft).length > 0 || referenceChanged(draft);

function changeOf(draft: Draft) {
  const fields: Record<string, unknown> = fieldChanges(draft.before, draft.after);
  if (referenceChanged(draft)) {
    fields.referencePlacementId = {
      before: draft.referenceBefore?.id ?? null,
      after: draft.referenceAfter?.id ?? null,
      unit: null,
    };
  }
  return {
    entity: 'placement',
    ref: { placementId: draft.placement.id },
    label: clipLabel(draft.placement.serial, draft.after.trackId),
    fields,
  };
}

/** The unfinished clips after the plan: the working copies replace the clips they stand for. */
function overlapWarnings(world: World, drafts: ReadonlyMap<number, Draft>, ops: readonly Op[]): unknown[] {
  const moved = ops.some((op) => op.op === 'move' || op.op === 'trim');
  if (!moved) return [];
  const states = new Map(
    [...world.placements.values()].map((p) => [p.serial, drafts.get(p.serial)?.after ?? stateOf(p)]),
  );
  const found: unknown[] = [];
  for (const draft of drafts.values()) {
    if (changedKeys(draft).every((key) => key !== 'trackId' && key !== 'startTimelineSec' && key !== 'durationSec')) {
      continue;
    }
    const mine = states.get(draft.placement.serial);
    if (mine === undefined) continue;
    const overlaps = [...states].some(
      ([serial, other]) =>
        serial !== draft.placement.serial &&
        other.trackId === mine.trackId &&
        other.startTimelineSec < mine.startTimelineSec + mine.durationSec - TOLERANCE &&
        other.startTimelineSec + other.durationSec > mine.startTimelineSec + TOLERANCE,
    );
    if (overlaps) found.push(warning('OVERLAPS_CLIP', subjectOf(draft.placement)));
  }
  return found;
}

/** Hidden tracks that the plan's clips land on, shown from the first hidden one up to the highest. */
function revealedBy(world: World, tracks: readonly number[]): number[] {
  const highest = Math.max(-1, ...tracks);
  const revealed: number[] = [];
  for (let id = world.visibleTrackCount; id <= highest; id++) revealed.push(id);
  return revealed;
}

const revealEffects = (revealed: readonly number[]) => ({
  sideEffects: revealed.length === 0 ? {} : { tracksRevealed: { trackIds: [...revealed], revert: null } },
  warnings: revealed.map((trackId) => warning('TRACK_AUTO_REVEALED', { trackId })),
});

function entryFor(ops: readonly Op[]): { description: string; innerActions: string[] } {
  const kinds = [...new Set(ops.map((op) => op.op))].filter((kind) => kind in ENTRY_NAMES);
  if (kinds.length === 1) {
    const only = ENTRY_NAMES[kinds[0] ?? ''];
    if (only !== undefined) return only;
  }
  return {
    description: 'Edit clips',
    innerActions: [...new Set(kinds.flatMap((kind) => ENTRY_NAMES[kind]?.innerActions ?? []))],
  };
}

function editClips(context: MethodContext, ops: readonly Op[], dryRun: boolean) {
  const { world } = context;
  const { drafts, warnings: planWarnings } = planEdits(world, ops);
  const effective = [...drafts.values()].filter(hasEffect);
  const warnings = [...planWarnings, ...overlapWarnings(world, drafts, ops)];
  const revealed = revealedBy(
    world,
    effective.filter((d) => d.after.trackId !== d.before.trackId).map((d) => d.after.trackId),
  );
  const reveal = revealEffects(revealed);
  const changes = effective.map(changeOf);
  const touched = effective.map((d) => d.placement);
  if (dryRun) {
    return envelope(world, {
      applied: false,
      noOp: false,
      dryRun: true,
      changes,
      diff: EMPTY_DIFF,
      contents: [],
      placements: touched,
      undo: null,
      dirtyBefore: world.project.dirty,
      sideEffects: reveal.sideEffects,
      warnings: [...warnings, ...reveal.warnings],
    });
  }
  if (effective.length === 0) {
    return envelope(world, {
      applied: true,
      noOp: true,
      diff: EMPTY_DIFF,
      contents: [],
      undo: { undoable: false, reason: 'no_op', revert: null },
      dirtyBefore: world.project.dirty,
      warnings,
    });
  }
  const dirtyBefore = world.project.dirty;
  const before = world.capture();
  world.revealThrough(Math.max(-1, ...revealed));
  const beforeStates = effective.map((d) => ({ draft: d, keys: new Set([...changedKeys(d), ...d.recorded]) }));
  for (const draft of effective) {
    applyState(world, draft.placement, draft.after);
    if (referenceChanged(draft)) {
      draft.placement.reference = draft.referenceAfter;
      world.touchArrangement();
    }
  }
  const { description, innerActions } = entryFor(ops);
  const { seq, undoId } = world.nextUndoId();
  const stateKeys = (side: 'before' | 'after') =>
    beforeStates
      .filter(({ draft, keys }) => keys.size > 0 || referenceChanged(draft))
      .map(({ draft, keys }) => ({
        serial: draft.placement.serial,
        state: pick(draft[side], [...keys]),
        ...(referenceChanged(draft)
          ? { reference: (side === 'before' ? draft.referenceBefore : draft.referenceAfter)?.serial ?? null }
          : {}),
      }));
  const entry: HistoryEntry = {
    seq,
    origin: 'control',
    action: ops.length === 1 && ops[0]?.op === 'move' ? 'clipMove' : 'clipEdit',
    description,
    innerActions,
    undoPatch: { placements: stateKeys('before') },
    redoPatch: { placements: stateKeys('after') },
    possiblyStale: false,
    unsafe: false,
    tracks: [...new Set(effective.flatMap((d) => [d.before.trackId, d.after.trackId]))],
  };
  world.undoStack.push(entry);
  world.redoStack = [];
  world.markDirty();
  const diff = world.diff(before, world.capture());
  return envelope(world, {
    applied: true,
    noOp: false,
    changes,
    diff,
    contents: [],
    placements: touched,
    undo: { undoable: true, undoId, description, innerActions: [...innerActions], steps: 1 },
    dirtyBefore,
    sideEffects: reveal.sideEffects,
    warnings: [...warnings, ...reveal.warnings],
  });
}

// split ----------------------------------------------------------------------------------------------

/** Where a split at `at` lands: on the nearest analysis frame of the content. */
function splitPosition(world: World, placement: PlacementRec, at: number) {
  const { content } = placement;
  const startOut = world.contentToOutput(content, placement.clipInContentSec);
  const requestedContent = world.outputToContent(content, startOut + (at - placement.startTimelineSec));
  const snappedContent = Math.round(requestedContent / HOP_SEC) * HOP_SEC;
  const snappedOut = world.contentToOutput(content, snappedContent);
  return {
    contentSec: round6(snappedContent),
    timelineSec: round6(placement.startTimelineSec + (snappedOut - startOut)),
  };
}

/** The result of a call that replaces clips: the entry OpenTune pushes (it cannot undo it) and the not-undoable descriptor. */
function pushUnsafeEntry(world: World, action: string, description: string, innerAction: string, tracks: number[]) {
  const { seq } = world.nextUndoId();
  world.undoStack.push({
    seq,
    origin: 'control',
    action,
    description,
    innerActions: [innerAction],
    undoPatch: null,
    redoPatch: null,
    possiblyStale: false,
    unsafe: true,
    tracks,
  });
  world.redoStack = [];
}

const clipItem = (placement: PlacementRec) => ({
  entity: 'placement',
  ref: { placementId: placement.id },
  label: clipLabel(placement.serial, placement.trackId),
});

/** The fades a clip had before a split shortened them, so that merging the two parts can put them back. */
const splitFades = new WeakMap<
  PlacementRec,
  { right: PlacementRec; fadeInSec: number; fadeOutSec: number; leftDurationSec: number; rightDurationSec: number }
>();

function split(context: MethodContext, op: Op, dryRun: boolean) {
  const { world } = context;
  const placement = world.placement(String(op.placementId));
  const at = op.atTimelineSec as number;
  const end = placement.startTimelineSec + placement.durationSec;
  const where = splitPosition(world, placement, at);
  if (at <= placement.startTimelineSec + TOLERANCE || at >= end - TOLERANCE) {
    throw refuse('INVALID_ARGUMENT', 'split_out_of_range', 'the position must lie strictly inside the clip');
  }
  if (where.timelineSec <= placement.startTimelineSec + TOLERANCE || where.timelineSec >= end - TOLERANCE) {
    throw refuse('INVALID_ARGUMENT', 'split_out_of_range', 'the nearest analysis frame lies at an edge of the clip');
  }
  const warnings: unknown[] = [];
  if (differs(where.timelineSec, at) && Math.abs(where.timelineSec - at) > TOLERANCE) {
    warnings.push(
      warning('SPLIT_SNAPPED', subjectOf(placement), {
        requestedTimelineSec: at,
        appliedTimelineSec: where.timelineSec,
      }),
    );
  }
  // Each part keeps the fade at its own outer edge, limited to its new length like any other fade.
  const windowLeft = round6(where.timelineSec - placement.startTimelineSec);
  const windowRight = round6(end - where.timelineSec);
  const fadeIn = clampFades(placement.fadeInSec, 0, windowLeft).fadeInSec;
  const fadeOut = clampFades(0, placement.fadeOutSec, windowRight).fadeOutSec;
  const fadeInShortened = differs(fadeIn, placement.fadeInSec);
  const fadeOutShortened = differs(fadeOut, placement.fadeOutSec);
  if (fadeInShortened || fadeOutShortened) {
    warnings.push(
      warning('FADES_RECLAMPED', subjectOf(placement), {
        fadeInSec: fadeInShortened ? { before: placement.fadeInSec, after: fadeIn } : null,
        fadeOutSec: fadeOutShortened ? { before: placement.fadeOutSec, after: fadeOut } : null,
      }),
    );
  }
  const dirtyBefore = world.project.dirty;
  if (dryRun) {
    return envelope(world, {
      applied: false,
      noOp: false,
      dryRun: true,
      diff: EMPTY_DIFF,
      contents: [],
      placements: [placement],
      undo: null,
      dirtyBefore,
      warnings,
      changes: [
        {
          entity: 'placement',
          ref: { placementId: placement.id },
          label: clipLabel(placement.serial, placement.trackId),
          fields: {
            durationSec: { before: placement.durationSec, after: windowLeft, unit: 'sec' },
            ...(fadeInShortened ? { fadeInSec: { before: placement.fadeInSec, after: fadeIn, unit: 'sec' } } : {}),
            ...(fadeOutShortened ? { fadeOutSec: { before: placement.fadeOutSec, after: fadeOut, unit: 'sec' } } : {}),
          },
        },
      ],
    });
  }
  const before = world.capture();
  const common = {
    content: placement.content,
    name: placement.name,
    gainLinear: placement.gainLinear,
    reference: placement.reference,
  };
  const left = world.addPlacement({
    ...common,
    trackId: placement.trackId,
    startTimelineSec: placement.startTimelineSec,
    durationSec: windowLeft,
    clipInContentSec: placement.clipInContentSec,
    fadeInSec: fadeIn,
  });
  const right = world.addPlacement({
    ...common,
    trackId: placement.trackId,
    startTimelineSec: where.timelineSec,
    durationSec: windowRight,
    clipInContentSec: where.contentSec,
    fadeOutSec: fadeOut,
  });
  splitFades.set(left, {
    right,
    fadeInSec: placement.fadeInSec,
    fadeOutSec: placement.fadeOutSec,
    leftDurationSec: left.durationSec,
    rightDurationSec: right.durationSec,
  });
  const original = clipItem(placement);
  world.removePlacement(placement);
  for (const other of world.placements.values()) if (other.reference === placement) other.reference = left;
  world.touchArrangement();
  pushUnsafeEntry(world, 'clipSplit', 'Split clip', 'splitClip', [placement.trackId]);
  world.markDirty();
  const diff = world.diff(before, world.capture());
  return envelope(world, {
    applied: true,
    noOp: false,
    created: [clipItem(left), clipItem(right)],
    removed: [original],
    idMap: [
      {
        entity: 'placement',
        relation: 'split',
        from: [{ placementId: placement.id }],
        to: [{ placementId: left.id }, { placementId: right.id }],
      },
    ],
    diff,
    contents: [],
    placements: [left, right],
    undo: {
      undoable: false,
      reason: 'upstream_undo_defect',
      revert: {
        method: 'arrangement.edit',
        params: {
          expectedArrangementRevision: world.arrangement,
          ops: [{ op: 'merge', leadingPlacementId: left.id, trailingPlacementId: right.id }],
        },
      },
    },
    dirtyBefore,
    warnings: [...warnings, warning('UPSTREAM_UNDO_DEFECT', subjectOf(placement))],
  });
}

// merge ----------------------------------------------------------------------------------------------

function merge(context: MethodContext, op: Op, dryRun: boolean) {
  const { world } = context;
  const leading = world.placement(String(op.leadingPlacementId));
  const trailing = world.placement(String(op.trailingPlacementId));
  const { content } = leading;
  const windowEndOut = world.contentToOutput(content, leading.clipInContentSec) + leading.durationSec;
  const possible =
    leading !== trailing &&
    trailing.content === content &&
    trailing.trackId === leading.trackId &&
    Math.abs(trailing.startTimelineSec - (leading.startTimelineSec + leading.durationSec)) < TOLERANCE &&
    Math.abs(world.contentToOutput(content, trailing.clipInContentSec) - windowEndOut) < TOLERANCE &&
    !differs(leading.gainLinear, trailing.gainLinear);
  if (!possible) {
    throw refuse(
      'INVALID_ARGUMENT',
      'merge_not_possible',
      'the clips must be on one track, adjacent in time and in the content, and have equal gain',
    );
  }
  const duration = round6(leading.durationSec + trailing.durationSec);
  // Parts of an earlier split get their original fades back as long as nobody changed the outer ones or
  // the length of either part since (a trimmed part no longer fits the fades it had).
  const origin = splitFades.get(leading);
  const restores =
    origin?.right === trailing &&
    !differs(leading.durationSec, origin.leftDurationSec) &&
    !differs(trailing.durationSec, origin.rightDurationSec) &&
    !differs(leading.fadeInSec, clampFades(origin.fadeInSec, 0, leading.durationSec).fadeInSec) &&
    !differs(trailing.fadeOutSec, clampFades(0, origin.fadeOutSec, trailing.durationSec).fadeOutSec);
  const mergedFades = restores
    ? clampFades(origin.fadeInSec, origin.fadeOutSec, duration)
    : { fadeInSec: leading.fadeInSec, fadeOutSec: trailing.fadeOutSec };
  const boundary = trailing.startTimelineSec;
  // A split lands on an analysis frame, so the recipe cuts the merged clip back at the former boundary only
  // where that boundary lies on one (PROTOCOL.md section 15.2 rule 8).
  const boundaryFrames = trailing.clipInContentSec / HOP_SEC;
  const splitsBack = Math.abs(boundaryFrames - Math.round(boundaryFrames)) < 1e-6;
  const dirtyBefore = world.project.dirty;
  if (dryRun) {
    return envelope(world, {
      applied: false,
      noOp: false,
      dryRun: true,
      changes: [
        {
          entity: 'placement',
          ref: { placementId: leading.id },
          label: clipLabel(leading.serial, leading.trackId),
          fields: {
            durationSec: { before: leading.durationSec, after: duration, unit: 'sec' },
            ...(differs(mergedFades.fadeInSec, leading.fadeInSec)
              ? { fadeInSec: { before: leading.fadeInSec, after: mergedFades.fadeInSec, unit: 'sec' } }
              : {}),
            ...(differs(mergedFades.fadeOutSec, leading.fadeOutSec)
              ? { fadeOutSec: { before: leading.fadeOutSec, after: mergedFades.fadeOutSec, unit: 'sec' } }
              : {}),
          },
        },
      ],
      diff: EMPTY_DIFF,
      contents: [],
      placements: [leading, trailing],
      undo: null,
      dirtyBefore,
    });
  }
  const before = world.capture();
  const merged = world.addPlacement({
    content,
    name: leading.name,
    trackId: leading.trackId,
    startTimelineSec: leading.startTimelineSec,
    durationSec: duration,
    clipInContentSec: leading.clipInContentSec,
    gainLinear: leading.gainLinear,
    fadeInSec: mergedFades.fadeInSec,
    fadeOutSec: mergedFades.fadeOutSec,
    reference: leading.reference,
  });
  const removed = [clipItem(leading), clipItem(trailing)];
  world.removePlacement(leading);
  world.removePlacement(trailing);
  for (const other of world.placements.values()) {
    if (other.reference === leading || other.reference === trailing) other.reference = merged;
  }
  world.touchArrangement();
  pushUnsafeEntry(world, 'clipMerge', 'Merge clips', 'mergeClips', [merged.trackId]);
  world.markDirty();
  const diff = world.diff(before, world.capture());
  return envelope(world, {
    applied: true,
    noOp: false,
    created: [clipItem(merged)],
    removed,
    idMap: [
      {
        entity: 'placement',
        relation: 'merge',
        from: [{ placementId: leading.id }, { placementId: trailing.id }],
        to: [{ placementId: merged.id }],
      },
    ],
    diff,
    contents: [],
    placements: [merged],
    undo: {
      undoable: false,
      reason: 'upstream_undo_defect',
      revert: splitsBack
        ? {
            method: 'arrangement.edit',
            params: {
              expectedArrangementRevision: world.arrangement,
              ops: [{ op: 'split', placementId: merged.id, atTimelineSec: boundary }],
            },
          }
        : null,
    },
    dirtyBefore,
    warnings: [
      warning('UPSTREAM_UNDO_DEFECT', subjectOf(leading)),
      ...(splitsBack ? [] : [warning('IRREVERSIBLE', subjectOf(leading))]),
    ],
  });
}

// delete ---------------------------------------------------------------------------------------------

function deleteClips(context: MethodContext, op: Op, params: Readonly<Record<string, unknown>>) {
  const { world } = context;
  const doomed = (op.placementIds as string[]).map((id) => world.placement(id));
  const dryRun = params.dryRun === true;
  if (!dryRun && params.confirm !== true) {
    throw refuse(
      'INVALID_ARGUMENT',
      'confirm_required',
      'deleting clips cannot be undone; the end user must agree, then the call carries confirm true',
    );
  }
  const unlinked = [...world.placements.values()].filter(
    (p) => !doomed.includes(p) && p.reference !== null && doomed.includes(p.reference),
  );
  const changes = unlinked.map((p) => ({
    entity: 'placement',
    ref: { placementId: p.id },
    label: clipLabel(p.serial, p.trackId),
    fields: { referencePlacementId: { before: p.reference?.id ?? null, after: null, unit: null } },
  }));
  // A content that no other clip shows leaves the project with the clips (section 14.4 rule 6).
  const removed = [...doomed.map(clipItem), ...leavingContents(world, doomed)];
  const dirtyBefore = world.project.dirty;
  if (dryRun) {
    return envelope(world, {
      applied: false,
      noOp: false,
      dryRun: true,
      changes,
      removed,
      diff: EMPTY_DIFF,
      contents: [],
      placements: unlinked,
      undo: null,
      dirtyBefore,
    });
  }
  const before = world.capture();
  const tracks = [...new Set(doomed.map((p) => p.trackId))];
  for (const placement of doomed) world.removePlacement(placement);
  for (const placement of unlinked) placement.reference = null;
  world.touchArrangement();
  pushUnsafeEntry(world, 'clipDelete', 'Delete clips', 'deleteClips', tracks);
  world.markDirty();
  const diff = world.diff(before, world.capture());
  return envelope(world, {
    applied: true,
    noOp: false,
    changes,
    removed,
    diff,
    contents: [],
    placements: unlinked,
    undo: { undoable: false, reason: 'upstream_undo_defect', revert: null },
    dirtyBefore,
    warnings: [
      warning('UPSTREAM_UNDO_DEFECT', doomed[0] === undefined ? null : subjectOf(doomed[0])),
      warning('IRREVERSIBLE', doomed[0] === undefined ? null : subjectOf(doomed[0])),
    ],
  });
}

// the handlers -----------------------------------------------------------------------------------------

const edit: Handler = (context) => {
  const { world, params } = context;
  const ops = params.ops as Op[];
  resolveHandles(world, ops);
  checkNotBusy(context);
  const first = ops[0];
  if (first?.op === 'split') requireReady(world.placement(String(first.placementId)).content);
  checkRevision(world, params.expectedArrangementRevision);
  const dryRun = params.dryRun === true;
  if (first?.op === 'split') return split(context, first, dryRun);
  if (first?.op === 'merge') return merge(context, first, dryRun);
  if (first?.op === 'delete') return deleteClips(context, first, params);
  return editClips(context, ops, dryRun);
};

const copy: Handler = (context) => {
  const { world, params } = context;
  const sources = (params.sources as { placementId: string }[]).map((s) => world.placement(s.placementId));
  const toTrackId = params.toTrackId as number;
  trackSlot(world, toTrackId);
  checkNotBusy(context);
  checkRevision(world, params.expectedArrangementRevision);
  const mode = params.mode as 'window' | 'full';
  const origin = Math.min(...sources.map((s) => s.startTimelineSec));
  const dirtyBefore = world.project.dirty;
  const before = world.capture();
  const revealed = world.revealThrough(toTrackId);
  const copies = sources.map((source) => ({
    source,
    copy: copyPlacement(world, source, {
      trackId: toTrackId,
      startTimelineSec: (params.startTimelineSec as number) + (source.startTimelineSec - origin),
      mode,
    }),
  }));
  world.touchArrangement();
  world.markDirty();
  const fresh = copies.map((c) => c.copy);
  const warnings: unknown[] = [];
  for (const { source, copy: made } of copies) {
    const stacked = Math.abs(made.startTimelineSec - source.startTimelineSec) < TOLERANCE;
    if (stacked) warnings.push(warning('STACKED_ON_SOURCE', subjectOf(made)));
    if (overlapsOther(world, made, [...fresh, ...(stacked ? [source] : [])])) {
      warnings.push(warning('OVERLAPS_CLIP', subjectOf(made)));
    }
  }
  const reveal = revealEffects(revealed);
  const diff = world.diff(before, world.capture());
  const contents = [...new Set(fresh.map((p) => p.content))];
  return envelope(world, {
    applied: true,
    noOp: isEmptyDiff(diff),
    created: [
      ...fresh.map(clipItem),
      ...contents.map((c) => ({ entity: 'content', ref: { contentId: c.id }, label: `Content ${String(c.objectId)}` })),
    ],
    idMap: copies.map(({ source, copy: made }) => ({
      entity: 'placement',
      relation: 'copy',
      from: [{ placementId: source.id }],
      to: [{ placementId: made.id }],
    })),
    diff,
    contents,
    placements: fresh,
    undo: {
      undoable: false,
      reason: 'ui_parity',
      revert: {
        method: 'arrangement.edit',
        params: {
          expectedArrangementRevision: world.arrangement,
          ops: [{ op: 'delete', placementIds: fresh.map((p) => p.id) }],
        },
        requiresConsent: true,
      },
    },
    dirtyBefore,
    sideEffects: reveal.sideEffects,
    warnings: [...warnings, ...reveal.warnings],
  });
};

export const arrangementHandlers: Readonly<Record<string, Handler>> = {
  'arrangement.edit': edit,
  'arrangement.copy': copy,
};
