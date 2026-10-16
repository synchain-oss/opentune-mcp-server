// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The exe target against a stand-in executable (test/support/fake-opentune.mjs), started with the
// Node binary: normal start and stop, a launcher that hands over to another process, and each way
// the start-up and the end can go wrong.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { pidAlive, systemProbe } from '../../src/discovery/process.js';
import { exeConfigFromEnv, exeTarget, isRunnerPath } from '../contract/exe-target.js';
import { runExeVector } from '../contract/exe-vectors.js';
import { mockTarget } from '../contract/mock-target.js';
import { PreconditionUnavailable } from '../contract/target.js';
import { loadVectors, type Vector } from '../contract/vectors.js';

const FAKE = fileURLToPath(new URL('../support/fake-opentune.mjs', import.meta.url));
const SLOW = 30_000;
// Each start-time reading may take a few attempts of a system tool on a busy machine.
const LAUNCHER = 90_000;
const WINDOWS = process.platform === 'win32';

const fake = (mode: string, timeoutMs = 10_000, extra: string[] = []) =>
  exeTarget({ exe: process.execPath, args: [FAKE, `--mode=${mode}`, ...extra], timeoutMs });

async function waitFor(condition: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

/** A file a stand-in writes how it ended to; ended by force, it writes nothing. */
const markers: string[] = [];
async function markerFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ot-exe-test-'));
  markers.push(dir);
  return path.join(dir, 'ended');
}
afterEach(async () => {
  for (const dir of markers.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A vector the stand-in does not report the capability of, so the vector itself is a SKIP. */
const skippedVector = () => {
  const entry = loadVectors().find((e) => e.problems.length === 0 && e.vector.capability !== 'session.v1');
  if (entry === undefined) throw new Error('no vector outside session.v1');
  return entry.vector;
};

describe('exe target', () => {
  it(
    'starts the executable, reads its discovery file, learns the capabilities and stops it',
    async () => {
      const target = fake('ok');
      const instance = await target.open();
      expect(instance.protocol).toBe('1.0');
      expect(instance.capabilities).toEqual(['session.v1']);
      expect(typeof instance.discovery.launchNonce).toBe('string');
      expect(await instance.establish({})).toEqual({});
      await expect(instance.establish({ track: 1 })).rejects.toBeInstanceOf(PreconditionUnavailable);
      expect(instance.runnerValue('runner.anything')).toBeUndefined();
      await instance.close();
      // Windows has no normal stop request, so there the end is forced and clean-up is not verified.
      expect(target.stats).toMatchObject(WINDOWS ? { verified: 0, forced: 1 } : { verified: 1, forced: 0 });
      expect(target.takeProblems()).toEqual([]);
    },
    SLOW,
  );

  it(
    'ends the process a launcher handed over to, once it is confirmed as started by this launch',
    async () => {
      const target = fake('launcher');
      const instance = await target.open();
      const pid = instance.discovery.pid as number;
      expect(pidAlive(pid)).toBe(true);
      await instance.close();
      expect(pidAlive(pid)).toBe(false);
      expect(target.takeProblems()).toEqual([]);
      expect(target.stats).toMatchObject(WINDOWS ? { verified: 0, forced: 1 } : { verified: 1, forced: 0 });
    },
    LAUNCHER,
  );

  it(
    'never ends a process the ready file names but it cannot confirm, and says so',
    async () => {
      const marker = await markerFile();
      const target = fake('launcher-bad-start', 10_000, [`--marker=${marker}`]);
      await expect(target.open()).rejects.toThrow(
        /could not be confirmed as started by this target .*it was not ended/,
      );
      expect(target.stats.notEnded).toBe(1);
      // It ends by itself once its data folder is gone and records that; ended by force it could not.
      expect(await waitFor(() => existsSync(marker))).toBe(true);
      expect(readFileSync(marker, 'utf8')).toBe('watchdog');
    },
    LAUNCHER,
  );

  it(
    'does not end the instance at close when it can no longer confirm it, and says so',
    async () => {
      const marker = await markerFile();
      let closing = false;
      const target = exeTarget({
        exe: process.execPath,
        args: [FAKE, '--mode=launcher', `--marker=${marker}`],
        timeoutMs: 10_000,
        // The real answers at the start; at close the start time is unknown.
        probe: (pid) => (closing ? Promise.resolve({ alive: true, startTimeMs: null }) : systemProbe().probe(pid)),
      });
      const instance = await target.open();
      closing = true;
      await instance.close();
      expect(target.takeProblems()).toEqual([expect.stringMatching(/start time could not be read again.*not ended/)]);
      expect(target.stats.notEnded).toBe(1);
      expect(await waitFor(() => existsSync(marker))).toBe(true);
      expect(readFileSync(marker, 'utf8')).toBe('watchdog');
    },
    LAUNCHER,
  );

  it(
    'reports an instance that ended by itself before close, with its exit code',
    async () => {
      const target = fake('exit-after-hello');
      const instance = await target.open();
      expect(await waitFor(() => pidAlive(instance.discovery.pid as number) === false)).toBe(true);
      await instance.close();
      expect(target.stats).toMatchObject({ exitedEarly: 1, verified: 0, forced: 0 });
      expect(target.takeProblems()).toEqual([
        expect.stringContaining('ended by itself before the vector was over (exit code 5)'),
      ]);
    },
    SLOW,
  );

  it(
    'fails when no ready file appears in time',
    async () => {
      await expect(fake('no-ready', 500).open()).rejects.toThrow('no ready file within 500 ms');
    },
    SLOW,
  );

  it(
    'fails when the launch nonce is not the one passed',
    async () => {
      await expect(fake('bad-nonce').open()).rejects.toThrow('launch nonce');
    },
    SLOW,
  );

  it(
    'fails when the discovery file names another pid than the ready file',
    async () => {
      await expect(fake('pid-mismatch').open()).rejects.toThrow('another pid');
    },
    SLOW,
  );

  it(
    'fails when the hello answer carries another serverProof, naming it once',
    async () => {
      const error = await fake('bad-proof')
        .open()
        .then(
          () => undefined,
          (e: unknown) => e as Error,
        );
      expect(error?.message).toBe('the session.hello result differs from the discovery file in serverProof');
    },
    SLOW,
  );

  it(
    'fails at once when the process ends first, with the stderr tail but not the secrets in it',
    async () => {
      const started = Date.now();
      const error = await fake('early-exit', 15_000)
        .open()
        .then(
          () => undefined,
          (e: unknown) => e as Error,
        );
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(error?.message).toContain('exit code 3');
      expect(error?.message).toContain('start-up failed');
      expect(error?.message).not.toMatch(/[0-9a-f]{32}/);
      // The launch nonce is base64url, which the hex pattern does not catch.
      expect(error?.message).toContain('nonce [redacted]');
    },
    SLOW,
  );

  it.skipIf(WINDOWS)(
    'records, without throwing, an instance that exits normally but leaves its discovery file',
    async () => {
      const target = fake('no-cleanup');
      const instance = await target.open();
      await instance.close();
      expect(target.stats).toMatchObject({ leftDiscoveryFile: 1, verified: 0 });
      expect(target.takeProblems()).toEqual([expect.stringContaining('left its discovery file behind')]);
    },
    SLOW,
  );

  it.skipIf(WINDOWS)(
    'makes the vector FAIL, through runVector, when the instance leaves its discovery file',
    async () => {
      const vector = skippedVector();
      const outcome = await runExeVector(vector, fake('no-cleanup'));
      expect(outcome).toMatchObject({ id: vector.id, result: 'FAIL' });
      expect(outcome.note).toMatch(/left its discovery file behind \(the vector itself: SKIP: /);
    },
    SLOW,
  );

  it('refuses an executable that is not an absolute path to an existing file', () => {
    expect(() => exeTarget({ exe: 'opentune.exe' })).toThrow('absolute path');
    expect(() => exeTarget({ exe: FAKE.replace('fake-opentune.mjs', 'missing.exe') })).toThrow('regular file');
    expect(() => exeTarget({ exe: fileURLToPath(new URL('.', import.meta.url)) })).toThrow('regular file');
  });
});

describe('OTCP_TARGET_DATA_DIR (kept data folders)', () => {
  const parents: string[] = [];
  async function parentDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ot-exe-keep-'));
    parents.push(dir);
    return dir;
  }
  afterEach(async () => {
    for (const dir of parents.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const keeping = (parent: string, extra: string[] = []) =>
    exeTarget({ exe: process.execPath, args: [FAKE, '--mode=ok', ...extra], timeoutMs: 10_000, dataDirParent: parent });

  it(
    'keeps one folder per launch under the given folder, with its logs, and removes only the discovery files',
    async () => {
      const parent = await parentDir();
      const target = keeping(parent);
      target.labelNext('import/start-path-not-absolute');
      const first = await target.open();
      await first.close();
      target.labelNext('import/start-path-not-absolute');
      const second = await target.open();
      await second.close();
      const names = target.takeDataDirs();
      expect(names).toHaveLength(2);
      expect(names[0]).not.toBe(names[1]);
      for (const name of names) {
        expect(name).toMatch(/^import-start-path-not-absolute-[A-Za-z0-9]{6}$/);
        expect(readFileSync(path.join(parent, name, 'logs', 'opentune.log'), 'utf8')).toBe('started\n');
        expect(existsSync(path.join(parent, name, 'control', 'instances'))).toBe(false);
      }
      expect(readdirSync(parent).sort()).toEqual([...names].sort());
      expect(target.takeDataDirs()).toEqual([]);
      expect(target.takeProblems()).toEqual([]);
    },
    SLOW,
  );

  it(
    'keeps the folder of a launch that failed, too',
    async () => {
      const parent = await parentDir();
      const target = exeTarget({
        exe: process.execPath,
        args: [FAKE, '--mode=bad-nonce'],
        timeoutMs: 10_000,
        dataDirParent: parent,
      });
      target.labelNext('smoke');
      await expect(target.open()).rejects.toThrow('launch nonce');
      expect(readdirSync(parent)).toHaveLength(1);
      expect(target.takeDataDirs()).toEqual(readdirSync(parent));
    },
    SLOW,
  );

  it(
    'still deletes a temporary folder when the variable is not set',
    async () => {
      const parent = await parentDir();
      const dirFile = path.join(parent, 'data-dir.txt');
      const target = fake('ok', 10_000, [`--dirfile=${dirFile}`]);
      const instance = await target.open();
      const dataDir = readFileSync(dirFile, 'utf8');
      expect(path.dirname(dataDir)).toBe(os.tmpdir());
      expect(existsSync(dataDir)).toBe(true);
      await instance.close();
      expect(existsSync(dataDir)).toBe(false);
      expect(target.takeDataDirs()).toEqual([]);
    },
    SLOW,
  );

  it('is a configuration error, not a skip, when the folder is relative or does not exist', async () => {
    const parent = await parentDir();
    const env = { OTCP_TARGET_EXE: FAKE };
    expect(exeConfigFromEnv({ ...env, OTCP_TARGET_DATA_DIR: parent })).toEqual({
      options: { exe: FAKE, dataDirParent: parent },
    });
    expect(exeConfigFromEnv({ ...env, OTCP_TARGET_DATA_DIR: '' })).toEqual({ options: { exe: FAKE } });
    expect(() => exeConfigFromEnv({ ...env, OTCP_TARGET_DATA_DIR: 'relative/dir' })).toThrow('absolute path');
    expect(() => exeConfigFromEnv({ ...env, OTCP_TARGET_DATA_DIR: path.join(parent, 'missing') })).toThrow(
      'existing directory',
    );
    // A file is not a directory.
    expect(() => exeConfigFromEnv({ ...env, OTCP_TARGET_DATA_DIR: FAKE })).toThrow('existing directory');
    expect(() => exeTarget({ exe: process.execPath, dataDirParent: 'relative' })).toThrow('absolute path');
    // Without the executable the checks are skipped, as before.
    expect(exeConfigFromEnv({ OTCP_TARGET_DATA_DIR: 'relative' })).toEqual({ skip: 'OTCP_TARGET_EXE is not set' });
  });

  it(
    'runExeVector reports the folder of the launch, named after the vector',
    async () => {
      const parent = await parentDir();
      const target = keeping(parent);
      const vector = skippedVector();
      const outcome = await runExeVector(vector, target);
      expect(outcome.dataDir).toBeDefined();
      expect(existsSync(path.join(parent, outcome.dataDir ?? ''))).toBe(true);
      expect(outcome.dataDir?.startsWith(vector.id.replace(/[^A-Za-z0-9._-]+/g, '-'))).toBe(true);
    },
    SLOW,
  );
});

describe('OTCP_TARGET_DATA_TEMPLATE (a known starting state)', () => {
  const dirs: string[] = [];
  async function scratch(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ot-exe-tpl-'));
    dirs.push(dir);
    return dir;
  }
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  /** A template with a file at the top, one in a sub-folder and an empty sub-folder. */
  async function template(): Promise<string> {
    const dir = await scratch();
    await writeFile(path.join(dir, 'state.txt'), 'known\n');
    await mkdir(path.join(dir, 'nested', 'deeper'), { recursive: true });
    await writeFile(path.join(dir, 'nested', 'deeper', 'inner.txt'), 'inner');
    await mkdir(path.join(dir, 'empty'));
    return dir;
  }
  const withTemplate = (snapshot: string, dataTemplate: string | undefined, dataDirParent?: string) =>
    exeTarget({
      exe: process.execPath,
      args: [FAKE, '--mode=ok', `--snapshot=${snapshot}`],
      timeoutMs: 10_000,
      ...(dataTemplate !== undefined && { dataTemplate }),
      ...(dataDirParent !== undefined && { dataDirParent }),
    });
  const held = (snapshot: string) => JSON.parse(readFileSync(snapshot, 'utf8')) as Record<string, string>;

  it(
    'copies the contents of the folder into the data folder of each launch, and two launches do not affect each other',
    async () => {
      const tpl = await template();
      const out = await scratch();
      const snapshot = path.join(out, 'snapshot.json');
      const target = withTemplate(snapshot, tpl);
      const expected = { 'state.txt': 'known\n', 'nested/deeper/inner.txt': 'inner' };
      const first = await target.open();
      expect(held(snapshot)).toEqual(expected);
      await first.close();
      await rm(snapshot);
      const second = await target.open();
      expect(held(snapshot)).toEqual(expected);
      await second.close();
      // The template itself is left as it was.
      expect(readFileSync(path.join(tpl, 'state.txt'), 'utf8')).toBe('known\n');
      expect(target.takeProblems()).toEqual([]);
    },
    SLOW,
  );

  it(
    'a launch that changes its copy does not change the template or the next launch',
    async () => {
      const tpl = await template();
      const parent = await scratch();
      const snapshot = path.join(await scratch(), 'snapshot.json');
      const target = withTemplate(snapshot, tpl, parent);
      const first = await target.open();
      const [firstDir] = target.takeDataDirs();
      await writeFile(path.join(parent, firstDir ?? '', 'state.txt'), 'changed');
      await first.close();
      await rm(snapshot);
      const second = await target.open();
      expect(held(snapshot)['state.txt']).toBe('known\n');
      await second.close();
      expect(readFileSync(path.join(tpl, 'state.txt'), 'utf8')).toBe('known\n');
      // The copy is in the kept folder, next to the logs of the launch.
      expect(readFileSync(path.join(parent, firstDir ?? '', 'nested', 'deeper', 'inner.txt'), 'utf8')).toBe('inner');
    },
    SLOW,
  );

  it(
    'does not copy the ready file or the discovery folder of the template, and says so in the stats',
    async () => {
      const tpl = await template();
      await writeFile(path.join(tpl, 'ready.json'), '{"pid":1}\n');
      await mkdir(path.join(tpl, 'control', 'instances'), { recursive: true });
      await writeFile(path.join(tpl, 'control', 'instances', '1.json'), '{}');
      await writeFile(path.join(tpl, 'control', 'keep.txt'), 'kept');
      const snapshot = path.join(await scratch(), 'snapshot.json');
      const target = withTemplate(snapshot, tpl);
      const instance = await target.open();
      expect(held(snapshot)).toEqual({
        'state.txt': 'known\n',
        'nested/deeper/inner.txt': 'inner',
        'control/keep.txt': 'kept',
      });
      await instance.close();
      expect(target.stats.templateSkipped).toBe(1);
      expect(target.takeProblems()).toEqual([]);
      // The template itself is left as it was.
      expect(existsSync(path.join(tpl, 'ready.json'))).toBe(true);
      expect(existsSync(path.join(tpl, 'control', 'instances', '1.json'))).toBe(true);
    },
    SLOW,
  );

  it('matches the ready file and the discovery folder without regard to case on Windows and macOS only', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      expect(isRunnerPath(['READY.JSON'], platform)).toBe(true);
      expect(isRunnerPath(['Control', 'Instances'], platform)).toBe(true);
    }
    expect(isRunnerPath(['READY.JSON'], 'linux')).toBe(false);
    expect(isRunnerPath(['Control', 'Instances'], 'linux')).toBe(false);
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(isRunnerPath(['ready.json'], platform)).toBe(true);
      expect(isRunnerPath(['control', 'instances'], platform)).toBe(true);
      // Only at the top of the data folder, and only these two.
      expect(isRunnerPath(['nested', 'ready.json'], platform)).toBe(false);
      expect(isRunnerPath(['control'], platform)).toBe(false);
      expect(isRunnerPath(['control', 'instances', '1.json'], platform)).toBe(false);
      expect(isRunnerPath(['control', 'keep.txt'], platform)).toBe(false);
    }
  });

  it(
    'copies nothing when the variable is not set',
    async () => {
      const snapshot = path.join(await scratch(), 'snapshot.json');
      const instance = await withTemplate(snapshot, undefined).open();
      expect(held(snapshot)).toEqual({});
      await instance.close();
    },
    SLOW,
  );

  it(
    'does not follow a symbolic link',
    async () => {
      const tpl = await template();
      const outside = await scratch();
      await writeFile(path.join(outside, 'secret.txt'), 'outside');
      // A junction needs no special right on Windows; a link to a file may not be allowed there.
      await symlink(outside, path.join(tpl, 'link-to-folder'), 'junction');
      try {
        await symlink(path.join(outside, 'secret.txt'), path.join(tpl, 'link-to-file'), 'file');
      } catch {
        // checked with the folder link alone
      }
      const snapshot = path.join(await scratch(), 'snapshot.json');
      const instance = await withTemplate(snapshot, tpl).open();
      expect(Object.keys(held(snapshot)).sort()).toEqual(['nested/deeper/inner.txt', 'state.txt']);
      await instance.close();
    },
    SLOW,
  );

  it('is a configuration error, not a skip, when the folder is relative, missing or not a folder', async () => {
    const tpl = await template();
    const env = { OTCP_TARGET_EXE: FAKE };
    expect(exeConfigFromEnv({ ...env, OTCP_TARGET_DATA_TEMPLATE: tpl })).toEqual({
      options: { exe: FAKE, dataTemplate: tpl },
    });
    expect(exeConfigFromEnv({ ...env, OTCP_TARGET_DATA_TEMPLATE: '' })).toEqual({ options: { exe: FAKE } });
    expect(() => exeConfigFromEnv({ ...env, OTCP_TARGET_DATA_TEMPLATE: 'relative/dir' })).toThrow('absolute path');
    expect(() => exeConfigFromEnv({ ...env, OTCP_TARGET_DATA_TEMPLATE: path.join(tpl, 'missing') })).toThrow(
      'existing directory',
    );
    expect(() => exeConfigFromEnv({ ...env, OTCP_TARGET_DATA_TEMPLATE: FAKE })).toThrow('existing directory');
    expect(() => exeTarget({ exe: process.execPath, dataTemplate: 'relative' })).toThrow('absolute path');
    expect(() => exeTarget({ exe: process.execPath, dataTemplate: path.join(tpl, 'missing') })).toThrow(
      'existing directory',
    );
  });
});

describe('runExeVector and BUSY modal_open', () => {
  /** A vector that asks for a write and expects it to succeed, with the given dialogs open. */
  const writeVector = (id: string, given: Vector['given']): Vector => ({
    id,
    type: 'request',
    description: 'test',
    capability: 'ui.bridge',
    since: '1.0',
    method: 'ui.setSelection',
    session: 'authenticated',
    ...(given !== undefined && { given }),
    request: { jsonrpc: '2.0', id: 1, method: 'ui.setSelection', params: { trackId: 1 } },
    response: { jsonrpc: '2.0', id: 1, result: {} },
  });
  const noProblems = () => [];

  it('adds the modal-dialog note when the instance sent BUSY modal_open', async () => {
    const vector = writeVector('test/modal-received', {
      dialogs: [{ kind: 'trackColour', trackId: 0, colour: '#FF8800' }],
    });
    const outcome = await runExeVector(vector, { ...mockTarget(), takeProblems: noProblems });
    expect(outcome.result).toBe('FAIL');
    expect(outcome.note).toContain('(the instance has a modal dialog open)');
  });

  it('does not add it when the step itself expects BUSY modal_open, even if the vector fails for another reason', async () => {
    const vector: Vector = {
      ...writeVector('test/modal-expected-and-received', {
        dialogs: [{ kind: 'trackColour', trackId: 0, colour: '#FF8800' }],
      }),
      // The instance does answer BUSY modal_open; the wrong code makes the vector fail anyway.
      response: {
        jsonrpc: '2.0',
        id: 1,
        error: { code: 1, message: 'BUSY', data: { kind: 'BUSY', reason: 'modal_open' } },
      },
    };
    const outcome = await runExeVector(vector, { ...mockTarget(), takeProblems: noProblems });
    expect(outcome.result).toBe('FAIL');
    expect(outcome.receivedModalOpen).toBeUndefined();
    expect(outcome.note).not.toContain('modal dialog open');
  });

  it(
    'does not add it when only the expectation of a vector says modal_open',
    async () => {
      // Nothing is open, so the instance answers normally; the vector then waits for a BUSY modal_open
      // line that never comes, and its note quotes what it expected.
      const busy = {
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32010, message: 'BUSY', data: { kind: 'BUSY', reason: 'modal_open' } },
      };
      const call = (id: number) => ({
        jsonrpc: '2.0',
        id,
        method: 'ui.setSelection',
        params: { trackId: 1 },
      });
      const vector: Vector = {
        ...writeVector('test/modal-expected', undefined),
        type: 'scenario',
        steps: [{ send: call(1) }, { expect: { jsonrpc: '2.0', id: 1, result: {} } }, { expect: busy }],
      };
      const outcome = await runExeVector(vector, { ...mockTarget(), takeProblems: noProblems });
      expect(outcome.result).toBe('FAIL');
      expect(outcome.note).toContain('modal_open');
      expect(outcome.note).not.toContain('modal dialog open');
    },
    SLOW,
  );
});

describe('runExeVector', () => {
  it('turns what close() found into a FAIL of that vector, and leaves other outcomes alone', async () => {
    const vector = skippedVector();
    const mock = mockTarget();
    let found: string[] = [];
    const target = {
      name: 'exe',
      async open() {
        const instance = await mock.open();
        // Reports no capability, so the vector itself is skipped.
        return { ...instance, capabilities: [] };
      },
      takeProblems() {
        const taken = found;
        found = [];
        return taken;
      },
    };
    expect(await runExeVector(vector, target)).toMatchObject({ result: 'SKIP' });
    found = ['the instance ended by itself before the vector was over (exit code 5)'];
    const outcome = await runExeVector(vector, target);
    expect(outcome.result).toBe('FAIL');
    expect(outcome.note).toMatch(/^the instance ended by itself .* \(the vector itself: SKIP: /);
  });
});

describe('exeConfigFromEnv', () => {
  it('reports a skip, with the reason, when OTCP_TARGET_EXE is not set', () => {
    expect(exeConfigFromEnv({})).toEqual({ skip: 'OTCP_TARGET_EXE is not set' });
    expect(exeConfigFromEnv({ OTCP_TARGET_EXE: '' })).toEqual({ skip: 'OTCP_TARGET_EXE is not set' });
  });

  it('reads the arguments and the timeout', () => {
    expect(exeConfigFromEnv({ OTCP_TARGET_EXE: FAKE })).toEqual({ options: { exe: FAKE } });
    expect(
      exeConfigFromEnv({
        OTCP_TARGET_EXE: FAKE,
        OTCP_TARGET_ARGS: '["--control-api","--x"]',
        OTCP_TARGET_TIMEOUT_MS: '500',
      }),
    ).toEqual({ options: { exe: FAKE, args: ['--control-api', '--x'], timeoutMs: 500 } });
  });

  it('rejects malformed values', () => {
    for (const OTCP_TARGET_ARGS of ['nope', '{"a":1}', '[1]']) {
      expect(() => exeConfigFromEnv({ OTCP_TARGET_EXE: FAKE, OTCP_TARGET_ARGS })).toThrow('OTCP_TARGET_ARGS');
    }
    for (const OTCP_TARGET_TIMEOUT_MS of ['0', '-5', '1.5', 'soon']) {
      expect(() => exeConfigFromEnv({ OTCP_TARGET_EXE: FAKE, OTCP_TARGET_TIMEOUT_MS })).toThrow(
        'OTCP_TARGET_TIMEOUT_MS',
      );
    }
  });
});
