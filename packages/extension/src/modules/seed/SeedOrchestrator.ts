import type {
  SeedTemplate,
  SeedExecutionResult,
  SeedObjectResult,
  SeedDataPlan,
  SeedRelation,
  GrappeConfig,
  GrappeResult,
  UUID,
} from '@sandforge/shared';
import { childrenPerParent, relationFor, seedDependencies } from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
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
   * Ids of records already in the org, for a relation that draws its parents
   * from there: at most `limit` records of `objectApiName` matching `where`.
   * Without it such a relation cannot be honoured, and its child object is
   * skipped rather than written with nothing to point at.
   */
  readExistingParentIds?: (
    objectApiName: string,
    where: string | undefined,
    limit: number,
  ) => Promise<string[]>;
  /** Draws the children of a `range` relation; `Math.random` unless a caller fixes it. */
  random?: () => number;
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

  /** Standard sequential execution: each object's records in one insert call. */
  private async executeSequential(
    template: SeedTemplate,
    orgId: string,
    operationId: UUID,
    startTime: number,
  ): Promise<SeedExecutionResult> {
    const run = newRun(template);
    const sortedObjects = this.deps.referenceLinker.resolveInsertOrder(
      template.objects,
      run.relations,
    );
    const plannedRecords = template.objects.reduce((sum, o) => sum + o.recordCount, 0);

    for (const obj of sortedObjects) {
      const ready = await this.readyToWrite(obj, run, plannedRecords);
      if (!ready) continue;

      const fallback: Pick<SeedObjectResult, 'aiFallback'> = {};
      const records = startsEmpty(ready.config, ready.relation)
        ? emptyRecords(ready.config.recordCount)
        : await this.deps.fieldMapper.mapFields(ready.config, run.existingIds, (aiFallback) => {
            fallback.aiFallback = aiFallback;
          });
      fillLookup(records, ready.relation, ready.placed);
      const insertResult = await this.deps.insert(orgId, obj.objectApiName, records, obj.batchSize);
      recordWrite(run, obj, insertResult, ready.notes, fallback);
    }

    return buildSuccessResult(
      template.id,
      operationId,
      run.objectResults,
      startTime,
      this.deps.now(),
    );
  }

  /**
   * The object as its records can be generated and placed, or null once it is
   * skipped, its result then saying why.
   *
   * Both paths come through here, so what keeps a run from writing what it
   * should not holds on both: an object whose parents wrote nothing is
   * skipped, a rule naming a field the org does not have is dropped, and a
   * relation that finds no parent writes no child. The partitioned path had
   * its own copy of the loop with none of the first two: a seed large enough
   * to take it wrote the children of a parent that had written nothing, and
   * lost every record of an object to one field the org does not have.
   */
  private async readyToWrite(
    obj: SeedTemplate['objects'][number],
    run: SeedRun,
    plannedRecords: number,
  ): Promise<ReadyObject | null> {
    const relation = relationFor(obj.objectApiName, run.relations);
    // A seed that carries on past a parent it could not write fills the org
    // with records attached to nothing — worse than a run that stops,
    // because it looks like it worked. Run against a real org, one missing
    // field on Account cost all fifty of them and Seed went on to write a
    // hundred contacts and two hundred opportunities, every one an orphan.
    const missingParents = seedDependencies(obj, run.relations).filter((name) =>
      run.wroteNothing.has(name),
    );
    if (missingParents.length > 0) {
      return skipObject(
        run,
        obj.objectApiName,
        `Skipped: ${missingParents.join(', ')} wrote no records, so there is nothing for ` +
          `${obj.objectApiName} to point at.`,
      );
    }

    this.reportProgress(obj.objectApiName, run.objectResults, plannedRecords);

    const own = withoutRelationLookup(obj, relation);
    const { config: usable, dropped } = await this.dropRulesTheOrgCannotTake(own);
    if (usable.fieldRules.length === 0 && own.fieldRules.length > 0) {
      return skipObject(
        run,
        obj.objectApiName,
        `Skipped: this org has none of the fields the template names (${dropped.join(', ')}).`,
      );
    }

    let placed: PlacedChildren | undefined;
    if (relation) {
      const placement = await this.placeChildren(obj, relation, run.existingIds);
      if ('skipped' in placement) return skipObject(run, obj.objectApiName, placement.skipped);
      placed = placement;
    }

    return {
      relation,
      config: placed ? { ...usable, recordCount: placed.parentIds.length } : usable,
      placed,
      notes: [
        ...(dropped.length > 0
          ? [
              `Written without ${dropped.join(', ')}: this org does not have ${dropped.length === 1 ? 'that field' : 'those fields'}.`,
            ]
          : []),
        ...(placed?.notes ?? []),
      ],
    };
  }

  /**
   * The parent id each record of a relation's child gets, in order, or why
   * none can be written. Parents come from the ids this run's insert of the
   * parent object returned, or from the org; each receives what the
   * distribution gives it, and the whole stops at the child's record count —
   * the most the run was planned and confirmed on.
   */
  private async placeChildren(
    obj: SeedTemplate['objects'][number],
    relation: SeedRelation,
    existingIds: ReadonlyMap<string, string[]>,
  ): Promise<PlacedChildren | { skipped: string }> {
    const { childObject: child, lookupField: lookup, parentObject: parent } = relation;
    if (!(await this.orgTakesField(child, lookup))) {
      return {
        skipped: `Skipped: this org does not let a seed write ${child}.${lookup}, the lookup the relation fills.`,
      };
    }

    let parents: string[];
    if (relation.parents.kind === 'generated') {
      parents = existingIds.get(parent) ?? [];
    } else {
      const read = this.deps.readExistingParentIds;
      if (!read) {
        return {
          skipped: `Skipped: this run cannot read the ${parent} records already in the org, so ${child} has nothing to point at.`,
        };
      }
      try {
        parents = await read(parent, relation.parents.where, relation.parents.limit);
      } catch (err: unknown) {
        return {
          skipped: `Skipped: reading the ${parent} records already in the org failed (${extractErrorMessage(err)}), so ${child} has nothing to point at.`,
        };
      }
    }
    if (parents.length === 0) {
      const where = relation.parents.kind === 'existing' ? relation.parents.where?.trim() : '';
      const none =
        relation.parents.kind === 'generated'
          ? `${parent} wrote no records`
          : `no ${parent} record in the org matches ${where ? `"${where}"` : 'the relation'}`;
      return { skipped: `Skipped: ${none}, so there is nothing for ${child} to point at.` };
    }

    const perParent = childrenPerParent(relation.distribution, parents.length, this.deps.random);
    const spread = perParent.reduce((sum, count) => sum + count, 0);
    const parentIds: string[] = [];
    for (const [index, count] of perParent.entries()) {
      for (let k = 0; k < count && parentIds.length < obj.recordCount; k++) {
        parentIds.push(parents[index]);
      }
    }
    if (parentIds.length === 0) {
      return {
        skipped: `Skipped: the relation gives none of the ${parents.length} ${parent} records a ${child}.`,
      };
    }
    return {
      parentIds,
      notes:
        spread > parentIds.length
          ? [
              `Stopped at ${parentIds.length} ${child} records, the most the template asks for: ` +
                `the relation spreads ${spread} over ${parents.length} ${parent} records.`,
            ]
          : [],
    };
  }

  /** Whether the org lets a seed write `field` on `objectApiName`; yes when nothing can tell. */
  private async orgTakesField(objectApiName: string, field: string): Promise<boolean> {
    if (!this.deps.describeCreateableFields) return true;
    try {
      return (await this.deps.describeCreateableFields(objectApiName)).has(field);
    } catch {
      return true;
    }
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

    const run = newRun(template);
    const sortedObjects = this.deps.referenceLinker.resolveInsertOrder(
      template.objects,
      run.relations,
    );
    const grappeResults: GrappeResult[] = [];
    let processedPartitions = 0;

    for (const obj of sortedObjects) {
      const ready = await this.readyToWrite(obj, run, totalRecords);
      if (!ready) continue;

      const fallback: Pick<SeedObjectResult, 'aiFallback'> = {};
      const records = startsEmpty(ready.config, ready.relation)
        ? emptyRecords(ready.config.recordCount)
        : await this.deps.fieldMapper.mapFields(ready.config, run.existingIds, (aiFallback) => {
            fallback.aiFallback = aiFallback;
          });
      fillLookup(records, ready.relation, ready.placed);
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
            run.objectResults,
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

      recordWrite(
        run,
        obj,
        { successIds: objCreatedIds, errors: objErrors },
        ready.notes,
        fallback,
      );
    }

    const totalProcessed = run.objectResults.reduce((s, r) => s + r.recordsCreated, 0);
    const totalFailed = run.objectResults.reduce((s, r) => s + r.recordsFailed, 0);

    this.deps.onGrappeEvent?.({
      type: 'grappe:completed',
      payload: { operationId, totalProcessed, totalFailed },
    });

    return buildSuccessResult(
      template.id,
      operationId,
      run.objectResults,
      startTime,
      this.deps.now(),
    );
  }
}

/** What a run carries from one object to the next. */
interface SeedRun {
  relations: SeedRelation[];
  /** The ids each object's insert returned, for the lookups and relations after it. */
  existingIds: Map<string, string[]>;
  /**
   * Objects that were asked for records and wrote none. What points at one of
   * them cannot be attached to anything.
   */
  wroteNothing: Set<string>;
  objectResults: SeedObjectResult[];
}

/** A run of `template` before its first object. */
function newRun(template: SeedTemplate): SeedRun {
  return {
    relations: template.relations ?? [],
    existingIds: new Map(),
    wroteNothing: new Set(),
    objectResults: [],
  };
}

/** An object past the guards: what its records are generated from and placed by. */
interface ReadyObject {
  relation: SeedRelation | undefined;
  /** The object's config, less the rules the org cannot take and the lookup a relation fills. */
  config: SeedTemplate['objects'][number];
  placed: PlacedChildren | undefined;
  /** What its result says besides the insert's own errors. */
  notes: string[];
}

/** Skip an object before anything is written for it, saying why; null for the caller to return. */
function skipObject(run: SeedRun, objectApiName: string, message: string): null {
  run.objectResults.push(skippedResult(objectApiName, message));
  run.wroteNothing.add(objectApiName);
  return null;
}

/** Keep what the org answered for an object: for the objects after it, and in its result. */
function recordWrite(
  run: SeedRun,
  obj: SeedTemplate['objects'][number],
  written: InsertResult,
  notes: string[],
  fallback: Pick<SeedObjectResult, 'aiFallback'>,
): void {
  run.existingIds.set(obj.objectApiName, written.successIds);
  if (obj.recordCount > 0 && written.successIds.length === 0) {
    run.wroteNothing.add(obj.objectApiName);
  }
  run.objectResults.push({
    objectApiName: obj.objectApiName,
    recordsCreated: written.successIds.length,
    recordsFailed: written.errors.length,
    createdIds: written.successIds,
    errors: [...written.errors, ...notes],
    ...fallback,
  });
}

/** Where a relation places the records of its child: one parent id per record. */
interface PlacedChildren {
  parentIds: string[];
  /** What the result says about the placement, e.g. that the record count stopped it. */
  notes: string[];
}

/** The object's rules, less the one on the lookup its relation fills. */
function withoutRelationLookup(
  obj: SeedTemplate['objects'][number],
  relation: SeedRelation | undefined,
): SeedTemplate['objects'][number] {
  if (!relation) return obj;
  const fieldRules = obj.fieldRules.filter((rule) => rule.fieldApiName !== relation.lookupField);
  return fieldRules.length === obj.fieldRules.length ? obj : { ...obj, fieldRules };
}

/**
 * Whether an object's records start empty rather than from its rules. A
 * relation's child may name no field besides the lookup the relation fills —
 * a junction of two lookups need not — and still has records to write;
 * `mapFields` answers none for a config without rules.
 */
function startsEmpty(
  config: SeedTemplate['objects'][number],
  relation: SeedRelation | undefined,
): boolean {
  return relation !== undefined && config.fieldRules.length === 0;
}

/** `count` records with no field set yet. */
function emptyRecords(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (): Record<string, unknown> => ({}));
}

/** Give each child record the parent id placed for it. */
function fillLookup(
  records: Record<string, unknown>[],
  relation: SeedRelation | undefined,
  placed: PlacedChildren | undefined,
): void {
  if (!relation || !placed) return;
  for (const [index, record] of records.entries()) {
    record[relation.lookupField] = placed.parentIds[index];
  }
}

/** The result of an object skipped before anything was written for it. */
function skippedResult(objectApiName: string, message: string): SeedObjectResult {
  return { objectApiName, recordsCreated: 0, recordsFailed: 0, createdIds: [], errors: [message] };
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
  // An object skipped before its insert neither wrote nor failed a record, so
  // counting failures alone called a run a success whose relation found no
  // parent in the org and wrote no child.
  const skipped = objectResults.some(
    (r) => r.recordsCreated === 0 && r.recordsFailed === 0 && r.errors.length > 0,
  );
  return {
    templateId,
    operationId,
    status: determineStatus(totalCreated, totalFailed, skipped),
    objectResults,
    totalRecordsCreated: totalCreated,
    totalRecordsFailed: totalFailed,
    duration: Date.now() - startTime,
    timestamp,
  };
}

/** Determine the overall status from created/failed counts and skipped objects */
function determineStatus(
  totalCreated: number,
  totalFailed: number,
  skipped: boolean,
): 'success' | 'partial' | 'failure' {
  if (totalFailed === 0 && !skipped) {
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
