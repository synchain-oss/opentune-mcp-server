// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveDiscoveryDir } from '../../src/discovery/dir.js';
import {
  MAX_DISCOVERY_BYTES,
  knownMembersProblem,
  parseDiscoveryFile,
  readDiscoveryBytes,
} from '../../src/discovery/file.js';
import {
  parseEpochMs,
  parsePidLines,
  parseProcStartTime,
  parseTasklist,
  pgrepPids,
  pidAlive,
  runTool,
  systemProbe,
} from '../../src/discovery/process.js';
import { scanDiscovery } from '../../src/discovery/scan.js';
import { discoveryContent, fakeProbe, tempDir } from '../support/context.js';
import { otcpSpec } from '../support/otcp-spec.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');

describe('resolveDiscoveryDir', () => {
  it('prefers the override, then OPENTUNE_DATA_DIR, then the platform default', () => {
    const env = { OPENTUNE_MCP_DISCOVERY_DIR: '/tmp/ot', OPENTUNE_DATA_DIR: '/data' };
    expect(resolveDiscoveryDir(env, 'linux', '/home/user')).toEqual({ ok: true, dir: '/tmp/ot', source: 'override' });
    expect(resolveDiscoveryDir({ OPENTUNE_DATA_DIR: '/data' }, 'darwin', '/Users/user')).toEqual({
      ok: true,
      dir: '/data/control/instances',
      source: 'dataDir',
    });
    expect(
      resolveDiscoveryDir({ LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local' }, 'win32', 'C:\\Users\\user'),
    ).toEqual({
      ok: true,
      dir: 'C:\\Users\\user\\AppData\\Local\\OpenTune\\control\\instances',
      source: 'default',
    });
    expect(resolveDiscoveryDir({}, 'win32', 'C:\\Users\\user')).toMatchObject({
      dir: 'C:\\Users\\user\\AppData\\Local\\OpenTune\\control\\instances',
    });
    expect(resolveDiscoveryDir({}, 'darwin', '/Users/user')).toMatchObject({
      dir: '/Users/user/Library/Application Support/OpenTune/control/instances',
    });
    expect(resolveDiscoveryDir({}, 'linux', '/home/user')).toMatchObject({
      dir: '/home/user/.local/state/OpenTune/control/instances',
    });
    expect(resolveDiscoveryDir({ XDG_STATE_HOME: '/state' }, 'linux', '/home/user')).toMatchObject({
      dir: '/state/OpenTune/control/instances',
    });
  });

  it('rejects a relative or drive-less override instead of ignoring it', () => {
    expect(resolveDiscoveryDir({ OPENTUNE_MCP_DISCOVERY_DIR: 'relative' }, 'linux', '/home/user')).toEqual({
      ok: false,
      variable: 'OPENTUNE_MCP_DISCOVERY_DIR',
      problem: 'OPENTUNE_MCP_DISCOVERY_DIR must be an absolute local path',
    });
    expect(resolveDiscoveryDir({ OPENTUNE_DATA_DIR: '\\data' }, 'win32', 'C:\\Users\\user')).toMatchObject({
      ok: false,
    });
  });
});

describe('parseDiscoveryFile', () => {
  it('accepts a valid file, ignores members of later versions and checks the pid against the name', () => {
    const content = discoveryContent(123, { addedLater: { x: 1 } });
    const parsed = parseDiscoveryFile('123.json', bytes(content));
    expect(parsed).toMatchObject({ ok: true, entry: { pid: 123, instanceId: content.instanceId, port: 45_678 } });
    expect(parseDiscoveryFile('124.json', bytes(content))).toEqual({
      ok: false,
      problem: 'pid differs from the file name',
    });
  });

  it('rejects files that are too large or not UTF-8 JSON, without quoting them', () => {
    const big = Buffer.from(JSON.stringify({ ...discoveryContent(1), pad: 'x'.repeat(9000) }));
    expect(parseDiscoveryFile('1.json', big)).toEqual({ ok: false, problem: 'larger than 8192 bytes' });
    expect(parseDiscoveryFile('1.json', Buffer.from([0x7b, 0xff, 0x7d]))).toEqual({
      ok: false,
      problem: 'not valid UTF-8 JSON',
    });
    const content = discoveryContent(1, { port: 'secret-looking' });
    const parsed = parseDiscoveryFile('1.json', bytes(content));
    expect(parsed).toEqual({ ok: false, problem: 'member port has the wrong type or form' });
    expect(JSON.stringify(parsed)).not.toContain(content.token as string);
  });

  // Each variant is judged by the hand-written check and by the schema's open form; they must agree.
  const variants: [string, (c: Record<string, unknown>) => unknown][] = [
    ['valid', (c) => c],
    ['an unknown member', (c) => ({ ...c, futureMember: [1, 2] })],
    ['not an object', () => [1]],
    ['majors empty', (c) => ({ ...c, protocolMajors: [] })],
    ['majors repeated', (c) => ({ ...c, protocolMajors: [1, 1] })],
    ['major 0', (c) => ({ ...c, protocolMajors: [0] })],
    ['pid 0', (c) => ({ ...c, pid: 0 })],
    ['pid 1.5', (c) => ({ ...c, pid: 1.5 })],
    ['start time negative', (c) => ({ ...c, processStartTimeMs: -1 })],
    ['instanceId upper case', (c) => ({ ...c, instanceId: (c.instanceId as string).toUpperCase() })],
    ['port 0', (c) => ({ ...c, port: 0 })],
    ['port 65536', (c) => ({ ...c, port: 65_536 })],
    ['token too short', (c) => ({ ...c, token: (c.token as string).slice(0, 30) })],
    ['token odd length', (c) => ({ ...c, token: `${c.token as string}a` })],
    ['proof too long', (c) => ({ ...c, serverProof: `${c.serverProof as string}00` })],
    ['nonce short', (c) => ({ ...c, launchNonce: 'abc' })],
    ['nonce valid', (c) => ({ ...c, launchNonce: 'abcdefghijklmnop' })],
    ['appVersion empty', (c) => ({ ...c, appVersion: '' })],
    ['appVersion 64 code points', (c) => ({ ...c, appVersion: '\u{1f3b5}'.repeat(64) })],
    ['appVersion 65 code points', (c) => ({ ...c, appVersion: 'v'.repeat(65) })],
    ['build with an extra member', (c) => ({ ...c, build: { commit: 'a'.repeat(40), tag: null, x: 1 } })],
    ['build without tag', (c) => ({ ...c, build: { commit: 'a'.repeat(40) } })],
    ['build tag string', (c) => ({ ...c, build: { commit: 'a'.repeat(40), tag: 'v1' } })],
    ['commit short', (c) => ({ ...c, build: { commit: 'abc', tag: null } })],
    ['buildTag 201', (c) => ({ ...c, buildTag: 'b'.repeat(201) })],
    ['sourceUrl http', (c) => ({ ...c, sourceUrl: 'http://example.com' })],
    ['flavor plugin', (c) => ({ ...c, flavor: 'plugin' })],
    ...[
      'protocolMajors',
      'pid',
      'processStartTimeMs',
      'instanceId',
      'port',
      'token',
      'serverProof',
      'launchNonce',
      'appVersion',
      'build',
      'buildTag',
      'sourceUrl',
      'startedAtMs',
      'flavor',
    ].map((member): [string, (c: Record<string, unknown>) => unknown] => [
      `without ${member}`,
      (c) => Object.fromEntries(Object.entries(c).filter(([key]) => key !== member)),
    ]),
  ];

  it.each(variants)('agrees with the schema for %s', (_name, mutate) => {
    const value = mutate(discoveryContent(7));
    const schemaOk = otcpSpec().validate('schemas/discovery-file.schema.json#/$defs/knownMembers', value).length === 0;
    expect(knownMembersProblem(value) === null).toBe(schemaOk);
  });
});

describe('scanDiscovery', () => {
  function setup() {
    const { dir, remove } = tempDir();
    cleanup.push(remove);
    const probe = fakeProbe();
    const write = (pid: number, content: unknown) => {
      writeFileSync(path.join(dir, `${String(pid)}.json`), JSON.stringify(content));
    };
    return { dir, probe, write };
  }

  it('reports a missing directory without creating it', async () => {
    const { dir, probe } = setup();
    const missing = path.join(dir, 'nope');
    expect(await scanDiscovery(missing, probe)).toEqual({ dir: missing, missing: true, instances: [], ignored: [] });
    expect(existsSync(missing)).toBe(false);
  });

  it('deletes the file of a process that is gone and keeps the file of a reused pid', async () => {
    const { dir, probe, write } = setup();
    write(101, discoveryContent(101));
    write(102, discoveryContent(102, { processStartTimeMs: 1_000_000 }));
    write(103, discoveryContent(103, { processStartTimeMs: 5_000_000 }));
    write(104, discoveryContent(104));
    probe.info.set(101, { alive: false, startTimeMs: null });
    probe.info.set(102, { alive: true, startTimeMs: 1_000_000 + 2001 });
    probe.info.set(103, { alive: true, startTimeMs: 5_000_000 - 1999 });
    probe.info.set(104, { alive: null, startTimeMs: null });
    const result = await scanDiscovery(dir, probe);
    expect(result.instances.map((i) => i.pid)).toEqual([103, 104]);
    expect(result.ignored).toEqual([
      { file: '101.json', reason: 'process_gone', problem: null, removed: true },
      { file: '102.json', reason: 'pid_reused', problem: null, removed: false },
    ]);
    expect(existsSync(path.join(dir, '101.json'))).toBe(false);
    expect(existsSync(path.join(dir, '102.json'))).toBe(true);
  });

  it('ignores invalid and temporary files, never deleting them', async () => {
    const { dir, probe, write } = setup();
    write(201, { pid: 201 });
    writeFileSync(path.join(dir, '.202.123.tmp'), 'partial');
    writeFileSync(path.join(dir, '0203.json'), '{}');
    mkdirSync(path.join(dir, '204.json'));
    const result = await scanDiscovery(dir, probe);
    expect(result.instances).toEqual([]);
    expect(result.ignored).toEqual([
      { file: '201.json', reason: 'invalid', problem: 'member protocolMajors is missing', removed: false },
      { file: '204.json', reason: 'unreadable', problem: null, removed: false },
    ]);
    expect(existsSync(path.join(dir, '201.json'))).toBe(true);
  });

  it('reads at most one byte more than a discovery file may have', async () => {
    const { dir, probe, write } = setup();
    const content = discoveryContent(401);
    write(401, content);
    writeFileSync(path.join(dir, '402.json'), Buffer.alloc(1024 * 1024, 0x20));
    mkdirSync(path.join(dir, '403.json'));
    expect((await readDiscoveryBytes(path.join(dir, '401.json')))?.toString('utf8')).toBe(JSON.stringify(content));
    expect((await readDiscoveryBytes(path.join(dir, '402.json')))?.length).toBe(MAX_DISCOVERY_BYTES + 1);
    expect(await readDiscoveryBytes(path.join(dir, '403.json'))).toBeNull();
    expect(await readDiscoveryBytes(path.join(dir, '404.json'))).toBeNull();
    const result = await scanDiscovery(dir, probe);
    expect(result.instances.map((i) => i.pid)).toEqual([401]);
    expect(result.ignored).toEqual([
      { file: '402.json', reason: 'invalid', problem: 'larger than 8192 bytes', removed: false },
      { file: '403.json', reason: 'unreadable', problem: null, removed: false },
    ]);
  });

  it('keeps a stale file that changed after it was judged', async () => {
    const { dir, write } = setup();
    write(301, discoveryContent(301));
    const probe = fakeProbe();
    probe.probe = () => {
      write(301, discoveryContent(301));
      return Promise.resolve({ alive: false, startTimeMs: null });
    };
    const result = await scanDiscovery(dir, probe);
    expect(result.ignored).toEqual([{ file: '301.json', reason: 'process_gone', problem: null, removed: false }]);
  });
});

describe('process probes', () => {
  it('tests existence with signal 0 only', () => {
    const calls: unknown[] = [];
    const err = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(pidAlive(5, (...args) => calls.push(args))).toBe(true);
    expect(calls).toEqual([[5, 0]]);
    expect(pidAlive(5, err('ESRCH'))).toBe(false);
    expect(pidAlive(5, err('EPERM'))).toBe(true);
    expect(pidAlive(5, err('EINVAL'))).toBeNull();
  });

  it('parses the outputs of the system tools', () => {
    const stat = '42 (my (odd) name) S 1 42 42 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 12345 1000 10';
    expect(parseProcStartTime(stat, 'cpu 1 2 3\nbtime 1760000000\n')).toBe(1_760_000_000_000 + 123_450);
    expect(parseProcStartTime(stat, 'no btime')).toBeNull();
    expect(
      parseTasklist('"OpenTune.exe","1234","Console","1","1 K"\r\n"opentune.exe","99","Console","1","1 K"\r\n'),
    ).toEqual([1234, 99]);
    expect(parseTasklist('INFO: No tasks are running which match the specified criteria.\r\n')).toEqual([]);
    expect(parsePidLines('12\n 34 \nx\n')).toEqual([12, 34]);
    expect(parseEpochMs('1760000000123.4\r\n')).toBe(1_760_000_000_123);
    expect(parseEpochMs('')).toBeNull();
    expect(parseEpochMs('nan')).toBeNull();
  });

  it('lists no OpenTune only when pgrep says nothing matched', () => {
    expect(pgrepPids({ ok: true, output: '12\n34\n' })).toEqual([12, 34]);
    expect(pgrepPids({ ok: false, exitCode: 1 })).toEqual([]);
    // pgrep missing, stopped after the time limit, or failing otherwise: cannot be determined.
    expect(pgrepPids({ ok: false, exitCode: null })).toBeNull();
    expect(pgrepPids({ ok: false, exitCode: 2 })).toBeNull();
  });

  it('reports the output, the exit status, or that a tool did not run', async () => {
    const { dir, remove } = tempDir();
    cleanup.push(remove);
    const script = path.join(dir, 'tool.mjs');
    writeFileSync(
      script,
      "const code = Number(process.argv[2]); if (code === 0) console.log('12'); process.exit(code);\n",
    );
    expect(await runTool(process.execPath, [script, '0'])).toEqual({
      ok: true,
      output: expect.stringMatching(/^12\r?\n$/) as unknown,
    });
    expect(await runTool(process.execPath, [script, '1'])).toEqual({ ok: false, exitCode: 1 });
    expect(await runTool(path.join(dir, 'missing-tool'), [])).toEqual({ ok: false, exitCode: null });
  }, 20_000);

  it('reads this process: alive, started when Node started', async () => {
    const probe = systemProbe();
    // The first read can start PowerShell cold on a loaded Windows runner and run out of the probe's
    // 5 s limit: it then reports startTimeMs null, which is not cached. Ask again (the system is warm
    // by then) before judging, so a slow runner passes while a probe that never answers still fails.
    let self = await probe.probe(process.pid);
    for (let attempt = 1; attempt < 3 && self.startTimeMs === null; attempt++) self = await probe.probe(process.pid);
    expect(self.alive).toBe(true);
    if (process.platform === 'win32' || process.platform === 'linux') expect(self.startTimeMs).not.toBeNull();
    if (self.startTimeMs !== null) expect(Math.abs(self.startTimeMs - performance.timeOrigin)).toBeLessThan(2000);
    expect(await probe.probe(process.pid)).toEqual(self);
    expect((await probe.probe(2 ** 31 - 2)).alive).toBe(false);
    const list = await probe.listOpenTune();
    expect(list === null || Array.isArray(list)).toBe(true);
  }, 40_000);
});
