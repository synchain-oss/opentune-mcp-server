// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Autosave copies and the old versions of a project file (opentune_save_project mode autosave, and the old version
// that mode save, mode save_as and opentune_save_project_overwrite keep before they replace a file), against the mock:
// where the files go and how they are named, the roll to the newest 50 and 10, the order of backup and save, what
// happens when a step fails, and the guard that the file system work stays inside the two folders next to the project
// file and deletes only files that match their folder's pattern.

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startMock } from '../../mock/server.js';
import {
  AUTOSAVE_KEEP,
  OLDVERSION_KEEP,
  ProjectFolders,
  autosavesToDelete,
  localStamp,
  nextAutosaveNumber,
  nodeProjectFs,
  oldVersionsToDelete,
  type FolderEntry,
  type ProjectFs,
} from '../../src/files/project-folders.js';
import { overwriteProject, saveProject, saveProjectTool } from '../../src/tools/project-files.js';
import type { Outcome, ToolContext } from '../../src/tools/registry.js';
import { tempDir, testContext } from '../support/context.js';
import { failTemporaryWrites } from '../support/fs-faults.js';
import { clip, need } from '../support/mock-client.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A local time, so that the time stamp in the name of an old version does not depend on the zone of the machine. */
const NOW = new Date(2026, 9, 28, 14, 5, 9).getTime();
const STAMP = '20261028-140509';

const FILES = [
  { bind: 'proj', kind: 'project', durationSec: 3 },
  { bind: 'other', kind: 'project', durationSec: 3 },
  { bind: 'fresh', kind: 'absent', extension: '.otproj' },
] as const;

interface Call {
  readonly op: keyof ProjectFs;
  readonly args: readonly string[];
}

/** The file system operations of the real file system, recorded; `overrides` replace single operations. */
function recorded(overrides: Partial<ProjectFs> = {}) {
  const calls: Call[] = [];
  const ops: ProjectFs = {
    list: (dir) => {
      calls.push({ op: 'list', args: [dir] });
      return (overrides.list ?? nodeProjectFs.list)(dir);
    },
    makeDir: (dir) => {
      calls.push({ op: 'makeDir', args: [dir] });
      return (overrides.makeDir ?? nodeProjectFs.makeDir)(dir);
    },
    copyNew: (from, to) => {
      calls.push({ op: 'copyNew', args: [from, to] });
      return (overrides.copyNew ?? nodeProjectFs.copyNew)(from, to);
    },
    remove: (file) => {
      calls.push({ op: 'remove', args: [file] });
      return (overrides.remove ?? nodeProjectFs.remove)(file);
    },
    fileExists: (file) => {
      calls.push({ op: 'fileExists', args: [file] });
      return (overrides.fileExists ?? nodeProjectFs.fileExists)(file);
    },
    sameFile: (a, b) => {
      calls.push({ op: 'sameFile', args: [a, b] });
      return (overrides.sameFile ?? nodeProjectFs.sameFile)(a, b);
    },
  };
  return { ops, calls };
}

const denied = (): Promise<never> => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));

interface SetupOptions {
  readonly files?: ProjectFs;
  /** The project has no file yet. */
  readonly noFile?: boolean;
  readonly withoutCapabilities?: readonly string[];
  readonly now?: number | (() => number);
}

async function setup(options: SetupOptions = {}) {
  const t = tempDir();
  cleanup.push(t.remove);
  const mock = await startMock({ discoveryDir: t.dir });
  cleanup.push(() => mock.stop());
  const ctx = testContext(t.dir, {
    now: options.now ?? NOW,
    ...(options.files === undefined ? {} : { files: options.files }),
  });
  cleanup.push(() => {
    ctx.instances.close();
  });
  const ids = mock.given({
    files: [...FILES],
    clips: [clip()],
    dirty: true,
    ...(options.noFile === true ? {} : { projectFile: 'proj' }),
    ...(options.withoutCapabilities === undefined ? {} : { withoutCapabilities: [...options.withoutCapabilities] }),
  });
  const proj = need(ids, 'proj');
  const { dir, name: stem } = path.parse(proj);
  const other = need(ids, 'other');
  const otherStem = path.parse(other).name;
  return {
    mock,
    ctx,
    proj,
    other,
    fresh: need(ids, 'fresh'),
    dir,
    stem,
    autosaveDir: path.join(dir, `${stem}.autosave`),
    oldDir: path.join(dir, `${stem}.oldversion`),
    otherOldDir: path.join(path.dirname(other), `${otherStem}.oldversion`),
  };
}

const body = (outcome: Outcome) => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.error.kind}(${String(outcome.error.reason)})`);
  return outcome.body as Record<string, unknown> & { summary: string };
};
const failure = (outcome: Outcome) => {
  if (outcome.ok) throw new Error('expected an error');
  return outcome.error;
};

const wait = { wait_seconds: 10 };
const autosave = (ctx: ToolContext) => saveProject(ctx, { mode: 'autosave', ...wait });
const save = (ctx: ToolContext) => saveProject(ctx, { mode: 'save', ...wait });
const names = (dir: string) => fs.readdirSync(dir).sort();
const autosaveName = (stem: string, n: number) => `${stem}-autosave-${String(n).padStart(4, '0')}.otproj`;

/** Writes empty files with these names into `dir` (made if needed). */
function populate(dir: string, files: readonly string[]) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of files) fs.writeFileSync(path.join(dir, name), `content of ${name}`);
}

describe('opentune_save_project mode autosave', () => {
  it('writes numbered copies into <name>.autosave next to the project file and leaves the project alone', async () => {
    const s = await setup();
    const before = fs.readFileSync(s.proj);
    const first = body(await autosave(s.ctx));
    const firstPath = path.join(s.autosaveDir, autosaveName(s.stem, 1));
    expect(first.autosave).toMatchObject({ path: firstPath, number: 1, folder: s.autosaveDir, keep: AUTOSAVE_KEEP });
    expect(fs.existsSync(firstPath)).toBe(true);
    expect(names(s.autosaveDir)).toEqual([autosaveName(s.stem, 1)]);
    // The first sentence: which copy, and that the project file did not change while the project still has changes.
    expect(first.summary).toMatch(
      /^opentune_save_project: wrote autosave copy 1 \(path in autosave\.path\); the project file was not changed and the project still has unsaved changes\./,
    );
    expect(first.summary).not.toContain(s.proj);
    expect(first.summary).not.toContain(s.autosaveDir);
    expect(first).toMatchObject({
      projectPath: s.proj,
      projectDirty: true,
      job: { kind: 'projectCopy', state: 'succeeded' },
      notSavedInProject: ['visibleTrackCount', 'undoHistory', 'preferences'],
      mediaFolder: path.join(s.autosaveDir, 'Project_Media'),
    });
    // Nothing of the project changed: the file, the flag, and no old version was made.
    expect(fs.readFileSync(s.proj).equals(before)).toBe(true);
    expect(s.mock.snapshot().dirty).toBe(true);
    expect(fs.existsSync(s.oldDir)).toBe(false);

    const second = body(await autosave(s.ctx));
    expect(second.autosave).toMatchObject({ number: 2, path: path.join(s.autosaveDir, autosaveName(s.stem, 2)) });
    expect(names(s.autosaveDir)).toEqual([autosaveName(s.stem, 1), autosaveName(s.stem, 2)]);
  });

  it('takes the next number after the highest in the folder, not after the count', async () => {
    const s = await setup();
    populate(s.autosaveDir, [autosaveName(s.stem, 3), autosaveName(s.stem, 7)]);
    const result = body(await autosave(s.ctx));
    expect(result.autosave).toMatchObject({ number: 8 });
    expect(fs.existsSync(path.join(s.autosaveDir, autosaveName(s.stem, 8)))).toBe(true);
  });

  it('keeps the newest 50: the 51st copy deletes the oldest one and nothing that does not match', async () => {
    const s = await setup();
    const copies = Array.from({ length: AUTOSAVE_KEEP }, (_, i) => autosaveName(s.stem, 10 + i));
    populate(s.autosaveDir, copies);
    // Things that must survive, although some look like copies: a directory with the name of the oldest copy, the
    // media folder with a file in it, a user's own project file, another project's copy, a number of three digits,
    // a suffix after .otproj, and the project's own old-version name.
    const alien = [
      'notes.txt',
      'mine.otproj',
      'other-autosave-0001.otproj',
      `${s.stem}-autosave-001.otproj`,
      `${autosaveName(s.stem, 2)}.bak`,
      `${s.stem}-${STAMP}.otproj`,
      `${s.stem}.otproj`,
    ];
    populate(s.autosaveDir, alien);
    fs.mkdirSync(path.join(s.autosaveDir, autosaveName(s.stem, 1)));
    fs.mkdirSync(path.join(s.autosaveDir, 'Project_Media'));
    fs.writeFileSync(path.join(s.autosaveDir, 'Project_Media', 'take1.wav'), 'audio');
    // The project's directory holds other project files, too.
    fs.writeFileSync(path.join(s.dir, 'sibling.otproj'), 'sibling');

    const result = body(await autosave(s.ctx));
    expect(result.autosave).toMatchObject({ number: 60, removedOlder: 1, couldNotRemove: 0 });
    expect(result.summary).toContain('1 copy beyond the newest 50 was deleted from that folder.');
    const left = names(s.autosaveDir);
    expect(left.filter((n) => /-autosave-\d{4}\.otproj$/.test(n) && n.startsWith(`${s.stem}-`)).length).toBe(
      AUTOSAVE_KEEP + 1,
    );
    expect(left).not.toContain(copies[0]);
    expect(left).toEqual(
      expect.arrayContaining([
        ...copies.slice(1),
        autosaveName(s.stem, 60),
        ...alien,
        autosaveName(s.stem, 1),
        'Project_Media',
      ]),
    );
    expect(fs.statSync(path.join(s.autosaveDir, autosaveName(s.stem, 1))).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(s.autosaveDir, 'Project_Media', 'take1.wav'), 'utf8')).toBe('audio');
    expect(fs.existsSync(path.join(s.dir, 'sibling.otproj'))).toBe(true);
    expect(fs.existsSync(s.proj)).toBe(true);
  });

  it('deletes nothing when the copy fails', async () => {
    const s = await setup();
    // 51 copies: a roll that ran regardless of the outcome would delete the oldest one.
    const copies = Array.from({ length: AUTOSAVE_KEEP + 1 }, (_, i) => autosaveName(s.stem, 10 + i));
    populate(s.autosaveDir, copies);
    failTemporaryWrites();
    const error = failure(await autosave(s.ctx));
    expect(error).toMatchObject({ kind: 'IO_ERROR', reason: 'write_failed' });
    expect(names(s.autosaveDir)).toEqual([...copies].sort());
  });

  it('writes nothing and says what to do when the project has no file yet', async () => {
    const s = await setup({ noFile: true });
    const before = names(s.dir);
    const error = failure(await autosave(s.ctx));
    expect(error).toMatchObject({ kind: 'INVALID_ARGUMENT', reason: 'no_project_path', executed: false });
    expect(error.nextStep).toMatchObject({ actor: 'agent', tool: 'opentune_save_project' });
    expect(error.nextStep.message).toMatch(/Ask the user where to save it/);
    expect(error.nextStep.message).toMatch(/mode save_as/);
    expect(names(s.dir)).toEqual(before);
  });

  it('writes nothing and tells the agent to remind the user when the build cannot write copies', async () => {
    const s = await setup({ withoutCapabilities: ['project.copy'] });
    const error = failure(await autosave(s.ctx));
    expect(error).toMatchObject({ kind: 'UNSUPPORTED', reason: 'capability_missing' });
    expect(error.detail).toMatch(/project\.copy/);
    expect(error.nextStep).toMatchObject({ actor: 'agent', tool: 'opentune_save_project' });
    expect(error.nextStep.message).toMatch(/do not call mode autosave again/);
    expect(error.nextStep.message).toMatch(/Remind the user/);
    expect(fs.existsSync(s.autosaveDir)).toBe(false);
  });

  it('takes no path', async () => {
    const s = await setup();
    const error = failure(await saveProject(s.ctx, { mode: 'autosave', path: s.fresh, ...wait }));
    expect(error).toMatchObject({ kind: 'INVALID_ARGUMENT', reason: 'path_unexpected' });
    expect(fs.existsSync(s.autosaveDir)).toBe(false);
  });

  it('reports a folder that cannot be made, without a request to OpenTune', async () => {
    const { ops } = recorded({ makeDir: denied });
    const s = await setup({ files: ops });
    const error = failure(await autosave(s.ctx));
    expect(error).toMatchObject({ kind: 'IO_ERROR', reason: 'write_failed', executed: false });
    expect(error.detail).toContain('(EACCES)');
    expect(error.nextStep.actor).toBe('user');
    expect(fs.existsSync(s.autosaveDir)).toBe(false);
  });

  it('never replaces a file: a name that appeared meanwhile is an error with a next step', async () => {
    // The listing is stale, as when another client wrote a copy between the listing and the request.
    const { ops } = recorded({ list: () => Promise.resolve([]) });
    const s = await setup({ files: ops });
    populate(s.autosaveDir, [autosaveName(s.stem, 1)]);
    const error = failure(await autosave(s.ctx));
    expect(error).toMatchObject({ kind: 'ALREADY_EXISTS' });
    expect(error.nextStep).toMatchObject({ actor: 'agent', tool: 'opentune_save_project', args: { mode: 'autosave' } });
    expect(fs.readFileSync(path.join(s.autosaveDir, autosaveName(s.stem, 1)), 'utf8')).toBe(
      `content of ${autosaveName(s.stem, 1)}`,
    );
  });

  it('is offered by the tool with its mode, and the tool needs the capabilities it uses', () => {
    expect(saveProjectTool.inputSchema.safeParse({ mode: 'autosave' }).success).toBe(true);
    expect(saveProjectTool.inputSchema.safeParse({ mode: 'copy' }).success).toBe(false);
    expect(saveProjectTool.description).toMatch(/mode autosave/);
    expect(saveProjectTool.description).toMatch(/newest 50/);
    expect(saveProjectTool.description).toMatch(/newest 10/);
    expect(saveProjectTool.otcpMethods).toEqual(
      expect.arrayContaining(['project.saveCopy', 'project.get', 'project.save', 'project.saveAs']),
    );
    expect(saveProjectTool.capabilities).toEqual(expect.arrayContaining(['project.io', 'jobs.v1', 'read.v1']));
    // project.copy is needed by mode autosave only: the other modes must keep working against a server without it.
    expect(saveProjectTool.capabilities).not.toContain('project.copy');
    expect(saveProjectTool.optionalCapabilities).toEqual(['project.copy']);
  });
});

describe('the old version kept before a save replaces a project file', () => {
  it('copies the file to <name>.oldversion before the save, named by the local time', async () => {
    const s = await setup();
    const original = fs.readFileSync(s.proj);
    const result = body(await save(s.ctx));
    const kept = path.join(s.oldDir, `${s.stem}-${STAMP}.otproj`);
    // The old version has the content from before the save: a save that ran first would have copied its own result.
    expect(fs.readFileSync(kept).equals(original)).toBe(true);
    expect(fs.readFileSync(s.proj).equals(original)).toBe(false);
    expect(result.oldVersion).toMatchObject({ path: kept, folder: s.oldDir, keep: OLDVERSION_KEEP, removedOlder: 0 });
    expect(result.summary).toMatch(
      /^opentune_save_project: saved the project to its file \(path in path\), replacing its previous content; a copy of the replaced content was kept in the oldversion folder next to that file \(path in oldVersion\.path\); opening that copy with opentune_open_project goes back to it\./,
    );
    expect(result.summary).not.toContain(s.oldDir);
    expect(result.summary).not.toMatch(/cannot be restored/);
    expect(result.nullReasons).not.toHaveProperty('oldVersion');
    expect(names(s.oldDir)).toEqual([`${s.stem}-${STAMP}.otproj`]);
  });

  it('adds -2 and -3 when the name of the second is taken', async () => {
    const s = await setup();
    body(await save(s.ctx));
    body(await save(s.ctx));
    body(await save(s.ctx));
    expect(names(s.oldDir)).toEqual(
      [`${s.stem}-${STAMP}.otproj`, `${s.stem}-${STAMP}-2.otproj`, `${s.stem}-${STAMP}-3.otproj`].sort(),
    );
  });

  it('keeps the newest 10: the 11th old version deletes the oldest one and nothing that does not match', async () => {
    const s = await setup();
    const versions = Array.from(
      { length: OLDVERSION_KEEP },
      (_, i) => `${s.stem}-202601${String(10 + i)}-120000.otproj`,
    );
    populate(s.oldDir, versions);
    const alien = [
      `${s.stem}-notes.otproj`,
      'other-20250101-000000.otproj',
      `${versions[0] ?? ''}.bak`,
      `${s.stem}-2026-01-01.otproj`,
      `${s.stem}-${STAMP}-extra.otproj`,
      'mine.otproj',
      autosaveName(s.stem, 1),
    ];
    populate(s.oldDir, alien);
    fs.mkdirSync(path.join(s.oldDir, 'Project_Media'));
    fs.writeFileSync(path.join(s.oldDir, 'Project_Media', 'take1.wav'), 'audio');
    // A directory with the name of an old version is not a file to delete, however old it is.
    fs.mkdirSync(path.join(s.oldDir, `${s.stem}-20200101-000000.otproj`));

    const result = body(await save(s.ctx));
    expect(result.oldVersion).toMatchObject({ removedOlder: 1, couldNotRemove: 0 });
    expect(result.summary).toContain('1 old version beyond the newest 10 was deleted from that folder.');
    const left = names(s.oldDir);
    expect(left).not.toContain(versions[0]);
    expect(left).toEqual(
      expect.arrayContaining([...versions.slice(1), `${s.stem}-${STAMP}.otproj`, ...alien, 'Project_Media']),
    );
    expect(fs.statSync(path.join(s.oldDir, `${s.stem}-20200101-000000.otproj`)).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(s.oldDir, 'Project_Media', 'take1.wav'), 'utf8')).toBe('audio');
  });

  it('does not save when the old version cannot be kept, and says why', async () => {
    const { ops } = recorded({ copyNew: denied });
    const s = await setup({ files: ops });
    const original = fs.readFileSync(s.proj);
    const error = failure(await save(s.ctx));
    expect(error).toMatchObject({ kind: 'IO_ERROR', reason: 'backup_failed', executed: false });
    expect(error.detail).toContain('(EACCES)');
    expect(error.detail).toMatch(/the project was not saved and its file is unchanged/);
    expect(error.nextStep.actor).toBe('user');
    // No save ran: the file is as it was and the project still has its changes.
    expect(fs.readFileSync(s.proj).equals(original)).toBe(true);
    expect(s.mock.snapshot().dirty).toBe(true);
    expect(fs.existsSync(s.oldDir) ? names(s.oldDir) : []).toEqual([]);
  });

  it('does not save when the folder for the old version cannot be made', async () => {
    const { ops } = recorded({ makeDir: denied });
    const s = await setup({ files: ops });
    const original = fs.readFileSync(s.proj);
    expect(failure(await save(s.ctx))).toMatchObject({ kind: 'IO_ERROR', reason: 'backup_failed' });
    expect(fs.readFileSync(s.proj).equals(original)).toBe(true);
    expect(s.mock.snapshot().dirty).toBe(true);
  });

  it('keeps nothing for a first save_as to a path where no file exists', async () => {
    const { ops, calls } = recorded();
    const s = await setup({ files: ops, noFile: true });
    const result = body(await saveProject(s.ctx, { mode: 'save_as', path: s.fresh, ...wait }));
    expect(result.summary).toMatch(/^opentune_save_project: wrote a new project file/);
    expect(result.oldVersion).toBeNull();
    expect(result.nullReasons).toMatchObject({ oldVersion: 'no_previous_file' });
    expect(calls.filter((c) => c.op === 'copyNew' || c.op === 'makeDir')).toEqual([]);
    expect(fs.existsSync(path.join(s.dir, `${path.parse(s.fresh).name}.oldversion`))).toBe(false);
  });

  it('keeps nothing for mode save when the project file is no longer there', async () => {
    const { ops, calls } = recorded();
    const s = await setup({ files: ops });
    fs.rmSync(s.proj);
    const result = body(await save(s.ctx));
    expect(result.summary).toMatch(/no earlier file was there, so there was nothing to keep/);
    expect(result.oldVersion).toBeNull();
    expect(calls.filter((c) => c.op === 'copyNew')).toEqual([]);
    expect(fs.existsSync(s.oldDir)).toBe(false);
  });

  it('keeps the old version of the project file for a save_as onto the file the project already has', async () => {
    const s = await setup();
    const original = fs.readFileSync(s.proj);
    const result = body(await saveProject(s.ctx, { mode: 'save_as', path: s.proj, ...wait }));
    expect(result.summary).toMatch(/which was already the project's file, replacing its previous content; a copy/);
    expect(fs.readFileSync(path.join(s.oldDir, `${s.stem}-${STAMP}.otproj`)).equals(original)).toBe(true);
  });

  it('keeps nothing when a save_as onto another existing file is refused', async () => {
    const { ops, calls } = recorded();
    const s = await setup({ files: ops });
    const original = fs.readFileSync(s.other);
    const error = failure(await saveProject(s.ctx, { mode: 'save_as', path: s.other, ...wait }));
    expect(error).toMatchObject({ kind: 'INVALID_ARGUMENT', reason: 'confirm_required' });
    expect(calls.filter((c) => c.op === 'copyNew')).toEqual([]);
    expect(fs.existsSync(s.otherOldDir)).toBe(false);
    expect(fs.readFileSync(s.other).equals(original)).toBe(true);
  });

  it('deletes the old version it made when OpenTune refuses the save', async () => {
    // The file system says the target is the project file, OpenTune says it is another file: it refuses.
    const { ops } = recorded({ sameFile: () => Promise.resolve(true) });
    const s = await setup({ files: ops });
    const error = failure(await saveProject(s.ctx, { mode: 'save_as', path: s.other, ...wait }));
    expect(error).toMatchObject({ kind: 'INVALID_ARGUMENT', reason: 'confirm_required' });
    expect(fs.existsSync(s.otherOldDir) ? names(s.otherOldDir) : []).toEqual([]);
  });

  it('deletes the old version it made, and rolls nothing, when the save fails', async () => {
    const s = await setup();
    const versions = Array.from(
      { length: OLDVERSION_KEEP },
      (_, i) => `${s.stem}-202601${String(10 + i)}-120000.otproj`,
    );
    populate(s.oldDir, versions);
    const original = fs.readFileSync(s.proj);
    failTemporaryWrites();
    const error = failure(await save(s.ctx));
    expect(error).toMatchObject({ kind: 'IO_ERROR', reason: 'write_failed' });
    // The file is unchanged, the ten old versions are all there, and the copy made for the failed save is gone.
    expect(fs.readFileSync(s.proj).equals(original)).toBe(true);
    expect(names(s.oldDir)).toEqual([...versions].sort());
  });
});

describe('opentune_save_project_overwrite keeps the replaced file', () => {
  it('copies the file it replaces to the oldversion folder beside that file, not the project file', async () => {
    const s = await setup();
    const replaced = fs.readFileSync(s.other);
    const otherStem = path.parse(s.other).name;
    const result = body(await overwriteProject(s.ctx, { path: s.other, confirm: true, ...wait }));
    const kept = path.join(s.otherOldDir, `${otherStem}-${STAMP}.otproj`);
    expect(fs.readFileSync(kept).equals(replaced)).toBe(true);
    expect(fs.readFileSync(s.other).equals(replaced)).toBe(false);
    expect(result.oldVersion).toMatchObject({ path: kept, folder: s.otherOldDir });
    expect(result.summary).toMatch(
      /^opentune_save_project_overwrite: OVERWROTE another existing project file at the user's request \(path in path\); a copy of the replaced content was kept in the oldversion folder next to that file \(path in oldVersion\.path\)/,
    );
    expect(result.summary).not.toMatch(/cannot be restored/);
    // The project's own old versions are not touched.
    expect(fs.existsSync(s.oldDir)).toBe(false);
  });

  it('does not overwrite when the old version cannot be kept', async () => {
    const { ops } = recorded({ copyNew: denied });
    const s = await setup({ files: ops });
    const replaced = fs.readFileSync(s.other);
    expect(failure(await overwriteProject(s.ctx, { path: s.other, confirm: true, ...wait }))).toMatchObject({
      kind: 'IO_ERROR',
      reason: 'backup_failed',
    });
    expect(fs.readFileSync(s.other).equals(replaced)).toBe(true);
    expect(s.mock.snapshot().dirty).toBe(true);
  });

  it('keeps nothing when there is no file at the path, and still needs confirm', async () => {
    const { ops, calls } = recorded();
    const s = await setup({ files: ops });
    expect(failure(await overwriteProject(s.ctx, { path: s.fresh, confirm: false, ...wait }))).toMatchObject({
      reason: 'confirm_required',
    });
    expect(calls).toEqual([]);
    const result = body(await overwriteProject(s.ctx, { path: s.fresh, confirm: true, ...wait }));
    expect(result.oldVersion).toBeNull();
    expect(calls.filter((c) => c.op === 'copyNew')).toEqual([]);
  });
});

describe('where the file system work happens', () => {
  it('stays inside the two folders next to the project files and deletes only what matches', async () => {
    const { ops, calls } = recorded();
    const s = await setup({ files: ops });
    const otherStem = path.parse(s.other).name;
    // Enough entries that both rolls delete something.
    populate(
      s.autosaveDir,
      Array.from({ length: AUTOSAVE_KEEP }, (_, i) => autosaveName(s.stem, 10 + i)),
    );
    populate(
      s.oldDir,
      Array.from({ length: OLDVERSION_KEEP }, (_, i) => `${s.stem}-202601${String(10 + i)}-120000.otproj`),
    );
    populate(
      s.otherOldDir,
      Array.from({ length: OLDVERSION_KEEP }, (_, i) => `${otherStem}-202601${String(10 + i)}-120000.otproj`),
    );
    populate(s.oldDir, ['notes.txt', 'mine.otproj']);
    populate(s.autosaveDir, ['notes.txt', 'mine.otproj']);
    fs.mkdirSync(path.join(s.autosaveDir, 'Project_Media'));

    body(await autosave(s.ctx));
    body(await autosave(s.ctx));
    body(await save(s.ctx));
    body(await saveProject(s.ctx, { mode: 'save_as', path: s.proj, ...wait }));
    body(await overwriteProject(s.ctx, { path: s.other, confirm: true, ...wait }));

    const folders = new Set([s.autosaveDir, s.oldDir, s.otherOldDir]);
    const projectFiles = new Set([s.proj, s.other]);
    const pattern = (dir: string): RegExp => {
      const stem = dir === s.otherOldDir ? otherStem : s.stem;
      return dir === s.autosaveDir
        ? new RegExp(`^${stem}-autosave-\\d{4,}\\.otproj$`)
        : new RegExp(`^${stem}-\\d{8}-\\d{6}(-\\d+)?\\.otproj$`);
    };
    const removed = calls.filter((c) => c.op === 'remove');
    expect(removed.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) {
      const [first = '', second = ''] = call.args;
      switch (call.op) {
        case 'list':
        case 'makeDir':
          expect(folders.has(first), `${call.op} ${first}`).toBe(true);
          break;
        case 'remove':
          expect(folders.has(path.dirname(first)), `remove ${first}`).toBe(true);
          expect(pattern(path.dirname(first)).test(path.basename(first)), `remove ${first}`).toBe(true);
          break;
        case 'copyNew':
          expect(projectFiles.has(first), `copy from ${first}`).toBe(true);
          expect(path.dirname(second) === s.oldDir || path.dirname(second) === s.otherOldDir, `copy to ${second}`).toBe(
            true,
          );
          break;
        case 'fileExists':
          expect(projectFiles.has(first), `fileExists ${first}`).toBe(true);
          break;
        case 'sameFile':
          expect(projectFiles.has(first) && projectFiles.has(second), `sameFile ${first}`).toBe(true);
          break;
      }
    }
    // What a user keeps in those folders, and the project files, are all still there.
    for (const dir of [s.autosaveDir, s.oldDir]) {
      expect(names(dir)).toEqual(expect.arrayContaining(['notes.txt', 'mine.otproj']));
    }
    expect(fs.existsSync(path.join(s.autosaveDir, 'Project_Media'))).toBe(true);
    expect(fs.existsSync(s.proj) && fs.existsSync(s.other)).toBe(true);
  });
});

describe('the names and the rolls, without a file system', () => {
  const entry = (name: string, isFile = true): FolderEntry => ({ name, isFile });
  const folders = (file: string, platform: NodeJS.Platform = 'linux') => {
    const found = ProjectFolders.of(file, platform);
    if (found === null) throw new Error(`no folders for ${file}`);
    return found;
  };

  it('names the folders after the file name without .otproj, next to the file', () => {
    const f = folders('/music/song one.otproj');
    expect(f.autosaveDir).toBe('/music/song one.autosave');
    expect(f.oldversionDir).toBe('/music/song one.oldversion');
    expect(f.autosaveName(7)).toBe('song one-autosave-0007.otproj');
    expect(f.autosaveName(12345)).toBe('song one-autosave-12345.otproj');
    const w = folders('C:\\Music\\take1.otproj', 'win32');
    expect(w.autosaveDir).toBe('C:\\Music\\take1.autosave');
    expect(w.oldversionDir).toBe('C:\\Music\\take1.oldversion');
  });

  it('builds paths only from absolute .otproj paths that pass the path rules', () => {
    for (const bad of [
      'song.otproj',
      '/music/song.wav',
      '/music/.otproj',
      '/music/song',
      '/',
      '//server/share/song.otproj',
      '/music/../song.otproj',
    ]) {
      expect(ProjectFolders.of(bad, 'linux'), bad).toBeNull();
    }
    for (const bad of [
      'C:song.otproj',
      '\\\\server\\share\\song.otproj',
      '\\\\?\\C:\\song.otproj',
      '\\\\.\\C:\\song.otproj',
      'C:\\Music\\song.otproj:stream',
      'C:\\Music\\song.wav',
      'relative\\song.otproj',
    ]) {
      expect(ProjectFolders.of(bad, 'win32'), bad).toBeNull();
    }
    expect(ProjectFolders.of('C:\\Music\\SONG.OTPROJ', 'win32')).not.toBeNull();
  });

  it('formats the time stamp in local time with two digits per field', () => {
    expect(localStamp(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('20260102-030405');
    expect(localStamp(new Date(2026, 11, 31, 23, 59, 59).getTime())).toBe('20261231-235959');
    expect(localStamp(NOW)).toBe(STAMP);
  });

  it('numbers after the highest number of any entry, matching only its own project', () => {
    const f = folders('/music/song.otproj');
    expect(nextAutosaveNumber(f, null)).toBe(1);
    expect(nextAutosaveNumber(f, [])).toBe(1);
    expect(nextAutosaveNumber(f, [entry('song-autosave-0002.otproj'), entry('song-autosave-0009.otproj')])).toBe(10);
    expect(nextAutosaveNumber(f, [entry('other-autosave-0099.otproj'), entry('song-autosave-12.otproj')])).toBe(1);
    // A directory with such a name still takes the number: a copy could not be written there.
    expect(nextAutosaveNumber(f, [entry('song-autosave-0004.otproj', false)])).toBe(5);
    expect(nextAutosaveNumber(f, [entry('song-autosave-9999.otproj'), entry('song-autosave-10000.otproj')])).toBe(
      10001,
    );
  });

  it('deletes the oldest autosave copies beyond the newest 50, never a directory or a name that does not match', () => {
    const f = folders('/music/song.otproj');
    const copies = Array.from({ length: 53 }, (_, i) =>
      entry(`song-autosave-${String(i + 1).padStart(4, '0')}.otproj`),
    );
    const extras = [
      entry('Project_Media', false),
      entry('song-autosave-0001.otproj.bak'),
      entry('song-autosave-001.otproj'),
      entry('other-autosave-0001.otproj'),
      entry('song-20260101-000000.otproj'),
      entry('notes.txt'),
      entry('song-autosave-0000.otproj', false),
    ];
    expect(autosavesToDelete(f, [...extras, ...copies])).toEqual([
      'song-autosave-0001.otproj',
      'song-autosave-0002.otproj',
      'song-autosave-0003.otproj',
    ]);
    expect(autosavesToDelete(f, copies.slice(0, 50))).toEqual([]);
    // A number of five digits is newer than 9999, not older (a sort of the names would get this wrong).
    expect(
      autosavesToDelete(
        f,
        [entry('song-autosave-9999.otproj'), entry('song-autosave-10000.otproj'), entry('song-autosave-10001.otproj')],
        2,
      ),
    ).toEqual(['song-autosave-9999.otproj']);
  });

  it('escapes the file name in the patterns', () => {
    const f = folders('/music/a.b (1) [x]+$.otproj');
    expect(f.autosaveNumber('a.b (1) [x]+$-autosave-0001.otproj')).toBe(1);
    expect(f.autosaveNumber('aXb (1) [x]+$-autosave-0001.otproj')).toBeNull();
    expect(f.autosaveNumber('a.b (1) [x]-autosave-0001.otproj')).toBeNull();
    const dot = folders('/music/a.b.otproj');
    expect(dot.autosaveNumber('aXb-autosave-0001.otproj')).toBeNull();
    expect(dot.oldVersionKey('aXb-20261028-140509.otproj')).toBeNull();
    expect(dot.oldVersionKey('a.b-20261028-140509.otproj')).toEqual({ time: '20261028-140509', suffix: 1 });
    expect(dot.oldVersionKey('a.b-20261028-140509-3.otproj')).toEqual({ time: '20261028-140509', suffix: 3 });
    // A project whose name is the start of another project's name does not claim the other's files.
    const song = folders('/music/song.otproj');
    expect(song.autosaveNumber('song-v2-autosave-0001.otproj')).toBeNull();
    expect(song.oldVersionKey('song-v2-20261028-140509.otproj')).toBeNull();
  });

  it('deletes the oldest old versions beyond the newest 10 by time, then by the number after a collision', () => {
    const f = folders('/music/song.otproj');
    const same = Array.from({ length: 12 }, (_, i) => entry(f.oldVersionName('20261028-140509', i + 1)));
    // Names of one second: no suffix is the first, then -2, -3 … -12 (-10 sorts before -2 as text, not as a number).
    expect(oldVersionsToDelete(f, same)).toEqual(['song-20261028-140509.otproj', 'song-20261028-140509-2.otproj']);
    const mixed = [
      entry('song-20261028-140510.otproj'),
      entry('song-20260101-000000.otproj'),
      entry('song-20261028-140509-2.otproj'),
      entry('song-20261028-140509.otproj'),
      entry('song-20260101-000000.otproj.bak'),
      entry('song-notes.otproj'),
      entry('Project_Media', false),
      entry('song-20250101-000000.otproj', false),
    ];
    expect(oldVersionsToDelete(f, mixed, 2)).toEqual(['song-20260101-000000.otproj', 'song-20261028-140509.otproj']);
    expect(oldVersionsToDelete(f, mixed)).toEqual([]);
  });
});
