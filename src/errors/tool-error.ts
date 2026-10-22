// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The one error shape every tool returns. OTCP errors keep their kind and reason (clients branch
// on the kind only, spec/otcp/v1/PROTOCOL.md section 17); this server adds a few kinds of its own
// for problems that happen before or around OTCP (no instance, several instances, a lost
// connection). Every error carries a next step and a link to its TROUBLESHOOTING section.

import { cleanDetail } from '../sanitize/untrusted.js';
import { kindStep, troubleshootingUrl } from './next-step.js';

export type Actor = 'agent' | 'user';

/** What to do about an error or a status: who acts, and with which tool call if any. */
export interface NextStep {
  readonly actor: Actor;
  /** A tool of this server to call next. */
  readonly tool?: string;
  /** Arguments for `tool`. */
  readonly args?: Readonly<Record<string, unknown>>;
  readonly message: string;
  /** Names of OpenTune menu items or buttons the user can use, as OpenTune labels them. */
  readonly uiLabels?: readonly string[];
}

export interface ToolError {
  readonly kind: string;
  readonly reason: string | null;
  /** Diagnostic text, printable ASCII, at most 1024 characters. Never contains secrets. */
  readonly detail: string;
  readonly retryable: boolean;
  /** false: nothing changed. true: state may have changed. null: unknown (the connection was lost). */
  readonly executed: boolean | null;
  readonly nextStep: NextStep;
  readonly url: string;
  /**
   * The protocol majors the discovery file reports, when a hello failed because the instance does
   * not serve one of them. The same list the status of a PROTOCOL_MISMATCH instance carries.
   */
  readonly protocolMajors?: readonly number[];
}

/** The `error.data` of an OTCP error response, or the same shape for a failure on this side. */
export interface ErrorData {
  readonly kind: string;
  readonly reason: string | null;
  readonly retryable: boolean;
  readonly detail: string;
  readonly executed: boolean | null;
  readonly protocolMajors?: readonly number[];
}

/** The protocol majors of an untrusted value: positive integers, each once, at most 16, else empty. */
export function protocolMajorsOf(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return [];
  const majors = value.filter(
    (entry): entry is number => typeof entry === 'number' && Number.isInteger(entry) && entry > 0,
  );
  return [...new Set(majors)].slice(0, 16);
}

/** Kinds this server adds; OTCP kinds come from spec/otcp/v1/registry/error-kinds.json. */
export const MCP_ERROR_KINDS = [
  'OPENTUNE_NOT_AVAILABLE',
  'MULTIPLE_INSTANCES',
  'INSTANCE_NOT_FOUND',
  'INSTANCE_UNVERIFIED',
  'CONNECTION_LOST',
  'REQUEST_TIMEOUT',
  'CONFIG_INVALID',
] as const;

/** The error kinds of OTCP v1, in registry order. A unit test keeps this list equal to the registry. */
export const OTCP_ERROR_KINDS = [
  'AUTH_FAILED',
  'PROTOCOL_MISMATCH',
  'SHUTTING_DOWN',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'NOT_READY',
  'ANALYSIS_FAILED',
  'RENDER_FAILED',
  'MODEL_UNAVAILABLE',
  'REVISION_CONFLICT',
  'UNDO_CONFLICT',
  'UNSAVED_CHANGES',
  'ALREADY_EXISTS',
  'BUSY',
  'TIMEOUT',
  'CANCELLED',
  'IO_ERROR',
  'UNSUPPORTED',
  'INTERNAL',
] as const;

/** An OTCP call failed; `data` is the error, from the instance or from this side. */
export class OtcpError extends Error {
  constructor(readonly data: ErrorData) {
    super(data.reason === null ? data.kind : `${data.kind}(${data.reason})`);
    this.name = 'OtcpError';
  }
}

export interface ErrorInit {
  readonly reason?: string | null;
  readonly detail: string;
  readonly retryable?: boolean;
  readonly executed?: boolean | null;
  /** Replaces the default next step of the kind and reason. */
  readonly nextStep?: NextStep;
  /** The protocol majors of the discovery file, for a hello that is refused for its major. */
  readonly protocolMajors?: readonly number[];
}

/** Builds a tool error; the next step and the link default to those of the kind and reason. */
export function toolError(kind: string, init: ErrorInit): ToolError {
  const reason = init.reason ?? null;
  const step = kindStep(kind, reason);
  const majors = init.protocolMajors === undefined ? [] : protocolMajorsOf(init.protocolMajors);
  return {
    kind,
    reason,
    detail: cleanDetail(init.detail),
    retryable: init.retryable ?? step.retryable,
    executed: init.executed === undefined ? false : init.executed,
    nextStep: init.nextStep ?? step.nextStep,
    url: troubleshootingUrl(`error-${step.anchorKind.toLowerCase()}`),
    ...(majors.length === 0 ? {} : { protocolMajors: majors }),
  };
}

/** The tool error for a failed OTCP call. Unknown kinds are handled like INTERNAL (section 2.3). */
export function fromOtcpError(data: ErrorData, nextStep?: NextStep): ToolError {
  return toolError(data.kind, {
    reason: data.reason,
    detail: data.detail,
    retryable: data.retryable,
    executed: data.executed,
    ...(nextStep === undefined ? {} : { nextStep }),
    ...(data.protocolMajors === undefined ? {} : { protocolMajors: data.protocolMajors }),
  });
}

/** Reads `error.data` of an OTCP response defensively: the instance is a separate program. */
export function errorDataFrom(error: unknown): ErrorData {
  const data = (typeof error === 'object' && error !== null ? (error as { data?: unknown }).data : undefined) as
    Record<string, unknown> | undefined;
  const kind = typeof data?.kind === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(data.kind) ? data.kind : 'INTERNAL';
  const reason = typeof data?.reason === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(data.reason) ? data.reason : null;
  return {
    kind,
    reason,
    retryable: data?.retryable === true,
    detail: typeof data?.detail === 'string' ? data.detail : 'the instance sent an error without data',
    executed: typeof data?.executed === 'boolean' ? data.executed : null,
  };
}
