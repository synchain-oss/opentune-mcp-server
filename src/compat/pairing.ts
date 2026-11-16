// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Which OpenTune builds this version of the server was checked with, and whether a running build is one of them.
// The list is compatibility.json (bundled into the server; docs/COMPATIBILITY.md and the README box are generated
// from the same file). A running build is recognised by what it reports about itself in the discovery file and in
// session.hello / session.info: the commit it was built from (`build.commit`) or a tag (`build.tag`, `buildTag`).
// The version alone never identifies a build: a build of the source between two releases reports the version of
// the next one, and every test build reports the version it was based on.
//
// This is a warning and never a refusal: a build that is not listed may work, because every tool reads what the
// build says instead of guessing from a version. The text here is fixed; the strings a build reports appear in the
// results only as values.

import compatibilityFile from '../../compatibility.json' with { type: 'json' };
import type { DiscoveryEntry } from '../discovery/file.js';
import { compatibilityUrl } from '../errors/next-step.js';
import type { NextStep } from '../errors/tool-error.js';

export interface ListedBuild {
  readonly kind: 'testBuild' | 'official' | 'upstreamSource';
  readonly tag?: string;
  readonly version?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly appVersion?: string;
  readonly platforms?: readonly string[];
  readonly verified: boolean;
  readonly note: string;
}

export interface CompatibilityRecord {
  /** A version of this server, or "unreleased" for the one being prepared. */
  readonly server: string;
  readonly spec: string;
  readonly specReleased?: boolean;
  /** True when this version of the server reports the pairing (the older records leave it out). */
  readonly runtimeCheck?: boolean;
  readonly opentune: readonly ListedBuild[];
}

/** Every record of compatibility.json, oldest first. A unit test validates the file with scripts/compat.mjs. */
export const RECORDS: readonly CompatibilityRecord[] = (
  compatibilityFile as unknown as { readonly records: readonly CompatibilityRecord[] }
).records;

/** The record this build of the server is checked against: the newest one (the release process names it). */
export function currentRecord(records: readonly CompatibilityRecord[] = RECORDS): CompatibilityRecord {
  const newest = records[records.length - 1];
  if (newest === undefined) throw new Error('compatibility.json has no records');
  return newest;
}

/** What a running OpenTune reports about its build. */
export interface BuildIdentity {
  readonly appVersion: string;
  /** 40 hexadecimal digits; all zeros when the build does not know its commit. */
  readonly commit: string;
  readonly tag: string | null;
  readonly buildTag: string | null;
}

const nonEmpty = (s: string | null): string | null => (s === null || s === '' ? null : s);

/** The identity in a discovery file (checked against the schema, and verified against the instance by session.hello). */
export function identityOf(entry: DiscoveryEntry): BuildIdentity {
  return {
    appVersion: entry.appVersion,
    commit: entry.build.commit,
    tag: nonEmpty(entry.build.tag),
    buildTag: nonEmpty(entry.buildTag),
  };
}

const NO_COMMIT = /^0{40}$/;

export type MatchedBy = 'commit' | 'tag';

/** The first listed build that the identity names by its commit or by a tag, or null. */
export function matchBuild(
  identity: BuildIdentity,
  builds: readonly ListedBuild[],
): { readonly build: ListedBuild; readonly by: MatchedBy } | null {
  const commit = NO_COMMIT.test(identity.commit) ? null : identity.commit.toLowerCase();
  const tags = [identity.tag, identity.buildTag].filter((t) => t !== null);
  for (const build of builds) {
    if (commit !== null && build.commit !== undefined && commit.startsWith(build.commit))
      return { build, by: 'commit' };
    if (build.tag !== undefined && tags.includes(build.tag)) return { build, by: 'tag' };
  }
  return null;
}

export const PAIRING_STATUSES = ['tested', 'listed_not_verified', 'not_listed', 'unidentified'] as const;
export type PairingStatus = (typeof PAIRING_STATUSES)[number];

export interface Pairing {
  readonly status: PairingStatus;
  /** The record the build was compared with: a version of this server, or "unreleased". */
  readonly record: string;
  /** The listed build the running one is, or null. */
  readonly listed: {
    readonly kind: ListedBuild['kind'];
    readonly ref: string;
    readonly verified: boolean;
    readonly matchedBy: MatchedBy;
  } | null;
  readonly message: string;
  /** For a build that is not listed or not identified: what to tell the user. Never a refusal. */
  readonly nextStep?: NextStep;
  /** Where the list is explained; absent for a build that was checked. */
  readonly url?: string;
}

const URL_ANCHOR = 'checking-the-build-you-run';

export const PAIRING_TEXT: Readonly<Record<PairingStatus, string>> = {
  tested: 'This OpenTune build is one of the builds this version of the server was checked with.',
  listed_not_verified:
    'This OpenTune build is listed for this version of the server, but it has not been verified against a real build yet.',
  not_listed:
    'This OpenTune build is not in the list of builds this version of the server was checked with. It may still work, ' +
    'because the server reads what each result says, but nobody has checked it.',
  unidentified:
    'This OpenTune build does not say which source it was built from (no commit and no tag), so the server cannot ' +
    'tell whether it is in the list of builds this version of the server was checked with. A build made from a git ' +
    'checkout reports its commit.',
};

/** Tell the user, keep working: a build that is not listed is a warning, never a refusal. */
const warn = (what: string): NextStep => ({
  actor: 'user',
  message:
    `Continue with the user's request; this is a warning, not a refusal. Tell the user once that ${what}. The list of ` +
    'builds that go with this version of the server is in docs/COMPATIBILITY.md. If a tool fails in a way that makes no ' +
    'sense, the build is the first thing to suspect, and switching to a listed build is the fix.',
});

const STEPS: Readonly<Partial<Record<PairingStatus, NextStep>>> = {
  not_listed: warn('this OpenTune build is not in the list of builds this server was checked with'),
  unidentified: warn(
    'this OpenTune build does not say which source it was built from, so it cannot be compared with the list of ' +
      'builds this server was checked with',
  ),
};

const shortRef = (build: ListedBuild): string =>
  build.tag ?? build.version ?? (build.commit === undefined ? build.kind : build.commit.slice(0, 7));

/** Compares a running build with the builds of `record` (the newest by default). */
export function pairingFor(identity: BuildIdentity, record: CompatibilityRecord = currentRecord()): Pairing {
  const found = matchBuild(identity, record.opentune);
  let status: PairingStatus;
  if (found !== null) status = found.build.verified ? 'tested' : 'listed_not_verified';
  else
    status =
      NO_COMMIT.test(identity.commit) && identity.tag === null && identity.buildTag === null
        ? 'unidentified'
        : 'not_listed';
  const step = STEPS[status];
  return {
    status,
    record: record.server,
    listed:
      found === null
        ? null
        : { kind: found.build.kind, ref: shortRef(found.build), verified: found.build.verified, matchedBy: found.by },
    message: PAIRING_TEXT[status],
    ...(step === undefined ? {} : { nextStep: step }),
    ...(status === 'tested' ? {} : { url: compatibilityUrl(URL_ANCHOR) }),
  };
}

/** A warning for a status result, or null when the build was checked or is listed. */
export function pairingWarning(
  instanceId: string,
  pairing: Pairing,
): { code: string; instanceId: string; message: string; nextStep: NextStep; url: string } | null {
  const { status, nextStep, url } = pairing;
  if (nextStep === undefined || url === undefined) return null;
  return {
    code: status === 'not_listed' ? 'BUILD_NOT_LISTED' : 'BUILD_NOT_IDENTIFIED',
    instanceId,
    message: pairing.message,
    nextStep,
    url,
  };
}
