// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// A small OTCP client for tests of the mock: it starts a mock with its own temporary directories,
// authenticates one session and calls methods, returning the whole response.

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { GivenClip } from '../../mock/given.js';
import { startMock, type MockOptions, type OtcpMock } from '../../mock/server.js';
import { RunnerConnection } from '../contract/connection.js';
import { otcpSpec } from './otcp-spec.js';

export interface Response {
  readonly id: unknown;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string; data: Record<string, unknown> };
}

export interface TestSession {
  readonly mock: OtcpMock;
  /** Sends one request and returns its response. */
  readonly call: (method: string, params?: Record<string, unknown>) => Promise<Response>;
  /** The result of a call that must succeed; it is also checked against the method's result schema. */
  readonly ok: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** The error of a call that must fail. */
  readonly fails: (method: string, params?: Record<string, unknown>) => Promise<NonNullable<Response['error']>>;
}

/** Everything a test opened, to be closed by `dispose()` in an afterEach hook. */
export class Sessions {
  readonly #cleanup: (() => Promise<void> | void)[] = [];

  async open(options: MockOptions = {}): Promise<TestSession> {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ot-mock-test-'));
    this.#cleanup.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const mock = await startMock({ discoveryDir: dir, ...options });
    this.#cleanup.push(() => mock.stop());
    const conn = await RunnerConnection.open(mock.address.port);
    this.#cleanup.push(() => {
      conn.destroy();
    });
    let nextId = 0;
    const exchange = async (message: unknown): Promise<Response> => {
      conn.write(Buffer.from(`${JSON.stringify(message)}\n`, 'utf8'));
      const line = await conn.readLine(5000);
      if (typeof line === 'string') throw new Error(`no line from the mock: ${line}`);
      return JSON.parse(line.toString('utf8')) as Response;
    };
    const hello = await exchange({
      jsonrpc: '2.0',
      id: 0,
      method: 'session.hello',
      params: { token: mock.discovery.token, protocol: '1.0', client: { name: 'mock-test', version: '1.0.0' } },
    });
    if (hello.result === undefined) throw new Error('the mock refused session.hello');
    const call: TestSession['call'] = (method, params = {}) =>
      exchange({ jsonrpc: '2.0', id: ++nextId, method, params });
    return {
      mock,
      call,
      async ok(method, params) {
        const response = await call(method, params);
        if (response.result === undefined) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
        const problems = otcpSpec().validate(`methods/${method}.schema.json#/$defs/result`, response.result);
        if (problems.length > 0) throw new Error(`${method} result is not valid: ${problems.join('; ')}`);
        return response.result;
      },
      async fails(method, params) {
        const response = await call(method, params);
        if (response.error === undefined) throw new Error(`${method} succeeded: ${JSON.stringify(response.result)}`);
        return response.error;
      },
    };
  }

  async dispose(): Promise<void> {
    for (const fn of this.#cleanup.splice(0).reverse()) await fn();
  }
}

/** A clip as the `clips` precondition describes it. */
export const clip = (extra: Partial<GivenClip> = {}): GivenClip => ({
  bind: 'clip',
  trackId: 0,
  startTimelineSec: 2,
  durationSec: 6,
  analysis: 'ready',
  notes: [
    { startContentSec: 0.5, endContentSec: 1.5, targetMidi: 64 },
    { startContentSec: 2, endContentSec: 3, targetMidi: 69 },
    { startContentSec: 3.5, endContentSec: 4.5, targetMidi: 69.3 },
  ],
  ...extra,
});

/** A name that `mock.given(...)` bound; throws when the mock bound none. */
export function need(bound: Record<string, string>, name: string): string {
  const value = bound[name];
  if (value === undefined) throw new Error(`the mock bound no ${name}`);
  return value;
}
