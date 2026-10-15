// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The OTCP v1 specification (spec/otcp/v1) as data for the test mock and the contract-vector
// runner: the method index, the registries and a JSON Schema 2020-12 validator over every schema
// file. Both read the specification at run time, so they follow it without generated code.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

/** spec/otcp/v1 of this repository. */
export const SPEC_ROOT = fileURLToPath(new URL('../../spec/otcp/v1/', import.meta.url));

/** Schema `$id`s are `https://otcp.invalid/v1/<path in spec/otcp/v1>` (methods/README.md). */
const ID_BASE = 'https://otcp.invalid/v1/';

export interface MethodInfo {
  readonly method: string;
  readonly capability: string;
  readonly since: string;
  /** false while the method is listed in methods/index.json but its schema file is not written yet. */
  readonly defined: boolean;
  /** x-otcp.valueCapabilities: params member -> value -> further capability. */
  readonly valueCapabilities: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** x-otcp.startsJob, or null. */
  readonly startsJob: string | null;
}

export interface ErrorKindInfo {
  readonly jsonrpcCode: number;
  readonly retryable: boolean;
}

export interface OtcpSpec {
  /** Every method of protocol major 1, by name. */
  readonly methods: ReadonlyMap<string, MethodInfo>;
  readonly errorKinds: ReadonlyMap<string, ErrorKindInfo>;
  /** Reason codes by `<scope>/<code>`, each with its own JSON-RPC code or null. */
  readonly reasons: ReadonlyMap<string, number | null>;
  /**
   * The methods that start each job kind (x-otcp.startsJob). A kind can have more than one: both
   * content.analyzeReference and content.autoTune (mode reference) start a referenceAnalysis job,
   * and each defines the result of the job it starts.
   */
  readonly jobStarters: ReadonlyMap<string, readonly string[]>;
  /**
   * Validates a value against the schema at `ref`, a path below spec/otcp/v1 with an optional
   * fragment (`methods/job.get.schema.json#/$defs/params`). Returns the problems; empty when valid.
   */
  validate(ref: string, value: unknown): string[];
  /** The JSON-RPC error code of a kind and reason (PROTOCOL.md section 17.2). */
  errorCode(kind: string, reason?: string): number;
}

interface IndexFile {
  methods: { method: string; capability: string; since: string; schema: string }[];
}
interface RegistryFile<T> {
  entries: (T & { code: string })[];
}
interface MethodFile {
  'x-otcp': {
    startsJob: string | null;
    valueCapabilities?: Record<string, Record<string, string>>;
  };
}

const readJson = (rel: string): unknown => JSON.parse(readFileSync(path.join(SPEC_ROOT, rel), 'utf8'));

function load(): OtcpSpec {
  // strict: false because the files carry annotations (x-otcp, examples) and union types that
  // strict mode reports; validation itself is unaffected.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const methodFiles = new Map<string, MethodFile>();
  for (const dir of ['schemas', 'methods']) {
    for (const name of readdirSync(path.join(SPEC_ROOT, dir))
      .filter((n) => n.endsWith('.schema.json'))
      .sort()) {
      const schema = readJson(`${dir}/${name}`) as MethodFile & Record<string, unknown>;
      ajv.addSchema(schema);
      if (dir === 'methods') methodFiles.set(name.slice(0, -'.schema.json'.length), schema);
    }
  }

  const methods = new Map<string, MethodInfo>();
  const jobStarters = new Map<string, string[]>();
  for (const entry of (readJson('methods/index.json') as IndexFile).methods) {
    const file = methodFiles.get(entry.method);
    const startsJob = file?.['x-otcp'].startsJob ?? null;
    methods.set(entry.method, {
      method: entry.method,
      capability: entry.capability,
      since: entry.since,
      defined: file !== undefined,
      valueCapabilities: file?.['x-otcp'].valueCapabilities ?? {},
      startsJob,
    });
    if (startsJob !== null) jobStarters.set(startsJob, [...(jobStarters.get(startsJob) ?? []), entry.method]);
  }

  const errorKinds = new Map<string, ErrorKindInfo>(
    (readJson('registry/error-kinds.json') as RegistryFile<ErrorKindInfo>).entries.map((e) => [
      e.code,
      { jsonrpcCode: e.jsonrpcCode, retryable: e.retryable },
    ]),
  );
  const reasons = new Map<string, number | null>(
    (readJson('registry/reasons.json') as RegistryFile<{ scope: string; jsonrpcCode?: number }>).entries.map((e) => [
      `${e.scope}/${e.code}`,
      e.jsonrpcCode ?? null,
    ]),
  );

  const validators = new Map<string, ValidateFunction>();
  return {
    methods,
    errorKinds,
    reasons,
    jobStarters,
    validate(ref, value) {
      let validator = validators.get(ref);
      if (validator === undefined) {
        validator = ajv.getSchema(`${ID_BASE}${ref}`);
        if (validator === undefined) throw new Error(`no schema at ${ref}`);
        validators.set(ref, validator);
      }
      if (validator(value)) return [];
      return (validator.errors ?? []).map((e) => `${e.instancePath === '' ? '/' : e.instancePath} ${e.message ?? ''}`);
    },
    errorCode(kind, reason) {
      const own = reason === undefined ? undefined : reasons.get(`${kind}/${reason}`);
      if (own !== undefined && own !== null) return own;
      const info = errorKinds.get(kind);
      if (info === undefined) throw new Error(`unregistered error kind ${kind}`);
      return info.jsonrpcCode;
    },
  };
}

let cached: OtcpSpec | undefined;

/** The specification, loaded once per process. */
export function otcpSpec(): OtcpSpec {
  cached ??= load();
  return cached;
}
