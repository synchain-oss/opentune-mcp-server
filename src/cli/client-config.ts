// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// `opentune-mcp doctor --client <name>`: prints the configuration that registers this server with
// an MCP client. It only prints; it never reads or writes a client's configuration file. Paths are
// shown with the home directory replaced by ~ unless the caller asks for full paths; the Claude Code
// command is the exception because it is run as printed.

import path from 'node:path';

import { OPENTUNE_PATH_ENV, configuredOpentunePath } from '../launch/config.js';
import { redactHome } from './doctor.js';

export const CLIENTS = ['claude-code', 'claude-desktop', 'cursor'] as const;
export type ClientName = (typeof CLIENTS)[number];

export const isClientName = (value: string): value is ClientName => (CLIENTS as readonly string[]).includes(value);

export interface ClientConfigDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** process.execPath: the node that runs this program. */
  readonly execPath: string;
  readonly version: string;
  /** Show real paths instead of replacing the home directory with ~. */
  readonly fullPaths: boolean;
}

const PACKAGE = '@synchain/opentune-mcp';
const SERVER_KEY = 'opentune';
const RELEASES = 'https://github.com/synchain-oss/opentune-mcp-server/releases';
const PATH_PLACEHOLDER = '<absolute path of the OpenTune executable>';

/** A GUI app on macOS only has the system directories on its PATH; node from anywhere else needs an absolute npx. */
const SYSTEM_NODE_DIR = /^\/usr(?:\/local)?\/bin\//;

interface ServerEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

function serverEntry(
  client: ClientName,
  deps: ClientConfigDeps,
  opentunePath: string,
  show: (p: string) => string,
): ServerEntry {
  const env: Record<string, string> = { [OPENTUNE_PATH_ENV]: opentunePath };
  if (deps.platform === 'win32') {
    // npx is a .cmd file there, which a client can only start through cmd.
    return { command: 'cmd', args: ['/c', 'npx', '-y', PACKAGE], env };
  }
  if (deps.platform === 'darwin' && client !== 'claude-code' && !SYSTEM_NODE_DIR.test(deps.execPath)) {
    // A GUI app does not read the shell profile, so node from Homebrew or a version manager is not on its PATH.
    const nodeDir = path.posix.dirname(deps.execPath);
    return {
      command: show(path.posix.join(nodeDir, 'npx')),
      args: ['-y', PACKAGE],
      env: { PATH: `${show(nodeDir)}:/usr/local/bin:/usr/bin:/bin`, ...env },
    };
  }
  return { command: 'npx', args: ['-y', PACKAGE], env };
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

function desktopConfigPath(platform: NodeJS.Platform): string | null {
  if (platform === 'win32') return '%APPDATA%\\Claude\\claude_desktop_config.json';
  if (platform === 'darwin') return '~/Library/Application Support/Claude/claude_desktop_config.json';
  return null;
}

/** Quotes one argument for a POSIX-style or Windows shell line. */
const quote = (text: string) => (/^[\w@%+=:,./\\-]+$/.test(text) ? text : `"${text.replaceAll('"', '\\"')}"`);

export function formatClientConfig(client: ClientName, deps: ClientConfigDeps): string {
  const redactions: string[] = [];
  const show = (p: string) => {
    if (deps.fullPaths) return p;
    const shown = redactHome(p, deps.home, deps.platform);
    if (shown !== p) redactions.push(p);
    return shown;
  };
  // The Claude Code snippet is a shell command run as printed, and no shell expands ~ everywhere (cmd and
  // PowerShell never do), so it always shows real paths. It is printed only in the user's own terminal.
  const shownPath = client === 'claude-code' ? (p: string) => p : show;
  const configured = configuredOpentunePath(deps.env);
  const opentunePath = configured === undefined ? PATH_PLACEHOLDER : shownPath(configured);
  const entry = serverEntry(client, deps, opentunePath, shownPath);
  const mcpServers = json({
    mcpServers: { [SERVER_KEY]: { command: entry.command, args: entry.args, env: entry.env } },
  });
  const lines: string[] = [];

  if (client === 'claude-code') {
    // The name comes first: --env/-e take any number of values, so a name after them would be read as one.
    // On Windows, claude.cmd is named explicitly: in PowerShell, claude resolves to the npm-generated
    // claude.ps1, and PowerShell drops the lone -- before the program sees it.
    const envFlags = Object.entries(entry.env).map(([k, v]) => `-e ${k}=${quote(v)}`);
    const program = deps.platform === 'win32' ? 'claude.cmd' : 'claude';
    lines.push(
      'Claude Code: run this once in a terminal.',
      '',
      `  ${program} mcp add ${SERVER_KEY} --scope user ${envFlags.join(' ')} -- ${[entry.command, ...entry.args].join(' ')}`,
      '',
      '--scope user makes the server available in every project; leave it out to register it for the current project only.',
    );
    if (deps.platform === 'win32') {
      lines.push(
        '',
        'The command says claude.cmd on purpose: in PowerShell, claude runs claude.ps1, which swallows the -- and',
        'fails with "missing required argument". It works the same in cmd.',
      );
    }
  } else if (client === 'cursor') {
    lines.push(
      'Cursor: put this in ~/.cursor/mcp.json (all projects) or .cursor/mcp.json (one project).',
      '',
      mcpServers,
    );
  } else if (desktopConfigPath(deps.platform) === null) {
    return 'Claude Desktop is not available on this platform; use claude-code or cursor instead.\n\nNothing was written; this command only prints.\n';
  } else {
    const file = desktopConfigPath(deps.platform);
    const base = `${RELEASES}/download/v${deps.version}/opentune-mcp-${deps.version}`;
    lines.push(
      'Claude Desktop, recommended: install the MCPB package. It needs no Node.js setup of its own and asks for the',
      'OpenTune executable in a settings form.',
      '',
      `  1. Download ${base}.mcpb`,
      `     and ${base}.mcpb.sha256 (the expected sha256 of the package).`,
      '  2. Compare the checksum: sha256sum -c opentune-mcp-' +
        deps.version +
        '.mcpb.sha256   (Windows: certutil -hashfile <file> SHA256).',
      '  3. Open the .mcpb file, or drag it into Settings > Extensions, and choose Install.',
      '  4. In the extension settings, set "OpenTune executable" to a build of OpenTune with the control interface.',
      '',
      'Advanced: register the npm package by hand instead.',
      `  Add this to ${String(file)} (create the file if it does not exist), then restart Claude Desktop.`,
      '',
      mcpServers,
    );
  }
  if (entry.env[OPENTUNE_PATH_ENV] === PATH_PLACEHOLDER) {
    lines.push(
      '',
      `Replace ${PATH_PLACEHOLDER} with the real path (${OPENTUNE_PATH_ENV} is not set in this shell), or`,
      'leave the setting out to use only an OpenTune you have already started.',
    );
  }
  if (redactions.length > 0) {
    lines.push(
      '',
      'Paths are shown with ~ for your home directory, but neither a JSON configuration file nor every shell expands',
      '~, so write the full path there, or run this command again with --full-paths.',
    );
  }
  lines.push('', 'Nothing was written; this command only prints.');
  return `${lines.join('\n')}\n`;
}
