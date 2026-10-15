// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Cleaning of a path as a user pastes it: Windows Explorer's "Copy as path" wraps it in quotes,
// property dialogs add invisible direction marks, and chat clients add typographic quotes or
// surrounding whitespace. This only removes such wrapping; it never decides whether the path is
// acceptable (src/paths/ does) and never touches a file.

// Direction marks and embeddings, zero-width characters, word joiner and byte order mark. Windows
// property dialogs put U+202A in front of a copied path.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

// Opening quote to the closing quote that matches it. Straight quotes and backticks close
// themselves; typographic quotes pair up, in either direction for German-style lows.
const CLOSERS: ReadonlyMap<string, readonly string[]> = new Map([
  ['"', ['"']],
  ["'", ["'"]],
  ['`', ['`']],
  ['“', ['”', '“']],
  ['‘', ['’', '‘']],
  ['„', ['”', '“']],
  ['‚', ['’', '‘']],
  ['«', ['»']],
  ['「', ['」']],
]);

/** Longest stack of quotes removed; deeper nesting is not a pasted path any more. */
const MAX_QUOTE_LAYERS = 4;

/**
 * Removes invisible marks, surrounding whitespace and matching quotes around a pasted path, in
 * that order and repeatedly (a quoted path inside quotes, with spaces between layers). A quote
 * that has no partner at the other end is kept, so the path check rejects the string as it is.
 */
export function cleanPathInput(raw: string): string {
  let text = raw.replace(INVISIBLE, '').trim();
  for (let layer = 0; layer < MAX_QUOTE_LAYERS && text.length >= 2; layer++) {
    if (!CLOSERS.get(text.charAt(0))?.includes(text.charAt(text.length - 1))) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}
