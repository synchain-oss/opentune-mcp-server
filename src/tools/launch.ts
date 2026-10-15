// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_launch: starts the OpenTune build configured in OPENTUNE_MCP_OPENTUNE_PATH with its
// control API, waits until it announces itself, and reports the result in the shape of
// opentune_get_status. It starts nothing when an instance with the control API already runs
// (unless the user asked for a second one), when an OpenTune without the control API runs, or
// when the configuration does not allow it; a call that arrives while another call's start is
// under way waits for that start instead. The started instance is accepted only if its discovery
// file carries the nonce passed to the process. No process is ever stopped, also not after a
// timeout. The executable, its arguments and its environment come from the configuration only.

import { z } from 'zod';

import { toolError } from '../errors/tool-error.js';
import type { DiscoveryEntry } from '../discovery/file.js';
import { checkLaunchConfig, isWsl, readOsRelease } from '../launch/config.js';
import {
  acquireLock,
  launchDir,
  liveRecords,
  newNonce,
  nonceHash,
  readReadyFile,
  readyFilePath,
  removeRecord,
  writeRecord,
  type LaunchRecord,
} from '../launch/records.js';
import { startProcess } from '../launch/start.js';
import type { Json } from '../otcp/client.js';
import { defineTool, type Outcome, type ToolContext } from './registry.js';
import { STARTUP_GRACE_MS, getStatus, status, type StatusState } from './status.js';

/** After the started process has exited, the discovery file may still appear for this long. */
const EXIT_GRACE_MS = 2000;

interface Flags extends Json {
  /** This call started OpenTune. */
  readonly launched: boolean;
  /** Another call had just started OpenTune; this call waited for that start. */
  readonly joined: boolean;
  /** An instance with the control API was running; nothing was started. */
  readonly alreadyRunning: boolean;
}

const NOTHING: Flags = { launched: false, joined: false, alreadyRunning: false };

/** A start this call made or joined, and what to wait for. */
interface Waiting {
  readonly record: LaunchRecord;
  /** The launching directory. */
  readonly dir: string;
  /** Whether the process this call started has exited; null when the call joined another start. */
  readonly exited: (() => boolean) | null;
  readonly workingDirectory: 'official_install' | 'executable_folder' | null;
}

type Plan =
  | { readonly kind: 'outcome'; readonly outcome: Outcome }
  | { readonly kind: 'running' }
  | { readonly kind: 'wait'; readonly wait: Waiting };

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** The result of opentune_get_status with this call's summary and flags in front. */
function relabel(outcome: Outcome, flags: Json, summary: (statusSummary: string) => string): Outcome {
  if (!outcome.ok) return outcome;
  const { summary: statusSummary, ...rest } = outcome.body;
  return { ok: true, body: { summary: summary(statusSummary), ...flags, ...rest } };
}

const notStartedOutcome = (state: StatusState, reason: string | null, extra: Json = {}): Outcome =>
  relabel(status(state, reason, extra), NOTHING, (s) => `OpenTune was not started. ${s}`);

const notStarted = (state: StatusState, reason: string | null, extra: Json = {}): Plan => ({
  kind: 'outcome',
  outcome: notStartedOutcome(state, reason, extra),
});

/** Decides, under the launch lock, whether to start, to wait for another start or to report. */
async function decide(
  ctx: ToolContext,
  discovery: { readonly dir: string; readonly override: boolean },
  allowSecond: boolean,
): Promise<Plan> {
  const scan = await ctx.instances.scan();
  if (!('instances' in scan)) return { kind: 'outcome', outcome: { ok: false, error: scan } };
  if (scan.instances.length > 0 && !allowSecond) return { kind: 'running' };

  const dir = launchDir(discovery.dir);
  const records = await liveRecords(dir, {
    probe: ctx.probe,
    now: ctx.now(),
    waitMs: ctx.launch.waitMs,
    cleanup: true,
  });
  const announced = new Set(scan.instances.map((i) => i.pid));
  const pending = records.find((r) => r.state === 'pending' && !announced.has(r.record.pid));
  if (pending) return { kind: 'wait', wait: { record: pending.record, dir, exited: null, workingDirectory: null } };

  // OpenTune processes without a discovery file: listed by name, or started earlier by this server
  // and still silent after the launch wait.
  const listed = (await ctx.probe.listOpenTune()) ?? [];
  const silent = [...new Set([...listed, ...records.map((r) => r.record.pid)])].filter((pid) => !announced.has(pid));
  if (silent.length > 0) {
    const starts = await Promise.all(silent.map(async (pid) => (await ctx.probe.probe(pid)).startTimeMs));
    const starting = starts.some((t) => t !== null && ctx.now() - t < STARTUP_GRACE_MS);
    return notStarted(starting ? 'STARTING' : 'RUNNING_WITHOUT_API', null, {
      processes: silent.map((pid) => ({ pid })),
    });
  }

  const config = await checkLaunchConfig(ctx.env, ctx.platform);
  if (config.state === 'unset') return notStarted('NOT_INSTALLED', 'path_not_configured');
  if (config.state === 'invalid') return notStarted('NOT_INSTALLED', config.reason);
  if (config.state === 'no_api') return notStarted('NO_API_BUILD', config.reason);

  const nonce = newNonce();
  const hash = nonceHash(nonce);
  const install = await ctx.launch.officialInstall().catch(() => null);
  const startedAtMs = ctx.now();
  const started = await startProcess(ctx.launch.spawn, {
    exe: config.path,
    cwd: install?.dir ?? config.dir,
    env: ctx.env,
    readyFile: readyFilePath(dir, hash),
    nonce,
    // OpenTune does not know this server's override, so it is told where to announce itself.
    discoveryDir: discovery.override ? discovery.dir : null,
  });
  if (!started.ok) {
    const error = toolError('CONFIG_INVALID', {
      reason: 'launch_failed',
      detail: `the executable in OPENTUNE_MCP_OPENTUNE_PATH could not be started (${started.code})`,
    });
    return { kind: 'outcome', outcome: { ok: false, error } };
  }
  const record: LaunchRecord = { pid: started.pid, startedAtMs, nonceHash: hash };
  await writeRecord(dir, record).catch((error: unknown) => {
    // Waiting still works; only other calls cannot join this start.
    ctx.logger.warn(`opentune_launch: the launch record could not be written (${(error as Error).message})`);
  });
  const workingDirectory = install ? 'official_install' : 'executable_folder';
  return { kind: 'wait', wait: { record, dir, exited: started.exited, workingDirectory } };
}

/** The status of the started instance, once its discovery file with the launch nonce has appeared. */
async function ready(ctx: ToolContext, entry: DiscoveryEntry, count: number, intro: string, flags: Json) {
  const others =
    count > 1
      ? ` ${String(count)} instances run now; pass instance_id ${entry.instanceId} to other tools to use this one.`
      : '';
  return relabel(await getStatus(ctx, entry.instanceId), flags, (s) => `${intro}. ${s}${others}`);
}

async function waitFor(ctx: ToolContext, wait: Waiting): Promise<Outcome> {
  const { record } = wait;
  const launched = wait.exited !== null;
  const pid = String(record.pid);
  const intro = launched
    ? `Started OpenTune (pid ${pid})`
    : `Another call started OpenTune (pid ${pid}) moments ago; this call started nothing and waited for it`;
  const flags: Json = {
    launched,
    joined: !launched,
    alreadyRunning: false,
    process: { pid: record.pid, startedAtMs: record.startedAtMs },
    ...(wait.workingDirectory === null ? {} : { workingDirectory: wait.workingDirectory }),
  };
  const deadline = record.startedAtMs + ctx.launch.waitMs;
  const readyFile = readyFilePath(wait.dir, record.nonceHash);
  let exitedAt: number | null = null;
  for (;;) {
    const scan = await ctx.instances.scan();
    if (!('instances' in scan)) return { ok: false, error: scan };
    const mine = scan.instances.find((e) => e.launchNonce !== null && nonceHash(e.launchNonce) === record.nonceHash);
    if (mine) {
      if (launched) await removeRecord(wait.dir, record);
      return ready(ctx, mine, scan.instances.length, intro, flags);
    }
    // The ready file names the discovery file of the started process; if that file, or one of the
    // started pid, is there but did not match above, its nonce differs (a build that ignores the
    // option, or another process) and the instance is not accepted as the one started.
    const announced = await readReadyFile(readyFile);
    const pids = new Set([record.pid, ...(announced ? [announced.pid] : [])]);
    if (scan.instances.some((e) => pids.has(e.pid))) {
      return relabel(
        status('NOT_READY', 'launch_unverified'),
        flags,
        () => `${intro}, but the instance that announced itself does not carry its launch nonce, so it is not used.`,
      );
    }
    const gone = wait.exited ? wait.exited() : (await ctx.probe.probe(record.pid)).alive === false;
    if (gone) exitedAt ??= ctx.now();
    if (exitedAt !== null && ctx.now() - exitedAt >= EXIT_GRACE_MS) {
      if (launched) await removeRecord(wait.dir, record);
      return relabel(
        status('NOT_RUNNING', 'launch_exited'),
        flags,
        () => `${intro}, but it exited before its control API became available.`,
      );
    }
    if (ctx.now() >= deadline) {
      const seconds = String(Math.round(ctx.launch.waitMs / 1000));
      return relabel(
        status('NOT_READY', 'launch_timeout'),
        flags,
        () =>
          `${intro}, but its control API did not become available within ${seconds} seconds. The process was left ` +
          'running.',
      );
    }
    await sleep(ctx.launch.pollMs);
  }
}

export async function launch(
  ctx: ToolContext,
  args: { allow_second_instance?: boolean | undefined },
): Promise<Outcome> {
  if (isWsl(ctx.env, ctx.platform, await readOsRelease(ctx.platform)))
    return notStartedOutcome('WSL_UNSUPPORTED_RUNTIME', null);
  const dir = ctx.instances.dir();
  if (!dir.ok)
    return { ok: false, error: toolError('CONFIG_INVALID', { reason: 'discovery_dir', detail: dir.problem }) };
  let release: () => Promise<void>;
  try {
    release = await acquireLock(launchDir(dir.dir), ctx.launch.pollMs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'locked';
    const detail = `the launching directory in the discovery directory cannot be used (${code})`;
    return { ok: false, error: toolError('CONFIG_INVALID', { reason: 'discovery_dir', detail }) };
  }
  let plan: Plan;
  try {
    plan = await decide(
      ctx,
      { dir: dir.dir, override: dir.source === 'override' },
      args.allow_second_instance === true,
    );
  } finally {
    await release();
  }
  if (plan.kind === 'outcome') return plan.outcome;
  if (plan.kind === 'running') {
    const flags: Flags = { launched: false, joined: false, alreadyRunning: true };
    return relabel(
      await getStatus(ctx, undefined),
      flags,
      (s) => `OpenTune is already running; nothing was started. ${s}`,
    );
  }
  return waitFor(ctx, plan.wait);
}

export const launchTool = defineTool({
  name: 'opentune_launch',
  title: 'Start OpenTune',
  description:
    'OpenTune (audio vocal pitch editor): starts the OpenTune build configured for this server ' +
    '(OPENTUNE_MCP_OPENTUNE_PATH) with its control API and waits up to 30 seconds until it is ready, then reports ' +
    'the state like opentune_get_status, with a nextStep. Starts nothing when OpenTune already runs ' +
    '(alreadyRunning), runs without the control API, or no API build is configured; the result says why. Repeated ' +
    "or concurrent calls share one start. allow_second_instance needs the user's explicit consent. Never closes " +
    'OpenTune.',
  inputSchema: z.strictObject({
    allow_second_instance: z
      .boolean()
      .optional()
      .describe(
        'Start another instance although one with the control API is running. Only when the user explicitly ' +
          'asked for a second OpenTune instance. Default false: report the running one.',
      ),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  capabilities: ['session.v1'],
  otcpMethods: ['session.hello', 'session.info'],
  run: (args, ctx) => launch(ctx, args),
});
