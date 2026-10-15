// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The OpenTune executable this server may start, which comes only from the user's configuration
// (OPENTUNE_MCP_OPENTUNE_PATH): an absolute path to an existing regular file, with an
// opentune-control.json next to it that lists protocol major 1. Tool input never influences it.
// Starting the process is not implemented here; this module only reports whether the
// configuration allows it, for opentune_get_status and doctor. Also detects WSL, where this server
// cannot reach an OpenTune that runs on Windows.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { isAbsoluteLocalPath } from '../discovery/dir.js';

export const OPENTUNE_PATH_ENV = 'OPENTUNE_MCP_OPENTUNE_PATH';
/** The file an API build ships next to its executable. */
export const CONTROL_MANIFEST = 'opentune-control.json';
const PROTOCOL_MAJOR = 1;

export type LaunchConfig =
  | { readonly state: 'unset'; readonly unfilledPlaceholder?: true }
  | { readonly state: 'invalid'; readonly reason: 'not_absolute' | 'not_found' | 'not_a_file' }
  | { readonly state: 'no_api'; readonly reason: 'manifest_missing' | 'manifest_invalid' | 'protocol_mismatch' }
  | { readonly state: 'ok'; readonly path: string };

/** A MCPB user-config reference a host passed through without substituting it, e.g. ${user_config.opentune_path}. */
const UNFILLED_PLACEHOLDER = /^\$\{user_config\.[^}]*\}$/;

export const isUnfilledPlaceholder = (value: string | undefined): boolean =>
  value !== undefined && UNFILLED_PLACEHOLDER.test(value.trim());

/** The configured OpenTune path; empty and unsubstituted placeholders count as not set. */
export function configuredOpentunePath(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[OPENTUNE_PATH_ENV];
  return value === undefined || value === '' || isUnfilledPlaceholder(value) ? undefined : value;
}

export async function checkLaunchConfig(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<LaunchConfig> {
  const exe = configuredOpentunePath(env);
  if (exe === undefined) {
    return isUnfilledPlaceholder(env[OPENTUNE_PATH_ENV])
      ? { state: 'unset', unfilledPlaceholder: true }
      : { state: 'unset' };
  }
  if (!isAbsoluteLocalPath(exe, platform)) return { state: 'invalid', reason: 'not_absolute' };
  const info = await stat(exe).catch(() => null);
  if (info === null) return { state: 'invalid', reason: 'not_found' };
  if (!info.isFile()) return { state: 'invalid', reason: 'not_a_file' };
  const p = platform === 'win32' ? path.win32 : path.posix;
  const text = await readFile(p.join(p.dirname(exe), CONTROL_MANIFEST), 'utf8').catch(() => null);
  if (text === null) return { state: 'no_api', reason: 'manifest_missing' };
  let majors: unknown;
  try {
    majors = (JSON.parse(text) as { protocolMajors?: unknown }).protocolMajors;
  } catch {
    return { state: 'no_api', reason: 'manifest_invalid' };
  }
  if (!Array.isArray(majors)) return { state: 'no_api', reason: 'manifest_invalid' };
  return majors.includes(PROTOCOL_MAJOR)
    ? { state: 'ok', path: exe }
    : { state: 'no_api', reason: 'protocol_mismatch' };
}

/** True inside the Windows Subsystem for Linux. An empty variable counts as unset. */
export function isWsl(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, osRelease: string | null): boolean {
  if (platform !== 'linux') return false;
  const set = (value: string | undefined) => value !== undefined && value !== '';
  return set(env.WSL_DISTRO_NAME) || set(env.WSL_INTEROP) || /microsoft/i.test(osRelease ?? '');
}

/** The kernel release string on Linux (for isWsl), or null. */
export async function readOsRelease(platform: NodeJS.Platform): Promise<string | null> {
  return platform === 'linux' ? readFile('/proc/sys/kernel/osrelease', 'utf8').catch(() => null) : null;
}
