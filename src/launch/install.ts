// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The official OpenTune installation on Windows, found read-only: first through the uninstall
// entries in the registry, then in the usual install folders. It is used as the working directory
// of an OpenTune this server starts (an API build without models of its own then finds the
// installed ones) and reported by doctor. It is never a candidate executable to start: only
// OPENTUNE_MCP_OPENTUNE_PATH names that. Not finding an installation is not an error.

import { stat } from 'node:fs/promises';
import path from 'node:path';

import { isAbsoluteLocalPath } from '../discovery/dir.js';
import { runTool, type ToolRun } from '../discovery/process.js';

export interface OfficialInstall {
  /** The installation folder, which holds OpenTune.exe. */
  readonly dir: string;
  /** DisplayVersion of the uninstall entry, or null (not found through the registry, or not set). */
  readonly version: string | null;
  readonly source: 'registry' | 'folder';
}

/** Looks for the installation; resolves with null when there is none or it cannot be determined. */
export type InstallDetector = () => Promise<OfficialInstall | null>;

export interface InstallDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** Runs a system tool by absolute path without a shell (runTool unless a test replaces it). */
  readonly run: (file: string, args: readonly string[]) => Promise<ToolRun>;
  readonly isFile: (file: string) => Promise<boolean>;
}

const EXE = 'OpenTune.exe';
/** Uninstall entries of installers for all users (64- and 32-bit views) and for the current user. */
export const UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
] as const;
/** The display name of the official installer's entry: "OpenTune", possibly followed by a version. */
const DISPLAY_NAME_RE = /^OpenTune(?:\s|$)/i;
const VERSION_RE = /^[0-9A-Za-z.+_ -]{1,64}$/;

/**
 * Parses the output of `reg query`: key paths with their values, by value name in lower case (the
 * registry compares value names without regard to case). Lines that are neither are ignored.
 */
export function parseRegQuery(text: string): Map<string, Map<string, string>> {
  const keys = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) {
      current = new Map();
      keys.set(line.trim(), current);
      continue;
    }
    const value = /^ {4}(.+?) {4}REG_[A-Z_]+(?: {4}(.*))?$/.exec(line);
    if (value && current) current.set((value[1] ?? '').toLowerCase(), (value[2] ?? '').trimEnd());
  }
  return keys;
}

/**
 * An install folder from the registry or the environment, without quotes and trailing backslashes:
 * a folder below a drive letter (`C:\...`), else null.
 */
export function installDir(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!isAbsoluteLocalPath(trimmed, 'win32')) return null;
  const dir = path.win32.normalize(trimmed).replace(/\\+$/, '');
  return /^[A-Za-z]:\\./.test(dir) ? dir : null;
}

async function fromRegistry(deps: InstallDeps, reg: string): Promise<OfficialInstall | null> {
  for (const root of UNINSTALL_KEYS) {
    const found = await deps.run(reg, ['query', root, '/s', '/f', 'OpenTune', '/d']);
    if (!found.ok) continue;
    for (const [key, matched] of parseRegQuery(found.output)) {
      if (!DISPLAY_NAME_RE.test(matched.get('displayname') ?? '')) continue;
      const all = await deps.run(reg, ['query', key]);
      const values = new Map([...matched, ...(all.ok ? (parseRegQuery(all.output).get(key) ?? []) : [])]);
      const dir = installDir(values.get('installlocation')) ?? installDir(values.get('inno setup: app path'));
      if (dir === null || !(await deps.isFile(path.win32.join(dir, EXE)))) continue;
      const version = values.get('displayversion') ?? '';
      return { dir, version: VERSION_RE.test(version) ? version : null, source: 'registry' };
    }
  }
  return null;
}

/** The installation, or null. Windows only; other systems have no official installer to find. */
export async function detectOfficialInstall(deps: InstallDeps): Promise<OfficialInstall | null> {
  if (deps.platform !== 'win32') return null;
  const { env } = deps;
  const reg = path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  const registered = await fromRegistry(deps, reg);
  if (registered) return registered;
  const local = env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'Programs') : undefined;
  const bases = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'], local];
  for (const base of new Set(bases.filter((b): b is string => b !== undefined && b !== ''))) {
    const dir = installDir(path.win32.join(base, 'OpenTune'));
    if (dir !== null && (await deps.isFile(path.win32.join(dir, EXE)))) return { dir, version: null, source: 'folder' };
  }
  return null;
}

const isFile = (file: string) =>
  stat(file).then(
    (s) => s.isFile(),
    () => false,
  );

/** The detector of the running system; errors count as "not found". */
export function systemInstallDetector(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): InstallDetector {
  return () => detectOfficialInstall({ env, platform, run: runTool, isFile }).catch(() => null);
}
