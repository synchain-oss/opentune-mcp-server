// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The boundary scenario (test/e2e/boundary.ts) against the test mock in place of an executable: the
// steps, their order and the report are right, and a deviation of the instance from what the
// scenario expects fails the step that notices it instead of passing.

import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startMock, type OtcpMock } from '../../mock/server.js';
import type { TargetInstance } from '../contract/target.js';
import { refusals, runBoundary } from '../e2e/boundary.js';
import { Scenario, formatScenarioTable, scenarioReportPath } from '../e2e/scenario.js';
import { StepSkip, type SmokeConfig } from '../e2e/smoke.js';
import { tempDir } from '../support/context.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const config: SmokeConfig = {
  exe: { exe: process.execPath },
  stepTimeoutMs: 20_000,
  reportPath: undefined,
};

/** A target whose "executable" is the in-process mock; `tweak` runs on the mock before the scenario sees it. */
function mockTarget(tweak: (mock: OtcpMock) => void = () => undefined) {
  return {
    async open(): Promise<TargetInstance> {
      const t = tempDir();
      const mock = await startMock({ discoveryDir: t.dir });
      tweak(mock);
      cleanup.push(t.remove);
      return {
        discovery: mock.discovery,
        protocol: '1.0',
        capabilities: [],
        establish: () => Promise.resolve({}),
        runnerValue: () => undefined,
        close: () => mock.stop(),
      };
    },
    takeProblems: () => [],
  };
}

const names = (steps: readonly { name: string; result: string }[]) => steps.map((s) => `${s.name}=${s.result}`);

describe('boundary scenario against the mock', () => {
  it('runs every step, passes, and reports what it observed', async () => {
    const report = await runBoundary(config, { target: mockTarget() });
    expect(names(report.steps)).toEqual([
      'generate audio=PASS',
      'launch=PASS',
      'hello=PASS',
      'Chinese and spaced paths: import and export round trip=PASS',
      'silent WAV: clip kept, analysis outcome reported=PASS',
      'master export lists the silent clip in dryContents=PASS',
      '601 s, 8 kHz, 8 bit WAV: audio_too_long with the limit=PASS',
      'undo and redo round trip restores the read-back state=PASS',
      'forbidden paths are refused and nothing is written=PASS',
      'shutdown=PASS',
    ]);
    expect(report).toMatchObject({ schema: 'opentune-mcp-e2e-exe/1', scenario: 'boundary', result: 'PASS' });
    expect(report.counts).toEqual({ PASS: 10, FAIL: 0, SKIP: 0, 'FLAKY-SKIP': 0 });
    expect(report.facts.maxAnalysisSec).toBe(600);
    expect(report.facts.longAudioBytes).toBeLessThan(5_000_000);
    expect(report.manualChecks).toEqual([]);
    expect(formatScenarioTable(report)).toContain('| step | result | time | note |');
  }, 60_000);

  it('skips only the undo step, and the run is SKIP, when the instance has no history capability', async () => {
    const report = await runBoundary(config, {
      target: mockTarget((mock) => {
        mock.given({ withoutCapabilities: ['history.v1'] });
      }),
    });
    const undo = report.steps.find((s) => s.name.startsWith('undo and redo'));
    expect(undo).toMatchObject({ result: 'SKIP' });
    expect(undo?.note).toContain('history.v1');
    expect(report.counts).toEqual({ PASS: 9, FAIL: 0, SKIP: 1, 'FLAKY-SKIP': 0 });
    expect(report.result).toBe('SKIP');
    // The steps after it still ran.
    expect(report.steps.find((s) => s.name.startsWith('forbidden paths'))?.result).toBe('PASS');
  }, 60_000);

  it('names where the report goes', () => {
    expect(scenarioReportPath(path.join('r', 'out', 'report.json'), 'boundary')).toBe(
      path.join('r', 'out', 'boundary.json'),
    );
    expect(scenarioReportPath(undefined, 'boundary')).toBeUndefined();
  });

  it('lists the refused paths of the platform, each with its reason', () => {
    const list = refusals(process.platform === 'win32' ? 'C:\\x\\refused' : '/x/refused', 'rel.wav');
    expect(list.map((r) => r.reason)).toEqual(
      process.platform === 'win32'
        ? ['path_not_absolute', 'path_unc', 'path_alternate_stream', 'path_bad_extension']
        : ['path_not_absolute', 'path_bad_extension'],
    );
  });
});

describe('Scenario step results', () => {
  const fail = () => Promise.reject(new Error('broken'));
  const skip = () => Promise.reject(new StepSkip('SKIP', 'capability missing'));
  const pass = () => Promise.resolve('fine');
  const run = async (first: () => Promise<string>, options: Parameters<Scenario['step']>[2]) => {
    const scenario = new Scenario('t');
    await scenario.step('one', first, options);
    await scenario.step('two', pass);
    await scenario.step('clean-up', pass, { always: true });
    return scenario.report();
  };
  const results = (r: Awaited<ReturnType<typeof run>>) => r.steps.map((x) => x.result);

  it('stops after a FAIL, but still runs clean-up', async () => {
    expect(results(await run(fail, undefined))).toEqual(['FAIL', 'SKIP', 'PASS']);
  });
  it('goes on after a FAIL of a step that says nothing depends on it, and the run is still FAIL', async () => {
    const report = await run(fail, { haltOnFail: false });
    expect(results(report)).toEqual(['FAIL', 'PASS', 'PASS']);
    expect(report.result).toBe('FAIL');
  });
  it('goes on after a SKIP unless the step says later ones depend on it', async () => {
    expect(results(await run(skip, undefined))).toEqual(['SKIP', 'PASS', 'PASS']);
    expect(results(await run(skip, { haltOnSkip: true }))).toEqual(['SKIP', 'SKIP', 'PASS']);
    expect((await run(skip, undefined)).result).toBe('SKIP');
  });
});
