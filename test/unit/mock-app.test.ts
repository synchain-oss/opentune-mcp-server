// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// app.quit in the mock beyond what the contract vectors show: the order of its checks, the reason it
// gives for each kind of unfinished job, and the way it ends: the answer first, then the connections
// close, the port refuses, the discovery file goes, and a request behind it gets SHUTTING_DOWN.

import fs, { existsSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startMock } from '../../mock/server.js';
import { RunnerConnection } from '../contract/connection.js';
import { tempDir } from '../support/context.js';
import { Sessions, type Response, type TestSession } from '../support/mock-client.js';

const sessions = new Sessions();
afterEach(async () => {
  await sessions.dispose();
});

const kindAndReason = (error: { data: Record<string, unknown> }) => [error.data.kind, error.data.reason];

/** A connection of its own, authenticated, that can send several requests in one write. */
async function pipelined(session: TestSession) {
  const conn = await RunnerConnection.open(session.mock.address.port);
  const write = (...requests: object[]) => {
    conn.write(Buffer.from(requests.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8'));
  };
  const read = async (): Promise<Response> => {
    const line = await conn.readLine(5000);
    if (typeof line === 'string') throw new Error(`no line from the mock: ${line}`);
    return JSON.parse(line.toString('utf8')) as Response;
  };
  write({
    jsonrpc: '2.0',
    id: 'hello',
    method: 'session.hello',
    params: { token: session.mock.discovery.token, protocol: '1.0', client: { name: 'mock-test', version: '1.0.0' } },
  });
  await read();
  return { conn, write, read };
}

describe('app.quit', () => {
  it('answers first, then ends the mock: the connection closes, the port refuses, the discovery file goes', async () => {
    const session = await sessions.open();
    const { mock } = session;
    expect(mock.quitRequested).toBe(false);
    const result = await session.ok('app.quit');
    expect(result).toMatchObject({ quitting: true, discardedUnsavedChanges: false, projectPath: null, warnings: [] });
    expect(result.nullReasons).toEqual({ projectPath: 'no_project_path' });
    expect(result.exitDeadlineMs).toBe(5000);
    expect(mock.quitRequested).toBe(true);
    await mock.whenEnded();
    expect(existsSync(mock.discoveryPath)).toBe(false);
    expect(mock.openConnections).toBe(0);
    await expect(RunnerConnection.open(mock.address.port)).rejects.toThrow();
    // The connection the answer came on is closed too.
    await expect(session.call('session.info')).rejects.toThrow(/no line from the mock/);
  });

  it('refuses a request behind it with SHUTTING_DOWN, also a second app.quit', async () => {
    const session = await sessions.open();
    const { write, read } = await pipelined(session);
    write(
      { jsonrpc: '2.0', id: 1, method: 'app.quit', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'app.quit', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'session.info', params: {} },
    );
    const first = await read();
    expect(first).toMatchObject({ id: 1, result: { quitting: true } });
    for (const id of [2, 3]) {
      const refused = await read();
      expect(refused).toMatchObject({ id, error: { data: { kind: 'SHUTTING_DOWN', executed: false } } });
    }
    await session.mock.whenEnded();
  });

  it('names the saved project, and gives no null reason then', async () => {
    const session = await sessions.open();
    const ids = session.mock.given({
      dirty: false,
      files: [{ bind: 'proj', kind: 'existing', extension: '.otproj' }],
      projectFile: 'proj',
    });
    const result = await session.ok('app.quit');
    expect(result.projectPath).toBe(ids.proj);
    expect(result).not.toHaveProperty('nullReasons');
  });

  describe('unsaved changes', () => {
    it('refuses them, changes nothing and keeps running; discardUnsaved false is the same as none', async () => {
      const session = await sessions.open();
      session.mock.given({ dirty: true });
      for (const params of [{}, { discardUnsaved: false }]) {
        const error = await session.fails('app.quit', params);
        expect(kindAndReason(error)).toEqual(['UNSAVED_CHANGES', 'project_dirty']);
        expect(error.data).toMatchObject({ executed: false });
      }
      expect(session.mock.quitRequested).toBe(false);
      expect((await session.ok('session.info')).flavor).toBe('standalone');
      expect((await session.ok('project.get')).project).toMatchObject({ dirty: true });
    });

    it('quits with discardUnsaved true, reports what it discards and warns that it cannot be undone', async () => {
      const session = await sessions.open();
      session.mock.given({ dirty: true });
      const result = await session.ok('app.quit', { discardUnsaved: true });
      expect(result).toMatchObject({
        quitting: true,
        discardedUnsavedChanges: true,
        warnings: [{ code: 'IRREVERSIBLE', subject: { singleton: 'project' } }],
      });
      await session.mock.whenEnded();
    });

    it('does not say it discards anything when nothing was unsaved, whatever discardUnsaved says', async () => {
      const session = await sessions.open();
      const result = await session.ok('app.quit', { discardUnsaved: true });
      expect(result).toMatchObject({ discardedUnsavedChanges: false, warnings: [] });
    });
  });

  describe('unfinished work', () => {
    it.each([
      ['import', 'import_in_progress'],
      ['export', 'export_in_progress'],
      ['projectOpen', 'project_operation'],
      ['projectSave', 'project_operation'],
      ['prefsApply', 'job_in_progress'],
      ['timeGridSeed', 'job_in_progress'],
    ])('a running %s job refuses with BUSY(%s), and the mock keeps running', async (kind, reason) => {
      const session = await sessions.open();
      session.mock.given({ jobs: [{ bind: 'job', kind, state: 'running', cancellable: false }] });
      const error = await session.fails('app.quit');
      expect(kindAndReason(error)).toEqual(['BUSY', reason]);
      expect(error.data).toMatchObject({ executed: false, retryable: true });
      expect(session.mock.quitRequested).toBe(false);
      expect((await session.ok('session.info')).flavor).toBe('standalone');
    });

    it('lets a job that finished go by', async () => {
      const session = await sessions.open();
      session.mock.given({ jobs: [{ bind: 'job', kind: 'prefsApply', state: 'cancelled', cancellable: false }] });
      expect(await session.ok('app.quit')).toMatchObject({ quitting: true });
      await session.mock.whenEnded();
    });

    it('checks the UI first: a dialog or a gesture is BUSY before unsaved changes are looked at', async () => {
      const session = await sessions.open();
      session.mock.given({ dirty: true, dialogs: [{ kind: 'message' }] });
      expect(kindAndReason(await session.fails('app.quit'))).toEqual(['BUSY', 'modal_open']);
      await session.ok('ui.dismiss', { target: 'dialogs' });
      session.mock.setBusy({ pointerDown: true });
      expect(kindAndReason(await session.fails('app.quit'))).toEqual(['BUSY', 'pointer_down']);
      session.mock.setBusy({ pointerDown: false });
      // Nothing busy any more: now the unsaved changes decide.
      expect(kindAndReason(await session.fails('app.quit'))).toEqual(['UNSAVED_CHANGES', 'project_dirty']);
    });

    it('checks the jobs before unsaved changes', async () => {
      const session = await sessions.open();
      session.mock.given({
        dirty: true,
        jobs: [{ bind: 'job', kind: 'prefsApply', state: 'running', cancellable: false }],
      });
      expect(kindAndReason(await session.fails('app.quit', { discardUnsaved: true }))).toEqual([
        'BUSY',
        'job_in_progress',
      ]);
    });
  });

  describe('what it needs', () => {
    it('is UNSUPPORTED(no_editor_window) without an editor window, and the mock keeps running', async () => {
      const session = await sessions.open();
      session.mock.setNoEditor(true);
      const error = await session.fails('app.quit');
      expect(kindAndReason(error)).toEqual(['UNSUPPORTED', 'no_editor_window']);
      expect(error.data).toMatchObject({ executed: false });
      expect(session.mock.quitRequested).toBe(false);
    });

    it('is UNSUPPORTED(capability_missing) where the capability is not reported', async () => {
      const session = await sessions.open();
      session.mock.given({ withoutCapabilities: ['app.quit'] });
      expect(kindAndReason(await session.fails('app.quit'))).toEqual(['UNSUPPORTED', 'capability_missing']);
      expect(session.mock.quitRequested).toBe(false);
    });

    it('takes only a boolean discardUnsaved and no other member', async () => {
      const session = await sessions.open();
      for (const params of [{ discardUnsaved: 'yes' }, { discard: true }]) {
        const response = await session.call('app.quit', params);
        expect(response.error?.code).toBe(-32602);
      }
      expect(session.mock.quitRequested).toBe(false);
    });
  });
});

describe('endJob', () => {
  it('ends a job that given made, so that app.quit no longer finds it unfinished', async () => {
    const session = await sessions.open();
    const ids = session.mock.given({
      jobs: [{ bind: 'job', kind: 'projectSave', state: 'running', cancellable: false }],
    });
    expect(kindAndReason(await session.fails('app.quit'))).toEqual(['BUSY', 'project_operation']);
    expect(session.mock.endJob(ids.job ?? '')).toBe(true);
    expect((await session.ok('job.get', { jobId: ids.job })).job).toMatchObject({ state: 'cancelled' });
    // Ending it again, or a job nobody made, is no job to end.
    expect(session.mock.endJob(ids.job ?? '')).toBe(false);
    expect(session.mock.endJob('j:00000000:99')).toBe(false);
    expect(await session.ok('app.quit')).toMatchObject({ quitting: true });
  });
});

describe('the end of the mock when the discovery file cannot be removed', () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  /** A mock whose rmSync fails for its discovery file only (as a file that Windows will not delete: EPERM). */
  async function stubborn() {
    const t = tempDir();
    cleanup.push(t.remove);
    const mock = await startMock({ discoveryDir: t.dir });
    const removed = fs.rmSync.bind(fs);
    const failure = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (target === mock.discoveryPath) throw failure;
      removed(target, options);
    });
    return { mock, failure };
  }

  it('still ends: whenEnded resolves, the clean-up after the file runs, and stop() reports the failure', async () => {
    const { mock, failure } = await stubborn();
    const ids = mock.given({ files: [{ bind: 'file', kind: 'existing', extension: '.otproj' }] });
    expect(existsSync(ids.file ?? '')).toBe(true);
    let ended = false;
    void mock.whenEnded().then(() => {
      ended = true;
    });
    await expect(mock.stop()).rejects.toBe(failure);
    // Without the end being marked this never resolves and the test runs into its time limit.
    await mock.whenEnded();
    expect(ended).toBe(true);
    // The files of the mock were cleaned up although the discovery file was not removed.
    expect(existsSync(ids.file ?? '')).toBe(false);
    expect(mock.openConnections).toBe(0);
    // Once, whoever asks: the second stop() is the same failure, not a second attempt.
    await expect(mock.stop()).rejects.toBe(failure);
  });

  it('ends after app.quit too, and leaves no unhandled rejection behind', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    cleanup.push(() => process.off('unhandledRejection', onUnhandled));

    const { mock, failure } = await stubborn();
    const { conn, write, read } = await pipelined({ mock } as TestSession);
    cleanup.push(() => {
      conn.destroy();
    });
    write({ jsonrpc: '2.0', id: 1, method: 'app.quit', params: {} });
    expect(await read()).toMatchObject({ id: 1, result: { quitting: true } });
    await mock.whenEnded();
    // The rejection of a promise that nobody handles is reported in a later turn: let it come.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(unhandled).toEqual([]);
    // The failure is not lost: whoever asks for the stop gets it.
    await expect(mock.stop()).rejects.toBe(failure);
  });
});
