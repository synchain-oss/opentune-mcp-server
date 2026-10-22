// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The one table of reason retryability (src/errors/reason-retryable.ts) must agree with the
// specification it is taken from: the descriptions of registry/reasons.json that state it, and the
// table of PROTOCOL.md section 11. The server's default for an error and the mock's error objects both
// read the table.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeError } from '../../mock/protocol.js';
import { kindStep } from '../../src/errors/next-step.js';
import { REASON_RETRYABLE } from '../../src/errors/reason-retryable.js';
import { SPEC_ROOT, otcpSpec } from '../support/otcp-spec.js';

interface Entry {
  readonly code: string;
  readonly scope: string;
  readonly description: string;
}

const registry = (
  JSON.parse(readFileSync(path.join(SPEC_ROOT, 'registry/reasons.json'), 'utf8')) as { entries: Entry[] }
).entries;
const kinds = (
  JSON.parse(readFileSync(path.join(SPEC_ROOT, 'registry/error-kinds.json'), 'utf8')) as {
    entries: { code: string; retryable: boolean }[];
  }
).entries;

/** The retryability a description states, or undefined when it states none. */
function statedRetryability(description: string): boolean | undefined {
  if (/\bNot retryable\b/.test(description)) return false;
  if (/(^|[.:] )Retryable\b/.test(description)) return true;
  return undefined;
}

/** The rows `| condition | \`reason\` | true |` of the readiness gate table in PROTOCOL.md section 11. */
function readinessGate(): Map<string, boolean> {
  const text = readFileSync(path.join(SPEC_ROOT, 'PROTOCOL.md'), 'utf8');
  const start = text.indexOf('## 11. Readiness gate');
  const end = text.indexOf('## 12. Jobs');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const rows = new Map<string, boolean>();
  for (const match of text.slice(start, end).matchAll(/^\|[^|]*\|\s*`([a-z0-9_]+)`\s*\|\s*(true|false)\s*\|\s*$/gm)) {
    rows.set(`NOT_READY/${match[1] ?? ''}`, match[2] === 'true');
  }
  return rows;
}

describe('the retryability table of the reasons', () => {
  it('holds exactly what the registry descriptions and the readiness gate of the specification state', () => {
    const expected = new Map<string, boolean>(readinessGate());
    for (const entry of registry) {
      const stated = statedRetryability(entry.description);
      if (stated !== undefined) expected.set(`${entry.scope}/${entry.code}`, stated);
    }
    expect(expected.size).toBeGreaterThan(10);
    expect(Object.entries(REASON_RETRYABLE).sort()).toEqual([...expected].sort());
  });

  it('names only registered reasons', () => {
    const known = new Set(registry.map((entry) => `${entry.scope}/${entry.code}`));
    for (const key of Object.keys(REASON_RETRYABLE)) expect(known.has(key), key).toBe(true);
  });

  it('is what the server reports for the reason, and the kind default for any other', () => {
    for (const [key, retryable] of Object.entries(REASON_RETRYABLE)) {
      const [kind = '', reason = ''] = key.split('/');
      expect(kindStep(kind, reason).retryable, key).toBe(retryable);
    }
    for (const kind of kinds) {
      expect(kindStep(kind.code, null).retryable, kind.code).toBe(kind.retryable);
      expect(kindStep(kind.code, 'a_reason_added_later').retryable, kind.code).toBe(kind.retryable);
    }
    // The readiness gate: a failed or voiceless analysis does not become ready by waiting.
    expect(kindStep('NOT_READY', 'f0_failed').retryable).toBe(false);
    expect(kindStep('NOT_READY', 'f0_empty').retryable).toBe(false);
    expect(kindStep('NOT_READY', 'f0_not_ready').retryable).toBe(true);
  });

  it('is what the mock puts in an error, unless the error says otherwise', () => {
    const spec = otcpSpec();
    const retryable = (kind: string, reason?: string, explicit?: boolean) =>
      makeError(spec, {
        kind,
        ...(reason === undefined ? {} : { reason }),
        ...(explicit === undefined ? {} : { retryable: explicit }),
        detail: 'x',
      }).data.retryable;
    for (const [key, expected] of Object.entries(REASON_RETRYABLE)) {
      const [kind = '', reason = ''] = key.split('/');
      expect(retryable(kind, reason), key).toBe(expected);
    }
    expect(retryable('NOT_READY')).toBe(true);
    expect(retryable('NOT_READY', 'reference_analysis_stalled', true)).toBe(true);
  });
});
