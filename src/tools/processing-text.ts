// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Fixed sentences about the vocoder and the rendering backend that opentune_get_status, opentune_launch,
// opentune_get_settings and opentune_set_settings share. They are composed from enumerated values only (the
// rendering priority gpuFirst or cpuFirst, the backend cpu, a flag); nothing OpenTune sent as text is put in them.

import { table } from '../render/text.js';

/**
 * What a vocoder that is not loaded can mean. OpenTune loads it when the first render needs it, so right after the
 * start it is not loaded and nothing is wrong. But session.info and prefs.get carry no member that tells "not loaded
 * yet" from "could not load" or "stuck" (`vocoderReady` is false in all three, and `vocoderReconfiguring` is false
 * unless a load is running), so the sentence must not call it normal: it says what to expect and what to do if it
 * does not come true.
 */
export const VOCODER_NOTE =
  'The vocoder is not loaded yet; it loads when the first render needs it. If it is still not loaded after a render, ' +
  'tell the user.';

/**
 * What each value of the rendering priority means and when it takes effect (opentune_get_settings, next to
 * options.renderingPriority). gpuFirst detects the GPU anew each time and tries it (DirectML on Windows); when
 * the session cannot be created OpenTune falls back to the CPU without a word, so the GPU is not guaranteed.
 * A change reloads the vocoder at once, which takes a few seconds, and renders nothing again, so the sound stays.
 */
export const RENDERING_PRIORITY_NOTES = table<string>({
  gpuFirst:
    'Tries the GPU (DirectML on Windows) each time the vocoder loads and falls back to the CPU when that fails, so ' +
    'the GPU is not guaranteed; processing.backend is what runs now. Takes effect at once: the vocoder reloads for a ' +
    'few seconds, nothing is rendered again and the sound stays as it is.',
  cpuFirst:
    'Always uses the CPU. Takes effect at once: the vocoder reloads for a few seconds, nothing is rendered again ' +
    'and the sound stays as it is.',
});

/** Where to look when the backend in use is not the one asked for. */
const WHERE =
  'To see why, read the log (opentune_get_settings with sections ["log"] and log_lines 30); "opentune-mcp doctor" ' +
  'checks Direct3D 12.';

/** The summary sentence of opentune_get_settings for gpuFirst with the CPU in use. */
export const GPU_FIRST_ON_CPU =
  'The rendering priority is gpuFirst but OpenTune is using the CPU: the GPU may be unavailable or have fallen back. ' +
  WHERE;

/** The sentence of opentune_set_settings after a change to gpuFirst that ended on the CPU. */
export const GPU_FIRST_REQUESTED_CPU_RUNS =
  'gpuFirst was requested, but OpenTune is now using the CPU: the GPU may be unavailable or have fallen back. ' + WHERE;

/** The sentence of opentune_set_settings when the vocoder was still reloading at the end of the wait. */
export const BACKEND_STILL_RELOADING =
  'The vocoder is still reloading, so which backend it uses is not known yet; read opentune_get_settings again in a ' +
  'few seconds.';

/**
 * The sentence of opentune_set_settings after a change to gpuFirst that read the CPU, when the vocoder was not ready
 * before the change. A job does not wait for a vocoder that was not ready (PROTOCOL.md section 12.7 rule 4), so it can
 * end before the vocoder has loaded again and the backend read afterwards may still be the old one: the fall back to
 * the CPU is not known, and is not claimed.
 */
export const BACKEND_NOT_CONFIRMED =
  'The vocoder was not ready when the setting changed, so it may not have loaded again yet: which backend it uses is ' +
  'only known after the next load, so read opentune_get_settings again once a render has run.';

/**
 * The sentence of opentune_set_settings after a change to gpuFirst that read the CPU, when session.info could not be
 * read before the change: whether the vocoder was ready then is not known, so whether the job waited for it is not
 * known either, and the fall back to the CPU is not claimed (BACKEND_NOT_CONFIRMED has the reasoning).
 */
export const BACKEND_NOT_CONFIRMED_STATE_UNKNOWN =
  'Whether the vocoder was ready when the setting changed could not be read, so it may not have loaded again yet: ' +
  'which backend it uses is only known after the next load, so read opentune_get_settings again once a render has run.';

/**
 * Whether the settings say gpuFirst with the CPU in use. Enumerated values only. The backend counts only while the
 * vocoder is loaded: a vocoder that is not loaded (or still reloading) can still report the backend from before, so no
 * fall back is concluded from it, the same rule opentune_set_settings applies after a change.
 */
export const gpuFirstOnCpu = (priority: unknown, backend: unknown, vocoderReady: unknown): boolean =>
  priority === 'gpuFirst' && backend === 'cpu' && vocoderReady === true;
