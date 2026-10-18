// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Builds dist/opentune-mcp.mjs so the smoke tests always run the current sources. Nothing to build
 * when SMOKE_BUNDLE names another copy (see smoke.test.ts).
 */
export default function setup(): void {
  if (process.env.SMOKE_BUNDLE !== undefined) return;
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) throw new Error(`scripts/build.mjs failed with exit code ${String(result.status)}`);
}
