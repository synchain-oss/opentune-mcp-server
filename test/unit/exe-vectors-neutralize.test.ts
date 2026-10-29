// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The text the exe contract runner writes into its result file names no personal folder.

import { homedir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { neutralize, vectorRow } from '../contract/exe-vectors.js';

const win = { home: String.raw`D:\profiles\alex`, tmp: String.raw`D:\profiles\alex\scratch`, windows: true };
const posix = { home: '/srv/alex', tmp: '/var/scratch/run', windows: false };

describe('neutralize', () => {
  it('replaces the temporary folder before the home folder it lies in', () => {
    const text = String.raw`cannot read D:\profiles\alex\scratch\ot-x\a.wav and D:\profiles\alex\music\b.wav`;
    expect(neutralize(text, win)).toBe(String.raw`cannot read %TEMP%\ot-x\a.wav and ~\music\b.wav`);
  });

  it('ignores letter case and takes either slash', () => {
    expect(neutralize('d:/PROFILES/ALEX/Scratch/ot-x/a.wav', win)).toBe('%TEMP%/ot-x/a.wav');
    expect(neutralize(String.raw`D:\PROFILES\Alex\file.txt`, win)).toBe(String.raw`~\file.txt`);
  });

  it('uses $TMPDIR and ~ on other systems', () => {
    expect(neutralize('open /var/scratch/run/ot-x/a and /srv/alex/b', posix)).toBe('open $TMPDIR/ot-x/a and ~/b');
  });

  it('does not touch a longer folder name that only starts the same', () => {
    expect(neutralize('/srv/alex2/file', posix)).toBe('/srv/alex2/file');
  });

  it('keeps only the first line of a stack', () => {
    const stack = String.raw`Error: boom in D:\profiles\alex\a.ts` + '\n    at run (a.ts:1:1)\n    at next (b.ts)';
    expect(neutralize(stack, win)).toBe(String.raw`Error: boom in ~\a.ts`);
  });

  it('is applied to the reason of a result row', () => {
    const row = vectorRow({ id: 'a/b', result: 'FAIL', note: `failed at ${homedir()}/file` } as never);
    expect(row.reason).toBe('failed at ~/file');
  });
});
