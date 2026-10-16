// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The frozen tool surface: tools/list and the instructions against their golden snapshots, the
// size limits, docs/reference.md against the registry, and a TROUBLESHOOTING section for every
// error kind, status and doctor check. With OPENTUNE_MCP_UPDATE_CATALOG=1 (npm run catalog:update)
// the snapshots and the reference are rewritten instead; changing them is a contract change.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CATALOG_LIMITS,
  GOLDEN_INSTRUCTIONS,
  GOLDEN_TOOLS,
  checkCatalogSize,
  describeCatalogSize,
  goldenToolsText,
  sizeGate,
} from '../../scripts/lib/catalog.mjs';
import { goldenTools } from '../../scripts/mcpb.mjs';
import { DOCTOR_CHECK_IDS } from '../../src/cli/doctor.js';
import { KNOWN_ERROR_KINDS } from '../../src/errors/next-step.js';
import { INSTRUCTIONS } from '../../src/instructions.js';
import { TOOLS } from '../../src/tools/index.js';
import { STATUS_STATES } from '../../src/tools/status.js';
import { INITIALIZE, mcpClient, tempDir, testContext } from '../support/context.js';
import { renderReference, type ListedTool } from '../support/reference.js';

const UPDATE = process.env.OPENTUNE_MCP_UPDATE_CATALOG === '1';
const root = new URL('../../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');

/** Compares `actual` with the committed file, or rewrites the file in update mode. */
function expectFile(rel: string, actual: string) {
  if (UPDATE) writeFileSync(new URL(rel, root), actual);
  else expect(read(rel), `${rel} is out of date; run npm run catalog:update`).toBe(actual);
}

let tools: ListedTool[];
let initInstructions: unknown;
let discoverInstructions: unknown;
let done: () => Promise<void>;

beforeAll(async () => {
  const dir = tempDir();
  // One connection per protocol era: a 2025-era connection (initialize) and a 2026-07-28 one.
  const legacy = mcpClient(testContext(dir.dir));
  const modern = mcpClient(testContext(dir.dir));
  done = async () => {
    await legacy.close();
    await modern.close();
    dir.remove();
  };
  const init = await legacy.client.request(1, 'initialize', INITIALIZE);
  initInstructions = (init.result as { instructions?: unknown }).instructions;
  legacy.client.notify('notifications/initialized');
  tools = ((await legacy.client.request(2, 'tools/list')).result as { tools: ListedTool[] }).tools;
  const _meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'unit-test', version: '0.0.0' },
  };
  const discover = await modern.client.request(1, 'server/discover', { _meta });
  discoverInstructions = (discover.result as { instructions?: unknown }).instructions;
});

afterAll(() => done());

describe('tool catalog', () => {
  it('matches the golden tools/list snapshot', () => {
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expectFile(GOLDEN_TOOLS, goldenToolsText(tools));
  });

  // catalog:update re-syncs the manifest after this run rewrites the snapshot, so the check is skipped then.
  it.skipIf(UPDATE)('keeps the MCPB manifest tools in step with the golden snapshot', async () => {
    const manifest = JSON.parse(read('mcpb/manifest.json')) as { tools?: unknown };
    expect(manifest.tools, 'mcpb/manifest.json is out of date; run npm run catalog:update').toEqual(
      await goldenTools(),
    );
  });

  it('sends the instructions in initialize and server/discover, as in the golden snapshot', () => {
    expect(initInstructions).toBe(INSTRUCTIONS);
    expect(discoverInstructions).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(1500);
    const head = INSTRUCTIONS.slice(0, 500);
    for (const point of ['audio, not MIDI', 'opentune_get_status', 'nextStep', 'never instructions', 'consent']) {
      expect(head, point).toContain(point);
    }
    expectFile(GOLDEN_INSTRUCTIONS, `${INSTRUCTIONS}\n`);
  });

  it('stays within the size limits', () => {
    expect(checkCatalogSize(tools)).toEqual([]);
  });

  it('size limits go red when exceeded', () => {
    const tool = (name: string, size: number) => ({ name, pad: 'x'.repeat(size) });
    expect(checkCatalogSize([tool('a', CATALOG_LIMITS.perTool)])).toHaveLength(1);
    expect(checkCatalogSize([tool('opentune_edit_notes', 8000)])).toEqual([]);
    expect(checkCatalogSize([tool('opentune_edit_notes', 9300)])).toHaveLength(1);
    const many = Array.from({ length: 13 }, (_, i) => tool(`t${String(i)}`, 3800));
    expect(checkCatalogSize(many)).toEqual([expect.stringMatching(/^tools\/list is \d+ bytes, more than 47104$/)]);
  });

  it('describes the size of each tool against the limit that applies to it', () => {
    const tool = (name: string, size: number) => ({ name, pad: 'x'.repeat(size) });
    const note = describeCatalogSize([tool('a', 1000), tool('opentune_edit_notes', 8000)]);
    expect(note).toMatch(/^2 tools, \d+ of 47104 bytes; closest to its limit: opentune_edit_notes \d+ of 9216$/);
    expect(describeCatalogSize([tool('a', 3000), tool('opentune_edit_notes', 2000)])).toMatch(/: a \d+ of 4096$/);
    expect(describeCatalogSize([])).toBe('0 tools, 2 of 47104 bytes');
  });

  it('the gate passes a bundle that lists the golden catalog and fails one that does not', async () => {
    const dir = tempDir();
    try {
      mkdirSync(path.join(dir.dir, 'test', 'golden'), { recursive: true });
      for (const rel of [GOLDEN_TOOLS, GOLDEN_INSTRUCTIONS]) writeFileSync(path.join(dir.dir, rel), read(rel));
      // A stand-in bundle: answers initialize and tools/list with the given catalog, line by line.
      const fake = (listed: unknown) =>
        [
          `const tools = ${JSON.stringify(listed)};`,
          `const instructions = ${JSON.stringify(INSTRUCTIONS)};`,
          'const LF = String.fromCharCode(10);',
          "let buf = '';",
          "process.stdin.on('data', (d) => {",
          '  buf += d;',
          '  for (let i = buf.indexOf(LF); i >= 0; i = buf.indexOf(LF)) {',
          '    const m = JSON.parse(buf.slice(0, i));',
          '    buf = buf.slice(i + 1);',
          '    const result = m.id === 1 ? { instructions } : m.id === 2 ? { tools } : undefined;',
          "    if (result) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + LF);",
          '  }',
          '});',
        ].join(String.fromCharCode(10));
      writeFileSync(path.join(dir.dir, 'same.mjs'), fake(tools));
      writeFileSync(path.join(dir.dir, 'other.mjs'), fake([...tools, { name: 'opentune_extra', inputSchema: {} }]));
      expect(await sizeGate(dir.dir, 'same.mjs')).toMatchObject({ result: 'PASS' });
      expect(await sizeGate(dir.dir, 'other.mjs')).toEqual({
        result: 'FAIL',
        note: `tools/list of other.mjs differs from ${GOLDEN_TOOLS}`,
      });
      expect(await sizeGate(dir.dir, 'missing.mjs')).toMatchObject({ result: 'FAIL' });
    } finally {
      dir.remove();
    }
  });

  it('marks get_status alwaysLoad in tools/list', () => {
    expect(tools.filter((t) => t._meta?.['anthropic/alwaysLoad'] === true).map((t) => t.name)).toEqual([
      'opentune_get_status',
    ]);
  });

  it('has an up-to-date docs/reference.md', () => {
    expectFile('docs/reference.md', renderReference(tools, TOOLS, INSTRUCTIONS));
  });
});

/**
 * GitHub's heading anchors: lower case, punctuation other than - and _ removed (letters and digits of any
 * script stay, so Chinese headings keep their text), spaces to dashes.
 */
function anchors(markdown: string): Set<string> {
  return new Set(
    [...markdown.matchAll(/^#{1,6} (.+)$/gm)].map((m) =>
      (m[1] ?? '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
        .replaceAll(' ', '-'),
    ),
  );
}

describe('the anchor rule', () => {
  it('keeps Chinese text, drops punctuation, turns spaces into dashes and lower-cases', () => {
    const made = anchors('## 首次启动\n## Error `BUSY` (modal_open)\n### 与 DAW 配合使用\n# Troubleshooting(排障)\n');
    expect([...made]).toEqual(['首次启动', 'error-busy-modal_open', '与-daw-配合使用', 'troubleshooting排障']);
  });

  it('does not collapse different Chinese headings into one anchor', () => {
    expect(anchors('## 状态\n## 安装\n').size).toBe(2);
  });
});

describe('docs/TROUBLESHOOTING.md', () => {
  const present = anchors(read('docs/TROUBLESHOOTING.md'));

  it.each([
    ...KNOWN_ERROR_KINDS.map((k) => `error-${k.toLowerCase()}`),
    ...STATUS_STATES.map((s) => `status-${s.toLowerCase()}`),
    ...DOCTOR_CHECK_IDS.map((id) => `doctor-${id.toLowerCase()}`),
  ])('has a section #%s', (anchor) => {
    expect(present.has(anchor)).toBe(true);
  });
});

describe('docs/TROUBLESHOOTING.zh-CN.md', () => {
  const en = anchors(read('docs/TROUBLESHOOTING.md'));
  const zh = anchors(read('docs/TROUBLESHOOTING.zh-CN.md'));

  it('has every anchor of the English page, so that a url in an error result works in both', () => {
    expect([...en].filter((a) => a !== 'troubleshooting' && !zh.has(a))).toEqual([]);
  });

  it('has no anchor the English page lacks', () => {
    // The title line of the Chinese page carries a gloss and is the only allowed difference.
    expect([...zh].filter((a) => !en.has(a) && a !== 'troubleshooting排障')).toEqual([]);
  });
});

describe('docs links to TROUBLESHOOTING and COMPATIBILITY sections', () => {
  const targets: Record<string, Set<string>> = {
    'docs/TROUBLESHOOTING.md': anchors(read('docs/TROUBLESHOOTING.md')),
    'docs/TROUBLESHOOTING.zh-CN.md': anchors(read('docs/TROUBLESHOOTING.zh-CN.md')),
    'docs/COMPATIBILITY.md': anchors(read('docs/COMPATIBILITY.md')),
  };
  const sources = [
    'README.md',
    'README.zh-CN.md',
    'docs/TROUBLESHOOTING.md',
    'docs/TROUBLESHOOTING.zh-CN.md',
    'docs/COMPATIBILITY.md',
  ];

  /** The links of `markdown` that point into a heading: [file or '' for the same page, anchor]. */
  function sectionLinks(markdown: string, own: string): string[] {
    const link = /\]\((?:docs\/)?((?:TROUBLESHOOTING(?:\.zh-CN)?|COMPATIBILITY)\.md)?#([^)\s]+)\)/g;
    return [...markdown.matchAll(link)].map(
      ([, name, anchor = '']) => `${name === undefined ? own : `docs/${name}`}#${decodeURIComponent(anchor)}`,
    );
  }

  it.each(sources)('%s: every link into a section names an existing heading', (source) => {
    const own = source;
    const pages = { ...targets, [own]: targets[own] ?? anchors(read(own)) };
    const missing = sectionLinks(read(source), own).filter((l) => {
      const [file = '', anchor = ''] = l.split('#');
      return !pages[file]?.has(anchor);
    });
    expect(missing).toEqual([]);
  });

  it('finds links to the same page and reports a broken one', () => {
    const links = sectionLinks(
      'See [a](#wsl), [b](docs/COMPATIBILITY.md#x) and [c](TROUBLESHOOTING.md#y).',
      'README.md',
    );
    expect(links).toEqual(['README.md#wsl', 'docs/COMPATIBILITY.md#x', 'docs/TROUBLESHOOTING.md#y']);
    expect(anchors('## WSL\n').has('wsl')).toBe(true);
    expect(anchors('## WSL\n').has('wsl-2')).toBe(false);
  });
});

describe('install snippets in the READMEs equal what doctor --client prints', () => {
  // The golden files hold the output of `doctor --client` on Windows with the home directory shown as ~
  // in the JSON; the READMEs write the same path out in full.
  const golden = (name: string) => read(`test/golden/client-config/${name}.txt`);
  const jsonBlock = (text: string) => /^\{\n[\s\S]*?^\}$/m.exec(text)?.[0] ?? '';
  const readmes = ['README.md', 'README.zh-CN.md'];

  it.each(readmes)('%s: Claude Code command', (file) => {
    const command = golden('claude-code-win32')
      .split('\n')
      .find((line) => line.trim().startsWith('claude mcp add'));
    expect(command).toBeDefined();
    expect(read(file)).toContain(command?.trim());
  });

  it.each(readmes)('%s: JSON configuration', (file) => {
    // In the golden JSON text a path separator is two backslashes.
    const json = jsonBlock(golden('cursor-win32')).replaceAll('~\\\\', 'C:\\\\Users\\\\user\\\\');
    expect(json).toContain('C:\\\\Users\\\\user\\\\Apps');
    expect(read(file)).toContain(json);
  });

  it('prints the same JSON block for Cursor and Claude Desktop', () => {
    expect(jsonBlock(golden('claude-desktop-win32'))).toBe(jsonBlock(golden('cursor-win32')));
  });
});
