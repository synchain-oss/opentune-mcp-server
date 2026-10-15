// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The path rules of PROTOCOL.md section 20.1 as the mock applies them, the WAV reader behind its
// import, the file identity of section 20.3 and the removal of the home directory from text.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { exists, identityOf, sameFile } from '../../mock/identity.js';
import { checkPath, extensionOf, pathProblem } from '../../mock/paths.js';
import { stripHome } from '../../mock/privacy.js';
import { readWav } from '../../mock/wav.js';
import { wavFile } from '../support/wav-file.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-paths-test-'));
  cleanup.push(dir);
  return dir;
};

describe('path rules (section 20.1)', () => {
  it.each([
    ['C:\\Music\\take1.wav', undefined],
    ['D:\\a b\\c.d.wav', undefined],
    ['take1.wav', 'path_not_absolute'],
    ['\\Music\\take1.wav', 'path_not_absolute'],
    ['C:take1.wav', 'path_drive_relative'],
    ['C:Music\\take1.wav', 'path_drive_relative'],
    ['\\\\server\\share\\take1.wav', 'path_unc'],
    ['\\\\?\\C:\\Music\\take1.wav', 'path_device_namespace'],
    ['\\\\.\\C:\\Music\\take1.wav', 'path_device_namespace'],
    ['C:\\Music\\take1.wav:stream', 'path_alternate_stream'],
    ['C:\\Music/take1.wav', 'path_not_normalized'],
    ['C:\\Music\\..\\take1.wav', 'path_not_normalized'],
    ['C:\\Music\\.\\take1.wav', 'path_not_normalized'],
    ['C:\\Music\\\\take1.wav', 'path_not_normalized'],
    ['C:\\Music\\', 'path_not_normalized'],
    ['C:\\Music\\take1.wav.', 'path_not_normalized'],
    ['C:\\Music\\take1 \\x.wav', 'path_not_normalized'],
    ['C:\\Music\\NUL.wav', 'path_reserved_name'],
    ['C:\\Music\\com1.txt.wav', 'path_reserved_name'],
    ['C:\\Music\\LPT\u00B2\\x.wav', 'path_reserved_name'],
    ['C:\\Music\\CONIN$.wav', 'path_reserved_name'],
    ['C:\\Music\\NUL .wav', 'path_reserved_name'],
    ['C:\\Music\\console.wav', undefined],
    ['C:\\Music\\take\u00011.wav', 'path_invalid_character'],
  ])('on Windows, %j gives %s', (input, reason) => {
    expect(pathProblem(input, 'windows')).toBe(reason);
  });

  it.each([
    ['/srv/a/take1.wav', undefined],
    ['take1.wav', 'path_not_absolute'],
    ['C:\\take1.wav', 'path_not_absolute'],
    ['/srv/a/../take1.wav', 'path_not_normalized'],
    ['/srv/a/./take1.wav', 'path_not_normalized'],
    ['/srv//take1.wav', 'path_not_normalized'],
    ['/srv/a/', 'path_not_normalized'],
    ['/srv/a/take\u00001.wav', 'path_invalid_character'],
    ['/srv/a/NUL.wav', undefined],
    ['/srv/a/take1.wav:stream', undefined],
  ])('on POSIX, %j gives %s', (input, reason) => {
    expect(pathProblem(input, 'posix')).toBe(reason);
  });

  it('checks the string before the extension, and the extension without regard to case', () => {
    expect(checkPath('C:\\Music\\take1.WAV', ['.wav'], 'path', 'windows')).toBeUndefined();
    expect(checkPath('/m/take1.Flac', ['.wav', '.flac'], 'path', 'posix')).toBeUndefined();
    expect(checkPath('/m/take1.mp3', ['.wav'], 'path', 'posix')?.init).toMatchObject({ reason: 'path_bad_extension' });
    expect(checkPath('/m/take1', ['.wav'], 'path', 'posix')?.init).toMatchObject({ reason: 'path_bad_extension' });
    // A name that is only an extension has none.
    expect(checkPath('/m/.wav', ['.wav'], 'path', 'posix')?.init).toMatchObject({ reason: 'path_bad_extension' });
    expect(checkPath('m/x.mp3', ['.wav'], 'path', 'posix')?.init).toMatchObject({ reason: 'path_not_absolute' });
    expect(extensionOf('C:\\a.b\\c')).toBe('');
    expect(extensionOf('/a.b/c.tar.wav')).toBe('.wav');
  });

  it('never puts the path in the detail', () => {
    const refusal = checkPath('/secret-name/../x.wav', ['.wav'], 'items[0].path', 'posix');
    expect(refusal?.init.detail).not.toContain('secret-name');
  });
});

describe('the WAV reader', () => {
  it('reads channels, rate and length, and tells a tone from silence', () => {
    expect(readWav(wavFile({ seconds: 2, rate: 8000, channels: 2 }))).toEqual({
      ok: true,
      channelCount: 2,
      sampleRateHz: 8000,
      durationSec: 2,
      voiced: true,
    });
    expect(readWav(wavFile({ seconds: 1, voiced: false }))).toMatchObject({ ok: true, voiced: false });
  });

  it.each([8, 16, 24, 32] as const)('reads %i-bit integer PCM', (bits) => {
    expect(readWav(wavFile({ seconds: 1, bits }))).toMatchObject({ ok: true, durationSec: 1, voiced: true });
  });

  it('reads 32-bit float and the extensible form of a format', () => {
    expect(readWav(wavFile({ seconds: 1, bits: 32, float: true }))).toMatchObject({ ok: true, voiced: true });
    expect(readWav(wavFile({ seconds: 1, extensible: true }))).toMatchObject({ ok: true, voiced: true });
  });

  it('stops at the end of the file when a chunk claims more than is there, and skips other chunks', () => {
    const wav = wavFile({ seconds: 1, extraChunk: true });
    expect(readWav(wav)).toMatchObject({ ok: true, durationSec: 1 });
    expect(readWav(wav.subarray(0, wav.length - 16000))).toMatchObject({ ok: true, durationSec: 0.5 });
  });

  it('rejects what it cannot decode', () => {
    expect(readWav(Buffer.from('this is not audio'))).toEqual({ ok: false });
    expect(readWav(Buffer.alloc(0))).toEqual({ ok: false });
    expect(readWav(wavFile({ seconds: 1 }).subarray(0, 30))).toEqual({ ok: false });
    expect(readWav(wavFile({ seconds: 1, bits: 64, float: true }))).toEqual({ ok: false });
    expect(readWav(wavFile({ seconds: 1, formatTag: 2 }))).toEqual({ ok: false });
    expect(readWav(wavFile({ seconds: 1, blockAlign: 3 }))).toEqual({ ok: false });
    expect(readWav(wavFile({ seconds: 1, noData: true }))).toEqual({ ok: false });
    expect(readWav(wavFile({ seconds: 1, rate: 0 }))).toEqual({ ok: false });
  });
});

describe('file identity (section 20.3)', () => {
  const denied = (file: string) => file.includes(`${path.sep}locked`);

  it('compares files by identity, not by name: a hard link is the same file, a copy is not', () => {
    const dir = tempDir();
    const original = path.join(dir, 'a.wav');
    const link = path.join(dir, 'b.wav');
    const copy = path.join(dir, 'c.wav');
    fs.writeFileSync(original, 'x');
    fs.copyFileSync(original, copy);
    let linked = true;
    try {
      fs.linkSync(original, link);
    } catch {
      linked = false;
    }
    if (linked) expect(sameFile(original, link, denied)).toBe(true);
    expect(sameFile(original, copy, denied)).toBe(false);
    expect(sameFile(original, original, denied)).toBe(true);
    expect(identityOf(original, denied)).toMatch(/^\d+:\d+$/);
  });

  it('names a missing file by its parent and its last segment', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    const missing = path.join(dir, 'sub', 'out.wav');
    expect(sameFile(missing, path.join(dir, 'sub', 'out.wav'), denied)).toBe(true);
    expect(sameFile(missing, path.join(dir, 'sub', 'other.wav'), denied)).toBe(false);
    expect(sameFile(missing, path.join(dir, 'out.wav'), denied)).toBe(false);
    // Parents that do not exist have no identity: nothing to compare.
    expect(sameFile(path.join(dir, 'no', 'out.wav'), path.join(dir, 'no', 'out.wav'), denied)).toBe(false);
    // An existing file is never the same as a missing one.
    fs.writeFileSync(path.join(dir, 'there.wav'), 'x');
    expect(sameFile(path.join(dir, 'there.wav'), path.join(dir, 'gone.wav'), denied)).toBe(false);
    expect(identityOf(path.join(dir, 'gone.wav'), denied)).toBeNull();
    expect(identityOf(path.join(dir, 'there.wav', 'below'), denied)).toBeNull();
    expect(exists(path.join(dir, 'there.wav'))).toBe(true);
    expect(exists(path.join(dir, 'gone.wav'))).toBe(false);
  });

  it('refuses with IO_ERROR(read_failed) when an identity cannot be determined', () => {
    const dir = tempDir();
    expect(() => identityOf(path.join(dir, 'locked', 'x.wav'), denied)).toThrow(/IO_ERROR\(read_failed\)/);
    expect(() => sameFile(path.join(dir, 'a.wav'), path.join(dir, 'locked', 'x.wav'), denied)).toThrow(
      /IO_ERROR\(read_failed\)/,
    );
  });
});

describe('removing the home directory from text', () => {
  it('matches both slash forms, and without regard to case on Windows only', () => {
    const home = 'C:\\Profiles\\Someone';
    const text = 'a C:\\Profiles\\Someone\\x.wav b c:/profiles/someone/y.wav c C:/Profiles/Someone';
    expect(stripHome(text, home, 'win32')).toBe('a ~\\x.wav b ~/y.wav c ~');
    expect(stripHome(text, home, 'linux')).toBe('a ~\\x.wav b c:/profiles/someone/y.wav c ~');
    expect(stripHome('/srv/a/x /srv/ab', '/srv/a', 'linux')).toBe('~/x ~b');
    expect(stripHome('unchanged', '', 'win32')).toBe('unchanged');
    // Characters that mean something in a pattern are taken literally.
    expect(stripHome('D:\\a+b(1)\\x', 'D:\\a+b(1)', 'win32')).toBe('~\\x');
  });
});
