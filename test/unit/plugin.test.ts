// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The Claude Code plugin: the sources in plugins/opentune and .claude-plugin agree with each other
// and with the npm and MCPB packages, and the assembled plugin zip is deterministic and complete.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MARKETPLACE,
  MCP_CONFIG,
  PLUGIN_ARCHIVE_URL,
  PLUGIN_MANIFEST,
  PLUGIN_ZIP,
  SERVER_PATH,
  assemblePlugin,
  buildPlugin,
  checkPluginSources,
  pluginSourceFiles,
  readPluginSources,
} from '../../scripts/plugin.mjs';
import { assetNames } from '../../scripts/release-assets.mjs';
import { REPO, goodSkill, pluginTree, type PluginTree } from '../support/plugin-tree.js';
import { readZip } from '../support/zip.js';

type Obj = Record<string, unknown>;
interface Sources {
  pkg: { version: string };
  plugin: { name: string; version: string; license: string; userConfig: Record<string, Obj> };
  mcp: { mcpServers: Record<string, Obj> };
  marketplace: { name: string; plugins: Obj[] };
  mcpb: { version: string };
  skills: string[];
}

const readJson = async (rel: string) => JSON.parse(await fs.readFile(path.join(REPO, rel), 'utf8')) as Obj;
const fresh = async () => structuredClone<Sources>(await readPluginSources(REPO));
// The parts the cases change; each exists in the repository's sources.
const option = (s: Sources) => s.plugin.userConfig.opentune_path ?? {};
const server = (s: Sources) => s.mcp.mcpServers.opentune ?? {};
const entry = (s: Sources) => s.marketplace.plugins[0] ?? {};

describe('plugin sources of this repository', () => {
  it('are consistent', async () => {
    expect(checkPluginSources(await readPluginSources(REPO))).toEqual([]);
  });

  it('give package.json, the plugin manifest and the MCPB manifest one version', async () => {
    const { version } = await readJson('package.json');
    expect(await readJson(PLUGIN_MANIFEST)).toMatchObject({ version });
    expect(await readJson('mcpb/manifest.json')).toMatchObject({ version });
  });

  it('start the bundle with node and pass the OpenTune path setting, as the MCPB package does', async () => {
    const env = { OPENTUNE_MCP_OPENTUNE_PATH: '${user_config.opentune_path}' };
    expect(await readJson(MCP_CONFIG)).toEqual({
      mcpServers: { opentune: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/servers/opentune-mcp.mjs'], env } },
    });
    expect(await readJson('mcpb/manifest.json')).toMatchObject({ server: { mcp_config: { env } } });
  });

  it('download the plugin from the release asset that the release workflow attaches', async () => {
    expect(await readJson(MARKETPLACE)).toMatchObject({
      plugins: [{ name: 'opentune', source: { source: 'archive', url: PLUGIN_ARCHIVE_URL } }],
    });
    expect(PLUGIN_ARCHIVE_URL.endsWith(`/releases/latest/download/${assetNames('1.0.0').plugin}`)).toBe(true);
  });
});

describe('checkPluginSources', () => {
  it.each<[string, (s: Sources) => unknown, string]>([
    ['the plugin version', (s) => (s.plugin.version = '9.9.9'), 'differs from package.json'],
    ['the MCPB version', (s) => (s.mcpb.version = '9.9.9'), 'mcpb/manifest.json: version'],
    ['the plugin name', (s) => (s.plugin.name = 'opentune-tools'), 'name must be "opentune"'],
    ['the licence', (s) => (s.plugin.license = 'GPL-3.0'), 'license must be MIT'],
    ['the option type', (s) => (option(s).type = 'string'), 'type must be "file"'],
    ['a required option', (s) => (option(s).required = true), 'must be optional'],
    ['the option text', (s) => (option(s).description = 'Path.'), 'description must match mcpb/manifest.json'],
    ['a second option', (s) => (s.plugin.userConfig.other = { type: 'string' }), 'exactly opentune_path'],
    ['the command', (s) => (server(s).command = 'npx'), 'must start with "node"'],
    ['the bundle path', (s) => (server(s).args = ['${CLAUDE_PLUGIN_ROOT}/dist/opentune-mcp.mjs']), 'args must be'],
    [
      'an undeclared option',
      (s) => (server(s).env = { OPENTUNE_MCP_OPENTUNE_PATH: '${user_config.exe}' }),
      'undeclared user_config.exe',
    ],
    ['a second server', (s) => (s.mcp.mcpServers.other = { command: 'node' }), 'exactly one server'],
    ['the entry name', (s) => (entry(s).name = 'opentune-mcp'), 'differs from the plugin name'],
    ['the entry source', (s) => (entry(s).source = './plugins/opentune'), 'source must be { "source": "archive"'],
    ['an entry version', (s) => (entry(s).version = '1.0.0'), 'must not set a version'],
    ['a second entry', (s) => s.marketplace.plugins.push({ name: 'x' }), 'exactly one plugin'],
    ['a reserved marketplace name', (s) => (s.marketplace.name = 'claude-tools'), 'reserved word'],
    ['a reserved skill name', (s) => (s.skills = ['anthropic-helper']), 'reserved word'],
    [
      'a backslash path',
      (s) => (server(s).args = ['${CLAUDE_PLUGIN_ROOT}\\servers\\opentune-mcp.mjs']),
      'forward slashes',
    ],
  ])('turns red on %s', async (_label, change, message) => {
    const sources = await fresh();
    change(sources);
    expect(checkPluginSources(sources as Parameters<typeof checkPluginSources>[0]).join('\n')).toContain(message);
  });
});

describe('plugin assembly', () => {
  let tree: PluginTree | undefined;
  afterEach(async () => {
    await tree?.remove();
    tree = undefined;
  });

  it('holds the sources, the bundle in servers/, the licence and the notices, and nothing from servers/ or caches', async () => {
    tree = await pluginTree({ skills: { 'tuning-workflow': goodSkill('tuning-workflow') } });
    await tree.write('plugins/opentune/servers/opentune-mcp.mjs', 'stale copy');
    await tree.write('plugins/opentune/skills/tuning-workflow/__pycache__/x.pyc', 'cache');
    await tree.write('plugins/opentune/skills/tuning-workflow/y.pyc', 'cache');
    const built = await assemblePlugin(tree.root);
    expect(built.files).toEqual([
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'LICENSE',
      'THIRD-PARTY-NOTICES.md',
      SERVER_PATH,
      'skills/tuning-workflow/SKILL.md',
      'skills/tuning-workflow/reference/notes.md',
    ]);
    const zip = readZip(built.bytes);
    expect(zip.map((e) => e.name)).toEqual(built.files);
    expect(zip.find((e) => e.name === SERVER_PATH)?.data.toString()).toContain('stand-in bundle');
    expect(built.version).toBe('1.2.3');
    expect(built.sha256).toBe(createHash('sha256').update(built.bytes).digest('hex'));
  });

  it('gives the same bytes twice, and other bytes when a skill changes', async () => {
    tree = await pluginTree({ skills: { 'check-results': goodSkill('check-results') } });
    const a = await assemblePlugin(tree.root);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = await assemblePlugin(tree.root);
    expect(b.bytes.equals(a.bytes)).toBe(true);
    await tree.write('plugins/opentune/skills/check-results/SKILL.md', 'changed');
    expect((await assemblePlugin(tree.root)).sha256).not.toBe(a.sha256);
  });

  it('asks for a build when the bundle is missing, and refuses inconsistent sources', async () => {
    tree = await pluginTree({ bundle: null });
    await expect(assemblePlugin(tree.root)).rejects.toThrow('npm run build');
    await tree.write('mcpb/manifest.json', JSON.stringify({ version: '0.0.1' }));
    await expect(assemblePlugin(tree.root)).rejects.toThrow('inconsistent');
  });

  it('refuses a source file that the assembly adds itself', async () => {
    tree = await pluginTree();
    await tree.write('plugins/opentune/LICENSE', 'other');
    await expect(assemblePlugin(tree.root)).rejects.toThrow('must not exist in the sources');
  });

  it('refuses a symbolic link in the plugin sources', async (ctx) => {
    tree = await pluginTree();
    try {
      await fs.symlink(path.join(tree.root, 'LICENSE'), path.join(tree.root, 'plugins/opentune/linked'));
    } catch {
      ctx.skip(); // creating links needs a privilege on Windows
    }
    await expect(pluginSourceFiles(tree.root)).rejects.toThrow('symbolic link');
  });

  it('writes the assembled directory, the zip and its sha256 file', async () => {
    tree = await pluginTree();
    const out = path.join(tree.root, 'out');
    await fs.mkdir(path.join(out, 'plugin', 'old'), { recursive: true });
    const built = await buildPlugin(tree.root, out);
    expect(await fs.readFile(path.join(out, PLUGIN_ZIP))).toEqual(built.bytes);
    expect(await fs.readFile(path.join(out, `${PLUGIN_ZIP}.sha256`), 'utf8')).toBe(`${built.sha256}  ${PLUGIN_ZIP}\n`);
    expect(await fs.readFile(path.join(out, 'plugin', SERVER_PATH), 'utf8')).toContain('stand-in bundle');
    await expect(fs.stat(path.join(out, 'plugin', 'old'))).rejects.toThrow();
  });
});
