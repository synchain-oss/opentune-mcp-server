// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// compatibility.json is the one record of which OpenTune build goes with which version of this server. Three
// things are made from it, and none of them is edited by hand:
//   - the table in docs/COMPATIBILITY.md and the "Which OpenTune build to use" box of README.md and
//     README.zh-CN.md (blocks between BEGIN GENERATED / END GENERATED comments; `npm run compat:update` rewrites
//     them, `npm run compat:check` fails when they differ, and a unit test does the same),
//   - the "Works with OpenTune" section at the top of the release notes (scripts/release-assets.mjs), which
//     fails for a version that has no record,
//   - the runtime check of opentune_get_status and `opentune-mcp doctor` (src/compat/), which bundles the file.
//
// File format (schema 1): { schema: 1, records: [record, ...] }, oldest first, and the record of the next release,
// named "unreleased", last. A record is { server, spec, specReleased?, runtimeCheck?, opentune: [entry, ...] };
// `runtimeCheck: true` says that this version of the server reports the pairing (opentune_get_status and doctor), so
// the notes and the README may say so; the versions made before the check existed leave it out. `server` is a
// version (x.y.z) or "unreleased". An entry names the OpenTune build and whether this server was run against a real
// one:
//   testBuild       { kind, tag, commit?, appVersion?, platforms?, verified, note }
//   upstreamSource  { kind, branch, commit, appVersion?, verified, note }
//   official        { kind, version, tag?, commit?, appVersion?, verified, note }   (tag or commit is required)
// A running build is recognised by its commit (a prefix of at least 7 hexadecimal digits is enough) or by a tag
// that equals its `build.tag` or its `buildTag`; the version alone never identifies a build, because a build of
// the source between two releases reports the version of the next one. `verified: false` means "listed, not yet
// verified against a real build".
//
// Usage: node scripts/compat.mjs update                  rewrites the generated blocks
//        node scripts/compat.mjs check                   exits 1 when a generated block is out of date
//        node scripts/compat.mjs release-section [ver]   prints the release-notes section of a version (default:
//                                                        the version of package.json); exits 1 without a record

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMPATIBILITY_FILE = 'compatibility.json';
export const UNRELEASED = 'unreleased';

const FORK_RELEASES = 'https://github.com/synchain-oss/OpenTune/releases/tag/';
const DOC_BASE = 'https://github.com/synchain-oss/opentune-mcp-server/blob/prod/docs/COMPATIBILITY.md';
export const SECTION_ANCHOR = 'which-opentune-build-goes-with-which-server';

export const PLATFORM_NAMES = {
  'windows-x64': { en: 'Windows x64', zh: 'Windows x64' },
  'macos-arm64': { en: 'macOS Apple silicon', zh: 'macOS Apple 芯片' },
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TEST_TAG = /^synchain-test\/v\d+\.\d+\.\d+-ctl\.\d+$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
// Printable ASCII only, and no pipe: the text goes into Markdown tables that Prettier pads by character count.
const PLAIN = /^[\x20-\x7e]+$/;
const KINDS = ['testBuild', 'official', 'upstreamSource'];
const ENTRY_KEYS = ['kind', 'tag', 'version', 'branch', 'commit', 'appVersion', 'platforms', 'verified', 'note'];
const RECORD_KEYS = ['server', 'spec', 'specReleased', 'runtimeCheck', 'opentune'];

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const plain = (v, max) => typeof v === 'string' && v.length <= max && PLAIN.test(v) && !v.includes('|');

function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function entryProblems(e, where) {
  if (!isObject(e)) return [`${where} is not an object`];
  const problems = [];
  const bad = (message) => problems.push(`${where}: ${message}`);
  for (const key of Object.keys(e)) if (!ENTRY_KEYS.includes(key)) bad(`unknown member ${key}`);
  if (!KINDS.includes(e.kind)) {
    bad(`kind must be one of ${KINDS.join(', ')}`);
    return problems;
  }
  const allowed = {
    testBuild: ['kind', 'tag', 'commit', 'appVersion', 'platforms', 'verified', 'note'],
    upstreamSource: ['kind', 'branch', 'commit', 'appVersion', 'verified', 'note'],
    official: ['kind', 'version', 'tag', 'commit', 'appVersion', 'verified', 'note'],
  }[e.kind];
  for (const key of Object.keys(e))
    if (ENTRY_KEYS.includes(key) && !allowed.includes(key)) bad(`${e.kind} has no ${key}`);
  if (e.kind === 'testBuild' && !(typeof e.tag === 'string' && TEST_TAG.test(e.tag)))
    bad('tag must look like synchain-test/v1.8.0-ctl.2');
  if (e.kind === 'upstreamSource') {
    if (!plain(e.branch, 100) || /[\s`]/.test(e.branch)) bad('branch must be a plain branch name');
    if (e.commit === undefined) bad('commit is required');
  }
  if (e.kind === 'official') {
    if (!(typeof e.version === 'string' && SEMVER.test(e.version))) bad('version must be x.y.z');
    if (e.tag !== undefined && !(plain(e.tag, 100) && !/[\s`]/.test(e.tag))) bad('tag must be a plain tag name');
    if (e.tag === undefined && e.commit === undefined)
      bad('tag or commit is required: the version alone does not identify a build');
  }
  if (e.commit !== undefined && !(typeof e.commit === 'string' && COMMIT.test(e.commit)))
    bad('commit must be 7 to 40 lower-case hexadecimal digits');
  if (e.appVersion !== undefined && !(plain(e.appVersion, 64) && !/[\s`]/.test(e.appVersion)))
    bad('appVersion must be a plain string');
  if (e.platforms !== undefined) {
    const ok =
      Array.isArray(e.platforms) &&
      e.platforms.length > 0 &&
      new Set(e.platforms).size === e.platforms.length &&
      e.platforms.every((p) => Object.hasOwn(PLATFORM_NAMES, p));
    if (!ok) bad(`platforms must be a list of ${Object.keys(PLATFORM_NAMES).join(', ')} without repeats`);
  }
  if (typeof e.verified !== 'boolean') bad('verified must be true or false');
  if (!plain(e.note, 300)) bad('note must be 1 to 300 printable ASCII characters without |');
  return problems;
}

/** All the problems of a parsed compatibility.json; an empty list means it is valid. */
export function validateCompatibility(data) {
  if (!isObject(data)) return ['the file is not a JSON object'];
  const problems = [];
  for (const key of Object.keys(data))
    if (key !== 'schema' && key !== 'records') problems.push(`unknown member ${key}`);
  if (data.schema !== 1) problems.push('schema must be 1');
  if (!Array.isArray(data.records) || data.records.length === 0)
    return [...problems, 'records must be a non-empty list'];
  let previous = null;
  data.records.forEach((record, i) => {
    const where = `records[${String(i)}]`;
    if (!isObject(record)) {
      problems.push(`${where} is not an object`);
      return;
    }
    for (const key of Object.keys(record))
      if (!RECORD_KEYS.includes(key)) problems.push(`${where}: unknown member ${key}`);
    const server = record.server;
    if (!(typeof server === 'string' && (SEMVER.test(server) || server === UNRELEASED))) {
      problems.push(`${where}: server must be x.y.z or "${UNRELEASED}"`);
    } else {
      if (previous === UNRELEASED) problems.push(`${where}: "${UNRELEASED}" must be the last record`);
      if (
        previous !== null &&
        previous !== UNRELEASED &&
        server !== UNRELEASED &&
        compareVersions(previous, server) >= 0
      )
        problems.push(`${where}: server ${server} is not newer than the record before it`);
      if (server === previous) problems.push(`${where}: server ${server} appears twice`);
      previous = server;
    }
    if (!plain(record.spec, 40) || /[\s`]/.test(record.spec))
      problems.push(`${where}: spec must be a plain version string`);
    if (record.specReleased !== undefined && typeof record.specReleased !== 'boolean')
      problems.push(`${where}: specReleased must be true or false`);
    if (record.runtimeCheck !== undefined && typeof record.runtimeCheck !== 'boolean')
      problems.push(`${where}: runtimeCheck must be true or false`);
    if (!Array.isArray(record.opentune) || record.opentune.length === 0) {
      problems.push(`${where}: opentune must be a non-empty list`);
      return;
    }
    const seen = new Set();
    record.opentune.forEach((entry, j) => {
      const here = `${where}.opentune[${String(j)}]`;
      problems.push(...entryProblems(entry, here));
      if (!isObject(entry)) return;
      for (const id of [entry.tag, entry.commit]) {
        if (id === undefined) continue;
        if (seen.has(id)) problems.push(`${here}: ${String(id)} is listed twice in this record`);
        seen.add(id);
      }
    });
  });
  return problems;
}

/** Parses the text of compatibility.json and throws when it is not valid. */
export function parseCompatibility(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${COMPATIBILITY_FILE} is not valid JSON`);
  }
  const problems = validateCompatibility(data);
  if (problems.length > 0) throw new Error(`${COMPATIBILITY_FILE} is not valid:\n- ${problems.join('\n- ')}`);
  return data;
}

export async function loadCompatibility(root = ROOT) {
  return parseCompatibility(await fs.readFile(path.join(root, COMPATIBILITY_FILE), 'utf8'));
}

/** The record of a server version; null when there is none. */
export const recordFor = (data, server) => data.records.find((r) => r.server === server) ?? null;

const short = (commit) => commit.slice(0, 7);
const specText = (record) => `\`${record.spec}\`${record.specReleased === false ? ', not released' : ''}`;

function platformsText(entry, lang) {
  if (!entry.platforms) return '';
  const names = entry.platforms.map((p) => PLATFORM_NAMES[p][lang]);
  return lang === 'zh' ? `(${names.join('、')})` : ` (${names.join(', ')})`;
}

const TEXT = {
  en: {
    testBuild: (e) => `Test build [\`${e.tag}\`](${FORK_RELEASES}${e.tag})${platformsText(e, 'en')}`,
    upstreamSource: (e) =>
      `Upstream OpenTune, branch \`${e.branch}\` at \`${short(e.commit)}\`, built with the control API switched on (CMake option \`OPENTUNE_ENABLE_CONTROL_API\`)`,
    official: (e) => `Official OpenTune \`${e.version}\``,
    verified: 'checked',
    unverified: 'listed, not yet verified against a real build',
  },
  zh: {
    testBuild: (e) => `测试版 [\`${e.tag}\`](${FORK_RELEASES}${e.tag})${platformsText(e, 'zh')}`,
    upstreamSource: (e) =>
      `上游 OpenTune 的 \`${e.branch}\` 分支,提交 \`${short(e.commit)}\`,打开控制接口后构建(CMake 选项 \`OPENTUNE_ENABLE_CONTROL_API\`)`,
    official: (e) => `官方 OpenTune \`${e.version}\``,
    verified: '已验证',
    unverified: '已列出,尚未在真实构建上验证',
  },
};

const item = (entry, lang) => {
  const state = entry.verified ? TEXT[lang].verified : TEXT[lang].unverified;
  return lang === 'zh' ? `- ${TEXT.zh[entry.kind](entry)}:${state}。` : `- ${TEXT.en[entry.kind](entry)}: ${state}.`;
};

/** Pads a table the way Prettier does (columns as wide as their widest cell, counting characters). */
function markdownTable(header, rows) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

const testBuildCell = (e) => `Test build \`${e.tag}\`${platformsText(e, 'en')}`;
const tableBuildCell = (e) => (e.kind === 'testBuild' ? testBuildCell(e) : TEXT.en[e.kind](e));

/** The table of docs/COMPATIBILITY.md: every record, the newest first. */
export function renderTable(data) {
  const rows = [...data.records]
    .reverse()
    .flatMap((record) =>
      record.opentune.map((e) => [
        record.server === UNRELEASED ? 'unreleased (this repository)' : record.server,
        specText(record),
        tableBuildCell(e),
        e.verified ? 'yes' : 'not yet',
        e.note,
      ]),
    );
  return markdownTable(['Server', 'OTCP specification', 'OpenTune build', 'Verified', 'Notes'], rows);
}

const BOX = {
  en: {
    title: 'Which OpenTune build to use.',
    intro: (record) =>
      record.server === UNRELEASED
        ? 'This version of the server (not released yet) is checked with these OpenTune builds:'
        : `OpenTune MCP Server ${record.server} is checked with these OpenTune builds:`,
    outro: (record) =>
      'Any other build is not covered: it may work, but nobody has checked it. An official OpenTune release without the control API does not work.' +
      (record.runtimeCheck === true
        ? ' `opentune_get_status` and `opentune-mcp doctor` tell you which build is running and whether it is listed.'
        : '') +
      ` Details: [Compatibility](docs/COMPATIBILITY.md#${SECTION_ANCHOR}).`,
  },
  zh: {
    title: '该用哪个 OpenTune 构建。',
    intro: (record) =>
      record.server === UNRELEASED
        ? '本版本的服务(尚未发布)用下列 OpenTune 构建检查过:'
        : `OpenTune MCP Server ${record.server} 用下列 OpenTune 构建检查过:`,
    outro: (record) =>
      '其他构建不在覆盖范围内:可能能用,但没有人检查过。没有控制接口的官方 OpenTune 发布版不能用。' +
      (record.runtimeCheck === true
        ? '`opentune_get_status` 与 `opentune-mcp doctor` 会告诉你正在运行的是哪个构建、它是否在清单里。'
        : '') +
      `详见[兼容性说明](docs/COMPATIBILITY.md#${SECTION_ANCHOR})。`,
  },
};

/** The box of the README (`lang` is "en" or "zh"), for the newest record. */
export function renderReadmeBox(data, lang) {
  const record = data.records[data.records.length - 1];
  const t = BOX[lang];
  return [
    `> **${t.title}** ${t.intro(record)}`,
    '>',
    ...record.opentune.map((e) => `> ${item(e, lang)}`),
    '>',
    `> ${t.outro(record)}`,
  ].join('\n');
}

/**
 * The "Works with OpenTune" section of the release notes of `version`, for the notes of that release (English) or for a
 * translation of them. Throws when the version has no record: a release without one must fail.
 */
export function renderReleaseSection(data, version, lang = 'en') {
  const record = recordFor(data, version);
  if (record === null)
    throw new Error(
      `${COMPATIBILITY_FILE} has no record for server version ${version}; add one (docs/RELEASE.md) before releasing`,
    );
  const link = `${DOC_BASE}#${SECTION_ANCHOR}`;
  const forked = record.opentune.some((e) => e.kind === 'testBuild');
  if (lang === 'zh') {
    return [
      '### 适用的 OpenTune',
      '',
      `OpenTune MCP Server ${version}(OTCP 规范 ${specText(record).replace(', not released', ',尚未发布')})用下列 OpenTune 构建检查过:`,
      '',
      ...record.opentune.map((e) => item(e, 'zh')),
      '',
      [
        '其他构建不在覆盖范围内:可能能用,但没有人检查过。没有控制接口的官方 OpenTune 发布版不能与本服务配合使用。',
        ...(forked ? ['这些测试版来自 fork synchain-oss/OpenTune;该 fork 已不再维护,已发布的测试版继续保留。'] : []),
        ...(record.runtimeCheck === true
          ? [
              '`opentune_get_status` 与 `opentune-mcp doctor` 会告诉你正在运行的是哪个构建、它是否在清单里;不在清单里时只给出警告,不会拒绝工作。',
            ]
          : []),
        `详见 [docs/COMPATIBILITY.md](${link})。`,
      ].join(''),
    ].join('\n');
  }
  return [
    '### Works with OpenTune',
    '',
    `OpenTune MCP Server ${version} (OTCP specification ${specText(record)}) was checked with these OpenTune builds:`,
    '',
    ...record.opentune.map((e) => item(e, 'en')),
    '',
    [
      'Any other build is not covered: it may work, but nobody has checked it. An official OpenTune release without the control API does not work with this server.',
      ...(forked
        ? [
            ' The test builds come from the fork synchain-oss/OpenTune, which is no longer maintained; the builds that exist stay available.',
          ]
        : []),
      ...(record.runtimeCheck === true
        ? [
            ' `opentune_get_status` and `opentune-mcp doctor` tell you which build is running and whether it is listed; a build that is not listed gets a warning, never a refusal.',
          ]
        : []),
      ` Details: [docs/COMPATIBILITY.md](${link}).`,
    ].join(''),
  ].join('\n');
}

const markerStart = (name) =>
  `<!-- BEGIN GENERATED compatibility:${name} (from compatibility.json; run npm run compat:update) -->`;
const markerEnd = (name) => `<!-- END GENERATED compatibility:${name} -->`;

/** `text` with the block `name` replaced by `content`; throws when the markers are missing. */
export function replaceBlock(text, name, content) {
  const start = text.indexOf(markerStart(name));
  const end = text.indexOf(markerEnd(name));
  if (start === -1 || end === -1 || end < start)
    throw new Error(`the generated block "${name}" is missing: ${markerStart(name)} ... ${markerEnd(name)}`);
  // Blank lines around the content: Prettier puts them there, and a Markdown block must not run into a comment line.
  return `${text.slice(0, start)}${markerStart(name)}\n\n${content}\n\n${text.slice(end)}`;
}

/** The generated blocks: file, block name, content. */
export function generatedBlocks(data) {
  return [
    { file: 'docs/COMPATIBILITY.md', name: 'table', content: renderTable(data) },
    { file: 'README.md', name: 'box', content: renderReadmeBox(data, 'en') },
    { file: 'README.zh-CN.md', name: 'box', content: renderReadmeBox(data, 'zh') },
  ];
}

/** Files whose generated block is out of date; with `write`, rewrites them. */
export async function syncDocs(root, { write }) {
  const data = await loadCompatibility(root);
  const stale = [];
  for (const { file, name, content } of generatedBlocks(data)) {
    const target = path.join(root, file);
    const text = await fs.readFile(target, 'utf8');
    const next = replaceBlock(text, name, content);
    if (next === text) continue;
    stale.push(file);
    if (write) await fs.writeFile(target, next);
  }
  return stale;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, argument] = process.argv.slice(2);
  try {
    if (command === 'update' || command === 'check') {
      const stale = await syncDocs(ROOT, { write: command === 'update' });
      if (command === 'update')
        process.stdout.write(stale.length === 0 ? 'compat: up to date\n' : `compat: rewrote ${stale.join(', ')}\n`);
      else if (stale.length > 0) {
        process.stderr.write(
          `compat: ${stale.join(', ')} differs from compatibility.json; run npm run compat:update\n`,
        );
        process.exitCode = 1;
      }
    } else if (command === 'release-section') {
      const version =
        argument ?? String(JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version);
      process.stdout.write(`${renderReleaseSection(await loadCompatibility(ROOT), version)}\n`);
    } else {
      process.stderr.write('usage: node scripts/compat.mjs update | check | release-section [version]\n');
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`compat: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
