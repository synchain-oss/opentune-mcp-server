// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The beat-grid skill: its manifest, the installer (dry-run text, the released:false refusal, the
// checksum rollback), the analyzer wrapper against a fake CLI, and the timing plan on synthetic
// grids and notes. Nothing here reaches the network or a real opentune-beats build.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
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
  editTiming: Json | null;
}
interface TimingPlan {
  clock: { gridToTimeline: string; placementOffsetSec: number | null };
  notes: { pages: number; used: number; clipRevision: string | null };
  globalOffsetMs: number | null;
  suggestions: Suggestion[];
  calls: { ops: Json[] }[];
  warnings: { code: string }[];
  counts: { flagged: number; calls: number };
}
interface InstallPlan {
  problems: string[];
  totalBytes: number | null;
  target: string | null;
  version: string | null;
  assets: { kind: string; asset: string; approxBytes: number }[];
  otherModel: { name: string; totalBytes: number | null };
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
  EXIT: { OK: number; USAGE: number; NOT_INSTALLED: number; INSTALL_FAILED: number; ANALYSIS_FAILED: number };
  analyze: (options: Json) => AnalyzeResult;
  currentInstallation: (home: string, manifest: Manifest, target: string) => { dir: string; executable: string } | null;
  dataHome: (env: Record<string, string | undefined>) => { home: string; source: string };
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
  EXIT,
  analyze,
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

  it('is marked unreleased with every sha256 empty, and passes the manifest checks that way', () => {
    expect(manifest.released).toBe(false);
    for (const entry of [...Object.values(manifest.platforms), ...Object.values(manifest.models)]) {
      expect(entry.sha256).toBe('');
    }
    expect(manifestProblems(manifest)).toEqual([]);
  });

  it('turns red on a guessed hash while unreleased, a missing hash once released, and a foreign URL', () => {
    const guessed = JSON.parse(JSON.stringify(manifest)) as Manifest;
    asset(guessed.models, 'final').sha256 = 'c'.repeat(64);
    expect(manifestProblems(guessed).join('\n')).toContain('must stay empty while manifest.released is false');

    const released = JSON.parse(JSON.stringify(manifest)) as Manifest;
    released.released = true;
    expect(manifestProblems(released).join('\n')).toContain('must be filled in before the release is marked released');

    const foreign = JSON.parse(JSON.stringify(manifest)) as Manifest;
    asset(foreign.models, 'mel').url = 'https://example.com/mel_spectrogram.onnx';
    expect(manifestProblems(foreign).join('\n')).toContain('the pinned release asset');
  });

  it('says that the release does not exist yet in the plan, and refuses --yes', async () => {
    const home = tempHome();
    cleanup.push(home.remove);
    const plan = installPlan({ manifest, target: 'win-x64', model: 'final', home: home.dir });
    expect(plan.problems.join('\n')).toContain('is not published yet');
    const text = formatPlan(plan);
    expect(text).toContain('nothing has been downloaded');
    expect(text).toContain('87 MB');
    expect(text).toContain('MIT');
    expect(text).toContain('not published yet');
    await expect(install({ manifest, home: home.dir, target: 'win-x64', model: 'final' })).rejects.toThrow(
      /not published yet/,
    );
    expect(fs.existsSync(path.join(home.dir, 'bin'))).toBe(false);
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
  it('prefers CLAUDE_PLUGIN_DATA, then OPENTUNE_BEATS_HOME, and says how to set one', () => {
    expect(dataHome({ CLAUDE_PLUGIN_DATA: 'C:/data', OPENTUNE_BEATS_HOME: 'C:/other' })).toEqual({
      home: path.resolve('C:/data'),
      source: 'CLAUDE_PLUGIN_DATA',
    });
    expect(dataHome({ OPENTUNE_BEATS_HOME: 'C:/other' })).toEqual({
      home: path.resolve('C:/other'),
      source: 'OPENTUNE_BEATS_HOME',
    });
    expect(() => dataHome({})).toThrow(BeatGridError);
    expect(() => dataHome({})).toThrow(/OPENTUNE_BEATS_HOME/);
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

  it('downloads through fetch, verifies the hash and discards a mismatch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-download-'));
    cleanup.push(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const bytes = Buffer.from('asset bytes');
    const fetchImpl = () => Promise.resolve(new Response(bytes, { status: 200 }));
    const file = path.join(dir, 'a.bin');
    await downloadAsset('https://example.com/a.bin', file, sha256(bytes), 'asset a', { fetchImpl });
    expect(fs.readFileSync(file)).toEqual(bytes);

    const bad = path.join(dir, 'b.bin');
    await expect(
      downloadAsset('https://example.com/b.bin', bad, 'e'.repeat(64), 'asset b', { fetchImpl }),
    ).rejects.toThrow(/does not match the pinned/);
    expect(fs.existsSync(bad)).toBe(false);

    await expect(
      downloadAsset('https://example.com/c.bin', path.join(dir, 'c.bin'), sha256(bytes), 'asset c', {
        fetchImpl: () => Promise.resolve(new Response('no', { status: 404 })),
      }),
    ).rejects.toThrow(/HTTP 404/);
    await expect(
      downloadAsset('https://example.com/d.bin', path.join(dir, 'd.bin'), sha256(bytes), 'asset d', {
        fetchImpl: () => Promise.reject(new Error('offline')),
      }),
    ).rejects.toThrow(/offline/);
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
    expect(result.notes.join(' ')).toContain('not published yet');
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
    expect(plan.counts).toEqual({ flagged: 0, calls: 0 });
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
    expect(flagged.editTiming).toEqual({
      clip: 'p:1234abcd:1:1',
      expected_revision: 'r:1234abcd:1:1:abc',
      ops: [{ op: 'shift', start_content_sec: 6.3, end_content_sec: 6.5, delta_ms: 240 }],
    });
    expect(plan.calls).toEqual([
      {
        clip: 'p:1234abcd:1:1',
        expected_revision: 'r:1234abcd:1:1:abc',
        ops: [{ op: 'shift', start_content_sec: 6.3, end_content_sec: 6.5, delta_ms: 240 }],
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
    const sixteenth = page([note(0, 0.5, 0.5), note(1, 1.0, 1.0), note(2, 1.16, 1.16)]);
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
      note(4, null, 1.0),
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

  it('groups the calls at most eight ops at a time', () => {
    const longGrid: Json = {
      ...grid,
      beats: Array.from({ length: 11 }, (_, i) => ({
        index: i,
        timeSec: i * 0.5,
        isDownbeat: i % 4 === 0,
        segment: 0,
      })),
      segments: [{ index: 0, startSec: 0, endSec: 5.5, bpm: 120, confidence: 0.9 }],
    };
    const many = page(Array.from({ length: 10 }, (_, i) => note(i, i * 0.5 + (i % 2 === 0 ? 0.1 : -0.1), i * 0.5)));
    const plan = timingPlan({ grid: longGrid, notes: many, gridOffsetSec: 0, thresholdMs: 10 });
    expect(plan.suggestions).toHaveLength(10);
    expect(plan.calls).toHaveLength(2);
    expect(plan.calls[0]?.ops).toHaveLength(8);
    expect(plan.calls[1]?.ops).toHaveLength(2);
    expect(plan.calls[0]?.ops[0]).not.toHaveProperty('dry_run');
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

    const plan = await run(['install', '--model', 'final']);
    expect(plan.code).toBe(EXIT.OK);
    expect(plan.out).toContain('nothing has been downloaded');
    expect(plan.out).toContain('not published yet');

    const yes = await run(['install', '--model', 'final', '--yes']);
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
      run: () => ({ status: 0, stdout: JSON.stringify(fakeGrid()), stderr: '', signal: null, error: null }),
    });
    expect(result.code).toBe(EXIT.OK);
    expect(result.out).toContain(`Wrote ${outFile}`);
    expect((JSON.parse(fs.readFileSync(outFile, 'utf8')) as Json).beats).toHaveLength(3);
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
