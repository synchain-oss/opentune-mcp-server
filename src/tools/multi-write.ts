// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// What the tools that make several OTCP write requests in one call share. The requests run one
// after the other, each only after the one before it succeeded. A failed request stops the call
// and the error lists what the requests before it applied, so nothing applied goes unreported.
// The result of a call with one request is that request's rendered result; with several, one
// summary whose first sentence carries what any of them cannot undo, destroys or does unasked,
// and the rendered result of each request under `results`.

import { OtcpError, fromOtcpError, type ErrorData, type NextStep, type ToolError } from '../errors/tool-error.js';
import type { Json, OtcpSession } from '../otcp/client.js';
import { encodeArrangementRevision } from '../otcp/tokens.js';
import { isObject } from '../render/changes.js';
import { writeOutcome } from '../render/index.js';
import { leadFlags } from '../render/summary.js';
import { WRITE_TIMEOUT_MS } from './clip-write.js';
import type { Body, Outcome } from './registry.js';

export interface WriteCall {
  readonly method: string;
  readonly params: Json;
}

export interface WriteResult {
  readonly method: string;
  readonly body: Body;
  readonly envelope: Json;
}

/** The step to give for an OTCP error of a call, when the default step of its kind does not fit. */
export type ErrorStep = (data: ErrorData, call: WriteCall) => NextStep | undefined;

/** Runs the calls in order. Returns every result, or the outcome that stopped the sequence. */
export async function runWrites(
  session: OtcpSession,
  tool: string,
  calls: readonly WriteCall[],
  errorStep: ErrorStep = () => undefined,
): Promise<{ readonly results: readonly WriteResult[] } | { readonly stopped: Outcome }> {
  const results: WriteResult[] = [];
  const failedAfter = (error: ToolError): Outcome => ({
    ok: false,
    error,
    ...(results.length === 0
      ? {}
      : { context: { applied_before_error: results.map((r) => ({ method: r.method, ...r.body })) } }),
  });
  for (const call of calls) {
    let envelope: unknown;
    try {
      envelope = await session.call(call.method, call.params, WRITE_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof OtcpError)) throw error;
      return { stopped: failedAfter(fromOtcpError(error.data, errorStep(error.data, call))) };
    }
    const outcome = writeOutcome(envelope, { tool });
    if (!outcome.ok) return { stopped: failedAfter(outcome.error) };
    results.push({ method: call.method, body: outcome.body, envelope: envelope as Json });
  }
  return { results };
}

const noPrefix = (summary: string, tool: string): string => summary.replace(`${tool}: `, '');

/** The arrangement_revision a write result reports, as tools hand it out; null when it reports none. */
export function arrangementRevisionOf(envelope: Json): string | null {
  const tokens = isObject(envelope.tokens) ? envelope.tokens : {};
  const token = tokens.arrangementRevision;
  return typeof token === 'string' && token.length > 0 && token.length <= 256 ? encodeArrangementRevision(token) : null;
}

/** One body for the results of a call: the single result as it is, or the combined one. */
export function combineResults(tool: string, results: readonly WriteResult[]): Body {
  const [only] = results;
  if (results.length === 1 && only !== undefined) return only.body;
  const flags = leadFlags(results.map((r) => r.envelope));
  const flagText = flags.length === 0 ? '' : ` (${flags.join('; ')})`;
  const parts = results.map((r, i) => `${String(i + 1)}. ${noPrefix(r.body.summary, tool)}`);
  return {
    summary:
      `${tool}: ${String(results.length)} requests ran in this order${flagText}, reported separately in ` +
      `results. ${parts.join(' ')}`,
    results: results.map((r) => ({ method: r.method, ...r.body })),
  };
}
