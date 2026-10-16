// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The MCP Inspector's CLI mode as a test client: every call starts the built bundle as a stdio
// server, runs one method and prints the result as JSON. The Inspector is a devDependency pinned
// to one version; it is an independent client of the protocol, so what it accepts is evidence that
// the bundle speaks MCP to a client other than the SDK the server is built with.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/** The launcher the package declares as its `inspector` bin, found through its package.json. */
function resolveLauncher(): string {
  const manifest = createRequire(import.meta.url).resolve('@modelcontextprotocol/inspector/package.json');
  const { bin, version } = JSON.parse(readFileSync(manifest, 'utf8')) as {
    bin?: string | Record<string, string>;
    version?: string;
  };
  const relative = typeof bin === 'string' ? bin : bin?.inspector;
  if (relative === undefined) {
    throw new Error(
      `@modelcontextprotocol/inspector ${version ?? '?'} declares no "inspector" bin; update test/support/inspector.ts`,
    );
  }
  return path.resolve(path.dirname(manifest), relative);
}

const LAUNCHER = resolveLauncher();

export interface InspectorRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout parsed as JSON; null when it is not JSON. */
  readonly json: unknown;
}

/** Runs `inspector --cli <node> <bundle> --method ...` and collects what it printed. */
export function inspect(
  bundle: string,
  serverEnv: Readonly<Record<string, string>>,
  method: string,
  options: {
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    /** The Inspector's own `--strict` schema portability check (tools/list only), reported as JSON. */
    strict?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<InspectorRun> {
  // The Inspector keeps a catalog and sign-in state in the user's directories: point every place it
  // could look (home, the Windows and XDG directories, its own catalog) into one empty directory, and
  // keep secrets in memory so the operating system's credential store is never opened.
  const home = mkdtempSync(path.join(os.tmpdir(), 'ot-inspector-'));
  const args = [LAUNCHER, '--cli'];
  for (const [key, value] of Object.entries(serverEnv)) args.push('-e', `${key}=${value}`);
  if (options.strict === true) args.push('--strict', '--format', 'json');
  args.push('--method', method);
  if (options.toolName !== undefined) args.push('--tool-name', options.toolName);
  if (options.toolArgs !== undefined) args.push('--tool-args-json', JSON.stringify(options.toolArgs));
  args.push(process.execPath, bundle);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_DATA_HOME: path.join(home, '.local', 'share'),
        XDG_STATE_HOME: path.join(home, '.local', 'state'),
        XDG_CACHE_HOME: path.join(home, '.cache'),
        MCP_CATALOG_PATH: path.join(home, 'mcp.json'),
        MCP_STORAGE_DIR: path.join(home, 'storage'),
        MCP_INSPECTOR_SECRET_STORE: 'memory',
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    // The one place that cleans up: stops the timer and removes the temporary home, once.
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rmSync(home, { recursive: true, force: true });
      settle();
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      finish(() => {
        reject(new Error(`the Inspector did not finish ${method} within ${String(options.timeoutMs ?? 60_000)} ms`));
      });
    }, options.timeoutMs ?? 60_000);
    child.on('error', (error) => {
      finish(() => {
        reject(error);
      });
    });
    child.on('close', (code) => {
      finish(() => {
        let json: unknown = null;
        try {
          json = JSON.parse(stdout);
        } catch {
          // Not JSON: the caller sees stdout.
        }
        resolve({ code, stdout, stderr, json });
      });
    });
  });
}
