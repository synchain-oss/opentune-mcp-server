// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// How tools are declared and registered. Every tool states its name, title, description, input
// schema, annotations, the OTCP capabilities it needs and the OTCP methods it calls; unit tests
// enforce the naming and description rules, openWorldHint false and the single alwaysLoad tool,
// and docs/reference.md is generated from these declarations. A tool returns an Outcome; this
// module turns it into the MCP result: the same object as structuredContent and, serialized so
// that untrusted strings stay JSON string values, as the text content.

import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { OtcpError, fromOtcpError, toolError, type ToolError } from '../errors/tool-error.js';
import type { Logger } from '../log.js';
import type { DiscoveryEntry } from '../discovery/file.js';
import type { ProcessProbe } from '../discovery/process.js';
import type { Json, OtcpSession } from '../otcp/client.js';
import { missingCapability, selectInstance, type Instances } from '../otcp/instances.js';
import { MissingTokenError } from '../otcp/tokens.js';
import { serializeResult } from '../sanitize/untrusted.js';

export interface ToolContext {
  readonly instances: Instances;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly probe: ProcessProbe;
  readonly logger: Logger;
  /** Current time in ms since the epoch. */
  readonly now: () => number;
}

/** A success body starts with a one-sentence summary composed only from trusted text. */
export interface Body {
  readonly summary: string;
  readonly [member: string]: unknown;
}

export type Outcome =
  | { readonly ok: true; readonly body: Body }
  | { readonly ok: false; readonly error: ToolError; readonly context?: Json };

export interface Annotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: false;
}

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: S;
  readonly outputSchema?: z.ZodObject;
  readonly annotations: Annotations;
  /** Clients that defer loading tool definitions load this one up front. Only opentune_get_status. */
  readonly alwaysLoad?: true;
  /** OTCP capabilities the tool needs; missing ones give UNSUPPORTED(capability_missing). */
  readonly capabilities: readonly string[];
  /** OTCP methods the tool calls. */
  readonly otcpMethods: readonly string[];
  run(args: z.output<S>, ctx: ToolContext): Promise<Outcome>;
}

/** Keeps the schema and the handler's argument type together. */
export function defineTool<S extends z.ZodObject>(definition: ToolDefinition<S>): ToolDefinition {
  return definition;
}

/** Tool `_meta` key that asks Claude clients to load the tool even when tool search defers the rest. */
export const ALWAYS_LOAD_META = 'anthropic/alwaysLoad';

export function render(outcome: Outcome): CallToolResult {
  const structured: Json = outcome.ok ? { ...outcome.body } : { error: outcome.error, ...outcome.context };
  return {
    content: [{ type: 'text', text: serializeResult(structured) }],
    structuredContent: structured,
    ...(outcome.ok ? {} : { isError: true }),
  };
}

export function registerTools(server: McpServer, tools: readonly ToolDefinition[], ctx: ToolContext): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        annotations: { ...tool.annotations },
        ...(tool.alwaysLoad ? { _meta: { [ALWAYS_LOAD_META]: true } } : {}),
      },
      async (args) => {
        try {
          return render(await tool.run(args, ctx));
        } catch (error) {
          ctx.logger.error(`${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`);
          return render({ ok: false, error: toolError('INTERNAL', { detail: 'unexpected error in this server' }) });
        }
      },
    );
  }
}

/**
 * Runs `fn` with a verified session of the selected instance after checking `capabilities`. Every
 * failure on the way (discovery, selection, connection, a missing capability, an OTCP error)
 * becomes an error outcome with its next step.
 */
export async function withInstance(
  ctx: ToolContext,
  select: { readonly instanceId: string | undefined; readonly hint?: string | undefined },
  capabilities: readonly string[],
  fn: (session: OtcpSession, entry: DiscoveryEntry) => Promise<Outcome>,
): Promise<Outcome> {
  const scan = await ctx.instances.scan();
  if (!('instances' in scan)) return { ok: false, error: scan };
  const chosen = selectInstance(scan.instances, select.instanceId, select.hint);
  if (!chosen.ok) return { ok: false, error: chosen.error, context: { instances: chosen.instances } };
  try {
    const session = await ctx.instances.session(chosen.entry);
    const missing = missingCapability(session, capabilities);
    if (missing) return { ok: false, error: missing };
    return await fn(session, chosen.entry);
  } catch (error) {
    if (error instanceof OtcpError) return { ok: false, error: fromOtcpError(error.data) };
    if (error instanceof MissingTokenError) {
      return {
        ok: false,
        error: toolError('INVALID_ARGUMENT', {
          reason: 'revision_incomplete',
          detail: `the revision given lacks its ${error.aspect} part, which this operation needs`,
          nextStep: {
            actor: 'agent',
            tool: 'opentune_get_project',
            message:
              'Call opentune_get_project to get a complete clip_revision for the clip, then call again with it.',
          },
        }),
      };
    }
    throw error;
  }
}

/** Top-level members of a rendered write result: the summary and the OTCP write envelope members. */
export const WRITE_RESULT_MEMBERS = [
  'summary',
  'applied',
  'noOp',
  'dryRun',
  'changes',
  'created',
  'removed',
  'idMap',
  'revisionDiff',
  'tokens',
  'undo',
  'dirty',
  'ui',
  'sideEffects',
  'warnings',
  'job',
] as const;

/**
 * The outputSchema shared by every tool that returns a write envelope: top-level members only, all
 * optional, no enums, other members allowed. The full structure lives in the OTCP schemas and is
 * enforced by tests against the mock and the vectors. A strict schema here would make the SDK
 * report a write that did take effect as a failed call whenever the shape differed.
 */
export const WRITE_RESULT_OUTPUT = z.looseObject(
  Object.fromEntries(WRITE_RESULT_MEMBERS.map((member) => [member, z.unknown().optional()])),
);
