// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Key estimation from pitch-class evidence: key profiles, the correlation of a 12-bin pitch-class
// vector with each of the 24 major and minor keys, the weighted fusion of several sources into key
// probabilities, the tuning offset of a pitch track, the pitch-class histogram of sung notes, and
// the segmentation of a song into local keys (a 24-state Viterbi path). Pure functions over plain
// data, written from the published methods (Krumhansl-style template matching, Temperley's
// profiles, circular-mean tuning); no code of any other key detector is used.
//
// Pitch classes count from C: 0 = C, 1 = C sharp ... 11 = B. A key index is root for major keys
// (0..11) and 12 + root for minor keys (12..23).

import { PHRASE_GAP_SEC } from './pitch.js';

export type Mode = 'major' | 'minor';

export interface KeyRef {
  readonly root: number;
  readonly scale: Mode;
}

/**
 * Key profiles from Temperley's Kostka-Payne corpus statistics (Music and Probability, 2007): how
 * often each scale degree occurs, from the tonic up. In the minor profile the flat seventh is raised
 * to the weight of the leading tone, because popular music in minor uses the natural seventh at
 * least as often as the raised one.
 */
export const PROFILES: Readonly<Record<Mode, readonly number[]>> = {
  major: [0.748, 0.06, 0.488, 0.082, 0.67, 0.46, 0.096, 0.715, 0.104, 0.366, 0.057, 0.4],
  minor: [0.712, 0.084, 0.474, 0.618, 0.049, 0.46, 0.105, 0.747, 0.404, 0.067, 0.33, 0.33],
};

/** Base weights of the sources, adjusted by their reliability (mix chroma, bass chroma, vocal notes). */
export const BASE_WEIGHTS = { mix: 0.6, bass: 0.2, vocals: 0.2 } as const;
export type SourceName = keyof typeof BASE_WEIGHTS;

/** Inverse temperature of the softmax over fused correlations, for fully reliable evidence. */
export const BETA = 16;
/** Weight of the vocal check of the three best keys (the share of sung time inside each key's scale). */
export const VOCAL_CHECK_WEIGHT = 1;
/** Below this tonic confidence the best key and its relative key are reported as one scale set. */
export const TONIC_CLEAR = 0.75;
/** Below this scale-set confidence the recommendation falls back to chromatic. */
export const SCALE_SET_SURE = 0.6;
/** Width of the pitch-class kernel, in semitones (a cosine-squared bump). */
export const KERNEL_SEMITONES = 4 / 3;

const SCALE_STEPS: ReadonlyMap<string, readonly number[]> = new Map([
  ['major', [0, 2, 4, 5, 7, 9, 11]],
  ['minor', [0, 2, 3, 5, 7, 8, 10]],
  ['harmonicMinor', [0, 2, 3, 5, 7, 8, 11]],
  ['dorian', [0, 2, 3, 5, 7, 9, 10]],
  ['mixolydian', [0, 2, 4, 5, 7, 9, 10]],
  ['pentatonicMajor', [0, 2, 4, 7, 9]],
  ['pentatonicMinor', [0, 3, 5, 7, 10]],
  ['chromatic', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
]);

const NAMES: Readonly<Record<Mode, readonly string[]>> = {
  major: ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'],
  minor: ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'],
};

/** Element `i` of a vector, 0 beyond its end. */
export const at = (vector: ArrayLike<number>, i: number): number => vector[i] ?? 0;
const pc = (value: number): number => ((Math.round(value) % 12) + 12) % 12;
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
export const round = (value: number, places = 3): number => Math.round(value * 10 ** places) / 10 ** places;

/** Index of the largest element (the first of equal ones). */
export const argmax = (vector: ArrayLike<number>): number =>
  Array.from(vector).reduce((best, v, i) => (v > at(vector, best) ? i : best), 0);

export const keyOf = (index: number): KeyRef => ({ root: index % 12, scale: index < 12 ? 'major' : 'minor' });
export const indexOf = (key: KeyRef): number => (key.scale === 'major' ? 0 : 12) + pc(key.root);

/** The usual spelling: E-flat major is "Eb major", its relative minor "C minor". */
export const keyName = (key: KeyRef): string => `${String(NAMES[key.scale][pc(key.root)])} ${key.scale}`;

/** The key with the same seven notes: C major and A minor are relative keys. */
export const relativeIndex = (index: number): number => (index < 12 ? 12 + ((index + 9) % 12) : (index + 3) % 12);

/** The pitch classes of a scale on a root, or null for a scale name this module does not know. */
export function scalePitchClasses(root: number, scale: string): number[] | null {
  return SCALE_STEPS.get(scale)?.map((s) => pc(root + s)) ?? null;
}

/** Pearson correlation of two vectors over the length of `a` (`b` reads as 0 beyond its end); 0 when either is constant. */
export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const xs = Array.from(a);
  const ys = xs.map((_, i) => at(b, i));
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  xs.forEach((x, i) => {
    const dx = x - mx;
    const dy = at(ys, i) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  });
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** The profile of key `index`, laid out by absolute pitch class. */
function rotated(index: number): number[] {
  const { root, scale } = keyOf(index);
  return Array.from({ length: 12 }, (_, p) => at(PROFILES[scale], (p - root + 12) % 12));
}
const ROTATED = Array.from({ length: 24 }, (_, i) => rotated(i));

/** Correlation of a pitch-class vector with every key: 24 values in key-index order. */
export function keyCorrelations(vector: ArrayLike<number>): Float64Array {
  return Float64Array.from(ROTATED, (profile) => pearson(vector, profile));
}

export function softmax(scores: ArrayLike<number>, beta: number): Float64Array {
  const max = Math.max(...Array.from(scores));
  const out = Float64Array.from(Array.from(scores), (s) => Math.exp(beta * (s - max)));
  const sum = out.reduce((s, v) => s + v, 0);
  return out.map((v) => v / sum);
}

/** Share of a pitch-class histogram that lies inside the scale of key `index`. */
export function inScaleShare(histogram: ArrayLike<number>, index: number): number {
  const { root, scale } = keyOf(index);
  const inside = new Set(scalePitchClasses(root, scale));
  const values = Array.from({ length: 12 }, (_, p) => at(histogram, p));
  const total = values.reduce((s, v) => s + v, 0);
  const part = values.reduce((s, v, p) => (inside.has(p) ? s + v : s), 0);
  return total > 0 ? part / total : 0;
}

export interface SourceEvidence {
  readonly name: SourceName;
  /** A 12-bin pitch-class vector. */
  readonly vector: ArrayLike<number>;
  /** 0..1: how much the source can be trusted (amount of material, presence of a bass line). */
  readonly reliability: number;
}

export interface KeyEstimate {
  /** Probability of each of the 24 keys, in key-index order. */
  readonly probabilities: Float64Array;
  /** Key indexes from the most to the least probable. */
  readonly order: readonly number[];
  /** Probability that the best key's seven notes are right: the best key plus its relative key. */
  readonly scaleSetConfidence: number;
  /** Share of the best key within its scale set: 0.5 = cannot tell it from the relative key, 1 = certain. */
  readonly tonicConfidence: number;
  /** Effective weight of each source; 0 for a source that did not take part. */
  readonly weights: Readonly<Record<SourceName, number>>;
}

/** A vector that is not all equal, with something above zero. */
const hasSignal = (vector: ArrayLike<number>): boolean => {
  const values = Array.from(vector);
  const max = Math.max(...values);
  return max > 0 && max > Math.min(...values);
};

/** Key indexes from the highest to the lowest score. */
const ranked = (scores: ArrayLike<number>): number[] =>
  Array.from({ length: scores.length }, (_, k) => k).sort((a, b) => at(scores, b) - at(scores, a));

/**
 * Fuses the sources: S(k) = sum of w_s * r_s(k) over the sources, w_s the base weight times the
 * reliability (normalized), r_s the correlation with key k. When the vocals take part next to the mix,
 * they check the three best keys: a key whose scale leaves out more of the sung time loses score,
 * which corrects the dominant and the parallel-minor confusions of the mix (it cannot separate
 * relative keys, which share their notes). Probabilities are a softmax whose sharpness follows the
 * weighted reliability. Null when no source has usable evidence.
 */
export function estimateKey(sources: readonly SourceEvidence[]): KeyEstimate | null {
  const usable = sources
    .filter((s) => s.reliability > 0 && hasSignal(s.vector))
    .map((s) => ({ ...s, raw: BASE_WEIGHTS[s.name] * clamp01(s.reliability) }));
  if (usable.length === 0) return null;
  const base = usable.reduce((sum, s) => sum + BASE_WEIGHTS[s.name], 0);
  const total = usable.reduce((sum, s) => sum + s.raw, 0);
  const weights: Record<SourceName, number> = { mix: 0, bass: 0, vocals: 0 };
  const scores = new Float64Array(24);
  for (const source of usable) {
    const w = source.raw / total;
    weights[source.name] += w;
    keyCorrelations(source.vector).forEach((r, k) => (scores[k] = at(scores, k) + w * r));
  }
  const vocals = usable.find((s) => s.name === 'vocals');
  if (vocals !== undefined && weights.mix > 0) {
    const checked = ranked(scores)
      .slice(0, 3)
      .map((k) => ({ k, share: inScaleShare(vocals.vector, k) }));
    const best = Math.max(...checked.map((c) => c.share));
    for (const { k, share } of checked) {
      scores[k] = at(scores, k) + VOCAL_CHECK_WEIGHT * clamp01(vocals.reliability) * (share - best);
    }
  }
  const probabilities = softmax(scores, (BETA * total) / base);
  const first = argmax(probabilities);
  const pFirst = at(probabilities, first);
  const scaleSet = pFirst + at(probabilities, relativeIndex(first));
  return {
    probabilities,
    order: ranked(probabilities),
    scaleSetConfidence: scaleSet,
    tonicConfidence: pFirst / scaleSet,
    weights,
  };
}

/** A pitch reading with a weight, as MIDI numbers at the reference tuning. */
export interface WeightedPitch {
  readonly midi: number;
  readonly weight: number;
}

export interface Tuning {
  /** Weighted circular mean of the distance to the nearest semitone, -50..50 cents. */
  readonly offsetCents: number;
  /** Length of the mean vector, 0..1: 1 when every reading has the same offset. */
  readonly reliability: number;
}

/** The tuning offset of pitch readings (circular mean over the semitone period); null without readings. */
export function tuningOffset(readings: Iterable<WeightedPitch>): Tuning | null {
  let c = 0;
  let s = 0;
  let w = 0;
  for (const { midi, weight } of readings) {
    c += weight * Math.cos(2 * Math.PI * midi);
    s += weight * Math.sin(2 * Math.PI * midi);
    w += weight;
  }
  if (!(w > 0)) return null;
  return { offsetCents: (Math.atan2(s, c) / (2 * Math.PI)) * 100, reliability: Math.hypot(c, s) / w };
}

/** Largest frame-to-frame change, in semitones over two frames, of a frame counted as steady. */
const STEADY_SEMITONES = 0.1;

/** The steady frames of a pitch track (both neighbours voiced, little movement), each with weight 1. */
export function steadyFrames(midi: readonly (number | null)[]): WeightedPitch[] {
  return midi.flatMap((here, k) => {
    const before = midi[k - 1];
    const after = midi[k + 1];
    return here != null && before != null && after != null && Math.abs(after - before) < STEADY_SEMITONES
      ? [{ midi: here, weight: 1 }]
      : [];
  });
}

/** A sung note or segment: its span in seconds and its detected pitch as a MIDI number. */
export interface PitchEvent {
  readonly startSec: number;
  readonly endSec: number;
  readonly midi: number;
}

/** Extra weight of the last note of a phrase, which tends to land on the tonic. */
export const PHRASE_END_WEIGHT = 1.5;

/** Adds `weight` at a fractional pitch class `position` with the cosine-squared kernel. */
export function addPitch(histogram: Float64Array, position: number, weight: number): void {
  const half = KERNEL_SEMITONES / 2;
  for (let j = Math.floor(position - half); j <= Math.ceil(position + half); j++) {
    const d = Math.abs(position - j);
    if (d < half) histogram[pc(j)] = at(histogram, pc(j)) + weight * Math.cos((Math.PI * d) / KERNEL_SEMITONES) ** 2;
  }
}

export interface VocalHistogram {
  readonly histogram: Float64Array;
  /** Sung seconds inside the range. */
  readonly seconds: number;
  readonly eventCount: number;
}

/**
 * The pitch-class histogram of sung notes inside [fromSec, toSec): each note counts with its
 * duration in the range, the last note of a phrase (a gap over PHRASE_GAP_SEC follows) with
 * PHRASE_END_WEIGHT times that, at its pitch minus the tuning offset.
 */
export function vocalHistogram(
  events: readonly PitchEvent[],
  offsetCents: number,
  fromSec = -Infinity,
  toSec = Infinity,
): VocalHistogram {
  const sorted = [...events].sort((a, b) => a.startSec - b.startSec);
  const histogram = new Float64Array(12);
  let seconds = 0;
  let eventCount = 0;
  sorted.forEach((event, i) => {
    const span = Math.min(event.endSec, toSec) - Math.max(event.startSec, fromSec);
    if (!(span > 0)) return;
    const next = sorted[i + 1];
    const phraseEnd = next === undefined || next.startSec - event.endSec > PHRASE_GAP_SEC;
    addPitch(histogram, event.midi - offsetCents / 100, span * (phraseEnd ? PHRASE_END_WEIGHT : 1));
    seconds += span;
    eventCount += 1;
  });
  return { histogram, seconds, eventCount };
}

/** Seconds of material at which a source counts as fully reliable. */
export const FULL_EVIDENCE_SEC = 20;

/** Reliability of the vocals: enough sung time, and more than a few distinct pitch classes. */
export function vocalReliability(vocal: VocalHistogram): number {
  const total = vocal.histogram.reduce((s, v) => s + v, 0);
  const distinct = vocal.histogram.filter((v) => v > 0 && v / total >= 0.03).length;
  return clamp01(vocal.seconds / FULL_EVIDENCE_SEC) * clamp01(distinct / 5);
}

/** Reliability of the mix: enough non-silent audio. */
export const mixReliability = (activeSec: number): number => clamp01(activeSec / FULL_EVIDENCE_SEC);

/** Reliability of the bass: the mix's, scaled by the share of frames that have a bass line. */
export const bassReliability = (activeSec: number, bassShare: number): number =>
  mixReliability(activeSec) * clamp01(bassShare / 0.5);

/** Steps between the key signatures of two keys on the circle of fifths, 0..6 (relative keys: 0). */
export function fifthsDistance(a: number, b: number): number {
  const major = (index: number) => (index < 12 ? index : (index + 3) % 12);
  const d = ((((major(a) - major(b)) * 7) % 12) + 12) % 12;
  return Math.min(d, 12 - d);
}

/** Log-score cost of a key change between two windows: a fixed part plus one per step of fifths. */
export const CHANGE_PENALTY = 8;
export const FIFTH_PENALTY = 1.5;
export const changeCost = (a: number, b: number): number =>
  a === b ? 0 : CHANGE_PENALTY + FIFTH_PENALTY * fifthsDistance(a, b);

const KEYS = Array.from({ length: 24 }, (_, k) => k);

/** The most likely key path through windows with the given log-scores (24 per window). */
export function viterbi(emissions: readonly ArrayLike<number>[]): number[] {
  const [first, ...rest] = emissions;
  if (first === undefined) return [];
  let score = Float64Array.from(KEYS, (k) => at(first, k));
  const back: number[][] = [];
  for (const emission of rest) {
    const prev = score;
    const from = KEYS.map((k) => argmax(Float64Array.from(KEYS, (j) => at(prev, j) - changeCost(j, k))));
    score = Float64Array.from(KEYS, (k) => at(prev, at(from, k)) - changeCost(at(from, k), k) + at(emission, k));
    back.push(from);
  }
  const path = [argmax(score)];
  for (const from of back.reverse()) path.unshift(at(from, at(path, 0)));
  return path;
}

export interface KeyWindow {
  readonly startSec: number;
  readonly endSec: number;
  /** The fused estimate of the window; null when the window has no evidence. */
  readonly estimate: KeyEstimate | null;
}

export interface KeySegment {
  readonly startSec: number;
  readonly endSec: number;
  readonly key: number;
  /** Mean probability of the segment key's scale set over its windows. */
  readonly scaleSetConfidence: number;
}

/**
 * Local keys: a Viterbi path through the windows (log-probabilities as emissions, a key change
 * costs changeCost), merged into segments. A window owns the time around its centre up to half
 * way to its neighbours; the first segment starts at 0 and the last ends at `durationSec`.
 */
export function segmentKeys(windows: readonly KeyWindow[], durationSec: number): KeySegment[] {
  const flat = new Float64Array(24);
  const path = viterbi(windows.map((w) => (w.estimate === null ? flat : w.estimate.probabilities.map(Math.log))));
  const centres = windows.map((w) => (w.startSec + w.endSec) / 2);
  const segments: { startSec: number; key: number; confidences: number[] }[] = [];
  let current: (typeof segments)[number] | undefined;
  windows.forEach((w, t) => {
    const key = at(path, t);
    if (current?.key !== key) {
      current = { startSec: t === 0 ? 0 : (at(centres, t - 1) + at(centres, t)) / 2, key, confidences: [] };
      segments.push(current);
    }
    if (w.estimate !== null) {
      current.confidences.push(at(w.estimate.probabilities, key) + at(w.estimate.probabilities, relativeIndex(key)));
    }
  });
  return segments.map((s, i) => ({
    startSec: s.startSec,
    endSec: segments[i + 1]?.startSec ?? durationSec,
    key: s.key,
    scaleSetConfidence:
      s.confidences.length === 0 ? 0 : s.confidences.reduce((a, b) => a + b, 0) / s.confidences.length,
  }));
}

/**
 * True when the flat seventh of a major key is clearly more present than its leading tone: the
 * music may be mixolydian, which a major key would snap wrongly.
 */
export function flatSeventhProminent(vector: ArrayLike<number>, index: number): boolean {
  if (index >= 12) return false;
  const max = Math.max(...Array.from({ length: 12 }, (_, p) => at(vector, p)));
  const flat = at(vector, (index + 10) % 12);
  return max > 0 && flat >= 0.3 * max && flat > 1.3 * at(vector, (index + 11) % 12);
}
