// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The effects scenario (test/e2e/effects.ts) against the stand-in executable
// (test/support/fake-opentune.mjs with test/support/fake-effects.mjs, `effects*` modes): every check
// passes against a stand-in that does what the specification says, and each way an instance can get
// the effects wrong (stale audio, a render that never settles, a mixed export, an undo that restores
// nothing) makes the check that is about it fail, and only that one. Two runs of the real test file in
// a child process show that it is skipped without OTCP_TARGET_EXE and runs the scenario with it.

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  HYBRID_MODE_NOTICE,
  PHRASE_GAP_SEC,
  PITCH_TOLERANCE_CENTS,
  RESYNTH_EDGE_MAX_RESIDUAL_DB,
  RESYNTH_MAX_RESIDUAL_DB,
  RESYNTH_PRE_ROLL_SEC,
  alignedResidualDb,
  awayWindow,
  compareSamples,
  consistencyOf,
  edgeResidualOf,
  effectsSetupFromEnv,
  noteDelta,
  resynthesisReach,
  runEffects,
  scrubText,
  snapshotProblems,
  type EffectsConfig,
  type EffectsReport,
} from '../e2e/effects.js';
import { fakeUserSettingsEnv } from '../support/fake-user-settings.js';
import { generateTone, writeToneFiles } from '../support/harmonic-tone.js';
import { decodeWav } from '../support/wav-decode.js';
import { wavFile } from '../support/wav-file.js';

const FAKE = fileURLToPath(new URL('../support/fake-opentune.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
/**
 * Timeout of a test that runs the whole scenario against the stand-in, once or several times (about 10 s
 * a run on a developer machine). Measured on the CI runners, with coverage: a run takes about 40 s, the
 * slowest tests run it two or three times (104 s and 121 s, the latter went over the 120 s this was) and
 * the whole file takes 840 s. 330 s is 2.7 times the slowest test, and a test that hangs still fails.
 */
const SCENARIO_TIMEOUT_MS = 330_000;

const config = (mode: string, extra: Partial<EffectsConfig> = {}): EffectsConfig => ({
  exe: { exe: process.execPath, args: [FAKE, `--mode=${mode}`], timeoutMs: 15_000 },
  stepTimeoutMs: 20_000,
  reportPath: undefined,
  audioPath: undefined,
  timingLengthsSec: [3],
  ...extra,
});

const results = (report: EffectsReport) => Object.fromEntries(report.steps.map((s) => [s.name, s.result]));
const noteOf = (report: EffectsReport, name: string) => report.steps.find((s) => s.name === name)?.note ?? '';

const scratch: string[] = [];
async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ot-effects-test-'));
  scratch.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('effects scenario against the stand-in', () => {
  it(
    'passes every check against an instance that does what the specification says',
    async () => {
      const report = await runEffects(config('effects'));
      expect(results(report)).toEqual({
        'prepare audio': 'PASS',
        launch: 'PASS',
        hello: 'PASS',
        'import and analysis': 'PASS',
        'export before any edit': 'PASS',
        'fixed note parameters': 'PASS',
        'baseline and noise floor': 'PASS',
        'setTargetPitch +100 cents': 'PASS',
        'shiftCents +100 cents': 'PASS',
        'setPitchShift +2 semitones': 'PASS',
        'AUTO regenerate pulls the sharp note back': 'PASS',
        'AUTO snapNotes pulls the sharp note back': 'PASS',
        'setParams retuneSpeed 1': 'PASS',
        'snapToScale returns an off-scale note to the scale': 'PASS',
        'prefs.set tuningHz 442': 'PASS',
        'race: +100 cents, export, -100 cents': 'PASS',
        'shiftTiming +30 ms': 'PASS',
        'moveHandles +30 ms': 'PASS',
        'extra clips for the note-split, vibrato and drift checks': 'PASS',
        'AUTO regenerate noteSplitCents': 'PASS',
        'setParams vibratoDepth and vibratoRateHz': 'PASS',
        'setParams pitchDriftScale 0': 'PASS',
        'prefs.set hybridMode': 'PASS',
        'timing 3 s': 'PASS',
        shutdown: 'PASS',
      });
      expect(report).toMatchObject({ schema: 'opentune-mcp-e2e-effects/1', result: 'PASS' });
      expect(noteOf(report, 'export before any edit')).toContain('listed in dryContents');
      expect(noteOf(report, 'race: +100 cents, export, -100 cents')).toContain('BUSY(export_in_progress)');
      expect(report.backend).toEqual({
        sessionInfo: 'fake',
        exports: ['fake'],
        f0Model: 'fake',
        vocoderWeight: 'fake',
      });
      expect(report.audio).toMatchObject({ source: 'generated', notes: 5 });
      // The measurements: the edited note moved by the edit, the others did not move at all.
      const target = report.checks['setTargetPitch +100 cents'] as {
        notes: { index: number; medianCents: number; frames: number }[];
        unedited: { spans: number; bitIdentical: number };
      };
      expect(target.notes.find((n) => n.index === 1)?.medianCents).toBeCloseTo(100, 0);
      expect(target.notes.filter((n) => n.index !== 1).every((n) => n.medianCents === 0)).toBe(true);
      expect(target.notes.every((n) => n.frames >= 20)).toBe(true);
      // Note 2 is the first note after the gap that follows the edited note: within the reach of
      // re-synthesis, and bit-identical here. The notes before the edit and after note 2 are away from it.
      expect(target.unedited).toEqual({
        away: { spans: 3, bitIdentical: 3, maxAbsDiff: 0, maxAbsDiffDbfs: null, notes: [0, 3, 4] },
        reach: [{ index: 2, bitIdentical: true, alignedResidualDb: null, edgeResidualDb: null }],
      });
      // Hybrid mode off, as every export of the check said; nothing to note at the top of the report.
      expect(report).toMatchObject({ hybridMode: false, notices: [], dataTemplateFrom: null });
      expect(report.checks['setTargetPitch +100 cents']).toMatchObject({
        processing: [{ export: 'setTargetPitch +100 cents', hybridMode: false, backend: 'fake' }],
      });
      expect(report.checks['baseline and noise floor']).toMatchObject({
        processing: [{ export: 'baseline' }, { export: 'baseline again' }],
      });
      expect(report.checks['race: +100 cents, export, -100 cents']).toMatchObject({
        processing: [{ export: 'race', hybridMode: false }],
      });
      expect(report.checks['timing 3 s']).toEqual({
        processing: [{ export: 'timing 3 s', hybridMode: false, backend: 'fake' }],
      });
      const auto = report.checks['AUTO snapNotes pulls the sharp note back'] as {
        notes: { index: number; medianCents: number }[];
      };
      expect(auto.notes.find((n) => n.index === 2)?.medianCents).toBeCloseTo(-40, 0);
      const timing = report.checks['shiftTiming +30 ms'] as { measuredShiftMs: number };
      expect(Math.abs(timing.measuredShiftMs - 30)).toBeLessThan(2);
      expect(report.noiseFloor).toMatchObject({ repeatExport: { bitIdentical: true } });
      expect(report.timings).toMatchObject({ lengths: [{ autoMode: 'regenerate' }] });
      expect(report.tolerances.pitchCents).toBe(PITCH_TOLERANCE_CENTS);
      expect(report.tolerances).toMatchObject({
        splitBoundarySec: 0.1,
        tuningCents: 3,
        vibratoRateHz: 0.25,
        driftZeroMaxFraction: 0.35,
        sameSoundPitchCents: 2,
      });

      // The checks of the notes, the scale, the preferences and the time grid.
      type Measured = { index: number; expectedCents: number; medianCents: number }[];
      const snap = report.checks['snapToScale returns an off-scale note to the scale'] as {
        note: number;
        targetMidi: { before: number; shifted: number; snapped: number };
        shifted: { notes: Measured };
        snapped: { notes: Measured };
      };
      // Note 3 (62) is shifted by 70 cents, to 62.7, and snapped to the nearest pitch of C major.
      expect(snap.targetMidi).toEqual({ before: 62, shifted: 62.7, snapped: 62 });
      expect(snap.shifted.notes.find((n) => n.index === snap.note)?.medianCents).toBeCloseTo(70, 0);
      expect(snap.snapped.notes.find((n) => n.index === snap.note)?.medianCents).toBeCloseTo(0, 0);

      const tuning = report.checks['prefs.set tuningHz 442'] as {
        tuningHz: { before: number; set: number };
        expectedShiftCents: number;
        notRetroactive: { notes: Measured };
        auto: { notes: Measured };
      };
      expect(tuning.tuningHz).toEqual({ before: 440, set: 442 });
      expect(tuning.expectedShiftCents).toBeCloseTo(7.85, 2);
      // Before AUTO nothing moved; after it the notes lie 7.85 cents up, the sharp one 32.15 down.
      expect(tuning.notRetroactive.notes.every((n) => n.medianCents === 0)).toBe(true);
      expect(tuning.auto.notes.filter((n) => n.index !== 2).every((n) => Math.abs(n.medianCents - 7.85) < 0.3)).toBe(
        true,
      );
      expect(tuning.auto.notes.find((n) => n.index === 2)?.medianCents).toBeCloseTo(-32.15, 0);

      const split = report.checks['AUTO regenerate noteSplitCents'] as {
        runs: { noteSplitCents: number; notes: number; paramsUsed: { noteSplitCents: number } }[];
      };
      expect(split.runs.map((r) => r.noteSplitCents)).toEqual([30, 160]);
      expect(split.runs.map((r) => r.paramsUsed.noteSplitCents)).toEqual([30, 160]);
      expect(split.runs[0]?.notes ?? 0).toBeGreaterThan(split.runs[1]?.notes ?? 99);
      expect(split.runs[1]?.notes).toBe(2);

      const vibrato = report.checks['setParams vibratoDepth and vibratoRateHz'] as {
        baseline: { amplitudeCents: number };
        vibrato: { amplitudeCents: number; rateHz: number };
      };
      expect(vibrato.baseline.amplitudeCents).toBeLessThan(1);
      expect(vibrato.vibrato.rateHz).toBeCloseTo(6, 1);
      expect(vibrato.vibrato.amplitudeCents).toBeCloseTo(45.5, -1);

      const drift = report.checks['setParams pitchDriftScale 0'] as {
        baseline: { stdCents: number };
        driftScale0: { stdCents: number };
      };
      expect(drift.baseline.stdCents).toBeGreaterThan(8);
      expect(drift.driftScale0.stdCents).toBeLessThan(1);

      const moved = report.checks['moveHandles +30 ms'] as {
        measuredShiftMs: number;
        handle: { outputSecBefore: number; outputSecAfter: number };
        notesAway: { index: number; shiftMs: number }[];
        exportAfterUndo: { bitIdentical: number };
      };
      expect(Math.abs(moved.measuredShiftMs - 30)).toBeLessThan(2);
      expect(moved.handle.outputSecAfter - moved.handle.outputSecBefore).toBeCloseTo(0.03, 6);
      expect(moved.notesAway.map((n) => n.index)).toEqual([0, 4]);
      expect(moved.notesAway.every((n) => n.shiftMs === 0)).toBe(true);
      expect(moved.exportAfterUndo.bitIdentical).toBe(1);

      // Hybrid mode: the scenario switched it on itself, and that stays out of the notice at the top
      // (checked above: hybridMode false, no notices). The corrections are judged where they should be.
      const hybrid = report.checks['prefs.set hybridMode'] as {
        hybridMode: { began: boolean; set: boolean };
        began: { index: number; medianCents: number }[];
        flipped: { index: number; medianCents: number }[];
        differ: { maxAbsDiff: number };
        putBack: { notes: { bitIdentical: boolean }[] };
        processing: { hybridMode: boolean }[];
      };
      expect(hybrid.hybridMode).toEqual({ began: false, set: true });
      expect(hybrid.began.find((n) => n.index === 1)?.medianCents).toBeCloseTo(30, 0);
      expect(hybrid.began.find((n) => n.index === 3)?.medianCents).toBeCloseTo(200, 0);
      // The lighter path leaves the small correction as it was and the large one applied.
      expect(hybrid.flipped.find((n) => n.index === 1)?.medianCents ?? 99).toBeLessThan(5);
      expect(hybrid.flipped.find((n) => n.index === 3)?.medianCents).toBeCloseTo(200, -1);
      expect(hybrid.differ.maxAbsDiff).toBeGreaterThan(1e-3);
      expect(hybrid.putBack.notes.every((n) => n.bitIdentical)).toBe(true);
      expect(hybrid.processing.map((p) => p.hybridMode)).toEqual([false, true, false, false]);
      // Nothing in the report names a file or holds a secret.
      expect(JSON.stringify(report)).not.toMatch(/ot-tone-|\.wav|[0-9a-f]{32}[0-9a-f]{32}/);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'fails every effect check, and runs them all, when the export holds the notes as they were imported',
    async () => {
      const report = await runEffects(config('effects-stale', { timingLengthsSec: [] }));
      expect(report.result).toBe('FAIL');
      const r = results(report);
      for (const name of [
        'setTargetPitch +100 cents',
        'shiftCents +100 cents',
        'setPitchShift +2 semitones',
        'AUTO regenerate pulls the sharp note back',
        'AUTO snapNotes pulls the sharp note back',
        'snapToScale returns an off-scale note to the scale',
        'prefs.set tuningHz 442',
        'race: +100 cents, export, -100 cents',
        'shiftTiming +30 ms',
        'moveHandles +30 ms',
        'prefs.set hybridMode',
      ]) {
        expect(r[name], name).toBe('FAIL');
      }
      expect(r['baseline and noise floor']).toBe('PASS');
      expect(noteOf(report, 'setTargetPitch +100 cents')).toMatch(/note 1: 0 cents, expected 100/);
      expect(r.shutdown).toBe('PASS');
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'fails the export before any edit when the render of an uncorrected clip never settles, and goes on',
    async () => {
      const report = await runEffects(config('effects-unsettled', { timingLengthsSec: [] }));
      const r = results(report);
      expect(r['export before any edit']).toBe('FAIL');
      expect(noteOf(report, 'export before any edit')).toContain('export_wait_timeout');
      expect(r['setTargetPitch +100 cents']).toBe('PASS');
      expect(r['shiftTiming +30 ms']).toBe('PASS');
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'fails the race when the export holds one note of each version; passes it on a changed_during_export conflict',
    async () => {
      const mixed = await runEffects(config('effects-mixed', { timingLengthsSec: [] }));
      expect(results(mixed)['race: +100 cents, export, -100 cents']).toBe('FAIL');
      expect(noteOf(mixed, 'race: +100 cents, export, -100 cents')).toContain('not one version: up, down');
      const conflict = await runEffects(config('effects-conflict', { timingLengthsSec: [] }));
      expect(results(conflict)['race: +100 cents, export, -100 cents']).toBe('PASS');
      expect(noteOf(conflict, 'race: +100 cents, export, -100 cents')).toContain(
        'REVISION_CONFLICT(changed_during_export), target untouched',
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'stops the checks when an undo does not put the clip back',
    async () => {
      const report = await runEffects(config('effects-undo-broken', { timingLengthsSec: [] }));
      const r = results(report);
      expect(r['setTargetPitch +100 cents']).toBe('FAIL');
      expect(noteOf(report, 'setTargetPitch +100 cents')).toContain('after edit.undo the clip is not as it was');
      expect(r['shiftCents +100 cents']).toBe('SKIP');
      expect(noteOf(report, 'shiftCents +100 cents')).toBe('not run: setTargetPitch +100 cents ended with FAIL');
      expect(r.shutdown).toBe('PASS');
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'stops the checks when a write took effect but its result gives no undoId to take it back with',
    async () => {
      for (const [mode, why] of [
        ['effects-undo-missing', 'its result says it cannot be undone (ui_parity)'],
        ['effects-undo-garbled', 'its undo block has no undoId'],
      ] as const) {
        const report = await runEffects(config(mode, { timingLengthsSec: [] }));
        const r = results(report);
        expect(r['setTargetPitch +100 cents'], mode).toBe('FAIL');
        expect(noteOf(report, 'setTargetPitch +100 cents')).toBe(
          `content.editNotes took effect, but ${why}: the check cannot take it back, and the checks after it would run on a changed clip`,
        );
        // Not run on a clip that still holds the edit (which would fail them for the wrong reason).
        expect(r['shiftCents +100 cents'], mode).toBe('SKIP');
        expect(noteOf(report, 'race: +100 cents, export, -100 cents')).toBe(
          'not run: setTargetPitch +100 cents ended with FAIL',
        );
        expect(r.shutdown).toBe('PASS');
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'takes a write back when its result cannot be read after it took effect, and goes on',
    async () => {
      const report = await runEffects(config('effects-tokens-missing', { timingLengthsSec: [] }));
      const r = results(report);
      expect(r['setTargetPitch +100 cents']).toBe('FAIL');
      expect(noteOf(report, 'setTargetPitch +100 cents')).toBe('the result has no tokens');
      expect(report.checks['setTargetPitch +100 cents']).toMatchObject({ error: 'the result has no tokens' });
      // The undo was recorded before the result was read, so the clip is back as it was.
      expect(r['shiftCents +100 cents']).toBe('PASS');
      expect(r['race: +100 cents, export, -100 cents']).toBe('PASS');
      expect(r['shiftTiming +30 ms']).toBe('PASS');
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'stops the checks when a write fails after it took effect and left the clip changed',
    async () => {
      const report = await runEffects(config('effects-reply-lost', { timingLengthsSec: [] }));
      const r = results(report);
      expect(r['setTargetPitch +100 cents']).toBe('FAIL');
      expect(noteOf(report, 'setTargetPitch +100 cents')).toMatch(
        /^INTERNAL\(fake_reply_lost\): fake; after edit\.undo the clip is not as it was: note 1 targetMidi: /,
      );
      expect(r['shiftCents +100 cents']).toBe('SKIP');
      expect(r.shutdown).toBe('PASS');
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'checks the report of the second write of the race when it is applied',
    async () => {
      const report = await runEffects(config('effects-down-misreport', { timingLengthsSec: [] }));
      const name = 'race: +100 cents, export, -100 cents';
      expect(results(report)[name]).toBe('FAIL');
      expect(noteOf(report, name)).toBe(
        'second edit: note 0 offsetCents: the result says -99, read back -100; ' +
          'second edit: note 4 offsetCents: the result says -99, read back -100',
      );
      expect(report.checks[name]).toMatchObject({ secondEdit: 'applied' });
      expect(String((report.checks[name] as { outcome?: string }).outcome)).toContain('-100 cents version in full');
      expect(results(report)['shiftTiming +30 ms']).toBe('PASS');
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'counts the reported fields it does not read back instead of failing on them',
    async () => {
      const report = await runEffects(config('effects-extra-fields', { timingLengthsSec: [] }));
      expect(report.result).toBe('PASS');
      expect(noteOf(report, 'setTargetPitch +100 cents')).toMatch(
        /; 1 reported field\(s\) not compared, as the scenario does not read them$/,
      );
      expect(noteOf(report, 'fixed note parameters')).toContain('1 reported field(s) not compared');
      expect(report.checks['setTargetPitch +100 cents']).toMatchObject({ unreadFields: ['note.futureField'] });
      expect(report.checks['race: +100 cents, export, -100 cents']).toMatchObject({
        unreadFields: ['note.futureField'],
      });
      // Results that report no such field have none in the report.
      expect(report.checks['setPitchShift +2 semitones']).not.toHaveProperty('unreadFields');
    },
    SCENARIO_TIMEOUT_MS,
  );

  // Hybrid mode on (the notice at the top of the report) is run through the real test file below.

  it(
    'accepts a note after an edit that is rendered again in another phase, and nothing further away',
    async () => {
      const resynth = await runEffects(config('effects-resynth', { timingLengthsSec: [] }));
      expect(resynth.result).toBe('PASS');
      const shift = resynth.checks['shiftCents +100 cents'] as {
        unedited: {
          away: { bitIdentical: number; notes: number[] };
          reach: { index: number; bitIdentical: boolean; alignedResidualDb: number }[];
        };
      };
      expect(shift.unedited.away).toMatchObject({ bitIdentical: 3, notes: [0, 1, 2] });
      expect(shift.unedited.reach).toHaveLength(1);
      expect(shift.unedited.reach[0]).toMatchObject({ index: 4, bitIdentical: false });
      expect(shift.unedited.reach[0]?.alignedResidualDb).toBeLessThan(RESYNTH_MAX_RESIDUAL_DB);
      expect(noteOf(resynth, 'shiftCents +100 cents')).toMatch(
        /\(note 4 rendered again in another phase, -[0-9.]+ dB\)/,
      );
      // The note two after the edit is away from it: a change there fails, and says where.
      const far = await runEffects(config('effects-resynth-far', { timingLengthsSec: [] }));
      const r = results(far);
      expect(r['setTargetPitch +100 cents']).toBe('FAIL');
      expect(noteOf(far, 'setTargetPitch +100 cents')).toMatch(
        /^notes away from the edit \(0, 3, 4\) differ from the baseline by up to [0-9.e+-]+ \(allowed 0\)$/,
      );
      // Note 3 is the last note: nothing is two after it.
      expect(r['shiftCents +100 cents']).toBe('PASS');
      // Rendered again 10 cents sharp is within the pitch tolerance, but not the same sound.
      const detuned = await runEffects(config('effects-resynth-detuned', { timingLengthsSec: [] }));
      for (const [name, index] of [
        ['setTargetPitch +100 cents', 2],
        ['shiftCents +100 cents', 4],
      ] as const) {
        expect(results(detuned)[name], name).toBe('FAIL');
        expect(noteOf(detuned, name)).toMatch(
          new RegExp(
            `^note ${String(index)}, after the edit, was rendered again but is not the same sound: -?[0-9.]+ dB left after aligning its phase \\(allowed -20\\)$`,
          ),
        );
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'is a FLAKY-SKIP when the backend cannot start, and SKIPs without history.v1 or the timing check without timing.v1',
    async () => {
      const backend = await runEffects(config('effects-backend', { timingLengthsSec: [] }));
      expect(backend.result).toBe('FLAKY-SKIP');
      expect(results(backend)['import and analysis']).toBe('FLAKY-SKIP');
      const history = await runEffects(config('effects-no-history', { timingLengthsSec: [] }));
      expect(results(history).hello).toBe('SKIP');
      expect(noteOf(history, 'hello')).toContain('history.v1');
      const timing = await runEffects(config('effects-no-timing', { timingLengthsSec: [] }));
      expect(timing.result).toBe('SKIP');
      expect(results(timing)['shiftTiming +30 ms']).toBe('SKIP');
      expect(results(timing)['race: +100 cents, export, -100 cents']).toBe('PASS');
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'runs the checks that need no known pitch on external audio, and names no file',
    async () => {
      const tone = generateTone({
        seed: 5,
        notes: [
          { midi: 55, durationSec: 0.9, gapSec: 0.4 },
          { midi: 58, durationSec: 1.1, gapSec: 0.4 },
          { midi: 60, durationSec: 0.3, gapSec: 0.4 },
        ],
      });
      const files = await writeToneFiles(tone, 'external-take');
      try {
        const report = await runEffects(config('effects', { audioPath: files.wavPath, timingLengthsSec: [] }));
        const r = results(report);
        expect(r['AUTO regenerate pulls the sharp note back']).toBe('SKIP');
        expect(noteOf(report, 'AUTO snapNotes pulls the sharp note back')).toContain('external audio');
        expect(r['setTargetPitch +100 cents']).toBe('PASS');
        expect(r['race: +100 cents, export, -100 cents']).toBe('PASS');
        expect(report.audio).toMatchObject({ source: 'external' });
        expect(report.noiseFloor).not.toHaveProperty('estimatorOnSource');
        expect(JSON.stringify(report)).not.toContain('external-take');
      } finally {
        await files.cleanup();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  // External audio: which notes of the unedited export are compared is decided on the source, and the
  // export contributes its median pitch only.
  const WOBBLE = { rateHz: 5.5, depthCents: 50 };
  const steadyNote = (midi: number) => ({ midi, durationSec: 0.9, gapSec: 0.4 });
  const externalRun = async (
    mode: string,
    notes: Parameters<typeof generateTone>[0]['notes'],
  ): Promise<EffectsReport> => {
    const files = await writeToneFiles(generateTone({ seed: 5, notes, leadSec: 0.6 }), 'external-take');
    try {
      return await runEffects(config(mode, { audioPath: files.wavPath, timingLengthsSec: [] }));
    } finally {
      await files.cleanup();
    }
  };
  const FIVE = [55, 58, 60, 62, 64].map(steadyNote);
  const exportCheck = (report: EffectsReport) =>
    report.checks['export before any edit'] as {
      external: {
        steadyNotes: number;
        leftOut: { unsteadyPitch: number[]; tooFewVoicedFrames: number[] };
        beyondTolerance: number[];
        allowedBeyondTolerance: number;
      };
    };

  it(
    'leaves a note with a +-50 cent vibrato in the source out of the unedited export check, and passes the rest',
    async () => {
      const notes = FIVE.map((n, i) => (i === 2 ? { ...n, vibrato: WOBBLE } : n));
      const report = await externalRun('effects', notes);
      expect(results(report)['export before any edit']).toBe('PASS');
      const { external } = exportCheck(report);
      expect(external.leftOut.unsteadyPitch).toEqual([2]);
      expect(external.leftOut.tooFewVoicedFrames).toEqual([]);
      expect(external.steadyNotes).toBe(4);
      expect(external.beyondTolerance).toEqual([]);
      // The notes away from the moved handle are reported with their phase-aligned residual and pitch.
      const timing = report.checks['shiftTiming +30 ms'] as { uneditedNotes?: Record<string, unknown>[] };
      expect(results(report)['shiftTiming +30 ms']).toBe('PASS');
      expect(timing.uneditedNotes?.length).toBeGreaterThan(0);
      for (const n of timing.uneditedNotes ?? []) {
        expect(n).toHaveProperty('bitIdentical');
        expect(n).toHaveProperty('edgeResidualDb');
        expect(typeof n.pitchCents).toBe('number');
        expect(Math.abs(n.pitchCents as number)).toBeLessThanOrEqual(PITCH_TOLERANCE_CENTS);
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'fails the unedited export of external audio that is off, however it is off, instead of skipping it',
    async () => {
      // Every note 30 cents sharp.
      const offset = await externalRun('effects-export-offset', FIVE);
      expect(results(offset)['export before any edit']).toBe('FAIL');
      expect(noteOf(offset, 'export before any edit')).toBe(
        'notes 0, 1, 2, 3, 4 are not at the detected pitch (5 of 5 steady notes, 0 allowed)',
      );
      // Every note bent over 180 cents: its own pitch is not steady, which must not take it out of the check.
      const glide = await externalRun('effects-export-glide', FIVE);
      expect(results(glide)['export before any edit']).toBe('FAIL');
      expect(exportCheck(glide).external.steadyNotes).toBe(5);
      expect(exportCheck(glide).external.leftOut.unsteadyPitch).toEqual([]);
      // One of five steady notes (20 %) beyond the tolerance: more than the 5 % allowed.
      const one = await externalRun('effects-export-one-off', FIVE);
      expect(results(one)['export before any edit']).toBe('FAIL');
      expect(noteOf(one, 'export before any edit')).toBe(
        'notes 1 are not at the detected pitch (1 of 5 steady notes, 0 allowed)',
      );
      expect(exportCheck(one).external.beyondTolerance).toEqual([1]);
      // The checks that follow still run on the same instance.
      expect(results(one)['setTargetPitch +100 cents']).toBe('PASS');
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'skips the unedited export check of external audio with fewer than 3 steady notes in the source',
    async () => {
      const notes = [55, 58, 60, 62].map((m, i) => (i < 2 ? { ...steadyNote(m), vibrato: WOBBLE } : steadyNote(m)));
      const report = await externalRun('effects', notes);
      expect(results(report)['export before any edit']).toBe('SKIP');
      expect(noteOf(report, 'export before any edit')).toBe(
        'external audio: only 2 of 4 notes have a steady pitch (2 with vibrato or glides, 0 too short)',
      );
      expect(exportCheck(report).external.steadyNotes).toBe(2);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'reports the attack and release residual of re-synthesised notes of external audio',
    async () => {
      const lengths = [0.6, 1.1, 0.6, 1.0, 0.6];
      const notes = FIVE.map((n, i) => ({ ...n, durationSec: lengths[i] ?? 0.6 }));
      const report = await externalRun('effects-resynth', notes);
      expect(report.steps.filter((s) => s.result === 'FAIL')).toEqual([]);
      const shift = report.checks['shiftCents +100 cents'] as {
        unedited: { reach: { bitIdentical: boolean; edgeResidualDb: number | null }[] };
      };
      expect(shift.unedited.reach.some((r) => !r.bitIdentical && typeof r.edgeResidualDb === 'number')).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );

  // The export after moveHandles is taken back: the clip is rendered again, so with external audio it is
  // the same sound in another phase and not the same samples; generated audio stays sample by sample.
  const MOVE = 'moveHandles +30 ms';
  interface AfterUndo {
    maxAbsDiff: number;
    sameSound?: { notes: { bitIdentical: boolean; pitchCents: number }[] };
  }
  const afterUndoOf = (report: EffectsReport) =>
    (report.checks[MOVE] as { exportAfterUndo: AfterUndo }).exportAfterUndo;

  it(
    'passes the export after the undo of moveHandles on external audio that comes back in another phase',
    async () => {
      const report = await externalRun('effects-undo-rephased', FIVE);
      expect(results(report)[MOVE]).toBe('PASS');
      expect(report.steps.filter((s) => s.result === 'FAIL')).toEqual([]);
      const again = afterUndoOf(report);
      // Sample by sample against the baseline this export would have failed (the tolerance is 1e-3 ...)
      expect(again.maxAbsDiff).toBeGreaterThan(0.01);
      // ... it is judged as the same sound: no note has the baseline's samples, every one its pitch.
      expect(again.sameSound?.notes.length).toBeGreaterThan(0);
      expect(again.sameSound?.notes.some((n) => !n.bitIdentical)).toBe(true);
      for (const n of again.sameSound?.notes ?? []) expect(Math.abs(n.pitchCents)).toBeLessThanOrEqual(0.5);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'fails the export after the undo of moveHandles on external audio that comes back at another pitch',
    async () => {
      const report = await externalRun('effects-undo-detuned', FIVE);
      expect(results(report)[MOVE]).toBe('FAIL');
      expect(noteOf(report, MOVE)).toMatch(/after the undo: note \d+ is 10(\.\d+)? cents from where it was/);
      expect(report.steps.filter((s) => s.result === 'FAIL').map((s) => s.name)).toEqual([MOVE]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'times the clips after the checks that external audio skips',
    async () => {
      const files = await writeToneFiles(generateTone({ seed: 5, notes: FIVE, leadSec: 0.6 }), 'external-take');
      try {
        const report = await runEffects(config('effects', { audioPath: files.wavPath, timingLengthsSec: [3] }));
        const r = results(report);
        expect(r['extra clips for the note-split, vibrato and drift checks']).toBe('SKIP');
        expect(r['prefs.set hybridMode']).toBe('SKIP');
        expect(noteOf(report, 'prefs.set hybridMode')).toContain('external audio');
        expect(r['timing 3 s']).toBe('PASS');
        expect(r.shutdown).toBe('PASS');
        expect(report.steps.filter((s) => s.result === 'FAIL')).toEqual([]);
      } finally {
        await files.cleanup();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'still compares the generated audio sample by sample after the undo of moveHandles',
    async () => {
      const report = await runEffects(config('effects-undo-detuned'));
      expect(results(report)[MOVE]).toBe('FAIL');
      expect(noteOf(report, MOVE)).toContain('after the undo the export differs from the baseline by up to');
      expect(afterUndoOf(report).sameSound).toBeUndefined();
      // The clip stays detuned, so the hybrid mode check, which compares with the baseline at the end, fails too.
      expect(report.steps.filter((s) => s.result === 'FAIL').map((s) => s.name)).toEqual([
        MOVE,
        'prefs.set hybridMode',
      ]);
    },
    SCENARIO_TIMEOUT_MS,
  );
});

describe('effects measurements', () => {
  const tone = (cents: number) =>
    decodeWav(generateTone({ seed: 9, notes: [{ midi: 60, cents, durationSec: 1 }], leadSec: 0.2 }).wav);
  const span = { index: 0, startSec: 0.2, endSec: 1.2, hz: 261.63 };

  it('measures the pitch difference of a note between two files to within the estimator bound', () => {
    const delta = noteDelta(tone(0), tone(100), span, 100);
    expect(delta.medianCents).not.toBeNull();
    expect(Math.abs((delta.medianCents ?? 0) - 100)).toBeLessThan(2);
    expect(delta.frames).toBeGreaterThan(50);
    // A span with no audio has too few voiced frames to be measured.
    expect(noteDelta(tone(0), tone(0), { ...span, startSec: 1.25, endSec: 1.3 }, 0).medianCents).toBeNull();
  });

  it('decodes the samples of PCM and float WAV files, every channel, and refuses what it cannot read', () => {
    const pcm = decodeWav(wavFile({ seconds: 0.1, rate: 8000, channels: 2 }));
    expect(pcm).toMatchObject({ sampleRateHz: 8000, bits: 16, float: false });
    expect(pcm.channels).toHaveLength(2);
    expect(pcm.mono).toHaveLength(800);
    expect(pcm.channels[0]?.[10]).toBe(pcm.channels[1]?.[10]);
    for (const bits of [8, 24, 32] as const) {
      const wav = decodeWav(wavFile({ seconds: 0.05, rate: 8000, bits }));
      expect(Math.max(...wav.mono.map(Math.abs))).toBeGreaterThan(0.29);
    }
    expect(decodeWav(wavFile({ seconds: 0.05, bits: 32, float: true, extensible: true, extraChunk: true })).float).toBe(
      true,
    );
    expect(() => decodeWav(Buffer.from('not a wav file'))).toThrow(/RIFF/);
    expect(() => decodeWav(wavFile({ seconds: 0.05, noData: true }))).toThrow(/no fmt or data/);
    expect(() => decodeWav(wavFile({ seconds: 0.05, formatTag: 2 }))).toThrow(/format tag 2/);
    expect(() => decodeWav(wavFile({ seconds: 0.05, bits: 16, float: true }))).toThrow(/layout/);
  });

  it('scrubs the audio file, the export folder and user folders from report text', () => {
    const audioPath = path.join(os.tmpdir(), 'takes', 'vocal take.wav');
    const workDir = path.join(os.tmpdir(), 'ot-tone-abc');
    const scrubbed = scrubText(
      `NOT_FOUND: ${audioPath} (vocal take.wav); wrote ${path.join(workDir, 'x.wav')}; ` +
        'C:\\Users\\username\\Music\\a.wav /home/username/b.wav /Users/username/c.wav',
      { audioPath, workDir },
    );
    expect(scrubbed).toBe(
      `NOT_FOUND: <audio> (<audio>); wrote ${path.join('<tmp>', 'x.wav')}; <home>\\Music\\a.wav <home>/b.wav <home>/c.wav`,
    );
    expect(scrubText('nothing to hide', {})).toBe('nothing to hide');
    expect(scrubText('a'.repeat(64), { audioPath: undefined, workDir: '' })).toBe('[redacted]');
  });

  it('tells a note rendered again in another phase from a moved, quieter or silent one', () => {
    const a = tone(0);
    const shifted = (wav: typeof a, by: number, gain = 1) => {
      const mono = new Float64Array(wav.mono.length);
      for (let i = 0; i < mono.length; i++) mono[i] = gain * (wav.mono[i - by] ?? 0);
      return { ...wav, channels: [mono], mono };
    };
    const inside = { startSec: 0.4, endSec: 1.0 };
    const period = a.sampleRateHz / 261.63;
    // The same samples: nothing left. A phase offset of a third of a period: aligned away.
    expect(alignedResidualDb(a, a, inside, period)).toBe(-200);
    const phase = alignedResidualDb(a, shifted(a, Math.round(period / 3)), inside, period);
    expect(phase).toBeLessThan(-40);
    // Not aligned (no shift allowed), the same offset leaves far more than the limit.
    expect(alignedResidualDb(a, shifted(a, Math.round(period / 3)), inside, 0)).toBeGreaterThan(
      RESYNTH_MAX_RESIDUAL_DB + 5,
    );
    // Moved by 10 cents, 2 dB quieter, or silent: well above the limit.
    expect(alignedResidualDb(a, tone(10), inside, period)).toBeGreaterThan(RESYNTH_MAX_RESIDUAL_DB + 10);
    expect(alignedResidualDb(a, shifted(a, 0, 10 ** (-2 / 20)), inside, period)).toBeGreaterThan(
      RESYNTH_MAX_RESIDUAL_DB,
    );
    expect(alignedResidualDb(a, shifted(a, 0, 0), inside, period)).toBe(0);
    // Nothing to compare against: no energy, or a span shorter than two shifts.
    expect(alignedResidualDb(shifted(a, 0, 0), a, inside, period)).toBeNull();
    expect(alignedResidualDb(a, a, { startSec: 0.5, endSec: 0.5 + period / a.sampleRateHz }, period)).toBeNull();
  });

  it('judges the attack and release of a re-synthesised note apart from its inside', () => {
    const a = tone(0);
    const note = { startSec: 0.2, endSec: 1.2 };
    const period = a.sampleRateHz / 261.63;
    const rate = a.sampleRateHz;
    const edit = (wav: typeof a, from: number, to: number, gain: number, by = 0) => {
      const mono = Float64Array.from(wav.mono);
      for (let i = Math.round(from * rate); i < Math.round(to * rate); i++) mono[i] = gain * (wav.mono[i - by] ?? 0);
      return { ...wav, channels: [mono], mono };
    };
    // The same samples, and the same sound in another phase: nothing left at the ends.
    expect(edgeResidualOf(a, a, note, period)).toBe(-200);
    const phase = edit(a, 0, 3, 1, Math.round(period / 3));
    expect(edgeResidualOf(a, phase, note, period)).toBeLessThan(RESYNTH_EDGE_MAX_RESIDUAL_DB - 20);
    // Only the first 0.1 s of the note is dropped (a lost attack): the inside is still the same sound,
    // and the edge check is the one that sees it. Same for a lost release.
    const noAttack = edit(a, 0.2, 0.3, 0);
    expect(alignedResidualDb(a, noAttack, { startSec: 0.4, endSec: 1.0 }, period)).toBe(-200);
    expect(edgeResidualOf(a, noAttack, note, period)).toBeGreaterThan(RESYNTH_EDGE_MAX_RESIDUAL_DB);
    expect(edgeResidualOf(a, edit(a, 1.1, 1.2, 0), note, period)).toBeGreaterThan(RESYNTH_EDGE_MAX_RESIDUAL_DB);
    // Nothing to compare against at either end.
    expect(edgeResidualOf(edit(a, 0, 3, 0), a, note, period)).toBeNull();
  });

  it('finds the notes within the reach of an edit, and the part of the others that is compared', () => {
    const note = (index: number, startSec: number, endSec: number) => ({ index, startSec, endSec });
    // Two phrases: 0-1-2 without gaps, a phrase gap, 3-4 without gaps, a phrase gap, 5.
    const gap = PHRASE_GAP_SEC + 0.05;
    const notes = [
      note(0, 0, 1),
      note(1, 1, 2),
      note(2, 2, 3),
      note(3, 3 + gap, 4 + gap),
      note(4, 4 + gap, 5 + gap),
      note(5, 5 + 2 * gap, 6 + 2 * gap),
    ];
    // The rest of the phrase, and the first note after the gap that ends it; never a note before.
    expect([...resynthesisReach(notes, [1])].sort()).toEqual([2, 3]);
    expect([...resynthesisReach(notes, [0])].sort()).toEqual([1, 2, 3]);
    expect([...resynthesisReach(notes, [3])].sort()).toEqual([4, 5]);
    expect([...resynthesisReach(notes, [5])]).toEqual([]);
    // An edited note is not in the reach of another edit; a short gap does not end a phrase.
    expect([...resynthesisReach(notes, [0, 2])].sort()).toEqual([1, 3]);
    const short = [note(0, 0, 1), note(1, 1 + PHRASE_GAP_SEC / 2, 2), note(2, 2 + gap, 3), note(3, 3 + gap * 2, 4)];
    expect([...resynthesisReach(short, [0])].sort()).toEqual([1, 2]);
    // Notes in any order: by time.
    expect([...resynthesisReach([...notes].reverse(), [3])].sort()).toEqual([4, 5]);

    // The compared part of a note stops RESYNTH_PRE_ROLL_SEC before an edited note after it.
    expect(awayWindow(note(0, 0, 1), notes, [1])).toEqual({ startSec: -0.05, endSec: 1 - RESYNTH_PRE_ROLL_SEC });
    expect(awayWindow(note(0, 0, 1), notes, [3])).toEqual({ startSec: -0.05, endSec: 1.05 });
    expect(awayWindow(note(5, 5, 6), notes, [1])).toEqual({ startSec: 4.95, endSec: 6.05 });
    // A note that ends within the pre-roll of an edited note has nothing left to compare.
    expect(awayWindow(note(9, 0.96, 0.98), [note(9, 0.96, 0.98), note(1, 1, 2)], [1])).toBeNull();
  });

  it('compares samples: identical, different, and of different lengths', () => {
    const a = tone(0);
    expect(compareSamples(a, a, [{ startSec: 0, endSec: 1 }])).toMatchObject({
      bitIdentical: 1,
      maxAbsDiff: 0,
      maxAbsDiffDbfs: null,
    });
    const b = tone(1);
    const diff = compareSamples(a, b, [{ startSec: 0.3, endSec: 1 }]);
    expect(diff.bitIdentical).toBe(0);
    expect(diff.maxAbsDiff).toBeGreaterThan(0);
    expect(diff.maxAbsDiffDbfs).toBeLessThan(0);
    const short = decodeWav(generateTone({ seed: 9, notes: [{ midi: 60, durationSec: 0.2 }], leadSec: 0 }).wav);
    expect(compareSamples(short, a, [{ startSec: 0, endSec: 2 }]).bitIdentical).toBe(0);
  });

  const state = {
    tokens: { arrangementRevision: 'a1', revision: 'r2', gridRevision: 'g1', keyRevision: 'k1' },
    notesRevision: 'r2',
    tuningHz: 440,
    notes: [
      {
        index: 0,
        startContentSec: 0.2,
        endContentSec: 1.2,
        detectedMidi: 60,
        targetMidi: 61,
        offsetCents: 0,
        retuneSpeed: 1,
        vibratoDepth: 0,
        vibratoRateHz: 7.5,
        pitchDriftScale: 1,
        voiced: true,
        corrected: true,
      },
    ],
    pitchShift: { semitones: 0, cents: 0 },
    handles: [{ handleId: '2', contentSec: 0.2, outputSec: 0.23 }],
    seeded: true,
  };
  const result = (overrides: Record<string, unknown> = {}) => ({
    tokens: {
      arrangementRevision: 'a1',
      contents: [{ contentId: 'c:1', revision: 'r2', gridRevision: 'g1', keyRevision: 'k1' }],
    },
    changes: [
      {
        entity: 'note',
        ref: { contentId: 'c:1', note: { index: 0, atRevision: 'r2' } },
        fields: { targetMidi: { before: 60, after: 61, unit: 'midi' } },
      },
      { entity: 'pitchShift', ref: { contentId: 'c:1' }, fields: { semitones: { before: 2, after: 0 } } },
      {
        entity: 'timeHandle',
        ref: { contentId: 'c:1', handleId: '2' },
        fields: { outputSec: { before: 0.2, after: 0.23 } },
      },
      { entity: 'content', ref: { contentId: 'c:1' }, fields: { revision: { before: 'r1', after: 'r2' } } },
      { entity: 'key', ref: { contentId: 'c:1' }, fields: { root: { before: 0, after: 2 } } },
    ],
    ...overrides,
  });

  const problemsOf = (r: Record<string, unknown>) => consistencyOf(r, state, 'c:1').problems;

  it('finds every disagreement between a result and the state read back', () => {
    expect(consistencyOf(result(), state, 'c:1')).toEqual({ problems: [], unreadFields: ['key.root'] });
    const wrong = problemsOf(
      result({
        tokens: {
          arrangementRevision: 'a0',
          contents: [{ contentId: 'c:1', revision: 'r9', gridRevision: 'g1', keyRevision: 'k1' }],
        },
        changes: [
          {
            entity: 'note',
            ref: { contentId: 'c:1', note: { index: 0, atRevision: 'r1' } },
            fields: { targetMidi: { before: 60, after: 61.5 } },
          },
          { entity: 'note', ref: { contentId: 'c:1', note: { index: 4, atRevision: 'r2' } }, fields: {} },
          { entity: 'timeHandle', ref: { contentId: 'c:1', handleId: '9' }, fields: { outputSec: { after: 1 } } },
          { entity: 'pitchShift', ref: { contentId: 'c:1' }, fields: { semitones: { before: 0, after: 2 } } },
        ],
      }),
    );
    expect(wrong).toEqual([
      'tokens.arrangementRevision is not the one read afterwards',
      'tokens.revision is not the one read afterwards',
      'note 0 is referenced at another revision than the one read afterwards',
      'note 0 targetMidi: the result says 61.5, read back 61',
      'note 4 of the changes is not there afterwards',
      'handle 9 of the changes is not there afterwards',
      'pitch shift semitones: the result says 2, read back 0',
    ]);
    expect(problemsOf(result({ tokens: { arrangementRevision: 'a1', contents: [] } }))).toEqual([
      'tokens has no entry for the clip',
    ]);
    expect(consistencyOf(result({ changes: null }), state, 'c:1')).toEqual({
      problems: ['changes is not an array'],
      unreadFields: [],
    });
  });

  it('compares only the fields it reads back, and lists the others without calling them a problem', () => {
    const extra = consistencyOf(
      result({
        changes: [
          {
            entity: 'note',
            ref: { contentId: 'c:1', note: { index: 0, atRevision: 'r2' } },
            // label is a note field the scenario does not parse; futureField one a later minor may add.
            fields: {
              targetMidi: { before: 60, after: 61 },
              label: { before: null, after: 'verse' },
              futureField: { before: 0, after: 1 },
            },
          },
          {
            entity: 'pitchShift',
            ref: { contentId: 'c:1' },
            fields: { cents: { before: 5, after: 0 }, formant: { before: 0, after: 1 } },
          },
          {
            entity: 'timeHandle',
            ref: { contentId: 'c:1', handleId: '2' },
            fields: { contentSec: { before: 0.1, after: 0.2 }, outputSec: { before: 0.2, after: 0.23 } },
          },
          { entity: 'note', ref: { contentId: 'c:1', note: { index: 0, atRevision: 'r2' } }, fields: { label: {} } },
        ],
      }),
      state,
      'c:1',
    );
    expect(extra).toEqual({ problems: [], unreadFields: ['note.futureField', 'note.label', 'pitchShift.formant'] });
    // A field it does read is still compared next to an unread one.
    expect(
      problemsOf(
        result({
          changes: [
            {
              entity: 'note',
              ref: { contentId: 'c:1', note: { index: 0, atRevision: 'r2' } },
              fields: { futureField: { after: 1 }, offsetCents: { before: 0, after: 100 } },
            },
            {
              entity: 'timeHandle',
              ref: { contentId: 'c:1', handleId: '2' },
              fields: { contentSec: { before: 0.2, after: 0.25 } },
            },
          ],
        }),
      ),
    ).toEqual([
      'note 0 offsetCents: the result says 100, read back 0',
      'handle 2 contentSec: the result says 0.25, read back 0.2',
    ]);
  });

  it('finds every difference between the snapshot before a write and the state after the undo', () => {
    expect(snapshotProblems(state, state)).toEqual([]);
    const moved = {
      ...state,
      notes: [
        { ...state.notes[0], targetMidi: 62 },
        { ...state.notes[0], index: 1 },
      ],
      pitchShift: { semitones: 1, cents: 0 },
      handles: [],
    } as typeof state;
    expect(snapshotProblems(state, moved)).toEqual([
      '2 notes after the undo, 1 before the write',
      'note 0 targetMidi: 61 before the write, 62 after the undo',
      'the pitch shift after the undo is not the one before the write',
      'the time-grid handles after the undo are not those before the write',
    ]);
  });
});

describe('effects configuration', () => {
  const exe = { OTCP_TARGET_EXE: process.execPath };
  it('reads the environment: report path, external audio and the timing lengths', async () => {
    expect(effectsSetupFromEnv({})).toEqual({ skip: 'OTCP_TARGET_EXE is not set' });
    const base = path.join(os.tmpdir(), 'reports');
    expect(effectsSetupFromEnv(exe)).toMatchObject({
      config: { reportPath: undefined, audioPath: undefined, timingLengthsSec: [60, 240], stepTimeoutMs: 180_000 },
    });
    expect(effectsSetupFromEnv({ ...exe, OTCP_E2E_REPORT: path.join(base, 'smoke.json') })).toMatchObject({
      config: { reportPath: path.join(base, 'effects.json') },
    });
    expect(
      effectsSetupFromEnv({
        ...exe,
        OTCP_E2E_REPORT: path.join(base, 'smoke.json'),
        OTCP_E2E_EFFECTS_REPORT: path.join(base, 'mine.json'),
        OTCP_E2E_EFFECTS_TIMING_SEC: '5, 10',
        OTCP_E2E_STEP_TIMEOUT_MS: '1000',
      }),
    ).toMatchObject({
      config: { reportPath: path.join(base, 'mine.json'), timingLengthsSec: [5, 10], stepTimeoutMs: 1000 },
    });
    expect(effectsSetupFromEnv({ ...exe, OTCP_E2E_EFFECTS_TIMING_SEC: 'none' })).toMatchObject({
      config: { timingLengthsSec: [] },
    });
    const dir = await tmp();
    const files = await writeToneFiles(generateTone({ seed: 1, notes: [{ midi: 60, durationSec: 0.2 }] }), 'take');
    scratch.push(files.dir);
    expect(effectsSetupFromEnv({ ...exe, OTCP_E2E_EFFECTS_AUDIO: files.wavPath })).toMatchObject({
      config: { audioPath: files.wavPath },
    });
    const bad: Record<string, string>[] = [
      { OTCP_E2E_EFFECTS_REPORT: 'relative.json' },
      { OTCP_E2E_REPORT: 'relative.json' },
      { OTCP_E2E_EFFECTS_AUDIO: 'take.wav' },
      { OTCP_E2E_EFFECTS_AUDIO: path.join(dir, 'missing.wav') },
      { OTCP_E2E_EFFECTS_AUDIO: files.truthPath },
      { OTCP_E2E_EFFECTS_TIMING_SEC: '1' },
      { OTCP_E2E_EFFECTS_TIMING_SEC: '60,x' },
      { OTCP_E2E_STEP_TIMEOUT_MS: '-1' },
    ];
    for (const env of bad) expect(() => effectsSetupFromEnv({ ...exe, ...env }), JSON.stringify(env)).toThrow();
  });

  it('takes its data template from OTCP_E2E_EFFECTS_DATA_TEMPLATE before OTCP_TARGET_DATA_TEMPLATE', async () => {
    const shared = await tmp();
    const own = await tmp();
    expect(effectsSetupFromEnv(exe)).toMatchObject({ config: { dataTemplateFrom: null } });
    expect(effectsSetupFromEnv(exe)).not.toHaveProperty('config.exe.dataTemplate');
    expect(effectsSetupFromEnv({ ...exe, OTCP_TARGET_DATA_TEMPLATE: shared })).toMatchObject({
      config: { exe: { dataTemplate: shared }, dataTemplateFrom: 'OTCP_TARGET_DATA_TEMPLATE' },
    });
    for (const env of [
      { OTCP_E2E_EFFECTS_DATA_TEMPLATE: own },
      { OTCP_E2E_EFFECTS_DATA_TEMPLATE: own, OTCP_TARGET_DATA_TEMPLATE: shared },
    ]) {
      expect(effectsSetupFromEnv({ ...exe, ...env }), JSON.stringify(env)).toMatchObject({
        config: {
          exe: { exe: process.execPath, dataTemplate: own },
          dataTemplateFrom: 'OTCP_E2E_EFFECTS_DATA_TEMPLATE',
        },
      });
    }
    // Empty is unset; anything else must be an absolute path of an existing folder, and the error names the variable.
    expect(
      effectsSetupFromEnv({ ...exe, OTCP_E2E_EFFECTS_DATA_TEMPLATE: '', OTCP_TARGET_DATA_TEMPLATE: shared }),
    ).toMatchObject({
      config: { exe: { dataTemplate: shared }, dataTemplateFrom: 'OTCP_TARGET_DATA_TEMPLATE' },
    });
    expect(() => effectsSetupFromEnv({ ...exe, OTCP_E2E_EFFECTS_DATA_TEMPLATE: 'relative' })).toThrow(
      'OTCP_E2E_EFFECTS_DATA_TEMPLATE must be an absolute path',
    );
    expect(() => effectsSetupFromEnv({ ...exe, OTCP_E2E_EFFECTS_DATA_TEMPLATE: path.join(own, 'missing') })).toThrow(
      'OTCP_E2E_EFFECTS_DATA_TEMPLATE is not an existing directory',
    );
    // Without an executable the scenario is skipped, whatever the template.
    expect(effectsSetupFromEnv({ OTCP_E2E_EFFECTS_DATA_TEMPLATE: 'relative' })).toEqual({
      skip: 'OTCP_TARGET_EXE is not set',
    });
  });
});

/** Runs the real test file of the scenario in a child process, with only the variables given. */
function runTestFile(env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OTCP_')));
  return spawnSync(
    process.execPath,
    [VITEST, 'run', '--project', 'e2e', '--reporter=verbose', 'test/e2e/exe-effects.test.ts'],
    { cwd: ROOT, env: { ...clean, ...env }, encoding: 'utf8', timeout: SCENARIO_TIMEOUT_MS - 30_000 },
  );
}

describe('the effects scenario as a test file', () => {
  it(
    'is skipped as a whole, with its reason, when OTCP_TARGET_EXE is not set',
    () => {
      const run = runTestFile({});
      const output = `${run.stdout}\n${run.stderr}`;
      expect(run.status).toBe(0);
      expect(output).toContain('exe effects not run: OTCP_TARGET_EXE is not set');
      expect(output).toMatch(/1 skipped/);
      expect(output).not.toMatch(/passed/);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'runs the scenario and writes effects.json next to the smoke report when OTCP_TARGET_EXE is set',
    async () => {
      const dir = await tmp();
      const template = await tmp();
      const run = runTestFile({
        ...(await fakeUserSettingsEnv(dir)),
        OTCP_TARGET_EXE: process.execPath,
        OTCP_TARGET_ARGS: JSON.stringify([FAKE, '--mode=effects-hybrid']),
        OTCP_E2E_REPORT: path.join(dir, 'report.json'),
        OTCP_E2E_STEP_TIMEOUT_MS: '20000',
        OTCP_E2E_EFFECTS_TIMING_SEC: 'none',
        OTCP_E2E_EFFECTS_DATA_TEMPLATE: template,
      });
      const output = `${run.stdout}\n${run.stderr}`;
      expect(run.status, output).toBe(0);
      expect(output).toMatch(/\| shiftTiming \+30 ms \| PASS \|/);
      expect(output).toMatch(/real user settings untouched \| PASS \|.*watched 1 files/);
      // The notice comes before the table.
      expect(output).toContain(`NOTE: ${HYBRID_MODE_NOTICE}\n| step | result | time | note |`);
      const written = JSON.parse(await readFile(path.join(dir, 'effects.json'), 'utf8')) as EffectsReport;
      // Hybrid mode on is said at the top of the report, and the checks are judged as usual.
      expect(written).toMatchObject({
        schema: 'opentune-mcp-e2e-effects/1',
        result: 'PASS',
        notices: [HYBRID_MODE_NOTICE],
        hybridMode: true,
        dataTemplateFrom: 'OTCP_E2E_EFFECTS_DATA_TEMPLATE',
      });
      expect(Object.keys(written).slice(0, 4)).toEqual(['schema', 'result', 'counts', 'notices']);
      expect(written.steps.find((s) => s.name === 'hello')?.note).toContain('hybrid mode on');
      expect(written.checks['shiftCents +100 cents']).toMatchObject({
        processing: [{ export: 'shiftCents +100 cents', hybridMode: true, backend: 'fake' }],
      });
    },
    SCENARIO_TIMEOUT_MS,
  );
});
