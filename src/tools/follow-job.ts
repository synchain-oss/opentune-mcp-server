// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Starting an OTCP method that hands its work to a job and waiting for it inside the same tool
// call (spec/otcp/v1/PROTOCOL.md section 12): the start result names the job, job.get waits up to
// the time the caller allows, and what the job did is rendered when it ended. When it has not
// ended, the result is the start envelope with the job id, so that the agent follows it with
// opentune_get_job.

import { errorDataFrom, fromOtcpError, type ToolError } from '../errors/tool-error.js';
import type { Json, OtcpSession } from '../otcp/client.js';
import { isObject } from '../render/changes.js';
import { token } from '../render/text.js';
import { MAX_WAIT_SECONDS } from './jobs.js';
import type { Outcome, ToolContext } from './registry.js';

export { MAX_WAIT_SECONDS };
/** The default wait inside one call; below the OTCP limit of 30 s so that the call returns first. */
export const DEFAULT_WAIT_SECONDS = 25;
export const START_TIMEOUT_MS = 15_000;
/** OTCP answers a job.get wait within waitMs + 1000 ms; this side allows a little more. */
export const WAIT_MARGIN_MS = 4000;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export interface Started {
  /** What the start method returned (a write envelope that names the job). */
  readonly started: Json;
  /** The job as last seen: after the wait, or as the start result named it. null when it names none. */
  readonly job: Json | null;
  /** Waiting for the job failed (the connection dropped, for example) although it was started. */
  readonly waitFailed: boolean;
}

/** Calls `method`, then waits up to `waitSeconds` for the job it started. */
export async function startAndWait(
  ctx: ToolContext,
  session: OtcpSession,
  method: string,
  params: Json,
  waitSeconds: number,
): Promise<Started> {
  const started = await session.call(method, params, START_TIMEOUT_MS);
  const named = isObject(started.job) ? started.job : null;
  const jobId = named === null ? null : token(named.jobId, 'jobId');
  const waitMs = Math.round(waitSeconds * 1000);
  if (jobId === null || waitMs <= 0) return { started, job: named, waitFailed: false };
  try {
    const answer = await session.call('job.get', { jobId, waitMs }, waitMs + WAIT_MARGIN_MS);
    return { started, job: isObject(answer.job) ? answer.job : named, waitFailed: false };
  } catch (error) {
    // The job is running whatever happened to the wait, so the call must not report a failure
    // that would say nothing was started.
    ctx.logger.warn(`waiting for job ${jobId} failed (${error instanceof Error ? error.message : 'unknown error'})`);
    return { started, job: named, waitFailed: true };
  }
}

export const jobState = (job: Json | null): string | null => (job === null ? null : token(job.state, 'camel'));

export const isTerminal = (job: Json | null): boolean => TERMINAL.has(jobState(job) ?? '');

/** The reference to the job that results carry: id, kind and state only; the result is rendered separately. */
export function jobRef(job: Json): Json {
  return { jobId: job.jobId ?? null, kind: job.kind ?? null, state: job.state ?? null };
}

/** The tool error for a job that failed, with the next step of its kind and reason. */
export function jobFailure(job: Json): Extract<Outcome, { ok: false }> {
  const data = errorDataFrom(job.error);
  const error: ToolError = fromOtcpError(data);
  return { ok: false, error, context: { job: jobRef(job) } };
}

/** The sentence added to the start summary (which already says to follow the job) when the wait ended early. */
export function followText(waitFailed: boolean): string {
  return waitFailed
    ? ' Waiting for the job failed, but the job itself is running.'
    : ' It was still running when the wait ended.';
}
