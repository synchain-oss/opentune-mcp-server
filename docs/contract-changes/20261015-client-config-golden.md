# Contract change: client configuration golden snippets

## Background

`opentune-mcp doctor --client <claude-code|claude-desktop|cursor>` prints the configuration that registers this server
with an MCP client. The text is what users copy and run, so the unit tests compare it byte for byte with golden files.

## Files

| File                                             | Change                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `test/golden/client-config/claude-code-*.txt`    | New. The `claude mcp add` command on Windows, macOS (version-managed node), Linux.      |
| `test/golden/client-config/claude-desktop-*.txt` | New. MCPB install steps plus the manual JSON; on Linux only a pointer to other clients. |
| `test/golden/client-config/cursor-*.txt`         | New. The `mcp.json` entry, also with `--full-paths`.                                    |

The Claude Code command shows real paths, because it is run as printed and no shell expands `~` everywhere. The JSON
snippets show `~` for the home directory unless `--full-paths` is given, and say so.

## Compatibility

New files only; nothing depends on an earlier shape. The OTCP specification (`spec/otcp/v1/`) and the tool catalog
are not changed.
