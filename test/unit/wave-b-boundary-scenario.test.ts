// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The wave-B boundary scenario (test/e2e/wave-b-boundary.ts) against the test mock in place of an executable:
// its steps pass against a correct instance, and each deviation of the instance in the save-as and missing-media
// steps (project.save and the revert recipe of project.open) fails the step that notices it instead of passing.

import { afterAll, describe, expect, it } from 'vitest';

import { startMock, type OtcpMock } from '../../mock/server.js';
import { OtcpError } from '../../src/errors/tool-error.js';
import type { Json } from '../../src/otcp/client.js';
import type { RealInstance, RealInstanceOptions } from '../e2e/real-support.js';
import type { ScenarioReport } from '../e2e/scenario.js';
import type { SmokeConfig } from '../e2e/smoke.js';
import { runWaveBBoundary, type WaveBBoundaryHooks } from '../e2e/wave-b-boundary.js';
import { wrapSession, type BeforeCall, type SessionDefect } from '../support/wrap-session.js';

const cleanup: (() => unknown)[] = [];
// The tests run side by side (each scenario run waits on timers of its own), so the clean-up waits for all of them.
afterAll(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const config: SmokeConfig = {
  exe: { exe: process.execPath },
  stepTimeoutMs: 20_000,
  reportPath: undefined,
};

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SAVE_AS = 'save as over another project';
const MISSING_MEDIA = 'a project with missing media';

interface Defects {
  readonly reply?: SessionDefect;
  readonly before?: BeforeCall;
}

/** Runs the scenario against a mock whose replies `defects` changes. */
async function run(defects: Defects = {}): Promise<{ report: ScenarioReport; calls: [string, Json][] }> {
  const calls: [string, Json][] = [];
  const mocks: OtcpMock[] = [];
  const hooks: WaveBBoundaryHooks = {
    async instance(request: RealInstanceOptions): Promise<RealInstance> {
      const mock = await startMock({ discoveryDir: request.discoveryDir });
      mocks.push(mock);
      mock.given({ audio: { running: true } });
      return {
        pid: Number(mock.discovery.pid),
        instanceId: mock.discovery.instanceId,
        discoveryFile: mock.discoveryPath,
        end: async () => {
          await mock.stop();
          return true;
        },
      };
    },
    session: (session) =>
      wrapSession(session, defects.reply ?? (() => undefined), (method, params) => {
        calls.push([method, structuredClone(params)]);
        defects.before?.(method, params);
      }),
  };
  cleanup.push(async () => {
    for (const mock of mocks) await mock.stop();
  });
  const report = await runWaveBBoundary(config, hooks);
  return { report, calls };
}

const stepOf = (report: ScenarioReport, name: string) => report.steps.find((step) => step.name === name);

/**
 * Changes the result of the nth job that `method` started (the jobs of this scenario are followed with job.get,
 * which carries the result of the job), and counts the calls of every method.
 */
function onJob(method: string, nth: number, edit: (result: Json) => void): Required<Defects> {
  const counts = new Map<string, number>();
  let started = '';
  return {
    before: (name) => {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (name === method || name.startsWith('project.') || name.startsWith('import.')) started = name;
    },
    reply: (name, result) => {
      if (name !== 'job.get' || started !== method || counts.get(method) !== nth) return undefined;
      const job = result.job;
      if (!isObject(job) || job.state !== 'succeeded' || !isObject(job.result)) return undefined;
      edit(job.result);
      return result;
    },
  };
}

/** Joins the defects of two hooks. */
function both(a: Required<Defects>, b: Required<Defects>): Required<Defects> {
  return {
    before: (method, params) => {
      a.before(method, params);
      b.before(method, params);
    },
    reply: (method, result, params) => {
      const first = a.reply(method, result, params);
      return b.reply(method, first ?? result, params) ?? first;
    },
  };
}

const warningsOf = (result: Json): Json[] => (Array.isArray(result.warnings) ? result.warnings.filter(isObject) : []);

describe.concurrent('the wave-B boundary scenario against a correct mock', () => {
  it('passes the save-as and missing-media steps, and reports what it saw', async () => {
    const { report } = await run();
    const names = report.steps.map((step) => `${step.name}=${step.result}`);
    expect(names).toContain(`${SAVE_AS}=PASS`);
    expect(names).toContain(`${MISSING_MEDIA}=PASS`);
    expect(report.steps.filter((step) => step.result === 'FAIL')).toEqual([]);
    expect(stepOf(report, SAVE_AS)?.note).toContain('project.save cleared the unsaved-changes flag');
    expect(stepOf(report, MISSING_MEDIA)?.note).toContain(
      'the revert recipe opened the previous project again: 5 clips as before',
    );
    expect(report.facts.editMarksDirty).toBe(true);
    expect(report.facts.saveWrote).toBe(true);
    expect(report.result).toBe('PASS');
  }, 120_000);

  it('sends project.save without parameters, and the revert recipe of project.open exactly as given', async () => {
    const { calls } = await run();
    const saves = calls.filter(([method]) => method === 'project.save');
    expect(saves).toHaveLength(1);
    expect(saves[0]?.[1]).toEqual({});
    const opens = calls.filter(([method]) => method === 'project.open').map(([, params]) => params);
    expect(opens).toHaveLength(2);
    // The recipe names the previous project and carries no consent of its own.
    expect(Object.keys(opens[1] ?? {})).toEqual(['path']);
    expect(Object.keys(opens[0] ?? {})).toEqual(['path']);
  }, 120_000);
});

describe.concurrent('project.save in the save-as step', () => {
  const fails = async (defects: Defects, expected: string): Promise<void> => {
    const { report } = await run(defects);
    const step = stepOf(report, SAVE_AS);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain(expected);
    // A deviation of the save does not hide the step after it.
    expect(stepOf(report, MISSING_MEDIA)).toBeDefined();
  };

  it('fails a result without the IRREVERSIBLE warning', async () => {
    await fails(
      onJob('project.save', 1, (result) => {
        result.warnings = warningsOf(result).filter((w) => w.code !== 'IRREVERSIBLE');
      }),
      'project.save carries no IRREVERSIBLE warning',
    );
  }, 120_000);

  it('fails a result without the NOT_SAVED_IN_PROJECT warning', async () => {
    await fails(
      onJob('project.save', 1, (result) => {
        result.warnings = warningsOf(result).filter((w) => w.code !== 'NOT_SAVED_IN_PROJECT');
      }),
      'project.save carries no NOT_SAVED_IN_PROJECT warning',
    );
  }, 120_000);

  it('fails a result that reports OVERWROTE_OTHER_PROJECT for the project file itself', async () => {
    await fails(
      onJob('project.save', 1, (result) => {
        result.warnings = [...warningsOf(result), { code: 'OVERWROTE_OTHER_PROJECT', subject: null, data: null }];
      }),
      'project.save reports OVERWROTE_OTHER_PROJECT',
    );
  }, 120_000);

  it('fails a result that says the save can be undone', async () => {
    await fails(
      onJob('project.save', 1, (result) => {
        result.undo = { undoable: true, reason: null, revert: null };
      }),
      'project.save: undo is not {undoable:false, reason:no_upstream_undo, revert:null}',
    );
  }, 120_000);

  it('fails a result that names another file than the project file', async () => {
    await fails(
      onJob('project.save', 1, (result) => {
        result.path = 'C:\\Music\\elsewhere.otproj';
      }),
      'project.save wrote another file than the project file',
    );
  }, 120_000);

  it('fails a result that reports an empty file', async () => {
    await fails(
      onJob('project.save', 1, (result) => {
        result.sizeBytes = 0;
      }),
      'project.save reports an empty file',
    );
  }, 120_000);

  it('fails when project.get still reports unsaved changes after the save', async () => {
    let saved = false;
    await fails(
      {
        before: (method) => {
          if (method === 'project.save') saved = true;
        },
        reply: (method, result) => {
          if (method !== 'project.get' || !saved || !isObject(result.project)) return undefined;
          result.project.dirty = true;
          return result;
        },
      },
      'project.get still reports unsaved changes after project.save',
    );
  }, 120_000);

  it('fails when project.get names another file after the save', async () => {
    let saved = false;
    await fails(
      {
        before: (method) => {
          if (method === 'project.save') saved = true;
        },
        reply: (method, result) => {
          if (method !== 'project.get' || !saved || !isObject(result.project)) return undefined;
          result.project.path = 'C:\\Music\\elsewhere.otproj';
          return result;
        },
      },
      'project.get names another file after project.save',
    );
  }, 120_000);

  it('fails when a change does not mark the project as changed, so there is nothing for the save to clear', async () => {
    await fails(
      {
        reply: (method, result) => {
          if (method !== 'project.get' || !isObject(result.project)) return undefined;
          result.project.dirty = false;
          return result;
        },
      },
      'a change did not mark the project as changed',
    );
  }, 120_000);
});

describe.concurrent('the revert recipe of project.open in the missing-media step', () => {
  const fails = async (defects: Defects, expected: string): Promise<ScenarioReport> => {
    const { report } = await run(defects);
    const step = stepOf(report, MISSING_MEDIA);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain(expected);
    return report;
  };

  it('fails a result without a revert recipe', async () => {
    await fails(
      onJob('project.open', 1, (result) => {
        result.undo = { undoable: false, reason: 'no_upstream_undo', revert: null };
      }),
      'the result of project.open gives no revert recipe that opens the previous project',
    );
  }, 120_000);

  it('fails a recipe that is not a project.open', async () => {
    await fails(
      onJob('project.open', 1, (result) => {
        result.undo = { undoable: false, reason: 'no_upstream_undo', revert: { method: 'project.get', params: {} } };
      }),
      'gives no revert recipe that opens the previous project',
    );
  }, 120_000);

  it('fails a recipe that names another file than the previous project', async () => {
    const report = await fails(
      onJob('project.open', 1, (result) => {
        const undo = isObject(result.undo) ? result.undo : {};
        const revert = isObject(undo.revert) ? undo.revert : { method: 'project.open', params: {} };
        result.undo = { ...undo, revert: { ...revert, params: { path: 'C:\\Music\\elsewhere.otproj' } } };
      }),
      'the revert recipe of project.open names another file than the previous project',
    );
    expect(report.result).toBe('FAIL');
  }, 120_000);

  it('fails a revert recipe the instance refuses for unsaved changes, and opens the project with the consent of the end user', async () => {
    const opens: Json[] = [];
    let count = 0;
    const { report } = await run({
      before: (method, params) => {
        if (method !== 'project.open') return;
        opens.push(structuredClone(params));
        count += 1;
        // The second open is the revert recipe.
        if (count === 2) {
          throw new OtcpError({
            kind: 'UNSAVED_CHANGES',
            reason: null,
            retryable: false,
            detail: 'the project has unsaved changes',
            executed: false,
          });
        }
      },
    });
    const step = stepOf(report, MISSING_MEDIA);
    expect(step?.result).toBe('FAIL');
    expect(step?.note).toContain('the revert recipe of project.open was refused with UNSAVED_CHANGES');
    expect(opens).toHaveLength(3);
    expect(opens[1]?.discardUnsaved).toBeUndefined();
    expect(opens[2]?.discardUnsaved).toBe(true);
  }, 120_000);

  it('fails when the clips after the revert recipe are not the ones from before the open', async () => {
    let opens = 0;
    await fails(
      {
        before: (method) => {
          if (method === 'project.open') opens += 1;
        },
        reply: (method, result) => {
          if (method !== 'project.get' || opens < 2 || !Array.isArray(result.placements)) return undefined;
          result.placements = result.placements.slice(0, -1);
          return result;
        },
      },
      'the clips after the revert recipe are not the ones from before the open',
    );
  }, 120_000);

  it('fails when project.get reports unsaved changes after the revert recipe', async () => {
    let opens = 0;
    await fails(
      {
        before: (method) => {
          if (method === 'project.open') opens += 1;
        },
        reply: (method, result) => {
          if (method !== 'project.get' || opens < 2 || !isObject(result.project)) return undefined;
          result.project.dirty = true;
          return result;
        },
      },
      'project.get reports unsaved changes after the revert recipe',
    );
  }, 120_000);

  it('fails when project.get names another project file after the revert recipe', async () => {
    let opens = 0;
    await fails(
      {
        before: (method) => {
          if (method === 'project.open') opens += 1;
        },
        reply: (method, result) => {
          if (method !== 'project.get' || opens < 2 || !isObject(result.project)) return undefined;
          result.project.path = 'C:\\Music\\elsewhere.otproj';
          return result;
        },
      },
      'project.get names another project file after the revert recipe than before the open',
    );
  }, 120_000);

  it('combines with a deviation of project.save without one hiding the other', async () => {
    const { report } = await run(
      both(
        onJob('project.save', 1, (result) => {
          result.sizeBytes = 0;
        }),
        onJob('project.open', 1, (result) => {
          result.undo = { undoable: false, reason: 'no_upstream_undo', revert: null };
        }),
      ),
    );
    expect(stepOf(report, SAVE_AS)?.result).toBe('FAIL');
    expect(stepOf(report, MISSING_MEDIA)?.result).toBe('FAIL');
  }, 120_000);
});
