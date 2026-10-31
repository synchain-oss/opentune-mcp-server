// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_save_project, opentune_save_project_overwrite and opentune_open_project against the
// mock: saving to the current file and to a new one, the refusals (no file yet, another existing
// file, confirm missing), opening with and without unsaved changes, missing media, a missing
// capability, a job that outlives the wait, and the coverage of the project methods of the spec.

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ManualClock } from '../../mock/clock.js';
import { startMock } from '../../mock/server.js';
import { getJob } from '../../src/tools/jobs.js';
import { TOOLS } from '../../src/tools/index.js';
import {
  mediaFolderMembers,
  openProject,
  openProjectTool,
  overwriteProject,
  overwriteProjectTool,
  saveProject,
  saveProjectTool,
} from '../../src/tools/project-files.js';
import type { Outcome, ToolContext } from '../../src/tools/registry.js';
import { tempDir, testContext } from '../support/context.js';
import { clip, need } from '../support/mock-client.js';
import { otcpSpec } from '../support/otcp-spec.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(options: { manual?: boolean } = {}) {
  const t = tempDir();
  cleanup.push(t.remove);
  const clock = new ManualClock();
  const mock = await startMock({ discoveryDir: t.dir, ...(options.manual === true ? { clock } : {}) });
  cleanup.push(() => mock.stop());
  const ctx = testContext(t.dir);
  cleanup.push(() => {
    ctx.instances.close();
  });
  return { mock, ctx, clock };
}

const body = (outcome: Outcome) => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.error.kind}(${String(outcome.error.reason)})`);
  return outcome.body as Record<string, unknown> & { summary: string };
};
const failure = (outcome: Outcome) => {
  if (outcome.ok) throw new Error('expected an error');
  return outcome.error;
};

const FILES = [
  { bind: 'fresh', kind: 'absent', extension: '.otproj' },
  { bind: 'other', kind: 'absent', extension: '.otproj' },
  { bind: 'existing', kind: 'project', durationSec: 3 },
] as const;

const wait = { wait_seconds: 10 };

/** What OpenTune does with the media of the project at every save; a fixed sentence, never built from the result. */
const MEDIA_COPY =
  'OpenTune also copies the audio the project uses into a folder next to the project file, named after it with _Media added.';
/** The media folder of a project file: named after it, next to it. */
const mediaFolderOf = (file: string) => path.join(path.dirname(file), `${path.parse(file).name}_Media`);
const save = (ctx: ToolContext, args: Parameters<typeof saveProject>[1]) => saveProject(ctx, { ...wait, ...args });

describe('opentune_save_project', () => {
  it('saves under a new path with save_as, then saves the same file with save', async () => {
    const { ctx, mock } = await setup();
    const ids = mock.given({ files: [...FILES], clips: [clip()], dirty: true });
    const first = body(await save(ctx, { mode: 'save_as', path: need(ids, 'fresh') }));
    // A new file replaced nothing: the first sentence says what was written, and not that it cannot be restored.
    expect(first.summary).toMatch(
      /^opentune_save_project: wrote a new project file \(path in path\); no existing file was replaced, and from now on it is the project's file\./,
    );
    expect(first.summary).not.toMatch(/cannot be restored|irreversible|IRREVERSIBLE/i);
    // A first save to a new place says at once that the audio is copied next to the file, and where.
    expect(first.summary).toContain(
      `from now on it is the project's file. ${MEDIA_COPY} The project is no longer marked as changed`,
    );
    expect(first.mediaFolder).toBe(mediaFolderOf(need(ids, 'fresh')));
    expect(first.summary).not.toContain('_Media/');
    expect(first.summary).not.toContain(need(ids, 'fresh'));
    // The warnings keep the facts that the protocol states: the write has no undo, and some state is not stored.
    expect((first.warnings as { code: string }[]).map((w) => w.code)).toEqual(['IRREVERSIBLE', 'NOT_SAVED_IN_PROJECT']);
    expect(
      (first.lines as { kind: string; code?: string; text: string }[]).filter((l) => l.kind === 'warning').length,
    ).toBe(2);
    expect(first.summary).toMatch(/no longer marked as changed/);
    expect(first.summary).toMatch(/Not stored in the project file: the undo and redo history, global preferences/);
    expect(first.summary).not.toContain(need(ids, 'fresh'));
    expect(first).toMatchObject({
      path: need(ids, 'fresh'),
      requestedPath: need(ids, 'fresh'),
      notSavedInProject: ['undoHistory', 'preferences'],
      job: { kind: 'projectSave', state: 'succeeded' },
    });
    expect(fs.existsSync(need(ids, 'fresh'))).toBe(true);

    // Nothing was replaced, so no old version was kept, and the result says why there is none.
    expect(first.oldVersion).toBeNull();
    expect(first.nullReasons).toMatchObject({ oldVersion: 'no_previous_file' });

    const again = body(await save(ctx, { mode: 'save' }));
    expect(again.summary).toMatch(
      /^opentune_save_project: saved the project to its file \(path in path\), replacing its previous content; a copy of the replaced content was kept in the oldversion folder/,
    );
    expect(again.path).toBe(need(ids, 'fresh'));
    expect((again.oldVersion as { path: string }).path).toMatch(/\.oldversion[\\/].*-\d{8}-\d{6}\.otproj$/);
    // A later save repeats it after the facts of the save, and does not know the folder (the file is OpenTune's).
    expect(again.summary.endsWith(MEDIA_COPY)).toBe(true);
    expect(again.summary.indexOf(MEDIA_COPY)).toBeGreaterThan(again.summary.indexOf('oldVersion.path'));
    expect(again.mediaFolder).toBeNull();
    expect(again.nullReasons).toMatchObject({ mediaFolder: 'project_path_not_given' });
  });

  it('keeps the reasons the write envelope gives for its own null members next to the one for mediaFolder', () => {
    // A save to the project's own file: the folder is unknown, and the envelope has reasons of its own.
    const rendered = { nullReasons: { ui: 'no_editor_window', history: 'capability_missing' } };
    expect(mediaFolderMembers(rendered, null)).toEqual({
      mediaFolder: null,
      nullReasons: { ui: 'no_editor_window', history: 'capability_missing', mediaFolder: 'project_path_not_given' },
    });
    // Without reasons of the envelope, the reason of mediaFolder is the only one.
    expect(mediaFolderMembers({}, null)).toEqual({
      mediaFolder: null,
      nullReasons: { mediaFolder: 'project_path_not_given' },
    });
    // A nullReasons that is not an object is not spread into the result.
    for (const odd of ['text', 7, null, ['a']]) {
      expect(mediaFolderMembers({ nullReasons: odd }, null)).toEqual({
        mediaFolder: null,
        nullReasons: { mediaFolder: 'project_path_not_given' },
      });
    }
    // With a folder there is nothing to explain, and the envelope's reasons are left as they are.
    expect(mediaFolderMembers(rendered, 'C:\\Music\\song_Media')).toEqual({
      mediaFolder: 'C:\\Music\\song_Media',
    });
  });

  it('does not call a save_as onto the file the project already has a new file', async () => {
    const { ctx, mock } = await setup();
    const ids = mock.given({ files: [...FILES], clips: [clip()], dirty: true });
    body(await save(ctx, { mode: 'save_as', path: need(ids, 'fresh') }));
    // The same file again: the project's path does not change, so nothing proves that a file is new.
    const again = body(await save(ctx, { mode: 'save_as', path: need(ids, 'fresh') }));
    expect(again.summary).toMatch(/^opentune_save_project: saved the project to the file given \(path in path\)/);
    expect(again.summary).not.toContain('wrote a new project file');
    // Another path writes another new file, and the project's file moves to it.
    const other = body(await save(ctx, { mode: 'save_as', path: need(ids, 'other') }));
    expect(other.summary).toMatch(/^opentune_save_project: wrote a new project file/);
    expect(other.path).toBe(need(ids, 'other'));
  });

  it('says what to do when the project has no file yet', async () => {
    const { ctx, mock } = await setup();
    mock.given({ files: [...FILES], clips: [clip()] });
    const error = failure(await save(ctx, { mode: 'save' }));
    expect(error).toMatchObject({ kind: 'INVALID_ARGUMENT', reason: 'no_project_path' });
    expect(error.nextStep).toMatchObject({ actor: 'agent', tool: 'opentune_save_project' });
    expect(error.nextStep.message).toMatch(/save_as/);
  });

  it('refuses another existing file and points to the overwrite tool, touching nothing', async () => {
    const { ctx, mock } = await setup();
    const ids = mock.given({ files: [...FILES], clips: [clip()] });
    const before = fs.readFileSync(need(ids, 'existing'), 'utf8');
    const error = failure(await save(ctx, { mode: 'save_as', path: need(ids, 'existing') }));
    expect(error).toMatchObject({ kind: 'INVALID_ARGUMENT', reason: 'confirm_required' });
    expect(error.nextStep).toMatchObject({ actor: 'user', tool: 'opentune_save_project_overwrite' });
    expect(error.nextStep.message).toMatch(/explicitly agrees/);
    expect(fs.readFileSync(need(ids, 'existing'), 'utf8')).toBe(before);
  });

  it('refuses wrong combinations of arguments and bad paths before any request', async () => {
    const { ctx } = await setup();
    expect(failure(await save(ctx, { mode: 'save_as' }))).toMatchObject({ reason: 'path_required' });
    expect(failure(await save(ctx, { mode: 'save', path: 'C:\\Music\\a.otproj' }))).toMatchObject({
      reason: 'path_unexpected',
    });
    expect(failure(await save(ctx, { mode: 'save_as', path: 'relative/a.otproj' })).kind).toBe('INVALID_ARGUMENT');
    const wrongExtension = process.platform === 'win32' ? 'C:\\Music\\a.wav' : '/music/a.wav';
    expect(failure(await save(ctx, { mode: 'save_as', path: wrongExtension })).kind).toBe('INVALID_ARGUMENT');
  });

  it('reports an error with a next step when the instance lacks project.io', async () => {
    const { ctx, mock } = await setup();
    mock.given({ withoutCapabilities: ['project.io'] });
    const error = failure(await save(ctx, { mode: 'save' }));
    expect(error).toMatchObject({ kind: 'UNSUPPORTED', reason: 'capability_missing' });
    expect(error.detail).toMatch(/project\.io/);
    expect(error.nextStep.message).toMatch(/update/i);
  });

  it('returns the job when it outlives the wait, and get_job follows it', async () => {
    const { ctx, mock, clock } = await setup({ manual: true });
    const ids = mock.given({ files: [...FILES], clips: [clip()], dirty: true });
    const started = body(await saveProject(ctx, { mode: 'save_as', path: need(ids, 'fresh'), wait_seconds: 0 }));
    expect(started.summary).toMatch(/^opentune_save_project: started job j:[0-9a-f]{8}:[1-9][0-9]*/);
    const jobId = (started.job as { jobId: string }).jobId;
    const timer = setInterval(() => {
      clock.advance(10);
    }, 5);
    cleanup.push(() => {
      clearInterval(timer);
    });
    const done = body(await getJob(ctx, { job_id: jobId, wait_seconds: 10 }));
    expect(JSON.stringify(done)).toContain('succeeded');
  });

  it('declares itself non-destructive and not idempotent (each autosave is a new copy), with the project methods it calls', () => {
    expect(saveProjectTool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(saveProjectTool.capabilities).toContain('project.io');
    expect(saveProjectTool.otcpMethods).toEqual([
      'project.save',
      'project.saveAs',
      'project.saveCopy',
      'project.get',
      'job.get',
    ]);
  });
});

describe('opentune_save_project_overwrite', () => {
  it('needs confirm and starts nothing without it', async () => {
    const { ctx, mock } = await setup();
    const ids = mock.given({ files: [...FILES], clips: [clip()] });
    const before = fs.readFileSync(need(ids, 'existing'), 'utf8');
    for (const confirm of [undefined, false]) {
      const error = failure(await overwriteProject(ctx, { path: need(ids, 'existing'), confirm, ...wait }));
      expect(error).toMatchObject({ kind: 'INVALID_ARGUMENT', reason: 'confirm_required', executed: false });
      expect(error.nextStep.actor).toBe('user');
    }
    expect(fs.readFileSync(need(ids, 'existing'), 'utf8')).toBe(before);
  });

  it('replaces the other project file with confirm and says so in the first sentence', async () => {
    const { ctx, mock } = await setup();
    const ids = mock.given({ files: [...FILES], clips: [clip()] });
    const before = fs.readFileSync(need(ids, 'existing'), 'utf8');
    const result = body(await overwriteProject(ctx, { path: need(ids, 'existing'), confirm: true, ...wait }));
    expect(result.summary).toMatch(
      /^opentune_save_project_overwrite: OVERWROTE another existing project file at the user's request/,
    );
    expect(result.summary).not.toContain(need(ids, 'existing'));
    expect(result.summary).toContain(`goes back to it. ${MEDIA_COPY}`);
    expect(result.summary).not.toContain('cannot be restored');
    expect(result.mediaFolder).toBe(mediaFolderOf(need(ids, 'existing')));
    expect(result.path).toBe(need(ids, 'existing'));
    expect(fs.readFileSync(need(ids, 'existing'), 'utf8')).not.toBe(before);
  });

  it('is destructive and not idempotent', () => {
    expect(overwriteProjectTool.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
    expect(overwriteProjectTool.description).toMatch(/user explicitly agreed/);
    expect(overwriteProjectTool.otcpMethods).toContain('project.saveAs');
  });
});

describe('opentune_open_project', () => {
  it('opens a project file, clears the history and says the old ids are invalid', async () => {
    const { ctx, mock } = await setup();
    const ids = mock.given({ files: [...FILES], clips: [clip()], dirty: false });
    const result = body(await openProject(ctx, { path: need(ids, 'existing'), ...wait }));
    expect(result.summary).toMatch(
      /^opentune_open_project: opened the project \(path in path\) and replaced the previous one/,
    );
    expect(result.summary).toMatch(/cannot be undone/);
    expect(result.summary).toMatch(
      /undo history is cleared and every earlier clip, placement and content id is invalid/,
    );
    expect(result.summary).not.toContain(need(ids, 'existing'));
    expect(result).toMatchObject({ path: need(ids, 'existing'), job: { kind: 'projectOpen', state: 'succeeded' } });
  });

  it('gives the way back to the previous project when it had a file, and says there is none when it had not', async () => {
    const { ctx, mock } = await setup();
    const ids = mock.given({ files: [...FILES], clips: [clip()], dirty: true });
    await save(ctx, { mode: 'save_as', path: need(ids, 'fresh') });
    const result = body(await openProject(ctx, { path: need(ids, 'existing'), ...wait }));
    expect(result.summary).toMatch(/cannot be undone with opentune_undo, but opening the previous project again/);
    expect(result.summary).not.toMatch(/cannot be undone or restored/);
    const restore = (result.lines as { kind: string; restore?: unknown }[]).find((l) => l.kind === 'revert');
    expect(restore?.restore).toEqual({ tool: 'opentune_open_project', arguments: { path: need(ids, 'fresh') } });

    const second = await setup();
    const ids2 = second.mock.given({ files: [...FILES], clips: [clip()], dirty: true });
    const discarded = body(
      await openProject(second.ctx, { path: need(ids2, 'existing'), discard_unsaved: true, ...wait }),
    );
    expect(discarded.summary).toMatch(/which cannot be undone or restored/);
  });

  it('fails with UNSAVED_CHANGES and never saves; discard_unsaved opens and says it discarded', async () => {
    const { ctx, mock } = await setup();
    const ids = mock.given({ files: [...FILES], clips: [clip()], dirty: true });
    const error = failure(await openProject(ctx, { path: need(ids, 'existing'), ...wait }));
    expect(error).toMatchObject({ kind: 'UNSAVED_CHANGES', reason: 'project_dirty' });
    // The agent writes a copy and asks; it is not sent to save the project file.
    expect(error.nextStep).toMatchObject({
      actor: 'agent',
      tool: 'opentune_save_project',
      args: { mode: 'autosave' },
    });
    expect(error.nextStep.message).toMatch(/mode autosave/);
    expect(error.nextStep.message).toMatch(/ask the user whether to save the project/);
    expect(error.nextStep.message).toMatch(/do neither without an answer/);
    expect(error.nextStep.message).toMatch(/discard_unsaved: true/);
    expect(JSON.stringify(error.nextStep.args)).not.toContain('"save"');
    expect(error.nextStep.message).not.toMatch(/save the project (first|with)/i);
    expect(mock.snapshot().placements.length).toBe(1);

    const result = body(await openProject(ctx, { path: need(ids, 'existing'), discard_unsaved: true, ...wait }));
    expect(result.summary).toMatch(/DISCARDING its unsaved changes/);
    expect(result.previous).toMatchObject({ dirty: true, discarded: true });
  });

  it('reports a missing media file and the clips that were not restored', async () => {
    const { ctx, mock } = await setup();
    const ids = mock.given({
      files: [{ bind: 'proj', kind: 'projectMissingMedia', extension: '.otproj', durationSec: 4 }],
    });
    const result = body(await openProject(ctx, { path: need(ids, 'proj'), ...wait }));
    expect(result.summary).toMatch(
      /1 media file could not be found or read \(listed in skipped\.media\), so 1 clip was not restored/,
    );
    expect(result.skipped).toMatchObject({ media: [{ reason: 'missing' }], placementCount: 1 });
    expect(JSON.stringify(result.warnings)).toContain('MEDIA_MISSING');
  });

  it('reports a file that does not exist, and needs project.io', async () => {
    const { ctx, mock } = await setup();
    const ids = mock.given({ files: [...FILES] });
    expect(failure(await openProject(ctx, { path: need(ids, 'fresh'), ...wait }))).toMatchObject({
      kind: 'NOT_FOUND',
      reason: 'file_not_found',
    });
    mock.given({ withoutCapabilities: ['project.io'] });
    expect(failure(await openProject(ctx, { path: need(ids, 'existing'), ...wait }))).toMatchObject({
      kind: 'UNSUPPORTED',
      reason: 'capability_missing',
    });
  });

  it('is destructive, and its description names the consent argument', () => {
    expect(openProjectTool.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
    expect(openProjectTool.description).toMatch(/discard_unsaved: true/);
  });
});

describe('coverage of the project methods', () => {
  // Methods of the spec that no tool calls, with the reason. None right now: project.clearRecent is
  // exposed through opentune_set_settings.
  const NOT_EXPOSED: Readonly<Record<string, string>> = {};

  it('has a tool or a reason for every project.* method', () => {
    const exposed = new Set(TOOLS.flatMap((t) => t.otcpMethods));
    const methods = [...otcpSpec().methods.keys()].filter((m) => m.startsWith('project.') && m !== 'project.get');
    expect(methods).toEqual(expect.arrayContaining(['project.save', 'project.saveAs', 'project.open']));
    expect(exposed.has('project.clearRecent')).toBe(true);
    for (const method of methods) {
      expect(exposed.has(method) || method in NOT_EXPOSED, method).toBe(true);
    }
    expect(Object.keys(NOT_EXPOSED).every((m) => !exposed.has(m))).toBe(true);
  });
});
