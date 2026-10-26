// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The UI bridge of the mock (capability ui.bridge): ui.getState, ui.dismiss and ui.setSelection
// (spec/otcp/v1/PROTOCOL.md sections 13.2, 14.6, 15.4 rule 4 and 21 rule 3), and ui.setWorkspace
// (capability ui.workspace, section 14.6). The window state it
// reads and changes lives in the model: the dialogs, the first-run overlay, the selection, the
// workspace and the scale shown in the transport bar. A switch of the workspace also lets the tempo field
// of the transport bar round the tempo (sideEffects.tempoRounded, section 14.6).

import { envelope, type Handler, type MethodContext } from './context.js';
import { refuse } from './errors.js';
import { DETECTED_KEY, type ContentRec, type DialogRec, type World } from './model.js';
import { generateNotes, needsGeneratedNotes, predictedNoteCount } from './notegen.js';
import { EMPTY_DIFF } from './writes.js';

const warning = (code: string, subject: unknown = null, data: unknown = null) => ({ code, subject, data });
const SELECTION = { singleton: 'selection' } as const;

/** What a dialog's title says; titles come from OpenTune and are untrusted data, so the mock shows none of its own. */
const DIALOG_TITLES: Readonly<Record<DialogRec['kind'], string>> = {
  trackColour: 'Track colour',
  confirm: 'Confirm',
  pitchShift: 'Pitch shift',
  preferences: 'Preferences',
  message: 'Message',
  unknown: 'Dialog',
};

/** Closing the track-colour dialog commits its colour; a dialog the server cannot classify may do the same. */
export const closeCommits = (dialog: DialogRec): boolean => dialog.kind === 'trackColour' || dialog.kind === 'unknown';

/** The dialogs, as ui.getState and the side effect of ui.dismiss list them. */
const dialogView = (dialog: DialogRec) => ({
  kind: dialog.kind,
  title: DIALOG_TITLES[dialog.kind],
  closeCommits: closeCommits(dialog),
  trackId: dialog.trackId,
});

/** A write of this module is refused while the user is in a gesture, an import or export runs, or a project job runs. */
function checkBusy(context: MethodContext, ignoreModal: boolean): void {
  const reason = context.world.busyReason(context.exportLock, ignoreModal);
  if (reason !== undefined) throw refuse('BUSY', reason, `the UI is busy: ${reason}`, 1000);
}

// ui.getState ----------------------------------------------------------------------------------------

const getState: Handler = ({ world, exportLock }) => ({
  busy: {
    pointerDown: world.busy.pointerDown,
    modalOpen: world.busy.modalOpen || world.dialogs.length > 0,
    importInProgress: world.busy.importInProgress,
    exportInProgress: exportLock,
    projectOperation: world.busy.projectOperation,
  },
  dialogs: world.dialogs.map(dialogView),
  onboarding: { shown: world.prefs.onboardingShown, showing: world.onboardingShowing },
  ui: world.uiSnapshot(),
  uiScale: { ...world.uiScale },
});

// ui.dismiss -----------------------------------------------------------------------------------------

/** What a dismissal that changes nothing reports: view state has no undo and nothing to restore. */
const viewOnly = { undoable: false, reason: 'not_persisted_state', revert: null } as const;
const noOpUndo = { undoable: false, reason: 'no_op', revert: null } as const;

function dismissDialogs(context: MethodContext) {
  const { world, params, hasCapability } = context;
  const open = [...world.dialogs].reverse();
  const dirtyBefore = world.project.dirty;
  if (open.length === 0) {
    return envelope(world, {
      applied: true,
      noOp: true,
      diff: EMPTY_DIFF,
      contents: [],
      undo: noOpUndo,
      dirtyBefore,
    });
  }
  const committing = open.filter(closeCommits);
  if (committing.length > 0 && params.confirm !== true) {
    throw refuse(
      'INVALID_ARGUMENT',
      'dialog_commits_on_close',
      'closing a dialog commits the value it shows; the end user must accept that, then the call carries confirm true',
    );
  }
  const before = world.capture();
  const changes: unknown[] = [];
  const sideEffects: Record<string, unknown> = {
    dialogClosed: { dialogs: open.map(({ kind, trackId }) => ({ kind, trackId })), revert: null },
  };
  const warnings: unknown[] = [];
  const restore: { trackId: number; colour: string }[] = [];
  for (const dialog of committing) {
    if (dialog.kind !== 'trackColour' || dialog.trackId === null || dialog.colour === null) {
      // A dialog the server cannot classify may commit something; the mock cannot say what.
      warnings.push(warning('DIALOG_CLOSE_COMMITTED', null, { kind: dialog.kind }));
      continue;
    }
    const track = world.tracks[dialog.trackId];
    if (track === undefined) continue;
    const colourBefore = track.colour;
    const colourAfter = dialog.colour.toUpperCase();
    track.colour = colourAfter;
    restore.push({ trackId: track.trackId, colour: colourBefore });
    changes.push({
      entity: 'track',
      ref: { trackId: track.trackId },
      label: world.trackLabel(track.trackId),
      fields: { colour: { before: colourBefore, after: colourAfter, unit: null } },
    });
    const revert = hasCapability('tracks.v1')
      ? { method: 'track.set', params: { tracks: [{ trackId: track.trackId, colour: colourBefore }] } }
      : null;
    sideEffects.dialogCommitted = {
      kind: dialog.kind,
      trackId: track.trackId,
      colourBefore,
      colourAfter,
      revert,
    };
    warnings.push(warning('DIALOG_CLOSE_COMMITTED', { trackId: track.trackId }, { kind: dialog.kind }));
  }
  world.dialogs = [];
  if (restore.length > 0) {
    world.touchTrackState();
    world.markDirty();
  }
  const committed = restore.length > 0;
  const revert = hasCapability('tracks.v1') && committed ? { method: 'track.set', params: { tracks: restore } } : null;
  return envelope(world, {
    applied: true,
    noOp: false,
    changes,
    diff: world.diff(before, world.capture()),
    contents: [],
    undo: committed ? { undoable: false, reason: 'ui_parity', revert } : viewOnly,
    dirtyBefore,
    sideEffects,
    warnings,
  });
}

function dismissOnboarding(context: MethodContext) {
  const { world, hasCapability } = context;
  const dirtyBefore = world.project.dirty;
  const showing = world.onboardingShowing;
  if (!showing && world.prefs.onboardingShown) {
    return envelope(world, {
      applied: true,
      noOp: true,
      diff: EMPTY_DIFF,
      contents: [],
      undo: noOpUndo,
      dirtyBefore,
    });
  }
  if (showing && !hasCapability('ui.onboardingClose')) {
    throw refuse(
      'UNSUPPORTED',
      'capability_missing',
      'this instance does not report the capability ui.onboardingClose',
    );
  }
  world.onboardingShowing = false;
  if (world.prefs.onboardingShown) {
    // OpenTune marks onboarding as shown once the overlay shows its choice: closing it then changes the view only.
    return envelope(world, {
      applied: true,
      noOp: false,
      diff: EMPTY_DIFF,
      contents: [],
      undo: viewOnly,
      dirtyBefore,
    });
  }
  world.prefs.onboardingShown = true;
  return envelope(world, {
    applied: true,
    noOp: false,
    changes: [
      {
        entity: 'preference',
        ref: { preference: 'onboardingShown' },
        label: 'First-run onboarding',
        fields: { onboardingShown: { before: false, after: true, unit: null } },
      },
    ],
    diff: EMPTY_DIFF,
    contents: [],
    // A user-global preference that no request of this protocol resets.
    undo: { undoable: false, reason: 'no_upstream_undo', revert: null },
    dirtyBefore,
    warnings: [warning('IRREVERSIBLE', { preference: 'onboardingShown' })],
  });
}

const dismiss: Handler = (context) => {
  // An open dialog does not refuse ui.dismiss, since closing it is the purpose (section 13.2).
  checkBusy(context, true);
  return context.params.target === 'onboarding' ? dismissOnboarding(context) : dismissDialogs(context);
};

// The tempo field ------------------------------------------------------------------------------------

const TEMPO = { singleton: 'tempo' } as const;
/** A tempo within this many bpm of its one-decimal value counts as that value: float noise is not a rounding. */
const TEMPO_TOLERANCE = 1e-9;

/**
 * What the tempo field of the transport bar does when the window switches view (section 14.6): it shows the tempo
 * with one decimal, and each switch moves the keyboard focus out of it, which makes it write the value it shows back
 * to the project. So every switch, in either direction, rounds a tempo that has more than one decimal; null when it
 * has at most one. A tempo that differs from its rounded value by no more than floating-point noise (120.30000000000001
 * shows as 120.3) is not rounded: the field writes back what it shows, which is the same number. The result describes
 * the rounding; `apply` carries it out, which a dry run does not.
 */
function tempoRounding({ world, hasCapability }: MethodContext) {
  const from = world.transport.bpm;
  const to = Math.round(from * 10) / 10;
  if (Math.abs(to - from) < TEMPO_TOLERANCE) return null;
  // The recipe needs transport.setTempo; an instance without it can restore nothing (section 15.2 rule 2).
  const revert = hasCapability('transport.v1') ? { method: 'transport.setTempo', params: { bpm: from } } : null;
  return {
    change: {
      entity: 'tempo',
      ref: TEMPO,
      label: 'Tempo',
      fields: { bpm: { before: from, after: to, unit: 'bpm' } },
    },
    effect: { fromBpm: from, toBpm: to, revert },
    warnings: revert === null ? [warning('IRREVERSIBLE', TEMPO)] : [],
    apply: () => {
      world.transport.bpm = to;
      world.markDirty();
    },
  };
}

// ui.setSelection ------------------------------------------------------------------------------------

const keyShown = (content: ContentRec) => content.key ?? (content.analysis === 'ready' ? DETECTED_KEY : null);

const setSelection: Handler = (context) => {
  const { world, params } = context;
  const placement = typeof params.placementId === 'string' ? world.placement(params.placementId) : undefined;
  const trackId = typeof params.trackId === 'number' ? params.trackId : undefined;
  if (trackId !== undefined && trackId >= world.visibleTrackCount) {
    throw refuse('NOT_FOUND', 'unknown_handle', 'trackId names no visible track');
  }
  checkBusy(context, false);
  const dryRun = params.dryRun === true;
  const targetTrack = placement?.trackId ?? trackId ?? null;
  const targetSelection = placement === undefined ? [] : [placement.id];
  const openEditor = placement !== undefined && params.openEditor === true;
  const content = placement?.content;

  const previous = {
    activeTrackId: world.activeTrackId,
    selectedPlacementIds: [...world.selectedPlacementIds],
  };
  const fields: Record<string, unknown> = {};
  if (previous.activeTrackId !== targetTrack) {
    fields.activeTrackId = { before: previous.activeTrackId, after: targetTrack, unit: null };
  }
  if (JSON.stringify(previous.selectedPlacementIds) !== JSON.stringify(targetSelection)) {
    fields.selectedPlacementIds = { before: previous.selectedPlacementIds, after: targetSelection, unit: null };
  }

  // What selecting makes OpenTune do beyond the selection (section 21 rule 3).
  const generating =
    content !== undefined && world.editingScheme === 'openDyne' && needsGeneratedNotes(content) ? content : undefined;
  const shownKey = content === undefined ? null : keyShown(content);
  const scaleChanged =
    shownKey !== null && (shownKey.root !== world.uiScale.root || shownKey.scale !== world.uiScale.scale);
  const switches = openEditor && world.workspace !== 'pianoRoll';
  // The piano roll holds the selected clip, also while the window shows the arrangement view; with a track selected
  // (no clip) it holds none, as ui.setWorkspace shows it.
  const loads = (content ?? null) !== world.pianoRollContent;

  const revert =
    previous.activeTrackId === null
      ? null
      : {
          method: 'ui.setSelection',
          params:
            previous.selectedPlacementIds[0] === undefined
              ? { trackId: previous.activeTrackId }
              : { placementId: previous.selectedPlacementIds[0] },
        };
  const sideEffects: Record<string, unknown> = {};
  const warnings: unknown[] = [];
  const effect = (count: number) => {
    sideEffects.notesGenerated = { contentId: content?.id ?? '', noteCount: count, revert: null };
    const notes = { contentId: content?.id ?? '' };
    warnings.push(warning('SELECTION_GENERATED_NOTES', notes), warning('IRREVERSIBLE', notes));
  };
  const scaleEffect = () => {
    if (shownKey === null) return;
    sideEffects.uiScaleChanged = {
      before: { ...world.uiScale },
      after: { root: shownKey.root, scale: shownKey.scale },
      revert: null,
    };
  };
  const workspaceEffect = () => {
    sideEffects.workspaceSwitched = { from: world.workspace, to: 'pianoRoll', revert: null };
  };
  const changes: unknown[] =
    Object.keys(fields).length === 0 ? [] : [{ entity: 'selection', ref: SELECTION, label: 'Selection', fields }];
  // The switch moves the keyboard focus out of the tempo field, which rounds the tempo (section 14.6).
  const rounding = switches ? tempoRounding(context) : null;
  if (rounding !== null) {
    changes.push(rounding.change);
    warnings.push(...rounding.warnings);
  }

  if (dryRun) {
    if (generating !== undefined) effect(predictedNoteCount(generating));
    if (scaleChanged) scaleEffect();
    if (switches) workspaceEffect();
    if (rounding !== null) sideEffects.tempoRounded = rounding.effect;
    return envelope(world, {
      applied: false,
      noOp: false,
      dryRun: true,
      changes,
      diff: EMPTY_DIFF,
      contents: [],
      undo: null,
      dirtyBefore: world.project.dirty,
      sideEffects,
      warnings,
    });
  }

  const dirtyBefore = world.project.dirty;
  const before = world.capture();
  world.selectedPlacementIds = targetSelection;
  world.activeTrackId = targetTrack;
  if (generating !== undefined) effect(generateNotes(world, generating));
  if (scaleChanged) scaleEffect();
  if (shownKey !== null) world.uiScale = { root: shownKey.root, scale: shownKey.scale };
  if (switches) workspaceEffect();
  if (rounding !== null) {
    sideEffects.tempoRounded = rounding.effect;
    rounding.apply();
  }
  // What the piano roll holds follows the selection, whichever view is shown; openEditor also switches the view.
  world.pianoRollContent = content ?? null;
  if (openEditor && content !== undefined) world.workspace = 'pianoRoll';
  const noOp = changes.length === 0 && Object.keys(sideEffects).length === 0 && !loads && !switches;
  return envelope(world, {
    applied: true,
    noOp,
    changes,
    diff: world.diff(before, world.capture()),
    contents: [],
    undo: noOp ? noOpUndo : { undoable: false, reason: 'not_persisted_state', revert },
    dirtyBefore,
    sideEffects,
    warnings,
  });
};

// ui.setWorkspace ------------------------------------------------------------------------------------

/**
 * Switches the window between the arrangement view and the piano roll, as the two view buttons of the
 * transport bar do. The workspace is view state: no content, clip or track changes and nothing is generated.
 * The one thing a switch does besides is the rounding of the tempo: each switch takes the keyboard focus out
 * of the tempo field, which rounds a tempo with more than one decimal and marks the project as changed
 * (tempoRounding). Without that rounding the project is not marked as changed. Switching to the piano roll shows
 * the clip that is selected at that moment, or nothing (`pianoRollContent` null) when no clip is selected, even
 * if the piano roll showed another clip before. Switching to the arrangement view leaves `pianoRollContent` as it
 * is, as the editor keeps the content it showed.
 */
const setWorkspace: Handler = (context) => {
  const { world, params } = context;
  checkBusy(context, false);
  const target = params.workspace === 'pianoRoll' ? 'pianoRoll' : 'arrangement';
  const from = world.workspace;
  const dirtyBefore = world.project.dirty;
  if (from === target) {
    return envelope(world, {
      applied: true,
      noOp: true,
      diff: EMPTY_DIFF,
      contents: [],
      undo: noOpUndo,
      dirtyBefore,
    });
  }
  world.workspace = target;
  if (target === 'pianoRoll') {
    const shown = world.selectedPlacementIds[0];
    world.pianoRollContent = shown === undefined ? null : world.placement(shown).content;
  }
  const rounding = tempoRounding(context);
  rounding?.apply();
  return envelope(world, {
    applied: true,
    noOp: false,
    changes: [
      {
        entity: 'ui',
        ref: { singleton: 'workspace' },
        label: 'Workspace',
        fields: { workspace: { before: from, after: target, unit: null } },
      },
      ...(rounding === null ? [] : [rounding.change]),
    ],
    diff: EMPTY_DIFF,
    contents: [],
    undo: {
      undoable: false,
      reason: 'not_persisted_state',
      revert: { method: 'ui.setWorkspace', params: { workspace: from } },
    },
    dirtyBefore,
    sideEffects: {
      workspaceSwitched: { from, to: target, revert: null },
      ...(rounding === null ? {} : { tempoRounded: rounding.effect }),
    },
    warnings: rounding === null ? [] : rounding.warnings,
  });
};

/** The window state shared by the other modules: the dialogs a `given` opens. */
export function openDialogs(world: World, dialogs: readonly Pick<DialogRec, 'kind' | 'trackId' | 'colour'>[]): void {
  world.dialogs = dialogs.map(({ kind, trackId, colour }) => ({ kind, trackId, colour }));
}

export const uiHandlers: Readonly<Record<string, Handler>> = {
  'ui.getState': getState,
  'ui.dismiss': dismiss,
  'ui.setSelection': setSelection,
  'ui.setWorkspace': setWorkspace,
};
