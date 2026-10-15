// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Path validation of the mock (spec/otcp/v1/PROTOCOL.md section 20.1): the server accepts a path
// exactly as given or rejects it, and looks at the string only, so a rejected path touches no
// file. The reasons and their order follow the tables of the section.

import { refuse, type MockError } from './errors.js';

export type PathSystem = 'windows' | 'posix';

/** The system whose rules apply to the paths this process sees. */
export const hostPathSystem = (): PathSystem => (process.platform === 'win32' ? 'windows' : 'posix');

// eslint-disable-next-line no-control-regex -- U+0000 to U+001F is what the rule forbids
const CONTROL_RE = /[\u0000-\u001F]/;
const DRIVE_ABSOLUTE_RE = /^[A-Za-z]:\\/;
const DRIVE_PREFIX_RE = /^[A-Za-z]:/;
const RESERVED_DEVICE_RE = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9¹²³])$/i;

/** The first rule a Windows path breaks, as a reason of INVALID_ARGUMENT, or undefined. */
function windowsProblem(path: string): string | undefined {
  if (path.startsWith('\\\\?\\') || path.startsWith('\\\\.\\')) return 'path_device_namespace';
  if (path.startsWith('\\\\')) return 'path_unc';
  if (DRIVE_PREFIX_RE.test(path) && !DRIVE_ABSOLUTE_RE.test(path)) return 'path_drive_relative';
  if (!DRIVE_ABSOLUTE_RE.test(path)) return 'path_not_absolute';
  const rest = path.slice(3);
  if (rest.includes(':')) return 'path_alternate_stream';
  if (rest.includes('/')) return 'path_not_normalized';
  const segments = rest.split('\\');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return 'path_not_normalized';
  // Windows drops trailing dots and spaces, so the path would name another file.
  if (segments.some((s) => s.endsWith('.') || s.endsWith(' '))) return 'path_not_normalized';
  if (segments.some((s) => RESERVED_DEVICE_RE.test((s.split('.')[0] ?? '').replace(/ +$/, '')))) {
    return 'path_reserved_name';
  }
  return undefined;
}

function posixProblem(path: string): string | undefined {
  if (!path.startsWith('/')) return 'path_not_absolute';
  const segments = path.slice(1).split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return 'path_not_normalized';
  return undefined;
}

/** The reason the string breaks section 20.1, or undefined if it is a valid absolute path. */
export function pathProblem(path: string, system: PathSystem = hostPathSystem()): string | undefined {
  if (CONTROL_RE.test(path)) return 'path_invalid_character';
  return system === 'windows' ? windowsProblem(path) : posixProblem(path);
}

/** The extension of the last segment with its dot, or '' if it has none. */
export function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

/**
 * Checks the path string and its extension against `extensions` (lower case, with the dot;
 * compared without regard to case). Returns the refusal, or undefined for a valid path.
 * `what` names the path in the detail, which never carries the path itself (section 20.2).
 */
export function checkPath(
  path: string,
  extensions: readonly string[],
  what: string,
  system: PathSystem = hostPathSystem(),
): MockError | undefined {
  const problem = pathProblem(path, system);
  if (problem !== undefined)
    return refuse('INVALID_ARGUMENT', problem, `${what} is not a valid absolute path (${problem})`);
  if (!extensions.includes(extensionOf(path).toLowerCase())) {
    return refuse('INVALID_ARGUMENT', 'path_bad_extension', `${what} must end in ${extensions.join(', ')}`);
  }
  return undefined;
}
