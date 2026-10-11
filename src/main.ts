// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Entry point of the `opentune-mcp` bundle. Kept to wiring only: argument handling lives in
// cli/run.ts and the server in server.ts, both unit-tested; this file is exercised end to end
// by the stdio smoke test against the built bundle.

import { run } from './cli/run.js';
import { writeCliStdout } from './cli/stdout.js';
import { createLogger, stderrSink } from './log.js';
import { startStdioServer } from './server.js';

const logger = createLogger();

const exitCode = run(process.argv.slice(2), {
  writeStdout: writeCliStdout,
  writeStderr: stderrSink,
  serve: () => {
    startStdioServer({ logger });
  },
});

if (exitCode !== undefined) process.exitCode = exitCode;
