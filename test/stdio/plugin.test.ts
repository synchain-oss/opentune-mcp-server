// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The assembled Claude Code plugin, started the way Claude Code starts it from the plugin's
// .mcp.json: ${CLAUDE_PLUGIN_ROOT} becomes the plugin directory, and ${user_config.opentune_path}
// becomes the empty string while the user has not set the OpenTune executable (what Claude Code
// 2.1.301 substitutes for an unset optional value, measured with a probe server). The server must
// then treat the path as not configured and tell the agent that the user has to act.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildPlugin } from '../../scripts/plugin.mjs';
import { tempDir } from '../support/context.js';
import { LineClient, isJsonRpcMessage } from '../support/jsonrpc-lines.js';
import { REPO } from '../support/plugin-tree.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface Server {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Substitutes the variables Claude Code fills in for an MCP stdio server of a plugin. */
function substitute(value: string, pluginRoot: string, userConfig: Record<string, string>): string {
  return value
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot.replaceAll('\\', '/'))
    .replace(/\$\{user_config\.([A-Za-z0-9_]+)\}/g, (_m, key: string) => userConfig[key] ?? '');
}

describe('the assembled plugin', () => {
  it('starts its server from .mcp.json and, with the OpenTune path unset, asks the user to act', async () => {
    const out = tempDir('ot-plugin-');
    cleanup.push(out.remove);
    const discovery = tempDir('ot-discovery-');
    cleanup.push(discovery.remove);
    const built = await buildPlugin(REPO, out.dir);
    const config = JSON.parse(await fs.readFile(path.join(built.dir, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, Server>;
    };
    const server = config.mcpServers.opentune;
    expect(server?.command).toBe('node');
    if (!server) return;
    const args = server.args.map((a) => substitute(a, built.dir, {}));
    const env = Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, substitute(v, built.dir, {})]));
    expect(env).toEqual({ OPENTUNE_MCP_OPENTUNE_PATH: '' });

    const child = spawn(process.execPath, args, {
      stdio: 'pipe',
      env: { ...process.env, ...env, OPENTUNE_MCP_DISCOVERY_DIR: discovery.dir },
    });
    cleanup.push(() => {
      if (child.exitCode === null) child.kill();
    });
    const client = new LineClient((line) => child.stdin.write(line), child.stdout, 20_000);
    await client.request(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'plugin-test', version: '0.0.0' },
    });
    client.notify('notifications/initialized');
    const response = await client.request(2, 'tools/call', { name: 'opentune_get_status', arguments: {} });
    const status = (response.result as { structuredContent: Record<string, unknown> }).structuredContent;
    // With no OpenTune running the unset path is the reason. An OpenTune without the control API
    // running on the test machine gives RUNNING_WITHOUT_API instead; a person has to act either way.
    if (status.state !== 'RUNNING_WITHOUT_API')
      expect(status).toMatchObject({ state: 'NOT_INSTALLED', reason: 'path_not_configured' });
    expect(status.nextStep).toMatchObject({ actor: 'user' });
    // stdout carries protocol frames only: every line parses as a JSON-RPC message.
    expect(client.lines.length).toBeGreaterThan(0);
    for (const line of client.lines) expect(isJsonRpcMessage(JSON.parse(line)), line).toBe(true);
    child.stdin.end();
  });
});
