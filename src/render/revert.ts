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
      /** The tool also takes expected_revision: the latest clip_revision of the clip, or the arrangement_revision. */
      readonly needsRevision: boolean;
      /** Which revision expected_revision is; meaningful when needsRevision is true. */
      readonly revisionKind: 'clip' | 'arrangement';
      readonly consent: boolean;
    };

interface Mapped {
  readonly call: RestoreCall;
  readonly needsRevision: boolean;
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

const TRACK_ID_MAX = 63;
const TRACK_OPS_MAX = 32;
const COLOUR_RE = /^#[0-9A-Fa-f]{6}$/;
const isNum = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/** The opentune_set_tracks ops that set the values a track.set recipe names. */
function trackOps(params: Json): Mapped | null {
  const ops: Json[] = [];
  for (const item of Array.isArray(params.tracks) ? (params.tracks as unknown[]) : []) {
    if (!isObject(item) || !isInt(item.trackId, 0, TRACK_ID_MAX)) return null;
    const track_id = item.trackId;
    if (typeof item.muted === 'boolean') ops.push({ op: 'mute', track_id, on: item.muted });
    if (typeof item.solo === 'boolean') ops.push({ op: 'solo', track_id, on: item.solo });
    if (isNum(item.volumeDb, -120, 24)) ops.push({ op: 'volume', track_id, db: item.volumeDb });
    else if (isNum(item.volumeLinear, 0, 4)) ops.push({ op: 'volume', track_id, linear: item.volumeLinear });
    if (typeof item.colour === 'string' && COLOUR_RE.test(item.colour)) {
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
    revisionKind: mapped.revisionKind ?? 'clip',
    consent,
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
