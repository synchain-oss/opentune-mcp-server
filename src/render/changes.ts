// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The change table of a rendered write result: one row per changed, created or removed entity,
// with each changed field as before -> after and its unit. Names and labels from OpenTune stay
// JSON values of the rows; they are never placed in a sentence.
//
// What "omitted" means in a result, because three numbers carry it:
// - `omittedCount` and `omittedChangeCount` of the envelope are OpenTune's. A method lists at most
//   200 entries each in `changes`, `created` and `removed` and counts the rest: `omittedCount`
//   {changes, created, removed} per kind (content.autoTune, project.open), `omittedChangeCount` for
//   `changes` alone (content.editNotes). They count what the method left out of those lists.
// - `changeTable.omittedChangeCount` is this server's and counts every entity of the result that is not
//   a row of the table: what the method left out, plus what it listed beyond the first MAX_TABLE_ROWS
//   rows. So the rows plus this number are all the entities of the result.
// - A count in a sentence is always the real total: the entries listed plus what the method left out.

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
  /**
   * Entities of the result that are not rows: those beyond the row limit and all those the OpenTune method left
   * out of its own lists (envelope omittedCount, omittedChangeCount). rows.length plus this is the total.
   */
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

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;

/**
 * How many entities of each kind the method itself left out of `changes`, `created` and `removed`,
 * from the members of the envelope that count them (see the head of this file).
 */
export function methodOmitted(envelope: Json): Record<TableRow['kind'], number> {
  const kinds = isObject(envelope.omittedCount) ? envelope.omittedCount : {};
  return {
    changed: count(kinds.changes) + count(envelope.omittedChangeCount),
    created: count(kinds.created),
    removed: count(kinds.removed),
  };
}

export function changeTable(envelope: Json): ChangeTable {
  const rows: TableRow[] = entitiesOf(envelope).map(({ kind, item }) => ({
    kind,
    entity: asString(item.entity),
    label: asString(item.label),
    ref: item.ref ?? null,
    ...(kind === 'changed' ? { fields: fieldsOf(item.fields) } : {}),
  }));
  const left = methodOmitted(envelope);
  return {
    rows: rows.slice(0, MAX_TABLE_ROWS),
    omittedChangeCount: Math.max(0, rows.length - MAX_TABLE_ROWS) + left.changed + left.created + left.removed,
  };
}
