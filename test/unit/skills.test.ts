// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The companion skills are plain instructions: valid frontmatter, only real tool names, no scripts.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TOOLS } from '../../src/tools/index.js';

const SKILLS_DIR = path.resolve(import.meta.dirname, '../../plugins/opentune/skills');
const SKILLS = ['tuning-workflow', 'check-results'] as const;
const ALLOWED_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
// Delete this exception once opentune_estimate_key is registered.
const NOT_YET_REGISTERED = new Set(['opentune_estimate_key']);
const SCRIPT_EXTENSIONS = /\.(sh|bash|ps1|bat|cmd|py|js|mjs|cjs|ts|rb|pl)$/i;

function readSkill(name: string): { fields: Map<string, string>; body: string; text: string } {
  const text = readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) throw new Error(`${name}: SKILL.md must start with a --- frontmatter block`);
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split('\n')) {
    const field = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (field !== null) fields.set(field[1] ?? '', field[2] ?? '');
  }
  return { fields, body: match[2] ?? '', text };
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

describe.each(SKILLS)('skill %s', (name) => {
  it('exists and starts with frontmatter', () => {
    expect(existsSync(path.join(SKILLS_DIR, name, 'SKILL.md'))).toBe(true);
    expect(readSkill(name).text.startsWith('---\n')).toBe(true);
  });

  it('uses only allowed frontmatter fields, and the name matches the directory', () => {
    const { fields } = readSkill(name);
    for (const key of fields.keys()) expect(ALLOWED_FIELDS.has(key), `field ${key}`).toBe(true);
    expect(fields.get('name')).toBe(name);
  });

  it('has a description of at most 200 characters without vendor names', () => {
    const description = readSkill(name).fields.get('description') ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(200);
    expect(/claude|anthropic/i.test(readSkill(name).text)).toBe(false);
  });

  it('is at most 250 lines', () => {
    expect(readSkill(name).text.split('\n').length).toBeLessThanOrEqual(250);
  });

  it('mentions only registered tools', () => {
    const registered = new Set(TOOLS.map((t) => t.name));
    const used = new Set(readSkill(name).text.match(/opentune_[a-z0-9_]+/g) ?? []);
    expect(used.size).toBeGreaterThan(0);
    for (const tool of used) {
      expect(registered.has(tool) || NOT_YET_REGISTERED.has(tool), `unknown tool ${tool}`).toBe(true);
    }
  });
});

describe('skill folders', () => {
  it('contain no script files', () => {
    for (const name of SKILLS) {
      for (const file of files(path.join(SKILLS_DIR, name))) {
        expect(SCRIPT_EXTENSIONS.test(file), file).toBe(false);
      }
    }
  });
});
