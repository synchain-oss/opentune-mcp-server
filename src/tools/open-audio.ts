// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_open_audio: imports audio files as new clips (import.start) and waits for the job for a
// while. The paths are normalized and checked here first (src/paths); the idempotency key is
// derived from the files and the target so that repeating a call does not import twice. File
// names and paths come back only as data inside the result, never in the summary.

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { toolError } from '../errors/tool-error.js';
import type { Json } from '../otcp/client.js';
import { resolvePath } from '../paths/index.js';
import { isObject } from '../render/changes.js';
import { isWriteEnvelope, writeBody, writeOutcome } from '../render/index.js';
import { token } from '../render/text.js';
import {
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  followText,
  isTerminal,
  jobFailure,
  jobRef,
  jobState,
  startAndWait,
} from './follow-job.js';
import { jobSentence } from './jobs.js';
import { WRITE_RESULT_OUTPUT, defineTool, withInstance, type Outcome, type ToolContext } from './registry.js';

const TOOL = 'opentune_open_audio';
const MAX_ITEMS = 64;
/** Where the idempotency key of import.start starts; printable ASCII, at most 128 characters. */
const KEY_PREFIX = 'otmcp-import-';

export type Layout = 'single' | 'sequential' | 'separate_tracks';
const OTCP_LAYOUT: Readonly<Record<Layout, string>> = {
  single: 'single',
  sequential: 'sequential',
  separate_tracks: 'separateTracks',
};

export interface OpenAudioArgs {
  readonly path?: string | undefined;
  readonly items?: readonly string[] | undefined;
  readonly layout?: Layout | undefined;
  readonly track?: number | undefined;
  readonly start?: number | undefined;
  readonly new_track?: boolean | undefined;
  readonly generate_notes?: boolean | undefined;
  readonly focus?: boolean | undefined;
  readonly allow_duplicate?: boolean | undefined;
  readonly wait_seconds?: number | undefined;
  readonly instance_id?: string | undefined;
}

const invalid = (detail: string, reason?: string): Outcome => ({
  ok: false,
  error: toolError('INVALID_ARGUMENT', { detail, ...(reason === undefined ? {} : { reason }) }),
});

/** The key of an import: the same files placed the same way give the same key. */
export function importKey(params: Json): string {
  const digest = createHash('sha256').update(JSON.stringify(params)).digest('hex');
  return `${KEY_PREFIX}${digest.slice(0, 32)}`;
}

interface ItemFacts {
  readonly requested: number;
  readonly imported: number;
  readonly failed: number;
  /** Error kinds of the failed items, each checked against its protocol form. */
  readonly kinds: readonly string[];
}

/** Counts and error kinds of the items, or null when the result does not carry them in the expected form. */
function itemFacts(result: Json): ItemFacts | null {
  const counts = isObject(result.counts) ? result.counts : {};
  const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
  const requested = int(counts.requested);
  const imported = int(counts.imported);
  const failed = int(counts.failed);
  if (requested === null || imported === null || failed === null) return null;
  const kinds = new Set<string>();
  for (const item of Array.isArray(result.items) ? result.items : []) {
    const data = isObject(item) && isObject(item.error) && isObject(item.error.data) ? item.error.data : null;
    const kind = data === null ? null : token(data.kind, 'code');
    if (kind !== null) kinds.add(kind);
  }
  return { requested, imported, failed, kinds: [...kinds] };
}

/** True when OpenTune generated notes for the focused clip that the request did not ask for (openDyne scheme). */
function notesByFocus(result: Json): boolean {
  return (Array.isArray(result.items) ? result.items : []).some(
    (item) => isObject(item) && token(item.notesGeneratedBy, 'camel') === 'focus',
  );
}

function finished(result: unknown): Outcome {
  if (!isWriteEnvelope(result)) return writeOutcome(result, { tool: TOOL });
  const body = writeBody(result, { tool: TOOL });
  const facts = itemFacts(result);
  let summary = body.summary;
  if (facts === null) {
    summary += ' See items for what happened to each file.';
  } else {
    const why = facts.kinds.length === 0 ? '' : ` (${facts.kinds.join(', ')})`;
    if (facts.imported === 0) {
      summary = `${TOOL}: no file was imported, nothing in the project changed; ${String(facts.failed)} failed${why}. See items[].error for each file.`;
    } else if (facts.failed > 0) {
      summary += ` ${String(facts.imported)} of ${String(facts.requested)} files were imported; ${String(facts.failed)} failed${why}: see items[].error for each.`;
    }
  }
  if (notesByFocus(result)) {
    summary +=
      ' OpenTune generated notes for the focused clip although none were requested: this is how the openDyne editing scheme works, and there is no undo entry for it.';
  }
  return { ok: true, body: { ...body, summary } };
}

export async function openAudio(ctx: ToolContext, args: OpenAudioArgs): Promise<Outcome> {
  if ((args.path === undefined) === (args.items === undefined)) {
    return invalid('give either path (one file) or items (several files), not both and not neither');
  }
  const raw = args.items ?? [args.path ?? ''];
  if (args.new_track === true && args.track !== undefined) {
    return invalid('track and new_track exclude each other: name a track or ask for a new one');
  }
  const layout: Layout = args.layout ?? (raw.length === 1 ? 'single' : 'sequential');
  if (layout === 'single' && raw.length > 1) {
    return invalid('layout single imports one file; use sequential or separate_tracks for several', 'layout_mismatch');
  }
  const paths: string[] = [];
  for (const [index, item] of raw.entries()) {
    const resolved = resolvePath(item, ctx, args.items === undefined ? 'path' : `items[${String(index)}]`);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    paths.push(resolved.path);
  }

  // The parameters in the form OTCP takes them. The key hashes exactly what the import depends on.
  const params: Json = {
    items: paths.map((path) => ({ path })),
    layout: OTCP_LAYOUT[layout],
    ...(args.track === undefined ? {} : { trackId: args.track }),
    ...(args.new_track === true ? { newTrack: true } : {}),
    ...(args.start === undefined ? {} : { startTimelineSec: args.start }),
    ...(args.generate_notes === true ? { generateNotes: true } : {}),
    ...(args.focus === undefined ? {} : { focus: args.focus }),
  };
  const sent: Json = args.allow_duplicate === true ? params : { ...params, idempotencyKey: importKey(params) };

  return withInstance(ctx, { instanceId: args.instance_id }, ['import.v1', 'jobs.v1'], async (session) => {
    const { started, job, waitFailed } = await startAndWait(
      ctx,
      session,
      'import.start',
      sent,
      args.wait_seconds ?? DEFAULT_WAIT_SECONDS,
    );
    const state = jobState(job);
    if (job === null || !isTerminal(job)) {
      const outcome = writeOutcome(started, { tool: TOOL });
      if (!outcome.ok) return outcome;
      const note = job === null ? '' : followText(waitFailed);
      return { ok: true, body: { ...outcome.body, summary: outcome.body.summary + note } };
    }
    if (state === 'failed') return jobFailure(job);
    if (state === 'cancelled') {
      const result = job.result;
      const base = isWriteEnvelope(result) ? writeBody(result, { tool: TOOL }) : null;
      return {
        ok: true,
        body: {
          ...(base ?? {}),
          summary: `${TOOL}: ${jobSentence(job)}`,
          job: jobRef(job),
          ...(base === null ? { result: result ?? null } : {}),
        },
      };
    }
    const outcome = finished(job.result);
    return outcome.ok ? { ok: true, body: { ...outcome.body, job: jobRef(job) } } : outcome;
  });
}

export const openAudioTool = defineTool({
  name: TOOL,
  title: 'Open audio in OpenTune',
  description:
    'OpenTune (audio vocal pitch editor): imports audio files as new clips, as the window does, ' +
    'and waits up to wait_seconds (default 25, max 30); if the import job has not ended, the result names it for ' +
    'opentune_get_job. Give path or items (absolute paths; quotes, file://, ~ and /mnt/<drive>/ are accepted). ' +
    'layout: single, sequential (end to end) or separate_tracks. Not undoable; the result says how to revert. In the ' +
    'openDyne scheme the focused clip also gets notes (no undo entry). Repeating a call with the same files and ' +
    'target imports nothing again unless allow_duplicate is true.',
  inputSchema: z.strictObject({
    path: z.string().min(1).max(4096).optional().describe('One file to import. Give path or items.'),
    items: z
      .array(z.string().min(1).max(4096))
      .min(1)
      .max(MAX_ITEMS)
      .optional()
      .describe('Several files, in the order to place them. Give path or items.'),
    layout: z
      .enum(['single', 'sequential', 'separate_tracks'])
      .optional()
      .describe(
        'single (one file), sequential (end to end on one track) or separate_tracks (one track each, from the target track). Default: single for one file, sequential for several.',
      ),
    track: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Target track id (0-based position). Default: the active track.'),
    start: z
      .number()
      .min(0)
      .optional()
      .describe('Timeline start of the first clip in seconds. Default: after the last clip on the track.'),
    new_track: z
      .boolean()
      .optional()
      .describe('Use the first track without clips as the target. Fails when every track has clips. Not with track.'),
    generate_notes: z.boolean().optional().describe('Generate notes once analysis ends. Default false.'),
    focus: z.boolean().optional().describe('Select the last imported clip, as the window does. Default true.'),
    allow_duplicate: z
      .boolean()
      .optional()
      .describe('Import again even if the same files were just imported to the same target. Default false.'),
    wait_seconds: z
      .number()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .optional()
      .describe('Seconds to wait for the import to end, 0 to 30. Default 25.'),
    instance_id: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional()
      .describe('OpenTune instance (32 hex digits, from opentune_get_status). Optional when one instance runs.'),
  }),
  outputSchema: WRITE_RESULT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  capabilities: ['import.v1', 'jobs.v1'],
  otcpMethods: ['import.start', 'job.get'],
  run: (args, ctx) => openAudio(ctx, args),
});
