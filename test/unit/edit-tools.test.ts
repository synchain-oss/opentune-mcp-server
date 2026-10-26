// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The edit tools against the mock: opentune_set_clip, opentune_autotune_range, opentune_edit_notes,
// opentune_undo and opentune_redo. Every tool runs for real (the mock changes its notes, key and
// history), so each test reads the effect back. The "unrelated change does not conflict" cases
// execute a write with an old clip_revision after another aspect of the clip changed, and pair
// each with the counter-example that does conflict.

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { startMock, type OtcpMock } from '../../mock/server.js';
import { OtcpError } from '../../src/errors/tool-error.js';
import type { OtcpSession } from '../../src/otcp/client.js';
import { decodeClipRevision } from '../../src/otcp/tokens.js';
import { autotune, autotuneTool, subtractRanges, type AutotuneArgs } from '../../src/tools/autotune.js';
import { withClipRevision } from '../../src/tools/clip-write.js';
import { editNotes, editNotesTool, indicesOverCents, offTargetCents } from '../../src/tools/edit-notes.js';
import { redoTool, undoTool } from '../../src/tools/history.js';
import { getNotes } from '../../src/tools/notes.js';
import { getProject } from '../../src/tools/project.js';
import { render, type Outcome, type ToolDefinition } from '../../src/tools/registry.js';
import { setClip, setClipTool } from '../../src/tools/set-clip.js';
import { tempDir, testContext, type TestContext } from '../support/context.js';
import { clip } from '../support/mock-client.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface Env {
  readonly mock: OtcpMock;
  readonly ctx: TestContext;
  readonly placement: string;
  readonly contentId: string;
  /** The clip_revision of the clip, as opentune_get_project shows it now. */
  readonly revision: () => Promise<string>;
  /** Calls an OTCP method on the instance, as someone else (the window, another client) would. */
  readonly otcp: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** The OTCP methods the tools call from now on, with their params, in order. */
  readonly calls: { method: string; params: Record<string, unknown> }[];
  readonly session: OtcpSession;
  readonly ids: Record<string, string>;
}

async function setup(given: Record<string, unknown> = {}): Promise<Env> {
  const t = tempDir();
  cleanup.push(t.remove);
  const mock = await startMock({ discoveryDir: t.dir });
  cleanup.push(() => mock.stop());
  const ctx = testContext(t.dir);
  cleanup.push(() => {
    ctx.instances.close();
  });
  const ids = mock.given({ clips: [clip()], ...given });
  const scan = await ctx.instances.scan();
  if (!('instances' in scan) || scan.instances[0] === undefined) throw new Error('no instance');
  const session = await ctx.instances.session(scan.instances[0]);
  const original = session.call.bind(session);
  const calls: Env['calls'] = [];
  session.call = (method, params, timeoutMs) => {
    calls.push({ method, params });
    return original(method, params, timeoutMs);
  };
  const revision = async () => {
    const outcome = await getProject(ctx, {});
    if (!outcome.ok) throw new Error('project');
    return (outcome.body.placements as { clip_revision: string }[])[0]?.clip_revision ?? '';
  };
  return {
    mock,
    ctx,
    placement: ids['clip.placementId'] ?? '',
    contentId: ids['clip.contentId'] ?? '',
    revision,
    otcp: (method, params) => original(method, params, 10_000),
    calls,
    session,
    ids,
  };
}

const body = (outcome: Outcome) => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.error.kind}: ${outcome.error.detail}`);
  return outcome.body;
};
const failure = (outcome: Outcome) => {
  if (outcome.ok) throw new Error('expected an error');
  return outcome.error;
};
const sent = (env: Env, method: string) => env.calls.filter((c) => c.method === method);

interface RevertLine {
  readonly kind: string;
  readonly restore: { readonly tool: string; readonly arguments: Record<string, unknown> } | null;
}
/** The tool call of the result's revert line. */
const restoreOf = (out: Record<string, unknown>) =>
  (out.lines as RevertLine[]).find((l) => l.kind === 'revert')?.restore;
/** Runs a tool as an MCP client would: the arguments go through its input schema first. */
const call = (tool: ToolDefinition, env: Env, args: Record<string, unknown>) =>
  tool.run(tool.inputSchema.parse(args), env.ctx);
/** Makes the instance answer `method` with something that is not a write envelope. */
function answerOddly(env: Env, method: string) {
  const original = env.session.call.bind(env.session);
  env.session.call = (m, params, timeoutMs) => (m === method ? Promise.resolve({}) : original(m, params, timeoutMs));
}

async function notesOf(env: Env) {
  const out = body(await getNotes(env.ctx, { clip: env.placement, clock: 'content' }));
  return out.notes as { index: number; targetMidi: number; offsetCents: number; retuneSpeed: number }[];
}

const SELECT_ALL = { all: true } as const;

describe('opentune_set_clip', () => {
  it('sets the key: not undoable, with the way back as a call of this tool that works as given', async () => {
    const env = await setup();
    const before = (await env.otcp('content.getDetails', { contentId: env.contentId })).key as Record<string, unknown>;
    const out = body(
      await setClip(env.ctx, {
        clip: env.placement,
        expected_revision: await env.revision(),
        key: { root: 2, scale: 'minor' },
      }),
    );
    expect(out.summary).toMatch(
      /^opentune_set_clip: changed 1 key \(not undoable: .*can be restored with opentune_set_clip/,
    );
    expect(out.undo).toMatchObject({ undoable: false, reason: 'ui_parity' });
    const restore = restoreOf(out);
    expect(restore).toEqual({
      tool: 'opentune_set_clip',
      arguments: { clip: env.contentId, key: { root: before.root, scale: before.scale } },
    });
    const details = await env.otcp('content.getDetails', { contentId: env.contentId });
    expect(details.key).toMatchObject({ root: 2, scale: 'minor' });
    // The line says: these arguments, and the latest clip_revision, which this result returns.
    const restored = body(
      await call(setClipTool, env, { ...restore?.arguments, expected_revision: out.clip_revision }),
    );
    expect(restored.applied).toBe(true);
    const after = await env.otcp('content.getDetails', { contentId: env.contentId });
    expect(after.key).toMatchObject({ root: before.root, scale: before.scale });
  });

  it('sets the pitch shift as one undo step and warns that the key is not transposed', async () => {
    const env = await setup();
    const out = body(
      await setClip(env.ctx, {
        clip: env.placement,
        expected_revision: await env.revision(),
        pitch_shift: { semitones: 2, cents: -10 },
      }),
    );
    expect(out.undo).toMatchObject({ undoable: true });
    expect(out.summary).toContain('Undo it as one step with undoId');
    expect(out.warnings).toEqual([expect.objectContaining({ code: 'KEY_NOT_TRANSPOSED' })]);
    expect(sent(env, 'content.setKey')).toHaveLength(0);
  });

  it('makes two requests for key and pitch shift, key first, and reports each', async () => {
    const env = await setup();
    const out = body(
      await setClip(env.ctx, {
        clip: env.placement,
        expected_revision: await env.revision(),
        key: { root: 5, scale: 'major' },
        pitch_shift: { semitones: -1, cents: 0 },
      }),
    );
    expect(sent(env, 'content.setKey')).toHaveLength(1);
    expect(sent(env, 'content.setPitchShift')).toHaveLength(1);
    const methods = env.calls.map((c) => c.method).filter((m) => m.startsWith('content.set'));
    expect(methods).toEqual(['content.setKey', 'content.setPitchShift']);
    const results = out.results as { method: string; undo: { undoable: boolean } }[];
    expect(results.map((r) => r.method)).toEqual(['content.setKey', 'content.setPitchShift']);
    expect(results.map((r) => r.undo.undoable)).toEqual([false, true]);
    // The key change cannot be undone, and the first sentence says so before anything else.
    expect(out.summary).toMatch(
      /^opentune_set_clip: the key change cannot be undone \(restore it as the results say\); two requests .*Key: .*Pitch shift: /,
    );
    expect(out.summary.split('. ')[0]).toContain('cannot be undone');
  });

  it('leaves the key out of the first sentence when the key did not change', async () => {
    const env = await setup();
    const current = (await env.otcp('content.getDetails', { contentId: env.contentId })).key as {
      root: number;
      scale: string;
    };
    const out = body(
      await setClip(env.ctx, {
        clip: env.placement,
        expected_revision: await env.revision(),
        key: { root: current.root, scale: current.scale },
        pitch_shift: { semitones: 1, cents: 0 },
      }),
    );
    expect((out.results as { noOp: boolean }[]).map((r) => r.noOp)).toEqual([true, false]);
    expect(out.summary).toMatch(/^opentune_set_clip: two requests were made/);
    expect(out.summary).not.toContain('cannot be undone');
  });

  it('stops when the first request returns no write envelope, and sends nothing after it', async () => {
    const env = await setup();
    answerOddly(env, 'content.setKey');
    const outcome = await setClip(env.ctx, {
      clip: env.placement,
      expected_revision: await env.revision(),
      key: { root: 7, scale: 'major' },
      pitch_shift: { semitones: 1, cents: 0 },
    });
    expect(failure(outcome)).toMatchObject({ kind: 'INTERNAL', executed: null });
    expect(sent(env, 'content.setPitchShift')).toHaveLength(0);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.context).toBeUndefined();
  });

  it('reports the applied key change when the second request returns no write envelope', async () => {
    const env = await setup();
    answerOddly(env, 'content.setPitchShift');
    const outcome = await setClip(env.ctx, {
      clip: env.placement,
      expected_revision: await env.revision(),
      key: { root: 7, scale: 'major' },
      pitch_shift: { semitones: 1, cents: 0 },
    });
    expect(failure(outcome)).toMatchObject({ kind: 'INTERNAL', executed: null });
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.context).toMatchObject({ applied_before_error: [{ method: 'content.setKey', applied: true }] });
  });

  it('reports the applied key change next to the error when the second request fails', async () => {
    const env = await setup();
    const original = env.session.call.bind(env.session);
    env.session.call = (method, params, timeoutMs) =>
      method === 'content.setPitchShift'
        ? Promise.reject(
            new OtcpError({ kind: 'BUSY', reason: null, retryable: true, detail: 'a dialog is open', executed: false }),
          )
        : original(method, params, timeoutMs);
    const outcome = await setClip(env.ctx, {
      clip: env.placement,
      expected_revision: await env.revision(),
      key: { root: 7, scale: 'major' },
      pitch_shift: { semitones: 1, cents: 0 },
    });
    expect(failure(outcome).kind).toBe('BUSY');
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.context).toMatchObject({ applied_before_error: [{ method: 'content.setKey', applied: true }] });
  });

  it('treats the current value as a success that changes nothing', async () => {
    const env = await setup();
    const shift = { semitones: 0, cents: 0 };
    const out = body(
      await setClip(env.ctx, { clip: env.placement, expected_revision: await env.revision(), pitch_shift: shift }),
    );
    expect(out.noOp).toBe(true);
    expect(out.summary).toContain('nothing was changed');
  });

  it('rejects an empty request, a revision this server did not issue and an unknown clip', async () => {
    const env = await setup();
    const revision = await env.revision();
    expect(failure(await setClip(env.ctx, { clip: env.placement, expected_revision: revision }))).toMatchObject({
      kind: 'INVALID_ARGUMENT',
    });
    const bad = failure(
      await setClip(env.ctx, { clip: env.placement, expected_revision: 'abc', key: { root: 0, scale: 'major' } }),
    );
    expect(bad).toMatchObject({ kind: 'INVALID_ARGUMENT', reason: 'revision_invalid' });
    expect(bad.nextStep.tool).toBe('opentune_get_project');
    expect(
      failure(
        await setClip(env.ctx, {
          clip: 'p:00000000:0:99',
          expected_revision: revision,
          key: { root: 0, scale: 'major' },
        }),
      ),
    ).toMatchObject({ kind: 'NOT_FOUND' });
    expect(sent(env, 'content.setKey')).toHaveLength(0);
  });

  it('does not conflict on an unrelated change, and conflicts when the key itself changed', async () => {
    const env = await setup();
    const old = await env.revision();
    // The notes change (content revision), the key stays: a key write with the old revision is fine.
    await env.otcp('content.editNotes', {
      contentId: env.contentId,
      expectedRevision: await notesRevision(env),
      ops: [{ op: 'shiftCents', select: { indices: [0] }, deltaCents: 5 }],
    });
    const ok = body(
      await setClip(env.ctx, { clip: env.placement, expected_revision: old, key: { root: 3, scale: 'major' } }),
    );
    expect(ok.applied).toBe(true);
    // The key changed since `old` was read: the same write now conflicts, and nothing is applied.
    const conflict = failure(
      await setClip(env.ctx, {
        clip: env.placement,
        expected_revision: old,
        key: { root: 4, scale: 'major' },
        pitch_shift: { semitones: 3, cents: 0 },
      }),
    );
    expect(conflict).toMatchObject({ kind: 'REVISION_CONFLICT', reason: 'key_changed' });
    expect(sent(env, 'content.setPitchShift')).toHaveLength(0);
  });

  it('does not conflict on a pitch shift whatever else changed', async () => {
    const env = await setup();
    const old = await env.revision();
    await env.otcp('content.setKey', { contentId: env.contentId, key: { root: 1, scale: 'minor' } });
    const out = body(
      await setClip(env.ctx, { clip: env.placement, expected_revision: old, pitch_shift: { semitones: 1, cents: 0 } }),
    );
    expect(out.applied).toBe(true);
    // Only the key aspect was forwarded.
    expect(sent(env, 'content.setPitchShift')[0]?.params).not.toHaveProperty('expectedKeyRevision');
  });
});

describe('opentune_autotune_range', () => {
  const args = async (env: Env, extra: Partial<AutotuneArgs> & Pick<AutotuneArgs, 'mode'>): Promise<AutotuneArgs> => ({
    clip: env.placement,
    expected_revision: await env.revision(),
    ...extra,
  });

  it('regenerates notes in ranges with an explicit scale and reports the generator defaults', async () => {
    const env = await setup();
    const out = body(
      await autotune(
        env.ctx,
        await args(env, {
          mode: 'regenerate',
          scale: { root: 0, scale: 'major' },
          ranges: [{ from_sec: 0, to_sec: 3 }],
        }),
      ),
    );
    expect(out.mode).toBe('regenerate');
    expect(out.keyUsed).toEqual({ root: 0, scale: 'major' });
    expect(out.paramsUsed).toBeTruthy();
    expect(out.undo).toMatchObject({ undoable: true });
    const params = sent(env, 'content.autoTune')[0]?.params;
    expect(params).toMatchObject({ mode: 'regenerate', ranges: [{ startContentSec: 0, endContentSec: 3 }] });
    // No parameter was given, so none is sent: OpenTune takes the generator defaults.
    expect(params).not.toHaveProperty('params');
  });

  it('sends only the parameters that were given, with the units of OTCP', async () => {
    const env = await setup();
    body(
      await autotune(
        env.ctx,
        await args(env, {
          mode: 'regenerate',
          scale: { root: 0, scale: 'major' },
          retune_speed: 0.25,
          note_split_cents: 80,
        }),
      ),
    );
    expect(sent(env, 'content.autoTune')[0]?.params.params).toEqual({ retuneSpeed: 0.25, noteSplitCents: 80 });
  });

  it('snaps the existing notes to the scale', async () => {
    const env = await setup();
    const out = body(
      await autotune(env.ctx, await args(env, { mode: 'snapNotes', scale: { root: 9, scale: 'minor' } })),
    );
    expect(out.mode).toBe('snapNotes');
    expect(out.paramsUsed).toBeNull();
    expect((await notesOf(env)).map((n) => n.targetMidi)).toContain(69);
  });

  it('turns exclude into the ranges that remain, and refuses when nothing or too much remains', async () => {
    expect(
      subtractRanges(
        [{ from_sec: 0, to_sec: 10 }],
        [
          { from_sec: 2, to_sec: 3 },
          { from_sec: 8, to_sec: 12 },
        ],
      ),
    ).toEqual([
      { from_sec: 0, to_sec: 2 },
      { from_sec: 3, to_sec: 8 },
    ]);
    expect(subtractRanges([{ from_sec: 0, to_sec: 5 }], [{ from_sec: 0, to_sec: 5 }])).toEqual([]);
    expect(subtractRanges([{ from_sec: 0, to_sec: 5 }], [{ from_sec: 6, to_sec: 7 }])).toEqual([
      { from_sec: 0, to_sec: 5 },
    ]);

    const env = await setup();
    const out = body(
      await autotune(
        env.ctx,
        await args(env, { mode: 'regenerate', scale: 'clip', exclude: [{ from_sec: 1, to_sec: 2 }], dry_run: true }),
      ),
    );
    expect(out.dryRun).toBe(true);
    const sentRanges = sent(env, 'content.autoTune')[0]?.params.ranges as {
      startContentSec: number;
      endContentSec: number;
    }[];
    expect(sentRanges[0]).toEqual({ startContentSec: 0, endContentSec: 1 });
    expect(sentRanges[1]?.startContentSec).toBe(2);

    const all = await autotune(
      env.ctx,
      await args(env, {
        mode: 'regenerate',
        scale: 'clip',
        ranges: [{ from_sec: 1, to_sec: 2 }],
        exclude: [{ from_sec: 0, to_sec: 3 }],
      }),
    );
    expect(failure(all).detail).toContain('nothing is left');
    const comb = Array.from({ length: 17 }, (_, i) => ({ from_sec: i * 0.2, to_sec: i * 0.2 + 0.1 }));
    const many = await autotune(
      env.ctx,
      await args(env, {
        mode: 'regenerate',
        scale: 'clip',
        ranges: [{ from_sec: 0, to_sec: 5 }],
        exclude: comb.map((r) => ({ from_sec: r.from_sec + 0.1, to_sec: r.to_sec + 0.05 })),
      }),
    );
    expect(failure(many).detail).toContain('more than the 16');
  });

  it('predicts with dry_run and applies nothing', async () => {
    const env = await setup();
    const before = await notesOf(env);
    const out = body(
      await autotune(
        env.ctx,
        await args(env, { mode: 'snapNotes', scale: { root: 0, scale: 'major' }, dry_run: true }),
      ),
    );
    expect(out).toMatchObject({ applied: false, dryRun: true });
    expect(out.summary).toContain('dry run, nothing was changed');
    expect(await notesOf(env)).toEqual(before);
  });

  it('guards notesOnly: without replace_edited_notes nothing is sent, with it the first sentence says what happened', async () => {
    const env = await setup();
    const refused = await autotune(env.ctx, await args(env, { mode: 'notesOnly' }));
    expect(failure(refused)).toMatchObject({ kind: 'INVALID_ARGUMENT', reason: 'confirm_required', executed: false });
    expect(failure(refused).nextStep.actor).toBe('user');
    expect(failure(refused).nextStep.message).toContain('replace_edited_notes: true');
    expect(sent(env, 'content.autoTune')).toHaveLength(0);
    // A preview is not guarded: it changes nothing.
    const preview = body(await autotune(env.ctx, await args(env, { mode: 'notesOnly', dry_run: true })));
    expect(preview.dryRun).toBe(true);
    expect(sent(env, 'content.autoTune')).toHaveLength(1);

    const out = body(await autotune(env.ctx, await args(env, { mode: 'notesOnly', replace_edited_notes: true })));
    expect(out.summary).toMatch(
      /^opentune_autotune_range: all notes of the clip were replaced \(REPLACES_ALL_NOTES\) and this cannot be undone;/,
    );
    expect(out.undo).toMatchObject({ undoable: false });
    expect((out.warnings as { code: string }[]).map((w) => w.code)).toContain('REPLACES_ALL_NOTES');
  });

  it('refuses a replace_edited_notes of false the same way', async () => {
    const env = await setup();
    const refused = await autotune(env.ctx, await args(env, { mode: 'notesOnly', replace_edited_notes: false }));
    expect(failure(refused).reason).toBe('confirm_required');
  });

  it('rejects arguments a mode does not take, naming what to change', async () => {
    const env = await setup();
    const problem = async (extra: Partial<AutotuneArgs> & Pick<AutotuneArgs, 'mode'>) =>
      failure(await autotune(env.ctx, await args(env, extra))).detail;
    expect(await problem({ mode: 'regenerate' })).toContain('needs scale');
    expect(await problem({ mode: 'snapNotes' })).toContain('needs scale');
    expect(await problem({ mode: 'snapNotes', scale: 'clip', retune_speed: 0.5 })).toContain(
      'not accepted by mode snapNotes',
    );
    expect(await problem({ mode: 'notesOnly', ranges: [{ from_sec: 0, to_sec: 1 }] })).toContain(
      'not accepted by mode notesOnly',
    );
    expect(await problem({ mode: 'notesOnly', scale: 'clip' })).toContain('scale is not accepted');
    expect(await problem({ mode: 'regenerate', scale: 'clip', ranges: [{ from_sec: 2, to_sec: 1 }] })).toContain(
      'to_sec must be larger',
    );
    expect(sent(env, 'content.autoTune')).toHaveLength(0);
  });

  it('has no mode reference and no member for a reference clip', async () => {
    const env = await setup();
    const schema = autotuneTool.inputSchema;
    const base = { clip: env.placement, expected_revision: await env.revision() };
    expect(schema.safeParse({ ...base, mode: 'regenerate', scale: 'clip' }).success).toBe(true);
    expect(schema.safeParse({ ...base, mode: 'reference' }).success).toBe(false);
    expect(
      schema.safeParse({ ...base, mode: 'regenerate', scale: 'clip', reference_clip: env.placement }).success,
    ).toBe(false);
  });

  it('does not conflict on an unrelated change with an explicit scale, and conflicts with scale clip when the key changed', async () => {
    const env = await setup();
    const old = await env.revision();
    await env.otcp('content.setKey', { contentId: env.contentId, key: { root: 6, scale: 'minor' } });
    const clipKey = failure(
      await autotune(env.ctx, {
        clip: env.placement,
        expected_revision: old,
        mode: 'snapNotes',
        scale: 'clip',
      }),
    );
    expect(clipKey).toMatchObject({ kind: 'REVISION_CONFLICT', reason: 'key_changed' });
    const explicit = body(
      await autotune(env.ctx, {
        clip: env.placement,
        expected_revision: old,
        mode: 'snapNotes',
        scale: { root: 0, scale: 'major' },
      }),
    );
    expect(explicit.applied).toBe(true);
    expect(sent(env, 'content.autoTune')[1]?.params).not.toHaveProperty('expectedKeyRevision');
    const fresh = body(
      await autotune(env.ctx, {
        clip: env.placement,
        expected_revision: await env.revision(),
        mode: 'snapNotes',
        scale: 'clip',
      }),
    );
    expect(fresh.keyUsed).toEqual({ root: 6, scale: 'minor' });
    expect(sent(env, 'content.autoTune').at(-1)?.params).toHaveProperty('key', 'clipKey');
  });

  it('conflicts when the notes changed since the revision was read', async () => {
    const env = await setup();
    const old = await env.revision();
    await env.otcp('content.editNotes', {
      contentId: env.contentId,
      expectedRevision: await notesRevision(env),
      ops: [{ op: 'shiftCents', select: SELECT_ALL, deltaCents: 5 }],
    });
    const out = failure(
      await autotune(env.ctx, {
        clip: env.placement,
        expected_revision: old,
        mode: 'snapNotes',
        scale: { root: 0, scale: 'major' },
      }),
    );
    expect(out).toMatchObject({ kind: 'REVISION_CONFLICT', reason: 'content_changed' });
  });
});

/** The content revision as the notes read reports it now. */
async function notesRevision(env: Env): Promise<string> {
  const read = await env.otcp('content.getNotes', { contentId: env.contentId, limit: 1 });
  const contents = (read.asOf as { contents: { contentId: string; revision: string }[] }).contents;
  return contents.find((c) => c.contentId === env.contentId)?.revision ?? '';
}

describe('opentune_edit_notes', () => {
  it('runs each kind of op on the notes it selects and reports one undo step', async () => {
    const env = await setup();
    const out = body(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: await env.revision(),
        ops: [
          { op: 'shiftCents', select: { indices: [0] }, delta_cents: 20 },
          { op: 'setTargetPitch', select: { indices: [1] }, target_midi: 71 },
          { op: 'snapToScale', select: { from_sec: 3, to_sec: 5 }, scale: { root: 0, scale: 'major' } },
          {
            op: 'setParams',
            select: SELECT_ALL,
            retune_speed: 0.3,
            vibrato_depth: 10,
            vibrato_rate_hz: 5.5,
            pitch_drift_scale: 0.5,
          },
        ],
      }),
    );
    expect(out.applied).toBe(true);
    expect(out.undo).toMatchObject({ undoable: true, steps: 1 });
    expect(out.summary).toContain('Undo it as one step with undoId');
    const notes = await notesOf(env);
    expect(notes[1]?.targetMidi).toBe(71);
    expect(notes.every((n) => n.retuneSpeed === 0.3)).toBe(true);
    expect(sent(env, 'content.editNotes')[0]?.params.ops).toHaveLength(4);
  });

  it('predicts with dry_run and changes nothing', async () => {
    const env = await setup();
    const before = await notesOf(env);
    const out = body(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: await env.revision(),
        ops: [{ op: 'shiftCents', select: SELECT_ALL, delta_cents: 50 }],
        dry_run: true,
      }),
    );
    expect(out).toMatchObject({ applied: false, dryRun: true });
    expect(out.summary).toContain('dry run, nothing was changed');
    expect(await notesOf(env)).toEqual(before);
  });

  it('resolves a condition to note indexes at the revision the caller holds', async () => {
    const env = await setup();
    const read = body(await getNotes(env.ctx, { clip: env.placement, clock: 'content' })).notes as {
      index: number;
      detectedMidi: number | null;
      targetMidi: number;
    }[];
    const expected = indicesOverCents(
      read.map((n) => ({ index: n.index, detectedMidi: n.detectedMidi, targetMidi: n.targetMidi })),
      100,
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(read.length);
    const out = body(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: await env.revision(),
        ops: [{ op: 'setParams', select: { off_target_cents_over: 100 }, retune_speed: 0.9 }],
      }),
    );
    expect(sent(env, 'content.editNotes')[0]?.params.ops).toEqual([
      { op: 'setParams', select: { indices: expected }, retuneSpeed: 0.9 },
    ]);
    expect(out.selection_resolved).toEqual([{ op: 0, matched: expected.length }]);
    const after = await notesOf(env);
    expect(after.filter((n) => n.retuneSpeed === 0.9).map((n) => n.index)).toEqual(expected);
  });

  it('limits a condition to a time range', async () => {
    const env = await setup();
    const out = body(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: await env.revision(),
        ops: [{ op: 'shiftCents', select: { off_target_cents_over: 100, from_sec: 0, to_sec: 2.5 }, delta_cents: 5 }],
      }),
    );
    // Notes 0 (307 cents off) and 2 (572 cents off) exceed 100 cents; only note 0 lies in the range.
    expect(sent(env, 'content.editNotes')[0]?.params.ops).toEqual([
      { op: 'shiftCents', select: { indices: [0] }, deltaCents: 5 },
    ]);
    expect(out.selection_resolved).toEqual([{ op: 0, matched: 1 }]);
    const half = failure(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: await env.revision(),
        ops: [{ op: 'shiftCents', select: { off_target_cents_over: 30, from_sec: 1 }, delta_cents: 5 }],
      }),
    );
    expect(half.detail).toContain('go together');
  });

  it('sends nothing when no note matches the condition', async () => {
    const env = await setup();
    const revision = await env.revision();
    const out = body(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: revision,
        ops: [{ op: 'shiftCents', select: { off_target_cents_over: 1200 }, delta_cents: 5 }],
      }),
    );
    expect(out).toMatchObject({ applied: false, noOp: true, clip_revision: revision });
    expect(out.summary).toContain('no note matched');
    expect(sent(env, 'content.editNotes')).toHaveLength(0);
  });

  it('refuses to resolve a condition against notes that changed since the revision was read', async () => {
    const env = await setup();
    const old = await env.revision();
    await env.otcp('content.editNotes', {
      contentId: env.contentId,
      expectedRevision: await notesRevision(env),
      ops: [{ op: 'shiftCents', select: SELECT_ALL, deltaCents: 5 }],
    });
    const out = failure(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: old,
        ops: [{ op: 'shiftCents', select: { off_target_cents_over: 10 }, delta_cents: 5 }],
      }),
    );
    expect(out).toMatchObject({ kind: 'REVISION_CONFLICT', reason: 'content_changed' });
    expect(sent(env, 'content.editNotes')).toHaveLength(0);
  });

  it('does not conflict when only the key changed, unless an op uses the clip key', async () => {
    const env = await setup();
    const old = await env.revision();
    await env.otcp('content.setKey', { contentId: env.contentId, key: { root: 3, scale: 'minor' } });
    // The counter-example first: an op that reads the clip key conflicts.
    const conflict = failure(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: old,
        ops: [{ op: 'snapToScale', select: SELECT_ALL, scale: 'clip' }],
      }),
    );
    expect(conflict).toMatchObject({ kind: 'REVISION_CONFLICT', reason: 'key_changed' });
    expect(sent(env, 'content.editNotes')[0]?.params).toHaveProperty('expectedKeyRevision');
    const fine = body(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: old,
        ops: [{ op: 'shiftCents', select: { indices: [0] }, delta_cents: 10 }],
      }),
    );
    expect(fine.applied).toBe(true);
    expect(sent(env, 'content.editNotes')[1]?.params).not.toHaveProperty('expectedKeyRevision');
  });

  it('conflicts when the notes changed, and reports an unknown note index', async () => {
    const env = await setup();
    const old = await env.revision();
    await env.otcp('content.editNotes', {
      contentId: env.contentId,
      expectedRevision: await notesRevision(env),
      ops: [{ op: 'shiftCents', select: SELECT_ALL, deltaCents: 5 }],
    });
    const stale = failure(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: old,
        ops: [{ op: 'shiftCents', select: { indices: [0] }, delta_cents: 5 }],
      }),
    );
    expect(stale).toMatchObject({ kind: 'REVISION_CONFLICT', reason: 'content_changed' });
    const missing = failure(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: await env.revision(),
        ops: [{ op: 'shiftCents', select: { indices: [999] }, delta_cents: 5 }],
      }),
    );
    expect(missing).toMatchObject({ kind: 'NOT_FOUND', reason: 'unknown_handle' });
  });

  it('rejects a setParams without parameters and a time range that runs backwards', async () => {
    const env = await setup();
    const revision = await env.revision();
    expect(
      failure(
        await editNotes(env.ctx, {
          clip: env.placement,
          expected_revision: revision,
          ops: [{ op: 'setParams', select: SELECT_ALL }],
        }),
      ).detail,
    ).toContain('at least one parameter');
    expect(
      failure(
        await editNotes(env.ctx, {
          clip: env.placement,
          expected_revision: revision,
          ops: [{ op: 'shiftCents', select: { from_sec: 3, to_sec: 1 }, delta_cents: 1 }],
        }),
      ).detail,
    ).toContain('to_sec must be larger');
    expect(sent(env, 'content.editNotes')).toHaveLength(0);
  });

  it('sends a repeated index once', async () => {
    const env = await setup();
    body(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: await env.revision(),
        ops: [{ op: 'shiftCents', select: { indices: [1, 0, 1] }, delta_cents: 5 }],
      }),
    );
    expect(sent(env, 'content.editNotes')[0]?.params.ops).toEqual([
      { op: 'shiftCents', select: { indices: [1, 0] }, deltaCents: 5 },
    ]);
  });

  it('evaluates every condition before any op runs, with one read of the notes per range', async () => {
    const env = await setup();
    const out = body(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: await env.revision(),
        ops: [
          { op: 'shiftCents', select: { off_target_cents_over: 100 }, delta_cents: 50 },
          { op: 'setParams', select: { off_target_cents_over: 100 }, retune_speed: 0.4 },
          { op: 'shiftCents', select: { off_target_cents_over: 100, from_sec: 0, to_sec: 2.5 }, delta_cents: 1 },
        ],
      }),
    );
    expect(sent(env, 'content.getNotes')).toHaveLength(2);
    const ops = sent(env, 'content.editNotes')[0]?.params.ops as { select: unknown }[];
    expect(ops[1]?.select).toEqual(ops[0]?.select);
    expect(out.selection_resolved).toHaveLength(3);
  });

  it('computes the distance of a sung pitch from the target in cents', () => {
    expect(offTargetCents({ index: 0, detectedMidi: 60.25, targetMidi: 60 })).toBeCloseTo(25);
    expect(offTargetCents({ index: 0, detectedMidi: null, targetMidi: 60 })).toBeNull();
    expect(
      indicesOverCents(
        [
          { index: 4, detectedMidi: 60.5, targetMidi: 60 },
          { index: 5, detectedMidi: null, targetMidi: 60 },
        ],
        30,
      ),
    ).toEqual([4]);
  });
});

describe('opentune_undo and opentune_redo', () => {
  const run = (tool: ToolDefinition, env: Env, args: Record<string, unknown>) =>
    tool.run(tool.inputSchema.parse(args), env.ctx);

  async function edited(env: Env) {
    const out = body(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: await env.revision(),
        ops: [{ op: 'shiftCents', select: { indices: [0] }, delta_cents: 25 }],
      }),
    );
    return (out.undo as { undoId: string }).undoId;
  }

  it('undoes the step it names, then redoes it, and each result carries the way back', async () => {
    const env = await setup();
    const before = (await notesOf(env))[0]?.offsetCents;
    const undoId = await edited(env);
    const undone = body(await run(undoTool, env, { undo_id: undoId }));
    expect(undone.applied).toBe(true);
    expect(undone.undo).toMatchObject({ undoable: false, revert: { method: 'edit.redo' } });
    expect((await notesOf(env))[0]?.offsetCents).toBe(before);
    expect(sent(env, 'edit.undo')[0]?.params).toEqual({ expectedUndoId: undoId });
    // The way back is a call of opentune_redo, run here exactly as the line gives it.
    const back = restoreOf(undone);
    expect(back).toEqual({ tool: 'opentune_redo', arguments: { undo_id: undoId } });
    const redone = body(await run(redoTool, env, back?.arguments ?? {}));
    expect(redone.applied).toBe(true);
    expect((await notesOf(env))[0]?.offsetCents).toBe((before ?? 0) + 25);
    expect(restoreOf(redone)).toEqual({ tool: 'opentune_undo', arguments: { undo_id: undoId } });
  });

  it('answers UNDO_CONFLICT with a step for the user when the top step is not the one named', async () => {
    const env = await setup();
    const undoId = await edited(env);
    await edited(env);
    const out = failure(await run(undoTool, env, { undo_id: undoId }));
    expect(out).toMatchObject({ kind: 'UNDO_CONFLICT', reason: 'top_mismatch' });
    expect(out.nextStep.actor).toBe('user');
    expect(out.nextStep.message).toContain('do not force');
  });

  it('forces only when asked to, and sends force with the id', async () => {
    const env = await setup();
    const undoId = await edited(env);
    const second = await edited(env);
    expect(second).not.toBe(undoId);
    const out = body(await run(undoTool, env, { undo_id: undoId, force: true }));
    expect(out.applied).toBe(true);
    expect(sent(env, 'edit.undo')[0]?.params).toEqual({ expectedUndoId: undoId, force: true });
    const never = await run(undoTool, env, { undo_id: second, force: false });
    expect(never.ok || never.error.kind !== 'INTERNAL').toBe(true);
    expect(sent(env, 'edit.undo')[1]?.params).toEqual({ expectedUndoId: second });
  });

  it('does not take back a change that has no undo entry (the key)', async () => {
    const env = await setup();
    const undoId = await edited(env);
    body(
      await setClip(env.ctx, {
        clip: env.placement,
        expected_revision: await env.revision(),
        key: { root: 8, scale: 'major' },
      }),
    );
    const undone = body(await run(undoTool, env, { undo_id: undoId }));
    expect(undone.applied).toBe(true);
    const details = await env.otcp('content.getDetails', { contentId: env.contentId });
    expect(details.key).toMatchObject({ root: 8, scale: 'major' });
  });

  it('reports an empty history, an unsafe step and a step that changes nothing as they are', async () => {
    const empty = await setup();
    const none = failure(await run(undoTool, empty, { undo_id: 'u:00000000:1', force: true }));
    expect(none).toMatchObject({ kind: 'UNDO_CONFLICT', reason: 'history_empty' });
    expect(none.nextStep.message).toContain('nothing to undo');

    const unsafe = await setup({
      history: { undo: [{ bind: 'split', origin: 'control', action: 'clipSplit', clip: 'clip' }], redo: [] },
    });
    const unsafeId = unsafe.ids.split ?? 'u:00000000:1';
    const refused = failure(await run(undoTool, unsafe, { undo_id: unsafeId, force: true }));
    expect(refused).toMatchObject({ kind: 'UNSUPPORTED', reason: 'undo_unsafe_build' });
    expect(refused.nextStep.actor).toBe('user');

    const stale = await setup({
      clips: [clip({ trackId: 1 })],
      history: {
        undo: [{ bind: 'move', origin: 'control', action: 'clipMove', clip: 'clip', trackDeletedAfter: true }],
        redo: [],
      },
    });
    const staleId = stale.ids.move ?? '';
    const noEffect = body(await run(undoTool, stale, { undo_id: staleId, force: true }));
    expect(noEffect.noOp).toBe(true);
    expect(noEffect.summary).toContain('the undo or redo step is used up');
    expect((noEffect.warnings as { code: string }[]).map((w) => w.code)).toContain('UNDO_NO_EFFECT');
  });

  it('needs the history capability', async () => {
    const env = await setup({ withoutCapabilities: ['history.v1'] });
    expect(failure(await run(undoTool, env, { undo_id: 'u:00000000:1' }))).toMatchObject({
      kind: 'UNSUPPORTED',
      reason: 'capability_missing',
    });
  });
});

describe('the clip_revision of a write result', () => {
  it('lets the next write go ahead without reading the clip again', async () => {
    const env = await setup();
    const old = await env.revision();
    const first = body(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: old,
        ops: [{ op: 'shiftCents', select: { indices: [0] }, delta_cents: 10 }],
      }),
    );
    // The revision read before the write is stale now; the one the result returned is not.
    const stale = failure(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: old,
        ops: [{ op: 'shiftCents', select: { indices: [1] }, delta_cents: 10 }],
      }),
    );
    expect(stale).toMatchObject({ kind: 'REVISION_CONFLICT', reason: 'content_changed' });
    const second = body(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: first.clip_revision as string,
        ops: [{ op: 'shiftCents', select: { indices: [1] }, delta_cents: 10 }],
      }),
    );
    expect(second.applied).toBe(true);
    // A key change advances the key part, so an edit that uses the clip key goes ahead with it too.
    const keyed = body(
      await setClip(env.ctx, {
        clip: env.placement,
        expected_revision: second.clip_revision as string,
        key: { root: 4, scale: 'minor' },
        pitch_shift: { semitones: 1, cents: 0 },
      }),
    );
    const snapped = body(
      await editNotes(env.ctx, {
        clip: env.placement,
        expected_revision: keyed.clip_revision as string,
        ops: [{ op: 'snapToScale', select: SELECT_ALL, scale: 'clip' }],
      }),
    );
    expect(snapped.applied).toBe(true);
    expect(sent(env, 'content.editNotes').at(-1)?.params).toHaveProperty('expectedKeyRevision');
    const tuned = body(
      await autotune(env.ctx, {
        clip: env.placement,
        expected_revision: snapped.clip_revision as string,
        mode: 'snapNotes',
        scale: 'clip',
      }),
    );
    expect(tuned.applied).toBe(true);
    // It is the revision a fresh read gives.
    expect(tuned.clip_revision).toBe(await env.revision());
  });

  it('takes the tokens the results report, the caller ones for the rest, and is null with a reason otherwise', () => {
    const prior = { content: 'r1', grid: 'g1', key: 'k1', geometry: 'h1' };
    const target = { contentId: 'c:01234567:0:1', placementId: 'p:01234567:0:1' };
    const reported = (n: number, placements: unknown[] = []) => ({
      tokens: {
        arrangementRevision: 'a1',
        contents: [
          {
            contentId: target.contentId,
            revision: `r${String(n)}`,
            gridRevision: `g${String(n)}`,
            keyRevision: `k${String(n)}`,
          },
        ],
        placements,
      },
    });
    const none = withClipRevision({ summary: 's', nullReasons: { ui: 'no_editor' } }, target, prior, [
      { tokens: { arrangementRevision: 'a1', contents: [], placements: [] } },
    ]);
    expect(none.clip_revision).toBeNull();
    expect(none.nullReasons).toEqual({ ui: 'no_editor', clip_revision: 'unavailable' });
    const moved = withClipRevision({ summary: 's' }, target, prior, [
      reported(2),
      reported(3, [{ placementId: target.placementId, geometryHash: 'h3' }]),
    ]);
    expect(decodeClipRevision(moved.clip_revision as string)).toEqual({
      content: 'r3',
      grid: 'g3',
      key: 'k3',
      geometry: 'h3',
    });
    expect(moved).not.toHaveProperty('nullReasons');
    const unknownGeometry = withClipRevision({ summary: 's' }, target, { ...prior, geometry: null }, [reported(2)]);
    expect(decodeClipRevision(unknownGeometry.clip_revision as string)?.geometry).toBeNull();
    expect(unknownGeometry.nullReasons).toEqual({ clip_revision_geometry: 'unavailable' });
    const byContent = withClipRevision({ summary: 's' }, { ...target, placementId: null }, prior, [
      'odd',
      reported(4, [{ placementId: target.placementId, geometryHash: 'h9' }]),
    ]);
    expect(decodeClipRevision(byContent.clip_revision as string)).toEqual({
      content: 'r4',
      grid: 'g4',
      key: 'k4',
      geometry: 'h1',
    });
  });
});

describe('tool declarations', () => {
  const tools: [ToolDefinition, string[]][] = [
    [setClipTool, ['edit.v1', 'read.v1']],
    [autotuneTool, ['edit.v1', 'read.v1']],
    [editNotesTool, ['edit.v1', 'read.v1']],
    [undoTool, ['history.v1']],
    [redoTool, ['history.v1']],
  ];

  it('declare the capabilities they need and are not read-only', () => {
    for (const [tool, capabilities] of tools) {
      expect(tool.capabilities, tool.name).toEqual(capabilities);
      expect(tool.annotations.readOnlyHint, tool.name).toBe(false);
    }
  });

  it('mark AUTO as destructive (it removes or replaces notes), and the edits that keep every note as not', () => {
    expect(autotuneTool.annotations.destructiveHint).toBe(true);
    for (const tool of [setClipTool, editNotesTool, undoTool, redoTool]) {
      expect(tool.annotations.destructiveHint, tool.name).toBe(false);
    }
  });

  it('describe retune_speed with its polarity and the force and consent rules', () => {
    for (const tool of [autotuneTool, editNotesTool]) {
      expect(tool.description, tool.name).toMatch(/0 keeps (the )?natural/);
      expect(tool.description, tool.name).toContain('1 sounds mechanical');
    }
    const properties = (tool: ToolDefinition) =>
      (z.toJSONSchema(tool.inputSchema) as { properties: Record<string, { description?: string }> }).properties;
    expect(properties(undoTool).force?.description).toContain('explicitly asked');
    expect(properties(redoTool).force?.description).toContain('explicitly asked');
    expect(properties(autotuneTool).replace_edited_notes?.description).toContain('consent');
  });

  it('render a rendered body that the shared output schema accepts', async () => {
    const env = await setup();
    const outcome = await setClip(env.ctx, {
      clip: env.placement,
      expected_revision: await env.revision(),
      key: { root: 2, scale: 'minor' },
    });
    const result = render(outcome);
    expect(setClipTool.outputSchema?.safeParse(result.structuredContent).success).toBe(true);
    expect((result.content[0] as { text: string }).text.split('\n')).toHaveLength(1);
  });
});
