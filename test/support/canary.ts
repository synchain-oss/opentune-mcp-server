// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The token canary's detector: given the secrets of a run (generated at run time, never stored) and
// everything the bundle printed, report which secret showed up where. The report names the secret
// ("token") and the place, never the value, so a failing run does not leak the canary into logs.

export interface Output {
  /** Where the text came from, for the report: "stdout", "stderr", "doctor output" ... */
  readonly source: string;
  readonly text: string;
}

const HEX = /^(?:[0-9a-f]{2})+$/i;

/**
 * The forms of one secret to look for: as is, in the other letter case, a long prefix and suffix,
 * and the encodings a careless implementation might print (base64 and base64url without padding,
 * percent-encoding in both letter cases, hexadecimal of the text, and base64 of the bytes when the
 * secret is itself hexadecimal).
 */
export function secretForms(secret: string): string[] {
  if (secret.length < 16) throw new Error('a canary secret needs at least 16 characters to be searched for');
  const part = Math.min(16, Math.floor(secret.length / 2));
  const bytes = Buffer.from(secret, 'utf8');
  const encodings: Buffer[] = [bytes];
  if (HEX.test(secret)) encodings.push(Buffer.from(secret, 'hex'));
  const forms = [secret, secret.toLowerCase(), secret.toUpperCase(), secret.slice(0, part), secret.slice(-part)];
  for (const raw of encodings) {
    const base64 = raw.toString('base64').replace(/=+$/, '');
    forms.push(base64, raw.toString('base64url'), base64.replace(/\+/g, '%2B').replace(/\//g, '%2F'));
    forms.push(raw.toString('hex'), raw.toString('hex').toUpperCase());
  }
  const percent = encodeURIComponent(secret);
  if (percent !== secret) forms.push(percent, percent.toLowerCase());
  return [...new Set(forms)];
}

/** One line per (secret, output) pair where the output holds any form of the secret; empty when none does. */
export function findLeaks(secrets: Readonly<Record<string, string>>, outputs: readonly Output[]): string[] {
  const leaks: string[] = [];
  for (const [label, secret] of Object.entries(secrets)) {
    const forms = secretForms(secret);
    for (const output of outputs) {
      if (forms.some((form) => output.text.includes(form))) {
        leaks.push(`the ${label} appears in ${output.source}`);
      }
    }
  }
  return leaks;
}
