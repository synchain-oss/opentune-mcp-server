// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Golden snapshots of what the project save tools return, one file per scenario in test/golden/project-files:
// the tool, the arguments and the MCP result (structuredContent) after the tool ran against the mock. The
// project files of the mock live in temporary folders, which the snapshots show as <tmp-1> and <tmp-2> with
// forward slashes.
// With OPENTUNE_MCP_UPDATE_CATALOG=1 (npm run catalog:update) the files are rewritten; a change to them is a
// contract change.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startMock } from '../../mock/server.js';
import { MEDIA_COPY_BUDGET_MS, nodeProjectFs, type ProjectFs } from '../../src/files/project-folders.js';
import { TOOLS } from '../../src/tools/index.js';
import { render, type ToolContext, type ToolDefinition } from '../../src/tools/registry.js';
import { tempDir, testContext } from '../support/context.js';
import { clip, need } from '../support/mock-client.js';

const UPDATE = process.env.OPENTUNE_MCP_UPDATE_CATALOG === '1';
const DIR = new URL('../golden/project-files/', import.meta.url);
const INSTANCE = '0123456789abcdef0123456789abcdef';
/** The clock of the scenarios: a local time, so that the time stamp in the name of an old version does not depend on the zone. */
const NOW = new Date(2026, 9, 28, 14, 5, 9).getTime();

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

/**
 * The snapshot of a value with each folder of the test named by its number (<tmp-1>, <tmp-2>), the separators
 * of such a path turned into forward slashes, and the sizes of the files left out.
 */
function neutral(value: unknown, folders: readonly string[], key = ''): unknown {
  if (typeof value === 'string') {
    const at = folders.findIndex((folder) => value.includes(folder));
    if (at < 0) return value;
    return value.replaceAll(folders[at] ?? '', `<tmp-${String(at + 1)}>`).replaceAll('\\', '/');
  }
  if (typeof value === 'number' && key === 'sizeBytes') return '<size>';
  if (Array.isArray(value)) return value.map((v) => neutral(v, folders));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, neutral(v, folders, k)]));
  }
  return value;
}

async function scenarios(): Promise<Record<string, Scenario>> {
  const out: Record<string, Scenario> = {};
  const t = tempDir();
  cleanup.push(t.remove);
  const mock = await startMock({ discoveryDir: t.dir, instanceId: INSTANCE });
  cleanup.push(() => mock.stop());
  const ctx = testContext(t.dir, { now: NOW });
  cleanup.push(() => {
    ctx.instances.close();
  });
  const ids = mock.given({
    files: [
      { bind: 'fresh', kind: 'absent', extension: '.otproj' },
      { bind: 'existing', kind: 'project', durationSec: 3 },
    ],
    clips: [clip()],
    dirty: true,
  });
  const folders = [path.dirname(need(ids, 'fresh')), path.dirname(need(ids, 'existing'))];
  // A file system that cannot copy audio, for the scenario in which the audio of an old version is not complete.
  const noAudioCopy: ProjectFs = {
    ...nodeProjectFs,
    copyNew: (from, to) =>
      path.basename(path.dirname(from)) === 'Project_Media'
        ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
        : nodeProjectFs.copyNew(from, to),
  };
  const failing = testContext(t.dir, { now: NOW, files: noAudioCopy });
  cleanup.push(() => {
    failing.instances.close();
  });
  // A file system on which copying audio takes the whole time budget of the copy, for the scenario in which the time runs out.
  let late = 0;
  const slowAudioCopy: ProjectFs = {
    ...nodeProjectFs,
    copyNew: async (from, to) => {
      await nodeProjectFs.copyNew(from, to);
      if (path.basename(path.dirname(from)) === 'Project_Media') late += MEDIA_COPY_BUDGET_MS;
    },
  };
  const slow = testContext(t.dir, { now: () => NOW + late, files: slowAudioCopy });
  cleanup.push(() => {
    slow.instances.close();
  });
  const run = async (
    id: string,
    description: string,
    name: string,
    input: Record<string, unknown>,
    using: ToolContext = ctx,
  ) => {
    const result = render(await tool(name).run(tool(name).inputSchema.parse(input), using)).structuredContent;
    out[id] = {
      description,
      tool: name,
      input: neutral(input, folders) as Record<string, unknown>,
      result: neutral(result, folders),
    };
  };
  await run(
    'save-as-new-file',
    'The first save to a new place: a new file is written, and the audio is copied next to it.',
    'opentune_save_project',
    { mode: 'save_as', path: need(ids, 'fresh'), wait_seconds: 10 },
  );
  await run(
    'autosave',
    'An autosave copy of a project that has a file: a numbered copy in the autosave folder next to it; the project file and its unsaved-changes flag do not change.',
    'opentune_save_project',
    { mode: 'autosave', wait_seconds: 10 },
  );
  await run(
    'save-current-file',
    'A later save to the same file: the previous content is replaced and kept as an old version; the media copy follows the facts.',
    'opentune_save_project',
    { mode: 'save', wait_seconds: 10 },
  );
  await run(
    'save-overwrite-other-file',
    'Replacing another project file: destructive, the replaced file is kept as an old version next to it, and the audio is copied next to it too.',
    'opentune_save_project_overwrite',
    { path: need(ids, 'existing'), confirm: true, wait_seconds: 10 },
  );
  // The project file is now the one that was replaced, and has audio next to it.
  const media = path.join(path.dirname(need(ids, 'existing')), 'Project_Media');
  mkdirSync(media);
  writeFileSync(path.join(media, '1.wav'), 'audio');
  await run(
    'save-copies-audio-for-old-version',
    'A save when the project folder has audio: the old version gets a copy of it in its own Project_Media folder, so it still opens when the original audio is gone.',
    'opentune_save_project',
    { mode: 'save', wait_seconds: 10 },
  );
  writeFileSync(path.join(media, '2.wav'), 'audio');
  await run(
    'save-audio-not-copied',
    'A save when some audio could not be copied: the save happens, and the result lists the file in oldVersion.media and carries a warning line made by this server.',
    'opentune_save_project',
    { mode: 'save', wait_seconds: 10 },
    failing,
  );
  writeFileSync(path.join(media, '3.wav'), 'audio');
  await run(
    'save-audio-time-ran-out',
    'A save when the copy of the audio used up its time: the files copied so far are kept, the files left are listed in oldVersion.media with timedOut true and a warning line made by this server, and the next save copies them.',
    'opentune_save_project',
    { mode: 'save', wait_seconds: 10 },
    slow,
  );
  return out;
}

const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe('project save tool result golden snapshots', () => {
  it('matches the files in test/golden/project-files', async () => {
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

  it('shows nothing of the machine in the snapshots', async () => {
    const all = JSON.stringify(await scenarios());
    expect(all).toContain('<tmp-1>/Project_Media');
    expect(all).toContain('<tmp-2>/Project_Media');
    expect(all).toContain('.autosave/Project_Media');
    expect(all).toContain('.oldversion/');
    // No backslash of a Windows path (a JSON backslash is two characters), no drive letter, no folder of a user.
    expect(all).not.toContain('\\\\');
    expect(all).not.toMatch(/"[A-Za-z]:\//);
    expect(all).not.toMatch(/\/(?:tmp|var|home|Users)\//);
  });
});
