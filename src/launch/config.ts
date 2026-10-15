// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The OpenTune executable this server may start, which comes only from the user's configuration
// (OPENTUNE_MCP_OPENTUNE_PATH): an absolute path to an existing regular file, with an
// opentune-control.json next to it that lists protocol major 1. Tool input never influences it.
// opentune_launch starts nothing this check does not accept; opentune_get_status and doctor report
// it. Also detects WSL, where this server cannot reach an OpenTune that runs on Windows.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { isAbsoluteLocalPath } from '../discovery/dir.js';
import { MAX_DISCOVERY_BYTES, readDiscoveryBytes } from '../discovery/file.js';

export const OPENTUNE_PATH_ENV = 'OPENTUNE_MCP_OPENTUNE_PATH';
/** The file an API build ships next to its executable. */
export const CONTROL_MANIFEST = 'opentune-control.json';
/** Largest opentune-control.json this server reads: 8 KiB, the bound of the reader it shares with discovery files. */
export const MAX_MANIFEST_BYTES = MAX_DISCOVERY_BYTES;
const PROTOCOL_MAJOR = 1;

export type ManifestProblem = 'manifest_missing' | 'manifest_too_large' | 'manifest_invalid' | 'protocol_mismatch';

export type LaunchConfig =
  | { readonly state: 'unset'; readonly unfilledPlaceholder?: true }
  | { readonly state: 'invalid'; readonly reason: 'not_absolute' | 'not_found' | 'not_a_file' }
  | { readonly state: 'no_api'; readonly reason: ManifestProblem }
  | { readonly state: 'ok'; readonly path: string; readonly dir: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Checks opentune-control.json. Its format is defined by the packaging of the API build; until it
 * is final, only `protocolMajors` (a list of positive integers) is read and other members are
 * ignored. A file larger than MAX_MANIFEST_BYTES, or that is not a UTF-8 JSON object with such a
 * list, is invalid.
 */
export function manifestProblem(bytes: Buffer | null): ManifestProblem | null {
  if (bytes === null) return 'manifest_missing';
  if (bytes.length > MAX_MANIFEST_BYTES) return 'manifest_too_large';
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return 'manifest_invalid';
  }
  const majors = isObject(value) ? value.protocolMajors : undefined;
  if (!Array.isArray(majors) || !majors.every((m) => typeof m === 'number' && Number.isInteger(m) && m >= 1)) {
    return 'manifest_invalid';
  }
  return majors.includes(PROTOCOL_MAJOR) ? null : 'protocol_mismatch';
}

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
  const dir = p.dirname(exe);
  const problem = manifestProblem(await readDiscoveryBytes(p.join(dir, CONTROL_MANIFEST)));
  return problem === null ? { state: 'ok', path: exe, dir } : { state: 'no_api', reason: problem };
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
