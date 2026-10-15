// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Bookkeeping of the OpenTune processes this server started: `<discovery dir>/launching/<pid>.json`
// holds the pid, the time of the start and the SHA-256 of the launch nonce (never the nonce itself,
// never a token). While such a process runs without a discovery file, opentune_get_status reports
// it as STARTING, and opentune_launch calls that arrive meanwhile wait for it instead of starting
// another one. The same directory holds the ready files OpenTune writes for those starts and a
// lock file that makes "decide whether to start, start, write the record" one step for every
// server process on the machine. The discovery scan ignores the directory (its name is not
// `<pid>.json`). Nothing here starts, signals or stops a process.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MAX_DISCOVERY_BYTES, readDiscoveryBytes } from '../discovery/file.js';
import type { ProcessProbe } from '../discovery/process.js';

export const LAUNCH_DIR = 'launching';
const RECORD_RE = /^[1-9][0-9]*\.json$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{32}$/;
const LOCK_FILE = 'launch.lock';
/** A lock file older than this is left over by a server that ended while it held it. */
export const LOCK_STALE_MS = 20_000;
/** The operating system's start time of a recorded process lies within this of the recorded time. */
export const START_SLACK_MS = 10_000;

export interface LaunchRecord {
  readonly pid: number;
  /** When this server started the process, in ms since the Unix epoch. */
  readonly startedAtMs: number;
  /** SHA-256 (hex) of the launch nonce passed to the process. */
  readonly nonceHash: string;
}

/** A recorded process that still runs: within the launch wait (`pending`) or past it (`stuck`). */
export interface LiveRecord {
  readonly record: LaunchRecord;
  readonly state: 'pending' | 'stuck';
}

export const launchDir = (discoveryDir: string) => path.join(discoveryDir, LAUNCH_DIR);

export const nonceHash = (nonce: string) => createHash('sha256').update(nonce, 'utf8').digest('hex');

/** A launch nonce: 32 characters of A-Z a-z 0-9 _ - (24 random bytes). */
export const newNonce = () => randomBytes(24).toString('base64url');

/** The ready file of a start, named after its nonce hash so that the record leads to it. */
export const readyFilePath = (dir: string, hash: string) => path.join(dir, `${hash.slice(0, 32)}.ready`);

const isInt = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;

function parseRecord(fileName: string, bytes: Buffer): LaunchRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (!isInt(v.pid, 1) || !isInt(v.startedAtMs, 0) || typeof v.nonceHash !== 'string' || !HASH_RE.test(v.nonceHash))
    return null;
  if (`${String(v.pid)}.json` !== fileName) return null;
  return { pid: v.pid, startedAtMs: v.startedAtMs, nonceHash: v.nonceHash };
}

/** The valid records in `dir`, newest first; an invalid or unreadable file is skipped. */
export async function readRecords(dir: string): Promise<LaunchRecord[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const records: LaunchRecord[] = [];
  for (const name of names.filter((n) => RECORD_RE.test(n))) {
    const bytes = await readDiscoveryBytes(path.join(dir, name));
    const record = bytes === null ? null : parseRecord(name, bytes);
    if (record) records.push(record);
  }
  return records.sort((a, b) => b.startedAtMs - a.startedAtMs);
}

/** Writes `<pid>.json` through a temporary file and a rename, so that readers never see half of it. */
export async function writeRecord(dir: string, record: LaunchRecord): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${String(record.pid)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temp, path.join(dir, `${String(record.pid)}.json`));
  } finally {
    await rm(temp, { force: true });
  }
}

/** Deletes a record and the ready file of its start. */
export async function removeRecord(dir: string, record: LaunchRecord): Promise<void> {
  await rm(path.join(dir, `${String(record.pid)}.json`), { force: true }).catch(() => undefined);
  await rm(readyFilePath(dir, record.nonceHash), { force: true }).catch(() => undefined);
}

/**
 * The records whose process still runs. A process that is gone, or whose pid now belongs to a
 * process started at another time, ends its record; with `cleanup` such records are deleted.
 */
export async function liveRecords(
  dir: string,
  deps: { readonly probe: ProcessProbe; readonly now: number; readonly waitMs: number; readonly cleanup: boolean },
): Promise<LiveRecord[]> {
  const live: LiveRecord[] = [];
  for (const record of await readRecords(dir)) {
    const info = await deps.probe.probe(record.pid);
    const reused =
      info.alive === true &&
      info.startTimeMs !== null &&
      Math.abs(info.startTimeMs - record.startedAtMs) > START_SLACK_MS;
    if (info.alive === false || reused) {
      if (deps.cleanup) await removeRecord(dir, record);
      continue;
    }
    live.push({ record, state: deps.now - record.startedAtMs < deps.waitMs ? 'pending' : 'stuck' });
  }
  return live;
}

/** `{pid, instanceId}` of a ready file (`$defs/readyFileKnownMembers`; other members are ignored), or null. */
export async function readReadyFile(file: string): Promise<{ pid: number; instanceId: string } | null> {
  const bytes = await readDiscoveryBytes(file);
  if (bytes === null || bytes.length > MAX_DISCOVERY_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const v = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Record<
    string,
    unknown
  >;
  return isInt(v.pid, 1) && typeof v.instanceId === 'string' && HEX128.test(v.instanceId)
    ? { pid: v.pid, instanceId: v.instanceId }
    : null;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** How long a refused creation of the lock file counts as a lock being released, not as an error. */
export const LOCK_DENIED_MS = 2000;

/** The file operations of the lock; tests replace them to force a particular interleaving of calls. */
export interface LockFiles {
  /** Creates the lock file; fails with EEXIST when it exists. */
  readonly create: (file: string) => Promise<void>;
  /** The modification time of a file in ms since the Unix epoch, or null when it cannot be read. */
  readonly modified: (file: string) => Promise<number | null>;
}

export const LOCK_FILES: LockFiles = {
  create: async (file) => {
    const handle = await open(file, 'wx', 0o600);
    await handle.close();
  },
  modified: (file) =>
    stat(file).then(
      (s) => s.mtimeMs,
      () => null,
    ),
};

/**
 * Removes the lock file `file` if it is older than LOCK_STALE_MS, and tells whether it did. The file
 * is first renamed to a name of its own, which only one caller can do, and checked there: when
 * another call has replaced the stale lock with its own lock in the meantime, that lock was moved
 * and is put back instead of being deleted.
 */
export async function removeStaleLock(file: string, files: LockFiles = LOCK_FILES): Promise<boolean> {
  const moved = `${file}.${randomBytes(8).toString('hex')}.stale`;
  const renamed = await rename(file, moved).then(
    () => true,
    () => false,
  );
  if (!renamed) return false;
  const mtimeMs = await files.modified(moved);
  if (mtimeMs !== null && Date.now() - mtimeMs <= LOCK_STALE_MS) {
    await rename(moved, file).catch(() => rm(moved, { force: true }).catch(() => undefined));
    return false;
  }
  await rm(moved, { force: true }).catch(() => undefined);
  return true;
}

/**
 * Takes the launch lock of `dir`, creating the directory if needed, and returns the function that
 * releases it. Waits while another call holds the lock; a lock older than LOCK_STALE_MS is removed.
 * Rejects when the directory cannot be created or the lock cannot be taken within twice that time.
 */
export async function acquireLock(
  dir: string,
  pollMs: number,
  replaced: Partial<LockFiles> = {},
): Promise<() => Promise<void>> {
  const files: LockFiles = { ...LOCK_FILES, ...replaced };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, LOCK_FILE);
  const giveUp = Date.now() + 2 * LOCK_STALE_MS;
  let deniedSince: number | null = null;
  for (;;) {
    try {
      await files.create(file);
      return () => unlink(file).catch(() => undefined);
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code === 'EPERM' || code === 'EACCES') {
        // Windows refuses to create a file while one of that name is still being deleted, which is
        // the case just after another call released the lock. A refusal that lasts is an error.
        deniedSince ??= Date.now();
        if (Date.now() - deniedSince > LOCK_DENIED_MS) throw error;
        await sleep(pollMs);
        continue;
      }
      if (code !== 'EEXIST') throw error;
      deniedSince = null;
    }
    const mtimeMs = await files.modified(file);
    if (mtimeMs !== null && Date.now() - mtimeMs > LOCK_STALE_MS && (await removeStaleLock(file, files))) continue;
    if (Date.now() > giveUp) throw new Error('the launch lock is held by another call');
    await sleep(pollMs);
  }
}
