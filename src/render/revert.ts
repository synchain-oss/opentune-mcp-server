// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// How a revert recipe (spec/otcp/v1/PROTOCOL.md section 15.2) is carried out through this server.
// OpenTune names an OTCP request, which an agent cannot send: it can only call tools. A recipe
// whose method a tool performs becomes that tool call, its arguments taken from the recipe's
// params; a recipe that no tool performs yet is reported as such, and the user can restore the
// state by hand in the OpenTune window. A test keeps every call below valid for its tool's schema.

import type { Json } from '../otcp/client.js';
import { encodeArrangementRevision } from '../otcp/tokens.js';
import { asList, isObject } from './changes.js';
import { table, token } from './text.js';

/** A tool call that restores the previous state. */
export interface RestoreCall {
  readonly tool: string;
  /** The arguments taken from the recipe; expected_revision, when the tool needs it, is not among them. */
  readonly arguments: Json;
}

export type RevertPlan =
  /** No request can restore the state (revert is null). */
  | { readonly kind: 'none' }
  /** A recipe that is not in the protocol form. */
  | { readonly kind: 'malformed' }
  /** A recipe that no tool of this server performs yet. */
  | { readonly kind: 'manual'; readonly consent: boolean }
  | {
      readonly kind: 'tool';
      readonly call: RestoreCall;
      /** The tool also takes expected_revision: the latest clip_revision of the clip, or the arrangement_revision. */
      readonly needsRevision: boolean;
      /** Which revision expected_revision is; meaningful when needsRevision is true. */
      readonly revisionKind: 'clip' | 'arrangement';
      readonly consent: boolean;
      /** The argument by which the tool takes the user's consent, added only once the user agreed. */
      readonly consentArgument?: string;
    };

interface Mapped {
  readonly call: RestoreCall;
  readonly needsRevision: boolean;
  /** The call needs the user's consent whether or not the recipe says so. */
  readonly consent?: true;
  readonly consentArgument?: string;
  readonly revisionKind?: 'clip' | 'arrangement';
}

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

function setClip(params: Json, args: (p: Json) => Json | null): Mapped | null {
  const clip = token(params.contentId, 'contentId');
  const rest = args(params);
  if (clip === null || rest === null) return null;
  return {
    call: { tool: 'opentune_set_clip', arguments: { clip, ...rest } },
    needsRevision: true,
    revisionKind: 'clip',
  };
}

function history(tool: string, params: Json): Mapped | null {
  const undoId = token(params.expectedUndoId, 'undoId');
  return undoId === null ? null : { call: { tool, arguments: { undo_id: undoId } }, needsRevision: false };
}

const isSec = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const clipOf = (value: unknown): string | null => token(value, 'placementId');

/** One op of an arrangement.edit recipe as opentune_edit_arrangement takes it, or null. */
function clipOp(op: unknown): Json | null {
  if (!isObject(op)) return null;
  const clip = clipOf(op.placementId);
  const withClip = (rest: Json | null): Json | null => (clip === null || rest === null ? null : { clip, ...rest });
  switch (op.op) {
    case 'move': {
      const track =
        op.toTrackId === undefined ? undefined : isInt(op.toTrackId, 0, Number.MAX_SAFE_INTEGER) ? op.toTrackId : null;
      const start =
        op.startTimelineSec === undefined ? undefined : isSec(op.startTimelineSec) ? op.startTimelineSec : null;
      if (track === null || start === null || (track === undefined && start === undefined)) return null;
      return withClip({
        op: 'move',
        ...(track === undefined ? {} : { to_track_id: track }),
        ...(start === undefined ? {} : { start_timeline_sec: start }),
      });
    }
    case 'trim':
      return (op.edge === 'start' || op.edge === 'end') && isSec(op.toTimelineSec)
        ? withClip({ op: 'trim', edge: op.edge, to_timeline_sec: op.toTimelineSec })
        : null;
    case 'setGain':
      // The tool takes the gain in dB only.
      return typeof op.gainDb === 'number' && Number.isFinite(op.gainDb)
        ? withClip({ op: 'gain', gain_db: op.gainDb })
        : null;
    case 'setFade': {
      const fades: Json = {};
      if (isSec(op.fadeInSec)) fades.fade_in_sec = op.fadeInSec;
      if (isSec(op.fadeOutSec)) fades.fade_out_sec = op.fadeOutSec;
      return Object.keys(fades).length === 0 ? null : withClip({ op: 'fade', ...fades });
    }
    case 'split':
      return isSec(op.atTimelineSec) ? withClip({ op: 'split', at_timeline_sec: op.atTimelineSec }) : null;
    case 'merge': {
      const leading = clipOf(op.leadingPlacementId);
      const trailing = clipOf(op.trailingPlacementId);
      return leading === null || trailing === null
        ? null
        : { op: 'merge', leading_clip: leading, trailing_clip: trailing };
    }
    case 'delete': {
      const clips = asList(op.placementIds).map(clipOf);
      return clips.length === 0 || clips.length > 64 || clips.includes(null) ? null : { op: 'delete', clips };
    }
    case 'setReference': {
      // The tool unbinds when reference_clip is left out.
      if (op.referencePlacementId === null) return withClip({ op: 'set_reference' });
      const reference = clipOf(op.referencePlacementId);
      return reference === null ? null : withClip({ op: 'set_reference', reference_clip: reference });
    }
    default:
      return null;
  }
}

/** The ops OpenTune cannot undo (PROTOCOL.md section 15.4 rule 1). */
const NOT_UNDOABLE = new Set(['split', 'merge', 'delete']);

/**
 * An arrangement.edit recipe as a call of opentune_edit_arrangement; its expected revision comes with it.
 * A restore that splits, merges or deletes cannot be undone in turn, so it waits for the user's consent
 * even when the recipe does not ask for it; a delete also takes that consent as confirm.
 */
function editArrangement(params: Json): Mapped | null {
  const revision = token(params.expectedArrangementRevision, 'revision');
  const ops = asList(params.ops).map(clipOp);
  if (revision === null || ops.length === 0 || ops.length > 64 || ops.includes(null)) return null;
  const kinds = ops.map((op) => String(op?.op));
  return {
    call: {
      tool: 'opentune_edit_arrangement',
      arguments: { expected_revision: encodeArrangementRevision(revision), ops },
    },
    needsRevision: false,
    ...(kinds.some((kind) => NOT_UNDOABLE.has(kind)) ? { consent: true } : {}),
    ...(kinds.includes('delete') ? { consentArgument: 'confirm' } : {}),
  };
}

/** A non-empty settings call, or null when the recipe holds no member the tool can take. */
function settingsCall(group: string, members: Json): Mapped | null {
  return Object.keys(members).length === 0
    ? null
    : { call: { tool: 'opentune_set_settings', arguments: { [group]: members } }, needsRevision: false };
}

/**
 * The prefs.set recipe of a preference change: the previous values, which the tool takes in
 * snake_case. A member whose value is not in the protocol's form (the instance is another program)
 * is left out rather than sent on; a recipe that names none becomes a manual restore.
 */
function preferenceRevert(params: Json): Mapped | null {
  const processing: Json = {};
  // A number, not only an integer: prefs.set takes any frequency from 400 to 500 Hz.
  if (typeof params.tuningHz === 'number' && params.tuningHz >= 400 && params.tuningHz <= 500)
    processing.tuning_hz = params.tuningHz;
  if (params.editingScheme === 'openTune' || params.editingScheme === 'openDyne')
    processing.editing_scheme = params.editingScheme;
  if (typeof params.hybridMode === 'boolean') processing.hybrid_mode = params.hybridMode;
  if (typeof params.experimentalFeatures === 'boolean') processing.experimental_features = params.experimentalFeatures;
  return settingsCall('processing', processing);
}

const textToken = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

/** The audio.set recipe of a device change, in the snake_case the tool takes. */
function audioRevert(params: Json): Mapped | null {
  const audio_device: Json = {};
  const deviceType = textToken(params.deviceType, 64);
  const outputDevice = textToken(params.outputDevice, 256);
  if (deviceType !== null) audio_device.device_type = deviceType;
  if (outputDevice !== null) audio_device.output_device = outputDevice;
  if (typeof params.sampleRateHz === 'number' && params.sampleRateHz > 0)
    audio_device.sample_rate_hz = params.sampleRateHz;
  if (isInt(params.bufferSizeFrame, 1, Number.MAX_SAFE_INTEGER))
    audio_device.buffer_size_frame = params.bufferSizeFrame;
  if (isInt(params.outputChannelPair, 0, Number.MAX_SAFE_INTEGER))
    audio_device.output_channel_pair = params.outputChannelPair;
  return settingsCall('audio_device', audio_device);
}

const TRACK_ID_MAX = 63;
const TRACK_OPS_MAX = 32;
const COLOUR_RE = /^#[0-9A-Fa-f]{6}$/;
const isNum = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/**
 * The opentune_set_tracks ops that set the values a track.set recipe names. A member that cannot be
 * mapped makes the whole recipe manual: a restore that silently leaves a value out is wrong.
 */
function trackOps(params: Json): Mapped | null {
  const ops: Json[] = [];
  for (const item of Array.isArray(params.tracks) ? (params.tracks as unknown[]) : []) {
    if (!isObject(item) || !isInt(item.trackId, 0, TRACK_ID_MAX)) return null;
    const track_id = item.trackId;
    const known = new Set(['trackId', 'muted', 'solo', 'volumeDb', 'volumeLinear', 'colour']);
    if (Object.keys(item).some((key) => !known.has(key))) return null;
    if (item.muted !== undefined) {
      if (typeof item.muted !== 'boolean') return null;
      ops.push({ op: 'mute', track_id, on: item.muted });
    }
    if (item.solo !== undefined) {
      if (typeof item.solo !== 'boolean') return null;
      ops.push({ op: 'solo', track_id, on: item.solo });
    }
    if (item.volumeDb !== undefined) {
      if (isNum(item.volumeDb, -120, 24)) {
        ops.push({ op: 'volume', track_id, db: item.volumeDb });
      } else {
        // Out of the dB range of the tool: write it back as the linear factor when that is in range.
        const linear = typeof item.volumeDb === 'number' ? 10 ** (item.volumeDb / 20) : Number.NaN;
        if (!isNum(linear, 0, 4)) return null;
        ops.push({ op: 'volume', track_id, linear });
      }
    } else if (item.volumeLinear !== undefined) {
      if (!isNum(item.volumeLinear, 0, 4)) return null;
      ops.push({ op: 'volume', track_id, linear: item.volumeLinear });
    }
    if (item.colour !== undefined) {
      if (typeof item.colour !== 'string' || !COLOUR_RE.test(item.colour)) return null;
      ops.push({ op: 'colour', track_id, colour: item.colour });
    }
  }
  if (ops.length === 0 || ops.length > TRACK_OPS_MAX) return null;
  return { call: { tool: 'opentune_set_tracks', arguments: { ops } }, needsRevision: false };
}

/** The opentune_transport call that sets the tempo and time signature a transport.setTempo recipe names. */
function tempoCall(params: Json): Mapped | null {
  const signature = isObject(params.timeSignature) ? params.timeSignature : {};
  if (!isNum(params.bpm, 1, 999) || !isInt(signature.numerator, 1, 32)) return null;
  if (![1, 2, 4, 8, 16, 32].includes(signature.denominator as number)) return null;
  const time_signature = { numerator: signature.numerator, denominator: signature.denominator };
  return {
    call: { tool: 'opentune_transport', arguments: { bpm: params.bpm, time_signature } },
    needsRevision: false,
  };
}

/** The tool call for each OTCP method a tool of this server performs, or null for params it cannot take. */
const TOOL_FOR = table<(params: Json) => Mapped | null>({
  'content.setKey': (params) =>
    setClip(params, (p) => {
      const key = isObject(p.key) ? p.key : {};
      const scale = token(key.scale, 'camel');
      return isInt(key.root, 0, 11) && scale !== null ? { key: { root: key.root, scale } } : null;
    }),
  'content.setPitchShift': (params) =>
    setClip(params, (p) => {
      const shift = isObject(p.pitchShift) ? p.pitchShift : {};
      return isInt(shift.semitones, -24, 24) && isInt(shift.cents, -99, 99)
        ? { pitch_shift: { semitones: shift.semitones, cents: shift.cents } }
        : null;
    }),
  'project.open': (params) =>
    typeof params.path === 'string' && params.path.length >= 1 && params.path.length <= 4096
      ? { call: { tool: 'opentune_open_project', arguments: { path: params.path } }, needsRevision: false }
      : null,
  'track.set': trackOps,
  'track.delete': (params) => {
    const track_id = params.trackId;
    return isInt(track_id, 0, TRACK_ID_MAX)
      ? {
          call: { tool: 'opentune_delete_track', arguments: { track_id } },
          needsRevision: true,
          revisionKind: 'arrangement',
        }
      : null;
  },
  'transport.setTempo': tempoCall,
  'transport.setLoop': (params) =>
    typeof params.enabled === 'boolean'
      ? { call: { tool: 'opentune_transport', arguments: { loop: params.enabled } }, needsRevision: false }
      : null,
  'ui.setSelection': (params) => {
    const clip = token(params.placementId, 'placementId');
    return clip === null
      ? null
      : { call: { tool: 'opentune_manage_ui', arguments: { op: 'focus_clip', clip } }, needsRevision: false };
  },
  'edit.undo': (params) => history('opentune_undo', params),
  'edit.redo': (params) => history('opentune_redo', params),
  'arrangement.edit': editArrangement,
  'prefs.set': preferenceRevert,
  'audio.set': audioRevert,
});

/** The OTCP methods a revert recipe can name and still be carried out by a tool call. */
export const RESTORABLE_METHODS: readonly string[] = Object.keys(TOOL_FOR);

/** How the recipe `revert` can be carried out. */
export function revertPlan(revert: unknown): RevertPlan {
  if (!isObject(revert)) return { kind: 'none' };
  const method = token(revert.method, 'method');
  if (method === null) return { kind: 'malformed' };
  const consent = revert.requiresConsent === true;
  const mapped = TOOL_FOR[method]?.(isObject(revert.params) ? revert.params : {}) ?? null;
  if (mapped === null) return { kind: 'manual', consent };
  return {
    kind: 'tool',
    call: mapped.call,
    needsRevision: mapped.needsRevision,
    consent: consent || mapped.consent === true,
    ...(mapped.consentArgument === undefined ? {} : { consentArgument: mapped.consentArgument }),
    revisionKind: mapped.revisionKind ?? 'clip',
  };
}

/** The sentence of a revert line. */
export function revertText(plan: RevertPlan): string {
  switch (plan.kind) {
    case 'none':
      return 'No request of the protocol can restore the previous state.';
    case 'malformed':
      return 'A revert recipe is given but not in the expected form; see revert.';
    case 'manual':
      return (
        'No tool of this server can carry out this restore yet; the user can restore it by hand in the OpenTune ' +
        `window.${plan.consent ? " It needs the user's explicit agreement." : ''}`
      );
    case 'tool': {
      const latest =
        plan.revisionKind === 'arrangement'
          ? 'arrangement_revision of opentune_get_project'
          : 'clip_revision you read for the clip';
      const revision = plan.needsRevision ? `, adding expected_revision: the latest ${latest}` : ', as they are';
      const call = `call ${plan.call.tool} with the arguments in restore${revision}`;
      if (!plan.consent) return `Restore: ${call}.`;
      const add = plan.consentArgument === undefined ? '' : `, adding ${plan.consentArgument}: true`;
      return `Only after the user explicitly agrees to restore it: ${call}${add}.`;
    }
  }
}

/** The words for the first sentence of the summary. */
export function revertFlag(plan: RevertPlan): string {
  switch (plan.kind) {
    case 'none':
    case 'malformed':
      return 'cannot be restored by any request';
    case 'manual':
      return 'no tool of this server can restore it yet, but the user can by hand in the OpenTune window';
    case 'tool':
      return plan.consent
        ? `can be restored with ${plan.call.tool} only after the user explicitly agrees`
        : `can be restored with ${plan.call.tool}, see the revert line`;
  }
}

/** The tool call of a revert line, or null when no tool performs the recipe. */
export const restoreCall = (plan: RevertPlan): RestoreCall | null => (plan.kind === 'tool' ? plan.call : null);
