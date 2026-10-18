// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// A YIN fundamental-frequency estimator (de Cheveigne and Kawahara, 2002) for the effects checks of
// the end-to-end tests. It reads audio back (an exported WAV, or the generated source) and reports one
// F0 value per frame, or null where the frame is unvoiced. Pure TypeScript without dependencies.
//
// It does not have to be a production pitch tracker: every effects check compares two files with this
// same estimator, so what matters is that it is precise and repeatable on harmonic, voice-like
// signals. Its error on generated harmonic tones is pinned by test/unit/f0-estimator.test.ts.
//
// Steps per frame (the numbers are those of the paper): 2. difference function, 3. cumulative mean
// normalised difference, 4. threshold, 5. parabolic interpolation of the chosen minimum. Step 6 (best
// local estimate) is left out: the signals measured here are steady within a note. Step 4 differs
// from the paper in one way: its threshold is taken relative to the deepest dip, not as an absolute
// value. A voice-like signal whose energy sits in a narrow formant is nearly periodic at the period of
// the harmonic nearest that formant, a fraction of the true period, and that dip can fall below any
// fixed threshold; it does not come as close to the deepest dip (at the true period) as a real period
// does. A relative threshold of 0.02 gave no octave error on generated tones from MIDI 38 to 82 at
// two tunings, where 0.01 and 0.04 both gave some, and an absolute 0.1 (the paper's) gave many. A
// caller that knows roughly where the pitch is passes minHz and maxHz around it, which rules octave
// errors out altogether.
//
// Before that, the audio is low-pass filtered and decimated to between 16 and 32 kHz, which keeps the
// work per frame small without losing precision for the fundamentals of a voice.

export interface F0Options {
  /** Lowest fundamental searched for; 60 Hz unless given. */
  readonly minHz?: number;
  /** Highest fundamental searched for; 1000 Hz unless given. */
  readonly maxHz?: number;
  /** Distance between frame centres; 10 ms unless given. Frame k is centred at k * hopSec. */
  readonly hopSec?: number;
  /** Integration window of the difference function; 30 ms unless given. */
  readonly windowSec?: number;
  /** Threshold of step 4: the first dip within this distance of the deepest one is chosen; 0.02 unless given. */
  readonly threshold?: number;
  /** A frame whose best normalised difference lies above this is unvoiced; 0.25 unless given. */
  readonly voicingThreshold?: number;
  /** A frame whose RMS lies below this (dB relative to full scale 1.0) is unvoiced; -50 unless given. */
  readonly silenceDbfs?: number;
}

export interface F0Track {
  readonly hopSec: number;
  /** One value per frame, frame k centred at k * hopSec: the fundamental in Hz, or null when unvoiced. */
  readonly hz: readonly (number | null)[];
  /** The normalised difference at the chosen lag (0 = perfectly periodic), per frame; 1 where not computed. */
  readonly aperiodicity: readonly number[];
}

const DEFAULTS = {
  minHz: 60,
  maxHz: 1000,
  hopSec: 0.01,
  windowSec: 0.03,
  threshold: 0.02,
  voicingThreshold: 0.25,
  silenceDbfs: -50,
} as const;

/**
 * The error bound of this estimator on generated harmonic tones from MIDI 40 to 80 (82 to 831 Hz), at
 * tunings 432, 440 and 446 Hz: the median over a note stays within this many cents of the true
 * pitch, and no single frame strays more than twice as far (test/unit/f0-estimator.test.ts). The
 * largest median error measured there was 1.9 cents, at the top of the range; it is below 0.5 cents
 * up to MIDI 70.
 */
export const ESTIMATOR_ERROR_CENTS = 2;

/** The decimated rate stays at or above this, so that 1000 Hz keeps at least 16 samples per period. */
const MIN_ANALYSIS_RATE_HZ = 16_000;
/** Half length of the low-pass filter used before decimation, in taps. */
const FILTER_HALF_TAPS = 32;
/** Cut-off of that filter as a fraction of the decimated Nyquist frequency. */
const FILTER_CUTOFF = 0.9;

/** Cents from `fromHz` to `toHz`: positive when `toHz` is higher. */
export const centsBetween = (fromHz: number, toHz: number): number => 1200 * Math.log2(toHz / fromHz);

/** Fractional MIDI number of `hz` (A4 = 69 at `tuningHz`). */
export const hzToMidi = (hz: number, tuningHz: number): number => 69 + 12 * Math.log2(hz / tuningHz);

/** The median of `values`, the mean of the two middle values for an even count; NaN when empty. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] ?? Number.NaN) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Low-pass filters `samples` (a Blackman-windowed sinc) and keeps every `factor`-th sample. A factor
 * of 1 returns the samples as they are.
 */
export function decimate(samples: Float64Array, factor: number): Float64Array {
  if (factor <= 1) return samples;
  const cutoff = FILTER_CUTOFF / factor; // fraction of the original Nyquist frequency
  const taps = new Float64Array(2 * FILTER_HALF_TAPS + 1);
  let sum = 0;
  for (let i = -FILTER_HALF_TAPS; i <= FILTER_HALF_TAPS; i++) {
    const sinc = i === 0 ? cutoff : Math.sin(Math.PI * cutoff * i) / (Math.PI * i);
    const n = (i + FILTER_HALF_TAPS) / (2 * FILTER_HALF_TAPS);
    const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * n) + 0.08 * Math.cos(4 * Math.PI * n);
    taps[i + FILTER_HALF_TAPS] = sinc * window;
    sum += sinc * window;
  }
  for (let i = 0; i < taps.length; i++) taps[i] = (taps[i] ?? 0) / sum;
  const out = new Float64Array(Math.floor(samples.length / factor));
  for (let o = 0; o < out.length; o++) {
    const centre = o * factor;
    let acc = 0;
    for (let i = -FILTER_HALF_TAPS; i <= FILTER_HALF_TAPS; i++) {
      const at = centre + i;
      if (at >= 0 && at < samples.length) acc += (taps[i + FILTER_HALF_TAPS] ?? 0) * (samples[at] ?? 0);
    }
    out[o] = acc;
  }
  return out;
}

function checkOptions(o: Required<F0Options>, rate: number): void {
  if (!(rate > 0)) throw new Error('the sample rate must be above 0');
  if (!(o.minHz > 0 && o.maxHz > o.minHz)) throw new Error('minHz must be above 0 and below maxHz');
  if (!(o.maxHz < rate / 4)) throw new Error('maxHz must be below a quarter of the sample rate');
  if (!(o.hopSec > 0 && o.windowSec > 0)) throw new Error('hopSec and windowSec must be above 0');
  if (!(o.threshold > 0 && o.voicingThreshold >= o.threshold)) {
    throw new Error('threshold must be above 0 and voicingThreshold at least threshold');
  }
}

/** Estimates the fundamental of every frame of `samples` (mono, -1..1) at `sampleRateHz`. */
export function estimateF0(samples: Float64Array, sampleRateHz: number, options: F0Options = {}): F0Track {
  const o: Required<F0Options> = { ...DEFAULTS, ...options };
  checkOptions(o, sampleRateHz);
  const factor = Math.max(1, Math.floor(sampleRateHz / MIN_ANALYSIS_RATE_HZ));
  const x = decimate(samples, factor);
  const rate = sampleRateHz / factor;
  const w = Math.max(2, Math.round(o.windowSec * rate));
  const tauMin = Math.max(2, Math.floor(rate / o.maxHz));
  const tauMax = Math.ceil(rate / o.minHz);
  const silence = 10 ** (o.silenceDbfs / 20);

  // Prefix sums of squares: the energy of any run of samples in O(1).
  const energy = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) energy[i + 1] = (energy[i] ?? 0) + (x[i] ?? 0) ** 2;
  const energyOf = (from: number, count: number) => (energy[from + count] ?? 0) - (energy[from] ?? 0);

  const frameCount = Math.floor(samples.length / sampleRateHz / o.hopSec) + 1;
  const hz: (number | null)[] = [];
  const aperiodicity: number[] = [];
  const d = new Float64Array(tauMax + 2);
  const cmnd = new Float64Array(tauMax + 2);
  for (let k = 0; k < frameCount; k++) {
    const start = Math.round(k * o.hopSec * rate) - (w >> 1);
    if (start < 0 || start + w + tauMax + 1 > x.length) {
      hz.push(null);
      aperiodicity.push(1);
      continue;
    }
    const e0 = energyOf(start, w);
    if (Math.sqrt(e0 / w) < silence) {
      hz.push(null);
      aperiodicity.push(1);
      continue;
    }
    // Step 2, as d(tau) = e(0) + e(tau) - 2 r(tau).
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let r = 0;
      for (let j = 0; j < w; j++) r += (x[start + j] ?? 0) * (x[start + j + tau] ?? 0);
      d[tau] = Math.max(0, e0 + energyOf(start + tau, w) - 2 * r);
    }
    // Step 3.
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      running += d[tau] ?? 0;
      cmnd[tau] = running > 0 ? ((d[tau] ?? 0) * tau) / running : 1;
    }
    // Step 4, with the threshold taken relative to the deepest dip (see the top of the file): the
    // first dip that comes within `threshold` of the deepest one, followed down to its minimum.
    let deepest = tauMin;
    for (let tau = tauMin + 1; tau <= tauMax; tau++) if ((cmnd[tau] ?? 1) < (cmnd[deepest] ?? 1)) deepest = tau;
    const accept = (cmnd[deepest] ?? 1) + o.threshold;
    let best = deepest;
    for (let tau = tauMin; tau < deepest; tau++) {
      if ((cmnd[tau] ?? 1) <= accept) {
        while (tau + 1 <= tauMax && (cmnd[tau + 1] ?? 1) < (cmnd[tau] ?? 1)) tau++;
        best = tau;
        break;
      }
    }
    const value = cmnd[best] ?? 1;
    aperiodicity.push(value);
    if (value > o.voicingThreshold) {
      hz.push(null);
      continue;
    }
    // Step 5: the vertex of the parabola through the minimum and its neighbours.
    const a = cmnd[best - 1] ?? value;
    const c = cmnd[best + 1] ?? value;
    const curvature = a - 2 * value + c;
    const shift = curvature > 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * curvature))) : 0;
    hz.push(rate / (best + shift));
  }
  return { hopSec: o.hopSec, hz, aperiodicity };
}
