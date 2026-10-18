// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The UI bridge of the mock (capability ui.bridge): ui.getState, ui.dismiss and ui.setSelection
// (spec/otcp/v1/PROTOCOL.md sections 13.2, 14.6, 15.4 rule 4 and 21 rule 3). The window state it
// reads and changes lives in the model: the dialogs, the first-run overlay, the selection, the
// workspace and the scale shown in the transport bar.

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
    sideEffects: showing ? { onboardingClosed: { revert: null } } : {},
    warnings: [warning('IRREVERSIBLE', { preference: 'onboardingShown' })],
  });
}

const dismiss: Handler = (context) => {
  // An open dialog does not refuse ui.dismiss, since closing it is the purpose (section 13.2).
  checkBusy(context, true);
  return context.params.target === 'onboarding' ? dismissOnboarding(context) : dismissDialogs(context);
};

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
  const referenceClip = placement?.reference ?? null;
  const queued =
    placement !== undefined && referenceClip !== null && world.prefs.experimentalFeatures
      ? [placement.content, referenceClip.content]
      : [];
  const shownKey = content === undefined ? null : keyShown(content);
  const scaleChanged =
    shownKey !== null && (shownKey.root !== world.uiScale.root || shownKey.scale !== world.uiScale.scale);
  const switches = openEditor && world.workspace !== 'pianoRoll';
  const reopens = openEditor && content !== undefined && world.pianoRollContent !== content;

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
  const subject = placement === undefined ? null : { placementId: placement.id };
  const effect = (count: number) => {
    sideEffects.notesGenerated = { contentId: content?.id ?? '', noteCount: count, revert: null };
    const notes = { contentId: content?.id ?? '' };
    warnings.push(warning('SELECTION_GENERATED_NOTES', notes), warning('IRREVERSIBLE', notes));
  };
  const queuedEffect = () => {
    sideEffects.referenceAnalysisQueued = { contentIds: queued.map((c) => c.id), revert: null };
    warnings.push(warning('REFERENCE_ANALYSIS_QUEUED', subject));
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
  const changes =
    Object.keys(fields).length === 0 ? [] : [{ entity: 'selection', ref: SELECTION, label: 'Selection', fields }];

  if (dryRun) {
    if (generating !== undefined) effect(predictedNoteCount(generating));
    if (queued.length > 0) queuedEffect();
    if (scaleChanged) scaleEffect();
    if (switches) workspaceEffect();
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
  if (queued.length > 0) {
    queuedEffect();
    for (const c of queued) world.queueAlignment(c);
  }
  if (scaleChanged) scaleEffect();
  if (shownKey !== null) world.uiScale = { root: shownKey.root, scale: shownKey.scale };
  if (switches) workspaceEffect();
  if (openEditor && content !== undefined) {
    world.workspace = 'pianoRoll';
    world.pianoRollContent = content;
  }
  const noOp = changes.length === 0 && Object.keys(sideEffects).length === 0 && !reopens && !switches;
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

/** The window state shared by the other modules: the dialogs a `given` opens. */
export function openDialogs(world: World, dialogs: readonly Pick<DialogRec, 'kind' | 'trackId' | 'colour'>[]): void {
  world.dialogs = dialogs.map(({ kind, trackId, colour }) => ({ kind, trackId, colour }));
}

export const uiHandlers: Readonly<Record<string, Handler>> = {
  'ui.getState': getState,
  'ui.dismiss': dismiss,
  'ui.setSelection': setSelection,
};
