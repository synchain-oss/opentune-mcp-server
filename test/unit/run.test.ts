// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXIT_USAGE, USAGE, run } from '../../src/cli/run.js';
import { writeCliStdout } from '../../src/cli/stdout.js';
import { SERVER_NAME, VERSION } from '../../src/version.js';

function harness() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const serve = vi.fn<() => void>();
  const deps = {
    writeStdout: (text: string) => {
      stdout.push(text);
    },
    writeStderr: (text: string) => {
      stderr.push(text);
    },
    serve,
  };
  return { stdout, stderr, serve, deps };
}

describe('run', () => {
  it('starts the server and returns no exit code when called without arguments', () => {
    const h = harness();
    expect(run([], h.deps)).toBeUndefined();
    expect(h.serve).toHaveBeenCalledOnce();
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toEqual([]);
  });

  it('prints the package version for --version without serving', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    const h = harness();
    expect(run(['--version'], h.deps)).toBe(0);
    expect(h.stdout).toEqual([`${pkg.version}\n`]);
    expect(VERSION).toBe(pkg.version);
    expect(h.serve).not.toHaveBeenCalled();
    expect(h.stderr).toEqual([]);
  });

  it('prints usage for --help without serving', () => {
    const h = harness();
    expect(run(['--help'], h.deps)).toBe(0);
    expect(h.stdout).toEqual([USAGE]);
    expect(USAGE).toContain(`Usage: ${SERVER_NAME} [--help | --version]`);
    expect(USAGE).toContain('--version');
    expect(h.serve).not.toHaveBeenCalled();
  });

  it('reports a usage error on stderr only and exits with the usage code', () => {
    const h = harness();
    expect(run(['--bogus'], h.deps)).toBe(EXIT_USAGE);
    expect(h.stdout).toEqual([]);
    expect(h.stderr.join('')).toBe(
      `${SERVER_NAME}: unknown argument "--bogus"\nRun '${SERVER_NAME} --help' for usage.\n`,
    );
    expect(h.serve).not.toHaveBeenCalled();
  });
});

describe('writeCliStdout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the text to process.stdout unchanged', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    writeCliStdout('0.0.0\n');
    expect(write).toHaveBeenCalledExactlyOnceWith('0.0.0\n');
  });
});
