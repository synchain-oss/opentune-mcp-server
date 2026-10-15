// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// `npm run catalog:update`: rewrites the golden tools/list and instructions snapshots
// (test/golden/) and docs/reference.md from the sources, by running test/unit/catalog.test.ts in
// update mode. The golden files are a frozen contract surface: a change needs a contract change
// record in docs/contract-changes/ in the same pull request (CLAUDE.md, section 5).
//
// The MCPB manifest's tools list is derived from the golden snapshot, so it is re-synced here as
// well (not a contract surface itself). It runs after the snapshot is rewritten, then prettier
// formats the manifest.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANIFEST, syncTools } from './mcpb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitest = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(process.execPath, [vitest, 'run', '--project', 'unit', 'test/unit/catalog.test.ts'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, OPENTUNE_MCP_UPDATE_CATALOG: '1' },
});

await syncTools(ROOT);
const prettier = path.join(ROOT, 'node_modules', 'prettier', 'bin', 'prettier.cjs');
const format = spawnSync(process.execPath, [prettier, '--write', MANIFEST], { cwd: ROOT, stdio: 'inherit' });

process.exitCode = result.status ?? 1;
if (format.status !== 0) process.exitCode ||= format.status ?? 1;
