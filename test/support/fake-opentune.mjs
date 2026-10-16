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
// `smoke-no-export` does not report export.v1.
//
// Every copy that keeps running ends by itself once its OPENTUNE_DATA_DIR is gone, so a test that
// fails cannot leave one behind; with `--marker=<file>` it first writes how it ended to that file.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const option = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const mode = option('mode') ?? 'ok';
const readyFile = option('control-api-ready-file');
const nonce = option('control-api-launch-nonce');
const marker = option('marker');
const dataDir = process.env.OPENTUNE_DATA_DIR;

const smoke = mode.startsWith('smoke');

const endWith = (how, code) => {
  if (marker !== undefined) fs.writeFileSync(marker, how);
  process.exit(code);
};

const LAUNCHED = { launcher: 'ok', 'launcher-bad-start': 'bad-start' };
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
  ['session.v1', 'jobs.v1', 'read.v1', 'import.v1', 'edit.v1', 'export.v1'].filter(
    (c) => !(mode === 'smoke-no-export' && c === 'export.v1'),
  );

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
  undo: null,
  dirty: { before: false, after: true },
  ui: null,
  sideEffects: {},
  warnings: [],
  job,
});
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

function smokeReply(request) {
  const { id, method, params } = request;
  const result = (value) => ({ jsonrpc: '2.0', id, result: value });
  if (method === 'import.start') {
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
  if (method === 'job.get') {
    const job = jobs.get(params.jobId);
    if (job === undefined) return failure(id, 'NOT_FOUND', 'job_not_found');
    job.polls++;
    const base = { jobId: params.jobId, kind: job.kind, cancellable: false, createdAtMs: 0, updatedAtMs: 0 };
    if (job.polls < 2) {
      return result({
        job: { ...base, state: 'running', finishedAtMs: null, progress: null, result: null, error: null },
      });
    }
    let jobResult;
    if (job.kind === 'import') {
      jobResult = {
        ...envelope('r1'),
        items: [{ path: job.source, imported: true, contentId: CONTENT_ID, f0State: 'ready', error: null }],
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
      job: { ...base, state: 'succeeded', finishedAtMs: 1, progress: null, result: jobResult, error: null },
    });
  }
  if (method === 'content.getDetails') {
    return result({
      contentId: CONTENT_ID,
      analysis: { f0State: 'ready', failure: null, hopSec: 0.01 },
      key: { root: 0, scale: 'major', origin: 'automatic', confidence: 0.9 },
      asOf: { arrangementRevision: 'a1', contents: tokens('r1').contents },
    });
  }
  if (method === 'content.autoTune') {
    return result({
      ...envelope('r2'),
      mode: params.mode,
      keyUsed: params.key,
      paramsUsed: null,
      noteCount: 8,
      omittedCount: 0,
    });
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
        const reply =
          smoke && socket.authed && request.method !== 'session.hello'
            ? smokeReply(request)
            : ok
              ? {
                  jsonrpc: '2.0',
                  id: request.id,
                  result: {
                    protocol: '1.0',
                    instanceId,
                    pid: process.pid,
                    serverProof: mode === 'bad-proof' ? randomBytes(16).toString('hex') : serverProof,
                    capabilities: smoke ? smokeCapabilities() : ['session.v1'],
                  },
                }
              : { jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'UNAUTHENTICATED', data: {} } };
        socket.write(`${JSON.stringify(reply)}\n`, () => {
          // Ends by itself, without removing its discovery file, as a crash would.
          if (mode === 'exit-after-hello') process.exit(5);
        });
      }
    });
    socket.on('error', () => {});
  });
  server.listen({ host: '127.0.0.1', port: 0 }, () => {
    const dir = path.join(dataDir, 'control', 'instances');
    fs.mkdirSync(dir, { recursive: true });
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
    const discoveryFile = path.join(dir, `${process.pid}.json`);
    fs.writeFileSync(discoveryFile, `${JSON.stringify(discovery)}\n`);
    fs.writeFileSync(`${readyFile}.tmp`, `${JSON.stringify({ pid: process.pid, instanceId })}\n`);
    fs.renameSync(`${readyFile}.tmp`, readyFile);
    process.on('SIGTERM', () => {
      if (mode !== 'no-cleanup') fs.rmSync(discoveryFile, { force: true });
      endWith('sigterm', 0);
    });
  });
}
