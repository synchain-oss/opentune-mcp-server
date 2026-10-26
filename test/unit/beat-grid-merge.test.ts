// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The timing plan merges the fragments of one sung syllable into a rhythm onset before it compares
// anything with the grid: chains of touching notes with a continuous pitch, the start of a chain as the
// only onset, a lone short note without a suggestion, the span of a chain as the range of its op. The
// notes are synthetic: glides cut into pieces of 10 to 20 ms, as automatic note splitting does.

import { describe, expect, it } from 'vitest';

import * as beatGridModule from '../../plugins/opentune/skills/beat-grid/scripts/beat-grid.mjs';

type Json = Record<string, unknown>;
interface Op {
  op: string;
  start_content_sec: number;
  end_content_sec: number;
  delta_ms: number;
}
interface Suggestion {
  noteIndex: number | null;
  chainLength: number;
  deltaMs: number;
  op: Op | null;
}
interface Plan {
  params: Json;
  settings: { reasons: Record<string, string> } & Json;
  merge: { voicedNotes: number; chains: number; mergedAway: number; onsets: number; shortNotesSkipped: number };
  notes: { used: number };
  counts: { flagged: number; calls: number; remainingSuggestions: number };
  suggestions: Suggestion[];
  calls: { ops: Op[] }[];
  warnings: {
    code: string;
    detail: string;
    // Only the warning RANGE_TOO_NARROW has these.
    noteIndex?: number | null;
    startContentSec?: number;
    deltaMs?: number;
    nextChainStartContentSec?: number;
    movedWithNextChainMs?: number | null;
  }[];
}
interface Chain {
  notes: Json[];
  start: number;
  end: number;
}
interface BeatGridModule {
  DEFAULT_MERGE_CENTS: number;
  DEFAULT_MERGE_GAP_MS: number;
  DEFAULT_MIN_NOTE_MS: number;
  MAX_OPS_PER_CALL: number;
  chainNotes: (notes: Json[], options?: Json) => Chain[];
  summarizePlan: (plan: Plan) => Json;
  timingPlan: (options: Json) => Plan;
}
const {
  DEFAULT_MERGE_CENTS,
  DEFAULT_MERGE_GAP_MS,
  DEFAULT_MIN_NOTE_MS,
  MAX_OPS_PER_CALL,
  chainNotes,
  summarizePlan,
  timingPlan,
} = beatGridModule as unknown as BeatGridModule;

const BEATS = 120;
const grid: Json = {
  schemaVersion: 1,
  model: { name: 'final' },
  beats: Array.from({ length: BEATS }, (_, index) => ({
    index,
    timeSec: index * 0.5,
    isDownbeat: index % 4 === 0,
    segment: 0,
  })),
  segments: [{ index: 0, startSec: 0, endSec: BEATS * 0.5, bpm: 120, confidence: 0.9 }],
  summary: { dominantBpm: 120 },
};

/** One note on both clocks (the clip starts at 0 on the timeline), 60 + `midi` semitones. */
const note = (index: number, startSec: number, lengthMs: number, midi: number | null, extra: Json = {}): Json => ({
  index,
  startContentSec: startSec,
  endContentSec: startSec + lengthMs / 1000,
  startTimelineSec: startSec,
  endTimelineSec: startSec + lengthMs / 1000,
  detectedMidi: midi,
  targetMidi: midi,
  voiced: true,
  ...extra,
});
const page = (notes: Json[], extra: Json = {}): Json => ({
  contentId: 'c:1234abcd:1:1',
  placementId: 'p:1234abcd:1:1',
  clip_revision: 'r:1234abcd:1:1:abc',
  notes,
  ...extra,
});
const plan = (notes: Json[], options: Json = {}): Plan =>
  timingPlan({ grid, notes: page(notes), gridOffsetSec: 0, thresholdMs: 30, ...options });
/** Three notes exactly on the beat, so that the singer's overall lead or lag (the median) is 0. */
const onBeats = (): Json[] => [note(100, 2, 100, 60), note(101, 3, 100, 60), note(102, 4, 100, 60)];
const planWithBeats = (notes: Json[], options: Json = {}): Plan => plan([...notes, ...onBeats()], options);

// The two shared parts of the text of the warning RANGE_TOO_NARROW (an onset that got no range of its own).
const narrowWho = (noteIndex: number, startSec: number): string =>
  `the onset at ${String(startSec)} s of the content (note index ${String(noteIndex)})`;
const narrowWhy = (nextStartSec: number): string =>
  `the next chain starts at ${String(nextStartSec)} s, so a range for this chain would end at or before its own ` +
  'start. Ranges are closed intervals and must not share an end point (a handle there would move twice), so a range ' +
  'ends at least 0.1 ms before the next one starts';

describe('merging fragments into rhythm onsets', () => {
  /**
   * A song of `syllables` syllables, one near each beat, alternately 120 ms late and 120 ms early; each is a
   * glide of 15 fragments of 15 ms with 2 ms between them (a quarter tone-ish step each), plus `noise` lone
   * 20 ms fragments in the gaps.
   */
  function glideSong(syllables: number, noise: number): Json[] {
    const notes: Json[] = [];
    let index = 0;
    for (let k = 1; k <= syllables; k++) {
      const onset = k * 0.5 + (k % 2 === 0 ? 0.12 : -0.12);
      for (let f = 0; f < 15; f++) {
        notes.push(note(index++, onset + f * 0.017, 15, 60 + f * 0.3));
      }
      // After an early syllable (odd k) there is room before the next one; after a late one there is not.
      if (k % 2 === 1 && (k + 1) / 2 <= noise) notes.push(note(index++, k * 0.5 + 0.3, 20, 62));
    }
    return notes.sort((a, b) => (a.startContentSec as number) - (b.startContentSec as number));
  }

  it('turns 614 fragments into a few dozen suggestions instead of hundreds', () => {
    const notes = glideSong(40, 14);
    expect(notes).toHaveLength(614);
    // Without merging every fragment start is compared with the grid.
    const naive = plan(notes, { mergeGapMs: 0, mergeCents: 0, minNoteMs: 0 });
    expect(naive.merge).toMatchObject({ chains: 614, onsets: 614, mergedAway: 0 });
    expect(naive.counts.flagged).toBeGreaterThan(400);
    // With the defaults one syllable is one onset.
    const merged = plan(notes);
    expect(merged.merge).toEqual({
      voicedNotes: 614,
      chains: 54,
      mergedAway: 560,
      onsets: 40,
      shortNotesSkipped: 14,
    });
    expect(merged.counts.flagged).toBeLessThanOrEqual(40);
    expect(merged.counts.flagged).toBeGreaterThan(30);
    expect(merged.suggestions.every((s) => s.chainLength === 15)).toBe(true);
    expect(merged.warnings.map((w) => w.code)).toContain('SHORT_NOTES');
    // Every op spans its whole chain: from the first fragment to the end of the last.
    const first = merged.suggestions[0]?.op;
    const onset = 0.5 - 0.12;
    expect(first?.start_content_sec).toBeCloseTo(onset, 3);
    expect(first?.end_content_sec).toBeCloseTo(onset + 14 * 0.017 + 0.015, 3);
    // And the single call is a short one.
    expect(merged.calls).toHaveLength(1);
    expect(merged.calls[0]?.ops.length).toBeLessThanOrEqual(MAX_OPS_PER_CALL);
  });

  it('keeps the defaults of the card: 30 ms, 300 cents, 60 ms', () => {
    expect([DEFAULT_MERGE_GAP_MS, DEFAULT_MERGE_CENTS, DEFAULT_MIN_NOTE_MS]).toEqual([30, 300, 60]);
    const result = plan([note(0, 1, 100, 60)]);
    expect(result.settings).toMatchObject({
      thresholdMs: 30,
      mergeGapMs: 30,
      mergeCents: 300,
      minNoteMs: 60,
      maxOpsPerCall: 64,
    });
    expect(result.params).toMatchObject({ mergeGapMs: 30, mergeCents: 300, minNoteMs: 60 });
  });

  it('states every setting with its reason in the output', () => {
    const { reasons } = plan([note(0, 1, 100, 60)]).settings;
    for (const name of ['thresholdMs', 'subdivision', 'mergeGapMs', 'mergeCents', 'minNoteMs', 'maxOpsPerCall']) {
      expect(reasons[name], name).toEqual(expect.any(String));
      expect(reasons[name]?.length, name).toBeGreaterThan(30);
    }
  });

  describe('which notes belong to one chain', () => {
    const chains = (notes: Json[], options: Json = {}) =>
      chainNotes(notes, options).map((chain) => chain.notes.map((n) => n.index));

    it('links notes that touch with a continuous pitch, and starts a new chain at a pause longer than the gap', () => {
      // Gaps of 0, 25 and 29.9 ms link; 30 ms and more do not (the gap must be less than the threshold).
      const notes = [
        note(0, 1.0, 100, 60), // 1.000 - 1.100
        note(1, 1.1, 100, 60), // gap 0
        note(2, 1.225, 100, 60), // gap 25 ms
        note(3, 1.3549, 100, 60), // gap 29.9 ms
        note(4, 1.5, 100, 60), // gap 45.1 ms
        note(5, 1.63, 100, 60), // gap 30 ms
      ];
      expect(chains(notes)).toEqual([[0, 1, 2, 3], [4], [5]]);
      expect(chains(notes, { mergeGapMs: 50 })).toEqual([[0, 1, 2, 3, 4, 5]]);
      expect(chains(notes, { mergeGapMs: 0 })).toEqual([[0], [1], [2], [3], [4], [5]]);
    });

    it('starts a new chain at a pitch jump of the threshold or more, even when the notes touch', () => {
      const notes = [
        note(0, 1.0, 50, 60),
        note(1, 1.05, 50, 62.99), // 299 cents: a glide
        note(2, 1.1, 50, 66), // 301 cents above the one before: a new syllable
        note(3, 1.15, 50, 66.5),
      ];
      expect(chains(notes)).toEqual([
        [0, 1],
        [2, 3],
      ]);
      expect(chains(notes, { mergeCents: 400 })).toEqual([[0, 1, 2, 3]]);
      expect(chains(notes, { mergeCents: 0 })).toEqual([[0], [1], [2], [3]]);
    });

    it('compares the pitch of neighbouring notes, so a long slide stays one chain', () => {
      // Each step is 200 cents; the first and the last note are 1,200 cents apart.
      const notes = Array.from({ length: 7 }, (_, i) => note(i, 1 + i * 0.05, 50, 60 + i * 2));
      expect(chains(notes)).toEqual([[0, 1, 2, 3, 4, 5, 6]]);
    });

    it('uses detectedMidi, then targetMidi, and decides by the gap alone without a pitch', () => {
      // The target is corrected to one pitch, but the detected pitch jumps: the detected pitch decides.
      const jump = [note(0, 1, 50, 60, { targetMidi: 60 }), note(1, 1.05, 50, 66, { targetMidi: 60 })];
      expect(chains(jump)).toEqual([[0], [1]]);
      // No detected pitch (null): the target decides.
      const onlyTarget = [
        note(0, 1, 50, null, { targetMidi: 60 }),
        note(1, 1.05, 50, null, { targetMidi: 67 }),
        note(2, 1.1, 50, null, { targetMidi: 67.5 }),
      ];
      expect(chains(onlyTarget)).toEqual([[0], [1, 2]]);
      // No pitch at all: touching notes link.
      const bare = [
        note(0, 1, 50, null, { targetMidi: undefined }),
        note(1, 1.05, 50, null, { targetMidi: undefined }),
      ];
      expect(chains(bare)).toEqual([[0, 1]]);
    });

    it('takes the notes in order of their start and never joins notes of different clips', () => {
      const shuffled = [note(2, 1.1, 50, 60), note(0, 1.0, 50, 60), note(1, 1.05, 50, 60)];
      expect(chains(shuffled)).toEqual([[0, 1, 2]]);
      const keyOf = (n: Json) => (n.index === 2 ? 'p:two' : 'p:one');
      expect(chains([note(0, 1.0, 50, 60), note(1, 1.05, 50, 60), note(2, 1.1, 50, 60)], { keyOf })).toEqual([
        [0, 1],
        [2],
      ]);
    });

    it('links an overlap, and measures the gap from the latest end of the chain', () => {
      // Note 0 is long, note 1 sits inside it, note 2 starts 20 ms after note 0 ends (but 450 ms after note 1).
      const notes = [note(0, 1.0, 500, 60), note(1, 1.1, 50, 60), note(2, 1.52, 50, 60)];
      expect(chains(notes)).toEqual([[0, 1, 2]]);
    });
  });

  describe('which chains get a suggestion', () => {
    it('gives a lone note of less than 60 ms none, and the start of a chain of short notes one', () => {
      const lone = planWithBeats([note(0, 1.18, 40, 60)]); // a 40 ms note 180 ms off the beat at 1.0
      expect(lone.suggestions).toEqual([]);
      expect(lone.merge).toMatchObject({ onsets: 3, shortNotesSkipped: 1 });
      expect(lone.warnings.map((w) => w.code)).toContain('SHORT_NOTES');
      // Two touching 20 ms notes are a chain: its start is an onset however short the notes are.
      const chain = planWithBeats([note(0, 1.18, 20, 60), note(1, 1.2, 20, 60)]);
      expect(chain.suggestions).toHaveLength(1);
      expect(chain.suggestions[0]).toMatchObject({ noteIndex: 0, chainLength: 2, deltaMs: -180 });
      // A lone note of exactly 60 ms is long enough; --min-note-ms moves the limit.
      expect(planWithBeats([note(0, 1.18, 60, 60)]).suggestions).toHaveLength(1);
      expect(planWithBeats([note(0, 1.18, 59, 60)]).suggestions).toHaveLength(0);
      expect(planWithBeats([note(0, 1.18, 40, 60)], { minNoteMs: 40 }).suggestions).toHaveLength(1);
    });

    it('gives only the start of a chain a suggestion, and the range of its op is the whole chain', () => {
      // Three fragments of one syllable 180 ms late; the later fragments are further from the beat.
      const result = planWithBeats([note(0, 1.18, 40, 60), note(1, 1.22, 40, 60.5), note(2, 1.26, 40, 61)]);
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]?.op).toEqual({
        op: 'shift',
        start_content_sec: 1.18,
        end_content_sec: 1.3,
        delta_ms: -180,
      });
      expect(result.merge).toEqual({ voicedNotes: 6, chains: 4, mergedAway: 2, onsets: 4, shortNotesSkipped: 0 });
    });

    it('ends the range of one op 0.1 ms before the next chain starts, because a range is a closed interval', () => {
      // The first chain ends at 1.4 s, but the next one (a pitch jump while touching) starts at 1.3 s. A handle at
      // 1.3 s lies in both ranges if they meet there, and would be moved twice.
      const result = plan([note(0, 1.18, 220, 60), note(1, 1.3, 100, 70)], { thresholdMs: 10 });
      const ranges = result.suggestions.map((s) => [s.op?.start_content_sec, s.op?.end_content_sec]);
      expect(ranges).toEqual([
        [1.18, 1.2999],
        [1.3, 1.4],
      ]);
    });

    it('plans two chains that follow each other end to end, so that no handle lies in two ranges', () => {
      // Two chains, the first ends at 1.3 s where the second starts (a pitch jump splits them).
      const result = planWithBeats([note(0, 1.18, 120, 60), note(1, 1.3, 100, 70)], { thresholdMs: 10 });
      const ops = result.suggestions.map((s) => s.op);
      expect(ops).toEqual([
        { op: 'shift', start_content_sec: 1.18, end_content_sec: 1.2999, delta_ms: -180 },
        { op: 'shift', start_content_sec: 1.3, end_content_sec: 1.4, delta_ms: 200 },
      ]);
      expect(result.warnings.map((w) => w.code)).not.toContain('RANGE_TOO_NARROW');
      // A gap of 0.2 ms still leaves a range of 0.1 ms.
      const narrow = planWithBeats([note(0, 1.18, 100, 60), note(1, 1.1802, 100, 70)], { thresholdMs: 10 });
      expect(narrow.suggestions.map((s) => s.op)).toEqual([
        { op: 'shift', start_content_sec: 1.18, end_content_sec: 1.1801, delta_ms: -180 },
        { op: 'shift', start_content_sec: 1.1802, end_content_sec: 1.2802, delta_ms: -180 },
      ]);
      expect(narrow.warnings.map((w) => w.code)).not.toContain('RANGE_TOO_NARROW');
    });

    it('skips an onset whose next chain starts within 0.1 ms, and says which onset and why', () => {
      // The two chains start 0.05 ms apart: the first has no room for a range of its own.
      const result = planWithBeats([note(0, 1.18, 100, 60, { index: 7 }), note(1, 1.18005, 100, 70, { index: 8 })], {
        thresholdMs: 10,
      });
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toMatchObject({ noteIndex: 8, deltaMs: -180 });
      expect(result.suggestions[0]?.op).toEqual({
        op: 'shift',
        start_content_sec: 1.18,
        end_content_sec: 1.2801,
        delta_ms: -180,
      });
      expect(result.counts.flagged).toBe(1);
      const skipped = result.warnings.filter((w) => w.code === 'RANGE_TOO_NARROW');
      expect(skipped).toHaveLength(1);
      // Both starts are in the same 0.1 ms, so the range of the next chain starts at 1.18, where this onset is:
      // a handle there is inside that range and moves with it, here by the same -180 ms.
      expect(skipped[0]).toEqual({
        code: 'RANGE_TOO_NARROW',
        detail: `${narrowWho(7, 1.18)} got no shift of its own (-180 ms): ${narrowWhy(1.18005)}. A handle at this onset lies inside the range 1.18 to 1.2801 s of a following chain, so it moves with that chain, by the same -180 ms this chain would have had; check it after the batch`,
        noteIndex: 7,
        startContentSec: 1.18,
        deltaMs: -180,
        nextChainStartContentSec: 1.18005,
        movedWithNextChainMs: -180,
      });
      // Not a dropped suggestion without a trace: the call carries one op, and the warning accounts for the other.
      expect(result.calls[0]?.ops).toHaveLength(1);
      // A gap of exactly 0.1 ms leaves a range that is empty, and is skipped the same way; here the next range
      // starts at 1.1801, after the onset at 1.18, so nothing moves a handle there.
      const empty = planWithBeats([note(0, 1.18, 100, 60, { index: 7 }), note(1, 1.1801, 100, 70, { index: 8 })], {
        thresholdMs: 10,
      });
      expect(empty.suggestions.map((s) => s.noteIndex)).toEqual([8]);
      expect(empty.suggestions[0]?.op?.start_content_sec).toBe(1.1801);
      expect(empty.warnings.find((w) => w.code === 'RANGE_TOO_NARROW')).toMatchObject({
        noteIndex: 7,
        movedWithNextChainMs: null,
      });
      // The range of a chain never falls back to the start plus 0.1 ms: that would reach past the next range.
      for (const { op } of result.suggestions) {
        expect(op?.end_content_sec).toBeGreaterThan(op?.start_content_sec ?? Infinity);
      }
    });

    // Two chains on either side of the midpoint between two grid points (every 0.25 s with --subdivision 2) have
    // the same deviation with opposite signs, so their shifts are -125 and +125 ms.
    describe('the warning says what happens to a handle at the skipped onset', () => {
      const tight = (aStart: number, bStart: number, options: Json = {}) =>
        planWithBeats([note(0, aStart, 100, 60, { index: 7 }), note(1, bStart, 100, 70, { index: 8 })], {
          thresholdMs: 10,
          subdivision: 2,
          ...options,
        });

      it('says that the handle moves with the next chain, by that chain’s shift, when it lies in its range', () => {
        // The grid is 0.05 ms later than the timeline, so the midpoint 1.12505 lies between the two starts, which are
        // in the same 0.1 ms: the next range starts at 1.125, before the onset at 1.12504.
        const result = tight(1.12504, 1.12506, { gridOffsetSec: 0.00005 });
        expect(result.suggestions).toHaveLength(1);
        expect(result.suggestions[0]).toMatchObject({ noteIndex: 8, deltaMs: 125 });
        const op = result.suggestions[0]?.op;
        expect(op).toEqual({ op: 'shift', start_content_sec: 1.125, end_content_sec: 1.2251, delta_ms: 125 });
        const [warning, ...others] = result.warnings.filter((w) => w.code === 'RANGE_TOO_NARROW');
        expect(others).toEqual([]);
        expect(warning).toEqual({
          code: 'RANGE_TOO_NARROW',
          detail: `${narrowWho(7, 1.12504)} got no shift of its own (-125 ms): ${narrowWhy(1.12506)}. A handle at this onset lies inside the range 1.125 to 1.2251 s of a following chain, so it moves with that chain, by 125 ms, and not by this chain's -125 ms; check it after the batch`,
          noteIndex: 7,
          startContentSec: 1.12504,
          deltaMs: -125,
          nextChainStartContentSec: 1.12506,
          movedWithNextChainMs: 125,
        });
        // The text and the members agree with the range that is planned.
        expect(warning?.detail).toContain(`${String(op?.start_content_sec)} to ${String(op?.end_content_sec)} s`);
        expect(warning?.movedWithNextChainMs).toBe(op?.delta_ms);
        expect(warning?.startContentSec).toBeGreaterThanOrEqual(op?.start_content_sec ?? Infinity);
        expect(warning?.startContentSec).toBeLessThanOrEqual(op?.end_content_sec ?? -Infinity);
      });

      it('says that nothing moves the handle when the next range starts after the onset', () => {
        // The onset is at 1.12498, in the bucket of 1.1249, and the next range starts at 1.125.
        const result = tight(1.12498, 1.12503);
        expect(result.suggestions).toHaveLength(1);
        expect(result.suggestions[0]).toMatchObject({ noteIndex: 8, deltaMs: 125 });
        const op = result.suggestions[0]?.op;
        expect(op).toEqual({ op: 'shift', start_content_sec: 1.125, end_content_sec: 1.2251, delta_ms: 125 });
        const [warning, ...others] = result.warnings.filter((w) => w.code === 'RANGE_TOO_NARROW');
        expect(others).toEqual([]);
        expect(warning).toEqual({
          code: 'RANGE_TOO_NARROW',
          detail: `${narrowWho(7, 1.12498)} got no shift of its own (-125 ms): ${narrowWhy(1.12503)}. No range of the plan covers a handle at this onset, so none is moved; fix its timing by hand if it matters`,
          noteIndex: 7,
          startContentSec: 1.12498,
          deltaMs: -125,
          nextChainStartContentSec: 1.12503,
          movedWithNextChainMs: null,
        });
        // The text and the members agree with the range that is planned: the onset is before it.
        expect(warning?.startContentSec).toBeLessThan(op?.start_content_sec ?? -Infinity);
        expect(warning?.detail).not.toContain('lies inside');
      });
    });

    it('does not let two neighbouring ranges overlap after rounding, whatever the decimals of the next start', () => {
      // The next chain starts at 1.30003 s: rounded outwards the end of the first range would be 1.3001, but the
      // next range starts at 1.3 and the first must stop 0.1 ms before it.
      const touching = planWithBeats([note(0, 1.18, 220, 60), note(1, 1.30003, 100, 70)], { thresholdMs: 10 });
      const ops = touching.suggestions.map((s) => s.op);
      expect(ops).toHaveLength(2);
      expect(ops[0]).toMatchObject({ start_content_sec: 1.18, end_content_sec: 1.2999 });
      expect(ops[1]?.start_content_sec).toBe(1.3);
      // A gap of 0.02 ms between two chains rounds to the same tenth of a millisecond, not past it.
      const gap = planWithBeats([note(0, 1.18, 100.02, 60), note(1, 1.28004, 100, 70)], { thresholdMs: 10 });
      expect(gap.suggestions[0]?.op?.end_content_sec).toBeLessThan(gap.suggestions[1]?.op?.start_content_sec ?? 0);
      // Many neighbours, starts of five decimals: every range ends before the next one starts.
      const crowd: Json[] = [];
      for (let k = 0; k < 40; k++)
        crowd.push(note(k, 1.1 + k * 0.03713 + k * 0.00007, 25 + (k % 3) * 0.013, k % 2 === 0 ? 60 : 70));
      const ranges = planWithBeats(crowd, { thresholdMs: 1, minNoteMs: 0 })
        .suggestions.map((s) => s.op)
        .filter((op): op is Op => op !== null)
        .sort((a, b) => a.start_content_sec - b.start_content_sec);
      expect(ranges.length).toBeGreaterThan(10);
      for (const [index, op] of ranges.entries()) {
        expect(op.end_content_sec).toBeGreaterThan(op.start_content_sec);
        const next = ranges[index + 1];
        // A range is a closed interval, so a range that ends where the next starts would move that handle twice.
        if (next !== undefined) expect(op.end_content_sec).toBeLessThan(next.start_content_sec);
      }
    });

    it('rounds the range outwards, so a handle at its edge stays inside', () => {
      const result = planWithBeats([note(0, 1.18003, 100.04, 60)]);
      expect(result.suggestions[0]?.op?.start_content_sec).toBe(1.18);
      expect(result.suggestions[0]?.op?.end_content_sec).toBe(1.2801);
    });

    it('leaves unvoiced notes out of the chains, so they do not bridge two syllables', () => {
      const result = plan([
        note(0, 1.18, 40, 60),
        note(1, 1.22, 40, 60, { voiced: false }),
        note(2, 1.26, 40, 60),
        note(3, 1.3, 40, 60),
      ]);
      // Notes 0 and 2 are 40 ms apart once the unvoiced note is out: two chains, a lone short note and a chain.
      expect(result.merge).toMatchObject({ voicedNotes: 3, chains: 2, onsets: 1, shortNotesSkipped: 1 });
      expect(result.warnings.map((w) => w.code)).toContain('UNVOICED_NOTES');
    });

    it('does not chain across the pages of two clips, and gives no call for them', () => {
      const one = page([note(0, 1.18, 100, 60)], { placementId: 'p:1234abcd:1:1' });
      const two = page([note(1, 1.28, 100, 60)], { placementId: 'p:1234abcd:2:1' });
      const mixed = timingPlan({ grid, notes: [one, two], gridOffsetSec: 0 });
      expect(mixed.merge.chains).toBe(2);
      expect(mixed.calls).toEqual([]);
      expect(mixed.warnings.map((w) => w.code)).toContain('MIXED_PLACEMENTS');
    });

    it('drops a note without a content start and says so', () => {
      const result = planWithBeats([note(0, 1.18, 100, 60), { index: 1, startTimelineSec: 2.2, voiced: true }]);
      expect(result.suggestions).toHaveLength(1);
      expect(result.warnings.map((w) => w.code)).toContain('NOTES_WITHOUT_CONTENT');
    });

    it('refuses merge settings that are not numbers of 0 or more', () => {
      for (const options of [{ mergeGapMs: -1 }, { mergeCents: Number.NaN }, { minNoteMs: -5 }]) {
        expect(() => plan([note(0, 1, 100, 60)], options)).toThrow(/must be a number, 0 or more/);
      }
    });
  });

  describe('the summary of a plan', () => {
    it('keeps the counts, the settings and the batches, and lists the ten largest shifts', () => {
      const result = plan(glideSong(40, 0));
      const summary = summarizePlan(result) as Json & { largestShifts: { deltaMs: number }[] };
      expect(summary.suggestions).toBeUndefined();
      expect(summary.suggestionsOmitted).toBe(result.counts.flagged);
      expect(summary.counts).toEqual(result.counts);
      expect(summary.calls).toEqual(result.calls);
      expect(summary.settings).toEqual(result.settings);
      expect(summary.largestShifts).toHaveLength(10);
      const sizes = summary.largestShifts.map((s) => Math.abs(s.deltaMs));
      expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    });
  });
});
