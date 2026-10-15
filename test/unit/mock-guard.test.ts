// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The mock must not look its answers up in the contract vectors (test/support/mock-guard.ts).

import { describe, expect, it } from 'vitest';

import { collectSources, mockSources, stripComments, vectorReferences } from '../support/mock-guard.js';

describe('mock does not read the contract vectors', () => {
  it('has no reference to the vectors in mock/ or in anything it imports', () => {
    const sources = mockSources();
    expect([...sources.keys()]).toEqual(
      expect.arrayContaining(['mock/server.ts', 'mock/model.ts', 'test/support/otcp-spec.ts']),
    );
    expect(vectorReferences(sources)).toEqual([]);
  });

  it('fails when a reference is planted: a path, a loader, or an import that leads to one', () => {
    expect(vectorReferences(new Map([['mock/x.ts', "readdirSync('spec/otcp/v1/vectors/session')"]]))).toHaveLength(1);
    expect(vectorReferences(new Map([['mock/x.ts', 'const all = loadVectors();']]))).toHaveLength(1);
    expect(vectorReferences(new Map([['mock/x.ts', "import { x } from '../test/contract/vectors.js';"]]))).toHaveLength(
      1,
    );
    // A reference reached through an import of a module that does not live in mock/.
    const virtual = new Map([
      ['mock/a.ts', "import { b } from '../test/support/b.js';"],
      ['test/support/b.ts', "export const b = readFileSync('spec/otcp/v1/vectors/job/get-running.json');"],
    ]);
    const sources = collectSources('mock/a.ts', (file) => virtual.get(file));
    expect([...sources.keys()]).toEqual(['mock/a.ts', 'test/support/b.ts']);
    expect(vectorReferences(sources)).toHaveLength(1);
  });

  it('does not count comments as references', () => {
    const text = '// see spec/otcp/v1/vectors/README.md\n/* the vectors */ const ok = 1; // vectors\n';
    expect(stripComments(text).trim()).toBe('const ok = 1;');
    expect(vectorReferences(new Map([['mock/x.ts', text]]))).toEqual([]);
  });
});
