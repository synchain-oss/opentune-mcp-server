// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { cancelJobTool, getJobTool } from './jobs.js';
import type { ToolDefinition } from './registry.js';
import { getStatusTool } from './status.js';

/** Every tool, in the order tools/list reports them. */
export const TOOLS: readonly ToolDefinition[] = [getStatusTool, getJobTool, cancelJobTool];
