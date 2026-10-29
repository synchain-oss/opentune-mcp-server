// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Output budget of the read tools: a single result stays within 20,000 characters, as the client
// receives it, for a clip of 800 notes and for a project with many clips. `npm run gates` runs this
// file as its "output budget" check.

import { afterEach, describe, expect, it } from 'vitest';

import { startMock } from '../../mock/server.js';
import { MAX_LISTED, MAX_TABLE_ROWS } from '../../src/render/index.js';
import { autotune } from '../../src/tools/autotune.js';
import { getClipDetails } from '../../src/tools/clip-details.js';
import { editArrangement } from '../../src/tools/edit-arrangement.js';
import { editNotes } from '../../src/tools/edit-notes.js';
import { getNotes, OUTPUT_BUDGET } from '../../src/tools/notes.js';
import { getProject } from '../../src/tools/project.js';
import { render, type Outcome } from '../../src/tools/registry.js';
import { getSettings } from '../../src/tools/settings.js';
import { MAX_LISTED_HANDLES, editTiming } from '../../src/tools/timing.js';
import { tempDir, testContext } from '../support/context.js';
import { clip, need } from '../support/mock-client.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Characters of the text block and of the structured content, as the client receives them. */
export function resultSizes(outcome: Outcome): { text: number; structured: number } {
  const result = render(outcome);
  const text = (result.content[0] as { text: string }).text;
  return { text: text.length, structured: JSON.stringify(result.structuredContent).length };
}

async function setup() {
  const t = tempDir();
  cleanup.push(t.remove);
  const mock = await startMock({ discoveryDir: t.dir });
  cleanup.push(() => mock.stop());
  const ctx = testContext(t.dir);
  cleanup.push(() => {
    ctx.instances.close();
  });
  return { mock, ctx };
}

const notes = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    startContentSec: i + 0.123456,
    endContentSec: i + 0.923456,
    targetMidi: 60.123456 + (i % 12),
  }));

describe('output budget', () => {
  it('keeps one page of a clip of 800 notes within the budget, at every page size', async () => {
    const { mock, ctx } = await setup();
    const ids = mock.given({ clips: [clip({ durationSec: 900, notes: notes(800) })] });
    const placement = need(ids, 'clip.placementId');
    for (const limit of [undefined, 1, 100, 200]) {
      let cursor: string | undefined;
      const seen: number[] = [];
      let largest = 0;
      for (let page = 0; page < 800; page += 1) {
        const outcome = await getNotes(ctx, { clip: placement, clock: 'content', ...(limit ? { limit } : {}), cursor });
        if (!outcome.ok) throw new Error(outcome.error.detail);
        const sizes = resultSizes(outcome);
        largest = Math.max(largest, sizes.text, sizes.structured);
        for (const note of outcome.body.notes as { index: number }[]) seen.push(note.index);
        cursor = (outcome.body.next_cursor as string | null) ?? undefined;
        if (cursor === undefined || limit === 1) break; // one note per page: the first page is enough
      }
      expect(largest, `limit ${String(limit)}`).toBeLessThanOrEqual(OUTPUT_BUDGET);
      if (limit !== 1) expect(seen).toEqual(Array.from({ length: 800 }, (_, i) => i));
    }
    expect(OUTPUT_BUDGET).toBe(20_000);
    // It pages through all 800 notes at several page sizes: about 0.5 s here, but 5.0 s on the shared
    // windows runner, which hit the default limit. The limit only has to outlast a slow runner.
  }, 20_000);

  it('says when it reduced the page size, and keeps a page that fits at the size asked for', async () => {
    const { mock, ctx } = await setup();
    const ids = mock.given({ clips: [clip({ durationSec: 900, notes: notes(800) })] });
    const big = await getNotes(ctx, { clip: need(ids, 'clip.placementId'), clock: 'content', limit: 200 });
    if (!big.ok) throw new Error('failed');
    expect(big.body.notes as unknown[]).not.toHaveLength(200);
    expect(big.body.page_limit_applied).toBe((big.body.notes as unknown[]).length);
    expect(big.body.summary).toContain('limited to');
    expect(big.body.next_cursor).not.toBeNull();
    const small = await getNotes(ctx, { clip: need(ids, 'clip.placementId'), clock: 'content', limit: 10 });
    if (!small.ok) throw new Error('failed');
    expect(small.body).not.toHaveProperty('page_limit_applied');
  });

  it('keeps the project of a busy session within the budget', async () => {
    const { mock, ctx } = await setup();
    mock.given({
      clips: Array.from({ length: 24 }, (_, i) =>
        clip({
          bind: `take-${String(i)}`,
          trackId: i % 4,
          startTimelineSec: i * 10,
          notes: notes(50),
          durationSec: 60,
        }),
      ),
    });
    const outcome = await getProject(ctx, { include_history: true });
    if (!outcome.ok) throw new Error(outcome.error.detail);
    expect(outcome.body.placements as unknown[]).toHaveLength(24);
    const sizes = resultSizes(outcome);
    expect(Math.max(sizes.text, sizes.structured)).toBeLessThanOrEqual(OUTPUT_BUDGET);
  });

  it('keeps the details of a clip of 800 notes and the settings with a long log within the budget', async () => {
    const { mock, ctx } = await setup();
    const ids = mock.given({ clips: [clip({ durationSec: 900, notes: notes(800) })] });
    for (let i = 0; i < 400; i += 1) mock.logLine(`${String(i)} ${'z'.repeat(2000)}`);
    const details = await getClipDetails(ctx, { clip: need(ids, 'clip.placementId') });
    const settings = await getSettings(ctx, {
      sections: ['processing', 'audio_device', 'recent', 'export_caps', 'log'],
      log_lines: 500,
    });
    for (const outcome of [details, settings]) {
      if (!outcome.ok) throw new Error(outcome.error.detail);
      const sizes = resultSizes(outcome);
      expect(Math.max(sizes.text, sizes.structured)).toBeLessThanOrEqual(OUTPUT_BUDGET);
    }
  });

  it('measures the result as the client receives it, so an oversized result would be caught', () => {
    const huge: Outcome = { ok: true, body: { summary: 'x', pad: 'y'.repeat(OUTPUT_BUDGET) } };
    expect(resultSizes(huge).text).toBeGreaterThan(OUTPUT_BUDGET);
  });
});

// The write tools ------------------------------------------------------------------------------------------------

/** A clip of `n` notes half a second apart; its length in seconds is `n / 2 + 10`. */
const spread = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    startContentSec: i * 0.5 + 0.123456,
    endContentSec: i * 0.5 + 0.423456,
    targetMidi: 60.123456 + (i % 12),
  }));

const revisionOfFirst = async (ctx: Awaited<ReturnType<typeof setup>>['ctx']): Promise<string> => {
  const project = await getProject(ctx, {});
  if (!project.ok) throw new Error(project.error.detail);
  return (project.body.placements as { clip_revision: string }[])[0]?.clip_revision ?? '';
};

/** Where `needle` first appears in the text of the result and in the JSON of its structured content; -1 when absent. */
function whereIn(outcome: Outcome, needle: string): { text: number; structured: number } {
  const result = render(outcome);
  return {
    text: (result.content[0] as { text: string }).text.indexOf(needle),
    structured: JSON.stringify(result.structuredContent).indexOf(needle),
  };
}

const ok = (outcome: Outcome) => {
  if (!outcome.ok) throw new Error(`${outcome.error.kind}: ${outcome.error.detail}`);
  return outcome.body;
};

/** The most a write result of a long edit may have: the text and the structured content together. */
const WRITE_BUDGET = 20_000;
/** What must still be there when a host keeps only the start of a long result: the undo id or the way back. */
const FRONT = 2_000;

describe('output budget of the write tools', () => {
  it('keeps the result of a regenerate of 1,200 notes within 20,000 characters with the undo id up front', async () => {
    const { mock, ctx } = await setup();
    const ids = mock.given({ clips: [clip({ durationSec: 900, notes: spread(1200) })] });
    const outcome = await autotune(ctx, {
      clip: need(ids, 'clip.placementId'),
      expected_revision: await revisionOfFirst(ctx),
      mode: 'regenerate',
      scale: { root: 0, scale: 'major' },
    });
    const body = ok(outcome);
    const sizes = resultSizes(outcome);
    // Text and structured content together, not each alone: a host may take both into account.
    expect(sizes.text + sizes.structured).toBeLessThanOrEqual(WRITE_BUDGET);
    // The lists show the first entries and count the rest.
    const omitted = body.omittedCount as { created: number; removed: number };
    expect(body.created as unknown[]).toHaveLength(MAX_LISTED);
    expect(body.removed as unknown[]).toHaveLength(MAX_LISTED);
    expect(omitted.removed).toBe(1200 - MAX_LISTED);
    expect(omitted.created).toBeGreaterThan(0);
    expect(body.summary).toContain('removed 1200 notes');
    expect((body.changeTable as { rows: unknown[] }).rows.length).toBeLessThanOrEqual(MAX_TABLE_ROWS);
    // Undoing it needs the undo id: it is among the first characters of both forms, before any list.
    const undoId = (body.undo as { undoId: string }).undoId;
    expect(whereIn(outcome, undoId).text).toBeGreaterThanOrEqual(0);
    expect(whereIn(outcome, undoId).text).toBeLessThan(FRONT);
    expect(whereIn(outcome, undoId).structured).toBeLessThan(FRONT);
    expect(whereIn(outcome, '"created"').text).toBeGreaterThan(whereIn(outcome, '"undoable"').text);
  });

  it('would exceed the budget without the cut: the same call, as OpenTune answers it, is far over', async () => {
    const { mock, ctx } = await setup();
    const ids = mock.given({ clips: [clip({ durationSec: 900, notes: spread(1200) })] });
    // Record what OpenTune answers to the tool's own request.
    const scan = await ctx.instances.scan();
    if (!('instances' in scan) || scan.instances[0] === undefined) throw new Error('no instance');
    const session = await ctx.instances.session(scan.instances[0]);
    const original = session.call.bind(session);
    const answers: Record<string, unknown>[] = [];
    session.call = async (method, params, timeoutMs) => {
      const answer = await original(method, params, timeoutMs);
      if (method === 'content.autoTune') answers.push(answer);
      return answer;
    };
    const outcome = await autotune(ctx, {
      clip: need(ids, 'clip.placementId'),
      expected_revision: await revisionOfFirst(ctx),
      mode: 'regenerate',
      scale: { root: 0, scale: 'major' },
      dry_run: true,
    });
    const [raw] = answers;
    expect(JSON.stringify(raw).length).toBeGreaterThan(WRITE_BUDGET);
    expect((raw?.created as unknown[]).length).toBeGreaterThan(MAX_LISTED);
    const body = ok(outcome);
    expect(body.created as unknown[]).toHaveLength(MAX_LISTED);
    const sizes = resultSizes(outcome);
    expect(sizes.text + sizes.structured).toBeLessThanOrEqual(WRITE_BUDGET);
  });

  it('puts the way back up front when the result cannot be undone', async () => {
    const { mock, ctx } = await setup();
    const ids = mock.given({ clips: [clip({ durationSec: 900, notes: spread(1200) })] });
    const outcome = await autotune(ctx, {
      clip: need(ids, 'clip.placementId'),
      expected_revision: await revisionOfFirst(ctx),
      mode: 'notesOnly',
      replace_edited_notes: true,
    });
    const body = ok(outcome);
    expect(body.undo).toMatchObject({ undoable: false });
    const sizes = resultSizes(outcome);
    expect(Math.max(sizes.text, sizes.structured)).toBeLessThanOrEqual(WRITE_BUDGET);
    for (const where of [whereIn(outcome, '"undoable":false'), whereIn(outcome, '"kind":"revert"')]) {
      expect(where.text).toBeGreaterThanOrEqual(0);
      expect(where.text).toBeLessThan(FRONT);
      expect(where.structured).toBeLessThan(FRONT);
    }
    // The summary says it first.
    expect(body.summary).toMatch(/^opentune_autotune_range: all notes of the clip were replaced/);
  });

  it('keeps an edit of all 1,200 notes within the budget', async () => {
    const { mock, ctx } = await setup();
    const ids = mock.given({ clips: [clip({ durationSec: 900, notes: spread(1200) })] });
    const outcome = await editNotes(ctx, {
      clip: need(ids, 'clip.placementId'),
      expected_revision: await revisionOfFirst(ctx),
      ops: [
        { op: 'setParams', select: { all: true }, retune_speed: 0.3 },
        { op: 'shiftCents', select: { all: true }, delta_cents: 10 },
      ],
    });
    const body = ok(outcome);
    const sizes = resultSizes(outcome);
    expect(Math.max(sizes.text, sizes.structured)).toBeLessThanOrEqual(OUTPUT_BUDGET);
    expect(body.changes as unknown[]).toHaveLength(MAX_LISTED);
    expect(body.summary).toContain('changed 1200 notes');
    expect(whereIn(outcome, (body.undo as { undoId: string }).undoId).structured).toBeLessThan(FRONT);
  });

  it('keeps a shift of every handle of a long time grid within the budget', async () => {
    const { mock, ctx } = await setup();
    const grid = Array.from({ length: 300 }, (_, i) => ({ bind: `h${String(i)}`, contentSec: i * 2 + 1 }));
    const ids = mock.given({ clips: [clip({ durationSec: 900, timeGrid: grid })] });
    const outcome = await editTiming(ctx, {
      clip: need(ids, 'clip.placementId'),
      expected_revision: await revisionOfFirst(ctx),
      ops: [{ op: 'shift', start_content_sec: 0, end_content_sec: 900, delta_ms: 50 }],
    });
    const body = ok(outcome);
    const sizes = resultSizes(outcome);
    expect(Math.max(sizes.text, sizes.structured)).toBeLessThanOrEqual(OUTPUT_BUDGET);
    expect(body.changes as unknown[]).toHaveLength(MAX_LISTED);
    expect(body.time_grid_handle_count).toBe(300);
    expect(body.time_grid_handles as unknown[]).toHaveLength(MAX_LISTED_HANDLES);
    expect(body.time_grid_handles_truncated).toBe(true);
    expect(whereIn(outcome, (body.undo as { undoId: string }).undoId).structured).toBeLessThan(FRONT);
  });

  it('keeps an edit of 40 clips on the timeline within the budget', async () => {
    const { mock, ctx } = await setup();
    const clips = Array.from({ length: 40 }, (_, i) =>
      clip({ bind: `c${String(i)}`, trackId: i % 4, startTimelineSec: i * 10, durationSec: 8 }),
    );
    const ids = mock.given({ clips });
    const project = ok(await getProject(ctx, {}));
    const outcome = await editArrangement(ctx, {
      expected_revision: project.arrangement_revision as string,
      ops: clips.map((c) => ({ op: 'gain' as const, clip: need(ids, `${c.bind}.placementId`), gain_db: -3 })),
    });
    const body = ok(outcome);
    const sizes = resultSizes(outcome);
    expect(Math.max(sizes.text, sizes.structured)).toBeLessThanOrEqual(OUTPUT_BUDGET);
    expect(body.changes as unknown[]).toHaveLength(MAX_LISTED);
    expect(whereIn(outcome, (body.undo as { undoId: string }).undoId).structured).toBeLessThan(FRONT);
  });
});
