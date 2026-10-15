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
        const reply = ok
          ? {
              jsonrpc: '2.0',
              id: request.id,
              result: {
                protocol: '1.0',
                instanceId,
                pid: process.pid,
                serverProof: mode === 'bad-proof' ? randomBytes(16).toString('hex') : serverProof,
                capabilities: ['session.v1'],
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
