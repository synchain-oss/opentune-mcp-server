// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The files a release attaches and its notes. Four packages of one version, each with a .sha256
// file: the npm tarball, the MCPB package for Claude Desktop, the Claude Code plugin zip (the
// marketplace entry downloads it from the latest release) and the skills zip that Claude Desktop
// users upload in Claude's settings. .github/workflows/release.yml runs this for tag pushes and dry runs alike;
// nothing here talks to GitHub.
//
// Usage: node scripts/release-assets.mjs build --out <dir>   needs `npm run build`, and the npm
//          tarball in <dir> (npm pack --pack-destination <dir>); writes the other three packages
//          and a .sha256 file for each of the four, and fails on any other file in <dir>
//        node scripts/release-assets.mjs notes --dir <dir>   prints the release notes (Markdown)
//          for the packages in <dir>

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { packMcpb } from './mcpb.mjs';
import { PLUGIN_ZIP, assemblePlugin } from './plugin.mjs';
import { writeSkillsZip } from './skills-zip.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MARKETPLACE_NAME = 'synchain-opentune';
export const REPOSITORY = 'synchain-oss/opentune-mcp-server';

/** The four packages of a version, in the order the notes list them. */
export function assetNames(version) {
  return {
    plugin: PLUGIN_ZIP,
    mcpb: `opentune-mcp-${version}.mcpb`,
    skills: `opentune-skills-${version}.zip`,
    npm: `synchain-opentune-mcp-${version}.tgz`,
  };
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function writeSha256(dir, name) {
  const digest = sha256(await fs.readFile(path.join(dir, name)));
  await fs.writeFile(path.join(dir, `${name}.sha256`), `${digest}  ${name}\n`);
  return digest;
}

/** Builds the packages next to the npm tarball in `outDir`; returns name -> sha256. */
export async function buildAssets(root, outDir) {
  const version = String(JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version);
  const names = assetNames(version);
  const before = await fs.readdir(outDir).catch(() => []);
  if (JSON.stringify(before) !== JSON.stringify([names.npm]))
    throw new Error(
      `${outDir} must hold only ${names.npm} (npm pack output) before the build; found ${before.join(', ') || 'nothing'}`,
    );

  const digests = new Map();
  digests.set(names.npm, await writeSha256(outDir, names.npm));
  const mcpb = await packMcpb(root, outDir);
  if (mcpb.name !== names.mcpb) throw new Error(`the MCPB package is ${mcpb.name}, expected ${names.mcpb}`);
  digests.set(names.mcpb, mcpb.sha256);
  const plugin = await assemblePlugin(root);
  if (plugin.version !== version) throw new Error(`the plugin is version ${plugin.version}, expected ${version}`);
  await fs.writeFile(path.join(outDir, names.plugin), plugin.bytes);
  digests.set(names.plugin, await writeSha256(outDir, names.plugin));
  const skills = await writeSkillsZip(root, outDir);
  digests.set(names.skills, skills.sha256);

  const expected = Object.values(names)
    .flatMap((n) => [n, `${n}.sha256`])
    .sort();
  const after = (await fs.readdir(outDir)).sort();
  if (JSON.stringify(after) !== JSON.stringify(expected))
    throw new Error(`${outDir} holds ${after.join(', ')}; expected exactly ${expected.join(', ')}`);
  return digests;
}

/** Reads `<name>.sha256` for each package of the version found in `dir`. */
export async function readDigests(dir) {
  const digests = new Map();
  for (const file of (await fs.readdir(dir)).filter((f) => f.endsWith('.sha256')).sort()) {
    const m = /^([0-9a-f]{64}) {2}(\S+)\n$/.exec(await fs.readFile(path.join(dir, file), 'utf8'));
    if (!m || `${m[2]}.sha256` !== file) throw new Error(`${file} is not one "<sha256>  <file>" line naming its file`);
    digests.set(m[2], m[1]);
  }
  return digests;
}

/**
 * Release notes for `version` with the given digests (name -> sha256). Only fixed text, the
 * version and the digests: nothing from commit messages or pull requests is copied in.
 */
export function releaseNotes(version, digests) {
  const names = assetNames(version);
  const row = (name, what) => {
    const digest = digests.get(name);
    if (!digest) throw new Error(`no sha256 for ${name}`);
    return `| \`${name}\` | ${what} | \`${digest}\` |`;
  };
  const lines = [
    `OpenTune MCP Server (by Synchain) ${version}. The four packages below are built from this tag and all carry version ${version}.`,
    '',
    '| File | What it is | sha256 |',
    '| --- | --- | --- |',
    row(
      names.plugin,
      'Claude Code plugin: the MCP server and its skills. Claude Code downloads it through the marketplace.',
    ),
    row(names.mcpb, 'MCPB package for Claude Desktop: the MCP server.'),
    row(
      names.skills,
      "The instruction-only skills, one zip per skill to upload in Claude's settings (for Claude Desktop).",
    ),
    row(names.npm, `The npm package \`@synchain/opentune-mcp\` ${version}, for other MCP clients.`),
    '',
    '### Install',
    '',
    `- **Claude Code:** \`claude plugin marketplace add ${REPOSITORY}\`, then \`claude plugin install opentune@${MARKETPLACE_NAME}\`. The plugin needs Node.js 22 or later.`,
    `- **Claude Desktop:** open \`${names.mcpb}\` for the tools. For the workflow guidance, extract \`${names.skills}\` and upload each zip in it as a skill in Claude's settings.`,
    `- **Other MCP clients:** \`npx -y @synchain/opentune-mcp@${version}\`.`,
    '',
    'Check a download with `sha256sum -c <file>.sha256`, or compare `Get-FileHash <file>` on Windows with the table. Changes are listed in CHANGELOG.md.',
  ];
  if (version.includes('-')) {
    lines.push(
      '',
      `This is a pre-release. The marketplace keeps serving the plugin of the latest full release; to try this one for a single session, run \`claude --plugin-dir ${names.plugin}\` on the downloaded file.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, flag, dir] = process.argv.slice(2);
  try {
    if (command === 'build' && flag === '--out' && dir) {
      const digests = await buildAssets(ROOT, path.resolve(dir));
      for (const [name, digest] of digests) process.stdout.write(`${digest}  ${name}\n`);
    } else if (command === 'notes' && flag === '--dir' && dir) {
      const version = String(JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version);
      process.stdout.write(releaseNotes(version, await readDigests(path.resolve(dir))));
    } else {
      process.stderr.write('usage: node scripts/release-assets.mjs build --out <dir> | notes --dir <dir>\n');
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`release-assets: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
