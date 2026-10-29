// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// A whole song, batch by batch, against the mock: read every note into a file with opentune_get_notes
// (output_path), make the timing plan from that file, apply the first batch with opentune_edit_timing,
// read again, plan again, until the plan has no call left. The song is synthetic: 150 syllables, each a
// glide cut into touching fragments, alternately late and early, with a time-grid handle just after the
// start of every syllable. It checks that a batch never has more than 64 operations, that the plan
// settles in a few rounds, and that a plan is not reused once the grid has changed.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startMock } from '../../mock/server.js';
import { getNotes } from '../../src/tools/notes.js';
import { editTiming } from '../../src/tools/timing.js';
import { type Outcome } from '../../src/tools/registry.js';
import { tempDir, testContext } from '../support/context.js';
import { clip, need } from '../support/mock-client.js';
import * as beatGridModule from '../../plugins/opentune/skills/beat-grid/scripts/beat-grid.mjs';

type Json = Record<string, unknown>;
interface Op {
  op: string;
  start_content_sec: number;
  end_content_sec: number;
  delta_ms: number;
}
interface Batch {
  batch: number;
  batches: number;
  ready: boolean;
  clip: string;
  expected_revision: string | null;
  ops: Op[];
}
interface Plan {
  settings: Json;
  merge: { voicedNotes: number; chains: number; onsets: number; shortNotesSkipped: number };
  globalOffsetMs: number | null;
  counts: { flagged: number; calls: number; remainingSuggestions: number };
  calls: Batch[];
  warnings: { code: string }[];
}
interface BeatGridModule {
  MAX_OPS_PER_CALL: number;
  main: (argv: string[], options?: Json) => Promise<number>;
}
const { MAX_OPS_PER_CALL, main } = beatGridModule as unknown as BeatGridModule;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const body = (outcome: Outcome) => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.error.kind}: ${outcome.error.detail}`);
  return outcome.body;
};

const SYLLABLES = 150;
const FRAGMENTS = 6;
// The mock hears a voiced stretch of 0.7 s in every phrase of 0.8 s, so a beat every 0.8 s, placed 0.2 s into
// the phrase, keeps the whole syllable (the beat, the late or early start around it, its fragments) voiced.
const BEAT_SEC = 0.8;
const BEAT_PHASE = 0.2;
/** The clip starts here on the timeline. */
const CLIP_START = 2;
/** How far after the start of a syllable its time-grid handle lies (inside the syllable, away from its edge). */
const HANDLE_AFTER = 0.003;

/** Alternately late and early by 40 to 100 ms: far enough from the beat for every syllable to be flagged. */
const jitter = (k: number): number => (k % 2 === 0 ? 1 : -1) * (0.04 + 0.06 * (((k * 7) % 10) / 10));
const onsetOf = (k: number): number => k * BEAT_SEC + BEAT_PHASE + jitter(k);

async function setup() {
  const t = tempDir();
  cleanup.push(t.remove);
  const mock = await startMock({ discoveryDir: t.dir });
  cleanup.push(() => mock.stop());
  const ctx = testContext(t.dir);
  cleanup.push(() => {
    ctx.instances.close();
  });
  const dir = path.join(t.dir, 'work');
  mkdirSync(dir);

  const notes: { startContentSec: number; endContentSec: number; targetMidi: number }[] = [];
  for (let k = 1; k <= SYLLABLES; k++) {
    for (let f = 0; f < FRAGMENTS; f++) {
      const start = onsetOf(k) + f * 0.017;
      notes.push({ startContentSec: start, endContentSec: start + 0.015, targetMidi: 60 + 0.2 * f });
    }
    // Every tenth syllable has a click-like fragment in the gap after it, too short to be a rhythm onset.
    if (k % 10 === 0) {
      const start = k * BEAT_SEC + BEAT_PHASE + 0.4;
      notes.push({ startContentSec: start, endContentSec: start + 0.02, targetMidi: 62 });
    }
  }
  notes.sort((a, b) => a.startContentSec - b.startContentSec);
  const handles = Array.from({ length: SYLLABLES }, (_, i) => ({
    bind: `h${String(i)}`,
    contentSec: onsetOf(i + 1) + HANDLE_AFTER,
  }));
  const ids = mock.given({
    dirty: false,
    clips: [
      clip({
        startTimelineSec: CLIP_START,
        durationSec: SYLLABLES * BEAT_SEC + 10,
        notes,
        timeGrid: handles,
      }),
    ],
  });
  const gridFile = path.join(dir, 'grid.json');
  writeFileSync(
    gridFile,
    JSON.stringify({
      schemaVersion: 1,
      beats: Array.from({ length: SYLLABLES + 10 }, (_, index) => ({
        index,
        timeSec: index * BEAT_SEC + BEAT_PHASE,
        isDownbeat: index % 4 === 0,
        segment: 0,
      })),
      segments: [{ index: 0, startSec: 0, endSec: (SYLLABLES + 10) * BEAT_SEC, bpm: 75, confidence: 0.95 }],
      summary: { dominantBpm: 75 },
    }),
  );
  return { ctx, dir, gridFile, placement: need(ids, 'clip.placementId'), noteCount: notes.length };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Reads every note into a new file and makes the plan from it; the file is the one the tool names. */
async function readAndPlan(s: Setup, round: number) {
  const read = body(
    await getNotes(s.ctx, {
      clip: s.placement,
      clock: 'content',
      output_path: path.join(s.dir, `notes-${String(round)}.json`),
    }),
  );
  const notesFile = (read.output as { path: string }).path;
  let out = '';
  const code = await main(
    ['timing-plan', '--grid', s.gridFile, '--notes', notesFile, '--grid-offset-sec', String(CLIP_START), '--summary'],
    { env: {}, cwd: s.dir, out: (text: string) => (out += text), err: () => undefined },
  );
  expect(code).toBe(0);
  return { read, notesFile, plan: JSON.parse(out) as Plan };
}

const applyFirst = async (s: Setup, plan: Plan) => {
  const batch = plan.calls[0];
  if (batch === undefined) throw new Error('no batch to apply');
  return editTiming(s.ctx, {
    clip: batch.clip,
    expected_revision: batch.expected_revision ?? '',
    ops: batch.ops.map((op) => ({ ...op, op: 'shift' as const })),
  });
};

describe('a whole song, one batch at a time', () => {
  it('plans, applies the first batch, reads and plans again, until nothing is left', async () => {
    const s = await setup();
    const rounds: { flagged: number; batches: number; ops: number }[] = [];
    let first: Plan | null = null;

    for (let round = 0; round < 8; round++) {
      const { plan } = await readAndPlan(s, round);
      expect(plan.merge).toMatchObject({
        voicedNotes: s.noteCount,
        chains: SYLLABLES + SYLLABLES / 10,
      });
      first ??= plan;
      if (plan.calls.length === 0) {
        rounds.push({ flagged: plan.counts.flagged, batches: 0, ops: 0 });
        break;
      }
      const batch = plan.calls[0];
      expect(batch?.batch).toBe(1);
      expect(batch?.ready).toBe(true);
      expect(batch?.ops.length).toBeLessThanOrEqual(MAX_OPS_PER_CALL);
      // Only the first batch can be sent; the others are previews with no revision to send.
      for (const later of plan.calls.slice(1)) expect(later.expected_revision).toBeNull();
      rounds.push({ flagged: plan.counts.flagged, batches: plan.calls.length, ops: batch?.ops.length ?? 0 });

      const applied = body(await applyFirst(s, plan));
      expect(applied.stopped).toBeUndefined();
      expect((applied.steps as unknown[]).length).toBe(batch?.ops.length);
    }

    // 150 syllables at 64 per batch: 64 + 64 + 22, and then a plan with nothing left.
    expect(first?.counts.flagged).toBe(SYLLABLES);
    expect(first?.calls.map((c) => c.ops.length)).toEqual([64, 64, 22]);
    expect(first?.settings).toMatchObject({ maxOpsPerCall: 64 });
    expect(rounds.map((r) => r.ops)).toEqual([64, 64, 22, 0]);
    // Every round has fewer syllables to correct than the one before.
    const flagged = rounds.map((r) => r.flagged);
    expect(flagged).toEqual([150, 86, 22, 0]);
    expect(rounds.at(-1)).toEqual({ flagged: 0, batches: 0, ops: 0 });
  });

  it('does not accept the batch of a plan once the grid has moved on', async () => {
    const s = await setup();
    const before = await readAndPlan(s, 0);
    const batch = before.plan.calls[0];
    if (batch === undefined) throw new Error('no batch');
    body(await applyFirst(s, before.plan));

    // The same batch again: its revision belongs to the grid as it was before the first call.
    const stale = await applyFirst(s, before.plan);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.kind).toBe('REVISION_CONFLICT');

    // A new reading gives a new revision, and a plan made from it is accepted.
    const after = await readAndPlan(s, 1);
    const next = after.plan.calls[0];
    expect(next?.expected_revision).not.toBe(batch.expected_revision);
    expect(next?.expected_revision).toBe((after.read.clip_revision as string | null) ?? undefined);
    body(await applyFirst(s, after.plan));
  });

  it('leaves the notes file as one complete JSON document at every round', async () => {
    const s = await setup();
    const { notesFile, read } = await readAndPlan(s, 0);
    const file = JSON.parse(readFileSync(notesFile, 'utf8')) as { notes: unknown[]; totalCount: number };
    expect(file.notes).toHaveLength(s.noteCount);
    expect(file.totalCount).toBe(s.noteCount);
    expect((read.output as { noteCount: number }).noteCount).toBe(s.noteCount);
  });
});
