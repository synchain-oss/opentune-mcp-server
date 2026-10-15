// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Read-path smoke test for targets that analyse pitch: imports generated audio of known pitch and
// checks what content.getNotes and content.getPitchCurve report against the ground truth. The mock
// does no pitch analysis, so against it the test is reported as skipped; a target for a running
// OpenTune is added to `targets` below and the same test then runs unchanged.

import { describe, expect, it } from 'vitest';

import { generateTone, writeToneFiles } from '../support/harmonic-tone.js';
import { RunnerConnection } from './connection.js';
import { mockTarget } from './mock-target.js';
import type { ContractTarget, TargetInstance } from './target.js';

interface PitchTarget {
  readonly target: ContractTarget;
  /** Why the target cannot take part; undefined when it analyses pitch. */
  readonly skipReason: string | undefined;
}

const targets: readonly PitchTarget[] = [
  { target: mockTarget(), skipReason: 'the mock does not analyse pitch' },
  // A running OpenTune: { target: <target that reads the discovery directory>, skipReason: undefined }
];

const TIMEOUT_MS = 60_000;
const NOTE_TOLERANCE_CENTS = 15;

type Json = Record<string, unknown>;

/** A minimal authenticated OTCP client over the runner's connection class. */
class Client {
  #next = 1;
  private constructor(readonly connection: RunnerConnection) {}

  static async connect(instance: TargetInstance): Promise<Client> {
    const client = new Client(await RunnerConnection.open(Number(instance.discovery.port)));
    await client.call('session.hello', {
      token: instance.discovery.token,
      protocol: instance.protocol,
      client: { name: 'otcp-pitch-smoke', version: '1.0.0' },
    });
    return client;
  }

  async call(method: string, params: Json): Promise<Json> {
    const id = `smoke-${String(this.#next++)}`;
    this.connection.write(Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, 'utf8'));
    for (;;) {
      const line = await this.connection.readLine(TIMEOUT_MS);
      if (line === 'closed' || line === 'timeout') throw new Error(`${method}: no response (${line})`);
      const message = JSON.parse(line.toString('utf8')) as Json;
      if (message.id !== id) continue;
      if (message.error !== undefined) throw new Error(`${method}: ${JSON.stringify(message.error)}`);
      return message.result as Json;
    }
  }

  close(): void {
    this.connection.destroy();
  }
}

async function waitForJob(client: Client, jobId: string): Promise<Json> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { job } = (await client.call('job.get', { jobId, waitMs: 5000 })) as { job: Json };
    if (job.state === 'succeeded') return job;
    if (job.state === 'failed' || job.state === 'cancelled') throw new Error(`job ${job.state}`);
  }
  throw new Error('the import job did not finish in time');
}

/** Signed distance of a fractional MIDI value from a truth value, in cents. */
const centsApart = (midi: number, truth: number) => (midi - truth) * 100;

describe.each(targets)('pitch read path on $target.name', ({ target, skipReason }) => {
  if (skipReason !== undefined) {
    it.skip(`reports detected pitch and note starts of generated audio (skipped: ${skipReason})`, () => undefined);
    return;
  }

  it(
    'reports detected pitch and note starts of generated audio',
    async () => {
      const instance = await target.open();
      const client = await Client.connect(instance);
      const info = await client.call('session.info', {});
      const extensions = (info.import as { extensions: string[] }).extensions;
      expect(extensions).toContain('.wav');

      // No method sets tuningHz, so the instance's own value defines the truth.
      const prefs = await client.call('prefs.get', {});
      const tuningHz = (prefs.processing as { tuningHz: number }).tuningHz;

      const tone = generateTone({
        seed: 1,
        tuningHz,
        notes: [
          { midi: 57, durationSec: 0.6 },
          { midi: 62, durationSec: 0.6 },
          { midi: 64, cents: 30, durationSec: 0.6 },
          { midi: 67, durationSec: 0.6 },
        ],
      });
      const files = await writeToneFiles(tone, 'smoke');
      try {
        const started = await client.call('import.start', {
          items: [{ path: files.wavPath }],
          layout: 'single',
          generateNotes: true,
        });
        const jobId = (started.job as { jobId: string }).jobId;
        const job = await waitForJob(client, jobId);
        const items = (job.result as { items: { contentId: string | null; f0State: string | null }[] }).items;
        const contentId = items[0]?.contentId;
        expect(contentId).toBeTruthy();
        expect(items[0]?.f0State).toBe('ready');

        const notes = (await client.call('content.getNotes', { contentId, limit: 500 })) as {
          tuningHz: number;
          notes: { startContentSec: number; detectedMidi: number | null; offsetCents: number }[];
        };
        const curve = (await client.call('content.getPitchCurve', { contentId })) as {
          hopSec: number;
          startContentSec: number;
          stepFrame: number;
          originalMidi: (number | null)[];
        };
        expect(notes.tuningHz).toBe(tuningHz);
        expect(notes.notes).toHaveLength(tone.truth.notes.length);

        tone.truth.notes.forEach((truth, i) => {
          const reported = notes.notes[i];
          expect(reported?.detectedMidi, `note ${String(i)} detectedMidi`).not.toBeNull();
          const detected = reported?.detectedMidi ?? Number.NaN;
          expect(Math.abs(centsApart(detected, truth.midiExact)), `note ${String(i)} pitch`).toBeLessThanOrEqual(
            NOTE_TOLERANCE_CENTS,
          );
          expect(
            Math.abs((reported?.startContentSec ?? Number.NaN) - truth.startSec),
            `note ${String(i)} start`,
          ).toBeLessThanOrEqual(curve.hopSec);
          // The pitch curve agrees inside the note, away from its edges.
          const frameSec = curve.hopSec * curve.stepFrame;
          const values: number[] = [];
          curve.originalMidi.forEach((value, frame) => {
            const t = curve.startContentSec + frame * frameSec;
            if (value !== null && t > truth.startSec + 0.1 && t < truth.endSec - 0.1) values.push(value);
          });
          values.sort((a, b) => a - b);
          const middle = values[Math.floor(values.length / 2)] ?? Number.NaN;
          expect(Math.abs(centsApart(middle, truth.midiExact)), `note ${String(i)} curve`).toBeLessThanOrEqual(
            NOTE_TOLERANCE_CENTS,
          );
        });
      } finally {
        client.close();
        await files.cleanup();
        await instance.close();
      }
    },
    TIMEOUT_MS * 2,
  );
});
