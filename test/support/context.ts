// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Helpers for tests of the tools: a tool context over an isolated discovery directory with a fake
// process probe, temporary directories, and an in-process MCP client.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import type { ProcessInfo, ProcessProbe } from '../../src/discovery/process.js';
import type { ProjectFs } from '../../src/files/project-folders.js';
import type { LaunchDeps } from '../../src/launch/start.js';
import { createLogger } from '../../src/log.js';
import { Instances, type InstanceDeps } from '../../src/otcp/instances.js';
import { startStdioServer } from '../../src/server.js';
import type { ToolContext } from '../../src/tools/registry.js';
import { LineClient } from './jsonrpc-lines.js';

/** A new empty directory under the system temp directory, removed by the returned function. */
export function tempDir(prefix = 'ot-test-'): { dir: string; remove: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface FakeProbe extends ProcessProbe {
  /** Per-pid answers; pids not listed are alive with an unknown start time. */
  readonly info: Map<number, ProcessInfo>;
  openTune: number[] | null;
}

export function fakeProbe(): FakeProbe {
  const info = new Map<number, ProcessInfo>();
  const probe: FakeProbe = {
    info,
    openTune: [],
    probe: (pid) => Promise.resolve(info.get(pid) ?? { alive: true, startTimeMs: null }),
    listOpenTune: () => Promise.resolve(probe.openTune),
  };
  return probe;
}

export interface TestContext extends ToolContext {
  readonly probe: FakeProbe;
  readonly logLines: string[];
}

/**
 * Launch dependencies for tests: starting a process fails the test unless a test passes its own
 * spawn, and no official installation is found.
 */
export const TEST_LAUNCH: LaunchDeps = {
  spawn: () => {
    throw new Error('this test must not start a process');
  },
  officialInstall: () => Promise.resolve(null),
  waitMs: 30_000,
  pollMs: 25,
};

/**
 * A tool context whose discovery directory is `dir`; nothing resolves to a real OpenTune folder.
 * The clock is real unless `now` fixes it (a number) or supplies it (a function). `files` replaces the file system
 * operations of the autosave and old-version folders.
 */
export function testContext(
  dir: string,
  options: {
    env?: NodeJS.ProcessEnv;
    now?: number | (() => number);
    files?: ProjectFs;
    open?: InstanceDeps['open'];
    launch?: Partial<LaunchDeps>;
  } = {},
): TestContext {
  const env = { OPENTUNE_MCP_DISCOVERY_DIR: dir, ...options.env };
  const probe = fakeProbe();
  const logLines: string[] = [];
  const { now } = options;
  return {
    instances: new Instances({
      env,
      platform: process.platform,
      home: path.join(dir, 'home'),
      probe,
      ...(options.open ? { open: options.open } : {}),
    }),
    env,
    platform: process.platform,
    probe,
    logger: createLogger({ sink: (line) => logLines.push(line), level: 'debug' }),
    logLines,
    now: now === undefined ? () => Date.now() : typeof now === 'function' ? now : () => now,
    ...(options.files ? { files: options.files } : {}),
    launch: { ...TEST_LAUNCH, ...options.launch },
  };
}

/** An MCP client connected in process to a server built on `ctx`. */
export function mcpClient(ctx: ToolContext): { client: LineClient; close: () => Promise<void> } {
  const input = new PassThrough();
  const output = new PassThrough();
  const handle = startStdioServer({
    logger: ctx.logger,
    transport: new StdioServerTransport(input, output),
    context: ctx,
  });
  const client = new LineClient((line) => input.write(line), output);
  return { client, close: () => handle.close() };
}

export const INITIALIZE = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'unit-test', version: '0.0.0' },
};

/** A valid discovery file; secrets are generated at run time and never written into the repository. */
export function discoveryContent(pid: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolMajors: [1],
    pid,
    processStartTimeMs: 1_760_000_000_000,
    instanceId: randomBytes(16).toString('hex'),
    port: 45_678,
    token: randomBytes(32).toString('hex'),
    serverProof: randomBytes(16).toString('hex'),
    launchNonce: null,
    appVersion: '1.2.3',
    build: { commit: 'a'.repeat(40), tag: null },
    buildTag: null,
    sourceUrl: 'https://github.com/synchain-oss/OpenTune',
    startedAtMs: 1_760_000_000_500,
    flavor: 'standalone',
    ...overrides,
  };
}
