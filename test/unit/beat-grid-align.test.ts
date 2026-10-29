// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// beat-grid align: how much later or earlier the events of a vocal file are than those of a backing
// file. The signals are synthetic (noise bursts against tone bursts with a known delay), written as
// WAV files in every format the skill reads; the answer must match the delay to within a frame.

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import * as beatGridModule from '../../plugins/opentune/skills/beat-grid/scripts/beat-grid.mjs';
import { tempDir } from '../support/context.js';
import {
  backingTrack,
  irregularHits,
  steadyHits,
  vocalTrack,
  wavFile,
  type WavOptions,
} from '../support/synthetic-audio.js';

type Json = Record<string, unknown>;
interface AlignResult {
  lagSec: number;
  confidence: number;
  confident: boolean;
  confidenceThreshold: number;
  peakCorrelation: number;
  nextBest: { lagSec: number; correlation: number } | null;
  searched: { maxLagSec: number; frameHz: number };
  vocal: { sampleRate: number; channels: number; bitsPerSample: number; format: string; seconds: number };
  backing: { sampleRate: number; channels: number; bitsPerSample: number; format: string; seconds: number };
  warnings: { code: string; detail: string }[];
}
interface BeatGridModule {
  ALIGN_MIN_CONFIDENCE: number;
  BeatGridError: new (code: string, detail: string, exitCode?: number) => Error & { code: string; exitCode: number };
  align: (options: Json) => AlignResult;
  crossCorrelation: (a: Float64Array, b: Float64Array, maxLag: number) => Float64Array;
  frameEnergies: (file: string) => { energies: number[]; info: Json };
  main: (argv: string[], options?: Json) => Promise<number>;
  onsetEnvelope: (energies: number[]) => Float64Array;
  pickPeak: (correlation: Float64Array, maxLag: number) => Json;
}
const { ALIGN_MIN_CONFIDENCE, align, crossCorrelation, frameEnergies, main, onsetEnvelope, pickPeak } =
  beatGridModule as unknown as BeatGridModule;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const SECONDS = 24;
const RATE = 8000;
const HITS = irregularHits(36);

function folder(): string {
  const t = tempDir('ot-align-');
  cleanup.push(t.remove);
  return t.dir;
}

/** Writes a vocal (delayed by `delay`) and a backing track as WAV files; returns their paths. */
function files(
  dir: string,
  delay: number,
  vocalOptions: Partial<WavOptions> = {},
  backingOptions: Partial<WavOptions> = {},
  times: readonly number[] = HITS,
) {
  const vocal = path.join(dir, 'vocal.wav');
  const backing = path.join(dir, 'backing.wav');
  const vocalRate = vocalOptions.rate ?? RATE;
  const backingRate = backingOptions.rate ?? RATE;
  fs.writeFileSync(
    vocal,
    wavFile([vocalTrack(times, delay, vocalRate, SECONDS)], { rate: vocalRate, bits: 16, ...vocalOptions }),
  );
  fs.writeFileSync(
    backing,
    wavFile([backingTrack(times, backingRate, SECONDS)], { rate: backingRate, bits: 16, ...backingOptions }),
  );
  return { vocal, backing };
}

describe('align: the offset of a vocal against a backing track', () => {
  it.each([0.37, -0.55, 0, 1.25, -1.8])('finds a delay of %f s, confidently', (delay) => {
    const { vocal, backing } = files(folder(), delay);
    const result = align({ vocal, backing });
    expect(Math.abs(result.lagSec - delay)).toBeLessThanOrEqual(0.015);
    expect(result.confident).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(ALIGN_MIN_CONFIDENCE);
    expect(result.confidenceThreshold).toBe(1.5);
    expect(result.peakCorrelation).toBeGreaterThan(0.2);
    expect(result.warnings).toEqual([]);
    expect(result.searched).toEqual({ maxLagSec: 2, frameHz: 100 });
  });

  it('means: positive when the events of the vocal come later in its file than in the backing file', () => {
    const { vocal, backing } = files(folder(), 0.6);
    expect(align({ vocal, backing }).lagSec).toBeGreaterThan(0.5);
    const swapped = align({ vocal: backing, backing: vocal });
    expect(swapped.lagSec).toBeLessThan(-0.5);
  });

  it('finds a delay between a few milliseconds of a frame, interpolating the peak', () => {
    const { vocal, backing } = files(folder(), 0.254);
    expect(Math.abs(align({ vocal, backing }).lagSec - 0.254)).toBeLessThanOrEqual(0.006);
  });

  it.each<[string, Partial<WavOptions>]>([
    ['16 bit PCM', { bits: 16 }],
    ['24 bit PCM', { bits: 24 }],
    ['32 bit PCM', { bits: 32 }],
    ['32 bit float', { bits: 32, float: true }],
    ['64 bit float', { bits: 64, float: true }],
    ['extensible 24 bit PCM', { bits: 24, extensible: true }],
    ['extensible 32 bit float', { bits: 32, float: true, extensible: true }],
    ['a LIST chunk before the data', { listChunk: true }],
    ['a data size of 0 (a stream)', { dataSize: 'zero' }],
    ['a data size of 0xFFFFFFFF', { dataSize: 'max' }],
    ['a data size larger than the file', { dataSize: 'too-large' }],
  ])('reads %s', (_name, format) => {
    const { vocal, backing } = files(folder(), 0.42, format, { bits: 16 });
    const result = align({ vocal, backing });
    expect(Math.abs(result.lagSec - 0.42)).toBeLessThanOrEqual(0.015);
    expect(result.confident).toBe(true);
    expect(result.vocal.bitsPerSample).toBe(format.bits ?? 16);
    expect(result.vocal.format).toBe(format.float === true ? 'float' : 'pcm');
  });

  it('mixes the channels down and handles different sample rates, with the time in seconds', () => {
    const dir = folder();
    const vocal = path.join(dir, 'vocal.wav');
    const backing = path.join(dir, 'backing.wav');
    const left = vocalTrack(HITS, 0.31, 22050, SECONDS);
    const right = new Float32Array(left.length); // one silent channel: the mix is half as loud, the onsets stay
    fs.writeFileSync(vocal, wavFile([left, right], { rate: 22050, bits: 24 }));
    fs.writeFileSync(backing, wavFile([backingTrack(HITS, 44100, SECONDS)], { rate: 44100, bits: 16 }));
    const result = align({ vocal, backing });
    expect(Math.abs(result.lagSec - 0.31)).toBeLessThanOrEqual(0.015);
    expect(result.vocal).toMatchObject({ sampleRate: 22050, channels: 2, seconds: SECONDS });
    expect(result.backing).toMatchObject({ sampleRate: 44100, channels: 1, seconds: SECONDS });
  });

  it('handles files of different length', () => {
    const dir = folder();
    const vocal = path.join(dir, 'vocal.wav');
    const backing = path.join(dir, 'backing.wav');
    fs.writeFileSync(vocal, wavFile([vocalTrack(HITS, 0.5, RATE, 16)], { rate: RATE, bits: 16 }));
    fs.writeFileSync(backing, wavFile([backingTrack(HITS, RATE, SECONDS)], { rate: RATE, bits: 16 }));
    const result = align({ vocal, backing });
    expect(Math.abs(result.lagSec - 0.5)).toBeLessThanOrEqual(0.015);
  });

  it('searches within the range asked for, and warns when the best match lies at its edge', () => {
    const { vocal, backing } = files(folder(), 1.2);
    const narrow = align({ vocal, backing, maxLagSec: 0.5 });
    expect(narrow.searched.maxLagSec).toBe(0.5);
    expect(Math.abs(narrow.lagSec)).toBeLessThanOrEqual(0.5);
    const edge = narrow.warnings.find((w) => w.code === 'LAG_AT_LIMIT');
    // The best match inside +-0.5 s is not the delay of 1.2 s: it may sit at the edge or elsewhere, but
    // the answer must not claim to be confident about 1.2.
    expect(Math.abs(narrow.lagSec - 1.2)).toBeGreaterThan(0.1);
    if (edge === undefined) expect(narrow.confident).toBe(false);
    const wide = align({ vocal, backing, maxLagSec: 3 });
    expect(Math.abs(wide.lagSec - 1.2)).toBeLessThanOrEqual(0.015);
  });

  it('is not confident about a steady rhythm, where several offsets fit equally well', () => {
    const dir = folder();
    const { vocal, backing } = files(dir, 0.12, {}, {}, steadyHits(44, 0.5));
    const result = align({ vocal, backing });
    expect(result.confident).toBe(false);
    expect(result.confidence).toBeLessThan(ALIGN_MIN_CONFIDENCE);
    expect(result.warnings.map((w) => w.code)).toContain('LOW_CONFIDENCE');
    expect(result.warnings.find((w) => w.code === 'LOW_CONFIDENCE')?.detail).toContain(
      'times better than the next best',
    );
    expect(result.nextBest).not.toBeNull();
  });

  it('is not confident when the vocal has nothing to do with the backing track', () => {
    const dir = folder();
    const vocal = path.join(dir, 'vocal.wav');
    const backing = path.join(dir, 'backing.wav');
    fs.writeFileSync(vocal, wavFile([vocalTrack(irregularHits(36, 99), 0, RATE, SECONDS)], { rate: RATE, bits: 16 }));
    fs.writeFileSync(backing, wavFile([backingTrack(HITS, RATE, SECONDS)], { rate: RATE, bits: 16 }));
    const result = align({ vocal, backing });
    expect(result.confident).toBe(false);
  });

  it('reports silence as having no onsets, with confidence 0', () => {
    const dir = folder();
    const vocal = path.join(dir, 'vocal.wav');
    const backing = path.join(dir, 'backing.wav');
    fs.writeFileSync(vocal, wavFile([new Float32Array(RATE * 5)], { rate: RATE, bits: 16 }));
    fs.writeFileSync(backing, wavFile([backingTrack(HITS, RATE, SECONDS)], { rate: RATE, bits: 16 }));
    const result = align({ vocal, backing });
    expect(result).toMatchObject({ lagSec: 0, confidence: 0, confident: false });
    expect(result.warnings.map((w) => w.code)).toEqual(['NO_ONSETS']);
    expect(result.warnings[0]?.detail).toContain('the vocal file');
  });
});

describe('align: files it cannot read', () => {
  const fails = (fn: () => unknown, code: string, pattern: RegExp) => {
    try {
      fn();
    } catch (error) {
      expect(error).toMatchObject({ code, exitCode: 2 });
      expect((error as Error).message).toMatch(pattern);
      return;
    }
    throw new Error('expected an error');
  };
  const write = (dir: string, name: string, bytes: Buffer): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return file;
  };
  const tone = [vocalTrack(HITS, 0, RATE, 3)];

  it('refuses a file that is not a WAV file, an RF64 file, and a format other than PCM and float', () => {
    const dir = folder();
    const good = write(dir, 'good.wav', wavFile(tone, { rate: RATE, bits: 16 }));
    fails(
      () => frameEnergies(write(dir, 'text.wav', Buffer.from('not a wav file at all'))),
      'WAV_UNSUPPORTED',
      /RIFF\/WAVE/,
    );
    fails(() => frameEnergies(write(dir, 'short.wav', Buffer.from('RIFF'))), 'WAV_UNSUPPORTED', /too short/);
    fails(
      () => frameEnergies(write(dir, 'rf64.wav', wavFile(tone, { rate: RATE, bits: 16, magic: 'RF64' }))),
      'WAV_UNSUPPORTED',
      /RF64/,
    );
    fails(
      () => frameEnergies(write(dir, 'eight.wav', wavFile(tone, { rate: RATE, bits: 8 }))),
      'WAV_UNSUPPORTED',
      /unsupported WAV format.*8 bit/,
    );
    fails(
      () => align({ vocal: good, backing: write(dir, 'eight2.wav', wavFile(tone, { rate: RATE, bits: 8 })) }),
      'WAV_UNSUPPORTED',
      /use 16, 24 or 32 bit PCM or 32 bit float/,
    );
  });

  it('refuses a file with no data chunk, no fmt chunk, or no samples', () => {
    const dir = folder();
    const whole = wavFile(tone, { rate: RATE, bits: 16 });
    // Cut after the fmt chunk: 12 byte header + 8 + 16.
    fails(() => frameEnergies(write(dir, 'nodata.wav', whole.subarray(0, 36))), 'WAV_UNSUPPORTED', /no data chunk/);
    const noFmt = Buffer.concat([whole.subarray(0, 12), whole.subarray(36)]);
    fails(() => frameEnergies(write(dir, 'nofmt.wav', noFmt)), 'WAV_UNSUPPORTED', /data chunk comes before the fmt/);
    fails(
      () => frameEnergies(write(dir, 'empty.wav', wavFile([new Float32Array(0)], { rate: RATE, bits: 16 }))),
      'WAV_UNSUPPORTED',
      /no samples/,
    );
  });

  it('names a file that cannot be opened, and a bad range', () => {
    const dir = folder();
    fails(() => frameEnergies(path.join(dir, 'missing.wav')), 'INPUT_UNREADABLE', /cannot open/);
    const good = write(dir, 'good.wav', wavFile(tone, { rate: RATE, bits: 16 }));
    fails(() => align({ vocal: good, backing: good, maxLagSec: 0 }), 'USAGE', /max-lag-sec/);
    fails(() => align({ vocal: good, backing: good, maxLagSec: 11 }), 'USAGE', /max-lag-sec/);
    fails(() => align({ vocal: good }), 'USAGE', /--vocal.*--backing/);
  });
});

describe('align: the pieces', () => {
  it('cuts frames of 10 ms, drops an incomplete last frame, and averages the channels', () => {
    const dir = folder();
    const file = path.join(dir, 'a.wav');
    const left = new Float32Array(RATE).fill(0.5);
    const right = new Float32Array(RATE).fill(-0.5); // the channels cancel
    fs.writeFileSync(file, wavFile([left, right], { rate: RATE, bits: 16 }));
    const cancelled = frameEnergies(file);
    expect(cancelled.energies).toHaveLength(100);
    expect(Math.max(...cancelled.energies)).toBeLessThan(1e-9);
    // 1.005 s of a constant 0.5: 100 complete frames, the 5 ms left over are dropped.
    fs.writeFileSync(file, wavFile([new Float32Array(RATE + 40).fill(0.5)], { rate: RATE, bits: 16 }));
    const steady = frameEnergies(file);
    expect(steady.energies).toHaveLength(100);
    expect(steady.energies[10]).toBeCloseTo(0.25, 3);
    // A rate that does not divide into frames of 10 ms (44.1 kHz: 441 samples; 22.05 kHz: 220.5) keeps the time.
    fs.writeFileSync(file, wavFile([new Float32Array(22050 * 2).fill(0.5)], { rate: 22050, bits: 16 }));
    expect(frameEnergies(file).energies).toHaveLength(200);
  });

  it('turns steps of level into peaks of the envelope, and silence into nothing', () => {
    const quiet = Array.from({ length: 300 }, () => 1e-9);
    const steps = [...quiet];
    for (const at of [50, 120, 200]) for (let i = 0; i < 20; i++) steps[at + i] = 0.1;
    const envelope = onsetEnvelope(steps);
    const peaks = [...envelope]
      .map((v, i) => [v, i] as const)
      .filter(([v]) => v > 0.2)
      .map(([, i]) => i);
    expect(peaks).toEqual([50, 120, 200]);
    expect(onsetEnvelope(new Array<number>(100).fill(0)).every((v) => v === 0)).toBe(true);
    expect(onsetEnvelope([]).length).toBe(0);
  });

  it('correlates two envelopes at the lag that lines them up, and reads the sign as later or earlier', () => {
    const a = new Float64Array(200);
    const b = new Float64Array(200);
    for (const at of [20, 70, 150]) {
      b[at] = 1;
      a[at + 7] = 1;
    }
    const correlation = crossCorrelation(a, b, 20);
    expect(correlation).toHaveLength(41);
    const best = [...correlation].indexOf(Math.max(...correlation));
    expect(best - 20).toBe(7);
    expect(pickPeak(correlation, 20)).toMatchObject({ lagFrames: 7, atLimit: false });
  });

  it('interpolates a peak between two frames, caps the confidence, and finds a rival', () => {
    // A peak of 1.0 at index 10 with 0.8 and 0.6 beside it: the true top lies a little to the left.
    const curve = new Float64Array(41);
    curve[9] = 0.8;
    curve[10] = 1;
    curve[11] = 0.6;
    const alone = pickPeak(curve, 20) as { lagFrames: number; confidence: number; rival: unknown };
    expect(alone.lagFrames).toBeCloseTo(-10 - 1 / 6, 3);
    expect(alone.confidence).toBe(100);
    expect(alone.rival).toBeNull();
    // A second local maximum of 0.5 further away than 50 ms: the confidence is the ratio.
    curve[30] = 0.5;
    expect((pickPeak(curve, 20) as { confidence: number }).confidence).toBeCloseTo(2, 5);
    // A ripple within 50 ms of the peak is not a rival.
    const ripple = new Float64Array(41);
    ripple[10] = 1;
    ripple[13] = 0.9;
    expect((pickPeak(ripple, 20) as { rival: unknown }).rival).toBeNull();
    // A peak at the end of the range is flagged.
    const edge = new Float64Array(41);
    edge[40] = 1;
    expect(pickPeak(edge, 20)).toMatchObject({ atLimit: true, lagFrames: 20 });
    // No positive correlation at all.
    expect(pickPeak(new Float64Array(41), 20)).toMatchObject({ confidence: 0 });
  });
});

describe('align: the command line', () => {
  async function run(argv: string[], options: Json = {}) {
    let out = '';
    let err = '';
    const code = await main(argv, { out: (t: string) => (out += t), err: (t: string) => (err += t), ...options });
    return { code, out, err, json: out.startsWith('{') ? (JSON.parse(out) as Json) : null };
  }

  it('prints the result as one JSON object, and takes relative paths from the working folder', async () => {
    const dir = folder();
    files(dir, 0.33);
    const result = await run(['align', '--vocal', 'vocal.wav', '--backing', 'backing.wav', '--home', ''], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ tool: 'beat-grid', command: 'align', confident: true });
    expect(Math.abs((result.json?.lagSec as number) - 0.33)).toBeLessThanOrEqual(0.015);
    expect(result.err).toBe('');
  });

  it('accepts --max-lag-sec, and refuses a missing option, a bad number and a missing file with exit code 2', async () => {
    const dir = folder();
    const { vocal, backing } = files(dir, 0.33);
    const narrow = await run(['align', '--vocal', vocal, '--backing', backing, '--max-lag-sec', '1']);
    expect((narrow.json?.searched as Json).maxLagSec).toBe(1);
    const noBacking = await run(['align', '--vocal', vocal]);
    expect(noBacking.code).toBe(2);
    expect(noBacking.out).toContain('align needs --backing');
    expect(noBacking.out).toContain('beat-grid align --vocal');
    const bad = await run(['align', '--vocal', vocal, '--backing', backing, '--max-lag-sec', '99']);
    expect(bad.code).toBe(2);
    const missing = await run(['align', '--vocal', path.join(dir, 'nope.wav'), '--backing', backing]);
    expect(missing.code).toBe(2);
    expect(missing.out).toContain('INPUT_UNREADABLE');
  });
});
