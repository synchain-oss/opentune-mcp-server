// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Golden snapshots of what the track, transport and window tools return, one file per scenario in
// test/golden/track-tools: the tool, the arguments and the MCP result (structuredContent) after the
// tool ran against the mock, errors with their next steps included. With
// OPENTUNE_MCP_UPDATE_CATALOG=1 (npm run catalog:update) the files are rewritten; a change to them
// is a contract change.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { ManualClock } from '../../mock/clock.js';
import { startMock } from '../../mock/server.js';
import { TOOLS } from '../../src/tools/index.js';
import { render, type ToolContext, type ToolDefinition } from '../../src/tools/registry.js';
import { tempDir, testContext } from '../support/context.js';
import { clipWithoutNotes } from '../support/clip-without-notes.js';
import { clip } from '../support/mock-client.js';

const UPDATE = process.env.OPENTUNE_MCP_UPDATE_CATALOG === '1';
const DIR = new URL('../golden/track-tools/', import.meta.url);
const INSTANCE = '0123456789abcdef0123456789abcdef';
const ARRANGEMENT = '<arrangement_revision from opentune_get_project>';

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

const tool = (name: string): ToolDefinition => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
};

async function world(given: Parameters<Awaited<ReturnType<typeof startMock>>['given']>[0]) {
  const t = tempDir();
  cleanup.push(t.remove);
  const mock = await startMock({ discoveryDir: t.dir, instanceId: INSTANCE, clock: new ManualClock() });
  cleanup.push(() => mock.stop());
  const ctx = testContext(t.dir);
  cleanup.push(() => {
    ctx.instances.close();
  });
  const ids = mock.given(given);
  return { ctx, ids };
}

const arrangement = async (ctx: ToolContext): Promise<string> => {
  const project = await tool('opentune_get_project').run({}, ctx);
  if (!project.ok) throw new Error('project');
  return project.body.arrangement_revision as string;
};

async function scenarios(): Promise<Record<string, Scenario>> {
  const out: Record<string, Scenario> = {};
  const run = async (
    ctx: ToolContext,
    id: string,
    description: string,
    name: string,
    input: Record<string, unknown>,
    withArrangement = false,
  ) => {
    const args = withArrangement ? { ...input, expected_revision: await arrangement(ctx) } : input;
    const result = render(await tool(name).run(tool(name).inputSchema.parse(args), ctx)).structuredContent;
    out[id] = {
      description,
      tool: name,
      input: withArrangement ? { ...input, expected_revision: ARRANGEMENT } : input,
      result,
    };
    return result as Record<string, unknown>;
  };

  {
    const { ctx } = await world({ clips: [clip()] });
    await run(
      ctx,
      'set-tracks-mute-volume',
      'Mute and volume: not undoable, with the way back.',
      'opentune_set_tracks',
      {
        ops: [
          { op: 'mute', track_id: 1, on: true },
          { op: 'volume', track_id: 1, db: -6 },
        ],
      },
    );
    await run(
      ctx,
      'set-tracks-reveal-and-solo',
      'Two requests in one call, reported one by one.',
      'opentune_set_tracks',
      {
        ops: [{ op: 'reveal' }, { op: 'solo', track_id: 0, on: true }],
      },
    );
    await run(ctx, 'set-tracks-duplicate', 'A copy: the way back is the deletion of the copy.', 'opentune_set_tracks', {
      ops: [{ op: 'duplicate', track_id: 0 }],
    });
    await run(ctx, 'set-tracks-unknown-track', 'A track id that names no slot.', 'opentune_set_tracks', {
      ops: [{ op: 'mute', track_id: 40, on: true }],
    });
  }
  {
    const { ctx } = await world({ clips: [clip(), clip({ bind: 'hidden', trackId: 4 })], visibleTrackCount: 4 });
    await run(
      ctx,
      'set-tracks-duplicate-occupied',
      'The target slot holds clips: choose another target.',
      'opentune_set_tracks',
      {
        ops: [{ op: 'duplicate', track_id: 0 }],
      },
    );
  }
  {
    const { ctx } = await world({
      clips: [
        clip({ bind: 'a', trackId: 0 }),
        clip({ bind: 'b', trackId: 1 }),
        clip({ bind: 'c', trackId: 2, startTimelineSec: 10 }),
      ],
      history: { undo: [{ origin: 'ui', action: 'noteEdit', clip: 'a' }], redo: [] },
    });
    await run(
      ctx,
      'delete-track-refused',
      'No confirm: nothing is deleted, the user is asked.',
      'opentune_delete_track',
      {
        track_id: 1,
        confirm: false,
      },
      true,
    );
    await run(
      ctx,
      'delete-track',
      'The deletion: irreversible, later ids moved, the history affected.',
      'opentune_delete_track',
      {
        track_id: 1,
        confirm: true,
      },
      true,
    );
    await run(
      ctx,
      'delete-track-hidden',
      'The old last id now names a hidden track.',
      'opentune_delete_track',
      {
        track_id: 3,
        confirm: true,
      },
      true,
    );
  }
  {
    const { ctx } = await world({ clips: [clip(), clip({ bind: 'b', trackId: 1 })] });
    const stale = await arrangement(ctx);
    await tool('opentune_set_tracks').run(
      tool('opentune_set_tracks').inputSchema.parse({ ops: [{ op: 'duplicate', track_id: 0 }] }),
      ctx,
    );
    const result = render(
      await tool('opentune_delete_track').run(
        tool('opentune_delete_track').inputSchema.parse({ track_id: 1, confirm: true, expected_revision: stale }),
        ctx,
      ),
    ).structuredContent;
    out['delete-track-conflict'] = {
      description: 'The arrangement changed since it was read: nothing deleted, read again.',
      tool: 'opentune_delete_track',
      input: { track_id: 1, confirm: true, expected_revision: ARRANGEMENT },
      result,
    };
  }
  {
    const { ctx } = await world({ clips: [clip()], audio: { running: false } });
    await run(ctx, 'transport-seek-play', 'Seek and play without an audio device.', 'opentune_transport', {
      action: 'seek',
      position_sec: 2.5,
      bpm: 96,
      time_signature: { numerator: 6, denominator: 8 },
      loop: true,
    });
    const play = tool('opentune_transport');
    await play.run(play.inputSchema.parse({ action: 'play' }), ctx);
    await run(ctx, 'transport-return', 'Back to the last start.', 'opentune_transport', {
      action: 'return_to_last_start',
    });
    await run(
      ctx,
      'transport-seek-needs-position',
      'A seek without a position: nothing is sent.',
      'opentune_transport',
      {
        action: 'seek',
      },
    );
  }
  {
    const { ctx, ids } = await world({
      editingScheme: 'openDyne',
      clips: [clipWithoutNotes({ bind: 'a', trackId: 0, key: { root: 7, scale: 'major' } })],
      onboarding: 'notShown',
      dialogs: [{ kind: 'trackColour', trackId: 1, colour: '#445566' }],
    });
    await run(
      ctx,
      'manage-ui-dismiss-refused',
      'A dialog commits its colour on close: refused without consent.',
      'opentune_manage_ui',
      {
        op: 'dismiss_dialogs',
      },
    );
    await run(
      ctx,
      'manage-ui-dismiss-commit',
      'With the users consent the colour is committed.',
      'opentune_manage_ui',
      {
        op: 'dismiss_dialogs',
        accept_commit: true,
      },
    );
    const placement = ids['a.placementId'] ?? '';
    await run(
      ctx,
      'manage-ui-focus-dry-run',
      'The prediction: notes would be generated, the scale changes.',
      'opentune_manage_ui',
      {
        op: 'focus_clip',
        clip: placement,
        dry_run: true,
      },
    );
    await run(
      ctx,
      'manage-ui-focus',
      'The report: what happened beyond the selection comes first.',
      'opentune_manage_ui',
      {
        op: 'focus_clip',
        clip: placement,
        open_editor: true,
      },
    );
    await run(
      ctx,
      'manage-ui-dismiss-onboarding',
      'The global setting is changed and cannot be undone.',
      'opentune_manage_ui',
      {
        op: 'dismiss_onboarding',
      },
    );
  }
  {
    const { ctx } = await world({ clips: [clip()], dirty: false });
    await run(
      ctx,
      'manage-ui-switch-view-piano-roll',
      'The piano roll with no clip selected: only the view changes, and the roll is empty.',
      'opentune_manage_ui',
      { op: 'switch_view', view: 'piano_roll' },
    );
    await run(
      ctx,
      'manage-ui-switch-view-noop',
      'The window already shows the piano roll: nothing changes.',
      'opentune_manage_ui',
      { op: 'switch_view', view: 'piano_roll' },
    );
    await run(
      ctx,
      'manage-ui-switch-view',
      'Closing the piano roll: back to the arrangement view, with the call that opens it again.',
      'opentune_manage_ui',
      { op: 'switch_view', view: 'arrangement' },
    );
    await run(
      ctx,
      'manage-ui-switch-view-missing-view',
      'switch_view without a view: nothing is sent.',
      'opentune_manage_ui',
      { op: 'switch_view' },
    );
  }
  {
    const { ctx } = await world({ clips: [clip()], withoutCapabilities: ['ui.workspace'] });
    await run(
      ctx,
      'manage-ui-switch-view-unsupported',
      'A build without ui.workspace: the user switches the view in the window.',
      'opentune_manage_ui',
      { op: 'switch_view', view: 'arrangement' },
    );
  }
  {
    const { ctx } = await world({ dirty: true });
    await run(
      ctx,
      'quit-unsaved-refused',
      'Unsaved changes: nothing is closed, and the next step is to save first (the project has no file yet).',
      'opentune_quit',
      {},
    );
    await run(
      ctx,
      'quit-discard',
      'Closed over unsaved changes with the consent of the user: the first sentence says they are lost.',
      'opentune_quit',
      { discard_unsaved: true },
    );
  }
  {
    const { ctx } = await world({ clips: [clip()], dirty: false });
    await run(
      ctx,
      'quit',
      'Nothing to lose: closed, and the instance is gone before the result comes back.',
      'opentune_quit',
      {},
    );
  }
  {
    const { ctx } = await world({ jobs: [{ bind: 'job', kind: 'prefsApply', state: 'running', cancellable: false }] });
    await run(ctx, 'quit-busy', 'A job has not finished: nothing is closed.', 'opentune_quit', {});
  }
  {
    const { ctx } = await world({ withoutCapabilities: ['app.quit'] });
    await run(
      ctx,
      'quit-unsupported',
      'A build without app.quit: nothing is sent; the user closes the window after the project is saved.',
      'opentune_quit',
      {},
    );
  }
  return out;
}

const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe('track, transport and window tool result golden snapshots', () => {
  it('matches the files in test/golden/track-tools', async () => {
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
