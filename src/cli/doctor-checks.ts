// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The doctor checks about versions, models and the files next to the OpenTune executable. They read
// the file system only through DoctorFs and never read model weights: for models only existence and
// size are looked at. Each check returns a status and a message; doctor.ts adds the id and link.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { CONTROL_MANIFEST, MAX_MANIFEST_BYTES } from '../launch/config.js';
import type { OfficialInstall } from '../launch/install.js';

export type Verdict = 'pass' | 'warn' | 'fail';
export interface Outcome {
  readonly status: Verdict;
  readonly message: string;
}

export interface FileInfo {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
}

export interface DoctorFs {
  /** null when the path does not exist or cannot be examined. */
  readonly stat: (file: string) => Promise<FileInfo | null>;
  /** The first `max` bytes of a file, or null when it cannot be read. */
  readonly readFile: (file: string, max: number) => Promise<Buffer | null>;
  /** Lower-case hex SHA-256 of a file, or null when it cannot be read. */
  readonly sha256: (file: string) => Promise<string | null>;
  /** Names in a directory, or null when it cannot be read. */
  readonly list: (dir: string) => Promise<string[] | null>;
}

export const systemDoctorFs: DoctorFs = {
  stat: (file) =>
    stat(file).then(
      (s) => ({ isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size }),
      () => null,
    ),
  readFile: async (file, max) => {
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
  },
  sha256: (file) =>
    new Promise((resolve) => {
      const hash = createHash('sha256');
      const stream = createReadStream(file);
      stream.on('data', (chunk) => {
        hash.update(chunk);
      });
      stream.on('error', () => {
        resolve(null);
      });
      stream.on('end', () => {
        resolve(hash.digest('hex'));
      });
    }),
  list: (dir) => readdir(dir).catch(() => null),
};

/** The oldest official OpenTune this server is known to work with. */
export const MIN_OFFICIAL_VERSION = '1.7.9';
/** First official version that keeps its models in the shared program-data folder. */
const SHARED_MODELS_FROM: Version = [1, 8, 0];
/** The model files the official installation must have, relative to the models folder. */
export const REQUIRED_MODELS: readonly (readonly string[])[] = [
  ['fcpe.onnx'],
  ['GAME', 'bd2dur.onnx'],
  ['GAME', 'dur2bd.onnx'],
  ['GAME', 'encoder.onnx'],
  ['GAME', 'estimator.onnx'],
  ['GAME', 'segmenter.onnx'],
];
export const CHECKSUM_FILE = 'SHA256SUMS';
const MAX_CHECKSUM_BYTES = 1024 * 1024;
const MAX_LISTED = 10;

type Version = readonly [number, number, number];

/** The leading major.minor.patch of a version text such as 1.8.1 or v1.8.1-beta, or null. */
export function parseVersion(text: string | null): Version | null {
  const m = /^v?(\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?(?![0-9])/.exec((text ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const MIN_VERSION: Version = [1, 7, 9];

type Pathlib = typeof path.win32;
export const pathLib = (platform: NodeJS.Platform): Pathlib => (platform === 'win32' ? path.win32 : path.posix);

const listed = (items: readonly string[]): string =>
  items.length <= MAX_LISTED
    ? items.join(', ')
    : `${items.slice(0, MAX_LISTED).join(', ')} and ${String(items.length - MAX_LISTED)} more`;

const notChecked = (why: string): Outcome => ({ status: 'warn', message: `Not checked: ${why}.` });
const NOT_WINDOWS = 'this check looks at an official OpenTune installation on Windows only';
const NO_INSTALL = 'no official OpenTune installation was found';
const NO_BUILD = 'OPENTUNE_MCP_OPENTUNE_PATH does not name a usable build';

export function versionCheck(install: OfficialInstall | null, windows: boolean): Outcome {
  if (!windows) return notChecked(NOT_WINDOWS);
  if (install === null) return notChecked(NO_INSTALL);
  const version = parseVersion(install.version);
  if (version === null) {
    return {
      status: 'warn',
      message:
        `Cannot tell: the version of the official installation in ${install.dir} is unknown, so it cannot be compared ` +
        `with the oldest supported version ${MIN_OFFICIAL_VERSION}.`,
    };
  }
  const shown = JSON.stringify(install.version);
  return compare(version, MIN_VERSION) < 0
    ? {
        status: 'fail',
        message: `Official OpenTune ${shown} is older than the oldest supported version ${MIN_OFFICIAL_VERSION}. Update it from the official OpenTune release page.`,
      }
    : { status: 'pass', message: `Official OpenTune ${shown} is supported (${MIN_OFFICIAL_VERSION} or later).` };
}

export interface ModelsDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly fs: DoctorFs;
}

/** Required files missing or empty in a models folder. */
async function missingModels(fs: DoctorFs, p: Pathlib, dir: string): Promise<string[]> {
  const missing: string[] = [];
  for (const parts of REQUIRED_MODELS) {
    const info = await fs.stat(p.join(dir, ...parts));
    if (info === null || !info.isFile || info.size === 0) missing.push(parts.join('\\'));
  }
  return missing;
}

export async function modelsCheck(
  install: OfficialInstall | null,
  deps: ModelsDeps,
  windows: boolean,
): Promise<Outcome> {
  if (!windows) return notChecked(NOT_WINDOWS);
  if (install === null) return notChecked(NO_INSTALL);
  const p = path.win32;
  const shared = p.join(deps.env.ProgramData ?? 'C:\\ProgramData', 'OpenTune', 'Models');
  const own = p.join(install.dir, 'models');
  const version = parseVersion(install.version);
  const dirs = version === null ? [shared, own] : [compare(version, SHARED_MODELS_FROM) >= 0 ? shared : own];
  const problems: string[] = [];
  for (const dir of dirs) {
    const missing = await missingModels(deps.fs, p, dir);
    if (missing.length === 0) {
      return { status: 'pass', message: `All ${String(REQUIRED_MODELS.length)} model files are present in ${dir}.` };
    }
    problems.push(`${dir} lacks or has empty ${listed(missing)}`);
  }
  if (version === null) {
    return {
      status: 'warn',
      message: `Cannot tell where this version keeps its models, and neither usual folder is complete: ${problems.join('; ')}.`,
    };
  }
  return {
    status: 'fail',
    message: `Model files are missing for official OpenTune ${JSON.stringify(install.version)}: ${problems.join('; ')}. Reinstall the models with the official installer.`,
  };
}

interface D3d12Entry {
  readonly bundled: boolean;
  readonly directory: string;
  readonly files: readonly { readonly name: string; readonly sha256: string }[];
}

const SAFE_NAME = /^[^\\/:*?"<>|\0]+$/;
/** A PowerShell single-quoted string literal. PowerShell also reads the typographic quotes U+2018 to U+201B as single quotes, so each is doubled like the ASCII one. */
const psQuote = (s: string): string => `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The d3d12 member of opentune-control.json: 'none' when absent, 'invalid' when malformed, null when unreadable. */
function parseD3d12(bytes: Buffer): D3d12Entry | 'none' | 'invalid' | 'bad-hash' | 'no-files' | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const d = value.d3d12;
  if (d === undefined) return 'none';
  if (!isObject(d) || typeof d.bundled !== 'boolean') return 'invalid';
  if (d.bundled) return { bundled: true, directory: '', files: [] };
  if (
    typeof d.directory !== 'string' ||
    d.directory === '.' ||
    d.directory === '..' ||
    !SAFE_NAME.test(d.directory) ||
    !Array.isArray(d.files)
  ) {
    return 'invalid';
  }
  const files: { name: string; sha256: string }[] = [];
  for (const f of d.files) {
    if (!isObject(f) || typeof f.name !== 'string' || !SAFE_NAME.test(f.name) || typeof f.sha256 !== 'string') {
      return 'invalid';
    }
    if (!/^[0-9a-fA-F]{64}$/.test(f.sha256)) return 'bad-hash';
    files.push({ name: f.name, sha256: f.sha256.toLowerCase() });
  }
  return files.length === 0 ? 'no-files' : { bundled: false, directory: d.directory, files };
}

/** The parts of a relative path from a checksum list, or null when it could leave the folder. */
function safeRelative(rel: string): string[] | null {
  const parts = rel.split(/[\\/]/);
  return rel === '' || /^[A-Za-z]:/.test(rel) || parts.some((s) => s === '' || s === '.' || s === '..') ? null : parts;
}

export interface SidecarDeps {
  readonly platform: NodeJS.Platform;
  readonly fs: DoctorFs;
}

export async function sidecarCheck(exeDir: string | null, deps: SidecarDeps): Promise<Outcome> {
  if (exeDir === null) return notChecked(NO_BUILD);
  const p = pathLib(deps.platform);
  const bytes = await deps.fs.readFile(p.join(exeDir, CHECKSUM_FILE), MAX_CHECKSUM_BYTES + 1);
  if (bytes === null) {
    return {
      status: 'warn',
      message: `Cannot verify: there is no ${CHECKSUM_FILE} in ${exeDir}. A build you made yourself has none; for a test build, unpack the whole zip again.`,
    };
  }
  if (bytes.length > MAX_CHECKSUM_BYTES) {
    return {
      status: 'fail',
      message: `${CHECKSUM_FILE} in ${exeDir} is larger than ${String(MAX_CHECKSUM_BYTES)} bytes.`,
    };
  }
  const entries: { hash: string; rel: string; parts: string[] }[] = [];
  const bad: string[] = [];
  for (const line of bytes
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const m = /^([0-9A-Fa-f]{64}) [ *](.+)$/.exec(line);
    const parts = m ? safeRelative((m[2] ?? '').trim()) : null;
    if (!m || parts === null) bad.push(`unusable line ${JSON.stringify(line.slice(0, 80))}`);
    else entries.push({ hash: (m[1] ?? '').toLowerCase(), rel: parts.join('\\'), parts });
  }
  const missing: string[] = [];
  const differing: string[] = [];
  for (const e of entries) {
    const hash = await deps.fs.sha256(p.join(exeDir, ...e.parts));
    if (hash === null) missing.push(e.rel);
    else if (hash !== e.hash) differing.push(e.rel);
  }
  if (entries.length === 0 && bad.length === 0) bad.push(`${CHECKSUM_FILE} lists no files`);
  const problems = [
    ...(missing.length > 0 ? [`missing: ${listed(missing)}`] : []),
    ...(differing.length > 0 ? [`hash differs: ${listed(differing)}`] : []),
    ...(bad.length > 0 ? [listed(bad)] : []),
  ];
  return problems.length === 0
    ? {
        status: 'pass',
        message: `All ${String(entries.length)} files listed in ${CHECKSUM_FILE} are present with matching hashes.`,
      }
    : {
        status: 'fail',
        message: `The files next to the executable do not match ${CHECKSUM_FILE} (${problems.join('; ')}). Unpack the test build again into an empty folder.`,
      };
}

export async function shadowedCheck(exeDir: string | null, deps: SidecarDeps): Promise<Outcome> {
  if (exeDir === null) return notChecked(NO_BUILD);
  const p = pathLib(deps.platform);
  const dir = p.join(exeDir, 'models');
  const info = await deps.fs.stat(dir);
  if (info === null) {
    return { status: 'pass', message: 'No models folder next to the executable.' };
  }
  if (!info.isDirectory) {
    return { status: 'warn', message: `${dir} exists but is not a folder; OpenTune may not look at it.` };
  }
  const missing = await missingModels(deps.fs, p, dir);
  const detail =
    missing.length === 0
      ? 'It holds all required model files.'
      : `It lacks or has empty ${listed(missing)}, so OpenTune may not find them.`;
  return {
    status: 'warn',
    message: `${dir} exists and is found before the installed models. ${detail} A test build does not ship it: remove or rename the folder to use the installed models.`,
  };
}

export interface D3d12Deps extends SidecarDeps {
  /** Folder of the official installation, when one was found. */
  readonly officialDir: string | null;
}

export async function d3d12Check(exeDir: string | null, deps: D3d12Deps): Promise<Outcome> {
  if (exeDir === null) return notChecked(NO_BUILD);
  const p = pathLib(deps.platform);
  const bytes = await deps.fs.readFile(p.join(exeDir, CONTROL_MANIFEST), MAX_MANIFEST_BYTES + 1);
  const d = bytes === null || bytes.length > MAX_MANIFEST_BYTES ? null : parseD3d12(bytes);
  if (d === null) return { status: 'warn', message: `Cannot tell: ${CONTROL_MANIFEST} cannot be read.` };
  if (d === 'none') return { status: 'pass', message: `${CONTROL_MANIFEST} has no d3d12 entry; nothing to copy.` };
  if (d === 'bad-hash') {
    return {
      status: 'warn',
      message: `Cannot tell: a hash in the d3d12 entry of ${CONTROL_MANIFEST} is not 64 hexadecimal characters.`,
    };
  }
  if (d === 'no-files') {
    return {
      status: 'warn',
      message: `Cannot tell: the d3d12 entry of ${CONTROL_MANIFEST} lists no files, so there is nothing to check.`,
    };
  }
  if (d === 'invalid') {
    return { status: 'warn', message: `Cannot tell: the d3d12 entry of ${CONTROL_MANIFEST} is not valid.` };
  }
  if (d.bundled)
    return { status: 'pass', message: 'The Direct3D 12 runtime is bundled with this build; nothing to copy.' };
  const folder = p.join(exeDir, d.directory);
  const missing: string[] = [];
  const differing: string[] = [];
  for (const f of d.files) {
    const hash = await deps.fs.sha256(p.join(folder, f.name));
    if (hash === null) missing.push(f.name);
    else if (hash !== f.sha256) differing.push(f.name);
  }
  const names = (await deps.fs.list(folder)) ?? [];
  const official = deps.officialDir ?? '<official OpenTune folder>';
  const notes: string[] = [];
  if (differing.length > 0) {
    notes.push(
      `${listed(differing)} in ${folder} does not match the hash in ${CONTROL_MANIFEST}. Delete the ${d.directory} folder to run on the CPU, then copy the file again from the official installation.`,
    );
  }
  if (names.some((n) => n.toLowerCase() === 'd3d12sdklayers.dll')) {
    notes.push(`${folder} contains D3D12SDKLayers.dll, the debug layer; do not copy it, delete it.`);
  }
  if (missing.length > 0) {
    notes.push(
      `Not copied: ${listed(missing)}. Without it OpenTune runs on the CPU. To copy it, run in PowerShell:`,
      `New-Item -ItemType Directory -Force -Path ${psQuote(folder)} | Out-Null`,
      ...missing.flatMap((n) => [
        `Copy-Item -LiteralPath ${psQuote(p.join(official, d.directory, n))} -Destination ${psQuote(p.join(folder, n))}`,
        `(Get-FileHash -Algorithm SHA256 -LiteralPath ${psQuote(p.join(folder, n))}).Hash`,
      ]),
      `then compare the printed hash with the entry in ${CONTROL_MANIFEST}.`,
    );
  }
  if (notes.length === 0) {
    return { status: 'pass', message: `The Direct3D 12 files in ${folder} match ${CONTROL_MANIFEST}.` };
  }
  return { status: differing.length > 0 ? 'fail' : 'warn', message: notes.join('\n') };
}
