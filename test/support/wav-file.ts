// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// WAV files for tests of the mock's import, built in memory at run time: a tone or silence in the
// layout a test asks for. Tests write them below the system temporary directory and delete them
// afterwards; no audio file is checked in.

export interface WavOptions {
  readonly seconds: number;
  readonly rate?: number;
  readonly channels?: number;
  readonly bits?: 8 | 16 | 24 | 32 | 64;
  /** IEEE float samples instead of integers. */
  readonly float?: boolean;
  /** A tone (default) or silence. */
  readonly voiced?: boolean;
  /** WAVE_FORMAT_EXTENSIBLE with a PCM sub-format. */
  readonly extensible?: boolean;
  /** A chunk of odd size before the data. */
  readonly extraChunk?: boolean;
  /** Overrides the format tag, the block alignment or leaves out the data chunk. */
  readonly formatTag?: number;
  readonly blockAlign?: number;
  readonly noData?: boolean;
}

function chunk(id: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, Buffer.alloc(body.length % 2)]);
}

export function wavFile(options: WavOptions): Buffer {
  const rate = options.rate ?? 16_000;
  const channels = options.channels ?? 1;
  const bits = options.bits ?? 16;
  const bytes = bits / 8;
  const frames = Math.round(options.seconds * rate);
  const data = Buffer.alloc(frames * channels * bytes);
  if (options.voiced !== false) {
    for (let i = 0; i < frames * channels; i++) {
      const value = 0.3 * Math.sin((2 * Math.PI * 220 * Math.floor(i / channels)) / rate);
      const at = i * bytes;
      if (options.float === true) {
        if (bits === 32) data.writeFloatLE(value, at);
      } else if (bits === 8) data.writeUInt8(Math.round(128 + value * 127), at);
      else if (bits === 16) data.writeInt16LE(Math.round(value * 32767), at);
      else if (bits === 24) data.writeIntLE(Math.round(value * 8388607), at, 3);
      else if (bits === 32) data.writeInt32LE(Math.round(value * 2147483647), at);
    }
  }
  const tag = options.formatTag ?? (options.float === true ? 3 : 1);
  const fmt = Buffer.alloc(options.extensible === true ? 40 : 16);
  fmt.writeUInt16LE(options.extensible === true ? 0xfffe : tag, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * channels * bytes, 8);
  fmt.writeUInt16LE(options.blockAlign ?? channels * bytes, 12);
  fmt.writeUInt16LE(bits, 14);
  if (options.extensible === true) {
    fmt.writeUInt16LE(22, 16);
    fmt.writeUInt16LE(bits, 18);
    fmt.writeUInt16LE(tag, 24);
  }
  const chunks = [
    chunk('fmt ', fmt),
    ...(options.extraChunk === true ? [chunk('LIST', Buffer.from('abcde'))] : []),
    ...(options.noData === true ? [] : [chunk('data', data)]),
  ];
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), ...chunks]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
