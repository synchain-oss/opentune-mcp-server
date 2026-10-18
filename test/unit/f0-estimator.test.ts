// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The F0 estimator of the effects checks (test/support/f0-estimator.ts) against generated harmonic
// tones whose pitch is known exactly, at three tunings: the error bound that the effects tolerances
// rest on (ESTIMATOR_ERROR_CENTS) holds, there is no octave error over the range of a voice, silence
// and noise are unvoiced, and a band given by the caller is honoured.

import { describe, expect, it } from 'vitest';

import {
  ESTIMATOR_ERROR_CENTS,
  centsBetween,
  decimate,
  estimateF0,
  hzToMidi,
  median,
  type F0Track,
} from '../support/f0-estimator.js';
import { generateTone } from '../support/harmonic-tone.js';

/** The estimates inside a note, its first and last 80 ms left out, as cents from `hz`. */
function centsInside(track: F0Track, startSec: number, endSec: number, hz: number) {
  const cents: number[] = [];
  let unvoiced = 0;
  track.hz.forEach((value, k) => {
    const t = k * track.hopSec;
    if (t < startSec + 0.08 || t > endSec - 0.08) return;
    if (value === null) unvoiced++;
    else cents.push(centsBetween(hz, value));
  });
  return { cents, unvoiced };
}

describe('F0 estimator', () => {
  for (const tuningHz of [440, 432, 446]) {
    it(`stays within ${String(ESTIMATOR_ERROR_CENTS)} cents of generated tones from MIDI 40 to 80 at tuningHz ${String(tuningHz)}`, () => {
      let worstMedian = 0;
      let worstFrame = 0;
      for (let midi = 40; midi <= 80; midi += 2) {
        for (const cents of [0, 40, -27]) {
          const tone = generateTone({ seed: midi * 13 + cents, notes: [{ midi, cents, durationSec: 0.5 }], tuningHz });
          const note = tone.truth.notes[0];
          if (note === undefined) throw new Error('no note');
          const track = estimateF0(tone.samples, tone.truth.sampleRateHz);
          const { cents: errors, unvoiced } = centsInside(track, note.startSec, note.endSec, note.hz);
          expect(unvoiced, `MIDI ${String(midi)}${cents >= 0 ? '+' : ''}${String(cents)} c: no unvoiced frame`).toBe(0);
          expect(errors.length).toBeGreaterThan(25);
          worstMedian = Math.max(worstMedian, Math.abs(median(errors)));
          worstFrame = Math.max(worstFrame, ...errors.map(Math.abs));
        }
      }
      expect(worstMedian).toBeLessThanOrEqual(ESTIMATOR_ERROR_CENTS);
      // A single frame may be a little further off, never by anything like an octave (1200 cents).
      expect(worstFrame).toBeLessThanOrEqual(2 * ESTIMATOR_ERROR_CENTS);
    }, 60_000);
  }

  it('reports the difference of two notes a semitone apart to within the bound, with vibrato', () => {
    const tone = generateTone({
      seed: 4,
      notes: [
        { midi: 57, durationSec: 1 },
        { midi: 58, durationSec: 1 },
      ],
      vibrato: { rateHz: 5.5, depthCents: 20 },
      tuningHz: 432,
    });
    const track = estimateF0(tone.samples, tone.truth.sampleRateHz);
    const [a, b] = tone.truth.notes;
    if (a === undefined || b === undefined) throw new Error('no notes');
    const ca = median(centsInside(track, a.startSec, a.endSec, a.hz).cents);
    const cb = median(centsInside(track, b.startSec, b.endSec, a.hz).cents);
    expect(Math.abs(cb - ca - 100)).toBeLessThanOrEqual(ESTIMATOR_ERROR_CENTS);
    expect(hzToMidi(a.hz, 432)).toBeCloseTo(57, 9);
  });

  it('leaves silence and white noise unvoiced, and the frames at the edges', () => {
    const rate = 44_100;
    const silence = new Float64Array(rate);
    expect(estimateF0(silence, rate).hz.every((v) => v === null)).toBe(true);
    let state = 1;
    const noise = silence.map(() => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return (state / 4294967296 - 0.5) * 0.5;
    });
    const track = estimateF0(noise, rate);
    const voiced = track.hz.filter((v) => v !== null).length;
    expect(voiced / track.hz.length).toBeLessThan(0.05);
    // The first frame is centred at 0: half its window lies before the file.
    const tone = generateTone({ seed: 1, leadSec: 0, notes: [{ midi: 60, durationSec: 0.5 }] });
    const toneTrack = estimateF0(tone.samples, tone.truth.sampleRateHz);
    expect(toneTrack.hz[0]).toBeNull();
    expect(toneTrack.aperiodicity[0]).toBe(1);
  });

  it('searches only the band it is given', () => {
    const tone = generateTone({ seed: 2, notes: [{ midi: 60, durationSec: 0.5 }] });
    const note = tone.truth.notes[0];
    if (note === undefined) throw new Error('no note');
    const inBand = estimateF0(tone.samples, tone.truth.sampleRateHz, { minHz: note.hz / 1.5, maxHz: note.hz * 1.5 });
    expect(Math.abs(median(centsInside(inBand, note.startSec, note.endSec, note.hz).cents))).toBeLessThanOrEqual(
      ESTIMATOR_ERROR_CENTS,
    );
    // A band that excludes the pitch finds no period that is good enough: unvoiced, or not the pitch.
    const outOfBand = estimateF0(tone.samples, tone.truth.sampleRateHz, { minHz: note.hz * 1.3, maxHz: note.hz * 1.9 });
    const found = centsInside(outOfBand, note.startSec, note.endSec, note.hz).cents;
    expect(found.every((c) => Math.abs(c) > 300)).toBe(true);
  });

  it('works on any sample rate, decimating above 32 kHz', () => {
    for (const sampleRateHz of [16_000, 22_050, 48_000, 96_000]) {
      const tone = generateTone({ seed: 3, sampleRateHz, notes: [{ midi: 62, cents: 13, durationSec: 0.5 }] });
      const note = tone.truth.notes[0];
      if (note === undefined) throw new Error('no note');
      const track = estimateF0(tone.samples, sampleRateHz);
      expect(Math.abs(median(centsInside(track, note.startSec, note.endSec, note.hz).cents))).toBeLessThanOrEqual(
        ESTIMATOR_ERROR_CENTS,
      );
    }
    const samples = new Float64Array([1, 2, 3]);
    expect(decimate(samples, 1)).toBe(samples);
    expect(decimate(new Float64Array(10), 3)).toHaveLength(3);
  });

  it('rejects options it cannot work with', () => {
    const samples = new Float64Array(1000);
    expect(() => estimateF0(samples, 0)).toThrow(/sample rate/);
    expect(() => estimateF0(samples, 44_100, { minHz: 500, maxHz: 400 })).toThrow(/minHz/);
    expect(() => estimateF0(samples, 8000, { maxHz: 2500 })).toThrow(/quarter/);
    expect(() => estimateF0(samples, 44_100, { hopSec: 0 })).toThrow(/hopSec/);
    expect(() => estimateF0(samples, 44_100, { threshold: 0.3, voicingThreshold: 0.2 })).toThrow(/threshold/);
  });

  it('computes medians and cents', () => {
    expect(median([])).toBeNaN();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(centsBetween(440, 880)).toBeCloseTo(1200, 9);
    expect(centsBetween(440, 440 * 2 ** (1 / 12))).toBeCloseTo(100, 9);
  });
});
