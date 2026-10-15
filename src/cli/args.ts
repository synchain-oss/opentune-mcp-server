// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { CLIENTS, isClientName, type ClientName } from './client-config.js';

/** What the process should do, decided from its command-line arguments. */
export type CliCommand =
  | { readonly kind: 'serve' }
  | { readonly kind: 'version' }
  | { readonly kind: 'help' }
  | { readonly kind: 'doctor'; readonly json: boolean }
  | { readonly kind: 'client-config'; readonly client: ClientName; readonly fullPaths: boolean }
  | { readonly kind: 'usage-error'; readonly message: string };

const HELP_FLAGS: ReadonlySet<string> = new Set(['--help', '-h']);
const VERSION_FLAG = '--version';

/**
 * Parses the arguments after the script path.
 *
 * - No arguments: serve MCP over stdio (how MCP clients launch the server).
 * - `--help` / `-h` anywhere: print usage, even next to other or unknown arguments.
 * - `--version`: print the version.
 * - `doctor [--json]`: check the set-up and print the results.
 * - `doctor --client <name> [--full-paths]`: print the configuration for an MCP client instead.
 * - Anything else: a usage error. Arguments are never ignored silently, so a mistyped flag
 *   cannot accidentally start the server.
 */
export function parseArgs(argv: readonly string[]): CliCommand {
  if (argv.length === 0) return { kind: 'serve' };
  if (argv.some((arg) => HELP_FLAGS.has(arg))) return { kind: 'help' };
  if (argv[0] === 'doctor') return parseDoctorArgs(argv.slice(1));
  const unknown = argv.find((arg) => arg !== VERSION_FLAG);
  if (unknown !== undefined) {
    return { kind: 'usage-error', message: `unknown argument ${JSON.stringify(unknown)}` };
  }
  return { kind: 'version' };
}

function parseDoctorArgs(args: readonly string[]): CliCommand {
  const usage = (message: string): CliCommand => ({ kind: 'usage-error', message });
  let json = false;
  let fullPaths = false;
  let client: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--json') json = true;
    else if (arg === '--full-paths') fullPaths = true;
    else if (arg === '--client') {
      client = args[++i];
      if (client === undefined) return usage('--client needs a value');
    } else if (arg.startsWith('--client=')) client = arg.slice('--client='.length);
    else return usage(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (client === undefined) {
    return fullPaths ? usage('--full-paths only applies with --client') : { kind: 'doctor', json };
  }
  if (!isClientName(client)) {
    return usage(`unknown client ${JSON.stringify(client)}; use one of ${CLIENTS.join(', ')}`);
  }
  if (json) return usage('--json does not apply with --client');
  return { kind: 'client-config', client, fullPaths };
}
