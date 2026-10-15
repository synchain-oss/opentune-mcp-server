// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Pitch statistics over notes and a detected pitch curve: how far each note's detected pitch is from
// its target, how steady it is, how it starts and ends, which notes exceed a threshold, and how the
// notes group into phrases. Pure functions over plain data. Segmentation is not done here: the notes
// come from OpenTune (content.getNotes or content.segmentNotes), this module only measures them.
//
// Pitch values are MIDI numbers at the content's tuningHz (OTCP reports them that way), so a
// difference of two of them in cents does not depend on tuningHz. Every deviation is
// detected minus target: positive means the singer is sharp of the target.

/** Cents in one semitone. */
const CENTS_PER_SEMITONE = 100;

/** Gap of silence between two notes, in seconds, above which a new phrase starts. */
export const PHRASE_GAP_SEC = 0.4;
/** Length of the onset and of the release window of a note, in seconds (shortened for short notes). */
export const EDGE_WINDOW_SEC = 0.1;
/** Default and largest accepted threshold for "this note is off", in cents. */
export const DEFAULT_THRESHOLD_CENTS = 25;
export const MAX_THRESHOLD_CENTS = 1200;
/** How many of the worst notes the overall summary lists. */
export const WORST_NOTE_COUNT = 5;

/** A note to measure: `index` is the OpenTune note index, null for a segment that is not a stored note. */
export interface NoteSpan {
  readonly index: number | null;
  readonly startContentSec: number;
  readonly endContentSec: number;
  readonly targetMidi: number;
}

/** The detected pitch, one value per frame, null where unvoiced. Frame k lies at startContentSec + k * frameSec. */
export interface PitchFrames {
  readonly startContentSec: number;
  readonly frameSec: number;
  readonly midi: readonly (number | null)[];
}

export interface NoteStat {
  readonly index: number | null;
  readonly startContentSec: number;
  readonly endContentSec: number;
  readonly targetMidi: number;
  readonly voicedFrameCount: number;
  /** Median of detected minus target over the voiced frames; null when no frame is voiced. */
  readonly medianDeviationCents: number | null;
  /** Standard deviation of the frame deviations around their mean: small is steady, vibrato raises it. */
  readonly stabilityCents: number | null;
  readonly onsetDeviationCents: number | null;
  readonly releaseDeviationCents: number | null;
  readonly overThreshold: boolean;
}

export interface PhraseStat {
  /** Position in the phrase list, from 0. */
  readonly phrase: number;
  readonly startContentSec: number;
  readonly endContentSec: number;
  readonly noteCount: number;
  readonly firstNoteIndex: number | null;
  readonly lastNoteIndex: number | null;
  readonly meanAbsDeviationCents: number | null;
  readonly overThresholdCount: number;
  /** The note of the phrase with the largest absolute deviation. */
  readonly worstNoteIndex: number | null;
}

export interface OverallStat {
  readonly noteCount: number;
  /** Notes with at least one voiced frame; the other statistics are over these. */
  readonly measuredNoteCount: number;
  readonly meanAbsDeviationCents: number | null;
  readonly meanSignedDeviationCents: number | null;
  readonly meanStabilityCents: number | null;
  readonly overThresholdCount: number;
  readonly overThresholdRatio: number | null;
  readonly worstNotes: readonly NoteStat[];
}

const round = (value: number, places = 2): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;

function standardDeviation(values: readonly number[]): number | null {
  const centre = mean(values);
  if (centre === null) return null;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - centre) ** 2, 0) / values.length);
}

/** Frame deviations in cents of one note, with the time of each frame; unvoiced frames are left out. */
function noteFrames(note: NoteSpan, frames: PitchFrames): { timeSec: number; cents: number }[] {
  if (!(frames.frameSec > 0)) return [];
  const eps = 1e-9;
  const first = Math.max(0, Math.ceil((note.startContentSec - frames.startContentSec) / frames.frameSec - eps));
  const out: { timeSec: number; cents: number }[] = [];
  for (let k = first; k < frames.midi.length; k += 1) {
    const timeSec = frames.startContentSec + k * frames.frameSec;
    if (timeSec >= note.endContentSec - eps) break;
    const midi = frames.midi[k];
    if (midi !== null && midi !== undefined) {
      out.push({ timeSec, cents: (midi - note.targetMidi) * CENTS_PER_SEMITONE });
    }
  }
  return out;
}

/** Measures every note against the curve. The result keeps the order of `notes`. */
export function measureNotes(notes: readonly NoteSpan[], frames: PitchFrames, thresholdCents: number): NoteStat[] {
  return notes.map((note) => {
    const points = noteFrames(note, frames);
    const all = points.map((p) => p.cents);
    const window = Math.min(EDGE_WINDOW_SEC, (note.endContentSec - note.startContentSec) / 2);
    const onset = points.filter((p) => p.timeSec < note.startContentSec + window).map((p) => p.cents);
    const release = points.filter((p) => p.timeSec >= note.endContentSec - window).map((p) => p.cents);
    const centre = median(all);
    const stability = standardDeviation(all);
    const onsetCents = median(onset);
    const releaseCents = median(release);
    return {
      index: note.index,
      startContentSec: note.startContentSec,
      endContentSec: note.endContentSec,
      targetMidi: note.targetMidi,
      voicedFrameCount: points.length,
      medianDeviationCents: centre === null ? null : round(centre),
      stabilityCents: stability === null ? null : round(stability),
      onsetDeviationCents: onsetCents === null ? null : round(onsetCents),
      releaseDeviationCents: releaseCents === null ? null : round(releaseCents),
      overThreshold: centre !== null && Math.abs(centre) > thresholdCents,
    };
  });
}

const absDeviation = (stat: NoteStat): number => Math.abs(stat.medianDeviationCents ?? 0);

/** Groups notes into phrases: a gap of more than PHRASE_GAP_SEC between two notes starts a new one. */
export function groupPhrases(stats: readonly NoteStat[]): PhraseStat[] {
  const ordered = [...stats].sort((a, b) => a.startContentSec - b.startContentSec);
  const groups: NoteStat[][] = [];
  let reach = -Infinity;
  for (const stat of ordered) {
    if (groups.length === 0 || stat.startContentSec - reach > PHRASE_GAP_SEC) groups.push([]);
    groups[groups.length - 1]?.push(stat);
    reach = Math.max(reach, stat.endContentSec);
  }
  return groups.map((group, phrase) => {
    const measured = group.filter((s) => s.medianDeviationCents !== null);
    const mad = mean(measured.map(absDeviation));
    const worst = measured.reduce<NoteStat | null>(
      (best, s) => (best === null || absDeviation(s) > absDeviation(best) ? s : best),
      null,
    );
    return {
      phrase,
      startContentSec: Math.min(...group.map((s) => s.startContentSec)),
      endContentSec: Math.max(...group.map((s) => s.endContentSec)),
      noteCount: group.length,
      firstNoteIndex: group[0]?.index ?? null,
      lastNoteIndex: group[group.length - 1]?.index ?? null,
      meanAbsDeviationCents: mad === null ? null : round(mad),
      overThresholdCount: group.filter((s) => s.overThreshold).length,
      worstNoteIndex: worst?.index ?? null,
    };
  });
}

export function summarize(stats: readonly NoteStat[]): OverallStat {
  const measured = stats.filter((s) => s.medianDeviationCents !== null);
  const abs = mean(measured.map(absDeviation));
  const signed = mean(measured.map((s) => s.medianDeviationCents ?? 0));
  const steady = mean(measured.map((s) => s.stabilityCents ?? 0));
  const over = measured.filter((s) => s.overThreshold).length;
  return {
    noteCount: stats.length,
    measuredNoteCount: measured.length,
    meanAbsDeviationCents: abs === null ? null : round(abs),
    meanSignedDeviationCents: signed === null ? null : round(signed),
    meanStabilityCents: steady === null ? null : round(steady),
    overThresholdCount: over,
    overThresholdRatio: measured.length === 0 ? null : round(over / measured.length, 4),
    worstNotes: [...measured].sort((a, b) => absDeviation(b) - absDeviation(a)).slice(0, WORST_NOTE_COUNT),
  };
}
