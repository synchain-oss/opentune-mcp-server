// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { GOLDEN_TOOLS, MANIFEST, SERVER_PATH, buildMcpb, crc32, goldenTools, zipStored } from '../../scripts/mcpb.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = async (file: string) =>
  JSON.parse(await fs.readFile(path.join(ROOT, file), 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface ZipEntry {
  name: string;
  data: Buffer;
  crc: number;
  time: number;
  date: number;
  attrs: number;
}

/** Reads a zip by its central directory (store and deflate), as any unzip tool would. */
function readZip(zip: Buffer): ZipEntry[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataStart, dataStart + zip.readUInt32LE(p + 20));
    expect(size).toBe(raw.length);
    out.push({
      name,
      data: method === 0 ? raw : inflateRawSync(raw),
      crc: zip.readUInt32LE(p + 16),
      time: zip.readUInt16LE(p + 12),
      date: zip.readUInt16LE(p + 14),
      attrs: zip.readUInt32LE(p + 38),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe('zipStored', () => {
  const entries = [
    { name: 'b/two.txt', data: Buffer.from('second') },
    { name: 'a.txt', data: Buffer.from('first') },
    { name: 'é.txt', data: Buffer.alloc(0) },
  ];

  it('is independent of input order and of when it runs', () => {
    const forward = zipStored(entries);
    expect(zipStored([...entries].reverse()).equals(forward)).toBe(true);
    expect(zipStored(entries).equals(forward)).toBe(true);
  });

  it('round-trips through a reader, in name order, with fixed time and attributes', () => {
    const read1 = readZip(zipStored(entries));
    expect(read1.map((e) => e.name)).toEqual(['a.txt', 'b/two.txt', 'é.txt']);
    expect(read1.map((e) => e.data.toString())).toEqual(['first', 'second', '']);
    for (const e of read1) {
      expect(e.crc).toBe(crc32(e.data));
      expect([e.time, e.date]).toEqual([0, 0x21]); // 1980-01-01 00:00
      expect(e.attrs >>> 16).toBe(0o100644);
    }
  });

  it('changes when the content changes', () => {
    const changed = zipStored([{ name: 'a.txt', data: Buffer.from('other') }, ...entries.slice(1)]);
    expect(changed.equals(zipStored(entries))).toBe(false);
  });
});

describe(MANIFEST, () => {
  it('is a manifest 0.3 for a node server that names the bundle and the OpenTune path setting', async () => {
    const m = await read(MANIFEST);
    expect(m).toMatchObject({
      manifest_version: '0.3',
      server: {
        type: 'node',
        entry_point: SERVER_PATH,
        mcp_config: {
          command: 'node',
          args: [`\${__dirname}/${SERVER_PATH}`],
          env: { OPENTUNE_MCP_OPENTUNE_PATH: '${user_config.opentune_path}' },
        },
      },
      compatibility: { runtimes: { node: '>=22' } },
      user_config: {
        opentune_path: { type: 'file', required: false },
      },
      tools_generated: false,
    });
    expect(JSON.stringify(m)).toContain('build of OpenTune Standalone that includes the control interface');
  });

  it('has the version and name of the npm package', async () => {
    const pkg = await read('package.json');
    const m = await read(MANIFEST);
    expect(m.version).toBe(pkg.version);
    expect(m.license).toBe(pkg.license);
    expect(m.name).toBe('opentune-mcp');
  });

  it(`lists the tools of ${GOLDEN_TOOLS}, with the same descriptions`, async () => {
    const m = await read(MANIFEST);
    expect(m.tools, 'run: node scripts/mcpb.mjs sync-tools, then npx prettier --write mcpb/manifest.json').toEqual(
      await goldenTools(ROOT),
    );
  });
});

describe('buildMcpb', () => {
  let tmp: string | undefined;
  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  /** A minimal tree with the files the package is made of. */
  async function tree(bundle: string): Promise<string> {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ot-mcpb-'));
    await fs.mkdir(path.join(tmp, 'dist'));
    await fs.mkdir(path.join(tmp, 'mcpb'));
    await fs.writeFile(path.join(tmp, 'dist', 'opentune-mcp.mjs'), bundle);
    await fs.writeFile(path.join(tmp, MANIFEST), JSON.stringify({ version: '9.9.9' }));
    await fs.writeFile(path.join(tmp, 'LICENSE'), 'license');
    await fs.writeFile(path.join(tmp, 'THIRD-PARTY-NOTICES.md'), 'notices');
    return tmp;
  }

  it('gives the same bytes and sha256 twice, and different bytes for a different bundle', async () => {
    const root = await tree('#!/usr/bin/env node\nconsole.error(1);\n');
    const a = await buildMcpb(root);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = await buildMcpb(root);
    expect(b.bytes.equals(a.bytes)).toBe(true);
    expect(a.sha256).toBe(createHash('sha256').update(a.bytes).digest('hex'));
    expect(a.version).toBe('9.9.9');
    await fs.writeFile(path.join(root, 'dist', 'opentune-mcp.mjs'), 'different');
    expect((await buildMcpb(root)).sha256).not.toBe(a.sha256);
  });

  it('contains exactly the manifest, the bundle, the licence and the notices', async () => {
    const root = await tree('bundle');
    const built = await buildMcpb(root);
    expect(built.files).toEqual(['LICENSE', 'THIRD-PARTY-NOTICES.md', 'manifest.json', SERVER_PATH]);
    const names = readZip(built.bytes).map((e) => e.name);
    expect(names).toEqual(['LICENSE', 'THIRD-PARTY-NOTICES.md', 'manifest.json', SERVER_PATH]);
    expect(
      readZip(built.bytes)
        .find((e) => e.name === SERVER_PATH)
        ?.data.toString(),
    ).toBe('bundle');
  });

  it('asks for a build when the bundle is missing', async () => {
    const root = await tree('x');
    await fs.rm(path.join(root, 'dist'), { recursive: true });
    await expect(buildMcpb(root)).rejects.toThrow('npm run build');
  });
});
