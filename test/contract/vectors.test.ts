// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Every vector of spec/otcp/v1/vectors against the mock. The session and job vectors must pass;
// the others need capabilities the mock does not report yet and are skipped with that reason. A
// PASS / FAIL / SKIP table goes to stderr, and to the file named by OTCP_CONTRACT_SUMMARY (JSON)
// for the "contract vectors (mock)" row of `npm run gates`.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, describe, it } from 'vitest';

import { mockTarget } from './mock-target.js';
import { runVector, type Outcome } from './runner.js';
import { loadVectors } from './vectors.js';

/** Areas whose vectors the mock implements in full: a SKIP there is a failure. */
const REQUIRED = /^(session|job)\//;

const target = mockTarget();
const outcomes: Outcome[] = [];

describe('contract vectors against the mock', () => {
  it.for(loadVectors())('$id', async (entry, ctx) => {
    const outcome: Outcome =
      entry.problems.length > 0
        ? { id: entry.id, result: 'FAIL', note: `invalid vector: ${entry.problems.join('; ')}` }
        : await runVector(entry.vector, target);
    outcomes.push(outcome);
    if (outcome.result === 'FAIL') throw new Error(outcome.note);
    if (outcome.result === 'SKIP') {
      if (REQUIRED.test(entry.id)) throw new Error(`must pass against the mock, but was skipped: ${outcome.note}`);
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
    const required = outcomes.filter((o) => REQUIRED.test(o.id));
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
        required: { total: required.length, pass: count('PASS', required) },
        skipReasons,
        failed: outcomes.filter((o) => o.result === 'FAIL').map((o) => o.id),
      };
      writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
    }
  });
});
