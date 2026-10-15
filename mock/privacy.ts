// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Removal of the user's home directory from text the mock returns (PROTOCOL.md section 20.2 rule 5).

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * Replaces the home directory in `text` with `~`, written with backslashes or with forward
 * slashes. On Windows paths are compared without regard to case, so the match is too.
 */
export function stripHome(text: string, home: string, platform: NodeJS.Platform = process.platform): string {
  if (home === '') return text;
  const forms = new Set([home, home.replaceAll('\\', '/')]);
  let out = text;
  for (const form of forms) {
    // The match ends at a path boundary: `/srv/a` is not the start of `/srv/ab`.
    const escaped = form.replace(REGEXP_SPECIALS, '\\$&');
    out = out.replace(new RegExp(`${escaped}(?=[\\\\/]|$)`, platform === 'win32' ? 'gi' : 'g'), '~');
  }
  return out;
}
