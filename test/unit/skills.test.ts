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

// The top-level `key: value` lines of a frontmatter block. A key may be written in quotes ("allowed-tools": ...), which
// YAML reads as the same key.
function parseFields(skill: string, frontmatter: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of frontmatter.split('\n')) {
    const field = /^(["']?)([A-Za-z][A-Za-z0-9-]*)\1:\s*(.*)$/.exec(line);
    if (field === null) continue;
    const key = field[2] ?? '';
    const value = field[3] ?? '';
    // A folded or literal block scalar would hide a long description from the length check.
    if (/^[>|]/.test(value)) {
      throw new Error(`${skill}: field ${key} uses a YAML block scalar; write a one-line value`);
    }
    fields.set(key, unquote(skill, key, value));
  }
  return fields;
}

function readSkill(name: string): { fields: Map<string, string>; frontmatter: string; body: string; text: string } {
  const text = readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) throw new Error(`${name}: SKILL.md must start with a --- frontmatter block`);
  const frontmatter = match[1] ?? '';
  return { fields: parseFields(name, frontmatter), frontmatter, body: match[2] ?? '', text };
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
// The check is deliberately wider than "has the key": it fails on the name anywhere in the frontmatter, whatever the
// letter case, quoting or indentation ("allowed-tools":, 'allowed-tools':, under metadata, in a flow mapping), because
// no skill has a reason to mention it there.
const mentionsAllowedTools = (frontmatter: string): boolean => /allowed-tools/i.test(frontmatter);

describe.each(SKILL_DIRS)('skill %s pre-approves no tools', (name) => {
  it('declares no allowed-tools', () => {
    const { fields, frontmatter } = readSkill(name);
    const why = `${name}: allowed-tools lets Claude Code run Bash and read or write files without asking the user while this skill is loaded; remove it`;
    expect(fields.has('allowed-tools'), why).toBe(false);
    expect(mentionsAllowedTools(frontmatter), why).toBe(false);
  });
});

describe('the allowed-tools check', () => {
  // Without these the check above could be loosened to the plain key without any test turning red.
  it.each([
    ['a plain key', 'name: x\nallowed-tools: Bash'],
    ['a key in double quotes', 'name: x\n"allowed-tools": Bash'],
    ['a key in single quotes', "name: x\n'allowed-tools': Bash"],
    ['an indented key', 'name: x\nmetadata:\n  allowed-tools: Bash'],
    ['a quoted indented key', 'name: x\nmetadata:\n  "allowed-tools": Bash'],
    ['a key in capitals', 'name: x\nAllowed-Tools: Bash'],
    ['a flow mapping', 'metadata: { allowed-tools: Bash }'],
  ])('sees %s', (_label, frontmatter) => {
    expect(mentionsAllowedTools(frontmatter)).toBe(true);
  });

  it('does not see a skill without it', () => {
    expect(mentionsAllowedTools("name: x\ndescription: 'Use when the user wants a tool.'\nlicense: MIT")).toBe(false);
  });

  it('reads a quoted key as the same field, so a quoted unknown field is not missed either', () => {
    expect([...parseFields('x', '"allowed-tools": Bash\n\'hooks\': x\nname: y').keys()]).toEqual([
      'allowed-tools',
      'hooks',
      'name',
    ]);
  });
});

// The result fields a skill names in backticks (`peakDbfs`, `blockedBy`) have to exist, or the skill tells the agent to
// read something no tool returns, and nothing fails until an agent follows it. A field is defined by the code that makes
// it: the server (src/), or, for a skill that ships a script, that script (its own output and options).
const SRC_DIR = path.resolve(import.meta.dirname, '../../src');
const CODE_FILES = /\.(ts|mjs|js|py|json)$/;
const readCode = (dir: string): string =>
  existsSync(dir)
    ? files(dir)
        .filter((file) => CODE_FILES.test(file))
        .map((file) => readFileSync(file, 'utf8'))
        .join('\n')
    : '';
// A name in backticks that looks like a field: lower-case start, a capital inside, nothing else (no dot, bracket,
// space, underscore or hyphen). The rule is that simple on purpose: it misses a field written as `a.b` or `snake_case`
// rather than flag a word that is not one.
const FIELD_LIKE = /`([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)`/g;
// Words that look like fields and are not results of this server's tools or of a skill's own script:
// - beatInBar: a member of a beat in the output of the beat analyzer (the opentune-beats program, built and released
//   from another repository). beat-grid.mjs passes the grid through and never names the member, so no file here defines it.
const NOT_RESULT_FIELDS = new Set<string>(['beatInBar']);

// Whether the code holds the word as a whole word (the words are letters and digits only, so they need no escaping).
// The limit: it matches against the whole text of src/ (or of the script), so a word in a comment or in a string counts
// as present. The check can only find a name that a skill mentions and the code does not have anywhere; it does not
// prove that the field is in the output. Comments are not cut out first: that would cut a `//` inside a string, and
// would not know the `#` of Python.
const isWord = (word: string, code: string): boolean => new RegExp(String.raw`\b${word}\b`).test(code);

function unknownFields(text: string, code: string): string[] {
  const named = new Set([...text.matchAll(FIELD_LIKE)].map((match) => match[1] ?? ''));
  return [...named].filter((word) => !NOT_RESULT_FIELDS.has(word) && !isWord(word, code)).sort();
}

describe('result fields named in the skills', () => {
  const srcCode = readCode(SRC_DIR);

  it.each(SKILL_DIRS)('skill %s names only fields that exist in the code', (name) => {
    const code = `${srcCode}\n${readCode(path.join(SKILLS_DIR, name, 'scripts'))}`;
    expect(unknownFields(readSkill(name).text, code)).toEqual([]);
  });

  it('finds a field that does not exist, and passes one that does', () => {
    const code = 'return { peakDbfs, clippedSampleCount };';
    expect(unknownFields('Read `peakDbfs` and `clippedSampleCount`.', code)).toEqual([]);
    expect(unknownFields('Read `peakDbfs` and `peakDbFs`, then `peakDbfsMax`.', code)).toEqual([
      'peakDbFs',
      'peakDbfsMax',
    ]);
    // Not field-like: a dotted path, a call, snake_case, a tool name and a plain word are left alone.
    expect(unknownFields('`counts.flagged` `calls[0]` `retune_speed` `opentune_undo` `chromatic`', '')).toEqual([]);
  });

  it('knows the fields the skills most depend on', () => {
    for (const field of ['peakDbfs', 'clippedSampleCount', 'blockedBy', 'onboardingShown']) {
      expect(isWord(field, srcCode), field).toBe(true);
    }
  });
});
