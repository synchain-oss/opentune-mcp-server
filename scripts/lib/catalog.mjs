// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The tool catalog as clients see it (tools/list) and its size limits. Used by the gates, which
// check the built bundle, and by test/unit/catalog.test.ts, which checks the sources and writes the
// golden snapshot and docs/reference.md.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Size limits of tools/list, in bytes of compact JSON (UTF-8). */
export const CATALOG_LIMITS = Object.freeze({
  total: 46 * 1024,
  perTool: 4 * 1024,
  /** Tools with a larger allowance. */
  perToolExceptions: Object.freeze({ opentune_edit_notes: 9 * 1024 }),
});

export const GOLDEN_TOOLS = 'test/golden/tools-list.json';
export const GOLDEN_INSTRUCTIONS = 'test/golden/instructions.txt';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Problems with the size of a tools/list `tools` array; empty when every limit holds. */
export function checkCatalogSize(tools, limits = CATALOG_LIMITS) {
  const problems = [];
  const total = bytes(tools);
  if (total > limits.total) problems.push(`tools/list is ${String(total)} bytes, more than ${String(limits.total)}`);
  for (const tool of tools) {
    const limit = limitOf(tool, limits);
    const size = bytes(tool);
    if (size > limit) problems.push(`${String(tool.name)} is ${String(size)} bytes, more than ${String(limit)}`);
  }
  return problems;
}

/** The size limit that applies to one tool: its own allowance, or the common per-tool limit. */
const limitOf = (tool, limits) => limits.perToolExceptions[tool.name] ?? limits.perTool;

/**
 * One-line description of the sizes, for a PASS note. The largest tool is the one closest to its
 * own limit (opentune_edit_notes has a bigger allowance than the others), shown against that limit.
 */
export function describeCatalogSize(tools, limits = CATALOG_LIMITS) {
  const share = (tool) => bytes(tool) / limitOf(tool, limits);
  const tightest = [...tools].sort((a, b) => share(b) - share(a))[0];
  return (
    `${String(tools.length)} tools, ${String(bytes(tools))} of ${String(limits.total)} bytes` +
    (tightest
      ? `; closest to its limit: ${String(tightest.name)} ${String(bytes(tightest))} of ${String(limitOf(tightest, limits))}`
      : '')
  );
}

/** The golden file content for a tools array. */
export const goldenToolsText = (tools) => `${JSON.stringify(tools, null, 2)}\n`;

/**
 * Starts the built bundle, performs the initialize handshake and returns the tools/list tools and
 * the instructions. The bundle runs with an empty discovery directory override so that nothing it
 * might read belongs to a real OpenTune installation.
 */
export function bundleCatalog(bundle, discoveryDir, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OPENTUNE_MCP_DISCOVERY_DIR: discoveryDir },
    });
    const replies = new Map();
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the bundle did not answer within ${String(timeoutMs)} ms; stderr: ${stderr}`));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    const request = (id, method, params = {}) =>
      new Promise((done) => {
        replies.set(id, done);
        send({ id, method, params });
      });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        replies.get(message.id)?.(message);
      }
    });
    (async () => {
      const init = await request(1, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'gates', version: '0.0.0' },
      });
      send({ method: 'notifications/initialized' });
      const list = await request(2, 'tools/list');
      child.stdin.end();
      clearTimeout(timer);
      if (init.error || list.error)
        throw new Error(`the bundle answered with an error: ${JSON.stringify(init.error ?? list.error)}`);
      return { tools: list.result.tools, instructions: init.result.instructions ?? null };
    })().then(resolve, (error) => {
      clearTimeout(timer);
      child.kill();
      reject(error);
    });
  });
}

/** Gates check: the bundle's tools/list equals the golden snapshot and stays within the size limits. */
export async function sizeGate(root, bundle) {
  const bundlePath = path.join(root, bundle);
  try {
    await fs.access(bundlePath);
  } catch {
    return { result: 'FAIL', note: `${bundle} is missing; run the build first` };
  }
  await fs.mkdir(path.join(root, '.cache'), { recursive: true });
  const empty = await fs.mkdtemp(path.join(root, '.cache', 'catalog-'));
  try {
    const { tools, instructions } = await bundleCatalog(bundlePath, empty);
    const problems = checkCatalogSize(tools);
    const golden = await fs.readFile(path.join(root, GOLDEN_TOOLS), 'utf8').catch(() => null);
    if (golden !== goldenToolsText(tools)) problems.push(`tools/list of ${bundle} differs from ${GOLDEN_TOOLS}`);
    const goldenInstructions = await fs.readFile(path.join(root, GOLDEN_INSTRUCTIONS), 'utf8').catch(() => null);
    if (goldenInstructions !== `${String(instructions)}\n`)
      problems.push(`instructions differ from ${GOLDEN_INSTRUCTIONS}`);
    if (problems.length > 0) return { result: 'FAIL', note: problems.join('; ') };
    return {
      result: 'PASS',
      note: `${describeCatalogSize(tools)}; tools/list and instructions equal the golden snapshots`,
    };
  } finally {
    await fs.rm(empty, { recursive: true, force: true });
  }
}
