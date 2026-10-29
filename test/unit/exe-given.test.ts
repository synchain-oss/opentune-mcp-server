// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The preconditions and runner names the exe target builds through public calls (test/contract/
// exe-given.ts), run against the mock in place of an executable: what the constructors make reads back
// as the vector describes it, and what they cannot make is a skipped precondition with its reason.

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { WorkFiles } from '../../mock/files.js';
import { startMock, type OtcpMock } from '../../mock/server.js';
import { parseDiscoveryFile } from '../../src/discovery/file.js';
import { OtcpSession, type Json } from '../../src/otcp/client.js';
import { OtcpError } from '../../src/errors/tool-error.js';
import {
  EXACT_CONTENT,
  establishExeGiven,
  readRunnerValues,
  unsupportedReason,
  type GivenEnv,
} from '../contract/exe-given.js';
import { PreconditionUnavailable } from '../contract/target.js';
import { loadVectors } from '../contract/vectors.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface Setup {
  readonly mock: OtcpMock;
  readonly session: OtcpSession;
  readonly files: WorkFiles;
  readonly env: GivenEnv;
}

async function setup(capabilities?: readonly string[]): Promise<Setup> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ot-given-test-'));
  const mock = await startMock({ discoveryDir: dir });
  const parsed = parseDiscoveryFile(`${String(mock.discovery.pid)}.json`, await readFile(mock.discoveryPath));
  if (!parsed.ok) throw new Error(parsed.problem);
  const session = await OtcpSession.open(parsed.entry, 15_000);
  const files = new WorkFiles();
  cleanup.push(async () => {
    session.close();
    files.dispose();
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const env: GivenEnv = {
    rpc: session,
    files,
    capabilities: capabilities ?? mock.capabilities,
    saveTarget: () => files.provide({ bind: 'saved', kind: 'absent', extension: '.otproj' }).saved ?? '',
  };
  return { mock, session, files, env };
}

const READY_CLIP = { bind: 'clip', trackId: 0, startTimelineSec: 2, durationSec: 6, analysis: 'ready' };

describe('which preconditions the exe target can make', () => {
  it('accepts clips, dirty, files, history and visibleTrackCount in the forms it can build', () => {
    expect(
      unsupportedReason({
        clips: [READY_CLIP],
        dirty: false,
        files: [{ bind: 'f', kind: 'audio', durationSec: 1 }],
        visibleTrackCount: 'all',
        history: { undo: [{ bind: 'u', origin: 'control', action: 'clipMove', clip: 'clip' }], redo: [] },
      }),
    ).toBeUndefined();
  });

  it.each([
    [{ audio: { running: true } }, 'given.audio'],
    [{ dialogs: [{ kind: 'message' }] }, 'given.dialogs'],
    [{ onboarding: 'showing' }, 'given.onboarding'],
    [{ keyboardFocus: 'tempoField' }, 'given.keyboardFocus'],
    [{ dirty: false, keyboardFocus: 'tempoField' }, 'where its keyboard focus is'],
    [{ editingScheme: 'openDyne' }, 'given.editingScheme'],
    [{ preferences: { tuningHz: 442 } }, 'given.preferences'],
    [{ jobs: [] }, 'given.jobs'],
    [{ withoutCapabilities: ['export.v1'] }, 'given.withoutCapabilities'],
    [{ files: [{ bind: 'f', kind: 'noAccess' }] }, 'noAccess'],
    [{ files: [{ bind: 'f', kind: 'project' }] }, 'project'],
    [{ clips: [{ ...READY_CLIP, analysis: 'running' }] }, 'running'],
    [{ clips: [{ ...READY_CLIP, analysis: 'failed' }] }, 'failed'],
    [{ clips: [{ ...READY_CLIP, notes: [] }] }, EXACT_CONTENT],
    [{ clips: [{ ...READY_CLIP, key: { root: 9, scale: 'minor' } }] }, EXACT_CONTENT],
    [{ clips: [{ ...READY_CLIP, fadeInSec: 0.5 }] }, EXACT_CONTENT],
    [{ clips: [READY_CLIP], history: { undo: [{ origin: 'ui', action: 'clipMove', clip: 'clip' }], redo: [] } }, 'UI'],
    [
      {
        clips: [READY_CLIP],
        history: { undo: [{ origin: 'control', action: 'noteEdit', clip: 'clip' }], redo: [] },
      },
      'noteEdit',
    ],
    [
      {
        clips: [READY_CLIP],
        history: { undo: [{ origin: 'control', action: 'clipMove', clip: 'clip', trackDeletedAfter: true }], redo: [] },
      },
      'track deletion',
    ],
    [
      {
        clips: [READY_CLIP],
        history: { undo: [], redo: [{ origin: 'control', action: 'clipMove', clip: 'clip' }] },
      },
      'redo',
    ],
  ] as const)('refuses %j with its reason', (given, expected) => {
    expect(unsupportedReason(given as unknown as Record<string, unknown>)).toContain(expected);
  });
});

describe('the vector that needs the keyboard focus in the tempo field', () => {
  // A started OpenTune rounds the tempo at a switch of the view only while its tempo field holds the keyboard focus,
  // which depends on whether its window is in the foreground. The exe target cannot make that so, so it must skip
  // the vector instead of running it and failing on a window in the background.
  it('is skipped by the exe target, with the reason', () => {
    const found = loadVectors().find((loaded) => loaded.id === 'ui/set-workspace-tempo-rounded');
    expect(found?.problems).toEqual([]);
    expect(found?.vector.given).toMatchObject({ keyboardFocus: 'tempoField' });
    expect(unsupportedReason(found?.vector.given ?? {})).toBe(
      'the exe target cannot establish given.keyboardFocus (whether the window is in the foreground and where its keyboard focus is belong to the machine, not to the runner)',
    );
  });
});

describe('establishing preconditions on an instance', () => {
  it('imports a plain ready clip as described and binds its names', async () => {
    const { session, env } = await setup();
    const bindings = await establishExeGiven({ clips: [READY_CLIP], dirty: false }, env);
    const project = await session.call('project.get', {}, 5000);
    const [placement] = project.placements as [Json];
    expect(placement).toMatchObject({ trackId: 0, startTimelineSec: 2 });
    expect(Number(placement.durationSec)).toBeCloseTo(6, 1);
    expect(bindings['clip.placementId']).toBe(placement.placementId);
    expect(bindings['clip.contentId']).toBe(placement.contentId);
    expect(bindings['clip.geometryHash']).toBe(placement.geometryHash);
    for (const name of ['revision', 'gridRevision', 'keyRevision']) {
      expect(typeof bindings[`clip.${name}`]).toBe('string');
    }
    expect(typeof bindings['clip.sourcePath']).toBe('string');
    expect((project.project as Json).dirty).toBe(false);
  });

  it('makes a dirty project without clips by a write it takes back', async () => {
    const { session, env } = await setup();
    await establishExeGiven({ dirty: true }, env);
    const project = await session.call('project.get', {}, 5000);
    expect((project.project as Json).dirty).toBe(true);
    expect((project.transport as Json).bpm).toBe(120);
  });

  it('leaves a clean project alone for dirty false and no clips', async () => {
    const { session, env } = await setup();
    await establishExeGiven({ dirty: false }, env);
    expect(((await session.call('project.get', {}, 5000)).project as Json).path).toBeNull();
  });

  it('creates the files of the vector in its own folder', async () => {
    const { env } = await setup();
    const bindings = await establishExeGiven(
      {
        files: [
          { bind: 'audio', kind: 'audio', durationSec: 1 },
          { bind: 'gone', kind: 'absent', extension: '.wav' },
          { bind: 'there', kind: 'existing', extension: '.wav' },
          { bind: 'junk', kind: 'undecodable' },
        ],
      },
      env,
    );
    expect(existsSync(String(bindings.audio))).toBe(true);
    expect(existsSync(String(bindings.gone))).toBe(false);
    expect(existsSync(String(bindings.there))).toBe(true);
    expect(existsSync(String(bindings['there.next']))).toBe(false);
    expect(existsSync(String(bindings.junk))).toBe(true);
  });

  it('shows the number of tracks asked for, and refuses to hide tracks', async () => {
    const { session, env } = await setup();
    await establishExeGiven({ visibleTrackCount: 'all' }, env);
    const project = await session.call('project.get', {}, 5000);
    expect(project.visibleTrackCount).toBe((project.tracks as Json[]).length);
    await expect(establishExeGiven({ visibleTrackCount: 1 }, env)).rejects.toThrow(PreconditionUnavailable);
  });

  it('records a control history entry per write, with the undo id bound', async () => {
    const { session, env } = await setup();
    const bindings = await establishExeGiven(
      {
        clips: [READY_CLIP],
        history: {
          undo: [
            { bind: 'u1', origin: 'control', action: 'pitchShift', clip: 'clip' },
            { bind: 'u2', origin: 'control', action: 'clipMove', clip: 'clip' },
          ],
          redo: [],
        },
      },
      env,
    );
    const history = (await session.call('edit.getHistory', {}, 5000)).history as Json;
    expect(history.undoCount).toBe(2);
    expect((history.undoTop as Json).undoId).toBe(bindings.u2);
    expect(bindings.u1).not.toBe(bindings.u2);
    // The clip moved back by the step of the clipMove entry: it ends at the given start.
    const [placement] = (await session.call('project.get', {}, 5000)).placements as [Json];
    expect(placement.startTimelineSec).toBe(2);
  });

  it('skips with the reason when a capability the precondition needs is missing', async () => {
    const { mock, env } = await setup();
    const without = mock.capabilities.filter((c) => c !== 'import.v1');
    await expect(establishExeGiven({ clips: [READY_CLIP] }, { ...env, capabilities: without })).rejects.toThrow(
      /does not report import\.v1/,
    );
  });

  it('skips a precondition that reads back differently from what the vector asks for', async () => {
    const { env } = await setup();
    // A tempo change that does not mark the project as changed: the state is not claimed.
    const rpc = {
      call: async (method: string, params: Json, timeoutMs: number) => {
        const result = await env.rpc.call(method, params, timeoutMs);
        if (method === 'project.get') return { ...result, project: { ...(result.project as Json), dirty: false } };
        return result;
      },
    };
    await expect(establishExeGiven({ dirty: true }, { ...env, rpc })).rejects.toThrow(/no write the target tried/);
  });
});

describe('the runner names of the exe target', () => {
  it('gives handles the instance answers with unknown_handle and stale_handle', async () => {
    const { mock, session, env } = await setup();
    await establishExeGiven({ clips: [READY_CLIP] }, env);
    const values = await readRunnerValues(session, mock.discovery.instanceId);
    const reason = async (method: string, params: Json): Promise<string | null> => {
      try {
        await session.call(method, params, 5000);
        return null;
      } catch (error) {
        return error instanceof OtcpError ? `${error.data.kind}/${String(error.data.reason)}` : String(error);
      }
    };
    expect(await reason('content.getDetails', { contentId: values['runner.unknownContentId'] })).toBe(
      'NOT_FOUND/unknown_handle',
    );
    expect(await reason('content.getDetails', { placementId: values['runner.unknownPlacementId'] })).toBe(
      'NOT_FOUND/unknown_handle',
    );
    expect(await reason('content.getDetails', { contentId: values['runner.staleContentId'] })).toBe(
      'NOT_FOUND/stale_handle',
    );
    expect(await reason('content.getDetails', { placementId: values['runner.stalePlacementId'] })).toBe(
      'NOT_FOUND/stale_handle',
    );
  });

  it('names the last track, the one after it and the current arrangement revision', async () => {
    const { mock, session, env } = await setup();
    await establishExeGiven({ clips: [READY_CLIP] }, env);
    const values = await readRunnerValues(session, mock.discovery.instanceId);
    const project = await session.call('project.get', {}, 5000);
    const tracks = project.tracks as Json[];
    expect(values['runner.lastTrackId']).toBe(tracks[tracks.length - 1]?.trackId);
    expect(values['runner.unknownTrackId']).toBe(Number(values['runner.lastTrackId']) + 1);
    expect(values['runner.arrangementRevision']).toBe((project.asOf as Json).arrangementRevision);
  });
});
