// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger, stderrSink, toSingleLine } from '../../src/log.js';

function capture(level?: 'error' | 'warn' | 'info' | 'debug') {
  const lines: string[] = [];
  const logger = createLogger({ sink: (line) => lines.push(line), ...(level ? { level } : {}) });
  return { lines, logger };
}

describe('createLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes one prefixed line per call', () => {
    const { lines, logger } = capture();
    logger.error('boom');
    logger.warn('careful');
    logger.info('hello');
    expect(lines).toEqual(['opentune-mcp error: boom\n', 'opentune-mcp warn: careful\n', 'opentune-mcp info: hello\n']);
  });

  it('drops levels below the threshold (info by default)', () => {
    const { lines, logger } = capture();
    logger.debug('hidden');
    expect(lines).toEqual([]);
  });

  it('honours an explicit level', () => {
    const verbose = capture('debug');
    verbose.logger.debug('shown');
    expect(verbose.lines).toEqual(['opentune-mcp debug: shown\n']);

    const quiet = capture('error');
    quiet.logger.warn('hidden');
    quiet.logger.info('hidden');
    quiet.logger.error('shown');
    expect(quiet.lines).toEqual(['opentune-mcp error: shown\n']);
  });

  it('never lets a message span or forge lines', () => {
    const { lines, logger } = capture();
    logger.info('first\nopentune-mcp error: forged\r\u0007');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('opentune-mcp info: first\\u000aopentune-mcp error: forged\\u000d\\u0007\n');
  });

  it('defaults to stderr and never touches stdout', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    createLogger().info('to stderr');
    expect(err).toHaveBeenCalledExactlyOnceWith('opentune-mcp info: to stderr\n');
    expect(out).not.toHaveBeenCalled();
  });

  it('exposes the stderr sink used by the entry point', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stderrSink('raw line\n');
    expect(err).toHaveBeenCalledExactlyOnceWith('raw line\n');
  });
});

describe('toSingleLine', () => {
  it('leaves printable text, including non-ASCII, unchanged', () => {
    expect(toSingleLine('音高 ok — 100%')).toBe('音高 ok — 100%');
  });

  it('escapes C0 controls and DEL', () => {
    expect(toSingleLine('a\u0000b\u001fc\u007f')).toBe('a\\u0000b\\u001fc\\u007f');
  });
});
