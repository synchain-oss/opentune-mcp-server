// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Each gate check must turn red on a planted violation, otherwise it proves nothing. Strings
// that the repository scanners look for (personal paths, foreign e-mail addresses) are
// assembled at runtime so that this file does not trip the scan it is testing.

import { describe, expect, it } from 'vitest';

import {
  AUDIO_EXTENSIONS,
  AUDIO_FIXTURE_DIR,
  AUDIO_SNIFF_BYTES,
  BIN,
  DEPENDABOT_EMAIL,
  DEPENDABOT_NAME,
  GIT_LOG_FORMAT,
  MAINTAINER_NAME,
  PACKED_FILES,
  WEB_MERGE_COMMITTER_EMAIL,
  WEB_MERGE_COMMITTER_NAME,
  audioKind,
  checkBranchRule,
  checkBundleShape,
  checkCommits,
  checkFrozenContract,
  checkLockfile,
  checkNoNewAudio,
  checkPackList,
  checkPackageJson,
  commitCheckScope,
  compareHeadingOutlines,
  findPullRequestTarget,
  findStdoutConsoleCalls,
  isContractChangeRecord,
  isDependabotCommit,
  markdownHeadings,
  parseGitLog,
  parseNameStatus,
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

  it('finds a call split across lines', () => {
    expect(findStdoutConsoleCalls('x();\nconsole\n  .log(1);')).toEqual(['line 2: console.log']);
  });

  it('finds bracket access with a string', () => {
    expect(findStdoutConsoleCalls(`console['log'](1);\nconsole[ "info" ](2); console[\`table\`]([])`)).toEqual([
      "line 1: console['log']",
      'line 2: console["info"]',
      'line 2: console[`table`]',
    ]);
  });

  it('finds methods destructured from console', () => {
    expect(
      findStdoutConsoleCalls(
        'const { log } = console;\nlet {\n  error,\n  debug: d,\n} = console;\nconst { dir }=console',
      ),
    ).toEqual(['line 1: { log } = console', 'line 2: { debug } = console', 'line 6: { dir } = console']);
  });

  it('ignores the stderr methods and unrelated code in the other forms', () => {
    expect(
      findStdoutConsoleCalls(
        "console['error'](1); console[\"warn\"](2); console['trace'](); const { error, warn, trace } = console;" +
          ' const { log } = logger; if ({ log } === console) {} const { info } = consoleLike; myconsole.log(1)',
      ),
    ).toEqual([]);
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
  const CONTACT = 'contact@synchain.ca';
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

  describe('names that go with the project addresses', () => {
    it('accepts a commit rebase-merged on the web: project author, GitHub as committer', () => {
      expect(
        checkCommits([commit({ committerName: WEB_MERGE_COMMITTER_NAME, committerEmail: WEB_MERGE_COMMITTER_EMAIL })]),
      ).toEqual([]);
    });

    it.each([
      [PROJECT, 'Someone'],
      [PROJECT, 'dlsnows'],
      [PROJECT, `${MAINTAINER_NAME} (laptop)`],
      [CONTACT, 'Someone'],
    ])('rejects the author %s under the name %j', (email, name) => {
      expect(checkCommits([commit({ name, email })])).toEqual([
        `commit aaaaaaaa: author "${name} <${email}>" uses a project address under a name other than DLsnows`,
      ]);
    });

    it.each([
      [PROJECT, 'Someone'],
      [PROJECT, 'DLSNOWS'],
      [CONTACT, 'Someone'],
    ])('rejects the committer %s under the name %j', (committerEmail, committerName) => {
      expect(checkCommits([commit({ committerName, committerEmail })])).toEqual([
        `commit aaaaaaaa: committer "${committerName} <${committerEmail}>" uses a project address` +
          ' under a name other than DLsnows',
      ]);
    });

    it("rejects GitHub's web-merge committer address under another name", () => {
      expect(
        checkCommits([
          commit({ email: GITHUB_NOREPLY, committerName: 'Someone', committerEmail: WEB_MERGE_COMMITTER_EMAIL }),
        ]),
      ).toEqual([
        `commit aaaaaaaa: committer "Someone <${WEB_MERGE_COMMITTER_EMAIL}>" uses GitHub's web-merge address` +
          ' under a name other than GitHub',
      ]);
    });
  });

  describe("the maintainer's GitHub noreply address", () => {
    it('is accepted as the author of a web merge only (committer GitHub)', () => {
      expect(
        checkCommits([
          commit({
            email: GITHUB_NOREPLY,
            committerName: WEB_MERGE_COMMITTER_NAME,
            committerEmail: WEB_MERGE_COMMITTER_EMAIL,
          }),
        ]),
      ).toEqual([]);
    });

    it('is rejected as the author of a local commit', () => {
      expect(checkCommits([commit({ email: GITHUB_NOREPLY })])).toEqual([
        `commit aaaaaaaa: author "DLsnows <${GITHUB_NOREPLY}>" is the GitHub noreply address, which only GitHub's` +
          ` web merge may record (committer "DLsnows <${PROJECT}>"); commit locally as DLsnows <${PROJECT}>`,
      ]);
    });

    it('is rejected as a committer', () => {
      expect(checkCommits([commit({ email: GITHUB_NOREPLY, committerEmail: GITHUB_NOREPLY })])).toEqual([
        `commit aaaaaaaa: author "DLsnows <${GITHUB_NOREPLY}>" is the GitHub noreply address, which only GitHub's` +
          ` web merge may record (committer "DLsnows <${GITHUB_NOREPLY}>"); commit locally as DLsnows <${PROJECT}>`,
        `commit aaaaaaaa: committer "DLsnows <${GITHUB_NOREPLY}>" is the GitHub noreply address, which no commit` +
          ` may use as committer (GitHub's web merge commits as GitHub); commit locally as DLsnows <${PROJECT}>`,
      ]);
      expect(checkCommits([commit({ committerEmail: GITHUB_NOREPLY })])).toHaveLength(1);
    });
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

    it.each(['DLsnows', 'dlsnows', 'DLSNOWS'])(
      'treats the name %j as the maintainer, who must use a project address',
      (name) => {
        expect(checkCommits([outsiderCommit({ name })], options)).toEqual([
          `commit aaaaaaaa: DLsnows must commit as a project address, not ${outsider}`,
          `commit aaaaaaaa: committer "Contributor <${outsider}>" is not a project address`,
          `commit aaaaaaaa message:3: e-mail address "${outsider}" is not a project address`,
        ]);
      },
    );

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

  describe('Dependabot commits', () => {
    // What GitHub writes for Dependabot: release notes that quote other people's addresses and an
    // upstream commit list with a co-author trailer, signed off by the bot's support address.
    const trailer = join('Co-Authored', '-By: ', 'Cla', 'ude <x', '@', 'example.com>');
    const bot = (over: Parameters<typeof commit>[0] = {}) =>
      commit({
        name: DEPENDABOT_NAME,
        email: DEPENDABOT_EMAIL,
        committerName: WEB_MERGE_COMMITTER_NAME,
        committerEmail: WEB_MERGE_COMMITTER_EMAIL,
        body: `chore(deps): bump x\n\nRelease notes by ${outsider}\n${trailer}\n\n${signoff(join('support', '@', 'github.com'))}`,
        ...over,
      });

    it('recognizes the bot as author, with GitHub or the bot as committer', () => {
      expect(isDependabotCommit(bot())).toBe(true);
      expect(isDependabotCommit(bot({ committerName: DEPENDABOT_NAME, committerEmail: DEPENDABOT_EMAIL }))).toBe(true);
      expect(isDependabotCommit(bot({ email: DEPENDABOT_EMAIL.toUpperCase() }))).toBe(true);
    });

    it.each([
      ['another name with the address', { name: 'dependabot' }],
      ['the name with another address', { email: outsider }],
      ['a committer that is neither GitHub nor the bot', { committerName: 'DLsnows', committerEmail: PROJECT }],
      ["GitHub's address under another committer name", { committerName: 'Someone' }],
    ])('does not recognize %s', (_label, over) => {
      expect(isDependabotCommit(bot(over))).toBe(false);
    });

    it('checks them like any other commit unless allowDependabot is set', () => {
      expect(checkCommits([bot()]).length).toBeGreaterThan(0);
      expect(checkCommits([bot()], { allowExternalAuthors: true }).length).toBeGreaterThan(0);
      expect(checkCommits([bot()], { allowDependabot: true })).toEqual([]);
    });

    it('still checks the other commits in the range when allowDependabot is set', () => {
      expect(checkCommits([bot(), commit({ body: 'chore: x' })], { allowDependabot: true })).toEqual([
        'commit aaaaaaaa: [missing-signoff] no Signed-off-by trailer (use git commit -s)',
      ]);
      // A commit that only borrows the bot's name is not exempt.
      expect(checkCommits([bot({ email: outsider })], { allowDependabot: true }).length).toBeGreaterThan(0);
    });
  });
});

describe('commitCheckScope', () => {
  const repo = 'synchain-oss/opentune-mcp-server';
  const sha = 'c'.repeat(40);

  it('checks the commits a push added, allowing merged contributions', () => {
    expect(commitCheckScope({ event: 'push', before: sha, defaultBranch: 'dev', repo })).toMatchObject({
      base: sha,
      allowExternalAuthors: true,
      allowDependabot: true,
    });
  });

  it('compares a push that creates a branch with the default branch', () => {
    expect(commitCheckScope({ event: 'push', before: '0'.repeat(40), defaultBranch: 'dev', repo })).toMatchObject({
      base: 'origin/dev',
    });
    expect(() => commitCheckScope({ event: 'push', before: '0'.repeat(40), repo })).toThrow(/default branch/);
  });

  it('refuses a push "before" that is not a commit SHA', () => {
    expect(() => commitCheckScope({ event: 'push', before: '--all', defaultBranch: 'dev', repo })).toThrow(/SHA/);
    expect(() =>
      commitCheckScope({ event: 'push', before: '--all', beforeAvailable: false, defaultBranch: 'dev', repo }),
    ).toThrow(/SHA/);
  });

  it('compares a push that rewrote its branch with the default branch', () => {
    const push = { event: 'push', before: sha, beforeAvailable: false, defaultBranch: 'dev', repo };
    const scope = commitCheckScope({ ...push, refName: 'feature/v2' });
    expect(scope).toMatchObject({ base: 'origin/dev', allowExternalAuthors: true, allowDependabot: true });
    expect(scope.reason).toContain('rewrote the branch');
  });

  it('refuses a push that rewrote the default branch, or a branch it cannot name', () => {
    const push = { event: 'push', before: sha, beforeAvailable: false, defaultBranch: 'dev', repo };
    expect(() => commitCheckScope({ ...push, refName: 'dev' })).toThrow(/rewrote the history of the default branch/);
    expect(() => commitCheckScope(push)).toThrow(/unknown branch/);
    expect(() => commitCheckScope({ ...push, refName: 'feature/v2', defaultBranch: '' })).toThrow(/default branch/);
  });

  it('holds a pull request from a branch of this repository to project identities', () => {
    expect(
      commitCheckScope({ event: 'pull_request', baseRef: 'feature/v1', repo, headRepo: repo, headRef: 'feat/x' }),
    ).toMatchObject({ base: 'origin/feature/v1', allowExternalAuthors: false, allowDependabot: false });
  });

  it("exempts Dependabot's commits only in Dependabot's own pull request", () => {
    const pr = { event: 'pull_request', baseRef: 'dev', repo, headRepo: repo, headRef: 'dependabot/npm_and_yarn/x' };
    expect(commitCheckScope({ ...pr, prAuthor: DEPENDABOT_NAME })).toMatchObject({
      allowExternalAuthors: false,
      allowDependabot: true,
    });
    // The branch name or the author alone is not enough.
    expect(commitCheckScope({ ...pr, prAuthor: 'DLsnows' })).toMatchObject({ allowDependabot: false });
    expect(commitCheckScope({ ...pr, headRef: 'feat/x', prAuthor: DEPENDABOT_NAME })).toMatchObject({
      allowDependabot: false,
    });
  });

  it('accepts signed-off outside authors from a fork, but never exempts Dependabot there', () => {
    expect(
      commitCheckScope({
        event: 'pull_request',
        baseRef: 'dev',
        repo,
        headRepo: 'someone/fork',
        headRef: 'dependabot/x',
        prAuthor: DEPENDABOT_NAME,
      }),
    ).toMatchObject({ base: 'origin/dev', allowExternalAuthors: true, allowDependabot: false });
    // A fork that was deleted has no head repository.
    expect(commitCheckScope({ event: 'pull_request', baseRef: 'dev', repo, headRef: 'x' })).toMatchObject({
      allowExternalAuthors: true,
    });
  });

  it("treats a pull request into prod as dev's already gated history", () => {
    expect(
      commitCheckScope({ event: 'pull_request', baseRef: 'prod', repo, headRepo: repo, headRef: 'dev' }),
    ).toMatchObject({ base: 'origin/prod', allowExternalAuthors: true, allowDependabot: true });
  });

  it('rejects other events and pull requests without a base', () => {
    expect(() => commitCheckScope({ event: 'workflow_dispatch', repo })).toThrow(/unsupported event/);
    expect(() => commitCheckScope({ event: 'pull_request', repo, headRepo: repo })).toThrow(/base/);
  });
});

describe('checkBranchRule', () => {
  const repo = 'synchain-oss/opentune-mcp-server';
  const fork = 'someone/opentune-mcp-server';

  it.each(['feat/M02-ci', 'feature/v1', 'dependabot/npm_and_yarn/zod-4.7.0'])(
    'lets the branch %s of this repository into dev',
    (headRef) => {
      expect(checkBranchRule({ baseRef: 'dev', headRef, headRepo: repo, repo })).toEqual([]);
    },
  );

  it.each(['main', 'fix/x', 'feat/', 'prod', 'features/x', 'my-feat/x'])(
    'keeps the branch %s of this repository out of dev',
    (headRef) => {
      expect(checkBranchRule({ baseRef: 'dev', headRef, headRepo: repo, repo })).toEqual([
        `only feat/*, feature/* or dependabot/* branches may be merged into dev (found "${headRef}")`,
      ]);
    },
  );

  it('lets only dev of this repository into prod', () => {
    expect(checkBranchRule({ baseRef: 'prod', headRef: 'dev', headRepo: repo, repo })).toEqual([]);
    expect(checkBranchRule({ baseRef: 'prod', headRef: 'feature/v1', headRepo: repo, repo })).toHaveLength(1);
    expect(checkBranchRule({ baseRef: 'prod', headRef: 'dev', headRepo: fork, repo })).toEqual([
      `only dev of ${repo} may be merged into prod (found ${fork}:dev)`,
    ]);
    expect(checkBranchRule({ baseRef: 'prod', headRef: 'dev', headRepo: '', repo })).toHaveLength(1);
  });

  it('lets a fork use any branch name except the long-lived ones', () => {
    expect(checkBranchRule({ baseRef: 'dev', headRef: 'fix-typo', headRepo: fork, repo })).toEqual([]);
    expect(checkBranchRule({ baseRef: 'dev', headRef: 'main', headRepo: fork, repo })).toEqual([]);
    for (const headRef of ['dev', 'prod', 'feature/v1', 'feature/v2']) {
      expect(checkBranchRule({ baseRef: 'dev', headRef, headRepo: fork, repo })).toEqual([
        `a pull request from a fork must not use the branch name "${headRef}" (reserved for long-lived branches)`,
      ]);
    }
  });

  it('has no rule for other bases', () => {
    expect(checkBranchRule({ baseRef: 'feature/v1', headRef: 'anything', headRepo: repo, repo })).toEqual([]);
  });
});

describe('contract change records and the frozen-contract guard', () => {
  it.each([
    ['docs/contract-changes/20261011-otcp-initial.md', true],
    ['docs/contract-changes/20240229-leap-day.md', true],
    ['docs/contract-changes/20261011-x.md', true],
    ['docs/contract-changes/20230229-not-a-leap-year.md', false],
    ['docs/contract-changes/20261301-bad-month.md', false],
    ['docs/contract-changes/20261032-bad-day.md', false],
    ['docs/contract-changes/2026101-short.md', false],
    ['docs/contract-changes/20261011-Upper.md', false],
    ['docs/contract-changes/20261011-double--hyphen.md', false],
    ['docs/contract-changes/20261011-.md', false],
    ['docs/contract-changes/20261011-slug.txt', false],
    ['docs/contract-changes/sub/20261011-slug.md', false],
    ['docs/20261011-slug.md', false],
  ])('%s is a record: %s', (path, expected) => {
    expect(isContractChangeRecord(path)).toBe(expected);
  });

  it('parses git diff --name-status -z output', () => {
    expect(parseNameStatus('M\0spec/a.md\0A\0docs/b c.md\0R100\0old.md\0new.md\0D\0x\0')).toEqual([
      { status: 'M', path: 'spec/a.md' },
      { status: 'A', path: 'docs/b c.md' },
      { status: 'R', path: 'old.md' },
      { status: 'R', path: 'new.md' },
      { status: 'D', path: 'x' },
    ]);
    expect(parseNameStatus('')).toEqual([]);
    expect(() => parseNameStatus('M\0')).toThrow(/malformed/);
    expect(() => parseNameStatus('spec/a.md\0M\0')).toThrow(/malformed/);
  });

  const record = { status: 'A', path: 'docs/contract-changes/20261011-add-method.md' };

  it('passes changes that touch no frozen file', () => {
    expect(
      checkFrozenContract([
        { status: 'M', path: 'src/server.ts' },
        { status: 'A', path: 'specs.md' },
      ]),
    ).toEqual([]);
    expect(checkFrozenContract([])).toEqual([]);
  });

  it.each([
    ['M', 'spec/otcp/v1/PROTOCOL.md'],
    ['A', 'spec/otcp/v1/methods/x.schema.json'],
    ['D', 'spec/otcp/v1/vectors/y.json'],
    ['M', 'test/golden/tools-list.json'],
    ['A', 'test/golden/instructions.txt'],
  ])('requires a record for %s %s', (status, path) => {
    expect(checkFrozenContract([{ status, path }])).toEqual([
      `1 frozen contract file(s) changed without a contract change record: ${path} (${status}); ` +
        'add docs/contract-changes/<YYYYMMDD>-<slug>.md to this pull request (CLAUDE.md §5)',
    ]);
    expect(checkFrozenContract([{ status, path }, record])).toEqual([]);
  });

  it('counts only a record added in this pull request, with a valid name', () => {
    const change = { status: 'M', path: 'spec/otcp/v1/PROTOCOL.md' };
    expect(checkFrozenContract([change, { ...record, status: 'M' }])).toHaveLength(1);
    expect(checkFrozenContract([change, { ...record, status: 'D' }])).toHaveLength(1);
    const misnamed = { status: 'A', path: 'docs/contract-changes/notes.md' };
    expect(checkFrozenContract([change, misnamed])).toEqual([
      expect.stringMatching(/^1 frozen contract file\(s\) changed/),
      'docs/contract-changes/notes.md does not count as a contract change record: the name must be ' +
        'docs/contract-changes/<YYYYMMDD>-<slug>.md (a real date, a lowercase slug)',
    ]);
  });

  it('does not treat look-alike paths as frozen', () => {
    expect(
      checkFrozenContract([
        { status: 'M', path: 'docs/spec/x.md' },
        { status: 'M', path: 'test/goldenfile.json' },
        { status: 'M', path: 'specification/x.md' },
      ]),
    ).toEqual([]);
  });
});

describe('audioKind / checkNoNewAudio', () => {
  /** Bytes from ASCII strings and byte arrays, in order. */
  const bytes = (...parts: (string | number[])[]) =>
    Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? Array.from(Buffer.from(p, 'latin1')) : p)));
  const wav = bytes('RIFF', [0x24, 0, 0, 0], 'WAVE');
  const source = bytes('import x fro');

  it('lists the common audio extensions', () => {
    expect(AUDIO_EXTENSIONS).toEqual(expect.arrayContaining(['.wav', '.flac', '.mp3', '.ogg', '.aiff', '.m4a']));
    expect(AUDIO_SNIFF_BYTES).toBeGreaterThanOrEqual(12);
  });

  it.each(['take1.wav', 'vocals/Lead.FLAC', 'a/b.mp3', 'x.m4a', 'x.aiff', 'x.ogg', 'x.opus', 'dir.wav/x.Wave'])(
    'treats %s as audio by its extension',
    (path) => {
      expect(audioKind(path, source)).toMatch(/^audio file extension \.[a-z0-9]+$/);
    },
  );

  it.each([
    ['WAV', wav],
    ['WAV', bytes('RF64', [0xff, 0xff, 0xff, 0xff], 'WAVE')],
    ['AIFF', bytes('FORM', [0, 0, 0, 0x2e], 'AIFF')],
    ['AIFF', bytes('FORM', [0, 0, 0, 0x2e], 'AIFC')],
    ['FLAC', bytes('fLaC', [0x00, 0, 0, 0x22])],
    ['FLAC', bytes('fLaC', [0x80, 0, 0, 0x22])],
    ['Ogg', bytes('OggS', [0, 2])],
    ['MP3 (ID3 tag)', bytes('ID3', [4, 0])],
    ['MPEG-4 audio', bytes([0, 0, 0, 0x20], 'ftypM4A ')],
    ['CAF', bytes('caff', [0, 1, 0, 0])],
    ['WavPack', bytes('wvpk', [0x20, 0, 0, 0])],
    ['AMR', bytes('#!AMR\n')],
    ['AMR', bytes('#!AMR-WB\n')],
    ['Sun audio', bytes('.snd', [0, 0, 0, 24])],
  ])('recognises %s data whatever the file is called', (format, head) => {
    expect(audioKind('renamed.dat', head)).toBe(`${format} data`);
  });

  it.each([
    ['README.md', bytes('# OpenTune M')],
    ['notes.txt', bytes('ID3 tags are')],
    ['notes.txt', bytes('OggS is the ')],
    ['notes.txt', bytes('fLaC streams')],
    ['notes.txt', bytes('caffeine is ')],
    ['notes.txt', bytes('.snd files a')],
    ['notes.txt', bytes('RIFF chunks ')],
    ['notes.txt', bytes('#!AMR is a f')],
    ['image.png', bytes([0x89], 'PNG\r\n', [0x1a, 0x0a])],
    ['video.mp4', bytes([0, 0, 0, 0x20], 'ftypisom')],
    ['src/wave.ts', source],
    ['wav', source],
    ['empty', new Uint8Array()],
  ])('does not treat %s (%j) as audio', (path, head) => {
    expect(audioKind(path, head)).toBeNull();
  });

  it(`allows new audio only under ${AUDIO_FIXTURE_DIR}`, () => {
    expect(
      checkNoNewAudio([
        { path: 'test/fixtures/vocals/take1.wav', head: wav },
        { path: 'test/fixtures/vocals/sub/take2.flac', head: bytes('fLaC', [0, 0, 0, 0x22]) },
        { path: 'src/server.ts', head: source },
      ]),
    ).toEqual([]);
    expect(checkNoNewAudio([])).toEqual([]);
  });

  it('reports new audio anywhere else, by extension or by signature', () => {
    expect(
      checkNoNewAudio([
        { path: 'test/fixtures/take1.wav', head: wav },
        { path: 'docs/sample.bin', head: wav },
      ]),
    ).toEqual([
      'test/fixtures/take1.wav: new audio file (audio file extension .wav); audio may only be added under ' +
        'test/fixtures/vocals/ (licensed test vocals)',
      'docs/sample.bin: new audio file (WAV data); audio may only be added under test/fixtures/vocals/ ' +
        '(licensed test vocals)',
    ]);
  });

  it('does not extend the exception to look-alike directories', () => {
    const lookAlikes = [
      'test/fixtures/vocals-extra/x.wav',
      'Test/Fixtures/Vocals/x.wav',
      'x/test/fixtures/vocals/y.wav',
    ];
    expect(checkNoNewAudio(lookAlikes.map((path) => ({ path, head: wav })))).toHaveLength(lookAlikes.length);
  });
});
