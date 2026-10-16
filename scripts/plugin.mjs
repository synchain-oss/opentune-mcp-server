// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Claude Code plugin packaging. plugins/opentune/ in the repository holds the plugin manifest, the
// MCP server configuration and the skills; the server bundle is never committed there. This script
// assembles the installable plugin from that directory, the built bundle (dist/opentune-mcp.mjs),
// LICENSE and THIRD-PARTY-NOTICES.md, and zips it so that the same inputs always give the same
// bytes (zipStored from scripts/mcpb.mjs: sorted entries, fixed timestamps, stored). The zip is
// the release asset that the marketplace entry in .claude-plugin/marketplace.json downloads; see
// docs/adr/0002-plugin-distribution.md.
//
// Usage: node scripts/plugin.mjs build [--out <dir>]     writes <dir>/plugin/ (the assembled
//                                                       plugin), <dir>/opentune-plugin.zip and its
//                                                       .sha256 (default dist); needs npm run build
//        node scripts/plugin.mjs validate [--out <dir>]  the same, then `claude plugin validate
//                                                       --strict` on the assembled plugin and on
//                                                       the marketplace file
//
// `claude plugin validate` comes from Claude Code at the version pinned in scripts/claude-cli
// (package.json + lockfile, so npm verifies every package's integrity): the `claude` on PATH when
// it reports exactly that version, otherwise an install under .cache/tools/claude-code. It runs
// with CLAUDE_CONFIG_DIR pointing at .cache/claude-config, so it never reads or writes the
// configuration of the person running it.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { zipStored } from './mcpb.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_DIR = 'plugins/opentune';
export const PLUGIN_MANIFEST = `${PLUGIN_DIR}/.claude-plugin/plugin.json`;
export const MCP_CONFIG = `${PLUGIN_DIR}/.mcp.json`;
export const MARKETPLACE = '.claude-plugin/marketplace.json';
export const MCPB_MANIFEST = 'mcpb/manifest.json';
export const BUNDLE = 'dist/opentune-mcp.mjs';
/** Where the bundle sits inside the assembled plugin; .mcp.json names it. */
export const SERVER_PATH = 'servers/opentune-mcp.mjs';
export const PLUGIN_NAME = 'opentune';
export const PLUGIN_ZIP = 'opentune-plugin.zip';
/**
 * The marketplace entry's source. GitHub redirects this URL to the asset of the latest published
 * release (drafts and pre-releases excluded), so the entry never changes from one release to the
 * next and the plugin a user installs is always the one a release workflow built from its tag.
 */
export const PLUGIN_ARCHIVE_URL = `https://github.com/synchain-oss/opentune-mcp-server/releases/latest/download/${PLUGIN_ZIP}`;
export const SERVER_ARGS = Object.freeze([`\${CLAUDE_PLUGIN_ROOT}/${SERVER_PATH}`]);
export const SERVER_ENV = Object.freeze({ OPENTUNE_MCP_OPENTUNE_PATH: '${user_config.opentune_path}' });
/** Words that Claude Code and claude.ai reserve in plugin, marketplace and skill names. */
export const RESERVED_WORDS = Object.freeze(['claude', 'anthropic']);
export const DEFAULT_OUT = 'dist';
/** Files and directories of the working tree that never go into the plugin. */
export const SKIPPED_NAMES = Object.freeze([
  '.gitignore',
  '.DS_Store',
  'Thumbs.db',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'node_modules',
]);
export const TOOL_SRC = 'scripts/claude-cli';
export const TOOL_DIR = '.cache/tools/claude-code';
export const CONFIG_DIR = '.cache/claude-config';

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

async function readJson(file, root) {
  return JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
}

/** Every string anywhere in a JSON value, with its path, for the slash and placeholder checks. */
function strings(value, at = '') {
  if (typeof value === 'string') return [{ at, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${at}[${i}]`));
  if (isObject(value)) return Object.entries(value).flatMap(([k, v]) => strings(v, at ? `${at}.${k}` : k));
  return [];
}

const reserved = (name) => RESERVED_WORDS.filter((word) => String(name).toLowerCase().includes(word));

// ---------------------------------------------------------------------------------------------
// consistency

/**
 * Checks the plugin sources against each other and against the other packages: one version for
 * package.json, the plugin manifest and the MCPB manifest; the plugin and marketplace entry names
 * agree and use no reserved word; .mcp.json starts the bundle with node and passes the OpenTune
 * path setting, which the manifest declares exactly as the MCPB manifest does; the marketplace
 * entry downloads the release asset; manifest paths use forward slashes.
 * @param {{ pkg: any, plugin: any, mcp: any, marketplace: any, mcpb: any, skills?: string[] }} input
 * @returns {string[]}
 */
export function checkPluginSources({ pkg, plugin, mcp, marketplace, mcpb, skills = [] }) {
  const problems = [];
  if (plugin.name !== PLUGIN_NAME) problems.push(`${PLUGIN_MANIFEST}: name must be "${PLUGIN_NAME}"`);
  if (plugin.version !== pkg.version)
    problems.push(`${PLUGIN_MANIFEST}: version ${plugin.version} differs from package.json ${pkg.version}`);
  if (mcpb.version !== pkg.version)
    problems.push(`${MCPB_MANIFEST}: version ${mcpb.version} differs from package.json ${pkg.version}`);
  if (plugin.license !== pkg.license) problems.push(`${PLUGIN_MANIFEST}: license must be ${pkg.license}`);

  const option = plugin.userConfig?.opentune_path;
  const mcpbOption = mcpb.user_config?.opentune_path;
  if (!isObject(option) || Object.keys(plugin.userConfig).length !== 1) {
    problems.push(`${PLUGIN_MANIFEST}: userConfig must declare exactly opentune_path`);
  } else {
    if (option.type !== 'file') problems.push(`${PLUGIN_MANIFEST}: userConfig.opentune_path.type must be "file"`);
    if (option.required !== false || option.sensitive === true)
      problems.push(`${PLUGIN_MANIFEST}: userConfig.opentune_path must be optional and not sensitive`);
    for (const key of ['title', 'description']) {
      if (option[key] !== mcpbOption?.[key])
        problems.push(`${PLUGIN_MANIFEST}: userConfig.opentune_path.${key} must match ${MCPB_MANIFEST}`);
    }
  }

  const servers = isObject(mcp.mcpServers) ? Object.keys(mcp.mcpServers) : [];
  const server = mcp.mcpServers?.[PLUGIN_NAME];
  if (servers.length !== 1 || !isObject(server)) {
    problems.push(`${MCP_CONFIG}: must declare exactly one server, "${PLUGIN_NAME}"`);
  } else {
    if (server.command !== 'node') problems.push(`${MCP_CONFIG}: the server must start with "node"`);
    if (JSON.stringify(server.args) !== JSON.stringify(SERVER_ARGS))
      problems.push(`${MCP_CONFIG}: args must be ${JSON.stringify(SERVER_ARGS)}`);
    if (JSON.stringify(server.env) !== JSON.stringify(SERVER_ENV))
      problems.push(`${MCP_CONFIG}: env must be ${JSON.stringify(SERVER_ENV)}`);
  }
  const declared = new Set(Object.keys(isObject(plugin.userConfig) ? plugin.userConfig : {}));
  for (const { at, value } of strings(mcp)) {
    for (const m of value.matchAll(/\$\{user_config\.([^}]*)\}/g)) {
      if (!declared.has(m[1] ?? '')) problems.push(`${MCP_CONFIG}: ${at} names undeclared user_config.${m[1]}`);
    }
  }

  const name = String(marketplace.name ?? '');
  if (reserved(name).length) problems.push(`${MARKETPLACE}: name "${name}" contains a reserved word`);
  const entries = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const entry = entries[0];
  if (entries.length !== 1 || !isObject(entry)) {
    problems.push(`${MARKETPLACE}: must list exactly one plugin`);
  } else {
    if (entry.name !== plugin.name)
      problems.push(`${MARKETPLACE}: entry name "${entry.name}" differs from the plugin name "${plugin.name}"`);
    if (!isObject(entry.source) || entry.source.source !== 'archive' || entry.source.url !== PLUGIN_ARCHIVE_URL)
      problems.push(
        `${MARKETPLACE}: the entry's source must be { "source": "archive", "url": "${PLUGIN_ARCHIVE_URL}" }`,
      );
    // plugin.json carries the version; a second one in the entry is ignored at install and drifts.
    if ('version' in entry) problems.push(`${MARKETPLACE}: the entry must not set a version (plugin.json does)`);
  }

  for (const [file, value] of [
    [PLUGIN_MANIFEST, plugin],
    [MCP_CONFIG, mcp],
    [MARKETPLACE, marketplace],
  ]) {
    for (const { at, value: s } of strings(value)) {
      if (s.includes('\\')) problems.push(`${file}: ${at} contains a backslash; manifest paths use forward slashes`);
    }
  }
  for (const n of [plugin.name, ...skills]) {
    if (reserved(n).length) problems.push(`${PLUGIN_DIR}: name "${n}" contains a reserved word`);
  }
  return problems;
}

/** Reads the inputs of checkPluginSources from a repository tree. */
export async function readPluginSources(root = ROOT) {
  const skillsDir = path.join(root, PLUGIN_DIR, 'skills');
  const skills = (await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return {
    pkg: await readJson('package.json', root),
    plugin: await readJson(PLUGIN_MANIFEST, root),
    mcp: await readJson(MCP_CONFIG, root),
    marketplace: await readJson(MARKETPLACE, root),
    mcpb: await readJson(MCPB_MANIFEST, root),
    skills,
  };
}

// ---------------------------------------------------------------------------------------------
// assemble

/**
 * The files of plugins/opentune that go into the plugin, as forward-slash paths relative to it.
 * servers/ is filled by the assembly, so its contents in the working tree are not read. Symbolic
 * links are refused: the zip cannot carry them and they could point outside the plugin.
 */
export async function pluginSourceFiles(root = ROOT) {
  const base = path.join(root, PLUGIN_DIR);
  const files = [];
  const walk = async (dir, prefix) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (SKIPPED_NAMES.includes(entry.name) || entry.name.endsWith('.pyc')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new Error(`${PLUGIN_DIR}/${rel} is a symbolic link; the plugin cannot carry it`);
      if (entry.isDirectory()) {
        if (rel !== 'servers') await walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  };
  await walk(base, '');
  return files.sort();
}

/**
 * Checks the sources and returns the assembled plugin: its entries (relative path and bytes), the
 * zip and its sha256. Needs the built bundle.
 * @param {string} [root]
 * @returns {Promise<{ entries: { name: string, data: Buffer }[], files: string[], bytes: Buffer,
 *   sha256: string, version: string }>}
 */
export async function assemblePlugin(root = ROOT) {
  const sources = await readPluginSources(root);
  const problems = checkPluginSources(sources);
  if (problems.length) throw new Error(`the plugin sources are inconsistent:\n  - ${problems.join('\n  - ')}`);
  const bundle = await fs.readFile(path.join(root, BUNDLE)).catch(() => null);
  if (bundle === null) throw new Error(`${BUNDLE} is missing; run npm run build first`);
  const entries = [];
  for (const rel of await pluginSourceFiles(root)) {
    entries.push({ name: rel, data: await fs.readFile(path.join(root, PLUGIN_DIR, rel)) });
  }
  const added = [
    { name: SERVER_PATH, data: bundle },
    { name: 'LICENSE', data: await fs.readFile(path.join(root, 'LICENSE')) },
    { name: 'THIRD-PARTY-NOTICES.md', data: await fs.readFile(path.join(root, 'THIRD-PARTY-NOTICES.md')) },
  ];
  for (const a of added) {
    if (entries.some((e) => e.name === a.name))
      throw new Error(`${PLUGIN_DIR}/${a.name} must not exist in the sources`);
    entries.push(a);
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const bytes = zipStored(entries);
  return {
    entries,
    files: entries.map((e) => e.name),
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    version: String(sources.plugin.version),
  };
}

/**
 * Writes <outDir>/plugin/ (replaced as a whole), <outDir>/opentune-plugin.zip and its .sha256.
 * @returns {Promise<Awaited<ReturnType<typeof assemblePlugin>> & { dir: string, zip: string }>}
 */
export async function buildPlugin(root = ROOT, outDir = path.join(root, DEFAULT_OUT)) {
  const assembled = await assemblePlugin(root);
  const dir = path.join(outDir, 'plugin');
  await fs.rm(dir, { recursive: true, force: true });
  for (const { name, data } of assembled.entries) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), data);
  }
  const zip = path.join(outDir, PLUGIN_ZIP);
  await fs.writeFile(zip, assembled.bytes);
  await fs.writeFile(`${zip}.sha256`, `${assembled.sha256}  ${PLUGIN_ZIP}\n`);
  return { ...assembled, dir, zip };
}

// ---------------------------------------------------------------------------------------------
// claude plugin validate

/** The pinned Claude Code command-line tool could not be found or installed (for example, offline). */
export class ClaudeCliUnavailable extends Error {}

function npm(args, cwd) {
  // As in scripts/mcpb.mjs: under npm, run npm's own script with node (no shell).
  const npmCli = process.env.npm_execpath;
  if (npmCli && /\.(?:c?js|mjs)$/.test(npmCli))
    return spawnSync(process.execPath, [npmCli, ...args], { cwd, stdio: ['ignore', 2, 2] });
  return spawnSync('npm', args, { cwd, stdio: ['ignore', 2, 2], shell: process.platform === 'win32' });
}

/** Environment of every CLI run: a configuration directory of its own, no updates, no telemetry. */
function cliEnv(root) {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: path.join(root, CONFIG_DIR),
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

/** Quotes one argument for cmd.exe; the arguments here are paths and flags without quotes. */
const cmdQuote = (arg) => (/^[\w./:=-]+$/.test(arg) ? arg : `"${arg}"`);

/**
 * Finds the pinned Claude Code CLI: the `claude` on PATH when it reports exactly the pinned
 * version, otherwise an install under .cache/tools/claude-code (once per lockfile).
 * @returns {Promise<{ run: (args: string[]) => import('node:child_process').SpawnSyncReturns<string>,
 *   version: string, source: string }>}
 */
export async function ensureClaudeCli(root = ROOT) {
  const pinned = (await readJson(`${TOOL_SRC}/package.json`, root)).dependencies['@anthropic-ai/claude-code'];
  await fs.mkdir(path.join(root, CONFIG_DIR), { recursive: true });
  const env = cliEnv(root);
  const options = { cwd: root, env, encoding: /** @type {const} */ ('utf8') };
  // On Windows the `claude` on PATH is often an npm .cmd shim, which only a shell can start.
  const onPath = (args) =>
    process.platform === 'win32'
      ? spawnSync(['claude', ...args].map(cmdQuote).join(' '), { ...options, shell: true })
      : spawnSync('claude', args, options);
  const found = onPath(['--version']);
  if (!found.error && found.status === 0 && found.stdout.trim().split(/\s+/)[0] === pinned)
    return { run: onPath, version: pinned, source: 'the claude on PATH' };

  const src = path.join(root, TOOL_SRC);
  const dir = path.join(root, TOOL_DIR);
  const lock = await fs.readFile(path.join(src, 'package-lock.json'));
  const stamp = createHash('sha256').update(lock).digest('hex');
  const cli = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli-wrapper.cjs');
  const stampFile = path.join(dir, '.lock-sha256');
  const installed = await fs.readFile(stampFile, 'utf8').catch(() => null);
  if (installed?.trim() !== stamp || !(await fs.stat(cli).catch(() => null))) {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(src, f), path.join(dir, f));
    // --ignore-scripts: the package's postinstall would only copy the platform binary over its
    // launcher; cli-wrapper.cjs starts that binary from the platform package instead.
    const result = npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
    if (result.error || result.status !== 0)
      throw new ClaudeCliUnavailable(
        `could not install the pinned Claude Code CLI ${pinned} (npm ci exited with ${result.status ?? 'an error'})`,
      );
    await fs.writeFile(stampFile, `${stamp}\n`);
  }
  const run = (args) => spawnSync(process.execPath, [cli, ...args], options);
  const version = run(['--version']);
  if (version.error || version.status !== 0 || version.stdout.trim().split(/\s+/)[0] !== pinned)
    throw new ClaudeCliUnavailable(
      `the pinned Claude Code CLI does not start or is not ${pinned}: ${`${version.stdout ?? ''}${version.stderr ?? ''}`.trim()}`,
    );
  return { run, version: pinned, source: `a pinned install in ${TOOL_DIR}` };
}

/**
 * Runs `claude plugin validate --strict` on an assembled plugin directory and on the marketplace
 * (the repository root); throws on any error or warning. Returns the CLI's output and version.
 */
export async function validatePlugin(root, pluginDir) {
  const cli = await ensureClaudeCli(root);
  const lines = [];
  for (const target of [pluginDir, root]) {
    const r = cli.run(['plugin', 'validate', '--strict', target]);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    if (r.error || r.status !== 0)
      throw new Error(`claude plugin validate --strict ${target} failed: ${out || r.error?.message}`);
    lines.push(out);
  }
  return { lines, version: cli.version, source: cli.source };
}

// ---------------------------------------------------------------------------------------------
// CLI

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  const i = rest.indexOf('--out');
  const out = i >= 0 && rest[i + 1] ? path.resolve(rest[i + 1]) : undefined;
  try {
    if (command === 'build' || command === 'validate') {
      const built = await buildPlugin(ROOT, out);
      process.stdout.write(`${built.dir}\n${built.zip}\nsha256 ${built.sha256}\n`);
      if (command === 'validate') {
        const result = await validatePlugin(ROOT, built.dir);
        process.stdout.write(`${result.lines.join('\n')}\nClaude Code ${result.version} (${result.source})\n`);
      }
    } else {
      process.stderr.write('usage: node scripts/plugin.mjs build [--out <dir>] | validate [--out <dir>]\n');
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`plugin: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
