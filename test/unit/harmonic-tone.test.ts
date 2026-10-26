// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Self-check of the tone generator, independent of OpenTune: a small YIN estimator reads the
// generated audio back and must agree with the ground truth the generator reports.

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  CONTOUR_HOP_SEC,
  generateTone,
  hzToMidiCents,
  slowDriftCents,
  steppedCents,
  writeToneFiles,
  type Tone,
  type ToneSpec,
} from '../support/harmonic-tone.js';

/** The F0 frame length used where the protocol gives none: 10 ms. */
const HOP_SEC = 0.01;
const WINDOW = 2048;
const YIN_THRESHOLD = 0.05;
const MIN_HZ = 80;
const MAX_HZ = 1000;

/**
 * Time limit of the cases that read a whole tone back with the YIN estimator below (about 160 frames
 * of 1.1 million multiply-adds each). Measured on a developer machine: 0.12 s without coverage; with
 * coverage on, in the full unit run, the slower of the two longest took 1.97 s (1.1 s when run alone).
 * A CI runner then took 5.4 s, past the default limit of 5 s. The limit is 1.97 s x 4 (how much slower
 * a CI runner may be) x 2.5 (margin) = 19.7 s, rounded up. It only bounds a hung or runaway estimator;
 * no tolerance of the checks depends on it.
 */
const F0_ESTIMATE_TIMEOUT_MS = 20_000;

/** YIN (de Cheveigne and Kawahara, 2002) on one frame centred at `centre`; null when unvoiced. */
function yin(samples: Float64Array, rate: number, centre: number): number | null {
  const start = centre - WINDOW / 2;
  const tauMin = Math.floor(rate / MAX_HZ);
  const tauMax = Math.ceil(rate / MIN_HZ);
  if (start < 0 || start + WINDOW + tauMax > samples.length) return null;
  const d = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < WINDOW; j++) {
      const diff = (samples[start + j] ?? 0) - (samples[start + j + tau] ?? 0);
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  const cmnd = new Float64Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau] ?? 0;
    cmnd[tau] = running > 0 ? ((d[tau] ?? 0) * tau) / running : 1;
  }
  for (let tau = tauMin; tau < tauMax; tau++) {
    if ((cmnd[tau] ?? 1) < YIN_THRESHOLD) {
      while (tau + 1 < tauMax && (cmnd[tau + 1] ?? 1) < (cmnd[tau] ?? 1)) tau++;
      const a = cmnd[tau - 1] ?? 0;
      const b = cmnd[tau] ?? 0;
      const c = cmnd[tau + 1] ?? 0;
      const denominator = a - 2 * b + c;
      const shift = denominator === 0 ? 0 : (a - c) / (2 * denominator);
      return rate / (tau + shift);
    }
  }
  return null;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

/** Start of a note by energy: the first hop block whose RMS reaches 10% of the loudest block. */
function energyOnsets(tone: Tone): number[] {
  const rate = tone.truth.sampleRateHz;
  const hop = Math.round(HOP_SEC * rate);
  const blocks: number[] = [];
  for (let i = 0; i + hop <= tone.samples.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < hop; j++) sum += (tone.samples[i + j] ?? 0) ** 2;
    blocks.push(Math.sqrt(sum / hop));
  }
  const threshold = 0.1 * Math.max(...blocks);
  const onsets: number[] = [];
  blocks.forEach((rms, i) => {
    if (rms >= threshold && (i === 0 || (blocks[i - 1] ?? 0) < threshold)) onsets.push(i * HOP_SEC);
  });
  return onsets;
}

function checkAgainstTruth(tone: Tone): void {
  const { truth } = tone;
  const rate = truth.sampleRateHz;
  for (const note of truth.notes) {
    const estimates: number[] = [];
    const from = note.startSec + 0.06;
    const to = note.endSec - 0.06;
    for (let t = from; t <= to; t += HOP_SEC) {
      const hz = yin(tone.samples, rate, Math.round(t * rate));
      if (hz !== null) estimates.push(hz);
    }
    expect(estimates.length, `note ${String(note.index)} has voiced frames`).toBeGreaterThan(3);
    const errorCents = Math.abs(1200 * Math.log2(median(estimates) / note.hz));
    expect(errorCents, `note ${String(note.index)} median error in cents`).toBeLessThanOrEqual(5);
  }
  const onsets = energyOnsets(tone);
  expect(onsets).toHaveLength(truth.notes.length);
  truth.notes.forEach((note, i) => {
    expect(Math.abs((onsets[i] ?? Number.NaN) - note.startSec), `note ${String(i)} onset`).toBeLessThanOrEqual(HOP_SEC);
  });
}

const NOTES = [
  { midi: 57, durationSec: 0.5 },
  { midi: 62, cents: 30, durationSec: 0.5 },
  { hz: 392, durationSec: 0.5, gapSec: 0.15 },
  { midi: 72, cents: -20, durationSec: 0.6 },
] as const;

describe('harmonic tone generator', () => {
  for (const tuningHz of [440, 432]) {
    it(
      `agrees with an independent F0 estimate at tuningHz ${String(tuningHz)}`,
      () => {
        checkAgainstTruth(generateTone({ seed: 7, notes: NOTES, tuningHz }));
      },
      F0_ESTIMATE_TIMEOUT_MS,
    );
  }

  it('holds the pitch centre under vibrato and an amplitude envelope', () => {
    const tone = generateTone({
      seed: 3,
      notes: [{ midi: 60, durationSec: 0.8 }],
      vibrato: { rateHz: 5.5, depthCents: 20 },
      envelope: (p) => 0.6 + 0.4 * Math.sin(Math.PI * p),
    });
    const rate = tone.truth.sampleRateHz;
    const estimates: number[] = [];
    for (let t = 0.3; t <= 0.9; t += HOP_SEC) {
      const hz = yin(tone.samples, rate, Math.round(t * rate));
      if (hz !== null) estimates.push(hz);
    }
    expect(Math.abs(1200 * Math.log2(median(estimates) / (tone.truth.notes[0]?.hz ?? 1)))).toBeLessThan(15);
  });

  it('reports the truth relative to tuningHz', () => {
    const { truth } = generateTone({ seed: 1, notes: [{ midi: 69, cents: 30, durationSec: 0.3 }], tuningHz: 432 });
    const note = truth.notes[0];
    expect(note?.hz).toBeCloseTo(432 * 2 ** (0.3 / 12), 9);
    expect(note?.midi).toBe(69);
    expect(note?.cents).toBeCloseTo(30, 6);
    expect(note?.midiExact).toBeCloseTo(69.3, 9);
    expect(note?.startSec).toBeCloseTo(0.2, 9);
    expect(note?.endSec).toBeCloseTo(0.5, 9);
    expect(hzToMidiCents(440, 432).cents).toBeGreaterThan(30);
  });

  it('is byte-identical for the same seed and parameters, and the seed leaves the truth alone', () => {
    const spec: ToneSpec = { seed: 11, notes: NOTES, tuningHz: 432 };
    const a = generateTone(spec);
    const b = generateTone(spec);
    expect(a.sha256).toBe(b.sha256);
    expect(a.wav.equals(b.wav)).toBe(true);
    const other = generateTone({ ...spec, seed: 12 });
    expect(other.sha256).not.toBe(a.sha256);
    expect(other.truth).toEqual(a.truth);
  });

  it('writes a mono 16-bit PCM WAV and the truth JSON, and removes them on cleanup', async () => {
    const tone = generateTone({ seed: 5, notes: [{ midi: 60, durationSec: 0.3 }] });
    const files = await writeToneFiles(tone);
    const wav = await readFile(files.wavPath);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(44100);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.length).toBe(44 + tone.samples.length * 2);
    const truth = JSON.parse(await readFile(files.truthPath, 'utf8')) as typeof tone.truth;
    expect(truth.notes).toHaveLength(1);
    await files.cleanup();
    await expect(readFile(files.wavPath)).rejects.toThrow();
  });

  it('rejects a note with neither hz nor midi', () => {
    expect(() => generateTone({ seed: 1, notes: [{ durationSec: 0.1 }] })).toThrow(/hz or midi/);
  });

  describe('rejects parameters it cannot render, naming the note and the parameter', () => {
    const ok = { midi: 60, durationSec: 0.2 } as const;
    it.each([
      ['hz at Nyquist', { hz: 22050, durationSec: 0.2 }, /note 0: hz 22050 must be above 0 and below half/],
      ['hz above Nyquist', { hz: 30000, durationSec: 0.2 }, /note 0: hz 30000 must be above 0 and below half/],
      ['hz zero', { hz: 0, durationSec: 0.2 }, /note 0: hz 0 must be above 0/],
      ['hz negative', { hz: -440, durationSec: 0.2 }, /note 0: hz -440 must be above 0/],
      ['hz NaN', { hz: Number.NaN, durationSec: 0.2 }, /note 0: hz NaN must be above 0/],
      ['midi far above the range', { midi: 200, durationSec: 0.2 }, /note 0: hz .* must be above 0 and below half/],
      ['midi NaN', { midi: Number.NaN, durationSec: 0.2 }, /note 0: hz NaN/],
      ['duration zero', { midi: 60, durationSec: 0 }, /note 0: durationSec 0 must be above 0/],
      ['duration negative', { midi: 60, durationSec: -0.1 }, /note 0: durationSec -0.1 must be above 0/],
      ['duration NaN', { midi: 60, durationSec: Number.NaN }, /note 0: durationSec NaN/],
      ['gap negative', { midi: 60, durationSec: 0.2, gapSec: -0.05 }, /note 0: gapSec -0.05 must be 0 or more/],
      ['gap NaN', { midi: 60, durationSec: 0.2, gapSec: Number.NaN }, /note 0: gapSec NaN/],
    ])('%s', (_label, note, message) => {
      expect(() => generateTone({ seed: 1, notes: [note] })).toThrow(message);
    });

    it('names the second note when the first is fine', () => {
      expect(() => generateTone({ seed: 1, notes: [ok, { hz: 0, durationSec: 0.2 }] })).toThrow(/^note 1: hz 0 /);
    });

    it.each([0, -0.01, Number.NaN])('fadeSec %s', (fadeSec) => {
      expect(() => generateTone({ seed: 1, notes: [ok], fadeSec })).toThrow(/fadeSec .* must be above 0/);
    });

    it('accepts a note just below Nyquist and zero gap', () => {
      const tone = generateTone({ seed: 1, notes: [{ hz: 22049, durationSec: 0.1, gapSec: 0 }] });
      expect(tone.truth.notes[0]?.hz).toBe(22049);
    });
  });
});

describe('pitch trajectories of a note', () => {
  /** The cents the F0 estimate lies above the note's own pitch, at `tSec` seconds from the start of the file. */
  const centsAt = (tone: Tone, tSec: number): number => {
    const rate = tone.truth.sampleRateHz;
    const hz = yin(tone.samples, rate, Math.round(tSec * rate));
    return hz === null ? Number.NaN : 1200 * Math.log2(hz / (tone.truth.notes[0]?.hz ?? 1));
  };

  it('steppedCents holds each level and glides between them in a raised cosine', () => {
    const f = steppedCents(
      [
        { atSec: 0, cents: 0 },
        { atSec: 1, cents: 90 },
        { atSec: 2, cents: 30 },
      ],
      0.2,
    );
    expect(f(0)).toBe(0);
    expect(f(0.89)).toBe(0);
    expect(f(1)).toBeCloseTo(45, 9); // the middle of the glide
    expect(f(1.11)).toBe(90);
    expect(f(1.5)).toBe(90);
    expect(f(2)).toBeCloseTo(60, 9);
    expect(f(5)).toBe(30);
    expect(f(0.95)).toBeGreaterThan(0);
    expect(f(0.95)).toBeLessThan(45);
  });

  it('steppedCents refuses no level and a glide of no length', () => {
    expect(() => steppedCents([])).toThrow(/at least one level/);
    expect(() => steppedCents([{ atSec: 0, cents: 0 }], 0)).toThrow(/rampSec 0 must be above 0/);
    expect(() => steppedCents([{ atSec: 0, cents: 0 }], Number.NaN)).toThrow(/rampSec NaN/);
  });

  it('slowDriftCents is a sine of the amplitude and the period, from the phase given', () => {
    const f = slowDriftCents(30, 2);
    expect(f(0)).toBeCloseTo(0, 9);
    expect(f(0.5)).toBeCloseTo(30, 9);
    expect(f(1)).toBeCloseTo(0, 9);
    expect(f(1.5)).toBeCloseTo(-30, 9);
    expect(slowDriftCents(10, 1, Math.PI / 2)(0)).toBeCloseTo(10, 9);
    expect(() => slowDriftCents(10, 0)).toThrow(/periodSec 0 must be above 0/);
  });

  it('puts a step into the audio: an independent estimate follows the plateaus', () => {
    const tone = generateTone({
      seed: 4,
      leadSec: 0.2,
      notes: [
        {
          midi: 60,
          durationSec: 1.6,
          pitchCents: steppedCents([
            { atSec: 0, cents: 0 },
            { atSec: 0.8, cents: 100 },
          ]),
        },
      ],
    });
    const before = [0.5, 0.6, 0.7].map((t) => centsAt(tone, t));
    const after = [1.1, 1.2, 1.3].map((t) => centsAt(tone, t));
    expect(Math.abs(median(before))).toBeLessThan(5);
    expect(Math.abs(median(after) - 100)).toBeLessThan(5);
    // The truth keeps the pitch the note was given.
    expect(tone.truth.notes[0]?.midiExact).toBe(60);
  });

  it('puts a slow drift into the audio: the estimate swings by the amplitude', () => {
    const tone = generateTone({
      seed: 4,
      leadSec: 0.2,
      notes: [{ midi: 60, durationSec: 2, pitchCents: slowDriftCents(30, 2) }],
    });
    // The sine peaks a quarter period into the note (0.2 + 0.5 s) and bottoms out at 0.2 + 1.5 s.
    const around = (t: number) => median([-0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03].map((d) => centsAt(tone, t + d)));
    expect(Math.abs(around(0.7) - 30)).toBeLessThan(8);
    expect(Math.abs(around(1.7) + 30)).toBeLessThan(8);
  });

  it('writes the trajectory into the truth, one value every CONTOUR_HOP_SEC from the start of the note', () => {
    const tone = generateTone({
      seed: 1,
      notes: [
        { midi: 60, durationSec: 0.5, pitchCents: (t) => 100 * t },
        { midi: 62, durationSec: 0.2 },
      ],
    });
    const [moving, flat] = tone.truth.notes;
    expect(moving?.contourCents).toHaveLength(50);
    expect(moving?.contourCents?.[0]).toBe(0);
    expect(moving?.contourCents?.[10]).toBeCloseTo(10, 6);
    expect(moving?.contourCents?.[49]).toBeCloseTo(49, 6);
    expect(flat?.contourCents).toBeUndefined();
    expect(CONTOUR_HOP_SEC).toBe(0.01);
  });

  it('stays byte-identical per seed with a trajectory, and differs from the tone without one', () => {
    const spec: ToneSpec = { seed: 9, notes: [{ midi: 60, durationSec: 0.4, pitchCents: slowDriftCents(20, 1) }] };
    expect(generateTone(spec).sha256).toBe(generateTone(spec).sha256);
    expect(generateTone(spec).sha256).not.toBe(
      generateTone({ seed: 9, notes: [{ midi: 60, durationSec: 0.4 }] }).sha256,
    );
  });
});
