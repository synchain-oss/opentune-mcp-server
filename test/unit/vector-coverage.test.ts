// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// scripts/vector-coverage.mjs: the merge of several runners' result files over the vector directory.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_VECTORS_DIR,
  InputError,
  formatReport,
  loadVectorIds,
  main,
  mergeCoverage,
  parseResult,
} from '../../scripts/vector-coverage.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ot-coverage-'));
  dirs.push(dir);
  return dir;
};

const result = (runner: string, rows: [string, string, string?][], commit = 'abc123') =>
  parseResult(
    { runner, commit, vectors: rows.map(([id, status, reason]) => ({ id, status, ...(reason ? { reason } : {}) })) },
    runner,
  );

const IDS = ['a/one', 'a/two', 'b/three', 'b/four'];

describe('mergeCoverage', () => {
  it('counts a vector as covered when any runner passes it, whatever the others say', () => {
    const merged = mergeCoverage(IDS, [
      result('mock', [
        ['a/one', 'PASS'],
        ['a/two', 'SKIP', 'mock lacks it'],
        ['b/three', 'PASS'],
        ['b/four', 'SKIP', 'needs a device'],
      ]),
      result('exe', [
        ['a/one', 'SKIP', 'no given'],
        ['a/two', 'PASS'],
        ['b/three', 'SKIP', 'exact content'],
        ['b/four', 'SKIP', 'needs a device'],
      ]),
    ]);
    expect(merged.vectors.map((v) => [v.id, v.passedBy])).toEqual([
      ['a/one', ['mock']],
      ['a/two', ['exe']],
      ['b/three', ['mock']],
      ['b/four', []],
    ]);
    expect(merged.uncovered).toEqual(['b/four']);
    expect(merged.covered).toBe(3);
    expect(merged.ok).toBe(false);
    expect(merged.runners.map((r) => [r.runner, r.PASS, r.SKIP, r.FAIL])).toEqual([
      ['mock', 2, 2, 0],
      ['exe', 1, 3, 0],
    ]);
  });

  it('lists every runner skip reason of an uncovered vector', () => {
    const merged = mergeCoverage(IDS, [
      result(
        'mock',
        IDS.map((id) => [id, 'PASS'] as [string, string]),
      ),
      result('exe', [['a/one', 'SKIP', 'exe reason']]),
      result('headless', [['a/one', 'SKIP', 'headless reason']]),
    ]);
    expect(merged.ok).toBe(true);
    const lone = mergeCoverage(['x/y'], [result('exe', [['x/y', 'SKIP', 'exe reason']]), result('fork', [])]);
    const report = formatReport(lone);
    expect(report).toContain('- x/y: exe SKIP (exe reason); fork not run');
    expect(report).toContain('Totals: 1 vectors, 0 pass in at least one runner, 1 pass in none');
  });

  it('is not ok when a vector fails in any runner, even if another runner passes it', () => {
    const merged = mergeCoverage(
      ['a/one'],
      [result('mock', [['a/one', 'PASS']]), result('exe', [['a/one', 'FAIL', 'wrong answer']])],
    );
    expect(merged.uncovered).toEqual([]);
    expect(merged.failing).toEqual(['a/one']);
    expect(merged.ok).toBe(false);
    expect(formatReport(merged)).toContain('FAIL in exe: wrong answer');
  });

  it('reports result ids that the specification does not have, and is not ok then', () => {
    const merged = mergeCoverage(
      ['a/one'],
      [
        result('mock', [
          ['a/one', 'PASS'],
          ['gone/old', 'PASS'],
        ]),
      ],
    );
    expect(merged.unknown).toEqual([{ runner: 'mock', id: 'gone/old' }]);
    expect(merged.ok).toBe(false);
    expect(formatReport(merged)).toContain('gone/old (mock)');
  });

  it('shows a vector that a runner did not list as not run', () => {
    const merged = mergeCoverage(
      ['a/one', 'a/two'],
      [result('mock', [['a/one', 'PASS']]), result('exe', [['a/two', 'PASS']])],
    );
    expect(merged.runners.map((r) => r.notRun)).toEqual([1, 1]);
    expect(merged.vectors[0]?.notRunIn).toEqual(['exe']);
    expect(merged.ok).toBe(true);
  });

  it('refuses two files of one runner', () => {
    expect(() => mergeCoverage(['a/one'], [result('exe', []), result('exe', [])])).toThrow(InputError);
  });
});

describe('parseResult', () => {
  it.each([
    [null, 'not an object'],
    [{ vectors: [] }, 'no runner name'],
    [{ runner: 'x' }, 'no vectors array'],
    [{ runner: 'x', vectors: [{ id: 'a', status: 'MAYBE' }] }, 'PASS, FAIL or SKIP'],
    [
      {
        runner: 'x',
        vectors: [
          { id: 'a', status: 'PASS' },
          { id: 'a', status: 'PASS' },
        ],
      },
      'listed twice',
    ],
  ])('refuses %j', (value, message) => {
    expect(() => parseResult(value, 'file')).toThrow(message);
  });

  it('reads a summary file of the contract run as it is, ignoring its other members', () => {
    const parsed = parseResult(
      { runner: 'exe', commit: 'c1', vectors: [{ id: 'a', status: 'SKIP', reason: 'r' }], total: 1, pass: 0 },
      'summary',
    );
    expect(parsed.rows.get('a')).toEqual({ status: 'SKIP', reason: 'r' });
    expect(parsed.commit).toBe('c1');
  });
});

describe('the command line', () => {
  const run = (argv: string[]) => {
    let out = '';
    let err = '';
    const code = main(argv, {
      out: (s) => (out += s),
      err: (s) => (err += s),
    });
    return { code, out, err };
  };

  const write = (dir: string, name: string, value: unknown): string => {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };

  const vectorsDir = (): string => {
    const dir = scratch();
    mkdirSync(path.join(dir, 'a'));
    writeFileSync(path.join(dir, 'a', 'one.json'), JSON.stringify({ id: 'a/one' }));
    writeFileSync(path.join(dir, 'a', 'two.json'), JSON.stringify({ id: 'a/two' }));
    writeFileSync(path.join(dir, 'README.md'), 'not a vector');
    return dir;
  };

  it('reads the ids from the vector directory', () => {
    expect(loadVectorIds(vectorsDir())).toEqual(['a/one', 'a/two']);
    expect(loadVectorIds(DEFAULT_VECTORS_DIR).length).toBeGreaterThan(200);
  });

  it('exits 0 when every vector passes somewhere', () => {
    const dir = scratch();
    const mock = write(dir, 'mock.json', { runner: 'mock', vectors: [{ id: 'a/one', status: 'PASS' }] });
    const exe = write(dir, 'exe.json', { runner: 'exe', commit: 'c', vectors: [{ id: 'a/two', status: 'PASS' }] });
    const { code, out } = run(['--vectors', vectorsDir(), mock, exe]);
    expect(code).toBe(0);
    expect(out).toContain('Totals: 2 vectors, 2 pass in at least one runner, 0 pass in none');
  });

  it('exits 1 for a vector no runner passes, and prints the reasons', () => {
    const dir = scratch();
    const mock = write(dir, 'mock.json', {
      runner: 'mock',
      vectors: [
        { id: 'a/one', status: 'PASS' },
        { id: 'a/two', status: 'SKIP', reason: 'why not' },
      ],
    });
    const { code, out } = run(['--vectors', vectorsDir(), mock]);
    expect(code).toBe(1);
    expect(out).toContain('- a/two: mock SKIP (why not)');
  });

  it('exits 1 for a failing vector and prints JSON on request', () => {
    const dir = scratch();
    const mock = write(dir, 'mock.json', {
      runner: 'mock',
      vectors: [
        { id: 'a/one', status: 'FAIL', reason: 'bad' },
        { id: 'a/two', status: 'PASS' },
      ],
    });
    const { code, out } = run(['--json', '--vectors', vectorsDir(), mock]);
    expect(code).toBe(1);
    expect((JSON.parse(out) as { failing: string[] }).failing).toEqual(['a/one']);
  });

  it('exits 2 for a missing file, a bad option and no input', () => {
    expect(run(['--vectors', vectorsDir(), path.join(scratch(), 'none.json')]).code).toBe(2);
    expect(run(['--nope']).code).toBe(2);
    expect(run([]).code).toBe(2);
  });
});
