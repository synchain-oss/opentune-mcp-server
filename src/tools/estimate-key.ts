// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_estimate_key: the key of a song from up to three kinds of evidence. The vocals come from
// OpenTune's analysis of a clip (content.getNotes, else content.segmentNotes, and the detected pitch
// of content.getPitchCurve; no audio is decoded for them); the mix and its bass line come from a WAV
// file read here (src/audio/). The estimation itself is src/analysis/key.ts. OpenTune keeps one key
// per clip and snaps to the seven notes of a scale, so the result separates the confidence in the
// scale set (relative keys share it) from the confidence in the tonic, and gives a recommendation
// for opentune_set_clip and opentune_autotune_range. Nothing is written, in OpenTune or on disk.

import { z } from 'zod';

import {
  SCALE_SET_SURE,
  TONIC_CLEAR,
  bassReliability,
  estimateKey,
  flatSeventhProminent,
  keyName,
  keyOf,
  mixReliability,
  relativeIndex,
  round,
  scalePitchClasses,
  sameScaleSetIndex,
  segmentKeys,
  steadyFrames,
  tuningOffset,
  vocalHistogram,
  vocalReliability,
  type KeyEstimate,
  type KeyRef,
  type KeySegment,
  type PitchEvent,
  type SourceEvidence,
} from '../analysis/key.js';
import { analyzeAudio, summarizeRange, type AudioFeatures } from '../audio/chroma.js';
import { MAX_WAV_BYTES, WavError, readWav, type DecodedWav } from '../audio/wav.js';
import { toolError, type NextStep } from '../errors/tool-error.js';
import type { Json, OtcpSession } from '../otcp/client.js';
import { resolvePath } from '../paths/index.js';
import { extensionOf } from '../paths/validate.js';
import { token } from '../render/text.js';
import { CLIP_FIELD, INSTANCE_FIELD, READ_TIMEOUT_MS, SCALES, invalid, isObject } from './clip-write.js';
import { defineTool, withInstance, type Body, type Outcome, type ToolContext } from './registry.js';

const TOOL = 'opentune_estimate_key';
const MAX_SECTIONS = 16;
const MIN_SECTION_SEC = 2;
/** Local keys: windows of this length, this far apart; a song needs two windows for them. */
const WINDOW_SEC = 12;
const WINDOW_HOP_SEC = 4;
const MAX_LOCAL_KEYS = 24;
const TOP_KEYS = 5;
const SECTION_KEYS = 3;
/** A tuning offset beyond this many cents, measured reliably, is pointed out. */
const TUNING_HINT_CENTS = 15;
const TUNING_SURE = 0.5;
const DEFAULT_REFERENCE_HZ = 440;

/** How much one call reads from OpenTune: notes and pitch frames (about 2.7 hours at 10 ms). */
export interface ReadLimits {
  readonly notePage: number;
  readonly maxNotePages: number;
  readonly curvePage: number;
  readonly maxCurvePages: number;
}
export const READ_LIMITS: ReadLimits = { notePage: 500, maxNotePages: 20, curvePage: 10_000, maxCurvePages: 100 };

export interface EstimateKeyArgs {
  readonly clip?: string | undefined;
  readonly mix_path?: string | undefined;
  readonly sections?: readonly { readonly start_sec: number; readonly end_sec: number }[] | undefined;
  readonly instance_id?: string | undefined;
}

/** Test seams: the size limit of the WAV file and the read limits. */
export interface EstimateKeyOptions {
  readonly maxWavBytes?: number;
  readonly limits?: ReadLimits;
}

const fin = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const CONVERT: NextStep = {
  actor: 'agent',
  message:
    'Give a WAV file (16, 24 or 32-bit PCM or 32-bit float, mono or stereo). Convert the file first, or, with the ' +
    "user's consent, import it with opentune_open_audio and write it as WAV with opentune_export_audio.",
};

/** The tool error for a WAV file that cannot be used; the detail never repeats the path. */
export function wavFailure(error: WavError, maxBytes: number): Outcome {
  const detail = `mix_path: ${error.message}`;
  switch (error.problem) {
    case 'not_found':
      return {
        ok: false,
        error: toolError('NOT_FOUND', {
          reason: 'file_not_found',
          detail,
          nextStep: {
            actor: 'agent',
            message: 'Check the path with the user and give the absolute path of an existing WAV file.',
          },
        }),
      };
    case 'read_failed':
      return { ok: false, error: toolError('IO_ERROR', { reason: 'read_failed', detail }) };
    case 'too_large':
      return {
        ok: false,
        error: toolError('INVALID_ARGUMENT', {
          reason: 'file_too_large',
          detail,
          nextStep: {
            actor: 'agent',
            message: `The limit is ${String(round(maxBytes / 1024 / 1024, 2))} MiB (256 MiB is about 25 minutes of 16-bit stereo at 44.1 kHz). Give a shorter excerpt, or a mono or 16-bit version.`,
          },
        }),
      };
    case 'not_a_file':
      return { ok: false, error: toolError('INVALID_ARGUMENT', { reason: 'not_a_file', detail, nextStep: CONVERT }) };
    default:
      return {
        ok: false,
        error: toolError('INVALID_ARGUMENT', { reason: 'wav_unsupported', detail, nextStep: CONVERT }),
      };
  }
}

interface ClipKey {
  readonly root: number;
  readonly scale: string;
  readonly origin: string | null;
  readonly confidence: number | null;
}

/** The key as OpenTune reports it, or null when it is missing or not in the protocol form. */
function clipKeyOf(value: unknown): ClipKey | null {
  if (!isObject(value)) return null;
  const scale = token(value.scale, 'camel');
  if (!Number.isInteger(value.root) || (value.root as number) < 0 || (value.root as number) > 11 || scale === null)
    return null;
  return {
    root: value.root as number,
    scale,
    origin: token(value.origin, 'camel'),
    confidence: fin(value.confidence) ? value.confidence : null,
  };
}

interface Vocals {
  readonly contentId: string;
  readonly placementId: string | null;
  readonly durationSec: number | null;
  readonly clipKey: ClipKey | null;
  /** The instance sent a key that is not in the protocol form (as opposed to sending none). */
  readonly clipKeyInvalid: boolean;
  readonly f0State: string | null;
  readonly tuningHz: number;
  readonly events: PitchEvent[];
  readonly noteSource: 'stored_notes' | 'detected_segments';
  readonly frames: (number | null)[];
  readonly warnings: string[];
}

/** Every page of a paged read, up to `maxPages`; `complete` is false when the limit cut it. */
async function pages(
  session: OtcpSession,
  method: string,
  params: Json,
  limit: number,
  maxPages: number,
): Promise<{ results: Json[]; complete: boolean }> {
  const results: Json[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await session.call(
      method,
      { ...params, ...(cursor === undefined ? {} : { cursor }), limit },
      READ_TIMEOUT_MS,
    );
    results.push(result);
    if (typeof result.nextCursor !== 'string') return { results, complete: true };
    cursor = result.nextCursor;
  }
  return { results, complete: false };
}

const eventsOf = (list: unknown): PitchEvent[] =>
  (Array.isArray(list) ? list : []).flatMap((n) =>
    isObject(n) &&
    fin(n.startContentSec) &&
    fin(n.endContentSec) &&
    fin(n.detectedMidi) &&
    n.endContentSec > n.startContentSec
      ? [{ startSec: n.startContentSec, endSec: n.endContentSec, midi: n.detectedMidi }]
      : [],
  );

/** The vocal evidence of a clip: its notes (or OpenTune's segmentation) and its detected pitch. */
async function readVocals(session: OtcpSession, clip: string, limits: ReadLimits): Promise<Vocals | Outcome> {
  const base: Json = clip.startsWith('p:') ? { placementId: clip } : { contentId: clip };
  const details = await session.call('content.getDetails', base, READ_TIMEOUT_MS);
  const contentId = token(details.contentId, 'contentId');
  if (contentId === null) {
    return { ok: false, error: toolError('INTERNAL', { detail: 'the instance returned no content id for the clip' }) };
  }
  const analysis = isObject(details.analysis) ? details.analysis : {};
  const f0State = typeof analysis.f0State === 'string' ? (token(analysis.f0State, 'camel') ?? 'unknown') : null;
  const warnings: string[] = [];
  const notes = await pages(session, 'content.getNotes', base, limits.notePage, limits.maxNotePages);
  if (!notes.complete) warnings.push('only the first notes of the clip were read (read limit)');
  let events = notes.results.flatMap((r) => eventsOf(r.notes));
  const reportedHz = notes.results[0]?.tuningHz;
  const tuningHz = fin(reportedHz) ? reportedHz : DEFAULT_REFERENCE_HZ;
  let noteSource: Vocals['noteSource'] = 'stored_notes';
  let frames: (number | null)[] = [];
  if (f0State === 'ready') {
    if (events.length === 0) {
      // No stored notes: OpenTune's own segmentation of the detected pitch stands in for them.
      const segmented = await session.call('content.segmentNotes', { contentId }, READ_TIMEOUT_MS);
      events = eventsOf(segmented.segments);
      noteSource = 'detected_segments';
    }
    const curve = await pages(
      session,
      'content.getPitchCurve',
      { contentId, stepFrame: 1 },
      limits.curvePage,
      limits.maxCurvePages,
    );
    if (!curve.complete) warnings.push('the pitch curve was cut at the read limit');
    frames = curve.results.flatMap((r) =>
      Array.isArray(r.originalMidi) ? r.originalMidi.map((v) => (fin(v) ? v : null)) : [],
    );
  }
  return {
    contentId,
    placementId: clip.startsWith('p:') ? clip : null,
    durationSec: fin(details.durationSec) ? details.durationSec : null,
    clipKey: clipKeyOf(details.key),
    clipKeyInvalid: details.key !== undefined && details.key !== null && clipKeyOf(details.key) === null,
    f0State,
    tuningHz,
    events: f0State === null || f0State === 'ready' ? events : [],
    noteSource,
    frames,
    warnings,
  };
}

/** Cents wrapped into -50..50: a tuning offset is the distance to the nearest semitone. */
const wrapCents = (cents: number): number => cents - 100 * Math.round(cents / 100);

const keyEntry = (index: number): Json => {
  const key = keyOf(index);
  return { root: key.root, scale: key.scale, name: keyName(key) };
};

const candidates = (estimate: KeyEstimate, count: number): Json[] =>
  estimate.order.slice(0, count).map((k) => ({ ...keyEntry(k), probability: round(estimate.probabilities[k] ?? 0) }));

/** Same seven notes: the pitch classes of the clip key equal those of the estimated key. */
function sameScaleSet(clipKey: ClipKey, key: KeyRef): boolean | null {
  const a = scalePitchClasses(clipKey.root, clipKey.scale);
  const b = scalePitchClasses(key.root, key.scale);
  if (a === null || b === null) return null;
  return a.length === b.length && a.every((p) => b.includes(p));
}

/** Said in place of a scale this server has no name for. */
const OTHER_SCALE = 'another scale';

/**
 * "G major" for the two scales the estimate names; "dorian on root 2" for any other scale of the protocol. The scale
 * is OpenTune's text: it is put in the sentence only as a token of the camel form that is also one of the scales of
 * the protocol; any other word (the protocol may grow, a file may carry anything) is said as "another scale".
 */
export function clipKeyName(clipKey: Pick<ClipKey, 'root' | 'scale'>): string {
  if (clipKey.scale === 'major' || clipKey.scale === 'minor') {
    return keyName({ root: clipKey.root, scale: clipKey.scale });
  }
  const scale = token(clipKey.scale, 'camel');
  const named = scale !== null && (SCALES as readonly string[]).includes(scale) ? scale : OTHER_SCALE;
  return `${named} on root ${String(clipKey.root)}`;
}

/** Where the key of the clip comes from, in words; an origin this server does not know is "of unknown origin". */
function clipKeySource(clipKey: ClipKey): string {
  return clipKey.origin === 'manual'
    ? 'set by the user'
    : clipKey.origin === 'automatic'
      ? 'found automatically'
      : 'of unknown origin';
}

/**
 * A clip key that the agent must not replace without asking: it has other notes than the estimate, or the two
 * cannot be compared (the scale is one this server has no name for, so it is not known whether the notes are the same).
 */
interface ClipConflict {
  readonly clipKey: ClipKey;
  readonly comparable: boolean;
}

/**
 * The part of recommendation.reason for a clip key that may differ from the estimate. Setting the key of a clip
 * cannot be undone, so the agent asks first, whatever the origin of the key; a key the user set stands unless the
 * user wants another.
 */
function clipKeyAsk({ clipKey, comparable }: ClipConflict): string {
  const head = `the clip's key in OpenTune (${clipKeyName(clipKey)}, ${clipKeySource(clipKey)}) ${
    comparable
      ? 'has other notes than this estimate'
      : 'cannot be compared with this estimate (its scale is not one this server knows)'
  }`;
  return clipKey.origin === 'manual'
    ? `${head}: keep the user's choice unless the user wants another, and ask before calling opentune_set_clip`
    : `${head}: ask the user which one to use before calling opentune_set_clip`;
}

/**
 * The summary sentence for a clip key that cannot be compared with the estimate. It does not name the key: the scale
 * is a word this server does not know.
 */
const NOT_COMPARABLE_TEXT =
  "The clip has a key in OpenTune that this server cannot compare with this estimate (its scale is not one it knows): ask the user which one is right before the clip's key is set.";

/**
 * The sentence for a clip whose key has the same notes as a sure estimate: snapping gives the same result, so the key
 * of the clip stays as it is and the agent has no irreversible step to take. Only where the estimate is the one to
 * snap to: with a key change, each part has its own key (local_keys), and `scale: "clip"` is not offered.
 */
function sameNotesText(clipKey: ClipKey, changes: boolean): string {
  return (
    `The clip's key in OpenTune (${clipKeyName(clipKey)}, ${clipKeySource(clipKey)}) has the same notes as this estimate, ` +
    (changes
      ? 'so snapping gives the same result and the clip key need not change; each part of the song still gets its own key (see local_keys).'
      : 'so snapping gives the same result: leave the clip key as it is and use scale "clip" in opentune_autotune_range.')
  );
}

/**
 * The sentence for a clip whose key has other notes than the estimate, in plain words and with a verdict on
 * which of the two to trust. A key a person set stands. A key OpenTune found on its own gives way to a sure
 * estimate that also hears the mix; against a vocals-only estimate (the same kind of evidence as OpenTune's)
 * or an unsure one, neither is clearly better and the user decides. Only the two origins this server knows
 * (`manual`, `automatic`) are said as such; a missing origin or one it does not know (the protocol lets it grow)
 * is said as "of unknown origin", and the sentence then never claims that the key was found automatically.
 */
function clipKeyText(clipKey: ClipKey, estimateSure: boolean, hearsMix: boolean): string {
  const head = `The clip's key in OpenTune (${clipKeyName(clipKey)}, ${clipKeySource(clipKey)}) has other notes than this estimate`;
  if (clipKey.origin === 'manual')
    return `${head}: the user's choice is the more trustworthy, so keep it unless the user wants another.`;
  if (clipKey.origin === 'automatic' && estimateSure && hearsMix) {
    return `${head}: the estimate is the more trustworthy, because it also hears the mix; offer it to the user before setting it.`;
  }
  const why = !estimateSure
    ? 'the estimate is uncertain'
    : !hearsMix
      ? 'the estimate rests on the vocals alone'
      : 'it is not known whether the user set that key or OpenTune found it, and a key the user set stands';
  return `${head}, and neither is clearly the more trustworthy (${why}): ask the user which one is right.`;
}

interface Evidence {
  readonly mix: AudioFeatures | null;
  readonly vocals: Vocals | null;
  readonly vocalOffsetCents: number;
}

/** The sources of the time range [fromSec, toSec); all of the song without a range. */
function sourcesIn(e: Evidence, fromSec?: number, toSec?: number): SourceEvidence[] {
  const out: SourceEvidence[] = [];
  if (e.mix !== null) {
    const s = summarizeRange(e.mix, fromSec, toSec);
    out.push({ name: 'mix', vector: s.chroma, reliability: mixReliability(s.activeSec) });
    out.push({ name: 'bass', vector: s.bass, reliability: bassReliability(s.activeSec, s.bassShare) });
  }
  if (e.vocals !== null) {
    const v = vocalHistogram(e.vocals.events, e.vocalOffsetCents, fromSec, toSec);
    out.push({ name: 'vocals', vector: v.histogram, reliability: vocalReliability(v) });
  }
  return out;
}

/**
 * What to do with the estimate. `ask_user` is true when the scale set is uncertain, and also when the clip has a key
 * (`conflict`) with other notes than the estimate, or one that cannot be compared with it: setting the key of the
 * clip over it cannot be undone. A clip key with the same notes, and a clip without a key, do not add to it.
 */
function recommendation(estimate: KeyEstimate, changes: boolean, conflict: ClipConflict | null = null): Json {
  const top = estimate.order[0] ?? 0;
  const key = keyOf(top);
  const sure = estimate.scaleSetConfidence >= SCALE_SET_SURE;
  const set = round(estimate.scaleSetConfidence, 2);
  const parts = [
    sure
      ? `scale set confidence ${String(set)}`
      : `scale set confidence ${String(set)} is below ${String(SCALE_SET_SURE)}: snap chromatically, or ask the user for the key`,
  ];
  if (sure && estimate.tonicConfidence < TONIC_CLEAR) {
    parts.push(
      `${keyName(key)} and ${keyName(keyOf(relativeIndex(top)))} have the same notes, so snapping is the same with either`,
    );
  }
  if (conflict !== null) parts.push(clipKeyAsk(conflict));
  if (changes) {
    parts.push(
      "the key changes (see local_keys): for each part, opentune_autotune_range with that part's range and key",
    );
  }
  return {
    key: sure ? { root: key.root, scale: key.scale } : { root: key.root, scale: 'chromatic' },
    ask_user: !sure || conflict !== null,
    reason: parts.join('; '),
  };
}

/** The windows of the local-key analysis over `durationSec` seconds. */
function localKeys(e: Evidence, durationSec: number) {
  if (durationSec < 2 * WINDOW_SEC) return null;
  const windows = [];
  for (let start = 0; start + WINDOW_SEC <= durationSec + 1e-9; start += WINDOW_HOP_SEC) {
    windows.push({
      startSec: start,
      endSec: start + WINDOW_SEC,
      estimate: estimateKey(sourcesIn(e, start, start + WINDOW_SEC)),
    });
  }
  return segmentKeys(windows, durationSec);
}

/**
 * The key name of each local key. A segment with the same notes as the song's estimate carries the
 * estimate's key, so local_keys never contradicts the top-level result; any other segment takes the
 * best key of its own time range when that has the segment's notes, else the key the path found.
 */
function nameSegments(segments: readonly KeySegment[], estimate: KeyEstimate, e: Evidence): KeySegment[] {
  const topKey = estimate.order[0] ?? 0;
  return segments.map((s) => {
    if (sameScaleSetIndex(s.key, topKey)) return { ...s, key: topKey };
    const own = estimateKey(sourcesIn(e, s.startSec, s.endSec))?.order[0];
    return own !== undefined && sameScaleSetIndex(s.key, own) ? { ...s, key: own } : s;
  });
}

const cents = (value: number | null | undefined): number | null =>
  value === null || value === undefined ? null : round(value, 1);

export async function estimateSongKey(
  ctx: ToolContext,
  args: EstimateKeyArgs,
  options: EstimateKeyOptions = {},
): Promise<Outcome> {
  if (args.clip === undefined && args.mix_path === undefined) {
    return invalid('give clip, mix_path or both: there is no evidence to estimate a key from');
  }
  for (const [i, s] of (args.sections ?? []).entries()) {
    if (!(s.end_sec - s.start_sec >= MIN_SECTION_SEC)) {
      return invalid(`sections[${String(i)}]: end_sec must be at least ${String(MIN_SECTION_SEC)} s after start_sec`);
    }
  }
  const maxBytes = options.maxWavBytes ?? MAX_WAV_BYTES;
  let wav: DecodedWav | null = null;
  if (args.mix_path !== undefined) {
    const resolved = resolvePath(args.mix_path, ctx, 'mix_path');
    if (!resolved.ok) return { ok: false, error: resolved.error };
    if (extensionOf(resolved.path).toLowerCase() !== '.wav') {
      return {
        ok: false,
        error: toolError('INVALID_ARGUMENT', {
          reason: 'path_bad_extension',
          detail: 'mix_path does not end in .wav; only WAV files are read',
          nextStep: CONVERT,
        }),
      };
    }
    try {
      wav = await readWav(resolved.path, maxBytes);
    } catch (error) {
      if (error instanceof WavError) return wavFailure(error, maxBytes);
      throw error;
    }
  }
  const mix = wav === null ? null : analyzeAudio(wav.samples, wav.rateHz);
  const clip = args.clip;
  if (clip === undefined) return { ok: true, body: buildBody(args, wav, mix, null) };
  return withInstance(ctx, { instanceId: args.instance_id }, ['read.v1'], async (session) => {
    const vocals = await readVocals(session, clip, options.limits ?? READ_LIMITS);
    if ('ok' in vocals) return vocals;
    return { ok: true, body: buildBody(args, wav, mix, vocals) };
  });
}

function buildBody(
  args: EstimateKeyArgs,
  wav: DecodedWav | null,
  mix: AudioFeatures | null,
  vocals: Vocals | null,
): Body {
  const warnings: string[] = [...(vocals?.warnings ?? [])];
  const reasons: Json = {};
  const referenceHz = vocals?.tuningHz ?? DEFAULT_REFERENCE_HZ;
  const vocalTuning =
    vocals === null
      ? null
      : (tuningOffset(steadyFrames(vocals.frames)) ??
        tuningOffset(vocals.events.map((ev) => ({ midi: ev.midi, weight: ev.endSec - ev.startSec }))));
  const mixTuning =
    mix?.tuning == null
      ? null
      : {
          offsetCents: wrapCents(mix.tuning.offsetCents - 1200 * Math.log2(referenceHz / 440)),
          reliability: mix.tuning.reliability,
        };
  const evidence: Evidence = { mix, vocals, vocalOffsetCents: vocalTuning?.offsetCents ?? 0 };
  // The timeline of the result is the clip's when a clip is given (its notes and the sections are on it),
  // else the mix's; a mix of another length is read from its start, so its end does not move the result.
  const durationSec = vocals?.durationSec ?? wav?.durationSec ?? null;
  const wholeSong = estimateKey(sourcesIn(evidence));
  let segments = wholeSong === null || durationSec === null ? null : localKeys(evidence, durationSec);
  if (segments !== null && segments.length > MAX_LOCAL_KEYS) {
    warnings.push(`only the first ${String(MAX_LOCAL_KEYS)} local keys are listed`);
    segments = segments.slice(0, MAX_LOCAL_KEYS);
  }
  const changes = segments !== null && segments.length > 1;
  // Across a key change the whole song mixes two scales; the key of its longest part is the main key.
  const main =
    segments !== null && changes
      ? segments.reduce((a, b) => (b.endSec - b.startSec > a.endSec - a.startSec ? b : a))
      : null;
  const estimate =
    main === null ? wholeSong : (estimateKey(sourcesIn(evidence, main.startSec, main.endSec)) ?? wholeSong);
  if (segments !== null && estimate !== null) segments = nameSegments(segments, estimate, evidence);
  const whole = mix === null ? null : summarizeRange(mix);
  const sung = vocals === null ? null : vocalHistogram(vocals.events, evidence.vocalOffsetCents);

  // Sources: what each contributed, and why one did not.
  const weight = (name: 'mix' | 'bass' | 'vocals') => round(estimate?.weights[name] ?? 0);
  const sources: Json = {
    mix:
      wav === null || whole === null
        ? { used: false, weight: 0, reason: 'not_given' }
        : {
            used: weight('mix') > 0,
            weight: weight('mix'),
            reliability: round(mixReliability(whole.activeSec)),
            duration_sec: round(wav.durationSec, 2),
            active_sec: round(whole.activeSec, 2),
            sample_rate_hz: wav.sampleRateHz,
            channels: wav.channels,
            bits: wav.bits,
            float: wav.float,
            ...(whole.activeSec === 0 ? { reason: 'silent' } : {}),
          },
    bass:
      whole === null
        ? { used: false, weight: 0, reason: 'not_given' }
        : {
            used: weight('bass') > 0,
            weight: weight('bass'),
            reliability: round(bassReliability(whole.activeSec, whole.bassShare)),
            bass_share: round(whole.bassShare),
          },
    vocals:
      vocals === null || sung === null
        ? { used: false, weight: 0, reason: 'not_given' }
        : {
            used: weight('vocals') > 0,
            weight: weight('vocals'),
            reliability: round(vocalReliability(sung)),
            note_source: vocals.noteSource,
            note_count: sung.eventCount,
            sung_sec: round(sung.seconds, 2),
            f0State: vocals.f0State,
            ...(vocals.f0State !== null && vocals.f0State !== 'ready'
              ? { reason: `pitch_analysis_${vocals.f0State}` }
              : sung.eventCount === 0
                ? { reason: 'no_notes' }
                : {}),
          },
  };

  // Tuning: the vocals against OpenTune's A4 when a clip is given, else the mix against 440 Hz.
  const primary = vocalTuning ?? mixTuning;
  const tuning: Json = {
    reference_hz: referenceHz,
    vocals_offset_cents: cents(vocalTuning?.offsetCents),
    vocals_reliability: vocalTuning === null ? null : round(vocalTuning.reliability),
    mix_offset_cents: cents(mixTuning?.offsetCents),
    mix_reliability: mixTuning === null ? null : round(mixTuning.reliability),
  };
  if (vocalTuning === null) reasons['tuning.vocals_offset_cents'] = vocals === null ? 'no_clip' : 'no_pitch_data';
  if (mixTuning === null) reasons['tuning.mix_offset_cents'] = mix === null ? 'no_mix' : 'no_pitch_data';
  if (primary === null) reasons.tuning_offset_cents = 'no_pitch_data';
  const sentences: string[] = [];
  const shown = (value: number) => `${value > 0 ? '+' : ''}${String(round(value, 1))}`;
  if (
    mixTuning !== null &&
    Math.abs(mixTuning.offsetCents) > TUNING_HINT_CENTS &&
    mixTuning.reliability >= TUNING_SURE
  ) {
    const suggested = round(referenceHz * 2 ** (mixTuning.offsetCents / 1200), 1);
    warnings.push(
      `the mix is tuned ${shown(mixTuning.offsetCents)} cents from A4 = ${String(referenceHz)} Hz: corrections snap to that grid and would leave the vocals off the mix; ask the user whether to set A4 to ${String(suggested)} Hz in OpenTune's preferences before correcting`,
    );
    sentences.push(
      `The mix is tuned ${shown(mixTuning.offsetCents)} cents from A4 = ${String(referenceHz)} Hz (see warnings).`,
    );
  } else if (
    vocalTuning !== null &&
    Math.abs(vocalTuning.offsetCents) > TUNING_HINT_CENTS &&
    vocalTuning.reliability >= TUNING_SURE
  ) {
    warnings.push(
      `the vocals sit ${shown(vocalTuning.offsetCents)} cents from the A4 = ${String(referenceHz)} Hz grid on average: the recording may be tuned that way, and corrections pull the notes to the grid; ask the user before correcting`,
    );
    sentences.push(
      `The vocals sit ${shown(vocalTuning.offsetCents)} cents from the A4 = ${String(referenceHz)} Hz grid (see warnings).`,
    );
  }

  const clipSame =
    vocals?.clipKey == null || estimate === null ? null : sameScaleSet(vocals.clipKey, keyOf(estimate.order[0] ?? 0));
  const clipInfo: Json | undefined =
    vocals === null
      ? undefined
      : {
          contentId: vocals.contentId,
          placementId: vocals.placementId,
          key: vocals.clipKey,
          same_scale_set_as_estimate: clipSame,
        };
  if (vocals !== null && vocals.clipKey === null) {
    reasons['clip.key'] = vocals.clipKeyInvalid ? 'invalid' : 'not_analyzed';
  }
  if (clipInfo?.same_scale_set_as_estimate === null) {
    reasons['clip.same_scale_set_as_estimate'] =
      vocals?.clipKey == null
        ? vocals?.clipKeyInvalid === true
          ? 'invalid'
          : 'not_analyzed'
        : estimate === null
          ? 'no_evidence'
          : 'unknown_scale';
  }

  if (wav !== null && vocals?.durationSec != null && Math.abs(wav.durationSec - vocals.durationSec) > 2) {
    warnings.push(
      `the mix lasts ${String(round(wav.durationSec, 1))} s and the clip's source audio ${String(round(vocals.durationSec, 1))} s: both are taken to start together, and times follow the clip`,
    );
  }

  if (estimate === null) {
    reasons.candidates = 'no_evidence';
    return {
      summary:
        'No key could be estimated: the mix is silent or missing and the clip has no sung notes with a detected pitch. ' +
        'Nothing was changed.',
      candidates: [],
      scale_set_confidence: null,
      tonic_confidence: null,
      scale_set: null,
      recommendation: null,
      tuning_offset_cents: cents(primary?.offsetCents),
      tuning,
      sources,
      estimated_over: null,
      local_keys: null,
      ...(args.sections === undefined ? {} : { sections: [] }),
      ...(clipInfo === undefined ? {} : { clip: clipInfo }),
      ...(warnings.length > 0 ? { warnings } : {}),
      nullReasons: {
        ...reasons,
        scale_set_confidence: 'no_evidence',
        tonic_confidence: 'no_evidence',
        scale_set: 'no_evidence',
        recommendation: 'no_evidence',
        estimated_over: 'no_evidence',
        local_keys: 'no_evidence',
      },
    };
  }

  const top = estimate.order[0] ?? 0;
  if (segments === null) {
    reasons.local_keys = durationSec === null ? 'duration_unknown' : `too_short_under_${String(2 * WINDOW_SEC)}_sec`;
  }
  if (durationSec === null) reasons.estimated_over = 'duration_unknown';
  const over =
    main !== null
      ? { start_sec: round(main.startSec, 2), end_sec: round(main.endSec, 2) }
      : durationSec === null
        ? null
        : { start_sec: 0, end_sec: round(durationSec, 2) };
  const tonicClear = estimate.tonicConfidence >= TONIC_CLEAR;
  const vocalsOnly = estimate.weights.mix === 0 && estimate.weights.bass === 0;
  const chromaVector = whole !== null && estimate.weights.mix > 0 ? whole.chroma : sung?.histogram;
  if (chromaVector !== undefined && flatSeventhProminent(chromaVector, top)) {
    warnings.push(
      `the flat seventh is frequent: the music may be mixolydian (scale mixolydian on root ${String(keyOf(top).root)}) rather than major; ask the user if the seventh matters`,
    );
  }
  if (vocalsOnly) {
    warnings.push(
      'only the vocals were used: the scale set is more reliable than the tonic and major or minor; give mix_path for a firmer estimate',
    );
  }

  const used = (['mix', 'bass', 'vocals'] as const).filter((n) => estimate.weights[n] > 0);
  // Both confidences of the top level are those of estimated_over: the main part across a key change, else the whole range.
  const range = over === null ? '' : `${String(Math.round(over.start_sec))} to ${String(Math.round(over.end_sec))} s`;
  const lead =
    `Estimated key${over === null ? '' : main === null ? ` over ${range}` : ` of the main part (${range})`}: ` +
    `${keyName(keyOf(top))} (scale set confidence ${String(round(estimate.scaleSetConfidence, 2))}, ` +
    `tonic confidence ${String(round(estimate.tonicConfidence, 2))}) from ${used.join(', ')}; nothing was changed.`;
  const rest: string[] = [];
  if (!tonicClear) {
    rest.push(
      `${keyName(keyOf(top))} and ${keyName(keyOf(relativeIndex(top)))} have the same notes and the tonic is unclear, which does not matter for snapping.`,
    );
  }
  if (estimate.scaleSetConfidence < SCALE_SET_SURE)
    rest.push('The scale set is uncertain: the recommendation is chromatic, or ask the user for the key.');
  if (vocalsOnly)
    rest.push('Only the vocals were used, so the tonic and major or minor are less certain than the scale set.');
  if (changes && segments !== null) {
    rest.push(
      `The key seems to change: ${segments.map((s) => `${keyName(keyOf(s.key))} from ${String(Math.round(s.startSec))} s`).join(', ')} (see local_keys).`,
    );
  }
  if (segments !== null) {
    rest.push(
      `The confidences above cover ${main === null ? 'the whole range' : 'the main part'}; scale_set_confidence in local_keys is the mean over the short windows of that segment alone, and can be lower.`,
    );
  }
  rest.push(...sentences);
  // A clip key with other notes than the estimate, or one that cannot be compared with it: asking the user before it
  // is replaced is the recommendation. A clip without a key has nothing to ask about.
  const sure = estimate.scaleSetConfidence >= SCALE_SET_SURE;
  const conflict: ClipConflict | null =
    vocals?.clipKey != null && clipSame !== true ? { clipKey: vocals.clipKey, comparable: clipSame === false } : null;
  if (conflict !== null) {
    rest.push(conflict.comparable ? clipKeyText(conflict.clipKey, sure, !vocalsOnly) : NOT_COMPARABLE_TEXT);
  } else if (clipSame === true && sure && vocals?.clipKey != null) {
    // Only for a sure estimate: with an unsure one the recommendation is chromatic, not the key of the clip.
    rest.push(sameNotesText(vocals.clipKey, changes));
  }
  rest.push(
    clipSame === true
      ? 'Pass recommendation.key as scale to opentune_autotune_range.'
      : conflict !== null
        ? 'Pass recommendation.key as scale to opentune_autotune_range, or as key to opentune_set_clip once the user has agreed.'
        : 'Pass recommendation.key as key to opentune_set_clip or as scale to opentune_autotune_range.',
  );

  // A section is outside the audio only when both the mix and the clip's source audio end before it.
  const audioEndSec =
    wav === null && vocals?.durationSec == null ? null : Math.max(wav?.durationSec ?? 0, vocals?.durationSec ?? 0);
  const sections =
    args.sections === undefined
      ? undefined
      : args.sections.map((s) => {
          const part = estimateKey(sourcesIn(evidence, s.start_sec, s.end_sec));
          const outside = audioEndSec !== null && s.start_sec >= audioEndSec;
          return part === null
            ? {
                start_sec: s.start_sec,
                end_sec: s.end_sec,
                candidates: [],
                scale_set_confidence: null,
                tonic_confidence: null,
                key: null,
                nullReasons: { key: outside ? 'outside_audio' : 'no_evidence' },
              }
            : {
                start_sec: s.start_sec,
                end_sec: s.end_sec,
                candidates: candidates(part, SECTION_KEYS),
                scale_set_confidence: round(part.scaleSetConfidence),
                tonic_confidence: round(part.tonicConfidence),
                key: recommendation(part, false).key as Json,
              };
        });

  return {
    summary: [lead, ...rest].join(' '),
    candidates: candidates(estimate, TOP_KEYS),
    scale_set_confidence: round(estimate.scaleSetConfidence),
    tonic_confidence: round(estimate.tonicConfidence),
    scale_set: { keys: [keyEntry(top), keyEntry(relativeIndex(top))], tonic_clear: tonicClear },
    recommendation: recommendation(estimate, changes, conflict),
    tuning_offset_cents: cents(primary?.offsetCents),
    tuning,
    sources,
    estimated_over: over,
    local_keys:
      segments === null
        ? null
        : segments.map((s) => ({
            start_sec: round(s.startSec, 2),
            end_sec: round(s.endSec, 2),
            ...keyEntry(s.key),
            scale_set_confidence: round(s.scaleSetConfidence),
          })),
    ...(sections === undefined ? {} : { sections }),
    ...(clipInfo === undefined ? {} : { clip: clipInfo }),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(Object.keys(reasons).length > 0 ? { nullReasons: reasons } : {}),
  };
}

export const estimateKeyTool = defineTool({
  name: TOOL,
  title: 'Estimate the key of a song',
  description:
    "OpenTune (audio vocal pitch editor): estimates a song's key from a clip's vocal pitch " +
    'and/or a WAV of the mix or backing (mix_path; PCM 16/24/32-bit or float32, mono or stereo). Returns the 5 best ' +
    'keys with probabilities, scale_set_confidence (relative keys share their 7 notes, which is what snapping uses) ' +
    'and tonic_confidence (both over estimated_over), tuning offset in cents, local keys (each with a confidence over ' +
    'its own segment) and keys per section (seconds on the clip; the mix starts with it). ' +
    'Pass recommendation.key to opentune_set_clip or opentune_autotune_range. Read-only.',
  inputSchema: z.strictObject({
    clip: CLIP_FIELD.optional(),
    mix_path: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe('Absolute path of a .wav file of the full mix or the backing track. Read only.'),
    sections: z
      .array(z.strictObject({ start_sec: z.number().min(0), end_sec: z.number().min(0) }))
      .min(1)
      .max(MAX_SECTIONS)
      .optional()
      .describe('Time ranges (seconds, at least 2 s long) that get a key each, for example verse and chorus.'),
    instance_id: INSTANCE_FIELD,
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  capabilities: ['read.v1'],
  otcpMethods: ['content.getDetails', 'content.getNotes', 'content.getPitchCurve', 'content.segmentNotes'],
  run: (args, ctx) => estimateSongKey(ctx, args),
});
