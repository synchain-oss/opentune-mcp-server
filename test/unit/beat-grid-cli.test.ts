// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The command line of the beat-grid skill: per-command help, the data folder (--home before the
// environment), the merge options and --summary of the timing plan, the notes file written by
// opentune_get_notes, and SKILL.md itself (every command it shows carries --home and parses, no
// allowed-tools, the thresholds it names are the ones the script uses). All data is synthetic.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { REPO } from '../support/plugin-tree.js';
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

async function run(argv: string[], env: Record<string, string> = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, { env, out: (text: string) => (out += text), err: (text: string) => (err += text) });
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
    const plan = await run(['install', '--model', 'final', '--home', folderA]);
    expect(plan.code).toBe(EXIT.OK);
    expect(plan.out).toContain(path.resolve(folderA).replace(/\\/g, '/').split('/').pop() ?? '');
    const refused = await run(['install', '--model', 'final', '--yes']);
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
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
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

  it('has no allowed-tools field, so the user is asked to approve the commands as usual', () => {
    expect(frontmatter).not.toBe('');
    expect(frontmatter).not.toMatch(/allowed-tools/i);
    expect(text.slice(0, text.indexOf('\n---\n', 4))).not.toMatch(/allowed-tools/i);
    // No other field that would approve a tool in advance either.
    const keys = [...frontmatter.matchAll(/^([A-Za-z][\w-]*):/gm)].map((match) => match[1]);
    expect(keys).toEqual(['name', 'description', 'license', 'compatibility', 'metadata']);
  });

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
    expect(text).toContain('beat-grid.mjs" align --vocal');
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
});
