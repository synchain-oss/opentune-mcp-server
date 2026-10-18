// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// How a revert recipe (spec/otcp/v1/PROTOCOL.md section 15.2) is carried out through this server.
// OpenTune names an OTCP request, which an agent cannot send: it can only call tools. A recipe
// whose method a tool performs becomes that tool call, its arguments taken from the recipe's
// params; a recipe that no tool performs yet is reported as such, and the user can restore the
// state by hand in the OpenTune window. A test keeps every call below valid for its tool's schema.

import type { Json } from '../otcp/client.js';
import { isObject } from './changes.js';
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
      /** The tool also takes expected_revision, the latest clip_revision of the clip. */
      readonly needsRevision: boolean;
      readonly consent: boolean;
    };

interface Mapped {
  readonly call: RestoreCall;
  readonly needsRevision: boolean;
}

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

function setClip(params: Json, args: (p: Json) => Json | null): Mapped | null {
  const clip = token(params.contentId, 'contentId');
  const rest = args(params);
  if (clip === null || rest === null) return null;
  return { call: { tool: 'opentune_set_clip', arguments: { clip, ...rest } }, needsRevision: true };
}

function history(tool: string, params: Json): Mapped | null {
  const undoId = token(params.expectedUndoId, 'undoId');
  return undoId === null ? null : { call: { tool, arguments: { undo_id: undoId } }, needsRevision: false };
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
  'edit.undo': (params) => history('opentune_undo', params),
  'edit.redo': (params) => history('opentune_redo', params),
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
  return { kind: 'tool', call: mapped.call, needsRevision: mapped.needsRevision, consent };
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
      const revision = plan.needsRevision
        ? ', adding expected_revision: the latest clip_revision you read for the clip'
        : ', as they are';
      const call = `call ${plan.call.tool} with the arguments in restore${revision}`;
      return plan.consent ? `Only after the user explicitly agrees to restore it: ${call}.` : `Restore: ${call}.`;
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
