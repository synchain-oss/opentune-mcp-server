// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The result of a method that hands its work to a job (PROTOCOL.md section 14.2, last state): a
// write envelope that changes nothing itself and names the job. The job's own result carries the
// envelope of the work it commits.

import { envelope } from './context.js';
import type { JobView } from './jobs.js';
import type { World } from './model.js';

export function jobStartedResult(
  world: World,
  job: Pick<JobView, 'jobId' | 'kind' | 'state'>,
): Record<string, unknown> {
  return envelope(world, {
    applied: false,
    noOp: false,
    diff: { arrangement: null, trackState: null, contents: [] },
    contents: [],
    undo: null,
    dirtyBefore: world.project.dirty,
    job: { jobId: job.jobId, kind: job.kind, state: job.state },
  });
}
