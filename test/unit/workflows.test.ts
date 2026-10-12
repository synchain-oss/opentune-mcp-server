// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Invariants of .github/workflows that a reviewer would otherwise have to re-check by eye on
// every change: pinned actions, read-only defaults, credentials not persisted, the aggregate CI
// check listing every job, CI running every local gate, and review-dispatch.yml keeping the exact
// tool boundary of claude-review.yml. The files are read as text (no YAML parser is installed),
// so the helpers below rely on the two-space indentation Prettier keeps.

import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const WORKFLOWS = readdirSync(new URL('../../.github/workflows/', import.meta.url))
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => ({ name, text: read(`.github/workflows/${name}`) }));

const indentOf = (line: string) => /^ */.exec(line)?.[0].length ?? 0;

/** The lines nested under the first line matching `header` (deeper indentation or blank). */
function blockUnder(text: string, header: RegExp): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) throw new Error(`no line matches ${String(header)}`);
  const indent = indentOf(lines[start] ?? '');
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && indentOf(line) <= indent) break;
    block.push(line);
  }
  while (block.length > 0 && block.at(-1)?.trim() === '') block.pop();
  return block;
}

/** Job id -> the job's text, for the jobs under the top-level `jobs:` key. */
function jobsOf(text: string): Map<string, string> {
  const jobs = new Map<string, string>();
  let current: string | undefined;
  for (const line of blockUnder(text, /^jobs:\s*$/)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header?.[1]) {
      current = header[1];
      jobs.set(current, '');
    } else if (current !== undefined) {
      jobs.set(current, `${jobs.get(current) ?? ''}${line}\n`);
    }
  }
  return jobs;
}

describe('every workflow', () => {
  it('exists (sanity check of the file list)', () => {
    expect(WORKFLOWS.map((w) => w.name)).toEqual(
      expect.arrayContaining(['branch-gate.yml', 'ci.yml', 'claude-review.yml', 'pr-agent.yml', 'review-dispatch.yml']),
    );
  });

  it.each(WORKFLOWS)('$name pins every action to a full commit SHA with its version in a comment', ({ text }) => {
    const uses = text.split('\n').filter((line) => /^\s*(?:-\s+)?uses:/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line).toMatch(/^\s*(?:-\s+)?uses: [\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40} # v\d+(?:\.\d+)*$/);
    }
  });

  it.each(WORKFLOWS)('$name defaults to read-only contents permission at the top level', ({ text }) => {
    expect(blockUnder(text, /^permissions:\s*$/)).toEqual(['  contents: read']);
  });

  it.each(WORKFLOWS)('$name never persists the checkout credentials', ({ text }) => {
    const lines = text.split('\n');
    const checkouts = lines.flatMap((line, i) => (line.includes('uses: actions/checkout@') ? [i] : []));
    for (const i of checkouts) {
      const step = blockUnder(lines.slice(i).join('\n'), /uses: actions\/checkout@/);
      expect(step, `checkout at line ${String(i + 1)}`).toContainEqual(
        expect.stringMatching(/^\s+persist-credentials: false$/),
      );
    }
  });
});

describe('ci.yml', () => {
  const text = read('.github/workflows/ci.yml');
  const jobs = jobsOf(text);

  it('aggregates every other job in mcp-gate, which always runs', () => {
    const gate = jobs.get('mcp-gate') ?? '';
    expect(gate).toMatch(/^ {4}name: mcp-gate$/m);
    expect(gate).toMatch(/^ {4}if: always\(\)$/m);
    const needs = /^ {4}needs: \[([^\]]*)\]$/m
      .exec(gate)?.[1]
      ?.split(',')
      .map((s) => s.trim());
    expect(needs?.sort()).toEqual([...jobs.keys()].filter((id) => id !== 'mcp-gate').sort());
    expect(gate).not.toMatch(/^\s+paths:/m);
  });

  // The gate names come from the steps table in scripts/gates.mjs; --only matches substrings,
  // case-insensitively, exactly as gates.mjs does.
  const gatesSource = read('scripts/gates.mjs');
  const table = /const steps = \[\n([\s\S]*?)\n {2}\];/.exec(gatesSource)?.[1] ?? '';
  const gateNames = [...table.matchAll(/\[\s*'([^']+)',/g)].map((m) => m[1] ?? '');
  const onlyLists = new Map(
    [...jobs].map(([id, body]) => [
      id,
      [...body.matchAll(/--only "([^"]+)"/g)].flatMap((m) => (m[1] ?? '').split(',').map((s) => s.trim())),
    ]),
  );
  const matches = (token: string, name: string) => name.toLowerCase().includes(token.toLowerCase());

  it('reads the gate names from scripts/gates.mjs', () => {
    expect(gateNames.length).toBeGreaterThan(20);
    expect(gateNames).toContain('reuse lint');
  });

  it('names only existing gates in --only', () => {
    for (const [id, tokens] of onlyLists) {
      for (const token of tokens) {
        expect(
          gateNames.some((name) => matches(token, name)),
          `${id}: --only "${token}"`,
        ).toBe(true);
      }
    }
  });

  it('runs every local gate somewhere in the full tier', () => {
    const fullTier = [...onlyLists].filter(([id]) => id !== 'light').flatMap(([, tokens]) => tokens);
    const missing = gateNames.filter((name) => !fullTier.some((token) => matches(token, name)));
    expect(missing).toEqual([]);
  });
});

describe('review-dispatch.yml keeps the tool boundary of claude-review.yml', () => {
  // The only intended difference: review-dispatch runs on issue_comment, where the PR number is
  // the issue number.
  const source = read('.github/workflows/claude-review.yml');
  const copy = read('.github/workflows/review-dispatch.yml').replaceAll(
    'github.event.issue.number',
    'github.event.pull_request.number',
  );

  it.each([
    ['the prompt', /^\s+prompt: \|$/],
    ['claude_args', /^\s+claude_args: \|$/],
    ['the step that prepares the PR context', /^\s+- name: Prepare PR context for the reviewer$/],
  ])('%s is identical', (_label, header) => {
    const original = blockUnder(source, header);
    expect(original.length).toBeGreaterThan(3);
    expect(blockUnder(copy, header)).toEqual(original);
  });

  it('pins the same action version', () => {
    const pin = (text: string) => /uses: (anthropics\/claude-code-action@\S+)/.exec(text)?.[1];
    expect(pin(copy)).toBeDefined();
    expect(pin(copy)).toBe(pin(source));
  });
});
