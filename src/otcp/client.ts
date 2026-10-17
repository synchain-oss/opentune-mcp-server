// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// One OTCP session with one instance (spec/otcp/v1/PROTOCOL.md sections 3 and 4): a TCP connection
// to the literal loopback address, session.hello with the token of the discovery file, and the
// client check of section 4.3 (serverProof, instanceId and pid must equal the discovery file)
// before any other request is sent. Requests are matched to responses by id and time out on this
// side. The token and the server proof never appear in an error, a log line or a result.

import { timingSafeEqual } from 'node:crypto';
import net from 'node:net';

import { OtcpError, errorDataFrom, type ErrorData } from '../errors/tool-error.js';
import type { DiscoveryEntry } from '../discovery/file.js';
import { SERVER_NAME, VERSION } from '../version.js';
import { LineSplitter, decodeLine, encodeLine } from './framing.js';

/** The protocol major this client speaks; a hello naming another major is refused. */
const SUPPORTED_MAJOR = 1;

/** The major of a `MAJOR.MINOR` protocol string, or NaN when it has none. */
const majorOf = (protocol: string): number => Number(/^(\d+)(?:\.|$)/.exec(protocol)?.[1] ?? Number.NaN);

/** The only address OTCP clients connect to (section 3.1 rule 3); host names are never resolved. */
export const LOOPBACK = '127.0.0.1';
/** Protocol version this client implements. */
export const CLIENT_PROTOCOL = '1.0';
const MAX_LINE_BYTES = 4_194_304;
const HELLO_TIMEOUT_MS = 5000;

export interface HelloInfo {
  readonly protocol: string;
  readonly instanceId: string;
  readonly pid: number;
  readonly appVersion: string;
  readonly capabilities: readonly string[];
}

export type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

const local = (kind: string, reason: string | null, detail: string, executed: boolean | null, retryable = true) =>
  new OtcpError({ kind, reason, retryable, detail, executed } satisfies ErrorData);

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

interface Pending {
  readonly resolve: (result: Json) => void;
  readonly reject: (error: OtcpError) => void;
  readonly timer: NodeJS.Timeout;
}

export class OtcpSession {
  readonly #socket: net.Socket;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;

  private constructor(
    socket: net.Socket,
    readonly hello: HelloInfo,
    splitter: LineSplitter,
  ) {
    this.#socket = socket;
    const onData = (chunk: Buffer) => {
      splitter.push(chunk);
      for (let event = splitter.next(); event !== undefined; event = splitter.next()) {
        if (event.kind === 'overflow') {
          this.#fail(local('CONNECTION_LOST', 'line_too_long', 'OpenTune sent a line longer than 4 MiB', null));
          return;
        }
        this.#onLine(event.bytes);
      }
    };
    socket.on('data', onData);
    const gone = () => {
      this.#fail(local('CONNECTION_LOST', null, 'the connection to OpenTune closed', null));
    };
    socket.on('close', gone);
    socket.on('error', gone);
  }

  /** Connects, authenticates and verifies the instance. Rejects with OtcpError. */
  static open(entry: DiscoveryEntry, timeoutMs = HELLO_TIMEOUT_MS): Promise<OtcpSession> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: LOOPBACK, port: entry.port });
      // An open connection must never keep the MCP server process alive on its own.
      socket.unref();
      const splitter = new LineSplitter(MAX_LINE_BYTES);
      let settled = false;
      const settle = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        socket.off('data', onData);
        return true;
      };
      const finish = (error: OtcpError) => {
        if (!settle()) return;
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(() => {
        finish(local('CONNECTION_LOST', 'hello_timeout', 'OpenTune did not answer session.hello in time', false));
      }, timeoutMs);
      timer.unref();
      socket.once('error', (error: NodeJS.ErrnoException) => {
        finish(
          local('CONNECTION_LOST', 'connect_failed', `cannot connect to OpenTune (${error.code ?? 'error'})`, false),
        );
      });
      socket.once('close', () => {
        finish(
          local('CONNECTION_LOST', 'closed_during_hello', 'OpenTune closed the connection during session.hello', false),
        );
      });
      socket.once('connect', () => {
        socket.write(
          encodeLine({
            jsonrpc: '2.0',
            id: 0,
            method: 'session.hello',
            params: { token: entry.token, protocol: CLIENT_PROTOCOL, client: { name: SERVER_NAME, version: VERSION } },
          }),
        );
      });
      const onData = (chunk: Buffer) => {
        if (settled) return;
        splitter.push(chunk);
        const event = splitter.next();
        if (event === undefined) return;
        if (event.kind === 'overflow') {
          finish(local('INSTANCE_UNVERIFIED', 'invalid_hello', 'the session.hello response is too long', false, false));
          return;
        }
        // The instance sends nothing unsolicited, so the splitter holds no further line yet.
        const decoded = decodeLine(event.bytes);
        const message = decoded.ok && isObject(decoded.value) ? decoded.value : undefined;
        if (message?.id !== 0) {
          finish(
            local(
              'INSTANCE_UNVERIFIED',
              'invalid_hello',
              'the session.hello response is not valid JSON-RPC',
              false,
              false,
            ),
          );
        } else if (message.error !== undefined) {
          finish(new OtcpError({ ...errorDataFrom(message.error), executed: false }));
        } else {
          const hello = verifyHello(message.result, entry);
          if (hello === null) {
            finish(
              local(
                'INSTANCE_UNVERIFIED',
                'proof_mismatch',
                'the instance at the discovered port does not match its discovery file (serverProof, instanceId or pid)',
                false,
                false,
              ),
            );
          } else if (majorOf(hello.protocol) !== SUPPORTED_MAJOR) {
            finish(
              local(
                'PROTOCOL_MISMATCH',
                'major_not_served',
                `the instance speaks OTCP ${hello.protocol}; this server speaks major ${String(SUPPORTED_MAJOR)}`,
                false,
                false,
              ),
            );
          } else {
            if (settle()) resolve(new OtcpSession(socket, hello, splitter));
          }
        }
      };
      socket.on('data', onData);
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Sends one request; resolves with its result object or rejects with OtcpError. */
  call(method: string, params: Json, timeoutMs: number): Promise<Json> {
    if (this.#closed) {
      return Promise.reject(local('CONNECTION_LOST', null, 'the connection to OpenTune is closed', false));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(local('REQUEST_TIMEOUT', null, `no response to ${method} within ${String(timeoutMs)} ms`, null));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.write(encodeLine({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close(): void {
    this.#fail(local('CONNECTION_LOST', null, 'the connection to OpenTune was closed by this server', null));
  }

  #onLine(bytes: Buffer): void {
    const decoded = decodeLine(bytes);
    if (!decoded.ok || !isObject(decoded.value)) return;
    const message = decoded.value;
    const pending = typeof message.id === 'number' ? this.#pending.get(message.id) : undefined;
    if (pending === undefined) return;
    this.#pending.delete(message.id as number);
    clearTimeout(pending.timer);
    if (message.error !== undefined) pending.reject(new OtcpError(errorDataFrom(message.error)));
    else if (isObject(message.result)) pending.resolve(message.result);
    else
      pending.reject(
        local('INTERNAL', 'invalid_response', 'OpenTune sent a response without a result object', null, false),
      );
  }

  #fail(error: OtcpError): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#socket.destroy();
  }
}

/** The section 4.3 check. Returns null when the instance is not the one the file describes. */
export function verifyHello(result: unknown, entry: DiscoveryEntry): HelloInfo | null {
  if (!isObject(result)) return null;
  const { serverProof, instanceId, pid, protocol, appVersion, capabilities } = result;
  if (typeof serverProof !== 'string' || !sameSecret(serverProof, entry.serverProof)) return null;
  if (instanceId !== entry.instanceId || pid !== entry.pid) return null;
  if (typeof protocol !== 'string' || !Array.isArray(capabilities)) return null;
  return {
    protocol,
    instanceId,
    pid,
    appVersion: typeof appVersion === 'string' ? appVersion : entry.appVersion,
    capabilities: capabilities.filter((c): c is string => typeof c === 'string'),
  };
}
