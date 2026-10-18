// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { startMock, type GivenJob, type OtcpMock } from '../../mock/server.js';
import type { DiscoveryEntry } from '../../src/discovery/file.js';
import { OtcpError, type ErrorData } from '../../src/errors/tool-error.js';
import { OtcpSession } from '../../src/otcp/client.js';
import { TOOLS } from '../../src/tools/index.js';
import { CANCEL_EFFECT, cancelJob, getJob, jobSentence } from '../../src/tools/jobs.js';
import { WRITE_RESULT_OUTPUT, render, withInstance, type Outcome } from '../../src/tools/registry.js';
import { STATUS_REASON_STEPS, STATUS_STATES, STATUS_TEXT, getStatus } from '../../src/tools/status.js';
import { discoveryContent, tempDir, testContext, type TestContext } from '../support/context.js';
import { otcpSpec } from '../support/otcp-spec.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function dir(): string {
  const t = tempDir();
  cleanup.push(t.remove);
  return t.dir;
}

function context(d: string, options: Parameters<typeof testContext>[1] = {}): TestContext {
  const ctx = testContext(d, options);
  cleanup.push(() => {
    ctx.instances.close();
  });
  return ctx;
}

async function withMock(): Promise<{ mock: OtcpMock; ctx: TestContext }> {
  const d = dir();
  const m = await startMock({ discoveryDir: d });
  cleanup.push(() => m.stop());
  return { mock: m, ctx: context(d) };
}

/** Sets up jobs on the mock and returns their ids by binding name. */
function given<K extends string>(m: OtcpMock, jobs: (GivenJob & { bind: K })[]): Record<K, string> {
  const bound = m.given({ jobs });
  return Object.fromEntries(jobs.map((j) => [j.bind, bound[j.bind] ?? ''])) as Record<K, string>;
}

const body = (outcome: Outcome) => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.error.kind}`);
  return outcome.body;
};
const error = (outcome: Outcome) => {
  if (outcome.ok) throw new Error('expected an error');
  return outcome.error;
};

describe('tool declarations', () => {
  const capabilities = new Set(
    (otcpSpec().methods.size > 0 ? [...otcpSpec().methods.values()] : []).map((m) => m.capability),
  );

  it.each(TOOLS.map((t) => [t.name, t] as const))('%s follows the tool-surface rules', (name, tool) => {
    expect(name).toMatch(/^opentune_[a-z0-9_]+$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(tool.title.length).toBeGreaterThan(0);
    expect(tool.description.startsWith('OpenTune (audio vocal pitch editor): ')).toBe(true);
    expect(tool.description.length).toBeLessThanOrEqual(600);
    expect(tool.annotations.openWorldHint).toBe(false);
    if (tool.annotations.readOnlyHint) expect(tool.annotations.destructiveHint).toBe(false);
    expect(tool.capabilities.length).toBeGreaterThan(0);
    for (const c of tool.capabilities) expect(capabilities.has(c), c).toBe(true);
    for (const method of tool.otcpMethods) {
      const info = otcpSpec().methods.get(method);
      expect(info?.defined, method).toBe(true);
      expect(tool.capabilities, method).toContain(info?.capability);
    }
  });

  it('marks only opentune_get_status alwaysLoad, and names are unique', () => {
    expect(TOOLS.filter((t) => t.alwaysLoad).map((t) => t.name)).toEqual(['opentune_get_status']);
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
  });

  it('defines the shared write-result outputSchema: top-level members only, no enum, at most 600 bytes', () => {
    const json = z.toJSONSchema(WRITE_RESULT_OUTPUT, { target: 'draft-2020-12', io: 'output' });
    const text = JSON.stringify(json);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(600);
    expect(text).not.toMatch(/"(enum|const)"/);
    for (const member of Object.values((json as { properties: Record<string, object> }).properties)) {
      expect(Object.keys(member)).toEqual([]);
    }
    expect(WRITE_RESULT_OUTPUT.safeParse({ summary: 'x', applied: true, extra: 1 }).success).toBe(true);
  });

  it('renders outcomes as structured content and the same JSON as text', () => {
    const ok = render({ ok: true, body: { summary: 'Done.', n: 1 } });
    expect(ok).toEqual({
      content: [{ type: 'text', text: '{"summary":"Done.","n":1}' }],
      structuredContent: { summary: 'Done.', n: 1 },
    });
    const failed = render({ ok: false, error: { kind: 'X' } as never, context: { instances: [] } });
    expect(failed).toMatchObject({ isError: true, structuredContent: { error: { kind: 'X' }, instances: [] } });
  });
});

describe('opentune_get_status', () => {
  const exeDir = (d: string, manifest: string | null) => {
    const bin = path.join(d, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'OpenTune.exe'), '');
    if (manifest !== null) writeFileSync(path.join(bin, 'opentune-control.json'), manifest);
    return path.join(bin, 'OpenTune.exe');
  };

  function expectState(outcome: Outcome, state: string, reason: string | null) {
    const b = body(outcome);
    expect(b).toMatchObject({
      state,
      reason,
      url: expect.stringMatching(new RegExp(`#status-${state.toLowerCase()}$`)) as unknown,
    });
    const step =
      (reason === null ? undefined : STATUS_REASON_STEPS[`${state}/${reason}`]) ?? STATUS_TEXT[state as 'READY'].step;
    expect(b.nextStep).toEqual(step);
    return b;
  }

  it('has a summary and a next step for every state', () => {
    for (const state of STATUS_STATES) {
      expect(STATUS_TEXT[state].summary.length, state).toBeGreaterThan(10);
      expect(STATUS_TEXT[state].step.message.length, state).toBeGreaterThan(10);
    }
  });

  it('walks the configuration states when nothing runs', async () => {
    const d = dir();
    expectState(await getStatus(context(d), undefined), 'NOT_INSTALLED', 'path_not_configured');
    const env = (p: string) => ({ env: { OPENTUNE_MCP_OPENTUNE_PATH: p } });
    expectState(await getStatus(context(d, env('OpenTune.exe')), undefined), 'NOT_INSTALLED', 'not_absolute');
    expectState(await getStatus(context(d, env(path.join(d, 'missing.exe'))), undefined), 'NOT_INSTALLED', 'not_found');
    expectState(await getStatus(context(d, env(d)), undefined), 'NOT_INSTALLED', 'not_a_file');
    const cases: [string | null, string, string | null][] = [
      [null, 'NO_API_BUILD', 'manifest_missing'],
      ['not json', 'NO_API_BUILD', 'manifest_invalid'],
      ['{"protocolMajors":"1"}', 'NO_API_BUILD', 'manifest_invalid'],
      ['{"protocolMajors":[2]}', 'NO_API_BUILD', 'protocol_mismatch'],
      ['{"protocolMajors":[1]}', 'NOT_RUNNING', null],
    ];
    for (const [manifest, state, reason] of cases) {
      const sub = path.join(d, `case-${String(cases.findIndex((c) => c[0] === manifest))}`);
      expectState(await getStatus(context(d, env(exeDir(sub, manifest))), undefined), state, reason);
    }
  });

  it('tells an OpenTune that is starting from one that runs without the control API', async () => {
    const d = dir();
    const ctx = context(d, { now: 1_000_000 });
    ctx.probe.openTune = [777];
    ctx.probe.info.set(777, { alive: true, startTimeMs: 1_000_000 - 5_000 });
    expect(expectState(await getStatus(ctx, undefined), 'STARTING', null)).toMatchObject({ processes: [{ pid: 777 }] });
    ctx.probe.info.set(777, { alive: true, startTimeMs: 1_000_000 - 60_000 });
    expectState(await getStatus(ctx, undefined), 'RUNNING_WITHOUT_API', null);
  });

  it('reports WSL before anything else', async () => {
    const ctx = context(dir());
    const wsl = { ...ctx, platform: 'linux' as const, env: { ...ctx.env, WSL_DISTRO_NAME: 'Ubuntu' } };
    expectState(await getStatus(wsl, undefined), 'WSL_UNSUPPORTED_RUNTIME', null);
  });

  it('is READY against the mock and describes the instance', async () => {
    const { mock: m, ctx } = await withMock();
    const b = expectState(await getStatus(ctx, undefined), 'READY', null);
    expect(b.instances).toEqual([
      expect.objectContaining({
        instanceId: m.discovery.instanceId,
        state: 'READY',
        protocol: '1.0',
        capabilities: expect.arrayContaining(['jobs.v1']) as unknown,
        info: expect.objectContaining({
          appVersion: '0.0.0-mock',
          processing: expect.any(Object) as unknown,
        }) as unknown,
      }),
    ]);
    expect(b.instances).toEqual([expect.not.objectContaining({ nullReasons: expect.anything() as unknown })]);
    expect(JSON.stringify(b)).not.toContain(m.discovery.token);
    expect(JSON.stringify(b)).not.toContain(m.discovery.serverProof as string);
    expectState(await getStatus(ctx, m.discovery.instanceId), 'READY', null);
    const stale = error(await getStatus(ctx, 'e'.repeat(32)));
    expect(stale.kind).toBe('INSTANCE_NOT_FOUND');
  });

  /** Writes discovery files for fake instances served by `sessions`. */
  function fakeInstances(sessions: ((entry: DiscoveryEntry) => Promise<OtcpSession>)[], majors: number[][] = []) {
    const d = dir();
    sessions.forEach((_s, i) => {
      const pid = 9000 + i;
      writeFileSync(
        path.join(d, `${String(pid)}.json`),
        JSON.stringify(discoveryContent(pid, { protocolMajors: majors[i] ?? [1], processStartTimeMs: i })),
      );
    });
    return context(d, {
      open: (entry) => (sessions[entry.pid - 9000] as (e: DiscoveryEntry) => Promise<OtcpSession>)(entry),
    });
  }
  const session = (info: () => Promise<unknown>) => (entry: DiscoveryEntry) =>
    Promise.resolve({
      closed: false,
      hello: {
        protocol: '1.0',
        instanceId: entry.instanceId,
        pid: entry.pid,
        appVersion: '1',
        capabilities: ['session.v1'],
      },
      call: info,
      close: () => undefined,
    } as unknown as OtcpSession);
  const failing = (data: Partial<ErrorData>) => () =>
    Promise.reject(
      new OtcpError({ kind: 'INTERNAL', reason: null, retryable: false, detail: 'x', executed: false, ...data }),
    );

  it('asks which instance to use when several are announced, ready or not', async () => {
    const ctx = fakeInstances([session(() => Promise.resolve({})), session(() => Promise.resolve({}))]);
    const b = expectState(await getStatus(ctx, undefined), 'READY', 'multiple_instances');
    expect(b.summary).toBe('2 OpenTune instances are running (2 ready); pass instance_id to choose one.');
    expect(b.instances).toHaveLength(2);
    const mixed = fakeInstances([failing({ kind: 'SHUTTING_DOWN' }), session(() => Promise.resolve({}))]);
    const m = expectState(await getStatus(mixed, undefined), 'READY', 'multiple_instances');
    expect(m.summary).toBe('2 OpenTune instances are running (1 ready); pass instance_id to choose one.');
  });

  it.each([
    [{ kind: 'CONNECTION_LOST', reason: 'connect_failed' }, 'NOT_READY', 'connect_failed'],
    [{ kind: 'CONNECTION_LOST', reason: null }, 'NOT_READY', 'session_failed'],
    [{ kind: 'INSTANCE_UNVERIFIED', reason: 'proof_mismatch' }, 'NOT_READY', 'instance_unverified'],
    [{ kind: 'AUTH_FAILED' }, 'NOT_READY', 'auth_failed'],
    [{ kind: 'SHUTTING_DOWN' }, 'NOT_READY', 'shutting_down'],
    [{ kind: 'BUSY', reason: 'session_limit' }, 'NOT_READY', 'session_limit'],
    [{ kind: 'PROTOCOL_MISMATCH' }, 'PROTOCOL_MISMATCH', 'hello_rejected'],
    [{ kind: 'PROTOCOL_MISMATCH', reason: 'major_not_served' }, 'PROTOCOL_MISMATCH', 'major_not_served'],
  ])('maps a failed session (%j) to %s', async (data, state, reason) => {
    const ctx = fakeInstances([failing(data)]);
    expectState(await getStatus(ctx, undefined), state, reason);
  });

  it('does not connect to an instance that serves no supported major', async () => {
    let opened = 0;
    const ctx = fakeInstances(
      [
        () => {
          opened++;
          return Promise.reject(new Error('must not connect'));
        },
      ],
      [[2]],
    );
    expectState(await getStatus(ctx, undefined), 'PROTOCOL_MISMATCH', 'major_not_served');
    expect(opened).toBe(0);
  });

  it('stays READY when session.info fails after a verified hello', async () => {
    const ctx = fakeInstances([session(failing({ kind: 'BUSY', reason: 'modal_open' }))]);
    const b = expectState(await getStatus(ctx, undefined), 'READY', null);
    expect(b.instances).toEqual([expect.objectContaining({ info: null, nullReasons: { info: 'unavailable' } })]);
  });

  it('gives a reason for each part of session.info that the instance does not report', async () => {
    const runtime = { os: 'windows', arch: 'x64' };
    const ctx = fakeInstances([session(() => Promise.resolve({ appVersion: '1', runtime, audioDevice: 'none' }))]);
    const b = expectState(await getStatus(ctx, undefined), 'READY', null);
    expect(b.instances).toEqual([
      expect.objectContaining({
        info: { appVersion: '1', runtime, audioDevice: null, processing: null },
        nullReasons: { 'info.audioDevice': 'not_reported', 'info.processing': 'not_reported' },
      }),
    ]);
  });

  it('says when the OpenTune processes cannot be listed', async () => {
    const ctx = context(dir());
    ctx.probe.openTune = null;
    const b = expectState(await getStatus(ctx, undefined), 'NOT_INSTALLED', 'path_not_configured');
    expect(b).toMatchObject({ processes: null, nullReasons: { processes: 'not_listable' } });
    ctx.probe.openTune = [];
    expect(body(await getStatus(ctx, undefined))).not.toHaveProperty('nullReasons');
  });

  it('reports discovery files it ignored, and configuration errors as errors', async () => {
    const d = dir();
    writeFileSync(path.join(d, '55.json'), '{}');
    expect(body(await getStatus(context(d), undefined)).ignoredDiscoveryFiles).toEqual([
      { file: '55.json', reason: 'invalid', removed: false },
    ]);
    const bad = context(d, { env: { OPENTUNE_MCP_DISCOVERY_DIR: 'relative' } });
    expect(error(await getStatus(bad, undefined))).toMatchObject({
      kind: 'CONFIG_INVALID',
      nextStep: { actor: 'user' },
    });
  });
});

describe('opentune_get_job and opentune_cancel_job', () => {
  it('reports jobs in every state from checked values only', async () => {
    const { mock: m, ctx } = await withMock();
    const ids = given(m, [
      { bind: 'run', kind: 'import', state: 'running', cancellable: true },
      { bind: 'done', kind: 'export', state: 'succeeded', cancellable: false },
      {
        bind: 'fail',
        kind: 'export',
        state: 'failed',
        cancellable: false,
        error: { kind: 'IO_ERROR', reason: 'write_failed' },
      },
      { bind: 'gone', kind: 'import', state: 'cancelled', cancellable: false },
    ]);
    const summary = async (id: string) => body(await getJob(ctx, { job_id: id })).summary;
    expect(await summary(ids.run)).toBe(
      `Job ${ids.run} (import) is running, 50% done. Call opentune_get_job again to follow it.`,
    );
    expect(await summary(ids.done)).toMatch(/succeeded; its result is in job\.result\.$/);
    expect(await summary(ids.fail)).toMatch(/failed with IO_ERROR; see job\.error\.$/);
    expect(await summary(ids.gone)).toMatch(/was cancelled/);
    expect(body(await getJob(ctx, { job_id: ids.done, wait_seconds: 1 })).job).toMatchObject({
      state: 'succeeded',
    });
    expect(error(await getJob(ctx, { job_id: `j:${m.discovery.instanceId.slice(0, 8)}:99` }))).toMatchObject({
      kind: 'NOT_FOUND',
      reason: 'job_not_found',
    });
    expect(jobSentence({ jobId: 'j:01234567:1', state: 'running', kind: 'x y', progress: null })).toBe(
      'Job j:01234567:1 (unknown) is running. Call opentune_get_job again to follow it.',
    );
    expect(jobSentence({ jobId: 'not a job id', state: 'running' })).toMatch(/cannot describe/);
  });

  it('cancels a cancellable job and reports what cancelling does', async () => {
    const { mock: m, ctx } = await withMock();
    const ids = given(m, [
      { bind: 'imp', kind: 'import', state: 'running', cancellable: true },
      { bind: 'done', kind: 'export', state: 'succeeded', cancellable: false },
      { bind: 'save', kind: 'projectSave', state: 'running', cancellable: false },
    ]);
    const cancelled = body(await cancelJob(ctx, { job_id: ids.imp }));
    expect(cancelled).toMatchObject({
      cancelRequested: true,
      effect: CANCEL_EFFECT.import,
      job: { state: 'cancelled' },
    });
    expect(cancelled.summary).toBe(`Job ${ids.imp} (import) was cancelled. ${String(CANCEL_EFFECT.import)}`);
    const again = body(await cancelJob(ctx, { job_id: ids.imp }));
    expect(again).toMatchObject({ cancelRequested: false });
    expect(again.summary).toMatch(/had already ended \(cancelled\); nothing was cancelled\.$/);
    expect(body(await cancelJob(ctx, { job_id: ids.done })).cancelRequested).toBe(false);
    const refused = error(await cancelJob(ctx, { job_id: ids.save }));
    expect(refused).toMatchObject({
      kind: 'UNSUPPORTED',
      reason: 'job_not_cancellable',
      nextStep: { actor: 'agent', tool: 'opentune_get_job', args: { job_id: ids.save } },
    });
    expect(error(await cancelJob(ctx, { job_id: 'j:00000000:1' }))).toMatchObject({ kind: 'INSTANCE_NOT_FOUND' });
  });

  it('reports a requested cancellation even when waiting for the job to stop fails', async () => {
    const d = dir();
    const m = await startMock({ discoveryDir: d });
    cleanup.push(() => m.stop());
    const ctx = context(d, {
      // The instance answers job.cancel, then fails the job.get that waits for the job to stop.
      open: async (entry) => {
        const session = await OtcpSession.open(entry);
        const call = session.call.bind(session);
        session.call = (method, params, timeoutMs) =>
          method === 'job.get'
            ? Promise.reject(
                new OtcpError({
                  kind: 'BUSY',
                  reason: 'request_limit',
                  retryable: true,
                  detail: 'too many requests',
                  executed: false,
                }),
              )
            : call(method, params, timeoutMs);
        return session;
      },
    });
    const ids = given(m, [{ bind: 'imp', kind: 'import', state: 'running', cancellable: true }]);
    const outcome = await cancelJob(ctx, { job_id: ids.imp });
    const b = body(outcome);
    expect(b).toMatchObject({ cancelRequested: true, effect: CANCEL_EFFECT.import, job: { state: 'running' } });
    expect(b.summary).toBe(
      `Cancellation of job ${ids.imp} (import) was requested; it stops at its next cancellation point. Follow it ` +
        'with opentune_get_job.',
    );
    expect(JSON.stringify(outcome)).not.toContain('"executed"');
    expect(ctx.logLines.join('\n')).toMatch(/waiting for the cancelled job failed \(BUSY\(request_limit\)\)/);
  });

  it('refuses a job id issued by another instance than instance_id, without asking OpenTune', async () => {
    const { mock: m, ctx } = await withMock();
    const ids = given(m, [{ bind: 'run', kind: 'import', state: 'running', cancellable: true }]);
    const own = m.discovery.instanceId;
    const other = `${own.startsWith('0') ? '1' : '0'}${own.slice(1)}`;
    const foreign = `j:${other.slice(0, 8)}:1`;
    for (const outcome of [
      await getJob(ctx, { job_id: foreign, instance_id: own }),
      await cancelJob(ctx, { job_id: foreign, instance_id: own }),
    ]) {
      expect(error(outcome)).toMatchObject({
        kind: 'INVALID_ARGUMENT',
        reason: null,
        executed: false,
        detail: expect.stringContaining(
          `job_id ${foreign} belongs to another OpenTune instance than instance_id`,
        ) as unknown,
      });
    }
    expect(body(await getJob(ctx, { job_id: ids.run, instance_id: own })).job).toMatchObject({ state: 'running' });
  });

  it('needs the jobs capability', async () => {
    const { mock: m, ctx } = await withMock();
    m.given({ withoutCapabilities: ['jobs.v1'] });
    expect(error(await getJob(ctx, { job_id: `j:${m.discovery.instanceId.slice(0, 8)}:1` }))).toMatchObject({
      kind: 'UNSUPPORTED',
      reason: 'capability_missing',
      detail: 'this OpenTune build does not report the capability jobs.v1',
    });
  });

  it('turns failures around the call into error outcomes and rethrows programming errors', async () => {
    const ctx = context(dir());
    expect(error(await getJob(ctx, { job_id: 'j:01234567:1' }))).toMatchObject({ kind: 'INSTANCE_NOT_FOUND' });
    const { ctx: live } = await withMock();
    await expect(
      withInstance(live, { instanceId: undefined }, [], () => Promise.reject(new TypeError('bug'))),
    ).rejects.toThrow(TypeError);
  });
});
