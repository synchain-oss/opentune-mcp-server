// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// A stand-in for an OpenTune executable, started with process.execPath by the tests of the exe
// target: it takes the same options, writes a discovery file and a ready file, listens on the
// loopback address and answers session.hello. `--mode=<name>` makes it misbehave in one way.
// Not part of the published package.
//
// Launcher modes start a second copy of this script, which writes the files, and exit at once,
// as a launcher that hands over to the real process does.
//
// The `smoke*` modes also answer the calls of the end-to-end smoke scenario (import, AUTO, export)
// with canned results, enough to walk the protocol; no audio is analysed. `smoke-dry` lists the
// content in dryContents, `smoke-backend` fails the import with an unavailable inference backend,
// `smoke-no-export` does not report export.v1,
// `smoke-open-scale` reports a scale AUTO's closed list does not have, `smoke-busy` refuses the
// import with BUSY modal_open and answers ui.getState (with ui.bridge reported), `smoke-busy-nobridge`
// does the same without reporting ui.bridge. Every reply of these modes
// has the shape the specification gives its result (the unit tests validate them).
//
// The `effects*` modes answer the calls of the end-to-end effects scenario with a small model of
// clips, notes and exports (test/support/fake-effects.mjs). The `arrangement*` modes answer the
// calls of the arrangement effects scenario with a small model of tracks, clips, their gain, fades
// and mute/solo, and a master mix (test/support/fake-arrangement.mjs).
//
// The `quit*` modes report app.quit and answer it as an instance that quits does: the result first, then
// the connections and the listener are closed and the process ends by itself. `quit` removes its discovery
// file and exits with status 0, `quit-no-cleanup` leaves the file, `quit-bad-exit` exits with status 5, and
// `quit-stays` closes everything but does not exit. `launcher-quit` is `quit` started through a launcher.
//
// Every copy that keeps running ends by itself once its OPENTUNE_DATA_DIR is gone, so a test that
// fails cannot leave one behind; with `--marker=<file>` it first writes how it ended to that file.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createArrangement } from './fake-arrangement.mjs';
import { createEffects } from './fake-effects.mjs';

const option = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const mode = option('mode') ?? 'ok';
const readyFile = option('control-api-ready-file');
const nonce = option('control-api-launch-nonce');
const marker = option('marker');
const dirFile = option('dirfile');
const snapshotFile = option('snapshot');
const dataDir = process.env.OPENTUNE_DATA_DIR;

const smoke = mode.startsWith('smoke');
const effects = mode.startsWith('effects') ? createEffects(mode) : undefined;
const arrangement = mode.startsWith('arrangement') ? createArrangement(mode) : undefined;
const quit = mode.startsWith('quit');
/** The rest of a valid session.hello result (the limits are fixed by PROTOCOL.md section 3.4). */
const HELLO_REST = {
  appVersion: '0.0.0-fake',
  flavor: 'standalone',
  limits: {
    preAuthReadBytes: 8192,
    helloTimeoutMs: 2000,
    maxPreAuthConnections: 8,
    maxSessions: 4,
    maxLineBytes: 4194304,
    maxInFlightPerSession: 16,
    idleTimeoutMs: 600000,
    dispatchTimeoutMs: 10000,
    jobWaitMaxMs: 30000,
    jobRetentionMs: 1800000,
    jobRetentionCount: 64,
  },
};

const endWith = (how, code) => {
  if (marker !== undefined) fs.writeFileSync(marker, how);
  process.exit(code);
};

const LAUNCHED = { launcher: 'ok', 'launcher-bad-start': 'bad-start', 'launcher-quit': 'quit' };
if (mode in LAUNCHED) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--mode='));
  const instance = spawn(process.execPath, [fileURLToPath(import.meta.url), `--mode=${LAUNCHED[mode]}`, ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  instance.unref();
  instance.once('spawn', () => process.exit(0));
} else {
  // A stand-in must never outlive its test.
  setInterval(() => {
    if (!fs.existsSync(dataDir)) endWith('watchdog', 0);
  }, 500);
  setTimeout(() => endWith('lifetime', 0), 120_000).unref();

  if (mode === 'early-exit') {
    // The secrets a real server must never print are made up here, at run time.
    process.stderr.write(`start-up failed, token ${randomBytes(32).toString('hex')}, nonce ${nonce}\n`);
    process.exit(3);
  }
  if (mode !== 'no-ready') serve();
}

const smokeCapabilities = () =>
  ['session.v1', 'jobs.v1', 'read.v1', 'import.v1', 'edit.v1', 'export.v1']
    .filter((c) => !(mode === 'smoke-no-export' && c === 'export.v1'))
    .concat(mode === 'smoke-busy' ? ['ui.bridge'] : []);

const CONTENT_ID = 'c:0123abcd:0:1';
const jobs = new Map();
let importedSource;
const tokens = (revision) => ({
  arrangementRevision: 'a1',
  contents: [{ contentId: CONTENT_ID, revision, gridRevision: 'g1', keyRevision: 'k1' }],
  placements: [],
});
const envelope = (revision, job = null) => ({
  applied: job === null,
  noOp: false,
  dryRun: false,
  changes: [],
  created: [],
  removed: [],
  idMap: [],
  revisionDiff: { arrangement: null, trackState: null, contents: [] },
  tokens: tokens(revision),
  undo:
    job === null
      ? { undoable: true, undoId: 'u:0123abcd:1', description: 'canned', innerActions: ['canned'], steps: 1 }
      : null,
  dirty: { before: false, after: true },
  ui: null,
  sideEffects: {},
  warnings: [],
  job,
});
const noProgress = { fraction: null, phase: null, itemsDone: null, itemsTotal: null };
const failure = (id, kind, reason) => ({
  jsonrpc: '2.0',
  id,
  error: { code: -32000, message: kind, data: { kind, reason, detail: 'canned', retryable: false, executed: false } },
});

/** The seconds of a PCM WAV file: data bytes over the byte rate of its fmt chunk. */
function wavSeconds(file) {
  const bytes = fs.readFileSync(file);
  return bytes.readUInt32LE(40) / bytes.readUInt32LE(28);
}

/** A stereo float32 WAV of `seconds` seconds holding a quiet tone. */
function exportWav(seconds) {
  const rate = 44100;
  const frames = Math.round(seconds * rate);
  const wav = Buffer.alloc(44 + frames * 8);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + frames * 8, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 8, 28);
  wav.writeUInt16LE(8, 32);
  wav.writeUInt16LE(32, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(frames * 8, 40);
  for (let i = 0; i < frames; i++) {
    const v = 0.25 * Math.sin((2 * Math.PI * 261.63 * i) / rate);
    wav.writeFloatLE(v, 44 + i * 8);
    wav.writeFloatLE(v, 48 + i * 8);
  }
  return wav;
}

const autoResult = (params) => ({
  ...envelope('r2'),
  mode: params.mode,
  keyUsed: params.key,
  paramsUsed: null,
  noteCount: { before: 0, after: 8 },
  omittedCount: { changes: 0, created: 0, removed: 0 },
});

function smokeReply(request) {
  const { id, method, params } = request;
  const result = (value) => ({ jsonrpc: '2.0', id, result: value });
  if (method === 'import.start') {
    if (mode.startsWith('smoke-busy')) return failure(id, 'BUSY', 'modal_open');
    if (mode === 'smoke-backend') return failure(id, 'MODEL_UNAVAILABLE', 'backend_unavailable');
    const jobId = `j:0123abcd:${String(jobs.size + 1)}`;
    importedSource = params.items[0].path;
    jobs.set(jobId, { kind: 'import', polls: 0, source: importedSource });
    return result(envelope('r1', { jobId, kind: 'import', state: 'queued' }));
  }
  if (method === 'export.start') {
    const jobId = `j:0123abcd:${String(jobs.size + 1)}`;
    jobs.set(jobId, { kind: 'export', polls: 0, target: params.path });
    return result(envelope('r2', { jobId, kind: 'export', state: 'queued' }));
  }
  if (method === 'ui.getState' && mode === 'smoke-busy') {
    return result({
      busy: {
        pointerDown: false,
        modalOpen: true,
        importInProgress: false,
        exportInProgress: false,
        projectOperation: false,
      },
      dialogs: [{ kind: 'message', title: 'Welcome', closeCommits: false, trackId: null }],
      onboarding: { shown: false, showing: true },
      ui: {},
      uiScale: { root: 0, scale: 'major' },
    });
  }
  if (method === 'job.get') {
    const job = jobs.get(params.jobId);
    if (job === undefined) return failure(id, 'NOT_FOUND', 'job_not_found');
    job.polls++;
    const base = { jobId: params.jobId, kind: job.kind, cancellable: false, createdAtMs: 0, updatedAtMs: 0 };
    if (job.polls < 2) {
      return result({
        job: { ...base, state: 'running', finishedAtMs: null, progress: noProgress, result: null, error: null },
      });
    }
    let jobResult;
    if (job.kind === 'import') {
      jobResult = {
        ...envelope('r1'),
        items: [
          {
            path: job.source,
            imported: true,
            placementId: 'p:0123abcd:0:1',
            contentId: CONTENT_ID,
            trackId: 1,
            startTimelineSec: 0,
            durationSec: 9.9,
            channelCount: 1,
            originalSampleRateHz: 44100,
            resampled: false,
            f0State: 'ready',
            notesGenerated: true,
            notesGeneratedBy: 'request',
            error: null,
          },
        ],
        counts: { requested: 1, imported: 1, failed: 0 },
      };
    } else {
      const seconds = wavSeconds(importedSource);
      fs.writeFileSync(job.target, exportWav(seconds));
      jobResult = {
        path: job.target,
        sampleRateHz: 44100,
        channelCount: 2,
        sampleFormat: 'float32',
        durationSec: seconds,
        startTimelineSec: 0,
        contents: [{ contentId: CONTENT_ID, revision: 'r3' }],
        dryContents: mode === 'smoke-dry' ? [{ contentId: CONTENT_ID, reason: 'unvoiced' }] : [],
        processing: { vocoderWeight: null, hybridMode: false, backend: 'fake', tuningHz: 440 },
      };
    }
    return result({
      job: { ...base, state: 'succeeded', finishedAtMs: 1, progress: noProgress, result: jobResult, error: null },
    });
  }
  if (method === 'content.getDetails') {
    return result({
      asOf: { arrangementRevision: 'a1', contents: tokens('r1').contents },
      derived: [],
      contentId: CONTENT_ID,
      viaPlacementId: 'p:0123abcd:0:1',
      placementIds: ['p:0123abcd:0:1'],
      durationSec: 9.9,
      key: {
        root: mode === 'smoke-open-scale' ? 2 : 0,
        scale: mode === 'smoke-open-scale' ? 'lydian' : 'major',
        origin: 'automatic',
        confidence: 0.9,
      },
      pitchShift: { semitones: 0, cents: 0 },
      analysis: { f0State: 'ready', failure: null, hopSec: 0.01 },
      render: { current: true, publishedRevision: 'r1', desiredRevision: 'r1' },
      timeGrid: { seeded: true, identity: true, handles: [], minHandleSpacingSec: 0.05 },
      autoModes: {
        editingScheme: 'openDyne',
        uiButtonRuns: 'regenerate',
        available: ['regenerate', 'snapNotes', 'notesOnly'],
      },
    });
  }
  if (method === 'content.autoTune') {
    if (mode === 'smoke-open-scale' && params.key?.scale !== 'chromatic') {
      return failure(id, 'INVALID_ARGUMENT', 'bad_params');
    }
    return result(autoResult(params));
  }
  return failure(id, 'UNSUPPORTED', 'capability_missing');
}

function serve() {
  const token = randomBytes(32).toString('hex');
  const serverProof = randomBytes(16).toString('hex');
  const instanceId = randomBytes(16).toString('hex');
  const server = net.createServer((socket) => {
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
        const request = JSON.parse(buffered.slice(0, at));
        buffered = buffered.slice(at + 1);
        const ok = request.method === 'session.hello' && request.params?.token === token;
        if (ok) socket.authed = true;
        const later = socket.authed && request.method !== 'session.hello';
        const quitting = quit && later && request.method === 'app.quit';
        const reply = quitting
          ? {
              jsonrpc: '2.0',
              id: request.id,
              result: {
                quitting: true,
                discardedUnsavedChanges: false,
                projectPath: null,
                nullReasons: { projectPath: 'no_project_path' },
                exitDeadlineMs: 5000,
                warnings: [],
              },
            }
          : smoke && later
            ? smokeReply(request)
            : effects !== undefined && later
              ? effects.reply(request)
              : arrangement !== undefined && later
                ? arrangement.reply(request)
                : ok
                  ? {
                      jsonrpc: '2.0',
                      id: request.id,
                      result: {
                        protocol: '1.0',
                        instanceId,
                        pid: process.pid,
                        serverProof: mode === 'bad-proof' ? randomBytes(16).toString('hex') : serverProof,
                        capabilities: smoke
                          ? smokeCapabilities()
                          : (effects?.capabilities ??
                            arrangement?.capabilities ??
                            (quit ? ['session.v1', 'app.quit'] : ['session.v1'])),
                        // A vector validates the whole result; the other modes only need the members the target reads.
                        ...(quit ? HELLO_REST : {}),
                      },
                    }
                  : { jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'UNAUTHENTICATED', data: {} } };
        socket.write(`${JSON.stringify(reply)}\n`, () => {
          // Ends by itself, without removing its discovery file, as a crash would.
          if (mode === 'exit-after-hello') process.exit(5);
          if (quitting) quitNow();
        });
      }
    });
    socket.on('error', () => {});
    sockets.add(socket);
  });
  const sockets = new Set();
  let discoveryFile;
  // What an instance does once it answered app.quit: no more connections, then the end of the process.
  const quitNow = () => {
    server.close();
    for (const socket of sockets) socket.destroy();
    if (mode === 'quit-stays') return;
    if (mode !== 'quit-no-cleanup') fs.rmSync(discoveryFile, { force: true });
    endWith('quit', mode === 'quit-bad-exit' ? 5 : 0);
  };
  server.listen({ host: '127.0.0.1', port: 0 }, () => {
    const dir = path.join(dataDir, 'control', 'instances');
    fs.mkdirSync(dir, { recursive: true });
    // For a test: where this instance's data folder is.
    if (dirFile !== undefined) fs.writeFileSync(dirFile, dataDir);
    // For a test: what the data folder held at the start (relative path to content), without what this
    // process writes itself.
    if (snapshotFile !== undefined) {
      const held = {};
      const walk = (rel) => {
        for (const entry of fs.readdirSync(path.join(dataDir, rel), { withFileTypes: true })) {
          const next = path.join(rel, entry.name);
          if (entry.isDirectory()) walk(next);
          else if (next !== 'ready.json')
            held[next.split(path.sep).join('/')] = fs.readFileSync(path.join(dataDir, next), 'utf8');
        }
      };
      walk('');
      fs.writeFileSync(snapshotFile, JSON.stringify(held));
    }
    // A log a test can look for in a kept data folder.
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'logs', 'opentune.log'), 'started\n');
    const discoveryPid = mode === 'pid-mismatch' ? process.pid + 1 : process.pid;
    const startedAt = Math.round(performance.timeOrigin);
    const discovery = {
      protocolMajors: [1],
      pid: discoveryPid,
      instanceId,
      port: server.address().port,
      token,
      serverProof,
      // bad-start: a start time the operating system does not confirm.
      processStartTimeMs: mode === 'bad-start' ? startedAt - 600_000 : startedAt,
      launchNonce: mode === 'bad-nonce' ? `${nonce}x` : nonce,
      appVersion: '0.0.0-fake',
      build: { commit: '0'.repeat(40), tag: null },
      buildTag: null,
      sourceUrl: 'https://github.com/synchain-oss/opentune-mcp-server',
      startedAtMs: Date.now(),
      flavor: 'standalone',
    };
    discoveryFile = path.join(dir, `${process.pid}.json`);
    fs.writeFileSync(discoveryFile, `${JSON.stringify(discovery)}\n`);
    fs.writeFileSync(`${readyFile}.tmp`, `${JSON.stringify({ pid: process.pid, instanceId })}\n`);
    fs.renameSync(`${readyFile}.tmp`, readyFile);
    process.on('SIGTERM', () => {
      if (mode !== 'no-cleanup') fs.rmSync(discoveryFile, { force: true });
      endWith('sigterm', 0);
    });
  });
}
