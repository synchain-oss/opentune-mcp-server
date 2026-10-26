// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The exe target and a vector that ends the instance (endsSession): the stand-in executable
// (test/support/fake-opentune.mjs, `quit*` modes) answers app.quit and then ends by itself. The target
// does not count that as an instance that ended too early, and finds out how it ended: the exit status
// of the process it started, the process a launcher handed over to, the discovery file.

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { exeTarget } from '../contract/exe-target.js';
import { runExeVector } from '../contract/exe-vectors.js';
import { runVector } from '../contract/runner.js';
import { loadVectors, type Vector } from '../contract/vectors.js';

const FAKE = fileURLToPath(new URL('../support/fake-opentune.mjs', import.meta.url));
const SLOW = 30_000;
// Each start-time reading may take a few attempts of a system tool on a busy machine.
const LAUNCHER = 90_000;

const fake = (mode: string) => exeTarget({ exe: process.execPath, args: [FAKE, `--mode=${mode}`], timeoutMs: 10_000 });

const quitClean = (): Vector => {
  const found = loadVectors().find((v) => v.id === 'app/quit-clean');
  if (found === undefined) throw new Error('no vector app/quit-clean');
  return found.vector;
};

describe('exe target: a vector that ends the instance', () => {
  it(
    'passes when the process answered, closed its connections, removed its discovery file and exited with status 0',
    async () => {
      const target = fake('quit');
      const outcome = await runExeVector(quitClean(), target);
      expect(outcome).toEqual({ id: 'app/quit-clean', result: 'PASS', note: '' });
      // Ended as asked: neither an early end nor a stop by the target.
      expect(target.stats).toMatchObject({ endedAsAsked: 1, exitedEarly: 0, verified: 0, forced: 0 });
      expect(target.takeProblems()).toEqual([]);
    },
    SLOW,
  );

  it(
    'fails when the instance leaves its discovery file behind',
    async () => {
      const target = fake('quit-no-cleanup');
      const outcome = await runExeVector(quitClean(), target);
      expect(outcome.result).toBe('FAIL');
      expect(outcome.note).toContain('the instance left its discovery file behind');
      expect(target.stats).toMatchObject({ endedAsAsked: 0, exitedEarly: 0 });
    },
    SLOW,
  );

  it(
    'fails when the process exits with a status other than 0, and says which',
    async () => {
      const target = fake('quit-bad-exit');
      const outcome = await runExeVector(quitClean(), target);
      expect(outcome.result).toBe('FAIL');
      expect(outcome.note).toContain('the process exited by itself with exit code 5, expected exit code 0');
      // The end was asked for: it is not reported a second time as an early end.
      expect(outcome.note).not.toContain('before the vector was over');
      expect(target.stats).toMatchObject({ endedAsAsked: 0, exitedEarly: 0 });
    },
    SLOW,
  );

  it(
    'does not count the end as an early one when the vector fails after the call that ends the instance',
    async () => {
      const target = fake('quit');
      // The stand-in answers app.quit as it should and quits. A step after the answer fails, a second after
      // the instance has ended by itself, so expectEnded() never runs: the call that ended the instance had been
      // sent, so the vector fails for its own step only, and not a second time for an end it did not ask for.
      const quitting = quitClean();
      const planted: Vector = {
        id: quitting.id,
        type: 'scenario',
        description: quitting.description,
        capability: quitting.capability,
        since: quitting.since,
        session: quitting.session,
        endsSession: true,
        steps: [
          { send: quitting.request },
          { expect: quitting.response },
          { pauseMs: 1000 },
          { expect: { jsonrpc: '2.0', id: 2, result: { $any: 'object' } } },
        ],
      };
      const outcome = await runExeVector(planted, target);
      expect(outcome.result).toBe('FAIL');
      expect(outcome.note).not.toContain('before the vector was over');
      expect(target.stats).toMatchObject({ exitedEarly: 0, endedAsAsked: 0 });
      expect(target.takeProblems()).toEqual([]);
    },
    SLOW,
  );

  it(
    'fails when the process is still running after the end wait, and then ends it',
    async () => {
      const target = fake('quit-stays');
      const outcome = await runVector(quitClean(), target, undefined, { endWaitMs: 1000 });
      expect(outcome.result).toBe('FAIL');
      expect(outcome.note).toMatch(/the process did not exit within \d+ ms after the instance was to end/);
      // close() stops what is left; it is a stop by the target, not an end as asked.
      expect(target.stats.endedAsAsked).toBe(0);
      expect(target.stats.verified + target.stats.forced).toBe(1);
      expect(target.takeProblems()).toEqual([]);
    },
    SLOW,
  );

  it(
    'passes for an instance a launcher handed over to, and says that its exit status could not be seen',
    async () => {
      const target = fake('launcher-quit');
      const outcome = await runExeVector(quitClean(), target);
      expect(outcome.result).toBe('PASS');
      expect(outcome.note).toMatch(/^not checked: the exit status of the instance \(started by a launcher/);
      expect(target.stats).toMatchObject({ endedAsAsked: 1, exitedEarly: 0 });
      expect(target.takeProblems()).toEqual([]);
    },
    LAUNCHER,
  );
});
