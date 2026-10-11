// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, type ServeStdioOptions, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import type { Logger } from './log.js';
import { SERVER_NAME, VERSION } from './version.js';

/**
 * Builds one MCP server instance. No tools are registered yet. Declaring the `tools`
 * capability installs the `tools/list` handler anyway, so clients get an empty list instead of
 * "method not found".
 */
export function createServer(): McpServer {
  return new McpServer({ name: SERVER_NAME, version: VERSION }, { capabilities: { tools: {} } });
}

export interface StdioServerOptions {
  readonly logger: Logger;
  /** Defaults to the process's own stdin and stdout. Tests pass their own streams. */
  readonly transport?: ServeStdioOptions['transport'];
}

/**
 * Serves MCP over stdio. The SDK answers both the 2025-era `initialize` handshake and the
 * 2026-07-28 per-request protocol from the same factory. When the client closes stdin the
 * transport closes, and the process exits once nothing else keeps it alive.
 */
export function startStdioServer(options: StdioServerOptions): StdioServerHandle {
  const { logger, transport } = options;
  return serveStdio(createServer, {
    onerror: (error) => {
      logger.error(`MCP transport error: ${error.message}`);
    },
    ...(transport === undefined ? {} : { transport }),
  });
}
