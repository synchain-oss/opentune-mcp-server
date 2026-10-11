// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { PassThrough } from 'node:stream';

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/log.js';
import { createServer, startStdioServer } from '../../src/server.js';
import { SERVER_NAME, VERSION } from '../../src/version.js';
import { LineClient, isJsonRpcMessage } from '../support/jsonrpc-lines.js';

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function startInProcess() {
  const input = new PassThrough();
  const output = new PassThrough();
  const logLines: string[] = [];
  const logger = createLogger({ sink: (line) => logLines.push(line) });
  const handle = startStdioServer({ logger, transport: new StdioServerTransport(input, output) });
  closers.push(() => handle.close());
  const client = new LineClient((line) => input.write(line), output);
  return { client, input, logLines };
}

describe('createServer', () => {
  it('builds a fresh, unconnected instance on every call', () => {
    const a = createServer();
    const b = createServer();
    expect(a).not.toBe(b);
    expect(a.isConnected()).toBe(false);
  });
});

describe('stdio server (in-process)', () => {
  it('answers the 2025-era initialize handshake with its name and version', async () => {
    const { client } = startInProcess();
    const init = await client.request(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'unit-test', version: '0.0.0' },
    });
    expect(init.error).toBeUndefined();
    expect(init.result).toMatchObject({
      protocolVersion: '2025-11-25',
      serverInfo: { name: SERVER_NAME, version: VERSION },
      capabilities: { tools: {} },
    });
  });

  it('lists no tools yet, rather than failing with "method not found"', async () => {
    const { client } = startInProcess();
    await client.request(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'unit-test', version: '0.0.0' },
    });
    client.notify('notifications/initialized');
    const list = await client.request(2, 'tools/list');
    expect(list.error).toBeUndefined();
    expect((list.result as { tools?: unknown }).tools).toEqual([]);
    expect(client.lines.every((line) => isJsonRpcMessage(JSON.parse(line)))).toBe(true);
  });

  it('serves 2026-07-28 requests that carry the protocol envelope', async () => {
    const { client } = startInProcess();
    const _meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'unit-test', version: '0.0.0' },
    };
    const discover = await client.request(1, 'server/discover', { _meta });
    expect(discover.error).toBeUndefined();
    expect(discover.result).toMatchObject({
      supportedVersions: expect.arrayContaining(['2026-07-28']) as unknown,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: VERSION } },
    });
    const list = await client.request(2, 'tools/list', { _meta });
    expect(list.error).toBeUndefined();
    expect((list.result as { tools?: unknown }).tools).toEqual([]);
  });

  it('reports transport errors through the logger (stderr), never on stdout', async () => {
    const { client, input, logLines } = startInProcess();
    // The SDK skips lines that are not JSON at all and reports JSON that is not JSON-RPC.
    input.write('this is not json\n');
    input.write('{"not":"json-rpc"}\n');
    const init = await client.request(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'unit-test', version: '0.0.0' },
    });
    expect(init.result).toBeDefined();
    expect(logLines.some((line) => line.startsWith(`${SERVER_NAME} error: MCP transport error:`))).toBe(true);
    expect(client.lines.every((line) => isJsonRpcMessage(JSON.parse(line)))).toBe(true);
  });
});
