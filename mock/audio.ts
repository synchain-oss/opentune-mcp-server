// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The audio device methods of the mock (capability audio.device): audio.get and audio.set
// (spec/otcp/v1/methods/audio.get.schema.json). The setup belongs to the installation, not to the
// project. The mock has two stand-in device types (the first with two output devices, the second with one), two
// sample rates and two buffer sizes; switching the device type opens the default (first) output device of the new
// type, as OpenTune does. A test can make it fail to open (`failsToOpen`), so that audio.set restores the previous
// setup, or make the restoration of an ASIO sample rate fail (`asioRateRestoreFails`): the mock's device types are
// stand-ins, so the failure is a flag, and the switch goes on with the warning ASIO_RATE_NOT_RESTORED.

import { checkNotBusy, envelope, type Handler } from './context.js';
import { refuse } from './errors.js';
import { AUDIO_AVAILABLE, outputDevicesOf, type AudioRec } from './model.js';
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

/** What the setup offers for the current device type. */
const available = (audio: AudioRec, outputChannelPairCount: number) => ({
  deviceTypes: [...AUDIO_AVAILABLE.deviceTypes],
  outputDevices: [...outputDevicesOf(audio.deviceType)],
  sampleRatesHz: [...AUDIO_AVAILABLE.sampleRatesHz],
  bufferSizesFrame: [...AUDIO_AVAILABLE.bufferSizesFrame],
  outputChannelPairCount,
});

const get: Handler = ({ world }) => ({
  device: deviceView(world.audio),
  available: available(world.audio, world.outputChannelPairCount),
});

/** Whether the setup offers the value the call asks for; output devices are those of the device type that will run. */
function offered(name: Member, value: string | number, deviceType: string, outputChannelPairCount: number): boolean {
  switch (name) {
    case 'deviceType':
      return (AUDIO_AVAILABLE.deviceTypes as readonly (string | number)[]).includes(value);
    case 'outputDevice':
      return (outputDevicesOf(deviceType) as readonly (string | number)[]).includes(value);
    case 'sampleRateHz':
      return (AUDIO_AVAILABLE.sampleRatesHz as readonly (string | number)[]).includes(value);
    case 'bufferSizeFrame':
      return (AUDIO_AVAILABLE.bufferSizesFrame as readonly (string | number)[]).includes(value);
    case 'outputChannelPair':
      return typeof value === 'number' && value < outputChannelPairCount;
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
  const targetType = typeof params.deviceType === 'string' ? params.deviceType : audio.deviceType;
  const unavailable = given.find(({ name, value }) => !offered(name, value, targetType, world.outputChannelPairCount));
  if (unavailable !== undefined) {
    throw refuse(
      'INVALID_ARGUMENT',
      'audio_setting_unavailable',
      `the audio setup does not offer the requested ${unavailable.name}`,
    );
  }
  // Another device type opens its default output device, unless the call names one.
  const wanted: Record<Member, string | number> = { ...audio };
  if (targetType !== audio.deviceType) {
    wanted.deviceType = targetType;
    wanted.outputDevice = outputDevicesOf(targetType)[0] ?? audio.outputDevice;
  }
  for (const { name, value } of given) wanted[name] = value;
  const differing = MEMBERS.filter(({ name }) => audio[name] !== wanted[name]).map(({ name }) => ({
    name,
    value: wanted[name],
  }));
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
  // OpenTune restores the sample rate of an ASIO device before it switches the device type or the output device. The
  // restoration is best effort: a failure does not stop the switch and is reported as a warning.
  const rateNotRestored =
    wasRunning &&
    audio.asioRateRestoreFails &&
    differing.some(({ name }) => name === 'deviceType' || name === 'outputDevice')
      ? warning(
          'ASIO_RATE_NOT_RESTORED',
          { singleton: 'audioDevice' },
          { deviceName: audio.outputDevice, sampleRateHz: audio.sampleRateHz },
        )
      : null;
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
    warnings: [
      warning('GLOBAL_PREFERENCE', null, { preferences: ['audioDevice'] }),
      ...(rateNotRestored === null ? [] : [rateNotRestored]),
    ],
    extra: { device: after },
  });
};

export const audioHandlers: Readonly<Record<string, Handler>> = { 'audio.get': get, 'audio.set': set };
