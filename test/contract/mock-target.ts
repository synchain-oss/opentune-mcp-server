// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The mock target: a fresh mock instance per vector, with its discovery file in a temporary
// directory of its own, so every vector starts from the same state and sees no other client.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startMock, UnsupportedPrecondition, type Given, type MockOptions } from '../../mock/server.js';
import { PreconditionUnavailable, type ContractTarget } from './target.js';

export function mockTarget(options: Omit<MockOptions, 'discoveryDir'> = {}): ContractTarget {
  return {
    name: 'mock',
    async open() {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'ot-mock-'));
      const mock = await startMock({ ...options, discoveryDir: dir });
      // Read back like any client would, from the file the instance wrote.
      const discovery = JSON.parse(await readFile(mock.discoveryPath, 'utf8')) as Record<string, unknown>;
      return {
        discovery,
        protocol: '1.0',
        capabilities: mock.capabilities,
        establish(given) {
          try {
            return Promise.resolve(mock.given(given as Given));
          } catch (error) {
            if (error instanceof UnsupportedPrecondition) throw new PreconditionUnavailable(error.message);
            throw error;
          }
        },
        runnerValue: () => undefined,
        async close() {
          await mock.stop();
          await rm(dir, { recursive: true, force: true });
        },
      };
    },
  };
}
