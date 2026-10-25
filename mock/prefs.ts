// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// prefs.set of the mock (capability prefs.write): the processing preferences that OpenTune's
// preferences window changes (spec/otcp/v1/methods/prefs.set.schema.json). Preferences are
// user-global: they are not part of the project, change no undo history and outlive the session.
// Changing the editing scheme, the vocoder weight or the rendering priority is applied by a job of
// kind prefsApply (PROTOCOL.md section 12.7), as OpenTune applies the scheme to its editor and
// reconfigures its vocoder asynchronously.

import { checkNotBusy, envelope, type Handler, type MethodContext } from './context.js';
import { MockError, refuse } from './errors.js';
import { jobStartedResult } from './job-reply.js';
import type { JobDriver } from './jobs.js';
import { carries } from './model.js';
import { generateNotes, needsGeneratedNotes } from './notegen.js';
import { EMPTY_DIFF } from './writes.js';

const warning = (code: string, subject: unknown = null, data: unknown = null) => ({ code, subject, data });

type Name =
  | 'tuningHz'
  | 'editingScheme'
  | 'hybridMode'
  | 'experimentalFeatures'
  | 'vocoderWeight'
  | 'renderingPriority'
  | 'f0Model'
  | 'referenceAlignMode';

interface Setting {
  readonly name: Name;
  readonly label: string;
  readonly unit: string | null;
}

/** In the order `changes`, GLOBAL_PREFERENCE and the revert recipe list them in (the four first, the four new ones after). */
const SETTINGS: readonly Setting[] = [
  { name: 'tuningHz', label: 'Tuning frequency', unit: 'hz' },
  { name: 'editingScheme', label: 'Editing scheme', unit: null },
  { name: 'hybridMode', label: 'Hybrid mode', unit: null },
  { name: 'experimentalFeatures', label: 'Experimental features', unit: null },
  { name: 'vocoderWeight', label: 'Vocoder weight', unit: null },
  { name: 'renderingPriority', label: 'Rendering priority', unit: null },
  { name: 'f0Model', label: 'Pitch model', unit: null },
  { name: 'referenceAlignMode', label: 'Reference alignment mode', unit: null },
];

/** The members that make OpenTune apply the change asynchronously, so that the call hands them to a job. */
const JOB_MEMBERS: readonly Name[] = ['editingScheme', 'vocoderWeight', 'renderingPriority'];

/** The members whose values must be among the installation's options. */
const OPTION_MEMBERS = ['vocoderWeight', 'f0Model'] as const;

/** How often a prefsApply job looks at the vocoder while it waits. */
const VOCODER_POLL_MS = 3;

type Value = number | string | boolean;

const currentValue = (context: MethodContext, name: Name): Value =>
  name === 'editingScheme' ? context.world.editingScheme : context.world.prefs[name];

function assign(context: MethodContext, name: Name, value: Value): void {
  const { world } = context;
  if (name === 'editingScheme') world.editingScheme = String(value);
  else if (name === 'tuningHz') world.prefs.tuningHz = Number(value);
  else if (name === 'hybridMode' || name === 'experimentalFeatures') world.prefs[name] = value === true;
  else world.prefs[name] = String(value);
}

interface Planned {
  readonly setting: Setting;
  readonly was: Value;
  readonly wanted: Value;
}

/** The members of the call that differ from the current values, in the order of SETTINGS. */
function plan(context: MethodContext): Planned[] {
  const planned: Planned[] = [];
  for (const setting of SETTINGS) {
    const wanted = context.params[setting.name] as Value | undefined;
    if (wanted === undefined) continue;
    const was = currentValue(context, setting.name);
    if (was !== wanted) planned.push({ setting, was, wanted });
  }
  return planned;
}

/** A vocoder weight or pitch model that the installation does not offer is refused before anything changes. */
function checkOptions({ world, params }: MethodContext): void {
  for (const name of OPTION_MEMBERS) {
    const wanted = params[name];
    if (typeof wanted === 'string' && !world.prefs.options[name].filter(carries).includes(wanted)) {
      throw refuse(
        'INVALID_ARGUMENT',
        'option_unavailable',
        `${name} is not one of the values that prefs.get lists in processing.options.${name}`,
      );
    }
  }
}

/** The pitch model is applied first; one that OpenTune cannot load fails the call with nothing changed. */
function checkF0Model({ world }: MethodContext, planned: readonly Planned[]): void {
  const model = planned.find(({ setting }) => setting.name === 'f0Model');
  if (model !== undefined && world.unloadableF0Models.has(String(model.wanted))) {
    throw refuse('MODEL_UNAVAILABLE', 'model_missing', 'OpenTune could not load the pitch model');
  }
}

/**
 * Makes the changes of `planned` and reports them. `waited` tells that the job waits for the vocoder (it was ready
 * before the call): only then is the render that a new vocoder weight causes reported.
 */
function commit(context: MethodContext, planned: readonly Planned[], waited: boolean): Record<string, unknown> {
  const { world } = context;
  const dirtyBefore = world.project.dirty;
  const before = world.capture();
  if (planned.length === 0) {
    return envelope(world, {
      applied: true,
      noOp: true,
      diff: EMPTY_DIFF,
      contents: [],
      undo: { undoable: false, reason: 'no_op', revert: null },
      dirtyBefore,
    });
  }
  const changes: unknown[] = [];
  const revert: Record<string, Value> = {};
  for (const { setting, was, wanted } of planned) {
    assign(context, setting.name, wanted);
    // A previous name that the wire cannot carry is reported as null and has no value to revert to.
    const before = setting.name === 'vocoderWeight' && !carries(String(was)) ? null : was;
    if (before !== null) revert[setting.name] = before;
    changes.push({
      entity: 'preference',
      ref: { preference: setting.name },
      label: setting.label,
      fields: { [setting.name]: { before, after: wanted, unit: setting.unit } },
    });
  }
  const has = (name: Name) => planned.some(({ setting }) => setting.name === name);
  const warnings: unknown[] = [
    warning('GLOBAL_PREFERENCE', null, { preferences: planned.map(({ setting }) => setting.name) }),
  ];
  if (has('tuningHz')) warnings.push(warning('NOT_RETROACTIVE', { preference: 'tuningHz' }));
  // The reference alignment mode only affects AUTO Ref, an experimental feature.
  if (has('referenceAlignMode')) warnings.push(warning('EXPERIMENTAL_FEATURE', { preference: 'referenceAlignMode' }));
  const sideEffects: Record<string, unknown> = {};
  const touched = [];
  // A new vocoder weight clears the caches and renders every clip again, which the result reports only when the job
  // waited for the vocoder; a new rendering priority only resets the inference backend, which invalidates nothing.
  if ((has('hybridMode') || has('vocoderWeight')) && world.contents.size > 0) {
    const contents = [...world.contents.values()];
    for (const content of contents) world.queueRender(content);
    if (has('hybridMode') || waited) {
      sideEffects.reRenderQueued = { contentIds: contents.map((c) => c.id), revert: null };
    }
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
    undo: {
      undoable: false,
      reason: 'ui_parity',
      revert: Object.keys(revert).length === 0 ? null : { method: 'prefs.set', params: revert },
    },
    dirtyBefore,
    sideEffects,
    warnings,
  });
}

/**
 * Takes the changes of `planned` back, as a job that ran into its limit does: a preference that another write changed
 * meanwhile keeps that write's value. Returns the names of those preferences.
 */
function withdraw(context: MethodContext, planned: readonly Planned[]): string[] {
  const kept: string[] = [];
  for (const { setting, was, wanted } of planned) {
    if (currentValue(context, setting.name) === wanted) assign(context, setting.name, was);
    else kept.push(setting.name);
  }
  return kept;
}

/**
 * The prefsApply job (PROTOCOL.md section 12.7). Its first step checks the busy state again, makes every change
 * (the pitch model first) and, after a change of the vocoder weight or the rendering priority of a vocoder that was
 * ready, starts the reconfiguration and waits for it. The vocoder reports ready for a moment after the command, so the
 * job waits until the vocoder is ready, not reconfiguring and nothing is queued. When the wait limit passes, it takes
 * its changes back and fails with MODEL_UNAVAILABLE(vocoder_not_ready).
 */
function prefsApplyDriver(context: MethodContext): JobDriver {
  const { world } = context;
  let started = false;
  let planned: Planned[] = [];
  let result: Record<string, unknown> = {};
  let deadline = 0;
  return () => {
    if (!started) {
      try {
        checkNotBusy(context);
        planned = plan(context);
        checkF0Model(context, planned);
        const vocoderWasReady = world.vocoder.ready && !world.vocoder.reconfiguring;
        const changesVocoder = planned.some(
          ({ setting }) => setting.name === 'vocoderWeight' || setting.name === 'renderingPriority',
        );
        const waits = changesVocoder && vocoderWasReady;
        result = commit(context, planned, waits);
        started = true;
        if (!waits) return { done: { state: 'succeeded', result } };
        world.reconfigureVocoder();
        deadline = world.now() + world.vocoderTiming.waitLimitMs;
        return { next: VOCODER_POLL_MS };
      } catch (error) {
        if (error instanceof MockError) return { done: { state: 'failed', error: error.init } };
        throw error;
      }
    }
    if (world.vocoderSettled) return { done: { state: 'succeeded', result } };
    const left = deadline - world.now();
    if (left > 0) return { next: Math.min(VOCODER_POLL_MS, left) };
    const kept = withdraw(context, planned);
    const detail =
      kept.length === 0
        ? 'the vocoder did not become ready in time; the previous preferences were restored'
        : 'the vocoder did not become ready in time; the previous preferences were restored except those another ' +
          `write changed while the job waited, which keep that write's value: ${kept.join(' ')}`;
    return {
      done: {
        state: 'failed',
        error: { kind: 'MODEL_UNAVAILABLE', reason: 'vocoder_not_ready', detail, executed: kept.length > 0 },
      },
    };
  };
}

const set: Handler = (context) => {
  const { world } = context;
  checkNotBusy(context);
  checkOptions(context);
  const planned = plan(context);
  if (planned.some(({ setting }) => JOB_MEMBERS.includes(setting.name))) {
    // The editor applies a new scheme and the vocoder a new weight or priority asynchronously: the job commits every
    // change of the call. Before its first step it checks the busy state again, so a dialog that opened in the
    // meantime fails it with nothing changed.
    const job = context.jobs.start({ kind: 'prefsApply', cancellable: false }, prefsApplyDriver(context));
    return jobStartedResult(world, job);
  }
  checkF0Model(context, planned);
  return commit(context, planned, false);
};

export const prefsHandlers: Readonly<Record<string, Handler>> = { 'prefs.set': set };
