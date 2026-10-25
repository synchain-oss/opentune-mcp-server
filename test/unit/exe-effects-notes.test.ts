// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The checks of the effects scenario (test/e2e/effects.ts) for note splitting, scale snapping, vibrato,
// pitch drift, the time grid's moveHandles and the two processing preferences, against the stand-in
// executable (`effects*` modes of test/support/fake-effects.mjs): each way an instance can get one of
// them wrong makes the check about it fail, and only that one; a check that fails half-way still puts
// the preference back; a preference that cannot be put back stops the checks. The measurements the
// checks rest on have their own tests below. (The run against an instance that does what the
// specification says is in exe-effects.test.ts.)

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DRIFT_MIN_BASELINE_STD_CENTS,
  DRIFT_ZERO_MAX_FRACTION,
  SPLIT_BOUNDARY_TOLERANCE_SEC,
  VIBRATO_ABSENT_MAX_CENTS,
  VIBRATO_AMPLITUDE_RATIO_MAX,
  VIBRATO_AMPLITUDE_RATIO_MIN,
  VIBRATO_RATE_TOLERANCE_HZ,
  driftProblems,
  nearestInCMajor,
  runEffects,
  splitProblems,
  vibratoProblems,
  waveringOf,
  type EffectsConfig,
  type EffectsReport,
  type Wavering,
} from '../e2e/effects.js';
import { generateTone } from '../support/harmonic-tone.js';
import { decodeWav } from '../support/wav-decode.js';

const FAKE = fileURLToPath(new URL('../support/fake-opentune.mjs', import.meta.url));
/**
 * Timeout of a test that runs the whole scenario against the stand-in, once or twice (about 10 s a run on a
 * developer machine). Measured on the CI runners, with coverage: a run takes about 40 s, the slowest test
 * (two runs) 98 s, and the whole file 681 s. 330 s is 3.4 times the slowest test, and a test that hangs
 * still fails.
 */
const SCENARIO_TIMEOUT_MS = 330_000;

const config = (mode: string): EffectsConfig => ({
  exe: { exe: process.execPath, args: [FAKE, `--mode=${mode}`], timeoutMs: 15_000 },
  stepTimeoutMs: 20_000,
  reportPath: undefined,
  audioPath: undefined,
  timingLengthsSec: [3],
});

const results = (report: EffectsReport) => Object.fromEntries(report.steps.map((s) => [s.name, s.result]));
const noteOf = (report: EffectsReport, name: string) => report.steps.find((s) => s.name === name)?.note ?? '';

const SNAP = 'snapToScale returns an off-scale note to the scale';
const TUNING = 'prefs.set tuningHz 442';
const HYBRID = 'prefs.set hybridMode';
const MOVE = 'moveHandles +30 ms';
const SPLIT = 'AUTO regenerate noteSplitCents';
const VIBRATO = 'setParams vibratoDepth and vibratoRateHz';
const DRIFT = 'setParams pitchDriftScale 0';
const NEW_CHECKS = [SNAP, TUNING, HYBRID, MOVE, SPLIT, VIBRATO, DRIFT] as const;

/** Runs the scenario against a stand-in that gets one thing wrong; only `wrong` fails, every other new check passes. */
async function onlyFails(mode: string, wrong: string): Promise<EffectsReport> {
  const report = await runEffects(config(mode));
  const r = results(report);
  expect(r[wrong], `${mode}: ${wrong}`).toBe('FAIL');
  for (const name of NEW_CHECKS.filter((n) => n !== wrong)) expect(r[name], `${mode}: ${name}`).toBe('PASS');
  expect(r['timing 3 s']).toBe('PASS');
  expect(r.shutdown).toBe('PASS');
  return report;
}

describe('note, scale, preference and time grid checks against the stand-in', () => {
  it(
    'fails the note-split check when AUTO cuts at the same sensitivity whatever it is asked for',
    async () => {
      const report = await onlyFails('effects-split-ignored', SPLIT);
      const note = noteOf(report, SPLIT);
      expect(note).toContain('noteSplitCents 30: no note starts within 0.1 s of the pitch step');
      expect(note).toContain("noteSplitCents 160: notes start inside the tone's notes at");
      expect(note).toMatch(/a sensitivity of 30 cents gave 4 notes, 160 cents gave 4: the smaller one should cut more/);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'fails the snapToScale check when the note stays off the scale',
    async () => {
      const report = await onlyFails('effects-snap-ignored', SNAP);
      const note = noteOf(report, SNAP);
      expect(note).toContain("the note's target reads back 62.7, expected 62");
      expect(note).toContain("the note's offsetCents reads back 70, expected 0");
      expect(note).toMatch(/snapped: note 3: 70(\.\d+)? cents, expected 0 \+- 15/);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'fails the vibrato check when the vibrato is stored and not rendered, or rendered at the wrong rate',
    async () => {
      const ignored = await onlyFails('effects-vibrato-ignored', VIBRATO);
      expect(noteOf(ignored, VIBRATO)).toMatch(
        /the pitch moves by \+-[0-9.]+ cents, expected between 35 and 57\.5 for depth 50/,
      );
      const slow = await onlyFails('effects-vibrato-wrong-rate', VIBRATO);
      expect(noteOf(slow, VIBRATO)).toMatch(/the pitch moves at 3(\.\d+)? Hz, expected 6 \+- 0\.25/);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'fails the drift check when pitchDriftScale 0 leaves the drift as it was',
    async () => {
      const report = await onlyFails('effects-drift-ignored', DRIFT);
      expect(noteOf(report, DRIFT)).toMatch(/with pitchDriftScale 0 the note still drifts by [0-9.]+ cents \(std\)/);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'fails the tuning check when AUTO rounds to the semitones of 440 Hz after the reference was changed',
    async () => {
      const report = await onlyFails('effects-tuning-ignored', TUNING);
      expect(noteOf(report, TUNING)).toMatch(/note 0: 0 cents, expected 7\.85 \+- 3/);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'fails the hybrid mode check when the preference changes and the render does not',
    async () => {
      const report = await onlyFails('effects-hybrid-ignored', HYBRID);
      expect(noteOf(report, HYBRID)).toMatch(
        /the clip exports the same in hybrid mode off and hybrid mode on \(samples differ by up to 0\.00e\+0, at least 1e-3 expected\)/,
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'fails the moveHandles check when the handle did not move although the result says it did',
    async () => {
      const report = await onlyFails('effects-move-ignored', MOVE);
      expect(noteOf(report, MOVE)).toMatch(/handle [0-9]+ outputSec: the result says [0-9.]+, read back [0-9.]+/);
      // shiftTiming moved its handle in the same instance.
      expect(results(report)['shiftTiming +30 ms']).toBe('PASS');
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'puts the hybrid mode back when the check fails half-way, and the checks after it run on the instance as it began',
    async () => {
      const report = await runEffects(config('effects-hybrid-export-fails'));
      const r = results(report);
      expect(r[HYBRID]).toBe('FAIL');
      expect(noteOf(report, HYBRID)).toContain('INTERNAL(fake_export_failed)');
      // No later check halted, and the exports of the timing step work again: the preference was restored.
      expect(r['timing 3 s']).toBe('PASS');
      expect(r.shutdown).toBe('PASS');
      for (const name of NEW_CHECKS.filter((n) => n !== HYBRID)) expect(r[name], name).toBe('PASS');
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'stops the checks, and names the preference and its value at the start, when a preference cannot be put back',
    async () => {
      const report = await runEffects(config('effects-pref-stuck'));
      const r = results(report);
      expect(r[TUNING]).toBe('FAIL');
      expect(noteOf(report, TUNING)).toContain(
        'preference tuningHz reads 442 after the revert, it was 440 when the check began',
      );
      // Not run on an instance whose reference is changed.
      expect(r['race: +100 cents, export, -100 cents']).toBe('SKIP');
      expect(noteOf(report, HYBRID)).toBe(`not run: ${TUNING} ended with FAIL`);
      expect(r[HYBRID]).toBe('SKIP');
      expect(r.shutdown).toBe('PASS');
    },
    SCENARIO_TIMEOUT_MS,
  );

  // The revert recipe of prefs.set is data the instance returns: the scenario uses it only as a prefs.set of
  // the preferences it changed, else it puts them back from what prefs.get read at the start, and says so.
  const PREF_CHECKS = [TUNING, HYBRID];
  const othersPass = (report: EffectsReport, failing: readonly string[]) => {
    const r = results(report);
    for (const name of failing) expect(r[name], name).toBe('FAIL');
    for (const name of NEW_CHECKS.filter((n) => !failing.includes(n))) expect(r[name], name).toBe('PASS');
    // The preferences were put back: later exports work (an instance left in hybrid mode would differ), the run ends.
    expect(r['timing 3 s']).toBe('PASS');
    expect(r.shutdown).toBe('PASS');
  };

  it(
    'fails a preference check whose result gives no revert recipe, and puts the preference back from its start value',
    async () => {
      const report = await runEffects(config('effects-pref-recipe-missing'));
      othersPass(report, PREF_CHECKS);
      for (const name of PREF_CHECKS) {
        expect(noteOf(report, name), name).toContain(
          'the prefs.set result gave no revert recipe; put back from what prefs.get read when the check began',
        );
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'does not call a method the revert recipe names but prefs.set, and puts the preference back from its start value',
    async () => {
      const report = await runEffects(config('effects-pref-recipe-foreign'));
      othersPass(report, PREF_CHECKS);
      for (const name of PREF_CHECKS) {
        const note = noteOf(report, name);
        expect(note, name).toContain(
          'the revert recipe calls prefs.wipe, not prefs.set; put back from what prefs.get read',
        );
        // Calling it would have failed this way (the stand-in has no such method).
        expect(note, name).not.toContain('UNSUPPORTED');
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'fails a preference check whose revert recipe also sets another preference, and sends only the one it changed',
    async () => {
      const report = await runEffects(config('effects-pref-recipe-extra'));
      othersPass(report, PREF_CHECKS);
      // The problem names the key the recipe has too much (an instance defect: the recipe would change a
      // preference the write did not touch).
      expect(noteOf(report, TUNING)).toContain(
        'the revert recipe also sets hybridMode, which this write did not change',
      );
      expect(noteOf(report, HYBRID)).toContain('the revert recipe also sets tuningHz, which this write did not change');
      // The extra keys were not executed: the hybrid mode the tuning recipe names (on) was not switched on.
      expect(report.hybridMode).toBe(false);
      expect(report.notices).toEqual([]);
      // Nothing else is wrong with the recipe: the put-back needed no fallback.
      for (const name of PREF_CHECKS) {
        expect(noteOf(report, name), name).not.toContain('put back from what prefs.get read');
        expect((report.checks[name] as { revertProblems?: string[] }).revertProblems).toBeUndefined();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'writes the problems of a put-back that runs after a failed check to the report',
    async () => {
      const report = await runEffects(config('effects-hybrid-export-fails-foreign'));
      othersPass(report, PREF_CHECKS);
      // The hybrid check failed half-way, on its export; the put-back ran as its cleanup.
      expect(noteOf(report, HYBRID)).toContain('INTERNAL(fake_export_failed)');
      const hybrid = report.checks[HYBRID] as { revertProblems?: string[] };
      expect(hybrid.revertProblems).toHaveLength(1);
      expect(hybrid.revertProblems?.[0]).toContain('the revert recipe calls prefs.wipe, not prefs.set');
      // The tuning check reached its own put-back: its problem is in its note, not in revertProblems.
      expect((report.checks[TUNING] as { revertProblems?: string[] }).revertProblems).toBeUndefined();
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'skips the preference checks without prefs.write, and runs the others',
    async () => {
      const report = await runEffects(config('effects-no-prefs'));
      const r = results(report);
      expect(r[TUNING]).toBe('SKIP');
      expect(noteOf(report, TUNING)).toBe('the instance does not report prefs.write');
      expect(r[HYBRID]).toBe('SKIP');
      for (const name of [SNAP, MOVE, SPLIT, VIBRATO, DRIFT]) expect(r[name], name).toBe('PASS');
      expect(report.result).toBe('SKIP');
    },
    SCENARIO_TIMEOUT_MS,
  );
});

describe('nearestInCMajor', () => {
  it.each([
    [62, 62],
    [62.7, 62],
    [63.4, 64],
    [60.49, 60],
    [60.51, 60],
    [61, 62], // between C# and D... 61 is not in C major: 60 and 62 are equally far, the tie goes up
    [66, 67], // F# is between F and G: the tie goes up
    [59.5, 60], // between B and C: the tie goes up
    [71.9, 72],
    [-1, -1], // B below the first octave
    [0.2, 0],
  ])('%s -> %s', (midi, expected) => {
    expect(nearestInCMajor(midi)).toBe(expected);
  });
});

describe('what the checks measure', () => {
  const steady = (cents: (t: number) => number, seconds = 3) => {
    const tone = generateTone({
      seed: 3,
      leadSec: 0.2,
      notes: [{ midi: 60, durationSec: seconds, pitchCents: cents }],
    });
    const hz = tone.truth.notes[0]?.hz ?? 1;
    return {
      wav: decodeWav(tone.wav),
      span: { index: 0, startSec: tone.truth.notes[0]?.startSec ?? 0, endSec: tone.truth.notes[0]?.endSec ?? 0, hz },
    };
  };

  it('waveringOf reads the rate and the amplitude of a vibrato, and almost nothing from a steady note', () => {
    const vib = steady((t) => 40 * Math.sin(2 * Math.PI * 6 * t));
    const wavering = waveringOf(vib.wav, vib.span);
    expect(wavering?.rateHz).toBeGreaterThan(5.9);
    expect(wavering?.rateHz).toBeLessThan(6.1);
    expect(wavering?.amplitudeCents).toBeGreaterThan(34);
    expect(wavering?.amplitudeCents).toBeLessThan(44);
    expect(wavering?.varianceShare).toBeGreaterThan(0.8);
    const flat = steady(() => 0);
    const none = waveringOf(flat.wav, flat.span);
    expect(none?.amplitudeCents).toBeLessThan(VIBRATO_ABSENT_MAX_CENTS);
    expect(none?.stdCents).toBeLessThan(2);
  });

  it('waveringOf reads a slow drift as spread, not as a vibrato', () => {
    const drift = steady((t) => 30 * Math.sin((2 * Math.PI * t) / 1.5), 3.6);
    const wavering = waveringOf(drift.wav, drift.span);
    expect(wavering?.stdCents).toBeGreaterThan(15);
    expect(wavering?.stdCents).toBeLessThan(23);
  });

  it('waveringOf is null for a note with too few voiced frames', () => {
    const tone = steady(() => 0, 0.12);
    expect(waveringOf(tone.wav, tone.span)).toBeNull();
  });

  const waver = (over: Partial<Wavering> = {}): Wavering => ({
    frames: 180,
    stdCents: 0.2,
    peakToPeakCents: 1,
    rateHz: 6,
    amplitudeCents: 0.1,
    varianceShare: 0.5,
    ...over,
  });

  describe('vibratoProblems', () => {
    const base = waver();
    it('accepts the vibrato that was set', () => {
      expect(vibratoProblems(base, waver({ rateHz: 6.1, amplitudeCents: 45.6, varianceShare: 1 }), 50, 6)).toEqual([]);
      // The edges of the window.
      expect(vibratoProblems(base, waver({ amplitudeCents: 50 * VIBRATO_AMPLITUDE_RATIO_MIN }), 50, 6)).toEqual([]);
      expect(vibratoProblems(base, waver({ amplitudeCents: 50 * VIBRATO_AMPLITUDE_RATIO_MAX }), 50, 6)).toEqual([]);
      expect(
        vibratoProblems(base, waver({ rateHz: 6 + VIBRATO_RATE_TOLERANCE_HZ, amplitudeCents: 45 }), 50, 6),
      ).toEqual([]);
    });
    it('rejects no vibrato, a wrong rate, a vibrato too weak or too strong', () => {
      expect(vibratoProblems(base, waver({ rateHz: 4.2, amplitudeCents: 0.3 }), 50, 6)).toHaveLength(2);
      expect(vibratoProblems(base, waver({ rateHz: 3, amplitudeCents: 45 }), 50, 6)).toEqual([
        'the pitch moves at 3 Hz, expected 6 +- 0.25',
      ]);
      expect(vibratoProblems(base, waver({ amplitudeCents: 20 }), 50, 6)[0]).toContain(
        'between 35 and 57.5 for depth 50',
      );
      expect(vibratoProblems(base, waver({ amplitudeCents: 70 }), 50, 6)[0]).toContain('+-70 cents');
    });
    it('rejects a baseline that already vibrates', () => {
      const moving = waver({ amplitudeCents: 8 });
      expect(vibratoProblems(moving, waver({ amplitudeCents: 45 }), 50, 6)[0]).toContain('baseline note already moves');
    });
  });

  describe('driftProblems', () => {
    it('accepts a note that drifts at scale 1 and hardly at 0', () => {
      expect(driftProblems(waver({ stdCents: 10.3 }), waver({ stdCents: 0.8 }))).toEqual([]);
      expect(driftProblems(waver({ stdCents: 10 }), waver({ stdCents: 10 * DRIFT_ZERO_MAX_FRACTION }))).toEqual([]);
    });
    it('rejects a scale 0 that drifts on, and a baseline too steady to say anything', () => {
      expect(driftProblems(waver({ stdCents: 10.3 }), waver({ stdCents: 9.9 }))[0]).toContain(
        'still drifts by 9.9 cents',
      );
      expect(driftProblems(waver({ stdCents: 10 }), waver({ stdCents: 3.6 }))).toHaveLength(1);
      expect(
        driftProblems(waver({ stdCents: DRIFT_MIN_BASELINE_STD_CENTS - 0.1 }), waver({ stdCents: 0 }))[0],
      ).toContain('the check needs');
    });
  });

  describe('splitProblems', () => {
    // Two tone notes with a step each: 1 to 3 s with a step at 2 s, 4 to 7 s with steps at 5 and 6 s.
    const toneNotes = [
      { startSec: 1, endSec: 3 },
      { startSec: 4, endSec: 7 },
    ];
    const steps = [2, 5, 6];
    const tol = SPLIT_BOUNDARY_TOLERANCE_SEC;
    const cutNotes = [
      { startSec: 1, endSec: 2 },
      { startSec: 2, endSec: 3 },
      { startSec: 4, endSec: 5 },
      { startSec: 5 + tol / 2, endSec: 6 },
      { startSec: 6, endSec: 7 },
    ];
    const whole = [
      { startSec: 1.02, endSec: 3 },
      { startSec: 4, endSec: 6.98 },
    ];

    it('accepts notes cut at every step, and notes that are the tone notes', () => {
      expect(splitProblems(cutNotes, toneNotes, steps, true)).toEqual([]);
      expect(splitProblems(whole, toneNotes, steps, false)).toEqual([]);
    });
    it('names a step nobody cut at, a cut where the pitch does not step', () => {
      expect(
        splitProblems(
          cutNotes.filter((n) => n.startSec !== 2),
          toneNotes,
          steps,
          true,
        ),
      ).toEqual(['no note starts within 0.1 s of the pitch step at 2.00 s']);
      expect(splitProblems([...cutNotes, { startSec: 3.5, endSec: 3.8 }], toneNotes, steps, true)).toEqual([]);
      expect(splitProblems([...cutNotes, { startSec: 6.5, endSec: 6.8 }], toneNotes, steps, true)).toEqual([
        'a note starts at 6.50 s, where the pitch does not step',
      ]);
    });
    it('names notes that start inside a tone note, and ends that are missing, when nothing should be cut', () => {
      expect(splitProblems(cutNotes, toneNotes, steps, false)[0]).toContain("notes start inside the tone's notes at");
      expect(
        splitProblems([{ startSec: 1.5, endSec: 3 }, whole[1] ?? { startSec: 0, endSec: 0 }], toneNotes, steps, false),
      ).toEqual([
        "notes start inside the tone's notes at 1.50 s",
        'no note starts at the start of the tone note at 1.00 s',
      ]);
      expect(
        splitProblems([whole[0] ?? { startSec: 0, endSec: 0 }, { startSec: 4, endSec: 6.5 }], toneNotes, steps, false),
      ).toEqual(['no note ends at the end of the tone note at 7.00 s']);
      expect(splitProblems([], toneNotes, steps, false)).toHaveLength(2);
    });
  });
});
