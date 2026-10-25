// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The arrangement effects scenario against a started OpenTune executable: it proves that what an
// arrangement or track write reports is what the instance then holds, and that the write changed the
// exported master mix exactly as it says and nothing else. It does not judge how the audio sounds.
//
// Checks, each against a baseline master export of the same two clips (clip A at 0 to 2.4 s on track
// 0, clip B at 3.6 to 5.6 s on track 1). Every check puts the project back and the export after it
// must equal the baseline bit for bit:
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
// - Move. op move takes clip B MOVE_DELTA_SEC later; the envelope cross-correlation of the old clip B
//   region against the new one reads that shift within MOVE_SHIFT_TOLERANCE_SEC, the old place is
//   silent and the new place holds the baseline's clip B samples (SHIFTED_MAX_ABS_DIFF), at a start
//   within POSITION_QUANTUM_SAMPLES of the named one. Undo as above.
// - Trim. op trim cuts TRIM_CUT_SEC off the end of clip A; the master is silent after the new end and
//   bit-identical before it. Undo as above.
// - Copy, window and full. `arrangement.copy` puts a copy of clip A COPY_GAP_SEC after the end of the
//   baseline on the same track. The copy sounds as clip A does (SHIFTED_MAX_ABS_DIFF) and the rest is
//   the baseline; the result's created entries are compared with `project.get`. The revert recipe
//   (a delete) is sent with the consent the scenario gives for what it made itself.
// - Delete a copy. A copy the scenario made is deleted with op delete: refused without `confirm`,
//   accepted with it; the master equals the baseline again. The original clip is never deleted.
// - Track volume. `track.set` volumeDb -6 and volumeLinear 0.5 lower the level over the track's clip
//   by 6.02 dB within TRACK_VOLUME_TOLERANCE_DB and leave the other clip bit-identical. The revert
//   recipe restores the volume.
// - Duplicate track, clone and share. `track.duplicate` copies the track of clip A to a hidden slot;
//   the two tracks play the same samples, so the master over clip A is the sum of two equal signals
//   (+6 dB, COHERENT_SUM_TOLERANCE_DB and COHERENT_SUM_MAX_ABS_DIFF). A shared copy keeps the notes
//   of the source and the source's content stays as it was. The revert recipe (a track delete) is
//   sent with the scenario's consent; the track list and the master must equal what they were.
// - Delete a duplicated track. `track.delete` with `confirm` (not through the revert recipe) removes
//   the duplicate a step made; `trackIdMap` must agree with the following `project.get`.
// - Split boundary. A split cannot be undone (upstream_undo_defect). op split cuts
//   clip A inside a voiced note. The result's created / removed / idMap entries are compared with a
//   fresh `project.get`, and the whole master must stay bit-identical to the baseline (same length);
//   if not, the report holds the largest difference, its time and its distance from the split. The
//   returned revert recipe (a merge) is sent as given; its export must equal the baseline again. A
//   refused merge is reported, not failed.
// - Batch import, last. `import.start` with layout sequential puts two clips on one track, the second
//   where the first ends (the project's positions and the onsets in the master agree within
//   ONSET_TOLERANCE_SEC, and the master equals the baseline plus the sources, IMPORT_MAX_ABS_DIFF);
//   separateTracks puts both at 0 on two tracks and the master is their sum. It runs last because an
//   import shows hidden track slots and nothing hides them again, so these two cases compare the
//   project without the track visibility flag. The specification gives an import a revert recipe
//   (a delete) when the instance reports arrangement.v1; a result without one fails the check, and
//   the scenario then deletes the clips with a call it builds itself and goes on measuring.
//
// The audio is generated (test/support/harmonic-tone.ts): two clips on two tracks that do not overlap
// in time, at different pitches. Only generated audio is used; no file name or path reaches the
// report. The instance is started and ended by the exe target (test/contract/exe-target.ts), exactly
// as the smoke and effects scenarios do.
//
// Steps and their results follow the smoke scenario (test/e2e/smoke.ts): PASS, FAIL, SKIP (a
// capability the check needs is not reported) and FLAKY-SKIP (only an inference backend that cannot
// be initialised). A failed set-up step stops the scenario; a failed check does not stop the checks
// after it unless a revert could not restore the state, or a write took effect without a usable
// undo or revert. The requirement checks export the master mix only; a clip or track export is not used.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { parseDiscoveryFile } from '../../src/discovery/file.js';
import { OtcpError } from '../../src/errors/tool-error.js';
import { OtcpSession, type HelloInfo, type Json } from '../../src/otcp/client.js';
import { checkDataTemplate, exeConfigFromEnv, exeTarget, type ExeTargetOptions } from '../contract/exe-target.js';
import type { TargetInstance } from '../contract/target.js';
import { generateTone, writeToneFiles, type Tone, type ToneFiles } from '../support/harmonic-tone.js';
import { SHIFT_ERROR_SEC, estimateShift } from '../support/time-shift.js';
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

/**
 * How far op move takes clip B later, in seconds. It is 25 times the 20 ms the envelope estimator
 * resolves comfortably, so a move that did nothing or a tenth of the distance cannot pass; it is
 * shorter than clip B (2 s), so the old and the new position overlap and both an old-only and a
 * new-only part of the master exist; and 22 050 samples at 44.1 kHz, a whole number of samples.
 */
export const MOVE_DELTA_SEC = 0.5;

/**
 * How far the measured shift of clip B may lie from MOVE_DELTA_SEC. A clip is moved as it is, so the
 * envelope of the moved clip is that of the original; the estimator is within SHIFT_ERROR_SEC
 * (0.04 ms for the same waveform, 1 ms at most for another phase) and this is that bound.
 */
export const MOVE_SHIFT_TOLERANCE_SEC = SHIFT_ERROR_SEC;

/**
 * How much of the end of clip A the trim check cuts off: 1 s of its 2.4 s. The cut part holds the
 * sustained note (RMS 0.23), so a trim that is not rendered leaves a level 100 times the noise floor.
 */
export const TRIM_CUT_SEC = 1;

/**
 * The copy checks put their copy this long after the end of the baseline master, on the track of
 * the source, so the target is empty on that track and on every other and no copy overlaps a clip
 * (no OVERLAPS_CLIP or STACKED_ON_SOURCE warning is expected).
 */
export const COPY_GAP_SEC = 0.4;

/**
 * How many samples a clip may start before or after the sample that its start in seconds names.
 * OpenTune turns a position in seconds into a whole sample by truncating: a clip moved to 4.1 s
 * sounds from sample 180809, not 180810, because 4.1 * 44100 is 180809.99999999997 in floating point.
 * The specification does not say which way a position is rounded, and one sample is 23 microseconds,
 * so the checks accept a start within one sample of the named one, in either direction; a clip two
 * samples away, or a clip that is not the source, still fails.
 */
export const POSITION_QUANTUM_SAMPLES = 1;

/**
 * The largest sample difference allowed between a moved or copied clip in the master and its source
 * in the baseline (full scale 1.0), at the best start within POSITION_QUANTUM_SAMPLES. The dry audio
 * of a content is copied into the master, so the clip equals its source sample for sample and none is
 * expected: the same rule as the regions the other checks hold bit-identical, and far below what a
 * shift of two samples (about 0.1 for these tones) or a gain of 1 % (5e-3) leaves.
 */
export const SHIFTED_MAX_ABS_DIFF = 0;

/** The track volume the volume check asks for with volumeDb. */
export const TRACK_VOLUME_DB = -6;

/** The volume the second case asks for with volumeLinear. */
export const TRACK_VOLUME_LINEAR = 0.5;

/** What volumeLinear 0.5 is in dB: 20 * log10(0.5) = -6.02 dB. */
export const TRACK_VOLUME_LINEAR_DB = 20 * Math.log10(TRACK_VOLUME_LINEAR);

/**
 * How far the measured level change of a track volume may lie from the expected one: a volume is a
 * multiplication of samples, so the level change is exact up to how the master sums the track with
 * the others (nothing else sounds there); 0.5 dB is the bound of the clip gain check and separates
 * the 6 dB of the check from no change (0 dB) or a wrong half of it (3 dB).
 */
export const TRACK_VOLUME_TOLERANCE_DB = 0.5;

/** The level of two identical, coherent signals added: 20 * log10(2). */
export const COHERENT_SUM_DB = 20 * Math.log10(2);

/**
 * How far the level over a duplicated track's clip may lie from COHERENT_SUM_DB. The exact check
 * below is stricter; this bound only keeps the reported level honest, with the 0.5 dB of the other
 * level checks.
 */
export const COHERENT_SUM_TOLERANCE_DB = 0.5;

/**
 * The largest difference allowed between the master over a duplicated track's clip and twice the
 * baseline there (full scale 1.0). The copy has the same samples, so the sum is an exact doubling up
 * to float32 rounding; 1e-6 is about 30 times the rounding at the tone's level (peak 0.5) and 100
 * times below the generator's noise floor (1e-4), so a copy that is off by one sample or by a gain
 * of 1 % (5e-3) cannot pass.
 */
export const COHERENT_SUM_MAX_ABS_DIFF = 1e-6;

/**
 * Where the sequential import starts, in seconds: later than any clip a check can leave behind
 * (the longest copy ends at 8.4 s), so the two imported clips sound alone and their onsets can be
 * measured in the master.
 */
export const IMPORT_START_SEC = 10;

/**
 * An onset is the first window of ONSET_WINDOW_SEC (2 ms, a few periods of the lowest generated note)
 * whose RMS reaches ONSET_LEVEL (0.02, 8 % of the generated tone's RMS of about 0.25, 200 times its
 * noise floor). The generated tone fades in over 10 ms, so the onset lies about 1 ms after the clip
 * start; the expected onset of an imported clip is the same measure on its source, scaled by the
 * mixer gain and placed where the project says the clip starts.
 */
export const ONSET_WINDOW_SEC = 0.002;
export const ONSET_LEVEL = 0.02;

/**
 * How far an onset in the master may lie from the onset of the clip's source placed where
 * `project.get` says: a clip is placed on a whole sample (23 microseconds), so 1 ms allows for the
 * position being rounded to a frame of the renderer and still catches a clip that is a 10 ms
 * analysis frame or more out of place.
 */
export const ONSET_TOLERANCE_SEC = 0.001;

/**
 * The largest difference allowed between the master after an import and the baseline plus the
 * imported sources, placed where `project.get` says and scaled by the gain the baseline shows for
 * its own sources (full scale 1.0). Dry audio is copied into the mix, so the sum is exact up to
 * float32 rounding: the same bound as COHERENT_SUM_MAX_ABS_DIFF, and a clip a sample out of place
 * cannot pass.
 */
export const IMPORT_MAX_ABS_DIFF = 1e-6;

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

/** One track slot of the project, as far as the checks read it. */
export interface TrackRead {
  readonly trackId: number;
  /** Whether the slot is shown; a hidden slot is where track.duplicate and a clip moved onto it reveal a track. */
  readonly visible: boolean;
  readonly muted: boolean;
  readonly solo: boolean;
  readonly audible: boolean;
  /** The volume in dB; null for a volume of 0 (minus infinity dB). */
  readonly volumeDb: number | null;
  readonly volumeLinear: number;
  readonly colour: string;
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
    visible: booleanField(value, 'visible', 'a track'),
    muted: booleanField(value, 'muted', 'a track'),
    solo: booleanField(value, 'solo', 'a track'),
    audible: booleanField(value, 'audible', 'a track'),
    volumeDb: nullableNumber(value, 'volumeDb', 'a track'),
    volumeLinear: num(value, 'volumeLinear', 'a track'),
    colour: text(value, 'colour', 'a track'),
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
        readBack = {
          visible: track.visible,
          muted: track.muted,
          solo: track.solo,
          audible: track.audible,
          volumeDb: track.volumeDb,
          volumeLinear: track.volumeLinear,
          colour: track.colour,
        };
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

/** What a comparison of two project snapshots leaves out. */
export interface SnapshotOptions {
  /**
   * Which track slots are shown. A batch import fills the tracks it needs and shows them; deleting
   * its clips does not hide them again, so the import checks do not compare this.
   */
  readonly ignoreTrackVisibility?: boolean;
}

/**
 * Problems between two snapshots of the project: placements, their fields, tracks and contents. A
 * track slot that was shown before the step is compared with its mute, solo, volume and colour; one
 * that was hidden only with whether it is shown again, because OpenTune resets a slot that stops
 * being shown.
 */
export function projectSnapshotProblems(
  before: ProjectState,
  after: ProjectState,
  options: SnapshotOptions = {},
): string[] {
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
    const names: ('visible' | 'muted' | 'solo' | 'audible' | 'volumeDb' | 'volumeLinear' | 'colour')[] = [];
    if (options.ignoreTrackVisibility !== true) names.push('visible');
    if (track.visible) names.push('muted', 'solo', 'audible', 'volumeDb', 'volumeLinear', 'colour');
    for (const name of names) {
      if (!same(track[name], read[name])) {
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

/**
 * The largest |wet[to + n] - factor * base[from + n]| over the samples n of `source`, every channel,
 * where `to` is `targetStartSec` plus `lagSamples` samples: how well the master over a moved or
 * copied clip equals the source's part of the baseline (factor 1), or the sum of the source and an
 * identical copy (factor 2). A sample beyond the end of a file counts as 0, so a master that stops
 * early differs.
 */
export function shiftedDifference(
  base: DecodedWav,
  wet: DecodedWav,
  source: Span,
  targetStartSec: number,
  factor = 1,
  lagSamples = 0,
): number {
  const rate = base.sampleRateHz;
  const from = Math.round(source.startSec * rate);
  const count = Math.max(0, Math.round((source.endSec - source.startSec) * rate));
  const to = Math.round(targetStartSec * rate) + lagSamples;
  let largest = 0;
  for (let c = 0; c < Math.max(base.channels.length, wet.channels.length); c++) {
    const a = base.channels[c];
    const b = wet.channels[c];
    for (let n = 0; n < count; n++) {
      largest = Math.max(largest, Math.abs((b?.[to + n] ?? 0) - factor * (a?.[from + n] ?? 0)));
    }
  }
  return largest;
}

/**
 * shiftedDifference at the best start within POSITION_QUANTUM_SAMPLES of the one named, with that
 * start as samples early (negative) or late (positive) of the named sample; the start nearest to the
 * named one wins a tie.
 */
export function placedDifference(
  base: DecodedWav,
  wet: DecodedWav,
  source: Span,
  targetStartSec: number,
  factor = 1,
): { readonly maxAbsDiff: number; readonly lagSamples: number } {
  let best = { maxAbsDiff: Number.POSITIVE_INFINITY, lagSamples: 0 };
  for (let lag = -POSITION_QUANTUM_SAMPLES; lag <= POSITION_QUANTUM_SAMPLES; lag++) {
    const maxAbsDiff = shiftedDifference(base, wet, source, targetStartSec, factor, lag);
    if (maxAbsDiff < best.maxAbsDiff || (maxAbsDiff === best.maxAbsDiff && Math.abs(lag) < Math.abs(best.lagSamples))) {
      best = { maxAbsDiff, lagSamples: lag };
    }
  }
  return best;
}

/** An audio file placed on the timeline: its samples and where its first sample plays. */
export interface PlacedSource {
  readonly samples: Float64Array;
  readonly startSec: number;
}

/**
 * The gain g with the smallest error of wet = g * source over the length of `source`, wet read from
 * `wetFromSec` on (least squares). It is the factor the mixer applies to a mono source, such as the
 * pan law, and it needs no model of the mixer: the scenario reads it off a clip it knows.
 */
export function fitGain(source: Float64Array, wet: Float64Array, wetFromSec: number, rate: number): number {
  const from = Math.round(wetFromSec * rate);
  let cross = 0;
  let energy = 0;
  for (let i = 0; i < source.length; i++) {
    const x = source[i] ?? 0;
    cross += x * (wet[from + i] ?? 0);
    energy += x * x;
  }
  return energy > 0 ? cross / energy : 0;
}

/**
 * The largest |wet[from + n] - gain * source[n]| over the samples n of `source`, wet read from
 * `wetFromSec` on: how well a clip of the master is a scaled copy of its source.
 */
export function fitError(
  source: Float64Array,
  wet: Float64Array,
  wetFromSec: number,
  gain: number,
  rate: number,
): number {
  const from = Math.round(wetFromSec * rate);
  let largest = 0;
  for (let i = 0; i < source.length; i++) {
    largest = Math.max(largest, Math.abs((wet[from + i] ?? 0) - gain * (source[i] ?? 0)));
  }
  return largest;
}

/**
 * The largest |wet - (base + gain * the sum of the placed sources)| over `span`, on the mean of the
 * channels, and where it is. It is how well the master after an import equals the baseline with the
 * imported audio added where the project says the clips are.
 */
export function sumDifference(
  base: DecodedWav,
  wet: DecodedWav,
  placed: readonly PlacedSource[],
  gain: number,
  span: Span,
  lagSamples: readonly number[] = [],
): { readonly maxAbsDiff: number; readonly timeSec: number | null } {
  const rate = base.sampleRateHz;
  const from = Math.max(0, Math.round(span.startSec * rate));
  const to = Math.round(span.endSec * rate);
  const starts = placed.map((p, k) => Math.round(p.startSec * rate) + (lagSamples[k] ?? 0));
  let maxAbsDiff = 0;
  let at: number | null = null;
  for (let i = from; i < to; i++) {
    let expected = base.mono[i] ?? 0;
    for (const [k, p] of placed.entries()) expected += gain * (p.samples[i - (starts[k] ?? 0)] ?? 0);
    const d = Math.abs((wet.mono[i] ?? 0) - expected);
    if (d > maxAbsDiff) {
      maxAbsDiff = d;
      at = i;
    }
  }
  return { maxAbsDiff, timeSec: at === null ? null : round(at / rate, 6) };
}

/**
 * sumDifference with the start of every source at the best of the samples within
 * POSITION_QUANTUM_SAMPLES of the named one (each source on its own), and those starts.
 */
export function bestSumDifference(
  base: DecodedWav,
  wet: DecodedWav,
  placed: readonly PlacedSource[],
  gain: number,
  span: Span,
): { readonly maxAbsDiff: number; readonly timeSec: number | null; readonly lagSamples: readonly number[] } {
  const lags: number[] = [];
  for (let lag = -POSITION_QUANTUM_SAMPLES; lag <= POSITION_QUANTUM_SAMPLES; lag++) lags.push(lag);
  const combinations = (n: number): number[][] =>
    n === 0 ? [[]] : combinations(n - 1).flatMap((rest) => lags.map((lag) => [...rest, lag]));
  let best:
    | { readonly maxAbsDiff: number; readonly timeSec: number | null; readonly lagSamples: readonly number[] }
    | undefined;
  for (const combination of combinations(placed.length)) {
    const found = sumDifference(base, wet, placed, gain, span, combination);
    if (best === undefined || found.maxAbsDiff < best.maxAbsDiff) best = { ...found, lagSamples: combination };
  }
  return best ?? { maxAbsDiff: 0, timeSec: null, lagSamples: [] };
}

/**
 * The first time in [fromSec, toSec) at which a window of ONSET_WINDOW_SEC has an RMS of at least
 * `level` (on the mean of the channels), the window's start; null when none does.
 */
export function onsetOf(wav: DecodedWav, fromSec: number, toSec: number, level: number): number | null {
  const rate = wav.sampleRateHz;
  const window = Math.max(1, Math.round(ONSET_WINDOW_SEC * rate));
  const from = Math.max(0, Math.round(fromSec * rate));
  const to = Math.min(wav.mono.length, Math.round(toSec * rate));
  let sum = 0;
  for (let i = from; i < Math.min(to, from + window); i++) sum += (wav.mono[i] ?? 0) ** 2;
  for (let i = from; i + window <= to; i++) {
    if (Math.sqrt(Math.max(0, sum) / window) >= level) return i / rate;
    sum += (wav.mono[i + window] ?? 0) ** 2 - (wav.mono[i] ?? 0) ** 2;
  }
  return null;
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
  /**
   * The revert recipe of a write that cannot be undone but can be reverted (a copy, a duplicated
   * track, an import), recorded like the undoId. The check clears it once it has taken the write back
   * itself (an explicit delete).
   */
  revert: Revert | undefined;
  /** What the comparison of the project after the restore leaves out. */
  readonly snapshot: SnapshotOptions;
  /**
   * A check of what the restore must have left alone (the notes of a shared content), run once the
   * project is back; it returns its problems.
   */
  afterRestore: (() => Promise<readonly string[]>) | undefined;
  /** The fields its results reported that the scenario does not read back. */
  readonly unread: Set<string>;
}

/** What the work of a check hands back: the note of a pass, its problems and its report. */
interface Outcome {
  readonly note: string;
  readonly problems: readonly string[];
  readonly report: Record<string, unknown>;
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

/** Whether a write result's changes report one of the fields `names` for the clip `placementId`. */
export function changesPlacementField(result: Json, placementId: string, names: readonly string[]): boolean {
  if (!Array.isArray(result.changes)) return false;
  return (result.changes as unknown[]).some(
    (change) =>
      isObject(change) &&
      change.entity === 'placement' &&
      isObject(change.ref) &&
      change.ref.placementId === placementId &&
      isObject(change.fields) &&
      names.some((name) => isObject(change.fields) && Object.hasOwn(change.fields, name)),
  );
}

/**
 * How well the master over `span` is the sum of two identical signals: the largest difference from
 * twice the baseline there, the level change, and the problems when either is out of its bound.
 */
export function coherentSumOf(
  base: DecodedWav,
  wet: DecodedWav,
  span: Span,
): { readonly maxAbsDiff: number; readonly levelDb: number | null; readonly problems: string[] } {
  const maxAbsDiff = shiftedDifference(base, wet, span, span.startSec, 2);
  const levelDb = levelDifferenceDb(base, wet, span);
  const problems: string[] = [];
  if (maxAbsDiff > COHERENT_SUM_MAX_ABS_DIFF) {
    problems.push(`the master over clip A differs from twice the baseline by up to ${maxAbsDiff.toExponential(2)}`);
  }
  if (levelDb === null || Math.abs(levelDb - COHERENT_SUM_DB) > COHERENT_SUM_TOLERANCE_DB) {
    problems.push(
      `the level over clip A changed by ${levelDb === null ? 'an unmeasurable amount' : `${String(round(levelDb))} dB`}, ` +
        `expected ${String(round(COHERENT_SUM_DB, 2))} +- ${String(COHERENT_SUM_TOLERANCE_DB)} dB`,
    );
  }
  return { maxAbsDiff, levelDb, problems };
}

/** A revert recipe as `revertOf` reads it. */
export type Revert = NonNullable<ReturnType<typeof revertOf>>;

/**
 * The methods whose revert recipe asks for the end user's consent (PROTOCOL.md section 15.2 rule 4)
 * and that the scenario sends anyway. The scenario made every clip and track such a recipe deletes (a
 * copy, a duplicated track, the clips of an import), so it plays the end user for these and adds
 * `confirm` itself, as the tour of the contract does.
 */
const CONSENT_METHODS: ReadonlySet<string> = new Set(['arrangement.edit', 'track.delete']);

/**
 * The params to send for a revert recipe: as given, plus `confirm: true` for a recipe that asks for
 * consent; undefined for a recipe that asks for consent for a method the scenario made no object of.
 * A recipe that carries a consent member itself is a problem (rule 4), added to `problems`.
 */
export function revertRequest(revert: Revert, problems: string[] = []): Json | undefined {
  if (Object.hasOwn(revert.params, 'confirm')) {
    problems.push(`the revert recipe of ${revert.method} carries confirm, which only the end user may give`);
  }
  if (!revert.requiresConsent) return revert.params;
  return CONSENT_METHODS.has(revert.method) ? { ...revert.params, confirm: true } : undefined;
}

/** The codes of the warnings of a write result. */
export function warningCodes(result: Json): string[] {
  const list = result.warnings;
  if (!Array.isArray(list)) return [];
  return (list as unknown[]).flatMap((warning) =>
    isObject(warning) && typeof warning.code === 'string' ? [warning.code] : [],
  );
}

/** The placementIds (or contentIds) of the entries of one list of a write result (`created`, `removed`). */
export function entityIds(result: Json, list: 'created' | 'removed', entity: 'placement' | 'content'): string[] {
  const entries = result[list];
  if (!Array.isArray(entries)) return [];
  const key = entity === 'placement' ? 'placementId' : 'contentId';
  return (entries as unknown[]).flatMap((raw) => {
    if (!isObject(raw) || raw.entity !== entity || !isObject(raw.ref)) return [];
    const id = raw.ref[key];
    return typeof id === 'string' ? [id] : [];
  });
}

/** The placements an idMap of the relation `copy` relates: the source's id and the copy's. */
export function copyPairs(result: Json): { readonly from: string; readonly to: string }[] {
  const maps = Array.isArray(result.idMap) ? (result.idMap as unknown[]) : [];
  const idsOf = (list: unknown): string[] =>
    Array.isArray(list)
      ? (list as unknown[]).flatMap((raw) =>
          isObject(raw) && typeof raw.placementId === 'string' ? [raw.placementId] : [],
        )
      : [];
  const pairs: { from: string; to: string }[] = [];
  for (const map of maps) {
    if (!isObject(map) || map.relation !== 'copy' || map.entity !== 'placement') continue;
    const from = idsOf(map.from);
    const to = idsOf(map.to);
    for (const [i, source] of from.entries()) {
      const copy = to[i];
      if (copy !== undefined) pairs.push({ from: source, to: copy });
    }
  }
  return pairs;
}

/**
 * What an arrangement.copy result and a fresh read must agree on: one new clip on the asked track at
 * the asked time, as long as its source with its gain and fades, with a content of its own (and
 * created, idMap and the warnings saying so), and no warning that the copy lands on another clip or on
 * a hidden track, which the scenario's choice of the target excludes.
 */
export function copyConsistency(
  result: Json,
  state: ProjectState,
  source: PlacementRead,
  mode: 'window' | 'full',
  toTrackId: number,
  startTimelineSec: number,
): string[] {
  const problems: string[] = [];
  const created = entityIds(result, 'created', 'placement');
  if (created.length !== 1) problems.push(`created must name the one copy (it says ${String(created.length)})`);
  const copy = created.length === 1 ? state.placements.find((p) => p.placementId === created[0]) : undefined;
  if (copy === undefined) {
    problems.push('the copy is not there afterwards');
    return problems;
  }
  if (copy.trackId !== toTrackId) {
    problems.push(`the copy is on track ${String(copy.trackId)}, not ${String(toTrackId)}`);
  }
  if (!same(copy.startTimelineSec, startTimelineSec)) {
    problems.push(`the copy starts at ${String(copy.startTimelineSec)} s, not ${String(startTimelineSec)} s`);
  }
  if (!same(copy.durationSec, source.durationSec)) {
    problems.push(`the copy is ${String(copy.durationSec)} s long, its source ${String(source.durationSec)} s`);
  }
  for (const name of ['gainDb', 'gainLinear', 'fadeInSec', 'fadeOutSec'] as const) {
    if (!same(copy[name], source[name])) problems.push(`the copy does not keep the ${name} of its source`);
  }
  if (copy.contentId === source.contentId)
    problems.push('the copy shows the content of its source, not one of its own');
  if (!entityIds(result, 'created', 'content').includes(copy.contentId)) {
    problems.push('created does not name the content of the copy');
  }
  if (mode === 'full' && !same(copy.clipInContentSec, source.clipInContentSec)) {
    problems.push('a full copy does not show the same part of its content as its source');
  }
  if (!copyPairs(result).some((pair) => pair.from === source.placementId && pair.to === copy.placementId)) {
    problems.push('idMap does not relate the source to its copy');
  }
  const codes = warningCodes(result);
  for (const code of ['STACKED_ON_SOURCE', 'OVERLAPS_CLIP', 'TRACK_AUTO_REVEALED']) {
    if (codes.includes(code))
      problems.push(`the copy carries the warning ${code}, though its target is empty and shown`);
  }
  return problems.slice(0, 8);
}

/**
 * What a track.duplicate result and the projects before and after it must agree on: exactly the
 * track newTrackId was shown, it takes mute, solo, volume and colour of its source, holds a copy of
 * every clip of the source at the same place with the same gain and fades, and its clips show contents
 * of their own (clone) or those of their sources (share, with the warning SHARED_CONTENT).
 */
export function duplicateConsistency(
  result: Json,
  before: ProjectState,
  after: ProjectState,
  sourceTrackId: number,
  mode: 'clone' | 'share',
): string[] {
  const newTrackId = typeof result.newTrackId === 'number' ? result.newTrackId : undefined;
  if (newTrackId === undefined) return ['the result has no newTrackId'];
  const problems: string[] = [];
  const shown = after.tracks
    .filter((t) => t.visible && before.tracks.find((b) => b.trackId === t.trackId)?.visible !== true)
    .map((t) => t.trackId);
  if (shown.length !== 1 || shown[0] !== newTrackId) {
    problems.push(
      `the tracks the duplicate shows are ${shown.join(', ') || 'none'}, newTrackId says ${String(newTrackId)}`,
    );
  }
  const source = after.tracks.find((t) => t.trackId === sourceTrackId);
  const track = after.tracks.find((t) => t.trackId === newTrackId);
  if (source !== undefined && track !== undefined) {
    for (const name of ['muted', 'solo', 'volumeDb', 'volumeLinear', 'colour'] as const) {
      if (!same(source[name], track[name])) problems.push(`the new track does not take the ${name} of its source`);
    }
  }
  const sources = before.placements.filter((p) => p.trackId === sourceTrackId);
  const copies = after.placements.filter((p) => p.trackId === newTrackId);
  if (copies.length !== sources.length) {
    problems.push(`the new track holds ${String(copies.length)} clip(s), its source ${String(sources.length)}`);
  }
  const pairs = copyPairs(result);
  for (const original of sources) {
    const copy = copies.find(
      (p) => same(p.startTimelineSec, original.startTimelineSec) && same(p.endTimelineSec, original.endTimelineSec),
    );
    if (copy === undefined) {
      problems.push(`the new track has no copy of clip ${original.placementId} at its place`);
      continue;
    }
    for (const name of ['gainDb', 'gainLinear', 'fadeInSec', 'fadeOutSec', 'clipInContentSec'] as const) {
      if (!same(copy[name], original[name])) problems.push(`the copy does not keep the ${name} of its source`);
    }
    const sharesContent = copy.contentId === original.contentId;
    if (mode === 'share' && !sharesContent) problems.push('a shared copy shows a content of its own');
    if (mode === 'clone' && sharesContent) problems.push('a cloned copy shows the content of its source');
    if (!pairs.some((pair) => pair.from === original.placementId && pair.to === copy.placementId)) {
      problems.push('idMap does not relate a clip to its copy');
    }
  }
  const added = after.contents.length - before.contents.length;
  const expectedAdded = mode === 'share' ? 0 : sources.length;
  if (added !== expectedAdded) {
    problems.push(`${mode} left ${String(added)} new content(s) in the project, expected ${String(expectedAdded)}`);
  }
  if (mode === 'share' && !warningCodes(result).includes('SHARED_CONTENT')) {
    problems.push('a shared copy carries no SHARED_CONTENT warning');
  }
  return problems.slice(0, 8);
}

/**
 * What a track.delete result and the projects before and after it must agree on: trackIdMap lists the
 * deleted track as gone and every later shown track with its new place; the clips of the deleted
 * track are gone (and `removed` names them), the clips of a moved track and its settings are on its new
 * place; one track fewer is shown.
 */
export function trackDeleteConsistency(
  result: Json,
  before: ProjectState,
  after: ProjectState,
  deletedTrackId: number,
): string[] {
  const map = result.trackIdMap;
  if (!Array.isArray(map)) return ['trackIdMap is not an array'];
  const problems: string[] = [];
  const entries = (map as unknown[]).flatMap((raw) =>
    isObject(raw) && typeof raw.before === 'number' && (typeof raw.after === 'number' || raw.after === null)
      ? [{ before: raw.before, after: raw.after }]
      : [],
  );
  if (entries.length !== map.length) problems.push('a trackIdMap entry has no before or no after');
  const shown = before.tracks
    .filter((t) => t.visible)
    .map((t) => t.trackId)
    .sort((a, b) => a - b);
  const index = shown.indexOf(deletedTrackId);
  if (index < 0) return [...problems, `track ${String(deletedTrackId)} was not shown before the delete`];
  const expected = new Map<number, number | null>([[deletedTrackId, null]]);
  for (let j = index + 1; j < shown.length; j++) {
    const moved = shown[j];
    const place = shown[j - 1];
    if (moved !== undefined && place !== undefined) expected.set(moved, place);
  }
  for (const [trackId, place] of expected) {
    const entry = entries.find((e) => e.before === trackId);
    if (entry?.after !== place) {
      problems.push(
        `trackIdMap should map track ${String(trackId)} to ${place === null ? 'null' : String(place)}, ` +
          `it says ${entry === undefined ? 'nothing' : String(entry.after)}`,
      );
    }
  }
  for (const entry of entries) {
    if (!expected.has(entry.before))
      problems.push(`trackIdMap lists track ${String(entry.before)}, which does not move`);
  }
  const held = before.placements.filter((p) => p.trackId === deletedTrackId).map((p) => p.placementId);
  const removed = entityIds(result, 'removed', 'placement');
  if (held.slice().sort().join('|') !== removed.slice().sort().join('|')) {
    problems.push(`removed names ${String(removed.length)} clip(s), the deleted track held ${String(held.length)}`);
  }
  for (const clip of before.placements) {
    const place = expected.get(clip.trackId);
    const now = after.placements.find((p) => p.placementId === clip.placementId);
    if (place === null) {
      if (now !== undefined) problems.push(`clip ${clip.placementId} of the deleted track is still there`);
    } else if (now?.trackId !== (place ?? clip.trackId)) {
      problems.push(
        `clip ${clip.placementId} is on track ${now === undefined ? 'nowhere' : String(now.trackId)}, ` +
          `expected ${String(place ?? clip.trackId)}`,
      );
    }
  }
  for (const [trackId, place] of expected) {
    if (place === null) continue;
    const was = before.tracks.find((t) => t.trackId === trackId);
    const now = after.tracks.find((t) => t.trackId === place);
    for (const name of ['muted', 'solo', 'volumeDb', 'volumeLinear', 'colour'] as const) {
      if (was !== undefined && now !== undefined && !same(was[name], now[name])) {
        problems.push(`track ${String(place)} does not take the ${name} of track ${String(trackId)}`);
      }
    }
  }
  const shownAfter = after.tracks.filter((t) => t.visible).length;
  if (shownAfter !== shown.length - 1) {
    problems.push(`${String(shownAfter)} track(s) are shown afterwards, expected ${String(shown.length - 1)}`);
  }
  if (after.tracks.find((t) => t.trackId === deletedTrackId)?.visible === true && index === shown.length - 1) {
    problems.push(`track ${String(deletedTrackId)} is still shown`);
  }
  return problems.slice(0, 8);
}

/** One clip of an import result. */
export interface ImportedClip {
  readonly placementId: string;
  readonly trackId: number;
  readonly startTimelineSec: number;
  readonly durationSec: number;
}

/** The clips an import job result reports, in the order of the files; throws for a file that was not imported. */
export function importedClips(result: Json): ImportedClip[] {
  const items = member(result, 'items', 'the import result');
  if (!Array.isArray(items)) throw new Error('the import result has no items array');
  return (items as unknown[]).map((item, i) => {
    if (!isObject(item) || item.imported !== true)
      throw new Error(`file ${String(i + 1)} of the import was not imported`);
    return {
      placementId: text(item, 'placementId', 'the import item'),
      trackId: num(item, 'trackId', 'the import item'),
      startTimelineSec: num(item, 'startTimelineSec', 'the import item'),
      durationSec: num(item, 'durationSec', 'the import item'),
    };
  });
}

/**
 * What an import of two files in one layout must leave on the timeline, by what the result says and
 * what a fresh read holds: sequential puts the second clip where the first ends, on the same track,
 * the first at `startTimelineSec`; separateTracks puts them on two successive tracks, both at 0.
 */
export function importLayoutProblems(
  layout: 'sequential' | 'separateTracks',
  clips: readonly ImportedClip[],
  state: ProjectState,
  startTimelineSec: number | undefined,
): string[] {
  const problems: string[] = [];
  const [first, second] = clips;
  if (clips.length !== 2 || first === undefined || second === undefined) {
    return [`the import reports ${String(clips.length)} clip(s), expected 2`];
  }
  for (const clip of clips) {
    const read = state.placements.find((p) => p.placementId === clip.placementId);
    if (read === undefined) {
      problems.push(`imported clip ${clip.placementId} is not in the project`);
      continue;
    }
    if (read.trackId !== clip.trackId)
      problems.push(
        `clip ${clip.placementId} is on track ${String(read.trackId)}, the result says ${String(clip.trackId)}`,
      );
    if (!same(read.startTimelineSec, clip.startTimelineSec)) {
      problems.push(
        `clip ${clip.placementId} starts at ${String(read.startTimelineSec)} s, the result says ${String(clip.startTimelineSec)} s`,
      );
    }
    if (!same(read.durationSec, clip.durationSec)) {
      problems.push(
        `clip ${clip.placementId} is ${String(read.durationSec)} s long, the result says ${String(clip.durationSec)} s`,
      );
    }
  }
  if (layout === 'sequential') {
    if (second.trackId !== first.trackId) problems.push('the sequential clips are on two tracks');
    if (startTimelineSec !== undefined && !same(first.startTimelineSec, startTimelineSec)) {
      problems.push(`the first clip starts at ${String(first.startTimelineSec)} s, not ${String(startTimelineSec)} s`);
    }
    const joined = first.startTimelineSec + first.durationSec;
    if (Math.abs(second.startTimelineSec - joined) > TIMELINE_EPSILON_SEC) {
      problems.push(
        `the second clip starts at ${String(second.startTimelineSec)} s, where the first ends at ${String(round(joined, 6))} s`,
      );
    }
  } else {
    if (second.trackId !== first.trackId + 1) {
      problems.push(
        `the clips are on tracks ${String(first.trackId)} and ${String(second.trackId)}, not two successive ones`,
      );
    }
    for (const clip of clips) {
      if (Math.abs(clip.startTimelineSec) > TIMELINE_EPSILON_SEC) {
        problems.push(`a clip on its own track starts at ${String(clip.startTimelineSec)} s, not 0`);
      }
    }
  }
  return problems.slice(0, 8);
}

/** `samples` with zeros appended so that it lasts at least `seconds`; the array itself when it is long enough. */
export function paddedTo(samples: Float64Array, seconds: number, rate: number): Float64Array {
  const length = Math.ceil(seconds * rate);
  if (samples.length >= length) return samples;
  const out = new Float64Array(length);
  out.set(samples);
  return out;
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

/** Compares two paths the way the platform does: without regard to case on Windows only. */
const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

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
  /** Where clip A and clip B lie in the baseline; the ids of the clips change once a split has been merged. */
  let baselineSpans: { readonly a: Span; readonly b: Span } | undefined;
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
    if (!samePath(path.resolve(exportedPath), path.resolve(file)))
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

  /**
   * A write that must have taken effect; returns the result and the project read right after it.
   * `restore` says how the check takes the write back, and records that in the frame before anything
   * else is read from the result: with the undoId of the write (`undo`) or with its revert recipe
   * (`revert`). A write that gives neither stops the checks after it, as they would run on a
   * changed project.
   */
  const write = async (
    method: 'arrangement.edit' | 'arrangement.copy' | 'track.set' | 'track.duplicate' | 'track.delete',
    params: Json,
    options: { readonly frame?: CheckFrame; readonly restore?: 'undo' | 'revert' } = {},
  ) => {
    const result = await need().call(method, params, 60_000);
    if (result.applied === false || result.dryRun === true) {
      throw new Error(`${method} changed nothing (applied ${String(result.applied)}, dryRun ${String(result.dryRun)})`);
    }
    if (options.restore !== undefined && options.frame !== undefined) {
      const cannot = (why: string) =>
        new Unrestored(
          `${method} took effect, but ${why}: ` +
            'the check cannot take it back, and the checks after it would run on a changed project',
        );
      if (options.restore === 'undo') {
        try {
          options.frame.undoId = undoIdOf(result);
        } catch (error) {
          throw cannot(error instanceof Error ? error.message : String(error));
        }
      } else {
        options.frame.revert = revertOf(result);
        if (options.frame.revert === undefined) throw cannot('its result gives no revert recipe');
      }
    }
    const state = await readProject(need());
    const consistency = writeConsistency(result, state);
    for (const field of consistency.unreadFields) options.frame?.unread.add(field);
    return { result, state, consistency };
  };

  /** A call that must be refused, with the kind and reason given; the problem is empty when it was. */
  const refusedWith = async (
    method: string,
    params: Json,
    kind: string,
    reason: string,
  ): Promise<string | undefined> => {
    try {
      await need().call(method, params, 60_000);
    } catch (error) {
      if (error instanceof OtcpError && error.data.kind === kind && error.data.reason === reason) return undefined;
      return `${method} was refused with ${classify(error).note}, expected ${kind}(${reason})`;
    }
    return `${method} was not refused, expected ${kind}(${reason})`;
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

  /**
   * Takes a write back with edit.undo, or with its revert recipe (sent as given, plus the consent the
   * scenario gives for what it made itself), and verifies the project, then the master against the
   * baseline. A project that is not as it was stops the checks after it; the problems returned are
   * those of the restore itself.
   */
  const restoreAndVerify = async (frame: CheckFrame): Promise<{ by: string; problems: string[] }> => {
    const problems: string[] = [];
    let result: Json;
    let by: string;
    let exportLabel: string;
    if (frame.undoId !== undefined) {
      result = await need().call('edit.undo', { expectedUndoId: frame.undoId }, 60_000);
      if (result.applied === false || result.dryRun === true) throw new Error('edit.undo did not apply');
      by = 'edit.undo';
      exportLabel = 'after undo';
    } else if (frame.revert !== undefined) {
      const { method } = frame.revert;
      const params = revertRequest(frame.revert, problems);
      if (params === undefined) {
        throw new Unrestored(
          `the revert recipe of the write is a ${method} call that needs consent, which the scenario cannot give`,
        );
      }
      try {
        result = await need().call(method, params, 60_000);
      } catch (error) {
        throw new Unrestored(`the revert (${method}) failed: ${classify(error).note}`, { cause: error });
      }
      if (result.applied === false || result.dryRun === true)
        throw new Unrestored(`the revert (${method}) did not apply`);
      by = `the revert (${method})`;
      exportLabel = 'after revert';
    } else {
      throw new Error('there is nothing to take the write back with');
    }
    const state = await readProject(need());
    const left = projectSnapshotProblems(frame.before, state, frame.snapshot);
    if (left.length > 0) throw new Unrestored(`after ${by} the project is not as it was: ${left.join('; ')}`);
    frame.undoId = undefined;
    frame.revert = undefined;
    problems.push(...tokensProblems(result, state).map((p) => `${by === 'edit.undo' ? 'undo' : 'revert'}: ${p}`));
    if (frame.afterRestore !== undefined) {
      try {
        problems.push(...(await frame.afterRestore()));
      } catch (error) {
        problems.push(`what the restore had to leave alone could not be read: ${classify(error).note}`);
      }
    }
    try {
      await compareWithBaseline(exportLabel, problems, `the master after ${by}`);
    } catch (error) {
      // The project is back; a failed export is a problem of the check, not a reason to stop the rest.
      problems.push(`the master after ${by} could not be exported: ${classify(error).note}`);
    }
    return { by, problems };
  };

  /**
   * Runs the work of a check, then takes back what it wrote, also when the work failed half-way (the
   * undoId or the revert recipe is recorded first). An error of the work is returned, not thrown,
   * unless it ends the scenario (a skip, or a project that is not as it was); `unrestored` is set when
   * the restore could not put the project back.
   */
  const guarded = async (
    frame: CheckFrame,
    work: (frame: CheckFrame) => Promise<Outcome>,
  ): Promise<{
    readonly outcome: Outcome | undefined;
    readonly failure: unknown;
    readonly restore: { by: string; problems: string[] } | undefined;
    readonly unrestored: Unrestored | undefined;
  }> => {
    let outcome: Outcome | undefined;
    let failure: unknown;
    try {
      outcome = await work(frame);
    } catch (error) {
      failure = error;
    }
    if (failure instanceof Unrestored || failure instanceof StepSkip) throw failure;
    let restore: { by: string; problems: string[] } | undefined;
    if (frame.undoId !== undefined || frame.revert !== undefined) {
      try {
        restore = await restoreAndVerify(frame);
      } catch (error) {
        // Whatever went wrong while taking the write back, the project is not known to be as it was.
        const unrestored = error instanceof Unrestored ? error : new Unrestored(messageOf(error), { cause: error });
        return { outcome, failure, restore: undefined, unrestored };
      }
    }
    return { outcome, failure, restore, unrestored: undefined };
  };

  /** A new frame: the project as it is, and nothing written yet. */
  const newFrame = async (snapshot: SnapshotOptions = {}): Promise<CheckFrame> => ({
    before: await readProject(need()),
    undoId: undefined,
    revert: undefined,
    snapshot,
    afterRestore: undefined,
    unread: new Set(),
  });

  /** What the report holds about a restore: that it worked (undoRestored, revertRestored), or its problems. */
  const restoreReport = (restore: { readonly by: string; readonly problems: readonly string[] } | undefined) => {
    if (restore === undefined) return {};
    const undo = restore.by === 'edit.undo';
    if (restore.problems.length > 0) return { [undo ? 'undo' : 'revert']: restore.problems };
    return { ...(undo ? { undoRestored: true } : { revertRestored: true }), restoredBy: restore.by };
  };

  /**
   * A check that writes and takes the write back: snapshot, work, edit.undo or the revert recipe and
   * the comparison with the snapshot, also when the work failed half-way (the undoId or the recipe is
   * recorded first). Any problem, including one of the restore, fails the check; a project the
   * restore did not put back stops the checks after it.
   */
  const undoableCheck = async (
    name: string,
    work: (frame: CheckFrame) => Promise<Outcome>,
    snapshot: SnapshotOptions = {},
  ): Promise<string> => {
    const frame = await newFrame(snapshot);
    const { outcome, failure, restore, unrestored } = await guarded(frame, work);
    const unread = frame.unread.size === 0 ? {} : { unreadFields: [...frame.unread].sort() };
    if (unrestored !== undefined) {
      checks[name] = { ...(outcome?.report ?? {}), ...unread, error: scrub(unrestored.message) };
      throw unrestored;
    }
    const restoreProblems = restore?.problems ?? [];
    const problems = [...(outcome?.problems ?? []), ...restoreProblems];
    checks[name] = {
      ...(outcome?.report ?? {}),
      ...unread,
      ...restoreReport(restore),
      ...(failure === undefined ? {} : { error: scrub(messageOf(failure)) }),
    };
    if (failure !== undefined) {
      throw new Error(
        restoreProblems.length === 0 ? messageOf(failure) : `${messageOf(failure)}; ${restoreProblems.join('; ')}`,
        { cause: failure },
      );
    }
    if (problems.length > 0) throw new Error(problems.join('; '));
    const note = outcome?.note ?? 'checked';
    return frame.unread.size === 0
      ? note
      : `${note}; ${String(frame.unread.size)} reported field(s) not compared, as the scenario does not read them`;
  };

  /** Skips the step when the instance does not report the capability. */
  const requires = (capability: string, why?: string) => {
    if (!has(capability)) {
      throw new StepSkip('SKIP', `the instance does not report ${capability}${why === undefined ? '' : `, ${why}`}`);
    }
  };

  const needBaseline = (): DecodedWav => {
    if (baseline === undefined) throw new Error('no baseline');
    return baseline;
  };

  /** The seconds a master lasts. */
  const lengthSec = (wav: DecodedWav) => wav.mono.length / wav.sampleRateHz;

  /**
   * One case of a step that has several (a volume, a layout), with its own frame and restore. Its
   * problems and report are added to `problems` and `cases` under the label, and the step's check
   * report is set as far as it got when a case could not restore the project. Returns the outcome
   * of the work, when it ended.
   */
  const runCase = async (
    name: string,
    cases: Record<string, unknown>[],
    problems: string[],
    label: string,
    work: (frame: CheckFrame) => Promise<Outcome>,
    snapshot: SnapshotOptions = {},
  ): Promise<Outcome | undefined> => {
    const frame = await newFrame(snapshot);
    const { outcome, failure, restore, unrestored } = await guarded(frame, work);
    const unread = frame.unread.size === 0 ? {} : { unreadFields: [...frame.unread].sort() };
    if (unrestored !== undefined) {
      checks[name] = {
        cases: [...cases, { case: label, ...(outcome?.report ?? {}), error: scrub(unrestored.message) }],
      };
      throw unrestored;
    }
    const prefix = (list: readonly string[]) => list.map((p) => `${label}: ${p}`);
    problems.push(...prefix(outcome?.problems ?? []), ...prefix(restore?.problems ?? []));
    if (failure !== undefined) problems.push(`${label}: ${scrub(messageOf(failure))}`);
    cases.push({
      case: label,
      ...(outcome?.report ?? {}),
      ...unread,
      ...restoreReport(restore),
      ...(failure === undefined ? {} : { error: scrub(messageOf(failure)) }),
    });
    return outcome;
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
    const project = await readProject(need());
    baselineSpans = {
      a: clipSpan(placementOf(project, clipAId)),
      b: clipSpan(placementOf(project, clipBId)),
    };
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
          { frame, restore: 'undo' },
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
          { frame, restore: 'undo' },
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

      await runCase(`mute track ${String(trackB)}`, { tracks: [{ trackId: trackB, muted: true }] }, regionB, regionA, {
        muted: [trackB],
        solo: [],
      });
      await runCase(`solo track ${String(trackA)}`, { tracks: [{ trackId: trackA, solo: true }] }, regionB, regionA, {
        muted: [],
        solo: [trackA],
      });
      await runCase(`solo track ${String(trackB)}`, { tracks: [{ trackId: trackB, solo: true }] }, regionA, regionB, {
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

  // --- clips: move, trim, copy, delete -----------------------------------------------------------

  await step(
    'move clip B 0.5 s later',
    async () =>
      undoableCheck('move clip B 0.5 s later', async (frame) => {
        requires('arrangement.v1');
        requires('history.v1', 'which edit.undo needs');
        const base = needBaseline();
        const rate = base.sampleRateHz;
        const quantumSec = POSITION_QUANTUM_SAMPLES / rate;
        const oldB = placementOf(frame.before, clipBId);
        const oldSpan = clipSpan(oldB);
        const wantedStart = round(oldB.startTimelineSec + MOVE_DELTA_SEC, 6);
        const { result, state, consistency } = await write(
          'arrangement.edit',
          {
            expectedArrangementRevision: frame.before.arrangementRevision,
            ops: [{ op: 'move', placementId: clipBId, startTimelineSec: wantedStart }],
          },
          { frame, restore: 'undo' },
        );
        const problems = [...consistency.problems];
        const moved = placementOf(state, clipBId);
        if (!same(moved.startTimelineSec, wantedStart)) {
          problems.push(`clip B starts at ${String(moved.startTimelineSec)} s, not ${String(wantedStart)} s`);
        }
        if (moved.trackId !== oldB.trackId) problems.push('clip B changed its track');
        if (!same(moved.durationSec, oldB.durationSec) || !same(moved.clipInContentSec, oldB.clipInContentSec)) {
          problems.push('moving clip B changed its length or the part of its content it shows');
        }
        if (!changesPlacementField(result, clipBId, ['startTimelineSec', 'endTimelineSec'])) {
          problems.push('its changes do not report the new place of clip B');
        }
        const wet = await exportMaster('move');
        // Only the old and the new place of clip B may differ: everything before it is the baseline.
        const untouched = compareSamples(base, wet.wav, [{ startSec: 0, endSec: oldSpan.startSec }]);
        if (untouched.bitIdentical !== 1) {
          problems.push(
            `the master before the old place of clip B differs from the baseline by up to ${untouched.maxAbsDiff.toExponential(2)}`,
          );
        }
        const vacated = silenceOf(wet.wav, {
          startSec: oldSpan.startSec,
          endSec: Math.min(oldSpan.endSec, moved.startTimelineSec - quantumSec),
        });
        if (vacated.maxAbs > SILENCE_MAX_ABS) {
          problems.push(`clip B is still heard at its old place (up to ${vacated.maxAbs.toExponential(2)})`);
        }
        const placedAt = placedDifference(base, wet.wav, oldSpan, moved.startTimelineSec);
        const exact = placedAt.maxAbsDiff;
        if (exact > SHIFTED_MAX_ABS_DIFF) {
          problems.push(
            `the master at the new place differs from clip B in the baseline by up to ${exact.toExponential(2)}`,
          );
        }
        // How far clip B moved, from the envelopes alone, as the timing check measures a shift.
        let shift: { readonly lagSec: number; readonly peak: number } | null = null;
        try {
          const maxLagSec = MOVE_DELTA_SEC + 0.1;
          const padSec = oldSpan.endSec + maxLagSec + 0.1;
          shift = estimateShift(
            paddedTo(base.mono, padSec, rate),
            paddedTo(wet.wav.mono, padSec, rate),
            rate,
            oldSpan,
            { maxLagSec },
          );
          if (Math.abs(shift.lagSec - MOVE_DELTA_SEC) > MOVE_SHIFT_TOLERANCE_SEC) {
            problems.push(
              `clip B moved by ${String(round(shift.lagSec * 1000, 1))} ms, expected ${String(MOVE_DELTA_SEC * 1000)} ms ` +
                `+- ${String(MOVE_SHIFT_TOLERANCE_SEC * 1000)} ms`,
            );
          }
        } catch (error) {
          problems.push(`the shift of clip B cannot be measured: ${messageOf(error)}`);
        }
        if (Math.abs(lengthSec(wet.wav) - moved.endTimelineSec) > 1 / rate + TIMELINE_EPSILON_SEC) {
          problems.push(
            `the master lasts ${String(round(lengthSec(wet.wav), 4))} s, clip B ends at ${String(moved.endTimelineSec)} s`,
          );
        }
        return {
          note:
            `clip B moved ${shift === null ? 'by an unmeasured time' : `${String(round(shift.lagSec * 1000, 1))} ms`} ` +
            `(asked ${String(MOVE_DELTA_SEC * 1000)} ms); its old place is silent, its new place equals the baseline; ` +
            'undo restored the clip and the master',
          problems,
          report: {
            deltaSec: MOVE_DELTA_SEC,
            requestedStartSec: wantedStart,
            startTimelineSec: moved.startTimelineSec,
            tolerance: {
              shiftSec: MOVE_SHIFT_TOLERANCE_SEC,
              maxAbsDiff: SHIFTED_MAX_ABS_DIFF,
              silenceMaxAbs: SILENCE_MAX_ABS,
            },
            measuredShiftSec: shift === null ? null : round(shift.lagSec, 5),
            correlationPeak: shift === null ? null : round(shift.peak, 4),
            newPlaceMaxAbsDiff: exact,
            startLagSamples: placedAt.lagSamples,
            oldPlaceMaxAbs: vacated.maxAbs,
            beforeOldPlaceBitIdentical: untouched.bitIdentical === 1,
            consistency: consistency.problems,
          },
        };
      }),
    { check: true },
  );

  await step(
    'trim clip A end by 1 s',
    async () =>
      undoableCheck('trim clip A end by 1 s', async (frame) => {
        requires('arrangement.v1');
        requires('history.v1', 'which edit.undo needs');
        const base = needBaseline();
        const quantumSec = POSITION_QUANTUM_SAMPLES / base.sampleRateHz;
        const oldA = placementOf(frame.before, clipAId);
        const oldB = placementOf(frame.before, clipBId);
        const wantedEnd = round(oldA.endTimelineSec - TRIM_CUT_SEC, 6);
        if (!(wantedEnd > oldA.startTimelineSec))
          throw new Error('clip A is not longer than the part the trim cuts off');
        const cut: Span = { startSec: wantedEnd, endSec: oldA.endTimelineSec };
        const cutRms = rmsOf(base, cut);
        if (cutRms <= SIGNAL_FLOOR_RMS) throw new Error('clip A has no sound in the part the trim cuts off');
        const { result, state, consistency } = await write(
          'arrangement.edit',
          {
            expectedArrangementRevision: frame.before.arrangementRevision,
            ops: [{ op: 'trim', placementId: clipAId, edge: 'end', toTimelineSec: wantedEnd }],
          },
          { frame, restore: 'undo' },
        );
        const problems = [...consistency.problems];
        const trimmed = placementOf(state, clipAId);
        if (!same(trimmed.endTimelineSec, wantedEnd)) {
          problems.push(`clip A ends at ${String(trimmed.endTimelineSec)} s, not ${String(wantedEnd)} s`);
        }
        if (
          !same(trimmed.startTimelineSec, oldA.startTimelineSec) ||
          !same(trimmed.clipInContentSec, oldA.clipInContentSec)
        ) {
          problems.push('trimming the end of clip A moved its start or the part of its content it shows');
        }
        if (!changesPlacementField(result, clipAId, ['endTimelineSec', 'durationSec'])) {
          problems.push('its changes do not report the new end of clip A');
        }
        const wet = await exportMaster('trim');
        // Before the new end, and all of clip B, are the baseline; after the new end clip A is gone. The
        // end is a position in seconds like a start, so one sample either side of it is not judged.
        const kept = compareSamples(base, wet.wav, [{ startSec: 0, endSec: wantedEnd - quantumSec }, clipSpan(oldB)]);
        if (kept.bitIdentical !== 2) {
          problems.push(
            `the kept part of clip A or clip B differs from the baseline by up to ${kept.maxAbsDiff.toExponential(2)}`,
          );
        }
        const after = silenceOf(wet.wav, { startSec: wantedEnd + quantumSec, endSec: oldB.startTimelineSec });
        if (after.maxAbs > SILENCE_MAX_ABS) {
          problems.push(`clip A is still heard after its new end (up to ${after.maxAbs.toExponential(2)})`);
        }
        return {
          note:
            `clip A ends at ${String(trimmed.endTimelineSec)} s (cut ${String(TRIM_CUT_SEC)} s, level ${String(round(20 * Math.log10(cutRms), 1))} dBFS before); ` +
            'silent after the new end, the rest bit-identical; undo restored the clip and the master',
          problems,
          report: {
            cutSec: TRIM_CUT_SEC,
            newEndSec: trimmed.endTimelineSec,
            cutPartBaselineRms: round(cutRms, 6),
            tolerance: { silenceMaxAbs: SILENCE_MAX_ABS },
            keptBitIdentical: kept.bitIdentical === 2,
            keptMaxAbsDiff: kept.maxAbsDiff,
            afterEnd: { maxAbs: after.maxAbs, nonZeroSamples: after.nonZeroSamples },
            warnings: warningCodes(result),
            consistency: consistency.problems,
          },
        };
      }),
    { check: true },
  );

  /**
   * A copy of clip A to an empty place after the end of the baseline, taken back by the revert recipe
   * of the copy: the end user's consent that the recipe asks for is given by the scenario, which made
   * the copy itself.
   */
  const copyCheck = (mode: 'window' | 'full') => async () =>
    undoableCheck(`copy ${mode} of clip A`, async (frame) => {
      requires('arrangement.v1');
      const base = needBaseline();
      const rate = base.sampleRateHz;
      const quantumSec = POSITION_QUANTUM_SAMPLES / rate;
      const source = placementOf(frame.before, clipAId);
      const sourceSpan = clipSpan(source);
      const baselineSec = lengthSec(base);
      const startSec = round(baselineSec + COPY_GAP_SEC, 6);
      const { result, state, consistency } = await write(
        'arrangement.copy',
        {
          sources: [{ placementId: clipAId }],
          mode,
          toTrackId: source.trackId,
          startTimelineSec: startSec,
          expectedArrangementRevision: frame.before.arrangementRevision,
        },
        { frame, restore: 'revert' },
      );
      const problems = [
        ...consistency.problems,
        ...copyConsistency(result, state, source, mode, source.trackId, startSec),
      ];
      const wet = await exportMaster(`copy ${mode}`);
      const untouched = compareSamples(base, wet.wav, [{ startSec: 0, endSec: baselineSec }]);
      if (untouched.bitIdentical !== 1) {
        problems.push(
          `the master up to the end of the baseline differs from it by up to ${untouched.maxAbsDiff.toExponential(2)}`,
        );
      }
      const gap = silenceOf(wet.wav, { startSec: baselineSec, endSec: startSec - quantumSec });
      if (gap.maxAbs > SILENCE_MAX_ABS) {
        problems.push(`the gap before the copy is not silent (up to ${gap.maxAbs.toExponential(2)})`);
      }
      const placedAt = placedDifference(base, wet.wav, sourceSpan, startSec);
      const exact = placedAt.maxAbsDiff;
      if (exact > SHIFTED_MAX_ABS_DIFF) {
        problems.push(
          `the copy in the master differs from its source in the baseline by up to ${exact.toExponential(2)}`,
        );
      }
      const copySpan: Span = { startSec, endSec: startSec + source.durationSec };
      const levelDb = levelRatioDb(rmsOf(base, sourceSpan), rmsOf(wet.wav, copySpan));
      if (Math.abs(lengthSec(wet.wav) - copySpan.endSec) > 1 / rate + TIMELINE_EPSILON_SEC) {
        problems.push(
          `the master lasts ${String(round(lengthSec(wet.wav), 4))} s, the copy ends at ${String(round(copySpan.endSec, 4))} s`,
        );
      }
      const recipe = frame.revert;
      return {
        note:
          `the ${mode} copy sounds at ${String(startSec)} s as clip A does (${levelDb === null ? 'level unmeasured' : `${String(round(levelDb, 2))} dB`}, ` +
          'bit-identical); the part before it is the baseline; the revert recipe removed it again',
        problems,
        report: {
          mode,
          startTimelineSec: startSec,
          durationSec: source.durationSec,
          tolerance: { maxAbsDiff: SHIFTED_MAX_ABS_DIFF, silenceMaxAbs: SILENCE_MAX_ABS },
          copyMaxAbsDiff: exact,
          startLagSamples: placedAt.lagSamples,
          copyLevelDb: levelDb === null ? null : round(levelDb, 3),
          baselinePartBitIdentical: untouched.bitIdentical === 1,
          gapMaxAbs: gap.maxAbs,
          revert: recipe === undefined ? null : { method: recipe.method, requiresConsent: recipe.requiresConsent },
          warnings: warningCodes(result),
          consistency: consistency.problems,
        },
      };
    });

  await step('copy window of clip A', copyCheck('window'), { check: true });
  await step('copy full of clip A', copyCheck('full'), { check: true });

  await step(
    'delete a copy of clip A',
    async () =>
      undoableCheck('delete a copy of clip A', async (frame) => {
        requires('arrangement.v1');
        const base = needBaseline();
        const source = placementOf(frame.before, clipAId);
        const sourceSpan = clipSpan(source);
        const startSec = round(lengthSec(base) + COPY_GAP_SEC, 6);
        // The clip to delete is a copy this check made: the delete of an original clip would leave the
        // scenario without it (OpenTune cannot undo a delete). The copy's own revert recipe stays in
        // the frame until the delete has taken the copy away, so that a check that fails half-way
        // does not leave the copy behind.
        const copied = await write(
          'arrangement.copy',
          {
            sources: [{ placementId: clipAId }],
            mode: 'window',
            toTrackId: source.trackId,
            startTimelineSec: startSec,
            expectedArrangementRevision: frame.before.arrangementRevision,
          },
          { frame, restore: 'revert' },
        );
        const problems = [
          ...copied.consistency.problems,
          ...copyConsistency(copied.result, copied.state, source, 'window', source.trackId, startSec),
        ];
        const copyId = entityIds(copied.result, 'created', 'placement')[0];
        if (copyId === undefined) throw new Error('the copy made for the delete has no placementId');
        const heard = await exportMaster('before delete');
        const heardDiff = placedDifference(base, heard.wav, sourceSpan, startSec).maxAbsDiff;
        if (heardDiff > SHIFTED_MAX_ABS_DIFF) {
          problems.push(
            `the copy made for the delete is not heard as clip A (up to ${heardDiff.toExponential(2)} off)`,
          );
        }
        // Without the end user's consent the delete is refused and changes nothing.
        const refused = await refusedWith(
          'arrangement.edit',
          {
            expectedArrangementRevision: copied.state.arrangementRevision,
            ops: [{ op: 'delete', placementIds: [copyId] }],
          },
          'INVALID_ARGUMENT',
          'confirm_required',
        );
        if (refused !== undefined) problems.push(refused);
        const afterRefusal = await readProject(need());
        const stillThere = afterRefusal.placements.some((p) => p.placementId === copyId);
        if (!stillThere) {
          frame.revert = undefined;
          problems.push('the delete without confirm removed the copy');
        } else {
          problems.push(
            ...projectSnapshotProblems(copied.state, afterRefusal).map((p) => `delete without confirm: ${p}`),
          );
        }
        let deleted: Awaited<ReturnType<typeof write>> | undefined;
        if (stillThere) {
          deleted = await write('arrangement.edit', {
            expectedArrangementRevision: afterRefusal.arrangementRevision,
            ops: [{ op: 'delete', placementIds: [copyId] }],
            confirm: true,
          });
          frame.revert = undefined;
          problems.push(...deleted.consistency.problems);
          const removed = entityIds(deleted.result, 'removed', 'placement');
          if (removed.length !== 1 || removed[0] !== copyId) {
            problems.push(`removed must name the copy once (it says ${removed.join(', ') || 'nothing'})`);
          }
        }
        const state = deleted?.state ?? afterRefusal;
        const left = projectSnapshotProblems(frame.before, state);
        if (left.length > 0) throw new Unrestored(`after the delete the project is not as it was: ${left.join('; ')}`);
        const after = await compareWithBaseline('after delete', problems, 'the master after the delete');
        const undoRaw = deleted?.result.undo;
        const undo = isObject(undoRaw) ? undoRaw : undefined;
        return {
          note:
            `the copy at ${String(startSec)} s was heard (bit-identical to clip A), the delete without confirm was refused, ` +
            `the delete with confirm took it away and the master equals the baseline${after.bitIdentical ? ' bit for bit' : ''}`,
          problems,
          report: {
            startTimelineSec: startSec,
            copyBeforeDeleteMaxAbsDiff: heardDiff,
            refusedWithoutConfirm: refused === undefined,
            afterDelete: {
              bitIdentical: after.bitIdentical,
              maxAbsDiff: after.maxAbsDiff,
              lengthsEqual: after.lengthsEqual,
            },
            undo:
              undo === undefined
                ? null
                : {
                    undoable: undo.undoable === true,
                    reason: typeof undo.reason === 'string' ? undo.reason : null,
                    revert: isObject(undo.revert),
                  },
            warnings: deleted === undefined ? [] : warningCodes(deleted.result),
          },
        };
      }),
    { check: true },
  );

  // --- track volume and the duplicate and delete of a track ---------------------------------------

  await step(
    'track volume -6 dB',
    async () => {
      requires('tracks.v1');
      const base = needBaseline();
      const before = await readProject(need());
      const clipA = placementOf(before, clipAId);
      const spanA = clipSpan(clipA);
      const spanB = clipSpan(placementOf(before, clipBId));
      const trackA = clipA.trackId;
      const problems: string[] = [];
      const cases: Record<string, unknown>[] = [];
      const name = 'track volume -6 dB';
      // Only clip A sounds on its track, so the level over clip A is the level of the track.
      const volumeCase = async (label: string, setting: Json, expectedDb: number) =>
        runCase(name, cases, problems, label, async (frame) => {
          const { consistency, state } = await write(
            'track.set',
            { tracks: [{ trackId: trackA, ...setting }] },
            { frame, restore: 'revert' },
          );
          const found = [...consistency.problems];
          const track = trackOf(state, trackA);
          const wantedLinear = 10 ** (expectedDb / 20);
          if (Math.abs(track.volumeLinear - wantedLinear) > 1e-4) {
            found.push(
              `the track reads back a volume of ${String(track.volumeLinear)}, expected ${String(round(wantedLinear, 4))}`,
            );
          }
          if (track.volumeDb === null || Math.abs(track.volumeDb - expectedDb) > 1e-3) {
            found.push(
              `the track reads back ${String(track.volumeDb)} dB, expected ${String(round(expectedDb, 3))} dB`,
            );
          }
          const wet = await exportMaster(label);
          const measuredDb = levelDifferenceDb(base, wet.wav, spanA);
          if (measuredDb === null) {
            found.push('clip A is silent in the baseline but not in the export');
          } else if (Math.abs(measuredDb - expectedDb) > TRACK_VOLUME_TOLERANCE_DB) {
            found.push(
              `clip A changed by ${String(round(measuredDb))} dB, expected ${String(round(expectedDb, 2))} +- ${String(TRACK_VOLUME_TOLERANCE_DB)} dB`,
            );
          }
          const other = compareSamples(base, wet.wav, [spanB]);
          if (other.bitIdentical !== 1) {
            found.push(`clip B differs from the baseline by up to ${other.maxAbsDiff.toExponential(2)}`);
          }
          return {
            note: label,
            problems: found,
            report: {
              expectedDb: round(expectedDb, 4),
              toleranceDb: TRACK_VOLUME_TOLERANCE_DB,
              measuredDb: measuredDb === null ? null : round(measuredDb, 3),
              volumeDb: track.volumeDb,
              volumeLinear: track.volumeLinear,
              clipB: { bitIdentical: other.bitIdentical === 1, maxAbsDiff: other.maxAbsDiff },
              consistency: consistency.problems,
            },
          };
        });
      const first = await volumeCase(
        `volumeDb ${String(TRACK_VOLUME_DB)}`,
        { volumeDb: TRACK_VOLUME_DB },
        TRACK_VOLUME_DB,
      );
      const second = await volumeCase(
        `volumeLinear ${String(TRACK_VOLUME_LINEAR)}`,
        { volumeLinear: TRACK_VOLUME_LINEAR },
        TRACK_VOLUME_LINEAR_DB,
      );
      checks[name] = { trackId: trackA, cases };
      if (problems.length > 0) throw new Error(problems.join('; '));
      const measured = (outcome: Outcome | undefined) => {
        const value = outcome?.report.measuredDb;
        return typeof value === 'number' ? `${String(value)} dB` : 'unmeasured';
      };
      return `volumeDb ${String(TRACK_VOLUME_DB)} measured ${measured(first)}, volumeLinear ${String(TRACK_VOLUME_LINEAR)} measured ${measured(second)}; clip B untouched; each revert restored the track and the master`;
    },
    { check: true },
  );

  /**
   * A duplicate of the track of clip A, taken back by the revert recipe of the duplicate (a
   * track.delete, for which the scenario gives the consent: it made the track). The master over clip
   * A is the sum of two identical signals, and the notes of the content of clip A read back as before.
   */
  const duplicateCheck = (mode: 'clone' | 'share') => async () =>
    undoableCheck(`duplicate track ${mode}`, async (frame) => {
      requires('tracks.v1');
      const base = needBaseline();
      const rate = base.sampleRateHz;
      const clipA = placementOf(frame.before, clipAId);
      const spanA = clipSpan(clipA);
      const notesBefore = await readNotes(need(), clipA.contentId);
      frame.afterRestore = async () => {
        const notesAfter = await readNotes(need(), clipA.contentId);
        return JSON.stringify(notesAfter) === JSON.stringify(notesBefore)
          ? []
          : ['the notes of the content of clip A read back differently after the revert'];
      };
      const { result, state, consistency } = await write(
        'track.duplicate',
        { trackId: clipA.trackId, mode },
        { frame, restore: 'revert' },
      );
      const problems = [
        ...consistency.problems,
        ...duplicateConsistency(result, frame.before, state, clipA.trackId, mode),
      ];
      const recipe = frame.revert;
      if (recipe?.method !== 'track.delete')
        problems.push('the revert recipe of the duplicate is not a track.delete call');
      const wet = await exportMaster(`duplicate track ${mode}`);
      const coherent = coherentSumOf(base, wet.wav, spanA);
      problems.push(...coherent.problems);
      const rest = compareSamples(base, wet.wav, [{ startSec: spanA.endSec, endSec: lengthSec(base) }]);
      if (rest.bitIdentical !== 1) {
        problems.push(`the master after clip A differs from the baseline by up to ${rest.maxAbsDiff.toExponential(2)}`);
      }
      if (Math.abs(lengthSec(wet.wav) - lengthSec(base)) > 1 / rate + TIMELINE_EPSILON_SEC) {
        problems.push('the duplicate changed the length of the master');
      }
      return {
        note:
          `${mode}: the master over clip A is ${coherent.levelDb === null ? 'unmeasured' : `${String(round(coherent.levelDb, 2))} dB`} ` +
          `above the baseline (the sum of two equal signals, ${String(round(COHERENT_SUM_DB, 2))} dB), the rest is the baseline; ` +
          'the revert recipe deleted the new track and the notes of clip A read back as before',
        problems,
        report: {
          mode,
          newTrackId: typeof result.newTrackId === 'number' ? result.newTrackId : null,
          tolerance: { levelDb: COHERENT_SUM_TOLERANCE_DB, maxAbsDiff: COHERENT_SUM_MAX_ABS_DIFF },
          clipALevelDb: coherent.levelDb === null ? null : round(coherent.levelDb, 3),
          clipAMaxAbsDiffFromTwiceBaseline: coherent.maxAbsDiff,
          restBitIdentical: rest.bitIdentical === 1,
          revert: recipe === undefined ? null : { method: recipe.method, requiresConsent: recipe.requiresConsent },
          warnings: warningCodes(result),
          noteCount: notesBefore.length,
          consistency: consistency.problems,
        },
      };
    });

  await step('duplicate track clone', duplicateCheck('clone'), { check: true });
  await step('duplicate track share', duplicateCheck('share'), { check: true });

  await step(
    'delete a duplicated track',
    async () =>
      undoableCheck('delete a duplicated track', async (frame) => {
        requires('tracks.v1');
        const base = needBaseline();
        const clipA = placementOf(frame.before, clipAId);
        const spanA = clipSpan(clipA);
        // The track to delete is a duplicate this check made, and the delete is called as itself, not
        // through the revert recipe of the duplicate, which stays in the frame until the delete has
        // taken the track away.
        const duplicated = await write(
          'track.duplicate',
          { trackId: clipA.trackId, mode: 'clone' },
          { frame, restore: 'revert' },
        );
        const problems = [
          ...duplicated.consistency.problems,
          ...duplicateConsistency(duplicated.result, frame.before, duplicated.state, clipA.trackId, 'clone'),
        ];
        const newTrackId = num(duplicated.result, 'newTrackId', 'the track.duplicate result');
        const heard = await exportMaster('before track delete');
        const coherent = coherentSumOf(base, heard.wav, spanA);
        problems.push(...coherent.problems.map((p) => `before the delete: ${p}`));
        const refused = await refusedWith(
          'track.delete',
          { trackId: newTrackId, expectedArrangementRevision: duplicated.state.arrangementRevision },
          'INVALID_ARGUMENT',
          'confirm_required',
        );
        if (refused !== undefined) problems.push(refused);
        const afterRefusal = await readProject(need());
        const stillShown = afterRefusal.tracks.find((t) => t.trackId === newTrackId)?.visible === true;
        if (!stillShown) {
          frame.revert = undefined;
          problems.push('the delete without confirm removed the track');
        } else {
          problems.push(
            ...projectSnapshotProblems(duplicated.state, afterRefusal).map((p) => `delete without confirm: ${p}`),
          );
        }
        let deleted: Awaited<ReturnType<typeof write>> | undefined;
        if (stillShown) {
          deleted = await write('track.delete', {
            trackId: newTrackId,
            expectedArrangementRevision: afterRefusal.arrangementRevision,
            confirm: true,
          });
          frame.revert = undefined;
          problems.push(
            ...deleted.consistency.problems,
            ...trackDeleteConsistency(deleted.result, afterRefusal, deleted.state, newTrackId),
          );
        }
        const state = deleted?.state ?? afterRefusal;
        const left = projectSnapshotProblems(frame.before, state);
        if (left.length > 0) throw new Unrestored(`after the delete the project is not as it was: ${left.join('; ')}`);
        const after = await compareWithBaseline('after track delete', problems, 'the master after the delete');
        const undoRaw = deleted?.result.undo;
        const undo = isObject(undoRaw) ? undoRaw : undefined;
        return {
          note:
            `the track duplicate of track ${String(clipA.trackId)} (track ${String(newTrackId)}) was heard (+${String(round(coherent.levelDb ?? Number.NaN, 2))} dB), ` +
            'the delete without confirm was refused, the delete with confirm removed it, trackIdMap agrees with the project, ' +
            `and the master equals the baseline${after.bitIdentical ? ' bit for bit' : ''}`,
          problems,
          report: {
            deletedTrackId: newTrackId,
            trackIdMap: deleted === undefined ? null : (deleted.result.trackIdMap ?? null),
            refusedWithoutConfirm: refused === undefined,
            duplicateLevelDb: coherent.levelDb === null ? null : round(coherent.levelDb, 3),
            afterDelete: {
              bitIdentical: after.bitIdentical,
              maxAbsDiff: after.maxAbsDiff,
              lengthsEqual: after.lengthsEqual,
            },
            undo:
              undo === undefined
                ? null
                : {
                    undoable: undo.undoable === true,
                    reason: typeof undo.reason === 'string' ? undo.reason : null,
                    revert: isObject(undo.revert),
                  },
            possiblyStaleEntries: deleted?.result.possiblyStaleEntries ?? null,
            warnings: deleted === undefined ? [] : warningCodes(deleted.result),
          },
        };
      }),
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
              // The merge took effect, so a check that cannot run is a failure of the check, not a refused merge.
              const why = 'the two split clips cannot be found for the merge check';
              problems.push(`the merge was applied, but checking its result failed: ${why}`);
              merge = { applied: true, method: revert.method, checkFailed: why };
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

  // The batch imports come last: they add tracks and their revert (a delete) leaves the imported
  // tracks shown, so no check after them could compare the track list with its first state. They
  // take their own imports back with the revert recipe and compare the project and the master with
  // the baseline, so the order costs the checks before nothing. They do not use the ids of clip A and
  // clip B, which a merge after the split check replaces; the baseline remembers where the clips lie.
  await step(
    'batch import sequential and separateTracks',
    async () => {
      requires('arrangement.v1', 'whose delete the revert of an import needs');
      const base = needBaseline();
      if (toneA === undefined || toneB === undefined || filesA === undefined || filesB === undefined) {
        throw new Error('no generated audio');
      }
      if (baselineSpans === undefined) throw new Error('no baseline spans');
      const spanA = baselineSpans.a;
      const rate = base.sampleRateHz;
      const sources = [decodeWav(toneA.wav), decodeWav(toneB.wav)];
      const [sourceA, sourceB] = sources;
      if (sourceA === undefined || sourceB === undefined) throw new Error('no decoded audio');
      if (sourceA.sampleRateHz !== rate || sourceB.sampleRateHz !== rate) {
        throw new Error('the generated audio and the master have different sample rates');
      }
      // The mixer scales a mono source (for example by a pan law); the factor is read off clip A of the
      // baseline, which holds nothing else, and the scenario checks that clip A really is a scaled copy
      // of its source, so the sum an import must give can be predicted from the sources alone.
      const lengthA = Math.round((spanA.endSec - spanA.startSec) * rate);
      const gain = fitGain(sourceA.mono.subarray(0, lengthA), base.mono, spanA.startSec, rate);
      const fitMaxAbsDiff = fitError(sourceA.mono.subarray(0, lengthA), base.mono, spanA.startSec, gain, rate);
      if (fitMaxAbsDiff > IMPORT_MAX_ABS_DIFF) {
        throw new Error(
          `clip A in the baseline master is not a scaled copy of its source (up to ${fitMaxAbsDiff.toExponential(2)} off ` +
            `with a factor of ${String(round(gain, 6))}), so the sum of an import cannot be predicted`,
        );
      }
      const pathA = filesA.wavPath;
      const pathB = filesB.wavPath;
      const name = 'batch import sequential and separateTracks';
      const cases: Record<string, unknown>[] = [];
      const problems: string[] = [];
      const importCase = (layout: 'sequential' | 'separateTracks', startTimelineSec: number | undefined) =>
        runCase(
          name,
          cases,
          problems,
          layout,
          async (frame) => {
            const result = await runJob(
              need(),
              'import.start',
              {
                items: [{ path: pathA }, { path: pathB }],
                layout,
                newTrack: true,
                ...(startTimelineSec === undefined ? {} : { startTimelineSec }),
                generateNotes: false,
                focus: false,
              },
              'import',
              timeoutMs,
            );
            if (!isObject(result)) throw new Error('the import result is not an object');
            // The clips are in the project from here on: whatever goes wrong, the revert removes them.
            const created = entityIds(result, 'created', 'placement');
            let state: ProjectState;
            try {
              state = await readProject(need());
            } catch (error) {
              throw new Unrestored(`the project cannot be read after the import: ${messageOf(error)}`);
            }
            const found: string[] = [];
            let recipe = revertOf(result);
            const givenByInstance = recipe !== undefined;
            if (recipe === undefined) {
              // The specification gives an import a revert recipe (a delete) when the instance reports
              // arrangement.v1. A result without one is a finding; the scenario made these clips, so it
              // takes them back with the delete itself and goes on measuring.
              const undo = isObject(result.undo) ? result.undo : {};
              found.push(
                `import.start gives no revert recipe (undo reason ${typeof undo.reason === 'string' ? undo.reason : 'missing'}, ` +
                  `warnings ${warningCodes(result).join(', ') || 'none'}) although the instance reports arrangement.v1, ` +
                  'whose delete the specification names as the revert; the clips were deleted by a call the scenario built',
              );
              if (created.length === 0) {
                throw new Unrestored('import.start gives no revert recipe and names no created clip to delete');
              }
              recipe = {
                method: 'arrangement.edit',
                params: {
                  expectedArrangementRevision: state.arrangementRevision,
                  ops: [{ op: 'delete', placementIds: created }],
                },
                requiresConsent: true,
              };
            }
            frame.revert = recipe;
            const clips = importedClips(result);
            found.push(
              ...writeConsistency(result, state).problems,
              ...importLayoutProblems(layout, clips, state, startTimelineSec),
            );
            const wet = await exportMaster(`import ${layout}`);
            const placed = clips.flatMap((clip, k) => {
              const read = state.placements.find((p) => p.placementId === clip.placementId);
              const source = sources[k];
              return read === undefined || source === undefined
                ? []
                : [{ samples: source.mono, startSec: read.startTimelineSec }];
            });
            const sum = bestSumDifference(base, wet.wav, placed, gain, { startSec: 0, endSec: lengthSec(wet.wav) });
            if (sum.maxAbsDiff > IMPORT_MAX_ABS_DIFF) {
              found.push(
                `the master differs from the baseline plus the imported audio by up to ${sum.maxAbsDiff.toExponential(2)} at ${String(sum.timeSec)} s`,
              );
            }
            const onsets: Record<string, unknown>[] = [];
            if (layout === 'sequential') {
              // Each clip sounds alone, so its first sound is where the project says the clip starts.
              for (const [k, clip] of clips.entries()) {
                const source = sources[k];
                if (source === undefined) continue;
                // The same measure on the source, scaled and put where the project says the clip starts:
                // the window that finds an onset reaches a little before the sound in both.
                const expected = new Float64Array(Math.ceil((clip.startTimelineSec + clip.durationSec + 0.1) * rate));
                expected.set(
                  source.mono.map((v) => v * gain),
                  Math.round(clip.startTimelineSec * rate),
                );
                const search = [clip.startTimelineSec - 0.05, clip.startTimelineSec + 1] as const;
                const expectedSec = onsetOf(
                  { ...source, channels: [expected], mono: expected },
                  ...search,
                  ONSET_LEVEL,
                );
                const heard = onsetOf(wet.wav, ...search, ONSET_LEVEL);
                if (expectedSec === null || heard === null) {
                  found.push(`the first sound of imported clip ${String(k + 1)} cannot be found`);
                  onsets.push({ clip: k + 1, expectedSec: null, measuredSec: null });
                  continue;
                }
                if (Math.abs(heard - expectedSec) > ONSET_TOLERANCE_SEC) {
                  found.push(
                    `imported clip ${String(k + 1)} starts sounding at ${String(round(heard, 5))} s, expected ${String(round(expectedSec, 5))} s ` +
                      `+- ${String(ONSET_TOLERANCE_SEC * 1000)} ms`,
                  );
                }
                onsets.push({ clip: k + 1, expectedSec: round(expectedSec, 5), measuredSec: round(heard, 5) });
              }
            }
            return {
              note: layout,
              problems: found,
              report: {
                layout,
                requestedStartSec: startTimelineSec ?? null,
                clips: clips.map((clip) => ({
                  trackId: clip.trackId,
                  startTimelineSec: clip.startTimelineSec,
                  durationSec: clip.durationSec,
                })),
                tolerance: { maxAbsDiff: IMPORT_MAX_ABS_DIFF, onsetSec: ONSET_TOLERANCE_SEC },
                sumMaxAbsDiff: sum.maxAbsDiff,
                startLagSamples: sum.lagSamples,
                onsets,
                revert: { method: recipe.method, requiresConsent: recipe.requiresConsent, givenByInstance },
                warnings: warningCodes(result),
              },
            };
          },
          // A batch import shows the tracks it needs and a delete does not hide them again.
          { ignoreTrackVisibility: true },
        );
      await importCase('sequential', IMPORT_START_SEC);
      await importCase('separateTracks', undefined);
      checks[name] = { gainFactor: round(gain, 6), gainFitMaxAbsDiff: fitMaxAbsDiff, cases };
      if (problems.length > 0) throw new Error(problems.join('; '));
      return (
        `sequential: the second clip starts where the first ends and both sound where the project says, from ${String(IMPORT_START_SEC)} s; ` +
        'separateTracks: both clips start at 0 on two successive tracks and the master is the baseline plus both; ' +
        'each revert removed the clips and restored the master'
      );
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
      moveDeltaSec: MOVE_DELTA_SEC,
      moveShiftToleranceSec: MOVE_SHIFT_TOLERANCE_SEC,
      trimCutSec: TRIM_CUT_SEC,
      copyGapSec: COPY_GAP_SEC,
      shiftedMaxAbsDiff: SHIFTED_MAX_ABS_DIFF,
      positionQuantumSamples: POSITION_QUANTUM_SAMPLES,
      trackVolumeDb: TRACK_VOLUME_DB,
      trackVolumeLinear: TRACK_VOLUME_LINEAR,
      trackVolumeToleranceDb: TRACK_VOLUME_TOLERANCE_DB,
      coherentSumDb: round(COHERENT_SUM_DB, 4),
      coherentSumToleranceDb: COHERENT_SUM_TOLERANCE_DB,
      coherentSumMaxAbsDiff: COHERENT_SUM_MAX_ABS_DIFF,
      importStartSec: IMPORT_START_SEC,
      onsetWindowSec: ONSET_WINDOW_SEC,
      onsetLevel: ONSET_LEVEL,
      onsetToleranceSec: ONSET_TOLERANCE_SEC,
      importMaxAbsDiff: IMPORT_MAX_ABS_DIFF,
    },
    checks,
    timings,
    dataDir,
    templateSkipped: target.stats?.templateSkipped ?? null,
    busyDiagnostics: diagnostics,
  };
}
