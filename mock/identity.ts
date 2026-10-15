// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// File identity (spec/otcp/v1/PROTOCOL.md section 20.3): whether two paths name the same file is
// decided by the identity of the files, never by comparing strings. The identity of an existing
// file is its volume and file id (`dev` and `ino` as Node reports them; on Windows these are the
// volume serial number and the file index). A path with no file has no identity; it names the
// same file as another path when the parent directories have equal identities and the last
// segments are equal as the file system compares names.

import fs from 'node:fs';
import path from 'node:path';

import { refuse } from './errors.js';

/** The identity of an existing file or directory, as a comparable string. */
const identityKey = (stats: fs.BigIntStats): string => `${String(stats.dev)}:${String(stats.ino)}`;

/** Whether the mock treats a path as one the instance cannot open (`files.isDenied`). */
export type DeniedCheck = (file: string) => boolean;

/** A directory entry as the file system compares names: without regard to case on Windows and macOS. */
const foldName = (name: string): string =>
  process.platform === 'win32' || process.platform === 'darwin' ? name.toLowerCase() : name;

/**
 * The identity of the file at `file`, or null if nothing exists there. Throws
 * IO_ERROR(read_failed) when it cannot be determined for another reason (section 20.3 rule 4).
 */
export function identityOf(file: string, denied: DeniedCheck): string | null {
  if (denied(file)) throw refuse('IO_ERROR', 'read_failed', 'the identity of a file could not be determined');
  try {
    return identityKey(fs.statSync(file, { bigint: true }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw refuse('IO_ERROR', 'read_failed', 'the identity of a file could not be determined');
  }
}

/** Two paths name the same file (section 20.3 rules 2 and 3). May throw IO_ERROR(read_failed). */
export function sameFile(a: string, b: string, denied: DeniedCheck): boolean {
  const idA = identityOf(a, denied);
  const idB = identityOf(b, denied);
  if (idA !== null || idB !== null) return idA !== null && idA === idB;
  const parentA = identityOf(path.dirname(a), denied);
  const parentB = identityOf(path.dirname(b), denied);
  return parentA !== null && parentA === parentB && foldName(path.basename(a)) === foldName(path.basename(b));
}

/** Whether anything exists at the path (a file, a directory or a dangling link). */
export function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}
