// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The read methods of the mock (capability read.v1): project.get, content.getNotes,
// content.getPitchCurve, content.segmentNotes, content.getDetails, transport.get, prefs.get and
// app.getLog. They read the model and never change it; reads are not gated by the analysis state
// (spec/otcp/v1/PROTOCOL.md sections 11 and 16).

import type { Handler } from './context.js';
import { refuse } from './errors.js';
import { historyView } from './history.js';
import type { ContentRec, NoteRec, PlacementRec, World } from './model.js';
import { round6 } from './model.js';
import {
  DEFAULT_NOTE_SPLIT_CENTS,
  HOP_SEC,
  detectedMidiAt,
  frameAtOrAfter,
  frameCount,
  medianDetected,
  noteName,
  segmentDetected,
} from './music.js';

const LOG_LINE_MAX = 4096;
const DEFAULT_NOTES_LIMIT = 200;
const DEFAULT_CURVE_LIMIT = 10_000;

interface Range {
  startContentSec: number;
  endContentSec: number;
}

const f0StateOf = (content: ContentRec): string =>
  content.analysis === 'running' ? 'extracting' : content.analysis === 'failed' ? 'failed' : 'ready';

const analysisFinished = (content: ContentRec): boolean =>
  content.analysis === 'ready' || content.analysis === 'unvoiced';

/** The detected pitch at a frame; an analysis that found no voice has none anywhere. */
const originalAt = (content: ContentRec, index: number): number | null =>
  content.analysis === 'ready' ? detectedMidiAt(index, content.durationSec) : null;

const gainDb = (linear: number): number | null => (linear === 0 ? null : round6(20 * Math.log10(linear)));

/** A cursor is opaque; this one holds the tokens of the read that issued it and the next offset. */
function encodeCursor(tokens: string, offset: number): string {
  return `c1.${Buffer.from(JSON.stringify({ t: tokens, o: offset }), 'utf8').toString('base64url')}`;
}

/** Section 10 rule 6: a cursor issued for other tokens than the current ones is stale. */
function decodeCursor(cursor: string, tokens: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor.replace(/^c1\./, ''), 'base64url').toString('utf8'));
  } catch {
    parsed = undefined;
  }
  const { t, o } = (parsed ?? {}) as { t?: unknown; o?: unknown };
  if (!cursor.startsWith('c1.') || typeof t !== 'string' || typeof o !== 'number' || !Number.isInteger(o) || o < 0) {
    throw refuse('INVALID_ARGUMENT', 'invalid_params', 'the cursor was not issued by this instance');
  }
  if (t !== tokens) throw refuse('REVISION_CONFLICT', 'cursor_stale', 'the tokens changed since the cursor was issued');
  return o;
}

const overlaps = (start: number, end: number, range: Range | undefined): boolean =>
  range === undefined || (start < range.endContentSec && end > range.startContentSec);

function detectedOf(content: ContentRec, note: Pick<NoteRec, 'startContentSec' | 'endContentSec'>): number | null {
  return content.analysis === 'ready'
    ? medianDetected(content.durationSec, note.startContentSec, note.endContentSec)
    : null;
}

/** A note differs from what was detected, so the corrected pitch curve differs there. */
const isCorrected = (note: NoteRec, detected: number | null): boolean =>
  detected !== null && (Math.abs(note.targetMidi - detected) >= 0.005 || note.vibratoDepth > 0);

/** The pitch OpenTune would render at frame `index`: the detected pitch pulled towards the note's target. */
function correctedAt(content: ContentRec, index: number, detected: Map<NoteRec, number | null>): number | null {
  const original = originalAt(content, index);
  if (original === null) return null;
  const t = index * HOP_SEC;
  const note = content.notes.find((n) => t >= n.startContentSec - 1e-9 && t < n.endContentSec - 1e-9);
  if (note === undefined) return original;
  if (!detected.has(note)) detected.set(note, detectedOf(content, note));
  const centre = detected.get(note) ?? null;
  if (!isCorrected(note, centre) || centre === null) return original;
  const vibrato = (note.vibratoDepth / 100) * Math.sin(2 * Math.PI * note.vibratoRateHz * (t - note.startContentSec));
  return note.targetMidi + (original - centre) * (1 - note.retuneSpeed) + vibrato;
}

/** The content a request names by contentId or placementId, and the placement it names, if any. */
function target(world: World, params: Readonly<Record<string, unknown>>) {
  if (typeof params.placementId === 'string') {
    const placement = world.placement(params.placementId);
    return { content: placement.content, placement };
  }
  return { content: world.content(String(params.contentId)), placement: undefined };
}

const readMeta = (world: World, contents: readonly ContentRec[], derived: string[] = []) => ({
  asOf: world.asOf(contents),
  derived,
});

function noteView(world: World, content: ContentRec, index: number, note: NoteRec, placement?: PlacementRec) {
  const detected = detectedOf(content, note);
  const timeline = (contentSec: number) =>
    placement === undefined
      ? null
      : round6(
          placement.startTimelineSec +
            world.contentToOutput(content, contentSec) -
            world.contentToOutput(content, placement.clipInContentSec),
        );
  return {
    index,
    label: `#${String(index)} ${noteName(note.targetMidi)} ${note.startContentSec.toFixed(2)}-${note.endContentSec.toFixed(2)}s`,
    startContentSec: round6(note.startContentSec),
    endContentSec: round6(note.endContentSec),
    startTimelineSec: timeline(note.startContentSec),
    endTimelineSec: timeline(note.endContentSec),
    detectedMidi: detected === null ? null : round6(detected),
    targetMidi: round6(note.targetMidi),
    offsetCents: round6(note.offsetCents),
    retuneSpeed: note.retuneSpeed,
    vibratoDepth: note.vibratoDepth,
    vibratoRateHz: note.vibratoRateHz,
    pitchDriftScale: note.pitchDriftScale,
    voiced: detected !== null,
    corrected: isCorrected(note, detected),
  };
}

const keyView = (content: ContentRec) => (content.key === null ? null : { ...content.key });

export const readHandlers: Readonly<Record<string, Handler>> = {
  'project.get': ({ world, hasCapability }) => {
    const contents = [...world.contents.values()];
    const placements = [...world.placements.values()];
    const hasHistory = hasCapability('history.v1');
    return {
      ...readMeta(world, contents, ['tracks[].label']),
      ...(hasHistory ? {} : { nullReasons: { history: 'capability_missing' } }),
      project: { path: world.project.path, dirty: world.project.dirty },
      tracks: world.tracks.map((track) => {
        const volume = track.volumeLinear;
        const anySolo = world.tracks.some((t) => t.solo);
        return {
          trackId: track.trackId,
          label: world.trackLabel(track.trackId),
          visible: track.visible,
          muted: track.muted,
          solo: track.solo,
          audible: !track.muted && (track.solo || !anySolo),
          volumeDb: gainDb(volume),
          volumeLinear: volume,
          colour: track.colour,
          rmsDb: null,
          placementCount: placements.filter((p) => p.trackId === track.trackId).length,
          nullReasons: { rmsDb: 'no_audio_device' },
        };
      }),
      visibleTrackCount: world.visibleTrackCount,
      activeTrackId: world.activeTrackId,
      placements: placements.map((p) => ({
        placementId: p.id,
        trackId: p.trackId,
        contentId: p.content.id,
        name: p.name,
        startTimelineSec: round6(p.startTimelineSec),
        endTimelineSec: round6(p.startTimelineSec + p.durationSec),
        durationSec: round6(p.durationSec),
        clipInContentSec: round6(p.clipInContentSec),
        gainDb: gainDb(p.gainLinear),
        gainLinear: p.gainLinear,
        fadeInSec: p.fadeInSec,
        fadeOutSec: p.fadeOutSec,
        referencePlacementId: p.reference?.id ?? null,
        sourcePath: p.content.sourcePath,
        geometryHash: p.geometryHash,
        ...(p.content.sourcePath === null ? { nullReasons: { sourcePath: 'unavailable' } } : {}),
      })),
      contents: contents.map((c) => ({
        contentId: c.id,
        f0State: f0StateOf(c),
        key: keyView(c),
        noteCount: c.notes.length,
        pitchShift: { ...c.pitchShift },
        timeGridIdentity: world.gridIsIdentity(c),
        ...(c.key === null ? { nullReasons: { key: 'not_analyzed' } } : {}),
      })),
      selection: { selectedPlacementIds: [...world.selectedPlacementIds], pianoRollContentId: null },
      transport: { ...world.transport, timeSignature: { ...world.transport.timeSignature } },
      history: hasHistory ? historyView(world) : null,
    };
  },

  'content.getNotes': ({ world, params }) => {
    const { content, placement } = target(world, params);
    const asked = params.range as Range | { startTimelineSec: number; endTimelineSec: number } | undefined;
    let range: Range | undefined;
    if (asked === undefined) {
      range = undefined;
    } else if ('startTimelineSec' in asked) {
      // A timeline range (only valid with a placement) goes back through the placement and the time grid.
      const origin =
        (placement?.startTimelineSec ?? 0) - world.contentToOutput(content, placement?.clipInContentSec ?? 0);
      range = {
        startContentSec: world.outputToContent(content, asked.startTimelineSec - origin),
        endContentSec: world.outputToContent(content, asked.endTimelineSec - origin),
      };
    } else {
      range = asked;
    }
    const wanted = content.notes
      .map((note, index) => ({ note, index }))
      .filter(({ note }) => overlaps(note.startContentSec, note.endContentSec, range));
    // The cursor is bound to the tokens and to how the notes are read: the range as given (a content
    // or a timeline range) and the placement, so a cursor of another read gets the same error as a stale one.
    const tokens = [
      content.revision,
      content.comp.grid,
      content.comp.key,
      placement?.id ?? '',
      placement?.geometryHash ?? '',
      JSON.stringify(asked ?? null),
    ].join('|');
    const offset = typeof params.cursor === 'string' ? decodeCursor(params.cursor, tokens) : 0;
    const limit = typeof params.limit === 'number' ? params.limit : DEFAULT_NOTES_LIMIT;
    const page = wanted.slice(offset, offset + limit);
    return {
      ...readMeta(world, [content]),
      contentId: content.id,
      placementId: placement?.id ?? null,
      tuningHz: world.prefs.tuningHz,
      totalCount: wanted.length,
      notes: page.map(({ note, index }) => noteView(world, content, index, note, placement)),
      nextCursor: offset + limit < wanted.length ? encodeCursor(tokens, offset + limit) : null,
    };
  },

  'content.getPitchCurve': ({ world, params }) => {
    const content = world.content(String(params.contentId));
    const range = params.range as Range | undefined;
    const step = typeof params.stepFrame === 'number' ? params.stepFrame : 1;
    const limit = typeof params.limit === 'number' ? params.limit : DEFAULT_CURVE_LIMIT;
    const frames: number[] = [];
    if (analysisFinished(content)) {
      const total = frameCount(content.durationSec);
      for (let i = range === undefined ? 0 : frameAtOrAfter(range.startContentSec); i < total; i += step) {
        if (range !== undefined && i * HOP_SEC >= range.endContentSec - 1e-9) break;
        frames.push(i);
      }
    }
    const tokens = [content.revision, content.comp.grid, String(step), JSON.stringify(range ?? null)].join('|');
    const offset = typeof params.cursor === 'string' ? decodeCursor(params.cursor, tokens) : 0;
    const page = frames.slice(offset, offset + limit);
    const round4 = (value: number | null) => (value === null ? null : Math.round(value * 1e4) / 1e4);
    const detected = new Map<NoteRec, number | null>();
    return {
      ...readMeta(world, [content]),
      contentId: content.id,
      f0State: f0StateOf(content),
      tuningHz: world.prefs.tuningHz,
      hopSec: HOP_SEC,
      stepFrame: step,
      startContentSec: round6((page[0] ?? (range === undefined ? 0 : frameAtOrAfter(range.startContentSec))) * HOP_SEC),
      pointCount: page.length,
      originalMidi: page.map((i) => round4(originalAt(content, i))),
      correctedMidi: page.map((i) => round4(correctedAt(content, i, detected))),
      nextCursor: offset + limit < frames.length ? encodeCursor(tokens, offset + limit) : null,
    };
  },

  'content.segmentNotes': ({ world, params }) => {
    const content = world.content(String(params.contentId));
    const range = params.range as Range | undefined;
    const splitCents = typeof params.noteSplitCents === 'number' ? params.noteSplitCents : DEFAULT_NOTE_SPLIT_CENTS;
    const segments = content.analysis === 'ready' ? segmentDetected(content.durationSec, splitCents) : [];
    return {
      ...readMeta(world, [content]),
      contentId: content.id,
      f0State: f0StateOf(content),
      tuningHz: world.prefs.tuningHz,
      noteSplitCents: splitCents,
      segments: segments
        .filter((s) => overlaps(s.startContentSec, s.endContentSec, range))
        .map((s) => ({
          startContentSec: round6(s.startContentSec),
          endContentSec: round6(s.endContentSec),
          detectedMidi: round6(s.detectedMidi),
        })),
    };
  },

  'content.getDetails': ({ world, params, hasCapability }) => {
    const { content, placement } = target(world, params);
    const shown = world.placementsOf(content);
    const via = placement ?? shown[0];
    if (via === undefined) throw refuse('NOT_FOUND', 'unknown_handle', 'no placement shows this content');
    const referenceBound = via.reference !== null && hasCapability('reference.v1');
    const ready = content.analysis === 'ready';
    const available = ready ? ['regenerate', 'notesOnly', ...(content.notes.length > 0 ? ['snapNotes'] : [])] : [];
    if (ready && referenceBound) available.push('reference');
    return {
      ...readMeta(world, [content]),
      ...(content.key === null ? { nullReasons: { key: 'not_analyzed' } } : {}),
      contentId: content.id,
      viaPlacementId: via.id,
      placementIds: shown.map((p) => p.id),
      durationSec: round6(content.durationSec),
      key: keyView(content),
      pitchShift: { ...content.pitchShift },
      analysis: {
        f0State: f0StateOf(content),
        failure: content.analysis === 'failed' ? 'f0_failed' : content.analysis === 'unvoiced' ? 'f0_empty' : null,
        hopSec: HOP_SEC,
      },
      render: {
        current: content.render.published === content.render.desired,
        publishedRevision: content.render.published,
        desiredRevision: content.render.desired,
      },
      timeGrid: {
        seeded: content.handles.length > 0,
        identity: world.gridIsIdentity(content),
        handles: content.handles.map((h) => ({
          handleId: h.handleId,
          contentSec: round6(h.contentSec),
          outputSec: round6(h.outputSec),
        })),
      },
      reference: {
        referencePlacementId: via.reference?.id ?? null,
        alignmentReady: content.alignmentReady,
      },
      autoModes: {
        editingScheme: world.editingScheme,
        uiButtonRuns: referenceBound ? 'reference' : world.editingScheme === 'openDyne' ? 'snapNotes' : 'regenerate',
        available,
      },
    };
  },

  'transport.get': ({ world }) => ({
    ...readMeta(world, []),
    transport: { ...world.transport, timeSignature: { ...world.transport.timeSignature } },
  }),

  'prefs.get': ({ world }) => ({
    processing: {
      tuningHz: world.prefs.tuningHz,
      editingScheme: world.editingScheme,
      hybridMode: world.prefs.hybridMode,
      vocoderWeight: null,
      f0Model: null,
      renderingPriority: null,
      experimentalFeatures: false,
      referenceAlignMode: null,
      nullReasons: {
        vocoderWeight: 'unavailable',
        f0Model: 'unavailable',
        renderingPriority: 'unavailable',
        referenceAlignMode: 'unavailable',
      },
    },
    onboardingShown: world.prefs.onboardingShown,
    language: world.prefs.language,
    recentProjects: [],
  }),

  'app.getLog': ({ world, params, redact }) => {
    const maxLines = typeof params.maxLines === 'number' ? params.maxLines : 200;
    const lines = world.logLines.slice(-maxLines).map((line) => redact(line).slice(0, LOG_LINE_MAX));
    return { lines, truncated: world.logLines.length > lines.length };
  },
};
