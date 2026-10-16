// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DOCTOR_CHECK_IDS,
  doctorExitCode,
  formatDoctor,
  redactHome,
  runDoctor,
  type DoctorDeps,
} from '../../src/cli/doctor.js';
import { isWsl } from '../../src/launch/config.js';
import { discoveryContent, tempDir } from '../support/context.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** A home directory with an isolated discovery directory inside it. */
function setup(env: NodeJS.ProcessEnv = {}): DoctorDeps & { discovery: string } {
  const { dir, remove } = tempDir();
  cleanup.push(remove);
  const discovery = path.join(dir, 'instances');
  return {
    env: { OPENTUNE_MCP_DISCOVERY_DIR: discovery, ...env },
    platform: process.platform,
    home: dir,
    nodeVersion: 'v22.12.0',
    osRelease: null,
    officialInstall: () => Promise.resolve(null),
    discovery,
  };
}

const byId = <T extends { id: string }>(checks: readonly T[], id: string) => checks.find((c) => c.id === id);

describe('doctor', () => {
  it('lists every check id in a stable order, none left as not implemented', async () => {
    const checks = await runDoctor(setup());
    expect(checks.map((c) => c.id)).toEqual(DOCTOR_CHECK_IDS);
    expect(checks.some((c) => c.status === 'not_implemented')).toBe(false);
    for (const c of checks) expect(c.url).toMatch(new RegExp(`#doctor-${c.id.toLowerCase()}$`));
    expect(byId(checks, 'OT_NODE_VERSION')?.status).toBe('pass');
    expect(byId(checks, 'OT_WSL_RUNTIME')?.status).toBe('pass');
    expect(byId(checks, 'OT_DISCOVERY_DIR')).toMatchObject({
      status: 'warn',
      message: expect.stringMatching(/does not exist yet/) as unknown,
    });
    expect(byId(checks, 'OT_OPENTUNE_PATH')).toMatchObject({
      status: 'warn',
      message: expect.stringMatching(/is not set/) as unknown,
    });
    expect(doctorExitCode(checks)).toBe(0);
  });

  it('fails on an old Node.js, WSL and a bad executable path', async () => {
    const deps = {
      ...setup({ OPENTUNE_MCP_OPENTUNE_PATH: 'relative.exe', WSL_DISTRO_NAME: 'Ubuntu' }),
      platform: 'linux' as const,
      nodeVersion: 'v20.1.0',
    };
    const checks = await runDoctor(deps);
    expect(byId(checks, 'OT_NODE_VERSION')?.status).toBe('fail');
    expect(byId(checks, 'OT_WSL_RUNTIME')?.status).toBe('fail');
    expect(byId(checks, 'OT_OPENTUNE_PATH')).toMatchObject({
      status: 'fail',
      message: expect.stringMatching(/not absolute/) as unknown,
    });
    expect(doctorExitCode(checks)).toBe(1);
  });

  it('treats an empty WSL variable as unset and falls through to the next one', () => {
    expect(isWsl({ WSL_DISTRO_NAME: '', WSL_INTEROP: '/run/WSL/1_interop' }, 'linux', null)).toBe(true);
    expect(isWsl({ WSL_DISTRO_NAME: '', WSL_INTEROP: '' }, 'linux', null)).toBe(false);
    expect(isWsl({}, 'linux', '5.15.0-microsoft-standard-WSL2')).toBe(true);
    expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, 'win32', null)).toBe(false);
  });

  it('accepts an API build and rejects one without a manifest', async () => {
    const base = setup();
    const bin = path.join(base.home, 'bin');
    mkdirSync(bin);
    const exe = path.join(bin, 'OpenTune.exe');
    writeFileSync(exe, '');
    const without = await runDoctor({ ...base, env: { ...base.env, OPENTUNE_MCP_OPENTUNE_PATH: exe } });
    expect(byId(without, 'OT_OPENTUNE_PATH')).toMatchObject({
      status: 'fail',
      message: expect.stringMatching(/manifest missing/) as unknown,
    });
    writeFileSync(path.join(bin, 'opentune-control.json'), '{"protocolMajors":[1]}');
    const ok = await runDoctor({ ...base, env: { ...base.env, OPENTUNE_MCP_OPENTUNE_PATH: exe } });
    expect(byId(ok, 'OT_OPENTUNE_PATH')).toMatchObject({
      status: 'pass',
      message: `OPENTUNE_MCP_OPENTUNE_PATH = ${path.join('~', 'bin', 'OpenTune.exe')}, a build with the control API.`,
    });
  });

  it('lists discovery files with the token only as present, and hides the home directory', async () => {
    const deps = setup();
    mkdirSync(deps.discovery);
    const content = discoveryContent(321);
    writeFileSync(path.join(deps.discovery, '321.json'), JSON.stringify(content));
    writeFileSync(path.join(deps.discovery, '322.json'), '{}');
    writeFileSync(path.join(deps.discovery, '323.json'), Buffer.alloc(1024 * 1024, 0x20));
    const checks = await runDoctor(deps);
    const discovery = byId(checks, 'OT_DISCOVERY_DIR');
    expect(discovery?.status).toBe('pass');
    expect(discovery?.message).toContain(
      `321.json: instance ${content.instanceId as string}, OpenTune "1.2.3", token present (redacted)`,
    );
    expect(discovery?.message).toContain('322.json: ignored (member protocolMajors is missing)');
    expect(discovery?.message).toContain('323.json: ignored (larger than 8192 bytes)');
    for (const json of [false, true]) {
      const out = formatDoctor(checks, json);
      expect(out).not.toContain(content.token as string);
      expect(out).not.toContain(content.serverProof as string);
      expect(out).not.toContain(deps.home);
    }
    expect(JSON.parse(formatDoctor(checks, true))).toMatchObject({
      name: 'opentune-mcp',
      checks: expect.any(Array) as unknown,
    });
    expect(formatDoctor(checks, false)).toMatch(
      /^opentune-mcp doctor .+\nPASS {2}OT_NODE_VERSION {2,}Node\.js v22\.12\.0/,
    );
  });

  it('reports the official installation on Windows only, and its absence as a warning', async () => {
    const base = { ...setup(), platform: 'win32' as const };
    const dir = `${base.home}\\Programs\\OpenTune`;
    const found = await runDoctor({
      ...base,
      officialInstall: () => Promise.resolve({ dir, version: '1.8.0', source: 'registry' }),
    });
    expect(byId(found, 'OT_NO_OFFICIAL_INSTALL')).toMatchObject({
      status: 'pass',
      message: expect.stringMatching(
        /^Official OpenTune installation in ~\\Programs\\OpenTune \(version "1\.8\.0", found by its uninstall entry\)/,
      ) as unknown,
    });
    const folder = await runDoctor({
      ...base,
      officialInstall: () => Promise.resolve({ dir, version: null, source: 'folder' }),
    });
    expect(byId(folder, 'OT_NO_OFFICIAL_INSTALL')?.message).toMatch(/\(version unknown, found by its install folder\)/);
    for (const officialInstall of [() => Promise.resolve(null), () => Promise.reject(new Error('reg failed'))]) {
      const missing = await runDoctor({ ...base, officialInstall });
      expect(byId(missing, 'OT_NO_OFFICIAL_INSTALL')).toMatchObject({
        status: 'warn',
        message: expect.stringMatching(
          /^No official OpenTune installation was found .+ This is not an error;/,
        ) as unknown,
      });
    }
    let asked = false;
    const elsewhere = await runDoctor({
      ...base,
      platform: 'linux',
      officialInstall: () => {
        asked = true;
        return Promise.resolve(null);
      },
    });
    expect(byId(elsewhere, 'OT_NO_OFFICIAL_INSTALL')).toMatchObject({
      status: 'warn',
      message: expect.stringMatching(/^Not checked: .+ on Windows only\.$/) as unknown,
    });
    expect(asked).toBe(false);
  });

  it('reports an unusable discovery directory', async () => {
    const deps = setup({ OPENTUNE_MCP_DISCOVERY_DIR: 'relative' });
    expect(byId(await runDoctor(deps), 'OT_DISCOVERY_DIR')?.status).toBe('fail');
    const file = setup();
    writeFileSync(file.discovery, 'not a directory');
    expect(byId(await runDoctor(file), 'OT_DISCOVERY_DIR')?.status).toBe('fail');
  });

  it('redacts the home directory, ignoring case on Windows only', () => {
    expect(redactHome('C:\\Users\\user\\x and c:\\users\\user\\y', 'C:\\Users\\user', 'win32')).toBe('~\\x and ~\\y');
    expect(redactHome('/home/user/x /HOME/USER/y', '/home/user', 'linux')).toBe('~/x /HOME/USER/y');
    expect(redactHome('/x', '/', 'linux')).toBe('/x');
  });
});
