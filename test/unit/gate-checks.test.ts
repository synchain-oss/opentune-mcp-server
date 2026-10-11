// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Each gate check must turn red on a planted violation, otherwise it proves nothing. Strings
// that the repository scanners look for (personal paths, foreign e-mail addresses) are
// assembled at runtime so that this file does not trip the scan it is testing.

import { describe, expect, it } from 'vitest';

import {
  BIN,
  GIT_LOG_FORMAT,
  PACKED_FILES,
  WEB_MERGE_COMMITTER_EMAIL,
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
    // Windows home directories as Git Bash / MSYS2, Cygwin and WSL print them.
    [join('/c', '/', 'Users', '/', name, '/repo')],
    [join('cd /C', '/', 'users', '/', name)],
    [join('/mnt/c', '/', 'Users', '/', name, '/x')],
    [join('"/cygdrive/d', '/', 'Users', '/', name, '"')],
    [join('file:///c', '/', 'Users', '/', name, '/x')],
    // A WSL distribution's home directory reached from Windows.
    [join('\\\\wsl$', '\\', 'Ubuntu', '\\', 'home', '\\', name, '\\x')],
    [join('"\\\\\\\\wsl.localhost', '\\\\', 'Debian', '\\\\', 'home', '\\\\', name, '"')],
    [join('//wsl$', '/', 'Ubuntu', '/', 'home', '/', name, '/x')],
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
    ['/c/Users/Public/Music'],
    ['/mnt/c/Users/<name>/x'],
    ['/mnt/d/Music/take1.wav'],
    ['https://example.com/c/Users/someone/profile'],
    ['\\\\wsl$\\Ubuntu\\home\\<name>\\x'],
    ['//wsl.localhost/Ubuntu/home/runner/x'],
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

  it('accepts further addresses only when the caller allows them', () => {
    const foreign = join(name, '@', 'example', '.com');
    expect(scanPrivacy(`mail ${foreign.toUpperCase()}`, 'f', { allowEmails: [foreign] })).toEqual([]);
    expect(scanPrivacy(`mail ${foreign}`, 'f', { allowEmails: [join('other', '@', 'example', '.com')] })).toHaveLength(
      1,
    );
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
  const commit = (
    over: Partial<{
      sha: string;
      parents: string[];
      name: string;
      email: string;
      committerName: string;
      committerEmail: string;
      body: string;
    }>,
  ) => ({
    sha: 'a'.repeat(40),
    parents: ['b'.repeat(40)],
    name: 'DLsnows',
    email: PROJECT,
    committerName: 'DLsnows',
    committerEmail: PROJECT,
    body: `chore: x\n\n${signoff(PROJECT)}`,
    ...over,
  });
  // An outside contributor's own commit, signed off and committed with their own address.
  const outsiderCommit = (over: Parameters<typeof commit>[0] = {}) =>
    commit({
      name: 'Contributor',
      email: outsider,
      committerName: 'Contributor',
      committerEmail: outsider,
      body: `fix: y\n\n${signoff(outsider)}`,
      ...over,
    });

  it('parses the git log records', () => {
    const text =
      `${'a'.repeat(40)}${US}${'b'.repeat(40)} ${'c'.repeat(40)}${US}Name${US}${PROJECT}` +
      `${US}GitHub${US}${WEB_MERGE_COMMITTER_EMAIL}${US}merge: y\n${RS}\n`;
    expect(parseGitLog(text)).toEqual([
      {
        sha: 'a'.repeat(40),
        parents: ['b'.repeat(40), 'c'.repeat(40)],
        name: 'Name',
        email: PROJECT,
        committerName: 'GitHub',
        committerEmail: WEB_MERGE_COMMITTER_EMAIL,
        body: 'merge: y',
      },
    ]);
    expect(parseGitLog('')).toEqual([]);
  });

  it('reads the fields that GIT_LOG_FORMAT asks git for, in that order', () => {
    expect(GIT_LOG_FORMAT).toBe('%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e');
  });

  it('accepts signed-off project commits, including web squash merges committed by GitHub', () => {
    expect(checkCommits([commit({})])).toEqual([]);
    expect(
      checkCommits([
        commit({ email: GITHUB_NOREPLY, committerName: 'GitHub', committerEmail: WEB_MERGE_COMMITTER_EMAIL }),
      ]),
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

  it('rejects AI attribution trailers', () => {
    const trailer = join('Co-Authored', '-By: ', 'Cla', 'ude');
    const problems = checkCommits([commit({ body: `chore: x\n\n${signoff(PROJECT)}\n${trailer}` })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^commit aaaaaaaa: \[co-authored-claude\]/);
  });

  it('rejects a commit made with a misconfigured identity, even when it is signed off consistently', () => {
    // A personal name and address from a global git config, signed off by that same address.
    expect(checkCommits([outsiderCommit()])).toEqual([
      `commit aaaaaaaa: author "Contributor <${outsider}>" is not a project address` +
        ' (commit as DLsnows <noreply@synchain.ca>; --allow-external-authors checks a contributor branch)',
      `commit aaaaaaaa: committer "Contributor <${outsider}>" is not a project address`,
      `commit aaaaaaaa message:3: e-mail address "${outsider}" is not a project address`,
    ]);
  });

  it('rejects maintainer commits from an address that is not a project address', () => {
    const problems = checkCommits([
      commit({ email: outsider, committerEmail: outsider, body: `chore: x\n\n${signoff(outsider)}` }),
    ]);
    expect(problems).toContain(`commit aaaaaaaa: DLsnows must commit as a project address, not ${outsider}`);
    // The maintainer's name never qualifies as an outside author.
    expect(
      checkCommits([commit({ email: outsider, committerEmail: outsider, body: `chore: x\n\n${signoff(outsider)}` })], {
        allowExternalAuthors: true,
      }),
    ).toEqual(problems);
  });

  it('rejects a project-authored commit whose committer is not a project address', () => {
    expect(checkCommits([commit({ committerName: 'Someone', committerEmail: outsider })])).toEqual([
      `commit aaaaaaaa: committer "Someone <${outsider}>" is not a project address`,
    ]);
  });

  it('rejects personal paths and foreign addresses in the commit message', () => {
    const home = join('C:', '\\', 'Users', '\\', 'al', 'ice');
    expect(checkCommits([commit({ body: `fix: crash in ${home}\\repo\n\n${signoff(PROJECT)}` })])).toEqual([
      `commit aaaaaaaa message:1: personal path "${home}"`,
    ]);
  });

  describe('with allowExternalAuthors (a contributor branch)', () => {
    const options = { allowExternalAuthors: true };

    it("accepts an outside author's commit signed off with their own address", () => {
      expect(checkCommits([outsiderCommit()], options)).toEqual([]);
      // ... also when the maintainer committed it (for example a cherry-pick).
      expect(checkCommits([outsiderCommit({ committerName: 'DLsnows', committerEmail: PROJECT })], options)).toEqual(
        [],
      );
    });

    it("rejects an outside author's commit signed off by someone else", () => {
      expect(checkCommits([outsiderCommit({ body: `fix: y\n\n${signoff(PROJECT)}` })], options)).toEqual([
        `commit aaaaaaaa: [signoff-identity] Signed-off-by email not allowed: ${PROJECT}`,
      ]);
    });

    it('rejects a committer who is neither the author nor a project address', () => {
      const third = join('third', '@', 'example', '.net');
      expect(checkCommits([outsiderCommit({ committerName: 'Third', committerEmail: third })], options)).toEqual([
        `commit aaaaaaaa: committer "Third <${third}>" is not a project address`,
      ]);
    });

    it("rejects other people's addresses in an outside author's message", () => {
      const third = join('third', '@', 'example', '.net');
      expect(
        checkCommits([outsiderCommit({ body: `fix: y (reported by ${third})\n\n${signoff(outsider)}` })], options),
      ).toEqual([`commit aaaaaaaa message:1: e-mail address "${third}" is not a project address`]);
    });
  });
});
