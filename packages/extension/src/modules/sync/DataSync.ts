import type {
  SyncObjectConfig,
  SyncObjectResult,
  SyncOperation,
  FieldMapping,
  AddOnField,
} from '@sandforge/shared';
import type { CrudFlsGuard, CrudOperation } from '../../core/metadata/CrudFlsGuard.js';
import { FieldTypeValidator } from './FieldTypeValidator.js';
import type { TargetFieldDescriptor } from './FieldTypeValidator.js';

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
}

/** Dependencies required by DataSync */
export interface DataSyncDeps {
  upsert: UpsertFn;
  insert: InsertFn;
  update: UpdateFn;
  delete: DeleteFn;
  /** Optional CRUD/FLS guard. When provided, permissions are re-verified before each DML operation. */
  crudFlsGuard?: CrudFlsGuard;
  /** Optional target field descriptors for pre-CRUD validation. */
  targetFieldDescriptors?: TargetFieldDescriptor[];
}

/**
 * Core data synchronization service between Salesforce orgs.
 * Takes source records, applies field mappings and add-on fields,
 * then writes to the target org using the appropriate operation.
 * Validates record values against target field constraints when target descriptors are provided.
 */
export class DataSync {
  private readonly deps: DataSyncDeps;
  private readonly fieldValidator: FieldTypeValidator;

  constructor(deps: DataSyncDeps) {
    this.deps = deps;
    this.fieldValidator = new FieldTypeValidator();
  }

  /**
   * Synchronize records for a single object configuration.
   * Applies field mappings and add-on fields, then performs the specified operation.
   * When target field descriptors are provided, validates record values before CRUD.
   */
  async sync(
    config: SyncObjectConfig,
    sourceRecords: Record<string, unknown>[],
  ): Promise<SyncObjectResult> {
    const mappedRecords = sourceRecords.map((record) =>
      applyMappingsAndAddOns(record, config.fieldMappings, config.addOnFields),
    );

    // Pre-CRUD field validation when target descriptors are available
    if (
      this.deps.targetFieldDescriptors &&
      this.deps.targetFieldDescriptors.length > 0 &&
      mappedRecords.length > 0
    ) {
      const validation = this.fieldValidator.validateRecords(
        mappedRecords,
        this.deps.targetFieldDescriptors,
      );
      if (!validation.valid) {
        const errorMessages = validation.errors.map(
          (e) => `Record[${e.recordIndex}].${e.field}: ${e.message}`,
        );
        return {
          objectApiName: config.objectApiName,
          operation: config.operation,
          processed: mappedRecords.length,
          success: 0,
          failed: mappedRecords.length,
          skipped: 0,
          conflictCount: 0,
          errors: errorMessages,
        };
      }
    }

    const outcomes = await this.executeOperation(
      config.objectApiName,
      config.operation,
      mappedRecords,
      config.batchSize,
      config.externalIdField,
    );

    return buildResult(config.objectApiName, config.operation, outcomes);
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
 * Apply field mappings and add-on fields to a single source record.
 */
function applyMappingsAndAddOns(
  record: Record<string, unknown>,
  mappings: FieldMapping[],
  addOns: AddOnField[],
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

  for (const addOn of addOns) {
    const fieldExists = addOn.fieldApiName in result;
    if (!fieldExists || addOn.overwriteExisting) {
      result[addOn.fieldApiName] = addOn.value;
    }
  }

  return result;
}

/**
 * Build a SyncObjectResult from operation outcomes.
 */
function buildResult(
  objectApiName: string,
  operation: SyncOperation,
  outcomes: OperationOutcome[],
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
    errors,
  };
}
