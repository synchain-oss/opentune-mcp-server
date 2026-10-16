// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Pitch-class features of an audio signal for key estimation, after the harmonic pitch class
// profile (HPCP) of Gomez (2006): a short-time spectrum, its peaks, the tuning of the peaks as a
// circular mean, then per frame a 12-bin chroma in which every peak also counts, with decaying
// weight, towards the pitch classes of which it could be the 2nd to 4th harmonic, and a separate
// bass chroma from the peaks below BASS_MAX_HZ. Frames are normalized to their maximum, so loud
// and quiet passages count alike; silent frames are marked and left out.

import { addPitch, at, tuningOffset, type Tuning, type WeightedPitch } from '../analysis/key.js';

const CHROMA_MIN_HZ = 60;
const CHROMA_MAX_HZ = 3500;
const BASS_MIN_HZ = 40;
export const BASS_MAX_HZ = 200;
const HARMONICS = 4;
const HARMONIC_DECAY = 0.6;
const MAX_PEAKS = 40;
/** Peaks below the frame's strongest peak by more than this ratio are ignored (-60 dB). */
const PEAK_FLOOR = 1e-3;
/** A frame with less than this share of the loudest frame's energy counts as silent (-50 dB). */
const SILENCE = 1e-5;
/** A frame has a bass line when its strongest bass peak is within this ratio of its strongest peak (-30 dB). */
const BASS_FLOOR = 0.0316;

const TWIDDLES = new Map<number, { cos: Float64Array; sin: Float64Array }>();

function twiddles(n: number) {
  let table = TWIDDLES.get(n);
  if (table === undefined) {
    table = {
      cos: Float64Array.from({ length: n / 2 }, (_, k) => Math.cos((-2 * Math.PI * k) / n)),
      sin: Float64Array.from({ length: n / 2 }, (_, k) => Math.sin((-2 * Math.PI * k) / n)),
    };
    TWIDDLES.set(n, table);
  }
  return table;
}

/** In-place radix-2 FFT; the length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  const table = twiddles(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [at(re, j), at(re, i)];
      [im[i], im[j]] = [at(im, j), at(im, i)];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const cr = at(table.cos, k * step);
        const ci = at(table.sin, k * step);
        const a = i + k;
        const b = a + half;
        const tr = at(re, b) * cr - at(im, b) * ci;
        const ti = at(re, b) * ci + at(im, b) * cr;
        re[b] = at(re, a) - tr;
        im[b] = at(im, a) - ti;
        re[a] = at(re, a) + tr;
        im[a] = at(im, a) + ti;
      }
    }
  }
}

export interface AudioFeatures {
  readonly rateHz: number;
  readonly durationSec: number;
  /** Time between frames, seconds. */
  readonly hopSec: number;
  /** Centre of each frame, seconds. */
  readonly times: Float64Array;
  /** 12 values per frame, normalized to a maximum of 1; zero for a silent frame. */
  readonly chroma: Float32Array;
  readonly bass: Float32Array;
  readonly active: Uint8Array;
  readonly bassPresent: Uint8Array;
  /** Tuning of the spectral peaks relative to A4 = 440 Hz; null without peaks. */
  readonly tuning: Tuning | null;
}

const midiOf = (hz: number): number => 69 + 12 * Math.log2(hz / 440);

/** The spectral features of mono `samples` at `rateHz`. */
export function analyzeAudio(samples: Float32Array, rateHz: number): AudioFeatures {
  const size = rateHz > 12_500 ? 8192 : 4096;
  const hop = size / 2;
  const count = samples.length >= size ? Math.floor((samples.length - size) / hop) + 1 : samples.length > 0 ? 1 : 0;
  const window = Float64Array.from({ length: size }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / size));
  const binHz = rateHz / size;
  const kMin = Math.max(1, Math.floor(BASS_MIN_HZ / binHz));
  const kMax = Math.min(size / 2 - 2, Math.ceil(CHROMA_MAX_HZ / binHz));
  const peaks: { hz: number; amp: number }[][] = [];
  const energy = new Float64Array(count);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const mag = new Float64Array(size / 2);
  for (let f = 0; f < count; f++) {
    re.fill(0);
    im.fill(0);
    for (let n = 0; n < size; n++) {
      const x = at(samples, f * hop + n) * at(window, n);
      re[n] = x;
      energy[f] = at(energy, f) + x * x;
    }
    fft(re, im);
    let top = 0;
    for (let k = kMin - 1; k <= kMax + 1; k++) {
      mag[k] = Math.hypot(at(re, k), at(im, k));
      top = Math.max(top, at(mag, k));
    }
    const found: { hz: number; amp: number }[] = [];
    for (let k = kMin; k <= kMax; k++) {
      const [a, b, c] = [at(mag, k - 1), at(mag, k), at(mag, k + 1)];
      if (!(b > a && b >= c && b > top * PEAK_FLOOR)) continue;
      // Parabolic interpolation of the log magnitude around the peak bin.
      const [la, lb, lc] = [Math.log(a + 1e-12), Math.log(b + 1e-12), Math.log(c + 1e-12)];
      const denominator = la - 2 * lb + lc;
      // A strict peak has la < lb >= lc, so the denominator is negative.
      const p = (0.5 * (la - lc)) / denominator;
      found.push({ hz: (k + p) * binHz, amp: Math.exp(lb - 0.25 * (la - lc) * p) });
    }
    peaks.push(found.sort((x, y) => y.amp - x.amp).slice(0, MAX_PEAKS));
  }
  const loudest = energy.reduce((m, v) => Math.max(m, v), 0);
  const active = Uint8Array.from(energy, (e) => (e > 1e-10 && e >= loudest * SILENCE ? 1 : 0));

  // Tuning: fundamentals dominate the peaks between 80 Hz and 1 kHz, weighted by energy.
  const readings: WeightedPitch[] = [];
  peaks.forEach((frame, f) => {
    if (active[f] !== 1) return;
    for (const { hz, amp } of frame) if (hz >= 80 && hz <= 1000) readings.push({ midi: midiOf(hz), weight: amp * amp });
  });
  const tuning = tuningOffset(readings);
  const shift = (tuning?.offsetCents ?? 0) / 100;

  const chroma = new Float32Array(count * 12);
  const bass = new Float32Array(count * 12);
  const bassPresent = new Uint8Array(count);
  const frameChroma = new Float64Array(12);
  const frameBass = new Float64Array(12);
  peaks.forEach((frame, f) => {
    if (active[f] !== 1) return;
    frameChroma.fill(0);
    frameBass.fill(0);
    const strongest = Math.max(0, ...frame.map((peak) => peak.amp));
    let bassTop = 0;
    for (const { hz, amp } of frame) {
      if (hz >= CHROMA_MIN_HZ) {
        for (let h = 1; h <= HARMONICS && hz / h >= CHROMA_MIN_HZ; h++) {
          addPitch(frameChroma, midiOf(hz / h) - shift, amp * HARMONIC_DECAY ** (h - 1));
        }
      }
      if (hz <= BASS_MAX_HZ) {
        addPitch(frameBass, midiOf(hz) - shift, amp);
        bassTop = Math.max(bassTop, amp);
      }
    }
    bassPresent[f] = bassTop > 0 && bassTop >= strongest * BASS_FLOOR ? 1 : 0;
    const cMax = Math.max(...frameChroma);
    const bMax = Math.max(...frameBass);
    for (let p = 0; p < 12; p++) {
      chroma[f * 12 + p] = at(frameChroma, p) / Math.max(cMax, Number.MIN_VALUE);
      bass[f * 12 + p] = at(frameBass, p) / Math.max(bMax, Number.MIN_VALUE);
    }
  });
  return {
    rateHz,
    durationSec: samples.length / rateHz,
    hopSec: hop / rateHz,
    times: Float64Array.from({ length: count }, (_, f) => (f * hop + size / 2) / rateHz),
    chroma,
    bass,
    active,
    bassPresent,
    tuning,
  };
}

export interface ChromaSummary {
  /** Mean chroma of the non-silent frames in the range. */
  readonly chroma: Float64Array;
  /** Mean bass chroma of the frames in the range that have a bass line. */
  readonly bass: Float64Array;
  /** Seconds of non-silent audio in the range. */
  readonly activeSec: number;
  /** Share of the non-silent frames that have a bass line. */
  readonly bassShare: number;
}

/** The features of the frames whose centre lies in [fromSec, toSec). */
export function summarizeRange(features: AudioFeatures, fromSec = -Infinity, toSec = Infinity): ChromaSummary {
  const chroma = new Float64Array(12);
  const bass = new Float64Array(12);
  let active = 0;
  let withBass = 0;
  features.times.forEach((t, f) => {
    if (t < fromSec || t >= toSec || features.active[f] !== 1) return;
    active += 1;
    const hasBass = features.bassPresent[f] === 1;
    if (hasBass) withBass += 1;
    for (let p = 0; p < 12; p++) {
      chroma[p] = at(chroma, p) + at(features.chroma, f * 12 + p);
      if (hasBass) bass[p] = at(bass, p) + at(features.bass, f * 12 + p);
    }
  });
  return {
    chroma: chroma.map((v) => (active > 0 ? v / active : 0)),
    bass: bass.map((v) => (withBass > 0 ? v / withBass : 0)),
    activeSec: active * features.hopSec,
    bassShare: active > 0 ? withBass / active : 0,
  };
}
