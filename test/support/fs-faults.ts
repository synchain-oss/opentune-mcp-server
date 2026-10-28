// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// File system faults for tests of the mock, which writes its files with node:fs.

import fs from 'node:fs';

import { vi } from 'vitest';

/**
 * Makes the write of any temporary file (a name ending in .tmp) fail with EACCES, the way a read-only or full folder
 * does; every other write goes through. The spy is removed by vi.restoreAllMocks().
 */
export function failTemporaryWrites(): void {
  const written = fs.writeFileSync.bind(fs);
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
    if (typeof file === 'string' && file.endsWith('.tmp')) {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }
    written(file, data, options);
  });
}
