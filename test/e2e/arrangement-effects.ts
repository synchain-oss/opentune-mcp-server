// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The arrangement effects scenario against a started OpenTune executable: it proves that what an
// arrangement or track write reports is what the instance then holds, and that the write changed the
// exported master mix exactly as it says and nothing else. It does not judge how the audio sounds.
//
// Four checks, each against a baseline master export of the same two clips:
//
// - Clip gain. `arrangement.edit` op setGain takes clip A to its gain - 6 dB; the RMS level over
//   clip A's region falls by 6 dB (GAIN_TOLERANCE_DB) and clip B's region is bit-identical. The
//   result is compared with a fresh `project.get` (changes[].fields.after and tokens), then edit.undo
//   puts the clip back and the master must equal the baseline bit for bit.
// - Fades are ramps. op setFade puts a fade of 0.5 s on each end of clip A. The wet/baseline level
//   ratio of every 10 ms window of the fade starts (or ends) at most FADE_START_MAX_DB below unity,
//   runs in one direction with FADE_MONOTONIC_SLACK_DB of slack for the windowing, and is within
//   FADE_END_TOLERANCE_DB of unity just outside the fade. The part between the fades and all of clip B
//   stay bit-identical. The ratio at 25, 50 and 75 % of each fade is reported, not checked. Undo is
//   verified as in the gain check.
// - Mute and solo. `track.set` mutes clip B's track, solos clip A's track and solos clip B's track in
//   turn. Each time the other clip's region of the master is silent (SILENCE_MAX_ABS) and the
//   remaining clip is bit-identical. Each call returns a revert recipe, which is sent exactly as
//   given; the old mute/solo values must be read back and the master must equal the baseline again.
//   A revert that does not restore stops the checks after it.
// - Split boundary. Last, because a split cannot be undone (upstream_undo_defect). op split cuts
//   clip A inside a voiced note. The result's created / removed / idMap entries are compared with a
//   fresh `project.get`, and the whole master must stay bit-identical to the baseline (same length);
//   if not, the report holds the largest difference, its time and its distance from the split. The
//   returned revert recipe (a merge) is sent as given; its export must equal the baseline again. A
//   refused merge is reported, not failed.
//
// The audio is generated (test/support/harmonic-tone.ts): two clips on two tracks that do not overlap
// in time, at different pitches. Only generated audio is used; no file name or path reaches the
// report. The instance is started and ended by the exe target (test/contract/exe-target.ts), exactly
// as the smoke and effects scenarios do.
//
// Steps and their results follow the smoke scenario (test/e2e/smoke.ts): PASS, FAIL, SKIP (a
// capability the check needs is not reported) and FLAKY-SKIP (only an inference backend that cannot
// be initialised). A failed set-up step stops the scenario; a failed check does not stop the checks
// after it unless a track revert could not restore the state, or a write took effect without a usable
// undoId. The requirement checks export the master mix only; a clip or track export is not used.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { parseDiscoveryFile } from '../../src/discovery/file.js';
import { OtcpSession, type HelloInfo, type Json } from '../../src/otcp/client.js';
import { checkDataTemplate, exeConfigFromEnv, exeTarget, type ExeTargetOptions } from '../contract/exe-target.js';
import type { TargetInstance } from '../contract/target.js';
import { generateTone, writeToneFiles, type Tone, type ToneFiles } from '../support/harmonic-tone.js';
import { decodeWav, type DecodedWav } from '../support/wav-decode.js';
import { compareSamples, peakOf, round, same, scrubText, waitForAnalysis } from './effects.js';
import {
  StepSkip,
  busyDiagnostics,
  classify,
  isModalBusy,
  isObject,
  member,
  num,
  runJob,
  summarise,
  text,
  type SmokeHooks,
  type StepReport,
  type StepResult,
} from './smoke.js';

// ---------------------------------------------------------------------------------------------
// tolerances, each with the reason for its value

/** The gain change the check applies to clip A, in dB. */
export const GAIN_CHANGE_DB = -6;

/**
 * How far the measured RMS change over clip A's region may lie from GAIN_CHANGE_DB. A gain is a
 * multiplication of samples, so the level change is exact up to how the master sums the clip with
 * the other tracks; 0.5 dB leaves room for that and still separates the 6 dB of the check from no
 * change (0 dB) or a wrong half of it (3 dB).
 */
export const GAIN_TOLERANCE_DB = 0.5;

/** The fade lengths the check asks for, at both ends of clip A. */
export const FADE_SEC = 0.5;

/** The window of the fade measurement: 2 % of a 0.5 s fade, short enough to show the ramp. */
export const FADE_WINDOW_SEC = 0.01;

/**
 * The first fade-in window (and the last fade-out window) must be this far below the baseline. A
 * 10 ms window at the start of a linear 0.5 s ramp measures about -38.8 dB; -24 dB leaves 14.8 dB
 * for a renderer's smoothing or another curve, while a fade that starts at unity measures 0 dB.
 */
export const FADE_START_MAX_DB = -24;

/** The last fade-out window is held to the same limit. */
export const FADE_END_MAX_DB = -24;

/**
 * How close to unity the level just outside a fade must be. The clip is untouched there, so the
 * ratio is 1.0; 0.5 dB allows for the renderer's smoothing at the boundary and is far below the
 * 24 dB of a fade that is still running.
 */
export const FADE_END_TOLERANCE_DB = 0.5;

/**
 * A 10 ms window is 2 % of the 0.5 s fade, so neighbouring windows of a monotone ramp differ by far
 * less than 0.2 dB. 3 dB of slack allows for windowing, overlap and a renderer's own curve; a dip of
 * the size of the fade (24 dB or more) is still caught.
 */
export const FADE_MONOTONIC_SLACK_DB = 3;

/** One 10 ms window is left out at each end of the unchanged middle, where the fade's smoothing may reach. */
export const FADE_GUARD_SEC = FADE_WINDOW_SEC;

/** The length of the window just outside a fade that measures whether the level is back at unity. */
export const FADE_EDGE_WINDOW_SEC = 0.1;

/**
 * RMS below this counts as silence in the level ratios. It is -60 dBFS, 40 dB below the generated
 * tone (about -20 dBFS RMS) and above the generator's noise floor (about -85 dBFS RMS), so a
 * window that only holds the noise floor cannot produce a meaningless ratio.
 */
export const SIGNAL_FLOOR_RMS = 1e-3;

/** The level, in dB, used for a window in which both files are silent; finite, so reports stay JSON. */
export const SILENCE_DB = -200;

/**
 * The largest sample allowed in a region that must be silent: 1e-6 of full scale (-120 dBFS), about
 * 30 dB above the rounding of a float32 master at the tone's level, and 100 dB below the tone. A
 * muted or soloed-out track is expected to produce exact zeros; the limit catches an audible leak
 * without failing on a last-bit residue of the mixer.
 */
export const SILENCE_MAX_ABS = 1e-6;

/** Timeline values read back from OpenTune are rounded to 1e-6 s, like the values in a result. */
export const TIMELINE_EPSILON_SEC = 1e-6;

/**
 * The split is asked for a little off the 10 ms analysis grid, so that an instance which snaps it
 * reports SPLIT_SNAPPED and the check has to use appliedTimelineSec. It stays inside the chosen note.
 */
export const SPLIT_OFFSET_SEC = 0.003;

/** A voiced note must be at least this long to hold a split with room at both ends. */
const MIN_SPLIT_NOTE_SEC = 0.2;

const DEFAULT_STEP_TIMEOUT_MS = 180_000;
const BASE_CAPABILITIES = ['session.v1', 'jobs.v1', 'read.v1', 'import.v1', 'export.v1'] as const;

// ---------------------------------------------------------------------------------------------
// configuration

export interface ArrangementEffectsConfig {
  readonly exe: ExeTargetOptions;
  /** How long one wait (analysis, a job) may take; 180 s unless given. */
  readonly stepTimeoutMs: number;
  /** Where the JSON report goes; none unless given. */
  readonly reportPath: string | undefined;
  /** Which variable the data template of `exe` came from, for the report; null (or absent) for none. */
  readonly dataTemplateFrom?: DataTemplateSource | null;
}

/** The variables a data template can come from: the scenario's own wins over the shared one. */
export type DataTemplateSource = 'OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE' | 'OTCP_TARGET_DATA_TEMPLATE';

export type ArrangementEffectsSetup = { readonly skip: string } | { readonly config: ArrangementEffectsConfig };

function absoluteOrUndefined(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value === '') return undefined;
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

/**
 * Reads OTCP_TARGET_EXE (and its siblings), OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE,
 * OTCP_E2E_ARRANGEMENT_EFFECTS_REPORT, OTCP_E2E_REPORT and OTCP_E2E_STEP_TIMEOUT_MS.
 *
 * The scenario has its own data template variable so that it can run in the same session as the
 * effects scenario; when it is not set, OTCP_TARGET_DATA_TEMPLATE is used, like every other
 * scenario. Its report is arrangement-effects.json next to OTCP_E2E_REPORT unless its own variable
 * names one.
 */
export function arrangementEffectsSetupFromEnv(env: NodeJS.ProcessEnv = process.env): ArrangementEffectsSetup {
  const shared = exeConfigFromEnv(env);
  if ('skip' in shared) return { skip: shared.skip };
  let exe = shared;
  let dataTemplateFrom: DataTemplateSource | null =
    shared.options.dataTemplate === undefined ? null : 'OTCP_TARGET_DATA_TEMPLATE';
  const ownTemplate = env.OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE;
  if (ownTemplate !== undefined && ownTemplate !== '') {
    checkDataTemplate(ownTemplate, 'OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE');
    exe = { options: { ...shared.options, dataTemplate: ownTemplate } };
    dataTemplateFrom = 'OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE';
  }
  let stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS;
  const raw = env.OTCP_E2E_STEP_TIMEOUT_MS;
  if (raw !== undefined && raw !== '') {
    stepTimeoutMs = Number(raw);
    if (!Number.isInteger(stepTimeoutMs) || stepTimeoutMs <= 0) {
      throw new Error('OTCP_E2E_STEP_TIMEOUT_MS must be a positive integer');
    }
  }
  let reportPath = absoluteOrUndefined(env, 'OTCP_E2E_ARRANGEMENT_EFFECTS_REPORT');
  const smokeReport = absoluteOrUndefined(env, 'OTCP_E2E_REPORT');
  if (reportPath === undefined && smokeReport !== undefined) {
    reportPath = path.join(path.dirname(smokeReport), 'arrangement-effects.json');
  }
  return { config: { exe: exe.options, stepTimeoutMs, reportPath, dataTemplateFrom } };
}

// ---------------------------------------------------------------------------------------------
// the report

export interface ArrangementEffectsReport {
  readonly schema: 'opentune-mcp-e2e-arrangement-effects/1';
  readonly result: StepResult;
  readonly counts: Readonly<Record<StepResult, number>>;
  /**
   * Whether OpenTune's hybrid mode was on: true when session.info or any export reported it on,
   * false when all that reported it said off, null when nothing reported it.
   */
  readonly hybridMode: boolean | null;
  /** Which variable the instance's data template came from; null when none was copied in. */
  readonly dataTemplateFrom: DataTemplateSource | null;
  readonly startedAt: string;
  readonly totalMs: number;
  readonly steps: readonly StepReport[];
  readonly instance: {
    readonly protocol: string;
    readonly appVersion: string;
    readonly capabilities: readonly string[];
  } | null;
  /** What the generated audio is; never a file name or a path. */
  readonly audio: Readonly<Record<string, unknown>> | null;
  /** The tolerances the checks used, each as in its constant. */
  readonly tolerances: Readonly<Record<string, number>>;
  /** The measurements of every check, by step name. */
  readonly checks: Readonly<Record<string, unknown>>;
  /** Wall-clock times, in milliseconds, and the exports of each check. */
  readonly timings: Readonly<Record<string, unknown>>;
  readonly dataDir: string | null;
  readonly templateSkipped: number | null;
  readonly busyDiagnostics: string | null;
}

/** What an export result reported about how it was processed. */
export interface ExportProcessing {
  readonly export: string;
  readonly hybridMode: boolean | null;
  readonly backend: string | null;
  readonly vocoderWeight: string | null;
  readonly tuningHz: number | null;
}

// ---------------------------------------------------------------------------------------------
// reading the project

/** A content token as a read result or a write result carries it. */
export interface ContentTokens {
  readonly contentId: string;
  readonly revision: string;
  readonly gridRevision: string;
  readonly keyRevision: string;
}

/** One clip (placement) of the project. */
export interface PlacementRead {
  readonly placementId: string;
  readonly trackId: number;
  readonly contentId: string;
  readonly startTimelineSec: number;
  readonly endTimelineSec: number;
  readonly durationSec: number;
  readonly clipInContentSec: number;
  readonly gainDb: number | null;
  readonly gainLinear: number;
  readonly fadeInSec: number;
  readonly fadeOutSec: number;
  readonly geometryHash: string;
}

/** One track of the project, as far as the checks read it. */
export interface TrackRead {
  readonly trackId: number;
  readonly muted: boolean;
  readonly solo: boolean;
  readonly audible: boolean;
}

/** What the scenario reads of the project after a write. */
export interface ProjectState {
  readonly arrangementRevision: string;
  readonly contents: readonly ContentTokens[];
  readonly placements: readonly PlacementRead[];
  readonly tracks: readonly TrackRead[];
}

function booleanField(value: unknown, name: string, what: string): boolean {
  const v = member(value, name, what);
  if (typeof v !== 'boolean') throw new Error(`${what}.${name} is not a boolean`);
  return v;
}

function nullableNumber(value: unknown, name: string, what: string): number | null {
  const v = member(value, name, what);
  if (v !== null && typeof v !== 'number') throw new Error(`${what}.${name} is not a number or null`);
  return v;
}

function parseContentTokens(value: unknown): ContentTokens {
  return {
    contentId: text(value, 'contentId', 'a content token'),
    revision: text(value, 'revision', 'a content token'),
    gridRevision: text(value, 'gridRevision', 'a content token'),
    keyRevision: text(value, 'keyRevision', 'a content token'),
  };
}

function parsePlacement(value: unknown): PlacementRead {
  return {
    placementId: text(value, 'placementId', 'a placement'),
    trackId: num(value, 'trackId', 'a placement'),
    contentId: text(value, 'contentId', 'a placement'),
    startTimelineSec: num(value, 'startTimelineSec', 'a placement'),
    endTimelineSec: num(value, 'endTimelineSec', 'a placement'),
    durationSec: num(value, 'durationSec', 'a placement'),
    clipInContentSec: num(value, 'clipInContentSec', 'a placement'),
    gainDb: nullableNumber(value, 'gainDb', 'a placement'),
    gainLinear: num(value, 'gainLinear', 'a placement'),
    fadeInSec: num(value, 'fadeInSec', 'a placement'),
    fadeOutSec: num(value, 'fadeOutSec', 'a placement'),
    geometryHash: text(value, 'geometryHash', 'a placement'),
  };
}

function parseTrack(value: unknown): TrackRead {
  return {
    trackId: num(value, 'trackId', 'a track'),
    muted: booleanField(value, 'muted', 'a track'),
    solo: booleanField(value, 'solo', 'a track'),
    audible: booleanField(value, 'audible', 'a track'),
  };
}

/** The project as a fresh `project.get` returns it. */
export async function readProject(session: OtcpSession): Promise<ProjectState> {
  const read = await session.call('project.get', {}, 30_000);
  const asOf = member(read, 'asOf', 'the project read result');
  const contents = member(asOf, 'contents', 'asOf');
  const placements = member(read, 'placements', 'the project read result');
  const tracks = member(read, 'tracks', 'the project read result');
  if (!Array.isArray(contents) || !Array.isArray(placements) || !Array.isArray(tracks)) {
    throw new Error('the project read result has no contents, placements or tracks array');
  }
  return {
    arrangementRevision: text(asOf, 'arrangementRevision', 'asOf'),
    contents: (contents as unknown[]).map(parseContentTokens),
    placements: (placements as unknown[]).map(parsePlacement),
    tracks: (tracks as unknown[]).map(parseTrack),
  };
}

/** The clip with the given id, else an error. */
export function placementOf(state: ProjectState, placementId: string): PlacementRead {
  const placement = state.placements.find((p) => p.placementId === placementId);
  if (placement === undefined) throw new Error(`placement ${placementId} is not in the project`);
  return placement;
}

/** The track with the given id, else an error. */
export function trackOf(state: ProjectState, trackId: number): TrackRead {
  const track = state.tracks.find((t) => t.trackId === trackId);
  if (track === undefined) throw new Error(`track ${String(trackId)} is not in the project`);
  return track;
}

/** The content token of a content, else an error. */
export function contentTokensOf(state: ProjectState, contentId: string): ContentTokens {
  const content = state.contents.find((c) => c.contentId === contentId);
  if (content === undefined) throw new Error(`content ${contentId} is not in the project`);
  return content;
}

/**
 * The tokens of a write result against a fresh read: arrangementRevision, every content token and
 * every placement's geometryHash. They are the values a client uses as expected values, so a fresh
 * read must agree with all of them.
 */
export function tokensProblems(result: Json, state: ProjectState): string[] {
  const problems: string[] = [];
  try {
    const tokens = member(result, 'tokens', 'the result');
    if (member(tokens, 'arrangementRevision', 'tokens') !== state.arrangementRevision) {
      problems.push('tokens.arrangementRevision is not the one read afterwards');
    }
    const contents = member(tokens, 'contents', 'tokens');
    if (!Array.isArray(contents)) {
      problems.push('tokens.contents is not an array');
    } else {
      for (const raw of contents as unknown[]) {
        const token = parseContentTokens(raw);
        const read = state.contents.find((c) => c.contentId === token.contentId);
        if (read === undefined) {
          problems.push(`tokens names content ${token.contentId}, which is not there afterwards`);
          continue;
        }
        for (const name of ['revision', 'gridRevision', 'keyRevision'] as const) {
          if (!same(token[name], read[name])) {
            problems.push(`tokens ${token.contentId} ${name} is not the one read afterwards`);
          }
        }
      }
    }
    const placements = member(tokens, 'placements', 'tokens');
    if (!Array.isArray(placements)) {
      problems.push('tokens.placements is not an array');
    } else {
      for (const raw of placements as unknown[]) {
        const placementId = text(raw, 'placementId', 'a placement token');
        const geometryHash = text(raw, 'geometryHash', 'a placement token');
        const read = state.placements.find((p) => p.placementId === placementId);
        if (read === undefined) {
          problems.push(`tokens names placement ${placementId}, which is not there afterwards`);
        } else if (geometryHash !== read.geometryHash) {
          problems.push(`tokens placement ${placementId} geometryHash is not the one read afterwards`);
        }
      }
    }
  } catch (error) {
    problems.push(`tokens: ${error instanceof Error ? error.message : String(error)}`);
  }
  return problems;
}

/** What a write result's changes and tokens disagree with a fresh read about. */
export interface WriteConsistency {
  readonly problems: string[];
  /**
   * The fields the scenario does not read back, as `entity.field`, sorted, each once. They are not
   * problems: fields are only ever added to the specification, and a client accepts unknown ones.
   */
  readonly unreadFields: string[];
}

/** The value of a read placement that a change may report. */
function readBackOfPlacement(placement: PlacementRead): Readonly<Record<string, unknown>> {
  return {
    placementId: placement.placementId,
    trackId: placement.trackId,
    contentId: placement.contentId,
    startTimelineSec: placement.startTimelineSec,
    endTimelineSec: placement.endTimelineSec,
    durationSec: placement.durationSec,
    clipInContentSec: placement.clipInContentSec,
    gainDb: placement.gainDb,
    gainLinear: placement.gainLinear,
    fadeInSec: placement.fadeInSec,
    fadeOutSec: placement.fadeOutSec,
    geometryHash: placement.geometryHash,
  };
}

/**
 * Report consistency of a write result against the project read right after it: the tokens, and
 * every field of a change that the scenario can read back (a placement's geometry, gain and fades, a
 * track's mute/solo/audible, a content's tokens). Other fields are listed in unreadFields.
 */
export function writeConsistency(result: Json, state: ProjectState): WriteConsistency {
  const problems = tokensProblems(result, state);
  const unread = new Set<string>();
  let changes: unknown;
  try {
    changes = member(result, 'changes', 'the result');
  } catch (error) {
    return { problems: [...problems, error instanceof Error ? error.message : String(error)], unreadFields: [] };
  }
  if (!Array.isArray(changes)) return { problems: [...problems, 'changes is not an array'], unreadFields: [] };
  for (const change of changes as unknown[]) {
    let entity: string;
    let ref: unknown;
    try {
      entity = text(change, 'entity', 'a change');
      ref = member(change, 'ref', 'a change');
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const fields = isObject(change) ? change.fields : undefined;
    if (!isObject(fields)) continue;
    let readBack: Readonly<Record<string, unknown>> | undefined;
    let what = entity;
    if (entity === 'placement') {
      const placementId = text(ref, 'placementId', 'a placement reference');
      what = `placement ${placementId}`;
      const placement = state.placements.find((p) => p.placementId === placementId);
      if (placement === undefined) {
        problems.push(`placement ${placementId} of the changes is not there afterwards`);
      } else {
        readBack = readBackOfPlacement(placement);
      }
    } else if (entity === 'track') {
      const trackId = num(ref, 'trackId', 'a track reference');
      what = `track ${String(trackId)}`;
      const track = state.tracks.find((t) => t.trackId === trackId);
      if (track === undefined) {
        problems.push(`track ${String(trackId)} of the changes is not there afterwards`);
      } else {
        readBack = { muted: track.muted, solo: track.solo, audible: track.audible };
      }
    } else if (entity === 'content') {
      const contentId = text(ref, 'contentId', 'a content reference');
      what = `content ${contentId}`;
      const content = state.contents.find((c) => c.contentId === contentId);
      if (content === undefined) {
        problems.push(`content ${contentId} of the changes is not there afterwards`);
      } else {
        readBack = { revision: content.revision, gridRevision: content.gridRevision, keyRevision: content.keyRevision };
      }
    }
    if (readBack === undefined) {
      for (const name of Object.keys(fields)) unread.add(`${entity}.${name}`);
      continue;
    }
    for (const [name, field] of Object.entries(fields)) {
      if (!Object.hasOwn(readBack, name)) {
        unread.add(`${entity}.${name}`);
        continue;
      }
      if (!isObject(field)) continue;
      if (!same(field.after, readBack[name])) {
        problems.push(
          `${what} ${name}: the result says ${JSON.stringify(field.after)}, read back ${JSON.stringify(readBack[name])}`,
        );
      }
    }
  }
  return { problems, unreadFields: [...unread].sort() };
}

/** Problems between two snapshots of the project: placements, their fields, tracks and contents. */
export function projectSnapshotProblems(before: ProjectState, after: ProjectState): string[] {
  const problems: string[] = [];
  const beforeIds = before.placements.map((p) => p.placementId).sort();
  const afterIds = after.placements.map((p) => p.placementId).sort();
  if (beforeIds.join('|') !== afterIds.join('|')) {
    problems.push(
      `${String(afterIds.length)} placements after the step, ${String(beforeIds.length)} before it: ` +
        `${afterIds.join(', ')} vs ${beforeIds.join(', ')}`,
    );
  }
  for (const placement of before.placements) {
    const read = after.placements.find((p) => p.placementId === placement.placementId);
    if (read === undefined) continue;
    for (const name of [
      'trackId',
      'contentId',
      'startTimelineSec',
      'endTimelineSec',
      'durationSec',
      'clipInContentSec',
      'gainDb',
      'gainLinear',
      'fadeInSec',
      'fadeOutSec',
    ] as const) {
      if (!same(placement[name], read[name])) {
        problems.push(
          `placement ${placement.placementId} ${name}: ${JSON.stringify(placement[name])} before, ` +
            `${JSON.stringify(read[name])} after`,
        );
      }
    }
  }
  for (const track of before.tracks) {
    const read = after.tracks.find((t) => t.trackId === track.trackId);
    if (read === undefined) {
      problems.push(`track ${String(track.trackId)} is gone`);
      continue;
    }
    for (const name of ['muted', 'solo', 'audible'] as const) {
      if (track[name] !== read[name]) {
        problems.push(
          `track ${String(track.trackId)} ${name}: ${String(track[name])} before, ${String(read[name])} after`,
        );
      }
    }
  }
  for (const content of before.contents) {
    const read = after.contents.find((c) => c.contentId === content.contentId);
    if (read === undefined) {
      problems.push(`content ${content.contentId} is gone`);
      continue;
    }
    for (const name of ['revision', 'gridRevision', 'keyRevision'] as const) {
      if (content[name] !== read[name]) {
        problems.push(`content ${content.contentId} ${name}: ${content[name]} before, ${read[name]} after`);
      }
    }
  }
  return problems.slice(0, 8);
}

// ---------------------------------------------------------------------------------------------
// measuring the master mix

/** A span of the master, in seconds. */
export interface Span {
  readonly startSec: number;
  readonly endSec: number;
}

/** The span a clip occupies on the timeline. */
export const clipSpan = (placement: PlacementRead): Span => ({
  startSec: placement.startTimelineSec,
  endSec: placement.endTimelineSec,
});

/** The number of samples a span covers, clamped to the file. */
function sampleRange(wav: DecodedWav, span: Span): { readonly from: number; readonly to: number } {
  const rate = wav.sampleRateHz;
  return {
    from: Math.max(0, Math.round(span.startSec * rate)),
    to: Math.min(wav.mono.length, Math.round(span.endSec * rate)),
  };
}

/** The RMS of a span over the mean of the channels; 0 for an empty span. */
export function rmsOf(wav: DecodedWav, span: Span): number {
  const { from, to } = sampleRange(wav, span);
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) sum += (wav.mono[i] ?? 0) ** 2;
  return Math.sqrt(sum / (to - from));
}

/** The level difference of two RMS values in dB; SILENCE_DB when both are silent, null when only the baseline is. */
export function levelRatioDb(baselineRms: number, wetRms: number): number | null {
  if (baselineRms <= SIGNAL_FLOOR_RMS) return wetRms <= SIGNAL_FLOOR_RMS ? SILENCE_DB : null;
  if (wetRms <= 0) return SILENCE_DB;
  return 20 * Math.log10(wetRms / baselineRms);
}

/** The level difference of a wet file against the baseline over a span, in dB. */
export function levelDifferenceDb(baseline: DecodedWav, wet: DecodedWav, span: Span): number | null {
  return levelRatioDb(rmsOf(baseline, span), rmsOf(wet, span));
}

/** One window of the fade measurement. `db` is null when the baseline is silent but the wet file is not. */
export interface LevelWindow {
  readonly startSec: number;
  readonly endSec: number;
  readonly baselineRms: number;
  readonly wetRms: number;
  readonly db: number | null;
}

/**
 * The level ratio of `count` equal windows over `from` to `to`; the last window ends exactly at `to`,
 * so a fade that is not a whole number of windows is still measured end to end.
 */
export function levelWindows(
  baseline: DecodedWav,
  wet: DecodedWav,
  fromSec: number,
  toSec: number,
  windowSec: number,
): LevelWindow[] {
  const span = toSec - fromSec;
  if (!(span > 0) || !(windowSec > 0)) return [];
  const count = Math.max(1, Math.round(span / windowSec));
  const width = span / count;
  const windows: LevelWindow[] = [];
  for (let i = 0; i < count; i++) {
    const startSec = fromSec + i * width;
    const endSec = i === count - 1 ? toSec : startSec + width;
    const baselineRms = rmsOf(baseline, { startSec, endSec });
    const wetRms = rmsOf(wet, { startSec, endSec });
    windows.push({ startSec, endSec, baselineRms, wetRms, db: levelRatioDb(baselineRms, wetRms) });
  }
  return windows;
}

/** The level ratio of a 10 ms window centred at `fraction` of `fromSec` to `toSec`; null when unmeasurable. */
export function levelAtFraction(
  baseline: DecodedWav,
  wet: DecodedWav,
  fromSec: number,
  toSec: number,
  fraction: number,
): number | null {
  const centre = fromSec + fraction * (toSec - fromSec);
  const half = FADE_WINDOW_SEC / 2;
  return levelRatioDb(
    rmsOf(baseline, { startSec: centre - half, endSec: centre + half }),
    rmsOf(wet, { startSec: centre - half, endSec: centre + half }),
  );
}

/** The measurements of a fade that the report holds; `problems` is empty when it is a proper ramp. */
export interface FadeMeasurement {
  readonly direction: 'in' | 'out';
  readonly fromSec: number;
  readonly toSec: number;
  readonly windows: readonly LevelWindow[];
  /**
   * The first audible window of a fade-in, the last audible window of a fade-out: where the ramp
   * still acts on the signal. A clip that ends in silence has no signal in its last windows, so the
   * last window with audio is the one that shows whether the fade reached the end.
   */
  readonly edgeDb: number | null;
  readonly edgeWindowIndex: number | null;
  /** The 100 ms just outside the fade: within FADE_END_TOLERANCE_DB of unity. */
  readonly edgeLevelDb: number | null;
  /** The ratio at 25, 50 and 75 % of the fade; information, not a check. */
  readonly fractions: {
    readonly at25Db: number | null;
    readonly at50Db: number | null;
    readonly at75Db: number | null;
  };
  readonly monotonicViolations: readonly {
    readonly index: number;
    readonly db: number | null;
    readonly previousDb: number | null;
  }[];
  readonly silentWindows: readonly number[];
  readonly problems: readonly string[];
}

/**
 * Measures one fade against the baseline. A fade-in must start at most FADE_START_MAX_DB below the
 * baseline and rise; a fade-out must fall to at most FADE_END_MAX_DB and may not rise. Both are
 * checked against the level just outside the fade, and the slope is allowed FADE_MONOTONIC_SLACK_DB
 * per window for the windowing.
 */
export function measureFade(
  baseline: DecodedWav,
  wet: DecodedWav,
  clip: Span,
  fadeSec: number,
  direction: 'in' | 'out',
): FadeMeasurement {
  const fromSec = direction === 'in' ? clip.startSec : clip.endSec - fadeSec;
  const toSec = direction === 'in' ? clip.startSec + fadeSec : clip.endSec;
  const windows = levelWindows(baseline, wet, fromSec, toSec, FADE_WINDOW_SEC);
  const problems: string[] = [];
  const silentWindows: number[] = [];
  for (const [i, window] of windows.entries()) {
    if (window.db === null) {
      silentWindows.push(i);
      problems.push(
        `the baseline is silent in ${direction === 'in' ? 'fade-in' : 'fade-out'} window ${String(i)} but the wet file is not`,
      );
    }
  }
  const dbOf = (window: LevelWindow | undefined): number | null => window?.db ?? null;
  const audible = windows
    .map((window, index) => ({ window, index }))
    .filter(({ window }) => window.baselineRms > SIGNAL_FLOOR_RMS);
  const edge = direction === 'in' ? audible[0] : audible.at(-1);
  const edgeWindowIndex = edge?.index ?? null;
  const edgeDb = edge === undefined ? null : edge.window.db;
  const edgeMax = direction === 'in' ? FADE_START_MAX_DB : FADE_END_MAX_DB;
  if (edgeDb === null) {
    problems.push(`the ${direction === 'in' ? 'first' : 'last'} audible fade window cannot be measured`);
  } else if (edgeDb > edgeMax) {
    problems.push(
      `the ${direction === 'in' ? 'first' : 'last'} audible fade window is ${String(round(edgeDb))} dB, ` +
        `expected at most ${String(edgeMax)} dB`,
    );
  }
  const monotonicViolations: { index: number; db: number | null; previousDb: number | null }[] = [];
  for (let i = 1; i < windows.length; i++) {
    const previous = dbOf(windows[i - 1]);
    const current = dbOf(windows[i]);
    if (previous === null || current === null) continue;
    const violated =
      direction === 'in' ? current < previous - FADE_MONOTONIC_SLACK_DB : current > previous + FADE_MONOTONIC_SLACK_DB;
    if (violated) {
      monotonicViolations.push({ index: i, db: current, previousDb: previous });
      problems.push(
        `the ${direction === 'in' ? 'fade-in' : 'fade-out'} is not monotonic at window ${String(i)}: ` +
          `${String(round(previous))} dB then ${String(round(current))} dB (allowed ${String(FADE_MONOTONIC_SLACK_DB)} dB of slack)`,
      );
    }
  }
  const edgeLevelSpan: Span =
    direction === 'in'
      ? { startSec: toSec, endSec: Math.min(clip.endSec, toSec + FADE_EDGE_WINDOW_SEC) }
      : { startSec: Math.max(clip.startSec, fromSec - FADE_EDGE_WINDOW_SEC), endSec: fromSec };
  const edgeLevelDb = levelDifferenceDb(baseline, wet, edgeLevelSpan);
  if (edgeLevelDb === null) {
    problems.push(`the level just ${direction === 'in' ? 'after' : 'before'} the fade cannot be measured`);
  } else if (Math.abs(edgeLevelDb) > FADE_END_TOLERANCE_DB) {
    problems.push(
      `the level just ${direction === 'in' ? 'after' : 'before'} the fade is ${String(round(edgeLevelDb))} dB from the baseline ` +
        `(allowed ${String(FADE_END_TOLERANCE_DB)} dB)`,
    );
  }
  return {
    direction,
    fromSec,
    toSec,
    windows,
    edgeDb,
    edgeWindowIndex,
    edgeLevelDb,
    fractions: {
      at25Db: levelAtFraction(baseline, wet, fromSec, toSec, 0.25),
      at50Db: levelAtFraction(baseline, wet, fromSec, toSec, 0.5),
      at75Db: levelAtFraction(baseline, wet, fromSec, toSec, 0.75),
    },
    monotonicViolations,
    silentWindows,
    problems,
  };
}

/** The largest absolute sample difference and where it is. */
export interface MaxDifference {
  readonly bitIdentical: boolean;
  readonly maxAbsDiff: number;
  readonly maxAbsDiffDbfs: number | null;
  readonly timeSec: number | null;
  readonly channel: number | null;
  readonly distanceFromSplitSec: number | null;
  readonly lengthsEqual: boolean;
}

/**
 * Compares two files sample by sample over their whole length, every channel, and returns the
 * largest difference and where it occurs. `referenceSec` is the split point the report measures the
 * distance from; missing samples of a shorter file count as 0 and make the files not bit-identical.
 */
export function maxDifference(
  baseline: DecodedWav,
  wet: DecodedWav,
  referenceSec: number | null = null,
): MaxDifference {
  const channels = Math.max(baseline.channels.length, wet.channels.length);
  let maxAbsDiff = 0;
  let timeSec: number | null = null;
  let channel: number | null = null;
  let lengthsEqual = baseline.channels.length === wet.channels.length;
  for (let c = 0; c < channels; c++) {
    const a = baseline.channels[c];
    const b = wet.channels[c];
    const length = Math.max(a?.length ?? 0, b?.length ?? 0);
    if ((a?.length ?? 0) !== (b?.length ?? 0)) lengthsEqual = false;
    for (let i = 0; i < length; i++) {
      const d = Math.abs((a?.[i] ?? 0) - (b?.[i] ?? 0));
      if (d > maxAbsDiff) {
        maxAbsDiff = d;
        timeSec = i / baseline.sampleRateHz;
        channel = c;
      }
    }
  }
  return {
    bitIdentical: maxAbsDiff === 0 && lengthsEqual,
    maxAbsDiff,
    maxAbsDiffDbfs: maxAbsDiff > 0 ? round(20 * Math.log10(maxAbsDiff), 1) : null,
    timeSec: timeSec === null ? null : round(timeSec, 6),
    channel,
    distanceFromSplitSec: timeSec === null || referenceSec === null ? null : round(Math.abs(timeSec - referenceSec), 6),
    lengthsEqual,
  };
}

/** A whole-file sample comparison, for the "equals the baseline" checks. */
export interface WholeFileComparison {
  readonly bitIdentical: boolean;
  readonly maxAbsDiff: number;
  readonly maxAbsDiffDbfs: number | null;
  readonly lengthsEqual: boolean;
}

export function wholeFileComparison(baseline: DecodedWav, wet: DecodedWav): WholeFileComparison {
  const endSec = Math.max(baseline.mono.length / baseline.sampleRateHz, wet.mono.length / wet.sampleRateHz);
  const comparison = compareSamples(baseline, wet, [{ startSec: 0, endSec }]);
  const lengthsEqual =
    baseline.channels.length === wet.channels.length &&
    baseline.mono.length === wet.mono.length &&
    baseline.channels.every((channel, i) => channel.length === wet.channels[i]?.length);
  return {
    bitIdentical: comparison.bitIdentical === 1 && lengthsEqual,
    maxAbsDiff: comparison.maxAbsDiff,
    maxAbsDiffDbfs: comparison.maxAbsDiffDbfs,
    lengthsEqual,
  };
}

/** What a region of the master holds when it must be silent. */
export interface Silence {
  readonly maxAbs: number;
  readonly nonZeroSamples: number;
  readonly samples: number;
}

/** The largest absolute sample of a span, every channel, and how many samples are not exactly 0. */
export function silenceOf(wav: DecodedWav, span: Span): Silence {
  const { from, to } = sampleRange(wav, span);
  let maxAbs = 0;
  let nonZeroSamples = 0;
  let samples = 0;
  for (const channel of wav.channels) {
    for (let i = from; i < Math.min(to, channel.length); i++) {
      const value = channel[i] ?? 0;
      if (value !== 0) nonZeroSamples++;
      maxAbs = Math.max(maxAbs, Math.abs(value));
      samples++;
    }
  }
  return { maxAbs, nonZeroSamples, samples };
}

// ---------------------------------------------------------------------------------------------
// reading notes

/** The part of a note that the split check reads. */
export interface NoteRead {
  readonly index: number;
  readonly startContentSec: number;
  readonly endContentSec: number;
  readonly voiced: boolean;
}

/** All notes of a content, page by page. */
export async function readNotes(session: OtcpSession, contentId: string): Promise<readonly NoteRead[]> {
  const notes: NoteRead[] = [];
  let cursor: string | null = null;
  do {
    const page: Json = await session.call(
      'content.getNotes',
      cursor === null ? { contentId, limit: 500 } : { contentId, limit: 500, cursor },
      30_000,
    );
    const list = member(page, 'notes', 'content.getNotes');
    if (!Array.isArray(list)) throw new Error('content.getNotes has no notes array');
    for (const raw of list as unknown[]) {
      notes.push({
        index: num(raw, 'index', 'a note'),
        startContentSec: num(raw, 'startContentSec', 'a note'),
        endContentSec: num(raw, 'endContentSec', 'a note'),
        voiced: booleanField(raw, 'voiced', 'a note'),
      });
    }
    const next = member(page, 'nextCursor', 'content.getNotes');
    cursor = typeof next === 'string' ? next : null;
  } while (cursor !== null);
  return notes;
}

/**
 * A timeline position strictly inside a voiced note of a clip, or undefined when the clip has none
 * long enough. Positions are converted through the clip's source window.
 */
export function splitPointOf(clip: PlacementRead, notes: readonly NoteRead[]): number | undefined {
  let best: { startSec: number; endSec: number } | undefined;
  for (const note of notes) {
    if (!note.voiced) continue;
    const startSec = clip.startTimelineSec + (note.startContentSec - clip.clipInContentSec);
    const endSec = clip.startTimelineSec + (note.endContentSec - clip.clipInContentSec);
    const from = Math.max(startSec, clip.startTimelineSec);
    const to = Math.min(endSec, clip.endTimelineSec);
    if (to - from < MIN_SPLIT_NOTE_SEC) continue;
    if (best === undefined || to - from > best.endSec - best.startSec) best = { startSec: from, endSec: to };
  }
  if (best === undefined) return undefined;
  return (best.startSec + best.endSec) / 2;
}

// ---------------------------------------------------------------------------------------------
// the scenario

export type ArrangementEffectsHooks = SmokeHooks;

interface StepOptions {
  /** Runs even when an earlier step stopped the scenario (clean-up). */
  readonly always?: boolean;
  /** A check: when it fails, the checks after it still run. */
  readonly check?: boolean;
}

/** Thrown by a check whose clean-up could not put the project back: the checks after it would be unsound. */
class Unrestored extends Error {}

interface CheckFrame {
  /** The project as it was before the check wrote anything. */
  readonly before: ProjectState;
  /** The undoId of the write that took effect, recorded before anything else is read from its result. */
  undoId: string | undefined;
  /** The fields its results reported that the scenario does not read back. */
  readonly unread: Set<string>;
}

/** The message of anything that ended a step, without letting an object stringify as `[object Object]`. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'an unknown error';
  }
}

/** The undoId of a write result; throws with the reason when it carries none. */
export function undoIdOf(result: Json): string {
  const undo = result.undo;
  if (!isObject(undo)) throw new Error('its result has no undo block');
  if (undo.undoable !== true) {
    const reason = typeof undo.reason === 'string' ? ` (${undo.reason})` : '';
    throw new Error(`its result says it cannot be undone${reason}`);
  }
  if (typeof undo.undoId !== 'string' || undo.undoId === '') throw new Error('its undo block has no undoId');
  return undo.undoId;
}

/** The revert recipe of a result, or undefined when it carries none. */
export function revertOf(
  result: Json,
): { readonly method: string; readonly params: Json; readonly requiresConsent: boolean } | undefined {
  const undo = result.undo;
  if (!isObject(undo)) return undefined;
  const revert = undo.revert;
  if (!isObject(revert)) return undefined;
  const method = typeof revert.method === 'string' ? revert.method : undefined;
  const params = isObject(revert.params) ? revert.params : undefined;
  if (method === undefined || params === undefined) return undefined;
  return { method, params, requiresConsent: revert.requiresConsent === true };
}

/** The applied split position from a result's SPLIT_SNAPPED warning, else the requested one. */
export function appliedSplitOf(
  result: Json,
  requestedTimelineSec: number,
): { readonly appliedTimelineSec: number; readonly snapped: boolean; readonly reportedRequested: number | null } {
  const warnings = result.warnings;
  if (Array.isArray(warnings)) {
    for (const warning of warnings as unknown[]) {
      if (!isObject(warning) || warning.code !== 'SPLIT_SNAPPED') continue;
      const data = warning.data;
      if (!isObject(data) || typeof data.appliedTimelineSec !== 'number') continue;
      return {
        appliedTimelineSec: data.appliedTimelineSec,
        snapped: true,
        reportedRequested: typeof data.requestedTimelineSec === 'number' ? data.requestedTimelineSec : null,
      };
    }
  }
  return { appliedTimelineSec: requestedTimelineSec, snapped: false, reportedRequested: null };
}

/**
 * The created / removed / idMap entries of a split against a fresh read: exactly the old clip is
 * removed, two new clips are created, the map relates the old one to both, and the two new clips
 * meet at the applied split and together cover the old clip.
 */
export function splitConsistency(
  result: Json,
  state: ProjectState,
  oldClip: PlacementRead,
  appliedTimelineSec: number,
): string[] {
  const problems: string[] = [];
  const idsOf = (list: unknown, entity: string): string[] => {
    if (!Array.isArray(list)) return [];
    const ids: string[] = [];
    for (const raw of list as unknown[]) {
      if (!isObject(raw) || raw.entity !== entity || !isObject(raw.ref)) continue;
      if (typeof raw.ref.placementId === 'string') ids.push(raw.ref.placementId);
    }
    return ids;
  };
  const refIds = (list: unknown): string[] => {
    if (!Array.isArray(list)) return [];
    const ids: string[] = [];
    for (const raw of list as unknown[]) {
      if (isObject(raw) && typeof raw.placementId === 'string') ids.push(raw.placementId);
    }
    return ids;
  };
  const created = idsOf(result.created, 'placement');
  const removed = idsOf(result.removed, 'placement');
  if (removed.length !== 1 || removed[0] !== oldClip.placementId) {
    problems.push(`removed must name the split clip once (it says ${removed.join(', ') || 'nothing'})`);
  }
  if (created.length !== 2) problems.push(`created must name the two new clips (it says ${String(created.length)})`);
  for (const id of created) {
    if (!state.placements.some((p) => p.placementId === id))
      problems.push(`created clip ${id} is not there afterwards`);
  }
  if (state.placements.some((p) => p.placementId === oldClip.placementId)) {
    problems.push(`the split clip ${oldClip.placementId} is still there afterwards`);
  }
  const maps = Array.isArray(result.idMap) ? (result.idMap as unknown[]) : [];
  const splitMaps = maps.filter((m) => isObject(m) && m.relation === 'split' && m.entity === 'placement');
  if (splitMaps.length !== 1) {
    problems.push(`idMap must have one split entry (it has ${String(splitMaps.length)})`);
  } else {
    const map = splitMaps[0];
    if (!isObject(map)) {
      problems.push('the split idMap entry is not an object');
    } else {
      const from = refIds(map.from);
      const to = refIds(map.to);
      if (from.length !== 1 || from[0] !== oldClip.placementId) {
        problems.push(`idMap.from must name the split clip (it says ${from.join(', ') || 'nothing'})`);
      }
      if (to.length !== 2 || !created.every((id) => to.includes(id))) {
        problems.push(`idMap.to must name both new clips (it says ${to.join(', ') || 'nothing'})`);
      }
    }
  }
  const parts = created
    .map((id) => state.placements.find((p) => p.placementId === id))
    .filter((p): p is PlacementRead => p !== undefined);
  if (parts.length === 2) {
    const leading = parts.reduce((a, b) => (a.startTimelineSec <= b.startTimelineSec ? a : b));
    const trailing = parts.find((p) => p !== leading);
    if (trailing === undefined) {
      problems.push('the two created clips cannot be told apart');
    } else {
      if (!same(leading.startTimelineSec, oldClip.startTimelineSec)) {
        problems.push(
          `the leading clip starts at ${String(leading.startTimelineSec)}, not ${String(oldClip.startTimelineSec)}`,
        );
      }
      if (!same(trailing.endTimelineSec, oldClip.endTimelineSec)) {
        problems.push(
          `the trailing clip ends at ${String(trailing.endTimelineSec)}, not ${String(oldClip.endTimelineSec)}`,
        );
      }
      if (!same(leading.endTimelineSec, appliedTimelineSec) || !same(trailing.startTimelineSec, appliedTimelineSec)) {
        problems.push(
          `the clips meet at ${String(leading.endTimelineSec)}/${String(trailing.startTimelineSec)}, ` +
            `not the applied split ${String(appliedTimelineSec)}`,
        );
      }
      if (leading.trackId !== oldClip.trackId || trailing.trackId !== oldClip.trackId) {
        problems.push('the two created clips are not on the track of the split clip');
      }
      // The specification does not say that a split keeps the content: OpenTune gives each part a
      // content of its own (revisionDiff.contents lists them), and a clip then starts at the start of
      // its own content. The source window only continues across the boundary when the content is kept;
      // the audio across the boundary is checked bit for bit against the baseline master.
      if (
        leading.contentId === oldClip.contentId &&
        trailing.contentId === oldClip.contentId &&
        !same(trailing.clipInContentSec, oldClip.clipInContentSec + (appliedTimelineSec - oldClip.startTimelineSec))
      ) {
        problems.push('the trailing clip does not continue the source window where the split clip stopped');
      }
      const covered = leading.durationSec + trailing.durationSec;
      if (!same(covered, oldClip.durationSec)) {
        problems.push(`the two clips cover ${String(covered)} s, not ${String(oldClip.durationSec)} s`);
      }
    }
  }
  return problems.slice(0, 8);
}

/** The two clips a split left on the track of the old clip, leading first; undefined unless exactly two. */
export function splitPartsOf(
  state: ProjectState,
  oldClip: PlacementRead,
): { readonly leading: PlacementRead; readonly trailing: PlacementRead } | undefined {
  const parts = state.placements
    .filter(
      (p) =>
        p.trackId === oldClip.trackId &&
        p.startTimelineSec >= oldClip.startTimelineSec - 1e-6 &&
        p.endTimelineSec <= oldClip.endTimelineSec + 1e-6,
    )
    .sort((a, b) => a.startTimelineSec - b.startTimelineSec);
  const [leading, trailing] = parts;
  return parts.length === 2 && leading !== undefined && trailing !== undefined ? { leading, trailing } : undefined;
}

/** The created / removed / idMap entries of a merge against a fresh read: the two clips became one. */
export function mergeConsistency(
  result: Json,
  state: ProjectState,
  leading: PlacementRead,
  trailing: PlacementRead,
): string[] {
  const problems: string[] = [];
  const idsOf = (list: unknown): string[] => {
    if (!Array.isArray(list)) return [];
    const ids: string[] = [];
    for (const raw of list as unknown[]) {
      if (isObject(raw) && isObject(raw.ref) && typeof raw.ref.placementId === 'string') ids.push(raw.ref.placementId);
    }
    return ids;
  };
  const created = idsOf(result.created);
  const removed = idsOf(result.removed);
  if (created.length !== 1) problems.push(`created must name the merged clip (it says ${String(created.length)})`);
  if (removed.length !== 2 || !removed.includes(leading.placementId) || !removed.includes(trailing.placementId)) {
    problems.push('removed must name both merged clips');
  }
  const merged = created.length === 1 ? state.placements.find((p) => p.placementId === created[0]) : undefined;
  if (merged === undefined) {
    problems.push('the merged clip is not there afterwards');
  } else {
    if (
      !same(merged.startTimelineSec, leading.startTimelineSec) ||
      !same(merged.endTimelineSec, trailing.endTimelineSec)
    ) {
      problems.push('the merged clip does not cover the two merged clips');
    }
    if (merged.trackId !== leading.trackId) {
      problems.push('the merged clip is not on the track of the merged clips');
    }
  }
  const maps = Array.isArray(result.idMap) ? (result.idMap as unknown[]) : [];
  if (!maps.some((m) => isObject(m) && m.relation === 'merge')) problems.push('idMap has no merge entry');
  return problems.slice(0, 8);
}

export async function runArrangementEffects(
  config: ArrangementEffectsConfig,
  hooks: ArrangementEffectsHooks = {},
): Promise<ArrangementEffectsReport> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const target = hooks.target ?? exeTarget(config.exe);
  const timeoutMs = config.stepTimeoutMs;
  const steps: StepReport[] = [];
  const checks: Record<string, unknown> = {};
  const timings: Record<string, unknown> = {};
  const exportTimes: { label: string; ms: number }[] = [];
  const processing = new Map<string, ExportProcessing[]>();
  let sessionHybridMode: boolean | null = null;
  let currentStep = '';
  let halted: string | undefined;
  let instance: TargetInstance | undefined;
  let session: OtcpSession | undefined;
  let hello: HelloInfo | undefined;
  let filesA: ToneFiles | undefined;
  let filesB: ToneFiles | undefined;
  let workDir = '';
  let toneA: Tone | undefined;
  let toneB: Tone | undefined;
  let audio: Record<string, unknown> | null = null;
  let diagnostics: string | null = null;
  let clipAId = '';
  let clipBId = '';
  let contentAId = '';
  let trackAId = -1;
  let trackBId = -1;
  let baseline: DecodedWav | undefined;
  let exportCount = 0;
  target.labelNext?.('arrangement-effects');

  const scrub = (text: string) => scrubText(text, { workDir });

  /** Keeps what an export result says about its processing for the current step. */
  const recordProcessing = (label: string, result: unknown) => {
    const p = member(result, 'processing', 'the export result');
    const entry: ExportProcessing = {
      export: label,
      vocoderWeight: isObject(p) && typeof p.vocoderWeight === 'string' ? p.vocoderWeight : null,
      hybridMode: isObject(p) && typeof p.hybridMode === 'boolean' ? p.hybridMode : null,
      backend: isObject(p) && typeof p.backend === 'string' ? p.backend : null,
      tuningHz: isObject(p) && typeof p.tuningHz === 'number' ? p.tuningHz : null,
    };
    const list = processing.get(currentStep) ?? [];
    list.push(entry);
    processing.set(currentStep, list);
  };

  const step = async (name: string, body: () => Promise<string>, options: StepOptions = {}) => {
    if (halted !== undefined && options.always !== true) {
      steps.push({ name, result: 'SKIP', ms: 0, note: `not run: ${halted}` });
      return;
    }
    currentStep = name;
    const at = performance.now();
    try {
      const note = await body();
      steps.push({ name, result: 'PASS', ms: performance.now() - at, note: scrub(note) });
    } catch (error) {
      const classified = classify(error);
      let note = scrub(classified.note);
      if (isModalBusy(error)) {
        diagnostics = await busyDiagnostics(session);
        note = `${note}; ${diagnostics}`;
      }
      steps.push({ name, result: classified.result, ms: performance.now() - at, note });
      if (options.check !== true || error instanceof Unrestored) halted ??= `${name} ended with ${classified.result}`;
    }
  };

  const need = (): OtcpSession => {
    if (session === undefined) throw new Error('no session');
    return session;
  };

  const has = (capability: string): boolean => hello?.capabilities.includes(capability) === true;

  /** Exports the master mix, reads the float32 WAV back and records its processing. */
  const exportMaster = async (label: string) => {
    const file = path.join(workDir, `arrangement-${String(++exportCount)}-${label.replace(/[^a-z0-9]+/gi, '-')}.wav`);
    const at = performance.now();
    const result = await runJob(
      need(),
      'export.start',
      { kind: 'master', path: file, ifExists: 'error' },
      'export',
      timeoutMs,
    );
    exportTimes.push({ label, ms: Math.round(performance.now() - at) });
    recordProcessing(label, result);
    const exportedPath = text(result, 'path', 'the export result');
    if (path.resolve(exportedPath).toLowerCase() !== path.resolve(file).toLowerCase())
      throw new Error(`the ${label} export result names another file than the one asked for`);
    const wav = decodeWav(await readFile(exportedPath));
    const reportedRate = num(result, 'sampleRateHz', 'the export result');
    const reportedChannels = num(result, 'channelCount', 'the export result');
    const reportedDuration = num(result, 'durationSec', 'the export result');
    const reportedStart = num(result, 'startTimelineSec', 'the export result');
    if (wav.sampleRateHz !== reportedRate) throw new Error(`the ${label} export has another sample rate than reported`);
    if (wav.channels.length !== reportedChannels) {
      throw new Error(
        `the ${label} export has ${String(wav.channels.length)} channels, reported ${String(reportedChannels)}`,
      );
    }
    const duration = wav.mono.length / wav.sampleRateHz;
    if (Math.abs(duration - reportedDuration) > 1 / wav.sampleRateHz + TIMELINE_EPSILON_SEC) {
      throw new Error(`the ${label} export is ${duration.toFixed(6)} s, reported ${String(reportedDuration)} s`);
    }
    if (Math.abs(reportedStart) > TIMELINE_EPSILON_SEC) {
      throw new Error(`the ${label} master starts at ${String(reportedStart)} s, not 0`);
    }
    if (peakOf(wav) <= 1e-4) throw new Error(`the ${label} export is silent`);
    const dry = member(result, 'dryContents', 'the export result');
    if (!Array.isArray(dry)) throw new Error('dryContents is not an array');
    return { wav, result, dry: dry.length };
  };

  /** A write that must have taken effect; returns the result and the project read right after it. */
  const write = async (
    method: 'arrangement.edit' | 'track.set',
    params: Json,
    options: { readonly frame?: CheckFrame; readonly undoable?: boolean } = {},
  ) => {
    const result = await need().call(method, params, 60_000);
    if (result.applied === false || result.dryRun === true) {
      throw new Error(`${method} changed nothing (applied ${String(result.applied)}, dryRun ${String(result.dryRun)})`);
    }
    if (options.undoable === true && options.frame !== undefined) {
      try {
        options.frame.undoId = undoIdOf(result);
      } catch (error) {
        throw new Unrestored(
          `${method} took effect, but ${error instanceof Error ? error.message : String(error)}: ` +
            'the check cannot take it back, and the checks after it would run on a changed project',
        );
      }
    }
    const state = await readProject(need());
    const consistency = writeConsistency(result, state);
    for (const field of consistency.unreadFields) options.frame?.unread.add(field);
    return { result, state, consistency };
  };

  /** Exports the master and compares it with the baseline; the result is a check problem or empty. */
  const compareWithBaseline = async (label: string, problems: string[], what: string) => {
    if (baseline === undefined) throw new Error('no baseline');
    const after = await exportMaster(label);
    const cmp = wholeFileComparison(baseline, after.wav);
    if (!cmp.bitIdentical) {
      problems.push(
        `${what} differs from the baseline by up to ${cmp.maxAbsDiff.toExponential(2)}` +
          (cmp.lengthsEqual ? '' : ' and has another length'),
      );
    }
    return { ...cmp, dry: after.dry };
  };

  /** Takes a write back with edit.undo and verifies the project, then the master. */
  const undoAndVerify = async (frame: CheckFrame): Promise<string[]> => {
    if (frame.undoId === undefined) throw new Error('there is no undoId to take the write back with');
    const result = await need().call('edit.undo', { expectedUndoId: frame.undoId }, 60_000);
    if (result.applied === false || result.dryRun === true) throw new Error('edit.undo did not apply');
    const state = await readProject(need());
    const left = projectSnapshotProblems(frame.before, state);
    if (left.length > 0) throw new Unrestored(`after edit.undo the project is not as it was: ${left.join('; ')}`);
    frame.undoId = undefined;
    const problems = tokensProblems(result, state).map((p) => `undo: ${p}`);
    try {
      await compareWithBaseline('after undo', problems, 'the master after edit.undo');
    } catch (error) {
      // The project is back; a failed export is a problem of the check, not a reason to stop the rest.
      problems.push(`the master after edit.undo could not be exported: ${classify(error).note}`);
    }
    return problems;
  };

  /**
   * A check that writes and takes the write back: snapshot, work, edit.undo and the comparison with
   * the snapshot, also when the work failed half-way (the undoId is recorded first). Any problem,
   * including one of the undo, fails the check; a project the undo did not restore stops the checks
   * after it.
   */
  const undoableCheck = async (
    name: string,
    work: (
      frame: CheckFrame,
    ) => Promise<{ note: string; problems: readonly string[]; report: Record<string, unknown> }>,
  ): Promise<string> => {
    const frame: CheckFrame = { before: await readProject(need()), undoId: undefined, unread: new Set() };
    let outcome: Awaited<ReturnType<typeof work>> | undefined;
    let failure: unknown;
    try {
      outcome = await work(frame);
    } catch (error) {
      failure = error;
    }
    if (failure instanceof Unrestored || failure instanceof StepSkip) throw failure;
    let undoProblems: string[] = [];
    if (frame.undoId !== undefined) {
      try {
        undoProblems = await undoAndVerify(frame);
      } catch (error) {
        checks[name] = {
          ...(outcome?.report ?? {}),
          ...(frame.unread.size === 0 ? {} : { unreadFields: [...frame.unread].sort() }),
          error: scrub(messageOf(error)),
        };
        throw new Unrestored(messageOf(error), { cause: error });
      }
    }
    const unread = frame.unread.size === 0 ? {} : { unreadFields: [...frame.unread].sort() };
    const problems = [...(outcome?.problems ?? []), ...undoProblems];
    checks[name] = {
      ...(outcome?.report ?? {}),
      ...unread,
      ...(undoProblems.length === 0 ? { undoRestored: true } : { undo: undoProblems }),
      ...(failure === undefined ? {} : { error: scrub(messageOf(failure)) }),
    };
    if (failure !== undefined) {
      throw new Error(
        undoProblems.length === 0 ? messageOf(failure) : `${messageOf(failure)}; ${undoProblems.join('; ')}`,
        { cause: failure },
      );
    }
    if (problems.length > 0) throw new Error(problems.join('; '));
    const note = outcome?.note ?? 'checked';
    return frame.unread.size === 0
      ? note
      : `${note}; ${String(frame.unread.size)} reported field(s) not compared, as the scenario does not read them`;
  };

  // --- set-up ---------------------------------------------------------------------------------

  await step('prepare audio', async () => {
    toneA = generateTone({
      seed: 20261101,
      leadSec: 0,
      notes: [{ midi: 60, durationSec: 2.4 }],
      fadeSec: 0.01,
    });
    toneB = generateTone({
      seed: 20261102,
      leadSec: 0,
      notes: [{ midi: 67, durationSec: 2.0 }],
      fadeSec: 0.01,
    });
    filesA = await writeToneFiles(toneA, 'arrangement-a');
    filesB = await writeToneFiles(toneB, 'arrangement-b');
    workDir = filesA.dir;
    const noteA = toneA.truth.notes[0];
    const noteB = toneB.truth.notes[0];
    audio = {
      source: 'generated',
      clipA: {
        seconds: round(toneA.truth.durationSec, 3),
        soundSeconds: noteA === undefined ? null : round(noteA.endSec - noteA.startSec, 3),
        midi: 60,
      },
      clipB: {
        seconds: round(toneB.truth.durationSec, 3),
        soundSeconds: noteB === undefined ? null : round(noteB.endSec - noteB.startSec, 3),
        midi: 67,
      },
    };
    return `generated: clip A ${toneA.truth.durationSec.toFixed(1)} s at MIDI 60, clip B ${toneB.truth.durationSec.toFixed(1)} s at MIDI 67`;
  });

  await step('launch', async () => {
    const at = performance.now();
    instance = await target.open();
    timings.launchToReadyMs = Math.round(performance.now() - at);
    return 'discovery file read, launch nonce and own hello checked';
  });

  await step('hello', async () => {
    if (instance === undefined) throw new Error('no instance');
    const entry = parseDiscoveryFile(
      `${String(instance.discovery.pid)}.json`,
      Buffer.from(JSON.stringify(instance.discovery), 'utf8'),
    );
    if (!entry.ok) throw new Error(`the discovery file is not valid: ${entry.problem}`);
    session = await OtcpSession.open(entry.entry, 15_000);
    hello = session.hello;
    const missing = BASE_CAPABILITIES.filter((c) => !has(c));
    if (missing.length > 0) {
      throw new StepSkip('SKIP', `the instance does not report ${missing.join(', ')}, which the scenario needs`);
    }
    const info = await need().call('session.info', {}, 30_000);
    const reported = member(info, 'processing', 'session.info');
    const hybrid = isObject(reported) ? reported.hybridMode : undefined;
    sessionHybridMode = typeof hybrid === 'boolean' ? hybrid : null;
    return `protocol ${hello.protocol}; ${String(hello.capabilities.length)} capabilit(ies); hybrid mode ${
      sessionHybridMode === null ? 'not reported' : sessionHybridMode ? 'on' : 'off'
    }`;
  });

  await step('import and analysis', async () => {
    const s = need();
    const initial = await readProject(s);
    if (initial.placements.length > 0) {
      throw new Error(
        `the project already holds ${String(initial.placements.length)} clip(s); the scenario needs an empty project`,
      );
    }
    if (filesA === undefined || filesB === undefined) throw new Error('the audio was not written');
    const importOne = async (file: string, startTimelineSec: number, label: string) => {
      const at = performance.now();
      const result = await runJob(
        s,
        'import.start',
        { items: [{ path: file }], layout: 'single', generateNotes: true, newTrack: true, startTimelineSec },
        'import',
        timeoutMs,
      );
      const items = member(result, 'items', 'the import result');
      const item: unknown = Array.isArray(items) ? (items as unknown[])[0] : undefined;
      if (!isObject(item) || item.imported !== true) throw new Error(`clip ${label} was not imported`);
      const contentId = text(item, 'contentId', 'the import item');
      const placementId = text(item, 'placementId', 'the import item');
      const trackId = num(item, 'trackId', 'the import item');
      const durationSec = num(item, 'durationSec', 'the import item');
      await waitForAnalysis(s, contentId, timeoutMs);
      return {
        contentId,
        placementId,
        trackId,
        durationSec,
        ms: Math.round(performance.now() - at),
      };
    };
    const a = await importOne(filesA.wavPath, 0, 'A');
    const bStart = round(a.durationSec + 1, 3);
    const b = await importOne(filesB.wavPath, bStart, 'B');
    clipAId = a.placementId;
    clipBId = b.placementId;
    contentAId = a.contentId;
    trackAId = a.trackId;
    trackBId = b.trackId;
    timings.importToF0ReadyMs = [a.ms, b.ms];
    const state = await readProject(s);
    let clipA = placementOf(state, clipAId);
    let clipB = placementOf(state, clipBId);
    if (clipA.trackId === clipB.trackId) throw new Error('the two clips are on one track');
    if (Math.abs(clipA.startTimelineSec) > TIMELINE_EPSILON_SEC) {
      throw new Error(`clip A starts at ${String(clipA.startTimelineSec)} s, not 0`);
    }
    if (clipB.startTimelineSec < clipA.endTimelineSec + 1 - TIMELINE_EPSILON_SEC) {
      throw new Error(
        `clip B starts at ${String(clipB.startTimelineSec)} s, less than 1 s after clip A ends at ${String(clipA.endTimelineSec)} s`,
      );
    }
    // The generated tone has 0.1 s of silence after its note; trim it away so a fade-out of 0.5 s
    // ends where the sound ends. Without arrangement.v1 the tails stay, and the checks that need a
    // fade or a split skip themselves.
    let trim: Record<string, unknown> | null = null;
    if (has('arrangement.v1')) {
      if (toneA === undefined || toneB === undefined) throw new Error('no tone');
      const noteA = toneA.truth.notes[0];
      const noteB = toneB.truth.notes[0];
      if (noteA === undefined || noteB === undefined) throw new Error('the tones have no notes');
      const endA = round(clipA.startTimelineSec + (noteA.endSec - clipA.clipInContentSec), 6);
      const endB = round(clipB.startTimelineSec + (noteB.endSec - clipB.clipInContentSec), 6);
      if (endA <= clipA.startTimelineSec || endB <= clipB.startTimelineSec) {
        throw new Error('the generated notes do not lie inside the imported clips');
      }
      const trimmed = await write('arrangement.edit', {
        expectedArrangementRevision: state.arrangementRevision,
        ops: [
          { op: 'trim', placementId: clipAId, edge: 'end', toTimelineSec: endA },
          { op: 'trim', placementId: clipBId, edge: 'end', toTimelineSec: endB },
        ],
      });
      const problems = [...trimmed.consistency.problems];
      clipA = placementOf(trimmed.state, clipAId);
      clipB = placementOf(trimmed.state, clipBId);
      if (!same(clipA.endTimelineSec, endA)) {
        problems.push(`clip A ends at ${String(clipA.endTimelineSec)} s, not ${String(endA)} s`);
      }
      if (!same(clipB.endTimelineSec, endB)) {
        problems.push(`clip B ends at ${String(clipB.endTimelineSec)} s, not ${String(endB)} s`);
      }
      if (problems.length > 0) throw new Error(problems.join('; '));
      trim = {
        clipAEndSec: endA,
        clipBEndSec: endB,
        gapSec: round(clipB.startTimelineSec - clipA.endTimelineSec, 3),
      };
    }
    checks['import and analysis'] = {
      tracks: { clipA: trackAId, clipB: trackBId },
      ...(trim === null ? { untrimmed: 'no arrangement.v1' } : { trim }),
    };
    const gap = clipB.startTimelineSec - clipA.endTimelineSec;
    return `two clips on tracks ${String(trackAId)} and ${String(trackBId)}, analysis ready; ${
      trim === null ? 'silent tails kept (no arrangement.v1)' : 'trimmed to their notes'
    }; clip B starts ${String(round(gap, 2))} s after clip A`;
  });

  await step('baseline master export', async () => {
    const first = await exportMaster('baseline');
    baseline = first.wav;
    const seconds = first.wav.mono.length / first.wav.sampleRateHz;
    if (!(seconds > 0)) throw new Error('the baseline export is empty');
    checks['baseline master export'] = {
      seconds: round(seconds, 3),
      sampleRateHz: first.wav.sampleRateHz,
      channels: first.wav.channels.length,
      dryContents: first.dry,
    };
    return `${seconds.toFixed(2)} s, ${String(first.wav.sampleRateHz)} Hz, ${String(
      first.wav.channels.length,
    )} ch, dry ${String(first.dry)} content(s)`;
  });

  // --- checks ---------------------------------------------------------------------------------

  await step(
    'clip gain -6 dB',
    async () =>
      undoableCheck('clip gain -6 dB', async (frame) => {
        if (!has('arrangement.v1')) throw new StepSkip('SKIP', 'the instance does not report arrangement.v1');
        if (!has('history.v1'))
          throw new StepSkip('SKIP', 'the instance does not report history.v1, which edit.undo needs');
        if (baseline === undefined) throw new Error('no baseline');
        const beforeClip = placementOf(frame.before, clipAId);
        if (beforeClip.gainDb === null || !Number.isFinite(beforeClip.gainDb)) {
          throw new Error('clip A has no finite gainDb to take 6 dB off');
        }
        const wantedGainDb = round(beforeClip.gainDb + GAIN_CHANGE_DB, 4);
        const { result, state, consistency } = await write(
          'arrangement.edit',
          {
            expectedArrangementRevision: frame.before.arrangementRevision,
            ops: [{ op: 'setGain', placementId: clipAId, gainDb: wantedGainDb }],
          },
          { frame, undoable: true },
        );
        const problems = [...consistency.problems];
        const afterClip = placementOf(state, clipAId);
        if (!same(afterClip.gainDb, wantedGainDb)) {
          problems.push(`clip A gain reads back ${String(afterClip.gainDb)}, not ${String(wantedGainDb)}`);
        }
        const changedGain = Array.isArray(result.changes)
          ? (result.changes as unknown[]).some(
              (c) =>
                isObject(c) &&
                c.entity === 'placement' &&
                isObject(c.ref) &&
                c.ref.placementId === clipAId &&
                isObject(c.fields) &&
                (Object.hasOwn(c.fields, 'gainDb') || Object.hasOwn(c.fields, 'gainLinear')),
            )
          : false;
        if (!changedGain) problems.push('its changes do not report the clip gain');
        const wet = await exportMaster('gain -6 dB');
        const regionA = clipSpan(afterClip);
        const regionB = clipSpan(placementOf(state, clipBId));
        const baselineRms = rmsOf(baseline, regionA);
        const wetRms = rmsOf(wet.wav, regionA);
        const measuredDb = levelRatioDb(baselineRms, wetRms);
        if (measuredDb === null) {
          problems.push('clip A is silent in the baseline but not in the export');
        } else if (Math.abs(measuredDb - GAIN_CHANGE_DB) > GAIN_TOLERANCE_DB) {
          problems.push(
            `clip A changed by ${String(round(measuredDb))} dB, expected ${String(GAIN_CHANGE_DB)} +- ${String(
              GAIN_TOLERANCE_DB,
            )} dB`,
          );
        }
        const clipB = compareSamples(baseline, wet.wav, [regionB]);
        if (clipB.bitIdentical !== 1) {
          problems.push(`clip B differs from the baseline by up to ${clipB.maxAbsDiff.toExponential(2)}`);
        }
        return {
          note:
            `clip A ${String(round(measuredDb ?? Number.NaN, 1))} dB (expected ${String(GAIN_CHANGE_DB)} dB); ` +
            `clip B bit-identical; undo restored the clip and the master`,
          problems,
          report: {
            expectedDb: GAIN_CHANGE_DB,
            toleranceDb: GAIN_TOLERANCE_DB,
            requestedGainDb: wantedGainDb,
            measuredDb: measuredDb === null ? null : round(measuredDb, 2),
            baselineRms: round(baselineRms, 6),
            wetRms: round(wetRms, 6),
            clipB: { bitIdentical: clipB.bitIdentical === 1, maxAbsDiff: clipB.maxAbsDiff },
            consistency: consistency.problems,
          },
        };
      }),
    { check: true },
  );

  await step(
    'fades are ramps',
    async () =>
      undoableCheck('fades are ramps', async (frame) => {
        if (!has('arrangement.v1')) throw new StepSkip('SKIP', 'the instance does not report arrangement.v1');
        if (!has('history.v1'))
          throw new StepSkip('SKIP', 'the instance does not report history.v1, which edit.undo needs');
        if (baseline === undefined) throw new Error('no baseline');
        const { result, state, consistency } = await write(
          'arrangement.edit',
          {
            expectedArrangementRevision: frame.before.arrangementRevision,
            ops: [{ op: 'setFade', placementId: clipAId, fadeInSec: FADE_SEC, fadeOutSec: FADE_SEC }],
          },
          { frame, undoable: true },
        );
        const problems = [...consistency.problems];
        const afterClip = placementOf(state, clipAId);
        const clamped =
          Array.isArray(result.warnings) &&
          (result.warnings as unknown[]).some((w) => isObject(w) && w.code === 'CLAMPED');
        if (!(afterClip.fadeInSec > 0) || !(afterClip.fadeOutSec > 0)) {
          problems.push('the instance applied no fade to clip A');
        }
        if (afterClip.fadeInSec + afterClip.fadeOutSec > afterClip.durationSec + TIMELINE_EPSILON_SEC) {
          problems.push('the two fades are longer than clip A');
        }
        const changedFades = Array.isArray(result.changes)
          ? (result.changes as unknown[]).some(
              (c) =>
                isObject(c) &&
                c.entity === 'placement' &&
                isObject(c.ref) &&
                c.ref.placementId === clipAId &&
                isObject(c.fields) &&
                (Object.hasOwn(c.fields, 'fadeInSec') || Object.hasOwn(c.fields, 'fadeOutSec')),
            )
          : false;
        if (!changedFades) problems.push('its changes do not report the fades');
        const wet = await exportMaster('fades');
        const spanA = clipSpan(afterClip);
        const fadeIn = measureFade(baseline, wet.wav, spanA, afterClip.fadeInSec, 'in');
        const fadeOut = measureFade(baseline, wet.wav, spanA, afterClip.fadeOutSec, 'out');
        problems.push(...fadeIn.problems.map((p) => `fade-in: ${p}`), ...fadeOut.problems.map((p) => `fade-out: ${p}`));
        const between: Span = {
          startSec: spanA.startSec + afterClip.fadeInSec + FADE_GUARD_SEC,
          endSec: spanA.endSec - afterClip.fadeOutSec - FADE_GUARD_SEC,
        };
        const regionB = clipSpan(placementOf(state, clipBId));
        const spans = between.endSec > between.startSec ? [between, regionB] : [regionB];
        const unchanged = compareSamples(baseline, wet.wav, spans);
        if (unchanged.bitIdentical !== spans.length) {
          problems.push(
            `the part between the fades or clip B differs from the baseline by up to ${unchanged.maxAbsDiff.toExponential(2)}`,
          );
        }
        return {
          note:
            `fade-in ${String(fadeIn.edgeDb === null ? 'unmeasured' : round(fadeIn.edgeDb, 1))} dB at its first window, ` +
            `fade-out ${String(fadeOut.edgeDb === null ? 'unmeasured' : round(fadeOut.edgeDb, 1))} dB at its last; ` +
            `${String(spans.length)} span(s) bit-identical; undo restored the clip and the master`,
          problems,
          report: {
            requestedFadeSec: FADE_SEC,
            clamped,
            fadeInSec: afterClip.fadeInSec,
            fadeOutSec: afterClip.fadeOutSec,
            tolerance: {
              startMaxDb: FADE_START_MAX_DB,
              endMaxDb: FADE_END_MAX_DB,
              edgeDb: FADE_END_TOLERANCE_DB,
              monotonicSlackDb: FADE_MONOTONIC_SLACK_DB,
              windowSec: FADE_WINDOW_SEC,
            },
            fadeIn: {
              edgeDb: fadeIn.edgeDb,
              edgeWindowIndex: fadeIn.edgeWindowIndex,
              edgeLevelDb: fadeIn.edgeLevelDb,
              fractions: fadeIn.fractions,
              violations: fadeIn.monotonicViolations,
              silentWindows: fadeIn.silentWindows,
            },
            fadeOut: {
              edgeDb: fadeOut.edgeDb,
              edgeWindowIndex: fadeOut.edgeWindowIndex,
              edgeLevelDb: fadeOut.edgeLevelDb,
              fractions: fadeOut.fractions,
              violations: fadeOut.monotonicViolations,
              silentWindows: fadeOut.silentWindows,
            },
            unchanged: {
              bitIdentical: unchanged.bitIdentical,
              spans: spans.length,
              maxAbsDiff: unchanged.maxAbsDiff,
            },
            consistency: consistency.problems,
          },
        };
      }),
    { check: true },
  );

  await step(
    'mute and solo in the master export',
    async () => {
      if (!has('tracks.v1')) throw new StepSkip('SKIP', 'the instance does not report tracks.v1');
      if (baseline === undefined) throw new Error('no baseline');
      const base = baseline;
      const s = need();
      const before = await readProject(s);
      const clipA = placementOf(before, clipAId);
      const clipB = placementOf(before, clipBId);
      const regionA = clipSpan(clipA);
      const regionB = clipSpan(clipB);
      const trackA = clipA.trackId;
      const trackB = clipB.trackId;
      if (trackA === trackB) throw new Error('the two clips are on one track');
      const problems: string[] = [];
      const cases: Record<string, unknown>[] = [];

      const runCase = async (
        label: string,
        setting: Json,
        silent: Span,
        identical: Span,
        expected: { readonly muted: readonly number[]; readonly solo: readonly number[] },
      ) => {
        const { result, state, consistency } = await write('track.set', setting);
        problems.push(...consistency.problems.map((p) => `${label}: ${p}`));
        // The write took effect: whatever goes wrong while measuring, the revert below still runs, so
        // that a later check does not meet muted or soloed tracks.
        let measureFailure: unknown;
        let silentRegion: ReturnType<typeof silenceOf> | undefined;
        let other: ReturnType<typeof compareSamples> | undefined;
        try {
          for (const trackId of expected.muted) {
            if (!trackOf(state, trackId).muted) problems.push(`${label}: track ${String(trackId)} is not muted`);
          }
          for (const trackId of expected.solo) {
            if (!trackOf(state, trackId).solo) problems.push(`${label}: track ${String(trackId)} is not soloed`);
          }
          const wet = await exportMaster(label);
          silentRegion = silenceOf(wet.wav, silent);
          if (silentRegion.maxAbs > SILENCE_MAX_ABS) {
            problems.push(
              `${label}: the clip that should be silent still reaches ${silentRegion.maxAbs.toExponential(2)}`,
            );
          }
          other = compareSamples(base, wet.wav, [identical]);
          if (other.bitIdentical !== 1) {
            problems.push(
              `${label}: the remaining clip differs from the baseline by up to ${other.maxAbsDiff.toExponential(2)}`,
            );
          }
        } catch (error) {
          measureFailure = error;
        }
        const revert = revertOf(result);
        if (revert === undefined) {
          throw new Unrestored(`${label}: track.set returned no revert recipe, so the check cannot restore the tracks`);
        }
        if (revert.requiresConsent) {
          throw new Unrestored(`${label}: the revert recipe needs consent, which the scenario cannot give`);
        }
        let reverted: Json;
        try {
          reverted = await s.call(revert.method, revert.params, 60_000);
        } catch (error) {
          throw new Unrestored(`${label}: the revert failed: ${classify(error).note}`, { cause: error });
        }
        if (reverted.applied === false || reverted.dryRun === true) {
          throw new Unrestored(`${label}: the revert did not apply`);
        }
        const afterRevert = await readProject(s);
        const left = projectSnapshotProblems(before, afterRevert);
        if (left.length > 0)
          throw new Unrestored(`${label}: after the revert the project is not as it was: ${left.join('; ')}`);
        if (
          trackOf(afterRevert, trackA).muted ||
          trackOf(afterRevert, trackB).muted ||
          trackOf(afterRevert, trackA).solo ||
          trackOf(afterRevert, trackB).solo
        ) {
          throw new Unrestored(`${label}: after the revert the old mute/solo values are not back`);
        }
        if (measureFailure !== undefined || silentRegion === undefined || other === undefined) {
          // Restored; the failure is the check's own, so the later checks still run.
          throw new Error(`${label}: ${messageOf(measureFailure)}`, { cause: measureFailure });
        }
        const afterMaster = await compareWithBaseline(
          `after ${label} revert`,
          problems,
          `the master after the ${label} revert`,
        );
        cases.push({
          case: label,
          tracks: state.tracks.map((t) => ({ trackId: t.trackId, muted: t.muted, solo: t.solo, audible: t.audible })),
          silent: { ...silentRegion, maxAbs: silentRegion.maxAbs },
          other: { bitIdentical: other.bitIdentical === 1, maxAbsDiff: other.maxAbsDiff },
          revert: {
            method: revert.method,
            applied: true,
            projectRestored: true,
            master: { bitIdentical: afterMaster.bitIdentical, maxAbsDiff: afterMaster.maxAbsDiff },
          },
        });
      };

      await runCase('mute track 2', { tracks: [{ trackId: trackB, muted: true }] }, regionB, regionA, {
        muted: [trackB],
        solo: [],
      });
      await runCase('solo track 1', { tracks: [{ trackId: trackA, solo: true }] }, regionB, regionA, {
        muted: [],
        solo: [trackA],
      });
      await runCase('solo track 2', { tracks: [{ trackId: trackB, solo: true }] }, regionA, regionB, {
        muted: [],
        solo: [trackB],
      });
      checks['mute and solo in the master export'] = {
        tracks: { clipA: trackA, clipB: trackB },
        silenceMaxAbs: SILENCE_MAX_ABS,
        cases,
      };
      if (problems.length > 0) throw new Error(problems.join('; '));
      return `mute track ${String(trackB)}, solo track ${String(trackA)} and solo track ${String(
        trackB,
      )} silence the other clip; each revert restored the tracks and the master`;
    },
    { check: true },
  );

  await step(
    'split boundary is seamless',
    async () => {
      if (!has('arrangement.v1')) throw new StepSkip('SKIP', 'the instance does not report arrangement.v1');
      if (baseline === undefined) throw new Error('no baseline');
      const s = need();
      const before = await readProject(s);
      const oldClip = placementOf(before, clipAId);
      const notes = await readNotes(s, contentAId);
      const splitAt = splitPointOf(oldClip, notes);
      if (splitAt === undefined) {
        throw new StepSkip('SKIP', 'clip A has no voiced note long enough to split inside');
      }
      const requested = round(splitAt + SPLIT_OFFSET_SEC, 6);
      const { result, state, consistency } = await write('arrangement.edit', {
        expectedArrangementRevision: before.arrangementRevision,
        ops: [{ op: 'split', placementId: clipAId, atTimelineSec: requested }],
      });
      const problems = [...consistency.problems];
      const applied = appliedSplitOf(result, requested);
      if (applied.snapped) {
        if (applied.reportedRequested !== null && !same(applied.reportedRequested, requested)) {
          problems.push(
            `SPLIT_SNAPPED reports a requested position of ${String(applied.reportedRequested)}, not ${String(requested)}`,
          );
        }
        if (!(
          applied.appliedTimelineSec > oldClip.startTimelineSec && applied.appliedTimelineSec < oldClip.endTimelineSec
        )) {
          problems.push(`the applied split ${String(applied.appliedTimelineSec)} is not inside clip A`);
        }
      }
      problems.push(...splitConsistency(result, state, oldClip, applied.appliedTimelineSec));
      const wet = await exportMaster('split');
      const difference = maxDifference(baseline, wet.wav, applied.appliedTimelineSec);
      if (!difference.bitIdentical) {
        problems.push(
          `the master differs from the baseline by up to ${difference.maxAbsDiff.toExponential(2)} at ` +
            `${String(difference.timeSec)} s, ${String(difference.distanceFromSplitSec)} s from the split`,
        );
      }
      const revert = revertOf(result);
      let merge: Record<string, unknown> | undefined;
      if (revert === undefined) {
        merge = { refused: 'the result gives no revert recipe' };
      } else if (revert.requiresConsent) {
        merge = { refused: 'the revert recipe needs consent' };
      } else {
        let reply: Json | undefined;
        try {
          reply = await s.call(revert.method, revert.params, 60_000);
        } catch (error) {
          // A merge the instance refuses is information, not a failure: the split is the last check.
          merge = { refused: classify(error).note };
        }
        if (reply === undefined) {
          merge ??= { refused: 'the merge call failed' };
        } else if (reply.applied === false || reply.dryRun === true) {
          merge = { refused: 'the merge was not applied' };
        } else {
          // From here the merge took effect: a read or an export that fails is a failure of the check,
          // not a refused merge.
          try {
            const afterMerge = await readProject(s);
            const splitParts = splitPartsOf(state, oldClip);
            if (splitParts === undefined) {
              merge = { refused: 'the two split clips cannot be found for the merge check' };
            } else {
              // The merge is the clean-up of a split, not a check of its own: how it reports itself
              // is written to the report, while only the audio it restores can fail the check.
              const mergeConsistencyProblems = mergeConsistency(
                reply,
                afterMerge,
                splitParts.leading,
                splitParts.trailing,
              );
              const afterMergeMaster = await exportMaster('after merge');
              const cmp = wholeFileComparison(baseline, afterMergeMaster.wav);
              if (!cmp.bitIdentical) {
                problems.push(
                  `after the merge the master differs from the baseline by up to ${cmp.maxAbsDiff.toExponential(2)}`,
                );
              }
              merge = {
                applied: true,
                method: revert.method,
                bitIdentical: cmp.bitIdentical,
                maxAbsDiff: cmp.maxAbsDiff,
                lengthsEqual: cmp.lengthsEqual,
                consistency: mergeConsistencyProblems,
              };
            }
          } catch (error) {
            problems.push(`the merge was applied, but checking its result failed: ${messageOf(error)}`);
            merge = { applied: true, method: revert.method, checkFailed: messageOf(error) };
          }
        }
      }
      checks['split boundary is seamless'] = {
        requestedTimelineSec: requested,
        appliedTimelineSec: applied.appliedTimelineSec,
        snapped: applied.snapped,
        difference,
        merge,
        consistency: consistency.problems,
      };
      if (problems.length > 0) throw new Error(problems.join('; '));
      const snap = applied.snapped ? ` (snapped to ${String(applied.appliedTimelineSec)} s)` : '';
      const mergeNote =
        merge.applied === true
          ? `the merge was applied and the master equals the baseline again`
          : `the merge was refused: ${String(merge.refused)}`;
      return `split at ${String(applied.appliedTimelineSec)} s${snap}; the master stayed bit-identical; ${mergeNote}`;
    },
    { check: true },
  );

  await step(
    'shutdown',
    async () => {
      session?.close();
      if (instance === undefined) return 'nothing was started';
      await instance.close();
      const problems = target.takeProblems();
      if (problems.length > 0) throw new Error(problems.join('; '));
      return target.takeDataDirs === undefined || config.exe.dataDirParent === undefined
        ? 'stopped, data folder removed'
        : 'stopped, data folder kept (see dataDir of the report)';
    },
    { always: true },
  );
  await filesA?.cleanup();
  await filesB?.cleanup();
  const dataDir = target.takeDataDirs?.()[0] ?? null;
  timings.exports = exportTimes;

  const finalBackend = [...processing.values()].flat();
  const reported = [sessionHybridMode, ...finalBackend.map((p) => p.hybridMode)].filter(
    (v): v is boolean => v !== null,
  );
  const hybridMode = reported.length === 0 ? null : reported.includes(true);
  for (const [name, list] of processing) {
    const report = checks[name];
    checks[name] = { ...(isObject(report) ? report : {}), processing: list };
  }

  return {
    schema: 'opentune-mcp-e2e-arrangement-effects/1',
    ...summarise(steps),
    hybridMode,
    dataTemplateFrom: config.dataTemplateFrom ?? null,
    startedAt,
    totalMs: Math.round(performance.now() - started),
    steps: steps.map((st) => ({ ...st, ms: Math.round(st.ms) })),
    instance:
      hello === undefined
        ? null
        : { protocol: hello.protocol, appVersion: hello.appVersion, capabilities: hello.capabilities },
    audio,
    tolerances: {
      gainDb: GAIN_CHANGE_DB,
      gainToleranceDb: GAIN_TOLERANCE_DB,
      fadeSec: FADE_SEC,
      fadeWindowSec: FADE_WINDOW_SEC,
      fadeStartMaxDb: FADE_START_MAX_DB,
      fadeEndMaxDb: FADE_END_MAX_DB,
      fadeEndToleranceDb: FADE_END_TOLERANCE_DB,
      fadeMonotonicSlackDb: FADE_MONOTONIC_SLACK_DB,
      fadeGuardSec: FADE_GUARD_SEC,
      signalFloorRms: SIGNAL_FLOOR_RMS,
      silenceMaxAbs: SILENCE_MAX_ABS,
      timelineEpsilonSec: TIMELINE_EPSILON_SEC,
      splitOffsetSec: SPLIT_OFFSET_SEC,
    },
    checks,
    timings,
    dataDir,
    templateSkipped: target.stats?.templateSkipped ?? null,
    busyDiagnostics: diagnostics,
  };
}
