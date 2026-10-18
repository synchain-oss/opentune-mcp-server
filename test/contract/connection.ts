// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// One TCP connection of the vector runner to the instance under test. It counts every byte the
// server sends (for expectClosed noBytes) and queues complete lines for expect steps.

import net from 'node:net';
import { performance } from 'node:perf_hooks';

import { LineSplitter } from '../../src/otcp/framing.js';

const MAX_LINE_BYTES = 4_194_304;

export class RunnerConnection {
  readonly #socket: net.Socket;
  readonly #splitter = new LineSplitter(MAX_LINE_BYTES);
  readonly #lines: Buffer[] = [];
  readonly #listeners = new Set<() => void>();
  #closed = false;
  /** Bytes the server has sent on this connection. */
  receivedBytes = 0;
  /** receivedBytes at the end of the previous step. */
  bytesAtStepEnd = 0;
  /** Set when the server broke the framing, for example with a line longer than 4 MiB. */
  framingProblem: string | undefined;

  private constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.receivedBytes += chunk.length;
      this.#splitter.push(chunk);
      for (let event = this.#splitter.next(); event !== undefined; event = this.#splitter.next()) {
        if (event.kind === 'overflow') this.framingProblem = 'the server sent a line longer than 4194304 bytes';
        else this.#lines.push(event.bytes);
      }
      this.#notify();
    });
    const closed = () => {
      this.#closed = true;
      this.#notify();
    };
    socket.on('end', closed);
    socket.on('close', closed);
    socket.on('error', closed);
  }

  /** Connects to the literal loopback address (PROTOCOL.md section 3.1 rule 3). */
  static open(port: number): Promise<RunnerConnection> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        resolve(new RunnerConnection(socket));
      });
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  write(bytes: Buffer): void {
    if (!this.#socket.destroyed && this.#socket.writable) this.#socket.write(bytes);
  }

  /** The next unread line; 'closed' when the connection closed first, 'timeout' after `timeoutMs`. */
  async readLine(timeoutMs: number): Promise<Buffer | 'closed' | 'timeout'> {
    const ready = await this.#until(() => this.#lines.length > 0 || this.#closed, performance.now() + timeoutMs);
    const line = this.#lines.shift();
    if (line !== undefined) return line;
    return ready ? 'closed' : 'timeout';
  }

  /** Whether the connection is closed by `deadline` (a performance.now() time). */
  waitClosed(deadline: number): Promise<boolean> {
    return this.#until(() => this.#closed, deadline);
  }

  destroy(): void {
    this.#socket.destroy();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  #until(condition: () => boolean, deadline: number): Promise<boolean> {
    if (condition()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (value: boolean) => {
        clearTimeout(timer);
        this.#listeners.delete(check);
        resolve(value);
      };
      const check = () => {
        if (condition()) done(true);
      };
      const timer = setTimeout(
        () => {
          done(condition());
        },
        Math.max(0, deadline - performance.now()),
      );
      this.#listeners.add(check);
    });
  }
}
