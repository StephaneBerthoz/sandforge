import type {
  SeedTemplate,
  SeedExecutionResult,
  SeedObjectResult,
  SeedDataPlan,
  SeedRelation,
  GrappeConfig,
  GrappePartition,
  GrappeResult,
  UUID,
} from '@sandforge/shared';
import type { DescribedSeedField, FieldRule, SeedAiFallback } from '@sandforge/shared';
import {
  PRICEBOOK_OBJECT,
  childrenPerParent,
  describedFieldRule,
  relationFor,
  seedDependencies,
  seedsStandardPricebook,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import type { SaveErrorDetail } from '../../core/common/existingRecordMatch.js';
import { addWrittenWithoutFields, fieldsLeftOutNote } from '../../core/common/refusedFields.js';
import type { SeedValidator } from './SeedValidator';
import type { DataPlanBuilder } from './DataPlanBuilder';
import type { FieldMapper } from './FieldMapper';
import type { ReferenceLinker } from './ReferenceLinker';
import type { SeedGrappeAdapter } from './SeedGrappeAdapter';
import { sendRefusedRowsAgain, type SentAgain } from './sendRefusedRowsAgain.js';
import { recordParentsRefusals } from './existingParents.js';
import type { CoreServices } from '../../services.js';

/**
 * Records of an object a sequential seed generates and inserts at a time, at
 * most: what it holds of an object whatever its count (see `slicesOf`). An
 * object of no more goes in one insert, as every object did.
 */
export const SEED_SLICE_RECORDS = 10_000;

/**
 * Values — records times rules — one slice holds, at most: a wide object is
 * generated in fewer records at a time. Ten thousand records of fourteen
 * rules took some 20 MB; of the hundreds of rules a wide object gets by
 * default, they would take hundreds.
 */
export const SEED_SLICE_VALUES = 500_000;

/** Fewest records a slice holds, however wide the object: a REST call's worth. */
const SEED_SLICE_LEAST = 200;

/** The records of `config` one slice of a sequential seed holds: see {@link SEED_SLICE_VALUES}. */
export function seedSliceOf(config: Pick<SeedTemplate['objects'][number], 'fieldRules'>): number {
  const byValues = Math.floor(SEED_SLICE_VALUES / Math.max(1, config.fieldRules.length));
  return Math.max(SEED_SLICE_LEAST, Math.min(SEED_SLICE_RECORDS, byValues));
}

/** Function signature for inserting records into Salesforce */
export type InsertFn = (
  orgId: string,
  objectApiName: string,
  records: Record<string, unknown>[],
  batchSize: number,
) => Promise<InsertResult>;

/** What the org answered for one record of an insert. */
export interface InsertedRow {
  /** The id it gave the record; absent when it refused it. */
  id?: string;
  /** Why it refused it, as `errors` counts it. */
  error?: string;
  /** Every error it refused it with, each with its code and the fields it named. */
  errorDetails?: SaveErrorDetail[];
}

/** Result of a batch insert operation */
export interface InsertResult {
  successIds: string[];
  errors: string[];
  /**
   * Set when the run's cancel stopped the insert before all of its records
   * were sent: the ids and errors are those of the records sent before it.
   */
  stopped?: boolean;
  /**
   * What the org answered for each record sent, in the order sent, when the
   * write can say: what a row refused on fields a validation rule or a
   * restricted picklist named is sent again from (`sendRefusedRowsAgain`).
   * The REST path answers so; the Bulk API's paths do not, and a row they
   * see refused stays refused.
   */
  rows?: InsertedRow[];
  /** What the object's result says of how its records were sent. Absent when nothing is. */
  notes?: string[];
}

/**
 * What the org lets a seed do with an object: create its records, or not —
 * the user may not (`readOnly`, with why when the reason is known), or the
 * org has no such object (`absent`, with the feature it needs when known).
 */
export type SeedObjectAccess =
  { access: 'createable' } | { access: 'readOnly' | 'absent'; reason?: string };

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
   * Every field the describe lists, settable or not. A dropped rule's field it
   * lists exists and is one the user may not set; one it does not list the
   * org lacks, or field-level security hides from the user. The result said
   * "this org does not have that field" of both. Optional: without it, the
   * result names both causes.
   */
  describeVisibleFields?: (objectApiName: string) => Promise<ReadonlySet<string>>;
  /**
   * Whether the org has an object and lets the user the seed runs as create
   * its records. An object it has not — `Knowledge__kav` where Knowledge is
   * off — or one the user may not create — a campaign without the Marketing
   * User box — is skipped with that reason: a built-in template tried to
   * insert its hundred articles into an org without Knowledge, and every one
   * was refused. Optional: without it, or when it cannot tell, the platform
   * answers the insert.
   */
  objectAccess?: (objectApiName: string) => Promise<SeedObjectAccess>;
  /**
   * The active values of an object's picklists, by field, as the org's
   * describe gives them. A random pick keeps the values among them, or takes
   * the org's own when it names none of them: a template wrote "Customer" as
   * an account type, which no org has, and an unrestricted picklist took it
   * as a value outside its list. Optional: without it the rule's values stand.
   */
  describePicklistValues?: (
    objectApiName: string,
  ) => Promise<ReadonlyMap<string, readonly string[]>>;
  /**
   * The fields the org refuses a record of `objectApiName` without and fills
   * none of itself, lookups apart. One no rule names is given the rule the
   * wizard gives a field it describes, and named in the result: an org with a
   * required text field of its own on Account refused every account of every
   * built-in template, and every contact, opportunity and case after them
   * was skipped. Optional: without it the rules stand as written.
   */
  describeRequiredFields?: (objectApiName: string) => Promise<DescribedSeedField[]>;
  /**
   * Ids of records already in the org, for a relation that draws its parents
   * from there: at most `limit` records of `objectApiName` matching `where`.
   * Without it such a relation cannot be honoured, and its child object is
   * skipped rather than written with nothing to point at. It also reads the
   * org's standard price book, which a reference to `Pricebook2` in a seed
   * that writes none points at (`seedsStandardPricebook`).
   */
  readExistingParentIds?: (
    objectApiName: string,
    where: string | undefined,
    limit: number,
  ) => Promise<string[]>;
  /**
   * Of the ids a relation names its parents by, those of records of
   * `objectApiName` the org holds. Asked before the run's first write, with
   * {@link describeKeyPrefix}: a relation naming a record no longer in the
   * org, or one of another object, refuses the run, each named. Without it
   * such a relation cannot be checked, and the run is refused before it
   * writes.
   */
  readPresentParentIds?: (objectApiName: string, ids: readonly string[]) => Promise<string[]>;
  /** The first three characters of the ids of `objectApiName`, when its describe gives them. */
  describeKeyPrefix?: (objectApiName: string) => Promise<string | undefined>;
  /** Draws the children of a `range` relation; `Math.random` unless a caller fixes it. */
  random?: () => number;
  /**
   * The run's cancel: the Seed page's Cancel, or Live Operations', through
   * the registry the run is listed in. Honoured before each object, before
   * each insert and each partition, and by an insert that stops partway. The
   * records already inserted stay in the org; the run answers with the
   * objects it reached, `cancelled` set.
   */
  signal?: AbortSignal;
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
   *
   * @param runId - The run's id, which its result carries as `operationId`:
   *   one the caller keeps the run's creations under as it writes them, or a
   *   new one.
   */
  async execute(template: SeedTemplate, orgId: string, runId?: UUID): Promise<SeedExecutionResult> {
    const operationId = runId ?? this.deps.generateId();
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

    // Parents named by id are checked against the org before the first
    // write: they are another run's records, which may have gone since.
    const refusals = await recordParentsRefusals(template.relations, {
      ...(this.deps.describeKeyPrefix ? { keyPrefixOf: this.deps.describeKeyPrefix } : {}),
      ...(this.deps.readPresentParentIds ? { presentIds: this.deps.readPresentParentIds } : {}),
    });
    if (refusals.length > 0) {
      return buildFailureResult(template.id, operationId, refusals, this.deps.now());
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
      // The Seed page's Cancel promises "Stop the running seed", and only an
      // insert of more than ten thousand records looked at it: every other
      // object went on being generated and inserted.
      if (this.deps.signal?.aborted) {
        return this.stoppedResult(template, operationId, run, startTime);
      }
      const ready = await this.readyToWrite(obj, run, plannedRecords);
      if (!ready) continue;

      const fallback: Pick<SeedObjectResult, 'aiFallback'> = {};
      const written: InsertResult = { successIds: [], errors: [] };
      const sentAgain: SentAgain = { result: written, unsent: [] };
      let slicesSent = 0;
      let stopped = false;
      const slice = seedSliceOf(ready.config);
      for await (const records of this.slicesOf(ready, run, slice, fallback)) {
        // Generating the records can take a while when AI fills them.
        if (this.deps.signal?.aborted) {
          stopped = true;
          break;
        }
        if (slicesSent > 0) {
          this.reportProgress(
            obj.objectApiName,
            run.objectResults,
            plannedRecords,
            written.successIds.length + written.errors.length,
          );
        }
        const sent = await this.insert(orgId, obj, records, ready);
        slicesSent++;
        keepWhatASliceWrote(sentAgain, sent);
        if (sent.result.stopped) {
          stopped = true;
          break;
        }
      }
      // What the slices sent before a cancel is kept, for the objects after
      // it and in its result.
      if (slicesSent > 0) {
        recordWrite(run, obj, written, [...ready.notes, ...notesOf(sentAgain)], fallback);
      }
      if (stopped) return this.stoppedResult(template, operationId, run, startTime);
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
    const closed = await this.closedObject(obj.objectApiName);
    if (closed) return skipObject(run, obj.objectApiName, closed);

    this.reportProgress(obj.objectApiName, run.objectResults, plannedRecords);

    const own = withoutRelationLookup(obj, relation);
    const { config: fitted, dropped } = await this.dropRulesTheOrgCannotTake(own);
    const why = await this.whyDropped(obj.objectApiName, dropped);
    if (fitted.fieldRules.length === 0 && own.fieldRules.length > 0) {
      return skipObject(
        run,
        obj.objectApiName,
        `Skipped: none of the fields the template names can be written (${why.join('; ')}).`,
      );
    }
    const { config: usable, filled } = await this.withWhatTheOrgRequires(
      await this.withTheOrgsPicklistValues(fitted),
      relation,
    );
    const noStandardBook = await this.matchStandardPricebook(usable, run);
    if (noStandardBook) return skipObject(run, obj.objectApiName, noStandardBook);

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
        ...why.map((reason) => `Written without ${reason}.`),
        ...(filled.length > 0
          ? [
              `Written with ${filled.join(', ')}, which this org requires and the template names no rule for.`,
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
    } else if (relation.parents.kind === 'records') {
      // Checked before the run's first write: each is a record of the parent
      // object the org holds. Placed in the order given, as the org's own are
      // placed in the order it returns them.
      parents = [...relation.parents.ids];
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

  /**
   * Insert records of an object, then write again, without the fields the
   * org named, the rows it refused for a validation rule, a restricted
   * picklist or a lookup filter (`sendRefusedRowsAgain`) — never without the
   * lookup a relation filled, a reference rule's field, or the record type.
   * Both paths insert through here, a partition at a time on the partitioned
   * one.
   */
  /**
   * The records of an object, `size` at a time, each slice generated only
   * once the caller has written the one before: what the run holds of an
   * object is a slice, whatever its count.
   *
   * Every record of an object used to be generated before its first insert,
   * each with a key for every rule and a parallel array of what faker drew:
   * a seed of a few hundred thousand records of a wide object, under the
   * million the host takes, ran the extension host out of memory in the
   * middle of the run. A slice goes on from the one before: its sequences and
   * masks from its place among the object's records, its relation's parents
   * from the next parent placed. At least one slice, empty for an object of
   * no record, as the run always sent one insert.
   *
   * @param fallback - Given what the AI could not write, across the slices.
   */
  private async *slicesOf(
    ready: ReadyObject,
    run: SeedRun,
    size: number,
    fallback: Pick<SeedObjectResult, 'aiFallback'>,
  ): AsyncGenerator<Record<string, unknown>[]> {
    const count = ready.config.recordCount;
    const step = Math.max(1, Math.floor(size));
    let from = 0;
    do {
      const n = Math.max(0, Math.min(step, count - from));
      const records = startsEmpty(ready.config, ready.relation)
        ? emptyRecords(n)
        : await this.deps.fieldMapper.mapFields(
            n === count ? ready.config : { ...ready.config, recordCount: n },
            run.existingIds,
            (aiFallback) => {
              fallback.aiFallback = withAiFallback(fallback.aiFallback, aiFallback);
            },
            from,
          );
      fillLookup(records, ready.relation, ready.placed, from);
      yield records;
      from += n;
    } while (from < count);
  }

  private async insert(
    orgId: string,
    obj: SeedTemplate['objects'][number],
    records: Record<string, unknown>[],
    ready: ReadyObject,
  ): Promise<SentAgain> {
    const send = (rows: Record<string, unknown>[]): Promise<InsertResult> =>
      this.deps.insert(orgId, obj.objectApiName, rows, obj.batchSize);
    const first = await send(records);
    const sent = await sendRefusedRowsAgain(
      send,
      records,
      first,
      settledFields(ready),
      () => this.deps.signal?.aborted === true,
    );
    return first.notes && first.notes.length > 0 ? { ...sent, notes: first.notes } : sent;
  }

  /**
   * Why the org takes no record of `objectApiName` from this seed — it has no
   * such object, or the user may not create one — or undefined when it takes
   * them, or nothing can tell.
   */
  private async closedObject(objectApiName: string): Promise<string | undefined> {
    if (!this.deps.objectAccess) return undefined;
    let found: SeedObjectAccess;
    try {
      found = await this.deps.objectAccess(objectApiName);
    } catch {
      return undefined;
    }
    if (found.access === 'createable') return undefined;
    const why = found.reason ? ` (${found.reason})` : '';
    return found.access === 'absent'
      ? `Skipped: this org has no ${objectApiName} object${why}.`
      : `Skipped: the user this seed runs as may not create ${objectApiName} records${why}.`;
  }

  /**
   * The object's random picks, each keeping the values the org's picklist
   * has, or taking the org's own active values when it names none of them.
   * A pick on a field the org gives no values for is left as written, and so
   * is the whole object when the org's picklists cannot be read.
   */
  private async withTheOrgsPicklistValues(
    obj: SeedTemplate['objects'][number],
  ): Promise<SeedTemplate['objects'][number]> {
    if (!this.deps.describePicklistValues) return obj;
    if (!obj.fieldRules.some((rule) => rule.ruleType === 'picklist_random')) return obj;
    let picklists: ReadonlyMap<string, readonly string[]>;
    try {
      picklists = await this.deps.describePicklistValues(obj.objectApiName);
    } catch {
      return obj;
    }
    let changed = false;
    const fieldRules = obj.fieldRules.map((rule) => {
      const offered = picklists.get(rule.fieldApiName);
      const values = rule.config.picklistValues;
      if (rule.ruleType !== 'picklist_random' || !offered?.length || !values) return rule;
      const kept = values.filter((value) => offered.includes(value));
      if (kept.length === values.length) return rule;
      changed = true;
      return {
        ...rule,
        config: { ...rule.config, picklistValues: kept.length ? kept : [...offered] },
      };
    });
    return changed ? { ...obj, fieldRules } : obj;
  }

  /**
   * The object's rules, with one for each field the org requires and no rule
   * names — the rule the wizard gives a field it describes — and those fields'
   * names. A field no generator fits (a time, a multi-select picklist) is
   * left for the org to refuse, as the wizard leaves it; so are all of them
   * when the org's describe cannot be read.
   */
  private async withWhatTheOrgRequires(
    obj: SeedTemplate['objects'][number],
    relation: SeedRelation | undefined,
  ): Promise<{ config: SeedTemplate['objects'][number]; filled: string[] }> {
    if (!this.deps.describeRequiredFields) return { config: obj, filled: [] };
    let required: DescribedSeedField[];
    try {
      required = await this.deps.describeRequiredFields(obj.objectApiName);
    } catch {
      return { config: obj, filled: [] };
    }
    const named = new Set([
      ...obj.fieldRules.map((rule) => rule.fieldApiName),
      ...(relation ? [relation.lookupField] : []),
    ]);
    const added: FieldRule[] = [];
    for (const field of required) {
      if (named.has(field.fieldApiName)) continue;
      const rule = describedFieldRule(field);
      if (rule.ruleType === 'static' && rule.config.staticValue === undefined) continue;
      added.push({ fieldApiName: field.fieldApiName, fieldType: field.type, ...rule });
    }
    if (added.length === 0) return { config: obj, filled: [] };
    return {
      config: { ...obj, fieldRules: [...obj.fieldRules, ...added] },
      filled: added.map((rule) => rule.fieldApiName),
    };
  }

  /**
   * Give the run the org's standard price book, which a reference to
   * `Pricebook2` in a seed that writes none points at, read once for the
   * run; or why the object is skipped when the book cannot be had. Its
   * records then draw the book as a lookup to a record of the run.
   */
  private async matchStandardPricebook(
    obj: SeedTemplate['objects'][number],
    run: SeedRun,
  ): Promise<string | undefined> {
    if (!obj.fieldRules.some((rule) => seedsStandardPricebook(rule, run.written))) return undefined;
    if (run.existingIds.has(PRICEBOOK_OBJECT)) return undefined;
    const read = this.deps.readExistingParentIds;
    const of = `${obj.objectApiName} points at the org's standard price book`;
    if (!read) return `Skipped: ${of}, and this run cannot read it.`;
    let ids: string[];
    try {
      ids = await read(PRICEBOOK_OBJECT, 'IsStandard = true', 1);
    } catch (err: unknown) {
      return `Skipped: ${of}, and reading it failed (${extractErrorMessage(err)}).`;
    }
    if (ids.length === 0) return `Skipped: ${of}, and the org shows none to this user.`;
    run.existingIds.set(PRICEBOOK_OBJECT, ids);
    return undefined;
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
   * Why each field a seed leaves out was left out, one reason to a group:
   * `Birthdate: it exists, but the user SandForge connects as may not set it`.
   * A field the describe does not list is one the org lacks, or one
   * field-level security hides from the user; the result said "this org does
   * not have that field" of a standard field the user's profile hid, and of
   * one the user could see but not set.
   */
  private async whyDropped(objectApiName: string, dropped: readonly string[]): Promise<string[]> {
    if (dropped.length === 0) return [];
    let visible: ReadonlySet<string> = new Set();
    try {
      if (this.deps.describeVisibleFields) {
        visible = await this.deps.describeVisibleFields(objectApiName);
      }
    } catch {
      // Cannot tell: every field is said with both of its possible causes.
    }
    const notSettable = dropped.filter((field) => visible.has(field));
    const unseen = dropped.filter((field) => !visible.has(field));
    const one = (fields: readonly string[], single: string, plural: string): string =>
      fields.length === 1 ? single : plural;
    return [
      ...(unseen.length > 0
        ? [
            `${unseen.join(', ')}: this org does not have ${one(unseen, 'that field', 'those fields')}, ` +
              `or field-level security hides ${one(unseen, 'it', 'them')} from the user SandForge connects as`,
          ]
        : []),
      ...(notSettable.length > 0
        ? [
            `${notSettable.join(', ')}: ${one(notSettable, 'it exists', 'they exist')}, but the user ` +
              `SandForge connects as may not set ${one(notSettable, 'it', 'them')}`,
          ]
        : []),
    ];
  }

  /**
   * The object's rules, less the ones naming a field this org does not have,
   * or the user may not set.
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
    const grappeSize = this.deps.grappeConfig?.grappeSize ?? 2000;

    /** Tell the Grappe view the run is over, with what its objects wrote. */
    const endGrappe = (): void => {
      const totalProcessed = run.objectResults.reduce((s, r) => s + r.recordsCreated, 0);
      const totalFailed = run.objectResults.reduce((s, r) => s + r.recordsFailed, 0);

      this.deps.onGrappeEvent?.({
        type: 'grappe:completed',
        payload: { operationId, totalProcessed, totalFailed },
      });
    };

    /** End the run at a cancel: the Grappe view is told it is over, as at the end of a run. */
    const stopHere = (): SeedExecutionResult => {
      endGrappe();
      return this.stoppedResult(template, operationId, run, startTime);
    };

    for (const obj of sortedObjects) {
      if (this.deps.signal?.aborted) return stopHere();
      // As many as the adapter planned for the object, from the same size.
      const planned = Math.ceil(obj.recordCount / grappeSize);
      const ready = await this.readyToWrite(obj, run, totalRecords);
      if (!ready) {
        processedPartitions = this.settleUnusedPartitions(
          partitions,
          processedPartitions,
          planned,
          0,
        );
        continue;
      }

      const fallback: Pick<SeedObjectResult, 'aiFallback'> = {};
      // Each partition generated just before it is inserted: see `slicesOf`.
      const chunkCount = Math.max(1, Math.ceil(ready.config.recordCount / grappeSize));

      let objSuccess = 0;
      let objFailed = 0;
      const objErrors: string[] = [];
      const objCreatedIds: string[] = [];
      /** What its partitions sent again without the fields the org named, said once for the object. */
      const objSentAgain: SentAgain = { result: { successIds: [], errors: [] }, unsent: [] };
      /** Partitions of the object inserted before a cancel stopped it, if one did. */
      let stoppedAfter: number | undefined;

      let chunkIndex = -1;
      for await (const chunk of this.slicesOf(ready, run, grappeSize, fallback)) {
        chunkIndex++;
        if (this.deps.signal?.aborted) {
          stoppedAfter = chunkIndex;
          break;
        }
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
        const sent = await this.insert(orgId, obj, chunk, ready);
        const insertResult = sent.result;
        if (sent.written) {
          objSentAgain.written = addWrittenWithoutFields(objSentAgain.written, sent.written);
        }
        objSentAgain.unsent.push(...sent.unsent);
        for (const note of sent.notes ?? []) {
          if (!(objSentAgain.notes ?? []).includes(note)) {
            objSentAgain.notes = [...(objSentAgain.notes ?? []), note];
          }
        }

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
        if (insertResult.stopped) {
          stoppedAfter = chunkIndex + 1;
          break;
        }
      }
      if (stoppedAfter !== undefined) {
        // What its partitions wrote before the cancel is kept, for the objects
        // after it and in its result.
        if (stoppedAfter > 0) {
          recordWrite(
            run,
            obj,
            { successIds: objCreatedIds, errors: objErrors },
            [...ready.notes, ...notesOf(objSentAgain)],
            fallback,
          );
        }
        return stopHere();
      }
      processedPartitions = this.settleUnusedPartitions(
        partitions,
        processedPartitions,
        planned - chunkCount,
        objSuccess + objFailed,
      );

      recordWrite(
        run,
        obj,
        { successIds: objCreatedIds, errors: objErrors },
        [...ready.notes, ...notesOf(objSentAgain)],
        fallback,
      );
    }

    endGrappe();

    return buildSuccessResult(
      template.id,
      operationId,
      run.objectResults,
      startTime,
      this.deps.now(),
    );
  }

  /**
   * The run as a cancel left it: the objects it reached, `cancelled` set, and
   * a status that is never `success`, since the objects after the cancel were
   * not written.
   */
  private stoppedResult(
    template: SeedTemplate,
    operationId: UUID,
    run: SeedRun,
    startTime: number,
  ): SeedExecutionResult {
    const reached = buildSuccessResult(
      template.id,
      operationId,
      run.objectResults,
      startTime,
      this.deps.now(),
    );
    return {
      ...reached,
      status: reached.status === 'success' ? 'partial' : reached.status,
      cancelled: true,
    };
  }

  /**
   * Report the partitions planned for an object that its run did not use —
   * all of them for an object skipped, the ones past its records for a
   * relation that placed fewer children than planned — so the partitions
   * reported reach the ones announced. Left unused, a skipped object held the
   * run's progress short of 100% for good.
   *
   * @param partitions - The partitions announced for the run.
   * @param processed - The partitions reported so far.
   * @param unused - How many of the object's planned partitions it did not use.
   * @param processedRecords - The object's records written or refused.
   * @returns The partitions reported so far, these included.
   */
  private settleUnusedPartitions(
    partitions: GrappePartition[],
    processed: number,
    unused: number,
    processedRecords: number,
  ): number {
    let reported = processed;
    for (let left = unused; left > 0; left--) {
      const grappeId = partitions[reported]?.id ?? this.deps.generateId();
      reported++;
      this.deps.onGrappeEvent?.({
        type: 'grappe:partitionProgress',
        payload: {
          grappeId,
          percentage: Math.round((reported / Math.max(partitions.length, 1)) * 100),
          processedRecords,
        },
      });
    }
    return reported;
  }
}

/** What a run carries from one object to the next. */
interface SeedRun {
  relations: SeedRelation[];
  /** The objects the template writes. */
  written: ReadonlySet<string>;
  /**
   * The ids each object's insert returned, for the lookups and relations
   * after it; and under `Pricebook2`, the org's standard price book once an
   * object points at it.
   */
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
    written: new Set(template.objects.map((o) => o.objectApiName)),
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

/**
 * The fields of an object no row is sent again without: the lookup its
 * relation fills, the lookups its reference rules fill from records the run
 * wrote, and the record type it was given. Written without them, a row
 * would stand alone, or go in as another kind of record.
 */
function settledFields(ready: ReadyObject): ReadonlySet<string> {
  return new Set([
    'RecordTypeId',
    ...(ready.relation ? [ready.relation.lookupField] : []),
    ...ready.config.fieldRules
      .filter((rule) => rule.ruleType === 'reference')
      .map((rule) => rule.fieldApiName),
  ]);
}

/** What an object's result says of its rows sent again: the fields left out, then what could not go. */
function notesOf(sent: Pick<SentAgain, 'written' | 'unsent' | 'notes'>): string[] {
  return [
    ...(sent.notes ?? []),
    ...(sent.written ? [fieldsLeftOutNote(sent.written)] : []),
    ...sent.unsent,
  ];
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

/**
 * Give each child record the parent id placed for it.
 *
 * @param from - The place of the first of `records` among the object's.
 */
function fillLookup(
  records: Record<string, unknown>[],
  relation: SeedRelation | undefined,
  placed: PlacedChildren | undefined,
  from = 0,
): void {
  if (!relation || !placed) return;
  for (const [index, record] of records.entries()) {
    record[relation.lookupField] = placed.parentIds[from + index];
  }
}

/**
 * What the AI could not write of an object, its slices taken together: the
 * fields of each, once and in the order met, and no answer only while no
 * slice got one.
 */
function withAiFallback(before: SeedAiFallback | undefined, slice: SeedAiFallback): SeedAiFallback {
  if (!before) return slice;
  return {
    fields: [...new Set([...before.fields, ...slice.fields])],
    reason:
      before.reason === 'no-answer' && slice.reason === 'no-answer' ? 'no-answer' : 'short-answer',
  };
}

/** Add to what the slices of an object wrote what one more wrote. */
function keepWhatASliceWrote(kept: SentAgain, sent: SentAgain): void {
  for (const id of sent.result.successIds) kept.result.successIds.push(id);
  for (const error of sent.result.errors) kept.result.errors.push(error);
  if (sent.written) kept.written = addWrittenWithoutFields(kept.written, sent.written);
  kept.unsent.push(...sent.unsent);
  // What an insert said of how it sent the records, once however many slices said it.
  for (const note of sent.notes ?? []) {
    if (!(kept.notes ?? []).includes(note)) kept.notes = [...(kept.notes ?? []), note];
  }
}

/** The result of an object skipped before anything was written for it. */
function skippedResult(objectApiName: string, message: string): SeedObjectResult {
  return { objectApiName, recordsCreated: 0, recordsFailed: 0, createdIds: [], errors: [message] };
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
