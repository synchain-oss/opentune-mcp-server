# Contract change: opentune_launch

## Background

Until now the server could only tell the user to start OpenTune with the control API. This change adds
`opentune_launch`, which starts the build the user configured in `OPENTUNE_MCP_OPENTUNE_PATH`, so that an agent can
follow the `NOT_RUNNING` next step on its own. Starting a process is a security boundary, so the tool is deliberately
narrow:

- The executable comes only from `OPENTUNE_MCP_OPENTUNE_PATH` (an absolute path to an existing regular file) with an
  `opentune-control.json` next to it that lists protocol major 1; otherwise the result is `NOT_INSTALLED` or
  `NO_API_BUILD` and nothing is started. The official installation is detected (Windows: uninstall entries, then the
  usual install folders) but used only as the working directory and by `doctor`, never as a candidate to start.
- The only input is `allow_second_instance` (strict schema); paths, arguments and environment variables in a call are
  rejected. The command line is fixed: `--control-api`, `--control-api-ready-file=`, `--control-api-launch-nonce=`
  and, when `OPENTUNE_MCP_DISCOVERY_DIR` overrides the directory, `--control-api-dir=` with that directory.
- The process is spawned with `shell: false`, `detached: true`, `stdio: 'ignore'` and unreferenced. The server never
  ends a process, also not after a timeout.
- The started instance is accepted only if its discovery file carries the launch nonce. `launching/<pid>.json` in the
  discovery directory (pid, start time, SHA-256 of the nonce; never the nonce or a token) lets repeated and concurrent
  calls share one start and lets `opentune_get_status` report `STARTING`.

## Files

| File                          | Change                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `test/golden/tools-list.json` | Adds `opentune_launch` (input `allow_second_instance?`; not read-only, not destructive, idempotent). |
| `docs/reference.md`           | Regenerated: the new tool.                                                                           |
| `docs/TROUBLESHOOTING.md`     | New section "Starting OpenTune"; new reasons below; `OT_NO_OFFICIAL_INSTALL` is now implemented.     |
| `mcpb/manifest.json`          | Tools list synced from the golden catalog (`node scripts/mcpb.mjs sync-tools`).                      |

The MCP instructions (`test/golden/instructions.txt`) and the OTCP specification (`spec/otcp/v1/`) are not changed;
the tool uses the start options, discovery file member `launchNonce` and ready file the specification already defines.

Result changes of `opentune_get_status` that the golden files do not cover:

| State / error                   | Change                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `NOT_RUNNING`                   | `nextStep` is now `{actor: "agent", tool: "opentune_launch"}` (was a user step).                      |
| `RUNNING_WITHOUT_API`           | The user step mentions restarting with `opentune_launch`; a launched process silent past 30 s counts. |
| `STARTING`                      | New `reason` `launch_pending` for a process `opentune_launch` started; other starts keep `null`.      |
| `NOT_READY`                     | New reasons `launch_timeout` (agent step: check the status again) and `launch_unverified` (user).     |
| `NOT_RUNNING`                   | New reason `launch_exited` (user step).                                                               |
| `NO_API_BUILD`                  | New reason `manifest_too_large` (`opentune-control.json` larger than 8 KiB).                          |
| `CONFIG_INVALID` (error)        | New reason `launch_failed` (the system could not start the configured executable).                    |
| doctor `OT_NO_OFFICIAL_INSTALL` | Implemented: `pass` with the folder and version, `warn` when none is found or not on Windows.         |

## Compatibility

The catalog only grows: clients that do not know `opentune_launch` keep working, and the existing tools keep their
names, descriptions and schemas. Reason codes are open sets, so clients must already accept the new ones. A client
that followed the old `NOT_RUNNING` user step still can: starting OpenTune by hand with `--control-api` works as
before. On the OpenTune side nothing new is required: a build that implements the start options of the specification
writes the ready file and `launchNonce`; an instance that announces itself for the start without the nonce is
reported as `launch_unverified` and not used, never silently accepted.
