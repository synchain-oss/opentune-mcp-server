// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_quit: closes OpenTune through app.quit (capability app.quit), as the close button of its
// window does, but never over unsaved changes unless the user agreed to lose them. OpenTune answers
// first and then exits, so the tool waits until the instance is really gone (its discovery file is
// removed or its process has ended) before it reports, and drops the connection it held. The result
// is not a write envelope: nothing can be undone, and the instance has no state left to compare.
// The path of the project file comes back only as data inside the result, never in the summary.

import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { z } from 'zod';

import { OtcpError, fromOtcpError, toolError, type NextStep, type ToolError } from '../errors/tool-error.js';
import type { Json, OtcpSession } from '../otcp/client.js';
import { missingCapability } from '../otcp/instances.js';
import { INSTANCE_FIELD, READ_TIMEOUT_MS, isObject } from './clip-write.js';
import { defineTool, withInstance, type Outcome, type ToolContext } from './registry.js';

const TOOL = 'opentune_quit';
const CAPABILITY = 'app.quit';
/** OpenTune answers app.quit before it exits; the answer takes no longer than a write. */
const QUIT_TIMEOUT_MS = 30_000;
/** What the wait for the exit adds to exitDeadlineMs, for a slow machine and the time to see the file go. */
const EXIT_MARGIN_MS = 2000;
/** Used when the result names no usable exitDeadlineMs; the value the specification suggests. */
const DEFAULT_EXIT_DEADLINE_MS = 5000;

export interface QuitArgs {
  readonly discard_unsaved?: boolean | undefined;
  readonly instance_id?: string | undefined;
}

const AFTER_ANSWER =
  'After a save, call opentune_quit again. Only if the user explicitly agrees to throw the unsaved changes away, ' +
  'call opentune_quit again with discard_unsaved: true.';

/** Whether the project has a file, read after the refusal; null when that cannot be told. */
async function projectHasFile(session: OtcpSession): Promise<boolean | null> {
  if (!session.hello.capabilities.includes('read.v1')) return null;
  try {
    const { project } = await session.call('project.get', {}, READ_TIMEOUT_MS);
    return isObject(project) ? typeof project.path === 'string' : null;
  } catch {
    return null;
  }
}

/**
 * What to do about unsaved changes. The agent never saves the project file on its own: it writes a copy (an autosave,
 * which leaves the project file alone) where the project has a file, and the user decides between a formal save and
 * dropping the changes. Without a file there is no copy to write, so the step is the user's.
 */
async function unsavedStep(session: OtcpSession): Promise<NextStep> {
  const hasFile = await projectHasFile(session);
  if (hasFile === true) {
    return {
      actor: 'agent',
      tool: 'opentune_save_project',
      args: { mode: 'autosave' },
      message:
        'Write a copy first with opentune_save_project (mode autosave): it keeps the work and leaves the project ' +
        'file alone. Then ask the user whether to save the project file (opentune_save_project, mode save) or to ' +
        `throw the unsaved changes away; do neither without an answer. ${AFTER_ANSWER}`,
    };
  }
  const options =
    hasFile === false
      ? 'The project was never saved, so it has no file and no copy can be written. Ask the user whether to save it ' +
        '(opentune_save_project, mode save_as, an absolute .otproj path, for example next to the vocal file) or to ' +
        'throw the unsaved changes away'
      : 'Ask the user whether to save the project (opentune_save_project, mode save; or mode save_as with an ' +
        'absolute .otproj path if it was never saved) or to throw the unsaved changes away; if the project has a ' +
        'file, write a copy first with mode autosave';
  return { actor: 'user', message: `${options}; do neither without an answer. ${AFTER_ANSWER}` };
}

/** The error of an instance that cannot be closed by request: the user closes the window themselves. */
function cannotQuit(missing: ToolError): ToolError {
  return toolError('UNSUPPORTED', {
    reason: 'capability_missing',
    detail: missing.detail,
    nextStep: {
      actor: 'user',
      message:
        'This OpenTune build cannot be closed by request. If the project has a file, write a copy first with ' +
        'opentune_save_project (mode autosave) and ask the user whether to save the project file before they close ' +
        'the OpenTune window themselves. Closing the window does not ask about unsaved changes.',
    },
  });
}

/** The time OpenTune gave itself to exit, from the result; the suggested default when it names none. */
function exitDeadline(result: Json): number {
  const ms = result.exitDeadlineMs;
  return typeof ms === 'number' && Number.isInteger(ms) && ms >= 1 && ms <= 60_000 ? ms : DEFAULT_EXIT_DEADLINE_MS;
}

/**
 * What the watch for the exit found. `exited` is true when the instance is gone (its discovery file removed, or its
 * process ended), false when it was still listed at the last look after the time given, and null when no look at the
 * discovery directory succeeded in that time: nothing is known then, and `problem` says why.
 */
type ExitWatch = { readonly exited: boolean } | { readonly exited: null; readonly problem: string };

/** Looks for the instance until it is gone or `limitMs` has passed; a failed look is tried again, it is not an answer. */
async function waitForExit(ctx: ToolContext, instanceId: string, limitMs: number): Promise<ExitWatch> {
  const deadline = performance.now() + limitMs;
  let problem = 'the discovery directory could not be read';
  let looked = false;
  for (;;) {
    const scan = await ctx.instances.scan();
    if ('instances' in scan) {
      looked = true;
      if (!scan.instances.some((instance) => instance.instanceId === instanceId)) return { exited: true };
    } else {
      problem = scan.detail;
    }
    if (performance.now() >= deadline) return looked ? { exited: false } : { exited: null, problem };
    await sleep(ctx.launch.pollMs);
  }
}

/** The summary: what happened to the application and to the unsaved work first, then what the agent may do. */
function summaryOf(discarded: boolean, watch: ExitWatch, waitedMs: number, hasPath: boolean): string {
  const seconds = String(Math.round(waitedMs / 1000));
  const lost = 'OpenTune was told to close without saving, so the unsaved changes are lost, but ';
  let first: string;
  if (watch.exited === true) {
    first = discarded ? 'OpenTune closed without saving; the unsaved changes are lost.' : 'OpenTune closed.';
  } else if (watch.exited === null) {
    // Nothing could be looked at: no claim of how long it took, only that it is not known.
    const unknown = `it could not be confirmed whether it has exited (${watch.problem}).`;
    first = discarded ? `${lost}${unknown}` : `OpenTune accepted the request to close, but ${unknown}`;
  } else if (discarded) {
    first = `${lost}it had not exited after ${seconds} s; it may still be shutting down.`;
  } else {
    first = `OpenTune accepted the request to close but had not exited after ${seconds} s; it may still be shutting down.`;
  }
  const rest = [
    watch.exited === true ? '' : 'Check opentune_get_status before assuming it is closed.',
    hasPath ? 'The project file is at the path in projectPath.' : 'The project had no file: it was never saved.',
    'To work again, start OpenTune with opentune_launch.',
  ].filter((sentence) => sentence !== '');
  return [first, ...rest].join(' ');
}

export async function quit(ctx: ToolContext, args: QuitArgs): Promise<Outcome> {
  const params: Json = args.discard_unsaved === true ? { discardUnsaved: true } : {};
  // The capability is checked inside, so that its error can name the way out for this tool.
  return withInstance(ctx, { instanceId: args.instance_id }, [], async (session, entry) => {
    const missing = missingCapability(session, [CAPABILITY]);
    if (missing !== null) return { ok: false, error: cannotQuit(missing) };
    let result: Json;
    try {
      result = await session.call('app.quit', params, QUIT_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof OtcpError && error.data.kind === 'UNSAVED_CHANGES') {
        return { ok: false, error: fromOtcpError(error.data, await unsavedStep(session)) };
      }
      throw error;
    }
    if (result.quitting !== true) {
      return {
        ok: false,
        error: toolError('INTERNAL', { detail: 'OpenTune answered app.quit without quitting: true', executed: null }),
      };
    }
    // The server closes every connection as it stops; this one is of no use any more.
    ctx.instances.forget(entry.instanceId);
    const deadlineMs = exitDeadline(result);
    const waitMs = deadlineMs + EXIT_MARGIN_MS;
    const started = performance.now();
    const watch = await waitForExit(ctx, entry.instanceId, waitMs);
    const discarded = result.discardedUnsavedChanges === true;
    const projectPath = typeof result.projectPath === 'string' ? result.projectPath : null;
    // exited is true (gone), false (still listed after the time given) or null (never seen: the reason is given).
    const reasons: Json = {
      ...(isObject(result.nullReasons) ? result.nullReasons : {}),
      ...(watch.exited === null ? { exited: 'not_observable' } : {}),
    };
    return {
      ok: true,
      body: {
        summary: summaryOf(discarded, watch, performance.now() - started, projectPath !== null),
        quitting: true,
        exited: watch.exited,
        ...(watch.exited === null ? { exitCheckProblem: watch.problem } : {}),
        discardedUnsavedChanges: discarded,
        projectPath,
        ...(Object.keys(reasons).length > 0 ? { nullReasons: reasons } : {}),
        exitDeadlineMs: deadlineMs,
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
      },
    };
  });
}

export const quitTool = defineTool({
  name: TOOL,
  title: 'Quit OpenTune',
  description:
    "OpenTune (audio vocal pitch editor): closes OpenTune like the window's close button and waits until it has " +
    'exited. Unlike the window, it never closes silently over unsaved changes: it fails with UNSAVED_CHANGES. Then ' +
    'write a copy with opentune_save_project (mode autosave) and ask the user to save or to give the changes up; ' +
    'pass discard_unsaved: true only when the user explicitly agreed to lose them (cannot be undone). Refuses ' +
    'while a dialog is open or a job runs. Use when the user says they are done, not for a pause. Start OpenTune ' +
    'again with opentune_launch.',
  inputSchema: z.strictObject({
    discard_unsaved: z
      .boolean()
      .optional()
      .describe('true only when the user explicitly agreed to lose the unsaved changes. Default false.'),
    instance_id: INSTANCE_FIELD,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  capabilities: [CAPABILITY],
  // Only what the tool needs. After a refusal for unsaved changes it also reads project.get, when the instance
  // offers read.v1, to tell the agent whether to save or to save under a path; that read is not required.
  otcpMethods: ['app.quit'],
  run: (args, ctx) => quit(ctx, args),
});
