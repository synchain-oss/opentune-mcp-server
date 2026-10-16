// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// `opentune-mcp doctor [--json]`: checks the set-up without starting the MCP server and without
// needing OpenTune to run. Check ids are stable (docs/TROUBLESHOOTING.md has a section for each);
// the status not_implemented is kept for a check that is registered before it is written.
// Output hides the home directory, and secrets of discovery files are only reported as present.

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { resolveDiscoveryDir } from '../discovery/dir.js';
import { DISCOVERY_FILE_RE, parseDiscoveryFile, readDiscoveryBytes } from '../discovery/file.js';
import { troubleshootingUrl } from '../errors/next-step.js';
import { OPENTUNE_PATH_ENV, checkLaunchConfig, isWsl } from '../launch/config.js';
import type { InstallDetector, OfficialInstall } from '../launch/install.js';
import { SERVER_NAME, VERSION } from '../version.js';
import {
  d3d12Check,
  modelsCheck,
  shadowedCheck,
  sidecarCheck,
  systemDoctorFs,
  versionCheck,
  type DoctorFs,
  type Outcome,
} from './doctor-checks.js';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'not_implemented';

export interface CheckResult {
  readonly id: string;
  readonly status: CheckStatus;
  readonly message: string;
  readonly url: string;
}

export const DOCTOR_CHECK_IDS: readonly string[] = [
  'OT_NODE_VERSION',
  'OT_WSL_RUNTIME',
  'OT_DISCOVERY_DIR',
  'OT_OPENTUNE_PATH',
  'OT_NO_OFFICIAL_INSTALL',
  'OT_VERSION_UNSUPPORTED',
  'OT_MODELS_MISSING',
  'OT_SIDECAR_INCOMPLETE',
  'OT_MODELS_SHADOWED',
  'OT_D3D12_NOT_COPIED',
];

export interface DoctorDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** process.version, for example v22.12.0. */
  readonly nodeVersion: string;
  /** Kernel release on Linux, for the WSL check. */
  readonly osRelease: string | null;
  /** Finds the official OpenTune installation (read-only). */
  readonly officialInstall: InstallDetector;
  /** File access of the checks on models and on the files next to the executable (the real one when omitted). */
  readonly fs?: DoctorFs;
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
    const bytes = await readDiscoveryBytes(path.join(dir.dir, name));
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
      if (config.unfilledPlaceholder === true) {
        return result(
          id,
          'warn',
          `${OPENTUNE_PATH_ENV} still holds an unfilled settings placeholder, so it is treated as not set. Open the extension settings and choose the OpenTune executable, or clear the setting.`,
        );
      }
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

function officialInstallCheck(deps: DoctorDeps, install: OfficialInstall | null): CheckResult {
  const id = 'OT_NO_OFFICIAL_INSTALL';
  if (deps.platform !== 'win32') {
    return result(id, 'warn', 'Not checked: this check looks for an official OpenTune installation on Windows only.');
  }
  if (install === null) {
    return result(
      id,
      'warn',
      'No official OpenTune installation was found (uninstall entries in the registry, usual install folders). This ' +
        'is not an error; an OpenTune started by this server then runs in the folder of its executable.',
    );
  }
  const version = install.version === null ? 'version unknown' : `version ${JSON.stringify(install.version)}`;
  const via = install.source === 'registry' ? 'uninstall entry' : 'install folder';
  return result(
    id,
    'pass',
    `Official OpenTune installation in ${install.dir} (${version}, found by its ${via}). An OpenTune started by ` +
      'this server uses this folder as its working directory, where a build without a models folder of its own ' +
      'looks for the installed models.',
  );
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
  const windows = deps.platform === 'win32';
  const fs = deps.fs ?? systemDoctorFs;
  // The installation is looked up once; several checks use it.
  const install = windows ? await deps.officialInstall().catch(() => null) : null;
  const config = await checkLaunchConfig(deps.env, deps.platform);
  const exeDir = config.state === 'ok' ? config.dir : null;
  const sidecar = { platform: deps.platform, fs };
  const outcome = (id: string, o: Outcome) => result(id, o.status, o.message);
  const checks = [
    node,
    wsl,
    await discoveryCheck(deps),
    await opentunePathCheck(deps),
    officialInstallCheck(deps, install),
    outcome('OT_VERSION_UNSUPPORTED', versionCheck(install, windows)),
    outcome('OT_MODELS_MISSING', await modelsCheck(install, { env: deps.env, fs }, windows)),
    outcome('OT_SIDECAR_INCOMPLETE', await sidecarCheck(exeDir, sidecar)),
    outcome('OT_MODELS_SHADOWED', await shadowedCheck(exeDir, sidecar)),
    outcome('OT_D3D12_NOT_COPIED', await d3d12Check(exeDir, { ...sidecar, officialDir: install?.dir ?? null })),
  ];
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
