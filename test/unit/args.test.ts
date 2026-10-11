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

  it('rejects an unknown argument next to --version', () => {
    expect(parseArgs(['--version', '--bogus'])).toEqual({ kind: 'usage-error', message: 'unknown argument "--bogus"' });
  });

  it('quotes the offending argument so control characters cannot reach the terminal raw', () => {
    const result = parseArgs(['\u001b[31mred\n']);
    expect(result).toEqual({ kind: 'usage-error', message: 'unknown argument "\\u001b[31mred\\n"' });
  });
});
