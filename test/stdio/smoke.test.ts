// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Smoke tests against the built bundle, started the way an MCP client starts it: a child
// process speaking newline-delimited JSON-RPC over stdin and stdout.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LineClient, isJsonRpcMessage } from '../support/jsonrpc-lines.js';

// SMOKE_BUNDLE points the same tests at another copy of the bundle: CI's package job installs the
// packed tarball into an empty directory and runs them against the installed file.
const BUNDLE = process.env.SMOKE_BUNDLE ?? fileURLToPath(new URL('../../dist/opentune-mcp.mjs', import.meta.url));
const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
const EXIT_TIMEOUT_MS = 10_000;
const GOLDEN = readFileSync(new URL('../golden/tools-list.json', import.meta.url), 'utf8');

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function startBundle(args: string[] = []) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [BUNDLE, ...args], { stdio: 'pipe' });
  let stdout = '';
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const exited = new Promise<Exit>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`bundle did not exit within ${String(EXIT_TIMEOUT_MS)} ms; stderr: ${stderr}`));
    }, EXIT_TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  return {
    child,
    exited,
    collectStdout: () => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

/** Every line on stdout must be a complete JSON-RPC message; reports the first offender. */
function expectOnlyJsonRpc(client: LineClient): void {
  expect(client.pending, 'unterminated output after the last newline').toBe('');
  for (const line of client.lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      expect.fail(`stdout line is not JSON: ${JSON.stringify(line)}`);
    }
    expect(isJsonRpcMessage(parsed), `stdout line is not a JSON-RPC message: ${line}`).toBe(true);
  }
}

describe('built bundle over stdio', () => {
  it('answers initialize and tools/list with JSON-RPC only on stdout, then exits when stdin closes', async () => {
    const run = startBundle();
    const client = new LineClient((line) => run.child.stdin.write(line), run.child.stdout);

    const init = await client.request(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'stdio-smoke', version: '0.0.0' },
    });
    expect(init.error).toBeUndefined();
    expect(init.result).toMatchObject({ serverInfo: { name: 'opentune-mcp', version: PKG.version } });

    client.notify('notifications/initialized');
    const list = await client.request(2, 'tools/list');
    expect(list.error).toBeUndefined();
    // The built bundle lists exactly the golden catalog.
    expect(`${JSON.stringify((list.result as { tools: unknown }).tools, null, 2)}
`).toBe(GOLDEN);

    run.child.stdin.end();
    const exit = await run.exited;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(client.lines).toHaveLength(2);
    expectOnlyJsonRpc(client);
  });

  it('serves 2026-07-28 requests too', async () => {
    const run = startBundle();
    const client = new LineClient((line) => run.child.stdin.write(line), run.child.stdout);
    const _meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'stdio-smoke', version: '0.0.0' },
    };
    const list = await client.request(1, 'tools/list', { _meta });
    expect(list.error).toBeUndefined();
    expect(`${JSON.stringify((list.result as { tools: unknown }).tools, null, 2)}
`).toBe(GOLDEN);

    run.child.stdin.end();
    expect(await run.exited).toEqual({ code: 0, signal: null });
    expectOnlyJsonRpc(client);
  });

  it('prints the version and exits without reading stdin', async () => {
    const run = startBundle(['--version']);
    run.collectStdout();
    // stdin stays open: the process must exit on its own instead of serving.
    expect(await run.exited).toEqual({ code: 0, signal: null });
    expect(run.stdout()).toBe(`${PKG.version}\n`);
    expect(run.stderr()).toBe('');
  });

  it('prints usage for --help and exits without reading stdin', async () => {
    const run = startBundle(['--help']);
    run.collectStdout();
    expect(await run.exited).toEqual({ code: 0, signal: null });
    expect(run.stdout()).toMatch(/^Usage: opentune-mcp \[--help \| --version\]\n/);
    expect(run.stderr()).toBe('');
  });

  it('rejects unknown arguments on stderr with exit code 2', async () => {
    const run = startBundle(['--bogus']);
    run.collectStdout();
    expect(await run.exited).toEqual({ code: 2, signal: null });
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toContain('unknown argument "--bogus"');
  });
});
