// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Bundles src/main.ts into dist/opentune-mcp.mjs, the single file that is published. All
// third-party code (MCP SDK, zod) is inlined, so the package has no runtime dependencies;
// THIRD-PARTY-NOTICES.md lists what was inlined (scripts/gen-notices.mjs).
//
// Usage: node scripts/build.mjs
// Writes dist/opentune-mcp.mjs (dist/ is emptied first) and the esbuild metafile to
// .cache/build/metafile.json (kept out of dist/ so the bundle stays the only file there).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUNDLE = 'dist/opentune-mcp.mjs';
export const METAFILE = '.cache/build/metafile.json';
export const SHEBANG = '#!/usr/bin/env node';

/** esbuild options shared by the build and by the notices generator. */
export async function bundleOptions(root = ROOT) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  return {
    absWorkingDir: root,
    entryPoints: ['src/main.ts'],
    outfile: BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: { js: SHEBANG },
    define: { __OPENTUNE_MCP_VERSION__: JSON.stringify(pkg.version) },
    legalComments: 'eof',
    metafile: true,
    logLevel: 'warning',
  };
}

/** Builds the bundle and returns the esbuild metafile. */
export async function build(root = ROOT) {
  await fs.rm(path.join(root, 'dist'), { recursive: true, force: true });
  const result = await esbuild.build(await bundleOptions(root));
  const metafilePath = path.join(root, METAFILE);
  await fs.mkdir(path.dirname(metafilePath), { recursive: true });
  await fs.writeFile(metafilePath, `${JSON.stringify(result.metafile, null, 2)}\n`);
  return result.metafile;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const metafile = await build();
  const bytes = metafile.outputs[BUNDLE]?.bytes ?? 0;
  process.stderr.write(`build: wrote ${BUNDLE} (${bytes} bytes)\n`);
}
