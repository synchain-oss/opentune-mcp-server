// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The retryability of the reasons for which the specification states one, by `<kind>/<reason>`. The
// server and the test mock read this one table, so neither repeats it. The built bundle cannot read
// spec/otcp/v1 at run time, so the values are kept here as constants; a unit test derives them from the
// specification again (the descriptions of registry/reasons.json that say "Retryable" or "Not
// retryable", and the table of PROTOCOL.md section 11) and fails when the two differ. Entries stay for the reasons
// that current servers no longer send (export_wait_timeout, export_stretch_dropped, vocoder_not_ready): an older
// server still does, and the value is the same.

export const REASON_RETRYABLE: Readonly<Record<string, boolean>> = Object.freeze({
  // PROTOCOL.md section 11, the readiness gate.
  'NOT_READY/f0_not_ready': true,
  'NOT_READY/f0_failed': false,
  'NOT_READY/f0_empty': false,
  'NOT_READY/notes_generating': true,
  // registry/reasons.json.
  'NOT_READY/grid_not_seeded': false,
  'INVALID_ARGUMENT/content_key_unset': false,
  'INVALID_ARGUMENT/nothing_to_export': false,
  'NOT_READY/export_dry_stretched': false,
  'NOT_READY/export_stretch_dropped': true,
  'NOT_READY/export_wait_timeout': true,
  'ANALYSIS_FAILED/timing_analysis_failed': false,
  'NOT_READY/timing_analysis_timeout': true,
  'UNSUPPORTED/no_editor_window': false,
  'INVALID_ARGUMENT/option_unavailable': false,
  'MODEL_UNAVAILABLE/vocoder_not_ready': true,
  'MODEL_UNAVAILABLE/vocoder_load_failed': false,
  // Reasons that specification 1.1.0 added (the reference implementation sends them; older servers never do).
  'NOT_FOUND/content_unavailable': false,
  // NOT_READY is retryable by default, but the reference implementation marks this reason not retryable explicitly.
  'NOT_READY/render_unavailable': false,
  'RENDER_FAILED/stretch_failed': false,
  'INTERNAL/editor_unavailable': false,
  'NOT_FOUND/track_not_found': false,
  'MODEL_UNAVAILABLE/vocoder_weight_rejected': false,
  'MODEL_UNAVAILABLE/backend_change_rejected': false,
});
