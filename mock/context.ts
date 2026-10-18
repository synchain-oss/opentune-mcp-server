// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// What a method handler of the mock gets, and the write envelope it answers a write with
// (spec/otcp/v1/PROTOCOL.md section 14).

import { refuse } from './errors.js';
import type { JobStore, JobView } from './jobs.js';
import type { ContentRec, PlacementRec, RevisionDiff, World } from './model.js';

export interface MethodContext {
  readonly world: World;
  readonly params: Readonly<Record<string, unknown>>;
  /** An export job holds the export lock (section 13.2). */
  readonly exportLock: boolean;
  /** The instance reports the capability now. */
  readonly hasCapability: (capability: string) => boolean;
  /** Removes the token, the server proof and the home directory from a line of text (section 20.2 rule 5). */
  readonly redact: (text: string) => string;
  /** Starts a job that runs `work` shortly and completes with its result. */
  readonly startJob: (kind: string, work: () => Record<string, unknown>) => JobView;
  /** For a job with steps of its own, and to look a job up. */
  readonly jobs: Pick<JobStore, 'start' | 'get'>;
}

/** Answers with the result, or throws a MockError. Runs "on the main thread": synchronously, one at a time. */
export type Handler = (context: MethodContext) => Record<string, unknown>;

/** A write is refused without waiting while the UI is busy (section 13.2). */
export function checkNotBusy({ world, exportLock }: MethodContext): void {
  const reason = world.busyReason(exportLock);
  if (reason !== undefined) {
    throw refuse('BUSY', reason, `the UI is busy: ${reason}`, 1000);
  }
}

export interface EnvelopeInit {
  applied: boolean;
  noOp: boolean;
  dryRun?: boolean;
  changes?: readonly unknown[];
  created?: readonly unknown[];
  removed?: readonly unknown[];
  idMap?: readonly unknown[];
  diff: RevisionDiff;
  /** The contents and placements whose tokens the write returns. */
  contents: readonly ContentRec[];
  placements?: readonly PlacementRec[];
  undo: unknown;
  dirtyBefore: boolean;
  sideEffects?: Record<string, unknown>;
  warnings?: readonly unknown[];
  job?: unknown;
  /** Method-specific members. */
  extra?: Record<string, unknown>;
}

export const isEmptyDiff = (diff: RevisionDiff): boolean =>
  diff.arrangement === null && diff.trackState === null && diff.contents.length === 0;

/** A write result with every member of the envelope (section 14.1), tokens read back now. */
export function envelope(world: World, init: EnvelopeInit): Record<string, unknown> {
  return {
    applied: init.applied,
    noOp: init.noOp,
    dryRun: init.dryRun ?? false,
    changes: init.changes ?? [],
    created: init.created ?? [],
    removed: init.removed ?? [],
    idMap: init.idMap ?? [],
    revisionDiff: init.diff,
    tokens: world.tokens(init.contents, init.placements ?? []),
    undo: init.undo,
    dirty: { before: init.dirtyBefore, after: world.project.dirty },
    ui: world.uiSnapshot(),
    sideEffects: init.sideEffects ?? {},
    warnings: init.warnings ?? [],
    job: init.job ?? null,
    ...init.extra,
  };
}

/** The undo descriptor of a change that creates no undo entry (section 15.1). */
export const notUndoable = (reason: string, revert: unknown = null) => ({ undoable: false, reason, revert });

/** Short display labels built from positions and values, never from names in files (section 20.2). */
export const contentLabel = (content: ContentRec): string => `Content ${String(content.objectId)}`;
export const placementLabel = (world: World, placement: PlacementRec): string =>
  `Clip ${String(placement.serial)} on ${world.trackLabel(placement.trackId)}`;
