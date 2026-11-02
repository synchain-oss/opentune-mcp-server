<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: MIT
-->

# Installing OpenTune MCP Server (by Synchain)

This page is about the MCP client configuration. The Claude Code plugin, which also brings the skills, and the
skills for Claude Desktop are described under Install in the [README](../README.md#install). A Chinese version
follows separately.

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

Run `opentune-mcp doctor --client claude-code` and run the printed `claude mcp add` command. The name (`opentune`) comes
first and `-e` sets the environment variable, because `-e`/`--env` takes any number of values and would otherwise swallow
the name. `--scope user` makes the server available in every project; leave it out for the current project only. On
Windows the command starts with `claude.cmd`; see [Troubleshooting](TROUBLESHOOTING.md#claude-code-mcp-add-fails-in-powershell).

## Cursor

Run `opentune-mcp doctor --client cursor` and put the printed JSON into `~/.cursor/mcp.json`.

## macOS (Apple silicon)

The macOS test build of OpenTune (from the release `synchain-test/v1.8.0-ctl.3` on, Apple silicon only, macOS 13.3 or
later) works with the same three clients; the MCPB manifest lists `darwin` next to `win32`. What differs from
Windows:

- **Official OpenTune first.** Install the official OpenTune 1.8.0 or later in `/Applications`. The test build
  contains no models; it uses the ones inside `/Applications/OpenTune.app`. `opentune-mcp doctor` reports the
  version it reads from the app's `Info.plist` (`OT_NO_OFFICIAL_INSTALL`, `OT_VERSION_UNSUPPORTED`) and whether
  `fcpe.onnx` is where the official app looks for it (`OT_MODELS_MISSING`).
- **Unpack the zip into a folder of your own** and keep its files together: `OpenTune-ctl.app`,
  `OpenTune-AI.command`, `opentune-control.json` and `SHA256SUMS`. The manifest is beside the script, not inside the
  app (a file inside the app would break its signature).
- **The configured program is `OpenTune-AI.command`.** Set **OpenTune executable** (MCPB), the `opentune_path` option of
  the plugin or `OPENTUNE_MCP_OPENTUNE_PATH` to the absolute path of that script, not to the executable inside the
  app. The server starts the script directly, in its folder, without a terminal; the script replaces itself with
  OpenTune and passes `--control-api`. Double-clicking `OpenTune-ctl.app` starts OpenTune without the control API,
  which the server then reports as `RUNNING_WITHOUT_API`.
- **Allow the first start by hand.** The build is signed ad hoc and not notarized, so Gatekeeper blocks it once; see
  [macOS: first start blocked by Gatekeeper](TROUBLESHOOTING.md#macos-first-start-blocked-by-gatekeeper). The server
  never changes file attributes and never runs `xattr`.
- **Checksum.** `shasum -a 256 -c opentune-mcp-<version>.mcpb.sha256` (the `sha256sum` that `doctor --client
claude-desktop` prints is not part of stock macOS).
- **GUI clients and `PATH`.** Cursor and Claude Desktop do not read your shell profile. When your Node.js is not in
  `/usr/bin` or `/usr/local/bin` (Homebrew on Apple silicon uses `/opt/homebrew/bin`; version managers use their own
  folder), `doctor --client` prints the full path of `npx` and a `PATH` entry. Claude Desktop's configuration file is
  `~/Library/Application Support/Claude/claude_desktop_config.json`.
- **Windows-only checks.** `OT_D3D12_NOT_COPIED` reports "Not applicable": the Direct3D 12 runtime is a Windows
  component. The skills run on macOS too (`beat-grid` with the macOS universal2 analyzer, `lyrics-timeline` on Apple
  silicon with Python 3.10 or later).

## WSL

The server must run with Windows Node.js, because OpenTune listens on `127.0.0.1` of Windows, which WSL cannot reach.
Configure the MCP client to start the server with Windows Node.js; the configuration that `opentune-mcp doctor --client
<name>` prints for Windows does that. A server that starts inside WSL reports `WSL_UNSUPPORTED_RUNTIME` (see
[Status WSL_UNSUPPORTED_RUNTIME](TROUBLESHOOTING.md#status-wsl_unsupported_runtime)). An agent in WSL can still hand over
files by path: a path argument such as `/mnt/c/Music/take1.wav` is converted to `C:\Music\take1.wav`, and results report
Windows paths.
