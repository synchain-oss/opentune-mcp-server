// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// What a write shows in the OpenTune window, derived from the changes, the side effects and the
// generic UI snapshot of the result. Two quirks of OpenTune are encoded here: the unsaved-changes
// asterisk in the window title does not always refresh, and the scale in the transport bar
// follows a key change only while the clip is selected (sideEffects.uiScaleChanged reports it).

import type { Json } from '../otcp/client.js';
import { entitiesOf, isObject } from './changes.js';
import { table, token } from './text.js';

export interface UiEffect {
  readonly surface: string;
  readonly effect: string;
  /** A content, placement or track handle, a track position, or `project`. */
  readonly target: string;
  /** Whether the user sees the effect now without doing anything. */
  readonly visibleNow: boolean;
  readonly howToSee?: string;
}

interface Where {
  readonly surface: string;
  readonly visible: (ui: Json | null, contentId: string | null, sideEffects: Json) => boolean;
  readonly howToSee: string;
}

const PIANO_ROLL: Where = {
  surface: 'piano roll',
  visible: (ui, contentId) =>
    ui !== null && ui.workspace === 'pianoRoll' && (contentId === null || ui.pianoRollContentId === contentId),
  howToSee: 'Open the clip in the piano roll.',
};
const ARRANGEMENT: Where = {
  surface: 'arrangement view',
  visible: (ui) => ui !== null && ui.workspace === 'arrangement',
  howToSee: 'Switch the window to the arrangement view.',
};
const ALWAYS = (surface: string): Where => ({ surface, visible: () => true, howToSee: '' });
const HIDDEN = (surface: string, howToSee: string): Where => ({ surface, visible: () => false, howToSee });

const BY_ENTITY = table<Where>({
  note: PIANO_ROLL,
  content: PIANO_ROLL,
  timeHandle: PIANO_ROLL,
  placement: ARRANGEMENT,
  track: ARRANGEMENT,
  key: {
    surface: 'transport bar key selector',
    visible: (_ui, _contentId, sideEffects) => Object.hasOwn(sideEffects, 'uiScaleChanged'),
    howToSee: 'Select the clip; the key selector in the transport bar then shows its key.',
  },
  pitchShift: HIDDEN('clip pitch shift', 'Select the clip and open its pitch-shift dialog.'),
  preference: HIDDEN('preferences', 'Open the preferences.'),
  audioDevice: HIDDEN('audio settings', 'Open the audio settings page.'),
  project: HIDDEN('window title', 'Look at the window title.'),
  tempo: ALWAYS('transport bar'),
  transport: ALWAYS('transport bar'),
  dialog: ALWAYS('dialog'),
});
const UNKNOWN = HIDDEN('unknown', 'Look at the OpenTune window.');

const SIDE_EFFECT_WHERE = table<Where & { effect: string }>({
  notesGenerated: { ...HIDDEN('piano roll', 'Open the clip in the piano roll.'), effect: 'notes generated' },
  reRenderQueued: {
    ...HIDDEN('background work', 'Playback and export use the new result once rendering is done.'),
    effect: 'rendering queued again',
  },
  uiScaleChanged: { ...ALWAYS('transport bar'), effect: 'scale changed' },
  workspaceSwitched: { ...ALWAYS('main window'), effect: 'workspace switched' },
  tracksRevealed: { ...ALWAYS('arrangement view'), effect: 'hidden tracks revealed' },
  dialogClosed: { ...ALWAYS('dialog'), effect: 'dialog closed' },
  dialogCommitted: { ...ALWAYS('dialog'), effect: 'dialog value committed' },
});

function targetOf(ref: unknown): { target: string; contentId: string | null } {
  const r = isObject(ref) ? ref : {};
  const contentId = token(r.contentId, 'contentId');
  const placementId = token(r.placementId, 'placementId');
  if (contentId !== null) return { target: contentId, contentId };
  if (placementId !== null) return { target: placementId, contentId: null };
  if (typeof r.trackId === 'number' && Number.isInteger(r.trackId) && r.trackId >= 0) {
    return { target: `track ${String(r.trackId)}`, contentId: null };
  }
  return { target: 'project', contentId: null };
}

export function uiEffects(envelope: Json): UiEffect[] {
  // A prediction changes nothing and a job has committed nothing yet: there is nothing to see.
  if (envelope.dryRun === true || isObject(envelope.job)) return [];
  const ui = isObject(envelope.ui) ? envelope.ui : null;
  const sideEffects = isObject(envelope.sideEffects) ? envelope.sideEffects : {};
  const noEditor = 'No editor window is open.';
  const out = new Map<string, UiEffect>();
  const add = (surface: string, effect: string, target: string, visibleNow: boolean, howToSee: string) => {
    const key = `${surface}|${effect}|${target}`;
    if (!out.has(key)) out.set(key, { surface, effect, target, visibleNow, ...(visibleNow ? {} : { howToSee }) });
  };

  for (const { kind, item } of entitiesOf(envelope)) {
    const entity = token(item.entity, 'camel');
    const where = (entity === null ? undefined : BY_ENTITY[entity]) ?? UNKNOWN;
    const { target, contentId } = targetOf(item.ref);
    const visible = where.visible(ui, contentId, sideEffects);
    add(where.surface, `${kind} ${entity ?? 'item'}`, target, visible, ui === null ? noEditor : where.howToSee);
  }

  const dirty = isObject(envelope.dirty) ? envelope.dirty : {};
  if (typeof dirty.before === 'boolean' && typeof dirty.after === 'boolean' && dirty.before !== dirty.after) {
    add(
      'window title',
      dirty.after ? 'unsaved-changes mark set' : 'unsaved-changes mark cleared',
      'project',
      false,
      'The asterisk in the window title may not refresh until the window is redrawn; dirty states the project state.',
    );
  }

  for (const name of Object.keys(sideEffects)) {
    const known = SIDE_EFFECT_WHERE[name];
    const where = known ?? UNKNOWN;
    const effect = known?.effect ?? `side effect ${token(name, 'camel') ?? 'with an unrecognized name'}`;
    add(where.surface, effect, 'project', where.visible(ui, null, sideEffects), where.howToSee);
  }
  return [...out.values()];
}
