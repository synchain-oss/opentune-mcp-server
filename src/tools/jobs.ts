// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_get_job and opentune_cancel_job (spec/otcp/v1/PROTOCOL.md section 12). The job object is
// returned as OpenTune reports it; the summary uses only values checked against their protocol
// form (job id, kind, state, a number), never free text from the job.

import { z } from 'zod';

import { toolError } from '../errors/tool-error.js';
import type { Json, OtcpSession } from '../otcp/client.js';
import { trustedToken } from '../sanitize/untrusted.js';
import { defineTool, withInstance, type Outcome, type ToolContext } from './registry.js';

const JOB_ID_RE = /^j:[0-9a-f]{8}:[1-9][0-9]*$/;
const KIND_RE = /^[a-z][a-zA-Z0-9]{0,63}$/;
const ERROR_KIND_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const STATES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
/** Longest wait inside one call, the OTCP limit (jobWaitMaxMs). */
export const MAX_WAIT_SECONDS = 30;
/** How long opentune_cancel_job waits for a cancelled job to stop. */
const CANCEL_SETTLE_MS = 5000;
/** OTCP answers a job.get wait within waitMs + 1000 ms; this side allows a little more. */
const WAIT_MARGIN_MS = 4000;

/** What cancelling does, per job kind (section 12.3). */
export const CANCEL_EFFECT: Readonly<Record<string, string>> = {
  import: 'Items imported before the cancellation stay; job.result lists them with how to revert each.',
  export: 'The temporary file is deleted; the target path is not touched.',
  referenceAnalysis: 'The analysis is discarded.',
  timeGridSeed: 'No anchors are written.',
  projectOpen: 'The current project is untouched.',
};

const jobIdSchema = z.string().regex(JOB_ID_RE).describe('Job id from the result that started the job (j:...).');
const instanceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/)
  .optional()
  .describe('Instance that owns the job. Optional: the job id identifies it.');

interface JobFacts {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly terminal: boolean;
}

function facts(job: unknown): JobFacts | null {
  const j = (typeof job === 'object' && job !== null ? job : {}) as Json;
  const id = trustedToken(j.jobId, JOB_ID_RE);
  const state = typeof j.state === 'string' && STATES.has(j.state) ? j.state : null;
  if (id === null || state === null) return null;
  return { id, kind: trustedToken(j.kind, KIND_RE) ?? 'unknown', state, terminal: TERMINAL.has(state) };
}

/** One sentence about a job, from checked values only. */
export function jobSentence(job: unknown): string {
  const f = facts(job);
  if (f === null) return 'OpenTune returned a job this server cannot describe; see job.';
  const j = job as Json;
  const name = `Job ${f.id} (${f.kind})`;
  if (f.state === 'succeeded') return `${name} succeeded; its result is in job.result.`;
  if (f.state === 'cancelled')
    return `${name} was cancelled; job.result lists any work it committed before it stopped.`;
  if (f.state === 'failed') {
    const data = (j.error as Json | null | undefined)?.data as Json | undefined;
    const kind = trustedToken(data?.kind, ERROR_KIND_RE);
    return `${name} failed${kind === null ? '' : ` with ${kind}`}; see job.error.`;
  }
  const fraction = (j.progress as Json | null)?.fraction;
  const done =
    typeof fraction === 'number' && fraction >= 0 && fraction <= 1
      ? `, ${String(Math.round(fraction * 100))}% done`
      : '';
  return `${name} is ${f.state}${done}. Call opentune_get_job again to follow it.`;
}

/** The instance part of a job id (the first 8 hex digits of its instance id), for routing. */
const hintOf = (jobId: string) => jobId.split(':')[1];

async function jobGet(session: OtcpSession, jobId: string, waitMs: number): Promise<Json> {
  return session.call('job.get', { jobId, waitMs }, waitMs + WAIT_MARGIN_MS);
}

export async function getJob(
  ctx: ToolContext,
  args: { job_id: string; wait_seconds?: number | undefined; instance_id?: string | undefined },
): Promise<Outcome> {
  const waitMs = Math.round((args.wait_seconds ?? 0) * 1000);
  return withInstance(
    ctx,
    { instanceId: args.instance_id, hint: hintOf(args.job_id) },
    ['jobs.v1'],
    async (session) => {
      const { job } = await jobGet(session, args.job_id, waitMs);
      return { ok: true, body: { summary: jobSentence(job), job } };
    },
  );
}

export async function cancelJob(
  ctx: ToolContext,
  args: { job_id: string; instance_id?: string | undefined },
): Promise<Outcome> {
  return withInstance(
    ctx,
    { instanceId: args.instance_id, hint: hintOf(args.job_id) },
    ['jobs.v1'],
    async (session) => {
      let result: Json;
      try {
        result = await session.call('job.cancel', { jobId: args.job_id }, 10_000);
      } catch (error) {
        const data = (error as { data?: { kind?: string; reason?: string | null } }).data;
        if (data?.kind !== 'UNSUPPORTED' || data.reason !== 'job_not_cancellable') throw error;
        const nextStep = {
          actor: 'agent' as const,
          tool: 'opentune_get_job',
          args: { job_id: args.job_id },
          message: 'This job cannot be cancelled (any more); it continues unchanged. Follow it with opentune_get_job.',
        };
        return {
          ok: false,
          error: toolError('UNSUPPORTED', {
            reason: 'job_not_cancellable',
            detail: 'the job cannot be cancelled now',
            nextStep,
          }),
        };
      }
      const requested = result.cancelRequested === true;
      let job = result.job;
      // Cancellation is asynchronous: wait briefly so the result can show what the job committed.
      if (requested && facts(job)?.terminal === false) job = (await jobGet(session, args.job_id, CANCEL_SETTLE_MS)).job;
      const f = facts(job);
      const effect = f === null ? null : (CANCEL_EFFECT[f.kind] ?? null);
      let summary: string;
      if (f === null) summary = 'OpenTune answered the cancellation with a job this server cannot describe; see job.';
      else if (!requested) summary = `Job ${f.id} (${f.kind}) had already ended (${f.state}); nothing was cancelled.`;
      else if (f.state === 'cancelled')
        summary = `Job ${f.id} (${f.kind}) was cancelled.${effect === null ? '' : ` ${effect}`}`;
      else if (f.terminal) summary = `Job ${f.id} (${f.kind}) ended (${f.state}) before the cancellation took effect.`;
      else
        summary = `Cancellation of job ${f.id} (${f.kind}) was requested; it stops at its next cancellation point. Follow it with opentune_get_job.`;
      return { ok: true, body: { summary, cancelRequested: requested, effect, job } };
    },
  );
}

export const getJobTool = defineTool({
  name: 'opentune_get_job',
  title: 'Get OpenTune job',
  description:
    'OpenTune (audio vocal pitch editor): reports a long-running job (import, export, analysis, project open or ' +
    'save): state queued, running, succeeded, failed or cancelled, progress, and when it has ended its result or ' +
    'error. With wait_seconds it waits up to that long for the job to end. Finished jobs are kept for 30 minutes. ' +
    'Read-only.',
  inputSchema: z.strictObject({
    job_id: jobIdSchema,
    wait_seconds: z
      .number()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .optional()
      .describe('Seconds to wait for the job to end before answering, 0 to 30. Default 0: answer at once.'),
    instance_id: instanceIdSchema,
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  capabilities: ['jobs.v1'],
  otcpMethods: ['job.get'],
  run: (args, ctx) => getJob(ctx, args),
});

export const cancelJobTool = defineTool({
  name: 'opentune_cancel_job',
  title: 'Cancel OpenTune job',
  description:
    'OpenTune (audio vocal pitch editor): asks OpenTune to stop a running job and reports the outcome. Work the job ' +
    'already committed stays: an import keeps the items imported so far, and the result lists them with how to ' +
    'revert each; an export never touches the target file. Project saves, preference changes and project opens past ' +
    'their preparation cannot be cancelled; the error then says so and the job continues.',
  inputSchema: z.strictObject({ job_id: jobIdSchema, instance_id: instanceIdSchema }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  capabilities: ['jobs.v1'],
  otcpMethods: ['job.cancel', 'job.get'],
  run: (args, ctx) => cancelJob(ctx, args),
});
