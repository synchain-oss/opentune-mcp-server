// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The one-sentence summary of a write result. Anything that cannot be undone, destroys something
// or has side effects nobody asked for comes first, inside the first sentence. The sentence is
// composed from the tool name and from tokens checked against their protocol form, never from
// names, labels or paths that OpenTune returned.

import type { Json } from '../otcp/client.js';
import { asList, entitiesOf, isObject, type TableRow } from './changes.js';
import { SIDE_EFFECT_TEXT, token, undoReasonText } from './text.js';

/** Warning codes that make a result destructive on their own. */
const DESTRUCTIVE_WARNINGS = new Set(['IRREVERSIBLE', 'UPSTREAM_UNDO_DEFECT', 'OVERWROTE_OTHER_PROJECT']);

export function warningCodes(envelope: Json): string[] {
  return asList(envelope.warnings).flatMap((w) => {
    const code = isObject(w) ? token(w.code, 'code') : null;
    return code === null ? [] : [code];
  });
}

/** "2 notes, 1 key": counts per entity name, the name only when it has the protocol form. */
function countPhrase(entities: readonly { item: Json }[]): string {
  const counts = new Map<string, number>();
  for (const { item } of entities) {
    const name = token(item.entity, 'camel') ?? 'item';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, n]) => `${String(n)} ${name}${n > 1 ? 's' : ''}`).join(', ');
}

const VERBS: Record<TableRow['kind'], [string, string]> = {
  changed: ['changed', 'change'],
  created: ['created', 'create'],
  removed: ['removed', 'remove'],
};

function didPhrase(envelope: Json, dryRun: boolean): string {
  const entities = entitiesOf(envelope);
  const parts = (['changed', 'created', 'removed'] as const).flatMap((kind) => {
    const of = entities.filter((e) => e.kind === kind);
    return of.length === 0 ? [] : [`${VERBS[kind][dryRun ? 1 : 0]} ${countPhrase(of)}`];
  });
  const own = envelope.omittedChangeCount;
  const more = typeof own === 'number' && Number.isInteger(own) && own > 0 ? own : 0;
  const text = parts.length === 0 ? (dryRun ? 'change nothing listed' : 'changed nothing listed') : parts.join(', ');
  return more > 0 ? `${text} (and ${String(more)} more not listed)` : text;
}

function flagsOf(envelope: Json): string[] {
  const flags: string[] = [];
  const removed = asList(envelope.removed).length;
  if (removed > 0 || warningCodes(envelope).some((c) => DESTRUCTIVE_WARNINGS.has(c))) flags.push('destructive');
  const undo = isObject(envelope.undo) ? envelope.undo : null;
  // A result that changed nothing has nothing to undo; the no_op reason says only that.
  if (undo !== null && undo.undoable === false && undo.reason !== 'no_op') {
    flags.push(`not undoable: ${undoReasonText(undo.reason)}`);
    const revert = isObject(undo.revert) ? undo.revert : null;
    const method = revert === null ? null : token(revert.method, 'method');
    if (method === null) flags.push('cannot be restored by any request');
    else
      flags.push(
        revert?.requiresConsent === true
          ? `can be restored with ${method} only after the user explicitly agrees`
          : `can be restored with ${method}, see the revert line`,
      );
  }
  const effects = Object.keys(isObject(envelope.sideEffects) ? envelope.sideEffects : {});
  if (effects.length > 0) {
    const names = effects.map(
      (name) => SIDE_EFFECT_TEXT[name] ?? `side effect ${token(name, 'camel') ?? 'with an unrecognized name'}`,
    );
    flags.push(`side effects: ${names.join(', ')}`);
  }
  return flags;
}

/**
 * What a result that changed nothing, or that only started a job, still did to the project: an
 * undo or redo step used up (UNDO_NO_EFFECT) and a change of the unsaved-changes mark. Such a
 * result reads as harmless, so these go into the first sentence too.
 */
function stateFlags(envelope: Json, warnings: readonly string[]): string[] {
  const dirty = isObject(envelope.dirty) ? envelope.dirty : {};
  const usedUp = warnings.includes('UNDO_NO_EFFECT');
  let mark: string | null = null;
  if (dirty.before === false && dirty.after === true) mark = 'the project is now marked as changed';
  else if (dirty.before === true && dirty.after === false) mark = 'the project is no longer marked as changed';
  else if (usedUp && dirty.before === true && dirty.after === true) mark = 'the project is still marked as changed';
  if (usedUp) return [`the undo or redo step is used up${mark === null ? '' : ` and ${mark}`}`];
  return mark === null ? [] : [mark];
}

const inParens = (flags: readonly string[]): string => (flags.length === 0 ? '' : ` (${flags.join('; ')})`);

export function summarize(envelope: Json, tool: string): string {
  const warnings = warningCodes(envelope);
  const tail = warnings.length === 0 ? '' : ` Warnings: ${warnings.join(', ')}.`;
  const job = isObject(envelope.job) ? envelope.job : null;
  if (job !== null) {
    const id = token(job.jobId, 'jobId');
    const kind = token(job.kind, 'camel');
    const state = token(job.state, 'camel');
    const named = id === null ? 'a job' : `job ${id}${kind === null ? '' : ` (${kind})`}`;
    const flagText = inParens([...flagsOf(envelope), ...stateFlags(envelope, warnings)]);
    return (
      `${tool}: started ${named}${state === null ? '' : `, ${state}`}${flagText}; ` +
      `nothing is committed until it finishes. Follow it with opentune_get_job.${tail}`
    );
  }
  const undo = isObject(envelope.undo) ? envelope.undo : null;
  const undoId = undo?.undoable === true ? token(undo.undoId, 'undoId') : null;
  const undoText = undoId === null ? '' : ` Undo it as one step with undoId ${undoId}.`;
  if (envelope.noOp === true) {
    const flagText = inParens([...flagsOf(envelope), ...stateFlags(envelope, warnings)]);
    return `${tool}: nothing was changed, which is a success${flagText}.${undoText}${tail}`;
  }
  const dryRun = envelope.dryRun === true;
  const lead = dryRun
    ? `${tool}: dry run, nothing was changed; would ${didPhrase(envelope, true)}`
    : `${tool}: ${didPhrase(envelope, false)}`;
  return `${lead}${inParens(flagsOf(envelope))}.${undoText}${tail}`;
}
