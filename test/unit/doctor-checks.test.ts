// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runDoctor, type DoctorDeps } from '../../src/cli/doctor.js';
import {
  REQUIRED_MODELS,
  d3d12Check,
  modelsCheck,
  parseVersion,
  shadowedCheck,
  sidecarCheck,
  versionCheck,
  type DoctorFs,
} from '../../src/cli/doctor-checks.js';
import type { OfficialInstall } from '../../src/launch/install.js';
import { tempDir } from '../support/context.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const win = path.win32;
const key = (p: string) => win.normalize(p).toLowerCase();

/** An in-memory Windows file system: keys are paths, values the file content. */
function memoryFs(files: Record<string, string>): DoctorFs {
  const map = new Map(Object.entries(files).map(([p, c]) => [key(p), c]));
  const isDir = (p: string) => [...map.keys()].some((k) => k.startsWith(`${key(p)}\\`));
  return {
    stat: (p) => {
      const content = map.get(key(p));
      if (content !== undefined) return Promise.resolve({ isFile: true, isDirectory: false, size: content.length });
      return Promise.resolve(isDir(p) ? { isFile: false, isDirectory: true, size: 0 } : null);
    },
    readFile: (p, max) => {
      const content = map.get(key(p));
      return Promise.resolve(content === undefined ? null : Buffer.from(content).subarray(0, max));
    },
    sha256: (p) => {
      const content = map.get(key(p));
      return Promise.resolve(content === undefined ? null : sha(content));
    },
    list: (p) =>
      Promise.resolve(
        isDir(p)
          ? [...map.keys()]
              .filter((k) => k.startsWith(`${key(p)}\\`))
              .map((k) => k.slice(key(p).length + 1).split('\\')[0] ?? '')
          : null,
      ),
  };
}

const PROGRAM_DATA = 'C:\\ProgramData';
const modelFiles = (dir: string) => Object.fromEntries(REQUIRED_MODELS.map((p) => [win.join(dir, ...p), 'weights']));
const install = (version: string | null, dir = 'C:\\Program Files\\OpenTune'): OfficialInstall => ({
  dir,
  version,
  source: 'registry',
});

describe('version check', () => {
  it('parses leading version numbers', () => {
    expect(parseVersion('1.8.1')).toEqual([1, 8, 1]);
    expect(parseVersion('v1.7.9-beta')).toEqual([1, 7, 9]);
    expect(parseVersion('2.0')).toEqual([2, 0, 0]);
    expect(parseVersion('abc')).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });

  it('passes from 1.7.9, fails below it, cannot tell without a version or installation', () => {
    expect(versionCheck(install('1.7.9'), true).status).toBe('pass');
    expect(versionCheck(install('1.8.1'), true).status).toBe('pass');
    expect(versionCheck(install('1.10.0'), true).status).toBe('pass');
    expect(versionCheck(install('2.0.0'), true).status).toBe('pass');
    const old = versionCheck(install('1.7.8'), true);
    expect(old).toMatchObject({ status: 'fail', message: expect.stringContaining('"1.7.8"') as unknown });
    expect(versionCheck(install('1.6.0'), true).status).toBe('fail');
    expect(versionCheck(install(null), true).message).toMatch(/^Cannot tell/);
    expect(versionCheck(install('nightly'), true).status).toBe('warn');
    expect(versionCheck(null, true).message).toMatch(/^Not checked: no official/);
    expect(versionCheck(null, false).message).toMatch(/on Windows only/);
  });
});

describe('models check', () => {
  const env = { ProgramData: PROGRAM_DATA };
  const shared = win.join(PROGRAM_DATA, 'OpenTune', 'Models');

  it('looks in the shared folder from 1.8 and in the install folder for 1.7', async () => {
    const fs = memoryFs({ ...modelFiles(shared) });
    expect(await modelsCheck(install('1.8.1'), { env, fs }, true)).toMatchObject({
      status: 'pass',
      message: expect.stringContaining(shared) as unknown,
    });
    const own = 'C:\\Program Files\\OpenTune\\models';
    const old = memoryFs({ ...modelFiles(own) });
    expect((await modelsCheck(install('1.7.9'), { env, fs: old }, true)).status).toBe('pass');
    // 1.7.9 does not look in the shared folder, and 1.8.1 not in the install folder.
    const wrong = await modelsCheck(install('1.7.9'), { env, fs }, true);
    expect(wrong.status).toBe('fail');
    expect(wrong.message).toContain(own);
    expect((await modelsCheck(install('1.8.1'), { env, fs: old }, true)).status).toBe('fail');
  });

  it('lists what is missing or empty', async () => {
    const files = modelFiles(shared);
    Reflect.deleteProperty(files, win.join(shared, 'GAME', 'encoder.onnx'));
    files[win.join(shared, 'fcpe.onnx')] = '';
    const result = await modelsCheck(install('1.8.1'), { env, fs: memoryFs(files) }, true);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('fcpe.onnx, GAME\\encoder.onnx');
    expect(result.message).not.toContain('segmenter');
  });

  it('uses the default program-data folder, tries both folders without a version, and defers otherwise', async () => {
    const fs = memoryFs({ ...modelFiles(shared) });
    expect((await modelsCheck(install(null), { env: {}, fs }, true)).status).toBe('pass');
    const none = await modelsCheck(install(null), { env, fs: memoryFs({}) }, true);
    expect(none).toMatchObject({ status: 'warn', message: expect.stringMatching(/^Cannot tell/) as unknown });
    expect((await modelsCheck(null, { env, fs }, true)).message).toMatch(/^Not checked/);
    expect((await modelsCheck(install('1.8.1'), { env, fs }, false)).message).toMatch(/^Not checked/);
  });
});

describe('side-car check', () => {
  const exeDir = 'C:\\Tools\\OpenTune-test';
  const deps = (files: Record<string, string>) => ({ platform: 'win32' as const, fs: memoryFs(files) });
  const sums = (entries: Record<string, string>) =>
    Object.entries(entries)
      .map(([name, content]) => `${sha(content)}  ${name}`)
      .join('\n');
  const build = {
    [win.join(exeDir, 'OpenTune.exe')]: 'exe',
    [win.join(exeDir, 'opentune-control.json')]: '{}',
    [win.join(exeDir, 'plugins', 'a.dll')]: 'dll',
  };
  const listing = (files: Record<string, string>) => ({
    [win.join(exeDir, 'SHA256SUMS')]: sums({
      'OpenTune.exe': files[win.join(exeDir, 'OpenTune.exe')] ?? '',
      'opentune-control.json': '{}',
      'plugins/a.dll': 'dll',
    }),
    ...files,
  });

  it('passes when every listed file matches', async () => {
    const result = await sidecarCheck(exeDir, deps(listing(build)));
    expect(result).toMatchObject({ status: 'pass', message: expect.stringContaining('All 3 files') as unknown });
  });

  it('fails on a missing or changed file and names it', async () => {
    const files = listing(build);
    Reflect.deleteProperty(files, win.join(exeDir, 'plugins', 'a.dll'));
    files[win.join(exeDir, 'OpenTune.exe')] = 'tampered';
    const result = await sidecarCheck(exeDir, deps(files));
    expect(result.status).toBe('fail');
    expect(result.message).toContain('missing: plugins\\a.dll');
    expect(result.message).toContain('hash differs: OpenTune.exe');
  });

  it('warns that it cannot verify without SHA256SUMS', async () => {
    expect(await sidecarCheck(exeDir, deps(build))).toMatchObject({
      status: 'warn',
      message: expect.stringMatching(/^Cannot verify: there is no SHA256SUMS/) as unknown,
    });
  });

  it('rejects unusable lines, paths that leave the folder, and an empty list', async () => {
    const hash = sha('x');
    for (const line of [
      'not a checksum line',
      `${hash}  ..\\outside.dll`,
      `${hash}  /abs.dll`,
      `${hash}  C:\\abs.dll`,
      `${hash}  a//b.dll`,
    ]) {
      const result = await sidecarCheck(exeDir, deps({ [win.join(exeDir, 'SHA256SUMS')]: line }));
      expect(result.status, line).toBe('fail');
      expect(result.message).toContain('unusable line');
    }
    const empty = await sidecarCheck(exeDir, deps({ [win.join(exeDir, 'SHA256SUMS')]: '\n' }));
    expect(empty).toMatchObject({ status: 'fail', message: expect.stringContaining('lists no files') as unknown });
  });

  it('accepts binary-mode lines and upper-case hashes, and limits long lists', async () => {
    const files = { [win.join(exeDir, 'a.bin')]: 'a' };
    const ok = await sidecarCheck(
      exeDir,
      deps({ ...files, [win.join(exeDir, 'SHA256SUMS')]: `${sha('a').toUpperCase()} *a.bin\r\n` }),
    );
    expect(ok.status).toBe('pass');
    const many = Array.from({ length: 12 }, (_, i) => `${sha('z')}  f${String(i)}.bin`).join('\n');
    const result = await sidecarCheck(exeDir, deps({ [win.join(exeDir, 'SHA256SUMS')]: many }));
    expect(result.message).toContain('and 2 more');
  });

  it('refuses an oversized list and defers without a usable build', async () => {
    const huge = 'x'.repeat(1024 * 1024 + 1);
    expect((await sidecarCheck(exeDir, deps({ [win.join(exeDir, 'SHA256SUMS')]: huge }))).status).toBe('fail');
    expect((await sidecarCheck(null, deps({}))).message).toMatch(/^Not checked/);
  });
});

describe('shadowed models check', () => {
  const exeDir = 'C:\\Tools\\OpenTune-test';
  const deps = (files: Record<string, string>) => ({ platform: 'win32' as const, fs: memoryFs(files) });

  it('passes without a models folder next to the executable', async () => {
    expect(await shadowedCheck(exeDir, deps({ [win.join(exeDir, 'OpenTune.exe')]: 'x' }))).toMatchObject({
      status: 'pass',
    });
  });

  it('warns when the folder exists, complete or not', async () => {
    const complete = await shadowedCheck(exeDir, deps(modelFiles(win.join(exeDir, 'models'))));
    expect(complete.status).toBe('warn');
    expect(complete.message).toContain('holds all required model files');
    const partial = await shadowedCheck(exeDir, deps({ [win.join(exeDir, 'models', 'fcpe.onnx')]: 'w' }));
    expect(partial.status).toBe('warn');
    expect(partial.message).toContain('GAME\\bd2dur.onnx');
    const file = await shadowedCheck(exeDir, deps({ [win.join(exeDir, 'models')]: 'a file' }));
    expect(file.message).toContain('not a folder');
  });

  it('defers without a usable build', async () => {
    expect((await shadowedCheck(null, deps({}))).message).toMatch(/^Not checked/);
  });
});

describe('Direct3D 12 check', () => {
  const exeDir = 'C:\\Tools\\OpenTune-test';
  const official = 'C:\\Program Files\\OpenTune';
  const manifest = (d3d12: unknown) => JSON.stringify({ protocolMajors: [1], d3d12 });
  const entry = { bundled: false, directory: 'D3D12', files: [{ name: 'D3D12Core.dll', sha256: sha('core') }] };
  const run = (files: Record<string, string>, officialDir: string | null = official) =>
    d3d12Check(exeDir, { platform: 'win32', fs: memoryFs(files), officialDir });
  const manifestAt = (content: string) => ({ [win.join(exeDir, 'opentune-control.json')]: content });

  it('passes when the file is copied and matches', async () => {
    const result = await run({ ...manifestAt(manifest(entry)), [win.join(exeDir, 'D3D12', 'D3D12Core.dll')]: 'core' });
    expect(result.status).toBe('pass');
  });

  it('warns with the copy commands when not copied', async () => {
    const result = await run(manifestAt(manifest(entry)));
    expect(result.status).toBe('warn');
    expect(result.message).toBe(
      [
        'Not copied: D3D12Core.dll. Without it OpenTune runs on the CPU. To copy it, run in PowerShell:',
        "New-Item -ItemType Directory -Force -Path 'C:\\Tools\\OpenTune-test\\D3D12' | Out-Null",
        "Copy-Item -LiteralPath 'C:\\Program Files\\OpenTune\\D3D12\\D3D12Core.dll' -Destination 'C:\\Tools\\OpenTune-test\\D3D12\\D3D12Core.dll'",
        "(Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\\Tools\\OpenTune-test\\D3D12\\D3D12Core.dll').Hash",
        'then compare the printed hash with the entry in opentune-control.json.',
      ].join('\n'),
    );
  });

  it('uses a placeholder for the official folder when there is no installation', async () => {
    const result = await run(manifestAt(manifest(entry)), null);
    expect(result.message).toContain("'<official OpenTune folder>\\D3D12\\D3D12Core.dll'");
  });

  it('fails when the copied file has another hash', async () => {
    const result = await run({ ...manifestAt(manifest(entry)), [win.join(exeDir, 'D3D12', 'D3D12Core.dll')]: 'other' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Delete the D3D12 folder to run on the CPU');
  });

  it('warns about the debug layer even when the runtime is copied', async () => {
    const result = await run({
      ...manifestAt(manifest(entry)),
      [win.join(exeDir, 'D3D12', 'D3D12Core.dll')]: 'core',
      [win.join(exeDir, 'D3D12', 'D3D12SDKLayers.dll')]: 'layers',
    });
    expect(result.status).toBe('warn');
    expect(result.message).toContain('debug layer');
  });

  it('has nothing to do for bundled or absent entries, and cannot tell for broken ones', async () => {
    expect((await run(manifestAt(manifest({ bundled: true })))).status).toBe('pass');
    expect((await run(manifestAt('{"protocolMajors":[1]}'))).message).toContain('no d3d12 entry');
    for (const bad of [
      'null',
      { bundled: 'no' },
      { bundled: false, directory: '..', files: [] },
      { bundled: false, directory: 'a\\b', files: [] },
      { bundled: false, directory: 'D3D12', files: [{ name: '..\\x.dll', sha256: 'x' }] },
      { bundled: false, directory: 'D3D12', files: 'x' },
    ]) {
      const content = bad === 'null' ? '{"d3d12":null}' : manifest(bad);
      expect((await run(manifestAt(content))).message, JSON.stringify(bad)).toMatch(/^Cannot tell/);
    }
    expect((await run(manifestAt('not json'))).message).toMatch(/^Cannot tell/);
    expect((await run({})).message).toMatch(/^Cannot tell/);
    expect((await d3d12Check(null, { platform: 'win32', fs: memoryFs({}), officialDir: null })).message).toMatch(
      /^Not checked/,
    );
  });
});

describe('doctor with the new checks', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });

  function setup(): DoctorDeps & { bin: string } {
    const { dir, remove } = tempDir();
    cleanup.push(remove);
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'OpenTune.exe'), '');
    return {
      env: {
        OPENTUNE_MCP_DISCOVERY_DIR: path.join(dir, 'instances'),
        OPENTUNE_MCP_OPENTUNE_PATH: path.join(bin, 'OpenTune.exe'),
      },
      platform: process.platform,
      home: dir,
      nodeVersion: 'v22.12.0',
      osRelease: null,
      officialInstall: () => Promise.resolve(null),
      bin,
    };
  }
  const byId = (checks: { id: string; status: string; message: string }[], id: string) =>
    checks.find((c) => c.id === id) ?? { id, status: 'missing', message: '' };

  it('checks a real side-car folder and hides the home directory', async () => {
    const deps = setup();
    writeFileSync(path.join(deps.bin, 'opentune-control.json'), '{"protocolMajors":[1]}');
    writeFileSync(
      path.join(deps.bin, 'SHA256SUMS'),
      `${sha('')}  OpenTune.exe\n${sha('{"protocolMajors":[1]}')}  opentune-control.json\n`,
    );
    mkdirSync(path.join(deps.bin, 'models'));
    const checks = await runDoctor(deps);
    expect(byId(checks, 'OT_SIDECAR_INCOMPLETE').status).toBe('pass');
    expect(byId(checks, 'OT_MODELS_SHADOWED')).toMatchObject({ status: 'warn' });
    expect(byId(checks, 'OT_MODELS_SHADOWED').message).toContain(path.join('~', 'bin', 'models'));
    expect(byId(checks, 'OT_D3D12_NOT_COPIED').status).toBe('pass');
    writeFileSync(path.join(deps.bin, 'OpenTune.exe'), 'changed');
    const changed = byId(await runDoctor(deps), 'OT_SIDECAR_INCOMPLETE');
    expect(changed.status).toBe('fail');
    expect(JSON.stringify(changed)).not.toContain(deps.home);
  });

  it('warns that a build without SHA256SUMS cannot be verified, and checks the official install on Windows', async () => {
    const deps = setup();
    writeFileSync(path.join(deps.bin, 'opentune-control.json'), '{"protocolMajors":[1]}');
    const none = await runDoctor(deps);
    expect(byId(none, 'OT_SIDECAR_INCOMPLETE').message).toMatch(/^Cannot verify/);
    expect(byId(none, 'OT_VERSION_UNSUPPORTED').message).toMatch(/^Not checked/);
    const win32 = await runDoctor({
      ...deps,
      platform: 'win32',
      env: { ...deps.env, ProgramData: 'C:\\ProgramData' },
      officialInstall: () => Promise.resolve(install('1.7.0')),
      fs: memoryFs({}),
    });
    expect(byId(win32, 'OT_VERSION_UNSUPPORTED').status).toBe('fail');
    expect(byId(win32, 'OT_MODELS_MISSING').status).toBe('fail');
  });
});
