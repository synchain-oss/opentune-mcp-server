// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The exe target against a stand-in executable (test/support/fake-opentune.mjs), started with the
// Node binary: normal start and stop, and each way the start-up can go wrong.

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { exeConfigFromEnv, exeTarget } from '../contract/exe-target.js';
import { PreconditionUnavailable } from '../contract/target.js';

const FAKE = fileURLToPath(new URL('../support/fake-opentune.mjs', import.meta.url));
const SLOW = 20_000;

const fake = (mode: string, timeoutMs = 10_000) =>
  exeTarget({ exe: process.execPath, args: [FAKE, `--mode=${mode}`], timeoutMs });

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
      expect(target.stats).toEqual(
        process.platform === 'win32' ? { verified: 0, forced: 1 } : { verified: 1, forced: 0 },
      );
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
    'fails when the hello answer carries another serverProof',
    async () => {
      await expect(fake('bad-proof').open()).rejects.toThrow('serverProof');
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
    },
    SLOW,
  );

  it.skipIf(process.platform === 'win32')(
    'fails the close of an instance that exits normally but leaves its discovery file',
    async () => {
      const instance = await fake('no-cleanup').open();
      await expect(instance.close()).rejects.toThrow('left its discovery file behind');
    },
    SLOW,
  );

  it('refuses an executable that is not an absolute path to an existing file', () => {
    expect(() => exeTarget({ exe: 'opentune.exe' })).toThrow('absolute path');
    expect(() => exeTarget({ exe: FAKE.replace('fake-opentune.mjs', 'missing.exe') })).toThrow('regular file');
    expect(() => exeTarget({ exe: fileURLToPath(new URL('.', import.meta.url)) })).toThrow('regular file');
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
