// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_get_project: the project in one read: tracks, clips (placements) with their timeline
// geometry and source, a summary of every content, the selection, the transport and, on request,
// the tops of the undo and redo histories. The OTCP revision tokens are folded into one opaque
// clip_revision per clip and one arrangement_revision, which the write tools take back as
// expected_revision. Track, clip and file names and paths are untrusted data: they appear only as
// values, never in the summary sentence.

import { z } from 'zod';

import { toolError } from '../errors/tool-error.js';
import type { Json } from '../otcp/client.js';
import { clipRevisionFrom, encodeArrangementRevision } from '../otcp/tokens.js';
import { defineTool, withInstance, type Outcome, type ToolContext } from './registry.js';

const READ_TIMEOUT_MS = 15_000;
const HISTORY_CAPABILITY = 'history.v1';

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const asArray = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);
const count = (n: number, noun: string) => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

export interface GetProjectArgs {
  readonly track_ids?: readonly number[] | undefined;
  readonly include_history?: boolean | undefined;
  readonly instance_id?: string | undefined;
}

/** A placement as the tool shows it: the geometry token is folded into clip_revision. */
function clipView(placement: Json, contentTokens: ReadonlyMap<unknown, unknown>): Json {
  const { geometryHash, nullReasons, ...rest } = placement;
  const revision = clipRevisionFrom(contentTokens.get(placement.contentId), geometryHash);
  const reasons: Json = { ...(isObject(nullReasons) ? nullReasons : {}) };
  if (revision === null) reasons.clip_revision = 'unavailable';
  return {
    ...rest,
    clip_revision: revision,
    ...(Object.keys(reasons).length > 0 ? { nullReasons: reasons } : {}),
  };
}

export async function getProject(ctx: ToolContext, args: GetProjectArgs): Promise<Outcome> {
  return withInstance(ctx, { instanceId: args.instance_id }, ['read.v1'], async (session) => {
    const project = await session.call('project.get', {}, READ_TIMEOUT_MS);
    const allTracks = asArray(project.tracks);
    const wanted = args.track_ids === undefined ? null : new Set(args.track_ids);
    if (wanted !== null) {
      const known = new Set(allTracks.map((t) => t.trackId));
      const unknown = [...wanted].filter((id) => !known.has(id));
      if (unknown.length > 0) {
        return {
          ok: false,
          error: toolError('INVALID_ARGUMENT', {
            detail:
              `track_ids names tracks that do not exist: ${unknown.join(', ')}; the project has ` +
              `${count(allTracks.length, 'track')}, numbered from 0. Track ids are positions and shift when a track is deleted`,
          }),
        };
      }
    }
    const tracks = wanted === null ? allTracks : allTracks.filter((t) => wanted.has(t.trackId as number));
    const allPlacements = asArray(project.placements);
    const placements = wanted === null ? allPlacements : allPlacements.filter((p) => wanted.has(p.trackId as number));
    const contentIds = new Set(placements.map((p) => p.contentId));
    const contents = asArray(project.contents).filter((c) => wanted === null || contentIds.has(c.contentId));

    const asOf = isObject(project.asOf) ? project.asOf : {};
    const tokens = new Map(asArray(asOf.contents).map((c) => [c.contentId, c] as const));
    const arrangement = typeof asOf.arrangementRevision === 'string' ? asOf.arrangementRevision : null;

    const nullReasons: Json = { ...(isObject(project.nullReasons) ? project.nullReasons : {}) };
    delete nullReasons.history;
    let history: unknown = null;
    if (args.include_history === true) {
      if (!session.hello.capabilities.includes(HISTORY_CAPABILITY)) {
        nullReasons.history = 'capability_missing';
      } else {
        history = (await session.call('edit.getHistory', {}, READ_TIMEOUT_MS)).history ?? null;
        if (history === null) nullReasons.history = 'unavailable';
      }
    }
    if (arrangement === null) nullReasons.arrangement_revision = 'unavailable';

    const dirty = isObject(project.project) && project.project.dirty === true;
    const summary =
      `The project has ${count(allTracks.length, 'track')} and ${count(allPlacements.length, 'clip')}` +
      (wanted === null
        ? ''
        : `; this result lists ${count(tracks.length, 'track')} and ${count(placements.length, 'clip')}`) +
      `, ${dirty ? 'with unsaved changes' : 'with no unsaved changes'}. Pass the clip_revision of a clip or the ` +
      'arrangement_revision as expected_revision to a write tool.';

    return {
      ok: true,
      body: {
        summary,
        project: project.project ?? null,
        tracks,
        visibleTrackCount: project.visibleTrackCount ?? null,
        activeTrackId: project.activeTrackId ?? null,
        placements: placements.map((p) => clipView(p, tokens)),
        contents,
        arrangement_revision: arrangement === null ? null : encodeArrangementRevision(arrangement),
        selection: project.selection ?? null,
        transport: project.transport ?? null,
        ...(args.include_history === true ? { history } : {}),
        derived: Array.isArray(project.derived) ? project.derived : [],
        ...(Object.keys(nullReasons).length > 0 ? { nullReasons } : {}),
      },
    };
  });
}

export const getProjectTool = defineTool({
  name: 'opentune_get_project',
  title: 'Get OpenTune project',
  description:
    'OpenTune (audio vocal pitch editor): reads the open project: path and unsaved-changes flag, tracks (volume, ' +
    'mute, solo), clips with timeline start, end and source file, a summary of each clip content (analysis state, ' +
    'key, note count, pitch shift), the selection and the transport. Every clip carries a clip_revision and the ' +
    'result an arrangement_revision: pass them as expected_revision to write tools. track_ids limits the result to ' +
    'those tracks; include_history adds the undo and redo tops. Read-only.',
  inputSchema: z.strictObject({
    track_ids: z
      .array(z.number().int().min(0))
      .max(64)
      .optional()
      .describe(
        'Only these tracks and their clips (0-based track ids; positions, they shift when a track is deleted).',
      ),
    include_history: z
      .boolean()
      .optional()
      .describe('Also return the tops of the undo and redo histories. Default false.'),
    instance_id: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional()
      .describe('OpenTune instance (32 hex digits, from opentune_get_status). Optional when one instance runs.'),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  capabilities: ['read.v1'],
  otcpMethods: ['project.get', 'edit.getHistory'],
  run: (args, ctx) => getProject(ctx, args),
});
