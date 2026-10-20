// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Runs a scenario with the watch of the real user's settings files (test/support/settings-guard.ts) around it.

import { watchUserSettings } from '../support/settings-guard.js';
import { summarise, type StepReport } from './smoke.js';

export const USER_SETTINGS_STEP = 'real user settings untouched';

interface Summarised {
  readonly steps: readonly StepReport[];
}

/** `Roaming/OpenTune`-style label of a folder: the last two segments, so that the user's name never shows. */
const labelOf = (dir: string): string =>
  dir
    .split(/[\\/]+/)
    .filter(Boolean)
    .slice(-2)
    .join('/');

/**
 * Runs a scenario with the real-user settings watch around it. The watch adds one more step to the report:
 * a FAIL when a file changed, a SKIP when it found no settings file at all (then it could not have noticed
 * anything, which on a machine with OpenTune installed means a wrong folder), otherwise a PASS that says how many
 * files in which folders were watched. The scenario's own result is never made better. When the scenario
 * throws, the watch result is added to its error message (the original error stays the `cause`), and a watch
 * that itself fails never hides the scenario's error.
 */
export async function withUserSettingsWatch<T extends Summarised>(
  run: () => Promise<T>,
  dirs?: string | readonly string[],
): Promise<T> {
  const watch = await watchUserSettings(dirs);
  let report: T | undefined;
  let failure: unknown;
  let failed = false;
  try {
    report = await run();
  } catch (error) {
    failure = error;
    failed = true;
  }
  let problems: readonly string[];
  try {
    problems = await watch.finish();
  } catch (error) {
    problems = [
      `the real user settings could not be compared: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  if (failed) {
    const why = failure instanceof Error ? failure.message : 'the scenario failed';
    if (problems.length === 0) throw failure instanceof Error ? failure : new Error(why);
    throw new Error(`${why}; ${USER_SETTINGS_STEP}: ${problems.join('; ')}`, { cause: failure });
  }
  if (report === undefined) throw new Error('the scenario returned no report');
  const where = watch.watched.map((folder) => `${labelOf(folder.dir)}: ${String(folder.files)}`).join(', ');
  const step: StepReport =
    problems.length > 0
      ? { name: USER_SETTINGS_STEP, result: 'FAIL', ms: 0, note: problems.join('; ') }
      : watch.files === 0
        ? {
            name: USER_SETTINGS_STEP,
            result: 'SKIP',
            ms: 0,
            note: `no settings file found to watch (${where === '' ? 'no folder known' : where}); the check could not notice a change`,
          }
        : { name: USER_SETTINGS_STEP, result: 'PASS', ms: 0, note: `watched ${String(watch.files)} files (${where})` };
  const steps: StepReport[] = [...report.steps, step];
  return { ...report, steps, ...summarise(steps) };
}
