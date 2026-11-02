// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The official OpenTune installation, found read-only. On Windows first through the uninstall
// entries in the registry, then in the usual install folders; on macOS /Applications/OpenTune.app,
// whose version is read from its Info.plist. On Windows it is used as the working directory of an
// OpenTune this server starts (an API build without models of its own then finds the installed
// ones); on macOS the models are found by the path of the app, so a start keeps the folder of the
// executable as its working directory. It is reported by doctor. It is never a candidate
// executable to start: only OPENTUNE_MCP_OPENTUNE_PATH names that. Not finding an installation is
// not an error. Nothing here runs an installer or writes anything.

import { open, stat } from 'node:fs/promises';
import path from 'node:path';

import { isAbsoluteLocalPath } from '../discovery/dir.js';
import { runTool, type ToolRun } from '../discovery/process.js';

export interface OfficialInstall {
  /** The installation folder, which holds OpenTune.exe; on macOS the app bundle, OpenTune.app. */
  readonly dir: string;
  /** DisplayVersion of the uninstall entry (Windows) or CFBundleShortVersionString (macOS), or null (not found, not set, unreadable). */
  readonly version: string | null;
  readonly source: 'registry' | 'folder' | 'bundle';
}

/** Whether a start runs in the installation's folder (Windows); a macOS app bundle is not used that way. */
export const isWorkingDirectory = (install: OfficialInstall | null): install is OfficialInstall =>
  install !== null && install.source !== 'bundle';

/** Looks for the installation; resolves with null when there is none or it cannot be determined. */
export type InstallDetector = () => Promise<OfficialInstall | null>;

export interface InstallDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** Runs a system tool by absolute path without a shell (runTool unless a test replaces it). */
  readonly run: (file: string, args: readonly string[]) => Promise<ToolRun>;
  readonly isFile: (file: string) => Promise<boolean>;
  /** The first `max` bytes of a file, or null when it cannot be read. */
  readonly readFile: (file: string, max: number) => Promise<Buffer | null>;
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

/** Where the official macOS installer puts the app (the folder of globalApplicationsDirectory in OpenTune). */
export const MAC_APP = '/Applications/OpenTune.app';
export const MAC_PLIST = `${MAC_APP}/Contents/Info.plist`;
const MAX_PLIST_BYTES = 64 * 1024;
const PLUTIL = '/usr/bin/plutil';

/** CFBundleShortVersionString from the text of an XML property list, or null. */
export function plistShortVersion(xml: string): string | null {
  const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(xml);
  const version = (m?.[1] ?? '').trim();
  return VERSION_RE.test(version) ? version : null;
}

async function fromMacBundle(deps: InstallDeps): Promise<OfficialInstall | null> {
  if (!(await deps.isFile(MAC_PLIST))) return null;
  const bytes = await deps.readFile(MAC_PLIST, MAX_PLIST_BYTES);
  let version: string | null = null;
  if (bytes !== null && bytes.subarray(0, 6).toString('latin1') === 'bplist') {
    // A binary property list: plutil only reads it and prints the one value.
    const printed = await deps.run(PLUTIL, ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', MAC_PLIST]);
    const text = printed.ok ? printed.output.trim() : '';
    version = VERSION_RE.test(text) ? text : null;
  } else if (bytes !== null) {
    version = plistShortVersion(bytes.toString('utf8'));
  }
  return { dir: MAC_APP, version, source: 'bundle' };
}

/** The installation, or null. Windows and macOS only; other systems have no official installer to find. */
export async function detectOfficialInstall(deps: InstallDeps): Promise<OfficialInstall | null> {
  if (deps.platform === 'darwin') return fromMacBundle(deps);
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

const readHead = async (file: string, max: number): Promise<Buffer | null> => {
  const handle = await open(file, 'r').catch(() => null);
  if (handle === null) return null;
  try {
    const buffer = Buffer.alloc(max);
    const { bytesRead } = await handle.read(buffer, 0, max, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
};

/** The detector of the running system; errors count as "not found". */
export function systemInstallDetector(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): InstallDetector {
  return () => detectOfficialInstall({ env, platform, run: runTool, isFile, readFile: readHead }).catch(() => null);
}
