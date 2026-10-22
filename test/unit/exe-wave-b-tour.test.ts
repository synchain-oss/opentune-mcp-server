// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The wave-B tour (test/e2e/wave-b-tour.ts) against the test mock in place of an executable: every
// check passes on a correct fake, and a fake whose answer carries one defect fails exactly the check
// that notices it (a wrong `after` value, a token that is not the one a fresh read returns, a revert
// recipe that does not restore the state, a result that fails its method schema, a missing promised
// warning, and a tool text that does not say that the change cannot be undone). The MCP part runs the
// real tools in process over the same mock, so the tour's tool checks are exercised end to end.

import { afterEach, describe, expect, it } from 'vitest';

import { realClock, type Clock } from '../../mock/clock.js';
import { REFERENCE_WAIT_LIMIT_MS as MOCK_REFERENCE_WAIT_LIMIT_MS } from '../../mock/reference.js';
import { startMock, type OtcpMock } from '../../mock/server.js';
import { OtcpSession, type Json } from '../../src/otcp/client.js';
import type { McpProcess, RealInstance, RealInstanceOptions, ToolOutcome } from '../e2e/real-support.js';
import type { SmokeConfig } from '../e2e/smoke.js';
import {
  REFERENCE_WAIT_LIMIT_MS,
  chooseAudioSwitch,
  isKnownStalledDefect,
  refusalIsDefect,
  runWaveBTour,
  type WaveBTourHooks,
  type WaveBTourReport,
} from '../e2e/wave-b-tour.js';
import { INITIALIZE, mcpClient, testContext, type TestContext } from '../support/context.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const config: SmokeConfig = {
  exe: { exe: process.execPath },
  stepTimeoutMs: 20_000,
  reportPath: undefined,
};

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Changes one OTCP reply before the tour sees it. */
type SessionDefect = (method: string, result: Json, params: Json) => Json | undefined;
/** Changes one MCP tool result before the tour sees it. */
type ToolDefect = (tool: string, body: Json) => unknown;

/** Runs before a call is sent to the instance. */
type BeforeCall = (method: string, params: Json) => void;

/** A session that answers like `session`, with `defect` applied to every reply. */
function wrapSession(session: OtcpSession, defect: SessionDefect, before?: BeforeCall): OtcpSession {
  const wrapped = {
    get hello() {
      return session.hello;
    },
    get closed() {
      return session.closed;
    },
    async call(method: string, params: Json, timeoutMs: number): Promise<Json> {
      before?.(method, params);
      const result = await session.call(method, params, timeoutMs);
      return defect(method, structuredClone(result), params) ?? result;
    },
    close() {
      session.close();
    },
  };
  return wrapped as unknown as OtcpSession;
}

/** The real tools over an in-process MCP client, as the built bundle would answer. */
async function fakeMcp(
  env: Readonly<Record<string, string>>,
  contexts: TestContext[],
  defect: ToolDefect | undefined,
): Promise<McpProcess> {
  const dir = env.OPENTUNE_MCP_DISCOVERY_DIR;
  if (dir === undefined) throw new Error('the scenario gave no discovery directory');
  const ctx = testContext(dir);
  contexts.push(ctx);
  const { client, close } = mcpClient(ctx);
  await client.request(1, 'initialize', INITIALIZE);
  client.notify('notifications/initialized');
  let id = 10;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await close();
    ctx.instances.close();
  };
  return {
    pid: process.pid,
    async call(name, args = {}) {
      const response = await client.request(id++, 'tools/call', { name, arguments: args });
      if (response.error !== undefined) throw new Error(`${name}: ${response.error.message}`);
      const result = response.result as { isError?: boolean; structuredContent?: unknown };
      if (!isObject(result.structuredContent)) throw new Error(`${name} returned no structured content`);
      const changed = defect?.(name, result.structuredContent);
      const body = (changed === undefined ? result.structuredContent : changed) as Record<string, unknown>;
      return { isError: result.isError === true, body } satisfies ToolOutcome;
    },
    stop,
    kill: stop,
    stderr: () => '',
  };
}

interface FixtureOptions {
  readonly prepare?: (mock: OtcpMock) => void;
  readonly reply?: SessionDefect;
  readonly before?: BeforeCall;
  readonly clock?: Clock;
  readonly tool?: ToolDefect;
}

/** A hook set whose instance and MCP server are the mock and the in-process tools. */
function fixture(options: FixtureOptions = {}): {
  readonly hooks: WaveBTourHooks;
  readonly mocks: OtcpMock[];
} {
  const mocks: OtcpMock[] = [];
  const contexts: TestContext[] = [];
  const hooks: WaveBTourHooks = {
    async instance(request: RealInstanceOptions): Promise<RealInstance> {
      const mock = await startMock({
        discoveryDir: request.discoveryDir,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
      mocks.push(mock);
      options.prepare?.(mock);
      return {
        pid: Number(mock.discovery.pid),
        instanceId: mock.discovery.instanceId,
        discoveryFile: mock.discoveryPath,
        end: async () => {
          await mock.stop();
          return true;
        },
      };
    },
    ...(options.reply === undefined && options.before === undefined
      ? {}
      : {
          session: (session: OtcpSession) => wrapSession(session, options.reply ?? (() => undefined), options.before),
        }),
    mcp: (env) => fakeMcp(env, contexts, options.tool),
  };
  cleanup.push(async () => {
    for (const ctx of contexts) ctx.instances.close();
    for (const mock of mocks) await mock.stop();
  });
  return { hooks, mocks };
}

const withAudio = (mock: OtcpMock): void => {
  mock.given({ audio: { running: true } });
};

const stepResult = (report: WaveBTourReport, name: string) =>
  report.steps.find((step) => step.name === name || step.name.startsWith(name));

const stepNames = (report: WaveBTourReport) =>
  report.steps.map((step) => `${step.name}=${step.result}${step.result === 'PASS' ? '' : ` (${step.note})`}`);

describe('the wave-B tour against a correct fake', () => {
  it('passes every check, records the latency of every call and leaves the instance as it found it', async () => {
    const { hooks, mocks } = fixture({ prepare: withAudio });
    const report = await runWaveBTour(config, hooks);

    expect(stepNames(report)).toEqual([
      'prepare=PASS',
      'launch=PASS',
      'hello=PASS',
      'ui.getState and ui.dismiss=PASS',
      'import and analysis=PASS',
      'ui.getState and ui.setSelection=PASS',
      'track.set, track.add, track.duplicate and track.delete=PASS',
      'transport.get, transport.setTempo, transport.setLoop and transport.control=PASS',
      'prefs.set=PASS',
      'audio.get and audio.set=PASS',
      'arrangement.edit: move, trim, gain and fade=PASS',
      'arrangement.copy and arrangement.edit op setReference=PASS',
      'content.analyzeReference and content.autoTune in mode reference=PASS',
      'the wave-B MCP tools=PASS',
      'arrangement.edit: split, the merge that takes it back, and delete=PASS',
      'shutdown=PASS',
    ]);
    expect(report).toMatchObject({ scenario: 'wave-b-tour', result: 'PASS', skipped: [] });
    expect(report.counts).toEqual({ PASS: 16, FAIL: 0, SKIP: 0, 'FLAKY-SKIP': 0 });
    expect(report.instance).toMatchObject({ protocol: '1.0', appVersion: '0.0.0-mock' });
    expect(report.capabilities).toContain('reference.v1');

    // The latency of every call of the tour is in the report.
    const methods = new Set(report.calls.map((call) => call.method));
    for (const method of [
      'track.set',
      'track.add',
      'track.duplicate',
      'track.delete',
      'transport.get',
      'transport.setTempo',
      'transport.setLoop',
      'transport.control',
      'ui.getState',
      'ui.dismiss',
      'ui.setSelection',
      'prefs.set',
      'audio.get',
      'audio.set',
      'content.analyzeReference',
      'content.autoTune',
      'arrangement.edit',
      'arrangement.copy',
    ]) {
      expect([...methods], method).toContain(method);
    }
    for (const call of report.calls) {
      expect(Number.isInteger(call.ms) && call.ms >= 0).toBe(true);
    }
    // Every call is fine except the stale revert probe, which must fail with REVISION_CONFLICT
    // before it is sent again with the current revision.
    expect(report.calls.filter((call) => call.outcome === 'error' && call.kind !== 'revert')).toEqual([]);
    const probes = report.calls.filter((call) => call.outcome === 'error');
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) expect(probe.note).toContain('REVISION_CONFLICT');
    expect(report.calls.filter((call) => call.kind === 'revert' && call.outcome === 'ok').length).toBeGreaterThan(0);
    expect(report.tools.map((tool) => tool.tool).sort()).toEqual([
      'opentune_autotune_range',
      'opentune_delete_track',
      'opentune_edit_arrangement',
      'opentune_manage_ui',
      'opentune_set_settings',
      'opentune_set_tracks',
      'opentune_transport',
    ]);
    expect(report.tools.every((tool) => tool.outcome === 'ok')).toBe(true);
    expect(report.facts.preferencesTouched).toBe('tuningHz');
    expect(report.facts.audioSetting).toBeTruthy();
    expect(report.facts.onboardingDismissed).toBeUndefined();
    expect(report.facts.readCalls).toBeGreaterThan(0);
    expect(report.manualChecks).toHaveLength(1);
    expect(report.result).toBe('PASS');
    expect(report.steps.every((step) => Number.isInteger(step.ms) && step.ms >= 0)).toBe(true);

    // The report holds no path, no token and no long hex run.
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/ot-e2e-|wave-b-tone|[A-Za-z]:[\\/]|\/tmp\//);
    expect(text).not.toMatch(/[0-9a-f]{32,}/);

    // The tour put the instance back: its clips are gone and no track is left muted.
    const state = mocks[0]?.snapshot();
    expect(state?.placements).toEqual([]);
    expect(state?.tracks.every((track) => !track.muted)).toBe(true);
  }, 120_000);
});

describe('a defective fake fails the check that notices it', () => {
  it('a changes[].fields.*.after that is not the value read back fails the report consistency check', async () => {
    let seen = 0;
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result) => {
        if (method !== 'track.set') return undefined;
        seen += 1;
        if (seen > 1) return undefined;
        const change = Array.isArray(result.changes) ? result.changes.find(isObject) : undefined;
        const fields = change === undefined ? undefined : change.fields;
        if (isObject(fields) && isObject(fields.muted) && typeof fields.muted.after === 'boolean') {
          fields.muted.after = !fields.muted.after;
        }
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, 'track.set, track.add');
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('a fresh read says');
    // The state could be put back, so the later steps still ran.
    expect(stepResult(report, 'the wave-B MCP tools')?.result).toBe('PASS');
    expect(report.result).toBe('FAIL');
  }, 120_000);

  it('a token that is not the one a fresh read returns fails the token check', async () => {
    let seen = 0;
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result) => {
        if (method !== 'track.set') return undefined;
        seen += 1;
        if (seen > 1 || !isObject(result.tokens)) return undefined;
        if (typeof result.tokens.arrangementRevision === 'string') {
          result.tokens.arrangementRevision = `${result.tokens.arrangementRevision}x`;
        }
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, 'track.set, track.add');
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('tokens.arrangementRevision is not the one a fresh read returns');
  }, 120_000);

  it('a revert recipe that does not restore the state stops the tour and says so', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result) => {
        if (method !== 'transport.setLoop') return undefined;
        const undo = isObject(result.undo) ? result.undo : undefined;
        const revert = undo === undefined ? undefined : undo.revert;
        const transport = isObject(result.transport) ? result.transport : undefined;
        if (isObject(revert) && isObject(revert.params) && transport !== undefined) {
          // The recipe sets the value that was just set, so sending it changes nothing.
          revert.params.enabled = transport.loopEnabled;
        }
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, 'transport.get, transport.setTempo');
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('differs from before the write');
    expect(stepResult(report, 'prefs.set')?.result).toBe('SKIP');
    expect(stepResult(report, 'prefs.set')?.note).toContain('could not put the state back');
    expect(report.counts.FAIL).toBe(1);
  }, 120_000);

  it('a result that fails its method schema fails the step, whatever else is right about it', async () => {
    let seen = 0;
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result) => {
        if (method !== 'transport.setTempo') return undefined;
        seen += 1;
        if (seen > 1) return undefined;
        delete result.tempo;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, 'transport.get, transport.setTempo');
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('not valid against methods/transport.setTempo.schema.json#/$defs/result');
    expect(step?.note).toContain('tempo');
    expect(stepResult(report, 'audio.get and audio.set')?.result).toBe('PASS');
  }, 120_000);

  it('a promised warning that is missing fails the step that promised it', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result) => {
        if (method !== 'transport.setLoop' || !Array.isArray(result.warnings)) return undefined;
        result.warnings = result.warnings.filter(
          (warning) => !isObject(warning) || warning.code !== 'LOOP_NO_EFFECT_STANDALONE',
        );
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, 'transport.get, transport.setTempo');
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('no LOOP_NO_EFFECT_STANDALONE warning');
  }, 120_000);

  it('a tool text that omits that the change cannot be undone fails the tool check', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      tool: (tool, body) => {
        if (tool !== 'opentune_delete_track' || typeof body.summary !== 'string') return undefined;
        return { ...body, summary: body.summary.replace(/cannot be undone or restored by any request/gi, 'was done') };
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, 'the wave-B MCP tools');
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('the first sentence does not say that it cannot be undone');
    expect(report.tools.find((tool) => tool.tool === 'opentune_delete_track')?.outcome).toBe('error');
    // The other tools were still called.
    expect(report.tools.filter((tool) => tool.outcome === 'ok').length).toBeGreaterThanOrEqual(5);
  }, 120_000);

  it('a tool result that is not an object fails the output schema check', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      tool: (tool) => (tool === 'opentune_transport' ? [] : undefined),
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, 'the wave-B MCP tools');
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('does not pass the output schema of opentune_transport');
  }, 120_000);
});

describe('nothing is played unless every visible track is muted', () => {
  const playCalls = (report: WaveBTourReport) =>
    report.calls.filter((call) => call.method === 'transport.control').map((call) => call.method);

  it('sends play when the mute is in place (the guard has something to hold back)', async () => {
    const { hooks } = fixture({ prepare: withAudio });
    const report = await runWaveBTour(config, hooks);
    expect(playCalls(report).length).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('a mute that the instance reports as not applied stops the play, the stop and the seek', async () => {
    const { hooks, mocks } = fixture({
      prepare: withAudio,
      reply: (method, result, params) => {
        const tracks = Array.isArray(params.tracks) ? params.tracks.filter(isObject) : [];
        if (method !== 'track.set' || tracks.length < 2 || !tracks.every((track) => track.muted === true)) {
          return undefined;
        }
        result.applied = false;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, 'transport.get, transport.setTempo');
    expect(step?.result).toBe('FAIL');
    expect(playCalls(report)).toEqual([]);
    // The mute that did take effect was put back.
    expect(mocks[0]?.snapshot().tracks.every((track) => !track.muted)).toBe(true);
  }, 120_000);

  it('an instance without tracks.v1 cannot mute, so nothing is played and the step says why', async () => {
    const { hooks } = fixture({
      prepare: (mock) => {
        mock.given({ audio: { running: true } });
        mock.given({ withoutCapabilities: ['tracks.v1'] });
      },
    });
    const report = await runWaveBTour(config, hooks);
    expect(playCalls(report)).toEqual([]);
    expect(report.skipped.join(' ')).toContain('needs tracks.v1');
  }, 120_000);
});

describe('the checks behind the findings of the real runs turn red on a defective fake', () => {
  it('an out-of-range gain that is applied unchanged, without CLAMPED, fails the arrangement step', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result, params) => {
        const ops = Array.isArray(params.ops) ? params.ops.filter(isObject) : [];
        if (method !== 'arrangement.edit' || !ops.some((op) => op.op === 'setGain')) return undefined;
        result.warnings = Array.isArray(result.warnings)
          ? result.warnings.filter((warning) => !isObject(warning) || warning.code !== 'CLAMPED')
          : [];
        for (const change of Array.isArray(result.changes) ? result.changes.filter(isObject) : []) {
          const fields = isObject(change.fields) ? change.fields : {};
          if (isObject(fields.gainDb)) fields.gainDb.after = 200;
        }
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, 'arrangement.edit: move, trim, gain and fade');
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('no CLAMPED warning');
  }, 120_000);

  it('an out-of-range gain that keeps its CLAMPED warning but reports the unchanged value fails the step', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result, params) => {
        const ops = Array.isArray(params.ops) ? params.ops.filter(isObject) : [];
        if (method !== 'arrangement.edit' || !ops.some((op) => op.op === 'setGain')) return undefined;
        for (const change of Array.isArray(result.changes) ? result.changes.filter(isObject) : []) {
          const fields = isObject(change.fields) ? change.fields : {};
          if (isObject(fields.gainDb)) fields.gainDb.after = 200;
        }
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, 'arrangement.edit: move, trim, gain and fade');
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('applied unchanged');
  }, 120_000);

  it('a reference analysis job that ends without alignment data fails the analysis step', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result) => {
        if (method !== 'job.get' || !isObject(result.job) || !isObject(result.job.result)) return undefined;
        if (!('alignmentReady' in result.job.result)) return undefined;
        result.job.result.alignmentReady = false;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, 'content.analyzeReference and content.autoTune');
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('alignment');
  }, 120_000);

  it('a reference analysis job that names another binding fails the analysis step', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result) => {
        if (method !== 'job.get' || !isObject(result.job) || !isObject(result.job.result)) return undefined;
        if (!('alignmentReady' in result.job.result)) return undefined;
        result.job.result.referencePlacementId = 'p:0:0:0';
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, 'content.analyzeReference and content.autoTune');
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('another binding');
  }, 120_000);
});

describe('a revert recipe refused for its token', () => {
  it('is a defect only while the arrangement still has the revision the recipe names', () => {
    expect(refusalIsDefect('a1', 'a1')).toBe(true);
    expect(refusalIsDefect('a2', 'a1')).toBe(false);
    expect(refusalIsDefect('a2', undefined)).toBe(false);
  });
});

describe('the reference analysis of the locked OpenTune', () => {
  const STEP = 'content.analyzeReference and content.autoTune';
  const TOOLS_STEP = 'the wave-B MCP tools';
  const DEFECT_NOTE = 'known upstream defect';

  /** Shortens the 30 s wait limit of the mock's reference job, so that a timeout does not make the test slow. */
  const quick: Clock = {
    now: () => realClock.now(),
    // Only the wait limit of the reference job is shortened; every other timer (the idle timeout of the
    // mock, for one) keeps its length.
    setTimer: (ms, callback) =>
      realClock.setTimer(
        ms >= MOCK_REFERENCE_WAIT_LIMIT_MS - 1_000 && ms <= MOCK_REFERENCE_WAIT_LIMIT_MS ? 50 : ms,
        callback,
      ),
  };

  type Where = 'analysis' | 'step' | 'tool' | 'both';

  /**
   * The first analysis completes, as it does in OpenTune; later the alignment data has to be computed
   * again and the mock's analysis ends as `fault` says. `where` picks the autoTune of the OTCP step
   * (the fault ends with the history read that follows it, so the steps after it run as usual), the
   * one of the MCP tool `opentune_autotune_range` (armed at the second history read, which is the one
   * before that tool), or both (the fault stays). `analysis` arms it at content.analyzeReference, so that
   * the analysis job and the autoTune that follows it both meet the fault.
   */
  const faultAt = (
    fault: 'stalled' | 'timeout' | 'failed',
    where: Where,
    options: { clock?: Clock; undoGrows?: boolean } = {},
  ) => {
    let mock: OtcpMock | undefined;
    let armed = false;
    let tuned = false;
    let histories = 0;
    let replies = 0;
    const arm = () => {
      armed = true;
      mock?.setReferenceFault(fault);
      mock?.forgetAlignment();
    };
    return fixture({
      prepare: (m) => {
        withAudio(m);
        mock = m;
      },
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      before: (method, params) => {
        if (method === 'content.analyzeReference' && where === 'analysis') arm();
        else if (method === 'content.autoTune' && params.mode === 'reference' && where !== 'tool') {
          if (where === 'analysis') tuned = true;
          else arm();
        } else if (method === 'edit.getHistory') {
          histories += 1;
          if (where === 'tool' && histories === 2) arm();
          else if ((where === 'step' && armed) || (where === 'analysis' && tuned)) {
            armed = false;
            mock?.setReferenceFault(null);
          }
        }
      },
      // The third history read is the one that follows the tool's job: one more undo step there is a change.
      reply: (method, result) => {
        if (method !== 'edit.getHistory' || options.undoGrows !== true) return undefined;
        replies += 1;
        if (replies !== 3 || !isObject(result.history)) return undefined;
        result.history.undoCount = Number(result.history.undoCount) + 1;
        return result;
      },
    });
  };

  const tool = (report: WaveBTourReport) => report.tools.find((entry) => entry.tool === 'opentune_autotune_range');

  it('passes a stalled autoTune that ended at once and changed nothing, and lists the defect', async () => {
    const { hooks } = faultAt('stalled', 'step');
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('PASS');
    expect(step?.note).toContain(DEFECT_NOTE);
    expect(step?.note).toContain('reported as NOT_READY(reference_analysis_stalled); nothing changed');
    expect(report.facts.knownUpstreamDefects).toEqual(['reference_analysis_stalled']);
    expect(tool(report)?.note).not.toContain(DEFECT_NOTE);
    expect(stepNames(report).filter((entry) => !entry.includes('=PASS'))).toEqual([]);
    expect(report.result).toBe('PASS');
  }, 120_000);

  it('passes a stalled analysis that ended at once and changed nothing, and lists the defect', async () => {
    const { hooks } = faultAt('stalled', 'analysis');
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('PASS');
    expect(step?.note).toContain(DEFECT_NOTE);
    expect(step?.note).toContain('by content.analyzeReference and by content.autoTune');
    expect(report.facts.knownUpstreamDefects).toEqual(['reference_analysis_stalled']);
    expect(
      report.calls.some((call) => call.method === 'job.get' && call.note.includes('reference_analysis_stalled')),
    ).toBe(true);
    expect(stepNames(report).filter((entry) => !entry.includes('=PASS'))).toEqual([]);
  }, 120_000);

  it.each(['timeout', 'failed'] as const)(
    'fails an analysis that ended with the %s reason, which is not the known defect',
    async (fault) => {
      const { hooks } = faultAt(fault, 'analysis', { clock: quick });
      const report = await runWaveBTour(config, hooks);
      const step = stepResult(report, STEP);
      expect(step?.result).toBe('FAIL');
      expect(step?.note).toContain(`reference_analysis_${fault}`);
      expect(report.facts.knownUpstreamDefects).toBeUndefined();
    },
    120_000,
  );

  it('fails an autoTune that ended with reference_analysis_timeout', async () => {
    const { hooks } = faultAt('timeout', 'step', { clock: quick });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('reference_analysis_timeout');
    expect(report.facts.knownUpstreamDefects).toBeUndefined();
  }, 120_000);

  it('fails an autoTune that ended with reference_analysis_failed', async () => {
    const { hooks } = faultAt('failed', 'step');
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('reference_analysis_failed');
    expect(report.facts.knownUpstreamDefects).toBeUndefined();
  }, 120_000);

  it('passes opentune_autotune_range when its job ended with the stalled error and changed nothing', async () => {
    const { hooks } = faultAt('stalled', 'tool');
    const report = await runWaveBTour(config, hooks);
    expect(stepResult(report, STEP)?.note).not.toContain(DEFECT_NOTE);
    expect(stepResult(report, TOOLS_STEP)?.result).toBe('PASS');
    expect(tool(report)).toMatchObject({ outcome: 'ok' });
    expect(tool(report)?.note).toContain(DEFECT_NOTE);
    expect(tool(report)?.note).toContain('NOT_READY(reference_analysis_stalled); nothing changed');
    expect(report.facts.knownUpstreamDefects).toEqual(['reference_analysis_stalled']);
    expect(report.tools.every((entry) => entry.outcome === 'ok')).toBe(true);
    expect(report.result).toBe('PASS');
  }, 120_000);

  it('lists the defect once when both the OTCP step and the tool met it', async () => {
    const { hooks } = faultAt('stalled', 'both');
    const report = await runWaveBTour(config, hooks);
    expect(stepResult(report, STEP)?.note).toContain(DEFECT_NOTE);
    expect(tool(report)?.note).toContain(DEFECT_NOTE);
    expect(report.facts.knownUpstreamDefects).toEqual(['reference_analysis_stalled']);
    expect(stepNames(report).filter((entry) => !entry.includes('=PASS'))).toEqual([]);
  }, 120_000);

  it('fails opentune_autotune_range when the stalled job left an undo step behind', async () => {
    const { hooks } = faultAt('stalled', 'tool', { undoGrows: true });
    const report = await runWaveBTour(config, hooks);
    expect(stepResult(report, TOOLS_STEP)?.result).toBe('FAIL');
    expect(tool(report)).toMatchObject({ outcome: 'error' });
    expect(tool(report)?.note).toContain('the undo stack went from');
    expect(report.facts.knownUpstreamDefects).toBeUndefined();
  }, 120_000);

  it.each(['timeout', 'failed'] as const)(
    'fails opentune_autotune_range when its job ended with the %s reason',
    async (fault) => {
      const { hooks } = faultAt(fault, 'tool', { clock: quick });
      const report = await runWaveBTour(config, hooks);
      expect(stepResult(report, TOOLS_STEP)?.result).toBe('FAIL');
      expect(tool(report)).toMatchObject({ outcome: 'error' });
      expect(tool(report)?.note).toContain(`reference_analysis_${fault}`);
      expect(report.facts.knownUpstreamDefects).toBeUndefined();
    },
    120_000,
  );

  it('counts only NOT_READY(reference_analysis_stalled) that came before the wait limit', () => {
    const stalled = {
      kind: 'NOT_READY',
      reason: 'reference_analysis_stalled',
      retryable: false,
      detail: 'x',
      executed: false,
    };
    expect(isKnownStalledDefect(stalled, 120)).toBe(true);
    expect(isKnownStalledDefect(stalled, REFERENCE_WAIT_LIMIT_MS)).toBe(false);
    expect(isKnownStalledDefect({ ...stalled, reason: 'reference_analysis_timeout' }, 120)).toBe(false);
    expect(isKnownStalledDefect({ ...stalled, kind: 'ANALYSIS_FAILED' }, 120)).toBe(false);
    expect(isKnownStalledDefect(undefined, 120)).toBe(false);
  });

  it('uses the wait limit of the mock as the limit before which the stalled error must come', () => {
    expect(REFERENCE_WAIT_LIMIT_MS).toBe(MOCK_REFERENCE_WAIT_LIMIT_MS);
  });
});

describe('the audio step of the tour', () => {
  const STEP = 'audio.get and audio.set';

  /** audio.get offers nothing but the current values of the listed lists. */
  const offerOnlyCurrent =
    (...lists: readonly ('bufferSizesFrame' | 'sampleRatesHz' | 'outputDevices' | 'deviceTypes')[]): SessionDefect =>
    (method, result) => {
      if (method !== 'audio.get' || !isObject(result.device) || !isObject(result.available)) return undefined;
      const current: Record<string, unknown> = {
        bufferSizesFrame: result.device.bufferSizeFrame,
        sampleRatesHz: result.device.sampleRateHz,
        outputDevices: result.device.outputDevice,
        deviceTypes: result.device.deviceType,
      };
      for (const list of lists) result.available[list] = [current[list]];
      return result;
    };

  it('changes a buffer size of the current device first and compares the whole setup after the revert', async () => {
    const { hooks } = fixture({ prepare: withAudio });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('PASS');
    expect(report.facts.audioSetting).toBe('bufferSizeFrame');
    expect(report.facts.audioSwitched).toBe('another buffer size or sample rate');
    expect(step?.note).toContain('the setup read back equals the one at the start (6 members compared)');
  }, 120_000);

  it('switches to another output device when the device offers no other buffer size or sample rate', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: offerOnlyCurrent('bufferSizesFrame', 'sampleRatesHz'),
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('PASS');
    expect(report.facts.audioSetting).toBe('outputDevice');
    expect(report.facts.audioSwitched).toBe('another device');
    expect(step?.note).toContain('outputDevice "Mock Output" -> "Mock Output 2" and back');
  }, 120_000);

  it('skips with its reason when audio.get offers nothing but the current setup', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: offerOnlyCurrent('bufferSizesFrame', 'sampleRatesHz', 'outputDevices', 'deviceTypes'),
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('SKIP');
    expect(step?.note).toContain('nothing to switch');
    expect(report.facts.audioSetting).toBeUndefined();
  }, 120_000);

  it('fails, and names the setup of the start, when the setup cannot be put back', async () => {
    let writes = 0;
    let mock: OtcpMock | undefined;
    const { hooks } = fixture({
      prepare: (m) => {
        withAudio(m);
        mock = m;
      },
      before: (method) => {
        if (method !== 'audio.set') return;
        writes += 1;
        // The switch works; the device then refuses to open again, for the revert and for the retry.
        if (writes === 2) mock?.given({ audio: { running: true, failsToOpen: true } });
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('the setup at the start was');
    expect(step?.note).toContain('"bufferSizeFrame":512');
    expect(step?.note).toContain('set it back by hand');
  }, 120_000);

  it('picks buffer size, sample rate, output device, device type in that order', () => {
    const device = {
      bufferSizeFrame: 256,
      sampleRateHz: 48000,
      outputDevice: 'A',
      deviceType: 'T',
    };
    const offer = (extra: Json = {}): Json => ({
      bufferSizesFrame: [256],
      sampleRatesHz: [48000],
      outputDevices: ['A'],
      deviceTypes: ['T'],
      ...extra,
    });
    expect(chooseAudioSwitch(device, offer())).toBeNull();
    expect(chooseAudioSwitch(device, offer({ deviceTypes: ['T', 'U'] }))).toEqual({ field: 'deviceType', value: 'U' });
    expect(chooseAudioSwitch(device, offer({ outputDevices: ['A', 'B'], deviceTypes: ['T', 'U'] }))).toEqual({
      field: 'outputDevice',
      value: 'B',
    });
    expect(chooseAudioSwitch(device, offer({ sampleRatesHz: [48000, 44100], outputDevices: ['A', 'B'] }))).toEqual({
      field: 'sampleRateHz',
      value: 44100,
    });
    expect(chooseAudioSwitch(device, offer({ bufferSizesFrame: [256, 512], sampleRatesHz: [44100] }))).toEqual({
      field: 'bufferSizeFrame',
      value: 512,
    });
  });
});
