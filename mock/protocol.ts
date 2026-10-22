// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// JSON-RPC profile of OTCP (spec/otcp/v1/PROTOCOL.md sections 3.3 and 17) from the server's side:
// request ids, the request and notification forms, error objects built from the registries, and
// the fixed responses of Appendix A.

import { encodeLine } from '../src/otcp/framing.js';
import { REASON_RETRYABLE } from './retryable.js';
import type { OtcpSpec } from '../test/support/otcp-spec.js';

export type RequestId = string | number;

export interface Request {
  readonly id: RequestId;
  readonly method: string;
  /** Absent when the request has none, which methods treat as {} (section 3.3 rule 3). */
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface ErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data: {
    readonly kind: string;
    readonly reason?: string;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
    readonly detail: string;
    readonly executed: boolean;
  };
}

export interface ErrorInit {
  readonly kind: string;
  readonly reason?: string;
  readonly detail: string;
  /** Defaults to the reason's retryability (mock/retryable.ts), else the kind's in registry/error-kinds.json. */
  readonly retryable?: boolean;
  /** Defaults to false: the request changed nothing. */
  readonly executed?: boolean;
  /** Hint for retryable errors (section 17.1). */
  readonly retryAfterMs?: number;
}

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A string of 1 to 128 code points, or a number whose binary64 value is an integer from 0 to
 * 2^53-1 (section 3.3 rule 3). JSON.parse has already converted `1.0` and `1e2` to 1 and 100.
 */
export function isValidRequestId(id: unknown): id is RequestId {
  if (typeof id === 'string') {
    // Code points: a surrogate pair counts once, a lone surrogate once as well.
    const codePoints = id.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '_').length;
    return codePoints >= 1 && codePoints <= 128;
  }
  return typeof id === 'number' && Number.isInteger(id) && id >= 0 && id <= Number.MAX_SAFE_INTEGER;
}

/** Ids compare by value: the number 1.0 equals 1, and a number never equals a string. */
export const idKey = (id: RequestId): string => (typeof id === 'number' ? `n:${String(id)}` : `s:${id}`);

export type Classified =
  | { readonly kind: 'batch' }
  | { readonly kind: 'notification' }
  | { readonly kind: 'invalid'; readonly id: RequestId | null; readonly detail: string }
  | { readonly kind: 'request'; readonly request: Request };

const REQUEST_MEMBERS = new Set(['jsonrpc', 'id', 'method', 'params']);

/** Cases 4 to 6 of section 3.3 rule 5, for a value that parsed as JSON. */
export function classify(value: unknown): Classified {
  if (Array.isArray(value)) return { kind: 'batch' };
  if (isPlainObject(value) && !('id' in value) && value.jsonrpc === '2.0' && typeof value.method === 'string') {
    return { kind: 'notification' };
  }
  if (!isPlainObject(value)) return { kind: 'invalid', id: null, detail: 'a request must be a JSON object' };
  const id = isValidRequestId(value.id) ? value.id : null;
  const invalid = (detail: string): Classified => ({ kind: 'invalid', id, detail });
  const extra = Object.keys(value).find((k) => !REQUEST_MEMBERS.has(k));
  if (extra !== undefined) return invalid('a request has only the members jsonrpc, id, method and params');
  if (value.jsonrpc !== '2.0') return invalid('jsonrpc must be "2.0"');
  if (id === null) return invalid('id must be a string of 1 to 128 code points or an integer from 0 to 2^53-1');
  if (typeof value.method !== 'string') return invalid('method must be a string');
  if ('params' in value && !isPlainObject(value.params)) return invalid('params must be an object');
  const params = isPlainObject(value.params) ? { params: value.params } : {};
  return { kind: 'request', request: { id, method: value.method, ...params } };
}

/** data.detail is printable ASCII of at most 1024 characters (section 17.1). */
export function printableDetail(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '?').slice(0, 1024);
}

/** An error object whose code, message and retryability follow the registries (section 17). */
export function makeError(spec: OtcpSpec, init: ErrorInit): ErrorObject {
  const kind = spec.errorKinds.get(init.kind);
  if (kind === undefined) throw new Error(`unregistered error kind ${init.kind}`);
  if (init.reason !== undefined && !spec.reasons.has(`${init.kind}/${init.reason}`)) {
    throw new Error(`reason ${init.reason} is not registered for ${init.kind}`);
  }
  return {
    code: spec.errorCode(init.kind, init.reason),
    message: init.kind,
    data: {
      kind: init.kind,
      ...(init.reason === undefined ? {} : { reason: init.reason }),
      retryable:
        init.retryable ??
        (init.reason === undefined ? undefined : REASON_RETRYABLE.get(`${init.kind}/${init.reason}`)) ??
        kind.retryable,
      ...(init.retryAfterMs === undefined ? {} : { retryAfterMs: init.retryAfterMs }),
      detail: printableDetail(init.detail),
      executed: init.executed ?? false,
    },
  };
}

export const successLine = (id: RequestId, result: unknown): Buffer => encodeLine({ jsonrpc: '2.0', id, result });

export const errorLine = (id: RequestId | null, error: ErrorObject): Buffer =>
  encodeLine({ jsonrpc: '2.0', id, error });

/**
 * The fixed responses of Appendix A, identical for every failure of their kind apart from the id.
 * A number id is written as a plain integer literal because JSON.stringify writes integers so.
 */
export function fixedResponse(kind: 'AUTH_FAILED' | 'PROTOCOL_MISMATCH', id: RequestId): Buffer {
  const auth = kind === 'AUTH_FAILED';
  return encodeLine({
    jsonrpc: '2.0',
    id,
    error: {
      code: auth ? -32001 : -32002,
      message: kind,
      data: {
        kind,
        retryable: false,
        detail: auth ? 'authentication failed' : 'unsupported protocol major version',
        executed: false,
      },
    },
  });
}
