// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The state of the mock instance: the project (tracks, placements, selection, transport, history,
// path and unsaved-changes flag), the contents (notes, keys, pitch shift, time grid, analysis and
// render state) and the tokens that guard writes (spec/otcp/v1/PROTOCOL.md sections 9, 10 and 14).
// Method handlers read and change it through the methods below, which keep the tokens and the
// world revision vector consistent: every token is minted from one counter, so a token never
// repeats, not even when an undo restores earlier data.

import type { Clock, Timer } from './clock.js';
import { refuse } from './errors.js';
import { TUNING_HZ } from './music.js';

export const TRACK_SLOTS = 8;
/** The tracks OpenTune shows before any clip needs more. */
export const INITIAL_VISIBLE_TRACKS = 4;
/** Time the mock needs to render a content again after an edit. */
export const RENDER_SETTLE_MS = 30;
/** Time the mock needs to compute the reference alignment data of a content. */
export const ALIGNMENT_SETTLE_MS = 30;
/**
 * How the mock reconfigures its vocoder after a new weight or rendering priority, and how long a prefsApply job waits
 * for it (60 s, the default of the real implementation); test hooks change them.
 */
export const VOCODER_RECONFIGURE = { queuedMs: 5, reconfiguringMs: 10, waitLimitMs: 60_000 } as const;
/** The vocoder weights and pitch models the mock's installation offers, as prefs.get lists them. */
export const DEFAULT_OPTIONS = {
  vocoderWeight: ['hifigan.onnx', 'hifigan_coulin9.onnx'],
  f0Model: ['fcpe'],
} as const;
/** Default note parameters of the note generator. */
export const DEFAULT_NOTE_PARAMS = { retuneSpeed: 0.5, vibratoDepth: 0, vibratoRateHz: 6, pitchDriftScale: 1 } as const;

export type Analysis = 'ready' | 'running' | 'failed' | 'unvoiced';
export type Component = 'notes' | 'pitch' | 'content' | 'grid' | 'key' | 'pitchShift' | 'reference';

export interface NoteRec {
  startContentSec: number;
  endContentSec: number;
  /** Includes offsetCents. */
  targetMidi: number;
  offsetCents: number;
  retuneSpeed: number;
  vibratoDepth: number;
  vibratoRateHz: number;
  pitchDriftScale: number;
}

export interface KeyRec {
  root: number;
  scale: string;
  origin: 'automatic' | 'manual';
  confidence: number | null;
}

export interface HandleRec {
  handleId: string;
  contentSec: number;
  outputSec: number;
}

export interface PitchShiftRec {
  semitones: number;
  cents: number;
}

export interface ContentRec {
  readonly objectId: number;
  readonly id: string;
  durationSec: number;
  analysis: Analysis;
  notes: NoteRec[];
  key: KeyRec | null;
  pitchShift: PitchShiftRec;
  handles: HandleRec[];
  sourcePath: string | null;
  /** Opaque value of each component of the world revision vector (section 14.4). */
  comp: Record<Component, string>;
  /** Changes with the notes, pitch and content components. */
  revision: string;
  render: { published: string; desired: string };
  alignmentReady: boolean;
  /** OpenTune generated notes for this content at some point (import, AUTO, selection in the openDyne scheme). */
  notesGenerated: boolean;
  handleSeq: number;
}

export interface PlacementRec {
  readonly serial: number;
  readonly id: string;
  trackId: number;
  content: ContentRec;
  name: string | null;
  startTimelineSec: number;
  durationSec: number;
  clipInContentSec: number;
  gainLinear: number;
  fadeInSec: number;
  fadeOutSec: number;
  reference: PlacementRec | null;
  geometryHash: string;
}

export interface TrackRec {
  trackId: number;
  visible: boolean;
  muted: boolean;
  solo: boolean;
  volumeLinear: number;
  colour: string;
}

/** What a history entry restores on one content. */
export interface ContentSnap {
  notes: NoteRec[];
  key: KeyRec | null;
  pitchShift: PitchShiftRec;
  handles: HandleRec[];
}

/** The properties of a placement that arrangement edits change (the geometry, the gain and the fades). */
export interface PlacementState {
  trackId: number;
  startTimelineSec: number;
  durationSec: number;
  clipInContentSec: number;
  gainLinear: number;
  fadeInSec: number;
  fadeOutSec: number;
}

/** A dialog open in the window (ui.getState, ui.dismiss). */
export interface DialogRec {
  kind: 'trackColour' | 'confirm' | 'pitchShift' | 'preferences' | 'message' | 'unknown';
  trackId: number | null;
  /** The colour a track-colour dialog shows; closing the dialog commits it to the track. */
  colour: string | null;
}

/** The audio device setup of the installation (audio.get, audio.set). */
export interface AudioRec {
  running: boolean;
  deviceType: string;
  outputDevice: string;
  sampleRateHz: number;
  bufferSizeFrame: number;
  outputChannelPair: number;
  /** Test interface: the device fails to open with any changed setup. */
  failsToOpen: boolean;
}

/**
 * What the audio settings page offers: two device types, the first with two output devices (so that a test can
 * switch the output device or the device type), two sample rates, two buffer sizes and one output channel pair.
 */
export const AUDIO_AVAILABLE = {
  deviceTypes: ['Mock Audio', 'Mock Audio 2'],
  /** The output devices of each device type; opening a type opens its first device. */
  outputDevicesByType: {
    'Mock Audio': ['Mock Output', 'Mock Output 2'],
    'Mock Audio 2': ['Mock B Output'],
  } as Readonly<Record<string, readonly string[]>>,
  sampleRatesHz: [44100, 48000],
  bufferSizesFrame: [256, 512],
  outputChannelPairCount: 1,
} as const;

/** The longest name that processing.options and the vocoder weight members carry, in code points, and the longest list. */
export const OPTION_TEXT_MAX = 64;
export const OPTION_LIST_MAX = 64;

/** Whether a name can go on the wire: not empty, well-formed Unicode and at most OPTION_TEXT_MAX code points. */
export const carries = (name: string): boolean =>
  name.length > 0 && name.isWellFormed() && Array.from(name).length <= OPTION_TEXT_MAX;

/** The output devices a device type offers. */
export const outputDevicesOf = (deviceType: string): readonly string[] =>
  AUDIO_AVAILABLE.outputDevicesByType[deviceType] ?? [];

const FIRST_DEVICE_TYPE = AUDIO_AVAILABLE.deviceTypes[0];
const FIRST_OUTPUT_DEVICE = 'Mock Output';

/** The vocoder as OpenTune's runtime reports it (session.info, processing). */
export interface VocoderRec {
  /** The vocoder is loaded and can render. */
  ready: boolean;
  /** OpenTune is loading a new weight or a new backend. */
  reconfiguring: boolean;
  /** A reconfiguration was issued and has not finished: OpenTune starts it asynchronously, so until it begins the vocoder still reports ready. */
  commandPending: boolean;
}

/** The state an undo or redo step puts back. */
export interface Patch {
  /** Only the aspects in `snap` are put back; an aspect left out stays as it is. */
  content?: { objectId: number; snap: Partial<ContentSnap> };
  /** Only the properties in `state` are put back; a property left out stays as it is. */
  placements?: {
    serial: number;
    state: Partial<PlacementState>;
    /** The serial of the clip it is bound to as reference, or null for none; left out: unchanged. */
    reference?: number | null;
  }[];
}

export interface HistoryEntry {
  /** The sequence number of its undoId; null for an entry from the UI that no call has applied. */
  seq: number | null;
  origin: 'control' | 'ui';
  action: string;
  description: string;
  innerActions: string[];
  /** Applied by edit.undo; null when the entry changes nothing now (its target has moved). */
  undoPatch: Patch | null;
  /** Applied by edit.redo. */
  redoPatch: Patch | null;
  possiblyStale: boolean;
  unsafe: boolean;
  /**
   * The track positions the entry addresses (the tracks of the clips it changed), for an entry made
   * through the API; absent for an entry that addresses none or that the server cannot inspect.
   */
  tracks?: number[];
}

/** The world revision vector (section 14.4) at one moment. */
export interface Vector {
  arrangement: string;
  trackState: string;
  contents: Map<number, Record<Component, string>>;
  /** The contentId of each content, as it was then (the epoch changes when a project is opened). */
  ids: Map<number, string>;
}

export interface RevisionPair {
  before: string | null;
  after: string | null;
}

export interface RevisionDiff {
  arrangement: RevisionPair | null;
  trackState: RevisionPair | null;
  contents: { contentId: string; changed: Partial<Record<Component, RevisionPair>> }[];
}

/** What the UI can be doing that makes writes wait (section 13.2). */
export interface BusyState {
  pointerDown: boolean;
  modalOpen: boolean;
  importInProgress: boolean;
  projectOperation: boolean;
}

export const BUSY_REASONS = {
  pointerDown: 'pointer_down',
  modalOpen: 'modal_open',
  importInProgress: 'import_in_progress',
  projectOperation: 'project_operation',
} as const satisfies Record<keyof BusyState, string>;

/** What the analysis finds in a clip that has none of its own key. */
export const DETECTED_KEY: KeyRec = { root: 0, scale: 'major', origin: 'automatic', confidence: 0.8 };

const COLOURS = ['#E57373', '#64B5F6', '#81C784', '#FFD54F', '#BA68C8', '#4DB6AC', '#FF8A65', '#A1887F'] as const;

/** A track as OpenTune starts it: shown if it is one of the first, with unit volume and its own colour. */
export const defaultTrack = (trackId: number): TrackRec => ({
  trackId,
  visible: trackId < INITIAL_VISIBLE_TRACKS,
  muted: false,
  solo: false,
  volumeLinear: 1,
  colour: COLOURS[trackId % COLOURS.length] ?? '#888888',
});

export const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export const clone = <T>(value: T): T => structuredClone(value);
/** Seconds are reported to 6 decimal places (section 8.2). */
export const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

const REVISION_COMPONENTS: readonly Component[] = ['notes', 'pitch', 'content'];

export class World {
  readonly short: string;
  /** Increases whenever every content is discarded at once, which opening a project does (section 9). */
  epoch = 0;
  readonly project: { path: string | null; dirty: boolean } = { path: null, dirty: false };
  /** Counts changes saved with the project, so that a save can tell whether the project changed while it ran. */
  changeCount = 0;
  editingScheme = 'openTune';
  readonly busy: BusyState = { pointerDown: false, modalOpen: false, importInProgress: false, projectOperation: false };
  readonly tracks: TrackRec[];
  visibleTrackCount = INITIAL_VISIBLE_TRACKS;
  /** OpenTune always has an active track; track 0 until something selects another. */
  activeTrackId: number | null = 0;
  workspace: 'arrangement' | 'pianoRoll' = 'arrangement';
  pianoRollContent: ContentRec | null = null;
  /** The dialogs open, from the bottom of the stack to the top. */
  dialogs: DialogRec[] = [];
  /** The first-run overlay is on screen. */
  onboardingShowing = false;
  /** The scale shown in the transport bar; it follows the key of the selected clip. */
  uiScale: { root: number; scale: string } = { root: 0, scale: 'major' };
  readonly audio: AudioRec = {
    running: false,
    deviceType: FIRST_DEVICE_TYPE,
    outputDevice: FIRST_OUTPUT_DEVICE,
    sampleRateHz: 44100,
    bufferSizeFrame: 512,
    outputChannelPair: 0,
    failsToOpen: false,
  };
  readonly contents = new Map<number, ContentRec>();
  readonly placements = new Map<number, PlacementRec>();
  selectedPlacementIds: string[] = [];
  readonly transport = {
    playing: false,
    positionTimelineSec: 0,
    playStartTimelineSec: 0,
    loopEnabled: false,
    bpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    audioDeviceRunning: false,
    lastControl: null as { call: string; atMs: number } | null,
  };
  readonly prefs = {
    tuningHz: TUNING_HZ,
    hybridMode: false,
    experimentalFeatures: false,
    vocoderWeight: DEFAULT_OPTIONS.vocoderWeight[0] as string,
    renderingPriority: 'gpuFirst',
    f0Model: DEFAULT_OPTIONS.f0Model[0] as string,
    referenceAlignMode: 'standardAuto',
    /** What the installation offers (prefs.get, processing.options): the weight files and the pitch models. */
    options: {
      vocoderWeight: [...DEFAULT_OPTIONS.vocoderWeight],
      f0Model: [...DEFAULT_OPTIONS.f0Model],
    } as { vocoderWeight: string[]; f0Model: string[] },
    onboardingShown: true,
    language: 'en',
    /** The most recent first; user-global, so opening another project leaves it alone. */
    recentProjects: [] as string[],
  };
  arrangement: string;
  trackState: string;
  undoStack: HistoryEntry[] = [];
  redoStack: HistoryEntry[] = [];
  readonly logLines: string[] = [];
  /** The reference analysis job of each placement (by placementId), so that a repeated call joins it. */
  readonly referenceJobs = new Map<string, string>();
  /** How a reference analysis that has to compute alignment data ends, or null when it completes. */
  referenceFault: 'stalled' | 'timeout' | 'failed' | null = null;
  readonly vocoder: VocoderRec = { ready: true, reconfiguring: false, commandPending: false };
  /**
   * Test interface: `stuck` makes a reconfiguration of the vocoder never finish, so that a wait for it passes its
   * limit; `loadFails` makes the command finish but leave the vocoder not ready (it could not load the new weight).
   */
  vocoderFault: 'stuck' | 'loadFails' | null = null;
  /** Test interface: the pitch models that OpenTune cannot load (prefs.set then fails with model_missing). */
  readonly unloadableF0Models = new Set<string>();
  /** How long the vocoder takes to start and to finish a reconfiguration; test hooks change it. */
  readonly vocoderTiming: { queuedMs: number; reconfiguringMs: number; waitLimitMs: number } = {
    ...VOCODER_RECONFIGURE,
  };
  #tick = 0;
  #contentSeq = 0;
  #placementSeq = 0;
  #undoSeq = 0;
  readonly #timers = new Set<Timer>();

  constructor(
    readonly instanceId: string,
    private readonly clock: Clock,
  ) {
    this.short = instanceId.slice(0, 8);
    this.arrangement = this.mint('a');
    this.trackState = this.mint('t');
    this.tracks = Array.from({ length: TRACK_SLOTS }, (_, trackId) => defaultTrack(trackId));
  }

  /** Milliseconds since the Unix epoch, from the injectable clock. */
  now(): number {
    return this.clock.now();
  }

  /** A new token. Tokens are opaque, never repeat, and are only compared for equality. */
  mint(prefix: string): string {
    return `${prefix}${String(++this.#tick)}`;
  }

  log(line: string): void {
    this.logLines.push(`${new Date(this.clock.now()).toISOString()} ${line}`);
  }

  // Content and placements ------------------------------------------------------------------

  addContent(init: Pick<ContentRec, 'durationSec' | 'analysis' | 'sourcePath'>): ContentRec {
    const objectId = ++this.#contentSeq;
    const content: ContentRec = {
      objectId,
      id: `c:${this.short}:${String(this.epoch)}:${String(objectId)}`,
      ...init,
      notes: [],
      key: null,
      pitchShift: { semitones: 0, cents: 0 },
      handles: [],
      comp: {
        notes: this.mint('n'),
        pitch: this.mint('p'),
        content: this.mint('c'),
        grid: this.mint('g'),
        key: this.mint('k'),
        pitchShift: this.mint('s'),
        reference: this.mint('f'),
      },
      revision: this.mint('r'),
      render: { published: '', desired: '' },
      alignmentReady: false,
      notesGenerated: false,
      handleSeq: 0,
    };
    content.render = { published: content.revision, desired: content.revision };
    this.contents.set(objectId, content);
    return content;
  }

  addPlacement(
    init: Pick<PlacementRec, 'trackId' | 'content' | 'name' | 'startTimelineSec' | 'durationSec'> &
      Partial<Pick<PlacementRec, 'clipInContentSec' | 'gainLinear' | 'fadeInSec' | 'fadeOutSec' | 'reference'>>,
  ): PlacementRec {
    const serial = ++this.#placementSeq;
    const placement: PlacementRec = {
      serial,
      id: `p:${this.short}:${String(this.epoch)}:${String(serial)}`,
      clipInContentSec: 0,
      gainLinear: 1,
      fadeInSec: 0,
      fadeOutSec: 0,
      reference: null,
      ...init,
      geometryHash: this.mint('h'),
    };
    this.placements.set(serial, placement);
    if (init.trackId >= this.visibleTrackCount) this.setVisibleTrackCount(init.trackId + 1);
    return placement;
  }

  /** section 9 rule 1: instance and epoch (stale), then existence (unknown). The form is the schema's. */
  #resolve<T>(id: string, kind: 'content' | 'placement', table: ReadonlyMap<number, T>): T {
    const [, short, epoch, n] = id.split(':');
    if (short !== this.short || Number(epoch) !== this.epoch) {
      throw refuse('NOT_FOUND', 'stale_handle', `the ${kind} handle belongs to another instance or an earlier epoch`);
    }
    const found = table.get(Number(n));
    if (found === undefined) throw refuse('NOT_FOUND', 'unknown_handle', `no ${kind} has this handle`);
    return found;
  }

  content(id: string): ContentRec {
    return this.#resolve(id, 'content', this.contents);
  }

  placement(id: string): PlacementRec {
    return this.#resolve(id, 'placement', this.placements);
  }

  placementsOf(content: ContentRec): PlacementRec[] {
    return [...this.placements.values()].filter((p) => p.content === content);
  }

  /** Handles for `runner.*` names that depend on the instance's state. */
  handleOfOtherInstance(kind: 'c' | 'p'): string {
    const other = this.short === '00000000' ? 'ffffffff' : '00000000';
    return `${kind}:${other}:${String(this.epoch)}:1`;
  }

  unknownHandle(kind: 'c' | 'p'): string {
    return `${kind}:${this.short}:${String(this.epoch)}:${String(kind === 'c' ? this.#contentSeq + 1000 : this.#placementSeq + 1000)}`;
  }

  // Tokens ------------------------------------------------------------------------------------

  /** Advances the given components of a content; revision follows notes, pitch and content. */
  touch(content: ContentRec, ...components: Component[]): void {
    for (const component of components) content.comp[component] = this.mint(component.slice(0, 1));
    if (components.some((c) => REVISION_COMPONENTS.includes(c))) content.revision = this.mint('r');
  }

  touchGeometry(placement: PlacementRec): void {
    placement.geometryHash = this.mint('h');
    this.arrangement = this.mint('a');
  }

  /** A change of a placement that its geometryHash does not cover (gain, fades, reference). */
  touchArrangement(): void {
    this.arrangement = this.mint('a');
  }

  touchTrackState(): void {
    this.trackState = this.mint('t');
  }

  /** Shows the first `count` track slots; the visibility of every slot follows. */
  setVisibleTrackCount(count: number): void {
    this.visibleTrackCount = count;
    for (const track of this.tracks) track.visible = track.trackId < count;
  }

  /** Shows the tracks up to `trackId` and returns those that were hidden before. */
  revealThrough(trackId: number): number[] {
    const revealed: number[] = [];
    for (let id = this.visibleTrackCount; id <= trackId; id++) revealed.push(id);
    if (revealed.length > 0) {
      this.setVisibleTrackCount(trackId + 1);
      this.touchTrackState();
    }
    return revealed;
  }

  /** Takes a placement out of the project; its content goes with it when no other placement shows it. */
  removePlacement(placement: PlacementRec): ContentRec | null {
    this.placements.delete(placement.serial);
    this.selectedPlacementIds = this.selectedPlacementIds.filter((id) => id !== placement.id);
    if (this.placementsOf(placement.content).length > 0) return null;
    this.contents.delete(placement.content.objectId);
    return placement.content;
  }

  /**
   * Replaces the project, as opening one does: every clip and content is removed, the handles of
   * the old project become stale (a new epoch), the tracks go back to their initial state, the
   * selection and the editor are reset and both histories are cleared. Returns how many history
   * entries were cleared.
   */
  resetProject(): { undoCount: number; redoCount: number } {
    const cleared = { undoCount: this.undoStack.length, redoCount: this.redoStack.length };
    this.contents.clear();
    this.placements.clear();
    this.epoch++;
    this.selectedPlacementIds = [];
    this.activeTrackId = 0;
    this.workspace = 'arrangement';
    this.pianoRollContent = null;
    this.undoStack = [];
    this.redoStack = [];
    for (const track of this.tracks) Object.assign(track, defaultTrack(track.trackId));
    this.visibleTrackCount = INITIAL_VISIBLE_TRACKS;
    this.arrangement = this.mint('a');
    this.trackState = this.mint('t');
    return cleared;
  }

  /** Queues rendering of a content again; it settles RENDER_SETTLE_MS later (section 14.6). */
  queueRender(content: ContentRec): void {
    const desired = this.mint('d');
    content.render.desired = desired;
    this.after(RENDER_SETTLE_MS, () => {
      content.render.published = content.render.desired;
    });
  }

  /** Runs `work` on the "main thread" `ms` later; a timer still pending when the world is disposed never runs. */
  after(ms: number, work: () => void): void {
    const timer = this.clock.setTimer(ms, () => {
      this.#timers.delete(timer);
      work();
    });
    this.#timers.add(timer);
  }

  /**
   * Queues the reference alignment analysis of a content; its data is there ALIGNMENT_SETTLE_MS later.
   * Under a reference fault OpenTune's analysis never completes, so no data arrives.
   */
  queueAlignment(content: ContentRec): void {
    this.after(ALIGNMENT_SETTLE_MS, () => {
      if (this.contents.get(content.objectId) !== content || content.alignmentReady) return;
      if (this.referenceFault !== null) return;
      content.alignmentReady = true;
      this.touch(content, 'reference');
    });
  }

  /**
   * OpenTune reconfigures its vocoder for a new weight or rendering priority. It starts asynchronously: the command
   * waits in a queue first, so for `queuedMs` the vocoder still reports ready and not reconfiguring; then it reports
   * reconfiguring for `reconfiguringMs`, and is ready again after that (never under the fault `stuck`; under `loadFails`
   * the command ends but the vocoder stays not ready).
   */
  reconfigureVocoder(): void {
    const { vocoder, vocoderTiming } = this;
    vocoder.commandPending = true;
    this.after(vocoderTiming.queuedMs, () => {
      vocoder.ready = false;
      vocoder.reconfiguring = true;
      this.after(vocoderTiming.reconfiguringMs, () => {
        if (this.vocoderFault === 'stuck') return;
        if (this.vocoderFault === 'loadFails') this.failVocoderLoad();
        else this.finishVocoder();
      });
    });
  }

  /** The command for the vocoder has finished, but the vocoder could not load the new weight and is not ready. */
  failVocoderLoad(): void {
    this.vocoder.ready = false;
    this.vocoder.reconfiguring = false;
    this.vocoder.commandPending = false;
  }

  /** The vocoder is ready again; a reconfiguration that was stuck ends. */
  finishVocoder(): void {
    this.vocoder.ready = true;
    this.vocoder.reconfiguring = false;
    this.vocoder.commandPending = false;
  }

  /** The vocoder is not ready although nothing about it is queued or running any more: it could not load. */
  get vocoderLoadFailed(): boolean {
    const { ready, reconfiguring, commandPending } = this.vocoder;
    return !ready && !reconfiguring && !commandPending;
  }

  /** The vocoder is ready and nothing about it is queued or running (OpenTune's control worker is idle). */
  get vocoderSettled(): boolean {
    const { ready, reconfiguring, commandPending } = this.vocoder;
    return ready && !reconfiguring && !commandPending;
  }

  capture(): Vector {
    return {
      arrangement: this.arrangement,
      trackState: this.trackState,
      contents: new Map([...this.contents].map(([id, c]) => [id, { ...c.comp }])),
      ids: new Map([...this.contents].map(([id, c]) => [id, c.id])),
    };
  }

  /** Only the components that differ (section 14.4 rule 5). */
  diff(before: Vector, after: Vector): RevisionDiff {
    const pair = (a: string, b: string): RevisionPair | null => (a === b ? null : { before: a, after: b });
    const contents: RevisionDiff['contents'] = [];
    for (const id of new Set([...before.contents.keys(), ...after.contents.keys()])) {
      const was = before.contents.get(id);
      const now = after.contents.get(id);
      const changed: Partial<Record<Component, RevisionPair>> = {};
      for (const component of Object.keys(now ?? was ?? {}) as Component[]) {
        const a = was?.[component] ?? null;
        const b = now?.[component] ?? null;
        if (a !== b) changed[component] = { before: a, after: b };
      }
      if (Object.keys(changed).length > 0) {
        contents.push({ contentId: after.ids.get(id) ?? before.ids.get(id) ?? '', changed });
      }
    }
    return {
      arrangement: pair(before.arrangement, after.arrangement),
      trackState: pair(before.trackState, after.trackState),
      contents,
    };
  }

  contentTokens(content: ContentRec) {
    return {
      contentId: content.id,
      revision: content.revision,
      gridRevision: content.comp.grid,
      keyRevision: content.comp.key,
    };
  }

  asOf(contents: readonly ContentRec[]) {
    return { arrangementRevision: this.arrangement, contents: contents.map((c) => this.contentTokens(c)) };
  }

  tokens(contents: readonly ContentRec[], placements: readonly PlacementRec[] = []) {
    return {
      arrangementRevision: this.arrangement,
      contents: contents.map((c) => this.contentTokens(c)),
      placements: placements.map((p) => ({ placementId: p.id, geometryHash: p.geometryHash })),
    };
  }

  // Time grid (section 8.1) ------------------------------------------------------------------

  /** The time grid as a list of (content, output) points; its ends map to themselves. */
  #gridPoints(content: ContentRec): [number, number][] {
    const inner = [...content.handles].sort((a, b) => a.contentSec - b.contentSec);
    return [
      [0, 0],
      ...inner.map((h): [number, number] => [h.contentSec, h.outputSec]),
      [content.durationSec, content.durationSec],
    ];
  }

  #interpolate(points: [number, number][], x: number): number {
    for (let i = 1; i < points.length; i++) {
      const [x0, y0] = points[i - 1] ?? [0, 0];
      const [x1, y1] = points[i] ?? [0, 0];
      if (x <= x1 || i === points.length - 1) return x1 === x0 ? y1 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
    }
    return x;
  }

  contentToOutput(content: ContentRec, contentSec: number): number {
    return this.#interpolate(this.#gridPoints(content), contentSec);
  }

  outputToContent(content: ContentRec, outputSec: number): number {
    return this.#interpolate(
      this.#gridPoints(content).map(([c, o]): [number, number] => [o, c]),
      outputSec,
    );
  }

  gridIsIdentity(content: ContentRec): boolean {
    return content.handles.every((h) => Math.abs(h.contentSec - h.outputSec) < 1e-9);
  }

  // Project state -------------------------------------------------------------------------------

  /** section 15.5: after a change saved with the project, the flag is set. */
  markDirty(): void {
    this.project.dirty = true;
    this.changeCount++;
  }

  uiSnapshot() {
    return {
      workspace: this.workspace,
      pianoRollContentId: this.pianoRollContent?.id ?? null,
      activeTrackId: this.activeTrackId,
      selectedPlacementIds: [...this.selectedPlacementIds],
      visibleTrackCount: this.visibleTrackCount,
    };
  }

  trackLabel(trackId: number): string {
    return `Track ${String(trackId + 1)}`;
  }

  /** `undoId`s are numbered from 1 (section 9). */
  nextUndoId(): { seq: number; undoId: string } {
    const seq = ++this.#undoSeq;
    return { seq, undoId: `u:${this.short}:${String(seq)}` };
  }

  undoIdOf(seq: number): string {
    return `u:${this.short}:${String(seq)}`;
  }

  /** Why a write is refused now, if it is (section 13.2); `exportLock` is held by a running export job. */
  busyReason(exportLock: boolean, ignoreModal = false): string | undefined {
    if (this.busy.pointerDown) return BUSY_REASONS.pointerDown;
    if (!ignoreModal && (this.busy.modalOpen || this.dialogs.length > 0)) return BUSY_REASONS.modalOpen;
    if (this.busy.importInProgress) return BUSY_REASONS.importInProgress;
    if (exportLock) return 'export_in_progress';
    if (this.busy.projectOperation) return BUSY_REASONS.projectOperation;
    return undefined;
  }

  /** Test interface: the analysis of a content finishes, fails or is requested again. */
  setAnalysis(content: ContentRec, analysis: Analysis): void {
    content.analysis = analysis;
    if (analysis === 'ready' && content.key === null) content.key = { ...DETECTED_KEY };
    this.touch(content, 'content');
  }

  /** Test interface: the data of the project without any token, for comparing states. */
  dataSnapshot() {
    return {
      dirty: this.project.dirty,
      contents: [...this.contents.values()].map((c) => ({
        id: c.id,
        analysis: c.analysis,
        notes: clone(c.notes),
        key: clone(c.key),
        pitchShift: clone(c.pitchShift),
        handles: clone(c.handles),
      })),
      placements: [...this.placements.values()].map((p) => ({
        id: p.id,
        trackId: p.trackId,
        startTimelineSec: p.startTimelineSec,
        durationSec: p.durationSec,
        clipInContentSec: p.clipInContentSec,
        gainLinear: p.gainLinear,
        fadeInSec: p.fadeInSec,
        fadeOutSec: p.fadeOutSec,
        reference: p.reference?.id ?? null,
      })),
      tracks: this.tracks.map(({ visible, muted, solo, volumeLinear, colour }) => ({
        visible,
        muted,
        solo,
        volumeLinear,
        colour,
      })),
    };
  }

  dispose(): void {
    for (const timer of this.#timers) timer.cancel();
    this.#timers.clear();
  }
}
