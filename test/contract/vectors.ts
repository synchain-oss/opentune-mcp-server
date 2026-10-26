// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Loads every vector in spec/otcp/v1/vectors and checks it against schemas/vector.schema.json and
// the naming rule (the id is the file path without .json).

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { SPEC_ROOT, otcpSpec } from '../support/otcp-spec.js';

export type Step = Readonly<Record<string, unknown>> & { readonly connection?: string };

export interface Vector {
  readonly id: string;
  readonly type: 'request' | 'scenario';
  readonly description: string;
  readonly capability: string;
  readonly extraCapabilities?: readonly string[];
  readonly since: string;
  readonly method?: string;
  readonly session: 'authenticated' | 'unauthenticated';
  readonly given?: Readonly<Record<string, unknown>>;
  readonly request?: unknown;
  readonly paramsValid?: boolean;
  readonly response?: unknown;
  readonly connectionAfter?: 'open' | 'closed';
  /** The last step makes the instance quit by itself (vectors/README.md, "Vectors that end the instance"). */
  readonly endsSession?: boolean;
  readonly steps?: readonly Step[];
}

export interface LoadedVector {
  /** `<area>/<slug>` from the file path. */
  readonly id: string;
  readonly vector: Vector;
  /** Why the file is not a valid vector; empty when it is. */
  readonly problems: readonly string[];
}

export const VECTORS_DIR = path.join(SPEC_ROOT, 'vectors');

export function loadVectors(): LoadedVector[] {
  const spec = otcpSpec();
  const loaded: LoadedVector[] = [];
  const areas = readdirSync(VECTORS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const area of areas.map((e) => e.name).sort()) {
    for (const file of readdirSync(path.join(VECTORS_DIR, area))
      .filter((f) => f.endsWith('.json'))
      .sort()) {
      const id = `${area}/${file.slice(0, -'.json'.length)}`;
      const vector = JSON.parse(readFileSync(path.join(VECTORS_DIR, area, file), 'utf8')) as Vector;
      const problems = spec.validate('schemas/vector.schema.json', vector);
      if (vector.id !== id) problems.push(`id ${JSON.stringify(vector.id)} differs from the file path ${id}`);
      loaded.push({ id, vector, problems });
    }
  }
  return loaded;
}
