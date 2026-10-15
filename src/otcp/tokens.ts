// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Revision tokens as tools show them. OTCP keeps one token per aspect (spec/otcp/v1/PROTOCOL.md
// section 10: content revision, time-grid revision, key revision, placement geometry hash,
// arrangement revision). Tools return one opaque `clip_revision` per clip and one
// `arrangement_revision`, and take a single `expected_revision` back. A write forwards only the
// aspects the operation depends on, so a change of another aspect (for example the key, for an
// edit that does not use it) never causes a conflict (section 10 rule 4).

/** The aspects of a clip_revision. */
export type Aspect = 'content' | 'grid' | 'key' | 'geometry';

export type ClipTokens = Readonly<Record<Aspect, string | null>>;

const ASPECTS: readonly Aspect[] = ['content', 'grid', 'key', 'geometry'];

/** The OTCP params that carry each aspect's expected value. */
export const EXPECTED_PARAM: Readonly<Record<Aspect, string>> = {
  content: 'expectedRevision',
  grid: 'expectedGridRevision',
  key: 'expectedKeyRevision',
  geometry: 'expectedGeometryHash',
};

/** Aspects each OTCP method accepts expected values for. A unit test checks this against the method schemas. */
export const METHOD_ASPECTS: Readonly<Record<string, readonly Aspect[]>> = {
  'content.autoTune': ['content', 'key'],
  'content.editNotes': ['content', 'key'],
  'content.setKey': ['key'],
  'content.shiftTiming': ['grid'],
  'content.editTimeGrid': ['grid'],
};

const CLIP_PREFIX = 'cr1.';
const ARRANGEMENT_PREFIX = 'ar1.';

const toB64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
const fromB64 = (text: string): string | null =>
  /^[A-Za-z0-9_-]+$/.test(text) ? Buffer.from(text, 'base64url').toString('utf8') : null;

export function encodeClipRevision(tokens: ClipTokens): string {
  return CLIP_PREFIX + toB64(JSON.stringify(ASPECTS.map((a) => tokens[a])));
}

/** The tokens inside a clip_revision, or null when the value is not one this server issued. */
export function decodeClipRevision(value: string): ClipTokens | null {
  if (!value.startsWith(CLIP_PREFIX)) return null;
  const text = fromB64(value.slice(CLIP_PREFIX.length));
  let parts: unknown;
  try {
    parts = text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parts) || parts.length !== ASPECTS.length) return null;
  if (!parts.every((p) => p === null || (typeof p === 'string' && p.length > 0 && p.length <= 256))) return null;
  return Object.fromEntries(ASPECTS.map((a, i) => [a, parts[i] as string | null])) as ClipTokens;
}

export function encodeArrangementRevision(token: string): string {
  return ARRANGEMENT_PREFIX + toB64(token);
}

export function decodeArrangementRevision(value: string): string | null {
  if (!value.startsWith(ARRANGEMENT_PREFIX)) return null;
  const token = fromB64(value.slice(ARRANGEMENT_PREFIX.length));
  return token !== null && token.length > 0 && token.length <= 256 ? token : null;
}

/**
 * The expected-value params of `method` for the aspects an operation depends on. Throws for an
 * aspect the method does not accept or a token the clip_revision lacks: both are programming errors
 * of the calling tool, not user errors.
 */
export function expectedParams(method: string, tokens: ClipTokens, depends: readonly Aspect[]): Record<string, string> {
  const accepted = METHOD_ASPECTS[method] ?? [];
  const params: Record<string, string> = {};
  for (const aspect of depends) {
    if (!accepted.includes(aspect)) throw new Error(`${method} takes no expected value for the ${aspect} aspect`);
    const token = tokens[aspect];
    if (token === null) throw new Error(`the clip_revision has no ${aspect} token`);
    params[EXPECTED_PARAM[aspect]] = token;
  }
  return params;
}
