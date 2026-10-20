// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Snapshot, compare and restore the settings files of an OpenTune data folder, so that a run against a
// real OpenTune leaves the folder as it found it. The files are the preferences (app-preferences.settings,
// which holds onboardingShown) and the JUCE settings (OpenTune.settings, which holds the audio device
// setup): every `*.settings` file in the folder, below it to a small depth, except log and discovery
// folders. A snapshot keeps the exact bytes, so a restore is byte for byte.
//
// Also here: a read-only watch of a folder that must NOT change (the real user's settings folder), which
// compares only size and modification time and never opens a file.
//
// As a module it is used by the real-OpenTune runner (test/e2e/settings-guard.ts); as a script:
//   node scripts/e2e/settings-snapshot.mjs snapshot <dir> <snapshot.json>
//   node scripts/e2e/settings-snapshot.mjs diff <dir> <snapshot.json>      (exit 1 when they differ)
//   node scripts/e2e/settings-snapshot.mjs restore <dir> <snapshot.json>   (exit 1 when it cannot be restored)

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SNAPSHOT_SCHEMA = 'opentune-settings-snapshot/1';

const SETTINGS_FILE = /\.settings$/i;
/** Folders that hold logs or discovery files, never settings. */
const SKIPPED_FOLDERS = new Set(['logs', 'control']);
const MAX_DEPTH = 3;
const MAX_LISTED = 12;

/** The relative paths (forward slashes, sorted) of the settings files below `dir`; none if `dir` is missing. */
export async function listSettingsFiles(dir, depth = 0, prefix = '') {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isFile() && SETTINGS_FILE.test(entry.name)) found.push(rel);
    else if (entry.isDirectory() && depth < MAX_DEPTH && !SKIPPED_FOLDERS.has(entry.name.toLowerCase())) {
      found.push(...(await listSettingsFiles(path.join(dir, entry.name), depth + 1, rel)));
    }
  }
  return found.sort();
}

/** The `name -> val` pairs of the flat `<VALUE name=".." val=".."/>` entries of a JUCE properties file. */
export function settingsEntries(text) {
  const entries = {};
  for (const match of text.matchAll(/<VALUE\s+name="([^"]*)"\s+val="([^"]*)"/g)) {
    entries[match[1] ?? ''] = match[2] ?? '';
  }
  return entries;
}

/** Takes the snapshot of the settings files of `dir`. */
export async function takeSnapshot(dir) {
  const files = {};
  for (const rel of await listSettingsFiles(dir)) {
    const bytes = await readFile(path.join(dir, ...rel.split('/')));
    files[rel] = {
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      entries: settingsEntries(bytes.toString('utf8')),
      base64: bytes.toString('base64'),
    };
  }
  return { schema: SNAPSHOT_SCHEMA, files };
}

const clip = (value) => (value.length > 40 ? `${value.slice(0, 37)}...` : value);

/**
 * The differences between two snapshots, as readable lines, in two lists: `changed` (a value that was
 * there is different or gone, a file is gone) and `appeared` (a key or a file that was not there).
 */
export function compareSnapshots(before, after) {
  const changed = [];
  const appeared = [];
  const names = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort();
  for (const name of names) {
    const a = before.files[name];
    const b = after.files[name];
    if (a === undefined) appeared.push(`${name}: appeared (${String(b?.size)} bytes)`);
    else if (b === undefined) changed.push(`${name}: disappeared`);
    else if (a.sha256 !== b.sha256) {
      const keys = [...new Set([...Object.keys(a.entries), ...Object.keys(b.entries)])].sort();
      const gone = [];
      const added = [];
      for (const key of keys) {
        const was = a.entries[key];
        const now = b.entries[key];
        if (was === now) continue;
        if (was === undefined) added.push(`${key} appeared (${clip(String(now))})`);
        else if (now === undefined) gone.push(`${key} disappeared`);
        else gone.push(`${key}: ${clip(was)} -> ${clip(now)}`);
      }
      if (gone.length > 0) changed.push(`${name}: ${gone.join(', ')}`);
      if (added.length > 0) appeared.push(`${name}: ${added.join(', ')}`);
      if (gone.length === 0 && added.length === 0) {
        changed.push(`${name}: content differs (${String(a.size)} -> ${String(b.size)} bytes)`);
      }
    }
  }
  return { changed: changed.slice(0, MAX_LISTED), appeared: appeared.slice(0, MAX_LISTED) };
}

/** All differences between two snapshots as readable lines (changed first); empty when they are the same. */
export function diffSnapshots(before, after) {
  const { changed, appeared } = compareSnapshots(before, after);
  return [...changed, ...appeared].slice(0, MAX_LISTED);
}

/**
 * Puts the settings files of `dir` back as the snapshot has them: files are rewritten with their exact
 * bytes, files that appeared since are removed. Returns what it did, as lines; empty when nothing was
 * different.
 */
export async function restoreSnapshot(dir, snapshot) {
  const actions = [];
  const current = await listSettingsFiles(dir);
  for (const name of current) {
    if (snapshot.files[name] === undefined) {
      await rm(path.join(dir, ...name.split('/')), { force: true });
      actions.push(`removed ${name}`);
    }
  }
  for (const [name, saved] of Object.entries(snapshot.files)) {
    const file = path.join(dir, ...name.split('/'));
    const bytes = Buffer.from(saved.base64, 'base64');
    const same = await readFile(file).then(
      (current) => createHash('sha256').update(current).digest('hex') === saved.sha256,
      () => false,
    );
    if (!same) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      actions.push(`rewrote ${name}`);
    }
  }
  return actions;
}

/**
 * The whole round: compare the settings files of `dir` with the snapshot, restore them, and check that
 * the restore worked. `differences` is what the run changed (a FAIL for the run); `problems` is what
 * could not be put back; `appeared` is what OpenTune added to the folder (keys and files that were not there),
 * which is reported but not a FAIL: it writes its defaults while it runs and when it ends. `baseline` is what the differences are measured against (default: the snapshot):
 * the state once the instance had started, because OpenTune writes its defaults into a fresh data folder
 * while it starts, and that is not something the run's own requests changed. The restore goes back to
 * the snapshot either way.
 */
export async function settleSnapshot(dir, snapshot, baseline = snapshot) {
  const { changed: differences, appeared } = compareSnapshots(baseline, await takeSnapshot(dir));
  const problems = [];
  try {
    await restoreSnapshot(dir, snapshot);
    const left = diffSnapshots(snapshot, await takeSnapshot(dir));
    if (left.length > 0) problems.push(`the settings could not be restored: ${left.join('; ')}`);
  } catch (error) {
    problems.push(`the settings could not be restored: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { differences, appeared, problems };
}

// ---------------------------------------------------------------------------------------------
// the read-only watch of a folder that must not change

/** Size and modification time of every settings file below `dir`; nothing is opened. */
export async function watchStats(dir) {
  const stats = {};
  for (const rel of await listSettingsFiles(dir)) {
    const info = await stat(path.join(dir, ...rel.split('/')));
    stats[rel] = { size: info.size, mtimeMs: info.mtimeMs };
  }
  return stats;
}

/** The differences between two readings of watchStats, as lines; empty when nothing changed. */
export function diffStats(before, after) {
  const lines = [];
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = before[name];
    const b = after[name];
    if (a === undefined) lines.push(`${name}: appeared`);
    else if (b === undefined) lines.push(`${name}: disappeared`);
    else if (a.size !== b.size) lines.push(`${name}: size ${String(a.size)} -> ${String(b.size)}`);
    else if (a.mtimeMs !== b.mtimeMs) lines.push(`${name}: modification time changed`);
  }
  return lines.slice(0, MAX_LISTED);
}

/** Where OpenTune keeps the settings of the real user on this machine (never written by a test). */
export function userSettingsDir(env = process.env, platform = process.platform, home = env.HOME ?? env.USERPROFILE) {
  if (platform === 'win32') {
    const appData = env.APPDATA ?? (home === undefined ? undefined : path.win32.join(home, 'AppData', 'Roaming'));
    return appData === undefined ? undefined : path.win32.join(appData, 'OpenTune');
  }
  if (home === undefined) return undefined;
  return platform === 'darwin'
    ? path.posix.join(home, 'Library', 'Application Support', 'OpenTune')
    : path.posix.join(home, '.config', 'OpenTune');
}

// ---------------------------------------------------------------------------------------------
// command line

async function main(argv) {
  const [command, dir, file] = argv;
  if (!['snapshot', 'diff', 'restore'].includes(command ?? '') || dir === undefined || file === undefined) {
    process.stderr.write('usage: settings-snapshot.mjs snapshot|diff|restore <dir> <snapshot.json>\n');
    return 2;
  }
  if (command === 'snapshot') {
    await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await writeFile(file, `${JSON.stringify(await takeSnapshot(dir), null, 2)}\n`, 'utf8');
    return 0;
  }
  const snapshot = JSON.parse(await readFile(file, 'utf8'));
  if (snapshot.schema !== SNAPSHOT_SCHEMA) throw new Error('not a settings snapshot');
  if (command === 'diff') {
    const lines = diffSnapshots(snapshot, await takeSnapshot(dir));
    process.stderr.write(lines.length === 0 ? 'same\n' : `${lines.join('\n')}\n`);
    return lines.length === 0 ? 0 : 1;
  }
  const { differences, problems } = await settleSnapshot(dir, snapshot);
  if (differences.length > 0) process.stderr.write(`restored; the run had changed:\n${differences.join('\n')}\n`);
  if (problems.length > 0) process.stderr.write(`${problems.join('\n')}\n`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
