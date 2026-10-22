// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The mock's table of reasons whose retryability differs from their kind's default must agree with
// the registry (spec/otcp/v1/registry/reasons.json and error-kinds.json).

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeError } from '../../mock/protocol.js';
import { REASON_RETRYABLE, UNSTATED, statedRetryability } from '../../mock/retryable.js';
import { SPEC_ROOT, otcpSpec } from '../support/otcp-spec.js';

interface Entry {
  readonly code: string;
  readonly scope: string;
  readonly description: string;
}

const registry = (
  JSON.parse(readFileSync(path.join(SPEC_ROOT, 'registry/reasons.json'), 'utf8')) as { entries: Entry[] }
).entries;

describe('the retryability table of the mock', () => {
  it('holds exactly what the registry states, plus the listed reasons it leaves unstated', () => {
    const expected = new Map<string, boolean>(Object.entries(UNSTATED));
    for (const entry of registry) {
      const stated = statedRetryability(entry.description);
      if (stated !== undefined) expected.set(`${entry.scope}/${entry.code}`, stated);
    }
    expect([...REASON_RETRYABLE].sort()).toEqual([...expected].sort());
  });

  it('names only registered reasons, and the unstated ones are not contradicted by the registry', () => {
    const known = new Map(registry.map((entry) => [`${entry.scope}/${entry.code}`, entry]));
    for (const key of REASON_RETRYABLE.keys()) expect(known.has(key), key).toBe(true);
    for (const key of Object.keys(UNSTATED)) {
      expect(statedRetryability(known.get(key)?.description ?? ''), key).toBeUndefined();
    }
  });

  it('lets an error take the retryability of its reason over that of its kind', () => {
    const spec = otcpSpec();
    const retryable = (kind: string, reason?: string) =>
      makeError(spec, { kind, ...(reason === undefined ? {} : { reason }), detail: 'x' }).data.retryable;
    expect(retryable('NOT_READY')).toBe(true);
    expect(retryable('NOT_READY', 'f0_not_ready')).toBe(true);
    expect(retryable('NOT_READY', 'reference_analysis_stalled')).toBe(false);
    expect(retryable('NOT_READY', 'reference_analysis_timeout')).toBe(true);
    expect(retryable('NOT_READY', 'f0_failed')).toBe(false);
    expect(retryable('ANALYSIS_FAILED', 'reference_analysis_failed')).toBe(false);
  });
});
