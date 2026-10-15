// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Entry point of the `opentune-mcp` bundle. Kept to wiring only: argument handling lives in
// cli/run.ts, the doctor checks in cli/doctor.ts and the server in server.ts, all unit-tested; this
// file is exercised end to end by the stdio tests against the built bundle.

import os from 'node:os';

import { doctorExitCode, formatDoctor, runDoctor } from './cli/doctor.js';
import { formatClientConfig } from './cli/client-config.js';
import { run } from './cli/run.js';
import { writeCliStdout } from './cli/stdout.js';
import { readOsRelease } from './launch/config.js';
import { createLogger, stderrSink } from './log.js';
import { startStdioServer } from './server.js';
import { VERSION } from './version.js';

const logger = createLogger();

const exitCode = run(process.argv.slice(2), {
  writeStdout: writeCliStdout,
  writeStderr: stderrSink,
  serve: () => {
    startStdioServer({ logger });
  },
  doctor: async (json) => {
    const checks = await runDoctor({
      env: process.env,
      platform: process.platform,
      home: os.homedir(),
      nodeVersion: process.version,
      osRelease: await readOsRelease(process.platform),
    });
    writeCliStdout(formatDoctor(checks, json));
    return doctorExitCode(checks);
  },
  clientConfig: (client, fullPaths) => {
    writeCliStdout(
      formatClientConfig(client, {
        env: process.env,
        platform: process.platform,
        home: os.homedir(),
        execPath: process.execPath,
        version: VERSION,
        fullPaths,
      }),
    );
    return 0;
  },
});

if (typeof exitCode === 'number') process.exitCode = exitCode;
else if (exitCode !== undefined) process.exitCode = await exitCode;
