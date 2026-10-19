// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// beat-grid: install and drive the opentune-beats tempo and beat-grid analyzer, and turn its grid
// plus the notes of a vocal clip into opentune_edit_timing suggestions. Node.js 22 or later, ESM,
// no third-party dependencies. The plugin already needs Node for the MCP server, so this skill
// ships no Python.
//
// Usage:
//   node beat-grid.mjs status
//   node beat-grid.mjs install --model final|small [--yes]
//   node beat-grid.mjs analyze <wav> [--model final|small] [--out <file>.json [--force]] [--summary]
//   node beat-grid.mjs timing-plan --grid <grid.json> --notes <notes.json> --grid-offset-sec <s>
//                                  [--threshold-ms 30] [--subdivision 1|2|4]
//
// Exit codes: 0 success; 2 usage or unreadable input; 3 not installed (or no data folder);
// 4 install, download or checksum failure; 5 the analyzer reported an error (its JSON is printed).
// Machine output is one JSON object on stdout; progress and diagnostics go to stderr.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST_FILE = path.join(SCRIPT_DIR, 'manifest.json');
export const HOME_ENV = Object.freeze(['CLAUDE_PLUGIN_DATA', 'OPENTUNE_BEATS_HOME']);
export const MODELS = Object.freeze(['final', 'small']);
export const TARGETS = Object.freeze(['win-x64', 'macos-universal2']);
export const SUBDIVISIONS = Object.freeze([1, 2, 4]);
export const DEFAULT_THRESHOLD_MS = 30;
export const MAX_OPS_PER_CALL = 8;
export const MAX_DELTA_MS = 10_000;
export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  NOT_INSTALLED: 3,
  INSTALL_FAILED: 4,
  ANALYSIS_FAILED: 5,
});

const SHA256_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INSTALL_DIR_RE = /^opentune-beats-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(win-x64|macos-universal2)$/;

const USAGE = `beat-grid: tempo and beat grid for OpenTune, from the opentune-beats analyzer.

  node beat-grid.mjs status
      Whether opentune-beats is installed, its version and folder, and the models it has (JSON).

  node beat-grid.mjs install --model final|small [--yes]
      Without --yes: print what would be downloaded, its size and its licence, and change nothing.
      With --yes: download, verify every sha256, extract, install and check --version.

  node beat-grid.mjs analyze <wav> [--model final|small] [--out <file>.json [--force]] [--summary]
      Run the analyzer on a WAV file. Without --summary the analyzer's JSON is printed, or written
      to --out (a .json path that must not exist yet, unless --force) with one line on stdout; with --summary the beat list is left out (segments, tempi,
      confidence and warnings only).

  node beat-grid.mjs timing-plan --grid <grid.json> --notes <notes.json> --grid-offset-sec <s>
                                 [--threshold-ms 30] [--subdivision 1|2|4]
      Turn a grid and the notes of a vocal clip (opentune_get_notes) into opentune_edit_timing
      suggestions to review before any call. The singer's overall lead or lag (the median) is
      removed before the threshold is applied.

Exit codes: 0 success, 2 usage or unreadable input, 3 not installed, 4 install failure,
5 the analyzer reported an error. Data folders: CLAUDE_PLUGIN_DATA, else OPENTUNE_BEATS_HOME.
`;

export class BeatGridError extends Error {
  /**
   * @param {string} code a short fixed identifier, printed in the error JSON
   * @param {string} detail what happened and what to do
   * @param {number} [exitCode]
   */
  constructor(code, detail, exitCode = EXIT.INSTALL_FAILED) {
    super(detail);
    this.name = 'BeatGridError';
    this.code = code;
    this.detail = detail;
    this.exitCode = exitCode;
  }
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function round(value, digits) {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function humanBytes(bytes) {
  if (!isFiniteNumber(bytes) || bytes < 0) return 'unknown';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

// ---------------------------------------------------------------------------------------------
// manifest

/** Reads the pinned version, URLs, sha256 values and sizes of the analyzer. */
export function loadManifest(file = MANIFEST_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new BeatGridError(
      'MANIFEST_UNREADABLE',
      `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.INSTALL_FAILED,
    );
  }
}

/** Why the manifest cannot be used as it is; empty when it can. */
export function manifestProblems(manifest) {
  const problems = [];
  if (!isObject(manifest)) return ['the manifest is not an object'];
  if (manifest.schemaVersion !== 1) problems.push('manifest.schemaVersion must be 1');
  if (manifest.tool !== 'opentune-beats') problems.push('manifest.tool must be "opentune-beats"');
  if (typeof manifest.version !== 'string' || !VERSION_RE.test(manifest.version))
    problems.push('manifest.version must be a version such as 0.1.0');
  if (typeof manifest.released !== 'boolean') problems.push('manifest.released must be true or false');
  if (typeof manifest.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(manifest.repository))
    problems.push('manifest.repository must be "owner/name"');
  if (typeof manifest.releaseTag !== 'string' || manifest.releaseTag === '')
    problems.push('manifest.releaseTag must name the release tag');
  const base = `https://github.com/${manifest.repository}/releases/download/${manifest.releaseTag}/`;
  const released = manifest.released === true;

  const checkAsset = (where, entry) => {
    if (!isObject(entry)) {
      problems.push(`${where} must be an object`);
      return;
    }
    if (typeof entry.asset !== 'string' || entry.asset === '') problems.push(`${where}.asset must be a file name`);
    if (typeof entry.url !== 'string' || !/^https:\/\//.test(entry.url))
      problems.push(`${where}.url must be an https URL`);
    else if (entry.url !== `${base}${String(entry.asset)}`)
      problems.push(`${where}.url must be ${base}${String(entry.asset)} (the pinned release asset)`);
    if (!isFiniteNumber(entry.approxBytes) || entry.approxBytes <= 0)
      problems.push(`${where}.approxBytes must be a positive number`);
    const sha = typeof entry.sha256 === 'string' ? entry.sha256.toLowerCase() : null;
    if (sha === null || (sha !== '' && !SHA256_RE.test(sha)))
      problems.push(`${where}.sha256 must be empty or a sha256`);
    if (released && sha !== null && !SHA256_RE.test(sha))
      problems.push(`${where}.sha256 must be filled in before the release is marked released`);
    if (!released && sha !== null && sha !== '')
      problems.push(`${where}.sha256 must stay empty while manifest.released is false (do not guess a hash)`);
  };

  for (const target of TARGETS) {
    const entry = isObject(manifest.platforms) ? manifest.platforms[target] : undefined;
    checkAsset(`platforms.${target}`, entry);
    if (isObject(entry) && entry.format !== 'zip' && entry.format !== 'tar.gz')
      problems.push(`platforms.${target}.format must be "zip" or "tar.gz"`);
  }
  for (const name of ['mel', 'final', 'small']) {
    const entry = isObject(manifest.models) ? manifest.models[name] : undefined;
    checkAsset(`models.${name}`, entry);
  }
  return problems;
}

export function detectTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return 'macos-universal2';
  return null;
}

export function executableName(target) {
  return target === 'win-x64' ? 'opentune-beats.exe' : 'opentune-beats';
}

export function binDir(home) {
  return path.join(home, 'bin');
}

export function installDirName(manifest, target) {
  return `${manifest.tool}-${manifest.version}-${target}`;
}

export function installDir(home, manifest, target) {
  return path.join(binDir(home), installDirName(manifest, target));
}

/** The folder under CLAUDE_PLUGIN_DATA (or OPENTUNE_BEATS_HOME); an error when neither is set. */
export function dataHome(env = process.env) {
  for (const name of HOME_ENV) {
    const value = (env[name] ?? '').trim();
    if (value !== '') return { home: path.resolve(value), source: name };
  }
  throw new BeatGridError(
    'NO_HOME',
    'Neither CLAUDE_PLUGIN_DATA nor OPENTUNE_BEATS_HOME is set, so there is no folder for the analyzer. ' +
      'When the skill runs as part of the plugin, CLAUDE_PLUGIN_DATA is set. Otherwise choose a short folder ' +
      'with ASCII characters only (for example C:/OpenTuneBeats), set OPENTUNE_BEATS_HOME to it and run again.',
    EXIT.NOT_INSTALLED,
  );
}

// ---------------------------------------------------------------------------------------------
// install plan

/**
 * What `install` would download for one model, with the sizes and the licence text the agent shows
 * the user before asking for consent. `problems` is empty when the install can go ahead.
 */
export function installPlan({ manifest, target = detectTarget(), model = 'final', home = null } = {}) {
  const safe = isObject(manifest) ? manifest : {};
  const platform = isObject(safe.platforms) ? safe.platforms[target] : undefined;
  const models = isObject(safe.models) ? safe.models : {};
  const problems = manifestProblems(manifest);
  if (target === null || !TARGETS.includes(target)) {
    problems.push('this platform has no opentune-beats release (Windows x64 and macOS universal2 only)');
  } else if (!isObject(platform)) {
    problems.push(`the manifest has no asset for ${target}`);
  }
  if (!MODELS.includes(model)) problems.push(`--model must be final or small (found ${String(model)})`);
  if (home === null)
    problems.push(
      'there is no data folder for the analyzer: set CLAUDE_PLUGIN_DATA (the plugin does this) or OPENTUNE_BEATS_HOME',
    );
  if (safe.released !== true) {
    problems.push(
      `the ${String(safe.releaseTag)} release of ${String(safe.repository)} is not published yet, and its ` +
        'sha256 values are not known; nothing can be downloaded or installed until the release exists and ' +
        'manifest.json is updated with its hashes',
    );
  }
  const assets = [];
  if (isObject(platform) && isObject(models.mel) && isObject(models[model])) {
    assets.push({ kind: 'program', ...platform });
    assets.push({ kind: 'model', name: 'mel', ...models.mel });
    assets.push({ kind: 'model', name: model, ...models[model] });
  }
  const modelBytes =
    isObject(models.mel) && isObject(models[model])
      ? Number(models.mel.approxBytes ?? 0) + Number(models[model].approxBytes ?? 0)
      : null;
  const totalBytes = isObject(platform) && modelBytes !== null ? Number(platform.approxBytes ?? 0) + modelBytes : null;
  const other = model === 'final' ? 'small' : 'final';
  const otherTotal =
    isObject(platform) && isObject(models.mel) && isObject(models[other])
      ? Number(platform.approxBytes ?? 0) + Number(models.mel.approxBytes ?? 0) + Number(models[other].approxBytes ?? 0)
      : null;
  return {
    tool: 'opentune-beats',
    version: typeof safe.version === 'string' ? safe.version : null,
    released: safe.released === true,
    license: typeof safe.license === 'string' ? safe.license : null,
    licenseNote: typeof safe.licenseNote === 'string' ? safe.licenseNote : null,
    target,
    model,
    home,
    dir:
      home === null || typeof safe.version !== 'string' || target === null || !TARGETS.includes(target)
        ? null
        : installDir(home, safe, target),
    assets,
    totalBytes,
    otherModel: { name: other, totalBytes: otherTotal },
    problems,
  };
}

/** The plan as text for the user, before any consent; fixed wording, no remote text. */
export function formatPlan(plan) {
  const lines = ['beat-grid install plan (nothing has been downloaded):'];
  lines.push(`  Tool      : ${plan.tool} ${plan.version}`);
  lines.push(`  Licence   : ${plan.license}. ${plan.licenseNote ?? ''}`.trimEnd());
  lines.push(`  Platform  : ${plan.target ?? 'not supported here'}`);
  lines.push(`  Folder    : ${plan.dir ?? '(no data folder; set CLAUDE_PLUGIN_DATA or OPENTUNE_BEATS_HOME)'}`);
  lines.push(
    `  Model     : ${plan.model} (use --model ${plan.otherModel.name} for ${humanBytes(plan.otherModel.totalBytes)})`,
  );
  if (plan.assets.length === 0) {
    lines.push('  Download  : unknown (the manifest has no assets for this platform)');
  } else {
    lines.push(`  Download  : about ${humanBytes(plan.totalBytes)} in total`);
    for (const asset of plan.assets) {
      const what = asset.kind === 'program' ? 'program' : 'model';
      lines.push(`    - ${what.padEnd(7)} ${asset.asset} (about ${humanBytes(asset.approxBytes)})`);
    }
  }
  if (plan.problems.length > 0) {
    lines.push('Problems:');
    for (const problem of plan.problems) lines.push(`  - ${problem}`);
  }
  lines.push(
    plan.problems.length > 0
      ? 'Nothing can be installed with these settings. Do not retry with --yes; tell the user what is missing.'
      : 'Nothing was downloaded and nothing was changed. Run the same command with --yes, only after the user agrees.',
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// running the analyzer

/**
 * Runs a command with its stdout and stderr in temporary files rather than pipes: a pipe can fail
 * in confined environments, and a full grid JSON is larger than a pipe buffer is worth. Returns
 * the exit status and both streams as text.
 */
export function runProcess(command, args, { env = process.env, cwd = undefined, timeoutMs = 30 * 60_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentune-beats-'));
  const stdoutFile = path.join(dir, 'stdout');
  const stderrFile = path.join(dir, 'stderr');
  let outFd;
  let errFd;
  try {
    outFd = fs.openSync(stdoutFile, 'w');
    errFd = fs.openSync(stderrFile, 'w');
    const result = spawnSync(command, args, {
      stdio: ['ignore', outFd, errFd],
      env,
      ...(cwd === undefined ? {} : { cwd }),
      timeout: timeoutMs,
      windowsHide: true,
    });
    return {
      status: result.status ?? ((result.error ?? result.signal) ? 1 : 0),
      signal: result.signal ?? null,
      error: result.error === undefined ? null : result.error.message,
      stdout: fs.readFileSync(stdoutFile, 'utf8'),
      stderr: fs.readFileSync(stderrFile, 'utf8'),
    };
  } finally {
    for (const fd of [outFd, errFd]) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // already closed
        }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The version in the one line `opentune-beats --version` prints, or null. */
export function parseVersionOutput(text) {
  const line = String(text).trim().split(/\r?\n/, 1)[0] ?? '';
  const match = /^opentune-beats\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s+\(.*\))?\s*$/.exec(line);
  return match ? { version: match[1], line } : null;
}

/** A self-check for a freshly installed executable: it must print its version and name ours. */
export function makeSelfCheck({ run = runProcess } = {}) {
  return (executable, expectedVersion) => {
    const result = run(executable, ['--version'], { timeoutMs: 60_000 });
    if (result.status !== 0) {
      throw new BeatGridError(
        'SELF_CHECK_FAILED',
        `${executable} --version exited with ${result.status}` +
          (result.error === null ? '' : ` (${result.error})`) +
          (result.stderr.trim() === '' ? '' : `: ${result.stderr.trim().slice(0, 300)}`),
        EXIT.INSTALL_FAILED,
      );
    }
    const parsed = parseVersionOutput(result.stdout);
    if (parsed === null) {
      throw new BeatGridError(
        'SELF_CHECK_FAILED',
        `${executable} --version did not print "opentune-beats <version>": ${result.stdout.trim().slice(0, 200)}`,
        EXIT.INSTALL_FAILED,
      );
    }
    if (parsed.version !== expectedVersion) {
      throw new BeatGridError(
        'SELF_CHECK_FAILED',
        `${executable} reports version ${parsed.version}, expected ${expectedVersion}`,
        EXIT.INSTALL_FAILED,
      );
    }
    return parsed.line;
  };
}

// ---------------------------------------------------------------------------------------------
// downloads and archives

function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function assertChecksum(file, expected, what) {
  const actual = sha256File(file);
  if (actual !== expected.toLowerCase()) {
    throw new BeatGridError(
      'CHECKSUM_MISMATCH',
      `${what}: sha256 ${actual} does not match the pinned ${expected}; the file was discarded`,
      EXIT.INSTALL_FAILED,
    );
  }
  return actual;
}

/** Copies an asset from a local folder (tests and offline mirrors) and checks its sha256. */
export function copyAsset(source, dest, expected, what) {
  fs.copyFileSync(source, dest);
  return assertChecksum(dest, expected, what);
}

/** Downloads one asset and checks its sha256; a mismatch deletes the file and throws. */
export async function downloadAsset(url, dest, expected, what, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  log(`  get ${what} ${url}`);
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'follow' });
  } catch (error) {
    throw new BeatGridError(
      'DOWNLOAD_FAILED',
      `cannot download ${url}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.INSTALL_FAILED,
    );
  }
  if (!response.ok || response.body === null) {
    throw new BeatGridError('DOWNLOAD_FAILED', `cannot download ${url}: HTTP ${response.status}`, EXIT.INSTALL_FAILED);
  }
  const hash = createHash('sha256');
  const fd = fs.openSync(dest, 'w');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      hash.update(buffer);
      let written = 0;
      while (written < buffer.length) written += fs.writeSync(fd, buffer, written, buffer.length - written);
      bytes += buffer.length;
    }
  } finally {
    fs.closeSync(fd);
  }
  const actual = hash.digest('hex');
  if (actual !== expected.toLowerCase()) {
    fs.rmSync(dest, { force: true });
    throw new BeatGridError(
      'CHECKSUM_MISMATCH',
      `${what}: sha256 ${actual} does not match the pinned ${expected}; the file was discarded`,
      EXIT.INSTALL_FAILED,
    );
  }
  log(`  have ${what} (${humanBytes(bytes)}, sha256 verified)`);
  return actual;
}

/** Rejects an archive path that would leave the destination or name a special file. */
function safeArchivePath(dest, name) {
  if (typeof name !== 'string' || name === '' || name.includes('\\') || name.includes('\0'))
    throw new BeatGridError('ARCHIVE_UNSAFE', `unsafe archive path ${JSON.stringify(name)}`, EXIT.INSTALL_FAILED);
  // `tar` commonly writes `./name`; strip one leading `./` before the checks, which still reject
  // `../` and any other dot segment.
  const cleaned = name.startsWith('./') ? name.slice(2) : name;
  if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned))
    throw new BeatGridError('ARCHIVE_UNSAFE', `absolute archive path ${JSON.stringify(name)}`, EXIT.INSTALL_FAILED);
  const parts = cleaned.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes(':')))
    throw new BeatGridError('ARCHIVE_UNSAFE', `unsafe archive path ${JSON.stringify(name)}`, EXIT.INSTALL_FAILED);
  const target = path.resolve(dest, ...parts);
  if (target !== dest && !target.startsWith(`${dest}${path.sep}`))
    throw new BeatGridError(
      'ARCHIVE_UNSAFE',
      `archive path escapes the folder: ${JSON.stringify(name)}`,
      EXIT.INSTALL_FAILED,
    );
  return target;
}

function writeArchiveEntry(dest, name, data, written, mode = null) {
  const target = safeArchivePath(dest, name);
  if (written.has(target))
    throw new BeatGridError('ARCHIVE_UNSAFE', `duplicate archive entry ${name}`, EXIT.INSTALL_FAILED);
  written.add(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  // The macOS program must keep its executable bit; Windows ignores it.
  if (isFiniteNumber(mode) && mode > 0) {
    try {
      fs.chmodSync(target, mode & 0o777);
    } catch {
      // A filesystem without modes (for example a mounted archive) still has the file.
    }
  }
}

function makeArchiveDir(dest, name) {
  fs.mkdirSync(safeArchivePath(dest, name), { recursive: true });
}

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;

/** Extracts a zip archive (stored or deflated entries; no symbolic links) into `dest`. */
export function extractZip(buffer, dest) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0)
    throw new BeatGridError(
      'ARCHIVE_INVALID',
      'the downloaded zip has no end-of-central-directory record',
      EXIT.INSTALL_FAILED,
    );
  if (buffer.readUInt32LE(end) !== ZIP_EOCD)
    throw new BeatGridError('ARCHIVE_INVALID', 'the downloaded zip is malformed', EXIT.INSTALL_FAILED);
  const count = buffer.readUInt16LE(end + 10);
  const offset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff)
    throw new BeatGridError('ARCHIVE_INVALID', 'zip64 archives are not supported', EXIT.INSTALL_FAILED);
  const written = new Set();
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== ZIP_CENTRAL)
      throw new BeatGridError(
        'ARCHIVE_INVALID',
        'the downloaded zip has a malformed central directory',
        EXIT.INSTALL_FAILED,
      );
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const attributes = buffer.readUInt32LE(at + 38);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    if ((flags & 0x1) !== 0)
      throw new BeatGridError('ARCHIVE_INVALID', `the zip entry ${name} is encrypted`, EXIT.INSTALL_FAILED);
    const unixMode = attributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000)
      throw new BeatGridError('ARCHIVE_UNSAFE', `the zip entry ${name} is a symbolic link`, EXIT.INSTALL_FAILED);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50)
      throw new BeatGridError('ARCHIVE_INVALID', `the zip entry ${name} has no local header`, EXIT.INSTALL_FAILED);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) {
      try {
        data = inflateRawSync(raw);
      } catch (error) {
        throw new BeatGridError(
          'ARCHIVE_INVALID',
          `the zip entry ${name} cannot be decompressed: ${error instanceof Error ? error.message : String(error)}`,
          EXIT.INSTALL_FAILED,
        );
      }
    } else
      throw new BeatGridError('ARCHIVE_INVALID', `the zip entry ${name} uses method ${method}`, EXIT.INSTALL_FAILED);
    if (data.length !== size)
      throw new BeatGridError('ARCHIVE_INVALID', `the zip entry ${name} has the wrong size`, EXIT.INSTALL_FAILED);
    if (name !== './' && name !== '.') {
      if (name.endsWith('/')) makeArchiveDir(dest, name.replace(/\/+$/, ''));
      else writeArchiveEntry(dest, name, data, written, unixMode & 0o777);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
}

function cString(buffer) {
  const end = buffer.indexOf(0);
  return (end < 0 ? buffer : buffer.subarray(0, end)).toString('utf8');
}

function parsePax(data) {
  const out = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number.parseInt(data.subarray(at, space).toString('utf8'), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) out[record.slice(0, equals)] = record.slice(equals + 1);
    at += length;
  }
  return out;
}

/** Extracts a .tar.gz archive (regular files and directories; no links) into `dest`. */
export function extractTarGz(buffer, dest) {
  let tar;
  try {
    tar = gunzipSync(buffer);
  } catch (error) {
    throw new BeatGridError(
      'ARCHIVE_INVALID',
      `the downloaded archive is not gzip: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.INSTALL_FAILED,
    );
  }
  const written = new Set();
  let longName = null;
  let paxPath = null;
  let at = 0;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = cString(header.subarray(0, 100));
    const size = Number.parseInt(cString(header.subarray(124, 136)).trim() || '0', 8);
    const mode = Number.parseInt(cString(header.subarray(100, 108)).trim() || '0', 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = cString(header.subarray(345, 500));
    if (!Number.isFinite(size) || size < 0)
      throw new BeatGridError('ARCHIVE_INVALID', `the tar entry ${name} has no size`, EXIT.INSTALL_FAILED);
    at += 512;
    const data = tar.subarray(at, at + size);
    at += Math.ceil(size / 512) * 512;
    if (type === 'x') {
      paxPath = parsePax(data).path ?? paxPath;
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = cString(data);
      continue;
    }
    const fullName = paxPath ?? longName ?? (prefix === '' ? name : `${prefix}/${name}`);
    paxPath = null;
    longName = null;
    if (type === '5') {
      if (fullName === './' || fullName === '.') continue;
      makeArchiveDir(dest, fullName.replace(/\/+$/, ''));
    } else if (type === '0' || type === '\0') writeArchiveEntry(dest, fullName, data, written, mode);
    else
      throw new BeatGridError(
        'ARCHIVE_UNSAFE',
        `the tar entry ${fullName} is not a regular file or directory (type ${JSON.stringify(type)})`,
        EXIT.INSTALL_FAILED,
      );
  }
}

// ---------------------------------------------------------------------------------------------
// install

/** The installation of the pinned version for `target`, or null. */
export function currentInstallation(home, manifest, target) {
  const dir = installDir(home, manifest, target);
  const executable = path.join(dir, executableName(target));
  const stat = fs.statSync(executable, { throwIfNoEntry: false });
  if (!stat?.isFile()) return null;
  return { dir, executable };
}

function readInstallMetadata(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'install.json'), 'utf8'));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function modelsIn(dir) {
  const models = {};
  for (const name of ['mel', 'final', 'small']) {
    const file = name === 'mel' ? 'mel_spectrogram.onnx' : `beat_this_${name}.onnx`;
    models[name] = fs.statSync(path.join(dir, 'models', file), { throwIfNoEntry: false })?.isFile() === true;
  }
  return models;
}

/**
 * Downloads, verifies, extracts and installs the analyzer, then checks `--version`. The previous
 * installation of the same version stays until the new one passes the check; a failure removes the
 * new folder and puts the old one back.
 */
export async function install({
  manifest,
  home,
  target = detectTarget(),
  model = 'final',
  sourceDir = null,
  log = () => {},
  selfCheck = makeSelfCheck(),
  now = () => new Date().toISOString(),
  fetchImpl = globalThis.fetch,
  fsImpl = fs,
} = {}) {
  if (target === null || !TARGETS.includes(target))
    throw new BeatGridError(
      'UNSUPPORTED_PLATFORM',
      'opentune-beats is published for Windows x64 and macOS universal2 only',
      EXIT.INSTALL_FAILED,
    );
  if (!MODELS.includes(model))
    throw new BeatGridError('USAGE', `--model must be final or small (found ${String(model)})`, EXIT.USAGE);
  if (manifest.released !== true)
    throw new BeatGridError(
      'NOT_RELEASED',
      `the ${String(manifest.releaseTag)} release of ${String(manifest.repository)} is not published yet, so nothing ` +
        'was downloaded. The manifest marks it released: false and has no sha256 values; do not guess them.',
      EXIT.INSTALL_FAILED,
    );
  const problems = manifestProblems(manifest);
  if (problems.length > 0)
    throw new BeatGridError(
      'MANIFEST_INVALID',
      `the manifest cannot be used: ${problems.join('; ')}`,
      EXIT.INSTALL_FAILED,
    );

  const platform = manifest.platforms[target];
  const assets = [
    { kind: 'program', ...platform },
    { kind: 'model', name: 'mel', ...manifest.models.mel },
    { kind: 'model', name: model, ...manifest.models[model] },
  ];
  const dest = installDir(home, manifest, target);
  const bin = binDir(home);
  fs.mkdirSync(bin, { recursive: true });
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const prefix = `.${installDirName(manifest, target)}`;
  const work = path.join(bin, `${prefix}.tmp-${token}`);
  const stage = path.join(work, 'stage');
  const downloads = path.join(work, 'downloads');
  const backup = path.join(bin, `${prefix}.old-${token}`);
  fs.mkdirSync(stage, { recursive: true });
  fs.mkdirSync(downloads, { recursive: true });
  let movedOld = false;
  try {
    const verified = {};
    for (const asset of assets) {
      const file = path.join(downloads, asset.asset);
      const what = asset.kind === 'program' ? 'program' : `model ${asset.name}`;
      if (sourceDir === null) {
        verified[asset.kind === 'program' ? 'program' : asset.name] = await downloadAsset(
          asset.url,
          file,
          asset.sha256,
          what,
          { fetchImpl, log },
        );
      } else {
        const source = path.join(sourceDir, asset.asset);
        if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile())
          throw new BeatGridError('DOWNLOAD_FAILED', `the source folder has no ${asset.asset}`, EXIT.INSTALL_FAILED);
        verified[asset.kind === 'program' ? 'program' : asset.name] = copyAsset(source, file, asset.sha256, what);
        log(`  have ${what} (${humanBytes(fs.statSync(file).size)}, sha256 verified)`);
      }
    }

    log('  extract the program');
    const archive = fs.readFileSync(path.join(downloads, platform.asset));
    if (platform.format === 'zip') extractZip(archive, stage);
    else extractTarGz(archive, stage);

    log('  install the models');
    fs.mkdirSync(path.join(stage, 'models'), { recursive: true });
    for (const asset of assets.filter((entry) => entry.kind === 'model')) {
      fs.copyFileSync(path.join(downloads, asset.asset), path.join(stage, 'models', asset.asset));
    }

    const executable = path.join(stage, executableName(target));
    if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile())
      throw new BeatGridError(
        'ARCHIVE_INVALID',
        `the archive does not hold ${executableName(target)} at its top level`,
        EXIT.INSTALL_FAILED,
      );
    if (target !== 'win-x64') fs.chmodSync(executable, 0o755);

    const metadata = {
      tool: manifest.tool,
      version: manifest.version,
      target,
      model,
      models: { mel: manifest.models.mel.asset, [model]: manifest.models[model].asset },
      sha256: verified,
      source: sourceDir === null ? 'download' : 'local',
      installedAt: now(),
    };
    fs.writeFileSync(path.join(stage, 'install.json'), `${JSON.stringify(metadata, null, 2)}\n`);

    if (fs.existsSync(dest)) {
      fs.renameSync(dest, backup);
      movedOld = true;
    }
    fs.renameSync(stage, dest);
    const replaced = movedOld;
    let versionLine;
    try {
      versionLine = selfCheck(path.join(dest, executableName(target)), manifest.version);
    } catch (error) {
      // Move the failed version out of the way, then put the previous one back. The backup is never
      // deleted here: if either step fails it stays where it is and its location is reported.
      let cleared = false;
      try {
        fsImpl.rmSync(dest, { recursive: true, force: true });
        cleared = true;
      } catch {
        try {
          fsImpl.renameSync(dest, path.join(bin, `${prefix}.failed-${token}`));
          cleared = true;
        } catch {
          cleared = false;
        }
      }
      if (movedOld) {
        if (!cleared) {
          movedOld = false;
          throw new BeatGridError(
            'ROLLBACK_FAILED',
            `the new version failed its self-check (${error instanceof Error ? error.message : String(error)}) ` +
              `and could not be removed or moved aside. The previous version is kept at ${backup}; stop any process ` +
              `that uses ${dest}, delete it, then rename the previous version back to ${dest}.`,
            EXIT.INSTALL_FAILED,
          );
        }
        try {
          fsImpl.renameSync(backup, dest);
        } catch (restoreError) {
          movedOld = false;
          throw new BeatGridError(
            'ROLLBACK_FAILED',
            `the new version failed its self-check (${error instanceof Error ? error.message : String(error)}) ` +
              `and the previous version could not be restored (${restoreError instanceof Error ? restoreError.message : String(restoreError)}). ` +
              `The previous version is kept at ${backup}; rename it back to ${dest}.`,
            EXIT.INSTALL_FAILED,
          );
        }
        movedOld = false;
      }
      throw error;
    }
    if (movedOld) {
      // The new version passed its self-check, so the backup is no longer needed; a failure to
      // delete it is harmless and leaves it for the next install to ignore.
      try {
        fsImpl.rmSync(backup, { recursive: true, force: true });
      } catch {
        log(`  could not delete the previous version at ${backup}`);
      }
      movedOld = false;
    }
    log(`  installed ${dest}`);
    return {
      dir: dest,
      executable: path.join(dest, executableName(target)),
      version: manifest.version,
      versionLine,
      model,
      models: modelsIn(dest),
      bytes: fs.statSync(path.join(dest, executableName(target))).size,
      replaced,
    };
  } catch (error) {
    // Only reached before the self-check (or after it passed): restore the previous version when
    // the new one never made it into place. The backup is never deleted.
    if (movedOld && !fs.existsSync(dest)) fs.renameSync(backup, dest);
    throw error;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// status

/** Whether the analyzer is installed, which version and target, and which models are present. */
export function status({
  manifest = loadManifest(),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const target = detectTarget(platform, arch);
  const base = {
    schemaVersion: 1,
    tool: 'beat-grid',
    command: 'status',
    manifest: { version: manifest.version, released: manifest.released === true, license: manifest.license },
    platform: { target, supported: target !== null },
    home: null,
    homeSource: null,
    installed: false,
    current: null,
    installations: [],
    models: { mel: false, final: false, small: false },
    download: null,
    notes: [],
  };
  if (target !== null) {
    const finalBytes =
      Number(manifest.platforms?.[target]?.approxBytes ?? 0) +
      Number(manifest.models?.mel?.approxBytes ?? 0) +
      Number(manifest.models?.final?.approxBytes ?? 0);
    const smallBytes =
      Number(manifest.platforms?.[target]?.approxBytes ?? 0) +
      Number(manifest.models?.mel?.approxBytes ?? 0) +
      Number(manifest.models?.small?.approxBytes ?? 0);
    base.download = { finalApproxBytes: finalBytes, smallApproxBytes: smallBytes };
  }
  if (manifest.released !== true)
    base.notes.push(
      `the ${String(manifest.releaseTag)} release of ${String(manifest.repository)} is not published yet; install ` +
        'refuses until it is and the manifest carries its sha256 values',
    );
  let homeInfo;
  try {
    homeInfo = dataHome(env);
  } catch (error) {
    if (error instanceof BeatGridError) {
      base.homeError = error.detail;
      base.notes.push(error.detail);
      return base;
    }
    throw error;
  }
  base.home = homeInfo.home;
  base.homeSource = homeInfo.source;
  const bin = binDir(homeInfo.home);
  const binEntries = fs.existsSync(bin) ? fs.readdirSync(bin, { withFileTypes: true }) : [];
  const entries = binEntries
    .filter((entry) => entry.isDirectory() && INSTALL_DIR_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const name of entries) {
    const match = INSTALL_DIR_RE.exec(name);
    if (match === null) continue;
    const dir = path.join(bin, name);
    const metadata = readInstallMetadata(dir);
    base.installations.push({
      version: match[1],
      target: match[2],
      dir,
      executable: fs.statSync(path.join(dir, executableName(match[2])), { throwIfNoEntry: false })?.isFile() === true,
      models: modelsIn(dir),
      model: typeof metadata?.model === 'string' ? metadata.model : null,
      installedAt: typeof metadata?.installedAt === 'string' ? metadata.installedAt : null,
    });
  }
  base.installations.sort((a, b) =>
    a.version === b.version ? a.target.localeCompare(b.target) : b.version.localeCompare(a.version),
  );
  const current = base.installations.find(
    (entry) => entry.version === manifest.version && entry.target === target && entry.executable,
  );
  if (current !== undefined) {
    base.installed = true;
    base.current = current;
    base.models = current.models;
  }
  return base;
}

// ---------------------------------------------------------------------------------------------
// analyze

function summarizeGrid(grid) {
  const summary = {
    schemaVersion: grid.schemaVersion,
    tool: grid.tool,
    model: grid.model,
    input: grid.input,
    params: grid.params,
    summary: grid.summary,
    segments: Array.isArray(grid.segments)
      ? grid.segments.map((segment) => ({
          index: segment.index,
          startSec: segment.startSec,
          endSec: segment.endSec,
          bpm: segment.bpm,
          timeSignature: segment.timeSignature,
          confidence: segment.confidence,
          octaveNote: segment.octaveNote,
          fitResidualMs: segment.fitResidualMs,
        }))
      : [],
    tempoChanges: grid.tempoChanges,
    refinement: grid.refinement,
    warnings: Array.isArray(grid.warnings) ? grid.warnings : [],
  };
  return summary;
}

/**
 * Runs the installed analyzer on one WAV file. Wrapper errors are thrown; an analyzer error is
 * returned with its JSON unchanged, so the caller can print it as the analyzer wrote it.
 */
export function analyze({
  manifest = loadManifest(),
  home,
  target = detectTarget(),
  input,
  model = 'final',
  out = null,
  force = false,
  run = runProcess,
} = {}) {
  if (target === null || !TARGETS.includes(target))
    throw new BeatGridError(
      'UNSUPPORTED_PLATFORM',
      'opentune-beats is published for Windows x64 and macOS universal2 only',
      EXIT.NOT_INSTALLED,
    );
  if (!MODELS.includes(model))
    throw new BeatGridError('USAGE', `--model must be final or small (found ${String(model)})`, EXIT.USAGE);
  if (typeof input !== 'string' || input === '')
    throw new BeatGridError('USAGE', 'analyze needs the path of a WAV file', EXIT.USAGE);
  const inputPath = path.resolve(input);
  if (!path.isAbsolute(input))
    throw new BeatGridError('INPUT_UNREADABLE', `give an absolute path to the WAV file (found ${input})`, EXIT.USAGE);
  const stat = fs.statSync(inputPath, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile())
    throw new BeatGridError('INPUT_UNREADABLE', `there is no file at ${input}`, EXIT.USAGE);
  if (path.extname(inputPath).toLowerCase() !== '.wav')
    throw new BeatGridError(
      'INPUT_UNREADABLE',
      `only .wav files are promised by the analyzer (found ${input})`,
      EXIT.USAGE,
    );
  if (out !== null) {
    if (path.extname(out).toLowerCase() !== '.json')
      throw new BeatGridError('OUT_REFUSED', `--out takes a .json file path (found ${out})`, EXIT.USAGE);
    if (!force && fs.existsSync(out))
      throw new BeatGridError(
        'OUT_EXISTS',
        `${out} already exists; choose another name, or pass --force to replace it`,
        EXIT.USAGE,
      );
  }
  const installed = currentInstallation(home, manifest, target);
  if (installed === null)
    throw new BeatGridError(
      'NOT_INSTALLED',
      `opentune-beats ${manifest.version} is not installed for ${target}; run the install step first`,
      EXIT.NOT_INSTALLED,
    );
  const result = run(
    installed.executable,
    ['analyze', inputPath, '--model', model, '--models-dir', path.join(installed.dir, 'models')],
    { timeoutMs: 30 * 60_000 },
  );
  const raw = result.stdout.trim();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new BeatGridError(
      'ANALYZER_OUTPUT',
      `opentune-beats exited with ${result.status} without printing one JSON object` +
        (result.stderr.trim() === '' ? '' : `: ${result.stderr.trim().slice(0, 500)}`),
      EXIT.ANALYSIS_FAILED,
    );
  }
  if (!isObject(json))
    throw new BeatGridError(
      'ANALYZER_OUTPUT',
      'opentune-beats printed JSON that is not an object',
      EXIT.ANALYSIS_FAILED,
    );
  const text = `${raw}\n`;
  if (out !== null && result.status === 0 && json.error === undefined) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text, { flag: force ? 'w' : 'wx' });
  }
  if (result.status !== 0 || json.error !== undefined) {
    // The analyzer distinguishes a missing model (3) and an unreadable input (4); keep that
    // distinction so the caller knows whether to repair the install or the path.
    const exitCode = result.status === 3 ? EXIT.NOT_INSTALLED : result.status === 4 ? EXIT.USAGE : EXIT.ANALYSIS_FAILED;
    return { ok: false, exitCode, json, raw: text };
  }
  return { ok: true, exitCode: EXIT.OK, json, raw: text, summary: summarizeGrid(json) };
}

// ---------------------------------------------------------------------------------------------
// timing plan

function notesFromJson(value) {
  const pages = [];
  const visit = (current) => {
    if (Array.isArray(current)) {
      if (current.length > 0 && current.every((item) => isObject(item) && !Array.isArray(item.notes))) {
        pages.push({ notes: current });
        return;
      }
      for (const item of current) visit(item);
      return;
    }
    if (!isObject(current))
      throw new BeatGridError('NOTES_UNREADABLE', 'the notes file is not an opentune_get_notes result', EXIT.USAGE);
    if (isObject(current.structuredContent)) {
      visit(current.structuredContent);
      return;
    }
    if (!Array.isArray(current.notes))
      throw new BeatGridError(
        'NOTES_UNREADABLE',
        'the notes file has no notes array; save the result of opentune_get_notes as it is',
        EXIT.USAGE,
      );
    pages.push(current);
  };
  visit(value);
  if (pages.length === 0) throw new BeatGridError('NOTES_UNREADABLE', 'the notes file holds no notes', EXIT.USAGE);
  const notes = [];
  for (const page of pages) {
    for (const note of page.notes) if (isObject(note)) notes.push(note);
  }
  const placementIds = new Set(pages.map((page) => page.placementId).filter((id) => typeof id === 'string'));
  const contentIds = new Set(pages.map((page) => page.contentId).filter((id) => typeof id === 'string'));
  const revisions = new Set(pages.map((page) => page.clip_revision).filter((revision) => typeof revision === 'string'));
  return {
    notes,
    pages: pages.length,
    placementId: placementIds.size === 1 ? [...placementIds][0] : null,
    contentId: contentIds.size === 1 ? [...contentIds][0] : null,
    clipRevision: revisions.size === 1 ? [...revisions][0] : null,
    mixedPlacement: placementIds.size > 1 || contentIds.size > 1,
    mixedRevision: revisions.size > 1,
    hasRevision: revisions.size > 0,
  };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Every grid point, on the grid clock and on the timeline clock (`grid time + gridOffsetSec`). */
function gridPoints(beats, subdivision, gridOffsetSec) {
  const points = [];
  for (const [index, beat] of beats.entries()) {
    points.push({ timeSec: beat.timeSec, timelineSec: beat.timeSec + gridOffsetSec, beatIndex: index, division: 0 });
    if (subdivision === 1) continue;
    const next = beats[index + 1];
    if (next === undefined) continue;
    if (beat.segment !== next.segment) continue;
    const step = next.timeSec - beat.timeSec;
    if (!(step > 0)) continue;
    for (let part = 1; part < subdivision; part++) {
      const timeSec = beat.timeSec + (step * part) / subdivision;
      points.push({ timeSec, timelineSec: timeSec + gridOffsetSec, beatIndex: index, division: part });
    }
  }
  points.sort((a, b) => a.timelineSec - b.timelineSec || a.division - b.division);
  return points;
}

/** The point nearest to `time` on the timeline clock; `points` is sorted by `timelineSec`. */
function nearestPoint(points, time) {
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].timelineSec < time) low = middle + 1;
    else high = middle;
  }
  const after = points[low];
  const before = low > 0 ? points[low - 1] : undefined;
  if (before === undefined) return after;
  return time - before.timelineSec <= after.timelineSec - time ? before : after;
}

function segmentAt(segments, time) {
  const sorted = segments
    .filter((segment) => isFiniteNumber(segment.startSec) && isFiniteNumber(segment.endSec))
    .sort((a, b) => a.startSec - b.startSec);
  let found = null;
  for (const segment of sorted) {
    if (segment.startSec <= time && time < segment.endSec) return segment;
    if (segment.startSec <= time) found = segment;
  }
  return found;
}

/**
 * Turns a grid and the notes of a vocal clip into opentune_edit_timing suggestions.
 *
 * The grid times are seconds from the start of the backing-track file; `gridOffsetSec` is where
 * that file starts on the OpenTune timeline (a clip's startTimelineSec minus its clipInContentSec).
 * The notes carry both clocks (opentune_get_notes with a placement id): startTimelineSec is used to
 * find the nearest beat, startContentSec to give opentune_edit_timing its range. The singer's
 * overall lead or lag is the median deviation and is removed before the threshold is applied.
 */
export function timingPlan({ grid, notes, gridOffsetSec, thresholdMs = DEFAULT_THRESHOLD_MS, subdivision = 1 } = {}) {
  if (!isObject(grid) || !Array.isArray(grid.beats) || grid.beats.length === 0)
    throw new BeatGridError(
      'NO_BEATS',
      'the grid file has no beats; run analyze without --summary and pass the full JSON',
      EXIT.USAGE,
    );
  if (!isFiniteNumber(gridOffsetSec))
    throw new BeatGridError(
      'USAGE',
      '--grid-offset-sec must be a number of seconds; it may be negative when the backing file starts before the timeline',
      EXIT.USAGE,
    );
  if (!isFiniteNumber(thresholdMs) || thresholdMs < 0)
    throw new BeatGridError('USAGE', '--threshold-ms must be a number of milliseconds, 0 or more', EXIT.USAGE);
  if (!SUBDIVISIONS.includes(subdivision))
    throw new BeatGridError('USAGE', '--subdivision must be 1, 2 or 4', EXIT.USAGE);

  const parsedNotes = notesFromJson(notes);
  const warnings = [];
  if (parsedNotes.mixedPlacement)
    warnings.push({
      code: 'MIXED_PLACEMENTS',
      detail:
        'the saved notes come from more than one clip, so no ready call is given; read the notes of one clip and make a separate plan for each clip',
    });
  if (parsedNotes.mixedRevision)
    warnings.push({
      code: 'REVISION_MISMATCH',
      detail: 'the pages were read at different clip revisions; read the clip again before applying anything',
    });
  const clip = parsedNotes.placementId ?? parsedNotes.contentId;
  if (clip === null)
    warnings.push({
      code: 'NO_CLIP',
      detail:
        'the notes file does not name the clip; save the whole opentune_get_notes result (it has placementId and ' +
        'clip_revision) to get ready-to-use calls',
    });
  if (parsedNotes.clipRevision === null)
    warnings.push({
      code: 'NO_REVISION',
      detail: parsedNotes.hasRevision
        ? 'the saved pages were read at different clip revisions; read the clip again before applying a call'
        : 'the notes file has no clip_revision; read the clip again with opentune_get_project before applying a call',
    });

  const beats = grid.beats
    .filter((beat) => isObject(beat) && isFiniteNumber(beat.timeSec))
    .map((beat) => ({ ...beat }))
    .sort((a, b) => a.timeSec - b.timeSec);
  if (beats.length === 0) throw new BeatGridError('NO_BEATS', 'the grid file has no beat with a time', EXIT.USAGE);
  const segments = Array.isArray(grid.segments) ? grid.segments.filter(isObject) : [];
  if (segments.length === 0)
    warnings.push({
      code: 'NO_SEGMENTS',
      detail: 'the grid has no tempo segments; each suggestion has no segment tempo',
    });

  const points = gridPoints(beats, subdivision, gridOffsetSec);
  const first = points[0].timelineSec;
  const last = points[points.length - 1].timelineSec;
  const considered = [];
  let skippedUnvoiced = 0;
  let skippedOutside = 0;
  let skippedWithoutTimeline = 0;
  let clockMismatch = 0;
  let placementOffset = null;

  for (const note of parsedNotes.notes) {
    if (note.voiced === false) {
      skippedUnvoiced += 1;
      continue;
    }
    if (!isFiniteNumber(note.startTimelineSec)) {
      skippedWithoutTimeline += 1;
      continue;
    }
    if (note.startTimelineSec < first - 1e-6 || note.startTimelineSec > last + 1e-6) {
      skippedOutside += 1;
      continue;
    }
    const offset =
      isFiniteNumber(note.startContentSec) && isFiniteNumber(note.startTimelineSec)
        ? note.startContentSec - note.startTimelineSec
        : null;
    if (offset !== null) {
      if (placementOffset === null) placementOffset = offset;
      else if (Math.abs(offset - placementOffset) > 0.002) clockMismatch += 1;
    }
    const point = nearestPoint(points, note.startTimelineSec);
    const segment = segmentAt(segments, point.timeSec);
    considered.push({ note, point, segment, offset });
  }
  if (skippedWithoutTimeline > 0 && considered.length === 0)
    throw new BeatGridError(
      'NOTES_WITHOUT_TIMELINE',
      'the notes have no startTimelineSec; call opentune_get_notes with the clip placement id (p:...) so each note ' +
        'carries both clocks, then save the result',
      EXIT.USAGE,
    );
  if (skippedOutside > 0)
    warnings.push({
      code: 'OUTSIDE_GRID',
      detail: `${String(skippedOutside)} note(s) start before the first or after the last beat and were left out`,
    });
  if (skippedUnvoiced > 0)
    warnings.push({ code: 'UNVOICED_NOTES', detail: `${String(skippedUnvoiced)} unvoiced note(s) were left out` });
  if (skippedWithoutTimeline > 0)
    warnings.push({
      code: 'NOTES_WITHOUT_TIMELINE',
      detail: `${String(skippedWithoutTimeline)} note(s) have no timeline time and were left out`,
    });
  if (clockMismatch > 0)
    warnings.push({
      code: 'CLOCK_MISMATCH',
      detail:
        `${String(clockMismatch)} note(s) do not share the same content-to-timeline offset; the ranges use each ` +
        "note's own content times, but check the clip placement before applying anything",
    });

  const deviations = considered.map(({ note, point }) => (note.startTimelineSec - point.timelineSec) * 1000);
  const globalOffsetMs = median(deviations);
  const suggestions = [];
  let deltaTooLarge = 0;
  // A ready call needs one clip and one revision: a mixed or missing one would be guessed, so
  // those plans give the numbers and the warnings without a call.
  const callable =
    clip !== null && parsedNotes.clipRevision !== null && !parsedNotes.mixedPlacement && !parsedNotes.mixedRevision;
  for (const { note, point, segment, offset } of considered) {
    const deviationMs = (note.startTimelineSec - point.timelineSec) * 1000;
    const adjustedMs = deviationMs - (globalOffsetMs ?? 0);
    if (Math.abs(adjustedMs) < thresholdMs) continue;
    const deltaMs = -Math.round(adjustedMs);
    // A shift that rounds to zero would only add an undo step that changes nothing.
    if (deltaMs === 0) continue;
    if (Math.abs(deltaMs) > MAX_DELTA_MS) {
      deltaTooLarge += 1;
      continue;
    }
    const startContentSec = isFiniteNumber(note.startContentSec)
      ? note.startContentSec
      : offset === null
        ? null
        : note.startTimelineSec + offset;
    const endContentSec = isFiniteNumber(note.endContentSec)
      ? note.endContentSec
      : isFiniteNumber(note.endTimelineSec)
        ? note.endTimelineSec + (offset ?? 0)
        : null;
    if (startContentSec === null) continue;
    const start = round(startContentSec, 4);
    const end = round(Math.max(endContentSec ?? startContentSec + 0.001, start + 0.001), 4);
    const op = { op: 'shift', start_content_sec: start, end_content_sec: end, delta_ms: deltaMs };
    const beat = beats[point.beatIndex];
    // opentune_edit_timing has no dry_run: this plan is the preview, and the call is made only
    // after the user agrees to it.
    const editTiming =
      callable && suggestions.length < MAX_OPS_PER_CALL
        ? { clip, expected_revision: parsedNotes.clipRevision, ops: [op] }
        : null;
    suggestions.push({
      noteIndex: isFiniteNumber(note.index) ? note.index : null,
      noteStartContentSec: round(startContentSec, 4),
      noteStartTimelineSec: round(note.startTimelineSec, 4),
      gridPoint: {
        timeSec: round(point.timeSec, 4),
        timelineSec: round(point.timelineSec, 4),
        kind: point.division === 0 ? 'beat' : 'subdivision',
        division: point.division,
        beatIndex: point.beatIndex,
        isDownbeat: point.division === 0 && beat?.isDownbeat === true,
      },
      deviationMs: round(deviationMs, 1),
      adjustedDeviationMs: round(adjustedMs, 1),
      deltaMs,
      segment:
        segment === null
          ? null
          : {
              index: segment.index,
              bpm: segment.bpm,
              timeSignature: segment.timeSignature,
              confidence: segment.confidence,
            },
      editTiming,
    });
  }
  if (deltaTooLarge > 0)
    warnings.push({
      code: 'DELTA_TOO_LARGE',
      detail: `${String(deltaTooLarge)} suggestion(s) would move more than ${String(MAX_DELTA_MS)} ms and were left out`,
    });
  if (considered.length === 0)
    warnings.push({
      code: 'NO_USABLE_NOTES',
      detail: 'no note with both a timeline time inside the grid and a content time was found',
    });

  // One call at a time: a write moves the notes and changes the revision, so every later
  // suggestion is stale after the first call. Only the first call is given; the rest are listed
  // without a call and are planned again from fresh notes.
  const calls = [];
  if (callable && suggestions.length > 0) {
    const ops = suggestions.slice(0, MAX_OPS_PER_CALL).map((suggestion) => suggestion.editTiming.ops[0]);
    calls.push({ clip, expected_revision: parsedNotes.clipRevision, ops });
  }
  const remainingSuggestions = callable ? Math.max(0, suggestions.length - MAX_OPS_PER_CALL) : 0;
  if (remainingSuggestions > 0)
    warnings.push({
      code: 'REPLAN_AFTER_CALL',
      detail:
        `${String(remainingSuggestions)} more suggestion(s) are listed without a call. After the first call is applied ` +
        'and the user has heard it, read the notes again with opentune_get_notes and run timing-plan again; do not reuse this plan for them.',
    });

  return {
    schemaVersion: 1,
    tool: 'beat-grid',
    command: 'timing-plan',
    params: { gridOffsetSec, thresholdMs, subdivision, model: grid.model?.name ?? null },
    conventions: {
      deviationMs: 'note start minus the nearest grid point; positive means the note is late',
      globalOffsetMs: 'median deviation removed before the threshold; positive means the singer is late overall',
      deltaMs: 'the shift to apply, the negative of the adjusted deviation; negative moves the note earlier',
    },
    clock: {
      grid: 'seconds from the start of the backing-track file the grid was analyzed from',
      notes: 'startTimelineSec and startContentSec as opentune_get_notes returns them for a clip placement',
      gridToTimeline: `timeline = grid time ${gridOffsetSec < 0 ? '-' : '+'} ${Math.abs(gridOffsetSec)}`,
      timelineToContent: 'content = timeline + (startContentSec - startTimelineSec) of the note',
      placementOffsetSec: placementOffset === null ? null : round(placementOffset, 6),
    },
    grid: {
      beats: beats.length,
      firstBeatSec: round(beats[0].timeSec, 4),
      lastBeatSec: round(beats[beats.length - 1].timeSec, 4),
      segments: segments.length,
      dominantBpm: grid.summary?.dominantBpm ?? null,
      model: grid.model?.name ?? null,
    },
    notes: {
      pages: parsedNotes.pages,
      count: parsedNotes.notes.length,
      used: considered.length,
      placementId: parsedNotes.placementId,
      contentId: parsedNotes.contentId,
      clipRevision: parsedNotes.clipRevision,
    },
    globalOffsetMs: globalOffsetMs === null ? null : round(globalOffsetMs, 1),
    counts: { flagged: suggestions.length, calls: calls.length, remainingSuggestions },
    apply: {
      tool: 'opentune_edit_timing',
      maxOpsPerCall: MAX_OPS_PER_CALL,
      note:
        'opentune_edit_timing has no dry-run parameter: this plan is the preview. Show it to the user and get ' +
        'their agreement before calling. calls holds only the first call (at most maxOpsPerCall ops, with ' +
        'expected_revision); after it, read the notes again and run timing-plan again for the rest. Each call is one ' +
        'undo step.',
    },
    suggestions,
    calls,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// command line

function usageError(detail) {
  return new BeatGridError('USAGE', `${detail}\n\n${USAGE}`, EXIT.USAGE);
}

const COMMAND_OPTIONS = Object.freeze({
  status: {},
  install: { model: 'value', yes: 'flag' },
  analyze: { model: 'value', out: 'value', force: 'flag', summary: 'flag' },
  'timing-plan': {
    grid: 'value',
    notes: 'value',
    'grid-offset-sec': 'value',
    'threshold-ms': 'value',
    subdivision: 'value',
  },
});

/** Reads one command line into `{ command, options, positionals }`; usage errors throw. */
export function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help')
    return { command: 'help', options: {}, positionals: [] };
  const [command, ...rest] = argv;
  const spec = COMMAND_OPTIONS[command];
  if (spec === undefined) throw usageError(`unknown command ${JSON.stringify(command)}`);
  const options = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const name = equals < 0 ? token.slice(2) : token.slice(2, equals);
    const kind = spec[name];
    if (kind === undefined) throw usageError(`unknown option --${name} for ${command}`);
    if (kind === 'flag') {
      if (equals >= 0) throw usageError(`--${name} takes no value`);
      options[name] = true;
      continue;
    }
    const value = equals >= 0 ? token.slice(equals + 1) : rest[++i];
    if (value === undefined || value === '') throw usageError(`--${name} needs a value`);
    options[name] = value;
  }
  const allowedPositionals = command === 'analyze' ? 1 : 0;
  if (positionals.length !== allowedPositionals)
    throw usageError(
      command === 'analyze'
        ? 'analyze takes exactly one WAV path'
        : `${command} takes no positional arguments (found ${positionals.length})`,
    );
  return { command, options, positionals };
}

function parseNumberOption(options, name, { fallback = null, min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  if (options[name] === undefined) return fallback;
  const value = Number(options[name]);
  if (!Number.isFinite(value) || value < min || value > max)
    throw usageError(
      `--${name} must be a number from ${String(min)} to ${String(max)} (found ${String(options[name])})`,
    );
  return value;
}

function writeJson(out, value) {
  out(`${JSON.stringify(value, null, 2)}\n`);
}

/** Runs one command; returns the exit code and writes stdout and stderr through the given sinks. */
export async function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    cwd = process.cwd(),
    platform = process.platform,
    arch = process.arch,
    out = (text) => process.stdout.write(text),
    err = (text) => process.stderr.write(text),
    run = runProcess,
    selfCheck,
  } = {},
) {
  try {
    const parsed = parseArgs(argv);
    if (parsed.command === 'help') {
      out(USAGE);
      return EXIT.OK;
    }
    if (parsed.command === 'status') {
      writeJson(out, status({ manifest: loadManifest(), env, platform, arch }));
      return EXIT.OK;
    }
    if (parsed.command === 'install') {
      const manifest = loadManifest();
      const model = parsed.options.model ?? 'final';
      if (!MODELS.includes(model)) throw usageError(`--model must be final or small (found ${String(model)})`);
      const target = detectTarget(platform, arch);
      let home = null;
      try {
        home = dataHome(env).home;
      } catch {
        home = null;
      }
      const plan = installPlan({ manifest, target, model, home });
      if (parsed.options.yes !== true) {
        out(formatPlan(plan));
        return EXIT.OK;
      }
      const resolved = dataHome(env);
      if (plan.problems.length > 0)
        throw new BeatGridError('INSTALL_REFUSED', plan.problems.join('; '), EXIT.INSTALL_FAILED);
      const result = await install({
        manifest,
        home: resolved.home,
        target,
        model,
        log: (line) => err(`${line}\n`),
        ...(selfCheck === undefined ? {} : { selfCheck }),
      });
      writeJson(out, { schemaVersion: 1, ok: true, command: 'install', ...result });
      return EXIT.OK;
    }
    if (parsed.command === 'analyze') {
      const manifest = loadManifest();
      const model = parsed.options.model ?? 'final';
      const outFile = parsed.options.out === undefined ? null : path.resolve(cwd, parsed.options.out);
      const result = analyze({
        manifest,
        home: dataHome(env).home,
        target: detectTarget(platform, arch),
        input: parsed.positionals[0],
        model,
        out: outFile,
        force: parsed.options.force === true,
        run,
      });
      out(
        result.ok && parsed.options.summary === true
          ? `${JSON.stringify(result.summary, null, 2)}\n`
          : result.ok && outFile !== null
            ? `Wrote ${outFile}\n`
            : result.raw,
      );
      return result.exitCode;
    }
    if (parsed.command === 'timing-plan') {
      const gridFile = parsed.options.grid;
      const notesFile = parsed.options.notes;
      const offset = parsed.options['grid-offset-sec'];
      if (gridFile === undefined) throw usageError('timing-plan needs --grid <grid.json>');
      if (notesFile === undefined) throw usageError('timing-plan needs --notes <notes.json>');
      if (offset === undefined) throw usageError('timing-plan needs --grid-offset-sec <s>');
      // The numbers are checked before any file is read, so a typo in an option is not masked by
      // an unreadable file.
      const gridOffsetSec = parseNumberOption(parsed.options, 'grid-offset-sec', {
        min: Number.NEGATIVE_INFINITY,
      });
      const thresholdMs = parseNumberOption(parsed.options, 'threshold-ms', { fallback: DEFAULT_THRESHOLD_MS });
      const subdivision = parseNumberOption(parsed.options, 'subdivision', { fallback: 1, min: 1, max: 4 });
      const readJson = (file, code) => {
        try {
          return JSON.parse(fs.readFileSync(path.resolve(cwd, file), 'utf8').replace(/^\uFEFF/, ''));
        } catch (error) {
          throw new BeatGridError(
            code,
            `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
            EXIT.USAGE,
          );
        }
      };
      const plan = timingPlan({
        grid: readJson(gridFile, 'GRID_UNREADABLE'),
        notes: readJson(notesFile, 'NOTES_UNREADABLE'),
        gridOffsetSec,
        thresholdMs,
        subdivision,
      });
      writeJson(out, plan);
      return EXIT.OK;
    }
    throw usageError(`unknown command ${JSON.stringify(parsed.command)}`);
  } catch (error) {
    if (error instanceof BeatGridError) {
      writeJson(out, { schemaVersion: 1, tool: 'beat-grid', error: { code: error.code, detail: error.message } });
      err(`${error.code}: ${error.message}\n`);
      return error.exitCode;
    }
    const detail = error instanceof Error ? error.message : String(error);
    writeJson(out, { schemaVersion: 1, tool: 'beat-grid', error: { code: 'INTERNAL', detail } });
    err(`INTERNAL: ${detail}\n`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
