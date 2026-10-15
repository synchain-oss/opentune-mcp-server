// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// What the tools that edit one clip share: the input fields (clip, expected_revision, key,
// instance_id), reading the clip_revision back into the tokens an operation depends on, and
// turning a clip id into the content id OTCP addresses. A clip is a placement id (p:...) or a
// content id (c:...); OTCP edits address contents.

import { z } from 'zod';

import { toolError } from '../errors/tool-error.js';
import type { Json, OtcpSession } from '../otcp/client.js';
import { decodeClipRevision, type ClipTokens } from '../otcp/tokens.js';
import type { Outcome } from './registry.js';

/** Timeout of one write request, in ms. */
export const WRITE_TIMEOUT_MS = 30_000;
export const READ_TIMEOUT_MS = 15_000;

export const CLIP_RE = /^[pc]:[0-9a-f]{8}:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/;

export const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const CLIP_FIELD = z
  .string()
  .regex(CLIP_RE)
  .describe('Clip placement id (p:...) from opentune_get_project, or a content id (c:...).');

export const REVISION_FIELD = z
  .string()
  .min(1)
  .max(2048)
  .describe('The clip_revision of the clip from opentune_get_project or opentune_get_notes, passed back unchanged.');

export const INSTANCE_FIELD = z
  .string()
  .regex(/^[0-9a-f]{32}$/)
  .optional()
  .describe('OpenTune instance (32 hex digits, from opentune_get_status). Optional when one instance runs.');

const SCALES = [
  'major',
  'minor',
  'chromatic',
  'harmonicMinor',
  'dorian',
  'mixolydian',
  'pentatonicMajor',
  'pentatonicMinor',
] as const;

/** A key as the tools take it: root 0 = C ... 11 = B, and a scale. */
export const KEY_FIELD = z.strictObject({
  root: z.number().int().min(0).max(11).describe('Tonic pitch class: 0 = C, 1 = C sharp ... 11 = B.'),
  scale: z.enum(SCALES),
});

export interface KeyArg {
  readonly root: number;
  readonly scale: string;
}

export const invalid = (detail: string, reason?: string): Outcome => ({
  ok: false,
  error: toolError('INVALID_ARGUMENT', { detail, ...(reason === undefined ? {} : { reason }) }),
});

/** The tokens inside an expected_revision, or an error outcome naming how to get a good one. */
export function revisionTokens(expected: string): ClipTokens | Outcome {
  const tokens = decodeClipRevision(expected);
  if (tokens !== null) return tokens;
  return {
    ok: false,
    error: toolError('INVALID_ARGUMENT', {
      reason: 'revision_invalid',
      detail: 'expected_revision is not a clip_revision issued by this server',
      nextStep: {
        actor: 'agent',
        tool: 'opentune_get_project',
        message:
          'Pass the clip_revision of the clip, exactly as opentune_get_project or opentune_get_notes returned it ' +
          '(not the arrangement_revision), then call again.',
      },
    }),
  };
}

export const isOutcome = (value: unknown): value is Outcome =>
  typeof value === 'object' && value !== null && 'ok' in value;

/** The content a clip id addresses, with the placement when the clip is one. */
export async function resolveContent(
  session: OtcpSession,
  clip: string,
): Promise<{ contentId: string; placementId: string | null } | Outcome> {
  if (clip.startsWith('c:')) return { contentId: clip, placementId: null };
  const project = await session.call('project.get', {}, READ_TIMEOUT_MS);
  const found = (Array.isArray(project.placements) ? project.placements : []).find(
    (p): p is Json => isObject(p) && p.placementId === clip,
  );
  if (found === undefined || typeof found.contentId !== 'string') {
    return {
      ok: false,
      error: toolError('NOT_FOUND', {
        reason: 'unknown_handle',
        detail: 'the project has no clip with this placement id; clip ids change when clips are deleted or recreated',
      }),
    };
  }
  return { contentId: found.contentId, placementId: clip };
}
