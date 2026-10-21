// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Reference alignment of the mock (capability reference.v1): content.analyzeReference, and the
// alignment that AUTO in mode reference makes (spec/otcp/v1/methods/content.analyzeReference.schema.json).
// The alignment data is derived from the audio: computing it changes no edit and has no undo
// entry. AUTO in mode reference then pulls the notes of a clip to the notes of the clip it is
// bound to, as one undo step.

import type { Handler } from './context.js';
import { MockError, refuse } from './errors.js';
import type { JobDriver } from './jobs.js';
import type { NoteRec, PlacementRec, World } from './model.js';
import { medianDetected } from './music.js';
import { requireReady } from './writes.js';

/** Time the mock takes to compute the alignment data of a clip and the clip it refers to. */
export const ALIGNMENT_STEP_MS = 40;

/** The wait limit of a referenceAnalysis job of the mock (PROTOCOL.md section 12.6): an analysis still running ends the job then. */
export const REFERENCE_WAIT_LIMIT_MS = 30_000;

/** A clip that has a reference binding, and the clip it refers to. */
export function boundReference(placement: PlacementRec): PlacementRec {
  if (placement.reference === null) {
    throw refuse('INVALID_ARGUMENT', 'reference_not_bound', 'the placement has no reference binding');
  }
  return placement.reference;
}

/** Both clips need a finished pitch analysis (section 11). */
export function requireReadyPair(placement: PlacementRec, reference: PlacementRec): void {
  requireReady(placement.content);
  requireReady(reference.content);
}

/**
 * The ways in which OpenTune's reference analysis does not complete (reasons reference_analysis_stalled,
 * reference_analysis_timeout and reference_analysis_failed of registry/reasons.json).
 */
function analysisFault(fault: NonNullable<World['referenceFault']>): MockError {
  switch (fault) {
    case 'stalled':
      return new MockError({
        kind: 'NOT_READY',
        reason: 'reference_analysis_stalled',
        detail: 'OpenTune completes one reference analysis per session; restart OpenTune to analyse again',
        retryable: false,
      });
    case 'timeout':
      return refuse('NOT_READY', 'reference_analysis_timeout', 'the reference analysis did not finish in time');
    case 'failed':
      return refuse('ANALYSIS_FAILED', 'reference_analysis_failed', 'the reference analysis failed');
  }
}

/** Whether the clip or the clip it refers to has no alignment data yet. */
function isMissing(placement: PlacementRec, reference: PlacementRec): boolean {
  return [placement.content, reference.content].some((content) => !content.alignmentReady);
}

/** Stores the alignment data of the clip and of the clip it refers to. */
export function computeAlignment(world: World, placement: PlacementRec, reference: PlacementRec): void {
  const missing = isMissing(placement, reference);
  if (missing && world.referenceFault !== null) throw analysisFault(world.referenceFault);
  for (const content of new Set([placement.content, reference.content])) {
    if (content.alignmentReady) continue;
    content.alignmentReady = true;
    world.touch(content, 'reference');
  }
}

/** The span of a note on the timeline as the clip shows it. */
function timelineSpan(world: World, placement: PlacementRec, note: NoteRec): [number, number] {
  const { content } = placement;
  const origin = placement.startTimelineSec - world.contentToOutput(content, placement.clipInContentSec);
  return [
    origin + world.contentToOutput(content, note.startContentSec),
    origin + world.contentToOutput(content, note.endContentSec),
  ];
}

/** The pitch of the reference clip over a span of the timeline, from its detected pitch (its content time, clamped to its audio). */
function referencePitch(world: World, reference: PlacementRec, start: number, end: number): number | null {
  const { content } = reference;
  const origin = reference.startTimelineSec - world.contentToOutput(content, reference.clipInContentSec);
  const from = Math.min(Math.max(0, world.outputToContent(content, start - origin)), content.durationSec);
  const to = Math.min(Math.max(from, world.outputToContent(content, end - origin)), content.durationSec);
  return medianDetected(content.durationSec, from, to);
}

/**
 * The notes of the clip after alignment: each note takes the target of the note of the reference
 * clip that sounds at the same time on the timeline, or of the nearest one; a reference clip with
 * no notes gives its detected pitch over the span of the note. A note the reference has no pitch
 * for keeps its target.
 */
export function alignedNotes(world: World, placement: PlacementRec, reference: PlacementRec): NoteRec[] {
  const spans = reference.content.notes.map((note) => ({
    target: note.targetMidi,
    span: timelineSpan(world, reference, note),
  }));
  return placement.content.notes.map((note) => {
    const [start, end] = timelineSpan(world, placement, note);
    const middle = (start + end) / 2;
    const distance = ({ span }: (typeof spans)[number]) =>
      middle < span[0] ? span[0] - middle : middle > span[1] ? middle - span[1] : 0;
    const nearest = spans.reduce<(typeof spans)[number] | undefined>(
      (best, candidate) => (best === undefined || distance(candidate) < distance(best) ? candidate : best),
      undefined,
    );
    const target = nearest === undefined ? referencePitch(world, reference, start, end) : nearest.target;
    return target === null ? { ...note } : { ...note, targetMidi: Math.round(target * 1e6) / 1e6, offsetCents: 0 };
  });
}

/**
 * A driver that computes the alignment data in two steps (so that the job is running for a
 * moment and can be cancelled before it stores anything), then calls `commit`, whose result ends
 * the job. A job cancelled before the second step discards the analysis (section 12.3).
 *
 * Section 12.6 rule 2: where the mock knows that the analysis cannot complete (fault `stalled`) the
 * job ends at once, without waiting; where the analysis is still running (fault `timeout`) the job
 * waits for the wait limit before it ends.
 */
export function alignmentDriver(
  world: World,
  pair: () => readonly [PlacementRec, PlacementRec | null],
  commit: () => Record<string, unknown>,
): JobDriver {
  let started = false;
  let waited = false;
  const faulty = (fault: World['referenceFault']): boolean => {
    const [placement, reference] = pair();
    if (reference === null) return false;
    return world.referenceFault === fault && isMissing(placement, reference);
  };
  return (control) => {
    if (control.cancelRequested) return { done: { state: 'cancelled' } };
    if (!started) {
      started = true;
      control.progress({ fraction: 0.5, phase: 'alignment' });
      return { next: faulty('stalled') ? 0 : ALIGNMENT_STEP_MS };
    }
    if (!waited && faulty('timeout')) {
      waited = true;
      return { next: REFERENCE_WAIT_LIMIT_MS - ALIGNMENT_STEP_MS };
    }
    try {
      return { done: { state: 'succeeded', result: commit() } };
    } catch (error) {
      // A check that the work repeats failed: the job ends with that check's error (NOT_FOUND,
      // INVALID_ARGUMENT, NOT_READY or, for content.autoTune, BUSY; x-otcp.jobErrors of both methods).
      if (error instanceof MockError) return { done: { state: 'failed', error: error.init } };
      throw error;
    }
  };
}

/** What the call checked can have changed while the job ran: the clips, their binding and the project. */
function recheckPair(world: World, placement: PlacementRec, reference: PlacementRec, epoch: number): void {
  if (world.epoch !== epoch || world.placements.get(placement.serial) !== placement) {
    throw refuse('NOT_FOUND', 'unknown_handle', 'the placement was removed before the job ran');
  }
  if (world.placements.get(reference.serial) !== reference || placement.reference !== reference) {
    throw refuse('INVALID_ARGUMENT', 'reference_not_bound', 'the reference binding changed before the job ran');
  }
  requireReadyPair(placement, reference);
}

const analyzeReference: Handler = ({ world, params, jobs }) => {
  const placement = world.placement(String(params.placementId));
  const reference = boundReference(placement);
  requireReadyPair(placement, reference);
  // A call for a clip whose analysis is still running returns that job (section 12.5).
  const joined = world.referenceJobs.get(placement.id);
  const running = joined === undefined ? undefined : jobs.get(joined);
  if (running?.finishedAtMs === null) {
    return { job: { jobId: running.jobId, kind: running.kind, state: running.state } };
  }
  const epoch = world.epoch;
  const job = jobs.start(
    { kind: 'referenceAnalysis' },
    alignmentDriver(
      world,
      () => [placement, reference],
      () => {
        recheckPair(world, placement, reference, epoch);
        computeAlignment(world, placement, reference);
        return {
          placementId: placement.id,
          referencePlacementId: reference.id,
          alignmentReady: placement.content.alignmentReady && reference.content.alignmentReady,
        };
      },
    ),
  );
  world.referenceJobs.set(placement.id, job.jobId);
  return { job: { jobId: job.jobId, kind: job.kind, state: job.state } };
};

export const referenceHandlers: Readonly<Record<string, Handler>> = {
  'content.analyzeReference': analyzeReference,
};
