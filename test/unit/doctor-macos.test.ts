// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The doctor checks on macOS (platform darwin): the official app in /Applications, its models, the
// models folders of the test build itself, what does not apply, and the hint for a path inside the
// app bundle. The file systems are in memory (POSIX paths), so the tests run on every host; only
// the ones that read real files are skipped on Windows, where a POSIX path is not absolute.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runDoctor, type DoctorDeps } from '../../src/cli/doctor.js';
import {
  MIN_OFFICIAL_VERSION_MACOS,
  REQUIRED_MODELS,
  d3d12Check,
  macOfficialModelDirs,
  modelsCheck,
  shadowedCheck,
  sidecarCheck,
  versionCheck,
  type DoctorFs,
} from '../../src/cli/doctor-checks.js';
import { MAC_APP, type OfficialInstall } from '../../src/launch/install.js';
import { tempDir } from '../support/context.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** An in-memory POSIX file system: keys are absolute paths, values the file content. */
function posixFs(files: Record<string, string>): DoctorFs {
  const entries = new Map(Object.entries(files));
  const isDir = (p: string) => [...entries.keys()].some((k) => k.startsWith(`${p}/`));
  return {
    stat: (p) => {
      const content = entries.get(p);
      if (content !== undefined) return Promise.resolve({ isFile: true, isDirectory: false, size: content.length });
      return Promise.resolve(isDir(p) ? { isFile: false, isDirectory: true, size: 0 } : null);
    },
    readFile: (p, max) => {
      const content = entries.get(p);
      return Promise.resolve(content === undefined ? null : Buffer.from(content).subarray(0, max));
    },
    sha256: (p) => {
      const content = entries.get(p);
      return Promise.resolve(content === undefined ? null : sha(content));
    },
    list: (p) =>
      Promise.resolve(
        isDir(p)
          ? [
              ...new Set(
                [...entries.keys()]
                  .filter((k) => k.startsWith(`${p}/`))
                  .map((k) => k.slice(p.length + 1).split('/')[0]),
              ),
            ].filter((n): n is string => n !== undefined)
          : null,
      ),
  };
}

const bundle = (version: string | null): OfficialInstall => ({ dir: MAC_APP, version, source: 'bundle' });
const inApp = `${MAC_APP}/Contents/Resources/models`;
const shared = '/Library/Application Support/OpenTune/models';
const withModels = (dir: string) =>
  Object.fromEntries(REQUIRED_MODELS.map((parts) => [`${dir}/${parts.join('/')}`, 'w']));
const env = {};

describe('doctor on macOS: version of the official app', () => {
  it('needs 1.8.0 or later, the oldest official macOS release the test build is checked against', () => {
    expect(MIN_OFFICIAL_VERSION_MACOS).toBe('1.8.0');
    expect(versionCheck(bundle('1.8.0'), 'darwin')).toMatchObject({
      status: 'pass',
      message: 'Official OpenTune "1.8.0" is supported (1.8.0 or later).',
    });
    expect(versionCheck(bundle('1.8.2'), 'darwin').status).toBe('pass');
    // 1.7.9 is supported on Windows, but not on macOS.
    const old = versionCheck(bundle('1.7.9'), 'darwin');
    expect(old).toMatchObject({ status: 'fail', message: expect.stringContaining('1.8.0') as unknown });
    expect(versionCheck(bundle('1.7.9'), 'win32').status).toBe('pass');
    expect(versionCheck(bundle(null), 'darwin').message).toMatch(
      /^Cannot tell: .*\/Applications\/OpenTune\.app.* 1\.8\.0\./,
    );
    expect(versionCheck(null, 'darwin').message).toMatch(/^Not checked: no official/);
    expect(versionCheck(bundle('1.8.0'), 'linux').message).toMatch(/on Windows and macOS only/);
  });
});

describe('doctor on macOS: models of the official app', () => {
  it('looks in the app first, then in /Applications/OpenTune/models and the shared folder', async () => {
    expect(macOfficialModelDirs(bundle('1.8.1'))).toEqual([inApp, '/Applications/OpenTune/models', shared]);
    for (const dir of [inApp, '/Applications/OpenTune/models', shared]) {
      const fs = posixFs(withModels(dir));
      expect(await modelsCheck(bundle('1.8.1'), { env, fs }, 'darwin')).toEqual({
        status: 'pass',
        message: `Required model files present in ${dir}: fcpe.onnx.`,
      });
    }
  });

  it('checks the first folder that exists, as OpenTune uses it, even when a later folder is complete', async () => {
    const fs = posixFs({ [`${inApp}/readme.txt`]: 'x', ...withModels(shared) });
    const result = await modelsCheck(bundle('1.8.1'), { env, fs }, 'darwin');
    expect(result.status).toBe('fail');
    expect(result.message).toContain(`${inApp} lacks or has empty fcpe.onnx`);
    expect(result.message).toContain('first folder that exists');
    // An empty file does not count either.
    const empty = await modelsCheck(bundle('1.8.1'), { env, fs: posixFs({ [`${inApp}/fcpe.onnx`]: '' }) }, 'darwin');
    expect(empty.status).toBe('fail');
  });

  it('does not ask for the note segmentation models (the GAME folder)', async () => {
    const fs = posixFs({ [`${inApp}/fcpe.onnx`]: 'w' });
    expect((await modelsCheck(bundle('1.8.1'), { env, fs }, 'darwin')).status).toBe('pass');
  });

  it('fails and names every folder it looked in when there is none, and defers without the app', async () => {
    const none = await modelsCheck(bundle('1.8.1'), { env, fs: posixFs({}) }, 'darwin');
    expect(none.status).toBe('fail');
    for (const dir of [inApp, '/Applications/OpenTune/models', shared]) expect(none.message).toContain(dir);
    // The folder does not depend on the version, so an unknown version is not a reason to doubt.
    expect((await modelsCheck(bundle(null), { env, fs: posixFs({}) }, 'darwin')).status).toBe('fail');
    expect((await modelsCheck(null, { env, fs: posixFs(withModels(inApp)) }, 'darwin')).message).toMatch(
      /^Not checked: no official/,
    );
  });
});

describe('doctor on macOS: models folders of the build itself', () => {
  const folder = '/Users/user/OpenTune-test/OpenTune-1.8.0-ctl.3-unofficial-macos-arm64';
  const app = `${folder}/OpenTune-ctl.app/Contents`;
  const deps = (files: Record<string, string>) => ({ platform: 'darwin' as const, fs: posixFs(files) });

  it('passes when neither the executable nor an app bundle beside it has a models folder', async () => {
    const files = { [`${folder}/OpenTune-AI.command`]: '#!/bin/sh', [`${app}/MacOS/OpenTune`]: 'x' };
    expect(await shadowedCheck(folder, deps(files))).toEqual({
      status: 'pass',
      message: 'No models folder next to the executable or in an app bundle beside it.',
    });
    expect(await shadowedCheck(`${app}/MacOS`, deps(files))).toMatchObject({ status: 'pass' });
  });

  it('finds the folders OpenTune looks at before the installed models', async () => {
    // The configured program is the executable inside the app: next to it, then ../Resources/models.
    const next = await shadowedCheck(`${app}/MacOS`, deps(withModels(`${app}/MacOS/models`)));
    expect(next.status).toBe('warn');
    expect(next.message).toContain(`${app}/MacOS/models exists`);
    expect(next.message).toContain('holds all required model files');
    const resources = await shadowedCheck(`${app}/MacOS`, deps({ [`${app}/Resources/models/fcpe.onnx`]: '' }));
    expect(resources.status).toBe('warn');
    expect(resources.message).toContain(`${app}/Resources/models exists`);
    expect(resources.message).toContain('lacks or has empty fcpe.onnx');
    // The configured program is the script beside the app: the bundles in its folder are looked into.
    const bundled = await shadowedCheck(folder, deps({ [`${app}/Resources/models/readme.txt`]: 'x' }));
    expect(bundled.status).toBe('warn');
    expect(bundled.message).toContain(`${app}/Resources/models exists`);
    const macos = await shadowedCheck(folder, deps({ [`${app}/MacOS/models/fcpe.onnx`]: 'w' }));
    expect(macos.message).toContain(`${app}/MacOS/models exists`);
    // A folder that is not an app bundle is not looked into.
    const other = await shadowedCheck(folder, deps({ [`${folder}/Other/Contents/Resources/models/a`]: 'x' }));
    expect(other.status).toBe('pass');
  });
});

describe('doctor on macOS: what does not apply and the checksum list', () => {
  it('reports the Direct3D 12 runtime as not applicable, as a pass, whatever the manifest says', async () => {
    const manifest = JSON.stringify({ protocolMajors: [1], d3d12: { bundled: false, directory: 'D3D12', files: [] } });
    const fs = posixFs({ '/t/opentune-control.json': manifest });
    for (const exeDir of [null, '/t']) {
      expect(await d3d12Check(exeDir, { platform: 'darwin', fs, officialDir: null })).toEqual({
        status: 'pass',
        message: 'Not applicable on macOS: the Direct3D 12 runtime is a Windows component; there is nothing to copy.',
      });
    }
  });

  it('verifies SHA256SUMS of the test build, with POSIX paths in the messages', async () => {
    const folder = '/t/pkg';
    const sums = `${sha('a')}  OpenTune-ctl.app/Contents/MacOS/OpenTune\n${sha('b')}  opentune-control.json\n`;
    const files = {
      [`${folder}/SHA256SUMS`]: sums,
      [`${folder}/OpenTune-ctl.app/Contents/MacOS/OpenTune`]: 'a',
      [`${folder}/opentune-control.json`]: 'b',
    };
    const ok = await sidecarCheck(folder, { platform: 'darwin', fs: posixFs(files) });
    expect(ok).toMatchObject({ status: 'pass', message: expect.stringContaining('All 2 files') as unknown });
    const changed = await sidecarCheck(folder, {
      platform: 'darwin',
      fs: posixFs({ ...files, [`${folder}/OpenTune-ctl.app/Contents/MacOS/OpenTune`]: 'changed' }),
    });
    expect(changed.status).toBe('fail');
    expect(changed.message).toContain('hash differs: OpenTune-ctl.app/Contents/MacOS/OpenTune');
    const missing = await sidecarCheck(folder, {
      platform: 'darwin',
      fs: posixFs({ [`${folder}/SHA256SUMS`]: sums, [`${folder}/opentune-control.json`]: 'b' }),
    });
    expect(missing.message).toContain('missing: OpenTune-ctl.app/Contents/MacOS/OpenTune');
  });
});

describe('doctor on macOS', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });

  /** Doctor dependencies for darwin: the app 1.8.1 with its models, in memory, unless a test replaces them. */
  const base = (overrides: Partial<DoctorDeps> = {}): DoctorDeps => ({
    env: { OPENTUNE_MCP_DISCOVERY_DIR: '/ot-test/no-such-discovery-dir' },
    platform: 'darwin',
    home: '/Users/user',
    nodeVersion: 'v22.12.0',
    osRelease: null,
    officialInstall: () => Promise.resolve(bundle('1.8.1')),
    fs: posixFs(withModels(inApp)),
    ...overrides,
  });
  const byId = (checks: { id: string; status: string; message: string }[], id: string) =>
    checks.find((c) => c.id === id) ?? { id, status: 'missing', message: '' };

  it('reports the app, its version and its models, and the Windows-only check as not applicable', async () => {
    const checks = await runDoctor(base());
    expect(byId(checks, 'OT_NO_OFFICIAL_INSTALL')).toMatchObject({
      status: 'pass',
      message: expect.stringMatching(
        /^Official OpenTune installation in \/Applications\/OpenTune\.app \(version "1\.8\.1", read from its Info\.plist\)/,
      ) as unknown,
    });
    expect(byId(checks, 'OT_VERSION_UNSUPPORTED').status).toBe('pass');
    expect(byId(checks, 'OT_MODELS_MISSING')).toMatchObject({
      status: 'pass',
      message: `Required model files present in ${inApp}: fcpe.onnx.`,
    });
    expect(byId(checks, 'OT_D3D12_NOT_COPIED')).toMatchObject({
      status: 'pass',
      message: expect.stringMatching(/^Not applicable on macOS/) as unknown,
    });
    expect(byId(checks, 'OT_WSL_RUNTIME').status).toBe('pass');
  });

  it('warns that the app is missing and says which release to install; the models and version are then not checked', async () => {
    let asked = 0;
    const checks = await runDoctor(
      base({
        officialInstall: () => {
          asked += 1;
          return Promise.resolve(null);
        },
      }),
    );
    expect(asked).toBe(1);
    const missing = byId(checks, 'OT_NO_OFFICIAL_INSTALL');
    expect(missing.status).toBe('warn');
    expect(missing.message).toContain('/Applications/OpenTune.app');
    expect(missing.message).toContain('1.8.0 or later');
    expect(byId(checks, 'OT_MODELS_MISSING').message).toMatch(/^Not checked/);
    expect(byId(checks, 'OT_VERSION_UNSUPPORTED').message).toMatch(/^Not checked/);
  });

  it('fails an app older than 1.8.0 and an app without models', async () => {
    const old = await runDoctor(base({ officialInstall: () => Promise.resolve(bundle('1.7.9')) }));
    expect(byId(old, 'OT_VERSION_UNSUPPORTED').status).toBe('fail');
    const empty = await runDoctor(base({ fs: posixFs({}) }));
    expect(byId(empty, 'OT_MODELS_MISSING').status).toBe('fail');
  });

  describe.skipIf(process.platform === 'win32')('with a test build on disk', () => {
    /** A folder as the test build is unpacked: the app bundle, and the script and the manifest beside it. */
    function unpacked(withScript: boolean, withManifest: boolean) {
      const { dir, remove } = tempDir();
      cleanup.push(remove);
      const folder = path.join(dir, 'pkg');
      const exeDir = path.join(folder, 'OpenTune-ctl.app', 'Contents', 'MacOS');
      mkdirSync(exeDir, { recursive: true });
      writeFileSync(path.join(exeDir, 'OpenTune'), '');
      if (withScript) writeFileSync(path.join(folder, 'OpenTune-AI.command'), '#!/bin/sh\n');
      if (withManifest) writeFileSync(path.join(folder, 'opentune-control.json'), '{"protocolMajors":[1]}');
      return { dir, exe: path.join(exeDir, 'OpenTune'), script: path.join(folder, 'OpenTune-AI.command') };
    }
    /** The real file system, and no official app (so that nothing outside the temporary folder is read). */
    const onDisk = (home: string, exe: string, platform: NodeJS.Platform = 'darwin'): DoctorDeps => ({
      env: { OPENTUNE_MCP_DISCOVERY_DIR: path.join(home, 'instances'), OPENTUNE_MCP_OPENTUNE_PATH: exe },
      platform,
      home,
      nodeVersion: 'v22.12.0',
      osRelease: null,
      officialInstall: () => Promise.resolve(null),
    });

    it('accepts the script that sits next to the manifest, and finds no models folder around it', async () => {
      const t = unpacked(true, true);
      const checks = await runDoctor(onDisk(t.dir, t.script));
      expect(byId(checks, 'OT_OPENTUNE_PATH').status).toBe('pass');
      expect(byId(checks, 'OT_MODELS_SHADOWED')).toMatchObject({
        status: 'pass',
        message: 'No models folder next to the executable or in an app bundle beside it.',
      });
    });

    it('tells where to point the path when it names the executable inside the app, which has no manifest beside it', async () => {
      const t = unpacked(true, true);
      const check = byId(await runDoctor(onDisk(t.dir, t.exe)), 'OT_OPENTUNE_PATH');
      expect(check.status).toBe('fail');
      expect(check.message).toContain('manifest missing');
      // The script is there, so the message names it (the home directory hidden as ~).
      expect(check.message).toContain(path.join('~', 'pkg', 'OpenTune-AI.command'));
      expect(check.message).not.toContain(t.dir);
      // Without the script beside the app it still says what to look for.
      const lost = unpacked(false, false);
      const noScript = byId(await runDoctor(onDisk(lost.dir, lost.exe)), 'OT_OPENTUNE_PATH');
      expect(noScript.message).toContain('next to OpenTune-AI.command, in the folder that holds the app');
      // The layout belongs to macOS: no hint elsewhere.
      const linux = byId(await runDoctor(onDisk(t.dir, t.exe, 'linux')), 'OT_OPENTUNE_PATH');
      expect(linux.message).toContain('manifest missing');
      expect(linux.message).not.toContain('OpenTune-AI.command');
    });
  });
});
