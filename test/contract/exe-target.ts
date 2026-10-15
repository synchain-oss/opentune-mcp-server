// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The executable target: starts a real OpenTune build with its control API on, in a data folder of
// its own, and runs the vectors against it. Configuration comes only from the environment (see
// test/contract/README.md); nothing about the machine it runs on is kept in the repository.
//
// Per vector: a fresh temporary OPENTUNE_DATA_DIR, the process started with `shell: false`, the
// ready file and launch nonce of PROTOCOL.md section 5.5 and the options table, the discovery file
// read back from <data dir>/control/instances and checked against both. The only process this
// target ever ends is the one it started itself.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { resolveDiscoveryDir } from '../../mock/discovery.js';
import { RunnerConnection } from './connection.js';
import { PreconditionUnavailable, type ContractTarget } from './target.js';

export interface ExeTargetOptions {
  /** Absolute path of the executable. */
  readonly exe: string;
  /** Arguments before the two this target adds; `--control-api` unless given. */
  readonly args?: readonly string[];
  /** How long to wait for the ready file, for the hello and for the exit; 30 s unless given. */
  readonly timeoutMs?: number;
}

export type ExeConfig = { readonly skip: string } | { readonly options: ExeTargetOptions };

/** What close() found, over all instances this target started. */
export interface ExeCleanupStats {
  /** Exited by itself after a normal stop request, discovery file removed. */
  verified: number;
  /** Ended by force; whether the instance cleans up after itself was not verified. */
  forced: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 50;
const STDERR_TAIL_CHARS = 2000;
const HELLO_ID = 'otcp-exe-hello';

/** Reads OTCP_TARGET_EXE, OTCP_TARGET_ARGS and OTCP_TARGET_TIMEOUT_MS. Throws on a bad value. */
export function exeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ExeConfig {
  const exe = env.OTCP_TARGET_EXE;
  if (exe === undefined || exe === '') return { skip: 'OTCP_TARGET_EXE is not set' };
  let args: string[] | undefined;
  const rawArgs = env.OTCP_TARGET_ARGS;
  if (rawArgs !== undefined && rawArgs !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs);
    } catch {
      throw new Error('OTCP_TARGET_ARGS must be a JSON array of strings');
    }
    if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === 'string')) {
      throw new Error('OTCP_TARGET_ARGS must be a JSON array of strings');
    }
    args = parsed;
  }
  let timeoutMs: number | undefined;
  const rawTimeout = env.OTCP_TARGET_TIMEOUT_MS;
  if (rawTimeout !== undefined && rawTimeout !== '') {
    timeoutMs = Number(rawTimeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error('OTCP_TARGET_TIMEOUT_MS must be a positive integer');
    }
  }
  return { options: { exe, ...(args && { args }), ...(timeoutMs && { timeoutMs }) } };
}

/** The executable must be an absolute path to an existing regular file. */
function checkExe(exe: string): void {
  if (!path.isAbsolute(exe)) throw new Error('OTCP_TARGET_EXE must be an absolute path');
  let isFile = false;
  try {
    isFile = statSync(exe).isFile();
  } catch {
    // reported below
  }
  if (!isFile) throw new Error('OTCP_TARGET_EXE is not an existing regular file');
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export function exeTarget(options: ExeTargetOptions): ContractTarget & { readonly stats: ExeCleanupStats } {
  checkExe(options.exe);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stats: ExeCleanupStats = { verified: 0, forced: 0 };

  return {
    name: 'exe',
    stats,
    async open() {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ot-exe-'));
      const instancesDir = path.join(dataDir, 'control', 'instances');
      const readyFile = path.join(dataDir, 'ready.json');
      const nonce = randomBytes(24).toString('base64url');
      let secrets: string[] = [nonce];
      let child: ChildProcess | undefined;
      let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let spawnError: Error | undefined;
      let stderrTail = '';

      const exitState = () => exited;
      const redacted = (text: string) => {
        let out = text.replace(/[0-9a-fA-F]{32,}/g, '[redacted]');
        for (const secret of secrets) if (secret !== '') out = out.replaceAll(secret, '[redacted]');
        return out;
      };
      const describe = (problem: string) => {
        const tail = redacted(stderrTail).trim();
        return `${problem}${tail === '' ? '' : `; stderr tail:\n${tail}`}`;
      };
      // Ends the process this target started. Windows has no normal stop request to send, so
      // there kill() ends it outright and the clean-up on exit cannot be verified.
      const stop = async (graceful: boolean): Promise<'clean' | 'forced'> => {
        const proc = child;
        if (proc === undefined || exitState() !== undefined) return 'forced';
        const done = new Promise<void>((resolve) => {
          proc.once('exit', () => {
            resolve();
          });
        });
        const normal = graceful && process.platform !== 'win32';
        proc.kill(normal ? 'SIGTERM' : 'SIGKILL');
        const timer = sleep(timeoutMs, 'timeout');
        const first = await Promise.race([done.then(() => 'done'), timer]);
        if (first === 'timeout') {
          proc.kill('SIGKILL');
          await done;
          return 'forced';
        }
        return normal && exitState()?.code === 0 ? 'clean' : 'forced';
      };
      const fail = async (problem: string): Promise<never> => {
        const message = describe(problem);
        await stop(false);
        await rm(dataDir, { recursive: true, force: true });
        throw new Error(message);
      };

      try {
        // Never a real OpenTune folder, whatever the temporary directory is.
        resolveDiscoveryDir(instancesDir);
        child = spawn(
          options.exe,
          [
            ...(options.args ?? ['--control-api']),
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
      } catch (error) {
        await rm(dataDir, { recursive: true, force: true });
        throw error;
      }
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
      });
      child.once('error', (error) => {
        spawnError = error;
      });
      child.once('exit', (code, signal) => {
        exited = { code, signal };
      });

      // Wait for the ready file; a process that ends first is a failure at once.
      const deadline = Date.now() + timeoutMs;
      let ready: unknown;
      for (;;) {
        if (spawnError !== undefined) return fail(`the executable could not be started: ${spawnError.message}`);
        ready = existsSync(readyFile) ? await readJson(readyFile) : undefined;
        if (ready !== undefined) break;
        if (exited !== undefined) {
          const how = exited.signal ?? `exit code ${String(exited.code)}`;
          return fail(`the process ended (${how}) before it wrote the ready file`);
        }
        if (Date.now() >= deadline) return fail(`no ready file within ${String(timeoutMs)} ms`);
        await sleep(POLL_MS);
      }
      if (!isObject(ready) || !Number.isInteger(ready.pid) || typeof ready.instanceId !== 'string') {
        return fail('the ready file does not hold {pid, instanceId}');
      }
      const readyPid = ready.pid as number;

      const discoveryFile = path.join(instancesDir, `${String(readyPid)}.json`);
      const discovery = await readJson(discoveryFile);
      if (!isObject(discovery))
        return fail(`no readable discovery file for pid ${String(readyPid)} in control/instances`);
      secrets = [nonce, discovery.token, discovery.serverProof].filter((v): v is string => typeof v === 'string');
      if (discovery.pid !== readyPid) return fail('the discovery file names another pid than the ready file');
      if (discovery.instanceId !== ready.instanceId) {
        return fail('the discovery file and the ready file differ in instanceId');
      }
      if (discovery.launchNonce !== nonce) return fail('the launch nonce of the discovery file is not the one passed');

      // The capabilities come from a session.hello of this target's own; the runner opens its own connections.
      let capabilities: string[];
      let protocol: string;
      let conn: RunnerConnection | undefined;
      try {
        conn = await RunnerConnection.open(Number(discovery.port));
        const hello = {
          jsonrpc: '2.0',
          id: HELLO_ID,
          method: 'session.hello',
          params: { token: discovery.token, protocol: '1.0', client: { name: 'otcp-exe-target', version: '1.0.0' } },
        };
        conn.write(Buffer.from(`${JSON.stringify(hello)}\n`, 'utf8'));
        const line = await conn.readLine(timeoutMs);
        if (line === 'closed' || line === 'timeout') return await fail(`session.hello got no answer (${line})`);
        const message = JSON.parse(line.toString('utf8')) as unknown;
        const result = isObject(message) && isObject(message.result) ? message.result : undefined;
        if (
          result === undefined ||
          result.serverProof !== discovery.serverProof ||
          !Array.isArray(result.capabilities) ||
          typeof result.protocol !== 'string'
        ) {
          return await fail('session.hello did not succeed with the serverProof of the discovery file');
        }
        capabilities = result.capabilities.filter((c): c is string => typeof c === 'string');
        protocol = result.protocol;
      } catch (error) {
        return await fail(`session.hello failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        conn?.destroy();
      }

      return {
        discovery,
        protocol,
        capabilities,
        establish(given) {
          // No preparatory calls yet: only vectors without preconditions run on a real instance.
          const members = Object.keys(given);
          if (members.length === 0) return Promise.resolve({});
          return Promise.reject(
            new PreconditionUnavailable(`the exe target cannot establish given.${members.join(', given.')}`),
          );
        },
        runnerValue: () => undefined,
        async close() {
          const how = await stop(true);
          const left = existsSync(discoveryFile);
          await rm(dataDir, { recursive: true, force: true });
          if (how === 'clean') {
            if (left) throw new Error('the instance exited normally but left its discovery file behind');
            stats.verified++;
          } else {
            // Ended by force: the clean-up on exit was not verified.
            stats.forced++;
          }
        },
      };
    },
  };
}
