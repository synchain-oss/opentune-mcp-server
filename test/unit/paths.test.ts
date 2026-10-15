// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Path cleaning, normalization and refusal (spec/otcp/v1/PROTOCOL.md section 20.1) on both path
// systems whatever the platform of the test run: quotes, file:// URLs, ~, /mnt/<drive>/, relative,
// UNC, device namespaces, drive-relative paths, alternate data streams, reserved names, Chinese
// and spaced paths, and the .wav extension rule. Refusals never repeat the path.

import { describe, expect, it } from 'vitest';

import type { PathSystem } from '../../src/paths/validate.js';
import { homeDir, normalizePath, pathProblem, pathRefusal, resolvePath, splitPath } from '../../src/paths/index.js';
import { extensionProblem } from '../../src/paths/normalize.js';
import { cleanPathInput } from '../../src/sanitize/path-input.js';
import { KNOWN_ERROR_KINDS } from '../../src/errors/next-step.js';
import { otcpSpec } from '../support/otcp-spec.js';

const WIN = { system: 'windows', home: 'C:\\Users\\Public' } as const;
const POSIX = { system: 'posix', home: '/home/user' } as const;

const ok = (raw: string, env: { system: PathSystem; home: string | null }) => {
  const result = normalizePath(raw, env);
  if (!result.ok) throw new Error(`expected a path, got ${result.reason}`);
  return result.path;
};
const reason = (raw: string, env: { system: PathSystem; home: string | null }) => {
  const result = normalizePath(raw, env);
  if (result.ok) throw new Error(`expected a refusal, got ${result.path}`);
  return result.reason;
};

describe('cleanPathInput', () => {
  it('removes straight, typographic and nested quotes, spaces and invisible marks', () => {
    expect(cleanPathInput('"C:\\Music\\a.wav"')).toBe('C:\\Music\\a.wav');
    expect(cleanPathInput("  '/home/user/a.wav'  ")).toBe('/home/user/a.wav');
    expect(cleanPathInput('\u201c/home/user/a.wav\u201d')).toBe('/home/user/a.wav');
    expect(cleanPathInput('\u2018/home/user/a.wav\u2019')).toBe('/home/user/a.wav');
    expect(cleanPathInput('\u00ab/home/user/a.wav\u00bb')).toBe('/home/user/a.wav');
    expect(cleanPathInput('`/home/user/a.wav`')).toBe('/home/user/a.wav');
    expect(cleanPathInput('" \'/home/user/a.wav\' "')).toBe('/home/user/a.wav');
    expect(cleanPathInput('\u202aC:\\Music\\a.wav\u200e')).toBe('C:\\Music\\a.wav');
    expect(cleanPathInput('\ufeff/home/user/a.wav')).toBe('/home/user/a.wav');
    // Marks inside the name belong to it (a zero width joiner in an emoji sequence).
    expect(cleanPathInput('\u202a"C:\\Music\\a\u200db\u200e.wav"\u200f')).toBe('C:\\Music\\a\u200db\u200e.wav');
    expect(cleanPathInput(' \u202a C:\\Music\\a.wav ')).toBe('C:\\Music\\a.wav');
  });

  it('keeps a quote that has no partner and stops at the nesting limit', () => {
    expect(cleanPathInput('"/home/user/a.wav')).toBe('"/home/user/a.wav');
    expect(cleanPathInput('"/home/user/a.wav\'')).toBe('"/home/user/a.wav\'');
    expect(cleanPathInput('"')).toBe('"');
    expect(cleanPathInput('""""""x""""""')).toBe('""x""');
    expect(cleanPathInput('')).toBe('');
    expect(cleanPathInput('plain')).toBe('plain');
  });
});

describe('normalizePath on Windows', () => {
  it('accepts drive paths with either separator, quotes and spaces', () => {
    expect(ok('C:\\Music\\a.wav', WIN)).toBe('C:\\Music\\a.wav');
    expect(ok('"C:/Music/My Songs/a.wav"', WIN)).toBe('C:\\Music\\My Songs\\a.wav');
    expect(ok('C:\\音乐\\人声 01.wav', WIN)).toBe('C:\\音乐\\人声 01.wav');
  });

  it('turns file:// URLs, ~ and /mnt/<drive>/ into drive paths', () => {
    expect(ok('file:///C:/Music/a%20b.wav', WIN)).toBe('C:\\Music\\a b.wav');
    expect(ok('FILE://localhost/C:/Music/a.wav', WIN)).toBe('C:\\Music\\a.wav');
    expect(ok('file:///C:/%E9%9F%B3%E4%B9%90/a.wav', WIN)).toBe('C:\\音乐\\a.wav');
    expect(ok('~/Music/a.wav', WIN)).toBe('C:\\Users\\Public\\Music\\a.wav');
    expect(ok('~\\Music\\a.wav', { ...WIN, home: 'C:\\Users\\Public\\' })).toBe('C:\\Users\\Public\\Music\\a.wav');
    expect(ok('/mnt/c/Music/a.wav', WIN)).toBe('C:\\Music\\a.wav');
    expect(ok('/mnt/d/a.wav', WIN)).toBe('D:\\a.wav');
  });

  it.each([
    ['a.wav', 'path_not_absolute'],
    ['Music\\a.wav', 'path_not_absolute'],
    ['\\Music\\a.wav', 'path_not_absolute'],
    ['/Music/a.wav', 'path_not_absolute'],
    ['\\\\server\\share\\a.wav', 'path_unc'],
    ['//server/share/a.wav', 'path_unc'],
    ['file://server/share/a.wav', 'path_unc'],
    ['\\\\?\\C:\\Music\\a.wav', 'path_device_namespace'],
    ['\\\\.\\C:\\Music\\a.wav', 'path_device_namespace'],
    ['//?/C:/Music/a.wav', 'path_device_namespace'],
    ['C:a.wav', 'path_drive_relative'],
    ['C:Music\\a.wav', 'path_drive_relative'],
    ['C:\\Music\\a.wav:stream', 'path_alternate_stream'],
    ['C:\\Music\\a.wav::$DATA', 'path_alternate_stream'],
    ['C:\\Music\\..\\a.wav', 'path_not_normalized'],
    ['C:\\Music\\.\\a.wav', 'path_not_normalized'],
    ['C:\\Music\\\\a.wav', 'path_not_normalized'],
    ['C:\\Music\\a.wav.', 'path_not_normalized'],
    ['C:\\Music \\a.wav', 'path_not_normalized'],
    ['C:\\Music\\NUL.wav', 'path_reserved_name'],
    ['C:\\Music\\com1', 'path_reserved_name'],
    ['C:\\Music\\a\u0007.wav', 'path_invalid_character'],
    ['C:\\Music\\a\n.wav', 'path_invalid_character'],
    ['~other/a.wav', 'path_not_absolute'],
    ['file:///C:/a%ZZ.wav', 'path_not_normalized'],
    ['file:///C:/a%00.wav', 'path_invalid_character'],
    ['', 'path_not_absolute'],
    ['/mnt/e', 'path_not_normalized'],
  ])('refuses %j as %s', (raw, expected) => {
    expect(reason(raw, WIN)).toBe(expected);
  });

  it('refuses ~ when the home directory is unknown', () => {
    expect(reason('~/a.wav', { system: 'windows', home: null })).toBe('path_not_absolute');
    expect(reason('~/a.wav', { system: 'windows', home: '' })).toBe('path_not_absolute');
  });
});

describe('normalizePath on POSIX', () => {
  it('accepts absolute paths, spaces and Chinese names, and leaves /mnt/ alone', () => {
    expect(ok('/home/user/人声 01.wav', POSIX)).toBe('/home/user/人声 01.wav');
    expect(ok("'/home/user/a b.wav'", POSIX)).toBe('/home/user/a b.wav');
    expect(ok('/mnt/c/Music/a.wav', POSIX)).toBe('/mnt/c/Music/a.wav');
    expect(ok('file:///home/user/a%20b.wav', POSIX)).toBe('/home/user/a b.wav');
    expect(ok('file:/home/user/a.wav', POSIX)).toBe('/home/user/a.wav');
    expect(ok('~/a.wav', POSIX)).toBe('/home/user/a.wav');
    expect(ok('~', POSIX)).toBe('/home/user');
  });

  it.each([
    ['a.wav', 'path_not_absolute'],
    ['./a.wav', 'path_not_absolute'],
    ['C:\\Music\\a.wav', 'path_not_absolute'],
    ['/home/user/../a.wav', 'path_not_normalized'],
    ['/home/user//a.wav', 'path_not_normalized'],
    ['/home/user/./a.wav', 'path_not_normalized'],
    ['/home/user/a\tb.wav', 'path_invalid_character'],
    ['file://server/share/a.wav', 'path_unc'],
  ])('refuses %j as %s', (raw, expected) => {
    expect(reason(raw, POSIX)).toBe(expected);
  });
});

describe('pathProblem and extensions', () => {
  it('judges the string only', () => {
    expect(pathProblem('C:\\a.wav', 'windows')).toBeUndefined();
    expect(pathProblem('/a.wav', 'posix')).toBeUndefined();
    expect(pathProblem('C:\\a.wav', 'posix')).toBe('path_not_absolute');
  });

  it('compares extensions without regard to case', () => {
    expect(extensionProblem('C:\\a.WAV', ['.wav'])).toBeUndefined();
    expect(extensionProblem('C:\\a.mp3', ['.wav'])).toBe('path_bad_extension');
    expect(extensionProblem('C:\\.wav', ['.wav'])).toBe('path_bad_extension');
    expect(extensionProblem('/a', ['.wav'])).toBe('path_bad_extension');
    expect(extensionProblem('/dir.wav/a', ['.wav'])).toBe('path_bad_extension');
  });

  it('splits a path into directory, stem and separator', () => {
    expect(splitPath('C:\\Music\\take.1.wav', 'windows')).toEqual({ dir: 'C:\\Music', stem: 'take.1', sep: '\\' });
    expect(splitPath('/home/user/take.wav', 'posix')).toEqual({ dir: '/home/user', stem: 'take', sep: '/' });
    expect(splitPath('/noext', 'posix')).toEqual({ dir: '', stem: 'noext', sep: '/' });
  });
});

describe('resolvePath and pathRefusal', () => {
  const ctx = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) => ({ env, platform });

  it('resolves with the environment of the process and checks the extension', () => {
    const home = resolvePath('~/a.wav', ctx('linux', { HOME: '/home/user' }), 'path', '.wav');
    expect(home).toEqual({ ok: true, path: '/home/user/a.wav' });
    const win = resolvePath('~/a.wav', ctx('win32', { USERPROFILE: 'C:\\Users\\Public' }), 'path');
    expect(win).toEqual({ ok: true, path: 'C:\\Users\\Public\\a.wav' });
    const bad = resolvePath('/home/user/a.mp3', ctx('linux'), 'path', '.wav');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatchObject({ kind: 'INVALID_ARGUMENT', reason: 'path_bad_extension' });
  });

  it('falls back to the operating system for the home directory', () => {
    expect(homeDir({}, 'linux')).toEqual(expect.any(String));
    expect(homeDir({ HOME: '' }, 'linux')).toEqual(expect.any(String));
    expect(homeDir({ USERPROFILE: 'D:\\u' }, 'win32')).toBe('D:\\u');
  });

  it('never repeats the path or its home directory, and always gives a next step', () => {
    const secret = 'C:\\Users\\Public\\private\\..\\take.wav';
    const refused = resolvePath(secret, ctx('win32'), 'path');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    const text = JSON.stringify(refused.error);
    expect(text).not.toContain('Public');
    expect(text).not.toContain('private');
    expect(refused.error).toMatchObject({ kind: 'INVALID_ARGUMENT', reason: 'path_not_normalized', executed: false });
    expect(refused.error.nextStep.message.length).toBeGreaterThan(10);
  });

  it('knows a reason the registry lists for every rule it can refuse with', () => {
    for (const code of [
      'path_not_absolute',
      'path_unc',
      'path_device_namespace',
      'path_drive_relative',
      'path_alternate_stream',
      'path_not_normalized',
      'path_reserved_name',
      'path_invalid_character',
      'path_bad_extension',
    ]) {
      expect(otcpSpec().reasons.has(`INVALID_ARGUMENT/${code}`), code).toBe(true);
      expect(pathRefusal('path', code).reason, code).toBe(code);
      expect(pathRefusal('path', code).nextStep.message, code).not.toBe('');
    }
    // A rule this server does not know is reported as a path in the wrong form, not echoed.
    expect(pathRefusal('items[1]', 'path_future_rule')).toMatchObject({ reason: 'path_not_normalized' });
    expect(KNOWN_ERROR_KINDS).toContain('INVALID_ARGUMENT');
  });

  it('names the extension in the error for a wrong extension', () => {
    const error = pathRefusal('path', 'path_bad_extension', '.wav');
    expect(error.detail).toContain('.wav');
    expect(error.nextStep.message).toContain('.wav');
  });
});
