// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Each gate check must turn red on a planted violation, otherwise it proves nothing. Strings
// that the repository scanners look for (personal paths, foreign e-mail addresses) are
// assembled at runtime so that this file does not trip the scan it is testing.

import { describe, expect, it } from 'vitest';

import {
  BIN,
  PACKED_FILES,
  checkBundleShape,
  checkCommits,
  checkLockfile,
  checkPackList,
  checkPackageJson,
  compareHeadingOutlines,
  findPullRequestTarget,
  findStdoutConsoleCalls,
  markdownHeadings,
  parseGitLog,
  parseSha256File,
  scanPrivacy,
} from '../../scripts/lib/checks.mjs';

const join = (...parts: string[]) => parts.join('');

function goodPackage(): Record<string, unknown> {
  return {
    name: '@synchain/opentune-mcp',
    files: [...PACKED_FILES],
    bin: { ...BIN },
    scripts: { build: 'node scripts/build.mjs', test: 'vitest run' },
    devDependencies: { esbuild: '0.28.2', vitest: '5.0.3', pre: '1.0.0-rc.1' },
  };
}

describe('checkPackageJson', () => {
  it('accepts the intended shape', () => {
    expect(checkPackageJson(goodPackage())).toEqual([]);
  });

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'])(
    'rejects a %s field, even an empty one',
    (field) => {
      expect(checkPackageJson({ ...goodPackage(), [field]: {} })).toEqual([
        `package.json must not have "${field}" (the bundle has no runtime dependencies)`,
      ]);
    },
  );

  it.each([
    'preinstall',
    'install',
    'postinstall',
    'prepare',
    'prepack',
    'postpack',
    'prepublishOnly',
    'publish',
    'postpublish',
  ])('rejects the lifecycle script %s', (name) => {
    const pkg = goodPackage();
    pkg.scripts = { ...(pkg.scripts as object), [name]: 'echo hi' };
    expect(checkPackageJson(pkg)).toEqual([`package.json must not define the lifecycle script "${name}"`]);
  });

  it.each(['^1.2.3', '~1.2.3', '>=1', '1.x', 'latest', '*'])('rejects the version range %s', (range) => {
    const pkg = goodPackage();
    pkg.devDependencies = { esbuild: range };
    expect(checkPackageJson(pkg)).toEqual([
      `devDependency esbuild must be pinned to an exact version (found "${range}")`,
    ]);
  });

  it('rejects any change to the files whitelist', () => {
    expect(checkPackageJson({ ...goodPackage(), files: [...PACKED_FILES, 'scripts'] })).toHaveLength(1);
    expect(checkPackageJson({ ...goodPackage(), files: PACKED_FILES.slice(1) })).toHaveLength(1);
    expect(checkPackageJson({ ...goodPackage(), files: ['dist', ...PACKED_FILES.slice(1)] })).toHaveLength(1);
  });

  it('rejects a different bin', () => {
    expect(checkPackageJson({ ...goodPackage(), bin: { 'opentune-mcp': 'dist/other.mjs' } })).toHaveLength(1);
  });
});

describe('checkLockfile', () => {
  it('accepts a root entry without dependencies', () => {
    expect(checkLockfile({ packages: { '': { name: 'x', devDependencies: {} } } })).toEqual([]);
  });

  it('rejects runtime dependencies in the root entry', () => {
    expect(checkLockfile({ packages: { '': { dependencies: { zod: '4.0.0' } } } })).toEqual([
      'package-lock.json root entry must not have "dependencies"',
    ]);
  });

  it('rejects a lockfile without a root entry', () => {
    expect(checkLockfile({})).toHaveLength(1);
  });
});

describe('checkPackList', () => {
  const packed = (paths: string[]) => [{ files: paths.map((path) => ({ path, size: 1, mode: 420 })) }];

  it('accepts exactly the whitelist plus package.json', () => {
    expect(checkPackList(packed([...PACKED_FILES, 'package.json']))).toEqual([]);
  });

  it('reports extra and missing files', () => {
    expect(checkPackList(packed([...PACKED_FILES, 'package.json', 'README.extra.md']))).toEqual([
      'packed but not whitelisted: README.extra.md',
    ]);
    expect(checkPackList(packed(['package.json', ...PACKED_FILES.slice(1)]))).toEqual([
      'whitelisted but not packed: dist/opentune-mcp.mjs',
    ]);
  });

  it('rejects output without a file list', () => {
    expect(checkPackList({})).toEqual(['npm pack --dry-run --json returned no file list']);
  });
});

describe('checkBundleShape', () => {
  const good = {
    distFiles: ['opentune-mcp.mjs'],
    bundleText: '#!/usr/bin/env node\nimport process from "node:process";\n',
    imports: ['node:process'],
  };

  it('accepts a single shebang bundle that imports only node: built-ins', () => {
    expect(checkBundleShape(good)).toEqual([]);
  });

  it('rejects extra files in dist/', () => {
    expect(checkBundleShape({ ...good, distFiles: ['opentune-mcp.mjs', 'opentune-mcp.mjs.map'] })).toHaveLength(1);
  });

  it('rejects a missing shebang', () => {
    expect(checkBundleShape({ ...good, bundleText: 'import process from "node:process";\n' })).toHaveLength(1);
  });

  it.each(['zod', 'fs', '@modelcontextprotocol/server', './chunk.mjs'])('rejects the import %s', (spec) => {
    expect(checkBundleShape({ ...good, imports: ['node:process', spec] })).toEqual([
      `bundle imports a non-built-in module: ${JSON.stringify(spec)}`,
    ]);
  });

  it('rejects a require() left for the runtime shim', () => {
    const bundleText = `${good.bundleText}throw Error('Dynamic require of "' + x + '" is not supported');\n`;
    expect(checkBundleShape({ ...good, bundleText })).toHaveLength(1);
  });
});

describe('findStdoutConsoleCalls', () => {
  it('finds console methods that write to stdout', () => {
    expect(findStdoutConsoleCalls('a();\nconsole.log("x");\nconsole . info(1); console.table([])')).toEqual([
      'line 2: console.log',
      'line 3: console.info',
      'line 3: console.table',
    ]);
  });

  it('ignores console methods that write to stderr', () => {
    expect(findStdoutConsoleCalls('console.error(1); console.warn(2); console.trace(); console.assert(x)')).toEqual([]);
  });
});

describe('markdownHeadings / compareHeadingOutlines', () => {
  const en = [
    '# Title',
    '',
    '<!-- a comment',
    '# not a heading',
    '-->',
    '## Status',
    '```text',
    '# not a heading',
    '```',
    '### Deep',
    'Setext',
    '---',
  ].join('\n');

  it('reads ATX and setext headings, skipping code fences and HTML comments', () => {
    expect(markdownHeadings(en).map((h) => [h.level, h.text])).toEqual([
      [1, 'Title'],
      [2, 'Status'],
      [3, 'Deep'],
      [2, 'Setext'],
    ]);
  });

  it('accepts translated headings with the same outline', () => {
    const zh = ['# 标题', '## 状态', '### 深入', '## 第二节'].join('\n');
    expect(compareHeadingOutlines(en, zh)).toEqual([]);
  });

  it('rejects a different level, a missing heading or an extra heading', () => {
    expect(compareHeadingOutlines('# A\n## B\n', '# A\n### B\n')).toHaveLength(1);
    expect(compareHeadingOutlines('# A\n## B\n', '# A\n')).toHaveLength(2);
    expect(compareHeadingOutlines('# A\n', '# A\n## extra\n')).toHaveLength(2);
  });

  it('passes on the real READMEs', async () => {
    const { readFile } = await import('node:fs/promises');
    const read = (name: string) => readFile(new URL(`../../${name}`, import.meta.url), 'utf8');
    expect(compareHeadingOutlines(await read('README.md'), await read('README.zh-CN.md'))).toEqual([]);
  });
});

describe('findPullRequestTarget', () => {
  const event = join('pull_request', '_target');
  const wf = (text: string) => [{ path: '.github/workflows/x.yml', text }];

  it.each([
    [`on:\n  ${event}:\n    types: [opened]`],
    [`on: ${event}`],
    [`on: [push, ${event}]`],
    [`on:\n  - push\n  - ${event}`],
  ])('finds the event in %j', (text) => {
    expect(findPullRequestTarget(wf(text))).toHaveLength(1);
  });

  it('ignores comments and prose that mention the event', () => {
    expect(findPullRequestTarget(wf(`# never use ${event} here\non:\n  pull_request:\n    # ${event}: no`))).toEqual(
      [],
    );
  });
});

describe('scanPrivacy', () => {
  const name = join('al', 'ice');

  it.each([
    [join('C:', '\\', 'Users', '\\', name, '\\', 'repo')],
    [join('c:', '/', 'users', '/', name)],
    [join('"D:', '\\\\', 'Users', '\\\\', name, '\\\\x"')],
    [join('/', 'Users', '/', name, '/src')],
    [join('/', 'home', '/', name, '/.npm')],
    [join('file:///C:', '/', 'Users', '/', name, '/x')],
    [join('C:', '\\', 'Users', '\\', '用户甲', '\\', 'x')],
    [join('/', 'home', '/', '_', name)],
  ])('finds the personal path in %s', (text) => {
    expect(scanPrivacy(text, 'f')).toHaveLength(1);
  });

  it.each([
    ['C:\\Users\\<name>\\x'],
    ['%LOCALAPPDATA%\\OpenTune'],
    ['C:\\Users\\%USERNAME%\\x'],
    ['C:\\Users\\Public\\Music'],
    ['/home/runner/work/x'],
    ['/Users/Shared/x'],
    ['https://example.com/Users/someone/profile'],
    ['C:\\Music\\take1.wav'],
    ['C:/Users/.../AppData'],
    ['C:\\Users\\…\\AppData'],
    ['/home/.../.npm'],
  ])('accepts the neutral path %s', (text) => {
    expect(scanPrivacy(text, 'f')).toEqual([]);
  });

  it('accepts only the project e-mail addresses', () => {
    expect(
      scanPrivacy('contact@synchain.ca noreply@synchain.ca 140901583+DLsnows@users.noreply.github.com', 'f'),
    ).toEqual([]);
    const foreign = join(name, '@', 'example', '.com');
    expect(scanPrivacy(`mail ${foreign}`, 'f')).toEqual([`f:1: e-mail address "${foreign}" is not a project address`]);
  });

  it('does not mistake package specs for e-mail addresses', () => {
    expect(
      scanPrivacy('zod@4.6.5 @vitest/coverage-v8@5.0.3 https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz', 'f'),
    ).toEqual([]);
  });
});

describe('parseSha256File', () => {
  it('reads sha256sum lines', () => {
    const digest = 'a'.repeat(64);
    expect([...parseSha256File(`${digest}  scripts/x.mjs\n${digest.toUpperCase()} *y.txt\n`)]).toEqual([
      ['scripts/x.mjs', digest],
      ['y.txt', digest],
    ]);
  });

  it('rejects malformed lines', () => {
    expect(() => parseSha256File('not-a-digest  x\n')).toThrow(/malformed/);
  });
});

describe('parseGitLog / checkCommits', () => {
  const US = '\x1f';
  const RS = '\x1e';
  const PROJECT = 'noreply@synchain.ca';
  const GITHUB_NOREPLY = join('140901583+DLsnows', '@', 'users.noreply.github.com');
  const outsider = join('contributor', '@', 'example', '.org');
  const signoff = (email: string) => `Signed-off-by: Someone <${email}>`;
  const commit = (over: Partial<{ sha: string; parents: string[]; name: string; email: string; body: string }>) => ({
    sha: 'a'.repeat(40),
    parents: ['b'.repeat(40)],
    name: 'DLsnows',
    email: PROJECT,
    body: `chore: x\n\n${signoff(PROJECT)}`,
    ...over,
  });

  it('parses the git log records', () => {
    const text = `${'a'.repeat(40)}${US}${'b'.repeat(40)} ${'c'.repeat(40)}${US}Name${US}${PROJECT}${US}merge: y\n${RS}\n`;
    expect(parseGitLog(text)).toEqual([
      {
        sha: 'a'.repeat(40),
        parents: ['b'.repeat(40), 'c'.repeat(40)],
        name: 'Name',
        email: PROJECT,
        body: 'merge: y',
      },
    ]);
    expect(parseGitLog('')).toEqual([]);
  });

  it('accepts signed-off commits, including web squash merges signed off with another project address', () => {
    expect(checkCommits([commit({})])).toEqual([]);
    expect(checkCommits([commit({ email: GITHUB_NOREPLY })])).toEqual([]);
    expect(
      checkCommits([commit({ name: 'Contributor', email: outsider, body: `fix: y\n\n${signoff(outsider)}` })]),
    ).toEqual([]);
  });

  it('rejects a commit without a sign-off', () => {
    expect(checkCommits([commit({ body: 'chore: x' })])).toEqual([
      'commit aaaaaaaa: [missing-signoff] no Signed-off-by trailer (use git commit -s)',
    ]);
  });

  it('does not require a sign-off on merge commits', () => {
    expect(checkCommits([commit({ parents: ['b'.repeat(40), 'c'.repeat(40)], body: 'Merge x' })])).toEqual([]);
  });

  it("rejects an outside author's commit signed off by someone else", () => {
    const problems = checkCommits([
      commit({ name: 'Contributor', email: outsider, body: `fix: y\n\n${signoff(PROJECT)}` }),
    ]);
    expect(problems).toEqual([`commit aaaaaaaa: [signoff-identity] Signed-off-by email not allowed: ${PROJECT}`]);
  });

  it('rejects AI attribution trailers', () => {
    const trailer = join('Co-Authored', '-By: ', 'Cla', 'ude <', 'x', '@', 'example.invalid>');
    const problems = checkCommits([commit({ body: `chore: x\n\n${signoff(PROJECT)}\n${trailer}` })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^commit aaaaaaaa: \[co-authored-claude\]/);
  });

  it('rejects maintainer commits from an address that is not a project address', () => {
    const problems = checkCommits([commit({ email: outsider, body: `chore: x\n\n${signoff(outsider)}` })]);
    expect(problems).toEqual([`commit aaaaaaaa: DLsnows must commit as a project address, not ${outsider}`]);
  });
});
