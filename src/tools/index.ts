// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { analyzePitchTool } from './analyze.js';
import { autotuneTool } from './autotune.js';
import { getClipDetailsTool } from './clip-details.js';
import { editNotesTool } from './edit-notes.js';
import { redoTool, undoTool } from './history.js';
import { cancelJobTool, getJobTool } from './jobs.js';
import { exportAudioTool } from './export-audio.js';
import { launchTool } from './launch.js';
import { getNotesTool } from './notes.js';
import { openAudioTool } from './open-audio.js';
import { getProjectTool } from './project.js';
import type { ToolDefinition } from './registry.js';
import { setClipTool } from './set-clip.js';
import { getSettingsTool } from './settings.js';
import { getStatusTool } from './status.js';
import { editTimingTool } from './timing.js';

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
  analyzePitchTool,
  openAudioTool,
  exportAudioTool,
  editTimingTool,
  getClipDetailsTool,
  getSettingsTool,
];
