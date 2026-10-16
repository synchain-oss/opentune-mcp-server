// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The skills zip: the instruction-only skills of the plugin, for people who use Claude without
// Claude Code (claude.ai, and Claude Desktop, whose chat ignores the MCP server of a plugin and
// gets the tools from the MCPB package instead). Those skills run where there is no local file
// system, MCP server or Python, so the zip takes a fixed list of skills that consist of
// instructions only, and checks each one first:
// - the SKILL.md frontmatter is valid YAML as a strict parser reads it (a plain value with ": "
//   in it is not), and uses only the fields every platform accepts (name, description, license,
//   compatibility, metadata, allowed-tools); claude.ai rejects unknown ones;
// - name is the directory name, at most 64 characters, lowercase words joined by hyphens, with no
//   reserved word; description is at most 200 characters; neither contains an XML tag;
// - every file is Markdown or plain text: no scripts, no binaries, no symbolic links.
// claude.ai takes one skill per upload, a zip whose top level is the skill's folder, so the
// output holds one such zip per skill. Every zip is built like the MCPB package (scripts/mcpb.mjs
// zipStored): same inputs, same bytes.
//
// Usage: node scripts/skills-zip.mjs [--out <dir>]   writes <dir>/opentune-skills-<version>.zip
//                                                   and its .sha256 (default dist)

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { zipStored } from './mcpb.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILLS_DIR = 'plugins/opentune/skills';
/** The skills that go into the zip, in this order. Skills that need local tools stay out. */
export const UPLOAD_SKILLS = Object.freeze(['tuning-workflow', 'check-results']);
export const FRONTMATTER_FIELDS = Object.freeze([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 200;
export const RESERVED_WORDS = Object.freeze(['claude', 'anthropic']);
export const TEXT_EXTENSIONS = Object.freeze(['.md', '.txt']);
export const DEFAULT_OUT = 'dist';

/** A skill of the fixed list is not in the repository. */
export class SkillMissing extends Error {}

const BLOCK_SCALAR = /^([|>])([+-]?)$/;

/**
 * Whether text can stand unquoted as a YAML plain scalar in a block mapping: no ": " or " #"
 * inside, no ":" at the end, and no indicator character at the start (`-`, `?` and `:` are
 * fine when a non-space follows). Lenient readers accept more, but a strict YAML parser fails on
 * the whole frontmatter, so the uploaded skill would have no name or description at all.
 */
export function isPlainScalar(text) {
  if (/: |:$| #/.test(text)) return false;
  if (/^[-?:](?=\S)/.test(text)) return true;
  return !/^[-?:,[\]{}#&*!|>'"%@`]/.test(text);
}

function unquote(raw, problems, key) {
  if (raw.startsWith('"')) {
    // A double-quoted YAML scalar without YAML-only escapes reads like a JSON string.
    try {
      return String(JSON.parse(raw));
    } catch {
      problems.push(`frontmatter: cannot read the double-quoted value of "${key}"`);
      return null;
    }
  }
  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'")) {
      problems.push(`frontmatter: cannot read the single-quoted value of "${key}"`);
      return null;
    }
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  return raw;
}

/**
 * Reads the YAML frontmatter of a SKILL.md as far as the checks need it: the top-level keys, and
 * the text of each key whose value is a scalar (plain, quoted, folded `>` or literal `|`). Nested
 * values (metadata, lists) are kept as null.
 * @param {string} text
 * @returns {{ keys: string[], values: Map<string, string | null>, problems: string[] }}
 */
export function parseFrontmatter(text) {
  const problems = [];
  const values = new Map();
  const keys = [];
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return { keys, values, problems: ['SKILL.md must start with a "---" frontmatter line'] };
  const end = lines.indexOf('---', 1);
  if (end === -1) return { keys, values, problems: ['SKILL.md frontmatter has no closing "---" line'] };
  /** @type {{ key: string, inline: string, rest: string[] } | undefined} */
  let current;
  const entries = [];
  for (const [i, line] of lines.slice(1, end).entries()) {
    const top = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(line);
    if (top) {
      current = { key: top[1] ?? '', inline: (top[2] ?? '').trim(), rest: [] };
      entries.push(current);
    } else if (line.trim() === '' || line.trimStart().startsWith('#')) {
      current?.rest.push('');
    } else if (/^[ \t]/.test(line) && current) {
      current.rest.push(line);
    } else {
      problems.push(`frontmatter line ${i + 2} is not a "key: value" line`);
    }
  }
  for (const { key, inline, rest } of entries) {
    if (values.has(key)) problems.push(`frontmatter: "${key}" appears twice`);
    keys.push(key);
    const block = BLOCK_SCALAR.exec(inline);
    const body = rest.map((l) => l.trim());
    while (body.length && body.at(-1) === '') body.pop();
    let value = null;
    if (block) {
      value = block[1] === '|' ? body.join('\n') : body.join(' ').replace(/ {2,}/g, ' ').trim();
    } else if (inline !== '') {
      // A plain scalar may continue on more indented lines; they fold into one line.
      value = rest.some((l) => l.trim() !== '')
        ? [inline, ...body].join(' ').replace(/\s+/g, ' ').trim()
        : unquote(inline, problems, key);
      const quoted = inline.startsWith('"') || inline.startsWith("'");
      if (!quoted && value !== null && !isPlainScalar(value))
        problems.push(
          `frontmatter: the value of "${key}" is not valid YAML as written (a plain value cannot contain ": " ` +
            'or " #", end with ":" or start with an indicator character); a strict YAML parser rejects the ' +
            'frontmatter, so put the value in double quotes',
        );
    }
    values.set(key, value);
  }
  return { keys, values, problems };
}

const reserved = (s) => RESERVED_WORDS.filter((w) => s.toLowerCase().includes(w));
const chars = (s) => [...s].length;

/**
 * Checks one skill of the upload list.
 * @param {{ name: string, files: { path: string, data: Buffer }[] }} skill
 * @returns {string[]}
 */
export function checkSkill({ name, files }) {
  const problems = [];
  const at = `${SKILLS_DIR}/${name}`;
  for (const { path: rel, data } of files) {
    const ext = path.posix.extname(rel).toLowerCase();
    if (!TEXT_EXTENSIONS.includes(ext))
      problems.push(`${at}/${rel}: only Markdown and plain text (${TEXT_EXTENSIONS.join(', ')}) can be uploaded`);
    else if (data.includes(0)) problems.push(`${at}/${rel}: binary content`);
    else if (data.subarray(0, 2).toString('latin1') === '#!') problems.push(`${at}/${rel}: a script (starts with #!)`);
  }
  const skillMd = files.find((f) => f.path === 'SKILL.md');
  if (!skillMd) return [...problems, `${at}/SKILL.md is missing`];
  const fm = parseFrontmatter(skillMd.data.toString('utf8'));
  problems.push(...fm.problems.map((p) => `${at}/SKILL.md: ${p}`));
  for (const key of fm.keys) {
    if (!FRONTMATTER_FIELDS.includes(key))
      problems.push(
        `${at}/SKILL.md: frontmatter field "${key}" is not one every platform accepts (${FRONTMATTER_FIELDS.join(', ')})`,
      );
  }
  const skillName = fm.values.get('name');
  if (typeof skillName !== 'string' || skillName === '') {
    problems.push(`${at}/SKILL.md: frontmatter has no name`);
  } else {
    if (skillName !== name) problems.push(`${at}/SKILL.md: name "${skillName}" differs from the directory name`);
    if (chars(skillName) > MAX_NAME) problems.push(`${at}/SKILL.md: name is longer than ${MAX_NAME} characters`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName))
      problems.push(`${at}/SKILL.md: name must be lowercase letters and digits joined by single hyphens`);
    if (reserved(skillName).length) problems.push(`${at}/SKILL.md: name contains a reserved word`);
  }
  const description = fm.values.get('description');
  if (typeof description !== 'string' || description.trim() === '') {
    problems.push(`${at}/SKILL.md: frontmatter has no description`);
  } else if (chars(description) > MAX_DESCRIPTION) {
    problems.push(
      `${at}/SKILL.md: description has ${chars(description)} characters, more than ${MAX_DESCRIPTION} (claude.ai rejects it)`,
    );
  }
  for (const [key, value] of [
    ['name', skillName],
    ['description', description],
  ]) {
    if (typeof value === 'string' && /<[^>]*>/.test(value)) problems.push(`${at}/SKILL.md: ${key} contains an XML tag`);
  }
  return problems;
}

/** The skills of the fixed list that exist in the repository (as directories or anything else). */
export async function presentSkills(root = ROOT, skills = UPLOAD_SKILLS) {
  const present = [];
  for (const name of skills) {
    if (await fs.lstat(path.join(root, SKILLS_DIR, name)).catch(() => null)) present.push(name);
  }
  return present;
}

/** Reads every file of one skill directory, as forward-slash paths relative to it. */
export async function readSkill(root, name) {
  const dir = path.join(root, SKILLS_DIR, name);
  const stat = await fs.lstat(dir).catch(() => null);
  if (stat === null)
    throw new SkillMissing(
      `${SKILLS_DIR}/${name} does not exist; the skills zip takes exactly ${UPLOAD_SKILLS.join(', ')}`,
    );
  const files = [];
  const problems = [];
  const walk = async (abs, prefix) => {
    for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) problems.push(`${SKILLS_DIR}/${name}/${rel}: a symbolic link`);
      else if (entry.isDirectory()) await walk(path.join(abs, entry.name), rel);
      else if (entry.isFile()) files.push({ path: rel, data: await fs.readFile(path.join(abs, entry.name)) });
    }
  };
  if (stat.isSymbolicLink() || !stat.isDirectory()) problems.push(`${SKILLS_DIR}/${name} is not a directory`);
  else await walk(dir, '');
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { name, files, problems };
}

/**
 * Checks the skills of the fixed list and builds the zip in memory: one upload-ready zip per skill
 * (`<skill>.zip`, with the skill's folder at its top level) inside opentune-skills-<version>.zip.
 * Throws SkillMissing when a skill of the list does not exist, and an Error listing every problem
 * when a check fails.
 */
export async function buildSkillsZip(root = ROOT, skills = UPLOAD_SKILLS) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const read = [];
  const missing = [];
  for (const name of skills) {
    try {
      read.push(await readSkill(root, name));
    } catch (error) {
      if (error instanceof SkillMissing) missing.push(name);
      else throw error;
    }
  }
  if (missing.length)
    throw new SkillMissing(
      `missing: ${missing.map((n) => `${SKILLS_DIR}/${n}/`).join(', ')}; the skills zip takes exactly ${skills.join(', ')}`,
    );
  const problems = read.flatMap((s) => [...s.problems, ...checkSkill(s)]);
  if (problems.length) throw new Error(`the skills cannot be uploaded as they are:\n  - ${problems.join('\n  - ')}`);
  const inner = read.map((s) => {
    const bytes = zipStored(s.files.map((f) => ({ name: `${s.name}/${f.path}`, data: f.data })));
    return { name: `${s.name}.zip`, data: bytes, files: s.files.length };
  });
  const bytes = zipStored(inner.map(({ name, data }) => ({ name, data })));
  const version = String(pkg.version);
  return {
    name: `opentune-skills-${version}.zip`,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    version,
    skills: inner.map(({ name, data, files }) => ({
      name,
      files,
      sha256: createHash('sha256').update(data).digest('hex'),
    })),
  };
}

export async function writeSkillsZip(root = ROOT, outDir = path.join(root, DEFAULT_OUT)) {
  const built = await buildSkillsZip(root);
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, built.name);
  await fs.writeFile(file, built.bytes);
  await fs.writeFile(`${file}.sha256`, `${built.sha256}  ${built.name}\n`);
  return { ...built, path: file };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  try {
    if (args.length && (i !== 0 || !args[1] || args.length > 2)) {
      process.stderr.write('usage: node scripts/skills-zip.mjs [--out <dir>]\n');
      process.exitCode = 2;
    } else {
      const written = await writeSkillsZip(ROOT, i === 0 ? path.resolve(args[1] ?? '') : undefined);
      process.stdout.write(`${written.path}\nsha256 ${written.sha256}\n`);
    }
  } catch (error) {
    process.stderr.write(`skills:zip: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
