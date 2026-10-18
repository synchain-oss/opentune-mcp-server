// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The mock's only source of time. Timestamps and every protocol timeout (hello timeout, idle
// timeout, job.get waits) come from a Clock, so tests can replace real time with ManualClock and
// check waits and timeouts without sleeping (spec/otcp/v1/vectors/README.md, "Reproducibility").

export interface Timer {
  cancel(): void;
}

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Calls `callback` once, `ms` milliseconds from now. */
  setTimer(ms: number, callback: () => void): Timer;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimer(ms, callback) {
    const handle = setTimeout(callback, ms);
    return {
      cancel: () => {
        clearTimeout(handle);
      },
    };
  },
};

interface PendingTimer {
  readonly at: number;
  readonly seq: number;
  readonly callback: () => void;
}

/** A clock that only moves when the test calls advance(). Timers fire in time order, ties in creation order. */
export class ManualClock implements Clock {
  #now: number;
  #seq = 0;
  readonly #timers = new Set<PendingTimer>();

  constructor(startMs = 1_767_225_600_000) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  setTimer(ms: number, callback: () => void): Timer {
    const timer: PendingTimer = { at: this.#now + Math.max(0, ms), seq: this.#seq++, callback };
    this.#timers.add(timer);
    return {
      cancel: () => {
        this.#timers.delete(timer);
      },
    };
  }

  /** Moves time forward by `ms`, firing every timer that falls due on the way. */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let due: PendingTimer | undefined;
      for (const t of this.#timers) {
        if (t.at <= target && (due === undefined || t.at < due.at || (t.at === due.at && t.seq < due.seq))) due = t;
      }
      if (due === undefined) break;
      this.#timers.delete(due);
      this.#now = due.at;
      due.callback();
    }
    this.#now = target;
  }
}
