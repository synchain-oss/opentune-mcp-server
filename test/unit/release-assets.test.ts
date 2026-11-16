// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Release assets: the four packages of one version with their .sha256 files, and release notes
// made of fixed text that passes the attribution check.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkText, loadPatterns } from '../../scripts/check-attribution.mjs';
import { loadCompatibility } from '../../scripts/compat.mjs';
import { assetNames, buildAssets, readDigests, releaseNotes } from '../../scripts/release-assets.mjs';
import { REPO, goodSkill, pluginTree, type PluginTree } from '../support/plugin-tree.js';

const digest = (c: string) => c.repeat(64);

/** A compatibility.json with a record for 1.4.0 (and an older one), so that the notes of that version can be made. */
const compatibility = {
  schema: 1,
  records: [
    {
      server: '1.3.0',
      spec: '1.0.0',
      opentune: [{ kind: 'testBuild', tag: 'synchain-test/v1.8.0-ctl.1', verified: true, note: 'Old.' }],
    },
    {
      server: '1.4.0',
      spec: '1.1.0',
      opentune: [
        {
          kind: 'testBuild',
          tag: 'synchain-test/v1.8.0-ctl.3',
          platforms: ['windows-x64', 'macos-arm64'],
          verified: true,
          note: 'x',
        },
        { kind: 'upstreamSource', branch: 'standalone', commit: '86bf698', verified: false, note: 'y' },
      ],
    },
  ],
};

describe('releaseNotes', () => {
  const names = assetNames('1.4.0');
  const digests = new Map([
    [names.plugin, digest('a')],
    [names.mcpb, digest('b')],
    [names.skills, digest('c')],
    [names.npm, digest('d')],
  ]);

  it('lists the four packages with their sha256 and the install commands', () => {
    const notes = releaseNotes('1.4.0', digests, compatibility);
    for (const [name, sha] of digests) {
      expect(notes).toContain(`| \`${name}\` |`);
      expect(notes).toContain(sha);
    }
    expect(notes).toContain('claude plugin marketplace add synchain-oss/opentune-mcp-server');
    expect(notes).toContain('claude plugin install opentune@synchain-opentune');
    expect(notes).toContain('npx -y @synchain/opentune-mcp@1.4.0');
    expect(notes).not.toContain('pre-release');
  });

  it('says that the marketplace keeps the last full release for a pre-release', () => {
    const rc = assetNames('1.4.0-rc.1');
    const notes = releaseNotes(
      '1.4.0-rc.1',
      new Map(Object.values(rc).map((n, i) => [n, digest(String(i))] as [string, string])),
      { ...compatibility, records: [{ ...compatibility.records[1], server: '1.4.0-rc.1' }] },
    );
    expect(notes).toContain('This is a pre-release');
  });

  it('passes the attribution check', () => {
    const result = checkText(releaseNotes('1.4.0', digests, compatibility), {
      patterns: loadPatterns(path.join(REPO, 'scripts', 'attribution-patterns.txt')) as { id: string; re: RegExp }[],
    }) as { violations: unknown[] };
    expect(result.violations).toEqual([]);
  });

  it('needs a sha256 for every package', () => {
    expect(() => releaseNotes('1.4.0', new Map(), compatibility)).toThrow(`no sha256 for ${names.plugin}`);
  });

  it('opens with the "Works with OpenTune" section of the version, before anything else', () => {
    const notes = releaseNotes('1.4.0', digests, compatibility);
    expect(notes.startsWith('### Works with OpenTune\n')).toBe(true);
    expect(notes.indexOf('### Works with OpenTune')).toBeLessThan(notes.indexOf('| File |'));
    expect(notes).toContain('synchain-test/v1.8.0-ctl.3');
    expect(notes).toContain('86bf698');
    expect(notes).toContain('listed, not yet verified against a real build');
    // The record of another version is not mixed in.
    expect(notes).not.toContain('ctl.1');
  });

  it('fails for a version that has no record in compatibility.json', () => {
    const other = assetNames('1.5.0');
    const more = new Map(Object.values(other).map((n) => [n, digest('e')] as [string, string]));
    expect(() => releaseNotes('1.5.0', more, compatibility)).toThrow(
      'has no record for server version 1.5.0; add one (docs/RELEASE.md) before releasing',
    );
  });

  it('is made from the record of the repository for the version of package.json', async () => {
    const { version } = JSON.parse(await fs.readFile(path.join(REPO, 'package.json'), 'utf8')) as { version: string };
    const real = (await loadCompatibility(REPO)) as unknown;
    const set = new Map(Object.values(assetNames(version)).map((n) => [n, digest('f')] as [string, string]));
    expect(releaseNotes(version, set, real)).toContain(`OpenTune MCP Server ${version} (OTCP specification`);
  });
});

describe('buildAssets', () => {
  let tree: PluginTree | undefined;
  afterEach(async () => {
    await tree?.remove();
    tree = undefined;
  });

  async function prepared(version = '1.4.0') {
    tree = await pluginTree({
      version,
      skills: { 'tuning-workflow': goodSkill('tuning-workflow'), 'check-results': goodSkill('check-results') },
    });
    const out = path.join(tree.root, 'assets');
    await fs.mkdir(out);
    await fs.writeFile(path.join(out, assetNames(version).npm), 'tarball');
    return out;
  }

  it('writes the other three packages and a sha256 file for each of the four', async () => {
    const out = await prepared();
    const digests = await buildAssets(tree?.root ?? '', out);
    const names = Object.values(assetNames('1.4.0'));
    expect((await fs.readdir(out)).sort()).toEqual(names.flatMap((n) => [n, `${n}.sha256`]).sort());
    expect([...digests.keys()].sort()).toEqual([...names].sort());
    for (const name of names) {
      const bytes = await fs.readFile(path.join(out, name));
      expect(digests.get(name), name).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    expect(await readDigests(out)).toEqual(digests);
  });

  it('starts only from the npm tarball', async () => {
    const out = await prepared();
    await fs.writeFile(path.join(out, 'extra.txt'), 'x');
    await expect(buildAssets(tree?.root ?? '', out)).rejects.toThrow('must hold only synchain-opentune-mcp-1.4.0.tgz');
  });

  it('rejects a malformed sha256 file', async () => {
    const out = await prepared();
    await fs.writeFile(path.join(out, 'x.tgz.sha256'), 'nope\n');
    await expect(readDigests(out)).rejects.toThrow('x.tgz.sha256');
  });
});
