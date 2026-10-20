// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The several-instances scenario: two real OpenTune instances announce themselves in one discovery
// directory and the MCP bundle (stdio, as an agent uses it) is asked to read and write. With no
// instance_id it must refuse to pick one and change nothing in either; with one it works on that
// instance only; when one instance ends, its stale discovery file is cleaned up at the next scan
// and the other instance keeps working. Only the instances this scenario started are ended.

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { generateTone } from '../support/harmonic-tone.js';
import {
  instanceSettingsProblems,
  removeDir,
  scratchDir,
  startMcp,
  startRealInstance,
  type McpProcess,
  type RealInstance,
  type ToolOutcome,
} from './real-support.js';
import { Scenario, type ScenarioReport } from './scenario.js';
import { isObject, type SmokeConfig } from './smoke.js';

export const SCENARIO_NAME = 'instances';

const errorKind = (outcome: ToolOutcome): string | null => {
  const error = outcome.body.error;
  return outcome.isError && isObject(error) && typeof error.kind === 'string' ? error.kind : null;
};

const placementCount = (outcome: ToolOutcome): number => {
  if (outcome.isError) throw new Error(`opentune_get_project failed: ${errorKind(outcome) ?? 'unknown error'}`);
  const list = outcome.body.placements;
  if (!Array.isArray(list)) throw new Error('opentune_get_project returned no placements');
  return list.length;
};

export async function runInstances(config: SmokeConfig): Promise<ScenarioReport> {
  const scenario = new Scenario(SCENARIO_NAME);
  const startTimeout = config.exe.timeoutMs ?? 60_000;
  let root = '';
  let discoveryDir = '';
  let toneFile = '';
  let mcp: McpProcess | undefined;
  const instances: RealInstance[] = [];

  const client = (): McpProcess => {
    if (mcp === undefined) throw new Error('no MCP process');
    return mcp;
  };
  const instance = (i: number): RealInstance => {
    const found = instances[i];
    if (found === undefined) throw new Error(`instance ${String(i)} was not started`);
    return found;
  };

  await scenario.step('prepare', async () => {
    root = await scratchDir(SCENARIO_NAME);
    discoveryDir = path.join(root, 'discovery');
    const tone = generateTone({
      seed: 20260401,
      notes: [0, 2].map((step) => ({ midi: 57 + step, cents: 30, durationSec: 1.1 })),
    });
    toneFile = path.join(root, 'instances-tone.wav');
    await writeFile(toneFile, tone.wav);
    return 'one shared discovery folder and a short generated tone';
  });

  await scenario.step(
    'start two instances in one discovery folder',
    async () => {
      for (let i = 0; i < 2; i++) {
        instances.push(
          await startRealInstance({
            exe: config.exe.exe,
            discoveryDir,
            dataDirParent: root,
            dataTemplate: config.exe.dataTemplate,
            timeoutMs: startTimeout,
          }),
        );
      }
      if (instance(0).instanceId === instance(1).instanceId || instance(0).pid === instance(1).pid) {
        throw new Error('the two instances are not distinct');
      }
      return 'two distinct instances announced themselves';
    },
    { haltOnSkip: true },
  );

  await scenario.step('the bundle lists both and says to pass instance_id', async () => {
    mcp = await startMcp({ OPENTUNE_MCP_DISCOVERY_DIR: discoveryDir });
    const status = await client().call('opentune_get_status');
    const listed = Array.isArray(status.body.instances) ? status.body.instances : [];
    if (listed.length !== 2) throw new Error(`opentune_get_status lists ${String(listed.length)} instances, not 2`);
    if (status.body.reason !== 'multiple_instances') {
      throw new Error(`the status reason is ${String(status.body.reason)}, not multiple_instances`);
    }
    return 'two instances listed, reason multiple_instances';
  });

  await scenario.step('without instance_id a read and a write are refused and change nothing', async () => {
    const read = await client().call('opentune_get_project');
    if (errorKind(read) !== 'MULTIPLE_INSTANCES') throw new Error(`the read gave ${errorKind(read) ?? 'a result'}`);
    const write = await client().call('opentune_open_audio', { path: toneFile });
    if (errorKind(write) !== 'MULTIPLE_INSTANCES') throw new Error(`the write gave ${errorKind(write) ?? 'a result'}`);
    for (const each of instances) {
      const count = placementCount(await client().call('opentune_get_project', { instance_id: each.instanceId }));
      if (count !== 0) throw new Error('the refused write still changed an instance');
    }
    return 'MULTIPLE_INSTANCES for the read and the write; neither instance holds a clip';
  });

  await scenario.step('with instance_id the write works on that instance only', async () => {
    const wrote = await client().call('opentune_open_audio', { path: toneFile, instance_id: instance(0).instanceId });
    if (wrote.isError) throw new Error(`the write with instance_id failed: ${errorKind(wrote) ?? 'unknown'}`);
    const a = placementCount(await client().call('opentune_get_project', { instance_id: instance(0).instanceId }));
    const b = placementCount(await client().call('opentune_get_project', { instance_id: instance(1).instanceId }));
    if (a !== 1 || b !== 0) throw new Error(`the first instance holds ${String(a)} clips and the second ${String(b)}`);
    return 'the clip is in the chosen instance, the other one is untouched';
  });

  await scenario.step('an ended instance is cleaned up and the other one keeps working', async () => {
    const gone = instance(1);
    if (!(await gone.end())) throw new Error('the second instance had ended by itself');
    // The next scan (any call) finds the process gone and removes its discovery file.
    const read = await client().call('opentune_get_project');
    if (placementCount(read) !== 1) throw new Error('the remaining instance does not answer as the only one');
    if (existsSync(gone.discoveryFile)) throw new Error('the discovery file of the ended instance was not cleaned up');
    const status = await client().call('opentune_get_status');
    const listed = Array.isArray(status.body.instances) ? status.body.instances : [];
    if (listed.length !== 1) throw new Error(`opentune_get_status lists ${String(listed.length)} instances, not 1`);
    return 'discovery file removed at the next scan; the remaining instance is the only one and answers';
  });

  await scenario.step(
    'shutdown',
    async () => {
      const notes: string[] = [];
      await mcp?.stop();
      for (const each of instances) {
        try {
          await each.end();
        } catch (error) {
          notes.push(error instanceof Error ? error.message : String(error));
        }
      }
      notes.push(...(await instanceSettingsProblems(instances)));
      if (root !== '') {
        try {
          await removeDir(root);
        } catch {
          notes.push('the scratch folder could not be removed');
        }
      }
      if (notes.length > 0) throw new Error(notes.join('; '));
      return 'the instances this scenario started are ended, scratch folder removed';
    },
    { always: true },
  );

  return scenario.report();
}
