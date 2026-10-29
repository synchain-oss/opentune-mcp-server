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
//
// Modes about the report of a write; each one applies the setTargetPitch edit as it should and gets
// only its result wrong: `effects-undo-missing` says the edit cannot be undone, `effects-undo-garbled`
// gives an undoId that is not a string, `effects-tokens-missing` leaves out the tokens, and
// `effects-reply-lost` answers with an error. `effects-down-misreport` lets writes through during an
// export, exports the notes as they are when it ends, and reports a wrong `offsetCents` for a write
// made during the export. `effects-extra-fields` reports a field in every note change that the
// specification does not have (yet).
//
// Modes about rendering: `effects-hybrid` reports hybrid mode on (in session.info and every export)
// and renders as `effects` does. `effects-resynth`, `effects-resynth-far` and
// `effects-resynth-detuned` render notes after an edited note again, as a vocoder that re-synthesises
// a stretch does (see reached() below). Every other mode reports hybrid mode off.
//
// Modes about the vocoder weight (prefs.get, prefs.set and the sound of an export): `effects` offers the
// weights `fake` and `fake-b`, takes the second by a prefsApply job, hands back the revert recipe of the
// switch, and renders a note with fewer overtones under `fake-b` (the same pitch, another sound).
// `effects-one-weight` offers one weight only, `effects-no-options` leaves processing.options out of
// prefs.get as an instance of an earlier release candidate does, `effects-weights-alike` renders both
// weights as the same sound, `effects-weight-revert-broken` gives a revert recipe that names the weight
// just set, and `effects-weight-stuck` accepts a switch back to the first weight and keeps the second one.
//
// Modes about a damaged export: the export of a clip nothing was corrected in (the first export of the
// scenario, which should be the source as it is) holds the notes at the wrong pitch, as an instance that
// shifts or bends what it should leave alone would. `effects-export-offset` renders every note 30
// cents sharp, `effects-export-glide` bends every note from 20 to 200 cents sharp over its length (its
// own pitch is not steady), and `effects-export-one-off` renders only the second note 100 cents
// sharp. Later exports render as `effects` does.
//
// Preferences: `prefs.get` and `prefs.set` keep tuningHz and hybridMode of the instance (user-global in
// OpenTune, here per instance), and `prefs.set` answers with the changes, the warnings, the
// reRenderQueued side effect of a hybrid mode change and the revert recipe. A note keeps its pitch in
// Hz; the A4 reference only decides how the API reads and writes it (stored midi + 12 log2(440 /
// tuningHz)) and what AUTO rounds to, so a changed reference is not retroactive. The render path the
// instance started with renders as `effects` does; the other hybrid mode state renders every note up to
// 2 cents off and, when it is hybrid mode on, leaves a correction below 75 cents unapplied, as the
// lighter path of OpenTune does. `effects-no-prefs` does not report prefs.write.
//
// Notes with a pitch trajectory (the truth file holds `contourCents`, see harmonic-tone.ts) are cut
// where the pitch strays from the running median of the note by more than the split sensitivity (80
// cents at import; AUTO regenerate takes `params.noteSplitCents`), and render the trajectory
// scaled by pitchDriftScale * (1 - retuneSpeed) plus a vibrato of 0.91 * vibratoDepth cents at
// vibratoRateHz (the factor OpenTune showed).
//
// Modes about the new notes parameters and preferences; each one gets one effect wrong and nothing
// else: `effects-split-ignored` cuts at 80 cents whatever AUTO is asked for (and says it used what was
// asked), `effects-snap-ignored` leaves a note where it is on snapToScale, `effects-vibrato-ignored`
// stores the vibrato and does not render it, `effects-vibrato-wrong-rate` renders it at half the rate,
// `effects-drift-ignored` renders the drift whatever pitchDriftScale says, `effects-tuning-ignored` has AUTO
// round to the semitones of 440 Hz, `effects-hybrid-ignored` changes the preference and renders as before,
// `effects-pref-stuck` ignores a second change of a preference (so its revert recipe does nothing),
// `effects-hybrid-export-fails` fails every export while the hybrid mode is not the one it began with (a
// check that fails half-way must still put the preference back), and `effects-move-ignored` answers
// moveHandles with a move it did not make.
//
// Modes about the revert recipe of prefs.set (the recipe is data the instance returns; the preference
// must be put back from what prefs.get read at the start when it is not usable): `effects-pref-recipe-missing`
// gives none, `effects-pref-recipe-foreign` names another method (`prefs.wipe`, which this stand-in does not
// have), `effects-pref-recipe-extra` carries the other preference with a value it must not set, and
// `effects-hybrid-export-fails-foreign` is `effects-hybrid-export-fails` with the foreign recipe (the put-back
// then runs as the cleanup of a check that failed half-way).
//
// Modes about the clip after a time-grid move is taken back: once moveHandles was applied, every export
// of the clip is rendered again in another phase (`effects-undo-rephased`, as OpenTune renders the whole
// clip again: the same sound at other samples) or, from the grid being identity again, 10 cents sharp
// (`effects-undo-detuned`).

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

/** Where a note keeps the part of its trajectory it was cut from (not enumerable on the wire: a Symbol). */
const SRC = Symbol('source');
const CONTOUR_HOP_SEC = 0.01;
const DEFAULT_SPLIT_CENTS = 80;
/** The size of the vibrato OpenTune rendered for a depth, relative to the depth. */
const VIBRATO_RESPONSE = 0.91;
/** Below this correction (cents) the lighter path of the other hybrid mode leaves a note as it was. */
const HYBRID_THRESHOLD_CENTS = 75;
/** What the lighter path does to the pitch of every note, by the parity of its index (cents). */
const LIGHTER_DETUNE_CENTS = [0.5, -2];
const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  pentatonicMajor: [0, 2, 4, 7, 9],
  pentatonicMinor: [0, 3, 5, 7, 10],
};

/** The pitch of the scale nearest to `midi`; a tie goes up. */
function nearestInScale(midi, root, scale) {
  const classes = SCALES[scale] ?? SCALES.chromatic;
  const base = Math.floor(midi / 12) * 12;
  let best = Number.NaN;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const octave of [-12, 0, 12]) {
    for (const pitchClass of classes) {
      const candidate = base + octave + ((pitchClass + root) % 12);
      const distance = Math.abs(candidate - midi);
      if (distance < bestDistance - 1e-9 || (Math.abs(distance - bestDistance) <= 1e-9 && candidate > best)) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }
  return best;
}

/** The median of the values (the upper one of two). */
function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Cuts a trajectory where it strays from the running median of its piece by more than `splitCents`. */
function segmentContour(contour, splitCents) {
  const pieces = [];
  let from = 0;
  let frames = [];
  for (const [k, c] of contour.entries()) {
    if (frames.length > 0 && Math.abs(c - medianOf(frames)) > splitCents) {
      pieces.push([from, k]);
      from = k;
      frames = [];
    }
    frames.push(c);
  }
  pieces.push([from, contour.length]);
  return pieces;
}

/** The notes a clip is cut into, from the truth file of its tone, at a split sensitivity (cents). */
function notesFromTruth(truthNotes, splitCents) {
  const notes = [];
  for (const n of truthNotes) {
    const make = (start, end, detected, extra = {}) => ({
      startContentSec: r6(start),
      endContentSec: r6(end),
      detectedMidi: r4(detected),
      targetMidi: r4(detected),
      offsetCents: 0,
      ...DEFAULT_PARAMS,
      voiced: true,
      corrected: false,
      ...extra,
    });
    if (!Array.isArray(n.contourCents)) {
      notes.push(make(n.startSec, n.endSec, n.midiExact));
      continue;
    }
    for (const [a, b] of segmentContour(n.contourCents, splitCents)) {
      const piece = n.contourCents.slice(a, b);
      const median = medianOf(piece);
      const end = b >= n.contourCents.length ? n.endSec : n.startSec + b * CONTOUR_HOP_SEC;
      notes.push(
        make(n.startSec + a * CONTOUR_HOP_SEC, end, n.midiExact + median / 100, { [SRC]: { contour: piece, median } }),
      );
    }
  }
  return notes;
}

/** The trajectory of a piece at `t` seconds into it, in cents from its median. */
function contourAt(src, t) {
  if (src === undefined) return 0;
  const x = Math.max(0, t / CONTOUR_HOP_SEC);
  const i = Math.min(src.contour.length - 1, Math.floor(x));
  const j = Math.min(src.contour.length - 1, i + 1);
  const a = src.contour[i] ?? 0;
  const b = src.contour[j] ?? a;
  return a + (b - a) * (x - i) - src.median;
}

export function effectsCapabilities(mode) {
  return [
    'session.v1',
    'jobs.v1',
    'read.v1',
    'import.v1',
    'edit.v1',
    'export.v1',
    'history.v1',
    'timing.v1',
    'prefs.write',
  ].filter(
    (c) =>
      !(mode === 'effects-no-timing' && c === 'timing.v1') &&
      !(mode === 'effects-no-history' && c === 'history.v1') &&
      !(mode === 'effects-no-prefs' && c === 'prefs.write'),
  );
}

/** The samples of a 16-bit PCM or float32 WAV file, first channel, as numbers in -1..1. */
export function readSamples(file) {
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

/** Whether a note's target is not where it was detected (the note was edited). */
const moved = (note) => note !== undefined && Math.abs(note.targetMidi - note.detectedMidi) > 1e-9;

/**
 * How the `effects-resynth*` modes render a note that an edit before it reaches, the way a vocoder
 * that synthesises a stretch again does: `effects-resynth` renders the note right after an edited
 * note in another phase (same pitch and level), `effects-resynth-far` the two notes after it, and
 * `effects-resynth-detuned` the note right after it 10 cents sharp. The offset follows from the
 * edited note alone, so taking the edit back renders the note as before.
 */
function reached(mode, notes, i, hz) {
  const note = notes[i];
  const previous = notes[i - 1];
  if (!mode.startsWith('effects-resynth') || moved(note)) return { hz, delaySec: 0 };
  if (mode === 'effects-resynth-detuned') return { hz: moved(previous) ? hz * 2 ** (10 / 1200) : hz, delaySec: 0 };
  const near = moved(previous) ? previous : mode === 'effects-resynth-far' && moved(notes[i - 2]) ? notes[i - 2] : null;
  if (near === null) return { hz, delaySec: 0 };
  const turn = 0.25 + 0.5 * (Math.abs(near.targetMidi - near.detectedMidi) % 1);
  return { hz, delaySec: turn / hz };
}

/**
 * Re-synthesises the notes: a harmonic series at each note's pitch, placed through the time grid. `path`
 * is the render path when it is not the one the instance started with ({ lighter, leaveSmall }, see the
 * header). A note with a trajectory (SRC) renders it scaled by pitchDriftScale * (1 - retuneSpeed), and
 * every note with a vibrato depth renders the vibrato; those notes are synthesised by phase accumulation.
 * The overtone k has the amplitude 1 / k ** rolloff: another rolloff is another sound at the same pitch (the other
 * vocoder weight).
 */
function render(content, notes, pitchShift, handles, mode = '', path = {}, rolloff = 1) {
  const amplitude = (k) => (rolloff === 1 ? k : k ** rolloff);
  const out = new Float64Array(Math.round(content.durationSec * RATE));
  for (const [i, note] of notes.entries()) {
    let target = note.targetMidi;
    if (path.leaveSmall && moved(note) && Math.abs(target - note.detectedMidi) * 100 < HYBRID_THRESHOLD_CENTS) {
      target = note.detectedMidi;
    }
    const detune = path.lighter ? (LIGHTER_DETUNE_CENTS[i % 2] ?? 0) / 100 : 0;
    const midi = target + pitchShift.semitones + pitchShift.cents / 100 + detune;
    let { hz, delaySec } = reached(mode, notes, i, TUNING_HZ * 2 ** ((midi - 69) / 12));
    // effects-undo-rephased: every note in another phase (same pitch and level).
    if (path.rephase) delaySec = 0.3 / hz;
    // effects-undo-detuned: every note 10 cents sharp.
    if (path.detune) hz *= 2 ** (10 / 1200);
    const src = note[SRC];
    const driftGain =
      src === undefined ? 0 : (mode === 'effects-drift-ignored' ? 1 : note.pitchDriftScale) * (1 - note.retuneSpeed);
    const depth = mode === 'effects-vibrato-ignored' ? 0 : note.vibratoDepth;
    const rate = mode === 'effects-vibrato-wrong-rate' ? note.vibratoRateHz / 2 : note.vibratoRateHz;
    const modulated = driftGain !== 0 || depth !== 0;
    const from = Math.round(mapTime(handles, content.durationSec, note.startContentSec) * RATE);
    const to = Math.round(mapTime(handles, content.durationSec, note.endContentSec) * RATE);
    const count = to - from;
    let phase = 0;
    for (let n = 0; n < count && from + n < out.length; n++) {
      const t = n / RATE;
      let v = 0;
      if (modulated) {
        const cents = driftGain * contourAt(src, t) + VIBRATO_RESPONSE * depth * Math.sin(2 * Math.PI * rate * t);
        phase += (2 * Math.PI * hz * 2 ** (cents / 1200)) / RATE;
        for (let k = 1; k <= HARMONICS; k++) v += Math.sin(k * phase) / amplitude(k);
      } else {
        for (let k = 1; k <= HARMONICS; k++) v += Math.sin(2 * Math.PI * k * hz * (t + delaySec)) / amplitude(k);
      }
      const edge = Math.min(1, t / FADE_SEC, (count / RATE - t) / FADE_SEC);
      out[from + n] = 0.2 * v * Math.max(0, edge);
    }
  }
  return out;
}

/** The damaged first export of the `effects-export-*` modes: each note from `from` to `to` cents sharp. */
function damaged(content, mode) {
  const out = new Float64Array(Math.round(content.durationSec * RATE));
  for (const [i, note] of content.notes.entries()) {
    let [from, to] = [0, 0];
    if (mode === 'effects-export-offset') [from, to] = [30, 30];
    else if (mode === 'effects-export-glide') [from, to] = [20, 200];
    else if (i === 1) [from, to] = [100, 100];
    const hz = TUNING_HZ * 2 ** ((note.detectedMidi - 69) / 12);
    const first = Math.round(note.startContentSec * RATE);
    const count = Math.round(note.endContentSec * RATE) - first;
    let phase = 0;
    for (let n = 0; n < count && first + n < out.length; n++) {
      const t = n / RATE;
      const cents = from + ((to - from) * n) / Math.max(1, count - 1);
      phase += (2 * Math.PI * hz * 2 ** (cents / 1200)) / RATE;
      let v = 0;
      for (let k = 1; k <= HARMONICS; k++) v += Math.sin(k * phase) / k;
      const edge = Math.min(1, t / FADE_SEC, (count / RATE - t) / FADE_SEC);
      out[first + n] = 0.2 * v * Math.max(0, edge);
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
  const writesDuringExport = ['effects-mixed', 'effects-conflict', 'effects-down-misreport'].includes(mode);
  const startHybridMode = mode === 'effects-hybrid';
  const prefs = { tuningHz: TUNING_HZ, hybridMode: startHybridMode };
  // The vocoder weights the installation offers and the one in use. Under `fake-b` a note has fewer overtones.
  const weights = mode === 'effects-one-weight' ? ['fake'] : ['fake', 'fake-b'];
  let weight = 'fake';
  const rolloff = () => (weight === 'fake-b' && mode !== 'effects-weights-alike' ? 2 : 1);
  const changedPrefs = new Set();
  /** How the API reads a stored midi number: shifted by the A4 reference (stored values are at 440 Hz). */
  const conv = () => 12 * Math.log2(TUNING_HZ / prefs.tuningHz);
  const apiMidi = (stored) => r4(stored + conv());
  const storedMidi = (api) => (conv() === 0 ? r4(api) : api - conv());
  /** The render path: the one the instance started with, or the other one. */
  const renderPath = (c) => {
    const other = mode !== 'effects-hybrid-ignored' && prefs.hybridMode !== startHybridMode;
    const identity = c.handles.every((h) => h.contentSec === h.outputSec);
    return {
      lighter: other,
      leaveSmall: other && prefs.hybridMode,
      rephase: mode === 'effects-undo-rephased' && c.regridded === true,
      detune: mode === 'effects-undo-detuned' && c.regridded === true && identity,
    };
  };

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
  /**
   * A job runs, lazily, when it is first read with job.get, and has ended by then: `polls` is how many
   * reads still find it running first. The default is none. A read that finds a job running makes the
   * scenario wait 100 ms before the next one, which this file's tests do not test (the smoke tests do,
   * with the stand-in whose jobs take two reads), and which would add 100 ms to each of the 20 to 30
   * exports of a run. A write that comes after export.start and before the first read still finds the
   * export job running: the race check depends on that, and the job takes its snapshot at the start.
   */
  const startJob = (kind, run, polls = 0) => {
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
      if (before[name] === after[name]) continue;
      const shown = (v) => (name === 'targetMidi' ? apiMidi(v) : v);
      fields[name] = { before: shown(before[name]), after: shown(after[name]), unit: null };
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
    if (params.generateNotes === true) c.notes = notesFromTruth(truth.notes, DEFAULT_SPLIT_CENTS);
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
    if (dry) samples = mode.startsWith('effects-export-') ? damaged(c, mode) : c.samples;
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
    else samples = render(c, c.notes, c.pitchShift, c.handles, mode, renderPath(c), rolloff());
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
        processing: {
          vocoderWeight: weight,
          hybridMode: prefs.hybridMode,
          backend: 'fake',
          tuningHz: prefs.tuningHz,
        },
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
        if (op.op === 'setTargetPitch') Object.assign(n, { targetMidi: storedMidi(op.targetMidi), offsetCents: 0 });
        else if (op.op === 'snapToScale') {
          if (mode !== 'effects-snap-ignored') {
            const snapped = nearestInScale(apiMidi(n.targetMidi), op.key.root, op.key.scale);
            Object.assign(n, { targetMidi: storedMidi(snapped), offsetCents: 0 });
          }
        } else if (op.op === 'shiftCents') {
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

  /** prefs.set for the vocoder weight, the only member of the weight modes: a prefsApply job applies it, as OpenTune does. */
  function setVocoderWeight(id, params) {
    const refused = busy(id);
    if (refused !== null) return refused;
    const asked = params.vocoderWeight;
    if (typeof asked !== 'string' || Object.keys(params).length !== 1) {
      return fail(id, 'INVALID_ARGUMENT', 'invalid_params');
    }
    if (!weights.includes(asked)) return fail(id, 'INVALID_ARGUMENT', 'option_unavailable', 'vocoderWeight');
    const anyContent = [...contents.values()][0] ?? { id: 'c:0:0:0', revision: 'r0', gridRevision: 'g0' };
    if (asked === weight) {
      const undo = { undoable: false, reason: 'no_op', revert: null };
      return ok(id, envelope(anyContent, { applied: false, noOp: true, undo }));
    }
    const before = weight;
    const job = startJob('prefsApply', () => {
      // `effects-weight-stuck` accepts a switch back to the first weight and keeps the second one.
      if (!(mode === 'effects-weight-stuck' && asked === weights[0])) weight = asked;
      const contentIds = [...contents.keys()];
      // `effects-weight-revert-broken` hands back a recipe that sets the weight just set.
      const revertTo = mode === 'effects-weight-revert-broken' ? asked : before;
      return {
        result: envelope(anyContent, {
          changes: [
            {
              entity: 'preference',
              ref: { preference: 'vocoderWeight' },
              label: 'Vocoder weight',
              fields: { vocoderWeight: { before, after: asked, unit: null } },
            },
          ],
          undo: {
            undoable: false,
            reason: 'ui_parity',
            revert: { method: 'prefs.set', params: { vocoderWeight: revertTo } },
          },
          sideEffects: contentIds.length > 0 ? { reRenderQueued: { contentIds, revert: null } } : {},
          warnings: [{ code: 'GLOBAL_PREFERENCE', subject: null, data: { preferences: ['vocoderWeight'] } }],
        }),
      };
    });
    return ok(id, { ...envelope(anyContent, { applied: false, undo: null }), job });
  }

  function reply(request) {
    const { id, method, params } = request;
    if (method === 'session.info') {
      return ok(id, {
        processing: {
          tuningHz: prefs.tuningHz,
          editingScheme: 'openTune',
          hybridMode: prefs.hybridMode,
          vocoderWeight: weight,
          f0Model: 'fake',
          renderingPriority: null,
          backend: 'fake',
          vocoderReady: true,
          vocoderReconfiguring: false,
          experimentalFeatures: false,
        },
      });
    }
    if (method === 'prefs.get') {
      const processing = {
        tuningHz: prefs.tuningHz,
        editingScheme: 'openTune',
        hybridMode: prefs.hybridMode,
        vocoderWeight: weight,
        f0Model: 'fake',
        renderingPriority: 'gpuFirst',
        experimentalFeatures: false,
      };
      // An instance of an earlier release candidate does not report the options.
      if (mode !== 'effects-no-options') {
        processing.options = {
          vocoderWeight: weights,
          f0Model: ['fake'],
          renderingPriority: ['gpuFirst', 'cpuFirst'],
        };
      }
      return ok(id, { processing, onboardingShown: true, language: 'en', recentProjects: [] });
    }
    if (method === 'prefs.set' && 'vocoderWeight' in params) return setVocoderWeight(id, params);
    if (method === 'prefs.set') {
      const changes = [];
      const revert = {};
      const warnings = [];
      for (const key of ['tuningHz', 'hybridMode']) {
        if (!(key in params)) continue;
        const before = prefs[key];
        const wanted = params[key];
        if (before === wanted) continue;
        // effects-pref-stuck: a preference that was changed once keeps that value, and says it took the next one.
        if (!(mode === 'effects-pref-stuck' && changedPrefs.has(key))) prefs[key] = wanted;
        changedPrefs.add(key);
        changes.push({
          entity: 'preference',
          ref: { preference: key },
          label: key,
          fields: { [key]: { before, after: wanted, unit: null } },
        });
        revert[key] = before;
        warnings.push({ code: 'GLOBAL_PREFERENCE', subject: null, data: { preferences: [key] } });
        if (key === 'tuningHz') {
          warnings.push({ code: 'NOT_RETROACTIVE', subject: null, data: { preference: key } });
        }
      }
      const idle = changes.length === 0;
      const queued = changes.some((ch) => ch.ref.preference === 'hybridMode');
      let recipe = { method: 'prefs.set', params: revert };
      if (mode === 'effects-pref-recipe-foreign' || mode === 'effects-hybrid-export-fails-foreign') {
        recipe = { method: 'prefs.wipe', params: revert };
      }
      if (mode === 'effects-pref-recipe-extra') {
        const other = 'tuningHz' in revert ? 'hybridMode' : 'tuningHz';
        recipe = { method: 'prefs.set', params: { ...revert, [other]: other === 'hybridMode' ? true : 450 } };
      }
      return ok(
        id,
        envelope(
          { id: 'c:0:0:0', revision: 'r0', gridRevision: 'g0' },
          {
            applied: !idle,
            noOp: idle,
            changes,
            undo: idle
              ? null
              : {
                  undoable: false,
                  reason: 'ui_parity',
                  revert: mode === 'effects-pref-recipe-missing' ? null : recipe,
                },
            tokens: { arrangementRevision: 'a1', contents: [], placements: [] },
            sideEffects: queued ? { reRenderQueued: { contentIds: [...contents.keys()], revert: null } } : {},
            warnings,
          },
        ),
      );
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
      // effects-hybrid-export-fails: no export while the hybrid mode is not the one the instance began with.
      if (mode.startsWith('effects-hybrid-export-fails') && prefs.hybridMode !== startHybridMode) {
        return fail(id, 'INTERNAL', 'fake_export_failed');
      }
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
      const job = startJob('export', () => finishExport(state));
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
        detectedMidi: apiMidi(n.detectedMidi),
        targetMidi: apiMidi(n.targetMidi),
      }));
      return ok(id, {
        asOf: asOf(c),
        derived: [],
        contentId: c.id,
        placementId: null,
        tuningHz: prefs.tuningHz,
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
      const undo = pushUndo(c, 'edit notes', before);
      const result = { ...envelope(c, { changes, undo }), omittedChangeCount: 0 };
      if (params.ops.some((op) => op.op === 'setTargetPitch')) {
        // The edit has taken effect (and is in the history); only its result is wrong.
        if (mode === 'effects-undo-missing') result.undo = { undoable: false, reason: 'ui_parity', revert: null };
        if (mode === 'effects-undo-garbled') result.undo = { ...undo, undoId: 42 };
        if (mode === 'effects-tokens-missing') delete result.tokens;
        if (mode === 'effects-reply-lost') return fail(id, 'INTERNAL', 'fake_reply_lost');
      }
      if (mode === 'effects-down-misreport' && exportLock !== null) {
        for (const ch of changes) if (ch.fields.offsetCents) ch.fields.offsetCents.after += 1;
      }
      if (mode === 'effects-extra-fields') {
        for (const ch of changes) ch.fields.futureField = { before: 0, after: 1, unit: null };
      }
      return ok(id, result);
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
      const asked = params.params ?? {};
      const splitCents = typeof asked.noteSplitCents === 'number' ? asked.noteSplitCents : DEFAULT_SPLIT_CENTS;
      if (params.mode === 'regenerate') {
        // The notes are cut again (effects-split-ignored: at the default sensitivity, whatever was asked).
        c.notes = notesFromTruth(c.truth, mode === 'effects-split-ignored' ? DEFAULT_SPLIT_CENTS : splitCents);
      }
      // The semitones of the A4 reference (effects-tuning-ignored: those of 440 Hz).
      const shift = mode === 'effects-tuning-ignored' ? 0 : conv();
      for (const n of c.notes) {
        const target = Math.round(n.targetMidi + shift) - shift;
        if (params.mode === 'regenerate') {
          Object.assign(n, DEFAULT_PARAMS);
          for (const name of NOTE_PARAMS) if (typeof asked[name] === 'number') n[name] = asked[name];
        }
        Object.assign(n, {
          offsetCents: r4(n.offsetCents + (target - n.targetMidi) * 100),
          targetMidi: target,
          corrected: true,
        });
      }
      c.revision = next('r');
      c.everCorrected = true;
      const changes = c.notes
        .slice(0, old.length)
        .map((n, i) => noteChange(c, i, old[i], n))
        .filter((ch) => Object.keys(ch.fields).length > 0);
      const ref = (index) => ({
        entity: 'note',
        ref: { contentId: c.id, note: { index, atRevision: c.revision } },
        label: null,
      });
      return ok(id, {
        ...envelope(c, {
          changes,
          created: c.notes.slice(old.length).map((_, k) => ref(old.length + k)),
          removed: old.slice(c.notes.length).map((_, k) => ref(c.notes.length + k)),
          undo: pushUndo(c, 'auto tune', before),
        }),
        mode: params.mode,
        keyUsed: params.key,
        paramsUsed: params.mode === 'snapNotes' ? null : { ...DEFAULT_PARAMS, ...asked, noteSplitCents: splitCents },
        noteCount: { before: old.length, after: c.notes.length },
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
    if (method === 'content.editTimeGrid' && params.op === 'moveHandles') {
      if (params.expectedGridRevision !== c.gridRevision) return fail(id, 'REVISION_CONFLICT', 'grid_changed');
      const before = snapshot(c);
      const changes = [];
      for (const move of params.moves) {
        const at = c.handles.findIndex((h) => h.handleId === move.handleId);
        const handle = c.handles[at];
        if (handle === undefined) return fail(id, 'NOT_FOUND', 'unknown_handle');
        const outputSec = r6(move.outputSec);
        // effects-move-ignored: the handle stays where it is, and the result says it moved.
        if (mode !== 'effects-move-ignored') c.handles[at] = { ...handle, outputSec };
        changes.push({
          entity: 'timeHandle',
          ref: { contentId: c.id, handleId: handle.handleId },
          label: null,
          fields: { outputSec: { before: handle.outputSec, after: outputSec, unit: 'sec' } },
        });
      }
      c.gridRevision = next('g');
      // effects-undo-rephased and effects-undo-detuned: from now on the clip is rendered again.
      c.regridded = true;
      return ok(id, {
        ...envelope(c, {
          changes,
          undo: pushUndo(c, 'move handles', before),
          sideEffects: { reRenderQueued: { contentIds: [c.id], revert: null } },
        }),
        clamped: [],
      });
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
