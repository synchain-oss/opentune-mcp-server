// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The parts of key estimation below the tool: key names and relations, correlation and fusion of the
// evidence (with the vocal check of the dominant and parallel-minor confusions), tuning offsets, the
// sung-note histogram, local keys by Viterbi, the WAV reader with its formats and refusals, and the
// chroma of synthetic chord progressions. All audio is generated here; no audio file is checked in.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  bassReliability,
  changeCost,
  estimateKey,
  fifthsDistance,
  flatSeventhProminent,
  indexOf,
  inScaleShare,
  keyCorrelations,
  keyName,
  keyOf,
  mixReliability,
  pearson,
  relativeIndex,
  scalePitchClasses,
  sameScaleSetIndex,
  segmentKeys,
  softmax,
  steadyFrames,
  tuningOffset,
  viterbi,
  vocalHistogram,
  vocalReliability,
  type KeyEstimate,
  type SourceEvidence,
} from '../../src/analysis/key.js';
import { analyzeAudio, fft, summarizeRange } from '../../src/audio/chroma.js';
import { MAX_WAV_BYTES, WavError, lowPass, parseFormat, readWav, toMono } from '../../src/audio/wav.js';
import { tempDir } from '../support/context.js';
import { encodeWav, major, melody, minor, power, renderSong, type Chord } from '../support/song.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function files() {
  const t = tempDir('ot-key-');
  cleanup.push(t.remove);
  return (name: string, bytes: Buffer) => {
    const file = path.join(t.dir, name);
    fs.writeFileSync(file, bytes);
    return file;
  };
}

const C = indexOf({ root: 0, scale: 'major' });
const name = (estimate: KeyEstimate | null, rank = 0) => keyName(keyOf(estimate?.order[rank] ?? -1));

/** Mix and bass evidence of a progression played `repeat` times at 11025 Hz. */
function mixSources(chords: readonly Chord[], repeat = 3): SourceEvidence[] {
  const features = analyzeAudio(Float32Array.from(renderSong(chords, { rateHz: 11_025, repeat })), 11_025);
  const s = summarizeRange(features);
  return [
    { name: 'mix', vector: s.chroma, reliability: mixReliability(s.activeSec) },
    { name: 'bass', vector: s.bass, reliability: bassReliability(s.activeSec, s.bassShare) },
  ];
}

function vocalSource(notes: readonly number[], totalSec = 24): SourceEvidence {
  const v = vocalHistogram(melody(notes, 0.5, totalSec), 0);
  return { name: 'vocals', vector: v.histogram, reliability: vocalReliability(v) };
}

describe('keys', () => {
  it('names keys with their usual spelling and finds the relative key', () => {
    expect(keyName({ root: 3, scale: 'major' })).toBe('Eb major');
    expect(keyName({ root: 1, scale: 'major' })).toBe('Db major');
    expect(keyName({ root: 1, scale: 'minor' })).toBe('C# minor');
    expect(keyOf(relativeIndex(C))).toEqual({ root: 9, scale: 'minor' });
    expect(keyOf(relativeIndex(indexOf({ root: 9, scale: 'minor' })))).toEqual({ root: 0, scale: 'major' });
    expect(indexOf({ root: 14, scale: 'minor' })).toBe(14);
  });

  it('knows the pitch classes of every OTCP scale and nothing else', () => {
    expect(scalePitchClasses(2, 'major')).toEqual([2, 4, 6, 7, 9, 11, 1]);
    expect(scalePitchClasses(0, 'chromatic')).toHaveLength(12);
    expect(scalePitchClasses(0, 'pentatonicMinor')).toEqual([0, 3, 5, 7, 10]);
    expect(scalePitchClasses(0, 'lydian')).toBeNull();
    // OpenTune names scales in camelCase; a name that an object inherits must not resolve.
    expect(scalePitchClasses(0, 'constructor')).toBeNull();
  });

  it('measures circle-of-fifths distance between key signatures and prices key changes by it', () => {
    const minorOf = (root: number) => indexOf({ root, scale: 'minor' });
    expect(fifthsDistance(C, 7)).toBe(1);
    expect(fifthsDistance(C, minorOf(9))).toBe(0);
    expect(fifthsDistance(C, 1)).toBe(5);
    expect(fifthsDistance(C, 6)).toBe(6);
    expect(changeCost(C, C)).toBe(0);
    expect(changeCost(C, 1)).toBeGreaterThan(changeCost(C, 7));
  });
});

describe('correlation and fusion', () => {
  it('correlates, returning 0 for a constant vector', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0);
    // A shorter second vector reads as zeros beyond its end.
    expect(pearson([1, 2, 3], [1, 2])).toBeCloseTo(pearson([1, 2, 3], [1, 2, 0]), 12);
    const scale = Array.from({ length: 12 }, (_, p) => (scalePitchClasses(0, 'major')?.includes(p) ? 1 : 0));
    const r = keyCorrelations(scale);
    expect([...r.keys()].sort((a, b) => (r[b] ?? 0) - (r[a] ?? 0))[0]).toBe(C);
    expect(softmax([0, 0], 5)).toEqual(Float64Array.of(0.5, 0.5));
  });

  it('needs usable evidence', () => {
    expect(estimateKey([])).toBeNull();
    expect(estimateKey([{ name: 'mix', vector: new Float64Array(12), reliability: 1 }])).toBeNull();
    expect(estimateKey([{ name: 'mix', vector: new Float64Array(12).fill(1), reliability: 1 }])).toBeNull();
    expect(
      estimateKey([{ name: 'mix', vector: Float64Array.of(1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1), reliability: 0 }]),
    ).toBeNull();
  });

  it('weights the sources by base weight and reliability', () => {
    const est = estimateKey([
      ...mixSources([major(0), major(5), major(7), major(0)]),
      vocalSource([60, 62, 64, 65, 67]),
    ]);
    expect(name(est)).toBe('C major');
    const w = est?.weights ?? { mix: 0, bass: 0, vocals: 0 };
    expect(w.mix + w.bass + w.vocals).toBeCloseTo(1, 10);
    expect(w.mix).toBeGreaterThan(w.vocals);
  });

  it('lets the vocals correct a mix that leans to the dominant', () => {
    // G, G, C, G: the mix alone hears G major; the singer's F belongs to C major only.
    const mix = mixSources([major(7), major(7), major(0), major(7)]);
    expect(name(estimateKey(mix))).toBe('G major');
    const fused = estimateKey([...mix, vocalSource([60, 62, 64, 65, 67, 65, 64, 62, 60])]);
    expect(name(fused)).toBe('C major');
    expect(fused?.scaleSetConfidence).toBeGreaterThan(0.8);
  });

  it('lets the vocals correct the parallel minor where the mix has no thirds', () => {
    const mix = mixSources([power(0), power(5), power(7), power(0)]);
    const alone = estimateKey(mix);
    expect(alone?.order.slice(0, 3).map((k) => keyName(keyOf(k)))).toContain('C minor');
    expect(alone?.scaleSetConfidence).toBeLessThan(0.6);
    const fused = estimateKey([...mix, vocalSource([64, 67, 69, 71, 72, 67, 64, 60])]);
    expect(name(fused)).toBe('C major');
    expect(fused?.probabilities[indexOf({ root: 0, scale: 'minor' })]).toBeLessThan(0.05);
  });

  it('estimates from the vocals alone, less sharply when there is little of them', () => {
    const d = estimateKey([vocalSource([62, 64, 66, 67, 69, 71, 73, 74, 69, 66, 62])]);
    expect(['D major', 'B minor']).toContain(name(d));
    expect(d?.weights).toEqual({ mix: 0, bass: 0, vocals: 1 });
    const short = estimateKey([vocalSource([62, 64, 66, 69], 3)]);
    expect(short?.scaleSetConfidence).toBeLessThan(0.6);
  });

  it('reports the share of sung time inside a scale', () => {
    const v = vocalHistogram(melody([60, 62, 64, 65, 67], 0.5, 10), 0).histogram;
    expect(inScaleShare(v, C)).toBeCloseTo(1, 5);
    expect(inScaleShare(v, 7)).toBeLessThan(0.9);
    expect(inScaleShare(new Float64Array(12), C)).toBe(0);
  });
});

describe('tuning and the sung-note histogram', () => {
  it('takes the circular mean of the distances to the nearest semitone', () => {
    expect(tuningOffset([])).toBeNull();
    const t = tuningOffset([60.2, 64.21, 67.19, 71.2].map((midi) => ({ midi, weight: 1 })));
    expect(t?.offsetCents).toBeCloseTo(20, 0);
    expect(t?.reliability).toBeGreaterThan(0.99);
    // Readings either side of the half-semitone point average across it, not to 0.
    expect(Math.abs(tuningOffset([60.49, 61.51].map((midi) => ({ midi, weight: 1 })))?.offsetCents ?? 0)).toBeCloseTo(
      50,
      0,
    );
  });

  it('keeps steady voiced frames only', () => {
    // The jump from 60 to 62 and the frames next to an unvoiced one are left out.
    expect(steadyFrames([null, 60, 60.01, 60.02, 62, 62, 62, null, 62])).toEqual([
      { midi: 60.01, weight: 1 },
      { midi: 62, weight: 1 },
    ]);
  });

  it('weights notes by duration, phrase ends by more, and keeps to the range', () => {
    const events = [
      { startSec: 0, endSec: 1, midi: 60 },
      { startSec: 1, endSec: 2, midi: 62 },
      { startSec: 3, endSec: 4, midi: 64.2 },
    ];
    const all = vocalHistogram(events, 20);
    expect(all.eventCount).toBe(3);
    expect(all.seconds).toBeCloseTo(3, 10);
    expect((all.histogram[2] ?? 0) / (all.histogram[0] ?? 1)).toBeCloseTo(1.5, 1);
    expect(all.histogram[4]).toBeCloseTo(1.5, 5);
    const part = vocalHistogram(events, 0, 0.5, 1.5);
    expect(part.seconds).toBeCloseTo(1, 10);
    expect(part.eventCount).toBe(2);
    expect(vocalReliability(vocalHistogram([], 0))).toBe(0);
  });
});

describe('local keys', () => {
  const window = (
    startSec: number,
    key: number | null,
    p = 0.9,
  ): { startSec: number; endSec: number; estimate: KeyEstimate | null } => {
    if (key === null) return { startSec, endSec: startSec + 12, estimate: null };
    const probabilities = new Float64Array(24).fill((1 - p) / 23);
    probabilities[key] = p;
    return {
      startSec,
      endSec: startSec + 12,
      estimate: {
        probabilities,
        order: [key],
        scaleSetConfidence: p,
        tonicConfidence: 1,
        weights: { mix: 1, bass: 0, vocals: 0 },
      },
    };
  };

  it('finds a key change that the evidence carries, and ignores a single odd window', () => {
    const steps = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36];
    const change = segmentKeys(
      steps.map((s, i) => window(s, i < 7 ? C : 1)),
      48,
    );
    expect(change.map((s) => [s.key, s.startSec, s.endSec])).toEqual([
      [C, 0, 32],
      [1, 32, 48],
    ]);
    expect(change[1]?.scaleSetConfidence).toBeGreaterThan(0.9);
    const blip = segmentKeys(
      steps.map((s, i) => window(s, i === 4 ? 7 : C, i === 4 ? 0.5 : 0.9)),
      48,
    );
    expect(blip.map((s) => s.key)).toEqual([C]);
  });

  it('merges neighbouring segments that share their scale set and keeps real changes', () => {
    const steps = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36];
    const Am = 12 + 9;
    const relative = segmentKeys(
      steps.map((s, i) => window(s, i < 5 ? C : Am)),
      48,
    );
    expect(relative).toHaveLength(1);
    expect(relative[0]).toMatchObject({ startSec: 0, endSec: 48 });
    expect(relative[0]?.scaleSetConfidence).toBeGreaterThan(0.8);
    expect(sameScaleSetIndex(C, Am)).toBe(true);
    expect(sameScaleSetIndex(C, 1)).toBe(false);
  });

  it('names a merged segment after the key that covers more of its time, the earlier one on a tie', () => {
    const Am = 12 + 9;
    const steps = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36];
    // A window owns the time up to half way to its neighbour, so `split` windows of the first key cover 4 * split + 4 s.
    const merged = (split: number, first: number, second: number) =>
      segmentKeys(
        steps.map((s, i) => window(s, i < split ? first : second)),
        48,
      ).map((s) => s.key);
    expect(merged(5, C, Am)).toEqual([C]);
    expect(merged(5, Am, C)).toEqual([Am]);
    expect(merged(6, C, Am)).toEqual([C]);
    expect(merged(4, C, Am)).toEqual([Am]);
    expect(merged(6, Am, C)).toEqual([Am]);
    expect(merged(4, Am, C)).toEqual([C]);
  });

  it('keeps a real key change next to a merged pair of relative keys', () => {
    const Am = 12 + 9;
    const steps = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36];
    const path = segmentKeys(
      steps.map((s, i) => window(s, i < 3 ? C : i < 6 ? Am : 1)),
      48,
    );
    expect(path.map((s) => [s.key, s.startSec, s.endSec])).toEqual([
      [C, 0, 28],
      [1, 28, 48],
    ]);
  });

  it('carries the key through windows without evidence', () => {
    expect(segmentKeys([], 10)).toEqual([]);
    expect(viterbi([])).toEqual([]);
    const gap = segmentKeys([window(0, C), window(4, null), window(8, C)], 20);
    expect(gap).toHaveLength(1);
    expect(segmentKeys([window(0, null)], 12)[0]?.scaleSetConfidence).toBe(0);
  });
});

describe('the flat-seventh hint', () => {
  it('fires for a major key whose flat seventh outweighs its leading tone', () => {
    const mixolydian = Float64Array.from({ length: 12 }, (_, p) => ([0, 2, 4, 5, 7, 9, 10].includes(p) ? 1 : 0));
    expect(flatSeventhProminent(mixolydian, C)).toBe(true);
    expect(flatSeventhProminent(mixolydian, indexOf({ root: 0, scale: 'minor' }))).toBe(false);
    const ionian = Float64Array.from({ length: 12 }, (_, p) => ([0, 2, 4, 5, 7, 9, 11].includes(p) ? 1 : 0));
    expect(flatSeventhProminent(ionian, C)).toBe(false);
    expect(flatSeventhProminent(new Float64Array(12), C)).toBe(false);
    expect(flatSeventhProminent(new Float64Array(12).fill(1), C)).toBe(false);
  });
});

describe('WAV reader', () => {
  const tone = (seconds: number, rate: number) =>
    Float64Array.from({ length: Math.round(seconds * rate) }, (_, n) => 0.5 * Math.sin((2 * Math.PI * 440 * n) / rate));

  it.each([
    ['16-bit mono', 'pcm16', 1, 11_025, false, 11_025],
    ['24-bit stereo, decimated by 4', 'pcm24', 2, 44_100, false, 11_025],
    ['32-bit float stereo, decimated by 4', 'float32', 2, 48_000, false, 12_000],
    ['32-bit extensible mono, decimated by 2', 'pcm32', 1, 22_050, true, 11_025],
  ] as const)('reads %s', async (_label, kind, channels, rate, extensible, analysisRate) => {
    const write = files();
    const signal = tone(1.5, rate);
    const file = write(
      'a.wav',
      encodeWav(
        Array.from({ length: channels }, () => signal),
        rate,
        kind,
        extensible,
      ),
    );
    const wav = await readWav(file);
    expect(wav).toMatchObject({
      sampleRateHz: rate,
      channels,
      bits: kind === 'pcm16' ? 16 : kind === 'pcm24' ? 24 : 32,
      float: kind === 'float32',
      rateHz: analysisRate,
    });
    expect(wav.durationSec).toBeCloseTo(1.5, 3);
    expect(wav.samples.length).toBeGreaterThan(1.45 * analysisRate);
    // The 440 Hz tone passes the decimation filter at its level.
    const peak = wav.samples.subarray(1000).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeGreaterThan(0.45);
    expect(peak).toBeLessThan(0.55);
  });

  it('filters what would fold back into the analysis band', () => {
    const h = lowPass(4);
    expect(h).toHaveLength(129);
    expect(h.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 10);
    // 9 kHz at 44.1 kHz lies above the 5.5 kHz Nyquist of the decimated signal.
    const response = Math.abs(h.reduce((s, v, n) => s + v * Math.cos((2 * Math.PI * 9000 * n) / 44_100), 0));
    expect(response).toBeLessThan(1e-3);
  });

  it('mixes the channels to mono and replaces non-finite floats by silence', () => {
    const bytes = Buffer.alloc(16);
    bytes.writeFloatLE(0.5, 0);
    bytes.writeFloatLE(-0.5, 4);
    bytes.writeFloatLE(Number.NaN, 8);
    bytes.writeFloatLE(0, 12);
    expect(Array.from(toMono(bytes, { sampleRateHz: 8000, channels: 2, bits: 32, float: true }))).toEqual([0, 0]);
  });

  /** A fmt chunk body with the given fields. */
  const fmt = (
    tag: number,
    channels: number,
    rate: number,
    bits: number,
    blockAlign = channels * (bits / 8),
    size = 16,
  ) => {
    const b = Buffer.alloc(size);
    b.writeUInt16LE(tag, 0);
    b.writeUInt16LE(channels, 2);
    b.writeUInt32LE(rate, 4);
    b.writeUInt16LE(blockAlign, 12);
    b.writeUInt16LE(bits, 14);
    return b;
  };

  it.each([
    ['a short fmt chunk', Buffer.alloc(10), /too short/],
    ['8-bit PCM', fmt(1, 1, 8000, 8), /only 16, 24 or 32-bit PCM/],
    ['64-bit float', fmt(3, 1, 8000, 64), /only 16, 24 or 32-bit PCM/],
    ['ADPCM', fmt(2, 1, 8000, 16), /format 2/],
    ['three channels', fmt(1, 3, 8000, 16), /3 channels/],
    ['a sample rate of 4 kHz', fmt(1, 1, 4000, 16), /sample rate 4000/],
    ['a wrong block alignment', fmt(1, 2, 8000, 16, 3), /block alignment/],
    ['an extensible format of unknown kind', fmt(0xfffe, 1, 8000, 16, 2, 40), /unknown sub-format/],
  ])('refuses %s', (_label, body, message) => {
    expect(() => parseFormat(body)).toThrow(message);
  });

  it('refuses files that are not WAV, have no data, are too large, are missing or are folders', async () => {
    const write = files();
    const problem = async (file: string, max?: number) => {
      try {
        await readWav(file, max);
      } catch (error) {
        return error instanceof WavError ? [error.problem, error.message] : ['other', String(error)];
      }
      return ['none', ''];
    };
    const good = encodeWav([tone(0.5, 8000)], 8000, 'pcm16');
    expect(await problem(write('id3.wav', Buffer.from('ID3\u0004 not a riff file at all')))).toEqual([
      'unsupported',
      'the file is not a RIFF/WAVE file',
    ]);
    const noData = Buffer.from(good.subarray(0, 36));
    noData.writeUInt32LE(28, 4);
    expect((await problem(write('nodata.wav', noData)))[0]).toBe('unsupported');
    expect(await problem(write('big.wav', good), 100)).toEqual([
      'too_large',
      `the file is ${String(good.length)} bytes; the limit is 100 bytes`,
    ]);
    expect((await problem(path.join(path.dirname(write('x.wav', good)), 'missing.wav')))[0]).toBe('not_found');
    const folder = path.join(path.dirname(write('y.wav', good)), 'folder.wav');
    fs.mkdirSync(folder);
    expect(['not_a_file', 'read_failed']).toContain((await problem(folder))[0]);
    expect(MAX_WAV_BYTES).toBe(256 * 1024 * 1024);
  });

  it('reads a data chunk that claims more bytes than the file has', async () => {
    const write = files();
    const bytes = encodeWav([tone(1, 8000)], 8000, 'pcm16');
    bytes.writeUInt32LE(0xffffffff, 40);
    expect((await readWav(write('cut.wav', bytes))).durationSec).toBeCloseTo(1, 3);
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO without waiting for a writer', async () => {
    const dir = path.dirname(files()('f.wav', Buffer.alloc(0)));
    const fifo = path.join(dir, 'pipe.wav');
    execFileSync('mkfifo', [fifo]);
    await expect(readWav(fifo)).rejects.toMatchObject({ problem: 'not_a_file' });
  });

  it('reports a path the system cannot open as a read failure with its code', async () => {
    await expect(readWav('bad\u0000name.wav')).rejects.toMatchObject({
      problem: 'read_failed',
      message: 'the file could not be read (ERR_INVALID_ARG_VALUE)',
    });
  });
});

describe('chroma', () => {
  it('computes an FFT', () => {
    const re = Float64Array.from({ length: 8 }, (_, n) => Math.cos((2 * Math.PI * n) / 8));
    const im = new Float64Array(8);
    fft(re, im);
    expect(re[1]).toBeCloseTo(4, 10);
    expect(re[7]).toBeCloseTo(4, 10);
    expect(Math.abs(re[2] ?? 1)).toBeLessThan(1e-9);
  });

  it('finds the notes, the bass line and the tuning of a progression', () => {
    const features = analyzeAudio(
      Float32Array.from(
        renderSong([major(0), major(5), major(7), major(0)], { rateHz: 11_025, repeat: 2, tuningCents: -12 }),
      ),
      11_025,
    );
    const s = summarizeRange(features);
    const top3 = [...s.chroma.keys()].sort((a, b) => (s.chroma[b] ?? 0) - (s.chroma[a] ?? 0)).slice(0, 3);
    expect(top3).toContain(0);
    expect(top3).toContain(7);
    expect(s.bassShare).toBe(1);
    expect(s.bass[0]).toBeGreaterThan(s.bass[2] ?? 1);
    expect(features.tuning?.offsetCents).toBeCloseTo(-12, 0);
    const later = summarizeRange(features, 8, 16);
    expect(later.activeSec).toBeGreaterThan(6);
    expect(later.activeSec).toBeLessThan(9);
  });

  it('marks silence and handles signals shorter than a frame', () => {
    const silent = analyzeAudio(new Float32Array(20_000), 11_025);
    expect(summarizeRange(silent).activeSec).toBe(0);
    expect(silent.tuning).toBeNull();
    expect(analyzeAudio(new Float32Array(0), 11_025).times).toHaveLength(0);
    const short = analyzeAudio(Float32Array.from(renderSong([minor(9, false, 0.2)], { rateHz: 16_000 })), 16_000);
    expect(short.times).toHaveLength(1);
    expect(summarizeRange(short).bassShare).toBe(0);
  });
});
