// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Two protections around a run against a real OpenTune, both built on scripts/e2e/settings-snapshot.mjs:
//
//  - guardDataDir: the settings files of the data folder the instance runs in (preferences with
//    onboardingShown, the JUCE settings with the audio device) are snapshotted before the instance
//    starts. When the run is over (whatever its outcome) they are compared with the snapshot, put back
//    byte for byte, and checked again. A difference is a FAIL that lists it; so is a restore that did
//    not work.
//  - watchUserSettings: the settings files of the real user's OpenTune folder are compared by size and
//    modification time before and after the run (never opened, never written). A change is a FAIL: the
//    run must not have touched the real settings. The log folder is not part of the comparison.

import {
  diffStats,
  settleSnapshot,
  takeSnapshot,
  userSettingsDir,
  watchStats,
  type SettingsSnapshot,
} from '../../scripts/e2e/settings-snapshot.mjs';

export interface SettingsGuard {
  /**
   * Takes the state the instance has once it is up (it writes its defaults into a fresh folder while it
   * starts); the run is judged against it, while the restore still goes back to the snapshot before the start.
   */
  settle(): Promise<void>;
  /** What OpenTune added to the folder (keys and files that were not there); known once finish() ran. Not a FAIL. */
  readonly appeared: readonly string[];
  /** Compares, restores and re-checks; the problems are FAIL lines. Runs once, later calls return the same lines. */
  finish(): Promise<readonly string[]>;
}

/** Takes the snapshot of the settings files of `dataDir`; call it after any template was copied and before the start. */
export async function guardDataDir(dataDir: string): Promise<SettingsGuard> {
  const snapshot: SettingsSnapshot = await takeSnapshot(dataDir);
  let done: Promise<readonly string[]> | undefined;
  let baseline: SettingsSnapshot | undefined;
  let appeared: readonly string[] = [];
  return {
    get appeared() {
      return appeared;
    },
    async settle() {
      baseline = await takeSnapshot(dataDir);
    },
    finish() {
      done ??= settleSnapshot(dataDir, snapshot, baseline).then(({ differences, appeared: added, problems }) => {
        appeared = added;
        return [
          ...(differences.length === 0
            ? []
            : [`the run changed the settings of its data folder (put back afterwards): ${differences.join('; ')}`]),
          ...problems,
        ];
      });
      return done;
    },
  };
}

/** Reads the settings files of the real user's folder (size and modification time only) and later compares. */
export async function watchUserSettings(
  dir: string | undefined = userSettingsDir(),
): Promise<{ finish(): Promise<readonly string[]> }> {
  const before = dir === undefined ? {} : await watchStats(dir);
  return {
    async finish() {
      if (dir === undefined) return [];
      const changes = diffStats(before, await watchStats(dir));
      return changes.length === 0
        ? []
        : [`the settings files of the real OpenTune folder changed during the run: ${changes.join('; ')}`];
    },
  };
}
