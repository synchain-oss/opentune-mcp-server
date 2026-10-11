// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';

import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Files that must each reach 90% (statements, branches, functions, lines) on top of the global
// 85%: input sanitizing, error construction, OTCP message framing, analysis and result rendering.
// The globs match nothing until those modules exist; new modules in these areas inherit the
// stricter bar automatically.
const strictPerFile = { statements: 90, branches: 90, functions: 90, lines: 90, perFile: true };

export default defineConfig({
  // Same injection as the esbuild build (scripts/build.mjs), so tests see the real version.
  define: { __OPENTUNE_MCP_VERSION__: JSON.stringify(pkg.version) },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
      {
        // Runs the built bundle as a child process; the global setup builds it first.
        extends: true,
        test: {
          name: 'stdio',
          include: ['test/stdio/**/*.test.ts'],
          globalSetup: ['test/stdio/global-setup.ts'],
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // main.ts only wires argv, stdio and the process exit code together; it runs in the
      // child process of the stdio smoke test, which in-process coverage cannot see.
      exclude: ['src/main.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
        'src/sanitize/**': strictPerFile,
        'src/errors/**': strictPerFile,
        'src/otcp/framing*.ts': strictPerFile,
        'src/analysis/**': strictPerFile,
        'src/render/**': strictPerFile,
      },
    },
  },
});
