// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// A mock OpenTune instance that speaks OTCP v1 from the specification in spec/otcp/v1: the
// transport and session layer (PROTOCOL.md sections 3 to 5), the jobs.v1 methods, the reads and
// the undo history. The project, the contents and their tokens are a model with state of its own
// (model.ts); the methods read and change it as the specification describes. The mock reports only
// the capabilities whose methods it implements, so every other method of the protocol gets
// UNSUPPORTED(capability_missing), as an instance without that capability answers. Test-only: it
// is not part of the published package.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';

import { LineSplitter, decodeLine, isBlankLine } from '../src/otcp/framing.js';
import { otcpSpec } from '../test/support/otcp-spec.js';
import { realClock, type Clock, type Timer } from './clock.js';
import type { Handler, MethodContext } from './context.js';
import { resolveDiscoveryDir, writeDiscoveryFile } from './discovery.js';
import { MockError } from './errors.js';
import { stripHome } from './privacy.js';
import { WorkFiles } from './files.js';
import { applyGiven, WORLD_GIVEN_MEMBERS, type GivenState } from './given.js';
import { arrangementHandlers } from './arrangement.js';
import { audioHandlers } from './audio.js';
import { editHandlers } from './edit.js';
import { ExportService } from './export.js';
import { historyHandlers } from './history.js';
import { IMPORT_LIMITS, ImportService } from './import.js';
import { JobStore, oneShot, UnsupportedPrecondition, type JobSpec } from './jobs.js';
import { prefsHandlers } from './prefs.js';
import { ProjectService } from './project.js';
import { TRACK_SLOTS, World, type Analysis, type BusyState } from './model.js';
import {
  classify,
  errorLine,
  fixedResponse,
  idKey,
  makeError,
  successLine,
  type ErrorInit,
  type Request,
  type RequestId,
} from './protocol.js';
import { readHandlers } from './reads.js';
import { referenceHandlers } from './reference.js';
import { timingHandlers } from './timing.js';
import { trackHandlers } from './tracks.js';
import { transportHandlers } from './transport.js';
import { uiHandlers } from './ui.js';

export { UnsupportedPrecondition } from './jobs.js';

/** The limits of section 3.4, as session.hello and session.info report them. */
export const LIMITS = {
  preAuthReadBytes: 8192,
  helloTimeoutMs: 2000,
  maxPreAuthConnections: 8,
  maxSessions: 4,
  maxLineBytes: 4_194_304,
  maxInFlightPerSession: 16,
  idleTimeoutMs: 600_000,
  dispatchTimeoutMs: 10_000,
  jobWaitMaxMs: 30_000,
  jobRetentionMs: 1_800_000,
  jobRetentionCount: 64,
} as const;

/** The capabilities whose methods the mock implements. */
export const MOCK_CAPABILITIES: readonly string[] = [
  'session.v1',
  'jobs.v1',
  'read.v1',
  'history.v1',
  'import.v1',
  'export.v1',
  'edit.v1',
  'timing.v1',
  'tracks.v1',
  'arrangement.v1',
  'transport.v1',
  'ui.bridge',
  'ui.onboardingClose',
  'reference.v1',
  'project.io',
  'prefs.write',
  'audio.device',
];

const LOOPBACK = '127.0.0.1';
const PROTOCOL = '1.0';
const PROTOCOL_MAJORS: readonly number[] = [1];
const PROTOCOL_VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const APP_VERSION = '0.0.0-mock';

export interface MockOptions {
  /** Where the discovery file goes; defaults to OPENTUNE_MCP_DISCOVERY_DIR. Never a real OpenTune folder. */
  readonly discoveryDir?: string;
  /** Listen address. Only 127.0.0.1 is accepted (section 3.1); other values are refused. */
  readonly host?: string;
  /** Seeds the instanceId, the mock's only random choice besides the token and the server proof. */
  readonly seed?: number;
  /** A fixed instanceId (32 lowercase hex digits), so that job ids repeat across runs. */
  readonly instanceId?: string;
  /** Source of timestamps and timeouts. Defaults to real time. */
  readonly clock?: Clock;
  /** Where the files of clips and of the `files` precondition go; a temporary directory by default. */
  readonly workDir?: string;
}

export interface GivenJob extends JobSpec {
  readonly bind: string;
}

/** The `given` preconditions of a vector (vectors/README.md); the mock models the members below. */
export interface Given extends GivenState {
  readonly jobs?: readonly GivenJob[];
  readonly withoutCapabilities?: readonly string[];
  readonly [member: string]: unknown;
}

export type DiscoveryContent = Readonly<Record<string, unknown>> & {
  readonly token: string;
  readonly instanceId: string;
  readonly port: number;
};

export interface OtcpMock {
  readonly address: net.AddressInfo;
  readonly discoveryPath: string;
  readonly discovery: DiscoveryContent;
  /** The capabilities session.hello and session.info report now. */
  readonly capabilities: readonly string[];
  /**
   * Test interface, outside OTCP: establishes a vector's `given` and returns the names it binds.
   * Throws UnsupportedPrecondition for preconditions the mock does not model yet.
   */
  given(given: Given): Record<string, string>;
  /** The value of a `runner.*` name that depends on the instance's state, or undefined if unknown. */
  runnerValue(name: string): string | number | undefined;
  /** The data of the project and its contents, without any token, for comparing states. */
  snapshot(): ReturnType<World['dataSnapshot']>;
  /** Connections accepted so far, open or closed. */
  readonly acceptedConnections: number;
  /** Connections open now, before and after authentication. */
  readonly openConnections: number;
  /** Resolves once the server has accepted at least `count` connections: the listener runs on its own event loop turn. */
  whenAccepted(count?: number): Promise<void>;
  /** Makes the UI busy (or not), as a gesture or a dialog in OpenTune would (PROTOCOL.md section 13.2). */
  setBusy(state: Partial<BusyState>): void;
  /** The pitch analysis of a content finishes, fails, or is requested again. */
  setAnalysis(contentId: string, analysis: Analysis): void;
  /** Appends a line to the log that app.getLog reads. */
  logLine(text: string): void;
  /** Removes a clip as the UI would, which the export lock does not stop (PROTOCOL.md section 19 rule 1). */
  removeClip(placementId: string): void;
  /** The next `times` attempts to render a content fail, so that an export of it fails (PROTOCOL.md section 19 rule 6). */
  failRender(contentId: string, times?: number): void;
  /** A reference analysis that has to compute alignment data ends as `fault` says (null: it completes). */
  setReferenceFault(fault: 'stalled' | 'timeout' | 'failed' | null): void;
  /** The alignment data of every content is gone, so that a reference analysis has to compute it again. */
  forgetAlignment(): void;
  /**
   * The first-run overlay starts, as OpenTune starts it while onboarding is not marked as shown. With
   * `choiceShown` the overlay has shown its choice, which marks onboarding as shown, as OpenTune does.
   */
  showOnboarding(choiceShown: boolean): void;
  /** The pitch analysis of the next `count` imported clips fails. */
  failNextAnalysis(count?: number): void;
  /** Stops as section 3.6 rule 2 describes and deletes the discovery file. */
  stop(): Promise<void>;
}

interface InFlight {
  readonly id: RequestId;
  /** Drops the pending work without answering. Set once the work is registered. */
  drop: () => void;
}

interface Connection {
  readonly socket: net.Socket;
  state: 'preauth' | 'session' | 'closed';
  readonly splitter: LineSplitter;
  readonly inFlight: Map<string, InFlight>;
  helloTimer: Timer | undefined;
  idleTimer: Timer | undefined;
}

const GIVEN_MEMBERS = new Set<string>(['jobs', 'withoutCapabilities', ...WORLD_GIVEN_MEMBERS]);

const PARSE_DETAILS = {
  utf8: 'the line is not valid UTF-8',
  json: 'the line is not valid JSON',
  depth: 'the line nests arrays and objects deeper than 64 levels',
} as const;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();

export async function startMock(options: MockOptions = {}): Promise<OtcpMock> {
  const host = options.host ?? LOOPBACK;
  if (host !== LOOPBACK)
    throw new Error(`the mock listens only on ${LOOPBACK} (PROTOCOL.md section 3.1), not on ${host}`);
  const discoveryDir = resolveDiscoveryDir(options.discoveryDir);
  const spec = otcpSpec();
  const clock = options.clock ?? realClock;
  const instanceId =
    options.instanceId ??
    (options.seed === undefined
      ? randomBytes(16).toString('hex')
      : sha256(`otcp-mock:${String(options.seed)}`)
          .toString('hex')
          .slice(0, 32));
  if (!/^[0-9a-f]{32}$/.test(instanceId)) throw new Error('instanceId must be 32 lowercase hexadecimal digits');
  // Secrets always come from the CSPRNG, also with a seed (vectors/README.md, "Reproducibility").
  const token = randomBytes(32).toString('hex');
  const serverProof = randomBytes(16).toString('hex');
  const tokenDigest = sha256(token);

  const jobs = new JobStore(spec, clock, instanceId.slice(0, 8));
  const world = new World(instanceId, clock);
  const files = new WorkFiles(options.workDir);
  const exporter = new ExportService(world, jobs, files, clock);
  const importer = new ImportService(world, jobs, files, clock, spec);
  const projects = new ProjectService(world, jobs, files);
  let capabilities = [...MOCK_CAPABILITIES];
  let preAuthCount = 0;
  let acceptedConnections = 0;
  const acceptWaiters: { count: number; resolve: () => void }[] = [];
  let sessionCount = 0;
  let stopping = false;
  const connections = new Set<Connection>();

  const err = (init: ErrorInit) => makeError(spec, init);
  const send = (conn: Connection, line: Buffer) => {
    if (conn.state !== 'closed') conn.socket.write(line);
  };
  const reply = (conn: Connection, id: RequestId | null, init: ErrorInit) => {
    send(conn, errorLine(id, err(init)));
  };

  /** Closes the connection, after sending `last` if given; any further input is discarded. */
  const close = (conn: Connection, last?: Buffer) => {
    if (conn.state === 'closed') return;
    if (conn.state === 'preauth') preAuthCount--;
    else sessionCount--;
    conn.state = 'closed';
    conn.helloTimer?.cancel();
    conn.idleTimer?.cancel();
    for (const pending of conn.inFlight.values()) pending.drop();
    conn.inFlight.clear();
    connections.delete(conn);
    endSocket(conn.socket, last);
  };

  /** Section 3.4 rule 4: idle while nothing is in flight; reset by every complete line. */
  const touch = (conn: Connection) => {
    conn.idleTimer?.cancel();
    conn.idleTimer = undefined;
    if (conn.state === 'session' && conn.inFlight.size === 0) {
      conn.idleTimer = clock.setTimer(LIMITS.idleTimeoutMs, () => {
        close(conn);
      });
    }
  };

  const helloResult = () => ({
    protocol: PROTOCOL,
    instanceId,
    pid: process.pid,
    serverProof,
    appVersion: APP_VERSION,
    flavor: 'standalone',
    capabilities: [...capabilities],
    limits: LIMITS,
  });

  const sessionInfo = () => ({
    protocol: PROTOCOL,
    instanceId,
    appVersion: APP_VERSION,
    build: discovery.build,
    buildTag: discovery.buildTag,
    sourceUrl: discovery.sourceUrl,
    flavor: 'standalone',
    runtime: {
      os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
      arch: process.arch,
      pid: process.pid,
    },
    audioDevice: world.audio.running
      ? {
          running: true,
          name: world.audio.outputDevice,
          sampleRateHz: world.audio.sampleRateHz,
          bufferSizeFrame: world.audio.bufferSizeFrame,
        }
      : {
          running: false,
          name: null,
          sampleRateHz: null,
          bufferSizeFrame: null,
          nullReasons: { name: 'no_audio_device', sampleRateHz: 'no_audio_device', bufferSizeFrame: 'no_audio_device' },
        },
    processing: {
      tuningHz: world.prefs.tuningHz,
      editingScheme: world.editingScheme,
      hybridMode: world.prefs.hybridMode,
      vocoderWeight: null,
      f0Model: null,
      renderingPriority: null,
      backend: null,
      vocoderReady: false,
      vocoderReconfiguring: false,
      experimentalFeatures: world.prefs.experimentalFeatures,
      referenceAlignMode: null,
      nullReasons: {
        vocoderWeight: 'unavailable',
        f0Model: 'unavailable',
        renderingPriority: 'unavailable',
        backend: 'unavailable',
        referenceAlignMode: 'unavailable',
      },
    },
    language: world.prefs.language,
    capabilities: [...capabilities],
    import: { ...IMPORT_LIMITS, extensions: [...IMPORT_LIMITS.extensions] },
    export: {
      formats: ['wav'],
      sampleRateHz: 44100,
      channels: { clip: 1, track: 1, master: 2 },
      sampleFormat: 'float32',
    },
    limits: LIMITS,
  });

  const methods: Readonly<Record<string, (conn: Connection, request: Request) => void>> = {
    'session.info': (conn, { id }) => {
      send(conn, successLine(id, sessionInfo()));
    },
    'job.get': (conn, { id, params }) => {
      const jobId = String(params?.jobId);
      const waitMs = typeof params?.waitMs === 'number' ? params.waitMs : 0;
      const job = jobs.get(jobId);
      if (job === undefined) {
        reply(conn, id, { kind: 'NOT_FOUND', reason: 'job_not_found', detail: 'no job with this jobId is retained' });
        return;
      }
      if (waitMs === 0 || job.finishedAtMs !== null) {
        send(conn, successLine(id, { job }));
        return;
      }
      // Section 12.2: held until the job is terminal or waitMs elapses; in flight meanwhile. The
      // request is registered before the wait starts, so the answer never depends on whether
      // the wait calls back at once.
      const key = idKey(id);
      const pending: InFlight = { id, drop: () => undefined };
      conn.inFlight.set(key, pending);
      pending.drop = jobs.wait(jobId, waitMs, (current) => {
        conn.inFlight.delete(key);
        send(conn, successLine(id, { job: current }));
        touch(conn);
      });
    },
    'job.cancel': (conn, { id, params }) => {
      const outcome = jobs.cancel(String(params?.jobId));
      if (outcome === undefined) {
        reply(conn, id, { kind: 'NOT_FOUND', reason: 'job_not_found', detail: 'no job with this jobId is retained' });
      } else if (outcome === 'not_cancellable') {
        reply(conn, id, {
          kind: 'UNSUPPORTED',
          reason: 'job_not_cancellable',
          detail: 'this job cannot be cancelled now',
        });
      } else {
        send(conn, successLine(id, outcome));
      }
    },
  };

  const redact = (text: string): string => {
    const out = text.split(token).join('<redacted>').split(serverProof).join('<redacted>');
    return stripHome(out, os.homedir());
  };

  const worldHandlers: Readonly<Record<string, Handler>> = {
    ...readHandlers,
    ...historyHandlers,
    ...editHandlers,
    ...timingHandlers,
    ...trackHandlers,
    ...arrangementHandlers,
    ...transportHandlers,
    ...uiHandlers,
    ...referenceHandlers,
    ...prefsHandlers,
    ...audioHandlers,
    ...projects.handlers,
    'import.start': importer.start,
    'export.start': exporter.start,
  };

  /** Runs a method of the model on the "main thread": synchronously, so requests apply in order. */
  const runModel = (conn: Connection, { id, method, params }: Request) => {
    const handler = worldHandlers[method];
    if (handler === undefined) return false;
    const context: MethodContext = {
      world,
      params: params ?? {},
      // Read when asked, so that the work of a job that runs later sees the lock as it is then.
      get exportLock() {
        return jobs.hasActive('export');
      },
      hasCapability: (c) => capabilities.includes(c),
      redact,
      startJob: (kind, work) => jobs.start({ kind }, oneShot(work)),
      jobs,
    };
    try {
      send(conn, successLine(id, handler(context)));
    } catch (error) {
      if (error instanceof MockError) reply(conn, id, error.init);
      else {
        const detail = error instanceof Error ? error.message : 'unexpected failure';
        reply(conn, id, { kind: 'INTERNAL', detail: `the mock failed in ${method}: ${detail}`, executed: true });
      }
    }
    return true;
  };

  /** Section 3.3 rule 5, cases 7 to 13, for a valid request on an authenticated session. */
  const dispatch = (conn: Connection, request: Request) => {
    const { id, method } = request;
    const params = request.params ?? {};
    if (conn.inFlight.has(idKey(id))) {
      reply(conn, null, {
        kind: 'INVALID_ARGUMENT',
        reason: 'duplicate_id',
        detail: 'a request with this id is in flight',
      });
      return;
    }
    if (conn.inFlight.size >= LIMITS.maxInFlightPerSession) {
      reply(conn, id, {
        kind: 'BUSY',
        reason: 'request_limit',
        detail: 'too many requests in flight',
        retryable: true,
      });
      return;
    }
    const info = spec.methods.get(method);
    if (info === undefined) {
      reply(conn, id, { kind: 'UNSUPPORTED', reason: 'unknown_method', detail: 'no method of OTCP 1.0 has this name' });
      return;
    }
    const needed = [
      info.capability,
      ...Object.entries(info.valueCapabilities).flatMap(([member, values]) => {
        const value = params[member];
        return typeof value === 'string' && Object.hasOwn(values, value) ? [values[value] ?? ''] : [];
      }),
    ];
    const missing = needed.find((c) => !capabilities.includes(c));
    if (missing !== undefined) {
      reply(conn, id, {
        kind: 'UNSUPPORTED',
        reason: 'capability_missing',
        detail: `this instance does not report the capability ${missing}`,
      });
      return;
    }
    if (method === 'session.hello') {
      close(
        conn,
        errorLine(
          id,
          err({ kind: 'INVALID_ARGUMENT', reason: 'hello_repeated', detail: 'the session is already authenticated' }),
        ),
      );
      return;
    }
    const problems = spec.validate(`methods/${method}.schema.json#/$defs/params`, params);
    if (problems.length > 0) {
      reply(conn, id, {
        kind: 'INVALID_ARGUMENT',
        reason: 'invalid_params',
        detail: `invalid params: ${problems.join('; ')}`,
      });
      return;
    }
    if (stopping) {
      reply(conn, id, { kind: 'SHUTTING_DOWN', detail: 'the server is stopping' });
      return;
    }
    const handler = methods[method];
    if (handler !== undefined) handler(conn, request);
    else if (!runModel(conn, request)) {
      reply(conn, id, { kind: 'INTERNAL', detail: `the mock reports ${info.capability} but lacks ${method}` });
    }
  };

  /** Section 3.3 rule 5, cases 2 to 6, for a line on an authenticated session. */
  const handleLine = (conn: Connection, bytes: Buffer) => {
    if (isBlankLine(bytes)) return;
    const decoded = decodeLine(bytes);
    if (!decoded.ok) {
      reply(conn, null, { kind: 'INVALID_ARGUMENT', reason: 'parse_error', detail: PARSE_DETAILS[decoded.error] });
      return;
    }
    const message = classify(decoded.value);
    if (message.kind === 'batch') {
      reply(conn, null, { kind: 'INVALID_ARGUMENT', reason: 'batch_unsupported', detail: 'batches are not supported' });
    } else if (message.kind === 'invalid') {
      reply(conn, message.id, { kind: 'INVALID_ARGUMENT', reason: 'invalid_request', detail: message.detail });
    } else if (message.kind === 'request') {
      dispatch(conn, message.request);
    }
  };

  /** Sections 3.5 rule 3 and 4.2: the first line must be a session.hello request. */
  const handleHello = (conn: Connection, bytes: Buffer) => {
    conn.helloTimer?.cancel();
    const decoded = decodeLine(bytes);
    const message = decoded.ok ? classify(decoded.value) : undefined;
    if (message?.kind !== 'request' || message.request.method !== 'session.hello') {
      close(conn);
      return;
    }
    const { id, params } = message.request;
    // Compared whenever token is a string, in time independent of its content.
    const tokenOk = typeof params?.token === 'string' && timingSafeEqual(sha256(params.token), tokenDigest);
    const protocol = params?.protocol;
    if (!tokenOk || typeof protocol !== 'string' || !PROTOCOL_VERSION_RE.test(protocol)) {
      close(conn, fixedResponse('AUTH_FAILED', id));
      return;
    }
    if (!PROTOCOL_MAJORS.includes(Number(protocol.split('.')[0]))) {
      close(conn, fixedResponse('PROTOCOL_MISMATCH', id));
      return;
    }
    const problems = spec.validate('methods/session.hello.schema.json#/$defs/params', params);
    if (problems.length > 0) {
      const detail = `invalid session.hello params: ${problems.join('; ')}`;
      close(conn, errorLine(id, err({ kind: 'INVALID_ARGUMENT', reason: 'invalid_params', detail })));
      return;
    }
    if (sessionCount >= LIMITS.maxSessions) {
      const busy = { kind: 'BUSY', reason: 'session_limit', detail: 'too many sessions', retryable: true };
      close(conn, errorLine(id, err(busy)));
      return;
    }
    preAuthCount--;
    sessionCount++;
    conn.state = 'session';
    conn.splitter.maxLineBytes = LIMITS.maxLineBytes;
    send(conn, successLine(id, helloResult()));
  };

  const drain = (conn: Connection) => {
    for (;;) {
      if (conn.state === 'closed') return;
      const event = conn.splitter.next();
      if (event === undefined) return;
      if (event.kind === 'overflow') {
        // Before authentication the connection closes without a byte (section 3.5 rule 2).
        const tooLong = err({
          kind: 'INVALID_ARGUMENT',
          reason: 'line_too_long',
          detail: `the line is longer than ${String(LIMITS.maxLineBytes)} bytes`,
        });
        close(conn, conn.state === 'session' ? errorLine(null, tooLong) : undefined);
        return;
      }
      if (conn.state === 'preauth') handleHello(conn, event.bytes);
      else handleLine(conn, event.bytes);
      touch(conn);
    }
  };

  const accept = (socket: net.Socket) => {
    if (stopping || preAuthCount >= LIMITS.maxPreAuthConnections) {
      endSocket(socket);
      return;
    }
    const conn: Connection = {
      socket,
      state: 'preauth',
      // A first line may take preAuthReadBytes including its LF.
      splitter: new LineSplitter(LIMITS.preAuthReadBytes - 1),
      inFlight: new Map(),
      helloTimer: undefined,
      idleTimer: undefined,
    };
    preAuthCount++;
    connections.add(conn);
    acceptedConnections++;
    for (const waiter of acceptWaiters.splice(0)) {
      if (acceptedConnections >= waiter.count) waiter.resolve();
      else acceptWaiters.push(waiter);
    }
    conn.helloTimer = clock.setTimer(LIMITS.helloTimeoutMs, () => {
      close(conn);
    });
    socket.on('data', (chunk: Buffer) => {
      if (conn.state === 'closed') return;
      conn.splitter.push(chunk);
      drain(conn);
    });
    // The peer closing (or failing) ends the connection; a half-written first line gets no answer.
    const gone = () => {
      close(conn);
    };
    socket.on('end', gone);
    socket.on('error', gone);
    socket.on('close', gone);
  };

  const server = net.createServer(accept);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: LOOPBACK, port: 0, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as net.AddressInfo;

  const discovery = {
    protocolMajors: [...PROTOCOL_MAJORS],
    pid: process.pid,
    processStartTimeMs: Math.round(performance.timeOrigin),
    instanceId,
    port: address.port,
    token,
    serverProof,
    launchNonce: null,
    appVersion: APP_VERSION,
    build: { commit: '0'.repeat(40), tag: null },
    buildTag: null,
    sourceUrl: 'https://github.com/synchain-oss/opentune-mcp-server',
    startedAtMs: clock.now(),
    flavor: 'standalone',
  };
  let discoveryPath: string;
  try {
    // Written only once the listener accepts connections (section 5.2 rule 5).
    discoveryPath = writeDiscoveryFile(discoveryDir, process.pid, discovery);
  } catch (error) {
    server.close();
    files.dispose();
    world.dispose();
    throw error;
  }
  world.log(`control API listening on 127.0.0.1:${String(address.port)}; discovery file ${discoveryPath}`);

  let stopped: Promise<void> | undefined;
  return {
    address,
    discoveryPath,
    discovery,
    get capabilities() {
      return [...capabilities];
    },
    given(given) {
      const unknown = Object.keys(given).find((member) => !GIVEN_MEMBERS.has(member));
      if (unknown !== undefined) throw new UnsupportedPrecondition(`the mock does not model given.${unknown} yet`);
      const without = given.withoutCapabilities ?? [];
      capabilities = capabilities.filter((c) => !without.includes(c));
      const bindings = applyGiven(world, files, given);
      for (const job of given.jobs ?? []) bindings[job.bind] = jobs.add(job).jobId;
      return bindings;
    },
    runnerValue(name) {
      switch (name) {
        case 'runner.unknownContentId':
          return world.unknownHandle('c');
        case 'runner.unknownPlacementId':
          return world.unknownHandle('p');
        case 'runner.staleContentId':
          return world.handleOfOtherInstance('c');
        case 'runner.stalePlacementId':
          return world.handleOfOtherInstance('p');
        case 'runner.arrangementRevision':
          return world.arrangement;
        case 'runner.lastTrackId':
          return TRACK_SLOTS - 1;
        case 'runner.unknownTrackId':
          return TRACK_SLOTS;
        default:
          return undefined;
      }
    },
    snapshot: () => world.dataSnapshot(),
    get acceptedConnections() {
      return acceptedConnections;
    },
    get openConnections() {
      return connections.size;
    },
    whenAccepted(count = 1) {
      if (acceptedConnections >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        acceptWaiters.push({ count, resolve });
      });
    },
    setBusy(state) {
      Object.assign(world.busy, state);
    },
    setAnalysis(contentId, analysis) {
      world.setAnalysis(world.content(contentId), analysis);
    },
    removeClip(placementId) {
      world.removePlacement(world.placement(placementId));
      world.touchArrangement();
    },
    failRender(contentId, times = 2) {
      exporter.failRender(world.content(contentId), times);
    },
    setReferenceFault(fault) {
      world.referenceFault = fault;
    },
    forgetAlignment() {
      for (const content of world.contents.values()) content.alignmentReady = false;
    },
    showOnboarding(choiceShown) {
      world.onboardingShowing = true;
      if (choiceShown) world.prefs.onboardingShown = true;
    },
    failNextAnalysis(count = 1) {
      importer.failNextAnalysis(count);
    },
    logLine(text) {
      world.log(text);
    },
    stop() {
      stopped ??= (async () => {
        stopping = true;
        for (const conn of connections) {
          for (const pending of conn.inFlight.values()) {
            pending.drop();
            send(conn, errorLine(pending.id, err({ kind: 'SHUTTING_DOWN', detail: 'the server is stopping' })));
          }
          conn.inFlight.clear();
        }
        for (const conn of [...connections]) close(conn);
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
        fs.rmSync(discoveryPath, { force: true });
        jobs.dispose();
        files.dispose();
        world.dispose();
      })();
      return stopped;
    },
  };
}

/**
 * Half-closes the socket after `last` and discards further input, then destroys it once the peer
 * closes or a second has passed. Closing with unread input could make the peer's system reset the
 * connection and drop the response before the client reads it.
 */
function endSocket(socket: net.Socket, last?: Buffer): void {
  if (socket.destroyed) return;
  socket.on('error', () => undefined);
  socket.resume();
  if (last === undefined) socket.end();
  else socket.end(last);
  const timer = setTimeout(() => socket.destroy(), 1000);
  timer.unref();
  socket.once('close', () => {
    clearTimeout(timer);
  });
}
