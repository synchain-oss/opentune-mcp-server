// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// opentune_set_clip: the key and the pitch shift of one clip. The key change has no undo entry (as
// in OpenTune's transport bar), so its result carries the revert recipe; the pitch shift is one
// undo step. When both are given they are two requests, and the result reports each one on its
// own. The key request goes first: it is the only one that can conflict with the expected
// revision, so a conflict stops the call before anything is applied.

import { z } from 'zod';

import { OtcpError, fromOtcpError } from '../errors/tool-error.js';
import type { Json } from '../otcp/client.js';
import { expectedParams } from '../otcp/tokens.js';
import { writeOutcome } from '../render/index.js';
import {
  CLIP_FIELD,
  INSTANCE_FIELD,
  KEY_FIELD,
  REVISION_FIELD,
  WRITE_TIMEOUT_MS,
  invalid,
  isOutcome,
  resolveContent,
  revisionTokens,
  type KeyArg,
} from './clip-write.js';
import { WRITE_RESULT_OUTPUT, defineTool, withInstance, type Outcome } from './registry.js';

const TOOL = 'opentune_set_clip';

export interface SetClipArgs {
  readonly clip: string;
  readonly expected_revision: string;
  readonly key?: KeyArg | undefined;
  readonly pitch_shift?: { readonly semitones: number; readonly cents: number } | undefined;
  readonly instance_id?: string | undefined;
}

export async function setClip(ctx: Parameters<typeof withInstance>[0], args: SetClipArgs): Promise<Outcome> {
  if (args.key === undefined && args.pitch_shift === undefined) {
    return invalid('give key, pitch_shift or both: there is nothing to set');
  }
  const tokens = revisionTokens(args.expected_revision);
  if (isOutcome(tokens)) return tokens;
  return withInstance(ctx, { instanceId: args.instance_id }, ['edit.v1', 'read.v1'], async (session) => {
    const target = await resolveContent(session, args.clip);
    if (isOutcome(target)) return target;
    const { contentId } = target;

    const calls: { method: string; params: Json }[] = [];
    if (args.key !== undefined) {
      calls.push({
        method: 'content.setKey',
        params: {
          contentId,
          key: { root: args.key.root, scale: args.key.scale },
          ...expectedParams('content.setKey', tokens, ['key']),
        },
      });
    }
    if (args.pitch_shift !== undefined) {
      calls.push({
        method: 'content.setPitchShift',
        params: { contentId, pitchShift: { semitones: args.pitch_shift.semitones, cents: args.pitch_shift.cents } },
      });
    }

    const results: { method: string; outcome: Outcome }[] = [];
    for (const call of calls) {
      try {
        results.push({
          method: call.method,
          outcome: writeOutcome(await session.call(call.method, call.params, WRITE_TIMEOUT_MS), { tool: TOOL }),
        });
      } catch (error) {
        if (!(error instanceof OtcpError) || results.length === 0) throw error;
        // The first request has taken effect: say so next to the error of the second.
        return {
          ok: false,
          error: fromOtcpError(error.data),
          context: {
            applied_before_error: results.map((r) => ({
              method: r.method,
              ...(r.outcome.ok ? r.outcome.body : { error: r.outcome.error }),
            })),
          },
        };
      }
    }

    const [only, second] = results;
    if (only === undefined) return invalid('nothing to set');
    if (second === undefined) return only.outcome;
    const failed = results.find((r) => !r.outcome.ok);
    if (failed !== undefined) return failed.outcome;
    const bodies = results.map((r) => (r.outcome.ok ? r.outcome.body : { summary: '' }));
    const rest = (summary: string) => summary.replace(`${TOOL}: `, '');
    return {
      ok: true,
      body: {
        summary:
          `${TOOL}: two requests were made, reported separately in results. ` +
          `Key: ${rest(bodies[0]?.summary ?? '')} Pitch shift: ${rest(bodies[1]?.summary ?? '')}`,
        results: results.map((r, i) => ({ method: r.method, ...bodies[i] })),
      },
    };
  });
}

export const setClipTool = defineTool({
  name: TOOL,
  title: 'Set OpenTune clip key and pitch shift',
  description:
    'OpenTune (audio vocal pitch editor): sets the key (root and scale) and/or the pitch shift (whole semitones ' +
    'plus cents) of a clip. The key change cannot be undone (as in OpenTune); the result gives the request that ' +
    'restores the previous key. The pitch shift is one undo step; it does not transpose the key. With both, two ' +
    'requests run, key first, and the result reports each. Needs the clip_revision as expected_revision; only the ' +
    'key part of it is checked. Setting the current value changes nothing.',
  inputSchema: z.strictObject({
    clip: CLIP_FIELD,
    expected_revision: REVISION_FIELD,
    key: KEY_FIELD.optional().describe('The clip key to set. Not undoable; the result gives the way back.'),
    pitch_shift: z
      .strictObject({
        semitones: z.number().int().min(-24).max(24),
        cents: z.number().int().min(-99).max(99),
      })
      .optional()
      .describe('Pitch shift to set: whole semitones -24..24 plus cents -99..99. Undoable.'),
    instance_id: INSTANCE_FIELD,
  }),
  outputSchema: WRITE_RESULT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  capabilities: ['edit.v1', 'read.v1'],
  otcpMethods: ['content.setKey', 'content.setPitchShift', 'project.get'],
  run: (args, ctx) => setClip(ctx, args),
});
