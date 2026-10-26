// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// CI checks that need the GitHub event context (.github/workflows/branch-gate.yml and ci.yml).
// The rules are the pure functions in scripts/lib/checks.mjs, unit-tested in
// test/unit/gate-checks.test.ts; this file only reads the context from environment variables,
// runs git and reports. Workflows pass the context through `env:`, never by expanding `${{ }}`
// inside a script. Needs only Node (no npm install): it imports nothing outside scripts/.
//
// Usage: node scripts/ci-checks.mjs <check>
//   scope    the commit range and identity rules of this event for the attribution check, printed
//            as base=…, exclude=… (space-separated refs; empty when nothing is left out),
//            allow_external_authors=…, allow_dependabot=… lines for $GITHUB_OUTPUT
//            (env: EVENT_NAME, BASE_REF, BEFORE, REF_NAME, DEFAULT_BRANCH, REPO, HEAD_REPO, HEAD_REF,
//            PR_AUTHOR). A ref the range leaves out must exist in the clone, else this fails.
//   branch   source branch rules of a pull request into dev or prod
//            (env: BASE_REF, HEAD_REF, HEAD_REPO, REPO)
//   commits  sign-off, attribution and identity of every commit in origin/<base>..HEAD of a pull
//            request, less the commits the scope leaves out
//            (env: as for scope; EVENT_NAME defaults to pull_request)
//   frozen   frozen-contract guard on the files changed since the merge base with origin/<base>
//            (env: BASE_REF)
// Exit status: 0 = pass, 1 = problems found, 2 = usage or context error.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GIT_LOG_FORMAT,
  checkBranchRule,
  checkCommits,
  checkFrozenContract,
  commitCheckScope,
  commitRange,
  parseGitLog,
  parseNameStatus,
} from './lib/checks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function log(message) {
  process.stderr.write(`${message}\n`);
}

function env(name, { required = true } = {}) {
  const value = process.env[name] ?? '';
  if (required && value === '') throw new Error(`environment variable ${name} is not set`);
  return value;
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** True when the commit is in this clone (`rev` must be a full SHA or a ref that commitCheckScope built). */
function commitExists(rev) {
  const result = spawnSync('git', ['cat-file', '-e', `${rev}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
  if (result.error) throw result.error;
  return result.status === 0;
}

function scopeFromEnv(defaultEvent) {
  const before = env('BEFORE', { required: false });
  // A push that rewrote its branch leaves `before` unreachable, so the full-history checkout does
  // not have it. Only a well-formed SHA reaches git; commitCheckScope rejects anything else.
  const beforeAvailable = /^[0-9a-f]{40}$/.test(before) && !/^0+$/.test(before) ? commitExists(before) : true;
  const scope = commitCheckScope({
    event: process.env.EVENT_NAME || defaultEvent,
    baseRef: env('BASE_REF', { required: false }),
    before,
    beforeAvailable,
    refName: env('REF_NAME', { required: false }),
    defaultBranch: env('DEFAULT_BRANCH', { required: false }),
    repo: env('REPO'),
    headRepo: env('HEAD_REPO', { required: false }),
    headRef: env('HEAD_REF', { required: false }),
    prAuthor: env('PR_AUTHOR', { required: false }),
  });
  // Fail closed: when the clone lacks a ref the range leaves out, say so, and never fall back to a
  // range without the exclusion.
  for (const ref of scope.exclude ?? []) {
    if (!commitExists(ref)) {
      throw new Error(
        `${ref} is not in this clone, so the commits already on the default branch cannot be left out of ` +
          `${scope.base}..HEAD; fetch it (actions/checkout with fetch-depth: 0, or git fetch origin)`,
      );
    }
  }
  return scope;
}

/** Prints the problems and returns the exit status. */
function report(title, problems, passNote) {
  if (problems.length === 0) {
    log(`${title}: PASS — ${passNote}`);
    return 0;
  }
  log(`${title}: FAIL`);
  for (const p of problems) log(`  - ${p}`);
  return 1;
}

const CHECKS = {
  scope() {
    const scope = scopeFromEnv('');
    log(`commit range ${commitRange(scope).join(' ')} — ${scope.reason}`);
    // `exclude` holds refs, which cannot contain spaces (git check-ref-format); the workflow splits it with `read -a`.
    process.stdout.write(
      `base=${scope.base}\nexclude=${(scope.exclude ?? []).join(' ')}\n` +
        `allow_external_authors=${String(scope.allowExternalAuthors)}\n` +
        `allow_dependabot=${String(scope.allowDependabot)}\n`,
    );
    return 0;
  },

  branch() {
    const pr = { baseRef: env('BASE_REF'), headRef: env('HEAD_REF'), headRepo: env('HEAD_REPO', { required: false }) };
    const repo = env('REPO');
    return report(
      'source branch',
      checkBranchRule({ ...pr, repo }),
      `${pr.headRepo || '(deleted repository)'}:${pr.headRef} -> ${pr.baseRef}`,
    );
  },

  commits() {
    const scope = scopeFromEnv('pull_request');
    log(`commit range ${commitRange(scope).join(' ')} — ${scope.reason}`);
    const commits = parseGitLog(git(['log', `--format=${GIT_LOG_FORMAT}`, ...commitRange(scope)]));
    const problems = checkCommits(commits, {
      allowExternalAuthors: scope.allowExternalAuthors,
      allowDependabot: scope.allowDependabot,
    });
    return report(
      'commits',
      problems,
      `${commits.length} commit(s): signed off (merge commits exempt), no AI attribution or personal data, ` +
        'author and committer identities as above',
    );
  },

  frozen() {
    const base = `origin/${env('BASE_REF')}`;
    // Against the merge base (three dots), so that changes on the base branch do not count; with
    // --no-renames a rename shows as the deletion of one path and the addition of the other.
    const changes = parseNameStatus(git(['diff', '--name-status', '--no-renames', '-z', `${base}...HEAD`]));
    return report(
      'frozen contract',
      checkFrozenContract(changes),
      `${changes.length} changed file(s); none frozen, or a contract change record is added`,
    );
  },
};

const name = process.argv[2] ?? '';
const check = Object.hasOwn(CHECKS, name) ? CHECKS[name] : undefined;
if (!check || process.argv.length > 3) {
  log(`usage: node scripts/ci-checks.mjs <${Object.keys(CHECKS).join(' | ')}>`);
  process.exitCode = 2;
} else {
  try {
    process.exitCode = check();
  } catch (error) {
    log(`ci-checks ${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
