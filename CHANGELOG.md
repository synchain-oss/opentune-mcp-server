# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The OTCP protocol specification in `spec/otcp/v1/` is
versioned separately and has its own changelog.

## Unreleased

### Added

- Project scaffold: TypeScript (strict, ESM) checked with `tsc`, eslint (typescript-eslint, type-aware) and prettier;
  vitest with v8 coverage thresholds (85% overall; 90% per file for input sanitizing, errors, OTCP framing, analysis
  and result rendering).
- `opentune-mcp` command. `--version` and `--help` print to stdout and exit. Without arguments it serves MCP over stdio
  as `opentune-mcp`, answering both the `initialize` handshake and 2026-07-28 requests. No tools are registered yet.
- Single-file build `dist/opentune-mcp.mjs` (esbuild). The package has no runtime dependencies and no lifecycle
  scripts, and `THIRD-PARTY-NOTICES.md` is generated from the esbuild metafile; see
  [ADR 0001](docs/adr/0001-single-file-bundle.md).
- Local gates, `npm run gates`: lint, formatting, typecheck, unit tests with coverage, build, bundle shape, package
  contents, `npm audit`, third-party notices, stdio smoke test, gitleaks (version and sha256 pinned in
  `scripts/tools.lock.json`), privacy, AI attribution and sign-off, README heading parity, and the
  `pull_request_target` ban. It prints a PASS / FAIL / SKIP table for the current commit.
