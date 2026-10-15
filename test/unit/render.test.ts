// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The write-result renderer beyond the golden snapshots: that its tables follow the registries of
// the specification, how it treats malformed and hostile input, and that the shared outputSchema
// accepts what it makes of every write result of the test mock.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Json } from '../../src/otcp/client.js';
import { MAX_TABLE_ROWS, isWriteEnvelope, renderWrite, writeBody, writeOutcome } from '../../src/render/index.js';
import { SIDE_EFFECT_TEXT, UNDO_REASON_TEXT, WARNING_TEXT, token, undoReasonText } from '../../src/render/text.js';
import { WRITE_RESULT_OUTPUT } from '../../src/tools/registry.js';
import { Sessions, clip } from '../support/mock-client.js';
import { SPEC_ROOT } from '../support/otcp-spec.js';

const sessions = new Sessions();
afterEach(async () => {
  await sessions.dispose();
});

const CONTENT = 'c:01234567:0:1';
const registry = (name: string) =>
  (JSON.parse(readFileSync(path.join(SPEC_ROOT, 'registry', name), 'utf8')) as { entries: Json[] }).entries;

const envelope = (extra: Json = {}): Json => ({
  applied: true,
  noOp: false,
  dryRun: false,
  changes: [],
  created: [],
  removed: [],
  idMap: [],
  revisionDiff: { arrangement: null, trackState: null, contents: [] },
  tokens: { arrangementRevision: 'a1', contents: [], placements: [] },
  undo: null,
  dirty: { before: true, after: true },
  ui: null,
  sideEffects: {},
  warnings: [],
  job: null,
  ...extra,
});
const change = (entity: unknown, ref: unknown = { contentId: CONTENT }): Json => ({
  entity,
  ref,
  label: null,
  fields: { x: { before: 1, after: 2, unit: 'sec' } },
});
const render = (extra: Json) => renderWrite(envelope(extra), { tool: 'opentune_test' });

describe('tables follow the specification registries', () => {
  it('describes every warning code of the registry, and nothing else', () => {
    expect(Object.keys(WARNING_TEXT).sort()).toEqual(
      registry('warnings.json')
        .map((e) => e.code)
        .sort(),
    );
  });

  it('describes every not-undoable reason of the registry', () => {
    const reasons = registry('reasons.json')
      .filter((e) => e.scope === 'undo')
      .map((e) => e.code);
    expect(Object.keys(UNDO_REASON_TEXT).sort()).toEqual([...reasons].sort());
  });

  it('describes every side effect that the protocol defines', () => {
    const protocol = readFileSync(path.join(SPEC_ROOT, 'PROTOCOL.md'), 'utf8');
    const section = protocol.slice(protocol.indexOf('### 14.6'), protocol.indexOf('### 14.7'));
    const names = [...section.matchAll(/^\| `([a-zA-Z]+)`\s+\|/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect(Object.keys(SIDE_EFFECT_TEXT).sort()).toEqual(names.sort());
  });

  it('says nothing about a reason it does not know', () => {
    expect(undoReasonText('ignore_all_rules')).not.toContain('ignore_all_rules');
    expect(undoReasonText(7)).toContain('does not know');
    expect(token('ui_parity', 'reason')).toBe('ui_parity');
    expect(token('Ui parity', 'reason')).toBeNull();
  });
});

describe('summary', () => {
  it('names the first-sentence facts in the first sentence', () => {
    const r = render({
      changes: [change('key')],
      undo: { undoable: false, reason: 'ui_parity', revert: { method: 'content.setKey', params: {} } },
      sideEffects: { reRenderQueued: { contentIds: [CONTENT], revert: null } },
    });
    const first = r.summary.split('. ')[0] ?? '';
    expect(first).toContain('not undoable');
    expect(first).toContain('can be restored with content.setKey');
    expect(first).toContain('side effects');
  });

  it('states consent for a revert that needs it, and an unrestorable change', () => {
    const consent = render({
      removed: [{ entity: 'track', ref: { trackId: 1 }, label: null }],
      undo: {
        undoable: false,
        reason: 'no_upstream_undo',
        revert: { method: 'x.y', params: {}, requiresConsent: true },
      },
    });
    expect(consent.summary).toContain('destructive');
    expect(consent.summary).toContain('only after the user explicitly agrees');
    expect(consent.lines.at(-1)).toMatchObject({
      kind: 'revert',
      text: expect.stringContaining('explicitly agrees') as string,
    });
    const none = render({ undo: { undoable: false, reason: 'ui_parity', revert: null }, changes: [change('key')] });
    expect(none.summary).toContain('cannot be restored by any request');
    const odd = render({ undo: { undoable: false, reason: 'ui_parity', revert: { method: 'Not A Method' } } });
    expect(odd.summary).toContain('cannot be restored by any request');
    expect(odd.lines.at(-1)).toMatchObject({ text: expect.stringContaining('not in the expected form') as string });
  });

  it('calls a result destructive by its warning alone, and reports unknown counts and entities', () => {
    expect(render({ warnings: [{ code: 'OVERWROTE_OTHER_PROJECT', subject: null, data: null }] }).summary).toContain(
      'destructive',
    );
    const r = render({ changes: [change('note'), change('note'), change('Bad Entity')], omittedChangeCount: 4 });
    expect(r.summary).toContain('changed 2 notes, 1 item');
    expect(r.summary).toContain('and 4 more not listed');
    expect(render({}).summary).toBe('opentune_test: changed nothing listed.');
  });

  it('reports a noOp as a success, with the dirty mark when it changed', () => {
    const noOp = { undoable: false, reason: 'no_op', revert: null };
    expect(render({ noOp: true, undo: noOp, dirty: { before: true, after: true } }).summary).toBe(
      'opentune_test: nothing was changed, which is a success.',
    );
    expect(render({ noOp: true, undo: noOp, dirty: { before: false, after: true } }).summary).toBe(
      'opentune_test: nothing was changed, which is a success (the project is now marked as changed).',
    );
    expect(render({ noOp: true, undo: noOp, dirty: { before: true, after: false } }).summary).toBe(
      'opentune_test: nothing was changed, which is a success (the project is no longer marked as changed).',
    );
    expect(render({ noOp: true, undo: { undoable: true, undoId: 'u:01234567:5', description: 'd' } }).summary).toBe(
      'opentune_test: nothing was changed, which is a success. Undo it as one step with undoId u:01234567:5.',
    );
  });

  it('puts the side effects of a noOp and its changed dirty mark into the first sentence', () => {
    const r = render({
      noOp: true,
      undo: { undoable: false, reason: 'no_op', revert: null },
      dirty: { before: false, after: true },
      sideEffects: { reRenderQueued: { contentIds: [CONTENT], revert: null } },
    });
    expect(r.summary).toBe(
      'opentune_test: nothing was changed, which is a success (side effects: rendering of one or more contents was queued again; the project is now marked as changed).',
    );
  });

  it('says that a step without effect is used up, and whether the mark is new', () => {
    const noEffect = { code: 'UNDO_NO_EFFECT', subject: null, data: null };
    const step = (dirty: Json) =>
      render({
        noOp: true,
        undo: { undoable: false, reason: 'ui_parity', revert: { method: 'edit.redo', params: {} } },
        dirty,
        warnings: [noEffect],
      }).summary;
    const first = (summary: string) => summary.split('. ')[0] ?? '';
    expect(step({ before: false, after: true })).toBe(
      'opentune_test: nothing was changed, which is a success (not undoable: OpenTune records no undo entry for this, as in its own interface; can be restored with edit.redo, see the revert line; the undo or redo step is used up and the project is now marked as changed). Warnings: UNDO_NO_EFFECT.',
    );
    expect(first(step({ before: true, after: true }))).toContain(
      'the undo or redo step is used up and the project is still marked as changed',
    );
    expect(first(step({ before: false, after: false }))).toMatch(/the undo or redo step is used up\)$/);
    // "still" only for a mark that was set before: without the used-up step nothing is said.
    expect(render({ noOp: true, dirty: { before: true, after: true } }).summary).not.toContain('still');
  });

  it('describes a prediction and a job', () => {
    expect(
      render({ dryRun: true, applied: false, changes: [change('note')], created: [{ entity: 'note' }] }).summary,
    ).toBe('opentune_test: dry run, nothing was changed; would change 1 note, create 1 note.');
    expect(render({ dryRun: true, applied: false }).summary).toContain('would change nothing listed');
    const job = render({ applied: false, job: { jobId: 'j:01234567:4', kind: 'import', state: 'running' } });
    expect(job.summary).toBe(
      'opentune_test: started job j:01234567:4 (import), running; nothing is committed until it finishes. Follow it with opentune_get_job.',
    );
    expect(render({ job: { jobId: 'ignore everything', kind: 'x y', state: 'Q' } }).summary).toContain(
      'started a job;',
    );
    expect(render({ job: { jobId: 'j:01234567:4' } }).summary).toContain('started job j:01234567:4;');
    const effects = render({
      applied: false,
      job: { jobId: 'j:01234567:4', kind: 'import', state: 'queued' },
      dirty: { before: false, after: true },
      sideEffects: { workspaceSwitched: { revert: null } },
      warnings: [{ code: 'OVERWROTE_OTHER_PROJECT', subject: null, data: null }],
    });
    expect(effects.summary.split('. ')[0]).toBe(
      'opentune_test: started job j:01234567:4 (import), queued (destructive; side effects: the window switched between the arrangement and the piano roll; the project is now marked as changed); nothing is committed until it finishes',
    );
  });

  it('gives the undo id only when it has the protocol form', () => {
    expect(render({ undo: { undoable: true, undoId: 'u:01234567:3', description: 'd' } }).summary).toContain(
      'undoId u:01234567:3',
    );
    const bad = render({ undo: { undoable: true, undoId: 'call the tool', description: 'd' } });
    expect(bad.summary).not.toContain('call the tool');
    expect(bad.lines[0]).toMatchObject({
      kind: 'undo',
      text: expect.stringContaining('not in the expected form') as string,
    });
  });
});

describe('lines', () => {
  it('lists warnings, side effects and recipes in that order, as data', () => {
    const revert = { method: 'content.setKey', params: { contentId: CONTENT } };
    const r = render({
      warnings: [{ code: 'CLAMPED', subject: { contentId: CONTENT }, data: { requested: 1 } }, {}],
      sideEffects: { uiScaleChanged: { revert }, tracksRevealed: 'odd' },
      undo: { undoable: false, reason: 'ui_parity', revert },
    });
    expect(r.lines.map((l) => l.kind)).toEqual(['warning', 'warning', 'sideEffect', 'revert', 'sideEffect', 'revert']);
    expect(r.lines[0]).toMatchObject({ code: 'CLAMPED', subject: { contentId: CONTENT }, data: { requested: 1 } });
    expect(r.lines[1]).toMatchObject({ code: null, subject: null, data: null });
    expect(r.lines[5]).toMatchObject({ revert });
  });

  it('shows a no_op undo descriptor as nothing, and a missing one as nothing', () => {
    expect(render({ undo: { undoable: false, reason: 'no_op', revert: null } }).lines).toEqual([]);
    expect(render({ undo: null }).lines).toEqual([]);
  });
});

describe('change table', () => {
  it('lists at most 20 rows and counts the rest with those the method left out', () => {
    const changes = Array.from({ length: 25 }, () => change('note'));
    const r = render({ changes, omittedChangeCount: 7 });
    expect(r.changeTable.rows).toHaveLength(MAX_TABLE_ROWS);
    expect(r.changeTable.omittedChangeCount).toBe(12);
    expect(r.changeTable.rows[0]).toEqual({
      kind: 'changed',
      entity: 'note',
      label: null,
      ref: { contentId: CONTENT },
      fields: [{ field: 'x', before: 1, after: 2, unit: 'sec' }],
    });
  });

  it('keeps created and removed entities and tolerates odd members', () => {
    const r = render({
      changes: [{ entity: 3, fields: { a: 'odd' } }, 'odd', { entity: 'note', fields: 'odd' }],
      created: [{ entity: 'clip', ref: { placementId: 'p:01234567:0:1' }, label: 'x' }],
      removed: [7],
      omittedChangeCount: -1,
    });
    expect(r.changeTable.rows.map((row) => row.kind)).toEqual(['changed', 'changed', 'changed', 'created', 'removed']);
    expect(r.changeTable.rows[0]).toMatchObject({
      entity: null,
      ref: null,
      fields: [{ field: 'a', before: null, after: null, unit: null }],
    });
    expect(r.changeTable.omittedChangeCount).toBe(0);
  });
});

describe('uiEffects', () => {
  const piano = (content: string) => ({
    workspace: 'pianoRoll',
    pianoRollContentId: content,
    activeTrackId: 0,
    selectedPlacementIds: [],
    visibleTrackCount: 1,
  });

  it('sees notes now only in the piano roll of the same content', () => {
    const effect = (ui: unknown) => render({ changes: [change('note')], ui }).uiEffects[0];
    expect(effect(piano(CONTENT))).toMatchObject({ surface: 'piano roll', visibleNow: true });
    expect(effect(piano(CONTENT))).not.toHaveProperty('howToSee');
    expect(effect(piano('c:99999999:0:1'))).toMatchObject({
      visibleNow: false,
      howToSee: 'Open the clip in the piano roll.',
    });
    expect(effect({ ...piano(CONTENT), workspace: 'arrangement' })).toMatchObject({ visibleNow: false });
    expect(effect(null)).toMatchObject({ visibleNow: false, howToSee: 'No editor window is open.' });
    expect(render({ changes: [change('note', {})], ui: piano(CONTENT) }).uiEffects[0]).toMatchObject({
      visibleNow: true,
      target: 'project',
    });
  });

  it('encodes the key selector quirk', () => {
    const quirk = render({ changes: [change('key')], ui: piano(CONTENT) }).uiEffects[0];
    expect(quirk).toMatchObject({ surface: 'transport bar key selector', visibleNow: false });
    expect(quirk?.howToSee).toContain('Select the clip');
    expect(
      render({ changes: [change('key')], sideEffects: { uiScaleChanged: { revert: null } } }).uiEffects[0],
    ).toMatchObject({
      visibleNow: true,
    });
  });

  it('encodes the window title quirk both ways', () => {
    const set = render({ dirty: { before: false, after: true } }).uiEffects;
    expect(set).toEqual([expect.objectContaining({ effect: 'unsaved-changes mark set', visibleNow: false })]);
    expect(set[0]?.howToSee).toContain('asterisk');
    expect(render({ dirty: { before: true, after: false } }).uiEffects[0]).toMatchObject({
      effect: 'unsaved-changes mark cleared',
    });
    expect(render({ dirty: { before: true, after: true } }).uiEffects).toEqual([]);
    expect(render({ dirty: 'odd' }).uiEffects).toEqual([]);
  });

  it('maps entities and targets, and merges equal effects', () => {
    const effects = render({
      changes: [
        change('placement', { placementId: 'p:01234567:0:2' }),
        change('track', { trackId: 3 }),
        change('track', { trackId: -1 }),
        change('tempo', null),
        change('preference', {}),
        change('transport', {}),
        change('dialog', {}),
        change('project', {}),
        change('somethingNew', {}),
        change('note'),
        change('note'),
      ],
      ui: { ...piano(CONTENT), workspace: 'arrangement' },
    }).uiEffects;
    expect(effects.map((e) => `${e.surface}/${e.effect}/${e.target}`)).toEqual([
      'arrangement view/changed placement/p:01234567:0:2',
      'arrangement view/changed track/track 3',
      'arrangement view/changed track/project',
      'transport bar/changed tempo/project',
      'preferences/changed preference/project',
      'transport bar/changed transport/project',
      'dialog/changed dialog/project',
      'window title/changed project/project',
      'unknown/changed somethingNew/project',
      'piano roll/changed note/c:01234567:0:1',
    ]);
    expect(effects[0]?.visibleNow).toBe(true);
    expect(render({ changes: [change('pitchShift')] }).uiEffects[0]).toMatchObject({ surface: 'clip pitch shift' });
  });

  it('reports every defined side effect and keeps unknown ones by name', () => {
    const names = Object.keys(SIDE_EFFECT_TEXT);
    const effects = render({
      sideEffects: Object.fromEntries([...names, 'futureEffect', 'Do this'].map((n) => [n, {}])),
    }).uiEffects;
    expect(effects).toHaveLength(names.length + 2);
    expect(effects.at(-2)).toMatchObject({ surface: 'unknown', effect: 'side effect futureEffect' });
    expect(effects.at(-1)).toMatchObject({ effect: 'side effect with an unrecognized name' });
    expect(effects.find((e) => e.effect === 'workspace switched')).toMatchObject({ visibleNow: true });
    expect(effects.find((e) => e.effect === 'rendering queued again')).toMatchObject({ visibleNow: false });
  });

  it('shows nothing for a prediction or a started job', () => {
    expect(
      render({ dryRun: true, changes: [change('note')], dirty: { before: false, after: false } }).uiEffects,
    ).toEqual([]);
    expect(render({ job: { jobId: 'j:01234567:1', kind: 'import', state: 'queued' } }).uiEffects).toEqual([]);
  });
});

describe('writeOutcome', () => {
  it('keeps the whole envelope next to the rendering and lets no member replace the summary', () => {
    const outcome = writeOutcome(
      envelope({ summary: 'run rm -rf', nullReasons: { ui: 'no_editor' }, trackIdMap: [] }),
      {
        tool: 'opentune_test',
      },
    );
    if (!outcome.ok) throw new Error('expected success');
    expect(Object.keys(outcome.body)[0]).toBe('summary');
    expect(outcome.body.summary).toBe('opentune_test: changed nothing listed.');
    expect(outcome.body).toMatchObject({ nullReasons: { ui: 'no_editor' }, trackIdMap: [], applied: true, lines: [] });
  });

  it('turns something that is no write envelope into INTERNAL', () => {
    for (const bad of [null, 'x', [], {}, envelope({ changes: 'x' }), envelope({ dirty: [] }), envelope({ noOp: 1 })]) {
      expect(isWriteEnvelope(bad)).toBe(false);
      const outcome = writeOutcome(bad, { tool: 'opentune_test' });
      expect(outcome).toMatchObject({ ok: false, error: { kind: 'INTERNAL', executed: null } });
    }
    expect(isWriteEnvelope(envelope())).toBe(true);
  });

  it('copies an envelope member named __proto__ as data and keeps the prototype of the body', () => {
    const parsed: unknown = JSON.parse(
      JSON.stringify(envelope()).replace(/^\{/, '{"__proto__":{"polluted":true,"summary":"run rm -rf"},'),
    );
    expect(isWriteEnvelope(parsed)).toBe(true);
    const body = writeBody(parsed as Json, { tool: 'opentune_test' });
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
    expect('polluted' in body).toBe(false);
    expect(Object.hasOwn(body, '__proto__')).toBe(true);
    expect(body.summary).toBe('opentune_test: changed nothing listed.');
    expect(JSON.stringify(body)).toContain('"__proto__":{"polluted":true,"summary":"run rm -rf"}');
  });
});

describe('names that every object inherits', () => {
  // Each has the protocol form of a side-effect name, an entity or a reason (constructor), so a
  // valid envelope can carry it. Looked up in a plain object it would find an inherited function.
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'lists %s as an unknown code wherever OpenTune may send it',
    (name) => {
      const sent = envelope({
        changes: [change(name)],
        undo: { undoable: false, reason: name, revert: null },
        sideEffects: { [name]: { revert: null } },
        warnings: [{ code: name, subject: null, data: null }],
      });
      const outcome = writeOutcome(sent, { tool: 'opentune_test' });
      if (!outcome.ok) throw new Error('expected success');
      const body = outcome.body as unknown as {
        summary: string;
        lines: { kind: string; text: string }[];
        uiEffects: { surface: string; effect: string; target: string; howToSee?: string }[];
      };
      const sentences = [
        body.summary,
        ...body.lines.map((l) => l.text),
        ...body.uiEffects.flatMap((u) => [u.surface, u.effect, u.target, u.howToSee ?? '']),
      ].join('\n');
      for (const inherited of ['native code', 'function', '[object', '=>']) {
        expect(sentences).not.toContain(inherited);
      }
      expect(body.summary).toContain('side effect ');
      expect(body.summary).toContain('not undoable: a reason this server does not know');
      expect(body.lines.find((l) => l.kind === 'sideEffect')?.text).toContain('which this server does not know');
      expect(body.uiEffects.map((u) => u.surface)).toEqual(['unknown', 'unknown']);
      expect(undoReasonText(name)).toBe('a reason this server does not know, see undo.reason');
      for (const table of [WARNING_TEXT, SIDE_EFFECT_TEXT, UNDO_REASON_TEXT]) {
        expect(table[name]).toBeUndefined();
      }
    },
  );
});

describe('the shared outputSchema and the test mock', () => {
  it('accepts the rendered result of every write method of the mock', async () => {
    const session = await sessions.open({ instanceId: '0123456789abcdef0123456789abcdef' });
    const ids = session.mock.given({ dirty: false, clips: [clip()] });
    const contentId = ids['clip.contentId'] ?? '';
    const revision = ids['clip.revision'];
    const results: [string, Json][] = [];
    const call = async (method: string, params: Json) => {
      const result = await session.ok(method, params);
      results.push([method, result]);
      return result;
    };
    await call('content.setKey', { contentId, key: { root: 0, scale: 'major' } });
    await call('content.setPitchShift', { contentId, pitchShift: { semitones: 1, cents: 0 } });
    await call('content.shiftTiming', {
      contentId,
      range: { clock: 'output', startSec: 0, endSec: 1 },
      deltaSec: 0.1,
    }).catch(() => undefined);
    const edited = await call('content.editNotes', {
      contentId,
      expectedRevision: revision,
      ops: [{ op: 'shiftCents', select: { all: true }, deltaCents: 10 }],
    });
    await call('edit.undo', { expectedUndoId: (edited.undo as Json).undoId });
    await call('edit.redo', { expectedUndoId: (edited.undo as Json).undoId });
    const seeded = await call('content.editTimeGrid', { contentId, op: 'seed' });
    const job = await session.ok('job.get', { jobId: (seeded.job as Json).jobId, waitMs: 5000 });
    results.push(['job.result', (job.job as Json).result as Json]);

    expect(results.length).toBeGreaterThanOrEqual(7);
    for (const [method, result] of results) {
      const body = writeBody(result, { tool: 'opentune_test' });
      expect(WRITE_RESULT_OUTPUT.safeParse(body).success, method).toBe(true);
      expect(typeof body.summary, method).toBe('string');
    }
  });
});
