// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_set_settings: the user-global settings of the OpenTune installation: the processing
// preferences that prefs.set takes, the audio device setup that audio.set takes, and clearing the
// recent-projects list (project.clearRecent). They belong to the installation, not to the project,
// so every change outlives the project and the session. OpenTune records no undo entry for them
// (undo reason ui_parity, as in its own window); OTCP returns the previous values as a revert
// recipe and the warning GLOBAL_PREFERENCE, and this result renders both. A change of the editing
// scheme is applied by a prefsApply job, followed here like any other job. Device names come from
// the system: they stay JSON string values and are never placed in a summary sentence.

import { z } from 'zod';

import { OtcpError, fromOtcpError, toolError, type NextStep, type ToolError } from '../errors/tool-error.js';
import type { Json, OtcpSession } from '../otcp/client.js';
import { missingCapability } from '../otcp/instances.js';
import { isObject } from '../render/changes.js';
import { writeOutcome } from '../render/index.js';
import { DESTRUCTIVE_WARNINGS, warningCodes } from '../render/summary.js';
import {
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  followText,
  isTerminal,
  jobFailure,
  jobRef,
  jobState,
  startAndWait,
} from './follow-job.js';
import { jobSentence } from './jobs.js';
import {
  WRITE_RESULT_OUTPUT,
  defineTool,
  withInstance,
  type Body,
  type Outcome,
  type ToolContext,
} from './registry.js';

const TOOL = 'opentune_set_settings';
/** The capabilities this tool may need: which ones follows from the arguments (see setSettings). */
const CAPABILITIES = ['prefs.write', 'audio.device', 'project.io', 'jobs.v1'] as const;

/** The settable fields of prefs.set, as the tool names them (snake_case) and OTCP names them. */
const PROCESSING_FIELDS = [
  ['tuning_hz', 'tuningHz'],
  ['editing_scheme', 'editingScheme'],
  ['hybrid_mode', 'hybridMode'],
  ['experimental_features', 'experimentalFeatures'],
] as const;

/** The settable fields of audio.set, as the tool names them (snake_case) and OTCP names them. */
const AUDIO_FIELDS = [
  ['device_type', 'deviceType'],
  ['output_device', 'outputDevice'],
  ['sample_rate_hz', 'sampleRateHz'],
  ['buffer_size_frame', 'bufferSizeFrame'],
  ['output_channel_pair', 'outputChannelPair'],
] as const;

const processingSchema = z.strictObject({
  tuning_hz: z
    .number()
    .min(400)
    .max(500)
    .optional()
    .describe('Frequency of A4 in Hz, 400 to 500; applies to future analysis and rendering only.'),
  editing_scheme: z
    .enum(['openTune', 'openDyne'])
    .optional()
    .describe(
      'Editing scheme, applied by a job; openDyne may generate notes for the open clip irreversibly, with no undo entry, and marks the project modified.',
    ),
  hybrid_mode: z
    .boolean()
    .optional()
    .describe('Hybrid mode: small corrections render as a pitch shift of the audio instead of the vocoder.'),
  experimental_features: z
    .boolean()
    .optional()
    .describe('Show or hide experimental features such as reference binding.'),
});

const audioDeviceSchema = z.strictObject({
  device_type: z.string().min(1).max(64).optional().describe('Audio device type (driver model) the instance offers.'),
  output_device: z.string().min(1).max(256).optional().describe('Output device name the instance offers.'),
  sample_rate_hz: z.number().positive().optional().describe('Sample rate in Hz that the device offers.'),
  buffer_size_frame: z.number().int().min(1).optional().describe('Buffer size in frames that the device offers.'),
  output_channel_pair: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Output channels as a pair: 0 = channels 1 and 2, 1 = channels 3 and 4.'),
});

export type Processing = z.output<typeof processingSchema>;
export type AudioDevice = z.output<typeof audioDeviceSchema>;

export interface SetSettingsArgs {
  readonly processing?: Processing | undefined;
  readonly audio_device?: AudioDevice | undefined;
  readonly clear_recent?: boolean | undefined;
  readonly wait_seconds?: number | undefined;
  readonly instance_id?: string | undefined;
}

/** The next step of a call that names no setting at all. */
const NOTHING: NextStep = {
  actor: 'agent',
  message:
    'Call again with processing {…}, audio_device {…} or clear_recent: true, and give at least one value in the ' +
    'group; each group is one change of the installation settings.',
};

const invalid = (detail: string): Outcome => ({
  ok: false,
  error: toolError('INVALID_ARGUMENT', { detail, nextStep: NOTHING }),
});

/** The OTCP params of a settings group: only the members that were given, in OTCP's camelCase. */
const paramsOf = (input: object, fields: readonly (readonly [string, string])[]): Json =>
  Object.fromEntries(
    fields.flatMap(([snake, camel]) => {
      const value = (input as Record<string, unknown>)[snake];
      return value === undefined ? [] : [[camel, value]];
    }),
  );

interface Step {
  readonly method: string;
  readonly params: Json;
  /** The group as a sentence may name it; server-composed text, never a value from OpenTune. */
  readonly label: string;
}

interface Rendered {
  readonly method: string;
  readonly label: string;
  readonly body: Body;
}

/** A summary without the tool prefix, for a sentence that composes several results. */
const withoutPrefix = (summary: string): string =>
  summary.startsWith(`${TOOL}: `) ? summary.slice(TOOL.length + 2) : summary;

/**
 * The first sentence of a settings change: the change is user-global and has no undo entry, and
 * the revert line holds the way back. It is composed from the rendering (never from a value
 * OpenTune sent): a change whose recipe no tool can carry out says so instead of promising one.
 */
function leadSentence(bodies: readonly Body[]): string {
  const lines = bodies.flatMap((body): readonly unknown[] =>
    Array.isArray(body.lines) ? (body.lines as unknown[]) : [],
  );
  const reverts = lines.filter((line) => isObject(line) && line.kind === 'revert');
  const restorable = reverts.some((line) => isObject(line) && line.restore !== null);
  const manual = reverts.some((line) => isObject(line) && line.restore === null);
  const base =
    'this changes user-global OpenTune settings, which belong to the installation and not to the project, and ' +
    'OpenTune records no undo entry for it';
  const generated = bodies.some(
    (body) =>
      warningCodes(body).includes('SCHEME_GENERATED_NOTES') ||
      (isObject(body.sideEffects) && 'notesGenerated' in body.sideEffects),
  );
  const irreversible =
    generated || bodies.some((body) => warningCodes(body).some((code) => DESTRUCTIVE_WARNINGS.has(code)));
  // Part of the change that nothing can take back comes before any promise of a way back.
  if (irreversible && restorable) {
    const what = generated ? 'the notes it generated' : 'part of it';
    return (
      `${base}, and ${what} can be neither undone nor reverted: the revert line gives the ${TOOL} call that ` +
      'puts back only the previous values it can, and the warnings say what stays.'
    );
  }
  if (restorable && !manual)
    return `${base}: the revert line gives the ${TOOL} call that puts the previous values back.`;
  if (restorable)
    return `${base}: the revert line gives the ${TOOL} call that puts some of the previous values back, and says what cannot be restored.`;
  return `${base}, and no request of the protocol can restore the previous values (see the revert line).`;
}

/** A single settings result with the lead sentence of its change; a result that changed nothing stays as it is. */
export function settingsLead(body: Body): Body {
  return body.noOp === true ? body : withLead(body, leadSentence([body]));
}

/** The body of a result that names a started job: it says what the change is before the job's own words. */
const JOB_LEAD =
  'this changes user-global OpenTune settings, which belong to the installation and not to the project, and ' +
  'OpenTune records no undo entry for it, and an editing-scheme change may generate notes that can be neither ' +
  "undone nor reverted; the job's result holds the previous values and what can be restored.";

const withLead = (body: Body, lead: string): Body => ({
  ...body,
  summary: `${TOOL}: ${lead} ${withoutPrefix(body.summary)}`,
});

/** Combines the finished groups of one call, or renders the single one it made. */
function combined(results: readonly Rendered[]): Outcome {
  const [only, second] = results;
  if (only === undefined)
    return invalid('give processing, audio_device or clear_recent: true: there is nothing to set');
  if (second === undefined) {
    // A result that changed nothing says only that; the lead would promise a revert that does not exist.
    return { ok: true, body: settingsLead(only.body) };
  }
  const parts = results.map((result) => `${result.label}: ${withoutPrefix(result.body.summary)}`);
  return {
    ok: true,
    body: {
      summary: `${TOOL}: ${leadSentence(results.map((result) => result.body))} ${parts.join(' ')}`,
      results: results.map((result) => ({ method: result.method, ...result.body })),
    },
  };
}

/** Runs every group in order; the first failure stops the call and carries what the earlier ones applied. */
async function runSteps(
  ctx: ToolContext,
  session: OtcpSession,
  steps: readonly Step[],
  waitSeconds: number,
): Promise<Outcome> {
  const results: Rendered[] = [];
  const failedAfter = (error: ToolError): Outcome => ({
    ok: false,
    error,
    context: {
      applied_before_error: results.map((result) => ({ method: result.method, ...result.body })),
    },
  });
  const stop = (outcome: Extract<Outcome, { ok: false }>): Outcome =>
    results.length === 0 ? outcome : failedAfter(outcome.error);

  for (const [index, step] of steps.entries()) {
    let run;
    try {
      run = await startAndWait(ctx, session, step.method, step.params, waitSeconds);
    } catch (error) {
      if (!(error instanceof OtcpError)) throw error;
      // Nothing applied yet: let withInstance turn the OTCP error into a tool error with its next step.
      if (results.length === 0) throw error;
      return failedAfter(fromOtcpError(error.data));
    }
    const { started, job, waitFailed } = run;
    if (job === null || !isTerminal(job)) {
      const outcome = writeOutcome(started, { tool: TOOL });
      if (!outcome.ok) return stop(outcome);
      if (job === null) {
        results.push({ method: step.method, label: step.label, body: outcome.body });
        continue;
      }
      // The job outlived the wait: the start envelope names it, and no later group is attempted.
      // With the current protocol only the first group can get here: prefs.set is the one method of the three
      // that starts a job (audio.set and project.clearRecent finish inside the call) and it always runs first,
      // so `earlier` is empty. Should a later group ever start a job, the revert lines of the groups that were
      // applied before it are only in `applied_before_job`, not in this body's own lines, and the note below
      // has to say so.
      const remaining = steps.length - index - 1;
      const earlier = results.map((result) => result.label);
      const note =
        followText(waitFailed) +
        (earlier.length > 0 ? ` The earlier group(s) already applied: ${earlier.join(', ')}.` : '') +
        (remaining > 0
          ? ` The ${String(remaining)} later setting group(s) were not attempted; call again for them.`
          : '');
      const pending = withLead({ ...outcome.body, summary: outcome.body.summary + note }, JOB_LEAD);
      return {
        ok: true,
        body:
          earlier.length === 0
            ? pending
            : { ...pending, applied_before_job: results.map((result) => ({ method: result.method, ...result.body })) },
      };
    }
    const state = jobState(job);
    if (state === 'failed') return stop(jobFailure(job));
    if (state === 'cancelled') {
      const outcome = writeOutcome(job.result, { tool: TOOL });
      results.push({
        method: step.method,
        label: step.label,
        body: outcome.ok
          ? { ...outcome.body, job: jobRef(job) }
          : { summary: `${TOOL}: ${jobSentence(job)}`, job: jobRef(job), result: job.result ?? null },
      });
      continue;
    }
    const result = isObject(job.result) ? job.result : null;
    if (result === null) {
      return stop({
        ok: false,
        error: toolError('INTERNAL', {
          detail: 'OpenTune finished the settings job without a result',
          executed: null,
        }),
      });
    }
    const outcome = writeOutcome(result, { tool: TOOL });
    if (!outcome.ok) return stop(outcome);
    results.push({ method: step.method, label: step.label, body: outcome.body });
  }
  return combined(results);
}

export async function setSettings(ctx: ToolContext, args: SetSettingsArgs): Promise<Outcome> {
  const processing = args.processing;
  const audio = args.audio_device;
  const clear = args.clear_recent === true;

  const steps: Step[] = [];
  if (processing !== undefined) {
    const params = paramsOf(processing, PROCESSING_FIELDS);
    if (Object.keys(params).length === 0) return invalid('processing was given without any setting');
    steps.push({ method: 'prefs.set', params, label: 'processing' });
  }
  if (audio !== undefined) {
    const params = paramsOf(audio, AUDIO_FIELDS);
    if (Object.keys(params).length === 0) return invalid('audio_device was given without any setting');
    steps.push({ method: 'audio.set', params, label: 'audio device' });
  }
  if (clear) steps.push({ method: 'project.clearRecent', params: {}, label: 'recent projects' });
  if (steps.length === 0)
    return invalid('give processing, audio_device or clear_recent: true: there is nothing to set');

  // Only the capabilities the given groups need; a build without audio.device takes processing.
  const needed = [
    ...(processing === undefined ? [] : ['prefs.write']),
    ...(audio === undefined ? [] : ['audio.device']),
    ...(clear ? ['project.io'] : []),
  ];
  return withInstance(ctx, { instanceId: args.instance_id }, [], async (session) => {
    const missing = missingCapability(session, needed);
    if (missing !== null) return { ok: false, error: missing };
    return runSteps(ctx, session, steps, args.wait_seconds ?? DEFAULT_WAIT_SECONDS);
  });
}

export const setSettingsTool = defineTool({
  name: TOOL,
  title: 'Set OpenTune settings',
  description:
    'OpenTune (audio vocal pitch editor): changes the global settings of the OpenTune installation, not of the ' +
    'project. processing: tuning_hz (A4 in Hz, 400-500), editing_scheme (openTune or openDyne, applied by a ' +
    'job), hybrid_mode, experimental_features. audio_device: device_type, output_device, sample_rate_hz, ' +
    'buffer_size_frame, output_channel_pair, each one the instance offers. clear_recent: true empties the ' +
    'recent-project list, which nothing refills. OpenTune records no undo entry; the result warns GLOBAL_PREFERENCE ' +
    'and gives the previous values with the call that restores them.',
  inputSchema: z.strictObject({
    processing: processingSchema.optional().describe('Processing preferences to change; give at least one member.'),
    audio_device: audioDeviceSchema.optional().describe('Audio device setup to change; give at least one member.'),
    clear_recent: z
      .boolean()
      .optional()
      .describe('true clears the recent-projects list. No request of the protocol fills it again.'),
    wait_seconds: z
      .number()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .optional()
      .describe('Seconds to wait for a settings job to end, 0 to 30. Default 25.'),
    instance_id: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional()
      .describe('OpenTune instance (32 hex digits, from opentune_get_status). Optional when one instance runs.'),
  }),
  outputSchema: WRITE_RESULT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  capabilities: [...CAPABILITIES],
  otcpMethods: ['prefs.set', 'audio.set', 'project.clearRecent', 'job.get'],
  run: (args, ctx) => setSettings(ctx, args),
});
