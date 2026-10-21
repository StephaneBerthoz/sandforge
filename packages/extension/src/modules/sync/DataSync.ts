import type {
  CurrencyReplaced,
  SyncLookupsLeftOut,
  SyncLookupsSetAfter,
  SyncObjectConfig,
  SyncObjectResult,
  SyncOperation,
  SyncWrittenWithoutFields,
} from '@sandforge/shared';
import type { CrudFlsGuard, CrudOperation } from '../../core/metadata/CrudFlsGuard.js';
import type { SaveErrorDetail } from '../../core/common/existingRecordMatch.js';
import {
  addWrittenWithoutFields,
  refusedFields,
  type FieldToLeaveOut,
  type WrittenWithoutFields,
} from '../../core/common/refusedFields.js';
import {
  addressedBy,
  prepareSyncRows,
  type DeferredLookup,
  type SyncRunLinks,
  type SyncWriteRun,
} from './syncRowPreparation.js';
import type { TargetWriteFields } from './targetWriteFields.js';
import { neutralizeSyncRows } from './syncContactPoints.js';
import type { ContactPointNeutralizer } from '../forge/stages/ContactPointNeutralizer.js';
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

/**
 * A lookup of a record already written, left out of its write and set by an
 * update once the record it names has its copy: one at another row of the
 * same write (`DeferredLookup`), or one at a record of an object the run
 * writes after it, which a cycle of lookups ties to it.
 */
export interface PendingLookup {
  /** The record written, by its id in the target. */
  id: string;
  /** The lookup. */
  field: string;
  /** The source id of the record it names. */
  parent: string;
}

/** What setting lookups left out of a write came to (`DataSync.setLookups`). */
export interface LookupsSet {
  /** The records given every lookup sent them, and which; none when none was. */
  set?: Omit<SyncLookupsSetAfter, 'after'>;
  /** The records left without some of them, by why. */
  leftOut: SyncLookupsLeftOut[];
  /**
   * How many records `leftOut` names, each once whatever its reasons: those
   * a delta run reads again, its watermark kept short of them.
   */
  unset: number;
  /** Whether the run's cancel stopped the updates before they were all sent. */
  cancelled: boolean;
}

/** What {@link DataSync.write} answers. */
export interface WriteAnswer {
  /** One outcome per record handed over, in their order. */
  outcomes: OperationOutcome[];
  /** What the write held back and why, and what it could not send again. */
  notes: string[];
  /** The rows sent in another currency than they were read in. */
  currencies: CurrencyReplaced[];
  /** The rows written without lookups they held, and why. */
  lookupsLeftOut: SyncLookupsLeftOut[];
  /** The rows written again without the fields the target refused them on; absent when none. */
  writtenWithoutFields?: SyncWrittenWithoutFields;
  /**
   * The lookups at records of an object the run writes after this one, left
   * out of the rows written (`SyncWriteRun.later`): the run sets them once
   * that object is written. Absent when none.
   */
  lookupsToSet?: PendingLookup[];
  /**
   * The records the write's second pass — the lookups at rows of the same
   * write, set once those rows had copies — left without some of them, each
   * once: a delta run keeps its watermark short of them, so the next run
   * reads them again. Absent when none.
   */
  lookupsUnset?: number;
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
  /**
   * What neutralizes the emails and phone numbers of the rows of a write made
   * on its own, without a run — Real-time's — as a run's `contactPoints` does
   * for a Sync. Absent, they go as read.
   */
  contactPoints?: ContactPointNeutralizer;
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
    const { outcomes, notes, currencies, lookupsLeftOut, writtenWithoutFields } = await this.write(
      config,
      sourceRecords,
      run,
    );
    return withCurrencies(
      buildObjectResult(
        config.objectApiName,
        config.operation,
        outcomes,
        notes,
        lookupsLeftOut,
        writtenWithoutFields,
      ),
      currencies,
    );
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
   *
   * `lookupsLeftOut` says the rows written without lookups they held, apart
   * from the notes: they were written, and a note listed among the refusals
   * read as one. So does `writtenWithoutFields` of the rows written again
   * without the fields the target refused them on.
   */
  async write(
    config: SyncObjectConfig,
    sourceRecords: Record<string, unknown>[],
    run?: SyncWriteRun,
  ): Promise<WriteAnswer> {
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
    // What the target's automation could reach — its email and phone fields —
    // made unreachable before anything is sent, the key the write matches on
    // left as read: see `syncContactPoints`. The neutralizer counts them, and
    // the run's result says it once. A write on its own, Real-time's,
    // neutralizes with the one it was given.
    const contactPoints = run ? run.contactPoints : this.deps.contactPoints;
    if (contactPoints && target?.fields) {
      neutralizeSyncRows(
        contactPoints,
        config.objectApiName,
        target.fields,
        prepared.payloads,
        config.externalIdField,
      );
    }
    const ownerLeftOut = leaveOutRefusedOwners(prepared.payloads, prepared.settled, run);
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
    // The rows to send in calls of their own first: the standard prices,
    // which the custom ones sent in the same call were refused for want of.
    const first = prepared.sentAt.filter((index) => index < (run?.standardFirst ?? 0)).length;
    const send = (payloads: Record<string, unknown>[]): Promise<OperationOutcome[]> =>
      this.executeOperation(
        config.objectApiName,
        config.operation,
        payloads,
        config.batchSize,
        config.externalIdField,
      );
    try {
      // Every record held back: nothing is sent.
      outcomes =
        prepared.payloads.length === 0 && sourceRecords.length > 0
          ? []
          : first > 0 && first < prepared.payloads.length
            ? await sendInTurn(
                config.objectApiName,
                send,
                prepared.payloads.slice(0, first),
                prepared.payloads.slice(first),
              )
            : await send(prepared.payloads);
    } catch (err: unknown) {
      if (!(err instanceof WriteCancelledError)) throw err;
      // The cancel stopped the write before one of its batches: the records
      // sent before it are written, and what was held back is said with them,
      // and the lookups they were to be given once written.
      const owners = ownersLeftOutOf(ownerLeftOut, err.written);
      const sent = aligned(err.written);
      throw new WriteCancelledError(
        config.objectApiName,
        sent,
        [...prepared.notes, ...err.notes],
        [
          ...(owners ? [owners] : []),
          ...err.lookupsLeftOut,
          ...notReachedOf(pendingOf([...prepared.deferred, ...prepared.deferredAcross], sent)),
        ],
        err.writtenWithoutFields,
      );
    }

    const retried = await this.retryRefused(
      config,
      prepared.payloads,
      outcomes,
      target?.references ?? null,
      prepared.settled,
    );
    if (run) for (const owner of retried.ownersRefused) run.links.noteOwnerRefused(owner);

    const all = aligned(retried.outcomes);
    const owners = ownersLeftOutOf(ownerLeftOut, retried.outcomes);
    const notes = [...prepared.notes, ...retried.notes];
    const lookupsLeftOut = [...(owners ? [owners] : []), ...retried.lookupsLeftOut];
    const { writtenWithoutFields } = retried;
    /** The lookups at an object written after this one, of the rows written. */
    const across = pendingOf(prepared.deferredAcross, all);
    /** The records the second pass left without some of their lookups. */
    let unset = 0;
    // Every record has been sent once, and keeps its refusal unless it was
    // tried again before the cancel: the run is told all of it, what was
    // dropped to write it, and that it was cancelled.
    if (retried.cancelled) {
      throw new WriteCancelledError(
        config.objectApiName,
        all,
        notes,
        [...lookupsLeftOut, ...notReachedOf([...pendingOf(prepared.deferred, all), ...across])],
        writtenWithoutFields,
      );
    }
    if (run) {
      noteInRun(config, all, run);
      // The lookups at rows of this write, now that those rows have copies.
      const within = await this.setLookups(
        config,
        pendingOf(prepared.deferred, all),
        run.links,
        false,
      );
      lookupsLeftOut.push(...within.leftOut);
      unset = within.unset;
      if (within.cancelled) {
        throw new WriteCancelledError(
          config.objectApiName,
          all,
          notes,
          [...lookupsLeftOut, ...notReachedOf(across)],
          writtenWithoutFields,
        );
      }
    }
    return {
      outcomes: all,
      notes,
      currencies: prepared.currencies,
      lookupsLeftOut,
      ...(writtenWithoutFields ? { writtenWithoutFields } : {}),
      ...(across.length > 0 ? { lookupsToSet: across } : {}),
      ...(unset > 0 ? { lookupsUnset: unset } : {}),
    };
  }

  /**
   * Set, by an update, the lookups left out of records already written, once
   * the records they name have their copies: the second write of an object
   * whose rows name each other (`deferred`, see `prepareSyncRows`), and the
   * pass a run makes once the objects a cycle of lookups ties together are
   * all written (`SyncWriteRun.later`).
   *
   * A lookup goes as the copy of the record it names. One whose record the
   * run set out to create and could not stays empty, said `parentRefused`.
   * One whose record the run wrote no copy of, nor refused — a record of an
   * object written after, outside what the run read of it — goes as the
   * source holds it when `asRead` is set, as the first write would have sent
   * it: between two sandboxes of one production the target holds that record
   * under the same id. The target refusing it for an id it does not have says
   * `notInTarget`; any other refusal of an update, or a call that fails,
   * `notSet` with its words; the updates a cancel kept from being sent,
   * `notReached`. The records stay written whatever this answers, and a
   * failure is said, never thrown.
   *
   * @param asRead - Whether a lookup at a record the run has no copy of goes
   *   as read: for records of another object, never those of the same write.
   */
  async setLookups(
    config: Pick<SyncObjectConfig, 'objectApiName' | 'batchSize'>,
    pending: readonly PendingLookup[],
    links: SyncRunLinks,
    asRead: boolean,
  ): Promise<LookupsSet> {
    const name = config.objectApiName;
    /** The updates naming copies, and those naming records as read, by record. */
    const copies = new Map<string, Record<string, unknown>>();
    const read = new Map<string, Record<string, unknown>>();
    const parentRefused = new Tally();
    for (const { id, field, parent } of pending) {
      const copy = links.targetOf(parent);
      const into =
        copy !== undefined
          ? copies
          : asRead && links.refusedObjectOf(parent) === undefined
            ? read
            : undefined;
      if (!into) {
        parentRefused.add(id, field);
        continue;
      }
      const update = into.get(id) ?? { Id: id };
      update[field] = copy ?? parent;
      into.set(id, update);
    }
    const set = new Tally();
    const notInTarget = new Tally();
    const notSet = new Tally();
    const notReached = new Tally();
    let cancelled = false;
    for (const sent of [[...copies.values()], [...read.values()]]) {
      if (sent.length === 0) continue;
      if (cancelled) {
        for (const row of sent) notReached.addRow(row);
        continue;
      }
      let answered: OperationOutcome[];
      try {
        answered = await this.executeOperation(name, 'update', sent, config.batchSize);
      } catch (err: unknown) {
        if (!(err instanceof WriteCancelledError)) {
          const reason = err instanceof Error ? err.message : String(err);
          for (const row of sent) notSet.addRow(row, reason);
          continue;
        }
        answered = err.written;
        cancelled = true;
      }
      sent.forEach((row, at) => {
        const outcome = answered[at];
        if (outcome === undefined) notReached.addRow(row);
        else if (outcome.success) set.addRow(row);
        else if (outcome.errors.some((m) => isCrossReferenceFailure(m))) notInTarget.addRow(row);
        else notSet.addRow(row, outcome.errors[0]);
      });
    }
    const left = [parentRefused, notInTarget, notSet, notReached];
    return {
      ...(set.records > 0 ? { set: { records: set.records, fields: set.fields() } } : {}),
      leftOut: [
        parentRefused.leftOut('parentRefused'),
        notInTarget.leftOut('notInTarget'),
        notSet.leftOut('notSet'),
        notReached.leftOut('notReached'),
      ].flatMap((entry) => (entry ? [entry] : [])),
      unset: new Set(left.flatMap((tally) => [...tally.recordIds])).size,
      cancelled,
    };
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
   *
   * `ownersRefused` names the owners of the source the target refused, on
   * `OwnerId`, for an id it does not have: a row refused for a lookup and
   * written once sent again without its owner alone, or whose refusal named
   * `OwnerId`. A row written again without several lookups names none of them.
   *
   * `lookupsLeftOut` says the rows written once sent again without lookups,
   * and which, apart from the notes: they were written.
   */
  private async retryRefused(
    config: SyncObjectConfig,
    records: Record<string, unknown>[],
    outcomes: OperationOutcome[],
    references: ReadonlySet<string> | null,
    settled: readonly ReadonlySet<string>[],
  ): Promise<{
    outcomes: OperationOutcome[];
    notes: string[];
    writtenWithoutFields?: SyncWrittenWithoutFields;
    cancelled: boolean;
    ownersRefused: string[];
    lookupsLeftOut: SyncLookupsLeftOut[];
  }> {
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

    /** The owners a refusal named `OwnerId` for, as the rows were first sent. */
    const ownersNamed = new Set<string>();
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
          const owner = records[index]?.[OWNER_FIELD];
          if (
            typeof owner === 'string' &&
            !kept.has(OWNER_FIELD) &&
            (outcome.errorDetails ?? []).some(
              (detail) =>
                isCrossReferenceFailure(detail.statusCode) && detail.fields.includes(OWNER_FIELD),
            )
          ) {
            ownersNamed.add(owner);
          }
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
    const ownersRefused = new Set(ownersNamed);
    merged.forEach((outcome, index) => {
      if (!outcome.success || tried[index].size === 0) return;
      if (lookupsLeft[index].length > 0) {
        recoveredLookups++;
        for (const field of lookupsLeft[index]) dropped.add(field);
        // Written once its owner alone was left out: the owner was what the
        // target refused.
        const owner = records[index]?.[OWNER_FIELD];
        if (
          typeof owner === 'string' &&
          lookupsLeft[index].length === 1 &&
          lookupsLeft[index][0] === OWNER_FIELD
        ) {
          ownersRefused.add(owner);
        }
      }
      if (fieldsLeft[index].length > 0) {
        withoutFields = addWrittenWithoutFields(withoutFields, {
          rows: 1,
          fields: fieldsLeft[index].map((field) => ({ ...field, rows: 1 })),
        });
      }
    });
    return {
      outcomes: merged,
      notes: [...notes, ...(cancelledAt?.notes ?? [])],
      ...(withoutFields ? { writtenWithoutFields: withoutFields } : {}),
      cancelled: cancelledAt !== undefined,
      ownersRefused: [...ownersRefused],
      lookupsLeftOut: [
        ...(recoveredLookups > 0
          ? [
              {
                records: recoveredLookups,
                fields: [...dropped].sort(),
                reason: 'notInTarget' as const,
              },
            ]
          : []),
        ...(cancelledAt?.lookupsLeftOut ?? []),
      ],
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

/** The owner a row carries from the source. */
const OWNER_FIELD = 'OwnerId';

/**
 * Leave out of the payloads the owners the target refused earlier in the run
 * (`SyncRunLinks.isOwnerRefused`), and say which rows went without theirs.
 *
 * Run between two scratch orgs, the account showed the target did not have
 * the source's owner, and the 12 000 contacts after it went as one Bulk API
 * job carrying it all the same: refused whole, every row on
 * `INVALID_CROSS_REFERENCE_KEY`, nearly a minute, then sent again without it.
 * A row whose owner the run settled — a copy it wrote — keeps it.
 *
 * @returns The places of the payloads written without their owner.
 */
function leaveOutRefusedOwners(
  payloads: Array<Record<string, unknown>>,
  settled: readonly ReadonlySet<string>[],
  run: SyncWriteRun | undefined,
): Set<number> {
  const leftOut = new Set<number>();
  if (!run) return leftOut;
  payloads.forEach((payload, index) => {
    const owner = payload[OWNER_FIELD];
    if (typeof owner !== 'string' || settled[index]?.has(OWNER_FIELD)) return;
    if (!run.links.isOwnerRefused(owner)) return;
    delete payload[OWNER_FIELD];
    leftOut.add(index);
  });
  return leftOut;
}

/**
 * What is said once of the rows written without their owner from the start,
 * as the retry says it of the rows it wrote without one; nothing when none of
 * them was written.
 */
function ownersLeftOutOf(
  leftOut: ReadonlySet<number>,
  outcomes: readonly OperationOutcome[],
): SyncLookupsLeftOut | undefined {
  let written = 0;
  for (const index of leftOut) if (outcomes[index]?.success) written++;
  if (written === 0) return undefined;
  return { records: written, fields: [OWNER_FIELD], reason: 'ownerRefusedEarlier' };
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
 * Records counted once each, with the lookups they were sent or went without
 * and the first words a refusal said of them: what one reason of
 * {@link DataSync.setLookups} comes to.
 */
class Tally {
  private readonly ids = new Set<string>();
  private readonly named = new Set<string>();
  private said: string | undefined;

  /** One lookup of a record. */
  add(id: string, field: string): void {
    this.ids.add(id);
    this.named.add(field);
  }

  /** The lookups an update of a record carries, and what refused it. */
  addRow(row: Record<string, unknown>, refusal?: string): void {
    const id = String(row.Id);
    for (const field of Object.keys(row)) if (field !== 'Id') this.add(id, field);
    if (refusal !== undefined && refusal !== '') this.said ??= refusal;
  }

  get records(): number {
    return this.ids.size;
  }

  /** The records counted, by id. */
  get recordIds(): ReadonlySet<string> {
    return this.ids;
  }

  fields(): string[] {
    return [...this.named].sort();
  }

  /** The records counted, as a result says them for `reason`; nothing when none. */
  leftOut(reason: SyncLookupsLeftOut['reason']): SyncLookupsLeftOut | undefined {
    if (this.ids.size === 0) return undefined;
    return {
      records: this.ids.size,
      fields: this.fields(),
      reason,
      ...(this.said !== undefined ? { refusal: this.said } : {}),
    };
  }
}

/** The lookups left out of the rows a write took, by the record each row became. */
function pendingOf(
  deferred: readonly DeferredLookup[],
  outcomes: readonly OperationOutcome[],
): PendingLookup[] {
  return deferred.flatMap(({ index, field, parent }) => {
    const row = outcomes[index];
    return row?.success && typeof row.id === 'string' && row.id !== ''
      ? [{ id: row.id, field, parent }]
      : [];
  });
}

/** How many records lookups waiting to be set are of, each once: `LookupsSet.unset` of a pass never made. */
export function unsetOf(pending: readonly PendingLookup[]): number {
  return new Set(pending.map(({ id }) => id)).size;
}

/**
 * What is said of the records a cancel left without the lookups they were
 * to be given once written: none when there are none.
 */
export function notReachedOf(pending: readonly PendingLookup[]): SyncLookupsLeftOut[] {
  const tally = new Tally();
  for (const { id, field } of pending) tally.add(id, field);
  const entry = tally.leftOut('notReached');
  return entry ? [entry] : [];
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
/**
 * `first`, then `then`, each in calls of its own, their outcomes in that
 * order. A cancel during the second answers the first's outcomes with the
 * records it sent before it.
 */
async function sendInTurn(
  objectApiName: string,
  send: (payloads: Record<string, unknown>[]) => Promise<OperationOutcome[]>,
  first: Record<string, unknown>[],
  then: Record<string, unknown>[],
): Promise<OperationOutcome[]> {
  const before = await send(first);
  try {
    return [...before, ...(await send(then))];
  } catch (err: unknown) {
    if (!(err instanceof WriteCancelledError)) throw err;
    throw new WriteCancelledError(
      objectApiName,
      [...before, ...err.written],
      err.notes,
      err.lookupsLeftOut,
      err.writtenWithoutFields,
    );
  }
}

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

/** `result`, with the rows its write sent in another currency when there are any. */
export function withCurrencies(
  result: SyncObjectResult,
  currencies: readonly CurrencyReplaced[],
): SyncObjectResult {
  return currencies.length > 0 ? { ...result, currenciesReplaced: [...currencies] } : result;
}

/** Refused records of one object whose refusals a run's result keeps. */
export const MAX_RESULT_REFUSALS_PER_OBJECT = 1_000;

/**
 * Build a SyncObjectResult from operation outcomes. The run builds one from
 * the outcomes of a write its cancel stopped, too: the records never sent have
 * no outcome, and are not counted.
 *
 * A row linked to a record the target holds (`linkedRecordOf`) is neither
 * written nor failed: counted skipped, as Forge counts it apart from its
 * failures, and said once with how many (`linkedToExisting`), apart from the
 * refusals, as are the rows written without lookups (`lookupsLeftOut`) and
 * those written again without the fields the target refused them on
 * (`writtenWithoutFields`). All were sentences among the errors, which the
 * results list as refusals, in red and in English.
 */
export function buildObjectResult(
  objectApiName: string,
  operation: SyncOperation,
  outcomes: OperationOutcome[],
  notes: string[] = [],
  lookupsLeftOut: readonly SyncLookupsLeftOut[] = [],
  writtenWithoutFields?: SyncWrittenWithoutFields,
): SyncObjectResult {
  let success = 0;
  let failed = 0;
  let linked = 0;
  let linkedBy: string | undefined;
  const errors: string[] = [];
  let refused = 0;
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
      // The refusals of the first records are kept, as Seed keeps them: the
      // page groups them by reason, and a thousand say every reason a large
      // object meets.
      if (!outcome.heldBack && refused++ < MAX_RESULT_REFUSALS_PER_OBJECT) {
        errors.push(...outcome.errors);
      }
    }
  }
  const refusalsDropped = Math.max(0, refused - MAX_RESULT_REFUSALS_PER_OBJECT);

  return {
    objectApiName,
    operation,
    processed: outcomes.length,
    success,
    failed,
    skipped: linked,
    conflictCount: 0,
    // Notices last: what was refused matters more than what was recovered.
    errors: [...errors, ...notes],
    ...(linked > 0
      ? { linkedToExisting: { records: linked, ...(linkedBy ? { refusal: linkedBy } : {}) } }
      : {}),
    ...(lookupsLeftOut.length > 0 ? { lookupsLeftOut: [...lookupsLeftOut] } : {}),
    ...(writtenWithoutFields ? { writtenWithoutFields } : {}),
    ...(refusalsDropped > 0 ? { refusalsDropped } : {}),
    // What each upserted record became, as the org said: the audit trail
    // counts them as created or updated rather than as "upserted".
    ...(operation === 'upsert' ? { upsertSplit: split } : {}),
  };
}
