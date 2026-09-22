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
import type { CoreServices } from '../../services.js';

/** Function signature for inserting records into Salesforce */
export type InsertFn = (
  orgId: string,
  objectApiName: string,
  records: Record<string, unknown>[],
  batchSize: number,
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

/** Progress reported as a seed moves on to its next object or partition. */
export interface SeedProgressEvent {
  /** The object about to be generated and inserted. */
  objectApiName: string;
  /** Records already sent to the org, created or failed, across all objects. */
  processedRecords: number;
  /** Records the template plans across all objects. */
  totalRecords: number;
  /** processedRecords over totalRecords, 0-100. */
  percentage: number;
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
  /**
   * Called before each object, on both the sequential and the partitioned path,
   * and on the partitioned path before each further partition of an object.
   */
  onProgress?: (event: SeedProgressEvent) => void;
  /**
   * The fields the org will accept on a write, per object.
   *
   * A template names fields; an org may not have them. `AnnualRevenue` is a
   * standard Account field and a real org did not expose it, so every one of
   * the fifty accounts a built-in template asked for was refused with "No such
   * column" — and, before the guard above, a hundred contacts and two hundred
   * opportunities were then written attached to nothing.
   *
   * A rule for a field the org does not have is dropped and named in the
   * result, which writes the records the template was for. Optional: without
   * it the run behaves as it did, and an object left with no rule at all is
   * still refused rather than written empty.
   */
  describeCreateableFields?: (objectApiName: string) => Promise<ReadonlySet<string>>;
  /**
   * Injected cross-cutting adapters (telemetry, storage, fs).
   * Provided by the composition root (`services.ts`). Optional to preserve
   * backward compatibility with tests that pass a narrow deps shape.
   */
  services?: CoreServices;
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
  async execute(template: SeedTemplate, orgId: string): Promise<SeedExecutionResult> {
    const operationId = this.deps.generateId();
    const startTime = Date.now();

    const validation = this.deps.validator.validate(template);
    if (!validation.valid) {
      return buildFailureResult(
        template.id,
        operationId,
        validation.errors.map((e) => e.message),
        this.deps.now(),
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

  /**
   * Report the object about to run and the records written before it. Without
   * it a run reported only its start and its end, and Quick Seed showed a bar
   * fixed at 50% for the whole run. `writtenInObject` counts the partitions of
   * the current object already inserted, so a partitioned object reports each
   * partition instead of restarting its count at 0.
   */
  private reportProgress(
    objectApiName: string,
    objectResults: SeedObjectResult[],
    totalRecords: number,
    writtenInObject = 0,
  ): void {
    const processedRecords = objectResults.reduce(
      (sum, r) => sum + r.recordsCreated + r.recordsFailed,
      writtenInObject,
    );
    this.deps.onProgress?.({
      objectApiName,
      processedRecords,
      totalRecords,
      percentage: Math.round((processedRecords / Math.max(totalRecords, 1)) * 100),
    });
  }

  /** Standard sequential execution — original logic. */
  private async executeSequential(
    template: SeedTemplate,
    orgId: string,
    operationId: UUID,
    startTime: number,
  ): Promise<SeedExecutionResult> {
    const sortedObjects = this.deps.referenceLinker.resolveInsertOrder(template.objects);
    const existingIds = new Map<string, string[]>();
    const objectResults: SeedObjectResult[] = [];
    const plannedRecords = template.objects.reduce((sum, o) => sum + o.recordCount, 0);

    // Objects that were asked for records and wrote none. What points at one
    // of them cannot be attached to anything.
    const wroteNothing = new Set<string>();

    for (const obj of sortedObjects) {
      // A seed that carries on past a parent it could not write fills the org
      // with records attached to nothing — worse than a run that stops,
      // because it looks like it worked. Run against a real org, one missing
      // field on Account cost all fifty of them and Seed went on to write a
      // hundred contacts and two hundred opportunities, every one an orphan.
      const missingParents = referencedObjects(obj).filter((name) => wroteNothing.has(name));
      if (missingParents.length > 0) {
        objectResults.push({
          objectApiName: obj.objectApiName,
          recordsCreated: 0,
          recordsFailed: 0,
          createdIds: [],
          errors: [
            `Skipped: ${missingParents.join(', ')} wrote no records, so there is nothing for ` +
              `${obj.objectApiName} to point at.`,
          ],
        });
        wroteNothing.add(obj.objectApiName);
        continue;
      }

      this.reportProgress(obj.objectApiName, objectResults, plannedRecords);

      const { config: usable, dropped } = await this.dropRulesTheOrgCannotTake(obj);
      if (usable.fieldRules.length === 0 && obj.fieldRules.length > 0) {
        objectResults.push({
          objectApiName: obj.objectApiName,
          recordsCreated: 0,
          recordsFailed: 0,
          createdIds: [],
          errors: [
            `Skipped: this org has none of the fields the template names ` +
              `(${dropped.join(', ')}).`,
          ],
        });
        wroteNothing.add(obj.objectApiName);
        continue;
      }

      const fallback: Pick<SeedObjectResult, 'aiFallback'> = {};
      const records = await this.deps.fieldMapper.mapFields(usable, existingIds, (aiFallback) => {
        fallback.aiFallback = aiFallback;
      });
      const insertResult = await this.deps.insert(orgId, obj.objectApiName, records, obj.batchSize);

      existingIds.set(obj.objectApiName, insertResult.successIds);
      if (obj.recordCount > 0 && insertResult.successIds.length === 0) {
        wroteNothing.add(obj.objectApiName);
      }

      objectResults.push({
        objectApiName: obj.objectApiName,
        recordsCreated: insertResult.successIds.length,
        recordsFailed: insertResult.errors.length,
        createdIds: insertResult.successIds,
        errors:
          dropped.length > 0
            ? [
                ...insertResult.errors,
                `Written without ${dropped.join(', ')}: this org does not have ${dropped.length === 1 ? 'that field' : 'those fields'}.`,
              ]
            : insertResult.errors,
        ...fallback,
      });
    }

    return buildSuccessResult(template.id, operationId, objectResults, startTime, this.deps.now());
  }

  /**
   * The object's rules, less the ones naming a field this org does not have.
   *
   * A reference rule fills a lookup and is left alone: the field it writes is
   * named by the rule, and a describe that cannot see it is a reason to let
   * the platform answer rather than to guess.
   */
  private async dropRulesTheOrgCannotTake(
    obj: SeedTemplate['objects'][number],
  ): Promise<{ config: SeedTemplate['objects'][number]; dropped: string[] }> {
    if (!this.deps.describeCreateableFields) return { config: obj, dropped: [] };
    let creatable: ReadonlySet<string>;
    try {
      creatable = await this.deps.describeCreateableFields(obj.objectApiName);
    } catch {
      return { config: obj, dropped: [] };
    }
    const kept = obj.fieldRules.filter(
      (rule) => rule.ruleType === 'reference' || creatable.has(rule.fieldApiName),
    );
    if (kept.length === obj.fieldRules.length) return { config: obj, dropped: [] };
    const dropped = obj.fieldRules
      .filter((rule) => !kept.includes(rule))
      .map((rule) => rule.fieldApiName);
    return { config: { ...obj, fieldRules: kept }, dropped };
  }

  /** Grappe (partitioned) execution — splits work into partitions with progress tracking. */
  private async executeWithGrappe(
    template: SeedTemplate,
    orgId: string,
    operationId: UUID,
    startTime: number,
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
      this.reportProgress(obj.objectApiName, objectResults, totalRecords);
      const fallback: Pick<SeedObjectResult, 'aiFallback'> = {};
      const records = await this.deps.fieldMapper.mapFields(obj, existingIds, (aiFallback) => {
        fallback.aiFallback = aiFallback;
      });
      const grappeSize = this.deps.grappeConfig?.grappeSize ?? 2000;
      const chunks = chunkArray(records, grappeSize);

      let objSuccess = 0;
      let objFailed = 0;
      const objErrors: string[] = [];
      const objCreatedIds: string[] = [];

      for (const [chunkIndex, chunk] of chunks.entries()) {
        if (chunkIndex > 0) {
          this.reportProgress(
            obj.objectApiName,
            objectResults,
            totalRecords,
            objSuccess + objFailed,
          );
        }
        const partitionStart = Date.now();
        const partitionId = partitions[processedPartitions]?.id ?? this.deps.generateId();
        const insertResult = await this.deps.insert(orgId, obj.objectApiName, chunk, obj.batchSize);

        objSuccess += insertResult.successIds.length;
        objFailed += insertResult.errors.length;
        objErrors.push(...insertResult.errors);
        objCreatedIds.push(...insertResult.successIds);

        grappeResults.push({
          grappeId: partitionId,
          status:
            insertResult.errors.length === 0
              ? 'success'
              : insertResult.successIds.length > 0
                ? 'partial'
                : 'failure',
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
        ...fallback,
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
  timestamp: string,
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
  totalFailed: number,
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
  timestamp: string,
): SeedExecutionResult {
  return {
    templateId,
    operationId,
    status: 'failure',
    objectResults: [
      {
        objectApiName: 'validation',
        recordsCreated: 0,
        recordsFailed: 0,
        createdIds: [],
        errors,
      },
    ],
    totalRecordsCreated: 0,
    totalRecordsFailed: 0,
    duration: 0,
    timestamp,
  };
}

/**
 * The objects this one's reference rules point at.
 *
 * A `reference` rule names the object its value is drawn from; without those
 * ids there is nothing to fill the field with.
 */
function referencedObjects(obj: SeedTemplate['objects'][number]): string[] {
  const names = new Set<string>();
  for (const rule of obj.fieldRules) {
    if (rule.ruleType !== 'reference') continue;
    const target = rule.config.referenceObject;
    if (typeof target === 'string' && target) names.add(target);
  }
  return [...names];
}
