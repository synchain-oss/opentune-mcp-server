# Troubleshooting

Every result of `opentune_get_status`, and every tool error, carries a `nextStep` (`actor` is `agent` or `user`)
and a `url` that points to one of the sections below. Run `opentune-mcp doctor` to check the set-up without starting
the server; `opentune-mcp doctor --json` prints the same checks as JSON. For how long import, analysis, rendering and
export take, see [How long to wait](COMPATIBILITY.md#how-long-to-wait).

## Statuses of opentune_get_status

### Status READY

OpenTune runs with the control API and this server verified it. With several instances running, pass `instance_id` to
the other tools; the server never picks one on its own. A dialog that is open in the OpenTune window blocks every write
operation; then the result carries `blockedBy`, see [First launch dialog](#first-launch-dialog).

### Status NOT_READY

An instance announced itself but no session could be established yet. `reason` says why: `connect_failed`,
`hello_timeout`, `closed_during_hello`, `session_limit` and `shutting_down` usually pass, so check again after a few
seconds. `instance_unverified` (the process at the port is not the instance of the discovery file) and `auth_failed`
need a restart of OpenTune.

Two reasons come only from `opentune_launch`. `launch_timeout`: the OpenTune it started did not announce its control
API within 30 seconds. The process keeps running (this server never ends it); check the status again after a few
seconds instead of starting OpenTune again. `launch_unverified`: an instance announced itself for the start, but its
discovery file does not carry the launch nonce passed to the process, so this server does not use it. Ask the user
which OpenTune windows are open.

### Status PROTOCOL_MISMATCH

OpenTune speaks a control protocol version this server does not support. Update OpenTune or this server so that both
support protocol major 1.

### Status STARTING

An OpenTune process started less than 30 seconds ago and has not published its control API yet. With `reason`
`launch_pending`, it is a process that `opentune_launch` started (`processes` lists its pid); another call of
`opentune_launch` waits for it instead of starting a second one. Check again shortly; if the state turns into
`RUNNING_WITHOUT_API`, the build or the start option lacks the control API.

### Status RUNNING_WITHOUT_API

OpenTune runs, but without the control API: it was started without `--control-api` (or `OPENTUNE_CONTROL_API=1`), or
the build has no control API. A process that `opentune_launch` started and that has not announced its control API
within 30 seconds counts here too. Save your work, quit OpenTune, and start it again with `opentune_launch` (or start
an API build with the option yourself). `opentune_launch` starts nothing while such a process runs, and this server
never closes OpenTune.

### Status NOT_RUNNING

The configured OpenTune build has the control API, but it is not running. `opentune_launch` starts it (see
[Starting OpenTune](#starting-opentune)); you can also start it yourself with `--control-api`.

With `reason` `launch_exited`, the OpenTune that `opentune_launch` started exited before its control API became
available. Start it by hand to see what happens, and run `opentune-mcp doctor`.

With `processes: null` and `nullReasons.processes` set to `not_listable` (in this state, `NO_API_BUILD` or
`NOT_INSTALLED`), the server could not list the running processes, so an OpenTune without the control API may still
be running. `opentune_launch` then starts nothing until the user confirms that no OpenTune runs (see
[OPENTUNE_NOT_AVAILABLE](#error-opentune_not_available)).

### Status NO_API_BUILD

`OPENTUNE_MCP_OPENTUNE_PATH` names an executable without an `opentune-control.json` for protocol major 1 next to it
(`reason`: `manifest_missing`, `manifest_too_large`, `manifest_invalid` or `protocol_mismatch`). The file must be a
UTF-8 JSON object of at most 8 KiB whose `protocolMajors` lists 1; other members are ignored. An official OpenTune release, which has no control API, lands here too. Configure a build with
the control API. `opentune_launch` never starts such an executable.

### Status NOT_INSTALLED

No OpenTune build with the control API is configured: `OPENTUNE_MCP_OPENTUNE_PATH` is not set
(`path_not_configured`), or does not name an existing executable by absolute path (`not_absolute`, `not_found`,
`not_a_file`). Set it in the MCP client's configuration for this server.

### Status WSL_UNSUPPORTED_RUNTIME

The server runs inside the Windows Subsystem for Linux and cannot reach OpenTune on Windows through `127.0.0.1`.
Configure the MCP client to start the server with Windows Node.js.

## Starting OpenTune

`opentune_launch` starts only the executable in `OPENTUNE_MCP_OPENTUNE_PATH`, and only when the checks of
[NOT_INSTALLED](#status-not_installed) and [NO_API_BUILD](#status-no_api_build) pass. Its only input is
`allow_second_instance`; nothing in a tool call changes the executable, its arguments or its environment. It passes
`--control-api`, a ready file, a random launch nonce and, when `OPENTUNE_MCP_DISCOVERY_DIR` is set, that directory
(`--control-api-dir=`), and waits up to 30 seconds for the instance whose discovery file carries the nonce. While it
waits, the folder `launching` in the discovery directory holds `<pid>.json` (the pid, the start time and a hash of the
nonce, never a token) and the ready file, so that `opentune_get_status` reports [STARTING](#status-starting) and
repeated or concurrent calls wait for the same start. It starts nothing when an instance with the control API already
runs (`alreadyRunning`; a second instance needs `allow_second_instance` and the user's explicit consent) or an OpenTune
without the control API runs. When the server cannot list the running processes, it cannot rule out the latter and
also starts nothing (error [OPENTUNE_NOT_AVAILABLE](#error-opentune_not_available), `reason`
`process_list_unavailable`). `allow_second_instance: true` is not idempotent: every call with it starts one more
instance once the earlier starts are done, so use it only once per consent. It never ends a process, also not after a
timeout.

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
the user's explicit consent. With reason `option_unavailable` (`opentune_set_settings`) the vocoder weight or the pitch
model is not one this installation offers; `detail` names the member and nothing was changed. Read the offered values
with `opentune_get_settings` (`processing.options`) and call again with one of them. A name is refused also when it
equals the current value but is no longer listed, for example when the weight file was removed. A test build of
`1.0.0-rc.5` does not know these members at all and answers with reason `invalid_params`
(see [Settings tools and the specification versions](COMPATIBILITY.md#settings-tools-and-the-specification-versions)).

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

Two reasons come from a change of the vocoder weight or the rendering priority (`opentune_set_settings`), which
OpenTune applies by a job that waits until the vocoder is ready again. In both cases OpenTune takes the changes back,
and the result says so. `vocoder_not_ready` (retryable): the vocoder was still busy when OpenTune's wait limit passed;
wait a little, then call again, and run `opentune-mcp doctor` if it keeps happening. `vocoder_load_failed` (not
retryable): the vocoder could not load the new weight or backend, for example because the weight file is corrupt or
incompatible; the previous settings are back, so sending the same value again does not help. Tell the user and check the
models with `opentune-mcp doctor`.

### Error REVISION_CONFLICT

The object changed since it was read. Read it again and retry with the new revision.

### Error UNDO_CONFLICT

The undo history does not have the expected entry on top. Ask the user how to proceed.

### Error UNSAVED_CHANGES

The request would discard unsaved changes. Ask the user whether to save or discard them. From `opentune_quit` the
refusal is deliberate: the close button of the OpenTune window quits without asking, this tool does not. Save first with
`opentune_save_project` (mode `save`, or `save_as` for a project that was never saved) and call `opentune_quit` again;
only when the user explicitly agrees to lose the changes, call it with `discard_unsaved: true`.

### Error ALREADY_EXISTS

The target exists and replacing it was not allowed.

### Error BUSY

OpenTune is in use: a dialog is open, the user is dragging, or an import, export or project operation runs. Finish it
in OpenTune, then retry. With reason `modal_open` a modal dialog is open; the first one is usually the one-time welcome
dialog, see [First launch dialog](#first-launch-dialog). `opentune_manage_ui` with op `dismiss_dialogs` closes
dialogs like the Escape key; a dialog that commits its value when closed (the track-colour dialog) is closed only
with `accept_commit: true`, which needs the user's agreement. Closing a confirmation box cancels the action it asked
about, so ask the user before closing any dialog. With reason `job_in_progress` (from `opentune_quit`) a job that has
not finished, for example a settings change, would be ended by quitting: wait a few seconds and call again.

### Error TIMEOUT

OpenTune did not start the request before its deadline. Nothing changed; retry.

### Error CANCELLED

The job was cancelled. Its result lists any work it committed before it stopped.

### Error IO_ERROR

A file could not be read or written. An export without `path` is written next to its source file; when that folder is
read-only the export fails and the server does not choose another folder. Call `opentune_export_audio` again with a
`path` in a folder you can write to.

### Error UNSUPPORTED

OpenTune or this build does not offer the operation. With reason `capability_missing`, `detail` names the missing
capability; with `no_editor_window`, OpenTune is running without an editor window, so start OpenTune Standalone with its window and try again; with `job_not_cancellable`, the job continues and can be followed with `opentune_get_job`. `opentune_manage_ui` with op `switch_view` needs the capability `ui.workspace`, which test builds before `1.0.0-rc.7` of the specification lack: switch the view in the OpenTune window (the arrangement view and piano roll buttons of the transport bar), or use a newer test build. `opentune_quit` needs the capability `app.quit`, which test builds before `1.0.0-rc.7` of the specification lack: save the project with `opentune_save_project`, then ask the user to close the OpenTune window (the window closes without asking about unsaved changes).

### Error INTERNAL

An unexpected error in OpenTune or in this server. Errors of kinds this server does not know are handled the same way.
Check the status and re-read the state before retrying.

### Error OPENTUNE_NOT_AVAILABLE

No instance with the control API is running. Check the status and follow its next step.

From `opentune_launch` with `reason` `process_list_unavailable` (and `processes: null`, `nullReasons.processes`
`not_listable`, as in [NOT_RUNNING](#status-not_running)): the server could not list the running processes, so it
cannot tell whether an OpenTune without the control API already runs, and starting would open a second instance next
to it. Nothing was started. Make sure no OpenTune is running; only after the user has confirmed this, call
`opentune_launch` again with `allow_second_instance: true`. That is the only way past this check.

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

With reason `read_too_slow` (from `opentune_get_notes` with `output_path`) this server stopped reading pages because
the next one could end after a client has given up (40 seconds into the call). Nothing in OpenTune changed and no file
was written; read a narrower range (`from` and `to`) into several files, or call again when OpenTune is less busy.

### Error CONFIG_INVALID

The server's configuration is invalid, for example `OPENTUNE_MCP_DISCOVERY_DIR` or `OPENTUNE_DATA_DIR` is not an
absolute path, or the discovery directory cannot be read (`reason` `discovery_dir`; `opentune_launch` also reports
it when it cannot create its `launching` folder there). With `reason` `launch_failed`, the executable in
`OPENTUNE_MCP_OPENTUNE_PATH` passed the checks but the system could not start it; `detail` gives the system's error
code. Run `opentune-mcp doctor`.

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

Whether an official OpenTune installation is present (Windows only): the server reads the uninstall entries in the
registry, then looks in the usual install folders. Not finding one is a warning, not an error. The installation is
never started by this server; an OpenTune that `opentune_launch` starts runs with it as working directory, so that a
build without a models folder of its own finds the installed models. Without an installation the working directory is
the folder of the configured executable.

### Doctor OT_VERSION_UNSUPPORTED

The version of the official OpenTune installation (read from its uninstall entry; Windows only) must be 1.7.9 or
later. Older: update OpenTune from the official release page. `warn` with "Not checked" means no installation was
found or the check does not apply on this system; `warn` with "Cannot tell" means the installation does not report a
version.

### Doctor OT_MODELS_MISSING

The official installation needs these files, none of them empty: `fcpe.onnx`, and `GAME\bd2dur.onnx`,
`GAME\dur2bd.onnx`, `GAME\encoder.onnx`, `GAME\estimator.onnx`, `GAME\segmenter.onnx`. OpenTune 1.8 and later keeps
them in `%ProgramData%\OpenTune\Models`; 1.7.x keeps them in the `models` folder of its install folder. The check only
looks at existence and size, never at the content. When it fails, the message names the folder it looked in and the
files that are missing: run the official installer again (or repair the installation) so that it restores the models.
When the installed version is unknown, both folders are tried and the result is a warning.

### Doctor OT_SIDECAR_INCOMPLETE

A test build comes as a zip with a `SHA256SUMS` file (lines of `<sha256>  <relative path>`) next to the executable.
`fail` means a file it lists is missing or its hash differs (the message names it), or the list cannot be read.
Delete the folder and unpack the whole zip again into an empty folder; do not copy single files over an older build.
`warn` ("Cannot verify") means there is no `SHA256SUMS`, which is normal for an executable you built yourself, and
the folder cannot be checked.

### Doctor OT_MODELS_SHADOWED

A `models` folder next to the executable is found before the installed models. A test build does not ship one, so
rename or delete it unless you put it there on purpose; the message says whether it holds all the required model
files.

### Doctor OT_D3D12_NOT_COPIED

A test build lists the Direct3D 12 runtime in `opentune-control.json` (`d3d12`) without bundling it. Without the file
OpenTune runs inference on the CPU, so this is a warning and copying is optional. Measured on a machine with an NVIDIA
GPU: without the copy the pitch analysis (F0) falls back to the CPU. Run the commands the check prints in PowerShell, which copy
`D3D12Core.dll` from the official installation to the `D3D12` folder next to the executable and print its SHA-256 hash
to compare with `opentune-control.json`; use the printed commands as they are, because they escape a path that contains
special characters. If the copied file has another hash (`fail`), delete the `D3D12` folder (back
to CPU) and copy it again from the official installation. `D3D12SDKLayers.dll` is the debug layer: do not copy it, and
delete it if it is there.
"Cannot tell" means the `d3d12` entry of `opentune-control.json` lists no files or has a hash that is not 64
hexadecimal characters, so nothing could be checked: unpack the test build again.

## Claude Code mcp add fails in PowerShell

`claude mcp add` fails with `missing required argument 'commandOrUrl'` (or `'name'`). Two causes:

- In PowerShell, `claude` resolves to the `claude.ps1` that npm generates, and PowerShell drops a lone `--` before the
  program sees it, so the command to register is missing. Run `claude.cmd mcp add …` instead, which `opentune-mcp doctor
--client claude-code` prints on Windows. In cmd and on macOS and Linux, `claude` works.
- `-e` (`--env`) takes any number of values, so a name written after it is read as one more variable. The name
  (`opentune`) must come first, as the printed command has it.

## First launch dialog

The first time OpenTune starts with a fresh data folder it shows a one-time welcome (onboarding) dialog. A person has to
answer it once in the OpenTune window. While it, or any other modal dialog, is open, every write operation fails with
[BUSY](#error-busy) and reason `modal_open`. `opentune_get_status` and `opentune_launch` read the window once when the
instance can report it and add `blockedBy` (`kind` `onboarding` or `dialog`, and a hint) to the result, with a summary
that says writes are refused until the dialog is closed; they do not say that everything is ready. `opentune_get_settings`
also reports whether onboarding was shown. Ask the user to answer the dialog, then retry. `opentune_manage_ui` can close
it like the Escape key: op `dismiss_onboarding` for the onboarding overlay (it also marks onboarding as shown, a global
setting that cannot be undone, so tell the user that OpenTune shows the welcome page and close it only after the user
agrees), op `dismiss_dialogs` for any other dialog. The server never presses a button of a dialog. If the window cannot
be read, `blockedBy` is null with the reason `unavailable` in `nullReasons`, and the status is still reported as ready.
An instance without the capability `ui.bridge` cannot report its window at all: `blockedBy` is null there with the
reason `capability_missing`, which does not mean that no dialog is open.

## Rendering backend and vocoder

`opentune_get_settings` (section `processing`) shows the rendering priority and the backend OpenTune uses now
(`processing.backend`). With `gpuFirst` OpenTune tries the GPU each time the vocoder loads and falls back to the CPU
without a word when that fails, so the GPU is not guaranteed. When the priority is `gpuFirst`, the backend is `cpu` and
the vocoder is loaded (`processing.vocoderReady` is true), the summary says so; a vocoder that is not loaded can still
report the backend from before, so nothing is concluded from it. To see why, read the log: `opentune_get_settings` with sections `["log"]` and `log_lines` 30 shows
the lines about the backend. On Windows also run `opentune-mcp doctor`: it checks the Direct3D 12 runtime that a test
build lists in `opentune-control.json` (see [OT_D3D12_NOT_COPIED](#doctor-ot_d3d12_not_copied)). After a change of the
rendering priority, `opentune_set_settings` reads the backend once the job has ended and reports it in
`rendering_backend`; if the vocoder is still reloading after a short wait, it says so instead of guessing. If the vocoder
was not ready when the setting changed (right after the start, before the first render), OpenTune can finish the job
before the vocoder has loaded again, so a `cpu` read then is not proof of a fall back: `rendering_backend.confirmed` is
`false`, and the backend is only known after the next load. Read `opentune_get_settings` again once a render has run.

`vocoderReady: false` just after OpenTune starts is expected: the vocoder loads when the first render needs it, and the
summaries of `opentune_get_status`, `opentune_launch` and `opentune_get_settings` say so. They do not call it normal,
because `session.info` and `prefs.get` have no member that tells a vocoder that has not loaded yet from one that could
not load or is stuck. If it is still false after a render has run (an edit that has to be rendered, an export), tell the
user, and read the log (`opentune_get_settings` with sections `["log"]`) for the reason. A change of the vocoder weight
or the rendering priority fails with [MODEL_UNAVAILABLE](#error-model_unavailable) `vocoder_load_failed` when OpenTune
cannot load the new weight or backend.

## Hybrid mode

OpenTune's preference "Hybrid Mode: Small corrections use DSP, large corrections use vocoder" (in the Chinese interface
"混合模式:小修用dsp,大修用声码器") is on by default. The part of a correction smaller than 75 cents is applied by DSP pitch
shifting instead of the vocoder. That is OpenTune's own design, in its window as well as through this server, and on
real voices such a small correction can be barely audible. If small corrections must be clearly audible, switch the
preference off in OpenTune's preferences, or ask the agent to do it with `opentune_set_settings`
(`processing.hybrid_mode`). It is a global setting of the OpenTune installation, not of the project, so it stays off
until it is switched on again; the result of `opentune_set_settings` gives the call that restores the previous value.
The setting is reported as it was, in three places: `export.processing.hybridMode` in the result of
`opentune_export_audio`; `job.result.processing.hybridMode` in `opentune_get_job` when the export job has not finished
within the call; and the preference itself in the `processing` section of `opentune_get_settings`. Do not assume it.

## Slow process discovery

On Windows the server reads the start time of OpenTune processes to tell a live instance from a stale discovery file.
The first such read after a cold start of PowerShell is sometimes slow, so finding an instance can take a few seconds
longer than usual. This is not an error; call again if a client gave up waiting.
