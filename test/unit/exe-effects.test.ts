// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The effects scenario (test/e2e/effects.ts) against the stand-in executable
// (test/support/fake-opentune.mjs with test/support/fake-effects.mjs, `effects*` modes): every check
// passes against a stand-in that does what the specification says, and each way an instance can get
// the effects wrong (stale audio, a render that never settles, a mixed export, an undo that restores
// nothing) makes the check that is about it fail, and only that one. Two runs of the real test file in
// a child process show that it is skipped without OTCP_TARGET_EXE and runs the scenario with it.

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  PITCH_TOLERANCE_CENTS,
  compareSamples,
  consistencyOf,
  effectsSetupFromEnv,
  noteDelta,
  runEffects,
  scrubText,
  snapshotProblems,
  type EffectsConfig,
  type EffectsReport,
} from '../e2e/effects.js';
import { generateTone, writeToneFiles } from '../support/harmonic-tone.js';
import { decodeWav } from '../support/wav-decode.js';
import { wavFile } from '../support/wav-file.js';

const FAKE = fileURLToPath(new URL('../support/fake-opentune.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const SLOW = 120_000;

const config = (mode: string, extra: Partial<EffectsConfig> = {}): EffectsConfig => ({
  exe: { exe: process.execPath, args: [FAKE, `--mode=${mode}`], timeoutMs: 15_000 },
  stepTimeoutMs: 20_000,
  reportPath: undefined,
  audioPath: undefined,
  timingLengthsSec: [3],
  ...extra,
});

const results = (report: EffectsReport) => Object.fromEntries(report.steps.map((s) => [s.name, s.result]));
const noteOf = (report: EffectsReport, name: string) => report.steps.find((s) => s.name === name)?.note ?? '';

const scratch: string[] = [];
async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ot-effects-test-'));
  scratch.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('effects scenario against the stand-in', () => {
  it(
    'passes every check against an instance that does what the specification says',
    async () => {
      const report = await runEffects(config('effects'));
      expect(results(report)).toEqual({
        'prepare audio': 'PASS',
        launch: 'PASS',
        hello: 'PASS',
        'import and analysis': 'PASS',
        'export before any edit': 'PASS',
        'fixed note parameters': 'PASS',
        'baseline and noise floor': 'PASS',
        'setTargetPitch +100 cents': 'PASS',
        'shiftCents +100 cents': 'PASS',
        'setPitchShift +2 semitones': 'PASS',
        'AUTO regenerate pulls the sharp note back': 'PASS',
        'AUTO snapNotes pulls the sharp note back': 'PASS',
        'setParams retuneSpeed 1': 'PASS',
        'race: +100 cents, export, -100 cents': 'PASS',
        'shiftTiming +30 ms': 'PASS',
        'timing 3 s': 'PASS',
        shutdown: 'PASS',
      });
      expect(report).toMatchObject({ schema: 'opentune-mcp-e2e-effects/1', result: 'PASS' });
      expect(noteOf(report, 'export before any edit')).toContain('listed in dryContents');
      expect(noteOf(report, 'race: +100 cents, export, -100 cents')).toContain('BUSY(export_in_progress)');
      expect(report.backend).toEqual({
        sessionInfo: 'fake',
        exports: ['fake'],
        f0Model: 'fake',
        vocoderWeight: 'fake',
      });
      expect(report.audio).toMatchObject({ source: 'generated', notes: 5 });
      // The measurements: the edited note moved by the edit, the others did not move at all.
      const target = report.checks['setTargetPitch +100 cents'] as {
        notes: { index: number; medianCents: number; frames: number }[];
        unedited: { spans: number; bitIdentical: number };
      };
      expect(target.notes.find((n) => n.index === 1)?.medianCents).toBeCloseTo(100, 0);
      expect(target.notes.filter((n) => n.index !== 1).every((n) => n.medianCents === 0)).toBe(true);
      expect(target.notes.every((n) => n.frames >= 20)).toBe(true);
      expect(target.unedited).toMatchObject({ spans: 4, bitIdentical: 4 });
      const auto = report.checks['AUTO snapNotes pulls the sharp note back'] as {
        notes: { index: number; medianCents: number }[];
      };
      expect(auto.notes.find((n) => n.index === 2)?.medianCents).toBeCloseTo(-40, 0);
      const timing = report.checks['shiftTiming +30 ms'] as { measuredShiftMs: number };
      expect(Math.abs(timing.measuredShiftMs - 30)).toBeLessThan(2);
      expect(report.noiseFloor).toMatchObject({ repeatExport: { bitIdentical: true } });
      expect(report.timings).toMatchObject({ lengths: [{ autoMode: 'regenerate' }] });
      expect(report.tolerances.pitchCents).toBe(PITCH_TOLERANCE_CENTS);
      // Nothing in the report names a file or holds a secret.
      expect(JSON.stringify(report)).not.toMatch(/ot-tone-|\.wav|[0-9a-f]{32}[0-9a-f]{32}/);
    },
    SLOW,
  );

  it(
    'fails every effect check, and runs them all, when the export holds the notes as they were imported',
    async () => {
      const report = await runEffects(config('effects-stale', { timingLengthsSec: [] }));
      expect(report.result).toBe('FAIL');
      const r = results(report);
      for (const name of [
        'setTargetPitch +100 cents',
        'shiftCents +100 cents',
        'setPitchShift +2 semitones',
        'AUTO regenerate pulls the sharp note back',
        'AUTO snapNotes pulls the sharp note back',
        'race: +100 cents, export, -100 cents',
        'shiftTiming +30 ms',
      ]) {
        expect(r[name], name).toBe('FAIL');
      }
      expect(r['baseline and noise floor']).toBe('PASS');
      expect(noteOf(report, 'setTargetPitch +100 cents')).toMatch(/note 1: 0 cents, expected 100/);
      expect(r.shutdown).toBe('PASS');
    },
    SLOW,
  );

  it(
    'fails the export before any edit when the render of an uncorrected clip never settles, and goes on',
    async () => {
      const report = await runEffects(config('effects-unsettled', { timingLengthsSec: [] }));
      const r = results(report);
      expect(r['export before any edit']).toBe('FAIL');
      expect(noteOf(report, 'export before any edit')).toContain('export_wait_timeout');
      expect(r['setTargetPitch +100 cents']).toBe('PASS');
      expect(r['shiftTiming +30 ms']).toBe('PASS');
    },
    SLOW,
  );

  it(
    'fails the race when the export holds one note of each version; passes it on a changed_during_export conflict',
    async () => {
      const mixed = await runEffects(config('effects-mixed', { timingLengthsSec: [] }));
      expect(results(mixed)['race: +100 cents, export, -100 cents']).toBe('FAIL');
      expect(noteOf(mixed, 'race: +100 cents, export, -100 cents')).toContain('not one version: up, down');
      const conflict = await runEffects(config('effects-conflict', { timingLengthsSec: [] }));
      expect(results(conflict)['race: +100 cents, export, -100 cents']).toBe('PASS');
      expect(noteOf(conflict, 'race: +100 cents, export, -100 cents')).toContain(
        'REVISION_CONFLICT(changed_during_export), target untouched',
      );
    },
    SLOW,
  );

  it(
    'stops the checks when an undo does not put the clip back',
    async () => {
      const report = await runEffects(config('effects-undo-broken', { timingLengthsSec: [] }));
      const r = results(report);
      expect(r['setTargetPitch +100 cents']).toBe('FAIL');
      expect(noteOf(report, 'setTargetPitch +100 cents')).toContain('after edit.undo the clip is not as it was');
      expect(r['shiftCents +100 cents']).toBe('SKIP');
      expect(noteOf(report, 'shiftCents +100 cents')).toBe('not run: setTargetPitch +100 cents ended with FAIL');
      expect(r.shutdown).toBe('PASS');
    },
    SLOW,
  );

  it(
    'stops the checks when a write took effect but its result gives no undoId to take it back with',
    async () => {
      for (const [mode, why] of [
        ['effects-undo-missing', 'its result says it cannot be undone (ui_parity)'],
        ['effects-undo-garbled', 'its undo block has no undoId'],
      ] as const) {
        const report = await runEffects(config(mode, { timingLengthsSec: [] }));
        const r = results(report);
        expect(r['setTargetPitch +100 cents'], mode).toBe('FAIL');
        expect(noteOf(report, 'setTargetPitch +100 cents')).toBe(
          `content.editNotes took effect, but ${why}: the check cannot take it back, and the checks after it would run on a changed clip`,
        );
        // Not run on a clip that still holds the edit (which would fail them for the wrong reason).
        expect(r['shiftCents +100 cents'], mode).toBe('SKIP');
        expect(noteOf(report, 'race: +100 cents, export, -100 cents')).toBe(
          'not run: setTargetPitch +100 cents ended with FAIL',
        );
        expect(r.shutdown).toBe('PASS');
      }
    },
    SLOW,
  );

  it(
    'takes a write back when its result cannot be read after it took effect, and goes on',
    async () => {
      const report = await runEffects(config('effects-tokens-missing', { timingLengthsSec: [] }));
      const r = results(report);
      expect(r['setTargetPitch +100 cents']).toBe('FAIL');
      expect(noteOf(report, 'setTargetPitch +100 cents')).toBe('the result has no tokens');
      expect(report.checks['setTargetPitch +100 cents']).toMatchObject({ error: 'the result has no tokens' });
      // The undo was recorded before the result was read, so the clip is back as it was.
      expect(r['shiftCents +100 cents']).toBe('PASS');
      expect(r['race: +100 cents, export, -100 cents']).toBe('PASS');
      expect(r['shiftTiming +30 ms']).toBe('PASS');
    },
    SLOW,
  );

  it(
    'stops the checks when a write fails after it took effect and left the clip changed',
    async () => {
      const report = await runEffects(config('effects-reply-lost', { timingLengthsSec: [] }));
      const r = results(report);
      expect(r['setTargetPitch +100 cents']).toBe('FAIL');
      expect(noteOf(report, 'setTargetPitch +100 cents')).toMatch(
        /^INTERNAL\(fake_reply_lost\): fake; after edit\.undo the clip is not as it was: note 1 targetMidi: /,
      );
      expect(r['shiftCents +100 cents']).toBe('SKIP');
      expect(r.shutdown).toBe('PASS');
    },
    SLOW,
  );

  it(
    'checks the report of the second write of the race when it is applied',
    async () => {
      const report = await runEffects(config('effects-down-misreport', { timingLengthsSec: [] }));
      const name = 'race: +100 cents, export, -100 cents';
      expect(results(report)[name]).toBe('FAIL');
      expect(noteOf(report, name)).toBe(
        'second edit: note 0 offsetCents: the result says -99, read back -100; ' +
          'second edit: note 4 offsetCents: the result says -99, read back -100',
      );
      expect(report.checks[name]).toMatchObject({ secondEdit: 'applied' });
      expect(String((report.checks[name] as { outcome?: string }).outcome)).toContain('-100 cents version in full');
      expect(results(report)['shiftTiming +30 ms']).toBe('PASS');
    },
    SLOW,
  );

  it(
    'counts the reported fields it does not read back instead of failing on them',
    async () => {
      const report = await runEffects(config('effects-extra-fields', { timingLengthsSec: [] }));
      expect(report.result).toBe('PASS');
      expect(noteOf(report, 'setTargetPitch +100 cents')).toMatch(
        /; 1 reported field\(s\) not compared, as the scenario does not read them$/,
      );
      expect(noteOf(report, 'fixed note parameters')).toContain('1 reported field(s) not compared');
      expect(report.checks['setTargetPitch +100 cents']).toMatchObject({ unreadFields: ['note.futureField'] });
      expect(report.checks['race: +100 cents, export, -100 cents']).toMatchObject({
        unreadFields: ['note.futureField'],
      });
      // Results that report no such field have none in the report.
      expect(report.checks['setPitchShift +2 semitones']).not.toHaveProperty('unreadFields');
    },
    SLOW,
  );

  it(
    'is a FLAKY-SKIP when the backend cannot start, and SKIPs without history.v1 or the timing check without timing.v1',
    async () => {
      const backend = await runEffects(config('effects-backend', { timingLengthsSec: [] }));
      expect(backend.result).toBe('FLAKY-SKIP');
      expect(results(backend)['import and analysis']).toBe('FLAKY-SKIP');
      const history = await runEffects(config('effects-no-history', { timingLengthsSec: [] }));
      expect(results(history).hello).toBe('SKIP');
      expect(noteOf(history, 'hello')).toContain('history.v1');
      const timing = await runEffects(config('effects-no-timing', { timingLengthsSec: [] }));
      expect(timing.result).toBe('SKIP');
      expect(results(timing)['shiftTiming +30 ms']).toBe('SKIP');
      expect(results(timing)['race: +100 cents, export, -100 cents']).toBe('PASS');
    },
    SLOW,
  );

  it(
    'runs the checks that need no known pitch on external audio, and names no file',
    async () => {
      const tone = generateTone({
        seed: 5,
        notes: [
          { midi: 55, durationSec: 0.9, gapSec: 0.4 },
          { midi: 58, durationSec: 1.1, gapSec: 0.4 },
          { midi: 60, durationSec: 0.3, gapSec: 0.4 },
        ],
      });
      const files = await writeToneFiles(tone, 'external-take');
      try {
        const report = await runEffects(config('effects', { audioPath: files.wavPath, timingLengthsSec: [] }));
        const r = results(report);
        expect(r['AUTO regenerate pulls the sharp note back']).toBe('SKIP');
        expect(noteOf(report, 'AUTO snapNotes pulls the sharp note back')).toContain('external audio');
        expect(r['setTargetPitch +100 cents']).toBe('PASS');
        expect(r['race: +100 cents, export, -100 cents']).toBe('PASS');
        expect(report.audio).toMatchObject({ source: 'external' });
        expect(report.noiseFloor).not.toHaveProperty('estimatorOnSource');
        expect(JSON.stringify(report)).not.toContain('external-take');
      } finally {
        await files.cleanup();
      }
    },
    SLOW,
  );
});

describe('effects measurements', () => {
  const tone = (cents: number) =>
    decodeWav(generateTone({ seed: 9, notes: [{ midi: 60, cents, durationSec: 1 }], leadSec: 0.2 }).wav);
  const span = { index: 0, startSec: 0.2, endSec: 1.2, hz: 261.63 };

  it('measures the pitch difference of a note between two files to within the estimator bound', () => {
    const delta = noteDelta(tone(0), tone(100), span, 100);
    expect(delta.medianCents).not.toBeNull();
    expect(Math.abs((delta.medianCents ?? 0) - 100)).toBeLessThan(2);
    expect(delta.frames).toBeGreaterThan(50);
    // A span with no audio has too few voiced frames to be measured.
    expect(noteDelta(tone(0), tone(0), { ...span, startSec: 1.25, endSec: 1.3 }, 0).medianCents).toBeNull();
  });

  it('decodes the samples of PCM and float WAV files, every channel, and refuses what it cannot read', () => {
    const pcm = decodeWav(wavFile({ seconds: 0.1, rate: 8000, channels: 2 }));
    expect(pcm).toMatchObject({ sampleRateHz: 8000, bits: 16, float: false });
    expect(pcm.channels).toHaveLength(2);
    expect(pcm.mono).toHaveLength(800);
    expect(pcm.channels[0]?.[10]).toBe(pcm.channels[1]?.[10]);
    for (const bits of [8, 24, 32] as const) {
      const wav = decodeWav(wavFile({ seconds: 0.05, rate: 8000, bits }));
      expect(Math.max(...wav.mono.map(Math.abs))).toBeGreaterThan(0.29);
    }
    expect(decodeWav(wavFile({ seconds: 0.05, bits: 32, float: true, extensible: true, extraChunk: true })).float).toBe(
      true,
    );
    expect(() => decodeWav(Buffer.from('not a wav file'))).toThrow(/RIFF/);
    expect(() => decodeWav(wavFile({ seconds: 0.05, noData: true }))).toThrow(/no fmt or data/);
    expect(() => decodeWav(wavFile({ seconds: 0.05, formatTag: 2 }))).toThrow(/format tag 2/);
    expect(() => decodeWav(wavFile({ seconds: 0.05, bits: 16, float: true }))).toThrow(/layout/);
  });

  it('scrubs the audio file, the export folder and user folders from report text', () => {
    const audioPath = path.join(os.tmpdir(), 'takes', 'vocal take.wav');
    const workDir = path.join(os.tmpdir(), 'ot-tone-abc');
    const scrubbed = scrubText(
      `NOT_FOUND: ${audioPath} (vocal take.wav); wrote ${path.join(workDir, 'x.wav')}; ` +
        'C:\\Users\\username\\Music\\a.wav /home/username/b.wav /Users/username/c.wav',
      { audioPath, workDir },
    );
    expect(scrubbed).toBe(
      `NOT_FOUND: <audio> (<audio>); wrote ${path.join('<tmp>', 'x.wav')}; <home>\\Music\\a.wav <home>/b.wav <home>/c.wav`,
    );
    expect(scrubText('nothing to hide', {})).toBe('nothing to hide');
    expect(scrubText('a'.repeat(64), { audioPath: undefined, workDir: '' })).toBe('[redacted]');
  });

  it('compares samples: identical, different, and of different lengths', () => {
    const a = tone(0);
    expect(compareSamples(a, a, [{ startSec: 0, endSec: 1 }])).toMatchObject({
      bitIdentical: 1,
      maxAbsDiff: 0,
      maxAbsDiffDbfs: null,
    });
    const b = tone(1);
    const diff = compareSamples(a, b, [{ startSec: 0.3, endSec: 1 }]);
    expect(diff.bitIdentical).toBe(0);
    expect(diff.maxAbsDiff).toBeGreaterThan(0);
    expect(diff.maxAbsDiffDbfs).toBeLessThan(0);
    const short = decodeWav(generateTone({ seed: 9, notes: [{ midi: 60, durationSec: 0.2 }], leadSec: 0 }).wav);
    expect(compareSamples(short, a, [{ startSec: 0, endSec: 2 }]).bitIdentical).toBe(0);
  });

  const state = {
    tokens: { arrangementRevision: 'a1', revision: 'r2', gridRevision: 'g1', keyRevision: 'k1' },
    notesRevision: 'r2',
    tuningHz: 440,
    notes: [
      {
        index: 0,
        startContentSec: 0.2,
        endContentSec: 1.2,
        detectedMidi: 60,
        targetMidi: 61,
        offsetCents: 0,
        retuneSpeed: 1,
        vibratoDepth: 0,
        vibratoRateHz: 7.5,
        pitchDriftScale: 1,
        voiced: true,
        corrected: true,
      },
    ],
    pitchShift: { semitones: 0, cents: 0 },
    handles: [{ handleId: '2', contentSec: 0.2, outputSec: 0.23 }],
    seeded: true,
  };
  const result = (overrides: Record<string, unknown> = {}) => ({
    tokens: {
      arrangementRevision: 'a1',
      contents: [{ contentId: 'c:1', revision: 'r2', gridRevision: 'g1', keyRevision: 'k1' }],
    },
    changes: [
      {
        entity: 'note',
        ref: { contentId: 'c:1', note: { index: 0, atRevision: 'r2' } },
        fields: { targetMidi: { before: 60, after: 61, unit: 'midi' } },
      },
      { entity: 'pitchShift', ref: { contentId: 'c:1' }, fields: { semitones: { before: 2, after: 0 } } },
      {
        entity: 'timeHandle',
        ref: { contentId: 'c:1', handleId: '2' },
        fields: { outputSec: { before: 0.2, after: 0.23 } },
      },
      { entity: 'content', ref: { contentId: 'c:1' }, fields: { revision: { before: 'r1', after: 'r2' } } },
      { entity: 'key', ref: { contentId: 'c:1' }, fields: { root: { before: 0, after: 2 } } },
    ],
    ...overrides,
  });

  const problemsOf = (r: Record<string, unknown>) => consistencyOf(r, state, 'c:1').problems;

  it('finds every disagreement between a result and the state read back', () => {
    expect(consistencyOf(result(), state, 'c:1')).toEqual({ problems: [], unreadFields: ['key.root'] });
    const wrong = problemsOf(
      result({
        tokens: {
          arrangementRevision: 'a0',
          contents: [{ contentId: 'c:1', revision: 'r9', gridRevision: 'g1', keyRevision: 'k1' }],
        },
        changes: [
          {
            entity: 'note',
            ref: { contentId: 'c:1', note: { index: 0, atRevision: 'r1' } },
            fields: { targetMidi: { before: 60, after: 61.5 } },
          },
          { entity: 'note', ref: { contentId: 'c:1', note: { index: 4, atRevision: 'r2' } }, fields: {} },
          { entity: 'timeHandle', ref: { contentId: 'c:1', handleId: '9' }, fields: { outputSec: { after: 1 } } },
          { entity: 'pitchShift', ref: { contentId: 'c:1' }, fields: { semitones: { before: 0, after: 2 } } },
        ],
      }),
    );
    expect(wrong).toEqual([
      'tokens.arrangementRevision is not the one read afterwards',
      'tokens.revision is not the one read afterwards',
      'note 0 is referenced at another revision than the one read afterwards',
      'note 0 targetMidi: the result says 61.5, read back 61',
      'note 4 of the changes is not there afterwards',
      'handle 9 of the changes is not there afterwards',
      'pitch shift semitones: the result says 2, read back 0',
    ]);
    expect(problemsOf(result({ tokens: { arrangementRevision: 'a1', contents: [] } }))).toEqual([
      'tokens has no entry for the clip',
    ]);
    expect(consistencyOf(result({ changes: null }), state, 'c:1')).toEqual({
      problems: ['changes is not an array'],
      unreadFields: [],
    });
  });

  it('compares only the fields it reads back, and lists the others without calling them a problem', () => {
    const extra = consistencyOf(
      result({
        changes: [
          {
            entity: 'note',
            ref: { contentId: 'c:1', note: { index: 0, atRevision: 'r2' } },
            // label is a note field the scenario does not parse; futureField one a later minor may add.
            fields: {
              targetMidi: { before: 60, after: 61 },
              label: { before: null, after: 'verse' },
              futureField: { before: 0, after: 1 },
            },
          },
          {
            entity: 'pitchShift',
            ref: { contentId: 'c:1' },
            fields: { cents: { before: 5, after: 0 }, formant: { before: 0, after: 1 } },
          },
          {
            entity: 'timeHandle',
            ref: { contentId: 'c:1', handleId: '2' },
            fields: { contentSec: { before: 0.1, after: 0.2 }, outputSec: { before: 0.2, after: 0.23 } },
          },
          { entity: 'note', ref: { contentId: 'c:1', note: { index: 0, atRevision: 'r2' } }, fields: { label: {} } },
        ],
      }),
      state,
      'c:1',
    );
    expect(extra).toEqual({ problems: [], unreadFields: ['note.futureField', 'note.label', 'pitchShift.formant'] });
    // A field it does read is still compared next to an unread one.
    expect(
      problemsOf(
        result({
          changes: [
            {
              entity: 'note',
              ref: { contentId: 'c:1', note: { index: 0, atRevision: 'r2' } },
              fields: { futureField: { after: 1 }, offsetCents: { before: 0, after: 100 } },
            },
            {
              entity: 'timeHandle',
              ref: { contentId: 'c:1', handleId: '2' },
              fields: { contentSec: { before: 0.2, after: 0.25 } },
            },
          ],
        }),
      ),
    ).toEqual([
      'note 0 offsetCents: the result says 100, read back 0',
      'handle 2 contentSec: the result says 0.25, read back 0.2',
    ]);
  });

  it('finds every difference between the snapshot before a write and the state after the undo', () => {
    expect(snapshotProblems(state, state)).toEqual([]);
    const moved = {
      ...state,
      notes: [
        { ...state.notes[0], targetMidi: 62 },
        { ...state.notes[0], index: 1 },
      ],
      pitchShift: { semitones: 1, cents: 0 },
      handles: [],
    } as typeof state;
    expect(snapshotProblems(state, moved)).toEqual([
      '2 notes after the undo, 1 before the write',
      'note 0 targetMidi: 61 before the write, 62 after the undo',
      'the pitch shift after the undo is not the one before the write',
      'the time-grid handles after the undo are not those before the write',
    ]);
  });
});

describe('effects configuration', () => {
  const exe = { OTCP_TARGET_EXE: process.execPath };
  it('reads the environment: report path, external audio and the timing lengths', async () => {
    expect(effectsSetupFromEnv({})).toEqual({ skip: 'OTCP_TARGET_EXE is not set' });
    const base = path.join(os.tmpdir(), 'reports');
    expect(effectsSetupFromEnv(exe)).toMatchObject({
      config: { reportPath: undefined, audioPath: undefined, timingLengthsSec: [60, 240], stepTimeoutMs: 180_000 },
    });
    expect(effectsSetupFromEnv({ ...exe, OTCP_E2E_REPORT: path.join(base, 'smoke.json') })).toMatchObject({
      config: { reportPath: path.join(base, 'effects.json') },
    });
    expect(
      effectsSetupFromEnv({
        ...exe,
        OTCP_E2E_REPORT: path.join(base, 'smoke.json'),
        OTCP_E2E_EFFECTS_REPORT: path.join(base, 'mine.json'),
        OTCP_E2E_EFFECTS_TIMING_SEC: '5, 10',
        OTCP_E2E_STEP_TIMEOUT_MS: '1000',
      }),
    ).toMatchObject({
      config: { reportPath: path.join(base, 'mine.json'), timingLengthsSec: [5, 10], stepTimeoutMs: 1000 },
    });
    expect(effectsSetupFromEnv({ ...exe, OTCP_E2E_EFFECTS_TIMING_SEC: 'none' })).toMatchObject({
      config: { timingLengthsSec: [] },
    });
    const dir = await tmp();
    const files = await writeToneFiles(generateTone({ seed: 1, notes: [{ midi: 60, durationSec: 0.2 }] }), 'take');
    scratch.push(files.dir);
    expect(effectsSetupFromEnv({ ...exe, OTCP_E2E_EFFECTS_AUDIO: files.wavPath })).toMatchObject({
      config: { audioPath: files.wavPath },
    });
    const bad: Record<string, string>[] = [
      { OTCP_E2E_EFFECTS_REPORT: 'relative.json' },
      { OTCP_E2E_REPORT: 'relative.json' },
      { OTCP_E2E_EFFECTS_AUDIO: 'take.wav' },
      { OTCP_E2E_EFFECTS_AUDIO: path.join(dir, 'missing.wav') },
      { OTCP_E2E_EFFECTS_AUDIO: files.truthPath },
      { OTCP_E2E_EFFECTS_TIMING_SEC: '1' },
      { OTCP_E2E_EFFECTS_TIMING_SEC: '60,x' },
      { OTCP_E2E_STEP_TIMEOUT_MS: '-1' },
    ];
    for (const env of bad) expect(() => effectsSetupFromEnv({ ...exe, ...env }), JSON.stringify(env)).toThrow();
  });
});

/** Runs the real test file of the scenario in a child process, with only the variables given. */
function runTestFile(env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OTCP_')));
  return spawnSync(
    process.execPath,
    [VITEST, 'run', '--project', 'e2e', '--reporter=verbose', 'test/e2e/exe-effects.test.ts'],
    { cwd: ROOT, env: { ...clean, ...env }, encoding: 'utf8', timeout: 110_000 },
  );
}

describe('the effects scenario as a test file', () => {
  it(
    'is skipped as a whole, with its reason, when OTCP_TARGET_EXE is not set',
    () => {
      const run = runTestFile({});
      const output = `${run.stdout}\n${run.stderr}`;
      expect(run.status).toBe(0);
      expect(output).toContain('exe effects not run: OTCP_TARGET_EXE is not set');
      expect(output).toMatch(/1 skipped/);
      expect(output).not.toMatch(/passed/);
    },
    SLOW,
  );

  it(
    'runs the scenario and writes effects.json next to the smoke report when OTCP_TARGET_EXE is set',
    async () => {
      const dir = await tmp();
      const run = runTestFile({
        OTCP_TARGET_EXE: process.execPath,
        OTCP_TARGET_ARGS: JSON.stringify([FAKE, '--mode=effects']),
        OTCP_E2E_REPORT: path.join(dir, 'report.json'),
        OTCP_E2E_STEP_TIMEOUT_MS: '20000',
        OTCP_E2E_EFFECTS_TIMING_SEC: 'none',
      });
      const output = `${run.stdout}\n${run.stderr}`;
      expect(run.status, output).toBe(0);
      expect(output).toMatch(/\| shiftTiming \+30 ms \| PASS \|/);
      const written = JSON.parse(await readFile(path.join(dir, 'effects.json'), 'utf8')) as EffectsReport;
      expect(written).toMatchObject({ schema: 'opentune-mcp-e2e-effects/1', result: 'PASS' });
    },
    SLOW,
  );
});
