// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  LineSplitter,
  MAX_NESTING_DEPTH,
  decodeLine,
  encodeLine,
  isBlankLine,
  nestingDepth,
  type LineEvent,
} from '../../src/otcp/framing.js';

const b = (text: string) => Buffer.from(text, 'utf8');

/** The lines in order, with 'overflow' for an overflow event. */
function drain(splitter: LineSplitter): string[] {
  const out: string[] = [];
  for (let e: LineEvent | undefined = splitter.next(); e !== undefined; e = splitter.next()) {
    out.push(e.kind === 'line' ? e.bytes.toString('utf8') : 'overflow');
  }
  return out;
}

describe('LineSplitter', () => {
  it('returns the lines of one chunk in order, without their LF, and keeps the rest', () => {
    const s = new LineSplitter(100);
    s.push(b('a\nbc\r\n\npartial'));
    expect(drain(s)).toEqual(['a', 'bc\r', '']);
    expect(s.pendingBytes).toBe(7);
    s.push(b(' line\n'));
    expect(drain(s)).toEqual(['partial line']);
    expect(s.pendingBytes).toBe(0);
  });

  it('joins a line that spans several chunks', () => {
    const s = new LineSplitter(100);
    for (const part of ['{"a"', ':', '1}\n{"b":2}', '\n']) s.push(b(part));
    expect(drain(s)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('does not rescan bytes it has already searched', () => {
    const s = new LineSplitter(100);
    s.push(b('abc'));
    expect(s.next()).toBeUndefined();
    s.push(b('def'));
    expect(s.next()).toBeUndefined();
    s.push(b('\n'));
    expect(drain(s)).toEqual(['abcdef']);
  });

  it('accepts a line of exactly maxLineBytes and overflows one byte later, before any LF arrives', () => {
    const ok = new LineSplitter(4);
    ok.push(b('abcd\n'));
    expect(drain(ok)).toEqual(['abcd']);

    const tooLong = new LineSplitter(4);
    tooLong.push(b('abcd'));
    expect(tooLong.next()).toBeUndefined();
    tooLong.push(b('e'));
    expect(drain(tooLong)).toEqual(['overflow']);
    // Nothing is accepted after an overflow.
    tooLong.push(b('\nx\n'));
    expect(tooLong.next()).toBeUndefined();
    expect(tooLong.pendingBytes).toBe(0);
  });

  it('overflows on a complete line that is too long', () => {
    const s = new LineSplitter(3);
    s.push(b('ok\nabcdef\nnext\n'));
    expect(drain(s)).toEqual(['ok', 'overflow']);
  });

  it('applies a changed maxLineBytes to the lines that follow', () => {
    const s = new LineSplitter(4);
    s.push(b('abc\nlonger line\n'));
    expect(s.next()).toEqual({ kind: 'line', bytes: b('abc') });
    s.maxLineBytes = 100;
    expect(drain(s)).toEqual(['longer line']);
  });

  it('ignores empty chunks', () => {
    const s = new LineSplitter(4);
    s.push(Buffer.alloc(0));
    expect(s.pendingBytes).toBe(0);
    expect(s.next()).toBeUndefined();
  });
});

describe('isBlankLine', () => {
  it('is true for empty lines and JSON whitespace only', () => {
    expect(isBlankLine(b(''))).toBe(true);
    expect(isBlankLine(b(' \t\r'))).toBe(true);
    expect(isBlankLine(b(' x '))).toBe(false);
    expect(isBlankLine(b(' '))).toBe(false);
  });
});

describe('nestingDepth', () => {
  it('counts arrays and objects, the outermost value being depth 1', () => {
    expect(nestingDepth('1')).toBe(0);
    expect(nestingDepth('{}')).toBe(1);
    expect(nestingDepth('{"a":[{"b":[]}],"c":{}}')).toBe(4);
  });

  it('ignores brackets inside strings, also after escaped quotes and backslashes', () => {
    expect(nestingDepth('{"a":"[[[{{{"}')).toBe(1);
    expect(nestingDepth(String.raw`{"a":"\"[[[","b":"\\","c":[1]}`)).toBe(2);
  });
});

describe('decodeLine', () => {
  const nested = (depth: number) => `${'{"a":'.repeat(depth - 1)}{}${'}'.repeat(depth - 1)}`;

  it('parses valid JSON, also with a CR before the LF', () => {
    expect(decodeLine(b('{"id":1}\r'))).toEqual({ ok: true, value: { id: 1 } });
    expect(decodeLine(b('[1,"x"]'))).toEqual({ ok: true, value: [1, 'x'] });
  });

  it('rejects invalid UTF-8 instead of replacing it', () => {
    expect(decodeLine(Buffer.from([0x22, 0xff, 0xfe, 0x22]))).toEqual({ ok: false, error: 'utf8' });
  });

  it('rejects a byte order mark and invalid JSON', () => {
    expect(decodeLine(b('﻿{}'))).toEqual({ ok: false, error: 'json' });
    expect(decodeLine(b('{"a":'))).toEqual({ ok: false, error: 'json' });
    expect(decodeLine(b(''))).toEqual({ ok: false, error: 'json' });
  });

  it(`accepts nesting of exactly ${String(MAX_NESTING_DEPTH)} and rejects one level more`, () => {
    expect(decodeLine(b(nested(MAX_NESTING_DEPTH))).ok).toBe(true);
    expect(decodeLine(b(nested(MAX_NESTING_DEPTH + 1)))).toEqual({ ok: false, error: 'depth' });
    expect(decodeLine(b(nested(3)), 2)).toEqual({ ok: false, error: 'depth' });
  });

  it('rejects strings and member names that escape a lone surrogate, anywhere in the value', () => {
    for (const line of [
      String.raw`{"id":"\ud800"}`,
      String.raw`{"id":"x\uDC00"}`,
      String.raw`{"params":{"\udc00":1}}`,
      String.raw`{"a":[1,{"b":"\uDE00\uD83D"}]}`,
      String.raw`"\ud800"`,
    ]) {
      expect(decodeLine(b(line)), line).toEqual({ ok: false, error: 'json' });
    }
  });

  it('accepts surrogate pairs, whether escaped or written as UTF-8', () => {
    expect(decodeLine(b(String.raw`{"id":"🎵"}`))).toEqual({ ok: true, value: { id: '\u{1F3B5}' } });
    expect(decodeLine(b('{"\u{1F3B5}":["\u{1F3B5}",null,true,2]}'))).toEqual({
      ok: true,
      value: { '\u{1F3B5}': ['\u{1F3B5}', null, true, 2] },
    });
  });
});

describe('encodeLine', () => {
  it('writes compact JSON and one LF, escaping line breaks inside strings', () => {
    const line = encodeLine({ id: 100, text: 'a\r\nb' });
    expect(line.toString('utf8')).toBe('{"id":100,"text":"a\\r\\nb"}\n');
    expect(line.indexOf(0x0a)).toBe(line.length - 1);
    expect(line.includes(0x0d)).toBe(false);
  });

  it('refuses values that are not JSON', () => {
    expect(() => encodeLine(undefined)).toThrow(TypeError);
  });
});
