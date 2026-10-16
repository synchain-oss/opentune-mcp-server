// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// A minimal zip reader for the plugin and skills packaging tests (the same as the one in
// test/unit/mcpb.test.ts): it reads the central directory the way any unzip tool does, so the
// tests check what a user extracts.

import { inflateRawSync } from 'node:zlib';

import { expect } from 'vitest';

export interface ZipEntry {
  name: string;
  data: Buffer;
  crc: number;
  time: number;
  date: number;
  attrs: number;
}

/** Reads a zip by its central directory (store and deflate). */
export function readZip(zip: Buffer): ZipEntry[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataStart, dataStart + zip.readUInt32LE(p + 20));
    expect(size).toBe(raw.length);
    out.push({
      name,
      data: method === 0 ? raw : inflateRawSync(raw),
      crc: zip.readUInt32LE(p + 16),
      time: zip.readUInt16LE(p + 12),
      date: zip.readUInt16LE(p + 14),
      attrs: zip.readUInt32LE(p + 38),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
