# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| latest minor (x.Y.*) | ✅ |
| older | ❌ |

Nothing has been released yet. Once releases exist, only the latest minor version line receives security fixes; please upgrade to it and reproduce there first.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub Private Vulnerability Reporting: Security → Report a vulnerability.

Backup channel, if the GitHub channel is not available: **contact@synchain.ca**, with `[security]` in the subject.

Reports in English or Chinese are both welcome. Please include, where you can: the server version or commit, the OpenTune build (official version or test-build tag), your OS version, the MCP client and its version, and the steps to reproduce. **Do not include tokens** from OpenTune discovery files or any other credentials.

## Response targets

- First response: within 3 working days
- Fix or mitigation: 14 days for high severity, 30 days for medium severity
- Disclosure: a public advisory (GHSA) is published 7 days after the fix ships

## Threat model in short

Processes running as the same OS user are trusted: they can already read that user's files and control their desktop applications. Not trusted: other OS users on the same machine, web pages open in a browser, and any text that reaches the model's context, including names, paths and metadata that OpenTune returns. The full threat model of the control protocol will be published in `spec/otcp/v1/SECURITY.md`.

## Scope

- ✅ **The local control channel**, as specified in `spec/otcp/v1/` and used by this server: connecting to anything other than the literal address `127.0.0.1`; trusting an OpenTune instance whose server proof, instance id or process id does not match its discovery file; discovery files that another OS user can create, replace or read; a web page in a browser being able to drive the control port; design flaws in the protocol's handshake, limits or framing.
- ✅ **Token handling**: the per-launch control token or the server proof appearing anywhere outside the discovery file and the handshake, for example in tool results, logs, error messages, `doctor` output or progress messages.
- ✅ **Path handling**: tool input that makes the server or OpenTune read or write somewhere the user did not ask for, including relative, UNC, device (`\\?\`, `\\.\`) and drive-relative paths and alternate data streams; overwriting a loaded source file or project media; saving over another project without the explicit, separate overwrite tool and its confirmation.
- ✅ **Untrusted text**: track, file and project names, metadata or log lines returned by OpenTune being presented to the model as instructions instead of data, or causing a destructive tool (delete a track, open a project, overwrite a project) to run without the user's explicit consent.
- ✅ **Launching OpenTune**: the server starting any executable other than the one the user configured, or passing tool-supplied arguments or environment variables to it.
- ✅ Supply-chain issues in the published package, the build scripts or CI (dependencies, workflow permissions, exposure of secrets).
- ✅ The C++ code we add to OpenTune for the control API in [synchain-oss/OpenTune](https://github.com/synchain-oss/OpenTune), and our unofficial test builds: report it here, or via Private Vulnerability Reporting on synchain-oss/OpenTune; both reach the same maintainers.
- ❌ Vulnerabilities in OpenTune itself, outside the code we add: report them to [YuFeng926/OpenTune](https://github.com/YuFeng926/OpenTune). If you are unsure which side is affected, report here and we will route it.
- ❌ Issues in MCP clients, or model behaviour that this server does not cause.
- ❌ Attacks that require code already running as the same OS user.
