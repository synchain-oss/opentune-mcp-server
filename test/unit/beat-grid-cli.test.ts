// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The command line of the beat-grid skill: per-command help, the data folder (--home before the
// environment), the merge options and --summary of the timing plan, the notes file written by
// opentune_get_notes, and SKILL.md itself (every command it shows carries --home and parses, the
// thresholds it names are the ones the script uses). All data is synthetic.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { REPO } from '../support/plugin-tree.js';
import { backingTrack, irregularHits, vocalTrack, wavFile } from '../support/synthetic-audio.js';
import * as beatGridModule from '../../plugins/opentune/skills/beat-grid/scripts/beat-grid.mjs';

type Json = Record<string, unknown>;
interface BeatGridModule {
  DEFAULT_MERGE_CENTS: number;
  DEFAULT_MERGE_GAP_MS: number;
  DEFAULT_MIN_NOTE_MS: number;
  EXIT: { OK: number; USAGE: number };
  MAX_OPS_PER_CALL: number;
  main: (argv: string[], options?: Json) => Promise<number>;
  parseArgs: (argv: string[]) => { command: string; options: Record<string, unknown>; positionals: string[] };
}
const { DEFAULT_MERGE_CENTS, DEFAULT_MERGE_GAP_MS, DEFAULT_MIN_NOTE_MS, EXIT, MAX_OPS_PER_CALL, main, parseArgs } =
  beatGridModule as unknown as BeatGridModule;

const COMMANDS = ['status', 'install', 'analyze', 'timing-plan', 'align'];
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-beat-cli-'));
  cleanup.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function run(argv: string[], env: Record<string, string> = {}, extra: Json = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    env,
    out: (text: string) => (out += text),
    err: (text: string) => (err += text),
    ...extra,
  });
  let json: Json | null;
  try {
    json = JSON.parse(out) as Json;
  } catch {
    json = null;
  }
  return { code, out, err, json };
}

describe('help for each command', () => {
  it.each(COMMANDS)('%s --help prints its own usage and exits 0', async (command) => {
    const result = await run([command, '--help']);
    expect(result.code).toBe(EXIT.OK);
    expect(result.out.startsWith(`beat-grid ${command}`)).toBe(true);
    expect(result.err).toBe('');
    // The same text through `help <command>`, and `-h`.
    expect((await run(['help', command])).out).toBe(result.out);
    expect((await run([command, '-h'])).out).toBe(result.out);
    // Every command's usage names --home.
    expect(result.out).toContain('--home');
  });

  it('prints the usage of the other commands only for the one asked', async () => {
    const result = await run(['timing-plan', '--help']);
    expect(result.out).toContain('--merge-gap-ms');
    expect(result.out).toContain('--min-note-ms');
    expect(result.out).not.toContain('--vocal');
    const align = await run(['align', '--help']);
    expect(align.out).toContain('--vocal');
    expect(align.out).toContain('--backing');
    expect(align.out).not.toContain('--merge-gap-ms');
  });

  it('does not look at any other argument when help is asked for', async () => {
    // No WAV file, no folder, no grid: asking for help must not try to use them.
    for (const argv of [
      ['analyze', '--help'],
      ['analyze', 'C:/Music/none.wav', '--model', 'nope', '--help'],
      ['install', '--yes', '--help'],
      ['timing-plan', '--grid-offset-sec', 'x', '--help'],
    ]) {
      const result = await run(argv);
      expect(result.code, argv.join(' ')).toBe(EXIT.OK);
      expect(result.err).toBe('');
    }
  });

  it('prints the list of commands without a command, and refuses an unknown one with the usage error', async () => {
    const bare = await run([]);
    expect(bare.code).toBe(EXIT.OK);
    for (const command of COMMANDS) expect(bare.out).toContain(command);
    expect(bare.out).toContain('align');
    expect((await run(['--help'])).out).toBe(bare.out);
    expect((await run(['help'])).out).toBe(bare.out);

    const unknown = await run(['help', 'nope']);
    expect(unknown.code).toBe(EXIT.USAGE);
    expect(unknown.err).toContain('unknown command');
    expect((await run(['nope', '--help'])).code).toBe(EXIT.USAGE);
  });

  it('names the data folder priority in the general usage', async () => {
    const bare = await run([]);
    expect(bare.out).toMatch(/--home.*OPENTUNE_BEATS_HOME.*CLAUDE_PLUGIN_DATA/s);
  });
});

describe('--home and the environment', () => {
  const folderA = path.join(os.tmpdir(), 'ot-beat-home-a');
  const folderB = path.join(os.tmpdir(), 'ot-beat-home-b');
  const folderC = path.join(os.tmpdir(), 'ot-beat-home-c');

  it('takes --home before OPENTUNE_BEATS_HOME and CLAUDE_PLUGIN_DATA, and says which it used', async () => {
    const env = { OPENTUNE_BEATS_HOME: folderB, CLAUDE_PLUGIN_DATA: folderC };
    const fromOption = await run(['status', '--home', folderA], env);
    expect(fromOption.json).toMatchObject({ home: path.resolve(folderA), homeSource: '--home' });
    const fromEquals = await run(['status', `--home=${folderA}`], env);
    expect(fromEquals.json).toMatchObject({ home: path.resolve(folderA), homeSource: '--home' });
    const fromBeatsHome = await run(['status'], env);
    expect(fromBeatsHome.json).toMatchObject({ home: path.resolve(folderB), homeSource: 'OPENTUNE_BEATS_HOME' });
    const fromPluginData = await run(['status'], { CLAUDE_PLUGIN_DATA: folderC });
    expect(fromPluginData.json).toMatchObject({ home: path.resolve(folderC), homeSource: 'CLAUDE_PLUGIN_DATA' });
  });

  it('is accepted by every command', () => {
    expect(parseArgs(['status', '--home', 'x']).options).toEqual({ home: 'x' });
    expect(parseArgs(['install', '--model', 'small', '--home', 'x']).options).toEqual({ model: 'small', home: 'x' });
    expect(parseArgs(['analyze', 'a.wav', '--home', 'x']).options).toEqual({ home: 'x' });
    expect(
      parseArgs(['timing-plan', '--grid', 'g', '--notes', 'n', '--grid-offset-sec', '0', '--home', 'x']).options,
    ).toMatchObject({ home: 'x' });
    expect(parseArgs(['align', '--vocal', 'v.wav', '--backing', 'b.wav', '--home', 'x']).options).toMatchObject({
      home: 'x',
    });
  });

  it('treats an empty --home as not given', async () => {
    const result = await run(['status', '--home', ''], { OPENTUNE_BEATS_HOME: folderB });
    expect(result.json).toMatchObject({ home: path.resolve(folderB), homeSource: 'OPENTUNE_BEATS_HOME' });
    const none = await run(['status', '--home', '']);
    expect(none.json?.homeSource).toBeNull();
    expect(String(none.json?.homeError)).toContain('--home');
    expect(String(none.json?.homeError)).toContain('CLAUDE_PLUGIN_DATA');
  });

  it('ignores a variable that was not replaced, and says so', async () => {
    for (const value of ['${CLAUDE_PLUGIN_DATA}', '$CLAUDE_PLUGIN_DATA', '%CLAUDE_PLUGIN_DATA%']) {
      const result = await run(['status', '--home', value], { CLAUDE_PLUGIN_DATA: folderC });
      expect(result.json, value).toMatchObject({ home: path.resolve(folderC), homeSource: 'CLAUDE_PLUGIN_DATA' });
      expect((result.json?.notes as string[]).join(' '), value).toContain('not replaced');
    }
    const only = await run(['status', '--home', '${CLAUDE_PLUGIN_DATA}']);
    expect(only.json?.homeSource).toBeNull();
    expect(only.code).toBe(EXIT.OK);
  });

  it('uses --home for the install plan and refuses a real install without any folder', async () => {
    // The plan names its folder only for a platform the analyzer is published for (Windows x64 and macOS), so the
    // platform is fixed here; on Linux (the CI light job) the real one has no folder to name.
    const plan = await run(['install', '--model', 'final', '--home', folderA], {}, { platform: 'win32', arch: 'x64' });
    expect(plan.code).toBe(EXIT.OK);
    expect(plan.out).toContain(path.resolve(folderA).replace(/\\/g, '/').split('/').pop() ?? '');
    // The reason the test used to fail on Linux: no release for that platform, so the plan has no folder.
    const linux = await run(['install', '--model', 'final', '--home', folderA], {}, { platform: 'linux', arch: 'x64' });
    expect(linux.code).toBe(EXIT.OK);
    expect(linux.out).toContain('not supported here');
    expect(linux.out).not.toContain('ot-beat-home-a');
    const refused = await run(['install', '--model', 'final', '--yes'], {}, { platform: 'win32', arch: 'x64' });
    expect(refused.code).not.toBe(EXIT.OK);
    expect((refused.json?.error as Json).code).toBe('NO_HOME');
  });
});

describe('timing-plan on the command line', () => {
  /** A grid at 120 BPM and the notes file as opentune_get_notes writes it with output_path. */
  function files(notes: Json[], extra: Json = {}) {
    const dir = tempDir();
    const grid = path.join(dir, 'grid.json');
    const notesFile = path.join(dir, 'notes.json');
    fs.writeFileSync(
      grid,
      JSON.stringify({
        schemaVersion: 1,
        beats: Array.from({ length: 60 }, (_, index) => ({ index, timeSec: index * 0.5, segment: 0 })),
        segments: [{ index: 0, startSec: 0, endSec: 30, bpm: 120, confidence: 0.9 }],
        summary: { dominantBpm: 120 },
      }),
    );
    fs.writeFileSync(
      notesFile,
      JSON.stringify({
        placementId: 'p:1234abcd:1:1',
        contentId: 'c:1234abcd:1:1',
        clip_revision: 'r:1234abcd:1:1:abc',
        clock: 'content',
        notes,
        ...extra,
      }),
    );
    return { grid, notesFile };
  }
  const note = (index: number, startSec: number, lengthMs: number, midi: number): Json => ({
    index,
    startContentSec: startSec,
    endContentSec: startSec + lengthMs / 1000,
    startTimelineSec: startSec,
    endTimelineSec: startSec + lengthMs / 1000,
    detectedMidi: midi,
    targetMidi: midi,
    voiced: true,
  });
  /** Four syllables, each a glide of eight touching fragments; the second and fourth 120 ms late. */
  function song(): Json[] {
    const notes: Json[] = [];
    let index = 0;
    for (let k = 1; k <= 8; k++) {
      const onset = k * 0.5 + (k % 2 === 0 ? 0.12 : 0);
      for (let f = 0; f < 8; f++) notes.push(note(index++, onset + f * 0.017, 15, 60 + f * 0.2));
    }
    return notes;
  }
  const args = (f: { grid: string; notesFile: string }, ...more: string[]) => [
    'timing-plan',
    '--grid',
    f.grid,
    '--notes',
    f.notesFile,
    '--grid-offset-sec',
    '0',
    ...more,
  ];

  it('takes the grid and notes paths from --paths-file, and refuses a path given in both places', async () => {
    const f = files(song());
    const pathsFile = path.join(tempDir(), 'beat-paths.json');
    // One file can serve every command: the keys of the other commands are left alone.
    fs.writeFileSync(pathsFile, JSON.stringify({ grid: f.grid, notes: f.notesFile, vocal: 'v.wav', input: 'i.wav' }));
    const viaFile = await run(['timing-plan', '--paths-file', pathsFile, '--grid-offset-sec', '0']);
    expect(viaFile.code).toBe(EXIT.OK);
    expect(viaFile.json).toEqual((await run(args(f))).json);
    // The grid from the command line and the notes from the file is fine too.
    fs.writeFileSync(pathsFile, JSON.stringify({ notes: f.notesFile }));
    const mixed = await run(['timing-plan', '--grid', f.grid, '--paths-file', pathsFile, '--grid-offset-sec', '0']);
    expect(mixed.code).toBe(EXIT.OK);

    const twice = await run([...args(f), '--paths-file', pathsFile]);
    expect(twice.code).toBe(EXIT.USAGE);
    expect(twice.err).toContain('given twice');
    // Still needs both paths from somewhere.
    const missing = await run(['timing-plan', '--paths-file', pathsFile, '--grid-offset-sec', '0']);
    expect(missing.code).toBe(EXIT.USAGE);
    expect(missing.err).toContain('--grid');
  });

  it('refuses a paths file that is unreadable, not an object, has an unknown key or a value that is not a string', async () => {
    const f = files(song());
    const dir = tempDir();
    const write = (value: unknown) => {
      const file = path.join(dir, `p-${String(Math.random()).slice(2)}.json`);
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
      return file;
    };
    const cases: [string, string][] = [
      [path.join(dir, 'missing.json'), 'cannot read --paths-file'],
      [write('{not json'), 'cannot read --paths-file'],
      [write(['a']), 'must hold a JSON object'],
      [write({ grid: f.grid, notes: f.notesFile, notez: 'x' }), 'which no command takes'],
      [write({ grid: 5, notes: f.notesFile }), 'must be a non-empty string'],
      [write({ grid: '', notes: f.notesFile }), 'must be a non-empty string'],
    ];
    for (const [file, message] of cases) {
      const result = await run(['timing-plan', '--paths-file', file, '--grid-offset-sec', '0']);
      expect(result.code, message).toBe(EXIT.USAGE);
      expect(result.err, message).toContain(message);
    }
  });

  it('reads the file written by opentune_get_notes as it is', async () => {
    const result = await run(args(files(song())));
    expect(result.code).toBe(EXIT.OK);
    const plan = result.json as { notes: { clipRevision: string }; merge: Json; counts: { flagged: number } };
    expect(plan.notes.clipRevision).toBe('r:1234abcd:1:1:abc');
    expect(plan.merge).toMatchObject({ voicedNotes: 64, chains: 8, onsets: 8 });
    expect(plan.counts.flagged).toBeGreaterThan(0);
  });

  it('still reads several pages of results in one file', async () => {
    const notes = song();
    const f = files([]);
    const page = (list: Json[], cursor: string | null) => ({
      placementId: 'p:1234abcd:1:1',
      contentId: 'c:1234abcd:1:1',
      clip_revision: 'r:1234abcd:1:1:abc',
      notes: list,
      next_cursor: cursor,
    });
    fs.writeFileSync(f.notesFile, JSON.stringify([page(notes.slice(0, 32), 'x'), page(notes.slice(32), null)]));
    const result = await run(args(f));
    expect(result.code).toBe(EXIT.OK);
    expect((result.json as { merge: Json }).merge).toMatchObject({ voicedNotes: 64, chains: 8 });
  });

  it('takes the merge options and shows them in settings', async () => {
    const f = files(song());
    const loose = await run(args(f, '--merge-gap-ms', '0', '--merge-cents', '0', '--min-note-ms', '0'));
    expect((loose.json as { merge: Json }).merge).toMatchObject({ chains: 64, mergedAway: 0 });
    const settings = (loose.json as { settings: Json }).settings;
    expect(settings).toMatchObject({ mergeGapMs: 0, mergeCents: 0, minNoteMs: 0, maxOpsPerCall: MAX_OPS_PER_CALL });
    const wide = await run(args(f, '--merge-gap-ms', '45'));
    expect((wide.json as { settings: Json }).settings).toMatchObject({ mergeGapMs: 45 });
    const bad = await run(args(f, '--merge-gap-ms', 'soon'));
    expect(bad.code).toBe(EXIT.USAGE);
    expect(String((bad.json?.error as Json).detail)).toContain('merge-gap-ms');
  });

  it('prints a summary without the list of suggestions with --summary', async () => {
    const f = files(song());
    const full = (await run(args(f))).json as { suggestions: unknown[]; counts: Json; calls: unknown[] };
    const summary = (await run(args(f, '--summary'))).json ?? {};
    expect(summary).not.toHaveProperty('suggestions');
    expect(summary.suggestionsOmitted).toBe(full.suggestions.length);
    expect(summary.counts).toEqual(full.counts);
    expect(summary.calls).toEqual(full.calls);
    expect(summary.settings).toBeDefined();
    expect(Array.isArray(summary.largestShifts)).toBe(true);
  });

  it('says in the output what to do between batches', async () => {
    const plan = (await run(args(files(song())))).json as { apply: { betweenBatches: string[]; basis: string } };
    expect(plan.apply.betweenBatches.join(' ')).toMatch(/calls\[0\]/);
    expect(plan.apply.betweenBatches.join(' ')).toMatch(/plan again|re-plan/i);
    expect(plan.apply.basis.length).toBeGreaterThan(40);
  });
});

describe('SKILL.md', () => {
  const skillFile = path.join(REPO, 'plugins', 'opentune', 'skills', 'beat-grid', 'SKILL.md');
  const text = fs.readFileSync(skillFile, 'utf8').replace(/\r\n/g, '\n');
  const HOME = '--home "${CLAUDE_PLUGIN_DATA}"';

  /** Each place where the script is called, up to the closing backtick or the end of the line. */
  function commandLines(): string[] {
    const found: string[] = [];
    for (const line of text.split('\n')) {
      let from = line.indexOf('node "${CLAUDE_SKILL_DIR}/scripts/beat-grid.mjs"');
      while (from >= 0) {
        const tick = line.indexOf('`', from);
        found.push(line.slice(from, tick < 0 ? undefined : tick));
        from = line.indexOf('node "${CLAUDE_SKILL_DIR}/scripts/beat-grid.mjs"', from + 1);
      }
    }
    return found;
  }

  /** The arguments after the script name, split like a shell would (double quotes only). */
  function argvOf(command: string): string[] {
    const rest = command.replace('node "${CLAUDE_SKILL_DIR}/scripts/beat-grid.mjs"', '').trim();
    const tokens: string[] = [];
    for (const match of rest.matchAll(/"([^"]*)"|(\S+)/g)) tokens.push(match[1] ?? match[2] ?? '');
    return tokens;
  }

  // That the skill declares no allowed-tools (so the user is asked to approve its commands as usual) is checked for
  // every skill in skills.test.ts.

  it('gives --home on every command it shows', () => {
    const commands = commandLines();
    expect(commands.length).toBeGreaterThanOrEqual(7);
    for (const command of commands) expect(command, command).toContain(HOME);
    // And the commands are all there: status, install (plan and --yes), analyze, timing-plan, align.
    const names = commands.map((command) => argvOf(command)[0]);
    for (const name of ['status', 'install', 'analyze', 'timing-plan', 'align']) expect(names).toContain(name);
  });

  it('shows commands the script accepts', () => {
    const real = commandLines().filter((command) => COMMANDS.includes(argvOf(command)[0] ?? ''));
    expect(real.length).toBeGreaterThanOrEqual(5);
    for (const command of real) {
      const argv = argvOf(command).map((token) => (token === '${CLAUDE_PLUGIN_DATA}' ? os.tmpdir() : token));
      expect(() => parseArgs(argv), command).not.toThrow();
    }
  });

  it('reads the notes with output_path and no longer asks to page and join them', () => {
    expect(text).toContain('output_path');
    expect(text).toContain('opentune_get_notes');
    expect(text).not.toMatch(/next_cursor/);
    expect(text).not.toMatch(/concatenat/i);
    expect(text).not.toMatch(/page(s)? (and|then) (join|merge|concat)/i);
  });

  it('names the thresholds the script uses, with their reasons', () => {
    expect(text).toContain(`\`--merge-gap-ms\` (default **${String(DEFAULT_MERGE_GAP_MS)}**)`);
    expect(text).toContain(`\`--merge-cents\` (default **${String(DEFAULT_MERGE_CENTS)}**)`);
    expect(text).toContain(`\`--min-note-ms\` (default **${String(DEFAULT_MIN_NOTE_MS)}**)`);
    expect(text).toContain('settings');
    expect(text).toMatch(/glide/);
  });

  it('applies one batch of at most 64 operations and plans again before the next', () => {
    expect(MAX_OPS_PER_CALL).toBe(64);
    expect(text).toContain('up to 64 ops');
    expect(text).toMatch(/calls\[0\]/);
    expect(text).toMatch(/plan again/i);
    expect(text).not.toMatch(/at most 8|up to 8|eight ops/i);
  });

  it('checks the alignment with align and asks only when it is not confident', () => {
    expect(text).toContain('beat-grid.mjs" align --paths-file');
    expect(text).toContain('confident: true');
    expect(text).toMatch(/confident: false/);
    expect(text).toContain('gridOffsetSec');
  });

  it('takes the request itself as consent, says how to undo, and states the irreversible step first', () => {
    expect(text).toMatch(/asked in so many words/);
    expect(text).toMatch(/how to undo/);
    expect(text).toMatch(/cannot be undone/);
    expect(text).toMatch(/first sentence/);
    // The old rule asked before every edit_timing call.
    expect(text).not.toMatch(/waits? for the user/i);
  });

  it('tells where the data folder comes from', () => {
    expect(text).toMatch(/--home.*OPENTUNE_BEATS_HOME.*CLAUDE_PLUGIN_DATA/s);
    expect(text).toContain('homeSource');
    expect(text).toContain('--help');
  });

  it('runs status before install, and skips the install section when the analyzer is installed', () => {
    const names = commandLines().map((command) => argvOf(command)[0]);
    expect(names.indexOf('status')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('status')).toBeLessThan(names.indexOf('install'));
    const firstStatus = text.indexOf('beat-grid.mjs" status');
    const firstInstall = text.indexOf('beat-grid.mjs" install');
    expect(firstStatus).toBeGreaterThan(0);
    expect(firstStatus).toBeLessThan(firstInstall);
    // The step that comes first says to skip everything about installing when `status` says installed.
    const before = text.slice(0, firstInstall);
    expect(before).toMatch(/installed: true/);
    expect(before).toMatch(/Skip the rest of this section/);
    expect(before).toMatch(/do not run `install`/);
  });

  it('never puts a path that a tool returned inside a shell command', () => {
    // sourcePath (OpenTune) and output.path (opentune_get_notes) are data: in a double-quoted command, $(...),
    // backticks and $VAR in them would run or expand, so they go to the script in a --paths-file.
    for (const command of commandLines()) {
      const argv = argvOf(command);
      const name = argv[0] ?? '';
      expect(command, command).not.toMatch(/sourcePath|output\.path/);
      // No double-quoted placeholder either: whatever fills it would be filled into a shell string.
      expect(command, command).not.toMatch(/"<[^">]*>"/);
      if (name === 'align') {
        expect(argv, command).toContain('--paths-file');
        expect(argv, command).not.toContain('--vocal');
        expect(argv, command).not.toContain('--backing');
      }
      if (name === 'analyze') {
        expect(argv, command).toContain('--paths-file');
        expect(
          argv.slice(1).filter((token) => !token.startsWith('--') && /\.wav$/i.test(token)),
          command,
        ).toEqual([]);
      }
      if (name === 'timing-plan') {
        expect(argv, command).toContain('--paths-file');
        expect(argv, command).not.toContain('--notes');
      }
    }
    // The rule is stated once, with the reason and the way out for a path the user typed.
    expect(text).toMatch(/Keep paths out of the command line/);
    expect(text).toMatch(/file-writing tool/);
    expect(text).toMatch(/in single quotes/);
  });

  it('gives the grid offset of step 2 as a placeholder, and says not to guess it', () => {
    const plan = commandLines().find((command) => argvOf(command)[0] === 'timing-plan') ?? '';
    const argv = argvOf(plan);
    expect(argv[argv.indexOf('--grid-offset-sec') + 1]).toBe('<gridOffsetSec>');
    expect(text).toContain('never guess it');
  });

  it('says to undo from the newest step when there are many', () => {
    expect(text).toMatch(/undo from the\s+newest one/);
  });

  it('stops for a refused install only when nothing is installed, and does not call the published release unpublished', () => {
    // The shipped manifest marks the release as published, so the text must not tell the user otherwise.
    const { loadManifest } = beatGridModule as unknown as { loadManifest: () => Json };
    expect(loadManifest().released).toBe(true);
    expect(text).not.toMatch(/not published|unpublished/);
    const matches = [...text.matchAll(/plan or `--yes` refuses/g)];
    expect(matches).toHaveLength(1);
    for (const match of matches) {
      const around = text.slice(Math.max(0, match.index - 260), match.index + 460);
      expect(around, around).toMatch(/not installed|nothing is installed|installed: false/);
      expect(around, around).toMatch(/nothing was\s+installed/);
    }
    // A reader who knows the analyzer is installed is told the release state does not matter.
    expect(text).toMatch(/release state does not matter|whatever the release state is/);
  });
});

describe('an analyzer that is already installed', () => {
  const { loadManifest } = beatGridModule as unknown as { loadManifest: () => Json };
  const shipped = loadManifest();
  // The shipped manifest turned back into one for a release that is not published (released: false, no sha256).
  // The cases below are about that state: nothing may be downloaded, and an installed analyzer still works.
  const manifest = JSON.parse(JSON.stringify(shipped)) as Json & {
    platforms: Record<string, Json>;
    models: Record<string, Json>;
  };
  manifest.released = false;
  for (const entry of [...Object.values(manifest.platforms), ...Object.values(manifest.models)]) entry.sha256 = '';
  const version = String(manifest.version);
  const winDir = `opentune-beats-${version}-win-x64`;

  /** A home with an installation of the pinned version; `models` are the model files that exist. */
  function installedHome(models: string[] = ['mel_spectrogram.onnx', 'beat_this_final.onnx']): string {
    const home = tempDir();
    const dir = path.join(home, 'bin', winDir);
    fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'opentune-beats.exe'), 'program');
    for (const model of models) fs.writeFileSync(path.join(dir, 'models', model), model);
    fs.writeFileSync(path.join(dir, 'install.json'), JSON.stringify({ version, model: 'final' }));
    return home;
  }

  const listing = (folder: string): string[] =>
    fs
      .readdirSync(folder, { recursive: true, withFileTypes: true })
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort();

  async function onWindows(argv: string[], fetched: string[] = []) {
    let out = '';
    let err = '';
    const code = await main(argv, {
      env: {},
      manifest,
      platform: 'win32',
      arch: 'x64',
      out: (text: string) => (out += text),
      err: (text: string) => (err += text),
      fetchImpl: (url: string) => {
        fetched.push(url);
        throw new Error('nothing may be downloaded');
      },
    });
    let json: Json | null;
    try {
      json = JSON.parse(out) as Json;
    } catch {
      json = null;
    }
    return { code, out, err, json };
  }

  it('is built on a manifest that says the release is not published, so the cases below mean something', () => {
    expect(shipped.released).toBe(true);
    expect(manifest.released).toBe(false);
    expect(manifest.version).toBe(shipped.version);
  });

  it('says already installed in the plan, with no Problems, and exits 0', async () => {
    const home = installedHome();
    const plan = await onWindows(['install', '--model', 'final', '--home', home]);
    expect(plan.code).toBe(EXIT.OK);
    expect(plan.out).toContain('already installed');
    expect(plan.out).toContain(version);
    expect(plan.out).toContain(winDir);
    expect(plan.out).toContain('mel, final');
    expect(plan.out).not.toContain('Problems');
    expect(plan.out).not.toContain('not published');
    expect(plan.out).not.toContain('Nothing can be installed');
    expect(plan.out).not.toContain('Do not retry');
    expect(plan.out).not.toContain('Download');
  });

  it('install --yes reports it and downloads nothing', async () => {
    const home = installedHome();
    const before = listing(home);
    const fetched: string[] = [];
    const result = await onWindows(['install', '--model', 'final', '--yes', '--home', home], fetched);
    expect(result.code).toBe(EXIT.OK);
    expect(result.json).toMatchObject({
      ok: true,
      command: 'install',
      alreadyInstalled: true,
      version,
      model: 'final',
      replaced: false,
      models: { mel: true, final: true, small: false },
    });
    expect(result.err).toContain('already installed');
    expect(fetched).toEqual([]);
    // Nothing was written: no new folder, no temporary folder, no backup.
    expect(listing(home)).toEqual(before);
  });

  it('judges the model asked for: the small one is missing, so the plan is still blocked by the release', async () => {
    const home = installedHome();
    const small = await onWindows(['install', '--model', 'small', '--home', home]);
    expect(small.out).not.toContain('already installed');
    expect(small.out).toContain('Problems');
    expect(small.out).toContain('not published yet');
    const refused = await onWindows(['install', '--model', 'small', '--yes', '--home', home]);
    expect(refused.code).not.toBe(EXIT.OK);
    expect((refused.json?.error as Json).code).toBe('INSTALL_REFUSED');
    // With the small model there too, either request is already installed.
    const both = installedHome(['mel_spectrogram.onnx', 'beat_this_final.onnx', 'beat_this_small.onnx']);
    expect((await onWindows(['install', '--model', 'small', '--home', both])).out).toContain('already installed');
  });

  it('still blocks on an unpublished release when nothing is installed, and when the program or mel is missing', async () => {
    const empty = tempDir();
    const none = await onWindows(['install', '--model', 'final', '--home', empty]);
    expect(none.code).toBe(EXIT.OK);
    expect(none.out).not.toContain('already installed');
    expect(none.out).toContain('Problems');
    expect(none.out).toContain('not published yet');
    expect(none.out).toContain('Nothing can be installed');
    const refused = await onWindows(['install', '--model', 'final', '--yes', '--home', empty]);
    expect(refused.code).not.toBe(EXIT.OK);
    expect((refused.json?.error as Json).code).toBe('INSTALL_REFUSED');
    expect(fs.existsSync(path.join(empty, 'bin'))).toBe(false);

    // The models without the program, and the program without the mel model, are not an installation.
    const noProgram = installedHome();
    fs.rmSync(path.join(noProgram, 'bin', winDir, 'opentune-beats.exe'));
    expect((await onWindows(['install', '--home', noProgram])).out).toContain('Problems');
    const noMel = installedHome(['beat_this_final.onnx']);
    expect((await onWindows(['install', '--home', noMel])).out).toContain('Problems');
  });

  it('does not take an installation of another version for the one the skill needs', async () => {
    const home = installedHome();
    fs.renameSync(path.join(home, 'bin', winDir), path.join(home, 'bin', 'opentune-beats-9.9.9-win-x64'));
    const plan = await onWindows(['install', '--home', home]);
    expect(plan.out).not.toContain('already installed');
    expect(plan.out).toContain('Problems');
  });

  it('agrees with status: installed there is already installed here, and the release note is left out', async () => {
    const home = installedHome();
    const status = await onWindows(['status', '--home', home]);
    expect(status.json).toMatchObject({ installed: true, models: { mel: true, final: true, small: false } });
    expect((status.json?.notes as string[]).join(' ')).not.toContain('not published');

    const empty = tempDir();
    const unused = await onWindows(['status', '--home', empty]);
    expect(unused.json?.installed).toBe(false);
    expect((unused.json?.notes as string[]).join(' ')).toContain('not published yet');
    // A missing data folder keeps the note too: there is no installation to use.
    const nowhere = await onWindows(['status']);
    expect((nowhere.json?.notes as string[]).join(' ')).toContain('not published yet');
  });
});

describe('paths from --paths-file are used as they are', () => {
  // File names with the characters a shell would run or expand. The files exist; the script has to open
  // exactly these names, which it does only when no shell and no expansion is involved.
  const HOSTILE = ['vocal $(echo hi) `id` ${HOME}.wav', 'backing $(echo hi) `id` ${HOME}.wav'] as const;

  function hostileFiles(delay: number) {
    const dir = tempDir();
    const times = irregularHits(36);
    const vocal = path.join(dir, HOSTILE[0]);
    const backing = path.join(dir, HOSTILE[1]);
    fs.writeFileSync(vocal, wavFile([vocalTrack(times, delay, 8000, 24)], { rate: 8000, bits: 16 }));
    fs.writeFileSync(backing, wavFile([backingTrack(times, 8000, 24)], { rate: 8000, bits: 16 }));
    const pathsFile = path.join(dir, 'beat-paths.json');
    return { dir, vocal, backing, pathsFile };
  }

  it('align finds the offset of files whose names hold $(...), backticks and ${VAR}', async () => {
    const f = hostileFiles(0.37);
    fs.writeFileSync(f.pathsFile, JSON.stringify({ vocal: f.vocal, backing: f.backing }));
    const result = await run(['align', '--paths-file', f.pathsFile]);
    expect(result.code).toBe(EXIT.OK);
    expect(Math.abs(Number(result.json?.lagSec) - 0.37)).toBeLessThanOrEqual(0.015);
    // The same names on the command line are read the same way (no shell is involved in a test); the point of
    // the file is the real shell of the skill, which the text rules in SKILL.md keep away from them.
    const direct = await run(['align', '--vocal', f.vocal, '--backing', f.backing]);
    expect(direct.json?.lagSec).toBe(result.json?.lagSec);
    // A path in both places is refused, and so is a file without the second path.
    expect((await run(['align', '--vocal', f.vocal, '--paths-file', f.pathsFile])).err).toContain('given twice');
    fs.writeFileSync(f.pathsFile, JSON.stringify({ vocal: f.vocal }));
    const half = await run(['align', '--paths-file', f.pathsFile]);
    expect(half.code).toBe(EXIT.USAGE);
    expect(half.err).toContain('align needs --backing');
  });

  it('analyze gives the analyzer exactly the path of the file, with no positional path', async () => {
    const f = hostileFiles(0);
    const manifest = (beatGridModule as unknown as { loadManifest: () => Json }).loadManifest();
    const home = tempDir();
    const installDir = path.join(home, 'bin', `opentune-beats-${String(manifest.version)}-win-x64`);
    fs.mkdirSync(path.join(installDir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(installDir, 'opentune-beats.exe'), 'program');
    fs.writeFileSync(f.pathsFile, JSON.stringify({ input: f.vocal }));

    const calls: string[][] = [];
    const analyze = (argv: string[]) =>
      main(argv, {
        env: {},
        platform: 'win32',
        arch: 'x64',
        out: () => undefined,
        err: () => undefined,
        run: (_executable: string, args: string[]) => {
          calls.push(args);
          return { status: 0, stdout: '{}', stderr: '', error: null };
        },
      });
    await analyze(['analyze', '--paths-file', f.pathsFile, '--model', 'final', '--home', home]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('analyze');
    expect(calls[0]?.[1]).toBe(path.resolve(f.vocal));

    // The file has to name the input; a path on the command line as well is refused (parse error, nothing run).
    fs.writeFileSync(f.pathsFile, JSON.stringify({ vocal: f.vocal }));
    const noInput = await analyze(['analyze', '--paths-file', f.pathsFile, '--home', home]);
    expect(noInput).toBe(EXIT.USAGE);
    const both = await analyze(['analyze', f.vocal, '--paths-file', f.pathsFile, '--home', home]);
    expect(both).toBe(EXIT.USAGE);
    expect(calls).toHaveLength(1);
  });

  it('accepts --paths-file on analyze, align and timing-plan, and keeps one positional path otherwise', () => {
    expect(parseArgs(['analyze', '--paths-file', 'p.json']).options).toEqual({ 'paths-file': 'p.json' });
    expect(parseArgs(['align', '--paths-file', 'p.json']).options).toEqual({ 'paths-file': 'p.json' });
    expect(parseArgs(['timing-plan', '--paths-file', 'p.json']).options).toEqual({ 'paths-file': 'p.json' });
    expect(() => parseArgs(['analyze', 'a.wav', '--paths-file', 'p.json'])).toThrow(/exactly one WAV path/);
    expect(() => parseArgs(['analyze'])).toThrow(/exactly one WAV path/);
    expect(() => parseArgs(['status', '--paths-file', 'p.json'])).toThrow(/unknown option --paths-file/);
    expect(() => parseArgs(['install', '--paths-file', 'p.json'])).toThrow(/unknown option --paths-file/);
  });
});
