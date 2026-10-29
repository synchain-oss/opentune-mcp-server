// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The transport methods of the mock (capability transport.v1): transport.control,
// transport.setTempo and transport.setLoop (spec/otcp/v1/PROTOCOL.md sections 14 and 15.4 rule 5).
// Play state, position and loop flag are view state: they have no undo entry and do not mark the
// project as changed. "Play from start" returns to the position of the last play or seek.

import { checkNotBusy, envelope, type Handler, type MethodContext } from './context.js';
import { EMPTY_DIFF } from './writes.js';

const warning = (code: string, subject: unknown = null) => ({ code, subject, data: null });
const SINGLETON = { singleton: 'transport' } as const;

type Action = 'play' | 'pause' | 'stop' | 'seek' | 'playFromLastStart' | 'pauseAtLastStart';

interface TransportState {
  playing: boolean;
  positionTimelineSec: number;
  playStartTimelineSec: number;
}

/** What each button does to the play state, the position and the position that play-from-start returns to. */
function next(action: Action, now: TransportState, seek: number | undefined): TransportState {
  switch (action) {
    case 'play':
      return {
        playing: true,
        positionTimelineSec: now.positionTimelineSec,
        playStartTimelineSec: now.positionTimelineSec,
      };
    case 'pause':
      return { ...now, playing: false };
    case 'stop':
      return {
        playing: false,
        positionTimelineSec: now.playStartTimelineSec,
        playStartTimelineSec: now.playStartTimelineSec,
      };
    case 'seek':
      return {
        ...now,
        positionTimelineSec: seek ?? now.positionTimelineSec,
        playStartTimelineSec: seek ?? now.positionTimelineSec,
      };
    case 'playFromLastStart':
      return {
        playing: true,
        positionTimelineSec: now.playStartTimelineSec,
        playStartTimelineSec: now.playStartTimelineSec,
      };
    case 'pauseAtLastStart':
      return now.playing
        ? {
            playing: false,
            positionTimelineSec: now.playStartTimelineSec,
            playStartTimelineSec: now.playStartTimelineSec,
          }
        : now;
  }
}

const transportView = ({ world }: MethodContext) => ({
  ...world.transport,
  timeSignature: { ...world.transport.timeSignature },
  lastControl: world.transport.lastControl === null ? null : { ...world.transport.lastControl },
});

const control: Handler = (context) => {
  const { world, params } = context;
  checkNotBusy(context);
  const action = params.action as Action;
  world.settleTransport();
  const t = world.transport;
  const before: TransportState = {
    playing: t.playing,
    positionTimelineSec: t.positionTimelineSec,
    playStartTimelineSec: t.playStartTimelineSec,
  };
  const after = next(action, before, params.positionTimelineSec as number | undefined);
  const fields: Record<string, unknown> = {};
  if (before.playing !== after.playing) fields.playing = { before: before.playing, after: after.playing, unit: null };
  if (before.positionTimelineSec !== after.positionTimelineSec) {
    fields.positionTimelineSec = { before: before.positionTimelineSec, after: after.positionTimelineSec, unit: 'sec' };
  }
  if (before.playStartTimelineSec !== after.playStartTimelineSec) {
    fields.playStartTimelineSec = {
      before: before.playStartTimelineSec,
      after: after.playStartTimelineSec,
      unit: 'sec',
    };
  }
  Object.assign(t, after);
  t.lastControl = { call: action, atMs: world.now() };
  const noOp = Object.keys(fields).length === 0;
  const warnings =
    (action === 'play' || action === 'playFromLastStart') && !t.audioDeviceRunning ? [warning('NO_AUDIO_DEVICE')] : [];
  return envelope(world, {
    applied: true,
    noOp,
    changes: noOp ? [] : [{ entity: 'transport', ref: SINGLETON, label: 'Transport', fields }],
    diff: EMPTY_DIFF,
    contents: [],
    undo: noOp
      ? { undoable: false, reason: 'no_op', revert: null }
      : { undoable: false, reason: 'not_persisted_state', revert: null },
    dirtyBefore: world.project.dirty,
    warnings,
    extra: { transport: transportView(context) },
  });
};

const setTempo: Handler = (context) => {
  const { world, params } = context;
  checkNotBusy(context);
  const t = world.transport;
  const bpm = typeof params.bpm === 'number' ? params.bpm : t.bpm;
  const signature = (params.timeSignature as { numerator: number; denominator: number } | undefined) ?? t.timeSignature;
  const fields: Record<string, unknown> = {};
  if (bpm !== t.bpm) fields.bpm = { before: t.bpm, after: bpm, unit: 'bpm' };
  if (signature.numerator !== t.timeSignature.numerator || signature.denominator !== t.timeSignature.denominator) {
    fields.timeSignature = { before: { ...t.timeSignature }, after: { ...signature }, unit: null };
  }
  // The recipe lists the members the call changes, as OpenTune does: a call that changes only the tempo gets
  // a recipe with the tempo alone, which a client must be able to carry out too.
  const previous = {
    ...(fields.bpm === undefined ? {} : { bpm: t.bpm }),
    ...(fields.timeSignature === undefined ? {} : { timeSignature: { ...t.timeSignature } }),
  };
  const dirtyBefore = world.project.dirty;
  const noOp = Object.keys(fields).length === 0;
  if (!noOp) {
    t.bpm = bpm;
    t.timeSignature = { numerator: signature.numerator, denominator: signature.denominator };
    world.markDirty();
  }
  return envelope(world, {
    applied: true,
    noOp,
    changes: noOp ? [] : [{ entity: 'tempo', ref: { singleton: 'tempo' }, label: 'Tempo', fields }],
    diff: EMPTY_DIFF,
    contents: [],
    undo: noOp
      ? { undoable: false, reason: 'no_op', revert: null }
      : { undoable: false, reason: 'ui_parity', revert: { method: 'transport.setTempo', params: previous } },
    dirtyBefore,
    extra: { tempo: { bpm: t.bpm, timeSignature: { ...t.timeSignature } } },
  });
};

const setLoop: Handler = (context) => {
  const { world, params } = context;
  checkNotBusy(context);
  const t = world.transport;
  const enabled = params.enabled === true;
  const previous = t.loopEnabled;
  const noOp = enabled === previous;
  t.loopEnabled = enabled;
  const warnings = noOp
    ? []
    : [...(enabled ? [warning('LOOP_NO_EFFECT_STANDALONE')] : []), warning('NOT_PERSISTED', SINGLETON)];
  return envelope(world, {
    applied: true,
    noOp,
    changes: noOp
      ? []
      : [
          {
            entity: 'transport',
            ref: SINGLETON,
            label: 'Transport',
            fields: { loopEnabled: { before: previous, after: enabled, unit: null } },
          },
        ],
    diff: EMPTY_DIFF,
    contents: [],
    undo: noOp
      ? { undoable: false, reason: 'no_op', revert: null }
      : {
          undoable: false,
          reason: 'not_persisted_state',
          revert: { method: 'transport.setLoop', params: { enabled: previous } },
        },
    dirtyBefore: world.project.dirty,
    warnings,
    extra: { transport: transportView(context) },
  });
};

export const transportHandlers: Readonly<Record<string, Handler>> = {
  'transport.control': control,
  'transport.setTempo': setTempo,
  'transport.setLoop': setLoop,
};
