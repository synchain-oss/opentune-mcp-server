// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The content edits of the mock (capability edit.v1): content.setKey, content.setPitchShift,
// content.editNotes and content.autoTune (spec/otcp/v1/PROTOCOL.md sections 10, 11 and 13 to 15).
// Every edit changes the notes, key or pitch shift of the model for real, so reads and the undo
// history see it; a note edit, a pitch shift and AUTO with ranges are one undo step each, while a
// key change and notesOnly have no undo entry, as in the UI. AUTO's reference mode runs as a job that
// aligns the notes to the clip the placement is bound to.

import { checkNotBusy, contentLabel, envelope, type Handler, type MethodContext } from './context.js';
import { refuse } from './errors.js';
import { jobStartedResult } from './job-reply.js';
import { DEFAULT_NOTE_PARAMS, DETECTED_KEY, sameJson, type ContentRec, type KeyRec, type NoteRec } from './model.js';
import { DEFAULT_NOTE_SPLIT_CENTS, nearestInScale, noteName, segmentDetected } from './music.js';
import { alignedNotes, alignmentDriver, boundReference, computeAlignment, requireReadyPair } from './reference.js';
import {
  commit,
  expectKeyRevision,
  expectRevision,
  noOpResult,
  predictionResult,
  requireReady,
  round,
  type UndoInfo,
} from './writes.js';

/** `changes`, `created` and `removed` list at most this many entries (the method schemas). */
const LISTED_MAX = 200;
const EPSILON = 1e-9;

const NOTE_EDIT: UndoInfo = { action: 'noteEdit', description: 'Edit notes', innerActions: ['setNotes'] };
const AUTO_TUNE: UndoInfo = { action: 'autoTune', description: 'Auto tune', innerActions: ['setNotes'] };
const PITCH_SHIFT: UndoInfo = { action: 'pitchShift', description: 'Pitch shift', innerActions: ['setPitchShift'] };

interface Range {
  startContentSec: number;
  endContentSec: number;
}

interface KeyInput {
  root: number;
  scale: string;
}

const overlaps = (note: Range, range: Range): boolean =>
  note.startContentSec < range.endContentSec && note.endContentSec > range.startContentSec;

const within = (note: Range, range: Range): boolean =>
  note.startContentSec >= range.startContentSec - EPSILON && note.endContentSec <= range.endContentSec + EPSILON;

const noteLabel = (index: number, note: NoteRec): string =>
  `#${String(index)} ${noteName(note.targetMidi)} ${note.startContentSec.toFixed(2)}-${note.endContentSec.toFixed(2)}s`;

const noteRef = (content: ContentRec, index: number, atRevision: string) => ({
  contentId: content.id,
  note: { index, atRevision },
});

const keyOf = (key: KeyRec | KeyInput): KeyInput => ({ root: key.root, scale: key.scale });

/** The common start of a content write: handle, busy state and readiness gate (section 13.1 rule 4). */
function open(context: MethodContext): ContentRec {
  const content = context.world.content(String(context.params.contentId));
  checkNotBusy(context);
  requireReady(content);
  return content;
}

// Note changes -----------------------------------------------------------------------------------

const NOTE_FIELDS = [
  ['targetMidi', 'midi'],
  ['offsetCents', 'cents'],
  ['retuneSpeed', null],
  ['vibratoDepth', null],
  ['vibratoRateHz', null],
  ['pitchDriftScale', null],
] as const satisfies readonly (readonly [keyof NoteRec, string | null])[];

function noteFieldChanges(before: NoteRec, after: NoteRec): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [name, unit] of NOTE_FIELDS) {
    if (Math.abs(before[name] - after[name]) > EPSILON) {
      fields[name] = { before: round(before[name]), after: round(after[name]), unit };
    }
  }
  return fields;
}

/** What a note edit does to the notes, before it is applied or only predicted. */
interface Plan {
  /** The notes after the edit, ordered by start time. */
  readonly notes: NoteRec[];
  /** Notes that stay and change, by index in `notes`. */
  readonly changed: readonly { index: number; before: NoteRec; after: NoteRec }[];
  /** Notes taken away, by index in the notes before the edit. */
  readonly removed: readonly { index: number; note: NoteRec }[];
  /** Notes made, by index in `notes`. */
  readonly created: readonly { index: number; note: NoteRec }[];
  readonly warnings: readonly unknown[];
}

const hasEffect = (plan: Plan): boolean =>
  plan.changed.length > 0 || plan.removed.length > 0 || plan.created.length > 0;

interface Listing {
  readonly changes: unknown[];
  readonly created: unknown[];
  readonly removed: unknown[];
  readonly omitted: { changes: number; created: number; removed: number };
}

/** The lists of a note edit's result: notes after the write are referenced at `after`, removed ones at `before`. */
function listing(content: ContentRec, plan: Plan, revisions: { before: string; after: string }) {
  const changes = plan.changed.map(({ index, before, after }) => ({
    entity: 'note',
    ref: noteRef(content, index, revisions.after),
    label: noteLabel(index, after),
    fields: noteFieldChanges(before, after),
  }));
  const created = plan.created.map(({ index, note }) => ({
    entity: 'note',
    ref: noteRef(content, index, revisions.after),
    label: noteLabel(index, note),
  }));
  const removed = plan.removed.map(({ index, note }) => ({
    entity: 'note',
    ref: noteRef(content, index, revisions.before),
    label: noteLabel(index, note),
  }));
  const cut = (list: unknown[]) => list.slice(0, LISTED_MAX);
  return {
    changes: cut(changes),
    created: cut(created),
    removed: cut(removed),
    omitted: {
      changes: Math.max(0, changes.length - LISTED_MAX),
      created: Math.max(0, created.length - LISTED_MAX),
      removed: Math.max(0, removed.length - LISTED_MAX),
    },
  } satisfies Listing;
}

/** Applies, predicts or recognizes as a no-op a note edit, and builds the result common to both methods. */
function writeNotes(
  context: MethodContext,
  content: ContentRec,
  plan: Plan,
  options: {
    dryRun: boolean;
    undo: UndoInfo | null;
    extra: (omitted: Listing['omitted']) => Record<string, unknown>;
    warnings?: readonly unknown[];
  },
) {
  const { world } = context;
  const beforeRevision = content.revision;
  const extraWarnings = options.warnings ?? [];
  if (options.dryRun) {
    const lists = listing(content, plan, { before: beforeRevision, after: beforeRevision });
    return predictionResult(context, content, {
      changes: lists.changes,
      created: lists.created,
      removed: lists.removed,
      warnings: [...plan.warnings, ...extraWarnings],
      extra: options.extra(lists.omitted),
    });
  }
  if (!hasEffect(plan)) {
    return noOpResult(context, content, options.extra({ changes: 0, created: 0, removed: 0 }));
  }
  const done = commit(world, content, {
    mutate() {
      content.notes = plan.notes;
      world.touch(content, 'notes', 'pitch');
    },
    undo: options.undo ?? {
      notUndoable: { undoable: false, reason: 'ui_parity', revert: null },
    },
    rerender: true,
  });
  const lists = listing(content, plan, { before: beforeRevision, after: content.revision });
  return envelope(world, {
    applied: true,
    noOp: false,
    changes: lists.changes,
    created: lists.created,
    removed: lists.removed,
    diff: done.diff,
    contents: [content],
    undo: done.undo,
    dirtyBefore: done.dirtyBefore,
    sideEffects: done.sideEffects,
    warnings: [...plan.warnings, ...extraWarnings],
    extra: options.extra(lists.omitted),
  });
}

// content.editNotes ----------------------------------------------------------------------------------

interface Select {
  indices?: number[];
  range?: Range;
  all?: true;
}

type Op =
  | { op: 'setTargetPitch'; select: Select; targetMidi: number }
  | { op: 'shiftCents'; select: Select; deltaCents: number }
  | { op: 'snapToScale'; select: Select; key: KeyInput | 'clipKey' }
  | ({ op: 'setParams'; select: Select } & Partial<
      Record<'retuneSpeed' | 'vibratoDepth' | 'vibratoRateHz' | 'pitchDriftScale', number>
    >);

/** Selections are resolved against the notes at expectedRevision, which are the current notes here. */
function selected(notes: readonly NoteRec[], select: Select): number[] {
  if (select.indices !== undefined) {
    const missing = select.indices.find((i) => i >= notes.length);
    if (missing !== undefined) {
      throw refuse('NOT_FOUND', 'unknown_handle', `the content has no note with index ${String(missing)}`);
    }
    return select.indices;
  }
  const range = select.range;
  return notes.flatMap((note, index) => (range === undefined || overlaps(note, range) ? [index] : []));
}

/** The notes that differ between two lists of the same length. */
function changesOf(before: readonly NoteRec[], after: readonly NoteRec[]): Plan['changed'] {
  return after.flatMap((note, index) => {
    const was = before[index];
    return was !== undefined && Object.keys(noteFieldChanges(was, note)).length > 0
      ? [{ index, before: was, after: note }]
      : [];
  });
}

function planEdit(content: ContentRec, ops: readonly Op[]): Plan {
  const original = content.notes;
  const notes = original.map((n) => ({ ...n }));
  for (const op of ops) {
    const key = op.op === 'snapToScale' ? (op.key === 'clipKey' ? keyOf(content.key ?? DETECTED_KEY) : op.key) : null;
    for (const index of selected(original, op.select)) {
      const note = notes[index] as NoteRec;
      switch (op.op) {
        case 'setTargetPitch':
          note.targetMidi = op.targetMidi;
          note.offsetCents = 0;
          break;
        case 'shiftCents':
          note.offsetCents += op.deltaCents;
          note.targetMidi += op.deltaCents / 100;
          break;
        case 'snapToScale':
          if (key !== null) note.targetMidi = nearestInScale(note.targetMidi, key);
          note.offsetCents = 0;
          break;
        case 'setParams':
          for (const name of ['retuneSpeed', 'vibratoDepth', 'vibratoRateHz', 'pitchDriftScale'] as const) {
            const value = op[name];
            if (value !== undefined) note[name] = value;
          }
          break;
      }
    }
  }
  return { notes, changed: changesOf(original, notes), removed: [], created: [], warnings: [] };
}

const editNotes: Handler = (context) => {
  const { params } = context;
  const content = open(context);
  expectRevision(content, params.expectedRevision);
  const ops = params.ops as Op[];
  if (ops.some((op) => op.op === 'snapToScale' && op.key === 'clipKey')) {
    expectKeyRevision(content, params.expectedKeyRevision);
  }
  const plan = planEdit(content, ops);
  return writeNotes(context, content, plan, {
    dryRun: params.dryRun === true,
    undo: NOTE_EDIT,
    extra: (omitted) => ({ omittedChangeCount: omitted.changes }),
  });
};

// content.autoTune -----------------------------------------------------------------------------------

interface GeneratorParams {
  retuneSpeed: number;
  vibratoDepth: number;
  vibratoRateHz: number;
  noteSplitCents: number;
}

/** A note as the generator makes it: the target is the detected pitch, snapped to a key if one is given. */
function generated(
  segment: { startContentSec: number; endContentSec: number; detectedMidi: number },
  key: KeyInput | null,
  used: GeneratorParams,
): NoteRec {
  const target = key === null ? segment.detectedMidi : nearestInScale(segment.detectedMidi, key);
  return {
    startContentSec: segment.startContentSec,
    endContentSec: segment.endContentSec,
    targetMidi: round(target),
    offsetCents: 0,
    retuneSpeed: used.retuneSpeed,
    vibratoDepth: used.vibratoDepth,
    vibratoRateHz: used.vibratoRateHz,
    pitchDriftScale: DEFAULT_NOTE_PARAMS.pitchDriftScale,
  };
}

/** Puts new notes among the kept ones in start order and returns the indices the new ones got. */
function merge(kept: readonly NoteRec[], added: readonly NoteRec[]) {
  const all = [...kept.map((note) => ({ note, fresh: false })), ...added.map((note) => ({ note, fresh: true }))].sort(
    (a, b) => a.note.startContentSec - b.note.startContentSec,
  );
  return {
    notes: all.map((entry) => entry.note),
    created: all.flatMap((entry, index) => (entry.fresh ? [{ index, note: entry.note }] : [])),
  };
}

function planRegenerate(content: ContentRec, ranges: readonly Range[], key: KeyInput, used: GeneratorParams): Plan {
  const original = content.notes;
  const removed: { index: number; note: NoteRec }[] = [];
  const dropped: unknown[] = [];
  original.forEach((note, index) => {
    const touching = ranges.filter((r) => overlaps(note, r));
    if (touching.length === 0) return;
    removed.push({ index, note });
    // Inside a range the note is regenerated; one that reaches over its edge is dropped.
    if (!touching.some((r) => within(note, r))) {
      dropped.push({
        note: { index, atRevision: content.revision },
        startContentSec: round(note.startContentSec),
        endContentSec: round(note.endContentSec),
      });
    }
  });
  const added: NoteRec[] = [];
  for (const segment of segmentDetected(content.durationSec, used.noteSplitCents)) {
    if (ranges.some((r) => within(segment, r))) added.push(generated(segment, key, used));
  }
  const kept = original.filter((_, index) => !removed.some((r) => r.index === index));
  const { notes, created } = merge(kept, added);
  return {
    notes,
    changed: [],
    removed,
    created,
    warnings:
      dropped.length === 0
        ? []
        : [{ code: 'DROPPED_BOUNDARY_NOTES', subject: { contentId: content.id }, data: { notes: dropped } }],
  };
}

function planSnap(content: ContentRec, ranges: readonly Range[], key: KeyInput): Plan {
  const original = content.notes;
  const notes = original.map((note) =>
    ranges.some((r) => overlaps(note, r))
      ? { ...note, targetMidi: nearestInScale(note.targetMidi, key), offsetCents: 0 }
      : { ...note },
  );
  return { notes, changed: changesOf(original, notes), removed: [], created: [], warnings: [] };
}

function planNotesOnly(content: ContentRec, used: GeneratorParams): Plan {
  const added = segmentDetected(content.durationSec, used.noteSplitCents).map((s) => generated(s, null, used));
  const warnings = [
    {
      code: 'REPLACES_ALL_NOTES',
      subject: { contentId: content.id },
      data: { removedCount: content.notes.length, createdCount: added.length },
    },
    { code: 'IRREVERSIBLE', subject: { contentId: content.id }, data: null },
  ];
  return {
    notes: added,
    changed: [],
    removed: content.notes.map((note, index) => ({ index, note })),
    created: added.map((note, index) => ({ index, note })),
    warnings,
  };
}

/** AUTO in mode reference: a job that computes the alignment data if needed and aligns the whole content (one undo step). */
function autoTuneReference(context: MethodContext, content: ContentRec) {
  const { world, params } = context;
  expectRevision(content, params.expectedRevision);
  const placement = world.placement(String(params.placementId));
  if (placement.content !== content) {
    throw refuse('INVALID_ARGUMENT', 'placement_content_mismatch', 'the placement does not show the content');
  }
  const reference = boundReference(placement);
  requireReadyPair(placement, reference);
  const members = (noteCount: unknown, omitted: Listing['omitted']) => ({
    mode: 'reference',
    keyUsed: null,
    paramsUsed: null,
    noteCount,
    omittedCount: omitted,
  });
  const epoch = world.epoch;
  const job = context.jobs.start(
    { kind: 'referenceAnalysis' },
    alignmentDriver(
      world,
      () => [placement, placement.reference],
      () => {
        // What the call checked can have changed while the job ran: check again, in the same order.
        if (world.epoch !== epoch || world.placements.get(placement.serial) !== placement) {
          throw refuse('NOT_FOUND', 'unknown_handle', 'the placement was removed before the job ran');
        }
        checkNotBusy(context);
        requireReady(content);
        const bound = boundReference(placement);
        requireReadyPair(placement, bound);
        // Just before it aligns, the job compares the token the call checked with the content's current one, as an
        // export does before it renames (PROTOCOL.md section 12.6 rule 5), and before it stores alignment data:
        // a job that fails stores none (rule 4).
        expectRevision(content, params.expectedRevision);
        computeAlignment(world, placement, bound);
        const notes = alignedNotes(world, placement, bound);
        const plan: Plan = { notes, changed: changesOf(content.notes, notes), removed: [], created: [], warnings: [] };
        const before = content.notes.length;
        return writeNotes(context, content, plan, {
          dryRun: false,
          undo: AUTO_TUNE,
          extra: (omitted) => members({ before, after: notes.length }, omitted),
        });
      },
    ),
  );
  return jobStartedResult(world, job, members(null, { changes: 0, created: 0, removed: 0 }));
}

const autoTune: Handler = (context) => {
  const { params } = context;
  const mode = String(params.mode);
  const content = open(context);
  if (mode === 'reference') return autoTuneReference(context, content);
  expectRevision(content, params.expectedRevision);
  const given = (params.params ?? {}) as Partial<GeneratorParams>;
  const used: GeneratorParams = {
    retuneSpeed: given.retuneSpeed ?? DEFAULT_NOTE_PARAMS.retuneSpeed,
    vibratoDepth: given.vibratoDepth ?? DEFAULT_NOTE_PARAMS.vibratoDepth,
    vibratoRateHz: given.vibratoRateHz ?? DEFAULT_NOTE_PARAMS.vibratoRateHz,
    noteSplitCents: given.noteSplitCents ?? DEFAULT_NOTE_SPLIT_CENTS,
  };
  const ranges = (params.ranges as Range[] | undefined) ?? [{ startContentSec: 0, endContentSec: content.durationSec }];
  let key: KeyInput | null = null;
  if (mode !== 'notesOnly') {
    if (params.key === 'clipKey') {
      expectKeyRevision(content, params.expectedKeyRevision);
      key = keyOf(content.key ?? DETECTED_KEY);
    } else {
      key = keyOf(params.key as KeyInput);
    }
  }
  const before = content.notes.length;
  let plan: Plan;
  if (key === null) plan = planNotesOnly(content, used);
  else if (mode === 'regenerate') plan = planRegenerate(content, ranges, key, used);
  else plan = planSnap(content, ranges, key);
  return writeNotes(context, content, plan, {
    dryRun: params.dryRun === true,
    undo: mode === 'notesOnly' ? null : AUTO_TUNE,
    extra: (omitted) => ({
      mode,
      keyUsed: key,
      paramsUsed: mode === 'snapNotes' ? null : used,
      noteCount: { before, after: plan.notes.length },
      omittedCount: omitted,
    }),
  });
};

// content.setKey and content.setPitchShift ---------------------------------------------------------

const setKey: Handler = (context) => {
  const { world, params } = context;
  const content = open(context);
  if (params.expectedKeyRevision !== undefined) expectKeyRevision(content, params.expectedKeyRevision);
  const wanted = params.key as KeyInput;
  const previous = content.key;
  if (previous !== null && previous.root === wanted.root && previous.scale === wanted.scale) {
    return noOpResult(context, content);
  }
  const done = commit(world, content, {
    mutate() {
      content.key = { root: wanted.root, scale: wanted.scale, origin: 'manual', confidence: null };
      world.touch(content, 'key');
    },
    // The recipe is built once the new key revision exists; see below.
    undo: { notUndoable: null },
    rerender: false,
  });
  const revert =
    previous === null
      ? null
      : {
          method: 'content.setKey',
          params: {
            contentId: content.id,
            key: keyOf(previous),
            expectedKeyRevision: content.comp.key,
          },
        };
  const undo = { undoable: false, reason: 'ui_parity', revert };
  const fields: Record<string, unknown> = {};
  if (previous?.root !== wanted.root) fields.root = { before: previous?.root ?? null, after: wanted.root, unit: null };
  if (previous?.scale !== wanted.scale)
    fields.scale = { before: previous?.scale ?? null, after: wanted.scale, unit: null };
  // Choosing the key of the selected clip also changes the scale shown in the transport bar.
  const shown = world.placementsOf(content).some((placement) => world.selectedPlacementIds.includes(placement.id));
  return envelope(world, {
    applied: true,
    noOp: false,
    changes: [{ entity: 'key', ref: { contentId: content.id }, label: contentLabel(content), fields }],
    diff: done.diff,
    contents: [content],
    undo,
    dirtyBefore: done.dirtyBefore,
    sideEffects: shown ? { uiScaleChanged: { root: wanted.root, scale: wanted.scale, revert } } : {},
    warnings: previous === null ? [{ code: 'IRREVERSIBLE', subject: { contentId: content.id }, data: null }] : [],
  });
};

const setPitchShift: Handler = (context) => {
  const { world, params } = context;
  const content = open(context);
  const wanted = params.pitchShift as { semitones: number; cents: number };
  const previous = content.pitchShift;
  if (sameJson(previous, wanted)) return noOpResult(context, content);
  const done = commit(world, content, {
    mutate() {
      content.pitchShift = { semitones: wanted.semitones, cents: wanted.cents };
      world.touch(content, 'pitchShift');
    },
    undo: PITCH_SHIFT,
    rerender: true,
  });
  const fields: Record<string, unknown> = {};
  if (previous.semitones !== wanted.semitones) {
    fields.semitones = { before: previous.semitones, after: wanted.semitones, unit: 'semitones' };
  }
  if (previous.cents !== wanted.cents) fields.cents = { before: previous.cents, after: wanted.cents, unit: 'cents' };
  return envelope(world, {
    applied: true,
    noOp: false,
    changes: [{ entity: 'pitchShift', ref: { contentId: content.id }, label: contentLabel(content), fields }],
    diff: done.diff,
    contents: [content],
    undo: done.undo,
    dirtyBefore: done.dirtyBefore,
    sideEffects: done.sideEffects,
    warnings: [{ code: 'KEY_NOT_TRANSPOSED', subject: { contentId: content.id }, data: null }],
  });
};

export const editHandlers: Readonly<Record<string, Handler>> = {
  'content.setKey': setKey,
  'content.setPitchShift': setPitchShift,
  'content.editNotes': editNotes,
  'content.autoTune': autoTune,
};
