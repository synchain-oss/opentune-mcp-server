// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Synthetic audio for tests of the beat-grid skill: a backing track of noise bursts, a vocal of tone
// bursts at the same moments plus a known delay, and a WAV writer for the formats the skill reads.
// Nothing here is a recording.

/** A small deterministic random sequence in [0, 1). */
export function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(1664525, x) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/** `count` moments from 0.5 s on, 0.3 to 0.9 s apart: irregular, so that only one delay fits two tracks. */
export function irregularHits(count: number, seed = 7): number[] {
  const random = lcg(seed);
  const times: number[] = [];
  let t = 0.5;
  for (let i = 0; i < count; i++) {
    times.push(t);
    t += 0.3 + 0.6 * random();
  }
  return times;
}

/** `count` moments `period` seconds apart from `first` on. */
export function steadyHits(count: number, period: number, first = 0.5): number[] {
  return Array.from({ length: count }, (_, i) => first + i * period);
}

/** A backing track: a burst of noise (decaying in about 20 ms) at each moment. */
export function backingTrack(times: readonly number[], rate: number, seconds: number, seed = 3): Float32Array {
  const random = lcg(seed);
  const out = new Float32Array(Math.round(rate * seconds));
  for (const time of times) {
    const start = Math.round(time * rate);
    const length = Math.round(0.12 * rate);
    for (let n = 0; n < length && start + n < out.length; n++) {
      if (start + n < 0) continue;
      out[start + n] = (random() * 2 - 1) * 0.8 * Math.exp(-n / rate / 0.02);
    }
  }
  return out;
}

/** A vocal: a 150 ms tone with a 10 ms attack at each moment plus `delay` seconds. */
export function vocalTrack(times: readonly number[], delay: number, rate: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (const time of times) {
    const start = Math.round((time + delay) * rate);
    const length = Math.round(0.15 * rate);
    for (let n = 0; n < length; n++) {
      const at = start + n;
      if (at < 0 || at >= out.length) continue;
      const t = n / rate;
      out[at] = Math.sin(2 * Math.PI * 220 * t) * 0.5 * Math.min(1, t / 0.01) * (1 - n / length);
    }
  }
  return out;
}

export interface WavOptions {
  readonly rate: number;
  readonly bits: 8 | 16 | 24 | 32 | 64;
  /** IEEE float samples instead of PCM. */
  readonly float?: boolean;
  /** The WAVE_FORMAT_EXTENSIBLE header, with the sub format of the samples. */
  readonly extensible?: boolean;
  /** A LIST chunk of odd length before the data (it is padded to an even length). */
  readonly listChunk?: boolean;
  /** What the data chunk says about its own size: its real size, 0, or 0xFFFFFFFF (a stream). */
  readonly dataSize?: 'exact' | 'zero' | 'max' | 'too-large';
  /** The RIFF magic, for a file that is not one. */
  readonly magic?: string;
}

/** A WAV file of the channels given (all of the same length), in the format asked for. */
export function wavFile(channels: readonly Float32Array[], options: WavOptions): Buffer {
  const { rate, bits } = options;
  const frames = channels[0]?.length ?? 0;
  const bytes = bits / 8;
  const data = Buffer.alloc(frames * channels.length * bytes);
  for (let i = 0; i < frames; i++) {
    channels.forEach((channel, c) => {
      const x = Math.max(-1, Math.min(1, channel[i] ?? 0));
      const at = (i * channels.length + c) * bytes;
      if (options.float === true) {
        if (bits === 32) data.writeFloatLE(x, at);
        else data.writeDoubleLE(x, at);
      } else if (bits === 8) data.writeUInt8(Math.round(x * 127) + 128, at);
      else if (bits === 16) data.writeInt16LE(Math.round(x * 32767), at);
      else if (bits === 24) data.writeIntLE(Math.round(x * 8388607), at, 3);
      else data.writeInt32LE(Math.round(x * 2147483647), at);
    });
  }
  const tag = options.float === true ? 3 : 1;
  const fmt = Buffer.alloc(options.extensible === true ? 40 : 16);
  fmt.writeUInt16LE(options.extensible === true ? 0xfffe : tag, 0);
  fmt.writeUInt16LE(channels.length, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * channels.length * bytes, 8);
  fmt.writeUInt16LE(channels.length * bytes, 12);
  fmt.writeUInt16LE(bits, 14);
  if (options.extensible === true) {
    fmt.writeUInt16LE(22, 16);
    fmt.writeUInt16LE(bits, 18);
    fmt.writeUInt32LE(channels.length === 1 ? 4 : 3, 20);
    fmt.writeUInt16LE(tag, 24); // the first two bytes of the sub format GUID are the format tag
    Buffer.from('000000001000800000aa00389b71', 'hex').copy(fmt, 26);
  }
  const chunk = (id: string, body: Buffer, sizeField?: number): Buffer => {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'latin1');
    head.writeUInt32LE(sizeField ?? body.length, 4);
    return Buffer.concat([head, body, body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const dataField =
    options.dataSize === 'zero'
      ? 0
      : options.dataSize === 'max'
        ? 0xffffffff
        : options.dataSize === 'too-large'
          ? data.length + 1000
          : data.length;
  const parts = [chunk('fmt ', fmt)];
  if (options.listChunk === true) parts.push(chunk('LIST', Buffer.from('INFOISFT\x05\x00\x00\x00test\x00', 'latin1')));
  parts.push(chunk('data', data, dataField));
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write(options.magic ?? 'RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WAVE', 8, 'latin1');
  return Buffer.concat([head, body]);
}
