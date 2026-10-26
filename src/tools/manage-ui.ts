// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_manage_ui: select a clip in the arrangement view, close dialogs, and mark the first-run
// onboarding as shown (capability ui.bridge). Selecting a clip can do more than select it: it can
// make OpenTune generate the clip's notes (no undo entry) and change the scale shown in the transport
// bar. dry_run predicts these effects, and the result of a real call
// names them in its first sentence. Closing a dialog can commit the value the dialog shows (the
// track-colour dialog commits its colour), so it is refused unless the user agreed.
//
// switch_view shows the arrangement view or the piano roll (capability ui.workspace); closing the piano
// roll is switch_view arrangement. It changes view state only, so a result that reports nothing else says
// that the project did not change, and whether the project still has the unsaved changes it had before; a
// result that reports anything more gets the generic summary, which names it.

import { z } from 'zod';

import { toolError, type ToolError } from '../errors/tool-error.js';
import { missingCapability } from '../otcp/instances.js';
import type { Json } from '../otcp/client.js';
import { isObject } from '../render/changes.js';
import { writeBody } from '../render/index.js';
import { warningCodes } from '../render/summary.js';
import { SIDE_EFFECT_TEXT, token, viewName } from '../render/text.js';
import { INSTANCE_FIELD, invalid } from './clip-write.js';
import { runWrites, type WriteCall, type WriteResult } from './multi-write.js';
import { WRITE_RESULT_OUTPUT, defineTool, withInstance, type Outcome, type ToolContext } from './registry.js';

const TOOL = 'opentune_manage_ui';
const OPS = ['focus_clip', 'switch_view', 'dismiss_dialogs', 'dismiss_onboarding'] as const;
const VIEWS = ['arrangement', 'piano_roll'] as const;
/** The workspace of OTCP that each view of the tool names. */
const WORKSPACE = { arrangement: 'arrangement', piano_roll: 'pianoRoll' } as const;
/** How a workspace of OTCP reads in a sentence, and the view of the tool that shows it. */
const WORKSPACE_WORDS = { arrangement: 'the arrangement view', pianoRoll: 'the piano roll' } as const;
const VIEW_OF = { arrangement: 'arrangement', pianoRoll: 'piano_roll' } as const;
const PLACEMENT_RE = /^p:[0-9a-f]{8}:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/;

export interface ManageUiArgs {
  readonly op: (typeof OPS)[number];
  readonly clip?: string | undefined;
  readonly open_editor?: boolean | undefined;
  readonly dry_run?: boolean | undefined;
  readonly accept_commit?: boolean | undefined;
  readonly view?: (typeof VIEWS)[number] | undefined;
  readonly instance_id?: string | undefined;
}

const natural = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
const count = (n: number, noun: string) => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

/**
 * The warning codes of a result, as the last sentence of a summary this file writes itself. The generic summary
 * of a write result names them; the summaries that replace it must not drop them, whichever branch they take.
 */
function warningTail(envelope: Json): string {
  const warnings = warningCodes(envelope);
  return warnings.length === 0 ? '' : ` Warnings: ${warnings.join(', ')}.`;
}

/** Side effects whose words are written out in focusSummary; any other one is named by the fixed table. */
const WORDED = new Set(['notesGenerated', 'uiScaleChanged', 'workspaceSwitched']);

/**
 * The summary of a clip selection. The side effects nobody asked for come first: they are the
 * reason to look at the result. Whether there are side effects is read from sideEffects and from
 * nothing else, and each one is named, also the switch of the view that open_editor asked for.
 * Counts are checked integers; names from OpenTune are never used.
 */
export function focusSummary(envelope: Json, openEditor = false): string {
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
  if (isObject(effects.uiScaleChanged)) unasked.push('the scale shown in the transport bar changes with the clip key');
  // The switch of the view is what open_editor asks for: it is said as part of the selection, not as a surprise.
  // Without open_editor it is a side effect nobody asked for.
  const switched = isObject(effects.workspaceSwitched) ? effects.workspaceSwitched : null;
  const route = switched === null ? '' : `from ${viewName(switched.from)} to ${viewName(switched.to)}`;
  if (switched !== null && !openEditor) unasked.push(`the window ${dry ? 'switches' : 'switched'} ${route}`);
  for (const name of Object.keys(effects)) {
    if (!WORDED.has(name)) {
      unasked.push(SIDE_EFFECT_TEXT[name] ?? `side effect ${token(name, 'camel') ?? 'with an unrecognized name'}`);
    }
  }
  const asked = switched !== null && openEditor;
  const tail = warningTail(envelope);
  const none = Object.keys(effects).length === 0;
  if (dry) {
    const selecting = asked ? `selecting the clip and switching the window ${route}` : 'selecting the clip';
    const would = none
      ? 'no side effects beyond the selection'
      : unasked.length === 0
        ? 'no other side effects'
        : `these side effects nobody asked for: ${unasked.join('; ')}`;
    return `${TOOL}: dry run, nothing was selected; ${selecting} would have ${would}.${tail}`;
  }
  if (envelope.noOp === true) return `${TOOL}: the clip was already selected; nothing was changed.${tail}`;
  const done = asked ? `selected the clip and switched the window ${route}, as open_editor asked` : 'selected the clip';
  if (none) return `${TOOL}: ${done}, with no side effects beyond the selection.${tail}`;
  return unasked.length === 0
    ? `${TOOL}: ${done}, with no other side effects.${tail}`
    : `${TOOL}: ${done}, and ALSO, which nobody asked for: ${unasked.join('; ')}.${tail}`;
}

const workspaceOf = (value: unknown): keyof typeof WORKSPACE_WORDS | null =>
  value === 'arrangement' || value === 'pianoRoll' ? value : null;

/**
 * Nothing but the workspace changed: only the window is listed in `changes`, no content, no mark on the
 * project, no side effect besides the switch.
 */
function viewOnly(envelope: Json): boolean {
  const effects = Object.keys(isObject(envelope.sideEffects) ? envelope.sideEffects : {});
  const diff = isObject(envelope.revisionDiff) ? envelope.revisionDiff : {};
  const dirty = isObject(envelope.dirty) ? envelope.dirty : {};
  return (
    Array.isArray(envelope.changes) &&
    envelope.changes.every((change) => isObject(change) && change.entity === 'ui') &&
    effects.every((name) => name === 'workspaceSwitched') &&
    warningCodes(envelope).length === 0 &&
    diff.arrangement === null &&
    diff.trackState === null &&
    Array.isArray(diff.contents) &&
    diff.contents.length === 0 &&
    typeof dirty.before === 'boolean' &&
    dirty.before === dirty.after
  );
}

/**
 * The summary of a view switch. It says which view the window shows now and that only the view changed. A
 * result that reports anything more (a side effect, a warning, a changed revision or mark) is not described
 * here: the generic summary of the write result names those, so `fallback` is returned for it.
 */
export function switchSummary(envelope: Json, view: (typeof VIEWS)[number], fallback: string): string {
  const asked = WORKSPACE[view];
  if (envelope.noOp === true) {
    return `${TOOL}: the window already shows ${WORKSPACE_WORDS[asked]}; nothing was changed.${warningTail(envelope)}`;
  }
  if (!viewOnly(envelope)) return fallback;
  const effects = isObject(envelope.sideEffects) ? envelope.sideEffects : {};
  const switched = isObject(effects.workspaceSwitched) ? effects.workspaceSwitched : {};
  const from = workspaceOf(switched.from);
  const ui = isObject(envelope.ui) ? envelope.ui : {};
  const empty =
    asked === 'pianoRoll' && Array.isArray(ui.selectedPlacementIds) && ui.selectedPlacementIds.length === 0
      ? ' No clip is selected, so the piano roll is empty; select one with focus_clip.'
      : '';
  const origin = from === null ? '' : `from ${WORKSPACE_WORDS[from]} `;
  const back = from === null ? '' : `; switch back with switch_view ${VIEW_OF[from]}`;
  // viewOnly has checked that dirty.before is a boolean equal to dirty.after: a project that had unsaved changes
  // still has them, and the sentence must not read as if the project had none.
  const dirty = isObject(envelope.dirty) ? envelope.dirty : {};
  const mark =
    dirty.before === true
      ? 'the project still has the unsaved changes it had before the switch'
      : 'the switch did not mark the project as changed';
  return (
    `${TOOL}: switched the window ${origin}to ${WORKSPACE_WORDS[asked]}, which changes the view only: ` +
    `no clip, note or setting changed and ${mark}${back}.${empty}`
  );
}

/** The error of switching the view on an instance that cannot: the user does it in the window. */
function switchUnsupported(error: ToolError): ToolError {
  return toolError('UNSUPPORTED', {
    reason: 'capability_missing',
    detail: error.detail,
    nextStep: {
      actor: 'user',
      message:
        'This OpenTune build cannot switch the view by request. Ask the user to click the arrangement view or ' +
        'piano roll button in the transport bar of the OpenTune window.',
    },
  });
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
  if (args.view !== undefined && args.op !== 'switch_view') {
    return invalid(`view belongs to switch_view, not to ${args.op}`, 'unexpected');
  }
  if (args.op === 'switch_view') {
    if (focusArgs || args.accept_commit !== undefined) {
      return invalid('switch_view takes only view, arrangement or piano_roll', 'unexpected');
    }
    if (args.view === undefined) {
      return invalid('switch_view needs view: arrangement or piano_roll', 'view_required');
    }
    call = { method: 'ui.setWorkspace', params: { workspace: WORKSPACE[args.view] } };
  } else if (args.op === 'focus_clip') {
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
  const view = args.op === 'switch_view' ? args.view : undefined;
  // switch_view needs ui.workspace and not ui.bridge: an instance can have either without the other.
  return withInstance(
    ctx,
    { instanceId: args.instance_id },
    view === undefined ? ['ui.bridge'] : [],
    async (session) => {
      if (view !== undefined) {
        const missing = missingCapability(session, ['ui.workspace']);
        if (missing !== null) return { ok: false, error: switchUnsupported(missing) };
      }
      // A dialog that commits on close is refused by the instance; the next step for
      // INVALID_ARGUMENT(dialog_commits_on_close) is the one in errors/next-step.ts.
      const run = await runWrites(session, TOOL, [call]);
      if ('stopped' in run) return args.op === 'dismiss_onboarding' ? onboardingUnsupported(run.stopped) : run.stopped;
      const [result] = run.results as readonly [WriteResult];
      // The instance that reports ui.workspace can switch the window back with switch_view; the revert line of a
      // switch the call made says so, and says otherwise when the instance cannot.
      const canSwitchView = session.hello.capabilities.includes('ui.workspace');
      const rendered = writeBody(result.envelope, { tool: TOOL, canSwitchView });
      if (args.op === 'focus_clip') {
        return { ok: true, body: { ...rendered, summary: focusSummary(result.envelope, args.open_editor === true) } };
      }
      if (view !== undefined) {
        return { ok: true, body: { ...rendered, summary: switchSummary(result.envelope, view, rendered.summary) } };
      }
      return { ok: true, body: rendered };
    },
  );
}

export const manageUiTool = defineTool({
  name: TOOL,
  title: 'Manage OpenTune window state',
  description:
    'OpenTune (audio vocal pitch editor): op focus_clip selects a clip, optionally opening the piano roll; ' +
    'selecting can generate the clip notes (no undo entry, project marked changed) and ' +
    'change the transport-bar scale, which dry_run predicts and a real result names first. switch_view shows view ' +
    'arrangement or piano_roll; arrangement closes the piano roll. dismiss_dialogs closes dialogs like Escape; ' +
    'one that commits its value needs accept_commit true, which only the user may allow. dismiss_onboarding marks ' +
    'first-run onboarding as shown (global, irreversible).',
  inputSchema: z.strictObject({
    op: z.enum(OPS),
    clip: z.string().optional().describe('focus_clip: clip placement id (p:...) from opentune_get_project.'),
    open_editor: z.boolean().optional().describe('focus_clip: also open the clip in the piano roll.'),
    dry_run: z.boolean().optional().describe('focus_clip: predict the effects, select nothing.'),
    view: z
      .enum(VIEWS)
      .optional()
      .describe('switch_view: the view to show; arrangement is what closing the piano roll returns to.'),
    accept_commit: z
      .boolean()
      .optional()
      .describe('dismiss_dialogs: true only when the user agreed that closing commits the value shown.'),
    instance_id: INSTANCE_FIELD,
  }),
  outputSchema: WRITE_RESULT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  capabilities: ['ui.bridge', 'ui.workspace'],
  otcpMethods: ['ui.setSelection', 'ui.setWorkspace', 'ui.dismiss'],
  run: (args, ctx) => manageUi(ctx, args),
});
