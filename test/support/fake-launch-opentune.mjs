// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// A stand-in for an OpenTune build with the control API, for the tests of opentune_launch. The
// tests start it with process.execPath and the command line opentune_launch builds. It reads the
// options of spec/otcp/v1/PROTOCOL.md section 6.3 as OpenTune does, writes its discovery file
// (section 5) and the ready file (section 5.5), and answers session.hello and session.info on
// 127.0.0.1. It writes only to the directory named by --control-api-dir= or OPENTUNE_DATA_DIR and
// exits without writing anything when neither is given, so it never touches a real OpenTune
// folder. Plain JavaScript, so that it runs on every supported Node.js without a build step.
//
// OT_FAKE_MODE selects the behaviour: `ready` (default), `silent` (runs, announces nothing),
// `other_nonce` (announces itself with another launch nonce), `no_nonce` (ignores the nonce and the
// ready file options, like a build without them) or `exit` (exits at once). It ends itself after
// OT_FAKE_LIFETIME_MS (default 20 s) so that no test can leave it running for long.

import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const mode = process.env.OT_FAKE_MODE ?? 'ready';
const lifetime = Number(process.env.OT_FAKE_LIFETIME_MS ?? 20_000);
setTimeout(() => process.exit(0), lifetime);

const option = (name) => {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return arg === undefined ? null : arg.slice(prefix.length);
};

if (mode === 'exit' || !process.argv.includes('--control-api')) process.exit(0);

const dataDir = process.env.OPENTUNE_DATA_DIR;
const dir = option('control-api-dir') ?? (dataDir ? path.join(dataDir, 'control', 'instances') : null);
if (dir === null) process.exit(2);

/** Writes through a temporary file and a rename, as the protocol requires. */
function writeAtomically(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(content)}\n`);
  renameSync(temp, file);
}

const instanceId = randomBytes(16).toString('hex');
const token = randomBytes(32).toString('hex');
const serverProof = randomBytes(16).toString('hex');
const nonce = option('control-api-launch-nonce');
const readyFile = option('control-api-ready-file');

const server = net.createServer((socket) => {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('error', () => undefined);
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const request = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      const reply = (result) => socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
      if (request.method === 'session.hello' && request.params?.token === token) {
        reply({
          protocol: '1.0',
          instanceId,
          pid: process.pid,
          serverProof,
          appVersion: '0.0.0-fake',
          capabilities: ['session.v1'],
        });
      } else if (request.method === 'session.info') {
        reply({
          appVersion: '0.0.0-fake',
          runtime: { os: process.platform, arch: process.arch },
          audioDevice: { running: false, name: null, sampleRateHz: null },
          processing: { editingScheme: 'notes', tuningHz: 440, vocoderReady: false },
        });
      } else {
        socket.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: request.id ?? null,
            error: { code: -32601, message: 'not implemented by the fake', data: { kind: 'UNSUPPORTED' } },
          })}\n`,
        );
      }
    }
  });
});

server.listen(0, '127.0.0.1', () => {
  if (mode === 'silent') return;
  const startedAtMs = Date.now();
  writeAtomically(path.join(dir, `${String(process.pid)}.json`), {
    protocolMajors: [1],
    pid: process.pid,
    processStartTimeMs: Math.round(performance.timeOrigin),
    instanceId,
    port: server.address().port,
    token,
    serverProof,
    launchNonce: mode === 'other_nonce' ? randomBytes(24).toString('base64url') : mode === 'no_nonce' ? null : nonce,
    appVersion: '0.0.0-fake',
    build: { commit: '0'.repeat(40), tag: null },
    buildTag: null,
    sourceUrl: 'https://github.com/synchain-oss/OpenTune',
    startedAtMs,
    flavor: 'standalone',
  });
  if (readyFile !== null && mode !== 'no_nonce') writeAtomically(readyFile, { pid: process.pid, instanceId });
});
