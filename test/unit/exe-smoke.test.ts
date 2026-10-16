// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The end-to-end smoke scenario (test/e2e/smoke.ts) against the stand-in executable
// (test/support/fake-opentune.mjs, `smoke*` modes): the protocol is walked, the timings and the
// report are right, and each way a step can end gets its result. The stand-in analyses no audio.
// Two runs of the real test file in a child process show that it is skipped without OTCP_TARGET_EXE
// and runs the scenario with it.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { exeTarget } from '../contract/exe-target.js';
import { OtcpSession, type Json } from '../../src/otcp/client.js';
import { parseDiscoveryFile } from '../../src/discovery/file.js';
import { otcpSpec } from '../support/otcp-spec.js';
import { OtcpError } from '../../src/errors/tool-error.js';
import {
  classify,
  formatTable,
  isModalBusy,
  readWav,
  runSmoke,
  safeTitle,
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

/**
 * Walks the scenario's calls against the stand-in and checks every reply against the schema of the
 * method: `result` for a call, `jobResult` for the result of the job it started.
 */
async function walk(mode: string): Promise<string[]> {
  const spec = otcpSpec();
  const problems: string[] = [];
  const check = (what: string, ref: string, value: unknown) => {
    for (const p of spec.validate(`methods/${ref}`, value)) problems.push(`${what}: ${p}`);
  };
  const target = exeTarget(config(mode).exe);
  const instance = await target.open();
  const dir = await tmp();
  try {
    const entry = parseDiscoveryFile(
      `${String(instance.discovery.pid)}.json`,
      Buffer.from(JSON.stringify(instance.discovery), 'utf8'),
    );
    if (!entry.ok) throw new Error(entry.problem);
    const session = await OtcpSession.open(entry.entry, 15_000);
    const follow = async (jobId: string, jobResultRef: string): Promise<Json> => {
      for (;;) {
        const reply = await session.call('job.get', { jobId, waitMs: 0 }, 5000);
        check('job.get', 'job.get.schema.json#/$defs/result', reply);
        const job = reply.job as Json;
        if (job.state === 'succeeded') {
          check(`${jobResultRef} jobResult`, `${jobResultRef}.schema.json#/$defs/jobResult`, job.result);
          return job.result as Json;
        }
      }
    };
    const source = path.join(dir, 'in.wav');
    await writeFile(source, wavFile({ seconds: 1, rate: 8000 }));
    const exportPath = path.join(dir, 'out.wav');
    const imp = await session.call('import.start', { items: [{ path: source }] }, 5000);
    check('import.start', 'import.start.schema.json#/$defs/result', imp);
    await follow((imp.job as Json).jobId as string, 'import.start');
    const details = await session.call('content.getDetails', { contentId: 'c:0123abcd:0:1' }, 5000);
    check('content.getDetails', 'content.getDetails.schema.json#/$defs/result', details);
    const tune = await session.call(
      'content.autoTune',
      { contentId: 'c:0123abcd:0:1', mode: 'regenerate', key: { root: 0, scale: 'chromatic' }, expectedRevision: 'r1' },
      5000,
    );
    check('content.autoTune', 'content.autoTune.schema.json#/$defs/result', tune);
    if (tune.job !== null) await follow((tune.job as Json).jobId as string, 'content.autoTune');
    const exp = await session.call('export.start', { kind: 'master', path: exportPath, ifExists: 'error' }, 5000);
    check('export.start', 'export.start.schema.json#/$defs/result', exp);
    await follow((exp.job as Json).jobId as string, 'export.start');
    session.close();
  } finally {
    await instance.close();
  }
  return problems;
}

describe('the stand-in follows the specification', () => {
  for (const mode of ['smoke', 'smoke-dry', 'smoke-auto-job', 'smoke-open-scale']) {
    it(
      `every reply of ${mode} is valid against its result or jobResult schema`,
      async () => {
        expect(await walk(mode)).toEqual([]);
      },
      SLOW,
    );
  }

  it('the check catches a reply that is not valid (noteCount as a number, no pitchShift)', () => {
    const spec = otcpSpec();
    const bad = { mode: 'regenerate', noteCount: 8, omittedCount: 0 };
    expect(spec.validate('methods/content.autoTune.schema.json#/$defs/result', bad)).not.toEqual([]);
    expect(
      spec.validate('methods/content.getDetails.schema.json#/$defs/result', { contentId: 'c:0123abcd:0:1' }),
    ).not.toEqual([]);
  });

  it(
    'AUTO passes when the work is handed to a job, and with a scale AUTO does not take',
    async () => {
      const job = await runSmoke(config('smoke-auto-job'));
      expect(job.result).toBe('PASS');
      expect(job.steps.find((s) => s.name === 'AUTO (regenerate)')?.note).toContain('8 notes (before 0)');
      const open = await runSmoke(config('smoke-open-scale'));
      expect(open.result).toBe('PASS');
      expect(open.steps.find((s) => s.name === 'AUTO (regenerate)')?.note).toContain('lydian');
    },
    SLOW,
  );
});

describe('data folder and diagnostics', () => {
  it(
    'keeps the data folder under OTCP_TARGET_DATA_DIR and names it in the report; none without it',
    async () => {
      const parent = await tmp();
      const kept = await runSmoke({ ...config('smoke'), exe: { ...config('smoke').exe, dataDirParent: parent } });
      expect(kept.result).toBe('PASS');
      expect(kept.dataDir).toMatch(/^smoke-[A-Za-z0-9]{6}$/);
      expect(readdirSync(parent)).toEqual([kept.dataDir]);
      expect(existsSync(path.join(parent, kept.dataDir ?? '', 'logs', 'opentune.log'))).toBe(true);
      expect(kept.steps.at(-1)?.note).toContain('kept');
      expect(formatTable(kept)).toContain(`data folder (under OTCP_TARGET_DATA_DIR): ${kept.dataDir ?? ''}`);
      expect(JSON.stringify(kept)).not.toContain(parent);
      expect(kept.busyDiagnostics).toBeNull();

      const temporary = await runSmoke(config('smoke'));
      expect(temporary.dataDir).toBeNull();
      expect(temporary.steps.at(-1)?.note).toBe('stopped, data folder removed');
      expect(formatTable(temporary)).not.toContain('data folder (under');
    },
    SLOW,
  );

  it(
    'copies the template folder into the data folder before the launch',
    async () => {
      const tpl = await tmp();
      await writeFile(path.join(tpl, 'state.txt'), 'known');
      const parent = await tmp();
      const base = config('smoke');
      const report = await runSmoke({ ...base, exe: { ...base.exe, dataDirParent: parent, dataTemplate: tpl } });
      expect(report.result).toBe('PASS');
      expect(report.templateSkipped).toBe(0);
      const [kept] = readdirSync(parent);
      expect(await readFile(path.join(parent, kept ?? '', 'state.txt'), 'utf8')).toBe('known');
      // A template that holds a ready file: it is left out of the copy, and the report says so.
      await writeFile(path.join(tpl, 'ready.json'), '{"pid":1}\n');
      const skipped = await runSmoke({ ...base, exe: { ...base.exe, dataTemplate: tpl } });
      expect(skipped.result).toBe('PASS');
      expect(skipped.templateSkipped).toBe(1);
    },
    SLOW,
  );

  it(
    'says in the note that a modal dialog is open, and records what ui.getState reports',
    async () => {
      const report = await runSmoke(config('smoke-busy'));
      expect(report.result).toBe('FAIL');
      const step = report.steps.find((s) => s.name === 'import and analysis');
      expect(step?.result).toBe('FAIL');
      expect(step?.note).toContain('the instance has a modal dialog open (BUSY modal_open)');
      expect(step?.note).toContain('"modalOpen":true');
      expect(step?.note).toContain('"showing":true');
      expect(step?.note).toContain('message "Welcome"');
      expect(report.busyDiagnostics).toContain('ui.getState: busy');
      expect(report.steps.at(-1)).toMatchObject({ name: 'shutdown', result: 'PASS' });
    },
    SLOW,
  );

  it(
    'does not call a method the instance did not report: without ui.bridge only the note is written',
    async () => {
      const report = await runSmoke(config('smoke-busy-nobridge'));
      const step = report.steps.find((s) => s.name === 'import and analysis');
      expect(step?.note).toContain('modal dialog open');
      expect(report.busyDiagnostics).toBe('the instance does not report ui.bridge, so ui.getState was not called');
    },
    SLOW,
  );

  it('folds paths under a user folder in a dialog title to <home> and cuts the title short', () => {
    expect(safeTitle('Save C:\\Users\\username\\Music\\take1.wav?')).toBe('Save <home>\\Music\\take1.wav?');
    expect(safeTitle('c:/users/username/x')).toBe('<home>/x');
    expect(safeTitle('Open /Users/username/Music/a.wav')).toBe('Open <home>/Music/a.wav');
    expect(safeTitle('/home/username/.config/x')).toBe('<home>/.config/x');
    expect(safeTitle('[/home/username/x]')).toBe('[<home>/x]');
    expect(safeTitle('/mnt/c/Users/username/Music/a.wav')).toBe('<home>/Music/a.wav');
    expect(safeTitle('Open file:///home/username/a.wav')).toBe('Open file://<home>/a.wav');
    expect(safeTitle('/opt/home/x')).toBe('/opt/home/x');
    expect(safeTitle('Welcome to OpenTune')).toBe('Welcome to OpenTune');
    expect(safeTitle('x'.repeat(100))).toHaveLength(60);
    expect(safeTitle(undefined)).toBe('undefined');
  });

  it('classifies BUSY modal_open apart from other errors', () => {
    const busy = (reason: string) =>
      new OtcpError({ kind: 'BUSY', reason, detail: 'x', retryable: true, executed: false });
    expect(isModalBusy(busy('modal_open'))).toBe(true);
    expect(isModalBusy(busy('pointer_down'))).toBe(false);
    expect(classify(busy('modal_open')).note).toContain('modal dialog open');
    expect(classify(busy('pointer_down')).note).not.toContain('modal dialog');
  });
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
  return spawnSync(
    process.execPath,
    [VITEST, 'run', '--project', 'e2e', 'test/e2e/exe-smoke.test.ts', '--reporter=verbose'],
    {
      cwd: ROOT,
      env: { ...clean, ...env },
      encoding: 'utf8',
      timeout: 80_000,
    },
  );
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
