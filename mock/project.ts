// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The project file methods of the mock (capability project.io): project.save, project.saveAs,
// project.open and project.clearRecent (spec/otcp/v1/PROTOCOL.md sections 12.3, 20 and 22). The
// files are really written and read, in the places the caller names; the tests name directories
// below the mock's work directory. Saving and opening are jobs: opening reads and prepares the
// file first (a cancellation point) and then replaces the project in one step.

import fs from 'node:fs';
import path from 'node:path';

import { checkNotBusy, envelope, type Handler } from './context.js';
import { refuse, MockError } from './errors.js';
import type { WorkFiles } from './files.js';
import { renameNoReplace } from './export.js';
import { exists, identityOf, sameFile } from './identity.js';
import { jobStartedResult } from './job-reply.js';
import type { JobControl, JobDriver, JobStep, JobStore } from './jobs.js';
import { TRACK_SLOTS, type PlacementRec, type World } from './model.js';
import { checkPath } from './paths.js';
import { parseProject, projectBytes, projectOf, type ProjectFile } from './projectfile.js';
import { clipLabel } from './placements.js';
import { readWav } from './wav.js';
import { IMPORT_ANALYSIS_MS } from './import.js';
import { EMPTY_DIFF } from './writes.js';

/** A project is at most this many entries long in `created` and `removed` of an open result (project.open). */
const LISTED_MAX = 200;
/** Time the mock takes to write a project file, and to read and then apply one. */
export const SAVE_STEP_MS = 10;
export const OPEN_STEP_MS = 10;
const EXTENSIONS = ['.otproj'] as const;

const warning = (code: string, subject: unknown = null, data: unknown = null) => ({ code, subject, data });
const PROJECT = { singleton: 'project' } as const;
/** State that a project file does not hold (the warning NOT_SAVED_IN_PROJECT). */
const NOT_SAVED = ['visibleTrackCount', 'undoHistory', 'preferences'] as const;

/** The media file a project clip shows, as far as the mock can tell what it holds. */
function readMedia(file: string): ReturnType<typeof readWav> {
  try {
    return readWav(fs.readFileSync(file));
  } catch {
    return { ok: false };
  }
}

/** A failure that is not one of the mock's own refusals, as the INTERNAL error that ends the job. */
function unexpected(kind: string, error: unknown): MockError {
  const detail = error instanceof Error ? error.message : 'unexpected failure';
  return new MockError({ kind: 'INTERNAL', detail: `the ${kind} job failed: ${detail}` });
}

export class ProjectService {
  #seq = 0;

  constructor(
    private readonly world: World,
    private readonly jobs: JobStore,
    private readonly files: WorkFiles,
  ) {}

  readonly #denied = (file: string): boolean => this.files.isDenied(file);

  /** The most recent project first, without repeats; a file that is the same as an earlier entry replaces it. */
  #remember(file: string): void {
    const { recentProjects } = this.world.prefs;
    const kept = recentProjects.filter((entry) => entry !== file);
    this.world.prefs.recentProjects = [file, ...kept];
  }

  // project.save and project.saveAs -----------------------------------------------------------------

  /** A save job: it writes what the project holds now, through a temporary file and the final rename (section 20.4). */
  #startSave(target: string, options: { confirm: boolean; replacesCurrent: boolean }) {
    const { world } = this;
    const data = projectBytes(projectOf(world));
    const changesAtStart = world.changeCount;
    let temp: string | undefined;
    const dropTemp = () => {
      if (temp !== undefined) fs.rmSync(temp, { force: true });
      temp = undefined;
    };
    world.busy.projectOperation = true;
    const finish = (outcome: JobStep & { done: unknown }): JobStep => {
      dropTemp();
      world.busy.projectOperation = false;
      return outcome;
    };
    const fail = (error: MockError): JobStep => finish({ done: { state: 'failed', error: error.init } });
    const driver: JobDriver = (control: JobControl) => {
      if (control.cancelRequested) return finish({ done: { state: 'cancelled' } });
      try {
        // Section 20.4: the file system decides at the rename; before it the identity is looked at again (rule 5).
        const previousPath = world.project.path;
        const isCurrent = previousPath !== null && sameFile(previousPath, target, this.#denied);
        const replaces = options.confirm || isCurrent || options.replacesCurrent;
        const existed = identityOf(target, this.#denied) !== null;
        if (existed && !replaces) {
          throw refuse('INVALID_ARGUMENT', 'confirm_required', 'a file appeared at the target and confirm is not true');
        }
        const dir = path.dirname(target);
        const temporary = path.join(dir, `.${path.basename(target)}.${String(++this.#seq)}.tmp`);
        try {
          fs.writeFileSync(temporary, data, { flag: 'wx' });
          temp = temporary;
        } catch {
          fs.rmSync(temporary, { force: true });
          throw refuse('IO_ERROR', 'write_failed', 'the project file could not be written');
        }
        if (replaces) {
          try {
            fs.renameSync(temporary, target);
          } catch {
            throw refuse('IO_ERROR', 'write_failed', 'the project file could not be moved into place');
          }
        } else if (renameNoReplace(temporary, target) === 'exists') {
          throw refuse('INVALID_ARGUMENT', 'confirm_required', 'a file appeared at the target and confirm is not true');
        }
        temp = undefined;
        const dirtyBefore = world.project.dirty;
        world.project.path = target;
        // The project changed while the job ran: the flag stays, since the file lacks that change.
        if (world.changeCount === changesAtStart) world.project.dirty = false;
        this.#remember(target);
        const overwrote = existed && !isCurrent && options.confirm;
        const changes =
          previousPath === target || (previousPath !== null && isCurrent)
            ? []
            : [
                {
                  entity: 'project',
                  ref: PROJECT,
                  label: 'Project',
                  fields: { path: { before: previousPath, after: target, unit: null } },
                },
              ];
        const result = envelope(world, {
          applied: true,
          noOp: false,
          changes,
          diff: EMPTY_DIFF,
          contents: [],
          undo: { undoable: false, reason: 'no_upstream_undo', revert: null },
          dirtyBefore,
          warnings: [
            warning('IRREVERSIBLE', PROJECT),
            ...(overwrote ? [warning('OVERWROTE_OTHER_PROJECT', { path: target }, { path: target })] : []),
            warning('NOT_SAVED_IN_PROJECT', null, { items: [...NOT_SAVED] }),
          ],
          extra: { path: target, sizeBytes: Buffer.byteLength(data) },
        });
        return finish({ done: { state: 'succeeded', result } });
      } catch (error) {
        // Any other failure (a file system error from the rename, say) must also release the project operation
        // and drop the temporary file, so it ends the job here instead of leaving the mock busy.
        return fail(error instanceof MockError ? error : unexpected('projectSave', error));
      }
    };
    return this.jobs.start({ kind: 'projectSave' }, driver, () => {
      dropTemp();
      world.busy.projectOperation = false;
    });
  }

  readonly save: Handler = (context) => {
    const { world } = this;
    checkNotBusy(context);
    const current = world.project.path;
    if (current === null) {
      throw refuse('INVALID_ARGUMENT', 'no_project_path', 'the project was never saved; project.saveAs saves it');
    }
    const job = this.#startSave(current, { confirm: false, replacesCurrent: true });
    return jobStartedResult(world, job);
  };

  readonly saveAs: Handler = (context) => {
    const { world, params } = context;
    const target = String(params.path);
    const bad = checkPath(target, EXTENSIONS, 'path');
    if (bad !== undefined) throw bad;
    checkNotBusy(context);
    // The identity of the target must be determinable (section 20.3 rule 4); this also tells whether it exists.
    const existed = identityOf(target, this.#denied) !== null;
    const current = world.project.path;
    const isCurrent = current !== null && sameFile(current, target, this.#denied);
    const confirm = params.confirm === true;
    if (existed && !isCurrent && !confirm) {
      throw refuse(
        'INVALID_ARGUMENT',
        'confirm_required',
        'the target is another existing file; replacing it needs confirm true, which only the end user may give',
      );
    }
    const job = this.#startSave(target, { confirm, replacesCurrent: isCurrent });
    return jobStartedResult(world, job);
  };

  // project.open ---------------------------------------------------------------------------------------

  /** Reads the project file; the failure of this step ends the job and leaves the current project untouched. */
  #read(file: string): ProjectFile {
    if (this.files.isDenied(file)) throw refuse('IO_ERROR', 'read_failed', 'the project file could not be read');
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      throw refuse('IO_ERROR', 'read_failed', 'the project file could not be read');
    }
    const project = parseProject(text);
    if (project === undefined) throw refuse('IO_ERROR', 'read_failed', 'the file is not a project OpenTune can read');
    return project;
  }

  /** Replaces the project in one step and builds the result of the job (the write envelope with the members of project.open). */
  #replace(file: string, project: ProjectFile, discarded: boolean): Record<string, unknown> {
    const { world } = this;
    const before = world.capture();
    const dirtyBefore = world.project.dirty;
    const previous = { path: world.project.path, dirty: dirtyBefore, discarded };
    const removedPlacements = [...world.placements.values()];
    const removedContents = [...world.contents.values()];
    const removed = [
      ...removedPlacements.map((p) => ({
        entity: 'placement',
        ref: { placementId: p.id },
        label: clipLabel(p.serial, p.trackId),
      })),
      ...removedContents.map((c) => ({
        entity: 'content',
        ref: { contentId: c.id },
        label: `Content ${String(c.objectId)}`,
      })),
    ];
    const historyCleared = world.resetProject();

    project.tracks.slice(0, TRACK_SLOTS).forEach((track, trackId) => {
      const slot = world.tracks[trackId];
      if (slot !== undefined) Object.assign(slot, track);
    });
    world.transport.bpm = project.bpm;
    world.transport.timeSignature = { ...project.timeSignature };
    world.transport.playing = false;
    world.transport.positionTimelineSec = 0;
    world.transport.playStartTimelineSec = 0;

    const missing: string[] = [];
    const contentOf = new Map<number, ReturnType<World['addContent']>>();
    const voicedOf = new Map<number, boolean>();
    const restored: PlacementRec[] = [];
    const skippedClips: number[] = [];
    project.clips.forEach((clip, index) => {
      const source = project.contents[clip.contentIndex];
      if (source === undefined) {
        skippedClips.push(index);
        return;
      }
      let content = contentOf.get(clip.contentIndex);
      if (content === undefined) {
        const wav = readMedia(source.source);
        if (!wav.ok) {
          if (!missing.includes(source.source)) missing.push(source.source);
          skippedClips.push(index);
          return;
        }
        content = world.addContent({ durationSec: source.durationSec, analysis: 'running', sourcePath: source.source });
        content.key = source.key === null ? null : { ...source.key };
        content.pitchShift = { ...source.pitchShift };
        content.notes = structuredClone(source.notes);
        content.handles = structuredClone(source.handles);
        content.handleSeq = content.handles.length;
        content.notesGenerated = content.notes.length > 0;
        contentOf.set(clip.contentIndex, content);
        voicedOf.set(content.objectId, wav.voiced);
      }
      const placement = world.addPlacement({
        trackId: clip.trackId,
        content,
        name: clip.name,
        startTimelineSec: clip.startTimelineSec,
        durationSec: clip.durationSec,
        clipInContentSec: clip.clipInContentSec,
        gainLinear: clip.gainLinear,
        fadeInSec: clip.fadeInSec,
        fadeOutSec: clip.fadeOutSec,
      });
      restored.push(placement);
    });
    for (const content of contentOf.values()) {
      const voiced = voicedOf.get(content.objectId) === true;
      world.after(IMPORT_ANALYSIS_MS, () => {
        if (world.contents.get(content.objectId) === content) world.setAnalysis(content, voiced ? 'ready' : 'unvoiced');
      });
    }
    world.touchArrangement();
    world.touchTrackState();
    world.project.path = file;
    world.project.dirty = false;
    this.#remember(file);

    const created = [
      ...restored.map((p) => ({
        entity: 'placement',
        ref: { placementId: p.id },
        label: clipLabel(p.serial, p.trackId),
      })),
      ...[...contentOf.values()].map((c) => ({
        entity: 'content',
        ref: { contentId: c.id },
        label: `Content ${String(c.objectId)}`,
      })),
    ];
    const createdListed = created.slice(0, LISTED_MAX);
    const removedListed = removed.slice(0, LISTED_MAX);
    const listedContents = new Set([
      ...createdListed.flatMap((e) => ('contentId' in e.ref ? [e.ref.contentId] : [])),
      ...removedListed.flatMap((e) => ('contentId' in e.ref ? [e.ref.contentId] : [])),
    ]);
    const diff = world.diff(before, world.capture());
    const revert =
      previous.path !== null && !previous.dirty && !discarded
        ? { method: 'project.open', params: { path: previous.path } }
        : null;
    const warnings = [
      ...(revert === null ? [warning('IRREVERSIBLE', PROJECT)] : []),
      ...(missing.length > 0 ? [warning('MEDIA_MISSING', null, { paths: missing })] : []),
    ];
    return envelope(world, {
      applied: true,
      noOp: false,
      created: createdListed,
      removed: removedListed,
      diff: { ...diff, contents: diff.contents.filter((c) => listedContents.has(c.contentId)) },
      contents: [...contentOf.values()].slice(0, LISTED_MAX),
      placements: restored.slice(0, LISTED_MAX),
      undo: { undoable: false, reason: 'no_upstream_undo', revert },
      dirtyBefore,
      warnings,
      changes:
        previous.path === file
          ? []
          : [
              {
                entity: 'project',
                ref: PROJECT,
                label: 'Project',
                fields: { path: { before: previous.path, after: file, unit: null } },
              },
            ],
      extra: {
        path: file,
        previous,
        restored: {
          placementCount: restored.length,
          contentCount: contentOf.size,
          visibleTrackCount: world.visibleTrackCount,
        },
        skipped: {
          media: missing.map((p) => ({ path: p, reason: 'missing' })),
          placementCount: skippedClips.length,
        },
        historyCleared,
        omittedCount: {
          created: Math.max(0, created.length - LISTED_MAX),
          removed: Math.max(0, removed.length - LISTED_MAX),
        },
      },
    });
  }

  readonly open: Handler = (context) => {
    const { world, params } = context;
    const target = String(params.path);
    const bad = checkPath(target, EXTENSIONS, 'path');
    if (bad !== undefined) throw bad;
    checkNotBusy(context);
    // A path in a directory the instance cannot open exists as far as the call can tell; reading it fails the job.
    if (!this.files.isDenied(target) && !exists(target)) {
      throw refuse('NOT_FOUND', 'file_not_found', 'no file exists at the path');
    }
    const discarded = world.project.dirty && params.discardUnsaved === true;
    if (world.project.dirty && !discarded) {
      throw refuse(
        'UNSAVED_CHANGES',
        'project_dirty',
        'the project has unsaved changes; discardUnsaved true opens the file anyway and loses them',
      );
    }
    world.busy.projectOperation = true;
    let prepared: ProjectFile | undefined;
    const finish = (done: Extract<JobStep, { done: unknown }>['done']): JobStep => {
      world.busy.projectOperation = false;
      return { done };
    };
    const driver: JobDriver = (control) => {
      if (control.cancelRequested) return finish({ state: 'cancelled' });
      try {
        if (prepared === undefined) {
          prepared = this.#read(target);
          // The file is read and prepared: the next step replaces the project and cannot be cancelled.
          control.lockCancellation();
          return { next: OPEN_STEP_MS };
        }
        return finish({ state: 'succeeded', result: this.#replace(target, prepared, discarded) });
      } catch (error) {
        const failure = error instanceof MockError ? error : unexpected('projectOpen', error);
        return finish({ state: 'failed', error: failure.init });
      }
    };
    const job = this.jobs.start({ kind: 'projectOpen' }, driver, () => {
      world.busy.projectOperation = false;
    });
    return jobStartedResult(world, job);
  };

  // project.clearRecent ------------------------------------------------------------------------------

  readonly clearRecent: Handler = (context) => {
    const { world } = this;
    checkNotBusy(context);
    const listed = [...world.prefs.recentProjects];
    if (listed.length === 0) {
      return envelope(world, {
        applied: true,
        noOp: true,
        diff: EMPTY_DIFF,
        contents: [],
        undo: { undoable: false, reason: 'no_op', revert: null },
        dirtyBefore: world.project.dirty,
      });
    }
    world.prefs.recentProjects = [];
    return envelope(world, {
      applied: true,
      noOp: false,
      changes: [
        {
          entity: 'preference',
          ref: { preference: 'recentProjects' },
          label: 'Recent projects',
          fields: { recentProjects: { before: listed, after: [], unit: null } },
        },
      ],
      diff: EMPTY_DIFF,
      contents: [],
      undo: { undoable: false, reason: 'no_upstream_undo', revert: null },
      dirtyBefore: world.project.dirty,
      warnings: [warning('IRREVERSIBLE', { preference: 'recentProjects' })],
    });
  };

  get handlers(): Readonly<Record<string, Handler>> {
    return {
      'project.save': this.save,
      'project.saveAs': this.saveAs,
      'project.open': this.open,
      'project.clearRecent': this.clearRecent,
    };
  }
}
