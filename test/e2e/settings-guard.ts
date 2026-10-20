// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Runs a scenario with the watch of the real user's settings files (test/support/settings-guard.ts) around it.

import { watchUserSettings } from '../support/settings-guard.js';
import { summarise, type StepReport } from './smoke.js';

export const USER_SETTINGS_STEP = 'real user settings untouched';

interface Summarised {
  readonly steps: readonly StepReport[];
}

/**
 * Runs a scenario with the real-user settings watch around it. Any change turns the report into a FAIL
 * by one more step; the scenario's own result is never made better.
 */
export async function withUserSettingsWatch<T extends Summarised>(run: () => Promise<T>, dir?: string): Promise<T> {
  const watch = await watchUserSettings(dir);
  let report: T | undefined;
  let failure: unknown;
  try {
    report = await run();
  } catch (error) {
    failure = error;
  }
  const problems = await watch.finish();
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error('the scenario failed');
  if (report === undefined) throw new Error('the scenario returned no report');
  if (problems.length === 0) return report;
  const steps: StepReport[] = [
    ...report.steps,
    { name: USER_SETTINGS_STEP, result: 'FAIL', ms: 0, note: problems.join('; ') },
  ];
  return { ...report, steps, ...summarise(steps) };
}
