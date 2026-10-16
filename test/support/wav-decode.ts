// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Decodes the samples of a PCM or IEEE-float WAV file, for the effects checks of the end-to-end
// tests (an export of OpenTune is float32; the generated source is 16-bit PCM). Every channel is
// kept as it is, so two files can be compared sample by sample; `mono` is their mean.

export interface DecodedWav {
  readonly sampleRateHz: number;
  readonly bits: number;
  readonly float: boolean;
  /** One array per channel, values as stored (integers scaled to -1..1). */
  readonly channels: readonly Float64Array[];
  /** The mean of the channels. */
  readonly mono: Float64Array;
}

/** Reads a RIFF/WAVE file with a PCM (8 to 32 bit) or IEEE float (32 or 64 bit) data chunk. Throws on anything else. */
export function decodeWav(bytes: Buffer): DecodedWav {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let fmt: { tag: number; channels: number; rate: number; bits: number } | undefined;
  let data: Buffer | undefined;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const body = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size));
    if (id === 'fmt ' && body.length >= 16) {
      let tag = body.readUInt16LE(0);
      if (tag === 0xfffe && body.length >= 26) tag = body.readUInt16LE(24);
      fmt = { tag, channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === 'data') {
      data = body;
    }
    at += 8 + size + (size % 2);
  }
  if (fmt === undefined || data === undefined) throw new Error('no fmt or data chunk');
  const float = fmt.tag === 3;
  if (!float && fmt.tag !== 1) throw new Error(`unsupported format tag ${String(fmt.tag)}`);
  const width = fmt.bits / 8;
  if (fmt.channels < 1 || fmt.rate < 1 || ![1, 2, 3, 4, 8].includes(width) || (float && width < 4)) {
    throw new Error('unsupported sample layout');
  }
  const frames = Math.floor(data.length / width / fmt.channels);
  const channels = Array.from({ length: fmt.channels }, () => new Float64Array(frames));
  const read = (at: number): number => {
    if (float) return width === 4 ? data.readFloatLE(at) : data.readDoubleLE(at);
    if (width === 1) return (data.readUInt8(at) - 128) / 128;
    if (width === 2) return data.readInt16LE(at) / 32768;
    if (width === 3) return data.readIntLE(at, 3) / 8388608;
    return data.readInt32LE(at) / 2147483648;
  };
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < fmt.channels; c++) {
      const channel = channels[c];
      if (channel !== undefined) channel[f] = read((f * fmt.channels + c) * width);
    }
  }
  const mono = new Float64Array(frames);
  for (const channel of channels) for (let f = 0; f < frames; f++) mono[f] = (mono[f] ?? 0) + (channel[f] ?? 0);
  for (let f = 0; f < frames; f++) mono[f] = (mono[f] ?? 0) / channels.length;
  return { sampleRateHz: fmt.rate, bits: fmt.bits, float, channels, mono };
}
