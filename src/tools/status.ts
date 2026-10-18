// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_get_status: one state for "can this server use OpenTune now", with the next step.
// The checks run from the outside in: the runtime (WSL), the discovery directory and the
// instances in it (session.hello and session.info), OpenTune processes that opentune_launch started
// and that have not announced themselves yet, other OpenTune processes without a discovery file,
// and finally the configured executable. Starting OpenTune is opentune_launch's job.

import { z } from 'zod';

import type { DiscoveryEntry } from '../discovery/file.js';
import { troubleshootingUrl } from '../errors/next-step.js';
import { OtcpError, type NextStep } from '../errors/tool-error.js';
import { checkLaunchConfig, isWsl, readOsRelease } from '../launch/config.js';
import { launchDir, liveRecords } from '../launch/records.js';
import type { Json } from '../otcp/client.js';
import { instanceSummary, selectInstance } from '../otcp/instances.js';
import { defineTool, type Outcome, type ToolContext } from './registry.js';

export const STATUS_STATES = [
  'READY',
  'NOT_READY',
  'PROTOCOL_MISMATCH',
  'STARTING',
  'RUNNING_WITHOUT_API',
  'NOT_RUNNING',
  'NO_API_BUILD',
  'NOT_INSTALLED',
  'WSL_UNSUPPORTED_RUNTIME',
] as const;

export type StatusState = (typeof STATUS_STATES)[number];

/** An OpenTune process younger than this without a discovery file is assumed to be starting. */
export const STARTUP_GRACE_MS = 30_000;
const INFO_TIMEOUT_MS = 10_000;
const PROTOCOL_MAJOR = 1;

const RETRY: NextStep = { actor: 'agent', tool: 'opentune_get_status', message: '' };
const later = (message: string): NextStep => ({ ...RETRY, message });
const user = (message: string): NextStep => ({ actor: 'user', message });
const RESTART = 'Ask the user to restart OpenTune with the control API, then check the status again.';

/** Summary sentence and default next step of each state. */
export const STATUS_TEXT: Readonly<Record<StatusState, { readonly summary: string; readonly step: NextStep }>> = {
  READY: {
    summary: 'OpenTune is running and ready.',
    step: { actor: 'agent', message: "OpenTune is ready. Continue with the user's request." },
  },
  NOT_READY: {
    summary: 'OpenTune is running, but this server cannot use it yet.',
    step: later('Wait a few seconds, then check the status again.'),
  },
  PROTOCOL_MISMATCH: {
    summary: 'OpenTune is running, but it speaks another version of the control protocol.',
    step: user('Ask the user to update OpenTune or this server so that both support control protocol 1.'),
  },
  STARTING: {
    summary: 'OpenTune is starting; its control API is not available yet.',
    step: later('Wait a few seconds, then check the status again.'),
  },
  RUNNING_WITHOUT_API: {
    summary: 'OpenTune is running without the control API.',
    step: user(
      'Ask the user to save their work and quit OpenTune, then start it again with opentune_launch (or the user ' +
        'starts a build with the control API using the --control-api option). Never close OpenTune yourself.',
    ),
  },
  NOT_RUNNING: {
    summary: 'OpenTune is not running.',
    step: {
      actor: 'agent',
      tool: 'opentune_launch',
      message: 'Start OpenTune with opentune_launch; it waits until OpenTune is ready.',
    },
  },
  NO_API_BUILD: {
    summary: 'The configured OpenTune build has no control API.',
    step: user(
      'The executable in OPENTUNE_MCP_OPENTUNE_PATH has no opentune-control.json for protocol 1 next to it. Ask the ' +
        'user to configure an OpenTune build with the control API.',
    ),
  },
  NOT_INSTALLED: {
    summary: 'No OpenTune build with the control API is configured for this server.',
    step: user(
      'Ask the user to set OPENTUNE_MCP_OPENTUNE_PATH to the absolute path of an OpenTune executable with the control ' +
        'API ("opentune-mcp doctor" checks the setup), or to start such a build with the --control-api option.',
    ),
  },
  WSL_UNSUPPORTED_RUNTIME: {
    summary: 'This server runs inside WSL, where it cannot reach OpenTune on Windows.',
    step: user('Ask the user to configure the MCP client to run this server with Windows Node.js, not inside WSL.'),
  },
};

/** Next steps that differ from the state's default, by `<state>/<reason>`. */
export const STATUS_REASON_STEPS: Readonly<Record<string, NextStep>> = {
  'READY/multiple_instances': user(
    'Several OpenTune instances are running. Ask the user which one to use and pass its instance_id to other tools.',
  ),
  'NOT_READY/instance_unverified': user(`The instance could not be verified. ${RESTART}`),
  'NOT_READY/auth_failed': user(`OpenTune refused this server's credentials. ${RESTART}`),
  'NOT_READY/launch_timeout': later(
    'OpenTune was started but its control API is not available yet. Wait a few seconds, then check the status ' +
      'again; do not start it again.',
  ),
  'NOT_READY/launch_unverified': user(
    'An OpenTune instance announced itself, but not with the launch nonce of the process this server started, so it ' +
      'is not used. Ask the user which OpenTune windows are open; do not start OpenTune again.',
  ),
  'NOT_RUNNING/launch_exited': user(
    'OpenTune exited right after it was started. Ask the user to start it by hand to see what happens, or to run ' +
      '"opentune-mcp doctor".',
  ),
  'NOT_INSTALLED/not_absolute': user(
    'OPENTUNE_MCP_OPENTUNE_PATH must be an absolute path. Ask the user to correct it.',
  ),
  'NOT_INSTALLED/not_found': user('OPENTUNE_MCP_OPENTUNE_PATH names no existing file. Ask the user to correct it.'),
  'NOT_INSTALLED/not_a_file': user(
    'OPENTUNE_MCP_OPENTUNE_PATH must name the executable file. Ask the user to correct it.',
  ),
};

/** The reason of a NOT_READY or PROTOCOL_MISMATCH instance, from the failure of its session. */
function failureState(error: OtcpError): { state: StatusState; reason: string } {
  const { kind, reason } = error.data;
  if (kind === 'PROTOCOL_MISMATCH')
    return {
      state: 'PROTOCOL_MISMATCH',
      reason: reason === 'major_not_served' ? 'major_not_served' : 'hello_rejected',
    };
  if (kind === 'INSTANCE_UNVERIFIED') return { state: 'NOT_READY', reason: 'instance_unverified' };
  if (kind === 'AUTH_FAILED') return { state: 'NOT_READY', reason: 'auth_failed' };
  if (kind === 'SHUTTING_DOWN') return { state: 'NOT_READY', reason: 'shutting_down' };
  if (kind === 'BUSY' && reason === 'session_limit') return { state: 'NOT_READY', reason: 'session_limit' };
  return { state: 'NOT_READY', reason: kind === 'CONNECTION_LOST' && reason !== null ? reason : 'session_failed' };
}

const pick = (value: unknown, keys: readonly string[]): Json | null => {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as Json;
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
};

/** What one instance reports; strings from OpenTune appear only as values. */
async function instanceStatus(ctx: ToolContext, entry: DiscoveryEntry): Promise<Json & { state: StatusState }> {
  const base = instanceSummary(entry);
  if (!entry.protocolMajors.includes(PROTOCOL_MAJOR)) {
    return { ...base, state: 'PROTOCOL_MISMATCH', reason: 'major_not_served', protocolMajors: entry.protocolMajors };
  }
  let session;
  try {
    session = await ctx.instances.session(entry);
  } catch (error) {
    if (!(error instanceof OtcpError)) throw error;
    return { ...base, ...failureState(error) };
  }
  const ready = {
    ...base,
    state: 'READY' as const,
    reason: null,
    protocol: session.hello.protocol,
    capabilities: session.hello.capabilities,
  };
  try {
    const info = await session.call('session.info', {}, INFO_TIMEOUT_MS);
    const parts: Json = {
      runtime: pick(info.runtime, ['os', 'arch']),
      audioDevice: pick(info.audioDevice, ['running', 'name', 'sampleRateHz']),
      processing: pick(info.processing, ['editingScheme', 'tuningHz', 'vocoderReady']),
    };
    const missing = Object.keys(parts).filter((key) => parts[key] === null);
    return {
      ...ready,
      info: { ...pick(info, ['appVersion', 'buildTag', 'sourceUrl', 'language']), ...parts },
      ...(missing.length > 0
        ? { nullReasons: Object.fromEntries(missing.map((key) => [`info.${key}`, 'not_reported'])) }
        : {}),
    };
  } catch (error) {
    if (!(error instanceof OtcpError)) throw error;
    // Reachable and verified; session.info waits for OpenTune's main thread and may fail on its own.
    return { ...ready, info: null, nullReasons: { info: 'unavailable' } };
  }
}

/** A status result: the state's summary (or `summary`), the next step for the state and reason, the link. */
export function status(state: StatusState, reason: string | null, extra: Json = {}, summary?: string): Outcome {
  const text = STATUS_TEXT[state];
  const nextStep = (reason === null ? undefined : STATUS_REASON_STEPS[`${state}/${reason}`]) ?? text.step;
  return {
    ok: true,
    body: {
      summary: summary ?? text.summary,
      state,
      reason,
      nextStep,
      url: troubleshootingUrl(`status-${state.toLowerCase()}`),
      ...extra,
    },
  };
}

export async function getStatus(ctx: ToolContext, instanceId: string | undefined): Promise<Outcome> {
  if (isWsl(ctx.env, ctx.platform, await readOsRelease(ctx.platform))) return status('WSL_UNSUPPORTED_RUNTIME', null);
  const scan = await ctx.instances.scan();
  if (!('instances' in scan)) return { ok: false, error: scan };
  const ignored = scan.ignored.map(({ file, reason, removed }) => ({ file, reason, removed }));
  const extra: Json = ignored.length > 0 ? { ignoredDiscoveryFiles: ignored } : {};

  if (instanceId !== undefined || scan.instances.length > 0) {
    let entries = scan.instances;
    if (instanceId !== undefined) {
      const chosen = selectInstance(scan.instances, instanceId);
      if (!chosen.ok) return { ok: false, error: chosen.error, context: { instances: chosen.instances } };
      entries = [chosen.entry];
    }
    const instances = await Promise.all(entries.map((entry) => instanceStatus(ctx, entry)));
    const readyCount = instances.filter((i) => i.state === 'READY').length;
    const first = readyCount > 0 ? instances.find((i) => i.state === 'READY') : instances[0];
    const state = first?.state ?? 'NOT_READY';
    // Other tools refuse to choose among several announced instances, ready or not.
    const multiple = state === 'READY' && instances.length > 1;
    const reason = multiple
      ? 'multiple_instances'
      : state === 'READY'
        ? null
        : ((first?.reason as string | null) ?? null);
    const summary = multiple
      ? `${String(instances.length)} OpenTune instances are running (${String(readyCount)} ready); pass instance_id ` +
        'to choose one.'
      : undefined;
    return status(state, reason, { ...extra, instances }, summary);
  }

  // Processes opentune_launch started: still within the launch wait (STARTING), or past it and
  // still without a discovery file, which counts as running without the control API.
  const launched = await liveRecords(launchDir(scan.dir), {
    probe: ctx.probe,
    now: ctx.now(),
    waitMs: ctx.launch.waitMs,
    cleanup: false,
  });
  const pending = launched.filter((r) => r.state === 'pending').map((r) => ({ pid: r.record.pid }));
  if (pending.length > 0) return status('STARTING', 'launch_pending', { ...extra, processes: pending });
  const listed = await ctx.probe.listOpenTune();
  const pids = [...new Set([...(listed ?? []), ...launched.map((r) => r.record.pid)])];
  if (listed === null) {
    // The states below assume no OpenTune runs; say that this could not be checked.
    extra.processes = null;
    extra.nullReasons = { processes: 'not_listable' };
  }
  if (pids.length > 0) {
    const starts = await Promise.all(pids.map(async (pid) => (await ctx.probe.probe(pid)).startTimeMs));
    const starting = starts.some((t) => t !== null && ctx.now() - t < STARTUP_GRACE_MS);
    return status(starting ? 'STARTING' : 'RUNNING_WITHOUT_API', null, {
      ...extra,
      processes: pids.map((pid) => ({ pid })),
    });
  }

  const launch = await checkLaunchConfig(ctx.env, ctx.platform);
  if (launch.state === 'unset') return status('NOT_INSTALLED', 'path_not_configured', extra);
  if (launch.state === 'invalid') return status('NOT_INSTALLED', launch.reason, extra);
  if (launch.state === 'no_api') return status('NO_API_BUILD', launch.reason, extra);
  return status('NOT_RUNNING', null, extra);
}

export const getStatusTool = defineTool({
  name: 'opentune_get_status',
  title: 'Get OpenTune status',
  description:
    'OpenTune (audio vocal pitch editor): reports whether this server can use OpenTune now, as one state ' +
    '(READY, NOT_READY, PROTOCOL_MISMATCH, STARTING, RUNNING_WITHOUT_API, NOT_RUNNING, NO_API_BUILD, NOT_INSTALLED, ' +
    'WSL_UNSUPPORTED_RUNTIME) with a nextStep saying who should do what. Call it first, and again whenever a tool ' +
    'error says so. Lists the running instances with their instance_id; when several run, ask the user which one ' +
    'to use. Read-only: it never starts, stops or changes OpenTune.',
  inputSchema: z.strictObject({
    instance_id: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional()
      .describe('Report only this instance (32 hex digits, from an earlier result). Omit to report all.'),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  alwaysLoad: true,
  capabilities: ['session.v1'],
  otcpMethods: ['session.hello', 'session.info'],
  run: (args, ctx) => getStatus(ctx, args.instance_id),
});
