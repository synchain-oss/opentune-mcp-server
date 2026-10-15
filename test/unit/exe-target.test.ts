// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The exe target against a stand-in executable (test/support/fake-opentune.mjs), started with the
// Node binary: normal start and stop, a launcher that hands over to another process, and each way
// the start-up and the end can go wrong.

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { pidAlive, systemProbe } from '../../src/discovery/process.js';
import { exeConfigFromEnv, exeTarget } from '../contract/exe-target.js';
import { runExeVector } from '../contract/exe-vectors.js';
import { mockTarget } from '../contract/mock-target.js';
import { PreconditionUnavailable } from '../contract/target.js';
import { loadVectors } from '../contract/vectors.js';

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
