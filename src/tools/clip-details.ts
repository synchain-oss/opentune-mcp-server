// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_get_clip_details: the state of one clip besides its notes: key, pitch shift, the pitch
// analysis and its last failure, whether the audible render is current, the time grid and the AUTO
// modes. The result carries the clip_revision, which the write tools take as expected_revision. The
// AUTO fields are OTCP's.

import { z } from 'zod';

import type { Json } from '../otcp/client.js';
import { clipRevisionFrom } from '../otcp/tokens.js';
import { trustedToken } from '../sanitize/untrusted.js';
import { geometryOf } from './notes.js';
import { defineTool, withInstance, type Outcome, type ToolContext } from './registry.js';

const READ_TIMEOUT_MS = 15_000;
const CLIP_RE = /^[pc]:[0-9a-f]{8}:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Most time handles one result lists; handleCount says how many there are. */
export const MAX_HANDLES = 200;

export const CLIP_SECTIONS = ['key', 'pitch_shift', 'analysis', 'render', 'time_grid', 'auto_modes'] as const;
type Section = (typeof CLIP_SECTIONS)[number];

/** The member of content.getDetails that carries each section. */
const MEMBER: Readonly<Record<Section, string>> = {
  key: 'key',
  pitch_shift: 'pitchShift',
  analysis: 'analysis',
  render: 'render',
  time_grid: 'timeGrid',
  auto_modes: 'autoModes',
};

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface GetClipDetailsArgs {
  readonly clip: string;
  readonly sections?: readonly Section[] | undefined;
  readonly instance_id?: string | undefined;
}

export async function getClipDetails(ctx: ToolContext, args: GetClipDetailsArgs): Promise<Outcome> {
  const wanted = new Set<Section>(args.sections ?? CLIP_SECTIONS);
  return withInstance(ctx, { instanceId: args.instance_id }, ['read.v1'], async (session) => {
    // The geometry is read before the details, as get_notes does: a change in between only makes
    // the token older, so a write using it gets REVISION_CONFLICT (the safe direction).
    const geometry = args.clip.startsWith('p:') ? await geometryOf(session, args.clip) : null;
    const details = await session.call(
      'content.getDetails',
      args.clip.startsWith('p:') ? { placementId: args.clip } : { contentId: args.clip },
      READ_TIMEOUT_MS,
    );
    const asOf = isObject(details.asOf) ? details.asOf : {};
    const sameArrangement =
      geometry !== null && geometry.arrangement !== null && geometry.arrangement === asOf.arrangementRevision;
    const content = (Array.isArray(asOf.contents) ? asOf.contents : []).find(
      (c): c is Json => isObject(c) && c.contentId === details.contentId,
    );
    const revision = clipRevisionFrom(content, sameArrangement ? geometry.hash : null);
    // A reason for a member that was not asked for is noise.
    const asked = new Set(['clip_revision', ...[...wanted].map((section) => MEMBER[section])]);
    const reasons: Json = Object.fromEntries(
      Object.entries(isObject(details.nullReasons) ? details.nullReasons : {}).filter(([member]) => asked.has(member)),
    );
    if (revision === null) reasons.clip_revision = 'unavailable';
    else if (geometry !== null && !sameArrangement) {
      reasons.clip_revision_geometry = geometry.hash === null ? 'unavailable' : 'arrangement_changed_during_read';
    }

    const members: Json = {};
    for (const section of CLIP_SECTIONS) {
      if (!wanted.has(section)) continue;
      const value = details[MEMBER[section]];
      if (section === 'time_grid' && isObject(value) && Array.isArray(value.handles)) {
        const handles = value.handles;
        members[MEMBER[section]] = {
          ...value,
          handleCount: handles.length,
          handles: handles.slice(0, MAX_HANDLES),
          ...(handles.length > MAX_HANDLES ? { handlesTruncated: true } : {}),
        };
      } else {
        members[MEMBER[section]] = value ?? null;
        if (value === undefined) reasons[MEMBER[section]] = 'unavailable';
      }
    }

    const parts: string[] = [];
    const render = isObject(details.render) ? details.render : null;
    if (wanted.has('render') && render !== null && typeof render.current === 'boolean') {
      parts.push(
        render.current
          ? 'the audible render is up to date'
          : 'the audible render is NOT up to date (an export waits for it)',
      );
    }
    const analysis = isObject(details.analysis) ? details.analysis : null;
    const f0State = trustedToken(analysis?.f0State, NAME_RE);
    if (wanted.has('analysis') && f0State !== null) {
      const failure = trustedToken(analysis?.failure, NAME_RE);
      parts.push(`the pitch analysis state is ${f0State}${failure === null ? '' : ` (failed: ${failure})`}`);
    }
    const autoModes = isObject(details.autoModes) ? details.autoModes : null;
    const mode = trustedToken(autoModes?.uiButtonRuns, NAME_RE);
    if (wanted.has('auto_modes') && mode !== null) parts.push(`the AUTO button would run ${mode}`);
    const summary =
      'Read the details of the clip' +
      (parts.length > 0 ? `: ${parts.join('; ')}` : '') +
      '. Times are in seconds; clip_revision can be passed as expected_revision to a write tool.';

    return {
      ok: true,
      body: {
        summary,
        contentId: details.contentId ?? null,
        viaPlacementId: details.viaPlacementId ?? null,
        placementIds: Array.isArray(details.placementIds) ? details.placementIds : [],
        durationSec: details.durationSec ?? null,
        clip_revision: revision,
        ...members,
        derived: Array.isArray(details.derived) ? details.derived : [],
        ...(Object.keys(reasons).length > 0 ? { nullReasons: reasons } : {}),
      },
    };
  });
}

export const getClipDetailsTool = defineTool({
  name: 'opentune_get_clip_details',
  title: 'Get OpenTune clip details',
  description:
    'OpenTune (audio vocal pitch editor): reads one clip besides its notes: duration, key, pitch shift (semitones ' +
    'and cents), pitch analysis state and last failure, whether the audible render is up to date, the time grid ' +
    'handles (seconds, content and output clock), and the AUTO modes (which one the AUTO button runs, which ' +
    'can be run). Returns clip_revision for expected_revision. sections limits the result; ' +
    'default all. Read-only.',
  inputSchema: z.strictObject({
    clip: z
      .string()
      .regex(CLIP_RE)
      .describe(
        'Clip placement id (p:...) from opentune_get_project, or a content id (c:...). Render and the AUTO mode ' +
          'are taken through the placement; a content id uses its first placement.',
      ),
    sections: z
      .array(z.enum(CLIP_SECTIONS))
      .min(1)
      .max(CLIP_SECTIONS.length)
      .optional()
      .describe('Parts to return. Default: all of them.'),
    instance_id: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional()
      .describe('OpenTune instance (32 hex digits, from opentune_get_status). Optional when one instance runs.'),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  capabilities: ['read.v1'],
  otcpMethods: ['content.getDetails', 'project.get'],
  run: (args, ctx) => getClipDetails(ctx, args),
});
