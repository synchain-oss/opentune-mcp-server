// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_undo and opentune_redo: take back or re-apply the step on top of OpenTune's history. The
// caller names the step it expects (the undo_id a write result reported), so a step the user made
// in the window since is never undone by mistake: the call fails with UNDO_CONFLICT and the agent
// asks the user. force skips that check and is for a change the user explicitly asked to undo.

import { z } from 'zod';

import { writeOutcome } from '../render/index.js';
import { INSTANCE_FIELD, WRITE_TIMEOUT_MS } from './clip-write.js';
import { WRITE_RESULT_OUTPUT, defineTool, withInstance, type Outcome, type ToolContext } from './registry.js';

export interface HistoryArgs {
  readonly undo_id: string;
  readonly force?: boolean | undefined;
  readonly instance_id?: string | undefined;
}

const UNDO_ID = z
  .string()
  .regex(/^u:[0-9a-f]{8}:[1-9][0-9]*$/)
  .describe('The undo id (u:...) of the step you expect on top, from the write result that made it.');

const FORCE =
  'Only when the user explicitly asked to undo or redo a change that was not made through this server: applies ' +
  'the top step whatever it is. Never set it to get past UNDO_CONFLICT on your own.';

function run(method: 'edit.undo' | 'edit.redo', tool: string) {
  return (ctx: ToolContext, args: HistoryArgs): Promise<Outcome> =>
    withInstance(ctx, { instanceId: args.instance_id }, ['history.v1'], async (session) => {
      const result = await session.call(
        method,
        { expectedUndoId: args.undo_id, ...(args.force === true ? { force: true } : {}) },
        WRITE_TIMEOUT_MS,
      );
      return writeOutcome(result, { tool });
    });
}

const input = z.strictObject({
  undo_id: UNDO_ID,
  force: z.boolean().optional().describe(FORCE),
  instance_id: INSTANCE_FIELD,
});

const undo = run('edit.undo', 'opentune_undo');
const redo = run('edit.redo', 'opentune_redo');

export const undoTool = defineTool({
  name: 'opentune_undo',
  title: 'Undo the top OpenTune step',
  description:
    'OpenTune (audio vocal pitch editor): undoes the step on top of the undo history, but only if it is the step ' +
    'undo_id names; otherwise UNDO_CONFLICT, and then ask the user (the history has changed). Only edits that ' +
    'reported an undo id can be undone. A step that changes nothing still uses up the undo step and marks the ' +
    'project changed (UNDO_NO_EFFECT). Clip split, merge and delete cannot be undone safely in some builds ' +
    '(undo_unsafe_build). The result gives the opentune_redo call that takes this back.',
  inputSchema: input,
  outputSchema: WRITE_RESULT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  capabilities: ['history.v1'],
  otcpMethods: ['edit.undo'],
  run: (args, ctx) => undo(ctx, args),
});

export const redoTool = defineTool({
  name: 'opentune_redo',
  title: 'Redo the top OpenTune step',
  description:
    'OpenTune (audio vocal pitch editor): redoes the step on top of the redo history, but only if it is the step ' +
    'undo_id names (the id the undo result reported); otherwise UNDO_CONFLICT, and then ask the user. Any edit ' +
    'without an undo entry made after the undo clears the redo history. A step that changes nothing still uses ' +
    'up the redo step (UNDO_NO_EFFECT). The result gives the opentune_undo call that takes this back.',
  inputSchema: input,
  outputSchema: WRITE_RESULT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  capabilities: ['history.v1'],
  otcpMethods: ['edit.redo'],
  run: (args, ctx) => redo(ctx, args),
});
