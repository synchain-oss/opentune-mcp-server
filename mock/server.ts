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
import { quitResult } from './app.js';
import { arrangementHandlers } from './arrangement.js';
import { audioHandlers } from './audio.js';
import { editHandlers } from './edit.js';
import { ExportService } from './export.js';
import { historyHandlers } from './history.js';
import { IMPORT_LIMITS, ImportService } from './import.js';
import { JobStore, oneShot, UnsupportedPrecondition, type JobSpec } from './jobs.js';
import { prefsHandlers } from './prefs.js';
import { ProjectService } from './project.js';
import { TRACK_SLOTS, World, carries, type Analysis, type BusyState } from './model.js';
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
  'ui.workspace',
  'project.io',
  'project.copy',
  'prefs.write',
  'audio.device',
  'app.quit',
];

const LOOPBACK = '127.0.0.1';
const PROTOCOL = '1.0';
const PROTOCOL_MAJORS: readonly number[] = [1];
const PROTOCOL_VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
/** The methods that act through the OpenTune editor window (PROTOCOL.md section 7 rule 6). */
const NO_EDITOR_METHODS: ReadonlySet<string> = new Set([
  'ui.getState',
  'ui.dismiss',
  'ui.setSelection',
  'ui.setWorkspace',
  'track.add',
  'track.duplicate',
  'track.delete',
  'project.save',
  'project.saveAs',
  'project.saveCopy',
  'project.open',
  'audio.set',
  'app.quit',
]);
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
  /**
   * How the vocoder reconfigures after a new weight or rendering priority: how long a command waits before the
   * vocoder reports it (`queuedMs`), how long it then reconfigures (`reconfiguringMs`), and how long a prefsApply job
   * waits for it (`waitLimitMs`, 60 s by default).
   */
  readonly vocoder?: Partial<{ queuedMs: number; reconfiguringMs: number; waitLimitMs: number }>;
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
  /**
   * `stuck`: a reconfiguration of the vocoder never finishes, so that a prefsApply job passes its wait limit and fails
   * with MODEL_UNAVAILABLE(vocoder_not_ready); `loadFails`: the vocoder can load only the weight and rendering priority
   * in use when the fault is set, so that a reconfiguration to any other ends with the vocoder not ready and the job
   * takes its changes back at once and fails with MODEL_UNAVAILABLE(vocoder_load_failed); null lets a stuck
   * reconfiguration finish.
   */
  setVocoderFault(fault: 'stuck' | 'loadFails' | null): void;
  /**
   * OpenTune loads its vocoder at the first render that needs it, not at start: until then session.info reports the
   * vocoder as not ready, and a change of the rendering priority or the weight does not wait for it. That render
   * starts the load, and it is not published before the vocoder has loaded. With hybrid mode on, a render whose
   * corrections all stay within 75 cents of the detected pitch is done by resampling, which needs no vocoder: it is
   * published at once and loads nothing. Off by default, the vocoder is ready from the start.
   */
  setVocoderLoadOnDemand(on: boolean): void;
  /**
   * Whether the GPU can create the inference session. Unset, the mock reports no backend (null, reason unavailable).
   * Set, processing.backend is "directml" under gpuFirst with the GPU available, and "cpu" otherwise: under gpuFirst
   * without a GPU it is the fall back to the CPU that OpenTune makes by itself; a prefs.set that sets gpuFirst then
   * carries the warning BACKEND_FALLBACK.
   */
  setGpuAvailable(on: boolean): void;
  /** OpenTune cannot load these pitch models: prefs.set of one of them (it must be among the options) fails with model_missing. */
  failF0Model(...models: readonly string[]): void;
  /**
   * The first-run overlay starts, as OpenTune starts it while onboarding is not marked as shown. With
   * `choiceShown` the overlay has shown its choice, which marks onboarding as shown, as OpenTune does.
   */
  showOnboarding(choiceShown: boolean): void;
  /**
   * A window-less run (no OpenTune editor window): the methods that act through the editor window fail with
   * `UNSUPPORTED(no_editor_window)`, `executed` false, and change nothing (PROTOCOL.md section 7 rule 6).
   */
  setNoEditor(on: boolean): void;
  /**
   * Ends a job that `given.jobs` made (it runs for ever otherwise), as cancelled. Returns false for an unknown job, one
   * that has ended already, and one the mock drives itself.
   */
  endJob(jobId: string): boolean;
  /** While the transport plays on a running device, the position advances by `rate` timeline seconds per second (0: it stays). */
  setTransportRate(rate: number): void;
  /**
   * The audio device offers `count` output channel pairs. OpenTune's Standalone offers the pair 0 only, which the
   * mock does by default and the contract vectors assume; a test that switches the pair offers more.
   */
  setOutputChannelPairCount(count: number): void;
  /** The pitch analysis of the next `count` imported clips fails. */
  failNextAnalysis(count?: number): void;
  /** Stops as section 3.6 rule 2 describes and deletes the discovery file. */
  stop(): Promise<void>;
  /**
   * app.quit was answered with success. The mock then stops by itself, through the path of stop(), as OpenTune
   * ends after it answered; what ends is the mock, never the process that runs it.
   */
  readonly quitRequested: boolean;
  /** Resolves once the mock has stopped completely: its connections and listener are closed and the discovery file is gone. */
  whenEnded(): Promise<void>;
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
  Object.assign(world.vocoderTiming, options.vocoder);
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
  let quitRequested = false;
  const connections = new Set<Connection>();
  let markEnded: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    markEnded = resolve;
  });

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
      vocoderWeight: carries(world.prefs.vocoderWeight) ? world.prefs.vocoderWeight : null,
      f0Model: world.prefs.f0Model,
      renderingPriority: world.prefs.renderingPriority,
      backend: world.backend,
      vocoderReady: world.vocoder.ready,
      vocoderReconfiguring: world.vocoder.reconfiguring,
      experimentalFeatures: world.prefs.experimentalFeatures,
      nullReasons: {
        ...(world.backend === null ? { backend: 'unavailable' } : {}),
        ...(carries(world.prefs.vocoderWeight) ? {} : { vocoderWeight: 'unavailable' }),
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

  /** Answers with the result `produce` builds, or with the error it throws; `after` runs once the result is written. */
  const respond = (
    conn: Connection,
    id: RequestId,
    method: string,
    produce: () => Record<string, unknown>,
    after?: () => void,
  ) => {
    try {
      send(conn, successLine(id, produce()));
    } catch (error) {
      if (error instanceof MockError) reply(conn, id, error.init);
      else {
        const detail = error instanceof Error ? error.message : 'unexpected failure';
        reply(conn, id, { kind: 'INTERNAL', detail: `the mock failed in ${method}: ${detail}`, executed: true });
      }
      return;
    }
    after?.();
  };

  /** A window-less run: a method that acts through the editor window fails (section 7 rule 6); true when it did. */
  const refusedNoEditor = (conn: Connection, id: RequestId, method: string): boolean => {
    if (!world.noEditor || !NO_EDITOR_METHODS.has(method)) return false;
    reply(conn, id, {
      kind: 'UNSUPPORTED',
      reason: 'no_editor_window',
      detail: `${method} acts through the OpenTune editor window, and this instance has no editor window`,
      executed: false,
    });
    return true;
  };

  /**
   * app.quit has answered with success: the server is stopping from now on (a later request gets SHUTTING_DOWN) and
   * stops through its normal path in the next turn of the event loop, after the answer has been written.
   */
  const beginQuit = () => {
    quitRequested = true;
    stopping = true;
    setImmediate(() => {
      // A stop that fails (the discovery file cannot be removed) must not become an unhandled rejection: the end is
      // still marked (whenEnded), and stop() hands the same failure to whoever asks for it.
      stopMock().catch(() => undefined);
    });
  };

  const methods: Readonly<Record<string, (conn: Connection, request: Request) => void>> = {
    'session.info': (conn, { id }) => {
      send(conn, successLine(id, sessionInfo()));
    },
    'app.quit': (conn, { id, method, params }) => {
      if (refusedNoEditor(conn, id, method)) return;
      respond(conn, id, method, () => quitResult(world, jobs, params ?? {}), beginQuit);
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
    if (refusedNoEditor(conn, id, method)) return true;
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
    respond(conn, id, method, () => handler(context));
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
  /**
   * Section 3.6 rule 2, then the discovery file (section 5.4 rule 1); once, whoever asks first. The mock has ended
   * once it has stopped, whether or not the discovery file could be removed (a file that cannot be deleted, as on
   * Windows with EPERM, makes rmSync throw): the clean-up after it runs and the end is marked in every case, and the
   * failure is the rejection of the promise returned here.
   */
  const stopMock = (): Promise<void> => {
    stopped ??= (async () => {
      try {
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
        try {
          fs.rmSync(discoveryPath, { force: true });
        } finally {
          jobs.dispose();
          files.dispose();
          world.dispose();
        }
      } finally {
        markEnded();
      }
    })();
    return stopped;
  };
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
    setVocoderFault(fault) {
      world.setVocoderFault(fault);
    },
    setVocoderLoadOnDemand(on) {
      world.setVocoderLoadOnDemand(on);
    },
    setGpuAvailable(on) {
      world.gpuAvailable = on;
    },
    failF0Model(...models) {
      for (const model of models) world.unloadableF0Models.add(model);
    },
    showOnboarding(choiceShown) {
      world.onboardingShowing = true;
      // Onboarding counts as shown only once the overlay has shown its choice; without it the flag is cleared.
      world.prefs.onboardingShown = choiceShown;
    },
    setNoEditor(on) {
      world.noEditor = on;
    },
    endJob(jobId) {
      return jobs.end(jobId);
    },
    setTransportRate(rate) {
      world.settleTransport();
      world.transportRate = rate;
    },
    setOutputChannelPairCount(count) {
      world.outputChannelPairCount = count;
    },
    failNextAnalysis(count = 1) {
      importer.failNextAnalysis(count);
    },
    logLine(text) {
      world.log(text);
    },
    stop: stopMock,
    get quitRequested() {
      return quitRequested;
    },
    whenEnded: () => ended,
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
