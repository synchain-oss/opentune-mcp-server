// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// import.start and the import job of the mock (see methods/import.start.schema.json): every path
// is checked before the job starts, the files are committed one by one as clips, a file that
// fails does not stop the others, and the job ends once every clip has been analysed and, where
// notes are generated, has its notes. The files are decoded for real (a WAV header reader), so
// duration, channels and sample rate come from the file.

import fs from 'node:fs';
import path from 'node:path';

import type { Clock } from './clock.js';
import { jobStartedResult } from './job-reply.js';
import { checkNotBusy, contentLabel, envelope, notUndoable, placementLabel, type Handler } from './context.js';
import { refuse } from './errors.js';
import type { WorkFiles } from './files.js';
import type { JobControl, JobStep, JobStore } from './jobs.js';
import {
  DEFAULT_NOTE_PARAMS,
  TRACK_SLOTS,
  type ContentRec,
  type PlacementRec,
  type Vector,
  type World,
} from './model.js';
import { DEFAULT_NOTE_SPLIT_CENTS, segmentDetected } from './music.js';
import { checkPath } from './paths.js';
import { makeError, type ErrorInit, type ErrorObject } from './protocol.js';
import type { OtcpSpec } from '../test/support/otcp-spec.js';
import { readWav, type WavReading } from './wav.js';

type WavOk = Extract<WavReading, { ok: true }>;

/** What session.info reports as `import`. */
export const IMPORT_EXTENSIONS: readonly string[] = ['.wav', '.flac', '.mp3'];
export const IMPORT_LIMITS = { extensions: IMPORT_EXTENSIONS, maxChannels: 2, maxAnalysisSec: 600 } as const;
/** Time the mock takes to decode and commit one file. */
export const IMPORT_ITEM_MS = 10;
/** Time the pitch analysis of an imported clip takes. */
export const IMPORT_ANALYSIS_MS = 30;
/** The rate OpenTune works at; a file at another rate is resampled. */
const PROJECT_SAMPLE_RATE_HZ = 44_100;

type Layout = 'single' | 'sequential' | 'separateTracks';

interface Plan {
  readonly paths: readonly string[];
  readonly layout: Layout;
  readonly baseTrack: number;
  readonly startTimelineSec: number | undefined;
  readonly generateNotes: boolean;
  readonly focus: boolean;
}

interface Item {
  readonly path: string;
  readonly imported: boolean;
  readonly placementId: string | null;
  readonly contentId: string | null;
  readonly trackId: number | null;
  readonly startTimelineSec: number | null;
  readonly durationSec: number | null;
  readonly channelCount: number | null;
  readonly originalSampleRateHz: number | null;
  readonly resampled: boolean | null;
  f0State: string | null;
  notesGenerated: boolean;
  notesGeneratedBy: string | null;
  error: ErrorObject | null;
}

interface Committed {
  readonly item: Item;
  readonly placement: PlacementRec;
  readonly content: ContentRec;
  readonly voiced: boolean;
  readonly analysisFails: boolean;
  readonly readyAt: number;
  settled: boolean;
}

/**
 * The request that deletes the imported clips. It needs arrangement.v1, which the mock does not
 * report, so no request the instance accepts can restore the state (PROTOCOL.md section 15.2 rule 2).
 */
const revertRecipe = (): Record<string, unknown> | null => null;

const failedItem = (file: string, error: ErrorObject): Item => ({
  path: file,
  imported: false,
  placementId: null,
  contentId: null,
  trackId: null,
  startTimelineSec: null,
  durationSec: null,
  channelCount: null,
  originalSampleRateHz: null,
  resampled: null,
  f0State: null,
  notesGenerated: false,
  notesGeneratedBy: null,
  error,
});

export class ImportService {
  /** The normalized params and the job of each idempotency key (section 12.5). */
  readonly #keys = new Map<string, { jobId: string; params: string }>();
  #analysisFaults = 0;

  constructor(
    private readonly world: World,
    private readonly jobs: JobStore,
    private readonly files: WorkFiles,
    private readonly clock: Clock,
    private readonly spec: OtcpSpec,
  ) {}

  /** Test interface: the analysis of the next `count` imported clips fails. */
  failNextAnalysis(count: number): void {
    this.#analysisFaults = count;
  }

  /** The track the first file goes to (schema description of import.start). */
  #baseTrack(params: Readonly<Record<string, unknown>>): number {
    const { world } = this;
    if (typeof params.trackId === 'number') {
      if (params.trackId >= TRACK_SLOTS) throw refuse('NOT_FOUND', 'unknown_handle', 'no track slot has this trackId');
      return params.trackId;
    }
    if (params.newTrack === true) {
      // When every track holds a clip, newTrack has no empty track to take. The schema does not say
      // whether the active track is used instead; the maintainers ruled that this is an error
      // (INVALID_ARGUMENT, track_capacity), and the next version of the spec will say so.
      const used = new Set([...world.placements.values()].map((p) => p.trackId));
      for (let id = 0; id < TRACK_SLOTS; id++) if (!used.has(id)) return id;
      throw refuse('INVALID_ARGUMENT', 'track_capacity', 'every track already holds a clip');
    }
    return world.activeTrackId;
  }

  readonly start: Handler = (context) => {
    const { params } = context;
    const paths = (params.items as { path: string }[]).map((i) => i.path);
    for (const [index, file] of paths.entries()) {
      const bad = checkPath(file, IMPORT_EXTENSIONS, `items[${String(index)}].path`);
      if (bad !== undefined) throw bad;
    }
    const layout = params.layout as Layout;
    const startTimelineSec = typeof params.startTimelineSec === 'number' ? params.startTimelineSec : undefined;
    const generateNotes = params.generateNotes === true;
    const focus = params.focus !== false;
    // The normalized params depend on the request only, so the idempotencyKey is looked up before
    // any check that depends on the state: a retry after a lost response returns the same job.
    const normalized = JSON.stringify({
      items: paths,
      layout,
      trackId: params.trackId ?? null,
      newTrack: params.newTrack === true,
      startTimelineSec: startTimelineSec ?? null,
      generateNotes,
      focus,
    });
    const key = typeof params.idempotencyKey === 'string' ? params.idempotencyKey : undefined;
    if (key !== undefined) {
      const known = this.#keys.get(key);
      const job = known === undefined ? undefined : this.jobs.get(known.jobId);
      if (known !== undefined && job === undefined) this.#keys.delete(key);
      if (known !== undefined && job !== undefined) {
        if (known.params !== normalized) {
          throw refuse(
            'INVALID_ARGUMENT',
            'idempotency_key_reused',
            'a retained import job was started with this idempotencyKey and other params',
          );
        }
        return jobStartedResult(this.world, job);
      }
    }
    const baseTrack = this.#baseTrack(params);
    if (layout === 'separateTracks' && baseTrack + paths.length > TRACK_SLOTS) {
      throw refuse(
        'INVALID_ARGUMENT',
        'track_capacity',
        `${String(paths.length)} files from track ${String(baseTrack)} need more than ${String(TRACK_SLOTS)} tracks`,
      );
    }
    const plan: Plan = { paths, layout, baseTrack, startTimelineSec, generateNotes, focus };
    checkNotBusy(context);
    const job = this.jobs.start({ kind: 'import', cancellable: true }, this.#driver(plan));
    if (key !== undefined) this.#keys.set(key, { jobId: job.jobId, params: normalized });
    return jobStartedResult(this.world, job);
  };

  #error(init: ErrorInit): ErrorObject {
    return makeError(this.spec, init);
  }

  /** Reads and decodes one file; the error is that of the item. */
  #load(file: string, index: number): { ok: true; wav: WavOk } | { ok: false; error: ErrorObject } {
    const which = `item ${String(index)}`;
    if (this.files.isDenied(file)) {
      return {
        ok: false,
        error: this.#error({ kind: 'IO_ERROR', reason: 'read_failed', detail: `${which} could not be read` }),
      };
    }
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR'
        ? {
            ok: false,
            error: this.#error({ kind: 'NOT_FOUND', reason: 'file_not_found', detail: `${which} does not exist` }),
          }
        : {
            ok: false,
            error: this.#error({ kind: 'IO_ERROR', reason: 'read_failed', detail: `${which} could not be read` }),
          };
    }
    const wav = readWav(bytes);
    if (!wav.ok) {
      return {
        ok: false,
        error: this.#error({ kind: 'UNSUPPORTED', reason: 'unsupported_format', detail: `${which} cannot be decoded` }),
      };
    }
    if (wav.channelCount > IMPORT_LIMITS.maxChannels) {
      return {
        ok: false,
        error: this.#error({
          kind: 'UNSUPPORTED',
          reason: 'too_many_channels',
          detail: `${which} has more than ${String(IMPORT_LIMITS.maxChannels)} channels`,
        }),
      };
    }
    if (wav.durationSec > IMPORT_LIMITS.maxAnalysisSec) {
      return {
        ok: false,
        error: this.#error({
          kind: 'INVALID_ARGUMENT',
          reason: 'audio_too_long',
          detail: `${which} is longer than ${String(IMPORT_LIMITS.maxAnalysisSec)} s`,
        }),
      };
    }
    return { ok: true, wav };
  }

  /** The end of the last clip on a track, where the UI appends the next one. */
  #trackEnd(trackId: number): number {
    return Math.max(
      0,
      ...[...this.world.placements.values()]
        .filter((p) => p.trackId === trackId)
        .map((p) => p.startTimelineSec + p.durationSec),
    );
  }

  /** The analysis of a committed clip finishes (or fails). */
  #settle(clip: Committed): void {
    if (clip.settled) return;
    clip.settled = true;
    this.world.setAnalysis(clip.content, clip.analysisFails ? 'failed' : clip.voiced ? 'ready' : 'unvoiced');
    clip.item.f0State = clip.analysisFails ? 'failed' : 'ready';
    if (clip.analysisFails) {
      clip.item.error = this.#error({
        kind: 'ANALYSIS_FAILED',
        reason: 'f0_failed',
        detail: 'the pitch analysis failed',
      });
    }
  }

  /** Generates the notes of a clip whose analysis found voice. */
  #generateNotes(clip: Committed, by: 'request' | 'focus'): void {
    const { content } = clip;
    if (content.analysis !== 'ready') return;
    content.notes = segmentDetected(content.durationSec, DEFAULT_NOTE_SPLIT_CENTS).map((s) => ({
      startContentSec: s.startContentSec,
      endContentSec: s.endContentSec,
      targetMidi: Math.round(s.detectedMidi),
      offsetCents: 0,
      ...DEFAULT_NOTE_PARAMS,
    }));
    this.world.touch(content, 'notes', 'pitch');
    clip.item.notesGenerated = true;
    clip.item.notesGeneratedBy = by;
  }

  #driver(plan: Plan) {
    const { world, clock } = this;
    const items: Item[] = [];
    const clips: Committed[] = [];
    let index = 0;
    let before: { vector: Vector; dirty: boolean } | undefined;
    const revealed: number[] = [];

    const commit = (file: string, i: number): Item => {
      const loaded = this.#load(file, i);
      if (!loaded.ok) return failedItem(file, loaded.error);
      const { wav } = loaded;
      before ??= { vector: world.capture(), dirty: world.project.dirty };
      const last = clips.at(-1);
      const trackId = plan.layout === 'separateTracks' ? plan.baseTrack + clips.length : plan.baseTrack;
      let start: number;
      if (plan.layout === 'sequential' && last !== undefined)
        start = last.placement.startTimelineSec + last.placement.durationSec;
      else start = plan.startTimelineSec ?? this.#trackEnd(trackId);
      const content = world.addContent({ durationSec: wav.durationSec, analysis: 'running', sourcePath: file });
      const shown = world.visibleTrackCount;
      const placement = world.addPlacement({
        trackId,
        content,
        name: path.basename(file, path.extname(file)),
        startTimelineSec: start,
        durationSec: wav.durationSec,
      });
      world.touchGeometry(placement);
      if (world.visibleTrackCount > shown) {
        world.trackState = world.mint('t');
        revealed.push(...Array.from({ length: world.visibleTrackCount - shown }, (_, k) => shown + k));
      }
      world.markDirty();
      if (plan.focus) world.selectedPlacementIds = [placement.id];
      const analysisFails = this.#analysisFaults > 0;
      if (analysisFails) this.#analysisFaults--;
      const item: Item = {
        path: file,
        imported: true,
        placementId: placement.id,
        contentId: content.id,
        trackId,
        startTimelineSec: start,
        durationSec: wav.durationSec,
        channelCount: wav.channelCount,
        originalSampleRateHz: wav.sampleRateHz,
        resampled: wav.sampleRateHz !== PROJECT_SAMPLE_RATE_HZ,
        f0State: 'extracting',
        notesGenerated: false,
        notesGeneratedBy: null,
        error: null,
      };
      clips.push({
        item,
        placement,
        content,
        voiced: wav.voiced,
        analysisFails,
        readyAt: clock.now() + IMPORT_ANALYSIS_MS,
        settled: false,
      });
      return item;
    };

    const finish = (state: 'succeeded' | 'cancelled'): JobStep => {
      for (const clip of clips) this.#settle(clip);
      // The clip selected last is the one the UI focuses (section 21 rule 2).
      const focused = plan.focus ? clips.at(-1) : undefined;
      for (const clip of clips) {
        if (plan.generateNotes) this.#generateNotes(clip, 'request');
        else if (clip === focused && world.editingScheme === 'openDyne') this.#generateNotes(clip, 'focus');
      }
      const result = this.#result(plan, items, clips, before, revealed);
      return { done: { state, result } };
    };

    return (control: JobControl): JobStep => {
      // Cancelling stops before the next file is committed (schema description of import.start).
      if (control.cancelRequested) return finish('cancelled');
      if (index < plan.paths.length) {
        const file = plan.paths[index] ?? '';
        items.push(commit(file, index));
        index++;
        control.progress({
          fraction: index / (plan.paths.length + 1),
          phase: 'import',
          itemsDone: index,
          itemsTotal: plan.paths.length,
        });
        return { next: IMPORT_ITEM_MS };
      }
      const pending = clips.filter((c) => !c.settled);
      const due = pending.filter((c) => c.readyAt <= clock.now());
      for (const clip of due) this.#settle(clip);
      const waiting = pending.filter((c) => !due.includes(c));
      if (waiting.length > 0) {
        control.progress({ phase: 'analysis' });
        return { next: Math.max(0, Math.min(...waiting.map((c) => c.readyAt)) - clock.now()) };
      }
      return finish('succeeded');
    };
  }

  /** The write envelope of the committed clips, with the items (jobResult). */
  #result(
    plan: Plan,
    items: readonly Item[],
    clips: readonly Committed[],
    before: { vector: Vector; dirty: boolean } | undefined,
    revealed: readonly number[],
  ): Record<string, unknown> {
    const { world } = this;
    const imported = clips.length;
    const vector = before?.vector ?? world.capture();
    const focusGenerated = clips.filter((c) => c.item.notesGeneratedBy === 'focus');
    // The mock does not report arrangement.v1, so no request the instance accepts removes a clip.
    const revert = revertRecipe();
    const sideEffects: Record<string, unknown> = {};
    if (focusGenerated.length > 0) {
      sideEffects.notesGenerated = { contentIds: focusGenerated.map((c) => c.content.id), revert };
    }
    if (revealed.length > 0) sideEffects.tracksRevealed = { trackIds: [...revealed], revert };
    const warnings: unknown[] = [
      ...focusGenerated.map((c) => ({
        code: 'SELECTION_GENERATED_NOTES',
        subject: { contentId: c.content.id },
        data: null,
      })),
      ...revealed.map((trackId) => ({ code: 'TRACK_AUTO_REVEALED', subject: { trackId }, data: null })),
      ...(imported > 0 && revert === null ? [{ code: 'IRREVERSIBLE', subject: null, data: null }] : []),
    ];
    return envelope(world, {
      applied: true,
      noOp: imported === 0,
      created: clips.flatMap((c) => [
        { entity: 'placement', ref: { placementId: c.placement.id }, label: placementLabel(world, c.placement) },
        { entity: 'content', ref: { contentId: c.content.id }, label: contentLabel(c.content) },
      ]),
      diff: world.diff(vector, world.capture()),
      contents: clips.map((c) => c.content),
      placements: clips.map((c) => c.placement),
      undo: imported > 0 ? notUndoable('ui_parity', revert) : notUndoable('no_op'),
      dirtyBefore: before?.dirty ?? world.project.dirty,
      sideEffects,
      warnings,
      extra: {
        items,
        counts: { requested: plan.paths.length, imported, failed: items.length - imported },
      },
    });
  }
}
