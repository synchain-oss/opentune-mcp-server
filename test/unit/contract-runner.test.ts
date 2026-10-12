// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The contract-vector runner itself: matchers on both sides of the line, the id-literal reader,
// and whole vectors against the mock, unchanged (PASS), with a planted wrong expectation (FAIL)
// and from an area the mock does not implement (SKIP, never PASS).

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
import { loadVectors, type Vector } from '../contract/vectors.js';

const bound = (entries: Record<string, unknown> = {}): Bindings => new Map(Object.entries(entries));

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
    const other = [...vectors.values()].find((v) => v.capability === 'read.v1');
    if (other === undefined) throw new Error('no read.v1 vector');
    const outcome = await runVector(other, target);
    expect(outcome).toEqual({
      id: other.id,
      result: 'SKIP',
      note: 'mock target lacks read.v1 (methods not implemented)',
    });
  });

  it('skips a vector whose precondition the mock cannot establish', async () => {
    const planted = vector('job/get-running');
    const outcome = await runVector({ ...planted, given: { ...planted.given, dirty: true } }, target);
    expect(outcome).toMatchObject({ result: 'SKIP', note: expect.stringContaining('given.dirty') as unknown });
  });
});
