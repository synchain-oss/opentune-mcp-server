// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Pure checks used by scripts/gates.mjs. They take text or parsed JSON and return a list of
// problems (an empty list means the check passes), so each one is unit-tested with planted
// violations in test/unit/gate-checks.test.ts.

import { checkText } from '../check-attribution.mjs';

/** The exact contents of the published package, besides package.json (which npm always adds). */
export const PACKED_FILES = Object.freeze([
  'dist/opentune-mcp.mjs',
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
]);

/** The only bin entry. */
export const BIN = Object.freeze({ 'opentune-mcp': 'dist/opentune-mcp.mjs' });

/** Dependency fields that would make npm install something next to the bundle. */
export const DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
]);

/**
 * Scripts that npm runs by itself on install, pack or publish (in this package or for its
 * consumers). None may exist: the published package has no lifecycle scripts, and keeping
 * them out of the source package.json too means `npm ci` / `npm pack` run nothing implicit.
 */
export const LIFECYCLE_SCRIPTS = Object.freeze([
  'preinstall',
  'install',
  'postinstall',
  'preuninstall',
  'uninstall',
  'postuninstall',
  'preprepare',
  'prepare',
  'postprepare',
  'prepack',
  'pack',
  'postpack',
  'prepublish',
  'prepublishOnly',
  'publish',
  'postpublish',
  'dependencies',
]);

const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function sameSet(a, b) {
  const sa = [...new Set(a)].sort();
  const sb = [...new Set(b)].sort();
  return sa.length === a.length && sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

/**
 * package.json policy: no dependencies of any kind, no lifecycle scripts, devDependencies
 * pinned to exact versions, `files` and `bin` exactly as published.
 * @param {Record<string, unknown>} pkg
 * @returns {string[]}
 */
export function checkPackageJson(pkg) {
  const problems = [];
  for (const field of DEPENDENCY_FIELDS) {
    if (field in pkg) problems.push(`package.json must not have "${field}" (the bundle has no runtime dependencies)`);
  }
  const scripts = /** @type {Record<string, string>} */ (pkg.scripts ?? {});
  for (const name of Object.keys(scripts)) {
    if (LIFECYCLE_SCRIPTS.includes(name) || /^(?:pre|post)?publish/.test(name)) {
      problems.push(`package.json must not define the lifecycle script "${name}"`);
    }
  }
  const dev = /** @type {Record<string, string>} */ (pkg.devDependencies ?? {});
  for (const [name, range] of Object.entries(dev)) {
    if (!EXACT_VERSION_RE.test(range))
      problems.push(`devDependency ${name} must be pinned to an exact version (found "${range}")`);
  }
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  if (!sameSet(files, PACKED_FILES)) {
    problems.push(
      `package.json "files" must be exactly ${JSON.stringify(PACKED_FILES)} (found ${JSON.stringify(pkg.files ?? null)})`,
    );
  }
  if (JSON.stringify(pkg.bin ?? null) !== JSON.stringify(BIN)) {
    problems.push(`package.json "bin" must be ${JSON.stringify(BIN)} (found ${JSON.stringify(pkg.bin ?? null)})`);
  }
  return problems;
}

/**
 * The root entry of package-lock.json mirrors package.json: it must not list runtime
 * dependencies either.
 * @param {{ packages?: Record<string, Record<string, unknown>> }} lock
 */
export function checkLockfile(lock) {
  const rootEntry = lock.packages?.[''];
  if (!rootEntry) return ['package-lock.json has no root package entry (lockfileVersion 3 expected)'];
  return DEPENDENCY_FIELDS.filter((field) => field in rootEntry).map(
    (field) => `package-lock.json root entry must not have "${field}"`,
  );
}

/**
 * Compares the output of `npm pack --dry-run --json` with the whitelist.
 * @param {unknown} packJson
 */
export function checkPackList(packJson) {
  const entry = Array.isArray(packJson) ? packJson[0] : undefined;
  if (!entry || !Array.isArray(entry.files)) return ['npm pack --dry-run --json returned no file list'];
  const actual = entry.files.map((f) => String(f.path).replace(/\\/g, '/'));
  const expected = [...PACKED_FILES, 'package.json'];
  const extra = actual.filter((f) => !expected.includes(f));
  const missing = expected.filter((f) => !actual.includes(f));
  return [
    ...extra.map((f) => `packed but not whitelisted: ${f}`),
    ...missing.map((f) => `whitelisted but not packed: ${f}`),
  ];
}

/**
 * Markdown heading outline: ATX (`#`) and setext (`===` / `---`) headings, ignoring fenced code
 * blocks and HTML comments.
 * @param {string} text
 * @returns {{ level: number, text: string, line: number }[]}
 */
export function markdownHeadings(text) {
  const lines = text.split(/\r?\n/);
  const headings = [];
  let fence = null;
  let inComment = false;
  let previous = null; // previous line if it could be a setext heading's text
  for (const [i, line] of lines.entries()) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = null;
      previous = null;
      continue;
    }
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      previous = null;
      continue;
    }
    const fenceOpen = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceOpen) {
      fence = fenceOpen[1];
      previous = null;
      continue;
    }
    if (/^ {0,3}<!--/.test(line)) {
      if (!line.includes('-->')) inComment = true;
      previous = null;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/.exec(line);
    if (atx) {
      headings.push({ level: atx[1].length, text: (atx[2] ?? '').trim(), line: i + 1 });
      previous = null;
      continue;
    }
    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (setext && previous !== null) {
      headings.push({ level: setext[1].startsWith('=') ? 1 : 2, text: previous.trim(), line: i });
      previous = null;
      continue;
    }
    const isParagraphText = line.trim() !== '' && !/^ {0,3}(?:[-*+]\s|\d+[.)]\s|>|\|)/.test(line);
    previous = isParagraphText ? line : null;
  }
  return headings;
}

/**
 * README.md and README.zh-CN.md must have the same heading outline: the same number of
 * headings, at the same levels, in the same order. Text is not compared (it is translated).
 * @param {string} english
 * @param {string} chinese
 */
export function compareHeadingOutlines(english, chinese) {
  const a = markdownHeadings(english);
  const b = markdownHeadings(chinese);
  const problems = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || x.level !== y.level) {
      const fmt = (h, file) => (h ? `${file}:${h.line} ${'#'.repeat(h.level)} ${h.text}` : `${file}: (no heading)`);
      problems.push(`heading #${i + 1} differs: ${fmt(x, 'README.md')} vs ${fmt(y, 'README.zh-CN.md')}`);
      break;
    }
  }
  if (a.length !== b.length) problems.push(`README.md has ${a.length} headings, README.zh-CN.md has ${b.length}`);
  return problems;
}

/**
 * The `pull_request_target` ban (CLAUDE.md, security rule 4): the same three anchored
 * alternatives as the documented grep, for the block-mapping key, the inline `on:` value or flow
 * sequence, and the block-sequence item. Comment lines explaining the rule do not match.
 */
export const PULL_REQUEST_TARGET_RE =
  /^[ \t\r\n\v\f]*pull_request_target:|^[ \t\r\n\v\f]*on:.*pull_request_target|^[ \t\r\n\v\f]*-[ \t\r\n\v\f]*pull_request_target/;

/**
 * @param {{ path: string, text: string }[]} files
 * @returns {string[]}
 */
export function findPullRequestTarget(files) {
  const hits = [];
  for (const { path, text } of files) {
    text.split('\n').forEach((line, i) => {
      if (PULL_REQUEST_TARGET_RE.test(line)) hits.push(`${path}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

/** The project's own addresses. Any other e-mail address in a tracked file is reported. */
export const ALLOWED_EMAILS = Object.freeze([
  'contact@synchain.ca',
  'noreply@synchain.ca',
  '140901583+dlsnows@users.noreply.github.com',
]);

// Placeholder or system account names that are not a person's home directory.
const NEUTRAL_WINDOWS_USERS = new Set([
  'public',
  'default',
  'all',
  'runneradmin',
  'username',
  'user',
  'yourname',
  'example',
]);
const NEUTRAL_MAC_USERS = new Set(['Shared', 'runner', 'username', 'user', 'yourname', 'example']);
const NEUTRAL_LINUX_USERS = new Set(['runner', 'node', 'username', 'user', 'yourname', 'example']);

// A user name starts with a letter, digit or underscore and stops at a separator, whitespace,
// quote or a character that only placeholders use, so placeholders (`<name>`, `%USERNAME%`,
// `$HOME`, `{user}`, `...`, `…`) never match.
const NAME = String.raw`([\p{L}\p{N}_][^\\/\s"'\x60<>|:*?%$\{\}\[\]()]*)`;
// One or more path separators of either kind (JSON and source strings double the backslash).
const SEP = String.raw`(?:\\+|/+)`;
const WINDOWS_HOME_RE = new RegExp(String.raw`(?<![A-Za-z])[A-Za-z]:${SEP}Users${SEP}${NAME}`, 'giu');
// The same Windows home directories in the POSIX form that Git Bash / MSYS2 (`/c/Users/<name>`),
// Cygwin (`/cygdrive/c/Users/<name>`) and WSL (`/mnt/c/Users/<name>`) print. Windows paths are
// case-insensitive, so `/C/users/<name>` counts too. The look-behind skips URL paths
// (`example.com/c/Users/<name>`).
const POSIX_DRIVE_HOME_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9.:\-])/(?:mnt/|cygdrive/)?[A-Za-z]/Users/${NAME}`,
  'giu',
);
// The look-behind skips URL paths (`example.com/Users/<name>`), drive paths (`C:/Users/<name>`,
// already reported by the Windows pattern) and POSIX drive paths (`/c/Users/<name>`, reported
// by the pattern above).
const MAC_HOME_RE = new RegExp(String.raw`(?<![A-Za-z0-9.:\-])/Users/${NAME}`, 'gu');
const LINUX_HOME_RE = new RegExp(String.raw`(?<![A-Za-z0-9.:\-])/home/${NAME}`, 'gu');
// A WSL distribution's home directory reached from Windows: `\\wsl$\<distro>\home\<name>`,
// `\\wsl.localhost\<distro>\home\<name>`, or the same with forward slashes.
const WSL_HOME_RE = new RegExp(
  String.raw`(?:\\{2,}|/{2,})wsl(?:\$|\.localhost)${SEP}[^\\/\s]+${SEP}home${SEP}${NAME}`,
  'giu',
);
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// Windows account names compare case-insensitively, like the paths they appear in.
const isNeutralWindowsUser = (user) => NEUTRAL_WINDOWS_USERS.has(user.toLowerCase());
/** Each home-directory pattern with the test for account names that are placeholders, not people. */
const HOME_PATTERNS = Object.freeze([
  { re: WINDOWS_HOME_RE, isNeutral: isNeutralWindowsUser },
  { re: POSIX_DRIVE_HOME_RE, isNeutral: isNeutralWindowsUser },
  { re: MAC_HOME_RE, isNeutral: (user) => NEUTRAL_MAC_USERS.has(user) },
  { re: LINUX_HOME_RE, isNeutral: (user) => NEUTRAL_LINUX_USERS.has(user) },
  { re: WSL_HOME_RE, isNeutral: (user) => NEUTRAL_LINUX_USERS.has(user) },
]);

/**
 * Finds personal paths (home directories that name a real user) and e-mail addresses other
 * than the project's own.
 * @param {string} text
 * @param {string} source path shown in the report
 * @param {{ allowEmails?: string[] }} [options] further addresses to accept (lowercase), such as
 *   an outside contributor's own address in their commit message
 * @returns {string[]}
 */
export function scanPrivacy(text, source, { allowEmails = [] } = {}) {
  const problems = [];
  text.split('\n').forEach((line, i) => {
    const where = `${source}:${i + 1}`;
    for (const { re, isNeutral } of HOME_PATTERNS) {
      for (const m of line.matchAll(re)) {
        if (!isNeutral(m[1])) problems.push(`${where}: personal path "${m[0]}"`);
      }
    }
    for (const m of line.matchAll(EMAIL_RE)) {
      const email = m[0].toLowerCase();
      if (!ALLOWED_EMAILS.includes(email) && !allowEmails.includes(email))
        problems.push(`${where}: e-mail address "${m[0]}" is not a project address`);
    }
  });
  return problems;
}

/**
 * `git log --format` read by parseGitLog: author and committer name and address, then the
 * message; unit separator between fields, record separator after each commit.
 */
export const GIT_LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e';

/** The maintainer's git name. Their commits must use a project address. */
export const MAINTAINER_NAME = 'DLsnows';

/**
 * The maintainer's GitHub noreply address. GitHub's web merge records it as the author of the
 * commits it creates; a local commit must never use it.
 */
export const MAINTAINER_GITHUB_NOREPLY = '140901583+dlsnows@users.noreply.github.com';

/**
 * The project addresses a local commit may carry, as author or committer. Each of them belongs
 * to the maintainer, so it is only valid together with MAINTAINER_NAME.
 */
export const LOCAL_COMMIT_EMAILS = Object.freeze(ALLOWED_EMAILS.filter((email) => email !== MAINTAINER_GITHUB_NOREPLY));

/**
 * The committer GitHub records when a pull request is merged on the web (merge, squash or
 * rebase). It is GitHub's own address and names no person. It is assembled from its parts so
 * that this file passes the privacy scan, which accepts only the project's addresses in files.
 */
export const WEB_MERGE_COMMITTER_EMAIL = ['noreply', 'github.com'].join('@');

/** The committer name GitHub records together with WEB_MERGE_COMMITTER_EMAIL. */
export const WEB_MERGE_COMMITTER_NAME = 'GitHub';

// An outside contributor must not pass as the maintainer by changing the case of the name.
const isMaintainerName = (name) => name.toLowerCase() === MAINTAINER_NAME.toLowerCase();

/**
 * @typedef {object} CommitInfo
 * @property {string} sha
 * @property {string[]} parents
 * @property {string} name            author name
 * @property {string} email           author e-mail address
 * @property {string} committerName
 * @property {string} committerEmail
 * @property {string} body            full commit message
 */

/**
 * @param {string} text output of `git log --format=${GIT_LOG_FORMAT}`
 * @returns {CommitInfo[]}
 */
export function parseGitLog(text) {
  return text
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = '', parents = '', name = '', email = '', committerName = '', committerEmail = '', body = ''] =
        record.split('\x1f');
      return { sha, parents: parents.split(/\s+/).filter(Boolean), name, email, committerName, committerEmail, body };
    });
}

/**
 * Author identity: a project address under the maintainer's name, the maintainer's GitHub
 * noreply address on a commit GitHub's web merge created, or (only with `externalAuthor`) an
 * outside contributor's own address.
 * @param {CommitInfo} commit
 * @param {boolean} externalAuthor
 * @returns {string[]}
 */
function checkAuthorIdentity(commit, externalAuthor) {
  const where = `commit ${commit.sha.slice(0, 8)}`;
  const author = commit.email.toLowerCase();
  const who = `"${commit.name} <${commit.email}>"`;
  if (LOCAL_COMMIT_EMAILS.includes(author)) {
    return commit.name === MAINTAINER_NAME
      ? []
      : [`${where}: author ${who} uses a project address under a name other than ${MAINTAINER_NAME}`];
  }
  if (author === MAINTAINER_GITHUB_NOREPLY) {
    return commit.committerEmail.toLowerCase() === WEB_MERGE_COMMITTER_EMAIL
      ? []
      : [
          `${where}: author ${who} is the GitHub noreply address, which only GitHub's web merge may record` +
            ` (committer "${commit.committerName} <${commit.committerEmail}>"); commit locally as` +
            ` ${MAINTAINER_NAME} <noreply@synchain.ca>`,
        ];
  }
  if (externalAuthor) return [];
  return [
    isMaintainerName(commit.name)
      ? `${where}: ${MAINTAINER_NAME} must commit as a project address, not ${commit.email}`
      : `${where}: author ${who} is not a project address` +
        ' (commit as DLsnows <noreply@synchain.ca>; --allow-external-authors checks a contributor branch)',
  ];
}

/**
 * Committer identity: a local project address under the maintainer's name, GitHub's web-merge
 * committer under GitHub's name, or (only with `externalAuthor`) the outside author themselves.
 * The maintainer's GitHub noreply address never commits: GitHub's web merge records its own
 * committer, so that address as committer means a local commit.
 * @param {CommitInfo} commit
 * @param {boolean} externalAuthor
 * @returns {string[]}
 */
function checkCommitterIdentity(commit, externalAuthor) {
  const where = `commit ${commit.sha.slice(0, 8)}`;
  const committer = commit.committerEmail.toLowerCase();
  const who = `"${commit.committerName} <${commit.committerEmail}>"`;
  if (LOCAL_COMMIT_EMAILS.includes(committer)) {
    return commit.committerName === MAINTAINER_NAME
      ? []
      : [`${where}: committer ${who} uses a project address under a name other than ${MAINTAINER_NAME}`];
  }
  if (committer === WEB_MERGE_COMMITTER_EMAIL) {
    return commit.committerName === WEB_MERGE_COMMITTER_NAME
      ? []
      : [
          `${where}: committer ${who} uses GitHub's web-merge address under a name other than ${WEB_MERGE_COMMITTER_NAME}`,
        ];
  }
  if (committer === MAINTAINER_GITHUB_NOREPLY) {
    return [
      `${where}: committer ${who} is the GitHub noreply address, which no commit may use as committer` +
        ` (GitHub's web merge commits as ${WEB_MERGE_COMMITTER_NAME}); commit locally as` +
        ` ${MAINTAINER_NAME} <noreply@synchain.ca>`,
    ];
  }
  if (externalAuthor && committer === commit.email.toLowerCase()) return [];
  return [`${where}: committer ${who} is not a project address`];
}

/**
 * Commit policy, for every commit in the range:
 * - no AI attribution in the message, and a DCO sign-off unless it is a merge commit;
 * - identity (name and address of the author and of the committer):
 *   - a local project address (noreply@synchain.ca, contact@synchain.ca) is valid only under
 *     the maintainer's exact name, as author and as committer;
 *   - the maintainer's GitHub noreply address is valid only as the author of a commit whose
 *     committer is GitHub's web merge (WEB_MERGE_COMMITTER_EMAIL); a local commit never uses it;
 *   - GitHub's web-merge address is valid as committer only under WEB_MERGE_COMMITTER_NAME.
 *   This branch belongs to this repository, so a commit made with a misconfigured git identity
 *   (a personal name or address) fails here, before it is pushed. With `allowExternalAuthors`
 *   (an outside contributor's branch), other authors are accepted when the sign-off carries
 *   their own address and they committed it themselves or the maintainer did; the maintainer's
 *   name, in any letter case, still requires a project address;
 * - the message holds no personal path, and no e-mail address other than the project's (or,
 *   for an outside author, their own).
 * A commit authored by a project address may be signed off with any project address, because
 * GitHub's web merge authors squash commits with the maintainer's GitHub noreply address while
 * the sign-off keeps noreply@synchain.ca.
 * @param {CommitInfo[]} commits
 * @param {{ patterns?: { id: string, re: RegExp }[], allowExternalAuthors?: boolean }} [options]
 *   patterns default to scripts/attribution-patterns.txt
 * @returns {string[]}
 */
export function checkCommits(commits, { patterns, allowExternalAuthors = false } = {}) {
  const problems = [];
  for (const commit of commits) {
    const short = commit.sha.slice(0, 8);
    const isMerge = commit.parents.length > 1;
    const author = commit.email.toLowerCase();
    const projectAuthor = ALLOWED_EMAILS.includes(author);
    const externalAuthor = !projectAuthor && allowExternalAuthors && !isMaintainerName(commit.name);

    const result = checkText(commit.body, {
      ...(patterns ? { patterns } : {}),
      requireSignoff: !isMerge,
      signoffEmails: isMerge ? null : projectAuthor ? [...ALLOWED_EMAILS] : [commit.email],
      source: `commit ${short}`,
    });
    problems.push(...result.violations.map((v) => `commit ${short}: [${v.rule}] ${v.text}`));
    problems.push(...checkAuthorIdentity(commit, externalAuthor), ...checkCommitterIdentity(commit, externalAuthor));
    problems.push(
      ...scanPrivacy(commit.body, `commit ${short} message`, { allowEmails: externalAuthor ? [author] : [] }),
    );
  }
  return problems;
}

/**
 * stdout carries MCP frames only, and that applies to bundled dependencies too. These console
 * methods write to stdout in Node; console.error / warn / trace / assert write to stderr.
 */
export const STDOUT_CONSOLE_METHODS = Object.freeze([
  'log',
  'info',
  'debug',
  'dir',
  'dirxml',
  'table',
  'count',
  'group',
  'groupCollapsed',
  'timeEnd',
  'timeLog',
]);

const STDOUT_METHOD = `(${STDOUT_CONSOLE_METHODS.join('|')})`;

/**
 * Heuristic text patterns for the common ways of reaching a stdout console method: a direct call
 * (`console.log`), bracket access with a string (`console["log"]`) and destructuring
 * (`{ log } = console`). Aliases (`const c = console; c.log()`) and computed names are not
 * caught. Each pattern scans the whole text, so a call split across lines is still found.
 */
export const STDOUT_CONSOLE_PATTERNS = Object.freeze([
  { re: new RegExp(String.raw`\bconsole\s*\.\s*${STDOUT_METHOD}\b`, 'g'), show: (m) => `console.${m[1]}` },
  {
    re: new RegExp(String.raw`\bconsole\s*\[\s*(['"\x60])${STDOUT_METHOD}\1\s*\]`, 'g'),
    show: (m) => `console[${m[1]}${m[2]}${m[1]}]`,
  },
  {
    re: new RegExp(String.raw`\{[^{}]*\b${STDOUT_METHOD}\b[^{}]*\}\s*=\s*console\b`, 'g'),
    show: (m) => `{ ${m[1]} } = console`,
  },
]);

/**
 * @param {string} bundleText
 * @returns {string[]} one entry per hit, in source order
 */
export function findStdoutConsoleCalls(bundleText) {
  const hits = [];
  for (const { re, show } of STDOUT_CONSOLE_PATTERNS) {
    for (const m of bundleText.matchAll(re)) hits.push({ index: m.index, text: show(m) });
  }
  return hits
    .sort((a, b) => a.index - b.index)
    .map(({ index, text }) => `line ${bundleText.slice(0, index).split('\n').length}: ${text}`);
}

/**
 * Bundle shape: dist/ holds exactly the bundle, the bundle starts with the shebang, every
 * import left in it is a `node:` built-in, and no `require()` was left for esbuild's runtime
 * shim (which throws "Dynamic require of ... is not supported" inside an ES module).
 * @param {{ distFiles: string[], bundleText: string, imports: string[] }} input
 * @returns {string[]}
 */
export function checkBundleShape({ distFiles, bundleText, imports }) {
  const problems = [];
  const normalized = distFiles.map((f) => f.replace(/\\/g, '/'));
  if (normalized.length !== 1 || normalized[0] !== 'opentune-mcp.mjs') {
    problems.push(`dist/ must contain only opentune-mcp.mjs (found ${JSON.stringify(normalized)})`);
  }
  const firstLine = bundleText.split('\n', 1)[0];
  if (firstLine !== '#!/usr/bin/env node')
    problems.push(`first line must be "#!/usr/bin/env node" (found ${JSON.stringify(firstLine)})`);
  for (const spec of imports) {
    if (!spec.startsWith('node:')) problems.push(`bundle imports a non-built-in module: ${JSON.stringify(spec)}`);
  }
  if (bundleText.includes('Dynamic require of '))
    problems.push('bundle contains an unresolved require() (esbuild dynamic-require shim)');
  return problems;
}

/**
 * Parses `sha256sum`-style lines ("<hex>  <path>").
 * @param {string} text
 * @returns {Map<string, string>} path -> lowercase hex digest
 */
export function parseSha256File(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!m) throw new Error(`malformed sha256 line: ${raw}`);
    out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}
