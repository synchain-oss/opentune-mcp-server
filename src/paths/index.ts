// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import os from 'node:os';

import type { ToolError } from '../errors/tool-error.js';
import { pathRefusal } from './errors.js';
import { extensionProblem, normalizePath } from './normalize.js';
import { systemOf, type PathSystem } from './validate.js';

export { normalizePath } from './normalize.js';
export { pathProblem, systemOf, type PathSystem } from './validate.js';
export { pathRefusal } from './errors.js';

/** The user's home directory for `~`, from the environment of the process (tests set it), else the OS. */
export function homeDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const fromEnv = platform === 'win32' ? env.USERPROFILE : env.HOME;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    return os.homedir();
  } catch {
    return null;
  }
}

export interface PathContext {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}

export type Resolved = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: ToolError };

/**
 * Normalizes the path an agent gave and checks it against the rules of section 20.1 and, when
 * `extension` is given, against that extension (lower case, with the dot). The error never repeats
 * the path.
 */
export function resolvePath(raw: string, ctx: PathContext, what: string, extension?: string): Resolved {
  const normalized = normalizePath(raw, { system: systemOf(ctx.platform), home: homeDir(ctx.env, ctx.platform) });
  if (!normalized.ok) return { ok: false, error: pathRefusal(what, normalized.reason) };
  if (extension !== undefined && extensionProblem(normalized.path, [extension]) !== undefined) {
    return { ok: false, error: pathRefusal(what, 'path_bad_extension', extension) };
  }
  return { ok: true, path: normalized.path };
}

/** The directory, base name without extension and separator of a valid absolute path. */
export function splitPath(path: string, system: PathSystem): { dir: string; stem: string; sep: string } {
  const sep = system === 'windows' ? '\\' : '/';
  const cut = path.lastIndexOf(sep);
  const name = path.slice(cut + 1);
  const dot = name.lastIndexOf('.');
  return { dir: path.slice(0, cut), stem: dot > 0 ? name.slice(0, dot) : name, sep };
}
