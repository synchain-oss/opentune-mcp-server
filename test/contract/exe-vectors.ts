// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Registers the vectors against a started OpenTune executable (exe-target.ts). Without
// OTCP_TARGET_EXE the whole target is one skipped test that says why; it never reports PASS.
// A PASS / FAIL / SKIP table goes to stderr, and to the file named by OTCP_CONTRACT_SUMMARY_EXE
// (JSON) for the "contract vectors (exe)" row of `npm run gates`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, it } from 'vitest';

import { exeConfigFromEnv, exeTarget, type ExeTarget } from './exe-target.js';
import { runVector, type Outcome } from './runner.js';
import { loadVectors, type Vector } from './vectors.js';

/** An outcome, with the data folder of the launch (relative to OTCP_TARGET_DATA_DIR) when it was kept. */
export interface ExeOutcome extends Outcome {
  readonly dataDir?: string;
}

/**
 * Runs one vector against the exe target. What the target found wrong with the instance while
 * ending it (left its discovery file, ended by itself, could not be ended) makes the vector FAIL,
 * whatever the vector itself gave. Never throws, like runVector.
 */
export async function runExeVector(
  vector: Vector,
  target: Pick<ExeTarget, 'name' | 'open' | 'takeProblems'> & Partial<Pick<ExeTarget, 'labelNext' | 'takeDataDirs'>>,
): Promise<ExeOutcome> {
  target.labelNext?.(vector.id);
  let outcome = await runVector(vector, target);
  const dataDir = target.takeDataDirs?.()[0];
  // A modal dialog open from the start refuses every write; say so where the FAIL is read.
  if (outcome.result === 'FAIL' && outcome.receivedModalOpen === true) {
    outcome = { ...outcome, note: `${outcome.note} (the instance has a modal dialog open)` };
  }
  const kept = dataDir === undefined ? {} : { dataDir };
  const problems = target.takeProblems();
  if (problems.length === 0) return { ...outcome, ...kept };
  const itself = outcome.note === '' ? outcome.result : `${outcome.result}: ${outcome.note}`;
  return { id: outcome.id, result: 'FAIL', note: `${problems.join('; ')} (the vector itself: ${itself})`, ...kept };
}

/** One vector of the result file that scripts/vector-coverage.mjs reads. */
export const vectorRow = (o: Outcome): { id: string; status: Outcome['result']; reason?: string } => ({
  id: o.id,
  status: o.result,
  ...(o.note === '' ? {} : { reason: neutralize(o.note) }),
});

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A regular expression that matches `directory` with either slash and any letter case. */
function directoryPattern(directory: string): RegExp {
  const parts = directory.split(/[\\/]+/).filter((part) => part !== '');
  const lead = /^[\\/]/.test(directory) ? '[\\\\/]+' : '';
  return new RegExp(`${lead}${parts.map(escapeRegExp).join('[\\\\/]+')}(?=[\\\\/]|$|[^\\w.-])`, 'gi');
}

/**
 * Makes text safe to share: the home folder becomes `~`, the temporary folder `%TEMP%` (Windows) or
 * `$TMPDIR` (elsewhere), matched without regard to case and with either slash, and a stack trace
 * keeps its first line. The temporary folder is replaced first because it often lies inside the home folder.
 */
export function neutralize(
  text: string,
  folders: { home: string; tmp: string; windows: boolean } = {
    home: homedir(),
    tmp: tmpdir(),
    windows: process.platform === 'win32',
  },
): string {
  const firstLine = text.split(/\r?\n\s+at /)[0] ?? text;
  let out = firstLine;
  const tmpName = folders.windows ? '%TEMP%' : '$TMPDIR';
  if (folders.tmp !== '') out = out.replace(directoryPattern(folders.tmp), () => tmpName);
  if (folders.home !== '') out = out.replace(directoryPattern(folders.home), () => '~');
  return out;
}

export function registerExeVectors(env: NodeJS.ProcessEnv = process.env): void {
  describe('contract vectors against the exe', () => {
    let target: ExeTarget;
    try {
      const config = exeConfigFromEnv(env);
      if ('skip' in config) {
        it.skip(`exe target not run: ${config.skip}`, () => undefined);
        return;
      }
      target = exeTarget(config.options);
    } catch (error) {
      // Configured, but wrongly: a failure, never a skip.
      const problem = error instanceof Error ? error : new Error(String(error));
      it('configuration', () => {
        throw problem;
      });
      return;
    }
    const outcomes: ExeOutcome[] = [];

    it.for(loadVectors())('$id', async (entry, ctx) => {
      const outcome: ExeOutcome =
        entry.problems.length > 0
          ? { id: entry.id, result: 'FAIL', note: `invalid vector: ${entry.problems.join('; ')}` }
          : await runExeVector(entry.vector, target);
      outcomes.push(outcome);
      if (outcome.result === 'FAIL') throw new Error(outcome.note);
      if (outcome.result === 'SKIP') ctx.skip(outcome.note);
    });

    afterAll(() => {
      const cell = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
      const table = [
        '| Vector | Result | Notes | Data folder |',
        '| --- | --- | --- | --- |',
        ...outcomes.map((o) => `| ${o.id} | ${o.result} | ${cell(o.note)} | ${o.dataDir ?? ''} |`),
      ];
      const { verified, forced, endedAsAsked, exitedEarly, leftDiscoveryFile, notEnded, templateSkipped } =
        target.stats;
      process.stderr.write(
        `\nContract vectors (exe target):\n${table.join('\n')}\n` +
          `Instances: ${String(verified)} exited normally with their discovery file removed, ` +
          `${String(forced)} ended by force (clean-up on exit not verified), ` +
          `${String(endedAsAsked)} quit by themselves where a vector asked for it, ` +
          `${String(exitedEarly)} ended by themselves during a vector, ` +
          `${String(leftDiscoveryFile)} left their discovery file behind, ` +
          `${String(notEnded)} could not be confirmed as started by this run and were not ended\n` +
          (templateSkipped > 0
            ? `Data template: its ready file and discovery folder were not copied, in ${String(templateSkipped)} launches (the runner uses them itself)\n`
            : ''),
      );
      const count = (result: Outcome['result']) => outcomes.filter((o) => o.result === result).length;
      const skipReasons: Record<string, number> = {};
      for (const o of outcomes.filter((x) => x.result === 'SKIP')) {
        const reason = neutralize(o.note);
        skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
      }
      const file = env.OTCP_CONTRACT_SUMMARY_EXE;
      if (file !== undefined && file !== '') {
        mkdirSync(path.dirname(file), { recursive: true });
        const summary = {
          runner: 'exe',
          // The build under test: set OTCP_TARGET_COMMIT to its commit; vector-coverage.mjs prints it.
          commit: env.OTCP_TARGET_COMMIT ?? 'unknown',
          vectors: outcomes.map(vectorRow),
          total: outcomes.length,
          pass: count('PASS'),
          fail: count('FAIL'),
          skip: count('SKIP'),
          skipReasons,
          failed: outcomes.filter((o) => o.result === 'FAIL').map((o) => o.id),
          // Relative to OTCP_TARGET_DATA_DIR; empty unless that was set.
          dataDirs: Object.fromEntries(outcomes.flatMap((o) => (o.dataDir === undefined ? [] : [[o.id, o.dataDir]]))),
          instances: { verified, forced, endedAsAsked, exitedEarly, leftDiscoveryFile, notEnded },
          templateSkipped,
        };
        writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
      }
    });
  });
}
