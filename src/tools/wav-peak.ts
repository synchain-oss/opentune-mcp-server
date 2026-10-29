// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The peak level of a WAV file, read in blocks so that a long export (a stereo float32 song is about 100 MB)
// never sits in memory whole. opentune_export_audio uses it on the file its own export just wrote, to tell the
// user when the mix is louder than full scale: a 32-bit float file holds that, but converting it to 16 bits or
// playing it elsewhere clips. Integer and 32 or 64-bit float samples are understood; anything else is reported
// as unsupported rather than guessed.

import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';

/** Why the peak is not known, as the reason of `nullReasons`. Fixed words, never text from a file. */
export type PeakFailure = 'unreadable' | 'not_a_wav' | 'unsupported_format' | 'too_large';

export type WavPeak =
  | {
      readonly ok: true;
      /** Largest absolute sample value, 1.0 being full scale; a NaN sample is not compared, so it never raises this. */
      readonly peak: number;
      /** 20 * log10(peak) in dBFS, to two decimals; null for a silent file or one with a sample that is not finite. */
      readonly peakDbfs: number | null;
      /** Samples with an absolute value above 1.0. */
      readonly clippedSampleCount: number;
      readonly nullReason?: 'silent' | 'not_finite';
    }
  | { readonly ok: false; readonly reason: PeakFailure };

/** Audio data above this size is not read: the answer is not worth a read that long inside a tool call. */
export const MAX_READ_BYTES = 2 ** 30;
/** Bytes read at a time. */
export const READ_BLOCK_BYTES = 1 << 20;
/** Chunks looked at before the data chunk; a real file has a handful. */
const MAX_CHUNKS = 64;

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;
const UNKNOWN_SIZE = 0xffff_ffff;

type SampleReader = (view: DataView, offset: number) => number;

/** How to turn the bytes of one sample into a fraction of full scale, or undefined for a layout that is not known. */
function readerOf(tag: number, bits: number): SampleReader | undefined {
  if (tag === FORMAT_FLOAT) {
    if (bits === 32) return (view, at) => view.getFloat32(at, true);
    if (bits === 64) return (view, at) => view.getFloat64(at, true);
    return undefined;
  }
  if (tag !== FORMAT_PCM) return undefined;
  switch (bits) {
    case 8:
      return (view, at) => (view.getUint8(at) - 128) / 128;
    case 16:
      return (view, at) => view.getInt16(at, true) / 32768;
    case 24:
      return (view, at) => (view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) / 8388608;
    case 32:
      return (view, at) => view.getInt32(at, true) / 2147483648;
    default:
      return undefined;
  }
}

interface Located {
  readonly read: SampleReader;
  readonly bytesPerSample: number;
  readonly start: number;
  readonly length: number;
}

async function locate(handle: FileHandle, size: number): Promise<Located | PeakFailure> {
  const head = Buffer.alloc(12);
  if ((await handle.read(head, 0, 12, 0)).bytesRead < 12) return 'not_a_wav';
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return 'not_a_wav';
  let format: { tag: number; bits: number } | undefined;
  let at = 12;
  for (let seen = 0; seen < MAX_CHUNKS && at + 8 <= size; seen += 1) {
    const header = Buffer.alloc(8);
    if ((await handle.read(header, 0, 8, at)).bytesRead < 8) break;
    const id = header.toString('ascii', 0, 4);
    const chunkSize = header.readUInt32LE(4);
    const body = at + 8;
    if (id === 'fmt ') {
      const fmt = Buffer.alloc(Math.min(chunkSize, 40));
      const got = (await handle.read(fmt, 0, fmt.length, body)).bytesRead;
      if (got < 16) return 'not_a_wav';
      const tag = fmt.readUInt16LE(0);
      // The extensible form names the real format in the first two bytes of its sub-format.
      const real = tag === FORMAT_EXTENSIBLE && got >= 26 ? fmt.readUInt16LE(24) : tag;
      format = { tag: real, bits: fmt.readUInt16LE(14) };
    } else if (id === 'data') {
      if (format === undefined) return 'not_a_wav';
      const read = readerOf(format.tag, format.bits);
      if (read === undefined) return 'unsupported_format';
      // A writer that streams leaves the size open; the file itself says where the audio ends.
      const left = size - body;
      const length = chunkSize === UNKNOWN_SIZE ? left : Math.min(chunkSize, left);
      return { read, bytesPerSample: format.bits / 8, start: body, length };
    }
    at = body + chunkSize + (chunkSize % 2);
  }
  return 'not_a_wav';
}

/** The two file system calls that decide which file is read; tests replace them. */
export interface FileOps {
  readonly lstat: (file: string) => Promise<BigIntStats>;
  readonly open: (file: string, flags: number) => Promise<FileHandle>;
}

const realOps: FileOps = { lstat: (file) => lstat(file, { bigint: true }), open: (file, flags) => open(file, flags) };

/** Open for reading, and refuse a link at the last part of the path where the system has a flag for it. */
export const OPEN_FLAGS = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);

/**
 * Whether the file that was opened is the one `lstat` looked at: a regular file with the same device and file number.
 * Between the two calls the path can be replaced, a link put in place of the file for one, and only the check after the
 * open sees the file that is really read. A file system that reports no file number (0) cannot be compared, and then
 * only the regular-file check holds: on Windows, which has no flag that refuses a link at open, this comparison is the
 * only guard and is best effort.
 */
const sameFile = (looked: BigIntStats, opened: BigIntStats): boolean =>
  opened.isFile() &&
  (looked.ino === 0n || opened.ino === 0n || (looked.dev === opened.dev && looked.ino === opened.ino));

/**
 * Reads the audio of the WAV file at `file` once, from start to end, and returns its peak level and the number of
 * samples above full scale. Never throws: a file that cannot be read or understood is a `reason`.
 */
export async function readWavPeak(file: string, ops: FileOps = realOps): Promise<WavPeak> {
  let handle: FileHandle | undefined;
  try {
    // A link is not the file the export wrote.
    const info = await ops.lstat(file);
    if (!info.isFile()) return { ok: false, reason: 'unreadable' };
    handle = await ops.open(file, OPEN_FLAGS);
    // The path may have been replaced since lstat: what is read is the file that was opened, and it must be the file
    // that was looked at.
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(info, opened)) return { ok: false, reason: 'unreadable' };
    const found = await locate(handle, Number(opened.size));
    if (typeof found === 'string') return { ok: false, reason: found };
    if (found.length > MAX_READ_BYTES) return { ok: false, reason: 'too_large' };
    const { read, bytesPerSample: width } = found;

    const block = Math.floor(READ_BLOCK_BYTES / width) * width;
    const raw = new ArrayBuffer(block);
    const bytes = Buffer.from(raw);
    const view = new DataView(raw);
    let peak = 0;
    let clipped = 0;
    // Samples that are NaN or infinite. NaN is neither above the peak nor above full scale, so only this count
    // tells that a file holds one: without it a file of NaN reads as silent, and a file with some NaN gets a finite peak.
    let nonFinite = 0;
    let at = found.start;
    let left = found.length - (found.length % width);
    while (left > 0) {
      const want = Math.min(block, left);
      const { bytesRead } = await handle.read(bytes, 0, want, at);
      // A file shorter than its header says ends the audio early.
      const usable = bytesRead - (bytesRead % width);
      if (usable === 0) break;
      for (let offset = 0; offset < usable; offset += width) {
        const value = Math.abs(read(view, offset));
        if (value > peak) peak = value;
        if (value > 1) clipped += 1;
        if (!Number.isFinite(value)) nonFinite += 1;
      }
      at += usable;
      left -= usable;
    }

    // A sample that is not a finite number makes the level unknown, whatever the other samples are: this comes before
    // silent, because a file of NaN has a peak of 0 here.
    if (nonFinite > 0) {
      return { ok: true, peak, peakDbfs: null, clippedSampleCount: clipped, nullReason: 'not_finite' };
    }
    if (peak === 0) return { ok: true, peak, peakDbfs: null, clippedSampleCount: clipped, nullReason: 'silent' };
    return {
      ok: true,
      peak,
      peakDbfs: Math.round(20 * Math.log10(peak) * 100) / 100,
      clippedSampleCount: clipped,
    };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
