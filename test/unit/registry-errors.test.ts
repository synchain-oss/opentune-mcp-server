// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// An unexpected exception in a tool is logged to stderr, but only as clean, bounded text: the message
// can carry arbitrary characters or text taken from OpenTune.

import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineTool, registerTools } from '../../src/tools/registry.js';
import { tempDir, testContext } from '../support/context.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function runFailing(message: string): Promise<{ lines: string[]; result: unknown }> {
  const temp = tempDir();
  cleanup.push(temp.remove);
  const ctx = testContext(temp.dir);
  let handler: ((args: unknown) => Promise<unknown>) | undefined;
  const server = {
    registerTool: (_name: string, _config: unknown, h: (args: unknown) => Promise<unknown>) => {
      handler = h;
    },
  } as unknown as McpServer;
  const tool = defineTool({
    name: 'opentune_boom',
    title: 'Boom',
    description: 'OpenTune (audio vocal pitch editor): always throws.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    capabilities: [],
    otcpMethods: [],
    run: () => Promise.reject(new Error(message)),
  });
  registerTools(server, [tool], ctx);
  const result = await handler?.({});
  return { lines: ctx.logLines, result };
}

describe('registerTools unexpected errors', () => {
  it('logs only printable ASCII, cut to 1 KB', async () => {
    const { lines } = await runFailing(`bad\u202e\u0000 \u00e9 ${'x'.repeat(5000)}`);
    const line = lines.join('\n');
    expect(line).toContain('opentune_boom failed: bad');
    expect(line).not.toMatch(/[^\u0020-\u007e\n]/);
    expect(line.length).toBeLessThan(1300);
    expect(line).toContain('...');
  });

  it('keeps a short message readable and answers with INTERNAL', async () => {
    const { lines, result } = await runFailing('plain failure');
    expect(lines.join('\n')).toContain('opentune_boom failed: plain failure');
    expect(JSON.stringify(result)).toContain('INTERNAL');
  });
});
