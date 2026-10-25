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
  COHERENT_SUM_DB,
  FADE_END_MAX_DB,
  FADE_START_MAX_DB,
  GAIN_TOLERANCE_DB,
  ONSET_LEVEL,
  POSITION_QUANTUM_SAMPLES,
  SILENCE_MAX_ABS,
  TIMELINE_EPSILON_SEC,
  appliedSplitOf,
  bestSumDifference,
  arrangementEffectsSetupFromEnv,
  changesPlacementField,
  coherentSumOf,
  copyConsistency,
  copyPairs,
  duplicateConsistency,
  entityIds,
  fitError,
  fitGain,
  importLayoutProblems,
  importedClips,
  levelDifferenceDb,
  levelWindows,
  maxDifference,
  measureFade,
  mergeConsistency,
  onsetOf,
  placedDifference,
  paddedTo,
  projectSnapshotProblems,
  readProject,
  revertOf,
  revertRequest,
  rmsOf,
  runArrangementEffects,
  shiftedDifference,
  silenceOf,
  splitConsistency,
  splitPartsOf,
  splitPointOf,
  sumDifference,
  tokensProblems,
  trackDeleteConsistency,
  trackOf,
  undoIdOf,
  warningCodes,
  wholeFileComparison,
  writeConsistency,
  type ArrangementEffectsConfig,
  type ArrangementEffectsReport,
  type PlacementRead,
  type ProjectState,
  type TrackRead,
} from '../e2e/arrangement-effects.js';
import { fakeUserSettingsEnv } from '../support/fake-user-settings.js';
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
const failed = (report: ArrangementEffectsReport) => report.steps.filter((s) => s.result === 'FAIL').map((s) => s.name);
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
  'move clip B 0.5 s later',
  'trim clip A end by 1 s',
  'copy window of clip A',
  'copy full of clip A',
  'delete a copy of clip A',
  'track volume -6 dB',
  'duplicate track clone',
  'duplicate track share',
  'delete a duplicated track',
  'split boundary is seamless',
  'batch import sequential and separateTracks',
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

interface RestoredCheck {
  readonly consistency: readonly string[];
}

interface MoveCheck extends RestoredCheck {
  readonly deltaSec: number;
  readonly measuredShiftSec: number | null;
  readonly newPlaceMaxAbsDiff: number;
  readonly startLagSamples: number;
  readonly oldPlaceMaxAbs: number;
  readonly undoRestored: boolean;
  readonly restoredBy: string;
}

interface TrimCheck extends RestoredCheck {
  readonly cutSec: number;
  readonly newEndSec: number;
  readonly cutPartBaselineRms: number;
  readonly keptBitIdentical: boolean;
  readonly afterEnd: { readonly maxAbs: number; readonly nonZeroSamples: number };
  readonly undoRestored: boolean;
}

interface CopyCheck extends RestoredCheck {
  readonly mode: string;
  readonly startTimelineSec: number;
  readonly copyMaxAbsDiff: number;
  readonly baselinePartBitIdentical: boolean;
  readonly revert: { readonly method: string; readonly requiresConsent: boolean } | null;
  readonly warnings: readonly string[];
  readonly revertRestored: boolean;
}

interface UndoBlock {
  readonly undoable: boolean;
  readonly reason: string | null;
  readonly revert: boolean;
}

interface DeleteCheck {
  readonly refusedWithoutConfirm: boolean;
  readonly copyBeforeDeleteMaxAbsDiff: number;
  readonly afterDelete: { readonly bitIdentical: boolean; readonly lengthsEqual: boolean };
  readonly undo: UndoBlock | null;
  readonly warnings: readonly string[];
}

interface VolumeCheck {
  readonly cases: readonly {
    readonly case: string;
    readonly measuredDb: number | null;
    readonly clipB: { readonly bitIdentical: boolean };
    readonly consistency: readonly string[];
    readonly revertRestored: boolean;
  }[];
}

interface DuplicateCheck extends RestoredCheck {
  readonly mode: string;
  readonly clipALevelDb: number | null;
  readonly clipAMaxAbsDiffFromTwiceBaseline: number;
  readonly restBitIdentical: boolean;
  readonly revert: { readonly method: string; readonly requiresConsent: boolean } | null;
  readonly warnings: readonly string[];
  readonly revertRestored: boolean;
}

interface TrackDeleteCheck {
  readonly deletedTrackId: number;
  readonly trackIdMap: readonly { readonly before: number; readonly after: number | null }[] | null;
  readonly refusedWithoutConfirm: boolean;
  readonly afterDelete: { readonly bitIdentical: boolean; readonly lengthsEqual: boolean };
  readonly undo: UndoBlock | null;
  readonly warnings: readonly string[];
}

interface ImportCheck {
  readonly cases: readonly {
    readonly case: string;
    readonly clips: readonly {
      readonly trackId: number;
      readonly startTimelineSec: number;
      readonly durationSec: number;
    }[];
    readonly sumMaxAbsDiff: number;
    readonly revert: { readonly method: string; readonly givenByInstance: boolean };
    readonly onsets: readonly {
      readonly expectedSec: number | null;
      readonly measuredSec: number | null;
    }[];
    readonly revertRestored: boolean;
  }[];
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
      expect(mute.cases.map((c) => c.case)).toEqual(['mute track 1', 'solo track 0', 'solo track 1']);
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
      // Move: clip B 0.5 s later, read off the master by cross-correlation; undone with edit.undo.
      const move = check<MoveCheck>(report, 'move clip B 0.5 s later');
      expect(move).toMatchObject({
        deltaSec: 0.5,
        newPlaceMaxAbsDiff: 0,
        oldPlaceMaxAbs: 0,
        undoRestored: true,
        restoredBy: 'edit.undo',
      });
      expect(move.measuredShiftSec).toBeCloseTo(0.5, 3);
      // 4.1 s is sample 180809.99999999997: a start that is truncated sounds one sample early.
      expect(move.startLagSamples).toBe(-1);
      expect(move.consistency).toEqual([]);
      // Trim: the cut part is silent, the kept part and the rest are the baseline; undone with edit.undo.
      const trim = check<TrimCheck>(report, 'trim clip A end by 1 s');
      expect(trim).toMatchObject({
        cutSec: 1,
        keptBitIdentical: true,
        afterEnd: { maxAbs: 0, nonZeroSamples: 0 },
        undoRestored: true,
      });
      expect(trim.newEndSec).toBeCloseTo(1.4, 6);
      expect(trim.cutPartBaselineRms).toBeGreaterThan(0.1);
      // Copy, window and full: the copy sounds as clip A; taken back by the revert recipe.
      for (const mode of ['window', 'full']) {
        const copy = check<CopyCheck>(report, `copy ${mode} of clip A`);
        expect(copy, mode).toMatchObject({
          mode,
          copyMaxAbsDiff: 0,
          baselinePartBitIdentical: true,
          revert: { method: 'arrangement.edit', requiresConsent: true },
          revertRestored: true,
          warnings: [],
          consistency: [],
        });
        expect(copy.startTimelineSec).toBeGreaterThan(5.6);
      }
      // Delete: refused without confirm, accepted with it; not undoable, and says so.
      const deleted = check<DeleteCheck>(report, 'delete a copy of clip A');
      expect(deleted).toMatchObject({
        refusedWithoutConfirm: true,
        copyBeforeDeleteMaxAbsDiff: 0,
        afterDelete: { bitIdentical: true, lengthsEqual: true },
        undo: { undoable: false, reason: 'upstream_undo_defect', revert: false },
      });
      expect(deleted.warnings).toEqual(expect.arrayContaining(['IRREVERSIBLE']));
      // Track volume: -6 dB by dB and by linear gain, each taken back by the revert recipe.
      const volume = check<VolumeCheck>(report, 'track volume -6 dB');
      expect(volume.cases.map((c) => c.case)).toEqual(['volumeDb -6', 'volumeLinear 0.5']);
      expect(volume.cases[0]?.measuredDb ?? Number.NaN).toBeCloseTo(-6, 1);
      expect(volume.cases[1]?.measuredDb ?? Number.NaN).toBeCloseTo(-6.02, 1);
      for (const c of volume.cases) {
        expect(c.clipB.bitIdentical, c.case).toBe(true);
        expect(c.consistency, c.case).toEqual([]);
        expect(c.revertRestored, c.case).toBe(true);
      }
      // Duplicate, clone and share: twice clip A's signal, and the revert (a track delete) puts it back.
      for (const mode of ['clone', 'share']) {
        const duplicate = check<DuplicateCheck>(report, `duplicate track ${mode}`);
        expect(duplicate, mode).toMatchObject({
          mode,
          clipAMaxAbsDiffFromTwiceBaseline: 0,
          restBitIdentical: true,
          revert: { method: 'track.delete', requiresConsent: true },
          revertRestored: true,
          consistency: [],
        });
        expect(duplicate.clipALevelDb ?? Number.NaN, mode).toBeCloseTo(6.02, 1);
        expect(duplicate.warnings, mode).toEqual(mode === 'share' ? ['SHARED_CONTENT'] : []);
      }
      // Track delete: refused without confirm, trackIdMap agrees with the project, the master is the baseline.
      const trackDelete = check<TrackDeleteCheck>(report, 'delete a duplicated track');
      expect(trackDelete).toMatchObject({
        refusedWithoutConfirm: true,
        trackIdMap: [{ before: trackDelete.deletedTrackId, after: null }],
        afterDelete: { bitIdentical: true, lengthsEqual: true },
        undo: { undoable: false, reason: 'no_upstream_undo', revert: false },
        warnings: ['IRREVERSIBLE'],
      });
      // Batch import: sequential joins the clips; separateTracks puts both at 0 on two tracks.
      const imports = check<ImportCheck>(report, 'batch import sequential and separateTracks');
      expect(imports.cases.map((c) => c.case)).toEqual(['sequential', 'separateTracks']);
      const [sequential, separate] = imports.cases;
      expect(sequential?.clips).toHaveLength(2);
      expect(sequential?.clips[0]?.startTimelineSec).toBe(10);
      expect(sequential?.clips[1]?.startTimelineSec).toBeCloseTo(
        (sequential?.clips[0]?.startTimelineSec ?? 0) + (sequential?.clips[0]?.durationSec ?? 0),
        5,
      );
      expect(sequential?.sumMaxAbsDiff ?? 1).toBeLessThanOrEqual(1e-6);
      for (const onset of sequential?.onsets ?? []) {
        expect(Math.abs((onset.measuredSec ?? Number.NaN) - (onset.expectedSec ?? Number.NaN))).toBeLessThanOrEqual(
          0.001,
        );
      }
      expect(separate?.clips.map((c) => c.startTimelineSec)).toEqual([0, 0]);
      expect(separate?.clips[1]?.trackId).toBe((separate?.clips[0]?.trackId ?? -1) + 1);
      expect(separate?.sumMaxAbsDiff ?? 1).toBeLessThanOrEqual(1e-6);
      for (const c of imports.cases) {
        expect(c.revertRestored, c.case).toBe(true);
        expect(c.revert, c.case).toMatchObject({ method: 'arrangement.edit', givenByInstance: true });
      }
      expect(report.tolerances).toMatchObject({ moveDeltaSec: 0.5, trimCutSec: 1, trackVolumeToleranceDb: 0.5 });
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
        /mute track 1: the clip that should be silent still reaches/,
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
        /solo track 0: the clip that should be silent/,
      );
      expect(noteOf(report, 'mute and solo in the master export')).toMatch(
        /solo track 1: the clip that should be silent/,
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
      expect(noteOf(report, 'mute and solo in the master export')).toContain('mute track 1');
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
    'fails the split check, instead of calling the merge refused, when an applied merge cannot be checked because the two split clips are not found',
    async () => {
      const report = await runArrangementEffects(config('arrangement-split-extra-part'));
      expect(results(report)['split boundary is seamless']).toBe('FAIL');
      expect(noteOf(report, 'split boundary is seamless')).toContain(
        'the merge was applied, but checking its result failed: the two split clips cannot be found for the merge check',
      );
      const split = check<{ merge: { refused?: string; applied?: boolean; checkFailed?: string } }>(
        report,
        'split boundary is seamless',
      );
      expect(split.merge.refused).toBeUndefined();
      expect(split.merge).toMatchObject({
        applied: true,
        checkFailed: 'the two split clips cannot be found for the merge check',
      });
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
    'fails the move check, and only it, when the clip sounds 50 ms later than the project says',
    async () => {
      const report = await runArrangementEffects(config('arrangement-move-wrong'));
      expect(failed(report)).toEqual(['move clip B 0.5 s later']);
      expect(noteOf(report, 'move clip B 0.5 s later')).toMatch(/clip B moved by 550 ms, expected 500 ms \+- 2 ms/);
      expect(noteOf(report, 'move clip B 0.5 s later')).toMatch(/the master at the new place differs from clip B/);
      // The undo put the clip back although the measurement failed, so the later checks meet the baseline.
      expect(check<MoveCheck>(report, 'move clip B 0.5 s later').undoRestored).toBe(true);
      expect(results(report).shutdown).toBe('PASS');
    },
    SLOW,
  );

  it(
    'fails the trim check, and only it, when the cut part of the clip is still rendered',
    async () => {
      const report = await runArrangementEffects(config('arrangement-trim-not-rendered'));
      expect(failed(report)).toEqual(['trim clip A end by 1 s']);
      expect(noteOf(report, 'trim clip A end by 1 s')).toMatch(/clip A is still heard after its new end/);
      expect(check<TrimCheck>(report, 'trim clip A end by 1 s').undoRestored).toBe(true);
    },
    SLOW,
  );

  it(
    'fails the copy checks when a copy sounds two samples away from where it is, and the delete check that makes a copy too',
    async () => {
      const report = await runArrangementEffects(config('arrangement-copy-offset'));
      expect(failed(report)).toEqual(['copy window of clip A', 'copy full of clip A', 'delete a copy of clip A']);
      for (const name of ['copy window of clip A', 'copy full of clip A']) {
        expect(noteOf(report, name), name).toMatch(/the copy in the master differs from its source in the baseline/);
        // The copy was taken back all the same.
        expect(check<CopyCheck>(report, name).revertRestored, name).toBe(true);
      }
      expect(noteOf(report, 'delete a copy of clip A')).toMatch(/the copy made for the delete is not heard as clip A/);
      expect(results(report)['batch import sequential and separateTracks']).toBe('PASS');
    },
    SLOW,
  );

  it(
    'fails the delete check, and only it, when a deleted clip is still in the master',
    async () => {
      const report = await runArrangementEffects(config('arrangement-delete-ghost'));
      expect(failed(report)).toEqual(['delete a copy of clip A']);
      expect(noteOf(report, 'delete a copy of clip A')).toMatch(
        /the master after the delete differs from the baseline by up to .* and has another length/,
      );
      // The copy is gone from the project; the checks after it meet the baseline.
      expect(results(report)['split boundary is seamless']).toBe('PASS');
    },
    SLOW,
  );

  it(
    'fails the delete checks when a clip or a track is deleted without confirm',
    async () => {
      const report = await runArrangementEffects(config('arrangement-delete-unconfirmed'));
      expect(failed(report)).toEqual(['delete a copy of clip A', 'delete a duplicated track']);
      expect(noteOf(report, 'delete a copy of clip A')).toContain(
        'arrangement.edit was not refused, expected INVALID_ARGUMENT(confirm_required); the delete without confirm removed the copy',
      );
      expect(noteOf(report, 'delete a duplicated track')).toContain(
        'track.delete was not refused, expected INVALID_ARGUMENT(confirm_required); the delete without confirm removed the track',
      );
      expect(results(report).shutdown).toBe('PASS');
    },
    SLOW,
  );

  it(
    'fails the track volume check, and only it, when the export ignores the volume',
    async () => {
      const report = await runArrangementEffects(config('arrangement-volume-ignored'));
      expect(failed(report)).toEqual(['track volume -6 dB']);
      const note = noteOf(report, 'track volume -6 dB');
      expect(note).toContain('volumeDb -6: clip A changed by 0 dB, expected -6 +- 0.5 dB');
      expect(note).toContain('volumeLinear 0.5: clip A changed by 0 dB, expected -6.02 +- 0.5 dB');
      // Both reverts restored the track.
      expect(check<VolumeCheck>(report, 'track volume -6 dB').cases.every((c) => c.revertRestored)).toBe(true);
    },
    SLOW,
  );

  it(
    'fails the duplicate checks when the duplicated track does not sound, and the delete check that makes one',
    async () => {
      const report = await runArrangementEffects(config('arrangement-duplicate-silent'));
      expect(failed(report)).toEqual(['duplicate track clone', 'duplicate track share', 'delete a duplicated track']);
      expect(noteOf(report, 'duplicate track clone')).toMatch(
        /the master over clip A differs from twice the baseline by up to .*the level over clip A changed by 0 dB, expected 6.02 \+- 0.5 dB/,
      );
      expect(noteOf(report, 'delete a duplicated track')).toContain(
        'before the delete: the master over clip A differs',
      );
      expect(check<DuplicateCheck>(report, 'duplicate track clone').revertRestored).toBe(true);
    },
    SLOW,
  );

  it(
    'fails the share check, and only it, when a shared duplicate copies the content',
    async () => {
      const report = await runArrangementEffects(config('arrangement-share-copies'));
      expect(failed(report)).toEqual(['duplicate track share']);
      const note = noteOf(report, 'duplicate track share');
      expect(note).toContain('a shared copy shows a content of its own');
      expect(note).toContain('a shared copy carries no SHARED_CONTENT warning');
      expect(results(report)['duplicate track clone']).toBe('PASS');
    },
    SLOW,
  );

  it(
    'fails the share check when taking the shared duplicate away changes the notes of the shared content',
    async () => {
      const report = await runArrangementEffects(config('arrangement-share-notes-lost'));
      expect(failed(report)).toEqual(['duplicate track share']);
      expect(noteOf(report, 'duplicate track share')).toContain(
        'the notes of the content of clip A read back differently after the revert',
      );
      // The clone check, which does not share, is not affected.
      expect(results(report)['duplicate track clone']).toBe('PASS');
    },
    SLOW,
  );

  it(
    'fails the track delete check when the deleted track still sounds in the master',
    async () => {
      const report = await runArrangementEffects(config('arrangement-track-delete-keeps-sound'));
      expect(failed(report)).toEqual(['delete a duplicated track']);
      expect(noteOf(report, 'delete a duplicated track')).toMatch(
        /the master after the delete differs from the baseline by up to/,
      );
    },
    SLOW,
  );

  it(
    'fails the track delete check when trackIdMap disagrees with the project',
    async () => {
      const report = await runArrangementEffects(config('arrangement-track-delete-bad-map'));
      expect(failed(report)).toEqual(['delete a duplicated track']);
      expect(noteOf(report, 'delete a duplicated track')).toContain('trackIdMap should map track 2 to null, it says 0');
    },
    SLOW,
  );

  it(
    'fails the sequential import when the second clip sounds 10 ms away from where the project puts it',
    async () => {
      const report = await runArrangementEffects(config('arrangement-import-gap'));
      expect(failed(report)).toEqual(['batch import sequential and separateTracks']);
      const note = noteOf(report, 'batch import sequential and separateTracks');
      expect(note).toMatch(/sequential: imported clip 2 starts sounding at 12\.6\d* s, expected 12\.59\d* s \+- 1 ms/);
      expect(note).toContain('sequential: the master differs from the baseline plus the imported audio');
      // The separateTracks case was still run, and both imports were taken back.
      const imports = check<ImportCheck>(report, 'batch import sequential and separateTracks');
      expect(imports.cases.map((c) => c.case)).toEqual(['sequential', 'separateTracks']);
      expect(imports.cases.every((c) => c.revertRestored)).toBe(true);
      expect(note).not.toContain('separateTracks:');
    },
    SLOW,
  );

  it(
    'fails the import check, and still takes the clips back, when an import gives no revert recipe',
    async () => {
      const report = await runArrangementEffects(config('arrangement-import-no-revert'));
      expect(failed(report)).toEqual(['batch import sequential and separateTracks']);
      const note = noteOf(report, 'batch import sequential and separateTracks');
      expect(note).toContain(
        'sequential: import.start gives no revert recipe (undo reason ui_parity, warnings IRREVERSIBLE)',
      );
      expect(note).toContain('separateTracks: import.start gives no revert recipe');
      // The measurements went on, and the delete the scenario built took both imports back.
      const imports = check<ImportCheck>(report, 'batch import sequential and separateTracks');
      expect(imports.cases.map((c) => c.case)).toEqual(['sequential', 'separateTracks']);
      expect(imports.cases.every((c) => c.revertRestored)).toBe(true);
      expect(imports.cases.every((c) => c.sumMaxAbsDiff <= 1e-6)).toBe(true);
      expect(imports.cases.map((c) => c.revert.givenByInstance)).toEqual([false, false]);
      expect(results(report).shutdown).toBe('PASS');
    },
    SLOW,
  );

  it(
    'fails the separateTracks import when the second clip sounds 0.1 s late',
    async () => {
      const report = await runArrangementEffects(config('arrangement-import-separate-offset'));
      expect(failed(report)).toEqual(['batch import sequential and separateTracks']);
      const note = noteOf(report, 'batch import sequential and separateTracks');
      expect(note).toContain('separateTracks: the master differs from the baseline plus the imported audio');
      expect(note).not.toContain('sequential:');
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
      // What needs arrangement.v1 is skipped; the track checks do not need it.
      for (const name of [
        'move clip B 0.5 s later',
        'trim clip A end by 1 s',
        'copy window of clip A',
        'copy full of clip A',
        'delete a copy of clip A',
        'batch import sequential and separateTracks',
      ]) {
        expect(r[name], name).toBe('SKIP');
      }
      for (const name of [
        'track volume -6 dB',
        'duplicate track clone',
        'duplicate track share',
        'delete a duplicated track',
      ]) {
        expect(r[name], name).toBe('PASS');
      }
      expect(noArrangement.result).toBe('SKIP');

      const noTracks = await runArrangementEffects(config('arrangement-no-tracks'));
      expect(results(noTracks)['mute and solo in the master export']).toBe('SKIP');
      expect(results(noTracks)['clip gain -6 dB']).toBe('PASS');
      expect(results(noTracks)['split boundary is seamless']).toBe('PASS');
      for (const name of [
        'track volume -6 dB',
        'duplicate track clone',
        'duplicate track share',
        'delete a duplicated track',
      ]) {
        expect(results(noTracks)[name], name).toBe('SKIP');
        expect(noteOf(noTracks, name), name).toContain('does not report tracks.v1');
      }
      for (const name of [
        'move clip B 0.5 s later',
        'trim clip A end by 1 s',
        'copy window of clip A',
        'copy full of clip A',
        'delete a copy of clip A',
        'batch import sequential and separateTracks',
      ]) {
        expect(results(noTracks)[name], name).toBe('PASS');
      }

      const noHistory = await runArrangementEffects(config('arrangement-no-history'));
      expect(results(noHistory)['clip gain -6 dB']).toBe('SKIP');
      expect(results(noHistory)['fades are ramps']).toBe('SKIP');
      expect(results(noHistory)['mute and solo in the master export']).toBe('PASS');
      expect(results(noHistory)['split boundary is seamless']).toBe('PASS');
      // Only the checks that take a write back with edit.undo need history.v1.
      for (const name of ['move clip B 0.5 s later', 'trim clip A end by 1 s']) {
        expect(results(noHistory)[name], name).toBe('SKIP');
        expect(noteOf(noHistory, name), name).toContain('history.v1');
      }
      for (const name of [
        'copy window of clip A',
        'copy full of clip A',
        'delete a copy of clip A',
        'track volume -6 dB',
        'duplicate track clone',
        'duplicate track share',
        'delete a duplicated track',
        'batch import sequential and separateTracks',
      ]) {
        expect(results(noHistory)[name], name).toBe('PASS');
      }
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
  const track = (trackId: number, overrides: Partial<TrackRead> = {}): TrackRead => ({
    trackId,
    visible: true,
    muted: false,
    solo: false,
    audible: true,
    volumeDb: 0,
    volumeLinear: 1,
    colour: '#808080',
    ...overrides,
  });
  const stateOf = (placements: readonly PlacementRead[], overrides: Partial<ProjectState> = {}): ProjectState => ({
    arrangementRevision: 'a1',
    contents: [{ contentId: 'c:0123abcd:0:1', revision: 'r1', gridRevision: 'g1', keyRevision: 'k1' }],
    placements,
    tracks: [track(0), track(1)],
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

  it('finds the two clips a split left on the track of the old clip, and nothing when there are not exactly two', () => {
    const old = placement();
    const leading = placement({ placementId: 'p:0123abcd:0:2', endTimelineSec: 1.2, durationSec: 1.2 });
    const trailing = placement({
      placementId: 'p:0123abcd:0:3',
      startTimelineSec: 1.2,
      durationSec: 0.8,
      clipInContentSec: 1.2,
    });
    expect(splitPartsOf(stateOf([trailing, leading]), old)).toEqual({ leading, trailing });
    // Clips on another track, or outside the old clip, are not parts of it.
    const elsewhere = placement({ placementId: 'p:0123abcd:0:4', startTimelineSec: 2, endTimelineSec: 3 });
    expect(splitPartsOf(stateOf([leading, trailing, elsewhere]), old)).toEqual({ leading, trailing });
    expect(splitPartsOf(stateOf([leading, { ...trailing, trackId: 1 }]), old)).toBeUndefined();
    // One clip (nothing was split) and three clips are not a split into two.
    expect(splitPartsOf(stateOf([old]), old)).toBeUndefined();
    expect(
      splitPartsOf(
        stateOf([leading, trailing, placement({ placementId: 'p:0123abcd:0:5', endTimelineSec: 0.1 })]),
        old,
      ),
    ).toBeUndefined();
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

  /** `wav` put at `atSec` in a file of `totalSec` seconds and scaled by `factor`. */
  const placed = (wav: DecodedWav, atSec: number, totalSec: number, factor = 1): DecodedWav => {
    const out = new Float64Array(Math.round(totalSec * wav.sampleRateHz));
    const at = Math.round(atSec * wav.sampleRateHz);
    for (const [i, value] of wav.mono.entries()) out[at + i] = (out[at + i] ?? 0) + factor * value;
    return { ...wav, channels: [out], mono: out };
  };
  const entry = (entity: 'placement' | 'content', id: string) => ({
    entity,
    ref: entity === 'placement' ? { placementId: id } : { contentId: id },
    label: null,
  });

  it('measures a moved or doubled clip, a fitted gain, a sum of placed sources and an onset', () => {
    const source = tone(1);
    const rate = source.sampleRateHz;
    const span = { startSec: 0, endSec: 1 };

    // A clip put at 3 s equals its source exactly; one sample away, or a master that stops early, does not.
    const moved = placed(source, 3, 5);
    expect(shiftedDifference(source, moved, span, 3)).toBe(0);
    expect(shiftedDifference(source, placed(source, 3 + 1 / rate, 5), span, 3)).toBeGreaterThan(1e-3);
    expect(shiftedDifference(source, placed(source, 3, 3.5), span, 3)).toBeGreaterThan(0.01);

    // A start that is a sample off still counts as the named one; two samples off does not.
    expect(POSITION_QUANTUM_SAMPLES).toBe(1);
    expect(placedDifference(source, moved, span, 3)).toEqual({ maxAbsDiff: 0, lagSamples: 0 });
    expect(placedDifference(source, placed(source, 3 - 1 / rate, 5), span, 3)).toEqual({
      maxAbsDiff: 0,
      lagSamples: -1,
    });
    expect(placedDifference(source, placed(source, 3 + 1 / rate, 5), span, 3)).toEqual({
      maxAbsDiff: 0,
      lagSamples: 1,
    });
    expect(placedDifference(source, placed(source, 3 + 2 / rate, 5), span, 3).maxAbsDiff).toBeGreaterThan(0.01);
    expect(shiftedDifference(source, placed(source, 3 - 1 / rate, 5), span, 3, 1, -1)).toBe(0);

    // Two identical clips add to twice the source: +6.02 dB. A copy that is silent does not.
    const doubled = placed(source, 0, 2, 2);
    expect(shiftedDifference(source, doubled, span, 0, 2)).toBe(0);
    const sound = coherentSumOf(source, doubled, span);
    expect(sound).toMatchObject({ maxAbsDiff: 0, problems: [] });
    expect(sound.levelDb).toBeCloseTo(COHERENT_SUM_DB, 6);
    const silent = coherentSumOf(source, placed(source, 0, 2), span);
    expect(silent.problems).toHaveLength(2);
    expect(silent.problems[1]).toMatch(/the level over clip A changed by 0 dB, expected 6.02 \+- 0.5 dB/);

    // The gain of a scaled copy is read off it; a wrong gain leaves an error.
    const scaled = placed(source, 2, 4, 0.5);
    const gain = fitGain(source.mono, scaled.mono, 2, rate);
    expect(gain).toBeCloseTo(0.5, 9);
    expect(fitError(source.mono, scaled.mono, 2, gain, rate)).toBeLessThan(1e-12);
    expect(fitError(source.mono, scaled.mono, 2, 1, rate)).toBeGreaterThan(0.1);
    expect(fitGain(new Float64Array(10), scaled.mono, 2, rate)).toBe(0);

    // The master after an import is the baseline plus the sources, each at its place and scaled.
    const base = placed(source, 0, 6);
    const wet = new Float64Array(base.mono);
    for (const at of [3, 4.5]) {
      for (const [i, value] of source.mono.entries()) wet[Math.round(at * rate) + i] = 0.5 * value;
    }
    const master = { ...base, channels: [wet], mono: wet };
    const sources = [
      { samples: source.mono, startSec: 3 },
      { samples: source.mono, startSec: 4.5 },
    ];
    const whole = { startSec: 0, endSec: 6 };
    expect(sumDifference(base, master, sources, 0.5, whole).maxAbsDiff).toBeLessThanOrEqual(1e-12);
    const late = sumDifference(
      base,
      master,
      [
        { samples: source.mono, startSec: 3 },
        { samples: source.mono, startSec: 4.5 + 1 / rate },
      ],
      0.5,
      whole,
    );
    expect(late.maxAbsDiff).toBeGreaterThan(1e-3);
    expect(late.timeSec ?? 0).toBeGreaterThanOrEqual(4.5);
    // With the start of each source free by one sample the early and late copies fit; three samples off do not.
    const early = new Float64Array(base.mono);
    for (const [at, lag] of [
      [3, 0],
      [4.5, -1],
    ] as const) {
      for (const [i, value] of source.mono.entries()) early[Math.round(at * rate) + lag + i] = 0.5 * value;
    }
    const earlyMaster = { ...base, channels: [early], mono: early };
    const fitted = bestSumDifference(base, earlyMaster, sources, 0.5, whole);
    expect(fitted.maxAbsDiff).toBeLessThanOrEqual(1e-12);
    expect(fitted.lagSamples).toEqual([0, -1]);
    const far = new Float64Array(base.mono);
    for (const [i, value] of source.mono.entries()) far[Math.round(3 * rate) + i] = 0.5 * value;
    for (const [i, value] of source.mono.entries()) far[Math.round(4.5 * rate) + 3 + i] = 0.5 * value;
    expect(
      bestSumDifference(base, { ...base, channels: [far], mono: far }, sources, 0.5, whole).maxAbsDiff,
    ).toBeGreaterThan(1e-3);
    expect(bestSumDifference(base, master, [], 0.5, whole)).toMatchObject({ lagSamples: [] });

    // The first sound of a clip is found just after its start; silence has none.
    const onset = onsetOf(moved, 2.95, 4, ONSET_LEVEL);
    expect(onset).toBeGreaterThanOrEqual(2.999);
    expect(onset).toBeLessThan(3.01);
    expect(onsetOf(moved, 0, 2.9, ONSET_LEVEL)).toBeNull();
    expect(onsetOf(moved, 3.5, 3.5005, ONSET_LEVEL)).toBeNull();

    expect(paddedTo(new Float64Array(10), 1, 100)).toHaveLength(100);
    const long = new Float64Array(200);
    expect(paddedTo(long, 1, 100)).toBe(long);
  });

  it('reads revert recipes with the consent the scenario gives, and the ids and warnings of a result', () => {
    const recipe = { method: 'arrangement.edit', params: { ops: [] }, requiresConsent: true };
    const problems: string[] = [];
    expect(revertRequest(recipe, problems)).toEqual({ ops: [], confirm: true });
    expect(revertRequest({ ...recipe, method: 'track.delete', params: { trackId: 2 } })).toEqual({
      trackId: 2,
      confirm: true,
    });
    expect(problems).toEqual([]);
    // A recipe that needs no consent is sent as given; consent is not given for anything else.
    expect(revertRequest({ method: 'track.set', params: { tracks: [] }, requiresConsent: false })).toEqual({
      tracks: [],
    });
    expect(revertRequest({ method: 'project.close', params: {}, requiresConsent: true })).toBeUndefined();
    // A recipe that carries confirm itself breaks the rule that only the end user gives it.
    const carried: string[] = [];
    revertRequest({ ...recipe, params: { confirm: true } }, carried);
    expect(carried).toEqual([
      'the revert recipe of arrangement.edit carries confirm, which only the end user may give',
    ]);

    const result = {
      created: [entry('placement', 'p:1'), entry('content', 'c:1'), { entity: 'placement', ref: null }],
      removed: [entry('placement', 'p:0')],
      idMap: [
        { entity: 'placement', relation: 'copy', from: [{ placementId: 'p:0' }], to: [{ placementId: 'p:1' }] },
        { entity: 'placement', relation: 'split', from: [{ placementId: 'p:0' }], to: [{ placementId: 'p:2' }] },
        { entity: 'content', relation: 'copy', from: [{ contentId: 'c:0' }], to: [{ contentId: 'c:1' }] },
      ],
      warnings: [{ code: 'STACKED_ON_SOURCE' }, { code: 7 }, 'junk', { code: 'IRREVERSIBLE' }],
      changes: [{ entity: 'placement', ref: { placementId: 'p:0' }, fields: { startTimelineSec: {}, trackId: {} } }],
    };
    expect(entityIds(result, 'created', 'placement')).toEqual(['p:1']);
    expect(entityIds(result, 'created', 'content')).toEqual(['c:1']);
    expect(entityIds(result, 'removed', 'placement')).toEqual(['p:0']);
    expect(entityIds({}, 'removed', 'placement')).toEqual([]);
    expect(copyPairs(result)).toEqual([{ from: 'p:0', to: 'p:1' }]);
    expect(copyPairs({})).toEqual([]);
    expect(warningCodes(result)).toEqual(['STACKED_ON_SOURCE', 'IRREVERSIBLE']);
    expect(warningCodes({})).toEqual([]);
    expect(changesPlacementField(result, 'p:0', ['startTimelineSec'])).toBe(true);
    expect(changesPlacementField(result, 'p:0', ['gainDb'])).toBe(false);
    expect(changesPlacementField(result, 'p:9', ['startTimelineSec'])).toBe(false);
    expect(changesPlacementField({}, 'p:0', ['startTimelineSec'])).toBe(false);
  });

  it('compares a copy result with the project, and names what is wrong with it', () => {
    const source = placement();
    const copy = placement({
      placementId: 'p:0123abcd:0:2',
      contentId: 'c:0123abcd:0:2',
      startTimelineSec: 6,
      endTimelineSec: 8,
    });
    const state = stateOf([source, copy]);
    const result = {
      created: [entry('placement', copy.placementId), entry('content', copy.contentId)],
      idMap: [
        {
          entity: 'placement',
          relation: 'copy',
          from: [{ placementId: source.placementId }],
          to: [{ placementId: copy.placementId }],
        },
      ],
      warnings: [],
    };
    expect(copyConsistency(result, state, source, 'window', 0, 6)).toEqual([]);
    expect(copyConsistency(result, state, source, 'full', 0, 6)).toEqual([]);
    expect(copyConsistency(result, state, source, 'window', 1, 6)).toEqual(['the copy is on track 0, not 1']);
    expect(copyConsistency(result, state, source, 'window', 0, 5)).toEqual(['the copy starts at 6 s, not 5 s']);
    expect(copyConsistency({ ...result, created: [] }, state, source, 'window', 0, 6)).toEqual([
      'created must name the one copy (it says 0)',
      'the copy is not there afterwards',
    ]);
    expect(copyConsistency({ ...result, idMap: [] }, state, source, 'window', 0, 6)).toEqual([
      'idMap does not relate the source to its copy',
    ]);
    expect(copyConsistency({ ...result, created: result.created.slice(0, 1) }, state, source, 'window', 0, 6)).toEqual([
      'created does not name the content of the copy',
    ]);
    expect(
      copyConsistency(result, stateOf([source, { ...copy, contentId: source.contentId }]), source, 'window', 0, 6),
    ).toContain('the copy shows the content of its source, not one of its own');
    expect(
      copyConsistency(result, stateOf([source, { ...copy, clipInContentSec: 0.5 }]), source, 'full', 0, 6),
    ).toEqual(['a full copy does not show the same part of its content as its source']);
    expect(copyConsistency(result, stateOf([source, { ...copy, gainDb: -3 }]), source, 'window', 0, 6)).toEqual([
      'the copy does not keep the gainDb of its source',
    ]);
    expect(
      copyConsistency({ ...result, warnings: [{ code: 'OVERLAPS_CLIP' }] }, state, source, 'window', 0, 6),
    ).toEqual(['the copy carries the warning OVERLAPS_CLIP, though its target is empty and shown']);
  });

  it('compares a track duplicate result with the projects before and after it', () => {
    const source = placement();
    const before = stateOf([source], {
      tracks: [track(0), track(1, { visible: false }), track(2, { visible: false })],
    });
    const duplicate = (contentId: string) =>
      placement({ placementId: 'p:0123abcd:0:2', trackId: 1, contentId, geometryHash: 'h2' });
    const shown = [track(0), track(1), track(2, { visible: false })];
    const cloneState = stateOf([source, duplicate('c:0123abcd:0:2')], {
      tracks: shown,
      contents: [
        ...before.contents,
        { contentId: 'c:0123abcd:0:2', revision: 'r1', gridRevision: 'g1', keyRevision: 'k1' },
      ],
    });
    const shareState = stateOf([source, duplicate(source.contentId)], { tracks: shown });
    const idMap = [
      {
        entity: 'placement',
        relation: 'copy',
        from: [{ placementId: source.placementId }],
        to: [{ placementId: 'p:0123abcd:0:2' }],
      },
    ];
    const clone = { newTrackId: 1, idMap, warnings: [] };
    const share = { newTrackId: 1, idMap, warnings: [{ code: 'SHARED_CONTENT' }] };
    expect(duplicateConsistency(clone, before, cloneState, 0, 'clone')).toEqual([]);
    expect(duplicateConsistency(share, before, shareState, 0, 'share')).toEqual([]);
    expect(duplicateConsistency({}, before, cloneState, 0, 'clone')).toEqual(['the result has no newTrackId']);
    expect(duplicateConsistency({ ...clone, newTrackId: 2 }, before, cloneState, 0, 'clone')[0]).toBe(
      'the tracks the duplicate shows are 1, newTrackId says 2',
    );
    // A clone that shares the content, and a share that copies it or does not warn.
    expect(duplicateConsistency(clone, before, shareState, 0, 'clone')).toEqual([
      'a cloned copy shows the content of its source',
      'clone left 0 new content(s) in the project, expected 1',
    ]);
    expect(duplicateConsistency(share, before, cloneState, 0, 'share')).toEqual([
      'a shared copy shows a content of its own',
      'share left 1 new content(s) in the project, expected 0',
    ]);
    expect(duplicateConsistency({ ...share, warnings: [] }, before, shareState, 0, 'share')).toEqual([
      'a shared copy carries no SHARED_CONTENT warning',
    ]);
    expect(duplicateConsistency({ ...clone, idMap: [] }, before, cloneState, 0, 'clone')).toEqual([
      'idMap does not relate a clip to its copy',
    ]);
    // The new track must take the settings of its source, and hold one clip per clip of the source.
    const quiet = stateOf(cloneState.placements, {
      contents: cloneState.contents,
      tracks: [track(0), track(1, { muted: true }), track(2, { visible: false })],
    });
    expect(duplicateConsistency(clone, before, quiet, 0, 'clone')).toEqual([
      'the new track does not take the muted of its source',
    ]);
    expect(duplicateConsistency(clone, before, stateOf([source], { tracks: shown }), 0, 'clone')[0]).toBe(
      'the new track holds 0 clip(s), its source 1',
    );
  });

  it('compares a track delete result with the projects before and after it', () => {
    const clip = (id: string, trackId: number) =>
      placement({ placementId: `p:0123abcd:0:${id}`, trackId, geometryHash: `h${id}` });
    const [a, b, c] = [clip('1', 0), clip('2', 1), clip('3', 2)] as const;
    const before = stateOf([a, b, c], {
      tracks: [
        track(0),
        track(1, { colour: '#111111' }),
        track(2, { colour: '#222222' }),
        track(3, { visible: false }),
      ],
    });
    // Deleting track 1: the clip of track 2 moves to track 1 and takes its settings with it.
    const moved = { ...c, trackId: 1 };
    const after = stateOf([a, moved], {
      tracks: [track(0), track(1, { colour: '#222222' }), track(2, { visible: false }), track(3, { visible: false })],
    });
    const result = {
      trackIdMap: [
        { before: 1, after: null },
        { before: 2, after: 1 },
      ],
      removed: [entry('placement', b.placementId)],
    };
    expect(trackDeleteConsistency(result, before, after, 1)).toEqual([]);
    expect(trackDeleteConsistency({}, before, after, 1)).toEqual(['trackIdMap is not an array']);
    expect(trackDeleteConsistency(result, before, after, 3)).toEqual(['track 3 was not shown before the delete']);
    expect(trackDeleteConsistency({ ...result, trackIdMap: [{ before: 1, after: 0 }] }, before, after, 1)).toEqual(
      expect.arrayContaining([
        'trackIdMap should map track 1 to null, it says 0',
        'trackIdMap should map track 2 to 1, it says nothing',
      ]),
    );
    expect(
      trackDeleteConsistency(
        { ...result, trackIdMap: [...result.trackIdMap, { before: 0, after: 0 }] },
        before,
        after,
        1,
      ),
    ).toEqual(['trackIdMap lists track 0, which does not move']);
    expect(trackDeleteConsistency({ ...result, removed: [] }, before, after, 1)).toEqual([
      'removed names 0 clip(s), the deleted track held 1',
    ]);
    // A clip left on the deleted track, a clip that did not move, and a track that is still shown.
    expect(trackDeleteConsistency(result, before, stateOf([a, b, moved], { tracks: after.tracks }), 1)).toEqual([
      'clip p:0123abcd:0:2 of the deleted track is still there',
    ]);
    expect(trackDeleteConsistency(result, before, stateOf([a, c], { tracks: after.tracks }), 1)).toEqual([
      'clip p:0123abcd:0:3 is on track 2, expected 1',
    ]);
    expect(trackDeleteConsistency(result, before, stateOf([a, moved], { tracks: before.tracks }), 1)).toEqual(
      expect.arrayContaining([
        'track 1 does not take the colour of track 2',
        '3 track(s) are shown afterwards, expected 2',
      ]),
    );
  });

  it('reads the clips of an import and checks the layout of both layouts', () => {
    const item = (placementId: string, trackId: number, startTimelineSec: number, durationSec: number) => ({
      imported: true,
      placementId,
      trackId,
      startTimelineSec,
      durationSec,
    });
    const items = [item('p:0123abcd:0:5', 2, 10, 2.6), item('p:0123abcd:0:6', 2, 12.6, 2.2)];
    const clips = importedClips({ items });
    expect(clips).toEqual([
      { placementId: 'p:0123abcd:0:5', trackId: 2, startTimelineSec: 10, durationSec: 2.6 },
      { placementId: 'p:0123abcd:0:6', trackId: 2, startTimelineSec: 12.6, durationSec: 2.2 },
    ]);
    expect(() => importedClips({ items: [items[0], { imported: false }] })).toThrow(
      'file 2 of the import was not imported',
    );
    expect(() => importedClips({ items: 'none' })).toThrow('the import result has no items array');

    type Clip = (typeof clips)[number];
    const stateFor = (read: readonly Clip[]) =>
      stateOf(
        read.map((clip) =>
          placement({
            placementId: clip.placementId,
            trackId: clip.trackId,
            startTimelineSec: clip.startTimelineSec,
            durationSec: clip.durationSec,
            endTimelineSec: clip.startTimelineSec + clip.durationSec,
          }),
        ),
      );
    const [first, second] = clips as [Clip, Clip];
    expect(importLayoutProblems('sequential', clips, stateFor(clips), 10)).toEqual([]);
    expect(importLayoutProblems('sequential', clips, stateFor(clips), undefined)).toEqual([]);
    expect(importLayoutProblems('sequential', [first], stateFor(clips), 10)).toEqual([
      'the import reports 1 clip(s), expected 2',
    ]);
    expect(importLayoutProblems('sequential', clips, stateFor(clips), 11)).toEqual([
      'the first clip starts at 10 s, not 11 s',
    ]);
    // A gap between the clips, two tracks, a clip the project does not hold, or holds differently.
    const gapped = [first, { ...second, startTimelineSec: 12.7 }];
    expect(importLayoutProblems('sequential', gapped, stateFor(gapped), 10)).toEqual([
      'the second clip starts at 12.7 s, where the first ends at 12.6 s',
    ]);
    const apart = [first, { ...second, trackId: 3 }];
    expect(importLayoutProblems('sequential', apart, stateFor(apart), 10)).toEqual([
      'the sequential clips are on two tracks',
    ]);
    expect(importLayoutProblems('sequential', clips, stateFor([first]), 10)).toEqual([
      'imported clip p:0123abcd:0:6 is not in the project',
    ]);
    expect(importLayoutProblems('sequential', clips, stateFor([first, { ...second, trackId: 4 }]), 10)).toEqual([
      'clip p:0123abcd:0:6 is on track 4, the result says 2',
    ]);

    const own: [Clip, Clip] = [
      { ...first, startTimelineSec: 0 },
      { ...second, trackId: 3, startTimelineSec: 0 },
    ];
    expect(importLayoutProblems('separateTracks', own, stateFor(own), undefined)).toEqual([]);
    const sameTrack: [Clip, Clip] = [own[0], { ...own[1], trackId: 2 }];
    expect(importLayoutProblems('separateTracks', sameTrack, stateFor(sameTrack), undefined)).toEqual([
      'the clips are on tracks 2 and 2, not two successive ones',
    ]);
    const late: [Clip, Clip] = [own[0], { ...own[1], startTimelineSec: 2.6 }];
    expect(importLayoutProblems('separateTracks', late, stateFor(late), undefined)).toEqual([
      'a clip on its own track starts at 2.6 s, not 0',
    ]);
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
        ...(await fakeUserSettingsEnv(dir)),
        OTCP_TARGET_EXE: process.execPath,
        OTCP_TARGET_ARGS: JSON.stringify([FAKE, '--mode=arrangement-hybrid']),
        OTCP_E2E_REPORT: path.join(dir, 'report.json'),
        OTCP_E2E_STEP_TIMEOUT_MS: '20000',
        OTCP_E2E_ARRANGEMENT_EFFECTS_DATA_TEMPLATE: template,
      });
      expect(run.status, run.output).toBe(0);
      expect(run.output).toMatch(/\| split boundary is seamless \| PASS \|/);
      expect(run.output).toMatch(/real user settings untouched \| PASS \|.*watched 1 files/);
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
