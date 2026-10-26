// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// Runs one OTCP test vector (spec/otcp/v1/vectors/README.md) against a target over TCP: request
// vectors and multi-step scenarios, every send and expect step, matchers, `given`, the capability
// and `since` filters, and the checks the format asks of runners beyond matching (the id literal
// of matching rule 4, results against the method's result schema, errors against section 17).

import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { otcpSpec, type OtcpSpec } from '../support/otcp-spec.js';
import { RunnerConnection } from './connection.js';
import { InvalidVector, isObject, match, names, redact, resolve, topLevelLiteral, type Bindings } from './matchers.js';
import { PreconditionUnavailable, type ContractTarget, type TargetInstance } from './target.js';
import type { Step, Vector } from './vectors.js';

export interface Outcome {
  readonly id: string;
  readonly result: 'PASS' | 'FAIL' | 'SKIP';
  readonly note: string;
  /** Set when the instance itself sent an error with data.reason modal_open (not when a vector merely expects one). */
  readonly receivedModalOpen?: true;
}

export interface RunOptions {
  /** How long an expect step waits for its line; 10 s unless given. */
  readonly readTimeoutMs?: number;
  /** How long a vector that ends the instance waits for a close and for the end; 15 s unless given. */
  readonly endWaitMs?: number;
}

/** The instance did not behave as the vector expects. */
class VectorFailure extends Error {}

const CLIENT = { name: 'otcp-vector-runner', version: '1.0.0' };
const RUNNER_PROTOCOL = '1.0';
const HELLO_ID = 'otcp-runner-hello';
const PROBE_ID = 'otcp-runner-probe';
/** How long an expect step waits for its line. */
const READ_TIMEOUT_MS = 10_000;
/** expectClosed without withinMs, and connectionAfter closed. */
const CLOSE_WAIT_MS = 5000;
/**
 * The same waits in a vector that ends the instance, and how long after its last step the instance
 * has to be gone (vectors/README.md, "Vectors that end the instance").
 */
const END_WAIT_MS = 15_000;
/** How often the port is tried while it is expected to refuse connections. */
const PORT_POLL_MS = 50;
const PLAIN_INTEGER_RE = /^(0|[1-9][0-9]*)$/;

const versionNumbers = (v: string) => v.split('.').map(Number);
const newerThan = (a: string, b: string) => {
  const [aMajor = 0, aMinor = 0] = versionNumbers(a);
  const [bMajor = 0, bMinor = 0] = versionNumbers(b);
  return aMajor !== bMajor ? aMajor > bMajor : aMinor > bMinor;
};

const isRequestId = (id: unknown): id is string | number => typeof id === 'string' || typeof id === 'number';
const idKey = (id: string | number) => `${typeof id}:${String(id)}`;

/** Whether an expected line is an error response with data.reason modal_open. */
function expectsModalOpen(expected: unknown): boolean {
  return (
    isObject(expected) &&
    isObject(expected.error) &&
    isObject(expected.error.data) &&
    expected.error.data.reason === 'modal_open'
  );
}

/** State of one vector run: bindings, connections, and the requests sent on each connection. */
class Run {
  readonly connections = new Map<string, RunnerConnection>();
  /** Per connection and request id, the methods of the requests sent, oldest first. */
  readonly #sent = new Map<string, Map<string, string[]>>();
  /** The method that started each job seen so far, by jobId. */
  readonly #jobStartedBy = new Map<string, string>();
  #stepEnd = performance.now();
  /** Whether a line the instance sent was an error whose data.reason is modal_open. */
  receivedModalOpen = false;

  constructor(
    readonly instance: TargetInstance,
    readonly spec: OtcpSpec,
    readonly bindings: Bindings,
    readonly readTimeoutMs: number,
    /** How long a wait for a close takes where the vector gives none. */
    readonly closeWaitMs: number = CLOSE_WAIT_MS,
  ) {}

  async connect(name: string): Promise<RunnerConnection> {
    if (this.connections.has(name)) throw new InvalidVector(`connection ${name} is opened twice`);
    const conn = await RunnerConnection.open(Number(this.instance.discovery.port));
    this.connections.set(name, conn);
    return conn;
  }

  conn(name: string): RunnerConnection {
    const conn = this.connections.get(name);
    if (conn === undefined) throw new InvalidVector(`step on connection ${name}, which is not open`);
    return conn;
  }

  /** Records the end of a step: the reference point of expectClosed. */
  markStep(): void {
    for (const conn of this.connections.values()) conn.bytesAtStepEnd = conn.receivedBytes;
    this.#stepEnd = performance.now();
  }

  #record(name: string, message: unknown): void {
    if (!isObject(message) || !isRequestId(message.id) || typeof message.method !== 'string') return;
    let byId = this.#sent.get(name);
    if (byId === undefined) this.#sent.set(name, (byId = new Map<string, string[]>()));
    const key = idKey(message.id);
    byId.set(key, [...(byId.get(key) ?? []), message.method]);
  }

  /** The method of the oldest request sent on the connection with this id, consumed by its response. */
  #methodFor(name: string, id: unknown): string | undefined {
    if (!isRequestId(id)) return undefined;
    const pending = this.#sent.get(name)?.get(idKey(id));
    return pending?.shift();
  }

  sendBytes(name: string, bytes: Buffer): void {
    for (const line of bytes.toString('utf8').split('\n').slice(0, -1)) {
      try {
        this.#record(name, JSON.parse(line));
      } catch {
        // malformed on purpose; nothing to record
      }
    }
    this.conn(name).write(bytes);
  }

  sendValue(name: string, value: unknown): void {
    this.sendBytes(name, Buffer.from(`${JSON.stringify(resolve(value, this.bindings))}\n`, 'utf8'));
  }

  /** Reads the next line on the connection and matches it; throws VectorFailure on a mismatch. */
  async expect(name: string, expected: unknown): Promise<void> {
    const line = await this.conn(name).readLine(this.readTimeoutMs);
    if (line === 'closed')
      throw new VectorFailure(`${name}: the server closed the connection instead of sending a line`);
    if (line === 'timeout') {
      // Whole, not cut short: runVector redacts the secrets from the note it ends up in.
      throw new VectorFailure(
        `${name}: no line within ${String(this.readTimeoutMs)} ms; expected ${JSON.stringify(expected)}`,
      );
    }
    const { framingProblem } = this.conn(name);
    if (framingProblem !== undefined) throw new VectorFailure(`${name}: ${framingProblem}`);
    const text = line.toString('utf8');
    let actual: unknown;
    try {
      actual = JSON.parse(text);
    } catch {
      // Redacted before it is cut short, so that no part of a secret survives the cut.
      throw new VectorFailure(
        `${name}: the server sent a line that is not JSON: ${redact(text, this.bindings).slice(0, 200)}`,
      );
    }
    if (isObject(actual) && isObject(actual.error) && isObject(actual.error.data)) {
      // A step that itself expects modal_open does not count: the vector asked for it.
      if (actual.error.data.reason === 'modal_open' && !expectsModalOpen(expected)) this.receivedModalOpen = true;
    }
    const problems = match(expected, actual, this.bindings);
    if (isObject(expected) && typeof expected.id === 'number') {
      const literal = topLevelLiteral(text, 'id');
      if (literal === undefined || !PLAIN_INTEGER_RE.test(literal)) {
        problems.push(`$.id: written as ${String(literal)}, not as a plain integer literal (matching rule 4)`);
      }
    }
    problems.push(...this.#checkMessage(actual, this.#methodFor(name, isObject(actual) ? actual.id : undefined)));
    if (problems.length > 0) throw new VectorFailure(`${name}: ${problems.join('; ')}`);
  }

  /** Schema and registry checks of a response, beyond what the vector expects. */
  #checkMessage(message: unknown, method: string | undefined): string[] {
    const { spec } = this;
    if (isObject(message) && 'error' in message) {
      const problems = spec
        .validate('schemas/common.schema.json#/$defs/rpcError', message)
        .map((p) => `error response ${p}`);
      if (problems.length > 0 || !isObject(message.error) || !isObject(message.error.data)) return problems;
      const { code } = message.error;
      const { kind, reason } = message.error.data;
      if (typeof kind !== 'string' || !spec.errorKinds.has(kind))
        return [`error kind ${String(kind)} is not registered`];
      if (message.error.message !== kind) problems.push('error message differs from data.kind (section 17.1)');
      if (typeof reason === 'string' && !spec.reasons.has(`${kind}/${reason}`)) {
        problems.push(`reason ${reason} is not registered for ${kind}`);
      } else if (code !== spec.errorCode(kind, typeof reason === 'string' ? reason : undefined)) {
        problems.push(`error code ${String(code)} is not the one section 17.2 gives ${kind}(${String(reason)})`);
      }
      return problems;
    }
    const problems = spec.validate('schemas/common.schema.json#/$defs/rpcSuccess', message).map((p) => `response ${p}`);
    if (
      problems.length > 0 ||
      !isObject(message) ||
      method === undefined ||
      spec.methods.get(method)?.defined !== true
    ) {
      return problems;
    }
    problems.push(
      ...spec
        .validate(`methods/${method}.schema.json#/$defs/result`, message.result)
        .map((p) => `${method} result ${p}`),
    );
    // A terminal job's result is that of the method that started it. The run remembers which method
    // started each job and checks against that method's jobResult. A job it did not see start (the
    // vector does not send the request) falls back to the methods that start its kind (x-otcp.startsJob;
    // a kind may have more than one starter): the result must then be valid for at least one of them,
    // and the problems reported are those of the closest fit.
    const job = isObject(message.result) ? message.result.job : undefined;
    if (isObject(job) && typeof job.jobId === 'string' && !this.#jobStartedBy.has(job.jobId)) {
      const starts = [...spec.jobStarters.values()].some((starters) => starters.includes(method));
      if (starts) this.#jobStartedBy.set(job.jobId, method);
    }
    if (isObject(job) && isObject(job.result) && typeof job.kind === 'string') {
      const kind = job.kind;
      const known = typeof job.jobId === 'string' ? this.#jobStartedBy.get(job.jobId) : undefined;
      const starters = known === undefined ? (spec.jobStarters.get(kind) ?? []) : [known];
      const attempts = starters.map((starter) =>
        spec
          .validate(`methods/${starter}.schema.json#/$defs/jobResult`, job.result)
          .map((p) => `${kind} job result ${p}`),
      );
      if (attempts.length > 0 && !attempts.some((a) => a.length === 0)) {
        problems.push(...attempts.reduce((best, a) => (a.length < best.length ? a : best)));
      }
    }
    return problems;
  }

  /** Authenticates the connection with the discovery token and verifies the server (section 4.3). */
  async authenticate(name: string): Promise<void> {
    // By reference, never by value: a failure names the binding and shows neither secret.
    this.sendValue(name, {
      jsonrpc: '2.0',
      id: HELLO_ID,
      method: 'session.hello',
      params: { token: { $ref: 'discovery.token' }, protocol: RUNNER_PROTOCOL, client: CLIENT },
    });
    try {
      await this.expect(name, {
        jsonrpc: '2.0',
        id: HELLO_ID,
        result: {
          serverProof: { $ref: 'discovery.serverProof' },
          instanceId: { $ref: 'discovery.instanceId' },
          pid: { $ref: 'discovery.pid' },
        },
      });
    } catch (error) {
      if (error instanceof VectorFailure)
        throw new VectorFailure(`the runner's own session.hello failed: ${error.message}`);
      throw error;
    }
  }

  /** connectionAfter open: the connection still answers a request. */
  async probe(name: string): Promise<void> {
    this.sendValue(name, { jsonrpc: '2.0', id: PROBE_ID, method: 'session.info', params: {} });
    const deadline = performance.now() + CLOSE_WAIT_MS;
    for (;;) {
      const line = await this.conn(name).readLine(Math.max(0, deadline - performance.now()));
      if (line === 'closed')
        throw new VectorFailure(`${name}: the server closed the connection, expected it to stay open`);
      if (line === 'timeout') throw new VectorFailure(`${name}: the connection stopped answering after the response`);
      const message = JSON.parse(line.toString('utf8')) as unknown;
      if (isObject(message) && message.id === PROBE_ID) return;
    }
  }

  /** Whether the port of the instance still accepts a connection; one that got in is closed again at once. */
  async portAccepts(): Promise<boolean> {
    try {
      (await RunnerConnection.open(Number(this.instance.discovery.port))).destroy();
      return true;
    } catch {
      return false;
    }
  }

  async expectClosed(name: string, options: { noBytes?: unknown; withinMs?: unknown }): Promise<void> {
    const conn = this.conn(name);
    const deadline =
      typeof options.withinMs === 'number' ? this.#stepEnd + options.withinMs : performance.now() + this.closeWaitMs;
    if (!(await conn.waitClosed(deadline))) {
      const within =
        typeof options.withinMs === 'number'
          ? `${String(options.withinMs)} ms after the previous step`
          : `in ${String(this.closeWaitMs / 1000)} s`;
      throw new VectorFailure(`${name}: the server did not close the connection ${within}`);
    }
    const sent = conn.receivedBytes - conn.bytesAtStepEnd;
    if (options.noBytes === true && sent > 0) {
      throw new VectorFailure(`${name}: the server sent ${String(sent)} bytes before closing, expected none`);
    }
  }

  async step(step: Step): Promise<void> {
    const name = step.connection ?? 'main';
    if (typeof step.connect === 'string') await this.connect(step.connect);
    else if ('send' in step) this.sendValue(name, step.send);
    else if (typeof step.sendRaw === 'string') this.sendBytes(name, Buffer.from(step.sendRaw, 'utf8'));
    else if (typeof step.sendHex === 'string') this.sendBytes(name, Buffer.from(step.sendHex, 'hex'));
    else if (isObject(step.sendFilled)) this.sendBytes(name, filled(step.sendFilled));
    else if ('expect' in step) await this.expect(name, step.expect);
    else if (isObject(step.expectClosed)) await this.expectClosed(name, step.expectClosed);
    else if (typeof step.pauseMs === 'number') await sleep(step.pauseMs);
    else throw new InvalidVector(`unknown step ${JSON.stringify(step)}`);
    this.markStep();
  }
}

/** sendFilled: head, then the fill character up to `bytes` bytes, then tail. */
function filled(spec: Record<string, unknown>): Buffer {
  const { head, fill, bytes, tail } = spec;
  if (typeof head !== 'string' || typeof fill !== 'string' || typeof bytes !== 'number' || typeof tail !== 'string') {
    throw new InvalidVector('sendFilled needs head, fill, bytes and tail');
  }
  const headBytes = Buffer.from(head, 'utf8');
  if (headBytes.length > bytes) throw new InvalidVector('sendFilled: head is longer than bytes');
  const body = Buffer.alloc(bytes, fill);
  headBytes.copy(body);
  return Buffer.concat([body, Buffer.from(tail, 'utf8')]);
}

/** Why the vector does not apply to the instance, or undefined when it does. */
function skipReason(vector: Vector, instance: TargetInstance, target: string): string | undefined {
  for (const capability of [vector.capability, ...(vector.extraCapabilities ?? [])]) {
    if (!instance.capabilities.includes(capability))
      return `${target} target lacks ${capability} (methods not implemented)`;
  }
  if (newerThan(vector.since, instance.protocol))
    return `the vector applies from ${vector.since}, the ${target} serves ${instance.protocol}`;
  return undefined;
}

/** discovery.* (matching rule 3): the members of the instance's discovery file. */
const discoveryBindings = (instance: TargetInstance): Bindings =>
  new Map(Object.entries(instance.discovery).map(([member, value]) => [`discovery.${member}`, value]));

/** discovery.* and runner.wrongToken (matching rule 3), plus the names `given` bound. */
function initialBindings(instance: TargetInstance, given: Readonly<Record<string, unknown>>): Bindings {
  const bindings: Bindings = new Map([...Object.entries(given), ...discoveryBindings(instance)]);
  const token = instance.discovery.token;
  if (typeof token === 'string' && token.length % 2 === 0) {
    let wrong = randomBytes(token.length / 2).toString('hex');
    if (wrong === token) wrong = `${wrong.startsWith('0') ? '1' : '0'}${wrong.slice(1)}`;
    bindings.set('runner.wrongToken', wrong);
  }
  return bindings;
}

/** The params of a request vector validate exactly when the vector says so (paramsValid). */
function checkParamsValid(vector: Vector, request: unknown, spec: OtcpSpec): void {
  const method = vector.method ?? '';
  if (spec.methods.get(method)?.defined !== true || !isObject(request)) return;
  const params = request.params ?? {};
  const valid = spec.validate(`methods/${method}.schema.json#/$defs/params`, params).length === 0;
  if (valid !== (vector.paramsValid ?? true)) {
    throw new InvalidVector(
      `paramsValid is ${String(vector.paramsValid ?? true)}, but the params ${valid ? 'validate' : 'do not validate'}`,
    );
  }
}

async function runSteps(vector: Vector, run: Run): Promise<void> {
  if (vector.type === 'request') {
    const request = resolve(vector.request, run.bindings);
    checkParamsValid(vector, request, run.spec);
    run.sendValue('main', request);
    await run.expect('main', vector.response);
    if (vector.connectionAfter === 'closed') {
      if (!(await run.conn('main').waitClosed(performance.now() + run.closeWaitMs))) {
        throw new VectorFailure('main: the server kept the connection open after the response, expected it to close');
      }
    } else {
      await run.probe('main');
    }
    return;
  }
  for (const step of vector.steps ?? []) await run.step(step);
}

/**
 * What a vector with endsSession asks beyond its steps (vectors/README.md, "Vectors that end the
 * instance", rule 3): within the end wait the instance is gone. Returns what the target could not observe.
 */
async function checkEnded(run: Run): Promise<readonly string[]> {
  const deadline = performance.now() + run.closeWaitMs;
  for (const [name, conn] of run.connections) {
    if (!(await conn.waitClosed(deadline))) {
      throw new VectorFailure(`${name}: the server did not close the connection after the instance was to end`);
    }
  }
  while (await run.portAccepts()) {
    if (performance.now() >= deadline) {
      throw new VectorFailure('the port of the instance still accepts connections after it was to end');
    }
    await sleep(PORT_POLL_MS);
  }
  if (run.instance.expectEnded === undefined) {
    return ['the exit of the process and the removal of the discovery file are not checked by this target'];
  }
  const { problems, notChecked } = await run.instance.expectEnded(Math.max(0, Math.ceil(deadline - performance.now())));
  if (problems.length > 0) throw new VectorFailure(problems.join('; '));
  return notChecked;
}

/** Runs one vector against a fresh instance of the target. Never throws. */
export async function runVector(
  vector: Vector,
  target: ContractTarget,
  spec = otcpSpec(),
  options: RunOptions = {},
): Promise<Outcome> {
  let instance: TargetInstance | undefined;
  let run: Run | undefined;
  // The note reaches test errors, the PASS / FAIL table and CI logs. Whatever the instance sent,
  // the token and the server proof of its discovery file never appear in it (section 4.5 rule 2).
  const outcome = (result: Outcome['result'], note: string): Outcome => ({
    id: vector.id,
    result,
    note: instance === undefined ? note : redact(note, discoveryBindings(instance)),
  });
  try {
    instance = await target.open();
    // Read as a client reads it: members this version defines, others allowed (section 5.4 rule 4).
    const discoveryProblems = spec.validate(
      'schemas/discovery-file.schema.json#/$defs/knownMembers',
      instance.discovery,
    );
    if (discoveryProblems.length > 0) return outcome('FAIL', `discovery file: ${discoveryProblems.join('; ')}`);
    const skip = skipReason(vector, instance, target.name);
    if (skip !== undefined) return outcome('SKIP', skip);
    let given: Readonly<Record<string, unknown>> = {};
    if (vector.given !== undefined) {
      try {
        given = await instance.establish(vector.given);
      } catch (error) {
        if (error instanceof PreconditionUnavailable) return outcome('SKIP', `precondition: ${error.message}`);
        throw error;
      }
    }
    const bindings = initialBindings(instance, given);
    const { refs, captures } = names([vector.request, vector.response, vector.steps]);
    if ([...refs].some((name) => name.startsWith('runner.') && name !== 'runner.wrongToken')) {
      await instance.prepareRunnerValues?.();
    }
    for (const name of refs) {
      if (bindings.has(name) || captures.has(name)) continue;
      const value = name.startsWith('runner.') ? instance.runnerValue(name) : undefined;
      if (value !== undefined) bindings.set(name, value);
      else if (name.startsWith('runner.')) return outcome('SKIP', `the ${target.name} target cannot provide ${name}`);
      else throw new InvalidVector(`$ref to ${name}, which nothing binds`);
    }

    run = new Run(
      instance,
      spec,
      bindings,
      options.readTimeoutMs ?? READ_TIMEOUT_MS,
      vector.endsSession === true ? (options.endWaitMs ?? END_WAIT_MS) : CLOSE_WAIT_MS,
    );
    await run.connect('main');
    if (vector.session === 'authenticated') await run.authenticate('main');
    run.markStep();
    await runSteps(vector, run);
    const notChecked = vector.endsSession === true ? await checkEnded(run) : [];
    const notes = vector.type === 'scenario' ? [`${String(vector.steps?.length ?? 0)} steps`] : [];
    if (notChecked.length > 0) notes.push(`not checked: ${notChecked.join(', ')}`);
    return outcome('PASS', notes.join('; '));
  } catch (error) {
    if (error instanceof VectorFailure) {
      const failed = outcome('FAIL', error.message);
      return run?.receivedModalOpen === true ? { ...failed, receivedModalOpen: true } : failed;
    }
    if (error instanceof InvalidVector) return outcome('FAIL', `invalid vector: ${error.message}`);
    return outcome('FAIL', `runner error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  } finally {
    // Lines not read are ignored; every connection of the vector is closed.
    for (const conn of run?.connections.values() ?? []) conn.destroy();
    await instance?.close();
  }
}
