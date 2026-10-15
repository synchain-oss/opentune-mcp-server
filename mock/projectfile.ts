// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The project file of the mock: a small JSON document that holds what OpenTune saves with a project
// (the clips, their contents, the tracks and the tempo) and none of what it does not (the number of
// visible tracks, the undo history and the preferences; PROTOCOL.md section 22, project.save). It
// is only ever written to the mock's work directory; the real format is OpenTune's own.

import type { KeyRec, HandleRec, NoteRec, PitchShiftRec, World } from './model.js';

const FORMAT = 'otcp-mock-project';

export interface ProjectContentFile {
  source: string;
  durationSec: number;
  key: KeyRec | null;
  pitchShift: PitchShiftRec;
  notes: NoteRec[];
  handles: HandleRec[];
}

export interface ProjectClipFile {
  contentIndex: number;
  trackId: number;
  name: string | null;
  startTimelineSec: number;
  durationSec: number;
  clipInContentSec: number;
  gainLinear: number;
  fadeInSec: number;
  fadeOutSec: number;
  /** The index in `clips` of the clip this one is bound to as reference, or null. */
  referenceClipIndex: number | null;
}

export interface ProjectFile {
  format: typeof FORMAT;
  version: 1;
  bpm: number;
  timeSignature: { numerator: number; denominator: number };
  tracks: { muted: boolean; solo: boolean; volumeLinear: number; colour: string }[];
  contents: ProjectContentFile[];
  clips: ProjectClipFile[];
}

/** What the project holds now, as the file records it. */
export function projectOf(world: World): ProjectFile {
  const contents = [...world.contents.values()];
  const placements = [...world.placements.values()].sort((a, b) => a.serial - b.serial);
  return {
    format: FORMAT,
    version: 1,
    bpm: world.transport.bpm,
    timeSignature: { ...world.transport.timeSignature },
    tracks: world.tracks.map(({ muted, solo, volumeLinear, colour }) => ({ muted, solo, volumeLinear, colour })),
    contents: contents.map((c) => ({
      source: c.sourcePath ?? '',
      durationSec: c.durationSec,
      key: c.key === null ? null : { ...c.key },
      pitchShift: { ...c.pitchShift },
      notes: structuredClone(c.notes),
      handles: structuredClone(c.handles),
    })),
    clips: placements.map((p) => ({
      contentIndex: contents.indexOf(p.content),
      trackId: p.trackId,
      name: p.name,
      startTimelineSec: p.startTimelineSec,
      durationSec: p.durationSec,
      clipInContentSec: p.clipInContentSec,
      gainLinear: p.gainLinear,
      fadeInSec: p.fadeInSec,
      fadeOutSec: p.fadeOutSec,
      referenceClipIndex: p.reference === null ? null : placements.indexOf(p.reference),
    })),
  };
}

export const projectBytes = (project: ProjectFile): string => `${JSON.stringify(project, null, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The project a file holds, or undefined when the text is not a project file this mock wrote. */
export function parseProject(text: string): ProjectFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.format !== FORMAT || value.version !== 1) return undefined;
  if (!Array.isArray(value.tracks) || !Array.isArray(value.contents) || !Array.isArray(value.clips)) return undefined;
  return value as unknown as ProjectFile;
}

/** The file of the `project` kind of the `files` precondition: one clip on track 0 that shows `mediaPath`. */
export function singleClipProject(mediaPath: string, durationSec: number): ProjectFile {
  return {
    format: FORMAT,
    version: 1,
    bpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    tracks: [],
    contents: [
      {
        source: mediaPath,
        durationSec,
        key: null,
        pitchShift: { semitones: 0, cents: 0 },
        notes: [],
        handles: [],
      },
    ],
    clips: [
      {
        contentIndex: 0,
        trackId: 0,
        name: null,
        startTimelineSec: 0,
        durationSec,
        clipInContentSec: 0,
        gainLinear: 1,
        fadeInSec: 0,
        fadeOutSec: 0,
        referenceClipIndex: null,
      },
    ],
  };
}
