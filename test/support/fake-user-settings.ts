// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// A made-up "real user" settings location for unit tests that run an e2e scenario in a child process
// against a fake executable. The scenario watches the real user's OpenTune folders (see
// test/support/settings-guard.ts); a child that inherits the real environment reads the machine's own
// folders, so the result would depend on whether OpenTune was ever installed there (a CI runner has no such
// folder, and the watch step is then a SKIP). With these variables the child watches a folder made here.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { userSettingsDirs } from '../../scripts/e2e/settings-snapshot.mjs';

/**
 * Creates a user settings folder below `dir` with one `app-preferences.settings` file in it and returns the
 * environment variables that make `userSettingsDirs` point there (on every platform).
 */
export async function fakeUserSettingsEnv(dir: string): Promise<Record<string, string>> {
  const roaming = path.join(dir, 'fake-user', 'Roaming');
  const local = path.join(dir, 'fake-user', 'Local');
  const config = path.join(dir, 'fake-user', 'config');
  const state = path.join(dir, 'fake-user', 'state');
  const env: Record<string, string> = {
    APPDATA: roaming,
    LOCALAPPDATA: local,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    HOME: path.join(dir, 'fake-user', 'home'),
    USERPROFILE: path.join(dir, 'fake-user', 'home'),
  };
  const [first] = userSettingsDirs(env);
  if (first === undefined) throw new Error('the fake user settings environment names no folder');
  await mkdir(first, { recursive: true });
  await writeFile(path.join(first, 'app-preferences.settings'), '<PROPERTIES/>\n', 'utf8');
  return env;
}
