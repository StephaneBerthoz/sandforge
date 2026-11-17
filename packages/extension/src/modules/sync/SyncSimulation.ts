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
 * What the write holds back before it sends anything — a record type it
 * cannot write, a row under a parent the run refused — the simulation holds
 * back too, from the same preparation (`prepareSyncRows`); and what the target
 * refuses on every row that carries it, known from its describe, it counts as
 * refused, as Forge's simulation finds it (`rowGapsOf`): a field the target
 * requires left empty, a text longer than its field, a number past its field's
 * places; and a value of a field the target keeps unique that it holds
 * already, or that a record sent before holds; and an upsert's key two
 * records of one call carry (`repeatedKeysOf`). A row it refuses is the
 * refused parent of the rows under it.
 *
 * What it cannot ask is the rest of what the target decides as it saves: a
 * validation rule, a duplicate rule, a trigger. A record one of those would
 * refuse is counted as the run would send it.
 */

import type {
  ConflictRecord,
  SyncObjectConfig,
  SyncObjectSimulation,
  SyncSimulatedRefusal,
} from '@sandforge/shared';
import { sanitizeSoqlObjectName } from '@sandforge/shared';
import { leftToThePlatformNote, type RowsLeftOut } from '../../core/common/platformRecords.js';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { queryAllPages, type PagedQuerySource } from '../forge/queryAllPages.js';
import type { FieldInfo } from '../forge/ForgeExecutor.js';
import { SimulationGaps, rowGapsOf } from '../forge/stages/SimulationGaps.js';

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
   * What the write does with each of `records`, in their order, where the
   * caller told it beyond what the target holds — an upsert's record that
   * updates what a record of an earlier call created (`repeatedKeysOf`).
   * Told from `inTarget` when absent.
   */
  readonly simulated?: readonly SimulatedRecord[];
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

/**
 * What the write would do with one record, as a simulation tells it from the
 * key it carries and what the target holds of it: create it, update or delete
 * the one record its key finds, refuse it — no key, a key the target does not
 * hold, or one it holds more than once — or, for a delete, leave it out.
 */
export type SimulatedRecord =
  'insert' | 'update' | 'delete' | 'noKey' | 'notInTarget' | 'notSent' | 'ambiguous';

/** The kinds of {@link SimulatedRecord} the target refuses. */
export const REFUSED_BY_THE_TARGET: ReadonlySet<SimulatedRecord> = new Set([
  'noKey',
  'notInTarget',
  'ambiguous',
]);

/** What the write would do with one record: see {@link SimulatedRecord}. */
export function simulateRecord(
  objectConfig: SyncObjectConfig,
  record: Record<string, unknown>,
  inTarget: ReadonlyMap<string, number>,
): SimulatedRecord {
  const operation = objectConfig.operation;
  const keyField = targetKeyOf(objectConfig);
  if (keyField === null) return 'insert';
  const key = simulationKey(record[keyField]);
  // A delete sends ids alone: a record without one is not sent at all.
  if (key === null) return operation === 'delete' ? 'notSent' : 'noKey';
  const held = inTarget.get(key) ?? 0;
  if (operation === 'upsert') {
    // On the Id, an upsert updates the record of that id and creates none:
    // the platform never takes an id it is given for a new record, and the
    // id is the source's. Counted created, a dry run said N inserts and exit
    // 0 of rows the run then had refused.
    if (held === 0) return keyField.toLowerCase() === 'id' ? 'notInTarget' : 'insert';
    return held === 1 ? 'update' : 'ambiguous';
  }
  if (held === 0) return 'notInTarget';
  return operation === 'update' ? 'update' : 'delete';
}

/**
 * Rows of a Bulk API 2.0 job the platform writes as one batch of its own: it
 * splits the data of a job in batches of ten thousand rows.
 */
export const BULK_JOB_BATCH_ROWS = 10_000;

/** How a write sends an object's records: the call each goes in, and whether the calls are one job's. */
export interface WriteCalls {
  /** The call the record at a position of the write goes in, from 0, in the order sent. */
  readonly callOf: (position: number) => number;
  /** Whether the calls are the batches of one Bulk API job, which the platform may write at once. */
  readonly job: boolean;
}

/**
 * The calls a write sends `rows` records of an object in, as `BulkDataWriter`
 * sends them: up to its Bulk API threshold, REST calls of the object's batch
 * size, one after the other; past it, one Bulk API job, which the platform
 * writes in batches of {@link BULK_JOB_BATCH_ROWS} rows.
 */
export function writeCallsOf(rows: number, batchSize: number, bulkThreshold: number): WriteCalls {
  const size = rows > bulkThreshold ? BULK_JOB_BATCH_ROWS : Math.max(1, batchSize);
  return { callOf: (position) => Math.floor(position / size), job: rows > bulkThreshold };
}

/** What {@link repeatedKeysOf} finds of the records an upsert sends. */
export interface RepeatedKeys {
  /** The positions of the records the target refuses: another of their call carries their key. */
  readonly refused: ReadonlySet<number>;
  /** Those it updates: a record of an earlier call carries their key and created its record. */
  readonly updated: ReadonlySet<number>;
  readonly notes: string[];
  readonly refusedFor: SyncSimulatedRefusal[];
}

/**
 * Of the records an upsert sends, in the order sent, those whose key another
 * of them carries, and what the target does with them:
 *
 * - in the same call, it refuses every one of them, each `DUPLICATE_VALUE:
 *   Duplicate external id specified`. Run between two scratch orgs, two leads
 *   of the source with one e-mail address, upserted on Email, were counted two
 *   to create by the dry run; the run had both refused in the one call they
 *   went in;
 * - in a later REST call, the upsert finds the record the earlier one created
 *   and updates it: two records of the source end as one in the target;
 * - in another batch of a Bulk API job, which the platform may write at the
 *   same time as the first, what it does cannot be told before the run: they
 *   stay counted as the target's holdings say, and a note says so.
 *
 * A record without a key is left to {@link simulateRecord}.
 *
 * @param keyField - The field the upsert matches on.
 * @param keys - The key each record carries, as {@link simulationKey} gives it.
 * @param simulated - What the write does with each record, from what the target holds.
 * @param calls - The calls the write sends them in.
 */
export function repeatedKeysOf(
  keyField: string,
  keys: readonly (string | null)[],
  simulated: readonly SimulatedRecord[],
  calls: WriteCalls,
): RepeatedKeys {
  const ofCall = new Map<string, number[]>();
  keys.forEach((key, position) => {
    if (key === null) return;
    const at = `${calls.callOf(position)}\u0000${key}`;
    const positions = ofCall.get(at);
    if (positions) positions.push(position);
    else ofCall.set(at, [position]);
  });
  const refused = new Set<number>();
  for (const positions of ofCall.values()) {
    if (positions.length > 1) for (const position of positions) refused.add(position);
  }
  // The call that created a record of each key, as the calls go one after the other.
  const createdIn = new Map<string, number>();
  const updated = new Set<number>();
  let apart = 0;
  keys.forEach((key, position) => {
    if (key === null || refused.has(position)) return;
    const call = calls.callOf(position);
    const earlier = createdIn.get(key);
    if (earlier === undefined) {
      if (simulated[position] === 'insert') createdIn.set(key, call);
      return;
    }
    if (calls.job) apart++;
    else if (simulated[position] === 'insert') updated.add(position);
  });
  const notes: string[] = [];
  const refusedFor: SyncSimulatedRefusal[] = [];
  if (refused.size > 0) {
    const note =
      `${refused.size} record(s) carry the ${keyField} of another record of the same call: ` +
      `an upsert finds its record by its key, and the target refuses every record of a call ` +
      `whose key another carries (DUPLICATE_VALUE: Duplicate external id specified).`;
    notes.push(note);
    refusedFor.push({ code: 'DUPLICATE_VALUE', rows: refused.size, note });
  }
  if (updated.size > 0) {
    notes.push(
      `${updated.size} record(s) carry the ${keyField} of a record sent in an earlier call: ` +
        `the upsert finds the record that one created and updates it with theirs.`,
    );
  }
  if (apart > 0) {
    notes.push(
      `${apart} record(s) carry the ${keyField} of a record in another batch of the Bulk API ` +
        `job: the platform may write the batches at once, so whether each updates the ` +
        `record the other created or creates one of its own cannot be told before the run.`,
    );
  }
  return { refused, updated, notes, refusedFor };
}

/** One object's line of a simulation, from what was read of both orgs. */
export function simulateObjectOutcome(input: ObjectSimulationInput): SyncObjectSimulation {
  const { objectConfig, records, inTarget } = input;
  const operation = objectConfig.operation;
  const keyField = targetKeyOf(objectConfig);
  const counts: Record<SimulatedRecord, number> = {
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
    const simulated = input.simulated?.[index] ?? simulateRecord(objectConfig, record, inTarget);
    counts[simulated]++;
    if (simulated === 'insert' || simulated === 'update') written.add(index);
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
        `${
          operation === 'upsert'
            ? 'an upsert on the Id finds no record there and creates none'
            : `${operation === 'update' ? 'an update' : 'a delete'} finds no record there`
        }, and the target refuses it. Two orgs share a record's Id only when it was copied ` +
        `with the org.`,
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

/** One payload a write would send, as the row checks read it. */
export interface PayloadToCheck {
  /** What is sent. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** The row as the source read it: whether it is a person account's. */
  readonly source: Readonly<Record<string, unknown>>;
  /**
   * Whether the write creates the record: only a record created is refused
   * for a field the target requires left out, an update keeping its value.
   */
  readonly creates: boolean;
}

/** The status code the target refuses rows with for each kind of gap {@link refusalNote} says. */
const GAP_CODES: Readonly<Record<string, string>> = {
  required_field_missing: 'REQUIRED_FIELD_MISSING',
  value_too_long: 'STRING_TOO_LONG',
  number_out_of_range: 'NUMBER_OUTSIDE_VALID_RANGE',
};

/** How a gap the target refuses rows for reads, counted. */
function refusalNote(gap: {
  kind: string;
  field?: string;
  rows: number;
  detail?: Record<string, unknown>;
}): string | undefined {
  const field = gap.field ?? '';
  switch (gap.kind) {
    case 'required_field_missing':
      return (
        `${gap.rows} record(s) leave ${field} empty, which the target requires: it refuses ` +
        `them (REQUIRED_FIELD_MISSING).`
      );
    case 'value_too_long':
      return (
        `${gap.rows} record(s) hold a ${field} longer than the ${String(gap.detail?.length)} ` +
        `characters the target's field takes (the longest, ${String(gap.detail?.longest)}): it ` +
        `refuses them (STRING_TOO_LONG).`
      );
    case 'number_out_of_range':
      return (
        `${gap.rows} record(s) hold a ${field} larger than the target's field takes: it refuses ` +
        `them (NUMBER_OUTSIDE_VALID_RANGE).`
      );
    default:
      return undefined;
  }
}

/**
 * Of the payloads a write would send, those the target refuses whatever else
 * they hold, as Forge's simulation finds them against the target's describe
 * (`rowGapsOf`): a field it requires left empty, a text longer than its field,
 * a number past its field's places. The target refuses those on every row, so
 * the simulation says so rather than count them written, and says each kind
 * once, with how many rows it refuses.
 *
 * @returns The positions of the payloads refused, the notes, and each note's code.
 */
export function refusedOnTheirFields(
  objectApiName: string,
  rows: readonly PayloadToCheck[],
  fields: readonly FieldInfo[],
): { refused: Set<number>; notes: string[]; refusedFor: SyncSimulatedRefusal[] } {
  const refused = new Set<number>();
  const found = new SimulationGaps();
  rows.forEach(({ payload, source, creates }, position) => {
    const ofRow = new SimulationGaps();
    rowGapsOf(
      {
        objectApiName,
        rows: [{ payload, source, typed: true }],
        targetFields: fields,
        picklistValuesByField: null,
        picklistFields: new Map(),
      },
      ofRow,
    );
    const blocking = ofRow
      .list(new Set())
      .filter(
        (gap) => gap.severity === 'blocking' && (creates || gap.kind !== 'required_field_missing'),
      );
    if (blocking.length === 0) return;
    refused.add(position);
    // Its id and source are given again by the collector.
    for (const gap of blocking) found.add(gap);
  });
  const refusedFor = found.list(new Set()).flatMap((gap): SyncSimulatedRefusal[] => {
    const note = refusalNote(gap);
    const code = GAP_CODES[gap.kind];
    return note && code ? [{ code, rows: gap.rows, note }] : [];
  });
  return { refused, notes: refusedFor.map(({ note }) => note), refusedFor };
}

/**
 * Of the records a write would create, in the order it sends them, those a
 * field the target keeps unique refuses (`DUPLICATE_VALUE`), as Forge's
 * simulation finds a unique value the target holds already: a value the
 * target holds, or one a record sent before it in the run holds. Run against
 * a target that keeps an external id unique where the source does not, the
 * second of two accounts sharing one was refused, and what hung from it with
 * it, while the simulation had counted both written.
 *
 * A value one record of the target holds has the row linked to that record,
 * as the run links it: the target names the record it refuses the row for,
 * and what hangs from the row follows it there. One a record sent before it
 * holds is refused: the target names no record of its own write.
 *
 * @param rows - The payloads the write would create, in the order sent.
 * @param heldByField - Per unique field, how many target records hold each
 *   value the rows carry, by the value as {@link simulationKey} gives it.
 * @returns The positions of the rows refused and of those linked, a note
 *   per field, and the code of each note that counts rows refused.
 */
export function refusedOnUniqueValues(
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  heldByField: ReadonlyMap<string, ReadonlyMap<string, number>>,
): {
  refused: Set<number>;
  linked: Set<number>;
  notes: string[];
  refusedFor: SyncSimulatedRefusal[];
} {
  const refused = new Set<number>();
  const linked = new Set<number>();
  const notes: string[] = [];
  const refusedFor: SyncSimulatedRefusal[] = [];
  for (const [field, held] of heldByField) {
    const seen = new Set<string>();
    let linkedHere = 0;
    let inTarget = 0;
    let twice = 0;
    rows.forEach((payload, position) => {
      const key = simulationKey(payload[field]);
      if (key === null) return;
      const holding = held.get(key) ?? 0;
      if (holding === 1) {
        linkedHere++;
        linked.add(position);
      } else if (holding > 1) {
        inTarget++;
        refused.add(position);
      } else if (seen.has(key)) {
        twice++;
        refused.add(position);
      }
      seen.add(key);
    });
    if (linkedHere > 0) {
      notes.push(
        `LINKED_TO_EXISTING: ${linkedHere} record(s) hold a ${field} the target keeps unique, ` +
          `which a record of the target holds already: it refuses them as duplicates ` +
          `(DUPLICATE_VALUE) and names that record, which the run links them to — what it ` +
          `writes under them points at that record.`,
      );
    }
    if (inTarget + twice === 0) continue;
    const note =
      `${inTarget + twice} record(s) hold a ${field} the target keeps unique, which ` +
      [
        inTarget > 0 ? `several records of the target hold already (${inTarget})` : '',
        twice > 0 ? `a record sent before them holds (${twice})` : '',
      ]
        .filter(Boolean)
        .join(' or ') +
      `: it refuses them (DUPLICATE_VALUE).`;
    notes.push(note);
    refusedFor.push({ code: 'DUPLICATE_VALUE', rows: inTarget + twice, note });
  }
  // Refused on one field, a row is not linked by another: which record, if
  // any, the target would name cannot be told.
  for (const position of refused) linked.delete(position);
  return { refused, linked, notes, refusedFor };
}
