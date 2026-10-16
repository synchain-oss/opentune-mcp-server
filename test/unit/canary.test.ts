// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The canary's detector must go red when a secret is in the output, in any of the forms that a
// careless implementation prints, and must name the place without printing the value. The secrets
// here are made up at run time; nothing in this file is a real token.

import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { findLeaks, secretForms } from '../support/canary.js';

const secret = () => randomBytes(24).toString('hex');

describe('token canary detector', () => {
  it('is quiet when no secret is in the output', () => {
    const secrets = { token: secret(), serverProof: secret() };
    expect(findLeaks(secrets, [{ source: 'stdout', text: '{"jsonrpc":"2.0","id":1,"result":{}}' }])).toEqual([]);
  });

  it('finds the whole value, the other letter case, and a long piece of it', () => {
    const value = secret();
    const secrets = { token: value };
    for (const text of [`x ${value} y`, value.toUpperCase(), `Bearer ${value.slice(0, 20)}...`, value.slice(-18)]) {
      expect(findLeaks(secrets, [{ source: 'stderr', text }])).toEqual(['the token appears in stderr']);
    }
  });

  it('names the secret and the place but never prints the value', () => {
    const value = secret();
    const leaks = findLeaks({ serverProof: value }, [
      { source: 'stdout', text: 'clean' },
      { source: 'a tool result', text: `{"note":"${value}"}` },
    ]);
    expect(leaks).toEqual(['the serverProof appears in a tool result']);
    expect(leaks.join('')).not.toContain(value);
  });

  it('refuses a secret too short to be searched for', () => {
    expect(() => secretForms('abc')).toThrow(/at least 16/);
  });
});
