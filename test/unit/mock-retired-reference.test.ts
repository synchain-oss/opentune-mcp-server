// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The reference alignment was removed from the specification in 1.0.0-rc.7. A member that only it used is no
// longer part of any method, so the mock answers a call that still names one with INVALID_ARGUMENT
// (invalid_params), and the method that was removed with it is unknown.

import { afterEach, describe, expect, it } from 'vitest';

import { Sessions, clip } from '../support/mock-client.js';

const sessions = new Sessions();
afterEach(async () => {
  await sessions.dispose();
});

const field = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], value);

async function setup() {
  const session = await sessions.open();
  const ids = session.mock.given({ clips: [clip({ bind: 'clip' }), clip({ bind: 'other', startTimelineSec: 3 })] });
  const details = await session.ok('content.getDetails', { contentId: ids['clip.contentId'] });
  const contents = field(details, 'asOf', 'contents') as { contentId: string; revision: string }[];
  const revision = contents.find((c) => c.contentId === ids['clip.contentId'])?.revision;
  const project = await session.ok('project.get');
  return { session, ids, revision, arrangementRevision: field(project, 'asOf', 'arrangementRevision') };
}

const invalidParams = { data: { kind: 'INVALID_ARGUMENT', reason: 'invalid_params' } };

describe('the members of the removed reference alignment', () => {
  it('content.autoTune has no mode reference', async () => {
    const { session, ids, revision } = await setup();
    const error = await session.fails('content.autoTune', {
      contentId: ids['clip.contentId'],
      mode: 'reference',
      placementId: ids['clip.placementId'],
      expectedRevision: revision,
    });
    expect(error).toMatchObject(invalidParams);
    // The same call in a mode that exists is not refused for its parameters.
    const ok = await session.call('content.autoTune', {
      contentId: ids['clip.contentId'],
      mode: 'snapNotes',
      key: { root: 0, scale: 'major' },
      expectedRevision: revision,
    });
    expect(ok.error).toBeUndefined();
  });

  it('content.autoTune has no member placementId', async () => {
    const { session, ids, revision } = await setup();
    const error = await session.fails('content.autoTune', {
      contentId: ids['clip.contentId'],
      mode: 'regenerate',
      key: { root: 0, scale: 'major' },
      placementId: ids['clip.placementId'],
      expectedRevision: revision,
    });
    expect(error).toMatchObject(invalidParams);
  });

  it('arrangement.edit has no op setReference', async () => {
    const { session, ids, arrangementRevision } = await setup();
    const error = await session.fails('arrangement.edit', {
      expectedArrangementRevision: arrangementRevision,
      ops: [
        { op: 'setReference', placementId: ids['clip.placementId'], referencePlacementId: ids['other.placementId'] },
      ],
    });
    expect(error).toMatchObject(invalidParams);
  });

  it('prefs.set has no member referenceAlignMode', async () => {
    const { session } = await setup();
    const error = await session.fails('prefs.set', { referenceAlignMode: 'game' });
    expect(error).toMatchObject(invalidParams);
  });

  it('prefs.get and session.info report no referenceAlignMode', async () => {
    const { session } = await setup();
    for (const method of ['prefs.get', 'session.info']) {
      const processing = field(await session.ok(method), 'processing') as Record<string, unknown>;
      expect(Object.keys(processing)).not.toContain('referenceAlignMode');
      expect(Object.keys((processing.options ?? {}) as Record<string, unknown>)).not.toContain('referenceAlignMode');
    }
  });

  it('content.getDetails reports no reference section', async () => {
    const { session, ids } = await setup();
    const details = await session.ok('content.getDetails', { contentId: ids['clip.contentId'] });
    expect(Object.keys(details)).not.toContain('reference');
  });

  it('content.analyzeReference is an unknown method', async () => {
    const { session, ids } = await setup();
    const error = await session.fails('content.analyzeReference', { placementId: ids['clip.placementId'] });
    expect(error).toMatchObject({ data: { kind: 'UNSUPPORTED', reason: 'unknown_method' } });
  });
});
