// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The fixed texts of the write-result renderer. OpenTune sends codes and names, never prose
// (spec/otcp/v1/PROTOCOL.md sections 14 and 18); the sentences here are this server's, reviewed
// through the golden snapshots in test/golden/render. A code that is not in a table is listed as
// it came, without a description.

import { trustedToken } from '../sanitize/untrusted.js';

/** Forms of the tokens the renderer may place in a sentence; anything else stays a JSON value. */
export const FORMS = {
  code: /^[A-Z][A-Z0-9_]{0,63}$/,
  camel: /^[a-z][A-Za-z0-9]{0,63}$/,
  reason: /^[a-z][a-z0-9_]{0,63}$/,
  method: /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/,
  undoId: /^u:[0-9a-f]{8}:[1-9][0-9]*$/,
  jobId: /^j:[0-9a-f]{8}:[1-9][0-9]*$/,
  contentId: /^c:[0-9a-f]{8}:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/,
  placementId: /^p:[0-9a-f]{8}:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/,
  /** An OTCP revision token (common.schema.json, revisionToken). */
  revision: /^[A-Za-z0-9._:-]{1,128}$/,
} as const;

export const token = (value: unknown, form: keyof typeof FORMS): string | null => trustedToken(value, FORMS[form]);

/**
 * A lookup table without a prototype. Names such as `constructor`, `toString` or `hasOwnProperty`
 * have the protocol forms of side-effect names, entities and reasons, so OpenTune may send them;
 * in a plain object they would find the members every object inherits. Here they find nothing and
 * are listed as unknown codes.
 */
export function table<T>(entries: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, T>, entries));
}

/** Warning codes of spec/otcp/v1/registry/warnings.json. A test keeps this table equal to the registry. */
export const WARNING_TEXT = table<string>({
  DROPPED_BOUNDARY_NOTES: 'Notes touching the edges of the processed range were dropped instead of regenerated.',
  NOT_PERSISTED: 'The change is applied in the running session but is not stored in the project file.',
  NOT_RETROACTIVE: 'The change applies to future analysis or rendering only; existing results are not recomputed.',
  GLOBAL_PREFERENCE: 'A user-global preference changed; it outlives the project and the session.',
  FADES_RECLAMPED: "Clip fades were shortened to fit the clip's new length.",
  SPLIT_SNAPPED: 'The split position was moved to the nearest analysis frame.',
  OVERLAPS_CLIP: 'The clip now overlaps another clip on the same track.',
  STACKED_ON_SOURCE: 'The copy starts at the same timeline position as its source, so both play at once.',
  TRACK_AUTO_REVEALED: 'A hidden track was made visible because it now holds a clip.',
  KEY_NOT_TRANSPOSED: "The clip's pitch shift changed but its key was not transposed with it.",
  LOOP_NO_EFFECT_STANDALONE: 'The loop flag is set, but looping has no audible effect in OpenTune Standalone.',
  NO_AUDIO_DEVICE: 'No audio output device is available.',
  EXPERIMENTAL_FEATURE: 'The feature used is experimental in OpenTune.',
  MEDIA_MISSING: 'Media that the project refers to is missing.',
  IRREVERSIBLE: 'This change can be neither undone nor reverted by any request of the protocol.',
  CLAMPED:
    'A value was limited as OpenTune limits it in its own editor; the applied value differs from the requested one.',
  REPLACES_ALL_NOTES: 'All existing notes of the content were replaced.',
  UNDO_NO_EFFECT:
    'The undo or redo step changed nothing, but the step is used up and the project is marked as changed.',
  UNDO_ENTRY_POSSIBLY_STALE:
    'The history entry may target a track that has moved since it was recorded (a track was deleted).',
  UPSTREAM_UNDO_DEFECT: 'OpenTune cannot undo this change reliably: it frees objects its own undo entry needs.',
  SELECTION_GENERATED_NOTES: 'Selecting the clip made OpenTune generate its notes, with no undo entry.',
  REFERENCE_ANALYSIS_QUEUED: 'Reference alignment analysis was queued.',
  DIALOG_CLOSE_COMMITTED: 'Closing the dialog committed the value it showed.',
  OVERWROTE_OTHER_PROJECT: 'An existing project file was overwritten.',
  RENDER_NOT_CURRENT: 'The audio rendering is not current; exports wait for it.',
  NOT_SAVED_IN_PROJECT: 'The change is not saved in the project file.',
  SCHEME_GENERATED_NOTES:
    'Switching the editing scheme generated notes for the clip open in the piano roll, with no undo entry.',
  SHARED_CONTENT:
    'The new clips share their contents with the clips they were copied from; an edit of one shows in the other.',
  UNDO_HISTORY_POSSIBLY_STALE:
    'Deleting a track made entries of the undo or redo history possibly stale; they may address tracks that have moved.',
  IMPORT_COMMIT_REPEATED:
    'OpenTune refused a clip id that the project already used, so the import committed the clip again; it was imported.',
  BACKEND_FALLBACK:
    'GPU first was requested, but OpenTune reported when the job ended that it runs on the CPU, because the GPU could not be used; the preference is set all the same.',
  ASIO_RATE_NOT_RESTORED:
    'The audio device was switched, but OpenTune could not restore the sample rate of the ASIO device first; the ASIO driver may still run at another sample rate than before.',
});

/** Side-effect names of PROTOCOL.md section 14.6. */
export const SIDE_EFFECT_TEXT = table<string>({
  notesGenerated: 'OpenTune generated notes for a content',
  reRenderQueued: 'rendering of one or more contents was queued again',
  uiScaleChanged: 'the scale shown in the transport bar changed',
  workspaceSwitched: 'the window switched between the arrangement and the piano roll',
  tempoRounded:
    'the tempo field of the transport bar wrote the tempo it shows, rounded to one decimal, back to the project',
  tracksRevealed: 'hidden tracks became visible',
  dialogClosed: 'a dialog was closed',
  dialogCommitted: 'closing a dialog committed its value',
});

/** A tempo in bpm as the sentence writes it: a finite number in the range of a tempo, else null (never a string from OpenTune). */
const bpmText = (value: unknown): string | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 10_000 ? String(value) : null;

/**
 * What OpenTune did to the tempo when the window switched view (sideEffects.tempoRounded, PROTOCOL.md section 14.6),
 * for the first sentence of a summary: its tempo field wrote the tempo it shows, rounded to one decimal, back to the
 * project. Nobody asked for it. `effect` is the side effect as OpenTune sent it; the two tempi are checked numbers,
 * and a value that is not one is left out of the sentence. `dryRun`: the result predicts it.
 */
export function tempoRoundedWords(effect: unknown, dryRun: boolean): string {
  const e = typeof effect === 'object' && effect !== null ? (effect as Record<string, unknown>) : {};
  const from = bpmText(e.fromBpm);
  const to = bpmText(e.toBpm);
  const tempo = from !== null && to !== null ? `the tempo from ${from} to ${to} bpm` : 'the tempo';
  return (
    `OpenTune ${dryRun ? 'would change' : 'changed'} ${tempo}, because its tempo field rounds it to one decimal ` +
    'when the window switches view'
  );
}

/** The views of the OpenTune window, as workspaceSwitched names them. */
const VIEW_NAME = table<string>({ arrangement: 'the arrangement view', pianoRoll: 'the piano roll' });

/** A view of the window in words; a name this server does not know is "another view", never repeated. */
export function viewName(value: unknown): string {
  const name = token(value, 'camel');
  return (name === null ? undefined : VIEW_NAME[name]) ?? 'another view';
}

/**
 * The way back for a switch of the view (sideEffects.workspaceSwitched, whose own revert is null) on an instance
 * that does not report ui.workspace: no tool can switch the window there, so the user does it with the view
 * buttons of the transport bar.
 */
export const workspaceRevertText = (from: unknown): string =>
  `No tool of this server can switch the window back to ${viewName(from)} yet; the user can click the view buttons in ` +
  'the transport bar (reverts side effect workspaceSwitched).';

/**
 * The way back for a switch of the view on an instance that reports ui.workspace: opentune_manage_ui, op
 * switch_view, with the arguments of the restore member of the same line.
 */
export const workspaceSwitchBackText = (from: unknown): string =>
  `Switch the window back to ${viewName(from)} with the op switch_view of opentune_manage_ui: call it with the ` +
  'arguments in restore, as they are (reverts side effect workspaceSwitched).';

/**
 * The way back for a switch of the view on an instance that reports ui.workspace, when the view the window showed
 * before is not known (the result names none this server knows): the op exists, but there is no call to hand out, so
 * the line says to show the view the user wants.
 */
export const workspaceUnknownBackText =
  'The view the window showed before is not known; with the op switch_view of opentune_manage_ui, show the view the ' +
  'user wants (arrangement or piano_roll) (reverts side effect workspaceSwitched).';

/**
 * What a change of the vocoder weight says about rendering again. OpenTune renders every content again once the
 * new weight has loaded; a job that did not wait for the vocoder (it was not ready before the call) can end before
 * that, and when the weight cannot be loaded nothing is rendered again (PROTOCOL.md section 12.7 rule 4).
 * `loaded`: the vocoder is ready, so the render happens. `afterLoad`: the vocoder is not ready (yet), so it
 * happens only if the weight loads.
 */
export type ReRenderState = 'loaded' | 'afterLoad';

export const RE_RENDER_TEXT: Readonly<Record<ReRenderState, string>> = {
  loaded: 'rendering of one or more contents will be done again with the new vocoder weight, which has loaded',
  afterLoad:
    'rendering of one or more contents starts again only after the new vocoder weight has finished loading, and ' +
    'not at all if it cannot be loaded',
};

/**
 * What a queued render means for what the user hears, for the sentence after the first one: playback keeps the
 * old sound until the render is current (opentune_get_clip_details, section render), and an export waits for it
 * by itself (warning RENDER_NOT_CURRENT). `afterLoad` is the vocoder weight that has not loaded yet.
 */
export function reRenderNote(reRender?: ReRenderState): string {
  return reRender === 'afterLoad'
    ? 'OpenTune renders again only once the new vocoder weight has loaded: until render.current of ' +
        'opentune_get_clip_details is true, playback can still sound the old way, and an export waits for the render by itself.'
    : 'OpenTune is rendering again: playback can still sound the old way until render.current of ' +
        'opentune_get_clip_details is true, and an export waits for the render by itself.';
}

/** Not-undoable reasons (`undo` scope of registry/reasons.json). */
export const UNDO_REASON_TEXT = table<string>({
  ui_parity: 'OpenTune records no undo entry for this, as in its own interface',
  no_upstream_undo: 'OpenTune has no undo for this',
  not_persisted_state: 'the state is not kept in the project',
  upstream_undo_defect: 'OpenTune cannot undo this reliably',
  no_op: 'nothing changed',
});

/** Why a change is not undoable, in words; a reason this server does not know is not repeated. */
export function undoReasonText(reason: unknown): string {
  const known = token(reason, 'reason');
  return (
    (known === null ? undefined : UNDO_REASON_TEXT[known]) ?? 'a reason this server does not know, see undo.reason'
  );
}
