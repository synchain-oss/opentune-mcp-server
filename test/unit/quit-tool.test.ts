// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_quit against the mock and against stand-in sessions: closing a project with nothing to
// lose, the refusals (unsaved changes with the right way to save first, unfinished work, a dialog, no
// editor window, an OpenTune build without the capability), closing over unsaved changes with the
// user's consent, the wait for the real exit and the connection that is dropped, and the selection of
// the instance.

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startMock } from '../../mock/server.js';
import { OtcpError, type ErrorData } from '../../src/errors/tool-error.js';
import type { Json, OtcpSession } from '../../src/otcp/client.js';
import { TOOLS } from '../../src/tools/index.js';
import { quit, quitTool } from '../../src/tools/quit.js';
import type { Outcome, ToolContext } from '../../src/tools/registry.js';
import { discoveryContent, tempDir, testContext } from '../support/context.js';
import { clip } from '../support/mock-client.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup() {
  const t = tempDir();
  cleanup.push(t.remove);
  const mock = await startMock({ discoveryDir: t.dir });
  cleanup.push(() => mock.stop());
  const ctx = testContext(t.dir);
  cleanup.push(() => {
    ctx.instances.close();
  });
  return { mock, ctx, dir: t.dir };
}

const body = (outcome: Outcome) => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.error.kind}(${String(outcome.error.reason)})`);
  return outcome.body as Record<string, unknown> & { summary: string };
};
const failure = (outcome: Outcome) => {
  if (outcome.ok) throw new Error('expected an error');
  return outcome.error;
};

const sentences = (text: string) => text.split(/(?<=\.) /);
const isErrorData = (value: Json | ErrorData): value is ErrorData =>
  typeof value.kind === 'string' && 'retryable' in value;

describe('opentune_quit', () => {
  it('closes OpenTune, waits until it is gone and says so first', async () => {
    const { ctx, mock } = await setup();
    const result = body(await quit(ctx, {}));
    expect(sentences(result.summary)[0]).toBe('OpenTune closed.');
    expect(result).toMatchObject({
      quitting: true,
      exited: true,
      discardedUnsavedChanges: false,
      projectPath: null,
      nullReasons: { projectPath: 'no_project_path' },
      exitDeadlineMs: 5000,
      warnings: [],
    });
    expect(result.summary).toContain('opentune_launch');
    // The instance is really gone, and nothing keeps its connection.
    expect(mock.quitRequested).toBe(true);
    expect(fs.existsSync(mock.discoveryPath)).toBe(false);
    expect(await ctx.instances.scan()).toMatchObject({ instances: [] });
  });

  it('names the project file only as data, never in the summary', async () => {
    const { ctx, mock } = await setup();
    const ids = mock.given({
      dirty: false,
      files: [{ bind: 'proj', kind: 'existing', extension: '.otproj' }],
      projectFile: 'proj',
    });
    const result = body(await quit(ctx, {}));
    expect(result.projectPath).toBe(ids.proj);
    expect(result).not.toHaveProperty('nullReasons');
    expect(result.summary).toContain('The project file is at the path in projectPath.');
    expect(result.summary).not.toContain(String(ids.proj));
  });

  describe('unsaved changes', () => {
    it('refuses, changes nothing, and sends the agent to save with mode save when the project has a file', async () => {
      const { ctx, mock } = await setup();
      mock.given({
        dirty: true,
        files: [{ bind: 'proj', kind: 'existing', extension: '.otproj' }],
        projectFile: 'proj',
      });
      const error = failure(await quit(ctx, {}));
      expect(error).toMatchObject({ kind: 'UNSAVED_CHANGES', reason: 'project_dirty', executed: false });
      expect(error.nextStep).toMatchObject({
        actor: 'agent',
        tool: 'opentune_save_project',
        args: { mode: 'save' },
      });
      expect(error.nextStep.message).toContain('then call opentune_quit again');
      expect(error.nextStep.message).toContain('ask the user whether the unsaved changes may be thrown away');
      expect(error.nextStep.message).toContain('discard_unsaved: true');
      expect(mock.quitRequested).toBe(false);
    });

    it('sends the agent to save_as when the project was never saved', async () => {
      const { ctx, mock } = await setup();
      mock.given({ dirty: true });
      const error = failure(await quit(ctx, {}));
      expect(error.kind).toBe('UNSAVED_CHANGES');
      expect(error.nextStep).toMatchObject({ actor: 'agent', tool: 'opentune_save_project' });
      expect(error.nextStep.args).toBeUndefined();
      expect(error.nextStep.message).toMatch(/never saved.*mode save_as, an absolute \.otproj path/);
    });

    it('names both ways to save when it cannot tell whether the project has a file', async () => {
      const { ctx, mock } = await setup();
      mock.given({ dirty: true, withoutCapabilities: ['read.v1'] });
      const error = failure(await quit(ctx, {}));
      expect(error.kind).toBe('UNSAVED_CHANGES');
      expect(error.nextStep.args).toBeUndefined();
      expect(error.nextStep.message).toMatch(/mode save; or mode save_as/);
    });

    it('closes over them with discard_unsaved, and says in the first sentence that they are lost', async () => {
      const { ctx, mock } = await setup();
      mock.given({ dirty: true });
      const result = body(await quit(ctx, { discard_unsaved: true }));
      expect(sentences(result.summary)[0]).toBe('OpenTune closed without saving; the unsaved changes are lost.');
      expect(result).toMatchObject({
        exited: true,
        discardedUnsavedChanges: true,
        warnings: [{ code: 'IRREVERSIBLE', subject: { singleton: 'project' } }],
      });
      expect(mock.quitRequested).toBe(true);
    });

    it('sends discardUnsaved only when asked, and nothing of it otherwise', async () => {
      const { ctx, mock } = await setup();
      mock.given({ dirty: true });
      expect(failure(await quit(ctx, { discard_unsaved: false })).kind).toBe('UNSAVED_CHANGES');
      expect(mock.quitRequested).toBe(false);
    });
  });

  describe('refusals', () => {
    it('refuses while a job has not finished, with a step for the agent', async () => {
      const { ctx, mock } = await setup();
      mock.given({ jobs: [{ bind: 'job', kind: 'prefsApply', state: 'running', cancellable: false }] });
      const error = failure(await quit(ctx, { discard_unsaved: true }));
      expect(error).toMatchObject({ kind: 'BUSY', reason: 'job_in_progress', retryable: true, executed: false });
      expect(error.nextStep.actor).toBe('agent');
      expect(error.nextStep.message).toContain('has not finished');
      expect(mock.quitRequested).toBe(false);
    });

    it('refuses while a dialog is open, and sends the user to close it', async () => {
      const { ctx, mock } = await setup();
      mock.given({ dialogs: [{ kind: 'message' }] });
      const error = failure(await quit(ctx, {}));
      expect(error).toMatchObject({ kind: 'BUSY', reason: 'modal_open' });
      expect(error.nextStep.actor).toBe('user');
      expect(mock.quitRequested).toBe(false);
    });

    it('is UNSUPPORTED(no_editor_window) without an editor window', async () => {
      const { ctx, mock } = await setup();
      mock.setNoEditor(true);
      const error = failure(await quit(ctx, {}));
      expect(error).toMatchObject({ kind: 'UNSUPPORTED', reason: 'no_editor_window', executed: false });
      expect(mock.quitRequested).toBe(false);
    });

    it('tells the user to save and close the window themselves on a build without the capability', async () => {
      const { ctx, mock } = await setup();
      mock.given({ withoutCapabilities: ['app.quit'], dirty: true });
      const error = failure(await quit(ctx, { discard_unsaved: true }));
      expect(error).toMatchObject({ kind: 'UNSUPPORTED', reason: 'capability_missing', executed: false });
      expect(error.detail).toContain('app.quit');
      expect(error.nextStep.actor).toBe('user');
      expect(error.nextStep.message).toMatch(/Save the project first.*close the OpenTune window themselves/);
      expect(error.nextStep.message).toContain('does not ask about unsaved changes');
      // Nothing was sent that could have closed it.
      expect(mock.quitRequested).toBe(false);
      expect(fs.existsSync(mock.discoveryPath)).toBe(true);
    });
  });

  describe('with a stand-in session', () => {
    /** One instance whose session answers app.quit as the test says; the discovery file is what the wait looks at. */
    function standIn(answer: Json | ErrorData, options: { removeFile: boolean }) {
      const t = tempDir();
      cleanup.push(t.remove);
      const content = discoveryContent(process.pid);
      const file = path.join(t.dir, `${String(process.pid)}.json`);
      fs.writeFileSync(file, JSON.stringify(content));
      const calls: { method: string; params: Json }[] = [];
      let closes = 0;
      let closed = false;
      const session = {
        hello: { capabilities: ['session.v1', 'app.quit'] },
        get closed() {
          return closed;
        },
        call(method: string, params: Json) {
          calls.push({ method, params });
          if (isErrorData(answer)) return Promise.reject(new OtcpError(answer));
          if (options.removeFile) fs.rmSync(file, { force: true });
          return Promise.resolve(answer);
        },
        close() {
          closes++;
          closed = true;
        },
      } as unknown as OtcpSession;
      const ctx: ToolContext = testContext(t.dir, { open: () => Promise.resolve(session) });
      cleanup.push(() => {
        ctx.instances.close();
      });
      return { ctx, calls, closes: () => closes, instanceId: content.instanceId as string };
    }
    const answer = (extra: Json = {}): Json => ({
      quitting: true,
      discardedUnsavedChanges: false,
      projectPath: null,
      exitDeadlineMs: 100,
      warnings: [],
      ...extra,
    });

    it('sends app.quit with no parameters, then closes the connection it held, once the instance is gone', async () => {
      const { ctx, calls, closes } = standIn(answer(), { removeFile: true });
      const result = body(await quit(ctx, {}));
      expect(result).toMatchObject({ exited: true });
      expect(calls).toEqual([{ method: 'app.quit', params: {} }]);
      // The cached session was closed and dropped: a later call would open a new one.
      expect(closes()).toBe(1);
    });

    it('sends discardUnsaved true only for discard_unsaved true', async () => {
      const { ctx, calls } = standIn(answer({ discardedUnsavedChanges: true }), { removeFile: true });
      await quit(ctx, { discard_unsaved: true });
      expect(calls).toEqual([{ method: 'app.quit', params: { discardUnsaved: true } }]);
    });

    it('warns when the instance is still there after the time it gave itself, and says what to do', async () => {
      const { ctx, closes } = standIn(answer({ exitDeadlineMs: 1 }), { removeFile: false });
      const result = body(await quit(ctx, {}));
      expect(result).toMatchObject({ quitting: true, exited: false });
      const [first, ...rest] = sentences(result.summary);
      expect(first).toMatch(
        /^OpenTune accepted the request to close but had not exited after \d+ s; it may still be shutting down\.$/,
      );
      expect(first).not.toMatch(/closed\./);
      expect(rest.join(' ')).toContain('Check opentune_get_status before assuming it is closed.');
      // The instance is still listed, so only the tool itself drops the connection it held; the scan would not.
      expect(closes()).toBe(1);
    }, 15_000);

    it('keeps the loss of unsaved changes in the first sentence when the exit is not confirmed', async () => {
      const { ctx } = standIn(answer({ exitDeadlineMs: 1, discardedUnsavedChanges: true }), { removeFile: false });
      const result = body(await quit(ctx, { discard_unsaved: true }));
      expect(result.exited).toBe(false);
      expect(sentences(result.summary)[0]).toMatch(
        /^OpenTune was told to close without saving, so the unsaved changes are lost, but it had not exited/,
      );
    }, 15_000);

    it('takes a missing or absurd exitDeadlineMs as the default and does not trust it', async () => {
      const { ctx } = standIn(answer({ exitDeadlineMs: 'soon' }), { removeFile: true });
      expect(body(await quit(ctx, {}))).toMatchObject({ exited: true, exitDeadlineMs: 5000 });
    });

    it('reports an answer without quitting true as an internal error, not as a close', async () => {
      const { ctx, closes } = standIn(answer({ quitting: false }), { removeFile: false });
      const error = failure(await quit(ctx, {}));
      expect(error).toMatchObject({ kind: 'INTERNAL', executed: null });
      expect(error.detail).toContain('without quitting: true');
      // It may still be running, and the connection is kept.
      expect(closes()).toBe(0);
    });

    it('passes an error of OpenTune on, with its kind, and keeps the connection', async () => {
      const refused: ErrorData = {
        kind: 'SHUTTING_DOWN',
        reason: null,
        retryable: false,
        detail: 'the server is stopping',
        executed: false,
      };
      const { ctx, closes } = standIn(refused, { removeFile: false });
      expect(failure(await quit(ctx, {}))).toMatchObject({ kind: 'SHUTTING_DOWN', executed: false });
      expect(closes()).toBe(0);
    });
  });

  describe('which instance', () => {
    function twoInstances() {
      const t = tempDir();
      cleanup.push(t.remove);
      const ids = [1001, 1002].map((pid) => {
        const content = discoveryContent(pid);
        fs.writeFileSync(path.join(t.dir, `${String(pid)}.json`), JSON.stringify(content));
        return content.instanceId as string;
      });
      const ctx = testContext(t.dir, {
        open: () => Promise.reject(new Error('no connection may be opened in this test')),
      });
      cleanup.push(() => {
        ctx.instances.close();
      });
      return { ctx, ids };
    }

    it('never picks one of several on its own', async () => {
      const { ctx } = twoInstances();
      const outcome = await quit(ctx, {});
      expect(failure(outcome)).toMatchObject({ kind: 'MULTIPLE_INSTANCES' });
      expect(outcome.ok ? [] : (outcome.context?.instances as unknown[])).toHaveLength(2);
    });

    it('does not switch to another instance when the instance_id is gone', async () => {
      const { ctx } = twoInstances();
      expect(failure(await quit(ctx, { instance_id: 'f'.repeat(32) }))).toMatchObject({ kind: 'INSTANCE_NOT_FOUND' });
    });
  });
});

describe('the tool declaration', () => {
  it('is registered once, as destructive but idempotent, and needs app.quit', () => {
    expect(TOOLS.filter((t) => t.name === 'opentune_quit')).toEqual([quitTool]);
    expect(quitTool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(quitTool.capabilities).toEqual(['app.quit']);
    expect(quitTool.otcpMethods).toContain('app.quit');
  });

  it('says in the description when it closes, what it refuses, who may consent and how to start again', () => {
    const { description } = quitTool;
    expect(description.length).toBeLessThanOrEqual(600);
    expect(description).toMatch(/^OpenTune \(audio vocal pitch editor\): /);
    for (const phrase of [
      "like the window's close button",
      'UNSAVED_CHANGES',
      'opentune_save_project',
      'discard_unsaved: true',
      'explicitly agreed',
      'cannot be undone',
      'opentune_launch',
    ]) {
      expect(description).toContain(phrase);
    }
  });

  it('takes only discard_unsaved and instance_id', () => {
    expect(Object.keys(quitTool.inputSchema.shape).sort()).toEqual(['discard_unsaved', 'instance_id']);
    expect(quitTool.inputSchema.safeParse({ discard_unsaved: true }).success).toBe(true);
    expect(quitTool.inputSchema.safeParse({ discard_unsaved: 'yes' }).success).toBe(false);
    expect(quitTool.inputSchema.safeParse({ confirm: true }).success).toBe(false);
  });
});

describe('a clip in the project', () => {
  it('does not change what quitting asks: only the unsaved flag decides', async () => {
    const { ctx, mock } = await setup();
    mock.given({ clips: [clip()], dirty: false });
    expect(body(await quit(ctx, {}))).toMatchObject({ exited: true, discardedUnsavedChanges: false });
  });
});
