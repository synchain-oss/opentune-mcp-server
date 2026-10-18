// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// A minimal newline-delimited JSON-RPC client for tests. It records every raw line the server
// writes, so tests can assert that the server's stdout carries nothing but JSON-RPC messages.

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

/** True for a JSON-RPC 2.0 request, notification, result or error object. */
export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const msg = value as Record<string, unknown>;
  if (msg.jsonrpc !== '2.0') return false;
  if (typeof msg.method === 'string') return !('result' in msg) && !('error' in msg);
  if (!('id' in msg)) return false;
  return 'result' in msg !== 'error' in msg;
}

interface Waiter {
  id: string | number;
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class LineClient {
  /** Every line the server wrote, verbatim (without the newline). */
  readonly lines: string[] = [];
  /** Lines that parsed as JSON-RPC messages. */
  readonly messages: JsonRpcMessage[] = [];
  private buffer = '';
  private waiters: Waiter[] = [];

  constructor(
    private readonly writeLine: (line: string) => void,
    output: NodeJS.ReadableStream,
    private readonly timeoutMs = 10_000,
  ) {
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf('\n');
      while (newline !== -1) {
        this.onLine(this.buffer.slice(0, newline));
        this.buffer = this.buffer.slice(newline + 1);
        newline = this.buffer.indexOf('\n');
      }
    });
  }

  /** Text received after the last newline (should be empty once the server is done). */
  get pending(): string {
    return this.buffer;
  }

  send(message: Record<string, unknown>): void {
    this.writeLine(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  request(id: string | number, method: string, params: Record<string, unknown> = {}): Promise<JsonRpcMessage> {
    const response = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.id !== id);
        reject(new Error(`no response to ${method} (id ${String(id)}) within ${String(this.timeoutMs)} ms`));
      }, this.timeoutMs);
      this.waiters.push({ id, resolve, reject, timer });
    });
    this.send({ id, method, params });
    return response;
  }

  private onLine(line: string): void {
    this.lines.push(line);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isJsonRpcMessage(parsed)) return;
    this.messages.push(parsed);
    const id = parsed.id;
    if (id === undefined || id === null || parsed.method !== undefined) return;
    const waiter = this.waiters.find((w) => w.id === id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters = this.waiters.filter((w) => w !== waiter);
    waiter.resolve(parsed);
  }
}
