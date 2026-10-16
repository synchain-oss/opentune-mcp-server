// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The MCP Inspector's CLI mode as a test client: every call starts the built bundle as a stdio
// server, runs one method and prints the result as JSON. The Inspector is a devDependency pinned
// to one version; it is an independent client of the protocol, so what it accepts is evidence that
// the bundle speaks MCP to a client other than the SDK the server is built with.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LAUNCHER = fileURLToPath(
  new URL('../../node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js', import.meta.url),
);

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
  // The Inspector keeps a catalog and sign-in state under the home directory: give it an empty one.
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
      env: { ...process.env, HOME: home, USERPROFILE: home, MCP_CATALOG_PATH: path.join(home, 'mcp.json') },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the Inspector did not finish ${method} within ${String(options.timeoutMs ?? 60_000)} ms`));
    }, options.timeoutMs ?? 60_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      rmSync(home, { recursive: true, force: true });
      let json: unknown = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        // Not JSON: the caller sees stdout.
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}
