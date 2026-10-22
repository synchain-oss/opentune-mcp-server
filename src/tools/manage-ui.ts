// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_manage_ui: select a clip in the arrangement view, close dialogs, and mark the first-run
// onboarding as shown (capability ui.bridge). Selecting a clip can do more than select it: it can
// make OpenTune generate the clip's notes (no undo entry), queue reference analysis and change the
// scale shown in the transport bar. dry_run predicts these effects, and the result of a real call
// names them in its first sentence. Closing a dialog can commit the value the dialog shows (the
// track-colour dialog commits its colour), so it is refused unless the user agreed.

import { z } from 'zod';

import { toolError } from '../errors/tool-error.js';
import type { Json } from '../otcp/client.js';
import { isObject } from '../render/changes.js';
import { writeBody } from '../render/index.js';
import { warningCodes } from '../render/summary.js';
import { INSTANCE_FIELD, invalid } from './clip-write.js';
import { runWrites, type WriteCall, type WriteResult } from './multi-write.js';
import { WRITE_RESULT_OUTPUT, defineTool, withInstance, type Outcome, type ToolContext } from './registry.js';

const TOOL = 'opentune_manage_ui';
const OPS = ['focus_clip', 'dismiss_dialogs', 'dismiss_onboarding'] as const;
const PLACEMENT_RE = /^p:[0-9a-f]{8}:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/;

export interface ManageUiArgs {
  readonly op: (typeof OPS)[number];
  readonly clip?: string | undefined;
  readonly open_editor?: boolean | undefined;
  readonly dry_run?: boolean | undefined;
  readonly accept_commit?: boolean | undefined;
  readonly instance_id?: string | undefined;
}

const natural = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
const count = (n: number, noun: string) => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

/**
 * The summary of a clip selection. The side effects nobody asked for come first: they are the
 * reason to look at the result. Counts are checked integers; names from OpenTune are never used.
 */
export function focusSummary(envelope: Json): string {
  const effects = isObject(envelope.sideEffects) ? envelope.sideEffects : {};
  const dry = envelope.dryRun === true;
  const unasked: string[] = [];
  if (isObject(effects.notesGenerated)) {
    const n = natural(effects.notesGenerated.noteCount);
    unasked.push(
      `OpenTune ${dry ? 'generates' : 'generated'} ${n === null ? 'notes' : count(n, 'note')} for the clip, with ` +
        'no undo entry, and the project is marked as changed',
    );
  }
  if (isObject(effects.referenceAnalysisQueued)) {
    const ids = effects.referenceAnalysisQueued.contentIds;
    unasked.push(
      `reference alignment analysis ${dry ? 'is' : 'was'} queued for ` +
        (Array.isArray(ids) ? count(ids.length, 'content') : 'contents'),
    );
  }
  if (isObject(effects.uiScaleChanged)) unasked.push('the scale shown in the transport bar changes with the clip key');
  const opened = isObject(effects.workspaceSwitched) ? ' and opens it in the piano roll' : '';
  const warnings = warningCodes(envelope);
  const tail = warnings.length === 0 ? '' : ` Warnings: ${warnings.join(', ')}.`;
  if (dry) {
    const would =
      unasked.length === 0
        ? 'no side effects beyond the selection'
        : `these side effects nobody asked for: ${unasked.join('; ')}`;
    return `${TOOL}: dry run, nothing was selected; selecting the clip${opened} would have ${would}.${tail}`;
  }
  if (envelope.noOp === true) return `${TOOL}: the clip was already selected; nothing was changed.${tail}`;
  const done = opened === '' ? 'selected the clip' : 'selected the clip and opened it in the piano roll';
  return unasked.length === 0
    ? `${TOOL}: ${done}, with no side effects beyond the selection.${tail}`
    : `${TOOL}: ${done}, and ALSO, which nobody asked for: ${unasked.join('; ')}.${tail}`;
}

/** The error of dismissing an overlay that is showing, on an instance that cannot close it. */
function onboardingUnsupported(outcome: Outcome): Outcome {
  if (outcome.ok || outcome.error.kind !== 'UNSUPPORTED') return outcome;
  return {
    ...outcome,
    error: toolError('UNSUPPORTED', {
      reason: outcome.error.reason,
      detail: outcome.error.detail,
      nextStep: {
        actor: 'user',
        message:
          'The first-run overlay is showing and this OpenTune build cannot close it from here. Ask the user to ' +
          'finish or close the overlay in the OpenTune window.',
      },
    }),
  };
}

export async function manageUi(ctx: ToolContext, args: ManageUiArgs): Promise<Outcome> {
  const focusArgs = args.clip !== undefined || args.open_editor !== undefined || args.dry_run !== undefined;
  let call: WriteCall;
  if (args.op === 'focus_clip') {
    if (args.clip === undefined || !PLACEMENT_RE.test(args.clip)) {
      return invalid('focus_clip needs clip, a clip placement id (p:...) from opentune_get_project', 'clip_required');
    }
    if (args.accept_commit !== undefined) return invalid('accept_commit belongs to dismiss_dialogs', 'unexpected');
    call = {
      method: 'ui.setSelection',
      params: {
        placementId: args.clip,
        ...(args.open_editor === true ? { openEditor: true } : {}),
        ...(args.dry_run === true ? { dryRun: true } : {}),
      },
    };
  } else {
    if (focusArgs) return invalid(`${args.op} takes no clip, open_editor or dry_run`, 'unexpected');
    if (args.op === 'dismiss_onboarding') {
      if (args.accept_commit !== undefined) return invalid('accept_commit belongs to dismiss_dialogs', 'unexpected');
      call = { method: 'ui.dismiss', params: { target: 'onboarding' } };
    } else {
      call = {
        method: 'ui.dismiss',
        params: { target: 'dialogs', ...(args.accept_commit === true ? { confirm: true } : {}) },
      };
    }
  }
  return withInstance(ctx, { instanceId: args.instance_id }, ['ui.bridge'], async (session) => {
    // A dialog that commits on close is refused by the instance; the next step for
    // INVALID_ARGUMENT(dialog_commits_on_close) is the one in errors/next-step.ts.
    const run = await runWrites(session, TOOL, [call]);
    if ('stopped' in run) return args.op === 'dismiss_onboarding' ? onboardingUnsupported(run.stopped) : run.stopped;
    const [result] = run.results as readonly [WriteResult];
    const rendered = writeBody(result.envelope, { tool: TOOL });
    return {
      ok: true,
      body: args.op === 'focus_clip' ? { ...rendered, summary: focusSummary(result.envelope) } : rendered,
    };
  });
}

export const manageUiTool = defineTool({
  name: TOOL,
  title: 'Manage OpenTune window state',
  description:
    'OpenTune (audio vocal pitch editor): op focus_clip selects a clip (placement id), optionally opening it in ' +
    'the piano roll. Selecting can make OpenTune generate the clip notes (no undo entry, project marked changed), ' +
    'queue reference analysis and change the transport-bar scale; dry_run predicts this, and a real result names ' +
    'it first. dismiss_dialogs closes all dialogs like Escape; a dialog that commits its value on close (track ' +
    'colour) is refused unless accept_commit is true, which only the user may allow. dismiss_onboarding marks ' +
    'the first-run onboarding as shown (global, cannot be undone).',
  inputSchema: z.strictObject({
    op: z.enum(OPS),
    clip: z.string().optional().describe('focus_clip: clip placement id (p:...) from opentune_get_project.'),
    open_editor: z.boolean().optional().describe('focus_clip: also open the clip in the piano roll.'),
    dry_run: z.boolean().optional().describe('focus_clip: predict the effects, select nothing.'),
    accept_commit: z
      .boolean()
      .optional()
      .describe('dismiss_dialogs: true only when the user agreed that closing commits the value shown.'),
    instance_id: INSTANCE_FIELD,
  }),
  outputSchema: WRITE_RESULT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  capabilities: ['ui.bridge'],
  otcpMethods: ['ui.setSelection', 'ui.dismiss'],
  run: (args, ctx) => manageUi(ctx, args),
});
