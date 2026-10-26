// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// beat-grid: install and drive the opentune-beats tempo and beat-grid analyzer, and turn its grid
// plus the notes of a vocal clip into opentune_edit_timing suggestions. Node.js 22 or later, ESM,
// no third-party dependencies. The plugin already needs Node for the MCP server, so this skill
// ships no Python.
//
// Usage (every command also takes --home <folder> and --help):
//   node beat-grid.mjs status
//   node beat-grid.mjs install --model final|small [--yes]
//   node beat-grid.mjs analyze <wav> [--model final|small] [--out <file>.json [--force]] [--summary]
//                                  [--no-refine] [--min-segment-beats <n>]
//   node beat-grid.mjs timing-plan --grid <grid.json> --notes <notes.json> --grid-offset-sec <s>
//                                  [--threshold-ms 30] [--subdivision 1|2|4] [--merge-gap-ms 30]
//                                  [--merge-cents 300] [--min-note-ms 60]
//   node beat-grid.mjs align --vocal <wav> --backing <wav> [--max-lag-sec 2]
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
// The data folder, by priority: --home, then these two variables in this order.
export const HOME_ENV = Object.freeze(['OPENTUNE_BEATS_HOME', 'CLAUDE_PLUGIN_DATA']);
export const HOME_OPTION = '--home';
export const MODELS = Object.freeze(['final', 'small']);
export const TARGETS = Object.freeze(['win-x64', 'macos-universal2']);
export const SUBDIVISIONS = Object.freeze([1, 2, 4]);
// GitHub serves release assets from github.com and redirects them to a signed URL on one of these
// hosts (objects.githubusercontent.com, or release-assets.githubusercontent.com for newer
// releases). A final URL on any other host means the download left GitHub, so it is refused even
// when the sha256 matches: the pinned hash says which bytes are wanted, not that these bytes are
// the ones the release published.
export const DOWNLOAD_HOSTS = Object.freeze([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
export const DEFAULT_THRESHOLD_MS = 30;
// opentune_edit_timing takes up to 64 operations in one call (each shift is one request and one undo step).
export const MAX_OPS_PER_CALL = 64;
export const MAX_DELTA_MS = 10_000;
// Merging the fragments of one sung syllable into a single rhythm onset (see timingPlan). Two voiced
// notes belong to one chain when the next starts less than DEFAULT_MERGE_GAP_MS after the previous
// ends (automatic note splitting cuts a glide into pieces that touch) and their pitches differ by
// less than DEFAULT_MERGE_CENTS (a glide stays inside a few semitones; a new syllable on a new pitch
// is a leap). A note shorter than DEFAULT_MIN_NOTE_MS that is not part of a chain is a fragment, not an
// onset a listener hears.
export const DEFAULT_MERGE_GAP_MS = 30;
export const DEFAULT_MERGE_CENTS = 300;
export const DEFAULT_MIN_NOTE_MS = 60;
// align: onset envelopes at 100 Hz, searched within +-2 s; the peak must beat the next-best peak by
// this ratio for the answer to be called confident.
export const ALIGN_FRAME_HZ = 100;
export const ALIGN_MAX_LAG_SEC = 2;
export const ALIGN_MIN_CONFIDENCE = 1.5;
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

const HOME_HELP = `  --home <folder>   The data folder (the analyzer is installed under <folder>/bin). Priority: --home,
                    then OPENTUNE_BEATS_HOME, then CLAUDE_PLUGIN_DATA. An empty value, or a variable that
                    was not replaced, counts as not given. Accepted by every command; only status,
                    install and analyze use it.`;

/** The usage text of each command, printed by `<command> --help` and `help <command>` (exit code 0). */
const COMMAND_HELP = Object.freeze({
  status: `beat-grid status [--home <folder>]
    Whether opentune-beats is installed, its version and folder, the models it has, and where the data
    folder came from (homeSource: --home, OPENTUNE_BEATS_HOME or CLAUDE_PLUGIN_DATA). JSON.

${HOME_HELP}
`,
  install: `beat-grid install --model final|small [--yes] [--home <folder>]
    Run status first: when it says installed (and the model is there) there is nothing to install.
    Without --yes: print what would be downloaded, its size and its licence, and change nothing; when the
    analyzer is already installed it says so (exit 0, no problems, whatever the release state is).
    With --yes: download, verify every sha256, extract, install and check --version; when the analyzer is
    already installed it only reports that and downloads nothing.

${HOME_HELP}
`,
  analyze: `beat-grid analyze <wav> [--model final|small] [--out <file>.json [--force]] [--summary]
                        [--no-refine] [--min-segment-beats <n>] [--home <folder>]
    Run the analyzer on a WAV file (an absolute path). Without --summary the analyzer's JSON is printed,
    or written to --out (a .json path that must not exist yet, unless --force) with one line on stdout;
    with --summary the beat list is left out (segments, tempi, confidence and warnings only).
    --no-refine turns off the analyzer's beat refinement; --min-segment-beats sets the shortest
    constant-tempo segment it reports (an integer of 1 or more).

${HOME_HELP}
`,
  'timing-plan': `beat-grid timing-plan --grid <grid.json> --notes <notes.json> --grid-offset-sec <s>
                        [--threshold-ms 30] [--subdivision 1|2|4] [--merge-gap-ms 30]
                        [--merge-cents 300] [--min-note-ms 60] [--home <folder>]
    Turn a grid and the notes of a vocal clip into opentune_edit_timing suggestions to review before any
    call. --notes is the file written by opentune_get_notes with output_path (the older saved pages of
    several results are read too). The singer's overall lead or lag (the median) is removed before the
    threshold is applied.
    Fragments are merged first: a note that starts less than --merge-gap-ms after the previous one ends
    and whose pitch is within --merge-cents of it belongs to the same chain; only the start of a chain is
    a rhythm onset and gets a suggestion, and the chain's span is the range of its op. A note shorter than
    --min-note-ms that is not in a chain gets none. The output lists every batch of up to 64 ops in
    calls; apply calls[0] only, then read the notes again and plan again.
    --home is accepted and ignored.
`,
  align: `beat-grid align --vocal <wav> --backing <wav> [--max-lag-sec 2] [--home <folder>]
    Find how much later (positive) or earlier (negative) the events of the vocal file are than those of
    the backing file, from their onset envelopes (100 Hz frames, cross-correlated within +-max-lag-sec,
    default 2, at most 10). Prints lagSec, confidence (the peak over the next-best peak; 1.5 or more is
    confident) and gridOffsetSec = (vocal clip startTimelineSec - clipInContentSec) + lagSec as a formula.
    Reads 16, 24 and 32 bit PCM and 32 bit float WAV files (absolute paths). --home is accepted and ignored.
`,
});

const USAGE = `beat-grid: tempo and beat grid for OpenTune, from the opentune-beats analyzer.

Commands (beat-grid <command> --help prints the usage of one):

  status        Whether opentune-beats is installed, and where the data folder is.
  install       Download and install the analyzer (asks for --yes).
  analyze       Run the analyzer on a WAV file.
  timing-plan   Turn a beat grid and the notes of a vocal into opentune_edit_timing batches.
  align         Check whether a vocal file and a backing file start together.

Exit codes: 0 success, 2 usage or unreadable input, 3 not installed, 4 install failure,
5 the analyzer reported an error. Data folder: --home, else OPENTUNE_BEATS_HOME, else CLAUDE_PLUGIN_DATA.
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

/** Whether a --home value is empty or a variable reference the shell or the skill did not replace. */
export function unusableHomeOption(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(text) || /^%[A-Za-z_][A-Za-z0-9_]*%$/.test(text);
}

/**
 * The data folder and where it came from. Priority: the --home option, then OPENTUNE_BEATS_HOME, then
 * CLAUDE_PLUGIN_DATA. An empty --home, or one that is still an unreplaced variable such as
 * ${CLAUDE_PLUGIN_DATA} (the skill text is only filled in when it runs as part of the plugin), counts as
 * not given. An error when no folder is given at all.
 */
export function dataHome(env = process.env, homeOption = null) {
  if (!unusableHomeOption(homeOption)) return { home: path.resolve(homeOption.trim()), source: HOME_OPTION };
  for (const name of HOME_ENV) {
    const value = (env[name] ?? '').trim();
    if (value !== '') return { home: path.resolve(value), source: name };
  }
  throw new BeatGridError(
    'NO_HOME',
    'No data folder is given: --home is empty or missing, and neither OPENTUNE_BEATS_HOME nor CLAUDE_PLUGIN_DATA is set. ' +
      'When the skill runs as part of the plugin, pass --home with the plugin data folder (CLAUDE_PLUGIN_DATA). ' +
      'Otherwise choose a short folder with ASCII characters only (for example C:/OpenTuneBeats) and pass it as --home ' +
      '(or set OPENTUNE_BEATS_HOME to it), the same one for install and for every run.',
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
  // A usable installation is all there is to do, whatever the state of the release is: the release
  // only matters for a download, and nothing is downloaded when the analyzer is already here. The
  // problems below are about a download, so an installation has none.
  const installed = existingInstall({ manifest: safe, home, target, model });
  const problems = [];
  if (installed === null) {
    problems.push(...manifestProblems(manifest));
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
    installed,
    problems,
  };
}

/** What `install` says when the analyzer is already installed: nothing to download, nothing to agree to. */
function formatInstalled(installed, model) {
  const present = Object.entries(installed.models)
    .filter(([, here]) => here)
    .map(([name]) => name);
  return (
    'beat-grid install plan: already installed, nothing to download (and nothing to ask the user):\n' +
    `  Tool      : ${installed.tool} ${installed.version} (${installed.target})\n` +
    `  Folder    : ${installed.dir}\n` +
    `  Models    : ${present.join(', ')} (the requested model is ${model})\n` +
    'Nothing was downloaded and nothing was changed. Skip the install and go on with the next step; the state of ' +
    'the release does not matter. To install again, delete the folder first.\n'
  );
}

/** The plan as text for the user, before any consent; fixed wording, no remote text. */
export function formatPlan(plan) {
  if (plan.installed !== null && plan.installed !== undefined) return formatInstalled(plan.installed, plan.model);
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
  // The redirect is followed, so `response.url` is where the bytes really came from. Check it
  // before the destination file is opened: a download that left GitHub writes nothing at all.
  const finalUrl = typeof response.url === 'string' ? response.url.trim() : '';
  let parsedUrl;
  try {
    parsedUrl = finalUrl === '' ? null : new URL(finalUrl);
  } catch {
    parsedUrl = null;
  }
  if (parsedUrl === null || parsedUrl.protocol !== 'https:' || !DOWNLOAD_HOSTS.includes(parsedUrl.hostname)) {
    throw new BeatGridError(
      'DOWNLOAD_HOST',
      `${what}: the download of ${url} ended at ${finalUrl === '' ? '(no URL)' : finalUrl}, which is not an https ` +
        `URL on a GitHub release host (${DOWNLOAD_HOSTS.join(', ')}); nothing was written`,
      EXIT.INSTALL_FAILED,
    );
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
 * The usable installation of the manifest's version for `target` in `home`, or null: the program is there
 * and so are the mel model and `model`. These are the facts `status` reports (installed, models), so the
 * install plan and `status` never disagree about whether the analyzer is installed.
 */
export function existingInstall({ manifest, home, target, model }) {
  if (home === null || typeof manifest?.version !== 'string' || typeof manifest.tool !== 'string') return null;
  if (target === null || !TARGETS.includes(target)) return null;
  const found = currentInstallation(home, manifest, target);
  if (found === null) return null;
  const models = modelsIn(found.dir);
  if (!models.mel || models[model] !== true) return null;
  const metadata = readInstallMetadata(found.dir);
  return {
    tool: 'opentune-beats',
    version: manifest.version,
    target,
    dir: found.dir,
    executable: found.executable,
    models,
    installedModel: typeof metadata?.model === 'string' ? metadata.model : null,
  };
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

/** Splits `major.minor.patch[-prerelease]`; null when the folder name does not have that shape. */
function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (match === null) return null;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/** Compares two numeric prerelease identifiers of any length without losing precision. */
function compareNumericIdentifiers(a, b) {
  const left = a.replace(/^0+(?=\d)/, '');
  const right = b.replace(/^0+(?=\d)/, '');
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Semantic-version order (semver 2.0.0 item 11): negative when `a` is older than `b`, zero when
 * they are equal. A version without a prerelease is greater; prerelease identifiers are compared
 * numerically when both are numeric, lexically otherwise, and a numeric identifier is lower than
 * an alphanumeric one. A name that is not a version falls back to a plain string comparison.
 */
export function compareVersions(a, b) {
  const left = parseVersion(String(a));
  const right = parseVersion(String(b));
  if (left === null || right === null) return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  for (let i = 0; i < 3; i++) {
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] - right.numbers[i];
  }
  // A prerelease is lower than the release it leads to.
  if (left.prerelease.length === 0 || right.prerelease.length === 0)
    return right.prerelease.length - left.prerelease.length;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    const one = left.prerelease[i];
    const other = right.prerelease[i];
    // A shorter set of identifiers is lower when all the shared ones are equal.
    if (one === undefined) return -1;
    if (other === undefined) return 1;
    const oneNumeric = /^\d+$/.test(one);
    const otherNumeric = /^\d+$/.test(other);
    if (oneNumeric && otherNumeric) {
      const order = compareNumericIdentifiers(one, other);
      if (order !== 0) return order;
    } else if (oneNumeric !== otherNumeric) {
      return oneNumeric ? -1 : 1;
    } else if (one !== other) {
      return one < other ? -1 : 1;
    }
  }
  return 0;
}

/** Whether the analyzer is installed, which version and target, and which models are present. */
export function status({
  manifest = loadManifest(),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  homeOption = null,
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
  // Only worth saying when there is nothing installed to use: an installed analyzer does not need the release.
  const unreleased =
    manifest.released === true
      ? []
      : [
          `the ${String(manifest.releaseTag)} release of ${String(manifest.repository)} is not published yet; install ` +
            'refuses until it is and the manifest carries its sha256 values',
        ];
  let homeInfo;
  if (typeof homeOption === 'string' && homeOption.trim() !== '' && unusableHomeOption(homeOption))
    base.notes.push(
      `--home was given as ${JSON.stringify(homeOption)}, which is a variable that was not replaced; it was ignored`,
    );
  try {
    homeInfo = dataHome(env, homeOption);
  } catch (error) {
    if (error instanceof BeatGridError) {
      base.homeError = error.detail;
      base.notes.push(error.detail);
      base.notes.unshift(...unreleased);
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
  base.installations.sort((a, b) => compareVersions(b.version, a.version) || a.target.localeCompare(b.target));
  const current = base.installations.find(
    (entry) => entry.version === manifest.version && entry.target === target && entry.executable,
  );
  if (current !== undefined) {
    base.installed = true;
    base.current = current;
    base.models = current.models;
  } else {
    base.notes.unshift(...unreleased);
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
  refine = true,
  minSegmentBeats = null,
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
  if (
    minSegmentBeats !== null &&
    minSegmentBeats !== undefined &&
    (!Number.isInteger(minSegmentBeats) || minSegmentBeats < 1)
  )
    throw new BeatGridError(
      'USAGE',
      `--min-segment-beats must be an integer of 1 or more (found ${String(minSegmentBeats)})`,
      EXIT.USAGE,
    );
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
  const args = ['analyze', inputPath, '--model', model, '--models-dir', path.join(installed.dir, 'models')];
  if (refine === false) args.push('--no-refine');
  if (minSegmentBeats !== null && minSegmentBeats !== undefined)
    args.push('--min-segment-beats', String(minSegmentBeats));
  const result = run(installed.executable, args, { timeoutMs: 30 * 60_000 });
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
  // The clip each note was read from, so that fragments of different clips are never chained together.
  const clipOf = new Map();
  for (const page of pages) {
    const key =
      typeof page.placementId === 'string'
        ? page.placementId
        : typeof page.contentId === 'string'
          ? page.contentId
          : null;
    for (const note of page.notes) {
      if (!isObject(note)) continue;
      notes.push(note);
      clipOf.set(note, key);
    }
  }
  const placementIds = new Set(pages.map((page) => page.placementId).filter((id) => typeof id === 'string'));
  const contentIds = new Set(pages.map((page) => page.contentId).filter((id) => typeof id === 'string'));
  const revisions = new Set(pages.map((page) => page.clip_revision).filter((revision) => typeof revision === 'string'));
  return {
    notes,
    clipOf,
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

const pitchOf = (note) => {
  if (isFiniteNumber(note.detectedMidi)) return note.detectedMidi;
  if (isFiniteNumber(note.targetMidi)) return note.targetMidi;
  return null;
};

/** The span of a note on the content clock, or null when it has no content start. */
function contentSpan(note) {
  if (!isFiniteNumber(note.startContentSec)) return null;
  const start = note.startContentSec;
  let end = start;
  if (isFiniteNumber(note.endContentSec)) end = note.endContentSec;
  else if (isFiniteNumber(note.endTimelineSec) && isFiniteNumber(note.startTimelineSec))
    end = start + (note.endTimelineSec - note.startTimelineSec);
  return { start, end: Math.max(end, start) };
}

/**
 * Groups voiced notes of one clip into chains of fragments of the same sung syllable. Notes are taken
 * in order of their content start; a note joins the chain before it when it starts less than
 * `mergeGapMs` after the chain ends (an overlap counts as a gap of 0 or less) and its pitch is within
 * `mergeCents` of the previous note's (detectedMidi, else targetMidi; with no pitch on either side only
 * the gap decides). Notes of different clips (`keyOf`) never join. Returns chains in order, each with
 * its notes, its start and its end (the latest end of its notes) on the content clock.
 */
export function chainNotes(
  notes,
  { mergeGapMs = DEFAULT_MERGE_GAP_MS, mergeCents = DEFAULT_MERGE_CENTS, keyOf = () => null } = {},
) {
  const entries = [];
  for (const note of notes) {
    const span = contentSpan(note);
    if (span !== null) entries.push({ note, span, key: keyOf(note) });
  }
  entries.sort((a, b) => {
    if (a.key !== b.key) return String(a.key) < String(b.key) ? -1 : 1;
    return a.span.start - b.span.start || a.span.end - b.span.end;
  });
  const chains = [];
  let current = null;
  for (const { note, span, key } of entries) {
    if (current !== null && current.key === key) {
      // Rounded to a microsecond, so a gap of exactly the threshold is not decided by floating point error.
      const gapMs = Math.round((span.start - current.end) * 1e6) / 1e3;
      const before = pitchOf(current.notes[current.notes.length - 1]);
      const after = pitchOf(note);
      const centsApart = before === null || after === null ? 0 : Math.round(Math.abs(after - before) * 1e5) / 1e3;
      if (gapMs < mergeGapMs && centsApart < mergeCents) {
        current.notes.push(note);
        current.end = Math.max(current.end, span.end);
        continue;
      }
    }
    current = { key, notes: [note], start: span.start, end: span.end };
    chains.push(current);
  }
  return chains;
}

/** Rounds down or up to four decimals, tolerating the error of a product such as 6.3 * 10000. */
const floor4 = (value) => Math.floor(value * 1e4 + 1e-6) / 1e4;
const ceil4 = (value) => Math.ceil(value * 1e4 - 1e-6) / 1e4;

const SETTING_REASONS = Object.freeze({
  thresholdMs:
    'a rhythm onset must be at least this far from the grid, after the singer’s overall lead or lag is removed, to get a suggestion; raise it to correct less',
  subdivision: '1 compares with the beats, 2 with eighth notes, 4 with sixteenth notes',
  mergeGapMs:
    'notes cut from one continuous voiced stretch (a glide that automatic note splitting broke into pieces) touch each other; a pause longer than this means the singer stopped, so the next note is a new onset',
  mergeCents:
    'the pieces of a glide stay within a few semitones of each other; a jump of this much or more is a new syllable on a new pitch even when the notes touch',
  minNoteMs:
    'a lone note shorter than this is a fragment (a consonant, a click, a splitting artifact), not an onset a listener hears, so it gets no suggestion; the start of a chain always does',
  maxOpsPerCall: 'the number of operations opentune_edit_timing takes in one call',
});

const BATCH_BASIS =
  'content.shiftTiming moves every handle whose output position lies in the range and leaves the others, so the audio ' +
  'between a moved handle and a handle that stays is stretched or compressed; a content range is mapped through the ' +
  'grid as it is at expectedGridRevision; a move is limited by the minimum spacing to the neighbouring handles ' +
  '(CLAMPED), and where handles lie is up to OpenTune. Every call changes the grid revision.';

const BETWEEN_BATCHES = Object.freeze([
  'Apply calls[0] only: it carries the expected_revision read with the notes. The later batches are previews of what is left; their expected_revision is null on purpose.',
  'After a batch the grid revision is new and the handles it moved have stretched the audio next to them, so the timeline position of the notes near those handles, and with it the delta of every later suggestion, is no longer what this plan measured; a move next to a neighbour may also have been limited (CLAMPED).',
  'Therefore do not send batch 2 from this plan. Read the notes again with opentune_get_notes and output_path (same clip, same range), run timing-plan again, and apply its calls[0]. Repeat until calls is empty or a round no longer lowers counts.flagged; two to four rounds is usual.',
  'Each operation is its own undo step; undoing a batch takes one opentune_undo per operation, newest first (the result lists the undo ids).',
]);

/**
 * Turns a grid and the notes of a vocal clip into opentune_edit_timing suggestions.
 *
 * The grid times are seconds from the start of the backing-track file; `gridOffsetSec` is where
 * that file starts on the OpenTune timeline (a clip's startTimelineSec minus its clipInContentSec).
 * The notes carry both clocks (opentune_get_notes with a placement id): startTimelineSec is used to
 * find the nearest beat, startContentSec to give opentune_edit_timing its range. The singer's
 * overall lead or lag is the median deviation and is removed before the threshold is applied.
 *
 * Automatic note splitting cuts one sung syllable into many touching fragments, and every fragment
 * start is not a rhythm onset. The notes are therefore merged into chains first (chainNotes); only
 * the start of a chain is compared with the grid, and the range of its op is the span of the whole
 * chain, so the handles inside it move together. A note shorter than `minNoteMs` that is not part
 * of a chain gets no suggestion.
 *
 * The suggestions are cut into batches of up to MAX_OPS_PER_CALL ops (`calls`). Only the first batch
 * can be applied from this plan: see BETWEEN_BATCHES.
 */
export function timingPlan({
  grid,
  notes,
  gridOffsetSec,
  thresholdMs = DEFAULT_THRESHOLD_MS,
  subdivision = 1,
  mergeGapMs = DEFAULT_MERGE_GAP_MS,
  mergeCents = DEFAULT_MERGE_CENTS,
  minNoteMs = DEFAULT_MIN_NOTE_MS,
} = {}) {
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
  for (const [name, value] of [
    ['--merge-gap-ms', mergeGapMs],
    ['--merge-cents', mergeCents],
    ['--min-note-ms', minNoteMs],
  ]) {
    if (!isFiniteNumber(value) || value < 0)
      throw new BeatGridError('USAGE', `${name} must be a number, 0 or more`, EXIT.USAGE);
  }

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
        'the notes file does not name the clip; use the file opentune_get_notes writes with output_path (it has ' +
        'placementId and clip_revision) to get ready-to-use calls',
    });
  if (parsedNotes.clipRevision === null)
    warnings.push({
      code: 'NO_REVISION',
      detail: parsedNotes.hasRevision
        ? 'the saved pages were read at different clip revisions; read the clip again before applying a call'
        : 'the notes file has no clip_revision; read the clip again with opentune_get_notes and output_path before applying a call',
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

  // Voiced notes with a content time are merged into chains; the start of a chain is the rhythm onset.
  const voiced = [];
  let skippedUnvoiced = 0;
  for (const note of parsedNotes.notes) {
    if (note.voiced === false) skippedUnvoiced += 1;
    else voiced.push(note);
  }
  const chainable = voiced.filter((note) => isFiniteNumber(note.startContentSec));
  const skippedWithoutContent = voiced.length - chainable.length;
  const chains = chainNotes(chainable, {
    mergeGapMs,
    mergeCents,
    keyOf: (note) => parsedNotes.clipOf.get(note) ?? null,
  });
  const onsets = [];
  let shortSkipped = 0;
  for (const [index, chain] of chains.entries()) {
    if (chain.notes.length < 2 && Math.round((chain.end - chain.start) * 1e6) / 1e3 < minNoteMs) {
      shortSkipped += 1;
      continue;
    }
    // The span of the op stops where the next chain starts, so two ops never share a handle.
    const next = chains[index + 1];
    const end =
      next !== undefined && next.key === chain.key ? Math.max(chain.start, Math.min(chain.end, next.start)) : chain.end;
    onsets.push({ chain, note: chain.notes[0], startContentSec: chain.start, endContentSec: end });
  }

  const considered = [];
  let skippedOutside = 0;
  let skippedWithoutTimeline = 0;
  let clockMismatch = 0;
  let placementOffset = null;

  for (const onset of onsets) {
    const { note } = onset;
    if (!isFiniteNumber(note.startTimelineSec)) {
      skippedWithoutTimeline += 1;
      continue;
    }
    if (note.startTimelineSec < first - 1e-6 || note.startTimelineSec > last + 1e-6) {
      skippedOutside += 1;
      continue;
    }
    const offset = note.startContentSec - note.startTimelineSec;
    if (placementOffset === null) placementOffset = offset;
    else if (Math.abs(offset - placementOffset) > 0.002) clockMismatch += 1;
    const point = nearestPoint(points, note.startTimelineSec);
    const segment = segmentAt(segments, point.timeSec);
    considered.push({ note, onset, point, segment });
  }
  if (skippedWithoutTimeline > 0 && considered.length === 0)
    throw new BeatGridError(
      'NOTES_WITHOUT_TIMELINE',
      'the notes have no startTimelineSec; call opentune_get_notes with the clip placement id (p:...) so each note ' +
        'carries both clocks, then run the plan on that file',
      EXIT.USAGE,
    );
  if (skippedOutside > 0)
    warnings.push({
      code: 'OUTSIDE_GRID',
      detail: `${String(skippedOutside)} onset(s) start before the first or after the last beat and were left out`,
    });
  if (skippedUnvoiced > 0)
    warnings.push({ code: 'UNVOICED_NOTES', detail: `${String(skippedUnvoiced)} unvoiced note(s) were left out` });
  if (skippedWithoutContent > 0)
    warnings.push({
      code: 'NOTES_WITHOUT_CONTENT',
      detail: `${String(skippedWithoutContent)} note(s) have no startContentSec and were left out`,
    });
  if (skippedWithoutTimeline > 0)
    warnings.push({
      code: 'NOTES_WITHOUT_TIMELINE',
      detail: `${String(skippedWithoutTimeline)} onset(s) have no timeline time and were left out`,
    });
  if (shortSkipped > 0)
    warnings.push({
      code: 'SHORT_NOTES',
      detail:
        `${String(shortSkipped)} note(s) shorter than ${String(minNoteMs)} ms that start no chain were left out ` +
        '(fragments, not onsets); lower --min-note-ms to include them',
    });
  if (clockMismatch > 0)
    warnings.push({
      code: 'CLOCK_MISMATCH',
      detail:
        `${String(clockMismatch)} onset(s) do not share the same content-to-timeline offset; the ranges use each ` +
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
  for (const { note, onset, point, segment } of considered) {
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
    // The range covers the whole chain (rounded outwards, so a handle at its edge stays inside).
    const start = floor4(onset.startContentSec);
    const end = Math.max(ceil4(onset.endContentSec), round(start + 0.001, 4));
    const op = { op: 'shift', start_content_sec: start, end_content_sec: end, delta_ms: deltaMs };
    const beat = beats[point.beatIndex];
    // opentune_edit_timing has no dry_run: this plan is the preview. A suggestion carries only its
    // op, never a ready call: `calls` below holds the batches, so an agent cannot read a call out of
    // every suggestion and issue one call per suggestion. A plan that cannot make a call (no single
    // clip and revision) carries no op either.
    suggestions.push({
      noteIndex: isFiniteNumber(note.index) ? note.index : null,
      chainLength: onset.chain.notes.length,
      noteStartContentSec: round(onset.startContentSec, 4),
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
      op: callable ? op : null,
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
      detail: 'no onset with both a timeline time inside the grid and a content time was found',
    });

  // Every batch is listed so that the size of the job is visible, but only the first can be applied:
  // see BETWEEN_BATCHES. The later ones carry no revision on purpose.
  const calls = [];
  if (callable && suggestions.length > 0) {
    const total = Math.ceil(suggestions.length / MAX_OPS_PER_CALL);
    for (let batch = 0; batch < total; batch++) {
      calls.push({
        batch: batch + 1,
        batches: total,
        ready: batch === 0,
        clip,
        expected_revision: batch === 0 ? parsedNotes.clipRevision : null,
        ops: suggestions
          .slice(batch * MAX_OPS_PER_CALL, (batch + 1) * MAX_OPS_PER_CALL)
          .map((suggestion) => suggestion.op),
      });
    }
  }
  const remainingSuggestions = callable ? Math.max(0, suggestions.length - MAX_OPS_PER_CALL) : 0;
  if (remainingSuggestions > 0)
    warnings.push({
      code: 'REPLAN_AFTER_CALL',
      detail:
        `${String(remainingSuggestions)} more suggestion(s) are in batches 2 to ${String(calls.length)}, listed as previews. ` +
        'Apply calls[0] only; after it, read the notes again with opentune_get_notes and output_path and run ' +
        'timing-plan again; do not send the later batches from this plan.',
    });

  const settings = {
    thresholdMs,
    subdivision,
    mergeGapMs,
    mergeCents,
    minNoteMs,
    maxOpsPerCall: MAX_OPS_PER_CALL,
    reasons: SETTING_REASONS,
  };
  return {
    schemaVersion: 1,
    tool: 'beat-grid',
    command: 'timing-plan',
    params: {
      gridOffsetSec,
      thresholdMs,
      subdivision,
      mergeGapMs,
      mergeCents,
      minNoteMs,
      model: grid.model?.name ?? null,
    },
    settings,
    conventions: {
      deviationMs: 'onset start minus the nearest grid point; positive means the onset is late',
      globalOffsetMs: 'median deviation removed before the threshold; positive means the singer is late overall',
      deltaMs: 'the shift to apply, the negative of the adjusted deviation; negative moves the onset earlier',
      onset: 'the start of a chain of touching notes, or a lone note of at least minNoteMs',
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
    merge: {
      voicedNotes: chainable.length,
      chains: chains.length,
      mergedAway: chainable.length - chains.length,
      onsets: onsets.length,
      shortNotesSkipped: shortSkipped,
    },
    globalOffsetMs: globalOffsetMs === null ? null : round(globalOffsetMs, 1),
    counts: { flagged: suggestions.length, calls: calls.length, remainingSuggestions },
    apply: {
      tool: 'opentune_edit_timing',
      maxOpsPerCall: MAX_OPS_PER_CALL,
      note:
        'opentune_edit_timing has no dry-run parameter: this plan is the preview. Each suggestion carries only its op, ' +
        'and null when no call can be made; calls holds the batches (at most maxOpsPerCall ops each, each op its own ' +
        'undo step). Apply calls[0] only, then plan again from fresh notes.',
      betweenBatches: BETWEEN_BATCHES,
      basis: BATCH_BASIS,
    },
    suggestions,
    calls,
    warnings,
  };
}

/** A plan without the list of suggestions: the counts, the settings, the batches and the ten largest shifts. */
export function summarizePlan(plan) {
  const { suggestions, ...rest } = plan;
  const worst = [...suggestions]
    .sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs))
    .slice(0, 10)
    .map(({ noteIndex, chainLength, noteStartTimelineSec, gridPoint, deviationMs, deltaMs, segment }) => ({
      noteIndex,
      chainLength,
      noteStartTimelineSec,
      gridPointTimelineSec: gridPoint.timelineSec,
      deviationMs,
      deltaMs,
      segmentIndex: segment === null ? null : segment.index,
    }));
  return { ...rest, suggestions: undefined, suggestionsOmitted: suggestions.length, largestShifts: worst };
}

// ---------------------------------------------------------------------------------------------
// align: does the vocal start together with the backing track?

const WAV_BLOCK_BYTES = 1 << 20;
const WAV_FORMAT_PCM = 1;
const WAV_FORMAT_FLOAT = 3;
const WAV_FORMAT_EXTENSIBLE = 0xfffe;
// Local maxima closer than this to the main peak are its own ripple, not a rival (50 ms).
const ALIGN_PEAK_EXCLUSION_FRAMES = 5;
const ALIGN_CONFIDENCE_CAP = 100;
// The level of an onset envelope is compared with its mean over this many frames either side (0.5 s).
const ALIGN_LOCAL_MEAN_FRAMES = 25;

function wavError(detail) {
  return new BeatGridError('WAV_UNSUPPORTED', detail, EXIT.USAGE);
}

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, read);
}

/**
 * The format of a RIFF/WAVE file and where its samples lie. Reads 16, 24 and 32 bit PCM, 32 and 64 bit
 * float, also in a WAVE_FORMAT_EXTENSIBLE header. A data chunk that claims no length, a streaming
 * placeholder or more than the file holds is read to the end of the file.
 */
export function readWavHeader(fd, size) {
  const head = readAt(fd, 0, 12);
  if (head.length < 12) throw wavError('the file is too short to be a WAV file');
  const magic = head.toString('latin1', 0, 4);
  if (magic === 'RF64' || magic === 'BW64')
    throw wavError('RF64 files (over 4 GiB) are not supported; export the audio as an ordinary WAV file');
  if (magic !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') throw wavError('the file is not a RIFF/WAVE file');
  let format = null;
  let position = 12;
  while (position + 8 <= size) {
    const chunk = readAt(fd, position, 8);
    if (chunk.length < 8) break;
    const id = chunk.toString('latin1', 0, 4);
    const chunkSize = chunk.readUInt32LE(4);
    const body = position + 8;
    if (id === 'fmt ') {
      if (chunkSize < 16) throw wavError('the fmt chunk of the file is too short');
      const fmt = readAt(fd, body, Math.min(chunkSize, 40));
      let tag = fmt.readUInt16LE(0);
      if (tag === WAV_FORMAT_EXTENSIBLE) {
        if (fmt.length < 26) throw wavError('the extensible fmt chunk of the file is too short');
        tag = fmt.readUInt16LE(24);
      }
      format = {
        tag,
        channels: fmt.readUInt16LE(2),
        sampleRate: fmt.readUInt32LE(4),
        bitsPerSample: fmt.readUInt16LE(14),
      };
    } else if (id === 'data') {
      if (format === null) throw wavError('the data chunk comes before the fmt chunk');
      const available = size - body;
      const dataBytes = chunkSize === 0 || chunkSize === 0xffffffff || chunkSize > available ? available : chunkSize;
      return { ...format, dataStart: body, dataBytes };
    }
    position = body + chunkSize + (chunkSize % 2);
  }
  throw wavError(format === null ? 'the file has no fmt chunk' : 'the file has no data chunk');
}

/** A function that reads sample `index` (a byte offset) of a buffer as a number from -1 to 1, or null. */
function sampleReader({ tag, bitsPerSample }) {
  if (tag === WAV_FORMAT_PCM) {
    if (bitsPerSample === 16) return (buffer, at) => buffer.readInt16LE(at) / 32768;
    if (bitsPerSample === 24) return (buffer, at) => buffer.readIntLE(at, 3) / 8388608;
    if (bitsPerSample === 32) return (buffer, at) => buffer.readInt32LE(at) / 2147483648;
  }
  if (tag === WAV_FORMAT_FLOAT) {
    if (bitsPerSample === 32) return (buffer, at) => buffer.readFloatLE(at);
    if (bitsPerSample === 64) return (buffer, at) => buffer.readDoubleLE(at);
  }
  return null;
}

/**
 * The mean square of each 10 ms frame (frameHz) of a WAV file, channels averaged, read in blocks so a
 * long file is never held in memory whole. A last frame that is not complete is dropped.
 */
export function frameEnergies(file, { frameHz = ALIGN_FRAME_HZ } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    throw new BeatGridError(
      'INPUT_UNREADABLE',
      `cannot open ${file}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.USAGE,
    );
  }
  try {
    const size = fs.fstatSync(fd).size;
    const header = readWavHeader(fd, size);
    const { channels, sampleRate, bitsPerSample } = header;
    const read = sampleReader(header);
    if (read === null || channels < 1 || sampleRate < 1000 || bitsPerSample % 8 !== 0)
      throw wavError(
        `unsupported WAV format (tag ${String(header.tag)}, ${String(bitsPerSample)} bit, ${String(channels)} channel(s), ` +
          `${String(sampleRate)} Hz); use 16, 24 or 32 bit PCM or 32 bit float`,
      );
    const bytesPerSample = bitsPerSample / 8;
    const frameBytes = bytesPerSample * channels;
    const totalFrames = Math.floor(header.dataBytes / frameBytes);
    if (totalFrames === 0) throw wavError('the file holds no samples');
    const framesPerBlock = Math.max(1, Math.floor(WAV_BLOCK_BYTES / frameBytes));
    const buffer = Buffer.alloc(framesPerBlock * frameBytes);
    const energies = [];
    let frame = 0;
    let boundary = Math.round(sampleRate / frameHz);
    let sampleNumber = 0;
    let sum = 0;
    let count = 0;
    for (let done = 0; done < totalFrames;) {
      const want = Math.min(framesPerBlock, totalFrames - done);
      const got = Math.floor(
        fs.readSync(fd, buffer, 0, want * frameBytes, header.dataStart + done * frameBytes) / frameBytes,
      );
      if (got === 0) break;
      for (let i = 0; i < got; i++) {
        let mono = 0;
        for (let channel = 0; channel < channels; channel++)
          mono += read(buffer, (i * channels + channel) * bytesPerSample);
        mono /= channels;
        sum += mono * mono;
        count += 1;
        sampleNumber += 1;
        if (sampleNumber >= boundary) {
          energies.push(sum / count);
          sum = 0;
          count = 0;
          frame += 1;
          boundary = Math.round(((frame + 1) * sampleRate) / frameHz);
        }
      }
      done += got;
    }
    return {
      energies,
      info: {
        sampleRate,
        channels,
        bitsPerSample,
        format: header.tag === WAV_FORMAT_FLOAT ? 'float' : 'pcm',
        seconds: round(totalFrames / sampleRate, 3),
      },
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * An onset envelope from frame energies: the rise of the level in dB-like units (log of the mean
 * square), kept where it exceeds its own local mean, then centred and scaled to unit length. Returns a
 * Float64Array; all zeros (norm 0) when the audio is silent.
 */
export function onsetEnvelope(energies) {
  const count = energies.length;
  const level = new Float64Array(count);
  for (let i = 0; i < count; i++) level[i] = Math.log1p(1e6 * energies[i]);
  const rise = new Float64Array(count);
  for (let i = 1; i < count; i++) rise[i] = Math.max(0, level[i] - level[i - 1]);
  const prefix = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) prefix[i + 1] = prefix[i] + rise[i];
  const envelope = new Float64Array(count);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const low = Math.max(0, i - ALIGN_LOCAL_MEAN_FRAMES);
    const high = Math.min(count, i + ALIGN_LOCAL_MEAN_FRAMES + 1);
    const mean = (prefix[high] - prefix[low]) / (high - low);
    envelope[i] = Math.max(0, rise[i] - mean);
    total += envelope[i];
  }
  const centre = count === 0 ? 0 : total / count;
  let norm = 0;
  for (let i = 0; i < count; i++) {
    envelope[i] -= centre;
    norm += envelope[i] * envelope[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < count; i++) envelope[i] /= norm;
  return envelope;
}

/**
 * The normalized cross-correlation r[k] of two envelopes for k from -maxLag to maxLag frames, as
 * sum over t of vocal[t] * backing[t - k]: the best k is positive when the vocal events come later.
 */
export function crossCorrelation(vocal, backing, maxLag) {
  const result = new Float64Array(2 * maxLag + 1);
  for (let k = -maxLag; k <= maxLag; k++) {
    const from = Math.max(0, k);
    const to = Math.min(vocal.length, backing.length + k);
    let sum = 0;
    for (let t = from; t < to; t++) sum += vocal[t] * backing[t - k];
    result[k + maxLag] = sum;
  }
  return result;
}

/**
 * Peak, interpolated lag and confidence of a correlation curve. Confidence is the peak divided by the
 * highest other local maximum (further than 50 ms from the peak), capped at 100; a curve with no
 * rival peak, or a rival that is not above zero, gets the cap.
 */
export function pickPeak(correlation, maxLag) {
  let peak = 0;
  for (let i = 1; i < correlation.length; i++) if (correlation[i] > correlation[peak]) peak = i;
  const value = correlation[peak];
  let rival = null;
  for (let i = 1; i < correlation.length - 1; i++) {
    if (Math.abs(i - peak) <= ALIGN_PEAK_EXCLUSION_FRAMES) continue;
    if (correlation[i] > correlation[i - 1] && correlation[i] >= correlation[i + 1]) {
      if (rival === null || correlation[i] > correlation[rival]) rival = i;
    }
  }
  let fraction = 0;
  if (peak > 0 && peak < correlation.length - 1) {
    const left = correlation[peak - 1];
    const right = correlation[peak + 1];
    const denominator = left - 2 * value + right;
    if (denominator < 0) fraction = (0.5 * (left - right)) / denominator;
  }
  const rivalValue = rival === null ? 0 : correlation[rival];
  const confidence = !(value > 0)
    ? 0
    : rivalValue <= 0
      ? ALIGN_CONFIDENCE_CAP
      : Math.min(ALIGN_CONFIDENCE_CAP, value / rivalValue);
  return {
    lagFrames: peak - maxLag + fraction,
    correlation: value,
    confidence,
    atLimit: peak === 0 || peak === correlation.length - 1,
    rival: rival === null ? null : { lagFrames: rival - maxLag, correlation: rivalValue },
  };
}

/**
 * Whether the events of a vocal file and a backing file line up, and by how much they are apart:
 * onset envelopes of both at ALIGN_FRAME_HZ, cross-correlated within +-maxLagSec.
 *
 * `lagSec` is positive when the vocal's events come later in its file than the same events in the
 * backing file. A beat at backing time b is then at vocal-file time b + lagSec, which is why
 * gridOffsetSec for a vocal clip is (its startTimelineSec - clipInContentSec) + lagSec.
 */
export function align({ vocal, backing, maxLagSec = ALIGN_MAX_LAG_SEC } = {}) {
  if (typeof vocal !== 'string' || vocal === '' || typeof backing !== 'string' || backing === '')
    throw new BeatGridError('USAGE', 'align needs --vocal <wav> and --backing <wav>', EXIT.USAGE);
  if (!isFiniteNumber(maxLagSec) || maxLagSec <= 0 || maxLagSec > 10)
    throw new BeatGridError('USAGE', '--max-lag-sec must be a number above 0 and at most 10', EXIT.USAGE);
  const vocalFrames = frameEnergies(vocal);
  const backingFrames = frameEnergies(backing);
  const warnings = [];
  const maxLag = Math.max(1, Math.round(maxLagSec * ALIGN_FRAME_HZ));
  const vocalEnvelope = onsetEnvelope(vocalFrames.energies);
  const backingEnvelope = onsetEnvelope(backingFrames.energies);
  const silent = (envelope) => envelope.every((value) => value === 0);
  if (silent(vocalEnvelope) || silent(backingEnvelope)) {
    warnings.push({
      code: 'NO_ONSETS',
      detail: `${silent(vocalEnvelope) ? 'the vocal' : 'the backing'} file has no level changes to compare (silence or a constant tone)`,
    });
  }
  const noOnsets = warnings.length > 0;
  const peak = noOnsets
    ? { lagFrames: 0, correlation: 0, confidence: 0, atLimit: false, rival: null }
    : pickPeak(crossCorrelation(vocalEnvelope, backingEnvelope, maxLag), maxLag);
  const lagSec = round(peak.lagFrames / ALIGN_FRAME_HZ, 4);
  const confident = peak.confidence >= ALIGN_MIN_CONFIDENCE;
  if (peak.atLimit)
    warnings.push({
      code: 'LAG_AT_LIMIT',
      detail: `the best match is at the edge of the search range (+-${String(maxLagSec)} s); the true offset may be larger`,
    });
  if (!noOnsets && !confident)
    warnings.push({
      code: 'LOW_CONFIDENCE',
      detail:
        `the best match is only ${String(round(peak.confidence, 2))} times better than the next best one (confident from ` +
        `${String(ALIGN_MIN_CONFIDENCE)}); a steady rhythm or a vocal that does not follow the backing's events makes several offsets look alike`,
    });
  return {
    schemaVersion: 1,
    tool: 'beat-grid',
    command: 'align',
    lagSec,
    confidence: round(peak.confidence, 2),
    confident,
    confidenceThreshold: ALIGN_MIN_CONFIDENCE,
    peakCorrelation: round(peak.correlation, 4),
    nextBest:
      peak.rival === null
        ? null
        : { lagSec: round(peak.rival.lagFrames / ALIGN_FRAME_HZ, 4), correlation: round(peak.rival.correlation, 4) },
    searched: { maxLagSec, frameHz: ALIGN_FRAME_HZ },
    conventions: {
      lagSec:
        'positive: the events of the vocal file come later than the same events of the backing file; negative: earlier',
      confidence:
        'the correlation at the best offset divided by the highest other peak (at least 50 ms away), capped at 100',
      gridOffsetSec:
        'for the timing plan: (startTimelineSec - clipInContentSec of the vocal clip) + lagSec, when the grid was analyzed from the backing file',
    },
    vocal: vocalFrames.info,
    backing: backingFrames.info,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// command line

function usageError(detail, command = null) {
  const usage = command !== null && COMMAND_HELP[command] !== undefined ? COMMAND_HELP[command] : USAGE;
  return new BeatGridError('USAGE', `${detail}\n\n${usage}`, EXIT.USAGE);
}

// Every command takes --home, so the skill can put it on each command line; commands that need no
// data folder accept it and ignore it.
const COMMAND_OPTIONS = Object.freeze({
  status: { home: 'value' },
  install: { model: 'value', yes: 'flag', home: 'value' },
  analyze: {
    model: 'value',
    out: 'value',
    force: 'flag',
    summary: 'flag',
    'no-refine': 'flag',
    'min-segment-beats': 'value',
    home: 'value',
  },
  'timing-plan': {
    grid: 'value',
    notes: 'value',
    'grid-offset-sec': 'value',
    'threshold-ms': 'value',
    subdivision: 'value',
    'merge-gap-ms': 'value',
    'merge-cents': 'value',
    'min-note-ms': 'value',
    summary: 'flag',
    home: 'value',
  },
  align: { vocal: 'value', backing: 'value', 'max-lag-sec': 'value', home: 'value' },
});

/**
 * Reads one command line into `{ command, options, positionals }`; usage errors throw. A help request
 * (`--help`, `-h`, `help`, `help <command>`, `<command> --help`) gives `{ command: 'help', topic }`,
 * where topic is the command to describe or null.
 */
export function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h')
    return { command: 'help', topic: null, options: {}, positionals: [] };
  if (argv[0] === 'help') {
    const topic = argv[1];
    if (topic !== undefined && COMMAND_OPTIONS[topic] === undefined)
      throw usageError(`unknown command ${JSON.stringify(topic)}`);
    return { command: 'help', topic: topic ?? null, options: {}, positionals: [] };
  }
  const [command, ...rest] = argv;
  const spec = COMMAND_OPTIONS[command];
  if (spec === undefined) throw usageError(`unknown command ${JSON.stringify(command)}`);
  if (rest.includes('--help') || rest.includes('-h'))
    return { command: 'help', topic: command, options: {}, positionals: [] };
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
    if (kind === undefined) throw usageError(`unknown option --${name} for ${command}`, command);
    if (kind === 'flag') {
      if (equals >= 0) throw usageError(`--${name} takes no value`, command);
      options[name] = true;
      continue;
    }
    const value = equals >= 0 ? token.slice(equals + 1) : rest[++i];
    // An empty --home is what a shell makes of an unset variable: it counts as not given.
    if (value === undefined || (value === '' && name !== 'home')) throw usageError(`--${name} needs a value`, command);
    options[name] = value;
  }
  const allowedPositionals = command === 'analyze' ? 1 : 0;
  if (positionals.length !== allowedPositionals)
    throw usageError(
      command === 'analyze'
        ? 'analyze takes exactly one WAV path'
        : `${command} takes no positional arguments (found ${positionals.length})`,
      command,
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

function parseIntegerOption(options, name, { min = 1, max = Number.POSITIVE_INFINITY } = {}) {
  const value = Number(options[name]);
  if (!Number.isInteger(value) || value < min || value > max)
    throw usageError(
      `--${name} must be an integer from ${String(min)} to ${String(max)} (found ${String(options[name])})`,
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
    manifest = null,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  // The manifest and the fetcher are injectable so a test can drive a whole command without
  // touching the shipped manifest file or the network. Both default to the real thing.
  const currentManifest = () => manifest ?? loadManifest();
  try {
    const parsed = parseArgs(argv);
    const homeOption = parsed.options.home ?? null;
    if (parsed.command === 'help') {
      out(parsed.topic === null ? USAGE : COMMAND_HELP[parsed.topic]);
      return EXIT.OK;
    }
    if (parsed.command === 'status') {
      writeJson(out, status({ manifest: currentManifest(), env, platform, arch, homeOption }));
      return EXIT.OK;
    }
    if (parsed.command === 'install') {
      const loadedManifest = currentManifest();
      const model = parsed.options.model ?? 'final';
      if (!MODELS.includes(model)) throw usageError(`--model must be final or small (found ${String(model)})`);
      const target = detectTarget(platform, arch);
      let home = null;
      try {
        home = dataHome(env, homeOption).home;
      } catch {
        home = null;
      }
      const plan = installPlan({ manifest: loadedManifest, target, model, home });
      if (parsed.options.yes !== true) {
        out(formatPlan(plan));
        return EXIT.OK;
      }
      if (plan.installed !== null) {
        // Nothing to download and nothing to replace, whatever the state of the release is.
        err('  already installed; nothing was downloaded or changed\n');
        writeJson(out, {
          schemaVersion: 1,
          ok: true,
          command: 'install',
          alreadyInstalled: true,
          dir: plan.installed.dir,
          executable: plan.installed.executable,
          version: plan.installed.version,
          model,
          models: plan.installed.models,
          replaced: false,
        });
        return EXIT.OK;
      }
      const resolved = dataHome(env, homeOption);
      if (plan.problems.length > 0)
        throw new BeatGridError('INSTALL_REFUSED', plan.problems.join('; '), EXIT.INSTALL_FAILED);
      const result = await install({
        manifest: loadedManifest,
        home: resolved.home,
        target,
        model,
        fetchImpl,
        log: (line) => err(`${line}\n`),
        ...(selfCheck === undefined ? {} : { selfCheck }),
      });
      writeJson(out, { schemaVersion: 1, ok: true, command: 'install', ...result });
      return EXIT.OK;
    }
    if (parsed.command === 'analyze') {
      const loadedManifest = currentManifest();
      const model = parsed.options.model ?? 'final';
      const outFile = parsed.options.out === undefined ? null : path.resolve(cwd, parsed.options.out);
      const minSegmentBeats =
        parsed.options['min-segment-beats'] === undefined
          ? null
          : parseIntegerOption(parsed.options, 'min-segment-beats', { min: 1 });
      const result = analyze({
        manifest: loadedManifest,
        home: dataHome(env, homeOption).home,
        target: detectTarget(platform, arch),
        input: parsed.positionals[0],
        model,
        out: outFile,
        force: parsed.options.force === true,
        refine: parsed.options['no-refine'] !== true,
        minSegmentBeats,
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
      const mergeGapMs = parseNumberOption(parsed.options, 'merge-gap-ms', { fallback: DEFAULT_MERGE_GAP_MS });
      const mergeCents = parseNumberOption(parsed.options, 'merge-cents', { fallback: DEFAULT_MERGE_CENTS });
      const minNoteMs = parseNumberOption(parsed.options, 'min-note-ms', { fallback: DEFAULT_MIN_NOTE_MS });
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
        mergeGapMs,
        mergeCents,
        minNoteMs,
      });
      writeJson(out, parsed.options.summary === true ? summarizePlan(plan) : plan);
      return EXIT.OK;
    }
    if (parsed.command === 'align') {
      if (parsed.options.vocal === undefined) throw usageError('align needs --vocal <wav>', 'align');
      if (parsed.options.backing === undefined) throw usageError('align needs --backing <wav>', 'align');
      const maxLagSec = parseNumberOption(parsed.options, 'max-lag-sec', {
        fallback: ALIGN_MAX_LAG_SEC,
        min: 0.01,
        max: 10,
      });
      writeJson(
        out,
        align({
          vocal: path.resolve(cwd, parsed.options.vocal),
          backing: path.resolve(cwd, parsed.options.backing),
          maxLagSec,
        }),
      );
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
