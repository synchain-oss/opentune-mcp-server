// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Token canary: the built bundle runs a scripted session over every tool against the mock, which
// creates its token and server proof at start-up from random bytes, and neither value may show up
// anywhere the bundle writes: stdout (tool results, errors, progress), stderr (the log), doctor.
// The test also proves that it can go red: a result that does carry the token is caught.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { startMock, type OtcpMock } from '../../mock/server.js';
import { findLeaks, type Output } from '../support/canary.js';
import { tempDir } from '../support/context.js';
import { LineClient, isJsonRpcMessage } from '../support/jsonrpc-lines.js';
import { clip, need } from '../support/mock-client.js';
import { runAllTools, type Fixture } from '../support/scenario.js';
import { wavFile } from '../support/wav-file.js';

const BUNDLE = process.env.SMOKE_BUNDLE ?? fileURLToPath(new URL('../../dist/opentune-mcp.mjs', import.meta.url));

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function spawnBundle(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [BUNDLE, ...args], {
    stdio: 'pipe',
    // OPENTUNE_MCP_OPENTUNE_PATH is cleared: the launch tool must not find an executable to start.
    env: { ...process.env, OPENTUNE_MCP_OPENTUNE_PATH: '', ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  cleanup.push(() => {
    if (child.exitCode === null) child.kill();
  });
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

async function startClient(env: NodeJS.ProcessEnv) {
  const server = spawnBundle([], env);
  const client = new LineClient((line) => server.child.stdin.write(line), server.child.stdout, 30_000);
  await client.request(1, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'canary', version: '0.0.0' },
  });
  client.notify('notifications/initialized');
  return { server, client };
}

const frames = (client: LineClient): Output[] => client.lines.map((text) => ({ source: 'a stdout frame', text }));

interface Session {
  readonly secrets: Record<string, string>;
  readonly outputs: Output[];
  readonly steps: Awaited<ReturnType<typeof runAllTools>>;
  readonly tools: string[];
}

/** Starts the mock, runs the bundle as a server through the whole scenario, then the CLI commands. */
async function runSession(): Promise<Session> {
  const dir = tempDir();
  cleanup.push(dir.remove);
  const mock: OtcpMock = await startMock({ discoveryDir: dir.dir });
  cleanup.push(() => mock.stop());
  const secrets = { token: mock.discovery.token, serverProof: mock.discovery.serverProof as string };
  const audioFile = path.join(dir.dir, 'take1.wav');
  fs.writeFileSync(audioFile, wavFile({ seconds: 2 }));
  const ids = mock.given({
    dirty: false,
    clips: [clip({ timeGrid: [{ bind: 'h1', contentSec: 1 }] })],
    jobs: [
      { bind: 'imp', kind: 'import', state: 'running', cancellable: true },
      { bind: 'save', kind: 'projectSave', state: 'running', cancellable: false },
    ],
  });
  const fixture: Fixture = {
    instanceId: mock.discovery.instanceId,
    placement: need(ids, 'clip.placementId'),
    contentId: need(ids, 'clip.contentId'),
    runningJob: need(ids, 'imp'),
    savingJob: need(ids, 'save'),
    audioFile,
  };

  const env = { OPENTUNE_MCP_DISCOVERY_DIR: dir.dir };
  const { server, client } = await startClient(env);
  const list = await client.request(2, 'tools/list');
  const tools = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name);
  let id = 10;
  const steps = await runAllTools(async (tool, args) => {
    const response = await client.request(id++, 'tools/call', { name: tool, arguments: args });
    const result = (response.result ?? {}) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    return { isError: response.error !== undefined || result.isError === true, structured: result.structuredContent };
  }, fixture);
  server.child.stdin.end();
  expect(await server.exited).toBe(0);
  expect(client.pending).toBe('');
  for (const line of client.lines) expect(isJsonRpcMessage(JSON.parse(line)), 'stdout line is JSON-RPC').toBe(true);

  const outputs: Output[] = [...frames(client), { source: 'stderr of the server', text: server.stderr() }];
  for (const args of [['doctor'], ['doctor', '--json'], ['--version'], ['--help']]) {
    const run = spawnBundle(args, env);
    await run.exited;
    outputs.push({ source: `stdout of ${args.join(' ')}`, text: run.stdout() });
    outputs.push({ source: `stderr of ${args.join(' ')}`, text: run.stderr() });
  }
  return { secrets, outputs, steps, tools };
}

describe('token canary', () => {
  it('finds neither the token nor the server proof anywhere, with every tool called', async () => {
    const session = await runSession();
    // Every tool of the catalog was called, and the error paths ran too.
    expect([...new Set(session.steps.map((s) => s.tool))].sort()).toEqual([...session.tools].sort());
    expect(session.steps.filter((s) => s.expect === 'error').length).toBeGreaterThanOrEqual(7);
    // The scan has something to look at: random values of real length, and non-empty outputs.
    expect(session.secrets.token).toMatch(/^[0-9a-f]{32,}$/i);
    expect(session.secrets.serverProof).toMatch(/^[0-9a-f]{32,}$/i);
    expect(session.outputs.filter((o) => o.text.length > 0).length).toBeGreaterThan(20);
    expect(findLeaks(session.secrets, session.outputs)).toEqual([]);
  });

  it('goes red when a result carries the token', async () => {
    // The file name is data that OpenTune hands back in the import result, so a mock that names a
    // file after its token puts the token into a tool result.
    const dir = tempDir();
    cleanup.push(dir.remove);
    const mock = await startMock({ discoveryDir: dir.dir });
    cleanup.push(() => mock.stop());
    const token = mock.discovery.token;
    const file = path.join(dir.dir, `${token}.wav`);
    fs.writeFileSync(file, wavFile({ seconds: 2 }));
    const { server, client } = await startClient({ OPENTUNE_MCP_DISCOVERY_DIR: dir.dir });
    await client.request(2, 'tools/call', { name: 'opentune_open_audio', arguments: { path: file, wait_seconds: 10 } });
    server.child.stdin.end();
    await server.exited;
    const leaks = findLeaks({ token }, [...frames(client), { source: 'stderr of the server', text: server.stderr() }]);
    expect(leaks).toContain('the token appears in a stdout frame');
    expect(leaks.join('')).not.toContain(token);
  });
});
