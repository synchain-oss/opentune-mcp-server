// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The contract-vector runner itself: matchers on both sides of the line, the id-literal reader,
// and whole vectors against the mock, unchanged (PASS), with a planted wrong expectation (FAIL)
// and from an area the mock does not implement (SKIP, never PASS). Failure notes never show the
// token or the server proof, whatever the instance sends.

import { randomBytes } from 'node:crypto';
import net from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  InvalidVector,
  jsonEqual,
  match,
  names,
  resolve,
  topLevelLiteral,
  type Bindings,
} from '../contract/matchers.js';
import { mockTarget } from '../contract/mock-target.js';
import { runVector } from '../contract/runner.js';
import type { ContractTarget } from '../contract/target.js';
import { loadVectors, type Vector } from '../contract/vectors.js';

const bound = (entries: Record<string, unknown> = {}): Bindings => new Map(Object.entries(entries));

interface Secrets {
  readonly token: string;
  readonly serverProof: string;
}

/** Fresh secrets of the discovery file's form; the token starts with a letter so it can pose as a reason code. */
const secrets = (): Secrets => ({
  token: `a${randomBytes(32).toString('hex').slice(1)}`,
  serverProof: randomBytes(16).toString('hex'),
});

/** None of the values is in the text, not even the start of one, which is what a cut leaves. */
const expectNoneOf = (text: string, ...values: string[]) => {
  for (const value of values) expect(text).not.toContain(value.slice(0, 12));
};

/**
 * An instance other than the one its discovery file names: the file is a mock's with the given
 * secrets, but its port is a server of the test's own. That server answers the first line it
 * receives, the runner's session.hello, with what `reply` returns for its id, or never answers.
 */
function impostor(fileSecrets: Secrets, reply?: (id: unknown) => string): ContractTarget {
  return {
    name: 'impostor',
    async open() {
      const instance = await mockTarget().open();
      const sockets = new Set<net.Socket>();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => undefined);
        let received = '';
        socket.on('data', (chunk: Buffer) => {
          if (received.includes('\n')) return;
          received += chunk.toString('utf8');
          const end = received.indexOf('\n');
          if (end === -1 || reply === undefined) return;
          socket.write(`${reply((JSON.parse(received.slice(0, end)) as { id: unknown }).id)}\n`);
        });
      });
      await new Promise<void>((done) => {
        server.listen({ host: '127.0.0.1', port: 0 }, done);
      });
      return {
        ...instance,
        discovery: { ...instance.discovery, ...fileSecrets, port: (server.address() as net.AddressInfo).port },
        async close() {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          });
          await instance.close();
        },
      };
    },
  };
}

describe('match', () => {
  it('matches objects as subsets and arrays element by element', () => {
    expect(match({ a: 1 }, { a: 1, extra: true }, bound())).toEqual([]);
    expect(match({ a: 1, b: 2 }, { a: 1 }, bound())).toEqual(['$.b: missing']);
    expect(match([1, 2], [1, 2], bound())).toEqual([]);
    expect(match([1, 2], [1, 2, 3], bound())).toEqual(['$: expected 2 elements, got 3']);
    expect(match([1], { 0: 1 }, bound())[0]).toMatch(/expected an array/);
    expect(match({ a: 1 }, [1], bound())[0]).toMatch(/expected an object/);
    expect(match({ a: { b: 'x' } }, { a: { b: 'y' } }, bound())).toEqual(['$.a.b: expected "x", got "y"']);
  });

  it('compares numbers by value and everything else strictly', () => {
    expect(match(100, 1e2, bound())).toEqual([]);
    expect(match(1, '1', bound())).toHaveLength(1);
    expect(match(null, null, bound())).toEqual([]);
    expect(match(false, 0, bound())).toHaveLength(1);
  });

  it('$any: any value or one JSON type, but the member must be present', () => {
    expect(match({ x: { $any: true } }, { x: null }, bound())).toEqual([]);
    expect(match({ x: { $any: true } }, {}, bound())).toEqual(['$.x: missing']);
    expect(match({ $any: 'integer' }, 3, bound())).toEqual([]);
    expect(match({ $any: 'integer' }, 3.5, bound())).toHaveLength(1);
    expect(match({ $any: 'number' }, 3.5, bound())).toEqual([]);
    expect(match({ $any: 'object' }, [], bound())).toHaveLength(1);
    expect(match({ $any: 'array' }, [], bound())).toEqual([]);
    expect(match({ $any: 'null' }, null, bound())).toEqual([]);
    expect(match({ $any: 'string' }, 1, bound())).toHaveLength(1);
  });

  it('$approx with $tol, 1e-6 by default, inclusive', () => {
    expect(match({ $approx: 1 }, 1.000001, bound())).toEqual([]);
    expect(match({ $approx: 1 }, 1.00001, bound())).toHaveLength(1);
    expect(match({ $approx: 10, $tol: 0.5 }, 10.5, bound())).toEqual([]);
    expect(match({ $approx: 10, $tol: 0.5 }, '10', bound())).toHaveLength(1);
  });

  it('$capture binds what matched, and $ref compares with it', () => {
    const b = bound();
    expect(match({ jobId: { $capture: 'job', $any: 'string' } }, { jobId: 'j:01234567:1' }, b)).toEqual([]);
    expect(b.get('job')).toBe('j:01234567:1');
    expect(match({ $ref: 'job' }, 'j:01234567:1', b)).toEqual([]);
    expect(match({ $ref: 'job' }, 'j:01234567:2', b)).toEqual(['$: expected the value of job, got "j:01234567:2"']);
    expect(match({ $ref: 'job' }, undefined, b)).toEqual(['$: missing']);
    // A capture whose constraint fails binds nothing.
    expect(match({ $capture: 'n', $any: 'string' }, 5, b)).toHaveLength(1);
    expect(b.has('n')).toBe(false);
  });

  it('never shows the token or the server proof, nor a near miss of them, nor part of one', () => {
    const { token, serverProof } = secrets();
    const b = bound({ 'discovery.token': token, 'discovery.serverProof': serverProof });
    const nearMiss = `${serverProof.slice(0, -1)}${serverProof.endsWith('0') ? '1' : '0'}`;
    expect(match({ $ref: 'discovery.serverProof' }, nearMiss, b)).toEqual([
      '$: expected the value of discovery.serverProof, got a different value (not shown)',
    ]);
    expect(match({ id: 'x' }, { id: token.toUpperCase() }, b)).toEqual(['$.id: expected "x", got "<redacted>"']);
    // Long enough to be cut short, with the token across the cut.
    const problems = match('x', `${'y'.repeat(100)}${token}`, b);
    expect(problems[0]).toMatch(/<redacted>"$/);
    expectNoneOf(problems.join(), token);
  });

  it('rejects malformed matchers as an invalid vector', () => {
    const b = bound({ x: 1 });
    expect(() => match({ $any: true, a: 1 }, {}, b)).toThrow(InvalidVector);
    expect(() => match({ $ref: 'unbound' }, 1, b)).toThrow(/not bound/);
    expect(() => match({ $ref: 'x', $any: true }, 1, b)).toThrow(InvalidVector);
    expect(() => match({ $capture: 'x' }, 1, b)).toThrow(/already bound/);
    expect(() => match({ $any: 'float' }, 1, b)).toThrow(InvalidVector);
    expect(() => match({ $any: true, $approx: 1 }, 1, b)).toThrow(InvalidVector);
    expect(() => match({ $tol: 1 }, 1, b)).toThrow(/needs \$approx/);
    expect(() => match({ $approx: 'x' }, 1, b)).toThrow(InvalidVector);
    expect(() => match({ $regex: 'a' }, 'a', b)).toThrow(/unknown matcher/);
    expect(() => match({ $capture: '1bad' }, 1, b)).toThrow(InvalidVector);
  });
});

describe('resolve, names and jsonEqual', () => {
  it('replaces $ref in values to send and allows no other matcher there', () => {
    const b = bound({ 'discovery.token': 'ab' });
    expect(resolve({ params: { token: { $ref: 'discovery.token' }, list: [1] } }, b)).toEqual({
      params: { token: 'ab', list: [1] },
    });
    expect(() => resolve({ $any: true }, b)).toThrow(InvalidVector);
    expect(() => resolve({ $ref: 'missing' }, b)).toThrow(InvalidVector);
  });

  it('collects referenced and captured names', () => {
    const found = names([{ a: { $ref: 'x' } }, [{ $capture: 'y' }]]);
    expect([...found.refs]).toEqual(['x']);
    expect([...found.captures]).toEqual(['y']);
  });

  it('compares JSON values regardless of member order', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual([1], [1, 2])).toBe(false);
    expect(jsonEqual({ a: 1 }, null)).toBe(false);
  });
});

describe('topLevelLiteral', () => {
  it('returns a top-level member exactly as written', () => {
    expect(topLevelLiteral('{"jsonrpc":"2.0","id":1.0,"result":{}}', 'id')).toBe('1.0');
    expect(topLevelLiteral('{ "result" : {"id":7,"x":[1,{"id":8}]} , "id" : 1e2 }', 'id')).toBe('1e2');
    expect(topLevelLiteral('{"error":{"data":"}\\"{"},"id":null}', 'id')).toBe('null');
    expect(topLevelLiteral('{"id":"a\\"b"}', 'id')).toBe('"a\\"b"');
    expect(topLevelLiteral('{"result":{}}', 'id')).toBeUndefined();
    expect(topLevelLiteral('[1]', 'id')).toBeUndefined();
    expect(topLevelLiteral('{"a" 1}', 'id')).toBeUndefined();
  });
});

describe('runVector against the mock', () => {
  const vectors = new Map(loadVectors().map((v) => [v.id, v.vector]));
  const vector = (id: string): Vector => {
    const v = vectors.get(id);
    if (v === undefined) throw new Error(`no vector ${id}`);
    return structuredClone(v);
  };
  const target = mockTarget();

  it('passes an unchanged vector', async () => {
    expect(await runVector(vector('session/info-ok'), target)).toMatchObject({ result: 'PASS' });
  });

  it('fails when an expected value is planted wrong', async () => {
    const planted = vector('session/info-ok');
    (planted.response as { result: { flavor: string } }).result.flavor = 'plugin';
    const outcome = await runVector(planted, target);
    expect(outcome.result).toBe('FAIL');
    expect(outcome.note).toContain('$.result.flavor: expected "plugin", got "standalone"');
  });

  it('fails when a scenario expects the connection to close but it stays open', async () => {
    const planted = vector('session/notification-ignored');
    const steps = [...(planted.steps ?? []), { expectClosed: { noBytes: true, withinMs: 200 } }];
    const outcome = await runVector({ ...planted, steps }, target);
    expect(outcome).toMatchObject({ result: 'FAIL', note: expect.stringContaining('did not close') as unknown });
  });

  it('fails a number id that the response writes differently (matching rule 4)', async () => {
    const planted = vector('session/hello-ok');
    // The request id is a string now, so the expected number id cannot be what the server echoes.
    (planted.request as { id: unknown }).id = '1';
    const outcome = await runVector(planted, target);
    expect(outcome.result).toBe('FAIL');
    expect(outcome.note).toContain('plain integer literal');
  });

  it('reports a vector whose params contradict paramsValid as invalid', async () => {
    const planted = {
      ...vector('session/info-unknown-param'),
      request: { jsonrpc: '2.0', id: 3, method: 'session.info' },
    };
    expect((await runVector(planted, target)).note).toMatch(/^invalid vector: paramsValid is false/);
  });

  it('skips, and never passes, a vector whose capability the mock does not report', async () => {
    const other = [...vectors.values()].find((v) => v.capability === 'edit.v1');
    if (other === undefined) throw new Error('no edit.v1 vector');
    const outcome = await runVector(other, target);
    expect(outcome).toEqual({
      id: other.id,
      result: 'SKIP',
      note: 'mock target lacks edit.v1 (methods not implemented)',
    });
  });

  it('skips a vector whose precondition the mock cannot establish', async () => {
    const planted = vector('job/get-running');
    const outcome = await runVector({ ...planted, given: { ...planted.given, futureMember: true } }, target);
    expect(outcome).toMatchObject({ result: 'SKIP', note: expect.stringContaining('given.futureMember') as unknown });
  });

  describe("keeps the token and the server proof out of a failed session.hello's note", () => {
    const helloFailed = /^the runner's own session\.hello failed: main: /;

    it('when the result does not match the discovery file', async () => {
      const file = secrets();
      const otherProof = randomBytes(16).toString('hex');
      // The proof of whichever instance answered, and the file's secrets where they do not belong.
      const target = impostor(file, (id) =>
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { serverProof: otherProof, instanceId: file.serverProof, pid: file.token },
        }),
      );
      const outcome = await runVector(vector('session/info-ok'), target);
      expect(outcome.result).toBe('FAIL');
      expect(outcome.note).toMatch(helloFailed);
      expect(outcome.note).toContain(
        '$.result.serverProof: expected the value of discovery.serverProof, got a different value (not shown)',
      );
      expect(outcome.note).toContain(
        '$.result.instanceId: expected the value of discovery.instanceId, got "<redacted>"',
      );
      expectNoneOf(outcome.note, file.token, file.serverProof, otherProof);
    });

    it('when no answer comes in time', async () => {
      const file = secrets();
      const outcome = await runVector(vector('session/info-ok'), impostor(file), undefined, { readTimeoutMs: 200 });
      expect(outcome.result).toBe('FAIL');
      expect(outcome.note).toMatch(helloFailed);
      expect(outcome.note).toContain('no line within 200 ms; expected ');
      expect(outcome.note).toContain('"serverProof":{"$ref":"discovery.serverProof"}');
      expectNoneOf(outcome.note, file.token, file.serverProof);
    });

    it('when the answer is not JSON and the token is where the note cuts it', async () => {
      const file = secrets();
      const outcome = await runVector(
        vector('session/info-ok'),
        impostor(file, () => `${'x'.repeat(180)}${file.token}`),
      );
      expect(outcome.note).toMatch(helloFailed);
      expect(outcome.note).toMatch(/not JSON: x+<redacted>$/);
      expectNoneOf(outcome.note, file.token);
    });

    it('when an error echoes the token as its reason', async () => {
      const file = secrets();
      const target = impostor(file, (id) =>
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32001,
            message: 'AUTH_FAILED',
            data: { kind: 'AUTH_FAILED', reason: file.token, retryable: false, detail: 'denied', executed: false },
          },
        }),
      );
      const outcome = await runVector(vector('session/info-ok'), target);
      expect(outcome.note).toMatch(helloFailed);
      expect(outcome.note).toContain('reason <redacted> is not registered for AUTH_FAILED');
      expectNoneOf(outcome.note, file.token);
    });
  });
});
