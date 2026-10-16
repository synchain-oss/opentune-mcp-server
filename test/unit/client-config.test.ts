// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { CLIENTS, formatClientConfig, isClientName, type ClientConfigDeps } from '../../src/cli/client-config.js';

const WIN: ClientConfigDeps = {
  env: { OPENTUNE_MCP_OPENTUNE_PATH: String.raw`C:\Users\user\Apps\OpenTune\OpenTune.exe` },
  platform: 'win32',
  home: String.raw`C:\Users\user`,
  execPath: String.raw`C:\Program Files\nodejs\node.exe`,
  version: '1.2.3',
  fullPaths: false,
};
const MAC_NVM: ClientConfigDeps = {
  env: { OPENTUNE_MCP_OPENTUNE_PATH: '/Applications/OpenTune.app/Contents/MacOS/OpenTune' },
  platform: 'darwin',
  home: '/Users/user',
  execPath: '/Users/user/.nvm/versions/node/v22.12.0/bin/node',
  version: '1.2.3',
  fullPaths: false,
};
const LINUX_UNSET: ClientConfigDeps = {
  env: {},
  platform: 'linux',
  home: '/home/user',
  execPath: '/usr/bin/node',
  version: '1.2.3',
  fullPaths: false,
};

const golden = (name: string) => `../golden/client-config/${name}.txt`;

describe('formatClientConfig (golden snippets)', () => {
  it.each([
    ['claude-code-win32', 'claude-code', WIN],
    ['claude-code-linux-unset', 'claude-code', LINUX_UNSET],
    ['claude-code-darwin-nvm', 'claude-code', MAC_NVM],
    ['claude-desktop-win32', 'claude-desktop', WIN],
    ['claude-desktop-darwin-nvm', 'claude-desktop', MAC_NVM],
    ['claude-desktop-linux-unset', 'claude-desktop', LINUX_UNSET],
    ['cursor-win32', 'cursor', WIN],
    ['cursor-darwin-nvm', 'cursor', MAC_NVM],
    ['cursor-darwin-nvm-full-paths', 'cursor', { ...MAC_NVM, fullPaths: true }],
    ['cursor-linux-unset', 'cursor', LINUX_UNSET],
  ] as const)('%s', async (name, client, deps) => {
    await expect(formatClientConfig(client, deps)).toMatchFileSnapshot(golden(name));
  });
});

describe('formatClientConfig', () => {
  it('knows the three clients', () => {
    expect(CLIENTS).toEqual(['claude-code', 'claude-desktop', 'cursor']);
    expect(isClientName('cursor')).toBe(true);
    expect(isClientName('vscode')).toBe(false);
  });

  it('hides the home directory unless full paths are asked for', () => {
    const hidden = formatClientConfig('cursor', MAC_NVM);
    expect(hidden).not.toContain('/Users/user');
    expect(hidden).toContain('~/.nvm/versions/node/v22.12.0/bin/npx');
    const full = formatClientConfig('cursor', { ...MAC_NVM, fullPaths: true });
    expect(full).toContain('/Users/user/.nvm/versions/node/v22.12.0/bin/npx');
    expect(full).not.toContain('Paths are shown with ~');
  });

  it('gives a macOS GUI client the absolute npx of a version-managed node, and Claude Code plain npx', () => {
    const cursor = formatClientConfig('cursor', MAC_NVM);
    expect(cursor).toContain('"command": "~/.nvm/versions/node/v22.12.0/bin/npx"');
    expect(cursor).toContain('"PATH": "~/.nvm/versions/node/v22.12.0/bin:');
    expect(formatClientConfig('claude-code', MAC_NVM)).toContain('-- npx -y @synchain/opentune-mcp');
  });

  it('gives an absolute npx to any macOS node outside /usr/bin and /usr/local/bin, Homebrew on Apple Silicon included', () => {
    const text = formatClientConfig('cursor', { ...MAC_NVM, execPath: '/opt/homebrew/bin/node' });
    expect(text).toContain('"command": "/opt/homebrew/bin/npx"');
    expect(text).toContain('"PATH": "/opt/homebrew/bin:');
  });

  it('leaves a system node as plain npx on macOS', () => {
    for (const execPath of ['/usr/local/bin/node', '/usr/bin/node']) {
      const text = formatClientConfig('cursor', { ...MAC_NVM, execPath });
      expect(text).toContain('"command": "npx"');
      expect(text).not.toContain('"PATH"');
    }
  });

  it('shows real paths in the Claude Code command, which is run as printed', () => {
    const text = formatClientConfig('claude-code', {
      ...MAC_NVM,
      env: { OPENTUNE_MCP_OPENTUNE_PATH: '/Users/user/Apps/OpenTune' },
    });
    expect(text).toContain('/Users/user/Apps/OpenTune');
    expect(text).not.toContain('~');
  });

  it('treats an unsubstituted settings placeholder as not set', () => {
    const text = formatClientConfig('cursor', {
      ...LINUX_UNSET,
      env: { OPENTUNE_MCP_OPENTUNE_PATH: '${user_config.opentune_path}' },
    });
    expect(text).toContain('<absolute path of the OpenTune executable>');
    expect(text).not.toContain('user_config');
  });

  it('points Linux users away from Claude Desktop', () => {
    const text = formatClientConfig('claude-desktop', LINUX_UNSET);
    expect(text).toContain('use claude-code or cursor');
    expect(text).not.toContain('.mcpb');
  });

  it('starts npx through cmd on Windows', () => {
    expect(formatClientConfig('cursor', WIN)).toContain('"command": "cmd"');
    expect(formatClientConfig('claude-code', WIN)).toContain('-- cmd /c npx -y @synchain/opentune-mcp');
  });

  it('puts a placeholder where the OpenTune path is not set, and says so', () => {
    for (const client of CLIENTS.filter((c) => c !== 'claude-desktop')) {
      const text = formatClientConfig(client, LINUX_UNSET);
      expect(text).toContain('<absolute path of the OpenTune executable>');
      expect(text).toContain('is not set in this shell');
    }
  });

  it('recommends the MCPB package first for Claude Desktop, with the checksum file', () => {
    const text = formatClientConfig('claude-desktop', WIN);
    expect(text.indexOf('recommended: install the MCPB package')).toBeLessThan(text.indexOf('Advanced'));
    expect(text).toContain('/releases/download/v1.2.3/opentune-mcp-1.2.3.mcpb');
    expect(text).toContain('opentune-mcp-1.2.3.mcpb.sha256');
    expect(text).toContain('%APPDATA%\\Claude\\claude_desktop_config.json');
  });

  it('always says it wrote nothing, and carries no secret', () => {
    for (const client of CLIENTS) {
      const text = formatClientConfig(client, { ...WIN, env: { ...WIN.env, OPENTUNE_MCP_TOKEN: 'secret-value' } });
      expect(text).toContain('Nothing was written');
      expect(text).not.toContain('secret-value');
    }
  });

  it('prints JSON that parses, with backslashes escaped', () => {
    const text = formatClientConfig('cursor', { ...WIN, fullPaths: true });
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      mcpServers: { opentune: { env: Record<string, string> } };
    };
    expect(parsed.mcpServers.opentune.env.OPENTUNE_MCP_OPENTUNE_PATH).toBe(WIN.env.OPENTUNE_MCP_OPENTUNE_PATH);
  });

  it('quotes a Claude Code argument that contains a space', () => {
    const text = formatClientConfig('claude-code', {
      ...LINUX_UNSET,
      env: { OPENTUNE_MCP_OPENTUNE_PATH: '/opt/Open Tune/OpenTune' },
    });
    expect(text).toContain('opentune --scope user -e OPENTUNE_MCP_OPENTUNE_PATH="/opt/Open Tune/OpenTune" --');
  });
});
