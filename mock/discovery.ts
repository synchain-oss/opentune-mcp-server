// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Discovery file of the mock (spec/otcp/v1/PROTOCOL.md section 5). The mock writes it only to a
// directory the test names explicitly (option or OPENTUNE_MCP_DISCOVERY_DIR) and refuses every
// directory of a real OpenTune installation, so no test can touch the user's real instances.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DISCOVERY_DIR_ENV = 'OPENTUNE_MCP_DISCOVERY_DIR';

/**
 * The data folders of a real OpenTune installation on this machine, which hold its preferences,
 * logs and the default discovery directory (section 5.1), on every platform.
 */
export function realOpenTuneDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const dirs = [
    path.join(home, 'AppData', 'Local', 'OpenTune'),
    path.join(home, 'AppData', 'Roaming', 'OpenTune'),
    path.join(home, 'Library', 'Application Support', 'OpenTune'),
    path.join(env.XDG_STATE_HOME ?? path.join(home, '.local', 'state'), 'OpenTune'),
  ];
  if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'OpenTune'));
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'OpenTune'));
  return dirs;
}

/** Windows and macOS file systems are case-insensitive by default; the other systems' are not. */
const foldsCase = (platform: NodeJS.Platform) => platform === 'win32' || platform === 'darwin';

const comparable = (p: string, platform: NodeJS.Platform) => {
  const resolved = path.resolve(p);
  return foldsCase(platform) ? resolved.toLowerCase() : resolved;
};

/** `child` is `parent` or lies below it. Both are compared as the platform's file system compares names. */
export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const rel = path.relative(comparable(parent, platform), comparable(child, platform));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The path with symbolic links and junctions resolved. A directory that does not exist yet is
 * resolved through its longest existing parent, so that a link in front of it cannot hide where
 * it will end up.
 */
export function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  const rest: string[] = [];
  let existing = resolved;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...rest.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return resolved;
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * The directory the mock writes its discovery file to. Throws when none is given or when it lies
 * inside a real OpenTune data folder, before anything is created: the only file-system access is
 * resolving links of directories that already exist.
 */
export function resolveDiscoveryDir(
  option: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  const dir = option ?? env[DISCOVERY_DIR_ENV];
  if (dir === undefined || dir === '') {
    throw new Error(
      `the mock writes its discovery file only to an explicit directory: pass discoveryDir or set ${DISCOVERY_DIR_ENV}`,
    );
  }
  if (!path.isAbsolute(dir)) throw new Error(`the discovery directory must be an absolute path: ${dir}`);
  // Compared by where the directories really are, so a link into a real folder is refused too.
  const where = canonicalPath(dir);
  for (const real of realOpenTuneDirs(env, home)) {
    if (isInside(where, canonicalPath(real))) {
      throw new Error(`refusing discovery directory ${dir}: it is inside the real OpenTune data folder ${real}`);
    }
  }
  return path.resolve(dir);
}

/** A Windows system tool by absolute path, so that a same-named tool earlier on PATH (Git Bash) is not used. */
const system32 = (tool: string) => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', tool);

let currentSid: string | undefined;

/** The SID of the user this process runs as (Windows). Only the SID is read, never a display name. */
function userSid(): string {
  if (currentSid !== undefined) return currentSid;
  const result = spawnSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const sid = /,"(S-1-[0-9-]+)"\s*$/.exec(result.stdout.trim())?.[1];
  if (result.status !== 0 || sid === undefined) throw new Error('cannot determine the SID of the current user');
  currentSid = sid;
  return sid;
}

/** The SDDL aliases icacls prints for well-known SIDs, which `/remove:g` needs as `*S-1-...`. */
const WELL_KNOWN_SIDS: Readonly<Record<string, string>> = {
  WD: 'S-1-1-0',
  SY: 'S-1-5-18',
  LS: 'S-1-5-19',
  NS: 'S-1-5-20',
  BA: 'S-1-5-32-544',
  BU: 'S-1-5-32-545',
  BG: 'S-1-5-32-546',
  PU: 'S-1-5-32-547',
  AU: 'S-1-5-11',
  IU: 'S-1-5-4',
  OW: 'S-1-3-4',
  CO: 'S-1-3-0',
};

/**
 * Removes every access entry except the current user's from a file whose inheritance is already cut.
 * When the directory has nothing to inherit, a new file gets the default DACL of the process token,
 * with explicit entries for SYSTEM and Administrators besides the user; `/inheritance:r` only drops
 * inherited entries. The entries are read back as SDDL, which names every trustee by SID, and removed
 * by SID: display names come out of icacls in the console code page and cannot be fed back safely.
 */
function removeOtherEntries(file: string, own: string): void {
  const icacls = system32('icacls.exe');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentune-mcp-acl-'));
  try {
    const saved = path.join(dir, 'acl.txt');
    const read = spawnSync(icacls, [file, '/save', saved], { windowsHide: true });
    if (read.status !== 0) throw new Error(`icacls failed to read the access rights of ${file}`);
    const sddl = fs.readFileSync(saved).toString('utf16le');
    const others = new Set<string>();
    for (const match of sddl.matchAll(/\((?:[AD]);[^;()]*;[^;()]*;[^;()]*;[^;()]*;([^;()]+)\)/g)) {
      const trustee = match[1] ?? '';
      const sid = trustee.startsWith('S-1-') ? trustee : WELL_KNOWN_SIDS[trustee];
      if (sid === undefined) throw new Error(`unrecognised trustee ${trustee} in the access rights of ${file}`);
      if (sid.toLowerCase() !== own.toLowerCase()) others.add(sid);
    }
    for (const sid of others) {
      const removed = spawnSync(icacls, [file, '/remove:g', `*${sid}`], { windowsHide: true });
      if (removed.status !== 0) throw new Error(`icacls failed to remove ${sid} from ${file}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** POSIX: the directory checks of section 5.2 rule 1. */
function checkPosixDir(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new Error(`discovery directory ${dir} is not a directory (or is a symbolic link)`);
  if (process.geteuid && stat.uid !== process.geteuid()) {
    throw new Error(`discovery directory ${dir} is not owned by the current user`);
  }
  if ((stat.mode & 0o022) !== 0) throw new Error(`discovery directory ${dir} is writable by group or others`);
}

/**
 * Writes `<dir>/<pid>.json` through a temporary file and a rename (section 5.2): on POSIX the
 * temporary file is created with O_EXCL|O_NOFOLLOW and mode 0600; on Windows its inherited access
 * rights are replaced by one entry for the current user before the content is written. Returns the
 * path of the discovery file.
 */
export function writeDiscoveryFile(dir: string, pid: number, content: unknown): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${String(pid)}.json`);
  // Temporary names never end in .json, so clients never read a half-written file (rule 4).
  const temp = path.join(dir, `.${String(pid)}.${String(process.hrtime.bigint())}.tmp`);
  const data = `${JSON.stringify(content)}\n`;
  let fd: number | undefined;
  try {
    if (process.platform === 'win32') {
      // A deliberate deviation from section 5.2 rule 3, which has the access rights set when the
      // file is created so that it never exists with others. Node cannot pass a security
      // descriptor to CreateFileW, so the mock creates the file empty and replaces its inherited
      // rights with one entry for the current user (dropping the default entries too) before it
      // writes anything. Until then the file holds no secret, and it lies in a directory the test
      // chose; the real server has no such window. If restricting the rights fails, the empty file
      // is deleted and nothing is written.
      fd = fs.openSync(temp, 'wx');
      const sid = userSid();
      const acl = spawnSync(system32('icacls.exe'), [temp, '/inheritance:r', '/grant:r', `*${sid}:(F)`], {
        windowsHide: true,
      });
      if (acl.status !== 0) throw new Error(`icacls failed to restrict ${temp} to the current user`);
      removeOtherEntries(temp, sid);
    } else {
      checkPosixDir(dir);
      const { O_CREAT, O_EXCL, O_WRONLY, O_NOFOLLOW } = fs.constants;
      fd = fs.openSync(temp, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600);
    }
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
  } catch (error) {
    // Whatever failed, no temporary file stays behind: it could hold the token.
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed or invalid; the file is removed below either way
      }
    }
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return target;
}
