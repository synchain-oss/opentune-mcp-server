// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The audio of an old version (opentune_save_project and opentune_save_project_overwrite): an old version names its
// audio relative to its own folder, so the files of the Project_Media folder next to the project file that is replaced
// are copied into <name>.oldversion/Project_Media before the save, by the rules of OpenTune's own copy of its audio. The
// tests run the tools against the mock with a recording file system, and fail single operations of it.

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startMock } from '../../mock/server.js';
import {
  MAX_MEDIA_NAMED,
  MEDIA_COPY_BUDGET_MS,
  ProjectFolders,
  copyMediaToOldVersions,
  nodeProjectFs,
  type FolderEntry,
  type ProjectFs,
} from '../../src/files/project-folders.js';
import { overwriteProject, saveProject } from '../../src/tools/project-files.js';
import type { Outcome, ToolContext } from '../../src/tools/registry.js';
import { tempDir, testContext } from '../support/context.js';
import { clip, need } from '../support/mock-client.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const NOW = new Date(2026, 9, 28, 14, 5, 9).getTime();
const STAMP = '20261028-140509';
const LONG_AGO = new Date(2020, 0, 1);
const LONG_AFTER = new Date(2040, 0, 1);

const FILES = [
  { bind: 'proj', kind: 'project', durationSec: 3 },
  { bind: 'other', kind: 'project', durationSec: 3 },
] as const;

interface Call {
  readonly op: keyof ProjectFs;
  readonly args: readonly string[];
}

/** The operations of the real file system, recorded; `overrides` replace single operations. */
function recorded(overrides: Partial<ProjectFs> = {}) {
  const calls: Call[] = [];
  type Operations = Record<keyof ProjectFs, (...args: string[]) => Promise<unknown>>;
  const real = nodeProjectFs as unknown as Operations;
  const replaced = overrides as Partial<Operations>;
  const ops = Object.fromEntries(
    (Object.keys(real) as (keyof ProjectFs)[]).map((op) => [
      op,
      (...args: string[]) => {
        calls.push({ op, args });
        return (replaced[op] ?? real[op])(...args);
      },
    ]),
  ) as unknown as ProjectFs;
  return { ops, calls };
}

const denied = (): Promise<never> => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
const full = (): Promise<never> => Promise.reject(Object.assign(new Error('full'), { code: 'ENOSPC' }));
const isMedia = (file: string): boolean => path.basename(path.dirname(file)) === 'Project_Media';

async function setup(files?: ProjectFs, now: number | (() => number) = NOW) {
  const t = tempDir();
  cleanup.push(t.remove);
  const mock = await startMock({ discoveryDir: t.dir });
  cleanup.push(() => mock.stop());
  const ctx = testContext(t.dir, { now, ...(files === undefined ? {} : { files }) });
  cleanup.push(() => {
    ctx.instances.close();
  });
  const ids = mock.given({ files: [...FILES], clips: [clip()], dirty: true, projectFile: 'proj' });
  const proj = need(ids, 'proj');
  const other = need(ids, 'other');
  const { dir, name: stem } = path.parse(proj);
  const otherDir = path.dirname(other);
  const otherStem = path.parse(other).name;
  return {
    mock,
    ctx,
    proj,
    other,
    dir,
    stem,
    mediaDir: path.join(dir, 'Project_Media'),
    oldDir: path.join(dir, `${stem}.oldversion`),
    oldMediaDir: path.join(dir, `${stem}.oldversion`, 'Project_Media'),
    otherMediaDir: path.join(otherDir, 'Project_Media'),
    otherOldDir: path.join(otherDir, `${otherStem}.oldversion`),
    otherOldMediaDir: path.join(otherDir, `${otherStem}.oldversion`, 'Project_Media'),
  };
}

const body = (outcome: Outcome) => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.error.kind}(${String(outcome.error.reason)})`);
  return outcome.body as Record<string, unknown> & { summary: string };
};

const wait = { wait_seconds: 10 };
const save = (ctx: ToolContext) => saveProject(ctx, { mode: 'save', ...wait });
const names = (dir: string) => fs.readdirSync(dir).sort();
const read = (file: string) => fs.readFileSync(file, 'utf8');
const media = (result: Record<string, unknown>) => (result.oldVersion as { media: unknown }).media;
const warningLines = (result: Record<string, unknown>) =>
  ((result.lines as { kind: string; code: unknown }[] | undefined) ?? []).filter((l) => l.kind === 'warning');
const mediaWarnings = (result: Record<string, unknown>) =>
  warningLines(result).filter((l) => l.code === 'OLD_VERSION_MEDIA_NOT_COPIED');

/** Writes files with these names and contents into `dir` (made if needed). */
function put(dir: string, files: Record<string, string>, mtime?: Date) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
    if (mtime !== undefined) fs.utimesSync(path.join(dir, name), mtime, mtime);
  }
}

const NOTHING = { copied: 0, notCopied: [], notCopiedCount: 0, timedOut: false };

describe('the audio is copied beside the old version', () => {
  it('copies the files of Project_Media next to the project file into <name>.oldversion/Project_Media', async () => {
    const s = await setup();
    put(s.mediaDir, { '1.wav': 'audio one', '2.mp3': 'audio two' });
    const result = body(await save(s.ctx));
    expect(names(s.oldMediaDir)).toEqual(['1.wav', '2.mp3']);
    expect(read(path.join(s.oldMediaDir, '1.wav'))).toBe('audio one');
    expect(read(path.join(s.oldMediaDir, '2.mp3'))).toBe('audio two');
    expect(media(result)).toEqual({ copied: 2, notCopied: [], notCopiedCount: 0, timedOut: false });
    // Said once, as data; a copy that worked adds nothing to the summary and no warning.
    expect(mediaWarnings(result)).toEqual([]);
    expect(result.summary).not.toMatch(/could not be copied/);
    // The audio next to the project file is only read.
    expect(names(s.mediaDir)).toEqual(['1.wav', '2.mp3']);
    expect(read(path.join(s.mediaDir, '1.wav'))).toBe('audio one');
    expect(names(s.oldDir)).toEqual(['Project_Media', `${s.stem}-${STAMP}.otproj`].sort());
  });

  it('copies before the save runs, when the old version of the project file is made', async () => {
    const dirtyAtCopy: (boolean | undefined)[] = [];
    const probe: { dirty?: () => boolean } = {};
    const { ops, calls } = recorded({
      copyNew: (from, to) => {
        if (isMedia(from)) dirtyAtCopy.push(probe.dirty?.());
        return nodeProjectFs.copyNew(from, to);
      },
    });
    const s = await setup(ops);
    probe.dirty = () => s.mock.snapshot().dirty;
    put(s.mediaDir, { '1.wav': 'audio' });
    body(await save(s.ctx));
    // The project was still marked as changed: the save had not run when the audio was copied.
    expect(dirtyAtCopy).toEqual([true]);
    expect(s.mock.snapshot().dirty).toBe(false);
    // After the copy of the project file, in the same step.
    const order = calls.filter((c) => c.op === 'copyNew').map((c) => path.basename(c.args[1] ?? ''));
    expect(order).toEqual([`${s.stem}-${STAMP}.otproj`, '1.wav']);
  });

  it('does not copy a file again that is there and not older than its source', async () => {
    const { ops, calls } = recorded();
    const s = await setup(ops);
    put(s.mediaDir, { '1.wav': 'source' }, LONG_AGO);
    // Newer than its source, and equal to it: both stay as they are.
    put(s.oldMediaDir, { '1.wav': 'newer copy' }, LONG_AFTER);
    put(s.mediaDir, { '2.wav': 'second source' }, LONG_AGO);
    put(s.oldMediaDir, { '2.wav': 'equal copy' }, LONG_AGO);
    const result = body(await save(s.ctx));
    expect(read(path.join(s.oldMediaDir, '1.wav'))).toBe('newer copy');
    expect(read(path.join(s.oldMediaDir, '2.wav'))).toBe('equal copy');
    expect(media(result)).toEqual(NOTHING);
    expect(calls.filter((c) => (c.op === 'copyNew' || c.op === 'copyReplace') && isMedia(c.args[0] ?? ''))).toEqual([]);
  });

  it('replaces a file that is older than its source, and leaves nothing of the copy behind', async () => {
    const { ops, calls } = recorded();
    const s = await setup(ops);
    put(s.oldMediaDir, { '1.wav': 'older copy' }, LONG_AGO);
    put(s.mediaDir, { '1.wav': 'new source' });
    const result = body(await save(s.ctx));
    expect(read(path.join(s.oldMediaDir, '1.wav'))).toBe('new source');
    expect(media(result)).toEqual({ copied: 1, notCopied: [], notCopiedCount: 0, timedOut: false });
    expect(calls.filter((c) => c.op === 'copyReplace')).toHaveLength(1);
    expect(names(s.oldMediaDir)).toEqual(['1.wav']);
    // Nothing was deleted to make room.
    expect(calls.filter((c) => c.op === 'remove')).toEqual([]);
  });

  it('skips directories and links, and does not enter sub-folders', async () => {
    const { ops, calls } = recorded({
      // A link, as the listing of a real folder reports it: an entry that is not a regular file.
      list: async (dir) => {
        const entries = await nodeProjectFs.list(dir);
        return dir.endsWith('Project_Media') && entries !== null
          ? [...entries, { name: 'link.wav', isFile: false } satisfies FolderEntry]
          : entries;
      },
    });
    const s = await setup(ops);
    put(s.mediaDir, { '1.wav': 'audio' });
    put(path.join(s.mediaDir, 'sub'), { 'inner.wav': 'inside a sub-folder' });
    const result = body(await save(s.ctx));
    expect(names(s.oldMediaDir)).toEqual(['1.wav']);
    expect(media(result)).toEqual({ copied: 1, notCopied: [], notCopiedCount: 0, timedOut: false });
    // Not even looked at: no stat, no copy, and the sub-folder is not listed.
    const touched = calls.flatMap((c) => c.args).filter((a) => /(\/|\\)(link\.wav|sub)(\/|\\|$)/.test(a));
    expect(touched).toEqual([]);
    expect(mediaWarnings(result)).toEqual([]);
  });

  it('never writes through a directory or a link where a file of the audio belongs', async () => {
    const { ops } = recorded({
      // The target of 3.wav is a link, as the stat of a real file system says it.
      stat: async (file) =>
        path.basename(file) === '3.wav' && file.includes('.oldversion')
          ? { isFile: false, mtimeMs: 0 }
          : nodeProjectFs.stat(file),
    });
    const s = await setup(ops);
    put(s.mediaDir, { '1.wav': 'audio one', '2.wav': 'audio two', '3.wav': 'audio three' });
    // A directory at the place of 1.wav; a link at the place of 3.wav (as the stat says).
    fs.mkdirSync(path.join(s.oldMediaDir, '1.wav'), { recursive: true });
    fs.writeFileSync(path.join(s.oldMediaDir, '3.wav'), 'what the link points to');
    const result = body(await save(s.ctx));
    expect(fs.statSync(path.join(s.oldMediaDir, '1.wav')).isDirectory()).toBe(true);
    expect(read(path.join(s.oldMediaDir, '3.wav'))).toBe('what the link points to');
    expect(read(path.join(s.oldMediaDir, '2.wav'))).toBe('audio two');
    expect(media(result)).toEqual({
      copied: 1,
      notCopied: ['Project_Media/1.wav', 'Project_Media/3.wav'],
      notCopiedCount: 2,
      timedOut: false,
    });
    expect(mediaWarnings(result)).toHaveLength(1);
  });

  it('does nothing, and says nothing, when the project has no Project_Media folder', async () => {
    const { ops, calls } = recorded();
    const s = await setup(ops);
    const result = body(await save(s.ctx));
    expect(media(result)).toEqual(NOTHING);
    expect(fs.existsSync(s.oldMediaDir)).toBe(false);
    expect(calls.filter((c) => c.op === 'copyNew' || c.op === 'copyReplace').map((c) => c.args[1])).toEqual([
      path.join(s.oldDir, `${s.stem}-${STAMP}.otproj`),
    ]);
    expect(mediaWarnings(result)).toEqual([]);
    expect(result.summary).not.toMatch(/could not be copied/);
  });

  it('makes no folder for an empty Project_Media folder, or one that holds only folders', async () => {
    const s = await setup();
    fs.mkdirSync(path.join(s.mediaDir, 'sub'), { recursive: true });
    const result = body(await save(s.ctx));
    expect(media(result)).toEqual(NOTHING);
    expect(fs.existsSync(s.oldMediaDir)).toBe(false);
  });

  it('completes the audio of an old version that is reused, which may have been made without it', async () => {
    const { ops, calls } = recorded();
    const s = await setup(ops);
    fs.mkdirSync(s.oldDir, { recursive: true });
    const reused = path.join(s.oldDir, `${s.stem}-20260102-120000.otproj`);
    fs.copyFileSync(s.proj, reused);
    put(s.mediaDir, { '1.wav': 'audio one', '2.wav': 'audio two' });
    put(s.oldMediaDir, { '1.wav': 'audio one' }, LONG_AFTER);
    const result = body(await save(s.ctx));
    expect(result.oldVersion).toMatchObject({ path: reused, reused: true });
    // No new copy of the project file, and the audio that was missing is there now.
    expect(calls.filter((c) => c.op === 'copyNew' && !isMedia(c.args[0] ?? ''))).toEqual([]);
    expect(names(s.oldMediaDir)).toEqual(['1.wav', '2.wav']);
    expect(media(result)).toEqual({ copied: 1, notCopied: [], notCopiedCount: 0, timedOut: false });
  });

  it('is part of the result of a save that has not finished within the call', async () => {
    const s = await setup();
    put(s.mediaDir, { '1.wav': 'audio' });
    const started = body(await saveProject(s.ctx, { mode: 'save', wait_seconds: 0 }));
    expect(media(started)).toEqual({ copied: 1, notCopied: [], notCopiedCount: 0, timedOut: false });
    expect(names(s.oldMediaDir)).toEqual(['1.wav']);
  });

  it('is kept, and grows only, when old versions are rolled', async () => {
    const s = await setup();
    const versions = Array.from({ length: 10 }, (_, i) => `${s.stem}-202601${String(10 + i)}-120000.otproj`);
    put(s.oldDir, Object.fromEntries(versions.map((v) => [v, v])));
    put(s.oldMediaDir, { 'earlier.wav': 'audio of an earlier version' });
    put(s.mediaDir, { '1.wav': 'audio' });
    const result = body(await save(s.ctx));
    expect(result.oldVersion).toMatchObject({ removedOlder: 1 });
    expect(names(s.oldMediaDir)).toEqual(['1.wav', 'earlier.wav']);
    expect(read(path.join(s.oldMediaDir, 'earlier.wav'))).toBe('audio of an earlier version');
  });

  it('takes the audio from the folder of the file that is replaced, for save_as onto the project file', async () => {
    const s = await setup();
    put(s.mediaDir, { '1.wav': 'audio' });
    const result = body(await saveProject(s.ctx, { mode: 'save_as', path: s.proj, ...wait }));
    expect(media(result)).toEqual({ copied: 1, notCopied: [], notCopiedCount: 0, timedOut: false });
    expect(names(s.oldMediaDir)).toEqual(['1.wav']);
  });
});

describe('the audio of the file that opentune_save_project_overwrite replaces', () => {
  it('comes from the folder of that file, not from the folder of the project file', async () => {
    const { ops, calls } = recorded();
    const s = await setup(ops);
    put(s.mediaDir, { 'project-audio.wav': 'audio of the project' });
    put(s.otherMediaDir, { 'replaced-audio.wav': 'audio of the replaced file' });
    const result = body(await overwriteProject(s.ctx, { path: s.other, confirm: true, ...wait }));
    expect(media(result)).toEqual({ copied: 1, notCopied: [], notCopiedCount: 0, timedOut: false });
    expect(names(s.otherOldMediaDir)).toEqual(['replaced-audio.wav']);
    expect(read(path.join(s.otherOldMediaDir, 'replaced-audio.wav'))).toBe('audio of the replaced file');
    // Nothing of the project's own audio or old versions was touched.
    expect(fs.existsSync(s.oldDir)).toBe(false);
    expect(names(s.mediaDir)).toEqual(['project-audio.wav']);
    expect(calls.filter((c) => c.args.some((a) => a.startsWith(s.oldDir)))).toEqual([]);
  });

  it('is copied before OpenTune replaces the file, which writes its own audio folder next to it', async () => {
    const unchangedAtCopy: (boolean | undefined)[] = [];
    const probe: { unchanged?: () => boolean } = {};
    const { ops } = recorded({
      copyNew: (from, to) => {
        if (isMedia(from)) unchangedAtCopy.push(probe.unchanged?.());
        return nodeProjectFs.copyNew(from, to);
      },
    });
    const s = await setup(ops);
    const replaced = fs.readFileSync(s.other);
    const unchanged = () => fs.readFileSync(s.other).equals(replaced);
    probe.unchanged = unchanged;
    put(s.otherMediaDir, { '1.wav': 'audio of the replaced file' });
    body(await overwriteProject(s.ctx, { path: s.other, confirm: true, ...wait }));
    // The file still held its old content when the audio was copied; the save replaced it afterwards.
    expect(unchangedAtCopy).toEqual([true]);
    expect(unchanged()).toBe(false);
  });
});

describe('a failure to copy the audio does not stop the save', () => {
  it('saves as usual, reports the file, and deletes the part of the copy that failed', async () => {
    const { ops, calls } = recorded({
      copyNew: (from, to) => {
        if (!isMedia(from)) return nodeProjectFs.copyNew(from, to);
        if (path.basename(from) === '2.wav') {
          fs.writeFileSync(to, 'a part of the audio');
          return full();
        }
        return nodeProjectFs.copyNew(from, to);
      },
    });
    const s = await setup(ops);
    put(s.mediaDir, { '1.wav': 'audio one', '2.wav': 'audio two' });
    const original = fs.readFileSync(s.proj);
    const result = body(await save(s.ctx));
    // The save ran and the old version of the project file is there.
    expect(result.applied).toBe(true);
    expect(result.job).toMatchObject({ state: 'succeeded' });
    expect(fs.readFileSync(s.proj).equals(original)).toBe(false);
    expect(fs.readFileSync(path.join(s.oldDir, `${s.stem}-${STAMP}.otproj`)).equals(original)).toBe(true);
    expect(s.mock.snapshot().dirty).toBe(false);
    // The file that was copied is there; the part of the other one is gone, and nothing else was deleted.
    expect(names(s.oldMediaDir)).toEqual(['1.wav']);
    expect(calls.filter((c) => c.op === 'remove').map((c) => c.args[0])).toEqual([path.join(s.oldMediaDir, '2.wav')]);
    // The result says which file it was, as data, and the summary says only that some audio was not copied.
    expect(media(result)).toEqual({
      copied: 1,
      notCopied: ['Project_Media/2.wav'],
      notCopiedCount: 1,
      timedOut: false,
    });
    expect(mediaWarnings(result)).toEqual([
      expect.objectContaining({
        kind: 'warning',
        source: 'server',
        subject: null,
        data: { notCopied: ['Project_Media/2.wav'], notCopiedCount: 1, timedOut: false },
        text: expect.stringContaining('may not find its audio') as unknown,
      }),
    ]);
    expect(result.summary).toContain('could not be copied completely into the Project_Media folder');
    expect(result.summary).toContain('oldVersion.media.notCopied');
    expect(result.summary).not.toContain('2.wav');
    // A failure is not the end of the time: that sentence is not there.
    expect(result.summary).not.toContain('stopped after');
    expect(result.summary).toMatch(/^opentune_save_project: saved the project to its file/);
    // The warnings of OpenTune stay where they were.
    expect(warningLines(result).some((l) => l.code === 'NOT_SAVED_IN_PROJECT')).toBe(true);
  });

  it('retries the file at the next save, because no part of it is left', async () => {
    let failing = true;
    const { ops } = recorded({
      copyNew: (from, to) => {
        if (isMedia(from) && failing) {
          fs.writeFileSync(to, 'a part of the audio');
          return full();
        }
        return nodeProjectFs.copyNew(from, to);
      },
    });
    const s = await setup(ops);
    put(s.mediaDir, { '1.wav': 'audio one' });
    const first = body(await save(s.ctx));
    expect(media(first)).toMatchObject({ copied: 0, notCopiedCount: 1 });
    failing = false;
    // The project is changed again so that this save has something to do; the old version is made again.
    fs.writeFileSync(s.proj, 'changed');
    const second = body(await save(s.ctx));
    expect(media(second)).toEqual({ copied: 1, notCopied: [], notCopiedCount: 0, timedOut: false });
    expect(read(path.join(s.oldMediaDir, '1.wav'))).toBe('audio one');
  });

  it('keeps the older copy of a file when its replacement fails', async () => {
    const { ops } = recorded({ copyReplace: denied });
    const s = await setup(ops);
    put(s.oldMediaDir, { '1.wav': 'older copy' }, LONG_AGO);
    put(s.mediaDir, { '1.wav': 'new source' });
    const result = body(await save(s.ctx));
    expect(result.applied).toBe(true);
    expect(read(path.join(s.oldMediaDir, '1.wav'))).toBe('older copy');
    expect(media(result)).toEqual({
      copied: 0,
      notCopied: ['Project_Media/1.wav'],
      notCopiedCount: 1,
      timedOut: false,
    });
  });

  it('reports the folder when the audio cannot be listed, or its folder cannot be made', async () => {
    const inMedia = (dir: string): boolean => path.basename(dir) === 'Project_Media';
    const faults = {
      list: { list: (dir: string) => (inMedia(dir) ? denied() : nodeProjectFs.list(dir)) },
      makeDir: { makeDir: (dir: string) => (inMedia(dir) ? denied() : nodeProjectFs.makeDir(dir)) },
    };
    for (const fault of ['list', 'makeDir'] as const) {
      const { ops } = recorded(faults[fault]);
      const s = await setup(ops);
      put(s.mediaDir, { '1.wav': 'audio' });
      const original = fs.readFileSync(s.proj);
      const result = body(await save(s.ctx));
      expect(result.applied, fault).toBe(true);
      expect(media(result), fault).toEqual({
        copied: 0,
        notCopied: ['Project_Media'],
        notCopiedCount: 1,
        timedOut: false,
      });
      expect(mediaWarnings(result), fault).toHaveLength(1);
      expect(fs.readFileSync(path.join(s.oldDir, `${s.stem}-${STAMP}.otproj`)).equals(original), fault).toBe(true);
    }
  });

  it('is reported for an old version that is reused, too', async () => {
    const { ops } = recorded({ copyNew: (from, to) => (isMedia(from) ? denied() : nodeProjectFs.copyNew(from, to)) });
    const s = await setup(ops);
    fs.mkdirSync(s.oldDir, { recursive: true });
    fs.copyFileSync(s.proj, path.join(s.oldDir, `${s.stem}-20260102-120000.otproj`));
    put(s.mediaDir, { '1.wav': 'audio' });
    const result = body(await save(s.ctx));
    expect(result.oldVersion).toMatchObject({ reused: true });
    expect(media(result)).toEqual({
      copied: 0,
      notCopied: ['Project_Media/1.wav'],
      notCopiedCount: 1,
      timedOut: false,
    });
    expect(mediaWarnings(result)).toHaveLength(1);
  });

  it('is reported in the result of a save that has not finished within the call', async () => {
    const { ops } = recorded({ copyNew: (from, to) => (isMedia(from) ? denied() : nodeProjectFs.copyNew(from, to)) });
    const s = await setup(ops);
    put(s.mediaDir, { '1.wav': 'audio' });
    const started = body(await saveProject(s.ctx, { mode: 'save', wait_seconds: 0 }));
    expect(media(started)).toEqual({
      copied: 0,
      notCopied: ['Project_Media/1.wav'],
      notCopiedCount: 1,
      timedOut: false,
    });
    expect(mediaWarnings(started)).toHaveLength(1);
    expect(started.summary).toContain('could not be copied completely');
  });

  it('is reported for the file that opentune_save_project_overwrite replaces', async () => {
    const { ops } = recorded({ copyNew: (from, to) => (isMedia(from) ? denied() : nodeProjectFs.copyNew(from, to)) });
    const s = await setup(ops);
    put(s.otherMediaDir, { '1.wav': 'audio' });
    const result = body(await overwriteProject(s.ctx, { path: s.other, confirm: true, ...wait }));
    expect(result.applied).toBe(true);
    expect(result.summary).toMatch(/^opentune_save_project_overwrite: OVERWROTE another existing project file/);
    expect(media(result)).toEqual({
      copied: 0,
      notCopied: ['Project_Media/1.wav'],
      notCopiedCount: 1,
      timedOut: false,
    });
    expect(mediaWarnings(result)).toHaveLength(1);
  });

  it('does not make the save fail when a file of the audio cannot even be looked at', async () => {
    const { ops } = recorded({ stat: (file) => (isMedia(file) ? denied() : nodeProjectFs.stat(file)) });
    const s = await setup(ops);
    put(s.mediaDir, { '1.wav': 'audio' });
    const result = body(await save(s.ctx));
    expect(result.applied).toBe(true);
    expect(media(result)).toEqual({
      copied: 0,
      notCopied: ['Project_Media/1.wav'],
      notCopiedCount: 1,
      timedOut: false,
    });
  });
});

describe('the copy of the audio stops when its time is used up', () => {
  /** A clock that the test moves by hand: no real waiting. */
  function handClock() {
    let time = NOW;
    return {
      now: () => time,
      advance: (ms: number) => {
        time += ms;
      },
    };
  }

  /** A file system on which copying the file `slowAfter` takes `taken` milliseconds on the clock. */
  function slowCopy(
    clock: ReturnType<typeof handClock>,
    slowAfter: string,
    taken: number,
    fail: readonly string[] = [],
  ) {
    return recorded({
      copyNew: (from, to) => {
        if (!isMedia(from)) return nodeProjectFs.copyNew(from, to);
        if (fail.includes(path.basename(from))) return denied();
        return nodeProjectFs.copyNew(from, to).then(() => {
          if (path.basename(from) === slowAfter) clock.advance(taken);
        });
      },
    });
  }

  const FIVE = { 'a.wav': 'a', 'b.wav': 'b', 'c.wav': 'c', 'd.wav': 'd', 'e.wav': 'e' };

  it('copies the files up to the one that used the time up, lists the rest, and saves as usual', async () => {
    const clock = handClock();
    const { ops, calls } = slowCopy(clock, 'b.wav', MEDIA_COPY_BUDGET_MS);
    const s = await setup(ops, clock.now);
    put(s.mediaDir, FIVE);
    const original = fs.readFileSync(s.proj);
    const result = body(await save(s.ctx));
    // The save ran, and the old version of the project file is there.
    expect(result.applied).toBe(true);
    expect(result.job).toMatchObject({ state: 'succeeded' });
    expect(fs.readFileSync(path.join(s.oldDir, `${s.stem}-${STAMP}.otproj`)).equals(original)).toBe(true);
    expect(s.mock.snapshot().dirty).toBe(false);
    // The first two were copied; the other three were not even tried, and nothing was deleted.
    expect(names(s.oldMediaDir)).toEqual(['a.wav', 'b.wav']);
    expect(
      calls.filter((c) => c.op === 'copyNew' && isMedia(c.args[0] ?? '')).map((c) => path.basename(c.args[0] ?? '')),
    ).toEqual(['a.wav', 'b.wav']);
    expect(calls.filter((c) => c.op === 'remove')).toEqual([]);
    expect(media(result)).toEqual({
      copied: 2,
      notCopied: ['Project_Media/c.wav', 'Project_Media/d.wav', 'Project_Media/e.wav'],
      notCopiedCount: 3,
      timedOut: true,
    });
    // One fixed sentence for the time, none for a failure; the warning line says the same, with the files as data.
    expect(result.summary).toContain('stopped after 15 seconds');
    expect(result.summary).toContain('The next save that replaces this project file copies the rest.');
    expect(result.summary).not.toContain('could not be copied completely');
    expect(result.summary).not.toMatch(/\b[a-e]\.wav\b/);
    expect(mediaWarnings(result)).toEqual([
      expect.objectContaining({
        kind: 'warning',
        source: 'server',
        subject: null,
        data: {
          notCopied: ['Project_Media/c.wav', 'Project_Media/d.wav', 'Project_Media/e.wav'],
          notCopiedCount: 3,
          timedOut: true,
        },
        text: expect.stringMatching(/stopped after 15 seconds.*The next save .* copies the rest\.$/) as unknown,
      }),
    ]);
    expect((mediaWarnings(result)[0] as unknown as { text: string }).text).not.toContain('not copied completely');
  });

  it('copies what is left at the next save, and that save is not timed out', async () => {
    const clock = handClock();
    let slow = true;
    const { ops } = recorded({
      copyNew: (from, to) =>
        nodeProjectFs.copyNew(from, to).then(() => {
          if (slow && isMedia(from) && path.basename(from) === 'b.wav') clock.advance(MEDIA_COPY_BUDGET_MS);
        }),
    });
    const s = await setup(ops, clock.now);
    put(s.mediaDir, FIVE);
    const first = body(await save(s.ctx));
    expect(media(first)).toMatchObject({ copied: 2, notCopiedCount: 3, timedOut: true });
    slow = false;
    // The project is changed again so that this save has something to do; only the files that are missing are copied.
    fs.writeFileSync(s.proj, 'changed');
    const second = body(await save(s.ctx));
    expect(media(second)).toEqual({ copied: 3, notCopied: [], notCopiedCount: 0, timedOut: false });
    expect(names(s.oldMediaDir)).toEqual(['a.wav', 'b.wav', 'c.wav', 'd.wav', 'e.wav']);
    expect(mediaWarnings(second)).toEqual([]);
    expect(second.summary).not.toContain('stopped after');
  });

  it('does not stop before the time is used up: a copy that ends a millisecond short of the budget goes on', async () => {
    const clock = handClock();
    const { ops } = slowCopy(clock, 'b.wav', MEDIA_COPY_BUDGET_MS - 1);
    const s = await setup(ops, clock.now);
    put(s.mediaDir, FIVE);
    const result = body(await save(s.ctx));
    expect(media(result)).toEqual({ copied: 5, notCopied: [], notCopiedCount: 0, timedOut: false });
    expect(mediaWarnings(result)).toEqual([]);
  });

  it('is not timed out when the time runs out after the last file: nothing is left', async () => {
    const clock = handClock();
    const { ops } = slowCopy(clock, 'e.wav', MEDIA_COPY_BUDGET_MS * 3);
    const s = await setup(ops, clock.now);
    put(s.mediaDir, FIVE);
    const result = body(await save(s.ctx));
    expect(media(result)).toEqual({ copied: 5, notCopied: [], notCopiedCount: 0, timedOut: false });
    expect(mediaWarnings(result)).toEqual([]);
  });

  it('gives both sentences when a file failed and the time ran out, and lists both kinds', async () => {
    const clock = handClock();
    const { ops } = slowCopy(clock, 'b.wav', MEDIA_COPY_BUDGET_MS, ['a.wav']);
    const s = await setup(ops, clock.now);
    put(s.mediaDir, FIVE);
    const result = body(await save(s.ctx));
    expect(result.applied).toBe(true);
    expect(names(s.oldMediaDir)).toEqual(['b.wav']);
    expect(media(result)).toEqual({
      copied: 1,
      notCopied: ['Project_Media/a.wav', 'Project_Media/c.wav', 'Project_Media/d.wav', 'Project_Media/e.wav'],
      notCopiedCount: 4,
      timedOut: true,
    });
    expect(result.summary).toContain('could not be copied completely');
    expect(result.summary).toContain('stopped after 15 seconds');
    const [warning] = mediaWarnings(result) as unknown as { text: string }[];
    expect(mediaWarnings(result)).toHaveLength(1);
    expect(warning?.text).toContain('not copied completely');
    expect(warning?.text).toContain('stopped after 15 seconds');
  });

  it('says nothing about the time when only a file failed', async () => {
    const clock = handClock();
    const { ops } = slowCopy(clock, 'none.wav', 0, ['a.wav']);
    const s = await setup(ops, clock.now);
    put(s.mediaDir, { 'a.wav': 'a', 'b.wav': 'b' });
    const result = body(await save(s.ctx));
    expect(media(result)).toEqual({
      copied: 1,
      notCopied: ['Project_Media/a.wav'],
      notCopiedCount: 1,
      timedOut: false,
    });
    expect(result.summary).toContain('could not be copied completely');
    expect(result.summary).not.toContain('stopped after');
    expect((mediaWarnings(result)[0] as unknown as { text: string }).text).not.toContain('stopped after');
  });

  it('applies to the file that opentune_save_project_overwrite replaces, too', async () => {
    const clock = handClock();
    const { ops } = slowCopy(clock, 'a.wav', MEDIA_COPY_BUDGET_MS);
    const s = await setup(ops, clock.now);
    put(s.otherMediaDir, { 'a.wav': 'a', 'b.wav': 'b' });
    const result = body(await overwriteProject(s.ctx, { path: s.other, confirm: true, ...wait }));
    expect(result.applied).toBe(true);
    expect(media(result)).toEqual({
      copied: 1,
      notCopied: ['Project_Media/b.wav'],
      notCopiedCount: 1,
      timedOut: true,
    });
    expect(mediaWarnings(result)).toHaveLength(1);
  });
});

describe('copyMediaToOldVersions', () => {
  /** The folders of a project file, with the oldversion folder made, as it is when the old version has been kept. */
  const folders = (file: string) => {
    const found = ProjectFolders.of(file, process.platform);
    if (found === null) throw new Error(`no folders for ${file}`);
    fs.mkdirSync(found.oldversionDir);
    return found;
  };

  it('names at most MAX_MEDIA_NAMED files that were not copied, and counts all of them', async () => {
    const t = tempDir();
    cleanup.push(t.remove);
    const file = path.join(t.dir, 'song.otproj');
    const f = folders(file);
    const many = Object.fromEntries(
      Array.from({ length: MAX_MEDIA_NAMED + 5 }, (_, i) => [`a${String(i).padStart(2, '0')}.wav`, 'x']),
    );
    put(f.mediaDir, many);
    const { ops } = recorded({ copyNew: denied });
    const result = await copyMediaToOldVersions(ops, f);
    expect(result.copied).toBe(0);
    expect(result.notCopiedCount).toBe(MAX_MEDIA_NAMED + 5);
    expect(result.notCopied).toHaveLength(MAX_MEDIA_NAMED);
    expect(result.notCopied[0]).toBe('Project_Media/a00.wav');
  });

  it('names at most MAX_MEDIA_NAMED of the files left when the time ran out, and counts all of them', async () => {
    const t = tempDir();
    cleanup.push(t.remove);
    const f = folders(path.join(t.dir, 'song.otproj'));
    const many = Object.fromEntries(
      Array.from({ length: MAX_MEDIA_NAMED + 6 }, (_, i) => [`a${String(i).padStart(2, '0')}.wav`, 'x']),
    );
    put(f.mediaDir, many);
    let time = 0;
    // The first file takes the whole budget.
    const { ops } = recorded({
      copyNew: (from, to) =>
        nodeProjectFs.copyNew(from, to).then(() => {
          time += MEDIA_COPY_BUDGET_MS;
        }),
    });
    const result = await copyMediaToOldVersions(ops, f, () => time);
    expect(result.copied).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(result.failedCount).toBe(0);
    expect(result.notCopiedCount).toBe(MAX_MEDIA_NAMED + 5);
    expect(result.notCopied).toHaveLength(MAX_MEDIA_NAMED);
    expect(result.notCopied[0]).toBe('Project_Media/a01.wav');
    expect(names(f.oldversionMediaDir)).toEqual(['a00.wav']);
  });

  it('counts the files that failed apart from those left, and lists the failed ones first', async () => {
    const t = tempDir();
    cleanup.push(t.remove);
    const f = folders(path.join(t.dir, 'song.otproj'));
    put(f.mediaDir, { 'a.wav': 'a', 'b.wav': 'b', 'c.wav': 'c' });
    let time = 0;
    const { ops } = recorded({
      copyNew: (from, to) => {
        if (path.basename(from) === 'a.wav') return denied();
        return nodeProjectFs.copyNew(from, to).then(() => {
          time += MEDIA_COPY_BUDGET_MS;
        });
      },
    });
    expect(await copyMediaToOldVersions(ops, f, () => time)).toEqual({
      copied: 1,
      notCopied: ['Project_Media/a.wav', 'Project_Media/c.wav'],
      notCopiedCount: 2,
      timedOut: true,
      failedCount: 1,
    });
  });

  it('copies every file once, in name order, and a second call copies nothing', async () => {
    const t = tempDir();
    cleanup.push(t.remove);
    const f = folders(path.join(t.dir, 'song.otproj'));
    put(f.mediaDir, { 'b.wav': 'b', 'a.wav': 'a' });
    const { ops, calls } = recorded();
    expect(await copyMediaToOldVersions(ops, f)).toEqual({ ...NOTHING, copied: 2, failedCount: 0 });
    expect(calls.filter((c) => c.op === 'copyNew').map((c) => path.basename(c.args[0] ?? ''))).toEqual([
      'a.wav',
      'b.wav',
    ]);
    expect(await copyMediaToOldVersions(ops, f)).toEqual({ ...NOTHING, failedCount: 0 });
    expect(names(f.oldversionMediaDir)).toEqual(['a.wav', 'b.wav']);
  });

  it('does not delete a file that appeared under the name meanwhile, and does not count it as failed', async () => {
    const t = tempDir();
    cleanup.push(t.remove);
    const f = folders(path.join(t.dir, 'song.otproj'));
    put(f.mediaDir, { '1.wav': 'source' });
    const { ops, calls } = recorded({
      // The listing of the target said nothing was there; another process wrote the file in between.
      stat: (file) => (isMedia(file) && file.includes('oldversion') ? Promise.resolve(null) : nodeProjectFs.stat(file)),
    });
    put(f.oldversionMediaDir, { '1.wav': 'written by someone else' });
    const result = await copyMediaToOldVersions(ops, f);
    expect(result).toEqual({ ...NOTHING, failedCount: 0 });
    expect(read(path.join(f.oldversionMediaDir, '1.wav'))).toBe('written by someone else');
    expect(calls.filter((c) => c.op === 'remove')).toEqual([]);
  });
});

describe('the operations of the real file system that the copy of the audio uses', () => {
  it('stat tells a file from a folder, and a missing path from both, without a link being followed', async () => {
    const t = tempDir();
    cleanup.push(t.remove);
    put(t.dir, { 'a.wav': 'audio' });
    fs.mkdirSync(path.join(t.dir, 'sub'));
    const file = await nodeProjectFs.stat(path.join(t.dir, 'a.wav'));
    expect(file).toMatchObject({ isFile: true });
    expect(file?.mtimeMs).toBeGreaterThan(0);
    expect(await nodeProjectFs.stat(path.join(t.dir, 'sub'))).toMatchObject({ isFile: false });
    expect(await nodeProjectFs.stat(path.join(t.dir, 'missing.wav'))).toBeNull();
    // Below a file there is nothing, too.
    expect(await nodeProjectFs.stat(path.join(t.dir, 'a.wav', 'x.wav'))).toBeNull();
    const link = path.join(t.dir, 'link.wav');
    try {
      fs.symlinkSync(path.join(t.dir, 'a.wav'), link, 'file');
    } catch {
      return; // Links need a privilege on some systems; the other checks stand.
    }
    expect(await nodeProjectFs.stat(link)).toMatchObject({ isFile: false });
  });

  it('copyReplace replaces the target, and a failure leaves the target as it was and no part behind', async () => {
    const t = tempDir();
    cleanup.push(t.remove);
    put(t.dir, { 'from.wav': 'new', 'to.wav': 'old' });
    await nodeProjectFs.copyReplace(path.join(t.dir, 'from.wav'), path.join(t.dir, 'to.wav'));
    expect(read(path.join(t.dir, 'to.wav'))).toBe('new');
    expect(names(t.dir)).toEqual(['from.wav', 'to.wav']);

    put(t.dir, { 'to.wav': 'old' });
    await expect(
      nodeProjectFs.copyReplace(path.join(t.dir, 'missing.wav'), path.join(t.dir, 'to.wav')),
    ).rejects.toThrow();
    expect(read(path.join(t.dir, 'to.wav'))).toBe('old');
    expect(names(t.dir)).toEqual(['from.wav', 'to.wav']);

    // The rename fails (the target is a folder): the part that was written is deleted again.
    fs.mkdirSync(path.join(t.dir, 'dir.wav'));
    await expect(
      nodeProjectFs.copyReplace(path.join(t.dir, 'from.wav'), path.join(t.dir, 'dir.wav')),
    ).rejects.toThrow();
    expect(names(t.dir)).toEqual(['dir.wav', 'from.wav', 'to.wav']);
  });
});
