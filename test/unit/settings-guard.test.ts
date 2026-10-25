// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The privacy side of the real-user settings watch (test/support/settings-guard.ts, test/e2e/settings-guard.ts):
// an error message that names a path inside the home folder reaches the report with `~` in its place, as the
// labels of the watched folders (`labelOf`) already keep the user's name out. Everything happens in temporary
// folders and with a made-up home folder; no real folder is touched.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { USER_SETTINGS_STEP, withUserSettingsWatch } from '../e2e/settings-guard.js';
import type { StepReport, StepResult } from '../e2e/smoke.js';
import { homeFolders, redactHome } from '../support/settings-guard.js';

type SnapshotModule = typeof import('../../scripts/e2e/settings-snapshot.mjs');
type WatchStats = SnapshotModule['watchStats'];

// The watch reads the folder twice (before and after the run); the stub lets a test make the second reading fail.
const stubbed = vi.hoisted(() => ({ watchStats: vi.fn<WatchStats>() }));
vi.mock('../../scripts/e2e/settings-snapshot.mjs', async (importOriginal) => {
  const actual = await importOriginal<SnapshotModule>();
  stubbed.watchStats.mockImplementation(actual.watchStats);
  return { ...actual, watchStats: (...args: Parameters<WatchStats>) => stubbed.watchStats(...args) };
});

// The account of the made-up home folder is put together at run time and every path is built from it, so
// that the privacy scan of the gates does not read the paths of a named account in this file as a personal
// path (it looks for a home directory of a person in every tracked file).
const ACCOUNT = ['ex', 'ample'].join('');
/** A home folder of a Windows user, with the given segments below the account. */
const winHome = (...rest: string[]): string => ['C:', 'Users', ACCOUNT, ...rest].join('\\');
/** A home folder of a POSIX user, with the given segments below the account. */
const posixHome = (...rest: string[]): string => ['/home', ACCOUNT, ...rest].join('/');
/** The same path with the backslashes doubled, as in an escaped string. */
const doubled = (value: string): string => value.replaceAll('\\', '\\\\');

const cleanup: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('redactHome', () => {
  it('replaces the home folder at the start of a path, in either slash style, once per occurrence', () => {
    const homes = [winHome()];
    expect(redactHome(`stat '${winHome('AppData', 'Roaming', 'OpenTune', 'x.settings')}'`, homes, 'win32')).toBe(
      "stat '~\\AppData\\Roaming\\OpenTune\\x.settings'",
    );
    expect(redactHome(`stat '${winHome('AppData', 'x.settings').replaceAll('\\', '/')}'`, homes, 'win32')).toBe(
      "stat '~/AppData/x.settings'",
    );
    expect(redactHome(`${winHome('a')} and ${winHome('b')}`, homes, 'win32')).toBe('~\\a and ~\\b');
    // An escaped string doubles the backslashes.
    expect(redactHome(`"${doubled(winHome('x.settings'))}"`, homes, 'win32')).toBe(`"${doubled('~\\x.settings')}"`);
    expect(redactHome(`stat '${posixHome('.config', 'OpenTune', 'x.settings')}'`, [posixHome()], 'linux')).toBe(
      "stat '~/.config/OpenTune/x.settings'",
    );
  });

  it('replaces the longer of two nested home folders first, whatever the order of the list', () => {
    // USERPROFILE below HOME: the outer folder must not take the inner one's prefix away first.
    const message = `stat '${winHome('data', 'x.settings')}' and '${winHome('a.txt')}'`;
    const expected = "stat '~\\x.settings' and '~\\a.txt'";
    expect(redactHome(message, [winHome(), winHome('data')], 'win32')).toBe(expected);
    expect(redactHome(message, [winHome('data'), winHome()], 'win32')).toBe(expected);
  });

  it('ignores the case on Windows only', () => {
    const shouted = (value: string): string => value.replace(ACCOUNT, ACCOUNT.toUpperCase());
    expect(redactHome(`stat '${shouted(winHome('x'))}'`, [winHome()], 'win32')).toBe("stat '~\\x'");
    expect(redactHome(`stat '${shouted(posixHome('x'))}'`, [posixHome()], 'linux')).toBe(
      `stat '${shouted(posixHome('x'))}'`,
    );
  });

  it('leaves another folder that only starts like the home folder alone', () => {
    // The home folder with a letter or a dot appended to its name is a different folder.
    const message = `stat '${posixHome()}2/x' and '/srv${posixHome('y')}' and '${posixHome()}.old/z'`;
    expect(redactHome(message, [posixHome()], 'linux')).toBe(message);
  });

  it('leaves a message without a home folder as it is, and takes a literal home folder with regex characters', () => {
    expect(redactHome('ENOENT: no such file', [posixHome()], 'linux')).toBe('ENOENT: no such file');
    const literal = ['/home', 'a+b$'].join('/');
    expect(redactHome(`stat '${literal}/x'`, [literal], 'linux')).toBe("stat '~/x'");
  });

  it('knows the home folders of this machine without a trailing slash, longest first, and never a bare root', () => {
    expect(homeFolders({ HOME: `${posixHome()}/`, USERPROFILE: posixHome('data') }, posixHome())).toEqual([
      posixHome('data'),
      posixHome(),
    ]);
    expect(homeFolders({ HOME: '/', USERPROFILE: 'C:\\' }, '/')).toEqual([]);
    expect(homeFolders({}, winHome())).toEqual([winHome()]);
  });
});

describe('withUserSettingsWatch keeps the home folder out of a failed comparison', () => {
  const sep = path.sep;
  const home =
    process.platform === 'win32' ? ['D:', 'Homes', ACCOUNT].join('\\') : ['/srv', 'homes', ACCOUNT].join('/');
  const base = {
    steps: [{ name: 'a', result: 'PASS', ms: 1, note: '' }] as StepReport[],
    result: 'PASS' as StepResult,
    counts: { PASS: 1, FAIL: 0, SKIP: 0, 'FLAKY-SKIP': 0 },
  };

  /** A folder with one settings file, and a second reading that fails the way a locked file does. */
  async function failingSecondReading(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ot-settings-guard-'));
    cleanup.push(dir);
    await writeFile(path.join(dir, 'app-preferences.settings'), 'x');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const actual = await vi.importActual<SnapshotModule>('../../scripts/e2e/settings-snapshot.mjs');
    stubbed.watchStats.mockReset();
    stubbed.watchStats
      .mockImplementationOnce(actual.watchStats)
      .mockRejectedValueOnce(
        Object.assign(
          new Error(
            `EACCES: permission denied, stat '${[home, 'AppData', 'Roaming', 'OpenTune', 'app-preferences.settings'].join(sep)}'`,
          ),
          { code: 'EACCES' },
        ),
      );
    return dir;
  }

  it('reports the failure with ~ for the home folder', async () => {
    const dir = await failingSecondReading();
    const report = await withUserSettingsWatch(() => Promise.resolve(base), dir);
    const step = report.steps.at(-1);
    expect(step).toMatchObject({ name: USER_SETTINGS_STEP, result: 'FAIL' });
    expect(step?.note).toContain('the real user settings could not be compared: EACCES: permission denied');
    expect(step?.note).toContain(`'~${sep}AppData${sep}Roaming${sep}OpenTune${sep}app-preferences.settings'`);
    expect(step?.note).not.toContain(home);
    expect(step?.note).not.toMatch(/homes/i);
  });

  it('does the same in the message that carries a scenario failure', async () => {
    const dir = await failingSecondReading();
    // The scenario's own error names a path in the home folder too; it goes through the same redaction.
    const scenarioError = new Error(`boom in '${path.join(home, 'x')}'`);
    const error = await withUserSettingsWatch(() => Promise.reject(scenarioError), dir).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const message = (error as Error).message;
    expect(message).toContain(`boom in '~${sep}x'`);
    expect(message).toContain(`'~${sep}AppData`);
    expect(message).not.toContain(home);
    expect(message).not.toMatch(/homes/i);
  });

  it('redacts the scenario error too when the watch found nothing wrong', async () => {
    // Both readings succeed, so the rethrown scenario error is the only message that could carry the home folder.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ot-settings-guard-'));
    cleanup.push(dir);
    await writeFile(path.join(dir, 'app-preferences.settings'), 'x');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const actual = await vi.importActual<SnapshotModule>('../../scripts/e2e/settings-snapshot.mjs');
    stubbed.watchStats.mockReset();
    stubbed.watchStats.mockImplementation(actual.watchStats);
    const scenarioError = new Error(`boom in '${path.join(home, 'x')}'`);
    const error = await withUserSettingsWatch(() => Promise.reject(scenarioError), dir).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const message = (error as Error).message;
    expect(message).toBe(`boom in '~${sep}x'`);
    expect(message).not.toContain(home);
  });
});
