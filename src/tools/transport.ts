// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_transport: the transport buttons and fields of OpenTune (capability transport.v1). One call
// can set the tempo and time signature, the loop flag and one play action. They run in that order,
// so a play action uses the new tempo. The play state, the position and the loop flag are view
// state; the tempo and time signature are saved with the project but have no undo entry, as in
// OpenTune, so the result gives the call that restores them.

import { z } from 'zod';

import { INSTANCE_FIELD, invalid } from './clip-write.js';
import { combineResults, runWrites, type WriteCall } from './multi-write.js';
import { WRITE_RESULT_OUTPUT, defineTool, withInstance, type Outcome, type ToolContext } from './registry.js';

const TOOL = 'opentune_transport';

const ACTIONS = ['play', 'pause', 'stop', 'seek', 'play_from_last_start', 'return_to_last_start'] as const;
type Action = (typeof ACTIONS)[number];

const OTCP_ACTION: Readonly<Record<Action, string>> = {
  play: 'play',
  pause: 'pause',
  stop: 'stop',
  seek: 'seek',
  play_from_last_start: 'playFromLastStart',
  return_to_last_start: 'pauseAtLastStart',
};

export interface TransportArgs {
  readonly action?: Action | undefined;
  readonly position_sec?: number | undefined;
  readonly bpm?: number | undefined;
  readonly time_signature?: { readonly numerator: number; readonly denominator: number } | undefined;
  readonly loop?: boolean | undefined;
  readonly instance_id?: string | undefined;
}

export async function transport(ctx: ToolContext, args: TransportArgs): Promise<Outcome> {
  const { action, bpm, time_signature: signature, loop } = args;
  if (action === undefined && bpm === undefined && signature === undefined && loop === undefined) {
    return invalid('give action, bpm, time_signature, loop or several: there is nothing to do');
  }
  if (action === 'seek' && args.position_sec === undefined) {
    return invalid('action seek needs position_sec, the timeline position in seconds', 'position_required');
  }
  if (action !== 'seek' && args.position_sec !== undefined) {
    return invalid('position_sec is only allowed with action seek', 'position_unexpected');
  }
  const calls: WriteCall[] = [];
  if (bpm !== undefined || signature !== undefined) {
    calls.push({
      method: 'transport.setTempo',
      params: {
        ...(bpm === undefined ? {} : { bpm }),
        ...(signature === undefined
          ? {}
          : { timeSignature: { numerator: signature.numerator, denominator: signature.denominator } }),
      },
    });
  }
  if (loop !== undefined) calls.push({ method: 'transport.setLoop', params: { enabled: loop } });
  if (action !== undefined) {
    calls.push({
      method: 'transport.control',
      params: {
        action: OTCP_ACTION[action],
        ...(args.position_sec === undefined ? {} : { positionTimelineSec: args.position_sec }),
      },
    });
  }
  return withInstance(ctx, { instanceId: args.instance_id }, ['transport.v1'], async (session) => {
    const run = await runWrites(session, TOOL, calls);
    if ('stopped' in run) return run.stopped;
    return { ok: true, body: combineResults(TOOL, run.results) };
  });
}

export const transportTool = defineTool({
  name: TOOL,
  title: 'Control OpenTune transport',
  description:
    'OpenTune (audio vocal pitch editor): the transport bar. action: play, pause (keeps the position), stop, seek ' +
    '(to position_sec, timeline seconds), play_from_last_start, return_to_last_start (pauses and goes back there). ' +
    'The last start is where playback last began or the last seek went, not 0. bpm (1..999), time_signature and ' +
    'loop are set before the action. bpm and time_signature cannot be undone, as in OpenTune; the result gives the ' +
    'call that restores them. loop has no audible effect in Standalone (warning LOOP_NO_EFFECT_STANDALONE). ' +
    'Without an audio device nothing is heard.',
  inputSchema: z.strictObject({
    action: z.enum(ACTIONS).optional(),
    position_sec: z.number().min(0).optional().describe('Timeline seconds. Only with action seek, where required.'),
    bpm: z.number().min(1).max(999).optional(),
    time_signature: z
      .strictObject({
        numerator: z.number().int().min(1).max(32),
        denominator: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16), z.literal(32)]),
      })
      .optional(),
    loop: z.boolean().optional(),
    instance_id: INSTANCE_FIELD,
  }),
  outputSchema: WRITE_RESULT_OUTPUT,
  // Not idempotent: play_from_last_start seeks back to the last start every time, also while playing.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  capabilities: ['transport.v1'],
  otcpMethods: ['transport.control', 'transport.setTempo', 'transport.setLoop'],
  run: (args, ctx) => transport(ctx, args),
});
