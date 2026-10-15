// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Files of the mock's work directory: the source audio of the clips a `given` creates, and the
// files and paths it provides for the `files` precondition. The audio is generated at run time (a
// tone, or silence) and lives only in the work directory, which the mock deletes when it stops.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { projectBytes, singleClipProject } from './projectfile.js';

export const WAV_SAMPLE_RATE_HZ = 16_000;
const TONE_HZ = 220;

/** A mono 16-bit PCM WAV file: a tone, or silence. */
export function wavBytes(durationSec: number, voiced: boolean): Buffer {
  const samples = Math.round(durationSec * WAV_SAMPLE_RATE_HZ);
  const data = Buffer.alloc(samples * 2);
  if (voiced) {
    for (let i = 0; i < samples; i++) {
      data.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * TONE_HZ * i) / WAV_SAMPLE_RATE_HZ)), i * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(WAV_SAMPLE_RATE_HZ, 24);
  header.writeUInt32LE(WAV_SAMPLE_RATE_HZ * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export type GivenFileKind =
  'audio' | 'absent' | 'existing' | 'noAccess' | 'undecodable' | 'project' | 'projectMissingMedia';

export interface GivenFile {
  readonly bind: string;
  readonly kind: GivenFileKind;
  readonly extension?: string;
  readonly durationSec?: number;
}

/**
 * The work directory and the files in it. The directory is created on first use, below the
 * operating system's temporary directory, and removed by dispose().
 */
export class WorkFiles {
  #root: string | undefined;
  #seq = 0;
  readonly #created: string[] = [];
  readonly #denied = new Set<string>();

  /** `workDir`, if given, must exist; the mock then removes only the directories it made in it. */
  constructor(private readonly workDir?: string) {}

  /** A fresh sub-directory, so that two files never share a name. */
  #fresh(): string {
    this.#root ??= this.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ot-mock-files-'));
    const dir = path.join(this.#root, `d${String(++this.#seq)}`);
    fs.mkdirSync(dir, { recursive: true });
    this.#created.push(dir);
    return dir;
  }

  /** The source file of a clip: `durationSec` of a tone, or silence when the clip has no voice. */
  clipSource(label: string, durationSec: number, voiced: boolean): string {
    const file = path.join(this.#fresh(), `${label}.wav`);
    fs.writeFileSync(file, wavBytes(durationSec, voiced));
    return file;
  }

  /**
   * Provides a file of the `files` precondition and returns the names it binds. `existing` also
   * binds `<bind>.next`, the name a rename on collision writes (PROTOCOL.md section 19 rule 3).
   */
  provide(file: GivenFile): Record<string, string> {
    const isProject = file.kind === 'project' || file.kind === 'projectMissingMedia';
    const extension = file.extension ?? (isProject ? '.otproj' : '.wav');
    const dir = this.#fresh();
    const target = path.join(dir, `${file.bind}${extension}`);
    switch (file.kind) {
      case 'audio':
        fs.writeFileSync(target, wavBytes(file.durationSec ?? 1, true));
        return { [file.bind]: target };
      case 'existing':
        fs.writeFileSync(target, 'existing file');
        return { [file.bind]: target, [`${file.bind}.next`]: path.join(dir, `${file.bind} (2)${extension}`) };
      case 'undecodable':
        fs.writeFileSync(target, 'this is not audio');
        return { [file.bind]: target };
      case 'noAccess': {
        // A directory the instance cannot open. Permissions cannot express that on every system,
        // so the mock treats paths below this directory as unreadable.
        const locked = path.join(dir, 'locked');
        fs.mkdirSync(locked);
        this.#denied.add(locked);
        return { [file.bind]: path.join(locked, `${file.bind}${extension}`) };
      }
      case 'project':
      case 'projectMissingMedia': {
        // One clip on track 0 that shows a WAV file next to the project file; the second kind leaves the WAV out.
        const durationSec = file.durationSec ?? 1;
        const media = path.join(dir, `${file.bind}-media.wav`);
        if (file.kind === 'project') fs.writeFileSync(media, wavBytes(durationSec, true));
        fs.writeFileSync(target, projectBytes(singleClipProject(media, durationSec)));
        return { [file.bind]: target };
      }
      case 'absent':
        return { [file.bind]: target };
    }
  }

  /** The path lies in a directory the mock treats as unreadable. */
  isDenied(file: string): boolean {
    return [...this.#denied].some((dir) => file === dir || file.startsWith(`${dir}${path.sep}`));
  }

  dispose(): void {
    for (const dir of this.#created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    if (this.#root !== undefined && this.workDir === undefined) fs.rmSync(this.#root, { recursive: true, force: true });
    this.#root = undefined;
  }
}
