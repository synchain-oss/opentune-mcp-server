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
//   `changes` alone (content.editNotes). They count what the method left out of those lists. A method
//   uses one of the two for `changes`, never both; when both are present, the larger one is taken.
// - `changeTable.omittedChangeCount` is this server's and counts every entity of the result that is not
//   a row of the table: what the method left out, plus what it listed beyond the first MAX_TABLE_ROWS
//   rows. So the rows plus this number are all the entities of the result.
// - A count in a sentence is always the real total: the entries listed plus what the method left out.

import type { Json } from '../otcp/client.js';

/**
 * Rows of the change table, a short preview of the first entities with each field as before -> after. The lists
 * of the envelope (MAX_LISTED entries each) carry the same entities in full, so the table is kept short.
 */
export const MAX_TABLE_ROWS = 10;

/**
 * Entries a rendered result lists in each of `changes`, `created`, `removed` and `idMap`; the rest is only counted
 * (see capEnvelope). A call on a whole song can create or remove a thousand notes, and the host refuses a result
 * that is too long as a whole, undo id included.
 */
export const MAX_LISTED = 20;

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
 * from the members of the envelope that count them (see the head of this file). The specification gives each
 * method one of the two members for `changes` (`omittedChangeCount` to content.editNotes, `omittedCount.changes`
 * to content.autoTune and project.open), never both. If both are present they count the same entries, so adding
 * them would count those twice: the larger of the two is taken.
 */
export function methodOmitted(envelope: Json): Record<TableRow['kind'], number> {
  const kinds = isObject(envelope.omittedCount) ? envelope.omittedCount : {};
  return {
    changed: Math.max(count(kinds.changes), count(envelope.omittedChangeCount)),
    created: count(kinds.created),
    removed: count(kinds.removed),
  };
}

/**
 * The envelope with each of `changes`, `created`, `removed` and `idMap` cut to MAX_LISTED entries, and what was cut
 * counted in `omittedCount` (per member, next to what the method itself left out); `omittedChangeCount`, when the
 * method sent it, is brought to the same total for `changes`. An envelope that needs no cut is returned as it is.
 * Everything else, the tokens and the undo descriptor included, is untouched. Cutting again changes nothing.
 */
export function capEnvelope(envelope: Json): Json {
  const left = methodOmitted(envelope);
  const kindOf = { changes: 'changed', created: 'created', removed: 'removed' } as const;
  const kinds = isObject(envelope.omittedCount) ? envelope.omittedCount : {};
  const lists: Json = {};
  const counts: Record<string, number> = {};
  for (const member of ['changes', 'created', 'removed', 'idMap'] as const) {
    const list = envelope[member];
    if (!Array.isArray(list) || list.length <= MAX_LISTED) continue;
    lists[member] = list.slice(0, MAX_LISTED);
    counts[member] = list.length - MAX_LISTED + (member === 'idMap' ? count(kinds.idMap) : left[kindOf[member]]);
  }
  if (Object.keys(counts).length === 0) return envelope;
  return {
    ...envelope,
    ...lists,
    omittedCount: { ...kinds, ...counts },
    ...(counts.changes !== undefined && 'omittedChangeCount' in envelope ? { omittedChangeCount: counts.changes } : {}),
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
