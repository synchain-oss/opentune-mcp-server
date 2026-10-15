// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The error for a path this server refuses before it reaches OpenTune. It is INVALID_ARGUMENT with
// the OTCP reason (spec/otcp/v1/registry/reasons.json), a detail that says which rule the path
// broke and never repeats the path (it may carry a home directory or text meant to steer an AI),
// and a next step that shows what to give instead. Nothing was executed.

import { toolError, type ToolError } from '../errors/tool-error.js';

const EXAMPLE = 'C:\\Music\\take1.wav on Windows, /home/user/take1.wav elsewhere';

const TEXT: Readonly<Record<string, { detail: string; step: string }>> = {
  path_not_absolute: {
    detail: 'is not an absolute path',
    step: `Give the full path of the file, for example ${EXAMPLE}. A relative path is never guessed. Ask the user for the full path if you do not have it.`,
  },
  path_unc: {
    detail: 'is a network (UNC) path, which OpenTune does not accept',
    step: 'Use a path on a local drive. Ask the user to copy the file to a local folder first if it lives on a network share.',
  },
  path_device_namespace: {
    detail: 'starts with a Windows device namespace prefix, which OpenTune does not accept',
    step: 'Give the ordinary drive path (for example C:\\Music\\take1.wav) without the \\\\?\\ or \\\\.\\ prefix.',
  },
  path_drive_relative: {
    detail: 'has a drive letter but is relative to the current folder of that drive',
    step: 'Give the full path with a backslash after the drive letter, for example C:\\Music\\take1.wav.',
  },
  path_alternate_stream: {
    detail: 'contains a colon after the drive, which would name an NTFS alternate data stream',
    step: 'Remove the colon and name the file itself.',
  },
  path_not_normalized: {
    detail: 'is not in normal form (empty, "." or ".." segments, a trailing dot or space, or mixed separators)',
    step: 'Give the path without "." or ".." segments, doubled separators, or a segment that ends in a dot or a space.',
  },
  path_reserved_name: {
    detail: 'contains a name Windows reserves for a device (CON, NUL, COM1 and similar)',
    step: 'Choose a different file name.',
  },
  path_invalid_character: {
    detail: 'contains a control character',
    step: 'Remove line breaks, tabs and other control characters from the path.',
  },
  path_bad_extension: {
    detail: 'does not have the required file extension',
    step: 'Give a file name with the extension the tool states in its description.',
  },
};

/** INVALID_ARGUMENT for a refused path; `what` names the argument (for example "path" or "items[2]"). */
export function pathRefusal(what: string, reason: string, extension?: string): ToolError {
  const known = TEXT[reason];
  const text = known ?? { detail: 'was refused', step: 'Give an absolute path of an ordinary local file.' };
  const extensionNote = reason === 'path_bad_extension' && extension !== undefined ? ` (${extension} only)` : '';
  return toolError('INVALID_ARGUMENT', {
    reason: known === undefined ? 'path_not_normalized' : reason,
    detail: `${what} ${text.detail}${extensionNote}`,
    nextStep: {
      actor: 'agent',
      message: `${text.step}${extension !== undefined && reason === 'path_bad_extension' ? ` Use ${extension}.` : ''}`,
    },
  });
}
