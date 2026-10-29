// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The beat-grid skill: its manifest, the installer (dry-run text, the released:false refusal, the
// checksum rollback), the analyzer wrapper against a fake CLI, and the timing plan on synthetic
// grids and notes. Nothing here reaches the network or a real opentune-beats build.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

import { zipStored } from '../../scripts/mcpb.mjs';
import { pluginSourceFiles } from '../../scripts/plugin.mjs';
import { UPLOAD_SKILLS } from '../../scripts/skills-zip.mjs';
import { REPO } from '../support/plugin-tree.js';
import * as beatGridModule from '../../plugins/opentune/skills/beat-grid/scripts/beat-grid.mjs';

type Json = Record<string, unknown>;
interface ManifestAsset {
  asset: string;
  url: string;
  sha256: string;
  format?: string;
  approxBytes: number;
}
interface Manifest {
  version: string;
  releaseTag: string;
  released: boolean;
  platforms: Record<string, ManifestAsset>;
  models: Record<string, ManifestAsset>;
  [key: string]: unknown;
}
interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  signal: string | null;
  error: string | null;
}
interface Segment {
  index: number;
  bpm: number;
  confidence: number;
}
interface Suggestion {
  noteIndex: number | null;
  deviationMs: number;
  adjustedDeviationMs: number;
  deltaMs: number;
  gridPoint: { kind: string; division: number; timelineSec: number };
  segment: Segment | null;
  op: Json | null;
}
interface TimingPlan {
  clock: { gridToTimeline: string; placementOffsetSec: number | null };
  notes: { pages: number; used: number; clipRevision: string | null };
  globalOffsetMs: number | null;
  suggestions: Suggestion[];
  calls: { ops: Json[] }[];
  warnings: { code: string; detail?: string }[];
  counts: { flagged: number; calls: number; remainingSuggestions: number };
}
interface InstallPlan {
  problems: string[];
  released: boolean;
  totalBytes: number | null;
  target: string | null;
  version: string | null;
  assets: { kind: string; asset: string; approxBytes: number }[];
  otherModel: { name: string; totalBytes: number | null };
  installed: { version: string; target: string; dir: string; models: Record<string, boolean> } | null;
}
interface InstallResult {
  dir: string;
  executable: string;
  version: string;
  versionLine: string;
  model: string;
  models: { mel: boolean; final: boolean; small: boolean };
  bytes: number;
  replaced: boolean;
}
interface AnalyzeResult {
  ok: boolean;
  exitCode: number;
  json: Json;
  raw: string;
  summary?: {
    segments: { bpm: number; startSec: number; endSec: number; confidence: number }[];
    summary: { dominantBpm: number };
  };
}
interface StatusResult {
  installed: boolean;
  current: { version: string; target: string; dir: string } | null;
  installations: { version: string; target: string; dir: string }[];
  models: { mel: boolean; final: boolean; small: boolean };
  home: string | null;
  homeSource: string | null;
  homeError?: string;
  platform: { target: string | null; supported: boolean };
  download: Json | null;
  notes: string[];
}
interface BeatGridModule {
  BeatGridError: new (code: string, detail: string, exitCode?: number) => Error & { code: string; detail: string };
  DEFAULT_THRESHOLD_MS: number;
  DOWNLOAD_HOSTS: readonly string[];
  EXIT: { OK: number; USAGE: number; NOT_INSTALLED: number; INSTALL_FAILED: number; ANALYSIS_FAILED: number };
  analyze: (options: Json) => AnalyzeResult;
  compareVersions: (a: string, b: string) => number;
  currentInstallation: (home: string, manifest: Manifest, target: string) => { dir: string; executable: string } | null;
  dataHome: (env: Record<string, string | undefined>, homeOption?: string | null) => { home: string; source: string };
  detectTarget: (platform?: string, arch?: string) => string | null;
  downloadAsset: (url: string, dest: string, sha: string, what: string, options?: Json) => Promise<string>;
  executableName: (target: string) => string;
  extractTarGz: (bytes: Buffer, dest: string) => void;
  extractZip: (bytes: Buffer, dest: string) => void;
  formatPlan: (plan: InstallPlan) => string;
  install: (options: Json) => Promise<InstallResult>;
  installDir: (home: string, manifest: Manifest, target: string) => string;
  installPlan: (options: Json) => InstallPlan;
  loadManifest: (file?: string) => Manifest;
  main: (argv: string[], options?: Json) => Promise<number>;
  manifestProblems: (manifest: unknown) => string[];
  parseArgs: (argv: string[]) => { command: string; options: Record<string, unknown>; positionals: string[] };
  parseVersionOutput: (text: string) => { version: string; line: string } | null;
  runProcess: (command: string, args: string[], options?: Json) => RunResult;
  status: (options?: Json) => StatusResult;
  timingPlan: (options: Json) => TimingPlan;
}

const {
  BeatGridError,
  DEFAULT_THRESHOLD_MS,
  DOWNLOAD_HOSTS,
  EXIT,
  analyze,
  compareVersions,
  currentInstallation,
  dataHome,
  detectTarget,
  downloadAsset,
  executableName,
  extractTarGz,
  extractZip,
  formatPlan,
  install,
  installDir,
  installPlan,
  loadManifest,
  main,
  manifestProblems,
  parseArgs,
  parseVersionOutput,
  runProcess,
  status,
  timingPlan,
} = beatGridModule as unknown as BeatGridModule;

const SKILL = path.resolve(import.meta.dirname, '../../plugins/opentune/skills/beat-grid');
const MANIFEST_FILE = path.join(SKILL, 'scripts/manifest.json');

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function asset(map: Record<string, ManifestAsset>, key: string): ManifestAsset {
  const value = map[key];
  if (value === undefined) throw new Error(`the test manifest has no ${key}`);
  return value;
}

function bufferOf(files: Record<string, Buffer>, key: string): Buffer {
  const value = files[key];
  if (value === undefined) throw new Error(`the test wrote no ${key}`);
  return value;
}

function firstSuggestion(plan: TimingPlan): Suggestion {
  const value = plan.suggestions[0];
  if (value === undefined) throw new Error('the plan has no suggestion');
  return value;
}

/** A fake fetch response with an async-iterable body and whatever final URL the test wants. */
function fakeFetchResponse(bytes: Buffer | string, url: unknown) {
  const chunk = Buffer.from(bytes);
  return {
    ok: true,
    status: 200,
    url,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

/** The code of the BeatGridError a download throws. */
async function downloadErrorCode(promise: Promise<unknown>): Promise<string> {
  const caught = await promise.catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(BeatGridError);
  return (caught as { code: string }).code;
}

/** A released copy of the manifest with every asset pinned to bytes this test controls. */
function releasedManifest(files: Record<string, Buffer>, version = '0.1.0'): Manifest {
  const manifest = JSON.parse(JSON.stringify(loadManifest(MANIFEST_FILE))) as Manifest;
  manifest.released = true;
  manifest.version = version;
  manifest.releaseTag = `v${version}`;
  for (const target of Object.keys(manifest.platforms)) {
    const entry = asset(manifest.platforms, target);
    entry.asset = `opentune-beats-${version}-${target}.${entry.format === 'zip' ? 'zip' : 'tar.gz'}`;
    entry.url = `https://github.com/synchain-oss/opentune-beats/releases/download/v${version}/${entry.asset}`;
    const bytes = files[entry.asset];
    entry.sha256 = bytes === undefined ? '0'.repeat(64) : sha256(bytes);
  }
  for (const name of Object.keys(manifest.models)) {
    const entry = asset(manifest.models, name);
    entry.url = `https://github.com/synchain-oss/opentune-beats/releases/download/v${version}/${entry.asset}`;
    const bytes = files[entry.asset];
    entry.sha256 = bytes === undefined ? '0'.repeat(64) : sha256(bytes);
  }
  return manifest;
}

/**
 * The shipped manifest turned back into one for a release that is not published: marked unreleased, no sha256.
 * The installer keeps refusing such a manifest, and these tests keep that refusal covered.
 */
function unreleasedManifest(): Manifest {
  const manifest = JSON.parse(JSON.stringify(loadManifest(MANIFEST_FILE))) as Manifest;
  manifest.released = false;
  for (const entry of [...Object.values(manifest.platforms), ...Object.values(manifest.models)]) entry.sha256 = '';
  return manifest;
}

/** A fake analyzer: a Node script that prints fixed JSON and exits 0. */
function fakeAnalyzer({ grid, exitCode = 0, stderr = '' }: { grid?: Json; exitCode?: number; stderr?: string } = {}) {
  return [
    '#!/usr/bin/env node',
    `process.stdout.write(${JSON.stringify(JSON.stringify(grid ?? {}))});`,
    stderr === '' ? '' : `process.stderr.write(${JSON.stringify(stderr)});`,
    `process.exitCode = ${String(exitCode)};`,
    '',
  ].join('\n');
}

function fakeGrid(): Json {
  return {
    schemaVersion: 1,
    tool: { name: 'opentune-beats', version: '0.1.0', beatThis: '1.1.0' },
    model: { name: 'final', file: 'beat_this_final.onnx', sha256: 'a'.repeat(64), melSha256: 'b'.repeat(64) },
    input: { fileName: 'backing.wav', durationSec: 8, sampleRateHz: 44100, channels: 2 },
    params: { refine: true, maxRefineMs: 30, minSegmentBeats: 8, frameSec: 0.02 },
    beats: [
      { index: 0, timeSec: 0.5, rawTimeSec: 0.51, confidence: 0.9, isDownbeat: true, bar: 1, beatInBar: 1, segment: 0 },
      {
        index: 1,
        timeSec: 1.0,
        rawTimeSec: 1.01,
        confidence: 0.9,
        isDownbeat: false,
        bar: 1,
        beatInBar: 2,
        segment: 0,
      },
      {
        index: 2,
        timeSec: 1.5,
        rawTimeSec: 1.51,
        confidence: 0.9,
        isDownbeat: false,
        bar: 1,
        beatInBar: 3,
        segment: 0,
      },
    ],
    segments: [
      {
        index: 0,
        startSec: 0,
        endSec: 8,
        firstBeat: 0,
        lastBeat: 2,
        bpm: 120,
        beatPeriodSec: 0.5,
        timeSignature: { numerator: 4, denominator: 4 },
        timeSignatureCandidates: [{ numerator: 4, denominator: 4, score: 0.9 }],
        confidence: 0.9,
        fitResidualMs: { median: 1, p95: 3 },
        octaveNote: null,
      },
    ],
    tempoChanges: [],
    refinement: { applied: true, globalOffsetMs: 0, medianAdjustMs: 0, p95AdjustMs: 2 },
    summary: { beats: 3, downbeats: 1, segments: 1, dominantBpm: 120, lowConfidenceSegments: [] },
    warnings: [],
  };
}

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-beats-'));
  return {
    dir,
    remove: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Writes a fake install of the manifest's version into the data folder. */
function fakeInstall(home: string, manifest: Manifest, target: string, { grid }: { grid?: Json } = {}) {
  const dir = installDir(home, manifest, target);
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  const executable = path.join(dir, executableName(target));
  fs.writeFileSync(executable, fakeAnalyzer(grid === undefined ? {} : { grid }));
  fs.writeFileSync(path.join(dir, 'models', 'mel_spectrogram.onnx'), 'mel');
  fs.writeFileSync(path.join(dir, 'models', 'beat_this_final.onnx'), 'final');
  if (target !== 'win-x64') fs.chmodSync(executable, 0o755);
  return dir;
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const remove of cleanup.splice(0).reverse()) remove();
});

describe('the shipped manifest', () => {
  const manifest = loadManifest(MANIFEST_FILE);

  it('is part of the plugin with its script and manifest, and stays out of the skills zip', async () => {
    const files = await pluginSourceFiles(REPO);
    expect(files).toContain('skills/beat-grid/SKILL.md');
    expect(files).toContain('skills/beat-grid/NOTICE');
    expect(files).toContain('skills/beat-grid/scripts/beat-grid.mjs');
    expect(files).toContain('skills/beat-grid/scripts/manifest.json');
    // The upload zip takes instruction-only skills; this one needs a local script and a download.
    expect(UPLOAD_SKILLS).not.toContain('beat-grid');
  });

  it('pins the tool, the release and one asset per platform and model', () => {
    expect(manifest.tool).toBe('opentune-beats');
    expect(manifest.repository).toBe('synchain-oss/opentune-beats');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(Object.keys(manifest.platforms).sort()).toEqual(['macos-universal2', 'win-x64']);
    expect(Object.keys(manifest.models).sort()).toEqual(['final', 'mel', 'small']);
    for (const entry of [...Object.values(manifest.platforms), ...Object.values(manifest.models)]) {
      expect(entry.asset).not.toBe('');
      expect(entry.url).toMatch(/^https:\/\/github\.com\/synchain-oss\/opentune-beats\/releases\/download\//);
      expect(entry.approxBytes).toBeGreaterThan(0);
    }
  });

  it('is marked released with every sha256 pinned to the published asset, and passes the manifest checks', () => {
    expect(manifest.released).toBe(true);
    for (const entry of [...Object.values(manifest.platforms), ...Object.values(manifest.models)]) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.url).toContain(`/releases/download/${manifest.releaseTag}/${entry.asset}`);
    }
    expect(manifestProblems(manifest)).toEqual([]);
  });

  it('turns red on a guessed hash while unreleased, a missing hash once released, and a foreign URL', () => {
    const unreleased = unreleasedManifest();
    expect(manifestProblems(unreleased)).toEqual([]);

    const guessed = JSON.parse(JSON.stringify(unreleased)) as Manifest;
    asset(guessed.models, 'final').sha256 = 'c'.repeat(64);
    expect(manifestProblems(guessed).join('\n')).toContain('must stay empty while manifest.released is false');

    const released = JSON.parse(JSON.stringify(unreleased)) as Manifest;
    released.released = true;
    expect(manifestProblems(released).join('\n')).toContain('must be filled in before the release is marked released');

    // The shipped manifest is marked released, so a hash that went missing from it is caught the same way.
    const lost = JSON.parse(JSON.stringify(manifest)) as Manifest;
    asset(lost.platforms, 'win-x64').sha256 = '';
    expect(manifestProblems(lost).join('\n')).toContain('must be filled in before the release is marked released');

    const foreign = JSON.parse(JSON.stringify(manifest)) as Manifest;
    asset(foreign.models, 'mel').url = 'https://example.com/mel_spectrogram.onnx';
    expect(manifestProblems(foreign).join('\n')).toContain('the pinned release asset');
  });

  it('plans the download of the published release without any problem', () => {
    const home = tempHome();
    cleanup.push(home.remove);
    const plan = installPlan({ manifest, target: 'win-x64', model: 'final', home: home.dir });
    expect(plan.problems).toEqual([]);
    expect(plan.released).toBe(true);
    const text = formatPlan(plan);
    expect(text).toContain('86 MB');
    expect(text).toContain('MIT');
    expect(text).not.toContain('not published yet');
  });

  it('says that the release does not exist yet in the plan, and refuses --yes, when the manifest says so', async () => {
    const unreleased = unreleasedManifest();
    const home = tempHome();
    cleanup.push(home.remove);
    const plan = installPlan({ manifest: unreleased, target: 'win-x64', model: 'final', home: home.dir });
    expect(plan.problems.join('\n')).toContain('is not published yet');
    const text = formatPlan(plan);
    expect(text).toContain('nothing has been downloaded');
    expect(text).toContain('86 MB');
    expect(text).toContain('MIT');
    expect(text).toContain('not published yet');
    await expect(install({ manifest: unreleased, home: home.dir, target: 'win-x64', model: 'final' })).rejects.toThrow(
      /not published yet/,
    );
    expect(fs.existsSync(path.join(home.dir, 'bin'))).toBe(false);
  });

  it('has no problem in the plan of an analyzer that is installed, whatever the release state is', () => {
    for (const state of [unreleasedManifest(), manifest]) {
      const home = tempHome();
      cleanup.push(home.remove);
      const empty = installPlan({ manifest: state, target: 'win-x64', model: 'final', home: home.dir });
      expect(empty.installed).toBeNull();
      // Nothing is installed: an unreleased manifest blocks the plan, a released one only offers the download.
      expect(empty.problems.length > 0).toBe(!state.released);

      const dir = fakeInstall(home.dir, state, 'win-x64');
      const plan = installPlan({ manifest: state, target: 'win-x64', model: 'final', home: home.dir });
      expect(plan.problems).toEqual([]);
      expect(plan.installed).toMatchObject({ version: state.version, target: 'win-x64', dir });
      expect(plan.installed).toMatchObject({ models: { mel: true, final: true, small: false } });
      expect(formatPlan(plan)).toContain('already installed');
      // The model asked for decides: the small one is not there, so that plan is not "already installed".
      const small = installPlan({ manifest: state, target: 'win-x64', model: 'small', home: home.dir });
      expect(small.installed).toBeNull();
      expect(small.problems.join('\n').includes('is not published yet')).toBe(!state.released);
    }
  });

  it('reports the size of the final and the small download in the plan', () => {
    const final = installPlan({ manifest, target: 'win-x64', model: 'final', home: null });
    const small = installPlan({ manifest, target: 'win-x64', model: 'small', home: null });
    expect(final.totalBytes).toBeGreaterThan(80_000_000);
    expect(final.totalBytes).toBeLessThan(95_000_000);
    expect(small.totalBytes ?? 0).toBeLessThan(final.totalBytes ?? 0);
  });
});

describe('dataHome and detectTarget', () => {
  it('prefers --home, then OPENTUNE_BEATS_HOME, then CLAUDE_PLUGIN_DATA, and says how to set one', () => {
    const env = { CLAUDE_PLUGIN_DATA: 'C:/data', OPENTUNE_BEATS_HOME: 'C:/other' };
    expect(dataHome(env, 'C:/option')).toEqual({ home: path.resolve('C:/option'), source: '--home' });
    expect(dataHome(env)).toEqual({ home: path.resolve('C:/other'), source: 'OPENTUNE_BEATS_HOME' });
    expect(dataHome({ CLAUDE_PLUGIN_DATA: 'C:/data' })).toEqual({
      home: path.resolve('C:/data'),
      source: 'CLAUDE_PLUGIN_DATA',
    });
    expect(() => dataHome({})).toThrow(BeatGridError);
    expect(() => dataHome({})).toThrow(/--home/);
    expect(() => dataHome({})).toThrow(/OPENTUNE_BEATS_HOME/);
  });

  it('treats an empty --home and a variable that was not replaced as not given', () => {
    const env = { CLAUDE_PLUGIN_DATA: 'C:/data' };
    for (const unusable of ['', '  ', '${CLAUDE_PLUGIN_DATA}', '$CLAUDE_PLUGIN_DATA', '%CLAUDE_PLUGIN_DATA%', null]) {
      expect(dataHome(env, unusable)).toEqual({ home: path.resolve('C:/data'), source: 'CLAUDE_PLUGIN_DATA' });
    }
    expect(() => dataHome({}, '${CLAUDE_PLUGIN_DATA}')).toThrow(/--home is empty or missing/);
  });

  it('maps only Windows x64 and macOS to a release target', () => {
    expect(detectTarget('win32', 'x64')).toBe('win-x64');
    expect(detectTarget('darwin', 'arm64')).toBe('macos-universal2');
    expect(detectTarget('darwin', 'x64')).toBe('macos-universal2');
    expect(detectTarget('linux', 'x64')).toBeNull();
    expect(detectTarget('win32', 'arm64')).toBeNull();
  });
});

describe('the installer', () => {
  function prepared(target = 'win-x64') {
    const home = tempHome();
    cleanup.push(home.remove);
    const version = '0.1.0';
    const executable = executableName(target);
    const program =
      target === 'win-x64'
        ? zipStored([
            { name: executable, data: Buffer.from(fakeAnalyzer({ grid: fakeGrid() })) },
            { name: 'LICENSE', data: Buffer.from('MIT\n') },
          ])
        : tarGz([
            { name: executable, data: Buffer.from(fakeAnalyzer({ grid: fakeGrid() })), mode: 0o755 },
            { name: 'LICENSE', data: Buffer.from('MIT\n') },
          ]);
    const platform =
      target === 'win-x64' ? 'opentune-beats-0.1.0-win-x64.zip' : 'opentune-beats-0.1.0-macos-universal2.tar.gz';
    const files = {
      [platform]: program,
      'mel_spectrogram.onnx': Buffer.from('mel'),
      'beat_this_final.onnx': Buffer.from('final'),
      'beat_this_small.onnx': Buffer.from('small'),
    };
    const sourceDir = path.join(home.dir, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(sourceDir, name), bytes);
    return { home: home.dir, sourceDir, manifest: releasedManifest(files, version), target, files, version };
  }

  it('installs atomically, writes the models and the metadata, and checks --version', async () => {
    const { home, sourceDir, manifest, target, files } = prepared();
    const checked: { executable: string; version: string }[] = [];
    const result = await install({
      manifest,
      home,
      target,
      model: 'final',
      sourceDir,
      selfCheck: (executable: string, version: string) => {
        checked.push({ executable, version });
        return `opentune-beats ${version} (beat-this 1.1.0)`;
      },
    });
    expect(checked).toEqual([
      { executable: path.join(installDir(home, manifest, target), executableName(target)), version: '0.1.0' },
    ]);
    expect(result.dir).toBe(installDir(home, manifest, target));
    expect(result.models).toEqual({ mel: true, final: true, small: false });
    const metadata = JSON.parse(fs.readFileSync(path.join(result.dir, 'install.json'), 'utf8')) as Json;
    expect(metadata).toMatchObject({
      tool: 'opentune-beats',
      version: '0.1.0',
      target,
      model: 'final',
      source: 'local',
    });
    const archive =
      target === 'win-x64' ? 'opentune-beats-0.1.0-win-x64.zip' : 'opentune-beats-0.1.0-macos-universal2.tar.gz';
    expect((metadata.sha256 as Json).program).toBe(sha256(bufferOf(files, archive)));
    // No staging folder is left behind.
    expect(fs.readdirSync(path.join(home, 'bin')).filter((name) => name.startsWith('.'))).toEqual([]);
    expect(currentInstallation(home, manifest, target)?.executable).toBe(result.executable);
  });

  it('installs the small model and lists it', async () => {
    const { home, sourceDir, manifest, target } = prepared();
    const result = await install({
      manifest,
      home,
      target,
      model: 'small',
      sourceDir,
      selfCheck: () => 'opentune-beats 0.1.0',
    });
    expect(result.models).toEqual({ mel: true, final: false, small: true });
    expect(fs.existsSync(path.join(result.dir, 'models', 'beat_this_small.onnx'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'models', 'beat_this_final.onnx'))).toBe(false);
  });

  it('installs the macOS tar.gz under its own target folder', async () => {
    const { home, sourceDir, manifest, target } = prepared('macos-universal2');
    const result = await install({
      manifest,
      home,
      target,
      model: 'final',
      sourceDir,
      selfCheck: () => 'opentune-beats 0.1.0',
    });
    expect(result.dir).toBe(installDir(home, manifest, 'macos-universal2'));
    expect(fs.statSync(path.join(result.dir, executableName('macos-universal2'))).isFile()).toBe(true);
    expect(result.models).toEqual({ mel: true, final: true, small: false });
  });

  it('refuses a checksum that does not match and writes nothing', async () => {
    const { home, sourceDir, manifest, target } = prepared();
    asset(manifest.models, 'final').sha256 = 'f'.repeat(64);
    await expect(install({ manifest, home, target, model: 'final', sourceDir })).rejects.toThrow(/sha256/);
    expect(currentInstallation(home, manifest, target)).toBeNull();
    expect(fs.readdirSync(path.join(home, 'bin'))).toEqual([]);
  });

  it('keeps the previous install when the new checksum does not match', async () => {
    const { home, sourceDir, manifest, target } = prepared();
    const first = await install({
      manifest,
      home,
      target,
      model: 'final',
      sourceDir,
      selfCheck: () => 'opentune-beats 0.1.0',
    });
    fs.writeFileSync(path.join(first.dir, 'marker'), 'old');
    asset(manifest.models, 'final').sha256 = 'f'.repeat(64);
    await expect(install({ manifest, home, target, model: 'final', sourceDir })).rejects.toThrow(/sha256/);
    expect(currentInstallation(home, manifest, target)?.dir).toBe(first.dir);
    expect(fs.readFileSync(path.join(first.dir, 'marker'), 'utf8')).toBe('old');
    expect(fs.readdirSync(path.join(home, 'bin'))).toEqual([path.basename(first.dir)]);
  });

  it('rolls back to the previous version when the new one fails --version', async () => {
    const { home, sourceDir, manifest, target } = prepared();
    const first = await install({
      manifest,
      home,
      target,
      model: 'final',
      sourceDir,
      selfCheck: () => 'opentune-beats 0.1.0',
    });
    fs.writeFileSync(path.join(first.dir, 'marker'), 'old');
    await expect(
      install({
        manifest,
        home,
        target,
        model: 'small',
        sourceDir,
        selfCheck: () => {
          throw new BeatGridError('SELF_CHECK_FAILED', 'the new build does not start');
        },
      }),
    ).rejects.toThrow(/does not start/);
    const after = currentInstallation(home, manifest, target);
    expect(after?.dir).toBe(first.dir);
    expect(fs.readFileSync(path.join(first.dir, 'marker'), 'utf8')).toBe('old');
    expect(fs.readdirSync(path.join(home, 'bin'))).toEqual([path.basename(first.dir)]);
  });

  describe('when removing the failed version fails', () => {
    async function twoInstalls() {
      const { home, sourceDir, manifest, target } = prepared();
      const first = await install({
        manifest,
        home,
        target,
        model: 'final',
        sourceDir,
        selfCheck: () => 'opentune-beats 0.1.0',
      });
      fs.writeFileSync(path.join(first.dir, 'marker'), 'old');
      const failSelfCheck = () => {
        throw new BeatGridError('SELF_CHECK_FAILED', 'the new build does not start');
      };
      return { home, sourceDir, manifest, target, first, failSelfCheck };
    }

    it('moves the failed folder aside and restores the previous version', async () => {
      const { home, sourceDir, manifest, target, first, failSelfCheck } = await twoInstalls();
      const fsImpl = {
        ...fs,
        rmSync: (file: string, options: fs.RmOptions) => {
          if (file === first.dir) throw new Error('EBUSY: resource busy or locked');
          fs.rmSync(file, options);
        },
      };
      await expect(
        install({ manifest, home, target, model: 'small', sourceDir, selfCheck: failSelfCheck, fsImpl }),
      ).rejects.toThrow(/does not start/);
      expect(fs.readFileSync(path.join(first.dir, 'marker'), 'utf8')).toBe('old');
      const left = fs.readdirSync(path.join(home, 'bin')).sort();
      expect(left).toHaveLength(2);
      expect(left.some((name) => name.includes('.failed-'))).toBe(true);
      expect(left.some((name) => name.includes('.old-'))).toBe(false);
    });

    it('keeps the previous version and reports where it is when nothing can be moved', async () => {
      const { home, sourceDir, manifest, target, first, failSelfCheck } = await twoInstalls();
      const fsImpl = {
        ...fs,
        rmSync: (file: string, options: fs.RmOptions) => {
          if (file === first.dir) throw new Error('EBUSY: resource busy or locked');
          fs.rmSync(file, options);
        },
        renameSync: (from: string, to: string) => {
          if (from === first.dir && to.includes('.failed-')) throw new Error('EBUSY: resource busy or locked');
          fs.renameSync(from, to);
        },
      };
      const error = (await install({
        manifest,
        home,
        target,
        model: 'small',
        sourceDir,
        selfCheck: failSelfCheck,
        fsImpl,
      }).catch((caught: unknown) => caught)) as { code: string; message: string };
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe('ROLLBACK_FAILED');
      const backup = fs.readdirSync(path.join(home, 'bin')).find((name) => name.includes('.old-'));
      expect(backup).toBeDefined();
      expect(error.message).toContain(path.join(home, 'bin', backup ?? ''));
      expect(fs.readFileSync(path.join(home, 'bin', backup ?? '', 'marker'), 'utf8')).toBe('old');
    });
  });

  it('extracts a zip and a tar.gz without escaping the folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-extract-'));
    cleanup.push(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    extractZip(
      zipStored([
        { name: 'opentune-beats.exe', data: Buffer.from('x') },
        { name: 'models/', data: Buffer.alloc(0) },
        { name: 'models/beat_this_final.onnx', data: Buffer.from('final') },
      ]),
      path.join(dir, 'zip'),
    );
    expect(fs.readFileSync(path.join(dir, 'zip', 'models', 'beat_this_final.onnx'), 'utf8')).toBe('final');
    extractTarGz(
      tarGz([
        { name: './opentune-beats', data: Buffer.from('x'), mode: 0o755 },
        { name: './models/beat_this_final.onnx', data: Buffer.from('final') },
      ]),
      path.join(dir, 'tar'),
    );
    expect(fs.readFileSync(path.join(dir, 'tar', 'models', 'beat_this_final.onnx'), 'utf8')).toBe('final');
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dir, 'tar', 'opentune-beats')).mode & 0o100).not.toBe(0);
    }

    expect(() => {
      extractZip(zipStored([{ name: '../escape', data: Buffer.from('x') }]), path.join(dir, 'bad'));
    }).toThrow(/escapes the folder|unsafe archive path/);
    expect(() => {
      extractTarGz(
        gzipSync(Buffer.concat([tarHeader('../escape', 1), Buffer.from('x'), Buffer.alloc(511)])),
        path.join(dir, 'bad2'),
      );
    }).toThrow(/escapes the folder|unsafe archive path/);
  });

  it('extracts the entries after a ./ zip entry instead of stalling on it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-extract-dot-'));
    cleanup.push(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    extractZip(
      zipStored([
        { name: './', data: Buffer.alloc(0) },
        { name: 'opentune-beats.exe', data: Buffer.from('x') },
        { name: 'models/beat_this_final.onnx', data: Buffer.from('final') },
      ]),
      path.join(dir, 'zip'),
    );
    expect(fs.readFileSync(path.join(dir, 'zip', 'opentune-beats.exe'), 'utf8')).toBe('x');
    expect(fs.readFileSync(path.join(dir, 'zip', 'models', 'beat_this_final.onnx'), 'utf8')).toBe('final');
  });

  describe('the archive guards', () => {
    const extractInto = (extract: () => void) => {
      expect(extract).toThrow(expect.objectContaining({ code: 'ARCHIVE_UNSAFE' }));
    };
    const folder = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-guard-'));
      cleanup.push(() => {
        fs.rmSync(dir, { recursive: true, force: true });
      });
      return dir;
    };

    it('refuses a zip symbolic link', () => {
      const zip = zipStored([{ name: 'link', data: Buffer.from('target') }]);
      // The central directory record starts with PK\x01\x02; its external attributes sit at offset 38.
      const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      zip.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
      extractInto(() => {
        extractZip(zip, folder());
      });
    });

    it('refuses a tar hard link and a tar symbolic link', () => {
      for (const type of ['1', '2']) {
        const header = tarHeader('link', 0);
        header.write(type, 156, 'utf8');
        header.write('        ', 148, 'utf8');
        let sum = 0;
        for (const byte of header) sum += byte;
        header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
        extractInto(() => {
          extractTarGz(gzipSync(Buffer.concat([header, Buffer.alloc(1024)])), folder());
        });
      }
    });

    it('refuses a drive letter or a colon in a path, in a zip and in a tar', () => {
      for (const name of ['C:/escape.txt', 'C:escape.txt', 'a/b:stream', 'models/x:y']) {
        extractInto(() => {
          extractZip(zipStored([{ name, data: Buffer.from('x') }]), folder());
        });
        extractInto(() => {
          extractTarGz(tarGz([{ name, data: Buffer.from('x') }]), folder());
        });
      }
    });

    it('refuses a duplicate entry, in a zip and in a tar', () => {
      extractInto(() => {
        extractZip(
          zipStored([
            { name: 'opentune-beats.exe', data: Buffer.from('one') },
            { name: 'opentune-beats.exe', data: Buffer.from('two') },
          ]),
          folder(),
        );
      });
      extractInto(() => {
        extractTarGz(
          tarGz([
            { name: 'opentune-beats', data: Buffer.from('one') },
            { name: 'opentune-beats', data: Buffer.from('two') },
          ]),
          folder(),
        );
      });
    });
  });

  it('downloads through fetch, verifies the hash and discards a mismatch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-download-'));
    cleanup.push(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const bytes = Buffer.from('asset bytes');
    const url = 'https://github.com/synchain-oss/opentune-beats/releases/download/v0.1.0/a.bin';
    const fetchImpl = () => Promise.resolve(fakeFetchResponse(bytes, url));
    const file = path.join(dir, 'a.bin');
    await downloadAsset(url, file, sha256(bytes), 'asset a', { fetchImpl });
    expect(fs.readFileSync(file)).toEqual(bytes);

    const bad = path.join(dir, 'b.bin');
    await expect(downloadAsset(url, bad, 'e'.repeat(64), 'asset b', { fetchImpl })).rejects.toThrow(
      /does not match the pinned/,
    );
    expect(fs.existsSync(bad)).toBe(false);

    await expect(
      downloadAsset(url, path.join(dir, 'c.bin'), sha256(bytes), 'asset c', {
        fetchImpl: () => Promise.resolve(new Response('no', { status: 404 })),
      }),
    ).rejects.toThrow(/HTTP 404/);
    await expect(
      downloadAsset(url, path.join(dir, 'd.bin'), sha256(bytes), 'asset d', {
        fetchImpl: () => Promise.reject(new Error('offline')),
      }),
    ).rejects.toThrow(/offline/);
  });

  describe('the download host allowlist', () => {
    const RELEASE_URL = 'https://github.com/synchain-oss/opentune-beats/releases/download/v0.1.0/a.bin';
    const bytes = Buffer.from('release bytes');

    function downloadDir() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-hosts-'));
      cleanup.push(() => {
        fs.rmSync(dir, { recursive: true, force: true });
      });
      return dir;
    }

    it('is a frozen allowlist of the GitHub release hosts', () => {
      expect(Object.isFrozen(DOWNLOAD_HOSTS)).toBe(true);
      expect([...DOWNLOAD_HOSTS].sort()).toEqual([
        'github.com',
        'objects.githubusercontent.com',
        'release-assets.githubusercontent.com',
      ]);
    });

    it('accepts a final URL on github.com and on the two asset hosts', async () => {
      const dir = downloadDir();
      const urls = [
        RELEASE_URL,
        'https://objects.githubusercontent.com/github-production-release-asset/1/a.bin?sig=test',
        'https://release-assets.githubusercontent.com/github-production-release-asset/2/a.bin?sig=test',
      ];
      for (const [index, url] of urls.entries()) {
        const file = path.join(dir, `ok-${String(index)}.bin`);
        await expect(
          downloadAsset(RELEASE_URL, file, sha256(bytes), 'asset a', {
            fetchImpl: () => Promise.resolve(fakeFetchResponse(bytes, url)),
          }),
        ).resolves.toBe(sha256(bytes));
        expect(fs.readFileSync(file)).toEqual(bytes);
      }
      // A real Response carries a read-only url; a redirect sets it the same way.
      const responseFile = path.join(dir, 'ok-response.bin');
      const response = Object.defineProperty(new Response(bytes, { status: 200 }), 'url', {
        value: 'https://release-assets.githubusercontent.com/github-production-release-asset/3/a.bin',
      });
      await expect(
        downloadAsset(RELEASE_URL, responseFile, sha256(bytes), 'asset a', {
          fetchImpl: () => Promise.resolve(response),
        }),
      ).resolves.toBe(sha256(bytes));
      expect(fs.readFileSync(responseFile)).toEqual(bytes);
    });

    it('refuses a redirect that leaves the allowed hosts, and writes nothing', async () => {
      const dir = downloadDir();
      const urls = [
        'https://evil.example/synchain-oss/opentune-beats/releases/download/v0.1.0/a.bin',
        'https://cdn.example.test/assets/a.bin',
      ];
      for (const [index, url] of urls.entries()) {
        const file = path.join(dir, `redirect-${String(index)}.bin`);
        expect(
          await downloadErrorCode(
            downloadAsset(RELEASE_URL, file, sha256(bytes), 'asset a', {
              fetchImpl: () => Promise.resolve(fakeFetchResponse(bytes, url)),
            }),
          ),
        ).toBe('DOWNLOAD_HOST');
        expect(fs.existsSync(file)).toBe(false);
      }
    });

    it('refuses a hostname that only looks like an allowed one', async () => {
      const dir = downloadDir();
      const hosts = [
        'evil-github.com',
        'github.com.evil.example',
        'notgithub.com',
        'githubusercontent.com',
        'objects.githubusercontent.com.evil.example',
      ];
      for (const host of hosts) {
        const file = path.join(dir, 'lookalike.bin');
        expect(
          await downloadErrorCode(
            downloadAsset(RELEASE_URL, file, sha256(bytes), 'asset a', {
              fetchImpl: () => Promise.resolve(fakeFetchResponse(bytes, `https://${host}/a.bin`)),
            }),
          ),
        ).toBe('DOWNLOAD_HOST');
        expect(fs.existsSync(file)).toBe(false);
      }
      // A host that only appears in the userinfo or the path is not the host that served it.
      const userinfo = path.join(dir, 'userinfo.bin');
      // Built from parts: written out, the URL looks like an e-mail address to the privacy scan.
      const userinfoUrl = ['https://github.com', 'evil.example/a.bin'].join('@');
      expect(
        await downloadErrorCode(
          downloadAsset(RELEASE_URL, userinfo, sha256(bytes), 'asset a', {
            fetchImpl: () => Promise.resolve(fakeFetchResponse(bytes, userinfoUrl)),
          }),
        ),
      ).toBe('DOWNLOAD_HOST');
      expect(fs.existsSync(userinfo)).toBe(false);
    });

    it('fails closed on a missing, empty, unparseable or non-https final URL', async () => {
      const dir = downloadDir();
      const finals: unknown[] = [
        undefined,
        '',
        '   ',
        'not a url',
        'github.com/synchain-oss/opentune-beats/a.bin',
        'http://github.com/synchain-oss/opentune-beats/a.bin',
        42,
      ];
      for (const [index, url] of finals.entries()) {
        const file = path.join(dir, `closed-${String(index)}.bin`);
        expect(
          await downloadErrorCode(
            downloadAsset(RELEASE_URL, file, sha256(bytes), 'asset a', {
              fetchImpl: () => Promise.resolve(fakeFetchResponse(bytes, url)),
            }),
          ),
        ).toBe('DOWNLOAD_HOST');
        expect(fs.existsSync(file)).toBe(false);
      }
    });

    it('still checks the sha256 after the host check', async () => {
      const dir = downloadDir();
      const file = path.join(dir, 'hash.bin');
      expect(
        await downloadErrorCode(
          downloadAsset(RELEASE_URL, file, 'e'.repeat(64), 'asset a', {
            fetchImpl: () => Promise.resolve(fakeFetchResponse(bytes, 'https://objects.githubusercontent.com/x/a.bin')),
          }),
        ),
      ).toBe('CHECKSUM_MISMATCH');
      expect(fs.existsSync(file)).toBe(false);
    });
  });
});

describe('the analyzer wrapper', () => {
  function installed(grid: Json = fakeGrid()) {
    const home = tempHome();
    cleanup.push(home.remove);
    const manifest = loadManifest(MANIFEST_FILE);
    const dir = fakeInstall(home.dir, manifest, 'win-x64', { grid });
    const wav = path.join(home.dir, 'backing.wav');
    fs.writeFileSync(wav, 'RIFF....WAVE');
    return { home: home.dir, manifest, dir, wav, executable: path.join(dir, executableName('win-x64')) };
  }

  const okRun = (stdout: string): RunResult => ({ status: 0, stdout, stderr: '', signal: null, error: null });

  it('passes the analyzer JSON through and saves it with --out', () => {
    const { home, manifest, wav, dir } = installed();
    const out = path.join(home, 'grid.json');
    const calls: { executable: string; args: string[] }[] = [];
    const result = analyze({
      manifest,
      home,
      target: 'win-x64',
      input: wav,
      out,
      run: (executable: string, args: string[]) => {
        calls.push({ executable, args });
        return okRun(JSON.stringify(fakeGrid()));
      },
    });
    expect(calls[0]?.executable).toBe(path.join(dir, executableName('win-x64')));
    expect(calls[0]?.args).toEqual(['analyze', wav, '--model', 'final', '--models-dir', path.join(dir, 'models')]);
    expect(result.ok).toBe(true);
    expect((JSON.parse(fs.readFileSync(out, 'utf8')) as Json).beats).toHaveLength(3);
  });

  it('summarizes segments without the beat list', () => {
    const { home, manifest, wav } = installed();
    const result = analyze({
      manifest,
      home,
      target: 'win-x64',
      input: wav,
      summary: true,
      run: () => okRun(JSON.stringify(fakeGrid())),
    });
    expect(result.summary?.segments[0]).toMatchObject({ bpm: 120, startSec: 0, endSec: 8, confidence: 0.9 });
    expect(result.summary).not.toHaveProperty('beats');
    expect(result.summary?.summary.dominantBpm).toBe(120);
    expect(JSON.stringify(result.summary)).not.toContain('rawTimeSec');
  });

  it('returns the analyzer error JSON and its exit code', () => {
    const { home, manifest, wav } = installed();
    const errorJson = { schemaVersion: 1, error: { code: 'INPUT_TOO_SHORT', detail: 'the input is too short' } };
    const result = analyze({
      manifest,
      home,
      target: 'win-x64',
      input: wav,
      run: () => ({ status: 5, stdout: JSON.stringify(errorJson), stderr: '', signal: null, error: null }),
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT.ANALYSIS_FAILED);
    expect(result.json).toEqual(errorJson);

    const modelMissing = analyze({
      manifest,
      home,
      target: 'win-x64',
      input: wav,
      run: () => ({ status: 3, stdout: JSON.stringify(errorJson), stderr: '', signal: null, error: null }),
    });
    expect(modelMissing.exitCode).toBe(EXIT.NOT_INSTALLED);
    const badInput = analyze({
      manifest,
      home,
      target: 'win-x64',
      input: wav,
      run: () => ({ status: 4, stdout: JSON.stringify(errorJson), stderr: '', signal: null, error: null }),
    });
    expect(badInput.exitCode).toBe(EXIT.USAGE);
  });

  it('refuses a missing install, a relative path, a non-WAV file and a bad model', () => {
    const { home, manifest, wav } = installed();
    const run = () => okRun('{}');
    const empty = tempHome();
    cleanup.push(empty.remove);
    expect(() => analyze({ manifest, home: empty.dir, target: 'win-x64', input: wav, run })).toThrow(/not installed/);
    expect(() => analyze({ manifest, home, target: 'win-x64', input: 'backing.wav', run })).toThrow(/absolute path/);
    const text = path.join(home, 'notes.txt');
    fs.writeFileSync(text, 'x');
    expect(() => analyze({ manifest, home, target: 'win-x64', input: text, run })).toThrow(/\.wav/);
    expect(() => analyze({ manifest, home, target: 'win-x64', input: wav, model: 'large', run })).toThrow(
      /final or small/,
    );
    expect(() => analyze({ manifest, home, target: 'linux-x64', input: wav, run })).toThrow(/Windows x64/);
  });

  it('reports a non-JSON answer and a non-object answer', () => {
    const { home, manifest, wav } = installed();
    expect(() =>
      analyze({
        manifest,
        home,
        target: 'win-x64',
        input: wav,
        run: () => ({ status: 1, stdout: 'boom', stderr: 'crashed', signal: null, error: null }),
      }),
    ).toThrow(/without printing one JSON object/);
    expect(() =>
      analyze({
        manifest,
        home,
        target: 'win-x64',
        input: wav,
        run: () => okRun('[]'),
      }),
    ).toThrow(/not an object/);
  });

  it('runs a real child process and reads its version', () => {
    const script = path.join(os.tmpdir(), `ot-beats-version-${String(process.pid)}-${String(Date.now())}.mjs`);
    fs.writeFileSync(script, 'process.stdout.write("opentune-beats 0.1.0 (beat-this 1.1.0)\\n");\n');
    cleanup.push(() => {
      fs.rmSync(script, { force: true });
    });
    const result = runProcess(process.execPath, [script]);
    expect(result.status).toBe(0);
    expect(parseVersionOutput(result.stdout)).toEqual({
      version: '0.1.0',
      line: 'opentune-beats 0.1.0 (beat-this 1.1.0)',
    });
    expect(parseVersionOutput('something else')).toBeNull();
    expect(parseVersionOutput('opentune-beats 1.2.3')).toMatchObject({ version: '1.2.3' });
  });

  it('runs a fake CLI through a real child process and summarizes it', () => {
    const { home, manifest, wav } = installed();
    const script = path.join(home, 'fake-analyzer.mjs');
    fs.writeFileSync(script, fakeAnalyzer({ grid: fakeGrid() }));
    const result = analyze({
      manifest,
      home,
      target: 'win-x64',
      input: wav,
      summary: true,
      run: (executable: string, args: string[]) => runProcess(process.execPath, [script, ...args]),
    });
    expect(result.ok).toBe(true);
    expect(result.summary?.summary.dominantBpm).toBe(120);
    expect(result.summary?.segments[0]?.bpm).toBe(120);
  });
});

describe('status', () => {
  it('lists the installs of the data folder and which models they hold', () => {
    const home = tempHome();
    cleanup.push(home.remove);
    const manifest = loadManifest(MANIFEST_FILE);
    const dir = fakeInstall(home.dir, manifest, 'win-x64');
    const result = status({ manifest, env: { OPENTUNE_BEATS_HOME: home.dir }, platform: 'win32', arch: 'x64' });
    expect(result.installed).toBe(true);
    expect(result.current).toMatchObject({ version: '0.1.0', target: 'win-x64', dir });
    expect(result.models).toEqual({ mel: true, final: true, small: false });
    expect(result.homeSource).toBe('OPENTUNE_BEATS_HOME');
    // The shipped manifest says released: there is no release note at all.
    expect(manifest.released).toBe(true);
    expect(result.notes.join(' ')).not.toContain('not published yet');

    // A manifest for a release that is not published, with the analyzer installed: nothing to warn about.
    const unreleased = unreleasedManifest();
    const unreleasedInstalled = status({
      manifest: unreleased,
      env: { OPENTUNE_BEATS_HOME: home.dir },
      platform: 'win32',
      arch: 'x64',
    });
    expect(unreleasedInstalled.installed).toBe(true);
    expect(unreleasedInstalled.notes.join(' ')).not.toContain('not published yet');

    // With nothing installed the note stays for such a manifest: it explains why an install would refuse.
    const empty = tempHome();
    cleanup.push(empty.remove);
    const unused = status({
      manifest: unreleased,
      env: { OPENTUNE_BEATS_HOME: empty.dir },
      platform: 'win32',
      arch: 'x64',
    });
    expect(unused.installed).toBe(false);
    expect(unused.notes.join(' ')).toContain('not published yet');
    const releasedEmpty = status({ manifest, env: { OPENTUNE_BEATS_HOME: empty.dir }, platform: 'win32', arch: 'x64' });
    expect(releasedEmpty.installed).toBe(false);
    expect(releasedEmpty.notes.join(' ')).not.toContain('not published yet');
  });

  it('orders installations by semantic version, newest first', () => {
    const home = tempHome();
    cleanup.push(home.remove);
    const manifest = loadManifest(MANIFEST_FILE);
    for (const version of ['0.9.0-rc.2', '0.9.0', '0.10.0', '0.9.0-rc.10', '1.0.0']) {
      const dir = path.join(home.dir, 'bin', `opentune-beats-${version}-win-x64`);
      fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
      fs.writeFileSync(path.join(dir, executableName('win-x64')), 'x');
    }
    const result = status({ manifest, env: { OPENTUNE_BEATS_HOME: home.dir }, platform: 'win32', arch: 'x64' });
    expect(result.installations.map((entry) => entry.version)).toEqual([
      '1.0.0',
      '0.10.0',
      '0.9.0',
      '0.9.0-rc.10',
      '0.9.0-rc.2',
    ]);
  });

  it('works without a data folder and on an unsupported platform', () => {
    const manifest = loadManifest(MANIFEST_FILE);
    const noHome = status({ manifest, env: {}, platform: 'win32', arch: 'x64' });
    expect(noHome.installed).toBe(false);
    expect(noHome.home).toBeNull();
    expect(noHome.homeError ?? '').toContain('CLAUDE_PLUGIN_DATA');
    const linux = status({ manifest, env: { OPENTUNE_BEATS_HOME: os.tmpdir() }, platform: 'linux', arch: 'x64' });
    expect(linux.platform).toEqual({ target: null, supported: false });
    expect(linux.download).toBeNull();
  });
});

describe('compareVersions', () => {
  it('compares numeric parts, then prereleases by the semantic-version rules', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    // Dot-separated identifiers: numeric compared as numbers, alphanumeric lexically.
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.11', '1.0.0-beta.2')).toBeGreaterThan(0);
  });
});

describe('the timing plan', () => {
  const beats = [0, 0.5, 1.0, 1.5, 2.0].map((timeSec, index) => ({
    index,
    timeSec,
    isDownbeat: index % 4 === 0,
    segment: 0,
  }));
  const grid: Json = {
    schemaVersion: 1,
    model: { name: 'final' },
    beats,
    segments: [
      {
        index: 0,
        startSec: 0,
        endSec: 2.25,
        bpm: 120,
        timeSignature: { numerator: 4, denominator: 4 },
        confidence: 0.9,
      },
    ],
    summary: { dominantBpm: 120 },
  };
  const note = (index: number, timeline: number | null, content: number, extra: Json = {}): Json => ({
    index,
    startTimelineSec: timeline,
    endTimelineSec: timeline === null ? null : timeline + 0.2,
    startContentSec: content,
    endContentSec: content + 0.2,
    voiced: true,
    ...extra,
  });
  const page = (notes: Json[], extra: Json = {}): Json => ({
    contentId: 'c:1234abcd:1:1',
    placementId: 'p:1234abcd:1:1',
    clip_revision: 'r:1234abcd:1:1:abc',
    notes,
    ...extra,
  });

  it('removes the singer’s overall lag before applying the threshold', () => {
    // Every note is 40 ms late: the median is 40 ms, so nothing is left to correct.
    const notes = page([note(0, 0.54, 5.04), note(1, 1.04, 5.54), note(2, 1.54, 6.04)]);
    const plan = timingPlan({ grid, notes, gridOffsetSec: 0 });
    expect(plan.globalOffsetMs).toBeCloseTo(40, 1);
    expect(plan.suggestions).toEqual([]);
    expect(plan.counts).toEqual({ flagged: 0, calls: 0, remainingSuggestions: 0 });
  });

  it('flags the notes that stay off after the global offset, and gives the shift', () => {
    const notes = page([note(0, 0.54, 5.04), note(1, 1.04, 5.54), note(2, 1.8, 6.3)]);
    const plan = timingPlan({ grid, notes, gridOffsetSec: 0 });
    expect(plan.globalOffsetMs).toBeCloseTo(40, 1);
    expect(plan.suggestions).toHaveLength(1);
    const flagged = firstSuggestion(plan);
    expect(flagged.noteIndex).toBe(2);
    expect(flagged.deviationMs).toBeCloseTo(-200, 1);
    expect(flagged.adjustedDeviationMs).toBeCloseTo(-240, 1);
    expect(flagged.deltaMs).toBe(240);
    expect(flagged.segment).toMatchObject({ index: 0, bpm: 120, confidence: 0.9 });
    const op = { op: 'shift', start_content_sec: 6.3, end_content_sec: 6.5, delta_ms: 240 };
    expect(flagged.op).toEqual(op);
    // A suggestion carries its op and nothing that could be mistaken for a ready call.
    expect(flagged).not.toHaveProperty('editTiming');
    expect(flagged).not.toHaveProperty('clip');
    expect(flagged).not.toHaveProperty('expected_revision');
    expect(plan.calls).toEqual([
      {
        batch: 1,
        batches: 1,
        ready: true,
        clip: 'p:1234abcd:1:1',
        expected_revision: 'r:1234abcd:1:1:abc',
        ops: [op],
      },
    ]);
  });

  it('uses the threshold and the grid offset on the timeline clock', () => {
    const notes = page([note(0, 10.56, 1.06), note(1, 11.06, 1.56), note(2, 11.53, 2.03)]);
    const plan = timingPlan({ grid, notes, gridOffsetSec: 10, thresholdMs: 30 });
    // Beat 0 is at timeline 10.0, beat 1 at 10.5, beat 2 at 11.0, beat 3 at 11.5.
    expect(plan.clock.gridToTimeline).toBe('timeline = grid time + 10');
    expect(plan.clock.placementOffsetSec).toBe(-9.5);
    expect(plan.globalOffsetMs).toBeCloseTo(60, 1);
    expect(plan.suggestions).toHaveLength(1);
    expect(plan.suggestions[0]).toMatchObject({ noteIndex: 2, deviationMs: 30, adjustedDeviationMs: -30, deltaMs: 30 });
    // The same note with a 40 ms threshold is inside the tolerance.
    expect(timingPlan({ grid, notes, gridOffsetSec: 10, thresholdMs: 40 }).suggestions).toEqual([]);
    expect(DEFAULT_THRESHOLD_MS).toBe(30);
  });

  it('matches subdivisions when asked, and not otherwise', () => {
    // Two notes on their beats and one 70 ms after the eighth-note point at 1.25 s.
    const notes = page([note(0, 0.5, 0.5), note(1, 1.0, 1.0), note(2, 1.32, 1.32)]);
    const onBeats = timingPlan({ grid, notes, gridOffsetSec: 0, thresholdMs: 30 });
    expect(onBeats.suggestions).toHaveLength(1);
    expect(onBeats.suggestions[0]?.gridPoint.kind).toBe('beat');
    expect(onBeats.suggestions[0]?.deltaMs).toBe(180);

    const eighths = timingPlan({ grid, notes, gridOffsetSec: 0, thresholdMs: 30, subdivision: 2 });
    expect(eighths.suggestions).toHaveLength(1);
    expect(eighths.suggestions[0]?.gridPoint).toMatchObject({ kind: 'subdivision', division: 1, timelineSec: 1.25 });
    expect(eighths.suggestions[0]?.adjustedDeviationMs).toBeCloseTo(70, 1);
    expect(eighths.suggestions[0]?.deltaMs).toBe(-70);

    // At a sixteenth grid the same note is near the 1.25 s point as well; at 1.16 s it is the
    // 1.125 s point (division 1 of 4) that is nearest.
    const sixteenth = page([
      note(0, 0.5, 0.5),
      note(1, 1.0, 1.0, { endTimelineSec: 1.1, endContentSec: 1.1 }),
      note(2, 1.16, 1.16),
    ]);
    const sixteenths = timingPlan({ grid, notes: sixteenth, gridOffsetSec: 0, thresholdMs: 30, subdivision: 4 });
    expect(sixteenths.suggestions).toHaveLength(1);
    expect(sixteenths.suggestions[0]?.gridPoint).toMatchObject({ kind: 'subdivision', division: 1 });
    expect(sixteenths.suggestions[0]?.gridPoint.timelineSec).toBeCloseTo(1.125, 4);
    expect(DEFAULT_THRESHOLD_MS).toBe(30);
  });

  it('reports the segment at each flagged note, including a boundary', () => {
    const twoSegments: Json = {
      ...grid,
      segments: [
        { index: 0, startSec: 0, endSec: 1.0, bpm: 120, confidence: 0.9 },
        { index: 1, startSec: 1.0, endSec: 2.25, bpm: 90, confidence: 0.4 },
      ],
    };
    const notes = page([note(0, 0.6, 0.6), note(1, 1.04, 1.04)]);
    const plan = timingPlan({ grid: twoSegments, notes, gridOffsetSec: 0, thresholdMs: 20 });
    expect(plan.suggestions.map((s) => s.segment?.index)).toEqual([0, 1]);
    expect(plan.suggestions.map((s) => s.segment?.bpm)).toEqual([120, 90]);
    // The note at 1.04 s belongs to the segment that starts at 1.0 s.
    expect(plan.suggestions[1]?.gridPoint.timelineSec).toBe(1);
  });

  it('leaves out unvoiced, out-of-grid and timeline-less notes, with warnings', () => {
    const notes = page([
      note(0, 0.9, 0.9),
      note(1, 1.6, 1.6),
      note(2, 0.5, 0.5, { voiced: false }),
      note(3, 9.5, 9.5),
      note(4, null, 3.0),
    ]);
    const plan = timingPlan({ grid, notes, gridOffsetSec: 0, thresholdMs: 30 });
    expect(plan.notes.used).toBe(2);
    expect(plan.suggestions.map((s) => s.noteIndex)).toEqual([0, 1]);
    expect(plan.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['OUTSIDE_GRID', 'UNVOICED_NOTES', 'NOTES_WITHOUT_TIMELINE']),
    );
  });

  it('accepts the merged pages of opentune_get_notes and the structuredContent wrapper', () => {
    const merged = [page([note(0, 0.9, 0.9)]), page([note(1, 1.6, 1.6)], { clip_revision: 'r:1234abcd:1:1:def' })];
    const plan = timingPlan({ grid, notes: merged, gridOffsetSec: 0 });
    expect(plan.notes.pages).toBe(2);
    expect(plan.notes.used).toBe(2);
    expect(plan.warnings.map((w) => w.code)).toContain('REVISION_MISMATCH');
    expect(plan.notes.clipRevision).toBeNull();

    const wrapped = { structuredContent: page([note(0, 0.9, 0.9), note(1, 1.6, 1.6)]) };
    expect(timingPlan({ grid, notes: wrapped, gridOffsetSec: 0 }).suggestions).toHaveLength(2);

    const bare = [note(0, 0.9, 0.9), note(1, 1.6, 1.6)];
    const barePlan = timingPlan({ grid, notes: bare, gridOffsetSec: 0 });
    expect(barePlan.suggestions).toHaveLength(2);
    expect(barePlan.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['NO_CLIP', 'NO_REVISION']));
    // Without one clip and one revision there is no call and no op to apply.
    expect(barePlan.calls).toEqual([]);
    expect(firstSuggestion(barePlan).op).toBeNull();
  });

  it('needs a timeline clock when the notes have none, and a grid with beats', () => {
    expect(() =>
      timingPlan({ grid, notes: page([{ index: 0, startContentSec: 0.9, endContentSec: 1.1 }]), gridOffsetSec: 0 }),
    ).toThrow(/startTimelineSec/);
    expect(() =>
      timingPlan({ grid: { ...grid, beats: [] }, notes: page([note(0, 0.9, 0.9)]), gridOffsetSec: 0 }),
    ).toThrow(/no beats/);
    expect(() => timingPlan({ grid, notes: {}, gridOffsetSec: 0 })).toThrow(/no notes array/);
    expect(() => timingPlan({ grid, notes: page([note(0, 0.9, 0.9)]), gridOffsetSec: Number.NaN })).toThrow(
      /grid-offset-sec/,
    );
    expect(() => timingPlan({ grid, notes: page([note(0, 0.9, 0.9)]), gridOffsetSec: 0, subdivision: 3 })).toThrow(
      /subdivision/,
    );
  });

  it('accepts a negative grid offset and puts the grid before the timeline', () => {
    const early: Json = {
      ...grid,
      beats: [0, 0.5, 1].map((timeSec, index) => ({ index, timeSec, isDownbeat: index === 0, segment: 0 })),
      segments: [{ index: 0, startSec: 0, endSec: 1.25, bpm: 120, confidence: 0.9 }],
    };
    const notes = page([note(0, 0.0, 0.0), note(1, 0.4, 0.4)]);
    const plan = timingPlan({ grid: early, notes, gridOffsetSec: -0.5, thresholdMs: 30 });
    // Beat 0 is on timeline -0.5, beat 1 at 0, beat 2 at 0.5; the note at 0.4 is 100 ms early.
    expect(plan.clock.gridToTimeline).toBe('timeline = grid time - 0.5');
    expect(plan.suggestions.map((s) => s.noteIndex)).toEqual([0, 1]);
  });

  /** A grid of 0.5 s beats and one sung note, a little off, on each beat: `count` onsets in all. */
  function songOf(count: number): { longGrid: Json; many: Json } {
    const longGrid: Json = {
      ...grid,
      beats: Array.from({ length: count + 1 }, (_, i) => ({
        index: i,
        timeSec: i * 0.5,
        isDownbeat: i % 4 === 0,
        segment: 0,
      })),
      segments: [{ index: 0, startSec: 0, endSec: count * 0.5 + 0.25, bpm: 120, confidence: 0.9 }],
    };
    const many = page(Array.from({ length: count }, (_, i) => note(i, i * 0.5 + (i % 2 === 0 ? 0.1 : -0.1), i * 0.5)));
    return { longGrid, many };
  }

  it('lists every batch of at most 64 ops, applies only the first, and asks to plan again for the rest', () => {
    const { longGrid, many } = songOf(150);
    const plan = timingPlan({ grid: longGrid, notes: many, gridOffsetSec: 0, thresholdMs: 10 });
    expect(plan.suggestions).toHaveLength(150);
    expect(plan.calls.map((call) => call.ops.length)).toEqual([64, 64, 22]);
    const calls = plan.calls as unknown as {
      batch: number;
      batches: number;
      ready: boolean;
      expected_revision: string | null;
      ops: Json[];
    }[];
    expect(calls.map((call) => [call.batch, call.batches, call.ready])).toEqual([
      [1, 3, true],
      [2, 3, false],
      [3, 3, false],
    ]);
    // Only the first batch carries the revision that was read; a later one would be stale after it.
    expect(calls[0]?.expected_revision).toBe('r:1234abcd:1:1:abc');
    expect(calls[1]?.expected_revision).toBeNull();
    expect(calls[2]?.expected_revision).toBeNull();
    // The batches are the suggestions in order, cut every 64.
    expect(calls.flatMap((call) => call.ops)).toEqual(plan.suggestions.map((suggestion) => suggestion.op));
    expect(calls[0]?.ops[0]).not.toHaveProperty('dry_run');
    expect(plan.counts).toEqual({ flagged: 150, calls: 3, remainingSuggestions: 86 });
    for (const suggestion of plan.suggestions) {
      expect(suggestion).not.toHaveProperty('editTiming');
      expect(suggestion.op).not.toHaveProperty('clip');
      expect(suggestion.op).not.toHaveProperty('expected_revision');
    }
    const replan = plan.warnings.find((warning) => warning.code === 'REPLAN_AFTER_CALL') as { detail?: string };
    expect(replan.detail ?? '').toContain('86 more suggestion(s)');
    expect(replan.detail ?? '').toContain('batches 2 to 3');
    expect(replan.detail ?? '').toContain('run timing-plan again');
  });

  it('says what to do between batches and why, from the semantics of the time grid', () => {
    const { longGrid, many } = songOf(70);
    const plan = timingPlan({ grid: longGrid, notes: many, gridOffsetSec: 0, thresholdMs: 10 });
    const apply = (plan as unknown as { apply: { maxOpsPerCall: number; betweenBatches: string[]; basis: string } })
      .apply;
    expect(apply.maxOpsPerCall).toBe(64);
    const steps = apply.betweenBatches.join(' ');
    expect(steps).toContain('Apply calls[0] only');
    expect(steps).toContain('Read the notes again with opentune_get_notes and output_path');
    expect(steps).toContain('run timing-plan again');
    expect(apply.basis).toContain('every handle whose output position lies in the range');
    expect(apply.basis).toContain('expectedGridRevision');
    expect(apply.basis).toContain('CLAMPED');
  });

  it('gives exactly one call and no re-plan warning for 64 suggestions, and a second batch for 66', () => {
    const exact = songOf(64);
    const plan = timingPlan({ grid: exact.longGrid, notes: exact.many, gridOffsetSec: 0, thresholdMs: 10 });
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]?.ops).toHaveLength(64);
    expect(plan.counts.remainingSuggestions).toBe(0);
    expect(plan.warnings.map((warning) => warning.code)).not.toContain('REPLAN_AFTER_CALL');
    // An odd number of onsets would leave one at the median, which is not flagged; 66 flag all 66.
    const over = songOf(66);
    const more = timingPlan({ grid: over.longGrid, notes: over.many, gridOffsetSec: 0, thresholdMs: 10 });
    expect(more.calls.map((call) => call.ops.length)).toEqual([64, 2]);
    expect(more.counts.remainingSuggestions).toBe(2);
  });

  it('leaves out a note whose shift rounds to zero milliseconds', () => {
    // Note 0 is 0.2 ms off and the threshold is 0: its shift would round to 0 and add an empty undo step.
    const notes = page([note(0, 0.0002, 0.0002), note(1, 0.5, 0.5), note(2, 1.0, 1.0)]);
    const plan = timingPlan({ grid, notes, gridOffsetSec: 0, thresholdMs: 0 });
    expect(plan.suggestions).toEqual([]);
    expect(plan.calls).toEqual([]);
  });

  it('says that a mixed-clip plan has no call and needs one plan per clip', () => {
    const mixed = [
      page([note(0, 0.6, 0.6), note(1, 0.62, 0.62)], { placementId: 'p:1234abcd:1:1' }),
      page([note(2, 1.36, 1.36)], { placementId: 'p:1234abcd:2:1' }),
    ];
    const plan = timingPlan({ grid, notes: mixed, gridOffsetSec: 0 });
    const warning = plan.warnings.find((entry) => entry.code === 'MIXED_PLACEMENTS') as { detail?: string };
    expect(warning.detail ?? '').toContain('no ready call');
    expect(warning.detail ?? '').not.toContain('uses the last');
    expect(plan.calls).toEqual([]);
    expect(plan.suggestions.length).toBeGreaterThan(0);
    for (const suggestion of plan.suggestions) {
      // No call can be made from a mixed plan, so there is no op to apply either.
      expect(suggestion.op).toBeNull();
      expect(suggestion).not.toHaveProperty('editTiming');
      expect(suggestion).not.toHaveProperty('expected_revision');
    }
  });
});

describe('the command line', () => {
  const env = { OPENTUNE_BEATS_HOME: path.join(os.tmpdir(), 'ot-beats-cli') };

  async function run(argv: string[], options: Json = {}) {
    let out = '';
    let err = '';
    const code = await main(argv, {
      env,
      out: (text: string) => (out += text),
      err: (text: string) => (err += text),
      ...options,
    });
    return {
      code,
      out,
      err,
      json: (() => {
        try {
          return JSON.parse(out) as Json;
        } catch {
          return null;
        }
      })(),
    };
  }

  it('reads the options of every command', () => {
    expect(parseArgs([]).command).toBe('help');
    expect(parseArgs(['analyze', 'C:/Music/a.wav', '--summary', '--model', 'small'])).toEqual({
      command: 'analyze',
      options: { summary: true, model: 'small' },
      positionals: ['C:/Music/a.wav'],
    });
    expect(
      parseArgs(['timing-plan', '--grid=a.json', '--notes', 'n.json', '--grid-offset-sec', '1.5']).options,
    ).toEqual({
      grid: 'a.json',
      notes: 'n.json',
      'grid-offset-sec': '1.5',
    });
    expect(parseArgs(['analyze', 'a.wav', '--no-refine', '--min-segment-beats', '8'])).toEqual({
      command: 'analyze',
      options: { 'no-refine': true, 'min-segment-beats': '8' },
      positionals: ['a.wav'],
    });
    expect(() => parseArgs(['nope'])).toThrow(/unknown command/);
    expect(() => parseArgs(['status', '--yes'])).toThrow(/unknown option/);
    expect(() => parseArgs(['analyze'])).toThrow(/exactly one WAV path/);
    expect(() => parseArgs(['install', '--yes=1'])).toThrow(/takes no value/);
    expect(() => parseArgs(['analyze', 'a.wav', '--model'])).toThrow(/needs a value/);
  });

  it('prints the status JSON and the install plan', async () => {
    const statusRun = await run(['status']);
    expect(statusRun.code).toBe(EXIT.OK);
    expect(statusRun.json).toMatchObject({ tool: 'beat-grid', command: 'status', installed: false });

    // The manifest of a release that is not published, so that --yes below is refused and nothing is downloaded.
    const unreleased = unreleasedManifest();
    const plan = await run(['install', '--model', 'final'], { manifest: unreleased });
    expect(plan.code).toBe(EXIT.OK);
    expect(plan.out).toContain('nothing has been downloaded');
    expect(plan.out).toContain('not published yet');

    const yes = await run(['install', '--model', 'final', '--yes'], { manifest: unreleased });
    expect(yes.code).toBe(EXIT.INSTALL_FAILED);
    expect((yes.json?.error as Json).code).toBe('INSTALL_REFUSED');
  });

  it('prints an error object and a non-zero code for a bad command line', async () => {
    const bad = await run([
      'timing-plan',
      '--grid',
      'missing.json',
      '--notes',
      'missing.json',
      '--grid-offset-sec',
      '0',
    ]);
    expect(bad.code).toBe(EXIT.USAGE);
    expect((bad.json?.error as Json).code).toBe('GRID_UNREADABLE');
    expect(bad.err).toContain('GRID_UNREADABLE');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-plan-'));
    cleanup.push(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const gridFile = path.join(dir, 'grid.json');
    const notesFile = path.join(dir, 'notes.json');
    fs.writeFileSync(gridFile, JSON.stringify({ schemaVersion: 1, beats: [{ timeSec: 0 }], segments: [] }));
    fs.writeFileSync(notesFile, JSON.stringify({ notes: [] }));
    const number = await run(['timing-plan', '--grid', gridFile, '--notes', notesFile, '--grid-offset-sec', 'x']);
    expect(number.code).toBe(EXIT.USAGE);
    expect((number.json?.error as Json).detail).toContain('grid-offset-sec');

    const model = await run(['install', '--model', 'large', '--yes']);
    expect(model.code).toBe(EXIT.USAGE);
    expect((model.json?.error as Json).detail).toContain('final or small');
  });

  it('writes the summary of an analyze run with --summary', async () => {
    const home = tempHome();
    cleanup.push(home.remove);
    const manifest = loadManifest(MANIFEST_FILE);
    fakeInstall(home.dir, manifest, 'win-x64', { grid: fakeGrid() });
    const wav = path.join(home.dir, 'backing.wav');
    fs.writeFileSync(wav, 'RIFF....WAVE');
    const result = await run(['analyze', wav, '--summary'], {
      env: { OPENTUNE_BEATS_HOME: home.dir },
      platform: 'win32',
      arch: 'x64',
      run: () => ({ status: 0, stdout: JSON.stringify(fakeGrid()), stderr: '', signal: null, error: null }),
    });
    expect(result.code).toBe(EXIT.OK);
    expect((result.json?.segments as Json[])[0]?.bpm).toBe(120);
    expect(result.json).not.toHaveProperty('beats');
  });

  it('writes the full grid with --out and prints one line', async () => {
    const home = tempHome();
    cleanup.push(home.remove);
    const manifest = loadManifest(MANIFEST_FILE);
    fakeInstall(home.dir, manifest, 'win-x64', { grid: fakeGrid() });
    const wav = path.join(home.dir, 'backing.wav');
    fs.writeFileSync(wav, 'RIFF....WAVE');
    const outFile = path.join(home.dir, 'grid.json');
    const result = await run(['analyze', wav, '--out', outFile], {
      env: { OPENTUNE_BEATS_HOME: home.dir },
      platform: 'win32',
      arch: 'x64',
      run: () => ({ status: 0, stdout: JSON.stringify(fakeGrid()), stderr: '', signal: null, error: null }),
    });
    expect(result.code).toBe(EXIT.OK);
    expect(result.out).toContain(`Wrote ${outFile}`);
    expect((JSON.parse(fs.readFileSync(outFile, 'utf8')) as Json).beats).toHaveLength(3);
  });

  it('refuses --out for a non-.json path and for an existing file unless --force is given', async () => {
    const home = tempHome();
    cleanup.push(home.remove);
    const manifest = loadManifest(MANIFEST_FILE);
    fakeInstall(home.dir, manifest, 'win-x64', { grid: fakeGrid() });
    const wav = path.join(home.dir, 'backing.wav');
    fs.writeFileSync(wav, 'RIFF....WAVE');
    const options = {
      env: { OPENTUNE_BEATS_HOME: home.dir },
      platform: 'win32',
      arch: 'x64',
      run: () => ({ status: 0, stdout: JSON.stringify(fakeGrid()), stderr: '', signal: null, error: null }),
    };
    const notJson = await run(['analyze', wav, '--out', path.join(home.dir, 'project.otproj')], options);
    expect(notJson.code).toBe(EXIT.USAGE);
    expect((notJson.json?.error as Json).code).toBe('OUT_REFUSED');
    expect(fs.existsSync(path.join(home.dir, 'project.otproj'))).toBe(false);

    const existing = path.join(home.dir, 'grid.json');
    fs.writeFileSync(existing, 'keep me');
    const refused = await run(['analyze', wav, '--out', existing], options);
    expect(refused.code).toBe(EXIT.USAGE);
    expect((refused.json?.error as Json).code).toBe('OUT_EXISTS');
    expect(fs.readFileSync(existing, 'utf8')).toBe('keep me');

    const forced = await run(['analyze', wav, '--out', existing, '--force'], options);
    expect(forced.code).toBe(EXIT.OK);
    expect((JSON.parse(fs.readFileSync(existing, 'utf8')) as Json).beats).toHaveLength(3);
  });

  it('reads JSON files that start with a byte-order mark', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-bom-'));
    cleanup.push(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const gridFile = path.join(dir, 'grid.json');
    const notesFile = path.join(dir, 'notes.json');
    fs.writeFileSync(
      gridFile,
      `\uFEFF${JSON.stringify({
        schemaVersion: 1,
        beats: [
          { index: 0, timeSec: 0, segment: 0 },
          { index: 1, timeSec: 0.5, segment: 0 },
          { index: 2, timeSec: 1, segment: 0 },
        ],
        segments: [{ index: 0, startSec: 0, endSec: 1.25, bpm: 120, confidence: 0.9 }],
      })}`,
    );
    fs.writeFileSync(
      notesFile,
      `\uFEFF${JSON.stringify({
        placementId: 'p:1234abcd:1:1',
        clip_revision: 'r:1234abcd:1:1:abc',
        notes: [{ index: 0, startTimelineSec: 0.9, startContentSec: 0.9, endContentSec: 1.1, voiced: true }],
      })}`,
    );
    const result = await run(['timing-plan', '--grid', gridFile, '--notes', notesFile, '--grid-offset-sec', '0']);
    expect(result.code).toBe(EXIT.OK);
  });

  it('passes --no-refine and --min-segment-beats through to the analyzer', async () => {
    const home = tempHome();
    cleanup.push(home.remove);
    const manifest = loadManifest(MANIFEST_FILE);
    const dir = fakeInstall(home.dir, manifest, 'win-x64', { grid: fakeGrid() });
    const wav = path.join(home.dir, 'backing.wav');
    fs.writeFileSync(wav, 'RIFF....WAVE');
    const base = ['analyze', wav, '--model', 'final', '--models-dir', path.join(dir, 'models')];
    const calls: string[][] = [];
    const options = {
      env: { OPENTUNE_BEATS_HOME: home.dir },
      platform: 'win32',
      arch: 'x64',
      run: (_executable: string, args: string[]) => {
        calls.push(args);
        return { status: 0, stdout: JSON.stringify(fakeGrid()), stderr: '', signal: null, error: null };
      },
    };
    const plain = await run(['analyze', wav], options);
    expect(plain.code).toBe(EXIT.OK);
    expect(calls[0]).toEqual(base);

    const both = await run(['analyze', wav, '--no-refine', '--min-segment-beats', '16'], options);
    expect(both.code).toBe(EXIT.OK);
    expect(calls[1]).toEqual([...base, '--no-refine', '--min-segment-beats', '16']);

    const valueOnly = await run(['analyze', wav, '--min-segment-beats=4'], options);
    expect(valueOnly.code).toBe(EXIT.OK);
    expect(calls[2]).toEqual([...base, '--min-segment-beats', '4']);

    // An invalid value is a usage error before the analyzer runs.
    for (const value of ['0', '-1', '2.5', 'many', '']) {
      const invalid = await run(['analyze', wav, '--no-refine', '--min-segment-beats', value], options);
      expect(invalid.code, `--min-segment-beats ${value}`).toBe(EXIT.USAGE);
    }
    expect(calls).toHaveLength(3);
  });

  it('installs end to end through main with a fake fetch and without the network', async () => {
    const home = tempHome();
    cleanup.push(home.remove);
    const version = '0.1.0';
    const executable = executableName('win-x64');
    const archive = `opentune-beats-${version}-win-x64.zip`;
    const files: Record<string, Buffer> = {
      [archive]: zipStored([
        { name: executable, data: Buffer.from(fakeAnalyzer({ grid: fakeGrid() })) },
        { name: 'LICENSE', data: Buffer.from('MIT\n') },
      ]),
      'mel_spectrogram.onnx': Buffer.from('mel'),
      'beat_this_final.onnx': Buffer.from('final'),
      'beat_this_small.onnx': Buffer.from('small'),
    };
    const manifest = releasedManifest(files, version);
    const fetched: string[] = [];
    const fetchImpl = (url: string) => {
      fetched.push(url);
      const name = url.slice(url.lastIndexOf('/') + 1);
      const bytes = files[name];
      if (bytes === undefined) throw new Error(`the test has no bytes for ${url}`);
      return Promise.resolve(
        fakeFetchResponse(
          bytes,
          `https://objects.githubusercontent.com/github-production-release-asset/${name}?sig=test`,
        ),
      );
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('the real fetch must not be used');
    });
    cleanup.push(() => {
      fetchSpy.mockRestore();
    });
    let out = '';
    let err = '';
    const code = await main(['install', '--yes', '--model', 'final'], {
      manifest,
      fetchImpl,
      env: { OPENTUNE_BEATS_HOME: home.dir },
      platform: 'win32',
      arch: 'x64',
      out: (text: string) => (out += text),
      err: (text: string) => (err += text),
      selfCheck: () => 'opentune-beats 0.1.0 (beat-this 1.1.0)',
    });
    expect(code).toBe(EXIT.OK);
    const result = JSON.parse(out) as Json;
    const dir = installDir(home.dir, manifest, 'win-x64');
    expect(result).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: 'install',
      dir,
      executable: path.join(dir, executable),
      version,
      versionLine: 'opentune-beats 0.1.0 (beat-this 1.1.0)',
      model: 'final',
      models: { mel: true, final: true, small: false },
      replaced: false,
    });
    expect(fs.existsSync(path.join(dir, executable))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'models')).sort()).toEqual(['beat_this_final.onnx', 'mel_spectrogram.onnx']);
    const metadata = JSON.parse(fs.readFileSync(path.join(dir, 'install.json'), 'utf8')) as Json;
    expect(metadata).toMatchObject({ tool: 'opentune-beats', version, target: 'win-x64', source: 'download' });
    expect((metadata.sha256 as Json).program).toBe(sha256(bufferOf(files, archive)));
    // The three assets came from the fake fetch, and the real one was never called.
    expect(fetched).toEqual([
      asset(manifest.platforms, 'win-x64').url,
      asset(manifest.models, 'mel').url,
      asset(manifest.models, 'final').url,
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(err).toContain('installed');
  });

  it('builds a timing plan from the two files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-plan-'));
    cleanup.push(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const gridFile = path.join(dir, 'grid.json');
    const notesFile = path.join(dir, 'notes.json');
    fs.writeFileSync(
      gridFile,
      JSON.stringify({
        schemaVersion: 1,
        beats: [
          { index: 0, timeSec: 0, segment: 0 },
          { index: 1, timeSec: 0.5, segment: 0 },
          { index: 2, timeSec: 1, segment: 0 },
          { index: 3, timeSec: 1.5, segment: 0 },
          { index: 4, timeSec: 2, segment: 0 },
        ],
        segments: [{ index: 0, startSec: 0, endSec: 2.25, bpm: 120, confidence: 0.9 }],
        model: { name: 'final' },
      }),
    );
    fs.writeFileSync(
      notesFile,
      JSON.stringify({
        placementId: 'p:1234abcd:1:1',
        clip_revision: 'r:1234abcd:1:1:abc',
        notes: [
          { index: 0, startTimelineSec: 0.9, startContentSec: 0.9, endContentSec: 1.1, voiced: true },
          { index: 1, startTimelineSec: 1.6, startContentSec: 1.6, endContentSec: 1.8, voiced: true },
        ],
      }),
    );
    const result = await run(['timing-plan', '--grid', gridFile, '--notes', notesFile, '--grid-offset-sec', '0']);
    expect(result.code).toBe(EXIT.OK);
    expect(result.json?.suggestions as Suggestion[]).toHaveLength(2);
    expect((result.json?.suggestions as Suggestion[]).map((s) => s.deltaMs)).toEqual([100, -100]);
  });
});

// --- helpers for archives the script must accept -----------------------------------------------

/** A tar archive of regular files, for the installer's tar.gz path. */
function tarGz(entries: { name: string; data: Buffer; mode?: number }[]) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const mode = entry.mode ?? 0o644;
    blocks.push(
      tarHeader(entry.name, entry.data.length, mode),
      entry.data,
      Buffer.alloc((512 - (entry.data.length % 512)) % 512),
    );
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function tarHeader(name: string, size: number, mode = 0o644) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'utf8');
  header.write('0000000\0', 108, 'utf8');
  header.write('0000000\0', 116, 'utf8');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'utf8');
  header.write('00000000000\0', 136, 'utf8');
  header.write('        ', 148, 'utf8');
  header.write('0', 156, 'utf8');
  header.write('ustar\0', 257, 'utf8');
  header.write('00', 263, 'utf8');
  header.write('        ', 148, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
  return header;
}
