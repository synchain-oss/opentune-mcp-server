// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import type { GivenClip } from '../../mock/given.js';
import { clip } from './mock-client.js';

/** A ready clip whose notes were never generated, as the `clips` precondition describes it. */
export function clipWithoutNotes(extra: Partial<GivenClip> = {}): GivenClip {
  const given = Object.entries(clip(extra)).filter(([name]) => name !== 'notes');
  return Object.fromEntries(given) as unknown as GivenClip;
}
