// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Seeded generator of a synthetic sung-like signal with exactly known pitch. It is used wherever a
// check needs audio whose pitch, note starts and note ends are known in advance: the generated
// audio is a harmonic series shaped by fixed vowel formants, with short fades at the note edges, so
// that an F0 estimator trained on voices treats it as voiced. The audio exists only at test run
// time (written to a temporary directory); nothing generated here is committed.
//
// Same seed and same parameters give byte-identical output. The seed only moves the starting
// phases of the harmonics and adds a very quiet noise floor; it never changes the ground truth.

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ToneNote {
  /** Fundamental frequency in Hz. Give either `hz` or `midi`. */
  readonly hz?: number;
  /** MIDI note number (A4 = 69 at `tuningHz`), integer or fractional. */
  readonly midi?: number;
  /** Cents added to `midi`; ignored with `hz`. */
  readonly cents?: number;
  readonly durationSec: number;
  /** Silence after the note; 0.1 s unless given. */
  readonly gapSec?: number;
  /** Vibrato of this note alone; replaces the vibrato of the spec for it. */
  readonly vibrato?: ToneVibrato;
}

export interface ToneVibrato {
  readonly rateHz: number;
  /** Peak deviation in cents. */
  readonly depthCents: number;
}

export interface ToneSpec {
  readonly seed: number;
  /** 44100 unless given. */
  readonly sampleRateHz?: number;
  readonly notes: readonly ToneNote[];
  /** A4 reference used to turn `midi` into Hz and to report cents; 440 unless given. */
  readonly tuningHz?: number;
  readonly vibrato?: ToneVibrato;
  /** Silence before the first note; 0.2 s unless given. */
  readonly leadSec?: number;
  /** Fade-in and fade-out of every note; 0.01 s unless given. */
  readonly fadeSec?: number;
  /** Peak amplitude, 0..1; 0.5 unless given. */
  readonly amplitude?: number;
  /** Amplitude envelope over one note, from its position 0..1 to a gain 0..1; flat unless given. */
  readonly envelope?: (position: number) => number;
}

export interface TruthNote {
  readonly index: number;
  readonly startSec: number;
  readonly endSec: number;
  /** The fundamental the note was generated at (the centre of the vibrato, if any). */
  readonly hz: number;
  /** The nearest integer MIDI note at `tuningHz`. */
  readonly midi: number;
  /** Distance from `midi` in cents, -50 to 50. */
  readonly cents: number;
  /** midi + cents / 100: what an estimator should report as a fractional MIDI number. */
  readonly midiExact: number;
}

export interface Truth {
  readonly sampleRateHz: number;
  readonly tuningHz: number;
  readonly durationSec: number;
  readonly notes: readonly TruthNote[];
}

export interface Tone {
  /** A complete mono 16-bit PCM WAV file. */
  readonly wav: Buffer;
  /** The samples the WAV was made from, before quantizing, in -1..1. */
  readonly samples: Float64Array;
  readonly truth: Truth;
  /** sha256 of `wav`, lower-case hex. */
  readonly sha256: string;
}

const DEFAULT_RATE = 44100;
const DEFAULT_TUNING = 440;
const DEFAULT_GAP_SEC = 0.1;
const DEFAULT_LEAD_SEC = 0.2;
const DEFAULT_FADE_SEC = 0.01;
const DEFAULT_AMPLITUDE = 0.5;
const MAX_HARMONICS = 24;
const NOISE_AMPLITUDE = 1e-4;
/** Silence after the last note, so a tail is never cut. */
const TAIL_SEC = 0.1;

/** Formants of an open /a/ (centre Hz, bandwidth Hz, relative gain). */
const FORMANTS: readonly (readonly [number, number, number])[] = [
  [800, 90, 1],
  [1200, 100, 0.5],
  [2600, 140, 0.25],
];

/** Magnitude of the vowel filter at `hz`: a sum of resonance peaks over a small floor. */
function formantGain(hz: number): number {
  let gain = 0.02;
  for (const [centre, bandwidth, weight] of FORMANTS) {
    const x = (hz - centre) / (bandwidth / 2);
    gain += weight / (1 + x * x);
  }
  return gain;
}

/** mulberry32: a small seeded generator with a fixed algorithm, so the same seed always agrees. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noteHz(note: ToneNote, tuningHz: number): number {
  if (note.hz !== undefined) return note.hz;
  if (note.midi === undefined) throw new Error('a note needs hz or midi');
  return tuningHz * 2 ** ((note.midi + (note.cents ?? 0) / 100 - 69) / 12);
}

/**
 * Rejects parameters the synthesis cannot render. A frequency at or above Nyquist would alias
 * into a different pitch, which would make the ground truth wrong without any visible error.
 * Written so that NaN fails every test.
 */
function checkNote(index: number, hz: number, durationSec: number, gapSec: number, rate: number): void {
  const where = `note ${String(index)}`;
  if (!(hz > 0 && hz < rate / 2))
    throw new Error(
      `${where}: hz ${String(hz)} must be above 0 and below half the sample rate (${String(rate / 2)} Hz)`,
    );
  if (!(durationSec > 0)) throw new Error(`${where}: durationSec ${String(durationSec)} must be above 0`);
  if (!(gapSec >= 0)) throw new Error(`${where}: gapSec ${String(gapSec)} must be 0 or more`);
}

/** Splits a frequency into the nearest integer MIDI note and the distance from it in cents. */
export function hzToMidiCents(hz: number, tuningHz: number): { midi: number; cents: number; midiExact: number } {
  const midiExact = 69 + 12 * Math.log2(hz / tuningHz);
  const midi = Math.round(midiExact);
  return { midi, cents: (midiExact - midi) * 100, midiExact };
}

function encodeWav(samples: Float64Array, sampleRateHz: number): Buffer {
  const dataBytes = samples.length * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRateHz, 24);
  wav.writeUInt32LE(sampleRateHz * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
    wav.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return wav;
}

export function generateTone(spec: ToneSpec): Tone {
  const rate = spec.sampleRateHz ?? DEFAULT_RATE;
  const tuningHz = spec.tuningHz ?? DEFAULT_TUNING;
  const fadeSec = spec.fadeSec ?? DEFAULT_FADE_SEC;
  const amplitude = spec.amplitude ?? DEFAULT_AMPLITUDE;
  const random = seededRandom(spec.seed);
  if (!(fadeSec > 0)) throw new Error(`fadeSec ${String(fadeSec)} must be above 0`);

  // Layout in time first, so the buffer is allocated once.
  const truthNotes: TruthNote[] = [];
  let cursor = spec.leadSec ?? DEFAULT_LEAD_SEC;
  for (const [index, note] of spec.notes.entries()) {
    const hz = noteHz(note, tuningHz);
    const gapSec = note.gapSec ?? DEFAULT_GAP_SEC;
    checkNote(index, hz, note.durationSec, gapSec, rate);
    truthNotes.push({
      index,
      startSec: cursor,
      endSec: cursor + note.durationSec,
      hz,
      ...hzToMidiCents(hz, tuningHz),
    });
    cursor += note.durationSec + gapSec;
  }
  const totalSamples = Math.ceil((cursor + TAIL_SEC) * rate);
  const samples = new Float64Array(totalSamples);

  // Starting phase of each harmonic: the part of the signal that depends on the seed.
  const phases = Array.from({ length: MAX_HARMONICS }, () => random() * 2 * Math.PI);

  for (const truth of truthNotes) {
    const first = Math.round(truth.startSec * rate);
    const count = Math.round((truth.endSec - truth.startSec) * rate);
    const harmonicCount = Math.min(MAX_HARMONICS, Math.floor((rate / 2 / truth.hz) * 0.9));
    // Amplitude of harmonic k: 1/k, shaped by the vowel filter at k * f0. Scaled so the sum of
    // the amplitudes (an upper bound of the waveform) equals the requested peak.
    const gains: number[] = [];
    for (let k = 1; k <= harmonicCount; k++) gains.push(formantGain(k * truth.hz) / k);
    const scale = amplitude / gains.reduce((a, b) => a + b, 0);

    let phase = 0;
    for (let n = 0; n < count; n++) {
      const t = n / rate;
      let f0 = truth.hz;
      const vibrato = spec.notes[truth.index]?.vibrato ?? spec.vibrato;
      if (vibrato) {
        f0 *= 2 ** ((vibrato.depthCents * Math.sin(2 * Math.PI * vibrato.rateHz * t)) / 1200);
      }
      phase += (2 * Math.PI * f0) / rate;
      let value = 0;
      for (let k = 1; k <= harmonicCount; k++) {
        value += (gains[k - 1] ?? 0) * Math.sin(k * phase + (phases[k - 1] ?? 0));
      }
      const edge = Math.min(1, t / fadeSec, (count / rate - t) / fadeSec);
      const gain = Math.max(0, edge) * (spec.envelope?.(count > 1 ? n / (count - 1) : 0) ?? 1);
      const index = first + n;
      if (index < totalSamples) samples[index] = value * scale * gain;
    }
  }

  // The same quiet noise floor everywhere, so silence is not digital zero.
  for (let i = 0; i < totalSamples; i++) samples[i] = (samples[i] ?? 0) + (random() - 0.5) * 2 * NOISE_AMPLITUDE;

  const wav = encodeWav(samples, rate);
  return {
    wav,
    samples,
    truth: { sampleRateHz: rate, tuningHz, durationSec: totalSamples / rate, notes: truthNotes },
    sha256: createHash('sha256').update(wav).digest('hex'),
  };
}

export interface ToneFiles {
  readonly dir: string;
  readonly wavPath: string;
  readonly truthPath: string;
  /** Deletes the directory. */
  cleanup(): Promise<void>;
}

/** Writes the WAV and the truth JSON into a new directory under the system temporary directory. */
export async function writeToneFiles(tone: Tone, name = 'tone'): Promise<ToneFiles> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ot-tone-'));
  const wavPath = path.join(dir, `${name}.wav`);
  const truthPath = path.join(dir, `${name}.truth.json`);
  await writeFile(wavPath, tone.wav);
  await writeFile(truthPath, `${JSON.stringify(tone.truth, null, 2)}\n`, 'utf8');
  return { dir, wavPath, truthPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
