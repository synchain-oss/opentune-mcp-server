// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

export const SNAPSHOT_SCHEMA: 'opentune-settings-snapshot/1';

export interface SettingsFile {
  readonly size: number;
  readonly sha256: string;
  readonly entries: Readonly<Record<string, string>>;
  readonly base64: string;
}

export interface SettingsSnapshot {
  readonly schema: typeof SNAPSHOT_SCHEMA;
  readonly files: Readonly<Record<string, SettingsFile>>;
}

export interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
}

export function listSettingsFiles(dir: string, depth?: number, prefix?: string): Promise<string[]>;
export function settingsEntries(text: string): Record<string, string>;
export function takeSnapshot(dir: string): Promise<SettingsSnapshot>;
export function compareSnapshots(
  before: SettingsSnapshot,
  after: SettingsSnapshot,
): { readonly changed: string[]; readonly appeared: string[] };
export function diffSnapshots(before: SettingsSnapshot, after: SettingsSnapshot): string[];
export function restoreSnapshot(dir: string, snapshot: SettingsSnapshot): Promise<string[]>;
export function settleSnapshot(
  dir: string,
  snapshot: SettingsSnapshot,
  baseline?: SettingsSnapshot,
): Promise<{ readonly differences: string[]; readonly appeared: string[]; readonly problems: string[] }>;
export function watchStats(dir: string): Promise<Record<string, FileStat>>;
export function diffStats(
  before: Readonly<Record<string, FileStat>>,
  after: Readonly<Record<string, FileStat>>,
): string[];
export function userSettingsDirs(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string): string[];
export function unsafeSnapshotKey(name: string): string | undefined;
export function restoreTargetProblem(
  dir: string,
  userDirs?: readonly string[],
  platform?: NodeJS.Platform,
): string | undefined;
