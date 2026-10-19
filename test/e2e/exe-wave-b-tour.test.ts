// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The wave-B tour against a started OpenTune executable (test/e2e/wave-b-tour.ts). Without
// OTCP_TARGET_EXE the whole scenario is one skipped test that says why; it never reports PASS then.
// The step table goes to stderr, and the JSON report to wave-b-tour.json next to OTCP_E2E_REPORT.

import { describe, it } from 'vitest';

import { formatScenarioTable, scenarioReportPath, writeScenarioReport } from './scenario.js';
import { smokeSetupFromEnv } from './smoke.js';
import { runWaveBTour, SCENARIO_NAME } from './wave-b-tour.js';

describe('wave-B tour against the exe', () => {
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
    it.skip(`wave-B tour not run: ${setup.skip}`, () => undefined);
    return;
  }
  const { config } = setup;

  it('drives every wave-B method and tool once and checks the answers against the specification', async (ctx) => {
    const report = await runWaveBTour(config);
    process.stderr.write(`\n${formatScenarioTable(report)}\n`);
    const file = scenarioReportPath(config.reportPath, SCENARIO_NAME);
    if (file !== undefined) writeScenarioReport(file, report);
    if (report.result === 'FAIL') {
      const failed = report.steps.filter((s) => s.result === 'FAIL').map((s) => `${s.name}: ${s.note}`);
      throw new Error(`${SCENARIO_NAME} scenario failed: ${failed.join('; ')}`);
    }
    if (report.result === 'SKIP' || report.result === 'FLAKY-SKIP') {
      const why = report.steps.find((s) => s.result === report.result);
      ctx.skip(`${report.result}: ${why?.note ?? ''}`);
    }
  });
});
