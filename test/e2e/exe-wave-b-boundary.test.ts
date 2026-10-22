// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The wave-B boundary against a started OpenTune executable (test/e2e/wave-b-boundary.ts). Without
// OTCP_TARGET_EXE the whole scenario is one skipped test that says why; it never reports PASS then.
// The step table goes to stderr, and the JSON report to wave-b-boundary.json next to OTCP_E2E_REPORT.

import { describe, it } from 'vitest';

import { withUserSettingsWatch } from './settings-guard.js';
import { formatScenarioTable, scenarioReportPath, writeScenarioReport } from './scenario.js';
import { smokeSetupFromEnv } from './smoke.js';
import { runWaveBBoundary, SCENARIO_NAME } from './wave-b-boundary.js';

describe('wave-B boundary against the exe', () => {
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
    it.skip(`wave-B boundary not run: ${setup.skip}`, () => undefined);
    return;
  }
  const { config } = setup;

  it('drives the wave-B edge cases and checks each answer against a fresh read', async (ctx) => {
    const report = await withUserSettingsWatch(() => runWaveBBoundary(config));
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
