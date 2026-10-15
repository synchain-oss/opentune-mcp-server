// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Reading one discovery file (spec/otcp/v1/PROTOCOL.md sections 5.3 and 5.4 rule 4). The file is
// checked against the open form of spec/otcp/v1/schemas/discovery-file.schema.json
// (`$defs/knownMembers`): every member this version defines must be present with its type and form,
// and members a later version adds are ignored. A unit test compares this check with the schema.

/** Largest discovery file a client accepts. */
export const MAX_DISCOVERY_BYTES = 8192;

/** Names of discovery files; temporary files and anything else in the directory are ignored. */
export const DISCOVERY_FILE_RE = /^[1-9][0-9]*\.json$/;

export interface DiscoveryEntry {
  readonly protocolMajors: readonly number[];
  readonly pid: number;
  readonly processStartTimeMs: number;
  readonly instanceId: string;
  readonly port: number;
  /** Secret. Sent in session.hello and nowhere else: never in results, errors, logs or doctor output. */
  readonly token: string;
  /** Secret-like: compared with the session.hello result and never shown. */
  readonly serverProof: string;
  readonly launchNonce: string | null;
  readonly appVersion: string;
  readonly build: { readonly commit: string; readonly tag: string | null };
  readonly buildTag: string | null;
  readonly sourceUrl: string;
  readonly startedAtMs: number;
}

export type ParsedFile =
  { readonly ok: true; readonly entry: DiscoveryEntry } | { readonly ok: false; readonly problem: string };

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
/** Length in code points, as JSON Schema counts it. */
const codePoints = (s: string) => Array.from(s).length;
const isStr = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && codePoints(v) >= min && codePoints(v) <= max;
const matches = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v);
const nullOr = (v: unknown, check: (x: unknown) => boolean) => v === null || check(v);

const HEX128 = /^[0-9a-f]{32}$/;
const SECRET = /^(?:[0-9a-f]{2}){16,64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** The member checks of `$defs/knownMembers`, in schema order. */
const MEMBERS: readonly (readonly [string, (v: unknown) => boolean])[] = [
  [
    'protocolMajors',
    (v) => Array.isArray(v) && v.length > 0 && v.every((m) => isInt(m, 1)) && new Set(v).size === v.length,
  ],
  ['pid', (v) => isInt(v, 1)],
  ['processStartTimeMs', (v) => isInt(v, 0)],
  ['instanceId', (v) => matches(v, HEX128)],
  ['port', (v) => isInt(v, 1, 65535)],
  ['token', (v) => matches(v, SECRET)],
  ['serverProof', (v) => matches(v, HEX128)],
  ['launchNonce', (v) => nullOr(v, (x) => matches(x, NONCE))],
  ['appVersion', (v) => isStr(v, 1, 64)],
  [
    'build',
    // buildInfo is a closed definition in common.schema.json, also inside the open knownMembers.
    (v) =>
      isObject(v) &&
      Object.keys(v).every((key) => key === 'commit' || key === 'tag') &&
      matches(v.commit, COMMIT) &&
      'tag' in v &&
      nullOr(v.tag, (x) => isStr(x, 0, 200)),
  ],
  ['buildTag', (v) => nullOr(v, (x) => isStr(x, 0, 200))],
  ['sourceUrl', (v) => matches(v, /^https:\/\//)],
  ['startedAtMs', (v) => isInt(v, 0)],
  ['flavor', (v) => v === 'standalone'],
];

/** Validates parsed file content against the open schema form; returns the first problem or null. */
export function knownMembersProblem(value: unknown): string | null {
  if (!isObject(value)) return 'not a JSON object';
  for (const [name, check] of MEMBERS) {
    if (!(name in value)) return `member ${name} is missing`;
    if (!check(value[name])) return `member ${name} has the wrong type or form`;
  }
  return null;
}

/** Parses `<pid>.json`. Problems never quote the content, which holds the token. */
export function parseDiscoveryFile(fileName: string, bytes: Buffer): ParsedFile {
  if (bytes.length > MAX_DISCOVERY_BYTES)
    return { ok: false, problem: `larger than ${String(MAX_DISCOVERY_BYTES)} bytes` };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, problem: 'not valid UTF-8 JSON' };
  }
  const problem = knownMembersProblem(value);
  if (problem !== null) return { ok: false, problem };
  const v = value as Json & DiscoveryEntry;
  if (`${String(v.pid)}.json` !== fileName) return { ok: false, problem: 'pid differs from the file name' };
  return {
    ok: true,
    entry: {
      protocolMajors: v.protocolMajors,
      pid: v.pid,
      processStartTimeMs: v.processStartTimeMs,
      instanceId: v.instanceId,
      port: v.port,
      token: v.token,
      serverProof: v.serverProof,
      launchNonce: v.launchNonce,
      appVersion: v.appVersion,
      build: { commit: v.build.commit, tag: v.build.tag },
      buildTag: v.buildTag,
      sourceUrl: v.sourceUrl,
      startedAtMs: v.startedAtMs,
    },
  };
}
