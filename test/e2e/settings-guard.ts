// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Runs a scenario with the watch of the real user's settings files (test/support/settings-guard.ts) around it.

import { labelOf, redactHome, watchUserSettings } from '../support/settings-guard.js';
import { summarise, type StepReport } from './smoke.js';

export const USER_SETTINGS_STEP = 'real user settings untouched';

interface Summarised {
  readonly steps: readonly StepReport[];
}

/**
 * A copy of `error` that is safe to hang on a new error as its `cause`: name, message and stack went through
 * `redactHome`, and nothing in it refers to the original. Node and vitest print the `cause` of an error they
 * report, so the original (whose message names whatever path the scenario failed on) would bring the home folder
 * into the output again. A cause of the error is copied the same way, down to a few levels.
 */
function redactedCopy(error: Error, depth = 0): Error {
  const copy = new Error(redactHome(error.message));
  copy.name = redactHome(error.name);
  if (error.stack !== undefined) copy.stack = redactHome(error.stack);
  if (error.cause instanceof Error && depth < 4) copy.cause = redactedCopy(error.cause, depth + 1);
  return copy;
}

/**
 * Runs a scenario with the real-user settings watch around it. The watch adds one more step to the report:
 *
 *  - FAIL when a settings file of the real user's folders changed, appeared or disappeared during the run.
 *  - PASS with the number of files and folders watched, when there were files and none changed.
 *  - When there was no settings file to watch at all, the answer depends on where the run happens:
 *    - On a CI runner (`env.CI` is `true`, which GitHub Actions sets) it is a PASS. A clean runner has never run
 *      OpenTune, so the folders are empty and nothing is expected there; the comparison still looks at the folders
 *      after the run, so a file that the run creates is found and fails the step.
 *    - Anywhere else it is a SKIP: the check could not have noticed anything, and on a machine where OpenTune is
 *      installed and has been run that means the watch looked into a wrong folder, which the SKIP brings to light.
 *      When no folder is known at all it is a SKIP on a runner too, since nothing was compared.
 *
 * The scenario's own result is never made better. When the scenario throws, the watch result is added to its error
 * message (the `cause` is a copy of the original error with the home folder redacted), and a watch that itself
 * fails never hides the scenario's error. `env` is where the CI flag is read from; tests pass their own.
 */
export async function withUserSettingsWatch<T extends Summarised>(
  run: () => Promise<T>,
  dirs?: string | readonly string[],
  env: NodeJS.ProcessEnv = process.env,
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
    // The message of a failed stat carries the full path of the real user's folder; the home folder in it
    // becomes `~`, as `labelOf` keeps the user's name out of the labels.
    const why = redactHome(error instanceof Error ? error.message : String(error));
    problems = [`the real user settings could not be compared: ${why}`];
  }
  if (failed) {
    const why = failure instanceof Error ? redactHome(failure.message) : 'the scenario failed';
    // The cause is a redacted copy: the original error names the paths the scenario failed on, home folder included.
    const options = failure instanceof Error ? { cause: redactedCopy(failure) } : undefined;
    if (problems.length === 0) throw new Error(why, options);
    throw new Error(`${why}; ${USER_SETTINGS_STEP}: ${problems.join('; ')}`, options);
  }
  if (report === undefined) throw new Error('the scenario returned no report');
  const where = watch.watched.map((folder) => `${labelOf(folder.dir)}: ${String(folder.files)}`).join(', ');
  const step: StepReport =
    problems.length > 0
      ? { name: USER_SETTINGS_STEP, result: 'FAIL', ms: 0, note: problems.join('; ') }
      : watch.files > 0
        ? { name: USER_SETTINGS_STEP, result: 'PASS', ms: 0, note: `watched ${String(watch.files)} files (${where})` }
        : env.CI === 'true' && watch.watched.length > 0
          ? {
              name: USER_SETTINGS_STEP,
              result: 'PASS',
              ms: 0,
              note: `no settings file existed in the watched folders before or after the run (${where}); none was created (clean CI runner)`,
            }
          : {
              name: USER_SETTINGS_STEP,
              result: 'SKIP',
              ms: 0,
              note: `no settings file found to watch (${where === '' ? 'no folder known' : where}); the check could not notice a change`,
            };
  const steps: StepReport[] = [...report.steps, step];
  return { ...report, steps, ...summarise(steps) };
}
