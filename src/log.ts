// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { SERVER_NAME } from './version.js';

/**
 * Minimal logger. Everything goes to stderr: on stdio, stdout carries MCP protocol frames and
 * nothing else, so a stray log line there would corrupt the client connection.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Receives one complete, newline-terminated log line. */
export type LogSink = (line: string) => void;

export interface Logger {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

export interface LoggerOptions {
  /** Where lines go. Defaults to stderr. */
  sink?: LogSink;
  /** Least severe level that is written. Defaults to `info`. */
  level?: LogLevel;
}

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { error: 0, warn: 1, info: 2, debug: 3 };

export const stderrSink: LogSink = (line) => {
  process.stderr.write(line);
};

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Escapes control characters (including CR and LF) so that one call always produces exactly
 * one line, whatever the message contains.
 */
export function toSingleLine(message: string): string {
  return message.replace(CONTROL_CHARS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? stderrSink;
  const threshold = LEVEL_RANK[options.level ?? 'info'];
  const emit = (level: LogLevel, message: string): void => {
    if (LEVEL_RANK[level] > threshold) return;
    sink(`${SERVER_NAME} ${level}: ${toSingleLine(message)}\n`);
  };
  return {
    error: (message) => {
      emit('error', message);
    },
    warn: (message) => {
      emit('warn', message);
    },
    info: (message) => {
      emit('info', message);
    },
    debug: (message) => {
      emit('debug', message);
    },
  };
}
