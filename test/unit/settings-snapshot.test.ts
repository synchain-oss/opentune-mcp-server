// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The settings snapshot of the real-OpenTune runs (scripts/e2e/settings-snapshot.mjs and
// test/support/settings-guard.ts): snapshot, difference report, byte-exact restore, and the read-only
// watch of the real user's folder. Everything happens in temporary folders; no real folder is touched.

import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  diffSnapshots,
  diffStats,
  listSettingsFiles,
  restoreSnapshot,
  restoreTargetProblem,
  settingsEntries,
  settleSnapshot,
  takeSnapshot,
  unsafeSnapshotKey,
  userSettingsDirs,
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

  it('settle(): what OpenTune added while it started is only reported, a later change is a FAIL, the restore goes back to before the start', async () => {
    const dir = await tempDir();
    await fill(dir);
    const before = {
      prefs: await readFile(path.join(dir, 'app-preferences.settings')),
      juce: await readFile(path.join(dir, 'OpenTune.settings')),
    };
    const guard = await guardDataDir(dir);
    // The instance starts: it rewrites one default, adds a key to an existing file, and a new file appears.
    await writeFile(
      path.join(dir, 'app-preferences.settings'),
      PREFS.replace('440', '441').replace('</PROPERTIES>', '  <VALUE name="shared.fresh" val="d"/>\n</PROPERTIES>'),
    );
    await writeFile(path.join(dir, 'fresh.settings'), 'defaults');
    await guard.settle();
    // The run changes one existing value.
    await writeFile(
      path.join(dir, 'app-preferences.settings'),
      PREFS.replace('440', '442').replace('</PROPERTIES>', '  <VALUE name="shared.fresh" val="d"/>\n</PROPERTIES>'),
    );
    const problems = await guard.finish();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('shared.tuningHz: 441 -> 442');
    expect(problems[0]).not.toContain('shared.fresh');
    expect(problems[0]).not.toContain('fresh.settings');
    expect(guard.appeared).toEqual([
      'app-preferences.settings: shared.fresh appeared (d)',
      'fresh.settings: appeared (8 bytes)',
    ]);
    // Back to the bytes from before the start; the file OpenTune added is gone.
    expect(await readFile(path.join(dir, 'app-preferences.settings'))).toEqual(before.prefs);
    expect(await readFile(path.join(dir, 'OpenTune.settings'))).toEqual(before.juce);
    expect(await listSettingsFiles(dir)).toEqual(['OpenTune.settings', 'app-preferences.settings']);
  });

  it('without settle(), what appeared since the snapshot is only reported and no FAIL', async () => {
    const dir = await tempDir();
    await fill(dir);
    const before = await readFile(path.join(dir, 'app-preferences.settings'));
    const guard = await guardDataDir(dir);
    await writeFile(
      path.join(dir, 'app-preferences.settings'),
      PREFS.replace('</PROPERTIES>', '  <VALUE name="shared.fresh" val="d"/>\n</PROPERTIES>'),
    );
    await writeFile(path.join(dir, 'fresh.settings'), 'defaults');
    expect(await guard.finish()).toEqual([]);
    expect(guard.appeared).toEqual([
      'app-preferences.settings: shared.fresh appeared (d)',
      'fresh.settings: appeared (8 bytes)',
    ]);
    expect(await readFile(path.join(dir, 'app-preferences.settings'))).toEqual(before);
    expect(await listSettingsFiles(dir)).toEqual(['OpenTune.settings', 'app-preferences.settings']);
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

  it('a file that is deleted between the listing and the stat counts as gone, not as an error', async () => {
    const dir = await tempDir();
    await fill(dir);
    const before = await watchStats(dir);
    // The stat of the first file runs after the file was deleted: the real ENOENT, with the full path in it.
    const racing = async (file: string) => {
      if (file.endsWith('OpenTune.settings')) await rm(file);
      return stat(file);
    };
    const after = await watchStats(dir, racing);
    expect(Object.keys(after)).toEqual(['app-preferences.settings']);
    expect(diffStats(before, after)).toEqual(['OpenTune.settings: disappeared']);
    // Once it is gone, the next reading no longer lists it and says nothing about it.
    expect(diffStats(after, await watchStats(dir))).toEqual([]);
  });

  it('every other error of the stat is thrown as it is', async () => {
    const dir = await tempDir();
    await fill(dir);
    const locked = () => Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    await expect(watchStats(dir, locked)).rejects.toThrow('EACCES: permission denied');
    const odd = () => Promise.reject(new Error('no code at all'));
    await expect(watchStats(dir, odd)).rejects.toThrow('no code at all');
  });

  it('knows the settings folders of each platform (the per-user data and the state folder) and none without a home', () => {
    expect(
      userSettingsDirs(
        { APPDATA: 'D:\\Home\\h\\AppData\\Roaming', LOCALAPPDATA: 'D:\\Home\\h\\AppData\\Local' },
        'win32',
      ),
    ).toEqual(['D:\\Home\\h\\AppData\\Roaming\\OpenTune', 'D:\\Home\\h\\AppData\\Local\\OpenTune']);
    expect(userSettingsDirs({}, 'win32', 'D:\\Home\\h')).toEqual([
      'D:\\Home\\h\\AppData\\Roaming\\OpenTune',
      'D:\\Home\\h\\AppData\\Local\\OpenTune',
    ]);
    expect(userSettingsDirs({}, 'darwin', '/Volumes/h')).toEqual(['/Volumes/h/Library/Application Support/OpenTune']);
    expect(userSettingsDirs({}, 'linux', '/srv/h')).toEqual([
      '/srv/h/.config/OpenTune',
      '/srv/h/.local/state/OpenTune',
    ]);
    expect(userSettingsDirs({ XDG_STATE_HOME: '/var/s' }, 'linux', '/srv/h')).toContain('/var/s/OpenTune');
    expect(userSettingsDirs({}, 'linux')).toEqual([]);
    expect(userSettingsDirs({}, 'win32')).toEqual([]);
  });

  it('counts the files it watches in each folder', async () => {
    const a = await tempDir();
    const b = await tempDir();
    await fill(a);
    const watch = await watchUserSettings([a, b]);
    expect(watch.watched).toEqual([
      { dir: a, files: 2 },
      { dir: b, files: 0 },
    ]);
    expect(watch.files).toBe(2);
    await writeFile(path.join(b, 'late.settings'), 'x');
    const problems = await watch.finish();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('late.settings: appeared');
  });

  it('names the folders in a failure by their last two segments, never by the full path', async () => {
    const root = await tempDir();
    const roaming = path.join(root, 'Users', 'someone', 'AppData', 'Roaming', 'OpenTune');
    const local = path.join(root, 'Users', 'someone', 'AppData', 'Local', 'OpenTune');
    await mkdir(roaming, { recursive: true });
    await mkdir(local, { recursive: true });
    await writeFile(path.join(roaming, 'app-preferences.settings'), 'one');
    await writeFile(path.join(local, 'other.settings'), 'two');
    const watch = await watchUserSettings([roaming, local]);
    await writeFile(path.join(roaming, 'app-preferences.settings'), 'changed, longer');
    const problems = await watch.finish();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Roaming/OpenTune:');
    expect(problems[0]).not.toContain(root);
    expect(problems[0]).not.toContain('someone');
  });

  it('a missing folder or an unknown location is quiet', async () => {
    const dir = await tempDir();
    expect(await (await watchUserSettings(path.join(dir, 'missing'))).finish()).toEqual([]);
    expect(await (await watchUserSettings([])).finish()).toEqual([]);
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
    expect(quiet.result).toBe('PASS');
    expect(quiet.steps.at(-1)).toMatchObject({ name: USER_SETTINGS_STEP, result: 'PASS' });
    expect(quiet.steps.at(-1)?.note).toContain('watched 2 files');

    const touched = await withUserSettingsWatch(async () => {
      await writeFile(path.join(dir, 'app-preferences.settings'), 'touched');
      return base;
    }, dir);
    expect(touched.result).toBe('FAIL');
    expect(touched.steps.at(-1)).toMatchObject({ name: USER_SETTINGS_STEP, result: 'FAIL' });
    expect(touched.steps.at(-1)?.note).toContain('app-preferences.settings');
    expect(touched.counts).toEqual({ PASS: 1, FAIL: 1, SKIP: 0, 'FLAKY-SKIP': 0 });
  });

  it('withUserSettingsWatch is a SKIP, not a PASS, when it found no file to watch', async () => {
    const dir = await tempDir();
    const base = {
      steps: [{ name: 'a', result: 'PASS', ms: 1, note: '' }] as StepReport[],
      result: 'PASS' as StepResult,
      counts: { PASS: 1, FAIL: 0, SKIP: 0, 'FLAKY-SKIP': 0 },
    };
    const report = await withUserSettingsWatch(() => Promise.resolve(base), path.join(dir, 'missing'));
    expect(report.steps.at(-1)).toMatchObject({ name: USER_SETTINGS_STEP, result: 'SKIP' });
    expect(report.steps.at(-1)?.note).toContain('no settings file found');
    expect(report.result).toBe('SKIP');
  });

  it('withUserSettingsWatch lets the scenario fail on its own', async () => {
    const dir = await tempDir();
    await fill(dir);
    await expect(withUserSettingsWatch(() => Promise.reject(new Error('boom')), dir)).rejects.toThrow(/^boom$/);
  });

  it('withUserSettingsWatch keeps both when the scenario throws and a settings file changed', async () => {
    const dir = await tempDir();
    await fill(dir);
    const failure = new Error('boom');
    const error = await withUserSettingsWatch(async () => {
      await writeFile(path.join(dir, 'app-preferences.settings'), 'touched');
      throw failure;
    }, dir).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('boom');
    expect(message).toContain(USER_SETTINGS_STEP);
    expect(message).toContain('app-preferences.settings');
    expect((error as Error).cause).toBe(failure);
  });

  it('withUserSettingsWatch does not lose the scenario error when the watch itself fails', async () => {
    const dir = await tempDir();
    await fill(dir);
    // The settings folder turns into a file during the run: reading its stats later must not hide 'boom'.
    const error = await withUserSettingsWatch(async () => {
      await rm(dir, { recursive: true, force: true });
      await writeFile(dir, 'now a file');
      throw new Error('boom');
    }, dir).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as Error).message).toContain('boom');
  });
});

describe('restore refuses what could do harm', () => {
  it('rejects snapshot keys that are not plain relative paths', () => {
    const bad = ['', '../x.settings', 'a/../../x.settings', '/etc/x.settings', 'C:/x.settings', 'c:x.settings'];
    bad.push('a\\b.settings', 'a//b.settings', './a.settings', 'a\0.settings');
    for (const key of bad) expect(unsafeSnapshotKey(key), JSON.stringify(key)).toBeDefined();
    for (const good of ['a.settings', 'OpenTune/nested.settings', 'a/b/c/d.settings']) {
      expect(unsafeSnapshotKey(good)).toBeUndefined();
    }
  });

  it('restoreSnapshot throws before it deletes or writes anything when a key is unsafe', async () => {
    const dir = await tempDir();
    await fill(dir);
    const outer = await tempDir();
    const snapshot = await takeSnapshot(dir);
    const evil = {
      ...snapshot,
      files: { ...snapshot.files, '../escaped.settings': snapshot.files['OpenTune.settings'] },
    } as typeof snapshot;
    await writeFile(path.join(dir, 'extra.settings'), 'must stay');
    await expect(restoreSnapshot(dir, evil)).rejects.toThrow(/unsafe file name/);
    expect(await listSettingsFiles(dir)).toContain('extra.settings');
    expect(await listSettingsFiles(outer)).toEqual([]);
    // Through the guard round the refusal is a problem line, not an exception.
    const { problems } = await settleSnapshot(dir, evil);
    expect(problems[0]).toContain('unsafe file name');
  });

  it('refuses a folder that is, contains or lies inside the real settings folder', () => {
    const real = ['D:\\Home\\h\\AppData\\Roaming\\OpenTune', 'D:\\Home\\h\\AppData\\Local\\OpenTune'];
    for (const bad of [
      'D:\\Home\\h\\AppData\\Roaming\\OpenTune',
      'd:\\home\\h\\appdata\\roaming\\opentune\\',
      'D:\\Home\\h\\AppData\\Roaming',
      'D:\\Home\\h',
      'D:\\',
      'D:\\Home\\h\\AppData\\Local\\OpenTune\\control',
    ]) {
      expect(restoreTargetProblem(bad, real, 'win32'), bad).toContain('real OpenTune');
    }
    expect(restoreTargetProblem('D:\\Scratch\\run1', real, 'win32')).toBeUndefined();
    expect(restoreTargetProblem('/srv/h/.config', ['/srv/h/.config/OpenTune'], 'linux')).toBeDefined();
    expect(restoreTargetProblem('/srv/h/.config/OpenTune2', ['/srv/h/.config/OpenTune'], 'linux')).toBeUndefined();
  });

  it('a sibling whose name merely starts with two dots is not outside', () => {
    // relative('/srv/h/..cache', '/srv/h/..cache/OpenTune') is 'OpenTune'; relative('/srv/h/..cache/OpenTune',
    // '/srv/h/..cache') is '..'; a folder named '..cache' below the user folder is a child, not a parent.
    expect(restoreTargetProblem('/srv/h/..cache', ['/srv/h/..cache/OpenTune'], 'linux')).toBeDefined();
    expect(restoreTargetProblem('/srv/h/OpenTune/..cache', ['/srv/h/OpenTune'], 'linux')).toBeDefined();
    expect(restoreTargetProblem('/srv/h', ['/srv/h/..cache/OpenTune'], 'linux')).toBeDefined();
    expect(restoreTargetProblem('/srv/h/..cache', ['/srv/h/OpenTune'], 'linux')).toBeUndefined();
    expect(restoreTargetProblem('D:\\Home\\h\\..cache', ['D:\\Home\\h\\OpenTune'], 'win32')).toBeUndefined();
    // Another drive is outside as well.
    expect(restoreTargetProblem('E:\\Scratch', ['D:\\Home\\h\\OpenTune'], 'win32')).toBeUndefined();
  });
});
