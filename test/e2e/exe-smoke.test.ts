// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The end-to-end smoke scenario against a started OpenTune executable (test/e2e/smoke.ts). Without
// OTCP_TARGET_EXE the whole scenario is one skipped test that says why; it never reports PASS.
// The step table goes to stderr, and the JSON report to the file named by OTCP_E2E_REPORT.

import { describe, it } from 'vitest';

import { formatTable, runSmoke, smokeSetupFromEnv, writeReport } from './smoke.js';

describe('end-to-end smoke against the exe', () => {
  let setup: ReturnType<typeof smokeSetupFromEnv>;
  try {
    setup = smokeSetupFromEnv();
  } catch (error) {
    // Configured, but wrongly: a failure, never a skip.
    const problem = error instanceof Error ? error : new Error(String(error));
    it('configuration', () => {
      throw problem;
    });
    return;
  }
  if ('skip' in setup) {
    it.skip(`exe smoke not run: ${setup.skip}`, () => undefined);
    return;
  }
  const { config } = setup;

  it('imports, tunes and exports a generated vocal', async (ctx) => {
    const report = await runSmoke(config);
    process.stderr.write(`\n${formatTable(report)}\n`);
    if (config.reportPath !== undefined) writeReport(config.reportPath, report);
    if (report.result === 'FAIL') {
      const failed = report.steps.filter((s) => s.result === 'FAIL').map((s) => `${s.name}: ${s.note}`);
      throw new Error(`smoke scenario failed: ${failed.join('; ')}`);
    }
    if (report.result === 'SKIP' || report.result === 'FLAKY-SKIP') {
      const why = report.steps.find((s) => s.result === report.result);
      ctx.skip(`${report.result}: ${why?.note ?? ''}`);
    }
  });
});
