// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { SERVER_NAME, VERSION } from '../version.js';
import { parseArgs } from './args.js';

/** Exit code for invalid command-line usage (same convention as most CLIs). */
export const EXIT_USAGE = 2;

export const USAGE = `Usage: ${SERVER_NAME} [--help | --version]

OpenTune MCP Server (by Synchain): a local MCP server that lets AI agents
operate OpenTune Standalone. MCP clients start it with no arguments; it then
serves MCP over stdio (standard input and output) until its input is closed.

Options:
  -h, --help     Print this help and exit.
  --version      Print the version and exit.

Documentation: https://github.com/synchain-oss/opentune-mcp-server#readme
`;

export interface CliDeps {
  /** CLI output (help, version). Only called for subcommands that do not serve MCP. */
  readonly writeStdout: (text: string) => void;
  /** Diagnostics. */
  readonly writeStderr: (text: string) => void;
  /** Starts the MCP stdio server; the process then lives as long as the connection. */
  readonly serve: () => void;
}

/**
 * Runs the command selected by `argv`. Returns the exit code for commands that finish
 * immediately, or `undefined` once the server has been started.
 */
export function run(argv: readonly string[], deps: CliDeps): number | undefined {
  const command = parseArgs(argv);
  switch (command.kind) {
    case 'serve':
      deps.serve();
      return undefined;
    case 'version':
      deps.writeStdout(`${VERSION}\n`);
      return 0;
    case 'help':
      deps.writeStdout(USAGE);
      return 0;
    case 'usage-error':
      deps.writeStderr(`${SERVER_NAME}: ${command.message}\nRun '${SERVER_NAME} --help' for usage.\n`);
      return EXIT_USAGE;
  }
}
