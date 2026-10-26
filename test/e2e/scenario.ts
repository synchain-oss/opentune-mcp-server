// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// What the boundary scenarios against a started OpenTune share: timed steps with the same four
// results as the smoke scenario, and a report of their own (JSON next to OTCP_E2E_REPORT, plus a
// table). The report has the members of the smoke report that make sense for any scenario (schema,
// result, counts, steps) and two of its own: `facts`, what the scenario observed, and
// `manualChecks`, what only a person can check on this machine and why.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { RESULTS, classify, summarise, type StepReport, type StepResult } from './smoke.js';

export interface ScenarioReport {
  readonly schema: 'opentune-mcp-e2e-exe/1';
  /** The scenario's name; also the name of its report file. */
  readonly scenario: string;
  /** FAIL if any step failed, else FLAKY-SKIP / SKIP if any step was skipped, else PASS. */
  readonly result: StepResult;
  readonly counts: Readonly<Record<StepResult, number>>;
  readonly startedAt: string;
  readonly totalMs: number;
  readonly steps: readonly StepReport[];
  /** What the scenario observed that is worth keeping next to the verdict; no paths and no secrets. */
  readonly facts: Readonly<Record<string, FactValue>>;
  /** Checks that cannot be automated on this machine, each with the reason. */
  readonly manualChecks: readonly string[];
}

/** A fact the scenario observed: a scalar, or a list of names (such as the preferences touched). */
export type FactValue = string | number | boolean | null | readonly string[];

export interface StepOptions {
  /** Clean-up: runs even after a step stopped the scenario. */
  readonly always?: boolean;
  /** A SKIP of this step stops the scenario too. */
  readonly haltOnSkip?: boolean;
  /**
   * Whether a FAIL stops the scenario (default true). False for a step whose outcome the later steps do not
   * depend on, so that one deviation does not hide what the others show; the run is a FAIL all the same.
   */
  readonly haltOnFail?: boolean;
}

/** Runs steps in order; one that fails stops the rest, except those marked `always` (clean-up). */
export class Scenario {
  readonly steps: StepReport[] = [];
  readonly facts: Record<string, FactValue> = {};
  readonly manualChecks: string[] = [];
  readonly #started = performance.now();
  readonly #startedAt = new Date().toISOString();
  #halted: string | undefined;

  constructor(readonly name: string) {}

  /** Why the scenario stopped, when it did. */
  get halted(): string | undefined {
    return this.#halted;
  }

  /**
   * Runs a step. A FAIL (or a FLAKY-SKIP: the machine cannot run the instance's inference) stops the
   * scenario; a SKIP stops it only when `haltOnSkip` says the later steps depend on this one, because a
   * capability that one step needs and the instance lacks says nothing about the next step.
   */
  async step(name: string, body: () => Promise<string>, options: StepOptions = {}): Promise<void> {
    if (this.#halted !== undefined && options.always !== true) {
      this.steps.push({ name, result: 'SKIP', ms: 0, note: `not run: ${this.#halted}` });
      return;
    }
    const at = performance.now();
    try {
      const note = await body();
      this.steps.push({ name, result: 'PASS', ms: performance.now() - at, note });
    } catch (error) {
      const { result, note } = classify(error);
      this.steps.push({ name, result, ms: performance.now() - at, note });
      if (
        (result === 'FAIL' && options.haltOnFail !== false) ||
        result === 'FLAKY-SKIP' ||
        (result !== 'FAIL' && options.haltOnSkip === true)
      ) {
        this.#halted ??= `${name} ended with ${result}`;
      }
    }
  }

  report(): ScenarioReport {
    return {
      schema: 'opentune-mcp-e2e-exe/1',
      scenario: this.name,
      ...summarise(this.steps),
      startedAt: this.#startedAt,
      totalMs: Math.round(performance.now() - this.#started),
      steps: this.steps.map((s) => ({ ...s, ms: Math.round(s.ms) })),
      facts: this.facts,
      manualChecks: this.manualChecks,
    };
  }
}

/** The report file of a scenario: `<name>.json` in the folder of OTCP_E2E_REPORT; none without it. */
export function scenarioReportPath(reportPath: string | undefined, name: string): string | undefined {
  return reportPath === undefined ? undefined : path.join(path.dirname(reportPath), `${name}.json`);
}

export function writeScenarioReport(file: string, report: ScenarioReport): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

/** The table printed to the test output (Markdown). */
export function formatScenarioTable(report: ScenarioReport): string {
  const rows = report.steps.map(
    (s) => `| ${s.name} | ${s.result} | ${(s.ms / 1000).toFixed(2)} s | ${s.note.replaceAll('|', '/')} |`,
  );
  const counts = RESULTS.map((r) => `${r} ${String(report.counts[r])}`).join(', ');
  return [
    `${report.scenario}:`,
    '| step | result | time | note |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `${report.result} (${counts}) in ${(report.totalMs / 1000).toFixed(1)} s`,
    ...report.manualChecks.map((m) => `manual check: ${m}`),
  ].join('\n');
}
