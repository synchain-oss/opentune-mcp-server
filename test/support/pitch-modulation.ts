// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Measurements on the pitch track of one note (the F0 values of test/support/f0-estimator.ts, one per
// frame): how much it wavers and at what rate. The effects scenario (test/e2e/effects.ts) uses them
// for the vibrato and the pitch drift of a rendered note, where the question is not which pitch the
// note is at, but whether its pitch moves, how far and how fast.

import { centsBetween, median } from './f0-estimator.js';

/** A track of per-frame cents, frame distance hopSec. */
export interface Contour {
  readonly hopSec: number;
  /** Cents from the median pitch of the track, one value per frame. */
  readonly cents: readonly number[];
  /** Frames that were unvoiced in the track and filled in by interpolation. */
  readonly filled: number;
}

/**
 * The cents of an F0 track (Hz per frame, null where unvoiced) around its median. Unvoiced frames
 * are filled in by linear interpolation between their voiced neighbours (the ends take the nearest
 * voiced value) so that the track stays evenly spaced; null when no frame is voiced or the unvoiced
 * share is above `maxUnvoiced` (a track with that many holes says nothing about the movement of the pitch).
 */
export function contourOf(hz: readonly (number | null)[], hopSec: number, maxUnvoiced = 0.1): Contour | null {
  const voiced = hz.filter((v): v is number => v !== null);
  if (voiced.length === 0 || hz.length - voiced.length > maxUnvoiced * hz.length) return null;
  const mid = median(voiced);
  const cents: number[] = hz.map((v) => (v === null ? Number.NaN : centsBetween(mid, v)));
  let filled = 0;
  for (let i = 0; i < cents.length; i++) {
    if (!Number.isNaN(cents[i])) continue;
    filled++;
    let before = i - 1;
    while (before >= 0 && Number.isNaN(cents[before])) before--;
    let after = i + 1;
    while (after < cents.length && Number.isNaN(cents[after])) after++;
    const a = before >= 0 ? cents[before] : undefined;
    const b = after < cents.length ? cents[after] : undefined;
    if (a !== undefined && b !== undefined) cents[i] = a + ((b - a) * (i - before)) / (after - before);
    else cents[i] = a ?? b ?? 0;
  }
  return { hopSec, cents, filled };
}

/** The values with their least-squares line removed (the mean too). */
export function detrend(values: readonly number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, v) => sum + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const [i, v] of values.entries()) {
    sxy += (i - meanX) * (v - meanY);
    sxx += (i - meanX) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return values.map((v, i) => v - meanY - slope * (i - meanX));
}

/** Standard deviation (population) of the values around their mean. */
export function stdDev(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
}

/** How far the pitch wavers once a straight drift is taken out: standard deviation and peak to peak, in cents. */
export function spreadOf(contour: Contour): { stdCents: number; peakToPeakCents: number } {
  const flat = detrend(contour.cents);
  if (flat.length === 0) return { stdCents: 0, peakToPeakCents: 0 };
  return { stdCents: stdDev(flat), peakToPeakCents: Math.max(...flat) - Math.min(...flat) };
}

export interface Modulation {
  /** Frequency of the strongest periodic movement of the pitch, in Hz (interpolated between scan steps). */
  readonly rateHz: number;
  /** Its amplitude (zero to peak) in cents. */
  readonly amplitudeCents: number;
  /** Standard deviation of the detrended pitch, in cents. */
  readonly stdCents: number;
  /**
   * The share of the pitch's variance that this one movement explains, 0 to 1: close to 1 for a
   * steady vibrato, small for noise or an irregular wander.
   */
  readonly varianceShare: number;
}

/** The scan of the strongest periodic movement: from 2.5 to 13 Hz (vibrato is 3 to 12 Hz), in steps of 0.02 Hz. */
const SCAN_MIN_HZ = 2.5;
const SCAN_MAX_HZ = 13;
const SCAN_STEP_HZ = 0.02;

/**
 * The strongest periodic movement of a contour between 2.5 and 13 Hz: the contour is detrended
 * (a straight line removed, so a slow drift does not pass for a vibrato), windowed (Hann) and
 * correlated with a sinusoid at each frequency of a fine scan; the peak gives rate and amplitude.
 */
export function modulationOf(contour: Contour): Modulation {
  const flat = detrend(contour.cents);
  const n = flat.length;
  const std = stdDev(flat);
  if (n < 8 || std === 0) return { rateHz: 0, amplitudeCents: 0, stdCents: std, varianceShare: 0 };
  const window = flat.map((_, i) => 0.5 * (1 - Math.cos((2 * Math.PI * (i + 0.5)) / n)));
  const windowSum = window.reduce((sum, w) => sum + w, 0);
  const amplitudeAt = (hz: number): number => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const phase = 2 * Math.PI * hz * i * contour.hopSec;
      const x = (flat[i] ?? 0) * (window[i] ?? 0);
      re += x * Math.cos(phase);
      im -= x * Math.sin(phase);
    }
    return (2 * Math.hypot(re, im)) / windowSum;
  };
  const count = Math.round((SCAN_MAX_HZ - SCAN_MIN_HZ) / SCAN_STEP_HZ);
  const amplitudes: number[] = [];
  for (let k = 0; k <= count; k++) amplitudes.push(amplitudeAt(SCAN_MIN_HZ + k * SCAN_STEP_HZ));
  let best = 0;
  for (const [k, a] of amplitudes.entries()) if (a > (amplitudes[best] ?? 0)) best = k;
  // Parabolic interpolation around the peak.
  const left = amplitudes[best - 1];
  const here = amplitudes[best] ?? 0;
  const right = amplitudes[best + 1];
  let offset = 0;
  if (left !== undefined && right !== undefined) {
    const denominator = left - 2 * here + right;
    if (denominator < 0) offset = (0.5 * (left - right)) / denominator;
  }
  const amplitude = here;
  return {
    rateHz: SCAN_MIN_HZ + (best + offset) * SCAN_STEP_HZ,
    amplitudeCents: amplitude,
    stdCents: std,
    varianceShare: Math.min(1, amplitude ** 2 / 2 / (std * std)),
  };
}
