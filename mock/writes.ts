// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// What the content writes of the mock (edit.v1 and timing.v1) have in common: the readiness gate
// and the token checks in the order of spec/otcp/v1/PROTOCOL.md section 13.1 rule 4, committing a
// change to a content together with its undo entry, and the write results of a call that changes
// nothing or only predicts (section 14.2).

import { envelope, type MethodContext } from './context.js';
import { MockError } from './errors.js';
import { snapOf } from './history.js';
import type { ContentRec, HistoryEntry, RevisionDiff, World } from './model.js';

/** Hint for the retry of a write that found the content not ready yet. */
const NOT_READY_RETRY_MS = 500;

export const EMPTY_DIFF: RevisionDiff = { arrangement: null, trackState: null, contents: [] };

/** Section 11: a content write waits for the pitch analysis; reads are never gated. */
export function requireReady(content: ContentRec): void {
  const state = {
    running: { reason: 'f0_not_ready', retryable: true, detail: 'pitch analysis of the content is still running' },
    failed: { reason: 'f0_failed', retryable: false, detail: 'pitch analysis of the content failed' },
    unvoiced: { reason: 'f0_empty', retryable: false, detail: 'pitch analysis found no voiced frame in the content' },
    ready: undefined,
  }[content.analysis];
  if (state === undefined) return;
  throw new MockError({
    kind: 'NOT_READY',
    reason: state.reason,
    detail: state.detail,
    retryable: state.retryable,
    ...(state.retryable ? { retryAfterMs: NOT_READY_RETRY_MS } : {}),
  });
}

const conflict = (reason: string, detail: string) =>
  new MockError({ kind: 'REVISION_CONFLICT', reason, detail, retryable: false });

/** Section 10 rule 3: an expected token that is not the current one fails with the reason of its aspect. */
export function expectRevision(content: ContentRec, expected: unknown): void {
  if (expected !== content.revision) throw conflict('content_changed', 'the content changed since expectedRevision');
}

export function expectGridRevision(content: ContentRec, expected: unknown): void {
  if (expected !== content.comp.grid)
    throw conflict('grid_changed', 'the time grid changed since expectedGridRevision');
}

export function expectKeyRevision(content: ContentRec, expected: unknown): void {
  if (expected !== content.comp.key) throw conflict('key_changed', 'the key changed since expectedKeyRevision');
}

/** The undo entry a change records: what the UI's history would show for the same edit. */
export interface UndoInfo {
  readonly action: string;
  readonly description: string;
  readonly innerActions: readonly string[];
}

export const sideEffectsOfRender = (contents: readonly ContentRec[]): Record<string, unknown> =>
  contents.length === 0 ? {} : { reRenderQueued: { contentIds: contents.map((c) => c.id), revert: null } };

export interface Commit {
  readonly diff: RevisionDiff;
  readonly undo: unknown;
  readonly dirtyBefore: boolean;
  readonly sideEffects: Record<string, unknown>;
}

/**
 * Applies `mutate` to the content and settles what follows from it: the revision diff, the undo
 * entry (or the descriptor of a change without one), rendering queued again, and the project
 * marked as changed. A new entry ends the redo history, as a new edit does in the UI.
 */
export function commit(
  world: World,
  content: ContentRec,
  options: {
    mutate: () => void;
    undo: UndoInfo | { readonly notUndoable: unknown };
    rerender: boolean;
  },
): Commit {
  const dirtyBefore = world.project.dirty;
  const before = world.capture();
  const snapBefore = snapOf(content);
  options.mutate();
  if (options.rerender) world.queueRender(content);
  let undo: unknown;
  if ('notUndoable' in options.undo) {
    undo = options.undo.notUndoable;
  } else {
    const { seq, undoId } = world.nextUndoId();
    const { action, description, innerActions } = options.undo;
    const entry: HistoryEntry = {
      seq,
      origin: 'control',
      action,
      description,
      innerActions: [...innerActions],
      undoPatch: { content: { objectId: content.objectId, snap: snapBefore } },
      redoPatch: { content: { objectId: content.objectId, snap: snapOf(content) } },
      possiblyStale: false,
      unsafe: false,
    };
    world.undoStack.push(entry);
    world.redoStack = [];
    undo = { undoable: true, undoId, description, innerActions: [...innerActions], steps: 1 };
  }
  world.markDirty();
  return {
    diff: world.diff(before, world.capture()),
    undo,
    dirtyBefore,
    sideEffects: options.rerender ? sideEffectsOfRender([content]) : {},
  };
}

/** A call that succeeds without changing anything (section 14.2, second row). */
export function noOpResult(
  { world }: MethodContext,
  content: ContentRec,
  extra: Record<string, unknown> = {},
  warnings: readonly unknown[] = [],
) {
  return envelope(world, {
    applied: true,
    noOp: true,
    diff: EMPTY_DIFF,
    contents: [content],
    undo: { undoable: false, reason: 'no_op', revert: null },
    dirtyBefore: world.project.dirty,
    warnings,
    extra,
  });
}

/** A prediction (section 14.2, third row): the changes it lists are not applied. */
export function predictionResult(
  { world }: MethodContext,
  content: ContentRec,
  init: {
    changes: readonly unknown[];
    created?: readonly unknown[];
    removed?: readonly unknown[];
    warnings?: readonly unknown[];
    extra?: Record<string, unknown>;
  },
) {
  return envelope(world, {
    applied: false,
    noOp: false,
    dryRun: true,
    changes: init.changes,
    ...(init.created === undefined ? {} : { created: init.created }),
    ...(init.removed === undefined ? {} : { removed: init.removed }),
    diff: EMPTY_DIFF,
    contents: [content],
    undo: null,
    dirtyBefore: world.project.dirty,
    ...(init.warnings === undefined ? {} : { warnings: init.warnings }),
    ...(init.extra === undefined ? {} : { extra: init.extra }),
  });
}

/** The result of a call that hands its work to a job (section 14.2, fourth row). */
export function jobResult(
  { world }: MethodContext,
  content: ContentRec,
  job: { jobId: string; kind: string; state: string },
  extra: Record<string, unknown> = {},
) {
  return envelope(world, {
    applied: false,
    noOp: false,
    diff: EMPTY_DIFF,
    contents: [content],
    undo: null,
    dirtyBefore: world.project.dirty,
    job: { jobId: job.jobId, kind: job.kind, state: job.state },
    extra,
  });
}

export const round = (value: number): number => Math.round(value * 1e6) / 1e6;
