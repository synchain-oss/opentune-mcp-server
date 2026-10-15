// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// NDJSON framing of OTCP (spec/otcp/v1/PROTOCOL.md section 3.2): one JSON value per line, UTF-8
// without a byte order mark, lines measured in bytes without the LF. Shared by every OTCP peer in
// this repository (the client and the test mock), so both sides split, measure and decode lines
// the same way.

const LF = 0x0a;

/** Nesting deeper than this many arrays or objects is a parse error; the outermost value has depth 1. */
export const MAX_NESTING_DEPTH = 64;

export type LineEvent =
  | { readonly kind: 'line'; readonly bytes: Buffer }
  /** More than `maxLineBytes` bytes arrived without an LF. The splitter accepts nothing after this. */
  | { readonly kind: 'overflow' };

/**
 * Splits a byte stream into lines. Chunks are pushed as they arrive and complete lines are taken
 * out one at a time with `next()`, so the caller can change `maxLineBytes` between lines (for
 * example once a connection has authenticated).
 */
export class LineSplitter {
  #chunks: Buffer[] = [];
  /** Bytes held in #chunks. */
  #length = 0;
  /** Leading bytes of #chunks already known to contain no LF. */
  #scanned = 0;
  #overflowed = false;

  /** Longest accepted line in bytes, without the LF. */
  maxLineBytes: number;

  constructor(maxLineBytes: number) {
    this.maxLineBytes = maxLineBytes;
  }

  /** Bytes received but not yet returned as part of a line. */
  get pendingBytes(): number {
    return this.#length;
  }

  push(chunk: Buffer): void {
    if (this.#overflowed || chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#length += chunk.length;
  }

  /** The next complete line, an overflow, or undefined when no complete line is buffered. */
  next(): LineEvent | undefined {
    if (this.#overflowed) return undefined;
    let offset = 0;
    for (const [k, chunk] of this.#chunks.entries()) {
      const from = Math.max(0, this.#scanned - offset);
      const lf = from < chunk.length ? chunk.indexOf(LF, from) : -1;
      if (lf !== -1) {
        const lineLength = offset + lf;
        if (lineLength > this.maxLineBytes) return this.#overflow();
        const bytes =
          k === 0 ? chunk.subarray(0, lf) : Buffer.concat([...this.#chunks.slice(0, k), chunk.subarray(0, lf)]);
        const rest = chunk.subarray(lf + 1);
        this.#chunks = rest.length > 0 ? [rest, ...this.#chunks.slice(k + 1)] : this.#chunks.slice(k + 1);
        this.#length -= lineLength + 1;
        this.#scanned = 0;
        return { kind: 'line', bytes };
      }
      offset += chunk.length;
    }
    this.#scanned = this.#length;
    return this.#length > this.maxLineBytes ? this.#overflow() : undefined;
  }

  #overflow(): LineEvent {
    this.#overflowed = true;
    this.#chunks = [];
    this.#length = 0;
    return { kind: 'overflow' };
  }
}

/** True when the line is empty or holds only JSON whitespace (space, tab, CR). */
export function isBlankLine(bytes: Uint8Array): boolean {
  return bytes.every((b) => b === 0x20 || b === 0x09 || b === 0x0d);
}

/** Deepest nesting of arrays and objects in JSON text; brackets inside strings do not count. */
export function nestingDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 0x5c) escaped = true;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x7b || c === 0x5b) {
      depth++;
      max = Math.max(max, depth);
    } else if (c === 0x7d || c === 0x5d) {
      depth--;
    }
  }
  return max;
}

export type DecodedLine =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: 'utf8' | 'json' | 'depth' };

// fatal: invalid UTF-8 throws instead of becoming U+FFFD. ignoreBOM: a byte order mark stays in
// the text, where JSON.parse rejects it, because OTCP lines carry none.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * True when a string in the JSON text, a member name included, has an escape of a lone surrogate:
 * a `\uD800` to `\uDBFF` escape not immediately followed by a `\uDC00` to `\uDFFF` escape, or a
 * low surrogate escape that does not immediately follow a high one. Such a string encodes no
 * Unicode text, which makes the line invalid JSON in OTCP terms (section 3.2 rule 3). The text is
 * scanned before it is parsed, so a string that the parser would drop, such as the first value of
 * a member name that appears twice, is checked as well. The text is valid UTF-8, so a surrogate
 * can only come from an escape. Escapes that the parser rejects anyway are not judged here.
 */
export function hasLoneSurrogateEscape(text: string): boolean {
  // Most lines have no escape that could encode a surrogate.
  if (!/\\u[dD][89a-fA-F]/.test(text)) return false;
  let inString = false;
  /** The previous character of the current string was a high surrogate escape. */
  let afterHigh = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (!inString) {
      if (c === 0x22) inString = true;
      continue;
    }
    if (c === 0x5c && text.charCodeAt(i + 1) === 0x75) {
      const hex = text.slice(i + 2, i + 6);
      const unit = HEX4.test(hex) ? Number.parseInt(hex, 16) : -1;
      const low = unit >= 0xdc00 && unit <= 0xdfff;
      if (afterHigh !== low) return true;
      afterHigh = unit >= 0xd800 && unit <= 0xdbff;
      i += 5;
      continue;
    }
    if (afterHigh) return true;
    if (c === 0x5c) i += 1;
    else if (c === 0x22) inString = false;
  }
  return afterHigh;
}

/** Decodes one line (without its LF). Any failure is a parse error in OTCP terms. */
export function decodeLine(bytes: Uint8Array, maxDepth = MAX_NESTING_DEPTH): DecodedLine {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return { ok: false, error: 'utf8' };
  }
  if (nestingDepth(text) > maxDepth) return { ok: false, error: 'depth' };
  if (hasLoneSurrogateEscape(text)) return { ok: false, error: 'json' };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: 'json' };
  }
}

/** Serializes one message as compact JSON followed by LF. JSON.stringify never emits a raw CR or LF. */
export function encodeLine(message: unknown): Buffer {
  const text = JSON.stringify(message) as string | undefined;
  if (text === undefined) throw new TypeError('the message cannot be serialized as JSON');
  return Buffer.from(`${text}\n`, 'utf8');
}
