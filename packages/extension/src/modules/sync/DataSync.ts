import type { SyncObjectConfig, SyncObjectResult, SyncOperation } from '@sandforge/shared';
import type { CrudFlsGuard, CrudOperation } from '../../core/metadata/CrudFlsGuard.js';
import type { SaveErrorDetail } from '../../core/common/existingRecordMatch.js';
import {
  addWrittenWithoutFields,
  fieldsLeftOutNote,
  refusedFields,
  type FieldToLeaveOut,
  type WrittenWithoutFields,
} from '../../core/common/refusedFields.js';
import {
  addressedBy,
  prepareSyncRows,
  type DeferredLookup,
  type SyncWriteRun,
} from './syncRowPreparation.js';
import type { TargetWriteFields } from './targetWriteFields.js';
import { WriteCancelledError } from './WriteCancelledError.js';

/** Function to upsert records using an external ID field */
export type UpsertFn = (
  objectName: string,
  externalIdField: string,
  records: Record<string, unknown>[],
  batchSize: number,
) => Promise<OperationOutcome[]>;

/** Function to insert records */
export type InsertFn = (
  objectName: string,
  records: Record<string, unknown>[],
  batchSize: number,
) => Promise<OperationOutcome[]>;

/** Function to update records */
export type UpdateFn = (
  objectName: string,
  records: Record<string, unknown>[],
  batchSize: number,
) => Promise<OperationOutcome[]>;

/** Function to delete records by IDs */
export type DeleteFn = (
  objectName: string,
  recordIds: string[],
  batchSize: number,
) => Promise<OperationOutcome[]>;

/** Outcome for a single record operation */
export interface OperationOutcome {
  id?: string;
  success: boolean;
  errors: string[];
  /**
   * The record the target already holds, when it refused this one as a
   * duplicate and named exactly one record of the object — see
   * `existingRecordOf`. A writer that links children reads it; one that does
   * not can leave it alone.
   */
  existingId?: string;
  /**
   * For an upsert the org wrote: whether it created the record (true) or
   * updated the one it found (false). Absent when the write does not say.
   */
  created?: boolean;
  /**
   * Every error the org refused the record with, each with its code and the
   * fields it named — `errors` may report the first alone — when one of them
   * named a field: what a writer reads to send the record again without the
   * fields a validation rule or a restricted picklist refused it on
   * (`refusedFields`). Absent when none named one, which leaves no field to
   * send it without.
   */
  errorDetails?: SaveErrorDetail[];
  /**
   * Set on a record the write held back and never sent — its record type
   * cannot be written, or a record it names was refused earlier in the run —
   * `errors` saying why. Counted as failed; the result says the reason once
   * per kind, with how many records it held, rather than once per record.
   */
  heldBack?: true;
}

/** Dependencies required by DataSync */
export interface DataSyncDeps {
  upsert: UpsertFn;
  insert: InsertFn;
  update: UpdateFn;
  delete: DeleteFn;
  /**
   * What the TARGET org will take on a write, per object.
   *
   * Without it a sync sends every field it read. `SELECT FIELDS(ALL)` returns
   * the audit fields, the compound address fields and every formula and
   * roll-up the object carries, and Salesforce refuses the whole record:
   * "Unable to create/update fields: LastModifiedDate, CreatedById,
   * BillingAddress, …". Run for real between two orgs, that is every record of
   * every object — a sync that cannot finish a single job, which is what a
   * beta tester reported and what no test had ever seen, because every test
   * supplied mappings and the mapped path builds its payload from those alone.
   *
   * Asked of the target rather than the source on purpose: a field the source
   * lets you write is not necessarily one the target does, and the run is
   * decided at the target.
   *
   * `references` names the lookups among them. A lookup carries an id from
   * the SOURCE org, which means nothing in the target unless the two happen
   * to share that record — so Salesforce answers
   * `insufficient access rights on cross-reference id` and loses the whole
   * row over one field. Knowing which fields those are is what lets the write
   * be tried again without them.
   *
   * The same describe carries the record types the running user may use,
   * and of the account whether the target has person accounts: see
   * `prepareSyncRows`.
   *
   * Optional, so a caller that cannot describe keeps the previous behaviour.
   */
  describeTargetFields?: (objectApiName: string) => Promise<TargetWriteFields>;
  /** Optional CRUD/FLS guard. When provided, permissions are re-verified before each DML operation. */
  crudFlsGuard?: CrudFlsGuard;
}

/**
 * Core data synchronization service between Salesforce orgs.
 * Takes source records, applies field mappings and add-on fields,
 * then writes to the target org using the appropriate operation.
 */
export class DataSync {
  private readonly deps: DataSyncDeps;

  constructor(deps: DataSyncDeps) {
    this.deps = deps;
  }

  /**
   * Synchronize records for a single object configuration.
   * Applies field mappings and add-on fields, then performs the specified operation.
   *
   * @param run - The run the write is part of: what it wrote and refused
   *   before, the source rows, both orgs' record types. See {@link write}.
   */
  async sync(
    config: SyncObjectConfig,
    sourceRecords: Record<string, unknown>[],
    run?: SyncWriteRun,
  ): Promise<SyncObjectResult> {
    const { outcomes, notes } = await this.write(config, sourceRecords, run);
    return buildObjectResult(config.objectApiName, config.operation, outcomes, notes);
  }

  /**
   * What {@link sync} does, reported record by record: one outcome per record,
   * in the order the records were given, and the notes the result carries.
   * Real-time replication reads it to say which change reached the target.
   *
   * What each record sends, and the records held back before the write, are
   * `prepareSyncRows`': the fields the target takes, without those the kind of
   * account leaves out; the record type mapped to the target's, a row whose
   * type cannot go held back; given the run, a lookup at a record it wrote
   * naming the copy, a row whose lookup names a record it refused held back.
   * Given the run, what the write wrote and refused is added to it, for the
   * objects written after.
   */
  async write(
    config: SyncObjectConfig,
    sourceRecords: Record<string, unknown>[],
    run?: SyncWriteRun,
  ): Promise<{ outcomes: OperationOutcome[]; notes: string[] }> {
    // What the target will take. A failure to describe is not a reason to
    // stop: the run then behaves as it did before this existed.
    let target: TargetWriteFields | null = null;
    if (this.deps.describeTargetFields) {
      try {
        const answer = await this.deps.describeTargetFields(config.objectApiName);
        // An empty creatable set means the describe could not say, not that
        // the object takes no field: filtering on it would send an empty
        // record to every row.
        target = answer.creatable.size > 0 ? answer : null;
      } catch {
        target = null;
      }
    }

    const prepared = prepareSyncRows({ config, records: sourceRecords, target, run });
    const heldAt = new Map(prepared.held.map(({ index, reason }) => [index, reason]));
    /**
     * One outcome per record handed over, in their order: the held ones'
     * own, the others' as the write answered them. A write a cancel stopped
     * answers the records it sent before it: the outcomes stop at the first
     * record it did not reach.
     */
    const aligned = (sent: readonly OperationOutcome[]): OperationOutcome[] => {
      const out: OperationOutcome[] = [];
      let next = 0;
      for (let index = 0; index < sourceRecords.length; index++) {
        const reason = heldAt.get(index);
        if (reason !== undefined) {
          out.push({ success: false, errors: [reason], heldBack: true });
          continue;
        }
        if (next >= sent.length) break;
        out.push(sent[next++]);
      }
      return out;
    };

    let outcomes: OperationOutcome[];
    try {
      // Every record held back: nothing is sent.
      outcomes =
        prepared.payloads.length === 0 && sourceRecords.length > 0
          ? []
          : await this.executeOperation(
              config.objectApiName,
              config.operation,
              prepared.payloads,
              config.batchSize,
              config.externalIdField,
            );
    } catch (err: unknown) {
      if (!(err instanceof WriteCancelledError)) throw err;
      // The cancel stopped the write before one of its batches: the records
      // sent before it are written, and what was held back is said with them.
      throw new WriteCancelledError(config.objectApiName, aligned(err.written), [
        ...prepared.notes,
        ...err.notes,
      ]);
    }

    const retried = await this.retryRefused(
      config,
      prepared.payloads,
      outcomes,
      target?.references ?? null,
      prepared.settled,
    );

    const all = aligned(retried.outcomes);
    const notes = [...prepared.notes, ...retried.notes];
    // Every record has been sent once, and keeps its refusal unless it was
    // tried again before the cancel: the run is told all of it, what was
    // dropped to write it, and that it was cancelled.
    if (retried.cancelled) {
      throw new WriteCancelledError(config.objectApiName, all, notes);
    }
    if (run) {
      noteInRun(config, all, run);
      // The lookups at rows of this write, now that those rows have copies.
      const within = await this.linkWithinWrite(config, prepared.deferred, all, run.links);
      notes.push(...within.notes);
      if (within.cancelled) throw new WriteCancelledError(config.objectApiName, all, notes);
    }
    return { outcomes: all, notes };
  }

  /**
   * The second write of an object whose rows name each other: each row the
   * first write took is given, by an update, the copy of the row its lookup
   * names (`deferred`, see `prepareSyncRows`). A row whose record there was
   * refused stays without the lookup, and the result says how many; so does
   * one whose update the target refused, with its reason, and the rows a
   * cancel kept the update from. The rows stay written whatever this write
   * answers, and a failure of it is said, never thrown.
   */
  private async linkWithinWrite(
    config: SyncObjectConfig,
    deferred: readonly DeferredLookup[],
    outcomes: readonly OperationOutcome[],
    links: SyncWriteRun['links'],
  ): Promise<{ notes: string[]; cancelled: boolean }> {
    const name = config.objectApiName;
    const updates = new Map<string, Record<string, unknown>>();
    /** Per lookup, the rows written that stay without it because their record was refused. */
    const refusedParent = new Map<string, number>();
    for (const { index, field, parent } of deferred) {
      const row = outcomes[index];
      if (!row?.success || typeof row.id !== 'string' || row.id === '') continue;
      const copy = links.targetOf(parent);
      if (copy === undefined) {
        refusedParent.set(field, (refusedParent.get(field) ?? 0) + 1);
        continue;
      }
      const update = updates.get(row.id) ?? { Id: row.id };
      update[field] = copy;
      updates.set(row.id, update);
    }
    const notes = [...refusedParent].map(
      ([field, count]) =>
        `${count} ${name} record(s) written without ${field}: the ${name} record it names was ` +
        'refused in this run.',
    );
    if (updates.size === 0) return { notes, cancelled: false };

    const sent = [...updates.values()];
    const fieldsOf = (rows: readonly Record<string, unknown>[]): string =>
      [...new Set(rows.flatMap((row) => Object.keys(row).filter((f) => f !== 'Id')))]
        .sort()
        .join(', ');
    let answered: OperationOutcome[];
    let cancelled = false;
    try {
      answered = await this.executeOperation(name, 'update', sent, config.batchSize);
    } catch (err: unknown) {
      if (!(err instanceof WriteCancelledError)) {
        const reason = err instanceof Error ? err.message : String(err);
        notes.push(
          `${sent.length} ${name} record(s) written without ${fieldsOf(sent)}: setting it once ` +
            `the record it names was written failed: ${reason}`,
        );
        return { notes, cancelled: false };
      }
      answered = err.written;
      cancelled = true;
    }
    const refused = sent.filter((_, at) => answered[at] !== undefined && !answered[at].success);
    if (refused.length > 0) {
      const first = answered.find((outcome) => !outcome.success)?.errors[0];
      notes.push(
        `${refused.length} ${name} record(s) written without ${fieldsOf(refused)}: the target ` +
          `refused setting it once the record it names was written${first ? ` (${first})` : ''}.`,
      );
    }
    const notReached = sent.slice(answered.length);
    if (notReached.length > 0) {
      notes.push(
        `${notReached.length} ${name} record(s) written without ${fieldsOf(notReached)}: the ` +
          'run was cancelled before it was set.',
      );
    }
    return { notes, cancelled };
  }

  /**
   * Send again the rows the target refused for a reason a field of their own
   * carries, without that field.
   *
   * A lookup holds an id from the source org. Unless the two orgs share that
   * record — which two sandboxes taken from the same production often do, and
   * which is why this shows up on one field and not all of them — the target
   * answers `insufficient access rights on cross-reference id` and loses the
   * whole row over it. Run for real, that cost one account of sixteen its
   * entire record for one custom Contact lookup. Such a row is written again
   * without the lookups that hold an id the run has no copy of — the owner, a
   * user, a record no object of the run wrote — and the dropped fields are
   * named in the result. Never without a lookup the run settled, at a record
   * it wrote, nor its record type: run into a client sandbox, contacts sent
   * under accounts the target had refused were written without `AccountId`,
   * `OwnerId` and `RecordTypeId` to get them in, and stood alone. A row whose
   * parent was refused is held back before it is sent (`prepareSyncRows`).
   *
   * A row the target refused on fields a validation rule of its own, or a
   * restricted picklist, named goes again without those fields, as Forge's
   * batch writer and Frozen's loader send it (`refusedFields`), and the
   * result says which fields, for how many rows, and in the rule's words —
   * never without a lookup the run settled.
   *
   * The target names one refusal at a time: run against a target with a phone
   * rule, a contact refused for its phone went again without it, and was then
   * refused for its owner, which had passed unseen. So a row goes again once
   * for each kind of refusal, at most twice, never twice for the same kind; a
   * row refused again keeps the target's last word on it.
   *
   * A cancel that stops a write sent again is answered, not thrown:
   * `cancelled` says so, and the outcomes and notes are those of every record
   * the writes sent. So is any other error of such a write: it only ever sent
   * again rows already refused, so it leaves them refused, and the rows
   * written stay written, notes and all. Thrown on, the error reported the
   * object as one failure whole, and nothing said what the first write had put
   * in the org.
   */
  private async retryRefused(
    config: SyncObjectConfig,
    records: Record<string, unknown>[],
    outcomes: OperationOutcome[],
    references: ReadonlySet<string> | null,
    settled: readonly ReadonlySet<string>[],
  ): Promise<{ outcomes: OperationOutcome[]; notes: string[]; cancelled: boolean }> {
    const key = addressedBy(config) ?? undefined;
    const merged = [...outcomes];
    /** Each row as it was last sent. */
    const current = [...records];
    /** Per row, the kinds of refusal it was sent again for. */
    const tried = records.map(() => new Set<'lookup' | 'fields'>());
    /** Per row, the lookups and the named fields it went without. */
    const lookupsLeft = records.map(() => [] as string[]);
    const fieldsLeft = records.map(() => [] as FieldToLeaveOut[]);
    const notes: string[] = [];
    let cancelledAt: WriteCancelledError | undefined;

    for (let pass = 0; pass < 2 && !cancelledAt; pass++) {
      const failedAt: number[] = [];
      const again: Record<string, unknown>[] = [];
      /** For each row sent again: the fields a refusal named, or `null` for a lookup's. */
      const named: Array<FieldToLeaveOut[] | null> = [];
      merged.forEach((outcome, index) => {
        if (outcome.success) return;
        const record = current[index];
        const kept = settled[index] ?? new Set<string>();
        if (outcome.errors.some((m) => isCrossReferenceFailure(m))) {
          if (tried[index].has('lookup') || !references || references.size === 0) return;
          const stripped: Record<string, unknown> = {};
          let leftOut = false;
          for (const field of Object.keys(record)) {
            if (
              references.has(field) &&
              !kept.has(field) &&
              record[field] !== null &&
              record[field] !== undefined
            ) {
              leftOut = true;
              continue;
            }
            stripped[field] = record[field];
          }
          if (!leftOut) return;
          failedAt.push(index);
          again.push(stripped);
          named.push(null);
          return;
        }
        if (tried[index].has('fields')) return;
        const fields = refusedFields(outcome.errorDetails, record, key);
        if (!fields || fields.some(({ field }) => kept.has(field))) return;
        const leave = new Set(fields.map(({ field }) => field));
        failedAt.push(index);
        again.push(Object.fromEntries(Object.entries(record).filter(([f]) => !leave.has(f))));
        named.push(fields);
      });
      if (failedAt.length === 0) break;

      let second: OperationOutcome[];
      try {
        second = await this.executeOperation(
          config.objectApiName,
          config.operation,
          again,
          config.batchSize,
          config.externalIdField,
        );
      } catch (err: unknown) {
        if (!(err instanceof WriteCancelledError)) {
          notes.push(...couldNotSendAgain(failedAt, current, again, named, err));
          break;
        }
        // The cancel stopped the write before one of its batches — its first,
        // when the cancel came during the write before. It names only the
        // rows sent again: passed on as it was, the run would have counted
        // those alone, and none of the records written before.
        second = err.written;
        cancelledAt = err;
      }
      second.forEach((outcome, position) => {
        const at = failedAt[position];
        const fields = named[position];
        tried[at].add(fields === null ? 'lookup' : 'fields');
        if (fields === null) {
          lookupsLeft[at].push(
            ...Object.keys(current[at]).filter((field) => !(field in again[position])),
          );
        } else {
          fieldsLeft[at].push(...fields);
        }
        current[at] = again[position];
        merged[at] = outcome;
      });
    }

    // Said of the rows written once sent again, beside the outcomes: a
    // successful write has no error list anybody reads, so the note has to
    // reach the result on its own or the dropped field is never mentioned.
    const dropped = new Set<string>();
    let recoveredLookups = 0;
    let withoutFields: WrittenWithoutFields | undefined;
    merged.forEach((outcome, index) => {
      if (!outcome.success || tried[index].size === 0) return;
      if (lookupsLeft[index].length > 0) {
        recoveredLookups++;
        for (const field of lookupsLeft[index]) dropped.add(field);
      }
      if (fieldsLeft[index].length > 0) {
        withoutFields = addWrittenWithoutFields(withoutFields, {
          rows: 1,
          fields: fieldsLeft[index].map((field) => ({ ...field, rows: 1 })),
        });
      }
    });
    const written = [
      ...(recoveredLookups > 0
        ? [
            `${recoveredLookups} record(s) written without ${[...dropped].sort().join(', ')}: ` +
              `the lookup held an id from the source org that the target does not have.`,
          ]
        : []),
      ...(withoutFields ? [fieldsLeftOutNote(withoutFields)] : []),
    ];
    return {
      outcomes: merged,
      notes: [...written, ...notes, ...(cancelledAt?.notes ?? [])],
      cancelled: cancelledAt !== undefined,
    };
  }

  private async executeOperation(
    objectName: string,
    operation: SyncOperation,
    records: Record<string, unknown>[],
    batchSize: number,
    externalIdField?: string,
  ): Promise<OperationOutcome[]> {
    // Re-verify CRUD/FLS permissions immediately before DML execution
    if (this.deps.crudFlsGuard) {
      const fieldNames = records.length > 0 ? Object.keys(records[0]) : [];
      const check = await this.deps.crudFlsGuard.checkCrudAndFls(
        objectName,
        operation as CrudOperation,
        fieldNames,
      );
      if (!check.allowed) {
        throw new Error(`CRUD/FLS check failed for ${operation} on ${objectName}: ${check.reason}`);
      }
    }

    switch (operation) {
      case 'insert':
        return this.deps.insert(objectName, records, batchSize);
      case 'update':
        return this.deps.update(objectName, records, batchSize);
      case 'upsert':
        return this.deps.upsert(objectName, externalIdField ?? 'Id', records, batchSize);
      case 'delete': {
        const ids = records.map((r) => r.Id).filter((id): id is string => typeof id === 'string');
        return this.deps.delete(objectName, ids, batchSize);
      }
    }
  }
}

/**
 * The two codes Salesforce refuses a lookup with when it points at something
 * the target org does not have: a record it cannot see, or an id it does not
 * hold at all.
 */
const CROSS_REFERENCE_CODES = [
  'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
  'INVALID_CROSS_REFERENCE_KEY',
];

/**
 * The words of those refusals when a shape carries no code: "insufficient
 * access rights on cross-reference id", "invalid cross reference id" — a
 * Developer Edition writes it without the hyphen, and an unmapped Account
 * copied between two of them lost every row over its OwnerId — and the French
 * "ID de référence croisée".
 */
const CROSS_REFERENCE_WORDS = /cross[- ]reference id|r[ée]f[ée]rence crois[ée]e/i;

/**
 * Salesforce refusing a row because a lookup points at something the target
 * org does not have, by its code or, where the shape carries none, by its
 * words in English or French.
 */
function isCrossReferenceFailure(message: string): boolean {
  return (
    CROSS_REFERENCE_CODES.some((code) => message.includes(code)) ||
    CROSS_REFERENCE_WORDS.test(message)
  );
}

/**
 * What is said of rows the target refused when sending them again failed
 * outright: they stay refused, each kind of refusal with the fields it would
 * have gone without and the error.
 */
function couldNotSendAgain(
  failedAt: readonly number[],
  current: readonly Record<string, unknown>[],
  again: readonly Record<string, unknown>[],
  named: ReadonlyArray<FieldToLeaveOut[] | null>,
  err: unknown,
): string[] {
  const reason = err instanceof Error ? err.message : String(err);
  const lookups = new Set<string>();
  const fields = new Set<string>();
  let lookupRows = 0;
  named.forEach((kind, position) => {
    if (kind === null) {
      lookupRows++;
      const sent = again[position];
      for (const field of Object.keys(current[failedAt[position]])) {
        if (!(field in sent)) lookups.add(field);
      }
    } else {
      for (const { field } of kind) fields.add(field);
    }
  });
  return [
    ...(lookupRows > 0
      ? [
          `${lookupRows} record(s) the target refused for a lookup it does not have could not ` +
            `be written again without ${[...lookups].sort().join(', ')}: ${reason}`,
        ]
      : []),
    ...(fields.size > 0
      ? [
          `${failedAt.length - lookupRows} record(s) the target refused on fields it named ` +
            `could not be written again without ${[...fields].sort().join(', ')}: ${reason}`,
        ]
      : []),
  ];
}

/**
 * The record of the target a refused row is linked to: the one the target
 * named when it refused the row as a duplicate (`existingId`, which the writer
 * reads off the refusal), for a row the run set out to create — an insert, or
 * an upsert. Of an update, the record named is another than the row's own.
 */
export function linkedRecordOf(
  operation: SyncOperation,
  outcome: OperationOutcome,
): string | undefined {
  if (outcome.success || (operation !== 'insert' && operation !== 'upsert')) return undefined;
  return outcome.existingId !== undefined && outcome.existingId !== ''
    ? outcome.existingId
    : undefined;
}

/**
 * Add what a write wrote and refused to the run it is part of, by the source
 * id of each record: the lookups of the objects written after read it. A
 * record the run set out to create — an insert, or an upsert — and the target
 * refused, or the write held back, is refused; one an update did not reach is
 * the target's already, and its children name it as they did. A delete adds
 * nothing.
 *
 * A row the target refused as a duplicate of a record it named is linked to
 * that record, as Forge links it: the target holds it already, so what hangs
 * from it follows it there rather than being held back. Run against a target
 * that keeps an external id unique, every contact under an account the target
 * held under the same id was held back as under a refused parent.
 */
function noteInRun(
  config: SyncObjectConfig,
  outcomes: readonly OperationOutcome[],
  run: SyncWriteRun,
): void {
  if (config.operation === 'delete') return;
  const creates = config.operation === 'insert' || config.operation === 'upsert';
  outcomes.forEach((outcome, index) => {
    const sourceId = run.sources[index]?.['Id'];
    if (typeof sourceId !== 'string' || sourceId === '') return;
    const linked = linkedRecordOf(config.operation, outcome);
    if (outcome.success && typeof outcome.id === 'string' && outcome.id !== '') {
      run.links.noteWritten(sourceId, outcome.id);
    } else if (linked !== undefined) {
      run.links.noteWritten(sourceId, linked);
    } else if (!outcome.success && creates) {
      run.links.noteRefused(sourceId, config.objectApiName);
    }
  });
}

/**
 * What is said once of the rows linked to a record the target holds, with
 * the first refusal that named one.
 */
function linkedNote(objectApiName: string, count: number, refusal: string | undefined): string {
  return (
    `LINKED_TO_EXISTING: ${count} ${objectApiName} record${count === 1 ? '' : 's'} linked to ` +
    `an existing record, not written: the target refused ${count === 1 ? 'it' : 'them'} as a ` +
    `duplicate of a record it holds and named it${refusal ? ` (${refusal})` : ''}; what the ` +
    `run writes under ${count === 1 ? 'it' : 'them'} points at that record.`
  );
}

/**
 * Build a SyncObjectResult from operation outcomes. The run builds one from
 * the outcomes of a write its cancel stopped, too: the records never sent have
 * no outcome, and are not counted.
 *
 * A row linked to a record the target holds (`linkedRecordOf`) is neither
 * written nor failed: counted skipped, as Forge counts it apart from its
 * failures, and said once with how many.
 */
export function buildObjectResult(
  objectApiName: string,
  operation: SyncOperation,
  outcomes: OperationOutcome[],
  notes: string[] = [],
): SyncObjectResult {
  let success = 0;
  let failed = 0;
  let linked = 0;
  let linkedBy: string | undefined;
  const errors: string[] = [];
  const split = { created: 0, updated: 0 };

  for (const outcome of outcomes) {
    if (outcome.success) {
      success++;
      if (outcome.created === true) split.created++;
      else if (outcome.created === false) split.updated++;
    } else if (linkedRecordOf(operation, outcome) !== undefined) {
      linked++;
      linkedBy ??= outcome.errors[0];
    } else {
      failed++;
      // A record held back is said once per reason, counted, in the notes.
      if (!outcome.heldBack) errors.push(...outcome.errors);
    }
  }

  return {
    objectApiName,
    operation,
    processed: outcomes.length,
    success,
    failed,
    skipped: linked,
    conflictCount: 0,
    // Notices last: what was refused matters more than what was recovered.
    errors: [
      ...errors,
      ...(linked > 0 ? [linkedNote(objectApiName, linked, linkedBy)] : []),
      ...notes,
    ],
    // What each upserted record became, as the org said: the audit trail
    // counts them as created or updated rather than as "upserted".
    ...(operation === 'upsert' ? { upsertSplit: split } : {}),
  };
}
