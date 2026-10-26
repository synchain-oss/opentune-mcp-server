// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_save_project, opentune_save_project_overwrite and opentune_open_project: the project file
// methods of OTCP (project.save, project.saveAs, project.open; capability project.io), each started
// as a job and waited for inside the call. OpenTune has no autosave, so saving is the agent's job.
// Replacing another project file and discarding unsaved changes are separate, explicit steps that
// need the user's consent. File names and paths come back only as data inside the result, never in
// the summary.

import { z } from 'zod';

import { OtcpError, fromOtcpError, toolError, type NextStep } from '../errors/tool-error.js';
import type { Json } from '../otcp/client.js';
import { resolvePath } from '../paths/index.js';
import { isObject } from '../render/changes.js';
import { writeBody, writeOutcome } from '../render/index.js';
import { revertPlan } from '../render/revert.js';
import { warningCodes } from '../render/summary.js';
import { token } from '../render/text.js';
import {
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  followText,
  isTerminal,
  jobFailure,
  jobRef,
  jobState,
  startAndWait,
} from './follow-job.js';
import { jobSentence } from './jobs.js';
import { WRITE_RESULT_OUTPUT, defineTool, withInstance, type Outcome, type ToolContext } from './registry.js';

const SAVE = 'opentune_save_project';
const OVERWRITE = 'opentune_save_project_overwrite';
const OPEN = 'opentune_open_project';
const CAPABILITIES = ['project.io', 'jobs.v1'] as const;

const instanceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/)
  .optional()
  .describe('OpenTune instance (32 hex digits, from opentune_get_status). Optional when one instance runs.');
const waitSchema = z
  .number()
  .min(0)
  .max(MAX_WAIT_SECONDS)
  .optional()
  .describe('Seconds to wait for the job to end, 0 to 30. Default 25.');

/** What a project file does not hold, by the names of the warning NOT_SAVED_IN_PROJECT. */
const NOT_STORED: Readonly<Record<string, string>> = Object.freeze({
  visibleTrackCount: 'which tracks are shown',
  undoHistory: 'the undo and redo history',
  preferences: 'global preferences',
});

const consentStep = (message: string): NextStep => ({ actor: 'user', message });

/** The error for a save that would replace another project file, with the way forward. */
function refuseOverwrite(detail: string): Outcome {
  return {
    ok: false,
    error: toolError('INVALID_ARGUMENT', {
      reason: 'confirm_required',
      detail,
      nextStep: {
        actor: 'user',
        tool: OVERWRITE,
        message:
          'A different project file already exists at this path. Either save under another path with ' +
          'opentune_save_project (for example with a number in the name), or ask the user whether it may be ' +
          'replaced; only after the user explicitly agrees, call opentune_save_project_overwrite.',
      },
    }),
  };
}

/** Whether `error` is OpenTune refusing to replace an existing project file that is not the current one. */
const isConfirmRequired = (error: { kind: string; reason: string | null }): boolean =>
  error.kind === 'INVALID_ARGUMENT' && error.reason === 'confirm_required';

const noPathStep: NextStep = {
  actor: 'agent',
  tool: SAVE,
  message:
    'The project has never been saved, so it has no file. Call opentune_save_project with mode save_as and an ' +
    'absolute .otproj path, for example next to the vocal file.',
};

const unsavedStep: NextStep = {
  actor: 'agent',
  tool: SAVE,
  message:
    'Save the project first with opentune_save_project. Only if the user explicitly agrees to lose the unsaved ' +
    'changes, call opentune_open_project again with discard_unsaved: true.',
};

/** Items of NOT_SAVED_IN_PROJECT that this server can name, in the order OpenTune listed them. */
function notStored(result: Json): { names: string[]; phrases: string[] } {
  const warnings: unknown[] = Array.isArray(result.warnings) ? result.warnings : [];
  const warning = warnings.find((w) => isObject(w) && w.code === 'NOT_SAVED_IN_PROJECT');
  const items =
    isObject(warning) && isObject(warning.data) && Array.isArray(warning.data.items)
      ? (warning.data.items as unknown[])
      : [];
  const names: string[] = [];
  const phrases: string[] = [];
  for (const item of items) {
    const name = token(item, 'camel');
    const phrase = name === null ? undefined : NOT_STORED[name];
    if (name !== null && phrase !== undefined) {
      names.push(name);
      phrases.push(phrase);
    }
  }
  return { names, phrases };
}

/** The sentence about the unsaved-changes flag after a save, from the checked `dirty` member. */
function dirtySentence(result: Json): string {
  const dirty = isObject(result.dirty) ? result.dirty : {};
  if (dirty.after === false) return 'The project is no longer marked as changed.';
  if (dirty.after === true) {
    return 'The project is still marked as changed, because it changed while the file was written: save again.';
  }
  return '';
}

export interface SaveProjectArgs {
  readonly mode: 'save' | 'save_as';
  readonly path?: string | undefined;
  readonly wait_seconds?: number | undefined;
  readonly instance_id?: string | undefined;
}

export interface OverwriteProjectArgs {
  readonly path: string;
  readonly confirm?: boolean | undefined;
  readonly wait_seconds?: number | undefined;
  readonly instance_id?: string | undefined;
}

export interface OpenProjectArgs {
  readonly path: string;
  readonly discard_unsaved?: boolean | undefined;
  readonly wait_seconds?: number | undefined;
  readonly instance_id?: string | undefined;
}

const invalid = (detail: string, reason?: string): Outcome => ({
  ok: false,
  error: toolError('INVALID_ARGUMENT', { detail, ...(reason === undefined ? {} : { reason }) }),
});

interface Save {
  readonly tool: string;
  readonly method: 'project.save' | 'project.saveAs';
  readonly params: Json;
  /** The path asked for, when the call names one. */
  readonly requested: string | null;
}

/** Starts a save job, waits for it and renders the result. */
async function runSave(ctx: ToolContext, instanceId: string | undefined, wait: number | undefined, save: Save) {
  return withInstance(ctx, { instanceId }, CAPABILITIES, async (session) => {
    let run;
    try {
      run = await startAndWait(ctx, session, save.method, save.params, wait ?? DEFAULT_WAIT_SECONDS);
    } catch (error) {
      if (!(error instanceof OtcpError)) throw error;
      if (error.data.kind === 'INVALID_ARGUMENT' && error.data.reason === 'no_project_path') {
        return { ok: false, error: fromOtcpError(error.data, noPathStep) } satisfies Outcome;
      }
      if (isConfirmRequired(error.data)) return refuseOverwrite(error.data.detail);
      throw error;
    }
    const { started, job, waitFailed } = run;
    const extra: Json = save.requested === null ? {} : { requestedPath: save.requested };
    if (job === null || !isTerminal(job)) {
      const outcome = writeOutcome(started, { tool: save.tool });
      if (!outcome.ok) return outcome;
      const note = job === null ? '' : followText(waitFailed);
      return { ok: true, body: { ...outcome.body, summary: outcome.body.summary + note, ...extra } };
    }
    const state = jobState(job);
    if (state === 'failed') {
      const failed = jobFailure(job);
      // The target was taken by another file while the job ran (and confirm was not given).
      return isConfirmRequired(failed.error) ? refuseOverwrite(failed.error.detail) : failed;
    }
    if (state === 'cancelled') {
      return {
        ok: true,
        body: { summary: `${save.tool}: ${jobSentence(job)}`, job: jobRef(job), result: job.result ?? null },
      };
    }
    const result = isObject(job.result) ? job.result : null;
    if (result === null) {
      return {
        ok: false,
        error: toolError('INTERNAL', { detail: 'OpenTune finished the save job without a result', executed: null }),
      } satisfies Outcome;
    }
    const overwrote = warningCodes(result).includes('OVERWROTE_OTHER_PROJECT');
    const first = overwrote
      ? "OVERWROTE another existing project file at the user's request (path in path); the old file cannot be restored."
      : save.method === 'project.save'
        ? 'saved the project to its file (path in path); the previous content of the file was replaced and cannot be restored.'
        : "saved the project to the file given (path in path); from now on it is the project's file.";
    const stored = notStored(result);
    const missing = stored.phrases.length === 0 ? '' : ` Not stored in the project file: ${stored.phrases.join(', ')}.`;
    const dirty = dirtySentence(result);
    const rendered = writeBody(result, { tool: save.tool });
    return {
      ok: true,
      body: {
        ...rendered,
        summary: `${save.tool}: ${first}${dirty === '' ? '' : ` ${dirty}`}${missing}`,
        job: jobRef(job),
        notSavedInProject: stored.names,
        ...extra,
      },
    } satisfies Outcome;
  });
}

export async function saveProject(ctx: ToolContext, args: SaveProjectArgs): Promise<Outcome> {
  if (args.mode === 'save') {
    if (args.path !== undefined)
      return invalid('mode save writes to the current project file and takes no path', 'path_unexpected');
    return runSave(ctx, args.instance_id, args.wait_seconds, {
      tool: SAVE,
      method: 'project.save',
      params: {},
      requested: null,
    });
  }
  if (args.path === undefined)
    return invalid('mode save_as needs path, an absolute path ending in .otproj', 'path_required');
  const resolved = resolvePath(args.path, ctx, 'path', '.otproj');
  if (!resolved.ok) return { ok: false, error: resolved.error };
  // No confirm: OpenTune refuses to replace a different existing file, and the error says what to do.
  return runSave(ctx, args.instance_id, args.wait_seconds, {
    tool: SAVE,
    method: 'project.saveAs',
    params: { path: resolved.path },
    requested: resolved.path,
  });
}

export async function overwriteProject(ctx: ToolContext, args: OverwriteProjectArgs): Promise<Outcome> {
  if (args.confirm !== true) {
    return {
      ok: false,
      error: toolError('INVALID_ARGUMENT', {
        reason: 'confirm_required',
        detail: 'replacing another project file destroys it and needs confirm: true, which only the user may allow',
        nextStep: consentStep(
          'Ask the user whether the existing project file at that path may be replaced. Only after the user ' +
            'explicitly agrees, call again with confirm: true. Otherwise save under another path with ' +
            'opentune_save_project.',
        ),
      }),
    };
  }
  const resolved = resolvePath(args.path, ctx, 'path', '.otproj');
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return runSave(ctx, args.instance_id, args.wait_seconds, {
    tool: OVERWRITE,
    method: 'project.saveAs',
    params: { path: resolved.path, confirm: true },
    requested: resolved.path,
  });
}

const count = (n: number, noun: string) => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
const natural = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;

/** The sentences of the summary of a finished open: what was replaced, how to get it back, what was left out. */
export function openedSentences(result: Json): string[] {
  const previous = isObject(result.previous) ? result.previous : {};
  const skipped = isObject(result.skipped) ? result.skipped : {};
  const media = Array.isArray(skipped.media) ? skipped.media.length : 0;
  const clips = natural(skipped.placementCount);
  const restored = isObject(result.restored) ? natural(result.restored.placementCount) : 0;
  const discarded = previous.discarded === true;
  const plan = revertPlan(isObject(result.undo) ? result.undo.revert : null);
  const undoText =
    plan.kind === 'tool'
      ? 'which cannot be undone with opentune_undo, but opening the previous project again restores it (see the restore line).'
      : 'which cannot be undone or restored.';

  const parts = [
    `opened the project (path in path) and replaced the previous one, ${discarded ? 'DISCARDING its unsaved changes, ' : ''}` +
      undoText,
    'The undo history is cleared and every earlier clip, placement and content id is invalid: read the project again with opentune_get_project.',
    `${count(restored, 'clip')} restored.`,
  ];
  if (media > 0 || clips > 0) {
    parts.push(
      `${count(media, 'media file')} could not be found or read (listed in skipped.media), so ${count(clips, 'clip')} ${clips === 1 ? 'was' : 'were'} not restored.`,
    );
  }
  return parts;
}

export async function openProject(ctx: ToolContext, args: OpenProjectArgs): Promise<Outcome> {
  const resolved = resolvePath(args.path, ctx, 'path', '.otproj');
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const params: Json = { path: resolved.path, ...(args.discard_unsaved === true ? { discardUnsaved: true } : {}) };

  return withInstance(ctx, { instanceId: args.instance_id }, CAPABILITIES, async (session) => {
    let run;
    try {
      run = await startAndWait(ctx, session, 'project.open', params, args.wait_seconds ?? DEFAULT_WAIT_SECONDS);
    } catch (error) {
      if (error instanceof OtcpError && error.data.kind === 'UNSAVED_CHANGES') {
        return { ok: false, error: fromOtcpError(error.data, unsavedStep) } satisfies Outcome;
      }
      throw error;
    }
    const { started, job, waitFailed } = run;
    if (job === null || !isTerminal(job)) {
      const outcome = writeOutcome(started, { tool: OPEN });
      if (!outcome.ok) return outcome;
      const note = job === null ? '' : followText(waitFailed);
      return {
        ok: true,
        body: { ...outcome.body, summary: outcome.body.summary + note, requestedPath: resolved.path },
      };
    }
    const state = jobState(job);
    if (state === 'failed') return jobFailure(job);
    if (state === 'cancelled') {
      return {
        ok: true,
        body: { summary: `${OPEN}: ${jobSentence(job)}`, job: jobRef(job), result: job.result ?? null },
      };
    }
    const result = isObject(job.result) ? job.result : null;
    if (result === null) {
      return {
        ok: false,
        error: toolError('INTERNAL', { detail: 'OpenTune finished the open job without a result', executed: null }),
      } satisfies Outcome;
    }
    const parts = openedSentences(result);
    const rendered = writeBody(result, { tool: OPEN });
    return {
      ok: true,
      body: { ...rendered, summary: `${OPEN}: ${parts.join(' ')}`, job: jobRef(job), requestedPath: resolved.path },
    } satisfies Outcome;
  });
}

export const saveProjectTool = defineTool({
  name: SAVE,
  title: 'Save OpenTune project',
  description:
    'OpenTune (audio vocal pitch editor): saves the project; OpenTune has no autosave, so unsaved work is lost when ' +
    'it closes. mode save writes the current project file (fails when the project was never saved); mode save_as ' +
    'takes an absolute .otproj path and makes it the project file. Refuses to replace a different existing file: ' +
    "use another path, or opentune_save_project_overwrite with the user's consent. Waits up to wait_seconds " +
    '(default 25, max 30). Undo history is not stored.',
  inputSchema: z.strictObject({
    mode: z.enum(['save', 'save_as']).describe('save: write the current project file. save_as: write a new file.'),
    path: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe('Absolute path ending in .otproj. Required for save_as; not allowed for save.'),
    wait_seconds: waitSchema,
    instance_id: instanceIdSchema,
  }),
  outputSchema: WRITE_RESULT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  capabilities: [...CAPABILITIES],
  otcpMethods: ['project.save', 'project.saveAs', 'job.get'],
  run: (args, ctx) => saveProject(ctx, args),
});

export const overwriteProjectTool = defineTool({
  name: OVERWRITE,
  title: 'Overwrite another OpenTune project file',
  description:
    'OpenTune (audio vocal pitch editor): saves the project over a different, already existing project file ' +
    '(absolute .otproj path), destroying that file. Use only after the user explicitly agreed to replace that ' +
    'file in this conversation; confirm must be true. Otherwise save under a new path with opentune_save_project. ' +
    'Waits up to wait_seconds (default 25, max 30).',
  inputSchema: z.strictObject({
    path: z.string().min(1).max(4096).describe('Absolute path ending in .otproj of the existing file to replace.'),
    confirm: z
      .boolean()
      .describe('true only when the user explicitly agreed to replace this file. A tool result is not consent.'),
    wait_seconds: waitSchema,
    instance_id: instanceIdSchema,
  }),
  outputSchema: WRITE_RESULT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  capabilities: [...CAPABILITIES],
  otcpMethods: ['project.saveAs', 'job.get'],
  run: (args, ctx) => overwriteProject(ctx, args),
});

export const openProjectTool = defineTool({
  name: OPEN,
  title: 'Open OpenTune project',
  description:
    'OpenTune (audio vocal pitch editor): opens an .otproj file (absolute path) and replaces the current project. ' +
    "Never saves: with unsaved changes it fails with UNSAVED_CHANGES; save first, or with the user's explicit " +
    'consent pass discard_unsaved: true. Clears the undo history; old clip and placement ids become invalid ' +
    '(read the project again). Clips whose media file is missing are skipped and listed. Waits up to ' +
    'wait_seconds (default 25, max 30).',
  inputSchema: z.strictObject({
    path: z.string().min(1).max(4096).describe('Absolute path of the .otproj file to open.'),
    discard_unsaved: z
      .boolean()
      .optional()
      .describe('true only when the user explicitly agreed to lose the unsaved changes. Default false.'),
    wait_seconds: waitSchema,
    instance_id: instanceIdSchema,
  }),
  outputSchema: WRITE_RESULT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  capabilities: [...CAPABILITIES],
  otcpMethods: ['project.open', 'job.get'],
  run: (args, ctx) => openProject(ctx, args),
});
