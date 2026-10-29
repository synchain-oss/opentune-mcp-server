// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { contourOf, detrend, modulationOf, spreadOf, stdDev } from '../support/pitch-modulation.js';

const HOP = 0.01;

/** An F0 track in Hz around `centreHz` with the given cents per frame. */
const track = (centreHz: number, cents: (i: number) => number, frames: number): number[] =>
  Array.from({ length: frames }, (_, i) => centreHz * 2 ** (cents(i) / 1200));

describe('contourOf', () => {
  it('gives the cents around the median pitch', () => {
    const hz = track(440, () => 0, 50).map((v, i) => (i % 2 === 0 ? v : v * 2 ** (20 / 1200)));
    const contour = contourOf(hz, HOP);
    expect(contour).not.toBeNull();
    expect(contour?.hopSec).toBe(HOP);
    expect(contour?.filled).toBe(0);
    // The median of a track that alternates 0 and 20 cents is the upper value (the middle of 25 and 25
    // sorted values); either way every value lies within 20 cents of it.
    for (const c of contour?.cents ?? []) expect(Math.abs(c)).toBeLessThanOrEqual(20.0001);
  });

  it('fills unvoiced frames by interpolating between their neighbours, and the ends with the nearest value', () => {
    const hz: (number | null)[] = track(440, (i) => 10 * i, 10);
    hz[0] = null;
    hz[4] = null;
    hz[5] = null;
    hz[9] = null;
    const contour = contourOf(hz, HOP, 0.5);
    expect(contour?.filled).toBe(4);
    const cents = contour?.cents ?? [];
    // Frames 3 and 6 are at 30 and 60 cents; 4 and 5 lie on the line between them.
    expect((cents[4] ?? 0) - (cents[3] ?? 0)).toBeCloseTo(10, 6);
    expect((cents[5] ?? 0) - (cents[4] ?? 0)).toBeCloseTo(10, 6);
    expect(cents[0]).toBe(cents[1]);
    expect(cents[9]).toBe(cents[8]);
  });

  it('is null for a track with too many unvoiced frames, and for one with none voiced', () => {
    const holes: (number | null)[] = track(440, () => 0, 20);
    for (let i = 0; i < 5; i++) holes[i * 4] = null;
    expect(contourOf(holes, HOP, 0.1)).toBeNull();
    expect(contourOf(holes, HOP, 0.3)).not.toBeNull();
    expect(contourOf([null, null, null], HOP)).toBeNull();
    expect(contourOf([], HOP)).toBeNull();
  });
});

describe('detrend and stdDev', () => {
  it('removes the mean and the straight line', () => {
    const flat = detrend(Array.from({ length: 11 }, (_, i) => 5 + 3 * i));
    for (const v of flat) expect(v).toBeCloseTo(0, 9);
    expect(detrend([])).toEqual([]);
    expect(detrend([7])).toEqual([0]);
  });

  it('keeps what is not a straight line', () => {
    const wave = Array.from({ length: 100 }, (_, i) => 10 * Math.sin((2 * Math.PI * i) / 25) + 0.5 * i);
    expect(stdDev(detrend(wave))).toBeCloseTo(10 / Math.SQRT2, 0);
  });

  it('stdDev is the population deviation, 0 for nothing', () => {
    expect(stdDev([])).toBe(0);
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 9);
  });
});

describe('spreadOf', () => {
  it('is near 0 for a steady pitch and ignores a straight drift', () => {
    const steady = contourOf(
      track(440, () => 0, 100),
      HOP,
    );
    expect(steady && spreadOf(steady).stdCents).toBeLessThan(1e-9);
    const drifting = contourOf(
      track(440, (i) => 0.5 * i, 100),
      HOP,
    );
    expect(drifting && spreadOf(drifting).stdCents).toBeLessThan(1e-6);
  });

  it('measures a wave: about amplitude over root two (a little less: the line fitted to the wave is taken out), peak to peak about twice the amplitude', () => {
    const wave = contourOf(
      track(440, (i) => 30 * Math.sin((2 * Math.PI * i * HOP) / 1.5), 300),
      HOP,
    );
    const spread = wave && spreadOf(wave);
    expect(spread?.stdCents).toBeGreaterThan(18);
    expect(spread?.stdCents).toBeLessThan(22.5);
    expect(spread?.peakToPeakCents).toBeGreaterThan(50);
    expect(spread?.peakToPeakCents).toBeLessThan(70);
  });

  it('is 0 for an empty contour', () => {
    expect(spreadOf({ hopSec: HOP, cents: [], filled: 0 })).toEqual({ stdCents: 0, peakToPeakCents: 0 });
  });
});

describe('modulationOf', () => {
  const vibrato = (rateHz: number, amplitude: number, frames = 300) =>
    contourOf(
      track(440, (i) => amplitude * Math.sin(2 * Math.PI * rateHz * i * HOP), frames),
      HOP,
    );

  it.each([
    [4, 20],
    [6, 45],
    [6, 10],
    [10, 25],
  ])('finds a vibrato of %s Hz and %s cents: its rate and its amplitude', (rate, amplitude) => {
    const contour = vibrato(rate, amplitude);
    const found = contour && modulationOf(contour);
    expect(found?.rateHz).toBeGreaterThan(rate - 0.1);
    expect(found?.rateHz).toBeLessThan(rate + 0.1);
    // A Hann window over a few periods leaks a little, so the amplitude is within 10 %.
    expect(found?.amplitudeCents).toBeGreaterThan(amplitude * 0.9);
    expect(found?.amplitudeCents).toBeLessThan(amplitude * 1.1);
    expect(found?.varianceShare).toBeGreaterThan(0.85);
  });

  it('finds the period as about 1 / rate', () => {
    const contour = vibrato(5, 30, 400);
    const found = contour && modulationOf(contour);
    expect(1 / (found?.rateHz ?? 1)).toBeGreaterThan(0.19);
    expect(1 / (found?.rateHz ?? 1)).toBeLessThan(0.21);
  });

  it('finds almost nothing in a steady pitch or a slow drift', () => {
    const steady = contourOf(
      track(440, () => 0, 300),
      HOP,
    );
    expect(steady && modulationOf(steady).amplitudeCents).toBe(0);
    // One slow period over the window is taken out by the straight line only in part; it stays below
    // the scan's lowest rate and far below the vibrato.
    const slow = contourOf(
      track(440, (i) => 30 * Math.sin((2 * Math.PI * i * HOP) / 3), 300),
      HOP,
    );
    expect(slow && modulationOf(slow).varianceShare).toBeLessThan(0.7);
  });

  it('gives a small share for noise', () => {
    let state = 12345;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const noisy = contourOf(
      track(440, () => (random() - 0.5) * 20, 300),
      HOP,
    );
    expect(noisy && modulationOf(noisy).varianceShare).toBeLessThan(0.2);
  });

  it('reports nothing for a track that is too short to say anything', () => {
    const short = contourOf(
      track(440, (i) => 10 * Math.sin(i), 5),
      HOP,
    );
    expect(short && modulationOf(short)).toMatchObject({ rateHz: 0, amplitudeCents: 0, varianceShare: 0 });
  });
});
