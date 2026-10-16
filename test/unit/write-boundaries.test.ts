// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Boundaries of the write tools: with several instances running no write picks one for the caller
// (and nothing reaches any of them), an instance_id that names no running instance is an error and
// never a reason to switch, and a write whose outcome is unknown (the request timed out, the
// connection dropped) is sent once and reported as possibly executed, never repeated.

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startMock, type OtcpMock } from '../../mock/server.js';
import { OtcpError } from '../../src/errors/tool-error.js';
import type { OtcpSession } from '../../src/otcp/client.js';
import { encodeClipRevision } from '../../src/otcp/tokens.js';
import { autotuneTool } from '../../src/tools/autotune.js';
import { editNotesTool } from '../../src/tools/edit-notes.js';
import { exportAudioTool } from '../../src/tools/export-audio.js';
import { redoTool, undoTool } from '../../src/tools/history.js';
import { getProject } from '../../src/tools/project.js';
import { render, type Outcome, type ToolDefinition } from '../../src/tools/registry.js';
import { setClipTool } from '../../src/tools/set-clip.js';
import { discoveryContent, tempDir, testContext, type TestContext } from '../support/context.js';
import { clip } from '../support/mock-client.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const failure = (outcome: Outcome) => {
  if (outcome.ok) throw new Error('expected an error');
  return outcome.error;
};

const REVISION = encodeClipRevision({ content: 'c1', grid: 'g1', key: 'k1', geometry: 'h1' });
const CLIP = 'p:00000000:0:0';

/** One valid call of every write tool, as an agent would send it (instance_id added by the tests). */
const WRITES: readonly {
  readonly name: string;
  readonly tool: ToolDefinition;
  readonly args: Record<string, unknown>;
}[] = [
  {
    name: 'opentune_edit_notes',
    tool: editNotesTool,
    args: {
      clip: CLIP,
      expected_revision: REVISION,
      ops: [{ op: 'shiftCents', select: { all: true }, delta_cents: 10 }],
    },
  },
  {
    name: 'opentune_autotune_range',
    tool: autotuneTool,
    args: { clip: CLIP, expected_revision: REVISION, mode: 'snapNotes', scale: 'clip' },
  },
  {
    name: 'opentune_export_audio',
    tool: exportAudioTool,
    args: { kind: 'master', path: 'C:\\Music\\out.wav' },
  },
  {
    name: 'opentune_set_clip',
    tool: setClipTool,
    args: { clip: CLIP, expected_revision: REVISION, pitch_shift: { semitones: 1, cents: 0 } },
  },
  { name: 'opentune_undo', tool: undoTool, args: { undo_id: 'u:00000000:1' } },
  { name: 'opentune_redo', tool: redoTool, args: { undo_id: 'u:00000000:1' } },
];

describe('write tools with several instances', () => {
  function twoInstances() {
    const t = tempDir();
    cleanup.push(t.remove);
    for (const i of [0, 1]) {
      writeFileSync(
        path.join(t.dir, `${String(9100 + i)}.json`),
        JSON.stringify(discoveryContent(9100 + i, { processStartTimeMs: i })),
      );
    }
    const opened: string[] = [];
    const calls: string[] = [];
    const ctx = testContext(t.dir, {
      open: (entry) => {
        opened.push(entry.instanceId);
        return Promise.resolve({
          closed: false,
          hello: {
            protocol: '1.0',
            instanceId: entry.instanceId,
            pid: entry.pid,
            appVersion: '1',
            capabilities: ['session.v1', 'read.v1', 'edit.v1', 'export.v1', 'jobs.v1', 'history.v1'],
          },
          call: (method: string) => {
            calls.push(method);
            return Promise.resolve({});
          },
          close: () => undefined,
        } as unknown as OtcpSession);
      },
    });
    return { ctx, opened, calls };
  }

  for (const write of WRITES) {
    it(`${write.name} without instance_id: MULTIPLE_INSTANCES, and no instance is contacted`, async () => {
      const { ctx, opened, calls } = twoInstances();
      const outcome = await write.tool.run(write.tool.inputSchema.parse(write.args), ctx);
      expect(failure(outcome)).toMatchObject({ kind: 'MULTIPLE_INSTANCES', executed: false });
      expect(opened).toEqual([]);
      expect(calls).toEqual([]);
      // The error lists the candidates, so the agent can pick one.
      expect((outcome as { context?: { instances?: unknown[] } }).context?.instances).toHaveLength(2);
    });

    it(`${write.name} with an instance_id that names no instance: INSTANCE_NOT_FOUND, no other instance is used`, async () => {
      const { ctx, opened, calls } = twoInstances();
      const args = write.tool.inputSchema.parse({ ...write.args, instance_id: 'e'.repeat(32) });
      expect(failure(await write.tool.run(args, ctx))).toMatchObject({ kind: 'INSTANCE_NOT_FOUND', executed: false });
      expect(opened).toEqual([]);
      expect(calls).toEqual([]);
    });
  }
});

describe('a write whose outcome is unknown is not sent again', () => {
  async function setup(): Promise<{
    mock: OtcpMock;
    ctx: TestContext;
    session: OtcpSession;
    ids: Record<string, string>;
  }> {
    const t = tempDir();
    cleanup.push(t.remove);
    const mock = await startMock({ discoveryDir: t.dir });
    cleanup.push(() => mock.stop());
    const ctx = testContext(t.dir);
    cleanup.push(() => {
      ctx.instances.close();
    });
    const ids = mock.given({ clips: [clip()], history: { undo: [], redo: [] } });
    const scan = await ctx.instances.scan();
    if (!('instances' in scan) || scan.instances[0] === undefined) throw new Error('no instance');
    return { mock, ctx, session: await ctx.instances.session(scan.instances[0]), ids };
  }

  /** Makes `method` fail the way a lost answer does; counts what is sent. */
  function failOn(session: OtcpSession, method: string, error: OtcpError) {
    const original = session.call.bind(session);
    const sent: string[] = [];
    session.call = (m, params, timeoutMs) => {
      sent.push(m);
      return m === method ? Promise.reject(error) : original(m, params, timeoutMs);
    };
    return sent;
  }

  const unknownOutcomes: readonly (readonly [string, OtcpError])[] = [
    [
      'REQUEST_TIMEOUT',
      new OtcpError({ kind: 'REQUEST_TIMEOUT', reason: null, retryable: true, detail: 'no answer', executed: null }),
    ],
    [
      'CONNECTION_LOST',
      new OtcpError({ kind: 'CONNECTION_LOST', reason: null, retryable: true, detail: 'closed', executed: null }),
    ],
  ];

  const cases: readonly {
    readonly tool: ToolDefinition;
    readonly method: string;
    readonly args: (e: { placement: string; revision: string }) => Record<string, unknown>;
  }[] = [
    {
      tool: editNotesTool,
      method: 'content.editNotes',
      args: (e) => ({
        clip: e.placement,
        expected_revision: e.revision,
        ops: [{ op: 'shiftCents', select: { indices: [0] }, delta_cents: 25 }],
      }),
    },
    {
      tool: autotuneTool,
      method: 'content.autoTune',
      args: (e) => ({ clip: e.placement, expected_revision: e.revision, mode: 'snapNotes', scale: 'clip' }),
    },
    {
      tool: setClipTool,
      method: 'content.setPitchShift',
      args: (e) => ({ clip: e.placement, expected_revision: e.revision, pitch_shift: { semitones: 1, cents: 0 } }),
    },
    {
      tool: exportAudioTool,
      method: 'export.start',
      args: () => ({ kind: 'master', path: 'C:\\Music\\unknown-outcome.wav' }),
    },
    { tool: undoTool, method: 'edit.undo', args: () => ({ undo_id: 'u:00000000:1' }) },
  ];

  for (const { tool, method, args } of cases) {
    for (const [label, error] of unknownOutcomes) {
      it(`${tool.name} sends ${method} once on ${label} and says it may have run`, async () => {
        const { ctx, session, ids } = await setup();
        const project = await getProject(ctx, {});
        if (!project.ok) throw new Error('project');
        const revision = (project.body.placements as { clip_revision: string }[])[0]?.clip_revision ?? '';
        const sent = failOn(session, method, error);
        const outcome = await tool.run(
          tool.inputSchema.parse(args({ placement: ids['clip.placementId'] ?? '', revision })),
          ctx,
        );
        expect(sent.filter((m) => m === method)).toHaveLength(1);
        const reported = failure(outcome);
        expect(reported.kind).toBe(label);
        // Unknown, not "no": the agent must not assume the write did not happen.
        expect(reported.executed).toBeNull();
        expect(reported.nextStep.message).toMatch(/may (or may not have run|still run)/);
        expect(reported.nextStep.message).toContain('Re-read');
        const text = (render(outcome).content[0] as { text: string }).text;
        expect(text).toContain('"executed":null');
      });
    }
  }
});
