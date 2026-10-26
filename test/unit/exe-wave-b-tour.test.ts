// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The wave-B tour (test/e2e/wave-b-tour.ts) against the test mock in place of an executable: every
// check passes on a correct fake, and a fake whose answer carries one defect fails exactly the check
// that notices it (a wrong `after` value, a token that is not the one a fresh read returns, a revert
// recipe that does not restore the state, a result that fails its method schema, a missing promised
// warning, and a tool text that does not say that the change cannot be undone). The MCP part runs the
// real tools in process over the same mock, so the tour's tool checks are exercised end to end.

import { afterEach, describe, expect, it } from 'vitest';

import type { Clock } from '../../mock/clock.js';
import { startMock, type OtcpMock } from '../../mock/server.js';
import { OtcpSession, type Json } from '../../src/otcp/client.js';
import type { McpProcess, RealInstance, RealInstanceOptions, ToolOutcome } from '../e2e/real-support.js';
import type { SmokeConfig } from '../e2e/smoke.js';
import {
  chooseAudioSwitch,
  isSafeDeviceType,
  otherOf,
  otherWeight,
  refusalIsDefect,
  runWaveBTour,
  unofferedWeight,
  VOCODER_LOAD_SHIFT_CENTS,
  type WaveBTourHooks,
  type WaveBTourReport,
} from '../e2e/wave-b-tour.js';
import { INITIALIZE, mcpClient, testContext, type TestContext } from '../support/context.js';
import { wrapSession, type BeforeCall, type SessionDefect } from '../support/wrap-session.js';

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

/** Changes one MCP tool result before the tour sees it. */
type ToolDefect = (tool: string, body: Json) => unknown;

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
  /** How long the transport plays before the tour pauses it (default: not at all, a mock does not wait for audio). */
  readonly playMs?: number;
  /** How long the first step waits for the first-run overlay (default: not at all). */
  readonly onboardingWaitMs?: number;
  /** How long the preference step waits for a vocoder that is not ready (default: the step's own 30 s). */
  readonly vocoderSettleMs?: number;
  /** How long the preference step waits for the vocoder to load after the edit that makes OpenTune load it (default: 60 s). */
  readonly vocoderLoadMs?: number;
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
    playMs: options.playMs ?? 0,
    onboardingWaitMs: options.onboardingWaitMs ?? 0,
    ...(options.vocoderSettleMs === undefined ? {} : { vocoderSettleMs: options.vocoderSettleMs }),
    ...(options.vocoderLoadMs === undefined ? {} : { vocoderLoadMs: options.vocoderLoadMs }),
  };
  cleanup.push(async () => {
    for (const ctx of contexts) ctx.instances.close();
    for (const mock of mocks) await mock.stop();
  });
  return { hooks, mocks };
}

const withAudio = (mock: OtcpMock): void => {
  mock.given({ audio: { running: true } });
  // OpenTune's Standalone offers the output channel pair 0 only, and so does the mock by default; a second pair lets
  // the tour switch it too.
  mock.setOutputChannelPairCount(2);
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
      'ui.setWorkspace=PASS',
      'track.set, track.add, track.duplicate and track.delete=PASS',
      'transport.get, transport.setTempo, transport.setLoop and transport.control=PASS',
      'prefs.set=PASS',
      'audio.get and audio.set=PASS',
      'arrangement.edit: move, trim, gain and fade=PASS',
      'arrangement.copy=PASS',
      'the wave-B MCP tools=PASS',
      'arrangement.edit: split, the merge that takes it back, and delete=PASS',
      'shutdown=PASS',
    ]);
    expect(report).toMatchObject({ scenario: 'wave-b-tour', result: 'PASS', skipped: [] });
    expect(report.counts).toEqual({ PASS: 16, FAIL: 0, SKIP: 0, 'FLAKY-SKIP': 0 });
    expect(report.instance).toMatchObject({ protocol: '1.0', appVersion: '0.0.0-mock' });
    expect(report.capabilities).not.toContain('reference.v1');

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
      'ui.setWorkspace',
      'prefs.set',
      'audio.get',
      'audio.set',
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
    // The one write that must fail is the vocoder weight that is not among the options.
    const refusals = report.calls.filter((call) => call.outcome === 'error' && call.kind === 'write');
    expect(refusals.map((call) => [call.method, call.note.includes('option_unavailable')])).toEqual([
      ['prefs.set', true],
    ]);
    expect(report.calls.filter((call) => call.outcome === 'error' && !['revert', 'write'].includes(call.kind))).toEqual(
      [],
    );
    const probes = report.calls.filter((call) => call.outcome === 'error' && call.kind !== 'write');
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) expect(probe.note).toContain('REVISION_CONFLICT');
    expect(report.calls.filter((call) => call.kind === 'revert' && call.outcome === 'ok').length).toBeGreaterThan(0);
    expect(report.tools.map((tool) => tool.tool).sort()).toEqual([
      'opentune_delete_track',
      'opentune_edit_arrangement',
      'opentune_manage_ui',
      'opentune_manage_ui',
      'opentune_set_settings',
      'opentune_set_tracks',
      'opentune_transport',
    ]);
    expect(report.tools.every((tool) => tool.outcome === 'ok')).toBe(true);
    expect(report.facts.preferencesTouched).toEqual(['tuningHz', 'renderingPriority', 'vocoderWeight']);
    for (const name of ['renderingPriority', 'f0Model', 'vocoderWeight', 'vocoderWeightRefused']) {
      expect(report.facts[`prefs.${name}`], name).toBe('PASS');
    }
    expect(report.facts.audioSwitched).toEqual([
      'bufferSizeFrame',
      'sampleRateHz',
      'outputChannelPair',
      'outputDevice',
      'deviceType',
    ]);
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
});

describe('a revert recipe refused for its token', () => {
  it('is a defect only while the arrangement still has the revision the recipe names', () => {
    expect(refusalIsDefect('a1', 'a1')).toBe(true);
    expect(refusalIsDefect('a2', 'a1')).toBe(false);
    expect(refusalIsDefect('a2', undefined)).toBe(false);
  });
});

type AudioList = 'bufferSizesFrame' | 'sampleRatesHz' | 'outputDevices' | 'deviceTypes' | 'outputChannelPairCount';

/** audio.get offers nothing but the current values of the listed lists (one output channel pair is the current one). */
const offerOnlyCurrent =
  (...lists: readonly AudioList[]): SessionDefect =>
  (method, result) => {
    if (method !== 'audio.get' || !isObject(result.device) || !isObject(result.available)) return undefined;
    const current: Record<string, unknown> = {
      bufferSizesFrame: result.device.bufferSizeFrame,
      sampleRatesHz: result.device.sampleRateHz,
      outputDevices: result.device.outputDevice,
      deviceTypes: result.device.deviceType,
    };
    for (const list of lists) {
      result.available[list] = list === 'outputChannelPairCount' ? 1 : [current[list]];
    }
    return result;
  };

/** The values of the audio setup the mock starts with (sample rate, buffer size, pair and names). */
const START_SETUP = {
  deviceType: 'Mock Audio',
  outputDevice: 'Mock Output',
  sampleRateHz: 44100,
  bufferSizeFrame: 512,
  outputChannelPair: 0,
};

describe('the audio step of the tour', () => {
  const STEP = 'audio.get and audio.set';

  /** Records the parameters of every audio.set the tour sends, and lets `each` look at the call (1, 2, ...) first. */
  const recording = (each?: (n: number, mock: OtcpMock | undefined) => void) => {
    const sent: Json[] = [];
    let mock: OtcpMock | undefined;
    const options = {
      prepare: (m: OtcpMock) => {
        withAudio(m);
        mock = m;
      },
      before: (method: string, params: Json) => {
        if (method !== 'audio.set') return;
        sent.push(structuredClone(params));
        each?.(sent.length, mock);
      },
    };
    return { sent, options };
  };

  it('switches every field the device offers, the device type last, and compares the whole setup after each', async () => {
    const { sent, options } = recording();
    const { hooks } = fixture(options);
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('PASS');
    // Every switch is followed by the revert recipe of its result, which names the members it changed: only the one
    // asked for, except for the device type, which also opened the other type's default output device.
    expect(sent).toEqual([
      { bufferSizeFrame: 256 },
      { bufferSizeFrame: 512 },
      { sampleRateHz: 48000 },
      { sampleRateHz: 44100 },
      { outputChannelPair: 1 },
      { outputChannelPair: 0 },
      { outputDevice: 'Mock Output 2' },
      { outputDevice: 'Mock Output' },
      { deviceType: 'Mock Audio 2' },
      { deviceType: 'Mock Audio', outputDevice: 'Mock Output' },
    ]);
    for (const field of ['bufferSizeFrame', 'sampleRateHz', 'outputChannelPair', 'outputDevice', 'deviceType']) {
      expect(report.facts[`audio.${field}`], field).toBe('PASS');
    }
    expect(report.facts.audioSwitched).toEqual([
      'bufferSizeFrame',
      'sampleRateHz',
      'outputChannelPair',
      'outputDevice',
      'deviceType',
    ]);
    expect(step?.note).toContain('bufferSizeFrame 512 -> 256 and back');
    expect(step?.note).toContain('deviceType "Mock Audio" -> "Mock Audio 2" and back');
    expect(step?.note).toContain('the setup read back equals the one at the start (6 members compared)');
  }, 120_000);

  it('tries what the first device type does not offer in the other type, then takes the type switch back', async () => {
    const { sent, options } = recording();
    // The first type offers one buffer size and one sample rate (as the shared mode of Windows Audio does).
    const { hooks } = fixture({
      ...options,
      reply: (method, result, params) =>
        isObject(result.device) && result.device.deviceType === 'Mock Audio'
          ? offerOnlyCurrent('bufferSizesFrame', 'sampleRatesHz')(method, result, params)
          : undefined,
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('PASS');
    expect(sent).toEqual([
      { outputChannelPair: 1 },
      { outputChannelPair: 0 },
      { outputDevice: 'Mock Output 2' },
      { outputDevice: 'Mock Output' },
      { deviceType: 'Mock Audio 2' },
      { bufferSizeFrame: 256 },
      { bufferSizeFrame: 512 },
      { sampleRateHz: 48000 },
      { sampleRateHz: 44100 },
      { deviceType: 'Mock Audio', outputDevice: 'Mock Output' },
    ]);
    expect(report.facts['audio.bufferSizeFrame']).toBe('PASS');
    expect(report.facts['audio.sampleRateHz']).toBe('PASS');
    expect(step?.note).toContain('bufferSizeFrame 512 -> 256 in "Mock Audio 2" and back');
    expect(step?.note).toContain('sampleRateHz 44100 -> 48000 in "Mock Audio 2" and back');
  }, 120_000);

  it('skips a field the device offers no other value of, with the reason, and switches the others', async () => {
    const { sent, options } = recording();
    const { hooks } = fixture({
      ...options,
      reply: offerOnlyCurrent('bufferSizesFrame', 'outputChannelPairCount'),
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('PASS');
    expect(report.facts['audio.bufferSizeFrame']).toBe('SKIP: audio.get offers no other bufferSizeFrame than 512');
    expect(report.facts['audio.outputChannelPair']).toBe('SKIP: audio.get offers no other output channel pair than 0');
    expect(report.facts['audio.sampleRateHz']).toBe('PASS');
    expect(sent.some((params) => 'bufferSizeFrame' in params || 'outputChannelPair' in params)).toBe(false);
    expect(step?.note).toContain('skipped: bufferSizeFrame (audio.get offers no other bufferSizeFrame than 512)');
  }, 120_000);

  it('never switches to ASIO or an exclusive mode, whatever audio.get lists', async () => {
    const { sent, options } = recording();
    const { hooks } = fixture({
      ...options,
      reply: (method, result) => {
        if (method !== 'audio.get' || !isObject(result.available) || !isObject(result.device)) return undefined;
        result.available.deviceTypes = [result.device.deviceType, 'ASIO', 'Windows Audio (Exclusive Mode)'];
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    expect(stepResult(report, STEP)?.result).toBe('PASS');
    expect(String(report.facts['audio.deviceType'])).toMatch(/^SKIP: .*safe to switch to \(ASIO and exclusive modes/);
    expect(sent.some((params) => 'deviceType' in params)).toBe(false);
  }, 120_000);

  it('skips with its reason when audio.get offers nothing but the current setup', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: offerOnlyCurrent(
        'bufferSizesFrame',
        'sampleRatesHz',
        'outputDevices',
        'deviceTypes',
        'outputChannelPairCount',
      ),
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('SKIP');
    expect(step?.note).toContain('nothing to switch');
    for (const field of ['bufferSizeFrame', 'sampleRateHz', 'outputChannelPair', 'outputDevice', 'deviceType']) {
      expect(String(report.facts[`audio.${field}`]), field).toMatch(/^SKIP: audio.get offers no other/);
    }
    expect(report.facts.audioSwitched).toEqual([]);
  }, 120_000);

  /** The switch works; the revert (the second audio.set) fails to open; the retry is the third. */
  const failingRevert = (retryWorks: boolean) =>
    recording((n, mock) => {
      if (n === 2) mock?.given({ audio: { running: true, failsToOpen: true } });
      if (n === 3 && retryWorks) mock?.given({ audio: { running: true, failsToOpen: false } });
    });

  it('sends the values of the start once more when the revert fails, and fails when that fails too', async () => {
    const { sent, options } = failingRevert(false);
    const { hooks } = fixture(options);
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('the setup at the start was');
    expect(step?.note).toContain('"bufferSizeFrame":512');
    expect(step?.note).toContain('set it back by hand');
    expect(step?.note).toContain('could not be set back with the start values either');
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual(START_SETUP);
  }, 120_000);

  it('fails too when the retry with the values of the start works, and says so', async () => {
    const { sent, options } = failingRevert(true);
    const { hooks } = fixture(options);
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('it was then set back with the start values');
    expect(step?.note).not.toContain('either');
    expect(step?.note).toContain('the setup at the start was');
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual(START_SETUP);
  }, 120_000);

  it('sends the values of the start once more when something other than the revert goes wrong, and fails', async () => {
    let writes = 0;
    let thrown = false;
    const sent: Json[] = [];
    const { hooks } = fixture({
      prepare: withAudio,
      before: (method, params) => {
        if (method === 'audio.set') {
          writes += 1;
          sent.push(structuredClone(params));
        } else if (method === 'audio.get' && writes === 2 && !thrown) {
          // The read that compares the setup after the first revert fails: not an Unrestored, a plain error.
          thrown = true;
          throw new Error('the read after the revert failed');
        }
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('the read after the revert failed');
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual(START_SETUP);
    // The setup was set back, so the tour goes on with the steps after this one.
    expect(stepResult(report, 'arrangement.edit: move, trim, gain and fade')?.result).toBe('PASS');
  }, 120_000);

  it('names the start values when they cannot be sent back after another error either', async () => {
    let writes = 0;
    const sent: Json[] = [];
    const { hooks } = fixture({
      prepare: withAudio,
      before: (method, params) => {
        if (method === 'audio.set') {
          writes += 1;
          sent.push(structuredClone(params));
        } else if (method === 'audio.get' && (writes === 2 || writes === 3)) {
          // The read after the revert fails, and so does the read that checks the start values sent back.
          throw new Error(`the read after audio.set number ${String(writes)} failed`);
        }
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('the read after audio.set number 2 failed');
    expect(step?.note).toContain('the start values could not be sent back either');
    expect(step?.note).toContain('the setup at the start was');
    // The setup could not be checked after it was put back, so nothing runs after it.
    expect(stepResult(report, 'arrangement.edit: move, trim, gain and fade')?.result).toBe('SKIP');
  }, 120_000);

  it('fails and sends the start values when the revert of the device type switch fails', async () => {
    // Eight sends for the four fields, the ninth switches the type, the tenth is its revert, the eleventh the retry.
    const { sent, options } = recording((n, mock) => {
      if (n === 10) mock?.given({ audio: { running: true, failsToOpen: true } });
      if (n === 11) mock?.given({ audio: { running: true, failsToOpen: false } });
    });
    const { hooks } = fixture(options);
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('device_open_failed');
    expect(sent).toHaveLength(11);
    expect(sent[8]).toEqual({ deviceType: 'Mock Audio 2' });
    expect(sent[10]).toEqual(START_SETUP);
  }, 120_000);

  it('fails the device type when the switch itself is refused, and has nothing to put back', async () => {
    const { sent, options } = recording((n, mock) => {
      if (n === 9) mock?.given({ audio: { running: true, failsToOpen: true } });
    });
    const { hooks } = fixture(options);
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('device_open_failed');
    expect(report.facts['audio.deviceType']).toBe('FAIL');
    expect(report.facts['audio.bufferSizeFrame']).toBe('PASS');
    expect(sent).toHaveLength(9);
  }, 120_000);

  it('picks another sample rate, buffer size, output device, channel pair or safe device type', () => {
    const device = {
      bufferSizeFrame: 256,
      sampleRateHz: 48000,
      outputDevice: 'A',
      deviceType: 'T',
      outputChannelPair: 0,
    };
    const offer = (extra: Json = {}): Json => ({
      bufferSizesFrame: [256],
      sampleRatesHz: [48000],
      outputDevices: ['A'],
      deviceTypes: ['T'],
      outputChannelPairCount: 1,
      ...extra,
    });
    for (const field of [
      'bufferSizeFrame',
      'sampleRateHz',
      'outputDevice',
      'deviceType',
      'outputChannelPair',
    ] as const) {
      expect(chooseAudioSwitch(field, device, offer()), field).toBeNull();
    }
    expect(chooseAudioSwitch('bufferSizeFrame', device, offer({ bufferSizesFrame: [256, 512] }))).toEqual({
      field: 'bufferSizeFrame',
      value: 512,
    });
    expect(chooseAudioSwitch('sampleRateHz', device, offer({ sampleRatesHz: [48000, 44100] }))).toEqual({
      field: 'sampleRateHz',
      value: 44100,
    });
    expect(chooseAudioSwitch('outputDevice', device, offer({ outputDevices: ['A', 'B'] }))).toEqual({
      field: 'outputDevice',
      value: 'B',
    });
    expect(chooseAudioSwitch('outputChannelPair', device, offer({ outputChannelPairCount: 3 }))).toEqual({
      field: 'outputChannelPair',
      value: 1,
    });
    expect(
      chooseAudioSwitch('outputChannelPair', { ...device, outputChannelPair: 1 }, offer({ outputChannelPairCount: 2 })),
    ).toEqual({
      field: 'outputChannelPair',
      value: 0,
    });
    // DirectSound first; ASIO and the exclusive modes never.
    expect(
      chooseAudioSwitch(
        'deviceType',
        device,
        offer({ deviceTypes: ['T', 'ASIO', 'Windows Audio (Exclusive Mode)', 'Windows Audio', 'DirectSound'] }),
      ),
    ).toEqual({ field: 'deviceType', value: 'DirectSound' });
    expect(
      chooseAudioSwitch(
        'deviceType',
        device,
        offer({ deviceTypes: ['T', 'ASIO', 'Windows Audio (Exclusive Mode)', 'Windows Audio'] }),
      ),
    ).toEqual({ field: 'deviceType', value: 'Windows Audio' });
    expect(
      chooseAudioSwitch('deviceType', device, offer({ deviceTypes: ['T', 'ASIO', 'WASAPI Exclusive'] })),
    ).toBeNull();
    expect(isSafeDeviceType('ASIO')).toBe(false);
    expect(isSafeDeviceType('Windows Audio (Exclusive Mode)')).toBe(false);
    expect(isSafeDeviceType('DirectSound')).toBe(true);
    expect(isSafeDeviceType('Windows Audio (Low Latency Mode)')).toBe(true);
  });
});

describe('the transport step of the tour', () => {
  const STEP = 'transport.get, transport.setTempo';
  /** Timeline seconds per second while the mock plays: fast, so that a short wait moves the position a lot. */
  const RATE = 20;
  const moving = (mock: OtcpMock): void => {
    withAudio(mock);
    mock.setTransportRate(RATE);
  };

  /** The actions of every transport.control call, and the last one (for a defect that starts after an action). */
  const tracking = () => {
    const actions: string[] = [];
    return {
      actions,
      before: (method: string, params: Json): void => {
        if (method === 'transport.control') actions.push(String(params.action));
      },
      last: () => actions[actions.length - 1],
    };
  };

  it('pauses, plays from the last start, pauses at it, and plays from the last start after a seek', async () => {
    const { actions, before } = tracking();
    const { hooks } = fixture({ prepare: moving, playMs: 100, before });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result, step?.note).toBe('PASS');
    expect(actions).toEqual([
      'seek',
      'play',
      'pause',
      'playFromLastStart',
      'pauseAtLastStart',
      'seek',
      'playFromLastStart',
      'stop',
      'seek',
    ]);
    expect(report.facts.transportPositionAdvances).toBe('yes');
    expect(step?.note).toContain('pause, playFromLastStart (also after a seek) and pauseAtLastStart');
    expect(report.result).toBe('PASS');
  }, 120_000);

  it('passes where the position does not move, and says so', async () => {
    const { actions, before } = tracking();
    const { hooks } = fixture({ prepare: withAudio, before });
    const report = await runWaveBTour(config, hooks);
    expect(stepResult(report, STEP)?.result).toBe('PASS');
    expect(actions).toContain('pauseAtLastStart');
    expect(report.facts.transportPositionAdvances).toBe('no (the position did not move while playing)');
  }, 120_000);

  it('passes without an audio device, expecting the NO_AUDIO_DEVICE warning on every play', async () => {
    const { hooks } = fixture();
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('PASS');
    expect(step?.note).toContain('(no audio device)');
    expect(report.facts.transportPositionAdvances).toBe('no audio device');
  }, 120_000);

  it('fails a play from the last start that does not carry the NO_AUDIO_DEVICE warning without a device', async () => {
    const { hooks } = fixture({
      reply: (method, result, params) => {
        if (method !== 'transport.control' || params.action !== 'playFromLastStart') return undefined;
        result.warnings = [];
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('no NO_AUDIO_DEVICE warning');
  }, 120_000);

  it('fails a pause that goes back to where playing began although the position had moved on', async () => {
    const t = tracking();
    const { hooks } = fixture({
      prepare: moving,
      playMs: 100,
      before: t.before,
      reply: (method, result) => {
        if (method !== 'transport.get' || t.last() !== 'pause' || !isObject(result.transport)) return undefined;
        result.transport.positionTimelineSec = 0.5;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('action pause moved the position back although playback had moved on');
  }, 120_000);

  it('fails a pause that leaves the transport playing', async () => {
    const t = tracking();
    const { hooks } = fixture({
      prepare: moving,
      playMs: 100,
      before: t.before,
      reply: (method, result) => {
        if (method !== 'transport.get' || t.last() !== 'pause' || !isObject(result.transport)) return undefined;
        result.transport.playing = true;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('the transport still plays after action pause');
  }, 120_000);

  it('fails a pause that moves the position of the last start', async () => {
    const t = tracking();
    const { hooks } = fixture({
      prepare: moving,
      playMs: 100,
      before: t.before,
      reply: (method, result) => {
        if (method !== 'transport.get' || t.last() !== 'pause' || !isObject(result.transport)) return undefined;
        result.transport.playStartTimelineSec = 7;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('action pause moved the position that play from start returns to');
  }, 120_000);

  it('fails a play from the last start that stays where the pause left the position', async () => {
    const t = tracking();
    const { hooks } = fixture({
      prepare: moving,
      playMs: 100,
      before: t.before,
      reply: (method, result, params) => {
        if (method !== 'transport.control' || params.action !== 'playFromLastStart' || !isObject(result.transport)) {
          return undefined;
        }
        result.transport.positionTimelineSec = 9;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('action playFromLastStart left the position at 9');
  }, 120_000);

  it('fails a pause at the last start that leaves the transport elsewhere', async () => {
    const t = tracking();
    const { hooks } = fixture({
      prepare: moving,
      playMs: 100,
      before: t.before,
      reply: (method, result) => {
        if (method !== 'transport.get' || t.last() !== 'pauseAtLastStart' || !isObject(result.transport)) {
          return undefined;
        }
        result.transport.positionTimelineSec = 3;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('action pauseAtLastStart left the position at 3');
  }, 120_000);

  it('fails a seek that does not set the position the play from start returns to', async () => {
    let seeks = 0;
    const { hooks } = fixture({
      prepare: moving,
      playMs: 100,
      before: (method, params) => {
        if (method === 'transport.control' && params.action === 'seek') seeks += 1;
      },
      reply: (method, result) => {
        // The reads after the second seek (the one made again) show the old position of the last start.
        if (method !== 'transport.get' || seeks !== 2 || !isObject(result.transport) || result.transport.playing) {
          return undefined;
        }
        result.transport.playStartTimelineSec = 0.5;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('a seek did not set the position that play from start returns to');
  }, 120_000);

  it('keeps what each call said and what a read showed in the report, and the lag of a read as a fact', async () => {
    const t = tracking();
    let stale = 0;
    const { hooks } = fixture({
      prepare: moving,
      playMs: 100,
      before: t.before,
      reply: (method, result) => {
        // OpenTune applies the return to the last start a moment after it answered: the first reads still show
        // the position where playback had got to.
        if (method !== 'transport.get' || t.last() !== 'pauseAtLastStart' || !isObject(result.transport)) {
          return undefined;
        }
        if (stale >= 2) return undefined;
        stale += 1;
        result.transport.positionTimelineSec = 3;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result, step?.note).toBe('PASS');
    expect(stale).toBe(2);
    expect(Number(report.facts.transportPositionLagMs)).toBeGreaterThanOrEqual(50);
    const trace = report.facts.transportTrace;
    expect(Array.isArray(trace) ? trace.length : 0).toBe(8);
    expect(String((trace as string[])[3])).toMatch(/^pauseAtLastStart: said false@/);
  }, 120_000);

  it('fails a position that a read never shows within the wait, and says how long it waited', async () => {
    const t = tracking();
    const { hooks } = fixture({
      prepare: moving,
      playMs: 100,
      before: t.before,
      reply: (method, result) => {
        if (method !== 'transport.get' || t.last() !== 'pauseAtLastStart' || !isObject(result.transport)) {
          return undefined;
        }
        result.transport.positionTimelineSec = 3;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toMatch(/the result says 0\.\d+, a fresh read says 3 \(\d+ ms later still\)/);
    expect(step?.note).toContain('action pauseAtLastStart left the position at 3');
  }, 120_000);

  it('accepts a few microseconds between the result of a pause and a read, as the audio thread ends its block', async () => {
    const t = tracking();
    const { hooks } = fixture({
      prepare: moving,
      playMs: 100,
      before: t.before,
      reply: (method, result) => {
        if (method !== 'transport.control' || t.last() !== 'pause' || !isObject(result.transport)) return undefined;
        result.transport.positionTimelineSec = Number(result.transport.positionTimelineSec) + 0.00002;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result, step?.note).toBe('PASS');
  }, 120_000);

  it('fails a result of a pause that is far from the position a read shows', async () => {
    const t = tracking();
    const { hooks } = fixture({
      prepare: moving,
      playMs: 100,
      before: t.before,
      reply: (method, result) => {
        if (method !== 'transport.control' || t.last() !== 'pause' || !isObject(result.transport)) return undefined;
        result.transport.positionTimelineSec = Number(result.transport.positionTimelineSec) + 0.5;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('the transport in the result of pause is not the one a fresh read shows');
  }, 120_000);

  it('changes the time signature together with the tempo, and the revert recipe puts both back', async () => {
    const sent: Json[] = [];
    const { hooks } = fixture({
      prepare: withAudio,
      before: (method, params) => {
        if (method === 'transport.setTempo') sent.push(structuredClone(params));
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('PASS');
    expect(sent).toEqual([
      { bpm: 121, timeSignature: { numerator: 3, denominator: 4 } },
      { bpm: 120, timeSignature: { numerator: 4, denominator: 4 } },
    ]);
    expect(step?.note).toContain('time signature 4/4 -> 3/4 and back');
  }, 120_000);

  it('fails a result that does not name the time signature among the changes', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result) => {
        if (method !== 'transport.setTempo') return undefined;
        for (const change of Array.isArray(result.changes) ? result.changes.filter(isObject) : []) {
          if (isObject(change.fields)) delete change.fields.timeSignature;
        }
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('the result names no timeSignature change');
  }, 120_000);

  it('fails a revert recipe that puts back the tempo but not the time signature, and stops the tour', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result) => {
        const undo = isObject(result.undo) ? result.undo : undefined;
        const revert = undo !== undefined && isObject(undo.revert) ? undo.revert : undefined;
        if (method !== 'transport.setTempo' || revert === undefined || !isObject(revert.params)) return undefined;
        delete revert.params.timeSignature;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('differs from before the write');
    expect(step?.note).toContain('timeSignature');
  }, 120_000);
});

describe('the selection step of the tour opens the editor', () => {
  const STEP = 'ui.getState and ui.setSelection';

  it('selects the clip with openEditor, and a fresh ui.getState shows the piano roll and that clip', async () => {
    const sent: Json[] = [];
    const { hooks } = fixture({
      prepare: withAudio,
      before: (method, params) => {
        if (method === 'ui.setSelection') sent.push(structuredClone(params));
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result, step?.note).toBe('PASS');
    expect(sent.some((params) => params.openEditor === true && typeof params.placementId === 'string')).toBe(true);
    expect(report.facts.editorOpened).toBe(true);
    expect(step?.note).toContain('openEditor showed the clip in the piano roll');
    // The track is the one of the clip, not track 0 by name.
    const first = sent[0];
    expect(first).toBeDefined();
    expect(typeof first?.trackId).toBe('number');
  }, 120_000);

  it('fails when the window does not show the piano roll after openEditor', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result) => {
        if (method !== 'ui.getState' || !isObject(result.ui)) return undefined;
        result.ui.workspace = 'arrangement';
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('not pianoRoll');
  }, 120_000);

  it('fails when the piano roll shows another content than the clip', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result) => {
        if (method !== 'ui.getState' || !isObject(result.ui) || result.ui.workspace !== 'pianoRoll') return undefined;
        result.ui.pianoRollContentId = 'c:other';
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('another content than the one of the clip');
  }, 120_000);

  it('fails when the result does not name the window switch', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result, params) => {
        if (method !== 'ui.setSelection' || params.openEditor !== true || !isObject(result.sideEffects))
          return undefined;
        delete result.sideEffects.workspaceSwitched;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('workspaceSwitched');
  }, 120_000);
});

describe('the workspace step of the tour closes the piano roll and puts it back', () => {
  const STEP = 'ui.setWorkspace';

  it('switches to the other view, sends the revert recipe, and asks for the shown view once more', async () => {
    const sent: string[] = [];
    const { hooks } = fixture({
      prepare: withAudio,
      before: (method, params) => {
        if (method === 'ui.setWorkspace') sent.push(String(params.workspace));
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result, step?.note).toBe('PASS');
    // The piano roll is open (the step before opened it): arrangement, the revert back, the no-op.
    expect(sent).toEqual(['arrangement', 'pianoRoll', 'pianoRoll']);
    expect(step?.note).toContain('from pianoRoll to arrangement');
    expect(step?.note).toContain('a no-op');
    // The window is as the step found it, and the MCP tool step used its own revert line.
    expect(report.calls.some((call) => call.method === 'ui.setWorkspace' && call.kind === 'revert')).toBe(true);
    const tool = report.tools.find((entry) => entry.tool === 'opentune_manage_ui' && entry.outcome === 'ok');
    expect(tool).toBeDefined();
  }, 120_000);

  it('is skipped, with the capability named, when the instance cannot switch the view', async () => {
    const { hooks } = fixture({
      prepare: (mock) => {
        withAudio(mock);
        mock.given({ withoutCapabilities: ['ui.workspace'] });
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('SKIP');
    expect(step?.note).toContain('ui.workspace');
    expect(report.skipped.join(' ')).toContain('opentune_manage_ui (needs ui.workspace)');
  }, 120_000);

  it('fails when the result names no workspaceSwitched side effect', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result) => {
        if (method !== 'ui.setWorkspace' || result.noOp === true || !isObject(result.sideEffects)) return undefined;
        delete result.sideEffects.workspaceSwitched;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('workspaceSwitched');
  }, 120_000);

  it('fails when the project is marked as changed by a view switch', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result) => {
        if (method !== 'ui.setWorkspace' || result.noOp === true || !isObject(result.dirty)) return undefined;
        // The mark flips: the project was changed by nothing but the view.
        result.dirty.after = result.dirty.after !== true;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('dirty went from');
  }, 120_000);

  it('fails a revert recipe that names the view already shown, and stops the tour', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result) => {
        const undo = isObject(result.undo) ? result.undo : undefined;
        const revert = undo !== undefined && isObject(undo.revert) ? undo.revert : undefined;
        if (method !== 'ui.setWorkspace' || revert === undefined) return undefined;
        revert.params = { workspace: 'arrangement' };
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('differs from before the write');
    expect(step?.note).toContain('workspace');
  }, 120_000);

  it('fails when the view switch does not show in a fresh ui.getState', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result) => {
        // The window state a fresh read reports never leaves the piano roll.
        if (method !== 'ui.getState' || !isObject(result.ui)) return undefined;
        result.ui.workspace = 'pianoRoll';
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('workspace');
  }, 120_000);
});

describe('the track step of the tour sets a colour and sends the revert recipe', () => {
  const STEP = 'track.set, track.add, track.duplicate and track.delete';

  it('sets another colour, sends the recipe of the result, and reads the colour of before back', async () => {
    const sent: Json[] = [];
    const { hooks, mocks } = fixture({
      prepare: withAudio,
      before: (method, params) => {
        if (method === 'track.set') sent.push(structuredClone(params));
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result, step?.note).toBe('PASS');
    const colours = sent.flatMap((params) =>
      (Array.isArray(params.tracks) ? params.tracks.filter(isObject) : []).flatMap((track) =>
        typeof track.colour === 'string' ? [track.colour] : [],
      ),
    );
    // The colour that was set, then the one the track had.
    expect(colours).toHaveLength(2);
    expect(colours[0]).not.toBe(colours[1]);
    expect(mocks[0]?.snapshot().tracks.every((track) => !track.muted)).toBe(true);
  }, 120_000);

  it('fails a revert recipe that puts back another colour, and stops the tour', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result, params) => {
        const tracks = Array.isArray(params.tracks) ? params.tracks.filter(isObject) : [];
        const undo = isObject(result.undo) ? result.undo : undefined;
        const revert = undo !== undefined && isObject(undo.revert) ? undo.revert : undefined;
        if (method !== 'track.set' || !tracks.some((track) => 'colour' in track)) return undefined;
        if (revert === undefined || !isObject(revert.params)) return undefined;
        revert.params = { tracks: [{ trackId: tracks[0]?.trackId, colour: '#000000' }] };
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('differs from before the write');
    expect(step?.note).toContain('colour');
  }, 120_000);

  it('fails a result that names no colour change', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result, params) => {
        const tracks = Array.isArray(params.tracks) ? params.tracks.filter(isObject) : [];
        if (method !== 'track.set' || !tracks.some((track) => 'colour' in track)) return undefined;
        // The colour change leaves the list (a result that still validates against the schema).
        result.changes = (Array.isArray(result.changes) ? result.changes.filter(isObject) : []).filter(
          (change) => !(isObject(change.fields) && 'colour' in change.fields),
        );
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('the result names no colour change');
  }, 120_000);
});

describe('the first-run overlay in the dismiss step of the tour', () => {
  const STEP = 'ui.getState and ui.dismiss';

  /** An instance that lists the overlay as a confirm dialog while it shows (a modal), as the measured build does. */
  const listsOverlayAsDialog = (extra: Json[] = [], staysAfterClose = false): SessionDefect => {
    let closed = false;
    return (method, result, params) => {
      if (method === 'ui.dismiss' && params.target === 'onboarding') closed = true;
      if (method !== 'ui.getState' || !isObject(result.onboarding) || !Array.isArray(result.dialogs)) return undefined;
      const overlay = result.onboarding.showing === true || (closed && staysAfterClose);
      if (overlay) {
        result.dialogs = [{ kind: 'confirm', title: '', closeCommits: false, trackId: null }, ...extra];
      } else if (extra.length > 0) {
        result.dialogs = [...extra];
      }
      return result;
    };
  };

  it('treats the confirm dialog that lists the overlay as the overlay, and closes both', async () => {
    const { hooks } = fixture({
      prepare: (mock) => {
        withAudio(mock);
        mock.showOnboarding(true);
      },
      reply: listsOverlayAsDialog(),
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result, step?.note).toBe('PASS');
    expect(report.facts).toMatchObject({ onboarding: 'showing', openDialogs: 1, onboardingDismissed: true });
    expect(report.result).toBe('PASS');
  }, 120_000);

  it('skips with the kind of a dialog that is not the overlay, and dismisses nothing', async () => {
    const dismissed: Json[] = [];
    const { hooks } = fixture({
      prepare: (mock) => {
        withAudio(mock);
        mock.showOnboarding(true);
      },
      reply: listsOverlayAsDialog([{ kind: 'message', title: 'x', closeCommits: false, trackId: null }]),
      before: (method, params) => {
        if (method === 'ui.dismiss') dismissed.push(structuredClone(params));
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('SKIP');
    expect(step?.note).toContain('1 dialog(s) open that this scenario did not open (kind: message)');
    expect(dismissed).toEqual([]);
  }, 120_000);

  it('skips for a confirm dialog while no overlay shows, since it is not the overlay', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result) => {
        if (method !== 'ui.getState' || !Array.isArray(result.dialogs)) return undefined;
        result.dialogs = [{ kind: 'confirm', title: '', closeCommits: false, trackId: null }];
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('SKIP');
    expect(step?.note).toContain('(kind: confirm)');
  }, 120_000);

  it('fails when ui.getState still lists the dialog of the overlay after it was closed', async () => {
    const { hooks } = fixture({
      prepare: (mock) => {
        withAudio(mock);
        mock.showOnboarding(true);
      },
      reply: listsOverlayAsDialog([], true),
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('ui.getState still lists 1 dialog(s) (confirm)');
  }, 120_000);

  it('closes the overlay of an instance whose data folder never showed it, and onboarding is marked as shown', async () => {
    const { hooks } = fixture({
      prepare: (mock) => {
        withAudio(mock);
        mock.given({ onboarding: 'showing' });
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result, step?.note).toBe('PASS');
    expect(step?.note).toContain('the call marked onboarding as shown: IRREVERSIBLE');
    expect(report.facts).toMatchObject({
      onboarding: 'showing',
      onboardingDismissed: true,
      onboardingMarkedByDismiss: true,
    });
    expect(report.result).toBe('PASS');
  }, 120_000);

  it('closes an overlay that OpenTune had marked as shown already, which changes the view only', async () => {
    const { hooks } = fixture({
      prepare: (mock) => {
        withAudio(mock);
        mock.showOnboarding(true);
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result, step?.note).toBe('PASS');
    expect(step?.note).toContain('OpenTune had marked it already: the view changed only');
    expect(report.facts).toMatchObject({ onboarding: 'showing', onboardingMarkedByDismiss: false });
  }, 120_000);

  it('prevents the overlay when onboarding is not marked as shown and no overlay comes up', async () => {
    const { hooks } = fixture({
      prepare: (mock) => {
        withAudio(mock);
        mock.given({ onboarding: 'notShown' });
      },
      onboardingWaitMs: 300,
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result, step?.note).toBe('PASS');
    expect(step?.note).toContain('ui.dismiss target onboarding marked it (IRREVERSIBLE)');
    expect(report.facts).toMatchObject({ onboarding: 'notShown', onboardingDismissed: true });
  }, 120_000);

  it('waits for the overlay of an instance that has not shown it yet, and closes it', async () => {
    let mock: OtcpMock | undefined;
    let reads = 0;
    const { hooks } = fixture({
      prepare: (m) => {
        withAudio(m);
        m.given({ onboarding: 'notShown' });
        mock = m;
      },
      onboardingWaitMs: 5_000,
      before: (method) => {
        // The overlay comes up on the third look, a moment after the instance is up.
        if (method === 'ui.getState' && ++reads === 3) mock?.showOnboarding(false);
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result, step?.note).toBe('PASS');
    expect(report.facts).toMatchObject({ onboarding: 'showing', onboardingMarkedByDismiss: true });
  }, 120_000);

  it('passes the call as a no-op when onboarding is marked as shown already', async () => {
    const { hooks } = fixture({ prepare: withAudio });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('PASS');
    expect(step?.note).toContain('ui.dismiss target onboarding was a no-op');
    expect(report.facts.onboarding).toBe('shown');
  }, 120_000);

  it('fails when ui.getState still shows the overlay after it was closed', async () => {
    let closed = false;
    const { hooks } = fixture({
      prepare: (mock) => {
        withAudio(mock);
        mock.showOnboarding(true);
      },
      before: (method, params) => {
        if (method === 'ui.dismiss' && params.target === 'onboarding') closed = true;
      },
      reply: (method, result) => {
        if (method !== 'ui.getState' || !closed || !isObject(result.onboarding)) return undefined;
        result.onboarding.showing = true;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('ui.getState still shows the first-run overlay');
  }, 120_000);

  it('fails a result that lists the preference without saying that it cannot be undone', async () => {
    const { hooks } = fixture({
      prepare: (mock) => {
        withAudio(mock);
        mock.given({ onboarding: 'showing' });
      },
      reply: (method, result, params) => {
        if (method !== 'ui.dismiss' || params.target !== 'onboarding') return undefined;
        result.warnings = [];
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('the preference is listed, but there is no IRREVERSIBLE warning');
  }, 120_000);

  it('fails a result that lists nothing but warns about IRREVERSIBLE', async () => {
    const { hooks } = fixture({
      prepare: (mock) => {
        withAudio(mock);
        mock.showOnboarding(true);
      },
      reply: (method, result, params) => {
        if (method !== 'ui.dismiss' || params.target !== 'onboarding') return undefined;
        result.warnings = [{ code: 'IRREVERSIBLE', subject: null, data: null }];
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('nothing is listed, but there is an IRREVERSIBLE warning');
  }, 120_000);

  it('fails an already-shown onboarding when the call is not a no-op', async () => {
    const { hooks } = fixture({
      prepare: withAudio,
      reply: (method, result, params) => {
        if (method !== 'ui.dismiss' || params.target !== 'onboarding') return undefined;
        result.noOp = false;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('noOp is false, expected true');
  }, 120_000);
});

describe('the preference step of the tour', () => {
  const STEP = 'prefs.set';
  const MEMBERS = ['vocoderWeight', 'renderingPriority', 'f0Model'] as const;
  const membersOf = (processing: Json | undefined): Json =>
    Object.fromEntries(MEMBERS.map((name) => [name, processing?.[name]]));

  /** Records what the tour sends with prefs.set and what session.info says; `defect` changes replies, `rewrite` params. */
  function watch(defect?: SessionDefect, rewrite?: BeforeCall) {
    const sent: Json[] = [];
    const infos: Json[] = [];
    const before: BeforeCall = (method, params) => {
      rewrite?.(method, params);
      if (method === 'prefs.set') sent.push(structuredClone(params));
    };
    const reply: SessionDefect = (method, result, params) => {
      if (method === 'session.info' && isObject(result.processing)) infos.push(structuredClone(result.processing));
      return defect?.(method, result, params);
    };
    return { sent, infos, options: { reply, before } };
  }

  /** The calls of the tour that set a preference other than the A4 tuning. */
  const rc6Sent = (sent: readonly Json[]): Json[] => sent.filter((params) => !('tuningHz' in params));

  const twoWeights = (mock: OtcpMock): void => {
    withAudio(mock);
  };
  const oneWeight = (mock: OtcpMock): void => {
    mock.given({ audio: { running: true }, preferences: { options: { vocoderWeight: ['hifigan.onnx'] } } });
    mock.setOutputChannelPairCount(2);
  };

  it('switches each member once, reads it back, puts it back, and sends a weight that is not offered last', async () => {
    const seen = watch();
    const { hooks } = fixture({ prepare: twoWeights, ...seen.options });
    const report = await runWaveBTour(config, hooks);
    expect(stepResult(report, STEP)?.result).toBe('PASS');
    const note = stepResult(report, STEP)?.note ?? '';
    expect(note).toContain('renderingPriority "gpuFirst" -> "cpuFirst" and back (backend null -> null)');
    expect(note).toContain('f0Model set to the one in use is a no-op');
    expect(note).toContain('vocoderWeight "hifigan.onnx" -> "hifigan_coulin9.onnx" and back');
    expect(note).toContain('refused with option_unavailable, nothing changed');
    expect(rc6Sent(seen.sent)).toEqual([
      { renderingPriority: 'cpuFirst' },
      { renderingPriority: 'gpuFirst' },
      { f0Model: 'fcpe' },
      { vocoderWeight: 'hifigan_coulin9.onnx' },
      { vocoderWeight: 'hifigan.onnx' },
      { vocoderWeight: 'not-installed-weight.onnx' },
    ]);
    // What session.info said at the end is what it said at the start, with the vocoder ready.
    const first = seen.infos[0];
    const last = seen.infos.at(-1);
    expect(membersOf(last)).toEqual(membersOf(first));
    expect(last).toMatchObject({ vocoderReady: true, vocoderReconfiguring: false });
    // The job of each change and of each revert of the vocoder weight and the rendering priority was followed.
    expect(report.calls.filter((call) => call.step === STEP && call.method === 'job.get')).toHaveLength(4);
    expect(report.skipped).toEqual([]);
    expect(report.result).toBe('PASS');
  }, 120_000);

  it('skips the vocoder weight where only one is installed, and still sends the weight that is not offered', async () => {
    const seen = watch();
    const { hooks } = fixture({ prepare: oneWeight, ...seen.options });
    const report = await runWaveBTour(config, hooks);
    expect(stepResult(report, STEP)?.result).toBe('PASS');
    const reason = 'only one vocoder weight is installed, or prefs.get reports none in use';
    expect(report.facts['prefs.vocoderWeight']).toBe(`SKIP: ${reason}`);
    expect(report.skipped).toEqual([`prefs.set vocoderWeight (${reason})`]);
    expect(report.facts['prefs.vocoderWeightRefused']).toBe('PASS');
    expect(report.facts.preferencesTouched).toEqual(['tuningHz', 'renderingPriority']);
    expect(rc6Sent(seen.sent).map((params) => Object.keys(params)[0])).toEqual([
      'renderingPriority',
      'renderingPriority',
      'f0Model',
      'vocoderWeight',
    ]);
    expect(rc6Sent(seen.sent).at(-1)).toEqual({ vocoderWeight: 'not-installed-weight.onnx' });
  }, 120_000);

  it('sends nothing of rc.6 to an instance that reports no processing.options, and says why', async () => {
    const seen = watch((method, result) => {
      if (method !== 'prefs.get' || !isObject(result.processing)) return undefined;
      delete result.processing.options;
      return result;
    });
    const { hooks } = fixture({ prepare: twoWeights, ...seen.options });
    const report = await runWaveBTour(config, hooks);
    expect(stepResult(report, STEP)?.result).toBe('PASS');
    expect(rc6Sent(seen.sent)).toEqual([]);
    for (const name of ['renderingPriority', 'f0Model', 'vocoderWeight', 'vocoderWeightRefused']) {
      expect(report.facts[`prefs.${name}`], name).toMatch(/^SKIP: prefs\.get reports no processing\.options/);
    }
    expect(report.skipped).toHaveLength(4);
    expect(report.facts.preferencesTouched).toEqual(['tuningHz']);
  }, 120_000);

  it('fails the step when the revert recipe does not put a member back, sends the start values, and goes on', async () => {
    const seen = watch((method, result) => {
      if (method !== 'job.get' || !isObject(result.job) || !isObject(result.job.result)) return undefined;
      const envelope = result.job.result;
      const change = Array.isArray(envelope.changes) ? envelope.changes.find(isObject) : undefined;
      if (change === undefined || !isObject(change.ref) || change.ref.preference !== 'renderingPriority') {
        return undefined;
      }
      const undo = isObject(envelope.undo) ? envelope.undo : undefined;
      const revert = undo === undefined ? undefined : undo.revert;
      const fields = isObject(change.fields) ? change.fields : {};
      const field = isObject(fields.renderingPriority) ? fields.renderingPriority : {};
      // The recipe sets the value that was just set, so sending it changes nothing.
      if (isObject(revert) && isObject(revert.params)) revert.params.renderingPriority = field.after;
      return result;
    });
    const { hooks } = fixture({ prepare: twoWeights, ...seen.options });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain(
      'prefs.set (renderingPriority): the read-back state after prefs.set (the revert recipe) differs from before the write',
    );
    expect(report.facts['prefs.renderingPriority']).toBe('FAIL');
    // The values of the start were sent once more, and that worked: the other members and the later steps ran.
    expect(rc6Sent(seen.sent).filter((params) => 'renderingPriority' in params)).toEqual([
      { renderingPriority: 'cpuFirst' },
      { renderingPriority: 'cpuFirst' },
      { renderingPriority: 'gpuFirst' },
    ]);
    expect(report.facts['prefs.vocoderWeight']).toBe('PASS');
    expect(report.facts['prefs.vocoderWeightRefused']).toBe('PASS');
    expect(stepResult(report, 'the wave-B MCP tools')?.result).toBe('PASS');
    expect(report.counts.FAIL).toBe(1);
  }, 120_000);

  it('stops the tour when the start values cannot be sent back either', async () => {
    // Every attempt to set the priority to gpuFirst (the revert and the start values) sets cpuFirst instead.
    const seen = watch(undefined, (method, params) => {
      if (method === 'prefs.set' && params.renderingPriority === 'gpuFirst') params.renderingPriority = 'cpuFirst';
    });
    const { hooks } = fixture({ prepare: twoWeights, ...seen.options });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('differs from before the write');
    expect(step?.note).toContain('the values at the start were');
    expect(stepResult(report, 'audio.get and audio.set')?.result).toBe('SKIP');
    expect(stepResult(report, 'audio.get and audio.set')?.note).toContain('could not put the preferences back');
    expect(report.counts.FAIL).toBe(1);
  }, 120_000);

  it('fails a revert of the vocoder weight that is a job which ends with another weight in use', async () => {
    // The recipe of the weight change names the weight just set, so that the revert job changes nothing.
    const seen = watch((method, result) => {
      if (method !== 'job.get' || !isObject(result.job) || !isObject(result.job.result)) return undefined;
      const envelope = result.job.result;
      const undo = isObject(envelope.undo) ? envelope.undo : undefined;
      const revert = undo === undefined ? undefined : undo.revert;
      const change = Array.isArray(envelope.changes) ? envelope.changes.find(isObject) : undefined;
      if (change === undefined || !isObject(change.ref) || change.ref.preference !== 'vocoderWeight') return undefined;
      const fields = isObject(change.fields) ? change.fields : {};
      const field = isObject(fields.vocoderWeight) ? fields.vocoderWeight : {};
      if (isObject(revert) && isObject(revert.params)) revert.params.vocoderWeight = field.after;
      return result;
    });
    const { hooks } = fixture({ prepare: twoWeights, ...seen.options });
    const report = await runWaveBTour(config, hooks);
    expect(stepResult(report, STEP)?.result).toBe('FAIL');
    expect(stepResult(report, STEP)?.note).toContain('prefs.set (vocoderWeight): the read-back state');
    expect(report.facts['prefs.vocoderWeight']).toBe('FAIL');
    // The start weight was sent once more after the revert that changed nothing.
    expect(rc6Sent(seen.sent).filter((params) => 'vocoderWeight' in params)[2]).toEqual({
      vocoderWeight: 'hifigan.onnx',
    });
    expect(stepResult(report, 'the wave-B MCP tools')?.result).toBe('PASS');
  }, 120_000);

  it('fails a weight that is not among the options but was accepted, and takes it back', async () => {
    const seen = watch(undefined, (method, params) => {
      if (
        method === 'prefs.set' &&
        typeof params.vocoderWeight === 'string' &&
        params.vocoderWeight.startsWith('not-')
      ) {
        params.vocoderWeight = 'hifigan_coulin9.onnx';
      }
    });
    const { hooks } = fixture({ prepare: twoWeights, ...seen.options });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('a weight that is not among the options was accepted');
    expect(report.facts['prefs.vocoderWeightRefused']).toBe('FAIL');
    // The accepted change was taken back by its revert recipe, so the later steps ran.
    expect(stepResult(report, 'the wave-B MCP tools')?.result).toBe('PASS');
  }, 120_000);

  it('fails a refusal that is not INVALID_ARGUMENT(option_unavailable)', async () => {
    const { hooks } = fixture({
      prepare: twoWeights,
      before: (method, params) => {
        if (
          method === 'prefs.set' &&
          typeof params.vocoderWeight === 'string' &&
          params.vocoderWeight.startsWith('not-')
        ) {
          params.vocoderWeight = 7;
        }
      },
    });
    const report = await runWaveBTour(config, hooks);
    const step = stepResult(report, STEP);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('not INVALID_ARGUMENT(option_unavailable)');
    expect(report.facts['prefs.vocoderWeightRefused']).toBe('FAIL');
  }, 120_000);

  it('fails a pitch model in use that is not reported as a no-op', async () => {
    const { hooks } = fixture({
      prepare: twoWeights,
      reply: (method, result, params) => {
        if (method !== 'prefs.set' || params.f0Model === undefined) return undefined;
        result.noOp = false;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    expect(stepResult(report, STEP)?.result).toBe('FAIL');
    expect(stepResult(report, STEP)?.note).toContain('prefs.set (f0Model): noOp is false, expected true');
    expect(report.facts['prefs.f0Model']).toBe('FAIL');
  }, 120_000);

  it('fails a priority that prefs.get does not show after the write', async () => {
    const { hooks } = fixture({
      prepare: twoWeights,
      reply: (method, result) => {
        if (method !== 'prefs.get' || !isObject(result.processing)) return undefined;
        if (result.processing.renderingPriority !== 'cpuFirst') return undefined;
        result.processing.renderingPriority = 'gpuFirst';
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    expect(stepResult(report, STEP)?.result).toBe('FAIL');
    expect(stepResult(report, STEP)?.note).toContain('prefs.get says "gpuFirst" after the write, not "cpuFirst"');
    expect(report.facts['prefs.renderingPriority']).toBe('FAIL');
  }, 120_000);

  it('fails a weight change that reports no render of the contents, and a priority change that reports one', async () => {
    const { hooks } = fixture({
      prepare: twoWeights,
      reply: (method, result) => {
        if (method !== 'job.get' || !isObject(result.job) || !isObject(result.job.result)) return undefined;
        const envelope = result.job.result;
        const change = Array.isArray(envelope.changes) ? envelope.changes.find(isObject) : undefined;
        const preference = change !== undefined && isObject(change.ref) ? change.ref.preference : undefined;
        if (preference === 'vocoderWeight') envelope.sideEffects = {};
        else if (preference === 'renderingPriority') {
          envelope.sideEffects = { reRenderQueued: { contentIds: [], revert: null } };
        } else return undefined;
        return result;
      },
    });
    const report = await runWaveBTour(config, hooks);
    const note = stepResult(report, STEP)?.note ?? '';
    expect(stepResult(report, STEP)?.result).toBe('FAIL');
    expect(note).toContain(
      'prefs.set (renderingPriority): the result reports reRenderQueued, which this preference does not cause',
    );
    expect(report.facts['prefs.renderingPriority']).toBe('FAIL');
    expect(report.facts['prefs.vocoderWeight']).toBe('FAIL');
  }, 120_000);

  describe('with a vocoder that OpenTune loads at the first render', () => {
    // Hybrid mode is on, as OpenTune has it by default and the data template of the real run does: a correction of
    // 75 cents or less is then rendered without the vocoder.
    const onDemand = (mock: OtcpMock): void => {
      twoWeights(mock);
      mock.given({ preferences: { hybridMode: true } });
      mock.setVocoderLoadOnDemand(true);
    };
    /** The edit that loads the vocoder and its undo, as the report lists them for the step. */
    const loadCalls = (report: WaveBTourReport): string[] =>
      report.calls
        .filter((call) => call.step === STEP && ['content.editNotes', 'edit.undo'].includes(call.method))
        .map((call) => `${call.method}/${call.kind}/${call.outcome}`);
    const SKIP_REASON = 'the vocoder was not ready within 0.3 s, so the job would not wait for it';

    it('loads it with one edit that it takes back, then switches the priority and the weight', async () => {
      const edits: Json[] = [];
      let beforeEdit: unknown;
      let afterUndo: unknown;
      const notesNow = (): unknown => structuredClone(mocks[0]?.snapshot().contents.map((content) => content.notes));
      const seen = watch(undefined, (method, params) => {
        if (method === 'content.editNotes') {
          edits.push(structuredClone(params));
          beforeEdit = notesNow();
        }
        if (method === 'prefs.set' && 'renderingPriority' in params) afterUndo ??= notesNow();
      });
      const { hooks, mocks } = fixture({ prepare: onDemand, ...seen.options });
      const report = await runWaveBTour(config, hooks);
      expect(stepResult(report, STEP)?.result).toBe('PASS');
      // The vocoder was not ready at first; the step says that one render loaded it.
      expect(seen.infos[0]).toMatchObject({ vocoderReady: false, vocoderReconfiguring: false });
      expect(stepResult(report, STEP)?.note).toContain(
        'the vocoder was loaded by one render first: OpenTune loads it on the first render',
      );
      // One edit of one note and its undo, listed in the report; the notes are as they were before the edit.
      expect(loadCalls(report)).toEqual(['content.editNotes/write/ok', 'edit.undo/undo/ok']);
      expect(edits).toHaveLength(1);
      expect(edits[0]).toMatchObject({
        ops: [{ op: 'shiftCents', select: { indices: [expect.any(Number)] }, deltaCents: VOCODER_LOAD_SHIFT_CENTS }],
      });
      expect(stepResult(report, STEP)?.note).toContain(
        `one note shifted by ${String(VOCODER_LOAD_SHIFT_CENTS)} cents and taken back with edit.undo`,
      );
      expect(afterUndo).toBeDefined();
      expect(afterUndo).toEqual(beforeEdit);
      // Both changes that a job applies ran after it, and the one edit served both.
      expect(report.facts['prefs.renderingPriority']).toBe('PASS');
      expect(report.facts['prefs.vocoderWeight']).toBe('PASS');
      expect(rc6Sent(seen.sent).map((params) => Object.keys(params)[0])).toEqual([
        'renderingPriority',
        'renderingPriority',
        'f0Model',
        'vocoderWeight',
        'vocoderWeight',
        'vocoderWeight',
      ]);
      expect(seen.infos.at(-1)).toMatchObject({ vocoderReady: true, vocoderReconfiguring: false });
      expect(report.skipped).toEqual([]);
      expect(report.result).toBe('PASS');
    }, 120_000);

    it('makes no edit when the vocoder is ready', async () => {
      const seen = watch();
      const { hooks } = fixture({ prepare: twoWeights, ...seen.options });
      const report = await runWaveBTour(config, hooks);
      expect(stepResult(report, STEP)?.result).toBe('PASS');
      expect(loadCalls(report)).toEqual([]);
      expect(stepResult(report, STEP)?.note).not.toContain('loaded by one render');
      expect(report.facts['prefs.renderingPriority']).toBe('PASS');
    }, 120_000);

    it('skips the priority and the weight with the old reason when the vocoder is not ready after the edit, and takes the edit back', async () => {
      let beforeEdit: unknown;
      let afterUndo: unknown;
      const notesNow = (): unknown => structuredClone(mocks[0]?.snapshot().contents.map((content) => content.notes));
      const seen = watch(undefined, (method) => {
        if (method === 'content.editNotes') beforeEdit = notesNow();
        if (method === 'edit.undo' && beforeEdit !== undefined && afterUndo === undefined) afterUndo = 'pending';
        if (method === 'prefs.set' && afterUndo === 'pending') afterUndo = notesNow();
      });
      const { hooks, mocks } = fixture({
        prepare: (mock) => {
          onDemand(mock);
          // The load never ends.
          mock.setVocoderFault('stuck');
        },
        vocoderLoadMs: 300,
        vocoderSettleMs: 300,
        ...seen.options,
      });
      const report = await runWaveBTour(config, hooks);
      expect(stepResult(report, STEP)?.result).toBe('PASS');
      expect(report.facts['prefs.renderingPriority']).toBe(`SKIP: ${SKIP_REASON}`);
      expect(report.facts['prefs.vocoderWeight']).toBe(`SKIP: ${SKIP_REASON}`);
      expect(report.skipped).toEqual([
        `prefs.set renderingPriority (${SKIP_REASON})`,
        `prefs.set vocoderWeight (${SKIP_REASON})`,
      ]);
      expect(stepResult(report, STEP)?.note).toContain('but it was not ready after the render');
      // Tried once, however many changes were skipped, and taken back.
      expect(loadCalls(report)).toEqual(['content.editNotes/write/ok', 'edit.undo/undo/ok']);
      expect(afterUndo).toEqual(beforeEdit);
      expect(rc6Sent(seen.sent).filter((params) => 'renderingPriority' in params)).toEqual([]);
      expect(rc6Sent(seen.sent).filter((params) => params.vocoderWeight === 'hifigan_coulin9.onnx')).toEqual([]);
      expect(report.facts['prefs.f0Model']).toBe('PASS');
      expect(report.facts['prefs.vocoderWeightRefused']).toBe('PASS');
    }, 120_000);

    it('fails the step and stops the tour when the edit cannot be taken back', async () => {
      let edited = false;
      let corrupted = false;
      const seen = watch(undefined, (method, params) => {
        if (method === 'content.editNotes') edited = true;
        else if (method === 'edit.undo' && edited && !corrupted) {
          corrupted = true;
          params.expectedUndoId = 'not-the-undo-id';
        }
      });
      const { hooks } = fixture({ prepare: onDemand, ...seen.options });
      const report = await runWaveBTour(config, hooks);
      const step = stepResult(report, STEP);
      expect(step?.result).toBe('FAIL');
      expect(step?.note).toContain('content.editNotes (an edit to load the vocoder): taking the write back failed');
      // Nothing of rc.6 was sent, and the tour stopped before the later steps.
      expect(rc6Sent(seen.sent)).toEqual([]);
      expect(stepResult(report, 'audio.get and audio.set')?.result).toBe('SKIP');
      expect(stepResult(report, 'audio.get and audio.set')?.note).toContain('could not be taken back');
      expect(report.counts.FAIL).toBe(1);
    }, 120_000);

    it('fails the step, without an undo, when the edit is refused, and skips the changes with the old reason', async () => {
      const seen = watch(undefined, (method, params) => {
        if (method === 'content.editNotes') params.expectedRevision = 'a-revision-that-is-not-current';
      });
      const { hooks } = fixture({ prepare: onDemand, vocoderSettleMs: 300, ...seen.options });
      const report = await runWaveBTour(config, hooks);
      const step = stepResult(report, STEP);
      expect(step?.result).toBe('FAIL');
      expect(step?.note).toContain('content.editNotes (an edit to load the vocoder): content.editNotes failed with');
      expect(loadCalls(report)).toEqual(['content.editNotes/write/error']);
      expect(report.facts['prefs.renderingPriority']).toBe(`SKIP: ${SKIP_REASON}`);
      expect(report.facts['prefs.vocoderWeight']).toBe(`SKIP: ${SKIP_REASON}`);
      expect(rc6Sent(seen.sent).filter((params) => 'renderingPriority' in params)).toEqual([]);
      // The later steps ran.
      expect(stepResult(report, 'the wave-B MCP tools')?.result).toBe('PASS');
    }, 120_000);

    it('does not load the vocoder with a correction of 10 cents under hybrid mode, as the real run showed', async () => {
      // The render is done by resampling: it catches up at once, and the vocoder stays unloaded.
      const seen = watch(undefined, (method, params) => {
        if (method !== 'content.editNotes' || !Array.isArray(params.ops)) return;
        for (const op of params.ops) if (isObject(op)) op.deltaCents = 10;
      });
      const { hooks } = fixture({ prepare: onDemand, vocoderSettleMs: 300, ...seen.options });
      const report = await runWaveBTour(config, hooks);
      expect(stepResult(report, STEP)?.result).toBe('PASS');
      expect(stepResult(report, STEP)?.note).toContain('but it was not ready after the render');
      expect(loadCalls(report)).toEqual(['content.editNotes/write/ok', 'edit.undo/undo/ok']);
      expect(report.facts['prefs.renderingPriority']).toBe(`SKIP: ${SKIP_REASON}`);
      expect(report.facts['prefs.vocoderWeight']).toBe(`SKIP: ${SKIP_REASON}`);
    }, 120_000);

    it('moves the note far enough to leave the range that hybrid mode renders without the vocoder', () => {
      // 75 cents is the limit of the resampling; a generated note can lie 50 cents from the pitch it was sung at.
      expect(VOCODER_LOAD_SHIFT_CENTS).toBeGreaterThanOrEqual(75 + 50);
    });

    it('tries nothing, and says so, when the clip has no voiced note', async () => {
      const seen = watch((method, result) => {
        if (method !== 'content.getNotes' || !Array.isArray(result.notes)) return undefined;
        for (const note of result.notes) if (isObject(note)) note.voiced = false;
        return result;
      });
      const { hooks } = fixture({ prepare: onDemand, vocoderSettleMs: 300, ...seen.options });
      const report = await runWaveBTour(config, hooks);
      expect(stepResult(report, STEP)?.result).toBe('PASS');
      expect(stepResult(report, STEP)?.note).toContain(
        'the clip has no voiced note to edit, so no render was tried to load the vocoder',
      );
      // No edit, so no undo; the changes that need the vocoder are skipped for the old reason, once the note is said.
      expect(loadCalls(report)).toEqual([]);
      expect(report.facts['prefs.renderingPriority']).toBe(`SKIP: ${SKIP_REASON}`);
      expect(report.facts['prefs.vocoderWeight']).toBe(`SKIP: ${SKIP_REASON}`);
      expect(
        stepResult(report, STEP)?.note.split('the clip has no voiced note to edit').length,
        'the sentence is written once',
      ).toBe(2);
    }, 120_000);

    it('reports a result of the edit that carries no token for the content, and still takes the edit back', async () => {
      const seen = watch((method, result) => {
        if (method !== 'content.editNotes' || !isObject(result.tokens)) return undefined;
        result.tokens.contents = [];
        return result;
      });
      const { hooks } = fixture({ prepare: onDemand, ...seen.options });
      const report = await runWaveBTour(config, hooks);
      expect(stepResult(report, STEP)?.result).toBe('FAIL');
      expect(stepResult(report, STEP)?.note).toContain(
        'content.editNotes (an edit to load the vocoder): the result of the edit carries no token for the content',
      );
      expect(loadCalls(report)).toEqual(['content.editNotes/write/ok', 'edit.undo/undo/ok']);
      // The revision check did not turn into a pass, and nothing else was reported about the revision.
      expect(stepResult(report, STEP)?.note).not.toContain('still the one right after the edit');
    }, 120_000);

    it('reports a project that does not list the content after the undo', async () => {
      let undone = false;
      let stripped = false;
      const seen = watch(
        (method, result) => {
          if (method !== 'project.get' || !undone || stripped || !isObject(result.asOf)) return undefined;
          stripped = true;
          result.asOf.contents = [];
          return result;
        },
        (method) => {
          if (method === 'edit.undo') undone = true;
        },
      );
      const { hooks } = fixture({ prepare: onDemand, ...seen.options });
      const report = await runWaveBTour(config, hooks);
      expect(stepResult(report, STEP)?.result).toBe('FAIL');
      expect(stepResult(report, STEP)?.note).toContain(
        'content.editNotes (an edit to load the vocoder): after the undo, project.get does not list the content',
      );
      expect(stepResult(report, STEP)?.note).not.toContain('give the content different revisions');
    }, 120_000);
  });

  it('picks the other value of a pair, the other weight, and a weight that is not offered', () => {
    expect(otherOf('gpuFirst', ['gpuFirst', 'cpuFirst'])).toBe('cpuFirst');
    expect(otherOf('cpuFirst', ['gpuFirst', 'cpuFirst'])).toBe('gpuFirst');
    expect(otherOf(null, ['gpuFirst', 'cpuFirst'])).toBeNull();
    expect(otherOf('auto', ['gpuFirst', 'cpuFirst'])).toBeNull();
    expect(otherWeight({ vocoderWeight: ['a', 'b'] }, 'a')).toBe('b');
    expect(otherWeight({ vocoderWeight: ['a', 'b'] }, 'b')).toBe('a');
    expect(otherWeight({ vocoderWeight: ['a', 'b'] }, null)).toBe('a');
    expect(otherWeight({ vocoderWeight: ['a'] }, 'a')).toBeNull();
    expect(otherWeight({ vocoderWeight: [] }, 'a')).toBeNull();
    expect(otherWeight({}, 'a')).toBeNull();
    expect(otherWeight(undefined, 'a')).toBeNull();
    expect(otherWeight({ vocoderWeight: ['a', 3, 'b'] }, 'a')).toBe('b');
    expect(unofferedWeight(['a'])).toBe('not-installed-weight.onnx');
    expect(unofferedWeight(['not-installed-weight.onnx'])).toBe('x-not-installed-weight.onnx');
  });
});
