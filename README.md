**English** | [简体中文](README.zh-CN.md)

[![License](https://img.shields.io/github/license/synchain-oss/opentune-mcp-server?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-pre--release-orange?style=flat-square)](#status)

<!-- Badge row follows the org template (synchain-oss/.github, branding/badges.md): same order, flat-square.
     Build, Release, npm and node badges are added only once the workflow, a release and the npm package exist.
     Do not advertise anything that is not published. -->

# OpenTune MCP Server (by Synchain)

> An MCP server that lets AI agents operate OpenTune, the open-source AI vocal pitch-correction app, and reports the result of every action in a clear, structured form.

OpenTune MCP Server is an open-source project led by [Synchain](https://www.synchain.ca), released under the [MIT License](LICENSE). It is a separate program that talks to OpenTune; it is not part of OpenTune itself.

## Status

> **Early release (0.1.0).** The npm package [`@synchain/opentune-mcp`](https://www.npmjs.com/package/@synchain/opentune-mcp), the Claude Code plugin and the MCPB package are published; see [GitHub Releases](https://github.com/synchain-oss/opentune-mcp-server/releases). Until the official OpenTune ships the control API, the server works only with the [unofficial test build](https://github.com/synchain-oss/OpenTune/releases) of OpenTune. Tool names are now fixed; a renamed tool keeps its old name, marked deprecated, for one minor version.

| Setup | Status |
| --- | --- |
| Windows x64, with the unofficial test build of OpenTune from [synchain-oss/OpenTune](https://github.com/synchain-oss/OpenTune) (it has the control API) | Supported. |
| Official OpenTune release (it has no control API) | Does not work: `opentune_get_status` reports `NO_API_BUILD`. If the configuration points at the test build but an official OpenTune is the one running, it reports `RUNNING_WITHOUT_API`. |
| macOS | Not yet. |
| Linux | Not supported: OpenTune itself has no Linux build. |
| WSL | The server must run with Windows Node.js; see [WSL](#wsl). |

The OpenTune VST3/ARA plug-in inside a DAW is not covered; only OpenTune Standalone is.

## Prerequisites

- **Node.js 22 or later** (not needed for the MCPB package, which Claude Desktop runs with its own runtime).
- **An installed official OpenTune, version 1.7.9 or newer.** The test build contains no models and no Direct3D 12 runtime; it uses the ones of the official installation. OpenTune 1.7.9 must be installed in its default location, because it keeps its models in its install folder. OpenTune 1.8.1 can be installed anywhere; it keeps its models in `%ProgramData%\OpenTune\Models`.
- **The unofficial test build**, a zip that you unpack to a folder outside Program Files. Check that `opentune-control.json` sits next to `OpenTune.exe`.
- **`OPENTUNE_MCP_OPENTUNE_PATH`** set to the absolute path of the test build's `OpenTune.exe`. The install snippets below set it for you.

Run `opentune-mcp doctor` to check all of this (it never starts OpenTune); every check it reports has a section in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## First launch

The first time OpenTune starts with a fresh data folder it shows a one-time welcome (onboarding) dialog. A person has to answer it once, in the OpenTune window. While that dialog or any other modal dialog is open, every write operation fails with `BUSY` (reason `modal_open`). Answer the dialog, then try again.

## Install

`opentune-mcp doctor --client <claude-code|claude-desktop|cursor>` prints the configuration for a client with your own paths filled in. It only prints; it never writes a client's configuration file. The snippets below are what it prints on Windows, with `C:\Users\user\Apps\OpenTune\OpenTune.exe` standing for the path of your test build.

**Claude Desktop (recommended): the MCPB package.** Download `opentune-mcp-<version>.mcpb` and its `.sha256` file from the [GitHub Releases](https://github.com/synchain-oss/opentune-mcp-server/releases) page, check the checksum, open the `.mcpb` file (or drag it into Settings > Extensions) and choose Install. In the extension settings, set "OpenTune executable" to the test build's `OpenTune.exe`. Details: [docs/install.md](docs/install.md). Advanced: register the npm package by hand with `opentune-mcp doctor --client claude-desktop`.

**Claude Desktop: the skills.** Claude Desktop's chat does not run the MCP server inside a Claude Code plugin, so it gets the tools from the MCPB package above. The workflow guidance comes separately: extract `opentune-skills-<version>.zip` from the same release and upload each zip in it as a skill in Claude's settings. The skills contain instructions only and act through the MCP tools, so they help where the MCPB package is installed; claude.ai in a browser has no local tools. Skills that need local tools (the `lyrics-timeline` Python runtime, the `beat-grid` analyzer it downloads) ship with the plugin only.

**Claude Code (recommended): the plugin.** The plugin holds the MCP server and the skills that guide the editing workflow, and needs Node.js 22 or later on `PATH`. Run these two commands once in a terminal (they work the same in PowerShell). `--config` sets the "OpenTune executable" option to the test build's `OpenTune.exe`; leave it out to set it later in `/config`, or to use only an OpenTune that you start yourself.

```text
claude plugin marketplace add synchain-oss/opentune-mcp-server
claude plugin install opentune@synchain-opentune --config opentune_path=C:\Users\user\Apps\OpenTune\OpenTune.exe
```

The marketplace hands out the plugin of the latest release, which carries the same version as the npm and MCPB packages of that release. Updates are not installed by themselves: run `claude plugin update opentune@synchain-opentune`, or turn on auto-update for the `synchain-opentune` marketplace in `/plugin`. In a session the tools are named `mcp__plugin_opentune_opentune__<tool>`.

**Claude Code without the plugin:** run this once in a terminal. `--scope user` makes the server available in every project (leave it out to register it for the current project only). On Windows the command says `claude.cmd` because PowerShell would otherwise run `claude.ps1`, which swallows the `--` and fails with `missing required argument` (see [Troubleshooting](docs/TROUBLESHOOTING.md#claude-code-mcp-add-fails-in-powershell)); on macOS and Linux write `claude`.

```text
claude.cmd mcp add opentune --scope user -e OPENTUNE_MCP_OPENTUNE_PATH=C:\Users\user\Apps\OpenTune\OpenTune.exe -- cmd /c npx -y @synchain/opentune-mcp
```

**Cursor:** put this in `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "opentune": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "@synchain/opentune-mcp"
      ],
      "env": {
        "OPENTUNE_MCP_OPENTUNE_PATH": "C:\\Users\\user\\Apps\\OpenTune\\OpenTune.exe"
      }
    }
  }
}
```

Then ask the agent to check OpenTune. It calls `opentune_get_status` first and follows the `nextStep` in the result; `opentune_launch` starts the configured OpenTune with its control API.

## Example prompts

These show what the tools do. They make no promise about how the corrected vocal sounds: judge the result by listening, and ask the agent for a different setting if it is not what you want.

1. **"Pull the out-of-tune notes of the second phrase into tune."** The agent calls `opentune_get_project` (the clips and their revisions), `opentune_analyze_pitch` (per note: how many cents the sung pitch is from its target; notes beyond the threshold are flagged) and `opentune_edit_notes` or `opentune_autotune_range` on that time range. Read the result as before and after values in cents, plus whether and how the change can be undone. With `dry_run` the agent can predict a change without applying it.
2. **"Raise the whole vocal by 2 semitones, then export it."** The agent calls `opentune_set_clip` with a pitch shift of 2 semitones (one undo step) and `opentune_export_audio` with kind `clip`. The result names the WAV file that was written; an existing file is never overwritten, the next free name is used.
3. **"Move this section 30 ms earlier."** The agent calls `opentune_edit_timing` with a `shift` of -30 ms (`delta_ms`) on that range. OpenTune does not detect beats: handle positions come from you, or from the `seed` operation. The result lists the handles and says if a move was limited (`CLAMPED`).
4. **"Open `C:\Music\take1.wav` and tune it to C major."** The agent calls `opentune_open_audio`, follows the import with `opentune_get_job` until the analysis ends, then calls `opentune_autotune_range` with mode `regenerate` and the scale C major. Long audio takes time: see [How long to wait](docs/COMPATIBILITY.md#how-long-to-wait).
5. **"Use the backing-track WAV to find the key of this song, then autotune in that key."** The agent calls `opentune_estimate_key` with `mix_path` (an absolute path to a `.wav` file) and, optionally, the vocal `clip`. The result lists the best keys with confidences, says when relative keys (which share their notes) cannot be told apart, and gives a `recommendation.key` that the agent passes to `opentune_autotune_range`. Nothing is changed by the estimate itself.
6. **"Move the second vocal 0.5 seconds later and fade it in."** The agent calls `opentune_get_project` (the clips with their timeline start, and the `arrangement_revision`), previews with `opentune_edit_arrangement` and `dry_run`, then sends a `move` (a new `start_timeline_sec`: the current start plus 0.5) and a `fade` (`fade_in_sec`) in one call, which is one undo step. This moves the clip on the timeline; it does not stretch the audio inside it (that is `opentune_edit_timing`). OpenTune has no section markers, so the agent names the clip it means by its start time and asks when two clips fit.
7. **"Mute the backing track so I can hear the vocal."** The agent reads the tracks with `opentune_get_project`, mutes the backing track with `opentune_set_tracks` (op `mute`) and, if you ask, starts playback with `opentune_transport` (action `play`). Track names are data: when it is not sure which track is the backing, it asks. A mute has no undo entry in OpenTune, as in the window; the result gives the call that unmutes, so ask for the track to be unmuted when you are done. Playback comes out of the audio device of your computer; the agent cannot hear it, so you do the listening.
8. **"Save this as a new project, `C:\Music\take1-v2.otproj`."** The agent calls `opentune_save_project` with mode `save_as` and that path; the new file becomes the project file. A different existing file is never replaced by it: for that the agent needs `opentune_save_project_overwrite`, which asks for your explicit agreement first. OpenTune has no autosave, so ask the agent to save after each finished step; the undo history is not stored in the project file.

## Using it with a DAW

The exchange is by file path only; there is no DAW plug-in.

1. In your DAW, export the dry vocal as a WAV file.
2. Ask the agent to open that file in OpenTune (`opentune_open_audio`), make the edits, and export a WAV file (`opentune_export_audio`; a clip, a track or the whole mix; without `path` it is written next to the source as `<name>.opentune.wav`, and a name that is taken gets the next free one, so nothing is overwritten).
3. Import the exported WAV back into the DAW, on a new track or in place of the dry vocal.
4. To go on later, ask the agent to save the OpenTune project (`opentune_save_project`, a `.otproj` file). Only OpenTune reads that file; the DAW does not.

If your agent runs in WSL, read [WSL](#wsl) for the form of the paths.

## WSL

The server must use Node.js on Windows, because OpenTune listens on `127.0.0.1` of Windows, which WSL cannot reach: inside WSL `opentune-mcp doctor` fails the check `OT_WSL_RUNTIME` and `opentune_get_status` reports `WSL_UNSUPPORTED_RUNTIME`. Configure your MCP client to start the server with Windows Node.js (the snippets above do that). An agent in WSL can still hand over files by path: in every path argument of a tool call (`path`, `items`, `mix_path`) a path in the form `/mnt/c/Music/take1.wav` is converted to `C:\Music\take1.wav`. Results report Windows paths, such as `C:\Music\take1.opentune.wav`; that is the form your Windows DAW takes, and inside WSL the same file is `/mnt/c/Music/take1.opentune.wav`.

## What it does

OpenTune analyses a recorded vocal, shows it as notes and a pitch curve, and re-renders the corrected voice with a neural vocoder. This server lets an AI agent perform, through MCP tool calls, operations that a person can perform in the OpenTune Standalone window. The complete list is in [docs/reference.md](docs/reference.md).

- **Import and export:** open audio files and export a clip, a track or the full mix as WAV.
- **Read the analysis:** notes, pitch curves, the detected key, analysis and render status, and a pitch summary per phrase that an agent can reason about. A key can also be estimated from a WAV of the backing track or the mix.
- **Auto-tune and note edits:** run OpenTune's AUTO correction on chosen time ranges, set a note's target pitch, shift it by cents, snap it to the scale, change retune speed, vibrato and drift, and set a clip's key and pitch shift.
- **Timing:** shift a section earlier or later, and move time handles. The `beat-grid` skill measures the tempo and beat grid of a backing track or the original mix and plans those shifts; its analyzer is downloaded only after the user agrees (about 85 to 90 MB with the default model).
- **Arrangement and tracks:** move, trim, fade and set the gain of clips on the timeline; split, merge, delete and copy clips; mute, solo and set the volume and colour of tracks; show hidden tracks, duplicate and delete tracks.
- **Playback and window:** play, pause, stop and seek; set the tempo, time signature and loop; select a clip and close dialogs.
- **Projects and settings:** save a project, save it under a new name, open another one; read and change OpenTune's global settings (tuning frequency, hybrid mode, editing scheme, audio device). OpenTune has no autosave, so saving is part of the workflow.
- **Undo and redo:** API changes go onto OpenTune's own undo history where OpenTune supports undo. When an action cannot be undone (some cannot, in OpenTune itself), the result says so and, where possible, includes a way to revert it.

Every change returns a structured result: what changed (before and after, with units), side effects, warnings, whether it can be undone, and how to revert it when it cannot. The goal is not to judge whether a vocal "sounds right"; it is to make OpenTune's existing operations available to an agent and to report their effects clearly.

## Tools

The server offers 27 tools; their parameters are in [docs/reference.md](docs/reference.md). A result that cannot be undone says so in its first sentence and, where there is a way back, gives the call that restores the old state.

**Status and jobs**

| Tool | What it does | Undo and your agreement |
| --- | --- | --- |
| `opentune_get_status` | Reports whether OpenTune can be used, with a `nextStep`, and lists the running instances. Call it first. | Read-only. |
| `opentune_launch` | Starts the configured OpenTune build with its control API, or says why it cannot. | A second instance needs `allow_second_instance`, only with your agreement. |
| `opentune_get_job` | Follows a long operation (import, export, analysis, project open or save). | Read-only. |
| `opentune_cancel_job` | Asks OpenTune to stop a running job. Work the job already committed stays. | A job that cannot be cancelled keeps running; the error says so. |

**Read**

| Tool | What it does | Undo and your agreement |
| --- | --- | --- |
| `opentune_get_project` | Tracks, clips, selection, transport, and the revisions that write tools need. | Read-only. |
| `opentune_get_notes` | The notes of one clip, a page at a time. | Read-only. |
| `opentune_get_clip_details` | Duration, key, pitch shift, analysis state, time handles, reference binding and AUTO modes of one clip. | Read-only. |
| `opentune_get_settings` | OpenTune's global settings: processing, audio device, recent projects, import and export limits, log lines. | Read-only. |

**Analyse**

| Tool | What it does | Undo and your agreement |
| --- | --- | --- |
| `opentune_analyze_pitch` | How far each note is from its target, in cents, before and after the corrections. | Read-only. |
| `opentune_estimate_key` | Estimates the key of a song from a clip's vocal pitch and/or a WAV of the mix or the backing track. | Read-only; the WAV is only read. |

**Audio files**

| Tool | What it does | Undo and your agreement |
| --- | --- | --- |
| `opentune_open_audio` | Imports audio files as new clips. | Cannot be undone; the result says how to revert it. |
| `opentune_export_audio` | Writes a WAV of a clip, a track or the master mix. Never overwrites a file. | Does not change the project. `allow_dry` (export a clip whose analysis failed, uncorrected) only with your agreement. |

**Clips and notes**

| Tool | What it does | Undo and your agreement |
| --- | --- | --- |
| `opentune_set_clip` | Sets the key and/or the pitch shift of a clip. | A key change cannot be undone (the result gives the call that restores it); a pitch shift is one undo step. |
| `opentune_autotune_range` | Runs OpenTune's AUTO on ranges of a clip. `dry_run` previews. | Marked destructive. Mode `notesOnly` replaces all notes and cannot be undone; it needs `replace_edited_notes`, only with your agreement. |
| `opentune_edit_notes` | Sets target pitch, shifts by cents, snaps to the scale, changes retune speed, vibrato and drift. `dry_run` previews. | One undo step. |
| `opentune_edit_timing` | Shifts or moves the time handles of a clip; `seed` places the first handles. | The `seed` operation cannot be undone. |
| `opentune_undo`, `opentune_redo` | Undo or redo the top step, if it is the step the call names. | After `UNDO_CONFLICT` the agent asks you. `force` only when you ask to undo a change that was not made through this server. |

**Arrangement and tracks**

| Tool | What it does | Undo and your agreement |
| --- | --- | --- |
| `opentune_edit_arrangement` | Clips on the timeline: move, trim, gain, fade, set a reference (experimental), split, merge, delete, copy. `dry_run` previews. | Marked destructive. Split, merge, delete and copy cannot be undone, so the agent asks you first; delete needs `confirm: true`. |
| `opentune_set_tracks` | Mute, solo, volume and colour of tracks; show hidden tracks; duplicate a track. | Mute, solo, volume and colour have no undo entry in OpenTune; the result gives the call that restores the old values. |
| `opentune_delete_track` | Deletes a track and its clips. | Marked destructive. Cannot be undone, and the later track ids move down by one. Needs `confirm: true`, only after you agreed to delete that track. |

**Playback and window**

| Tool | What it does | Undo and your agreement |
| --- | --- | --- |
| `opentune_transport` | Play, pause, stop, seek, tempo, time signature, loop. | Tempo and time signature cannot be undone (the result gives the restoring call). Looping has no audible effect in the standalone app, and without an audio device nothing is heard. |
| `opentune_manage_ui` | Selects a clip (and can open it in the piano roll), closes dialogs, marks the first-run dialog as shown. | Marked destructive. Selecting a clip can make OpenTune generate its notes (no undo entry). A dialog that commits its value when it closes needs `accept_commit`, only with your agreement. Marking the first-run dialog as shown cannot be undone. |

**Projects and settings**

| Tool | What it does | Undo and your agreement |
| --- | --- | --- |
| `opentune_save_project` | Saves the project, or saves it as a new `.otproj` file. | Does not replace a different existing file. |
| `opentune_save_project_overwrite` | Saves the project over a different, existing `.otproj` file. | Marked destructive. The old file is lost. Needs `confirm: true`, only after you agreed to replace that file. |
| `opentune_open_project` | Opens a `.otproj` file and replaces the current project. | Marked destructive. Never saves: with unsaved changes it fails (`UNSAVED_CHANGES`) unless `discard_unsaved: true`, only with your agreement. Clears the undo history. |
| `opentune_set_settings` | Changes OpenTune's global settings (A4 tuning, hybrid mode, editing scheme, experimental features, vocoder weight, rendering priority, pitch model, reference alignment mode, audio device) or empties the recent-projects list. | Marked destructive. The settings belong to the OpenTune installation, not to the project, and have no undo entry; the result gives the previous values and the call that restores them. The recent-projects list cannot be refilled. |

### Your agreement

The tools marked destructive in their MCP annotations are `opentune_autotune_range`, `opentune_edit_arrangement`, `opentune_delete_track`, `opentune_manage_ui`, `opentune_open_project`, `opentune_save_project_overwrite` and `opentune_set_settings`. The server's instructions tell the agent to get your explicit agreement, in the conversation, before any destructive or irreversible action, and a tool result never counts as agreement. The arguments that confirm such an action (`confirm`, `discard_unsaved`, `replace_edited_notes`, `accept_commit`, `allow_dry`, `allow_second_instance`, `force`) are set only after you agreed. If you want a second check, set your MCP client to ask before it runs these tools.

## How it works

```text
MCP client (for example Claude Desktop, Claude Code or Cursor)
   |  MCP over stdio
   v
opentune-mcp  (this repository, Node.js, MIT)
   |  OTCP: JSON-RPC 2.0, one JSON message per line, TCP on 127.0.0.1
   v
OpenTune Standalone with the control API  (synchain-oss/OpenTune, AGPL-3.0)
```

- **Two layers.** The control API runs inside OpenTune and speaks a small, versioned protocol, the OpenTune Control Protocol (OTCP). This server turns MCP tool calls into OTCP requests and the replies into readable results. The two are separate programs, so this repository contains no OpenTune code.
- **Off by default.** The control API is a build option. Even in a build that includes it, OpenTune opens it only when it is started with the API explicitly enabled.
- **Local only.** OpenTune listens on the literal address 127.0.0.1, on a port chosen by the operating system, and accepts requests only after a handshake with a random token created for each launch and stored in a per-user discovery file. This server opens no network port of its own; it talks to your MCP client over stdio.
- **Public specification.** The OTCP specification (JSON Schemas, examples and a threat model) is in `spec/otcp/v1/` in this repository, under the MIT License.

## Known limitations

- **Hybrid mode and small corrections.** OpenTune's preference "Hybrid Mode: Small corrections use DSP, large corrections use vocoder" is on by default. The part of a correction below 75 cents is applied by DSP pitch shifting instead of the vocoder, which is OpenTune's own design, and on real voices such a small correction can be barely audible. To make small corrections count, switch that preference off in OpenTune, or ask the agent to do it with `opentune_set_settings` (`processing.hybrid_mode`); it is a global setting of OpenTune, not of the project, so it stays off until someone switches it on again. See [Hybrid mode](docs/TROUBLESHOOTING.md#hybrid-mode).
- **Some edits cannot be undone.** Importing audio, changing the key of a clip and a time-grid `seed` cannot be undone. Splitting, merging and deleting clips cannot be undone because of a defect in OpenTune (it frees objects that its own undo entry needs); copying clips and deleting a track cannot be undone either. Mute, solo, volume, colour, tempo, time signature and the global settings have no undo entry in OpenTune. The result says so in its first sentence, the agent asks you before the destructive ones, and where there is a way back the result gives the call that restores the old state.
- **No autosave.** OpenTune does not save by itself, and the undo history is not stored in the project file. Unsaved work is lost when OpenTune closes or crashes: ask the agent to save after each finished step.
- **One reference analysis per session.** OpenTune completes only one reference analysis per session (a defect in OpenTune itself). After that, `opentune_autotune_range` in mode `reference` ends with `NOT_READY` until OpenTune is restarted; save the project first. See [NOT_READY](docs/TROUBLESHOOTING.md#error-not_ready).
- **`RUNNING_WITHOUT_API` was only checked by hand.** The state of an official OpenTune that runs without the control API was verified manually, not by an automated test.
- **Read-only source folder.** An export without `path` goes next to the source file. When that folder is read-only the export fails with an error; it does not pick another folder. Give a writable `path`.
- **First launch needs a person.** The welcome dialog has to be answered once ([First launch](#first-launch)).
- **Not covered:** official OpenTune builds that lack the control API, Linux, the VST3/ARA plug-in, features that OpenTune's own window does not have, and drawing-style edits (drawing, stretching, splitting or merging notes, per-note EQ, hand-drawn curves).

## Relationship to OpenTune

- [OpenTune](https://github.com/YuFeng926/OpenTune) is an open-source AI pitch-correction app. OpenTune is a project of DAYA STUDIO and is licensed under AGPL-3.0. Its only official release channel is [YuFeng926/OpenTune](https://github.com/YuFeng926/OpenTune).
- The OpenTune author has agreed to this approach: we develop the control API in our fork, [synchain-oss/OpenTune](https://github.com/synchain-oss/OpenTune), as added code that leaves OpenTune's behaviour unchanged while the API is off, and plan to propose it to the upstream project. This does not make it an official OpenTune feature; whether and how it is merged is up to the author.
- This repository contains no OpenTune source code and no model weights.
- Until the control API is part of an official OpenTune release, the patched build is an unofficial test build. It contains no model weights and uses the models from your official OpenTune installation.
- OpenTune MCP Server is a Synchain project, not an official OpenTune or DAYA STUDIO product.

## Documentation

- [docs/install.md](docs/install.md): setup for MCP clients, including the MCPB package
- [docs/reference.md](docs/reference.md): tool reference, generated from the server
- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md): which OpenTune versions, test builds and protocol versions work together, which capabilities each tool needs, and how long operations take
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) ([中文](docs/TROUBLESHOOTING.zh-CN.md)): errors, states and doctor checks, with fixes
- [docs/real-opentune-testing.md](docs/real-opentune-testing.md): running the end-to-end checks against a real OpenTune, and how to judge a run
- `spec/otcp/v1/`: the OTCP specification

## Contributing

Issues and pull requests are welcome, in English or Chinese. See [CONTRIBUTING.md](CONTRIBUTING.md) (in Chinese) and the [Code of Conduct](CODE_OF_CONDUCT.md). Every commit must be signed off (`git commit -s`, DCO). While the project is in pre-release, please open an issue before starting a larger change. Issues about the control API in [synchain-oss/OpenTune](https://github.com/synchain-oss/OpenTune) and its test builds are tracked here too.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in a public issue. The local control channel, its token and file-path handling are in scope.

## License

[MIT](LICENSE) © 2026 Synchain. The OTCP specification in `spec/` is also MIT-licensed.

OpenTune is licensed under AGPL-3.0 and is not part of this repository. The models that OpenTune uses have their own licences, some of them non-commercial; none of them are distributed here.

## Related projects

- [synchain-oss/OpenTune](https://github.com/synchain-oss/OpenTune): our fork of OpenTune, where the control API is developed
- [synchain-oss/synchain-cli](https://github.com/synchain-oss/synchain-cli): `@synchain/cli`, the Synchain command-line client
- [synchain-oss/synchain-bridge](https://github.com/synchain-oss/synchain-bridge): audio plugin (VST3/AU) that streams DAW audio to remote collaborators
- [synchain-oss/scvb](https://github.com/synchain-oss/scvb): Synchain Vocal Balancer, automatic pan and level balancing for vocal arrangements (VST3)
- [synchain.ca](https://www.synchain.ca): Synchain website
