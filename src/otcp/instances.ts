// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The instances this server can talk to: discovery on every call, one lazily opened session per
// instance (cached by instanceId, together with the capabilities its hello reported), and the
// instance-selection rule. The selection never picks an instance on its own when several run, and
// an instance_id that no longer names a running instance is an error, never a reason to switch.

import { resolveDiscoveryDir, type DirResolution } from '../discovery/dir.js';
import type { DiscoveryEntry } from '../discovery/file.js';
import type { ProcessProbe } from '../discovery/process.js';
import { scanDiscovery, type ScanResult } from '../discovery/scan.js';
import { toolError, type ToolError } from '../errors/tool-error.js';
import { OtcpSession, type Json } from './client.js';

export interface InstanceDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly probe: ProcessProbe;
  /** Opens a verified session; OtcpSession.open unless a test replaces it. */
  readonly open?: (entry: DiscoveryEntry) => Promise<OtcpSession>;
}

/** What results show about an instance (never the token, the server proof or the port). */
export function instanceSummary(entry: DiscoveryEntry): Json {
  return { instanceId: entry.instanceId, pid: entry.pid, appVersion: entry.appVersion, startedAtMs: entry.startedAtMs };
}

export type Selection =
  | { readonly ok: true; readonly entry: DiscoveryEntry }
  | { readonly ok: false; readonly error: ToolError; readonly instances: Json[] };

/**
 * Chooses the instance for a call: the one named by `instanceId`, else the one whose id starts
 * with `hint` (the instance part of a handle such as a job id), else the only one running.
 */
export function selectInstance(
  instances: readonly DiscoveryEntry[],
  instanceId: string | undefined,
  hint?: string,
): Selection {
  const list = instances.map(instanceSummary);
  const fail = (kind: string, detail: string): Selection => ({
    ok: false,
    error: toolError(kind, { detail }),
    instances: list,
  });
  if (instanceId !== undefined) {
    const entry = instances.find((i) => i.instanceId === instanceId);
    return entry
      ? { ok: true, entry }
      : fail('INSTANCE_NOT_FOUND', 'no running OpenTune instance has this instance_id');
  }
  const candidates = hint === undefined ? instances : instances.filter((i) => i.instanceId.startsWith(hint));
  const [only] = candidates;
  if (candidates.length === 1 && only) return { ok: true, entry: only };
  if (candidates.length > 1) {
    return fail(
      'MULTIPLE_INSTANCES',
      `${String(candidates.length)} OpenTune instances are running and no instance_id was given`,
    );
  }
  return hint === undefined
    ? fail('OPENTUNE_NOT_AVAILABLE', 'no running OpenTune instance with the control API was found')
    : fail('INSTANCE_NOT_FOUND', 'the OpenTune instance that issued this id is no longer running');
}

export class Instances {
  readonly #sessions = new Map<string, Promise<OtcpSession>>();
  readonly #open: (entry: DiscoveryEntry) => Promise<OtcpSession>;

  constructor(readonly deps: InstanceDeps) {
    this.#open = deps.open ?? ((entry) => OtcpSession.open(entry));
  }

  dir(): DirResolution {
    return resolveDiscoveryDir(this.deps.env, this.deps.platform, this.deps.home);
  }

  /** Scans the discovery directory and closes sessions of instances that are gone. */
  async scan(): Promise<ScanResult | ToolError> {
    const dir = this.dir();
    if (!dir.ok) return toolError('CONFIG_INVALID', { reason: 'discovery_dir', detail: dir.problem });
    let result: ScanResult;
    try {
      result = await scanDiscovery(dir.dir, this.deps.probe);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'error';
      return toolError('CONFIG_INVALID', {
        reason: 'discovery_dir',
        detail: `the discovery directory cannot be read (${code})`,
      });
    }
    const live = new Set(result.instances.map((i) => i.instanceId));
    for (const [id, session] of this.#sessions) {
      if (!live.has(id)) {
        this.#sessions.delete(id);
        void session.then(
          (s) => {
            s.close();
          },
          () => undefined,
        );
      }
    }
    return result;
  }

  /**
   * The open session of an instance, opened (or reopened after a disconnect) when needed. Calls
   * that arrive together share one opening: a call only removes the cache entry it read itself, and
   * when another call has already started a new session it waits for that one instead of opening a
   * second (which nothing would ever close, and which would hold one of OpenTune's session slots).
   */
  async session(entry: DiscoveryEntry): Promise<OtcpSession> {
    const id = entry.instanceId;
    const cached = this.#sessions.get(id);
    if (cached) {
      const session = await cached.catch(() => null);
      if (session && !session.closed) return session;
      const current = this.#sessions.get(id);
      if (current === cached) this.#sessions.delete(id);
      else if (current) return this.session(entry);
    }
    const opening = this.#open(entry);
    this.#sessions.set(id, opening);
    try {
      return await opening;
    } catch (error) {
      if (this.#sessions.get(id) === opening) this.#sessions.delete(id);
      throw error;
    }
  }

  close(): void {
    for (const session of this.#sessions.values())
      void session.then(
        (s) => {
          s.close();
        },
        () => undefined,
      );
    this.#sessions.clear();
  }
}

/** UNSUPPORTED(capability_missing) for the first capability the instance does not report, or null. */
export function missingCapability(session: OtcpSession, required: readonly string[]): ToolError | null {
  const missing = required.find((c) => !session.hello.capabilities.includes(c));
  return missing === undefined
    ? null
    : toolError('UNSUPPORTED', {
        reason: 'capability_missing',
        detail: `this OpenTune build does not report the capability ${missing}`,
      });
}
