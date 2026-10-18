// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

/**
 * Replaced with the `version` field of package.json at build time (esbuild `define` in
 * scripts/build.mjs) and in tests (vitest `define` in vitest.config.ts). There is deliberately
 * no fallback: an unreplaced identifier throws at startup instead of reporting a wrong version.
 */
declare const __OPENTUNE_MCP_VERSION__: string;

/** MCP server name reported in `serverInfo`. */
export const SERVER_NAME = 'opentune-mcp';

/** Package version, reported by `--version` and in `serverInfo`. */
export const VERSION: string = __OPENTUNE_MCP_VERSION__;
