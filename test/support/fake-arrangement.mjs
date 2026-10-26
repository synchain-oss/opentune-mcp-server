// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The `arrangement*` modes of the stand-in executable (test/support/fake-opentune.mjs): enough of an
// instance to walk the arrangement effects scenario (test/e2e/arrangement-effects.ts). It keeps
// tracks, clips (placements) and their contents, and renders the master mix from the imported source
// samples with the clip gain, the fades, mute/solo and the split the arrangement holds, so every
// write is audible in the export and a track that is not heard is zero.
//
// `arrangement` behaves as the specification says. The other modes get one thing wrong, each for the
// check that is about it: `arrangement-gain-wrong` renders a setGain 3 dB away from the value it
// reports, `arrangement-gain-misreport` reports a wrong `after` value in `changes`,
// `arrangement-fade-step` applies the fades as steps at the wrong end, `arrangement-mute-leak` leaves
// a muted track at -60 dB, `arrangement-solo-broken` ignores solo, `arrangement-track-misreport`
// reports a wrong mute value, `arrangement-revert-broken` ignores every track.set after the first
// (the revert), `arrangement-undo-broken` answers edit.undo without restoring anything,
// `arrangement-undo-missing` says a setGain cannot be undone, `arrangement-split-gap` drops one
// sample at the split, and `arrangement-split-misreport` leaves the trailing clip out of `created`.
// `arrangement-export-fails-in-mute` fails the export of the first mute case and
// `arrangement-export-fails-after-merge` the export after the merge of the split check.
// `arrangement-export-other-path` reports another file than the one asked for.
// `arrangement-split-extra-part` leaves a third, very quiet clip inside the split clip, so that the project
// shows three clips where a split leaves two (the merge of the split check cannot find its two clips).
// The checks for move, trim, copy, delete, track volume, track duplicate, track delete and batch import
// each have modes that get one thing wrong. `arrangement-move-wrong` renders a moved clip 50 ms late,
// `arrangement-trim-not-rendered` keeps sounding the cut part of a trimmed clip, `arrangement-copy-offset`
// renders a copy two samples late, `arrangement-delete-ghost` keeps a deleted clip in the export that
// follows the delete, `arrangement-delete-unconfirmed` deletes a clip or a track without `confirm`,
// `arrangement-volume-ignored` ignores the track volume in the export, `arrangement-duplicate-silent`
// renders a duplicated track without sound, `arrangement-share-copies` gives a shared duplicate a
// content of its own, `arrangement-share-notes-lost` deletes the notes of a shared content with its
// duplicate, `arrangement-track-delete-keeps-sound` keeps a deleted track in the export that follows the
// delete, `arrangement-track-delete-bad-map` reports a wrong `trackIdMap`, `arrangement-import-no-revert`
// gives an import no revert recipe, `arrangement-import-gap` renders the second sequential clip 10 ms
// late and `arrangement-import-separate-offset` renders the second separate-track clip 0.1 s late. The
// stand-in keeps twelve track slots and shows the first; an import, a copy or a duplicate shows the next
// hidden one. It starts a clip at the sample that truncating its start in seconds names, as OpenTune does.
// `arrangement-no-arrangement`, `arrangement-no-tracks` and `arrangement-no-history` do not report
// the capability of that name; `arrangement-backend` fails the import with an unavailable inference
// backend; `arrangement-hybrid` reports hybrid mode on. Its "analysis" reads the truth file the tone
// generator writes next to its WAV (test/support/harmonic-tone.ts); no audio is analysed. Not part
// of the published package.

import fs from 'node:fs';

import { readSamples } from './fake-effects.mjs';

const RATE = 44_100;
const TUNING_HZ = 440;
const SHORT = '0123abcd';
const NOTE_PARAMS = { retuneSpeed: 0.5, vibratoDepth: 0, vibratoRateHz: 7.5, pitchDriftScale: 1 };
const GAIN_RANGE_DB = { min: -60, max: 12 };
const SLOT_COUNT = 12;

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

export function arrangementCapabilities(mode) {
  return [
    'session.v1',
    'jobs.v1',
    'read.v1',
    'import.v1',
    'export.v1',
    'arrangement.v1',
    'tracks.v1',
    'history.v1',
  ].filter(
    (c) =>
      !(mode === 'arrangement-no-arrangement' && c === 'arrangement.v1') &&
      !(mode === 'arrangement-no-tracks' && c === 'tracks.v1') &&
      !(mode === 'arrangement-no-history' && c === 'history.v1'),
  );
}

/** A stereo float32 WAV of interleaved left and right samples. */
function stereoWav(left, right) {
  const frames = Math.min(left.length, right.length);
  const wav = Buffer.alloc(44 + frames * 8);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + frames * 8, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 8, 28);
  wav.writeUInt16LE(8, 32);
  wav.writeUInt16LE(32, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(frames * 8, 40);
  for (let i = 0; i < frames; i++) {
    wav.writeFloatLE(left[i] ?? 0, 44 + i * 8);
    wav.writeFloatLE(right[i] ?? 0, 48 + i * 8);
  }
  return wav;
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const clonePlacements = (placements) => new Map([...placements].map(([id, p]) => [id, clone(p)]));

export function createArrangement(mode) {
  let exportFailed = false;
  const contents = new Map();
  const placements = new Map();
  // OpenTune has twelve track slots and shows the first one only; an import, a copy or a duplicate shows more.
  const tracks = new Map(
    Array.from({ length: SLOT_COUNT }, (_, trackId) => [
      trackId,
      { trackId, muted: false, solo: false, volumeDb: 0, volumeLinear: 1, colour: '#808080', visible: trackId === 0 },
    ]),
  );
  /** Clips a defect mode keeps in the mix after they have left the project. */
  const ghosts = [];
  const jobs = new Map();
  const undoStack = [];
  let revision = 0;
  let contentSeq = 0;
  let placementSeq = 0;
  let hashSeq = 0;
  let undoSeq = 0;
  let jobSeq = 0;
  let trackCalls = 0;

  const arrangementRevision = () => `a${revision}`;
  const bump = () => {
    revision += 1;
    return arrangementRevision();
  };
  const newHash = () => `h${(hashSeq += 1)}`;
  const newPlacementId = () => {
    placementSeq += 1;
    return `p:${SHORT}:0:${placementSeq}`;
  };
  const contentToken = (c) => ({
    contentId: c.id,
    revision: c.revision,
    gridRevision: c.gridRevision,
    keyRevision: c.keyRevision,
  });
  const tokens = () => ({
    arrangementRevision: arrangementRevision(),
    contents: [...contents.values()].map(contentToken),
    placements: [...placements.values()].map((p) => ({ placementId: p.id, geometryHash: p.geometryHash })),
  });
  const asOf = () => ({
    arrangementRevision: arrangementRevision(),
    contents: [...contents.values()].map(contentToken),
  });
  const anySolo = () => [...tracks.values()].some((t) => t.solo);
  /** Whether a track is heard while `soloed` says whether any track is soloed (a fixed snapshot). */
  const audibleWith = (track, soloed) => {
    if (mode === 'arrangement-solo-broken') return !track.muted;
    return !track.muted && (track.solo || !soloed);
  };
  const audibleOf = (track) => audibleWith(track, anySolo());
  const envelope = (extra = {}) => ({
    applied: true,
    noOp: false,
    dryRun: false,
    changes: [],
    created: [],
    removed: [],
    idMap: [],
    revisionDiff: { arrangement: null, trackState: null, contents: [] },
    tokens: tokens(),
    undo: { undoable: false, reason: 'ui_parity', revert: null },
    dirty: { before: true, after: true },
    ui: null,
    sideEffects: {},
    warnings: [],
    job: null,
    ...extra,
  });
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, kind, reason) => ({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: kind, data: { kind, reason, detail: 'fake', retryable: false, executed: false } },
  });
  const startJob = (kind, run, polls = 1) => {
    jobSeq += 1;
    const jobId = `j:${SHORT}:${String(jobSeq)}`;
    jobs.set(jobId, { kind, run, polls, state: 'running', result: null, error: null });
    return { jobId, kind, state: 'queued' };
  };
  const placementChange = (before, after, fields) => ({
    entity: 'placement',
    ref: { placementId: after.id },
    label: null,
    fields: Object.fromEntries(
      fields
        .filter(([name]) => before[name] !== after[name])
        .map(([name, unit]) => [name, { before: before[name], after: after[name], unit }]),
    ),
  });

  /** A fresh track slot; the model keeps SLOT_COUNT of them and shows the first one only. */
  function newSlot(trackId, visible) {
    return { trackId, muted: false, solo: false, volumeDb: 0, volumeLinear: 1, colour: '#808080', visible };
  }

  /**
   * The track an import lands on: the named one, the first without clips (newTrack), which is shown if
   * it was hidden, or the active one; null when newTrack finds none.
   */
  function pickTrack(params) {
    if (typeof params.trackId === 'number') return params.trackId;
    if (params.newTrack === true) {
      const used = new Set([...placements.values()].map((p) => p.trackId));
      const free = [...tracks.values()].find((t) => !used.has(t.trackId));
      if (free === undefined) return null;
      free.visible = true;
      return free.trackId;
    }
    return 0;
  }

  /** A content of its own made from the samples of another (or from a window of them). */
  function newContent(samples, notes) {
    contentSeq += 1;
    return {
      id: `c:${SHORT}:0:${String(contentSeq)}`,
      samples,
      durationSec: samples.length / RATE,
      revision: `r${String((revision += 1))}`,
      gridRevision: `g${String((revision += 1))}`,
      keyRevision: `k${String((revision += 1))}`,
      notes,
    };
  }

  /** The clip a copy of `src` is: same gain and fades, a content of its own, and the place asked for. */
  function copyOf(src, contentId, trackId, startTimelineSec, clipInContentSec) {
    const copy = clone(src);
    delete copy.audioShiftSec;
    delete copy.audioShiftSamples;
    delete copy.renderEndSec;
    delete copy.silent;
    return {
      ...copy,
      id: newPlacementId(),
      trackId,
      contentId,
      startTimelineSec: r6(startTimelineSec),
      endTimelineSec: r6(startTimelineSec + src.durationSec),
      clipInContentSec,
      geometryHash: newHash(),
    };
  }

  const createdEntry = (entity, ref) => ({ entity, ref, label: null });

  /** Imports the files of one import.start in the layout asked for; returns the job result or an error object. */
  function importItems(params) {
    const layout = params.layout ?? 'single';
    const items = Array.isArray(params.items) ? params.items : [];
    const target = pickTrack(params);
    if (target === null || (layout === 'separateTracks' && target + items.length > tracks.size)) {
      return { error: { kind: 'INVALID_ARGUMENT', reason: 'track_capacity' } };
    }
    const done = [];
    const created = [];
    for (const [k, item] of items.entries()) {
      const truth = JSON.parse(fs.readFileSync(item.path.replace(/\.wav$/i, '.truth.json'), 'utf8'));
      const samples = readSamples(item.path);
      const content = newContent(
        samples,
        truth.notes.map((note, index) => ({
          index,
          startContentSec: r6(note.startSec),
          endContentSec: r6(note.endSec),
          detectedMidi: r4(note.midiExact),
          targetMidi: r4(note.midiExact),
          offsetCents: 0,
          ...NOTE_PARAMS,
          voiced: true,
          corrected: false,
        })),
      );
      contents.set(content.id, content);
      const trackId = layout === 'separateTracks' ? target + k : target;
      const track = tracks.get(trackId);
      track.visible = true;
      const lastEnd = [...placements.values()]
        .filter((p) => p.trackId === trackId)
        .reduce((most, p) => Math.max(most, p.endTimelineSec), 0);
      const startTimelineSec =
        k === 0 && typeof params.startTimelineSec === 'number' ? params.startTimelineSec : lastEnd;
      const placement = {
        id: newPlacementId(),
        trackId,
        contentId: content.id,
        startTimelineSec: r6(startTimelineSec),
        endTimelineSec: r6(startTimelineSec + content.durationSec),
        durationSec: r6(content.durationSec),
        clipInContentSec: 0,
        gainDb: 0,
        gainLinear: 1,
        fadeInSec: 0,
        fadeOutSec: 0,
        geometryHash: newHash(),
      };
      // The defects of the batch layouts: the second clip sounds later than the project says.
      if (mode === 'arrangement-import-gap' && layout === 'sequential' && k === 1) placement.audioShiftSec = 0.01;
      if (mode === 'arrangement-import-separate-offset' && layout === 'separateTracks' && k === 1) {
        placement.audioShiftSec = 0.1;
      }
      placements.set(placement.id, placement);
      created.push(
        createdEntry('placement', { placementId: placement.id }),
        createdEntry('content', { contentId: content.id }),
      );
      done.push({
        path: item.path,
        imported: true,
        placementId: placement.id,
        contentId: content.id,
        trackId,
        startTimelineSec: placement.startTimelineSec,
        durationSec: content.durationSec,
        channelCount: 1,
        originalSampleRateHz: RATE,
        resampled: false,
        f0State: 'ready',
        notesGenerated: params.generateNotes === true,
        notesGeneratedBy: params.generateNotes === true ? 'request' : null,
        error: null,
      });
    }
    bump();
    return {
      ...envelope({
        applied: true,
        created,
        // The defect of the import check: no revert recipe, though the instance has arrangement.v1.
        warnings: mode === 'arrangement-import-no-revert' ? [{ code: 'IRREVERSIBLE', subject: null, data: null }] : [],
        undo: {
          undoable: false,
          reason: 'ui_parity',
          revert:
            mode === 'arrangement-import-no-revert'
              ? null
              : {
                  method: 'arrangement.edit',
                  params: {
                    expectedArrangementRevision: arrangementRevision(),
                    ops: [{ op: 'delete', placementIds: done.map((d) => d.placementId) }],
                  },
                  requiresConsent: true,
                },
        },
      }),
      items: done,
      counts: { requested: items.length, imported: done.length, failed: 0 },
    };
  }

  function projectGet() {
    const used = (trackId) => [...placements.values()].filter((p) => p.trackId === trackId).length;
    return {
      asOf: asOf(),
      derived: [],
      project: { path: null, dirty: true },
      tracks: [...tracks.values()].map((t) => ({
        trackId: t.trackId,
        label: `Track ${String(t.trackId + 1)}`,
        visible: t.visible,
        muted: t.muted,
        solo: t.solo,
        audible: audibleOf(t),
        volumeDb: t.volumeDb,
        volumeLinear: t.volumeLinear,
        colour: t.colour,
        rmsDb: null,
        placementCount: used(t.trackId),
      })),
      visibleTrackCount: [...tracks.values()].filter((t) => t.visible).length,
      activeTrackId: 0,
      placements: [...placements.values()].map((p) => ({
        placementId: p.id,
        trackId: p.trackId,
        contentId: p.contentId,
        name: null,
        startTimelineSec: p.startTimelineSec,
        endTimelineSec: p.endTimelineSec,
        durationSec: p.durationSec,
        clipInContentSec: p.clipInContentSec,
        gainDb: p.gainDb,
        gainLinear: p.gainLinear,
        fadeInSec: p.fadeInSec,
        fadeOutSec: p.fadeOutSec,
        sourcePath: null,
        geometryHash: p.geometryHash,
      })),
      contents: [...contents.values()].map((c) => ({
        contentId: c.id,
        f0State: 'ready',
        key: { root: 0, scale: 'chromatic', origin: 'automatic', confidence: 1 },
        noteCount: c.notes.length,
        pitchShift: { semitones: 0, cents: 0 },
        timeGridIdentity: true,
      })),
      selection: { selectedPlacementIds: [], pianoRollContentId: null },
      transport: {
        playing: false,
        positionTimelineSec: 0,
        playStartTimelineSec: 0,
        loopEnabled: false,
        bpm: 120,
        timeSignature: { numerator: 4, denominator: 4 },
        audioDeviceRunning: false,
        lastControl: null,
      },
      history: null,
      nullReasons: { history: 'no_history' },
    };
  }

  /** Applies one trim; returns the changes and the new placement. */
  function applyTrim(p, edge, toTimelineSec) {
    const before = clone(p);
    if (edge === 'end') {
      const limit = p.startTimelineSec + (contents.get(p.contentId).durationSec - p.clipInContentSec);
      if (!(toTimelineSec > p.startTimelineSec) || toTimelineSec > limit + 1e-6) return null;
      // The defect of the trim check: a trim that leaves a clip under 1.5 s is not rendered.
      if (mode === 'arrangement-trim-not-rendered' && toTimelineSec - p.startTimelineSec < 1.5) {
        p.renderEndSec = p.endTimelineSec;
      }
      p.endTimelineSec = r6(toTimelineSec);
      p.durationSec = r6(p.endTimelineSec - p.startTimelineSec);
    } else if (edge === 'start') {
      if (!(toTimelineSec < p.endTimelineSec) || toTimelineSec < p.startTimelineSec - p.clipInContentSec) return null;
      const moved = toTimelineSec - p.startTimelineSec;
      p.startTimelineSec = r6(toTimelineSec);
      p.clipInContentSec = r6(p.clipInContentSec + moved);
      p.durationSec = r6(p.endTimelineSec - p.startTimelineSec);
    } else {
      return null;
    }
    p.geometryHash = newHash();
    return placementChange(before, p, [
      ['startTimelineSec', 'sec'],
      ['endTimelineSec', 'sec'],
      ['durationSec', 'sec'],
      ['clipInContentSec', 'sec'],
    ]);
  }

  /** Sets one clip gain; returns the changes or null when the placement does not exist. */
  function applySetGain(p, op, warnings) {
    if (p === undefined) return null;
    const before = clone(p);
    let requested;
    if (typeof op.gainDb === 'number') requested = op.gainDb;
    else if (op.gainLinear === 0) requested = GAIN_RANGE_DB.min;
    else if (typeof op.gainLinear === 'number') requested = 20 * Math.log10(op.gainLinear);
    else return null;
    const applied = Math.max(GAIN_RANGE_DB.min, Math.min(GAIN_RANGE_DB.max, requested));
    if (applied !== requested) {
      warnings.push({
        code: 'CLAMPED',
        subject: { placementId: p.id },
        data: { field: 'gainDb', requested, applied },
      });
    }
    p.gainDb = r4(applied);
    p.gainLinear = r6(10 ** (applied / 20));
    p.geometryHash = newHash();
    if (mode === 'arrangement-gain-wrong') p.audioGainDb = r4(applied + 3);
    const change = placementChange(before, p, [
      ['gainDb', 'db'],
      ['gainLinear', 'linear'],
    ]);
    if (mode === 'arrangement-gain-misreport' && change.fields.gainDb !== undefined) {
      change.fields.gainDb.after = r4(applied + 1);
    }
    return change;
  }

  /** Sets the fades of one clip; returns the changes or null when the placement does not exist. */
  function applySetFade(p, op, warnings) {
    if (p === undefined) return null;
    const before = clone(p);
    const requestedIn = typeof op.fadeInSec === 'number' ? op.fadeInSec : p.fadeInSec;
    const requestedOut = typeof op.fadeOutSec === 'number' ? op.fadeOutSec : p.fadeOutSec;
    const appliedIn = Math.max(0, Math.min(p.durationSec, requestedIn));
    const appliedOut = Math.max(0, Math.min(p.durationSec, requestedOut));
    if (appliedIn !== requestedIn) {
      warnings.push({
        code: 'CLAMPED',
        subject: { placementId: p.id },
        data: { field: 'fadeInSec', requested: requestedIn, applied: appliedIn },
      });
    }
    if (appliedOut !== requestedOut) {
      warnings.push({
        code: 'CLAMPED',
        subject: { placementId: p.id },
        data: { field: 'fadeOutSec', requested: requestedOut, applied: appliedOut },
      });
    }
    p.fadeInSec = r6(appliedIn);
    p.fadeOutSec = r6(appliedOut);
    p.geometryHash = newHash();
    return placementChange(before, p, [
      ['fadeInSec', 'sec'],
      ['fadeOutSec', 'sec'],
    ]);
  }

  /** Cuts one clip in two; returns the write-envelope members of the split or an error object. */
  function applySplit(p, op, warnings) {
    if (p === undefined) return { error: { kind: 'NOT_FOUND', reason: 'unknown_handle' } };
    const requested = op.atTimelineSec;
    const applied = Math.round(requested * 100) / 100;
    if (!(applied > p.startTimelineSec + 1e-9) || !(applied < p.endTimelineSec - 1e-9)) {
      return { error: { kind: 'INVALID_ARGUMENT', reason: 'split_out_of_range' } };
    }
    if (Math.abs(applied - requested) > 1e-9) {
      warnings.push({
        code: 'SPLIT_SNAPPED',
        subject: { placementId: p.id },
        data: { requestedTimelineSec: requested, appliedTimelineSec: applied },
      });
    }
    const before = clone(p);
    const leading = {
      ...clone(p),
      id: newPlacementId(),
      endTimelineSec: r6(applied),
      durationSec: r6(applied - p.startTimelineSec),
      fadeOutSec: 0,
      geometryHash: newHash(),
    };
    const trailing = {
      ...clone(p),
      id: newPlacementId(),
      startTimelineSec: r6(applied),
      durationSec: r6(p.endTimelineSec - applied),
      clipInContentSec: r6(p.clipInContentSec + (applied - p.startTimelineSec)),
      fadeInSec: 0,
      geometryHash: newHash(),
    };
    if (mode === 'arrangement-split-gap') trailing.skipFirstSample = true;
    placements.delete(p.id);
    placements.set(leading.id, leading);
    placements.set(trailing.id, trailing);
    if (mode === 'arrangement-split-extra-part') {
      const extra = {
        ...clone(leading),
        id: newPlacementId(),
        endTimelineSec: r6(p.startTimelineSec + 0.1),
        durationSec: 0.1,
        gainDb: -60,
        gainLinear: 0.001,
        fadeInSec: 0,
        fadeOutSec: 0,
        geometryHash: newHash(),
      };
      placements.set(extra.id, extra);
    }
    bump();
    const created = [
      { entity: 'placement', ref: { placementId: leading.id }, label: null },
      ...(mode === 'arrangement-split-misreport'
        ? []
        : [{ entity: 'placement', ref: { placementId: trailing.id }, label: null }]),
    ];
    const removed = [{ entity: 'placement', ref: { placementId: p.id }, label: null }];
    const idMap = [
      {
        entity: 'placement',
        relation: 'split',
        from: [{ placementId: p.id }],
        to: [{ placementId: leading.id }, { placementId: trailing.id }],
      },
    ];
    warnings.push({ code: 'UPSTREAM_UNDO_DEFECT', subject: { placementId: before.id }, data: null });
    return {
      created,
      removed,
      idMap,
      warnings,
      undo: {
        undoable: false,
        reason: 'upstream_undo_defect',
        revert: {
          method: 'arrangement.edit',
          params: {
            expectedArrangementRevision: arrangementRevision(),
            ops: [{ op: 'merge', leadingPlacementId: leading.id, trailingPlacementId: trailing.id }],
          },
        },
      },
    };
  }

  /** Joins two clips; returns the write-envelope members of the merge or an error object. */
  function applyMerge(leading, trailing, warnings) {
    if (leading === undefined || trailing === undefined)
      return { error: { kind: 'NOT_FOUND', reason: 'unknown_handle' } };
    const adjacent = Math.abs(trailing.startTimelineSec - leading.endTimelineSec) <= 1e-6;
    const sameContent = leading.contentId === trailing.contentId && leading.trackId === trailing.trackId;
    const continues =
      Math.abs(
        leading.clipInContentSec + (trailing.startTimelineSec - leading.startTimelineSec) - trailing.clipInContentSec,
      ) <= 1e-6;
    const sameGain = Math.abs(leading.gainDb - trailing.gainDb) <= 1e-9;
    if (!adjacent || !sameContent || !continues || !sameGain) {
      return { error: { kind: 'INVALID_ARGUMENT', reason: 'merge_not_possible' } };
    }
    const merged = {
      ...clone(leading),
      id: newPlacementId(),
      endTimelineSec: trailing.endTimelineSec,
      durationSec: r6(trailing.endTimelineSec - leading.startTimelineSec),
      fadeOutSec: trailing.fadeOutSec,
      geometryHash: newHash(),
    };
    placements.delete(leading.id);
    placements.delete(trailing.id);
    placements.set(merged.id, merged);
    bump();
    warnings.push({ code: 'UPSTREAM_UNDO_DEFECT', subject: { placementId: merged.id }, data: null });
    return {
      created: [{ entity: 'placement', ref: { placementId: merged.id }, label: null }],
      removed: [
        { entity: 'placement', ref: { placementId: leading.id }, label: null },
        { entity: 'placement', ref: { placementId: trailing.id }, label: null },
      ],
      idMap: [
        {
          entity: 'placement',
          relation: 'merge',
          from: [{ placementId: leading.id }, { placementId: trailing.id }],
          to: [{ placementId: merged.id }],
        },
      ],
      warnings,
      undo: {
        undoable: false,
        reason: 'upstream_undo_defect',
        revert: {
          method: 'arrangement.edit',
          params: {
            expectedArrangementRevision: arrangementRevision(),
            ops: [{ op: 'split', placementId: merged.id, atTimelineSec: leading.endTimelineSec }],
          },
        },
      },
    };
  }

  /** Moves one clip in time, to another track, or both; returns the change or an error object. */
  function applyMove(p, op, warnings) {
    if (p === undefined) return { error: { kind: 'NOT_FOUND', reason: 'unknown_handle' } };
    const trackId = typeof op.toTrackId === 'number' ? op.toTrackId : p.trackId;
    const track = tracks.get(trackId);
    if (track === undefined) return { error: { kind: 'NOT_FOUND', reason: 'unknown_handle' } };
    const before = clone(p);
    const start = typeof op.startTimelineSec === 'number' ? op.startTimelineSec : p.startTimelineSec;
    p.trackId = trackId;
    p.startTimelineSec = r6(start);
    p.endTimelineSec = r6(start + p.durationSec);
    p.geometryHash = newHash();
    if (!track.visible) {
      track.visible = true;
      warnings.push({ code: 'TRACK_AUTO_REVEALED', subject: { trackId }, data: null });
    }
    // The defect of the move check: the clip sounds 50 ms later than the project says.
    if (mode === 'arrangement-move-wrong' && typeof op.startTimelineSec === 'number') p.audioShiftSec = 0.05;
    return {
      change: placementChange(before, p, [
        ['trackId', null],
        ['startTimelineSec', 'sec'],
        ['endTimelineSec', 'sec'],
      ]),
    };
  }

  /** Removes clips (op delete, which needs confirm); returns the write-envelope members or an error object. */
  function applyDelete(op, params, warnings) {
    const ids = Array.isArray(op.placementIds) ? op.placementIds : [];
    const found = ids.map((id) => placements.get(id));
    if (found.some((p) => p === undefined)) return { error: { kind: 'NOT_FOUND', reason: 'unknown_handle' } };
    // The defect of the delete checks: a delete is carried out without the end user's consent.
    if (params.confirm !== true && params.dryRun !== true && mode !== 'arrangement-delete-unconfirmed') {
      return { error: { kind: 'INVALID_ARGUMENT', reason: 'confirm_required' } };
    }
    ghosts.length = 0;
    for (const p of found) {
      placements.delete(p.id);
      // The defect of the delete check: the clip is gone from the project but still sounds in the
      // export that follows the delete (the one the check compares with the baseline).
      if (mode === 'arrangement-delete-ghost') ghosts.push(p);
      warnings.push({ code: 'UPSTREAM_UNDO_DEFECT', subject: { placementId: p.id }, data: null });
      warnings.push({ code: 'IRREVERSIBLE', subject: { placementId: p.id }, data: null });
    }
    bump();
    return {
      removed: found.map((p) => createdEntry('placement', { placementId: p.id })),
      undo: { undoable: false, reason: 'upstream_undo_defect', revert: null },
    };
  }

  /** Copies clips to a track, as pasting (window) and duplicating (full) do; returns the result or an error object. */
  function arrangementCopy(params) {
    if (params.expectedArrangementRevision !== arrangementRevision()) {
      return { error: { kind: 'REVISION_CONFLICT', reason: 'arrangement_changed' } };
    }
    const target = tracks.get(params.toTrackId);
    const sources = (Array.isArray(params.sources) ? params.sources : []).map((s) => placements.get(s.placementId));
    if (target === undefined || sources.length === 0 || sources.some((s) => s === undefined)) {
      return { error: { kind: 'NOT_FOUND', reason: 'unknown_handle' } };
    }
    const earliest = Math.min(...sources.map((s) => s.startTimelineSec));
    const created = [];
    const idMap = [];
    const warnings = [];
    const newIds = [];
    for (const src of sources) {
      const content = contents.get(src.contentId);
      const window = params.mode === 'window';
      const from = Math.round(src.clipInContentSec * RATE);
      const to = from + Math.round(src.durationSec * RATE);
      const copied = newContent(
        window ? content.samples.slice(from, to) : content.samples.slice(),
        content.notes.map((note) => clone(note)),
      );
      contents.set(copied.id, copied);
      const start = params.startTimelineSec + (src.startTimelineSec - earliest);
      const copy = copyOf(src, copied.id, target.trackId, start, window ? 0 : src.clipInContentSec);
      // The defect of the copy checks: the copy sounds two samples late.
      if (mode === 'arrangement-copy-offset') copy.audioShiftSamples = 2;
      const others = [...placements.values()].filter((p) => p.trackId === target.trackId);
      if (others.some((p) => p.startTimelineSec === copy.startTimelineSec && p.id === src.id)) {
        warnings.push({ code: 'STACKED_ON_SOURCE', subject: { placementId: copy.id }, data: null });
      } else if (
        others.some((p) => p.startTimelineSec < copy.endTimelineSec && copy.startTimelineSec < p.endTimelineSec)
      ) {
        warnings.push({ code: 'OVERLAPS_CLIP', subject: { placementId: copy.id }, data: null });
      }
      placements.set(copy.id, copy);
      newIds.push(copy.id);
      created.push(
        createdEntry('placement', { placementId: copy.id }),
        createdEntry('content', { contentId: copied.id }),
      );
      idMap.push({
        entity: 'placement',
        relation: 'copy',
        from: [{ placementId: src.id }],
        to: [{ placementId: copy.id }],
      });
    }
    const sideEffects = {};
    if (!target.visible) {
      target.visible = true;
      warnings.push({ code: 'TRACK_AUTO_REVEALED', subject: { trackId: target.trackId }, data: null });
      sideEffects.tracksRevealed = { trackIds: [target.trackId], revert: null };
    }
    bump();
    return envelope({
      created,
      idMap,
      warnings,
      sideEffects,
      undo: {
        undoable: false,
        reason: 'ui_parity',
        revert: {
          method: 'arrangement.edit',
          params: {
            expectedArrangementRevision: arrangementRevision(),
            ops: [{ op: 'delete', placementIds: newIds }],
          },
          requiresConsent: true,
        },
      },
    });
  }

  /** Duplicates a shown track to the first hidden slot; returns the result or an error object. */
  function trackDuplicate(params) {
    const source = tracks.get(params.trackId);
    if (source === undefined) return { error: { kind: 'NOT_FOUND', reason: 'unknown_handle' } };
    if (!source.visible) return { error: { kind: 'INVALID_ARGUMENT', reason: 'track_hidden' } };
    const slot = [...tracks.values()].find((t) => !t.visible);
    if (slot === undefined) return { error: { kind: 'INVALID_ARGUMENT', reason: 'track_limit' } };
    if ([...placements.values()].some((p) => p.trackId === slot.trackId)) {
      return { error: { kind: 'INVALID_ARGUMENT', reason: 'target_track_occupied' } };
    }
    const share = params.mode === 'share';
    const hidden = clone(slot);
    for (const name of ['muted', 'solo', 'volumeDb', 'volumeLinear', 'colour']) slot[name] = source[name];
    slot.visible = true;
    const fields = {};
    for (const name of ['visible', 'muted', 'solo', 'volumeDb', 'volumeLinear', 'colour']) {
      if (hidden[name] !== slot[name]) fields[name] = { before: hidden[name], after: slot[name], unit: null };
    }
    const created = [];
    const idMap = [];
    const warnings = [];
    for (const src of [...placements.values()].filter((p) => p.trackId === source.trackId)) {
      const content = contents.get(src.contentId);
      let contentId = src.contentId;
      // The defect of the share check: a shared duplicate that copies the contents after all.
      if (!share || mode === 'arrangement-share-copies') {
        const copied = newContent(
          content.samples.slice(),
          content.notes.map((note) => clone(note)),
        );
        contents.set(copied.id, copied);
        contentId = copied.id;
        created.push(createdEntry('content', { contentId }));
      }
      const copy = copyOf(src, contentId, slot.trackId, src.startTimelineSec, src.clipInContentSec);
      // The defect of the duplicate checks: the copied clips are in the project but not in the mix.
      if (mode === 'arrangement-duplicate-silent') copy.silent = true;
      placements.set(copy.id, copy);
      created.push(createdEntry('placement', { placementId: copy.id }));
      idMap.push({
        entity: 'placement',
        relation: 'copy',
        from: [{ placementId: src.id }],
        to: [{ placementId: copy.id }],
      });
    }
    if (share && mode !== 'arrangement-share-copies') {
      warnings.push({ code: 'SHARED_CONTENT', subject: { trackId: slot.trackId }, data: null });
    }
    bump();
    return {
      ...envelope({
        changes: [{ entity: 'track', ref: { trackId: slot.trackId }, label: null, fields }],
        created,
        idMap,
        warnings,
        undo: {
          undoable: false,
          reason: 'ui_parity',
          revert: {
            method: 'track.delete',
            params: { trackId: slot.trackId, expectedArrangementRevision: arrangementRevision() },
            requiresConsent: true,
          },
        },
      }),
      newTrackId: slot.trackId,
    };
  }

  /** Deletes a shown track; later shown tracks move down by one. Returns the result or an error object. */
  function trackDelete(params) {
    if (params.expectedArrangementRevision !== arrangementRevision()) {
      return { error: { kind: 'REVISION_CONFLICT', reason: 'arrangement_changed' } };
    }
    const track = tracks.get(params.trackId);
    if (track === undefined) return { error: { kind: 'NOT_FOUND', reason: 'unknown_handle' } };
    if (params.confirm !== true && mode !== 'arrangement-delete-unconfirmed') {
      return { error: { kind: 'INVALID_ARGUMENT', reason: 'confirm_required' } };
    }
    if (!track.visible) return { error: { kind: 'INVALID_ARGUMENT', reason: 'track_hidden' } };
    const shown = [...tracks.values()]
      .filter((t) => t.visible)
      .map((t) => t.trackId)
      .sort((a, b) => a - b);
    if (shown.length === 1) return { error: { kind: 'INVALID_ARGUMENT', reason: 'last_track' } };
    const index = shown.indexOf(params.trackId);
    const removed = [];
    ghosts.length = 0;
    for (const p of [...placements.values()].filter((q) => q.trackId === params.trackId)) {
      placements.delete(p.id);
      // The defect of the share check: deleting a shared copy takes the notes of the shared content.
      if (
        mode === 'arrangement-share-notes-lost' &&
        [...placements.values()].some((q) => q.contentId === p.contentId)
      ) {
        contents.get(p.contentId).notes = [];
      }
      // The defect of the track delete check: the clips of the deleted track still sound.
      if (mode === 'arrangement-track-delete-keeps-sound') ghosts.push(p);
      removed.push(createdEntry('placement', { placementId: p.id }));
    }
    const changes = [];
    const trackIdMap = [{ before: params.trackId, after: mode === 'arrangement-track-delete-bad-map' ? 0 : null }];
    for (let j = index + 1; j < shown.length; j++) {
      const from = tracks.get(shown[j]);
      const to = tracks.get(shown[j - 1]);
      for (const name of ['muted', 'solo', 'volumeDb', 'volumeLinear', 'colour']) to[name] = from[name];
      for (const p of placements.values()) {
        if (p.trackId !== shown[j]) continue;
        const before = clone(p);
        p.trackId = shown[j - 1];
        p.geometryHash = newHash();
        changes.push(placementChange(before, p, [['trackId', null]]));
      }
      trackIdMap.push({ before: shown[j], after: shown[j - 1] });
    }
    const last = tracks.get(shown.at(-1));
    Object.assign(last, newSlot(last.trackId, false));
    bump();
    return {
      ...envelope({
        changes,
        removed,
        warnings: [{ code: 'IRREVERSIBLE', subject: { trackId: params.trackId }, data: null }],
        undo: { undoable: false, reason: 'no_upstream_undo', revert: null },
      }),
      trackIdMap,
      possiblyStaleEntries: { undo: 0, redo: 0 },
    };
  }

  /** Applies the ops of one arrangement.edit; returns the result members or an error object. */
  function arrangementEdit(params) {
    if (params.expectedArrangementRevision !== arrangementRevision()) {
      return { error: { kind: 'REVISION_CONFLICT', reason: 'arrangement_changed' } };
    }
    const ops = Array.isArray(params.ops) ? params.ops : [];
    const before = clonePlacements(placements);
    const changes = [];
    const created = [];
    const removed = [];
    const idMap = [];
    const warnings = [];
    let undo;
    for (const op of ops) {
      if (op.op === 'setGain' || op.op === 'setFade' || op.op === 'trim') {
        const p = placements.get(op.placementId);
        if (p === undefined) return { error: { kind: 'NOT_FOUND', reason: 'unknown_handle' } };
        const change =
          op.op === 'setGain'
            ? applySetGain(p, op, warnings)
            : op.op === 'setFade'
              ? applySetFade(p, op, warnings)
              : applyTrim(p, op.edge, op.toTimelineSec);
        if (change === null) return { error: { kind: 'INVALID_ARGUMENT', reason: 'trim_out_of_range' } };
        if (Object.keys(change.fields).length > 0) changes.push(change);
        bump();
      } else if (op.op === 'move') {
        const moved = applyMove(placements.get(op.placementId), op, warnings);
        if (moved.error !== undefined) return moved;
        if (Object.keys(moved.change.fields).length > 0) changes.push(moved.change);
        bump();
      } else if (op.op === 'delete') {
        const deleted = applyDelete(op, params, warnings);
        if (deleted.error !== undefined) return deleted;
        removed.push(...deleted.removed);
        undo = deleted.undo;
      } else if (op.op === 'split') {
        const applied = applySplit(placements.get(op.placementId), op, warnings);
        if (applied.error !== undefined) return applied;
        created.push(...applied.created);
        removed.push(...applied.removed);
        idMap.push(...applied.idMap);
        undo = applied.undo;
      } else if (op.op === 'merge') {
        const applied = applyMerge(
          placements.get(op.leadingPlacementId),
          placements.get(op.trailingPlacementId),
          warnings,
        );
        if (applied.error !== undefined) return applied;
        created.push(...applied.created);
        removed.push(...applied.removed);
        idMap.push(...applied.idMap);
        undo = applied.undo;
      } else {
        return { error: { kind: 'UNSUPPORTED', reason: 'capability_missing' } };
      }
    }
    if (undo === undefined) {
      undoSeq += 1;
      const undoId = `u:${SHORT}:${String(undoSeq)}`;
      undoStack.push({ undoId, before });
      undo =
        mode === 'arrangement-undo-missing' && ops.some((op) => op.op === 'setGain')
          ? { undoable: false, reason: 'ui_parity', revert: null }
          : {
              undoable: true,
              undoId,
              description: 'arrangement edit',
              innerActions: ['FakeArrangementEdit'],
              steps: 1,
            };
    }
    return {
      ...envelope({ changes, created, removed, idMap, warnings, undo }),
      omittedChangeCount: 0,
    };
  }

  function trackSet(params) {
    trackCalls += 1;
    const apply = !(mode === 'arrangement-revert-broken' && trackCalls > 1);
    const beforeTracks = new Map([...tracks].map(([id, t]) => [id, clone(t)]));
    const settings = Array.isArray(params.tracks) ? params.tracks : [];
    const revert = [];
    for (const setting of settings) {
      const track = tracks.get(setting.trackId);
      if (track === undefined) return { error: { kind: 'NOT_FOUND', reason: 'unknown_handle' } };
      const previous = {};
      if (typeof setting.muted === 'boolean') previous.muted = track.muted;
      if (typeof setting.solo === 'boolean') previous.solo = track.solo;
      if (typeof setting.volumeDb === 'number' || typeof setting.volumeLinear === 'number')
        previous.volumeDb = track.volumeDb;
      if (typeof setting.colour === 'string') previous.colour = track.colour;
      revert.push({ trackId: setting.trackId, ...previous });
      if (!apply) continue;
      if (typeof setting.muted === 'boolean') track.muted = setting.muted;
      if (typeof setting.solo === 'boolean') track.solo = setting.solo;
      if (typeof setting.volumeDb === 'number') {
        track.volumeDb = setting.volumeDb;
        track.volumeLinear = r6(10 ** (setting.volumeDb / 20));
      } else if (typeof setting.volumeLinear === 'number') {
        track.volumeLinear = setting.volumeLinear;
        track.volumeDb = setting.volumeLinear === 0 ? null : 20 * Math.log10(setting.volumeLinear);
      }
      if (typeof setting.colour === 'string') track.colour = setting.colour;
    }
    const beforeAnySolo = [...beforeTracks.values()].some((t) => t.solo);
    const afterAnySolo = [...tracks.values()].some((t) => t.solo);
    const changes = [];
    for (const [id, track] of tracks) {
      const before = beforeTracks.get(id);
      if (before === undefined) continue;
      const fields = {};
      for (const [name, unit] of [
        ['muted', null],
        ['solo', null],
        ['volumeDb', 'db'],
        ['volumeLinear', 'linear'],
        ['colour', null],
      ]) {
        if (before[name] !== track[name]) fields[name] = { before: before[name], after: track[name], unit };
      }
      const audibleBefore = audibleWith(before, beforeAnySolo);
      const audibleAfter = audibleWith(track, afterAnySolo);
      if (audibleBefore !== audibleAfter) {
        fields.audible = { before: audibleBefore, after: audibleAfter, unit: null };
      }
      if (Object.keys(fields).length > 0) changes.push({ entity: 'track', ref: { trackId: id }, label: null, fields });
    }
    if (mode === 'arrangement-track-misreport' && changes.length > 0) {
      const fields = changes[0].fields;
      if (fields.muted !== undefined) fields.muted.after = !fields.muted.after;
      else if (fields.solo !== undefined) fields.solo.after = !fields.solo.after;
    }
    return {
      ...envelope({
        changes,
        undo: { undoable: false, reason: 'ui_parity', revert: { method: 'track.set', params: { tracks: revert } } },
      }),
    };
  }

  function finishExport(job) {
    // The ghosts of a defect mode sound in the export after the delete they belong to, and only there,
    // so that the revert recipes of the other checks do not fail with them.
    const ghostExport = {
      'arrangement-delete-ghost': /-after-delete.wav$/,
      'arrangement-track-delete-keeps-sound': /-after-track-delete.wav$/,
    }[mode];
    const heard = ghostExport === undefined || ghostExport.test(job.path) ? ghosts : [];
    const list = [...placements.values(), ...heard];
    if (list.length === 0) return { error: { kind: 'INVALID_ARGUMENT', reason: 'nothing_to_export' } };
    // Where a clip sounds: its place, moved by the defects that make it sound elsewhere than it says.
    const shiftOf = (p) => Math.round((p.audioShiftSec ?? 0) * RATE) + (p.audioShiftSamples ?? 0);
    // A position in seconds becomes a sample by truncating, as OpenTune does: a clip at 4.1 s sounds
    // from sample 180809, one sample before the sample that rounding names. The end is rounded.
    const soundsFrom = (p) => Math.trunc(p.startTimelineSec * RATE) + shiftOf(p);
    const soundsTo = (p) => Math.round((p.renderEndSec ?? p.endTimelineSec) * RATE) + shiftOf(p);
    const frames = list.reduce((most, p) => Math.max(most, soundsTo(p)), 0);
    const left = new Float64Array(frames);
    const right = new Float64Array(frames);
    for (const p of list) {
      if (p.silent === true) continue;
      const track = tracks.get(p.trackId);
      if (track === undefined) continue;
      const audible = audibleOf(track);
      if (!audible && mode !== 'arrangement-mute-leak') continue;
      let gain =
        10 ** ((mode === 'arrangement-gain-wrong' && p.audioGainDb !== undefined ? p.audioGainDb : p.gainDb) / 20);
      if (mode !== 'arrangement-volume-ignored') gain *= track.volumeLinear;
      if (!audible) gain *= 1e-3;
      const content = contents.get(p.contentId);
      if (content === undefined) continue;
      const start = soundsFrom(p);
      const count = soundsTo(p) - start;
      const source = Math.round(p.clipInContentSec * RATE);
      for (let n = 0; n < count; n++) {
        const at = start + n;
        if (at < 0 || at >= frames) break;
        const t = n / RATE;
        let g = gain;
        if (p.fadeInSec > 0 && mode !== 'arrangement-fade-step') g *= Math.min(1, t / p.fadeInSec);
        if (p.fadeOutSec > 0 && mode !== 'arrangement-fade-step') {
          g *= Math.max(0, Math.min(1, (p.durationSec - t) / p.fadeOutSec));
        }
        let sample = content.samples[source + n] ?? 0;
        if (mode === 'arrangement-split-gap' && p.skipFirstSample === true && n === 0) sample = 0;
        left[at] = (left[at] ?? 0) + sample * g;
        right[at] = (right[at] ?? 0) + sample * g;
      }
    }
    // `arrangement-export-other-path` writes the file next to the one asked for and reports that one.
    const written = mode === 'arrangement-export-other-path' ? `${job.path}.other.wav` : job.path;
    fs.writeFileSync(written, stereoWav(left, right));
    return {
      result: {
        path: written,
        sampleRateHz: RATE,
        channelCount: 2,
        sampleFormat: 'float32',
        durationSec: r6(frames / RATE),
        startTimelineSec: 0,
        contents: [...contents.values()].map((c) => ({ contentId: c.id, revision: c.revision })),
        dryContents: [...contents.values()].map((c) => ({ contentId: c.id, reason: 'nothingToRender' })),
        processing: {
          vocoderWeight: 'fake',
          hybridMode: mode === 'arrangement-hybrid',
          backend: 'fake',
          tuningHz: TUNING_HZ,
        },
      },
    };
  }

  function editUndo(request) {
    const { id, params } = request;
    if (undoStack.length === 0) return fail(id, 'UNDO_CONFLICT', 'history_empty');
    const top = undoStack.at(-1);
    if (top.undoId !== params.expectedUndoId) return fail(id, 'UNDO_CONFLICT', 'top_mismatch');
    undoStack.pop();
    if (mode !== 'arrangement-undo-broken') {
      placements.clear();
      for (const [placementId, placement] of clonePlacements(top.before)) placements.set(placementId, placement);
      bump();
    }
    return ok(id, {
      ...envelope({ undo: { undoable: false, reason: 'ui_parity', revert: null } }),
      entry: {
        undoId: top.undoId,
        description: 'arrangement edit',
        origin: 'control',
        possiblyStale: false,
        unsafe: false,
      },
    });
  }

  function reply(request) {
    const { id, method, params } = request;
    if (method === 'session.info') {
      return ok(id, {
        processing: {
          tuningHz: TUNING_HZ,
          editingScheme: 'openTune',
          hybridMode: mode === 'arrangement-hybrid',
          vocoderWeight: 'fake',
          f0Model: 'fake',
          renderingPriority: null,
          backend: 'fake',
          vocoderReady: true,
          vocoderReconfiguring: false,
          experimentalFeatures: false,
        },
      });
    }
    if (method === 'import.start') {
      if (mode === 'arrangement-backend') return fail(id, 'MODEL_UNAVAILABLE', 'backend_unavailable');
      const job = startJob(
        'import',
        () => {
          const imported = importItems(params);
          return imported.error === undefined ? { result: imported } : { error: imported.error };
        },
        0,
      );
      return ok(id, { ...envelope({ applied: false, undo: null }), job });
    }
    if (method === 'job.get') {
      const job = jobs.get(params.jobId);
      if (job === undefined) return fail(id, 'NOT_FOUND', 'job_not_found');
      if (job.state === 'running') {
        job.polls -= 1;
        if (job.polls < 0) {
          const { result, error } = job.run();
          job.state = error === undefined ? 'succeeded' : 'failed';
          job.result = result ?? null;
          job.error =
            error === undefined ? null : { code: -32000, message: error.kind, data: { ...error, executed: true } };
        }
      }
      return ok(id, {
        job: {
          jobId: params.jobId,
          kind: job.kind,
          state: job.state,
          cancellable: false,
          createdAtMs: 0,
          updatedAtMs: 0,
          finishedAtMs: job.state === 'running' ? null : 1,
          progress: { fraction: null, phase: null, itemsDone: null, itemsTotal: null },
          result: job.result,
          error: job.error,
        },
      });
    }
    if (method === 'project.get') return ok(id, projectGet());
    if (method === 'content.getDetails') {
      const c = contents.get(params.contentId);
      if (c === undefined) return fail(id, 'NOT_FOUND', 'unknown_handle');
      return ok(id, {
        asOf: asOf(),
        derived: [],
        contentId: c.id,
        pitchShift: { semitones: 0, cents: 0 },
        key: { root: 0, scale: 'chromatic', origin: 'automatic', confidence: 1 },
        analysis: { f0State: 'ready', failure: null, hopSec: 0.01 },
        render: { current: true, publishedRevision: c.revision, desiredRevision: c.revision },
        timeGrid: { seeded: false, identity: true, minHandleSpacingSec: 0.01, handles: [] },
        autoModes: { editingScheme: 'openTune', uiButtonRuns: 'regenerate', available: ['regenerate', 'snapNotes'] },
      });
    }
    if (method === 'content.getNotes') {
      const c = contents.get(params.contentId);
      if (c === undefined) return fail(id, 'NOT_FOUND', 'unknown_handle');
      const limit = params.limit ?? 200;
      return ok(id, {
        asOf: asOf(),
        derived: [],
        contentId: c.id,
        placementId: null,
        tuningHz: TUNING_HZ,
        totalCount: c.notes.length,
        notes: c.notes.slice(0, limit).map((n) => ({
          index: n.index,
          label: null,
          startTimelineSec: null,
          endTimelineSec: null,
          startContentSec: n.startContentSec,
          endContentSec: n.endContentSec,
          detectedMidi: n.detectedMidi,
          targetMidi: n.targetMidi,
          offsetCents: n.offsetCents,
          retuneSpeed: n.retuneSpeed,
          vibratoDepth: n.vibratoDepth,
          vibratoRateHz: n.vibratoRateHz,
          pitchDriftScale: n.pitchDriftScale,
          voiced: n.voiced,
          corrected: n.corrected,
        })),
        nextCursor: null,
      });
    }
    if (method === 'arrangement.edit') {
      const result = arrangementEdit(params);
      return result.error === undefined ? ok(id, result) : fail(id, result.error.kind, result.error.reason);
    }
    if (method === 'track.set') {
      const result = trackSet(params);
      return result.error === undefined ? ok(id, result) : fail(id, result.error.kind, result.error.reason);
    }
    const routed = {
      'arrangement.copy': arrangementCopy,
      'track.duplicate': trackDuplicate,
      'track.delete': trackDelete,
    }[method];
    if (routed !== undefined) {
      const result = routed(params);
      return result.error === undefined ? ok(id, result) : fail(id, result.error.kind, result.error.reason);
    }
    if (method === 'export.start') {
      if (params.kind !== 'master') return fail(id, 'UNSUPPORTED', 'capability_missing');
      if (fs.existsSync(params.path)) return fail(id, 'ALREADY_EXISTS', 'target_exists');
      // The export of the first mute case and the one after the merge fail; the files are named
      // arrangement-<n>-<label>.wav, so the label tells them apart from the others.
      if (mode === 'arrangement-export-fails-in-mute' && !exportFailed && /-mute-track-\d+\.wav$/.test(params.path)) {
        exportFailed = true;
        return fail(id, 'INTERNAL', 'export_failed');
      }
      if (mode === 'arrangement-export-fails-after-merge' && /-after-merge\.wav$/.test(params.path)) {
        return fail(id, 'INTERNAL', 'export_failed');
      }
      const job = startJob('export', () => finishExport({ path: params.path }), 0);
      return ok(id, { ...envelope({ applied: false, undo: null }), job });
    }
    return fail(id, 'UNSUPPORTED', 'capability_missing');
  }

  return {
    capabilities: arrangementCapabilities(mode),
    reply: (request) => (request.method === 'edit.undo' ? editUndo(request) : reply(request)),
  };
}
