// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startMock, type OtcpMock } from '../../mock/server.js';
import { parseDiscoveryFile, type DiscoveryEntry } from '../../src/discovery/file.js';
import { OtcpError } from '../../src/errors/tool-error.js';
import { OtcpSession } from '../../src/otcp/client.js';
import { Instances, missingCapability, selectInstance } from '../../src/otcp/instances.js';
import {
  METHOD_ASPECTS,
  EXPECTED_PARAM,
  decodeArrangementRevision,
  decodeClipRevision,
  encodeArrangementRevision,
  encodeClipRevision,
  expectedParams,
} from '../../src/otcp/tokens.js';
import { discoveryContent, fakeProbe, tempDir } from '../support/context.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function entryOf(content: Record<string, unknown>): DiscoveryEntry {
  const parsed = parseDiscoveryFile(`${String(content.pid)}.json`, Buffer.from(JSON.stringify(content)));
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.entry;
}

async function mock(): Promise<{ mock: OtcpMock; entry: DiscoveryEntry; dir: string }> {
  const { dir, remove } = tempDir();
  cleanup.push(remove);
  const m = await startMock({ discoveryDir: dir });
  cleanup.push(() => m.stop());
  return { mock: m, entry: entryOf(m.discovery), dir };
}

/** A TCP server that records every line and answers through `reply`. */
async function fakeInstance(reply: (line: string, socket: net.Socket) => void) {
  const lines: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        lines.push(line);
        reply(line, socket);
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          resolve();
        });
      }),
  );
  return { port, lines };
}

function helloResult(entry: DiscoveryEntry, overrides: Record<string, unknown> = {}) {
  return {
    protocol: '1.0',
    instanceId: entry.instanceId,
    pid: entry.pid,
    serverProof: entry.serverProof,
    appVersion: entry.appVersion,
    flavor: 'standalone',
    capabilities: ['session.v1'],
    ...overrides,
  };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OtcpError) return error;
    throw error;
  }
  throw new Error('expected an OtcpError');
};

/** Neither secret of the entry appears in anything the client produced. */
function expectNoSecrets(entry: DiscoveryEntry, ...values: unknown[]) {
  const text = JSON.stringify(values.map((v) => (v instanceof OtcpError ? { message: v.message, data: v.data } : v)));
  expect(text).not.toContain(entry.token);
  expect(text).not.toContain(entry.serverProof);
}

describe('OtcpSession against the mock', () => {
  it('authenticates, verifies the instance and calls methods', async () => {
    const { entry } = await mock();
    const session = await OtcpSession.open(entry);
    expect(session.hello).toMatchObject({ instanceId: entry.instanceId, pid: entry.pid, protocol: '1.0' });
    expect(session.hello.capabilities).toEqual(expect.arrayContaining(['session.v1', 'jobs.v1']));
    expect(await session.call('session.info', {}, 5000)).toMatchObject({ instanceId: entry.instanceId });
    const notFound = await failure(session.call('job.get', { jobId: 'j:00000000:9' }, 5000));
    expect(notFound.data).toMatchObject({ kind: 'NOT_FOUND', reason: 'job_not_found', executed: false });
    session.close();
    expect(session.closed).toBe(true);
    const closed = await failure(session.call('session.info', {}, 5000));
    expect(closed.data).toMatchObject({ kind: 'CONNECTION_LOST', executed: false });
    expectNoSecrets(entry, notFound, closed, session.hello);
  });

  it('reports AUTH_FAILED for a token the instance does not accept, without quoting it', async () => {
    const { entry } = await mock();
    const wrong = { ...entry, token: randomBytes(32).toString('hex') };
    const error = await failure(OtcpSession.open(wrong));
    expect(error.data).toMatchObject({ kind: 'AUTH_FAILED', executed: false });
    expectNoSecrets(entry, error);
    expectNoSecrets(wrong, error);
  });

  it('fails pending calls when the instance stops', async () => {
    const { mock: m, entry } = await mock();
    const job = m.given({ jobs: [{ bind: 'j', kind: 'import', state: 'running', cancellable: true }] });
    const session = await OtcpSession.open(entry);
    const waiting = failure(session.call('job.get', { jobId: job.j, waitMs: 20_000 }, 25_000));
    await m.stop();
    const error = await waiting;
    expect(['SHUTTING_DOWN', 'CONNECTION_LOST']).toContain(error.data.kind);
  });
});

describe('OtcpSession against other listeners', () => {
  it('sends nothing after a hello whose serverProof differs from the discovery file', async () => {
    const entry = entryOf(discoveryContent(4242));
    const fake = await fakeInstance((line, socket) => {
      const { id } = JSON.parse(line) as { id: number };
      socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, result: helloResult(entry, { serverProof: randomBytes(16).toString('hex') }) })}\n`,
      );
    });
    const error = await failure(OtcpSession.open({ ...entry, port: fake.port }));
    expect(error.data).toMatchObject({ kind: 'INSTANCE_UNVERIFIED', reason: 'proof_mismatch', executed: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.lines).toHaveLength(1);
    expect(JSON.parse(fake.lines[0] ?? '')).toMatchObject({ method: 'session.hello', params: { protocol: '1.0' } });
    expectNoSecrets(entry, error);
  });

  it.each([
    ['instanceId', { instanceId: 'f'.repeat(32) }],
    ['pid', { pid: 1 }],
    ['capabilities', { capabilities: 'all' }],
  ])('rejects a hello with a different %s', async (_name, overrides) => {
    const entry = entryOf(discoveryContent(4243));
    const fake = await fakeInstance((line, socket) => {
      const { id } = JSON.parse(line) as { id: number };
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: helloResult(entry, overrides) })}\n`);
    });
    const error = await failure(OtcpSession.open({ ...entry, port: fake.port }));
    expect(error.data.kind).toBe('INSTANCE_UNVERIFIED');
  });

  it('rejects a hello response that is not JSON-RPC', async () => {
    const entry = entryOf(discoveryContent(4244));
    const fake = await fakeInstance((_line, socket) => socket.write('HTTP/1.1 400 Bad Request\n'));
    expect((await failure(OtcpSession.open({ ...entry, port: fake.port }))).data).toMatchObject({
      kind: 'INSTANCE_UNVERIFIED',
      reason: 'invalid_hello',
    });
  });

  it('times out a silent listener and a missing one', async () => {
    const entry = entryOf(discoveryContent(4245));
    const silent = await fakeInstance(() => undefined);
    expect((await failure(OtcpSession.open({ ...entry, port: silent.port }, 200))).data).toMatchObject({
      kind: 'CONNECTION_LOST',
      reason: 'hello_timeout',
    });
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    expect((await failure(OtcpSession.open({ ...entry, port }))).data).toMatchObject({
      kind: 'CONNECTION_LOST',
      reason: 'connect_failed',
      executed: false,
    });
  });

  it('times out a request without dropping the session, and ignores stray responses', async () => {
    const entry = entryOf(discoveryContent(4246));
    const fake = await fakeInstance((line, socket) => {
      const { id, method } = JSON.parse(line) as { id: number; method: string };
      if (method === 'session.hello')
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: helloResult(entry) })}\n`);
      if (method === 'echo') {
        socket.write('not json\n{"jsonrpc":"2.0","id":999,"result":{}}\n');
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } })}\n`);
      }
      if (method === 'bad') socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: 7 })}\n`);
    });
    const session = await OtcpSession.open({ ...entry, port: fake.port });
    const timeout = await failure(session.call('slow', {}, 100));
    expect(timeout.data).toMatchObject({ kind: 'REQUEST_TIMEOUT', executed: null });
    expect(await session.call('echo', {}, 2000)).toEqual({ ok: true });
    expect((await failure(session.call('bad', {}, 2000))).data).toMatchObject({
      kind: 'INTERNAL',
      reason: 'invalid_response',
    });
    session.close();
  });
});

describe('Instances', () => {
  it('opens one session per instance, reopens it after a disconnect and drops it when the instance is gone', async () => {
    const { mock: m, dir } = await mock();
    const instances = new Instances({
      env: { OPENTUNE_MCP_DISCOVERY_DIR: dir },
      platform: process.platform,
      home: dir,
      probe: fakeProbe(),
    });
    cleanup.push(() => {
      instances.close();
    });
    const scan = await instances.scan();
    if (!('instances' in scan)) throw new Error('scan failed');
    const [entry] = scan.instances;
    if (!entry) throw new Error('no instance');
    const first = await instances.session(entry);
    expect(await instances.session(entry)).toBe(first);
    expect(missingCapability(first, ['jobs.v1'])).toBeNull();
    expect(missingCapability(first, ['tracks.v1'])).toMatchObject({
      kind: 'UNSUPPORTED',
      reason: 'capability_missing',
    });
    first.close();
    const second = await instances.session(entry);
    expect(second).not.toBe(first);
    await m.stop();
    expect(readdirSync(dir)).toEqual([]);
    const after = await instances.scan();
    expect('instances' in after && after.instances).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.closed).toBe(true);
  });

  it('reports an unusable discovery directory as a configuration error', async () => {
    const relative = new Instances({
      env: { OPENTUNE_MCP_DISCOVERY_DIR: 'relative/dir' },
      platform: 'linux',
      home: '/home/user',
      probe: fakeProbe(),
    });
    expect(await relative.scan()).toMatchObject({ kind: 'CONFIG_INVALID', reason: 'discovery_dir' });
    const { dir, remove } = tempDir();
    cleanup.push(remove);
    const file = path.join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    const unreadable = new Instances({
      env: { OPENTUNE_MCP_DISCOVERY_DIR: file },
      platform: process.platform,
      home: dir,
      probe: fakeProbe(),
    });
    expect(await unreadable.scan()).toMatchObject({ kind: 'CONFIG_INVALID' });
  });

  it('forgets a session that failed to open', async () => {
    let calls = 0;
    const instances = new Instances({
      env: {},
      platform: 'linux',
      home: '/home/user',
      probe: fakeProbe(),
      open: () => {
        calls++;
        return Promise.reject(
          new OtcpError({
            kind: 'CONNECTION_LOST',
            reason: 'connect_failed',
            retryable: true,
            detail: 'x',
            executed: false,
          }),
        );
      },
    });
    const entry = entryOf(discoveryContent(5));
    await failure(instances.session(entry));
    await failure(instances.session(entry));
    expect(calls).toBe(2);
  });
});

describe('selectInstance', () => {
  const a = entryOf(discoveryContent(11, { instanceId: `aaaaaaaa${'0'.repeat(24)}` }));
  const b = entryOf(discoveryContent(12, { instanceId: `bbbbbbbb${'0'.repeat(24)}` }));

  it('takes the only instance, or the one named', () => {
    expect(selectInstance([a], undefined)).toEqual({ ok: true, entry: a });
    expect(selectInstance([a, b], b.instanceId)).toEqual({ ok: true, entry: b });
  });

  it('never picks one of several on its own, and lists them without secrets', () => {
    const result = selectInstance([a, b], undefined);
    expect(result).toMatchObject({ ok: false, error: { kind: 'MULTIPLE_INSTANCES', nextStep: { actor: 'user' } } });
    expect(!result.ok && result.instances).toEqual([
      { instanceId: a.instanceId, pid: 11, appVersion: '1.2.3', startedAtMs: a.startedAtMs },
      { instanceId: b.instanceId, pid: 12, appVersion: '1.2.3', startedAtMs: b.startedAtMs },
    ]);
    expectNoSecrets(a, result);
    expectNoSecrets(b, result);
  });

  it('reports a stale instance_id instead of switching to another instance', () => {
    expect(selectInstance([a], b.instanceId)).toMatchObject({ ok: false, error: { kind: 'INSTANCE_NOT_FOUND' } });
  });

  it('routes by the instance part of a handle', () => {
    expect(selectInstance([a, b], undefined, 'bbbbbbbb')).toEqual({ ok: true, entry: b });
    expect(selectInstance([a], undefined, 'cccccccc')).toMatchObject({
      ok: false,
      error: { kind: 'INSTANCE_NOT_FOUND' },
    });
    expect(selectInstance([], undefined)).toMatchObject({ ok: false, error: { kind: 'OPENTUNE_NOT_AVAILABLE' } });
  });
});

describe('revision tokens', () => {
  const tokens = { content: 'r:17', grid: 'g:3', key: 'k:2', geometry: null };

  it('round-trips clip and arrangement revisions and rejects foreign values', () => {
    const encoded = encodeClipRevision(tokens);
    expect(encoded).toMatch(/^cr1\.[A-Za-z0-9_-]+$/);
    expect(decodeClipRevision(encoded)).toEqual(tokens);
    expect(decodeArrangementRevision(encodeArrangementRevision('a:9'))).toBe('a:9');
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const bad of [
      'r:17',
      'cr1.',
      'cr1.***',
      `cr1.${b64([1, 2, 3, 4])}`,
      `cr1.${b64(['a'])}`,
      'cr1.e30',
      `cr1.${b64(['', null, null, null])}`,
    ]) {
      expect(decodeClipRevision(bad), bad).toBeNull();
    }
    expect(decodeClipRevision(`cr1.${Buffer.from('{not json').toString('base64url')}`)).toBeNull();
    for (const bad of ['a:9', 'ar1.', 'ar1.!!']) expect(decodeArrangementRevision(bad)).toBeNull();
  });

  it('forwards only the aspects the operation depends on, so unrelated changes do not conflict', () => {
    const before = decodeClipRevision(encodeClipRevision(tokens));
    const afterKeyChange = decodeClipRevision(encodeClipRevision({ ...tokens, key: 'k:3' }));
    if (!before || !afterKeyChange) throw new Error('decode failed');
    // A note edit that does not use the key sends only the content revision: a key change since
    // the read leaves the forwarded value, and so the server's comparison, unchanged.
    expect(expectedParams('content.editNotes', afterKeyChange, ['content'])).toEqual({ expectedRevision: 'r:17' });
    expect(expectedParams('content.editNotes', afterKeyChange, ['content'])).toEqual(
      expectedParams('content.editNotes', before, ['content']),
    );
    expect(expectedParams('content.editNotes', before, ['content', 'key'])).toEqual({
      expectedRevision: 'r:17',
      expectedKeyRevision: 'k:2',
    });
    expect(() => expectedParams('content.setKey', before, ['content'])).toThrow(/no expected value/);
    expect(() => expectedParams('content.editTimeGrid', { ...before, grid: null }, ['grid'])).toThrow(/no grid token/);
  });

  it('knows exactly the expected-value params of each method schema', () => {
    for (const [method, aspects] of Object.entries(METHOD_ASPECTS)) {
      const schema = JSON.parse(
        readFileSync(new URL(`../../spec/otcp/v1/methods/${method}.schema.json`, import.meta.url), 'utf8'),
      ) as { $defs: { params: unknown } };
      // Member names anywhere in the params schema (some methods have one shape per op).
      const names = [...JSON.stringify(schema.$defs.params).matchAll(/"(expected[A-Za-z]+)":\{/g)].map((m) => m[1]);
      const expected = [...new Set(names)].filter((p) => p !== 'expectedUndoId');
      expect(expected.sort(), method).toEqual(aspects.map((a) => EXPECTED_PARAM[a]).sort());
    }
  });
});
