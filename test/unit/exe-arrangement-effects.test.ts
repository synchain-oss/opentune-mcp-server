// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The arrangement effects scenario (test/e2e/arrangement-effects.ts) against the stand-in
// executable (test/support/fake-opentune.mjs with test/support/fake-arrangement.mjs, `arrangement*`
// modes): every check passes against a stand-in that does what the specification says, and each way
// an instance can get an arrangement or track write wrong makes the check that is about it fail, and
// only that one. The measurements are also exercised on synthetic files, so a defect the stand-in
// does not have can still be shown to fail. Two runs of the real test file in a child process show
// that it is skipped without OTCP_TARGET_EXE and runs the scenario with it.

import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  FADE_END_MAX_DB,
  FADE_START_MAX_DB,
  GAIN_TOLERANCE_DB,
  SILENCE_MAX_ABS,
  TIMELINE_EPSILON_SEC,
  appliedSplitOf,
  arrangementEffectsSetupFromEnv,
  levelDifferenceDb,
  levelWindows,
  maxDifference,
  measureFade,
  mergeConsistency,
  projectSnapshotProblems,
  readProject,
  revertOf,
  rmsOf,
  runArrangementEffects,
  silenceOf,
  splitConsistency,
  splitPointOf,
  tokensProblems,
  trackOf,
  undoIdOf,
  wholeFileComparison,
  writeConsistency,
  type ArrangementEffectsConfig,
  type ArrangementEffectsReport,
  type PlacementRead,
  type ProjectState,
} from '../e2e/arrangement-effects.js';
import { generateTone } from '../support/harmonic-tone.js';
import { decodeWav, type DecodedWav } from '../support/wav-decode.js';

const FAKE = fileURLToPath(new URL('../support/fake-opentune.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const SLOW = 120_000;

const config = (mode: string, extra: Partial<ArrangementEffectsConfig> = {}): ArrangementEffectsConfig => ({
  exe: { exe: process.execPath, args: [FAKE, `--mode=${mode}`], timeoutMs: 15_000 },
  stepTimeoutMs: 20_000,
  reportPath: undefined,
  ...extra,
});

const results = (report: ArrangementEffectsReport) => Object.fromEntries(report.steps.map((s) => [s.name, s.result]));
const noteOf = (report: ArrangementEffectsReport, name: string) =>
  report.steps.find((s) => s.name === name)?.note ?? '';
// The type parameter is the point of this helper: it names the shape of one check's report.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const check = <T>(report: ArrangementEffectsReport, name: string): T => report.checks[name] as T;

const scratch: string[] = [];
async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ot-arrangement-test-'));
  scratch.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

const STEPS = [
  'prepare audio',
  'launch',
  'hello',
  'import and analysis',
  'baseline master export',
  'clip gain -6 dB',
  'fades are ramps',
  'mute and solo in the master export',
  'split boundary is seamless',
  'shutdown',
] as const;

interface GainCheck {
  readonly measuredDb: number | null;
  readonly expectedDb: number;
  readonly toleranceDb: number;
  readonly clipB: { readonly bitIdentical: boolean; readonly maxAbsDiff: number };
  readonly consistency: readonly string[];
  readonly undoRestored: boolean;
  readonly undo?: readonly string[];
  readonly processing: readonly {
    readonly export: string;
    readonly hybridMode: boolean;
    readonly backend: string;
    readonly vocoderWeight: string;
    readonly tuningHz: number;
  }[];
}

interface FadeReport {
  readonly edgeDb: number | null;
  readonly edgeWindowIndex: number | null;
  readonly edgeLevelDb: number | null;
  readonly fractions: {
    readonly at25Db: number | null;
    readonly at50Db: number | null;
    readonly at75Db: number | null;
  };
  readonly violations: readonly unknown[];
  readonly silentWindows: readonly number[];
}

interface FadeCheck {
  readonly fadeIn: FadeReport;
  readonly fadeOut: FadeReport;
  readonly unchanged: { readonly bitIdentical: number; readonly spans: number; readonly maxAbsDiff: number };
  readonly undoRestored: boolean;
}

interface MuteCheck {
  readonly cases: readonly {
    readonly case: string;
    readonly silent: { readonly maxAbs: number; readonly nonZeroSamples: number };
    readonly other: { readonly bitIdentical: boolean; readonly maxAbsDiff: number };
    readonly revert: { readonly applied: boolean; readonly master: { readonly bitIdentical: boolean } };
  }[];
}

interface SplitCheck {
  readonly requestedTimelineSec: number;
  readonly appliedTimelineSec: number;
  readonly snapped: boolean;
  readonly difference: {
    readonly bitIdentical: boolean;
    readonly maxAbsDiff: number;
    readonly timeSec: number | null;
    readonly distanceFromSplitSec: number | null;
  };
  readonly merge: {
    readonly applied?: boolean;
    readonly bitIdentical?: boolean;
    readonly refused?: string;
  };
}

describe('arrangement effects scenario against the stand-in', () => {
  it(
    'passes every check against an instance that does what the specification says',
    async () => {
      const report = await runArrangementEffects(config('arrangement'));
      expect(report.steps.map((s) => s.name)).toEqual([...STEPS]);
      expect(results(report)).toEqual(Object.fromEntries(STEPS.map((name) => [name, 'PASS'])));
      expect(report).toMatchObject({
        schema: 'opentune-mcp-e2e-arrangement-effects/1',
        result: 'PASS',
        hybridMode: false,
        dataTemplateFrom: null,
        audio: { source: 'generated' },
        instance: { protocol: '1.0' },
      });
      expect(report.tolerances).toMatchObject({ gainDb: -6, gainToleranceDb: GAIN_TOLERANCE_DB });
      // The master is stereo, starts at 0 and ends with clip B; both contents are dry (no note edit).
      const baseline = check<{ channels: number; dryContents: number }>(report, 'baseline master export');
      expect(baseline).toMatchObject({ channels: 2, dryContents: 2 });
      // Gain: clip A down 6 dB, clip B untouched; the undo put both back.
      const gain = check<GainCheck>(report, 'clip gain -6 dB');
      expect(gain).toMatchObject({
        expectedDb: -6,
        toleranceDb: 0.5,
        clipB: { bitIdentical: true },
        undoRestored: true,
      });
      expect(gain.measuredDb).toBeCloseTo(-6, 1);
      expect(gain.consistency).toEqual([]);
      expect(gain.processing[0]).toMatchObject({ hybridMode: false, backend: 'fake' });
      // Fades: both ramps start or end low, run one way and reach unity outside; the middle is untouched.
      const fades = check<FadeCheck>(report, 'fades are ramps');
      expect(fades.fadeIn.edgeDb).toBeLessThanOrEqual(FADE_START_MAX_DB);
      expect(fades.fadeOut.edgeDb).toBeLessThanOrEqual(FADE_END_MAX_DB);
      expect(fades.fadeIn.violations).toEqual([]);
      expect(fades.fadeOut.violations).toEqual([]);
      expect(fades.fadeIn.silentWindows).toEqual([]);
      expect(Math.abs(fades.fadeIn.edgeLevelDb ?? Number.NaN)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(fades.fadeOut.edgeLevelDb ?? Number.NaN)).toBeLessThanOrEqual(0.5);
      expect(fades.fadeIn.fractions.at25Db ?? 0).toBeLessThan(fades.fadeIn.fractions.at50Db ?? 0);
      expect(fades.fadeIn.fractions.at50Db ?? 0).toBeLessThan(fades.fadeIn.fractions.at75Db ?? 0);
      expect(fades.fadeOut.fractions.at25Db ?? 0).toBeGreaterThan(fades.fadeOut.fractions.at50Db ?? 0);
      expect(fades.fadeOut.fractions.at50Db ?? 0).toBeGreaterThan(fades.fadeOut.fractions.at75Db ?? -1000);
      expect(fades.unchanged).toMatchObject({ bitIdentical: 2, spans: 2, maxAbsDiff: 0 });
      expect(fades.undoRestored).toBe(true);
      // Mute and solo: three cases, each silencing one clip and leaving the other exact; each revert restored all.
      const mute = check<MuteCheck>(report, 'mute and solo in the master export');
      expect(mute.cases.map((c) => c.case)).toEqual(['mute track 2', 'solo track 1', 'solo track 2']);
      for (const c of mute.cases) {
        expect(c.silent.maxAbs, c.case).toBeLessThanOrEqual(SILENCE_MAX_ABS);
        expect(c.silent.nonZeroSamples, c.case).toBe(0);
        expect(c.other.bitIdentical, c.case).toBe(true);
        expect(c.revert.applied, c.case).toBe(true);
        expect(c.revert.master.bitIdentical, c.case).toBe(true);
      }
      // Split: snapped from the off-grid request, seamless, and the merge restored the baseline.
      const split = check<SplitCheck>(report, 'split boundary is seamless');
      expect(split.requestedTimelineSec).toBeCloseTo(1.203, 6);
      expect(split.appliedTimelineSec).toBeCloseTo(1.2, 6);
      expect(split.snapped).toBe(true);
      expect(split.difference).toMatchObject({ bitIdentical: true, maxAbsDiff: 0, distanceFromSplitSec: null });
      expect(split.merge).toMatchObject({ applied: true, bitIdentical: true });
      // Nothing in the report names an export file, a generated file or a user folder.
      expect(JSON.stringify(report)).not.toMatch(/ot-tone-|\.wav|arrangement-\d+|[A-Za-z]:[\\/]/);
    },
    SLOW,
  );

  it(
    'fails the gain check when the export holds a gain 3 dB from the one the result reports',
    async () => {
      const report = await runArrangementEffects(config('arrangement-gain-wrong'));
      expect(results(report)['clip gain -6 dB']).toBe('FAIL');
      expect(noteOf(report, 'clip gain -6 dB')).toMatch(/clip A changed by -3 dB, expected -6/);
      expect(results(report)['fades are ramps']).toBe('PASS');
      expect(results(report)['mute and solo in the master export']).toBe('PASS');
      expect(results(report)['split boundary is seamless']).toBe('PASS');
      expect(check<GainCheck>(report, 'clip gain -6 dB').undoRestored).toBe(true);
    },
    SLOW,
  );

  it(
    'fails the gain check when its result reports a value the project does not hold',
    async () => {
      const report = await runArrangementEffects(config('arrangement-gain-misreport'));
      expect(results(report)['clip gain -6 dB']).toBe('FAIL');
      expect(noteOf(report, 'clip gain -6 dB')).toMatch(/placement .* gainDb: the result says/);
      expect(check<GainCheck>(report, 'clip gain -6 dB').consistency.length).toBeGreaterThan(0);
      expect(results(report)['fades are ramps']).toBe('PASS');
    },
    SLOW,
  );

  it(
    'fails the fade check when the fades are steps at the wrong end',
    async () => {
      const report = await runArrangementEffects(config('arrangement-fade-step'));
      expect(results(report)['fades are ramps']).toBe('FAIL');
      expect(noteOf(report, 'fades are ramps')).toMatch(/fade-in: the first audible fade window is 0 dB/);
      expect(noteOf(report, 'fades are ramps')).toMatch(/fade-out: the last audible fade window is 0 dB/);
      expect(results(report)['clip gain -6 dB']).toBe('PASS');
      expect(results(report)['mute and solo in the master export']).toBe('PASS');
      expect(results(report)['split boundary is seamless']).toBe('PASS');
      expect(check<FadeCheck>(report, 'fades are ramps').undoRestored).toBe(true);
    },
    SLOW,
  );

  it(
    'fails the mute/solo check when a muted track leaks into the master',
    async () => {
      const report = await runArrangementEffects(config('arrangement-mute-leak'));
      expect(results(report)['mute and solo in the master export']).toBe('FAIL');
      expect(noteOf(report, 'mute and solo in the master export')).toMatch(
        /mute track 2: the clip that should be silent still reaches/,
      );
      const mute = check<MuteCheck>(report, 'mute and solo in the master export');
      expect(mute.cases[0]?.silent.maxAbs ?? 0).toBeGreaterThan(SILENCE_MAX_ABS);
      expect(mute.cases.every((c) => c.revert.master.bitIdentical)).toBe(true);
      expect(results(report)['split boundary is seamless']).toBe('PASS');
    },
    SLOW,
  );

  it(
    'fails both solo cases when the instance ignores solo, and still restores the tracks',
    async () => {
      const report = await runArrangementEffects(config('arrangement-solo-broken'));
      expect(results(report)['mute and solo in the master export']).toBe('FAIL');
      expect(noteOf(report, 'mute and solo in the master export')).toMatch(
        /solo track 1: the clip that should be silent/,
      );
      expect(noteOf(report, 'mute and solo in the master export')).toMatch(
        /solo track 2: the clip that should be silent/,
      );
      const mute = check<MuteCheck>(report, 'mute and solo in the master export');
      expect(mute.cases).toHaveLength(3);
      expect(mute.cases.every((c) => c.revert.master.bitIdentical)).toBe(true);
    },
    SLOW,
  );

  it(
    'fails the mute/solo check when its result reports the wrong mute value',
    async () => {
      const report = await runArrangementEffects(config('arrangement-track-misreport'));
      expect(results(report)['mute and solo in the master export']).toBe('FAIL');
      expect(noteOf(report, 'mute and solo in the master export')).toMatch(/track .* muted: the result says/);
      expect(results(report)['split boundary is seamless']).toBe('PASS');
    },
    SLOW,
  );

  it(
    'stops the checks after a track revert that does not restore the tracks',
    async () => {
      const report = await runArrangementEffects(config('arrangement-revert-broken'));
      const r = results(report);
      expect(r['clip gain -6 dB']).toBe('PASS');
      expect(r['fades are ramps']).toBe('PASS');
      expect(r['mute and solo in the master export']).toBe('FAIL');
      expect(noteOf(report, 'mute and solo in the master export')).toContain(
        'after the revert the project is not as it was',
      );
      expect(r['split boundary is seamless']).toBe('SKIP');
      expect(noteOf(report, 'split boundary is seamless')).toContain(
        'mute and solo in the master export ended with FAIL',
      );
      expect(r.shutdown).toBe('PASS');
    },
    SLOW,
  );

  it(
    'puts the tracks back when an export fails after a mute took effect, so the split check is not misled',
    async () => {
      const report = await runArrangementEffects(config('arrangement-export-fails-in-mute'));
      const r = results(report);
      expect(r['mute and solo in the master export']).toBe('FAIL');
      expect(noteOf(report, 'mute and solo in the master export')).toContain('mute track 2');
      // The mute was reverted although the measurement failed: the split check meets the clean project.
      expect(r['split boundary is seamless']).toBe('PASS');
      expect(r.shutdown).toBe('PASS');
    },
    SLOW,
  );

  it(
    'fails the split check, instead of calling the merge refused, when the export after an applied merge fails',
    async () => {
      const report = await runArrangementEffects(config('arrangement-export-fails-after-merge'));
      expect(results(report)['split boundary is seamless']).toBe('FAIL');
      expect(noteOf(report, 'split boundary is seamless')).toContain(
        'the merge was applied, but checking its result failed',
      );
      const split = check<{ merge: { refused?: string; applied?: boolean } }>(report, 'split boundary is seamless');
      expect(split.merge.refused).toBeUndefined();
      expect(split.merge.applied).toBe(true);
    },
    SLOW,
  );

  it(
    'fails the checks that export when the result names another file than the one asked for',
    async () => {
      const report = await runArrangementEffects(config('arrangement-export-other-path'));
      expect(results(report)['baseline master export']).toBe('FAIL');
      expect(noteOf(report, 'baseline master export')).toContain('another file than the one asked for');
    },
    SLOW,
  );

  it(
    'stops the checks when an undo does not put the clip back',
    async () => {
      const report = await runArrangementEffects(config('arrangement-undo-broken'));
      const r = results(report);
      expect(r['clip gain -6 dB']).toBe('FAIL');
      expect(noteOf(report, 'clip gain -6 dB')).toContain('after edit.undo the project is not as it was');
      expect(r['fades are ramps']).toBe('SKIP');
      expect(noteOf(report, 'fades are ramps')).toContain('clip gain -6 dB ended with FAIL');
      expect(r.shutdown).toBe('PASS');
    },
    SLOW,
  );

  it(
    'stops the checks when a write took effect but gives no undoId to take it back with',
    async () => {
      const report = await runArrangementEffects(config('arrangement-undo-missing'));
      expect(results(report)['clip gain -6 dB']).toBe('FAIL');
      expect(noteOf(report, 'clip gain -6 dB')).toContain(
        'arrangement.edit took effect, but its result says it cannot be undone (ui_parity)',
      );
      expect(results(report)['fades are ramps']).toBe('SKIP');
      expect(results(report).shutdown).toBe('PASS');
    },
    SLOW,
  );

  it(
    'fails the split when it drops a sample at its boundary, and reports where, then merges',
    async () => {
      const report = await runArrangementEffects(config('arrangement-split-gap'));
      expect(results(report)['split boundary is seamless']).toBe('FAIL');
      const note = noteOf(report, 'split boundary is seamless');
      expect(note).toMatch(/the master differs from the baseline by up to .* from the split/);
      const split = check<SplitCheck>(report, 'split boundary is seamless');
      expect(split.difference.bitIdentical).toBe(false);
      expect(split.difference.maxAbsDiff).toBeGreaterThan(0);
      expect(split.difference.distanceFromSplitSec ?? 1).toBeCloseTo(0, 3);
      expect(split.merge).toMatchObject({ applied: true, bitIdentical: true });
      expect(results(report)['clip gain -6 dB']).toBe('PASS');
    },
    SLOW,
  );

  it(
    'fails the split when created and idMap leave out the trailing clip, without failing its audio',
    async () => {
      const report = await runArrangementEffects(config('arrangement-split-misreport'));
      expect(results(report)['split boundary is seamless']).toBe('FAIL');
      expect(noteOf(report, 'split boundary is seamless')).toMatch(/created must name the two new clips/);
      const split = check<SplitCheck>(report, 'split boundary is seamless');
      expect(split.difference.bitIdentical).toBe(true);
      expect(split.merge).toMatchObject({ applied: true, bitIdentical: true });
    },
    SLOW,
  );

  it(
    'skips the checks whose capability is missing, and runs the others',
    async () => {
      const noArrangement = await runArrangementEffects(config('arrangement-no-arrangement'));
      const r = results(noArrangement);
      expect(r['import and analysis']).toBe('PASS');
      expect(noteOf(noArrangement, 'import and analysis')).toContain('silent tails kept (no arrangement.v1)');
      expect(r['clip gain -6 dB']).toBe('SKIP');
      expect(r['fades are ramps']).toBe('SKIP');
      expect(r['split boundary is seamless']).toBe('SKIP');
      expect(r['mute and solo in the master export']).toBe('PASS');
      expect(noArrangement.result).toBe('SKIP');

      const noTracks = await runArrangementEffects(config('arrangement-no-tracks'));
      expect(results(noTracks)['mute and solo in the master export']).toBe('SKIP');
      expect(results(noTracks)['clip gain -6 dB']).toBe('PASS');
      expect(results(noTracks)['split boundary is seamless']).toBe('PASS');

      const noHistory = await runArrangementEffects(config('arrangement-no-history'));
      expect(results(noHistory)['clip gain -6 dB']).toBe('SKIP');
      expect(results(noHistory)['fades are ramps']).toBe('SKIP');
      expect(results(noHistory)['mute and solo in the master export']).toBe('PASS');
      expect(results(noHistory)['split boundary is seamless']).toBe('PASS');
    },
    SLOW,
  );

  it(
    'is a FLAKY-SKIP when the inference backend cannot start, and records hybrid mode when it is on',
    async () => {
      const backend = await runArrangementEffects(config('arrangement-backend'));
      expect(backend.result).toBe('FLAKY-SKIP');
      expect(results(backend)['import and analysis']).toBe('FLAKY-SKIP');
      expect(noteOf(backend, 'import and analysis')).toContain('the inference backend could not be initialised');
      expect(results(backend).shutdown).toBe('PASS');

      const hybrid = await runArrangementEffects(config('arrangement-hybrid'));
      expect(hybrid).toMatchObject({ result: 'PASS', hybridMode: true });
      expect(check<GainCheck>(hybrid, 'clip gain -6 dB').processing[0]).toMatchObject({
        hybridMode: true,
        backend: 'fake',
      });
    },
    SLOW,
  );
});

describe('arrangement effects measurements', () => {
  const tone = (seconds = 2): DecodedWav =>
    decodeWav(generateTone({ seed: 11, leadSec: 0, notes: [{ midi: 60, durationSec: seconds }], fadeSec: 0.01 }).wav);
  const withEnvelope = (wav: DecodedWav, envelope: (t: number) => number): DecodedWav => {
    const samples = Float64Array.from(wav.mono, (value, i) => value * envelope(i / wav.sampleRateHz));
    return { ...wav, channels: [samples], mono: samples };
  };
  const placement = (overrides: Partial<PlacementRead> = {}): PlacementRead => ({
    placementId: 'p:0123abcd:0:1',
    trackId: 0,
    contentId: 'c:0123abcd:0:1',
    startTimelineSec: 0,
    endTimelineSec: 2,
    durationSec: 2,
    clipInContentSec: 0,
    gainDb: 0,
    gainLinear: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    geometryHash: 'h1',
    ...overrides,
  });
  const stateOf = (placements: readonly PlacementRead[], overrides: Partial<ProjectState> = {}): ProjectState => ({
    arrangementRevision: 'a1',
    contents: [{ contentId: 'c:0123abcd:0:1', revision: 'r1', gridRevision: 'g1', keyRevision: 'k1' }],
    placements,
    tracks: [
      { trackId: 0, muted: false, solo: false, audible: true },
      { trackId: 1, muted: false, solo: false, audible: true },
    ],
    ...overrides,
  });

  it('measures a level change and a fade ramp, and tells a step from a ramp', () => {
    const base = tone();
    const span = { startSec: 0, endSec: 2 };
    const quiet = withEnvelope(base, () => 10 ** (-6 / 20));
    expect(levelDifferenceDb(base, quiet, span)).toBeCloseTo(-6, 2);
    expect(rmsOf(quiet, span)).toBeLessThan(rmsOf(base, span));

    const faded = withEnvelope(base, (t) => Math.min(1, t / 0.5, (2 - t) / 0.5));
    const fadeIn = measureFade(base, faded, span, 0.5, 'in');
    const fadeOut = measureFade(base, faded, span, 0.5, 'out');
    expect(fadeIn.problems).toEqual([]);
    expect(fadeOut.problems).toEqual([]);
    expect(fadeIn.edgeDb).toBeLessThanOrEqual(FADE_START_MAX_DB);
    expect(fadeOut.edgeDb).toBeLessThanOrEqual(FADE_END_MAX_DB);
    expect(Math.abs(fadeIn.edgeLevelDb ?? Number.NaN)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(fadeOut.edgeLevelDb ?? Number.NaN)).toBeLessThanOrEqual(0.5);
    expect(fadeIn.fractions.at25Db ?? 0).toBeLessThan(fadeIn.fractions.at75Db ?? 0);
    expect(fadeOut.fractions.at25Db ?? 0).toBeGreaterThan(fadeOut.fractions.at75Db ?? -1000);
    expect(levelWindows(base, faded, 0, 0.5, 0.01)).toHaveLength(50);

    // No fade at all: the first and last audible windows are at unity, which is the failure.
    expect(measureFade(base, base, span, 0.5, 'in').problems.length).toBeGreaterThan(0);
    expect(measureFade(base, base, span, 0.5, 'out').problems.length).toBeGreaterThan(0);
    // A step at the wrong end: unity through the fade, then a drop.
    const step = withEnvelope(base, (t) => (t < 1.995 ? 1 : 0));
    expect(measureFade(base, step, span, 0.5, 'out').edgeDb).toBeGreaterThan(FADE_END_MAX_DB);
    // A reversed ramp rises where the fade-in should rise, but the fade-out rises too: its last audible
    // window is loud.
    const reversed = withEnvelope(base, (t) => Math.max(0, Math.min(1, (t - 0.5) / 1)));
    expect(measureFade(base, reversed, span, 0.5, 'out').problems.length).toBeGreaterThan(0);
  });

  it('finds the largest difference, its time and its distance from the split', () => {
    const base = tone(1.5);
    const span = { startSec: 0, endSec: 1.5 };
    expect(maxDifference(base, base, 1).bitIdentical).toBe(true);
    const altered = Float64Array.from(base.mono);
    const at = Math.round(1.2 * base.sampleRateHz);
    altered[at] = (altered[at] ?? 0) + 0.25;
    const wet = { ...base, channels: [altered], mono: altered };
    const diff = maxDifference(base, wet, 1.2);
    expect(diff.bitIdentical).toBe(false);
    expect(diff.maxAbsDiff).toBeCloseTo(0.25, 6);
    expect(diff.timeSec).toBeCloseTo(1.2, 6);
    expect(diff.distanceFromSplitSec).toBeCloseTo(0, 6);
    expect(wholeFileComparison(base, wet).bitIdentical).toBe(false);
    expect(wholeFileComparison(base, base).bitIdentical).toBe(true);
    expect(
      silenceOf(
        withEnvelope(base, () => 0),
        span,
      ),
    ).toMatchObject({ maxAbs: 0, nonZeroSamples: 0 });
    expect(silenceOf(base, span).maxAbs).toBeGreaterThan(0);
  });

  it('finds a split point strictly inside the longest voiced note', () => {
    const clip = placement();
    expect(
      splitPointOf(clip, [
        { index: 0, startContentSec: 0.2, endContentSec: 0.6, voiced: true },
        { index: 1, startContentSec: 0.8, endContentSec: 1.8, voiced: true },
      ]),
    ).toBeCloseTo(1.3, 6);
    expect(splitPointOf(clip, [{ index: 0, startContentSec: 0.2, endContentSec: 0.5, voiced: false }])).toBeUndefined();
    // A note that reaches outside the clip is intersected with it.
    expect(
      splitPointOf(placement({ startTimelineSec: 0.5, endTimelineSec: 1.5 }), [
        { index: 0, startContentSec: 0, endContentSec: 2, voiced: true },
      ]),
    ).toBeCloseTo(1, 6);
  });

  it('reads the applied split position from SPLIT_SNAPPED', () => {
    expect(appliedSplitOf({ warnings: [] }, 1.203)).toEqual({
      appliedTimelineSec: 1.203,
      snapped: false,
      reportedRequested: null,
    });
    expect(
      appliedSplitOf(
        { warnings: [{ code: 'SPLIT_SNAPPED', data: { requestedTimelineSec: 1.203, appliedTimelineSec: 1.2 } }] },
        1.203,
      ),
    ).toEqual({ appliedTimelineSec: 1.2, snapped: true, reportedRequested: 1.203 });
    expect(appliedSplitOf({ warnings: [{ code: 'SPLIT_SNAPPED', data: {} }] }, 1.203).appliedTimelineSec).toBe(1.203);
  });

  it('compares a write result with the project: changes, tokens, created/removed/idMap and snapshots', () => {
    const old = placement();
    const state = stateOf([old]);
    const tokens = {
      arrangementRevision: 'a1',
      contents: [{ contentId: old.contentId, revision: 'r1', gridRevision: 'g1', keyRevision: 'k1' }],
      placements: [{ placementId: old.placementId, geometryHash: old.geometryHash }],
    };
    expect(tokensProblems({ tokens }, state)).toEqual([]);
    expect(tokensProblems({ tokens: { ...tokens, arrangementRevision: 'a0' } }, state)).toEqual([
      'tokens.arrangementRevision is not the one read afterwards',
    ]);
    expect(tokensProblems({ tokens: { ...tokens, placements: [] } }, state)).toEqual([]);
    expect(
      tokensProblems(
        { tokens: { ...tokens, placements: [{ placementId: 'p:0123abcd:0:9', geometryHash: 'h9' }] } },
        state,
      ),
    ).toEqual(['tokens names placement p:0123abcd:0:9, which is not there afterwards']);

    const result = {
      tokens,
      changes: [
        {
          entity: 'placement',
          ref: { placementId: old.placementId },
          fields: { gainDb: { before: 0, after: 0, unit: 'db' }, futureField: { before: 0, after: 1 } },
        },
      ],
    };
    expect(writeConsistency(result, state)).toEqual({ problems: [], unreadFields: ['placement.futureField'] });
    expect(
      writeConsistency(
        { ...result, changes: [{ ...result.changes[0], fields: { gainDb: { before: 0, after: -3 } } }] },
        state,
      ).problems,
    ).toEqual(['placement p:0123abcd:0:1 gainDb: the result says -3, read back 0']);

    const after = placement({
      placementId: 'p:0123abcd:0:2',
      startTimelineSec: 0,
      endTimelineSec: 1,
      durationSec: 1,
      gainDb: -6,
      gainLinear: 10 ** (-6 / 20),
      fadeInSec: 0.2,
      fadeOutSec: 0.2,
      geometryHash: 'h2',
    });
    const trailing = placement({
      placementId: 'p:0123abcd:0:3',
      startTimelineSec: 1,
      clipInContentSec: 1,
      endTimelineSec: 2,
      durationSec: 1,
      geometryHash: 'h3',
    });
    const splitState = stateOf([after, trailing]);
    const splitResult = {
      created: [
        { entity: 'placement', ref: { placementId: after.placementId }, label: null },
        { entity: 'placement', ref: { placementId: trailing.placementId }, label: null },
      ],
      removed: [{ entity: 'placement', ref: { placementId: old.placementId }, label: null }],
      idMap: [
        {
          entity: 'placement',
          relation: 'split',
          from: [{ placementId: old.placementId }],
          to: [{ placementId: after.placementId }, { placementId: trailing.placementId }],
        },
      ],
    };
    expect(splitConsistency(splitResult, splitState, old, 1)).toEqual([]);
    expect(
      splitConsistency({ ...splitResult, created: splitResult.created.slice(0, 1) }, splitState, old, 1),
    ).toContain('created must name the two new clips (it says 1)');
    expect(
      splitConsistency({ ...splitResult, idMap: [{ ...splitResult.idMap[0], from: [] }] }, splitState, old, 1),
    ).toContain('idMap.from must name the split clip (it says nothing)');
    expect(splitConsistency(splitResult, stateOf([old]), old, 1)).not.toEqual([]);

    const merged = placement({ placementId: 'p:0123abcd:0:3', endTimelineSec: 2, durationSec: 2, geometryHash: 'h4' });
    const mergeResult = {
      created: [{ entity: 'placement', ref: { placementId: merged.placementId }, label: null }],
      removed: [
        { entity: 'placement', ref: { placementId: after.placementId }, label: null },
        { entity: 'placement', ref: { placementId: trailing.placementId }, label: null },
      ],
      idMap: [
        {
          entity: 'placement',
          relation: 'merge',
          from: [{ placementId: after.placementId }, { placementId: trailing.placementId }],
          to: [{ placementId: merged.placementId }],
        },
      ],
    };
    expect(mergeConsistency(mergeResult, stateOf([merged]), after, trailing)).toEqual([]);

    expect(projectSnapshotProblems(state, state)).toEqual([]);
    expect(projectSnapshotProblems(state, stateOf([placement({ gainDb: -6, gainLinear: 10 ** (-6 / 20) })]))).toContain(
      'placement p:0123abcd:0:1 gainDb: 0 before, -6 after',
    );
    expect(trackOf(state, 1)).toMatchObject({ muted: false, solo: false, audible: true });
    expect(placement({ fadeInSec: 0.1 }).fadeInSec).toBe(0.1);
  });

  it('reads the undoId and the revert recipe, and refuses a result that has neither', () => {
    expect(undoIdOf({ undo: { undoable: true, undoId: 'u:1' } })).toBe('u:1');
    expect(() => undoIdOf({ undo: { undoable: false, reason: 'ui_parity' } })).toThrow(
      /cannot be undone \(ui_parity\)/,
    );
    expect(() => undoIdOf({ undo: { undoable: true } })).toThrow(/no undoId/);
    expect(() => undoIdOf({})).toThrow(/no undo block/);
    expect(revertOf({ undo: { undoable: false, revert: { method: 'track.set', params: { tracks: [] } } } })).toEqual({
      method: 'track.set',
      params: { tracks: [] },
      requiresConsent: false,
    });
    expect(revertOf({ undo: { undoable: false, revert: null } })).toBeUndefined();
    expect(revertOf({})).toBeUndefined();
  });

  it('reads a project with its tracks and clips, and names what is missing', async () => {
    const read = {
      asOf: {
        arrangementRevision: 'a1',
        contents: [{ contentId: 'c:0123abcd:0:1', revision: 'r1', gridRevision: 'g1', keyRevision: 'k1' }],
      },
      placements: [
        {
          placementId: 'p:0123abcd:0:1',
          trackId: 0,
          contentId: 'c:0123abcd:0:1',
          name: null,
          startTimelineSec: 0,
          endTimelineSec: 2,
          durationSec: 2,
          clipInContentSec: 0,
          gainDb: -6,
          gainLinear: 0.501187,
          fadeInSec: 0.5,
          fadeOutSec: 0.5,
          referencePlacementId: null,
          sourcePath: null,
          geometryHash: 'h1',
        },
      ],
      tracks: [
        {
          trackId: 0,
          label: 'Track 1',
          visible: true,
          muted: false,
          solo: true,
          audible: true,
          volumeDb: 0,
          volumeLinear: 1,
          colour: '#808080',
          rmsDb: null,
          placementCount: 1,
        },
      ],
    };
    const fakeSession = { call: (method: string) => Promise.resolve(method === 'project.get' ? read : {}) };
    const state = await readProject(fakeSession as never);
    expect(state.arrangementRevision).toBe('a1');
    expect(state.placements[0]).toMatchObject({ placementId: 'p:0123abcd:0:1', gainDb: -6, fadeInSec: 0.5 });
    expect(trackOf(state, 0)).toMatchObject({ solo: true, audible: true });
    expect(TIMELINE_EPSILON_SEC).toBeLessThan(0.001);
  });
});

describe('arrangement effects configuration', () => {
  const exe = { OTCP_TARGET_EXE: process.execPath };

  it('is skipped without OTCP_TARGET_EXE, and reads its own report and data template', async () => {
    expect(arrangementEffectsSetupFromEnv({})).toEqual({ skip: 'OTCP_TARGET_EXE is not set' });
    const base = path.join(os.tmpdir(), 'reports');
    expect(arrangementEffectsSetupFromEnv(exe)).toMatchObject({
      config: { reportPath: undefined, stepTimeoutMs: 180_000, dataTemplateFrom: null },
    });
    expect(arrangementEffectsSetupFromEnv({ ...exe, OTCP_E2E_REPORT: path.join(base, 'smoke.json') })).toMatchObject({
      config: { reportPath: path.join(base, 'arrangement-effects.json') },
    });
    expect(
      arrangementEffectsSetupFromEnv({
        ...exe,
        OTCP_E2E_REPORT: path.join(base, 'smoke.json'),
        OTCP_E2E_ARRANGEMENT_EFFECTS_REPORT: path.join(base, 'mine.json'),
        OTCP_E2E_STEP_TIMEOUT_MS: '5000',
      }),
    ).toMatchObject({ config: { reportPath: path.join(base, 'mine.json'), stepTimeoutMs: 5000 } });
    for (const env of [
      { OTCP_E2E_ARRANGEMENT_EFFECTS_REPORT: 'relative.json' },
      { OTCP_E2E_REPORT: 'relative.json' },
      { OTCP_E2E_STEP_TIMEOUT_MS: '-1' },
    ]) {
      expect(() => arrangementEffectsSetupFromEnv({ ...exe, ...env }), JSON.stringify(env)).toThrow();
    }
    const shared = await tmp();
    const own = await tmp();
    expect(arrangementEffectsSetupFromEnv({ ...exe, OTCP_TARGET_DATA_TEMPLATE: shared })).toMatchObject({
      config: { exe: { dataTemplate: shared }, dataTemplateFrom: 'OTCP_TARGET_DATA_TEMPLATE' },
    });
    expect(
      arrangementEffectsSetupFromEnv({
        ...exe,
        OTCP_TARGET_DATA_TEMPLATE: shared,
        OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE: own,
      }),
    ).toMatchObject({
      config: { exe: { dataTemplate: own }, dataTemplateFrom: 'OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE' },
    });
    expect(() =>
      arrangementEffectsSetupFromEnv({ ...exe, OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE: 'relative' }),
    ).toThrow('OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE must be an absolute path');
    expect(() =>
      arrangementEffectsSetupFromEnv({ ...exe, OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE: path.join(own, 'missing') }),
    ).toThrow('OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE is not an existing directory');
  });
});

/**
 * Runs the real test file of the scenario in a child process, with only the variables given. The
 * child's output goes to a file rather than through pipes: a pipe is what the sandboxed test run
 * cannot create, and the file is also easier to read after the run.
 */
function runTestFile(env: Record<string, string>): { readonly status: number | null; readonly output: string } {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OTCP_')));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ot-arrangement-file-'));
  const log = path.join(dir, 'test.log');
  const fd = openSync(log, 'w');
  try {
    const run = spawnSync(
      process.execPath,
      [
        VITEST,
        'run',
        '--pool=threads',
        '--project',
        'e2e',
        '--reporter=verbose',
        'test/e2e/exe-arrangement-effects.test.ts',
      ],
      {
        cwd: ROOT,
        // The e2e project builds the bundle in its global setup; the arrangement scenario does not
        // use it, and SMOKE_BUNDLE makes the setup skip that build.
        env: { ...clean, SMOKE_BUNDLE: path.join(ROOT, 'dist', 'opentune-mcp.mjs'), ...env },
        stdio: ['ignore', fd, fd],
        timeout: 110_000,
      },
    );
    const output = readFileSync(log, 'utf8');
    return {
      status: run.status,
      output: run.error === undefined ? output : `${output}\n${run.error.message}`,
    };
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the arrangement effects scenario as a test file', () => {
  it(
    'is skipped as a whole, with its reason, when OTCP_TARGET_EXE is not set',
    () => {
      const run = runTestFile({});
      expect(run.status).toBe(0);
      expect(run.output).toContain('exe arrangement effects not run: OTCP_TARGET_EXE is not set');
      expect(run.output).toMatch(/1 skipped/);
      expect(run.output).not.toMatch(/passed/);
    },
    SLOW,
  );

  it(
    'runs the scenario and writes arrangement-effects.json next to the smoke report when OTCP_TARGET_EXE is set',
    async () => {
      const dir = await tmp();
      const template = await tmp();
      const run = runTestFile({
        OTCP_TARGET_EXE: process.execPath,
        OTCP_TARGET_ARGS: JSON.stringify([FAKE, '--mode=arrangement-hybrid']),
        OTCP_E2E_REPORT: path.join(dir, 'report.json'),
        OTCP_E2E_STEP_TIMEOUT_MS: '20000',
        OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE: template,
      });
      expect(run.status, run.output).toBe(0);
      expect(run.output).toMatch(/\| split boundary is seamless \| PASS \|/);
      const written = JSON.parse(
        await readFile(path.join(dir, 'arrangement-effects.json'), 'utf8'),
      ) as ArrangementEffectsReport;
      expect(written).toMatchObject({
        schema: 'opentune-mcp-e2e-arrangement-effects/1',
        result: 'PASS',
        hybridMode: true,
        dataTemplateFrom: 'OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE',
      });
      expect(Object.keys(written).slice(0, 3)).toEqual(['schema', 'result', 'counts']);
      expect(check<GainCheck>(written, 'clip gain -6 dB').processing).toContainEqual({
        export: 'gain -6 dB',
        hybridMode: true,
        backend: 'fake',
        vocoderWeight: 'fake',
        tuningHz: 440,
      });
    },
    SLOW,
  );
});
