// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The settings snapshot of the real-OpenTune runs (scripts/e2e/settings-snapshot.mjs and
// test/support/settings-guard.ts): snapshot, difference report, byte-exact restore, and the read-only
// watch of the real user's folder. Everything happens in temporary folders; no real folder is touched.

import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  diffSnapshots,
  diffStats,
  listSettingsFiles,
  restoreSnapshot,
  settingsEntries,
  settleSnapshot,
  takeSnapshot,
  userSettingsDir,
  watchStats,
} from '../../scripts/e2e/settings-snapshot.mjs';
import { USER_SETTINGS_STEP, withUserSettingsWatch } from '../e2e/settings-guard.js';
import type { StepReport, StepResult } from '../e2e/smoke.js';
import { guardDataDir, watchUserSettings } from '../support/settings-guard.js';

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ot-settings-test-'));
  cleanup.push(dir);
  return dir;
};

const PREFS =
  '<?xml version="1.0" encoding="UTF-8"?>\n\n<PROPERTIES>\n  <VALUE name="shared.onboardingShown" val="1"/>\n  <VALUE name="shared.tuningHz" val="440"/>\n</PROPERTIES>\n';
const JUCE =
  '<?xml version="1.0" encoding="UTF-8"?>\n\n<PROPERTIES>\n  <VALUE name="audioSetup"><DEVICESETUP deviceType="WASAPI" bufferSize="480"/></VALUE>\n</PROPERTIES>\n';

async function fill(dir: string): Promise<void> {
  await writeFile(path.join(dir, 'app-preferences.settings'), PREFS);
  await writeFile(path.join(dir, 'OpenTune.settings'), JUCE);
  await mkdir(path.join(dir, 'Logs'));
  await writeFile(path.join(dir, 'Logs', 'noise.settings'), 'log folders are never looked at');
  await mkdir(path.join(dir, 'control', 'instances'), { recursive: true });
  await writeFile(path.join(dir, 'control', 'instances', 'x.settings'), 'nor are discovery folders');
}

describe('listSettingsFiles and settingsEntries', () => {
  it('lists the settings files, sorted, without the log and discovery folders; a missing folder has none', async () => {
    const dir = await tempDir();
    await fill(dir);
    await mkdir(path.join(dir, 'OpenTune'));
    await writeFile(path.join(dir, 'OpenTune', 'nested.settings'), PREFS);
    await writeFile(path.join(dir, 'readme.txt'), 'not a settings file');
    expect(await listSettingsFiles(dir)).toEqual([
      'OpenTune.settings',
      'OpenTune/nested.settings',
      'app-preferences.settings',
    ]);
    expect(await listSettingsFiles(path.join(dir, 'missing'))).toEqual([]);
  });

  it('reads the flat value entries and ignores nested setups', () => {
    expect(settingsEntries(PREFS)).toEqual({ 'shared.onboardingShown': '1', 'shared.tuningHz': '440' });
    expect(settingsEntries(JUCE)).toEqual({});
  });
});

describe('snapshot, difference report and restore', () => {
  it('finds no difference when nothing changed', async () => {
    const dir = await tempDir();
    await fill(dir);
    const snapshot = await takeSnapshot(dir);
    expect(Object.keys(snapshot.files)).toEqual(['OpenTune.settings', 'app-preferences.settings']);
    expect(diffSnapshots(snapshot, await takeSnapshot(dir))).toEqual([]);
  });

  it('reports a changed value, an added value, a changed nested setup, an appeared and a disappeared file', async () => {
    const dir = await tempDir();
    await fill(dir);
    const snapshot = await takeSnapshot(dir);
    await writeFile(
      path.join(dir, 'app-preferences.settings'),
      PREFS.replace('val="1"', 'val="0"').replace(
        '</PROPERTIES>',
        '  <VALUE name="shared.extra" val="x"/>\n</PROPERTIES>',
      ),
    );
    await writeFile(path.join(dir, 'OpenTune.settings'), JUCE.replace('480', '960'));
    await writeFile(path.join(dir, 'new.settings'), 'abc');
    const lines = diffSnapshots(snapshot, await takeSnapshot(dir));
    expect(lines).toEqual([
      'OpenTune.settings: content differs (' + String(JUCE.length) + ' -> ' + String(JUCE.length) + ' bytes)',
      'app-preferences.settings: shared.onboardingShown: 1 -> 0',
      'app-preferences.settings: shared.extra appeared (x)',
      'new.settings: appeared (3 bytes)',
    ]);
    await rm(path.join(dir, 'OpenTune.settings'));
    expect(diffSnapshots(snapshot, await takeSnapshot(dir))).toContain('OpenTune.settings: disappeared');
  });

  it('restores the exact bytes, brings back a deleted file and removes one that appeared', async () => {
    const dir = await tempDir();
    await fill(dir);
    const snapshot = await takeSnapshot(dir);
    await writeFile(path.join(dir, 'app-preferences.settings'), 'changed');
    await rm(path.join(dir, 'OpenTune.settings'));
    await writeFile(path.join(dir, 'new.settings'), 'abc');
    const actions = await restoreSnapshot(dir, snapshot);
    expect(actions.sort()).toEqual([
      'removed new.settings',
      'rewrote OpenTune.settings',
      'rewrote app-preferences.settings',
    ]);
    expect(await readFile(path.join(dir, 'app-preferences.settings'), 'utf8')).toBe(PREFS);
    expect(await readFile(path.join(dir, 'OpenTune.settings'), 'utf8')).toBe(JUCE);
    expect(await listSettingsFiles(dir)).toEqual(['OpenTune.settings', 'app-preferences.settings']);
    expect(await restoreSnapshot(dir, snapshot)).toEqual([]);
  });

  it('settleSnapshot lists what the run changed, restores it and checks the restore', async () => {
    const dir = await tempDir();
    await fill(dir);
    const snapshot = await takeSnapshot(dir);
    await writeFile(path.join(dir, 'app-preferences.settings'), PREFS.replace('440', '442'));
    const { differences, problems } = await settleSnapshot(dir, snapshot);
    expect(differences).toEqual(['app-preferences.settings: shared.tuningHz: 440 -> 442']);
    expect(problems).toEqual([]);
    expect(await readFile(path.join(dir, 'app-preferences.settings'), 'utf8')).toBe(PREFS);
    expect((await settleSnapshot(dir, snapshot)).differences).toEqual([]);
  });

  it('settleSnapshot reports a restore that does not work', async () => {
    const dir = await tempDir();
    await fill(dir);
    const snapshot = await takeSnapshot(dir);
    await rm(path.join(dir, 'app-preferences.settings'));
    // A folder where the file belongs: it cannot be written back.
    await mkdir(path.join(dir, 'app-preferences.settings'));
    const { problems } = await settleSnapshot(dir, snapshot);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('could not be restored');
  });

  it('keeps at most a dozen lines', async () => {
    const dir = await tempDir();
    const snapshot = await takeSnapshot(dir);
    for (let i = 0; i < 20; i++) await writeFile(path.join(dir, `f${String(i).padStart(2, '0')}.settings`), 'x');
    expect(diffSnapshots(snapshot, await takeSnapshot(dir))).toHaveLength(12);
  });
});

describe('guardDataDir', () => {
  it('says what the run changed, once, and puts the files back', async () => {
    const dir = await tempDir();
    await fill(dir);
    const guard = await guardDataDir(dir);
    await writeFile(path.join(dir, 'app-preferences.settings'), PREFS.replace('val="1"', 'val="0"'));
    const first = await guard.finish();
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('shared.onboardingShown: 1 -> 0');
    expect(first[0]).toContain('put back afterwards');
    expect(await readFile(path.join(dir, 'app-preferences.settings'), 'utf8')).toBe(PREFS);
    // The second call is the same answer, not a second comparison.
    expect(await guard.finish()).toBe(first);
  });

  it('has nothing to say about a run that changed nothing', async () => {
    const dir = await tempDir();
    await fill(dir);
    expect(await (await guardDataDir(dir)).finish()).toEqual([]);
  });
});

describe('the read-only watch of the real user folder', () => {
  it('compares size and modification time only', async () => {
    const dir = await tempDir();
    await fill(dir);
    const before = await watchStats(dir);
    expect(Object.keys(before)).toEqual(['OpenTune.settings', 'app-preferences.settings']);
    expect(diffStats(before, await watchStats(dir))).toEqual([]);
    await utimes(path.join(dir, 'OpenTune.settings'), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    await writeFile(path.join(dir, 'app-preferences.settings'), `${PREFS}\n`);
    await writeFile(path.join(dir, 'third.settings'), 'x');
    const lines = diffStats(before, await watchStats(dir));
    expect(lines).toEqual([
      'OpenTune.settings: modification time changed',
      `app-preferences.settings: size ${String(PREFS.length)} -> ${String(PREFS.length + 1)}`,
      'third.settings: appeared',
    ]);
    await rm(path.join(dir, 'third.settings'));
    expect(diffStats(await watchStats(dir), {})).toContain('OpenTune.settings: disappeared');
  });

  it('knows the settings folder of each platform and nothing without a home', () => {
    expect(userSettingsDir({ APPDATA: 'D:\\Home\\h\\AppData\\Roaming' }, 'win32')).toBe(
      'D:\\Home\\h\\AppData\\Roaming\\OpenTune',
    );
    expect(userSettingsDir({}, 'win32', 'D:\\Home\\h')).toBe('D:\\Home\\h\\AppData\\Roaming\\OpenTune');
    expect(userSettingsDir({}, 'darwin', '/Volumes/h')).toBe('/Volumes/h/Library/Application Support/OpenTune');
    expect(userSettingsDir({}, 'linux', '/srv/h')).toBe('/srv/h/.config/OpenTune');
    expect(userSettingsDir({}, 'linux')).toBeUndefined();
    expect(userSettingsDir({}, 'win32')).toBeUndefined();
  });

  it('a missing folder or an unknown location is quiet', async () => {
    const dir = await tempDir();
    expect(await (await watchUserSettings(path.join(dir, 'missing'))).finish()).toEqual([]);
    expect(await (await watchUserSettings(undefined)).finish()).toEqual([]);
  });

  it('withUserSettingsWatch adds a FAIL step when a settings file changed, and nothing otherwise', async () => {
    const dir = await tempDir();
    await fill(dir);
    const base = {
      steps: [{ name: 'a', result: 'PASS', ms: 1, note: '' }] as StepReport[],
      result: 'PASS' as StepResult,
      counts: { PASS: 1, FAIL: 0, SKIP: 0, 'FLAKY-SKIP': 0 },
    };

    const quiet = await withUserSettingsWatch(() => Promise.resolve(base), dir);
    expect(quiet).toBe(base);

    const touched = await withUserSettingsWatch(async () => {
      await writeFile(path.join(dir, 'app-preferences.settings'), 'touched');
      return base;
    }, dir);
    expect(touched.result).toBe('FAIL');
    expect(touched.steps.at(-1)).toMatchObject({ name: USER_SETTINGS_STEP, result: 'FAIL' });
    expect(touched.steps.at(-1)?.note).toContain('app-preferences.settings');
    expect(touched.counts).toEqual({ PASS: 1, FAIL: 1, SKIP: 0, 'FLAKY-SKIP': 0 });
  });

  it('withUserSettingsWatch lets the scenario fail on its own', async () => {
    const dir = await tempDir();
    await expect(withUserSettingsWatch(() => Promise.reject(new Error('boom')), dir)).rejects.toThrow('boom');
  });
});
