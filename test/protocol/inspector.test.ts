// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// MCP Inspector CLI scripted scenarios against the built bundle and the mock. `tools/list` runs
// with the Inspector's own `--strict` schema portability check and a strict reading of every tool
// (the fields clients rely on, the catalog equal to the golden snapshot); then an agent's usual
// route runs call by call: get_status, get_project, get_notes, analyze_pitch, the dry run of two
// write tools, get_job, and the two kinds of failure (a refused call, an invalid argument).

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { startMock } from '../../mock/server.js';
import { tempDir } from '../support/context.js';
import { inspect } from '../support/inspector.js';
import { clip, need } from '../support/mock-client.js';

const BUNDLE = process.env.SMOKE_BUNDLE ?? fileURLToPath(new URL('../../dist/opentune-mcp.mjs', import.meta.url));
const GOLDEN = fileURLToPath(new URL('../golden/tools-list.json', import.meta.url));

/** The Inspector exits with 5 when a tool answers with isError. */
const TOOL_ERROR_EXIT = 5;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { type?: string; additionalProperties?: unknown };
  annotations?: Record<string, unknown>;
}

interface Finding {
  severity: string;
  schema?: string;
  path?: string;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

async function setup() {
  const dir = tempDir();
  cleanup.push(dir.remove);
  const mock = await startMock({ discoveryDir: dir.dir });
  cleanup.push(() => mock.stop());
  const ids = mock.given({
    dirty: false,
    clips: [clip()],
    jobs: [{ bind: 'imp', kind: 'import', state: 'running', cancellable: true }],
  });
  const env = { OPENTUNE_MCP_DISCOVERY_DIR: dir.dir };
  const call = async (tool: string, args: Record<string, unknown>, exit = 0) => {
    const run = await inspect(BUNDLE, env, 'tools/call', { toolName: tool, toolArgs: args });
    expect(run.code, `${tool} exit code; stderr: ${run.stderr.slice(0, 300)}`).toBe(exit);
    expect(run.json, `${tool} printed JSON`).not.toBeNull();
    return run.json as ToolResult;
  };
  return { mock, ids, env, call };
}

describe('Inspector CLI', () => {
  it('tools/list --strict: no portability errors, every tool fully described, equal to the golden snapshot', async () => {
    const { env } = await setup();
    const run = await inspect(BUNDLE, env, 'tools/list', { strict: true });
    expect(run.code, run.stderr.slice(0, 500)).toBe(0);
    const out = run.json as { result: { tools: Tool[] }; schemaFindings?: { toolName: string; findings: Finding[] }[] };
    const tools = out.result.tools;

    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Tool[];
    expect(tools.map((t) => t.name)).toEqual(golden.map((t) => t.name));
    expect(tools).toEqual(golden);
    for (const tool of tools) {
      expect(tool.name, 'name').toMatch(/^opentune_[a-z0-9_]+$/);
      expect(tool.title, `${tool.name} title`).toBeTruthy();
      expect(tool.description, `${tool.name} description`).toMatch(/^OpenTune \(audio vocal pitch editor\): /);
      expect(tool.inputSchema, `${tool.name} inputSchema`).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      expect(tool.annotations, `${tool.name} annotations`).toMatchObject({
        readOnlyHint: expect.any(Boolean) as unknown,
        destructiveHint: expect.any(Boolean) as unknown,
        idempotentHint: expect.any(Boolean) as unknown,
        openWorldHint: false,
      });
    }

    // The Inspector's portability check: no errors at all. Its warnings are about the deliberately
    // loose outputSchema of the write tools (top-level keys only); the input schemas, which the
    // model fills in, have none.
    const findings = (out.schemaFindings ?? []).flatMap((r) => r.findings.map((f) => ({ tool: r.toolName, ...f })));
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    for (const f of findings) expect(f.schema, `${f.tool} warning at ${f.path ?? ''}`).toBe('outputSchema');
  });

  it('runs the read route: status, project, notes, pitch analysis', async () => {
    const { mock, ids, call } = await setup();
    const placement = need(ids, 'clip.placementId');

    const status = await call('opentune_get_status', {});
    expect(status.structuredContent).toMatchObject({
      state: 'READY',
      instances: [{ instanceId: mock.discovery.instanceId, state: 'READY' }],
    });
    expect(JSON.parse(status.content[0]?.text ?? '')).toEqual(status.structuredContent);

    const project = await call('opentune_get_project', {});
    expect(project.structuredContent).toMatchObject({ summary: expect.any(String) as unknown });
    expect(JSON.stringify(project.structuredContent)).toContain(placement);

    const notes = await call('opentune_get_notes', { clip: placement, clock: 'content' });
    expect((notes.structuredContent?.notes as unknown[]).length).toBe(3);
    expect(notes.structuredContent?.clip_revision).toEqual(expect.any(String));

    const pitch = await call('opentune_analyze_pitch', { clip: placement });
    expect(pitch.structuredContent).toMatchObject({ summary: expect.any(String) as unknown });
  });

  it('runs the write route as dry runs that change nothing, then follows a job', async () => {
    const { ids, call } = await setup();
    const placement = need(ids, 'clip.placementId');
    const before = (await call('opentune_get_notes', { clip: placement, clock: 'content' })).structuredContent;
    const revision = before?.clip_revision as string;

    const edit = await call('opentune_edit_notes', {
      clip: placement,
      expected_revision: revision,
      ops: [{ op: 'shiftCents', select: { indices: [0] }, delta_cents: 25 }],
      dry_run: true,
    });
    expect(edit.structuredContent).toMatchObject({ dryRun: true });
    const tune = await call('opentune_autotune_range', {
      clip: placement,
      expected_revision: revision,
      mode: 'snapNotes',
      scale: { root: 0, scale: 'major' },
      dry_run: true,
    });
    expect(tune.structuredContent).toMatchObject({ dryRun: true });

    const after = (await call('opentune_get_notes', { clip: placement, clock: 'content' })).structuredContent;
    expect(after).toEqual(before);

    const job = await call('opentune_get_job', { job_id: need(ids, 'imp') });
    expect(job.structuredContent).toMatchObject({ job: { jobId: need(ids, 'imp'), state: 'running' } });
  });

  it('reports a refused call and an invalid argument as isError, with a next step for the first', async () => {
    const { mock, call } = await setup();
    const unknownJob = `j:${mock.discovery.instanceId.slice(0, 8)}:99`;
    const gone = await call('opentune_get_job', { job_id: unknownJob }, TOOL_ERROR_EXIT);
    expect(gone.isError).toBe(true);
    expect(gone.structuredContent).toMatchObject({
      error: { kind: expect.any(String) as unknown, nextStep: { message: expect.any(String) as unknown } },
    });
    const invalid = await call('opentune_get_job', { job_id: 'x' }, TOOL_ERROR_EXIT);
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]?.text).toMatch(/^Input validation error/);
  });
});
