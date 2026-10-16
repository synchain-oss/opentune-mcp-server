// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The end-to-end smoke scenario against a started OpenTune executable: start it, say hello, import
// a generated sung-like WAV and wait for its pitch analysis, run AUTO (regenerate), export the
// master mix, check the exported file and stop the instance. Every step is timed and gets one of
// four results; the whole run is a report (JSON) and a table.
//
// Results:
//   PASS        the step ran and its checks held;
//   FAIL        the step ran and something was wrong, or it could not be run for a reason that
//               is a defect (a model that is not installed, a timeout, a wrong result);
//   SKIP        the step could not be run, and nothing is wrong: the instance does not report a
//               capability the scenario needs, or an earlier step already failed;
//   FLAKY-SKIP  the step could not be run for a reason that belongs to the machine and that the
//               specification allows: the inference backend cannot be initialised (the error
//               MODEL_UNAVAILABLE with reason backend_unavailable). Nothing else is classified
//               this way; a real failure is never turned into a FLAKY-SKIP.
//
// The instance is started and ended by the exe target (test/contract/exe-target.ts): a data folder
// of its own, the process it started, and only a process it can confirm to be its own.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { parseDiscoveryFile } from '../../src/discovery/file.js';
import { OtcpError, errorDataFrom } from '../../src/errors/tool-error.js';
import { OtcpSession, type HelloInfo, type Json } from '../../src/otcp/client.js';
import { exeConfigFromEnv, exeTarget, type ExeTarget, type ExeTargetOptions } from '../contract/exe-target.js';
import type { TargetInstance } from '../contract/target.js';
import { generateTone, writeToneFiles, type Tone, type ToneFiles } from '../support/harmonic-tone.js';

export type StepResult = 'PASS' | 'FAIL' | 'SKIP' | 'FLAKY-SKIP';
export const RESULTS: readonly StepResult[] = ['PASS', 'FAIL', 'SKIP', 'FLAKY-SKIP'];

export interface StepReport {
  readonly name: string;
  readonly result: StepResult;
  /** Wall-clock time of the step, in milliseconds. */
  readonly ms: number;
  /** Why, for everything but a plain PASS; for a PASS, a short fact about what was checked. */
  readonly note: string;
}

export interface SmokeReport {
  readonly schema: 'opentune-mcp-e2e-exe/1';
  /** FAIL if any step failed, else FLAKY-SKIP / SKIP if any step was skipped, else PASS. */
  readonly result: StepResult;
  readonly counts: Readonly<Record<StepResult, number>>;
  readonly startedAt: string;
  readonly totalMs: number;
  readonly steps: readonly StepReport[];
  /** What the instance reported in its session.hello; null when the scenario never got that far. */
  readonly instance: { readonly protocol: string; readonly appVersion: string } | null;
  /** The audio the scenario generated and what came back; null before it exists. */
  readonly audio: Readonly<Record<string, number | string | boolean>> | null;
  /**
   * The name of the data folder of this launch, relative to OTCP_TARGET_DATA_DIR, for finding the
   * instance's logs there; null when that variable was not set (the folder was temporary and is gone).
   */
  readonly dataDir: string | null;
  /** What the instance said about being busy after a step got BUSY (modal_open); null if that never happened. */
  readonly busyDiagnostics: string | null;
}

export interface SmokeConfig {
  readonly exe: ExeTargetOptions;
  /** How long one wait (analysis, a job, a retryable NOT_READY) may take; 180 s unless given. */
  readonly stepTimeoutMs: number;
  /** Where the JSON report goes; none unless given. */
  readonly reportPath: string | undefined;
}

export type SmokeSetup = { readonly skip: string } | { readonly config: SmokeConfig };

const DEFAULT_STEP_TIMEOUT_MS = 180_000;
const JOB_POLL_MS = 5000;
const REQUIRED_CAPABILITIES = ['session.v1', 'jobs.v1', 'read.v1', 'import.v1', 'edit.v1', 'export.v1'] as const;

/** Reads OTCP_TARGET_EXE (and its siblings), OTCP_E2E_REPORT and OTCP_E2E_STEP_TIMEOUT_MS. */
export function smokeSetupFromEnv(env: NodeJS.ProcessEnv = process.env): SmokeSetup {
  const exe = exeConfigFromEnv(env);
  if ('skip' in exe) return { skip: exe.skip };
  let stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS;
  const raw = env.OTCP_E2E_STEP_TIMEOUT_MS;
  if (raw !== undefined && raw !== '') {
    stepTimeoutMs = Number(raw);
    if (!Number.isInteger(stepTimeoutMs) || stepTimeoutMs <= 0) {
      throw new Error('OTCP_E2E_STEP_TIMEOUT_MS must be a positive integer');
    }
  }
  const report = env.OTCP_E2E_REPORT;
  if (report !== undefined && report !== '' && !path.isAbsolute(report)) {
    throw new Error('OTCP_E2E_REPORT must be an absolute path');
  }
  return {
    config: { exe: exe.options, stepTimeoutMs, reportPath: report === undefined || report === '' ? undefined : report },
  };
}

// ---------------------------------------------------------------------------------------------
// results

/** Thrown inside a step to end it with a result other than PASS or FAIL. */
class StepSkip extends Error {
  constructor(
    readonly result: 'SKIP' | 'FLAKY-SKIP',
    note: string,
  ) {
    super(note);
  }
}

/** Never lets a long hex run (a token or proof, should an instance echo one) reach a report. */
const clean = (text: string) => text.replace(/[0-9a-fA-F]{32,}/g, '[redacted]').slice(0, 400);

/** Whether the error is BUSY with the reason modal_open: a dialog is open in the instance. */
export const isModalBusy = (error: unknown): boolean =>
  error instanceof OtcpError && error.data.kind === 'BUSY' && error.data.reason === 'modal_open';

/** The result and the note for an error that ended a step. */
export function classify(error: unknown): { result: StepResult; note: string } {
  if (error instanceof StepSkip) return { result: error.result, note: error.message };
  if (error instanceof OtcpError) {
    const { kind, reason, detail } = error.data;
    if (kind === 'MODEL_UNAVAILABLE' && reason === 'backend_unavailable') {
      return {
        result: 'FLAKY-SKIP',
        note: clean(`the inference backend could not be initialised on this machine: ${detail}`),
      };
    }
    if (isModalBusy(error)) {
      return {
        result: 'FAIL',
        note: clean(`the instance has a modal dialog open (BUSY modal_open), so it refused the call: ${detail}`),
      };
    }
    return { result: 'FAIL', note: clean(`${error.message}: ${detail}`) };
  }
  return { result: 'FAIL', note: clean(error instanceof Error ? error.message : String(error)) };
}

export function summarise(steps: readonly StepReport[]): Pick<SmokeReport, 'result' | 'counts'> {
  const counts: Record<StepResult, number> = { PASS: 0, FAIL: 0, SKIP: 0, 'FLAKY-SKIP': 0 };
  for (const step of steps) counts[step.result]++;
  let result: StepResult = 'PASS';
  if (counts.FAIL > 0) result = 'FAIL';
  else if (counts['FLAKY-SKIP'] > 0) result = 'FLAKY-SKIP';
  else if (counts.SKIP > 0) result = 'SKIP';
  return { result, counts };
}

/** The table printed to the test output (Markdown). */
export function formatTable(report: SmokeReport): string {
  const rows = report.steps.map(
    (s) => `| ${s.name} | ${s.result} | ${(s.ms / 1000).toFixed(2)} s | ${s.note.replaceAll('|', '/')} |`,
  );
  const counts = RESULTS.map((r) => `${r} ${String(report.counts[r])}`).join(', ');
  return [
    '| step | result | time | note |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `${report.result} (${counts}) in ${(report.totalMs / 1000).toFixed(1)} s`,
    ...(report.dataDir === null ? [] : [`data folder (under OTCP_TARGET_DATA_DIR): ${report.dataDir}`]),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// the report file

/** Writes the report where OTCP_E2E_REPORT says; the folder is created if needed. */
export function writeReport(file: string, report: SmokeReport): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// helpers on untyped results

/** The scales `keyInput.scale` takes (common.schema.json); the key of a content may name others. */
const KEY_INPUT_SCALES: readonly string[] = [
  'major',
  'minor',
  'chromatic',
  'harmonicMinor',
  'dorian',
  'mixolydian',
  'pentatonicMajor',
  'pentatonicMinor',
];

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function member(value: unknown, name: string, what: string): unknown {
  if (!isObject(value) || !(name in value)) throw new Error(`${what} has no ${name}`);
  return value[name];
}
function text(value: unknown, name: string, what: string): string {
  const v = member(value, name, what);
  if (typeof v !== 'string') throw new Error(`${what}.${name} is not a string`);
  return v;
}
function num(value: unknown, name: string, what: string): number {
  const v = member(value, name, what);
  if (typeof v !== 'number') throw new Error(`${what}.${name} is not a number`);
  return v;
}

/** The revision of `contentId` in the asOf block of a read result. */
function revisionOf(read: Json, contentId: string): string {
  const contents = member(member(read, 'asOf', 'the read result'), 'contents', 'asOf');
  if (!Array.isArray(contents)) throw new Error('asOf.contents is not an array');
  for (const entry of contents as unknown[]) {
    if (isObject(entry) && entry.contentId === contentId && typeof entry.revision === 'string') return entry.revision;
  }
  throw new Error('the read result carries no revision for the imported content');
}

/** Follows a job to its end; returns its result, or throws the error it failed with. */
async function waitJob(session: OtcpSession, jobId: string, what: string, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`the ${what} job did not finish within ${String(timeoutMs)} ms`);
    const waitMs = Math.min(JOB_POLL_MS, left);
    const reply = await session.call('job.get', { jobId, waitMs }, waitMs + 15_000);
    const job = member(reply, 'job', 'job.get result');
    const state = text(job, 'state', 'the job');
    if (state === 'succeeded') return member(job, 'result', 'the job');
    if (state === 'failed') {
      const error = member(job, 'error', 'the failed job');
      throw new OtcpError({ ...errorDataFrom(error), executed: null });
    }
    if (state === 'cancelled') throw new Error(`the ${what} job was cancelled`);
    // Not terminal yet: a server that answers at once (waitMs ignored) must not be spun on.
    if (waitMs > 0) await sleep(100);
  }
}

/** Starts a job-backed method and follows the job it hands over. */
async function runJob(
  session: OtcpSession,
  method: string,
  params: Json,
  what: string,
  timeoutMs: number,
): Promise<unknown> {
  const started = await session.call(method, params, 60_000);
  const job = member(started, 'job', `${method} result`);
  if (!isObject(job)) throw new Error(`${method} handed over no job`);
  return waitJob(session, text(job, 'jobId', 'the job'), what, timeoutMs);
}

// ---------------------------------------------------------------------------------------------
// the exported file

export interface WavFacts {
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly bits: number;
  readonly float: boolean;
  readonly durationSec: number;
  /** Largest absolute sample, 0..1 (more for a float file that clips). */
  readonly peak: number;
}

/** Reads the header and the samples of a PCM or IEEE-float WAV file. Throws on anything else. */
export function readWav(bytes: Buffer): WavFacts {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('the exported file is not a RIFF/WAVE file');
  }
  let fmt: { tag: number; channels: number; rate: number; bits: number } | undefined;
  let data: Buffer | undefined;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const body = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size));
    if (id === 'fmt ' && body.length >= 16) {
      let tag = body.readUInt16LE(0);
      if (tag === 0xfffe && body.length >= 26) tag = body.readUInt16LE(24);
      fmt = { tag, channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === 'data') {
      data = body;
    }
    at += 8 + size + (size % 2);
  }
  if (fmt === undefined || data === undefined) throw new Error('the exported file has no fmt or data chunk');
  const float = fmt.tag === 3;
  if (!float && fmt.tag !== 1) throw new Error(`the exported file has the unsupported format tag ${String(fmt.tag)}`);
  const width = fmt.bits / 8;
  if (fmt.channels < 1 || fmt.rate < 1 || ![2, 3, 4, 8].includes(width) || (float && width < 4)) {
    throw new Error('the exported file has an unsupported layout');
  }
  const samples = Math.floor(data.length / width);
  let peak = 0;
  for (let i = 0; i < samples; i++) {
    const at = i * width;
    let v: number;
    if (float) v = width === 4 ? data.readFloatLE(at) : data.readDoubleLE(at);
    else if (width === 2) v = data.readInt16LE(at) / 32768;
    else if (width === 3) v = data.readIntLE(at, 3) / 8388608;
    else v = data.readInt32LE(at) / 2147483648;
    peak = Math.max(peak, Math.abs(v));
  }
  return {
    sampleRateHz: fmt.rate,
    channels: fmt.channels,
    bits: fmt.bits,
    float,
    durationSec: samples / fmt.channels / fmt.rate,
    peak,
  };
}

// ---------------------------------------------------------------------------------------------
// the scenario

/** 8 notes of 1.1 s, each 30 cents sharp, so the source is about 10 s long and has pitch to correct. */
function makeTone(): Tone {
  return generateTone({
    seed: 20260401,
    notes: [0, 2, 4, 5, 7, 5, 4, 2].map((step) => ({
      midi: 57 + step,
      cents: 30,
      durationSec: 1.1,
    })),
  });
}

export interface SmokeHooks {
  /** For tests: replaces the target that starts the executable. */
  readonly target?: Pick<ExeTarget, 'open' | 'takeProblems'> & Partial<Pick<ExeTarget, 'labelNext' | 'takeDataDirs'>>;
}

/**
 * A dialog title is untrusted data and may hold a file path: a path under a user folder is folded
 * to <home>, then the title is cut short.
 */
export function safeTitle(title: unknown): string {
  return String(title)
    .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/]+/gi, '<home>')
    .replace(/\/mnt\/[a-z]\/Users\/[^/\s]+/gi, '<home>')
    .replace(/(^|[^A-Za-z0-9])\/(?:Users|home)\/[^/\s]+/g, '$1<home>')
    .slice(0, 60);
}

/**
 * What ui.getState says about the window (busy conditions, open dialogs, the first-run overlay),
 * as one line for the report. Called only after a BUSY modal_open, and only when the instance
 * reports ui.bridge; never throws. Dialog titles are untrusted data and are cut short.
 */
async function busyDiagnostics(session: OtcpSession | undefined): Promise<string> {
  if (session === undefined) return 'no session to ask for the window state';
  if (!session.hello.capabilities.includes('ui.bridge')) {
    return 'the instance does not report ui.bridge, so ui.getState was not called';
  }
  try {
    const state = await session.call('ui.getState', {}, 15_000);
    const busy = isObject(state.busy) ? state.busy : {};
    const onboarding = isObject(state.onboarding) ? state.onboarding : {};
    const dialogs = Array.isArray(state.dialogs) ? (state.dialogs as unknown[]) : [];
    const listed = dialogs
      .map((d) =>
        isObject(d) ? `${String(d.kind)} "${safeTitle(d.title)}" closeCommits=${String(d.closeCommits)}` : '?',
      )
      .join('; ');
    return clean(
      `ui.getState: busy ${JSON.stringify(busy)}; onboarding ${JSON.stringify(onboarding)}; ` +
        `${String(dialogs.length)} dialog(s)${listed === '' ? '' : ` [${listed}]`}`,
    );
  } catch (error) {
    return clean(`ui.getState failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function runSmoke(config: SmokeConfig, hooks: SmokeHooks = {}): Promise<SmokeReport> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const target = hooks.target ?? exeTarget(config.exe);
  const steps: StepReport[] = [];
  let halted: string | undefined;
  let instance: TargetInstance | undefined;
  let session: OtcpSession | undefined;
  let hello: HelloInfo | undefined;
  let files: ToneFiles | undefined;
  let tone: Tone | undefined;
  let audio: Record<string, number | string | boolean> | null = null;
  const timeoutMs = config.stepTimeoutMs;
  let diagnostics: string | null = null;
  target.labelNext?.('smoke');

  /** Runs a step unless an earlier one stopped the scenario; `always` steps (clean-up) run anyway. */
  const step = async (name: string, body: () => Promise<string>, always = false) => {
    if (halted !== undefined && !always) {
      steps.push({ name, result: 'SKIP', ms: 0, note: `not run: ${halted}` });
      return;
    }
    const at = performance.now();
    try {
      const note = await body();
      steps.push({ name, result: 'PASS', ms: performance.now() - at, note });
    } catch (error) {
      const classified = classify(error);
      const { result } = classified;
      let { note } = classified;
      if (isModalBusy(error)) {
        // One extra read-only call, to see what the window looks like; not part of the scenario.
        diagnostics = await busyDiagnostics(session);
        note = `${note}; ${diagnostics}`;
      }
      steps.push({ name, result, ms: performance.now() - at, note });
      halted ??= `${name} ended with ${result}`;
    }
  };

  let contentId = '';
  let source = '';
  let exportPath = '';
  let exportResult: unknown;

  await step('generate audio', async () => {
    tone = makeTone();
    files = await writeToneFiles(tone, 'smoke-source');
    source = files.wavPath;
    exportPath = path.join(files.dir, 'smoke-export.wav');
    audio = {
      sourceSeconds: Number(tone.truth.durationSec.toFixed(3)),
      sourceSampleRateHz: tone.truth.sampleRateHz,
    };
    return `${tone.truth.durationSec.toFixed(1)} s, ${String(tone.truth.sampleRateHz)} Hz, mono`;
  });

  await step('launch', async () => {
    instance = await target.open();
    return 'discovery file read, launch nonce and own hello checked';
  });

  await step('hello', async () => {
    if (instance === undefined) throw new Error('no instance');
    const entry = parseDiscoveryFile(
      `${String(instance.discovery.pid)}.json`,
      Buffer.from(JSON.stringify(instance.discovery), 'utf8'),
    );
    if (!entry.ok) throw new Error(`the discovery file is not valid: ${entry.problem}`);
    session = await OtcpSession.open(entry.entry, 15_000);
    hello = session.hello;
    const missing = REQUIRED_CAPABILITIES.filter((c) => !session?.hello.capabilities.includes(c));
    if (missing.length > 0) {
      throw new StepSkip('SKIP', `the instance does not report ${missing.join(', ')}, which the scenario needs`);
    }
    return `protocol ${hello.protocol}`;
  });

  await step('import and analysis', async () => {
    if (session === undefined) throw new Error('no session');
    const result = await runJob(
      session,
      'import.start',
      { items: [{ path: source }], layout: 'single' },
      'import',
      timeoutMs,
    );
    const items = member(result, 'items', 'the import result');
    const item: unknown = Array.isArray(items) ? (items as unknown[])[0] : undefined;
    if (!isObject(item) || item.imported !== true) {
      const error = isObject(item) && isObject(item.error) ? ` (${text(item.error, 'kind', 'error')})` : '';
      throw new Error(`the file was not imported${error}`);
    }
    contentId = text(item, 'contentId', 'the import item');
    // The job ends when the analysis has; a slower instance is waited for, a failed one is a failure.
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const details = await session.call('content.getDetails', { contentId }, 30_000);
      const state = text(member(details, 'analysis', 'content details'), 'f0State', 'analysis');
      if (state === 'ready') break;
      if (state === 'failed') throw new Error('the pitch analysis failed');
      if (state === 'notRequested') throw new Error('the instance did not start a pitch analysis (notRequested)');
      if (Date.now() >= deadline) throw new Error(`the pitch analysis was not ready within ${String(timeoutMs)} ms`);
      await sleep(500);
    }
    return 'imported, pitch analysis ready';
  });

  await step('AUTO (regenerate)', async () => {
    if (session === undefined) throw new Error('no session');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const details = await session.call('content.getDetails', { contentId }, 30_000);
      const key = member(details, 'key', 'content details');
      // The content's own key when the analysis found one and AUTO's closed scale list has its
      // scale (the key reports an open scale name); else the chromatic scale from C: every semitone.
      let keyNote = '';
      let keyInput: { root: number; scale: string } = { root: 0, scale: 'chromatic' };
      if (isObject(key)) {
        const scale = text(key, 'scale', 'key');
        if (KEY_INPUT_SCALES.includes(scale)) keyInput = { root: num(key, 'root', 'key'), scale };
        else keyNote = ` (the instance reports the scale ${scale}, which AUTO does not take: chromatic used)`;
      }
      try {
        let result: unknown = await session.call(
          'content.autoTune',
          { contentId, mode: 'regenerate', key: keyInput, expectedRevision: revisionOf(details, contentId) },
          120_000,
        );
        // The work may be handed to a job; the job's result then carries the counts.
        const handed = member(result, 'job', 'the AUTO result');
        if (isObject(handed)) {
          result = await waitJob(session, text(handed, 'jobId', 'the AUTO job'), 'AUTO', timeoutMs);
        }
        if (member(result, 'applied', 'the AUTO result') !== true)
          throw new Error('AUTO changed nothing (applied false)');
        const counts = member(result, 'noteCount', 'the AUTO result');
        const notes = isObject(counts)
          ? `${String(num(counts, 'after', 'noteCount'))} notes (before ${String(num(counts, 'before', 'noteCount'))})`
          : 'notes not counted';
        return `${notes} in ${keyInput.scale}${keyNote}`;
      } catch (error) {
        // The notes of a freshly imported clip may still be generated: retry while the instance says so.
        if (error instanceof OtcpError && error.data.kind === 'NOT_READY' && error.data.retryable) {
          if (Date.now() >= deadline)
            throw new Error(`the content was not ready for AUTO within ${String(timeoutMs)} ms`, { cause: error });
          await sleep(500);
          continue;
        }
        throw error;
      }
    }
  });

  await step('export', async () => {
    if (session === undefined) throw new Error('no session');
    exportResult = await runJob(
      session,
      'export.start',
      { kind: 'master', path: exportPath, ifExists: 'error' },
      'export',
      timeoutMs,
    );
    return 'master mix written';
  });

  await step('check exported file', async () => {
    if (tone === undefined) throw new Error('no source audio');
    const written = text(exportResult, 'path', 'the export result');
    const bytes = await readFile(written);
    if (bytes.length === 0) throw new Error('the exported file is empty');
    const wav = readWav(bytes);
    const reportedRate = num(exportResult, 'sampleRateHz', 'the export result');
    const reportedChannels = num(exportResult, 'channelCount', 'the export result');
    const dry = member(exportResult, 'dryContents', 'the export result');
    if (!Array.isArray(dry)) throw new Error('dryContents is not an array');
    const problems: string[] = [];
    if (wav.sampleRateHz < 8000 || wav.sampleRateHz > 384_000)
      problems.push(`sample rate ${String(wav.sampleRateHz)} Hz`);
    if (wav.sampleRateHz !== reportedRate) problems.push('the file and the export result disagree on the sample rate');
    if (wav.channels !== reportedChannels)
      problems.push('the file and the export result disagree on the channel count');
    if (wav.channels < 1 || wav.channels > 2) problems.push(`${String(wav.channels)} channels`);
    const source = tone.truth.durationSec;
    if (wav.durationSec < source - 0.5 || wav.durationSec > source + 3) {
      problems.push(`duration ${wav.durationSec.toFixed(2)} s for a ${source.toFixed(2)} s source`);
    }
    if (wav.peak <= 0) problems.push('the file is silent');
    if (dry.length > 0) problems.push(`${String(dry.length)} content(s) were exported uncorrected (dryContents)`);
    if (createHash('sha256').update(bytes).digest('hex') === tone.sha256) {
      problems.push('the exported file is identical to the source');
    }
    audio = {
      ...audio,
      exportSeconds: Number(wav.durationSec.toFixed(3)),
      exportSampleRateHz: wav.sampleRateHz,
      exportChannels: wav.channels,
      exportBits: wav.bits,
      exportPeak: Number(wav.peak.toFixed(4)),
      exportDryContents: dry.length,
    };
    if (problems.length > 0) throw new Error(problems.join('; '));
    return `${wav.durationSec.toFixed(1)} s, ${String(wav.sampleRateHz)} Hz, ${String(wav.channels)} ch, corrected`;
  });

  await step(
    'shutdown',
    async () => {
      session?.close();
      if (instance === undefined) return 'nothing was started';
      await instance.close();
      const problems = target.takeProblems();
      if (problems.length > 0) throw new Error(problems.join('; '));
      return target.takeDataDirs === undefined || config.exe.dataDirParent === undefined
        ? 'stopped, data folder removed'
        : 'stopped, data folder kept (see dataDir of the report)';
    },
    true,
  );
  await files?.cleanup();
  const dataDir = target.takeDataDirs?.()[0] ?? null;

  const ms = performance.now() - started;
  return {
    schema: 'opentune-mcp-e2e-exe/1',
    ...summarise(steps),
    startedAt,
    totalMs: Math.round(ms),
    steps: steps.map((s) => ({ ...s, ms: Math.round(s.ms) })),
    instance: hello === undefined ? null : { protocol: hello.protocol, appVersion: hello.appVersion },
    audio,
    dataDir,
    busyDiagnostics: diagnostics,
  };
}
