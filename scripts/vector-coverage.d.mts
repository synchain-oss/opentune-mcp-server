// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

export const DEFAULT_VECTORS_DIR: string;
export class InputError extends Error {}
export interface ParsedResult {
  runner: string;
  commit: string;
  rows: Map<string, { status: string; reason: string }>;
}
export interface MergedVector {
  id: string;
  passedBy: string[];
  failedIn: { runner: string; reason: string }[];
  skippedIn: { runner: string; reason: string }[];
  notRunIn: string[];
}
export interface Merged {
  total: number;
  covered: number;
  uncovered: string[];
  failing: string[];
  unknown: { runner: string; id: string }[];
  runners: { runner: string; commit: string; PASS: number; FAIL: number; SKIP: number; notRun: number }[];
  vectors: MergedVector[];
  ok: boolean;
}
export function loadVectorIds(dir: string): string[];
export function parseResult(value: unknown, label: string): ParsedResult;
export function mergeCoverage(ids: string[], results: ParsedResult[]): Merged;
export function formatReport(merged: Merged): string;
export function main(argv: string[], io?: { out: (s: string) => unknown; err: (s: string) => unknown }): number;
