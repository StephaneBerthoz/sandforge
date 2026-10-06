/**
 * What a sync run would do with one object, worked out from what a
 * simulation read, without writing anything.
 *
 * The simulation reads the source exactly as the run does — the same query,
 * the rows left to the platform, the mappings, transforms and add-ons, and on
 * a bidirectional run the same conflict detection against the target. What
 * the run leaves to the target, the simulation asks it: whether it holds the
 * key each record would be written on. That answer is what an upsert, an
 * update or a delete does, so it is what decides each record's line here.
 *
 * What it cannot ask is everything the target decides as it saves: a
 * validation rule, a duplicate rule, a required field, a trigger. A record
 * one of those would refuse is counted as the run would send it.
 */

import type { ConflictRecord, SyncObjectConfig, SyncObjectSimulation } from '@sandforge/shared';
import { sanitizeSoqlObjectName } from '@sandforge/shared';
import { leftToThePlatformNote, type RowsLeftOut } from '../../core/common/platformRecords.js';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { queryAllPages, type PagedQuerySource } from '../forge/queryAllPages.js';

/** Most fields named as differing on an object's conflicts. */
const MAX_CONFLICT_FIELDS = 10;

/**
 * The field a write of `objectConfig` finds its record by in the target, or
 * `null` for an insert, which finds none. An upsert matches on its External
 * ID field, an update and a delete on `Id` — as `DataSync` sends them.
 */
export function targetKeyOf(objectConfig: SyncObjectConfig): string | null {
  switch (objectConfig.operation) {
    case 'insert':
      return null;
    case 'upsert':
      return objectConfig.externalIdField ?? 'Id';
    case 'update':
    case 'delete':
      return 'Id';
  }
}

/**
 * A key value as the target matches it, or `null` when the record carries
 * none. Lower-cased: the platform matches a text External ID regardless of
 * case unless the field says otherwise, and an 18-character record id stays
 * unique in any case.
 */
export function simulationKey(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return null;
  }
  const text = String(value);
  return text === '' ? null : text.toLowerCase();
}

/**
 * A key as a SOQL literal: a number or a checkbox bare, as the field compares
 * it, and text quoted and escaped. A number field compared with a quoted
 * value is refused by the platform, and text left bare is not a value.
 */
export function soqlLiteral(value: string | number | boolean): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `'${sanitizeSoqlValue(String(value))}'`;
}

/** Most keys in one lookup query, and most characters of their literals. */
const KEYS_PER_LOOKUP = 200;
const LOOKUP_CHARACTERS = 4_000;

/**
 * `keys` in groups small enough for one `IN (…)` each. A query travels in the
 * address of a GET, which the platform stops reading somewhere past sixteen
 * thousand characters, so a group is bounded by its length as well as by its
 * count: two hundred record ids come to some four thousand.
 */
export function keyBatches<T extends string | number | boolean>(keys: readonly T[]): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let length = 0;
  for (const key of keys) {
    const size = soqlLiteral(key).length + 2;
    if (
      batch.length > 0 &&
      (batch.length >= KEYS_PER_LOOKUP || length + size > LOOKUP_CHARACTERS)
    ) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(key);
    length += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * What a simulation asks the target in place of the write: how many of its
 * records hold each of the keys the simulated records carry, by the key as
 * {@link simulationKey} gives it. A key the target does not hold is absent.
 *
 * Counted, not merely found: an External ID field need not be unique, and an
 * upsert whose key matches two target records updates neither — the platform
 * refuses it. Run against a target that earlier copies had filled, a key
 * held once in the source was held eight times on average in the target.
 *
 * By key, a few hundred at a time, rather than the whole target object: an
 * upsert matches across the whole object, whatever filter the read used, and
 * a target can hold far more than the subset being synced.
 *
 * @param target - The target org's paged query.
 * @param signal - The simulation's cancel, honoured between two lookups.
 */
export function targetLookup(
  target: PagedQuerySource<Record<string, unknown>>,
  signal?: AbortSignal,
): (
  orgId: string,
  objectConfig: SyncObjectConfig,
  keyField: string,
  keys: readonly (string | number | boolean)[],
) => Promise<ReadonlyMap<string, number>> {
  return async (_orgId, objectConfig, keyField, keys) => {
    const object = sanitizeSoqlObjectName(objectConfig.objectApiName);
    const field = assertSoqlIdentifier(keyField);
    const held = new Map<string, number>();
    for (const batch of keyBatches(keys)) {
      if (signal?.aborted) throw new Error('The simulation was cancelled.');
      const { records } = await queryAllPages(
        target,
        `SELECT ${field} FROM ${object} WHERE ${field} IN (${batch.map(soqlLiteral).join(', ')})`,
      );
      for (const row of records) {
        const key = simulationKey(row[field]);
        if (key !== null) held.set(key, (held.get(key) ?? 0) + 1);
      }
    }
    return held;
  };
}

/** What {@link simulateObjectOutcome} reads. */
export interface ObjectSimulationInput {
  /** The object as the configuration runs it. */
  readonly objectConfig: SyncObjectConfig;
  /** Rows the source read returned. */
  readonly read: number;
  /** The records the run's write would be handed, after any conflict was settled. */
  readonly records: readonly Record<string, unknown>[];
  /** The rows the read leaves to the platform, by reason. */
  readonly leftOut: readonly RowsLeftOut[];
  /**
   * How many target records hold each key the records carry in
   * {@link targetKeyOf}'s field, by the key as {@link simulationKey} gives it;
   * a key the target does not hold is absent. Not read for an insert.
   */
  readonly inTarget: ReadonlyMap<string, number>;
  /**
   * On a bidirectional run: the records both orgs hold with different values,
   * as the run detects them, and the records as they were before the strategy
   * settled them. Empty on a run that writes source to target.
   */
  readonly conflicts: readonly ConflictRecord[];
  readonly unsettled: readonly Record<string, unknown>[];
  /** The field the run matched those conflicts on. */
  readonly matchField: string;
  /**
   * The fields the target lets a write carry, from its describe, or `null`
   * when it could not say — the write then sends every field it was given.
   */
  readonly writable: ReadonlySet<string> | null;
}

/** Fields no write carries, whatever a comparison finds on them. */
const NEVER_WRITTEN: ReadonlySet<string> = new Set(['attributes', 'Id']);

/**
 * The fields a conflict differs on that the run would write: the source
 * record carries them and the target takes them. A comparison of every field
 * read finds the audit fields and the target's own record id different on
 * every record; none of them is written, so none of them is a conflict
 * anybody has to settle.
 */
function writtenConflictFields(
  conflict: ConflictRecord,
  sent: Record<string, unknown> | undefined,
  matchField: string,
  writable: ReadonlySet<string> | null,
): string[] {
  if (!sent) return [];
  return conflict.conflictFields.filter(
    (field) =>
      field !== matchField &&
      !NEVER_WRITTEN.has(field) &&
      field in sent &&
      (writable === null || writable.has(field)),
  );
}

/** One object's line of a simulation, from what was read of both orgs. */
export function simulateObjectOutcome(input: ObjectSimulationInput): SyncObjectSimulation {
  const { objectConfig, records, inTarget } = input;
  const operation = objectConfig.operation;
  const keyField = targetKeyOf(objectConfig);
  const counts = {
    insert: 0,
    update: 0,
    delete: 0,
    noKey: 0,
    notInTarget: 0,
    notSent: 0,
    ambiguous: 0,
  };
  // The records whose values reach the target, by their position: only
  // those can be in a conflict anybody has to settle.
  const written = new Set<number>();

  records.forEach((record, index) => {
    if (keyField === null) {
      counts.insert++;
      written.add(index);
      return;
    }
    const key = simulationKey(record[keyField]);
    if (key === null) {
      // A delete sends ids alone: a record without one is not sent at all.
      if (operation === 'delete') counts.notSent++;
      else counts.noKey++;
      return;
    }
    const held = inTarget.get(key) ?? 0;
    if (operation === 'upsert') {
      if (held === 0) {
        counts.insert++;
        written.add(index);
      } else if (held === 1) {
        counts.update++;
        written.add(index);
      } else {
        counts.ambiguous++;
      }
    } else if (held === 0) {
      counts.notInTarget++;
    } else if (operation === 'update') {
      counts.update++;
      written.add(index);
    } else {
      counts.delete++;
    }
  });

  const notes = input.leftOut.map(({ why, count }) => leftToThePlatformNote(count, why));
  if (counts.noKey > 0) {
    notes.push(
      operation === 'upsert'
        ? `${counts.noKey} record(s) carry no value in ${keyField}: an upsert matches on it, ` +
            `and the target refuses a record without one.`
        : `${counts.noKey} record(s) carry no Id: an update finds its record by Id, and the ` +
            `target refuses one without it.`,
    );
  }
  if (counts.notInTarget > 0) {
    notes.push(
      `${counts.notInTarget} record(s) carry an Id the target does not hold: ` +
        `${operation === 'update' ? 'an update' : 'a delete'} finds no record there, and the ` +
        `target refuses it. Two orgs share a record's Id only when it was copied with the org.`,
    );
  }
  if (counts.ambiguous > 0) {
    notes.push(
      `${counts.ambiguous} record(s) match more than one record of the target on ${keyField}: ` +
        `an upsert finds no single record to update, and the target refuses it.`,
    );
  }
  if (counts.notSent > 0) {
    notes.push(
      `${counts.notSent} record(s) carry no Id: a delete sends ids alone, so the run leaves them out.`,
    );
  }

  const sentByKey = new Map<string, Record<string, unknown>>();
  input.unsettled.forEach((record, index) => {
    const key = String(record[input.matchField] ?? '');
    if (key && written.has(index)) sentByKey.set(key, record);
  });
  const frequency = new Map<string, number>();
  let conflicts = 0;
  for (const conflict of input.conflicts) {
    const fields = writtenConflictFields(
      conflict,
      sentByKey.get(conflict.recordId),
      input.matchField,
      input.writable,
    );
    if (fields.length === 0) continue;
    conflicts++;
    for (const field of fields) frequency.set(field, (frequency.get(field) ?? 0) + 1);
  }
  const conflictFields = [...frequency]
    .sort(([a, na], [b, nb]) => nb - na || a.localeCompare(b))
    .slice(0, MAX_CONFLICT_FIELDS)
    .map(([field]) => field);

  const leftOut = input.leftOut.reduce((sum, { count }) => sum + count, 0);
  return {
    objectApiName: objectConfig.objectApiName,
    operation,
    read: input.read,
    insert: counts.insert,
    update: counts.update,
    delete: counts.delete,
    skipped: leftOut + counts.notSent,
    refused: counts.noKey + counts.notInTarget + counts.ambiguous,
    conflicts,
    conflictFields,
    notes,
  };
}
