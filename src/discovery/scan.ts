// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Scanning the discovery directory (spec/otcp/v1/PROTOCOL.md section 5.4). A file is stale when its
// process is not running, or when a process with its pid runs but started at another time (the pid
// was reused). Only a file whose process is known to be gone is deleted, and only if it still has
// the content that was judged; a file whose state cannot be determined is kept and treated as live,
// because the session.hello check (serverProof, instanceId, pid) still protects the connection.

import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { DISCOVERY_FILE_RE, parseDiscoveryFile, readDiscoveryBytes, type DiscoveryEntry } from './file.js';
import type { ProcessProbe } from './process.js';

/** Start times that differ by more than this mean the pid now belongs to another process. */
export const START_TIME_TOLERANCE_MS = 2000;

export type IgnoredReason = 'invalid' | 'process_gone' | 'pid_reused' | 'unreadable';

export interface IgnoredFile {
  readonly file: string;
  readonly reason: IgnoredReason;
  /** Why the file is invalid (never quotes its content); null for the other reasons. */
  readonly problem: string | null;
  /** The stale file was deleted. */
  readonly removed: boolean;
}

export interface ScanResult {
  readonly dir: string;
  /** The directory does not exist yet (no instance has ever written to it). */
  readonly missing: boolean;
  /** Files of instances that may be running, ordered by start time (oldest first). */
  readonly instances: readonly DiscoveryEntry[];
  readonly ignored: readonly IgnoredFile[];
}

export async function scanDiscovery(dir: string, probe: ProcessProbe): Promise<ScanResult> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => DISCOVERY_FILE_RE.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { dir, missing: true, instances: [], ignored: [] };
    throw error;
  }
  const instances: DiscoveryEntry[] = [];
  const ignored: IgnoredFile[] = [];
  for (const file of names) {
    const full = path.join(dir, file);
    const bytes = await readDiscoveryBytes(full);
    if (bytes === null) {
      ignored.push({ file, reason: 'unreadable', problem: null, removed: false });
      continue;
    }
    const parsed = parseDiscoveryFile(file, bytes);
    if (!parsed.ok) {
      ignored.push({ file, reason: 'invalid', problem: parsed.problem, removed: false });
      continue;
    }
    const { entry } = parsed;
    const info = await probe.probe(entry.pid);
    if (info.alive === false) {
      ignored.push({ file, reason: 'process_gone', problem: null, removed: await removeIfUnchanged(full, bytes) });
    } else if (
      info.alive === true &&
      info.startTimeMs !== null &&
      Math.abs(info.startTimeMs - entry.processStartTimeMs) > START_TIME_TOLERANCE_MS
    ) {
      ignored.push({ file, reason: 'pid_reused', problem: null, removed: false });
    } else {
      instances.push(entry);
    }
  }
  instances.sort((a, b) => a.processStartTimeMs - b.processStartTimeMs || a.pid - b.pid);
  return { dir, missing: false, instances, ignored };
}

/** Deletes a stale file unless it changed since it was read (a new instance may reuse the name). */
async function removeIfUnchanged(file: string, judged: Buffer): Promise<boolean> {
  const now = await readDiscoveryBytes(file);
  if (!now?.equals(judged)) return false;
  return unlink(file).then(
    () => true,
    () => false,
  );
}
