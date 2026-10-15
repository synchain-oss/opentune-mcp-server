// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { parseArgs } from '../../src/cli/args.js';

describe('parseArgs', () => {
  it('serves MCP over stdio when there are no arguments', () => {
    expect(parseArgs([])).toEqual({ kind: 'serve' });
  });

  it('recognises --version', () => {
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseArgs(['--version', '--version'])).toEqual({ kind: 'version' });
  });

  it.each([['--help'], ['-h']])('recognises %s', (flag) => {
    expect(parseArgs([flag])).toEqual({ kind: 'help' });
  });

  it('prefers help over everything else, including unknown arguments', () => {
    expect(parseArgs(['--version', '--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['--bogus', '-h'])).toEqual({ kind: 'help' });
  });

  it.each([['--bogus'], ['-v'], ['serve'], ['--VERSION'], ['']])('rejects %j instead of ignoring it', (arg) => {
    expect(parseArgs([arg])).toEqual({ kind: 'usage-error', message: `unknown argument ${JSON.stringify(arg)}` });
  });

  it('recognises doctor and its --json flag, and nothing else after it', () => {
    expect(parseArgs(['doctor'])).toEqual({ kind: 'doctor', json: false });
    expect(parseArgs(['doctor', '--json'])).toEqual({ kind: 'doctor', json: true });
    expect(parseArgs(['doctor', '--bogus'])).toEqual({ kind: 'usage-error', message: 'unknown argument "--bogus"' });
    expect(parseArgs(['--json'])).toEqual({ kind: 'usage-error', message: 'unknown argument "--json"' });
    expect(parseArgs(['doctor', '-h'])).toEqual({ kind: 'help' });
  });

  it('recognises doctor --client with an optional --full-paths', () => {
    expect(parseArgs(['doctor', '--client', 'cursor'])).toEqual({
      kind: 'client-config',
      client: 'cursor',
      fullPaths: false,
    });
    expect(parseArgs(['doctor', '--client=claude-desktop', '--full-paths'])).toEqual({
      kind: 'client-config',
      client: 'claude-desktop',
      fullPaths: true,
    });
    expect(parseArgs(['doctor', '--full-paths', '--client', 'claude-code'])).toEqual({
      kind: 'client-config',
      client: 'claude-code',
      fullPaths: true,
    });
  });

  it.each([
    [['doctor', '--client'], '--client needs a value'],
    [['doctor', '--client', 'vscode'], 'unknown client "vscode"; use one of claude-code, claude-desktop, cursor'],
    [['doctor', '--client='], 'unknown client ""; use one of claude-code, claude-desktop, cursor'],
    [['doctor', '--client', 'cursor', '--json'], '--json does not apply with --client'],
    [['doctor', '--full-paths'], '--full-paths only applies with --client'],
  ])('rejects %j', (argv, message) => {
    expect(parseArgs(argv)).toEqual({ kind: 'usage-error', message });
  });

  it('rejects an unknown argument next to --version', () => {
    expect(parseArgs(['--version', '--bogus'])).toEqual({ kind: 'usage-error', message: 'unknown argument "--bogus"' });
  });

  it('quotes the offending argument so control characters cannot reach the terminal raw', () => {
    const result = parseArgs(['\u001b[31mred\n']);
    expect(result).toEqual({ kind: 'usage-error', message: 'unknown argument "\\u001b[31mred\\n"' });
  });
});
