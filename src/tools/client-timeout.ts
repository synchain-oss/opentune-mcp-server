// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// How long a client waits for a result. The tools whose call can run for a long time (opentune_edit_timing with many
// operations, opentune_get_notes with output_path) keep their own work inside it: a result that arrives later is lost,
// and with it what the call did (a revision, a file nobody knows about).

/**
 * How long a client waits for a result before it gives up: 60 seconds is the usual default, and a result that
 * arrives later is lost together with the clip_revision or the file path it carries.
 */
export const CLIENT_TIMEOUT_MS = 60_000;
