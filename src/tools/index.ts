// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { analyzePitchTool } from './analyze.js';
import { cancelJobTool, getJobTool } from './jobs.js';
import { launchTool } from './launch.js';
import { getNotesTool } from './notes.js';
import { getProjectTool } from './project.js';
import type { ToolDefinition } from './registry.js';
import { getStatusTool } from './status.js';

/** Every tool, in the order tools/list reports them. */
export const TOOLS: readonly ToolDefinition[] = [
  getStatusTool,
  getProjectTool,
  getNotesTool,
  getJobTool,
  cancelJobTool,
  launchTool,
  analyzePitchTool,
];
