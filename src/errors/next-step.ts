// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Default next steps of every error kind and every status of opentune_get_status, and the links to
// their sections in docs/TROUBLESHOOTING.md. A reason refines the step where the right action
// differs from the kind's default. Unit tests check that every kind, status and doctor check has
// a step and an anchor.

import type { NextStep } from './tool-error.js';

const DOCS = 'https://github.com/synchain-oss/opentune-mcp-server/blob/prod/docs/TROUBLESHOOTING.md';

/** Link to a section of docs/TROUBLESHOOTING.md (`error-<kind>`, `status-<state>`, `doctor-<id>`). */
export function troubleshootingUrl(anchor: string): string {
  return `${DOCS}#${anchor}`;
}

const STATUS: NextStep = { actor: 'agent', tool: 'opentune_get_status', message: '' };
const agent = (message: string): NextStep => ({ actor: 'agent', message });
const user = (message: string): NextStep => ({ actor: 'user', message });
const status = (message: string): NextStep => ({ ...STATUS, message });

interface KindEntry {
  readonly retryable: boolean;
  readonly step: NextStep;
}

const k = (retryable: boolean, step: NextStep): KindEntry => ({ retryable, step });

const INTERNAL = k(false, status('Unexpected error. Check the status and re-read any state before retrying.'));

/** Every OTCP kind and every kind this server adds. */
const KINDS: Readonly<Record<string, KindEntry>> = {
  AUTH_FAILED: k(false, status('OpenTune refused the connection, probably because it restarted. Check the status.')),
  PROTOCOL_MISMATCH: k(
    false,
    user(
      'This OpenTune build speaks another control protocol version. Ask the user to update OpenTune or this server.',
    ),
  ),
  SHUTTING_DOWN: k(false, status('OpenTune is closing. Check the status before doing anything else.')),
  INVALID_ARGUMENT: k(false, agent('The arguments were rejected; correct them as the detail says and call again.')),
  NOT_FOUND: k(false, agent('The object no longer exists or the id is out of date. Read the current state again.')),
  NOT_READY: k(true, agent('OpenTune is still analysing the audio. Wait a few seconds and call again.')),
  ANALYSIS_FAILED: k(false, user('OpenTune could not analyse the pitch of this audio. Tell the user.')),
  RENDER_FAILED: k(false, user('OpenTune could not render the corrected audio. Tell the user.')),
  MODEL_UNAVAILABLE: k(false, user('A model OpenTune needs is missing. Ask the user to run "opentune-mcp doctor".')),
  REVISION_CONFLICT: k(
    false,
    agent('The object changed since it was read. Read it again, then retry with the new revision.'),
  ),
  UNDO_CONFLICT: k(false, user('The undo history is not as expected. Ask the user how to proceed; do not force it.')),
  UNSAVED_CHANGES: k(false, user('The project has unsaved changes. Ask the user whether to save or discard them.')),
  ALREADY_EXISTS: k(false, user('The target already exists. Ask the user for another target.')),
  BUSY: k(true, user('OpenTune is busy (for example a dialog is open). Ask the user to finish, then retry.')),
  TIMEOUT: k(true, agent('OpenTune did not start the request in time; nothing changed. Retry.')),
  CANCELLED: k(false, agent('The job was cancelled. Its result lists any work it committed before it stopped.')),
  IO_ERROR: k(false, user('A file could not be read or written. Tell the user which operation failed.')),
  UNSUPPORTED: k(false, user('OpenTune does not support this here. Tell the user; do not work around it.')),
  INTERNAL,
  OPENTUNE_NOT_AVAILABLE: k(false, status('No ready OpenTune instance. Check the status and follow its next step.')),
  MULTIPLE_INSTANCES: k(
    false,
    user('Several OpenTune instances are running. Ask the user which one to use, then pass its instance_id.'),
  ),
  INSTANCE_NOT_FOUND: k(
    false,
    user('That OpenTune instance is gone (closed or restarted). Ask the user before using another instance.'),
  ),
  INSTANCE_UNVERIFIED: k(
    false,
    user(
      'The process at the discovered port is not the OpenTune instance that announced it. Ask the user to restart OpenTune.',
    ),
  ),
  CONNECTION_LOST: k(
    true,
    status('The connection to OpenTune was lost; the request may or may not have run. Re-read state before retrying.'),
  ),
  REQUEST_TIMEOUT: k(
    true,
    status('OpenTune did not answer in time; the request may still run. Re-read state before retrying.'),
  ),
  CONFIG_INVALID: k(false, user('The server configuration is invalid. Ask the user to fix it as the detail says.')),
};

/** Steps that differ from the kind's default, by `<kind>/<reason>`. */
const REASONS: Readonly<Record<string, NextStep>> = {
  'INVALID_ARGUMENT/confirm_required': user(
    'This is destructive. Ask the user to confirm explicitly; only then call again with confirm: true.',
  ),
  'NOT_FOUND/job_not_found': agent('The job is unknown or expired (finished jobs are kept for 30 minutes).'),
  'NOT_READY/f0_failed': user('Pitch analysis of this clip failed, so it cannot be edited. Tell the user.'),
  'NOT_READY/f0_empty': user('OpenTune found no singing in this clip, so it cannot be edited. Tell the user.'),
  'BUSY/request_limit': agent('Too many requests at once. Wait for the pending ones, then retry.'),
  'BUSY/job_limit': agent('Too many jobs are running. Wait for one to finish (opentune_get_job), then retry.'),
  'BUSY/session_limit': user(
    'OpenTune already has the maximum number of control connections. Ask the user to close other clients.',
  ),
  'UNSUPPORTED/capability_missing': user(
    'This OpenTune build lacks the feature (see detail). Ask the user to update to a build that has it.',
  ),
  'UNSUPPORTED/job_not_cancellable': agent(
    'This job cannot be cancelled now; it continues. Follow it with opentune_get_job.',
  ),
};

/** The default next step, retryability and anchor kind of an error. Unknown kinds use INTERNAL. */
export function kindStep(
  kind: string,
  reason: string | null,
): { nextStep: NextStep; retryable: boolean; anchorKind: string } {
  const known = Object.hasOwn(KINDS, kind);
  const entry = (known ? KINDS[kind] : undefined) ?? INTERNAL;
  const refined = reason === null ? undefined : REASONS[`${kind}/${reason}`];
  return { nextStep: refined ?? entry.step, retryable: entry.retryable, anchorKind: known ? kind : 'INTERNAL' };
}

/** Kinds with a default step: the OTCP kinds and this server's own. */
export const KNOWN_ERROR_KINDS: readonly string[] = Object.keys(KINDS);
