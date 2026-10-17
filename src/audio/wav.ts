// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Reads a WAV file for analysis: integer PCM of 16, 24 or 32 bits or 32-bit float, mono or stereo,
// plain or WAVE_FORMAT_EXTENSIBLE. The file is opened read-only and read in blocks; the channels
// are averaged to mono and the signal is low-pass filtered and decimated to about ANALYSIS_RATE_HZ
// on the way, so memory stays small for long files. Nothing is written.

import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

/** Largest file accepted: 256 MiB, about 25 minutes of 16-bit stereo at 44.1 kHz. */
export const MAX_WAV_BYTES = 256 * 1024 * 1024;
/** The analysis rate the input is decimated towards (an integer factor, never below it). */
export const ANALYSIS_RATE_HZ = 11_025;

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;
/** The bytes of the KSDATAFORMAT_SUBTYPE GUIDs after the format tag. */
const GUID_TAIL = Buffer.from([0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]);
const BLOCK_BYTES = 1 << 20;

export type WavProblem = 'not_found' | 'not_a_file' | 'read_failed' | 'too_large' | 'unsupported';

export class WavError extends Error {
  constructor(
    readonly problem: WavProblem,
    detail: string,
  ) {
    super(detail);
    this.name = 'WavError';
  }
}

export interface WavFormat {
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly bits: number;
  readonly float: boolean;
}

export interface DecodedWav extends WavFormat {
  /** Mono samples at `rateHz`, scaled to -1..1. */
  readonly samples: Float32Array;
  readonly rateHz: number;
  readonly durationSec: number;
}

const unsupported = (detail: string) => new WavError('unsupported', detail);

/** The format of a fmt chunk body, or a WavError naming what is not supported. */
export function parseFormat(body: Buffer): WavFormat {
  if (body.length < 16) throw unsupported('the fmt chunk is too short');
  let tag = body.readUInt16LE(0);
  const channels = body.readUInt16LE(2);
  const sampleRateHz = body.readUInt32LE(4);
  const blockAlign = body.readUInt16LE(12);
  const bits = body.readUInt16LE(14);
  if (tag === FORMAT_EXTENSIBLE) {
    if (body.length < 40 || !body.subarray(26, 40).equals(GUID_TAIL)) {
      throw unsupported('the extensible format has an unknown sub-format');
    }
    tag = body.readUInt16LE(24);
  }
  const float = tag === FORMAT_FLOAT;
  if (!(float && bits === 32) && !(tag === FORMAT_PCM && (bits === 16 || bits === 24 || bits === 32))) {
    throw unsupported(
      `the audio is format ${String(tag)} with ${String(bits)} bits; only 16, 24 or 32-bit PCM and 32-bit float are read`,
    );
  }
  if (channels < 1 || channels > 2)
    throw unsupported(`the audio has ${String(channels)} channels; only mono or stereo are read`);
  if (sampleRateHz < 8000 || sampleRateHz > 384_000)
    throw unsupported(`the sample rate ${String(sampleRateHz)} Hz is not supported`);
  if (blockAlign !== channels * (bits / 8)) throw unsupported('the block alignment does not match the format');
  return { sampleRateHz, channels, bits, float };
}

/** Windowed-sinc (Blackman) low-pass for decimation by `factor`: cutoff at 0.4 of the output rate. */
export function lowPass(factor: number): Float64Array {
  const taps = 32 * factor + 1;
  const mid = (taps - 1) / 2;
  const cutoff = 0.4 / factor;
  const h = Float64Array.from({ length: taps }, (_, n) => {
    const x = n - mid;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const window =
      0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (taps - 1));
    return sinc * window;
  });
  const sum = h.reduce((s, v) => s + v, 0);
  return h.map((v) => v / sum);
}

/** Converts interleaved sample bytes to mono floats. */
export function toMono(bytes: Buffer, format: WavFormat): Float32Array {
  const width = format.bits / 8;
  const frames = Math.floor(bytes.length / (width * format.channels));
  const out = new Float32Array(frames);
  const read = (at: number): number => {
    if (format.float) return bytes.readFloatLE(at);
    if (format.bits === 16) return bytes.readInt16LE(at) / 32_768;
    if (format.bits === 24) return bytes.readIntLE(at, 3) / 8_388_608;
    return bytes.readInt32LE(at) / 2_147_483_648;
  };
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < format.channels; c++) sum += read((f * format.channels + c) * width);
    const value = sum / format.channels;
    out[f] = Number.isFinite(value) ? value : 0;
  }
  return out;
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

const ioError = (error: unknown): WavError => {
  const code = (error as { code?: unknown }).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new WavError('not_found', 'the file does not exist');
  if (code === 'EISDIR') return new WavError('not_a_file', 'the path names a folder, not a file');
  return new WavError('read_failed', `the file could not be read (${typeof code === 'string' ? code : 'error'})`);
};

/**
 * Reads the WAV file at `path` (an absolute path already checked) as mono at about
 * ANALYSIS_RATE_HZ. Throws a WavError for a missing, unreadable, oversized or unsupported file.
 */
export async function readWav(path: string, maxBytes = MAX_WAV_BYTES): Promise<DecodedWav> {
  let handle: FileHandle;
  try {
    // A FIFO or device opened for reading would block until a writer shows up: open without blocking
    // on POSIX and let the isFile() check below refuse it. Windows has no such files and no O_NONBLOCK.
    handle = await open(path, process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw ioError(error);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new WavError('not_a_file', 'the path does not name an ordinary file');
    if (stat.size > maxBytes) {
      throw new WavError('too_large', `the file is ${String(stat.size)} bytes; the limit is ${String(maxBytes)} bytes`);
    }
    const head = await readAt(handle, 0, 12);
    if (head.length < 12 || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') {
      throw unsupported('the file is not a RIFF/WAVE file');
    }
    let format: WavFormat | null = null;
    let data: { start: number; size: number } | null = null;
    for (let at = 12; at + 8 <= stat.size && data === null;) {
      const header = await readAt(handle, at, 8);
      const id = header.toString('latin1', 0, 4);
      const size = header.readUInt32LE(4);
      if (id === 'fmt ') format = parseFormat(await readAt(handle, at + 8, Math.min(size, 64)));
      if (id === 'data') data = { start: at + 8, size: Math.min(size, stat.size - at - 8) };
      at += 8 + size + (size % 2);
    }
    if (format === null || data === null) throw unsupported('the file has no fmt or no data chunk before its end');
    return await decode(handle, format, data);
  } catch (error) {
    throw error instanceof WavError ? error : ioError(error);
  } finally {
    await handle.close();
  }
}

async function decode(
  handle: FileHandle,
  format: WavFormat,
  data: { start: number; size: number },
): Promise<DecodedWav> {
  const frameBytes = (format.bits / 8) * format.channels;
  const totalFrames = Math.floor(data.size / frameBytes);
  const factor = Math.max(1, Math.floor(format.sampleRateHz / ANALYSIS_RATE_HZ));
  const h = factor === 1 ? Float64Array.of(1) : lowPass(factor);
  const out = new Float32Array(Math.ceil(totalFrames / factor) + 1);
  let written = 0;
  // Half the filter of zeros in front, so output sample i lies at input sample i * factor.
  let pending = new Float32Array((h.length - 1) / 2);
  const block = Math.floor(BLOCK_BYTES / frameBytes) * frameBytes;
  for (let offset = 0; offset < totalFrames * frameBytes; offset += block) {
    const bytes = await readAt(handle, data.start + offset, Math.min(block, totalFrames * frameBytes - offset));
    const mono = toMono(bytes, format);
    const buffer = new Float32Array(pending.length + mono.length);
    buffer.set(pending);
    buffer.set(mono, pending.length);
    let pos = 0;
    for (; pos + h.length <= buffer.length; pos += factor) {
      let acc = 0;
      for (let k = 0; k < h.length; k++) acc += (h[k] ?? 0) * (buffer[pos + k] ?? 0);
      out[written++] = acc;
    }
    pending = buffer.slice(pos);
  }
  const rateHz = format.sampleRateHz / factor;
  return { ...format, samples: out.subarray(0, written), rateHz, durationSec: totalFrames / format.sampleRateHz };
}
