// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The effects scenario against a started OpenTune executable (test/e2e/effects.ts). Without
// OTCP_TARGET_EXE the whole scenario is one skipped test that says why; it never reports PASS.
// The step table goes to stderr, and the JSON report to OTCP_E2E_EFFECTS_REPORT, or to effects.json
// next to OTCP_E2E_REPORT.

import { describe, it } from 'vitest';

import { effectsSetupFromEnv, runEffects } from './effects.js';
import { formatTable, writeReport } from './smoke.js';

describe('end-to-end effects against the exe', () => {
  let setup: ReturnType<typeof effectsSetupFromEnv>;
  try {
    setup = effectsSetupFromEnv();
  } catch (error) {
    // Configured, but wrongly: a failure, never a skip.
    const problem = error instanceof Error ? error : new Error(String(error));
    it('configuration', () => {
      throw problem;
    });
    return;
  }
  if ('skip' in setup) {
    it.skip(`exe effects not run: ${setup.skip}`, () => undefined);
    return;
  }
  const { config } = setup;

  it('changes in the exported audio what each write reports, and nothing else', async (ctx) => {
    const report = await runEffects(config);
    process.stderr.write(`\n${formatTable(report)}\n`);
    if (config.reportPath !== undefined) writeReport(config.reportPath, report);
    if (report.result === 'FAIL') {
      const failed = report.steps.filter((s) => s.result === 'FAIL').map((s) => `${s.name}: ${s.note}`);
      throw new Error(`effects scenario failed: ${failed.join('; ')}`);
    }
    if (report.result === 'SKIP' || report.result === 'FLAKY-SKIP') {
      const why = report.steps.find((s) => s.result === report.result);
      ctx.skip(`${report.result}: ${why?.note ?? ''}`);
    }
  });
});
