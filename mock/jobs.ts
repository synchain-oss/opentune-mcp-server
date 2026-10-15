// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Jobs of the mock instance (spec/otcp/v1/PROTOCOL.md section 12): sequential job ids, job.get
// long polls, job.cancel with asynchronous cancellation, and retention. Jobs belong to the
// instance, not to a session.

import type { OtcpSpec } from '../test/support/otcp-spec.js';
import type { Clock, Timer } from './clock.js';
import { refuse } from './errors.js';
import { makeError, type ErrorInit, type ErrorObject } from './protocol.js';

export const JOB_RETENTION_MS = 1_800_000;
export const JOB_RETENTION_COUNT = 64;

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

const TERMINAL: ReadonlySet<JobState> = new Set(['succeeded', 'failed', 'cancelled']);

export interface JobProgress {
  readonly fraction: number | null;
  readonly phase: string | null;
  readonly itemsDone: number | null;
  readonly itemsTotal: number | null;
}

/** The job object of common.schema.json#/$defs/job. */
export interface JobView {
  readonly jobId: string;
  readonly kind: string;
  readonly state: JobState;
  readonly cancellable: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly finishedAtMs: number | null;
  readonly progress: JobProgress;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly error: ErrorObject | null;
}

/** How a job driven by the store ends. A failed or cancelled job may carry the work it committed. */
export type JobOutcome =
  | { readonly state: 'succeeded'; readonly result: Readonly<Record<string, unknown>> }
  | { readonly state: 'failed'; readonly error: ErrorInit; readonly result?: Readonly<Record<string, unknown>> }
  | { readonly state: 'cancelled'; readonly result?: Readonly<Record<string, unknown>> };

/** What a driver does in one step: ask to be called again after `next` ms, or end the job. */
export type JobStep = { readonly next: number } | { readonly done: JobOutcome };

/** What a driver sees and can change while it runs. */
export interface JobControl {
  /** Cancellation was requested; the driver stops at this cancellation point (section 12.3). */
  readonly cancelRequested: boolean;
  progress(update: Partial<JobProgress>): void;
}

/** One step of a job, called on the "main thread" by the clock; steps never overlap. */
export type JobDriver = (control: JobControl) => JobStep;

interface JobRecord {
  view: JobView;
  cancelRequested: boolean;
  readonly waiters: Set<() => void>;
  driver?: JobDriver | undefined;
  timer?: Timer | undefined;
  /** Called when the store stops with the job unfinished. */
  onDispose?: (() => void) | undefined;
}

export interface JobSpec {
  readonly kind: string;
  readonly state: JobState;
  readonly cancellable: boolean;
  readonly error?: { readonly kind: string; readonly reason?: string };
}

/** A precondition the mock does not model yet; the runner reports the vector as skipped. */
export class UnsupportedPrecondition extends Error {}

/**
 * Results of succeeded jobs, by kind, valid against the starting method's `$defs.jobResult`. Kinds
 * missing here cannot be set up in a terminal state yet.
 */
const TERMINAL_RESULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  export: {
    path: 'C:\\Music\\take1 (tuned).wav',
    sampleRateHz: 44100,
    channelCount: 2,
    sampleFormat: 'float32',
    durationSec: 10,
    startTimelineSec: 0,
    dryContents: [],
    processing: {
      vocoderWeight: null,
      hybridMode: false,
      backend: null,
      tuningHz: 440,
      nullReasons: { vocoderWeight: 'unavailable', backend: 'unavailable' },
    },
  },
};

const progressOf = (state: JobState): JobProgress => ({
  fraction: state === 'queued' ? 0 : state === 'succeeded' ? 1 : state === 'running' ? 0.5 : null,
  phase: null,
  itemsDone: null,
  itemsTotal: null,
});

export class JobStore {
  readonly #jobs = new Map<string, JobRecord>();
  #seq = 0;

  constructor(
    private readonly spec: OtcpSpec,
    private readonly clock: Clock,
    /** First 8 characters of the instanceId (section 9). */
    private readonly instanceIdShort: string,
  ) {}

  /** Creates a job in the given state, as a `given.jobs` entry describes it. */
  add(spec: JobSpec): JobView {
    const now = this.clock.now();
    const terminal = TERMINAL.has(spec.state);
    let result: Readonly<Record<string, unknown>> | null = null;
    if (spec.state === 'succeeded') {
      result = TERMINAL_RESULTS[spec.kind] ?? null;
      if (result === null) throw new UnsupportedPrecondition(`the mock has no result for a succeeded ${spec.kind} job`);
    }
    let error: ErrorObject | null = null;
    if (spec.state === 'cancelled') error = this.#cancelledError();
    if (spec.state === 'failed') {
      error = makeError(this.spec, {
        kind: spec.error?.kind ?? 'INTERNAL',
        ...(spec.error?.reason === undefined ? {} : { reason: spec.error.reason }),
        detail: `the ${spec.kind} job failed`,
      });
    }
    const jobId = this.#reserve(now);
    const view: JobView = {
      jobId,
      kind: spec.kind,
      state: spec.state,
      cancellable: terminal ? false : spec.cancellable,
      createdAtMs: now,
      updatedAtMs: now,
      finishedAtMs: terminal ? now : null,
      progress: progressOf(spec.state),
      result,
      error,
    };
    this.#jobs.set(jobId, { view, cancelRequested: false, waiters: new Set() });
    return view;
  }

  /** Makes room for one more job (section 12.4) and returns its id; BUSY(job_limit) if every retained job is active. */
  #reserve(now: number): string {
    this.#evict(now, JOB_RETENTION_COUNT - 1);
    if (this.#jobs.size >= JOB_RETENTION_COUNT) {
      throw refuse('BUSY', 'job_limit', 'every retained job is still active', 1000);
    }
    return `j:${this.instanceIdShort}:${String(++this.#seq)}`;
  }

  /**
   * Starts a job that the store drives: queued now, then one step of `driver` after another on the
   * clock, the first right away. The job is running from its first step on.
   */
  start(
    spec: { readonly kind: string; readonly cancellable: boolean },
    driver: JobDriver,
    onDispose?: () => void,
  ): JobView {
    const now = this.clock.now();
    const jobId = this.#reserve(now);
    const view: JobView = {
      jobId,
      kind: spec.kind,
      state: 'queued',
      cancellable: spec.cancellable,
      createdAtMs: now,
      updatedAtMs: now,
      finishedAtMs: null,
      progress: progressOf('queued'),
      result: null,
      error: null,
    };
    const record: JobRecord = { view, cancelRequested: false, waiters: new Set(), driver, onDispose };
    this.#jobs.set(jobId, record);
    this.#schedule(record, 0);
    return view;
  }

  #schedule(record: JobRecord, ms: number): void {
    record.timer?.cancel();
    record.timer = this.clock.setTimer(ms, () => {
      record.timer = undefined;
      this.#step(record);
    });
  }

  #step(record: JobRecord): void {
    if (record.driver === undefined || TERMINAL.has(record.view.state)) return;
    if (record.view.state === 'queued') {
      record.view = {
        ...record.view,
        state: 'running',
        updatedAtMs: this.clock.now(),
        progress: progressOf('running'),
      };
    }
    const control: JobControl = {
      get cancelRequested() {
        return record.cancelRequested;
      },
      progress: (update) => {
        record.view = {
          ...record.view,
          updatedAtMs: this.clock.now(),
          progress: { ...record.view.progress, ...update },
        };
      },
    };
    let step: JobStep;
    try {
      step = record.driver(control);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unexpected failure';
      step = { done: { state: 'failed', error: { kind: 'INTERNAL', detail: `the job failed: ${detail}` } } };
    }
    if ('next' in step) this.#schedule(record, step.next);
    else this.#finish(record, step.done);
  }

  /** Moves a job to its terminal state and wakes everyone who waits for it. */
  #finish(record: JobRecord, outcome: JobOutcome): void {
    const now = this.clock.now();
    record.timer?.cancel();
    record.timer = undefined;
    record.driver = undefined;
    const progress = {
      ...progressOf(outcome.state),
      itemsDone: record.view.progress.itemsDone,
      itemsTotal: record.view.progress.itemsTotal,
    };
    record.view = {
      ...record.view,
      state: outcome.state,
      cancellable: false,
      updatedAtMs: now,
      finishedAtMs: now,
      progress,
      result: outcome.state === 'succeeded' ? outcome.result : (outcome.result ?? null),
      error:
        outcome.state === 'succeeded'
          ? null
          : outcome.state === 'cancelled'
            ? this.#cancelledError()
            : makeError(this.spec, outcome.error),
    };
    for (const waiter of [...record.waiters]) waiter();
  }

  /** Stops every pending step and wait; the store is not used afterwards. */
  dispose(): void {
    for (const record of this.#jobs.values()) {
      if (record.driver !== undefined) record.onDispose?.();
      record.timer?.cancel();
      record.timer = undefined;
      record.driver = undefined;
    }
  }

  /** A job of this kind exists that has not finished: for kind `export`, the export lock is held (section 13.2). */
  hasActive(kind: string): boolean {
    return [...this.#jobs.values()].some((r) => r.view.kind === kind && r.view.finishedAtMs === null);
  }

  get(jobId: string): JobView | undefined {
    this.#evict(this.clock.now(), JOB_RETENTION_COUNT);
    return this.#jobs.get(jobId)?.view;
  }

  /**
   * Calls `onDone` with the job once it is terminal or `waitMs` has elapsed (section 12.2).
   * Returns a function that drops the wait without calling `onDone`.
   */
  wait(jobId: string, waitMs: number, onDone: (job: JobView) => void): () => void {
    const record = this.#jobs.get(jobId);
    if (record === undefined || TERMINAL.has(record.view.state) || waitMs === 0) {
      if (record !== undefined) onDone(record.view);
      return () => undefined;
    }
    const finish = () => {
      timer.cancel();
      record.waiters.delete(finish);
      onDone(record.view);
    };
    record.waiters.add(finish);
    const timer: Timer = this.clock.setTimer(waitMs, finish);
    return () => {
      timer.cancel();
      record.waiters.delete(finish);
    };
  }

  /**
   * job.cancel (section 12.3). Returns undefined for an unknown job and 'not_cancellable' for a
   * job that cannot be cancelled now; otherwise whether cancellation is (or was) requested.
   */
  cancel(jobId: string): { cancelRequested: boolean; job: JobView } | 'not_cancellable' | undefined {
    const record = this.#jobs.get(jobId);
    if (record === undefined) return undefined;
    if (TERMINAL.has(record.view.state)) return { cancelRequested: false, job: record.view };
    if (record.cancelRequested) return { cancelRequested: true, job: record.view };
    if (!record.view.cancellable) return 'not_cancellable';
    record.cancelRequested = true;
    record.view = { ...record.view, cancellable: false, updatedAtMs: this.clock.now() };
    if (record.driver !== undefined) {
      // The driver stops at its next step, which comes right after the response.
      this.#schedule(record, 0);
      return { cancelRequested: true, job: record.view };
    }
    // The job reaches its next cancellation point right after the response.
    this.clock.setTimer(0, () => {
      const now = this.clock.now();
      record.view = {
        ...record.view,
        state: 'cancelled',
        updatedAtMs: now,
        finishedAtMs: now,
        progress: progressOf('cancelled'),
        error: this.#cancelledError(),
      };
      for (const waiter of [...record.waiters]) waiter();
    });
    return { cancelRequested: true, job: record.view };
  }

  #cancelledError(): ErrorObject {
    return makeError(this.spec, { kind: 'CANCELLED', reason: 'cancelled_by_request', detail: 'the job was cancelled' });
  }

  /**
   * Section 12.4: a terminal job leaves once its retention time has passed, or earlier, oldest
   * first, while more than `keep` jobs exist. Jobs that are not terminal never leave.
   */
  #evict(now: number, keep: number): void {
    const terminal = [...this.#jobs.values()]
      .filter((r) => r.view.finishedAtMs !== null)
      .sort((a, b) => (a.view.finishedAtMs ?? 0) - (b.view.finishedAtMs ?? 0));
    for (const record of terminal) {
      const expired = (record.view.finishedAtMs ?? 0) + JOB_RETENTION_MS <= now;
      if (!expired && this.#jobs.size <= keep) break;
      this.#jobs.delete(record.view.jobId);
    }
  }
}
