// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The change table of a rendered write result: one row per changed, created or removed entity,
// with each changed field as before -> after and its unit. Names and labels from OpenTune stay
// JSON values of the rows; they are never placed in a sentence.

import type { Json } from '../otcp/client.js';

/** Rows a rendered result lists; the rest is only counted. */
export const MAX_TABLE_ROWS = 20;

export interface TableField {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly unit: string | null;
}

export interface TableRow {
  readonly kind: 'changed' | 'created' | 'removed';
  readonly entity: string | null;
  readonly label: string | null;
  readonly ref: unknown;
  /** Only for kind changed. */
  readonly fields?: readonly TableField[];
}

export interface ChangeTable {
  readonly rows: readonly TableRow[];
  /** Entities not listed: those beyond the row limit and those the OpenTune method did not list. */
  readonly omittedChangeCount: number;
}

export const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
export const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function fieldsOf(value: unknown): TableField[] {
  if (!isObject(value)) return [];
  return Object.entries(value).map(([field, entry]) => {
    const f = isObject(entry) ? entry : {};
    return { field, before: f.before ?? null, after: f.after ?? null, unit: asString(f.unit) };
  });
}

/** The entities of a result in table order: changed, then created, then removed. */
export function entitiesOf(envelope: Json): { kind: TableRow['kind']; item: Json }[] {
  const out: { kind: TableRow['kind']; item: Json }[] = [];
  for (const [member, kind] of [
    ['changes', 'changed'],
    ['created', 'created'],
    ['removed', 'removed'],
  ] as const) {
    for (const item of asList(envelope[member])) out.push({ kind, item: isObject(item) ? item : {} });
  }
  return out;
}

export function changeTable(envelope: Json): ChangeTable {
  const rows: TableRow[] = entitiesOf(envelope).map(({ kind, item }) => ({
    kind,
    entity: asString(item.entity),
    label: asString(item.label),
    ref: item.ref ?? null,
    ...(kind === 'changed' ? { fields: fieldsOf(item.fields) } : {}),
  }));
  const own = envelope.omittedChangeCount;
  const listedByMethod = typeof own === 'number' && Number.isInteger(own) && own > 0 ? own : 0;
  return {
    rows: rows.slice(0, MAX_TABLE_ROWS),
    omittedChangeCount: Math.max(0, rows.length - MAX_TABLE_ROWS) + listedByMethod,
  };
}
