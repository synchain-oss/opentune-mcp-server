// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// What the vector runner needs from the instance under test. The runner itself speaks only OTCP
// over TCP; a target supplies the instance, its discovery file and the `given` preconditions. The
// mock target is in mock-target.ts; a target for a running OpenTune reads the discovery directory,
// learns the capabilities from a session.hello of its own and sets up preconditions with
// preparatory calls.

/** What a target found out about the end of an instance. */
export interface EndReport {
  /** What is wrong with it: a process that did not exit, one that exited with a status other than 0, a discovery file still there. Empty when the end was clean. */
  readonly problems: readonly string[];
  /** What the target could not observe, for example the exit status of a process it did not start. */
  readonly notChecked: readonly string[];
}

export interface TargetInstance {
  /** The discovery file of the instance (PROTOCOL.md section 5.3). */
  readonly discovery: Readonly<Record<string, unknown>>;
  /** The MAJOR.MINOR the instance serves for major 1. */
  readonly protocol: string;
  /** The capabilities the instance reports before any precondition is established. */
  readonly capabilities: readonly string[];
  /**
   * Establishes a vector's `given` and returns the names it binds. Throws PreconditionUnavailable
   * when the target cannot establish it; the runner then skips the vector.
   */
  establish(given: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
  /** The value of a `runner.*` name that depends on the instance's state, or undefined if unknown. */
  runnerValue(name: string): unknown;
  /**
   * Reads what the `runner.*` values depend on, once the preconditions are established. The runner
   * calls it before it asks for those values; a target whose values do not depend on state has none.
   */
  prepareRunnerValues?(): Promise<void>;
  /**
   * Called when a vector with `endsSession` is done and the runner has seen that the connections closed
   * and the port accepts none. Waits up to `waitMs` for the instance to end by itself and reports what
   * the target can observe of how it ended. It does not end the instance itself. The target also takes
   * note that the end was asked for, so that close() does not count it as an instance that ended too
   * early. A target without it checks nothing of this, and the runner says so in the outcome.
   */
  expectEnded?(waitMs: number): Promise<EndReport>;
  /** Ends the instance, or detaches from it. */
  close(): Promise<void>;
}

export interface ContractTarget {
  readonly name: string;
  /** An instance for one vector, in its initial state, with no other client connected. */
  open(): Promise<TargetInstance>;
}

export class PreconditionUnavailable extends Error {}
