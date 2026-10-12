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

const comparable = (p: string) => {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(comparable(parent), comparable(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The directory the mock writes its discovery file to. Throws, before any file-system access, when
 * none is given or when it lies inside a real OpenTune data folder.
 */
export function resolveDiscoveryDir(option: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const dir = option ?? env[DISCOVERY_DIR_ENV];
  if (dir === undefined || dir === '') {
    throw new Error(
      `the mock writes its discovery file only to an explicit directory: pass discoveryDir or set ${DISCOVERY_DIR_ENV}`,
    );
  }
  if (!path.isAbsolute(dir)) throw new Error(`the discovery directory must be an absolute path: ${dir}`);
  for (const real of realOpenTuneDirs(env)) {
    if (isInside(dir, real)) {
      throw new Error(`refusing discovery directory ${dir}: it is inside the real OpenTune data folder ${real}`);
    }
  }
  return path.resolve(dir);
}

/** A Windows system tool by absolute path, so that a same-named tool earlier on PATH (Git Bash) is not used. */
const system32 = (tool: string) => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', tool);

let currentUserSid: string | undefined;

/** The SID of the user this process runs as (Windows). */
function userSid(): string {
  if (currentUserSid !== undefined) return currentUserSid;
  const result = spawnSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(result.stdout.trim())?.[1];
  if (result.status !== 0 || sid === undefined) throw new Error('cannot determine the SID of the current user');
  currentUserSid = sid;
  return sid;
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
  let fd: number;
  if (process.platform === 'win32') {
    fd = fs.openSync(temp, 'wx');
    const acl = spawnSync(system32('icacls.exe'), [temp, '/inheritance:r', '/grant:r', `*${userSid()}:(F)`], {
      windowsHide: true,
    });
    if (acl.status !== 0) {
      fs.closeSync(fd);
      fs.rmSync(temp, { force: true });
      throw new Error(`icacls failed to restrict ${temp} to the current user`);
    }
  } else {
    checkPosixDir(dir);
    const { O_CREAT, O_EXCL, O_WRONLY, O_NOFOLLOW } = fs.constants;
    fd = fs.openSync(temp, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600);
  }
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, target);
  return target;
}
