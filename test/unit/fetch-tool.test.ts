// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CACHE_DIR, LOCK_FILE, fetchTool, resolveTool } from '../../scripts/fetch-tool.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface Pin {
  version: string;
  url: string;
  binary?: string;
  assets: Record<string, { asset: string; sha256: string }>;
}

async function readLock(root = ROOT): Promise<Record<string, Pin>> {
  return JSON.parse(await fs.readFile(path.join(root, LOCK_FILE), 'utf8')) as Record<string, Pin>;
}

/** Every file under `dir` (relative to the repository root), skipping nothing. */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(path.join(ROOT, dir), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFiles(rel)));
    else out.push(rel);
  }
  return out;
}

describe(LOCK_FILE, () => {
  it('pins gitleaks for every platform the gates run on, each asset with a sha256', async () => {
    const pin = (await readLock()).gitleaks;
    expect(pin?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(pin?.assets ?? {}).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64',
    ]);
    for (const { asset, sha256 } of Object.values(pin?.assets ?? {})) {
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
      // The version is written once, in `version`; names and the URL use the placeholder.
      expect(asset).toContain('{version}');
      expect(asset).not.toContain(pin?.version);
    }
    expect(pin?.url).toContain('{version}');
    expect(pin?.url).toContain('{asset}');
  });

  it('is the only place in scripts/ and .github/ that spells out a pinned version', async () => {
    const lock = await readLock();
    const files = [...(await listFiles('scripts')), ...(await listFiles('.github'))].filter((f) => f !== LOCK_FILE);
    for (const [name, pin] of Object.entries(lock)) {
      if (name.startsWith('$')) continue;
      for (const file of files) {
        const text = await fs.readFile(path.join(ROOT, file), 'utf8');
        expect(text.includes(pin.version), `${file} hardcodes ${name} ${pin.version}`).toBe(false);
      }
    }
  });
});

describe('resolveTool', () => {
  it('expands the placeholders for the requested platform', async () => {
    const tool = await resolveTool('gitleaks', { platform: 'linux', arch: 'x64' });
    expect(tool.asset).toBe(`gitleaks_${tool.version}_linux_x64.tar.gz`);
    expect(tool.url).toBe(`https://github.com/gitleaks/gitleaks/releases/download/v${tool.version}/${tool.asset}`);
    expect(tool.binary).toBe('gitleaks');
    expect(tool.dir).toBe(path.join(ROOT, CACHE_DIR, 'gitleaks', tool.version));
  });

  it('names the Windows executable with .exe', async () => {
    const tool = await resolveTool('gitleaks', { platform: 'win32', arch: 'x64' });
    expect(tool.asset).toBe(`gitleaks_${tool.version}_windows_x64.zip`);
    expect(tool.binary).toBe('gitleaks.exe');
  });

  it('rejects a tool or platform without a pin', async () => {
    await expect(resolveTool('no-such-tool')).rejects.toThrow(/no valid pin/);
    await expect(resolveTool('gitleaks', { platform: 'sunos', arch: 'x64' })).rejects.toThrow(/no asset for sunos-x64/);
  });
});

describe('fetchTool', () => {
  const temps: string[] = [];
  const good = Buffer.from('the genuine archive');
  const goodSha = createHash('sha256').update(good).digest('hex');

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const dir of temps.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  /** A scratch repository root whose lock pins a fake tool for this platform. */
  async function scratchRoot(sha256 = goodSha): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ot-fetch-tool-'));
    temps.push(root);
    const lock = {
      demo: {
        version: '1.2.3',
        url: 'https://downloads.invalid/v{version}/{asset}',
        binary: 'demo',
        assets: { [`${process.platform}-${process.arch}`]: { asset: 'demo_{version}.tar.gz', sha256 } },
      },
    };
    await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(root, LOCK_FILE), JSON.stringify(lock));
    return root;
  }

  it('refuses an archive whose sha256 does not match the pin, and deletes it', async () => {
    const root = await scratchRoot();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('a tampered archive')));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchTool('demo', { root })).rejects.toThrow(
      `sha256 mismatch for demo_1.2.3.tar.gz: expected ${goodSha}`,
    );
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://downloads.invalid/v1.2.3/demo_1.2.3.tar.gz', {
      redirect: 'follow',
    });
    await expect(fs.stat(path.join(root, CACHE_DIR, 'demo', '1.2.3', 'demo_1.2.3.tar.gz'))).rejects.toThrow(/ENOENT/);
  });

  it('reports a failed download', async () => {
    const root = await scratchRoot();
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('not found', { status: 404 })));
    await expect(fetchTool('demo', { root })).rejects.toThrow(/HTTP 404/);
  });

  it('reuses a cached archive that matches the pin instead of downloading it again', async () => {
    const root = await scratchRoot();
    const dir = path.join(root, CACHE_DIR, 'demo', '1.2.3');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'demo_1.2.3.tar.gz'), good);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // The verified bytes are not a real archive, so extraction is what fails here.
    await expect(fetchTool('demo', { root })).rejects.toThrow(/extracting demo/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a lock entry without a valid sha256', async () => {
    const root = await scratchRoot('not-a-digest');
    await expect(fetchTool('demo', { root })).rejects.toThrow(/no valid sha256/);
  });
});
