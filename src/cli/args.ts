// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

/** What the process should do, decided from its command-line arguments. */
export type CliCommand =
  | { readonly kind: 'serve' }
  | { readonly kind: 'version' }
  | { readonly kind: 'help' }
  | { readonly kind: 'usage-error'; readonly message: string };

const HELP_FLAGS: ReadonlySet<string> = new Set(['--help', '-h']);
const VERSION_FLAG = '--version';

/**
 * Parses the arguments after the script path.
 *
 * - No arguments: serve MCP over stdio (how MCP clients launch the server).
 * - `--help` / `-h` anywhere: print usage, even next to other or unknown arguments.
 * - `--version`: print the version.
 * - Anything else: a usage error. Arguments are never ignored silently, so a mistyped flag
 *   cannot accidentally start the server.
 */
export function parseArgs(argv: readonly string[]): CliCommand {
  if (argv.length === 0) return { kind: 'serve' };
  if (argv.some((arg) => HELP_FLAGS.has(arg))) return { kind: 'help' };
  const unknown = argv.find((arg) => arg !== VERSION_FLAG);
  if (unknown !== undefined) {
    return { kind: 'usage-error', message: `unknown argument ${JSON.stringify(unknown)}` };
  }
  return { kind: 'version' };
}
