// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The writer behind opentune_get_notes output_path: a new file that never replaces another, written
// through a temporary file in the same folder, with the branches of a real disk (a name that is taken,
// a file system without hard links, a failing write) reached through the FileOps seam.

import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FileWriteError,
  MAX_RENAME_INDEX,
  folderOf,
  realFiles,
  writeNewFile,
  type FileOps,
} from '../../src/tools/notes-file.js';
import { tempDir } from '../support/context.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function folder(): string {
  const t = tempDir('ot-notes-file-');
  cleanup.push(t.remove);
  return t.dir;
}

const errno = (code: string): Error => Object.assign(new Error(code), { code });

/** The real file system with some calls replaced, and a log of what the writer asked for. */
function ops(overrides: Partial<FileOps> = {}): { ops: FileOps; calls: string[] } {
  const calls: string[] = [];
  const wrap =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      calls.push(name);
      return fn(...args);
    };
  return {
    calls,
    ops: {
      kindOf: wrap('kindOf', overrides.kindOf ?? realFiles.kindOf),
      create: wrap('create', overrides.create ?? realFiles.create),
      link: wrap('link', overrides.link ?? realFiles.link),
      copyNew: wrap('copyNew', overrides.copyNew ?? realFiles.copyNew),
      remove: wrap('remove', overrides.remove ?? realFiles.remove),
    },
  };
}

const system = process.platform === 'win32' ? 'windows' : 'posix';

describe('folderOf', () => {
  it('keeps a root whole and cuts the last segment elsewhere', () => {
    expect(folderOf('C:\\a.json', 'windows')).toBe('C:\\');
    expect(folderOf('C:\\Music\\a.json', 'windows')).toBe('C:\\Music');
    expect(folderOf('/a.json', 'posix')).toBe('/');
    expect(folderOf('/home/user/a.json', 'posix')).toBe('/home/user');
  });
});

describe('writeNewFile', () => {
  it('writes the data under the name asked for and leaves no temporary file', async () => {
    const dir = folder();
    const target = path.join(dir, 'notes.json');
    const written = await writeNewFile(target, '{"a":1}\n', system);
    expect(written).toEqual({ path: target, renamed: false });
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}\n');
    expect(readdirSync(dir)).toEqual(['notes.json']);
  });

  it('takes the next free numbered name and never touches a file that exists', async () => {
    const dir = folder();
    const target = path.join(dir, 'notes.json');
    writeFileSync(target, 'precious');
    writeFileSync(path.join(dir, 'notes (2).json'), 'also precious');
    const written = await writeNewFile(target, 'new', system);
    expect(written).toEqual({ path: path.join(dir, 'notes (3).json'), renamed: true });
    expect(readFileSync(target, 'utf8')).toBe('precious');
    expect(readFileSync(path.join(dir, 'notes (2).json'), 'utf8')).toBe('also precious');
    expect(readFileSync(written.path, 'utf8')).toBe('new');
    expect(readdirSync(dir).sort()).toEqual(['notes (2).json', 'notes (3).json', 'notes.json']);
  });

  it('keeps the case of the extension in the numbered name', async () => {
    const dir = folder();
    const target = path.join(dir, 'Take 1.JSON');
    writeFileSync(target, 'x');
    expect((await writeNewFile(target, 'y', system)).path).toBe(path.join(dir, 'Take 1 (2).JSON'));
  });

  it('does not follow a link that sits at the name: a dangling symbolic link counts as taken', async () => {
    const dir = folder();
    const target = path.join(dir, 'notes.json');
    const aim = path.join(dir, 'aim.json');
    try {
      // A directory link works without privileges on Windows when it is a junction; a file link may not.
      symlinkSync(aim, target);
    } catch {
      return; // symbolic links are not available here
    }
    const written = await writeNewFile(target, 'new', system);
    expect(written.renamed).toBe(true);
    expect(readdirSync(dir).includes('aim.json')).toBe(false);
  });

  it('falls back to a copy that fails on an existing name when the file system has no hard links', async () => {
    const dir = folder();
    const target = path.join(dir, 'notes.json');
    writeFileSync(target, 'precious');
    const { ops: seam, calls } = ops({
      link: () => Promise.reject(errno('EPERM')),
    });
    const written = await writeNewFile(target, 'copied', system, seam);
    expect(written).toEqual({ path: path.join(dir, 'notes (2).json'), renamed: true });
    expect(calls.filter((c) => c === 'copyNew')).toHaveLength(2);
    expect(readFileSync(target, 'utf8')).toBe('precious');
    expect(readFileSync(written.path, 'utf8')).toBe('copied');
    expect(readdirSync(dir).sort()).toEqual(['notes (2).json', 'notes.json']);
  });

  it('fails without a trace when the copy fails for another reason than a taken name', async () => {
    const dir = folder();
    const { ops: seam } = ops({
      link: () => Promise.reject(errno('ENOTSUP')),
      copyNew: () => Promise.reject(errno('EACCES')),
    });
    await expect(writeNewFile(path.join(dir, 'notes.json'), 'x', system, seam)).rejects.toMatchObject({
      kind: 'io',
      code: 'EACCES',
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes the half-written file a failed copy leaves at the name, and only then', async () => {
    const dir = folder();
    const target = path.join(dir, 'notes.json');
    const removed: string[] = [];
    const { ops: seam } = ops({
      link: () => Promise.reject(errno('EPERM')),
      copyNew: (_source, name) => {
        writeFileSync(name, '{"half');
        return Promise.reject(errno('ENOSPC'));
      },
      remove: async (file) => {
        removed.push(file);
        await realFiles.remove(file);
      },
    });
    const failure = await writeNewFile(target, '{"whole":true}', system, seam).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(FileWriteError);
    expect(failure).toMatchObject({ kind: 'io', code: 'ENOSPC' });
    // The half-written target and the temporary file are both gone, and no other name was touched.
    expect(removed).toHaveLength(2);
    expect(removed).toContain(target);
    expect(removed.find((file) => file !== target)).toMatch(/.[0-9a-f]{16}.tmp$/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('keeps a file that was there before, and reports the copy failure when the clean-up fails too', async () => {
    const dir = folder();
    const target = path.join(dir, 'notes.json');
    writeFileSync(target, 'precious');
    const removed: string[] = [];
    let copies = 0;
    const { ops: seam } = ops({
      link: () => Promise.reject(errno('EPERM')),
      copyNew: (_source, name) => {
        copies += 1;
        // The first name is taken (EEXIST: nothing of ours to clean up); the second fails halfway.
        if (copies === 1) return Promise.reject(errno('EEXIST'));
        writeFileSync(name, 'half');
        return Promise.reject(errno('EIO'));
      },
      remove: async (file) => {
        removed.push(file);
        if (file !== target && !file.endsWith('.tmp')) throw errno('EBUSY');
        await realFiles.remove(file);
      },
    });
    const failure = await writeNewFile(target, 'x', system, seam).catch((e: unknown) => e);
    // The failed removal of the half-written second name (EBUSY) does not replace the error of the copy (EIO).
    expect(failure).toMatchObject({ kind: 'io', code: 'EIO' });
    expect(removed).toContain(path.join(dir, 'notes (2).json'));
    expect(removed).not.toContain(target);
    expect(readFileSync(target, 'utf8')).toBe('precious');
  });

  it('removes the temporary file when creating it fails halfway', async () => {
    const dir = folder();
    const removed: string[] = [];
    const { ops: seam } = ops({
      create: (file) => {
        writeFileSync(file, 'half');
        return Promise.reject(errno('ENOSPC'));
      },
      remove: async (file) => {
        removed.push(file);
        await realFiles.remove(file);
      },
    });
    const failure = await writeNewFile(path.join(dir, 'notes.json'), 'x', system, seam).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(FileWriteError);
    expect(failure).toMatchObject({ kind: 'io', code: 'ENOSPC' });
    expect(removed).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('gives up with names_taken after the last numbered name and removes the temporary file', async () => {
    const dir = folder();
    const taken = new Set<string>();
    const { ops: seam } = ops({
      link: (_existing, target) => {
        taken.add(target);
        return Promise.reject(errno('EEXIST'));
      },
    });
    await expect(writeNewFile(path.join(dir, 'notes.json'), 'x', system, seam)).rejects.toMatchObject({
      kind: 'names_taken',
    });
    expect(taken.size).toBe(MAX_RENAME_INDEX);
    expect([...taken].at(-1)).toBe(path.join(dir, `notes (${String(MAX_RENAME_INDEX)}).json`));
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reports a vanished folder as an io failure', async () => {
    const dir = folder();
    const { ops: seam } = ops({
      link: () => Promise.reject(errno('ENOENT')),
      copyNew: () => Promise.reject(errno('ENOENT')),
    });
    await expect(writeNewFile(path.join(dir, 'notes.json'), 'x', system, seam)).rejects.toMatchObject({
      kind: 'io',
      code: 'ENOENT',
    });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('realFiles', () => {
  it('tells a folder, a missing path and a file apart, and removes a file that is already gone quietly', async () => {
    const dir = folder();
    const file = path.join(dir, 'a.json');
    writeFileSync(file, '{}');
    mkdirSync(path.join(dir, 'sub'));
    expect(await realFiles.kindOf(dir)).toBe('directory');
    expect(await realFiles.kindOf(file)).toBe('other');
    expect(await realFiles.kindOf(path.join(dir, 'missing'))).toBe('missing');
    // A path below a file is missing, not an error.
    expect(await realFiles.kindOf(path.join(file, 'below'))).toBe('missing');
    await realFiles.remove(file);
    await realFiles.remove(file);
    expect(readdirSync(dir)).toEqual(['sub']);
  });

  it('creates a file only when it does not exist yet', async () => {
    const dir = folder();
    const file = path.join(dir, 'a.json');
    await realFiles.create(file, 'one');
    await expect(realFiles.create(file, 'two')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(file, 'utf8')).toBe('one');
  });
});
