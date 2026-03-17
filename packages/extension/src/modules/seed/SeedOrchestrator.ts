import type {
  SeedTemplate,
  SeedExecutionResult,
  SeedObjectResult,
  SeedDataPlan,
  GrappeConfig,
  GrappeResult,
  UUID,
} from '@sandforge/shared';
import type { SeedValidator } from './SeedValidator';
import type { DataPlanBuilder } from './DataPlanBuilder';
import type { FieldMapper } from './FieldMapper';
import type { ReferenceLinker } from './ReferenceLinker';
import type { SeedGrappeAdapter } from './SeedGrappeAdapter';

/** Function signature for inserting records into Salesforce */
export type InsertFn = (
  orgId: string,
  objectApiName: string,
  records: Record<string, unknown>[],
  batchSize: number
) => Promise<InsertResult>;

/** Result of a batch insert operation */
export interface InsertResult {
  successIds: string[];
  errors: string[];
}

/** Function signature for generating unique IDs */
export type GenerateIdFn = () => UUID;

/** Function signature for getting the current ISO timestamp */
export type NowFn = () => string;

/** Grappe event emitted during partitioned execution */
export interface GrappeEvent {
  type: 'grappe:started' | 'grappe:partitionProgress' | 'grappe:completed';
  payload: Record<string, unknown>;
}

/** Dependencies required by SeedOrchestrator */
export interface SeedOrchestratorDependencies {
  validator: SeedValidator;
  planBuilder: DataPlanBuilder;
  fieldMapper: FieldMapper;
  referenceLinker: ReferenceLinker;
  insert: InsertFn;
  generateId: GenerateIdFn;
  now: NowFn;
  grappeAdapter?: SeedGrappeAdapter;
  grappeConfig?: GrappeConfig;
  onGrappeEvent?: (event: GrappeEvent) => void;
}

/**
 * Central orchestrator for seed operations.
 * Coordinates validation, plan building, data generation,
 * reference linking, and insertion in dependency order.
 * Supports grappe (partitioned) mode for large datasets.
 */
export class SeedOrchestrator {
  private readonly deps: SeedOrchestratorDependencies;

  constructor(deps: SeedOrchestratorDependencies) {
    this.deps = deps;
  }

  /**
   * Execute a full seed operation for the given template.
   * Steps: validate template, build plan, generate data per object
   * in dependency order, insert records, and collect results.
   * Activates grappe mode when total records exceed the configured threshold.
   */
  async execute(
    template: SeedTemplate,
    orgId: string
  ): Promise<SeedExecutionResult> {
    const operationId = this.deps.generateId();
    const startTime = Date.now();

    const validation = this.deps.validator.validate(template);
    if (!validation.valid) {
      return buildFailureResult(
        template.id,
        operationId,
        validation.errors.map((e) => e.message),
        this.deps.now()
      );
    }

    const totalRecords = template.objects.reduce((sum, o) => sum + o.recordCount, 0);
    const useGrappe = this.shouldActivateGrappe(totalRecords);

    if (useGrappe) {
      return this.executeWithGrappe(template, orgId, operationId, startTime);
    }

    return this.executeSequential(template, orgId, operationId, startTime);
  }

  /** Build a preview plan for the template without executing */
  preview(template: SeedTemplate): SeedDataPlan {
    return this.deps.planBuilder.build(template);
  }

  /** Check whether grappe mode should activate based on record count and config. */
  private shouldActivateGrappe(totalRecords: number): boolean {
    const config = this.deps.grappeConfig;
    return !!(
      config?.enabled &&
      this.deps.grappeAdapter &&
      totalRecords >= config.autoActivateThreshold
    );
  }

  /** Standard sequential execution — original logic. */
  private async executeSequential(
    template: SeedTemplate,
    orgId: string,
    operationId: UUID,
    startTime: number
  ): Promise<SeedExecutionResult> {
    const sortedObjects = this.deps.referenceLinker.resolveInsertOrder(template.objects);
    const existingIds = new Map<string, string[]>();
    const objectResults: SeedObjectResult[] = [];

    for (const obj of sortedObjects) {
      const records = await this.deps.fieldMapper.mapFields(obj, existingIds);
      const insertResult = await this.deps.insert(
        orgId,
        obj.objectApiName,
        records,
        obj.batchSize
      );

      existingIds.set(obj.objectApiName, insertResult.successIds);

      objectResults.push({
        objectApiName: obj.objectApiName,
        recordsCreated: insertResult.successIds.length,
        recordsFailed: insertResult.errors.length,
        createdIds: insertResult.successIds,
        errors: insertResult.errors,
      });
    }

    return buildSuccessResult(template.id, operationId, objectResults, startTime, this.deps.now());
  }

  /** Grappe (partitioned) execution — splits work into partitions with progress tracking. */
  private async executeWithGrappe(
    template: SeedTemplate,
    orgId: string,
    operationId: UUID,
    startTime: number
  ): Promise<SeedExecutionResult> {
    const adapter = this.deps.grappeAdapter!;
    const partitions = adapter.partition(template);
    const totalRecords = partitions.reduce((s, p) => s + p.recordCount, 0);

    this.deps.onGrappeEvent?.({
      type: 'grappe:started',
      payload: { operationId, totalPartitions: partitions.length, totalRecords },
    });

    const sortedObjects = this.deps.referenceLinker.resolveInsertOrder(template.objects);
    const existingIds = new Map<string, string[]>();
    const objectResults: SeedObjectResult[] = [];
    const grappeResults: GrappeResult[] = [];
    let processedPartitions = 0;

    for (const obj of sortedObjects) {
      const records = await this.deps.fieldMapper.mapFields(obj, existingIds);
      const grappeSize = this.deps.grappeConfig?.grappeSize ?? 2000;
      const chunks = chunkArray(records, grappeSize);

      let objSuccess = 0;
      let objFailed = 0;
      const objErrors: string[] = [];
      const objCreatedIds: string[] = [];

      for (const chunk of chunks) {
        const partitionStart = Date.now();
        const partitionId = partitions[processedPartitions]?.id ?? this.deps.generateId();
        const insertResult = await this.deps.insert(orgId, obj.objectApiName, chunk, obj.batchSize);

        objSuccess += insertResult.successIds.length;
        objFailed += insertResult.errors.length;
        objErrors.push(...insertResult.errors);
        objCreatedIds.push(...insertResult.successIds);

        grappeResults.push({
          grappeId: partitionId,
          status: insertResult.errors.length === 0 ? 'success' : insertResult.successIds.length > 0 ? 'partial' : 'failure',
          processedRecords: chunk.length,
          successCount: insertResult.successIds.length,
          failureCount: insertResult.errors.length,
          errors: insertResult.errors,
          duration: Date.now() - partitionStart,
        });

        processedPartitions++;
        const percentage = Math.round((processedPartitions / Math.max(partitions.length, 1)) * 100);

        this.deps.onGrappeEvent?.({
          type: 'grappe:partitionProgress',
          payload: { grappeId: partitionId, percentage, processedRecords: objSuccess + objFailed },
        });
      }

      existingIds.set(obj.objectApiName, objCreatedIds);

      objectResults.push({
        objectApiName: obj.objectApiName,
        recordsCreated: objSuccess,
        recordsFailed: objFailed,
        createdIds: objCreatedIds,
        errors: objErrors,
      });
    }

    const totalProcessed = objectResults.reduce((s, r) => s + r.recordsCreated, 0);
    const totalFailed = objectResults.reduce((s, r) => s + r.recordsFailed, 0);

    this.deps.onGrappeEvent?.({
      type: 'grappe:completed',
      payload: { operationId, totalProcessed, totalFailed },
    });

    return buildSuccessResult(template.id, operationId, objectResults, startTime, this.deps.now());
  }
}

/** Split an array into chunks of a given size */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks.length === 0 ? [array] : chunks;
}

/** Build a success/partial result from object results */
function buildSuccessResult(
  templateId: UUID,
  operationId: UUID,
  objectResults: SeedObjectResult[],
  startTime: number,
  timestamp: string
): SeedExecutionResult {
  const totalCreated = objectResults.reduce((s, r) => s + r.recordsCreated, 0);
  const totalFailed = objectResults.reduce((s, r) => s + r.recordsFailed, 0);
  return {
    templateId,
    operationId,
    status: determineStatus(totalCreated, totalFailed),
    objectResults,
    totalRecordsCreated: totalCreated,
    totalRecordsFailed: totalFailed,
    duration: Date.now() - startTime,
    timestamp,
  };
}

/** Determine the overall status based on created/failed counts */
function determineStatus(
  totalCreated: number,
  totalFailed: number
): 'success' | 'partial' | 'failure' {
  if (totalFailed === 0) {
    return 'success';
  }
  if (totalCreated === 0) {
    return 'failure';
  }
  return 'partial';
}

/** Build a failure result when validation fails */
function buildFailureResult(
  templateId: UUID,
  operationId: UUID,
  errors: string[],
  timestamp: string
): SeedExecutionResult {
  return {
    templateId,
    operationId,
    status: 'failure',
    objectResults: [{
      objectApiName: 'validation',
      recordsCreated: 0,
      recordsFailed: 0,
      createdIds: [],
      errors,
    }],
    totalRecordsCreated: 0,
    totalRecordsFailed: 0,
    duration: 0,
    timestamp,
  };
}
