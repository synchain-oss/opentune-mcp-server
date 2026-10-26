// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The executable target: starts a real OpenTune build with its control API on, in a data folder of
// its own, and runs the vectors against it. Configuration comes only from the environment (see
// test/contract/README.md); nothing about the machine it runs on is kept in the repository.
//
// Per vector: a fresh temporary OPENTUNE_DATA_DIR (or, with OTCP_TARGET_DATA_DIR, a fresh sub-folder
// of that folder, which is kept so its logs can be read), the process started with `shell: false`, the
// ready file and launch nonce of PROTOCOL.md section 5.5 and the options table, the discovery file
// read back from <data dir>/control/instances and checked against both.
//
// This target ends only the process it started itself and, when the ready file names another pid
// (a launcher that starts the real process), that process once it is confirmed to come from this
// launch: its discovery file carries the launch nonce, and the start time the operating system
// reports for it lies between the launch and the ready file and matches the discovery file. A
// process it cannot confirm is never ended; that is reported instead. No process is ever looked up
// or ended by name.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { resolveDiscoveryDir } from '../../mock/discovery.js';
import { WorkFiles } from '../../mock/files.js';
import { parseDiscoveryFile } from '../../src/discovery/file.js';
import { pidAlive, systemProbe, type ProcessInfo } from '../../src/discovery/process.js';
import { OtcpSession } from '../../src/otcp/client.js';
import { otcpSpec } from '../support/otcp-spec.js';
import { guardDataDir, type SettingsGuard } from '../support/settings-guard.js';
import { RunnerConnection } from './connection.js';
import { establishExeGiven, readRunnerValues, type Rpc } from './exe-given.js';
import type { ContractTarget } from './target.js';

export interface ExeTargetOptions {
  /** Absolute path of the executable. */
  readonly exe: string;
  /** Arguments before the two this target adds; `--control-api` unless given. */
  readonly args?: readonly string[];
  /** How long to wait for the ready file, for the hello and for the exit; 30 s unless given. */
  readonly timeoutMs?: number;
  /** Whether a pid runs and when it started; asks the operating system unless given. */
  readonly probe?: (pid: number) => Promise<ProcessInfo>;
  /**
   * Absolute path of an existing folder. When given, each launch gets a new sub-folder of it as its
   * data folder, and that sub-folder is kept after the instance ended (only the discovery files,
   * which hold a token, are removed from it); otherwise a temporary folder that is deleted.
   */
  readonly dataDirParent?: string;
  /**
   * Absolute path of an existing folder. When given, the contents of this folder are copied into the
   * data folder of every launch before the process starts (with or without `dataDirParent`), so a
   * test starts from a known state. Only regular files and sub-folders are copied; symbolic links
   * are not followed.
   */
  readonly dataTemplate?: string;
}

export type ExeConfig = { readonly skip: string } | { readonly options: ExeTargetOptions };

/** What close() found, over all instances this target started. */
export interface ExeCleanupStats {
  /** Exited by itself after a normal stop request, discovery file removed. */
  verified: number;
  /** Ended by force; whether the instance cleans up after itself was not verified. */
  forced: number;
  /** Ended by itself as a vector that ends the instance (endsSession) asked, and cleaned up: discovery file removed. */
  endedAsAsked: number;
  /** Had already ended by itself before the vector was over, where the vector did not ask for that. */
  exitedEarly: number;
  /** Exited after a normal stop request but left its discovery file behind. */
  leftDiscoveryFile: number;
  /** Named by the ready file but not confirmed as started by this target, so left running. */
  notEnded: number;
  /** Launches whose template held the ready file or the discovery folder, which were not copied. */
  templateSkipped: number;
}

export type ExeTarget = ContractTarget & {
  readonly stats: ExeCleanupStats;
  /** Names the data folder of the next launch (only used with `dataDirParent`); consumed by that launch. */
  labelNext(label: string): void;
  /** The names (relative to `dataDirParent`) of the kept data folders launched since the last call. */
  takeDataDirs(): string[];
  /** What the close() calls since the last call found wrong with the instance; each makes its vector FAIL. */
  takeProblems(): string[];
};

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 50;
const STDERR_TAIL_CHARS = 2000;
const HELLO_ID = 'otcp-exe-hello';
/** How far two readings of one process's start time may differ (PROTOCOL.md section 5.4 rule 2). */
const START_TOLERANCE_MS = 2000;
const PROBE_ATTEMPTS = 3;
/**
 * How long to wait after closing a preparatory session. OTCP has no call that reports how many sessions
 * are open (only the limit, `maxSessions`, is specified), so the release cannot be polled; the server
 * handles the close on its next turn, which takes a few milliseconds, and 200 ms is a generous margin. If
 * it were too short, the vector's own connection would meet the session limit and the vector would fail
 * with BUSY(session_limit) instead of passing.
 */
const SESSION_CLOSE_SETTLE_MS = 200;
/** The ready file's name in the data folder, and the discovery folder below it: paths this runner itself uses. */
const READY_FILE_NAME = 'ready.json';
const DISCOVERY_DIR_PARTS = ['control', 'instances'] as const;
const READY_FILE_REF = 'schemas/discovery-file.schema.json#/$defs/readyFileKnownMembers';

/** Reads OTCP_TARGET_EXE, OTCP_TARGET_ARGS, OTCP_TARGET_TIMEOUT_MS, OTCP_TARGET_DATA_DIR and OTCP_TARGET_DATA_TEMPLATE. Throws on a bad value. */
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
  let dataDirParent: string | undefined;
  const rawDataDir = env.OTCP_TARGET_DATA_DIR;
  if (rawDataDir !== undefined && rawDataDir !== '') {
    checkDataDirParent(rawDataDir);
    dataDirParent = rawDataDir;
  }
  let dataTemplate: string | undefined;
  const rawTemplate = env.OTCP_TARGET_DATA_TEMPLATE;
  if (rawTemplate !== undefined && rawTemplate !== '') {
    checkDataTemplate(rawTemplate);
    dataTemplate = rawTemplate;
  }
  return {
    options: {
      exe,
      ...(args && { args }),
      ...(timeoutMs && { timeoutMs }),
      ...(dataDirParent && { dataDirParent }),
      ...(dataTemplate && { dataTemplate }),
    },
  };
}

/**
 * The template folder must be an absolute path to an existing directory. `name` is the variable it
 * came from, for the error (a scenario can take its template from a variable of its own).
 */
export function checkDataTemplate(dir: string, name = 'OTCP_TARGET_DATA_TEMPLATE'): void {
  if (!path.isAbsolute(dir)) throw new Error(`${name} must be an absolute path`);
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir) throw new Error(`${name} is not an existing directory`);
}

/**
 * Whether `rel` (a path relative to the data folder, as its parts) is one this runner uses itself:
 * the ready file at the top, or the discovery folder. Windows and macOS compare file names without
 * regard to case by default, so there `Ready.json` or `Control/Instances` is the same path and is
 * matched as well.
 */
export function isRunnerPath(rel: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  const fold =
    platform === 'win32' || platform === 'darwin' ? (name: string) => name.toLowerCase() : (name: string) => name;
  const parts = rel.map(fold);
  return (
    (parts.length === 1 && parts[0] === fold(READY_FILE_NAME)) ||
    (parts.length === DISCOVERY_DIR_PARTS.length &&
      parts.every((part, i) => part === fold(DISCOVERY_DIR_PARTS[i] ?? '')))
  );
}

/**
 * Copies the contents of `from` into `to`: regular files and sub-folders only, links are skipped.
 * The paths this runner uses itself (isRunnerPath: the ready file at the top, the discovery folder)
 * are not copied: a stale one would be taken for the new instance's. Returns whether any was skipped.
 */
export async function copyTemplate(from: string, to: string, rel: readonly string[] = []): Promise<boolean> {
  let skipped = false;
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const here = [...rel, entry.name];
    if (isRunnerPath(here)) {
      skipped = true;
      continue;
    }
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await mkdir(target, { recursive: true });
      if (await copyTemplate(source, target, here)) skipped = true;
    } else if (entry.isFile()) {
      await copyFile(source, target);
    }
  }
  return skipped;
}

/** The folder for kept data folders must be an absolute path to an existing directory. */
function checkDataDirParent(dir: string): void {
  if (!path.isAbsolute(dir)) throw new Error('OTCP_TARGET_DATA_DIR must be an absolute path');
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir) throw new Error('OTCP_TARGET_DATA_DIR is not an existing directory');
}

/** A folder-name prefix from a label (a vector id has slashes): safe characters only, and not long. */
function folderPrefix(label: string): string {
  const safe = label
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${safe === '' ? 'run' : safe}-`;
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

/** Resolves true when `event` settles within `ms`, false otherwise; the timer never outlives it. */
async function within(event: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([event.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Sends a signal; false when the process is gone already. */
function signal(pid: number, name: NodeJS.Signals): boolean {
  try {
    process.kill(pid, name);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** Waits until no process with `pid` runs; false when one still does after `ms`. */
async function gone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (pidAlive(pid) === false) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

const sameStart = (a: number, b: number) => Math.abs(a - b) <= START_TOLERANCE_MS;

/** How the instance ended. */
type Ending =
  | { readonly how: 'clean' }
  | { readonly how: 'forced' }
  | { readonly how: 'exited'; readonly detail: string }
  | { readonly how: 'notEnded'; readonly detail: string };

/** The process the ready file names, when it is not the started one and was confirmed as coming from this launch. */
interface Owned {
  readonly pid: number;
  readonly startTimeMs: number;
}

type Hello = { readonly protocol: string; readonly capabilities: string[] } | { readonly problem: string };

/** A session.hello of the target's own, checked against the discovery file (PROTOCOL.md section 4.3). */
async function ownHello(discovery: Record<string, unknown>, timeoutMs: number): Promise<Hello> {
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
    if (line === 'closed' || line === 'timeout') return { problem: `session.hello got no answer (${line})` };
    let message: unknown;
    try {
      message = JSON.parse(line.toString('utf8'));
    } catch {
      // Not the parser's message: it can quote the line, and the line holds the server proof.
      return { problem: 'session.hello got an answer that is not JSON' };
    }
    const result = isObject(message) && isObject(message.result) ? message.result : undefined;
    if (result === undefined) return { problem: 'session.hello did not succeed' };
    const differs = ['serverProof', 'instanceId', 'pid'].filter((member) => result[member] !== discovery[member]);
    if (differs.length > 0) {
      return { problem: `the session.hello result differs from the discovery file in ${differs.join(', ')}` };
    }
    if (!Array.isArray(result.capabilities) || typeof result.protocol !== 'string') {
      return { problem: 'the session.hello result has no capabilities or protocol' };
    }
    return {
      protocol: result.protocol,
      capabilities: result.capabilities.filter((c): c is string => typeof c === 'string'),
    };
  } catch (error) {
    return { problem: `session.hello failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    conn?.destroy();
  }
}

export function exeTarget(options: ExeTargetOptions): ExeTarget {
  checkExe(options.exe);
  if (options.dataDirParent !== undefined) checkDataDirParent(options.dataDirParent);
  if (options.dataTemplate !== undefined) checkDataTemplate(options.dataTemplate);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // A probe of its own per question, so no start time is remembered across a reuse of the pid.
  const probeOnce = options.probe ?? ((pid: number) => systemProbe().probe(pid));
  // Reading a start time runs a system tool with a time limit (PowerShell on Windows), which a
  // busy machine can miss; an unknown answer is asked again before it counts.
  const probe = async (pid: number): Promise<ProcessInfo> => {
    let info = await probeOnce(pid);
    for (let attempt = 1; attempt < PROBE_ATTEMPTS && info.alive !== false && info.startTimeMs === null; attempt++) {
      info = await probeOnce(pid);
    }
    return info;
  };
  const stats: ExeCleanupStats = {
    verified: 0,
    forced: 0,
    endedAsAsked: 0,
    exitedEarly: 0,
    leftDiscoveryFile: 0,
    notEnded: 0,
    templateSkipped: 0,
  };
  let problems: string[] = [];
  let nextLabel: string | undefined;
  let dataDirs: string[] = [];

  const notEndedNote = (pid: number, reason: string) =>
    `pid ${String(pid)}, named by the ready file, could not be confirmed as started by this target (${reason}); ` +
    'it was not ended';

  /** Whether `pid` is the process this launch started: why not, or its start time. */
  const confirm = async (
    pid: number,
    discovery: unknown,
    nonce: string,
    launchedAtMs: number,
    readyAtMs: number,
  ): Promise<Owned | string> => {
    if (!isObject(discovery)) return 'it has no readable discovery file';
    if (discovery.pid !== pid) return 'its discovery file names another pid';
    if (discovery.launchNonce !== nonce) return 'its discovery file does not carry the launch nonce';
    const info = await probe(pid);
    if (info.alive !== true) return info.alive === false ? 'it is not running' : 'whether it runs is unknown';
    const started = info.startTimeMs;
    if (started === null) return 'the operating system did not report its start time';
    if (started < launchedAtMs - START_TOLERANCE_MS || started > readyAtMs + START_TOLERANCE_MS) {
      return 'it did not start between the launch and the ready file';
    }
    const recorded = discovery.processStartTimeMs;
    if (typeof recorded !== 'number' || !sameStart(started, recorded)) {
      return 'its start time is not the processStartTimeMs of its discovery file';
    }
    return { pid, startTimeMs: started };
  };

  /** Ends a confirmed process that this target did not start itself, after checking it is still that process. */
  const stopOwned = async (owned: Owned, graceful: boolean): Promise<Ending> => {
    const now = await probe(owned.pid);
    const notRunning = { how: 'exited', detail: `pid ${String(owned.pid)} no longer ran` } as const;
    if (now.alive === false) return notRunning;
    if (now.alive !== true || now.startTimeMs === null) {
      return { how: 'notEnded', detail: notEndedNote(owned.pid, 'its start time could not be read again') };
    }
    // Another process with the same pid: the instance itself ended.
    if (!sameStart(now.startTimeMs, owned.startTimeMs)) return notRunning;
    const normal = graceful && process.platform !== 'win32';
    if (!signal(owned.pid, normal ? 'SIGTERM' : 'SIGKILL')) return notRunning;
    if (await gone(owned.pid, timeoutMs)) return normal ? { how: 'clean' } : { how: 'forced' };
    // Still there after the time allowed: by force, if it still is that process.
    const again = await probe(owned.pid);
    if (again.alive === true && again.startTimeMs !== null && sameStart(again.startTimeMs, owned.startTimeMs)) {
      signal(owned.pid, 'SIGKILL');
      await gone(owned.pid, timeoutMs);
    }
    return { how: 'forced' };
  };

  return {
    name: 'exe',
    stats,
    takeProblems() {
      const taken = problems;
      problems = [];
      return taken;
    },
    labelNext(label) {
      nextLabel = label;
    },
    takeDataDirs() {
      const taken = dataDirs;
      dataDirs = [];
      return taken;
    },
    async open() {
      const keep = options.dataDirParent !== undefined;
      let dataDir: string;
      if (options.dataDirParent === undefined) {
        dataDir = await mkdtemp(path.join(os.tmpdir(), 'ot-exe-'));
      } else {
        // A folder of its own per launch (the random tail keeps two launches of one label apart).
        dataDir = await mkdtemp(path.join(options.dataDirParent, folderPrefix(nextLabel ?? 'run')));
        dataDirs.push(path.basename(dataDir));
      }
      nextLabel = undefined;
      const instancesDir = path.join(dataDir, ...DISCOVERY_DIR_PARTS);
      const readyFile = path.join(dataDir, READY_FILE_NAME);
      const nonce = randomBytes(24).toString('base64url');
      let secrets: string[] = [nonce];
      let child: ChildProcess | undefined;
      let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let exitEvent: Promise<void> = Promise.resolve();
      let spawnError: Error | undefined;
      let stderrTail = '';
      /** The pid of the instance, once the ready file names it. */
      let instancePid: number | undefined = undefined;
      let owned: Owned | undefined;
      let unconfirmed: string | undefined;
      /** Whether the runner sent the call that makes the instance end by itself (endRequested was called). */
      let endAsked = false;
      /** The snapshot of the settings files of the data folder, taken before the start. */
      let settings: SettingsGuard | undefined;

      const redacted = (text: string) => {
        let out = text.replace(/[0-9a-fA-F]{32,}/g, '[redacted]');
        for (const secret of secrets) if (secret !== '') out = out.replaceAll(secret, '[redacted]');
        return out;
      };
      const describe = (problem: string) => {
        const tail = stderrTail.trim();
        return redacted(`${problem}${tail === '' ? '' : `; stderr tail:\n${tail}`}`);
      };
      const exitState = () => exited;
      const exitText = () => (exited === undefined ? 'unknown' : (exited.signal ?? `exit code ${String(exited.code)}`));

      // Ends the process this target started. Windows has no normal stop request to send, so
      // there kill() ends it outright and the clean-up on exit cannot be verified.
      const stopChild = async (graceful: boolean): Promise<Ending> => {
        const proc = child;
        if (proc?.pid === undefined) return { how: 'exited', detail: 'it did not start' };
        // Gone already, and the exit event is on its way.
        if (exited === undefined && pidAlive(proc.pid) === false) await within(exitEvent, timeoutMs);
        if (exited !== undefined) return { how: 'exited', detail: exitText() };
        const normal = graceful && process.platform !== 'win32';
        proc.kill(normal ? 'SIGTERM' : 'SIGKILL');
        if (!(await within(exitEvent, timeoutMs))) {
          proc.kill('SIGKILL');
          await within(exitEvent, timeoutMs);
          return { how: 'forced' };
        }
        // Read again: the exit came while this function waited.
        return normal && exitState()?.code === 0 ? { how: 'clean' } : { how: 'forced' };
      };
      // Ends the instance: the started process, or the confirmed process it started and then the
      // started process (the launcher) if it still runs. An unconfirmed process is left alone.
      const end = async (graceful: boolean): Promise<Ending> => {
        if (instancePid === undefined || instancePid === child?.pid) return stopChild(graceful);
        const ending =
          owned === undefined
            ? ({ how: 'notEnded', detail: notEndedNote(instancePid, unconfirmed ?? 'not checked') } as const)
            : await stopOwned(owned, graceful);
        await stopChild(false);
        return ending;
      };
      const removeDataDir = async (): Promise<string | undefined> => {
        try {
          if (keep) {
            // Logs and preferences stay; the discovery files hold a token of an instance that is gone.
            await rm(instancesDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          } else {
            await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          }
          return undefined;
        } catch {
          return keep
            ? 'the discovery files in the kept data folder could not be removed'
            : 'the temporary data folder could not be removed';
        }
      };
      /** Compares the settings files with the snapshot and puts them back; what differed or stayed wrong. */
      const settingsProblems = async (): Promise<readonly string[]> => {
        try {
          return (await settings?.finish()) ?? [];
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          return [`the settings of the data folder could not be checked: ${why}`];
        }
      };
      const fail = async (problem: string): Promise<never> => {
        const notes = [problem];
        try {
          const ending = await end(false);
          if (ending.how === 'notEnded') {
            stats.notEnded++;
            notes.push(ending.detail);
          }
        } catch (error) {
          notes.push(`stopping it failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        notes.push(...(await settingsProblems()));
        const removal = await removeDataDir();
        if (removal !== undefined) notes.push(removal);
        throw new Error(describe(notes.join('; ')));
      };

      const launchedAtMs = Date.now();
      try {
        // Never a real OpenTune folder, whatever the temporary directory is.
        resolveDiscoveryDir(instancesDir);
        if (options.dataTemplate !== undefined && (await copyTemplate(options.dataTemplate, dataDir))) {
          stats.templateSkipped++;
        }
        settings = await guardDataDir(dataDir);
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
        await removeDataDir();
        throw error;
      }
      const started = child;
      exitEvent = new Promise<void>((resolve) => {
        started.once('exit', (code, sig) => {
          exited = { code, signal: sig };
          resolve();
        });
      });
      started.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
      });
      started.once('error', (error) => {
        spawnError = error;
      });

      // Wait for the ready file; a process that ends first is a failure at once, unless it is a
      // launcher whose instance writes the ready file after it.
      const deadline = Date.now() + timeoutMs;
      let ready: unknown;
      for (;;) {
        if (spawnError !== undefined) return fail(`the executable could not be started: ${spawnError.message}`);
        ready = existsSync(readyFile) ? await readJson(readyFile) : undefined;
        if (ready !== undefined) break;
        if (exited !== undefined && exited.code !== 0) {
          return fail(`the process ended (${exitText()}) before it wrote the ready file`);
        }
        if (Date.now() >= deadline) {
          const after = exited === undefined ? '' : ` (the started process had ended with ${exitText()})`;
          return fail(`no ready file within ${String(timeoutMs)} ms${after}`);
        }
        await sleep(POLL_MS);
      }
      const readyAtMs = Date.now();
      const files = new WorkFiles();
      let runnerValues: Readonly<Record<string, string | number>> = {};
      const readyProblems = otcpSpec().validate(READY_FILE_REF, ready);
      if (readyProblems.length > 0 || !isObject(ready)) {
        return fail(`the ready file is not valid: ${readyProblems.join('; ')}`);
      }
      const readyPid = ready.pid as number;
      instancePid = readyPid;

      const discoveryFile = path.join(instancesDir, `${String(readyPid)}.json`);
      const discovery = await readJson(discoveryFile);
      if (isObject(discovery)) {
        secrets = [nonce, discovery.token, discovery.serverProof].filter((v): v is string => typeof v === 'string');
      }
      if (readyPid !== started.pid) {
        // A launcher: the instance is another process, which may be ended only once confirmed.
        const confirmation = await confirm(readyPid, discovery, nonce, launchedAtMs, readyAtMs);
        if (typeof confirmation === 'string') unconfirmed = confirmation;
        else owned = confirmation;
      }
      if (!isObject(discovery))
        return fail(`no readable discovery file for pid ${String(readyPid)} in control/instances`);
      if (discovery.pid !== readyPid) return fail('the discovery file names another pid than the ready file');
      if (discovery.instanceId !== ready.instanceId) {
        return fail('the discovery file and the ready file differ in instanceId');
      }
      if (discovery.launchNonce !== nonce) return fail('the launch nonce of the discovery file is not the one passed');
      if (unconfirmed !== undefined)
        return fail(`the ready file names pid ${String(readyPid)}, not the started process`);

      /** A session for the preparatory calls of one precondition or reading, closed afterwards. */
      const withRpc = async <T>(use: (rpc: Rpc) => Promise<T>): Promise<T> => {
        const parsed = parseDiscoveryFile(`${String(readyPid)}.json`, await readFile(discoveryFile));
        if (!parsed.ok) throw new Error(`the discovery file is not valid: ${parsed.problem}`);
        const session = await OtcpSession.open(parsed.entry, timeoutMs);
        try {
          return await use(session);
        } finally {
          session.close();
          // The server notices the close on its own turn; the vector needs to be the only connection.
          await sleep(SESSION_CLOSE_SETTLE_MS);
        }
      };
      // The capabilities come from a session.hello of this target's own; the runner opens its own connections.
      const hello = await ownHello(discovery, timeoutMs);
      if ('problem' in hello) return fail(hello.problem);
      await settings.settle();

      return {
        discovery,
        protocol: hello.protocol,
        capabilities: hello.capabilities,
        // Preparatory calls of a session of its own, closed before the vector connects: the runner makes
        // sure its connections are the only ones. What cannot be made stays a skipped precondition.
        establish: (given) =>
          Object.keys(given).length === 0
            ? Promise.resolve({})
            : withRpc((rpc) =>
                establishExeGiven(given, {
                  rpc,
                  files,
                  capabilities: hello.capabilities,
                  saveTarget: () => files.provide({ bind: 'saved', kind: 'absent', extension: '.otproj' }).saved ?? '',
                }),
              ),
        runnerValue: (name) => runnerValues[name],
        async prepareRunnerValues() {
          runnerValues = await withRpc((rpc) => readRunnerValues(rpc, String(discovery.instanceId)));
        },
        // The runner is about to send the call that makes the instance quit (a vector with endsSession): the end
        // that follows is asked for, also when the vector fails before expectEnded() runs.
        endRequested() {
          endAsked = true;
        },
        // The instance quits by itself (a vector with endsSession): its exit, when the target started the
        // process; the removal of its discovery file. Never ends the instance (close() does that, if it is
        // still there).
        async expectEnded(waitMs) {
          const found: string[] = [];
          const notChecked: string[] = [];
          const waitUntil = Date.now() + waitMs;
          const remaining = () => Math.max(0, waitUntil - Date.now());
          if (instancePid === child.pid) {
            if (await within(exitEvent, remaining())) {
              const status = exitState();
              if (status?.code !== 0)
                found.push(`the process exited by itself with ${exitText()}, expected exit code 0`);
            } else {
              found.push(`the process did not exit within ${String(waitMs)} ms after the instance was to end`);
            }
          } else {
            // A launcher started the instance: the process is not the one this target started, so only that it
            // is gone can be seen, not how it exited.
            if (!(await gone(instancePid, remaining()))) {
              found.push(`the process did not exit within ${String(waitMs)} ms after the instance was to end`);
            }
            notChecked.push('the exit status of the instance (started by a launcher, not by this target)');
          }
          if (existsSync(discoveryFile)) found.push('the instance left its discovery file behind');
          if (found.length === 0) stats.endedAsAsked++;
          return { problems: found.map(redacted), notChecked };
        },
        // Never throws: the runner's result for the vector must survive. What goes wrong here is
        // left for takeProblems(), which makes the vector FAIL.
        async close() {
          const found: string[] = [];
          try {
            const ending = await end(true);
            if (ending.how === 'clean') {
              if (existsSync(discoveryFile)) {
                stats.leftDiscoveryFile++;
                found.push('the instance exited after a normal stop request but left its discovery file behind');
              } else {
                stats.verified++;
              }
            } else if (ending.how === 'forced') {
              // Ended by force: the clean-up on exit was not verified.
              stats.forced++;
            } else if (ending.how === 'exited') {
              // The runner sent the call that makes the instance end: the checks are in expectEnded, or the vector
              // failed first and says why; it is no early end.
              if (!endAsked) {
                stats.exitedEarly++;
                found.push(`the instance ended by itself before the vector was over (${ending.detail})`);
              }
            } else {
              stats.notEnded++;
              found.push(ending.detail);
            }
          } catch (error) {
            found.push(`stopping the instance failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          found.push(...(await settingsProblems()));
          files.dispose();
          const removal = await removeDataDir();
          if (removal !== undefined) found.push(removal);
          problems.push(...found.map(redacted));
        },
      };
    },
  };
}
