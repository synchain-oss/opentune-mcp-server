// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Turns a path as a user or an agent wrote it into the absolute path OTCP accepts, or says why it
// cannot: quotes and invisible marks removed, file:// URLs decoded, ~ expanded, /mnt/<drive>/
// turned into <drive>:\ on Windows, forward slashes made backslashes on Windows. Relative paths,
// UNC paths, device namespaces, drive-relative paths and alternate data streams are refused, never
// repaired. Only the string is looked at; no file is touched.

import { cleanPathInput } from '../sanitize/path-input.js';
import { extensionOf, pathProblem, type PathSystem } from './validate.js';

export interface PathEnv {
  readonly system: PathSystem;
  /** The user's home directory for `~`, or null when it is not known. */
  readonly home: string | null;
}

export type Normalized = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

const fail = (reason: string): Normalized => ({ ok: false, reason });
const toBackslashes = (text: string): string => text.replaceAll('/', '\\');

/** The path part of a file: URL, or the reason it cannot name a local file. */
function fromFileUrl(text: string, system: PathSystem): Normalized {
  let rest = text.slice('file:'.length);
  let host = '';
  if (rest.startsWith('//')) {
    const slash = rest.indexOf('/', 2);
    host = slash === -1 ? rest.slice(2) : rest.slice(2, slash);
    rest = slash === -1 ? '' : rest.slice(slash);
  }
  if (host !== '' && host.toLowerCase() !== 'localhost') return fail('path_unc');
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return fail('path_not_normalized');
  }
  // file:///C:/Music/a.wav carries the drive after the slash that starts the path.
  if (system === 'windows' && /^\/[A-Za-z]:/.test(decoded)) decoded = decoded.slice(1);
  return { ok: true, path: decoded };
}

/** `~` and `~/...` (also `~\...`) expanded; null when the text does not start with a home reference. */
function expandHome(text: string, home: string | null, system: PathSystem): Normalized | null {
  if (text !== '~' && !text.startsWith('~/') && !text.startsWith('~\\')) return null;
  if (home === null || home === '') return fail('path_not_absolute');
  const tail = text.slice(1);
  return { ok: true, path: home.replace(/[\\/]+$/, '') + (system === 'windows' ? toBackslashes(tail) : tail) };
}

const MNT_RE = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/s;

/** Normalizes `raw`; the result is valid under the rules of section 20.1, or names the rule it breaks. */
export function normalizePath(raw: string, env: PathEnv): Normalized {
  const { system } = env;
  let text = cleanPathInput(raw);
  if (/^file:/i.test(text)) {
    const url = fromFileUrl(text, system);
    if (!url.ok) return url;
    text = url.path;
  } else {
    const home = expandHome(text, env.home, system);
    if (home !== null) {
      if (!home.ok) return home;
      text = home.path;
    }
  }
  if (system === 'windows') {
    const mnt = MNT_RE.exec(text);
    if (mnt !== null) text = `${(mnt[1] ?? '').toUpperCase()}:\\${toBackslashes(mnt[2] ?? '')}`;
    // Slashes become backslashes only where the string is plainly a drive path or a UNC or device
    // path, so that the latter two are recognized and refused rather than read as relative.
    else if (/^[A-Za-z]:[\\/]/.test(text) || /^[\\/]{2}/.test(text)) text = toBackslashes(text);
  }
  const problem = pathProblem(text, system);
  return problem === undefined ? { ok: true, path: text } : fail(problem);
}

/** 'path_bad_extension' unless the path ends in one of `extensions` (lower case, with the dot), compared without regard to case. */
export function extensionProblem(path: string, extensions: readonly string[]): string | undefined {
  return extensions.includes(extensionOf(path).toLowerCase()) ? undefined : 'path_bad_extension';
}
