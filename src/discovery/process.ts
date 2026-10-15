// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// What the operating system says about processes: whether a pid is running, when it started, and
// which OpenTune processes run. Used to recognise stale discovery files (spec/otcp/v1/PROTOCOL.md
// section 5.4 rule 2) and an OpenTune that runs without the control API. This module only looks:
// it never signals, stops or starts a process (process.kill with signal 0 only tests existence).
// Every system tool is run by absolute path, without a shell, with a time limit.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface ProcessInfo {
  /** null when it cannot be determined. */
  readonly alive: boolean | null;
  /** Start time in ms since the Unix epoch, or null when unknown. */
  readonly startTimeMs: number | null;
}

export interface ProcessProbe {
  probe(pid: number): Promise<ProcessInfo>;
  /** Pids of running OpenTune processes, or null when they cannot be listed. */
  listOpenTune(): Promise<readonly number[] | null>;
}

/** Whether a process with this pid exists. EPERM means it exists but belongs to someone else. */
export function pidAlive(
  pid: number,
  kill: (pid: number, signal: 0) => unknown = (p, s) => process.kill(p, s),
): boolean | null {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return code === 'EPERM' ? true : null;
  }
}

/** Linux: start time from /proc/<pid>/stat (field 22, clock ticks after boot) and btime in /proc/stat. */
export function parseProcStartTime(stat: string, procStat: string, ticksPerSecond = 100): number | null {
  // The command name (field 2) is in parentheses and may contain spaces and parentheses itself.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(fields[19]);
  const btime = Number(/^btime (\d+)$/m.exec(procStat)?.[1]);
  return Number.isFinite(ticks) && Number.isFinite(btime)
    ? Math.round(btime * 1000 + (ticks * 1000) / ticksPerSecond)
    : null;
}

/** Windows: pids from `tasklist /FO CSV /NH` lines whose image name is OpenTune.exe. */
export function parseTasklist(csv: string): number[] {
  return [...csv.matchAll(/^"OpenTune\.exe","(\d+)"/gim)].map((m) => Number(m[1]));
}

/** Pids printed one per line (pgrep). */
export function parsePidLines(text: string): number[] {
  return text
    .split(/\r?\n/)
    .filter((line) => /^\d+$/.test(line.trim()))
    .map((line) => Number(line.trim()));
}

/** A number of ms since the epoch printed on a line of its own, or null. */
export function parseEpochMs(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() !== '' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

const TOOL_TIMEOUT_MS = 5000;

/** Runs a system tool; resolves with its stdout, or null if it failed, was missing or timed out. */
function run(file: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: TOOL_TIMEOUT_MS, windowsHide: true, shell: false, encoding: 'utf8', ...(env ? { env } : {}) },
      (error, stdout) => {
        resolve(error ? null : stdout);
      },
    );
  });
}

const system32 = (tool: string) => path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', tool);

async function startTime(pid: number): Promise<number | null> {
  if (process.platform === 'linux') {
    const [stat, procStat] = await Promise.all([
      readFile(`/proc/${String(pid)}/stat`, 'utf8').catch(() => null),
      readFile('/proc/stat', 'utf8').catch(() => null),
    ]);
    return stat === null || procStat === null ? null : parseProcStartTime(stat, procStat);
  }
  if (process.platform === 'win32') {
    const command = `[DateTimeOffset]::new((Get-Process -Id ${String(pid)} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`;
    const out = await run(system32('WindowsPowerShell\\v1.0\\powershell.exe'), [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ]);
    return out === null ? null : parseEpochMs(out);
  }
  // macOS and other systems: ps prints the start time in seconds; the probe tolerates 2 s.
  const out = await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { ...process.env, LC_ALL: 'C', TZ: 'UTC' });
  const ms = out === null ? Number.NaN : Date.parse(`${out.trim()} UTC`);
  return Number.isFinite(ms) ? ms : null;
}

/** The probe of the running system. Start times are cached per pid while the pid stays alive. */
export function systemProbe(): ProcessProbe {
  const starts = new Map<number, number>();
  return {
    async probe(pid) {
      const alive = pidAlive(pid);
      if (alive !== true) {
        starts.delete(pid);
        return { alive, startTimeMs: null };
      }
      const cached = starts.get(pid);
      if (cached !== undefined) return { alive, startTimeMs: cached };
      const startTimeMs = await startTime(pid);
      if (startTimeMs !== null) starts.set(pid, startTimeMs);
      return { alive, startTimeMs };
    },
    async listOpenTune() {
      if (process.platform === 'win32') {
        const out = await run(system32('tasklist.exe'), ['/FI', 'IMAGENAME eq OpenTune.exe', '/FO', 'CSV', '/NH']);
        return out === null ? null : parseTasklist(out);
      }
      // pgrep exits with status 1 when nothing matches, which run() reports as a failure.
      const out = await run('/usr/bin/pgrep', ['-x', 'OpenTune']);
      return out === null ? [] : parsePidLines(out);
    },
  };
}
