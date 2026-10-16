// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The boundary scenarios against a started OpenTune executable (boundary.ts, instances.ts,
// launch-real.ts), each with its own table and its own report file (<scenario>.json next to
// OTCP_E2E_REPORT). Without OTCP_TARGET_EXE each is one skipped test that says why; none reports PASS
// then. The two that go through the MCP bundle need dist/opentune-mcp.mjs, which this project's
// global setup builds.

import { describe, it } from 'vitest';

import { runBoundary, SCENARIO_NAME as BOUNDARY } from './boundary.js';
import { runInstances, SCENARIO_NAME as INSTANCES } from './instances.js';
import { runLaunchReal, SCENARIO_NAME as LAUNCH } from './launch-real.js';
import { formatScenarioTable, scenarioReportPath, writeScenarioReport, type ScenarioReport } from './scenario.js';
import { smokeSetupFromEnv, type SmokeConfig } from './smoke.js';

const scenarios: readonly {
  readonly name: string;
  readonly title: string;
  readonly run: (config: SmokeConfig) => Promise<ScenarioReport>;
}[] = [
  {
    name: BOUNDARY,
    title: 'boundary inputs: paths, silence, length, undo and forbidden paths',
    run: (c) => runBoundary(c),
  },
  { name: INSTANCES, title: 'two instances through the MCP bundle', run: runInstances },
  { name: LAUNCH, title: 'launch and a dying MCP process through the MCP bundle', run: runLaunchReal },
];

describe('boundary scenarios against the exe', () => {
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
    for (const { name } of scenarios) it.skip(`${name} not run: ${setup.skip}`, () => undefined);
    return;
  }
  const { config } = setup;

  // One after the other: they share the machine, and a test must not see another's OpenTune.
  for (const { name, title, run } of scenarios) {
    it(title, async (ctx) => {
      const report = await run(config);
      process.stderr.write(`\n${formatScenarioTable(report)}\n`);
      const file = scenarioReportPath(config.reportPath, name);
      if (file !== undefined) writeScenarioReport(file, report);
      if (report.result === 'FAIL') {
        const failed = report.steps.filter((s) => s.result === 'FAIL').map((s) => `${s.name}: ${s.note}`);
        throw new Error(`${name} scenario failed: ${failed.join('; ')}`);
      }
      if (report.result === 'SKIP' || report.result === 'FLAKY-SKIP') {
        const why = report.steps.find((s) => s.result === report.result);
        ctx.skip(`${report.result}: ${why?.note ?? ''}`);
      }
    });
  }
});
