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
      /** The tool also takes expected_revision, the latest clip_revision of the clip. */
      readonly needsRevision: boolean;
      readonly consent: boolean;
      /** The argument by which the tool takes the user's consent, added only once the user agreed. */
      readonly consentArgument?: string;
    };

interface Mapped {
  readonly call: RestoreCall;
  readonly needsRevision: boolean;
  readonly consentArgument?: string;
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

/** An arrangement.edit recipe as a call of opentune_edit_arrangement; its expected revision comes with it. */
function editArrangement(params: Json): Mapped | null {
  const revision = token(params.expectedArrangementRevision, 'revision');
  const ops = asList(params.ops).map(clipOp);
  if (revision === null || ops.length === 0 || ops.length > 64 || ops.includes(null)) return null;
  return {
    call: {
      tool: 'opentune_edit_arrangement',
      arguments: { expected_revision: encodeArrangementRevision(revision), ops },
    },
    needsRevision: false,
    ...(ops.some((op) => op?.op === 'delete') ? { consentArgument: 'confirm' } : {}),
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
  'edit.undo': (params) => history('opentune_undo', params),
  'edit.redo': (params) => history('opentune_redo', params),
  'arrangement.edit': editArrangement,
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
    consent,
    ...(mapped.consentArgument === undefined ? {} : { consentArgument: mapped.consentArgument }),
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
      const revision = plan.needsRevision
        ? ', adding expected_revision: the latest clip_revision you read for the clip'
        : ', as they are';
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
