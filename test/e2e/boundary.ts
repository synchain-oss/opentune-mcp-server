// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The boundary scenario against one started OpenTune: what the happy-path smoke scenario never
// feeds it. Audio in a folder and under a file name that hold Chinese characters and spaces,
// silence, a file over the analysis limit, an undo and redo round trip, and paths the
// specification forbids, which must be refused before anything is written. Every step is timed
// and gets one of the smoke scenario's four results; the report is boundary.json next to
// OTCP_E2E_REPORT.
//
// The instance is started and ended by the exe target (test/contract/exe-target.ts), and the
// generated audio and exports live in a folder of this run, which is removed at the end.

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { parseDiscoveryFile } from '../../src/discovery/file.js';
import { OtcpError, errorDataFrom, type ErrorData } from '../../src/errors/tool-error.js';
import { OtcpSession, type Json } from '../../src/otcp/client.js';
import { exeTarget } from '../contract/exe-target.js';
import type { TargetInstance } from '../contract/target.js';
import { generateTone } from '../support/harmonic-tone.js';
import { wavFile } from '../support/wav-file.js';
import { removeDir, scratchDir } from './real-support.js';
import { Scenario, type ScenarioReport } from './scenario.js';
import { StepSkip, isObject, member, num, readWav, runJob, text, type SmokeConfig, type SmokeHooks } from './smoke.js';

export const SCENARIO_NAME = 'boundary';
const REQUIRED_CAPABILITIES = ['session.v1', 'jobs.v1', 'read.v1', 'import.v1', 'export.v1'] as const;

/** A sample rate and bit depth that make 601 s only about 4.8 MB, so the file stays small. */
const LONG_AUDIO = { seconds: 601, rate: 8000, bits: 8 } as const;

/** Compares two paths the way Windows does when it is Windows, so that a case change is no difference. */
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** One refused path: how it is spelled for the platform, and the reason the specification gives. */
interface Refusal {
  readonly label: string;
  readonly path: string;
  readonly reason: string;
}

export function refusals(refusedDir: string, relativeName: string): Refusal[] {
  const win = process.platform === 'win32';
  return [
    { label: 'relative', path: relativeName, reason: 'path_not_absolute' },
    ...(win
      ? [
          { label: 'UNC', path: '\\\\127.0.0.1\\ot-boundary\\refused.wav', reason: 'path_unc' },
          {
            label: 'alternate data stream',
            path: `${refusedDir}\\refused.wav:hidden.wav`,
            reason: 'path_alternate_stream',
          },
        ]
      : []),
    { label: 'extension .docx', path: path.join(refusedDir, 'refused.docx'), reason: 'path_bad_extension' },
  ];
}

async function importOne(session: OtcpSession, file: string, timeoutMs: number): Promise<Json> {
  const result = await runJob(
    session,
    'import.start',
    { items: [{ path: file }], layout: 'single' },
    'import',
    timeoutMs,
  );
  const items = member(result, 'items', 'the import result');
  const item: unknown = Array.isArray(items) ? (items as unknown[])[0] : undefined;
  if (!isObject(item)) throw new Error('the import result has no item');
  return item;
}

/** Polls the analysis of a content until it is ready or failed. */
async function settleAnalysis(session: OtcpSession, contentId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const details = await session.call('content.getDetails', { contentId }, 30_000);
    const state = text(member(details, 'analysis', 'content details'), 'f0State', 'analysis');
    if (state === 'ready' || state === 'failed') return state;
    if (state === 'notRequested') throw new Error('the instance did not start a pitch analysis (notRequested)');
    if (Date.now() >= deadline) throw new Error(`the pitch analysis was not settled within ${String(timeoutMs)} ms`);
    await sleep(500);
  }
}

async function placements(session: OtcpSession): Promise<Json[]> {
  const project = await session.call('project.get', {}, 30_000);
  const list = member(project, 'placements', 'the project');
  if (!Array.isArray(list)) throw new Error('project.placements is not an array');
  return (list as unknown[]).filter(isObject);
}

async function snapshot(session: OtcpSession, contentId: string): Promise<string> {
  const details = await session.call('content.getDetails', { contentId }, 30_000);
  const notes = await session.call('content.getNotes', { contentId }, 30_000);
  return JSON.stringify({ pitchShift: member(details, 'pitchShift', 'content details'), notes: notes.notes ?? null });
}

/** The error an OTCP call ended with, or null when it succeeded. */
async function failureOf(call: Promise<unknown>): Promise<ErrorData | null> {
  try {
    await call;
    return null;
  } catch (error) {
    if (error instanceof OtcpError) return error.data;
    throw error;
  }
}

export async function runBoundary(config: SmokeConfig, hooks: SmokeHooks = {}): Promise<ScenarioReport> {
  const target = hooks.target ?? exeTarget(config.exe);
  const timeoutMs = config.stepTimeoutMs;
  const scenario = new Scenario(SCENARIO_NAME);
  target.labelNext?.(SCENARIO_NAME);

  let root = '';
  let toneFile = '';
  let silentFile = '';
  let longFile = '';
  let exportDir = '';
  let refusedDir = '';
  let instance: TargetInstance | undefined;
  let session: OtcpSession | undefined;
  const capabilities = new Set<string>();
  let toneContent = '';
  let tonePlacement = '';
  let silentContent = '';
  let relativeName = '';

  const need = (): OtcpSession => {
    if (session === undefined) throw new Error('no session');
    return session;
  };

  await scenario.step('generate audio', async () => {
    root = await scratchDir(SCENARIO_NAME);
    // Chinese characters and an inner space in the folder and in the file name.
    const audioDir = path.join(root, '人声 目录 一');
    exportDir = path.join(root, '导出 目录 一');
    refusedDir = path.join(root, 'refused');
    await Promise.all([audioDir, exportDir, refusedDir].map((dir) => mkdir(dir, { recursive: true })));
    const tone = generateTone({
      seed: 20260401,
      notes: [0, 2, 4, 5].map((step) => ({ midi: 57 + step, cents: 30, durationSec: 1.1 })),
    });
    toneFile = path.join(audioDir, '人声 一.wav');
    silentFile = path.join(audioDir, '静音 一.wav');
    longFile = path.join(root, 'long-601s.wav');
    relativeName = `ot-boundary-relative-${String(process.pid)}.wav`;
    await writeFile(toneFile, tone.wav);
    await writeFile(silentFile, wavFile({ seconds: 3, rate: 44_100, voiced: false }));
    const long = wavFile({ ...LONG_AUDIO });
    await writeFile(longFile, long);
    scenario.facts.longAudioBytes = long.length;
    return `${tone.truth.durationSec.toFixed(1)} s tone, 3 s silence and a ${String(LONG_AUDIO.seconds)} s file (${(long.length / 1e6).toFixed(1)} MB), in folders with Chinese names and spaces`;
  });

  await scenario.step(
    'launch',
    async () => {
      instance = await target.open();
      return 'discovery file read, launch nonce and own hello checked';
    },
    { haltOnSkip: true },
  );

  await scenario.step(
    'hello',
    async () => {
      if (instance === undefined) throw new Error('no instance');
      const entry = parseDiscoveryFile(
        `${String(instance.discovery.pid)}.json`,
        Buffer.from(JSON.stringify(instance.discovery), 'utf8'),
      );
      if (!entry.ok) throw new Error(`the discovery file is not valid: ${entry.problem}`);
      session = await OtcpSession.open(entry.entry, 15_000);
      for (const c of session.hello.capabilities) capabilities.add(c);
      const missing = REQUIRED_CAPABILITIES.filter((c) => !capabilities.has(c));
      if (missing.length > 0) {
        throw new StepSkip('SKIP', `the instance does not report ${missing.join(', ')}, which the scenario needs`);
      }
      return `protocol ${session.hello.protocol}`;
    },
    { haltOnSkip: true },
  );

  await scenario.step('Chinese and spaced paths: import and export round trip', async () => {
    const s = need();
    const item = await importOne(s, toneFile, timeoutMs);
    if (item.imported !== true) {
      const error = isObject(item.error) ? ` (${text(item.error, 'kind', 'error')})` : '';
      throw new Error(`the file in the Chinese folder was not imported${error}`);
    }
    toneContent = text(item, 'contentId', 'the import item');
    tonePlacement = text(item, 'placementId', 'the import item');
    if ((await settleAnalysis(s, toneContent, timeoutMs)) !== 'ready') throw new Error('the pitch analysis failed');
    const clip = (await placements(s)).find((p) => p.placementId === tonePlacement);
    if (clip === undefined) throw new Error('the imported clip is not in project.get');
    const sourcePath = text(clip, 'sourcePath', 'the clip');
    if (!samePath(sourcePath, toneFile)) throw new Error('project.get names another source file than the one imported');

    const wanted = path.join(exportDir, '结果 一.wav');
    const exported = await runJob(
      s,
      'export.start',
      { kind: 'master', path: wanted, ifExists: 'error' },
      'export',
      timeoutMs,
    );
    const written = text(exported, 'path', 'the export result');
    if (!samePath(written, wanted)) throw new Error('the export result names another path than the one asked for');
    const names = await readdir(exportDir);
    if (names.length !== 1) throw new Error(`the export folder holds ${String(names.length)} files, not one`);
    const wav = readWav(await readFile(wanted));
    if (wav.durationSec <= 0) throw new Error('the exported file holds no audio');
    return `imported from, and exported to, a Chinese folder with spaces; ${wav.durationSec.toFixed(1)} s read back`;
  });

  await scenario.step('silent WAV: clip kept, analysis outcome reported', async () => {
    const s = need();
    const before = (await placements(s)).length;
    const item = await importOne(s, silentFile, timeoutMs);
    if (item.imported !== true) throw new Error('the silent file was not imported at all, so no clip was kept');
    silentContent = text(item, 'contentId', 'the import item');
    const itemState = String(item.f0State);
    const error = isObject(item.error) ? text(item.error, 'kind', 'error') : null;
    const settled = await settleAnalysis(s, silentContent, timeoutMs);
    const after = await placements(s);
    if (after.length !== before + 1 || !after.some((p) => p.contentId === silentContent)) {
      throw new Error('the clip of the silent file is not in project.get');
    }
    scenario.facts.silentItemF0State = itemState;
    scenario.facts.silentItemError = error;
    scenario.facts.silentSettledF0State = settled;
    if (settled === 'failed' && error !== 'ANALYSIS_FAILED') {
      throw new Error(`the analysis failed but the item error is ${error ?? 'null'}, not ANALYSIS_FAILED`);
    }
    return settled === 'failed'
      ? 'ANALYSIS_FAILED, the clip stays in the project'
      : `the analysis ended ${settled} (no voiced audio); the clip stays in the project`;
  });

  await scenario.step('master export lists the silent clip in dryContents', async () => {
    const s = need();
    const exported = await runJob(
      s,
      'export.start',
      { kind: 'master', path: path.join(exportDir, '混合 含静音.wav'), ifExists: 'error', allowDry: true },
      'export',
      timeoutMs,
    );
    const dry = member(exported, 'dryContents', 'the export result');
    if (!Array.isArray(dry)) throw new Error('dryContents is not an array');
    const entry = (dry as unknown[]).find((d) => isObject(d) && d.contentId === silentContent);
    if (!isObject(entry)) throw new Error('the silent clip is not listed in dryContents');
    scenario.facts.silentDryReason = text(entry, 'reason', 'the dryContents entry');
    return `listed in dryContents (${text(entry, 'reason', 'the dryContents entry')})`;
  });

  await scenario.step(
    '601 s, 8 kHz, 8 bit WAV: audio_too_long with the limit',
    async () => {
      const s = need();
      const info = await s.call('session.info', {}, 15_000);
      const limit = num(member(info, 'import', 'session.info'), 'maxAnalysisSec', 'session.info import');
      const before = (await placements(s)).length;
      // The specification reports a file that fails as an item of the finished job; an instance that
      // refuses the whole call instead gives the same error, so both are read.
      let failure: ErrorData | undefined;
      try {
        const result = await runJob(
          s,
          'import.start',
          { items: [{ path: longFile }], layout: 'single' },
          'import',
          timeoutMs,
        );
        const items = member(result, 'items', 'the import result');
        const item: unknown = Array.isArray(items) ? (items as unknown[])[0] : undefined;
        if (!isObject(item) || item.imported === true || !isObject(item.error)) {
          throw new Error('the over-long file was accepted by the import job');
        }
        failure = errorDataFrom(item.error);
      } catch (error) {
        if (!(error instanceof OtcpError)) throw error;
        failure = error.data;
      }
      if (failure.kind !== 'INVALID_ARGUMENT' || failure.reason !== 'audio_too_long') {
        throw new Error(`expected INVALID_ARGUMENT(audio_too_long), got ${failure.kind}(${failure.reason ?? 'null'})`);
      }
      if ((await placements(s)).length !== before) throw new Error('a clip was imported for the over-long file');
      scenario.facts.maxAnalysisSec = limit;
      scenario.facts.audioTooLongNamesLimit = failure.detail.includes(String(limit));
      if (!failure.detail.includes(String(limit))) {
        throw new Error(`the error does not name the limit (${String(limit)} s); its detail is: ${failure.detail}`);
      }
      return `INVALID_ARGUMENT(audio_too_long), limit ${String(limit)} s named, nothing imported`;
    },
    { haltOnFail: false },
  );

  await scenario.step('undo and redo round trip restores the read-back state', async () => {
    const s = need();
    const missing = ['edit.v1', 'history.v1'].filter((c) => !capabilities.has(c));
    if (missing.length > 0) throw new StepSkip('SKIP', `the instance does not report ${missing.join(', ')}`);
    const before = await snapshot(s, toneContent);
    const written = await s.call(
      'content.setPitchShift',
      { contentId: toneContent, pitchShift: { semitones: 2, cents: 0 } },
      60_000,
    );
    const undo = member(written, 'undo', 'the write result');
    const undoId = text(undo, 'undoId', 'the undo recipe');
    const after = await snapshot(s, toneContent);
    if (after === before) throw new Error('the pitch shift changed nothing the read-back shows');
    await s.call('edit.undo', { expectedUndoId: undoId }, 60_000);
    if ((await snapshot(s, toneContent)) !== before)
      throw new Error('after undo the read-back differs from before the edit');
    await s.call('edit.redo', { expectedUndoId: undoId }, 60_000);
    if ((await snapshot(s, toneContent)) !== after)
      throw new Error('after redo the read-back differs from after the edit');
    return 'undo restored the snapshot before the edit, redo the one after it';
  });

  await scenario.step('forbidden paths are refused and nothing is written', async () => {
    const s = need();
    const outside = path.resolve(relativeName);
    const problems: string[] = [];
    const cases = refusals(refusedDir, relativeName);
    for (const { label, path: bad, reason } of cases) {
      const failure = await failureOf(s.call('export.start', { kind: 'master', path: bad, ifExists: 'error' }, 30_000));
      if (failure === null) problems.push(`${label}: accepted`);
      else if (failure.kind !== 'INVALID_ARGUMENT' || failure.reason !== reason) {
        problems.push(`${label}: ${failure.kind}(${failure.reason ?? 'null'}), expected INVALID_ARGUMENT(${reason})`);
      }
    }
    // Give a wrongly accepted job the time to write something before looking.
    await sleep(1000);
    const leftovers = await readdir(refusedDir);
    if (leftovers.length > 0) problems.push(`the target folder holds ${String(leftovers.length)} new file(s)`);
    if (existsSync(outside)) {
      problems.push('a file appeared at the relative path, in the working directory of the test run');
      await removeDir(outside);
    }
    if (problems.length > 0) throw new Error(problems.join('; '));
    return `${cases.map((c) => c.label).join(', ')}: INVALID_ARGUMENT, no file written`;
  });

  await scenario.step(
    'shutdown',
    async () => {
      session?.close();
      const notes: string[] = [];
      if (instance !== undefined) {
        await instance.close();
        const problems = target.takeProblems();
        if (problems.length > 0) notes.push(problems.join('; '));
      }
      if (root !== '') {
        try {
          await removeDir(root);
        } catch {
          notes.push('the scratch folder could not be removed');
        }
      }
      if (notes.length > 0) throw new Error(notes.join('; '));
      return instance === undefined ? 'nothing was started' : 'stopped, scratch folder removed';
    },
    { always: true },
  );

  return scenario.report();
}
