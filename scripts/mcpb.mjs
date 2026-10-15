// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// MCPB (MCP Bundle) packaging for Claude Desktop. The bundle is a zip of mcpb/manifest.json, the
// single-file server bundle, LICENSE and THIRD-PARTY-NOTICES.md. The zip is written here with the
// Node standard library so that the same inputs always give the same bytes: entries are sorted,
// every timestamp is fixed, entries are stored (not deflated, so the output does not depend on the
// zlib version) and the attributes are constant.
//
// Usage: node scripts/mcpb.mjs pack [--out <dir>]    writes <dir>/opentune-mcp-<version>.mcpb and
//                                                    <dir>/opentune-mcp-<version>.mcpb.sha256
//                                                    (default .cache/mcpb); needs `npm run build`
//        node scripts/mcpb.mjs validate              `mcpb validate` on mcpb/manifest.json
//        node scripts/mcpb.mjs sync-tools            rewrites the tools list of the manifest from
//                                                    test/golden/tools-list.json
//
// `mcpb validate` comes from the pinned install in scripts/mcpb-tool (package.json + lockfile, so
// npm verifies every package's integrity). It lives outside the root package: the root audit has
// no tolerance for advisories and the tool is not shipped.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = 'mcpb/manifest.json';
export const GOLDEN_TOOLS = 'test/golden/tools-list.json';
export const BUNDLE = 'dist/opentune-mcp.mjs';
export const DEFAULT_OUT = '.cache/mcpb';
export const TOOL_SRC = 'scripts/mcpb-tool';
export const TOOL_DIR = '.cache/tools/mcpb';
/** Where the bundle sits inside the package; the manifest's entry_point and args name it. */
export const SERVER_PATH = 'server/opentune-mcp.mjs';

// ---------------------------------------------------------------------------------------------
// zip writer (store only)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 1980-01-01 00:00:00, the earliest time a zip can express.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const UNIX_FILE_0644 = ((0o100000 | 0o644) << 16) >>> 0;
const MADE_BY_UNIX = (3 << 8) | 20;

/**
 * Builds a zip archive. `entries` are `{ name, data }` with forward-slash relative names; they are
 * written in byte order of the name, so the caller's order does not matter.
 * @param {{ name: string, data: Buffer }[]} entries
 * @returns {Buffer}
 */
export function zipStored(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of sorted) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(MADE_BY_UNIX, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(UNIX_FILE_0644, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

// ---------------------------------------------------------------------------------------------
// manifest

async function readJson(file, root) {
  return JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
}

/** Tools as the manifest lists them: name and the golden description, in golden order. */
export async function goldenTools(root = ROOT) {
  const tools = await readJson(GOLDEN_TOOLS, root);
  return tools.map((t) => ({ name: t.name, description: t.description }));
}

export async function syncTools(root = ROOT) {
  const manifest = await readJson(MANIFEST, root);
  manifest.tools = await goldenTools(root);
  await fs.writeFile(path.join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.tools.length;
}

// ---------------------------------------------------------------------------------------------
// pack

/**
 * Reads the inputs and returns the package bytes. Needs the built bundle.
 * @param {string} [root]
 * @returns {Promise<{ bytes: Buffer, sha256: string, version: string, files: string[] }>}
 */
export async function buildMcpb(root = ROOT) {
  const bundle = await fs.readFile(path.join(root, BUNDLE)).catch(() => null);
  if (bundle === null) throw new Error(`${BUNDLE} is missing; run npm run build first`);
  const manifestBytes = await fs.readFile(path.join(root, MANIFEST));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const entries = [
    { name: 'manifest.json', data: manifestBytes },
    { name: SERVER_PATH, data: bundle },
    { name: 'LICENSE', data: await fs.readFile(path.join(root, 'LICENSE')) },
    { name: 'THIRD-PARTY-NOTICES.md', data: await fs.readFile(path.join(root, 'THIRD-PARTY-NOTICES.md')) },
  ];
  const bytes = zipStored(entries);
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    version: String(manifest.version),
    files: entries.map((e) => e.name).sort(),
  };
}

export async function packMcpb(root = ROOT, outDir = path.join(root, DEFAULT_OUT)) {
  const built = await buildMcpb(root);
  await fs.mkdir(outDir, { recursive: true });
  const name = `opentune-mcp-${built.version}.mcpb`;
  await fs.writeFile(path.join(outDir, name), built.bytes);
  await fs.writeFile(path.join(outDir, `${name}.sha256`), `${built.sha256}  ${name}\n`);
  return { ...built, name, path: path.join(outDir, name) };
}

// ---------------------------------------------------------------------------------------------
// mcpb CLI (validate)

/** The pinned MCPB CLI could not be installed (for example, no network). */
export class McpbToolUnavailable extends Error {}

function npm(args, cwd) {
  // Same as scripts/gates.mjs: when npm started us, run its own script with node (no shell);
  // otherwise use the npm on PATH.
  const npmCli = process.env.npm_execpath;
  if (npmCli && /\.(?:c?js|mjs)$/.test(npmCli))
    return spawnSync(process.execPath, [npmCli, ...args], { cwd, stdio: ['ignore', 2, 2] });
  return spawnSync('npm', args, { cwd, stdio: ['ignore', 2, 2], shell: process.platform === 'win32' });
}

/**
 * Installs the pinned MCPB CLI under .cache/tools/mcpb (once per lockfile) and returns the path of
 * its entry script. Throws when it cannot be installed, for example without network access.
 */
export async function ensureMcpbCli(root = ROOT) {
  const src = path.join(root, TOOL_SRC);
  const dir = path.join(root, TOOL_DIR);
  const lock = await fs.readFile(path.join(src, 'package-lock.json'));
  const stamp = createHash('sha256').update(lock).digest('hex');
  const cli = path.join(dir, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
  const stampFile = path.join(dir, '.lock-sha256');
  const installed = await fs.readFile(stampFile, 'utf8').catch(() => null);
  if (installed?.trim() === stamp && (await fs.stat(cli).catch(() => null))) return cli;
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(src, f), path.join(dir, f));
  const result = npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
  if (result.error || result.status !== 0)
    throw new McpbToolUnavailable(
      `could not install the pinned MCPB CLI (npm ci exited with ${result.status ?? 'an error'})`,
    );
  await fs.writeFile(stampFile, `${stamp}\n`);
  return cli;
}

/** Runs `mcpb validate` on the manifest and `mcpb info` on a package; returns output lines. */
export async function validateMcpb(root = ROOT, packagePath = null) {
  const cli = await ensureMcpbCli(root);
  const lines = [];
  const run = (args) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    if (r.error || r.status !== 0) throw new Error(`mcpb ${args[0]} failed: ${out || r.error?.message}`);
    lines.push(out);
  };
  run(['validate', path.join(root, MANIFEST)]);
  if (packagePath) run(['info', packagePath]);
  return lines;
}

// ---------------------------------------------------------------------------------------------
// CLI

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'pack') {
      const i = rest.indexOf('--out');
      const out = i >= 0 && rest[i + 1] ? path.resolve(rest[i + 1]) : undefined;
      const packed = await packMcpb(ROOT, out);
      process.stdout.write(`${packed.path}\nsha256 ${packed.sha256}\n`);
    } else if (command === 'validate') {
      process.stdout.write(`${(await validateMcpb()).join('\n')}\n`);
    } else if (command === 'sync-tools') {
      process.stdout.write(`manifest tools synced from ${GOLDEN_TOOLS}: ${await syncTools()} tools\n`);
    } else {
      process.stderr.write('usage: node scripts/mcpb.mjs pack [--out <dir>] | validate | sync-tools\n');
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`mcpb: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
