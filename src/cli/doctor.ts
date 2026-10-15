// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// `opentune-mcp doctor [--json]`: checks the set-up without starting the MCP server and without
// needing OpenTune to run. Check ids are stable (docs/TROUBLESHOOTING.md has a section for each);
// checks that are planned but not implemented yet are listed with the status not_implemented.
// Output hides the home directory, and secrets of discovery files are only reported as present.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { resolveDiscoveryDir } from '../discovery/dir.js';
import { DISCOVERY_FILE_RE, parseDiscoveryFile } from '../discovery/file.js';
import { troubleshootingUrl } from '../errors/next-step.js';
import { OPENTUNE_PATH_ENV, checkLaunchConfig, isWsl } from '../launch/config.js';
import { SERVER_NAME, VERSION } from '../version.js';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'not_implemented';

export interface CheckResult {
  readonly id: string;
  readonly status: CheckStatus;
  readonly message: string;
  readonly url: string;
}

/** Checks that are registered but not implemented yet. */
const PLANNED = [
  'OT_NO_OFFICIAL_INSTALL',
  'OT_VERSION_UNSUPPORTED',
  'OT_MODELS_MISSING',
  'OT_SIDECAR_INCOMPLETE',
  'OT_MODELS_SHADOWED',
  'OT_D3D12_NOT_COPIED',
] as const;

export const DOCTOR_CHECK_IDS: readonly string[] = [
  'OT_NODE_VERSION',
  'OT_WSL_RUNTIME',
  'OT_DISCOVERY_DIR',
  'OT_OPENTUNE_PATH',
  ...PLANNED,
];

export interface DoctorDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** process.version, for example v22.12.0. */
  readonly nodeVersion: string;
  /** Kernel release on Linux, for the WSL check. */
  readonly osRelease: string | null;
}

const MIN_NODE_MAJOR = 22;

/** Replaces the home directory with ~ (ignoring case on Windows). */
export function redactHome(text: string, home: string, platform: NodeJS.Platform): string {
  if (home.length < 2) return text;
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, platform === 'win32' ? 'gi' : 'g'), '~');
}

const result = (id: string, status: CheckStatus, message: string): CheckResult => ({
  id,
  status,
  message,
  url: troubleshootingUrl(`doctor-${id.toLowerCase()}`),
});

async function discoveryCheck(deps: DoctorDeps): Promise<CheckResult> {
  const id = 'OT_DISCOVERY_DIR';
  const dir = resolveDiscoveryDir(deps.env, deps.platform, deps.home);
  if (!dir.ok) return result(id, 'fail', dir.problem);
  let names: string[];
  try {
    names = (await readdir(dir.dir)).filter((n) => DISCOVERY_FILE_RE.test(n)).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'error';
    return code === 'ENOENT'
      ? result(
          id,
          'warn',
          `${dir.dir} does not exist yet: no OpenTune with the control API has started (${dir.source}).`,
        )
      : result(id, 'fail', `${dir.dir} cannot be read (${code}).`);
  }
  const lines: string[] = [];
  for (const name of names) {
    const bytes = await readFile(path.join(dir.dir, name)).catch(() => null);
    const parsed = bytes === null ? null : parseDiscoveryFile(name, bytes);
    lines.push(
      parsed?.ok
        ? `${name}: instance ${parsed.entry.instanceId}, OpenTune ${JSON.stringify(parsed.entry.appVersion)}, token present (redacted)`
        : `${name}: ignored (${parsed === null ? 'unreadable' : parsed.problem})`,
    );
  }
  const count = `${String(names.length)} discovery file(s)`;
  return result(id, 'pass', [`${dir.dir} is readable (${dir.source}); ${count}.`, ...lines].join('\n'));
}

async function opentunePathCheck(deps: DoctorDeps): Promise<CheckResult> {
  const id = 'OT_OPENTUNE_PATH';
  const config = await checkLaunchConfig(deps.env, deps.platform);
  switch (config.state) {
    case 'unset':
      return result(
        id,
        'warn',
        `${OPENTUNE_PATH_ENV} is not set, so this server cannot tell which OpenTune build to use.`,
      );
    case 'invalid':
      return result(
        id,
        'fail',
        `${OPENTUNE_PATH_ENV} is set but ${config.reason.replaceAll('_', ' ')}: it must be the absolute path of the OpenTune executable.`,
      );
    case 'no_api':
      return result(
        id,
        'fail',
        `${OPENTUNE_PATH_ENV} names a build without a usable opentune-control.json (${config.reason.replaceAll('_', ' ')}).`,
      );
    case 'ok':
      return result(id, 'pass', `${OPENTUNE_PATH_ENV} = ${config.path}, a build with the control API.`);
  }
}

export async function runDoctor(deps: DoctorDeps): Promise<CheckResult[]> {
  const major = Number(/^v(\d+)\./.exec(deps.nodeVersion)?.[1]);
  const node =
    major >= MIN_NODE_MAJOR
      ? result('OT_NODE_VERSION', 'pass', `Node.js ${deps.nodeVersion} (${String(MIN_NODE_MAJOR)} or later required).`)
      : result(
          'OT_NODE_VERSION',
          'fail',
          `Node.js ${deps.nodeVersion} is too old; ${String(MIN_NODE_MAJOR)} or later is required.`,
        );
  const wsl = isWsl(deps.env, deps.platform, deps.osRelease)
    ? result(
        'OT_WSL_RUNTIME',
        'fail',
        'Running inside WSL, which cannot reach OpenTune on Windows; run this server with Windows Node.js.',
      )
    : result('OT_WSL_RUNTIME', 'pass', 'Not running inside WSL.');
  const checks = [node, wsl, await discoveryCheck(deps), await opentunePathCheck(deps)];
  for (const id of PLANNED) checks.push(result(id, 'not_implemented', 'This check is not implemented yet.'));
  return checks.map((c) => ({ ...c, message: redactHome(c.message, deps.home, deps.platform) }));
}

const LABEL: Readonly<Record<CheckStatus, string>> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  not_implemented: 'TODO',
};

export function formatDoctor(checks: readonly CheckResult[], json: boolean): string {
  if (json) return `${JSON.stringify({ name: SERVER_NAME, version: VERSION, checks }, null, 2)}\n`;
  const width = Math.max(...checks.map((c) => c.id.length));
  const lines = checks.map((c) => {
    const [first = '', ...rest] = c.message.split('\n');
    return [
      `${LABEL[c.status]}  ${c.id.padEnd(width)}  ${first}`,
      ...rest.map((r) => `${' '.repeat(width + 8)}${r}`),
    ].join('\n');
  });
  return `${SERVER_NAME} doctor ${VERSION}\n${lines.join('\n')}\n`;
}

/** Exit status: 1 when a check failed. */
export const doctorExitCode = (checks: readonly CheckResult[]) => (checks.some((c) => c.status === 'fail') ? 1 : 0);
