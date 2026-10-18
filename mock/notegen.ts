// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Note generation that OpenTune does by itself, outside a request for it: when a clip is selected
// or opened in the openDyne scheme, and when the scheme is switched to openDyne with a clip open in
// the piano roll (spec/otcp/v1/PROTOCOL.md section 21 rules 3 and 4). It has no undo entry.

import { commit } from './writes.js';
import { DEFAULT_NOTE_PARAMS, type ContentRec, type World } from './model.js';
import { DEFAULT_NOTE_SPLIT_CENTS, segmentDetected } from './music.js';

/** The notes the generator makes for a content: one per segment of the detected pitch, at that pitch rounded. */
const segmentsOf = (content: ContentRec) => segmentDetected(content.durationSec, DEFAULT_NOTE_SPLIT_CENTS);

/** The content's analysis has finished with voice and OpenTune never generated notes for it. */
export const needsGeneratedNotes = (content: ContentRec): boolean =>
  content.analysis === 'ready' && !content.notesGenerated;

/** How many notes generation would make; what a prediction reports. */
export const predictedNoteCount = (content: ContentRec): number => segmentsOf(content).length;

/** Generates the notes of the content as one change without an undo entry; returns the number of notes made. */
export function generateNotes(world: World, content: ContentRec): number {
  commit(world, content, {
    mutate() {
      content.notes = segmentsOf(content).map((s) => ({
        startContentSec: s.startContentSec,
        endContentSec: s.endContentSec,
        targetMidi: Math.round(s.detectedMidi),
        offsetCents: 0,
        ...DEFAULT_NOTE_PARAMS,
      }));
      content.notesGenerated = true;
      world.touch(content, 'notes', 'pitch');
    },
    undo: { notUndoable: { undoable: false, reason: 'ui_parity', revert: null } },
    // The generation is reported as notesGenerated; as for the clips an import generates notes for, the
    // rendering that follows it is not reported separately.
    rerender: false,
  });
  return content.notes.length;
}
