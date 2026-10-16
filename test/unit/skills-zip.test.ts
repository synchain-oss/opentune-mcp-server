// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The skills zip: the frontmatter reader, the checks that keep the uploaded skills portable and
// free of scripts, and the deterministic zip of upload-ready zips. Skills here are fakes in a
// temporary tree; the real ones are checked by the "skills zip" gate.

import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_DESCRIPTION,
  MAX_NAME,
  SkillMissing,
  UPLOAD_SKILLS,
  buildSkillsZip,
  checkSkill,
  isPlainScalar,
  parseFrontmatter,
  presentSkills,
  writeSkillsZip,
} from '../../scripts/skills-zip.mjs';
import { goodSkill, pluginTree, skillMd, type Files, type PluginTree } from '../support/plugin-tree.js';
import { readZip } from '../support/zip.js';

const asFiles = (files: Files) =>
  Object.entries(files).map(([p, data]) => ({ path: p, data: Buffer.isBuffer(data) ? data : Buffer.from(data) }));

describe('parseFrontmatter', () => {
  it('reads plain, quoted, folded and literal scalars, and keeps nested values as null', () => {
    const fm = parseFrontmatter(
      [
        '---',
        'name: tuning-workflow',
        "description: 'It''s for tuning'",
        'license: "MIT"',
        'compatibility: >',
        '  Works with the',
        '  OpenTune MCP tools.',
        'allowed-tools: |',
        '  Read',
        '  Grep',
        'metadata:',
        '  author: Synchain',
        '---',
        'body',
      ].join('\n'),
    );
    expect(fm.problems).toEqual([]);
    expect(fm.keys).toEqual(['name', 'description', 'license', 'compatibility', 'allowed-tools', 'metadata']);
    expect(Object.fromEntries(fm.values)).toEqual({
      name: 'tuning-workflow',
      description: "It's for tuning",
      license: 'MIT',
      compatibility: 'Works with the OpenTune MCP tools.',
      'allowed-tools': 'Read\nGrep',
      metadata: null,
    });
  });

  it('folds a plain scalar that continues on indented lines', () => {
    const fm = parseFrontmatter('---\ndescription: Use when\n  the user asks.\n---\n');
    expect(fm.values.get('description')).toBe('Use when the user asks.');
  });

  it('accepts a quoted value that a plain one could not hold', () => {
    const fm = parseFrontmatter('---\ndescription: "Use when: the user asks # now"\n---\n');
    expect(fm.problems).toEqual([]);
    expect(fm.values.get('description')).toBe('Use when: the user asks # now');
  });

  it.each([
    ['a colon and a space', 'Use the opentune_* tools: import, export'],
    ['a colon on a continuation line', 'Use the tools\n  for this: and that'],
    ['a comment marker', 'Use it # for tuning'],
    ['a trailing colon', 'Steps:'],
    ['a flow sequence', '[a, b]'],
    ['an alias', '*ref'],
  ])('reports a plain value with %s as invalid YAML', (_label, value) => {
    expect(parseFrontmatter(`---\nname: x\ndescription: ${value}\n---\n`).problems.join('\n')).toContain(
      'the value of "description" is not valid YAML as written',
    );
  });

  it.each([
    ['a double-quoted value', '"Use when\n  the user asks."'],
    ['a single-quoted value', "'Use when\n  the user asks.'"],
  ])('rejects %s that continues on the next line, and says to write it on one line', (_label, value) => {
    const problems = parseFrontmatter(`---\ndescription: ${value}\n---\n`).problems.join('\n');
    expect(problems).toContain('the quoted value of "description" continues on the next line');
    expect(problems).toContain('write it on one line');
  });

  it('still accepts a quoted value on one line followed by another key', () => {
    expect(parseFrontmatter('---\ndescription: "Use when: a"\nlicense: MIT\n---\n').problems).toEqual([]);
  });

  it.each([
    ['Use when the user asks, then check.', true],
    ['x #y', false],
    ['x\t#y', false],
    ['x#y', true],
    ['-x and ?y', true],
    ['https://example.com/a', true],
    ['a:b', true],
    ['- item', false],
    ['@x', false],
    ['x: y', false],
  ])('isPlainScalar(%j) is %s', (text, plain) => {
    expect(isPlainScalar(text)).toBe(plain);
  });

  it.each([
    ['no opening fence', 'name: x\n', 'must start with'],
    ['no closing fence', '---\nname: x\n', 'no closing'],
    ['a line that is not a key', '---\nname: x\n- item\n---\n', 'not a "key: value" line'],
    ['a key twice', '---\nname: x\nname: y\n---\n', 'appears twice'],
    ['a broken double-quoted value', '---\nname: "x\n---\n', 'double-quoted'],
    ['a broken single-quoted value', "---\nname: 'x\n---\n", 'single-quoted'],
  ])('reports %s', (_label, text, message) => {
    expect(parseFrontmatter(text).problems.join('\n')).toContain(message);
  });
});

describe('checkSkill', () => {
  const check = (files: Files, name = 'tuning-workflow') => checkSkill({ name, files: asFiles(files) }).join('\n');

  it('accepts an instruction-only skill', () => {
    expect(check(goodSkill('tuning-workflow'))).toBe('');
  });

  it('accepts a name of exactly 64 and a description of exactly 200 characters', () => {
    const name = `${'ab-'.repeat((MAX_NAME - 1) / 3)}a`;
    expect(name).toHaveLength(MAX_NAME);
    const files = { 'SKILL.md': skillMd(`name: ${name}`, `description: ${'d'.repeat(MAX_DESCRIPTION)}`) };
    expect(check(files, name)).toBe('');
  });

  it.each([
    ['a field other platforms reject', skillMd('name: tuning-workflow', 'description: d', 'model: x'), '"model"'],
    ['a name that is not the directory', skillMd('name: tuning', 'description: d'), 'differs from the directory'],
    ['no name', skillMd('description: d'), 'has no name'],
    ['an uppercase name', skillMd('name: Tuning-Workflow', 'description: d'), 'lowercase'],
    ['no description', skillMd('name: tuning-workflow'), 'has no description'],
    [
      'a description of 201 characters',
      skillMd('name: tuning-workflow', `description: ${'d'.repeat(MAX_DESCRIPTION + 1)}`),
      'more than 200',
    ],
    ['an XML tag', skillMd('name: tuning-workflow', 'description: Use <b>this</b>'), 'XML tag'],
  ])('rejects %s', (_label, md, message) => {
    expect(check({ 'SKILL.md': md })).toContain(message);
  });

  it('rejects a name longer than 64 characters and a reserved word', () => {
    const long = 'a'.repeat(MAX_NAME + 1);
    expect(check({ 'SKILL.md': skillMd(`name: ${long}`, 'description: d') }, long)).toContain('longer than 64');
    expect(check({ 'SKILL.md': skillMd('name: claude-tuning', 'description: d') }, 'claude-tuning')).toContain(
      'reserved word',
    );
  });

  it.each([
    ['a Python script', 'scripts/align.py', 'print(1)\n', 'only Markdown and plain text'],
    ['a shell script', 'run.sh', 'echo\n', 'only Markdown and plain text'],
    ['a binary', 'model.bin', Buffer.from([0, 1, 2]), 'only Markdown and plain text'],
    ['binary content behind a text extension', 'notes.md', Buffer.from([0x23, 0, 0x41]), 'binary content'],
    ['a script behind a text extension', 'run.txt', '#!/bin/sh\necho\n', 'a script'],
  ])('rejects %s', (_label, rel, data, message) => {
    expect(check({ ...goodSkill('tuning-workflow'), [rel]: data })).toContain(message);
  });

  it('requires SKILL.md', () => {
    expect(check({ 'README.md': '# x\n' })).toContain('SKILL.md is missing');
  });
});

describe('the skills zip', () => {
  let tree: PluginTree | undefined;
  afterEach(async () => {
    await tree?.remove();
    tree = undefined;
  });
  const both = () => Object.fromEntries(UPLOAD_SKILLS.map((name) => [name, goodSkill(name)]));

  it('takes exactly the fixed list', () => {
    expect(UPLOAD_SKILLS).toEqual(['tuning-workflow', 'check-results']);
  });

  it('holds one upload-ready zip per skill, with the skill folder at its top, the same bytes every time', async () => {
    tree = await pluginTree({
      version: '2.0.0',
      skills: { ...both(), 'lyrics-timeline': goodSkill('lyrics-timeline') },
    });
    const a = await buildSkillsZip(tree.root);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = await buildSkillsZip(tree.root);
    expect(b.bytes.equals(a.bytes)).toBe(true);
    expect(a.name).toBe('opentune-skills-2.0.0.zip');
    const outer = readZip(a.bytes);
    expect(outer.map((e) => e.name)).toEqual(['check-results.zip', 'tuning-workflow.zip']);
    const inner = readZip(outer.find((e) => e.name === 'tuning-workflow.zip')?.data ?? Buffer.alloc(0));
    expect(inner.map((e) => e.name)).toEqual(['tuning-workflow/SKILL.md', 'tuning-workflow/reference/notes.md']);
    expect(a.skills.map((s) => s.name)).toEqual(['tuning-workflow.zip', 'check-results.zip']);
  });

  it('writes the zip and its sha256 file', async () => {
    tree = await pluginTree({ skills: both() });
    const out = path.join(tree.root, 'out');
    const written = await writeSkillsZip(tree.root, out);
    expect(await fs.readFile(path.join(out, 'opentune-skills-1.2.3.zip'))).toEqual(written.bytes);
    expect(await fs.readFile(path.join(out, 'opentune-skills-1.2.3.zip.sha256'), 'utf8')).toBe(
      `${written.sha256}  opentune-skills-1.2.3.zip\n`,
    );
  });

  it('names a missing skill clearly, and lists every problem of the others', async () => {
    tree = await pluginTree({ skills: { 'tuning-workflow': goodSkill('tuning-workflow') } });
    expect(await presentSkills(tree.root)).toEqual(['tuning-workflow']);
    await expect(buildSkillsZip(tree.root)).rejects.toThrow(SkillMissing);
    await expect(buildSkillsZip(tree.root)).rejects.toThrow('missing: plugins/opentune/skills/check-results/;');
    await tree.write('plugins/opentune/skills/check-results/SKILL.md', skillMd('name: check-results'));
    await tree.write('plugins/opentune/skills/check-results/tool.py', 'x');
    await expect(buildSkillsZip(tree.root)).rejects.toThrow(/tool\.py: only Markdown[\s\S]*has no description/);
  });

  it('refuses a symbolic link inside a skill', async (ctx) => {
    tree = await pluginTree({ skills: both() });
    try {
      await fs.symlink(
        path.join(tree.root, 'LICENSE'),
        path.join(tree.root, 'plugins/opentune/skills/check-results/linked.md'),
      );
    } catch {
      ctx.skip(); // creating links needs a privilege on Windows
    }
    await expect(buildSkillsZip(tree.root)).rejects.toThrow('a symbolic link');
  });
});
