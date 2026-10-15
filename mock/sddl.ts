// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Pure helpers that turn the trustees of an SDDL string (as `icacls /save` prints it) into SIDs.
// They call no tool and read no machine state: the SID of the current user is an argument, so the
// tests run them on every platform.

/**
 * Aliases that stand for one fixed SID on every machine (the SDDL SID strings of the Windows
 * documentation).
 */
const FIXED_ALIASES: Readonly<Record<string, string>> = {
  WD: 'S-1-1-0',
  CO: 'S-1-3-0',
  CG: 'S-1-3-1',
  OW: 'S-1-3-4',
  NU: 'S-1-5-2',
  IU: 'S-1-5-4',
  SU: 'S-1-5-6',
  AN: 'S-1-5-7',
  ED: 'S-1-5-9',
  PS: 'S-1-5-10',
  AU: 'S-1-5-11',
  RC: 'S-1-5-12',
  SY: 'S-1-5-18',
  LS: 'S-1-5-19',
  NS: 'S-1-5-20',
  WR: 'S-1-5-33',
  BA: 'S-1-5-32-544',
  BU: 'S-1-5-32-545',
  BG: 'S-1-5-32-546',
  PU: 'S-1-5-32-547',
  AO: 'S-1-5-32-548',
  SO: 'S-1-5-32-549',
  PO: 'S-1-5-32-550',
  BO: 'S-1-5-32-551',
  RE: 'S-1-5-32-552',
  RU: 'S-1-5-32-554',
  RD: 'S-1-5-32-555',
  NO: 'S-1-5-32-556',
  MU: 'S-1-5-32-558',
  IS: 'S-1-5-32-568',
  CY: 'S-1-5-32-569',
  ER: 'S-1-5-32-573',
  CD: 'S-1-5-32-574',
  ES: 'S-1-5-32-576',
  MS: 'S-1-5-32-577',
  HA: 'S-1-5-32-578',
  AA: 'S-1-5-32-579',
  RM: 'S-1-5-32-580',
  AC: 'S-1-15-2-1',
  LW: 'S-1-16-4096',
  ME: 'S-1-16-8192',
  MP: 'S-1-16-8448',
  HI: 'S-1-16-12288',
  SI: 'S-1-16-16384',
  SS: 'S-1-18-1',
};

/** Aliases that name a RID below the machine or domain SID, which is the prefix of the user's own SID. */
const RELATIVE_ALIASES: Readonly<Record<string, number>> = {
  LA: 500,
  LG: 501,
  DA: 512,
  DU: 513,
  DG: 514,
  DC: 515,
  DD: 516,
  CA: 517,
  SA: 518,
  EA: 519,
  PA: 520,
  RS: 553,
};

/** The `S-1-5-21-a-b-c` prefix of a machine or domain user SID, or undefined for any other form. */
function domainPrefix(userSid: string): string | undefined {
  return /^(S-1-5-21-\d+-\d+-\d+)-\d+$/.exec(userSid)?.[1];
}

/**
 * The SID a trustee of an SDDL access entry stands for: an explicit `S-1-...` SID is returned as
 * is, a fixed alias is looked up, and a machine- or domain-relative alias (LA, DA, ...) is
 * computed from the prefix of `userSid`. Returns undefined for an alias it does not know, and for
 * a relative alias when `userSid` is not of the `S-1-5-21-...` form.
 */
export function resolveTrustee(trustee: string, userSid: string): string | undefined {
  if (trustee.startsWith('S-1-')) return trustee;
  const fixed = FIXED_ALIASES[trustee];
  if (fixed !== undefined) return fixed;
  const rid = RELATIVE_ALIASES[trustee];
  const prefix = domainPrefix(userSid);
  return rid !== undefined && prefix !== undefined ? `${prefix}-${String(rid)}` : undefined;
}

/** The trustee field of every allow or deny entry in the SDDL text, in order of appearance. */
export function sddlTrusteeFields(sddl: string): string[] {
  return [...sddl.matchAll(/\((?:[AD]);[^;()]*;[^;()]*;[^;()]*;[^;()]*;([^;()]+)\)/g)].map((m) => m[1] ?? '');
}

/**
 * The SIDs, without duplicates and in order of appearance, that hold an entry other than
 * `userSid` itself in the SDDL text; an alias that resolves to `userSid` (LA for the built-in
 * administrator account running the process) is the user and not listed. Throws, naming the
 * alias, for a trustee that cannot be resolved: the caller must not guess which entries to keep.
 */
export function otherTrustees(sddl: string, userSid: string): string[] {
  const others = new Set<string>();
  for (const trustee of sddlTrusteeFields(sddl)) {
    const sid = resolveTrustee(trustee, userSid);
    if (sid === undefined) throw new Error(`unrecognised trustee ${trustee}`);
    if (sid.toLowerCase() !== userSid.toLowerCase()) others.add(sid);
  }
  return [...others];
}
