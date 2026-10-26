// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Writes a result file that must not replace anything: the data goes to a temporary file in the
// target's folder, and the temporary file is then linked to the first free name (<stem>.json,
// <stem> (2).json, ... <stem> (999).json), the way OpenTune picks the name of an export. The link
// fails when the name exists, so there is no moment at which a file could be replaced, and a failed
// write leaves neither a half-written target nor the temporary file behind. A file system without
// hard links falls back to a copy that fails when the name exists.

import { randomBytes } from 'node:crypto';
import { copyFile, constants, link, open, stat, unlink } from 'node:fs/promises';

import { extensionOf, type PathSystem } from '../paths/validate.js';

/** The last name tried, as for exports: `<stem> (999).json`. */
export const MAX_RENAME_INDEX = 999;

/** The file system calls the writer needs; tests replace them to reach the branches of a real disk. */
export interface FileOps {
  /** What the path is, without following a missing link: a folder, nothing, or something else. */
  kindOf: (path: string) => Promise<'directory' | 'missing' | 'other'>;
  /** Creates a file that must not exist yet and writes `data` to it. */
  create: (path: string, data: string) => Promise<void>;
  /** Makes `target` another name of `existing`; fails with EEXIST when `target` exists. */
  link: (existing: string, target: string) => Promise<void>;
  /** Copies `source` to a `target` that must not exist; fails with EEXIST when it does. */
  copyNew: (source: string, target: string) => Promise<void>;
  /** Removes a file; a file that is already gone is not an error. */
  remove: (path: string) => Promise<void>;
}

const errnoOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;

export const realFiles: FileOps = {
  async kindOf(path) {
    try {
      return (await stat(path)).isDirectory() ? 'directory' : 'other';
    } catch (error) {
      if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR') return 'missing';
      throw error;
    }
  },
  async create(path, data) {
    // Mode 0600 keeps the temporary file private; the final name is a link to the same file, so the
    // result keeps that mode, like the other files this server writes.
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(data, 'utf8');
    } finally {
      await handle.close();
    }
  },
  link: (existing, target) => link(existing, target),
  copyNew: (source, target) => copyFile(source, target, constants.COPYFILE_EXCL),
  async remove(path) {
    try {
      await unlink(path);
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') throw error;
    }
  },
};

/** Why a file could not be written: every name was taken, or the file system failed. */
export class FileWriteError extends Error {
  constructor(
    readonly kind: 'names_taken' | 'io',
    /** The error code of the file system (EACCES, ENOSPC, ...), when it has one. */
    readonly code: string | null,
  ) {
    super(kind === 'names_taken' ? 'every candidate name is taken' : `the file system failed (${code ?? 'no code'})`);
    this.name = 'FileWriteError';
  }
}

export interface Written {
  /** The file that was written. */
  readonly path: string;
  /** True when the name asked for was taken and a later free name was used. */
  readonly renamed: boolean;
}

/** The folder of an absolute path, with the root kept whole (`C:\`, `/`). */
export function folderOf(path: string, system: PathSystem): string {
  const sep = system === 'windows' ? '\\' : '/';
  const cut = path.lastIndexOf(sep);
  const dir = path.slice(0, cut);
  return dir === '' || /^[A-Za-z]:$/.test(dir) ? `${dir}${sep}` : dir;
}

/** Links (or, without hard links, copies) the temporary file to `candidate`; false when that name exists. */
async function place(ops: FileOps, temp: string, candidate: string): Promise<boolean> {
  try {
    await ops.link(temp, candidate);
    return true;
  } catch (error) {
    if (errnoOf(error) === 'EEXIST') return false;
  }
  // No hard link here (FAT, some network and cloud folders). The copy still never replaces a file.
  try {
    await ops.copyNew(temp, candidate);
    return true;
  } catch (error) {
    if (errnoOf(error) === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Writes `data` to `target` or, when that name is taken, to the next free `<stem> (n)<ext>`; never
 * replaces a file. The folder of `target` must exist. Throws FileWriteError.
 */
export async function writeNewFile(
  target: string,
  data: string,
  system: PathSystem,
  ops: FileOps = realFiles,
): Promise<Written> {
  const sep = system === 'windows' ? '\\' : '/';
  const dir = folderOf(target, system);
  const base = target.slice(target.lastIndexOf(sep) + 1);
  const extension = extensionOf(target);
  const stem = extension === '' ? base : base.slice(0, -extension.length);
  const folder = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  const temp = `${folder}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await ops.create(temp, data);
  } catch (error) {
    await ops.remove(temp).catch(() => undefined);
    throw new FileWriteError('io', errnoOf(error) ?? null);
  }
  try {
    for (let index = 1; index <= MAX_RENAME_INDEX; index += 1) {
      const candidate = index === 1 ? target : `${folder}${stem} (${String(index)})${extension}`;
      if (await place(ops, temp, candidate)) return { path: candidate, renamed: index > 1 };
    }
    throw new FileWriteError('names_taken', null);
  } catch (error) {
    if (error instanceof FileWriteError) throw error;
    throw new FileWriteError('io', errnoOf(error) ?? null);
  } finally {
    // The target is a second name of the same file once linked; removing the temporary name keeps it.
    await ops.remove(temp).catch(() => undefined);
  }
}
