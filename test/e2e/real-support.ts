// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Support for the scenarios that drive a started OpenTune through the MCP bundle: the bundle as a
// child process speaking MCP over stdio, one OpenTune instance started and ended by the scenario
// itself, and the checks that decide whether a process is one the scenario may end. Nothing here
// ends a process it cannot show to be its own.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { pidAlive, systemProbe } from '../../src/discovery/process.js';
import { copyTemplate } from '../contract/exe-target.js';
import { LineClient } from '../support/jsonrpc-lines.js';
import { isObject } from './smoke.js';

const BUNDLE = fileURLToPath(new URL('../../dist/opentune-mcp.mjs', import.meta.url));
const INITIALIZE = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'e2e-boundary', version: '0.0.0' },
};

/** A new empty folder below the system temporary directory; `ot-` prefixed so that it is easy to tell. */
export const scratchDir = (label: string): Promise<string> => mkdtemp(path.join(os.tmpdir(), `ot-e2e-${label}-`));

export interface ToolOutcome {
  readonly isError: boolean;
  /** The structured result (or the structured error) of the tool. */
  readonly body: Record<string, unknown>;
}

export interface McpProcess {
  readonly pid: number;
  call(name: string, args?: Record<string, unknown>): Promise<ToolOutcome>;
  /** Ends stdin and waits for a normal exit; ends the process by force if it does not come. */
  stop(): Promise<void>;
  /** Ends the process at once, as a crash would. */
  kill(): Promise<void>;
  /** Everything the process wrote to stderr so far. */
  stderr(): string;
}

/**
 * Starts the built bundle as an MCP server on stdio. Variables of this server (OPENTUNE_MCP_*) and
 * OPENTUNE_DATA_DIR of the calling environment never reach it: only `env` does, so no scenario can
 * resolve the discovery directory of a real OpenTune.
 */
export async function startMcp(env: Readonly<Record<string, string>>): Promise<McpProcess> {
  if (!existsSync(BUNDLE)) throw new Error('dist/opentune-mcp.mjs does not exist: run npm run build first');
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^OPENTUNE_(MCP_|DATA_DIR$|CONTROL_API$)/.test(k)),
  );
  const child: ChildProcess = spawn(process.execPath, [BUNDLE], {
    stdio: 'pipe',
    windowsHide: true,
    env: { ...base, ...env },
  });
  const { stdin, stdout, stderr } = child;
  if (child.pid === undefined || stdin === null || stdout === null || stderr === null) {
    throw new Error('the MCP bundle could not be started');
  }
  let err = '';
  stderr.setEncoding('utf8');
  stderr.on('data', (chunk: string) => (err += chunk));
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
  const client = new LineClient((line) => stdin.write(line), stdout, 180_000);
  await client.request(1, 'initialize', INITIALIZE);
  client.notify('notifications/initialized');
  let id = 10;
  return {
    pid: child.pid,
    async call(name, args = {}) {
      const response = await client.request(id++, 'tools/call', { name, arguments: args });
      if (response.error !== undefined) throw new Error(`${name}: ${response.error.message}`);
      const result = response.result as { isError?: boolean; structuredContent?: unknown };
      if (!isObject(result.structuredContent)) throw new Error(`${name} returned no structured content`);
      return { isError: result.isError === true, body: result.structuredContent };
    },
    async stop() {
      stdin.end();
      const timeout = sleep(5000).then(() => 'late' as const);
      if ((await Promise.race([exited.then(() => 'exited' as const), timeout])) === 'late') {
        child.kill();
        await exited;
      }
    },
    async kill() {
      child.kill();
      await exited;
    },
    stderr: () => err,
  };
}

const END_TIMEOUT_MS = 15_000;

/** Waits until no process with `pid` runs. */
export async function waitGone(pid: number, timeoutMs = END_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) !== false) {
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
  return true;
}

/** The pids of the running OpenTune processes; throws when the system cannot list them. */
export async function openTunePids(): Promise<readonly number[]> {
  const listed = await systemProbe().listOpenTune();
  if (listed === null) throw new Error('the running OpenTune processes cannot be listed on this machine');
  return listed;
}

const START_TOLERANCE_MS = 2000;

/**
 * Ends an OpenTune process after checking that it is the one whose discovery file `file` describes:
 * the pid runs OpenTune, and its start time is the processStartTimeMs of that file. The file lives
 * in a folder of this scenario, so the instance it describes was started for it. Returns false when
 * the process was gone already, throws when it cannot be shown to be that process.
 */
export async function endConfirmed(file: string): Promise<boolean> {
  const discovery = JSON.parse(await readFile(file, 'utf8')) as unknown;
  if (!isObject(discovery) || typeof discovery.pid !== 'number' || typeof discovery.processStartTimeMs !== 'number') {
    throw new Error('the discovery file is not usable to confirm the process');
  }
  const { pid } = discovery;
  const info = await systemProbe().probe(pid);
  if (info.alive === false) return false;
  const listed = await openTunePids();
  if (!listed.includes(pid)) return false;
  if (info.startTimeMs === null || Math.abs(info.startTimeMs - discovery.processStartTimeMs) > START_TOLERANCE_MS) {
    throw new Error(
      `pid ${String(pid)} runs OpenTune but is not shown to be the process of the discovery file; left running`,
    );
  }
  process.kill(pid, 'SIGKILL');
  if (!(await waitGone(pid))) throw new Error(`pid ${String(pid)} did not end`);
  return true;
}

/**
 * Ends every instance that a discovery file of `dir` (a folder of this scenario) describes, each
 * only after `end` confirmed it to be that process. A failure for one file never skips the others;
 * the problems come back as notes. A missing folder means nothing was started.
 */
export async function endAllConfirmed(
  dir: string,
  end: (file: string) => Promise<boolean> = endConfirmed,
): Promise<{ readonly ended: number; readonly notes: readonly string[] }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { ended: 0, notes: [] };
  }
  let ended = 0;
  const notes: string[] = [];
  for (const name of names.filter((n) => /^\d+\.json$/.test(n)).sort()) {
    try {
      if (await end(path.join(dir, name))) ended += 1;
    } catch (error) {
      notes.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ended, notes };
}

export interface RealInstance {
  readonly pid: number;
  readonly instanceId: string;
  /** Its discovery file. */
  readonly discoveryFile: string;
  /** Ends it (by force; Windows has no normal stop request) and resolves false if it had ended already. */
  end(): Promise<boolean>;
}

export interface RealInstanceOptions {
  readonly exe: string;
  /** Where the instance announces itself (--control-api-dir); shared by instances that must see each other. */
  readonly discoveryDir: string;
  /** An existing folder; the instance gets a data folder of its own below it. */
  readonly dataDirParent: string;
  /** Copied into the data folder before the start (first-run state), when given. */
  readonly dataTemplate?: string | undefined;
  readonly timeoutMs: number;
}

/**
 * Starts one OpenTune the way the contract runner does (own data folder, ready file, launch nonce),
 * but announcing itself in a given discovery directory. Resolves once the instance wrote its ready
 * file and a discovery file that carries this start's nonce and the pid of the started process.
 */
export async function startRealInstance(options: RealInstanceOptions): Promise<RealInstance> {
  const dataDir = await mkdtemp(path.join(options.dataDirParent, 'inst-'));
  // Same rules as the contract runner: the ready file and the discovery folder of the template are not copied.
  if (options.dataTemplate !== undefined) await copyTemplate(options.dataTemplate, dataDir);
  await mkdir(options.discoveryDir, { recursive: true });
  const readyFile = path.join(dataDir, 'ready.json');
  const nonce = randomBytes(24).toString('base64url');
  const child = spawn(
    options.exe,
    [
      '--control-api',
      `--control-api-dir=${options.discoveryDir}`,
      `--control-api-ready-file=${readyFile}`,
      `--control-api-launch-nonce=${nonce}`,
    ],
    {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, OPENTUNE_DATA_DIR: dataDir, OPENTUNE_CONTROL_API: '1' },
    },
  );
  const state = { exited: false };
  const exitEvent = new Promise<void>((resolve) =>
    child.once('exit', () => {
      state.exited = true;
      resolve();
    }),
  );
  child.once('error', () => {
    state.exited = true;
  });
  child.stderr.resume();
  const kill = async () => {
    if (!state.exited) child.kill('SIGKILL');
    await Promise.race([exitEvent, sleep(END_TIMEOUT_MS)]);
  };
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (state.exited) throw new Error('the instance ended before it wrote its ready file');
    if (existsSync(readyFile)) break;
    if (Date.now() >= deadline) {
      await kill();
      throw new Error(`no ready file within ${String(options.timeoutMs)} ms`);
    }
    await sleep(100);
  }
  try {
    const ready: unknown = JSON.parse(readFileSync(readyFile, 'utf8'));
    if (!isObject(ready) || ready.pid !== child.pid || typeof ready.instanceId !== 'string') {
      throw new Error('the ready file does not name the started process (a launcher?), so it is not ended');
    }
    const discoveryFile = path.join(options.discoveryDir, `${String(child.pid)}.json`);
    const discovery: unknown = JSON.parse(readFileSync(discoveryFile, 'utf8'));
    if (!isObject(discovery) || discovery.launchNonce !== nonce || discovery.pid !== child.pid) {
      throw new Error('the discovery file does not carry the launch nonce of this start');
    }
    return {
      pid: child.pid ?? 0,
      instanceId: ready.instanceId,
      discoveryFile,
      async end() {
        if (state.exited) return false;
        await kill();
        return true;
      },
    };
  } catch (error) {
    await kill();
    throw error;
  }
}

/** Removes a scratch folder, retrying while a just-ended process still holds a file in it. */
export const removeDir = (dir: string): Promise<void> =>
  rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
