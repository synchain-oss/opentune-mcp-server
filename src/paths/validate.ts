// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The path rules of spec/otcp/v1/PROTOCOL.md section 20.1, applied to the string only so that a
// rejected path touches no file. OpenTune's own checks are authoritative; this runs first so that
// the agent gets an actionable error without a round trip.

export type PathSystem = 'windows' | 'posix';

/** The path rules that apply on the platform this process runs on. */
export const systemOf = (platform: NodeJS.Platform): PathSystem => (platform === 'win32' ? 'windows' : 'posix');

// eslint-disable-next-line no-control-regex -- U+0000 to U+001F is what the rule forbids
const CONTROL_RE = /[\u0000-\u001F]/;
const DRIVE_ABSOLUTE_RE = /^[A-Za-z]:\\/;
const DRIVE_PREFIX_RE = /^[A-Za-z]:/;
const RESERVED_DEVICE_RE = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9¹²³])$/i;

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

/** The section 20.1 reason the string breaks, or undefined if it is a valid absolute path. */
export function pathProblem(path: string, system: PathSystem): string | undefined {
  if (CONTROL_RE.test(path)) return 'path_invalid_character';
  return system === 'windows' ? windowsProblem(path) : posixProblem(path);
}

/** The extension of the last segment with its dot, or '' when it has none. */
export function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}
