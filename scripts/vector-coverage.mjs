#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// vector-coverage: merges the result files of several OTCP vector runners (the mock, a started
// OpenTune executable, the fork's headless runner) into one table: which runner passes which vector,
// which vectors no runner passes (with every runner's reason for skipping them), and the totals.
//
// Result file (one per runner), JSON:
//   { "runner": "<name>", "commit": "<sha>", "vectors": [ { "id": "<vector id>", "status": "PASS"|"FAIL"|"SKIP", "reason": "<why>" } ] }
// `reason` is optional for PASS. Extra members are ignored, so the summary files of
// `OTCP_CONTRACT_SUMMARY` and `OTCP_CONTRACT_SUMMARY_EXE` can be passed as they are.
//
// Usage:
//   node scripts/vector-coverage.mjs [--vectors <dir>] [--json] <result.json>...
//   --vectors <dir>  the vector directory; default spec/otcp/v1/vectors
//   --json           print the merged result as JSON instead of the table
// Exit codes: 0 every vector passes in at least one runner and none fails; 1 a vector fails, no
// runner passes a vector, or a result names a vector that is not in the directory; 2 usage or
// unreadable input.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_VECTORS_DIR = path.join(HERE, '..', 'spec', 'otcp', 'v1', 'vectors');
const STATUSES = new Set(['PASS', 'FAIL', 'SKIP']);

/** A problem with the input itself (exit code 2). */
export class InputError extends Error {}

/** The ids of every vector file below `dir`, sorted. */
export function loadVectorIds(dir) {
  const ids = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.json')) {
        let value;
        try {
          value = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          throw new InputError(`${file} is not valid JSON`);
        }
        if (typeof value?.id === 'string') ids.push(value.id);
      }
    }
  };
  walk(dir);
  return ids.sort();
}

/** Checks the shape of one result file's content and returns it. */
export function parseResult(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InputError(`${label}: the result is not an object`);
  }
  if (typeof value.runner !== 'string' || value.runner === '') throw new InputError(`${label}: no runner name`);
  if (!Array.isArray(value.vectors)) throw new InputError(`${label}: no vectors array`);
  const rows = new Map();
  for (const row of value.vectors) {
    if (typeof row?.id !== 'string' || !STATUSES.has(row.status)) {
      throw new InputError(`${label}: a vector row needs an id and a status of PASS, FAIL or SKIP`);
    }
    if (rows.has(row.id)) throw new InputError(`${label}: the vector ${row.id} is listed twice`);
    rows.set(row.id, { status: row.status, reason: typeof row.reason === 'string' ? row.reason : '' });
  }
  return { runner: value.runner, commit: typeof value.commit === 'string' ? value.commit : 'unknown', rows };
}

/**
 * Merges parsed results over the ids of the vector directory.
 * @param {string[]} ids every vector id of the specification
 * @param {{runner: string, commit: string, rows: Map<string, {status: string, reason: string}>}[]} results
 */
export function mergeCoverage(ids, results) {
  const names = results.map((r) => r.runner);
  if (new Set(names).size !== names.length) throw new InputError('two result files name the same runner');
  const known = new Set(ids);
  const vectors = ids.map((id) => {
    const perRunner = results.map((r) => ({
      runner: r.runner,
      ...(r.rows.get(id) ?? { status: 'NOT RUN', reason: '' }),
    }));
    return {
      id,
      passedBy: perRunner.filter((r) => r.status === 'PASS').map((r) => r.runner),
      failedIn: perRunner.filter((r) => r.status === 'FAIL').map((r) => ({ runner: r.runner, reason: r.reason })),
      skippedIn: perRunner.filter((r) => r.status === 'SKIP').map((r) => ({ runner: r.runner, reason: r.reason })),
      notRunIn: perRunner.filter((r) => r.status === 'NOT RUN').map((r) => r.runner),
    };
  });
  const unknown = results.flatMap((r) =>
    [...r.rows.keys()].filter((id) => !known.has(id)).map((id) => ({ runner: r.runner, id })),
  );
  const runners = results.map((r) => {
    const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
    for (const row of r.rows.values()) counts[row.status] += 1;
    return { runner: r.runner, commit: r.commit, ...counts, notRun: ids.filter((id) => !r.rows.has(id)).length };
  });
  const uncovered = vectors.filter((v) => v.passedBy.length === 0);
  const failing = vectors.filter((v) => v.failedIn.length > 0);
  return {
    total: ids.length,
    covered: ids.length - uncovered.length,
    uncovered: uncovered.map((v) => v.id),
    failing: failing.map((v) => v.id),
    unknown,
    runners,
    vectors,
    ok: uncovered.length === 0 && failing.length === 0 && unknown.length === 0,
  };
}

const cell = (text) => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ');

/** The merged result as a Markdown report. */
export function formatReport(merged) {
  const lines = [
    '## Runners',
    '',
    '| Runner | Commit | PASS | FAIL | SKIP | Not run |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of merged.runners) {
    lines.push(`| ${cell(r.runner)} | ${cell(r.commit)} | ${r.PASS} | ${r.FAIL} | ${r.SKIP} | ${r.notRun} |`);
  }
  lines.push('', '## Vectors', '', '| Vector | Passes in | Other runners |', '| --- | --- | --- |');
  for (const v of merged.vectors) {
    const others = [
      ...v.failedIn.map((f) => `FAIL in ${f.runner}${f.reason === '' ? '' : `: ${f.reason}`}`),
      ...v.skippedIn.map((s) => `SKIP in ${s.runner}${s.reason === '' ? '' : `: ${s.reason}`}`),
      // The runners that did not list the vector are counted, not named: with many runners the names alone fill the line.
      ...(v.notRunIn.length === 0
        ? []
        : [`not listed by ${v.notRunIn.length} ${v.notRunIn.length === 1 ? 'runner' : 'runners'}`]),
    ];
    lines.push(
      `| ${cell(v.id)} | ${v.passedBy.length === 0 ? '**none**' : cell(v.passedBy.join(', '))} | ${cell(others.join('; '))} |`,
    );
  }
  lines.push('', '## Vectors no runner passes', '');
  if (merged.uncovered.length === 0) lines.push('None.');
  for (const id of merged.uncovered) {
    const v = merged.vectors.find((entry) => entry.id === id);
    const why = [
      ...(v?.failedIn ?? []).map((f) => `${f.runner} FAIL${f.reason === '' ? '' : ` (${f.reason})`}`),
      ...(v?.skippedIn ?? []).map((s) => `${s.runner} SKIP${s.reason === '' ? '' : ` (${s.reason})`}`),
      ...(v?.notRunIn ?? []).map((n) => `${n} not run`),
    ];
    lines.push(`- ${id}: ${why.join('; ')}`);
  }
  if (merged.unknown.length > 0) {
    lines.push('', '## Vector ids that are not in the specification', '');
    for (const u of merged.unknown) lines.push(`- ${u.id} (${u.runner})`);
  }
  lines.push(
    '',
    `Totals: ${merged.total} vectors, ${merged.covered} pass in at least one runner, ${merged.uncovered.length} pass in none, ` +
      `${merged.failing.length} fail somewhere, ${merged.unknown.length} unknown ids.`,
  );
  return `${lines.join('\n')}\n`;
}

/** Runs the command line; returns the exit code. */
export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  let dir = DEFAULT_VECTORS_DIR;
  let json = false;
  const files = [];
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--json') json = true;
      else if (arg === '--vectors') {
        const next = argv[++i];
        if (next === undefined) throw new InputError('--vectors needs a directory');
        dir = next;
      } else if (arg.startsWith('--')) throw new InputError(`unknown option ${arg}`);
      else files.push(arg);
    }
    if (files.length === 0) throw new InputError('give at least one result file');
    const results = files.map((file) => {
      let value;
      try {
        value = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        throw new InputError(`${file} cannot be read as JSON`);
      }
      return parseResult(value, file);
    });
    const merged = mergeCoverage(loadVectorIds(dir), results);
    io.out(json ? `${JSON.stringify(merged, null, 2)}\n` : formatReport(merged));
    return merged.ok ? 0 : 1;
  } catch (error) {
    if (!(error instanceof InputError) && !(error instanceof Error && 'code' in error)) throw error;
    io.err(`vector-coverage: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
