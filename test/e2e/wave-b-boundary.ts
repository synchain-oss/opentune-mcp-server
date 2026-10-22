// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The wave-B boundary scenario against a started OpenTune executable. The wave-B tour (wave-b-tour.ts)
// and the arrangement effects scenario drive every method once; this one drives the cases at the edge
// of what a write promises, and checks that the answer, the history and a fresh read agree:
//
//  1. split, merge and delete report that they cannot be undone (upstream_undo_defect), and edit.undo
//     refuses such an entry on top of the history (UNSUPPORTED undo_unsafe_build);
//  2. trimming a clip shorter than its fades shortens them (FADES_RECLAMPED), and undoing the trim
//     puts the old fades back;
//  3. deleting a middle track reports the id map, makes the older undo entry possibly stale, and
//     undoing that entry reports what it did (UNDO_NO_EFFECT) in line with a fresh read;
//  4. with the openDyne editing scheme, importing with focus and selecting a clip without notes
//     generate notes as a side effect, and report it;
//  5. switching the editing scheme reports its job and side effects, and its revert recipe puts the
//     scheme back;
//  6. every processing preference that can be changed here is changed once and put back by the revert
//     recipe exactly as given;
//  7. saving as over another project is refused without confirmation and reports
//     OVERWROTE_OTHER_PROJECT with it;
//  8. a project whose media file has gone opens without that clip and reports MEDIA_MISSING.
//
// Two cases cannot be driven through the interface and are listed as manual checks: the track colour
// dialog (no request opens it), and a write that happens while a modal dialog is open (no request
// opens a modal either). Everything runs in a temporary folder with a data folder of its own; the
// settings snapshot around the instance (test/support/settings-guard.ts) proves its settings files are
// back as they were, and the user-settings watch of the test proves the real ones were not touched.
// Only generated audio is used.

import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseDiscoveryFile } from '../../src/discovery/file.js';
import { OtcpError } from '../../src/errors/tool-error.js';
import { OtcpSession, type Json } from '../../src/otcp/client.js';
import { generateTone } from '../support/harmonic-tone.js';
import { placementOf, readProject, type ProjectState } from './arrangement-effects.js';
import { waitForAnalysis } from './effects.js';
import {
  endAllConfirmed,
  instanceSettingsProblems,
  removeDir,
  scratchDir,
  startRealInstance,
  type RealInstance,
} from './real-support.js';
import { Scenario, type ScenarioReport } from './scenario.js';
import {
  StepSkip,
  busyDiagnostics,
  isModalBusy,
  isObject,
  member,
  num,
  runJob,
  text,
  waitJob,
  type SmokeConfig,
} from './smoke.js';

export const SCENARIO_NAME = 'wave-b-boundary';

const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 60_000;
const START_HELLO_TIMEOUT_MS = 15_000;
const EPSILON = 1e-5;

const REQUIRED_CAPABILITIES = ['session.v1', 'jobs.v1', 'read.v1', 'import.v1'] as const;

/** The checks nobody can drive through the interface, each with the reason. */
export const MANUAL_CHECKS: readonly string[] = [
  'TRACK COLOUR DIALOG: open the colour dialog of a track in the OpenTune window and close it by the close button and ' +
    'by Escape; the track keeps its colour. No request opens this dialog (ui.dismiss only closes one, and ui.getState ' +
    'only lists it), so a person has to open it. The headless tests cover dismissing a listed dialog.',
  'WRITE DURING A MODAL: with a dialog open in the OpenTune window, send a write (for example track.set); it must ' +
    'fail with BUSY (modal_open) and change nothing. No request can open a modal dialog, so a person has to open it. ' +
    'The headless tests cover the BUSY answer with a test bridge.',
];

const listOf = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);

/** The codes of the warnings of a write result. */
const warningCodes = (envelope: Json): string[] =>
  listOf(envelope.warnings).flatMap((w) => (typeof w.code === 'string' ? [w.code] : []));

const close = (a: number, b: number): boolean => Math.abs(a - b) <= EPSILON;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What `withMediaAway` found: how `body` ended, and the renames back that did not work. */
export interface MediaAwayResult<T> {
  readonly outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
  /** One line per rename back that failed, with file names and an error code but no folder. */
  readonly putBackFailures: readonly string[];
}

/**
 * Takes the copies of the media that OpenTune keeps in folders next to the project files in `folder` away
 * (each folder gets `.away` appended), runs `body`, and puts everything back whatever `body` did: the folders
 * and the media file that the caller already renamed from `copy` to `moved`. Every rename back is tried on its
 * own, so one that fails neither stops the others nor replaces how `body` ended: the failure is returned in
 * `putBackFailures` for the caller to report next to the outcome. `move` replaces `rename` in tests.
 */
export async function withMediaAway<T>(
  files: { readonly folder: string; readonly copy: string; readonly moved: string },
  body: (copyFolders: number) => Promise<T>,
  move: (from: string, to: string) => Promise<void> = rename,
): Promise<MediaAwayResult<T>> {
  const away: string[] = [];
  let outcome: MediaAwayResult<T>['outcome'];
  try {
    for (const entry of await readdir(files.folder, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      await move(path.join(files.folder, entry.name), path.join(files.folder, `${entry.name}.away`));
      away.push(entry.name);
    }
    outcome = { ok: true, value: await body(away.length) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const back: (readonly [string, string])[] = [
    [files.moved, files.copy],
    ...away.map((name): readonly [string, string] => [
      path.join(files.folder, `${name}.away`),
      path.join(files.folder, name),
    ]),
  ];
  const putBackFailures: string[] = [];
  for (const [from, to] of back) {
    try {
      await move(from, to);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      putBackFailures.push(
        `${path.basename(from)} could not be renamed back to ${path.basename(to)} (${typeof code === 'string' ? code : 'rename failed'})`,
      );
    }
  }
  return { outcome, putBackFailures };
}

/** A compact picture of the arrangement a fresh read shows, to tell "unchanged" from "changed". */
function signatureOf(state: ProjectState): string {
  const placements = state.placements
    .map((p) => [p.placementId, p.trackId, p.startTimelineSec, p.durationSec, p.gainLinear, p.fadeInSec, p.fadeOutSec])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const tracks = state.tracks.map((t) => [t.trackId, t.muted, t.solo]).sort((a, b) => Number(a[0]) - Number(b[0]));
  return JSON.stringify({ placements, tracks });
}

interface Clip {
  readonly placementId: string;
  readonly contentId: string;
  readonly trackId: number;
}

const PROCESSING_MEMBERS = ['tuningHz', 'editingScheme', 'hybridMode', 'experimentalFeatures'] as const;

export async function runWaveBBoundary(config: SmokeConfig): Promise<ScenarioReport> {
  const scenario = new Scenario(SCENARIO_NAME);
  const timeoutMs = config.stepTimeoutMs;
  const startTimeoutMs = config.exe.timeoutMs ?? 60_000;
  let root = '';
  let discoveryDir = '';
  let dataDirParent = '';
  let toneFile = '';
  let instance: RealInstance | undefined;
  let session: OtcpSession | undefined;
  let capabilities: readonly string[] = [];
  /** The method of the latest request, named when a modal dialog refuses a call. */
  let lastCall = '';
  const clips: Record<'a' | 'b' | 'c' | 'd', Clip | undefined> = {
    a: undefined,
    b: undefined,
    c: undefined,
    d: undefined,
  };

  const need = (): OtcpSession => {
    if (session === undefined) throw new Error('no session');
    return session;
  };
  const clip = (name: keyof typeof clips): Clip => {
    const found = clips[name];
    if (found === undefined) throw new Error(`clip ${name} was not imported`);
    return found;
  };
  const requireCapabilities = (names: readonly string[]): void => {
    const missing = names.filter((name) => !capabilities.includes(name));
    if (missing.length > 0) throw new StepSkip('SKIP', `the instance does not report ${missing.join(', ')}`);
  };
  const step = (name: string, body: () => Promise<string>, options?: Parameters<Scenario['step']>[2]) =>
    scenario.step(
      name,
      async () => {
        try {
          return await body();
        } catch (error) {
          // A modal dialog that stays open refuses every later write: say which one it is.
          if (isModalBusy(error))
            throw new Error(`${messageOf(error)} (during ${lastCall}); ${await busyDiagnostics(session)}`, {
              cause: error,
            });
          throw error;
        }
      },
      options,
    );
  /** A check: one deviation must not hide what the later checks show. */
  const check = (name: string, body: () => Promise<string>) => step(name, body, { haltOnFail: false });

  const finish = (label: string, problems: string[], note: string): string => {
    if (problems.length > 0) throw new Error(`${label}: ${problems.slice(0, 8).join('; ')}`);
    return note;
  };

  const call = (method: string, params: Json, ms = WRITE_TIMEOUT_MS): Promise<Json> => {
    lastCall = method;
    return need()
      .call(method, params, ms)
      .then((result) => {
        if (!isObject(result)) throw new Error(`${method} returned no object`);
        return result;
      });
  };

  /** The error a call must fail with; a success is a problem. */
  const refused = async (method: string, params: Json): Promise<OtcpError> => {
    try {
      await call(method, params);
    } catch (error) {
      if (error instanceof OtcpError) return error;
      throw error;
    }
    throw new Error(`${method} succeeded where it had to be refused`);
  };
  const errorName = (error: OtcpError): string =>
    error.data.reason === null ? error.data.kind : `${error.data.kind}(${error.data.reason})`;

  /** A write that may have started a job (a changed editing scheme): the envelope of the write. */
  const writeEnvelope = async (method: string, params: Json): Promise<Json> => {
    const result = await call(method, params);
    const job = result.job;
    if (isObject(job) && typeof job.jobId === 'string' && result.applied !== true) {
      const done = await waitJob(need(), job.jobId, method, timeoutMs);
      if (!isObject(done)) throw new Error(`the ${method} job ended without a result object`);
      return done;
    }
    return result;
  };

  const revertOf = (envelope: Json): Json => {
    const undo = envelope.undo;
    const revert = isObject(undo) ? undo.revert : undefined;
    if (!isObject(revert) || typeof revert.method !== 'string' || !isObject(revert.params)) {
      throw new Error('the result carries no revert recipe');
    }
    return revert;
  };
  const sendRevert = (recipe: Json): Promise<Json> => writeEnvelope(String(recipe.method), recipe.params as Json);

  const processingOf = async (): Promise<Json> => {
    const prefs = await call('prefs.get', {}, READ_TIMEOUT_MS);
    const processing = member(prefs, 'processing', 'prefs.get');
    if (!isObject(processing)) throw new Error('prefs.get has no processing object');
    const picked: Json = {};
    for (const name of PROCESSING_MEMBERS) picked[name] = processing[name] ?? null;
    return picked;
  };

  const importClip = async (file: string, options: { generateNotes: boolean; focus: boolean }): Promise<Json> => {
    const result = await runJob(
      need(),
      'import.start',
      { items: [{ path: file }], layout: 'single', newTrack: true, startTimelineSec: 0, ...options },
      'import',
      timeoutMs,
    );
    const items = listOf(member(result, 'items', 'the import result'));
    const item = items[0];
    if (item?.imported !== true) throw new Error('the clip was not imported');
    await waitForAnalysis(need(), text(item, 'contentId', 'the import item'), timeoutMs);
    return Object.assign({}, item, { envelope: result });
  };
  const clipOf = (item: Json): Clip => ({
    placementId: text(item, 'placementId', 'the import item'),
    contentId: text(item, 'contentId', 'the import item'),
    trackId: num(item, 'trackId', 'the import item'),
  });

  /**
   * A dialog that an action of this run left open refuses every later write (BUSY, modal_open). Waits a
   * moment for it to go; one that stays is reported, and closed so the checks after it can run.
   */
  const leftOverDialogProblems = async (after: string): Promise<string[]> => {
    const open = async (): Promise<Json[]> =>
      listOf(member(await call('ui.getState', {}, READ_TIMEOUT_MS), 'dialogs', 'ui.getState'));
    // A dialog may come up a moment after the write that causes it.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const deadline = Date.now() + 5_000;
    let dialogs = await open();
    while (dialogs.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      dialogs = await open();
    }
    scenario.facts[`uiStateAfter ${after}`] = JSON.stringify(await call('ui.getState', {}, READ_TIMEOUT_MS)).slice(
      0,
      600,
    );
    if (dialogs.length === 0) return [];
    const listed = dialogs
      .map((d) => `${typeof d.kind === 'string' ? d.kind : 'dialog'} closeCommits=${String(d.closeCommits)}`)
      .join(', ');
    scenario.facts[`dialogLeftBy ${after}`] = listed;
    let closed = 'it was closed with ui.dismiss';
    try {
      await call('ui.dismiss', { target: 'dialogs' });
    } catch (error) {
      closed = `ui.dismiss failed: ${messageOf(error)}`;
    }
    return [`${after} left ${String(dialogs.length)} dialog(s) open (${listed}); ${closed}`];
  };

  const historyTop = async (): Promise<Json | null> => {
    const history = member(await call('edit.getHistory', {}, READ_TIMEOUT_MS), 'history', 'edit.getHistory');
    const top = isObject(history) ? history.undoTop : null;
    return isObject(top) ? top : null;
  };

  /** The write result says it cannot be undone because of the upstream defect, and says so as a warning. */
  const notUndoableProblems = (label: string, envelope: Json): string[] => {
    const problems: string[] = [];
    const undo = envelope.undo;
    if (!isObject(undo) || undo.undoable !== false || undo.reason !== 'upstream_undo_defect') {
      problems.push(`${label}: undo is not {undoable:false, reason:upstream_undo_defect}`);
    }
    if (!warningCodes(envelope).includes('UPSTREAM_UNDO_DEFECT')) {
      problems.push(`${label}: the warning UPSTREAM_UNDO_DEFECT is missing`);
    }
    return problems;
  };

  /** edit.undo on the entry the write left on top must be refused; nothing may change. */
  const undoRefusedProblems = async (label: string): Promise<string[]> => {
    const problems: string[] = [];
    const top = await historyTop();
    if (top === null) return [`${label}: the history has no entry on top`];
    if (top.unsafe !== true) problems.push(`${label}: the entry on top of the history is not flagged unsafe`);
    const before = signatureOf(await readProject(need()));
    const params: Json = typeof top.undoId === 'string' ? { expectedUndoId: top.undoId } : { force: true };
    try {
      const refusal = await refused('edit.undo', params);
      if (refusal.data.kind !== 'UNSUPPORTED' || refusal.data.reason !== 'undo_unsafe_build') {
        problems.push(`${label}: edit.undo failed with ${errorName(refusal)}, not UNSUPPORTED(undo_unsafe_build)`);
      }
    } catch (error) {
      problems.push(`${label}: ${messageOf(error)}`);
    }
    if (signatureOf(await readProject(need())) !== before)
      problems.push(`${label}: the refused undo changed the project`);
    return problems;
  };

  // ---------------------------------------------------------------------------------------------
  // set-up

  await step('prepare', async () => {
    root = await scratchDir(SCENARIO_NAME);
    discoveryDir = path.join(root, 'discovery');
    dataDirParent = path.join(root, 'data');
    await mkdir(discoveryDir, { recursive: true });
    await mkdir(dataDirParent, { recursive: true });
    const tone = generateTone({
      seed: 20260402,
      notes: [0, 2, 4].map((semitones) => ({ midi: 57 + semitones, cents: 30, durationSec: 1.1 })),
    });
    toneFile = path.join(root, 'boundary-tone.wav');
    await writeFile(toneFile, tone.wav);
    scenario.facts.sourceSeconds = Number(tone.truth.durationSec.toFixed(3));
    return `${tone.truth.durationSec.toFixed(1)} s of generated audio, own discovery and data folders`;
  });

  await step(
    'launch',
    async () => {
      instance = await startRealInstance({
        exe: config.exe.exe,
        discoveryDir,
        dataDirParent,
        dataTemplate: config.exe.dataTemplate,
        timeoutMs: startTimeoutMs,
      });
      return 'the instance of this run announced itself; only a process this run started is ended';
    },
    { haltOnSkip: true },
  );

  await step(
    'hello',
    async () => {
      const started = instance;
      if (started === undefined) throw new Error('no instance');
      const entry = parseDiscoveryFile(`${String(started.pid)}.json`, await readFile(started.discoveryFile));
      if (!entry.ok) throw new Error(`the discovery file is not valid: ${entry.problem}`);
      session = await OtcpSession.open(entry.entry, START_HELLO_TIMEOUT_MS);
      capabilities = session.hello.capabilities;
      requireCapabilities(REQUIRED_CAPABILITIES);
      scenario.facts.protocol = session.hello.protocol;
      return `protocol ${session.hello.protocol}, ${String(capabilities.length)} capabilities`;
    },
    { haltOnSkip: true },
  );

  await step('import four clips on four tracks', async () => {
    requireCapabilities(['arrangement.v1', 'history.v1', 'tracks.v1']);
    const state = await readProject(need());
    if (state.placements.length > 0) throw new Error('the project is not empty');
    for (const name of ['a', 'b', 'c', 'd'] as const) {
      clips[name] = clipOf(await importClip(toneFile, { generateNotes: true, focus: false }));
    }
    const fresh = await readProject(need());
    const tracks = new Set(fresh.placements.map((p) => p.trackId));
    if (tracks.size !== 4) throw new Error(`the four clips are on ${String(tracks.size)} track(s)`);
    return 'four clips with notes, one per track';
  });

  // ---------------------------------------------------------------------------------------------
  // 2. trim shorter than the fades (first: the later checks leave unsafe entries on the history)

  await check('trim shorter than the fades, and its undo', async () => {
    requireCapabilities(['arrangement.v1', 'history.v1']);
    const problems: string[] = [];
    const d = clip('d');
    let state = await readProject(need());
    const before = placementOf(state, d.placementId);
    const fades = await call('arrangement.edit', {
      expectedArrangementRevision: state.arrangementRevision,
      ops: [{ op: 'setFade', placementId: d.placementId, fadeInSec: 0.5, fadeOutSec: 0.5 }],
    });
    state = await readProject(need());
    const faded = placementOf(state, d.placementId);
    if (!close(faded.fadeInSec, 0.5) || !close(faded.fadeOutSec, 0.5)) problems.push('the fades were not set to 0.5 s');
    const newEnd = faded.startTimelineSec + 0.4;
    const trim = await call('arrangement.edit', {
      expectedArrangementRevision: state.arrangementRevision,
      ops: [{ op: 'trim', placementId: d.placementId, edge: 'end', toTimelineSec: newEnd }],
    });
    if (!warningCodes(trim).includes('FADES_RECLAMPED')) problems.push('the trim carries no FADES_RECLAMPED warning');
    state = await readProject(need());
    const trimmed = placementOf(state, d.placementId);
    if (!close(trimmed.durationSec, 0.4)) problems.push(`the clip is ${String(trimmed.durationSec)} s long, not 0.4 s`);
    if (Math.max(trimmed.fadeInSec, trimmed.fadeOutSec) > trimmed.durationSec + EPSILON) {
      problems.push('a fade is still longer than the clip');
    }
    scenario.facts.fadesAfterTrimSec = `${String(trimmed.fadeInSec)} / ${String(trimmed.fadeOutSec)}`;
    if (trimmed.fadeInSec >= 0.5 - EPSILON && trimmed.fadeOutSec >= 0.5 - EPSILON) {
      problems.push('neither fade was shortened');
    }
    const undo = trim.undo;
    if (!isObject(undo) || undo.undoable !== true || typeof undo.undoId !== 'string') {
      problems.push('the trim result gives no undo id');
    } else {
      await call('edit.undo', { expectedUndoId: undo.undoId });
      state = await readProject(need());
      const back = placementOf(state, d.placementId);
      if (!close(back.durationSec, faded.durationSec) || !close(back.endTimelineSec, faded.endTimelineSec)) {
        problems.push('undoing the trim did not restore the clip length');
      }
      if (!close(back.fadeInSec, 0.5) || !close(back.fadeOutSec, 0.5)) {
        problems.push(
          `undoing the trim left the fades at ${String(back.fadeInSec)} / ${String(back.fadeOutSec)} s, not 0.5 / 0.5 s`,
        );
      }
    }
    // Put the clip back the way it was imported: undo the fade step as well.
    const fadeUndo = fades.undo;
    if (isObject(fadeUndo) && typeof fadeUndo.undoId === 'string') {
      await call('edit.undo', { expectedUndoId: fadeUndo.undoId });
      const final = placementOf(await readProject(need()), d.placementId);
      if (!close(final.fadeInSec, before.fadeInSec) || !close(final.fadeOutSec, before.fadeOutSec)) {
        problems.push('the fades were not put back as imported');
      }
    }
    return finish('trim re-clamps fades', problems, 'FADES_RECLAMPED reported; the undo restored length and fades');
  });

  // ---------------------------------------------------------------------------------------------
  // 3. delete a middle track, then undo an older step

  await check('delete a middle track, then undo an older step', async () => {
    requireCapabilities(['tracks.v1', 'history.v1', 'arrangement.v1']);
    const problems: string[] = [];
    const b = clip('b');
    let state = await readProject(need());
    const tracksBefore = new Map(state.placements.map((p) => [p.placementId, p.trackId]));
    const gain = await call('arrangement.edit', {
      expectedArrangementRevision: state.arrangementRevision,
      ops: [{ op: 'setGain', placementId: b.placementId, gainDb: -3 }],
    });
    const gainUndo = isObject(gain.undo) ? gain.undo.undoId : undefined;
    if (typeof gainUndo !== 'string') throw new Error('the gain step gives no undo id');
    state = await readProject(need());
    const withoutConfirm = await refused('track.delete', {
      trackId: b.trackId,
      expectedArrangementRevision: state.arrangementRevision,
    });
    if (withoutConfirm.data.kind !== 'INVALID_ARGUMENT' || withoutConfirm.data.reason !== 'confirm_required') {
      problems.push(`track.delete without confirm failed with ${errorName(withoutConfirm)}, not confirm_required`);
    }
    const deleted = await call('track.delete', {
      trackId: b.trackId,
      expectedArrangementRevision: state.arrangementRevision,
      confirm: true,
    });
    const idMap = listOf(deleted.trackIdMap);
    const entryOf = (before: number) => idMap.find((entry) => entry.before === before);
    if (entryOf(b.trackId)?.after !== null) problems.push('trackIdMap does not map the deleted track to null');
    state = await readProject(need());
    for (const [placementId, trackId] of tracksBefore) {
      if (placementId === b.placementId) {
        if (state.placements.some((p) => p.placementId === placementId))
          problems.push('the deleted clip is still there');
        continue;
      }
      const mapped = entryOf(trackId);
      const expected = mapped === undefined ? trackId : mapped.after;
      const now = state.placements.find((p) => p.placementId === placementId)?.trackId;
      if (now !== expected) {
        problems.push(
          `the clip of track ${String(trackId)} is on track ${String(now)}, trackIdMap says ${String(expected)}`,
        );
      }
    }
    const stale = isObject(deleted.possiblyStaleEntries) ? deleted.possiblyStaleEntries : undefined;
    const top = await historyTop();
    if (top?.possiblyStale !== true) problems.push('the older entry is not possibly stale in the history');
    if (stale === undefined || num(stale, 'undo', 'possiblyStaleEntries') < 1) {
      problems.push('track.delete counted no possibly stale undo entry');
    }
    const conflict = await refused('edit.undo', { expectedUndoId: gainUndo });
    if (conflict.data.kind !== 'UNDO_CONFLICT' || conflict.data.reason !== 'stale_entry') {
      problems.push(`undoing the stale entry failed with ${errorName(conflict)}, not UNDO_CONFLICT(stale_entry)`);
    }
    const signature = signatureOf(state);
    const forced = await call('edit.undo', { force: true });
    const codes = warningCodes(forced);
    const changed = signatureOf(await readProject(need())) !== signature;
    if (forced.noOp === true) {
      if (!codes.includes('UNDO_NO_EFFECT')) problems.push('a no-op undo carries no UNDO_NO_EFFECT warning');
      if (changed) problems.push('the undo said noOp, but a fresh read differs');
    } else if (!changed) {
      problems.push('the undo said it changed the project, but a fresh read is the same');
    }
    scenario.facts.staleUndo = forced.noOp === true ? 'noOp (UNDO_NO_EFFECT)' : 'applied';
    return finish(
      'track delete and stale undo',
      problems,
      `trackIdMap matches a fresh read; the stale entry was refused without force and answered with ${codes.join(', ') || 'no warning'} with it`,
    );
  });

  // ---------------------------------------------------------------------------------------------
  // 1. structural edits cannot be undone

  await check('split, merge and delete report the undo defect', async () => {
    requireCapabilities(['arrangement.v1', 'history.v1']);
    const problems: string[] = [];
    const a = clip('a');
    let state = await readProject(need());
    const whole = placementOf(state, a.placementId);
    const split = await call('arrangement.edit', {
      expectedArrangementRevision: state.arrangementRevision,
      ops: [{ op: 'split', placementId: a.placementId, atTimelineSec: whole.startTimelineSec + whole.durationSec / 2 }],
    });
    problems.push(...notUndoableProblems('split', split), ...(await undoRefusedProblems('split')));
    state = await readProject(need());
    const parts = state.placements
      .filter((p) => p.trackId === whole.trackId)
      .sort((x, y) => x.startTimelineSec - y.startTimelineSec);
    const leading = parts[0];
    const trailing = parts[1];
    if (parts.length !== 2 || leading === undefined || trailing === undefined) {
      problems.push(`the split left ${String(parts.length)} clip(s) on the track, not 2`);
    } else {
      const merge = await call('arrangement.edit', {
        expectedArrangementRevision: state.arrangementRevision,
        ops: [{ op: 'merge', leadingPlacementId: leading.placementId, trailingPlacementId: trailing.placementId }],
      });
      problems.push(...notUndoableProblems('merge', merge), ...(await undoRefusedProblems('merge')));
    }
    state = await readProject(need());
    const doomed = clip('c');
    const unconfirmed = await refused('arrangement.edit', {
      expectedArrangementRevision: state.arrangementRevision,
      ops: [{ op: 'delete', placementIds: [doomed.placementId] }],
    });
    if (unconfirmed.data.reason !== 'confirm_required') {
      problems.push(`delete without confirm failed with ${errorName(unconfirmed)}, not confirm_required`);
    }
    const removed = await call('arrangement.edit', {
      expectedArrangementRevision: state.arrangementRevision,
      ops: [{ op: 'delete', placementIds: [doomed.placementId] }],
      confirm: true,
    });
    problems.push(...notUndoableProblems('delete', removed), ...(await undoRefusedProblems('delete')));
    if (state.placements.length - 1 !== (await readProject(need())).placements.length) {
      problems.push('delete did not remove exactly one clip');
    }
    return finish('structural undo', problems, 'split, merge and delete: undo defect reported, edit.undo refused each');
  });

  // ---------------------------------------------------------------------------------------------
  // 5. and 6. preferences: the editing scheme, then every other processing preference

  await check('switch the editing scheme and put it back', async () => {
    requireCapabilities(['prefs.write']);
    const problems: string[] = [];
    const original = await processingOf();
    const wanted = original.editingScheme === 'openDyne' ? 'openTune' : 'openDyne';
    const envelope = await writeEnvelope('prefs.set', { editingScheme: wanted });
    try {
      if (envelope.applied !== true) problems.push('the switch did not apply');
      if (!warningCodes(envelope).includes('GLOBAL_PREFERENCE')) problems.push('GLOBAL_PREFERENCE is missing');
      const undo = envelope.undo;
      if (!isObject(undo) || undo.undoable !== false || undo.reason !== 'ui_parity') {
        problems.push('undo is not {undoable:false, reason:ui_parity}');
      }
      scenario.facts.schemeSwitchSideEffects = Object.keys(isObject(envelope.sideEffects) ? envelope.sideEffects : {})
        .sort()
        .join(',');
      scenario.facts.schemeSwitchWarnings = warningCodes(envelope).sort().join(',');
      if ((await processingOf()).editingScheme !== wanted) problems.push('a fresh read does not show the new scheme');
      // A dialog the switch opened would refuse the revert below.
      problems.push(...(await leftOverDialogProblems('the scheme switch')));
    } finally {
      const recipe = revertOf(envelope);
      await sendRevert(recipe);
    }
    const back = await processingOf();
    if (back.editingScheme !== original.editingScheme) problems.push('the revert recipe did not put the scheme back');
    return finish('editing scheme', problems, `${String(original.editingScheme)} -> ${wanted} and back by the recipe`);
  });

  await check('every processing preference changes once and is put back by its recipe', async () => {
    requireCapabilities(['prefs.write']);
    const problems: string[] = [];
    const original = await processingOf();
    const changes: Json[] = [
      { tuningHz: original.tuningHz === 442 ? 441 : 442 },
      { hybridMode: original.hybridMode !== true },
      { experimentalFeatures: original.experimentalFeatures !== true },
    ];
    for (const params of changes) {
      const name = Object.keys(params)[0] ?? '';
      let envelope: Json | undefined;
      try {
        envelope = await writeEnvelope('prefs.set', params);
        if (envelope.applied !== true || envelope.noOp === true) problems.push(`${name}: the change did not apply`);
        if (!warningCodes(envelope).includes('GLOBAL_PREFERENCE'))
          problems.push(`${name}: GLOBAL_PREFERENCE is missing`);
        const now = await processingOf();
        if (now[name] !== params[name]) problems.push(`${name}: a fresh read does not show the new value`);
        // A dialog the change opened would refuse the revert below.
        problems.push(...(await leftOverDialogProblems(`the ${name} change`)));
      } finally {
        if (envelope !== undefined) await sendRevert(revertOf(envelope));
      }
      const back = await processingOf();
      if (JSON.stringify(back) !== JSON.stringify(original)) {
        problems.push(
          `${name}: after the recipe the preferences are ${JSON.stringify(back)}, not ${JSON.stringify(original)}`,
        );
      }
    }
    return finish(
      'processing preferences',
      problems,
      'tuningHz, hybridMode and experimentalFeatures: set, reverted, read back',
    );
  });

  // ---------------------------------------------------------------------------------------------
  // 4. openDyne: notes generated by focus and by selection

  await check('openDyne: import focus and selection generate notes', async () => {
    requireCapabilities(['prefs.write', 'ui.bridge']);
    const problems: string[] = [];
    const original = await processingOf();
    const noteCountOf = async (contentId: string): Promise<number> => {
      const read = await call('project.get', {}, READ_TIMEOUT_MS);
      const summary = listOf(member(read, 'contents', 'project.get')).find((c) => c.contentId === contentId);
      return summary === undefined ? -1 : num(summary, 'noteCount', 'the content summary');
    };
    let switched: Json | undefined;
    try {
      // The clip without notes is made under openTune, which never generates notes by itself, and only then is
      // the scheme switched: with openDyne already set, a clip imported even with focus false and generateNotes
      // false gets notes a moment after its analysis (it is selected, and no result reports them), so no
      // clip without notes can be made there with certainty.
      if (original.editingScheme === 'openDyne') {
        switched = await writeEnvelope('prefs.set', { editingScheme: 'openTune' });
      }
      const bare = await importClip(toneFile, { generateNotes: false, focus: false });
      const bareClip = clipOf(bare);
      // Moves the selection off the new clip: a selected clip is the one that gets notes in openDyne.
      const others = (await readProject(need())).placements.filter((p) => p.placementId !== bareClip.placementId);
      const elsewhere = others[0];
      if (elsewhere === undefined) {
        throw new StepSkip(
          'SKIP',
          'no other clip than the new one to move the selection to, so no clip can be unselected',
        );
      }
      await call('ui.setSelection', { placementId: elsewhere.placementId });
      // Bounded poll of the count (the analysis is ready; a note count of a clip nobody selected stays 0).
      for (let i = 0; i < 6; i++) {
        if ((await noteCountOf(bareClip.contentId)) !== 0) {
          throw new Error('a clip imported without notes under openTune has notes before the switch');
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      const toDyne = await writeEnvelope('prefs.set', { editingScheme: 'openDyne' });
      switched ??= toDyne;
      scenario.facts.schemeSwitchToOpenDyneWarnings = warningCodes(toDyne).sort().join(',');
      for (let i = 0; i < 6; i++) {
        if ((await noteCountOf(bareClip.contentId)) !== 0) {
          throw new Error('the switch to openDyne generated notes for a clip nobody selected');
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      // Move the selection off the new clip first: selecting a clip that already is selected generates nothing.
      // `elsewhere` was taken before the switch and is still a clip of the project; it is never the new clip.
      await call('ui.setSelection', { placementId: elsewhere.placementId });
      const notesBefore = await noteCountOf(bareClip.contentId);
      const selected = await call('ui.setSelection', { placementId: bareClip.placementId });
      if (!warningCodes(selected).includes('SELECTION_GENERATED_NOTES')) {
        const effects = isObject(selected.sideEffects) ? Object.keys(selected.sideEffects).join(',') : '';
        problems.push(
          `selecting the clip without notes carries no SELECTION_GENERATED_NOTES warning (it had ${String(notesBefore)} notes before; ` +
            `warnings: ${warningCodes(selected).join(',') || 'none'}; sideEffects: ${effects || 'none'}; ` +
            `notes after: ${String(await noteCountOf(bareClip.contentId))})`,
        );
      }
      const generated = isObject(selected.sideEffects) ? selected.sideEffects.notesGenerated : undefined;
      if (!isObject(generated) || generated.contentId !== bareClip.contentId) {
        problems.push('sideEffects.notesGenerated does not name the selected clip');
      }
      const dirty = selected.dirty;
      if (!isObject(dirty) || dirty.after !== true) problems.push('the project is not marked as changed');
      const state = await call('ui.getState', {}, READ_TIMEOUT_MS);
      const ui = member(state, 'ui', 'ui.getState');
      const ids = isObject(ui) && Array.isArray(ui.selectedPlacementIds) ? (ui.selectedPlacementIds as unknown[]) : [];
      if (ids.length !== 1 || ids[0] !== bareClip.placementId)
        problems.push('ui.getState does not show the selected clip');
      const notes = await noteCountOf(bareClip.contentId);
      if (notes <= 0) problems.push('a fresh read shows no notes on the selected clip');
      if (isObject(generated) && typeof generated.noteCount === 'number' && generated.noteCount !== notes) {
        problems.push(`the result says ${String(generated.noteCount)} notes, a fresh read ${String(notes)}`);
      }
      const focused = await importClip(toneFile, { generateNotes: false, focus: true });
      const envelope = focused.envelope as Json;
      if (focused.notesGenerated !== true || focused.notesGeneratedBy !== 'focus') {
        problems.push('the import with focus did not report notesGenerated / notesGeneratedBy focus');
      }
      if (!warningCodes(envelope).includes('SELECTION_GENERATED_NOTES')) {
        problems.push('the import with focus carries no SELECTION_GENERATED_NOTES warning');
      }
    } finally {
      if (switched !== undefined) await sendRevert(revertOf(switched));
    }
    if (JSON.stringify(await processingOf()) !== JSON.stringify(original)) {
      problems.push('the editing scheme was not put back');
    }
    return finish('openDyne side effects', problems, 'notes were generated by focus and by selection, and reported');
  });

  // ---------------------------------------------------------------------------------------------
  // 7. and 8. save as over another project, and a project whose media is gone

  // The two steps share the project that the first one leaves saved and loaded.
  const folder = path.join(root, 'projects');
  const media = path.join(root, 'media');
  const copy = path.join(media, 'copied-take.wav');
  const moved = path.join(media, 'moved-take.wav');
  const first = path.join(folder, 'first.otproj');
  const second = path.join(folder, 'second.otproj');
  let placedCount = 0;

  await check('save as over another project', async () => {
    requireCapabilities(['project.io']);
    const problems: string[] = [];
    await mkdir(folder, { recursive: true });
    await mkdir(media, { recursive: true });
    await copyFile(toneFile, copy);
    await importClip(copy, { generateNotes: false, focus: false });
    placedCount = (await readProject(need())).placements.length;
    const save = (target: string, extra: Json = {}) =>
      runJob(need(), 'project.saveAs', { path: target, ...extra }, 'project save', timeoutMs);
    const plain = await save(first);
    scenario.facts.projectBytes = num(plain, 'sizeBytes', 'the save result');
    scenario.facts.mediaBytes = (await stat(copy)).size;
    if (isObject(plain) && warningCodes(plain).includes('OVERWROTE_OTHER_PROJECT')) {
      problems.push('saving to a new file reports OVERWROTE_OTHER_PROJECT');
    }
    await save(second);
    const before = await stat(first);
    try {
      await save(first);
      problems.push('saving over another project without confirm was not refused');
    } catch (error) {
      if (!(error instanceof OtcpError)) throw error;
      scenario.facts.overwriteRefusal = errorName(error);
    }
    const unchanged = await stat(first);
    if (unchanged.size !== before.size || unchanged.mtimeMs !== before.mtimeMs) {
      problems.push('the refused save changed the other project file');
    }
    const overwritten = await save(first, { confirm: true });
    if (!isObject(overwritten) || !warningCodes(overwritten).includes('OVERWROTE_OTHER_PROJECT')) {
      problems.push('saving over another project with confirm carries no OVERWROTE_OTHER_PROJECT warning');
    }
    return finish('save as', problems, 'overwrite refused, then confirmed with its warning');
  });

  await check('a project with missing media', async () => {
    requireCapabilities(['project.io']);
    if (placedCount === 0) throw new StepSkip('SKIP', 'the save-as step did not leave a saved project to open');
    const problems: string[] = [];
    // The project is saved now; take the media of the copied clip away and open the file again.
    try {
      await rename(copy, moved);
    } catch (error) {
      scenario.manualChecks.push(
        `MISSING MEDIA was not run: the media file could not be renamed while OpenTune held it (${messageOf(error)}); ` +
          'rename it by hand, then open the project.',
      );
      throw new StepSkip('SKIP', `the media file could not be renamed while OpenTune held it: ${messageOf(error)}`);
    }
    // OpenTune keeps a copy of the media in a folder next to the project file; that copy is taken away too.
    const { outcome, putBackFailures } = await withMediaAway({ folder, copy, moved }, async (copyFolders) => {
      scenario.facts.mediaCopyFolders = copyFolders;
      const opened = await runJob(need(), 'project.open', { path: first }, 'project open', timeoutMs);
      if (!isObject(opened)) throw new Error('project.open ended without a result object');
      if (!warningCodes(opened).includes('MEDIA_MISSING')) problems.push('opening carries no MEDIA_MISSING warning');
      const skipped = member(opened, 'skipped', 'the open result');
      const missing = isObject(skipped) ? listOf(skipped.media) : [];
      if (missing.length !== 1 || missing[0]?.reason !== 'missing') {
        problems.push(`skipped.media lists ${String(missing.length)} file(s), expected the one renamed`);
      }
      if (isObject(skipped) && skipped.placementCount !== 1) {
        problems.push(`skipped.placementCount is ${String(skipped.placementCount)}, not 1`);
      }
      const restored = member(opened, 'restored', 'the open result');
      if (isObject(restored) && restored.placementCount !== placedCount - 1) {
        problems.push(`restored.placementCount is ${String(restored.placementCount)}, not ${String(placedCount - 1)}`);
      }
      const after = await readProject(need());
      if (after.placements.length !== placedCount - 1) {
        problems.push(`a fresh read shows ${String(after.placements.length)} clip(s), not ${String(placedCount - 1)}`);
      }
      scenario.facts.missingMediaWarnings = warningCodes(opened).sort().join(',');
    });
    // A rename back that fails neither hides what the check found nor turns it into a failure of its own: it
    // is a note of the report (the scratch folder is removed afterwards), and the verdict stays as it was.
    const left =
      putBackFailures.length === 0
        ? undefined
        : `files of the scratch folder were left renamed: ${putBackFailures.join(', ')}`;
    if (left !== undefined) scenario.manualChecks.push(`MISSING MEDIA: ${left}.`);
    if (!outcome.ok) throw outcome.error;
    return finish(
      'missing media',
      problems,
      `the project opened without the missing file, and MEDIA_MISSING was reported${left === undefined ? '' : `; ${left}`}`,
    );
  });

  // ---------------------------------------------------------------------------------------------

  await step(
    'shutdown',
    async () => {
      session?.close();
      const notes: string[] = [];
      if (instance !== undefined) {
        try {
          await instance.end();
        } catch (error) {
          notes.push(messageOf(error));
        }
      }
      if (discoveryDir !== '') notes.push(...(await endAllConfirmed(discoveryDir)).notes);
      // The settings of the instance's data folder must be back as they were before it started.
      notes.push(...(await instanceSettingsProblems([instance])));
      scenario.facts.settingsFilesWithAddedKeys = instance?.settings?.appeared.length ?? 0;
      if (root !== '') {
        try {
          await removeDir(root);
        } catch {
          notes.push('the scratch folder could not be removed');
        }
      }
      if (notes.length > 0) throw new Error(notes.join('; '));
      return instance === undefined
        ? 'nothing was started'
        : 'the instance this run started is ended, its settings are as before, scratch folder removed';
    },
    { always: true },
  );

  scenario.manualChecks.push(...MANUAL_CHECKS);
  return scenario.report();
}
