// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Golden snapshots of what the edit tools return, one file per scenario in test/golden/edit-tools:
// the tool, the arguments and the MCP result (structuredContent) after the tool ran against the
// mock. Unlike test/golden/render, which freezes the renderer on its own, these freeze the whole
// tool result: the summary, the rendering, the envelope and the errors with their next steps.
// With OPENTUNE_MCP_UPDATE_CATALOG=1 (npm run catalog:update) the files are rewritten; a change to
// them is a contract change.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { startMock } from '../../mock/server.js';
import { TOOLS } from '../../src/tools/index.js';
import { render, type ToolDefinition } from '../../src/tools/registry.js';
import { tempDir, testContext } from '../support/context.js';
import { clip } from '../support/mock-client.js';

const UPDATE = process.env.OPENTUNE_MCP_UPDATE_CATALOG === '1';
const DIR = new URL('../golden/edit-tools/', import.meta.url);
const INSTANCE = '0123456789abcdef0123456789abcdef';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface Scenario {
  readonly description: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly result: unknown;
}

const REVISION = '<clip_revision of the clip>';

async function scenarios(): Promise<Record<string, Scenario>> {
  const t = tempDir();
  cleanup.push(t.remove);
  const mock = await startMock({ discoveryDir: t.dir, instanceId: INSTANCE });
  cleanup.push(() => mock.stop());
  const ctx = testContext(t.dir);
  cleanup.push(() => {
    ctx.instances.close();
  });
  const notes = [
    { startContentSec: 0.5, endContentSec: 1.5, targetMidi: 64 },
    { startContentSec: 2, endContentSec: 3, targetMidi: 69 },
    { startContentSec: 3.5, endContentSec: 4.5, targetMidi: 69.3 },
  ];
  const ids = mock.given({ dirty: false, clips: [clip({ key: { root: 9, scale: 'minor' }, notes })] });
  const placement = ids['clip.placementId'] ?? '';

  const tool = (name: string): ToolDefinition => {
    const found = TOOLS.find((t) => t.name === name);
    if (found === undefined) throw new Error(`no tool ${name}`);
    return found;
  };
  const out: Record<string, Scenario> = {};
  const revision = async (): Promise<string> => {
    const project = await tool('opentune_get_project').run({}, ctx);
    if (!project.ok) throw new Error('project');
    return (project.body.placements as { clip_revision: string }[])[0]?.clip_revision ?? '';
  };
  const run = async (id: string, description: string, name: string, input: Record<string, unknown>) => {
    const writes = !name.endsWith('undo') && !name.endsWith('redo');
    const args = writes ? { ...input, expected_revision: await revision() } : input;
    const result = render(await tool(name).run(tool(name).inputSchema.parse(args), ctx)).structuredContent;
    out[id] = { description, tool: name, input: writes ? { ...input, expected_revision: REVISION } : input, result };
    return result as Record<string, unknown>;
  };

  await run(
    'set-clip-pitch-shift',
    'A pitch shift: one undo step, KEY_NOT_TRANSPOSED, rendering queued again.',
    'opentune_set_clip',
    {
      clip: placement,
      pitch_shift: { semitones: 2, cents: -10 },
    },
  );
  await run('set-clip-both', 'Key and pitch shift: two requests, reported one by one.', 'opentune_set_clip', {
    clip: placement,
    key: { root: 0, scale: 'major' },
    pitch_shift: { semitones: 0, cents: 0 },
  });
  await run('set-clip-key', 'A key change: not undoable, with the way back.', 'opentune_set_clip', {
    clip: placement,
    key: { root: 2, scale: 'dorian' },
  });
  await run(
    'autotune-regenerate',
    'AUTO regenerate in one range with an explicit scale and one parameter.',
    'opentune_autotune_range',
    {
      clip: placement,
      mode: 'regenerate',
      scale: { root: 0, scale: 'major' },
      ranges: [{ from_sec: 0, to_sec: 3 }],
      retune_speed: 0.2,
    },
  );
  await run('autotune-dry-run', 'A preview of snapNotes: nothing applied.', 'opentune_autotune_range', {
    clip: placement,
    mode: 'snapNotes',
    scale: 'clip',
    dry_run: true,
  });
  await run('autotune-notes-only-refused', 'notesOnly without consent: nothing is sent.', 'opentune_autotune_range', {
    clip: placement,
    mode: 'notesOnly',
  });
  await run('edit-notes-condition', 'A condition resolved to indexes before one undo step.', 'opentune_edit_notes', {
    clip: placement,
    ops: [{ op: 'setParams', select: { off_target_cents_over: 100 }, retune_speed: 0.9 }],
  });
  const edited = await run('edit-notes-snap', 'Several ops in one undo step.', 'opentune_edit_notes', {
    clip: placement,
    ops: [
      { op: 'shiftCents', select: { indices: [0] }, delta_cents: -20 },
      { op: 'snapToScale', select: { all: true }, scale: 'clip' },
    ],
  });
  const undoId = (edited.undo as { undoId: string }).undoId;
  await run('undo-conflict', 'The named step is not on top: UNDO_CONFLICT, ask the user.', 'opentune_undo', {
    undo_id: 'u:01234567:9999',
  });
  await run('undo-step', 'Undo of the named step; the result gives the redo.', 'opentune_undo', { undo_id: undoId });
  await run('redo-step', 'Redo of the same step; the result gives the undo.', 'opentune_redo', { undo_id: undoId });
  await run(
    'autotune-notes-only',
    'notesOnly with consent: all notes replaced, first sentence says so.',
    'opentune_autotune_range',
    {
      clip: placement,
      mode: 'notesOnly',
      replace_edited_notes: true,
    },
  );
  return out;
}

const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe('edit tool result golden snapshots', () => {
  it('matches the files in test/golden/edit-tools', async () => {
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
