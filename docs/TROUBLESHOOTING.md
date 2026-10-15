# Troubleshooting

Every result of `opentune_get_status`, and every tool error, carries a `nextStep` (`actor` is `agent` or `user`)
and a `url` that points to one of the sections below. Run `opentune-mcp doctor` to check the set-up without starting
the server; `opentune-mcp doctor --json` prints the same checks as JSON.

## Statuses of opentune_get_status

### Status READY

OpenTune runs with the control API and this server verified it. With several instances running, pass `instance_id` to
the other tools; the server never picks one on its own.

### Status NOT_READY

An instance announced itself but no session could be established yet. `reason` says why: `connect_failed`,
`hello_timeout`, `closed_during_hello`, `session_limit` and `shutting_down` usually pass, so check again after a few
seconds. `instance_unverified` (the process at the port is not the instance of the discovery file) and `auth_failed`
need a restart of OpenTune.

### Status PROTOCOL_MISMATCH

OpenTune speaks a control protocol version this server does not support. Update OpenTune or this server so that both
support protocol major 1.

### Status STARTING

An OpenTune process started less than 30 seconds ago and has not published its control API yet. Check again shortly;
if the state turns into `RUNNING_WITHOUT_API`, the build or the start option lacks the control API.

### Status RUNNING_WITHOUT_API

OpenTune runs, but without the control API: it was started without `--control-api` (or `OPENTUNE_CONTROL_API=1`), or
the build has no control API. Save your work, quit OpenTune and start an API build with the option. This server never
closes OpenTune.

### Status NOT_RUNNING

The configured OpenTune build has the control API, but it is not running. Start it with `--control-api`.

With `processes: null` and `nullReasons.processes` set to `not_listable` (in this state, `NO_API_BUILD` or
`NOT_INSTALLED`), the server could not list the running processes, so an OpenTune without the control API may still
be running.

### Status NO_API_BUILD

`OPENTUNE_MCP_OPENTUNE_PATH` names an executable without an `opentune-control.json` for protocol major 1 next to it
(`reason`: `manifest_missing`, `manifest_invalid` or `protocol_mismatch`). Configure a build with the control API.

### Status NOT_INSTALLED

No OpenTune build with the control API is configured: `OPENTUNE_MCP_OPENTUNE_PATH` is not set
(`path_not_configured`), or does not name an existing executable by absolute path (`not_absolute`, `not_found`,
`not_a_file`). Set it in the MCP client's configuration for this server.

### Status WSL_UNSUPPORTED_RUNTIME

The server runs inside the Windows Subsystem for Linux and cannot reach OpenTune on Windows through `127.0.0.1`.
Configure the MCP client to start the server with Windows Node.js.

## Errors

The kinds of the OpenTune control protocol come first, then the kinds this server adds. `executed` false means the
request changed nothing; `null` means it is unknown whether it ran, so re-read the state before retrying a change.

### Error AUTH_FAILED

OpenTune refused the credentials from its discovery file, usually because it restarted. Check the status.

### Error PROTOCOL_MISMATCH

OpenTune speaks another protocol version. Update OpenTune or this server.

### Error SHUTTING_DOWN

OpenTune is closing. Check the status before doing anything else.

### Error INVALID_ARGUMENT

The arguments were rejected; `detail` says why. With reason `confirm_required` the operation is destructive and needs
the user's explicit consent.

### Error NOT_FOUND

The object no longer exists, or its id is out of date (ids change when a project is opened). Read the state again.
Finished jobs are kept for 30 minutes.

### Error NOT_READY

OpenTune is still analysing the audio or generating notes. Wait and retry. Reasons `f0_failed` and `f0_empty` do not
pass: the clip cannot be edited.

### Error ANALYSIS_FAILED

OpenTune could not analyse the pitch of the audio.

### Error RENDER_FAILED

OpenTune could not render the corrected audio, also after one automatic retry.

### Error MODEL_UNAVAILABLE

A model or inference backend OpenTune needs is missing. Run `opentune-mcp doctor`.

### Error REVISION_CONFLICT

The object changed since it was read. Read it again and retry with the new revision.

### Error UNDO_CONFLICT

The undo history does not have the expected entry on top. Ask the user how to proceed.

### Error UNSAVED_CHANGES

The request would discard unsaved changes. Ask the user whether to save or discard them.

### Error ALREADY_EXISTS

The target exists and replacing it was not allowed.

### Error BUSY

OpenTune is in use: a dialog is open, the user is dragging, or an import, export or project operation runs. Finish it
in OpenTune, then retry.

### Error TIMEOUT

OpenTune did not start the request before its deadline. Nothing changed; retry.

### Error CANCELLED

The job was cancelled. Its result lists any work it committed before it stopped.

### Error IO_ERROR

A file could not be read or written.

### Error UNSUPPORTED

OpenTune or this build does not offer the operation. With reason `capability_missing`, `detail` names the missing
capability; with `job_not_cancellable`, the job continues and can be followed with `opentune_get_job`.

### Error INTERNAL

An unexpected error in OpenTune or in this server. Errors of kinds this server does not know are handled the same way.
Check the status and re-read the state before retrying.

### Error OPENTUNE_NOT_AVAILABLE

No instance with the control API is running. Check the status and follow its next step.

### Error MULTIPLE_INSTANCES

Several instances run and no `instance_id` was given. The error lists the instances; ask the user which one to use.

### Error INSTANCE_NOT_FOUND

The `instance_id`, or the instance part of a job id, names no running instance: it was closed or restarted. The
server does not switch to another instance; ask the user.

### Error INSTANCE_UNVERIFIED

The process listening at the announced port did not prove to be the instance of the discovery file (server proof,
instance id or process id differ). The server sends it nothing further. Restart OpenTune.

### Error CONNECTION_LOST

The connection to OpenTune failed or closed. A request in flight may or may not have run; re-read the state before
retrying a change.

### Error REQUEST_TIMEOUT

OpenTune did not answer in time. The request may still run; re-read the state before retrying a change.

### Error CONFIG_INVALID

The server's configuration is invalid, for example `OPENTUNE_MCP_DISCOVERY_DIR` or `OPENTUNE_DATA_DIR` is not an
absolute path, or the discovery directory cannot be read.

## Doctor checks

### Doctor OT_NODE_VERSION

Node.js 22 or later is required.

### Doctor OT_WSL_RUNTIME

Inside WSL the server cannot reach OpenTune on Windows; run it with Windows Node.js.

### Doctor OT_DISCOVERY_DIR

The directory where OpenTune announces running instances must be readable. It does not exist until an OpenTune with
the control API has started once. `OPENTUNE_MCP_DISCOVERY_DIR` overrides it.

### Doctor OT_OPENTUNE_PATH

`OPENTUNE_MCP_OPENTUNE_PATH` must be the absolute path of the OpenTune executable of a build with the control API,
with an `opentune-control.json` next to it.

### Doctor OT_NO_OFFICIAL_INSTALL

Planned check, not implemented yet: whether an official OpenTune installation is present.

### Doctor OT_VERSION_UNSUPPORTED

Planned check, not implemented yet: whether the installed OpenTune version is supported.

### Doctor OT_MODELS_MISSING

Planned check, not implemented yet: whether the models OpenTune needs are installed.

### Doctor OT_SIDECAR_INCOMPLETE

Planned check, not implemented yet: whether the files that must sit next to the executable are complete.

### Doctor OT_MODELS_SHADOWED

Planned check, not implemented yet: whether a models folder next to the executable hides the installed models.

### Doctor OT_D3D12_NOT_COPIED

Planned check, not implemented yet: whether the Direct3D 12 runtime files were copied next to the executable; without
them OpenTune runs inference on the CPU.
