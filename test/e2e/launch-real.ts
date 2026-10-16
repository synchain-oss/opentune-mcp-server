// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The launch scenario against a real OpenTune, through the MCP bundle's opentune_launch and
// opentune_get_status: an executable without a control manifest is never started; two launches in a
// row and two at once give one process; and an MCP server that dies leaves OpenTune, its discovery
// file and the unsaved clip alone, so that a new server finds the same instance. The data and
// discovery folders are this run's own. The only process ended is the one the launch started, after
// its discovery file in that folder showed it to be the one. An OpenTune that this scenario did not
// start stops it before anything is launched.

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';

import { parseDiscoveryFile } from '../../src/discovery/file.js';
import { pidAlive } from '../../src/discovery/process.js';
import { systemInstallDetector } from '../../src/launch/install.js';
import { CONTROL_MANIFEST } from '../../src/launch/config.js';
import { OtcpSession } from '../../src/otcp/client.js';
import { generateTone } from '../support/harmonic-tone.js';
import {
  endConfirmed,
  openTunePids,
  removeDir,
  scratchDir,
  startMcp,
  type McpProcess,
  type ToolOutcome,
} from './real-support.js';
import { Scenario, type ScenarioReport } from './scenario.js';
import { StepSkip, isObject, member, runJob, text, type SmokeConfig } from './smoke.js';

export const SCENARIO_NAME = 'launch-real';

/** The OpenTune instances a status or launch result lists. */
function listed(outcome: ToolOutcome): { instanceId: string; pid: number }[] {
  const list = outcome.body.instances;
  if (!Array.isArray(list)) throw new Error('the result lists no instances');
  return list.filter(isObject).map((i) => ({ instanceId: String(i.instanceId), pid: Number(i.pid) }));
}

const flag = (outcome: ToolOutcome, name: string) => outcome.body[name] === true;
const same = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && [...a].sort((x, y) => x - y).every((pid, i) => pid === [...b].sort((x, y) => x - y)[i]);

export async function runLaunchReal(config: SmokeConfig): Promise<ScenarioReport> {
  const scenario = new Scenario(SCENARIO_NAME);
  const timeoutMs = config.stepTimeoutMs;
  let root = '';
  let dataDir = '';
  let toneFile = '';
  let instancesDir = '';
  const servers: McpProcess[] = [];
  let launchedPid = 0;
  let launchedId = '';
  let discoveryFile = '';

  const server = async (env: Record<string, string>): Promise<McpProcess> => {
    const started = await startMcp({ OPENTUNE_DATA_DIR: dataDir, ...env });
    servers.push(started);
    return started;
  };
  const ourExe = { OPENTUNE_MCP_OPENTUNE_PATH: config.exe.exe };

  const session = async (): Promise<OtcpSession> => {
    const entry = parseDiscoveryFile(`${String(launchedPid)}.json`, await readFile(discoveryFile));
    if (!entry.ok) throw new Error(`the discovery file is not valid: ${entry.problem}`);
    return OtcpSession.open(entry.entry, 15_000);
  };
  const clipCount = async (s: OtcpSession): Promise<{ clips: number; dirty: boolean }> => {
    const project = await s.call('project.get', {}, 30_000);
    const placements = member(project, 'placements', 'the project');
    const state = member(project, 'project', 'the project');
    return {
      clips: Array.isArray(placements) ? placements.length : -1,
      dirty: isObject(state) && state.dirty === true,
    };
  };

  await scenario.step(
    'prepare',
    async () => {
      const running = await openTunePids();
      if (running.length > 0) {
        // Not ours: a person may be working in it. It is not touched, and nothing is launched next to it.
        throw new StepSkip('SKIP', 'an OpenTune that this scenario did not start is running; it was left alone');
      }
      root = await scratchDir(SCENARIO_NAME);
      dataDir = path.join(root, 'data');
      instancesDir = path.join(dataDir, 'control', 'instances');
      await mkdir(dataDir, { recursive: true });
      if (config.exe.dataTemplate !== undefined) await cp(config.exe.dataTemplate, dataDir, { recursive: true });
      const tone = generateTone({
        seed: 20260401,
        notes: [0, 2].map((step) => ({ midi: 57 + step, cents: 30, durationSec: 1.1 })),
      });
      toneFile = path.join(root, 'launch-tone.wav');
      await writeFile(toneFile, tone.wav);
      return 'no other OpenTune runs; own data folder (the discovery folder is below it)';
    },
    { haltOnSkip: true },
  );

  await scenario.step('an executable without a control manifest is not started', async () => {
    // The official installation, found read-only, has no manifest; failing that, a copy of this
    // build's executable alone (its manifest stays behind).
    const official = await systemInstallDetector(process.env, process.platform)();
    let exe = official === null ? null : path.join(official.dir, 'OpenTune.exe');
    let source = 'official installation';
    if (exe === null || !existsSync(exe) || existsSync(path.join(path.dirname(exe), CONTROL_MANIFEST))) {
      const dir = path.join(root, 'no-manifest');
      await mkdir(dir, { recursive: true });
      exe = path.join(dir, 'OpenTune.exe');
      await copyFile(config.exe.exe, exe);
      source = 'copy of the test build without its manifest';
    }
    const before = await openTunePids();
    const mcp = await server({ OPENTUNE_MCP_OPENTUNE_PATH: exe });
    const result = await mcp.call('opentune_launch');
    const after = await openTunePids();
    await mcp.stop();
    if (result.body.state !== 'NO_API_BUILD') throw new Error(`the launch gave state ${String(result.body.state)}`);
    if (!same(before, after)) throw new Error('the list of OpenTune processes changed');
    if (existsSync(instancesDir) && (await readdir(instancesDir)).some((name) => /^\d+\.json$/.test(name))) {
      throw new Error('something announced itself in the discovery folder');
    }
    scenario.facts.noManifestExecutable = source;
    return `NO_API_BUILD (${source}); no process started`;
  });

  await scenario.step('two launches at once give one process', async () => {
    const mcp = await server(ourExe);
    const [a, b] = await Promise.all([mcp.call('opentune_launch'), mcp.call('opentune_launch')]);
    if (a.isError || b.isError) throw new Error('a launch ended with an error');
    const started = [a, b].filter((r) => flag(r, 'launched')).length;
    const joinedOrKnown = [a, b].filter((r) => flag(r, 'joined') || flag(r, 'alreadyRunning')).length;
    if (started !== 1 || joinedOrKnown !== 1) {
      throw new Error(
        `${String(started)} calls started OpenTune and ${String(joinedOrKnown)} joined or found it running`,
      );
    }
    for (const r of [a, b]) {
      if (r.body.state !== 'READY') throw new Error(`a launch ended in state ${String(r.body.state)}`);
    }
    const [one, ...rest] = listed(a);
    if (one === undefined || rest.length > 0) throw new Error('the launch does not list exactly one instance');
    launchedPid = one.pid;
    launchedId = one.instanceId;
    discoveryFile = path.join(instancesDir, `${String(launchedPid)}.json`);
    const running = await openTunePids();
    if (running.length !== 1 || running[0] !== launchedPid) {
      throw new Error(`${String(running.length)} OpenTune processes run after two concurrent launches`);
    }
    return 'one started it, the other joined; one pid, state READY';
  });

  await scenario.step('a launch after that finds it running', async () => {
    const mcp = servers.at(-1);
    if (mcp === undefined) throw new Error('no MCP process');
    const again = await mcp.call('opentune_launch');
    if (again.isError || !flag(again, 'alreadyRunning') || flag(again, 'launched')) {
      throw new Error('the second launch did not report alreadyRunning');
    }
    const running = await openTunePids();
    if (running.length !== 1 || running[0] !== launchedPid) throw new Error('the number of OpenTune processes changed');
    return 'alreadyRunning, same pid, no second process';
  });

  await scenario.step('import an unsaved clip', async () => {
    const s = await session();
    try {
      const result = await runJob(
        s,
        'import.start',
        { items: [{ path: toneFile }], layout: 'single' },
        'import',
        timeoutMs,
      );
      const items = member(result, 'items', 'the import result');
      const item: unknown = Array.isArray(items) ? (items as unknown[])[0] : undefined;
      if (!isObject(item) || item.imported !== true) throw new Error('the file was not imported');
      text(item, 'contentId', 'the import item');
      const state = await clipCount(s);
      if (state.clips !== 1 || !state.dirty) throw new Error('the project does not hold one unsaved clip');
    } finally {
      s.close();
    }
    return 'one clip, project has unsaved changes';
  });

  await scenario.step('killing the MCP process leaves OpenTune, its discovery file and the clip', async () => {
    const mcp = servers.at(-1);
    if (mcp === undefined) throw new Error('no MCP process');
    await mcp.kill();
    if (pidAlive(launchedPid) !== true) throw new Error('OpenTune ended with the MCP process');
    if (!existsSync(discoveryFile)) throw new Error('the discovery file is gone');
    const s = await session();
    try {
      const state = await clipCount(s);
      if (state.clips !== 1 || !state.dirty) throw new Error('the unsaved clip is gone');
    } finally {
      s.close();
    }
    return 'OpenTune still runs, the discovery file and the unsaved clip are still there';
  });

  await scenario.step('a new MCP process reads the same instance as READY', async () => {
    const mcp = await server(ourExe);
    const status = await mcp.call('opentune_get_status');
    const [one, ...rest] = listed(status);
    if (status.body.state !== 'READY' || one === undefined || rest.length > 0) {
      throw new Error(`the new server reports ${String(status.body.state)}`);
    }
    if (one.instanceId !== launchedId || one.pid !== launchedPid)
      throw new Error('the new server sees another instance');
    return 'READY, same instanceId and pid';
  });

  // Starting an OpenTune without the control API needs the official GUI, which this scenario does not
  // start on a machine it has not been told is free for it.
  scenario.manualChecks.push(
    'RUNNING_WITHOUT_API: start the official OpenTune without the control API, then call opentune_get_status and ' +
      'opentune_launch; expect state RUNNING_WITHOUT_API and no second process. The scenario never starts or ' +
      'installs the official GUI, and cannot confirm that this machine may run it.',
  );

  await scenario.step(
    'shutdown',
    async () => {
      const notes: string[] = [];
      for (const mcp of servers) await mcp.stop().catch(() => undefined);
      if (discoveryFile !== '' && existsSync(discoveryFile)) {
        try {
          await endConfirmed(discoveryFile);
        } catch (error) {
          notes.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (root !== '') {
        try {
          await removeDir(root);
        } catch {
          notes.push('the scratch folder could not be removed');
        }
      }
      if (notes.length > 0) throw new Error(notes.join('; '));
      return 'the instance the launch started is ended, scratch folder removed';
    },
    { always: true },
  );

  return scenario.report();
}
