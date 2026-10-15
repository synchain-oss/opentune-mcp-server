// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { checkLaunchConfig, configuredOpentunePath, isUnfilledPlaceholder } from '../../src/launch/config.js';

const ENV = 'OPENTUNE_MCP_OPENTUNE_PATH';

describe('unsubstituted user-config placeholders', () => {
  it.each(['${user_config.opentune_path}', '  ${user_config.opentune_path} '])('%j is recognised', (value) => {
    expect(isUnfilledPlaceholder(value)).toBe(true);
    expect(configuredOpentunePath({ [ENV]: value })).toBeUndefined();
  });

  it.each([undefined, '', '/opt/OpenTune/OpenTune', String.raw`C:\Apps\${user_config}\OpenTune.exe`])(
    '%j is not a placeholder',
    (value) => {
      expect(isUnfilledPlaceholder(value)).toBe(false);
    },
  );

  it('is treated as not set, with a flag so doctor can say what to do', async () => {
    expect(await checkLaunchConfig({ [ENV]: '${user_config.opentune_path}' }, 'linux')).toEqual({
      state: 'unset',
      unfilledPlaceholder: true,
    });
    expect(await checkLaunchConfig({ [ENV]: '' }, 'linux')).toEqual({ state: 'unset' });
    expect(await checkLaunchConfig({}, 'linux')).toEqual({ state: 'unset' });
  });
});
