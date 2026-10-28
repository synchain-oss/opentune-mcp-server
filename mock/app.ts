// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The application methods of the mock that end it (capability app.quit): app.quit
// (spec/otcp/v1/PROTOCOL.md sections 13.2, 14.1 and 20.2 rule 3). The function only decides: it
// refuses, or builds the result. The server answers with the result first and then stops through the
// path of its normal shutdown (server.ts), as OpenTune answers first and then quits on its main thread.

import { refuse } from './errors.js';
import type { JobStore } from './jobs.js';
import type { World } from './model.js';

/** The longest time the mock takes to end after it answered: it ends in the next turn of the event loop. */
export const EXIT_DEADLINE_MS = 5000;

const PROJECT = { singleton: 'project' } as const;

/** The reason BUSY gives for an unfinished job of this kind where section 13.2 has one; job_in_progress for the others. */
const JOB_BUSY_REASONS: Readonly<Record<string, string>> = {
  import: 'import_in_progress',
  export: 'export_in_progress',
  projectOpen: 'project_operation',
  projectSave: 'project_operation',
  projectCopy: 'project_operation',
};
const OTHER_JOB_REASON = 'job_in_progress';

/**
 * The checks of app.quit in their order, then its result. The first check, that the server is already
 * stopping, is the server's own: it answers every later request with SHUTTING_DOWN before a method runs.
 */
export function quitResult(
  world: World,
  jobs: Pick<JobStore, 'hasActive' | 'activeKinds'>,
  params: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const busy = world.busyReason(jobs.hasActive('export'));
  if (busy !== undefined) throw refuse('BUSY', busy, `the UI is busy: ${busy}`, 1000);
  const [unfinished] = jobs.activeKinds();
  if (unfinished !== undefined) {
    const reason = JOB_BUSY_REASONS[unfinished] ?? OTHER_JOB_REASON;
    throw refuse('BUSY', reason, 'a job has not finished, and quitting would end it', 1000);
  }
  const discarded = world.project.dirty;
  if (discarded && params.discardUnsaved !== true) {
    throw refuse(
      'UNSAVED_CHANGES',
      'project_dirty',
      'the project has unsaved changes; discardUnsaved true quits anyway and loses them',
    );
  }
  const { path } = world.project;
  return {
    quitting: true,
    discardedUnsavedChanges: discarded,
    projectPath: path,
    exitDeadlineMs: EXIT_DEADLINE_MS,
    warnings: discarded ? [{ code: 'IRREVERSIBLE', subject: PROJECT, data: null }] : [],
    ...(path === null ? { nullReasons: { projectPath: 'no_project_path' } } : {}),
  };
}
