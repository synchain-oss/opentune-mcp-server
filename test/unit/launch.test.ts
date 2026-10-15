// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_launch against a stand-in executable (test/support/fake-launch-opentune.mjs) that the tests
// start with process.execPath and the command line the tool builds. The tool's own spawn options
// are recorded and asserted. Every process a test starts is ended by the test itself afterwards:
// the server never ends one.

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { startMock } from '../../mock/server.js';
import { pidAlive } from '../../src/discovery/process.js';
import { manifestProblem } from '../../src/launch/config.js';
import { detectOfficialInstall, installDir, parseRegQuery, systemInstallDetector } from '../../src/launch/install.js';
import {
  LOCK_DENIED_MS,
  LOCK_FILES,
  LOCK_STALE_MS,
  acquireLock,
  launchDir,
  liveRecords,
  nonceHash,
  readRecords,
  readReadyFile,
  removeStaleLock,
  writeRecord,
} from '../../src/launch/records.js';
import { launchArgs, startProcess, type LaunchDeps, type SpawnFn } from '../../src/launch/start.js';
import type { ToolRun } from '../../src/discovery/process.js';
import { launch, launchTool } from '../../src/tools/launch.js';
import { render, type Outcome } from '../../src/tools/registry.js';
import { STATUS_REASON_STEPS, STATUS_TEXT, getStatus } from '../../src/tools/status.js';
import { INITIALIZE, fakeProbe, mcpClient, tempDir, testContext, type TestContext } from '../support/context.js';

const FAKE = fileURLToPath(new URL('../support/fake-launch-opentune.mjs', import.meta.url));
const TIMEOUT = 30_000;

const cleanup: (() => unknown)[] = [];
const processes: ChildProcess[] = [];

/** Ends a stand-in this test started and waits until it is gone, so that its folders can be removed. */
async function end(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
}

afterEach(async () => {
  // The tests end what they started; the server under test never does.
  await Promise.all(processes.splice(0).map(end));
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function dir(): string {
  const t = tempDir();
  cleanup.push(t.remove);
  return t.dir;
}

const body = (outcome: Outcome) => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.error.kind}: ${outcome.error.detail}`);
  return outcome.body;
};
const error = (outcome: Outcome) => {
  if (outcome.ok) throw new Error('expected an error');
  return outcome.error;
};

/** An executable file with an opentune-control.json (or none) next to it. */
function executable(d: string, manifest: string | null = '{"protocolMajors":[1]}'): string {
  const bin = path.join(d, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'OpenTune.exe'), '');
  if (manifest !== null) writeFileSync(path.join(bin, 'opentune-control.json'), manifest);
  return path.join(bin, 'OpenTune.exe');
}

interface Spawned {
  readonly file: string;
  readonly args: string[];
  readonly options: SpawnOptions;
}

/** A spawn that records the call and starts the stand-in with the same command line and options. */
function fakeSpawn(calls: Spawned[]): SpawnFn {
  return (file, args, options) => {
    calls.push({ file, args: [...args], options });
    // The context's environment lacks the system variables Node.js itself needs on some systems.
    // windowsHide only keeps the stand-in's console window from flashing up during the tests.
    const child = spawn(process.execPath, [FAKE, ...args], {
      ...options,
      env: { ...process.env, ...options.env },
      windowsHide: true,
    });
    processes.push(child);
    return child;
  };
}

interface Setup {
  readonly ctx: TestContext;
  readonly calls: Spawned[];
  readonly discovery: string;
  readonly exe: string;
}

function setup(
  options: { mode?: string; env?: NodeJS.ProcessEnv; launch?: Partial<LaunchDeps>; manifest?: string | null } = {},
): Setup {
  const d = dir();
  const discovery = path.join(d, 'instances');
  const exe = executable(d, options.manifest);
  const calls: Spawned[] = [];
  const ctx = testContext(discovery, {
    env: { OPENTUNE_MCP_OPENTUNE_PATH: exe, OT_FAKE_MODE: options.mode ?? 'ready', ...options.env },
    launch: { spawn: fakeSpawn(calls), waitMs: 15_000, ...options.launch },
  });
  cleanup.push(() => {
    ctx.instances.close();
  });
  return { ctx, calls, discovery, exe };
}

const launchFiles = (discovery: string) => readdirSync(launchDir(discovery)).sort();

describe('opentune_launch', () => {
  it(
    'starts the configured build with the fixed command line and options and reports READY',
    async () => {
      const { ctx, calls, discovery, exe } = setup();
      const b = body(await launch(ctx, {}));
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call?.file).toBe(exe);
      expect(call?.options).toEqual({
        shell: false,
        detached: true,
        stdio: 'ignore',
        cwd: path.dirname(exe),
        env: ctx.env,
      });
      expect(call?.args).toEqual([
        '--control-api',
        `--control-api-dir=${discovery}`,
        expect.stringMatching(/^--control-api-ready-file=.+[\\/]launching[\\/][0-9a-f]{32}\.ready$/) as unknown,
        expect.stringMatching(/^--control-api-launch-nonce=[A-Za-z0-9_-]{32}$/) as unknown,
      ]);
      const pid = (b.process as { pid: number }).pid;
      expect(b).toMatchObject({
        launched: true,
        joined: false,
        alreadyRunning: false,
        workingDirectory: 'executable_folder',
        state: 'READY',
        reason: null,
        nextStep: STATUS_TEXT.READY.step,
        instances: [{ pid, state: 'READY', protocol: '1.0' }],
      });
      expect(b.summary).toBe(`Started OpenTune (pid ${String(pid)}). OpenTune is running and ready.`);
      // The nonce on the command line is the one in the discovery file; the record and the ready file are gone.
      const nonce = call?.args[3]?.split('=')[1] ?? '';
      const announced = JSON.parse(readFileSync(path.join(discovery, `${String(pid)}.json`), 'utf8')) as {
        launchNonce: string;
      };
      expect(announced.launchNonce).toBe(nonce);
      expect(launchFiles(discovery)).toEqual([]);

      const again = body(await launch(ctx, {}));
      expect(calls).toHaveLength(1);
      expect(again).toMatchObject({ launched: false, alreadyRunning: true, state: 'READY' });
      expect(again.summary).toBe('OpenTune is already running; nothing was started. OpenTune is running and ready.');
    },
    TIMEOUT,
  );

  it(
    'runs in the official installation folder and lets OpenTune find OPENTUNE_DATA_DIR on its own',
    async () => {
      const install = dir();
      const data = dir();
      const lock = path.join(data, 'control', 'instances', 'launching', 'launch.lock');
      let lockedDuringDetection: boolean | null = null;
      const { ctx, calls } = setup({
        env: { OPENTUNE_MCP_DISCOVERY_DIR: '', OPENTUNE_DATA_DIR: data },
        launch: {
          officialInstall: () => {
            lockedDuringDetection = existsSync(lock);
            return Promise.resolve({ dir: install, version: '1.8.0', source: 'registry' });
          },
        },
      });
      const b = body(await launch(ctx, {}));
      // The detection (registry queries, possibly slow) does not run while the launch lock is held.
      expect(lockedDuringDetection).toBe(false);
      expect(b).toMatchObject({ launched: true, state: 'READY', workingDirectory: 'official_install' });
      expect(calls[0]?.options.cwd).toBe(install);
      expect(calls[0]?.args.some((a) => a.startsWith('--control-api-dir='))).toBe(false);
      expect(calls[0]?.args[1]).toContain(path.join(data, 'control', 'instances', 'launching'));
    },
    TIMEOUT,
  );

  it(
    'starts once for concurrent calls',
    async () => {
      const { ctx, calls } = setup();
      const results = (await Promise.all([launch(ctx, {}), launch(ctx, {})])).map(body);
      expect(calls).toHaveLength(1);
      expect(results.map((r) => r.state)).toEqual(['READY', 'READY']);
      expect(results.filter((r) => r.launched)).toHaveLength(1);
      const other = results.find((r) => r.launched !== true);
      expect(other?.joined === true || other?.alreadyRunning === true).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'leaves a process that does not announce itself running, and a call meanwhile waits for it',
    async () => {
      const { ctx, calls, discovery } = setup({ mode: 'silent', launch: { waitMs: 1500 } });
      const results = (await Promise.all([launch(ctx, {}), launch(ctx, {})])).map(body);
      expect(calls).toHaveLength(1);
      // Either call may take the launch lock first; the other one joins its start.
      const first = results.find((r) => r.launched === true);
      const second = results.find((r) => r.launched !== true);
      const pid = (first?.process as { pid: number }).pid;
      for (const b of [first, second]) {
        expect(b).toMatchObject({
          state: 'NOT_READY',
          reason: 'launch_timeout',
          nextStep: STATUS_REASON_STEPS['NOT_READY/launch_timeout'],
          process: { pid },
        });
      }
      expect([first?.launched, second?.launched, second?.joined]).toEqual([true, false, true]);
      expect(first?.summary).toBe(
        `Started OpenTune (pid ${String(pid)}), but its control API did not become available within 2 seconds. ` +
          'The process was left running.',
      );
      expect(second?.summary).toMatch(/^Another call started OpenTune \(pid \d+\) moments ago; this call started/);
      expect(pidAlive(pid)).toBe(true);
      expect(launchFiles(discovery)).toEqual([`${String(pid)}.json`]);
      // Past the wait the silent process counts as running without the control API: no second start.
      expect(body(await getStatus(ctx, undefined))).toMatchObject({
        state: 'RUNNING_WITHOUT_API',
        processes: [{ pid }],
      });
      const later = body(await launch(ctx, {}));
      expect(later).toMatchObject({ launched: false, state: 'RUNNING_WITHOUT_API', nextStep: { actor: 'user' } });
      expect(calls).toHaveLength(1);
    },
    TIMEOUT,
  );

  it.each(['other_nonce', 'no_nonce'])(
    'does not accept an instance whose discovery file lacks the launch nonce (%s)',
    async (mode) => {
      // waitMs is long: the result must come from the announced instance, not from the timeout.
      const { ctx } = setup({ mode, launch: { waitMs: 25_000 } });
      const started = Date.now();
      const b = body(await launch(ctx, {}));
      expect(b).toMatchObject({
        launched: true,
        state: 'NOT_READY',
        reason: 'launch_unverified',
        nextStep: STATUS_REASON_STEPS['NOT_READY/launch_unverified'],
      });
      expect(b.summary).toMatch(/does not carry its launch nonce, so it is not used\.$/);
      expect(b).not.toHaveProperty('instances');
      expect(Date.now() - started).toBeLessThan(20_000);
    },
    TIMEOUT,
  );

  it(
    'reports a process that exits before it announces itself',
    async () => {
      const { ctx, discovery } = setup({ mode: 'exit' });
      const b = body(await launch(ctx, {}));
      expect(b).toMatchObject({
        launched: true,
        state: 'NOT_RUNNING',
        reason: 'launch_exited',
        nextStep: STATUS_REASON_STEPS['NOT_RUNNING/launch_exited'],
      });
      expect(launchFiles(discovery)).toEqual([]);
    },
    TIMEOUT,
  );

  it('never starts without a usable configuration', async () => {
    const d = dir();
    const cases: [NodeJS.ProcessEnv, string | null, string, string][] = [
      [{ OPENTUNE_MCP_OPENTUNE_PATH: '' }, '{"protocolMajors":[1]}', 'NOT_INSTALLED', 'path_not_configured'],
      [{ OPENTUNE_MCP_OPENTUNE_PATH: 'OpenTune.exe' }, '{"protocolMajors":[1]}', 'NOT_INSTALLED', 'not_absolute'],
      [{ OPENTUNE_MCP_OPENTUNE_PATH: path.join(d, 'nope.exe') }, '', 'NOT_INSTALLED', 'not_found'],
      [{ OPENTUNE_MCP_OPENTUNE_PATH: d }, '', 'NOT_INSTALLED', 'not_a_file'],
      [{}, null, 'NO_API_BUILD', 'manifest_missing'],
      [{}, '{"protocolMajors":[2]}', 'NO_API_BUILD', 'protocol_mismatch'],
      [{}, '[1]', 'NO_API_BUILD', 'manifest_invalid'],
      [{}, `{"protocolMajors":[1],"pad":"${'x'.repeat(9000)}"}`, 'NO_API_BUILD', 'manifest_too_large'],
    ];
    for (const [env, manifest, state, reason] of cases) {
      const { ctx, calls } = setup({ env, manifest });
      const b = body(await launch(ctx, {}));
      expect(b, reason).toMatchObject({ launched: false, joined: false, alreadyRunning: false, state, reason });
      expect(b.summary).toMatch(/^OpenTune was not started\. /);
      expect(calls).toHaveLength(0);
    }
  });

  it('does not start while an OpenTune without the control API runs, or one has just started', async () => {
    const { ctx, calls } = setup();
    ctx.probe.openTune = [777];
    ctx.probe.info.set(777, { alive: true, startTimeMs: Date.now() - 60_000 });
    const b = body(await launch(ctx, {}));
    expect(b).toMatchObject({
      launched: false,
      state: 'RUNNING_WITHOUT_API',
      processes: [{ pid: 777 }],
      nextStep: { actor: 'user', message: expect.stringContaining('opentune_launch') as unknown },
    });
    ctx.probe.info.set(777, { alive: true, startTimeMs: Date.now() - 1000 });
    expect(body(await launch(ctx, {}))).toMatchObject({ launched: false, state: 'STARTING' });
    expect(calls).toHaveLength(0);
  });

  it(
    'starts nothing when the running processes cannot be listed, until the user confirms that none runs',
    async () => {
      const { ctx, calls } = setup();
      ctx.probe.openTune = null;
      const unlisted = { processes: null, nullReasons: { processes: 'not_listable' } };
      // get_status leads the agent here; the process list it could not read is reported, not taken as empty.
      expect(body(await getStatus(ctx, undefined))).toMatchObject({
        state: 'NOT_RUNNING',
        nextStep: { actor: 'agent', tool: 'opentune_launch' },
        ...unlisted,
      });
      const refused = await launch(ctx, {});
      expect(refused).toMatchObject({
        ok: false,
        error: {
          kind: 'OPENTUNE_NOT_AVAILABLE',
          reason: 'process_list_unavailable',
          retryable: false,
          executed: false,
          nextStep: {
            actor: 'user',
            message: expect.stringMatching(/Only after the user confirms, .*allow_second_instance: true/) as unknown,
          },
          url: expect.stringMatching(/#error-opentune_not_available$/) as unknown,
        },
        context: unlisted,
      });
      expect(render(refused)).toMatchObject({ isError: true, structuredContent: unlisted });
      expect(calls).toHaveLength(0);

      // A configuration problem comes first: confirming would not help.
      const unset = setup({ env: { OPENTUNE_MCP_OPENTUNE_PATH: '' } });
      unset.ctx.probe.openTune = null;
      expect(body(await launch(unset.ctx, {}))).toMatchObject({
        launched: false,
        state: 'NOT_INSTALLED',
        reason: 'path_not_configured',
        ...unlisted,
      });

      // After the user confirmed that no OpenTune runs.
      const b = body(await launch(ctx, { allow_second_instance: true }));
      expect(calls).toHaveLength(1);
      expect(b).toMatchObject({ launched: true, state: 'READY', instances: [{ state: 'READY' }] });
    },
    TIMEOUT,
  );

  it(
    'reports a running instance as alreadyRunning and starts a second one only when allowed',
    async () => {
      const { ctx, calls, discovery } = setup();
      const mock = await startMock({ discoveryDir: discovery });
      cleanup.push(() => mock.stop());
      const running = body(await launch(ctx, {}));
      expect(running).toMatchObject({
        launched: false,
        alreadyRunning: true,
        state: 'READY',
        instances: [{ instanceId: mock.discovery.instanceId }],
      });
      expect(calls).toHaveLength(0);
      const second = body(await launch(ctx, { allow_second_instance: true }));
      expect(calls).toHaveLength(1);
      expect(second).toMatchObject({ launched: true, state: 'READY', instances: [{ state: 'READY' }] });
      const id = (second.instances as { instanceId: string }[])[0]?.instanceId ?? '';
      expect(id).not.toBe(mock.discovery.instanceId);
      expect(second.summary).toMatch(new RegExp(`2 instances run now; pass instance_id ${id} to other tools`));
    },
    TIMEOUT,
  );

  it('accepts no path, argument or environment in its input', async () => {
    const { ctx, calls } = setup();
    expect(launchTool.inputSchema.safeParse({}).success).toBe(true);
    expect(launchTool.inputSchema.safeParse({ allow_second_instance: true }).success).toBe(true);
    const { client, close } = mcpClient(ctx);
    cleanup.push(close);
    await client.request(1, 'initialize', INITIALIZE);
    client.notify('notifications/initialized');
    let id = 2;
    for (const args of [
      { path: 'C:\\Tools\\other.exe' },
      { allow_second_instance: true, args: ['--control-api-dir=C:\\elsewhere'] },
      { env: { OPENTUNE_DATA_DIR: 'C:\\elsewhere' } },
      { allow_second_instance: 'yes' },
    ]) {
      const response = await client.request(id++, 'tools/call', { name: 'opentune_launch', arguments: args });
      expect(response.result, JSON.stringify(args)).toMatchObject({ isError: true });
    }
    expect(calls).toHaveLength(0);
  });

  it('reports an executable that cannot be started, and leaves no record', async () => {
    const d = dir();
    const missing = path.join(d, 'gone.exe');
    const { ctx, discovery } = setup({
      launch: { spawn: (_file, args, options) => spawn(missing, [...args], options) },
    });
    const e = error(await launch(ctx, {}));
    expect(e).toMatchObject({
      kind: 'CONFIG_INVALID',
      reason: 'launch_failed',
      executed: false,
      nextStep: { actor: 'user' },
      detail: 'the executable in OPENTUNE_MCP_OPENTUNE_PATH could not be started (ENOENT)',
    });
    expect(launchFiles(discovery)).toEqual([]);
    const thrown = setup({
      launch: {
        spawn: () => {
          throw Object.assign(new Error('bad'), { code: 'EINVAL' });
        },
      },
    });
    expect(error(await launch(thrown.ctx, {})).detail).toMatch(/\(EINVAL\)$/);
  });

  it('reports WSL and an unusable discovery directory before doing anything', async () => {
    const { ctx, calls } = setup();
    const wsl = { ...ctx, platform: 'linux' as const, env: { ...ctx.env, WSL_DISTRO_NAME: 'Ubuntu' } };
    expect(body(await launch(wsl, {}))).toMatchObject({ launched: false, state: 'WSL_UNSUPPORTED_RUNTIME' });
    const relative = testContext('relative', { launch: ctx.launch });
    expect(error(await launch(relative, {}))).toMatchObject({ kind: 'CONFIG_INVALID', reason: 'discovery_dir' });
    const file = path.join(dir(), 'file');
    writeFileSync(file, '');
    const blocked = testContext(file, { launch: ctx.launch });
    expect(error(await launch(blocked, {}))).toMatchObject({
      kind: 'CONFIG_INVALID',
      reason: 'discovery_dir',
      detail: expect.stringMatching(/^the launching directory in the discovery directory cannot be used/) as unknown,
    });
    expect(calls).toHaveLength(0);
  });
});

describe('launch records', () => {
  const hash = nonceHash('n'.repeat(32));

  it('make get_status report STARTING while the started process runs within the launch wait', async () => {
    const discovery = path.join(dir(), 'instances');
    const ctx = testContext(discovery, { launch: { waitMs: 60_000 } });
    cleanup.push(() => {
      ctx.instances.close();
    });
    await writeRecord(launchDir(discovery), { pid: 4242, startedAtMs: Date.now() - 1000, nonceHash: hash });
    const b = body(await getStatus(ctx, undefined));
    expect(b).toMatchObject({ state: 'STARTING', reason: 'launch_pending', processes: [{ pid: 4242 }] });
    expect(b.nextStep).toEqual(STATUS_TEXT.STARTING.step);
    ctx.probe.info.set(4242, { alive: false, startTimeMs: null });
    expect(body(await getStatus(ctx, undefined))).toMatchObject({ state: 'NOT_INSTALLED' });
    // get_status only reads; the record of the ended process is still there.
    expect(await readRecords(launchDir(discovery))).toHaveLength(1);
  });

  it('end when the process is gone or its pid was reused, and skip invalid files', async () => {
    const d = launchDir(dir());
    const now = Date.now();
    await writeRecord(d, { pid: 1, startedAtMs: now, nonceHash: hash });
    await writeRecord(d, { pid: 2, startedAtMs: now - 5000, nonceHash: hash });
    await writeRecord(d, { pid: 3, startedAtMs: now - 60_000, nonceHash: hash });
    await writeRecord(d, { pid: 4, startedAtMs: now, nonceHash: hash });
    writeFileSync(path.join(d, '5.json'), '{"pid":6,"startedAtMs":1,"nonceHash":"x"}');
    writeFileSync(path.join(d, '7.json'), 'not json');
    const probe = fakeProbe();
    probe.info.set(2, { alive: false, startTimeMs: null });
    probe.info.set(4, { alive: true, startTimeMs: now - 120_000 });
    const live = await liveRecords(d, { probe, now, waitMs: 30_000, cleanup: true });
    expect(live.map((r) => [r.record.pid, r.state])).toEqual([
      [1, 'pending'],
      [3, 'stuck'],
    ]);
    expect(readdirSync(d).sort()).toEqual(['1.json', '3.json', '5.json', '7.json']);
  });

  it('read ready files by their known members only', async () => {
    const d = dir();
    const file = path.join(d, 'r.ready');
    expect(await readReadyFile(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ pid: 12, instanceId: 'a'.repeat(32), later: true }));
    expect(await readReadyFile(file)).toEqual({ pid: 12, instanceId: 'a'.repeat(32) });
    for (const content of ['[]', '{"pid":0,"instanceId":"x"}', 'nope', `{"pad":"${'x'.repeat(9000)}"}`]) {
      writeFileSync(file, content);
      expect(await readReadyFile(file), content).toBeNull();
    }
  });

  it('take the lock in turn and remove a lock left behind', async () => {
    const d = launchDir(dir());
    const release = await acquireLock(d, 10);
    let second = false;
    const waiting = acquireLock(d, 10).then((r) => {
      second = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(second).toBe(false);
    await release();
    await (
      await waiting
    )();
    const lock = path.join(d, 'launch.lock');
    writeFileSync(lock, '');
    const old = (Date.now() - 2 * LOCK_STALE_MS) / 1000;
    utimesSync(lock, old, old);
    await (
      await acquireLock(d, 10)
    )();
    expect(readdirSync(d)).toEqual([]);
  });

  /** A lock file in a new launching directory, left behind long ago or just created. */
  function lockFile(stale: boolean): { d: string; lock: string } {
    const d = launchDir(dir());
    mkdirSync(d, { recursive: true });
    const lock = path.join(d, 'launch.lock');
    writeFileSync(lock, 'held');
    if (stale) {
      const old = (Date.now() - 2 * LOCK_STALE_MS) / 1000;
      utimesSync(lock, old, old);
    }
    return { d, lock };
  }

  it('remove only a lock left behind, and put back a lock that has replaced it', async () => {
    const fresh = lockFile(false);
    expect(await removeStaleLock(fresh.lock)).toBe(false);
    expect(readdirSync(fresh.d)).toEqual(['launch.lock']);
    expect(readFileSync(fresh.lock, 'utf8')).toBe('held');
    const stale = lockFile(true);
    expect(await removeStaleLock(stale.lock)).toBe(true);
    expect(readdirSync(stale.d)).toEqual([]);
    expect(await removeStaleLock(stale.lock)).toBe(false);
  });

  it('let only one of two calls that saw the same lock left behind take the lock', async () => {
    const { d, lock } = lockFile(true);
    // The late call reads the age of the old lock, then pauses until the other call has replaced it
    // with its own lock; it then acts on what it saw, as a slower process would.
    let seen!: () => void;
    const lateHasSeen = new Promise<void>((resolve) => {
      seen = resolve;
    });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let first = true;
    const late = acquireLock(d, 10, {
      modified: async (file) => {
        const mtimeMs = await LOCK_FILES.modified(file);
        if (first && file === lock) {
          first = false;
          seen();
          await paused;
        }
        return mtimeMs;
      },
    });
    let lateHolds = false;
    void late.then(() => {
      lateHolds = true;
    });
    await lateHasSeen;
    const releaseEarly = await acquireLock(d, 10);
    resume();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lateHolds).toBe(false);
    expect(readdirSync(d)).toEqual(['launch.lock']);
    await releaseEarly();
    await (
      await late
    )();
    expect(lateHolds).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('wait out a brief refusal to create the lock file, but not a lasting one', async () => {
    const d = launchDir(dir());
    const fail = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));
    let attempts = 0;
    const release = await acquireLock(d, 10, {
      create: (file) => {
        attempts += 1;
        // Windows: the name of a lock file another call has just deleted cannot be reused at once.
        if (attempts <= 3) return fail('EPERM');
        writeFileSync(file, '', { flag: 'wx' });
        return Promise.resolve();
      },
    });
    expect(attempts).toBe(4);
    await release();
    const started = Date.now();
    await expect(acquireLock(d, 50, { create: () => fail('EACCES') })).rejects.toMatchObject({ code: 'EACCES' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(LOCK_DENIED_MS);
    await expect(acquireLock(d, 10, { create: () => fail('ENOSPC') })).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(readdirSync(d)).toEqual([]);
  });
});

describe('starting a process', () => {
  it('strips trailing separators from the discovery directory option', () => {
    const request = { exe: 'x', cwd: 'y', env: {}, readyFile: 'r', nonce: 'n' };
    for (const [given, passed] of [
      ['C:\\Data\\instances\\', 'C:\\Data\\instances'],
      ['/data/instances//', '/data/instances'],
      ['C:\\', 'C:\\'],
      ['/', '/'],
    ] as const) {
      expect(launchArgs({ ...request, discoveryDir: given })[1]).toBe(`--control-api-dir=${passed}`);
    }
    expect(launchArgs({ ...request, discoveryDir: null })).toEqual([
      '--control-api',
      '--control-api-ready-file=r',
      '--control-api-launch-nonce=n',
    ]);
  });

  it('turns an error without a code into UNKNOWN', async () => {
    const started = await startProcess(
      () => {
        throw new Error('no code');
      },
      { exe: 'x', cwd: 'y', env: {}, readyFile: 'r', nonce: 'n', discoveryDir: null },
    );
    expect(started).toEqual({ ok: false, code: 'UNKNOWN' });
  });
});

describe('opentune-control.json', () => {
  it('is read by protocolMajors only', () => {
    const check = (text: string) => manifestProblem(Buffer.from(text));
    expect(manifestProblem(null)).toBe('manifest_missing');
    expect(check('{"protocolMajors":[1,2],"other":{"x":1}}')).toBeNull();
    expect(check('{"protocolMajors":[2]}')).toBe('protocol_mismatch');
    for (const text of [
      '',
      'null',
      '[1]',
      '{"protocolMajors":1}',
      '{"protocolMajors":["1"]}',
      '{"protocolMajors":[0]}',
    ])
      expect(check(text), text).toBe('manifest_invalid');
    expect(manifestProblem(Buffer.from([0xef, 0xbb, 0x7b, 0xff]))).toBe('manifest_invalid');
    expect(check(`{"protocolMajors":[1],"pad":"${'x'.repeat(8200)}"}`)).toBe('manifest_too_large');
  });
});

describe('official installation', () => {
  const KEY = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{0A1B}_is1';
  const OTHER = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other';
  const search = [
    '',
    OTHER,
    '    DisplayName    REG_SZ    OpenTuneless Helper',
    '',
    KEY,
    '    DisplayName    REG_SZ    OpenTune version 1.8.0',
    '',
    'End of search: 2 match(es) found.',
  ].join('\r\n');
  const full = (location: string) =>
    [
      '',
      KEY,
      '    Inno Setup: App Path    REG_SZ    C:\\Program Files\\OpenTune',
      `    InstallLocation    REG_SZ    ${location}`,
      '    DisplayName    REG_SZ    OpenTune version 1.8.0',
      '    DisplayVersion    REG_SZ    1.8.0',
      '    NoModify    REG_DWORD    0x1',
      '    Empty    REG_SZ',
      '',
    ].join('\r\n');

  function deps(runs: Record<string, ToolRun>, files: string[], env: NodeJS.ProcessEnv = {}) {
    const asked: string[][] = [];
    return {
      asked,
      deps: {
        env,
        platform: 'win32' as const,
        run: (file: string, args: readonly string[]) => {
          asked.push([file, ...args]);
          return Promise.resolve(runs[args.join(' ')] ?? { ok: false as const, exitCode: 1 });
        },
        isFile: (file: string) => Promise.resolve(files.includes(file)),
      },
    };
  }

  it('parses reg query output', () => {
    const keys = parseRegQuery(full('"C:\\Program Files\\OpenTune\\"'));
    expect([...keys.keys()]).toEqual([KEY]);
    expect(keys.get(KEY)?.get('inno setup: app path')).toBe('C:\\Program Files\\OpenTune');
    expect(keys.get(KEY)?.get('empty')).toBe('');
  });

  it('accepts only folders below a drive letter', () => {
    expect(installDir('"C:\\Program Files\\OpenTune\\"')).toBe('C:\\Program Files\\OpenTune');
    expect(installDir('D:/Apps/OpenTune/')).toBe('D:\\Apps\\OpenTune');
    for (const bad of [undefined, '', 'C:\\', 'C:', 'relative', '\\\\server\\share\\OpenTune', '\\\\?\\C:\\x'])
      expect(installDir(bad), bad).toBeNull();
  });

  it('finds the installation through its uninstall entry, read-only', async () => {
    const root = 'query HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s /f OpenTune /d';
    const { asked, deps: d } = deps(
      { [root]: { ok: true, output: search }, [`query ${KEY}`]: { ok: true, output: full('C:\\Apps\\OpenTune\\') } },
      ['C:\\Apps\\OpenTune\\OpenTune.exe'],
      { SystemRoot: 'C:\\Windows' },
    );
    expect(await detectOfficialInstall(d)).toEqual({ dir: 'C:\\Apps\\OpenTune', version: '1.8.0', source: 'registry' });
    expect(asked).toEqual([
      ['C:\\Windows\\System32\\reg.exe', ...root.split(' ').slice(0, 2), ...root.split(' ').slice(2)],
      ['C:\\Windows\\System32\\reg.exe', 'query', KEY],
    ]);
    for (const args of asked) expect(args[1]).toBe('query');
  });

  it('falls back to the app path, then to the usual folders, and finds nothing elsewhere', async () => {
    const root = 'query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s /f OpenTune /d';
    const noLocation = full('').replace('1.8.0\r\n    NoModify', 'not a version!\r\n    NoModify');
    const viaAppPath = deps(
      { [root]: { ok: true, output: search }, [`query ${KEY}`]: { ok: true, output: noLocation } },
      ['C:\\Program Files\\OpenTune\\OpenTune.exe'],
    );
    expect(await detectOfficialInstall(viaAppPath.deps)).toEqual({
      dir: 'C:\\Program Files\\OpenTune',
      version: null,
      source: 'registry',
    });
    const folders = deps(
      { [root]: { ok: true, output: search } },
      ['D:\\Profiles\\AppData\\Local\\Programs\\OpenTune\\OpenTune.exe'],
      { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'D:\\Profiles\\AppData\\Local' },
    );
    expect(await detectOfficialInstall(folders.deps)).toEqual({
      dir: 'D:\\Profiles\\AppData\\Local\\Programs\\OpenTune',
      version: null,
      source: 'folder',
    });
    expect(await detectOfficialInstall(deps({}, [], { ProgramFiles: 'C:\\Program Files' }).deps)).toBeNull();
    expect(await detectOfficialInstall({ ...deps({}, []).deps, platform: 'linux' })).toBeNull();
    expect(await systemInstallDetector({}, 'darwin')()).toBeNull();
  });
});
