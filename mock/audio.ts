// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The audio device methods of the mock (capability audio.device): audio.get and audio.set
// (spec/otcp/v1/methods/audio.get.schema.json). The setup belongs to the installation, not to the
// project. The mock has one stand-in device type with two output devices, two sample rates and two buffer sizes; a
// test can make it fail to open (`failsToOpen`), so that audio.set restores the previous setup.

import { checkNotBusy, envelope, type Handler } from './context.js';
import { refuse } from './errors.js';
import { AUDIO_AVAILABLE, type AudioRec } from './model.js';
import { EMPTY_DIFF } from './writes.js';

const warning = (code: string, subject: unknown = null, data: unknown = null) => ({ code, subject, data });

type Member = 'deviceType' | 'outputDevice' | 'sampleRateHz' | 'bufferSizeFrame' | 'outputChannelPair';
const MEMBERS: readonly { name: Member; unit: string | null }[] = [
  { name: 'deviceType', unit: null },
  { name: 'outputDevice', unit: null },
  { name: 'sampleRateHz', unit: 'hz' },
  { name: 'bufferSizeFrame', unit: 'frame' },
  { name: 'outputChannelPair', unit: null },
];

/** The device as audio.get and audio.set report it: members other than `running` are null without a device. */
export function deviceView(audio: AudioRec) {
  if (audio.running) {
    return {
      running: true,
      deviceType: audio.deviceType,
      outputDevice: audio.outputDevice,
      sampleRateHz: audio.sampleRateHz,
      bufferSizeFrame: audio.bufferSizeFrame,
      outputChannelPair: audio.outputChannelPair,
    };
  }
  return {
    running: false,
    deviceType: null,
    outputDevice: null,
    sampleRateHz: null,
    bufferSizeFrame: null,
    outputChannelPair: null,
    nullReasons: Object.fromEntries(MEMBERS.map(({ name }) => [name, 'no_audio_device'])),
  };
}

const available = () => ({
  deviceTypes: [...AUDIO_AVAILABLE.deviceTypes],
  outputDevices: [...AUDIO_AVAILABLE.outputDevices],
  sampleRatesHz: [...AUDIO_AVAILABLE.sampleRatesHz],
  bufferSizesFrame: [...AUDIO_AVAILABLE.bufferSizesFrame],
  outputChannelPairCount: AUDIO_AVAILABLE.outputChannelPairCount,
});

const get: Handler = ({ world }) => ({ device: deviceView(world.audio), available: available() });

/** Whether the setup offers the value the call asks for. */
function offered(name: Member, value: string | number): boolean {
  switch (name) {
    case 'deviceType':
      return (AUDIO_AVAILABLE.deviceTypes as readonly (string | number)[]).includes(value);
    case 'outputDevice':
      return (AUDIO_AVAILABLE.outputDevices as readonly (string | number)[]).includes(value);
    case 'sampleRateHz':
      return (AUDIO_AVAILABLE.sampleRatesHz as readonly (string | number)[]).includes(value);
    case 'bufferSizeFrame':
      return (AUDIO_AVAILABLE.bufferSizesFrame as readonly (string | number)[]).includes(value);
    case 'outputChannelPair':
      return typeof value === 'number' && value < AUDIO_AVAILABLE.outputChannelPairCount;
  }
}

const set: Handler = (context) => {
  const { world, params } = context;
  checkNotBusy(context);
  const audio = world.audio;
  const given = MEMBERS.flatMap(({ name }) => {
    const value = params[name] as string | number | undefined;
    return value === undefined ? [] : [{ name, value }];
  });
  const unavailable = given.find(({ name, value }) => !offered(name, value));
  if (unavailable !== undefined) {
    throw refuse(
      'INVALID_ARGUMENT',
      'audio_setting_unavailable',
      `the audio setup does not offer the requested ${unavailable.name}`,
    );
  }
  const differing = given.filter(({ name, value }) => audio[name] !== value);
  const dirtyBefore = world.project.dirty;
  if (audio.running && differing.length === 0) {
    return envelope(world, {
      applied: true,
      noOp: true,
      diff: EMPTY_DIFF,
      contents: [],
      undo: { undoable: false, reason: 'no_op', revert: null },
      dirtyBefore,
      extra: { device: deviceView(audio) },
    });
  }
  if (audio.failsToOpen) {
    // The previous setup is restored, as the settings page does; the call changed nothing.
    throw refuse('IO_ERROR', 'device_open_failed', 'the device could not be opened with the new setup');
  }
  const wasRunning = audio.running;
  const before = deviceView(audio);
  const revert: Record<string, string | number> = {};
  for (const { name, value } of differing) {
    revert[name] = audio[name];
    // The type of the member follows from its name; the value was checked against the offer above.
    Object.assign(audio, { [name]: value });
  }
  audio.running = true;
  world.transport.audioDeviceRunning = true;
  const after = deviceView(audio);
  const fields: Record<string, unknown> = {};
  if (!wasRunning) fields.running = { before: false, after: true, unit: null };
  for (const { name, unit } of MEMBERS) {
    if (before[name] !== after[name]) fields[name] = { before: before[name], after: after[name], unit };
  }
  return envelope(world, {
    applied: true,
    noOp: false,
    changes: [{ entity: 'audioDevice', ref: { singleton: 'audioDevice' }, label: 'Audio device', fields }],
    diff: EMPTY_DIFF,
    contents: [],
    undo: {
      undoable: false,
      reason: 'ui_parity',
      revert: wasRunning ? { method: 'audio.set', params: revert } : null,
    },
    dirtyBefore,
    warnings: [warning('GLOBAL_PREFERENCE', null, { preferences: ['audioDevice'] })],
    extra: { device: after },
  });
};

export const audioHandlers: Readonly<Record<string, Handler>> = { 'audio.get': get, 'audio.set': set };
