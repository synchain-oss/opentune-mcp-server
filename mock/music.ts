// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The mock's stand-in for pitch analysis: a synthetic detected pitch curve that is a pure function
// of content time, a note segmentation of it, and the corrected curve that follows the notes. It
// is deliberately simple and deterministic; it only has to behave consistently, not sound right.

export const TUNING_HZ = 440;
/** Analysis frame length in seconds (reported as `hopSec`). */
export const HOP_SEC = 0.01;
/** Default note-split sensitivity of the note generator, in cents. */
export const DEFAULT_NOTE_SPLIT_CENTS = 100;

/** A tune in C major, one pitch per phrase. */
const MELODY = [64, 67, 69, 67, 65, 62, 60, 64] as const;
const PHRASE_SEC = 0.8;
const VOICED_SEC = 0.7;
/** Segments shorter than this many frames are not notes. */
const MIN_NOTE_FRAMES = 5;
/** Frames that must deviate before a segment is split. */
const SPLIT_FRAMES = 3;

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** `A4` for MIDI 69. */
export function noteName(midi: number): string {
  const rounded = Math.round(midi);
  return `${NOTE_NAMES[((rounded % 12) + 12) % 12] ?? '?'}${String(Math.floor(rounded / 12) - 1)}`;
}

/** Frames of a content of `durationSec` seconds. */
export const frameCount = (durationSec: number): number => Math.ceil(durationSec / HOP_SEC - 1e-9);

/**
 * The detected pitch at frame `index` as a MIDI number, or null for an unvoiced frame. Odd phrases
 * hold their pitch for half the phrase and then go up a semitone and a half; a small vibrato rides on all.
 */
export function detectedMidiAt(index: number, durationSec: number): number | null {
  const t = index * HOP_SEC;
  if (index < 0 || t >= durationSec) return null;
  const phrase = Math.floor(t / PHRASE_SEC + 1e-9);
  const local = t - phrase * PHRASE_SEC;
  if (local >= VOICED_SEC - 1e-9) return null;
  const base = MELODY[phrase % MELODY.length] ?? 60;
  const step = phrase % 2 === 1 && local >= VOICED_SEC / 2 ? 1.5 : 0;
  return base + step + 0.12 * Math.sin(2 * Math.PI * 5.5 * t);
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export interface Segment {
  readonly startContentSec: number;
  readonly endContentSec: number;
  readonly detectedMidi: number;
}

/** First frame of a content time (the frame whose start is not before it). */
export const frameAtOrAfter = (sec: number): number => Math.max(0, Math.ceil(sec / HOP_SEC - 1e-9));

/** The median detected pitch over [startContentSec, endContentSec), or null when no frame is voiced. */
export function medianDetected(durationSec: number, startContentSec: number, endContentSec: number): number | null {
  const values: number[] = [];
  for (let i = frameAtOrAfter(startContentSec); i * HOP_SEC < endContentSec - 1e-9; i++) {
    const midi = detectedMidiAt(i, durationSec);
    if (midi !== null) values.push(midi);
  }
  return values.length === 0 ? null : median(values);
}

/**
 * Splits the detected pitch into notes: a run of voiced frames ends at an unvoiced frame, and
 * within a run a new segment starts once the pitch has stayed more than `splitCents` away from the
 * median of the segment for a few frames.
 */
export function segmentDetected(durationSec: number, splitCents: number): Segment[] {
  const segments: Segment[] = [];
  const total = frameCount(durationSec);
  let values: number[] = [];
  let first = 0;
  let deviant = 0;
  const close = (endFrame: number) => {
    if (values.length >= MIN_NOTE_FRAMES) {
      segments.push({
        startContentSec: first * HOP_SEC,
        endContentSec: endFrame * HOP_SEC,
        detectedMidi: median(values),
      });
    }
    values = [];
    deviant = 0;
  };
  for (let i = 0; i <= total; i++) {
    const midi = i < total ? detectedMidiAt(i, durationSec) : null;
    if (midi === null) {
      close(i);
      continue;
    }
    if (values.length === 0) first = i;
    if (values.length >= MIN_NOTE_FRAMES && Math.abs(midi - median(values)) * 100 > splitCents) {
      deviant++;
      if (deviant >= SPLIT_FRAMES) {
        // The split lies where the deviation began; the frames since then start the next segment.
        const keep = values.length - (deviant - 1);
        const tail = values.slice(keep);
        values = values.slice(0, keep);
        close(first + keep);
        first = i - (deviant - 1);
        values = [...tail, midi];
        deviant = 0;
        continue;
      }
    } else {
      deviant = 0;
    }
    values.push(midi);
  }
  return segments;
}

/** The pitch classes of each scale a key can name, counted up from its root. */
export const SCALES: Readonly<Record<string, readonly number[]>> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  pentatonicMajor: [0, 2, 4, 7, 9],
  pentatonicMinor: [0, 3, 5, 7, 10],
};

/** The pitch of the key's scale nearest to `midi`; an exact tie goes up. */
export function nearestInScale(midi: number, key: { root: number; scale: string }): number {
  const degrees = SCALES[key.scale] ?? SCALES.chromatic ?? [];
  let best = Number.NaN;
  let bestDistance = Infinity;
  for (let candidate = Math.floor(midi) - 12; candidate <= Math.ceil(midi) + 12; candidate++) {
    if (!degrees.includes((((candidate - key.root) % 12) + 12) % 12)) continue;
    const distance = Math.abs(candidate - midi);
    if (distance < bestDistance - 1e-9 || (Math.abs(distance - bestDistance) <= 1e-9 && candidate > best)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
