// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Generates THIRD-PARTY-NOTICES.md from the esbuild metafile: every third-party package that
// contributes code to dist/opentune-mcp.mjs, with its version, its license, and the full text
// of its license (and NOTICE) files. A bundled package without license information is an
// error, so a new dependency can never ship unlisted.
//
// Usage:
//   node scripts/gen-notices.mjs           write THIRD-PARTY-NOTICES.md
//   node scripts/gen-notices.mjs --check   exit 1 if the committed file differs from the output

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

import { BUNDLE, ROOT, bundleOptions } from './build.mjs';

export const NOTICES_FILE = 'THIRD-PARTY-NOTICES.md';

const LICENSE_FILE_RE = /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i;

/**
 * Maps a metafile input path to the root directory of the package it belongs to, or null for
 * first-party sources. Uses the last `node_modules` segment, so nested installs resolve to the
 * innermost package and nested package.json files (e.g. `dist/esm/package.json`) are ignored.
 */
export function packageRootOf(inputPath) {
  const parts = inputPath.split(/[\\/]/);
  const idx = parts.lastIndexOf('node_modules');
  if (idx === -1 || idx + 1 >= parts.length) return null;
  const scoped = parts[idx + 1].startsWith('@');
  const end = idx + (scoped ? 3 : 2);
  if (end > parts.length) return null;
  return parts.slice(0, end).join('/');
}

/** Package roots (relative to the project root) that contribute bytes to the bundle. */
export function bundledPackageRoots(metafile, outfile = BUNDLE) {
  const output = metafile.outputs[outfile];
  if (!output) throw new Error(`metafile has no output ${outfile}`);
  const roots = new Set();
  for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
    if (bytesInOutput <= 0) continue;
    const root = packageRootOf(input);
    if (root) roots.add(root);
  }
  return [...roots].sort();
}

function spdxIds(expression) {
  return [...new Set(expression.match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g) ?? [])].filter(
    (token) => !['AND', 'OR', 'WITH'].includes(token),
  );
}

async function describePackage(root, pkgRoot) {
  const dir = path.join(root, pkgRoot);
  const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  const problems = [];
  if (typeof pkg.name !== 'string' || !pkg.name) problems.push('no name');
  if (typeof pkg.version !== 'string' || !pkg.version) problems.push('no version');
  const license = typeof pkg.license === 'string' ? pkg.license.trim() : '';
  if (!license || /^(?:UNLICENSED|SEE LICENSE IN\b)/i.test(license)) {
    problems.push(`no SPDX license expression in package.json (found ${JSON.stringify(pkg.license ?? null)})`);
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const licenseFiles = [];
  for (const entry of entries
    .filter((e) => e.isFile() && LICENSE_FILE_RE.test(e.name))
    .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const text = (await fs.readFile(path.join(dir, entry.name), 'utf8')).replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    if (text) licenseFiles.push({ name: entry.name, text });
  }
  if (problems.length) throw new Error(`${pkgRoot}: ${problems.join('; ')}`);
  return { name: pkg.name, version: pkg.version, license, licenseFiles };
}

function fenceFor(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

export function renderNotices(packages) {
  const lines = [
    '# Third-party notices',
    '',
    '`dist/opentune-mcp.mjs`, the single file published as `@synchain/opentune-mcp`, includes code',
    'from the third-party packages below. This file is generated from the esbuild metafile by',
    '`scripts/gen-notices.mjs`; do not edit it by hand. Run `npm run notices` after changing',
    'dependencies; `npm run gates` fails while it is out of date.',
    '',
    '| Package | Version | License |',
    '| --- | --- | --- |',
    ...packages.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`),
  ];
  for (const p of packages) {
    lines.push('', `## ${p.name} ${p.version}`, '', `License: ${p.license}`, '');
    lines.push(`Source: https://www.npmjs.com/package/${p.name}/v/${p.version}`);
    if (p.licenseFiles.length === 0) {
      lines.push('', 'The package ships no license file. License text:');
      for (const id of spdxIds(p.license)) lines.push(`- https://spdx.org/licenses/${id}.html`);
    }
    for (const file of p.licenseFiles) {
      const fence = fenceFor(file.text);
      lines.push('', `### ${file.name}`, '', `${fence}text`, file.text, fence);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Bundles in memory (dist/ is not touched) and renders the notices for what was bundled. */
export async function generateNotices(root = ROOT) {
  const result = await esbuild.build({ ...(await bundleOptions(root)), write: false });
  const packages = [];
  for (const pkgRoot of bundledPackageRoots(result.metafile)) packages.push(await describePackage(root, pkgRoot));
  packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { text: renderNotices(packages), packages };
}

/** Returns null when the committed file matches, else a short description of the difference. */
export async function checkNotices(root = ROOT) {
  const { text, packages } = await generateNotices(root);
  let committed;
  try {
    committed = await fs.readFile(path.join(root, NOTICES_FILE), 'utf8');
  } catch {
    return { ok: false, packages, detail: `${NOTICES_FILE} is missing; run npm run notices` };
  }
  if (committed === text) return { ok: true, packages, detail: '' };
  return { ok: false, packages, detail: `${NOTICES_FILE} is out of date; run npm run notices` };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    if (process.argv.includes('--check')) {
      const result = await checkNotices();
      process.stderr.write(
        result.ok ? `gen-notices: ${NOTICES_FILE} is up to date\n` : `gen-notices: ${result.detail}\n`,
      );
      process.exitCode = result.ok ? 0 : 1;
    } else {
      const { text, packages } = await generateNotices();
      await fs.writeFile(path.join(ROOT, NOTICES_FILE), text);
      process.stderr.write(`gen-notices: wrote ${NOTICES_FILE} (${packages.length} packages)\n`);
    }
  } catch (error) {
    process.stderr.write(`gen-notices: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
