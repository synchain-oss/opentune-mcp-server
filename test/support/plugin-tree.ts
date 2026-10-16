// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// A temporary repository tree with what the plugin, skills and release packaging read: the real
// plugin, marketplace and MCPB manifests (with the version replaced), a stand-in bundle, LICENSE,
// THIRD-PARTY-NOTICES.md and the given skills.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../..', import.meta.url));

export type Files = Record<string, string | Buffer>;

export interface PluginTree {
  root: string;
  write: (rel: string, data: string | Buffer) => Promise<void>;
  remove: () => Promise<void>;
}

/** A SKILL.md with the given frontmatter lines and a short body. */
export const skillMd = (...frontmatter: string[]) => `---\n${frontmatter.join('\n')}\n---\n\n# Steps\n\nDo this.\n`;

/** An instruction-only skill that passes every check. */
export const goodSkill = (name: string): Files => ({
  'SKILL.md': skillMd(`name: ${name}`, `description: Use when the user asks for ${name}.`),
  'reference/notes.md': '# Notes\n',
});

export async function pluginTree({
  version = '1.2.3',
  skills = {},
  bundle = '#!/usr/bin/env node\n// stand-in bundle\n',
}: { version?: string; skills?: Record<string, Files>; bundle?: string | null } = {}): Promise<PluginTree> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ot-plugin-'));
  const write = async (rel: string, data: string | Buffer) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), data);
  };
  const json = async (rel: string, change: (value: Record<string, unknown>) => void) => {
    const value = JSON.parse(await fs.readFile(path.join(REPO, rel), 'utf8')) as Record<string, unknown>;
    change(value);
    await write(rel, `${JSON.stringify(value, null, 2)}\n`);
  };
  await json('package.json', (v) => (v.version = version));
  await json('mcpb/manifest.json', (v) => (v.version = version));
  await json('plugins/opentune/.claude-plugin/plugin.json', (v) => (v.version = version));
  await json('plugins/opentune/.mcp.json', () => undefined);
  await json('.claude-plugin/marketplace.json', () => undefined);
  await write('plugins/opentune/servers/.gitignore', '*\n!.gitignore\n');
  await write('LICENSE', 'MIT License\n');
  await write('THIRD-PARTY-NOTICES.md', '# Notices\n');
  if (bundle !== null) await write('dist/opentune-mcp.mjs', bundle);
  for (const [name, files] of Object.entries(skills)) {
    for (const [rel, data] of Object.entries(files)) await write(`plugins/opentune/skills/${name}/${rel}`, data);
  }
  return { root, write, remove: () => fs.rm(root, { recursive: true, force: true }) };
}
