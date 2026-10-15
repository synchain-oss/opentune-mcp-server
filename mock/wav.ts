// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// A minimal WAV reader for the mock's import: it reads the header (channels, sample rate, length)
// and decides whether the audio has any signal, which is all the mock's stand-in for analysis
// needs. Integer PCM (8 to 32 bits) and 32-bit float are understood; anything else is not decodable.

export type WavReading =
  | {
      readonly ok: true;
      readonly channelCount: number;
      readonly sampleRateHz: number;
      readonly durationSec: number;
      /** Some sample is louder than the noise floor. */
      readonly voiced: boolean;
    }
  | { readonly ok: false };

/** Peak level, as a fraction of full scale, below which a file counts as silent. */
export const SILENCE_PEAK = 0.001;

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

interface Format {
  readonly tag: number;
  readonly channels: number;
  readonly rate: number;
  readonly bits: number;
  readonly blockAlign: number;
}

/** A sample as a fraction of full scale, or undefined for a layout the reader does not know. */
function sampleAt(data: Buffer, offset: number, format: Format): number | undefined {
  const { tag, bits } = format;
  if (tag === FORMAT_FLOAT) return bits === 32 ? data.readFloatLE(offset) : undefined;
  switch (bits) {
    case 8:
      return (data.readUInt8(offset) - 128) / 128;
    case 16:
      return data.readInt16LE(offset) / 32768;
    case 24:
      return data.readIntLE(offset, 3) / 8388608;
    case 32:
      return data.readInt32LE(offset) / 2147483648;
    default:
      return undefined;
  }
}

export function readWav(bytes: Buffer): WavReading {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false };
  }
  let format: Format | undefined;
  let data: Buffer | undefined;
  for (let at = 12; at + 8 <= bytes.length && data === undefined;) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const body = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size));
    if (id === 'fmt ' && body.length >= 16) {
      const tag = body.readUInt16LE(0);
      // The extensible form names the real format in the first two bytes of its sub-format.
      const effective = tag === FORMAT_EXTENSIBLE && body.length >= 26 ? body.readUInt16LE(24) : tag;
      format = {
        tag: effective,
        channels: body.readUInt16LE(2),
        rate: body.readUInt32LE(4),
        blockAlign: body.readUInt16LE(12),
        bits: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      data = body;
    }
    at += 8 + size + (size % 2);
  }
  if (format === undefined || data === undefined) return { ok: false };
  const bytesPerSample = format.bits / 8;
  const known = format.tag === FORMAT_PCM || format.tag === FORMAT_FLOAT;
  if (!known || format.channels < 1 || format.rate < 1 || !Number.isInteger(bytesPerSample)) return { ok: false };
  if (format.blockAlign !== format.channels * bytesPerSample) return { ok: false };
  if (sampleAt(Buffer.alloc(8), 0, format) === undefined) return { ok: false };
  const frames = Math.floor(data.length / format.blockAlign);
  let peak = 0;
  for (let i = 0; i < frames * format.channels; i++) {
    peak = Math.max(peak, Math.abs(sampleAt(data, i * bytesPerSample, format) ?? 0));
  }
  return {
    ok: true,
    channelCount: format.channels,
    sampleRateHz: format.rate,
    durationSec: frames / format.rate,
    voiced: peak > SILENCE_PEAK,
  };
}
