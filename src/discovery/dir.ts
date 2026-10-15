// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The discovery directory this server reads (spec/otcp/v1/PROTOCOL.md section 5.1). Pure: the
// environment, platform and home directory are parameters, so tests never resolve the real one.

import path from 'node:path';

/** Overrides the directory, for tests and unusual set-ups. Must be an absolute path. */
export const DISCOVERY_DIR_ENV = 'OPENTUNE_MCP_DISCOVERY_DIR';

export type DirSource = 'override' | 'dataDir' | 'default';

export type DirResolution =
  | { readonly ok: true; readonly dir: string; readonly source: DirSource }
  | { readonly ok: false; readonly variable: string; readonly problem: string };

/** True for an absolute local path in the platform's form (on Windows a drive letter and a backslash). */
export function isAbsoluteLocalPath(p: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/');
}

/**
 * The override, else `<OPENTUNE_DATA_DIR>/control/instances` (where an OpenTune started with that
 * variable writes its file), else the platform default.
 */
export function resolveDiscoveryDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): DirResolution {
  const p = platform === 'win32' ? path.win32 : path.posix;
  for (const [variable, source, suffix] of [
    [DISCOVERY_DIR_ENV, 'override', []],
    ['OPENTUNE_DATA_DIR', 'dataDir', ['control', 'instances']],
  ] as const) {
    const value = env[variable];
    if (value === undefined || value === '') continue;
    if (!isAbsoluteLocalPath(value, platform)) {
      return { ok: false, variable, problem: `${variable} must be an absolute local path` };
    }
    return { ok: true, dir: p.join(value, ...suffix), source };
  }
  const tail = ['OpenTune', 'control', 'instances'];
  if (platform === 'win32') {
    return { ok: true, dir: p.join(env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local'), ...tail), source: 'default' };
  }
  if (platform === 'darwin') {
    return { ok: true, dir: p.join(home, 'Library', 'Application Support', ...tail), source: 'default' };
  }
  const state =
    env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== ''
      ? env.XDG_STATE_HOME
      : p.join(home, '.local', 'state');
  return { ok: true, dir: p.join(state, ...tail), source: 'default' };
}
