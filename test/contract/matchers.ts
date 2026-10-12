// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Matchers and matching rules of spec/otcp/v1/vectors/README.md ("Matchers"): $any, $approx with
// $tol, $capture and $ref; objects match as subsets, arrays element by element, numbers by value.

/** The vector itself breaks the vector format; reported as a failure of the vector. */
export class InvalidVector extends Error {}

export type Bindings = Map<string, unknown>;

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)?$/;
const MATCHER_NAMES = new Set(['$any', '$approx', '$tol', '$capture', '$ref']);
const ANY_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const show = (value: unknown): string => {
  const text = value === undefined ? 'nothing' : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
};

/** True for an object whose member names all start with `$`. An object that mixes them with other names is invalid. */
export function isMatcher(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const names = Object.keys(value);
  const dollar = names.filter((n) => n.startsWith('$'));
  if (dollar.length === 0) return false;
  if (dollar.length !== names.length) {
    throw new InvalidVector(`an object mixes matcher names with member names: ${names.join(', ')}`);
  }
  return true;
}

function nameOf(matcher: Record<string, unknown>, key: '$capture' | '$ref'): string {
  const name = matcher[key];
  if (typeof name !== 'string' || !NAME_RE.test(name))
    throw new InvalidVector(`${key} needs a name, got ${show(name)}`);
  return name;
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case 'integer':
      return Number.isInteger(value);
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return typeof value === type;
  }
}

/** JSON equality: objects regardless of member order, numbers by value. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return a === b;
}

function matchMatcher(m: Record<string, unknown>, actual: unknown, bindings: Bindings, at: string): string[] {
  const unknown = Object.keys(m).find((n) => !MATCHER_NAMES.has(n));
  if (unknown !== undefined) throw new InvalidVector(`unknown matcher ${unknown}`);
  if ('$ref' in m) {
    if (Object.keys(m).length !== 1) throw new InvalidVector('$ref cannot be combined with other matchers');
    const name = nameOf(m, '$ref');
    if (!bindings.has(name)) throw new InvalidVector(`$ref to ${name}, which is not bound`);
    if (actual === undefined) return [`${at}: missing`];
    return jsonEqual(bindings.get(name), actual) ? [] : [`${at}: expected the value of ${name}, got ${show(actual)}`];
  }
  if ('$any' in m && ('$approx' in m || '$tol' in m)) throw new InvalidVector('$any cannot be combined with $approx');
  if ('$tol' in m && !('$approx' in m)) throw new InvalidVector('$tol needs $approx');
  if (actual === undefined) return [`${at}: missing`];
  const problems: string[] = [];
  if ('$any' in m) {
    const type = m.$any;
    if (type !== true && !(typeof type === 'string' && ANY_TYPES.has(type))) {
      throw new InvalidVector(`$any takes true or a JSON type, got ${show(type)}`);
    }
    if (typeof type === 'string' && !hasType(actual, type))
      problems.push(`${at}: expected any ${type}, got ${show(actual)}`);
  }
  if ('$approx' in m) {
    const x = m.$approx;
    const tol = m.$tol ?? 1e-6;
    if (typeof x !== 'number' || typeof tol !== 'number' || tol < 0)
      throw new InvalidVector('$approx and $tol take numbers');
    if (typeof actual !== 'number' || Math.abs(actual - x) > tol) {
      problems.push(`${at}: expected ${String(x)} within ${String(tol)}, got ${show(actual)}`);
    }
  }
  if ('$capture' in m) {
    const name = nameOf(m, '$capture');
    if (bindings.has(name)) throw new InvalidVector(`$capture binds ${name}, which is already bound`);
    if (problems.length === 0) bindings.set(name, actual);
  }
  return problems;
}

/**
 * Matches an actual value against an expected one (matching rules 1 and 2). Returns the
 * mismatches, empty when it matches; binds the names of `$capture` matchers that match.
 */
export function match(expected: unknown, actual: unknown, bindings: Bindings, at = '$'): string[] {
  if (isMatcher(expected)) return matchMatcher(expected, actual, bindings, at);
  if (actual === undefined) return [`${at}: missing`];
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${at}: expected an array, got ${show(actual)}`];
    if (actual.length !== expected.length) {
      return [`${at}: expected ${String(expected.length)} elements, got ${String(actual.length)}`];
    }
    return expected.flatMap((e, i) => match(e, actual[i], bindings, `${at}[${String(i)}]`));
  }
  if (isObject(expected)) {
    if (!isObject(actual)) return [`${at}: expected an object, got ${show(actual)}`];
    return Object.entries(expected).flatMap(([k, e]) =>
      match(e, Object.hasOwn(actual, k) ? actual[k] : undefined, bindings, `${at}.${k}`),
    );
  }
  return jsonEqual(expected, actual) ? [] : [`${at}: expected ${show(expected)}, got ${show(actual)}`];
}

/** A value to send with its `$ref` matchers replaced by the bound values. Other matchers are invalid there. */
export function resolve(value: unknown, bindings: Bindings): unknown {
  if (isMatcher(value)) {
    if (Object.keys(value).length !== 1 || !('$ref' in value))
      throw new InvalidVector('values to send may only contain $ref');
    const name = nameOf(value, '$ref');
    if (!bindings.has(name)) throw new InvalidVector(`$ref to ${name}, which is not bound`);
    return bindings.get(name);
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, bindings));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, bindings)]));
  return value;
}

/** The names a value refers to with `$ref` and binds with `$capture`. */
export function names(value: unknown, out = { refs: new Set<string>(), captures: new Set<string>() }) {
  if (Array.isArray(value)) for (const v of value) names(v, out);
  else if (isObject(value)) {
    if (typeof value.$ref === 'string') out.refs.add(value.$ref);
    if (typeof value.$capture === 'string') out.captures.add(value.$capture);
    for (const v of Object.values(value)) names(v, out);
  }
  return out;
}

/** End of the JSON value that starts at `i` (a string, object, array or literal). */
function valueEnd(text: string, i: number): number {
  let depth = 0;
  let inString = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (inString) {
      if (c === '\\') j++;
      else if (c === '"') {
        inString = false;
        if (depth === 0) return j + 1;
      }
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      if (depth === 0) return j;
      depth--;
      if (depth === 0) return j + 1;
    } else if (depth === 0 && (c === ',' || c === ' ' || c === '\t' || c === '\r' || c === '\n')) return j;
  }
  return text.length;
}

/**
 * The text of a top-level member's value exactly as the line writes it, or undefined. Used for
 * matching rule 4: a number id must be written as a plain integer literal.
 */
export function topLevelLiteral(text: string, member: string): string | undefined {
  let i = text.indexOf('{');
  if (i === -1) return undefined;
  const skip = () => {
    while (i < text.length && ' \t\r\n'.includes(text[i] ?? '')) i++;
  };
  i++;
  for (;;) {
    skip();
    if (text[i] !== '"') return undefined;
    const keyEnd = valueEnd(text, i);
    const key = JSON.parse(text.slice(i, keyEnd)) as string;
    i = keyEnd;
    skip();
    if (text[i] !== ':') return undefined;
    i++;
    skip();
    const end = valueEnd(text, i);
    if (key === member) return text.slice(i, end);
    i = end;
    skip();
    if (text[i] !== ',') return undefined;
    i++;
  }
}
