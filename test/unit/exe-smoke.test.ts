// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The end-to-end smoke scenario (test/e2e/smoke.ts) against the stand-in executable
// (test/support/fake-opentune.mjs, `smoke*` modes): the protocol is walked, the timings and the
// report are right, and each way a step can end gets its result. The stand-in analyses no audio.
// Two runs of the real test file in a child process show that it is skipped without OTCP_TARGET_EXE
// and runs the scenario with it.

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { OtcpError } from '../../src/errors/tool-error.js';
import {
  classify,
  formatTable,
  readWav,
  runSmoke,
  smokeSetupFromEnv,
  summarise,
  writeReport,
  type SmokeConfig,
  type SmokeReport,
} from '../e2e/smoke.js';
import { wavFile } from '../support/wav-file.js';

const FAKE = fileURLToPath(new URL('../support/fake-opentune.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const SLOW = 90_000;

const config = (mode: string): SmokeConfig => ({
  exe: { exe: process.execPath, args: [FAKE, `--mode=${mode}`], timeoutMs: 15_000 },
  stepTimeoutMs: 20_000,
  reportPath: undefined,
});

const names = (report: SmokeReport) => report.steps.map((s) => `${s.name}=${s.result}`);

const scratch: string[] = [];
async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ot-smoke-test-'));
  scratch.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('smoke scenario against the stand-in', () => {
  it(
    'walks import, AUTO and export, times every step and reports PASS',
    async () => {
      const report = await runSmoke(config('smoke'));
      expect(names(report)).toEqual([
        'generate audio=PASS',
        'launch=PASS',
        'hello=PASS',
        'import and analysis=PASS',
        'AUTO (regenerate)=PASS',
        'export=PASS',
        'check exported file=PASS',
        'shutdown=PASS',
      ]);
      expect(report.result).toBe('PASS');
      expect(report.counts).toEqual({ PASS: 8, FAIL: 0, SKIP: 0, 'FLAKY-SKIP': 0 });
      for (const step of report.steps) expect(Number.isInteger(step.ms) && step.ms >= 0).toBe(true);
      // The import waits for a job that is first reported running, so it cannot be instantaneous.
      expect(report.steps.find((s) => s.name === 'import and analysis')?.ms).toBeGreaterThan(50);
      expect(report.totalMs).toBeGreaterThanOrEqual(report.steps.reduce((a, s) => a + s.ms, 0) - 8);
      expect(report.instance).toMatchObject({ protocol: '1.0', appVersion: '0.0.0-fake' });
      expect(report.audio).toMatchObject({ exportChannels: 2, exportSampleRateHz: 44100, exportDryContents: 0 });
      expect(formatTable(report)).toMatch(/\| AUTO \(regenerate\) \| PASS \| [\d.]+ s \|/);

      // The report is JSON a workflow can upload, and holds neither a path nor a secret.
      const dir = await tmp();
      const file = path.join(dir, 'nested', 'report.json');
      writeReport(file, report);
      const text = await readFile(file, 'utf8');
      expect(JSON.parse(text)).toEqual(report);
      expect(text).not.toMatch(/ot-tone-|[0-9a-f]{32}[0-9a-f]{32}/);
    },
    SLOW,
  );

  it(
    'fails the check of the exported file when the content was exported uncorrected',
    async () => {
      const report = await runSmoke(config('smoke-dry'));
      expect(report.result).toBe('FAIL');
      expect(report.steps.find((s) => s.name === 'check exported file')).toMatchObject({
        result: 'FAIL',
        note: expect.stringContaining('exported uncorrected') as unknown,
      });
      // Clean-up still runs.
      expect(report.steps.at(-1)).toMatchObject({ name: 'shutdown', result: 'PASS' });
    },
    SLOW,
  );

  it(
    'is a FLAKY-SKIP, not a failure, when the inference backend cannot start; later steps are SKIP',
    async () => {
      const report = await runSmoke(config('smoke-backend'));
      expect(names(report).slice(2)).toEqual([
        'hello=PASS',
        'import and analysis=FLAKY-SKIP',
        'AUTO (regenerate)=SKIP',
        'export=SKIP',
        'check exported file=SKIP',
        'shutdown=PASS',
      ]);
      expect(report.result).toBe('FLAKY-SKIP');
      expect(report.counts['FLAKY-SKIP']).toBe(1);
      expect(report.steps[3]?.note).toContain('inference backend');
      expect(report.steps[4]?.note).toBe('not run: import and analysis ended with FLAKY-SKIP');
    },
    SLOW,
  );

  it(
    'skips when the instance does not report a capability the scenario needs',
    async () => {
      const report = await runSmoke(config('smoke-no-export'));
      expect(report.result).toBe('SKIP');
      expect(report.steps.find((s) => s.name === 'hello')).toMatchObject({
        result: 'SKIP',
        note: expect.stringContaining('export.v1') as unknown,
      });
      expect(report.counts.FAIL).toBe(0);
    },
    SLOW,
  );

  it(
    'fails at the launch when the executable never writes a ready file, and nothing after it runs',
    async () => {
      const report = await runSmoke({
        ...config('no-ready'),
        exe: { exe: process.execPath, args: [FAKE, '--mode=no-ready'], timeoutMs: 1500 },
      });
      expect(report.result).toBe('FAIL');
      expect(report.steps.find((s) => s.name === 'launch')?.result).toBe('FAIL');
      expect(report.steps.find((s) => s.name === 'hello')?.result).toBe('SKIP');
      expect(report.instance).toBeNull();
    },
    SLOW,
  );
});

describe('smoke helpers', () => {
  it('reads the environment: skipped without an executable, a config with one', () => {
    expect(smokeSetupFromEnv({})).toEqual({ skip: 'OTCP_TARGET_EXE is not set' });
    const setup = smokeSetupFromEnv({
      OTCP_TARGET_EXE: process.execPath,
      OTCP_E2E_STEP_TIMEOUT_MS: '5000',
      OTCP_E2E_REPORT: path.join(os.tmpdir(), 'r.json'),
    });
    expect(setup).toMatchObject({ config: { stepTimeoutMs: 5000, exe: { exe: process.execPath } } });
    expect(smokeSetupFromEnv({ OTCP_TARGET_EXE: process.execPath })).toMatchObject({
      config: { stepTimeoutMs: 180_000, reportPath: undefined },
    });
    expect(() => smokeSetupFromEnv({ OTCP_TARGET_EXE: process.execPath, OTCP_E2E_STEP_TIMEOUT_MS: '0' })).toThrow(
      /positive integer/,
    );
    expect(() => smokeSetupFromEnv({ OTCP_TARGET_EXE: process.execPath, OTCP_E2E_REPORT: 'r.json' })).toThrow(
      /absolute path/,
    );
  });

  it('classifies errors: only an unavailable backend is a FLAKY-SKIP', () => {
    const otcp = (kind: string, reason: string) =>
      new OtcpError({ kind, reason, retryable: false, detail: 'd', executed: false });
    expect(classify(otcp('MODEL_UNAVAILABLE', 'backend_unavailable')).result).toBe('FLAKY-SKIP');
    expect(classify(otcp('MODEL_UNAVAILABLE', 'model_missing')).result).toBe('FAIL');
    expect(classify(otcp('TIMEOUT', 'dispatch_timeout')).result).toBe('FAIL');
    expect(classify(new Error('boom'))).toEqual({ result: 'FAIL', note: 'boom' });
    expect(classify('x'.repeat(40) + 'a'.repeat(64)).note).toContain('[redacted]');
  });

  it('summarises: any FAIL wins, then FLAKY-SKIP, then SKIP', () => {
    const step = (result: SmokeReport['result']) => ({ name: 'n', result, ms: 0, note: '' });
    expect(summarise([step('PASS'), step('SKIP'), step('FAIL')]).result).toBe('FAIL');
    expect(summarise([step('PASS'), step('SKIP'), step('FLAKY-SKIP')]).result).toBe('FLAKY-SKIP');
    expect(summarise([step('PASS'), step('SKIP')]).result).toBe('SKIP');
    expect(summarise([step('PASS')]).result).toBe('PASS');
  });

  it('reads WAV files: integer and float samples, and rejects what is not one', () => {
    const wav = readWav(wavFile({ seconds: 0.5, rate: 8000 }));
    expect(wav).toMatchObject({ sampleRateHz: 8000, channels: 1, bits: 16, float: false });
    expect(wav.durationSec).toBeCloseTo(0.5, 3);
    expect(wav.peak).toBeGreaterThan(0.2);
    expect(readWav(wavFile({ seconds: 0.25, rate: 8000, voiced: false })).peak).toBe(0);
    expect(readWav(wavFile({ seconds: 0.25, bits: 24, channels: 2 }))).toMatchObject({ bits: 24, channels: 2 });
    expect(readWav(wavFile({ seconds: 0.25, bits: 32, float: true }))).toMatchObject({ bits: 32, float: true });
    expect(readWav(wavFile({ seconds: 0.25, bits: 32 })).bits).toBe(32);
    expect(readWav(wavFile({ seconds: 0.25, extensible: true, extraChunk: true })).channels).toBe(1);
    expect(() => readWav(Buffer.from('not a wav file at all'))).toThrow(/not a RIFF\/WAVE/);
    expect(() => readWav(wavFile({ seconds: 0.1, noData: true }))).toThrow(/no fmt or data/);
    expect(() => readWav(wavFile({ seconds: 0.1, formatTag: 2 }))).toThrow(/format tag 2/);
  });
});

/** Runs the real test file of the scenario in a child process, with only the variables given. */
function runTestFile(env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OTCP_')));
  return spawnSync(process.execPath, [VITEST, 'run', '--project', 'e2e', '--reporter=verbose'], {
    cwd: ROOT,
    env: { ...clean, ...env },
    encoding: 'utf8',
    timeout: 80_000,
  });
}

describe('the scenario as a test file', () => {
  it(
    'is skipped as a whole, with its reason, when OTCP_TARGET_EXE is not set',
    () => {
      const run = runTestFile({});
      const output = `${run.stdout}\n${run.stderr}`;
      expect(run.status).toBe(0);
      expect(output).toContain('exe smoke not run: OTCP_TARGET_EXE is not set');
      expect(output).toMatch(/1 skipped/);
      expect(output).not.toMatch(/passed/);
    },
    SLOW,
  );

  it(
    'runs the scenario and writes the report when OTCP_TARGET_EXE is set',
    async () => {
      const dir = await tmp();
      const report = path.join(dir, 'report.json');
      const run = runTestFile({
        OTCP_TARGET_EXE: process.execPath,
        OTCP_TARGET_ARGS: JSON.stringify([FAKE, '--mode=smoke']),
        OTCP_E2E_REPORT: report,
        OTCP_E2E_STEP_TIMEOUT_MS: '20000',
      });
      const output = `${run.stdout}\n${run.stderr}`;
      expect(run.status, output).toBe(0);
      expect(output).toMatch(/\| export \| PASS \|/);
      const written = JSON.parse(await readFile(report, 'utf8')) as SmokeReport;
      expect(written).toMatchObject({ schema: 'opentune-mcp-e2e-exe/1', result: 'PASS' });
    },
    SLOW,
  );
});
