// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// export.start and the export job of the mock (spec/otcp/v1/PROTOCOL.md section 19): path and
// target checks before the job, the export lock, the readiness wait driven by the clock, the
// revision check before the final rename, and a final rename that never replaces a file the
// request did not allow it to replace (section 20.4). The job really writes a WAV file: a header
// and as many silent samples as the export has, so the files in the target directory behave as an
// export's would.

import fs from 'node:fs';
import path from 'node:path';

import type { Clock } from './clock.js';
import { checkNotBusy, type Handler } from './context.js';
import { refuse, MockError } from './errors.js';
import type { WorkFiles } from './files.js';
import { exists, identityOf, sameFile } from './identity.js';
import { jobStartedResult } from './job-reply.js';
import type { JobOutcome, JobStore, JobStep } from './jobs.js';
import { TRACK_SLOTS, type ContentRec, type PlacementRec, type World } from './model.js';
import { checkPath } from './paths.js';

/** How often the main-thread timer of section 19 rule 6 looks at the contents. */
export const EXPORT_POLL_MS = 100;
/** Time the mock takes to write the file once the contents are ready. */
export const EXPORT_WRITE_MS = 50;
/** Section 19 rule 7. */
export const EXPORT_WAIT_LIMIT_MS = 120_000;
export const EXPORT_SAMPLE_RATE_HZ = 44_100;
const MAX_RENAME_INDEX = 999;
const FLOAT_BYTES = 4;
const WAV_HEADER_BYTES = 44;

type IfExists = 'error' | 'rename' | 'overwrite';

interface Plan {
  readonly kind: 'clip' | 'track' | 'master';
  readonly path: string;
  readonly ifExists: IfExists;
  readonly allowDry: boolean;
  readonly contents: readonly ContentRec[];
  readonly channelCount: number;
  readonly startTimelineSec: number;
  readonly durationSec: number;
}

/** A WAV header for float32 samples, followed by `frames` silent frames once the file is extended. */
function wavHeader(channels: number, frames: number): Buffer {
  const dataBytes = frames * channels * FLOAT_BYTES;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(WAV_HEADER_BYTES - 8 + dataBytes, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // IEEE float
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(EXPORT_SAMPLE_RATE_HZ, 24);
  header.writeUInt32LE(EXPORT_SAMPLE_RATE_HZ * channels * FLOAT_BYTES, 28);
  header.writeUInt16LE(channels * FLOAT_BYTES, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** A rename that never replaces: a hard link, then removal of the temporary name (section 20.4, last row). */
function renameNoReplace(temp: string, target: string): 'done' | 'exists' {
  try {
    fs.linkSync(temp, target);
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'EEXIST') return 'exists';
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS' && code !== 'EXDEV') {
      throw error;
    }
    // No hard links here: a copy that fails if the target exists is the nearest atomic form.
    try {
      fs.copyFileSync(temp, target, fs.constants.COPYFILE_EXCL);
    } catch (copyError) {
      if (errnoOf(copyError) === 'EEXIST') return 'exists';
      throw copyError;
    }
  }
  fs.unlinkSync(temp);
  return 'done';
}

export class ExportService {
  /** The normalized params of each export job started, to join an identical job (section 19 rule 5). */
  readonly #keys = new Map<string, string>();
  /** Render attempts that still fail, by content (test interface). */
  readonly #renderFaults = new Map<number, number>();
  #seq = 0;

  constructor(
    private readonly world: World,
    private readonly jobs: JobStore,
    private readonly files: WorkFiles,
    private readonly clock: Clock,
  ) {}

  /** Test interface: the next `times` attempts to render the content fail. */
  failRender(content: ContentRec, times: number): void {
    this.#renderFaults.set(content.objectId, times);
  }

  readonly #denied = (file: string): boolean => this.files.isDenied(file);

  /** Section 19 rule 2: the name is a loaded source file or a media file of the project. */
  #isLoadedMedia(target: string): boolean {
    // The identity of the target itself must be determinable, whatever the project holds (section 20.3 rule 4).
    identityOf(target, this.#denied);
    return [...this.world.contents.values()].some(
      (c) => c.sourcePath !== null && sameFile(c.sourcePath, target, this.#denied),
    );
  }

  #plan(params: Readonly<Record<string, unknown>>): Plan {
    const kind = params.kind as Plan['kind'];
    const target = (params.target ?? {}) as { placementId?: string; trackId?: number };
    let placements: PlacementRec[];
    if (kind === 'clip') {
      placements = [this.world.placement(String(target.placementId))];
    } else if (kind === 'track') {
      const trackId = Number(target.trackId);
      if (trackId >= TRACK_SLOTS) throw refuse('NOT_FOUND', 'unknown_handle', 'no track has this trackId');
      placements = [...this.world.placements.values()].filter((p) => p.trackId === trackId);
    } else {
      placements = [...this.world.placements.values()];
    }
    placements.sort((a, b) => a.serial - b.serial);
    const contents = [...new Set(placements.map((p) => p.content))];
    const first = placements[0];
    return {
      kind,
      path: String(params.path),
      ifExists: (params.ifExists as IfExists | undefined) ?? 'error',
      allowDry: params.allowDry === true,
      contents,
      channelCount: kind === 'master' ? 2 : 1,
      startTimelineSec: kind === 'clip' && first !== undefined ? first.startTimelineSec : 0,
      durationSec:
        kind === 'clip' && first !== undefined
          ? first.durationSec
          : Math.max(0, ...placements.map((p) => p.startTimelineSec + p.durationSec)),
    };
  }

  /** export.start (section 19). */
  readonly start: Handler = (context) => {
    const { params } = context;
    const bad = checkPath(String(params.path), ['.wav'], 'path');
    if (bad !== undefined) throw bad;
    const plan = this.#plan(params);
    const key = JSON.stringify({
      kind: plan.kind,
      target: params.target ?? null,
      path: plan.path,
      ifExists: plan.ifExists,
      allowDry: plan.allowDry,
    });
    for (const [jobId, jobKey] of this.#keys) {
      const job = this.jobs.get(jobId);
      if (jobKey === key && job?.finishedAtMs === null) return jobStartedResult(this.world, job);
    }
    checkNotBusy(context);
    if (this.#isLoadedMedia(plan.path)) {
      throw refuse('INVALID_ARGUMENT', 'target_is_loaded_media', 'the target is a source or media file of the project');
    }
    if (plan.ifExists === 'error' && exists(plan.path)) {
      throw refuse('ALREADY_EXISTS', 'target_exists', 'a file already exists at the target and ifExists is error');
    }
    const job = this.jobs.start({ kind: 'export', cancellable: true }, this.#driver(plan));
    this.#keys.set(job.jobId, key);
    return jobStartedResult(this.world, job);
  };

  /** The decision of section 19 rule 6 for one content. */
  #judge(
    content: ContentRec,
    plan: Plan,
    retried: Set<number>,
  ): 'ready' | 'wait' | { dry: string } | { fail: MockError } {
    switch (content.analysis) {
      case 'running':
        return 'wait';
      case 'unvoiced':
        return { dry: 'unvoiced' };
      case 'failed':
        return plan.allowDry
          ? { dry: 'analysisFailed' }
          : { fail: refuse('ANALYSIS_FAILED', 'f0_failed', 'the pitch analysis of a content failed') };
      case 'ready':
        break;
    }
    if (content.notes.length === 0) return { dry: 'nothingToRender' };
    if (content.render.published !== content.render.desired) return 'wait';
    const remaining = this.#renderFaults.get(content.objectId) ?? 0;
    if (remaining === 0) return 'ready';
    if (retried.has(content.objectId)) {
      return { fail: refuse('RENDER_FAILED', 'render_chunk_failed', 'a render block failed twice') };
    }
    // The block failed: queue it again once.
    retried.add(content.objectId);
    this.#renderFaults.set(content.objectId, remaining - 1);
    this.world.queueRender(content);
    return 'wait';
  }

  #driver(plan: Plan) {
    const { clock } = this;
    const retried = new Set<number>();
    const failed = (error: MockError): JobOutcome => ({ state: 'failed', error: error.init });
    let startedAt: number | undefined;
    let phase: 'wait' | 'write' = 'wait';
    let dry: { contentId: string; reason: string }[] = [];
    let recorded: Map<number, string> | undefined;
    let temp: string | undefined;
    const dropTemp = () => {
      if (temp !== undefined) fs.rmSync(temp, { force: true });
      temp = undefined;
    };

    const finish = (outcome: JobOutcome): JobStep => {
      dropTemp();
      return { done: outcome };
    };

    const waitStep = (): JobStep => {
      startedAt ??= clock.now();
      const verdicts = plan.contents.map((c) => ({ content: c, verdict: this.#judge(c, plan, retried) }));
      const failure = verdicts.find((v) => typeof v.verdict === 'object' && 'fail' in v.verdict);
      if (failure !== undefined && typeof failure.verdict === 'object' && 'fail' in failure.verdict) {
        return finish(failed(failure.verdict.fail));
      }
      if (verdicts.some((v) => v.verdict === 'wait')) {
        if (clock.now() - startedAt >= EXPORT_WAIT_LIMIT_MS) {
          return finish(
            failed(refuse('NOT_READY', 'export_wait_timeout', 'analysis and rendering did not settle within 120 s')),
          );
        }
        return { next: EXPORT_POLL_MS };
      }
      dry = verdicts.flatMap((v) =>
        typeof v.verdict === 'object' && 'dry' in v.verdict ? [{ contentId: v.content.id, reason: v.verdict.dry }] : [],
      );
      // Rule 8: in this step the revisions are recorded and the temporary file is started.
      recorded = new Map(plan.contents.map((c) => [c.objectId, c.revision]));
      const dir = path.dirname(plan.path);
      const temporary = path.join(dir, `.${path.basename(plan.path)}.${String(++this.#seq)}.tmp`);
      try {
        const frames = Math.round(plan.durationSec * EXPORT_SAMPLE_RATE_HZ);
        fs.writeFileSync(temporary, wavHeader(plan.channelCount, frames), { flag: 'wx' });
        temp = temporary;
        fs.truncateSync(temporary, WAV_HEADER_BYTES + frames * plan.channelCount * FLOAT_BYTES);
      } catch {
        fs.rmSync(temporary, { force: true });
        return finish(failed(refuse('IO_ERROR', 'write_failed', 'the output file could not be written')));
      }
      phase = 'write';
      return { next: EXPORT_WRITE_MS };
    };

    /** The names the final rename may use, in order. */
    const candidates = (): string[] => {
      if (plan.ifExists !== 'rename') return [plan.path];
      const dir = path.dirname(plan.path);
      const stem = path.basename(plan.path).slice(0, -'.wav'.length);
      return [
        plan.path,
        ...Array.from({ length: MAX_RENAME_INDEX - 1 }, (_, i) => path.join(dir, `${stem} (${String(i + 2)}).wav`)),
      ];
    };

    const renameStep = (): JobStep => {
      const placed = temp;
      if (placed === undefined || recorded === undefined)
        return finish(failed(refuse('INTERNAL', undefined, 'no file')));
      if (plan.contents.some((c) => recorded?.get(c.objectId) !== c.revision)) {
        return finish(
          failed(refuse('REVISION_CONFLICT', 'changed_during_export', 'a content changed while the file was written')),
        );
      }
      try {
        for (const name of candidates()) {
          // Rule 2 again, for the name actually used.
          if (this.#isLoadedMedia(name)) {
            return finish(
              failed(refuse('INVALID_ARGUMENT', 'target_is_loaded_media', 'the target is a source or media file')),
            );
          }
          if (plan.ifExists === 'overwrite') {
            fs.renameSync(placed, name);
            temp = undefined;
            return finish({ state: 'succeeded', result: this.#result(plan, name, dry) });
          }
          if (renameNoReplace(placed, name) === 'done') {
            temp = undefined;
            return finish({ state: 'succeeded', result: this.#result(plan, name, dry) });
          }
          if (plan.ifExists === 'error') break;
        }
        return finish(failed(refuse('ALREADY_EXISTS', 'target_exists', 'a file appeared at the target')));
      } catch (error) {
        if (error instanceof MockError) return finish(failed(error));
        return finish(failed(refuse('IO_ERROR', 'write_failed', 'the output file could not be moved into place')));
      }
    };

    return (control: { readonly cancelRequested: boolean }): JobStep => {
      // Section 19 rule 9: cancelling is possible until the final rename, which is one step.
      if (control.cancelRequested) return finish({ state: 'cancelled' });
      return phase === 'wait' ? waitStep() : renameStep();
    };
  }

  #result(plan: Plan, written: string, dry: readonly { contentId: string; reason: string }[]) {
    return {
      path: written,
      sampleRateHz: EXPORT_SAMPLE_RATE_HZ,
      channelCount: plan.channelCount,
      sampleFormat: 'float32',
      durationSec: plan.durationSec,
      startTimelineSec: plan.startTimelineSec,
      dryContents: [...dry],
      processing: {
        vocoderWeight: null,
        hybridMode: this.world.prefs.hybridMode,
        backend: null,
        tuningHz: this.world.prefs.tuningHz,
        nullReasons: { vocoderWeight: 'unavailable', backend: 'unavailable' },
      },
    };
  }
}
