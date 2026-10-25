// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The method closure for the content.* methods of the spec: every one is declared by some tool, or is in a
// table of methods that no tool sends, with the reason.

import { describe, expect, it } from 'vitest';

import { TOOLS } from '../../src/tools/index.js';
import { otcpSpec } from '../support/otcp-spec.js';

describe('coverage of the content methods', () => {
  it('has a tool for every content.* method, and a reason for the others', () => {
    const exposed = new Set(TOOLS.flatMap((t) => t.otcpMethods));
    const NOT_EXPOSED: Readonly<Record<string, string>> = {
      'content.analyzeReference':
        'opentune_autotune_range in reference mode starts the analysis itself: content.autoTune in mode reference ' +
        'starts a referenceAnalysis job too (PROTOCOL.md, section 12.1) and waits for the alignment data of both ' +
        'clips (section 12.6), so no tool needs to start the analysis on its own.',
    };
    const methods = [...otcpSpec().methods.keys()].filter((m) => m.startsWith('content.'));
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) expect(exposed.has(method) || method in NOT_EXPOSED, method).toBe(true);
    // A method in the table is one that no tool sends, and the table gives a reason for each.
    expect(Object.keys(NOT_EXPOSED).every((m) => !exposed.has(m))).toBe(true);
    expect(Object.keys(NOT_EXPOSED).every((m) => methods.includes(m))).toBe(true);
    expect(Object.values(NOT_EXPOSED).every((reason) => reason.length > 40)).toBe(true);
  });
});
