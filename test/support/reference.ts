// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Renders docs/reference.md from the tool registry and the tools/list output, so that the
// reference always describes what clients receive. test/unit/catalog.test.ts compares the result
// with the committed file; `npm run catalog:update` rewrites it.

import type { ToolDefinition } from '../../src/tools/registry.js';

interface JsonSchema {
  type?: string;
  description?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

export interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: Record<string, boolean>;
  _meta?: Record<string, unknown>;
}

const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');

function typeOf(schema: JsonSchema): string {
  const parts = [schema.type ?? 'any'];
  if (schema.pattern !== undefined) parts.push(`matching \`${schema.pattern}\``);
  if (schema.minimum !== undefined && schema.maximum !== undefined) {
    parts.push(`${String(schema.minimum)} to ${String(schema.maximum)}`);
  }
  return parts.join(', ');
}

function hints(annotations: Record<string, boolean> = {}): string {
  return [
    annotations.readOnlyHint ? 'read-only' : 'changes state',
    annotations.destructiveHint ? 'destructive' : 'not destructive',
    annotations.idempotentHint ? 'idempotent' : 'not idempotent',
    annotations.openWorldHint ? 'open world' : 'closed world',
  ].join(', ');
}

export function renderReference(
  tools: readonly ListedTool[],
  registry: readonly ToolDefinition[],
  instructions: string,
): string {
  const out: string[] = [
    '<!-- Generated from the tool registry (src/tools/) by `npm run catalog:update`. Do not edit by hand. -->',
    '',
    '# Tool reference',
    '',
    `OpenTune MCP Server (by Synchain) offers ${String(tools.length)} tools. Every tool returns its result both as`,
    '`structuredContent` and as the same JSON in a text block. Errors have the shape',
    '`{kind, reason, detail, retryable, executed, nextStep, url}`; see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).',
    '',
    '## Instructions',
    '',
    'The server sends these instructions to clients in `initialize` and `server/discover`:',
    '',
    '```text',
    instructions,
    '```',
    '',
    '## Tools',
    '',
  ];
  for (const tool of tools) {
    const declared = registry.find((t) => t.name === tool.name);
    const alwaysLoad = tool._meta?.['anthropic/alwaysLoad'] === true ? '; always loaded' : '';
    out.push(
      `### \`${tool.name}\``,
      '',
      `**${tool.title ?? tool.name}**: ${hints(tool.annotations)}${alwaysLoad}.`,
      '',
    );
    out.push(tool.description ?? '', '');
    if (declared) {
      const code = (items: readonly string[]) => items.map((i) => `\`${i}\``).join(', ');
      const optional =
        declared.optionalCapabilities === undefined || declared.optionalCapabilities.length === 0
          ? ''
          : ` Needed by one mode only: ${code(declared.optionalCapabilities)}.`;
      out.push(
        `OTCP capabilities: ${code(declared.capabilities)}.${optional} OTCP methods: ${code(declared.otcpMethods)}.`,
        '',
      );
    }
    const props = Object.entries(tool.inputSchema.properties ?? {});
    if (props.length === 0) {
      out.push('No parameters.', '');
    } else {
      out.push('| Parameter | Type | Required | Description |', '| --- | --- | --- | --- |');
      for (const [name, schema] of props) {
        const required = tool.inputSchema.required?.includes(name) ? 'yes' : 'no';
        out.push(`| \`${name}\` | ${cell(typeOf(schema))} | ${required} | ${cell(schema.description ?? '')} |`);
      }
      out.push('');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}
