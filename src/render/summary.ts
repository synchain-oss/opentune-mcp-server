// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The one-sentence summary of a write result. Anything that cannot be undone, destroys something
// or has side effects nobody asked for comes first, inside the first sentence. The sentence is
// composed from the tool name and from tokens checked against their protocol form, never from
// names, labels or paths that OpenTune returned.

import type { Json } from '../otcp/client.js';
import { asList, entitiesOf, isObject, methodOmitted, type TableRow } from './changes.js';
import { revertFlag, revertPlan } from './revert.js';
import { RE_RENDER_TEXT, SIDE_EFFECT_TEXT, reRenderNote, token, undoReasonText, type ReRenderState } from './text.js';

/** Warning codes that make a result destructive on their own. */
export const DESTRUCTIVE_WARNINGS = new Set(['IRREVERSIBLE', 'UPSTREAM_UNDO_DEFECT', 'OVERWROTE_OTHER_PROJECT']);

export function warningCodes(envelope: Json): string[] {
  return asList(envelope.warnings).flatMap((w) => {
    const code = isObject(w) ? token(w.code, 'code') : null;
    return code === null ? [] : [code];
  });
}

/**
 * "2 notes, 1 key": counts per entity name, the name only when it has the protocol form. `omitted` is
 * what the method left out of the list these entities came from (see changes.ts): it is part of the
 * count, so the sentence gives the real total and not the length of a list that was cut short. The
 * left-out entities have no name, so a cut list is named by the one entity name of the listed ones, or
 * is "items" when the listed ones differ.
 */
function countPhrase(entities: readonly { item: Json }[], omitted = 0): string {
  const counts = new Map<string, number>();
  for (const { item } of entities) {
    const name = token(item.entity, 'camel') ?? 'item';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (omitted > 0) {
    const total = entities.length + omitted;
    const [only] = counts.size === 1 ? [...counts.keys()] : [];
    return `${String(total)} ${only === undefined ? 'items' : `${only}s`}`;
  }
  return [...counts].map(([name, n]) => `${String(n)} ${name}${n > 1 ? 's' : ''}`).join(', ');
}

const VERBS: Record<TableRow['kind'], [string, string]> = {
  changed: ['changed', 'change'],
  created: ['created', 'create'],
  removed: ['removed', 'remove'],
};

/** The members of the envelope that list the entities of each kind. */
const LISTS: Record<TableRow['kind'], string> = { changed: 'changes', created: 'created', removed: 'removed' };

/**
 * What a result did, by the real number of entities: the listed ones plus those the method left out of its
 * lists (it lists at most 200 per kind). A kind whose list was cut is said so after the first sentence by
 * listNote, because the counts in the first sentence are totals and the table shows only some of them.
 */
function didPhrase(envelope: Json, dryRun: boolean): string {
  const entities = entitiesOf(envelope);
  const left = methodOmitted(envelope);
  const parts = (['changed', 'created', 'removed'] as const).flatMap((kind) => {
    const of = entities.filter((e) => e.kind === kind);
    return of.length === 0 && left[kind] === 0 ? [] : [`${VERBS[kind][dryRun ? 1 : 0]} ${countPhrase(of, left[kind])}`];
  });
  return parts.length === 0 ? (dryRun ? 'change nothing listed' : 'changed nothing listed') : parts.join(', ');
}

/** " Only the first 200 entries of created are listed." for each list the method cut short; else nothing. */
function listNote(envelope: Json): string {
  const left = methodOmitted(envelope);
  return (['changed', 'created', 'removed'] as const)
    .filter((kind) => left[kind] > 0)
    .map((kind) => {
      const listed = asList(envelope[LISTS[kind]]).length;
      return ` Only the first ${String(listed)} entries of ${LISTS[kind]} are listed.`;
    })
    .join('');
}

const COLOUR_RE = /^#[0-9A-Fa-f]{6}$/;
const isTrackId = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const MAX_TRACKS_NAMED = 8;

/**
 * The hidden tracks a result shows and the track colours it changes, named for the first sentence: a
 * duplicate takes the first hidden slot, shows it and gives it the colour of its source, which a reader of
 * "changed 1 track" would not know. They come from `changes` (members visible and colour) and from the side
 * effect tracksRevealed, each track once. Positions are checked integers and colours checked #RRGGBB values;
 * anything else is left out of the sentence.
 */
function trackFacts(envelope: Json, dryRun: boolean): { revealed: readonly number[]; phrases: readonly string[] } {
  const revealed: number[] = [];
  const recoloured: string[] = [];
  for (const item of asList(envelope.changes)) {
    if (!isObject(item) || item.entity !== 'track') continue;
    const id = isObject(item.ref) ? item.ref.trackId : undefined;
    if (!isTrackId(id)) continue;
    const fields = isObject(item.fields) ? item.fields : {};
    const visible = isObject(fields.visible) ? fields.visible : {};
    if (visible.before === false && visible.after === true && !revealed.includes(id)) revealed.push(id);
    const colour = isObject(fields.colour) ? fields.colour : null;
    if (colour !== null) {
      const { before, after } = colour;
      const values =
        typeof before === 'string' && typeof after === 'string' && COLOUR_RE.test(before) && COLOUR_RE.test(after)
          ? ` from ${before} to ${after}`
          : '';
      recoloured.push(`the colour of track ${String(id)} ${dryRun ? 'would change' : 'changed'}${values}`);
    }
  }
  const effects = isObject(envelope.sideEffects) ? envelope.sideEffects : {};
  const effect = isObject(effects.tracksRevealed) ? effects.tracksRevealed : {};
  for (const id of asList(effect.trackIds)) if (isTrackId(id) && !revealed.includes(id)) revealed.push(id);
  const phrases: string[] = [];
  if (revealed.length > 0) {
    const shown = revealed.slice(0, MAX_TRACKS_NAMED).join(', ');
    const more = revealed.length > MAX_TRACKS_NAMED ? ` and ${String(revealed.length - MAX_TRACKS_NAMED)} more` : '';
    const noun = revealed.length === 1 ? 'track' : 'tracks';
    phrases.push(`${dryRun ? 'would reveal' : 'revealed'} the hidden ${noun} ${shown}${more}`);
  }
  phrases.push(...recoloured.slice(0, MAX_TRACKS_NAMED));
  return { revealed, phrases };
}

function flagsOf(envelope: Json, reRender?: ReRenderState): string[] {
  const flags: string[] = [];
  const removed = asList(envelope.removed).length;
  if (removed > 0 || warningCodes(envelope).some((c) => DESTRUCTIVE_WARNINGS.has(c))) flags.push('destructive');
  const tracks = trackFacts(envelope, envelope.dryRun === true);
  flags.push(...tracks.phrases);
  const undo = isObject(envelope.undo) ? envelope.undo : null;
  // A result that changed nothing has nothing to undo; the no_op reason says only that.
  if (undo !== null && undo.undoable === false && undo.reason !== 'no_op') {
    flags.push(`not undoable: ${undoReasonText(undo.reason)}`);
    flags.push(revertFlag(revertPlan(undo.revert)));
  }
  // The side effect tracksRevealed is already said with the tracks it names above.
  const effects = Object.keys(isObject(envelope.sideEffects) ? envelope.sideEffects : {}).filter(
    (name) => !(name === 'tracksRevealed' && tracks.revealed.length > 0),
  );
  if (effects.length > 0) {
    const names = effects.map((name) =>
      name === 'reRenderQueued' && reRender !== undefined
        ? RE_RENDER_TEXT[reRender]
        : (SIDE_EFFECT_TEXT[name] ?? `side effect ${token(name, 'camel') ?? 'with an unrecognized name'}`),
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

/**
 * The sentence for results that queued a render (side effect reRenderQueued): what the user hears is still the
 * old sound until the render is current, and an export waits for it. Nothing is rendered for a dry run, for a
 * result that changed nothing or for a job that has only started, so those get no sentence. It is " <sentence>"
 * (once, for any number of results) or an empty string.
 */
export function reRenderSentence(envelopes: readonly Json[], reRender?: ReRenderState): string {
  const queued = envelopes.some(
    (envelope) =>
      envelope.dryRun !== true &&
      envelope.noOp !== true &&
      !isObject(envelope.job) &&
      isObject(envelope.sideEffects) &&
      'reRenderQueued' in envelope.sideEffects,
  );
  return queued ? ` ${reRenderNote(reRender)}` : '';
}

export interface SummarizeOptions {
  /**
   * false leaves the first-sentence flags out. A summary that combines several results carries every
   * flag of all of them in its own first sentence, so the parts do not repeat them.
   */
  readonly flags?: boolean;
  /** How the side effect reRenderQueued of a vocoder-weight change reads (ReRenderState); absent: the generic words. */
  readonly reRender?: ReRenderState;
}

export function summarize(envelope: Json, tool: string, options: SummarizeOptions = {}): string {
  const withFlags = options.flags !== false;
  const warnings = warningCodes(envelope);
  const tail = warnings.length === 0 ? '' : ` Warnings: ${warnings.join(', ')}.`;
  const states = (): string[] => (withFlags ? stateFlags(envelope, warnings) : []);
  const flags = (): string[] => (withFlags ? flagsOf(envelope, options.reRender) : []);
  const job = isObject(envelope.job) ? envelope.job : null;
  if (job !== null) {
    const id = token(job.jobId, 'jobId');
    const kind = token(job.kind, 'camel');
    const state = token(job.state, 'camel');
    const named = id === null ? 'a job' : `job ${id}${kind === null ? '' : ` (${kind})`}`;
    const flagText = inParens([...flags(), ...states()]);
    return (
      `${tool}: started ${named}${state === null ? '' : `, ${state}`}${flagText}; ` +
      `nothing is committed until it finishes. Follow it with opentune_get_job.${tail}`
    );
  }
  const undo = isObject(envelope.undo) ? envelope.undo : null;
  const undoId = undo?.undoable === true ? token(undo.undoId, 'undoId') : null;
  const undoText = undoId === null ? '' : ` Undo it as one step with undoId ${undoId}.`;
  if (envelope.noOp === true) {
    const flagText = inParens([...flags(), ...states()]);
    return `${tool}: nothing was changed, which is a success${flagText}.${undoText}${tail}`;
  }
  const dryRun = envelope.dryRun === true;
  const lead = dryRun
    ? `${tool}: dry run, nothing was changed; would ${didPhrase(envelope, true)}`
    : `${tool}: ${didPhrase(envelope, false)}`;
  // The parts of a combined summary leave the render sentence to the combined one (flags: false).
  const rendering = withFlags ? reRenderSentence([envelope], options.reRender) : '';
  return `${lead}${inParens(flags())}.${listNote(envelope)}${rendering}${undoText}${tail}`;
}

/**
 * The first-sentence flags of several results taken together (not undoable, destructive, side
 * effects, a changed unsaved-changes mark), each once. A result that bundles several requests
 * puts them in its first sentence, so that a reader of the first sentence misses none of them.
 */
export function leadFlags(envelopes: readonly Json[]): string[] {
  const flags: string[] = [];
  for (const envelope of envelopes) {
    for (const flag of [...flagsOf(envelope), ...stateFlags(envelope, warningCodes(envelope))]) {
      if (!flags.includes(flag)) flags.push(flag);
    }
  }
  return flags;
}
