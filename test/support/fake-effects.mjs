// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The `effects*` modes of the stand-in executable (test/support/fake-opentune.mjs): enough of an
// instance to walk the effects scenario (test/e2e/effects.ts). It keeps notes, a pitch shift, a time
// grid and an undo history per imported clip, and its exports re-synthesise every note at the pitch
// its notes, the pitch shift and the time grid ask for, so an edit is audible in the file and a note
// that was not touched is bit-identical. Its "analysis" reads the truth file the tone generator
// writes next to its WAV (test/support/harmonic-tone.ts); no audio is analysed. Not part of the
// published package.
//
// Modes: `effects` behaves as the specification says. `effects-stale` exports the notes as they
// were imported, whatever was edited, without listing the clip as dry. `effects-unsettled` never
// settles the render of a clip nothing was corrected in, so its export times out. `effects-mixed`
// lets writes through during an export and renders the first note as it was when the export
// started and the others as they are at the end. `effects-conflict` lets writes through during an
// export and fails the export with REVISION_CONFLICT(changed_during_export). `effects-undo-broken`
// answers edit.undo without restoring anything. `effects-backend` fails the import with an
// unavailable inference backend. `effects-no-timing` does not report timing.v1, `effects-no-history`
// not history.v1.

import fs from 'node:fs';

const RATE = 44_100;
const TUNING_HZ = 440;
const HARMONICS = 8;
const FADE_SEC = 0.01;
const SHORT = '0123abcd';
const DEFAULT_PARAMS = { retuneSpeed: 0.15, vibratoDepth: 0, vibratoRateHz: 7.5, pitchDriftScale: 1 };
const NOTE_PARAMS = ['retuneSpeed', 'vibratoDepth', 'vibratoRateHz', 'pitchDriftScale'];

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

export function effectsCapabilities(mode) {
  return ['session.v1', 'jobs.v1', 'read.v1', 'import.v1', 'edit.v1', 'export.v1', 'history.v1', 'timing.v1'].filter(
    (c) =>
      !(mode === 'effects-no-timing' && c === 'timing.v1') && !(mode === 'effects-no-history' && c === 'history.v1'),
  );
}

/** The samples of a 16-bit PCM or float32 WAV file, first channel, as numbers in -1..1. */
function readSamples(file) {
  const bytes = fs.readFileSync(file);
  let at = 12;
  let format = 1;
  let channels = 1;
  let bits = 16;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      format = bytes.readUInt16LE(at + 8);
      channels = bytes.readUInt16LE(at + 10);
      bits = bytes.readUInt16LE(at + 22);
    } else if (id === 'data') {
      const width = bits / 8;
      const frames = Math.floor(size / width / channels);
      const out = new Float64Array(frames);
      for (let i = 0; i < frames; i++) {
        const p = at + 8 + i * width * channels;
        out[i] = format === 3 ? bytes.readFloatLE(p) : bytes.readInt16LE(p) / 32768;
      }
      return out;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

/** A mono float32 WAV file of `samples`. */
function wavBytes(samples) {
  const wav = Buffer.alloc(44 + samples.length * 4);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + samples.length * 4, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(32, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(samples.length * 4, 40);
  for (let i = 0; i < samples.length; i++) wav.writeFloatLE(samples[i], 44 + i * 4);
  return wav;
}

/** Content seconds to output seconds through the handles (identity outside them). */
function mapTime(handles, durationSec, t) {
  const points = [
    { contentSec: 0, outputSec: 0 },
    ...[...handles].sort((a, b) => a.contentSec - b.contentSec),
    { contentSec: durationSec, outputSec: durationSec },
  ];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (t <= b.contentSec) {
      const span = b.contentSec - a.contentSec;
      return span <= 0 ? b.outputSec : a.outputSec + ((t - a.contentSec) * (b.outputSec - a.outputSec)) / span;
    }
  }
  return t;
}

/** Re-synthesises the notes: a harmonic series at each note's pitch, placed through the time grid. */
function render(content, notes, pitchShift, handles) {
  const out = new Float64Array(Math.round(content.durationSec * RATE));
  for (const note of notes) {
    const midi = note.targetMidi + pitchShift.semitones + pitchShift.cents / 100;
    const hz = TUNING_HZ * 2 ** ((midi - 69) / 12);
    const from = Math.round(mapTime(handles, content.durationSec, note.startContentSec) * RATE);
    const to = Math.round(mapTime(handles, content.durationSec, note.endContentSec) * RATE);
    const count = to - from;
    for (let n = 0; n < count && from + n < out.length; n++) {
      const t = n / RATE;
      let v = 0;
      for (let k = 1; k <= HARMONICS; k++) v += Math.sin(2 * Math.PI * k * hz * t) / k;
      const edge = Math.min(1, t / FADE_SEC, (count / RATE - t) / FADE_SEC);
      out[from + n] = 0.2 * v * Math.max(0, edge);
    }
  }
  return out;
}

export function createEffects(mode) {
  const contents = new Map();
  const jobs = new Map();
  const undoStack = [];
  let counter = 0;
  let undoSeq = 0;
  let exportLock = null;
  const next = (prefix) => `${prefix}${(++counter).toString(16).padStart(8, '0')}`;
  const writesDuringExport = mode === 'effects-mixed' || mode === 'effects-conflict';

  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, kind, reason, detail = 'fake') => ({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: kind, data: { kind, reason, detail, retryable: false, executed: false } },
  });
  const tokens = (c) => ({
    arrangementRevision: 'a1',
    contents: [{ contentId: c.id, revision: c.revision, gridRevision: c.gridRevision, keyRevision: 'k1' }],
    placements: [],
  });
  const asOf = (c) => ({ arrangementRevision: 'a1', contents: tokens(c).contents });
  const envelope = (c, extra = {}) => ({
    applied: true,
    noOp: false,
    dryRun: false,
    changes: [],
    created: [],
    removed: [],
    idMap: [],
    revisionDiff: { arrangement: null, trackState: null, contents: [] },
    tokens: tokens(c),
    undo: { undoable: false, reason: 'ui_parity', revert: null },
    dirty: { before: true, after: true },
    ui: null,
    sideEffects: {},
    warnings: [],
    job: null,
    ...extra,
  });
  const startJob = (kind, run, polls = 1) => {
    const jobId = `j:${SHORT}:${String(jobs.size + 1)}`;
    jobs.set(jobId, { kind, run, polls, state: 'running', result: null, error: null });
    return { jobId, kind, state: 'queued' };
  };
  const snapshot = (c) => ({
    notes: c.notes.map((n) => ({ ...n })),
    pitchShift: { ...c.pitchShift },
    handles: c.handles.map((h) => ({ ...h })),
  });
  const content = (id) => contents.get(id);
  const pushUndo = (c, description, before) => {
    const undoId = `u:${SHORT}:${String(++undoSeq)}`;
    undoStack.push({ undoId, description, contentId: c.id, before });
    return { undoable: true, undoId, description, innerActions: ['FakeEdit'], steps: 1 };
  };
  const busy = (id) => (exportLock !== null && !writesDuringExport ? fail(id, 'BUSY', 'export_in_progress') : null);

  const noteChange = (c, index, before, after) => {
    const fields = {};
    for (const name of ['targetMidi', 'offsetCents', ...NOTE_PARAMS]) {
      if (before[name] !== after[name]) fields[name] = { before: before[name], after: after[name], unit: null };
    }
    return { entity: 'note', ref: { contentId: c.id, note: { index, atRevision: c.revision } }, label: null, fields };
  };

  function importItem(params) {
    const item = params.items[0];
    const truth = JSON.parse(fs.readFileSync(item.path.replace(/\.wav$/i, '.truth.json'), 'utf8'));
    const samples = readSamples(item.path);
    const serial = contents.size + 1;
    const c = {
      id: `c:${SHORT}:0:${String(serial)}`,
      placementId: `p:${SHORT}:0:${String(serial)}`,
      samples,
      durationSec: samples.length / RATE,
      truth: truth.notes,
      notes: [],
      pitchShift: { semitones: 0, cents: 0 },
      handles: [],
      revision: next('r'),
      gridRevision: next('g'),
      everCorrected: false,
    };
    if (params.generateNotes === true) {
      c.notes = truth.notes.map((n) => ({
        startContentSec: r6(n.startSec),
        endContentSec: r6(n.endSec),
        detectedMidi: r4(n.midiExact),
        targetMidi: r4(n.midiExact),
        offsetCents: 0,
        ...DEFAULT_PARAMS,
        voiced: true,
        corrected: false,
      }));
    }
    contents.set(c.id, c);
    return {
      ...envelope(c),
      items: [
        {
          path: item.path,
          imported: true,
          placementId: c.placementId,
          contentId: c.id,
          trackId: serial - 1,
          startTimelineSec: 0,
          durationSec: c.durationSec,
          channelCount: 1,
          originalSampleRateHz: RATE,
          resampled: false,
          f0State: 'ready',
          notesGenerated: params.generateNotes === true,
          notesGeneratedBy: params.generateNotes === true ? 'request' : null,
          error: null,
        },
      ],
      counts: { requested: 1, imported: 1, failed: 0 },
    };
  }

  function finishExport(job) {
    exportLock = null;
    const c = job.content;
    if (mode === 'effects-unsettled' && !c.everCorrected) {
      return { error: { kind: 'NOT_READY', reason: 'export_wait_timeout', detail: 'fake', retryable: true } };
    }
    if (mode === 'effects-conflict' && c.revision !== job.revision) {
      return { error: { kind: 'REVISION_CONFLICT', reason: 'changed_during_export', detail: 'fake', retryable: true } };
    }
    const identity = c.handles.every((h) => h.contentSec === h.outputSec);
    const dry =
      !c.notes.some((n) => n.corrected) && c.pitchShift.semitones === 0 && c.pitchShift.cents === 0 && identity;
    let samples;
    if (dry) samples = c.samples;
    else if (mode === 'effects-stale')
      samples = render(
        c,
        c.notes.map((n) => ({ ...n, targetMidi: n.detectedMidi })),
        { semitones: 0, cents: 0 },
        [],
      );
    else if (mode === 'effects-mixed')
      samples = render(
        c,
        c.notes.map((n, i) => (i === 0 ? job.notes[0] : n)),
        c.pitchShift,
        c.handles,
      );
    else samples = render(c, c.notes, c.pitchShift, c.handles);
    fs.writeFileSync(job.path, wavBytes(samples));
    return {
      result: {
        path: job.path,
        sampleRateHz: RATE,
        channelCount: 1,
        sampleFormat: 'float32',
        durationSec: c.durationSec,
        startTimelineSec: 0,
        contents: [{ contentId: c.id, revision: c.revision }],
        dryContents: dry ? [{ contentId: c.id, reason: 'nothingToRender' }] : [],
        processing: { vocoderWeight: 'fake', hybridMode: true, backend: 'fake', tuningHz: TUNING_HZ },
      },
    };
  }

  /** Applies note ops; returns the changes, or an error reply. */
  function editNotes(id, c, params) {
    const before = c.notes.map((n) => ({ ...n }));
    for (const op of params.ops) {
      const indices = op.select.all === true ? c.notes.map((_, i) => i) : op.select.indices;
      for (const i of indices) {
        const n = c.notes[i];
        if (n === undefined) return fail(id, 'NOT_FOUND', 'unknown_handle');
        if (op.op === 'setTargetPitch') Object.assign(n, { targetMidi: r4(op.targetMidi), offsetCents: 0 });
        else if (op.op === 'shiftCents') {
          Object.assign(n, {
            targetMidi: r4(n.targetMidi + op.deltaCents / 100),
            offsetCents: r4(n.offsetCents + op.deltaCents),
          });
        } else if (op.op === 'setParams') for (const name of NOTE_PARAMS) if (name in op) n[name] = op[name];
        n.corrected = true;
      }
    }
    return before;
  }

  function reply(request) {
    const { id, method, params } = request;
    if (method === 'session.info') {
      return ok(id, {
        processing: {
          tuningHz: TUNING_HZ,
          editingScheme: 'openTune',
          hybridMode: true,
          vocoderWeight: 'fake',
          f0Model: 'fake',
          renderingPriority: null,
          backend: 'fake',
          vocoderReady: true,
          vocoderReconfiguring: false,
          experimentalFeatures: false,
          referenceAlignMode: null,
        },
      });
    }
    if (method === 'import.start') {
      if (mode === 'effects-backend') return fail(id, 'MODEL_UNAVAILABLE', 'backend_unavailable');
      const job = startJob('import', () => ({ result: importItem(params) }));
      return ok(id, {
        ...envelope({ id: 'c:0:0:0', revision: 'r0', gridRevision: 'g0' }, { applied: false, undo: null }),
        job,
      });
    }
    if (method === 'job.get') {
      const job = jobs.get(params.jobId);
      if (job === undefined) return fail(id, 'NOT_FOUND', 'job_not_found');
      if (job.state === 'running') {
        job.polls--;
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
    const c = typeof params?.contentId === 'string' ? content(params.contentId) : undefined;
    if (method === 'export.start') {
      const target = [...contents.values()].find((x) => x.placementId === params.target?.placementId);
      if (target === undefined) return fail(id, 'NOT_FOUND', 'unknown_handle');
      if (exportLock !== null) return fail(id, 'BUSY', 'export_in_progress');
      if (fs.existsSync(params.path)) return fail(id, 'ALREADY_EXISTS', 'target_exists');
      const state = {
        content: target,
        path: params.path,
        revision: target.revision,
        notes: target.notes.map((n) => ({ ...n })),
      };
      exportLock = state;
      const job = startJob('export', () => finishExport(state), 2);
      return ok(id, { ...envelope(target, { applied: false, undo: null }), job });
    }
    if (c === undefined) return fail(id, 'UNSUPPORTED', 'capability_missing');
    if (method === 'content.getDetails') {
      const settled = !(mode === 'effects-unsettled' && !c.everCorrected);
      return ok(id, {
        asOf: asOf(c),
        derived: [],
        contentId: c.id,
        pitchShift: c.pitchShift,
        analysis: { f0State: 'ready', failure: null, hopSec: 0.01 },
        render: {
          current: settled,
          publishedRevision: settled ? c.revision : 'unsettled',
          desiredRevision: c.revision,
        },
        timeGrid: {
          seeded: c.handles.length > 0,
          identity: c.handles.every((h) => h.contentSec === h.outputSec),
          minHandleSpacingSec: 0.03,
          handles: c.handles,
        },
        autoModes: {
          editingScheme: 'openTune',
          uiButtonRuns: 'regenerate',
          available: ['regenerate', 'snapNotes', 'notesOnly'],
        },
      });
    }
    if (method === 'content.getNotes') {
      const limit = params.limit ?? 200;
      const all = c.notes.map((n, index) => ({
        index,
        label: null,
        startTimelineSec: null,
        endTimelineSec: null,
        ...n,
      }));
      return ok(id, {
        asOf: asOf(c),
        derived: [],
        contentId: c.id,
        placementId: null,
        tuningHz: TUNING_HZ,
        totalCount: all.length,
        notes: all.slice(0, limit),
        nextCursor: null,
      });
    }
    const refused = busy(id);
    if (refused !== null) return refused;
    if (method === 'content.editNotes') {
      if (params.expectedRevision !== c.revision) return fail(id, 'REVISION_CONFLICT', 'content_changed');
      const before = snapshot(c);
      const notesBefore = editNotes(id, c, params);
      if (!Array.isArray(notesBefore)) return notesBefore;
      c.revision = next('r');
      c.everCorrected = true;
      const changes = c.notes
        .map((n, i) => noteChange(c, i, notesBefore[i], n))
        .filter((ch) => Object.keys(ch.fields).length > 0);
      return ok(id, { ...envelope(c, { changes, undo: pushUndo(c, 'edit notes', before) }), omittedChangeCount: 0 });
    }
    if (method === 'content.setPitchShift') {
      const before = snapshot(c);
      const fields = {};
      for (const name of ['semitones', 'cents']) {
        if (c.pitchShift[name] !== params.pitchShift[name]) {
          fields[name] = { before: c.pitchShift[name], after: params.pitchShift[name], unit: name };
        }
      }
      c.pitchShift = { ...params.pitchShift };
      const changes = [{ entity: 'pitchShift', ref: { contentId: c.id }, label: null, fields }];
      return ok(id, envelope(c, { changes, undo: pushUndo(c, 'pitch shift', before) }));
    }
    if (method === 'content.autoTune') {
      if (params.expectedRevision !== c.revision) return fail(id, 'REVISION_CONFLICT', 'content_changed');
      const before = snapshot(c);
      const old = c.notes.map((n) => ({ ...n }));
      for (const n of c.notes) {
        const target = Math.round(n.targetMidi);
        if (params.mode === 'regenerate') Object.assign(n, DEFAULT_PARAMS);
        Object.assign(n, {
          offsetCents: r4(n.offsetCents + (target - n.targetMidi) * 100),
          targetMidi: target,
          corrected: true,
        });
      }
      c.revision = next('r');
      c.everCorrected = true;
      const changes = c.notes
        .map((n, i) => noteChange(c, i, old[i], n))
        .filter((ch) => Object.keys(ch.fields).length > 0);
      return ok(id, {
        ...envelope(c, { changes, undo: pushUndo(c, 'auto tune', before) }),
        mode: params.mode,
        keyUsed: params.key,
        paramsUsed: params.mode === 'snapNotes' ? null : { ...DEFAULT_PARAMS, noteSplitCents: 80 },
        noteCount: { before: c.notes.length, after: c.notes.length },
        omittedCount: { changes: 0, created: 0, removed: 0 },
      });
    }
    if (method === 'content.editTimeGrid' && params.op === 'seed') {
      const job = startJob('timeGridSeed', () => {
        if (c.handles.length === 0) {
          c.handles = c.notes.map((n, i) => ({
            handleId: String(i + 2),
            contentSec: n.startContentSec,
            outputSec: n.startContentSec,
          }));
          c.gridRevision = next('g');
        }
        return { result: { ...envelope(c), clamped: [] } };
      });
      return ok(id, { ...envelope(c, { applied: false, undo: null }), job, clamped: [] });
    }
    if (method === 'content.shiftTiming') {
      if (params.expectedGridRevision !== c.gridRevision) return fail(id, 'REVISION_CONFLICT', 'grid_changed');
      const before = snapshot(c);
      const { startContentSec, endContentSec } = params.range;
      const changes = [];
      c.handles = c.handles.map((h) => {
        if (h.contentSec < startContentSec || h.contentSec > endContentSec) return h;
        const outputSec = r6(h.outputSec + params.deltaSec);
        changes.push({
          entity: 'timeHandle',
          ref: { contentId: c.id, handleId: h.handleId },
          label: null,
          fields: { outputSec: { before: h.outputSec, after: outputSec, unit: 'sec' } },
        });
        return { ...h, outputSec };
      });
      c.gridRevision = next('g');
      return ok(id, { ...envelope(c, { changes, undo: pushUndo(c, 'move handles', before) }), clamped: [] });
    }
    return fail(id, 'UNSUPPORTED', 'capability_missing');
  }

  function undo(request) {
    const { id, params } = request;
    const refused = busy(id);
    if (refused !== null) return refused;
    const top = undoStack.at(-1);
    if (top === undefined) return fail(id, 'UNDO_CONFLICT', 'history_empty');
    if (top.undoId !== params.expectedUndoId) return fail(id, 'UNDO_CONFLICT', 'top_mismatch');
    undoStack.pop();
    const c = content(top.contentId);
    const changes = [];
    if (mode !== 'effects-undo-broken') {
      const revision = c.revision;
      const gridRevision = c.gridRevision;
      if (JSON.stringify(c.notes) !== JSON.stringify(top.before.notes)) c.revision = next('r');
      if (JSON.stringify(c.handles) !== JSON.stringify(top.before.handles)) c.gridRevision = next('g');
      c.notes = top.before.notes;
      c.pitchShift = top.before.pitchShift;
      c.handles = top.before.handles;
      if (revision !== c.revision) {
        changes.push({
          entity: 'content',
          ref: { contentId: c.id },
          label: null,
          fields: { revision: { before: revision, after: c.revision, unit: null } },
        });
      }
      if (gridRevision !== c.gridRevision) {
        changes.push({
          entity: 'content',
          ref: { contentId: c.id },
          label: null,
          fields: { gridRevision: { before: gridRevision, after: c.gridRevision, unit: null } },
        });
      }
    }
    return ok(id, {
      ...envelope(c, {
        changes,
        undo: {
          undoable: false,
          reason: 'ui_parity',
          revert: { method: 'edit.redo', params: { expectedUndoId: top.undoId } },
        },
      }),
      entry: {
        undoId: top.undoId,
        description: top.description,
        origin: 'control',
        possiblyStale: false,
        unsafe: false,
      },
    });
  }

  return {
    capabilities: effectsCapabilities(mode),
    reply: (request) => (request.method === 'edit.undo' ? undo(request) : reply(request)),
  };
}
