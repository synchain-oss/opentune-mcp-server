**English** | [简体中文](README.zh-CN.md)

[![License](https://img.shields.io/github/license/synchain-oss/opentune-mcp-server?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-pre--release-orange?style=flat-square)](#status)

<!-- Badge row follows the org template (synchain-oss/.github, branding/badges.md): same order, flat-square.
     Build, Release, npm and node badges are added only once the workflow, a release and the npm package exist.
     Do not advertise anything that is not published. -->

# OpenTune MCP Server (by Synchain)

> An MCP server, in development, that will let AI agents operate OpenTune, the open-source AI vocal pitch-correction app, and report the result of every action in a clear, structured form.

OpenTune MCP Server is an open-source project led by [Synchain](https://www.synchain.ca), released under the [MIT License](LICENSE). It is a separate program that talks to OpenTune; it is not part of OpenTune itself.

## Status

> **Pre-release, work in progress. Nothing is published yet.** There is no npm package, no release and no runnable server in this repository yet. The protocol, the tool names and the behaviour described below may still change before the first release.

| Item | Status |
| --- | --- |
| This server (`@synchain/opentune-mcp`, command `opentune-mcp`) | Not published. The protocol specification, the server and its tests are being added to this repository. |
| OpenTune with the control API | Required. Official OpenTune releases do not include the control API yet. A patched build is being developed in [synchain-oss/OpenTune](https://github.com/synchain-oss/OpenTune) and will be offered as a clearly labelled unofficial test build until the API is part of an official OpenTune release. |
| Windows x64 | First target platform. |
| macOS | Not yet. No macOS test builds will be published; on macOS the server is planned to work with an official OpenTune release that includes the control API, or with a build from source. |
| Linux | Not supported: OpenTune itself has no Linux build. |
| Node.js | 22 or later (planned requirement). |

**What works today:** nothing that you can install or run yet.

**What will not work, even after the first release:** official OpenTune builds that lack the control API, Linux, and the OpenTune VST3/ARA plug-in inside a DAW (only OpenTune Standalone is covered).

## What it does

OpenTune analyses a recorded vocal, shows it as notes and a pitch curve, and re-renders the corrected voice with a neural vocoder. This server is planned to let an AI agent perform, through MCP tool calls, the operations a person can already perform in the OpenTune Standalone window:

- **Import and export**: open audio files (one file, several files in sequence, or one track per file) and export a clip, a track or the full mix as WAV.
- **Read the analysis**: notes, pitch curves, the detected key, analysis and render status, and a pitch summary per phrase that an agent can reason about.
- **Auto-tune**: run OpenTune's AUTO correction on chosen time ranges, with an explicit scale and explicit parameters.
- **Note edits**: set a note's target pitch, shift it by cents, snap it to the scale, or change its retune speed, vibrato and drift.
- **Timing**: shift a section earlier or later, and move time handles.
- **Arrangement, tracks and transport**: move, trim, split, merge and delete clips, and set their gain and fades; set mute, solo, volume and colour per track; play, stop and seek; set tempo and time signature.
- **Projects and settings**: save, save as and open projects; read and change processing preferences and the audio device.
- **Undo and redo**: API changes go onto OpenTune's own undo history where OpenTune supports undo. When an action cannot be undone (some cannot, in OpenTune itself), the result says so and, where possible, includes a way to revert it.

Every change will return a structured result: what changed (before and after, with units), side effects, warnings, whether it can be undone, and how to revert it when it cannot. The goal is not to judge whether a vocal "sounds right"; it is to make OpenTune's existing operations available to an agent and to report their effects clearly.

Not in the first version: features that OpenTune's UI does not have, and drawing-style edits (drawing, stretching, splitting or merging notes, per-note EQ, hand-drawn curves), which are deferred to a later version.

## How it works

The planned design:

```text
MCP client (for example Claude Desktop, Claude Code or Cursor)
   |  MCP over stdio
   v
opentune-mcp  (this repository, Node.js, MIT)
   |  OTCP: JSON-RPC 2.0, one JSON message per line, TCP on 127.0.0.1
   v
OpenTune Standalone with the control API  (synchain-oss/OpenTune, AGPL-3.0)
```

- **Two layers.** The control API will run inside OpenTune and speak a small, versioned protocol, the OpenTune Control Protocol (OTCP). This server will turn MCP tool calls into OTCP requests and turn the replies into readable results. The two are separate programs, so this repository contains no OpenTune code.
- **Off by default.** The control API will be a build option. Even in a build that includes it, OpenTune will open it only when it is started with the API explicitly enabled.
- **Local only.** OpenTune will listen on the literal address 127.0.0.1, on a port chosen by the operating system, and will accept requests only after a handshake with a random token created for each launch and stored in a per-user discovery file. This server will open no network port of its own; it will talk to your MCP client over stdio.
- **Public specification.** The OTCP specification (JSON Schemas, examples and a threat model) will live in `spec/otcp/v1/` in this repository, under the MIT License.

## Relationship to OpenTune

- [OpenTune](https://github.com/YuFeng926/OpenTune) is an open-source AI pitch-correction app. OpenTune is a project of DAYA STUDIO and is licensed under AGPL-3.0. Its only official release channel is [YuFeng926/OpenTune](https://github.com/YuFeng926/OpenTune).
- The OpenTune author has agreed to this approach: we develop the control API in our fork, [synchain-oss/OpenTune](https://github.com/synchain-oss/OpenTune), as added code that leaves OpenTune's behaviour unchanged while the API is off, and plan to propose it to the upstream project. This does not make it an official OpenTune feature; whether and how it is merged is up to the author.
- This repository contains no OpenTune source code and no model weights.
- Until the control API is part of an official OpenTune release, any patched build we publish will be clearly labelled as an unofficial test build. It will contain no model weights and will use the models from your official OpenTune installation.
- OpenTune MCP Server is a Synchain project, not an official OpenTune or DAYA STUDIO product.

## Roadmap

1. The OTCP specification and a mock OpenTune, so that the server can be tested without OpenTune.
2. First release on Windows: reading, import and export, auto-tune, note and timing edits, undo and redo, together with an unofficial OpenTune test build.
3. Second release: arrangement, tracks, transport, project save and open, settings.
4. macOS, with an official OpenTune release that includes the control API (or a build from source).
5. Proposing the control API to the upstream OpenTune project. Listing in MCP directories only after an official OpenTune release includes the API.

## Documentation

These documents will be added as the work lands:

- `docs/install-for-agents.md`: setup for MCP clients and AI agents
- `docs/reference.md`: tool reference, generated from the server
- `docs/ARCHITECTURE.md`: how the two layers fit together
- `docs/COMPATIBILITY.md`: which versions of this server, the protocol and OpenTune builds work together
- `docs/TROUBLESHOOTING.md` (with a Chinese version): errors and fixes, by error code
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
