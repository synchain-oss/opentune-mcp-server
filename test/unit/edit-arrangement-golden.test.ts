// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Golden snapshots of what opentune_edit_arrangement returns, one file per scenario in
// test/golden/arrangement: the arguments and the MCP result (structuredContent) after the tool ran
// against the mock. They freeze the summary (whose first sentence must say when a split, merge or
// delete cannot be undone), the rendering, the envelope and the errors with their next steps. With
// OPENTUNE_MCP_UPDATE_CATALOG=1 (npm run catalog:update) the files are rewritten; a change to them
// is a contract change.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { startMock } from '../../mock/server.js';
import { editArrangementTool } from '../../src/tools/edit-arrangement.js';
import { getProject } from '../../src/tools/project.js';
import { render } from '../../src/tools/registry.js';
import { tempDir, testContext } from '../support/context.js';
import { clip } from '../support/mock-client.js';

const UPDATE = process.env.OPENTUNE_MCP_UPDATE_CATALOG === '1';
const DIR = new URL('../golden/arrangement/', import.meta.url);
const INSTANCE = '0123456789abcdef0123456789abcdef';
const REVISION = '<arrangement_revision>';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface Scenario {
  readonly description: string;
  readonly input: Record<string, unknown>;
  readonly result: unknown;
}

async function scenarios(): Promise<Record<string, Scenario>> {
  const t = tempDir();
  cleanup.push(t.remove);
  const mock = await startMock({ discoveryDir: t.dir, instanceId: INSTANCE });
  cleanup.push(() => mock.stop());
  const ctx = testContext(t.dir);
  cleanup.push(() => {
    ctx.instances.close();
  });
  const ids = mock.given({
    dirty: false,
    clips: [
      clip({ bind: 'a', startTimelineSec: 0, durationSec: 4, fadeInSec: 0.5, fadeOutSec: 1.5 }),
      clip({ bind: 'b', trackId: 1, startTimelineSec: 2, durationSec: 4 }),
      clip({ bind: 'c', trackId: 2, startTimelineSec: 10, durationSec: 3 }),
    ],
  });
  const a = ids['a.placementId'] ?? '';
  const b = ids['b.placementId'] ?? '';
  const c = ids['c.placementId'] ?? '';

  const arrangement = async (): Promise<string> => {
    const project = await getProject(ctx, {});
    if (!project.ok) throw new Error('project');
    return project.body.arrangement_revision as string;
  };
  const out: Record<string, Scenario> = {};
  const run = async (id: string, description: string, input: Record<string, unknown>) => {
    const args = editArrangementTool.inputSchema.parse({ ...input, expected_revision: await arrangement() });
    const result = render(await editArrangementTool.run(args, ctx)).structuredContent;
    out[id] = { description, input: { ...input, expected_revision: REVISION }, result };
    return result as Record<string, unknown>;
  };

  await run('edit-several-ops', 'Gain, fade and a move to a hidden track in one undo step.', {
    ops: [
      { op: 'gain', clip: b, gain_db: -6 },
      { op: 'fade', clip: b, fade_in_sec: 0.25 },
      { op: 'move', clip: b, to_track_id: 5 },
    ],
  });
  await run('trim-fades', 'A trim that shortens the fades: FADES_RECLAMPED, and the undo step restores them.', {
    ops: [{ op: 'trim', clip: a, edge: 'end', to_timeline_sec: 1.5 }],
  });
  await run('split-dry-run', 'A preview of a split: the first sentence says applying it cannot be undone.', {
    ops: [{ op: 'split', clip: c, at_timeline_sec: 11.504 }],
    dry_run: true,
  });
  const split = await run('split', 'A split: the first sentence says it cannot be undone, and why.', {
    ops: [{ op: 'split', clip: c, at_timeline_sec: 11.504 }],
  });
  const [left, right] = (split.clip_ids as { created: string[] }).created;
  await run('merge', 'Merging the two parts again: cannot be undone either.', {
    ops: [{ op: 'merge', leading_clip: left, trailing_clip: right }],
  });
  await run('split-out-of-range', 'A split outside the clip: an error with a next step.', {
    ops: [{ op: 'split', clip: a, at_timeline_sec: 30 }],
  });
  await run('copy-mixed-refused', 'copy together with an undoable op: refused before anything is sent.', {
    ops: [
      { op: 'copy', clips: [a], mode: 'window', to_track_id: 3, start_timeline_sec: 20 },
      { op: 'gain', clip: a, gain_db: -3 },
    ],
  });
  await run('copy', 'A copy: not undoable, and removing the copies again needs the user to agree.', {
    ops: [{ op: 'copy', clips: [a], mode: 'full', to_track_id: 0, start_timeline_sec: 0 }],
  });
  await run('delete-confirm-required', 'A delete without confirm: an error that asks the user.', {
    ops: [{ op: 'delete', clips: [a] }],
  });
  await run('delete-dry-run', 'A preview of a delete: says it cannot be undone and needs confirm.', {
    ops: [{ op: 'delete', clips: [a] }],
    dry_run: true,
  });
  // An instance whose delete result carries IRREVERSIBLE but not the undo defect of OpenTune: the
  // mock always reports the defect, so this one answer is scripted. Nothing in the mock changes.
  const scan = await ctx.instances.scan();
  if (!('instances' in scan) || scan.instances[0] === undefined) throw new Error('no instance');
  const session = await ctx.instances.session(scan.instances[0]);
  const original = session.call.bind(session);
  session.call = (method, params, timeoutMs) => {
    if (method !== 'arrangement.edit') return original(method, params, timeoutMs);
    return Promise.resolve({
      applied: true,
      noOp: false,
      dryRun: false,
      changes: [],
      created: [],
      removed: [{ entity: 'placement', ref: { placementId: a }, label: 'Clip 1 on Track 1' }],
      idMap: [],
      revisionDiff: { arrangement: { before: 'a1', after: 'a2' }, trackState: null, contents: [] },
      tokens: { arrangementRevision: 'a2', contents: [], placements: [] },
      undo: { undoable: false, reason: 'no_upstream_undo', revert: null },
      dirty: { before: true, after: true },
      ui: null,
      sideEffects: {},
      warnings: [{ code: 'IRREVERSIBLE', subject: null, data: null }],
      job: null,
    });
  };
  try {
    await run(
      'delete-irreversible-without-defect',
      'A delete whose result is IRREVERSIBLE without the undo defect of OpenTune: the first sentence still says it cannot be undone.',
      { ops: [{ op: 'delete', clips: [a] }], confirm: true },
    );
  } finally {
    session.call = original;
  }
  await run('delete', 'A delete with consent: cannot be undone or restored, said first.', {
    ops: [{ op: 'delete', clips: [a] }],
    confirm: true,
  });
  await run('copy-duplicate-clips', 'A copy that names the same clip twice: it is copied once.', {
    ops: [{ op: 'copy', clips: [b, b], mode: 'full', to_track_id: 3, start_timeline_sec: 20 }],
  });
  return out;
}

const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe('opentune_edit_arrangement result golden snapshots', () => {
  it('matches the files in test/golden/arrangement', async () => {
    const all = await scenarios();
    const files = Object.fromEntries(Object.entries(all).map(([id, s]) => [`${id}.json`, text(s)]));
    if (UPDATE) {
      mkdirSync(DIR, { recursive: true });
      for (const name of readdirSync(DIR)) if (!(name in files)) rmSync(new URL(name, DIR));
      for (const [name, content] of Object.entries(files)) writeFileSync(new URL(name, DIR), content);
    }
    expect(readdirSync(DIR).sort()).toEqual(Object.keys(files).sort());
    for (const [name, content] of Object.entries(files)) {
      expect(readFileSync(new URL(name, DIR), 'utf8'), `${name} is out of date; run npm run catalog:update`).toBe(
        content,
      );
    }
  });
});
