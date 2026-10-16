// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Output budget of the read tools: a single result stays within 20,000 characters, as the client
// receives it, for a clip of 800 notes and for a project with many clips. `npm run gates` runs this
// file as its "output budget" check.

import { afterEach, describe, expect, it } from 'vitest';

import { startMock } from '../../mock/server.js';
import { getClipDetails } from '../../src/tools/clip-details.js';
import { getNotes, OUTPUT_BUDGET } from '../../src/tools/notes.js';
import { getProject } from '../../src/tools/project.js';
import { render, type Outcome } from '../../src/tools/registry.js';
import { getSettings } from '../../src/tools/settings.js';
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
  });

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
