// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The preconditions (`given`) and the instance-dependent names (`runner.*`) that the exe target can
// establish on a started OpenTune through its own public calls (vectors/README.md, "Preconditions").
// Whatever cannot be made faithfully stays a SKIP with the reason: state that only the UI or the
// machine can produce (dialogs, audio device, preferences, the first-run overlay), content that a
// vector describes exactly (notes, keys, time grids, fades, pitch shifts), and files that need a
// project OpenTune wrote itself or an access control list. Everything is built from audio generated
// at run time (mock/files.ts); no file outside the vector's own work directory is read.
//
// The logic takes an `Rpc` (one `call`), so it is tested against the mock without an executable.

import { WorkFiles, type GivenFile } from '../../mock/files.js';
import type { Json } from '../../src/otcp/client.js';
import { waitJob } from '../e2e/smoke.js';
import { PreconditionUnavailable } from './target.js';

/** What the establishing code needs of a session: one request, answered with the result object. */
export interface Rpc {
  call(method: string, params: Json, timeoutMs: number): Promise<Json>;
}

/** The reason of every vector whose clips are described by their exact content. */
export const EXACT_CONTENT =
  "needs exact content (notes, key, time grid, fades or pitch shift); covered by the fork's headless runner";

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObject) : []);

const SUPPORTED = new Set(['clips', 'dirty', 'files', 'history', 'visibleTrackCount']);
const MEMBER_REASONS: Readonly<Record<string, string>> = {
  jobs: 'no request makes a job of a given kind and state',
  withoutCapabilities: 'a started build cannot hide a capability it has',
  editingScheme: 'it would change the preferences of the machine',
  preferences: 'it would change the preferences of the machine',
  dialogs: 'no request opens a dialog',
  onboarding: 'no request starts or resets the first-run overlay',
  audio: 'the audio device belongs to the machine',
  projectFile: 'it needs a project saved by the vector itself',
  clipOnEveryTrack: 'it needs a clip on every track slot of the build',
};
const CLIP_BASE = new Set(['bind', 'trackId', 'startTimelineSec', 'durationSec', 'analysis']);
/** The step a clip move of a `clipMove` history entry makes, in seconds. */
const MOVE_SEC = 0.1;
const CALL_MS = 60_000;
const JOB_MS = 180_000;

const asArray = (v: unknown): readonly Json[] => (Array.isArray(v) ? (v as Json[]) : []);

/** Why this `given` cannot be established on a real instance, or undefined when it can. Needs no instance. */
export function unsupportedReason(given: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of Object.keys(given)) {
    if (!SUPPORTED.has(key)) {
      return `the exe target cannot establish given.${key} (${MEMBER_REASONS[key] ?? 'not known to the target'})`;
    }
  }
  for (const file of asArray(given.files)) {
    if (file.kind === 'noAccess') {
      return 'the exe target cannot establish given.files noAccess (it needs an access control list that denies the instance)';
    }
    if (file.kind === 'project' || file.kind === 'projectMissingMedia') {
      return `the exe target cannot establish given.files ${file.kind as string} (it needs a project written by OpenTune itself)`;
    }
  }
  const clips = asArray(given.clips);
  for (const clip of clips) {
    if (Object.keys(clip).some((name) => !CLIP_BASE.has(name))) return EXACT_CONTENT;
    if (clip.analysis !== 'ready') {
      return `the exe target cannot establish a clip whose analysis is ${String(clip.analysis)} (an import gives a finished analysis of a voiced file)`;
    }
  }
  if (isObject(given.history)) {
    const { undo, redo } = given.history;
    if (asArray(redo).length > 0) return 'the exe target cannot establish a redo history (given.history.redo)';
    for (const entry of asArray(undo)) {
      if (entry.origin !== 'control') return 'the exe target cannot establish an undo entry made in the UI';
      if (entry.action !== 'pitchShift' && entry.action !== 'clipMove') {
        return `the exe target cannot establish an undo entry of action ${String(entry.action)}`;
      }
      if (entry.trackDeletedAfter === true || entry.laterTrackDeletedAfter === true) {
        return 'the exe target cannot establish an undo entry that a track deletion made possibly stale';
      }
      if (!clips.some((clip) => clip.bind === entry.clip)) return 'a history entry names a clip that is not given';
    }
  }
  return undefined;
}

/** Everything `establishExeGiven` needs besides the `given`. */
export interface GivenEnv {
  readonly rpc: Rpc;
  /** The work directory of the vector: files are written below it and removed with it. */
  readonly files: WorkFiles;
  readonly capabilities: readonly string[];
  /** Where a clean project is saved to when `dirty` is false but the establishing made it dirty. */
  readonly saveTarget: () => string;
}

const need = (env: GivenEnv, ...capabilities: string[]): void => {
  const missing = capabilities.filter((c) => !env.capabilities.includes(c));
  if (missing.length > 0) throw new PreconditionUnavailable(`the instance does not report ${missing.join(', ')}`);
};

async function projectOf(rpc: Rpc): Promise<Json> {
  return rpc.call('project.get', {}, CALL_MS);
}

const dirtyOf = (project: Json): boolean => isObject(project.project) && project.project.dirty === true;

const textOf = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new Error(`${what} is not a string`);
  return v;
};

/** The tokens of the contents in the `asOf` of any read. */
function tokensOf(read: Json, contentId: string): Json | undefined {
  const asOf = isObject(read.asOf) ? read.asOf : {};
  return list(asOf.contents).find((entry) => entry.contentId === contentId);
}

/**
 * Establishes a vector's `given` on the instance and returns the names it binds. Throws
 * PreconditionUnavailable, with the reason, for what it cannot make (also what is checked after
 * making it: a state that reads back differently is not claimed).
 */
export async function establishExeGiven(
  given: Readonly<Record<string, unknown>>,
  env: GivenEnv,
): Promise<Readonly<Record<string, unknown>>> {
  const reason = unsupportedReason(given);
  if (reason !== undefined) throw new PreconditionUnavailable(reason);
  const bindings: Record<string, unknown> = {};
  const { rpc } = env;

  for (const file of asArray(given.files)) {
    Object.assign(bindings, env.files.provide(file as unknown as GivenFile));
  }

  const clips = asArray(given.clips);
  const history = isObject(given.history) ? asArray(given.history.undo) : [];
  const placementOf = new Map<string, string>();
  const contentOf = new Map<string, string>();
  if (clips.length > 0) {
    need(env, 'import.v1', 'jobs.v1', 'read.v1');
    for (const clip of clips) {
      const bind = textOf(clip.bind, 'a clip bind');
      const moves = history.filter((entry) => entry.clip === bind && entry.action === 'clipMove').length;
      const file = env.files.clipSource(bind, Number(clip.durationSec), true);
      const started = await rpc.call(
        'import.start',
        {
          items: [{ path: file }],
          layout: 'single',
          trackId: Number(clip.trackId),
          // Each clipMove entry moves the clip back by MOVE_SEC, so it ends at the given start.
          startTimelineSec: Number(clip.startTimelineSec) + moves * MOVE_SEC,
          generateNotes: false,
          focus: false,
        },
        CALL_MS,
      );
      const job = isObject(started.job) ? started.job : undefined;
      if (job === undefined) throw new Error('import.start handed over no job');
      const result = (await waitJob(rpc as never, textOf(job.jobId, 'the job id'), 'import', JOB_MS)) as Json;
      const item = list(result.items)[0];
      if (item?.imported !== true) {
        throw new PreconditionUnavailable(
          `the clip ${bind} could not be imported (${JSON.stringify(item?.error ?? null)})`,
        );
      }
      const contentId = textOf(item.contentId, 'the content id');
      placementOf.set(bind, textOf(item.placementId, 'the placement id'));
      contentOf.set(bind, contentId);
      // The pitch analysis must be finished: the vector's clip is `ready`.
      const deadline = Date.now() + JOB_MS;
      for (;;) {
        const details = await rpc.call('content.getDetails', { contentId }, CALL_MS);
        const state = isObject(details.analysis) ? details.analysis.f0State : undefined;
        if (state === 'ready') break;
        if (state === 'failed') throw new PreconditionUnavailable(`the pitch analysis of the clip ${bind} failed`);
        if (Date.now() > deadline) throw new Error(`the pitch analysis of the clip ${bind} did not finish`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  // The history: public writes whose results name their undo entries. Clip moves go back by one
  // step each; a pitch shift is made on the clip's content.
  for (const entry of history) {
    need(env, 'history.v1');
    const clip = textOf(entry.clip, 'a history clip');
    const placementId = placementOf.get(clip);
    const contentId = contentOf.get(clip);
    if (placementId === undefined || contentId === undefined) throw new Error('a history entry names no imported clip');
    let result: Json;
    if (entry.action === 'clipMove') {
      need(env, 'arrangement.v1');
      const project = await projectOf(rpc);
      const placement = list(project.placements).find((p) => p.placementId === placementId);
      if (placement === undefined) throw new Error('the clip is not in the project');
      const asOf = isObject(project.asOf) ? project.asOf : {};
      result = await rpc.call(
        'arrangement.edit',
        {
          expectedArrangementRevision: asOf.arrangementRevision,
          ops: [{ op: 'move', placementId, startTimelineSec: Number(placement.startTimelineSec) - MOVE_SEC }],
        },
        CALL_MS,
      );
    } else {
      need(env, 'edit.v1');
      result = await rpc.call('content.setPitchShift', { contentId, pitchShift: { semitones: 1, cents: 0 } }, CALL_MS);
    }
    const undo = isObject(result.undo) ? result.undo : {};
    if (typeof entry.bind === 'string') {
      if (typeof undo.undoId !== 'string') {
        throw new PreconditionUnavailable(`the ${String(entry.action)} write of the history entry gave no undo entry`);
      }
      bindings[entry.bind] = undo.undoId;
    }
  }

  // Visible tracks. An instance shows tracks that hold clips, and tracks cannot be hidden again, so
  // a target below what is shown already cannot be reached.
  if (given.visibleTrackCount !== undefined) {
    need(env, 'tracks.v1');
    const project = await projectOf(rpc);
    const target = given.visibleTrackCount === 'all' ? list(project.tracks).length : Number(given.visibleTrackCount);
    const current = Number(project.visibleTrackCount);
    if (current > target) {
      throw new PreconditionUnavailable(
        `the instance shows ${String(current)} tracks, and tracks cannot be hidden to reach ${String(target)}`,
      );
    }
    if (current < target) await rpc.call('track.add', { count: target - current }, CALL_MS);
    const after = Number((await projectOf(rpc)).visibleTrackCount);
    if (after !== target) {
      throw new PreconditionUnavailable(
        `${String(after)} tracks are shown, not the ${String(target)} the vector needs`,
      );
    }
  }

  // The unsaved-changes flag. Clips and history made the project dirty; saving makes it clean.
  if (given.dirty !== undefined) {
    const want = given.dirty === true;
    let project = await projectOf(rpc);
    if (dirtyOf(project) !== want) {
      if (want) {
        project = await makeDirty(rpc, env, project);
      } else {
        need(env, 'project.io');
        const saving = await rpc.call('project.saveAs', { path: env.saveTarget() }, CALL_MS);
        const job = isObject(saving.job) ? saving.job : undefined;
        if (job === undefined) throw new Error('project.saveAs handed over no job');
        await waitJob(rpc as never, textOf(job.jobId, 'the job id'), 'save', JOB_MS);
        project = await projectOf(rpc);
      }
    }
    if (dirtyOf(project) !== want) {
      throw new PreconditionUnavailable(
        `the project reads ${dirtyOf(project) ? 'dirty' : 'clean'}, not ${want ? 'dirty' : 'clean'}`,
      );
    }
  }

  // The names of the clips, bound last: the tokens are those after every precondition.
  const finalProject = clips.length > 0 ? await projectOf(rpc) : undefined;
  for (const clip of clips) {
    const bind = textOf(clip.bind, 'a clip bind');
    const placementId = placementOf.get(bind) ?? '';
    const contentId = contentOf.get(bind) ?? '';
    const placement = list(finalProject?.placements).find((p) => p.placementId === placementId);
    const tokens = tokensOf(finalProject ?? {}, contentId);
    bindings[`${bind}.contentId`] = contentId;
    bindings[`${bind}.placementId`] = placementId;
    bindings[`${bind}.sourcePath`] = placement?.sourcePath ?? null;
    bindings[`${bind}.revision`] = tokens?.revision;
    bindings[`${bind}.gridRevision`] = tokens?.gridRevision;
    bindings[`${bind}.keyRevision`] = tokens?.keyRevision;
    bindings[`${bind}.geometryHash`] = placement?.geometryHash;
  }
  return bindings;
}

/**
 * Marks the project as changed by a write that is taken back at once, so that the state a vector
 * looks at is the one it asked for: a tempo change and back first, else muting and unmuting track 0.
 */
async function makeDirty(rpc: Rpc, env: GivenEnv, project: Json): Promise<Json> {
  const attempts: (() => Promise<void>)[] = [];
  if (env.capabilities.includes('transport.v1')) {
    attempts.push(async () => {
      const transport = isObject(project.transport) ? project.transport : {};
      const bpm = Number(transport.bpm ?? 120);
      await rpc.call('transport.setTempo', { bpm: bpm === 121 ? 120 : 121 }, CALL_MS);
      await rpc.call('transport.setTempo', { bpm }, CALL_MS);
    });
  }
  if (env.capabilities.includes('tracks.v1')) {
    const track = list(project.tracks)[0];
    const muted = track?.muted === true;
    attempts.push(async () => {
      await rpc.call('track.set', { tracks: [{ trackId: 0, muted: !muted }] }, CALL_MS);
      await rpc.call('track.set', { tracks: [{ trackId: 0, muted }] }, CALL_MS);
    });
  }
  // Setting the tempo is the write that marks the project as changed; the mute is the second try.
  for (const attempt of attempts) {
    await attempt();
    const latest = await projectOf(rpc);
    if (dirtyOf(latest)) return latest;
  }
  throw new PreconditionUnavailable('no write the target tried marks the project as changed');
}

/** The values of the `runner.*` names that depend on the instance, from reads of it. */
export async function readRunnerValues(
  rpc: Rpc,
  instanceId: string,
): Promise<Readonly<Record<string, string | number>>> {
  const project = await projectOf(rpc);
  const short = instanceId.slice(0, 8);
  // Another instance part of the same form: the first character changed.
  const other = `${short.startsWith('0') ? '1' : '0'}${short.slice(1)}`;
  // The content epoch is that of any handle the project holds; a fresh instance is at epoch 0.
  const handle = [
    ...list(project.placements).map((p) => p.placementId),
    ...list(project.contents).map((c) => c.contentId),
  ].find((h): h is string => typeof h === 'string');
  const epoch = handle === undefined ? '0' : (handle.split(':')[2] ?? '0');
  const asOf = isObject(project.asOf) ? project.asOf : {};
  const last = Math.max(0, list(project.tracks).length - 1);
  return {
    'runner.unknownPlacementId': `p:${short}:${epoch}:999999`,
    'runner.unknownContentId': `c:${short}:${epoch}:999999`,
    'runner.stalePlacementId': `p:${other}:${epoch}:1`,
    'runner.staleContentId': `c:${other}:${epoch}:1`,
    'runner.lastTrackId': last,
    'runner.unknownTrackId': last + 1,
    ...(typeof asOf.arrangementRevision === 'string' ? { 'runner.arrangementRevision': asOf.arrangementRevision } : {}),
  };
}
