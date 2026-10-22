// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The wave-B tour against a started OpenTune: every OTCP method and every MCP tool that wave B added
// is driven once, and what the instance answers is checked against the specification and against what
// the tools tell the user. For every write the tour checks that the result validates against the
// method schema, that every `changes[].fields.*.after` equals the value a read right after the write
// returns, that the returned tokens equal those of a fresh read, that the undo or revert recipe
// restores the read-back snapshot, and that the warnings the specification promises for the case are
// there; the latency of every call goes into the report. The MCP part starts the built bundle over
// stdio against the same instance and calls each wave-B tool once.
//
// Safety on the machine: the instance runs with a data folder of this run (never the real AppData);
// playback happens only while every track is muted, and the mute is put back; audio.set changes one
// value audio.get offers (a buffer size or sample rate of the current device, else another output
// device or device type), with the maintainer's agreement, and reverts it, comparing the whole setup
// with the one it found; prefs.set reverts every preference
// it touched; ui.dismiss runs only when no dialog is open (or closes the first-run overlay this run's
// own instance started); track.delete and arrangement.edit op delete act only on tracks and clips this
// scenario created, with confirm true set here. All audio is generated at run time.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { parseDiscoveryFile } from '../../src/discovery/file.js';
import { OtcpError, type ErrorData } from '../../src/errors/tool-error.js';
import { OtcpSession, type Json } from '../../src/otcp/client.js';
import { TOOLS } from '../../src/tools/index.js';
import { generateTone } from '../support/harmonic-tone.js';
import { otcpSpec } from '../support/otcp-spec.js';
import {
  endAllConfirmed,
  instanceSettingsProblems,
  removeDir,
  scratchDir,
  startMcp,
  startRealInstance,
  type McpProcess,
  type RealInstance,
  type RealInstanceOptions,
  type ToolOutcome,
} from './real-support.js';
import { Scenario, type ScenarioReport } from './scenario.js';
import { StepSkip, clean, member, num, text, waitJob, type SmokeConfig } from './smoke.js';

export const SCENARIO_NAME = 'wave-b-tour';

const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 60_000;
const START_HELLO_TIMEOUT_MS = 15_000;
const MAX_LISTED = 8;

/** The capabilities without which the tour cannot run at all. */
const REQUIRED_CAPABILITIES = ['session.v1', 'jobs.v1', 'read.v1', 'import.v1'] as const;

/** The members a change of the entity may name, as the reads report them. */
const TRACK_MEMBERS = ['muted', 'solo', 'volumeDb', 'volumeLinear', 'colour', 'visible', 'audible'] as const;
const PLACEMENT_MEMBERS = [
  'trackId',
  'startTimelineSec',
  'endTimelineSec',
  'durationSec',
  'clipInContentSec',
  'gainDb',
  'gainLinear',
  'fadeInSec',
  'fadeOutSec',
  'referencePlacementId',
] as const;
const NOTE_MEMBERS = [
  'startContentSec',
  'endContentSec',
  'targetMidi',
  'offsetCents',
  'retuneSpeed',
  'vibratoDepth',
  'vibratoRateHz',
  'pitchDriftScale',
  'voiced',
  'corrected',
] as const;
const PROCESSING_MEMBERS = ['tuningHz', 'editingScheme', 'hybridMode', 'experimentalFeatures'] as const;
const DEVICE_MEMBERS = [
  'running',
  'deviceType',
  'outputDevice',
  'sampleRateHz',
  'bufferSizeFrame',
  'outputChannelPair',
] as const;
const TRANSPORT_MEMBERS = ['playing', 'positionTimelineSec', 'playStartTimelineSec', 'loopEnabled'] as const;
const SELECTION_MEMBERS = ['workspace', 'activeTrackId', 'selectedPlacementIds', 'pianoRollContentId'] as const;

const READBACK_EPSILON = 1e-6;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const listOf = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);

/** The numbers of an array value, for the audio lists; anything else is empty. */
const numbersOf = (value: unknown): number[] =>
  (Array.isArray(value) ? (value as unknown[]) : []).filter((item): item is number => typeof item === 'number');

/** The strings of an array value, for the audio lists; anything else is empty. */
const stringsOf = (value: unknown): string[] =>
  (Array.isArray(value) ? (value as unknown[]) : []).filter((item): item is string => typeof item === 'string');

/** The one audio setting the tour changes and puts back. */
export interface AudioSwitch {
  readonly field: 'bufferSizeFrame' | 'sampleRateHz' | 'outputDevice' | 'deviceType';
  readonly value: string | number;
}

/**
 * Picks what audio.set changes in the audio.get answer. A buffer size or sample rate of the current
 * device comes first (nothing else about the setup moves); when the device offers neither, another
 * output device, then another device type. null when audio.get offers nothing but the current setup.
 */
export function chooseAudioSwitch(device: Json, available: Json): AudioSwitch | null {
  const otherNumber = (offered: unknown, current: unknown): number | undefined =>
    numbersOf(offered).find((value) => value !== current);
  const otherText = (offered: unknown, current: unknown): string | undefined =>
    stringsOf(offered).find((value) => value !== current);
  const buffer = otherNumber(available.bufferSizesFrame, device.bufferSizeFrame);
  if (buffer !== undefined) return { field: 'bufferSizeFrame', value: buffer };
  const rate = otherNumber(available.sampleRatesHz, device.sampleRateHz);
  if (rate !== undefined) return { field: 'sampleRateHz', value: rate };
  const output = otherText(available.outputDevices, device.outputDevice);
  if (output !== undefined) return { field: 'outputDevice', value: output };
  const type = otherText(available.deviceTypes, device.deviceType);
  if (type !== undefined) return { field: 'deviceType', value: type };
  return null;
}

/** A member that must be an object. */
function objectMember(value: unknown, name: string, what: string): Json {
  const found = member(value, name, what);
  if (!isObject(found)) throw new Error(`${what}.${name} is not an object`);
  return found;
}

/** The members of `value` whose names are in `names`; absent members stay absent. */
function pick(value: unknown, names: readonly string[]): Json {
  const from = isObject(value) ? value : {};
  return Object.fromEntries(names.filter((name) => name in from).map((name) => [name, from[name]]));
}

const sameNumber = (a: number, b: number): boolean => Math.abs(a - b) <= READBACK_EPSILON;

/** Deep equality of read-back values, with numbers compared to the precision the protocol rounds to. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return sameNumber(a, b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameValue(a[key], b[key]));
  }
  return a === b;
}

/** The paths at which two snapshot values differ, at most `MAX_LISTED` of them. */
export function differences(a: Json, b: Json, at = ''): string[] {
  const found: string[] = [];
  const walk = (x: unknown, y: unknown, where: string) => {
    if (found.length >= MAX_LISTED) return;
    if (sameValue(x, y)) return;
    if (isObject(x) && isObject(y)) {
      for (const key of [...new Set([...Object.keys(x), ...Object.keys(y)])]) {
        if (!(key in x)) found.push(`${where}${key} appeared`);
        else if (!(key in y)) found.push(`${where}${key} disappeared`);
        else walk(x[key], y[key], `${where}${key}.`);
      }
      return;
    }
    found.push(`${where}${JSON.stringify(x)} -> ${JSON.stringify(y)}`);
  };
  walk(a, b, at);
  return found.slice(0, MAX_LISTED);
}

const codesOf = (envelope: Json): string[] =>
  listOf(envelope.warnings).flatMap((warning) => (typeof warning.code === 'string' ? [warning.code] : []));

const firstSentence = (summary: string): string => summary.split(/(?<=\.)\s/)[0] ?? summary;

const schemaPath = (method: string, part: 'result' | 'jobResult'): string =>
  `methods/${method}.schema.json#/$defs/${part}`;

/** The problems of a value against a schema of the specification. */
export function schemaProblems(ref: string, value: unknown, what: string): string[] {
  return otcpSpec()
    .validate(ref, value)
    .map((problem) => `${what}: not valid against ${ref}: ${problem}`);
}

// ---------------------------------------------------------------------------------------------
// reading the instance

interface NoteListing {
  readonly notes: Json[];
  readonly revision: string;
}

/** Reads of the instance, cached until the next write, so that one check reads each state once. */
class Reads {
  readonly stats = { calls: 0, ms: 0 };
  #project: Json | undefined;
  #transport: Json | undefined;
  #prefs: Json | undefined;
  #audio: Json | undefined;
  #ui: Json | undefined;
  readonly #details = new Map<string, Json>();
  readonly #notes = new Map<string, NoteListing>();

  constructor(private readonly session: OtcpSession) {}

  clear(): void {
    this.#project = undefined;
    this.#transport = undefined;
    this.#prefs = undefined;
    this.#audio = undefined;
    this.#ui = undefined;
    this.#details.clear();
    this.#notes.clear();
  }

  async #read(method: string, params: Json): Promise<Json> {
    const started = performance.now();
    try {
      return await this.session.call(method, params, READ_TIMEOUT_MS);
    } finally {
      this.stats.calls += 1;
      this.stats.ms += performance.now() - started;
    }
  }

  async project(): Promise<Json> {
    this.#project ??= await this.#read('project.get', {});
    return this.#project;
  }

  async transport(): Promise<Json> {
    this.#transport ??= await this.#read('transport.get', {});
    return this.#transport;
  }

  async prefs(): Promise<Json> {
    this.#prefs ??= await this.#read('prefs.get', {});
    return this.#prefs;
  }

  async audio(): Promise<Json> {
    this.#audio ??= await this.#read('audio.get', {});
    return this.#audio;
  }

  async ui(): Promise<Json> {
    this.#ui ??= await this.#read('ui.getState', {});
    return this.#ui;
  }

  async details(contentId: string): Promise<Json> {
    let read = this.#details.get(contentId);
    if (read === undefined) {
      read = await this.#read('content.getDetails', { contentId });
      this.#details.set(contentId, read);
    }
    return read;
  }

  async notes(contentId: string): Promise<NoteListing> {
    let read = this.#notes.get(contentId);
    if (read === undefined) {
      const notes: Json[] = [];
      let cursor: string | null = null;
      let revision: string;
      do {
        const page = await this.#read(
          'content.getNotes',
          cursor === null ? { contentId, limit: 500 } : { contentId, limit: 500, cursor },
        );
        const asOf = member(page, 'asOf', 'content.getNotes');
        const entry = listOf(member(asOf, 'contents', 'asOf')).find((c) => c.contentId === contentId);
        revision = text(entry ?? {}, 'revision', 'the notes tokens');
        notes.push(...listOf(member(page, 'notes', 'content.getNotes')));
        const next = member(page, 'nextCursor', 'content.getNotes');
        cursor = typeof next === 'string' ? next : null;
      } while (cursor !== null);
      read = { notes, revision };
      this.#notes.set(contentId, read);
    }
    return read;
  }

  /** The transport state, as transport.get reports it. */
  async transportState(): Promise<Json> {
    return objectMember(await this.transport(), 'transport', 'transport.get');
  }

  async projectState(): Promise<Json> {
    return objectMember(await this.project(), 'project', 'project.get');
  }

  async uiState(): Promise<Json> {
    return objectMember(await this.ui(), 'ui', 'ui.getState');
  }

  /** What a fresh read says about the entity a change refers to, by member name; null when it is gone. */
  async valuesOf(entity: string, ref: unknown): Promise<Json | null> {
    if (!isObject(ref)) return null;
    switch (entity) {
      case 'track': {
        const trackId = num(ref, 'trackId', 'the reference');
        const track = listOf(member(await this.project(), 'tracks', 'project.get')).find((t) => t.trackId === trackId);
        return track === undefined ? null : pick(track, TRACK_MEMBERS);
      }
      case 'placement': {
        const placementId = text(ref, 'placementId', 'the reference');
        const placement = listOf(member(await this.project(), 'placements', 'project.get')).find(
          (p) => p.placementId === placementId,
        );
        return placement === undefined ? null : pick(placement, PLACEMENT_MEMBERS);
      }
      case 'content': {
        const contentId = text(ref, 'contentId', 'the reference');
        const project = await this.project();
        const asOf = objectMember(project, 'asOf', 'project.get');
        const tokens = listOf(member(asOf, 'contents', 'asOf')).find((c) => c.contentId === contentId);
        const summary = listOf(member(project, 'contents', 'project.get')).find((c) => c.contentId === contentId);
        // A content that left the project with the write (the last clip showing it was removed) is
        // gone: there is nothing to read, and content.getDetails would fail with NOT_FOUND.
        if (tokens === undefined && summary === undefined) return null;
        const values: Json = {};
        if (tokens !== undefined) {
          values.revision = tokens.revision;
          values.gridRevision = tokens.gridRevision;
          values.keyRevision = tokens.keyRevision;
        }
        if (summary !== undefined) {
          values.noteCount = summary.noteCount;
          values.key = summary.key;
          values.pitchShift = summary.pitchShift;
          values.f0State = summary.f0State;
        }
        const details = await this.details(contentId);
        values.referencePlacementId = objectMember(details, 'reference', 'content details').referencePlacementId;
        return values;
      }
      case 'note': {
        const contentId = text(ref, 'contentId', 'the reference');
        const noteRef = member(ref, 'note', 'the reference');
        const index = num(noteRef, 'index', 'the note reference');
        const listed = await this.notes(contentId);
        const note = listed.notes.find((n) => n.index === index);
        return note === undefined ? null : pick(note, NOTE_MEMBERS);
      }
      case 'key': {
        const contentId = text(ref, 'contentId', 'the reference');
        const details = await this.details(contentId);
        const key = member(details, 'key', 'content details');
        return isObject(key) ? pick(key, ['root', 'scale']) : null;
      }
      case 'pitchShift': {
        const contentId = text(ref, 'contentId', 'the reference');
        return pick(member(await this.details(contentId), 'pitchShift', 'content details'), ['semitones', 'cents']);
      }
      case 'tempo': {
        const transport = await this.transportState();
        return pick(transport, ['bpm', 'timeSignature']);
      }
      case 'transport': {
        return pick(await this.transportState(), TRANSPORT_MEMBERS);
      }
      case 'preference': {
        const name = text(ref, 'preference', 'the reference');
        const prefs = await this.prefs();
        const processing = member(prefs, 'processing', 'prefs.get');
        if (isObject(processing) && name in processing) return { [name]: processing[name] };
        if (name in prefs) return { [name]: prefs[name] };
        return null;
      }
      case 'audioDevice': {
        return pick(member(await this.audio(), 'device', 'audio.get'), DEVICE_MEMBERS);
      }
      case 'selection': {
        return pick(await this.uiState(), SELECTION_MEMBERS);
      }
      case 'project': {
        return pick(await this.projectState(), ['dirty', 'path']);
      }
      default:
        return null;
    }
  }

  /** A canonical snapshot of the parts of the state named by `kinds`, for comparing around a write. */
  async snapshot(kinds: readonly string[]): Promise<Json> {
    const out: Json = {};
    for (const kind of kinds) out[kind] = await this.snapshotValue(kind);
    return out;
  }

  async snapshotValue(kind: string): Promise<unknown> {
    if (kind === 'tracks') {
      // Only the visible tracks: deleting a track moves the hidden ones into other slots and gives
      // the last slot a fresh default, which no request restores and which the scenario never changed.
      return visibleTracks(await this.project())
        .map((track) => {
          const entry: Json = { trackId: track.trackId };
          return Object.assign(entry, pick(track, TRACK_MEMBERS));
        })
        .sort((a, b) => Number(a.trackId) - Number(b.trackId));
    }
    if (kind === 'placements') {
      return listOf(member(await this.project(), 'placements', 'project.get'))
        .map((placement) => {
          const entry: Json = { placementId: placement.placementId, contentId: placement.contentId };
          return Object.assign(entry, pick(placement, PLACEMENT_MEMBERS));
        })
        .sort((a, b) => String(a.placementId).localeCompare(String(b.placementId)));
    }
    if (kind === 'geometry') {
      const key = (entry: Json) => `${String(entry.contentId)}:${String(entry.startTimelineSec)}`;
      return listOf(member(await this.project(), 'placements', 'project.get'))
        .map((placement) => {
          const entry: Json = { contentId: placement.contentId };
          return Object.assign(entry, pick(placement, PLACEMENT_MEMBERS));
        })
        .sort((a, b) => key(a).localeCompare(key(b)));
    }
    if (kind === 'tempo') return pick(await this.transportState(), ['bpm', 'timeSignature']);
    if (kind === 'loop') return pick(await this.transportState(), ['loopEnabled']);
    if (kind === 'transport') return pick(await this.transportState(), TRANSPORT_MEMBERS);
    if (kind === 'processing') return pick(member(await this.prefs(), 'processing', 'prefs.get'), PROCESSING_MEMBERS);
    if (kind === 'audio') return pick(member(await this.audio(), 'device', 'audio.get'), DEVICE_MEMBERS);
    if (kind === 'selection') return pick(await this.uiState(), SELECTION_MEMBERS);
    if (kind === 'onboarding') {
      const onboarding = member(await this.ui(), 'onboarding', 'ui.getState');
      const shown = pick(await this.prefs(), ['onboardingShown']);
      return pick({ ...(isObject(onboarding) ? onboarding : {}), ...shown }, ['shown', 'showing', 'onboardingShown']);
    }
    if (kind.startsWith('content:')) {
      const contentId = kind.slice('content:'.length);
      const details = await this.details(contentId);
      const reference = objectMember(details, 'reference', 'content details');
      const listed = await this.notes(contentId);
      return {
        key: details.key,
        pitchShift: details.pitchShift,
        referencePlacementId: reference.referencePlacementId,
        alignmentReady: reference.alignmentReady,
        noteCount: listed.notes.length,
        notes: listed.notes.map((note) =>
          pick(note, ['index', 'startContentSec', 'endContentSec', 'targetMidi', 'offsetCents']),
        ),
      };
    }
    if (kind.startsWith('notes:')) {
      const contentId = kind.slice('notes:'.length);
      return (await this.notes(contentId)).notes.map((note) =>
        pick(note, ['index', 'startContentSec', 'endContentSec', 'targetMidi', 'offsetCents']),
      );
    }
    throw new Error(`no snapshot of ${kind}`);
  }
}

// ---------------------------------------------------------------------------------------------
// the calls and their checks

export interface TourCall {
  readonly step: string;
  readonly method: string;
  readonly kind: 'write' | 'undo' | 'revert' | 'read' | 'job';
  readonly ms: number;
  readonly outcome: 'ok' | 'error';
  readonly note: string;
}

export interface TourTool {
  readonly tool: string;
  readonly ms: number;
  readonly outcome: 'ok' | 'error' | 'skip';
  readonly note: string;
}

/** What a write is expected to report; the specification's promises for the case. */
export interface WriteExpect {
  readonly warnings?: readonly string[];
  readonly absentWarnings?: readonly string[];
  readonly noOp?: boolean;
  readonly applied?: boolean;
  readonly undoable?: boolean;
  readonly undoReason?: string;
  readonly revert?: 'none' | 'present' | 'consent';
  readonly irreversible?: boolean;
}

export interface WriteSpec {
  readonly step: string;
  readonly method: string;
  readonly params: Json;
  readonly expect?: WriteExpect;
  /** The parts of the state read before the write and compared after the undo or revert. */
  readonly snapshot?: readonly string[];
  /** Follow the job the call started and check the job's result (the method's jobResult schema). */
  readonly followJob?: boolean;
  /** 'none' keeps the change (a later step takes it back); the default takes it back at once. */
  readonly restore?: 'auto' | 'none';
}

export interface WriteRun {
  /** The write envelope of the committed work (the job's result for a job-backed method). */
  readonly envelope: Json;
  readonly problems: string[];
  /** Fields of changes the read-back comparison does not know, as `entity.field`. */
  readonly unread: string[];
  /** The state did not come back after the undo or revert: later steps must not rely on it. */
  readonly unrestored: boolean;
  readonly ms: number;
  /** What took the change back, for the note. */
  readonly restoredBy: string | null;
  /** The error the instance answered the write (or its job) with; absent when it committed. */
  readonly failure?: ErrorData;
}

/** Runs the calls of the tour, times them and keeps the read cache in step with the instance. */
class Tour {
  readonly reads: Reads;
  readonly calls: TourCall[] = [];

  constructor(
    private readonly session: OtcpSession,
    private readonly timeoutMs: number,
    private readonly stepName: () => string,
  ) {
    this.reads = new Reads(session);
  }

  async call(kind: TourCall['kind'], method: string, params: Json): Promise<Json> {
    const started = performance.now();
    try {
      const result = await this.session.call(method, params, WRITE_TIMEOUT_MS);
      this.calls.push({
        step: this.stepName(),
        method,
        kind,
        ms: Math.round(performance.now() - started),
        outcome: 'ok',
        note: 'result read',
      });
      return result;
    } catch (error) {
      this.calls.push({
        step: this.stepName(),
        method,
        kind,
        ms: Math.round(performance.now() - started),
        outcome: 'error',
        note: clean(error instanceof Error ? error.message : String(error)),
      });
      throw error;
    }
  }

  /** Follows a job a method handed over; the job's result is the write envelope of the committed work. */
  async followJob(step: string, what: string, job: Json): Promise<Json> {
    const jobId = text(job, 'jobId', 'the job');
    const started = performance.now();
    try {
      const result = await waitJob(this.session, jobId, what, this.timeoutMs);
      if (!isObject(result)) throw new Error(`the ${what} job ended without a result object`);
      this.calls.push({
        step,
        method: 'job.get',
        kind: 'job',
        ms: Math.round(performance.now() - started),
        outcome: 'ok',
        note: clean(`${what} job`),
      });
      return result;
    } catch (error) {
      this.calls.push({
        step,
        method: 'job.get',
        kind: 'job',
        ms: Math.round(performance.now() - started),
        outcome: 'error',
        note: clean(error instanceof Error ? error.message : String(error)),
      });
      throw error;
    }
  }

  /** The problems of one write's result against its expectations, the read-back state and its tokens. */
  private async checkEnvelope(
    method: string,
    envelope: Json,
    expect: WriteExpect | undefined,
  ): Promise<{ problems: string[]; unread: string[] }> {
    const problems: string[] = [];
    const unread = new Set<string>();
    const codes = codesOf(envelope);
    if (expect?.warnings !== undefined) {
      for (const code of expect.warnings) {
        if (!codes.includes(code)) problems.push(`no ${code} warning (warnings: ${codes.join(', ') || 'none'})`);
      }
    }
    for (const code of expect?.absentWarnings ?? []) {
      if (codes.includes(code)) problems.push(`unexpected ${code} warning`);
    }
    if (expect?.irreversible === true && !codes.includes('IRREVERSIBLE')) problems.push('no IRREVERSIBLE warning');
    if (expect?.noOp !== undefined && envelope.noOp !== expect.noOp) {
      problems.push(`noOp is ${String(envelope.noOp)}, expected ${String(expect.noOp)}`);
    }
    if (expect?.applied !== undefined && envelope.applied !== expect.applied) {
      problems.push(`applied is ${String(envelope.applied)}, expected ${String(expect.applied)}`);
    }
    const undo = isObject(envelope.undo) ? envelope.undo : null;
    if (expect?.undoable !== undefined) {
      if (undo === null) problems.push('the result carries no undo descriptor');
      else if (undo.undoable !== expect.undoable) {
        problems.push(`undo.undoable is ${String(undo.undoable)}, expected ${String(expect.undoable)}`);
      }
    }
    if (expect?.undoReason !== undefined && undo?.reason !== expect.undoReason) {
      problems.push(`undo.reason is ${String(undo?.reason)}, expected ${expect.undoReason}`);
    }
    if (expect?.revert !== undefined) {
      const revert = undo?.revert ?? null;
      const got =
        revert === null ? 'none' : isObject(revert) && revert.requiresConsent === true ? 'consent' : 'present';
      if (got !== expect.revert) problems.push(`undo.revert is ${got}, expected ${expect.revert}`);
    }

    // Every `after` of a change equals the value a read right after the write returns.
    const changes = listOf(member(envelope, 'changes', 'the result'));
    for (const change of changes) {
      const entity = text(change, 'entity', 'a change');
      const ref = member(change, 'ref', 'a change');
      const fields = member(change, 'fields', 'a change');
      if (entity === 'note') {
        const noteRef = member(ref, 'note', 'the note reference');
        const contentId = text(ref, 'contentId', 'the note reference');
        const listed = await this.reads.notes(contentId);
        if (member(noteRef, 'atRevision', 'the note reference') !== listed.revision) {
          problems.push(`a note is referenced at another revision than the one read afterwards`);
        }
      }
      const values = await this.reads.valuesOf(entity, ref);
      if (values === null) {
        problems.push(`the ${entity} of a change is not there after the write`);
        continue;
      }
      for (const [name, field] of Object.entries(isObject(fields) ? fields : {})) {
        if (!(name in values)) {
          unread.add(`${entity}.${name}`);
          continue;
        }
        const after = isObject(field) ? field.after : undefined;
        if (!sameValue(after, values[name])) {
          problems.push(
            `${entity}.${name}: the result says ${JSON.stringify(after)}, a fresh read says ${JSON.stringify(values[name])}`,
          );
        }
      }
    }

    // The tokens equal those of a fresh read.
    const tokens = member(envelope, 'tokens', 'the result');
    if (!isObject(tokens)) {
      problems.push('tokens is not an object');
      return { problems, unread: [...unread].sort() };
    }
    const project = await this.reads.project();
    const asOf = objectMember(project, 'asOf', 'project.get');
    if (tokens.arrangementRevision !== asOf.arrangementRevision) {
      problems.push('tokens.arrangementRevision is not the one a fresh read returns');
    }
    const freshContents = listOf(member(asOf, 'contents', 'asOf'));
    for (const entry of listOf(tokens.contents)) {
      const fresh = freshContents.find((c) => c.contentId === entry.contentId);
      if (fresh === undefined) continue; // The content left the project with the write.
      for (const name of ['revision', 'gridRevision', 'keyRevision']) {
        if (entry[name] !== fresh[name]) problems.push(`tokens.contents.${name} is not the one a fresh read returns`);
      }
    }
    const freshPlacements = listOf(member(project, 'placements', 'project.get'));
    for (const entry of listOf(tokens.placements)) {
      const fresh = freshPlacements.find((p) => p.placementId === entry.placementId);
      if (fresh !== undefined && entry.geometryHash !== fresh.geometryHash) {
        problems.push('tokens.placements.geometryHash is not the one a fresh read returns');
      }
    }

    // Created entities are there, removed ones are gone.
    for (const item of listOf(member(envelope, 'created', 'the result'))) {
      const entity = text(item, 'entity', 'a created entity');
      if ((await this.reads.valuesOf(entity, member(item, 'ref', 'a created entity'))) === null) {
        problems.push(`a created ${entity} is not there after the write`);
      }
    }
    for (const item of listOf(member(envelope, 'removed', 'the result'))) {
      const entity = text(item, 'entity', 'a removed entity');
      if ((await this.reads.valuesOf(entity, member(item, 'ref', 'a removed entity'))) !== null) {
        problems.push(`a removed ${entity} is still there after the write`);
      }
    }
    return { problems, unread: [...unread].sort() };
  }

  /** The parameters of a revert recipe: exactly as given; a consent member only where the recipe asks for consent. */
  private revertParams(recipe: Json): Json {
    const params = { ...(isObject(recipe.params) ? recipe.params : {}) };
    if (recipe.requiresConsent === true) {
      // A recipe never carries the end user's consent (PROTOCOL.md section 15.2 rule 4). This scenario
      // is a fixture: everything it deletes it created itself, so it may set the consent here.
      if (
        typeof recipe.method === 'string' &&
        (recipe.method === 'track.delete' || recipe.method === 'arrangement.edit')
      ) {
        params.confirm = true;
      }
    }
    return params;
  }

  /** Takes a write back by its undo or revert recipe; null when the result gives neither. */
  private async restore(step: string, envelope: Json): Promise<string | null> {
    const undo = isObject(envelope.undo) ? envelope.undo : null;
    if (undo === null) return null;
    if (undo.undoable === true) {
      const undoId = text(undo, 'undoId', 'the undo descriptor');
      const written = await this.call('undo', 'edit.undo', { expectedUndoId: undoId });
      const problems = schemaProblems(schemaPath('edit.undo', 'result'), written, 'edit.undo');
      if (problems.length > 0) throw new Error(problems.join('; '));
      return `edit.undo ${undoId}`;
    }
    const recipe = undo.revert;
    if (!isObject(recipe)) return null;
    const method = text(recipe, 'method', 'the revert recipe');
    const written = await this.call('revert', method, this.revertParams(recipe));
    // The revert is a call of a wave-B method too: its result must be valid and carry what the
    // specification promises for the state it puts back.
    const invalid = schemaProblems(schemaPath(method, 'result'), written, `${method} (revert)`);
    if (invalid.length > 0) throw new Error(invalid.join('; '));
    return `${method} (the revert recipe)`;
  }

  /** Runs one write of the tour: the call, the checks and the round trip that takes it back. */
  async write(spec: WriteSpec): Promise<WriteRun> {
    this.reads.clear();
    const before = spec.snapshot === undefined ? null : await this.reads.snapshot(spec.snapshot);
    const started = performance.now();
    const problems: string[] = [];
    let envelope: Json;
    try {
      const immediate = await this.call('write', spec.method, spec.params);
      problems.push(...schemaProblems(schemaPath(spec.method, 'result'), immediate, spec.method));
      envelope = immediate;
      if (spec.followJob === true) {
        const job = member(immediate, 'job', `${spec.method} result`);
        if (isObject(job)) envelope = await this.followJob(spec.step, spec.method, job);
        else problems.push(`${spec.method} did not hand the work to a job`);
        problems.push(...schemaProblems(schemaPath(spec.method, 'jobResult'), envelope, `${spec.method} job result`));
      }
    } catch (error) {
      if (!(error instanceof OtcpError)) throw error;
      // A refused write changes nothing: the step reports it and the later steps keep running.
      return {
        envelope: {},
        problems: [`${spec.method} failed with ${error.message}: ${error.data.detail}`],
        unread: [],
        unrestored: false,
        ms: performance.now() - started,
        restoredBy: null,
        failure: error.data,
      };
    }
    this.reads.clear();
    // A check that throws (a read that fails) is a problem of the step; the write is still taken back below.
    let checked: { problems: string[]; unread: string[] };
    try {
      checked = await this.checkEnvelope(spec.method, envelope, spec.expect);
    } catch (error) {
      checked = {
        problems: [
          `checking the result of ${spec.method} failed: ${clean(error instanceof Error ? error.message : String(error))}`,
        ],
        unread: [],
      };
    }
    problems.push(...checked.problems);
    const ms = performance.now() - started;

    let unrestored = false;
    let restoredBy: string | null = null;
    if (spec.restore !== 'none' && envelope.applied === true) {
      this.reads.clear();
      try {
        restoredBy = await this.restore(spec.step, envelope);
      } catch (error) {
        problems.push(`taking the write back failed: ${clean(error instanceof Error ? error.message : String(error))}`);
        unrestored = true;
      }
      if (restoredBy !== null && before !== null) {
        this.reads.clear();
        const after = await this.reads.snapshot(spec.snapshot ?? []);
        const found = differences(before, after);
        if (found.length > 0) {
          problems.push(`the read-back state after ${restoredBy} differs from before the write: ${found.join('; ')}`);
          unrestored = true;
        }
      }
    }
    this.reads.clear();
    return { envelope, problems, unread: checked.unread, unrestored, ms, restoredBy };
  }

  /** A write the step keeps applied; the state it leaves behind is compared by the caller. */
  async writeKept(spec: WriteSpec): Promise<WriteRun> {
    return this.write({ ...spec, restore: 'none' });
  }
}

// ---------------------------------------------------------------------------------------------
// the MCP tools

/** What one MCP tool call must show. */
export interface ToolExpect {
  /** The change can be neither undone nor restored: the first sentence must say so. */
  readonly irreversible?: boolean;
  /** The change has no undo entry: the first sentence must say so. */
  readonly notUndoable?: boolean;
  /** The change can be undone: the result must carry an undoId. */
  readonly undoable?: boolean;
  readonly warnings?: readonly string[];
  /** Selecting a clip says in its first sentence what it did besides selecting. */
  readonly selectionLead?: boolean;
}

export interface ToolSpec {
  readonly tool: string;
  readonly args: Json;
  /** The capabilities the representative call needs; a missing one is a SKIP with its name. */
  readonly capabilities: readonly string[];
  readonly expect?: ToolExpect;
  /** Reads the change back through OTCP; returns a problem, or null when the change is there. */
  readonly visible: (body: Json) => Promise<string | null>;
  /** Puts the change back through the tool or OTCP; a failure is a problem. */
  readonly restore?: (body: Json) => Promise<void>;
  /** The note of a PASS that is not the usual "the change is in a fresh read", or null. */
  readonly passNote?: () => string | null;
}

/** The first-sentence checks of a tool result: what cannot be undone, replaces or affects more than asked. */
export function toolTextProblems(body: Json, expect: ToolExpect | undefined): string[] {
  const problems: string[] = [];
  const summary = body.summary;
  if (typeof summary !== 'string' || summary === '') return ['the result has no summary'];
  const first = firstSentence(summary);
  const codes = codesOf(body);
  const undo = isObject(body.undo) ? body.undo : null;
  const effects = Object.keys(isObject(body.sideEffects) ? body.sideEffects : {});
  const removed = listOf(body.removed).length;
  if (expect?.irreversible === true) {
    if (!codes.includes('IRREVERSIBLE')) problems.push('no IRREVERSIBLE warning');
    if (!/cannot be undone|can(?:not|'t) be undone|irreversib/i.test(first)) {
      problems.push(`the first sentence does not say that it cannot be undone: ${first}`);
    }
  }
  if (expect?.notUndoable === true) {
    if (undo !== null && undo.undoable === true) problems.push('the result is undoable, but this call must not be');
    if (!/not undoable|cannot be undone|no undo entry/i.test(first)) {
      problems.push(`the first sentence does not say that it cannot be undone: ${first}`);
    }
  }
  if (expect?.undoable === true) {
    if (undo?.undoable !== true) problems.push('the result carries no undoId');
    else if (typeof undo.undoId !== 'string') problems.push('the result carries no undoId');
  }
  for (const code of expect?.warnings ?? []) {
    if (!codes.includes(code)) problems.push(`no ${code} warning (warnings: ${codes.join(', ') || 'none'})`);
  }
  if (expect?.selectionLead === true && body.noOp !== true) {
    if (effects.length > 0 || codes.includes('SELECTION_GENERATED_NOTES')) {
      if (!/nobody asked|ALSO|irreversib/i.test(first)) {
        problems.push(`the first sentence does not name the side effects: ${first}`);
      }
    } else if (!/no side effects beyond the selection/i.test(first)) {
      problems.push(`the first sentence does not say that selecting had no side effects: ${first}`);
    }
  }
  if (removed > 0 && !/removed|cannot be undone|not undoable/i.test(first)) {
    problems.push(`the first sentence does not say that something was removed: ${first}`);
  }
  return problems;
}

/** A tool result against the output schema its declaration in src/tools gives it. */
export function outputSchemaProblems(tool: string, body: Json): string[] {
  const definition = TOOLS.find((candidate) => candidate.name === tool);
  if (definition === undefined) return [`the tool registry has no ${tool}`];
  if (definition.outputSchema === undefined) return [];
  const parsed = definition.outputSchema.safeParse(body);
  return parsed.success ? [] : [`the structured result does not pass the output schema of ${tool}`];
}

// ---------------------------------------------------------------------------------------------
// the scenario

export interface WaveBTourHooks {
  /** For tests: starts the instance in place of startRealInstance. */
  readonly instance?: (options: RealInstanceOptions) => Promise<RealInstance>;
  /** For tests: wraps the session, so that a reply can be changed before the tour checks it. */
  readonly session?: (session: OtcpSession) => OtcpSession;
  /** For tests: starts the MCP server in place of the built bundle. */
  readonly mcp?: (env: Readonly<Record<string, string>>) => Promise<McpProcess>;
}

export interface WaveBTourReport extends ScenarioReport {
  /** What session.hello reported; null when the scenario never got that far. */
  readonly instance: { readonly protocol: string; readonly appVersion: string } | null;
  /** The capabilities the instance reported. */
  readonly capabilities: readonly string[];
  /** Every call of the tour with its latency (result reads of the checks are counted in the facts). */
  readonly calls: readonly TourCall[];
  /** Every MCP tool call of the tour with its latency. */
  readonly tools: readonly TourTool[];
  /** What could not be run, and why. */
  readonly skipped: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// helpers of the scenario

const visibleTracks = (project: Json): Json[] =>
  listOf(member(project, 'tracks', 'project.get')).filter((track) => track.visible === true);

const placementById = (project: Json, placementId: string): Json | undefined =>
  listOf(member(project, 'placements', 'project.get')).find((p) => p.placementId === placementId);

/** The revision of `contentId` in the asOf block of a read result. */
const revisionOf = (read: Json, contentId: string): string => {
  const asOf = member(read, 'asOf', 'the read');
  const entry = listOf(member(asOf, 'contents', 'asOf')).find((c) => c.contentId === contentId);
  if (entry === undefined) throw new Error('the read result carries no revision for the content');
  return text(entry, 'revision', 'the content tokens');
};

const arrangementOf = (project: Json): string =>
  text(member(project, 'asOf', 'project.get'), 'arrangementRevision', 'asOf');

const noteCountOf = (project: Json, contentId: string): number => {
  const summary = listOf(member(project, 'contents', 'project.get')).find((c) => c.contentId === contentId);
  return summary === undefined ? 0 : num(summary, 'noteCount', 'the content summary');
};

const isTrackLimit = (error: unknown): boolean =>
  error instanceof OtcpError && error.data.kind === 'INVALID_ARGUMENT' && error.data.reason === 'track_limit';

const isRevisionConflict = (error: unknown): boolean =>
  error instanceof OtcpError && error.data.kind === 'REVISION_CONFLICT';

/** A recipe may be refused for its token only when the arrangement has moved on from the revision it names. */
export const refusalIsDefect = (currentRevision: string, recipeRevision: unknown): boolean =>
  currentRevision === recipeRevision;

/**
 * The wait limit of a referenceAnalysis job. The protocol leaves the value to the implementation
 * (PROTOCOL.md section 12.6); the fork waits this long, as the mock does.
 */
export const REFERENCE_WAIT_LIMIT_MS = 30_000;

const KNOWN_STALLED_REASON = 'reference_analysis_stalled';

/**
 * Whether a failed content.autoTune (mode reference) is the known defect of the locked OpenTune: its
 * reference analysis service accepts only one task per session, and the fork reports every later
 * analysis as NOT_READY(reference_analysis_stalled) (PROTOCOL.md section 15.4 rule 8). Only that
 * error counts, and only when the job ended before the wait limit: one that ended at the limit, or
 * another error such as reference_analysis_timeout, is a failure of the step.
 */
export const isKnownStalledDefect = (failure: ErrorData | undefined, elapsedMs: number): boolean =>
  failure?.kind === 'NOT_READY' && failure.reason === KNOWN_STALLED_REASON && elapsedMs < REFERENCE_WAIT_LIMIT_MS;

/** A step that could not put the state back; the scenario stops after it. */
export class Unrestored extends Error {}

// ---------------------------------------------------------------------------------------------
// the tour

export async function runWaveBTour(config: SmokeConfig, hooks: WaveBTourHooks = {}): Promise<WaveBTourReport> {
  const scenario = new Scenario(SCENARIO_NAME);
  const timeoutMs = config.stepTimeoutMs;
  const startTimeoutMs = config.exe.timeoutMs ?? 60_000;
  const tools: TourTool[] = [];
  const skipped: string[] = [];
  let root = '';
  let discoveryDir = '';
  let dataDirParent = '';
  let toneFile = '';
  let instance: RealInstance | undefined;
  let session: OtcpSession | undefined;
  let mcp: McpProcess | undefined;
  let tour: Tour | undefined;
  let capabilities: readonly string[] = [];
  let protocol = '';
  let appVersion = '';
  let contentId = '';
  /** The clip that shows the imported content; a split and a merge give it a new placement id. */
  let clipId = '';
  /** The copy arrangement.copy made, and the revert recipe that removes it again. */
  let copyId = '';
  let copyContentId = '';
  let copyRevert: Json | null = null;
  let geometryBeforeCopy: Json | null = null;
  let stopReason: string | undefined;
  let stepName = 'setup';

  const need = (): OtcpSession => {
    if (session === undefined) throw new Error('no session');
    return session;
  };
  const theTour = (): Tour => {
    if (tour === undefined) throw new Error('no session');
    return tour;
  };
  const mcpProcess = (): McpProcess => {
    if (mcp === undefined) throw new Error('no MCP server');
    return mcp;
  };

  const step = (name: string, body: () => Promise<string>, options?: Parameters<Scenario['step']>[2]) => {
    stepName = name;
    return scenario.step(
      name,
      async () => {
        if (stopReason !== undefined && options?.always !== true) {
          throw new StepSkip('SKIP', `not run: ${stopReason}`);
        }
        // Each step starts from a fresh read: the MCP part changes the project from another session.
        tour?.reads.clear();
        return await body();
      },
      options,
    );
  };

  const requireCapabilities = (names: readonly string[]): void => {
    const missing = names.filter((name) => !capabilities.includes(name));
    if (missing.length > 0) throw new StepSkip('SKIP', `the instance does not report ${missing.join(', ')}`);
  };

  /** A step whose checks do not stop the tour: one deviation must not hide what the later checks show. */
  const checkStep = (name: string, body: () => Promise<string>) => step(name, body, { haltOnFail: false });

  /** Keeps the problems of one write; a state that did not come back stops the scenario. */
  const collect = (stepLabel: string, problems: string[], run: WriteRun): void => {
    problems.push(...run.problems);
    if (run.unrestored) {
      stopReason = `${stepLabel} could not put the state back`;
      throw new Unrestored(`${stepLabel}: ${run.problems.join('; ')}`);
    }
  };

  const finish = (stepLabel: string, problems: string[], note: string): string => {
    if (problems.length === 0) return note;
    const shown = problems.slice(0, MAX_LISTED).join('; ');
    const more = problems.length > MAX_LISTED ? ` (+${String(problems.length - MAX_LISTED)} more)` : '';
    throw new Error(`${stepLabel}: ${shown}${more}`);
  };

  const placementOfContent = (project: Json, wanted: string): Json | undefined =>
    listOf(member(project, 'placements', 'project.get')).find((p) => p.contentId === wanted);

  /** The number of undo steps now. */
  const undoCountOf = async (): Promise<number> => {
    const read = await theTour().call('read', 'edit.getHistory', {});
    return num(member(read, 'history', 'the edit.getHistory result'), 'undoCount', 'the history');
  };

  /**
   * The notes of a content and the undo stack now. The function it returns reads both again and lists
   * what changed: for a job that failed with the known defect and so had to leave the project as it was.
   */
  const captureState = async (contentId: string): Promise<() => Promise<string[]>> => {
    const t = theTour();
    const kind = `notes:${contentId}`;
    t.reads.clear();
    const notes = await t.reads.snapshot([kind]);
    const undoCount = await undoCountOf();
    return async () => {
      t.reads.clear();
      const found: string[] = [];
      const moved = differences(notes, await t.reads.snapshot([kind]));
      if (moved.length > 0) found.push(`the notes changed although the job failed: ${moved.join('; ')}`);
      const undoAfter = await undoCountOf();
      if (undoAfter !== undoCount) {
        found.push(`the undo stack went from ${String(undoCount)} to ${String(undoAfter)} steps`);
      }
      return found;
    };
  };

  /** Lists the defect in the report once, however many steps met it. */
  const recordKnownDefect = (name: string): void => {
    const listed = scenario.facts.knownUpstreamDefects;
    const names = typeof listed === 'object' && listed !== null ? listed : [];
    if (!names.includes(name)) scenario.facts.knownUpstreamDefects = [...names, name];
  };

  await step('prepare', async () => {
    root = await scratchDir(SCENARIO_NAME);
    discoveryDir = path.join(root, 'discovery');
    dataDirParent = path.join(root, 'data');
    await mkdir(discoveryDir, { recursive: true });
    await mkdir(dataDirParent, { recursive: true });
    const tone = generateTone({
      seed: 20260401,
      notes: [0, 2, 4, 5, 7].map((semitones) => ({ midi: 57 + semitones, cents: 30, durationSec: 1.1 })),
    });
    toneFile = path.join(root, 'wave-b-tone.wav');
    await writeFile(toneFile, tone.wav);
    scenario.facts.sourceSeconds = Number(tone.truth.durationSec.toFixed(3));
    scenario.facts.sourceNotes = tone.truth.notes.length;
    return `${tone.truth.durationSec.toFixed(1)} s of generated audio, own discovery and data folders`;
  });

  await step(
    'launch',
    async () => {
      const open = hooks.instance ?? startRealInstance;
      instance = await open({
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
      const opened = await OtcpSession.open(entry.entry, START_HELLO_TIMEOUT_MS);
      session = hooks.session === undefined ? opened : hooks.session(opened);
      capabilities = session.hello.capabilities;
      protocol = session.hello.protocol;
      appVersion = session.hello.appVersion;
      tour = new Tour(session, timeoutMs, () => stepName);
      requireCapabilities(REQUIRED_CAPABILITIES);
      return `protocol ${protocol}, OpenTune ${appVersion}, ${String(capabilities.length)} capabilities`;
    },
    { haltOnSkip: true },
  );

  await step(
    'ui.getState and ui.dismiss',
    async () => {
      requireCapabilities(['ui.bridge']);
      const problems: string[] = [];
      const state = await theTour().call('read', 'ui.getState', {});
      problems.push(...schemaProblems(schemaPath('ui.getState', 'result'), state, 'ui.getState'));
      const dialogs = listOf(member(state, 'dialogs', 'ui.getState'));
      const onboarding = member(state, 'onboarding', 'ui.getState');
      const showing = isObject(onboarding) && onboarding.showing === true;
      scenario.facts.openDialogs = dialogs.length;
      scenario.facts.onboarding = showing
        ? 'showing'
        : isObject(onboarding) && onboarding.shown === true
          ? 'shown'
          : 'notShown';
      if (dialogs.length > 0) {
        // Closing a dialog this scenario did not open could drop work the user is in the middle of.
        throw new StepSkip(
          'SKIP',
          `the instance has ${String(dialogs.length)} dialog(s) open that this scenario did not open; nothing is dismissed`,
        );
      }
      if (showing) {
        // The overlay blocks writes, and this run's own instance started it; closing it marks
        // onboardingShown, a preference no request resets (IRREVERSIBLE, confined to this run's
        // temporary data folder).
        requireCapabilities(['ui.onboardingClose']);
        const overlay = await theTour().write({
          step: 'ui.dismiss',
          method: 'ui.dismiss',
          params: { target: 'onboarding' },
          expect: {
            applied: true,
            undoable: false,
            undoReason: 'no_upstream_undo',
            revert: 'none',
            irreversible: true,
          },
        });
        collect('ui.dismiss (onboarding)', problems, overlay);
        scenario.facts.onboardingDismissed = true;
      }
      const dismissed = await theTour().write({
        step: 'ui.dismiss',
        method: 'ui.dismiss',
        params: { target: 'dialogs' },
        expect: {
          applied: true,
          noOp: true,
          undoable: false,
          undoReason: 'no_op',
          revert: 'none',
          absentWarnings: ['IRREVERSIBLE'],
        },
      });
      collect('ui.dismiss (dialogs)', problems, dismissed);
      return finish(
        'ui.getState and ui.dismiss',
        problems,
        showing
          ? 'the first-run overlay of this run was closed; no dialog was open to dismiss'
          : 'no dialog is open; ui.dismiss was a no-op',
      );
    },
    { haltOnSkip: true, haltOnFail: false },
  );

  await step(
    'import and analysis',
    async () => {
      requireCapabilities(['import.v1', 'jobs.v1', 'read.v1']);
      const s = need();
      const result = await runImport(s, toneFile, timeoutMs);
      const problems = schemaProblems(schemaPath('import.start', 'jobResult'), result, 'import.start job result');
      const item = listOf(member(result, 'items', 'the import result'))[0];
      if (item?.imported !== true) throw new Error('the file was not imported');
      contentId = text(item, 'contentId', 'the import item');
      clipId = text(item, 'placementId', 'the import item');
      scenario.facts.notesGeneratedBy = typeof item.notesGeneratedBy === 'string' ? item.notesGeneratedBy : null;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const details = await s.call('content.getDetails', { contentId }, READ_TIMEOUT_MS);
        const f0 = text(member(details, 'analysis', 'content details'), 'f0State', 'analysis');
        if (f0 === 'ready') break;
        if (f0 === 'failed') throw new Error('the pitch analysis failed');
        if (Date.now() >= deadline) throw new Error(`the pitch analysis was not ready within ${String(timeoutMs)} ms`);
        await sleep(500);
      }
      // The reference checks need notes on the clip; the import asked for them.
      const notesDeadline = Date.now() + 60_000;
      for (;;) {
        const count = noteCountOf(await tourOfProject(s), contentId);
        if (count > 0) break;
        if (Date.now() >= notesDeadline) {
          throw new Error('OpenTune generated no notes for the imported clip, which the reference checks need');
        }
        await sleep(500);
      }
      return finish('import and analysis', problems, 'imported with generated notes, pitch analysis ready');
    },
    { haltOnSkip: true },
  );

  await checkStep('ui.getState and ui.setSelection', async () => {
    requireCapabilities(['ui.bridge']);
    const problems: string[] = [];
    const t = theTour();
    const state = await t.call('read', 'ui.getState', {});
    problems.push(...schemaProblems(schemaPath('ui.getState', 'result'), state, 'ui.getState'));
    // A track first (no clip is selected by that), so that selecting the clip has a previous
    // selection to put back; the selection is view state and its undo reason is not_persisted_state.
    const trackSelection = await t.write({
      step: 'ui.setSelection (track)',
      method: 'ui.setSelection',
      params: { trackId: 0 },
      snapshot: ['selection'],
      // Kept: taking it back at once would select the clip again, and the clip selection that follows
      // would be a no-op (PROTOCOL.md: selecting what is already selected is a no-op).
      restore: 'none',
      expect: { applied: true, undoable: false, absentWarnings: ['IRREVERSIBLE'] },
    });
    collect('ui.setSelection (track)', problems, trackSelection);
    const clipSelection = await t.write({
      step: 'ui.setSelection (clip)',
      method: 'ui.setSelection',
      params: { placementId: clipId },
      snapshot: ['selection'],
      expect: {
        applied: true,
        noOp: false,
        undoable: false,
        undoReason: 'not_persisted_state',
        revert: 'present',
        absentWarnings: ['IRREVERSIBLE'],
      },
    });
    collect('ui.setSelection (clip)', problems, clipSelection);
    // The clip's revert put the track selection back; the selection this run found (the imported
    // clip) is put back by selecting the clip again.
    const putBack = await t.write({
      step: 'ui.setSelection (put the clip back)',
      method: 'ui.setSelection',
      params: { placementId: clipId },
      restore: 'none',
      expect: { applied: true, noOp: false, absentWarnings: ['IRREVERSIBLE'] },
    });
    collect('ui.setSelection (put the clip back)', problems, putBack);
    // The runner read the selection right after the write and compared the `after` values; by now
    // the previous selection is back. The result itself must name the clip.
    const change = listOf(member(clipSelection.envelope, 'changes', 'the result')).find(
      (entry) => entry.entity === 'selection',
    );
    const selected = isObject(change?.fields) ? change.fields.selectedPlacementIds : null;
    const after = isObject(selected) ? selected.after : null;
    if (!Array.isArray(after) || !after.includes(clipId)) {
      problems.push('the result does not report the selection of the clip');
    }
    return finish(
      'ui.getState and ui.setSelection',
      problems,
      `ui.getState read; a track and the clip were selected and the previous selection put back${
        clipSelection.restoredBy === null ? ' (there was none)' : ''
      }`,
    );
  });

  await checkStep('track.set, track.add, track.duplicate and track.delete', async () => {
    requireCapabilities(['tracks.v1']);
    const problems: string[] = [];
    const t = theTour();
    // The track of the imported clip: the first track is not always the one that holds it.
    const sourceTrack = Number(placementById(await t.reads.project(), clipId)?.trackId ?? 0);
    const muted = await t.write({
      step: 'track.set',
      method: 'track.set',
      params: { tracks: [{ trackId: sourceTrack, muted: true }] },
      snapshot: ['tracks'],
      expect: { applied: true, noOp: false, undoable: false, undoReason: 'ui_parity', revert: 'present' },
    });
    collect('track.set', problems, muted);

    let added = false;
    try {
      const add = await t.write({
        step: 'track.add',
        method: 'track.add',
        params: { count: 1 },
        expect: {
          applied: true,
          noOp: false,
          undoable: false,
          undoReason: 'not_persisted_state',
          revert: 'none',
          warnings: ['NOT_PERSISTED'],
        },
      });
      collect('track.add', problems, add);
      const count = member(add.envelope, 'visibleTrackCount', 'the track.add result');
      const fresh = Number(member(await t.reads.project(), 'visibleTrackCount', 'project.get'));
      if (Number(member(count, 'after', 'visibleTrackCount')) !== fresh) {
        problems.push('visibleTrackCount.after is not the one a fresh project read returns');
      }
      added = true;
    } catch (error) {
      if (!isTrackLimit(error)) throw error;
      skipped.push('track.add (the instance has no hidden track slot)');
      scenario.facts.trackAdd = 'track_limit';
    }

    // The duplicate creates a track of its own; its revert deletes it again, which drives track.delete
    // on a track this scenario created.
    const duplicate = await t.write({
      step: 'track.duplicate',
      method: 'track.duplicate',
      params: { trackId: sourceTrack, mode: 'clone' },
      snapshot: ['tracks', 'placements'],
      expect: { applied: true, noOp: false, undoable: false, undoReason: 'ui_parity', revert: 'consent' },
    });
    collect('track.duplicate', problems, duplicate);
    const recipe = isObject(duplicate.envelope.undo) ? duplicate.envelope.undo.revert : null;
    if (!isObject(recipe) || recipe.method !== 'track.delete') {
      problems.push('the revert of track.duplicate is not a track.delete call');
    }
    scenario.facts.duplicatedTrack = num(duplicate.envelope, 'newTrackId', 'the track.duplicate result');
    return finish(
      'track.set, track.add, track.duplicate and track.delete',
      problems,
      `track.set and ${added ? 'track.add ran' : 'track.add hit the track limit (skipped)'}; track.duplicate ran and ` +
        'its revert deleted the new track again (track.delete)',
    );
  });

  await checkStep('transport.get, transport.setTempo, transport.setLoop and transport.control', async () => {
    requireCapabilities(['transport.v1']);
    const problems: string[] = [];
    const t = theTour();
    const read = await t.call('read', 'transport.get', {});
    problems.push(...schemaProblems(schemaPath('transport.get', 'result'), read, 'transport.get'));
    const transport = objectMember(read, 'transport', 'transport.get');
    const before = {
      playing: transport.playing === true,
      positionTimelineSec: num(transport, 'positionTimelineSec', 'transport'),
      loopEnabled: transport.loopEnabled === true,
    };
    const bpmBefore = num(transport, 'bpm', 'transport');
    const device = transport.audioDeviceRunning === true;

    const wantedBpm = bpmBefore === 120 ? 121 : 120;
    const tempo = await t.write({
      step: 'transport.setTempo',
      method: 'transport.setTempo',
      params: { bpm: wantedBpm },
      snapshot: ['tempo'],
      expect: { applied: true, noOp: false, undoable: false, undoReason: 'ui_parity', revert: 'present' },
    });
    collect('transport.setTempo', problems, tempo);

    const loop = await t.write({
      step: 'transport.setLoop',
      method: 'transport.setLoop',
      params: { enabled: !before.loopEnabled },
      snapshot: ['loop'],
      expect: {
        applied: true,
        noOp: false,
        undoable: false,
        undoReason: 'not_persisted_state',
        revert: 'present',
        warnings: before.loopEnabled ? ['NOT_PERSISTED'] : ['NOT_PERSISTED', 'LOOP_NO_EFFECT_STANDALONE'],
        absentWarnings: before.loopEnabled ? ['LOOP_NO_EFFECT_STANDALONE'] : [],
      },
    });
    collect('transport.setLoop', problems, loop);

    // Nothing may be audible: every visible track is muted before the play and put back afterwards.
    const project = await t.reads.project();
    const tracks = visibleTracks(project);
    const tracksBefore = listOf(member(await t.reads.snapshot(['tracks']), 'tracks', 'the tracks snapshot'));
    // Playback starts only when the mute is in place: without tracks.v1, or when the mute was refused,
    // not applied or not visible in a fresh read, the play, stop and seek calls are not sent.
    const canMute = capabilities.includes('tracks.v1');
    let playable = tracks.length === 0;
    if (!canMute) {
      skipped.push('transport.control play (needs tracks.v1 to mute every track first)');
    } else if (tracks.length > 0) {
      const mutedAll = await t.writeKept({
        step: 'track.set (mute for playback)',
        method: 'track.set',
        params: { tracks: tracks.map((track) => ({ trackId: track.trackId, muted: true })) },
        expect: { applied: true, undoable: false, undoReason: 'ui_parity', revert: 'present' },
      });
      collect('track.set (mute)', problems, mutedAll);
      const allMuted = visibleTracks(await t.reads.project()).every((track) => track.muted === true);
      if (!allMuted) problems.push('a visible track is not muted before playback');
      if (mutedAll.problems.length === 0 && allMuted) playable = true;
      else problems.push('not every visible track is muted; playback is not started');
    }

    // Whatever fails between the seek and the stop, the transport is stopped and the mute put back.
    let started = false;
    let stopped = false;
    try {
      if (playable) {
        const seekTo = before.positionTimelineSec === 0 ? 0.5 : 0;
        const seek = await t.writeKept({
          step: 'transport.control (seek)',
          method: 'transport.control',
          params: { action: 'seek', positionTimelineSec: seekTo },
          expect: {
            applied: true,
            noOp: false,
            undoable: false,
            undoReason: 'not_persisted_state',
            revert: 'none',
            absentWarnings: ['IRREVERSIBLE', 'NO_AUDIO_DEVICE'],
          },
        });
        collect('transport.control (seek)', problems, seek);

        const play = await t.writeKept({
          step: 'transport.control (play)',
          method: 'transport.control',
          params: { action: 'play' },
          expect: {
            applied: true,
            noOp: false,
            undoable: false,
            undoReason: 'not_persisted_state',
            revert: 'none',
            absentWarnings: ['IRREVERSIBLE'],
            warnings: device ? [] : ['NO_AUDIO_DEVICE'],
          },
        });
        collect('transport.control (play)', problems, play);
        started = play.envelope.applied === true;
        if (member(await t.reads.transportState(), 'playing', 'transport') !== true) {
          problems.push('the transport does not play after action play');
        }

        const stop = await t.writeKept({
          step: 'transport.control (stop)',
          method: 'transport.control',
          params: { action: 'stop' },
          expect: { applied: true, noOp: false, undoable: false, undoReason: 'not_persisted_state', revert: 'none' },
        });
        collect('transport.control (stop)', problems, stop);
        stopped = true;

        const back = await t.writeKept({
          step: 'transport.control (seek back)',
          method: 'transport.control',
          params: { action: 'seek', positionTimelineSec: before.positionTimelineSec },
          expect: { applied: true, undoable: false, undoReason: 'not_persisted_state', revert: 'none' },
        });
        collect('transport.control (seek back)', problems, back);
      }
    } finally {
      if (started && !stopped) {
        try {
          await t.writeKept({
            step: 'transport.control (stop after a failure)',
            method: 'transport.control',
            params: { action: 'stop' },
            expect: { applied: true },
          });
        } catch {
          problems.push('the transport could not be stopped after a failure');
        }
      }
      if (canMute && tracks.length > 0) {
        const unmuted = await t.writeKept({
          step: 'track.set (restore the mute)',
          method: 'track.set',
          params: { tracks: tracksBefore.map((track) => ({ trackId: track.trackId, muted: track.muted === true })) },
          expect: { applied: true, undoable: false, undoReason: 'ui_parity', revert: 'present' },
        });
        collect('track.set (unmute)', problems, unmuted);
        const after = listOf(member(await t.reads.snapshot(['tracks']), 'tracks', 'the tracks snapshot'));
        const found = differences({ tracks: tracksBefore }, { tracks: after });
        if (found.length > 0) problems.push(`the tracks after the mute was put back differ: ${found.join('; ')}`);
      }
    }
    const now = pick(await t.reads.transportState(), ['playing', 'positionTimelineSec']);
    if (!sameValue(now, { playing: before.playing, positionTimelineSec: before.positionTimelineSec })) {
      problems.push('the transport was not left stopped at the position it had');
    }
    return finish(
      'transport.get, transport.setTempo, transport.setLoop and transport.control',
      problems,
      `tempo ${String(bpmBefore)} -> ${String(wantedBpm)} and back, loop toggled and back, ` +
        `${playable ? (tracks.length > 0 ? 'every track muted during' : 'no visible track to mute during') : 'playback not started during'} play${device ? '' : ' (no audio device)'}`,
    );
  });

  await checkStep('prefs.set', async () => {
    requireCapabilities(['prefs.write']);
    const problems: string[] = [];
    const t = theTour();
    const processing = member(await t.reads.prefs(), 'processing', 'prefs.get');
    const current = num(processing, 'tuningHz', 'the processing preferences');
    const wanted = current === 442 ? 441 : 442;
    const written = await t.write({
      step: 'prefs.set',
      method: 'prefs.set',
      params: { tuningHz: wanted },
      snapshot: ['processing'],
      expect: {
        applied: true,
        noOp: false,
        undoable: false,
        undoReason: 'ui_parity',
        revert: 'present',
        warnings: ['GLOBAL_PREFERENCE', 'NOT_RETROACTIVE'],
      },
    });
    collect('prefs.set', problems, written);
    const recipe = isObject(written.envelope.undo) ? written.envelope.undo.revert : null;
    if (!isObject(recipe) || !isObject(recipe.params) || recipe.params.tuningHz !== current) {
      problems.push('the revert recipe does not name the previous tuningHz');
    }
    const back = num(member(await t.reads.prefs(), 'processing', 'prefs.get'), 'tuningHz', 'the preferences');
    if (!sameNumber(back, current)) problems.push(`tuningHz is ${String(back)}, not back at ${String(current)}`);
    scenario.facts.preferencesTouched = 'tuningHz';
    return finish('prefs.set', problems, `tuningHz ${String(current)} -> ${String(wanted)} and back`);
  });

  await checkStep('audio.get and audio.set', async () => {
    requireCapabilities(['audio.device']);
    const t = theTour();
    const read = await t.call('read', 'audio.get', {});
    const problems = schemaProblems(schemaPath('audio.get', 'result'), read, 'audio.get');
    const device = objectMember(read, 'device', 'audio.get');
    const available = objectMember(read, 'available', 'audio.get');
    if (device.running !== true) {
      throw new StepSkip('SKIP', 'no audio device runs in the instance, so no audio setting can be changed');
    }
    // A buffer size or sample rate of the current device when it offers one, otherwise another output
    // device or device type (the maintainer agreed to that, provided the setup is put back). The whole
    // setup is read now and compared with the one read after the revert.
    const chosen = chooseAudioSwitch(device, available);
    if (chosen === null) {
      throw new StepSkip(
        'SKIP',
        'audio.get offers no other buffer size, sample rate, output device or device type than the current setup, so there is nothing to switch',
      );
    }
    const { field, value: wanted } = chosen;
    const startSetup = pick(device, DEVICE_MEMBERS);
    const startNote = `the setup at the start was ${JSON.stringify(startSetup)}; set it back by hand if it is not`;
    const previous = device[field];
    /** Sends the values read at the start once more and compares the read-back one by one. */
    const putBack = async (): Promise<boolean> => {
      const retry = Object.fromEntries(
        ['deviceType', 'outputDevice', 'sampleRateHz', 'bufferSizeFrame', 'outputChannelPair']
          .filter((name) => startSetup[name] !== undefined && startSetup[name] !== null)
          .map((name) => [name, startSetup[name]]),
      );
      try {
        await t.call('write', 'audio.set', retry);
        t.reads.clear();
        return (
          differences(startSetup, pick(objectMember(await t.reads.audio(), 'device', 'audio.get'), DEVICE_MEMBERS))
            .length === 0
        );
      } catch {
        return false;
      }
    };
    let written: WriteRun;
    try {
      written = await t.write({
        step: 'audio.set',
        method: 'audio.set',
        params: { [field]: wanted },
        snapshot: ['audio'],
        expect: {
          applied: true,
          noOp: false,
          undoable: false,
          undoReason: 'ui_parity',
          revert: 'present',
          warnings: ['GLOBAL_PREFERENCE'],
        },
      });
      collect('audio.set', problems, written);
    } catch (error) {
      if (error instanceof Unrestored) {
        // The runner could not take the change back, or read something else after the revert: send the
        // values of the start once more before the step stops, and say whether that put them back.
        const restoredAgain = await putBack();
        throw new Unrestored(
          `${error.message}; ${restoredAgain ? 'it was then set back with the start values' : 'it could not be set back with the start values either'}; ${startNote}`,
        );
      }
      throw error;
    }
    // The runner read the state right after the write and found the requested value there (the
    // `after` of the change); by now the revert recipe has put the previous value back.
    if (written.envelope.applied === true) {
      const changed = listOf(member(written.envelope, 'changes', 'the result')).some(
        (change) => isObject(change.fields) && field in change.fields,
      );
      if (!changed) problems.push(`the result names no ${field} change`);
    }
    // The setup as it is now, whatever happened above (a refused or failed switch included).
    const now = pick(objectMember(await t.reads.audio(), 'device', 'audio.get'), DEVICE_MEMBERS);
    const moved = differences(startSetup, now);
    if (moved.length > 0) {
      // Put it back with the values read at the start, so that the machine is left as it was found.
      const restored = await putBack();
      problems.push(
        `the audio setup differs from the one at the start (${moved.join('; ')}); ${restored ? 'it was set back with the start values' : 'it could not be set back'}; ${startNote}`,
      );
      if (!restored) stopReason = 'the audio setup could not be put back';
    }
    scenario.facts.audioSetting = field;
    scenario.facts.audioSwitched =
      field === 'outputDevice' || field === 'deviceType' ? 'another device' : 'another buffer size or sample rate';
    return finish(
      'audio.get and audio.set',
      problems,
      `${field} ${JSON.stringify(previous)} -> ${JSON.stringify(wanted)} and back; the setup read back equals the one at the start (${String(Object.keys(startSetup).length)} members compared)`,
    );
  });

  await checkStep('arrangement.edit: move, trim, gain and fade', async () => {
    requireCapabilities(['arrangement.v1', 'history.v1']);
    const problems: string[] = [];
    const t = theTour();
    const project = await t.reads.project();
    const clip = placementById(project, clipId);
    if (clip === undefined) throw new Error('the imported clip is not in the project');
    const start = num(clip, 'startTimelineSec', 'the clip');
    const end = num(clip, 'endTimelineSec', 'the clip');
    const empty = visibleTracks(project).find((track) => num(track, 'placementCount', 'the track') === 0);
    const ops: Json[] = [
      {
        op: 'move',
        placementId: clipId,
        startTimelineSec: start + 0.25,
        ...(empty === undefined ? {} : { toTrackId: empty.trackId }),
      },
      { op: 'trim', placementId: clipId, edge: 'end', toTimelineSec: end + 0.05 },
      // Deliberately far out of the range OpenTune accepts: the applied value must be the limited one
      // and the result must carry CLAMPED.
      { op: 'setGain', placementId: clipId, gainDb: 200 },
      { op: 'setFade', placementId: clipId, fadeInSec: 0.2, fadeOutSec: 0.3 },
    ];
    const written = await t.write({
      step: 'arrangement.edit (move, trim, gain, fade)',
      method: 'arrangement.edit',
      params: { expectedArrangementRevision: arrangementOf(project), ops },
      snapshot: ['geometry'],
      expect: { applied: true, noOp: false, undoable: true, revert: 'none', warnings: ['CLAMPED'] },
    });
    collect('arrangement.edit', problems, written);
    const applied = listOf(member(written.envelope, 'changes', 'the result'))
      .flatMap((change) => Object.entries(isObject(change.fields) ? change.fields : {}))
      .find(([name]) => name === 'gainDb');
    if (applied === undefined) problems.push('the result names no gainDb change for the clamped gain');
    else if (Number(isObject(applied[1]) ? applied[1].after : undefined) === 200) {
      problems.push('the out-of-range gain was applied unchanged');
    }
    return finish(
      'arrangement.edit: move, trim, gain and fade',
      problems,
      `4 ops as one undo step; the undo restored the clip${empty === undefined ? '' : ' on its new track'}`,
    );
  });

  await checkStep('arrangement.copy and arrangement.edit op setReference', async () => {
    requireCapabilities(['arrangement.v1', 'history.v1']);
    const problems: string[] = [];
    const t = theTour();
    const project = await t.reads.project();
    geometryBeforeCopy = await t.reads.snapshot(['geometry']);
    const clip = placementById(project, clipId);
    if (clip === undefined) throw new Error('the imported clip is not in the project');
    const trackId = num(clip, 'trackId', 'the clip');
    const target =
      visibleTracks(project).find(
        (track) => track.trackId !== trackId && num(track, 'placementCount', 'the track') === 0,
      ) ?? visibleTracks(project).find((track) => track.trackId !== trackId);
    if (target === undefined) throw new StepSkip('SKIP', 'the project has no second visible track to copy the clip to');
    const copied = await t.writeKept({
      step: 'arrangement.copy',
      method: 'arrangement.copy',
      params: {
        sources: [{ placementId: clipId }],
        mode: 'window',
        toTrackId: target.trackId,
        startTimelineSec: num(clip, 'startTimelineSec', 'the clip') + 0.5,
        expectedArrangementRevision: arrangementOf(project),
      },
      expect: { applied: true, noOp: false, undoable: false, undoReason: 'ui_parity', revert: 'consent' },
    });
    collect('arrangement.copy', problems, copied);
    const copyUndo = isObject(copied.envelope.undo) ? copied.envelope.undo.revert : null;
    copyRevert = isObject(copyUndo) ? copyUndo : null;
    if (copyRevert === null) problems.push('arrangement.copy gives no revert recipe');
    const created = listOf(member(copied.envelope, 'created', 'the result')).find(
      (item) => item.entity === 'placement',
    );
    if (created === undefined) throw new Error('the copy created no clip');
    copyId = text(member(created, 'ref', 'the created clip'), 'placementId', 'the created clip');
    copyContentId = text(placementById(await t.reads.project(), copyId), 'contentId', 'the copied clip');

    const bindParams = async (): Promise<Json> => ({
      expectedArrangementRevision: arrangementOf(await t.reads.project()),
      ops: [{ op: 'setReference', placementId: copyId, referencePlacementId: clipId }],
    });
    const bound = await t.write({
      step: 'arrangement.edit (setReference)',
      method: 'arrangement.edit',
      params: await bindParams(),
      snapshot: ['placements'],
      expect: { applied: true, noOp: false, undoable: true, revert: 'none', warnings: ['EXPERIMENTAL_FEATURE'] },
    });
    collect('arrangement.edit (setReference)', problems, bound);
    // The round trip above took the binding back; bind it again for the reference checks of the next step.
    const rebound = await t.writeKept({
      step: 'arrangement.edit (setReference again)',
      method: 'arrangement.edit',
      params: await bindParams(),
      expect: { applied: true, noOp: false, undoable: true, revert: 'none', warnings: ['EXPERIMENTAL_FEATURE'] },
    });
    collect('arrangement.edit (setReference again)', problems, rebound);
    const fresh = placementById(await t.reads.project(), copyId);
    if (fresh?.referencePlacementId !== clipId) {
      problems.push('the reference binding is not in a fresh project read');
    }
    return finish(
      'arrangement.copy and arrangement.edit op setReference',
      problems,
      'the copy shows the source content; the binding was taken back and set again',
    );
  });

  await checkStep('content.analyzeReference and content.autoTune in mode reference', async () => {
    requireCapabilities(['reference.v1', 'edit.v1', 'history.v1']);
    const problems: string[] = [];
    const t = theTour();
    const analysisStarted = performance.now();
    const started = await t.call('write', 'content.analyzeReference', { placementId: copyId });
    problems.push(
      ...schemaProblems(schemaPath('content.analyzeReference', 'result'), started, 'content.analyzeReference'),
    );
    const job = member(started, 'job', 'the content.analyzeReference result');
    if (!isObject(job)) throw new Error('content.analyzeReference handed over no job');
    // The same rule as for content.autoTune below: only the stalled error that came before the wait
    // limit is the known defect; any other failure of the job fails the step.
    let analysisStalled = false;
    try {
      const analysis = await t.followJob('content.analyzeReference', 'reference analysis', job);
      problems.push(
        ...schemaProblems(schemaPath('content.analyzeReference', 'jobResult'), analysis, 'the reference analysis job'),
      );
      if (analysis.placementId !== copyId || analysis.referencePlacementId !== clipId) {
        problems.push('the job result names another binding than the one asked for');
      }
      if (analysis.alignmentReady !== true) problems.push('the alignment data is not ready after the job');
    } catch (error) {
      if (!(error instanceof OtcpError) || !isKnownStalledDefect(error.data, performance.now() - analysisStarted)) {
        throw error;
      }
      analysisStalled = true;
    }
    const details = await t.reads.details(copyContentId);
    const alignmentReady =
      member(member(details, 'reference', 'content details'), 'alignmentReady', 'reference') === true;
    if (analysisStalled) {
      // The job wrote nothing, so the alignment data is still missing; that it is missing is the defect.
      if (alignmentReady) problems.push('content.getDetails reports alignment data although the analysis was stalled');
    } else if (!alignmentReady) {
      problems.push('content.getDetails does not report the alignment data of the copy');
    }

    const unchanged = await captureState(copyContentId);
    const tuned = await t.write({
      step: 'content.autoTune (reference)',
      method: 'content.autoTune',
      params: {
        contentId: copyContentId,
        mode: 'reference',
        placementId: copyId,
        expectedRevision: revisionOf(details, copyContentId),
      },
      followJob: true,
      snapshot: [`notes:${copyContentId}`],
      expect: { applied: true, absentWarnings: ['IRREVERSIBLE', 'REPLACES_ALL_NOTES'] },
    });
    if (isKnownStalledDefect(tuned.failure, tuned.ms)) {
      // The defect is OpenTune's and the protocol does not hide it: the step passes only if the error
      // is exactly that one, it came at once, and the failed job left the project as it was.
      problems.push(...(await unchanged()));
      if (problems.length === 0) recordKnownDefect(KNOWN_STALLED_REASON);
      return finish(
        'content.analyzeReference and content.autoTune in mode reference',
        problems,
        'known upstream defect: OpenTune completes only one reference analysis per session, reported as NOT_READY(reference_analysis_stalled); nothing changed' +
          (analysisStalled ? ' (by content.analyzeReference and by content.autoTune)' : ' (by content.autoTune)'),
      );
    }
    collect('content.autoTune (reference)', problems, tuned);
    if (tuned.envelope.noOp !== true) {
      const undo = isObject(tuned.envelope.undo) ? tuned.envelope.undo : null;
      if (undo?.undoable !== true) problems.push('mode reference did not commit one undo step');
    }
    // The analysis was stalled but the alignment still ran: the defect is listed only when nothing else
    // is wrong, so that a failing step does not put it in the report.
    const stalledNote = analysisStalled && problems.length === 0;
    if (stalledNote) recordKnownDefect(KNOWN_STALLED_REASON);
    return finish(
      'content.analyzeReference and content.autoTune in mode reference',
      problems,
      (stalledNote
        ? 'known upstream defect: OpenTune completes only one reference analysis per session, reported as NOT_READY(reference_analysis_stalled) by content.analyzeReference; the alignment still ran; '
        : '') +
        (tuned.envelope.noOp === true
          ? 'the alignment data was computed; the notes already followed the reference'
          : 'the alignment data was computed and the notes were aligned in one undo step'),
    );
  });

  await checkStep('the wave-B MCP tools', async () => {
    const problems: string[] = [];
    const t = theTour();
    mcp = await (hooks.mcp ?? startMcp)({ OPENTUNE_MCP_DISCOVERY_DIR: discoveryDir });

    /** Carries out the tool call a revert line in a result names, if it names one. */
    const restoreFromLine = async (body: Json): Promise<void> => {
      const lines = Array.isArray(body.lines) ? body.lines.filter(isObject) : [];
      const line = lines.find((entry) => entry.kind === 'revert' && isObject(entry.restore));
      if (line === undefined || !isObject(line.restore)) return;
      const tool = text(line.restore, 'tool', 'the restore call');
      const args = member(line.restore, 'arguments', 'the restore call');
      await mcpProcess().call(tool, isObject(args) ? args : {});
    };
    // The undo of the two undoable tool results needs history.v1; without it the change stays.
    const canUndo = capabilities.includes('history.v1');
    const undoFromBody = async (body: Json): Promise<void> => {
      const undo = isObject(body.undo) ? body.undo : null;
      const undoId = undo === null ? null : undo.undoId;
      if (!canUndo || typeof undoId !== 'string') return;
      await mcpProcess().call('opentune_undo', { undo_id: undoId });
    };

    const runTool = async (spec: ToolSpec): Promise<void> => {
      const missing = spec.capabilities.filter((capability) => !capabilities.includes(capability));
      if (missing.length > 0) {
        skipped.push(`${spec.tool} (needs ${missing.join(', ')})`);
        tools.push({
          tool: spec.tool,
          ms: 0,
          outcome: 'skip',
          note: `the instance does not report ${missing.join(', ')}`,
        });
        return;
      }
      const started = performance.now();
      let outcome: ToolOutcome;
      try {
        outcome = await mcpProcess().call(spec.tool, spec.args);
      } catch (error) {
        const note = clean(error instanceof Error ? error.message : String(error));
        tools.push({ tool: spec.tool, ms: Math.round(performance.now() - started), outcome: 'error', note });
        problems.push(`${spec.tool}: ${note}`);
        return;
      }
      const ms = Math.round(performance.now() - started);
      const found: string[] = [];
      if (outcome.isError) {
        found.push(`answered with an error: ${JSON.stringify(outcome.body).slice(0, 300)}`);
      } else {
        found.push(...outputSchemaProblems(spec.tool, outcome.body));
        found.push(...toolTextProblems(outcome.body, spec.expect));
        t.reads.clear();
        const shown = await spec
          .visible(outcome.body)
          .catch((error: unknown) => clean(error instanceof Error ? error.message : String(error)));
        if (shown !== null) found.push(shown);
        if (found.length === 0 && spec.restore !== undefined) {
          try {
            await spec.restore(outcome.body);
          } catch (error) {
            found.push(`putting it back failed: ${clean(error instanceof Error ? error.message : String(error))}`);
          }
        }
      }
      tools.push({
        tool: spec.tool,
        ms,
        outcome: found.length === 0 ? 'ok' : 'error',
        note:
          found.length === 0 ? (spec.passNote?.() ?? 'the change is in a fresh read') : found.slice(0, 4).join('; '),
      });
      problems.push(...found.map((problem) => `${spec.tool}: ${problem}`));
    };

    // opentune_set_tracks: duplicate a track of this scenario, and opentune_delete_track the copy.
    const made: { trackId: number | null; clips: string[] } = { trackId: null, clips: [] };
    const sourceTrack = Number(placementById(await t.reads.project(), clipId)?.trackId ?? 0);
    await runTool({
      tool: 'opentune_set_tracks',
      args: { ops: [{ op: 'duplicate', track_id: sourceTrack, mode: 'clone' }] },
      capabilities: ['tracks.v1'],
      expect: { notUndoable: true },
      visible: async (body) => {
        const trackId = typeof body.newTrackId === 'number' ? body.newTrackId : null;
        if (trackId === null) return 'the result names no new track';
        made.trackId = trackId;
        const fresh = await t.reads.project();
        const track = listOf(member(fresh, 'tracks', 'project.get')).find((entry) => entry.trackId === trackId);
        if (track === undefined) return 'the duplicated track is not in a fresh project read';
        const clips = listOf(member(fresh, 'placements', 'project.get')).filter((p) => p.trackId === trackId);
        made.clips = clips.flatMap((p) => (typeof p.placementId === 'string' ? [p.placementId] : []));
        return clips.length === 0 ? 'the duplicated track holds no clip in a fresh project read' : null;
      },
    });
    if (made.trackId === null) {
      skipped.push('opentune_delete_track (the duplicate created no track)');
      tools.push({
        tool: 'opentune_delete_track',
        ms: 0,
        outcome: 'skip',
        note: 'no track of this scenario to delete',
      });
    } else {
      const trackId = made.trackId;
      const copiedClips = [...made.clips];
      const read = await mcpProcess().call('opentune_get_project');
      const revision = typeof read.body.arrangement_revision === 'string' ? read.body.arrangement_revision : null;
      if (revision === null) problems.push('opentune_delete_track: opentune_get_project gave no arrangement_revision');
      else {
        await runTool({
          tool: 'opentune_delete_track',
          args: { track_id: trackId, expected_revision: revision, confirm: true },
          capabilities: ['tracks.v1'],
          expect: { irreversible: true },
          visible: async () => {
            // The tracks after the deleted one move down, so a track id is not a proof: the clips of
            // the duplicated track must be gone.
            const fresh = await t.reads.project();
            const still = listOf(member(fresh, 'placements', 'project.get')).filter((p) =>
              copiedClips.includes(String(p.placementId)),
            );
            return still.length > 0 ? 'a clip of the deleted track is still in a fresh project read' : null;
          },
        });
      }
    }

    // opentune_transport: the loop flag, and the revert line the result gives.
    const transport = await t.reads.transportState();
    const loopBefore = transport.loopEnabled === true;
    await runTool({
      tool: 'opentune_transport',
      args: { loop: !loopBefore },
      capabilities: ['transport.v1'],
      expect: {
        notUndoable: true,
        warnings: loopBefore ? [] : ['LOOP_NO_EFFECT_STANDALONE'],
      },
      visible: async () => {
        const now = await t.reads.transportState();
        return now.loopEnabled === !loopBefore ? null : 'the loop flag is not the requested one in a fresh read';
      },
      restore: restoreFromLine,
    });

    // opentune_manage_ui: select the clip this scenario imported.
    await runTool({
      tool: 'opentune_manage_ui',
      args: { op: 'focus_clip', clip: clipId },
      capabilities: ['ui.bridge'],
      expect: { selectionLead: true },
      visible: async () => {
        const ui = await t.reads.uiState();
        const selected = Array.isArray(ui.selectedPlacementIds) ? ui.selectedPlacementIds : [];
        return selected.includes(clipId) ? null : 'the clip is not selected in a fresh ui.getState';
      },
      restore: restoreFromLine,
    });

    // opentune_set_settings: a processing preference, put back through the revert line.
    const processing = member(await t.reads.prefs(), 'processing', 'prefs.get');
    const tuningBefore = num(processing, 'tuningHz', 'the processing preferences');
    const tuningWanted = tuningBefore === 442 ? 441 : 442;
    await runTool({
      tool: 'opentune_set_settings',
      args: { processing: { tuning_hz: tuningWanted } },
      capabilities: ['prefs.write'],
      expect: { notUndoable: true, warnings: ['GLOBAL_PREFERENCE', 'NOT_RETROACTIVE'] },
      visible: async () => {
        const now = num(member(await t.reads.prefs(), 'processing', 'prefs.get'), 'tuningHz', 'the preferences');
        return sameNumber(now, tuningWanted) ? null : 'tuningHz is not the requested one in a fresh read';
      },
      restore: restoreFromLine,
    });

    // opentune_edit_arrangement: one gain op on the clip, undone through opentune_undo.
    const projectRead = await mcpProcess().call('opentune_get_project');
    const arrangement =
      typeof projectRead.body.arrangement_revision === 'string' ? projectRead.body.arrangement_revision : null;
    if (arrangement === null)
      problems.push('opentune_edit_arrangement: opentune_get_project gave no arrangement_revision');
    else {
      await runTool({
        tool: 'opentune_edit_arrangement',
        args: { expected_revision: arrangement, ops: [{ op: 'gain', clip: clipId, gain_db: -2 }] },
        capabilities: ['arrangement.v1'],
        expect: { undoable: true },
        visible: async () => {
          const fresh = placementById(await t.reads.project(), clipId);
          const gain = fresh === undefined ? null : fresh.gainDb;
          return typeof gain === 'number' && Math.abs(gain + 2) < 0.01
            ? null
            : `the clip gain is ${JSON.stringify(gain)}, not -2 dB`;
        },
        restore: undoFromBody,
      });
    }

    // opentune_autotune_range in mode reference: the result may hand the work to a job (the method
    // does); the job's result is followed and the change is confirmed by a fresh read.
    const copyRead = await mcpProcess().call('opentune_get_project');
    const copyClip = listOf(copyRead.body.placements).find((p) => p.placementId === copyId);
    const copyRevision = copyClip === undefined ? null : copyClip.clip_revision;
    if (typeof copyRevision !== 'string') problems.push('opentune_autotune_range: the copy has no clip_revision');
    else {
      const before = revisionOf(await t.reads.details(copyContentId), copyContentId);
      const unchanged = await captureState(copyContentId);
      let undoId: string | null = null;
      let knownDefect = false;
      // The clock of the wait starts before the tool call, not inside the check that follows it: the
      // job runs while the tool call is answered, so a clock that starts later measures less than
      // the wait really was, and a stalled error that came at the wait limit would pass as a known
      // defect.
      const toolStarted = performance.now();
      await runTool({
        tool: 'opentune_autotune_range',
        args: { clip: copyId, expected_revision: copyRevision, mode: 'reference' },
        capabilities: ['edit.v1', 'reference.v1'],
        passNote: () =>
          knownDefect
            ? 'known upstream defect: OpenTune completes only one reference analysis per session, reported as NOT_READY(reference_analysis_stalled); nothing changed'
            : null,
        visible: async (body) => {
          let envelope = body;
          if (isObject(body.job)) {
            try {
              envelope = await t.followJob('opentune_autotune_range', 'reference alignment', body.job);
            } catch (error) {
              // The same rule as for content.autoTune: only the stalled error that came before the wait
              // limit, with the project left as it was, is the known defect; anything else is a problem.
              if (!(error instanceof OtcpError) || !isKnownStalledDefect(error.data, performance.now() - toolStarted)) {
                throw error;
              }
              const moved = await unchanged();
              if (moved.length > 0) return moved.join('; ');
              knownDefect = true;
              recordKnownDefect(KNOWN_STALLED_REASON);
              return null;
            }
            t.reads.clear();
          }
          const undo = isObject(envelope.undo) ? envelope.undo : null;
          if (typeof undo?.undoId === 'string') undoId = undo.undoId;
          const now = revisionOf(await t.reads.details(copyContentId), copyContentId);
          if (envelope.noOp === true) return now === before ? null : 'the result says noOp but the clip changed';
          return now === before ? 'the clip did not change after the tool reported a change' : null;
        },
        restore: async () => {
          if (!canUndo || undoId === null) return;
          await mcpProcess().call('opentune_undo', { undo_id: undoId });
        },
      });
    }
    const checked = tools.filter((entry) => entry.outcome !== 'skip').length;
    return finish(
      'the wave-B MCP tools',
      problems,
      `${String(checked)} of 7 tools called; the change of each is visible in a fresh OTCP read`,
    );
  });

  await checkStep('arrangement.edit: split, the merge that takes it back, and delete', async () => {
    requireCapabilities(['arrangement.v1']);
    const problems: string[] = [];
    const t = theTour();

    // The copy of the earlier step is taken back first, while the clips are as expected.
    if (isObject(copyRevert)) {
      const method = text(copyRevert, 'method', 'the revert recipe');
      const params = { ...(isObject(copyRevert.params) ? copyRevert.params : {}) };
      const asGiven = { ...params };
      if (copyRevert.requiresConsent === true) asGiven.confirm = true;
      let stale = false;
      let cleanedWithCurrentRevision = false;
      try {
        const applied = await t.call('revert', method, asGiven);
        problems.push(...schemaProblems(schemaPath(method, 'result'), applied, 'the revert of arrangement.copy'));
        const codes = codesOf(applied);
        if (!codes.includes('IRREVERSIBLE') || !codes.includes('UPSTREAM_UNDO_DEFECT')) {
          problems.push(`the revert of the copy lacks IRREVERSIBLE or UPSTREAM_UNDO_DEFECT (${codes.join(', ')})`);
        }
      } catch (error) {
        if (!isRevisionConflict(error)) throw error;
        // The recipe carries the tokens of the state right after the copy (PROTOCOL.md section 15.2
        // rule 3), so it refuses to overwrite later writes: that is the promise. Refusing while the
        // arrangement is still the one the recipe names would be a defect of the recipe.
        stale = true;
      }
      if (stale) {
        // The MCP part changed the project from another session: read the revision fresh.
        t.reads.clear();
        const current = arrangementOf(await t.reads.project());
        if (refusalIsDefect(current, params.expectedArrangementRevision)) {
          problems.push(
            'the revert recipe of the copy was refused with REVISION_CONFLICT although the arrangement still has the revision it names',
          );
        }
        // Only the clean-up of the scenario's own clip: the recipe was refused as given, so this call
        // is not counted as a successful round trip of the recipe.
        cleanedWithCurrentRevision = true;
        try {
          const removed = await t.call('revert', method, {
            ...params,
            expectedArrangementRevision: current,
            ...(copyRevert.requiresConsent === true ? { confirm: true } : {}),
          });
          problems.push(...schemaProblems(schemaPath(method, 'result'), removed, 'the revert of arrangement.copy'));
          const codes = codesOf(removed);
          if (!codes.includes('IRREVERSIBLE') || !codes.includes('UPSTREAM_UNDO_DEFECT')) {
            problems.push(`the revert of the copy lacks IRREVERSIBLE or UPSTREAM_UNDO_DEFECT (${codes.join(', ')})`);
          }
        } catch (error) {
          stopReason = 'the copy could not be taken back';
          throw new Unrestored(
            `the revert of arrangement.copy failed with the current revision: ` +
              `${clean(error instanceof Error ? error.message : String(error))}; ops ` +
              JSON.stringify(params.ops ?? null),
          );
        }
        t.reads.clear();
      }
      scenario.facts.copyRevert = cleanedWithCurrentRevision
        ? 'refused as given by its token guard; the clip was removed by a clean-up call with the current revision'
        : 'accepted as given';
      if (placementById(await t.reads.project(), copyId) !== undefined) problems.push('the copy is still there');
      const restored = await t.reads.snapshot(['geometry']);
      const found = differences(geometryBeforeCopy ?? {}, restored);
      if (found.length > 0) problems.push(`the clips after the copy was taken back differ: ${found.join('; ')}`);
    } else {
      problems.push('arrangement.copy gave no revert recipe to carry out');
    }

    // A merge makes new clip and content ids (idMap relation merge), so the clip to delete is found by
    // the merged clip's id, not by the content the import made.
    let doomedClipId = clipId;
    // split: OpenTune cannot undo it, and the result says so; its revert merges the clips again.
    const project = await t.reads.project();
    const clip = placementOfContent(project, contentId);
    if (clip === undefined) throw new Error('the clip of the imported content is not in the project');
    clipId = text(clip, 'placementId', 'the clip');
    const at = num(clip, 'startTimelineSec', 'the clip') + num(clip, 'durationSec', 'the clip') / 2;
    const beforeSplit = await t.reads.snapshot(['geometry']);
    const split = await t.write({
      step: 'arrangement.edit (split)',
      method: 'arrangement.edit',
      params: {
        expectedArrangementRevision: arrangementOf(project),
        ops: [{ op: 'split', placementId: clipId, atTimelineSec: at }],
      },
      restore: 'none',
      expect: {
        applied: true,
        noOp: false,
        undoable: false,
        undoReason: 'upstream_undo_defect',
        revert: 'present',
        warnings: ['UPSTREAM_UNDO_DEFECT'],
      },
    });
    collect('arrangement.edit (split)', problems, split);
    const splitRevert = isObject(split.envelope.undo) ? split.envelope.undo.revert : null;
    if (!isObject(splitRevert)) {
      problems.push('the split gives no revert recipe');
    } else {
      const ops = isObject(splitRevert.params) ? splitRevert.params.ops : undefined;
      const first = Array.isArray(ops) && isObject(ops[0]) ? ops[0] : undefined;
      if (first?.op !== 'merge') problems.push('the revert of the split is not a merge call');
      else if (!isObject(splitRevert.params)) problems.push('the revert of the split carries no params');
      else {
        const merged = await t.write({
          step: 'arrangement.edit (merge, the revert of the split)',
          method: 'arrangement.edit',
          params: { ...splitRevert.params },
          restore: 'none',
          expect: {
            applied: true,
            noOp: false,
            undoable: false,
            undoReason: 'upstream_undo_defect',
            revert: 'present',
            warnings: ['UPSTREAM_UNDO_DEFECT'],
          },
        });
        collect('arrangement.edit (merge)', problems, merged);
        const joined = listOf(member(merged.envelope, 'created', 'the result')).find(
          (item) => item.entity === 'placement',
        );
        if (isObject(joined?.ref) && typeof joined.ref.placementId === 'string') doomedClipId = joined.ref.placementId;
        else problems.push('the merge result lists no created placement');
        // A merge replaces the two clips by one clip of a new content (idMap relation merge, created
        // lists it), so the content id is the one member that cannot be the same as before the split.
        const withoutContentIds = (snapshot: Json): Json => ({
          geometry: listOf(member(snapshot, 'geometry', 'the geometry snapshot')).map((entry) => {
            const rest: Json = { ...entry };
            delete rest.contentId;
            return rest;
          }),
        });
        const restored = await t.reads.snapshot(['geometry']);
        const found = differences(withoutContentIds(beforeSplit), withoutContentIds(restored));
        if (found.length > 0)
          problems.push(`the clips after the merge differ from before the split: ${found.join('; ')}`);
      }
    }

    // delete: only a clip this scenario created, with the consent the scenario sets itself.
    const fresh = await t.reads.project();
    const doomed = placementById(fresh, doomedClipId);
    if (doomed === undefined) throw new Error('the clip to delete is not in the project before the delete');
    const doomedId = text(doomed, 'placementId', 'the clip');
    const doomedContentId = text(doomed, 'contentId', 'the clip');
    const removed = await t.write({
      step: 'arrangement.edit (delete)',
      method: 'arrangement.edit',
      params: {
        expectedArrangementRevision: arrangementOf(fresh),
        ops: [{ op: 'delete', placementIds: [doomedId] }],
        confirm: true,
      },
      expect: {
        applied: true,
        noOp: false,
        undoable: false,
        undoReason: 'upstream_undo_defect',
        revert: 'none',
        irreversible: true,
        warnings: ['UPSTREAM_UNDO_DEFECT', 'IRREVERSIBLE'],
      },
    });
    collect('arrangement.edit (delete)', problems, removed);
    if (placementById(await t.reads.project(), doomedId) !== undefined) {
      problems.push('the deleted clip is still in a fresh project read');
    }
    const listed = listOf(member(removed.envelope, 'removed', 'the result'));
    if (
      !listed.some((item) => item.entity === 'content' && isObject(item.ref) && item.ref.contentId === doomedContentId)
    ) {
      problems.push('the removed content is not listed in removed');
    }
    return finish(
      'arrangement.edit: split, the merge that takes it back, and delete',
      problems,
      'the copy was removed (the recipe refused to run against later writes, as promised, or ran as given: see facts.copyRevert); the split was taken back by its merge recipe; the clip was deleted',
    );
  });

  await step(
    'shutdown',
    async () => {
      session?.close();
      const notes: string[] = [];
      await mcp?.stop().catch(() => undefined);
      if (instance !== undefined) {
        try {
          await instance.end();
        } catch (error) {
          notes.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (discoveryDir !== '') {
        const ended = await endAllConfirmed(discoveryDir);
        notes.push(...ended.notes);
      }
      notes.push(...(await instanceSettingsProblems([instance])));
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
        : 'the instance this run started is ended, scratch folder removed';
    },
    { always: true },
  );

  scenario.facts.readCalls = tour?.reads.stats.calls ?? 0;
  scenario.facts.readMs = Math.round(tour?.reads.stats.ms ?? 0);
  scenario.facts.callCount = tour?.calls.length ?? 0;
  scenario.facts.mcpToolCalls = tools.filter((entry) => entry.outcome !== 'skip').length;
  scenario.manualChecks.push(
    'LISTEN: the tour mutes every track before it plays and unmutes them again; a person can check in the OpenTune ' +
      'window that nothing was heard and that no track was left muted.',
  );
  const report = scenario.report();
  return {
    ...report,
    instance: protocol === '' ? null : { protocol, appVersion },
    capabilities: [...capabilities],
    calls: tour?.calls ?? [],
    tools,
    skipped,
  };
}

/** session.call of one read, for the polling loops that must not read a cached value. */
function tourOfProject(session: OtcpSession): Promise<Json> {
  return session.call('project.get', {}, READ_TIMEOUT_MS);
}

/** Starts the import job and follows it; the job result is the import's own result shape. */
async function runImport(session: OtcpSession, file: string, timeoutMs: number): Promise<Json> {
  const started = await session.call(
    'import.start',
    { items: [{ path: file }], layout: 'single', generateNotes: true, focus: false },
    60_000,
  );
  const job = member(started, 'job', 'the import result');
  if (!isObject(job)) throw new Error('import.start handed over no job');
  const result = await waitJob(session, text(job, 'jobId', 'the import job'), 'import', timeoutMs);
  if (!isObject(result)) throw new Error('the import job ended without a result object');
  return result;
}
