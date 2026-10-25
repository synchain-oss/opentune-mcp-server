// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// A session whose replies a test can change before a scenario checks them, to show that the check which
// notices the deviation turns red (the scenarios of test/e2e take such a session through their hooks).

import type { Json, OtcpSession } from '../../src/otcp/client.js';

/** Changes one OTCP reply before the scenario sees it; returns the changed reply, or undefined to keep it. */
export type SessionDefect = (method: string, result: Json, params: Json) => Json | undefined;

/** Runs before a call is sent to the instance. */
export type BeforeCall = (method: string, params: Json) => void;

/** A session that answers like `session`, with `defect` applied to every reply. */
export function wrapSession(session: OtcpSession, defect: SessionDefect, before?: BeforeCall): OtcpSession {
  const wrapped = {
    get hello() {
      return session.hello;
    },
    get closed() {
      return session.closed;
    },
    async call(method: string, params: Json, timeoutMs: number): Promise<Json> {
      before?.(method, params);
      const result = await session.call(method, params, timeoutMs);
      return defect(method, structuredClone(result), params) ?? result;
    },
    close() {
      session.close();
    },
  };
  return wrapped as unknown as OtcpSession;
}
