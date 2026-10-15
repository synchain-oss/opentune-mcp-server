// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// End to end against the mock: the built bundle over stdio, the mock instance over loopback TCP,
// discovery through an isolated directory. Doubles as the token canary: the mock creates its token
// and server proof at run time, and neither may appear in anything the bundle prints, on stdout or
// stderr, as a server or as doctor.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { startMock, type OtcpMock } from '../../mock/server.js';
import { tempDir } from '../support/context.js';
import { LineClient, isJsonRpcMessage } from '../support/jsonrpc-lines.js';

const BUNDLE = process.env.SMOKE_BUNDLE ?? fileURLToPath(new URL('../../dist/opentune-mcp.mjs', import.meta.url));

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function spawnBundle(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [BUNDLE, ...args], { stdio: 'pipe', env: { ...process.env, ...env } });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  cleanup.push(() => {
    if (child.exitCode === null) child.kill();
  });
  return { child, exited, stderr: () => stderr };
}

interface ToolResult {
  isError?: boolean;
  structuredContent: Record<string, unknown>;
  content: { type: string; text: string }[];
}

describe('bundle against the mock', () => {
  it('discovers the mock, reports READY and follows and cancels a job; secrets never leak', async () => {
    const dir = tempDir();
    cleanup.push(dir.remove);
    const mock: OtcpMock = await startMock({ discoveryDir: dir.dir });
    cleanup.push(() => mock.stop());
    const secrets = [mock.discovery.token, mock.discovery.serverProof as string];

    const run = spawnBundle([], { OPENTUNE_MCP_DISCOVERY_DIR: dir.dir });
    const client = new LineClient((line) => run.child.stdin.write(line), run.child.stdout, 20_000);
    await client.request(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '0.0.0' },
    });
    client.notify('notifications/initialized');
    const list = await client.request(2, 'tools/list');
    expect((list.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toContain('opentune_get_status');

    let id = 10;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await client.request(id++, 'tools/call', { name, arguments: args });
      expect(response.error).toBeUndefined();
      const result = response.result as ToolResult;
      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
      return result;
    };

    const status = await call('opentune_get_status');
    expect(status.isError).toBeUndefined();
    expect(status.structuredContent).toMatchObject({
      state: 'READY',
      instances: [{ instanceId: mock.discovery.instanceId, state: 'READY' }],
    });

    const jobs = mock.given({
      jobs: [
        { bind: 'imp', kind: 'import', state: 'running', cancellable: true },
        { bind: 'save', kind: 'projectSave', state: 'running', cancellable: false },
      ],
    });
    const job = await call('opentune_get_job', { job_id: jobs.imp });
    expect(job.structuredContent).toMatchObject({ job: { jobId: jobs.imp, state: 'running' } });
    const cancelled = await call('opentune_cancel_job', { job_id: jobs.imp });
    expect(cancelled.structuredContent).toMatchObject({ cancelRequested: true, job: { state: 'cancelled' } });
    const refused = await call('opentune_cancel_job', { job_id: jobs.save });
    expect(refused).toMatchObject({ isError: true, structuredContent: { error: { reason: 'job_not_cancellable' } } });
    const invalid = await client.request(id++, 'tools/call', {
      name: 'opentune_get_job',
      arguments: { job_id: 'nope' },
    });
    expect(invalid.result).toMatchObject({ isError: true });

    run.child.stdin.end();
    expect(await run.exited).toBe(0);
    expect(client.pending).toBe('');
    for (const line of client.lines) expect(isJsonRpcMessage(JSON.parse(line)), line).toBe(true);
    const everything = [...client.lines, run.stderr()].join('\n');
    for (const secret of secrets) expect(everything).not.toContain(secret);

    const doctor = spawnBundle(['doctor', '--json'], { OPENTUNE_MCP_DISCOVERY_DIR: dir.dir });
    let out = '';
    doctor.child.stdout.setEncoding('utf8');
    doctor.child.stdout.on('data', (chunk: string) => (out += chunk));
    await doctor.exited;
    expect(JSON.parse(out)).toMatchObject({
      checks: expect.arrayContaining([expect.objectContaining({ id: 'OT_DISCOVERY_DIR', status: 'pass' })]) as unknown,
    });
    expect(out).toContain('token present (redacted)');
    for (const secret of secrets) expect(`${out}${doctor.stderr()}`).not.toContain(secret);
  });
});
