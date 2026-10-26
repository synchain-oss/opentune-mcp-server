// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Renders the write envelope that OTCP returns (spec/otcp/v1/PROTOCOL.md section 14) as the body
// of a tool result: a summary, what the OpenTune window shows, a table of the changes, and one
// line each for warnings, side effects and the undo or revert recipe, with the tool call that
// carries out a recipe (revert.ts). OpenTune sends codes and values only; the sentences come from
// the fixed tables in text.ts, checked by golden snapshots. The full envelope stays in the result
// next to the rendering.

import { toolError } from '../errors/tool-error.js';
import type { Json } from '../otcp/client.js';
import type { Body, Outcome } from '../tools/registry.js';
import { asList, changeTable, isObject, type ChangeTable } from './changes.js';
import { restoreCall, revertPlan, revertText, type RestoreCall } from './revert.js';
import { summarize } from './summary.js';
import {
  RE_RENDER_TEXT,
  SIDE_EFFECT_TEXT,
  WARNING_TEXT,
  token,
  undoReasonText,
  workspaceRevertText,
  type ReRenderState,
} from './text.js';
import { uiEffects, type UiEffect } from './ui-effects.js';

export type { ChangeTable, TableField, TableRow } from './changes.js';
export { MAX_TABLE_ROWS } from './changes.js';
export type { RestoreCall } from './revert.js';
export type { UiEffect } from './ui-effects.js';
export type { ReRenderState } from './text.js';

export interface RenderContext {
  /** The tool that made the call, for example opentune_set_key. */
  readonly tool: string;
  /**
   * Set for a result that changed the vocoder weight: whether the new weight has loaded, which decides how the
   * side effect reRenderQueued reads (ReRenderState). Absent: the generic words.
   */
  readonly reRender?: ReRenderState;
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
      /** The tool call that carries out the recipe, or null when no tool of this server performs it. */
      readonly restore: RestoreCall | null;
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

/** A revert line: what OpenTune sent, the tool call that carries it out, and how. */
function revertLine(revert: unknown, text: (sentence: string) => string): Line {
  const plan = revertPlan(revert);
  return { kind: 'revert', text: text(revertText(plan)), revert, restore: restoreCall(plan) };
}

function sideEffectLines(envelope: Json, reRender?: ReRenderState): Line[] {
  const effects = isObject(envelope.sideEffects) ? envelope.sideEffects : {};
  return Object.entries(effects).flatMap(([name, details]) => {
    const known =
      name === 'reRenderQueued' && reRender !== undefined ? RE_RENDER_TEXT[reRender] : SIDE_EFFECT_TEXT[name];
    const label = token(name, 'camel');
    const text = known ?? `side effect ${label ?? 'with an unrecognized name'}, which this server does not know`;
    const revert = isObject(details) ? (details.revert ?? null) : null;
    const lines: Line[] = [
      { kind: 'sideEffect', name, text: `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}.`, details, revert },
    ];
    if (revert !== null) lines.push(revertLine(revert, (s) => `${s} (reverts side effect ${label ?? 'above'})`));
    else if (name === 'workspaceSwitched') {
      // The protocol gives no recipe for the switch, but the user can take it back: say how, so the agent does
      // not leave the user in a view they did not ask for without a word.
      const from = isObject(details) ? details.from : undefined;
      lines.push({ kind: 'revert', text: workspaceRevertText(from), revert: null, restore: null });
    }
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
            : `Undoable as one step: undo it with opentune_undo, undo_id ${undoId}.`,
        undoId: undo.undoId ?? null,
        description: undo.description ?? null,
      },
    ];
  }
  if (undo.reason === 'no_op') return [];
  return [revertLine(undo.revert ?? null, (s) => `Not undoable (${undoReasonText(undo.reason)}). ${s}`)];
}

/** Renders an envelope that has been checked against the OTCP write envelope schema. */
export function renderWrite(envelope: Json, ctx: RenderContext): Rendering {
  return {
    summary: summarize(envelope, ctx.tool, ctx.reRender === undefined ? {} : { reRender: ctx.reRender }),
    uiEffects: uiEffects(envelope),
    changeTable: changeTable(envelope),
    lines: [...warningLines(envelope), ...sideEffectLines(envelope, ctx.reRender), ...undoLines(envelope)],
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
  // The leading summary keeps it first; the rendering, spread last, wins over a same-named envelope
  // member. Spreading defines members, so an envelope member named __proto__ stays a data member
  // instead of replacing the prototype of the body, as Object.assign would.
  const leading: Json = { summary: rendering.summary, ...envelope };
  return { ...leading, ...rendering };
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
