// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClientName } from '../../src/cli/client-config.js';
import { EXIT_USAGE, USAGE, run } from '../../src/cli/run.js';
import { writeCliStdout } from '../../src/cli/stdout.js';
import { SERVER_NAME, VERSION } from '../../src/version.js';

function harness() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const serve = vi.fn<() => void>();
  const doctor = vi.fn<(json: boolean) => Promise<number>>(() => Promise.resolve(1));
  const clientConfig = vi.fn<(client: ClientName, fullPaths: boolean) => number>(() => 0);
  const deps = {
    writeStdout: (text: string) => {
      stdout.push(text);
    },
    writeStderr: (text: string) => {
      stderr.push(text);
    },
    serve,
    doctor,
    clientConfig,
  };
  return { stdout, stderr, serve, doctor, clientConfig, deps };
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

  it('runs doctor, with or without --json, and returns its exit code', async () => {
    const h = harness();
    expect(await run(['doctor'], h.deps)).toBe(1);
    expect(await run(['doctor', '--json'], h.deps)).toBe(1);
    expect(h.doctor.mock.calls).toEqual([[false], [true]]);
    expect(h.serve).not.toHaveBeenCalled();
    expect(USAGE).toContain(`${SERVER_NAME} doctor [--json]`);
  });

  it('prints a client configuration without running the doctor checks', () => {
    const h = harness();
    expect(run(['doctor', '--client', 'cursor', '--full-paths'], h.deps)).toBe(0);
    expect(h.clientConfig.mock.calls).toEqual([['cursor', true]]);
    expect(h.doctor).not.toHaveBeenCalled();
    expect(h.serve).not.toHaveBeenCalled();
    expect(USAGE).toContain('doctor --client <claude-code|claude-desktop|cursor>');
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
