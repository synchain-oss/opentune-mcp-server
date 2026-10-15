// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The mock's discovery file: no temporary file survives a failed write, and the guard against a
// real OpenTune data folder looks at where directories really are, and on macOS ignores case.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { canonicalPath, isInside, resolveDiscoveryDir, writeDiscoveryFile } from '../../mock/discovery.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-mock-test-'));
  cleanup.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const entries = (dir: string) => fs.readdirSync(dir);

describe('writeDiscoveryFile', () => {
  it('writes <pid>.json and leaves no temporary file', () => {
    const dir = tempDir();
    const file = writeDiscoveryFile(dir, 4242, { a: 1 });
    expect(path.basename(file)).toBe('4242.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 1 });
    expect(entries(dir)).toEqual(['4242.json']);
  });

  it.each([
    [
      'writeSync',
      () =>
        vi.spyOn(fs, 'writeSync').mockImplementation(() => {
          throw new Error('disk full');
        }),
    ],
    [
      'fsyncSync',
      () =>
        vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
          throw new Error('cannot flush');
        }),
    ],
    [
      'renameSync',
      () =>
        vi.spyOn(fs, 'renameSync').mockImplementation(() => {
          throw new Error('cannot rename');
        }),
    ],
  ])('deletes the temporary file when %s fails, and the error reaches the caller', (_name, fail) => {
    const dir = tempDir();
    fail();
    expect(() => writeDiscoveryFile(dir, 4242, { token: 'not written' })).toThrow();
    vi.restoreAllMocks();
    expect(entries(dir)).toEqual([]);
  });

  it('does not replace an existing discovery file when the write fails', () => {
    const dir = tempDir();
    writeDiscoveryFile(dir, 4242, { generation: 1 });
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('cannot rename');
    });
    expect(() => writeDiscoveryFile(dir, 4242, { generation: 2 })).toThrow();
    vi.restoreAllMocks();
    expect(entries(dir)).toEqual(['4242.json']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '4242.json'), 'utf8'))).toEqual({ generation: 1 });
  });
});

describe('the guard against a real OpenTune data folder', () => {
  /** A fake home with the Windows data folder in it, and a link to that folder from elsewhere. */
  function linkedHome() {
    const home = tempDir();
    const real = path.join(home, 'AppData', 'Local', 'OpenTune');
    fs.mkdirSync(real, { recursive: true });
    const elsewhere = tempDir();
    const link = path.join(elsewhere, 'innocent');
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    return { home, real, link, elsewhere };
  }

  it('refuses a directory that reaches a real folder through a link, existing or not yet created', () => {
    const { home, link } = linkedHome();
    expect(() => resolveDiscoveryDir(link, {}, home)).toThrow(/real OpenTune data folder/);
    expect(() => resolveDiscoveryDir(path.join(link, 'control', 'instances'), {}, home)).toThrow(
      /real OpenTune data folder/,
    );
    expect(fs.existsSync(path.join(link, 'control'))).toBe(false);
  });

  it('accepts a directory outside every real folder, also below an unrelated link', () => {
    const { home, elsewhere } = linkedHome();
    const other = path.join(elsewhere, 'plain', 'instances');
    expect(resolveDiscoveryDir(other, {}, home)).toBe(path.resolve(other));
  });

  it('resolves links through the longest existing parent', () => {
    const { real, link } = linkedHome();
    const resolved = canonicalPath(path.join(link, 'a', 'b'));
    expect(resolved.toLowerCase()).toBe(path.join(fs.realpathSync.native(real), 'a', 'b').toLowerCase());
    expect(canonicalPath(link).toLowerCase()).toBe(fs.realpathSync.native(real).toLowerCase());
  });

  it('compares names without regard to case on Windows and macOS, not on other systems', () => {
    const parent = path.resolve('/Volumes/Studio/Application Support/OpenTune');
    const child = path.resolve('/volumes/studio/application support/opentune/control/instances');
    expect(isInside(child, parent, 'darwin')).toBe(true);
    expect(isInside(child, parent, 'win32')).toBe(true);
    // path.relative on a Windows host folds case itself, so the other systems are only visible elsewhere.
    if (process.platform !== 'win32') expect(isInside(child, parent, 'linux')).toBe(false);
    expect(isInside(path.resolve('/Volumes/Studio/Application Support/OpenTunes'), parent, 'darwin')).toBe(false);
    expect(isInside(parent, parent, 'linux')).toBe(true);
  });
});
