// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

/**
 * The only sanctioned stdout writer in src/. It is used by CLI subcommands (`--help`,
 * `--version`) that print and exit without starting the MCP server, so stdout is not carrying
 * protocol frames when it runs. Everything else logs through ../log.ts (stderr); eslint rejects
 * any other use of stdout or console output in src/.
 */
export function writeCliStdout(text: string): void {
  // eslint-disable-next-line no-restricted-syntax -- CLI subcommands that never serve MCP
  process.stdout.write(text);
}
