// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Every vector of spec/otcp/v1/vectors against the mock. A vector whose capabilities the mock
// reports must pass; the others need methods the mock does not implement yet and are skipped with
// that reason. A
// PASS / FAIL / SKIP table goes to stderr, and to the file named by OTCP_CONTRACT_SUMMARY (JSON)
// for the "contract vectors (mock)" row of `npm run gates`.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, describe, it } from 'vitest';

import { MOCK_CAPABILITIES } from '../../mock/server.js';
import { registerExeVectors } from './exe-vectors.js';
import { mockTarget } from './mock-target.js';
import { runVector, type Outcome } from './runner.js';
import { loadVectors, type Vector } from './vectors.js';

/** The mock implements every method of the capabilities it reports, so a SKIP for such a vector is a failure. */
const isRequired = (vector: Vector): boolean =>
  [vector.capability, ...(vector.extraCapabilities ?? [])].every((c) => MOCK_CAPABILITIES.includes(c));

const target = mockTarget();
const outcomes: Outcome[] = [];
const required = new Set<string>();

describe('contract vectors against the mock', () => {
  it.for(loadVectors())('$id', async (entry, ctx) => {
    const outcome: Outcome =
      entry.problems.length > 0
        ? { id: entry.id, result: 'FAIL', note: `invalid vector: ${entry.problems.join('; ')}` }
        : await runVector(entry.vector, target);
    outcomes.push(outcome);
    if (isRequired(entry.vector)) required.add(entry.id);
    if (outcome.result === 'FAIL') throw new Error(outcome.note);
    if (outcome.result === 'SKIP') {
      if (isRequired(entry.vector)) throw new Error(`must pass against the mock, but was skipped: ${outcome.note}`);
      ctx.skip(outcome.note);
    }
  });

  afterAll(() => {
    const cell = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
    const table = [
      '| Vector | Result | Notes |',
      '| --- | --- | --- |',
      ...outcomes.map((o) => `| ${o.id} | ${o.result} | ${cell(o.note)} |`),
    ];
    process.stderr.write(`\nContract vectors (mock target):\n${table.join('\n')}\n`);
    const count = (result: Outcome['result'], list = outcomes) => list.filter((o) => o.result === result).length;
    const covered = outcomes.filter((o) => required.has(o.id));
    const skipReasons: Record<string, number> = {};
    for (const o of outcomes.filter((x) => x.result === 'SKIP')) skipReasons[o.note] = (skipReasons[o.note] ?? 0) + 1;
    const file = process.env.OTCP_CONTRACT_SUMMARY;
    if (file !== undefined && file !== '') {
      mkdirSync(path.dirname(file), { recursive: true });
      const summary = {
        total: outcomes.length,
        pass: count('PASS'),
        fail: count('FAIL'),
        skip: count('SKIP'),
        required: { total: covered.length, pass: count('PASS', covered) },
        skipReasons,
        failed: outcomes.filter((o) => o.result === 'FAIL').map((o) => o.id),
      };
      writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
    }
  });
});

// The same vectors against a started OpenTune; skipped, with the reason, unless OTCP_TARGET_EXE is set.
registerExeVectors();
