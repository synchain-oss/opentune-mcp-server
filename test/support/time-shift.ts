// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Time-shift estimate between two recordings of the same material, for the timing effects check of
// the end-to-end tests: how much later a section plays in one file than in the other. Pure TypeScript
// without dependencies; its error is pinned by test/unit/time-shift.test.ts.
//
// The estimate cross-correlates amplitude envelopes, not waveforms. The waveform of a sung note is
// nearly periodic, so its cross-correlation has a peak every period (about 2 to 10 ms for a voice) and
// the right one cannot be told apart; a re-synthesised file may also start the periods at another
// phase. The envelope has neither problem: its shape comes from the note starts and ends and the
// silence between them. The envelope is the RMS over a short window at a fine hop, and the peak of the
// normalised cross-correlation is refined by parabolic interpolation, which gives sub-hop precision.

export interface ShiftWindow {
  /** Start and end of the section in the reference file, in seconds. */
  readonly startSec: number;
  readonly endSec: number;
}

export interface ShiftOptions {
  /** Largest shift searched for, either way; 0.1 s unless given. */
  readonly maxLagSec?: number;
  /** Hop of the envelope; 0.5 ms unless given. */
  readonly hopSec?: number;
  /** RMS window of the envelope; 4 ms unless given. */
  readonly windowSec?: number;
}

export interface ShiftEstimate {
  /** How much later the section plays in `moved` than in `reference`; negative when earlier. */
  readonly lagSec: number;
  /** Normalised cross-correlation at that lag, -1..1: near 1 when the two envelopes have the same shape. */
  readonly peak: number;
}

const DEFAULTS = { maxLagSec: 0.1, hopSec: 0.0005, windowSec: 0.004 } as const;

/**
 * The error bound of this estimate with the default options, on generated tones delayed by a known
 * number of samples, also when the delayed copy starts its periods at another phase
 * (test/unit/time-shift.test.ts). Measured: within 0.04 ms for the same waveform, about 1 ms for a
 * copy at another phase, whose envelope differs a little where the note starts and ends.
 */
export const SHIFT_ERROR_SEC = 0.002;

/** The RMS envelope of `samples`: value i is the RMS of the window centred at i * hop samples. */
export function rmsEnvelope(samples: Float64Array, rate: number, hopSec: number, windowSec: number): Float64Array {
  const hop = hopSec * rate;
  const half = Math.max(1, Math.round((windowSec * rate) / 2));
  const squares = new Float64Array(samples.length + 1);
  for (let i = 0; i < samples.length; i++) squares[i + 1] = (squares[i] ?? 0) + (samples[i] ?? 0) ** 2;
  const count = Math.floor(samples.length / hop) + 1;
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const centre = Math.round(i * hop);
    const from = Math.max(0, centre - half);
    const to = Math.min(samples.length, centre + half);
    out[i] = to > from ? Math.sqrt(Math.max(0, (squares[to] ?? 0) - (squares[from] ?? 0)) / (to - from)) : 0;
  }
  return out;
}

/** Normalised cross-correlation of `a[from..to)` with `b` shifted by `lag` (zero mean, unit norm). */
function correlation(a: Float64Array, b: Float64Array, from: number, to: number, lag: number): number {
  let meanA = 0;
  let meanB = 0;
  const n = to - from;
  for (let i = from; i < to; i++) {
    meanA += a[i] ?? 0;
    meanB += b[i + lag] ?? 0;
  }
  meanA /= n;
  meanB /= n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = from; i < to; i++) {
    const x = (a[i] ?? 0) - meanA;
    const y = (b[i + lag] ?? 0) - meanB;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/**
 * Estimates how much later the section `window` of `reference` plays in `moved` (both mono, at
 * `rate`). Throws when the window, widened by the largest lag, does not fit in both files, or when
 * the section has no envelope to follow (silence or a constant level).
 */
export function estimateShift(
  reference: Float64Array,
  moved: Float64Array,
  rate: number,
  window: ShiftWindow,
  options: ShiftOptions = {},
): ShiftEstimate {
  const o = { ...DEFAULTS, ...options };
  if (!(o.hopSec > 0 && o.windowSec > 0 && o.maxLagSec > 0)) throw new Error('the options must be above 0');
  const a = rmsEnvelope(reference, rate, o.hopSec, o.windowSec);
  const b = rmsEnvelope(moved, rate, o.hopSec, o.windowSec);
  const from = Math.round(window.startSec / o.hopSec);
  const to = Math.round(window.endSec / o.hopSec);
  const maxLag = Math.round(o.maxLagSec / o.hopSec);
  if (!(to > from + 2) || from - maxLag < 0 || to + maxLag > Math.min(a.length, b.length)) {
    throw new Error('the window, widened by the largest lag, does not fit in both files');
  }
  const scores = new Float64Array(2 * maxLag + 1);
  let best = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const score = correlation(a, b, from, to, lag);
    scores[lag + maxLag] = score;
    if (score > (scores[best] ?? -Infinity)) best = lag + maxLag;
  }
  const peak = scores[best] ?? 0;
  if (peak === 0) throw new Error('the section has no envelope to follow');
  // Parabolic interpolation around the peak; none at the edge of the search range.
  let shift = 0;
  if (best > 0 && best < scores.length - 1) {
    const l = scores[best - 1] ?? peak;
    const r = scores[best + 1] ?? peak;
    const curvature = l - 2 * peak + r;
    if (curvature < 0) shift = Math.max(-0.5, Math.min(0.5, (l - r) / (2 * curvature)));
  }
  return { lagSec: (best - maxLag + shift) * o.hopSec, peak };
}
