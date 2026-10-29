// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The clean-up around the missing-media step of the wave-B boundary scenario (test/e2e/wave-b-boundary.ts):
// the files it moves away come back whatever the step did, and a rename back that fails never replaces how
// the step ended. The rest of the scenario needs a started OpenTune; here only the folders are real.

import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { withMediaAway } from '../e2e/wave-b-boundary.js';

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** The layout of the step: a project folder with two media-copy folders and a project, and the media file already moved. */
async function layout() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ot-boundary-test-'));
  cleanup.push(root);
  const folder = path.join(root, 'projects');
  const media = path.join(root, 'media');
  await mkdir(path.join(folder, 'first-media'), { recursive: true });
  await mkdir(path.join(folder, 'second-media'), { recursive: true });
  await writeFile(path.join(folder, 'first.otproj'), 'project');
  await mkdir(media, { recursive: true });
  const copy = path.join(media, 'copied-take.wav');
  const moved = path.join(media, 'moved-take.wav');
  await writeFile(moved, 'audio');
  const names = async () => ({
    folder: (await readdir(folder)).sort(),
    media: (await readdir(media)).sort(),
  });
  return { root, folder, copy, moved, names };
}

const BACK = {
  folder: ['first-media', 'first.otproj', 'second-media'],
  media: ['copied-take.wav'],
};

const denied = (name: string) =>
  Object.assign(new Error(`EPERM: operation not permitted, rename '${name}'`), { code: 'EPERM' });

describe('withMediaAway', () => {
  it('takes the copy folders away while the body runs and puts everything back afterwards', async () => {
    const { names, ...files } = await layout();
    let during: string[] = [];
    const result = await withMediaAway(files, async (copyFolders) => {
      during = (await readdir(files.folder)).sort();
      return copyFolders;
    });
    expect(result).toEqual({ outcome: { ok: true, value: 2 }, putBackFailures: [] });
    expect(during).toEqual(['first-media.away', 'first.otproj', 'second-media.away']);
    expect(await names()).toEqual(BACK);
  });

  it('puts everything back when the body throws, and hands the error over', async () => {
    const { names, ...files } = await layout();
    const failure = new Error('project.open failed');
    const result = await withMediaAway(files, () => Promise.reject(failure));
    expect(result.outcome).toEqual({ ok: false, error: failure });
    expect(result.putBackFailures).toEqual([]);
    expect(await names()).toEqual(BACK);
  });

  it('a rename back that fails does not replace the result of the body, and the others still go back', async () => {
    const { names, ...files } = await layout();
    // The media file cannot be renamed back (OpenTune holds it, say); the copy folders can.
    const move = (from: string, to: string) => (from === files.moved ? Promise.reject(denied(from)) : rename(from, to));
    const result = await withMediaAway(files, () => Promise.resolve('opened'), move);
    expect(result.outcome).toEqual({ ok: true, value: 'opened' });
    expect(result.putBackFailures).toEqual(['moved-take.wav could not be renamed back to copied-take.wav (EPERM)']);
    expect(result.putBackFailures.join()).not.toContain(files.root);
    expect(await names()).toEqual({ folder: BACK.folder, media: ['moved-take.wav'] });
  });

  it('a rename back that fails does not replace the error of the body either', async () => {
    const { names, ...files } = await layout();
    const failure = new Error('project.open failed');
    const move = (from: string, to: string) =>
      from.endsWith('first-media.away') || from === files.moved ? Promise.reject(denied(from)) : rename(from, to);
    const result = await withMediaAway(files, () => Promise.reject(failure), move);
    expect(result.outcome).toEqual({ ok: false, error: failure });
    expect(result.putBackFailures).toEqual([
      'moved-take.wav could not be renamed back to copied-take.wav (EPERM)',
      'first-media.away could not be renamed back to first-media (EPERM)',
    ]);
    expect(await names()).toEqual({
      folder: ['first-media.away', 'first.otproj', 'second-media'],
      media: ['moved-take.wav'],
    });
  });

  it('puts back the folders it did move when taking one away fails, without running the body', async () => {
    const { names, ...files } = await layout();
    let ran = false;
    // The second folder cannot be taken away (whichever the listing names second).
    let calls = 0;
    const move = (from: string, to: string) => (++calls === 2 ? Promise.reject(denied(from)) : rename(from, to));
    const result = await withMediaAway(
      files,
      () => {
        ran = true;
        return Promise.resolve(0);
      },
      move,
    );
    expect(ran).toBe(false);
    expect(result.outcome.ok).toBe(false);
    expect(result.putBackFailures).toEqual([]);
    expect(await names()).toEqual(BACK);
  });

  it('names a rename failure without an error code by what happened', async () => {
    const { names, ...files } = await layout();
    const move = (from: string, to: string) =>
      from === files.moved ? Promise.reject(new Error('who knows')) : rename(from, to);
    const result = await withMediaAway(files, () => Promise.resolve(1), move);
    expect(result.putBackFailures).toEqual([
      'moved-take.wav could not be renamed back to copied-take.wav (rename failed)',
    ]);
    expect(await names()).toEqual({ folder: BACK.folder, media: ['moved-take.wav'] });
  });
});
