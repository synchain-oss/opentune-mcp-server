<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: MIT
-->

# Installing OpenTune MCP Server (by Synchain)

This page is a skeleton: the MCPB section below is complete in outline, the other clients are filled in
later. A Chinese version follows separately.

`opentune-mcp doctor --client <claude-code|claude-desktop|cursor>` prints the configuration for a client with
your own paths filled in. It only prints; it never writes a client's configuration file.

## Claude Desktop: MCPB package (recommended)

An MCPB package (`.mcpb`) is a one-file extension that Claude Desktop installs with a click. It contains the
server bundle and asks for the one setting the server needs, so you do not edit any JSON.

Requirements: Claude Desktop with extension support (it runs Node.js extensions with its own runtime, which must
be Node.js 22 or later; the manifest states this), and a build of OpenTune Standalone that includes the control interface (the file
`opentune-control.json` sits next to its executable).

1. Download `opentune-mcp-<version>.mcpb` and `opentune-mcp-<version>.mcpb.sha256` from the
   [GitHub Releases](https://github.com/synchain-oss/opentune-mcp-server/releases) page of this repository.
2. Check the download against the checksum file:
   - macOS / Linux: `sha256sum -c opentune-mcp-<version>.mcpb.sha256` (macOS: `shasum -a 256 -c`).
   - Windows: `certutil -hashfile opentune-mcp-<version>.mcpb SHA256`, and compare the output with the file.
3. Open the `.mcpb` file (or drag it into Settings > Extensions) and choose Install.
4. In the extension's settings, set **OpenTune executable** to the OpenTune executable with the control
   interface. This becomes `OPENTUNE_MCP_OPENTUNE_PATH` for the server. Leave it empty to use only an OpenTune
   that you started yourself.

The package is not signed. It is built reproducibly: building the same release twice gives the same bytes, so
the published sha256 can be checked by anyone who builds the tag themselves (`npm ci`, `npm run build`,
`npm run mcpb:pack`).

### Maintainers

- `mcpb/manifest.json` is the manifest (version 0.3). Its tool list mirrors `test/golden/tools-list.json`; after
  a tool change run `node scripts/mcpb.mjs sync-tools` and format the file.
- `npm run mcpb:pack` writes `.cache/mcpb/opentune-mcp-<version>.mcpb` and a `.sha256` file next to it.
- `npm run mcpb:validate` runs `mcpb validate` with the version pinned in `scripts/mcpb-tool/`.

## Claude Desktop: JSON configuration (advanced)

Run `opentune-mcp doctor --client claude-desktop` and follow the second half of its output.

## Claude Code

Run `opentune-mcp doctor --client claude-code` and run the printed `claude mcp add` command.

## Cursor

Run `opentune-mcp doctor --client cursor` and put the printed JSON into `~/.cursor/mcp.json`.
