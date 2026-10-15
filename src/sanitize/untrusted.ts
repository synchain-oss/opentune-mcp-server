// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Strings from OpenTune (track, clip, file and project names, paths, metadata, log lines) may be
// written to manipulate an AI. They reach the model only as JSON string values inside a tool
// result, never inside the summary sentences this server composes. This module serializes results
// so that such a string cannot leave its JSON value when a client renders the text: JSON.stringify
// already escapes quotes, backslashes and C0 controls; the characters below are escaped as well,
// because clients may render them as line breaks or use them to reorder text visually.

// C1 controls, soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width and
// directional marks, line and paragraph separators, directional embeddings, overrides and
// isolates, word joiner and invisible operators, byte order mark and interlinear annotation marks.
const INVISIBLE = /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g;

const escape = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;

/**
 * Serializes a tool result as single-line JSON in which every untrusted string stays a JSON string
 * value and every invisible or line-breaking character is written as a \u escape. The output
 * parses back (JSON.parse) to a value equal to the input.
 */
export function serializeResult(value: unknown): string {
  const text = JSON.stringify(value) as string | undefined;
  if (text === undefined) throw new TypeError('the result cannot be serialized as JSON');
  return text.replace(INVISIBLE, escape);
}

const NOT_PRINTABLE_ASCII = /[^\u0020-\u007e]/g;

/** Diagnostic text: printable ASCII only, at most `max` characters (OTCP `detail` rules). */
export function cleanDetail(text: string, max = 1024): string {
  const ascii = text.replace(NOT_PRINTABLE_ASCII, '?');
  return ascii.length <= max ? ascii : `${ascii.slice(0, max - 3)}...`;
}

/** A value only if it is a string that matches `pattern`, else null (for values used in summaries). */
export function trustedToken(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}
