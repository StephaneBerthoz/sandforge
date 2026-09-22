import type {
  SyncObjectConfig,
  SyncObjectResult,
  SyncOperation,
  FieldMapping,
  AddOnField,
} from '@sandforge/shared';
import type { CrudFlsGuard, CrudOperation } from '../../core/metadata/CrudFlsGuard.js';
import {
  carriesRecordType,
  defaultRecordTypeOf,
  findUnavailableRecordTypes,
  recordTypeFallbackNote,
  type RecordTypeAvailability,
  type UnavailableRecordTypeUse,
} from '../../core/metadata/recordTypeAvailability.js';
import type { TargetWriteFields } from './targetWriteFields.js';

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
   * The same describe carries the record types the running user may use:
   * see {@link DataSync.withoutClosedRecordTypes}.
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
   */
  async sync(
    config: SyncObjectConfig,
    sourceRecords: Record<string, unknown>[],
  ): Promise<SyncObjectResult> {
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

    const mappedRecords = sourceRecords.map((record) =>
      applyMappingsAndAddOns(
        record,
        config.fieldMappings,
        config.addOnFields,
        target?.creatable ?? null,
      ),
    );

    const closed = this.withoutClosedRecordTypes(config, mappedRecords, target);

    const outcomes = await this.executeOperation(
      config.objectApiName,
      config.operation,
      closed.records,
      config.batchSize,
      config.externalIdField,
    );

    const retried = await this.retryWithoutCrossOrgReferences(
      config,
      closed.records,
      outcomes,
      target?.references ?? null,
    );

    // Said only of the records that were written: one refused for another
    // reason carries its own error.
    const recordTypeNotes = closed.dropped.flatMap(({ use, indices }) => {
      const written = indices.filter((i) => retried.outcomes[i]?.success).length;
      return written > 0
        ? [recordTypeFallbackNote({ ...use, recordCount: written }, closed.fallback)]
        : [];
    });

    return buildResult(config.objectApiName, config.operation, retried.outcomes, [
      ...recordTypeNotes,
      ...retried.notes,
    ]);
  }

  /**
   * Take the record type off the records whose type the running user cannot
   * use in the target org, so the platform decides it instead.
   *
   * A sync copies `RecordTypeId` as it read it. A type that exists in the
   * target but is closed to the running user — or inactive there — refuses
   * every record carrying it, with an `INVALID_CROSS_REFERENCE_KEY` that names
   * the id and not the reason. Sync already writes a row without a lookup the
   * target cannot take rather than lose the row over one field (see
   * {@link retryWithoutCrossOrgReferences}); a record type is that case known
   * before the write, so it gets the same trade: the record is written, a new
   * one with the running user's default record type, and the result says
   * which type was set aside, for how many records, and what to grant to
   * keep it. A delete sends no record type and is left alone.
   */
  private withoutClosedRecordTypes(
    config: SyncObjectConfig,
    records: Record<string, unknown>[],
    target: TargetWriteFields | null,
  ): {
    records: Record<string, unknown>[];
    dropped: Array<{ use: UnavailableRecordTypeUse; indices: number[] }>;
    fallback: RecordTypeAvailability | undefined;
  } {
    const infos = target?.recordTypes ?? [];
    if (config.operation === 'delete' || infos.length === 0) {
      return { records, dropped: [], fallback: undefined };
    }
    const uses = findUnavailableRecordTypes(config.objectApiName, records, infos);
    if (uses.length === 0) return { records, dropped: [], fallback: undefined };

    const dropped = uses.map((use) => ({ use, indices: [] as number[] }));
    const sent = records.map((record, index) => {
      const hit = dropped.find(({ use }) => carriesRecordType(record, [use]));
      if (!hit) return record;
      hit.indices.push(index);
      const copy = { ...record };
      delete copy['RecordTypeId'];
      return copy;
    });
    return { records: sent, dropped, fallback: defaultRecordTypeOf(infos) };
  }

  /**
   * Try once more, without the lookups, the rows a cross-reference refused.
   *
   * A lookup holds an id from the source org. Unless the two orgs share that
   * record — which two sandboxes taken from the same production often do, and
   * which is why this shows up on one field and not all of them — the target
   * answers `insufficient access rights on cross-reference id` and loses the
   * whole row over it. Run for real, that cost one account of sixteen its
   * entire record for one custom Contact lookup.
   *
   * Sync has no id map to repair the lookup with: it copies fields, it does
   * not walk a graph. So the row is written without them and the dropped
   * fields are named in the result — the same trade Forge makes, and better
   * than losing the row. Once, never in a loop: a second refusal is a real
   * one.
   */
  private async retryWithoutCrossOrgReferences(
    config: SyncObjectConfig,
    records: Record<string, unknown>[],
    outcomes: OperationOutcome[],
    references: ReadonlySet<string> | null,
  ): Promise<{ outcomes: OperationOutcome[]; notes: string[] }> {
    if (!references || references.size === 0) return { outcomes, notes: [] };

    const failedAt: number[] = [];
    outcomes.forEach((outcome, index) => {
      if (!outcome.success && outcome.errors.some((m) => isCrossReferenceFailure(m))) {
        failedAt.push(index);
      }
    });
    if (failedAt.length === 0) return { outcomes, notes: [] };

    const withoutLookups: Record<string, unknown>[] = [];
    const dropped = new Set<string>();
    for (const index of failedAt) {
      const record = records[index];
      const stripped: Record<string, unknown> = {};
      for (const key of Object.keys(record)) {
        if (references.has(key) && record[key] !== null && record[key] !== undefined) {
          dropped.add(key);
          continue;
        }
        stripped[key] = record[key];
      }
      withoutLookups.push(stripped);
    }
    if (dropped.size === 0) return { outcomes, notes: [] };

    const second = await this.executeOperation(
      config.objectApiName,
      config.operation,
      withoutLookups,
      config.batchSize,
      config.externalIdField,
    );

    const merged = [...outcomes];
    let recovered = 0;
    second.forEach((outcome, position) => {
      const at = failedAt[position];
      if (outcome.success) {
        merged[at] = outcome;
        recovered++;
      }
    });
    // Carried beside the outcomes, because a successful write has no error
    // list anybody reads: the note has to reach the result on its own or the
    // dropped field is never mentioned anywhere.
    const notes =
      recovered > 0
        ? [
            `${recovered} record(s) written without ${[...dropped].sort().join(', ')}: ` +
              `the lookup held an id from the source org that the target does not have.`,
          ]
        : [];
    return { outcomes: merged, notes };
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
 * Salesforce refusing a row because a lookup points at something the target
 * org does not have. The wording is the API's own and stays English even on a
 * localised org; the code is matched too, for the shapes that carry it.
 */
function isCrossReferenceFailure(message: string): boolean {
  return (
    message.includes('INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY') ||
    message.toLowerCase().includes('cross-reference id')
  );
}

/**
 * Apply field mappings and add-on fields to a single source record.
 */
function applyMappingsAndAddOns(
  record: Record<string, unknown>,
  mappings: FieldMapping[],
  addOns: AddOnField[],
  creatable: ReadonlySet<string> | null,
): Record<string, unknown> {
  let result: Record<string, unknown>;

  if (mappings.length === 0) {
    result = { ...record };
  } else {
    result = {};
    for (const mapping of mappings) {
      if (mapping.type === 'exclude') {
        continue;
      }
      result[mapping.targetField] = record[mapping.sourceField];
    }
  }

  // Add-ons are set by the person running the sync, so they are applied
  // before the filter rather than after: an add-on naming a field the target
  // will not take is a mistake worth surfacing, not one to hide.
  for (const addOn of addOns) {
    const fieldExists = addOn.fieldApiName in result;
    if (!fieldExists || addOn.overwriteExisting) {
      result[addOn.fieldApiName] = addOn.value;
    }
  }

  if (!creatable) return result;

  // `attributes` is jsforce's own envelope and is never a field.
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(result)) {
    if (key === 'attributes') continue;
    if (creatable.has(key)) filtered[key] = result[key];
  }
  return filtered;
}

/**
 * Build a SyncObjectResult from operation outcomes.
 */
function buildResult(
  objectApiName: string,
  operation: SyncOperation,
  outcomes: OperationOutcome[],
  notes: string[] = [],
): SyncObjectResult {
  let success = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const outcome of outcomes) {
    if (outcome.success) {
      success++;
    } else {
      failed++;
      errors.push(...outcome.errors);
    }
  }

  return {
    objectApiName,
    operation,
    processed: outcomes.length,
    success,
    failed,
    skipped: 0,
    conflictCount: 0,
    // Notices last: what was refused matters more than what was recovered.
    errors: [...errors, ...notes],
  };
}
