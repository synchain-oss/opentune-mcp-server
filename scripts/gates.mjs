// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Local gates: `npm run gates`. Runs every check in order and prints a PASS / FAIL / SKIP table
// (Markdown, ready to paste into a pull request) for the current commit to stdout. Progress and
// tool output go to stderr. Exits 1 if any check fails.
//
// Usage: node scripts/gates.mjs [--base <ref>] [--only <names>] [--allow-external-authors]
//                               [--allow-dependabot] [--no-skip]
//   --base   branch the current branch will be merged into; the commits in <ref>..HEAD are
//            checked for attribution, sign-off and identity, and the files that are new since
//            the merge base, or added by a commit in the range and removed again, must not be
//            audio (default: origin/feature/v1)
//   --only   comma-separated, case-insensitive substrings of check names; runs just those checks
//            (for re-running one failure). A table from a partial run is not a gates result.
//   --allow-external-authors
//            accept commits authored by outside contributors (signed off with their own
//            address). Without it every author and committer must be a project address, which
//            is the rule for this repository's own branches.
//   --allow-dependabot
//            skip the commits Dependabot made (its pull requests, and dev's history once they are
//            merged); CI decides when this applies (scripts/ci-checks.mjs scope).
//   --no-skip
//            treat every SKIP row as a failure: the run exits 1 and names the skipped checks. CI
//            uses it where a check must actually run (a SKIP there means a tool was not installed).
//            Without it SKIP rows keep their reason and do not fail the run.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

import { checkText, loadPatterns } from './check-attribution.mjs';
import { sizeGate } from './lib/catalog.mjs';
import { checkNotices } from './gen-notices.mjs';
import { fetchTool } from './fetch-tool.mjs';
import {
  ALLOWED_EMAILS,
  AUDIO_FIXTURE_DIR,
  AUDIO_SNIFF_BYTES,
  GIT_LOG_FORMAT,
  addedInHistory,
  checkBundleShape,
  checkCommits,
  checkLockfile,
  checkNoNewAudio,
  checkPackageJson,
  checkPackList,
  compareHeadingOutlines,
  findPullRequestTarget,
  findStdoutConsoleCalls,
  parseGitLog,
  parseSha256File,
  scanPrivacy,
} from './lib/checks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE = 'origin/feature/v1';
const BUNDLE = 'dist/opentune-mcp.mjs';
const PATTERNS_FILE = 'scripts/attribution-patterns.txt';
const PATTERNS_SHA_FILE = 'scripts/attribution-patterns.sha256';

class Skip extends Error {}

// ---------------------------------------------------------------------------------------------
// process helpers

function log(message) {
  process.stderr.write(`${message}\n`);
}

/** Runs a command with its output streamed to stderr; returns the exit status. */
function runStreaming(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: ['ignore', 2, 2], ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Runs a command and captures stdout (stderr is streamed). */
function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 2],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout };
}

/** npm, invoked the same way whether gates runs under `npm run` or directly with node. */
function npmCommand(args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && /\.(?:c?js|mjs)$/.test(npmCli))
    return { command: process.execPath, args: [npmCli, ...args], shell: false };
  return { command: 'npm', args, shell: process.platform === 'win32' };
}

function npmStreaming(args, options = {}) {
  const npm = npmCommand(args);
  return runStreaming(npm.command, npm.args, { shell: npm.shell, ...options });
}

function npmCapture(args) {
  const npm = npmCommand(args);
  return runCapture(npm.command, npm.args, { shell: npm.shell });
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * The first `bytes` bytes of a blob (`<commit>:<path>`). The process is stopped once they have
 * arrived, so a large recording is not read whole.
 */
function gitBlobHead(spec, bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '-p', spec], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let total = 0;
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= bytes) child.kill();
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (total < bytes && code !== 0) reject(new Error(`git cat-file ${spec} failed: ${stderr.trim()}`));
      else resolve(Buffer.concat(chunks).subarray(0, bytes));
    });
  });
}

// ---------------------------------------------------------------------------------------------
// repository helpers

/** Files that are tracked or would be added (untracked but not ignored), and still exist. */
async function repoFiles() {
  const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const files = [];
  for (const file of [...new Set(listed)].sort()) {
    try {
      const stat = await fs.stat(path.join(ROOT, file));
      if (stat.isFile()) files.push(file);
    } catch {
      // deleted in the working tree
    }
  }
  return files;
}

/** Text content of each repository file; binary files (containing NUL) are skipped. */
async function repoTextFiles() {
  const out = [];
  for (const file of await repoFiles()) {
    const buf = await fs.readFile(path.join(ROOT, file));
    if (buf.includes(0)) continue;
    out.push({ path: file, text: buf.toString('utf8') });
  }
  return out;
}

async function sha256File(rel) {
  return createHash('sha256')
    .update(await fs.readFile(path.join(ROOT, rel)))
    .digest('hex');
}

function summarize(problems, limit = 5) {
  const head = problems.slice(0, limit).join('; ');
  return problems.length > limit ? `${head}; … (+${problems.length - limit} more)` : head;
}

function verdict(problems, passNote) {
  if (problems.length === 0) return { result: 'PASS', note: passNote };
  for (const p of problems) log(`  - ${p}`);
  return { result: 'FAIL', note: summarize(problems) };
}

function npmScriptStep(script, passNote) {
  return () => {
    const status = npmStreaming(['run', '--silent', script]);
    return status === 0
      ? { result: 'PASS', note: passNote }
      : { result: 'FAIL', note: `npm run ${script} exited with ${status}` };
  };
}

// ---------------------------------------------------------------------------------------------
// checks

async function bundleShape() {
  const distFiles = [];
  const walk = async (dir, prefix) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else distFiles.push(rel);
    }
  };
  await walk(path.join(ROOT, 'dist'), '');
  const bundleText = await fs.readFile(path.join(ROOT, BUNDLE), 'utf8').catch(() => '');
  if (!bundleText) return { result: 'FAIL', note: `${BUNDLE} is missing` };
  // Parse the emitted file itself and record every module specifier it still references
  // (static import, dynamic import, require); the bundle is not rebundled, only scanned.
  const imports = new Set();
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [BUNDLE],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [
      {
        name: 'collect-imports',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === 'entry-point') return undefined;
            imports.add(args.path);
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });
  const problems = checkBundleShape({ distFiles, bundleText, imports: [...imports] });
  return verdict(problems, `dist/ = ${BUNDLE} only; shebang; imports: ${[...imports].sort().join(', ') || 'none'}`);
}

async function bundleStdoutHygiene() {
  const bundleText = await fs.readFile(path.join(ROOT, BUNDLE), 'utf8').catch(() => '');
  if (!bundleText) return { result: 'FAIL', note: `${BUNDLE} is missing` };
  // A heuristic text scan, not a proof: it checks the common forms (direct call, bracket access,
  // destructuring) of the console methods that write to stdout; aliases are not followed.
  const hits = findStdoutConsoleCalls(bundleText);
  return verdict(
    hits.map((h) => `${BUNDLE} ${h}`),
    'heuristic scan of the whole bundle, bundled dependencies included: no stdout-writing console method ' +
      'reached directly (console.log), by bracket access (console["log"]) or by destructuring ({ log } = console)',
  );
}

function packList() {
  const { status, stdout } = npmCapture(['pack', '--dry-run', '--json', '--ignore-scripts']);
  if (status !== 0) return { result: 'FAIL', note: `npm pack --dry-run exited with ${status}` };
  const parsed = JSON.parse(stdout);
  const problems = checkPackList(parsed);
  const files = problems.length ? [] : parsed[0].files.map((f) => f.path).sort();
  return verdict(problems, `exactly the whitelist (${files.length} files): ${files.join(', ')}`);
}

async function packagePolicy() {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const problems = [...checkPackageJson(pkg), ...checkLockfile(lock)];
  return verdict(
    problems,
    `no dependencies, no lifecycle scripts, ${Object.keys(pkg.devDependencies ?? {}).length} devDependencies pinned exactly`,
  );
}

function audit() {
  // --audit-level=low: zero tolerance. The package ships no dependencies, so every advisory is
  // in the build and test toolchain, which runs on maintainer machines and in CI next to
  // release credentials.
  const status = npmStreaming(['audit', '--audit-level=low']);
  return status === 0
    ? { result: 'PASS', note: 'npm audit --audit-level=low (devDependencies included): 0 vulnerabilities' }
    : { result: 'FAIL', note: `npm audit --audit-level=low exited with ${status}` };
}

async function notices() {
  const result = await checkNotices(ROOT);
  if (!result.ok) return { result: 'FAIL', note: result.detail };
  return {
    result: 'PASS',
    note: `matches the bundle: ${result.packages.map((p) => `${p.name}@${p.version} (${p.license})`).join(', ')}`,
  };
}

async function gitleaks(base) {
  const tool = await fetchTool('gitleaks', { root: ROOT });
  const reportDir = path.join(ROOT, '.cache', 'gitleaks');
  const treeDir = path.join(reportDir, 'tree');
  await fs.rm(reportDir, { recursive: true, force: true });
  await fs.mkdir(treeDir, { recursive: true });
  // Working tree: copy the repository files (tracked + not ignored) so node_modules, dist and
  // caches are not scanned, then scan the copy.
  const files = await repoFiles();
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(treeDir, file)), { recursive: true });
    await fs.copyFile(path.join(ROOT, file), path.join(treeDir, file));
  }
  const common = ['--no-banner', '--no-color', '--redact', '--exit-code', '1', '--report-format', 'json'];
  const dirReport = path.join(reportDir, 'dir.json');
  const dirStatus = runStreaming(tool.path, ['dir', treeDir, ...common, '--report-path', dirReport]);
  // Branch commits: everything not yet on the base branch.
  const range = `${base}..HEAD`;
  const gitReport = path.join(reportDir, 'git.json');
  const gitStatus = runStreaming(tool.path, ['git', ROOT, ...common, '--log-opts', range, '--report-path', gitReport]);
  const findings = [];
  for (const [label, report] of [
    ['tree', dirReport],
    ['commits', gitReport],
  ]) {
    const parsed = JSON.parse(await fs.readFile(report, 'utf8').catch(() => '[]'));
    for (const f of parsed) {
      const file = String(f.File ?? '')
        .replaceAll('\\', '/')
        .replace(`${treeDir.replaceAll('\\', '/')}/`, '');
      findings.push(
        `${label}: ${file}:${f.StartLine} [${f.RuleID}]${f.Commit ? ` @${String(f.Commit).slice(0, 8)}` : ''}`,
      );
    }
  }
  await fs.rm(treeDir, { recursive: true, force: true });
  if (dirStatus > 1 || gitStatus > 1) findings.push(`gitleaks exited with ${dirStatus} (dir) / ${gitStatus} (git)`);
  if (findings.length === 0 && (dirStatus !== 0 || gitStatus !== 0))
    findings.push(`gitleaks exited with ${dirStatus} (dir) / ${gitStatus} (git)`);
  return verdict(
    findings,
    `gitleaks ${tool.version} (sha256 verified): ${files.length} files in the working tree, commits ${range}: no leaks`,
  );
}

async function privacy() {
  const files = await repoTextFiles();
  const problems = files.flatMap((f) => scanPrivacy(f.text, f.path));
  return verdict(
    problems,
    `${files.length} text files: no personal paths; e-mail addresses limited to ${ALLOWED_EMAILS.length} project addresses`,
  );
}

async function attribution(base, allowExternalAuthors, allowDependabot) {
  // 1. The checker and its pattern list are byte-identical copies of the maintainer's canonical
  //    files; the pinned digests detect any local edit.
  const pinned = parseSha256File(await fs.readFile(path.join(ROOT, PATTERNS_SHA_FILE), 'utf8'));
  const problems = [];
  for (const rel of ['scripts/check-attribution.mjs', PATTERNS_FILE]) {
    const expected = pinned.get(rel);
    const actual = await sha256File(rel).catch(() => null);
    if (!expected) problems.push(`${PATTERNS_SHA_FILE} has no digest for ${rel}`);
    else if (actual !== expected) problems.push(`${rel} sha256 ${actual ?? '(missing)'} != pinned ${expected}`);
  }
  if (problems.length) return verdict(problems, '');
  const patterns = loadPatterns(path.join(ROOT, PATTERNS_FILE));

  // 2. Commit messages and identities (author and committer) on this branch.
  const commits = parseGitLog(git(['log', `--format=${GIT_LOG_FORMAT}`, `${base}..HEAD`]));
  problems.push(...checkCommits(commits, { patterns, allowExternalAuthors, allowDependabot }));

  // 3. Repository text files (the pattern list itself is excluded: it contains the patterns).
  const files = (await repoTextFiles()).filter((f) => f.path !== PATTERNS_FILE);
  for (const f of files) {
    const result = checkText(f.text, { patterns, source: f.path });
    problems.push(...result.violations.map((v) => `${f.path}:${v.line}: [${v.rule}] ${v.text}`));
  }
  return verdict(
    problems,
    `checker sha256 pinned; ${commits.length} commits in ${base}..HEAD` +
      `${allowDependabot ? " (Dependabot's own commits exempt)" : ''}: signed off, ` +
      `${allowExternalAuthors ? 'project or signed-off outside' : 'project'} author and committer (name and address), ` +
      `no AI attribution or personal data in messages; ${files.length} text files clean`,
  );
}

async function noNewAudio(base) {
  // Against the merge base, like a pull request diff, and over the working tree (tracked and
  // untracked, not ignored), so that a recording is caught locally before it is committed.
  const mergeBase = git(['merge-base', base, 'HEAD']).trim();
  const atBase = new Set(git(['ls-tree', '-r', '-z', '--name-only', mergeBase]).split('\0').filter(Boolean));
  const added = [];
  for (const file of await repoFiles()) {
    if (atBase.has(file)) continue;
    const handle = await fs.open(path.join(ROOT, file), 'r');
    try {
      const head = Buffer.alloc(AUDIO_SNIFF_BYTES);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      added.push({ path: file, head: head.subarray(0, bytesRead) });
    } finally {
      await handle.close();
    }
  }
  // Also the files that a commit on this branch added and a later commit removed: the history
  // keeps them, and a merge commit or a push puts them on the branch for good.
  const headPaths = git(['ls-tree', '-r', '-z', '--name-only', 'HEAD']).split('\0').filter(Boolean);
  added.push(...(await addedInHistory(`${base}..HEAD`, { git, headPaths, blobHead: gitBlobHead })));
  return verdict(
    checkNoNewAudio(added),
    `${added.length} file(s) new since the merge base with ${base}, including those added and removed again ` +
      `in ${base}..HEAD: no audio (by extension or signature) outside ${AUDIO_FIXTURE_DIR}`,
  );
}

async function readmeParity() {
  const en = await fs.readFile(path.join(ROOT, 'README.md'), 'utf8');
  const zh = await fs.readFile(path.join(ROOT, 'README.zh-CN.md'), 'utf8');
  const problems = compareHeadingOutlines(en, zh);
  return verdict(problems, 'README.md and README.zh-CN.md have the same heading outline');
}

async function pullRequestTarget() {
  const dir = path.join(ROOT, '.github', 'workflows');
  const files = [];
  const walk = async (abs) => {
    for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
      const full = path.join(abs, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push({ path: path.relative(ROOT, full).replaceAll('\\', '/'), text: await fs.readFile(full, 'utf8') });
    }
  };
  try {
    await walk(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { result: 'PASS', note: 'no .github/workflows yet: zero hits' };
    throw error;
  }
  const hits = findPullRequestTarget(files);
  return verdict(hits, `${files.length} workflow files: zero hits`);
}

function reuseLint() {
  // The REUSE tool is a Python package and not an npm devDependency, so it runs only where it is
  // installed; the CI compliance job always installs and runs it.
  const result = spawnSync('reuse', ['lint'], { cwd: ROOT, stdio: ['ignore', 2, 2] });
  if (result.error?.code === 'ENOENT') {
    throw new Skip('reuse is not installed here (pipx install reuse); the CI compliance job runs it');
  }
  if (result.error) throw result.error;
  return result.status === 0
    ? { result: 'PASS', note: 'reuse lint: compliant' }
    : { result: 'FAIL', note: `reuse lint exited with ${result.status ?? 'a signal'}` };
}

async function contractVectors() {
  // The contract project runs every vector in spec/otcp/v1/vectors against the test mock and
  // writes its counts here; the vectors of the capabilities the mock reports must all pass, the
  // rest may be skipped.
  const summaryFile = path.join(ROOT, '.cache', 'contract', 'summary.json');
  await fs.rm(summaryFile, { force: true });
  const status = npmStreaming(['run', '--silent', 'test:contract'], {
    env: { ...process.env, OTCP_CONTRACT_SUMMARY: summaryFile },
  });
  const summary = JSON.parse(await fs.readFile(summaryFile, 'utf8').catch(() => 'null'));
  if (summary === null)
    return { result: 'FAIL', note: `npm run test:contract exited with ${status} and wrote no summary` };
  const skips = Object.entries(summary.skipReasons)
    .map(([reason, n]) => `${reason}: ${n}`)
    .join('; ');
  const note =
    `${summary.total} vectors: ${summary.pass} PASS (capabilities the mock reports: ${summary.required.pass} of ` +
    `${summary.required.total}), ${summary.fail} FAIL${summary.fail ? ` (${summary.failed.join(', ')})` : ''}, ` +
    `${summary.skip} SKIP${skips ? ` (${skips})` : ''}`;
  const ok = status === 0 && summary.fail === 0 && summary.required.pass === summary.required.total;
  return { result: ok ? 'PASS' : 'FAIL', note };
}

function notYet(reason) {
  return () => {
    throw new Skip(reason);
  };
}

// ---------------------------------------------------------------------------------------------
// main

const USAGE =
  'usage: node scripts/gates.mjs [--base <ref>] [--only <names>] [--allow-external-authors] [--allow-dependabot] [--no-skip]';

function parseArgs(argv) {
  const options = {
    base: DEFAULT_BASE,
    only: null,
    allowExternalAuthors: false,
    allowDependabot: false,
    noSkip: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base' && argv[i + 1]) options.base = argv[++i];
    else if (argv[i] === '--allow-external-authors') options.allowExternalAuthors = true;
    else if (argv[i] === '--allow-dependabot') options.allowDependabot = true;
    else if (argv[i] === '--no-skip') options.noSkip = true;
    else if (argv[i] === '--only' && argv[i + 1]) {
      options.only = argv[++i]
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    } else throw new Error(`unknown argument ${JSON.stringify(argv[i])}; ${USAGE}`);
  }
  return options;
}

async function main() {
  const { base, only, allowExternalAuthors, allowDependabot, noSkip } = parseArgs(process.argv.slice(2));
  try {
    git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  } catch {
    throw new Error(`base ref ${base} not found; fetch it (git fetch origin) or pass --base <ref>`);
  }

  const steps = [
    ['lint (eslint)', npmScriptStep('lint', 'eslint: 0 problems')],
    ['format:check (prettier)', npmScriptStep('format:check', 'prettier --check: all files formatted')],
    ['typecheck (tsc)', npmScriptStep('typecheck', 'tsc --noEmit: 0 errors')],
    ['unit tests + coverage (vitest)', npmScriptStep('test:unit', 'unit project passed; coverage thresholds met')],
    ['build (esbuild)', npmScriptStep('build', `${BUNDLE} built`)],
    ['bundle shape', bundleShape],
    ['bundle stdout hygiene', bundleStdoutHygiene],
    ['npm pack --dry-run', packList],
    ['package.json: no dependencies / lifecycle scripts', packagePolicy],
    ['npm audit', audit],
    ['THIRD-PARTY-NOTICES', notices],
    [
      'stdio smoke (initialize, tools/list)',
      npmScriptStep('test:stdio', 'bundle answers initialize and tools/list; stdout is JSON-RPC only; clean exit'),
    ],
    ['gitleaks', () => gitleaks(base)],
    ['privacy', privacy],
    ['no new audio files (outside test/fixtures/vocals/)', () => noNewAudio(base)],
    ['attribution, sign-off + identity', () => attribution(base, allowExternalAuthors, allowDependabot)],
    ['README en/zh-CN heading outline', readmeParity],
    ['no pull_request_target', pullRequestTarget],
    ['contract vectors (mock)', contractVectors],
    ['tools/list size gate', () => sizeGate(ROOT, BUNDLE)],
    ['token canary', notYet('not yet: no OTCP client or MCP tool output to check for the token')],
    ['output budget', notYet('not yet: no read tools, and the mock has no project content to read')],
    [
      'docs consistency',
      npmScriptStep(
        'test:catalog',
        'docs/reference.md and the golden snapshots match the tool registry; docs/TROUBLESHOOTING.md has a ' +
          'section for every error kind, status and doctor check',
      ),
    ],
    ['Inspector CLI --strict', notYet('not yet: no tools to validate')],
    ['reuse lint', reuseLint],
  ];

  const selected = only ? steps.filter(([name]) => only.some((s) => name.toLowerCase().includes(s))) : steps;
  if (selected.length === 0) throw new Error(`--only ${only.join(',')} matches no check`);

  const rows = [];
  for (const [name, fn] of selected) {
    log(`\n=== ${name}`);
    const started = Date.now();
    let row;
    try {
      row = await fn();
    } catch (error) {
      row =
        error instanceof Skip
          ? { result: 'SKIP', note: error.message }
          : { result: 'FAIL', note: error instanceof Error ? error.message : String(error) };
    }
    log(
      `=== ${name}: ${row.result} (${((Date.now() - started) / 1000).toFixed(1)} s)${row.note ? ` — ${row.note}` : ''}`,
    );
    rows.push({ name, ...row });
  }

  const sha = git(['rev-parse', 'HEAD']).trim();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const dirty = git(['status', '--porcelain']).trim() !== '';
  const failed = rows.filter((r) => r.result === 'FAIL').length;
  const skipped = rows.filter((r) => r.result === 'SKIP').map((r) => r.name);
  const skipFailure = noSkip && skipped.length > 0;
  let verdictLine = 'All checks passed (SKIP rows give their reason).';
  if (failed) verdictLine = `**${failed} check(s) failed.**`;
  else if (skipFailure)
    verdictLine = `**--no-skip: ${skipped.length} check(s) skipped, which counts as a failure: ${skipped.join('; ')}.**`;
  if (skipFailure) log(`gates: --no-skip: ${skipped.length} check(s) skipped: ${skipped.join('; ')}`);
  const cell = (s) => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const partial = selected.length < steps.length ? ` (partial run: ${selected.length} of ${steps.length} checks)` : '';
  const table = [
    `### Local gates: \`${sha}\`${dirty ? ' (with uncommitted changes)' : ''}${partial}`,
    '',
    `Branch \`${branch}\`, base \`${base}\`${allowExternalAuthors ? ', outside authors allowed' : ''}` +
      `${allowDependabot ? ", Dependabot's commits exempt" : ''}; ` +
      `Node ${process.version}, ${process.platform}-${process.arch}.`,
    '',
    '| Check | Result | Notes |',
    '| --- | --- | --- |',
    ...rows.map((r) => `| ${cell(r.name)} | ${r.result} | ${cell(r.note)} |`),
    '',
    verdictLine,
    '',
  ].join('\n');
  process.stdout.write(`\n${table}`);
  process.exitCode = failed || skipFailure ? 1 : 0;
}

try {
  await main();
} catch (error) {
  log(`gates: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
