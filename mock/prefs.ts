// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// prefs.set of the mock (capability prefs.write): the processing preferences that OpenTune's
// preferences window changes (spec/otcp/v1/methods/prefs.set.schema.json). Preferences are
// user-global: they are not part of the project, change no undo history and outlive the session.
// Changing the editing scheme is applied by a job of kind prefsApply, as the editor applies it
// asynchronously.

import { checkNotBusy, envelope, type Handler, type MethodContext } from './context.js';
import { jobStartedResult } from './job-reply.js';
import { generateNotes, needsGeneratedNotes } from './notegen.js';
import { EMPTY_DIFF } from './writes.js';

const warning = (code: string, subject: unknown = null, data: unknown = null) => ({ code, subject, data });

interface Setting {
  readonly name: 'tuningHz' | 'editingScheme' | 'hybridMode' | 'experimentalFeatures';
  readonly label: string;
  readonly unit: string | null;
}

/** In the order of the schema, which is the order `changes` lists them in. */
const SETTINGS: readonly Setting[] = [
  { name: 'tuningHz', label: 'Tuning frequency', unit: 'hz' },
  { name: 'editingScheme', label: 'Editing scheme', unit: null },
  { name: 'hybridMode', label: 'Hybrid mode', unit: null },
  { name: 'experimentalFeatures', label: 'Experimental features', unit: null },
];

type Value = number | string | boolean;

const currentValue = (context: MethodContext, name: Setting['name']): Value =>
  name === 'editingScheme' ? context.world.editingScheme : context.world.prefs[name];

function assign(context: MethodContext, name: Setting['name'], value: Value): void {
  const { world } = context;
  if (name === 'editingScheme') world.editingScheme = String(value);
  else if (name === 'tuningHz') world.prefs.tuningHz = Number(value);
  else world.prefs[name] = value === true;
}

/** Applies the preferences of the call that differ from the current ones, and reports it. */
function apply(context: MethodContext): Record<string, unknown> {
  const { world, params } = context;
  const dirtyBefore = world.project.dirty;
  const before = world.capture();
  const changes: unknown[] = [];
  const revert: Record<string, Value> = {};
  const changed: Setting[] = [];
  for (const setting of SETTINGS) {
    const wanted = params[setting.name] as Value | undefined;
    if (wanted === undefined) continue;
    const was = currentValue(context, setting.name);
    if (was === wanted) continue;
    assign(context, setting.name, wanted);
    revert[setting.name] = was;
    changed.push(setting);
    changes.push({
      entity: 'preference',
      ref: { preference: setting.name },
      label: setting.label,
      fields: { [setting.name]: { before: was, after: wanted, unit: setting.unit } },
    });
  }
  if (changed.length === 0) {
    return envelope(world, {
      applied: true,
      noOp: true,
      diff: EMPTY_DIFF,
      contents: [],
      undo: { undoable: false, reason: 'no_op', revert: null },
      dirtyBefore,
    });
  }
  const has = (name: Setting['name']) => changed.some((s) => s.name === name);
  const warnings: unknown[] = [warning('GLOBAL_PREFERENCE', null, { preferences: changed.map((s) => s.name) })];
  if (has('tuningHz')) warnings.push(warning('NOT_RETROACTIVE', { preference: 'tuningHz' }));
  const sideEffects: Record<string, unknown> = {};
  const touched = [];
  if (has('hybridMode') && world.contents.size > 0) {
    const contents = [...world.contents.values()];
    for (const content of contents) world.queueRender(content);
    sideEffects.reRenderQueued = { contentIds: contents.map((c) => c.id), revert: null };
  }
  const open = world.pianoRollContent;
  if (has('editingScheme') && world.editingScheme === 'openDyne' && open !== null && needsGeneratedNotes(open)) {
    const noteCount = generateNotes(world, open);
    sideEffects.notesGenerated = { contentId: open.id, noteCount, revert: null };
    warnings.push(
      warning('SCHEME_GENERATED_NOTES', { contentId: open.id }),
      warning('IRREVERSIBLE', { contentId: open.id }),
    );
    touched.push(open);
  }
  return envelope(world, {
    applied: true,
    noOp: false,
    changes,
    diff: world.diff(before, world.capture()),
    contents: touched,
    undo: { undoable: false, reason: 'ui_parity', revert: { method: 'prefs.set', params: revert } },
    dirtyBefore,
    sideEffects,
    warnings,
  });
}

const set: Handler = (context) => {
  const { world, params } = context;
  checkNotBusy(context);
  if (typeof params.editingScheme === 'string' && params.editingScheme !== world.editingScheme) {
    // The editor applies a new scheme asynchronously: the job commits every change of the call. Before its first
    // step it checks the busy state again, so a dialog that opened in the meantime fails it with nothing changed.
    const job = context.startJob('prefsApply', () => {
      checkNotBusy(context);
      return apply(context);
    });
    return jobStartedResult(world, job);
  }
  return apply(context);
};

export const prefsHandlers: Readonly<Record<string, Handler>> = { 'prefs.set': set };
