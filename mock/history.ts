// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The undo and redo history of the mock and its three methods: edit.getHistory, edit.undo and
// edit.redo (spec/otcp/v1/PROTOCOL.md sections 15.3 and 15.4). An entry holds the state an undo
// and a redo step put back, so applying it changes the project for real and the world revision
// vector shows what changed.

import { checkNotBusy, contentLabel, envelope, isEmptyDiff, placementLabel, type Handler } from './context.js';
import { refuse } from './errors.js';
import {
  clone,
  sameJson,
  type ContentRec,
  type ContentSnap,
  type HistoryEntry,
  type Patch,
  type PlacementRec,
  type World,
} from './model.js';

export const snapOf = (content: ContentRec): ContentSnap => ({
  notes: clone(content.notes),
  key: clone(content.key),
  pitchShift: clone(content.pitchShift),
  handles: clone(content.handles),
});

export function entryView(world: World, entry: HistoryEntry) {
  return {
    undoId: entry.seq === null ? null : world.undoIdOf(entry.seq),
    description: entry.description,
    origin: entry.origin,
    possiblyStale: entry.possiblyStale,
    unsafe: entry.unsafe,
  };
}

/** The tops and sizes of both histories (`common.schema.json#/$defs/history`). */
export function historyView(world: World) {
  const top = (stack: readonly HistoryEntry[]) => {
    const entry = stack.at(-1);
    return entry === undefined ? null : entryView(world, entry);
  };
  return {
    canUndo: world.undoStack.length > 0,
    canRedo: world.redoStack.length > 0,
    undoCount: world.undoStack.length,
    redoCount: world.redoStack.length,
    undoTop: top(world.undoStack),
    redoTop: top(world.redoStack),
  };
}

interface Effect {
  changes: unknown[];
  contents: ContentRec[];
  placements: PlacementRec[];
  /** Contents whose sound changes, so that rendering is queued again. */
  rerender: ContentRec[];
}

/** Puts a patch back and describes what it changed (section 14.3). */
function applyPatch(world: World, patch: Patch | null): Effect {
  const effect: Effect = { changes: [], contents: [], placements: [], rerender: [] };
  if (patch?.content !== undefined) {
    const content = world.contents.get(patch.content.objectId);
    if (content !== undefined) restore(world, content, patch.content.snap, effect);
  }
  if (patch?.placement !== undefined) {
    const placement = world.placements.get(patch.placement.serial);
    const to = patch.placement.startTimelineSec;
    if (placement !== undefined && placement.startTimelineSec !== to) {
      const from = placement.startTimelineSec;
      placement.startTimelineSec = to;
      world.touchGeometry(placement);
      effect.placements.push(placement);
      effect.changes.push({
        entity: 'placement',
        ref: { placementId: placement.id },
        label: placementLabel(world, placement),
        fields: { startTimelineSec: { before: from, after: to, unit: 'sec' } },
      });
    }
  }
  return effect;
}

function restore(world: World, content: ContentRec, snap: ContentSnap, effect: Effect): void {
  const ref = { contentId: content.id };
  const label = contentLabel(content);
  const touched = () => {
    if (!effect.contents.includes(content)) effect.contents.push(content);
  };
  if (!sameJson(content.notes, snap.notes)) {
    const before = content.revision;
    content.notes = clone(snap.notes);
    world.touch(content, 'notes', 'pitch');
    effect.changes.push({
      entity: 'content',
      ref,
      label,
      fields: { revision: { before, after: content.revision, unit: null } },
    });
    effect.rerender.push(content);
    touched();
  }
  if (!sameJson(content.key, snap.key)) {
    const before = content.key;
    content.key = clone(snap.key);
    world.touch(content, 'key');
    effect.changes.push({
      entity: 'key',
      ref,
      label,
      fields: {
        root: { before: before?.root ?? null, after: snap.key?.root ?? null, unit: null },
        scale: { before: before?.scale ?? null, after: snap.key?.scale ?? null, unit: null },
      },
    });
    touched();
  }
  if (!sameJson(content.pitchShift, snap.pitchShift)) {
    const before = content.pitchShift;
    content.pitchShift = clone(snap.pitchShift);
    world.touch(content, 'pitchShift');
    const fields: Record<string, unknown> = {};
    if (before.semitones !== snap.pitchShift.semitones) {
      fields.semitones = { before: before.semitones, after: snap.pitchShift.semitones, unit: 'semitones' };
    }
    if (before.cents !== snap.pitchShift.cents) {
      fields.cents = { before: before.cents, after: snap.pitchShift.cents, unit: 'cents' };
    }
    effect.changes.push({ entity: 'pitchShift', ref, label, fields });
    effect.rerender.push(content);
    touched();
  }
  if (!sameJson(content.handles, snap.handles)) {
    const before = content.handles;
    const gridRevision = content.comp.grid;
    content.handles = clone(snap.handles);
    world.touch(content, 'grid');
    const same =
      before.length === snap.handles.length && before.every((h, i) => h.handleId === snap.handles[i]?.handleId);
    if (same) {
      for (const [i, handle] of snap.handles.entries()) {
        const old = before[i];
        if (old !== undefined && old.outputSec !== handle.outputSec) {
          effect.changes.push({
            entity: 'timeHandle',
            ref: { ...ref, handleId: handle.handleId },
            label: `Handle at ${handle.contentSec.toFixed(2)} s`,
            fields: { outputSec: { before: old.outputSec, after: handle.outputSec, unit: 'sec' } },
          });
        }
      }
    } else {
      effect.changes.push({
        entity: 'content',
        ref,
        label,
        fields: { gridRevision: { before: gridRevision, after: content.comp.grid, unit: null } },
      });
    }
    effect.rerender.push(content);
    touched();
  }
}

/** edit.undo and edit.redo (section 15.3). */
function step(kind: 'undo' | 'redo'): Handler {
  return (context) => {
    const { world, params } = context;
    checkNotBusy(context);
    const stack = kind === 'undo' ? world.undoStack : world.redoStack;
    const other = kind === 'undo' ? world.redoStack : world.undoStack;
    const top = stack.at(-1);
    const force = params.force === true;
    if (top === undefined) throw refuse('UNDO_CONFLICT', 'history_empty', `there is nothing to ${kind}`);
    if (!force && (top.seq === null || world.undoIdOf(top.seq) !== params.expectedUndoId)) {
      throw refuse('UNDO_CONFLICT', 'top_mismatch', `the entry on top of the ${kind} history is not the expected one`);
    }
    if (top.unsafe) {
      throw refuse(
        'UNSUPPORTED',
        'undo_unsafe_build',
        `the top entry is a clip split, merge or delete, which is not ${kind === 'undo' ? 'undone' : 'redone'}`,
      );
    }
    if (!force && top.possiblyStale && top.origin === 'control') {
      throw refuse('UNDO_CONFLICT', 'stale_entry', 'a track was deleted after the entry was recorded');
    }

    const dirtyBefore = world.project.dirty;
    const before = world.capture();
    const effect = applyPatch(world, kind === 'undo' ? top.undoPatch : top.redoPatch);
    for (const content of new Set(effect.rerender)) world.queueRender(content);
    stack.pop();
    top.seq ??= world.nextUndoId().seq;
    const warnings: unknown[] = [];
    if (top.possiblyStale) {
      if (force) top.possiblyStale = false;
      else warnings.push({ code: 'UNDO_ENTRY_POSSIBLY_STALE', subject: null, data: null });
    }
    other.push(top);
    // The step is used up and the project marked as changed, whether or not anything changed.
    world.markDirty();
    const diff = world.diff(before, world.capture());
    const noOp = isEmptyDiff(diff);
    if (noOp) warnings.push({ code: 'UNDO_NO_EFFECT', subject: null, data: null });
    const undoId = world.undoIdOf(top.seq);
    const reRender = [...new Set(effect.rerender)];
    return envelope(world, {
      applied: true,
      noOp,
      changes: noOp ? [] : effect.changes,
      diff,
      contents: effect.contents,
      placements: effect.placements,
      undo: {
        undoable: false,
        reason: 'ui_parity',
        revert: { method: kind === 'undo' ? 'edit.redo' : 'edit.undo', params: { expectedUndoId: undoId } },
      },
      dirtyBefore,
      sideEffects:
        reRender.length === 0 ? {} : { reRenderQueued: { contentIds: reRender.map((c) => c.id), revert: null } },
      warnings,
      extra: { entry: entryView(world, top) },
    });
  };
}

export const historyHandlers: Readonly<Record<string, Handler>> = {
  'edit.getHistory': ({ world }) => ({
    asOf: world.asOf([]),
    derived: [],
    history: historyView(world),
  }),
  'edit.undo': step('undo'),
  'edit.redo': step('redo'),
};
