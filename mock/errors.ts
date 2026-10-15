// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// How the mock's method handlers refuse a request: they throw a MockError, and the server turns
// it into an error response (spec/otcp/v1/PROTOCOL.md section 17).

import type { ErrorInit } from './protocol.js';

export class MockError extends Error {
  constructor(readonly init: ErrorInit) {
    super(`${init.kind}${init.reason === undefined ? '' : `(${init.reason})`}: ${init.detail}`);
  }
}

/** An error whose request changed nothing (`executed` false), the usual case: checks come first. */
export const refuse = (kind: string, reason: string | undefined, detail: string, retryAfterMs?: number): MockError =>
  new MockError({
    kind,
    ...(reason === undefined ? {} : { reason }),
    detail,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
