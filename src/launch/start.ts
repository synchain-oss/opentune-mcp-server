// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Starting the configured OpenTune executable: the only place where this server creates a process
// that outlives a tool call. The process is spawned without a shell, detached, with its standard
// streams ignored (so it never writes into the MCP stream), and unreferenced, so that the server
// can exit while OpenTune keeps running. The command line is fixed: the control API switch, the
// ready file, the launch nonce and, when this server reads another discovery directory than
// OpenTune's default, that directory. Tool input reaches none of it. Nothing here signals or
// stops a process.

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import { systemInstallDetector, type InstallDetector } from './install.js';

export type SpawnFn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** What opentune_launch needs from the system; tests replace the parts that start processes. */
export interface LaunchDeps {
  /** child_process.spawn unless a test replaces it. */
  readonly spawn: SpawnFn;
  readonly officialInstall: InstallDetector;
  /** How long a start waits for the instance to announce itself. */
  readonly waitMs: number;
  /** Interval of the checks while waiting. */
  readonly pollMs: number;
}

/** How long opentune_launch waits for a started OpenTune. */
export const LAUNCH_WAIT_MS = 30_000;

export function systemLaunchDeps(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): LaunchDeps {
  return {
    spawn: (file, args, options) => spawn(file, [...args], options),
    officialInstall: systemInstallDetector(env, platform),
    waitMs: LAUNCH_WAIT_MS,
    pollMs: 250,
  };
}

/** The options of every start. */
export const SPAWN_OPTIONS = { shell: false, detached: true, stdio: 'ignore' } as const;

export interface StartRequest {
  /** The checked OPENTUNE_MCP_OPENTUNE_PATH. */
  readonly exe: string;
  readonly cwd: string;
  /** This server's environment, unchanged. */
  readonly env: NodeJS.ProcessEnv;
  readonly readyFile: string;
  readonly nonce: string;
  /** Passed as --control-api-dir= when not null. */
  readonly discoveryDir: string | null;
}

/** A path for an option value: without trailing separators, which OpenTune rejects (empty segment). */
const optionPath = (p: string) => p.replace(/(?<=[^:\\/])[\\/]+$/, '');

export function launchArgs(request: StartRequest): string[] {
  return [
    '--control-api',
    ...(request.discoveryDir === null ? [] : [`--control-api-dir=${optionPath(request.discoveryDir)}`]),
    `--control-api-ready-file=${request.readyFile}`,
    `--control-api-launch-nonce=${request.nonce}`,
  ];
}

export type Started =
  | { readonly ok: true; readonly pid: number; readonly exited: () => boolean }
  | { readonly ok: false; readonly code: string };

const errorCode = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN';
};

/** Spawns the process. Resolves with its pid, or with the error code when it could not be started. */
export async function startProcess(spawnFn: SpawnFn, request: StartRequest): Promise<Started> {
  let child: ChildProcess;
  try {
    child = spawnFn(request.exe, launchArgs(request), { ...SPAWN_OPTIONS, cwd: request.cwd, env: request.env });
  } catch (error) {
    return { ok: false, code: errorCode(error) };
  }
  let failure: unknown = null;
  let exited = false;
  // Without a listener an 'error' event would end this server.
  const failed = new Promise<void>((resolve) => {
    child.on('error', (error) => {
      failure = error;
      resolve();
    });
  });
  child.once('exit', () => {
    exited = true;
  });
  const { pid } = child;
  if (pid === undefined) {
    // A process that could not be created reports why on the next turn of the event loop.
    await Promise.race([
      failed,
      new Promise((resolve) => {
        setTimeout(resolve, 1000).unref();
      }),
    ]);
    return { ok: false, code: errorCode(failure) };
  }
  child.unref();
  return { ok: true, pid, exited: () => exited };
}
