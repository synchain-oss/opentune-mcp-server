// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// One scripted session over every tool, errors included, for the protocol tests. The transport is
// the caller's: `call` runs one tool call over stdio and returns what came back.

export interface CallResult {
  readonly isError: boolean;
  readonly structured: Record<string, unknown> | undefined;
}

export type Call = (tool: string, args: Record<string, unknown>) => Promise<CallResult>;

/** What the mock was set up with, by name. */
export interface Fixture {
  readonly instanceId: string;
  readonly placement: string;
  readonly contentId: string;
  readonly runningJob: string;
  readonly savingJob: string;
  /** A WAV file the mock may import. */
  readonly audioFile: string;
  /** Ends the save job that runs for ever, so that nothing is unfinished when the instance is asked to quit. */
  readonly endSavingJob: () => void;
}

export interface Step {
  readonly tool: string;
  readonly expect: 'ok' | 'error';
}

const MISSING_JOB = 'j:00000000:99';

/**
 * Calls every tool at least once, with successful calls and the error paths that an agent hits
 * (bad arguments, a stale revision, an unknown job, a refused cancel, no OpenTune to start).
 * Returns the steps in order with what each was expected to do; throws when one did the other.
 */
export async function runAllTools(call: Call, f: Fixture): Promise<Step[]> {
  const steps: Step[] = [];
  const run = async (tool: string, args: Record<string, unknown>, expectation: 'ok' | 'error' = 'ok') => {
    const result = await call(tool, args);
    const actual = result.isError ? 'error' : 'ok';
    if (actual !== expectation) {
      throw new Error(`${tool} ${JSON.stringify(args).slice(0, 80)}: expected ${expectation}, got ${actual}`);
    }
    steps.push({ tool, expect: expectation });
    return result.structured ?? {};
  };
  const revision = async () => {
    const notes = await run('opentune_get_notes', { clip: f.placement, clock: 'content' });
    return notes.clip_revision as string;
  };

  await run('opentune_get_status', {});
  await run('opentune_get_status', { instance_id: f.instanceId });
  await run('opentune_get_status', { instance_id: '0'.repeat(32) }, 'error');
  await run('opentune_get_project', { include_history: true });
  await run('opentune_get_notes', { clip: f.placement, clock: 'timeline', from: 2, to: 5, limit: 2 });
  await run('opentune_get_clip_details', { clip: f.contentId });
  await run('opentune_get_settings', { log_lines: 20 });
  await run('opentune_analyze_pitch', { clip: f.placement });
  await run('opentune_analyze_pitch', { clip: f.placement, detail: 'notes', limit: 3 });
  await run('opentune_estimate_key', { clip: f.placement });
  await run('opentune_estimate_key', { clip: f.placement, mix_path: f.audioFile });
  await run('opentune_estimate_key', { mix_path: 'relative/mix.wav' }, 'error');

  await run('opentune_get_job', { job_id: f.runningJob });
  await run('opentune_get_job', { job_id: MISSING_JOB }, 'error');
  await run('opentune_get_job', { job_id: 'not a job id' }, 'error');
  await run('opentune_cancel_job', { job_id: f.runningJob });
  await run('opentune_cancel_job', { job_id: f.savingJob }, 'error');

  await run('opentune_autotune_range', {
    clip: f.placement,
    expected_revision: await revision(),
    mode: 'snapNotes',
    scale: { root: 0, scale: 'major' },
    dry_run: true,
  });
  await run('opentune_set_clip', {
    clip: f.placement,
    expected_revision: await revision(),
    pitch_shift: { semitones: 1, cents: 0 },
  });
  const edited = await run('opentune_edit_notes', {
    clip: f.placement,
    expected_revision: await revision(),
    ops: [{ op: 'shiftCents', select: { indices: [0] }, delta_cents: 25 }],
  });
  const undoId = (edited.undo as { undoId: string }).undoId;
  await run('opentune_undo', { undo_id: undoId });
  await run('opentune_redo', { undo_id: undoId });
  await run('opentune_edit_notes', { clip: f.placement, expected_revision: 'stale', ops: [] }, 'error');
  await run('opentune_edit_timing', {
    clip: f.placement,
    expected_revision: await revision(),
    ops: [{ op: 'shift', start_output_sec: 1.5, end_output_sec: 2.5, delta_ms: 100 }],
  });

  const arrangement = async () => (await run('opentune_get_project', {})).arrangement_revision as string;
  await run('opentune_edit_arrangement', {
    expected_revision: await arrangement(),
    ops: [{ op: 'gain', clip: f.placement, gain_db: -1 }],
  });
  await run(
    'opentune_edit_arrangement',
    {
      expected_revision: await arrangement(),
      ops: [{ op: 'delete', clips: [f.placement] }],
    },
    'error',
  );

  await run('opentune_open_audio', { path: f.audioFile, wait_seconds: 10 });
  await run('opentune_open_audio', { path: 'relative/take1.wav' }, 'error');
  await run('opentune_export_audio', { kind: 'clip', target: { clip: f.placement }, wait_seconds: 10 });
  await run('opentune_export_audio', { kind: 'master', path: 'C:\\Music\\export.mp3' }, 'error');
  // An instance runs, so a plain launch only reports it; asking for a second one needs the
  // executable, which is not configured for the bundle, so nothing starts and the result says why.
  await run('opentune_launch', {});
  await run('opentune_launch', { allow_second_instance: true });
  await run('opentune_set_settings', { processing: { tuning_hz: 442 }, wait_seconds: 10 });
  await run('opentune_set_settings', {}, 'error');
  // The vocoder weight, rendering priority and pitch model, and a weight the
  // installation does not list, which is refused with nothing changed.
  await run('opentune_set_settings', {
    processing: {
      vocoder_weight: 'hifigan_coulin9.onnx',
      rendering_priority: 'cpuFirst',
      f0_model: 'fcpe',
    },
    wait_seconds: 10,
  });
  await run('opentune_set_settings', { processing: { vocoder_weight: 'not-installed.onnx' } }, 'error');
  // Tracks, transport and window state. Deleting a track renumbers the later ones, so it comes after
  // the steps that use track ids.
  await run('opentune_set_tracks', {
    ops: [
      { op: 'mute', track_id: 1, on: true },
      { op: 'solo', track_id: 1, on: false },
      { op: 'volume', track_id: 1, db: -3 },
      { op: 'colour', track_id: 1, colour: '#336699' },
    ],
  });
  await run('opentune_set_tracks', { ops: [{ op: 'mute', track_id: 40, on: true }] }, 'error');
  const before = (await run('opentune_get_project', {})).arrangement_revision as string;
  await run('opentune_set_tracks', { ops: [{ op: 'reveal' }, { op: 'duplicate', track_id: 0, mode: 'share' }] });
  await run('opentune_delete_track', { track_id: 3, expected_revision: before, confirm: true }, 'error');
  const after = (await run('opentune_get_project', {})).arrangement_revision as string;
  await run('opentune_delete_track', { track_id: 3, expected_revision: after, confirm: false }, 'error');
  await run('opentune_delete_track', { track_id: 3, expected_revision: after, confirm: true });
  await run('opentune_transport', { action: 'seek', position_sec: 1 });
  await run('opentune_transport', { action: 'play' });
  await run('opentune_transport', { action: 'pause' });
  await run('opentune_transport', { action: 'play_from_last_start', bpm: 100, loop: true });
  await run('opentune_transport', { action: 'return_to_last_start' });
  await run('opentune_transport', { action: 'stop', time_signature: { numerator: 3, denominator: 4 } });
  await run('opentune_transport', { action: 'seek' }, 'error');
  await run('opentune_manage_ui', { op: 'focus_clip', clip: f.placement, dry_run: true });
  await run('opentune_manage_ui', { op: 'focus_clip', clip: f.placement, open_editor: true });
  await run('opentune_manage_ui', { op: 'focus_clip' }, 'error');
  // The piano roll is open now: close it, then ask for a view that does not exist.
  await run('opentune_manage_ui', { op: 'switch_view', view: 'arrangement' });
  await run('opentune_manage_ui', { op: 'switch_view', view: 'sideways' }, 'error');
  await run('opentune_manage_ui', { op: 'dismiss_dialogs' });
  await run('opentune_manage_ui', { op: 'dismiss_onboarding' });
  // Last: opening a project replaces the clips whose ids the steps above used.
  const project = f.audioFile.replace(/\.wav$/, '.otproj');
  const next = f.audioFile.replace(/\.wav$/, '-02.otproj');
  await run('opentune_save_project', { mode: 'save' }, 'error');
  await run('opentune_save_project', { mode: 'save_as', path: project, wait_seconds: 10 });
  await run('opentune_save_project', { mode: 'save', wait_seconds: 10 });
  await run('opentune_save_project', { mode: 'save_as', path: 'relative/take1.otproj' }, 'error');
  await run('opentune_save_project_overwrite', { path: project, confirm: false }, 'error');
  await run('opentune_save_project', { mode: 'save_as', path: next, wait_seconds: 10 });
  await run('opentune_save_project', { mode: 'save_as', path: project }, 'error');
  await run('opentune_save_project_overwrite', { path: project, confirm: true, wait_seconds: 10 });
  await run('opentune_open_project', { path: next, wait_seconds: 10 });
  await run('opentune_open_project', { path: project.replace('.otproj', '-missing.otproj') }, 'error');
  // Quitting ends the instance, so it is the very last step. The refusals come first: an instance that does not
  // exist, and the save job that is still unfinished.
  await run('opentune_quit', { instance_id: '0'.repeat(32) }, 'error');
  await run('opentune_quit', {}, 'error');
  f.endSavingJob();
  await run('opentune_quit', {});
  return steps;
}
