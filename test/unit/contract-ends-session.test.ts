// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The vectors that end the instance (endsSession, vectors/README.md "Vectors that end the instance")
// as the runner handles them: the longer waits, the checks after the last step (connections closed,
// the port refuses, the target's own look at the process and the discovery file) and what the outcome
// says about what a target cannot observe. Whole vectors against the mock, and against wrappers of it
// that behave wrongly on purpose.

import net from 'node:net';

import { describe, expect, it } from 'vitest';

import { mockTarget } from '../contract/mock-target.js';
import { runVector } from '../contract/runner.js';
import type { ContractTarget, EndReport, TargetInstance } from '../contract/target.js';
import { loadVectors, type Vector } from '../contract/vectors.js';

const loaded = new Map(loadVectors().map((v) => [v.id, v]));
const vector = (id: string): Vector => {
  const found = loaded.get(id);
  if (found === undefined) throw new Error(`no vector ${id}`);
  return structuredClone(found.vector);
};

/** Short enough that a wait that has to run out does not take 15 s. */
const SHORT = { endWaitMs: 300 };

const ENDS = ['app/quit-clean', 'app/quit-saved-path', 'app/quit-dirty-discard'];

/** The mock with its own look at how it ended replaced, and a record of what the runner asked of it. */
function observing(
  expectEnded: ((waitMs: number) => Promise<EndReport>) | undefined,
  asked: number[] = [],
): ContractTarget {
  const inner = mockTarget();
  return {
    name: 'observing',
    async open() {
      const instance = await inner.open();
      const base: TargetInstance = {
        discovery: instance.discovery,
        protocol: instance.protocol,
        capabilities: instance.capabilities,
        establish: (given) => instance.establish(given),
        runnerValue: (name) => instance.runnerValue(name),
        close: () => instance.close(),
      };
      if (expectEnded === undefined) return base;
      return {
        ...base,
        expectEnded: (waitMs: number) => {
          asked.push(waitMs);
          return expectEnded(waitMs);
        },
      };
    },
  };
}

/**
 * The mock behind a listener of the test's own that stays up after the mock quit, as an instance that
 * does not stop listening would: it accepts a connection and drops it at once.
 */
function lingeringPort(): ContractTarget {
  const inner = mockTarget();
  return {
    name: 'lingering',
    async open() {
      const instance = await inner.open();
      const upstream = Number(instance.discovery.port);
      const sockets = new Set<net.Socket>();
      const proxy = net.createServer((client) => {
        sockets.add(client);
        client.on('error', () => undefined);
        const server = net.connect({ host: '127.0.0.1', port: upstream });
        sockets.add(server);
        server.on('error', () => {
          client.destroy();
        });
        server.on('close', () => {
          client.destroy();
        });
        client.on('close', () => {
          server.destroy();
        });
        client.pipe(server);
        server.pipe(client);
      });
      await new Promise<void>((done) => {
        proxy.listen({ host: '127.0.0.1', port: 0 }, done);
      });
      return {
        ...instance,
        discovery: { ...instance.discovery, port: (proxy.address() as net.AddressInfo).port },
        async close() {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((done) => {
            proxy.close(() => {
              done();
            });
          });
          await instance.close();
        },
      };
    },
  };
}

describe('vectors with endsSession', () => {
  it.each(ENDS)('%s passes against the mock, which reports what it cannot show', async (id) => {
    const outcome = await runVector(vector(id), mockTarget());
    expect(outcome).toMatchObject({ id, result: 'PASS' });
    expect(outcome.note).toMatch(/^not checked: the exit status of a process/);
  });

  it('has the three vectors that quit the mock, and no other vector sets endsSession', () => {
    const ending = [...loaded.values()].filter((v) => v.vector.endsSession === true).map((v) => v.id);
    expect(ending.sort()).toEqual([...ENDS].sort());
  });

  it('asks the target how the instance ended, once, within the time it has', async () => {
    const asked: number[] = [];
    const target = observing(() => Promise.resolve({ problems: [], notChecked: [] }), asked);
    const outcome = await runVector(vector('app/quit-clean'), target);
    expect(outcome).toMatchObject({ result: 'PASS', note: '' });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeGreaterThan(0);
    expect(asked[0]).toBeLessThanOrEqual(15_000);
  });

  it('does not ask for the end of a vector that does not end the instance', async () => {
    const asked: number[] = [];
    const target = observing(() => Promise.resolve({ problems: ['must not be asked'], notChecked: [] }), asked);
    for (const id of ['app/quit-dirty-refused', 'app/quit-busy', 'session/info-ok']) {
      expect(await runVector(vector(id), target)).toMatchObject({ result: 'PASS' });
    }
    expect(asked).toEqual([]);
  });

  it('fails when the target finds the end wrong, with what it found', async () => {
    const target = observing(() =>
      Promise.resolve({
        problems: ['the process exited by itself with exit code 5, expected exit code 0'],
        notChecked: [],
      }),
    );
    const outcome = await runVector(vector('app/quit-clean'), target);
    expect(outcome).toEqual({
      id: 'app/quit-clean',
      result: 'FAIL',
      note: 'the process exited by itself with exit code 5, expected exit code 0',
    });
  });

  it('passes with a note of what the target could not observe', async () => {
    const target = observing(() =>
      Promise.resolve({ problems: [], notChecked: ['the exit status of the instance (started by a launcher)'] }),
    );
    const outcome = await runVector(vector('app/quit-clean'), target);
    expect(outcome).toMatchObject({
      result: 'PASS',
      note: 'not checked: the exit status of the instance (started by a launcher)',
    });
  });

  it('says that a target without a look at the process leaves the exit and the discovery file unchecked', async () => {
    const outcome = await runVector(vector('app/quit-clean'), observing(undefined));
    expect(outcome).toMatchObject({ result: 'PASS' });
    expect(outcome.note).toBe(
      'not checked: the exit of the process and the removal of the discovery file are not checked by this target',
    );
  });

  it('fails a request vector whose connection stays open after the response', async () => {
    // session.info does not end anything; claiming it does must not pass.
    const planted: Vector = { ...vector('session/info-ok'), endsSession: true, connectionAfter: 'closed' };
    const outcome = await runVector(planted, mockTarget(), undefined, SHORT);
    expect(outcome).toMatchObject({
      result: 'FAIL',
      note: 'main: the server kept the connection open after the response, expected it to close',
    });
  });

  it('gives an expectClosed without withinMs the longer wait, and names it', async () => {
    const base = vector('session/notification-ignored');
    const planted: Vector = { ...base, endsSession: true, steps: [...(base.steps ?? []), { expectClosed: {} }] };
    const outcome = await runVector(planted, mockTarget(), undefined, SHORT);
    expect(outcome).toMatchObject({
      result: 'FAIL',
      note: 'main: the server did not close the connection in 0.3 s',
    });
  });

  it('fails when the port still accepts connections after the connections closed', async () => {
    const outcome = await runVector(vector('app/quit-clean'), lingeringPort(), undefined, SHORT);
    expect(outcome).toEqual({
      id: 'app/quit-clean',
      result: 'FAIL',
      note: 'the port of the instance still accepts connections after it was to end',
    });
  });

  it('fails when a connection of the vector is still open after the end wait', async () => {
    // The mock never quits here, so the connection of the vector stays open.
    const base = vector('session/notification-ignored');
    const planted: Vector = { ...base, endsSession: true };
    const outcome = await runVector(planted, mockTarget(), undefined, SHORT);
    expect(outcome.result).toBe('FAIL');
    expect(outcome.note).toMatch(/the server did not close the connection after the instance was to end/);
  });
});

describe('the mock target looks at how the mock ended', () => {
  it('finds a mock that is still running, and its discovery file', async () => {
    const instance = await mockTarget().open();
    try {
      const report = await instance.expectEnded?.(100);
      expect(report?.problems).toEqual([
        'the mock did not end in 100 ms',
        'the discovery file of the instance is still there',
      ]);
    } finally {
      await instance.close();
    }
  });
});
