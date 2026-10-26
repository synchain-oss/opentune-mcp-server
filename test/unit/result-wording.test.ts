// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Summaries that must agree with the facts of the same result, through the tools and the mock: the counts of
// a listing that OpenTune cut short, and the sentence about a render that has not finished. The other
// wording fixes are tested with their tools.

import { afterEach, describe, expect, it } from 'vitest';

import { startMock, type OtcpMock } from '../../mock/server.js';
import { MAX_LISTED } from '../../src/render/index.js';
import { autotune, type AutotuneArgs } from '../../src/tools/autotune.js';
import { editNotes } from '../../src/tools/edit-notes.js';
import { getProject } from '../../src/tools/project.js';
import type { Outcome } from '../../src/tools/registry.js';
import { tempDir, testContext, type TestContext } from '../support/context.js';
import { clip, need } from '../support/mock-client.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(): Promise<{ mock: OtcpMock; ctx: TestContext }> {
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

type Body = Record<string, unknown> & { summary: string };
const body = (outcome: Outcome): Body => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.error.kind}(${String(outcome.error.reason)})`);
  return outcome.body;
};

async function revisionOf(ctx: TestContext): Promise<string> {
  const project = body(await getProject(ctx, {}));
  return (project.placements as { clip_revision: string }[])[0]?.clip_revision ?? '';
}

interface ChangeTable {
  rows: unknown[];
  omittedChangeCount: number;
}

describe('a listing that OpenTune cut short', () => {
  it('reports the real totals of AUTO, not the length of the list', async () => {
    const { mock, ctx } = await setup();
    // A long clip: AUTO makes far more notes than the 200 a result lists. The 3 notes it had are replaced.
    const ids = mock.given({ clips: [clip({ durationSec: 520 })] });
    const args: AutotuneArgs = {
      clip: need(ids, 'clip.placementId'),
      expected_revision: await revisionOf(ctx),
      mode: 'regenerate',
      scale: { root: 0, scale: 'major' },
    };
    const out = body(await autotune(ctx, args));
    const noteCount = out.noteCount as { before: number; after: number };
    const omitted = out.omittedCount as { changes: number; created: number; removed: number };
    const listed = (out.created as unknown[]).length;
    const created = listed + omitted.created;
    // OpenTune lists 200 of them; the result lists MAX_LISTED, and counts the rest in omittedCount.
    expect(listed).toBe(MAX_LISTED);
    expect(omitted.created).toBeGreaterThan(0);
    // The facts agree with one another: notes after = notes before - removed + created.
    expect(noteCount.after).toBe(noteCount.before - (out.removed as unknown[]).length + created);
    // The summary uses the real totals, and says that the list is shorter.
    expect(out.summary).toContain(`removed ${String((out.removed as unknown[]).length)} notes`);
    expect(out.summary).toContain(`created ${String(created)} notes`);
    expect(out.summary).toContain(`Only the first ${String(MAX_LISTED)} entries of created are listed.`);
    expect(out.summary).not.toContain('created 200 notes');
    // omittedCount counts, per kind, what OpenTune left out of changes, created and removed. omittedChangeCount of
    // the table counts every entity of the result that is not a row of it: those and the listed ones beyond its
    // rows. Rows plus omittedChangeCount are therefore all the entities of the result.
    const table = out.changeTable as ChangeTable;
    expect(table.rows.length + table.omittedChangeCount).toBe(
      (out.removed as unknown[]).length + created + omitted.removed + omitted.changes,
    );
  });

  it('reports the real total of an edit of more notes than a result lists', async () => {
    const { mock, ctx } = await setup();
    const many = Array.from({ length: 450 }, (_, i) => ({
      startContentSec: i * 0.5,
      endContentSec: i * 0.5 + 0.4,
      targetMidi: 60 + (i % 12),
    }));
    const ids = mock.given({ clips: [clip({ durationSec: 300, notes: many })] });
    const out = body(
      await editNotes(ctx, {
        clip: need(ids, 'clip.placementId'),
        expected_revision: await revisionOf(ctx),
        ops: [{ op: 'shiftCents', select: { all: true }, delta_cents: 10 }],
      }),
    );
    // OpenTune left 250 out of the 200 it listed; the result lists 20, so 430 are left out of it.
    expect(out.omittedChangeCount).toBe(450 - MAX_LISTED);
    expect(out.changes).toHaveLength(MAX_LISTED);
    expect(out.summary).toContain('changed 450 notes');
    expect(out.summary).toContain(`Only the first ${String(MAX_LISTED)} entries of changes are listed.`);
    expect(out.summary).not.toContain('more not listed');
    const table = out.changeTable as ChangeTable;
    expect(table.rows.length + table.omittedChangeCount).toBe(450);
  });

  it('does not add a note about the list when everything is listed', async () => {
    const { mock, ctx } = await setup();
    const ids = mock.given({ clips: [clip()] });
    const out = body(
      await editNotes(ctx, {
        clip: need(ids, 'clip.placementId'),
        expected_revision: await revisionOf(ctx),
        ops: [{ op: 'shiftCents', select: { all: true }, delta_cents: 10 }],
      }),
    );
    expect(out.summary).toContain('changed 3 notes');
    expect(out.summary).not.toContain('listed');
  });
});

describe('a result that queued a render', () => {
  it('tells that playback can still sound the old way, where to look, and that an export waits', async () => {
    const { mock, ctx } = await setup();
    const ids = mock.given({ clips: [clip()] });
    const edit = body(
      await editNotes(ctx, {
        clip: need(ids, 'clip.placementId'),
        expected_revision: await revisionOf(ctx),
        ops: [{ op: 'shiftCents', select: { all: true }, delta_cents: 10 }],
      }),
    );
    expect(edit.sideEffects).toHaveProperty('reRenderQueued');
    expect(edit.summary).toContain(
      'OpenTune is rendering again: playback can still sound the old way until render.current of opentune_get_clip_details is true, and an export waits for the render by itself.',
    );
    const auto = body(
      await autotune(ctx, {
        clip: need(ids, 'clip.placementId'),
        expected_revision: await revisionOf(ctx),
        mode: 'regenerate',
        scale: { root: 0, scale: 'major' },
      }),
    );
    expect(auto.summary).toContain('OpenTune is rendering again');
  });

  it('says nothing about a render in a dry run', async () => {
    const { mock, ctx } = await setup();
    const ids = mock.given({ clips: [clip()] });
    const out = body(
      await editNotes(ctx, {
        clip: need(ids, 'clip.placementId'),
        expected_revision: await revisionOf(ctx),
        dry_run: true,
        ops: [{ op: 'shiftCents', select: { all: true }, delta_cents: 10 }],
      }),
    );
    expect(out.summary).toContain('dry run');
    expect(out.summary).not.toContain('rendering again');
  });
});
