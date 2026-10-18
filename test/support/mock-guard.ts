// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Guard for the rule that the mock answers from the specification's semantics and its own state,
// never from the contract vectors: no code of mock/, and no module it imports, may name the
// vectors directory or load vectors. The check reads source text, so planting a reference in any
// of those files turns it red (test/unit/mock-guard.test.ts shows it does).

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The directory of the vectors, the loaders of the contract tests, and file names of vectors. */
const FORBIDDEN = /\bvectors\b|VECTORS_DIR|loadVectors|contract[\\/]vectors|vectors\.(?:js|ts|json)/i;
const IMPORT = /(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

/** Source text without its comments, so that prose about the vectors is no reference. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** The module at `entry` and every module it imports through relative specifiers, by repository path. */
export function collectSources(
  entry: string,
  read: (file: string) => string | undefined = (file) => {
    try {
      return readFileSync(path.join(REPO_ROOT, file), 'utf8');
    } catch {
      return undefined;
    }
  },
): Map<string, string> {
  const found = new Map<string, string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (found.has(file)) continue;
    const text = read(file);
    if (text === undefined) continue;
    found.set(file, text);
    for (const match of stripComments(text).matchAll(IMPORT)) {
      const specifier = match[1] ?? '';
      queue.push(path.posix.join(path.posix.dirname(file), specifier).replace(/\.js$/, '.ts'));
    }
  }
  return found;
}

/** Every `mock/*.ts` file with the modules it imports. */
export function mockSources(): Map<string, string> {
  const all = new Map<string, string>();
  const dir = path.join(REPO_ROOT, 'mock');
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    for (const [file, text] of collectSources(`mock/${name}`)) all.set(file, text);
  }
  return all;
}

/** Where the sources name the vectors: `<file>: <the offending line>`. Empty when they do not. */
export function vectorReferences(sources: ReadonlyMap<string, string>): string[] {
  const hits: string[] = [];
  for (const [file, text] of sources) {
    for (const line of stripComments(text).split('\n')) {
      if (FORBIDDEN.test(line)) hits.push(`${file}: ${line.trim()}`);
    }
  }
  return hits;
}
