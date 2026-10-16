// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Synthetic songs for the key estimation tests, rendered at run time (no audio file is checked in):
// chord progressions with a bass line as additive tones with harmonics, encoded as WAV in the
// sample formats the reader supports.

/** One chord: MIDI notes above, a bass note, and how long it lasts. */
export interface Chord {
  readonly notes: readonly number[];
  readonly bass: number | null;
  readonly sec: number;
}

/** Triads by root pitch class: major and minor, in a middle register (from MIDI 60 up). */
export const major = (root: number, bass = true, sec = 2): Chord => triad(root, [0, 4, 7], bass, sec);
export const minor = (root: number, bass = true, sec = 2): Chord => triad(root, [0, 3, 7], bass, sec);
/** Root and fifth only: neither major nor minor. */
export const power = (root: number, bass = true, sec = 2): Chord => triad(root, [0, 7, 12], bass, sec);

function triad(root: number, steps: readonly number[], bass: boolean, sec: number): Chord {
  const base = 60 + (root % 12);
  return { notes: steps.map((s) => base + s), bass: bass ? 36 + (root % 12) : null, sec };
}

export interface RenderOptions {
  readonly rateHz: number;
  /** Detuning of every note against A4 = 440 Hz, in cents. */
  readonly tuningCents?: number;
  /** How many times the progression is played. */
  readonly repeat?: number;
}

/** Renders the chords one after the other as a mono signal at -1..1. */
export function renderSong(chords: readonly Chord[], options: RenderOptions): Float64Array {
  const rate = options.rateHz;
  const sequence = Array.from({ length: options.repeat ?? 1 }, () => chords).flat();
  const total = sequence.reduce((s, c) => s + c.sec, 0);
  const out = new Float64Array(Math.round(total * rate));
  const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12 + (options.tuningCents ?? 0) / 1200);
  let start = 0;
  for (const chord of sequence) {
    const from = Math.round(start * rate);
    const length = Math.round(chord.sec * rate);
    const voices = [
      ...chord.notes.map((m) => ({ f: hz(m), gain: 0.12, harmonics: 6 })),
      ...(chord.bass === null ? [] : [{ f: hz(chord.bass), gain: 0.18, harmonics: 4 }]),
    ];
    for (const voice of voices) {
      for (let h = 1; h <= voice.harmonics; h++) {
        const w = (2 * Math.PI * voice.f * h) / rate;
        if (voice.f * h >= rate / 2) break;
        for (let n = 0; n < length; n++) {
          const env = Math.min(1, n / (0.01 * rate), (length - n) / (0.05 * rate));
          out[from + n] = (out[from + n] ?? 0) + ((voice.gain * env) / h) * Math.sin(w * n);
        }
      }
    }
    start += chord.sec;
  }
  return out;
}

/** A sung line: the MIDI notes in turn, each `noteSec` long, with a 0.6 s breath after every `phrase` notes. */
export function melody(
  notes: readonly number[],
  noteSec: number,
  totalSec: number,
  phrase = 4,
): { startSec: number; endSec: number; midi: number }[] {
  const out: { startSec: number; endSec: number; midi: number }[] = [];
  for (let t = 0, i = 0; t + noteSec <= totalSec; i++) {
    out.push({ startSec: t, endSec: t + noteSec * 0.95, midi: notes[i % notes.length] ?? 60 });
    t += noteSec + ((i + 1) % phrase === 0 ? 0.6 : 0);
  }
  return out;
}

export type SampleKind = 'pcm16' | 'pcm24' | 'pcm32' | 'float32';

/** A WAV file of the channels (equal lengths) in the given sample format. */
export function encodeWav(
  channels: readonly Float64Array[],
  rateHz: number,
  kind: SampleKind,
  extensible = false,
): Buffer {
  const bits = kind === 'pcm16' ? 16 : kind === 'pcm24' ? 24 : 32;
  const width = bits / 8;
  const frames = channels[0]?.length ?? 0;
  const data = Buffer.alloc(frames * channels.length * width);
  for (let f = 0; f < frames; f++) {
    channels.forEach((channel, c) => {
      const v = Math.max(-1, Math.min(1, channel[f] ?? 0));
      const at = (f * channels.length + c) * width;
      if (kind === 'float32') data.writeFloatLE(v, at);
      else if (kind === 'pcm16') data.writeInt16LE(Math.round(v * 32767), at);
      else if (kind === 'pcm24') data.writeIntLE(Math.round(v * 8388607), at, 3);
      else data.writeInt32LE(Math.round(v * 2147483647), at);
    });
  }
  const tag = kind === 'float32' ? 3 : 1;
  const fmt = Buffer.alloc(extensible ? 40 : 16);
  fmt.writeUInt16LE(extensible ? 0xfffe : tag, 0);
  fmt.writeUInt16LE(channels.length, 2);
  fmt.writeUInt32LE(rateHz, 4);
  fmt.writeUInt32LE(rateHz * channels.length * width, 8);
  fmt.writeUInt16LE(channels.length * width, 12);
  fmt.writeUInt16LE(bits, 14);
  if (extensible) {
    fmt.writeUInt16LE(22, 16);
    fmt.writeUInt16LE(bits, 18);
    fmt.writeUInt16LE(tag, 24);
    Buffer.from([0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]).copy(fmt, 26);
  }
  const chunk = (id: string, body: Buffer) => {
    const header = Buffer.alloc(8);
    header.write(id, 0, 'latin1');
    header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body, Buffer.alloc(body.length % 2)]);
  };
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), chunk('fmt ', fmt), chunk('data', data)]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
