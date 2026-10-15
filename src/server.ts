// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import os from 'node:os';

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, type ServeStdioOptions, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import { systemProbe } from './discovery/process.js';
import { INSTRUCTIONS } from './instructions.js';
import { systemLaunchDeps } from './launch/start.js';
import { createLogger, type Logger } from './log.js';
import { Instances } from './otcp/instances.js';
import { TOOLS } from './tools/index.js';
import { registerTools, type ToolContext } from './tools/registry.js';
import { SERVER_NAME, VERSION } from './version.js';

/** The state tools share for the life of the process: discovery, sessions and the environment. */
export function createContext(logger: Logger, env: NodeJS.ProcessEnv = process.env): ToolContext {
  const probe = systemProbe();
  return {
    instances: new Instances({ env, platform: process.platform, home: os.homedir(), probe }),
    env,
    platform: process.platform,
    probe,
    logger,
    now: () => Date.now(),
    launch: systemLaunchDeps(env, process.platform),
  };
}

/**
 * Builds one MCP server instance with every tool registered. The SDK may build more than one per
 * connection (one per protocol era), so the shared state lives in the context passed in.
 */
export function createServer(ctx: ToolContext = createContext(createLogger())): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  registerTools(server, TOOLS, ctx);
  return server;
}

export interface StdioServerOptions {
  readonly logger: Logger;
  /** Defaults to the process's own stdin and stdout. Tests pass their own streams. */
  readonly transport?: ServeStdioOptions['transport'];
  /** Defaults to one built from the process environment. */
  readonly context?: ToolContext;
}

/**
 * Serves MCP over stdio. The SDK answers both the 2025-era `initialize` handshake and the
 * 2026-07-28 per-request protocol from the same factory. When the client closes stdin the
 * transport closes, and the process exits once nothing else keeps it alive (OTCP connections
 * never do).
 */
export function startStdioServer(options: StdioServerOptions): StdioServerHandle {
  const { logger, transport } = options;
  const ctx = options.context ?? createContext(logger);
  return serveStdio(() => createServer(ctx), {
    onerror: (error) => {
      logger.error(`MCP transport error: ${error.message}`);
    },
    ...(transport === undefined ? {} : { transport }),
  });
}
