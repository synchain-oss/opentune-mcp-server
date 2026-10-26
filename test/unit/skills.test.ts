// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The companion skills are plain instructions: valid frontmatter, only real tool names, no scripts.
// Every skill folder is checked; only the pure-instruction skills (PURE_SKILLS) are held to "no scripts".

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TOOLS } from '../../src/tools/index.js';

const SKILLS_DIR = path.resolve(import.meta.dirname, '../../plugins/opentune/skills');
const SKILL_DIRS = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
// Skills that are instructions only. A skill that ships scripts (such as lyrics-timeline) is not listed here.
const PURE_SKILLS = ['tuning-workflow', 'check-results'];
const ALLOWED_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const SCRIPT_EXTENSIONS = /\.(sh|bash|ps1|bat|cmd|py|js|mjs|cjs|ts|rb|pl)$/i;

// A quoted value is read without its quotes (\" and \\ are the escapes of a double-quoted value, '' the escape of a
// single-quoted one), so the length check counts the text.
function unquote(skill: string, key: string, value: string): string {
  const quote = value.charAt(0);
  if (quote !== '"' && quote !== "'") return value;
  if (value.length < 2 || !value.endsWith(quote))
    throw new Error(`${skill}: field ${key} has an unterminated value in quotes`);
  const inner = value.slice(1, -1);
  return quote === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner.replaceAll("''", "'");
}

function readSkill(name: string): { fields: Map<string, string>; body: string; text: string } {
  const text = readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) throw new Error(`${name}: SKILL.md must start with a --- frontmatter block`);
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split('\n')) {
    const field = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (field === null) continue;
    const value = field[2] ?? '';
    // A folded or literal block scalar would hide a long description from the length check.
    if (/^[>|]/.test(value)) {
      throw new Error(`${name}: field ${field[1] ?? ''} uses a YAML block scalar; write a one-line value`);
    }
    fields.set(field[1] ?? '', unquote(name, field[1] ?? '', value));
  }
  return { fields, body: match[2] ?? '', text };
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

describe.each(SKILL_DIRS)('skill %s', (name) => {
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
    expect(/claude|anthropic/i.test(description)).toBe(false);
    // The whole text of a pure-instruction skill (which is also uploaded to Claude Desktop) is vendor-neutral. A
    // skill that runs scripts in the plugin has to name the plugin's own variables (CLAUDE_SKILL_DIR and so on).
    if (PURE_SKILLS.includes(name)) expect(/claude|anthropic/i.test(readSkill(name).text)).toBe(false);
  });

  it('is at most 250 lines', () => {
    expect(readSkill(name).text.split('\n').length).toBeLessThanOrEqual(250);
  });

  it('mentions only registered tools', () => {
    const registered = new Set(TOOLS.map((t) => t.name));
    const used = new Set(readSkill(name).text.match(/opentune_[a-z0-9_]+/g) ?? []);
    expect(used.size).toBeGreaterThan(0);
    for (const tool of used) {
      expect(registered.has(tool), `unknown tool ${tool}`).toBe(true);
    }
  });
});

describe('skill folders', () => {
  it('contain no script files', () => {
    for (const name of PURE_SKILLS) {
      for (const file of files(path.join(SKILLS_DIR, name))) {
        expect(SCRIPT_EXTENSIONS.test(file), file).toBe(false);
      }
    }
  });
});

// allowed-tools pre-approves the listed tools (for example Bash, Read and Write) for as long as the skill is loaded, so
// Claude Code stops asking the user before those run. No plugin skill may declare it. The name stays in ALLOWED_FIELDS
// above because the skills zip tool (scripts/skills-zip.mjs) still recognises the field; this check is what forbids it.
describe.each(SKILL_DIRS)('skill %s pre-approves no tools', (name) => {
  it('declares no allowed-tools', () => {
    expect(
      readSkill(name).fields.has('allowed-tools'),
      `${name}: allowed-tools lets Claude Code run Bash and read or write files without asking the user while this skill is loaded; remove the line`,
    ).toBe(false);
  });
});
