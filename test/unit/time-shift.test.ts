// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The time-shift estimate of the timing effects check (test/support/time-shift.ts) against generated
// tones moved by a known number of samples: the error bound that the timing tolerance rests on
// (SHIFT_ERROR_SEC) holds both ways, also when the moved copy starts its periods at another phase
// (a re-synthesised file), and a window that does not fit or holds nothing to follow is refused.

import { describe, expect, it } from 'vitest';

import { generateTone, type ToneNote } from '../support/harmonic-tone.js';
import { SHIFT_ERROR_SEC, estimateShift, rmsEnvelope } from '../support/time-shift.js';

const NOTES: readonly ToneNote[] = [
  { midi: 57, durationSec: 0.8, gapSec: 0.3 },
  { midi: 60, cents: 40, durationSec: 0.8, gapSec: 0.3 },
  { midi: 64, durationSec: 0.8, gapSec: 0.3 },
];

/** `samples` delayed by `seconds` (earlier when negative), padded with zeros. */
function delayed(samples: Float64Array, rate: number, seconds: number): Float64Array {
  const n = Math.round(seconds * rate);
  return samples.map((_, i) => samples[i - n] ?? 0);
}

describe('time-shift estimate', () => {
  const tone = generateTone({ seed: 21, notes: NOTES });
  const rate = tone.truth.sampleRateHz;
  const middle = tone.truth.notes[1];
  if (middle === undefined) throw new Error('no note');
  const window = { startSec: middle.startSec - 0.15, endSec: middle.endSec + 0.15 };
  // The same notes with other starting phases of every harmonic.
  const otherPhase = generateTone({ seed: 77, notes: NOTES }).samples;

  for (const seconds of [0, 0.03, -0.015, 0.0073, 0.05]) {
    it(`finds a shift of ${String(seconds * 1000)} ms within ${String(SHIFT_ERROR_SEC * 1000)} ms`, () => {
      const exact = Math.round(seconds * rate) / rate;
      const same = estimateShift(tone.samples, delayed(tone.samples, rate, seconds), rate, window);
      expect(Math.abs(same.lagSec - exact)).toBeLessThanOrEqual(SHIFT_ERROR_SEC);
      expect(same.peak).toBeGreaterThan(0.99);
      const phase = estimateShift(tone.samples, delayed(otherPhase, rate, seconds), rate, window);
      expect(Math.abs(phase.lagSec - exact)).toBeLessThanOrEqual(SHIFT_ERROR_SEC);
      expect(phase.peak).toBeGreaterThan(0.95);
    });
  }

  it('refuses a window that does not fit, a section without an envelope, and bad options', () => {
    expect(() => estimateShift(tone.samples, tone.samples, rate, { startSec: 0, endSec: 0.5 })).toThrow(/fit/);
    expect(() =>
      estimateShift(tone.samples, tone.samples, rate, { startSec: 1, endSec: tone.truth.durationSec }),
    ).toThrow(/fit/);
    const silence = new Float64Array(rate * 2);
    expect(() => estimateShift(silence, silence, rate, { startSec: 0.5, endSec: 1.5 })).toThrow(/envelope/);
    expect(() => estimateShift(tone.samples, tone.samples, rate, window, { hopSec: 0 })).toThrow(/above 0/);
  });

  it('builds an RMS envelope at the given hop', () => {
    const constant = new Float64Array(1000).fill(0.5);
    const envelope = rmsEnvelope(constant, 1000, 0.01, 0.004);
    expect(envelope).toHaveLength(101);
    expect(envelope[50]).toBeCloseTo(0.5, 9);
    expect(rmsEnvelope(new Float64Array(0), 1000, 0.01, 0.004)[0]).toBe(0);
  });
});
