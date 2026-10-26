// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_export_audio: writes a WAV file of a clip, a track or the master mix (export.start) and
// waits for the job for a while. There is no overwrite option: the call always asks OpenTune to
// pick the next free name (ifExists rename), so an existing file is never replaced. Without a path
// the file goes next to the source audio as <name>.opentune.wav. File names and paths come back
// only as data inside the result, never in the summary. After a finished export the file just written is read once,
// in blocks, for its peak level: a mix above 0 dBFS is held by a 32-bit float file but clips when converted.

import { z } from 'zod';

import { toolError } from '../errors/tool-error.js';
import type { Json } from '../otcp/client.js';
import { pathProblem, resolvePath, splitPath, systemOf, type PathSystem } from '../paths/index.js';
import { asList, isObject } from '../render/changes.js';
import { writeBody, writeOutcome } from '../render/index.js';
import {
  MAX_WAIT_SECONDS,
  START_TIMEOUT_MS,
  WAIT_MARGIN_MS,
  followText,
  isTerminal,
  jobFailure,
  jobRef,
  jobState,
  startAndWait,
} from './follow-job.js';
import { jobSentence } from './jobs.js';
import { readWavPeak, type PeakFailure } from './wav-peak.js';
import { WRITE_RESULT_OUTPUT, defineTool, withInstance, type Outcome, type ToolContext } from './registry.js';

const TOOL = 'opentune_export_audio';
/** Reading the project before the export starts. */
export const READ_TIMEOUT_MS = 10_000;
/**
 * Seconds waited for the export job when the call does not say. Together with the read and start
 * timeouts and the wait margin, even the longest allowed wait stays under the 60 s request limit
 * that common MCP clients apply (see EXPORT_WORST_CASE_MS).
 */
export const EXPORT_DEFAULT_WAIT_SECONDS = 20;
/** The longest one call can take: project.get, export.start, then the longest wait plus its margin. */
export const EXPORT_WORST_CASE_MS = READ_TIMEOUT_MS + START_TIMEOUT_MS + MAX_WAIT_SECONDS * 1000 + WAIT_MARGIN_MS;
/** Appended to the stem of the source file name to make the default export name. */
const DEFAULT_SUFFIX = '.opentune.wav';

export type ExportKind = 'clip' | 'track' | 'master';

export interface ExportAudioArgs {
  readonly kind: ExportKind;
  readonly target?: { readonly clip?: string | undefined; readonly track?: number | undefined } | undefined;
  readonly path?: string | undefined;
  readonly allow_dry?: boolean | undefined;
  readonly wait_seconds?: number | undefined;
  readonly instance_id?: string | undefined;
}

const invalid = (detail: string, reason?: string): Outcome => ({
  ok: false,
  error: toolError('INVALID_ARGUMENT', { detail, ...(reason === undefined ? {} : { reason }) }),
});

/** The OTCP target of the call, or the reason the combination of kind and target is wrong. */
function otcpTarget(args: ExportAudioArgs): { target?: Json } | { problem: string } {
  const { clip, track } = args.target ?? {};
  if (clip !== undefined && track !== undefined) return { problem: 'target names a clip and a track; give one' };
  if (args.kind === 'master') {
    return clip === undefined && track === undefined
      ? {}
      : { problem: 'kind master exports the whole mix and takes no target' };
  }
  if (args.kind === 'clip') {
    return clip === undefined
      ? { problem: 'kind clip needs target.clip, a placement id (p:...) from opentune_get_project' }
      : { target: { placementId: clip } };
  }
  return track === undefined
    ? { problem: 'kind track needs target.track, a track id (0-based position)' }
    : { target: { trackId: track } };
}

interface Placement {
  readonly placementId: unknown;
  readonly trackId: unknown;
  readonly startTimelineSec: number;
  readonly sourcePath: string | null;
}

function placementsOf(project: Json): Placement[] {
  return asList(project.placements).flatMap((p) =>
    isObject(p)
      ? [
          {
            placementId: p.placementId,
            trackId: p.trackId,
            startTimelineSec: typeof p.startTimelineSec === 'number' ? p.startTimelineSec : 0,
            sourcePath: typeof p.sourcePath === 'string' ? p.sourcePath : null,
          },
        ]
      : [],
  );
}

/** Where a path is the same file for the purpose of the early check: Windows ignores letter case. */
const comparable = (path: string, system: PathSystem): string => (system === 'windows' ? path.toLowerCase() : path);

/**
 * The default file: <directory of the source>/<source name without extension>.opentune.wav. A clip
 * uses its own source; a track the source of its first clip; the master the saved project's file
 * name, else the source of the first clip on the timeline. null when no usable source is known.
 */
export function defaultExportPath(
  project: Json,
  args: ExportAudioArgs,
  system: PathSystem,
): { path: string } | { problem: string } | { notFound: string } {
  const placements = placementsOf(project);
  // An id that is not in the project any more (or was never) is not a reason to ask for a path.
  if (args.kind === 'clip' && !placements.some((p) => p.placementId === args.target?.clip)) {
    return { notFound: 'the clip is not in the project (its id is out of date or wrong)' };
  }
  if (args.kind === 'track') {
    const known = asList(project.tracks).some((t) => isObject(t) && t.trackId === args.target?.track);
    if (!known && !placements.some((p) => p.trackId === args.target?.track)) {
      return { notFound: 'the track is not in the project (its id is out of date or wrong)' };
    }
  }
  const byStart = (a: Placement, b: Placement) => a.startTimelineSec - b.startTimelineSec;
  const usable = (p: Placement) => p.sourcePath !== null && pathProblem(p.sourcePath, system) === undefined;
  const sourceOf = (): string | null => {
    if (args.kind === 'clip') {
      return placements.find((p) => p.placementId === args.target?.clip)?.sourcePath ?? null;
    }
    if (args.kind === 'track') {
      return (
        placements.filter((p) => p.trackId === args.target?.track && usable(p)).sort(byStart)[0]?.sourcePath ?? null
      );
    }
    const info = isObject(project.project) ? project.project : {};
    const saved = typeof info.path === 'string' && pathProblem(info.path, system) === undefined ? info.path : null;
    return saved ?? placements.filter(usable).sort(byStart)[0]?.sourcePath ?? null;
  };
  const source = sourceOf();
  if (source === null || pathProblem(source, system) !== undefined) {
    return {
      problem:
        'OpenTune does not know a source file to put the export next to; pass path, an absolute path ending in .wav',
    };
  }
  const { dir, stem, sep } = splitPath(source, system);
  // Only the name changes, so a valid source path gives a valid default path.
  return { path: `${dir}${sep}${stem}${DEFAULT_SUFFIX}` };
}

const count = (n: number, noun: string) => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

/** Highest N of the names `<stem> (N).wav` an export tries (spec: PROTOCOL.md section 19, ifExists rename). */
const MAX_RENAME_INDEX = 999;

/**
 * Whether `written` is the file this export wrote: the path asked for, or in its folder one of the next free names
 * `<stem> (2).wav` to `<stem> (999).wav`. OpenTune sends the path in the job result; nothing else is read.
 */
export function isFileOfThisExport(written: unknown, requested: string, system: PathSystem): written is string {
  if (typeof written !== 'string' || pathProblem(written, system) !== undefined) return false;
  if (comparable(written, system) === comparable(requested, system)) return true;
  const asked = splitPath(requested, system);
  const got = splitPath(written, system);
  if (comparable(got.dir, system) !== comparable(asked.dir, system)) return false;
  const name = written.slice(got.dir.length + got.sep.length);
  const prefix = comparable(`${asked.stem} (`, system);
  const suffix = '.wav';
  const lower = comparable(name, system);
  if (!lower.startsWith(prefix) || !lower.endsWith(`)${suffix}`)) return false;
  const index = lower.slice(prefix.length, lower.length - suffix.length - 1);
  return /^[1-9][0-9]{0,2}$/.test(index) && Number(index) >= 2 && Number(index) <= MAX_RENAME_INDEX;
}

/** What the read of the exported file adds to the result: the two members, the reasons for a null, the sentence. */
interface PeakReport {
  readonly members: Json;
  readonly reasons: Json;
  readonly sentence: string;
}

const NOT_THIS_EXPORT = 'not_the_exported_file';

/**
 * Reads the exported file for its peak. A file that cannot be read does not fail the export: both members are
 * null and `nullReasons` says why. A peak above full scale gets one sentence in the summary.
 */
export async function peakReport(written: unknown, requested: string, system: PathSystem): Promise<PeakReport> {
  const missing = (reason: PeakFailure | typeof NOT_THIS_EXPORT): PeakReport => ({
    members: { peakDbfs: null, clippedSampleCount: null },
    reasons: { peakDbfs: reason, clippedSampleCount: reason },
    sentence: '',
  });
  if (!isFileOfThisExport(written, requested, system)) return missing(NOT_THIS_EXPORT);
  const peak = await readWavPeak(written);
  if (!peak.ok) return missing(peak.reason);
  const members: Json = { peakDbfs: peak.peakDbfs, clippedSampleCount: peak.clippedSampleCount };
  const reasons: Json = peak.nullReason === undefined ? {} : { peakDbfs: peak.nullReason };
  if (peak.peak <= 1) return { members, reasons, sentence: '' };
  const level =
    peak.peakDbfs === null
      ? 'a sample is not a finite number'
      : `${peak.peakDbfs > 0 ? '+' : ''}${peak.peakDbfs.toFixed(2)} dBFS`;
  return {
    members,
    reasons,
    sentence:
      ` The peak is above 0 dBFS (${level}; ${count(peak.clippedSampleCount, 'sample')} above full scale), so converting ` +
      'the file to 16 bits or playing it elsewhere may clip: lower the volume of a track (opentune_set_tracks, op ' +
      'volume) and export again.',
  };
}

/** The one-sentence summary of a finished export, from the kind asked for and checked counts only. */
function exportSummary(
  args: ExportAudioArgs,
  result: Json,
  requested: string,
  system: PathSystem,
  peakSentence: string,
): string {
  const dry = asList(result.dryContents).length;
  const written = typeof result.path === 'string' ? result.path : null;
  const renamed = written !== null && comparable(written, system) !== comparable(requested, system);
  const what = args.kind === 'master' ? 'the master mix' : `the ${args.kind}`;
  const lead =
    dry > 0
      ? `${TOOL}: ${count(dry, 'content')} in this export ${dry === 1 ? 'is' : 'are'} uncorrected (dry, not pitch-corrected; reasons in export.dryContents), and ${what} was written as a new WAV file.`
      : `${TOOL}: ${what} was written as a new WAV file (path in export.path).`;
  const rename = renamed
    ? ' The name asked for was taken, so OpenTune used the next free name; nothing was overwritten.'
    : '';
  return `${lead}${rename}${peakSentence} The project itself was not changed.`;
}

export async function exportAudio(ctx: ToolContext, args: ExportAudioArgs): Promise<Outcome> {
  const system = systemOf(ctx.platform);
  const t = otcpTarget(args);
  if ('problem' in t) return invalid(t.problem, 'target_mismatch');
  let given: string | null = null;
  if (args.path !== undefined) {
    const resolved = resolvePath(args.path, ctx, 'path', '.wav');
    if (!resolved.ok) return { ok: false, error: resolved.error };
    given = resolved.path;
  }

  return withInstance(ctx, { instanceId: args.instance_id }, ['export.v1', 'jobs.v1', 'read.v1'], async (session) => {
    // The project tells where the default file goes and whether the target is a loaded source file.
    // OpenTune decides by file identity before it writes; this early check only saves a round trip.
    const project = await session.call('project.get', {}, READ_TIMEOUT_MS);
    let target = given;
    if (target === null) {
      const chosen = defaultExportPath(project, args, system);
      if ('notFound' in chosen) {
        return {
          ok: false,
          error: toolError('NOT_FOUND', {
            reason: 'unknown_handle',
            detail: `${chosen.notFound}; read the project again with opentune_get_project and use a current id`,
          }),
        };
      }
      if ('problem' in chosen) return invalid(chosen.problem, 'path_required');
      target = chosen.path;
    }
    const same = comparable(target, system);
    if (placementsOf(project).some((p) => p.sourcePath !== null && comparable(p.sourcePath, system) === same)) {
      return {
        ok: false,
        error: toolError('INVALID_ARGUMENT', {
          reason: 'target_is_loaded_media',
          detail: 'the export path is the source file of a clip in the project; an export never overwrites it',
        }),
      };
    }

    const params: Json = {
      kind: args.kind,
      ...(t.target === undefined ? {} : { target: t.target }),
      path: target,
      // Never "overwrite", never "error": a taken name gets the next free one.
      ifExists: 'rename',
      ...(args.allow_dry === true ? { allowDry: true } : {}),
    };
    const { started, job, waitFailed } = await startAndWait(
      ctx,
      session,
      'export.start',
      params,
      args.wait_seconds ?? EXPORT_DEFAULT_WAIT_SECONDS,
    );
    if (job === null || !isTerminal(job)) {
      const outcome = writeOutcome(started, { tool: TOOL });
      if (!outcome.ok) return outcome;
      const note = job === null ? '' : followText(waitFailed);
      // The agent needs to know where the file will be written, also while the job runs.
      return { ok: true, body: { ...outcome.body, summary: outcome.body.summary + note, requestedPath: target } };
    }
    const state = jobState(job);
    if (state === 'failed') return jobFailure(job);
    if (state === 'cancelled') {
      return {
        ok: true,
        body: { summary: `${TOOL}: ${jobSentence(job)}`, job: jobRef(job), result: job.result ?? null },
      };
    }
    const result = isObject(job.result) ? job.result : null;
    if (result === null) {
      return {
        ok: false,
        error: toolError('INTERNAL', {
          detail: 'OpenTune finished the export job without a result',
          executed: null,
        }),
      };
    }
    // The start envelope changed nothing; it keeps the renderings (ui, side effects, warnings) in the result.
    const rendered = writeBody(started, { tool: TOOL });
    const peak = await peakReport(result.path, target, system);
    const reasons: Json = { ...(isObject(rendered.nullReasons) ? rendered.nullReasons : {}), ...peak.reasons };
    return {
      ok: true,
      body: {
        ...rendered,
        summary: exportSummary(args, result, target, system, peak.sentence),
        job: jobRef(job),
        export: result,
        requestedPath: target,
        ...peak.members,
        ...(Object.keys(reasons).length > 0 ? { nullReasons: reasons } : {}),
      },
    };
  });
}

export const exportAudioTool = defineTool({
  name: TOOL,
  title: 'Export audio from OpenTune',
  description:
    'OpenTune (audio vocal pitch editor): writes a WAV file of a clip, a track or the master mix and waits up to ' +
    'wait_seconds (default 20, max 30); if the export job has not ended, the result names it for opentune_get_job. ' +
    'kind clip needs target.clip (placement id), track needs target.track, master takes none. path: absolute, ' +
    'ending in .wav; default <source folder>/<source name>.opentune.wav. Never overwrites: a taken name gets the ' +
    'next free one. Unanalysed contents are exported uncorrected (dryContents; allow_dry for failed analysis). ' +
    'Does not change the project.',
  inputSchema: z.strictObject({
    kind: z.enum(['clip', 'track', 'master']).describe('What to export: one clip, one track or the whole mix.'),
    target: z
      .strictObject({
        clip: z
          .string()
          .regex(/^p:[0-9a-f]{8}:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/)
          .optional()
          .describe('Clip placement id (p:...) from opentune_get_project. For kind clip.'),
        track: z.number().int().min(0).optional().describe('Track id (0-based position). For kind track.'),
      })
      .optional()
      .describe('Which clip or track to export. Not for master.'),
    path: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        'Absolute path of the WAV file to write, ending in .wav. Default: <source folder>/<name>.opentune.wav.',
      ),
    allow_dry: z
      .boolean()
      .optional()
      .describe(
        'Export a clip whose pitch analysis failed uncorrected instead of failing. Only with the user agreeing.',
      ),
    wait_seconds: z
      .number()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .optional()
      .describe('Seconds to wait for the export to end, 0 to 30. Default 20.'),
    instance_id: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional()
      .describe('OpenTune instance (32 hex digits, from opentune_get_status). Optional when one instance runs.'),
  }),
  outputSchema: WRITE_RESULT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  capabilities: ['export.v1', 'jobs.v1', 'read.v1'],
  otcpMethods: ['export.start', 'project.get', 'job.get'],
  run: (args, ctx) => exportAudio(ctx, args),
});
