// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// src/analysis/pitch.ts on synthetic pitch curves with known deviations: sharp and flat notes,
// tuningHz 440 and not 440, vibrato, unvoiced notes, phrase grouping by silence, empty curves.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THRESHOLD_CENTS,
  EDGE_WINDOW_SEC,
  PHRASE_GAP_SEC,
  WORST_NOTE_COUNT,
  groupPhrases,
  measureNotes,
  median,
  summarize,
  type NoteSpan,
  type PitchFrames,
} from '../../src/analysis/pitch.js';

const FRAME = 0.01;

/** A curve of `seconds` seconds where `pitch(t)` gives MIDI or null. */
function curve(seconds: number, pitch: (t: number) => number | null, startContentSec = 0): PitchFrames {
  const count = Math.round(seconds / FRAME);
  return {
    startContentSec,
    frameSec: FRAME,
    midi: Array.from({ length: count }, (_, k) => pitch(startContentSec + k * FRAME)),
  };
}

const note = (index: number, start: number, end: number, targetMidi: number): NoteSpan => ({
  index,
  startContentSec: start,
  endContentSec: end,
  targetMidi,
});

describe('measureNotes', () => {
  it('reports the known deviation of a sharp and a flat note, signed detected minus target', () => {
    const frames = curve(2, (t) => (t < 1 ? 60.3 : 64 - 0.2));
    const [sharp, flat] = measureNotes([note(0, 0, 1, 60), note(1, 1, 2, 64)], frames, DEFAULT_THRESHOLD_CENTS);
    expect(sharp?.medianDeviationCents).toBeCloseTo(30, 1);
    expect(sharp?.overThreshold).toBe(true);
    expect(sharp?.stabilityCents).toBeCloseTo(0, 5);
    expect(flat?.medianDeviationCents).toBeCloseTo(-20, 1);
    expect(flat?.overThreshold).toBe(false);
  });

  it('applies the threshold strictly: a note exactly at the threshold is not flagged', () => {
    const frames = curve(1, () => 60.25);
    const [at] = measureNotes([note(0, 0, 1, 60)], frames, 25);
    expect(at?.medianDeviationCents).toBe(25);
    expect(at?.overThreshold).toBe(false);
    expect(measureNotes([note(0, 0, 1, 60)], frames, 24)[0]?.overThreshold).toBe(true);
  });

  it('gives the same cents for any tuningHz because the curve is already in MIDI at that tuning', () => {
    // 432 Hz tuning: A4 sounds at 432 Hz; a note 20 cents sharp is 69.2 in MIDI at that tuning as well.
    const at440 = measureNotes(
      [note(0, 0, 1, 69)],
      curve(1, () => 69.2),
      25,
    )[0];
    const at432 = measureNotes(
      [note(0, 0, 1, 69)],
      curve(1, () => 69 + 20 / 100),
      25,
    )[0];
    expect(at432?.medianDeviationCents).toBe(at440?.medianDeviationCents);
    expect(at440?.medianDeviationCents).toBeCloseTo(20, 5);
  });

  it('finds a drift in the onset and release windows separately from the median', () => {
    // Scoops up into the pitch (flat at the start), holds, then falls off flat at the end.
    const frames = curve(1, (t) => 60 + (t < EDGE_WINDOW_SEC ? -0.4 : t >= 1 - EDGE_WINDOW_SEC ? -0.3 : 0));
    const [stat] = measureNotes([note(0, 0, 1, 60)], frames, 25);
    expect(stat?.medianDeviationCents).toBeCloseTo(0, 5);
    expect(stat?.onsetDeviationCents).toBeCloseTo(-40, 5);
    expect(stat?.releaseDeviationCents).toBeCloseTo(-30, 5);
  });

  it('shortens the edge windows of a short note to half its length', () => {
    const frames = curve(0.1, (t) => (t < 0.05 ? 60.2 : 60.4));
    const [stat] = measureNotes([note(0, 0, 0.1, 60)], frames, 25);
    expect(stat?.onsetDeviationCents).toBeCloseTo(20, 5);
    expect(stat?.releaseDeviationCents).toBeCloseTo(40, 5);
  });

  it('shows vibrato as stability, not as a median offset', () => {
    // 5.5 Hz vibrato of +-30 cents around the target over a whole number of cycles.
    const frames = curve(2, (t) => 60 + 0.3 * Math.sin(2 * Math.PI * 5.5 * t));
    const [stat] = measureNotes([note(0, 0, 2, 60)], frames, 25);
    expect(Math.abs(stat?.medianDeviationCents ?? 99)).toBeLessThan(2);
    expect(stat?.stabilityCents).toBeGreaterThan(18);
    expect(stat?.stabilityCents).toBeLessThan(24);
    expect(stat?.overThreshold).toBe(false);
  });

  it('leaves unvoiced frames out and reports null for a note without any voiced frame', () => {
    const frames = curve(2, (t) => (t < 0.5 ? null : t < 1 ? 60.1 : null));
    const [partly, silent] = measureNotes([note(0, 0, 1, 60), note(1, 1, 2, 60)], frames, 25);
    expect(partly?.voicedFrameCount).toBe(50);
    expect(partly?.medianDeviationCents).toBeCloseTo(10, 5);
    expect(silent?.voicedFrameCount).toBe(0);
    expect(silent).toMatchObject({
      medianDeviationCents: null,
      stabilityCents: null,
      onsetDeviationCents: null,
      releaseDeviationCents: null,
      overThreshold: false,
    });
  });

  it('reads the frames of a curve that does not start at zero, and ignores frames outside the note', () => {
    const frames = curve(1, (t) => (t < 5.5 ? 50 : 60.1), 5);
    const [stat] = measureNotes([note(3, 5.5, 6, 60)], frames, 25);
    expect(stat?.index).toBe(3);
    expect(stat?.medianDeviationCents).toBeCloseTo(10, 5);
    expect(stat?.voicedFrameCount).toBe(50);
  });

  it('handles an empty curve, no notes and a curve without a frame length', () => {
    expect(measureNotes([note(0, 0, 1, 60)], { startContentSec: 0, frameSec: FRAME, midi: [] }, 25)[0]).toMatchObject({
      voicedFrameCount: 0,
      medianDeviationCents: null,
    });
    expect(
      measureNotes(
        [],
        curve(1, () => 60),
        25,
      ),
    ).toEqual([]);
    expect(
      measureNotes([note(0, 0, 1, 60)], { startContentSec: 0, frameSec: 0, midi: [60] }, 25)[0]?.voicedFrameCount,
    ).toBe(0);
  });
});

describe('groupPhrases', () => {
  const frames = curve(10, () => 60.1);
  const stats = measureNotes(
    [note(0, 0, 1, 60), note(1, 1.2, 2, 60), note(2, 2 + PHRASE_GAP_SEC + 0.1, 3.5, 60), note(3, 3.5, 4, 60.5)],
    frames,
    25,
  );

  it('starts a new phrase after a silence longer than the gap constant', () => {
    const phrases = groupPhrases(stats);
    expect(phrases.map((p) => [p.firstNoteIndex, p.lastNoteIndex, p.noteCount])).toEqual([
      [0, 1, 2],
      [2, 3, 2],
    ]);
    expect(phrases[0]?.startContentSec).toBe(0);
    expect(phrases[1]?.endContentSec).toBe(4);
  });

  it('keeps notes together when the silence is exactly the gap, and when notes overlap', () => {
    const joined = groupPhrases(
      measureNotes([note(0, 0, 1, 60), note(1, 1 + PHRASE_GAP_SEC, 2, 60), note(2, 1.5, 1.8, 60)], frames, 25),
    );
    expect(joined).toHaveLength(1);
  });

  it('summarizes each phrase: mean absolute deviation, flagged count and worst note', () => {
    const [first, second] = groupPhrases(stats);
    expect(first?.meanAbsDeviationCents).toBeCloseTo(10, 5);
    expect(first?.overThresholdCount).toBe(0);
    expect(second?.overThresholdCount).toBe(1);
    expect(second?.worstNoteIndex).toBe(3);
    expect(second?.meanAbsDeviationCents).toBeCloseTo(25, 1);
  });

  it('orders phrases by time whatever the order of the notes, and tolerates notes without measurement', () => {
    const silent = measureNotes([note(7, 20, 21, 60)], { startContentSec: 0, frameSec: FRAME, midi: [] }, 25);
    const phrases = groupPhrases([...stats].reverse().concat(silent));
    expect(phrases[0]).toMatchObject({ phrase: 0, firstNoteIndex: 0 });
    expect(phrases.at(-1)).toMatchObject({ firstNoteIndex: 7, meanAbsDeviationCents: null });
    expect(phrases.at(-1)?.phrase).toBe(phrases.length - 1);
    const only = groupPhrases(silent);
    expect(only[0]).toMatchObject({ meanAbsDeviationCents: null, worstNoteIndex: null, overThresholdCount: 0 });
    expect(groupPhrases([])).toEqual([]);
  });
});

describe('summarize', () => {
  it('gives the mean absolute and signed deviation, the flagged ratio and the worst notes in order', () => {
    const offsets = [0, 10, -20, 40, -60, 5, 30];
    const frames = curve(offsets.length, (t) => 60 + (offsets[Math.floor(t + 1e-6)] ?? 0) / 100);
    const stats = measureNotes(
      offsets.map((_, i) => note(i, i, i + 1, 60)),
      frames,
      25,
    );
    const overall = summarize(stats);
    expect(overall.noteCount).toBe(7);
    expect(overall.meanAbsDeviationCents).toBeCloseTo(23.57, 1);
    expect(overall.meanSignedDeviationCents).toBeCloseTo(0.71, 1);
    expect(overall.overThresholdCount).toBe(3);
    expect(overall.overThresholdRatio).toBeCloseTo(3 / 7, 3);
    expect(overall.worstNotes).toHaveLength(WORST_NOTE_COUNT);
    expect(overall.worstNotes.map((n) => n.index)).toEqual([4, 3, 6, 2, 1]);
  });

  it('excludes unmeasured notes from the statistics and returns nulls when nothing was measured', () => {
    const silent = measureNotes([note(0, 0, 1, 60)], { startContentSec: 0, frameSec: FRAME, midi: [] }, 25);
    expect(summarize(silent)).toEqual({
      noteCount: 1,
      measuredNoteCount: 0,
      meanAbsDeviationCents: null,
      meanSignedDeviationCents: null,
      meanStabilityCents: null,
      overThresholdCount: 0,
      overThresholdRatio: null,
      correctedMeanAbsDeviationCents: null,
      correctedMeanSignedDeviationCents: null,
      correctedMeanStabilityCents: null,
      correctedOverThresholdCount: null,
      correctedOverThresholdRatio: null,
      worstNotes: [],
    });
    const mixed = summarize([
      ...silent,
      ...measureNotes(
        [note(1, 0, 1, 60)],
        curve(1, () => 60.1),
        25,
      ),
    ]);
    expect(mixed).toMatchObject({ noteCount: 2, measuredNoteCount: 1, meanAbsDeviationCents: 10 });
  });
});

describe('corrected pitch', () => {
  const frames = curve(1, () => 60.3);

  it('measures the corrected curve against the same targets, next to the detected one', () => {
    const [stat] = measureNotes(
      [note(0, 0, 1, 60)],
      frames,
      25,
      curve(1, () => 60.1),
    );
    expect(stat).toMatchObject({
      medianDeviationCents: 30,
      overThreshold: true,
      correctedMedianDeviationCents: 10,
      correctedStabilityCents: 0,
      correctedOverThreshold: false,
    });
  });

  it('leaves the corrected measures null without a corrected curve, and sums them only when every note has them', () => {
    const alone = measureNotes([note(0, 0, 1, 60)], frames, 25);
    expect(alone[0]).toMatchObject({
      correctedMedianDeviationCents: null,
      correctedStabilityCents: null,
      correctedOverThreshold: null,
    });
    expect(summarize(alone).correctedOverThresholdCount).toBeNull();
    expect(groupPhrases(alone)[0]).toMatchObject({
      correctedMeanAbsDeviationCents: null,
      correctedOverThresholdCount: null,
    });
  });

  it('counts a note with no voiced corrected frame as not off, and summarizes the others', () => {
    const stats = measureNotes(
      [note(0, 0, 0.5, 60), note(1, 0.5, 1, 60)],
      frames,
      25,
      curve(1, (t) => (t < 0.5 ? null : 61)),
    );
    expect(stats[0]).toMatchObject({ correctedMedianDeviationCents: null, correctedOverThreshold: false });
    expect(stats[1]).toMatchObject({ correctedMedianDeviationCents: 100, correctedOverThreshold: true });
    expect(summarize(stats)).toMatchObject({
      correctedMeanAbsDeviationCents: 100,
      correctedMeanSignedDeviationCents: 100,
      correctedOverThresholdCount: 1,
      correctedOverThresholdRatio: 1,
    });
  });
});

describe('median', () => {
  it('takes the middle of an odd count, the mean of the middle two of an even count, null of nothing', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
