// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The two folders this server keeps next to a project file, and the only file system work it does in
// them: `<name>.autosave` holds numbered copies of the project that opentune_save_project writes with
// mode autosave (the newest 10 are kept), and `<name>.oldversion` holds the earlier content of a project
// file that a save is about to replace (the newest 10 are kept). `<name>` is the file name without
// `.otproj`.
//
// The path policy of these operations: they run only on a project file whose path passed the rules of
// spec/otcp/v1/PROTOCOL.md section 20.1, they create at most the two folders directly below that file's
// directory (and a media folder inside `.oldversion`, see below), they write only files inside them, and they
// delete only a regular file in them whose name matches the pattern of its folder for this project name. Such a
// file counts as a copy or an old version of this project and can be deleted by the roll, whoever put it there. A
// directory (a media folder among them), a link, another project's copies and every file with any other name are
// never touched, whatever else the folder holds, with one exception: when the roll of the autosave copies deletes a
// copy, it deletes the media folder of that copy together with it (removeMediaFolder: the regular files in the one
// folder whose path is computed from the name of the copy, never a pattern, then the folder if it is empty), because
// OpenTune gives every copy a full set of its audio in a folder of its own and nothing else would ever delete it. A
// folder, once made, otherwise stays: when the save it was made for is refused, an empty `.oldversion` folder can
// remain, on purpose, because deleting directories is outside what this module does. The names come from this module,
// never from a tool argument.
//
// The audio of an old version: an old version names its audio relative to the folder it is in, so it finds the
// audio only in a media folder of the same name inside `<name>.oldversion`. OpenTune names the media folder of a
// project file after it, `<name>_Media`, next to the file (specification 1.0.0-rc.9). A project file that an earlier
// OpenTune saved names its audio in a folder `Project_Media` that every project file of the directory shared. So
// whenever an old version is made (or reused), the regular files of the media folder next to the project file that
// is being copied are copied into the folder of the same name inside `<name>.oldversion`: `<name>_Media` when it
// exists, else `Project_Media`. A file is written only when it is missing there or older than its source, never
// deleted, never overwritten when newer, and links and sub-folders are not followed. Which files a project file
// uses can only be told by reading the project file, and this module does not depend on the structure of
// OpenTune's files, so it copies the whole folder. A `<name>_Media` folder holds the audio of this project file
// only; the folder `Project_Media` is shared by every project file in the same directory, so the audio of the other
// projects in it is copied too, and every project file has an oldversion folder of its own, so the space taken grows
// with the number of project files in one directory. The roll of the old versions never touches these folders, so
// they only grow. The only file there that is ever deleted is the part of a copy that failed while this attempt
// wrote it.
//
// The copy has a time budget (MEDIA_COPY_BUDGET_MS), checked between files: when it is used up, the files that are
// left are not copied and are reported as not copied (`timedOut`); the next save copies them, because only files that
// are missing or older are copied.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { splitPath } from '../paths/index.js';
import { extensionOf, pathProblem, systemOf, type PathSystem } from '../paths/validate.js';

/**
 * Autosave copies kept per project; the oldest beyond this are deleted after a new one is written, each together with
 * the media folder of the copy.
 */
export const AUTOSAVE_KEEP = 10;
/** Old versions kept per project file; the oldest beyond this are deleted after a save. */
export const OLDVERSION_KEEP = 10;

const EXTENSION = '.otproj';
/**
 * The folder of the audio of a project file written by an earlier OpenTune, next to the project file and shared by
 * every project file of the directory; OpenTune makes it, and so does this module (inside the oldversion folder).
 */
const LEGACY_MEDIA_FOLDER = 'Project_Media';
/** The suffix of the folder of the audio of a project file: `<name>_Media`, named after the project file. */
const MEDIA_SUFFIX = '_Media';

/** A folder of the audio of a project file next to it, and the folder of the same name inside the oldversion folder. */
export interface MediaFolder {
  /** The name of the folder (the same on both sides). */
  readonly name: string;
  /** The folder next to the project file, where the project file finds its audio. */
  readonly dir: string;
  /** The folder where an old version finds its audio: its path is relative to the oldversion folder. */
  readonly oldversionDir: string;
}

/** An entry of a directory: its name and whether it is a regular file (not a directory or a link). */
export interface FolderEntry {
  readonly name: string;
  readonly isFile: boolean;
}

/** What is at a path: whether it is a regular file (a link is not followed, so it is not one) and its change time. */
export interface FileStat {
  readonly isFile: boolean;
  /** Time of the last change of the content, in milliseconds. */
  readonly mtimeMs: number;
}

/** The file system operations of this module, so that tests can fail them one by one. */
export interface ProjectFs {
  /** The entries of a directory, or null when the directory does not exist. */
  list(dir: string): Promise<readonly FolderEntry[] | null>;
  /** Creates `dir` (not its parents). A directory that exists already is fine. */
  makeDir(dir: string): Promise<void>;
  /** Copies `from` to `to`, which must not exist: fails with code EEXIST when it does. */
  copyNew(from: string, to: string): Promise<void>;
  /**
   * Replaces the file `to` by a copy of `from`. Never leaves a part of a file under the name `to`: when it fails,
   * `to` is as it was.
   */
  copyReplace(from: string, to: string): Promise<void>;
  /** What is at the path without following a link, or null when nothing is there. */
  stat(file: string): Promise<FileStat | null>;
  /** Deletes one file. */
  remove(file: string): Promise<void>;
  /**
   * Deletes the media folder of an autosave copy: the regular files directly in it, then the folder itself. Succeeds
   * without doing anything when nothing is at the path (a build that implements specification 1.0.0-rc.8 gives a
   * copy no folder of its own) or the path is not a folder (a link is not followed and not deleted). Fails when the
   * folder still holds anything else (a sub-folder or a link) or a file cannot be deleted.
   */
  removeMediaFolder(dir: string): Promise<void>;
  /** Whether a regular file exists at the path (links are followed). */
  fileExists(file: string): Promise<boolean>;
  /** Whether two paths name the same existing file (the file system's own identity, not the path text). */
  sameFile(a: string, b: string): Promise<boolean>;
  /** Whether two regular files hold exactly the same bytes. Fails when either cannot be read. */
  sameContent(a: string, b: string): Promise<boolean>;
}

/** The size of the chunks in which two files are compared. */
const COMPARE_CHUNK = 64 * 1024;

async function sameBytes(a: string, b: string): Promise<boolean> {
  const first = await fs.open(a, 'r');
  try {
    const second = await fs.open(b, 'r');
    try {
      const [sizeA, sizeB] = await Promise.all([first.stat(), second.stat()]);
      if (sizeA.size !== sizeB.size) return false;
      const x = Buffer.alloc(COMPARE_CHUNK);
      const y = Buffer.alloc(COMPARE_CHUNK);
      for (let position = 0; position < sizeA.size; position += COMPARE_CHUNK) {
        const [readA, readB] = await Promise.all([
          first.read(x, 0, COMPARE_CHUNK, position),
          second.read(y, 0, COMPARE_CHUNK, position),
        ]);
        if (
          readA.bytesRead !== readB.bytesRead ||
          !x.subarray(0, readA.bytesRead).equals(y.subarray(0, readB.bytesRead))
        ) {
          return false;
        }
      }
      return true;
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
  }
}

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** The operations on the real file system. */
export const nodeProjectFs: ProjectFs = {
  async list(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, isFile: entry.isFile() }));
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return null;
      throw error;
    }
  },
  async makeDir(dir) {
    try {
      await fs.mkdir(dir);
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error;
      // Something is there: a directory is what is wanted; anything else must fail the copy that follows.
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) throw error;
    }
  },
  async copyNew(from, to) {
    await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  },
  async copyReplace(from, to) {
    // Written under a name of its own and renamed over `to` only when complete, so that a failure leaves `to` as it was.
    const part = `${to}.${randomBytes(4).toString('hex')}.part`;
    try {
      await fs.copyFile(from, part, fs.constants.COPYFILE_EXCL);
      await fs.rename(part, to);
    } catch (error) {
      await fs.rm(part, { force: true }).catch(() => undefined);
      throw error;
    }
  },
  async stat(file) {
    try {
      const stat = await fs.lstat(file);
      return { isFile: stat.isFile(), mtimeMs: stat.mtimeMs };
    } catch (error) {
      const code = codeOf(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw error;
    }
  },
  async remove(file) {
    await fs.unlink(file);
  },
  async removeMediaFolder(dir) {
    let stat;
    try {
      stat = await fs.lstat(dir);
    } catch (error) {
      const code = codeOf(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw error;
    }
    if (!stat.isDirectory()) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isFile()) await fs.unlink(path.join(dir, entry.name));
    }
    await fs.rmdir(dir);
  },
  async fileExists(file) {
    try {
      return (await fs.stat(file)).isFile();
    } catch (error) {
      const code = codeOf(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw error;
    }
  },
  async sameFile(a, b) {
    try {
      const [first, second] = await Promise.all([fs.stat(a, { bigint: true }), fs.stat(b, { bigint: true })]);
      // A file system that reports no file id (0) gives no proof of identity.
      return first.ino !== 0n && first.ino === second.ino && first.dev === second.dev;
    } catch {
      return false;
    }
  },
  sameContent: sameBytes,
};

const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

/** The pieces of the file names this module reads and writes, for one project file. */
export class ProjectFolders {
  private constructor(
    readonly file: string,
    readonly dir: string,
    readonly stem: string,
    readonly sep: string,
  ) {}

  /**
   * The folders of a project file, or null when the path is not one this module may build paths from: not an
   * absolute path by the rules of section 20.1, not ending in .otproj, or without a file name before the extension.
   */
  static of(file: string, platform: NodeJS.Platform): ProjectFolders | null {
    const system: PathSystem = systemOf(platform);
    if (pathProblem(file, system) !== undefined) return null;
    if (extensionOf(file).toLowerCase() !== EXTENSION) return null;
    const { dir, stem, sep } = splitPath(file, system);
    return stem === '' || dir === '' ? null : new ProjectFolders(file, dir, stem, sep);
  }

  get autosaveDir(): string {
    return `${this.dir}${this.sep}${this.stem}.autosave`;
  }

  get oldversionDir(): string {
    return `${this.dir}${this.sep}${this.stem}.oldversion`;
  }

  /** The folder with the audio of the project file, next to it: where the project file finds its audio. */
  get media(): MediaFolder {
    return this.mediaFolder(`${this.stem}${MEDIA_SUFFIX}`);
  }

  /** The folder `Project_Media` of an earlier OpenTune, shared by the project files of the directory. */
  get legacyMedia(): MediaFolder {
    return this.mediaFolder(LEGACY_MEDIA_FOLDER);
  }

  private mediaFolder(name: string): MediaFolder {
    return {
      name,
      dir: `${this.dir}${this.sep}${name}`,
      // The path of an old version's audio is relative to the folder the old version is in.
      oldversionDir: `${this.oldversionDir}${this.sep}${name}`,
    };
  }

  /** The folder where OpenTune puts the audio of the autosave copy with this number: named after the copy, next to it. */
  autosaveMediaDir(number: number): string {
    return this.autosaveMediaDirOf(this.autosaveName(number));
  }

  /** The folder of the audio of the autosave copy with this file name, which must be one of this project's copies. */
  autosaveMediaDirOf(copyName: string): string {
    return `${this.autosaveDir}${this.sep}${copyName.slice(0, -EXTENSION.length)}${MEDIA_SUFFIX}`;
  }

  /**
   * The folder `Project_Media` inside the autosave folder, where a build that implements specification 1.0.0-rc.8 puts
   * the audio of every copy: one folder for all the copies. This server never deletes it.
   */
  get autosaveSharedMediaDir(): string {
    return `${this.autosaveDir}${this.sep}${LEGACY_MEDIA_FOLDER}`;
  }

  autosaveName(number: number): string {
    return `${this.stem}-autosave-${String(number).padStart(4, '0')}${EXTENSION}`;
  }

  /** The number in the name of an autosave copy of this project, or null for any other name. */
  autosaveNumber(name: string): number | null {
    const match = new RegExp(`^${escapeRegExp(this.stem)}-autosave-(\\d{4,})\\.otproj$`).exec(name);
    const digits = match?.[1];
    return digits === undefined ? null : Number.parseInt(digits, 10);
  }

  /** The sort key of an old version of this project (time, then the number after a same-second collision), or null. */
  oldVersionKey(name: string): { readonly time: string; readonly suffix: number } | null {
    const match = new RegExp(`^${escapeRegExp(this.stem)}-(\\d{8}-\\d{6})(?:-(\\d+))?\\.otproj$`).exec(name);
    const time = match?.[1];
    if (time === undefined) return null;
    return { time, suffix: match?.[2] === undefined ? 1 : Number.parseInt(match[2], 10) };
  }

  oldVersionName(time: string, suffix: number): string {
    return `${this.stem}-${time}${suffix <= 1 ? '' : `-${String(suffix)}`}${EXTENSION}`;
  }
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** `YYYYMMDD-HHMMSS` in the local time of this machine, the time stamp in the name of an old version. */
export function localStamp(epochMs: number): string {
  const d = new Date(epochMs);
  return (
    `${pad(d.getFullYear(), 4)}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** The number the next autosave copy gets: one more than the highest number any entry of the folder carries. */
export function nextAutosaveNumber(folders: ProjectFolders, entries: readonly FolderEntry[] | null): number {
  let highest = 0;
  // Every entry counts, whatever it is: a directory with such a name would make the copy fail, too.
  for (const entry of entries ?? []) highest = Math.max(highest, folders.autosaveNumber(entry.name) ?? 0);
  return highest + 1;
}

/** The names of the autosave copies to delete so that the newest `keep` stay: regular files of this pattern only. */
export function autosavesToDelete(
  folders: ProjectFolders,
  entries: readonly FolderEntry[],
  keep = AUTOSAVE_KEEP,
): string[] {
  const copies = entries
    .filter((entry) => entry.isFile)
    .flatMap((entry) => {
      const number = folders.autosaveNumber(entry.name);
      return number === null ? [] : [{ name: entry.name, number }];
    })
    .sort((a, b) => a.number - b.number || (a.name < b.name ? -1 : 1));
  return copies.slice(0, Math.max(0, copies.length - keep)).map((copy) => copy.name);
}

/** The old versions of this project among the entries (regular files of its pattern only), oldest first. */
function sortedOldVersions(folders: ProjectFolders, entries: readonly FolderEntry[]): { name: string }[] {
  return entries
    .filter((entry) => entry.isFile)
    .flatMap((entry) => {
      const key = folders.oldVersionKey(entry.name);
      return key === null ? [] : [{ name: entry.name, key }];
    })
    .sort((a, b) =>
      a.key.time === b.key.time
        ? a.key.suffix - b.key.suffix || (a.name < b.name ? -1 : 1)
        : a.key.time < b.key.time
          ? -1
          : 1,
    );
}

/** The names of the old versions to delete so that the newest `keep` stay: regular files of this pattern only. */
export function oldVersionsToDelete(
  folders: ProjectFolders,
  entries: readonly FolderEntry[],
  keep = OLDVERSION_KEEP,
): string[] {
  const versions = sortedOldVersions(folders, entries);
  return versions.slice(0, Math.max(0, versions.length - keep)).map((version) => version.name);
}

/** The name of the newest old version of this project among the entries, or null when there is none. */
export function newestOldVersion(folders: ProjectFolders, entries: readonly FolderEntry[]): string | null {
  return sortedOldVersions(folders, entries).at(-1)?.name ?? null;
}

export interface Rolled {
  /** Files that were deleted. */
  readonly removed: number;
  /** Files that should have been deleted and could not be. */
  readonly failed: number;
}

/** What the roll of the autosave copies did: the copies are counted apart from the audio folders of deleted copies. */
export interface RolledAutosaves extends Rolled {
  /**
   * Copies that were deleted whose audio folder could not be deleted. A folder that does not exist is not one of them:
   * a build that implements specification 1.0.0-rc.8 keeps the audio of all the copies in one shared folder, so a
   * copy has no folder of its own to delete.
   */
  readonly foldersFailed: number;
}

async function removeAll(ops: ProjectFs, dir: string, sep: string, names: readonly string[]): Promise<Rolled> {
  let removed = 0;
  let failed = 0;
  for (const name of names) {
    try {
      await ops.remove(`${dir}${sep}${name}`);
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}

/**
 * Deletes the autosave copies beyond the newest `keep`, each together with its media folder (the folder whose path is
 * computed from the name of the copy; a copy that could not be deleted keeps its folder, which it still needs). `removed`
 * counts the copies deleted and `failed` the copies that could not be deleted; `foldersFailed` counts, apart from
 * them, the deleted copies whose audio folder could not be deleted (a folder that does not exist is not a failure). A
 * failure to list or delete is counted, never thrown.
 */
export async function rollAutosaves(
  ops: ProjectFs,
  folders: ProjectFolders,
  keep = AUTOSAVE_KEEP,
): Promise<RolledAutosaves> {
  try {
    const entries = await ops.list(folders.autosaveDir);
    if (entries === null) return { removed: 0, failed: 0, foldersFailed: 0 };
    let removed = 0;
    let failed = 0;
    let foldersFailed = 0;
    for (const name of autosavesToDelete(folders, entries, keep)) {
      try {
        await ops.remove(`${folders.autosaveDir}${folders.sep}${name}`);
        removed += 1;
      } catch {
        failed += 1;
        continue;
      }
      try {
        await ops.removeMediaFolder(folders.autosaveMediaDirOf(name));
      } catch {
        foldersFailed += 1;
      }
    }
    return { removed, failed, foldersFailed };
  } catch {
    return { removed: 0, failed: 1, foldersFailed: 0 };
  }
}

/** Deletes the old versions beyond the newest `keep`. A failure to list or delete is counted, never thrown. */
export async function rollOldVersions(
  ops: ProjectFs,
  folders: ProjectFolders,
  keep = OLDVERSION_KEEP,
): Promise<Rolled> {
  try {
    const entries = await ops.list(folders.oldversionDir);
    if (entries === null) return { removed: 0, failed: 0 };
    return await removeAll(ops, folders.oldversionDir, folders.sep, oldVersionsToDelete(folders, entries, keep));
  } catch {
    return { removed: 0, failed: 1 };
  }
}

/** What became of the audio of the project file that an old version was made of. */
export interface MediaCopy {
  /** Files written into the media folder of the oldversion folder: new there, or replacing an older one. */
  readonly copied: number;
  /**
   * Paths, relative to the project file's folder and written with `/`, of the files that should have been copied and
   * were not (`<media folder>/<file name>`), or the name of the media folder itself when the folder could not be read
   * or the folder for the copies could not be made. At most MAX_MEDIA_NAMED are listed. The files that were left when the
   * time budget ran out are among them.
   */
  readonly notCopied: readonly string[];
  /** How many things were not copied: `notCopied.length`, or more when the list was cut. */
  readonly notCopiedCount: number;
  /**
   * true: the time budget (MEDIA_COPY_BUDGET_MS) ran out with files left, which were not tried; the next save copies
   * them. false: every file was tried, and those in `notCopied` failed.
   */
  readonly timedOut: boolean;
  /**
   * How many of `notCopiedCount` failed, as opposed to being left when the time ran out. Not a member of a tool
   * result: it lets the summary say whether failures come on top of the time.
   */
  readonly failedCount: number;
}

/** The most files that `MediaCopy.notCopied` names. */
export const MAX_MEDIA_NAMED = 20;

/**
 * The longest the copy of the audio of one project file into the oldversion folder runs, in milliseconds. It is the
 * limit of this one step, not a share of a total: `mode: save` also reads the project (READ_TIMEOUT_MS of
 * tools/project-files.ts, 15 seconds), starts the save (START_TIMEOUT_MS, 15 seconds) and waits for its job
 * (`wait_seconds`, 25 by default and 30 at most, plus WAIT_MARGIN_MS, 4 seconds). Normally each step is quick. If every
 * step used its whole limit, the save would take 15 + 15 + 15 + 29 = 74 seconds (79 with the largest `wait_seconds`),
 * more than the 60 seconds a client waits by default (CLIENT_TIMEOUT_MS of tools/client-timeout.ts). The client then
 * gives up on a save that has happened: the file is replaced, the result is lost, and the next read of the project
 * shows it. The time is read after each file, so a single very large file can take longer; the files that are left when
 * the time is used up are copied by the next save.
 */
export const MEDIA_COPY_BUDGET_MS = 15_000;

export interface OldVersion {
  /** The copy of the file that was written, or the existing one that already held the content (`reused`). */
  readonly file: string;
  /** The folder it is in. */
  readonly folder: string;
  /** Its name, which `removeOldVersion` accepts. */
  readonly name: string;
  /** true: the newest old version already held exactly this content, so no new copy was made. */
  readonly reused: boolean;
  /** The audio of the project file, kept next to the old version (copied or made complete also when `reused`). */
  readonly media: MediaCopy;
}

/** The old version of a project file without its audio. */
type OldVersionFile = Omit<OldVersion, 'media'>;

/** The most same-second collisions of old versions that are tried before the backup fails. */
const MAX_SAME_SECOND = 999;

/**
 * The newest old version when it holds exactly the bytes of the project file, else null. Anything that goes wrong
 * (the folder cannot be listed, a file cannot be read) is "not the same": a new copy is made then.
 */
async function sameAsNewest(ops: ProjectFs, folders: ProjectFolders): Promise<OldVersionFile | null> {
  try {
    const entries = await ops.list(folders.oldversionDir);
    const name = entries === null ? null : newestOldVersion(folders, entries);
    if (name === null) return null;
    const file = `${folders.oldversionDir}${folders.sep}${name}`;
    return (await ops.sameContent(folders.file, file))
      ? { file, folder: folders.oldversionDir, name, reused: true }
      : null;
  } catch {
    return null;
  }
}

/** `<media folder>/<name>`: how a file of the media folder is named in a result, whatever the path separator. */
const mediaLabel = (folder: MediaFolder, name: string): string => `${folder.name}/${name}`;

type MediaStep = 'copied' | 'kept' | 'failed';

/**
 * Brings one file of the media folder into the folder of the old versions, by the rules of OpenTune's own copy of its
 * audio: written when it is missing there or older than its source, otherwise left alone (a newer file is never
 * overwritten). A directory or a link where the file belongs is not touched and counts as not copied. Never throws.
 */
async function copyOneMedia(ops: ProjectFs, from: string, to: string): Promise<MediaStep> {
  try {
    const source = await ops.stat(from);
    // Gone since it was listed, or no regular file any more: there is nothing to copy.
    if (!source?.isFile) return 'kept';
    const target = await ops.stat(to);
    if (target === null) {
      try {
        await ops.copyNew(from, to);
        return 'copied';
      } catch (error) {
        // EEXIST: a file appeared meanwhile, and stays. Any other failure may have left a part of the copy under this
        // name, which this attempt made: it is deleted, so that no later run takes it for a complete copy.
        if (codeOf(error) === 'EEXIST') return 'kept';
        try {
          await ops.remove(to);
        } catch {
          // Nothing more can be done about it.
        }
        return 'failed';
      }
    }
    if (!target.isFile) return 'failed';
    if (target.mtimeMs >= source.mtimeMs) return 'kept';
    await ops.copyReplace(from, to);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/**
 * Copies the audio of the project file into the media folder inside `<name>.oldversion`, where an old version looks
 * for it: the regular files of the media folder next to the project file (`<name>_Media`, else the `Project_Media` of
 * an earlier OpenTune), none of its sub-folders and no link. It does nothing, and reports nothing, when neither
 * folder exists (a project that never had audio). It never deletes
 * anything, and never throws: the old version of the project file is what a save needs, and a failure here is reported in
 * the result instead (`notCopied`) and does not stop the save. The oldversion folder must exist already.
 *
 * The copy stops once MEDIA_COPY_BUDGET_MS have passed on `clock` (milliseconds, read after each file): the files
 * that were not tried are reported as not copied, with `timedOut`, and the next save copies them.
 */
export async function copyMediaToOldVersions(
  ops: ProjectFs,
  folders: ProjectFolders,
  clock: () => number = () => Date.now(),
): Promise<MediaCopy> {
  const result = (copied: number, failed: readonly string[], unfinished: readonly string[] = []): MediaCopy => {
    const notCopied = [...failed, ...unfinished];
    return {
      copied,
      notCopied: notCopied.slice(0, MAX_MEDIA_NAMED),
      notCopiedCount: notCopied.length,
      timedOut: unfinished.length > 0,
      failedCount: failed.length,
    };
  };
  const started = clock();
  let folder: MediaFolder | null = null;
  let names: string[] = [];
  // The folder named after the project file, else the shared folder of an earlier OpenTune.
  for (const candidate of [folders.media, folders.legacyMedia]) {
    try {
      const entries = await ops.list(candidate.dir);
      if (entries === null) continue;
      folder = candidate;
      names = entries
        .filter((entry) => entry.isFile)
        .map((entry) => entry.name)
        .sort();
      break;
    } catch {
      return result(0, [candidate.name]);
    }
  }
  if (folder === null || names.length === 0) return result(0, []);
  const found = folder;
  try {
    await ops.makeDir(found.oldversionDir);
  } catch {
    return result(0, [found.name]);
  }
  let copied = 0;
  const failed: string[] = [];
  for (const [index, name] of names.entries()) {
    const step = await copyOneMedia(
      ops,
      `${found.dir}${folders.sep}${name}`,
      `${found.oldversionDir}${folders.sep}${name}`,
    );
    if (step === 'copied') copied += 1;
    else if (step === 'failed') failed.push(mediaLabel(found, name));
    // Out of time: what is left is not tried (the next save does it). Nothing left means nothing timed out.
    if (clock() - started >= MEDIA_COPY_BUDGET_MS) {
      return result(
        copied,
        failed,
        names.slice(index + 1).map((left) => mediaLabel(found, left)),
      );
    }
  }
  return result(copied, failed);
}

/**
 * Keeps a project file that is about to be replaced in the `.oldversion` folder next to it: it copies it as
 * `<name>-<YYYYMMDD-HHMMSS>.otproj` (`-2`, `-3`, … when that name is taken in the same second), unless the newest old
 * version already holds exactly its bytes (a save after a save that changed nothing), which is then the old version
 * (`reused`) and would only crowd out an older one. Throws when the folder cannot be made or the copy fails: the
 * caller must then not replace the file. A copy that failed part way is deleted again (only the file this attempt
 * named). Rolling is separate, so that a failed save leaves the older versions alone.
 *
 * Once the old version exists (made now, or reused), the audio of the project file is copied next to it
 * (copyMediaToOldVersions), so that the old version still finds its audio when the original audio files are gone. That
 * is done also for a reused old version, which may have been made before this was done. It does not throw. `clock`
 * times the copy of the audio (see MEDIA_COPY_BUDGET_MS).
 */
export async function copyToOldVersions(
  ops: ProjectFs,
  folders: ProjectFolders,
  epochMs: number,
  clock: () => number = () => Date.now(),
): Promise<OldVersion> {
  const kept = await keepProjectFile(ops, folders, epochMs);
  return { ...kept, media: await copyMediaToOldVersions(ops, folders, clock) };
}

async function keepProjectFile(ops: ProjectFs, folders: ProjectFolders, epochMs: number): Promise<OldVersionFile> {
  await ops.makeDir(folders.oldversionDir);
  const same = await sameAsNewest(ops, folders);
  if (same !== null) return same;
  const stamp = localStamp(epochMs);
  for (let suffix = 1; suffix <= MAX_SAME_SECOND; suffix += 1) {
    const name = folders.oldVersionName(stamp, suffix);
    const file = `${folders.oldversionDir}${folders.sep}${name}`;
    try {
      await ops.copyNew(folders.file, file);
      return { file, folder: folders.oldversionDir, name, reused: false };
    } catch (error) {
      // EEXIST: the name belongs to a file that was there before, and stays. Any other failure may have left a
      // part of the copy under this name, which this attempt made.
      if (codeOf(error) !== 'EEXIST') {
        await removeOldVersion(ops, folders, name);
        throw error;
      }
    }
  }
  throw new Error('too many old versions with the same time stamp');
}

/**
 * Deletes an old version that this call made: the one just written, when the save it was made for failed and the file
 * it copied is still the project file, or the rest of a copy that failed part way. Only a name that is an old version
 * of this project is deleted. Never throws.
 */
export async function removeOldVersion(ops: ProjectFs, folders: ProjectFolders, name: string): Promise<boolean> {
  if (folders.oldVersionKey(name) === null) return false;
  try {
    await ops.remove(`${folders.oldversionDir}${folders.sep}${name}`);
    return true;
  } catch {
    return false;
  }
}
