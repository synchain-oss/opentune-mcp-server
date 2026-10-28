// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_save_project, opentune_save_project_overwrite and opentune_open_project: the project file
// methods of OTCP (project.save, project.saveAs, project.saveCopy, project.open; capabilities
// project.io and project.copy), each started as a job and waited for inside the call. OpenTune has no
// autosave of its own, so this tool provides one: mode autosave writes a numbered copy of the project
// into <name>.autosave next to the project file and never touches the project file, its unsaved-changes
// flag or the recent-projects list. Replacing the project file (mode save, save_as, the overwrite tool)
// first copies the old content into <name>.oldversion, together with the audio the old content uses (the files of
// the Project_Media folder next to that file, into <name>.oldversion/Project_Media, where an old version looks for
// its audio; a failure to copy the audio does not stop the save and comes back as a warning); replacing another
// project file and discarding unsaved changes are separate, explicit steps that need the user's consent. The file
// system work is in src/files/project-folders.ts. File names and paths come back only as data inside the result,
// never in the summary.

import { z } from 'zod';

import { OtcpError, fromOtcpError, toolError, type NextStep } from '../errors/tool-error.js';
import {
  AUTOSAVE_KEEP,
  OLDVERSION_KEEP,
  ProjectFolders,
  copyToOldVersions,
  nextAutosaveNumber,
  nodeProjectFs,
  removeOldVersion,
  rollAutosaves,
  rollOldVersions,
  type MediaCopy,
  type OldVersion,
  type ProjectFs,
  type Rolled,
} from '../files/project-folders.js';
import type { Json, OtcpSession } from '../otcp/client.js';
import { resolvePath, splitPath, systemOf, type PathSystem } from '../paths/index.js';
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
/** The save modes also read the project (project.get) to tell which file a save replaces. */
const SAVE_CAPABILITIES = ['project.io', 'jobs.v1', 'read.v1'] as const;
/** What mode autosave needs besides project.copy, which it checks itself to give its own next step. */
const AUTOSAVE_CAPABILITIES = ['read.v1', 'jobs.v1'] as const;
const COPY_CAPABILITY = 'project.copy';
const READ_TIMEOUT_MS = 15_000;

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

/**
 * What OpenTune does at every save, whatever its result says: it first copies the audio the project uses into the
 * folder Project_Media next to the project file (files copied before and unchanged are skipped; an older file of
 * the same name is replaced, which in a folder shared with another OpenTune project can replace that project's audio:
 * OpenTune's own behavior, and the reason autosave copies get a folder of their own). The sentence is fixed and is
 * not built from anything the result holds.
 */
const MEDIA_COPY =
  'OpenTune also copies the audio the project uses into the Project_Media folder next to the project file.';
const MEDIA_FOLDER = 'Project_Media';

/**
 * The media folder of a project file this server was told the path of (save_as and overwrite, whose path it checked
 * itself); null for a save to the project's current file, whose path only OpenTune knows.
 */
function mediaFolderOf(file: string | null, platform: NodeJS.Platform): string | null {
  if (file === null) return null;
  const { dir, sep } = splitPath(file, systemOf(platform));
  return `${dir}${sep}${MEDIA_FOLDER}`;
}

/**
 * The members of a save result that give the media folder: `mediaFolder`, and when it is null, its reason. The write
 * envelope may carry nullReasons of its own (for members of the envelope that are null); they stay, and the reason of
 * the member this server adds is put next to them, so that no null member of the result loses its reason.
 */
export function mediaFolderMembers(rendered: Json, media: string | null): Json {
  if (media !== null) return { mediaFolder: media };
  return {
    mediaFolder: null,
    nullReasons: {
      ...(isObject(rendered.nullReasons) ? rendered.nullReasons : {}),
      mediaFolder: 'project_path_not_given',
    },
  };
}

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

/**
 * The agent writes a copy (an autosave leaves the project file alone) and asks; it never saves the project file or
 * gives the changes up on its own.
 */
const unsavedStep: NextStep = {
  actor: 'agent',
  tool: SAVE,
  args: { mode: 'autosave' },
  message:
    'Write a copy first with opentune_save_project (mode autosave; a project that was never saved has no file for a ' +
    'copy, so skip it). Then ask the user whether to save the project (mode save, or mode save_as with an absolute ' +
    '.otproj path if it was never saved) or to throw the unsaved changes away; do neither without an answer. After ' +
    'a save, call opentune_open_project again. Only if the user explicitly agrees to throw the changes away, call ' +
    'it again with discard_unsaved: true.',
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

/** Whether the result lists the project's path as changed (entity project, member path, before and after differ). */
function projectPathChanged(result: Json): boolean {
  return (Array.isArray(result.changes) ? (result.changes as unknown[]) : []).some((item) => {
    if (!isObject(item) || item.entity !== 'project' || !isObject(item.fields) || !isObject(item.fields.path)) {
      return false;
    }
    const { before, after } = item.fields.path;
    return typeof after === 'string' && after !== before;
  });
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
  readonly mode: 'autosave' | 'save' | 'save_as';
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

/** Which file a formal save replaces, and so must keep an old version of first. */
type Replaces =
  /** The project's current file (mode save). */
  | 'current'
  /** The file asked for, but only when it is the project's current file (mode save_as): another file is refused. */
  | 'requested-if-current'
  /** The file asked for, whatever it is (the overwrite tool). */
  | 'requested';

interface Save {
  readonly tool: string;
  readonly method: 'project.save' | 'project.saveAs';
  readonly params: Json;
  /** The path asked for, when the call names one. */
  readonly requested: string | null;
  readonly replaces: Replaces;
}

const comparable = (file: string, system: PathSystem): string => (system === 'windows' ? file.toLowerCase() : file);

/** The path of the project's current file, or null when the project has none. */
async function currentProjectFile(session: OtcpSession): Promise<string | null> {
  const answer = await session.call('project.get', {}, READ_TIMEOUT_MS);
  const project = answer.project;
  return isObject(project) && typeof project.path === 'string' ? project.path : null;
}

/** The file this save is about to replace, or null when it replaces no file that exists. */
async function replacedFile(
  ops: ProjectFs,
  session: OtcpSession,
  save: Save,
  system: PathSystem,
): Promise<string | null> {
  const target = save.requested;
  if (save.replaces === 'requested') return target !== null && (await ops.fileExists(target)) ? target : null;
  const current = await currentProjectFile(session);
  if (current === null) return null;
  if (save.replaces === 'current') return (await ops.fileExists(current)) ? current : null;
  if (target === null || !(await ops.fileExists(target))) return null;
  const same = comparable(target, system) === comparable(current, system) || (await ops.sameFile(current, target));
  return same ? target : null;
}

/** The file system code of a failure as a fixed token, for a detail; never free text. */
function codeSuffix(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{2,16}$/.test(code) ? ` (${code})` : '';
}

/** The error for an old version that could not be kept: nothing is saved, so the file is as it was. */
function backupFailed(detail: string): Outcome {
  return {
    ok: false,
    error: toolError('IO_ERROR', {
      reason: 'backup_failed',
      detail: `${detail}; the project was not saved and its file is unchanged`,
      nextStep: {
        actor: 'user',
        message:
          'The earlier content of the project file could not be kept in its oldversion folder, so nothing was ' +
          'saved: this server never replaces a file without keeping the old version. The folder may be read-only, ' +
          'full or not allowed. Tell the user; with their agreement, save under another path with ' +
          'opentune_save_project (mode save_as).',
      },
    }),
  };
}

/** What happened before the save: the old version that was kept (null when the save replaces no file), or the refusal. */
type Prepared =
  | { readonly ok: true; readonly backup: OldVersion | null; readonly folders: ProjectFolders | null }
  | { readonly ok: false; readonly outcome: Outcome };

/**
 * Copies the file the save is about to replace into the oldversion folder next to it. Any failure on the way stops
 * the save: a file is never replaced without its old version kept.
 */
async function keepOldVersion(ctx: ToolContext, session: OtcpSession, save: Save): Promise<Prepared> {
  const ops = ctx.files ?? nodeProjectFs;
  let source: string | null;
  try {
    source = await replacedFile(ops, session, save, systemOf(ctx.platform));
  } catch (error) {
    if (error instanceof OtcpError) throw error;
    return { ok: false, outcome: backupFailed(`the file to be replaced could not be inspected${codeSuffix(error)}`) };
  }
  if (source === null) return { ok: true, backup: null, folders: null };
  const folders = ProjectFolders.of(source, ctx.platform);
  if (folders === null) {
    return {
      ok: false,
      outcome: backupFailed('the file to be replaced is not an absolute .otproj path an old version can be kept for'),
    };
  }
  try {
    return { ok: true, backup: await copyToOldVersions(ops, folders, ctx.now()), folders };
  } catch (error) {
    return {
      ok: false,
      outcome: backupFailed(`the file to be replaced could not be copied to its oldversion folder${codeSuffix(error)}`),
    };
  }
}

/** The sentence about the old versions deleted to keep the newest ones; empty when none was. */
function rolledSentence(rolled: Rolled | null, keep: number, singular: string, plural: string): string {
  if (rolled === null) return '';
  const removed =
    rolled.removed === 0
      ? ''
      : ` ${String(rolled.removed)} ${rolled.removed === 1 ? singular : plural} beyond the newest ${String(keep)} ${rolled.removed === 1 ? 'was' : 'were'} deleted from that folder.`;
  const failed = rolled.failed === 0 ? '' : ` Some ${plural} beyond the newest ${String(keep)} could not be deleted.`;
  return removed + failed;
}

const KEPT =
  'a copy of the replaced content was kept in the oldversion folder next to that file (path in oldVersion.path); ' +
  'opening that copy with opentune_open_project goes back to it.';

/**
 * The code of the warning line this server adds when the audio of a replaced project could not be copied beside its old
 * version. It is not a code of OpenTune's registry, so the line says `source: 'server'`.
 */
const MEDIA_NOT_COPIED = 'OLD_VERSION_MEDIA_NOT_COPIED';

/** The sentence of the summary for audio that was not copied. Fixed: the names are data in oldVersion.media. */
const MEDIA_NOT_COPIED_SENTENCE =
  ' The audio of the replaced project could not be copied completely into the Project_Media folder inside the ' +
  'oldversion folder (listed in oldVersion.media.notCopied), so that old version may not find its audio when it is ' +
  'opened after the original audio files are gone.';

/** `oldVersion.media`: how many audio files were copied, and which were not (`notCopied`, relative paths, as data). */
const mediaMember = (media: MediaCopy): Json => ({
  copied: media.copied,
  notCopied: [...media.notCopied],
  notCopiedCount: media.notCopiedCount,
});

/** The sentence about audio that was not copied, or nothing when all of it was (or there was none). */
const mediaSentence = (backup: OldVersion | null): string =>
  backup === null || backup.media.notCopiedCount === 0 ? '' : MEDIA_NOT_COPIED_SENTENCE;

/** The lines of a result, and the warning line about audio that was not copied when some was not. */
function linesWithMedia(lines: unknown, backup: OldVersion | null): unknown[] {
  const own = Array.isArray(lines) ? (lines as unknown[]) : [];
  if (backup === null || backup.media.notCopiedCount === 0) return own;
  const warning: Json = {
    kind: 'warning',
    code: MEDIA_NOT_COPIED,
    source: 'server',
    text:
      'The audio of the replaced project was not copied completely into the Project_Media folder inside the ' +
      'oldversion folder, so that old version may not find its audio when it is opened after the original audio ' +
      'files are gone (the files are in data.notCopied).',
    subject: null,
    data: { notCopied: [...backup.media.notCopied], notCopiedCount: backup.media.notCopiedCount },
  };
  return [...own, warning];
}

/** Starts a save job, waits for it and renders the result. */
async function runSave(ctx: ToolContext, instanceId: string | undefined, wait: number | undefined, save: Save) {
  const capabilities = save.replaces === 'requested' ? CAPABILITIES : SAVE_CAPABILITIES;
  return withInstance(ctx, { instanceId }, capabilities, async (session) => {
    const ops = ctx.files ?? nodeProjectFs;
    const prepared = await keepOldVersion(ctx, session, save);
    if (!prepared.ok) return prepared.outcome;
    const { backup, folders } = prepared;
    // The old version made for a save that did not happen is deleted again: the file it copied is still there. One
    // that was there before (the newest already held the content) is not this save's to delete.
    const dropBackup = async (): Promise<void> => {
      if (backup !== null && !backup.reused && folders !== null) await removeOldVersion(ops, folders, backup.name);
    };
    let run;
    try {
      run = await startAndWait(ctx, session, save.method, save.params, wait ?? DEFAULT_WAIT_SECONDS);
    } catch (error) {
      if (!(error instanceof OtcpError)) throw error;
      // OpenTune refused to start the save (executed false): nothing was replaced.
      if (error.data.executed === false) await dropBackup();
      if (error.data.kind === 'INVALID_ARGUMENT' && error.data.reason === 'no_project_path') {
        return { ok: false, error: fromOtcpError(error.data, noPathStep) } satisfies Outcome;
      }
      if (isConfirmRequired(error.data)) return refuseOverwrite(error.data.detail);
      throw error;
    }
    const { started, job, waitFailed } = run;
    const extra: Json = save.requested === null ? {} : { requestedPath: save.requested };
    const kept: Json | null =
      backup === null
        ? null
        : {
            path: backup.file,
            folder: backup.folder,
            keep: OLDVERSION_KEEP,
            reused: backup.reused,
            media: mediaMember(backup.media),
          };
    if (job === null || !isTerminal(job)) {
      const outcome = writeOutcome(started, { tool: save.tool });
      if (!outcome.ok) return outcome;
      const note = job === null ? '' : followText(waitFailed);
      const keptNote =
        kept === null
          ? ''
          : ' The previous content of the file is kept in its oldversion folder (path in oldVersion.path).';
      return {
        ok: true,
        body: {
          ...outcome.body,
          summary: outcome.body.summary + note + keptNote + mediaSentence(backup),
          lines: linesWithMedia(outcome.body.lines, backup),
          ...(kept === null ? {} : { oldVersion: kept }),
          ...extra,
        },
      };
    }
    const state = jobState(job);
    if (state === 'failed') {
      const failed = jobFailure(job);
      // The target was taken by another file while the job ran (and confirm was not given), or the job reports that it
      // changed nothing: the file is as it was, and so the old version only repeats it.
      if (failed.error.executed === false || isConfirmRequired(failed.error)) await dropBackup();
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
    // Rolled only now that the save worked: a failed save leaves the older versions alone.
    const rolled = folders === null ? null : await rollOldVersions(ops, folders);
    const overwrote = warningCodes(result).includes('OVERWROTE_OTHER_PROJECT');
    // A save_as that moved the project's file to a path, and replaced nothing, wrote a new file. The result says
    // so by the change of the project's path; without that change nothing proves it, and the sentence stays neutral.
    const wroteNew = save.method === 'project.saveAs' && !overwrote && projectPathChanged(result);
    const first = overwrote
      ? backup === null
        ? "OVERWROTE another existing project file at the user's request (path in path); the old file cannot be restored."
        : `OVERWROTE another existing project file at the user's request (path in path); ${KEPT}`
      : save.method === 'project.save'
        ? backup === null
          ? 'saved the project to its file (path in path); no earlier file was there, so there was nothing to keep.'
          : `saved the project to its file (path in path), replacing its previous content; ${KEPT}`
        : wroteNew
          ? "wrote a new project file (path in path); no existing file was replaced, and from now on it is the project's file."
          : backup === null
            ? "saved the project to the file given (path in path); from now on it is the project's file."
            : `saved the project to the file given (path in path), which was already the project's file, replacing its previous content; ${KEPT}`;
    const reusedNote =
      backup?.reused === true
        ? ' The newest old version already held exactly this content, so no new copy was made.'
        : '';
    const stored = notStored(result);
    const missing = stored.phrases.length === 0 ? '' : ` Not stored in the project file: ${stored.phrases.join(', ')}.`;
    const dirty = dirtySentence(result);
    const rendered = writeBody(result, { tool: save.tool });
    // The first save to a place says at once that the audio is copied there; a save to the project's own file
    // says it after the facts of the save.
    const toNewPlace = save.method === 'project.saveAs';
    const media = mediaFolderOf(save.requested, ctx.platform);
    const mediaMembers = mediaFolderMembers(rendered, media);
    const reasons: Json = {
      ...(isObject(mediaMembers.nullReasons) ? mediaMembers.nullReasons : {}),
      ...(kept === null ? { oldVersion: 'no_previous_file' } : {}),
    };
    return {
      ok: true,
      body: {
        ...rendered,
        summary:
          `${save.tool}: ${first}${reusedNote}${rolledSentence(rolled, OLDVERSION_KEEP, 'old version', 'old versions')}` +
          `${mediaSentence(backup)}${toNewPlace ? ` ${MEDIA_COPY}` : ''}${dirty === '' ? '' : ` ${dirty}`}${missing}` +
          (toNewPlace ? '' : ` ${MEDIA_COPY}`),
        lines: linesWithMedia(rendered.lines, backup),
        job: jobRef(job),
        notSavedInProject: stored.names,
        ...mediaMembers,
        oldVersion:
          kept === null
            ? null
            : { ...kept, ...(rolled === null ? {} : { removedOlder: rolled.removed, couldNotRemove: rolled.failed }) },
        ...(Object.keys(reasons).length === 0 ? {} : { nullReasons: reasons }),
        ...extra,
      },
    } satisfies Outcome;
  });
}

const noAutosaveStep: NextStep = {
  actor: 'agent',
  tool: SAVE,
  message:
    'The project has never been saved, so there is no file to keep the copies next to. Ask the user where to save ' +
    'it, then call opentune_save_project with mode save_as and that absolute .otproj path.',
};

/** The error of an OpenTune build that cannot write copies: nothing was written, and retrying does not help. */
const noCopyCapability: Outcome = {
  ok: false,
  error: toolError('UNSUPPORTED', {
    reason: 'capability_missing',
    detail: 'this OpenTune build does not report the capability project.copy, which mode autosave needs',
    nextStep: {
      actor: 'agent',
      tool: SAVE,
      message:
        'This OpenTune build cannot write autosave copies, so do not call mode autosave again. Remind the user to ' +
        'save the project when they want to keep their work; with their request or agreement, call ' +
        'opentune_save_project with mode save.',
    },
  }),
};

/** The error for an autosave folder that could not be prepared: nothing was written. */
const autosaveFolderFailed = (error: unknown): Outcome => ({
  ok: false,
  error: toolError('IO_ERROR', {
    reason: 'write_failed',
    detail: `the autosave folder next to the project file could not be prepared${codeSuffix(error)}; nothing was written`,
    nextStep: {
      actor: 'user',
      message:
        'The folder next to the project file may be read-only, full or not allowed. Tell the user; with their ' +
        'agreement, save under another path with opentune_save_project (mode save_as).',
    },
  }),
});

/** Writes the next numbered copy of the project into <name>.autosave and keeps the newest 50. */
async function runAutosave(ctx: ToolContext, args: SaveProjectArgs): Promise<Outcome> {
  const tool = SAVE;
  return withInstance(ctx, { instanceId: args.instance_id }, AUTOSAVE_CAPABILITIES, async (session) => {
    if (!session.hello.capabilities.includes(COPY_CAPABILITY)) return noCopyCapability;
    const ops = ctx.files ?? nodeProjectFs;
    const file = await currentProjectFile(session);
    if (file === null) {
      return {
        ok: false,
        error: toolError('INVALID_ARGUMENT', {
          reason: 'no_project_path',
          detail:
            'the project has never been saved, so it has no file to keep autosave copies next to; nothing was written',
          nextStep: noAutosaveStep,
        }),
      };
    }
    const folders = ProjectFolders.of(file, ctx.platform);
    if (folders === null) {
      return {
        ok: false,
        error: toolError('INVALID_ARGUMENT', {
          reason: 'project_path_unusable',
          detail:
            "the project's file is not an absolute .otproj path an autosave folder can be named after; nothing was written",
          nextStep: noAutosaveStep,
        }),
      };
    }
    let number: number;
    try {
      await ops.makeDir(folders.autosaveDir);
      number = nextAutosaveNumber(folders, await ops.list(folders.autosaveDir));
    } catch (error) {
      return autosaveFolderFailed(error);
    }
    const target = `${folders.autosaveDir}${folders.sep}${folders.autosaveName(number)}`;
    let run;
    try {
      run = await startAndWait(
        ctx,
        session,
        'project.saveCopy',
        { path: target },
        args.wait_seconds ?? DEFAULT_WAIT_SECONDS,
      );
    } catch (error) {
      if (error instanceof OtcpError && error.data.kind === 'ALREADY_EXISTS') {
        return {
          ok: false,
          error: fromOtcpError(error.data, {
            actor: 'agent',
            tool: SAVE,
            args: { mode: 'autosave' },
            message: 'A file with the next copy name appeared meanwhile; nothing was overwritten. Call again.',
          }),
        };
      }
      throw error;
    }
    const { started, job, waitFailed } = run;
    const copy: Json = { path: target, number, folder: folders.autosaveDir, keep: AUTOSAVE_KEEP };
    if (job === null || !isTerminal(job)) {
      const outcome = writeOutcome(started, { tool });
      if (!outcome.ok) return outcome;
      const note = job === null ? '' : followText(waitFailed);
      return { ok: true, body: { ...outcome.body, summary: outcome.body.summary + note, autosave: copy } };
    }
    const state = jobState(job);
    if (state === 'failed') return jobFailure(job);
    if (state === 'cancelled') {
      return {
        ok: true,
        body: { summary: `${tool}: ${jobSentence(job)}`, job: jobRef(job), result: job.result ?? null },
      };
    }
    const result = isObject(job.result) ? job.result : null;
    if (result === null) {
      return {
        ok: false,
        error: toolError('INTERNAL', { detail: 'OpenTune finished the copy job without a result', executed: null }),
      };
    }
    // Rolled only now that the copy exists: a failed copy leaves the older ones alone.
    const rolled = await rollAutosaves(ops, folders);
    const dirty = result.projectDirty;
    const unsaved =
      dirty === true
        ? ' and the project still has unsaved changes'
        : dirty === false
          ? '; the project has no unsaved changes'
          : '';
    const stored = notStored(result);
    const missing = stored.phrases.length === 0 ? '' : ` Not stored in the copy: ${stored.phrases.join(', ')}.`;
    const rendered = writeBody(started, { tool });
    const reasons: Json = {
      ...(isObject(rendered.nullReasons) ? rendered.nullReasons : {}),
      ...(isObject(result.nullReasons) ? result.nullReasons : {}),
    };
    return {
      ok: true,
      body: {
        ...rendered,
        summary:
          `${tool}: wrote autosave copy ${String(number)} (path in autosave.path); the project file was not changed` +
          `${unsaved}.${rolledSentence(rolled, AUTOSAVE_KEEP, 'copy', 'copies')}${missing}` +
          ' OpenTune also copies the audio the project uses into a Project_Media folder inside the autosave folder.',
        job: jobRef(job),
        autosave: {
          ...copy,
          sizeBytes: typeof result.sizeBytes === 'number' ? result.sizeBytes : null,
          removedOlder: rolled.removed,
          couldNotRemove: rolled.failed,
        },
        projectPath: typeof result.projectPath === 'string' ? result.projectPath : null,
        projectDirty: typeof dirty === 'boolean' ? dirty : null,
        notSavedInProject: stored.names,
        mediaFolder: `${folders.autosaveDir}${folders.sep}${MEDIA_FOLDER}`,
        ...(Object.keys(reasons).length === 0 ? {} : { nullReasons: reasons }),
      },
    } satisfies Outcome;
  });
}

export async function saveProject(ctx: ToolContext, args: SaveProjectArgs): Promise<Outcome> {
  if (args.mode === 'autosave') {
    if (args.path !== undefined) {
      return invalid('mode autosave takes no path: the copy goes next to the project file', 'path_unexpected');
    }
    return runAutosave(ctx, args);
  }
  if (args.mode === 'save') {
    if (args.path !== undefined)
      return invalid('mode save writes to the current project file and takes no path', 'path_unexpected');
    return runSave(ctx, args.instance_id, args.wait_seconds, {
      tool: SAVE,
      method: 'project.save',
      params: {},
      requested: null,
      replaces: 'current',
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
    replaces: 'requested-if-current',
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
    replaces: 'requested',
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
    'OpenTune (audio vocal pitch editor): saves the project. mode autosave writes a numbered copy into ' +
    '<name>.autosave next to the project file (newest 50 kept) and writes nothing outside that folder: use it ' +
    'after each step without asking. mode save overwrites the project file; save_as takes an absolute .otproj ' +
    'path and makes it the project file; use both only when the user asks or agrees (the replaced file goes to ' +
    '<name>.oldversion, newest 10). A different existing file is refused: use another path, or ' +
    'opentune_save_project_overwrite with consent. Waits up to wait_seconds (default 25, max 30).',
  inputSchema: z.strictObject({
    mode: z
      .enum(['autosave', 'save', 'save_as'])
      .describe(
        'autosave: write a numbered copy next to the project file; the project file is not changed. ' +
          'save: overwrite the current project file. save_as: write a new file.',
      ),
    path: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe('Absolute path ending in .otproj. Required for save_as; not allowed for save or autosave.'),
    wait_seconds: waitSchema,
    instance_id: instanceIdSchema,
  }),
  outputSchema: WRITE_RESULT_OUTPUT,
  // Not idempotent: every autosave writes a new numbered copy.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  capabilities: [...SAVE_CAPABILITIES],
  optionalCapabilities: [COPY_CAPABILITY],
  otcpMethods: ['project.save', 'project.saveAs', 'project.saveCopy', 'project.get', 'job.get'],
  run: (args, ctx) => saveProject(ctx, args),
});

export const overwriteProjectTool = defineTool({
  name: OVERWRITE,
  title: 'Overwrite another OpenTune project file',
  description:
    'OpenTune (audio vocal pitch editor): saves the project over a different, already existing project file ' +
    '(absolute .otproj path), destroying that file. Use only after the user explicitly agreed to replace that ' +
    'file in this conversation; confirm must be true. The replaced file is kept in <name>.oldversion next to it ' +
    '(newest 10). Otherwise save under a new path with opentune_save_project. Waits up to wait_seconds (default ' +
    '25, max 30).',
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
    'Never saves: with unsaved changes it fails with UNSAVED_CHANGES; write a copy with mode autosave and ask the ' +
    'user to save or give the changes up, and only with their explicit consent pass discard_unsaved: true. ' +
    'Clears the undo history; old clip and placement ids become invalid ' +
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
