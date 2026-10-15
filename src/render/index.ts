// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Renders the write envelope that OTCP returns (spec/otcp/v1/PROTOCOL.md section 14) as the body
// of a tool result: a summary, what the OpenTune window shows, a table of the changes, and one
// line each for warnings, side effects and the undo or revert recipe. OpenTune sends codes and
// values only; the sentences come from the fixed tables in text.ts, checked by golden snapshots.
// The full envelope stays in the result next to the rendering.

import { toolError } from '../errors/tool-error.js';
import type { Json } from '../otcp/client.js';
import type { Body, Outcome } from '../tools/registry.js';
import { asList, changeTable, isObject, type ChangeTable } from './changes.js';
import { summarize } from './summary.js';
import { SIDE_EFFECT_TEXT, WARNING_TEXT, token, undoReasonText } from './text.js';
import { uiEffects, type UiEffect } from './ui-effects.js';

export type { ChangeTable, TableField, TableRow } from './changes.js';
export { MAX_TABLE_ROWS } from './changes.js';
export type { UiEffect } from './ui-effects.js';

export interface RenderContext {
  /** The tool that made the call, for example opentune_set_key. */
  readonly tool: string;
}

/** One line below the summary. Everything but `text` is data from OpenTune, as it came. */
export type Line =
  | {
      readonly kind: 'warning';
      readonly code: unknown;
      readonly text: string;
      readonly subject: unknown;
      readonly data: unknown;
    }
  | {
      readonly kind: 'sideEffect';
      readonly name: string;
      readonly text: string;
      readonly details: unknown;
      readonly revert: unknown;
    }
  | { readonly kind: 'undo'; readonly text: string; readonly undoId: unknown; readonly description: unknown }
  | {
      readonly kind: 'revert';
      readonly text: string;
      /** The recipe exactly as OpenTune sent it, or null when no request can restore the state. */
      readonly revert: unknown;
    };

export interface Rendering {
  readonly summary: string;
  readonly uiEffects: readonly UiEffect[];
  readonly changeTable: ChangeTable;
  readonly lines: readonly Line[];
}

function warningLines(envelope: Json): Line[] {
  return asList(envelope.warnings).map((item) => {
    const w = isObject(item) ? item : {};
    const code = token(w.code, 'code');
    const text =
      code === null
        ? 'A warning whose code is not in the expected form; see code as OpenTune sent it.'
        : (WARNING_TEXT[code] ?? `Warning ${code} is not known to this server; see subject and data.`);
    return { kind: 'warning', code: w.code ?? null, text, subject: w.subject ?? null, data: w.data ?? null };
  });
}

function revertText(revert: unknown): string {
  const r = isObject(revert) ? revert : null;
  const method = r === null ? null : token(r.method, 'method');
  if (r === null) return 'No request of the protocol can restore the previous state.';
  if (method === null) return 'A revert recipe is given but not in the expected form; see revert.';
  return r.requiresConsent === true
    ? `Restore with ${method} and these params, but only after the user explicitly agrees; add the method's consent parameters yourself.`
    : `Restore with ${method} and these params, sent unchanged.`;
}

function sideEffectLines(envelope: Json): Line[] {
  const effects = isObject(envelope.sideEffects) ? envelope.sideEffects : {};
  return Object.entries(effects).flatMap(([name, details]) => {
    const known = SIDE_EFFECT_TEXT[name];
    const label = token(name, 'camel');
    const text = known ?? `side effect ${label ?? 'with an unrecognized name'}, which this server does not know`;
    const revert = isObject(details) ? (details.revert ?? null) : null;
    const lines: Line[] = [
      { kind: 'sideEffect', name, text: `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}.`, details, revert },
    ];
    if (revert !== null)
      lines.push({ kind: 'revert', text: `${revertText(revert)} (reverts side effect ${label ?? 'above'})`, revert });
    return lines;
  });
}

function undoLines(envelope: Json): Line[] {
  const undo = isObject(envelope.undo) ? envelope.undo : null;
  if (undo === null) return [];
  if (undo.undoable === true) {
    const undoId = token(undo.undoId, 'undoId');
    return [
      {
        kind: 'undo',
        text:
          undoId === null
            ? 'Undoable as one step, but the undo id is not in the expected form.'
            : `Undoable as one step: undo it with expectedUndoId ${undoId}.`,
        undoId: undo.undoId ?? null,
        description: undo.description ?? null,
      },
    ];
  }
  if (undo.reason === 'no_op') return [];
  const revert = undo.revert ?? null;
  return [
    {
      kind: 'revert',
      text: `Not undoable (${undoReasonText(undo.reason)}). ${revertText(revert)}`,
      revert,
    },
  ];
}

/** Renders an envelope that has been checked against the OTCP write envelope schema. */
export function renderWrite(envelope: Json, ctx: RenderContext): Rendering {
  return {
    summary: summarize(envelope, ctx.tool),
    uiEffects: uiEffects(envelope),
    changeTable: changeTable(envelope),
    lines: [...warningLines(envelope), ...sideEffectLines(envelope), ...undoLines(envelope)],
  };
}

const ARRAYS = ['changes', 'created', 'removed', 'idMap', 'warnings'] as const;
const OBJECTS = ['revisionDiff', 'tokens', 'dirty', 'sideEffects'] as const;

/** Whether `value` has the shape of a write envelope; the full structure is checked by the OTCP schemas. */
export function isWriteEnvelope(value: unknown): value is Json {
  return (
    isObject(value) &&
    typeof value.applied === 'boolean' &&
    typeof value.noOp === 'boolean' &&
    typeof value.dryRun === 'boolean' &&
    ARRAYS.every((m) => Array.isArray(value[m])) &&
    OBJECTS.every((m) => isObject(value[m]))
  );
}

/**
 * The body of a write tool's result: summary first, then the whole envelope as OpenTune sent it,
 * then uiEffects, changeTable and lines. Members of the envelope are never changed or dropped.
 */
export function writeBody(envelope: Json, ctx: RenderContext): Body {
  const rendering = renderWrite(envelope, ctx);
  // Object.assign keeps summary first and lets the rendering win over a same-named envelope member.
  const body = { summary: rendering.summary };
  return Object.assign(body, envelope, {
    summary: rendering.summary,
    uiEffects: rendering.uiEffects,
    changeTable: rendering.changeTable,
    lines: rendering.lines,
  });
}

/** The outcome for the result of a write call: the rendered body, or INTERNAL when it is no write envelope. */
export function writeOutcome(result: unknown, ctx: RenderContext): Outcome {
  if (!isWriteEnvelope(result)) {
    return {
      ok: false,
      error: toolError('INTERNAL', {
        detail: 'OpenTune returned a result for a write call that is not a write envelope',
        executed: null,
      }),
    };
  }
  return { ok: true, body: writeBody(result, ctx) };
}
