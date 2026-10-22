// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The reasons whose retryability differs from the default of their error kind (registry/error-kinds.json).
// One table for every place of the mock that raises such an error (jobs, writes, reference, time grid),
// so that none of them states a reason's retryability on its own. The registry is the source: an entry of
// registry/reasons.json whose description says "Not retryable" or "Retryable" gives the value; the few
// reasons whose description says nothing about it are listed in UNSTATED, and a unit test checks every
// value against the registry.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { SPEC_ROOT } from '../test/support/otcp-spec.js';

/** Reasons whose retryability the registry's description does not state; `<kind>/<reason>`. */
export const UNSTATED: Readonly<Record<string, boolean>> = Object.freeze({
  // A failed or voiceless pitch analysis does not become ready by waiting (the kind NOT_READY waits).
  'NOT_READY/f0_failed': false,
  'NOT_READY/f0_empty': false,
});

interface ReasonEntry {
  readonly code: string;
  readonly scope: string;
  readonly description: string;
}

/** The retryability a description states, or undefined when it states none. */
export function statedRetryability(description: string): boolean | undefined {
  if (/\bNot retryable\b/.test(description)) return false;
  if (/(^|[.:] )Retryable\b/.test(description)) return true;
  return undefined;
}

function load(): ReadonlyMap<string, boolean> {
  const file = JSON.parse(readFileSync(path.join(SPEC_ROOT, 'registry/reasons.json'), 'utf8')) as {
    entries: ReasonEntry[];
  };
  const table = new Map<string, boolean>(Object.entries(UNSTATED));
  for (const entry of file.entries) {
    const stated = statedRetryability(entry.description);
    if (stated !== undefined) table.set(`${entry.scope}/${entry.code}`, stated);
  }
  return table;
}

/** Retryability of `<kind>/<reason>` where it is not the kind's default. */
export const REASON_RETRYABLE: ReadonlyMap<string, boolean> = load();
