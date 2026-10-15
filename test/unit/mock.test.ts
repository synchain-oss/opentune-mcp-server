// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The test mock beyond what the vectors show: its guards (never a real OpenTune data folder, never
// an address other than 127.0.0.1, a protected discovery file), reproducibility, and the timing
// behaviours that need an injected clock (hello and idle timeouts, job.get waits, cancellation,
// stopping).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it } from 'vitest';

import { ManualClock } from '../../mock/clock.js';
import { DISCOVERY_DIR_ENV, realOpenTuneDirs, resolveDiscoveryDir } from '../../mock/discovery.js';
import { fixedResponse } from '../../mock/protocol.js';
import { otherTrustees, resolveTrustee, sddlTrusteeFields } from '../../mock/sddl.js';
import { LIMITS, startMock, type MockOptions, type OtcpMock } from '../../mock/server.js';
import { RunnerConnection } from '../contract/connection.js';
import { SPEC_ROOT, otcpSpec } from '../support/otcp-spec.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ot-mock-test-'));
  cleanup.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function mock(options: MockOptions = {}): Promise<OtcpMock> {
  const instance = await startMock({ discoveryDir: tempDir(), ...options });
  cleanup.push(() => instance.stop());
  return instance;
}

async function connect(instance: OtcpMock): Promise<RunnerConnection> {
  const conn = await RunnerConnection.open(instance.address.port);
  cleanup.push(() => {
    conn.destroy();
  });
  return conn;
}

const send = (conn: RunnerConnection, message: unknown) => {
  conn.write(Buffer.from(`${JSON.stringify(message)}\n`, 'utf8'));
};

async function read(conn: RunnerConnection): Promise<Record<string, unknown>> {
  const line = await conn.readLine(2000);
  if (typeof line === 'string') throw new Error(`no line: ${line}`);
  return JSON.parse(line.toString('utf8')) as Record<string, unknown>;
}

async function authenticated(instance: OtcpMock): Promise<RunnerConnection> {
  const conn = await connect(instance);
  const client = { name: 'mock-test', version: '1.0.0' };
  send(conn, {
    jsonrpc: '2.0',
    id: 0,
    method: 'session.hello',
    params: { token: instance.discovery.token, protocol: '1.0', client },
  });
  expect(await read(conn)).toHaveProperty('result');
  return conn;
}

/**
 * Returns once the server has handled every line sent so far: a session.info that follows them is
 * answered at once, and the server handles the lines of a connection in order, so its answer shows
 * that, for example, a job.get before it is registered as waiting. The answer is read here.
 */
async function roundTrip(conn: RunnerConnection): Promise<void> {
  send(conn, { jsonrpc: '2.0', id: 'round-trip', method: 'session.info' });
  expect(await read(conn)).toMatchObject({ id: 'round-trip', result: { flavor: 'standalone' } });
}

const closedSoon = (conn: RunnerConnection) => conn.waitClosed(performance.now() + 2000);

describe('mock guards', () => {
  it('refuses to listen anywhere but 127.0.0.1', async () => {
    for (const host of ['0.0.0.0', '::', 'localhost', '192.168.1.10']) {
      await expect(startMock({ host, discoveryDir: tempDir() })).rejects.toThrow(/only on 127\.0\.0\.1/);
    }
    const instance = await mock();
    expect(instance.address).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
  });

  it('needs an explicit discovery directory: the option or the environment variable, absolute', () => {
    expect(() => resolveDiscoveryDir(undefined, {})).toThrow(DISCOVERY_DIR_ENV);
    const dir = tempDir();
    expect(resolveDiscoveryDir(undefined, { [DISCOVERY_DIR_ENV]: dir })).toBe(path.resolve(dir));
    expect(() => resolveDiscoveryDir('relative/dir', {})).toThrow(/absolute/);
  });

  it('refuses every directory inside a real OpenTune data folder, before touching it', async () => {
    const reals = realOpenTuneDirs();
    expect(reals.length).toBeGreaterThanOrEqual(4);
    for (const real of reals) {
      const instances = path.join(real, 'control', 'instances');
      const existed = existsSync(instances);
      expect(() => resolveDiscoveryDir(instances)).toThrow(/real OpenTune data folder/);
      expect(() => resolveDiscoveryDir(undefined, { ...process.env, [DISCOVERY_DIR_ENV]: real })).toThrow(
        /real OpenTune/,
      );
      await expect(startMock({ discoveryDir: instances })).rejects.toThrow(/real OpenTune/);
      expect(existsSync(instances)).toBe(existed);
    }
    // The default Windows location, wherever LOCALAPPDATA points.
    const fakeLocal = tempDir();
    expect(realOpenTuneDirs({ LOCALAPPDATA: fakeLocal })).toContain(path.join(fakeLocal, 'OpenTune'));
    expect(() =>
      resolveDiscoveryDir(path.join(fakeLocal, 'OpenTune', 'control', 'instances'), { LOCALAPPDATA: fakeLocal }),
    ).toThrow(/real OpenTune/);
  });

  it('writes a discovery file that validates, is named after the pid, and goes away on stop', async () => {
    const instance = await mock();
    expect(path.basename(instance.discoveryPath)).toBe(`${String(process.pid)}.json`);
    const content = JSON.parse(readFileSync(instance.discoveryPath, 'utf8')) as unknown;
    expect(otcpSpec().validate('schemas/discovery-file.schema.json', content)).toEqual([]);
    expect(content).toMatchObject({ port: instance.address.port, token: instance.discovery.token });
    await instance.stop();
    expect(existsSync(instance.discoveryPath)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('creates the discovery file with mode 0600 (POSIX)', async () => {
    const instance = await mock();
    expect(statSync(instance.discoveryPath).mode & 0o777).toBe(0o600);
  });

  // A new file gets the default DACL of the process token (explicit entries for SYSTEM, Administrators and
  // the user) when its directory has nothing to inherit, as on CI runners; `/inheritance:r` cannot drop those.
  describe.runIf(process.platform === 'win32')(
    'gives only the current user access to the discovery file (Windows)',
    () => {
      const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

      const sidOf = (): string => {
        const who = spawnSync(path.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
        const sid = /,"(S-1-[0-9-]+)"\s*$/.exec(who.stdout.trim())?.[1] ?? '';
        expect(sid).not.toBe('');
        return sid;
      };

      // Reads the DACL as SDDL, which names trustees by SID and so does not depend on the console code page.
      function expectOnlyCurrentUser(file: string): void {
        const saved = path.join(tempDir(), 'acl.txt');
        expect(spawnSync(path.join(system32, 'icacls.exe'), [file, '/save', saved]).status).toBe(0);
        const sddl = readFileSync(saved).toString('utf16le');
        const dacl = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
        expect(dacl?.[1]).toContain('P');
        // One entry that grants full access, to a trustee that is the current user (the built-in
        // administrator account is written as the alias LA rather than as its SID).
        const sid = sidOf();
        expect(dacl?.[2]).toMatch(/^\(A;;FA;;;[^;()]+\)$/);
        const trustees = sddlTrusteeFields(sddl);
        expect(trustees).toHaveLength(1);
        expect(resolveTrustee(trustees[0] ?? '', sid)?.toLowerCase()).toBe(sid.toLowerCase());
      }

      it('in an ordinary temporary directory', async () => {
        expectOnlyCurrentUser((await mock()).discoveryPath);
      });

      it('in a directory with no inheritable entries', async () => {
        const dir = tempDir();
        const who = spawnSync(path.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
        const sid = /"(S-1-[0-9-]+)"\s*$/.exec(who.stdout.trim())?.[1] ?? '';
        expect(sid).not.toBe('');
        // Protected, with a plain entry that has neither (OI) nor (CI): nothing flows down to new files.
        const set = spawnSync(path.join(system32, 'icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${sid}:(F)`]);
        expect(set.status).toBe(0);
        expectOnlyCurrentUser((await mock({ discoveryDir: dir })).discoveryPath);
      });
    },
  );
});

describe('SDDL trustee resolution', () => {
  const user = 'S-1-5-21-111-222-333-1001';
  const sddl = (...trustees: string[]) => `D:PAI${trustees.map((t) => `(A;;FA;;;${t})`).join('')}`;

  it('resolves fixed aliases and explicit SIDs', () => {
    expect(resolveTrustee('SY', user)).toBe('S-1-5-18');
    expect(resolveTrustee('BA', user)).toBe('S-1-5-32-544');
    expect(resolveTrustee('S-1-5-21-9-9-9-500', user)).toBe('S-1-5-21-9-9-9-500');
  });

  it('computes machine- and domain-relative aliases from the prefix of the user SID', () => {
    expect(resolveTrustee('LA', user)).toBe('S-1-5-21-111-222-333-500');
    expect(resolveTrustee('LG', user)).toBe('S-1-5-21-111-222-333-501');
    expect(resolveTrustee('DA', user)).toBe('S-1-5-21-111-222-333-512');
    expect(resolveTrustee('DU', user)).toBe('S-1-5-21-111-222-333-513');
  });

  it('cannot compute a relative alias for a user SID outside S-1-5-21', () => {
    expect(resolveTrustee('LA', 'S-1-12-1-1-2-3-4')).toBeUndefined();
    expect(resolveTrustee('SY', 'S-1-12-1-1-2-3-4')).toBe('S-1-5-18');
  });

  it('returns undefined for an unknown alias', () => {
    expect(resolveTrustee('ZZ', user)).toBeUndefined();
  });

  it('does not list the current user, however it is written', () => {
    expect(otherTrustees(sddl(user), user)).toEqual([]);
    expect(otherTrustees(sddl('LA'), 'S-1-5-21-111-222-333-500')).toEqual([]);
  });

  it('lists every other trustee once, resolved to SIDs', () => {
    expect(otherTrustees(sddl('LA', 'SY', 'BA', 'SY', 'S-1-5-21-1-2-3-1234'), user)).toEqual([
      'S-1-5-21-111-222-333-500',
      'S-1-5-18',
      'S-1-5-32-544',
      'S-1-5-21-1-2-3-1234',
    ]);
  });

  it('names the alias it cannot resolve', () => {
    expect(() => otherTrustees(sddl('ZZ'), user)).toThrow('unrecognised trustee ZZ');
    expect(() => otherTrustees(sddl('LA'), 'S-1-12-1-1-2-3-4')).toThrow('unrecognised trustee LA');
  });
});

describe('mock reproducibility', () => {
  it('derives the instanceId from the seed; the secrets always come from the CSPRNG', async () => {
    const a = await mock({ seed: 7 });
    const b = await mock({ seed: 7 });
    const c = await mock({ seed: 8 });
    expect(a.discovery.instanceId).toBe(b.discovery.instanceId);
    expect(c.discovery.instanceId).not.toBe(a.discovery.instanceId);
    expect(a.discovery.token).not.toBe(b.discovery.token);
    expect(a.discovery.serverProof).not.toBe(b.discovery.serverProof);
  });

  it('numbers jobs from 1 under a fixed instanceId', async () => {
    const instance = await mock({ instanceId: '0123456789abcdef0123456789abcdef' });
    const bound = instance.given({
      jobs: [
        { bind: 'first', kind: 'export', state: 'running', cancellable: true },
        { bind: 'second', kind: 'projectSave', state: 'queued', cancellable: false },
      ],
    });
    expect(bound).toEqual({ first: 'j:01234567:1', second: 'j:01234567:2' });
    expect(() =>
      instance.given({ jobs: [{ bind: 'x', kind: 'projectOpen', state: 'succeeded', cancellable: false }] }),
    ).toThrow(/no result for a succeeded projectOpen job/);
  });

  it('writes the fixed responses of Appendix A byte for byte', () => {
    const protocol = readFileSync(path.join(SPEC_ROOT, 'PROTOCOL.md'), 'utf8');
    const appendix = protocol.slice(protocol.indexOf('## Appendix A'));
    const blocks = [...appendix.matchAll(/```text\n(.*)\n```/g)].map((m) => m[1] ?? '');
    expect(blocks).toHaveLength(2);
    const [auth, mismatch] = blocks.map((b) => b.replace('<id>', '1'));
    expect(fixedResponse('AUTH_FAILED', 1).toString('utf8')).toBe(`${auth ?? ''}\n`);
    expect(fixedResponse('PROTOCOL_MISMATCH', 1).toString('utf8')).toBe(`${mismatch ?? ''}\n`);
  });
});

describe('mock timing with an injected clock', () => {
  it('closes a connection without a byte when no first line arrives within the hello timeout', async () => {
    const clock = new ManualClock();
    const instance = await mock({ clock });
    const conn = await connect(instance);
    // The timer starts when the server accepts the connection, which may be a turn after the client's connect.
    await instance.whenAccepted();
    clock.advance(LIMITS.helloTimeoutMs - 1);
    expect(instance.openConnections).toBe(1);
    clock.advance(1);
    expect(instance.openConnections).toBe(0);
    expect(await closedSoon(conn)).toBe(true);
    expect(conn.receivedBytes).toBe(0);
  });

  it('closes a session without a message once it has been idle since its last request finished', async () => {
    const clock = new ManualClock();
    const instance = await mock({ clock });
    const { job } = instance.given({ jobs: [{ bind: 'job', kind: 'export', state: 'running', cancellable: true }] });
    const conn = await authenticated(instance);
    send(conn, { jsonrpc: '2.0', id: 1, method: 'job.get', params: { jobId: job, waitMs: LIMITS.jobWaitMaxMs } });
    await roundTrip(conn);
    clock.advance(LIMITS.jobWaitMaxMs);
    // The wait ended after 30 s with the job unchanged; idleness counts from then, not from the line.
    expect(await read(conn)).toMatchObject({ id: 1, result: { job: { state: 'running' } } });
    const bytes = conn.receivedBytes;
    clock.advance(LIMITS.idleTimeoutMs - 1);
    expect(instance.openConnections).toBe(1);
    clock.advance(1);
    expect(instance.openConnections).toBe(0);
    expect(await closedSoon(conn)).toBe(true);
    expect(conn.receivedBytes).toBe(bytes);
  });

  it('cancels a job at its next cancellation point and answers a waiting job.get then', async () => {
    const clock = new ManualClock();
    const instance = await mock({ clock });
    const { job } = instance.given({ jobs: [{ bind: 'job', kind: 'export', state: 'running', cancellable: true }] });
    const conn = await authenticated(instance);
    send(conn, { jsonrpc: '2.0', id: 1, method: 'job.get', params: { jobId: job, waitMs: 10_000 } });
    send(conn, { jsonrpc: '2.0', id: 2, method: 'job.cancel', params: { jobId: job } });
    expect(await read(conn)).toMatchObject({
      id: 2,
      result: { cancelRequested: true, job: { state: 'running', cancellable: false } },
    });
    send(conn, { jsonrpc: '2.0', id: 3, method: 'job.cancel', params: { jobId: job } });
    expect(await read(conn)).toMatchObject({ id: 3, result: { cancelRequested: true } });
    clock.advance(0);
    const cancelled = await read(conn);
    expect(cancelled).toMatchObject({
      id: 1,
      result: {
        job: { state: 'cancelled', finishedAtMs: clock.now(), error: { data: { reason: 'cancelled_by_request' } } },
      },
    });
    expect(otcpSpec().validate('methods/job.get.schema.json#/$defs/result', cancelled.result)).toEqual([]);
  });

  it('ends a waiting job.get with SHUTTING_DOWN when it stops', async () => {
    const clock = new ManualClock();
    const instance = await mock({ clock });
    const { job } = instance.given({ jobs: [{ bind: 'job', kind: 'export', state: 'running', cancellable: true }] });
    const conn = await authenticated(instance);
    send(conn, { jsonrpc: '2.0', id: 'w', method: 'job.get', params: { jobId: job, waitMs: 5000 } });
    await roundTrip(conn);
    const stopped = instance.stop();
    expect(await read(conn)).toMatchObject({ id: 'w', error: { data: { kind: 'SHUTTING_DOWN', executed: false } } });
    expect(await closedSoon(conn)).toBe(true);
    await stopped;
    expect(existsSync(instance.discoveryPath)).toBe(false);
  });
});
