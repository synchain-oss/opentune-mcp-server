// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The effects scenario against a started OpenTune executable: it proves that what a write reports
// is what the instance then holds, and that what the write says it changed is what changed in the
// exported audio, and nothing else. It does not judge how good the correction sounds.
//
// Three kinds of check:
//
// - Report consistency. After every write, the `after` value of each change equals the value read
//   back at once, and the tokens of the result equal those of a fresh read. Only the fields the
//   scenario reads back are compared; any other field is listed (unreadFields), not a problem, since
//   fields are only ever added. After edit.undo, the notes, the pitch shift and the time-grid
//   handles read back equal the snapshot taken before the write.
// - Differential effects. The clip is exported before the edit (the baseline) and after it; the same
//   F0 estimator (test/support/f0-estimator.ts) reads both files. For every edited note only frames
//   voiced in both files count, and max(80 ms, 20 % of the note) is left out at both ends; the median
//   difference must lie within PITCH_TOLERANCE_CENTS of the expected change. The time shift is
//   measured by cross-correlation of the amplitude envelopes (test/support/time-shift.ts), not by F0.
// - Wet and dry. An edited note differs from the baseline, notes that were not edited do not: notes
//   away from an edit are compared sample by sample (UNEDITED_MAX_ABS_DIFF_*); a note within the reach
//   of an edit's re-synthesis (RESYNTH_*) is either bit-identical or the same sound in another phase.
//   No export is silent, and an export that is not corrected is listed in dryContents. A race: +100
//   cents, export.start, at once -100 cents; the file must be one whole version or the job must fail
//   with REVISION_CONFLICT(changed_during_export).
//
// The checks are meant for an instance whose vocoder renders every corrected note, that is with
// OpenTune's hybrid mode off: with it on, OpenTune renders small corrections on a lighter path
// instead, so the checks of small corrections can fail for a reason of OpenTune's own. The scenario
// does not change that preference; it starts its instance from the data template the caller gives
// (OTCP_E2E_EFFECTS_DATA_TEMPLATE, else OTCP_TARGET_DATA_TEMPLATE), records the hybrid mode every
// export reports, and says at the top of the report when it was on. The checks are judged the same
// either way.
//
// Steps and their results follow the smoke scenario (test/e2e/smoke.ts): PASS, FAIL, SKIP (a
// capability the scenario needs is not reported, or the audio given cannot answer the check) and
// FLAKY-SKIP (only an inference backend that cannot be initialised). A failed set-up step stops the
// scenario; a failed check does not stop the checks after it, because each check puts the clip back
// as it was (edit.undo) and verifies that it did, also when it fails half-way. The undo of a write
// that took effect is recorded before anything else is read from its result; a write that took
// effect without a usable undoId cannot be taken back, and like an undo that does not restore the
// clip it stops the checks after it. The instance is started and ended by the exe target
// (test/contract/exe-target.ts), exactly as in the smoke scenario.
//
// The audio is generated (test/support/harmonic-tone.ts): five notes with silence between them, one
// of them 40 cents sharp. OTCP_E2E_EFFECTS_AUDIO replaces it with a WAV file of the caller's; then
// only the checks that do not need to know the pitch in advance run, and the report says the audio
// was external, without its name or path.

import { performance } from 'node:perf_hooks';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { parseDiscoveryFile } from '../../src/discovery/file.js';
import { OtcpError } from '../../src/errors/tool-error.js';
import { OtcpSession, type HelloInfo, type Json } from '../../src/otcp/client.js';
import { checkDataTemplate, exeConfigFromEnv, exeTarget, type ExeTargetOptions } from '../contract/exe-target.js';
import type { TargetInstance } from '../contract/target.js';
import { ESTIMATOR_ERROR_CENTS, centsBetween, estimateF0, median } from '../support/f0-estimator.js';
import { generateTone, writeToneFiles, type Tone, type ToneFiles } from '../support/harmonic-tone.js';
import { SHIFT_ERROR_SEC, estimateShift } from '../support/time-shift.js';
import { decodeWav, type DecodedWav } from '../support/wav-decode.js';
import {
  StepSkip,
  busyDiagnostics,
  classify,
  clean,
  isModalBusy,
  isObject,
  member,
  num,
  runJob,
  summarise,
  text,
  waitJob,
  type SmokeHooks,
  type StepReport,
  type StepResult,
} from './smoke.js';

// ---------------------------------------------------------------------------------------------
// tolerances, fixed once from measurements against a control-API build of OpenTune 1.8.0 (Windows,
// FCPE analysis, HiFi-GAN vocoder), with hybrid mode on and off; see docs/real-opentune-testing.md,
// "Effects scenario"

/**
 * How far the median pitch difference of a note may lie from the expected change, in cents.
 *
 * Noise floor: two exports of the unchanged clip were bit-identical (0 cents), and the estimator
 * stays within ESTIMATOR_ERROR_CENTS (2) of known harmonic tones. Above that floor the renderer
 * itself puts a note a few cents off its target. With hybrid mode on, the rendered baseline lay -3.9
 * to +0.8 cents from the source, and the measured changes were +101.1 and +105.1 cents for +100 cents
 * and +199.9 to +205.1 cents for +2 semitones, so up to 5.1 cents off; with it off (the vocoder
 * renders every note), -0.9 to +1.3 cents, +99.9 to +100.0 cents, +199.8 to +200.0 cents and -41.1
 * cents for the 40 cents sharp note, so up to 1.1 cents off. 15 cents is three times the larger of
 * the two, and still tells every effect apart from no effect: it is below half of the 40 cents that
 * AUTO has to take off the sharp note, and well below the 50 cents the smallest edit (100 cents) needs.
 */
export const PITCH_TOLERANCE_CENTS = 15;

/**
 * How far the measured time shift may lie from the expected one. Measured: 29.2 ms (hybrid mode on)
 * and 28.8 ms (off) for a 30 ms move (the audio right after the handle is compressed a little, so the
 * estimate falls just short), 0.0 ms at the notes away from it; the estimator is within
 * SHIFT_ERROR_SEC (2 ms). 5 ms leaves four times the larger measured deviation and stays far from
 * the 30 ms of the effect.
 */
export const SHIFT_TOLERANCE_SEC = 0.005;

/**
 * The largest sample difference allowed in notes away from a note or pitch edit (linear, full scale
 * 1.0): none. Measured bit-identical in every export, with hybrid mode on and off: every note before
 * an edited note (up to RESYNTH_PRE_ROLL_SEC before it), and every note past the reach of the edit's
 * re-synthesis (resynthesisReach).
 */
export const UNEDITED_MAX_ABS_DIFF_NOTES = 0;

/*
 * The reach of an edit's re-synthesis, measured with hybrid mode off (the vocoder renders every
 * corrected note): every note of the scenario's audio and of a second tone with phrases of notes
 * without gaps moved by +100 cents on its own (shiftCents, and setTargetPitch for two of them), and
 * one note also by -100 and by +10 cents:
 *
 * - The renderer synthesises the edited stretch again from shortly before the edited note to the end
 *   of its render block, and also the next block when that one begins within about 0.16 s after the
 *   edited note ends. Inside a phrase without gaps the stretch began 69 to 78 ms before the edited
 *   note, so in the note before it; after a silence it began in that silence (0.19 s before the note,
 *   0.17 s after the note before it). Blocks are split in silences: each gap of 0.355 s and more was a
 *   split, a phrase without gaps was one block. Taking the edit back gave a bit-identical export again.
 * - A note in that stretch is synthesised again as a whole, not only near the edit: the same pitch
 *   (median 0 cents) and the same level (0.0 dB), but in another phase, so its samples differ by about
 *   its own size (peak differences of -3.1 to -9.8 dBFS on notes that peak at -8 to -9.6 dBFS). A
 *   window of a few milliseconds around the edit would not cover it.
 * - Nothing before that stretch and nothing after it changed by a single sample.
 *
 * Hence three zones per unedited note, instead of one tolerance for all: the last
 * RESYNTH_PRE_ROLL_SEC before an edited note is not compared; the notes after an edited note, up to
 * and including the first one after a gap of at least PHRASE_GAP_SEC, are in the reach and may be
 * re-synthesised (then RESYNTH_MAX_RESIDUAL_DB applies, and their pitch is measured like every
 * note's); every other note must be bit-identical (UNEDITED_MAX_ABS_DIFF_NOTES).
 */

/**
 * Before an edited note, this much is not compared: where a note runs into the edited one, the
 * re-synthesis started up to 78 ms before it.
 */
export const RESYNTH_PRE_ROLL_SEC = 0.1;

/**
 * A gap between notes of at least this length ends a phrase: re-synthesis may reach the first note
 * after it, and no further. Every measured gap of 0.355 s and more split the render blocks.
 */
export const PHRASE_GAP_SEC = 0.3;

/**
 * A re-synthesised note within the reach of an edit must be the same sound in another phase: over its
 * inside (trimmed as for the F0 measurement), the energy of the difference left after aligning every
 * RESYNTH_WINDOW_SEC window by at most one period of the note, relative to the note's energy.
 * Measured: -25.1 to -40.3 dB on re-synthesised notes, against +2.2 to +3.0 dB on a note moved by 100
 * cents and -0.3 dB on one moved by 10 cents. -20 dB lies 5 dB above the worst re-synthesised note and
 * 20 dB below a 10 cents move; a stale, moved or silent note fails, and so does one that is louder or
 * quieter by more than about 1 dB.
 */
export const RESYNTH_MAX_RESIDUAL_DB = -20;

/** The windows of the aligned comparison. */
const RESYNTH_WINDOW_SEC = 0.1;

/**
 * The same for notes away from a moved time-grid handle. A grid change renders the clip again, and
 * the notes it did not move were not bit-identical: they differed by up to 1.1e-4 (-79 dBFS) from
 * the baseline, with hybrid mode on and off alike, far below the notes themselves (about -16 dBFS).
 * 1e-3 (-60 dBFS) is 20 dB above
 * that measurement and still 44 dB below the music, where a stale or shifted note would differ by
 * the size of the note itself.
 */
export const UNEDITED_MAX_ABS_DIFF_TIMING = 1e-3;

/** A note must have at least this many frames voiced in both files to be measured. */
export const MIN_VOICED_FRAMES = 20;

/** Left out at both ends of a note: max(EDGE_TRIM_SEC, EDGE_TRIM_FRACTION of its length). */
const EDGE_TRIM_SEC = 0.08;
const EDGE_TRIM_FRACTION = 0.2;
/** The F0 search band around the note's detected pitch: wide enough for every edit, too narrow for an octave error. */
const BAND_SEMITONES = 7;
/** The edits of the checks. */
const EDIT_CENTS = 100;
const PITCH_SHIFT_SEMITONES = 2;
const TIMING_SHIFT_SEC = 0.03;
/** The deliberately sharp note of the generated audio. */
const OFF_NOTE_CENTS = 40;
/** Around a moved handle, the window of the time-shift estimate. */
const SHIFT_WINDOW_SEC = 0.15;
/**
 * Notes shorter than this are not measured (trimmed at both ends they keep fewer than
 * MIN_VOICED_FRAMES frames of 10 ms) and not picked for edits.
 */
const MIN_NOTE_SEC = 0.4;
/** How often the render state is read while waiting for it to settle. */
const SETTLE_POLL_MS = 100;
/** Values read back must equal the values a result reported to within this (they are rounded). */
const READBACK_EPSILON = 1e-6;
/**
 * The explicit parameters every note gets before the baseline, so that no check depends on the
 * generator's defaults. retuneSpeed is mid-range, not 1: retuneSpeed 1 is a check of its own
 * ('setParams retuneSpeed 1'), because a build can render it at the wrong pitch.
 */
const FIXED_PARAMS = { retuneSpeed: 0.5, vibratoDepth: 0, pitchDriftScale: 1 } as const;

const DEFAULT_STEP_TIMEOUT_MS = 180_000;
const DEFAULT_TIMING_LENGTHS_SEC = [60, 240] as const;
const REQUIRED_CAPABILITIES = [
  'session.v1',
  'jobs.v1',
  'read.v1',
  'import.v1',
  'edit.v1',
  'export.v1',
  'history.v1',
] as const;

// ---------------------------------------------------------------------------------------------
// configuration

export interface EffectsConfig {
  readonly exe: ExeTargetOptions;
  /** How long one wait (analysis, a job, a render to settle) may take; 180 s unless given. */
  readonly stepTimeoutMs: number;
  /** Where the JSON report goes; none unless given. */
  readonly reportPath: string | undefined;
  /** A WAV file to use instead of the generated audio; undefined for the generated audio. */
  readonly audioPath: string | undefined;
  /** Lengths, in seconds, of the extra clips that are only timed; 60 and 240 unless given. */
  readonly timingLengthsSec: readonly number[];
  /** Which variable the data template of `exe` came from, for the report; null (or absent) for none. */
  readonly dataTemplateFrom?: DataTemplateSource | null;
}

/** The variables a data template can come from: the scenario's own wins over the shared one. */
export type DataTemplateSource = 'OTCP_E2E_EFFECTS_DATA_TEMPLATE' | 'OTCP_TARGET_DATA_TEMPLATE';

export type EffectsSetup = { readonly skip: string } | { readonly config: EffectsConfig };

function absoluteOrUndefined(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value === '') return undefined;
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

/**
 * Reads OTCP_TARGET_EXE (and its siblings), OTCP_E2E_EFFECTS_DATA_TEMPLATE, OTCP_E2E_EFFECTS_REPORT,
 * OTCP_E2E_REPORT, OTCP_E2E_STEP_TIMEOUT_MS, OTCP_E2E_EFFECTS_AUDIO and OTCP_E2E_EFFECTS_TIMING_SEC.
 *
 * OTCP_E2E_EFFECTS_DATA_TEMPLATE, when set, is the data template of this scenario's instance in place
 * of OTCP_TARGET_DATA_TEMPLATE (same meaning, same checks): the effects checks want an instance with
 * hybrid mode off, and the other scenarios need not run on that state. Which files make up that
 * state is the caller's business; the scenario only copies the folder.
 */
export function effectsSetupFromEnv(env: NodeJS.ProcessEnv = process.env): EffectsSetup {
  const shared = exeConfigFromEnv(env);
  if ('skip' in shared) return { skip: shared.skip };
  let exe = shared;
  let dataTemplateFrom: DataTemplateSource | null =
    shared.options.dataTemplate === undefined ? null : 'OTCP_TARGET_DATA_TEMPLATE';
  const ownTemplate = env.OTCP_E2E_EFFECTS_DATA_TEMPLATE;
  if (ownTemplate !== undefined && ownTemplate !== '') {
    checkDataTemplate(ownTemplate, 'OTCP_E2E_EFFECTS_DATA_TEMPLATE');
    exe = { options: { ...shared.options, dataTemplate: ownTemplate } };
    dataTemplateFrom = 'OTCP_E2E_EFFECTS_DATA_TEMPLATE';
  }
  let stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS;
  const raw = env.OTCP_E2E_STEP_TIMEOUT_MS;
  if (raw !== undefined && raw !== '') {
    stepTimeoutMs = Number(raw);
    if (!Number.isInteger(stepTimeoutMs) || stepTimeoutMs <= 0) {
      throw new Error('OTCP_E2E_STEP_TIMEOUT_MS must be a positive integer');
    }
  }
  // Its own report path, else effects.json next to the smoke report, else none.
  let reportPath = absoluteOrUndefined(env, 'OTCP_E2E_EFFECTS_REPORT');
  const smokeReport = absoluteOrUndefined(env, 'OTCP_E2E_REPORT');
  if (reportPath === undefined && smokeReport !== undefined) {
    reportPath = path.join(path.dirname(smokeReport), 'effects.json');
  }
  const audioPath = absoluteOrUndefined(env, 'OTCP_E2E_EFFECTS_AUDIO');
  if (audioPath !== undefined) {
    if (path.extname(audioPath).toLowerCase() !== '.wav')
      throw new Error('OTCP_E2E_EFFECTS_AUDIO must name a .wav file');
    if (!existsSync(audioPath) || !statSync(audioPath).isFile()) {
      throw new Error('OTCP_E2E_EFFECTS_AUDIO is not an existing file');
    }
  }
  let timingLengthsSec: readonly number[] = DEFAULT_TIMING_LENGTHS_SEC;
  const lengths = env.OTCP_E2E_EFFECTS_TIMING_SEC;
  if (lengths !== undefined && lengths !== '') {
    timingLengthsSec =
      lengths.trim() === 'none'
        ? []
        : lengths.split(',').map((part) => {
            const value = Number(part.trim());
            if (!(Number.isFinite(value) && value >= 2 && value <= 600)) {
              throw new Error(
                'OTCP_E2E_EFFECTS_TIMING_SEC must be "none" or a comma-separated list of 2 to 600 (seconds)',
              );
            }
            return value;
          });
  }
  return { config: { exe: exe.options, stepTimeoutMs, reportPath, audioPath, timingLengthsSec, dataTemplateFrom } };
}

// ---------------------------------------------------------------------------------------------
// the report

export interface EffectsReport {
  readonly schema: 'opentune-mcp-e2e-effects/1';
  readonly result: StepResult;
  readonly counts: Readonly<Record<StepResult, number>>;
  /** What a reader must know before reading the results (HYBRID_MODE_NOTICE); empty when nothing. */
  readonly notices: readonly string[];
  /**
   * Whether OpenTune's hybrid mode was on: true when session.info or any export reported it on,
   * false when all that reported it said off, null when nothing reported it. Each check has the
   * `processing` of its own exports.
   */
  readonly hybridMode: boolean | null;
  /** Which variable the instance's data template came from; null when none was copied in. */
  readonly dataTemplateFrom: DataTemplateSource | null;
  readonly startedAt: string;
  readonly totalMs: number;
  readonly steps: readonly StepReport[];
  readonly instance: { readonly protocol: string; readonly appVersion: string } | null;
  /**
   * The inference backend: what session.info reports for the instance, and what the export results
   * report as having produced the audio (they can differ: a session falls back to the CPU).
   */
  readonly backend: {
    readonly sessionInfo: string | null;
    readonly exports: readonly string[];
    readonly f0Model: string | null;
    readonly vocoderWeight: string | null;
  } | null;
  /** Where the audio came from and what it is; never a file name or a path. */
  readonly audio: Readonly<Record<string, number | string | boolean>> | null;
  /** The tolerances the checks used, with the error bounds of the estimators they rest on. */
  readonly tolerances: {
    readonly pitchCents: number;
    readonly shiftMs: number;
    readonly uneditedMaxAbsDiffNotes: number;
    readonly uneditedMaxAbsDiffTiming: number;
    readonly resynthPreRollMs: number;
    readonly phraseGapMs: number;
    readonly resynthMaxResidualDb: number;
    readonly minVoicedFrames: number;
    readonly estimatorErrorCents: number;
    readonly shiftEstimatorErrorMs: number;
  };
  /** What two exports of the unchanged clip, and the estimator against the known pitch, measured. */
  readonly noiseFloor: Readonly<Record<string, unknown>> | null;
  /** The measurements of every check, by step name. */
  readonly checks: Readonly<Record<string, unknown>>;
  /** Wall-clock times, in milliseconds. */
  readonly timings: Readonly<Record<string, unknown>>;
  readonly dataDir: string | null;
  readonly templateSkipped: number | null;
  readonly busyDiagnostics: string | null;
}

/** The first notice of a report whose instance had hybrid mode on. */
export const HYBRID_MODE_NOTICE =
  'Hybrid mode is on: checks of small corrections can fail because OpenTune itself renders small ' +
  'corrections on its lighter path instead of the vocoder; the checks are judged as usual. Run them ' +
  'on an instance with hybrid mode off (a data template given in OTCP_E2E_EFFECTS_DATA_TEMPLATE).';

/** What an export reported about how it was processed, kept per step. */
export interface ExportProcessing {
  readonly export: string;
  readonly hybridMode: boolean | null;
  readonly backend: string | null;
}

// ---------------------------------------------------------------------------------------------
// reading the clip

interface NoteRead {
  readonly index: number;
  readonly startContentSec: number;
  readonly endContentSec: number;
  readonly detectedMidi: number | null;
  readonly targetMidi: number;
  readonly offsetCents: number;
  readonly retuneSpeed: number;
  readonly vibratoDepth: number;
  readonly vibratoRateHz: number;
  readonly pitchDriftScale: number;
  readonly voiced: boolean;
  readonly corrected: boolean;
}

interface HandleRead {
  readonly handleId: string;
  readonly contentSec: number;
  readonly outputSec: number;
}

interface Tokens {
  readonly arrangementRevision: string;
  readonly revision: string;
  readonly gridRevision: string;
  readonly keyRevision: string;
}

/** What the scenario reads of the clip: its notes, pitch shift, time grid and tokens, after one write. */
interface ClipState {
  readonly tokens: Tokens;
  readonly notesRevision: string;
  readonly tuningHz: number;
  readonly notes: readonly NoteRead[];
  readonly pitchShift: { readonly semitones: number; readonly cents: number };
  readonly handles: readonly HandleRead[];
  readonly seeded: boolean;
}

const NOTE_FIELDS = [
  'startContentSec',
  'endContentSec',
  'detectedMidi',
  'targetMidi',
  'offsetCents',
  'retuneSpeed',
  'vibratoDepth',
  'vibratoRateHz',
  'pitchDriftScale',
  'voiced',
  'corrected',
] as const;

function bool(value: unknown, name: string, what: string): boolean {
  const v = member(value, name, what);
  if (typeof v !== 'boolean') throw new Error(`${what}.${name} is not a boolean`);
  return v;
}

function parseNote(value: unknown): NoteRead {
  const detected = member(value, 'detectedMidi', 'a note');
  return {
    index: num(value, 'index', 'a note'),
    startContentSec: num(value, 'startContentSec', 'a note'),
    endContentSec: num(value, 'endContentSec', 'a note'),
    detectedMidi: typeof detected === 'number' ? detected : null,
    targetMidi: num(value, 'targetMidi', 'a note'),
    offsetCents: num(value, 'offsetCents', 'a note'),
    retuneSpeed: num(value, 'retuneSpeed', 'a note'),
    vibratoDepth: num(value, 'vibratoDepth', 'a note'),
    vibratoRateHz: num(value, 'vibratoRateHz', 'a note'),
    pitchDriftScale: num(value, 'pitchDriftScale', 'a note'),
    voiced: bool(value, 'voiced', 'a note'),
    corrected: bool(value, 'corrected', 'a note'),
  };
}

function tokensOf(read: Json, contentId: string): Tokens {
  const asOf = member(read, 'asOf', 'the read result');
  const contents = member(asOf, 'contents', 'asOf');
  if (!Array.isArray(contents)) throw new Error('asOf.contents is not an array');
  const entry = (contents as unknown[]).find((c) => isObject(c) && c.contentId === contentId);
  if (entry === undefined) throw new Error('the read result carries no tokens for the clip');
  return {
    arrangementRevision: text(asOf, 'arrangementRevision', 'asOf'),
    revision: text(entry, 'revision', 'the tokens'),
    gridRevision: text(entry, 'gridRevision', 'the tokens'),
    keyRevision: text(entry, 'keyRevision', 'the tokens'),
  };
}

async function readState(session: OtcpSession, contentId: string): Promise<ClipState> {
  const notes: NoteRead[] = [];
  let cursor: string | null = null;
  let notesRevision: string;
  let tuningHz: number;
  do {
    const page: Json = await session.call(
      'content.getNotes',
      cursor === null ? { contentId, limit: 500 } : { contentId, limit: 500, cursor },
      30_000,
    );
    notesRevision = tokensOf(page, contentId).revision;
    tuningHz = num(page, 'tuningHz', 'content.getNotes');
    const list = member(page, 'notes', 'content.getNotes');
    if (!Array.isArray(list)) throw new Error('content.getNotes has no notes array');
    for (const note of list as unknown[]) notes.push(parseNote(note));
    const next = member(page, 'nextCursor', 'content.getNotes');
    cursor = typeof next === 'string' ? next : null;
  } while (cursor !== null);
  const details = await session.call('content.getDetails', { contentId }, 30_000);
  const shift = member(details, 'pitchShift', 'content details');
  const grid = member(details, 'timeGrid', 'content details');
  const handles = member(grid, 'handles', 'timeGrid');
  if (!Array.isArray(handles)) throw new Error('timeGrid.handles is not an array');
  return {
    tokens: tokensOf(details, contentId),
    notesRevision,
    tuningHz,
    notes,
    pitchShift: { semitones: num(shift, 'semitones', 'pitchShift'), cents: num(shift, 'cents', 'pitchShift') },
    handles: (handles as unknown[]).map((h) => ({
      handleId: text(h, 'handleId', 'a handle'),
      contentSec: num(h, 'contentSec', 'a handle'),
      outputSec: num(h, 'outputSec', 'a handle'),
    })),
    seeded: bool(grid, 'seeded', 'timeGrid'),
  };
}

const same = (a: unknown, b: unknown) =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= READBACK_EPSILON : a === b;

/** Report consistency of a write result against the state read right after it. */
export interface Consistency {
  /** Where the result and the state read back disagree. */
  readonly problems: string[];
  /**
   * The fields of `changes` the scenario does not read back, as `entity.field`, sorted, each once.
   * They are not compared and are not a problem: fields are only ever added to the specification,
   * and a client accepts the ones it does not know.
   */
  readonly unreadFields: string[];
}

/**
 * Report consistency of a write result against the state read right after it: the tokens, and every
 * field of a change the scenario reads back (the note fields of NOTE_FIELDS, the pitch shift, a
 * time-grid handle, the clip's tokens). Other fields, and the fields of other entities, are listed in
 * unreadFields.
 */
export function consistencyOf(result: Json, after: ClipState, contentId: string): Consistency {
  const problems: string[] = [];
  const unread = new Set<string>();
  const tokens = member(result, 'tokens', 'the result');
  if (member(tokens, 'arrangementRevision', 'tokens') !== after.tokens.arrangementRevision) {
    problems.push('tokens.arrangementRevision is not the one read afterwards');
  }
  const contents = member(tokens, 'contents', 'tokens');
  const entry = Array.isArray(contents)
    ? (contents as unknown[]).find((c) => isObject(c) && c.contentId === contentId)
    : undefined;
  if (entry === undefined) problems.push('tokens has no entry for the clip');
  else {
    for (const name of ['revision', 'gridRevision', 'keyRevision'] as const) {
      if (member(entry, name, 'the tokens') !== after.tokens[name]) {
        problems.push(`tokens.${name} is not the one read afterwards`);
      }
    }
  }
  const changes = member(result, 'changes', 'the result');
  if (!Array.isArray(changes)) return { problems: [...problems, 'changes is not an array'], unreadFields: [] };
  for (const change of changes as unknown[]) {
    const entity = text(change, 'entity', 'a change');
    const ref = member(change, 'ref', 'a change');
    const fields = member(change, 'fields', 'a change');
    if (!isObject(fields)) continue;
    // What the scenario read back for this change, by field name; null when the entity it refers to
    // is not there afterwards (already a problem).
    let what = entity;
    let readBack: Readonly<Record<string, unknown>> | null = {};
    if (entity === 'note') {
      const note = member(ref, 'note', 'a note reference');
      const index = num(note, 'index', 'a note reference');
      what = `note ${String(index)}`;
      if (member(note, 'atRevision', 'a note reference') !== after.notesRevision) {
        problems.push(`note ${String(index)} is referenced at another revision than the one read afterwards`);
      }
      const read = after.notes.find((n) => n.index === index);
      if (read === undefined) problems.push(`note ${String(index)} of the changes is not there afterwards`);
      readBack = read === undefined ? null : Object.fromEntries(NOTE_FIELDS.map((name) => [name, read[name]]));
    } else if (entity === 'pitchShift') {
      what = 'pitch shift';
      readBack = after.pitchShift;
    } else if (entity === 'timeHandle') {
      const handleId = text(ref, 'handleId', 'a handle reference');
      what = `handle ${handleId}`;
      const handle = after.handles.find((h) => h.handleId === handleId);
      if (handle === undefined) problems.push(`handle ${handleId} of the changes is not there afterwards`);
      readBack = handle === undefined ? null : { contentSec: handle.contentSec, outputSec: handle.outputSec };
    } else if (entity === 'content') {
      what = 'the clip';
      readBack = {
        revision: after.tokens.revision,
        gridRevision: after.tokens.gridRevision,
        keyRevision: after.tokens.keyRevision,
      };
    }
    if (readBack === null) continue;
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

/** Differences between two snapshots of the clip, for the check after edit.undo. Tokens are not compared. */
export function snapshotProblems(before: ClipState, after: ClipState): string[] {
  const problems: string[] = [];
  if (before.notes.length !== after.notes.length) {
    problems.push(
      `${String(after.notes.length)} notes after the undo, ${String(before.notes.length)} before the write`,
    );
  }
  for (const [i, a] of before.notes.entries()) {
    const b = after.notes[i];
    if (b === undefined) break;
    for (const name of NOTE_FIELDS) {
      if (!same(a[name], b[name])) {
        problems.push(
          `note ${String(i)} ${name}: ${JSON.stringify(a[name])} before the write, ${JSON.stringify(b[name])} after the undo`,
        );
      }
    }
  }
  if (
    before.pitchShift.semitones !== after.pitchShift.semitones ||
    before.pitchShift.cents !== after.pitchShift.cents
  ) {
    problems.push('the pitch shift after the undo is not the one before the write');
  }
  const handles = (s: ClipState) => JSON.stringify(s.handles.map((h) => [h.handleId, h.contentSec, h.outputSec]));
  if (handles(before) !== handles(after))
    problems.push('the time-grid handles after the undo are not those before the write');
  return problems.slice(0, 8);
}

// ---------------------------------------------------------------------------------------------
// measuring two exports

/** A note to measure: its place in the exported file (seconds) and roughly where its pitch is. */
export interface Span {
  readonly index: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly hz: number;
}

export interface NoteDelta {
  readonly index: number;
  readonly expectedCents: number;
  /** Median of the per-frame differences, wet minus baseline; null when too few frames were voiced in both. */
  readonly medianCents: number | null;
  readonly frames: number;
  /** Per-frame differences (rounded), kept for the race check; not written to the report. */
  readonly perFrame: readonly number[];
}

/** A NoteDelta as the report shows it: without the per-frame values. */
const publicDelta = (d: NoteDelta) => ({
  index: d.index,
  expectedCents: d.expectedCents,
  medianCents: d.medianCents,
  frames: d.frames,
});

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

/**
 * Text for the report: the given audio file (its path and its name) becomes <audio>, the folder of
 * the exports <tmp>, and what is left of a user folder <home>; then as clean() (no long hex, cut short).
 * An error an instance sends may quote a path; the report must never hold one.
 */
export function scrubText(
  text: string,
  where: { readonly audioPath?: string | undefined; readonly workDir?: string | undefined },
): string {
  let out = text;
  if (where.audioPath !== undefined) {
    out = out.replaceAll(where.audioPath, '<audio>').replaceAll(path.basename(where.audioPath), '<audio>');
  }
  if (where.workDir !== undefined && where.workDir !== '') out = out.replaceAll(where.workDir, '<tmp>');
  out = out
    .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+/gi, '<home>')
    .replace(/(^|[^A-Za-z0-9])\/(?:Users|home)\/[^/\s]+/g, '$1<home>');
  return clean(out);
}

/** The F0 of the trimmed inside of a note, one value per 10 ms frame (null where unvoiced). */
function noteFrames(wav: DecodedWav, span: Span): (number | null)[] {
  const rate = wav.sampleRateHz;
  const trim = Math.max(EDGE_TRIM_SEC, EDGE_TRIM_FRACTION * (span.endSec - span.startSec));
  const margin = 0.05;
  const from = Math.max(0, Math.round((span.startSec - margin) * rate));
  const to = Math.min(wav.mono.length, Math.round((span.endSec + margin) * rate));
  if (to - from < rate * 0.1) return [];
  const band = 2 ** (BAND_SEMITONES / 12);
  const track = estimateF0(wav.mono.subarray(from, to), rate, {
    minHz: span.hz / band,
    maxHz: Math.min(span.hz * band, rate / 4 - 1),
  });
  const offset = from / rate;
  const frames: (number | null)[] = [];
  track.hz.forEach((hz, k) => {
    const t = offset + k * track.hopSec;
    if (t >= span.startSec + trim && t <= span.endSec - trim) frames.push(hz);
  });
  return frames;
}

/** The pitch difference of one note between two exports, frame by frame, voiced frames of both only. */
export function noteDelta(baseline: DecodedWav, wet: DecodedWav, span: Span, expectedCents: number): NoteDelta {
  const a = noteFrames(baseline, span);
  const b = noteFrames(wet, span);
  const perFrame: number[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x !== null && x !== undefined && y !== null && y !== undefined) perFrame.push(centsBetween(x, y));
  }
  return {
    index: span.index,
    expectedCents,
    medianCents: perFrame.length >= MIN_VOICED_FRAMES ? round(median(perFrame)) : null,
    frames: perFrame.length,
    perFrame: perFrame.map((c) => round(c, 1)),
  };
}

/** The median pitch of a note in one file against a known frequency, in cents; null when too few frames are voiced. */
function pitchAgainst(wav: DecodedWav, span: Span, hz: number): { cents: number | null; frames: number } {
  const voiced = noteFrames(wav, span).filter((v): v is number => v !== null);
  return {
    cents: voiced.length >= MIN_VOICED_FRAMES ? round(median(voiced.map((v) => centsBetween(hz, v)))) : null,
    frames: voiced.length,
  };
}

export interface SampleComparison {
  /** Spans compared. */
  readonly spans: number;
  /** Spans whose samples are equal bit for bit, in every channel. */
  readonly bitIdentical: number;
  /** Largest absolute sample difference over all spans (linear). */
  readonly maxAbsDiff: number;
  /** The same in dB relative to full scale; null when there is no difference. */
  readonly maxAbsDiffDbfs: number | null;
}

/** Compares two exports sample by sample over the given spans (seconds), every channel. */
export function compareSamples(
  a: DecodedWav,
  b: DecodedWav,
  spans: readonly { startSec: number; endSec: number }[],
): SampleComparison {
  let identical = 0;
  let maxAbsDiff = 0;
  const rate = a.sampleRateHz;
  for (const span of spans) {
    const from = Math.max(0, Math.round(span.startSec * rate));
    let same = true;
    for (let c = 0; c < Math.max(a.channels.length, b.channels.length); c++) {
      const x = a.channels[c];
      const y = b.channels[c];
      const to = Math.min(Math.round(span.endSec * rate), Math.max(x?.length ?? 0, y?.length ?? 0));
      for (let i = from; i < to; i++) {
        const d = Math.abs((x?.[i] ?? 0) - (y?.[i] ?? 0));
        if (d > 0 || (x?.[i] === undefined) !== (y?.[i] === undefined)) same = false;
        if (d > maxAbsDiff) maxAbsDiff = d;
      }
    }
    if (same) identical++;
  }
  return {
    spans: spans.length,
    bitIdentical: identical,
    maxAbsDiff,
    maxAbsDiffDbfs: maxAbsDiff > 0 ? round(20 * Math.log10(maxAbsDiff), 1) : null,
  };
}

/**
 * How far two files differ over a span once each RESYNTH_WINDOW_SEC window of `b` may be shifted by
 * up to `maxLagSamples` against `a` (a phase offset): the smallest energy of a - b per window, summed
 * over the windows, relative to the energy of `a` there, in dB. Windows shorter than twice the largest
 * shift are left out. Null when `a` has no energy in the span (nothing to compare against); -200 at
 * the lowest (the same samples after the shift).
 */
export function alignedResidualDb(
  a: DecodedWav,
  b: DecodedWav,
  span: { readonly startSec: number; readonly endSec: number },
  maxLagSamples: number,
): number | null {
  const x = a.mono;
  const y = b.mono;
  const rate = a.sampleRateHz;
  const lagMax = Math.max(0, Math.ceil(maxLagSamples));
  const from = Math.max(0, Math.round(span.startSec * rate));
  const to = Math.min(x.length, Math.round(span.endSec * rate));
  const step = Math.max(1, Math.round(RESYNTH_WINDOW_SEC * rate));
  let energy = 0;
  let residual = 0;
  for (let start = from; start < to; start += step) {
    const end = Math.min(to, start + step);
    if (end - start < 2 * lagMax) continue;
    let windowEnergy = 0;
    for (let i = start; i < end; i++) windowEnergy += (x[i] ?? 0) ** 2;
    let best = Infinity;
    for (let lag = -lagMax; lag <= lagMax; lag++) {
      let e = 0;
      for (let i = start; i < end && e < best; i++) e += ((x[i] ?? 0) - (y[i - lag] ?? 0)) ** 2;
      if (e < best) best = e;
    }
    energy += windowEnergy;
    residual += best;
  }
  if (!(energy > 0)) return null;
  return round(Math.max(-200, 10 * Math.log10(residual / energy)), 1);
}

/** A note by its place in the clip (content seconds). */
export interface NotePlace {
  readonly index: number;
  readonly startSec: number;
  readonly endSec: number;
}

/**
 * The unedited notes an edit's re-synthesis may reach (see RESYNTH_PRE_ROLL_SEC and the measurements
 * above it): after every edited note, the notes that follow it in its phrase, and the first note
 * after the gap of at least PHRASE_GAP_SEC that ends the phrase. `notes` are all notes of the clip.
 */
export function resynthesisReach(notes: readonly NotePlace[], edited: readonly number[]): Set<number> {
  const sorted = [...notes].sort((p, q) => p.startSec - q.startSec || p.index - q.index);
  const isEdited = new Set(edited);
  const reach = new Set<number>();
  for (const [at, note] of sorted.entries()) {
    if (!isEdited.has(note.index)) continue;
    let end = note.endSec;
    for (const next of sorted.slice(at + 1)) {
      const gap = next.startSec - end;
      if (!isEdited.has(next.index)) reach.add(next.index);
      if (gap >= PHRASE_GAP_SEC) break;
      end = Math.max(end, next.endSec);
    }
  }
  return reach;
}

/**
 * The part of an unedited note that must be bit-identical: the note and 50 ms on either side, but
 * only up to RESYNTH_PRE_ROLL_SEC before the start of an edited note after it. Null when nothing is
 * left of it.
 */
export function awayWindow(
  span: NotePlace,
  notes: readonly NotePlace[],
  edited: readonly number[],
): { startSec: number; endSec: number } | null {
  const startSec = span.startSec - 0.05;
  let endSec = span.endSec + 0.05;
  for (const note of notes) {
    if (edited.includes(note.index) && note.startSec > span.startSec) {
      endSec = Math.min(endSec, note.startSec - RESYNTH_PRE_ROLL_SEC);
    }
  }
  return endSec > startSec ? { startSec, endSec } : null;
}

/** The inside of a note that is measured: max(EDGE_TRIM_SEC, EDGE_TRIM_FRACTION of it) off both ends. */
function insideOf(span: { readonly startSec: number; readonly endSec: number }) {
  const trim = Math.max(EDGE_TRIM_SEC, EDGE_TRIM_FRACTION * (span.endSec - span.startSec));
  return { startSec: span.startSec + trim, endSec: span.endSec - trim };
}

/** The largest absolute sample of a file (all channels). */
function peakOf(wav: DecodedWav): number {
  let peak = 0;
  for (const channel of wav.channels) for (const v of channel) peak = Math.max(peak, Math.abs(v));
  return peak;
}

// ---------------------------------------------------------------------------------------------
// the audio

/** Five notes with silence between them, one of them 40 cents sharp; 8.5 s. */
function makeTone(): Tone {
  return generateTone({
    seed: 20261016,
    leadSec: 0.4,
    notes: [
      { midi: 57, durationSec: 1.2, gapSec: 0.4 },
      { midi: 59, durationSec: 1.2, gapSec: 0.4 },
      { midi: 60, cents: OFF_NOTE_CENTS, durationSec: 1.2, gapSec: 0.4 },
      { midi: 62, durationSec: 1.2, gapSec: 0.4 },
      { midi: 64, durationSec: 1.2, gapSec: 0.4 },
    ],
  });
}

/** A tone of about `seconds` for the timings only: notes of 1.1 s, a scale up and down. */
function makeLongTone(seconds: number): Tone {
  const steps = [0, 2, 4, 5, 7, 5, 4, 2];
  const count = Math.max(1, Math.round((seconds - 0.3) / 1.2));
  return generateTone({
    seed: 7 + count,
    notes: Array.from({ length: count }, (_, i) => ({ midi: 57 + (steps[i % steps.length] ?? 0), durationSec: 1.1 })),
  });
}

/** Which notes the checks edit. */
interface Picks {
  /** setTargetPitch +100 cents. */
  readonly target: number;
  /** shiftCents +100 cents; its start is also where the time shift moves a handle. */
  readonly shift: number;
  /** The two notes of the race. */
  readonly race: readonly [number, number];
  /** The deliberately sharp note; null for external audio. */
  readonly off: number | null;
}

// ---------------------------------------------------------------------------------------------
// the scenario

export type EffectsHooks = SmokeHooks;

interface StepOptions {
  /** Runs even when an earlier step stopped the scenario (clean-up). */
  readonly always?: boolean;
  /** A check: when it fails, the checks after it still run. */
  readonly check?: boolean;
}

/** Thrown by a check whose clean-up could not put the clip back as it was: the checks after it would be unsound. */
class Unrestored extends Error {}

export async function runEffects(config: EffectsConfig, hooks: EffectsHooks = {}): Promise<EffectsReport> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const target = hooks.target ?? exeTarget(config.exe);
  const timeoutMs = config.stepTimeoutMs;
  const steps: StepReport[] = [];
  const checks: Record<string, unknown> = {};
  const timings: Record<string, unknown> = {};
  const exportTimes: { label: string; ms: number }[] = [];
  const exportBackends = new Set<string>();
  let halted: string | undefined;
  let instance: TargetInstance | undefined;
  let session: OtcpSession | undefined;
  let hello: HelloInfo | undefined;
  let files: ToneFiles | undefined;
  let tone: Tone | undefined;
  let audio: Record<string, number | string | boolean> | null = null;
  let backend = null as EffectsReport['backend'];
  let noiseFloor: Record<string, unknown> | null = null;
  let diagnostics: string | null = null;
  let sessionHybridMode: boolean | null = null;
  /** The processing every export reported, by the step that made it. */
  const processing = new Map<string, ExportProcessing[]>();
  let currentStep = '';
  target.labelNext?.('effects');

  /** Report text without the given audio file, the export folder or a user folder (scrubText). */
  const scrub = (text: string) => scrubText(text, { audioPath: config.audioPath, workDir });

  /** Keeps what an export result says about its processing (hybrid mode, backend) for the current step. */
  const recordProcessing = (label: string, result: unknown) => {
    const p = member(result, 'processing', 'the export result');
    const entry: ExportProcessing = {
      export: label,
      hybridMode: isObject(p) && typeof p.hybridMode === 'boolean' ? p.hybridMode : null,
      backend: isObject(p) && typeof p.backend === 'string' ? p.backend : null,
    };
    if (entry.backend !== null) exportBackends.add(entry.backend);
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

  let contentId = '';
  let placementId = '';
  let source = '';
  let workDir = '';
  let baseline: DecodedWav | undefined;
  let spans: Span[] = [];
  /** Every note of the clip by its place, voiced or not: the gaps between them end phrases (resynthesisReach). */
  let places: NotePlace[] = [];
  let picks: Picks | undefined;
  let exportCount = 0;

  /** Waits until the clip's audible render is settled at its current revision; returns how long it took. */
  const settle = async (id = contentId): Promise<number> => {
    const at = performance.now();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const details = await need().call('content.getDetails', { contentId: id }, 30_000);
      const render = member(details, 'render', 'content details');
      if (member(render, 'current', 'render') === true) return performance.now() - at;
      if (Date.now() >= deadline) {
        throw new Error(`the render did not settle within ${String(timeoutMs)} ms (${JSON.stringify(render)})`);
      }
      await sleep(SETTLE_POLL_MS);
    }
  };

  /** Exports the clip (or another placement) and reads the file back. Checks it is not silent and the dry list. */
  const exportClip = async (label: string, placement = placementId) => {
    const file = path.join(workDir, `effects-${String(++exportCount)}-${label.replace(/[^a-z0-9]+/gi, '-')}.wav`);
    const at = performance.now();
    const result = await runJob(
      need(),
      'export.start',
      { kind: 'clip', target: { placementId: placement }, path: file, ifExists: 'error' },
      'export',
      timeoutMs,
    );
    exportTimes.push({ label, ms: Math.round(performance.now() - at) });
    recordProcessing(label, result);
    const dry = member(result, 'dryContents', 'the export result');
    if (!Array.isArray(dry)) throw new Error('dryContents is not an array');
    const wav = decodeWav(await readFile(text(result, 'path', 'the export result')));
    if (peakOf(wav) <= 1e-4) throw new Error(`the ${label} export is silent`);
    return { wav, dry: dry as unknown[] };
  };

  /** An export that must be corrected: nothing in dryContents. */
  const exportWet = async (label: string) => {
    const { wav, dry } = await exportClip(label);
    if (dry.length > 0)
      throw new Error(`the ${label} export lists the clip in dryContents: it was exported uncorrected`);
    return wav;
  };

  interface CheckFrame {
    /** The clip as it was before the check wrote anything. */
    readonly before: ClipState;
    /** The undoId of every write the check made, oldest first; restored newest first. */
    readonly undoIds: string[];
    /** The fields its results reported that the scenario does not read back (Consistency.unreadFields). */
    readonly unread: Set<string>;
    /** The measurements, written to checks[name]. */
    readonly report: Record<string, unknown>;
  }

  /** The undoId of a write result; throws with the reason when it carries none. */
  const undoIdOf = (result: Json): string => {
    const undo = result.undo;
    if (!isObject(undo)) throw new Error('its result has no undo block');
    if (undo.undoable !== true) {
      const reason = typeof undo.reason === 'string' ? ` (${undo.reason})` : '';
      throw new Error(`its result says it cannot be undone${reason}`);
    }
    if (typeof undo.undoId !== 'string' || undo.undoId === '') throw new Error('its undo block has no undoId');
    return undo.undoId;
  };

  /**
   * The first thing done with every write result: whether the write took effect (applied, and not a
   * dry run; a result that does not say counts as taking effect). Inside a check the undoId of a
   * write that took effect goes into the frame at once, before anything else is read from the result,
   * so that a failure further on can still take the write back. A write that took effect without a
   * usable undoId cannot be taken back, and the checks after this one would run on a changed clip:
   * Unrestored, which stops them.
   */
  const tookEffect = (method: string, result: Json, frame: CheckFrame | null): boolean => {
    if (result.applied === false || result.dryRun === true) return false;
    if (frame !== null) {
      let undoId: string;
      try {
        undoId = undoIdOf(result);
      } catch (error) {
        throw new Unrestored(
          `${method} took effect, but ${error instanceof Error ? error.message : String(error)}: ` +
            'the check cannot take it back, and the checks after it would run on a changed clip',
        );
      }
      frame.undoIds.push(undoId);
    }
    if (result.applied !== true) throw new Error(`the ${method} result does not say whether it was applied`);
    return true;
  };

  /**
   * A write, then the state read back at once and the consistency of the two. Inside a check, give
   * its frame: the undo is recorded first (tookEffect), and the unread fields go into the frame.
   */
  const write = async (method: string, params: Json, frame: CheckFrame | null) => {
    const result = await need().call(method, params, 60_000);
    if (!tookEffect(method, result, frame)) {
      throw new Error(`${method} changed nothing (applied ${String(result.applied)}, dryRun ${String(result.dryRun)})`);
    }
    const after = await readState(need(), contentId);
    const { problems, unreadFields } = consistencyOf(result, after, contentId);
    for (const field of unreadFields) frame?.unread.add(field);
    return { result, after, problems, unreadFields };
  };

  /**
   * Takes back the writes of a check with edit.undo, newest first, and verifies the clip is as it
   * was (also when there is nothing to take back). Returns the problems; throws Unrestored when the
   * clip could not be put back.
   */
  const restore = async (frame: CheckFrame): Promise<string[]> => {
    const problems: string[] = [];
    try {
      for (const undoId of [...frame.undoIds].reverse()) {
        const result = await need().call('edit.undo', { expectedUndoId: undoId }, 60_000);
        const after = await readState(need(), contentId);
        const consistency = consistencyOf(result, after, contentId);
        problems.push(...consistency.problems.map((p) => `undo: ${p}`));
        for (const field of consistency.unreadFields) frame.unread.add(field);
      }
      const now = await readState(need(), contentId);
      const left = snapshotProblems(frame.before, now);
      if (left.length > 0) throw new Unrestored(`after edit.undo the clip is not as it was: ${left.join('; ')}`);
      if (frame.undoIds.length > 0) await settle();
    } catch (error) {
      if (error instanceof Unrestored) throw error;
      throw new Unrestored(
        `the clip could not be put back: ${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error,
        },
      );
    }
    return problems;
  };

  /** The unread fields of a check, for its report; nothing when there are none. */
  const unreadReport = (frame: CheckFrame) =>
    frame.unread.size === 0 ? {} : { unreadFields: [...frame.unread].sort() };

  /**
   * The frame of a check that writes: snapshot, the check's own work, then edit.undo of its writes
   * and the comparison with the snapshot, also when the work failed half-way (a write may have taken
   * effect before the failure; its undo was recorded first). The check returns its note and its
   * problems; any problem, including one of the undo, fails it.
   */
  const guardedCheck = async (
    name: string,
    work: (frame: CheckFrame) => Promise<{ note: string; problems: readonly string[] }>,
  ): Promise<string> => {
    const frame: CheckFrame = {
      before: await readState(need(), contentId),
      undoIds: [],
      unread: new Set(),
      report: {},
    };
    let restored = false;
    try {
      const { note, problems } = await work(frame);
      checks[name] = frame.report;
      restored = true;
      const undo = await restore(frame);
      Object.assign(frame.report, { undo }, unreadReport(frame));
      const all = [...problems, ...undo];
      if (all.length > 0) throw new Error(all.join('; '));
      return frame.unread.size === 0
        ? note
        : `${note}; ${String(frame.unread.size)} reported field(s) not compared, as the scenario does not read them`;
    } catch (error) {
      let thrown = error;
      // Unrestored from the work: what it could not take back is already known.
      if (!restored && !(error instanceof Unrestored)) {
        try {
          await restore(frame);
        } catch (failure) {
          const why = failure instanceof Error ? failure.message : String(failure);
          thrown = new Unrestored(`${classify(error).note}; ${why}`, { cause: error });
        }
      }
      checks[name] = {
        ...frame.report,
        ...unreadReport(frame),
        error: scrub(thrown instanceof Error ? thrown.message : String(thrown)),
      };
      throw thrown;
    }
  };

  /** Imports one file, follows the job and waits for its pitch analysis; returns its handles and how long it took. */
  const importAndAnalyse = async (file: string, extra: Json = {}) => {
    const s = need();
    const at = performance.now();
    const result = await runJob(
      s,
      'import.start',
      { items: [{ path: file }], layout: 'single', generateNotes: true, ...extra },
      'import',
      timeoutMs,
    );
    const items = member(result, 'items', 'the import result');
    const item: unknown = Array.isArray(items) ? (items as unknown[])[0] : undefined;
    if (!isObject(item) || item.imported !== true) throw new Error('the file was not imported');
    const id = text(item, 'contentId', 'the import item');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const details = await s.call('content.getDetails', { contentId: id }, 30_000);
      const state = text(member(details, 'analysis', 'content details'), 'f0State', 'analysis');
      if (state === 'ready') break;
      if (state === 'failed' || state === 'notRequested') throw new Error(`the pitch analysis is ${state}`);
      if (Date.now() >= deadline) throw new Error(`the pitch analysis was not ready within ${String(timeoutMs)} ms`);
      await sleep(200);
    }
    return {
      contentId: id,
      placementId: text(item, 'placementId', 'the import item'),
      ms: Math.round(performance.now() - at),
    };
  };

  /** Spans of the notes by index, with their detected pitch; unvoiced and short notes are left out. */
  const spansOf = (state: ClipState): Span[] =>
    state.notes
      .filter(
        (n): n is NoteRead & { detectedMidi: number } =>
          n.voiced && n.detectedMidi !== null && n.endContentSec - n.startContentSec >= MIN_NOTE_SEC,
      )
      .map((n) => ({
        index: n.index,
        startSec: n.startContentSec,
        endSec: n.endContentSec,
        hz: state.tuningHz * 2 ** ((n.detectedMidi - 69) / 12),
      }));

  const spanOf = (index: number): Span => {
    const span = spans.find((s) => s.index === index);
    if (span === undefined) throw new Error(`note ${String(index)} is not a voiced note`);
    return span;
  };

  /** Measures every note against the baseline: `expected` gives the change of the edited ones, all others 0. */
  const measure = (wet: DecodedWav, expected: ReadonlyMap<number, number>) => {
    if (baseline === undefined) throw new Error('no baseline');
    const base = baseline;
    const deltas = spans.map((span) => noteDelta(base, wet, span, expected.get(span.index) ?? 0));
    const problems: string[] = [];
    for (const d of deltas) {
      if (d.medianCents === null) {
        problems.push(`note ${String(d.index)}: only ${String(d.frames)} frames voiced in both files`);
      } else if (Math.abs(d.medianCents - d.expectedCents) > PITCH_TOLERANCE_CENTS) {
        problems.push(
          `note ${String(d.index)}: ${String(d.medianCents)} cents, expected ${String(d.expectedCents)} +- ${String(PITCH_TOLERANCE_CENTS)}`,
        );
      }
    }
    // The notes that were not edited, in the zones of RESYNTH_*: those within the reach of an edit's
    // re-synthesis, and those away from every edit.
    const edited = [...expected.keys()];
    const reachable = resynthesisReach(places, edited);
    const uneditedSpans = spans.filter((s) => !expected.has(s.index));
    const awaySpans = uneditedSpans.filter((s) => !reachable.has(s.index));
    const windows = awaySpans
      .map((s) => awayWindow(s, places, edited))
      .filter((w): w is { startSec: number; endSec: number } => w !== null);
    const away = compareSamples(base, wet, windows);
    if (away.maxAbsDiff > UNEDITED_MAX_ABS_DIFF_NOTES) {
      problems.push(
        `notes away from the edit (${awaySpans.map((s) => String(s.index)).join(', ')}) differ from the baseline ` +
          `by up to ${away.maxAbsDiff.toExponential(2)} (allowed ${String(UNEDITED_MAX_ABS_DIFF_NOTES)})`,
      );
    }
    const reach = uneditedSpans
      .filter((s) => reachable.has(s.index))
      .map((s) => {
        const identical =
          compareSamples(base, wet, [{ startSec: s.startSec - 0.05, endSec: s.endSec + 0.05 }]).bitIdentical === 1;
        // One period of the note's pitch is as far as a phase offset can move it.
        const residualDb = identical ? null : alignedResidualDb(base, wet, insideOf(s), base.sampleRateHz / s.hz);
        return { index: s.index, bitIdentical: identical, alignedResidualDb: residualDb };
      });
    for (const r of reach) {
      if (r.bitIdentical) continue;
      if (r.alignedResidualDb === null || r.alignedResidualDb > RESYNTH_MAX_RESIDUAL_DB) {
        problems.push(
          `note ${String(r.index)}, after the edit, was rendered again but is not the same sound: ` +
            `${String(r.alignedResidualDb)} dB left after aligning its phase (allowed ${String(RESYNTH_MAX_RESIDUAL_DB)})`,
        );
      }
    }
    const report = {
      toleranceCents: PITCH_TOLERANCE_CENTS,
      notes: deltas.map(publicDelta),
      unedited: { away: { ...away, notes: awaySpans.map((s) => s.index) }, reach },
    };
    return { deltas, problems, report };
  };

  const describeDeltas = (deltas: readonly NoteDelta[], indices: readonly number[]) =>
    indices
      .map((i) => deltas.find((d) => d.index === i))
      .map((d) => `note ${String(d?.index)} ${String(d?.medianCents)} c over ${String(d?.frames)} frames`)
      .join(', ');

  // --- set-up ---------------------------------------------------------------------------------

  await step('prepare audio', async () => {
    if (config.audioPath === undefined) {
      tone = makeTone();
      files = await writeToneFiles(tone, 'effects-source');
      source = files.wavPath;
      workDir = files.dir;
      audio = {
        source: 'generated',
        seconds: round(tone.truth.durationSec, 3),
        sampleRateHz: tone.truth.sampleRateHz,
        notes: tone.truth.notes.length,
        offNoteCents: OFF_NOTE_CENTS,
      };
      return `generated: ${tone.truth.durationSec.toFixed(1)} s, ${String(tone.truth.notes.length)} notes, one ${String(OFF_NOTE_CENTS)} cents sharp`;
    }
    // The exports still need a folder of their own.
    files = await writeToneFiles(generateTone({ seed: 1, notes: [{ midi: 60, durationSec: 0.1 }] }), 'unused');
    workDir = files.dir;
    source = config.audioPath;
    const wav = decodeWav(await readFile(source));
    audio = {
      source: 'external',
      seconds: round(wav.mono.length / wav.sampleRateHz, 3),
      sampleRateHz: wav.sampleRateHz,
      channels: wav.channels.length,
    };
    return 'external audio (OTCP_E2E_EFFECTS_AUDIO); checks that need a known pitch are skipped';
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
    const missing = REQUIRED_CAPABILITIES.filter((c) => !hello?.capabilities.includes(c));
    if (missing.length > 0) {
      throw new StepSkip('SKIP', `the instance does not report ${missing.join(', ')}, which the scenario needs`);
    }
    const info = await session.call('session.info', {}, 30_000);
    const processing = member(info, 'processing', 'session.info');
    const nullable = (name: string) => {
      const v = member(processing, name, 'processing');
      return typeof v === 'string' ? v : null;
    };
    backend = {
      sessionInfo: nullable('backend'),
      exports: [],
      f0Model: nullable('f0Model'),
      vocoderWeight: nullable('vocoderWeight'),
    };
    const hybrid = isObject(processing) ? processing.hybridMode : undefined;
    sessionHybridMode = typeof hybrid === 'boolean' ? hybrid : null;
    return (
      `protocol ${hello.protocol}; backend ${String(backend.sessionInfo)}, ` +
      `scheme ${text(processing, 'editingScheme', 'processing')}, hybrid mode ${sessionHybridMode === null ? 'not reported' : sessionHybridMode ? 'on' : 'off'}`
    );
  });

  let afterImport: ClipState | undefined;
  await step('import and analysis', async () => {
    const imported = await importAndAnalyse(source);
    contentId = imported.contentId;
    placementId = imported.placementId;
    timings.importToF0ReadyMs = imported.ms;
    afterImport = await readState(need(), contentId);
    spans = spansOf(afterImport);
    places = afterImport.notes.map((n) => ({ index: n.index, startSec: n.startContentSec, endSec: n.endContentSec }));
    const corrected = afterImport.notes.filter((n) => n.corrected).length;
    if (tone !== undefined) {
      if (spans.length !== tone.truth.notes.length) {
        throw new Error(
          `OpenTune found ${String(spans.length)} voiced notes, the generated audio has ${String(tone.truth.notes.length)}`,
        );
      }
      picks = { target: 1, shift: 3, race: [0, 4], off: 2 };
    } else {
      const long = [...spans].sort((a, b) => b.endSec - b.startSec - (a.endSec - a.startSec));
      const [first, second] = long;
      if (first !== undefined && second !== undefined) {
        picks = { target: first.index, shift: second.index, race: [first.index, second.index], off: null };
      }
    }
    return `${String(afterImport.notes.length)} notes generated (${String(corrected)} corrected), analysis ready`;
  });

  // --- checks ---------------------------------------------------------------------------------

  await step(
    'export before any edit',
    async () => {
      // Nothing is corrected yet: the export is either corrected anyway or lists the clip in
      // dryContents (PROTOCOL.md section 19 rule 6); either way it is the source's pitch.
      const { wav, dry } = await exportClip('unedited');
      const listed = dry.some((d) => isObject(d) && d.contentId === contentId);
      const pitches = spans.map((span) => ({ index: span.index, ...pitchAgainst(wav, span, span.hz) }));
      checks['export before any edit'] = { dryListed: listed, notes: pitches };
      const off = pitches.filter((p) => p.cents === null || Math.abs(p.cents) > PITCH_TOLERANCE_CENTS);
      if (off.length > 0) {
        throw new Error(`notes ${off.map((p) => String(p.index)).join(', ')} are not at the detected pitch`);
      }
      return listed ? 'exported uncorrected and listed in dryContents' : 'exported, not listed as dry';
    },
    { check: true },
  );

  let fixed: ClipState | undefined;
  await step('fixed note parameters', async () => {
    if (afterImport === undefined) throw new Error('no notes');
    // A set-up step: these parameters stay for every check, so the write is not taken back.
    const { result, after, problems, unreadFields } = await write(
      'content.editNotes',
      {
        contentId,
        expectedRevision: afterImport.notesRevision,
        ops: [{ op: 'setParams', select: { all: true }, ...FIXED_PARAMS }],
      },
      null,
    );
    const wrong = after.notes.filter(
      (n) =>
        !same(n.retuneSpeed, FIXED_PARAMS.retuneSpeed) ||
        !same(n.vibratoDepth, FIXED_PARAMS.vibratoDepth) ||
        !same(n.pitchDriftScale, FIXED_PARAMS.pitchDriftScale),
    );
    if (wrong.length > 0) problems.push(`${String(wrong.length)} notes do not have the parameters set`);
    timings.fixedParamsToSettleMs = Math.round(await settle());
    fixed = after;
    checks['fixed note parameters'] = {
      consistency: problems,
      undoable: isObject(result.undo) && result.undo.undoable === true,
      ...(unreadFields.length === 0 ? {} : { unreadFields }),
    };
    if (problems.length > 0) throw new Error(problems.join('; '));
    const unread =
      unreadFields.length === 0
        ? ''
        : `; ${String(unreadFields.length)} reported field(s) not compared, as the scenario does not read them`;
    return `retuneSpeed ${String(FIXED_PARAMS.retuneSpeed)}, vibratoDepth ${String(FIXED_PARAMS.vibratoDepth)}, pitchDriftScale ${String(FIXED_PARAMS.pitchDriftScale)} on every note; render settled${unread}`;
  });

  await step('baseline and noise floor', async () => {
    const first = await exportWet('baseline');
    const second = await exportWet('baseline again');
    baseline = first;
    const deltas = spans.map((span) => noteDelta(first, second, span, 0));
    const samples = compareSamples(first, second, [{ startSec: 0, endSec: first.mono.length / first.sampleRateHz }]);
    const floor: Record<string, unknown> = {
      repeatExport: {
        bitIdentical: samples.bitIdentical === 1,
        maxAbsDiff: samples.maxAbsDiff,
        notes: deltas.map(publicDelta),
      },
    };
    if (tone !== undefined) {
      const truth = tone.truth;
      const sourceWav = decodeWav(tone.wav);
      floor.estimatorOnSource = truth.notes.map((note, i) => ({
        index: i,
        ...pitchAgainst(sourceWav, { index: i, startSec: note.startSec, endSec: note.endSec, hz: note.hz }, note.hz),
      }));
      floor.renderedAgainstSource = truth.notes.map((note, i) => ({
        index: i,
        ...pitchAgainst(first, { index: i, startSec: note.startSec, endSec: note.endSec, hz: note.hz }, note.hz),
      }));
    }
    noiseFloor = floor;
    const unmeasured = deltas.filter((d) => d.medianCents === null).map((d) => String(d.index));
    if (unmeasured.length > 0) {
      throw new Error(
        `notes ${unmeasured.join(', ')} have fewer than ${String(MIN_VOICED_FRAMES)} voiced frames in the baseline`,
      );
    }
    const worst = Math.max(0, ...deltas.map((d) => Math.abs(d.medianCents ?? 0)));
    if (worst > PITCH_TOLERANCE_CENTS) {
      throw new Error(`two exports of the unchanged clip differ by ${String(worst)} cents`);
    }
    return `two exports ${samples.bitIdentical === 1 ? 'bit-identical' : `differ by up to ${samples.maxAbsDiff.toExponential(2)}`}; worst note ${String(worst)} cents`;
  });

  /** A pitch check: one write, an export, the measurement and the restore. */
  const pitchCheck = async (
    name: string,
    makeParams: (state: ClipState) => { method: string; params: Json },
    expected: (state: ClipState) => ReadonlyMap<number, number>,
    expectChange: (result: Json, before: ClipState, after: ClipState) => string[],
  ) => {
    if (fixed === undefined || baseline === undefined) throw new Error('no baseline');
    return guardedCheck(name, async (frame) => {
      const { before, report } = frame;
      const { method, params } = makeParams(before);
      const at = performance.now();
      const { result, after, problems: consistency } = await write(method, params, frame);
      const problems = [...consistency, ...expectChange(result, before, after)];
      await settle();
      const writeToSettleMs = Math.round(performance.now() - at);
      const want = expected(before);
      const m = measure(await exportWet(name), want);
      problems.push(...m.problems);
      Object.assign(report, m.report, { writeToSettleMs, consistency });
      const again = m.report.unedited.reach.filter((r) => !r.bitIdentical);
      const rendered =
        again.length === 0
          ? ''
          : ` (${again.map((r) => `note ${String(r.index)} rendered again in another phase, ${String(r.alignedResidualDb)} dB`).join(', ')})`;
      return {
        note: `${describeDeltas(m.deltas, [...want.keys()])}; others unchanged${rendered}; undo restored the clip`,
        problems,
      };
    });
  };

  const noteChanged = (result: Json, index: number, field: string, want: number): string[] => {
    const changes = member(result, 'changes', 'the result');
    const change = Array.isArray(changes)
      ? (changes as unknown[]).find(
          (c) =>
            isObject(c) && c.entity === 'note' && isObject(c.ref) && isObject(c.ref.note) && c.ref.note.index === index,
        )
      : undefined;
    const fields = isObject(change) ? change.fields : undefined;
    const value = isObject(fields) && isObject(fields[field]) ? fields[field].after : undefined;
    return same(value, want)
      ? []
      : [`changes does not report note ${String(index)} ${field} ${String(want)} (it says ${JSON.stringify(value)})`];
  };

  await step(
    'setTargetPitch +100 cents',
    async () => {
      if (picks === undefined)
        throw new StepSkip('SKIP', `the audio has fewer than two voiced notes of ${String(MIN_NOTE_SEC)} s`);
      const index = picks.target;
      return pitchCheck(
        'setTargetPitch +100 cents',
        (state) => ({
          method: 'content.editNotes',
          params: {
            contentId,
            expectedRevision: state.notesRevision,
            ops: [
              {
                op: 'setTargetPitch',
                select: { indices: [index] },
                targetMidi: round(noteAt(state, index).targetMidi + 1, 4),
              },
            ],
          },
        }),
        () => new Map([[index, EDIT_CENTS]]),
        (result, before) => noteChanged(result, index, 'targetMidi', round(noteAt(before, index).targetMidi + 1, 4)),
      );
    },
    { check: true },
  );

  await step(
    'shiftCents +100 cents',
    async () => {
      if (picks === undefined)
        throw new StepSkip('SKIP', `the audio has fewer than two voiced notes of ${String(MIN_NOTE_SEC)} s`);
      const index = picks.shift;
      return pitchCheck(
        'shiftCents +100 cents',
        (state) => ({
          method: 'content.editNotes',
          params: {
            contentId,
            expectedRevision: state.notesRevision,
            ops: [{ op: 'shiftCents', select: { indices: [index] }, deltaCents: EDIT_CENTS }],
          },
        }),
        () => new Map([[index, EDIT_CENTS]]),
        (result, before) => [
          ...noteChanged(result, index, 'offsetCents', noteAt(before, index).offsetCents + EDIT_CENTS),
          ...noteChanged(result, index, 'targetMidi', round(noteAt(before, index).targetMidi + EDIT_CENTS / 100, 4)),
        ],
      );
    },
    { check: true },
  );

  await step(
    'setPitchShift +2 semitones',
    async () =>
      pitchCheck(
        'setPitchShift +2 semitones',
        () => ({
          method: 'content.setPitchShift',
          params: { contentId, pitchShift: { semitones: PITCH_SHIFT_SEMITONES, cents: 0 } },
        }),
        () => new Map(spans.map((s) => [s.index, PITCH_SHIFT_SEMITONES * 100])),
        (_result, _before, after) =>
          after.pitchShift.semitones === PITCH_SHIFT_SEMITONES && after.pitchShift.cents === 0
            ? []
            : [`the pitch shift read back is ${JSON.stringify(after.pitchShift)}`],
      ),
    { check: true },
  );

  // Both modes AUTO runs from the button, each on its own: regenerate (the openTune scheme) replaces
  // the notes, snapNotes (the openDyne scheme) moves the targets of the existing ones.
  const autoToSettleMs: Record<string, number> = {};
  for (const mode of ['regenerate', 'snapNotes'] as const) {
    const name = `AUTO ${mode} pulls the sharp note back`;
    await step(
      name,
      async () => {
        if (picks === undefined) {
          throw new StepSkip('SKIP', `the audio has fewer than two voiced notes of ${String(MIN_NOTE_SEC)} s`);
        }
        if (picks.off === null) {
          throw new StepSkip('SKIP', 'external audio: which note is off, and by how much, is not known in advance');
        }
        const off = picks.off;
        const details = await need().call('content.getDetails', { contentId }, 30_000);
        const available = member(member(details, 'autoModes', 'content details'), 'available', 'autoModes');
        if (!Array.isArray(available) || !available.includes(mode)) {
          throw new StepSkip('SKIP', `the clip does not offer AUTO mode ${mode}`);
        }
        return pitchCheck(
          name,
          (state) => ({
            method: 'content.autoTune',
            params: { contentId, mode, key: { root: 0, scale: 'chromatic' }, expectedRevision: state.notesRevision },
          }),
          // Every note to the nearest semitone: the sharp note down by its 40 cents, the others stay.
          () => new Map(spans.map((s) => [s.index, s.index === off ? -OFF_NOTE_CENTS : 0])),
          (_result, before, after) => {
            const n = noteAt(after, off);
            return Math.abs(n.targetMidi - Math.round(noteAt(before, off).targetMidi)) <= READBACK_EPSILON
              ? []
              : [`the sharp note's target reads back ${String(n.targetMidi)}`];
          },
        ).finally(() => {
          const report = checks[name];
          if (isObject(report) && typeof report.writeToSettleMs === 'number') {
            autoToSettleMs[mode] = report.writeToSettleMs;
          }
        });
      },
      { check: true },
    );
  }
  timings.autoToSettleMs = autoToSettleMs;

  await step(
    'setParams retuneSpeed 1',
    async () =>
      // retuneSpeed 1 flattens every note to its target, which is where the baseline already holds
      // these flat notes: no note may move.
      pitchCheck(
        'setParams retuneSpeed 1',
        (state) => ({
          method: 'content.editNotes',
          params: {
            contentId,
            expectedRevision: state.notesRevision,
            ops: [{ op: 'setParams', select: { all: true }, retuneSpeed: 1 }],
          },
        }),
        () => new Map(spans.map((s) => [s.index, 0])),
        (_result, _before, after) => {
          const wrong = after.notes.filter((n) => !same(n.retuneSpeed, 1)).length;
          return wrong === 0 ? [] : [`${String(wrong)} notes do not read back retuneSpeed 1`];
        },
      ),
    { check: true },
  );

  await step(
    'race: +100 cents, export, -100 cents',
    async () => {
      if (picks === undefined)
        throw new StepSkip('SKIP', `the audio has fewer than two voiced notes of ${String(MIN_NOTE_SEC)} s`);
      if (baseline === undefined) throw new Error('no baseline');
      const base = baseline;
      const s = need();
      const indices = [...picks.race];
      return guardedCheck('race: +100 cents, export, -100 cents', async (frame) => {
        const { before, report } = frame;
        const up = await write(
          'content.editNotes',
          {
            contentId,
            expectedRevision: before.notesRevision,
            ops: [{ op: 'shiftCents', select: { indices }, deltaCents: EDIT_CENTS }],
          },
          frame,
        );
        const file = path.join(workDir, `effects-${String(++exportCount)}-race.wav`);
        const started = await s.call(
          'export.start',
          { kind: 'clip', target: { placementId }, path: file, ifExists: 'error' },
          60_000,
        );
        const job = member(started, 'job', 'export.start result');
        if (!isObject(job)) throw new Error('export.start handed over no job');
        // At once, without waiting for anything: the second version. Its undo is recorded first, as
        // for every write; its report is checked once the export job has ended.
        let second: 'applied' | 'busy' | 'notApplied' = 'busy';
        let down: Json | undefined;
        try {
          const reply = await s.call(
            'content.editNotes',
            {
              contentId,
              expectedRevision: up.after.notesRevision,
              ops: [{ op: 'shiftCents', select: { indices }, deltaCents: -2 * EDIT_CENTS }],
            },
            60_000,
          );
          second = 'notApplied';
          if (tookEffect('content.editNotes', reply, frame)) {
            second = 'applied';
            down = reply;
          }
        } catch (error) {
          if (!(error instanceof OtcpError && error.data.kind === 'BUSY' && error.data.reason === 'export_in_progress'))
            throw error;
        }
        report.secondEdit =
          second === 'applied'
            ? 'applied'
            : second === 'busy'
              ? 'refused: BUSY(export_in_progress)'
              : 'not applied (applied false)';
        let outcome: string;
        let result: unknown;
        try {
          result = await waitJob(s, text(job, 'jobId', 'the job'), 'export', timeoutMs);
        } catch (error) {
          const conflict =
            error instanceof OtcpError &&
            error.data.kind === 'REVISION_CONFLICT' &&
            error.data.reason === 'changed_during_export';
          if (!conflict) throw error;
        }
        // Report consistency of both writes: the first was read back at once, the second now (the
        // export job is over, so reading cannot change the race).
        const problems = up.problems.map((p) => `first edit: ${p}`);
        if (down !== undefined) {
          const consistency = consistencyOf(down, await readState(s, contentId), contentId);
          problems.push(...consistency.problems.map((p) => `second edit: ${p}`));
          for (const field of consistency.unreadFields) frame.unread.add(field);
        }
        report.consistency = problems.slice();
        if (result === undefined) {
          if (second !== 'applied') {
            throw new Error('REVISION_CONFLICT(changed_during_export) although nothing changed during the export');
          }
          if (existsSync(file)) throw new Error('the export failed but its target was written');
          outcome = 'REVISION_CONFLICT(changed_during_export), target untouched';
        } else {
          recordProcessing('race', result);
          const dry = member(result, 'dryContents', 'the export result');
          if (Array.isArray(dry) && dry.length > 0) throw new Error('the race export lists the clip in dryContents');
          const wav = decodeWav(await readFile(text(result, 'path', 'the export result')));
          if (peakOf(wav) <= 1e-4) throw new Error('the race export is silent');
          const deltas = indices.map((i) => noteDelta(base, wav, spanOf(i), 0));
          // Which version each note is: +100 or -100 cents from the baseline, or neither.
          const versionOf = (d: NoteDelta) =>
            d.medianCents === null
              ? 'unmeasured'
              : Math.abs(d.medianCents - EDIT_CENTS) <= PITCH_TOLERANCE_CENTS
                ? 'up'
                : Math.abs(d.medianCents + EDIT_CENTS) <= PITCH_TOLERANCE_CENTS
                  ? 'down'
                  : 'neither';
          const versions = deltas.map(versionOf);
          // Within a note, every frame must belong to the same version (no switch half-way).
          const mixedFrames = deltas.map((d, i) => {
            const want = versions[i] === 'up' ? EDIT_CENTS : -EDIT_CENTS;
            return d.perFrame.filter((c) => Math.abs(c - want) > PITCH_TOLERANCE_CENTS).length;
          });
          report.notes = deltas.map((d, i) => ({
            index: d.index,
            medianCents: d.medianCents,
            frames: d.frames,
            version: versions[i],
            framesOff: mixedFrames[i],
          }));
          const [va, vb] = versions;
          if (va !== vb || (va !== 'up' && va !== 'down'))
            throw new Error(`the export is not one version: ${versions.join(', ')}`);
          if (mixedFrames.some((n, i) => n > 0.1 * (deltas[i]?.frames ?? 0))) {
            throw new Error('more than a tenth of the frames of a note belong to no version or the other one');
          }
          if (va === 'down' && second !== 'applied') throw new Error('the export has a version that was never applied');
          outcome = `export holds the ${va === 'up' ? '+100' : '-100'} cents version in full`;
        }
        report.outcome = outcome;
        return { note: `second edit ${String(report.secondEdit)}; ${outcome}`, problems };
      });
    },
    { check: true },
  );

  await step(
    'shiftTiming +30 ms',
    async () => {
      const s = need();
      if (!s.hello.capabilities.includes('timing.v1'))
        throw new StepSkip('SKIP', 'the instance does not report timing.v1');
      if (picks === undefined)
        throw new StepSkip('SKIP', `the audio has fewer than two voiced notes of ${String(MIN_NOTE_SEC)} s`);
      if (baseline === undefined) throw new Error('no baseline');
      const base = baseline;
      const anchor = spanOf(picks.shift).startSec;
      // Seeding cannot be undone (as in OpenTune) and must not change the sound: checked on its own export.
      const seeded = await s.call('content.editTimeGrid', { contentId, op: 'seed' }, 60_000);
      const job = member(seeded, 'job', 'the seed result');
      if (isObject(job)) await waitJob(s, text(job, 'jobId', 'the seed job'), 'time-grid seed', timeoutMs);
      await settle();
      const seededWav = await exportWet('after seeding the time grid');
      const unedited = (list: readonly Span[]) =>
        list.map((sp) => ({ startSec: sp.startSec - 0.05, endSec: sp.endSec + 0.05 }));
      const seededSamples = compareSamples(base, seededWav, unedited(spans));
      return guardedCheck('shiftTiming +30 ms', async (frame) => {
        const { before, report } = frame;
        report.seedUnchanged = seededSamples;
        if (seededSamples.maxAbsDiff > UNEDITED_MAX_ABS_DIFF_TIMING) {
          throw new Error(
            `seeding the time grid changed the sound by up to ${seededSamples.maxAbsDiff.toExponential(2)}`,
          );
        }
        if (before.handles.length === 0) throw new Error('the seeded time grid has no handles');
        // The handle nearest the start of the picked note; the notes before the handle before it
        // and after the handle after it do not move.
        const sorted = [...before.handles].sort((a, b) => a.contentSec - b.contentSec);
        const at = sorted.reduce((best, h) =>
          Math.abs(h.contentSec - anchor) < Math.abs(best.contentSec - anchor) ? h : best,
        );
        const k = sorted.indexOf(at);
        const previous = sorted[k - 1]?.contentSec ?? 0;
        const next = sorted[k + 1]?.contentSec ?? Infinity;
        const half = Math.min(0.05, Math.min(at.contentSec - previous, next - at.contentSec) / 3);
        const { after, problems } = await write(
          'content.shiftTiming',
          {
            contentId,
            expectedGridRevision: before.tokens.gridRevision,
            range: { startContentSec: round(at.contentSec - half, 6), endContentSec: round(at.contentSec + half, 6) },
            deltaSec: TIMING_SHIFT_SEC,
          },
          frame,
        );
        const moved = after.handles.find((h) => h.handleId === at.handleId);
        if (moved === undefined || !same(round(moved.outputSec - at.outputSec, 6), TIMING_SHIFT_SEC)) {
          problems.push(`handle ${at.handleId} moved to ${String(moved?.outputSec)} from ${String(at.outputSec)}`);
        }
        const others = after.handles.filter(
          (h) =>
            h.handleId !== at.handleId &&
            before.handles.find((b) => b.handleId === h.handleId)?.outputSec !== h.outputSec,
        );
        if (others.length > 0) problems.push(`${String(others.length)} other handles moved as well`);
        await settle();
        const wet = await exportWet('shiftTiming +30 ms');
        const shift = estimateShift(base.mono, wet.mono, base.sampleRateHz, {
          startSec: at.outputSec - SHIFT_WINDOW_SEC,
          endSec: at.outputSec + SHIFT_WINDOW_SEC,
        });
        const shiftMs = round(shift.lagSec * 1000);
        if (Math.abs(shift.lagSec - TIMING_SHIFT_SEC) > SHIFT_TOLERANCE_SEC) {
          problems.push(
            `the audio at the handle moved by ${String(shiftMs)} ms, expected ${String(TIMING_SHIFT_SEC * 1000)} +- ${String(SHIFT_TOLERANCE_SEC * 1000)}`,
          );
        }
        const still = spans.filter((sp) => sp.endSec < previous || sp.startSec > next);
        const stillShifts = still.map((sp) => {
          try {
            const e = estimateShift(base.mono, wet.mono, base.sampleRateHz, {
              startSec: sp.startSec - SHIFT_WINDOW_SEC,
              endSec: sp.startSec + SHIFT_WINDOW_SEC,
            });
            return { index: sp.index, shiftMs: round(e.lagSec * 1000) };
          } catch {
            return { index: sp.index, shiftMs: null };
          }
        });
        for (const st of stillShifts) {
          if (st.shiftMs === null || Math.abs(st.shiftMs) > SHIFT_TOLERANCE_SEC * 1000) {
            problems.push(`note ${String(st.index)}, away from the moved handle, moved by ${String(st.shiftMs)} ms`);
          }
        }
        const stillSamples = compareSamples(base, wet, unedited(still));
        if (stillSamples.maxAbsDiff > UNEDITED_MAX_ABS_DIFF_TIMING) {
          problems.push(
            `notes away from the moved handle differ from the baseline by up to ${stillSamples.maxAbsDiff.toExponential(2)}`,
          );
        }
        Object.assign(report, {
          toleranceMs: SHIFT_TOLERANCE_SEC * 1000,
          handle: {
            contentSec: at.contentSec,
            outputSecBefore: at.outputSec,
            outputSecAfter: moved?.outputSec ?? null,
          },
          measuredShiftMs: shiftMs,
          correlation: round(shift.peak, 4),
          notesAway: stillShifts,
          unedited: stillSamples,
          consistency: problems.slice(),
        });
        return {
          note: `moved by ${String(shiftMs)} ms at the handle, notes away from it unchanged; undo restored the grid`,
          problems,
        };
      });
    },
    { check: true },
  );

  const lengthTimings: Record<string, unknown>[] = [];
  for (const seconds of config.timingLengthsSec) {
    await step(
      `timing ${String(seconds)} s`,
      async () => {
        const s = need();
        const long = makeLongTone(seconds);
        const longFiles = await writeToneFiles(long, `effects-timing-${String(seconds)}`);
        try {
          // On a track of its own and not selected, so the clip of the checks stays as it is.
          const imported = await importAndAnalyse(longFiles.wavPath, { newTrack: true, focus: false });
          const id = imported.contentId;
          const notes = await s.call('content.getNotes', { contentId: id, limit: 1 }, 30_000);
          const details = await s.call('content.getDetails', { contentId: id }, 30_000);
          const mode = text(member(details, 'autoModes', 'content details'), 'uiButtonRuns', 'autoModes');
          let at = performance.now();
          const tuned = await s.call(
            'content.autoTune',
            {
              contentId: id,
              mode: mode === 'snapNotes' ? 'snapNotes' : 'regenerate',
              key: { root: 0, scale: 'chromatic' },
              expectedRevision: tokensOf(notes, id).revision,
            },
            120_000,
          );
          if (isObject(tuned.job)) await waitJob(s, text(tuned.job, 'jobId', 'the AUTO job'), 'AUTO', timeoutMs);
          await settle(id);
          const autoToSettleMs = Math.round(performance.now() - at);
          at = performance.now();
          const { dry } = await exportClip(`timing ${String(seconds)} s`, imported.placementId);
          const exportMs = Math.round(performance.now() - at);
          const importToF0ReadyMs = imported.ms;
          lengthTimings.push({
            sourceSec: round(long.truth.durationSec, 1),
            notes: long.truth.notes.length,
            importToF0ReadyMs,
            autoMode: mode,
            autoToSettleMs,
            exportMs,
          });
          if (dry.length > 0) throw new Error('the export lists the clip in dryContents');
          return `import to F0 ready ${(importToF0ReadyMs / 1000).toFixed(1)} s, AUTO to settled ${(autoToSettleMs / 1000).toFixed(1)} s, export ${(exportMs / 1000).toFixed(1)} s`;
        } finally {
          await longFiles.cleanup();
        }
      },
      { check: true },
    );
  }

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
  await files?.cleanup();
  const dataDir = target.takeDataDirs?.()[0] ?? null;
  timings.exports = exportTimes;
  timings.lengths = lengthTimings;
  const finalBackend: EffectsReport['backend'] = backend === null ? null : { ...backend, exports: [...exportBackends] };
  // Every step that exported gets the processing its exports reported (hybrid mode and backend).
  for (const [name, list] of processing) {
    const report = checks[name];
    checks[name] = { ...(isObject(report) ? report : {}), processing: list };
  }
  const reported = [sessionHybridMode, ...[...processing.values()].flat().map((p) => p.hybridMode)].filter(
    (v): v is boolean => v !== null,
  );
  const hybridMode = reported.length === 0 ? null : reported.includes(true);

  return {
    schema: 'opentune-mcp-e2e-effects/1',
    ...summarise(steps),
    notices: hybridMode === true ? [HYBRID_MODE_NOTICE] : [],
    hybridMode,
    dataTemplateFrom: config.dataTemplateFrom ?? null,
    startedAt,
    totalMs: Math.round(performance.now() - started),
    steps: steps.map((st) => ({ ...st, ms: Math.round(st.ms) })),
    instance: hello === undefined ? null : { protocol: hello.protocol, appVersion: hello.appVersion },
    backend: finalBackend,
    audio,
    tolerances: {
      pitchCents: PITCH_TOLERANCE_CENTS,
      shiftMs: SHIFT_TOLERANCE_SEC * 1000,
      uneditedMaxAbsDiffNotes: UNEDITED_MAX_ABS_DIFF_NOTES,
      uneditedMaxAbsDiffTiming: UNEDITED_MAX_ABS_DIFF_TIMING,
      resynthPreRollMs: RESYNTH_PRE_ROLL_SEC * 1000,
      phraseGapMs: PHRASE_GAP_SEC * 1000,
      resynthMaxResidualDb: RESYNTH_MAX_RESIDUAL_DB,
      minVoicedFrames: MIN_VOICED_FRAMES,
      estimatorErrorCents: ESTIMATOR_ERROR_CENTS,
      shiftEstimatorErrorMs: SHIFT_ERROR_SEC * 1000,
    },
    noiseFloor,
    checks,
    timings,
    dataDir,
    templateSkipped: target.stats?.templateSkipped ?? null,
    busyDiagnostics: diagnostics,
  };
}

function noteAt(state: ClipState, index: number): NoteRead {
  const note = state.notes.find((n) => n.index === index);
  if (note === undefined) throw new Error(`there is no note ${String(index)}`);
  return note;
}
