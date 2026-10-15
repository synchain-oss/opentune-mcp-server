// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { autotuneTool } from './autotune.js';
import { editNotesTool } from './edit-notes.js';
import { redoTool, undoTool } from './history.js';
import { cancelJobTool, getJobTool } from './jobs.js';
import { launchTool } from './launch.js';
import { getNotesTool } from './notes.js';
import { getProjectTool } from './project.js';
import type { ToolDefinition } from './registry.js';
import { setClipTool } from './set-clip.js';
import { getStatusTool } from './status.js';

/** Every tool, in the order tools/list reports them. */
export const TOOLS: readonly ToolDefinition[] = [
  getStatusTool,
  getProjectTool,
  getNotesTool,
  getJobTool,
  cancelJobTool,
  launchTool,
  setClipTool,
  autotuneTool,
  editNotesTool,
  undoTool,
  redoTool,
];
